// Shared background-work controls. No transcript, generated text or credentials are stored here.
import { scopeKey } from './scope.js'

export function backgroundBlockReason(cfg, scope) {
  if (cfg.enabled === false) return 'PLUGIN_DISABLED'
  if (cfg.botQQ && String(cfg.botQQ) !== scope.account) return 'ACCOUNT_CHANGED'
  // Standalone stores may omit transport configuration; a configured allowlist is authoritative.
  if (cfg.allow !== undefined) {
    const [kind, id] = scope.chat.split(':')
    const allowed = kind === 'group' ? cfg.allow?.groups : cfg.allow?.private
    if (!(kind === 'private' && String(cfg.ownerQQ || '') === id) &&
      !(Array.isArray(allowed) && allowed.map(String).includes(id))) return 'SCOPE_DISABLED'
  }
  return ''
}

export function createWorkControl(blockReason, stoppedCode = 'WORK_STOPPED') {
  let stopped = false
  const active = new Set()
  const error = code => Object.assign(new Error(`后台任务已取消：${code}`), { code })
  function reason(scope, kind) {
    try { return stopped ? stoppedCode : scope ? blockReason(scope, kind) : '' }
    catch { return 'BACKGROUND_POLICY_UNAVAILABLE' }
  }
  function assertActive(scope, kind) { const code = reason(scope, kind); if (code) throw error(code) }
  function refresh(eventReason = () => '') {
    for (const job of active) {
      const code = reason(job.scope, job.kind) || eventReason(job.scope, job.kind)
      if (code) job.controller.abort(error(code))
    }
  }
  async function waitFor(run, scope, kind) {
    assertActive(scope, kind)
    const controller = new AbortController(), job = { scope, kind, controller }
    active.add(job)
    let onAbort
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const result = await Promise.race([Promise.resolve().then(() => {
        controller.signal.throwIfAborted(); assertActive(scope, kind)
        return run(controller.signal)
      }), aborted])
      controller.signal.throwIfAborted(); assertActive(scope, kind)
      return result
    } finally {
      active.delete(job)
      controller.signal.removeEventListener('abort', onAbort)
    }
  }
  return { reason, assertActive, waitFor, refresh, stop() { stopped = true; refresh() }, get stopped() { return stopped } }
}

export const isDiscardedWork = error => /^(?:STALE|ACCOUNT_CHANGED|BACKGROUND_POLICY_UNAVAILABLE|.*DISABLED|.*STOPPED)/.test(error?.code || '')
const integer = (value, fallback, min, max) => Number.isFinite(Number(value)) && value != null
  ? Math.max(min, Math.min(max, Math.floor(Number(value)))) : fallback
export function retrySettings(raw = {}) {
  const retryBaseMs = integer(raw.retryBaseMs, 60_000, 60_000, 3600_000)
  return { retryBaseMs, retryMaxMs: integer(raw.retryMaxMs, 3600_000, retryBaseMs, 86400_000),
    pauseAfterFailures: integer(raw.pauseAfterFailures, 6, 3, 20) }
}

export function createRetryState(db, namespace, now, config = () => ({})) {
  db.exec(`CREATE TABLE IF NOT EXISTS background_work_state(
    namespace TEXT NOT NULL,scope_key TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(namespace,scope_key));`)
  const key = scope => JSON.stringify([scope.account, scope.chat, scope.persona || ''])
  const recoveryReset = namespace === 'memory' ? { successStreak: 0, recoveryLease: null, lastSuccessCallId: null, callLease: null } : {}
  const empty = () => ({ failures: 0, nextAttemptAt: 0, paused: false, pauseReason: '', lastError: '',
    batchLimit: null, charLimit: null, lastCallId: null, phase: 'idle', ...recoveryReset })
  const read = scope => ({ ...empty(), ...JSON.parse(db.get('SELECT body FROM background_work_state WHERE namespace=? AND scope_key=?', namespace, key(scope))?.body || '{}') })
  function write(scope, patch) {
    const old = read(scope), state = { ...old, ...patch, ...(patch.phase === 'discarded' ? recoveryReset : {}) }
    if (namespace === 'memory' && patch.lastCallId && ['extraction', 'deduplication'].includes(patch.phase)) {
      state.callLease = db.get('SELECT lease_token FROM memory_checkpoints WHERE scope_key=?', scopeKey(scope))?.lease_token || null
      // An interrupted lease is not a successful sample, even if its outcome is unknown.
      if (old.callLease && old.callLease !== state.callLease && old.lastCallId !== old.lastSuccessCallId) state.successStreak = 0
    }
    db.run('INSERT INTO background_work_state VALUES (?,?,?) ON CONFLICT(namespace,scope_key) DO UPDATE SET body=excluded.body', namespace, key(scope), JSON.stringify(state))
    return state
  }
  function failure(scope, error, { batchSize, chars, priorFailures = 0 } = {}) {
    const old = read(scope), c = retrySettings(config()), failures = Math.max(old.failures, priorFailures) + 1
    const code = String(error.code || 'MODEL_FAILED').slice(0, 100), paused = failures >= c.pauseAfterFailures
    return write(scope, { ...recoveryReset, failures, paused, pauseReason: paused ? code : '', lastError: code, phase: 'failed',
      nextAttemptAt: now() + Math.min(c.retryMaxMs, c.retryBaseMs * 2 ** Math.min(failures - 1, 20)),
      ...(batchSize ? { batchLimit: Math.max(1, Math.floor(batchSize / 2)) } : {}),
      ...(chars ? { charLimit: Math.max(256, Math.floor(chars / 2)) } : {}) })
  }
  function success(scope) {
    const old = read(scope), patch = { failures: 0, paused: false, pauseReason: '', lastError: '', nextAttemptAt: 0, phase: 'done' }
    if (namespace === 'memory' && (old.batchLimit != null || old.charLimit != null) && old.lastCallId && old.lastCallId !== old.lastSuccessCallId) {
      const lease = db.get('SELECT lease_token FROM memory_checkpoints WHERE scope_key=?', scopeKey(scope))?.lease_token
      if (lease && lease === old.callLease) patch.lastSuccessCallId = old.lastCallId
      // Extraction freezes its limits for the whole lease. Do not promote again
      // using more commits that still exercised the previous, smaller limits.
      if (lease && lease === old.callLease && lease !== old.recoveryLease) {
        patch.successStreak = integer(old.successStreak, 0, 0, 2) + 1
        if (patch.successStreak >= 3) {
          const c = config() || {}
          // Match extraction's normal configuration/output budget, without changing it.
          const maxTokens = Math.floor(Math.max(1000, Math.min(16000, Number(c.maxOutputTokens) || 6000)))
          const factLimit = Math.max(1, Math.min(12, Math.floor((maxTokens - 768) / 900)))
          const batchMax = Math.floor(Math.max(1, Math.min(100, Number(c.maxBatchMessages ?? c.batchMessages) || 40, factLimit)))
          const charMax = Math.floor(Math.max(256, Math.min(50000, Number(c.maxChars) || 12000)))
          const grow = (value, max) => value == null || value * 2 >= max ? null : value * 2
          Object.assign(patch, { successStreak: 0, recoveryLease: lease,
            batchLimit: grow(old.batchLimit, batchMax), charLimit: grow(old.charLimit, charMax) })
        }
      }
    }
    return write(scope, patch)
  }
  return { read, write, failure,
    success,
    resume: scope => write(scope, { ...recoveryReset, failures: 0, paused: false, pauseReason: '', nextAttemptAt: 0, phase: 'pending' }),
  }
}

// Shared background-work controls. No transcript, generated text or credentials are stored here.
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
  const empty = () => ({ failures: 0, nextAttemptAt: 0, paused: false, pauseReason: '', lastError: '',
    batchLimit: null, charLimit: null, lastCallId: null, phase: 'idle' })
  const read = scope => ({ ...empty(), ...JSON.parse(db.get('SELECT body FROM background_work_state WHERE namespace=? AND scope_key=?', namespace, key(scope))?.body || '{}') })
  function write(scope, patch) {
    const state = { ...read(scope), ...patch }
    db.run('INSERT INTO background_work_state VALUES (?,?,?) ON CONFLICT(namespace,scope_key) DO UPDATE SET body=excluded.body', namespace, key(scope), JSON.stringify(state))
    return state
  }
  function failure(scope, error, { batchSize, chars, priorFailures = 0 } = {}) {
    const old = read(scope), c = retrySettings(config()), failures = Math.max(old.failures, priorFailures) + 1
    const code = String(error.code || 'MODEL_FAILED').slice(0, 100), paused = failures >= c.pauseAfterFailures
    return write(scope, { failures, paused, pauseReason: paused ? code : '', lastError: code, phase: 'failed',
      nextAttemptAt: now() + Math.min(c.retryMaxMs, c.retryBaseMs * 2 ** Math.min(failures - 1, 20)),
      ...(batchSize ? { batchLimit: Math.max(1, Math.floor(batchSize / 2)) } : {}),
      ...(chars ? { charLimit: Math.max(256, Math.floor(chars / 2)) } : {}) })
  }
  return { read, write, failure,
    success: scope => write(scope, { failures: 0, paused: false, pauseReason: '', lastError: '', nextAttemptAt: 0, phase: 'done' }),
    resume: scope => write(scope, { failures: 0, paused: false, pauseReason: '', nextAttemptAt: 0, phase: 'pending' }),
  }
}

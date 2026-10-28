import { randomUUID } from 'node:crypto'
import { roleModel, pickReasoningEffort } from '../core/llm.js'
import { fail, hash, scopeOf, scopeKey } from './contracts.js'

export function ensureRuntime(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS wp6_model_budget(day TEXT PRIMARY KEY, calls INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS wp6_model_calls(id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, kind TEXT NOT NULL, expires_at INTEGER NOT NULL);`)
}
export function reserveCall(db, scope, kind, c, now) {
  return db.tx(() => {
    db.run('DELETE FROM wp6_model_calls WHERE expires_at <= ?', now)
    if (db.get('SELECT 1 FROM wp6_model_calls WHERE scope_key=?', scopeKey(scope))) return null
    const day = new Date(now).toISOString().slice(0, 10)
    if (Number(db.get('SELECT COUNT(*) AS n FROM wp6_model_calls').n) >= c.maxConcurrent) return null
    if (Number(db.get('SELECT calls FROM wp6_model_budget WHERE day = ?', day)?.calls || 0) >= c.maxCallsPerDay) return null
    const id = randomUUID()
    db.run('INSERT INTO wp6_model_budget(day,calls) VALUES (?,1) ON CONFLICT(day) DO UPDATE SET calls=calls+1', day)
    db.run('INSERT INTO wp6_model_calls(id,scope_key,kind,expires_at) VALUES (?,?,?,?)', id, scopeKey(scope), kind, now + c.timeoutMs + 5000)
    db.run('DELETE FROM wp6_model_budget WHERE day < ?', new Date(now - 90 * 86400000).toISOString().slice(0, 10))
    return id
  })
}
export function budgetState(db, c, now) {
  const day = new Date(now).toISOString().slice(0, 10)
  return { day, calls: Number(db.get('SELECT calls FROM wp6_model_budget WHERE day=?', day)?.calls || 0),
    active: Number(db.get('SELECT COUNT(*) AS n FROM wp6_model_calls WHERE expires_at>?', now).n),
    maxCallsPerDay: c.maxCallsPerDay, maxConcurrent: c.maxConcurrent }
}
export function identityToken({ scope, storage, getIdentity, getConfig }) {
  scope = scopeOf(scope)
  const identity = getIdentity?.(scope)
  if (!identity || identity.error || String(identity.personaId || '') !== scope.persona || (identity.account && String(identity.account) !== scope.account)) fail('IDENTITY_REQUIRED', '当前聊天的人设身份不可验证')
  const cfg = getConfig()
  if (cfg.botQQ && String(cfg.botQQ) !== scope.account) fail('STALE_IDENTITY', '账号已经改变')
  return {
    scope, epoch: storage.epochs.current(scope.chat), identity,
    fingerprint: hash([scope, identity.personaId, identity.revision ?? 0, identity.bindingRevision ?? 0, identity.layers?.policy || {}, cfg.botQQ || scope.account]),
  }
}
export function sameIdentity(token, deps) {
  try {
    const current = identityToken({ ...deps, scope: token.scope })
    return current.epoch === token.epoch && current.fingerprint === token.fingerprint
  } catch { return false }
}
export async function modelText(dsh, { cfg, role = 'learning', system, text, signal, maxTokens = 1200 }) {
  const target = roleModel(dsh, cfg, role), llm = dsh?.llm || dsh?.get?.('llm')
  if (!target || !llm?.stream) fail('MODEL_UNAVAILABLE', '未配置学习/判断模型')
  const reasoningEffort = await pickReasoningEffort(dsh, target.provider, target.model, target.reasoningEffort || 'low')
  signal.throwIfAborted()
  let output = '', finished = false
  for await (const block of llm.stream({ provider: target.provider, model: target.model, reasoningEffort, system,
    messages: [{ role: 'user', id: randomUUID(), content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'aurabot' } }],
    temperature: 0.2, maxTokens, signal })) {
    signal.throwIfAborted()
    if (block.type === 'text-delta') output += block.text || ''
    if (output.length > 16000) fail('MODEL_OUTPUT_TOO_LARGE', '模型结果超过上限')
    if (block.type === 'finish') {
      const kind = typeof block.reason === 'string' ? block.reason : block.reason?.kind
      if (!['stop', 'completed'].includes(kind)) fail('MODEL_FAILED', '模型没有完整完成判断')
      finished = true
    }
  }
  if (!finished) fail('MODEL_FAILED', '模型流提前结束')
  return output
}
export async function boundedCall(fn, timeoutMs, parentSignal) {
  const controller = new AbortController()
  const stop = () => controller.abort(parentSignal.reason)
  parentSignal?.addEventListener('abort', stop, { once: true })
  if (parentSignal?.aborted) stop()
  let timer, onAbort
  try {
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(controller.signal.reason || new Error('工作已取消'))
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    controller.signal.throwIfAborted()
    timer = setTimeout(() => controller.abort(Object.assign(new Error('模型判断超时'), { code: 'MODEL_TIMEOUT' })), timeoutMs)
    return await Promise.race([Promise.resolve().then(() => fn(controller.signal)), aborted])
  } finally {
    clearTimeout(timer)
    controller.signal.removeEventListener('abort', onAbort)
    parentSignal?.removeEventListener('abort', stop)
  }
}

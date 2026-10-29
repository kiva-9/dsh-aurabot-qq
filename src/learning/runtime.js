import { randomUUID } from 'node:crypto'
import { askModel } from '../core/llm.js'
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
    if (c.maxCallsPerDay > 0 && Number(db.get('SELECT calls FROM wp6_model_budget WHERE day = ?', day)?.calls || 0) >= c.maxCallsPerDay) return null
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
export async function modelText(dsh, options) {
  return askModel(dsh, { role: 'learning', maxTokens: 2400, maxOutputChars: 16000, temperature: 0.2, ...options })
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
    aborted.catch(() => {})
    controller.signal.throwIfAborted()
    timer = setTimeout(() => controller.abort(Object.assign(new Error('模型判断超时'), { code: 'MODEL_TIMEOUT' })), timeoutMs)
    return await Promise.race([Promise.resolve().then(() => { controller.signal.throwIfAborted(); return fn(controller.signal) }), aborted])
  } finally {
    clearTimeout(timer)
    controller.signal.removeEventListener('abort', onAbort)
    parentSignal?.removeEventListener('abort', stop)
  }
}

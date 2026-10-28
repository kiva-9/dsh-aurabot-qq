import { createHash } from 'node:crypto'
import { fail } from './errors.js'

export const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function searchScope(context) {
  const account = typeof context?.account === 'string' ? context.account : ''
  const chat = typeof context?.chatId === 'string' ? context.chatId : ''
  if (!account || account.length > 128 || !/^(private|group):[\w-]+$/.test(chat) || chat.length > 160) fail('SCOPE_REQUIRED', '必须提供当前机器人账号和聊天范围')
  return { account, chat }
}

export function searchContext(context) {
  const scope = searchScope(context)
  for (const key of ['actorId', 'requestId', 'turnId']) if (typeof context[key] !== 'string' || !context[key] || context[key].length > 256) fail('CONTEXT_REQUIRED', '搜索需要有效的请求者、请求 ID 和回合 ID')
  return { ...context, scope }
}

/** Isolated WP5 tables; does not change user_version or run the global migration. */
export function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_results (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      actor_id TEXT NOT NULL, request_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('web-search','page-extract','reference-candidates')),
      cache_key TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      result_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS search_results_scope ON search_results(account_id, chat_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS search_results_cache ON search_results(account_id, chat_id, actor_id, cache_key, expires_at);
    CREATE TABLE IF NOT EXISTS search_budgets (
      account_id TEXT NOT NULL, chat_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      searches INTEGER NOT NULL DEFAULT 0, tools INTEGER NOT NULL DEFAULT 0, downloads INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(account_id, chat_id, turn_id)
    );
    CREATE TABLE IF NOT EXISTS search_limits (
      key TEXT NOT NULL, window INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(key, window)
    );
    CREATE TABLE IF NOT EXISTS search_reference_bytes (
      result_id TEXT NOT NULL REFERENCES search_results(id) ON DELETE CASCADE,
      candidate_id TEXT NOT NULL, mime TEXT NOT NULL, bytes BLOB NOT NULL,
      PRIMARY KEY(result_id, candidate_id)
    );
  `)
}

export function createSearchStore(db, { now = Date.now } = {}) {
  ensureSchema(db)
  function save(record, blobs = [], { maxCacheBytes = 128 * 1024 * 1024 } = {}) {
    db.tx(() => {
      if (blobs.length) {
        db.run('DELETE FROM search_reference_bytes WHERE result_id IN (SELECT id FROM search_results WHERE expires_at<=?)', now())
        const used = Number(db.get('SELECT COALESCE(SUM(length(bytes)),0) n FROM search_reference_bytes WHERE result_id<>?', record.id).n)
        if (used + blobs.reduce((n, b) => n + b.buf.length, 0) > maxCacheBytes) fail('CACHE_FULL', '参考图片缓存已达到字节额度，请等待缓存过期或调整配置')
      }
      db.run(`INSERT INTO search_results(id,account_id,chat_id,actor_id,request_id,turn_id,kind,cache_key,created_at,expires_at,result_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET result_json=excluded.result_json, expires_at=excluded.expires_at`,
      record.id, record.scope.account, record.scope.chat, record.actorId, record.requestId, record.turnId, record.type,
      record.cache.key, record.createdAt, record.expiresAt, JSON.stringify(record))
      for (const blob of blobs) db.run('INSERT OR REPLACE INTO search_reference_bytes(result_id,candidate_id,mime,bytes) VALUES(?,?,?,?)', record.id, blob.id, blob.mime, blob.buf)
    })
    return record
  }
  function get(context, id) {
    const scope = searchScope(context)
    if (typeof id !== 'string' || id.length > 128) return null
    const row = db.get('SELECT result_json FROM search_results WHERE id=? AND account_id=? AND chat_id=?', id, scope.account, scope.chat)
    return row ? JSON.parse(row.result_json) : null
  }
  function history(context, { limit = 20, before, beforeId = '' } = {}) {
    const s = searchScope(context)
    const n = Math.min(50, Math.max(1, Math.floor(Number(limit) || 20)))
    const timestamp = Number.isFinite(Number(before)) ? Number(before) : Number.MAX_SAFE_INTEGER
    return db.all('SELECT result_json FROM search_results WHERE account_id=? AND chat_id=? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC,id DESC LIMIT ?',
      s.account, s.chat, timestamp, timestamp, String(beforeId).slice(0, 128), n).map((r) => JSON.parse(r.result_json))
  }
  function cached(context, key) {
    const s = searchScope(context)
    const row = db.get('SELECT result_json FROM search_results WHERE account_id=? AND chat_id=? AND actor_id=? AND cache_key=? AND expires_at>? ORDER BY created_at DESC LIMIT 1', s.account, s.chat, context.actorId, key, now())
    const record = row ? JSON.parse(row.result_json) : null
    return record?.status === 'complete' ? record : null
  }
  function reserve(context, field, limit) {
    if (!['searches', 'tools', 'downloads'].includes(field)) fail('INVALID_INPUT', '预算类型不合法')
    const s = searchScope(context)
    return db.tx(() => {
      db.run('INSERT OR IGNORE INTO search_budgets(account_id,chat_id,turn_id) VALUES(?,?,?)', s.account, s.chat, context.turnId)
      const changed = db.run(`UPDATE search_budgets SET ${field}=${field}+1 WHERE account_id=? AND chat_id=? AND turn_id=? AND ${field}<?`, s.account, s.chat, context.turnId, limit).changes
      if (!changed) fail('BUDGET_EXHAUSTED', field === 'searches' ? '本回合最多两轮搜索，预算已用完' : '本回合的工具或下载预算已用完')
      return budget(context)
    })
  }
  function budget(context) {
    const s = searchScope(context)
    const row = db.get('SELECT searches,tools,downloads FROM search_budgets WHERE account_id=? AND chat_id=? AND turn_id=?', s.account, s.chat, context.turnId)
    return row ? { ...row } : { searches: 0, tools: 0, downloads: 0 }
  }
  function reserveRequests(key, cfg) {
    db.tx(() => {
      for (const [label, period, limit] of [['minute', 60000, cfg.maxRequestsPerMinute], ['day', 86400000, cfg.maxRequestsPerDay]]) {
        const window = Math.floor(now() / period)
        const k = `${key}:${label}`
        db.run('INSERT OR IGNORE INTO search_limits(key,window,used) VALUES(?,?,0)', k, window)
        if (!db.run('UPDATE search_limits SET used=used+1 WHERE key=? AND window=? AND used<?', k, window, limit).changes) fail('QUOTA_EXHAUSTED', '搜索服务请求额度已用完')
        db.run('DELETE FROM search_limits WHERE key=? AND window<?', k, window - 2)
      }
    })
  }
  function reserveDownload(context, sourceResultId, limit) {
    db.tx(() => {
      reserve(context, 'downloads', 12)
      reserve({ ...context, turnId: `source:${sourceResultId}` }, 'downloads', limit)
    })
  }
  function bytes(context, resultId, candidateId) {
    if (!get(context, resultId)) return null
    const row = db.get('SELECT mime,bytes FROM search_reference_bytes WHERE result_id=? AND candidate_id=?', resultId, candidateId)
    return row ? { mime: row.mime, buf: Buffer.from(row.bytes) } : null
  }
  return { save, get, history, cached, reserve, reserveRequests, reserveDownload, budget, bytes }
}

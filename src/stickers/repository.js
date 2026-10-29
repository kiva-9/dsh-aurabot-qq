import { randomUUID, createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { ensureStickerSchema } from './schema.js'

const host = hostname()
const runtime = randomUUID()
const active = new Set()
const decode = (r) => r ? JSON.parse(r.body_json) : null
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const newStickerId = (prefix) => `${prefix}_${randomUUID()}`
export const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
function alive(owner) {
  if (!owner || owner.host !== host || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return true
  if (owner.pid === process.pid && owner.runtime === runtime) return active.has(owner.token)
  try { process.kill(owner.pid, 0); return true } catch (e) { return e.code !== 'ESRCH' }
}
function taskView(r) {
  return r ? { id: r.id, accountId: r.account, chatId: r.chat, kind: r.kind, itemId: r.item_id, key: r.task_key,
    state: r.state, attempts: r.attempts, owner: r.owner_json ? JSON.parse(r.owner_json) : null,
    input: JSON.parse(r.input_json), output: r.output_json ? JSON.parse(r.output_json) : null,
    error: r.error, outcome: r.outcome, createdAt: r.created_at, updatedAt: r.updated_at } : null
}

export function createStickerRepository({ storage, now = Date.now, limits }) {
  ensureStickerSchema(storage)
  const db = storage.db
  const get = (id) => decode(db.get('SELECT body_json FROM sticker_items WHERE id=?', id))
  const all = (includeDeleted = false) => db.all(`SELECT body_json FROM sticker_items ${includeDeleted ? '' : "WHERE state!='deleted'"} ORDER BY created_at DESC,id`).map(decode)
  const find = (account, key) => db.all('SELECT body_json FROM sticker_items WHERE account=? AND (id=? OR md5=? OR sha256=?)', account, key, key, key).map(decode)
  const save = (it) => db.run(`INSERT INTO sticker_items(id,account,chat,sha256,md5,asset_id,state,revision,body_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,revision=excluded.revision,
    body_json=excluded.body_json,updated_at=excluded.updated_at`,
  it.id, it.scope.account, it.scope.chat, it.sha256, it.md5, it.assetId, it.state, it.revision, JSON.stringify(it), it.at, now())
  function update(id, fn, expectedRevision) {
    return db.tx(() => {
      const it = get(id)
      if (!it) fail('NOT_FOUND', '没有这张表情')
      if (expectedRevision !== undefined && it.revision !== expectedRevision) fail('STALE_REVISION', '表情已被修改，请刷新')
      fn(it)
      it.revision++
      it.updatedAt = now()
      save(it)
      return it
    })
  }
  const source = (scope, key) => decode(db.get('SELECT body_json FROM sticker_sources WHERE account=? AND chat=? AND source_key=?', scope.account, scope.chat, key))
  function saveSource(scope, key, body, itemId = null) {
    db.run(`INSERT INTO sticker_sources(id,account,chat,source_key,item_id,body_json,created_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(account,chat,source_key) DO UPDATE SET item_id=COALESCE(excluded.item_id,sticker_sources.item_id)`,
    newStickerId('sts'), scope.account, scope.chat, key, itemId, JSON.stringify(body), now())
  }
  function ingest(buf, info, scope, input = {}) {
    return db.tx(() => {
      const digest = hash(buf)
      const existing = decode(db.get('SELECT body_json FROM sticker_items WHERE account=? AND chat=? AND sha256=?', scope.account, scope.chat, digest))
      if (existing) {
        if (input.source) saveSource(scope, input.source.key, input.source, existing.id)
        if (existing.state === 'deleted') fail('TOMBSTONED', '这张图已删除，重复收藏不会恢复')
        return { ok: true, item: existing, existed: true }
      }
      const { maxLibrary, maxPerHour } = limits()
      if (db.get("SELECT COUNT(*) AS n FROM sticker_items WHERE account=? AND state!='deleted'", scope.account).n >= maxLibrary) fail('LIBRARY_FULL', '表情库已满，请先审核或删除')
      if (input.automatic && db.get('SELECT COUNT(*) AS n FROM sticker_quota WHERE account=? AND reserved_at>?', scope.account, now() - 3600_000).n >= maxPerHour) fail('QUOTA_EXCEEDED', '这小时收够了')
      const asset = storage.assets.put(buf, { mime: info.mime, width: info.width, height: info.height, sourceKind: input.automatic ? 'inbound' : 'upload' })
      const t = now()
      const { segment: _segment, ...sourceEvidence } = input.source || {}
      const item = { id: newStickerId('stk'), sha256: digest, md5: createHash('md5').update(buf).digest('hex'), assetId: asset.id,
        scope, state: 'pending', revision: 1, name: String(input.name || '').slice(0, 80), tags: input.tags || [],
        description: '', ocr: '', emotions: [], suitable: [], unsuitable: [], editedFields: input.editedFields || [],
        analysis: { state: 'pending', error: null, evidence: null }, frames: [], animated: info.animated,
        review: { kind: 'pending', reason: '等待审核' }, wantsQQ: Boolean(input.toQQ),
        mime: info.mime, width: info.width, height: info.height, bytes: buf.length, from: input.from || 'manual',
        source: input.source ? sourceEvidence : null, at: t, updatedAt: t, uses: 0, lastUsed: 0 }
      save(item)
      if (input.automatic) db.run('INSERT INTO sticker_quota(item_id,account,reserved_at) VALUES (?,?,?)', item.id, scope.account, t)
      if (input.source) saveSource(scope, input.source.key, input.source, item.id)
      return { ok: true, item, existed: false }
    })
  }

  const task = (id) => taskView(db.get('SELECT * FROM sticker_tasks WHERE id=?', id))
  function taskQuery(account, options = {}) {
    const where = ['account=?'], args = [account]
    for (const [option, column] of [['state', 'state'], ['kind', 'kind'], ['itemId', 'item_id'], ['chatId', 'chat']]) {
      if (options[option]) { where.push(`${column}=?`); args.push(options[option]) }
    }
    return { where: where.join(' AND '), args }
  }
  function tasks(account, options = {}) {
    const { where, args } = taskQuery(account, options)
    return db.all(`SELECT * FROM sticker_tasks WHERE ${where} ORDER BY created_at DESC,id LIMIT ?`, ...args, options.limit || 1000).map(taskView)
  }
  function taskPage(account, options) {
    const { where, args } = taskQuery(account, options)
    const total = db.get(`SELECT COUNT(*) AS n FROM sticker_tasks WHERE ${where}`, ...args).n
    // 管理列表不读取下载输入的大块 base64，更不把它再次返回到面板。
    const rows = db.all(`SELECT id,account,chat,kind,task_key,item_id,state,attempts,NULL AS owner_json,
      json_object('action',json_extract(input_json,'$.action')) AS input_json,output_json,error,outcome,created_at,updated_at
      FROM sticker_tasks WHERE ${where} ORDER BY created_at DESC,id LIMIT ? OFFSET ?`, ...args, options.limit, options.offset)
    return { total, items: rows.map(taskView), limit: options.limit, offset: options.offset }
  }
  function enqueue(scope, kind, key, input, itemId = null) {
    return db.tx(() => {
      const old = taskView(db.get('SELECT * FROM sticker_tasks WHERE account=? AND chat=? AND kind=? AND task_key=?', scope.account, scope.chat, kind, key))
      if (old) return old
      if (db.get("SELECT COUNT(*) AS n FROM sticker_tasks WHERE account=? AND state IN ('queued','running')", scope.account).n >= limits().maxQueued) fail('QUEUE_FULL', '表情后台队列已满')
      const id = newStickerId('stj')
      db.run("INSERT INTO sticker_tasks(id,account,chat,kind,task_key,item_id,state,input_json,created_at,updated_at) VALUES (?,?,?,?,?,?,'queued',?,?,?)",
        id, scope.account, scope.chat, kind, key, itemId, JSON.stringify(input), now(), now())
      return task(id)
    })
  }
  const qq = (account, sha256) => {
    const stored = decode(db.get('SELECT body_json FROM sticker_qq WHERE account=? AND sha256=?', account, sha256))
    if (stored) return stored
    // 兼容旧导入：来源已证明收藏存在，缺 ID 不能当作未收藏而再次 add。
    const imported = db.get("SELECT 1 FROM sticker_items WHERE account=? AND sha256=? AND json_extract(body_json,'$.from')='qq' LIMIT 1", account, sha256)
    return { state: imported ? 'unidentified' : 'idle', emojiId: '', taskId: null,
      error: imported ? '已从 QQ 收藏导入，但未取得收藏 ID；请核对并绑定已有收藏' : null }
  }
  const saveQQ = (account, sha256, value) => db.run('INSERT INTO sticker_qq(account,sha256,body_json) VALUES (?,?,?) ON CONFLICT(account,sha256) DO UPDATE SET body_json=excluded.body_json', account, sha256, JSON.stringify(value))
  function recover(account) {
    return db.tx(() => {
      const result = { requeued: 0, unknown: 0 }
      for (const t of tasks(account, { state: 'running' })) {
        if (alive(t.owner)) continue
        // 识别也可能已经计费；丢失进程不能证明外部调用没有发生。
        const state = ['sync', 'analyze'].includes(t.kind) ? 'unknown' : 'queued'
        db.run('UPDATE sticker_tasks SET state=?,owner_json=NULL,error=?,outcome=?,updated_at=? WHERE id=? AND state=?', state, '后台进程退出', state === 'unknown' ? 'unknown' : null, now(), t.id, 'running')
        if (t.kind === 'sync') {
          const q = qq(account, t.input.sha256)
          if (q.taskId === t.id) saveQQ(account, t.input.sha256, { ...q, state: 'unknown', error: '同步时进程退出，结果未知' })
        }
        if (t.kind === 'analyze') {
          const it = get(t.itemId)
          if (it && it.state !== 'deleted') update(it.id, (item) => {
            item.analysis = { ...item.analysis, state: 'unknown', error: '识别时进程退出，可能已计费；需核对任务，不能直接重试' }
          })
        }
        if (state === 'unknown') result.unknown++
        else result.requeued++
      }
      return result
    })
  }
  function claim(account, { sync = true, analyze = true, collect = true } = {}) {
    const result = db.tx(() => {
      recover(account)
      if (db.get("SELECT COUNT(*) AS n FROM sticker_tasks WHERE account=? AND state='running'", account).n >= limits().concurrency) return null
      const r = db.get(`SELECT * FROM sticker_tasks WHERE account=? AND state='queued' ${sync ? '' : "AND kind NOT IN ('sync','import')"} ${analyze ? '' : "AND kind!='analyze'"} ${collect ? '' : "AND kind!='collect'"} ORDER BY created_at,id LIMIT 1`, account)
      if (!r) return null
      const owner = { pid: process.pid, host, runtime, token: randomUUID() }
      db.run("UPDATE sticker_tasks SET state='running',owner_json=?,attempts=attempts+1,error=NULL,updated_at=? WHERE id=? AND state='queued'", JSON.stringify(owner), now(), r.id)
      return task(r.id)
    })
    if (result) active.add(result.owner.token)
    return result
  }
  const owns = (t) => {
    const live = task(t.id)
    return live?.state === 'running' && live.owner?.token === t.owner?.token
  }
  function finish(t, state, { output = null, error = null, outcome = null } = {}) {
    if (!owns(t)) return false
    return Boolean(db.run('UPDATE sticker_tasks SET state=?,output_json=?,error=?,outcome=?,owner_json=NULL,updated_at=? WHERE id=? AND owner_json=? AND state=?',
      state, JSON.stringify(output), error, outcome, now(), t.id, JSON.stringify(t.owner), 'running').changes)
  }
  function retryTask(id) {
    return db.tx(() => {
      const t = task(id)
      if (!t || t.state !== 'failed') fail('NOT_RETRYABLE', '只允许重试明确失败；未知同步结果须先核对')
      if (t.kind === 'sync' && !['not_sent', 'rejected'].includes(t.outcome)) fail('NOT_RETRYABLE', '同步结果不明确')
      if (t.itemId && get(t.itemId)?.state === 'deleted' && t.input.action !== 'delete') fail('TOMBSTONED', '表情已删除')
      if (db.get("SELECT COUNT(*) AS n FROM sticker_tasks WHERE account=? AND state IN ('queued','running')", t.accountId).n >= limits().maxQueued) fail('QUEUE_FULL', '后台队列已满')
      db.run("UPDATE sticker_tasks SET state='queued',error=NULL,updated_at=? WHERE id=?", now(), id)
      return task(id)
    })
  }
  const forget = (t) => active.delete(t.owner?.token)
  const usage = (scope, sha256) => db.get('SELECT uses,last_used AS lastUsed FROM sticker_uses WHERE account=? AND chat=? AND sha256=?', scope.account, scope.chat, sha256) || { uses: 0, lastUsed: 0 }
  const used = (scope, sha256) => db.run(`INSERT INTO sticker_uses(account,chat,sha256,uses,last_used) VALUES (?,?,?,1,?)
    ON CONFLICT(account,chat,sha256) DO UPDATE SET uses=uses+1,last_used=excluded.last_used`, scope.account, scope.chat, sha256, now())
  return { db, get, all, find, save, update, ingest, source, saveSource, task, tasks, taskPage, enqueue, qq, saveQQ, recover, claim, owns, finish, retryTask, forget, usage, used }
}

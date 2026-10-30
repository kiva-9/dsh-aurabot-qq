// 存储层入口：打开主库、跑结构迁移，提供各实体的读写（repos）。
// 业务代码只通过这里读写，不直接拼 SQL。

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { openDatabase, toJson, fromJson } from './db.js'
import { migrate, schemaVersion, LATEST_VERSION } from './migrations.js'
import { newId, traceId } from '../core/ids.js'
import { parseChatId } from '../domain/scope.js'

const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp', 'audio/wav': '.wav', 'audio/mpeg': '.mp3', 'audio/silk': '.silk', 'audio/amr': '.amr' }

/**
 * @param {{file: string, filesDir: string, log?: object, now?: () => number}} o
 *   file：数据库文件（':memory:' 测试用）；filesDir：媒体文件根目录。
 */
export function createStorage({ file, filesDir, log, now = () => Date.now() }) {
  const db = openDatabase(file)
  let migration
  try {
    migration = migrate(db, { log })
  } catch (error) {
    db.close()
    throw error
  }

  // ---------- 计数器 ----------
  function nextSeq(name) {
    return db.tx(() => {
      db.run('INSERT INTO sequences(name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1', name)
      return Number(db.get('SELECT value FROM sequences WHERE name = ?', name).value)
    })
  }

  // ---------- meta ----------
  const meta = {
    get: (key, fallback = null) => fromJson(db.get('SELECT value FROM meta WHERE key = ?', key)?.value, fallback),
    set: (key, value) => { db.run('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, toJson(value)) },
  }

  // ---------- 聊天 ----------
  const chats = {
    ensure({ account, chatId, title = '' }) {
      const p = parseChatId(chatId)
      if (!p) throw new Error(`聊天 ID 不合法：${chatId}`)
      const t = now()
      db.run(`INSERT INTO chats(id, account_id, kind, platform_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title = CASE WHEN excluded.title != '' THEN excluded.title ELSE chats.title END, updated_at = excluded.updated_at`,
      chatId, String(account), p.kind, p.id, String(title || ''), t, t)
      return chats.get(chatId)
    },
    get: (chatId) => rowChat(db.get('SELECT * FROM chats WHERE id = ?', chatId)),
  }

  // ---------- 消息 ----------
  /**
   * 收到的事件登记成消息。来源 ID 可靠（QQ 消息 ID）时按 账号+聊天+类别+ID 去重：重放的事件返回 { duplicate: true }。
   * 拿不到来源 ID 时一律当新消息（不能用内容指纹去重，否则连发两条「哈哈」会丢一条）。
   */
  function ingestMessage(m) {
    const account = String(m.account)
    const pid = m.platformMsgId === undefined || m.platformMsgId === null || m.platformMsgId === '' || String(m.platformMsgId) === '0' ? null : String(m.platformMsgId)
    const dedupeKey = pid ? `${account}|${m.chatId}|${m.eventKind}|${pid}` : null
    return db.tx(() => {
      if (dedupeKey) {
        const old = db.get('SELECT id, recv_seq FROM messages WHERE dedupe_key = ?', dedupeKey)
        if (old) return { id: old.id, recvSeq: Number(old.recv_seq), duplicate: true }
      }
      chats.ensure({ account, chatId: m.chatId, title: m.chatTitle || '' })
      const id = newId('msg')
      const recvSeq = nextSeq('recv')
      db.run(`INSERT INTO messages(id, account_id, chat_id, event_kind, platform_msg_id, dedupe_key, author_id, author_name, platform_time, received_at, recv_seq, text, segments_json, reply_to, forwards_json, mentioned, trace_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, account, m.chatId, m.eventKind || 'message', pid, dedupeKey, String(m.authorId), String(m.authorName || ''),
      m.platformTime ?? null, m.receivedAt ?? now(), recvSeq, String(m.text || ''), toJson(m.segments || []),
      m.replyTo ? String(m.replyTo) : null, toJson(m.forwards || []), m.mentioned ? 1 : 0, m.traceId || traceId())
      return { id, recvSeq, duplicate: false }
    })
  }
  const messages = {
    ingest: ingestMessage,
    get: (id) => rowMessage(db.get('SELECT * FROM messages WHERE id = ?', id)),
    byPlatformId: (chatId, pid, eventKind = 'message', account) => rowMessage(account ? db.get('SELECT * FROM messages WHERE account_id = ? AND chat_id = ? AND platform_msg_id = ? AND event_kind = ? ORDER BY recv_seq DESC LIMIT 1', String(account), chatId, String(pid), eventKind) : db.get('SELECT * FROM messages WHERE chat_id = ? AND platform_msg_id = ? AND event_kind = ? ORDER BY recv_seq DESC LIMIT 1', chatId, String(pid), eventKind)),
    recent: (chatId, limit = 20) => db.all('SELECT * FROM messages WHERE chat_id = ? ORDER BY recv_seq DESC LIMIT ?', chatId, limit).map(rowMessage).reverse(),
    markRecalled: (chatId, pid) => db.run('UPDATE messages SET recalled_at = ? WHERE chat_id = ? AND platform_msg_id = ? AND recalled_at IS NULL', now(), chatId, String(pid)).changes,
  }

  // ---------- 资产与出现记录 ----------
  /** 同一份字节只存一次（按 sha256）；返回资产记录。 */
  function putAsset(buf, { mime, width = null, height = null, sourceKind = 'inbound' }) {
    if (!Buffer.isBuffer(buf) || !buf.length) throw new Error('资产内容是空的')
    const sha = createHash('sha256').update(buf).digest('hex')
    const existing = db.get('SELECT * FROM assets WHERE sha256 = ?', sha)
    if (existing && existing.state === 'stored') return rowAsset(existing)
    const rel = join(sha.slice(0, 2), sha + (EXT[mime] || '.bin'))
    const abs = join(filesDir, rel)
    if (!existsSync(abs)) {
      mkdirSync(dirname(abs), { recursive: true })
      const tmp = `${abs}.tmp-${process.pid}`
      writeFileSync(tmp, buf)
      renameSync(tmp, abs)
    }
    return db.tx(() => {
      const again = db.get('SELECT * FROM assets WHERE sha256 = ?', sha)
      if (again) {
        if (again.state !== 'stored') db.run("UPDATE assets SET state = 'stored', path = ? WHERE id = ?", rel, again.id)
        return rowAsset(db.get('SELECT * FROM assets WHERE id = ?', again.id))
      }
      const id = newId('ast')
      db.run('INSERT INTO assets(id, sha256, mime, bytes, width, height, path, source_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, sha, mime, buf.length, width, height, rel, sourceKind, now())
      return rowAsset(db.get('SELECT * FROM assets WHERE id = ?', id))
    })
  }
  const assets = {
    put: putAsset,
    get: (id) => rowAsset(db.get('SELECT * FROM assets WHERE id = ?', id)),
    pathOf: (asset) => join(filesDir, asset.path),
  }

  const occurrences = {
    /** 消息里的媒体段先登记（pending），下载、识别完再回填，不按「某人最后一条」去对。 */
    add({ messageId, chatId, authorId, segIndex, kind, remote = {}, scope }) {
      const id = newId('occ')
      const t = now()
      db.run(`INSERT INTO asset_occurrences(id, message_id, chat_id, author_id, seg_index, kind, remote_json, scope_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, messageId ?? null, chatId, String(authorId), segIndex, kind, toJson(remote), toJson(scope), t, t)
      return id
    },
    ready: (id, assetId, analysis) => db.run("UPDATE asset_occurrences SET state = 'ready', asset_id = ?, error = NULL, analysis_json = COALESCE(?, analysis_json), updated_at = ? WHERE id = ?", assetId ?? null, analysis ? toJson(analysis) : null, now(), id).changes,
    failed: (id, error, state = 'failed') => db.run('UPDATE asset_occurrences SET state = ?, error = ?, updated_at = ? WHERE id = ?', state, String(error || '').slice(0, 500), now(), id).changes,
    get: (id) => rowOccurrence(db.get('SELECT * FROM asset_occurrences WHERE id = ?', id)),
    ofMessage: (messageId) => db.all('SELECT * FROM asset_occurrences WHERE message_id = ? ORDER BY seg_index', messageId).map(rowOccurrence),
    pending: (limit = 50) => db.all("SELECT * FROM asset_occurrences WHERE state = 'pending' ORDER BY created_at LIMIT ?", limit).map(rowOccurrence),
    /** 这个聊天最近的图片和表情（旧的在前）：按账号隔离，撤回的不算。 */
    recent(chatId, { account, since = 0, limit = 6 }) {
      const rows = db.all(`SELECT o.seg_index, o.kind, o.author_id, o.message_id, o.remote_json, o.created_at, m.account_id, m.segments_json
        FROM asset_occurrences o JOIN messages m ON m.id = o.message_id
        WHERE o.chat_id = ? AND m.account_id = ? AND o.kind IN ('image', 'sticker') AND o.created_at >= ? AND m.recalled_at IS NULL
        ORDER BY o.created_at DESC, o.seg_index DESC LIMIT ?`, chatId, String(account), since, limit)
      return rows.reverse().map((r) => ({
        seg: fromJson(r.segments_json, [])[r.seg_index] || { type: 'image', data: fromJson(r.remote_json, {}) },
        userId: r.author_id, messageId: r.message_id, account: r.account_id, at: r.created_at, sticker: r.kind === 'sticker',
      }))
    },
  }

  // ---------- 会话代次 ----------
  // 切换人设、重开会话时代次 +1；旧代次里还没发出去的回复一律作废（迟到的结果不能发到 QQ）
  const epochs = {
    current: (chatId) => Number(db.get('SELECT epoch FROM chat_epochs WHERE chat_id = ?', chatId)?.epoch || 0),
    bump(chatId, reason = '') {
      return db.tx(() => {
        db.run(`INSERT INTO chat_epochs(chat_id, epoch, reason, updated_at) VALUES (?, 1, ?, ?)
          ON CONFLICT(chat_id) DO UPDATE SET epoch = epoch + 1, reason = excluded.reason, updated_at = excluded.updated_at`, chatId, String(reason), now())
        return epochs.current(chatId)
      })
    },
  }

  // ---------- 请求 ----------
  const requests = {
    /** 请求的提出者由接收层确定，模型和工具不能改。 */
    create({ chatId, actorId, sourceMessageIds, replyTarget = null, policyRevision = 0, traceId: trc }) {
      if (!Array.isArray(sourceMessageIds) || !sourceMessageIds.length) throw new Error('请求必须关联来源消息')
      const sources = sourceMessageIds.map((id) => messages.get(id))
      if (sources.some((m) => !m || m.chatId !== chatId || m.authorId !== String(actorId))) throw new Error('请求来源必须属于当前聊天的同一提出者')
      if (new Set(sources.map((m) => m.account)).size !== 1) throw new Error('请求不能混用不同账号的消息')
      const id = newId('req')
      const t = now()
      db.run(`INSERT INTO requests(id, chat_id, actor_id, source_message_ids_json, reply_target, policy_revision, epoch, trace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, chatId, String(actorId), toJson(sourceMessageIds), replyTarget, policyRevision, epochs.current(chatId), trc || traceId(), t, t)
      return requests.get(id)
    },
    get: (id) => rowRequest(db.get('SELECT * FROM requests WHERE id = ?', id)),
    appendSource(id, messageId) {
      return db.tx(() => {
        const request = requests.get(id), message = messages.get(messageId)
        const first = request && messages.get(request.sourceMessageIds[0])
        if (!request || !message || !first || request.epoch !== epochs.current(request.chatId) ||
          message.recalledAt != null || message.account !== first.account || message.chatId !== request.chatId ||
          message.authorId !== request.actorId || ['canceled','cancel_requested','closed','expired'].includes(request.state)) throw new Error('补充消息不属于当前有效请求')
        if (request.sourceMessageIds.includes(messageId)) return request
        if (request.sourceMessageIds.length >= 64) throw new Error('当前请求已达到补充消息上限')
        db.run('UPDATE requests SET source_message_ids_json=?, updated_at=? WHERE id=?', toJson([...request.sourceMessageIds,messageId]), now(),id)
        return requests.get(id)
      })
    },
    setState: (id, state) => db.run('UPDATE requests SET state = ?, updated_at = ? WHERE id = ?', state, now(), id).changes,
  }

  // ---------- 旧数据迁移的进度 ----------
  const legacy = {
    get: (step) => {
      const r = db.get('SELECT * FROM legacy_migrations WHERE step = ?', step)
      return r ? { step: r.step, state: r.state, startedAt: r.started_at, finishedAt: r.finished_at, report: fromJson(r.report_json, {}), error: r.error } : null
    },
    list: () => db.all('SELECT step FROM legacy_migrations ORDER BY started_at').map((r) => legacy.get(r.step)),
    start: (step) => db.run(`INSERT INTO legacy_migrations(step, state, started_at) VALUES (?, 'running', ?)
      ON CONFLICT(step) DO UPDATE SET state = 'running', started_at = excluded.started_at, finished_at = NULL, error = NULL`, step, now()),
    finish: (step, report) => db.run("UPDATE legacy_migrations SET state = 'done', finished_at = ?, report_json = ?, error = NULL WHERE step = ?", now(), toJson(report || {}), step),
    fail: (step, error) => db.run("UPDATE legacy_migrations SET state = 'failed', finished_at = ?, error = ? WHERE step = ?", now(), String(error).slice(0, 2000), step),
  }

  function info() {
    const count = (t) => Number(db.get(`SELECT COUNT(*) AS n FROM ${t}`).n)
    return {
      file: db.file,
      version: schemaVersion(db),
      latest: LATEST_VERSION,
      migratedFrom: migration.from,
      backup: migration.backup,
      counts: { chats: count('chats'), messages: count('messages'), assets: count('assets'), occurrences: count('asset_occurrences'), requests: count('requests') },
    }
  }

  return { db, tx: db.tx, nextSeq, meta, chats, messages, assets, occurrences, epochs, requests, legacy, info, close: () => db.close() }
}

function rowChat(r) {
  return r ? { id: r.id, account: r.account_id, kind: r.kind, platformId: r.platform_id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at } : null
}
function rowMessage(r) {
  if (!r) return null
  return {
    id: r.id, account: r.account_id, chatId: r.chat_id, eventKind: r.event_kind, platformMsgId: r.platform_msg_id,
    authorId: r.author_id, authorName: r.author_name, platformTime: r.platform_time, receivedAt: r.received_at, recvSeq: Number(r.recv_seq),
    text: r.text, segments: fromJson(r.segments_json, []), replyTo: r.reply_to, forwards: fromJson(r.forwards_json, []),
    mentioned: Boolean(r.mentioned), traceId: r.trace_id, recalledAt: r.recalled_at,
  }
}
function rowAsset(r) {
  return r ? { id: r.id, sha256: r.sha256, mime: r.mime, bytes: Number(r.bytes), width: r.width, height: r.height, path: r.path, sourceKind: r.source_kind, state: r.state, createdAt: r.created_at } : null
}
function rowOccurrence(r) {
  if (!r) return null
  return {
    id: r.id, messageId: r.message_id, chatId: r.chat_id, authorId: r.author_id, segIndex: Number(r.seg_index), kind: r.kind,
    assetId: r.asset_id, remote: fromJson(r.remote_json, {}), state: r.state, error: r.error, scope: fromJson(r.scope_json, null), analysis: fromJson(r.analysis_json, {}),
    createdAt: r.created_at, updatedAt: r.updated_at,
  }
}
function rowRequest(r) {
  if (!r) return null
  return {
    id: r.id, chatId: r.chat_id, actorId: r.actor_id, sourceMessageIds: fromJson(r.source_message_ids_json, []), replyTarget: r.reply_target,
    policyRevision: Number(r.policy_revision), epoch: Number(r.epoch), state: r.state, traceId: r.trace_id, createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

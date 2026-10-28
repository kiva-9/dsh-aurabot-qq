// 发送记录（outbox）：一次回复拆成几段，每段先落库再发，按顺序发，每段单独记回执。
//
// 状态：pending → sending → delivered（网关回了成功）
//   failed   网关明确拒绝 / 没发出去且重试用完
//   unknown  发出去了但没等到回应（超时、断线）：可能已经送达，不盲目重发
//   canceled 代次变了（换人设、重开会话）或积压太久，作废不发
//   skipped  按设置不发（总开关关、试运行）
// 部分成功时只补剩下的段；重启时还在 sending 的段记成 unknown。

import { newId } from '../core/ids.js'
import { toJson, fromJson } from '../storage/db.js'

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * @param {object} o
 * @param {object} o.storage createStorage 的返回值
 * @param {(chatId: string, message: object[], info: object) => Promise<object|null>} o.send
 *   真正发到 QQ：返回网关结果（含 message_id）；返回 null 表示按设置不发（skipped）；
 *   出错时抛 OneBotError，带 outcome（rejected / not_sent / unknown）
 * @param {(message: object[]) => Promise<object[]>} [o.resolve] 发送前把资产引用换成实际内容
 */
export function createOutbox({ storage, send, resolve = async (m) => m, log, now = () => Date.now(), sleep = sleepMs, retries = 2, retryDelayMs = 1500 }) {
  const db = storage.db
  const inflight = new Map() // batchId → Promise（同一批不并发发两次）

  /** 登记一次回复的几段。items: [{ kind, message, note, delayMs }]。返回 batchId。 */
  function enqueue({ chatId, requestId = null, epoch, items }) {
    if (!Array.isArray(items) || !items.length) throw new Error('没有要发的内容')
    const batchId = newId('obx')
    const ep = epoch ?? storage.epochs.current(chatId)
    db.tx(() => {
      items.forEach((it, seq) => {
        const t = now()
        db.run(`INSERT INTO outbox(id, batch_id, seq, chat_id, request_id, epoch, kind, payload_json, idempotency_key, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId('out'), batchId, seq, chatId, requestId, ep, it.kind || 'other',
        toJson({ message: it.message, note: it.note || '', delayMs: it.delayMs || 0 }), `${batchId}:${seq}`, t, t)
      })
    })
    return batchId
  }

  const rowsOf = (batchId) => db.all('SELECT * FROM outbox WHERE batch_id = ? ORDER BY seq', batchId).map(row)
  const setState = (id, state, extra = {}) => db.run(
    'UPDATE outbox SET state = ?, platform_msg_id = COALESCE(?, platform_msg_id), last_error = ?, attempts = attempts + ?, updated_at = ? WHERE id = ?',
    state, extra.platformMsgId ?? null, extra.error ?? null, extra.attempt ? 1 : 0, now(), id)

  async function sendOne(r) {
    // 代次变了：这段是上一个角色 / 上一段会话生成的，作废
    if (r.epoch !== storage.epochs.current(r.chatId)) {
      setState(r.id, 'canceled', { error: '会话代次已变' })
      return 'canceled'
    }
    for (let attempt = 0; ; attempt++) {
      setState(r.id, 'sending', { attempt: true })
      try {
        const message = await resolve(r.payload.message)
        const res = await send(r.chatId, message, { note: r.payload.note, kind: r.kind, outboxId: r.id, requestId: r.requestId })
        if (res === null || res === undefined) {
          setState(r.id, 'skipped')
          return 'skipped'
        }
        setState(r.id, 'delivered', { platformMsgId: res.message_id !== undefined ? String(res.message_id) : null })
        return 'delivered'
      } catch (error) {
        const outcome = error?.outcome || 'unknown'
        if (outcome === 'not_sent' && attempt < retries) {
          setState(r.id, 'pending', { error: error.message })
          await sleep(retryDelayMs * (attempt + 1))
          continue
        }
        const state = outcome === 'unknown' ? 'unknown' : 'failed'
        setState(r.id, state, { error: error.message })
        log?.warn?.(`发到 ${r.chatId} 的第 ${r.seq + 1} 段${state === 'unknown' ? '不确定发没发出去' : '没发出去'}：`, error.message)
        return state
      }
    }
  }

  /** 把这一批还没发的段按顺序发出去。返回各状态的段数和 QQ 消息 ID。 */
  function deliver(batchId) {
    if (inflight.has(batchId)) return inflight.get(batchId)
    const p = (async () => {
      const rows = rowsOf(batchId)
      let first = true
      for (const r of rows) {
        if (r.state !== 'pending') continue
        if (!first && r.payload.delayMs > 0) await sleep(r.payload.delayMs)
        first = false
        await sendOne(r)
      }
      return summary(batchId)
    })().finally(() => inflight.delete(batchId))
    inflight.set(batchId, p)
    return p
  }

  function summary(batchId) {
    const rows = rowsOf(batchId)
    const count = (s) => rows.filter((r) => r.state === s).length
    return {
      batchId,
      total: rows.length,
      delivered: count('delivered'),
      failed: count('failed'),
      unknown: count('unknown'),
      canceled: count('canceled'),
      skipped: count('skipped'),
      pending: count('pending') + count('sending'),
      messageIds: rows.filter((r) => r.platformMsgId).map((r) => r.platformMsgId),
    }
  }

  /**
   * 启动时调用：上次停在 sending 的段记成 unknown（可能已经发出）；
   * 积压的 pending 太旧就作废（几分钟前的话现在发出去不对劲），没过期的接着发。
   */
  async function recover({ maxAgeMs = 2 * 60_000 } = {}) {
    const t = now()
    const stuck = db.run("UPDATE outbox SET state = 'unknown', last_error = '重启时还在发送中', updated_at = ? WHERE state = 'sending'", t).changes
    const stale = db.run("UPDATE outbox SET state = 'canceled', last_error = '积压太久', updated_at = ? WHERE state = 'pending' AND created_at < ?", t, t - maxAgeMs).changes
    const batches = db.all("SELECT DISTINCT batch_id FROM outbox WHERE state = 'pending' ORDER BY created_at").map((r) => r.batch_id)
    for (const b of batches) await deliver(b)
    return { stuck, stale, resumed: batches.length }
  }

  /** 作废某个聊天里还没发的段（取消、换人设时用）。 */
  function cancelPending(chatId, reason = '已取消') {
    return db.run("UPDATE outbox SET state = 'canceled', last_error = ?, updated_at = ? WHERE chat_id = ? AND state = 'pending'", reason, now(), chatId).changes
  }

  return { enqueue, deliver, summary, recover, cancelPending, rows: rowsOf }
}

function row(r) {
  return {
    id: r.id, batchId: r.batch_id, seq: Number(r.seq), chatId: r.chat_id, requestId: r.request_id, epoch: Number(r.epoch), kind: r.kind,
    payload: fromJson(r.payload_json, { message: [] }), state: r.state, attempts: Number(r.attempts), platformMsgId: r.platform_msg_id,
    lastError: r.last_error, createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

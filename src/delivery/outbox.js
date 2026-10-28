// 发送记录：稳定 batchId 幂等登记；整批 claim、逐段落库、逐段核对取消条件。
// unknown 可能已经送达，永不自动重发；显式 retry 只补有明确未发送依据的段。
// claim 和发送结果依据放在现有 meta 表，不需要改数据库结构。

import { hostname } from 'node:os'
import { isDeepStrictEqual } from 'node:util'
import { newId } from '../core/ids.js'
import { toJson, fromJson } from '../storage/db.js'

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))
const host = hostname()
const runtimeId = newId('obw')
const activeClaims = new Set()
const metaKey = (batchId) => `outbox:batch:${batchId}`
const retryable = (outcome) => outcome === 'not_sent' || outcome === 'rejected'
const errorText = (error) => String(error?.message ?? error)

// 不能按时间过期抢占：resolve / guard / 网关请求可能仍在运行。
// 本运行实例可确认 worker 已结束；其他实例仅回收确定退出的本机进程。
// 权限不足、异机、PID 复用均保守地保留 claim。
function ownerAlive(claim) {
  if (claim.host !== host || !Number.isSafeInteger(claim.pid) || claim.pid <= 0) return true
  if (claim.pid === process.pid && claim.runtimeId === runtimeId) return activeClaims.has(claim.token)
  try { process.kill(claim.pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
}

/**
 * @param {object} o
 * @param {object} o.storage createStorage 的返回值
 * @param {(chatId: string, message: object[], info: object) => Promise<object|null>} o.send
 *   返回网关结果（含 message_id）；null / undefined 表示明确没发（skipped）；
 *   抛错只有 outcome=not_sent / rejected 才能重试，其他一律 unknown。
 * @param {(message: object[]) => Promise<object[]>} [o.resolve] 发送前把资产引用换成实际内容
 */
export function createOutbox({ storage, send, resolve = async (m) => m, log, now = () => Date.now(), sleep = sleepMs, retries = 2, retryDelayMs = 1500 }) {
  const db = storage.db
  const inflight = new Map()

  function metadata(batchId) {
    const saved = db.get('SELECT value FROM meta WHERE key = ?', metaKey(batchId))
    if (!saved) return { outcomes: {}, requiresGuard: false, claim: null }
    const m = fromJson(saved.value)
    if (!m || typeof m !== 'object' || !m.outcomes || typeof m.outcomes !== 'object' || Array.isArray(m.outcomes)) {
      throw new Error(`outbox 批次 ${batchId} 的恢复记录损坏，停止发送`)
    }
    return m
  }
  const saveMetadata = (batchId, m) => db.run(
    'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', metaKey(batchId), toJson(m))
  const rawRows = (batchId) => db.all('SELECT * FROM outbox WHERE batch_id = ? ORDER BY seq', batchId)
  const rowsOf = (batchId) => {
    const m = metadata(batchId)
    return rawRows(batchId).map((r) => ({ ...row(r), outcome: m.outcomes[r.id] ?? null }))
  }

  /**
   * enqueue({ batchId?, chatId, requestId?, epoch?, items, requiresGuard? }) → batchId。
   * 省略 batchId 保持旧调用；提供时整批幂等，重复 ID 的内容/目标不一致抛 OUTBOX_BATCH_CONFLICT。
   * 重复调用省略 epoch 时沿用原代次；提供了 epoch 则必须匹配。
   * job 有取消 guard 时传 requiresGuard:true，堵住 enqueue 后、deliver 前崩溃的恢复窗口。
   */
  function enqueue({ batchId = newId('obx'), chatId, requestId = null, epoch, items, requiresGuard = false }) {
    if (typeof batchId !== 'string' || !batchId.trim()) throw new Error('batchId 必须是非空字符串')
    if (!Array.isArray(items) || !items.length) throw new Error('没有要发的内容')
    const parts = items.map((it) => ({ kind: it.kind || 'other', payload: fromJson(toJson({
      message: it.message, note: it.note || '', delayMs: it.delayMs || 0, ...(it.force ? { force: true } : {}),
    })) }))
    db.tx(() => {
      const existing = rawRows(batchId).map(row)
      const ep = epoch ?? existing[0]?.epoch ?? storage.epochs.current(chatId)
      if (existing.length) {
        const matches = existing.length === parts.length && existing.every((r, seq) =>
          r.seq === seq && r.chatId === chatId && r.requestId === requestId && r.epoch === ep &&
          r.kind === parts[seq].kind && isDeepStrictEqual(r.payload, parts[seq].payload))
        if (!matches) throw Object.assign(new Error(`batchId ${batchId} 已用于不同的发送内容`), { code: 'OUTBOX_BATCH_CONFLICT' })
      } else {
        const t = now()
        parts.forEach((part, seq) => {
          db.run(`INSERT INTO outbox(id, batch_id, seq, chat_id, request_id, epoch, kind, payload_json, idempotency_key, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          newId('out'), batchId, seq, chatId, requestId, ep, part.kind, toJson(part.payload), `${batchId}:${seq}`, t, t)
        })
      }
      const m = metadata(batchId)
      m.requiresGuard ||= Boolean(requiresGuard)
      saveMetadata(batchId, m)
    })
    return batchId
  }

  // db.tx 使用 BEGIN IMMEDIATE：检查占用、回收孤儿、重置可重试段和新 claim 原子完成。
  // claim 覆盖 resolve、段间停顿和重试等待，期间别的实例/进程只能读取汇总。
  function claimBatch(batchId, { shouldSend, retry = false, maxAgeMs } = {}) {
    const acquired = db.tx(() => {
      const rows = rawRows(batchId)
      const out = { token: null, stuck: 0, stale: 0 }
      if (!rows.length) return out
      const m = metadata(batchId)
      if (m.claim && ownerAlive(m.claim)) return out
      m.claim = null
      m.requiresGuard ||= Boolean(shouldSend)
      const t = now()
      for (const r of rows) {
        if (r.state === 'sending') {
          db.run("UPDATE outbox SET state = 'unknown', last_error = '发送者已退出，发送结果不确定', updated_at = ? WHERE id = ? AND state = 'sending'", t, r.id)
          m.outcomes[r.id] = 'unknown'
          out.stuck++
        }
      }
      if (!m.requiresGuard || shouldSend) {
        if (retry) {
          for (const r of rows) {
            // 旧 failed 缺少明确 outcome，不能仅凭状态/错误文案推测可重试。
            // skipped 的接口语义本身就是没调用网关，旧数据也可显式补发。
            if (r.state === 'skipped' || (r.state === 'failed' && retryable(m.outcomes[r.id]))) {
              db.run("UPDATE outbox SET state = 'pending', last_error = NULL, updated_at = ? WHERE id = ? AND state IN ('failed', 'skipped')", t, r.id)
            }
          }
        }
        if (maxAgeMs !== undefined) {
          out.stale = db.run("UPDATE outbox SET state = 'canceled', last_error = '积压太久', updated_at = ? WHERE batch_id = ? AND state = 'pending' AND created_at < ?", t, batchId, t - maxAgeMs).changes
        }
        if (db.get("SELECT id FROM outbox WHERE batch_id = ? AND state = 'pending' LIMIT 1", batchId)) {
          out.token = newId('clm')
          m.claim = { token: out.token, pid: process.pid, host, runtimeId, claimedAt: t }
        }
      }
      saveMetadata(batchId, m)
      return out
    })
    if (acquired.token) activeClaims.add(acquired.token)
    return acquired
  }

  function release(batchId, token) {
    db.tx(() => {
      const m = metadata(batchId)
      if (m.claim?.token !== token) return
      m.claim = null
      saveMetadata(batchId, m)
    })
  }

  // 只允许持有 batch claim 的 worker 改自己读取的状态；发送结果依据和状态一起提交。
  function setState(r, token, from, state, { outcome = null, platformMsgId = null, error = null } = {}) {
    return db.tx(() => {
      const m = metadata(r.batchId)
      if (m.claim?.token !== token) return false
      const changed = db.run(`UPDATE outbox SET state = ?, platform_msg_id = COALESCE(?, platform_msg_id), last_error = ?,
        attempts = attempts + ?, updated_at = ? WHERE id = ? AND state = ?`,
      state, platformMsgId, error, state === 'sending' ? 1 : 0, now(), r.id, from).changes
      if (changed) {
        if (outcome) m.outcomes[r.id] = outcome
        else delete m.outcomes[r.id]
        saveMetadata(r.batchId, m)
      }
      return Boolean(changed)
    })
  }

  function pending(r, token, shouldSend) {
    const m = metadata(r.batchId)
    if (m.claim?.token !== token || (m.requiresGuard && !shouldSend)) return false
    if (db.get('SELECT state FROM outbox WHERE id = ?', r.id)?.state !== 'pending') return false
    if (r.epoch !== storage.epochs.current(r.chatId)) {
      setState(r, token, 'pending', 'canceled', { error: '会话代次已变' })
      return false
    }
    return true
  }

  async function sendOne(r, token, shouldSend) {
    for (let attempt = 0; ; attempt++) {
      if (!pending(r, token, shouldSend)) return
      let message
      try {
        message = await resolve(r.payload.message, { chatId: r.chatId, requestId: r.requestId, epoch: r.epoch })
        if (!pending(r, token, shouldSend)) return
        if (shouldSend) {
          const verdict = shouldSend({ ...r, ...row(db.get('SELECT * FROM outbox WHERE id = ?', r.id)) })
          // 同步 guard 后不额外让出执行权；异步 guard 完成后仍须再次核对 epoch。
          const allowed = verdict && typeof verdict.then === 'function' ? await verdict : verdict
          if (!allowed) {
            setState(r, token, 'pending', 'canceled', { error: 'shouldSend 已阻止发送' })
            return
          }
        }
      } catch (error) {
        // resolve / guard 失败时尚未调用 send，确定没发；不把它误记成 unknown。
        setState(r, token, 'pending', 'failed', { outcome: 'not_sent', error: `发送前检查失败：${errorText(error)}` })
        return
      }
      // 最后一次异步检查之后再核对 epoch 和状态，并原子 claim 这一段。
      const claimed = db.tx(() => pending(r, token, shouldSend) && setState(r, token, 'pending', 'sending', { outcome: 'unknown' }))
      if (!claimed) return
      let res
      try {
        res = await send(r.chatId, message, {
          note: r.payload.note, kind: r.kind, outboxId: r.id, requestId: r.requestId,
          force: Boolean(r.payload.force), batchId: r.batchId, seq: r.seq, epoch: r.epoch, idempotencyKey: r.idempotencyKey,
        })
      } catch (error) {
        const outcome = retryable(error?.outcome) ? error.outcome : 'unknown'
        const again = outcome === 'not_sent' && attempt < retries
        const state = again ? 'pending' : outcome === 'unknown' ? 'unknown' : 'failed'
        if (!setState(r, token, 'sending', state, { outcome, error: errorText(error) })) return
        if (again) {
          await sleep(retryDelayMs * (attempt + 1))
          continue
        }
        log?.warn?.(`发到 ${r.chatId} 的第 ${r.seq + 1} 段${state === 'unknown' ? '不确定发没发出去' : '没发出去'}：`, errorText(error))
        return
      }
      // 回执落库失败必须向外抛；不能被 send 的 catch 当作「没发」重新发送。
      if (res === null || res === undefined) setState(r, token, 'sending', 'skipped', { outcome: 'not_sent' })
      else setState(r, token, 'sending', 'delivered', { platformMsgId: res.message_id !== undefined ? String(res.message_id) : null })
      return
    }
  }

  function runClaimed(batchId, token, shouldSend) {
    // 先登记 promise 再运行用户回调，阻止同步重入 deliver/retry。
    const p = Promise.resolve().then(async () => {
      try {
        let first = true
        for (const r of rowsOf(batchId)) {
          if (r.state !== 'pending') continue
          if (!first && r.payload.delayMs > 0) await sleep(r.payload.delayMs)
          first = false
          await sendOne(r, token, shouldSend)
        }
        return summary(batchId)
      } finally {
        // 即使释放 claim 的持久化失败，也能证明这个运行实例的 worker 已经结束。
        try { release(batchId, token) } finally { activeClaims.delete(token) }
      }
    }).finally(() => inflight.delete(batchId))
    inflight.set(batchId, p)
    return p
  }

  function start(batchId, { shouldSend } = {}, retry = false) {
    if (shouldSend !== undefined && typeof shouldSend !== 'function') return Promise.reject(new TypeError('shouldSend 必须是函数'))
    if (inflight.has(batchId)) return inflight.get(batchId)
    try {
      const { token } = claimBatch(batchId, { shouldSend, retry })
      return token ? runClaimed(batchId, token, shouldSend) : Promise.resolve(summary(batchId))
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /** 仅发送 pending；shouldSend(row) 支持异步，false 记 canceled，抛错记明确未发送。 */
  const deliver = (batchId, options) => start(batchId, options)
  /** 显式补发 failed(not_sent/rejected) 和 skipped；不复制段、不重发 delivered/unknown/canceled。 */
  const retry = (batchId, options) => start(batchId, options, true)

  function summary(batchId) {
    const rows = rowsOf(batchId)
    const count = (s) => rows.filter((r) => r.state === s).length
    return {
      batchId, total: rows.length, delivered: count('delivered'), failed: count('failed'), unknown: count('unknown'),
      canceled: count('canceled'), skipped: count('skipped'), pending: count('pending') + count('sending'),
      messageIds: rows.filter((r) => r.platformMsgId).map((r) => r.platformMsgId),
    }
  }

  /**
   * 活 worker 的整批完全不碰；孤儿 sending → unknown，没过期的 pending 接着发。
   * requiresGuard 批次没有提供 shouldSend 时保留 pending，交回 job worker 检查后发送。
   * 不重置 failed/skipped/unknown；恢复只算自己成功 claim 的批次。
   */
  async function recover({ maxAgeMs = 2 * 60_000, shouldSend } = {}) {
    if (shouldSend !== undefined && typeof shouldSend !== 'function') throw new TypeError('shouldSend 必须是函数')
    const result = { stuck: 0, stale: 0, resumed: 0 }
    const batches = db.all("SELECT batch_id FROM outbox WHERE state IN ('pending', 'sending') GROUP BY batch_id ORDER BY MIN(created_at)")
    for (const { batch_id: batchId } of batches) {
      const claim = claimBatch(batchId, { shouldSend, maxAgeMs })
      result.stuck += claim.stuck
      result.stale += claim.stale
      if (claim.token) {
        result.resumed++
        await runClaimed(batchId, claim.token, shouldSend)
      }
    }
    return result
  }

  /** 作废还没真正发到网关的段，包括 resolve / guard / 重试等待中的段。 */
  function cancelPending(chatId, reason = '已取消') {
    return db.run("UPDATE outbox SET state = 'canceled', last_error = ?, updated_at = ? WHERE chat_id = ? AND state = 'pending'", reason, now(), chatId).changes
  }

  const byPlatformId = (chatId, pid) => {
    const r = db.get('SELECT * FROM outbox WHERE chat_id = ? AND platform_msg_id = ? LIMIT 1', chatId, String(pid))
    return r ? { ...row(r), outcome: metadata(r.batch_id).outcomes[r.id] ?? null } : null
  }

  return { enqueue, deliver, retry, summary, recover, cancelPending, rows: rowsOf, byPlatformId }
}

function row(r) {
  return {
    id: r.id, batchId: r.batch_id, seq: Number(r.seq), chatId: r.chat_id, requestId: r.request_id, epoch: Number(r.epoch), kind: r.kind,
    payload: fromJson(r.payload_json, { message: [] }), idempotencyKey: r.idempotency_key, state: r.state, attempts: Number(r.attempts), platformMsgId: r.platform_msg_id,
    lastError: r.last_error, createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

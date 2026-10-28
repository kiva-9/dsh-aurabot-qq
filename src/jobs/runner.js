// 可恢复任务：有费用或外部状态变化的事（生图……）都登记成任务，后台按状态一步步推进。
//
// 状态：queued → preparing → submitting → running → generated → delivery_pending → delivered
//   waiting_input 等输入（图片还没下载好）  retry_wait 确定没执行的临时故障，等一会儿重试
//   failed 失败  cancel_requested 取消中  canceled 已取消  unknown 请求可能已被服务接收但不知道结果（不自动重发）
//
// - 先在事务里登记任务和额度，再去调外部服务
// - 每次外部尝试单独记一行（attempt），记下服务的任务 ID 和计费是否可知
// - 结果先存成资产（generated），再发 QQ；发送失败只重试发送，不重新生成
// - worker 用租约领任务，同一个任务不会被两个 worker 同时推进；重启时按状态恢复
// - 取消是一个过程：服务支持就请求取消；已经在画的至少不再发出去，不假报「已经停止计费」

import { newId, traceId } from '../core/ids.js'
import { toJson, fromJson } from '../storage/db.js'

export const ACTIVE = ['queued', 'preparing', 'waiting_input', 'submitting', 'running', 'retry_wait', 'generated', 'delivery_pending', 'cancel_requested']
export const FINAL = ['delivered', 'failed', 'canceled', 'unknown']
const PARKED = 9e15 // not_before 设成它 = 停住，等人工处理（重发 / 重试）

const dayOf = (t) => new Date(t).toISOString().slice(0, 10)

/**
 * @param {object} o
 * @param {object} o.storage
 * @param {Record<string, object>} o.handlers kind → {
 *     prepare?(job) → { ready: true } | { wait: '原因', untilMs }
 *     submit(job, attempt) → { status: 'done', outputs } | { status: 'running', providerTaskId }   出错抛 ProviderError
 *     poll?(job) → 同上，或 { status: 'failed', error }
 *     store(job, outputs) → output（存成资产后要记进任务的内容）
 *     deliver(job) → { delivered: boolean, error? }
 *     cancel?(job) → { ok, message }
 *     notify?(job, event, info)   event: failed / unknown / canceled / delivered / waiting
 *     quota?(job) → [{ scope, limit }]   每天的额度
 *     perChat?: number  这个聊天同时最多几个在跑
 *   }
 */
export function createJobRunner({ storage, handlers, log, now = () => Date.now(), owner = `host-${process.pid}`, leaseMs = 120_000, concurrency = 2, retryBaseMs = 5000, pollMs = 3000 }) {
  const db = storage.db
  const running = new Map() // jobId → Promise
  let timer = null

  const row = (id) => db.get('SELECT * FROM jobs WHERE id = ?', id)
  const job = (id) => view(row(id))

  function set(id, fields) {
    const keys = Object.keys(fields)
    db.run(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => fields[k]), now(), id)
  }

  /**
   * 登记一个任务（和额度预留在同一个事务里）。额度不够时抛错，任务不登记。
   */
  function enqueue({ kind, chatId, requestId = null, actorId, input, parentJobId = null, profileId = null, maxAttempts = 3, epoch }) {
    const h = handlers[kind]
    if (!h) throw new Error(`不认识的任务类型：${kind}`)
    const id = newId('job')
    const t = now()
    const draft = { id, kind, chatId, actorId: String(actorId), input, parentJobId, profileId }
    return db.tx(() => {
      for (const q of h.quota?.(draft) || []) {
        const used = Number(db.get("SELECT COUNT(*) AS n FROM quota_reservations WHERE scope = ? AND day = ? AND state IN ('held', 'used')", q.scope, dayOf(t)).n)
        if (used >= q.limit) throw Object.assign(new Error(q.message || `今天的额度用完了（${q.limit} 次）`), { code: 'QUOTA' })
        db.run("INSERT INTO quota_reservations(id, job_id, scope, day, state, created_at) VALUES (?, ?, ?, ?, 'held', ?)", newId('qta'), id, q.scope, dayOf(t), t)
      }
      db.run(`INSERT INTO jobs(id, kind, chat_id, request_id, actor_id, epoch, state, input_json, parent_job_id, profile_id, max_attempts, trace_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
      id, kind, chatId, requestId, String(actorId), epoch ?? storage.epochs.current(chatId), toJson(input), parentJobId, profileId, maxAttempts, traceId(), t, t)
      return job(id)
    })
  }

  const quotaTo = (jobId, state) => db.run("UPDATE quota_reservations SET state = ? WHERE job_id = ? AND state = 'held'", state, jobId)

  /** 领一个能推进的任务（租约），领不到返回 null。公平：同一个聊天同时在跑的不超过 perChat。 */
  function claim() {
    const t = now()
    const candidates = db.all(`SELECT * FROM jobs WHERE state IN ('queued', 'waiting_input', 'retry_wait', 'running', 'generated', 'delivery_pending', 'cancel_requested')
      AND not_before <= ? AND (lease_owner IS NULL OR lease_until < ?) ORDER BY created_at LIMIT 50`, t, t)
    for (const r of candidates) {
      if (running.has(r.id)) continue
      const h = handlers[r.kind]
      if (!h) continue
      if (['queued', 'retry_wait'].includes(r.state)) {
        const busy = Number(db.get("SELECT COUNT(*) AS n FROM jobs WHERE chat_id = ? AND state IN ('preparing', 'submitting', 'running') AND id != ?", r.chat_id, r.id).n)
        if (busy >= (h.perChat || 1)) continue
      }
      const ok = db.run('UPDATE jobs SET lease_owner = ?, lease_until = ? WHERE id = ? AND (lease_owner IS NULL OR lease_until < ?)', owner, t + leaseMs, r.id, t).changes
      if (ok) return view(row(r.id))
    }
    return null
  }

  const release = (id) => db.run('UPDATE jobs SET lease_owner = NULL, lease_until = NULL WHERE id = ? AND lease_owner = ?', id, owner)

  function attemptOpen(j) {
    const id = newId('att')
    const n = j.attempts + 1
    db.tx(() => {
      db.run("INSERT INTO job_attempts(id, job_id, n, state, started_at) VALUES (?, ?, ?, 'running', ?)", id, j.id, n, now())
      set(j.id, { attempts: n, state: 'submitting' })
    })
    return { id, n }
  }
  const attemptClose = (id, state, extra = {}) => db.run('UPDATE job_attempts SET state = ?, billing = COALESCE(?, billing), provider_task_id = COALESCE(?, provider_task_id), error_kind = ?, error = ?, finished_at = ? WHERE id = ?',
    state, extra.billing ?? null, extra.providerTaskId ?? null, extra.errorKind ?? null, extra.error ?? null, now(), id)

  const canceling = (id) => row(id)?.state === 'cancel_requested'

  /** 把一个领到的任务往前推一步（可能连推几步）。 */
  async function advance(j) {
    const h = handlers[j.kind]
    try {
      if (j.state === 'cancel_requested') return await doCancel(j, h)
      if (j.state === 'queued' || j.state === 'waiting_input' || j.state === 'retry_wait') {
        set(j.id, { state: 'preparing' })
        const p = h.prepare ? await h.prepare(j) : { ready: true }
        if (canceling(j.id)) return await doCancel(job(j.id), h)
        if (!p.ready) {
          const until = j.input.waitUntil || p.untilMs || now() + 60_000
          if (now() > until) return fail(j, h, 'invalid', p.wait || '等不到需要的输入', 'none')
          set(j.id, { state: 'waiting_input', not_before: now() + 2000, error: p.wait || '' })
          if (j.state !== 'waiting_input') h.notify?.(job(j.id), 'waiting', { reason: p.wait })
          return
        }
        return await submit(job(j.id), h)
      }
      if (j.state === 'running') return await poll(j, h)
      if (j.state === 'generated' || j.state === 'delivery_pending') return await deliver(j, h)
    } catch (error) {
      log?.warn?.(`任务 ${j.id} 出错：`, error.message)
      fail(job(j.id), h, error.kind || 'unknown', error.message, error.maybeCharged === false ? 'none' : 'unknown')
    } finally {
      release(j.id)
    }
  }

  async function submit(j, h) {
    const at = attemptOpen(j)
    let res
    try {
      res = await h.submit(job(j.id), at)
    } catch (error) {
      const kind = error.kind || 'unknown'
      const billing = error.maybeCharged ? 'unknown' : 'none'
      attemptClose(at.id, kind === 'unknown' ? 'unknown' : 'failed', { billing, errorKind: kind, error: error.message })
      if (canceling(j.id)) return finishCanceled(j, h, billing === 'none')
      if ((kind === 'transient' || kind === 'quota') && j.attempts + 1 < j.maxAttempts) {
        const wait = retryBaseMs * 2 ** j.attempts * (kind === 'quota' ? 4 : 1)
        set(j.id, { state: 'retry_wait', not_before: now() + wait, error_kind: kind, error: error.message })
        log?.info?.(`任务 ${j.id} 临时失败，${Math.round(wait / 1000)} 秒后重试：${error.message}`)
        return
      }
      if (kind === 'unknown') {
        set(j.id, { state: 'unknown', error_kind: kind, error: error.message, finished_at: now() })
        h.notify?.(job(j.id), 'unknown', { message: error.message })
        return
      }
      return fail(job(j.id), h, kind, error.message, billing)
    }
    return afterResult(j, h, res, at)
  }

  async function poll(j, h) {
    if (!h.poll) return fail(j, h, 'unknown', '这个服务不能查进度', 'unknown')
    const at = db.get('SELECT id FROM job_attempts WHERE job_id = ? ORDER BY n DESC LIMIT 1', j.id)
    let res
    try {
      res = await h.poll(j)
    } catch (error) {
      // 查进度出错不等于任务失败：过一会儿再查，查太多次才放弃
      const tries = (j.output.pollErrors || 0) + 1
      if (tries > 20) {
        set(j.id, { state: 'unknown', error_kind: 'unknown', error: '一直查不到进度：' + error.message, finished_at: now() })
        h.notify?.(job(j.id), 'unknown', { message: error.message })
        return
      }
      set(j.id, { output_json: toJson({ ...j.output, pollErrors: tries }), not_before: now() + pollMs * 2 })
      return
    }
    return afterResult(j, h, res, at)
  }

  async function afterResult(j, h, res, at) {
    if (res.status === 'running') {
      if (at) attemptClose(at.id, 'running', { providerTaskId: res.providerTaskId })
      db.run("UPDATE job_attempts SET state = 'running' WHERE id = ?", at?.id)
      set(j.id, { state: canceling(j.id) ? 'cancel_requested' : 'running', provider_task_id: res.providerTaskId ?? j.providerTaskId, not_before: now() + pollMs })
      return
    }
    if (res.status === 'failed') {
      if (at) attemptClose(at.id, 'failed', { billing: 'unknown', errorKind: res.error?.kind, error: res.error?.message })
      return fail(job(j.id), h, res.error?.kind || 'invalid', res.error?.message || '服务说失败了', 'unknown')
    }
    // 画好了：先存成资产（即使用户已经取消，也留着结果，只是不发）
    const output = await h.store(job(j.id), res.outputs)
    if (at) attemptClose(at.id, 'done', { billing: res.billing || 'charged', providerTaskId: res.providerTaskId })
    quotaTo(j.id, 'used')
    if (canceling(j.id)) {
      set(j.id, { state: 'canceled', output_json: toJson({ ...job(j.id).output, ...output }), error: '画好时已经取消，没发出去', finished_at: now() })
      h.notify?.(job(j.id), 'canceled', { afterGenerated: true })
      return
    }
    set(j.id, { state: 'generated', output_json: toJson({ ...job(j.id).output, ...output }), error_kind: null, error: null })
    return deliver(job(j.id), h)
  }

  async function deliver(j, h) {
    set(j.id, { state: 'delivery_pending' })
    const r = await h.deliver(j)
    if (r.delivered) {
      set(j.id, { state: 'delivered', finished_at: now(), error: null })
      h.notify?.(job(j.id), 'delivered', {})
      return
    }
    // 发送没成功：停住等重发，不重新生成
    set(j.id, { state: 'delivery_pending', not_before: PARKED, error: '发送没成功：' + (r.error || '看日志') })
    log?.warn?.(`任务 ${j.id} 画好了但没发出去：${r.error || ''}`)
  }

  function fail(j, h, kind, message, billing) {
    set(j.id, { state: 'failed', error_kind: kind, error: message, finished_at: now() })
    if (billing === 'none') quotaTo(j.id, 'released')
    h.notify?.(job(j.id), 'failed', { kind, message })
  }

  async function doCancel(j, h) {
    let msg = ''
    if (j.providerTaskId && h.cancel) {
      try { msg = (await h.cancel(j)).message || '' } catch (error) { msg = '服务那边没取消成功：' + error.message }
    }
    finishCanceled(j, h, !j.providerTaskId && j.attempts === 0, msg)
  }

  function finishCanceled(j, h, neverSubmitted, msg = '') {
    set(j.id, { state: 'canceled', finished_at: now(), error: msg || null })
    if (neverSubmitted) quotaTo(j.id, 'released')
    h.notify?.(job(j.id), 'canceled', { message: msg })
  }

  /**
   * 取消。没开始的直接取消；正在提交 / 在画的标成取消中（worker 去请求服务取消，画好了也不发）；
   * 画好还没发的直接取消（不发）。by：谁要取消（只有任务的主人或者 force 才行）。
   */
  function cancel(id, { by, force = false } = {}) {
    return db.tx(() => {
      const j = job(id)
      if (!j) return { ok: false, message: '没有这个任务' }
      if (!force && by !== undefined && String(by) !== j.actorId) return { ok: false, message: '只能取消自己的任务' }
      if (FINAL.includes(j.state)) return { ok: false, message: `这个任务已经${STATE_LABEL[j.state]}了` }
      if (['queued', 'waiting_input', 'retry_wait'].includes(j.state)) {
        set(id, { state: 'canceled', finished_at: now() })
        if (j.attempts === 0 || j.state !== 'retry_wait') quotaTo(id, 'released')
        return { ok: true, message: '取消了，还没开始画' }
      }
      if (['generated', 'delivery_pending'].includes(j.state)) {
        set(id, { state: 'canceled', finished_at: now(), error: '画好了，按要求没发' })
        return { ok: true, message: '已经画好了，不发了' }
      }
      set(id, { state: 'cancel_requested', not_before: 0 })
      return { ok: true, message: '在取消了：已经在画的可能停不下来，画好了也不会发出来' }
    })
  }

  /** 发送失败停住的任务：重新发一次（不重新生成）。 */
  function resend(id) {
    const j = job(id)
    if (!j) return { ok: false, message: '没有这个任务' }
    if (!['delivery_pending', 'generated'].includes(j.state)) return { ok: false, message: '只有画好了还没发出去的任务能重发' }
    set(id, { not_before: 0, error: null })
    kick()
    return { ok: true, message: '在重发了' }
  }

  /** 启动时调用：上次停在半路的任务按状态恢复。 */
  function recover() {
    const t = now()
    const out = { requeued: 0, unknown: 0, polling: 0, delivering: 0 }
    db.tx(() => {
      for (const r of db.all("SELECT * FROM jobs WHERE state IN ('preparing', 'submitting', 'running', 'generated', 'delivery_pending')")) {
        if (r.state === 'preparing') { set(r.id, { state: 'queued', lease_owner: null, lease_until: null }); out.requeued++ }
        else if (r.state === 'submitting') {
          // 请求可能已经被服务接收了：有服务任务 ID 就接着查，没有就标成不确定（不盲目重发，可能重复计费）
          const at = db.get('SELECT provider_task_id FROM job_attempts WHERE job_id = ? ORDER BY n DESC LIMIT 1', r.id)
          if (at?.provider_task_id) { set(r.id, { state: 'running', provider_task_id: at.provider_task_id, lease_owner: null, lease_until: null, not_before: t }); out.polling++ }
          else { set(r.id, { state: 'unknown', error: '重启时请求正在发出去，不确定服务有没有收到', lease_owner: null, lease_until: null, finished_at: t }); out.unknown++ }
        } else if (r.state === 'running') { set(r.id, { lease_owner: null, lease_until: null, not_before: t }); out.polling++ }
        else if (r.not_before < PARKED) { set(r.id, { lease_owner: null, lease_until: null }); out.delivering++ }
      }
    })
    return out
  }

  /** 推进一轮：领满并发上限的任务，等它们这一步做完。 */
  async function tick() {
    const started = []
    while (running.size < concurrency) {
      const j = claim()
      if (!j) break
      const p = advance(j).finally(() => running.delete(j.id))
      running.set(j.id, p)
      started.push(p)
    }
    await Promise.all(started)
    return started.length
  }

  /** 跑到没有能推进的任务为止（测试用）。 */
  async function drain(max = 50) {
    for (let i = 0; i < max; i++) if (!(await tick())) return
  }

  let kicking = false
  function kick() {
    if (kicking) return
    kicking = true
    setImmediate(() => { kicking = false; tick().catch((error) => log?.warn?.('任务推进出错：', error.message)) })
  }

  function start(intervalMs = 1500) {
    if (timer) return
    timer = setInterval(() => tick().catch((error) => log?.warn?.('任务推进出错：', error.message)), intervalMs)
    timer.unref?.()
  }
  function stop() {
    clearInterval(timer)
    timer = null
  }

  const list = ({ chatId, actorId, states, limit = 30 } = {}) => {
    const where = []
    const args = []
    if (chatId) { where.push('chat_id = ?'); args.push(chatId) }
    if (actorId) { where.push('actor_id = ?'); args.push(String(actorId)) }
    if (states?.length) { where.push(`state IN (${states.map(() => '?').join(',')})`); args.push(...states) }
    return db.all(`SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`, ...args, limit).map(view)
  }
  const attempts = (id) => db.all('SELECT * FROM job_attempts WHERE job_id = ? ORDER BY n', id).map((r) => ({ id: r.id, n: Number(r.n), providerTaskId: r.provider_task_id, billing: r.billing, state: r.state, errorKind: r.error_kind, error: r.error, startedAt: r.started_at, finishedAt: r.finished_at }))

  return { enqueue, cancel, resend, recover, tick, drain, kick, start, stop, get: job, list, attempts }
}

export const STATE_LABEL = {
  queued: '排队中', preparing: '准备中', waiting_input: '等输入', submitting: '提交中', running: '在画', retry_wait: '等重试',
  generated: '画好了', delivery_pending: '待发送', delivered: '已发出', failed: '失败', cancel_requested: '取消中', canceled: '已取消', unknown: '结果不确定',
}

function view(r) {
  if (!r) return null
  return {
    id: r.id, kind: r.kind, chatId: r.chat_id, requestId: r.request_id, actorId: r.actor_id, epoch: Number(r.epoch), state: r.state,
    input: fromJson(r.input_json, {}), output: fromJson(r.output_json, {}), parentJobId: r.parent_job_id, profileId: r.profile_id,
    attempts: Number(r.attempts), maxAttempts: Number(r.max_attempts), providerTaskId: r.provider_task_id, errorKind: r.error_kind, error: r.error,
    traceId: r.trace_id, createdAt: r.created_at, updatedAt: r.updated_at, finishedAt: r.finished_at, notBefore: Number(r.not_before),
  }
}

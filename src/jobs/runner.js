// 可恢复任务：先登记与预留额度，再提交外部服务。未知结果不自动重发。
// 每次领取使用独立租约 token；数据库续写、handler 副作用都必须检查 fence。

import { newId, traceId } from '../core/ids.js'
import { toJson, fromJson } from '../storage/db.js'

export const ACTIVE = ['queued', 'preparing', 'waiting_input', 'submitting', 'running', 'retry_wait', 'generated', 'delivery_pending', 'cancel_requested']
export const FINAL = ['delivered', 'failed', 'canceled', 'unknown']
const PARKED = 9e15
const AVAILABLE = '(lease_owner IS NULL OR lease_until IS NULL OR lease_until <= ?)'
const dayOf = (t) => new Date(t).toISOString().slice(0, 10)
const billingOf = (value, fallback = 'unknown') => ['charged', 'free', 'unknown', 'none'].includes(value) ? value : fallback
const errorBilling = (error) => billingOf(error?.billing, error?.maybeCharged === false ? 'none' : 'unknown')
const abortError = (message) => Object.assign(new Error(message), { name: 'AbortError', code: 'JOB_INACTIVE' })

/**
 * 原有 handler 参数不变，只在末尾追加 execution：
 * prepare(job, execution); submit(job, attempt, execution); poll(job, execution);
 * store(job, outputs, execution); deliver(job, execution); cancel(job, execution);
 * notify(job, event, info, execution)。quota(job) / perChat 不变。
 *
 * execution.signal：stop / 取消 / 租约丢失时 abort；每步完成后也失效。
 * guard() / shouldContinue()：同步检查当前领取、状态和有效租约；deliver/notify 还检查 epoch。
 * assertActive()：不再有效时抛 AbortError。
 * commit(fn)：在同步 SQLite 事务内检查上述条件后执行 fn（禁止异步 fn）。
 * handler 在每次 await 后、实际发请求/发送前都须检查 guard，并向下传 signal/guard。
 * runner 无法撤回已经提交给远端的发送，也不能隔离绕过 commit 的 handler 数据库写入。
 *
 * deliver → { delivered, error?, batchId?, failed?, unknown?, canceled?, skipped? }。
 * batchId 保存在 output.deliveryBatchId；回执标志保存在 output.delivery。
 * handler 应在发送前用 commit 持久化刚建立的 outbox batchId，供恢复/人工重发复用。
 *
 * concurrency 限制同库的活跃租约数（各 worker 也受本地上限约束）；perChat 限制
 * 同一聊天的新生成任务。轮询中的任务占聊天名额，暂停的发送失败不阻塞后续生成。
 */
export function createJobRunner({ storage, handlers, log, now = () => Date.now(), owner = 'host', leaseMs = 120_000, concurrency = 2, retryBaseMs = 5000, pollMs = 3000 }) {
  if (!Number.isFinite(leaseMs) || leaseMs < 1) throw new RangeError('leaseMs 必须大于 0')
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('concurrency 必须是正整数')
  const db = storage.db
  const workerToken = String(owner) + ':' + newId('wkr')
  const running = new Map()
  let timer = null
  let immediate = null
  let stopped = false

  const row = (id) => db.get('SELECT * FROM jobs WHERE id = ?', id)
  const job = (id) => view(row(id))
  const attemptRows = (id) => db.all('SELECT * FROM job_attempts WHERE job_id = ? ORDER BY n', id)
  const warn = (...args) => { try { log?.warn?.(...args) } catch {} }
  const quotaTo = (id, state) => db.run("UPDATE quota_reservations SET state = ? WHERE job_id = ? AND state = 'held'", state, id)

  // 仅供事务内使用。异步路径必须经 fenced；取消/恢复/领取自己持有同步事务。
  function set(id, fields) {
    const keys = Object.keys(fields)
    db.run('UPDATE jobs SET ' + keys.map((k) => k + ' = ?').join(', ') + ', updated_at = ? WHERE id = ?', ...keys.map((k) => fields[k]), now(), id)
  }

  // 重试期间保留预留；确定生成成功或收费就使用；终态下所有尝试均无费用才释放。
  function settleQuota(id, terminal = false, allowEmpty = true) {
    const ats = attemptRows(id)
    if (ats.some((a) => a.billing === 'charged' || a.state === 'done')) quotaTo(id, 'used')
    else if (terminal && (allowEmpty || ats.length > 0) && ats.every((a) => ['none', 'free'].includes(a.billing)) &&
      Number(row(id).attempts) <= ats.length) quotaTo(id, 'released')
  }

  function enqueue({ kind, chatId, requestId = null, actorId, input, parentJobId = null, profileId = null, maxAttempts = 3, epoch }) {
    const h = handlers[kind]
    if (!h) throw new Error('不认识的任务类型：' + kind)
    const id = newId('job')
    const t = now()
    const draft = { id, kind, chatId, actorId: String(actorId), input, parentJobId, profileId }
    return db.tx(() => {
      for (const q of h.quota?.(draft) || []) {
        const used = Number(db.get("SELECT COUNT(*) AS n FROM quota_reservations WHERE scope = ? AND day = ? AND state IN ('held', 'used')", q.scope, dayOf(t)).n)
        if (used >= q.limit) throw Object.assign(new Error(q.message || '今天的额度用完了（' + q.limit + ' 次）'), { code: 'QUOTA' })
        db.run("INSERT INTO quota_reservations(id, job_id, scope, day, state, created_at) VALUES (?, ?, ?, ?, 'held', ?)", newId('qta'), id, q.scope, dayOf(t), t)
      }
      db.run("INSERT INTO jobs(id, kind, chat_id, request_id, actor_id, epoch, state, input_json, parent_job_id, profile_id, max_attempts, trace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)",
        id, kind, chatId, requestId, String(actorId), epoch ?? storage.epochs.current(chatId), toJson(input), parentJobId, profileId, maxAttempts, traceId(), t, t)
      return job(id)
    })
  }

  function owns(x, state = x.state) {
    if (stopped || x.controller.signal.aborted) return false
    const r = row(x.id)
    return Boolean(r && r.lease_owner === x.token && r.lease_until > now() && r.state === state)
  }

  function fenced(x, fn, state = x.state, checkEpoch = false) {
    return db.tx(() => {
      if (!owns(x, state)) throw abortError('任务租约或状态已经改变')
      const r = row(x.id)
      if (checkEpoch && Number(r.epoch) !== storage.epochs.current(r.chat_id)) throw abortError('会话代次已经改变')
      if (fn.constructor?.name === 'AsyncFunction') throw new TypeError('execution.commit 只接受同步函数')
      const result = fn()
      if (result && typeof result.then === 'function') throw new TypeError('execution.commit 只接受同步函数')
      x.state = row(x.id).state
      return result
    })
  }

  function context(x, checkEpoch = false) {
    const state = x.state
    const phase = x.phase = (x.phase || 0) + 1
    const guard = () => {
      if (x.phase !== phase || !owns(x, state)) return false
      const r = row(x.id)
      return !checkEpoch || Number(r.epoch) === storage.epochs.current(r.chat_id)
    }
    return Object.freeze({
      signal: x.controller.signal, workerToken, leaseToken: x.token,
      guard, shouldContinue: guard,
      assertActive: () => { if (!guard()) throw abortError('任务已停止、取消、过期或失去租约') },
      commit: (fn) => {
        if (x.phase !== phase) throw abortError('handler 已经进入下一阶段')
        return fenced(x, fn, state, checkEpoch)
      },
    })
  }

  function abort(x, reason) {
    clearInterval(x.heartbeat)
    if (!x.controller.signal.aborted) x.controller.abort(abortError(reason))
  }

  function release(x) {
    // 即使 stop 后旧 promise 才退出，也不能释放后来领取的租约。
    db.run('UPDATE jobs SET lease_owner = NULL, lease_until = NULL WHERE id = ? AND lease_owner = ?', x.id, x.token)
  }

  function keepAlive(x) {
    x.heartbeat = setInterval(() => {
      try {
        const renewed = db.tx(() => {
          if (!owns(x)) return false
          return db.run('UPDATE jobs SET lease_until = ? WHERE id = ? AND lease_owner = ? AND lease_until > ? AND state = ?',
            now() + leaseMs, x.id, x.token, now(), x.state).changes > 0
        })
        if (!renewed) abort(x, '任务租约已经失效')
      } catch (error) {
        abort(x, '任务租约续期失败')
        warn('任务租约续期失败：', error.message)
      }
    }, Math.max(1, Math.floor(leaseMs / 3)))
    x.heartbeat.unref?.()
  }

  function updateAttempt(id, state, extra = {}) {
    if (!id) return
    const previous = db.get('SELECT * FROM job_attempts WHERE id = ?', id)
    if (previous?.state === 'done' && state !== 'done') return
    const billing = extra.billing === 'unknown' && ['charged', 'free', 'none'].includes(previous?.billing) ? null : extra.billing
    db.run('UPDATE job_attempts SET state = ?, billing = COALESCE(?, billing), provider_task_id = COALESCE(?, provider_task_id), error_kind = ?, error = ?, finished_at = ? WHERE id = ?',
      state, billing ?? null, extra.providerTaskId ?? null, extra.errorKind ?? null, extra.error ?? null, state === 'running' ? null : now(), id)
  }

  function closeOpen(id, state, errorKind, error) {
    db.run("UPDATE job_attempts SET state = ?, error_kind = ?, error = ?, finished_at = ? WHERE job_id = ? AND state = 'running'",
      state, errorKind ?? null, error ?? null, now(), id)
  }

  // 只在租约过期/不完整时恢复。任何可能提交过的记录都不能回到 submit。
  function recoverRow(r) {
    const t = now()
    if (r.lease_owner !== null && r.lease_until !== null && r.lease_until > t) return null
    const clear = { lease_owner: null, lease_until: null }
    if (r.state === 'cancel_requested') {
      if (r.lease_owner !== null || r.lease_until !== null) set(r.id, clear)
      return null
    }
    if (r.state === 'generated') {
      if (r.lease_owner !== null || r.lease_until !== null) set(r.id, clear)
      return r.not_before < PARKED ? 'delivering' : null
    }
    if (r.state === 'delivery_pending') {
      // 可能已经发到远端；自动恢复只允许 generated。发送中断必须人工决定。
      if (r.not_before < PARKED || r.lease_owner !== null || r.lease_until !== null) {
        set(r.id, { ...clear, not_before: PARKED, error: r.error || '发送中断，结果不确定，请确认后人工重发',
          output_json: toJson({ ...fromJson(r.output_json, {}), delivery: { ...fromJson(r.output_json, {}).delivery, unknown: true } }) })
      }
      return null
    }
    const ats = attemptRows(r.id)
    const count = Math.max(Number(r.attempts), ...ats.map((a) => Number(a.n)), 0)
    const latest = ats.at(-1)
    const safe = count === ats.length && ats.every((a) => a.state === 'failed' && a.billing === 'none' && a.finished_at !== null)
    if (['submitting', 'running'].includes(r.state) || !safe) {
      const providerTaskId = latest?.provider_task_id || r.provider_task_id
      if (providerTaskId) {
        set(r.id, { ...clear, state: 'running', provider_task_id: providerTaskId, attempts: count, finished_at: null })
        if (latest && latest.state !== 'done') updateAttempt(latest.id, 'running')
        settleQuota(r.id)
        return 'polling'
      }
      const message = '请求可能已经提交，无法确认服务结果；为避免重复收费不自动重发'
      set(r.id, { ...clear, state: 'unknown', attempts: count, error_kind: 'unknown', error: message, finished_at: t })
      closeOpen(r.id, 'unknown', 'unknown', message)
      settleQuota(r.id, true, false)
      return 'unknown'
    }
    if (r.state === 'preparing') {
      set(r.id, { ...clear, state: 'queued', attempts: count, finished_at: null })
      return 'requeued'
    }
    if (r.lease_owner !== null || r.lease_until !== null || Number(r.attempts) !== count) set(r.id, { ...clear, attempts: count })
    return null
  }

  function recover() {
    const out = { requeued: 0, unknown: 0, polling: 0, delivering: 0 }
    db.tx(() => {
      const rows = db.all('SELECT * FROM jobs WHERE state IN (' + ACTIVE.map(() => '?').join(',') + ') AND ' + AVAILABLE, ...ACTIVE, now())
      for (const r of rows) {
        if (!handlers[r.kind]) continue
        const key = recoverRow(r)
        if (key) out[key]++
      }
    })
    return out
  }

  // 聊天的服务顺序存在已有 sequences 表，跨 worker 共享；没有前 50 行饥饿窗口。
  function claim() {
    if (stopped) return null
    return db.tx(() => {
      const t = now()
      const leased = Number(db.get('SELECT COUNT(*) AS n FROM jobs WHERE lease_owner IS NOT NULL AND lease_until > ? AND state IN (' + ACTIVE.map(() => '?').join(',') + ')', t, ...ACTIVE).n)
      if (leased >= concurrency) return null
      const candidates = db.all("SELECT j.* FROM jobs j LEFT JOIN sequences s ON s.name = 'jobs:chat:' || j.chat_id WHERE j.state IN (" + ACTIVE.map(() => '?').join(',') + ') AND j.not_before <= ? AND ' + AVAILABLE + ' ORDER BY COALESCE(s.value, 0), j.created_at, j.id', ...ACTIVE, t, t)
      for (let r of candidates) {
        if (running.has(r.id) || !handlers[r.kind]) continue
        const sourceState = r.state
        // 正常 running / generated / 已人工安排的 delivery 不需要恢复；中断的提交需要。
        if (['preparing', 'submitting'].includes(r.state) ||
          (r.lease_owner !== null && r.lease_until !== null && r.lease_until <= t)) {
          recoverRow(r)
          r = row(r.id)
          if (!ACTIVE.includes(r.state) || r.not_before > t) continue
        }
        const preparing = ['queued', 'waiting_input', 'retry_wait'].includes(r.state)
        if (preparing) {
          // 旧版本/损坏记录也不能绕过已发生的外部尝试。
          const ats = attemptRows(r.id)
          const count = Math.max(Number(r.attempts), ...ats.map((a) => Number(a.n)), 0)
          if (count !== ats.length || ats.some((a) => a.state !== 'failed' || a.billing !== 'none' || a.finished_at === null)) {
            recoverRow(r)
            continue
          }
          if (Number(r.attempts) !== count) set(r.id, { attempts: count })
          const busy = Number(db.get("SELECT COUNT(*) AS n FROM jobs WHERE chat_id = ? AND id != ? AND (state IN ('preparing', 'submitting', 'running', 'cancel_requested') OR (lease_owner IS NOT NULL AND lease_until > ?))", r.chat_id, r.id, t).n)
          if (busy >= (handlers[r.kind].perChat || 1)) continue
        }
        const token = workerToken + ':' + newId('run')
        set(r.id, { lease_owner: token, lease_until: t + leaseMs, ...(preparing ? { state: 'preparing' } : {}) })
        db.run("INSERT INTO sequences(name, value) VALUES ('jobs:claim', 1) ON CONFLICT(name) DO UPDATE SET value = value + 1")
        db.run("INSERT INTO sequences(name, value) VALUES (?, (SELECT value FROM sequences WHERE name = 'jobs:claim')) ON CONFLICT(name) DO UPDATE SET value = excluded.value", 'jobs:chat:' + r.chat_id)
        return { id: r.id, token, state: preparing ? 'preparing' : r.state, sourceState, controller: new AbortController(), heartbeat: null }
      }
      return null
    })
  }

  async function notify(x, h, event, info) {
    const execution = context(x, true)
    if (!h.notify || !execution.guard()) return
    try { await h.notify(job(x.id), event, info, execution) }
    catch (error) { warn('任务 ' + x.id + ' 通知失败：', error?.message || error) }
  }

  async function fail(x, h, kind, message, state = 'failed') {
    fenced(x, () => {
      set(x.id, { state, error_kind: kind, error: message, finished_at: now() })
      closeOpen(x.id, state === 'unknown' ? 'unknown' : 'failed', kind, message)
      settleQuota(x.id, true, state !== 'unknown')
    })
    await notify(x, h, state, { kind, message })
  }

  async function submit(x, h) {
    const j = job(x.id)
    if (j.attempts >= j.maxAttempts) return fail(x, h, 'invalid', '任务尝试次数已用完')
    const at = fenced(x, () => {
      const a = { id: newId('att'), n: j.attempts + 1 }
      db.run("INSERT INTO job_attempts(id, job_id, n, state, started_at) VALUES (?, ?, ?, 'running', ?)", a.id, j.id, a.n, now())
      set(j.id, { attempts: a.n, state: 'submitting', provider_task_id: null, finished_at: null })
      return a
    })
    const execution = context(x)
    let res
    try {
      execution.assertActive()
      res = await h.submit(job(x.id), at, execution)
    } catch (error) {
      if (!owns(x)) return
      const kind = error?.kind || 'unknown'
      const billing = errorBilling(error)
      const retry = billing === 'none' && ['transient', 'quota'].includes(kind) && error?.retryable !== false && at.n < j.maxAttempts
      fenced(x, () => {
        updateAttempt(at.id, kind === 'unknown' || billing === 'unknown' ? 'unknown' : 'failed', { billing, errorKind: kind, error: String(error?.message || error) })
        if (retry) set(x.id, { state: 'retry_wait', not_before: now() + retryBaseMs * 2 ** (at.n - 1) * (kind === 'quota' ? 4 : 1), error_kind: kind, error: String(error?.message || error) })
        settleQuota(x.id)
      })
      if (retry) return
      return fail(x, h, kind, String(error?.message || error), kind === 'unknown' || billing === 'unknown' ? 'unknown' : 'failed')
    }
    if (!owns(x)) return
    await afterResult(x, h, res, at)
  }

  async function poll(x, h) {
    const j = job(x.id)
    if (!h.poll || !j.providerTaskId) return fail(x, h, 'unknown', '这个任务无法查进度', 'unknown')
    const at = attemptRows(x.id).at(-1)
    let res
    try { res = await h.poll(j, context(x)) }
    catch (error) {
      if (!owns(x)) return
      const tries = (job(x.id).output.pollErrors || 0) + 1
      if (tries > 20) return fail(x, h, 'unknown', '一直查不到进度：' + String(error?.message || error), 'unknown')
      fenced(x, () => set(x.id, { output_json: toJson({ ...job(x.id).output, pollErrors: tries }), not_before: now() + pollMs * 2 }))
      return
    }
    if (!owns(x)) return
    await afterResult(x, h, res, at)
  }

  async function afterResult(x, h, res, at) {
    if (!['running', 'done', 'failed'].includes(res?.status)) return fail(x, h, 'unknown', '服务返回了无法确认的任务状态', 'unknown')
    const providerTaskId = res.providerTaskId || job(x.id).providerTaskId
    const previousBilling = at?.id ? db.get('SELECT billing FROM job_attempts WHERE id = ?', at.id)?.billing : null
    if (res.status === 'running') {
      if (!providerTaskId) return fail(x, h, 'unknown', '服务接受了任务但没有返回任务 ID', 'unknown')
      fenced(x, () => {
        if (at?.state !== 'done') updateAttempt(at?.id, 'running', { providerTaskId, billing: billingOf(res.billing) })
        set(x.id, { state: 'running', provider_task_id: providerTaskId, not_before: now() + pollMs,
          output_json: toJson({ ...job(x.id).output, pollErrors: 0 }), error_kind: null, error: null })
        settleQuota(x.id)
      })
      return
    }
    if (res.status === 'failed') {
      const kind = res.error?.kind || 'invalid'
      const message = res.error?.message || '服务说失败了'
      fenced(x, () => updateAttempt(at?.id, 'failed', { billing: billingOf(res.billing, errorBilling(res.error)), providerTaskId, errorKind: kind, error: message }))
      return fail(x, h, kind, message)
    }
    // 生成已经完成；先记账，不能让 store/deliver 的异常覆盖已知收费事实。
    fenced(x, () => {
      updateAttempt(at?.id, 'done', { billing: billingOf(res.billing, previousBilling && previousBilling !== 'unknown' ? previousBilling : 'charged'), providerTaskId })
      if (providerTaskId) set(x.id, { provider_task_id: providerTaskId })
      quotaTo(x.id, 'used')
    })
    const output = await h.store(job(x.id), res.outputs, context(x))
    if (!owns(x)) return
    fenced(x, () => set(x.id, { state: 'generated', output_json: toJson({ ...job(x.id).output, ...output }), error_kind: null, error: null, not_before: 0 }))
    await deliver(x, h)
  }

  async function finishCanceled(x, h, message) {
    const allowEmpty = x.state !== 'cancel_requested'
    fenced(x, () => {
      set(x.id, { state: 'canceled', finished_at: now(), error: message || null })
      closeOpen(x.id, 'canceled', null, message)
      settleQuota(x.id, true, allowEmpty)
    })
    await notify(x, h, 'canceled', { message })
  }

  async function deliver(x, h) {
    const j = job(x.id)
    if (j.epoch !== storage.epochs.current(j.chatId)) return finishCanceled(x, h, '会话代次已变，未继续发送')
    // 先停住：发送时崩溃、stop 或租约丢失，都不会自动重复发送。
    fenced(x, () => set(x.id, { state: 'delivery_pending', not_before: PARKED }))
    const execution = context(x, true)
    let result
    try {
      execution.assertActive()
      result = await h.deliver(job(x.id), execution)
    } catch (error) {
      if (!owns(x)) return
      result = { delivered: false, unknown: true, error: String(error?.message || error) }
    }
    if (!owns(x)) return
    if (!execution.guard()) return finishCanceled(x, h, '会话代次已变，未继续发送')
    const r = result || { delivered: false, unknown: true, error: '发送没有返回回执' }
    const delivered = Boolean(r.delivered) && !r.skipped && !r.failed && !r.unknown && !r.canceled
    fenced(x, () => {
      const output = job(x.id).output
      const delivery = { ...output.delivery, delivered, failed: Boolean(r.failed), unknown: Boolean(r.unknown), canceled: Boolean(r.canceled), skipped: Boolean(r.skipped) }
      const batchId = r.batchId || output.deliveryBatchId || delivery.batchId
      if (batchId) { delivery.batchId = batchId; output.deliveryBatchId = batchId }
      set(x.id, { state: r.canceled ? 'canceled' : delivered ? 'delivered' : 'delivery_pending',
        output_json: toJson({ ...output, delivery }), finished_at: delivered || r.canceled ? now() : null,
        error_kind: delivered ? null : 'delivery', error: delivered ? null : r.canceled ? '发送已取消' : '发送没成功：' + (r.error || (r.unknown ? '结果不确定，请确认后人工重发' : '看日志')) })
    })
    if (delivered) await notify(x, h, 'delivered', { skipped: Boolean(r.skipped) })
    else if (r.canceled) await notify(x, h, 'canceled', { message: '发送已取消' })
  }

  async function doCancel(x, h) {
    const j = job(x.id)
    let message = ''
    if (j.providerTaskId && h.cancel) {
      try { message = (await h.cancel(j, context(x)))?.message || '' }
      catch (error) {
        if (!owns(x)) return
        message = '服务那边没取消成功：' + String(error?.message || error)
      }
    }
    if (owns(x)) await finishCanceled(x, h, message)
  }

  async function advance(x) {
    const h = handlers[job(x.id).kind]
    try {
      if (!owns(x)) return
      if (x.state === 'cancel_requested') return await doCancel(x, h)
      if (x.state === 'preparing') {
        const p = h.prepare ? await h.prepare(job(x.id), context(x)) : { ready: true }
        if (!owns(x)) return
        if (!p?.ready) {
          const j = job(x.id)
          const until = j.input.waitUntil || p?.untilMs || now() + 60_000
          if (now() >= until) return await fail(x, h, 'invalid', p?.wait || '等不到需要的输入')
          fenced(x, () => set(x.id, { state: 'waiting_input', input_json: toJson({ ...j.input, waitUntil: until }), not_before: now() + 2000, error: p?.wait || '' }))
          if (x.sourceState !== 'waiting_input') await notify(x, h, 'waiting', { reason: p?.wait })
          return
        }
        return await submit(x, h)
      }
      if (x.state === 'running') return await poll(x, h)
      if (x.state === 'generated' || x.state === 'delivery_pending') return await deliver(x, h)
    } catch (error) {
      if (!owns(x)) return
      warn('任务 ' + x.id + ' 出错：', error?.message || error)
      await fail(x, h, error?.kind || 'unknown', String(error?.message || error))
    } finally {
      abort(x, '这次任务推进已经结束')
      release(x)
    }
  }

  function cancel(id, { by, force = false } = {}) {
    const result = db.tx(() => {
      const j = job(id)
      if (!j) return { ok: false, message: '没有这个任务' }
      if (!force && by !== undefined && String(by) !== j.actorId) return { ok: false, message: '只能取消自己的任务' }
      if (FINAL.includes(j.state)) return { ok: false, message: '这个任务已经' + STATE_LABEL[j.state] + '了' }
      if (j.state === 'cancel_requested') return { ok: true, message: '已经在取消了' }
      const immediateCancel = ['queued', 'waiting_input', 'retry_wait', 'preparing', 'generated', 'delivery_pending'].includes(j.state)
      set(id, { state: immediateCancel ? 'canceled' : 'cancel_requested', not_before: 0,
        lease_owner: null, lease_until: null, finished_at: immediateCancel ? now() : null,
        error: immediateCancel ? '按要求取消；不会继续发送' : null })
      if (immediateCancel) {
        closeOpen(id, 'canceled', null, '按要求取消')
        settleQuota(id, true)
      }
      return { ok: true, message: immediateCancel ? '取消了，不会继续发送' : '在取消了：已经提交的可能停不下来，迟到的结果不会发送' }
    })
    if (result.ok) {
      const x = running.get(id)
      if (x && row(id).lease_owner !== x.token) {
        abort(x, '任务已经取消')
        // 不等忽略 AbortSignal 的旧 handler，允许本 worker 马上推进 cancel_requested。
        running.delete(id)
      }
    }
    return result
  }

  function resend(id) {
    const result = db.tx(() => {
      const r = row(id)
      if (!r) return { ok: false, message: '没有这个任务' }
      if (!['delivery_pending', 'generated'].includes(r.state)) return { ok: false, message: '只有画好了还没发出去的任务能重发' }
      if (r.lease_owner !== null && r.lease_until > now()) return { ok: false, message: '这个任务正在发送中' }
      set(id, { not_before: 0, error: null, lease_owner: null, lease_until: null })
      return { ok: true, message: '在重发了' }
    })
    if (result.ok) kick()
    return result
  }

  async function tick() {
    if (stopped) return 0
    const started = []
    while (!stopped && running.size < concurrency) {
      const x = claim()
      if (!x) break
      running.set(x.id, x)
      keepAlive(x)
      x.promise = advance(x).finally(() => { if (running.get(x.id) === x) running.delete(x.id) })
      started.push(x.promise)
    }
    await Promise.all(started)
    return started.length
  }

  async function drain(max = 50) {
    for (let i = 0; i < max; i++) if (!(await tick())) return
  }

  function kick() {
    if (stopped || immediate) return
    immediate = setImmediate(() => {
      immediate = null
      if (!stopped) tick().catch((error) => warn('任务推进出错：', error.message))
    })
  }

  function start(intervalMs = 1500) {
    if (timer) return
    stopped = false
    timer = setInterval(() => tick().catch((error) => warn('任务推进出错：', error.message)), intervalMs)
    timer.unref?.()
  }

  function stop() {
    stopped = true
    clearInterval(timer)
    clearImmediate(immediate)
    timer = null
    immediate = null
    for (const x of running.values()) {
      abort(x, '任务 worker 已停止')
      release(x)
    }
    running.clear()
  }

  const list = ({ chatId, actorId, states, limit = 30 } = {}) => {
    const where = []
    const args = []
    if (chatId) { where.push('chat_id = ?'); args.push(chatId) }
    if (actorId) { where.push('actor_id = ?'); args.push(String(actorId)) }
    if (states?.length) { where.push('state IN (' + states.map(() => '?').join(',') + ')'); args.push(...states) }
    return db.all('SELECT * FROM jobs ' + (where.length ? 'WHERE ' + where.join(' AND ') : '') + ' ORDER BY created_at DESC, id DESC LIMIT ?', ...args, limit).map(view)
  }
  const attempts = (id) => attemptRows(id).map((r) => ({ id: r.id, n: Number(r.n), providerTaskId: r.provider_task_id, billing: r.billing, state: r.state, errorKind: r.error_kind, error: r.error, startedAt: r.started_at, finishedAt: r.finished_at }))

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

// 持久等待和有界唤醒投递。使用既有 meta 表；不创建第二个计时/任务数据库。
import { randomUUID } from 'node:crypto'
import { newId } from '../core/ids.js'

const PREFIX = 'planner:wait:'
const LIVE = new Set(['waiting', 'ready', 'dispatching'])
const inactive = (message) => Object.assign(new Error(message), { name: 'AbortError' })

/**
 * validate/inspect/matches 都是同步可信回调。inspect → { ready, reason, observations }。
 * onWake(event, execution) 必须返回 true / {accepted:true} 才确认已接收。
 * {accepted:false,retryable:true} 明确未接收才有限重试；抛错、超时、崩溃均 unknown，
 * 不自动重复叫醒模型。事件 id 稳定，下游仍须据此去重。
 */
export function createWaitQueue({
  storage, now = () => Date.now(), validate, inspect, matches = () => false, onWake,
  leaseMs = 30_000, wakeTimeoutMs = 30_000, maxPerTick = 8, maxAttempts = 3,
  retryMs = 1000, maxWakeAgeMs = 300_000, log,
}) {
  for (const [name, value] of Object.entries({ leaseMs, wakeTimeoutMs, maxPerTick, maxAttempts, retryMs, maxWakeAgeMs })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(name + ' 必须是正整数')
  }
  const db = storage.db
  const running = new Map()
  let disposed = false
  let receiver = onWake
  const warn = (...args) => { try { log?.warn?.(...args) } catch {} }
  const read = (id) => {
    const value = db.get('SELECT value FROM meta WHERE key = ?', PREFIX + id)?.value
    if (!value) return null
    const r = JSON.parse(value)
    if (r.id !== id || r.version !== 1 || !r.context || !r.wakeId) throw new Error('等待记录损坏：' + id)
    return r
  }
  const all = () => db.all('SELECT key FROM meta WHERE key GLOB ?', PREFIX + '*').map((r) => read(r.key.slice(PREFIX.length)))
  const save = (r) => {
    r.updatedAt = now()
    db.run('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', PREFIX + r.id, JSON.stringify(r))
    return r
  }
  const valid = (r) => {
    const result = validate(r)
    if (result && typeof result.then === 'function') throw new TypeError('等待校验必须同步')
    return result === true || result?.valid === true
  }
  function terminal(r, state, error) {
    return save({ ...r, state, error: error || null, leaseToken: null, leaseUntil: null, finishedAt: now() })
  }
  function ready(r, reason, observations = []) {
    return save({ ...r, state: 'ready', reason, observations, readyAt: now(), notBefore: now() })
  }
  function refreshRecord(r, event) {
    if (!LIVE.has(r.state)) return r
    if (!valid(r)) return terminal(r, 'canceled', '请求、归属、权限或会话已失效')
    if (r.state === 'dispatching') {
      if (!r.leaseToken || r.leaseUntil <= now()) return terminal(r, 'unknown', '唤醒投递中断，是否已进入模型不确定；不自动重发')
      return r
    }
    if (r.state === 'ready') {
      if (now() - r.readyAt > maxWakeAgeMs) return terminal(r, 'expired', '唤醒事件积压过久')
      return r
    }
    if (now() >= r.deadline) {
      if (now() - r.deadline > maxWakeAgeMs) return terminal(r, 'expired', '等待期限已过去太久')
      return ready(r, 'deadline')
    }
    const result = inspect(r)
    if (result && typeof result.then === 'function') throw new TypeError('等待条件检查必须同步')
    if (result?.ready) return ready(r, result.reason || r.condition, result.observations || [])
    if (event && matches(r, event)) return ready(r, event.type)
    return r
  }

  function schedule(input) {
    if (disposed) throw inactive('等待服务已停止')
    return db.tx(() => {
      const r = { ...input, id: newId('wai'), wakeId: newId('wak'), version: 1,
        state: 'waiting', attempts: 0, createdAt: now(), updatedAt: now(),
        leaseToken: null, leaseUntil: null, notBefore: 0, finishedAt: null }
      if (!Number.isSafeInteger(r.deadline) || r.deadline <= now()) throw new RangeError('等待期限必须在将来')
      if (!valid(r)) throw inactive('等待请求已失效')
      save(r)
      return read(r.id)
    })
  }
  function refresh(event) {
    if (disposed) return []
    return db.tx(() => all().filter((r) => LIVE.has(r.state)).map((r) => refreshRecord(r, event)))
  }
  function cancel(id, reason = '已取消等待') {
    const changed = db.tx(() => {
      const r = read(id)
      if (!r || (!LIVE.has(r.state) && r.state !== 'unknown')) return false
      terminal(r, 'canceled', reason)
      return true
    })
    if (changed) running.get(id)?.controller.abort(inactive(reason))
    return changed
  }
  const owns = (x) => {
    const r = read(x.id)
    return r?.state === 'dispatching' && r.leaseToken === x.token && r.leaseUntil > now()
  }
  function execution(x) {
    const guard = () => !disposed && !x.controller.signal.aborted && owns(x) && valid(read(x.id))
    return Object.freeze({
      signal: x.controller.signal, guard, shouldContinue: guard,
      assertActive: () => { if (!guard()) throw inactive('唤醒已取消或失去租约') },
      commit: (fn) => db.tx(() => {
        if (!guard()) throw inactive('唤醒已取消或失去租约')
        if (fn.constructor?.name === 'AsyncFunction') throw new TypeError('commit 必须同步')
        const result = fn()
        if (result && typeof result.then === 'function') throw new TypeError('commit 必须同步')
        return result
      }),
    })
  }
  function claim(id) {
    return db.tx(() => {
      let r = read(id)
      if (!r || r.state !== 'ready' || r.notBefore > now()) return null
      r = refreshRecord(r)
      if (r.state !== 'ready') return null
      const active = all().filter((other) => other.state === 'dispatching' && other.leaseUntil > now())
      if (active.length >= maxPerTick || active.some((other) => other.context.account === r.context.account && other.context.chatId === r.context.chatId)) return null
      const token = randomUUID()
      save({ ...r, state: 'dispatching', leaseToken: token, leaseUntil: now() + leaseMs, attempts: r.attempts + 1 })
      return { id, token, controller: new AbortController() }
    })
  }
  async function dispatch(x) {
    const r = read(x.id)
    const ex = execution(x)
    const event = Object.freeze({
      id: r.wakeId, type: 'planner_wake', waitId: r.id, reason: r.reason,
      context: { ...r.context, wakeId: r.wakeId, turnId: r.wakeId },
      jobIds: [...(r.jobIds || [])], requestId: r.targetRequestId,
      observations: r.observations || [], deadline: r.deadline,
    })
    let timeout, renew, onAbort
    try {
      const aborted = new Promise((resolve) => {
        onAbort = () => resolve({ accepted: false, unknown: true, error: x.controller.signal.reason?.message || '唤醒中止' })
        x.controller.signal.addEventListener('abort', onAbort, { once: true })
      })
      renew = setInterval(() => {
        try {
          db.tx(() => {
            if (!ex.guard()) { x.controller.abort(inactive('唤醒权限或租约失效')); return }
            save({ ...read(x.id), leaseUntil: now() + leaseMs })
          })
        } catch (error) {
          warn('等待唤醒续租失败：', error.message)
          x.controller.abort(inactive('唤醒续租失败'))
        }
      }, Math.max(1, Math.floor(leaseMs / 3)))
      renew.unref?.()
      timeout = setTimeout(() => x.controller.abort(inactive('唤醒接收超时')), wakeTimeoutMs)
      const delivered = Promise.resolve().then(() => {
        ex.assertActive()
        return receiver(event, ex)
      }).then((answer) => answer, (error) => ({ accepted: false, unknown: true, error: String(error?.message || error).slice(0, 300) }))
      const result = await Promise.race([delivered, aborted])
      if (disposed) return
      db.tx(() => {
        if (disposed || !owns(x)) return
        const current = read(x.id)
        if (!valid(current)) { terminal(current, 'canceled', '请求或权限已失效'); return }
        if (result === true || result?.accepted === true) terminal(current, 'woken')
        else if (result?.accepted === false && result.retryable === true && !result.unknown) {
          if (current.attempts >= maxAttempts) terminal(current, 'failed', '唤醒接收重试已用完')
          else save({ ...current, state: 'ready', leaseToken: null, leaseUntil: null,
            notBefore: now() + retryMs * 2 ** (current.attempts - 1), error: '接收器明确未接收，稍后重试' })
        } else terminal(current, 'unknown', result?.error || '接收器未确认是否接收；不自动重发')
      })
    } finally {
      clearTimeout(timeout)
      clearInterval(renew)
      x.controller.signal.removeEventListener('abort', onAbort)
      x.controller.abort(inactive('本次唤醒投递已结束'))
      if (running.get(x.id) === x) running.delete(x.id)
    }
  }
  async function tick() {
    if (disposed) return 0
    refresh()
    if (typeof receiver !== 'function') return 0
    const chats = new Set()
    const started = []
    const candidates = all().filter((r) => r.state === 'ready' && r.notBefore <= now())
      .sort((a, b) => a.notBefore - b.notBefore || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    for (const r of candidates) {
      const chatKey = JSON.stringify([r.context.account, r.context.chatId])
      if (started.length >= maxPerTick || running.size >= maxPerTick || disposed) break
      if (running.has(r.id) || chats.has(chatKey)) continue
      const x = claim(r.id)
      if (!x) continue
      chats.add(chatKey)
      running.set(r.id, x)
      started.push(dispatch(x))
    }
    await Promise.all(started)
    return started.length
  }
  function dispose() {
    disposed = true
    for (const x of running.values()) {
      db.tx(() => { if (owns(x)) terminal(read(x.id), 'unknown', '服务停止时唤醒可能已接收；不自动重发') })
      x.controller.abort(inactive('等待服务已停止'))
    }
  }
  return {
    schedule, get: read, list: all, cancel, tick, recover: () => refresh(),
    signal: (event) => refresh(event), dispose,
    setOnWake: (fn) => { if (fn !== undefined && typeof fn !== 'function') throw new TypeError('onWake 必须是函数'); receiver = fn },
  }
}

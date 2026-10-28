// Planner 的持久控制面：决策/工具预算、wait/stop、请求归属和通用任务控制。
// 不运行额外的 LLM 自循环。宿主每次决策调用 decision，每次工具调用 useTool/runTool。
import { createHash } from 'node:crypto'
import { newId } from '../core/ids.js'
import { checkAllowed, isOwner, levelFor } from '../chat/access.js'
import { STATE_LABEL } from '../jobs/runner.js'
import { createWaitQueue } from './waits.js'

const ACTIONS = new Set(['reply', 'ask_clarification', 'wait', 'stop', 'search', 'recall', 'submit_job'])
const JOB_DONE = new Set(['delivered', 'failed', 'canceled', 'unknown'])
const REQUEST_CANCELED = new Set(['canceled', 'cancel_requested', 'closed', 'expired'])
const WAIT_LIVE = new Set(['waiting', 'ready', 'dispatching'])
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
const bounded = (value, max = 300) => String(value || '').slice(0, max)
const hash = (parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')

/**
 * context 只能由接收层构造，不能使用模型参数：
 * {account,chatId,actorId,requestId,epoch,policyRevision,turnId,wakeId?,signal?,assertActive?}
 * turnId 是当前批次首个 requestId，steer 追加请求沿用；持久唤醒使用 event.context。
 *
 * getRunner(kind) 动态取得对应模块 runner（不限 image）。
 * onWake(event, execution) → {accepted:true}：宿主以 event.id 去重后接收调度事件；
 * 不确定是否入队时抛错，保留 unknown；只有明确未入队才能返回
 * {accepted:false,retryable:true}。可先创建服务，再 setOnWake(fn) 接线。
 *
 * panelList/panelCancel 是独立的可信宿主管理入口，调用者须先验证面板身份。
 * 模型工具永远不能调用该入口，也不能通过 authority/force 参数切换身份。
 */
export function createPlanner({
  storage, getConfig, getRunner = () => null, onWake, now = () => Date.now(), log,
  maxRounds = 4, maxTools = 6, maxSearches = 2, maxAutoWakes = 8,
  maxWaitMs = 86_400_000, minWaitMs = 1000, maxPendingPerRequest = 8, ...queueOptions
}) {
  for (const [name, n] of Object.entries({ maxRounds, maxTools, maxSearches, maxAutoWakes, maxWaitMs, minWaitMs, maxPendingPerRequest })) {
    if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(name + ' 必须是正整数')
  }
  if (maxWaitMs < minWaitMs) throw new RangeError('maxWaitMs 小于 minWaitMs')
  const db = storage.db
  let disposed = false
  const get = (key) => {
    const r = db.get('SELECT value FROM meta WHERE key = ?', key)
    return r ? JSON.parse(r.value) : null
  }
  const put = (key, value) => db.run('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value))
  const rawJob = (id) => db.get('SELECT * FROM jobs WHERE id = ?', String(id || ''))

  // 来源消息是不可变的账号/作者证据；不依赖可能被另一账号覆盖的 chats.account_id。
  function requestScope(id) {
    const r = storage.requests.get(String(id || ''))
    if (!r || !r.sourceMessageIds?.length) fail('CONTEXT_REQUIRED', '请求缺少可信来源消息')
    const messages = r.sourceMessageIds.map((mid) => storage.messages.get(mid))
    const account = messages[0]?.account
    if (!account || messages.some((m) => !m || m.account !== account || m.chatId !== r.chatId || String(m.authorId) !== String(r.actorId))) {
      fail('SCOPE_MISMATCH', '请求来源与账号、聊天或请求者不一致')
    }
    return { ...r, account: String(account) }
  }
  function authorize(raw) {
    if (disposed) fail('STOPPED', 'Planner 已停止')
    if (!raw || raw.signal?.aborted) fail('CANCELED', '当前调用已取消')
    raw.assertActive?.()
    const r = requestScope(raw.requestId)
    const cfg = getConfig()
    if (!cfg.botQQ || r.account !== String(cfg.botQQ) || String(raw.account || '') !== r.account ||
      raw.chatId !== r.chatId || String(raw.actorId || '') !== String(r.actorId)) fail('SCOPE_MISMATCH', '请求不属于当前账号、聊天或请求者')
    if (REQUEST_CANCELED.has(r.state)) fail('CANCELED', '请求已取消或结束')
    if (Number(raw.epoch) !== r.epoch || r.epoch !== storage.epochs.current(r.chatId)) fail('STALE_CONTEXT', '会话代次已改变')
    if (Number(raw.policyRevision) !== r.policyRevision ||
      (Number.isSafeInteger(cfg.policyRevision) && cfg.policyRevision !== r.policyRevision)) fail('STALE_POLICY', '请求权限版本已失效')
    const [kind, id] = r.chatId.split(':')
    const chat = { kind, chatId: r.chatId, userId: kind === 'private' ? id : undefined, groupId: kind === 'group' ? id : undefined }
    if (!['group', 'private'].includes(kind) || (kind === 'private' && String(r.actorId) !== id) || cfg.enabled === false || !checkAllowed(cfg, { ...chat, userId: String(r.actorId) }).allowed ||
      levelFor(cfg, chat) === 'chat') fail('FORBIDDEN', '当前聊天不允许使用任务工具')
    return {
      account: r.account, chatId: r.chatId, actorId: String(r.actorId), requestId: r.id,
      sourceMessageIds: [...r.sourceMessageIds], epoch: r.epoch, policyRevision: r.policyRevision, traceId: r.traceId,
      turnId: String(raw.turnId || raw.wakeId || r.id), ...(raw.wakeId ? { wakeId: String(raw.wakeId) } : {}),
    }
  }
  function taskVisible(ctx, r) {
    if (!r || r.chat_id !== ctx.chatId) return false
    let account
    if (r.request_id) {
      try {
        const request = requestScope(r.request_id)
        if (request.chatId !== r.chat_id || String(request.actorId) !== String(r.actor_id)) return false
        account = request.account
      } catch (error) {
        if (['CONTEXT_REQUIRED', 'SCOPE_MISMATCH'].includes(error.code)) return false
        throw error
      }
    } else {
      // 面板/旧任务必须有可信创建时冻结的账号；缺失时不猜测属于当前账号。
      account = JSON.parse(r.input_json || '{}').accountId
    }
    return String(account || '') === ctx.account && (String(r.actor_id) === ctx.actorId || isOwner(getConfig(), ctx.actorId))
  }
  const waitVisible = (ctx, r) => r?.context.account === ctx.account && r.context.chatId === ctx.chatId &&
    (r.context.actorId === ctx.actorId || isOwner(getConfig(), ctx.actorId))
  const turnKey = (ctx) => 'planner:turn:' + hash([ctx.account, ctx.chatId, ctx.epoch, ctx.wakeId || ctx.turnId])
  function turn(ctx) {
    const key = turnKey(ctx)
    let r = get(key)
    if (!r) {
      r = { version: 1, id: ctx.wakeId || newId('wak'), account: ctx.account, chatId: ctx.chatId,
        epoch: ctx.epoch, state: 'active', rounds: 0, tools: 0, searches: 0, actions: [], createdAt: now(), updatedAt: now() }
      put(key, r)
    }
    if (r.version !== 1 || r.account !== ctx.account || r.chatId !== ctx.chatId || r.epoch !== ctx.epoch) fail('CORRUPT_STATE', 'Planner 回合记录损坏')
    return { key, r }
  }
  function admit(ctx, { action, tool, search = false } = {}) {
    const { key, r } = turn(ctx)
    if (r.state !== 'active') return { ok: false, code: r.state === 'exhausted' ? 'BUDGET_EXHAUSTED' : 'PLANNER_STOPPED', message: '本次决策已经结束', wakeId: r.id }
    if ((action && r.rounds >= maxRounds) || (tool && r.tools >= maxTools) || (search && r.searches >= maxSearches)) {
      put(key, { ...r, state: 'exhausted', updatedAt: now(), finishedAt: now() })
      return { ok: false, code: 'BUDGET_EXHAUSTED', message: '本次唤醒预算已用完；使用已有结果或结束，不能自动再次唤醒', wakeId: r.id }
    }
    if (action) r.rounds++
    if (tool) r.tools++
    if (search) r.searches++
    r.actions.push({ action: action || 'tool', ...(tool ? { tool: bounded(tool, 80) } : {}), requestId: ctx.requestId, at: now() })
    r.updatedAt = now()
    put(key, r)
    return { ok: true, wakeId: r.id, budgets: { rounds: r.rounds, tools: r.tools, searches: r.searches } }
  }
  const contextSnapshot = (ctx) => ({ ...ctx, sourceMessageIds: [...ctx.sourceMessageIds] })
  function validateWait(r) {
    try {
      const ctx = authorize(r.context)
      const target = requestScope(r.targetRequestId)
      if (target.account !== ctx.account || target.chatId !== ctx.chatId ||
        (String(target.actorId) !== ctx.actorId && !isOwner(getConfig(), ctx.actorId))) return false
      return (r.jobIds || []).every((id) => taskVisible(ctx, rawJob(id)))
    } catch (error) {
      if (['CONTEXT_REQUIRED', 'SCOPE_MISMATCH', 'CANCELED', 'STALE_CONTEXT', 'STALE_POLICY', 'FORBIDDEN', 'STOPPED'].includes(error.code)) return false
      throw error
    }
  }
  const signature = (r) => JSON.stringify([r.state, r.updatedAt, r.sourceMessageIds])
  const requestEventKey = (account, id) => 'planner:request-event:' + hash([account, id])
  function inspectWait(r) {
    if (r.condition === 'job') {
      const observations = r.jobIds.map((id) => { const j = rawJob(id); return { jobId: id, state: j.state, errorKind: j.error_kind } })
      const isReady = (j) => JOB_DONE.has(j.state) || (r.resultReady && ['generated', 'delivery_pending'].includes(j.state))
      return { ready: r.mode === 'any' ? observations.some(isReady) : observations.every(isReady), reason: 'job', observations }
    }
    if (r.condition === 'request') {
      const target = requestScope(r.targetRequestId)
      const event = get(requestEventKey(target.account, target.id))
      return { ready: signature(target) !== r.baseline || (event?.recvSeq > r.afterSeq), reason: 'request',
        observations: [{ requestId: target.id, state: target.state, ...(event?.recvSeq > r.afterSeq ? { messageId: event.messageId } : {}) }] }
    }
    if (r.condition === 'media') {
      const observations = r.occurrenceIds.map((id) => { const o = storage.occurrences.get(id); return { occurrenceId: id, state: o?.state || 'unavailable' } })
      return { ready: observations.every((o) => o.state !== 'pending'), reason: 'media', observations }
    }
    return { ready: false }
  }
  const queue = createWaitQueue({
    ...queueOptions, storage, now, log, onWake, validate: validateWait, inspect: inspectWait,
  })

  // request 补充用接收层登记的 messageId 作为持久证据/去重序号，不能凭空重放一个 scope 唤醒。
  function signal(event) {
    if (disposed) return []
    return db.tx(() => {
      if (event?.type === 'request' && typeof event.messageId === 'string' && storage.requests.get(String(event.requestId || ''))) {
        const target = requestScope(event.requestId)
        const message = storage.messages.get(event.messageId)
        if (message && message.account === target.account && message.chatId === target.chatId && String(message.authorId) === String(target.actorId) &&
          event.account === target.account && event.chatId === target.chatId && String(event.actorId || '') === String(target.actorId)) {
          const key = requestEventKey(target.account, target.id)
          if (message.recvSeq > (get(key)?.recvSeq || 0)) put(key, { messageId: message.id, recvSeq: message.recvSeq })
        }
      }
      return queue.signal(event)
    })
  }

  function begin(raw) {
    return db.tx(() => {
      const ctx = authorize(raw)
      const exists = Boolean(get(turnKey(ctx)))
      const { r } = turn(ctx)
      return { ok: true, created: !exists, wakeId: r.id, state: r.state, context: ctx }
    })
  }
  // 宿主在真正调用模型前预留一轮；同一 wake 不能并发调用两个 Planner。
  function beginDecision(raw) {
    return db.tx(() => {
      const ctx = authorize(raw)
      const { r } = turn(ctx)
      if (r.pendingDecision) return { ok: false, code: 'DECISION_IN_FLIGHT', message: '当前唤醒已有模型决策在进行' }
      const result = admit(ctx, { action: 'decision' })
      if (!result.ok) return result
      const current = turn(ctx)
      const decisionId = newId('dec')
      put(current.key, { ...current.r, pendingDecision: decisionId })
      return { ...result, decisionId }
    })
  }
  function finishDecision(raw, decisionId, action) {
    if (!ACTIONS.has(action) || action === 'wait' || action === 'stop') fail('INVALID_ACTION', 'wait/stop 必须调用对应控制方法')
    return db.tx(() => {
      const ctx = authorize(raw)
      const { key, r } = turn(ctx)
      if (r.state !== 'active' || r.pendingDecision !== decisionId) return { ok: false, code: 'STALE_DECISION', message: '这轮决策已经结束或被控制工具接管' }
      r.actions.push({ action, requestId: ctx.requestId, decisionId, at: now() })
      put(key, { ...r, pendingDecision: null, updatedAt: now() })
      return { ok: true, wakeId: r.id }
    })
  }
  function decision(raw, action) {
    if (!ACTIONS.has(action)) fail('INVALID_ACTION', '不认识的 Planner 动作')
    if (action === 'wait') fail('WAIT_REQUIRED', 'wait 必须用 wait(context, spec) 登记依赖和期限')
    if (action === 'stop') return stop(raw)
    return db.tx(() => admit(authorize(raw), { action }))
  }
  function useTool(raw, { name, search = false } = {}) {
    if (!name || typeof name !== 'string') fail('INVALID_TOOL', '工具需要名字')
    const result = db.tx(() => admit(authorize(raw), { tool: name, search }))
    if (!result.ok) return result
    const guard = () => {
      try { const ctx = authorize(raw); return get(turnKey(ctx))?.state === 'active' } catch { return false }
    }
    return { ...result, execution: {
      signal: raw.signal, guard, shouldContinue: guard,
      assertActive: () => { if (!guard()) fail('PLANNER_STOPPED', '当前决策已停止或权限失效') },
      commit: (fn) => db.tx(() => {
        if (!guard()) fail('PLANNER_STOPPED', '当前决策已停止或权限失效')
        if (fn.constructor?.name === 'AsyncFunction') fail('ASYNC_COMMIT', 'commit 必须同步')
        const value = fn()
        if (value && typeof value.then === 'function') fail('ASYNC_COMMIT', 'commit 必须同步')
        return value
      }),
    } }
  }
  async function runTool(raw, options, execute) {
    const ticket = useTool(raw, options)
    if (!ticket.ok) return ticket
    ticket.execution.assertActive()
    const result = await execute(ticket.execution)
    ticket.execution.assertActive()
    return result
  }
  function stop(raw, reason = '本次决策结束') {
    return db.tx(() => {
      const ctx = authorize(raw)
      const { key, r } = turn(ctx)
      if (r.state === 'active') {
        r.actions.push({ action: 'stop', requestId: ctx.requestId, at: now() })
        put(key, { ...r, state: 'stopped', pendingDecision: null, reason: bounded(reason), updatedAt: now(), finishedAt: now() })
      }
      return { ok: true, wakeId: r.id, state: r.state === 'active' ? 'stopped' : r.state,
        message: '当前决策已结束，后台任务和已登记等待不受取消' }
    })
  }
  function wait(raw, spec = {}) {
    return db.tx(() => {
      const ctx = authorize(raw)
      const condition = spec.condition
      if (!['job', 'request', 'media', 'time'].includes(condition)) fail('INVALID_WAIT', '必须明确等待 job/request/media/time')
      const deadline = spec.deadline ?? now() + (spec.timeoutMs ?? Math.max(minWaitMs, Math.min(60_000, maxWaitMs)))
      if (!Number.isSafeInteger(deadline) || deadline - now() < minWaitMs || deadline - now() > maxWaitMs) fail('INVALID_DEADLINE', '等待时间必须在 ' + minWaitMs + '–' + maxWaitMs + ' 毫秒之间')
      const target = requestScope(spec.requestId || ctx.requestId)
      const jobIds = [...new Set(spec.jobIds || [])]
      if (!Array.isArray(spec.jobIds || []) || jobIds.some((id) => typeof id !== 'string') || jobIds.length > 8 ||
        (condition === 'job' ? !jobIds.length : jobIds.length > 0)) fail('INVALID_WAIT', 'job 等待需要 1–8 个任务 ID，其他条件不接收 jobIds')
      const record = { context: contextSnapshot(ctx), condition, deadline, targetRequestId: target.id,
        jobIds, mode: spec.mode || 'all', resultReady: spec.resultReady === true, baseline: signature(target) }
      record.afterSeq = Number(db.get('SELECT COALESCE(MAX(recv_seq), 0) AS seq FROM messages WHERE account_id = ? AND chat_id = ? AND author_id = ?', target.account, target.chatId, String(target.actorId)).seq)
      if (!['all', 'any'].includes(record.mode) || !validateWait(record)) fail('FORBIDDEN', '不能等待不可见的请求或任务')
      if (condition === 'media') {
        record.occurrenceIds = target.sourceMessageIds.flatMap((id) => storage.occurrences.ofMessage(id).map((o) => o.id))
        if (!record.occurrenceIds.length) fail('INVALID_WAIT', '该请求没有需要等待的媒体')
      }
      if (queue.list().filter((r) => WAIT_LIVE.has(r.state) && r.context.account === ctx.account && r.context.requestId === ctx.requestId).length >= maxPendingPerRequest) fail('WAIT_LIMIT', '该请求等待数量已达上限')
      const chainKey = 'planner:chain:' + hash([ctx.account, ctx.requestId])
      const count = get(chainKey)?.count || 0
      if (count >= maxAutoWakes) {
        const { key, r } = turn(ctx)
        put(key, { ...r, state: 'exhausted', updatedAt: now(), finishedAt: now() })
        return { ok: false, code: 'WAKE_LIMIT', message: '该请求的自动唤醒次数已用完，需要新的用户请求' }
      }
      const current = turn(ctx)
      const result = current.r.state === 'active' && current.r.pendingDecision
        ? { ok: true, wakeId: current.r.id } : admit(ctx, { action: 'wait' })
      if (!result.ok) return result
      const saved = queue.schedule(record)
      const { key, r } = turn(ctx)
      if (r.pendingDecision) r.actions.push({ action: 'wait', requestId: ctx.requestId, decisionId: r.pendingDecision, at: now() })
      put(key, { ...r, state: 'waiting', pendingDecision: null, waitId: saved.id, updatedAt: now(), finishedAt: now() })
      put(chainKey, { count: count + 1 })
      return { ok: true, waitId: saved.id, wakeId: result.wakeId, state: 'waiting', deadline, message: '已登记等待；当前决策结束，到条件满足或期限时再唤醒' }
    })
  }

  const jobView = (r) => ({
    id: r.id, type: 'job', kind: r.kind, requestId: r.request_id, actorId: r.actor_id,
    state: r.state, stateLabel: STATE_LABEL[r.state] || r.state, attempts: Number(r.attempts),
    error: bounded(r.error), createdAt: r.created_at, updatedAt: r.updated_at, finishedAt: r.finished_at,
  })
  const waitView = (r) => ({
    id: r.id, type: 'wait', kind: 'wait', requestId: r.context.requestId, actorId: r.context.actorId,
    state: r.state, condition: r.condition, deadline: r.deadline, jobIds: r.jobIds,
    error: bounded(r.error), createdAt: r.createdAt, updatedAt: r.updatedAt, finishedAt: r.finishedAt,
  })
  function listWithContext(ctx, { id, limit = 10, kind } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) fail('INVALID_LIMIT', 'limit 必须在 1–50 之间')
    if (id) {
      const w = queue.get(String(id))
      if (w && waitVisible(ctx, w)) return [waitView(w)]
      const j = rawJob(id)
      if (taskVisible(ctx, j)) return [jobView(j)]
      fail('NOT_FOUND', '没有可查看的任务')
    }
    const jobs = db.all('SELECT * FROM jobs WHERE chat_id = ? ORDER BY created_at DESC, id DESC', ctx.chatId).filter((r) => taskVisible(ctx, r)).map(jobView)
    const waits = queue.list().filter((r) => waitVisible(ctx, r)).map(waitView)
    return [...jobs, ...waits].filter((r) => !kind || r.kind === kind).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)).slice(0, limit)
  }
  function cancelWithContext(ctx, id) {
    const w = queue.get(String(id))
    if (w && waitVisible(ctx, w)) {
      const canceled = queue.cancel(w.id)
      return { ok: canceled, message: canceled ? '等待已取消；后台任务不受影响' : '等待已结束，无法再取消' }
    }
    const j = rawJob(id)
    if (!taskVisible(ctx, j)) fail('NOT_FOUND', '没有可取消的任务')
    const runner = getRunner(j.kind)
    if (!runner || typeof runner.cancel !== 'function') fail('RUNNER_UNAVAILABLE', '任务所属模块当前不可用，未修改任务：' + j.kind)
    return runner.cancel(j.id, { by: ctx.actorId, force: isOwner(getConfig(), ctx.actorId) })
  }
  const listTasks = (raw, options) => db.tx(() => listWithContext(authorize(raw), options))
  const cancelTask = (raw, id) => db.tx(() => cancelWithContext(authorize(raw), id))
  function panelContext(chatId) {
    const cfg = getConfig()
    if (disposed || !cfg.botQQ || !cfg.ownerQQ || !/^(group|private):\d+$/.test(String(chatId || ''))) fail('CONTEXT_REQUIRED', '管理入口需要当前账号、主人和明确聊天')
    return { account: String(cfg.botQQ), chatId, actorId: String(cfg.ownerQQ) }
  }
  return {
    begin, authorize, beginDecision, finishDecision, decision, useTool, runTool, stop, wait, listTasks, cancelTask,
    panelList: ({ chatId, ...options }) => db.tx(() => listWithContext(panelContext(chatId), options)),
    panelCancel: ({ chatId, id }) => db.tx(() => cancelWithContext(panelContext(chatId), id)),
    state: (raw) => db.tx(() => { const ctx = authorize(raw); return get(turnKey(ctx)) }),
    getWait: (raw, id) => { const ctx = authorize(raw); const r = queue.get(id); if (!waitVisible(ctx, r)) fail('NOT_FOUND', '没有可查看的等待'); return r },
    shouldContinue: (raw) => { try { return get(turnKey(authorize(raw)))?.state === 'active' } catch { return false } },
    tick: queue.tick, recover: queue.recover, signal, setOnWake: queue.setOnWake,
    dispose: () => { queue.dispose(); disposed = true },
  }
}

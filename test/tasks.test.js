import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import tasksModule from '../src/modules/tasks/index.js'
import { createStorage } from '../src/storage/index.js'
import { createJobRunner } from '../src/jobs/runner.js'

function setup(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-tasks-'))
  const storage = createStorage({ file: ':memory:', filesDir: join(dir, 'assets') })
  const cfg = { botQQ: '9000', ownerQQ: '7', enabled: true, allow: { groups: ['1', '2'], private: ['8'] } }
  const request = ({ actor = '8', chatId = 'group:1', account = cfg.botQQ } = {}) => {
    const msg = storage.messages.ingest({ account, chatId, authorId: actor, eventKind: 'message', text: 'fixture' })
    return storage.requests.create({ chatId, actorId: actor, sourceMessageIds: [msg.id] })
  }
  const initial = request()
  let currentRequests = [initial]
  let actor = { actorId: initial.actorId, requestId: initial.id }
  let chatId = initial.chatId
  let wakeId
  const hub = {
    turnActor: () => actor, turnRequests: () => currentRequests, chatOfSession: () => chatId,
    turnWakeId: () => wakeId,
  }
  const h = { submit: async () => ({ status: 'done', outputs: ['asset'] }), store: async () => ({ assetIds: ['asset'] }), deliver: async () => ({ delivered: true }) }
  const runner = createJobRunner({ storage, handlers: { image: h, song: h, bili: h }, pollMs: 0 })
  const calls = [], registry = new Map()
  for (const kind of ['image', 'song', 'bili']) registry.set(kind, {
    cancel: (id, options) => { calls.push({ kind, id, options }); return runner.cancel(id, options) },
  })
  const builders = [], timers = [], cleanup = [], listeners = new Map(), controls = [], routes = new Map()
  const core = {
    hub, storage, getJobRunner: (kind) => registry.get(kind),
    http: { query: (req) => req.query, body: async (req) => req.body },
    plannerControl: async (event) => { controls.push(event) },
    ...options.core,
  }
  const service = tasksModule.setup({
    core, config: () => cfg, lazy: (id) => id === 'imagegen' ? { runner } : {},
    tool: (fn) => builders.push(fn), every: (ms, fn) => timers.push(fn),
    route: (path, fn) => routes.set(path, fn),
    on: (name, fn) => listeners.set(name, fn), onDispose: (fn) => cleanup.push(fn),
  })
  const tools = () => builders[0]({ chat: { kind: 'group', chatId: 'group:1' }, sessionId: 'session', level: 'social' })
  const call = (name, args = {}, execution) => tools().find((x) => x.name === name).execute(args, execution)
  const job = (req = initial, kind = 'image', input = {}) => runner.enqueue({
    kind, requestId: req.id, chatId: req.chatId, actorId: req.actorId,
    input: { accountId: cfg.botQQ, apiKey: 'must-not-leak', prompt: 'fixture', ...input },
  })
  const select = (req, requests = [req]) => { actor = { actorId: req.actorId, requestId: req.id }; currentRequests = requests }
  t.after(() => {
    cleanup.forEach((fn) => fn())
    runner.stop()
    storage.close()
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()))
    rmSync(dir, { recursive: true, force: true })
  })
  return { storage, cfg, service, core, builders, timers, listeners, controls, calls, registry, runner, routes,
    initial, tools, call, job, request, select,
    actor: (value) => { actor = value }, requests: (value) => { currentRequests = value },
    chat: (value) => { chatId = value }, wake: (value) => { wakeId = value },
  }
}

test('四个真实可执行工具，schema 不暴露身份/force；系统聊天和纯聊天不挂工具', async (t) => {
  const f = setup(t)
  assert.deepEqual(f.tools().map((x) => x.name), ['qq_wait', 'qq_stop', 'qq_tasks', 'qq_cancel_task'])
  for (const tool of f.tools()) {
    assert.equal(tool.parameters.additionalProperties, false)
    for (const name of ['actorId', 'account', 'chatId', 'force', 'authority', 'turnId', 'wakeId']) {
      assert.equal(tool.parameters.properties[name], undefined)
    }
  }
  assert.deepEqual(f.builders[0]({ chat: { kind: 'system' } }), [])
  assert.deepEqual(f.builders[0]({ chat: { kind: 'group' }, level: 'chat' }), [])
  const r = await f.call('qq_tasks')
  assert.equal(r.ok, true)
  assert.equal(JSON.parse(f.tools()[2].output.render({}, r)[0].text).tasks.length, 0)
})

for (const kind of ['image', 'song', 'bili']) {
  test(kind + ' 查询与取消沿用同一归属规则，按 kind 分派 runner', async (t) => {
    const f = setup(t)
    const own = f.job(f.initial, kind)
    const other = f.job(f.request({ actor: '9' }), kind)
    const queried = await f.call('qq_tasks', { kind })
    assert.deepEqual(queried.tasks.map((x) => x.id), [own.id])
    assert.ok(!JSON.stringify(queried).includes('must-not-leak'))
    assert.equal((await f.call('qq_tasks', { task_id: other.id })).code, 'NOT_FOUND')
    assert.equal((await f.call('qq_cancel_task', { task_id: other.id })).code, 'NOT_FOUND')
    assert.equal((await f.call('qq_cancel_task', { task_id: own.id })).ok, true)
    assert.deepEqual(f.calls, [{ kind, id: own.id, options: { by: '8', force: false } }])
    assert.equal(f.runner.get(own.id).state, 'canceled')
    assert.equal(f.runner.get(other.id).state, 'queued')
  })
}

test('模型伪造 owner/force/chat/account 参数无效，同轮主人发言也不替其他人授权', async (t) => {
  const f = setup(t)
  const ownerReq = f.request({ actor: '7' })
  const victim = f.job(ownerReq, 'song')
  f.select(f.initial, [f.initial, ownerReq])
  const forged = { task_id: victim.id, actorId: '7', force: true, chatId: 'private:7', account: '9000', authority: 'owner-panel' }
  assert.equal((await f.call('qq_tasks', forged)).code, 'NOT_FOUND')
  assert.equal((await f.call('qq_cancel_task', forged)).code, 'NOT_FOUND')
  assert.equal(f.calls.length, 0)
  f.select(ownerReq, [f.initial, ownerReq])
  const another = f.job(f.request({ actor: '9' }), 'bili')
  assert.equal((await f.call('qq_tasks', { task_id: another.id })).ok, true)
  assert.equal((await f.call('qq_cancel_task', { task_id: another.id })).ok, true)
  assert.equal(f.calls.at(-1).options.force, true)
  assert.equal(f.calls.at(-1).options.by, '7')
})

test('主人工具也不能跨聊天/账号；独立面板管理需要明确聊天且不能跨账号', async (t) => {
  const f = setup(t)
  const owner = f.request({ actor: '7' })
  f.select(owner)
  const elsewhere = f.job(f.request({ chatId: 'group:2' }), 'song')
  const foreignRequest = f.request({ chatId: 'group:1', account: '9001' })
  const foreign = f.job(foreignRequest, 'bili')
  assert.equal((await f.call('qq_tasks', { task_id: elsewhere.id })).code, 'NOT_FOUND')
  assert.equal((await f.call('qq_cancel_task', { task_id: elsewhere.id })).code, 'NOT_FOUND')
  assert.equal((await f.call('qq_tasks', { task_id: foreign.id })).code, 'NOT_FOUND')
  assert.equal((await f.call('qq_cancel_task', { task_id: foreign.id })).code, 'NOT_FOUND')
  assert.deepEqual(f.service.panelList({ chatId: 'group:2' }).map((r) => r.id), [elsewhere.id])
  assert.equal(f.service.panelCancel({ chatId: 'group:2', id: elsewhere.id }).ok, true)
  assert.throws(() => f.service.panelCancel({ chatId: 'group:1', id: foreign.id }), { code: 'NOT_FOUND' })
  assert.throws(() => f.service.panelList({}), { code: 'CONTEXT_REQUIRED' })
})

test('旧任务没有可信账号不猜归属，冻结账号的面板任务仍可管理', async (t) => {
  const f = setup(t)
  const hidden = f.runner.enqueue({ kind: 'song', chatId: 'group:1', actorId: '8', input: { prompt: 'legacy' } })
  const visible = f.runner.enqueue({ kind: 'bili', chatId: 'group:1', actorId: '8', input: { accountId: '9000' } })
  assert.equal((await f.call('qq_tasks', { task_id: hidden.id })).code, 'NOT_FOUND')
  assert.equal((await f.call('qq_cancel_task', { task_id: hidden.id })).code, 'NOT_FOUND')
  assert.equal((await f.call('qq_tasks', { task_id: visible.id })).ok, true)
  assert.equal((await f.call('qq_cancel_task', { task_id: visible.id })).ok, true)
})

for (const invalid of ['ambiguous', 'missing', 'forged_actor', 'moved_session', 'old_turn', 'epoch', 'account', 'blocked_chat', 'canceled_request', 'signal']) {
  test('无效上下文 ' + invalid + ' 同时拒绝查询和取消', async (t) => {
    const f = setup(t)
    const j = f.job()
    const controller = new AbortController()
    if (invalid === 'ambiguous') f.actor({ error: '请明确正在处理谁的请求' })
    if (invalid === 'missing') f.actor({ actorId: '8', requestId: null })
    if (invalid === 'forged_actor') f.actor({ actorId: '7', requestId: f.initial.id })
    if (invalid === 'moved_session') f.chat('group:2')
    if (invalid === 'old_turn') f.requests([f.request()])
    if (invalid === 'epoch') f.storage.epochs.bump('group:1')
    if (invalid === 'account') f.cfg.botQQ = '9001'
    if (invalid === 'blocked_chat') f.cfg.allow.groups = []
    if (invalid === 'canceled_request') f.storage.requests.setState(f.initial.id, 'canceled')
    if (invalid === 'signal') controller.abort()
    const first = await f.call('qq_tasks', { task_id: j.id }, { signal: controller.signal })
    const second = await f.call('qq_cancel_task', { task_id: j.id }, { signal: controller.signal })
    assert.equal(first.ok, false)
    assert.equal(second.ok, false)
    assert.equal(first.code, second.code)
    assert.equal(f.calls.length, 0)
    assert.equal(f.runner.get(j.id).state, 'queued')
  })
}

test('模块移除/不可用仍能查账本，取消明确失败且不修改任务', async (t) => {
  const f = setup(t)
  const j = f.job(f.initial, 'song')
  f.registry.delete('song')
  assert.equal((await f.call('qq_tasks', { task_id: j.id })).ok, true)
  assert.equal((await f.call('qq_cancel_task', { task_id: j.id })).code, 'RUNNER_UNAVAILABLE')
  assert.equal(f.runner.get(j.id).state, 'queued')
})

test('wait/stop 控制回调在持久状态之后，取消等待与取消后台任务是不同操作', async (t) => {
  const f = setup(t)
  const j = f.job(f.initial, 'song')
  const w = await f.call('qq_wait', { condition: 'job', job_ids: [j.id], timeout_ms: 1000 })
  assert.equal(w.ok, true)
  assert.equal(f.controls[0].action, 'wait')
  assert.equal(f.controls[0].context.actorId, '8')
  const stop = await f.call('qq_stop', { reason: '已交后台' })
  assert.equal(stop.ok, true)
  assert.equal(f.runner.get(j.id).state, 'queued')
  const next = f.request()
  f.select(next)
  assert.equal((await f.call('qq_tasks', { task_id: w.waitId })).tasks[0].state, 'waiting')
  assert.equal((await f.call('qq_cancel_task', { task_id: w.waitId })).ok, true)
  assert.equal(f.runner.get(j.id).state, 'queued')
  assert.equal(f.calls.length, 0)
})

test('等待对象不可越权，模型 request_id 只作依赖，不可替换操作者', async (t) => {
  const f = setup(t)
  const owner = f.request({ actor: '7' })
  const ownerJob = f.job(owner)
  assert.equal((await f.call('qq_wait', { condition: 'job', job_ids: [ownerJob.id], request_id: owner.id })).code, 'FORBIDDEN')
  assert.equal((await f.call('qq_wait', { condition: 'request', request_id: owner.id })).code, 'FORBIDDEN')
  assert.equal(f.controls.length, 0)
})

test('唤醒接线后同一个 request 使用新的 wakeId 预算，finish 信号不会伪造结果', async (t) => {
  const f = setup(t)
  const j = f.job(f.initial, 'bili')
  const w = await f.call('qq_wait', { condition: 'job', job_ids: [j.id], timeout_ms: 10000 })
  assert.equal(w.ok, true)
  const wakes = []
  f.service.setOnWake((event, execution) => {
    assert.equal(execution.guard(), true)
    const accepted = execution.commit(() => f.service.begin(event.context))
    wakes.push(event)
    return { accepted: accepted.ok }
  })
  f.listeners.get('job/changed')({ jobId: j.id, account: '9000', chatId: 'group:1', state: 'delivered' })
  await f.timers[0]()
  assert.equal(wakes.length, 0)
  await f.runner.drain()
  f.listeners.get('job/changed')({ jobId: j.id, account: '9000', chatId: 'group:1' })
  await f.timers[0]()
  assert.equal(wakes.length, 1)
  assert.equal((await f.call('qq_tasks')).code, 'PLANNER_STOPPED', '未绑定新 wakeId 不能偷重置旧回合')
  f.wake(wakes[0].id)
  const result = await f.call('qq_tasks', { task_id: j.id })
  assert.equal(result.ok, true)
  assert.equal(result.tasks[0].state, 'delivered')
})

test('六次工具上限和 stop 持久化；宿主控制回调故障不能复活当前回合', async (t) => {
  const f = setup(t)
  for (let i = 0; i < 6; i++) assert.equal((await f.call('qq_tasks')).ok, true)
  assert.equal((await f.call('qq_tasks')).code, 'BUDGET_EXHAUSTED')
  const result = await f.call('qq_stop')
  assert.equal(result.ok, true)
  assert.equal(result.state, 'exhausted')
  f.select(f.request())
  f.service.setOnControl(() => { throw new Error('host failed') })
  const stopped = await f.call('qq_stop')
  assert.equal(stopped.ok, true)
  assert.equal(stopped.hostControl, 'failed')
  assert.equal((await f.call('qq_tasks')).code, 'PLANNER_STOPPED')
})

test('/tasks/list 与 /tasks/cancel：明确聊天、可信 owner、按 kind 管理，拒绝错误方法与跨账号', async (t) => {
  const f = setup(t)
  const j = f.job(f.request({ actor: '9', chatId: 'group:2' }), 'song')
  const list = f.routes.get('/tasks/list'), cancel = f.routes.get('/tasks/cancel')
  assert.equal((await list({ method: 'POST', query: { chatId: 'group:2' } })).code, 'METHOD_NOT_ALLOWED')
  assert.equal((await cancel({ method: 'GET', body: { chatId: 'group:2', id: j.id } })).code, 'METHOD_NOT_ALLOWED')
  assert.equal((await list({ method: 'GET', query: {} })).code, 'CONTEXT_REQUIRED')
  assert.equal((await list({ method: 'GET', query: { chatId: 'group:2', limit: '500' } })).code, 'INVALID_LIMIT')
  const queried = await list({ method: 'GET', query: { chatId: 'group:2', kind: 'song', actorId: 'fake', account: 'fake' } })
  assert.deepEqual(queried.list.map((r) => r.id), [j.id])
  assert.equal((await cancel({ method: 'POST', body: { chatId: 'group:1', id: j.id } })).code, 'NOT_FOUND')
  assert.equal((await cancel({ method: 'POST', body: { chatId: 'group:2', id: j.id, actorId: '9', force: false } })).ok, true)
  assert.deepEqual(f.calls.at(-1).options, { by: '7', force: true })
  const foreign = f.job(f.request({ account: '9001', chatId: 'group:2' }), 'bili')
  assert.equal((await cancel({ method: 'POST', body: { chatId: 'group:2', id: foreign.id, account: '9001' } })).code, 'NOT_FOUND')
})

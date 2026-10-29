import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createStorage } from '../src/storage/index.js'
import { createPlanner } from '../src/runtime/planner.js'
import { createJobRunner } from '../src/jobs/runner.js'

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
async function until(fn) {
  const end = Date.now() + 3000
  while (!fn()) { assert.ok(Date.now() < end, 'condition timeout'); await sleep(5) }
}
function setup(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-planner-'))
  const file = join(dir, 'db.sqlite')
  const stores = [], planners = [], runners = []
  const cfg = { botQQ: '9000', ownerQQ: '7', enabled: true, allow: { groups: ['1', '2', '3'], private: ['8'] } }
  let clock = 1000
  const events = []
  const open = () => {
    const s = createStorage({ file, filesDir: join(dir, 'assets'), now: () => clock })
    stores.push(s)
    return s
  }
  const s = open()
  const h = {
    submit: async () => ({ status: 'running', providerTaskId: 'provider-task' }),
    poll: async () => ({ status: 'done', outputs: ['asset'] }),
    store: async (j, outputs) => ({ assets: outputs }),
    deliver: async () => ({ delivered: true }),
  }
  const runner = createJobRunner({ storage: s, handlers: { image: h, song: h, bili: h }, now: () => clock, pollMs: 0 })
  runners.push(runner)
  const make = (storage = s, extra = {}) => {
    const p = createPlanner({ storage, getConfig: () => cfg, getRunner: () => runner, now: () => clock,
      minWaitMs: 10, maxWaitMs: 10000, maxWakeAgeMs: 1000, leaseMs: 120,
      onWake: async (event) => { events.push(event); return { accepted: true } }, ...options, ...extra })
    planners.push(p)
    return p
  }
  const p = make()
  const request = ({ actor = '8', chatId = 'group:1', account = cfg.botQQ } = {}) => {
    const m = s.messages.ingest({ account, chatId, authorId: actor, text: 'request', eventKind: 'message' })
    const r = s.requests.create({ chatId, actorId: actor, sourceMessageIds: [m.id] })
    return { account: String(account), chatId, actorId: String(actor), requestId: r.id, turnId: r.id,
      epoch: r.epoch, policyRevision: r.policyRevision, sourceMessageIds: r.sourceMessageIds }
  }
  const ctx = request()
  const job = (context = ctx, kind = 'image') => runner.enqueue({ kind, chatId: context.chatId, actorId: context.actorId,
    requestId: context.requestId, input: { accountId: context.account, prompt: 'fixture' } })
  const waitRow = (id) => JSON.parse(s.db.get('SELECT value FROM meta WHERE key = ?', 'planner:wait:' + id).value)
  t.after(() => {
    for (const p of planners) p.dispose()
    for (const r of runners) r.stop()
    for (const s of stores) s.close()
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()))
    rmSync(dir, { recursive: true, force: true })
  })
  return { s, p, cfg, ctx, events, runner, h, request, job, waitRow, open, make,
    time: (value) => { clock = value }, advance: (value) => { clock += value }, now: () => clock }
}

test('Planner follows the live tool limit beyond six and preserves exhausted turns', (t) => {
  const f = setup(t)
  f.cfg.toolCallsPerTurn = 30
  for (let i = 0; i < 10; i++) assert.equal(f.p.useTool(f.ctx, { name: 'recall' }).ok, true)
  // A panel reduction applies immediately; restoring a higher limit cannot
  // reopen the same exhausted decision or reset its persisted consumption.
  f.cfg.toolCallsPerTurn = 10
  assert.equal(f.p.useTool(f.ctx, { name: 'recall' }).code, 'BUDGET_EXHAUSTED')
  f.cfg.toolCallsPerTurn = 30
  assert.equal(f.p.useTool(f.ctx, { name: 'recall' }).code, 'BUDGET_EXHAUSTED')
  const next = f.request()
  for (let i = 0; i < 30; i++) assert.equal(f.p.useTool(next, { name: 'recall' }).ok, true)
  assert.equal(f.p.useTool(next, { name: 'recall' }).code, 'BUDGET_EXHAUSTED')
})

test('explicit Planner limits override config and searches retain an independent cap', (t) => {
  const f = setup(t, { maxTools: 2 })
  f.cfg.toolCallsPerTurn = 30
  assert.equal(f.p.useTool(f.ctx, { name: 'recall' }).ok, true)
  assert.equal(f.p.useTool(f.ctx, { name: 'recall' }).ok, true)
  assert.equal(f.p.useTool(f.ctx, { name: 'recall' }).code, 'BUDGET_EXHAUSTED')
  const p = f.make(f.s, { maxTools: undefined }), next = f.request()
  assert.equal(p.useTool(next, { name: 'search', search: true }).ok, true)
  assert.equal(p.useTool(next, { name: 'search', search: true }).ok, true)
  assert.equal(p.useTool(next, { name: 'search', search: true }).code, 'BUDGET_EXHAUSTED')
})

test('wait 落库后结束决策，stop 不取消等待或后台任务', async (t) => {
  const f = setup(t)
  const j = f.job()
  await f.runner.tick()
  const w = f.p.wait(f.ctx, { condition: 'job', jobIds: [j.id], timeoutMs: 1000 })
  assert.equal(w.ok, true)
  assert.equal(f.p.state(f.ctx).state, 'waiting')
  assert.equal(f.waitRow(w.waitId).context.actorId, '8')
  assert.equal(f.waitRow(w.waitId).targetRequestId, f.ctx.requestId)
  assert.equal(f.p.useTool(f.ctx, { name: 'draw_more' }).code, 'PLANNER_STOPPED')
  f.p.stop(f.ctx)
  assert.equal(f.waitRow(w.waitId).state, 'waiting')
  assert.equal(f.runner.get(j.id).state, 'running')
  await f.p.tick()
  assert.equal(f.events.length, 0)
  await f.runner.drain()
  f.p.signal({ type: 'job', jobId: j.id, account: '9000', chatId: f.ctx.chatId })
  await f.p.tick()
  await f.p.tick()
  assert.equal(f.events.length, 1)
  assert.equal(f.events[0].observations[0].state, 'delivered')
  assert.equal(f.events[0].context.requestId, f.ctx.requestId)
  assert.equal(f.events[0].context.actorId, f.ctx.actorId)
  assert.equal(f.p.begin(f.events[0].context).created, true)
  assert.equal(f.p.begin(f.events[0].context).created, false, '稳定 wakeId 不重建预算')
})

test('重开 SQLite 后恢复期限等待，只唤醒一次，已确认回执不重放', async (t) => {
  const f = setup(t)
  const w = f.p.wait(f.ctx, { condition: 'time', timeoutMs: 100 })
  const wakeId = f.waitRow(w.waitId).wakeId
  f.p.dispose()
  const fresh = f.make(f.open())
  fresh.recover()
  f.advance(99)
  await fresh.tick()
  assert.equal(f.events.length, 0)
  f.advance(1)
  await fresh.tick()
  assert.equal(f.events[0].id, wakeId)
  assert.equal(f.events[0].reason, 'deadline')
  fresh.dispose()
  const again = f.make(f.open())
  again.recover()
  await again.tick()
  assert.equal(f.events.length, 1)
  assert.equal(f.waitRow(w.waitId).state, 'woken')
})

for (const state of ['failed', 'unknown', 'canceled']) {
  test('job ' + state + ' 会唤醒并如实传状态，不改写成成功', async (t) => {
    const f = setup(t)
    const j = f.job(f.ctx, 'song')
    const w = f.p.wait(f.ctx, { condition: 'job', jobIds: [j.id] })
    f.s.db.run('UPDATE jobs SET state = ? WHERE id = ?', state, j.id)
    await f.p.tick()
    assert.equal(f.events[0].observations[0].state, state)
    assert.equal(f.waitRow(w.waitId).state, 'woken')
    assert.equal(f.runner.get(j.id).state, state)
  })
}

test('job all/any/resultReady 条件不同，伪造完成事件不能替代账本', async (t) => {
  const f = setup(t)
  const j1 = f.job(), j2 = f.job()
  const a = f.p.wait(f.ctx, { condition: 'job', jobIds: [j1.id, j2.id], mode: 'all', resultReady: true })
  const other = f.request()
  // 同请求者的后续请求可以等待原任务；归属仍是自己的。
  const b = f.p.wait(other, { condition: 'job', jobIds: [j1.id, j2.id], mode: 'any', resultReady: true })
  f.p.signal({ type: 'job', jobId: j1.id, account: '9000', chatId: 'group:1', state: 'delivered' })
  await f.p.tick()
  assert.equal(f.events.length, 0)
  f.s.db.run("UPDATE jobs SET state = 'delivery_pending' WHERE id = ?", j1.id)
  await f.p.tick()
  assert.equal(f.waitRow(a.waitId).state, 'waiting')
  assert.equal(f.waitRow(b.waitId).state, 'woken')
  assert.equal(f.events[0].observations[0].state, 'delivery_pending')
})

test('请求补充事件须匹配账号、聊天、请求和作者；媒体失败也会解除等待', async (t) => {
  const f = setup(t)
  const w = f.p.wait(f.ctx, { condition: 'request' })
  for (const mismatch of [{ account: 'wrong' }, { chatId: 'group:2' }, { actorId: '7' }, { requestId: 'fake' }]) {
    f.p.signal({ type: 'request', account: '9000', chatId: 'group:1', actorId: '8', requestId: f.ctx.requestId, ...mismatch })
  }
  await f.p.tick()
  assert.equal(f.events.length, 0)
  const supplement = f.s.messages.ingest({ account: '9000', chatId: 'group:1', authorId: '8', text: '补充条件' })
  f.p.signal({ type: 'request', account: '9000', chatId: 'group:1', actorId: '8', requestId: f.ctx.requestId, messageId: supplement.id })
  await f.p.tick()
  assert.equal(f.waitRow(w.waitId).state, 'woken')
  const ctx = f.request()
  const occurrence = f.s.occurrences.add({ messageId: ctx.sourceMessageIds[0], chatId: ctx.chatId, authorId: '8', segIndex: 0,
    kind: 'image', scope: { account: '9000', chat: ctx.chatId, category: 'image' } })
  const media = f.p.wait(ctx, { condition: 'media' })
  await f.p.tick()
  assert.equal(f.waitRow(media.waitId).state, 'waiting')
  f.s.occurrences.failed(occurrence, 'download failed')
  await f.p.tick()
  assert.equal(f.events.at(-1).observations[0].state, 'failed')
})

for (const change of ['epoch', 'account', 'permission', 'policy', 'request']) {
  test(change + ' 失效后等待被取消，重启不会复活旧权限', async (t) => {
    const f = setup(t)
    const w = f.p.wait(f.ctx, { condition: 'time', timeoutMs: 10 })
    if (change === 'epoch') f.s.epochs.bump(f.ctx.chatId)
    if (change === 'account') f.cfg.botQQ = '9001'
    if (change === 'permission') f.cfg.allow.groups = []
    if (change === 'policy') f.cfg.policyRevision = 1
    if (change === 'request') f.s.requests.setState(f.ctx.requestId, 'canceled')
    f.advance(10)
    const fresh = f.make(f.open())
    fresh.recover()
    await fresh.tick()
    assert.equal(f.waitRow(w.waitId).state, 'canceled')
    assert.equal(f.events.length, 0)
  })
}

test('期限、积压过期和未接线接收器都有明确状态，不丢等待也不自动自唤醒', async (t) => {
  const f = setup(t, { onWake: undefined })
  assert.throws(() => f.p.wait(f.ctx, { condition: 'time', timeoutMs: 0 }), { code: 'INVALID_DEADLINE' })
  assert.throws(() => f.p.wait(f.ctx, { condition: 'time', timeoutMs: 10001 }), { code: 'INVALID_DEADLINE' })
  const w = f.p.wait(f.ctx, { condition: 'time', timeoutMs: 100 })
  f.advance(100)
  assert.equal(await f.p.tick(), 0)
  assert.equal(f.waitRow(w.waitId).state, 'ready')
  f.p.setOnWake((event) => { f.events.push(event); return true })
  await f.p.tick()
  assert.equal(f.events.length, 1)
  const ctx = f.request()
  const stale = f.p.wait(ctx, { condition: 'time', timeoutMs: 10 })
  f.advance(1011)
  f.p.recover()
  await f.p.tick()
  assert.equal(f.waitRow(stale.waitId).state, 'expired')
  assert.equal(f.events.length, 1)
})

test('4 轮/6 工具/2 搜索预算持久化且同回合多人共享，耗尽不再安排唤醒', async (t) => {
  const f = setup(t)
  for (let i = 0; i < 4; i++) assert.equal(f.p.decision(f.ctx, 'recall').ok, true)
  const fresh = f.make(f.open())
  assert.equal(fresh.decision(f.ctx, 'search').code, 'BUDGET_EXHAUSTED')
  assert.equal(fresh.wait(f.ctx, { condition: 'time' }).code, 'BUDGET_EXHAUSTED')
  assert.equal(f.p.state(f.ctx).state, 'exhausted')
  const ctx = f.request()
  let executions = 0
  for (let i = 0; i < 6; i++) await f.p.runTool(ctx, { name: 'test' }, async () => { executions++; return { ok: true } })
  assert.equal((await fresh.runTool(ctx, { name: 'paid' }, async () => { executions++; })).code, 'BUDGET_EXHAUSTED')
  assert.equal(executions, 6)
  const a = f.request()
  const b = { ...f.request({ actor: '9' }), turnId: a.turnId }
  assert.equal(f.p.useTool(a, { name: 'search', search: true }).ok, true)
  assert.equal(fresh.useTool(b, { name: 'reference-search', search: true }).ok, true)
  assert.equal(f.p.useTool(a, { name: 'search', search: true }).code, 'BUDGET_EXHAUSTED')
  assert.equal(f.p.state(a).searches, 2)
  assert.equal(await f.p.tick(), 0)
})

test('自动等待链有跨重启总上限，新的用户请求才拥有新的额度', async (t) => {
  const f = setup(t, { maxAutoWakes: 2 })
  let ctx = f.ctx
  for (let i = 0; i < 2; i++) {
    assert.equal(f.p.wait(ctx, { condition: 'time', timeoutMs: 10 }).ok, true)
    f.advance(10)
    await f.p.tick()
    ctx = f.events.at(-1).context
    f.p.begin(ctx)
  }
  const fresh = f.make(f.open())
  assert.equal(fresh.wait(ctx, { condition: 'time', timeoutMs: 10 }).code, 'WAKE_LIMIT')
  f.advance(100)
  await fresh.tick()
  assert.equal(f.events.length, 2)
  assert.equal(fresh.wait(f.request(), { condition: 'time', timeoutMs: 10 }).ok, true)
})

test('stop 和请求失效隔离迟到工具结果，失败工具仍消耗预算', async (t) => {
  const f = setup(t)
  const entered = deferred(), gate = deferred()
  let sideEffects = 0
  const pending = f.p.runTool(f.ctx, { name: 'slow' }, async (ex) => {
    entered.resolve(ex)
    await gate.promise
    if (ex.guard()) sideEffects++
    return { ok: true }
  })
  const ex = await entered.promise
  f.p.stop(f.ctx)
  assert.equal(ex.guard(), false)
  gate.resolve()
  await assert.rejects(pending, { code: 'PLANNER_STOPPED' })
  assert.equal(sideEffects, 0)
  const ctx = f.request()
  await assert.rejects(f.p.runTool(ctx, { name: 'fails' }, async () => { throw new Error('fault') }), /fault/)
  assert.equal(f.p.state(ctx).tools, 1)
})

test('接收器异常/超时结果 unknown，迟到确认和再次 tick 不能重复唤醒', async (t) => {
  const gate = deferred(), entered = deferred()
  const f = setup(t, { wakeTimeoutMs: 30, onWake: async (event, ex) => { entered.resolve(ex); await gate.promise; return true } })
  const w = f.p.wait(f.ctx, { condition: 'time', timeoutMs: 10 })
  f.advance(10)
  const ticking = f.p.tick()
  const ex = await entered.promise
  await ticking
  assert.equal(ex.signal.aborted, true)
  assert.equal(f.waitRow(w.waitId).state, 'unknown')
  gate.resolve()
  await sleep(1)
  assert.equal(await f.p.tick(), 0)
  assert.equal(f.waitRow(w.waitId).state, 'unknown')
  f.p.setOnWake(() => { throw new Error('queue connection lost') })
  const second = f.p.wait(f.request(), { condition: 'time', timeoutMs: 10 })
  f.advance(10)
  await f.p.tick()
  assert.equal(f.waitRow(second.waitId).state, 'unknown')
})

test('只有明确未接收才退避重试，次数有上限', async (t) => {
  let calls = 0
  const f = setup(t, { retryMs: 10, maxAttempts: 3, onWake: () => { calls++; return { accepted: false, retryable: true } } })
  const w = f.p.wait(f.ctx, { condition: 'time', timeoutMs: 10 })
  f.advance(10)
  await f.p.tick()
  await f.p.tick()
  assert.equal(calls, 1)
  f.advance(10)
  await f.p.tick()
  f.advance(20)
  await f.p.tick()
  assert.equal(calls, 3)
  assert.equal(f.waitRow(w.waitId).state, 'failed')
  f.advance(100)
  assert.equal(await f.p.tick(), 0)
})

test('独立连接保留活投递租约；租约过期恢复 unknown，旧确认不能覆盖', async (t) => {
  const entered = deferred(), gate = deferred()
  let calls = 0
  const f = setup(t, { onWake: async (event, ex) => { calls++; entered.resolve(ex); await gate.promise; return true } })
  const w = f.p.wait(f.ctx, { condition: 'time', timeoutMs: 10 })
  f.advance(10)
  const ticking = f.p.tick()
  const ex = await entered.promise
  const fresh = f.make(f.open())
  const token = f.waitRow(w.waitId).leaseToken
  fresh.recover()
  assert.equal(await fresh.tick(), 0)
  assert.equal(f.waitRow(w.waitId).leaseToken, token)
  f.advance(40)
  await until(() => f.waitRow(w.waitId).leaseUntil >= f.now() + 120)
  f.advance(121)
  fresh.recover()
  assert.equal(f.waitRow(w.waitId).state, 'unknown')
  assert.equal(ex.guard(), false)
  gate.resolve()
  await ticking
  assert.equal(f.waitRow(w.waitId).state, 'unknown')
  assert.equal(calls, 1)
})

test('取消等待或 dispose 中止在途唤醒，stop 当前决策则不取消它', async (t) => {
  const entered = deferred(), gate = deferred()
  const f = setup(t, { onWake: async (event, ex) => { entered.resolve(ex); await gate.promise; return true } })
  const w = f.p.wait(f.ctx, { condition: 'time', timeoutMs: 10 })
  f.advance(10)
  const ticking = f.p.tick()
  const ex = await entered.promise
  f.p.cancelTask(f.ctx, w.waitId)
  assert.equal(ex.signal.aborted, true)
  await ticking
  gate.resolve()
  assert.equal(f.waitRow(w.waitId).state, 'canceled')
  const pending = f.p.wait(f.request(), { condition: 'time', timeoutMs: 10 })
  f.p.dispose()
  assert.equal(f.waitRow(pending.waitId).state, 'waiting', '服务停止保留尚未投递的等待')
})

test('一次 tick 有总量及每聊天上限，等待积压不会瞬间刷模型', async (t) => {
  const f = setup(t, { maxPerTick: 2 })
  for (const chatId of ['group:1', 'group:1', 'group:1', 'group:2', 'group:3']) {
    f.p.wait(f.request({ chatId }), { condition: 'time', timeoutMs: 10 })
  }
  f.advance(10)
  assert.equal(await f.p.tick(), 2)
  assert.equal(new Set(f.events.map((e) => e.context.chatId)).size, 2)
  assert.equal(await f.p.tick(), 2)
  assert.equal(await f.p.tick(), 1)
  assert.equal(await f.p.tick(), 0)
})

test('模型请求前预留 4 轮，拒绝并发和第 5 次调用；wait 工具不双扣同一轮', async (t) => {
  const f = setup(t)
  for (let i = 0; i < 4; i++) {
    const started = f.p.beginDecision(f.ctx)
    assert.equal(started.ok, true)
    assert.equal(f.p.beginDecision(f.ctx).code, 'DECISION_IN_FLIGHT')
    assert.equal(f.p.finishDecision(f.ctx, 'forged', 'reply').code, 'STALE_DECISION')
    assert.equal(f.p.finishDecision(f.ctx, started.decisionId, 'recall').ok, true)
  }
  assert.equal(f.p.beginDecision(f.ctx).code, 'BUDGET_EXHAUSTED')
  const ctx = f.request()
  const reserved = f.p.beginDecision(ctx)
  const wait = f.p.wait(ctx, { condition: 'time', timeoutMs: 10 })
  assert.equal(wait.ok, true)
  assert.equal(f.p.state(ctx).rounds, 1)
  assert.equal(f.p.finishDecision(ctx, reserved.decisionId, 'reply').code, 'STALE_DECISION')
  assert.equal(f.p.shouldContinue(ctx), false)
})

test('等待登记落库故障整笔回滚，不消耗预算或留下孤儿等待', (t) => {
  const f = setup(t)
  const run = f.s.db.run
  f.s.db.run = (sql, ...args) => {
    if (String(args[0]).startsWith('planner:wait:')) throw new Error('disk fault')
    return run(sql, ...args)
  }
  try { assert.throws(() => f.p.wait(f.ctx, { condition: 'time', timeoutMs: 10 }), /disk fault/) }
  finally { f.s.db.run = run }
  assert.equal(f.p.state(f.ctx), null)
  assert.equal(f.s.db.all("SELECT key FROM meta WHERE key GLOB 'planner:wait:*'").length, 0)
  assert.equal(f.p.wait(f.ctx, { condition: 'time', timeoutMs: 10 }).ok, true)
})

test('已接收但确认落库故障时不重发；过期恢复 unknown 保留稳定事件 ID', async (t) => {
  const f = setup(t)
  const w = f.p.wait(f.ctx, { condition: 'time', timeoutMs: 10 })
  const run = f.s.db.run
  f.s.db.run = (sql, ...args) => {
    if (String(args[0]).startsWith('planner:wait:') && String(args[1]).includes('"state":"woken"')) throw new Error('receipt write failed')
    return run(sql, ...args)
  }
  f.advance(10)
  try { await assert.rejects(f.p.tick(), /receipt write failed/) }
  finally { f.s.db.run = run }
  assert.equal(f.events.length, 1)
  const fresh = f.make(f.open())
  assert.equal(await fresh.tick(), 0)
  f.advance(121)
  fresh.recover()
  assert.equal(f.waitRow(w.waitId).state, 'unknown')
  assert.equal(await fresh.tick(), 0)
  assert.equal(f.events.length, 1)
})

test('同一 request 补充事件跨重启持久去重，不能再次触发下一次等待', async (t) => {
  const f = setup(t)
  f.p.wait(f.ctx, { condition: 'request', timeoutMs: 1000 })
  const message = f.s.messages.ingest({ account: '9000', chatId: 'group:1', authorId: '8', text: 'supplement' })
  const event = { type: 'request', account: '9000', chatId: 'group:1', actorId: '8', requestId: f.ctx.requestId, messageId: message.id }
  f.p.signal(event)
  f.p.dispose()
  const fresh = f.make(f.open())
  await fresh.tick()
  assert.equal(f.events.length, 1)
  const wakeContext = f.events[0].context
  fresh.begin(wakeContext)
  const next = fresh.wait(wakeContext, { condition: 'request', timeoutMs: 1000 })
  fresh.signal(event)
  await fresh.tick()
  assert.equal(f.events.length, 1)
  assert.equal(f.waitRow(next.waitId).state, 'waiting')
})

test('重叠 tick 与独立连接共享唤醒并发上限，同聊天只能有一个在投递', async (t) => {
  const gate = deferred()
  let entered = 0
  const f = setup(t, { maxPerTick: 2, onWake: async () => { entered++; await gate.promise; return true } })
  for (const chatId of ['group:1', 'group:1', 'group:2', 'group:3']) {
    f.p.wait(f.request({ chatId }), { condition: 'time', timeoutMs: 10 })
  }
  f.advance(10)
  const first = f.p.tick()
  await until(() => entered === 2)
  const fresh = f.make(f.open())
  assert.equal(await fresh.tick(), 0)
  assert.equal(await f.p.tick(), 0)
  gate.resolve()
  await first
  assert.equal(await fresh.tick(), 2)
})

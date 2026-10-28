// 可恢复任务：状态推进、额度、重试、不确定结果不重发、发送失败只重发、取消、重启恢复、公平。
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { createStorage } from '../src/storage/index.js'
import { createJobRunner } from '../src/jobs/runner.js'
import { ProviderError } from '../src/providers/image/common.js'
import { createOutbox } from '../src/delivery/outbox.js'

const fixtures = []
const runners = []
const storage = () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-jobs-'))
  const s = createStorage({ file: ':memory:', filesDir: join(dir, 'assets') })
  fixtures.push({ s, dir })
  return s
}
afterEach(() => {
  for (const r of runners.splice(0)) r.stop()
  for (const { s, dir } of fixtures.splice(0)) {
    s.close()
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()))
    rmSync(dir, { recursive: true, force: true })
  }
})

/** 脚本化的处理器：submits / polls 里按顺序给结果；记下每次调用。 */
function handler(script = {}) {
  const calls = { submit: 0, poll: 0, deliver: 0, cancel: 0, notify: [] }
  const h = {
    perChat: script.perChat || 1,
    quota: script.quota,
    prepare: async (j) => (script.prepare ? script.prepare(j) : { ready: true }),
    submit: async () => { calls.submit++; const s = (script.submits || []).shift() || { status: 'done', outputs: ['img'] }; if (s instanceof Error) throw s; return s },
    poll: async () => { calls.poll++; const s = (script.polls || []).shift() || { status: 'done', outputs: ['img'] }; if (s instanceof Error) throw s; return s },
    store: async (j, outputs) => ({ assets: outputs }),
    deliver: async () => { calls.deliver++; const s = (script.delivers || []).shift(); return s || { delivered: true } },
    cancel: async () => { calls.cancel++; return { ok: true, message: '服务那边取消了' } },
    notify: (j, ev, info) => calls.notify.push([ev, info]),
  }
  return { h, calls }
}

const mk = (s, h, o = {}) => {
  const r = createJobRunner({ storage: s, handlers: { image: h }, retryBaseMs: 0, pollMs: 0, ...o })
  runners.push(r)
  return r
}
const enq = (r, extra = {}) => r.enqueue({ kind: 'image', chatId: 'group:1', actorId: '7', input: { prompt: '猫' }, ...extra })

test('一路走完：排队 → 提交 → 画好 → 发出；每次尝试都记下来', async () => {
  const s = storage()
  const { h, calls } = handler()
  const r = mk(s, h)
  const j = enq(r)
  assert.equal(j.state, 'queued')
  await r.drain()
  const done = r.get(j.id)
  assert.equal(done.state, 'delivered')
  assert.deepEqual(done.output.assets, ['img'])
  assert.equal(calls.submit, 1)
  assert.equal(r.attempts(j.id)[0].billing, 'charged')
  assert.deepEqual(calls.notify.map((x) => x[0]), ['delivered'])
})

test('异步服务：提交后查进度，查到画好再发', async () => {
  const s = storage()
  const { h, calls } = handler({ submits: [{ status: 'running', providerTaskId: 'p-1' }], polls: [{ status: 'running' }, { status: 'done', outputs: ['x'] }] })
  const r = mk(s, h)
  const j = enq(r)
  await r.drain()
  assert.equal(r.get(j.id).state, 'delivered')
  assert.equal(r.get(j.id).providerTaskId, 'p-1')
  assert.equal(calls.poll, 2)
})

test('确定没执行的临时故障才重试；可能已被接收的不重发，标成不确定', async () => {
  const s = storage()
  const a = handler({ submits: [new ProviderError('transient', '连不上'), { status: 'done', outputs: ['ok'] }] })
  const r1 = mk(s, a.h)
  const j1 = enq(r1)
  await r1.drain()
  assert.equal(r1.get(j1.id).state, 'delivered')
  assert.deepEqual(r1.attempts(j1.id).map((x) => x.billing), ['none', 'charged'])

  const b = handler({ submits: [new ProviderError('unknown', '超时')] })
  const r2 = mk(s, b.h)
  const j2 = enq(r2)
  await r2.drain()
  assert.equal(r2.get(j2.id).state, 'unknown')
  assert.equal(b.calls.submit, 1, '没有盲目重发')
  assert.equal(b.calls.notify[0][0], 'unknown')
})

test('不支持的模式直接失败，不重试；确定没执行时额度退回', async () => {
  const s = storage()
  const quota = () => [{ scope: 'user:7', limit: 1 }]
  const { h, calls } = handler({ submits: [new ProviderError('unsupported', '不支持蒙版', { maybeCharged: false })], quota })
  const r = mk(s, h)
  const j = enq(r)
  await r.drain()
  assert.equal(r.get(j.id).state, 'failed')
  assert.equal(r.get(j.id).errorKind, 'unsupported')
  assert.equal(calls.submit, 1)
  assert.ok(enq(r), '没执行的那次不占额度')
})

test('额度：用完了就不能再登记，登记和预留在同一个事务里', async () => {
  const s = storage()
  const { h } = handler({ quota: () => [{ scope: 'user:7', limit: 2, message: '今天画够了' }] })
  const r = mk(s, h)
  enq(r)
  enq(r)
  assert.throws(() => enq(r), /今天画够了/)
  assert.equal(r.list().length, 2, '超额的那个没登记')
})

test('发送失败：停住等重发，重发时不重新生成', async () => {
  const s = storage()
  const { h, calls } = handler({ delivers: [{ delivered: false, error: '网关拒绝' }, { delivered: true }] })
  const r = mk(s, h)
  const j = enq(r)
  await r.drain()
  assert.equal(r.get(j.id).state, 'delivery_pending')
  assert.match(r.get(j.id).error, /网关拒绝/)
  await r.drain()
  assert.equal(calls.deliver, 1, '停住了，不会自己一直重发')
  assert.equal(r.resend(j.id).ok, true)
  await r.drain()
  assert.equal(r.get(j.id).state, 'delivered')
  assert.equal(calls.submit, 1, '没重新生成')
})

test('取消：只能取消自己的；没开始的直接取消；在画的请服务取消，画好了也不发', async () => {
  const s = storage()
  const { h, calls } = handler({ submits: [{ status: 'running', providerTaskId: 'p-9' }], polls: [{ status: 'done', outputs: ['late'] }] })
  const r = mk(s, h)
  const a = enq(r)
  assert.equal(r.cancel(a.id, { by: '8' }).ok, false, '别人取消不了')
  assert.equal(r.cancel(a.id, { by: '7' }).ok, true)
  assert.equal(r.get(a.id).state, 'canceled')

  const b = enq(r)
  await r.tick() // 提交，进入 running
  assert.equal(r.get(b.id).state, 'running')
  r.cancel(b.id, { by: '7' })
  await r.drain()
  assert.equal(r.get(b.id).state, 'canceled')
  assert.equal(calls.cancel, 1, '请服务取消了')
  assert.equal(calls.deliver, 0, '没发出去')
  assert.equal(r.cancel(b.id, { by: '7' }).ok, false, '已经取消的再取消会说明')
})

test('等输入：图片还没好就等，等太久就失败', async () => {
  const s = storage()
  let clock = 1000
  let ready = false
  const { h } = handler({ prepare: () => (ready ? { ready: true } : { wait: '图片还在下载' }) })
  const r = mk(s, h, { now: () => clock })
  const j = enq(r, { input: { prompt: 'x', waitUntil: 50_000 } })
  await r.tick()
  assert.equal(r.get(j.id).state, 'waiting_input')
  clock += 3000
  ready = true
  await r.drain()
  assert.equal(r.get(j.id).state, 'delivered')
  ready = false
  const k = enq(r, { input: { prompt: 'y', waitUntil: clock + 1000 } })
  await r.tick()
  clock += 5000
  await r.drain()
  assert.equal(r.get(k.id).state, 'failed')
})

test('重启恢复：提交到一半、没有服务任务 ID 的标成不确定；有 ID 的接着查', async () => {
  const s = storage()
  const { h, calls } = handler({ polls: [{ status: 'done', outputs: ['r'] }] })
  const r = mk(s, h)
  const a = enq(r)
  const b = enq(r, { chatId: 'group:2' })
  s.db.run("UPDATE jobs SET state = 'submitting', lease_owner = 'old', lease_until = 1 WHERE id = ?", a.id)
  s.db.run("INSERT INTO job_attempts(id, job_id, n, state, started_at) VALUES ('att_x', ?, 1, 'running', 1)", a.id)
  s.db.run("UPDATE jobs SET state = 'submitting', lease_owner = 'old', lease_until = 1 WHERE id = ?", b.id)
  s.db.run("INSERT INTO job_attempts(id, job_id, n, provider_task_id, state, started_at) VALUES ('att_y', ?, 1, 'p-5', 'running', 1)", b.id)
  const fresh = mk(s, h, { owner: 'new' })
  assert.deepEqual(fresh.recover(), { requeued: 0, unknown: 1, polling: 1, delivering: 0 })
  await fresh.drain()
  assert.equal(fresh.get(a.id).state, 'unknown')
  assert.equal(fresh.get(b.id).state, 'delivered')
  assert.equal(calls.submit, 0, '恢复时没有重新提交')
})

test('公平：同一个聊天同时只跑一个，别的聊天不用等', async () => {
  const s = storage()
  const { h } = handler({ submits: [{ status: 'running', providerTaskId: 'a' }, { status: 'running', providerTaskId: 'b' }], polls: [{ status: 'running' }, { status: 'running' }, { status: 'running' }] })
  const r = mk(s, h, { concurrency: 5 })
  const a1 = enq(r)
  const a2 = enq(r)
  const b1 = enq(r, { chatId: 'group:2' })
  await r.tick()
  assert.equal(r.get(a1.id).state, 'running')
  assert.equal(r.get(a2.id).state, 'queued', '同一个聊天的第二个等着')
  assert.equal(r.get(b1.id).state, 'running', '别的聊天照跑')
})

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const quotaState = (s, id) => s.db.get('SELECT state FROM quota_reservations WHERE job_id = ?', id)?.state
const oneQuota = () => [{ scope: 'user:7', limit: 1 }]

test('execution 保留旧签名，commit 原子保存 handler 数据，阶段结束后旧 guard 失效', async () => {
  const s = storage()
  const { h } = handler()
  const seen = []
  let prepareExecution, submitExecution
  h.prepare = async (j, execution) => {
    prepareExecution = execution
    assert.equal(execution.guard(), true)
    assert.equal(execution.shouldContinue, execution.guard)
    assert.throws(() => execution.commit(async () => {}), /同步/)
    execution.commit(() => s.db.run('UPDATE jobs SET profile_id = ? WHERE id = ?', 'frozen', j.id))
    assert.throws(() => execution.commit(() => {
      s.db.run('UPDATE jobs SET profile_id = ? WHERE id = ?', 'rollback', j.id)
      throw new Error('rollback')
    }), /rollback/)
    seen.push('prepare')
    return { ready: true }
  }
  h.submit = async (j, attempt, execution) => {
    assert.equal(j.profileId, 'frozen')
    assert.equal(attempt.n, 1)
    assert.equal(prepareExecution.guard(), false)
    submitExecution = execution
    seen.push('submit')
    return { status: 'done', outputs: ['original-output'] }
  }
  h.store = async (j, outputs, execution) => {
    assert.deepEqual(outputs, ['original-output'])
    assert.equal(submitExecution.guard(), false, '同一 submitting 状态的不同 handler 也要隔离')
    assert.throws(() => submitExecution.commit(() => {}), { name: 'AbortError' })
    assert.equal(execution.signal.aborted, false)
    seen.push('store')
    return { assets: outputs }
  }
  h.deliver = async (j, execution) => {
    assert.deepEqual(j.output.assets, ['original-output'])
    assert.equal(execution.guard(), true)
    seen.push('deliver')
    return { delivered: true }
  }
  h.notify = async (j, event, info, execution) => {
    assert.equal(event, 'delivered')
    assert.equal(j.state, 'delivered')
    assert.equal(execution.guard(), true)
    assert.equal(typeof info, 'object')
    seen.push('notify')
  }
  const r = mk(s, h)
  const j = enq(r)
  await r.drain()
  assert.deepEqual(seen, ['prepare', 'submit', 'store', 'deliver', 'notify'])
  assert.equal(submitExecution.signal.aborted, true)
  assert.equal(submitExecution.guard(), false)
  assert.equal(r.get(j.id).state, 'delivered')
})

test('running attempt 保持 finished_at=NULL，轮询不丢已知收费信息', async () => {
  const s = storage()
  const { h } = handler({
    quota: oneQuota,
    submits: [{ status: 'running', providerTaskId: 'paid', billing: 'charged' }],
    polls: [{ status: 'running' }, { status: 'done', outputs: ['x'] }],
  })
  const r = mk(s, h)
  const j = enq(r)
  await r.tick()
  const started = r.attempts(j.id)[0].startedAt
  await r.tick()
  assert.equal(r.attempts(j.id)[0].state, 'running')
  assert.equal(r.attempts(j.id)[0].finishedAt, null)
  assert.equal(r.attempts(j.id)[0].billing, 'charged')
  assert.equal(quotaState(s, j.id), 'used')
  await r.drain()
  assert.equal(r.attempts(j.id)[0].startedAt, started)
  assert.ok(r.attempts(j.id)[0].finishedAt >= started)
})

test('确定未执行的重试保留额度，取消 retry_wait 才释放，重试上限不多执行一次', async () => {
  const s = storage()
  const a = handler({ quota: oneQuota, submits: [new ProviderError('transient', 'offline')] })
  const r = mk(s, a.h)
  const j = enq(r)
  await r.tick()
  assert.equal(r.get(j.id).state, 'retry_wait')
  assert.equal(quotaState(s, j.id), 'held')
  assert.throws(() => enq(r), { code: 'QUOTA' })
  r.cancel(j.id, { by: '7' })
  assert.equal(quotaState(s, j.id), 'released')
  a.h.submit = async () => { a.calls.submit++; throw new ProviderError('transient', 'still offline') }
  const next = enq(r, { maxAttempts: 2 })
  await r.drain()
  assert.equal(a.calls.submit, 3)
  assert.equal(r.get(next.id).state, 'failed')
  assert.equal(quotaState(s, next.id), 'released')
  assert.deepEqual(r.attempts(next.id).map((a) => [a.state, a.billing]), [['failed', 'none'], ['failed', 'none']])
})

for (const [name, error, expected, billing] of [
  ['普通 Error', new Error('socket closed'), 'unknown', 'unknown'],
  ['可能收费的临时故障', new ProviderError('transient', 'accepted?', { maybeCharged: true }), 'unknown', 'unknown'],
  ['缺少计费证据的 retryable 错误', Object.assign(new Error('maybe'), { kind: 'transient', retryable: true }), 'unknown', 'unknown'],
  ['明确禁止重试', new ProviderError('transient', 'do not retry', { retryable: false }), 'failed', 'none'],
]) {
  test(name + '：不能盲目重提或退还不确定的额度', async () => {
    const s = storage()
    const { h, calls } = handler({ quota: oneQuota, submits: [error] })
    const r = mk(s, h)
    const j = enq(r)
    await r.drain()
    assert.equal(calls.submit, 1)
    assert.equal(r.get(j.id).state, expected)
    assert.equal(r.attempts(j.id)[0].billing, billing)
    assert.ok(r.attempts(j.id)[0].finishedAt)
    assert.equal(quotaState(s, j.id), billing === 'none' ? 'released' : 'held')
  })
}

test('prepare 失败无外部尝试，store 失败保留已完成 attempt 与已用额度', async () => {
  const s = storage()
  const first = handler({ quota: oneQuota, prepare: () => { throw new Error('local input failed') } })
  const r = mk(s, first.h)
  const a = enq(r)
  await r.drain()
  assert.equal(r.get(a.id).state, 'failed')
  assert.equal(first.calls.submit, 0)
  assert.deepEqual(r.attempts(a.id), [])
  assert.equal(quotaState(s, a.id), 'released')
  first.h.prepare = async () => ({ ready: true })
  first.h.store = async () => { throw new ProviderError('invalid', 'disk failed', { maybeCharged: false }) }
  const b = enq(r)
  await r.drain()
  assert.equal(r.get(b.id).state, 'failed')
  assert.equal(r.attempts(b.id)[0].state, 'done')
  assert.equal(r.attempts(b.id)[0].billing, 'charged')
  assert.equal(quotaState(s, b.id), 'used')
  assert.equal(first.calls.deliver, 0)
  assert.equal(first.calls.submit, 1)
  assert.throws(() => enq(r), { code: 'QUOTA' })
})

for (const billing of ['charged', 'unknown', 'none', 'free']) {
  test('服务明确失败时记录 billing=' + billing + '，不凭错误种类猜收费', async () => {
    const s = storage()
    const { h } = handler({ quota: oneQuota, submits: [{ status: 'failed', billing, error: { kind: 'invalid', message: 'provider rejected' } }] })
    const r = mk(s, h)
    const j = enq(r)
    await r.drain()
    assert.equal(r.get(j.id).state, 'failed')
    assert.equal(r.attempts(j.id)[0].billing, billing)
    assert.equal(quotaState(s, j.id), billing === 'charged' ? 'used' : billing === 'unknown' ? 'held' : 'released')
  })
}

test('轮询连续失败只结束当前 attempt，不重新提交，不释放不确定费用', async () => {
  const s = storage()
  const { h, calls } = handler({ quota: oneQuota, submits: [{ status: 'running', providerTaskId: 'remote-task' }] })
  h.poll = async () => { calls.poll++; throw new ProviderError('transient', 'query unavailable', { maybeCharged: false }) }
  const r = mk(s, h)
  const j = enq(r)
  await r.drain()
  assert.equal(calls.poll, 21)
  assert.equal(calls.submit, 1)
  assert.equal(r.get(j.id).state, 'unknown')
  assert.equal(r.attempts(j.id)[0].state, 'unknown')
  assert.ok(r.attempts(j.id)[0].finishedAt)
  assert.equal(quotaState(s, j.id), 'held')
})

test('deliver 抛错只停发送，batchId 与资产保留，人工补发不重新生成', async () => {
  const s = storage()
  const { h, calls } = handler({ quota: oneQuota })
  h.deliver = async (j, execution) => {
    calls.deliver++
    if (calls.deliver === 1) {
      execution.commit(() => s.db.run('UPDATE jobs SET output_json = ? WHERE id = ?', JSON.stringify({ ...j.output, deliveryBatchId: 'persistent-batch' }), j.id))
      throw new Error('delivery timeout')
    }
    assert.equal(j.output.deliveryBatchId, 'persistent-batch')
    return { delivered: true, batchId: j.output.deliveryBatchId }
  }
  const r = mk(s, h)
  const j = enq(r)
  await r.drain()
  const failed = r.get(j.id)
  assert.equal(failed.state, 'delivery_pending')
  assert.deepEqual(failed.output.assets, ['img'])
  assert.equal(failed.output.delivery.unknown, true)
  assert.match(failed.error, /delivery timeout/)
  assert.equal(r.attempts(j.id)[0].state, 'done')
  assert.equal(quotaState(s, j.id), 'used')
  await r.drain()
  assert.equal(calls.deliver, 1)
  assert.equal(r.resend(j.id).ok, true)
  await r.drain()
  assert.equal(calls.submit, 1)
  assert.equal(calls.deliver, 2)
  assert.equal(r.get(j.id).state, 'delivered')
  assert.equal(r.get(j.id).output.delivery.batchId, 'persistent-batch')
  assert.deepEqual(calls.notify.map((e) => e[0]), ['delivered'])
})

for (const flag of ['skipped', 'failed', 'unknown', 'canceled']) {
  test('delivery ' + flag + ' 即使伴随 delivered 也不能记已发，不触发 delivered 通知', async () => {
    const s = storage()
    const { h, calls } = handler({ delivers: [{ delivered: true, [flag]: true, batchId: 'batch', error: '结果保留' }] })
    const r = mk(s, h)
    const j = enq(r)
    await r.drain()
    assert.equal(r.get(j.id).state, flag === 'canceled' ? 'canceled' : 'delivery_pending')
    assert.equal(r.get(j.id).output.delivery[flag], true)
    assert.equal(r.get(j.id).output.delivery.delivered, false)
    assert.equal(r.get(j.id).output.deliveryBatchId, 'batch')
    assert.equal(calls.notify.some((e) => e[0] === 'delivered'), false)
    assert.equal(calls.submit, 1)
    assert.deepEqual(r.get(j.id).output.assets, ['img'])
  })
}

for (const asyncFailure of [false, true]) {
  test('通知' + (asyncFailure ? '异步拒绝' : '同步抛错') + '不会改变任务/attempt/额度或形成未处理 rejection', async () => {
    const s = storage()
    const messages = []
    const { h } = handler({ quota: oneQuota })
    h.notify = asyncFailure ? async () => { throw new Error('notify failed') } : () => { throw new Error('notify failed') }
    const r = mk(s, h, { log: { warn: (...args) => messages.push(args) } })
    const j = enq(r)
    await r.drain()
    await nextTurn()
    assert.equal(r.get(j.id).state, 'delivered')
    assert.equal(r.attempts(j.id)[0].state, 'done')
    assert.equal(quotaState(s, j.id), 'used')
    assert.equal(messages.length, 1)
  })
}

for (const phase of ['prepare', 'submit', 'poll', 'store', 'deliver']) {
  for (const rejects of [false, true]) {
    test('取消期间 ' + phase + (rejects ? ' 迟到抛错' : ' 迟到成功') + '都不能覆盖取消或发送结果', async () => {
      const s = storage()
      const { h, calls } = handler({ quota: oneQuota, ...(phase === 'poll' ? { submits: [{ status: 'running', providerTaskId: 'task' }] } : {}) })
      const r = mk(s, h)
      const other = mk(s, h)
      const entered = deferred()
      const gate = deferred()
      let sends = 0
      const results = { prepare: { ready: true }, submit: { status: 'done', outputs: ['late'] }, poll: { status: 'done', outputs: ['late'] }, store: { assets: ['late'] }, deliver: { delivered: true } }
      h[phase] = async (...args) => {
        const execution = args.at(-1)
        entered.resolve(execution)
        await gate.promise
        if (rejects) throw new Error('late failure')
        if (phase === 'deliver' && execution.guard()) sends++
        return results[phase]
      }
      const j = enq(r)
      if (phase === 'poll') await r.tick()
      const pending = r.tick()
      const execution = await entered.promise
      assert.equal(execution.guard(), true)
      assert.equal(r.cancel(j.id, { by: '7' }).ok, true)
      assert.equal(execution.signal.aborted, true)
      assert.equal(execution.guard(), false)
      assert.throws(() => execution.commit(() => {}), { name: 'AbortError' })
      await other.drain()
      const snapshot = { job: r.get(j.id), attempts: r.attempts(j.id), quota: quotaState(s, j.id) }
      gate.resolve()
      await pending
      assert.deepEqual({ job: r.get(j.id), attempts: r.attempts(j.id), quota: quotaState(s, j.id) }, snapshot)
      assert.equal(r.get(j.id).state, 'canceled')
      assert.equal(sends, 0)
      assert.equal(calls.notify.some((e) => ['delivered', 'failed', 'unknown'].includes(e[0])), false)
      assert.equal(quotaState(s, j.id), phase === 'prepare' ? 'released' : ['store', 'deliver'].includes(phase) ? 'used' : 'held')
    })
  }
}

test('epoch 变化后 delivery 的守卫拒绝实际发送并保留输出', async () => {
  const s = storage()
  const { h } = handler()
  const r = mk(s, h)
  const entered = deferred(), gate = deferred()
  let sends = 0
  h.deliver = async (j, execution) => {
    entered.resolve(execution)
    await gate.promise
    if (execution.shouldContinue()) sends++
    return { delivered: false, canceled: true }
  }
  const j = enq(r)
  const pending = r.tick()
  const execution = await entered.promise
  s.epochs.bump(j.chatId, 'new session')
  assert.equal(execution.guard(), false)
  assert.throws(() => execution.commit(() => {}), { name: 'AbortError' })
  gate.resolve()
  await pending
  assert.equal(sends, 0)
  assert.equal(r.get(j.id).state, 'canceled')
  assert.deepEqual(r.get(j.id).output.assets, ['img'])
})

test('stop 清掉已经安排的 kick，后来的 kick/tick 都不领取', async () => {
  const s = storage()
  const { h, calls } = handler()
  const r = mk(s, h)
  const j = enq(r)
  r.kick()
  r.stop()
  r.kick()
  await nextTurn()
  assert.equal(await r.tick(), 0)
  assert.equal(r.get(j.id).state, 'queued')
  assert.equal(calls.submit, 0)
})

for (const phase of ['prepare', 'submit', 'poll', 'store', 'deliver', 'notify']) {
  test('stop 在 ' + phase + ' 中传递 AbortSignal，迟到 handler 不能写回或开始发送', async () => {
    const s = storage()
    const { h, calls } = handler({ ...(phase === 'poll' ? { submits: [{ status: 'running', providerTaskId: 'task' }] } : {}) })
    const r = mk(s, h)
    const entered = deferred(), gate = deferred()
    let sideEffects = 0
    const results = { prepare: { ready: true }, submit: { status: 'done', outputs: ['late'] }, poll: { status: 'done', outputs: ['late'] }, store: { assets: ['late'] }, deliver: { delivered: true } }
    h[phase] = async (...args) => {
      const execution = args.at(-1)
      entered.resolve(execution)
      await gate.promise
      if (execution.guard()) sideEffects++
      return results[phase]
    }
    const j = enq(r)
    if (phase === 'poll') await r.tick()
    const pending = r.tick()
    const execution = await entered.promise
    r.stop()
    assert.equal(execution.signal.aborted, true)
    const snapshot = r.get(j.id)
    gate.resolve()
    await pending
    assert.equal(sideEffects, 0)
    assert.deepEqual(r.get(j.id), snapshot)
    assert.equal(await r.tick(), 0)
    if (!['deliver', 'notify'].includes(phase)) assert.equal(calls.deliver, 0)
  })
}

test('已知免费任务完成时保留 billing=free，生成额度仍记已使用', async () => {
  const s = storage()
  const { h } = handler({ quota: oneQuota, submits: [{ status: 'running', providerTaskId: 'free-task', billing: 'free' }] })
  const r = mk(s, h)
  const j = enq(r)
  await r.drain()
  assert.equal(r.get(j.id).state, 'delivered')
  assert.equal(r.attempts(j.id)[0].billing, 'free')
  assert.equal(quotaState(s, j.id), 'used')
})

test('同一个 runner 可以完成取消，不必等忽略 signal 的旧提交返回', async () => {
  const s = storage()
  const { h } = handler({ quota: oneQuota })
  const entered = deferred(), gate = deferred()
  h.submit = async () => { entered.resolve(); await gate.promise; return { status: 'done', outputs: ['late'] } }
  const r = mk(s, h, { concurrency: 1 })
  const j = enq(r)
  const pending = r.tick()
  await entered.promise
  r.cancel(j.id)
  await r.drain()
  assert.equal(r.get(j.id).state, 'canceled')
  const canceled = r.get(j.id)
  gate.resolve()
  await pending
  assert.deepEqual(r.get(j.id), canceled)
  assert.equal(quotaState(s, j.id), 'held')
})

test('恢复或取消缺失 attempt 的提交记录，不能凭空认定未收费并退额度', async () => {
  const s = storage()
  const { h } = handler({ quota: oneQuota })
  const r = mk(s, h)
  const j = enq(r)
  s.db.run("UPDATE jobs SET state = 'submitting' WHERE id = ?", j.id)
  r.recover()
  assert.equal(r.get(j.id).state, 'unknown')
  assert.equal(quotaState(s, j.id), 'held')
  h.quota = () => [{ scope: 'user:8', limit: 1 }]
  const another = enq(r, { actorId: '8' })
  s.db.run("UPDATE jobs SET state = 'submitting' WHERE id = ?", another.id)
  r.cancel(another.id)
  await r.drain()
  assert.equal(r.get(another.id).state, 'canceled')
  assert.equal(quotaState(s, another.id), 'held')
})

test('恢复安全重试时先修正 attempts，不能重复 n 或绕过 maxAttempts', async () => {
  const s = storage()
  const { h, calls } = handler({ quota: oneQuota })
  const r = mk(s, h)
  const j = enq(r, { maxAttempts: 1 })
  s.db.run("UPDATE jobs SET state = 'retry_wait' WHERE id = ?", j.id)
  s.db.run("INSERT INTO job_attempts(id, job_id, n, state, billing, started_at, finished_at) VALUES ('legacy', ?, 1, 'failed', 'none', 1, 2)", j.id)
  await r.drain()
  assert.equal(calls.submit, 0)
  assert.equal(r.get(j.id).state, 'failed')
  assert.equal(r.get(j.id).attempts, 1)
  assert.equal(r.attempts(j.id).length, 1)
  assert.equal(quotaState(s, j.id), 'released')
})

for (const action of ['cancel', 'stop']) {
  test('runner → 真实 outbox：首段发出后 ' + action + '，第二段异步解析完成也不得发送', async () => {
    const s = storage()
    const entered = deferred(), gate = deferred(), sent = []
    const outbox = createOutbox({
      storage: s,
      resolve: async (message) => {
        if (message[0].data.text === 'two') { entered.resolve(); await gate.promise }
        return message
      },
      send: async (chatId, message) => { sent.push(message[0].data.text); return { message_id: sent.length } },
    })
    const { h, calls } = handler()
    h.deliver = async (j, execution) => {
      const batchId = execution.commit(() => outbox.enqueue({
        batchId: 'job:' + j.id, chatId: j.chatId, epoch: j.epoch, requiresGuard: true,
        items: ['one', 'two'].map((text) => ({ kind: 'text', message: [{ type: 'text', data: { text } }] })),
      }))
      const result = await outbox.deliver(batchId, { shouldSend: execution.guard })
      return { delivered: result.delivered === 2, batchId, canceled: result.canceled > 0, unknown: result.unknown > 0 }
    }
    const r = mk(s, h)
    const j = enq(r)
    const pending = r.tick()
    await entered.promise
    if (action === 'cancel') r.cancel(j.id)
    else r.stop()
    gate.resolve()
    await pending
    assert.deepEqual(sent, ['one'])
    assert.deepEqual(outbox.rows('job:' + j.id).map((r) => r.state), ['delivered', 'canceled'])
    assert.equal(r.get(j.id).state, action === 'cancel' ? 'canceled' : 'delivery_pending')
    assert.equal(calls.notify.some((event) => event[0] === 'delivered'), false)
  })
}

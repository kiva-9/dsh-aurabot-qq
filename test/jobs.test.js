// 可恢复任务：状态推进、额度、重试、不确定结果不重发、发送失败只重发、取消、重启恢复、公平。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorage } from '../src/storage/index.js'
import { createJobRunner } from '../src/jobs/runner.js'
import { ProviderError } from '../src/providers/image/common.js'

const storage = () => createStorage({ file: ':memory:', filesDir: join(mkdtempSync(join(tmpdir(), 'aurabot-jobs-')), 'assets') })

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

const mk = (s, h, o = {}) => createJobRunner({ storage: s, handlers: { image: h }, retryBaseMs: 0, pollMs: 0, ...o })
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

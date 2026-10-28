// 使用真实 SQLite 文件、独立连接以及 worker_threads；服务端/QQ 仍为故障注入 handler。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { once } from 'node:events'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { createStorage } from '../src/storage/index.js'
import { createJobRunner, ACTIVE } from '../src/jobs/runner.js'

const deferred = () => {
  let resolve
  const promise = new Promise((yes) => { resolve = yes })
  return { promise, resolve }
}
const enqueue = (r, extra = {}) => r.enqueue({ kind: 'image', chatId: 'group:1', actorId: '7', input: { prompt: 'cat' }, ...extra })
const handler = (extra = {}) => ({
  perChat: 1,
  prepare: async () => ({ ready: true }),
  submit: async () => ({ status: 'done', outputs: ['image'] }),
  poll: async () => ({ status: 'done', outputs: ['image'] }),
  store: async (j, outputs) => ({ assets: outputs }),
  deliver: async () => ({ delivered: true }),
  cancel: async () => ({ ok: true, message: 'canceled' }),
  ...extra,
})
async function until(fn, message, timeout = 5000) {
  const end = Date.now() + timeout
  while (!fn()) {
    assert.ok(Date.now() < end, message)
    await sleep(5)
  }
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-jobs-recovery-'))
  const file = join(dir, 'jobs.sqlite')
  const stores = [
    createStorage({ file, filesDir: join(dir, 'assets') }),
    createStorage({ file, filesDir: join(dir, 'assets') }),
  ]
  const runners = []
  const cleanups = []
  const mk = (h, options = {}, index = 0) => {
    const r = createJobRunner({ storage: stores[index], handlers: { image: h }, retryBaseMs: 0, pollMs: 0, ...options })
    runners.push(r)
    return r
  }
  t.after(async () => {
    for (const r of runners) r.stop()
    for (const fn of cleanups) await fn()
    for (const s of stores) s.close()
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()))
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, file, stores, mk, cleanups }
}
const snapshot = (s, id) => ({
  job: s.db.get('SELECT * FROM jobs WHERE id = ?', id),
  attempts: s.db.all('SELECT * FROM job_attempts WHERE job_id = ? ORDER BY n', id),
  quota: s.db.all('SELECT * FROM quota_reservations WHERE job_id = ? ORDER BY id', id),
})

if (isMainThread) {
  test('recover 完全保留所有活租约；只有过期或不完整租约才可恢复', (t) => {
    const f = fixture(t)
    let clock = 1000
    const r = f.mk(handler(), { now: () => clock })
    const other = f.mk(handler(), { now: () => clock }, 1)
    const ids = ACTIVE.map((state, i) => {
      const j = enqueue(r, { chatId: 'group:' + i })
      f.stores[0].db.run('UPDATE jobs SET state = ?, lease_owner = ?, lease_until = ? WHERE id = ?', state, 'active-' + i, 2000, j.id)
      return j.id
    })
    const before = ids.map((id) => snapshot(f.stores[0], id))
    assert.deepEqual(other.recover(), { requeued: 0, unknown: 0, polling: 0, delivering: 0 })
    assert.deepEqual(ids.map((id) => snapshot(f.stores[0], id)), before)
    for (const lease of [{ owner: 'old', until: 1000 }, { owner: 'old', until: null }, { owner: null, until: 9000 }]) {
      const j = enqueue(r)
      f.stores[0].db.run("UPDATE jobs SET state = 'preparing', lease_owner = ?, lease_until = ? WHERE id = ?", lease.owner, lease.until, j.id)
      assert.equal(other.recover().requeued, 1)
      assert.equal(r.get(j.id).state, 'queued')
    }
    assert.deepEqual(ids.map((id) => snapshot(f.stores[0], id)), before)
  })

  for (const phase of ['prepare', 'submit', 'poll', 'store', 'deliver', 'cancel', 'notify']) {
    test(phase + ' 长时间 await 时续租，另一个连接 recover/tick 不能抢活任务', async (t) => {
      const f = fixture(t)
      let clock = 1000
      const entered = deferred(), gate = deferred()
      const h = handler()
      if (['poll', 'cancel'].includes(phase)) h.submit = async () => ({ status: 'running', providerTaskId: 'task' })
      const results = { prepare: { ready: true }, submit: { status: 'done', outputs: ['x'] }, poll: { status: 'done', outputs: ['x'] }, store: { assets: ['x'] }, deliver: { delivered: true }, cancel: { ok: true } }
      h[phase] = async (...args) => { entered.resolve(args.at(-1)); await gate.promise; return results[phase] }
      const r = f.mk(h, { now: () => clock, leaseMs: 120, concurrency: 1 })
      const other = f.mk(handler({ submit: () => assert.fail('不能重新提交') }), { now: () => clock, leaseMs: 120, concurrency: 1 }, 1)
      const j = enqueue(r)
      if (['poll', 'cancel'].includes(phase)) await r.tick()
      if (phase === 'cancel') r.cancel(j.id)
      const pending = r.tick()
      f.cleanups.push(async () => { gate.resolve(); await pending })
      const execution = await entered.promise
      const first = snapshot(f.stores[0], j.id).job
      for (let i = 0; i < 4; i++) {
        clock += 40
        await until(() => snapshot(f.stores[1], j.id).job.lease_until >= clock + 120, '续期没有推进')
      }
      assert.ok(clock > first.lease_until, '任务超过了原始租约期限')
      assert.equal(execution.signal.aborted, false)
      const before = snapshot(f.stores[0], j.id)
      assert.deepEqual(other.recover(), { requeued: 0, unknown: 0, polling: 0, delivering: 0 })
      assert.equal(await other.tick(), 0)
      assert.deepEqual(snapshot(f.stores[0], j.id), before)
      gate.resolve()
      await pending
    })
  }

  for (const explicitOwner of [undefined, 'same-configured-owner']) {
    test('同进程' + (explicitOwner ? '相同 owner 配置' : '默认 owner') + '仍有不同 worker token', async (t) => {
      const f = fixture(t)
      const entered = [deferred(), deferred()], gate = deferred()
      const opts = { concurrency: 2, ...(explicitOwner ? { owner: explicitOwner } : {}) }
      const runners = [0, 1].map((i) => f.mk(handler({
        prepare: async (j, execution) => { entered[i].resolve(execution); await gate.promise; return { ready: true } },
      }), opts, i))
      const jobs = [enqueue(runners[0]), enqueue(runners[0], { chatId: 'group:2' })]
      // 第一个 worker 的本地并发先限制为一个，通过第二条任务的 not_before 分批开放。
      f.stores[0].db.run('UPDATE jobs SET not_before = ? WHERE id = ?', 9e15, jobs[1].id)
      const first = runners[0].tick()
      const x = await entered[0].promise
      f.stores[0].db.run('UPDATE jobs SET not_before = 0 WHERE id = ?', jobs[1].id)
      const second = runners[1].tick()
      f.cleanups.push(async () => { gate.resolve(); await Promise.all([first, second]) })
      const y = await entered[1].promise
      assert.notEqual(x.workerToken, y.workerToken)
      assert.notEqual(x.leaseToken, y.leaseToken)
      gate.resolve()
      await Promise.all([first, second])
    })
  }

  for (const phase of ['prepare', 'poll', 'deliver', 'cancel']) {
    for (const rejects of [false, true]) {
      test('过期 ' + phase + (rejects ? ' 抛错' : ' 成功') + '不能覆盖新 owner 或释放新租约', async (t) => {
        const f = fixture(t)
        let clock = 1000
        const oldEntered = deferred(), oldGate = deferred(), newEntered = deferred(), newGate = deferred()
        const result = { prepare: { ready: true }, poll: { status: 'done', outputs: ['new'] }, deliver: { delivered: true }, cancel: { ok: true, message: 'new cancel' } }
        const h1 = handler({
          quota: () => [{ scope: 'user:7', limit: 5 }],
          ...(phase === 'poll' || phase === 'cancel' ? { submit: async () => ({ status: 'running', providerTaskId: 'task' }) } : {}),
          [phase]: async (...args) => {
            oldEntered.resolve(args.at(-1))
            await oldGate.promise
            if (rejects) throw new Error('old failure')
            return result[phase]
          },
        })
        const h2 = handler({
          [phase]: async (...args) => { newEntered.resolve(args.at(-1)); await newGate.promise; return result[phase] },
        })
        const opts = { now: () => clock, leaseMs: 1000, owner: 'same-owner' }
        const old = f.mk(h1, opts)
        const fresh = f.mk(h2, opts, 1)
        const j = enqueue(old)
        if (phase === 'poll' || phase === 'cancel') await old.tick()
        if (phase === 'cancel') old.cancel(j.id)
        const previous = old.tick()
        const x = await oldEntered.promise
        clock += 1001
        fresh.recover()
        if (phase === 'deliver') assert.equal(fresh.resend(j.id).ok, true)
        const current = fresh.tick()
        f.cleanups.push(async () => { oldGate.resolve(); newGate.resolve(); await Promise.all([previous, current]) })
        const y = await newEntered.promise
        assert.notEqual(x.leaseToken, y.leaseToken)
        assert.equal(x.guard(), false)
        assert.throws(() => x.commit(() => f.stores[0].db.run("UPDATE jobs SET error = 'stale' WHERE id = ?", j.id)), { name: 'AbortError' })
        const before = snapshot(f.stores[1], j.id)
        oldGate.resolve()
        await previous
        assert.deepEqual(snapshot(f.stores[1], j.id), before)
        assert.equal(y.guard(), true, '旧 finally 没有释放新领取')
        newGate.resolve()
        await current
        assert.equal(fresh.get(j.id).state, phase === 'cancel' ? 'canceled' : 'delivered')
      })
    }
  }

  for (const phase of ['submit', 'store']) {
    test('过期 ' + phase + ' 无服务 ID 时只记 unknown，不重复收费，迟到成功也不能恢复', async (t) => {
      const f = fixture(t)
      let clock = 1000
      const entered = deferred(), gate = deferred()
      let lateSends = 0, newSubmits = 0
      const old = f.mk(handler({
        quota: () => [{ scope: 'user:7', limit: 1 }],
        [phase]: async (...args) => {
          entered.resolve(args.at(-1))
          await gate.promise
          return phase === 'submit' ? { status: 'done', outputs: ['late'] } : { assets: ['late'] }
        },
        deliver: async () => { lateSends++; return { delivered: true } },
      }), { now: () => clock, leaseMs: 1000 })
      const fresh = f.mk(handler({ submit: async () => { newSubmits++; return { status: 'done', outputs: ['duplicate'] } } }), { now: () => clock }, 1)
      const j = enqueue(old)
      const pending = old.tick()
      f.cleanups.push(async () => { gate.resolve(); await pending })
      await entered.promise
      clock += 1001
      assert.equal(fresh.recover().unknown, 1)
      const before = snapshot(f.stores[1], j.id)
      gate.resolve()
      await pending
      fresh.recover()
      await fresh.drain()
      assert.deepEqual(snapshot(f.stores[1], j.id), before)
      assert.equal(newSubmits, 0)
      assert.equal(lateSends, 0)
      assert.equal(before.attempts[0].state, phase === 'submit' ? 'unknown' : 'done')
      assert.equal(before.quota[0].state, phase === 'submit' ? 'held' : 'used')
    })
  }

  test('recover 使用 jobs 或 attempt 中的服务 ID；不完整提交/收费记录绝不重新 submit', async (t) => {
    const f = fixture(t)
    let submits = 0, polls = 0
    const h = handler({ submit: async () => { submits++; return { status: 'done', outputs: [] } }, poll: async () => { polls++; return { status: 'done', outputs: ['recovered'] } } })
    const r = f.mk(h, { now: () => 1000 })
    const cases = [
      { state: 'submitting', jobId: 'job-task', atId: null },
      { state: 'submitting', jobId: null, atId: 'attempt-task' },
      { state: 'preparing', jobId: null, atId: null },
      { state: 'retry_wait', jobId: null, atId: null },
      { state: 'queued', jobId: null, atId: null },
      { state: 'running', jobId: null, atId: null },
    ]
    const jobs = cases.map((c, i) => {
      const j = enqueue(r, { chatId: 'group:' + i })
      f.stores[0].db.run('UPDATE jobs SET state = ?, provider_task_id = ?, lease_owner = ?, lease_until = ? WHERE id = ?', c.state, c.jobId, 'dead', 1000, j.id)
      f.stores[0].db.run("INSERT INTO job_attempts(id, job_id, n, state, billing, provider_task_id, started_at, finished_at) VALUES (?, ?, 1, 'running', 'unknown', ?, 1, 2)", 'attempt-' + i, j.id, c.atId)
      return j
    })
    const fresh = f.mk(h, { now: () => 1000 }, 1)
    assert.deepEqual(fresh.recover(), { requeued: 0, unknown: 4, polling: 2, delivering: 0 })
    for (const j of jobs.slice(0, 2)) {
      assert.equal(fresh.attempts(j.id)[0].finishedAt, null)
      assert.equal(fresh.get(j.id).attempts, 1)
    }
    await fresh.drain()
    fresh.recover()
    await fresh.drain()
    assert.equal(submits, 0)
    assert.equal(polls, 2)
    assert.deepEqual(jobs.map((j) => fresh.get(j.id).state), ['delivered', 'delivered', 'unknown', 'unknown', 'unknown', 'unknown'])
  })

  test('中断 delivery 只允许人工重发；generated 自动发送也绝不重新生成', async (t) => {
    const f = fixture(t)
    let submits = 0, delivers = 0
    const r = f.mk(handler({
      submit: async () => { submits++; throw new Error('must not submit') },
      deliver: async (j) => { delivers++; assert.deepEqual(j.output.assets, ['saved']); return { delivered: true, batchId: j.output.deliveryBatchId } },
    }), { now: () => 1000 })
    const generated = enqueue(r), sending = enqueue(r, { chatId: 'group:2' })
    for (const [j, state] of [[generated, 'generated'], [sending, 'delivery_pending']]) {
      f.stores[0].db.run('UPDATE jobs SET state = ?, output_json = ?, lease_owner = ?, lease_until = ? WHERE id = ?',
        state, JSON.stringify({ assets: ['saved'], deliveryBatchId: 'persisted-' + j.id }), 'dead', 1000, j.id)
    }
    r.recover()
    await r.drain()
    assert.equal(r.get(generated.id).state, 'delivered')
    assert.equal(r.get(sending.id).state, 'delivery_pending')
    assert.equal(r.get(sending.id).output.delivery.unknown, true)
    assert.equal(delivers, 1)
    r.recover()
    await r.drain()
    assert.equal(delivers, 1)
    r.resend(sending.id)
    await r.drain()
    assert.equal(delivers, 2)
    assert.equal(submits, 0)
  })

  test('远端 worker 取消会使旧 signal 在续租时 abort，迟到结果不能写回', async (t) => {
    const f = fixture(t)
    const entered = deferred(), gate = deferred()
    const old = f.mk(handler({ submit: async (...args) => { entered.resolve(args.at(-1)); await gate.promise; return { status: 'done', outputs: ['late'] } } }), { leaseMs: 120 })
    const fresh = f.mk(handler(), {}, 1)
    const j = enqueue(old)
    const pending = old.tick()
    f.cleanups.push(async () => { gate.resolve(); await pending })
    const execution = await entered.promise
    fresh.cancel(j.id)
    await fresh.drain()
    await until(() => execution.signal.aborted, '远端取消没有传到 signal')
    const before = snapshot(f.stores[1], j.id)
    gate.resolve()
    await pending
    assert.deepEqual(snapshot(f.stores[1], j.id), before)
    assert.equal(fresh.get(j.id).state, 'canceled')
  })

  test('租约续期数据库故障中止 handler，不能继续生成或发送', async (t) => {
    const f = fixture(t)
    const s = f.stores[0]
    const run = s.db.run
    const entered = deferred(), gate = deferred()
    let submits = 0
    const old = f.mk(handler({
      prepare: async (j, execution) => { entered.resolve(execution); await gate.promise; return { ready: true } },
      submit: async () => { submits++; return { status: 'done', outputs: ['bad'] } },
    }), { leaseMs: 120 })
    const j = enqueue(old)
    const pending = old.tick()
    f.cleanups.push(async () => { s.db.run = run; gate.resolve(); await pending })
    const execution = await entered.promise
    s.db.run = (sql, ...args) => {
      if (sql.startsWith('UPDATE jobs SET lease_until = ?')) throw new Error('injected write failure')
      return run(sql, ...args)
    }
    await until(() => execution.signal.aborted, '续期失败没有中止')
    gate.resolve()
    await pending
    assert.equal(submits, 0)
    assert.equal(old.get(j.id).state, 'preparing')
  })

  test('跨连接公平顺序持久化：60 条旧聊天积压后，两个新聊天均在前三次获得服务', async (t) => {
    const f = fixture(t)
    const served = []
    const h = handler({ submit: async (j) => { served.push(j.chatId); return { status: 'done', outputs: ['x'] } } })
    const a = f.mk(h, { concurrency: 1, now: () => 1000 })
    const b = f.mk(h, { concurrency: 1, now: () => 1000 }, 1)
    for (let i = 0; i < 60; i++) enqueue(a)
    enqueue(a, { chatId: 'group:2' })
    enqueue(a, { chatId: 'group:3' })
    await a.tick()
    await b.tick()
    await a.tick()
    assert.deepEqual(served, ['group:1', 'group:2', 'group:3'])
  })

  test('waiting_input 也受跨 worker perChat 限制，不能越过正在生成的同聊天任务', async (t) => {
    const f = fixture(t)
    let clock = 1000
    const a = f.mk(handler({ submit: async () => ({ status: 'running', providerTaskId: 'a' }) }), { now: () => clock, pollMs: 10000 })
    const running = enqueue(a)
    await a.tick()
    for (let i = 0; i < 60; i++) {
      const j = enqueue(a)
      f.stores[0].db.run("UPDATE jobs SET state = 'waiting_input' WHERE id = ?", j.id)
    }
    const other = enqueue(a, { chatId: 'group:2' })
    const b = f.mk(handler(), { now: () => clock, concurrency: 5 }, 1)
    await b.tick()
    assert.equal(b.get(other.id).state, 'delivered')
    assert.equal(b.get(running.id).state, 'running')
    assert.equal(b.list({ states: ['waiting_input'], limit: 100 }).length, 60)
  })

  test('4 个真实 worker 同时争抢 SQLite：共享并发=2、perChat=1、公平且每个任务只提交一次', { timeout: 15000 }, async (t) => {
    const f = fixture(t)
    const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 256)
    const stats = new Int32Array(shared)
    const r = f.mk(handler())
    const jobs = []
    for (let i = 0; i < 60; i++) jobs.push(enqueue(r, { input: { seq: i, bucket: 0 } }))
    jobs.push(enqueue(r, { chatId: 'group:2', input: { seq: 60, bucket: 1 } }))
    jobs.push(enqueue(r, { chatId: 'group:3', input: { seq: 61, bucket: 2 } }))
    const workers = []
    f.cleanups.push(async () => {
      Atomics.store(stats, 0, 1); Atomics.notify(stats, 0)
      Atomics.store(stats, 2, 1); Atomics.notify(stats, 2)
      await Promise.all(workers.map((w) => w.terminate()))
    })
    for (let i = 0; i < 4; i++) {
      const w = new Worker(new URL(import.meta.url), { workerData: { file: f.file, filesDir: join(f.dir, 'assets'), shared } })
      workers.push(w)
      const [ready] = await once(w, 'message')
      assert.equal(ready.type, 'ready')
    }
    const command = (w, type) => {
      const response = once(w, 'message').then(([m]) => { assert.equal(m.type, 'done', m.error); return m.count })
      w.postMessage(type)
      return response
    }
    const round = workers.map((w) => command(w, 'tick'))
    await until(() => Atomics.load(stats, 1) === 4, 'worker 尚未全部到达并发起跑屏障')
    Atomics.store(stats, 2, 1); Atomics.notify(stats, 2)
    await until(() => Atomics.load(stats, 3) === 2, '没有实质同时推进两个任务')
    assert.equal(Atomics.load(stats, 4), 2)
    assert.equal(Atomics.load(stats, 5), 0, '同聊天没有同时 prepare')
    const leased = f.stores[0].db.all('SELECT chat_id, lease_owner FROM jobs WHERE lease_owner IS NOT NULL')
    assert.equal(leased.length, 2)
    assert.equal(new Set(leased.map((j) => j.chat_id)).size, 2)
    assert.equal(new Set(leased.map((j) => j.lease_owner)).size, 2)
    assert.ok(leased.some((j) => j.chat_id === 'group:2'), '第 61 条聊天没有被积压饿死')
    Atomics.store(stats, 0, 1); Atomics.notify(stats, 0)
    await Promise.all(round)
    // 第二轮后第三个聊天必然获得服务；随后各 worker 并发 drain 剩余任务。
    await Promise.all(workers.map((w) => command(w, 'tick')))
    assert.equal(r.get(jobs[61].id).state, 'delivered')
    await Promise.all(workers.map((w) => command(w, 'drain')))
    assert.equal(Atomics.load(stats, 5), 0)
    assert.ok(Atomics.load(stats, 4) <= 2)
    for (let i = 0; i < jobs.length; i++) {
      assert.equal(Atomics.load(stats, 16 + i), 1, '外部 submit 次数 ' + i)
      assert.equal(r.get(jobs[i].id).state, 'delivered')
      assert.equal(r.attempts(jobs[i].id).length, 1)
    }
  })
} else {
  const s = createStorage({ file: workerData.file, filesDir: workerData.filesDir })
  const stats = new Int32Array(workerData.shared)
  const r = createJobRunner({
    storage: s, concurrency: 2, leaseMs: 10_000, pollMs: 0,
    handlers: { image: handler({
      prepare: async (j) => {
        const active = Atomics.add(stats, 3, 1) + 1
        let previous = Atomics.load(stats, 4)
        while (active > previous) {
          const actual = Atomics.compareExchange(stats, 4, previous, active)
          if (actual === previous) break
          previous = actual
        }
        if (Atomics.add(stats, 6 + j.input.bucket, 1) !== 0) Atomics.add(stats, 5, 1)
        try { await Atomics.waitAsync(stats, 0, 0).value }
        finally { Atomics.sub(stats, 3, 1); Atomics.sub(stats, 6 + j.input.bucket, 1) }
        return { ready: true }
      },
      submit: async (j) => {
        Atomics.add(stats, 16 + j.input.seq, 1)
        return { status: 'done', outputs: [j.id] }
      },
    }) },
  })
  parentPort.on('message', async (type) => {
    try {
      Atomics.add(stats, 1, 1)
      Atomics.wait(stats, 2, 0)
      const count = type === 'drain' ? await r.drain(100) : await r.tick()
      parentPort.postMessage({ type: 'done', count })
    } catch (error) {
      parentPort.postMessage({ type: 'error', error: error.stack })
    }
  })
  parentPort.postMessage({ type: 'ready' })
}

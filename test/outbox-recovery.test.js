import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createStorage } from '../src/storage/index.js'
import { createOutbox } from '../src/delivery/outbox.js'

const text = (value, extra = {}) => ({ kind: 'text', message: [{ type: 'text', data: { text: value } }], ...extra })
const failure = (outcome) => Object.assign(new Error(String(outcome)), { outcome })
const noWait = async () => {}
const gate = () => {
  let release
  const promise = new Promise((r) => { release = r })
  return { promise, release }
}

function fixture(t, persistent = false) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-outbox-recovery-'))
  const options = { file: persistent ? join(dir, 'outbox.db') : ':memory:', filesDir: join(dir, 'assets') }
  const cleanups = []
  const open = () => {
    const storage = createStorage(options)
    cleanups.push(() => storage.close())
    return storage
  }
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup()
    // dir 是本测试刚用 mkdtemp 创建的绝对临时目录。
    rmSync(dir, { recursive: true, force: true })
  })
  return { options, open, storage: open(), cleanups }
}

test('稳定 batchId 跨连接、重开数据库幂等；不同内容拒绝且不改原记录', async (t) => {
  const f = fixture(t, true)
  let sent = 0
  const send = async () => ({ message_id: ++sent })
  const ob = createOutbox({ storage: f.storage, send })
  const input = { batchId: 'image:job-1', chatId: 'group:1', requestId: 'request-1', items: [text('a'), text('b')] }
  const batchId = ob.enqueue(input)
  const ids = ob.rows(batchId).map((r) => r.id)
  await ob.deliver(batchId)
  f.storage.close()
  const reopened = f.open()
  const next = createOutbox({ storage: reopened, send })
  reopened.epochs.bump(input.chatId, '换人设')
  assert.equal(next.enqueue(input), batchId, '省略 epoch 的重复登记沿用原代次')
  assert.deepEqual(next.rows(batchId).map((r) => r.id), ids)
  assert.deepEqual(next.rows(batchId).map((r) => r.idempotencyKey), [`${batchId}:0`, `${batchId}:1`])
  assert.equal((await next.deliver(batchId)).delivered, 2)
  assert.equal(sent, 2)
  const before = next.rows(batchId)
  for (const changed of [
    { chatId: 'group:2' }, { requestId: 'request-2' }, { epoch: 1 },
    { items: [text('a')] }, { items: [text('a'), text('c')] },
    { items: [text('a'), text('b', { force: true })] },
  ]) assert.throws(() => next.enqueue({ ...input, ...changed }), { code: 'OUTBOX_BATCH_CONFLICT' })
  assert.deepEqual(next.rows(batchId), before)
})

test('登记半批发生数据库故障会整批回滚，重试登记仍只有一批', (t) => {
  const { storage } = fixture(t)
  const ob = createOutbox({ storage, send: async () => ({}) })
  const input = { batchId: 'image:atomic', chatId: 'group:1', items: [text('a'), text('b')] }
  const run = storage.db.run
  let inserts = 0
  storage.db.run = (sql, ...args) => {
    if (sql.startsWith('INSERT INTO outbox') && ++inserts === 2) throw new Error('disk full')
    return run(sql, ...args)
  }
  assert.throws(() => ob.enqueue(input), /disk full/)
  storage.db.run = run
  assert.equal(ob.summary(input.batchId).total, 0)
  assert.equal(ob.enqueue(input), input.batchId)
  assert.equal(ob.summary(input.batchId).total, 2)
})

test('partial 显式重试跨重启只补 not_sent/rejected/skipped，保留成功和 unknown 段', async (t) => {
  const f = fixture(t, true)
  const calls = []
  let retrying = false
  const send = async (_chatId, message, info) => {
    const value = message[0].data.text
    calls.push(value)
    assert.equal(info.idempotencyKey, `${info.batchId}:${info.seq}`)
    if (!retrying) {
      if (value === 'b') throw failure('not_sent')
      if (value === 'c') throw failure('rejected')
      if (value === 'd') throw failure('unknown')
      if (value === 'f') return null
    }
    return { message_id: value }
  }
  const ob = createOutbox({ storage: f.storage, send, retries: 0 })
  const b = ob.enqueue({ batchId: 'image:partial', chatId: 'group:1', requiresGuard: true, items: 'abcdef'.split('').map((v) => text(v)) })
  const guard = (r) => r.seq !== 4
  const first = await ob.deliver(b, { shouldSend: guard })
  assert.deepEqual([first.delivered, first.failed, first.unknown, first.canceled, first.skipped], [1, 2, 1, 1, 1])
  const ids = ob.rows(b).map((r) => r.id)
  f.storage.close()
  retrying = true
  const next = createOutbox({ storage: f.open(), send })
  await next.deliver(b, { shouldSend: guard })
  await next.recover({ shouldSend: guard })
  assert.deepEqual(calls, ['a', 'b', 'c', 'd', 'f'], '普通发送和恢复不重置终态')
  const result = await next.retry(b, { shouldSend: guard })
  assert.deepEqual(calls, ['a', 'b', 'c', 'd', 'f', 'b', 'c', 'f'])
  assert.deepEqual(next.rows(b).map((r) => r.id), ids)
  assert.deepEqual(next.rows(b).map((r) => r.attempts), [1, 2, 2, 1, 0, 2])
  assert.deepEqual(result.messageIds, ['a', 'b', 'c', 'f'])
  assert.equal(result.delivered, 4)
  assert.equal(result.unknown, 1)
  assert.equal(result.canceled, 1)
  await next.retry(b, { shouldSend: guard })
  assert.equal(calls.length, 8)
})

test('未识别 outcome 和裸异常都按 unknown，旧 failed 无结果依据不自动补发', async (t) => {
  const { storage } = fixture(t)
  let calls = 0
  const errors = [failure('unexpected'), new Error('lost receipt'), null]
  const ob = createOutbox({ storage, sleep: noWait, send: async () => { throw errors[calls++] } })
  const b = ob.enqueue({ chatId: 'group:1', items: [text('a'), text('b'), text('c'), text('legacy')] })
  storage.db.run("UPDATE outbox SET state = 'failed', last_error = 'not_sent' WHERE batch_id = ? AND seq = 3", b)
  await ob.deliver(b)
  const result = await ob.retry(b)
  assert.equal(calls, 3)
  assert.equal(result.unknown, 3)
  assert.equal(result.failed, 1, '错误文案不能证明发送结果')
  assert.deepEqual(ob.rows(b).slice(0, 3).map((r) => r.outcome), ['unknown', 'unknown', 'unknown'])
})

test('试运行 skipped 不计 delivered，只有显式 retry 才补发', async (t) => {
  const { storage } = fixture(t)
  let dryRun = true
  let calls = 0
  const ob = createOutbox({ storage, send: async () => { calls++; return dryRun ? null : { message_id: 42 } } })
  const b = ob.enqueue({ batchId: 'image:dry-run', chatId: 'group:1', items: [text('a')] })
  const first = await ob.deliver(b)
  assert.equal(first.delivered, 0)
  assert.equal(first.skipped, 1)
  dryRun = false
  await ob.deliver(b)
  await ob.recover()
  assert.equal(calls, 1)
  assert.equal((await ob.retry(b)).delivered, 1)
  assert.equal(calls, 2)
})

test('enqueue 后崩溃的 guarded 批次，恢复和无 guard 调用不能绕过检查', async (t) => {
  const f = fixture(t, true)
  let clock = 1_000_000
  let calls = 0
  const send = async () => { calls++; return {} }
  const ob = createOutbox({ storage: f.storage, send, now: () => clock })
  const input = { batchId: 'image:guarded', chatId: 'group:1', items: [text('a')] }
  const b = ob.enqueue({ ...input, requiresGuard: true })
  f.storage.close()
  const next = createOutbox({ storage: f.open(), send, now: () => clock })
  next.enqueue(input)
  clock += 1_000_000
  assert.deepEqual(await next.recover(), { stuck: 0, stale: 0, resumed: 0 })
  assert.equal((await next.deliver(b)).pending, 1)
  assert.equal((await next.retry(b)).pending, 1)
  assert.equal(calls, 0)
  const result = await next.deliver(b, { shouldSend: async () => false })
  assert.equal(result.canceled, 1)
  assert.equal(calls, 0)
})

for (const change of ['epoch', 'guard', 'cancel']) {
  test(`not_sent 重试退避期间 ${change} 失效，下一次发送前重新检查`, async (t) => {
    const { storage } = fixture(t)
    let allowed = true
    let calls = 0
    let checks = 0
    const ob = createOutbox({
      storage,
      send: async () => { calls++; throw failure('not_sent') },
      sleep: async () => {
        if (change === 'epoch') storage.epochs.bump('group:1')
        else if (change === 'guard') allowed = false
        else ob.cancelPending('group:1')
      },
    })
    const b = ob.enqueue({ chatId: 'group:1', items: [text('a', { force: true })] })
    const result = await ob.deliver(b, { shouldSend: () => { checks++; return allowed } })
    assert.equal(calls, 1)
    assert.equal(result.canceled, 1)
    assert.equal(ob.rows(b)[0].attempts, 1)
    if (change === 'guard') assert.equal(checks, 2)
  })
}

for (const stage of ['resolve', 'guard']) {
  test(`${stage} await 期间 epoch 改变，即使检查返回 true 也不发送`, async (t) => {
    const { storage } = fixture(t)
    const entered = gate()
    const blocked = gate()
    let calls = 0
    const pause = async () => { entered.release(); await blocked.promise }
    const ob = createOutbox({ storage, send: async () => { calls++; return {} }, resolve: async (m) => { if (stage === 'resolve') await pause(); return m } })
    const b = ob.enqueue({ chatId: 'group:1', items: [text('a')] })
    const work = ob.deliver(b, { shouldSend: async () => { if (stage === 'guard') await pause(); return true } })
    await entered.promise
    storage.epochs.bump('group:1')
    blocked.release()
    assert.equal((await work).canceled, 1)
    assert.equal(calls, 0)
    assert.equal(ob.rows(b)[0].attempts, 0)
  })
}

test('每段独立检查 guard；第一段成功不能放行后来取消的段', async (t) => {
  const { storage } = fixture(t)
  let allowed = true
  const checked = []
  const ob = createOutbox({ storage, send: async () => { allowed = false; return { message_id: 1 } } })
  const b = ob.enqueue({ chatId: 'group:1', items: [text('a'), text('b'), text('c')] })
  const result = await ob.deliver(b, { shouldSend: (r) => { checked.push([r.batchId, r.seq]); return allowed } })
  assert.deepEqual(checked, [[b, 0], [b, 1], [b, 2]])
  assert.equal(result.delivered, 1)
  assert.equal(result.canceled, 2)
})

test('段间等待被 cancelPending 取消后，不使用旧 rows 快照继续发', async (t) => {
  const { storage } = fixture(t)
  const calls = []
  const ob = createOutbox({
    storage, send: async (_c, m) => { calls.push(m[0].data.text); return {} },
    sleep: async () => { assert.equal(ob.cancelPending('group:1'), 2) },
  })
  const b = ob.enqueue({ chatId: 'group:1', items: [text('a'), text('b', { delayMs: 1 }), text('c')] })
  const result = await ob.deliver(b)
  assert.deepEqual(calls, ['a'])
  assert.equal(result.canceled, 2)
})

for (const stage of ['resolve', 'guard']) {
  test(`${stage} 抛错明确未发送，可以显式重试`, async (t) => {
    const { storage } = fixture(t)
    let broken = true
    let calls = 0
    const ob = createOutbox({
      storage, send: async () => { calls++; return {} },
      resolve: async (m) => { if (broken && stage === 'resolve') throw new Error('missing asset'); return m },
    })
    const shouldSend = async () => { if (broken && stage === 'guard') throw new Error('job lookup failed'); return true }
    const b = ob.enqueue({ chatId: 'group:1', items: [text('a')] })
    assert.equal((await ob.deliver(b, { shouldSend })).failed, 1)
    assert.equal(calls, 0)
    assert.equal(ob.rows(b)[0].outcome, 'not_sent')
    assert.equal(ob.rows(b)[0].attempts, 0)
    broken = false
    assert.equal((await ob.retry(b, { shouldSend })).delivered, 1)
    assert.equal(calls, 1)
  })
}

for (const stage of ['resolve', 'send', 'delay', 'retry']) {
  test(`独立 SQLite 连接在 ${stage} 期间不能发送或恢复活 worker 的批次`, async (t) => {
    const f = fixture(t, true)
    const entered = gate()
    const blocked = gate()
    const calls = []
    let clock = 1_000_000
    let firstCall = true
    const pause = async () => { entered.release(); await blocked.promise }
    const active = createOutbox({
      storage: f.storage, now: () => clock,
      resolve: async (m) => { if (stage === 'resolve') await pause(); return m },
      send: async (_c, m) => {
        calls.push(m[0].data.text)
        if (stage === 'send') await pause()
        if (stage === 'retry' && firstCall) { firstCall = false; throw failure('not_sent') }
        return { message_id: calls.length }
      },
      sleep: pause,
    })
    const other = createOutbox({ storage: f.open(), now: () => clock, send: async () => assert.fail('另一个 worker 抢发了') })
    const b = active.enqueue({ chatId: 'group:1', items: [text('a'), text('b', { delayMs: stage === 'delay' ? 1 : 0 })] })
    const work = active.deliver(b)
    await entered.promise
    clock += 1_000_000
    const before = other.rows(b)
    await other.deliver(b)
    await other.retry(b)
    assert.deepEqual(await active.recover(), { stuck: 0, stale: 0, resumed: 0 })
    assert.deepEqual(await other.recover(), { stuck: 0, stale: 0, resumed: 0 })
    assert.deepEqual(other.rows(b), before, '恢复不能连带取消活批次里的老 pending')
    blocked.release()
    assert.equal((await work).delivered, 2)
    assert.deepEqual(calls, stage === 'retry' ? ['a', 'a', 'b'] : ['a', 'b'])
  })
}

test('用户回调同步重入 deliver/retry 仍共享同一个 promise', async (t) => {
  const { storage } = fixture(t)
  let reentered
  let retried
  let calls = 0
  const ob = createOutbox({
    storage, resolve: async (m) => { reentered = ob.deliver(b); return m },
    send: async () => { retried = ob.retry(b); calls++; return {} },
  })
  const b = ob.enqueue({ chatId: 'group:1', items: [text('a')] })
  const work = ob.deliver(b)
  await work
  assert.equal(reentered, work)
  assert.equal(retried, work)
  assert.equal(calls, 1)
})

test('网关成功后保存 outcome 故障回滚，不能误当 not_sent 再发', async (t) => {
  const { storage } = fixture(t)
  const calls = []
  const run = storage.db.run
  let failReceipt = false
  storage.db.run = (sql, ...args) => {
    if (failReceipt && sql.startsWith('INSERT INTO meta')) {
      failReceipt = false
      throw failure('not_sent') // 即使错误带这个字段，也不是 send 的结果。
    }
    return run(sql, ...args)
  }
  const ob = createOutbox({ storage, sleep: noWait, send: async (_c, m) => {
    const value = m[0].data.text
    calls.push(value)
    if (value === 'a') failReceipt = true
    return { message_id: value }
  } })
  const b = ob.enqueue({ chatId: 'group:1', items: [text('a'), text('b')] })
  await assert.rejects(ob.deliver(b), /not_sent/)
  assert.deepEqual(calls, ['a'])
  assert.equal(ob.rows(b)[0].state, 'sending')
  assert.equal(ob.rows(b)[0].outcome, 'unknown')
  assert.equal(ob.rows(b)[0].platformMsgId, null, '整笔回执事务回滚')
  const recovered = await ob.recover()
  assert.deepEqual(recovered, { stuck: 1, stale: 0, resumed: 1 })
  await ob.retry(b)
  assert.deepEqual(calls, ['a', 'b'])
  assert.equal(ob.summary(b).unknown, 1)
  assert.equal(ob.summary(b).delivered, 1)
})

test('段间等待抛错释放 claim，恢复只接着发送剩余 pending', async (t) => {
  const { storage } = fixture(t)
  const calls = []
  const ob = createOutbox({ storage, send: async (_c, m) => { calls.push(m[0].data.text); return {} }, sleep: async () => { throw new Error('stopped') } })
  const b = ob.enqueue({ chatId: 'group:1', items: [text('a'), text('b', { delayMs: 1 })] })
  await assert.rejects(ob.deliver(b), /stopped/)
  assert.deepEqual(await ob.recover(), { stuck: 0, stale: 0, resumed: 1 })
  assert.deepEqual(calls, ['a', 'b'])
})

test('worker 已结束但释放 claim 落库失败，同进程恢复仍能继续剩余段', async (t) => {
  const f = fixture(t, true)
  const calls = []
  let failRelease = false
  const run = f.storage.db.run
  f.storage.db.run = (sql, ...args) => {
    if (failRelease && sql.startsWith('INSERT INTO meta')) {
      failRelease = false
      throw new Error('claim write failed')
    }
    return run(sql, ...args)
  }
  const send = async (_c, m) => { calls.push(m[0].data.text); return {} }
  const ob = createOutbox({ storage: f.storage, send, sleep: async () => { failRelease = true; throw new Error('stopped') } })
  const b = ob.enqueue({ chatId: 'group:1', items: [text('a'), text('b', { delayMs: 1 })] })
  await assert.rejects(ob.deliver(b), /claim write failed/)
  const next = createOutbox({ storage: f.open(), send })
  assert.deepEqual(await next.recover(), { stuck: 0, stale: 0, resumed: 1 })
  assert.deepEqual(calls, ['a', 'b'])
  assert.equal(next.summary(b).delivered, 2)
})

// 子进程使用同一个真实 SQLite 文件。用 IPC 门闩控制故障点，不依赖毫秒级竞速。
const childProgram = `
  import { createStorage } from ${JSON.stringify(new URL('../src/storage/index.js', import.meta.url).href)}
  import { createOutbox } from ${JSON.stringify(new URL('../src/delivery/outbox.js', import.meta.url).href)}
  const { options, mode } = JSON.parse(process.argv[1])
  const storage = createStorage(options)
  const hold = async (stage) => {
    process.send({ event: 'held', stage })
    await new Promise(() => {})
  }
  const outbox = createOutbox({
    storage,
    resolve: async (m) => { if (mode === 'resolve') await hold('resolve'); return m },
    send: async (_c, m) => {
      process.send({ event: 'sent', text: m[0].data.text })
      if (mode === 'send') await hold('send')
      return { message_id: m[0].data.text }
    },
  })
  process.on('message', async (command) => {
    if (command === 'exit') process.exit(0)
    if (command !== 'go') return
    try {
      const batchId = outbox.enqueue({ batchId: 'image:process', chatId: 'group:1', items: ['a', 'b'].map((value) => ({ kind: 'text', message: [{ type: 'text', data: { text: value } }] })) })
      const result = await outbox.deliver(batchId)
      process.send({ event: 'done', result })
    } catch (error) {
      process.send({ event: 'failure', error: error.stack })
    }
  })
  process.send({ event: 'ready' })
`

function worker(f, mode) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', childProgram, JSON.stringify({ options: f.options, mode })], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
  })
  const messages = []
  const waiters = []
  let stderr = ''
  let exited = false
  let failure
  const failWaiters = (error) => {
    failure = error
    for (const waiter of waiters.splice(0)) waiter.reject(error)
  }
  child.stderr.on('data', (data) => { stderr += data })
  child.on('message', (message) => {
    messages.push(message)
    if (message.event === 'failure') return failWaiters(new Error(message.error))
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].event === message.event) waiters.splice(i, 1)[0].resolve(message)
    }
  })
  const closed = new Promise((resolve) => {
    child.on('error', (error) => { failWaiters(error); resolve() })
    child.on('exit', (code, signal) => {
      exited = true
      failWaiters(new Error(`worker exited: ${code}/${signal} ${stderr}`))
      resolve()
    })
  })
  f.cleanups.push(async () => { if (!exited) child.kill(); await closed })
  return {
    child, messages,
    wait(event) {
      const received = messages.find((m) => m.event === event)
      if (received) return Promise.resolve(received)
      if (failure) return Promise.reject(failure)
      return new Promise((resolve, reject) => waiters.push({ event, resolve, reject }))
    },
    async exit() { child.send('exit'); await closed },
  }
}

for (const stage of ['resolve', 'send']) {
  test(`真实进程在 ${stage} 时存活不被抢占，退出后保守恢复`, { timeout: 15_000 }, async (t) => {
    const f = fixture(t, true)
    const child = worker(f, stage)
    await child.wait('ready')
    child.child.send('go')
    await child.wait('held')
    const calls = []
    const ob = createOutbox({ storage: f.storage, send: async (_c, m) => { calls.push(m[0].data.text); return {} } })
    const b = 'image:process'
    const before = ob.rows(b)
    await ob.deliver(b)
    await ob.retry(b)
    assert.deepEqual(await ob.recover({ maxAgeMs: 0 }), { stuck: 0, stale: 0, resumed: 0 })
    assert.deepEqual(ob.rows(b), before)
    assert.deepEqual(calls, [])
    await child.exit()
    const result = await ob.recover()
    assert.deepEqual(result, { stuck: stage === 'send' ? 1 : 0, stale: 0, resumed: 1 })
    await ob.retry(b)
    assert.deepEqual(calls, stage === 'send' ? ['b'] : ['a', 'b'])
    assert.equal(ob.summary(b).unknown, stage === 'send' ? 1 : 0)
    assert.deepEqual(ob.rows(b).map((r) => r.id), before.map((r) => r.id))
  })
}

test('两个进程同时以相同 batchId 登记和发送，每段只发一次', { timeout: 15_000 }, async (t) => {
  const f = fixture(t, true)
  const workers = [worker(f, 'normal'), worker(f, 'normal')]
  await Promise.all(workers.map((w) => w.wait('ready')))
  workers.forEach((w) => w.child.send('go'))
  await Promise.all(workers.map((w) => w.wait('done')))
  const sent = workers.flatMap((w) => w.messages.filter((m) => m.event === 'sent').map((m) => m.text))
  assert.deepEqual(sent.sort(), ['a', 'b'])
  const ob = createOutbox({ storage: f.storage, send: async () => assert.fail('已经发完') })
  assert.equal(ob.summary('image:process').total, 2)
  assert.equal((await ob.deliver('image:process')).delivered, 2)
})

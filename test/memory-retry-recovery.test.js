import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStorage } from '../src/storage/index.js'
import { createMemoryStore } from '../src/memory/index.js'
import { createRetryState } from '../src/memory/background.js'
import { deferred, settled } from './helpers/wp6.js'

const S = { account: 'bot', chat: 'group:101', persona: '' }
const zero = { facts: [], summary: null }
function fixture(t, extraction = {}) {
  let time = 1000000, extract = async () => zero, memory
  const cfg = { enabled: true, botQQ: S.account, allow: { groups: ['101'] }, memory: { enabled: true, extraction } }
  const storage = createStorage({ file: ':memory:', filesDir: '', now: () => time }), calls = [], services = []
  const retry = createRetryState(storage.db, 'memory', () => time, () => cfg.memory.extraction)
  const create = () => {
    memory = createMemoryStore({ storage, now: () => time, getConfig: () => cfg, extract: async input => {
      calls.push({ size: input.messages.length, chars: input.messages.reduce((n, m) => n + m.text.length, 0), operationId: input.operationId })
      return extract(input)
    } })
    services.push(memory)
    return memory
  }
  create()
  t.mock.method(globalThis, 'fetch', () => assert.fail('No external calls are allowed'))
  t.after(async () => { await Promise.all(services.map(s => s.stop())); storage.close() })
  const add = (n = 1, text = '证'.repeat(150), authorId = 'alice') => {
    for (let i = 0; i < n; i++) storage.messages.ingest({ account: S.account, chatId: S.chat, eventKind: 'message', authorId, text })
  }
  // The audited legacy state has no recovery counters; exercise that migration path.
  const seed = (body = {}) => storage.db.run('INSERT INTO background_work_state VALUES (?,?,?) ON CONFLICT(namespace,scope_key) DO UPDATE SET body=excluded.body',
    'memory', JSON.stringify([S.account, S.chat, S.persona]), JSON.stringify({ failures: 0, phase: 'done', batchLimit: 1, charLimit: 256, ...body }))
  return { cfg, storage, calls, retry, add, seed, create, get memory() { return memory }, setExtract: fn => { extract = fn },
    advance: ms => { time += ms }, now: () => time }
}
const limits = f => [f.memory.status(S).batchLimit, f.memory.status(S).charLimit]

test('legacy reduced limits need three committed successes; the streak survives a worker restart', async t => {
  const f = fixture(t); f.seed()
  f.add(2)
  assert.equal((await f.memory.consolidate(S)).ok, true)
  assert.deepEqual(limits(f), [1, 256])
  assert.equal(f.memory.status(S).successStreak, 2)
  await f.memory.stop(); f.create()
  f.add()
  assert.equal((await f.memory.consolidate(S)).ok, true)
  assert.deepEqual(limits(f), [2, 512])
  assert.equal(f.memory.status(S).successStreak, 0)
})

test('a large backlog promotes at most once per frozen extraction lease and gradually reaches normal budgets', async t => {
  const f = fixture(t), configBefore = structuredClone(f.cfg); f.seed()
  const expected = [[2, 512], [4, 1024], [null, 2048], [null, 4096], [null, 8192], [null, null]]
  const sizes = [1, 2, 4, 5, 5, 5]
  for (let wave = 0; wave < expected.length; wave++) {
    const start = f.calls.length
    f.add(30)
    const result = await f.memory.consolidate(S), calls = f.calls.slice(start)
    assert.equal(result.ok, true); assert.equal(result.processed, 30)
    assert.deepEqual(limits(f), expected[wave])
    assert.equal(new Set(calls.map(c => c.operationId)).size, 1)
    assert.equal(Math.max(...calls.map(c => c.size)), sizes[wave])
    assert.equal(f.memory.status(S).recvSeq, f.memory.status(S).watermark)
  }
  f.add(5, '字'.repeat(2000))
  const start = f.calls.length
  assert.equal((await f.memory.consolidate(S)).ok, true)
  assert.deepEqual(f.calls.slice(start).map(({ size, chars }) => [size, chars]), [[5, 10000]])
  assert.deepEqual(limits(f), [null, null])
  assert.deepEqual(f.cfg, configBefore)
})

test('recovery respects configured batch/character limits and the output-token ceiling', async t => {
  const f = fixture(t, { batchMessages: 9, maxChars: 700, maxOutputTokens: 3500 }); f.seed()
  f.add(12)
  await f.memory.consolidate(S)
  assert.deepEqual(limits(f), [2, 512])
  f.add(12)
  await f.memory.consolidate(S)
  assert.deepEqual(limits(f), [null, null])
  const start = f.calls.length
  f.add(12)
  await f.memory.consolidate(S)
  assert.ok(f.calls.slice(start).every(c => c.size <= 3 && c.chars <= 700))
  assert.equal(Math.max(...f.calls.slice(start).map(c => c.size)), 3)
})

test('failure after promotion shrinks again, keeps the failed interval and preserves backoff/error metadata', async t => {
  const f = fixture(t); f.seed({ billing: 'unknown' })
  f.add(3); await f.memory.consolidate(S)
  assert.deepEqual(limits(f), [2, 512])
  const before = f.memory.status(S).recvSeq, seen = []
  f.setExtract(async ({ messages }) => {
    seen.push(messages.map(m => m.messageId))
    throw Object.assign(new Error('result unknown'), { code: 'MODEL_INCOMPLETE', outcome: 'unknown' })
  })
  f.add(3)
  assert.equal((await f.memory.consolidate(S)).code, 'MODEL_INCOMPLETE')
  const failed = f.memory.status(S)
  assert.equal(failed.recvSeq, before)
  assert.equal(failed.failures, 1); assert.equal(failed.successStreak, 0)
  assert.equal(failed.lastError, 'MODEL_INCOMPLETE'); assert.equal(failed.phase, 'failed')
  assert.equal(failed.billing, 'unknown')
  assert.equal(failed.nextAttemptAt, f.now() + 60000)
  assert.deepEqual(limits(f), [1, 256])
  assert.equal((await f.memory.consolidate(S)).code, 'EXTRACTION_BACKOFF')
  assert.equal(seen.length, 1)
  f.advance(60000)
  f.setExtract(async ({ messages }) => { seen.push(messages.map(m => m.messageId)); return zero })
  const result = await f.memory.consolidate(S)
  assert.equal(result.processed, 3)
  assert.equal(seen[1][0], seen[0][0], 'retry starts at the same uncommitted message')
  assert.equal(f.memory.status(S).recvSeq, f.memory.status(S).watermark)
})

test('a later failure in the same lease clears recovery and advances only earlier committed messages', async t => {
  const f = fixture(t); f.seed()
  let calls = 0
  f.setExtract(async () => { if (++calls === 4) throw Object.assign(new Error('timeout'), { code: 'MODEL_TIMEOUT' }); return zero })
  f.add(5)
  const result = await f.memory.consolidate(S)
  assert.equal(result.code, 'MODEL_TIMEOUT'); assert.equal(result.processed, 3)
  const progress = f.memory.status(S)
  assert.equal(progress.recvSeq, 3); assert.equal(progress.watermark, 5)
  assert.equal(progress.successStreak, 0); assert.equal(progress.recoveryLease, null)
  assert.deepEqual(limits(f), [1, 256])
})

test('skipped bot evidence and no-op consolidation are not model successes', async t => {
  const f = fixture(t); f.seed()
  f.add(2)
  await f.memory.consolidate(S)
  const calls = f.calls.length
  f.add(20, '机器人回复', S.account)
  await f.memory.consolidate(S)
  await f.memory.consolidate(S)
  assert.equal(f.calls.length, calls)
  assert.equal(f.memory.status(S).successStreak, 2)
  assert.deepEqual(limits(f), [1, 256])
})

test('commits after a promotion cannot leak old successful calls into a model-free next lease', async t => {
  const f = fixture(t); f.seed()
  f.add(20); await f.memory.consolidate(S)
  assert.deepEqual(limits(f), [2, 512])
  assert.equal(f.memory.status(S).successStreak, 0)
  f.add(20, '机器人回复', S.account)
  await f.memory.consolidate(S)
  assert.equal(f.memory.status(S).successStreak, 0)
  assert.deepEqual(limits(f), [2, 512])
})

test('an unfinished call from an expired lease is never counted as a success or carried into the recovery streak', async t => {
  const f = fixture(t)
  f.seed({ successStreak: 2, callLease: 'expired-lease', lastCallId: 'unknown-call', lastSuccessCallId: 'previous-call', phase: 'extraction', billing: 'unknown' })
  f.add(3, '机器人回复', S.account)
  await f.memory.consolidate(S)
  assert.deepEqual(limits(f), [1, 256])
  assert.equal(f.calls.length, 0)
  assert.equal(f.memory.status(S).billing, 'unknown')
  f.add(); await f.memory.consolidate(S)
  assert.deepEqual(limits(f), [1, 256])
  assert.equal(f.memory.status(S).successStreak, 1)
  f.add(2); await f.memory.consolidate(S)
  assert.deepEqual(limits(f), [2, 512])
})

test('discarded work and explicit resume break the success streak without releasing reduced limits', async t => {
  const f = fixture(t); f.seed()
  f.add(2); await f.memory.consolidate(S)
  const entered = deferred(), late = deferred(), before = f.memory.status(S).recvSeq
  f.setExtract(async () => { entered.resolve(); await late.promise; return zero })
  f.add()
  const work = f.memory.consolidate(S)
  await entered.promise
  f.cfg.memory.enabled = false; f.memory.refreshPolicy()
  assert.equal((await work).ok, false)
  assert.equal(f.memory.status(S).recvSeq, before)
  assert.equal(f.memory.status(S).successStreak, 0)
  assert.deepEqual(limits(f), [1, 256])
  late.resolve(); await settled()
  f.cfg.memory.enabled = true
  f.setExtract(async () => zero)
  await f.memory.consolidate(S)
  assert.equal(f.memory.status(S).successStreak, 1)
  assert.equal(f.memory.resumeExtraction(S).ok, true)
  assert.equal(f.memory.status(S).successStreak, 0)
  assert.deepEqual(limits(f), [1, 256])
})

test('recovery state stays scoped and does not alter learning/mood retry behavior', async t => {
  const f = fixture(t); f.seed()
  const others = [{ ...S, account: 'other' }, { ...S, chat: 'group:102' }, { ...S, persona: 'other' }]
  for (const scope of others) f.retry.write(scope, { batchLimit: 1, charLimit: 256, successStreak: 2, phase: 'unknown' })
  const snapshots = others.map(scope => f.retry.read(scope))
  f.add(6); await f.memory.consolidate(S)
  assert.deepEqual(others.map(scope => f.retry.read(scope)), snapshots)
  for (const namespace of ['mood', 'learning:expression']) {
    const retry = createRetryState(f.storage.db, namespace, f.now)
    retry.failure(S, { code: 'MODEL_INCOMPLETE' }, { batchSize: 4, chars: 1024 })
    for (let i = 0; i < 6; i++) retry.success(S)
    const state = retry.read(S)
    assert.deepEqual([state.batchLimit, state.charLimit, state.failures], [2, 512, 0])
    assert.equal(state.successStreak, undefined)
  }
})

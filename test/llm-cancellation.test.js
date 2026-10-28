import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { askModel, observeModelUsage, clearReasoningCache, clearVisionCache, modelReasoning, DEFAULT_MODEL_TIMEOUT_MS, MAX_MODEL_TIMEOUT_MS } from '../src/core/llm.js'
import { createStorage } from '../src/storage/index.js'
import { createMemoryStore } from '../src/memory/index.js'

const CFG = { model: { provider: 'local-mock', model: 'test-model' } }
const S = { account: 'bot', chat: 'group:101', persona: 'fish' }
const USAGE = { inputTokens: 10, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 2, reasoningTokens: 1, totalTokens: 20 }
const options = extra => ({ cfg: CFG, text: 'PRIVATE-PROMPT', system: 'PRIVATE-SYSTEM', ...extra })
const code = value => error => error.code === value
function deferred() {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
function fixture(t, extra = {}) {
  clearReasoningCache(); clearVisionCache()
  const calls = [], reports = [], observed = []
  const dsh = { get: () => null, llm: {
    resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
    stream(params) {
      calls.push(params)
      return extra.stream ? extra.stream(params) : (async function* () {
        yield { type: 'text-delta', text: '  完整回答  ' }
        yield { type: 'usage', usage: USAGE }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    }, ...extra.llm,
  }, ...(extra.attachments ? { attachments: extra.attachments } : {}) }
  t.after(observeModelUsage(dsh, event => observed.push(event)))
  return { dsh, calls, reports, observed, run: more => askModel(dsh, options({ onUsage: event => reports.push(event), ...more })) }
}

test('string return stays compatible; one usage event has only whitelisted model/context/count fields', async t => {
  const f = fixture(t)
  const result = await f.run({ role: 'memory', scope: { ...S, apiKey: 'SECRET-KEY' }, chatId: 'group:202', requestId: 'request-1' })
  assert.equal(result, '完整回答')
  assert.equal(f.reports.length, 1); assert.equal(f.observed.length, 1)
  const event = f.reports[0]
  assert.deepEqual(event, f.observed[0])
  assert.deepEqual(event.context, { account: 'bot', chatId: 'group:202', requestId: 'request-1', role: 'memory' })
  assert.deepEqual(event.tokens, USAGE)
  assert.equal(event.provider, CFG.model.provider); assert.equal(event.model, CFG.model.model)
  assert.equal(event.status, 'success'); assert.equal(event.attempts, 1); assert.equal(event.usageComplete, true)
  assert.ok(Number.isInteger(event.duration) && event.duration >= 0)
  assert.equal(event.durationMs, event.duration)
  assert.deepEqual(Object.keys(event).sort(), ['attempts', 'context', 'duration', 'durationMs', 'model', 'provider', 'role', 'status', 'tokens', 'usageComplete'])
  assert.equal(/PRIVATE|SECRET|prompt|apiKey/.test(JSON.stringify(event)), false)
  assert.ok(Object.isFrozen(event) && Object.isFrozen(event.context) && Object.isFrozen(event.tokens))
  assert.ok(f.calls[0].signal instanceof AbortSignal)
})

test('usage snapshots replace within an attempt; malformed/private counters are not forwarded or invented', async t => {
  const f = fixture(t, { stream: async function* () {
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 1, apiKey: 'SECRET' } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 4, totalTokens: 19, cacheReadTokens: 5, cacheWriteTokens: -1, reasoningTokens: NaN, prompt: 'PRIVATE' } }
    yield { type: 'text-delta', text: 'done' }; yield { type: 'finish', reason: 'completed' }
  } })
  await f.run()
  assert.deepEqual(f.reports[0].tokens, { inputTokens: 10, outputTokens: 4, totalTokens: 19, cacheReadTokens: 5 })
})

test('missing usage remains unknown, including zero-attempt preflight failures', async t => {
  const f = fixture(t, { stream: async function* () { yield { type: 'finish', reason: 'stop' } } })
  assert.equal(await f.run(), '')
  assert.equal(f.reports[0].tokens, null); assert.equal(f.reports[0].usageComplete, false)
  await assert.rejects(f.run({ cfg: {} }), code('MODEL_UNAVAILABLE'))
  assert.equal(f.reports[1].status, 'failed'); assert.equal(f.reports[1].attempts, 0)
  assert.equal(f.reports[1].tokens, null); assert.equal(f.observed.length, 2)
})

test('WeakMap observers support unsubscribe and independent contexts without mutating frozen hosts', async () => {
  const make = () => Object.freeze({ llm: { stream: async function* () { yield { type: 'finish', reason: 'stop' } } } })
  const a = make(), b = make(), first = [], second = [], other = [], keys = Reflect.ownKeys(a)
  const off1 = observeModelUsage(a, event => first.push(event)), off2 = observeModelUsage(a, event => second.push(event)), off3 = observeModelUsage(b, event => other.push(event))
  await askModel(a, options()); off1(); off1(); await askModel(a, options()); await askModel(b, options())
  assert.equal(first.length, 1); assert.equal(second.length, 2); assert.equal(other.length, 1)
  assert.deepEqual(Reflect.ownKeys(a), keys)
  off2(); off3(); await askModel(a, options()); assert.equal(second.length, 2)
})

test('throwing, rejecting and never-settling callbacks cannot break or hang the request', { timeout: 1000 }, async t => {
  const f = fixture(t), seen = []
  t.after(observeModelUsage(f.dsh, () => { throw new Error('observer broke') }))
  t.after(observeModelUsage(f.dsh, async () => { throw new Error('observer rejected') }))
  t.after(observeModelUsage(f.dsh, event => seen.push(event)))
  assert.equal(await f.run({ onUsage: () => new Promise(() => {}) }), '完整回答')
  assert.equal(await f.run({ onUsage: event => { event.tokens.inputTokens = 999 } }), '完整回答')
  await nextTurn()
  assert.equal(seen.length, 2); assert.equal(seen[1].tokens.inputTokens, 10)
})

test('pre-aborted input makes no metadata/attachment/stream call and still settles the ledger once', async t => {
  const controller = new AbortController(); controller.abort('PRIVATE-CANCEL-REASON')
  let probes = 0
  const f = fixture(t, { llm: { resolveModelInfo: async () => { probes++; return {} } } })
  await assert.rejects(f.run({ signal: controller.signal, scope: S, role: 'vision', images: [{ data: 'PRIVATE-IMAGE', mediaType: 'image/png' }] }), code('MODEL_ABORTED'))
  assert.equal(probes, 0); assert.equal(f.calls.length, 0)
  assert.equal(f.reports[0].status, 'aborted'); assert.equal(f.observed[0].attempts, 0)
  assert.equal(f.observed[0].context.chatId, S.chat)
  assert.equal(JSON.stringify(f.observed).includes('PRIVATE'), false)
})

test('parent abort reaches the stream; stalled next/return and late rejection cannot hang or report success', { timeout: 1000 }, async t => {
  const controller = new AbortController(), started = deferred(), late = deferred()
  let cleaned = 0
  const f = fixture(t, { stream: params => {
    return { [Symbol.asyncIterator]() { return this }, next: () => { started.resolve(params.signal); return late.promise }, return() { cleaned++; return new Promise(() => {}) } }
  } })
  const outcome = assert.rejects(f.run({ signal: controller.signal }), code('MODEL_ABORTED'))
  const signal = await started.promise; controller.abort()
  await outcome
  assert.equal(signal.aborted, true); assert.equal(cleaned, 1)
  assert.equal(f.reports[0].status, 'aborted')
  late.reject(new Error('PRIVATE-LATE-FAILURE')); await nextTurn()
  assert.equal(f.reports.length, 1); assert.equal(f.observed.length, 1)
})

test('abort during stream creation closes the newly created iterable before reading it', async t => {
  const c = new AbortController(); let closed = 0, reads = 0
  const f = fixture(t, { stream: () => {
    c.abort()
    return { [Symbol.asyncIterator]() { return this }, next() { reads++; return Promise.resolve({ done: true }) }, return() { closed++; return Promise.resolve({ done: true }) } }
  } })
  await assert.rejects(f.run({ signal: c.signal }), code('MODEL_ABORTED'))
  assert.equal(closed, 1); assert.equal(reads, 0); assert.equal(f.reports.length, 1)
})

test('an asynchronous stream factory resolving after timeout is closed without consuming late results', async t => {
  const late = deferred(); let closed = 0, reads = 0
  const f = fixture(t, { stream: () => late.promise })
  await assert.rejects(f.run({ timeoutMs: 15 }), code('MODEL_TIMEOUT'))
  late.resolve({ [Symbol.asyncIterator]() { return this }, next() { reads++; return Promise.resolve({ value: { type: 'finish', reason: 'stop' } }) },
    return() { closed++; return Promise.reject(new Error('late cleanup error')) } })
  await nextTurn()
  assert.equal(closed, 1); assert.equal(reads, 0); assert.equal(f.reports.length, 1)
})

test('cancellation retains only usage seen before abort and ignores late successful completion', async t => {
  const controller = new AbortController(), started = deferred(), late = deferred()
  const f = fixture(t, { stream: async function* () {
    yield { type: 'usage', usage: USAGE }; yield { type: 'text-delta', text: 'partial' }
    started.resolve(); await late.promise
    yield { type: 'usage', usage: { inputTokens: 9999, outputTokens: 9999 } }
    yield { type: 'finish', reason: 'stop' }
  } })
  const outcome = assert.rejects(f.run({ signal: controller.signal }), code('MODEL_ABORTED'))
  await started.promise; controller.abort(); await outcome
  late.resolve(); await nextTurn()
  assert.deepEqual(f.reports[0].tokens, USAGE); assert.equal(f.reports.length, 1)
})

test('default deadline is 120 seconds and does not depend on stream honoring AbortSignal', async t => {
  const started = deferred(), f = fixture(t, { stream: params => {
    started.resolve(params.signal)
    return { [Symbol.asyncIterator]() { return this }, next: () => new Promise(() => {}) }
  } })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  assert.equal(DEFAULT_MODEL_TIMEOUT_MS, 120_000)
  let settled = false
  const outcome = assert.rejects(f.run().finally(() => { settled = true }), code('MODEL_TIMEOUT'))
  const signal = await started.promise
  t.mock.timers.tick(119_999); await Promise.resolve(); assert.equal(settled, false)
  t.mock.timers.tick(1); await outcome
  assert.equal(signal.aborted, true); assert.equal(f.reports[0].status, 'timeout')
})

test('short custom timeout aborts the transport and cannot become a late success', { timeout: 1000 }, async t => {
  const late = deferred(), f = fixture(t, { stream: async function* () { await late.promise; yield { type: 'finish', reason: 'stop' } } })
  await assert.rejects(f.run({ timeoutMs: 15 }), code('MODEL_TIMEOUT'))
  assert.equal(f.calls[0].signal.aborted, true)
  late.resolve(); await nextTurn(); assert.equal(f.reports.length, 1); assert.equal(f.reports[0].status, 'timeout')
})

for (const invalid of [0, -1, Infinity, NaN, '100', MAX_MODEL_TIMEOUT_MS + 1]) {
  test(`invalid timeout ${String(invalid)} fails before dispatch with one report`, async t => {
    const f = fixture(t)
    await assert.rejects(f.run({ timeoutMs: invalid }), code('INVALID_TIMEOUT'))
    assert.equal(f.calls.length, 0); assert.equal(f.reports.length, 1); assert.equal(f.reports[0].status, 'failed')
  })
}

test('timeout covers hanging capability lookup, and late metadata cannot poison the shared cache', async t => {
  const late = deferred(); let probes = 0, signal
  const f = fixture(t, { llm: { resolveModelInfo: async (_p, _m, s) => { signal = s; probes++; return probes === 1 ? late.promise : {} } } })
  await assert.rejects(f.run({ timeoutMs: 15 }), code('MODEL_TIMEOUT'))
  assert.equal(signal.aborted, true); assert.equal(f.calls.length, 0)
  late.resolve({ reasoning: { efforts: ['high'] } }); await nextTurn()
  assert.equal(await modelReasoning(f.dsh, CFG.model.provider, CFG.model.model), null)
  assert.equal(probes, 2); assert.equal(f.reports.length, 1)
})

test('timeout covers attachment admission and no late stream begins', async t => {
  const late = deferred(), f = fixture(t, { attachments: { admitPromptContent: () => late.promise } })
  await assert.rejects(f.run({ timeoutMs: 15, role: 'vision', images: [{ data: 'PRIVATE-PIXELS', mediaType: 'image/png' }] }), code('MODEL_TIMEOUT'))
  late.resolve([]); await nextTurn()
  assert.equal(f.calls.length, 0); assert.equal(f.reports[0].attempts, 0)
})

test('a valid terminal finish settles without waiting for a hung iterator cleanup', { timeout: 1000 }, async t => {
  let n = 0, returns = 0
  const f = fixture(t, { stream: () => ({ [Symbol.asyncIterator]() { return this },
    next: async () => ({ value: n++ ? { type: 'finish', reason: 'stop' } : { type: 'text-delta', text: 'ok' }, done: false }),
    return: () => { returns++; return new Promise(() => {}) },
  }) })
  assert.equal(await f.run(), 'ok'); assert.equal(returns, 1); assert.equal(f.reports[0].status, 'success')
})

for (const reason of [{ kind: 'aborted' }, { kind: 'error', failure: { code: 'PROVIDER_FAILED', message: 'PRIVATE-PROVIDER-ERROR' } },
  { kind: 'max-tokens' }, 'tool-calls', null, 'error']) {
  test(`finish ${JSON.stringify(reason)} never publishes partial text`, async t => {
    const f = fixture(t, { stream: async function* () { yield { type: 'text-delta', text: 'partial' }; yield { type: 'usage', usage: USAGE }; yield { type: 'finish', reason } } })
    await assert.rejects(f.run(), error => Boolean(error.code))
    assert.equal(f.reports[0].status, reason?.kind === 'aborted' ? 'aborted' : 'failed')
    assert.equal(f.calls[0].signal.aborted, true, 'An unsuccessful stream also cancels any remaining transport work')
    assert.deepEqual(f.reports[0].tokens, USAGE); assert.equal(f.reports.length, 1)
    assert.equal(JSON.stringify(f.reports).includes('PRIVATE'), false)
  })
}

test('EOF without finish and thrown or in-band stream errors are failures, never successful partial output', async t => {
  for (const mode of ['eof', 'throw', 'error']) {
    const f = fixture(t, { stream: async function* () {
      yield { type: 'text-delta', text: 'partial' }
      if (mode === 'throw') throw new Error('PRIVATE-ERROR')
      if (mode === 'error') yield { type: 'error', error: { code: 'SERVICE_ERROR', message: 'PRIVATE-ERROR' } }
    } })
    await assert.rejects(f.run())
    assert.equal(f.reports[0].status, 'failed'); assert.equal(f.reports[0].tokens, null)
    assert.equal(JSON.stringify(f.reports).includes('PRIVATE'), false)
  }
})

test('the reasoning compatibility retry shares one deadline and emits only one aggregate event', async t => {
  let n = 0
  const f = fixture(t, { llm: { resolveModelInfo: async () => ({ reasoning: { efforts: ['low'] } }) }, stream: async function* () {
    if (!n++) { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT' } } }; return }
    yield { type: 'usage', usage: USAGE }; yield { type: 'text-delta', text: 'recovered' }; yield { type: 'finish', reason: 'stop' }
  } })
  assert.equal(await f.run(), 'recovered'); assert.equal(f.calls.length, 2)
  assert.equal(f.calls[0].signal, f.calls[1].signal)
  assert.equal(f.reports.length, 1); assert.equal(f.observed.length, 1)
  assert.equal(f.reports[0].attempts, 2); assert.equal(f.reports[0].usageComplete, false)
  assert.deepEqual(f.reports[0].tokens, USAGE)
})

test('abort between unsupported-effort rejection and retry never starts a second call', async t => {
  const controller = new AbortController()
  const f = fixture(t, { llm: { resolveModelInfo: async () => ({ reasoning: { efforts: ['low'] } }) }, stream: async function* () {
    controller.abort(); throw new Error('UNSUPPORTED_REASONING_EFFORT')
  } })
  await assert.rejects(f.run({ signal: controller.signal }), code('MODEL_ABORTED'))
  assert.equal(f.calls.length, 1); assert.equal(f.reports[0].status, 'aborted')
})

test('unsupported effort after partial content or usage cannot cause a duplicate model call', async t => {
  for (const chunk of [{ type: 'text-delta', text: 'partial' }, { type: 'usage', usage: USAGE }]) {
    const f = fixture(t, { llm: { resolveModelInfo: async () => ({ reasoning: { efforts: ['low'] } }) }, stream: async function* () {
      yield chunk; yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT' } } }
    } })
    await assert.rejects(f.run()); assert.equal(f.calls.length, 1)
  }
})

test('parent abort listener is removed after success, failure and timeout', async t => {
  for (const mode of ['success', 'failed', 'timeout']) {
    const c = new AbortController(), { signal } = c
    let adds = 0, removes = 0
    const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal)
    signal.addEventListener = (...args) => { if (args[0] === 'abort') adds++; return add(...args) }
    signal.removeEventListener = (...args) => { if (args[0] === 'abort') removes++; return remove(...args) }
    const f = fixture(t, { stream: async function* () {
      if (mode === 'failed') throw new Error('fail')
      if (mode === 'timeout') await new Promise(() => {})
      yield { type: 'finish', reason: 'stop' }
    } })
    const result = f.run({ signal, timeoutMs: 15 })
    if (mode === 'success') await result; else await assert.rejects(result)
    assert.equal(adds, 1); assert.equal(removes, 1)
    c.abort(); assert.equal(f.reports.length, 1)
  }
})

test('memory wrapper forwards lifecycle signal/scope; host observer sees cancellation without a model callback', { timeout: 1000 }, async t => {
  const entered = deferred(), late = deferred(), seen = [], params = []
  const storage = createStorage({ file: ':memory:', filesDir: '' })
  const dsh = { get: () => null, llm: { stream: async function* (o) {
    params.push(o); entered.resolve(); await late.promise
    yield { type: 'text-delta', text: '{"facts":[],"summary":null}' }; yield { type: 'finish', reason: 'stop' }
  } } }
  t.after(observeModelUsage(dsh, event => seen.push(event)))
  const memory = createMemoryStore({ storage, dsh, getConfig: () => CFG })
  t.after(async () => { await memory.stop(); storage.close() })
  storage.messages.ingest({ account: S.account, chatId: S.chat, authorId: 'alice', eventKind: 'message', text: 'PRIVATE-MEMORY-EVIDENCE' })
  const job = memory.consolidate({ scope: S })
  await entered.promise
  assert.ok(params[0].signal instanceof AbortSignal)
  const payload = JSON.parse(params[0].messages[0].content[0].text)
  assert.deepEqual(payload.scope, S); assert.equal('signal' in payload, false)
  await memory.stop(); assert.equal((await job).ok, false)
  await nextTurn()
  assert.equal(params[0].signal.aborted, true)
  assert.equal(seen.length, 1); assert.equal(seen[0].status, 'aborted')
  assert.deepEqual(seen[0].context, { chatId: S.chat, account: S.account, requestId: null, role: 'memory' })
  assert.equal(JSON.stringify(seen).includes('PRIVATE'), false)
  late.resolve(); await nextTurn(); assert.equal(seen.length, 1)
  assert.equal(storage.db.get('SELECT recv_seq FROM memory_checkpoints').recv_seq, 0)
})

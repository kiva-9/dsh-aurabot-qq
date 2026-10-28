import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createStorage } from '../src/storage/index.js'
import { createFactRepository } from '../src/memory/store.js'
import { visible } from '../src/memory/scope.js'
import { createHookRuntime } from '../src/core/hooks.js'
import { mappingFingerprint } from '../src/memory/embedding/index.js'
import { createMemoryVectorService, validateMemoryVectorConfig, MEMORY_VECTOR_CONFIG_SCHEMA } from '../src/memory/vector/integration/service.js'

const A = { account: 'bot', chat: 'group:1', persona: 'fish' }, B = { ...A, chat: 'group:2' }, P = { ...A, chat: 'private:1' }
const meta = scope => ({ scope, actorId: 'admin', reason: 'integration regression' })
const space = (id, modalities = ['text'], extra = {}) => ({ spaceId: id, provider: 'loopback-test', endpointIdentity: 'local-test', model: id, revision: 'r1', dims: 3, metric: 'cosine', modalities, normalization: 'none', prefixes: { query: '', document: '' }, preprocess: { text: { version: '1' } }, protocolMappingVersion: 'openai-text-v1', ...extra })
const imageMapping = { version: 'fixed-v1', path: '/encode', modelField: 'model', modalityField: 'modality', inputs: { text: { field: 'inputs' }, image: { field: 'inputs', itemField: 'url', representation: 'url' } }, response: { vectorsPath: 'vectors', modelPath: 'model', revisionPath: 'revision' } }
const imageSpace = (role, modalities) => space(role, modalities, { protocolMappingVersion: imageMapping.version, preprocess: { text: { version: '1' }, image: { version: '1', mode: 'passthrough' }, protocolMappingFingerprint: mappingFingerprint(imageMapping) } })
const vector = input => /咖啡|提神|拿铁|coffee/.test(input) ? [0, 1, 0] : /红|red/.test(input) ? [1, 0, 0] : /蓝|blue/.test(input) ? [0, 0, 1] : [1, 1, 1]
const barrier = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

async function fixture(t, { images = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'aurabot-vector-integration-'))
  const storage = createStorage({ file: join(dir, 'facts.sqlite'), filesDir: join(dir, 'assets') })
  let policy = { shareGroups: [] }
  const repo = createFactRepository({ storage, getPolicy: () => policy })
  const state = { hold: null, fail: false, drift: false, requests: 0 }
  const server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw)
      state.requests++
      if (state.hold) await state.hold(body)
      if (state.fail) { res.writeHead(503); res.end('{}'); return }
      const values = (body.input ?? body.inputs).map(value => {
        const v = vector(typeof value === 'string' ? value : value.url)
        if (state.drift) v[2] += 0.2
        return v
      })
      const result = req.url === '/embeddings' ? { model: body.model, data: values.map((embedding, index) => ({ index, embedding })) } : { model: body.model, revision: 'r1', vectors: values }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result))
    } catch { if (!res.headersSent) res.writeHead(500); res.end('{}') }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const config = { version: 1, index: { backend: 'local', path: join(dir, 'vectors.sqlite') }, roles: { text: { type: 'openai-text', space: space('text'), baseUrl, apiKey: 'test-secret' } }, queue: { batchSize: 2 } }
  const imageRows = new Map(); let imageRevision = 0
  const imageRepo = {
    list(scope, { limit = 300 } = {}) { return [...imageRows.values()].filter(row => !row.deleted && visible(row.scope, scope, policy, 'image')).slice(0, limit).map(row => structuredClone(row)) },
    get(id, scope) { const row = imageRows.get(id); return row && !row.deleted && visible(row.scope, scope, policy, 'image') ? structuredClone(row) : null },
    revision() { return imageRevision },
  }
  if (images) {
    config.roles.image = { type: 'fixed-http', space: imageSpace('image', ['image']), baseUrl, mapping: imageMapping, samples: { image: ['https://mock.test/red.png', 'https://mock.test/blue.png'] } }
    config.roles.joint = { type: 'fixed-http', space: imageSpace('joint', ['text', 'image']), baseUrl, mapping: imageMapping, samples: { text: ['red dress', 'blue cup'], image: ['https://mock.test/red.png', 'https://mock.test/blue.png'] }, alignmentPairs: [{ text: 0, positiveImage: 0, negativeImage: 1, margin: 0.1 }] }
  }
  const services = new Set()
  const create = async () => { const result = await createMemoryVectorService({ repo, config, imageRepo: images ? imageRepo : undefined }); services.add(result); return result }
  const service = await create()
  t.after(async () => { for (const instance of services) await instance.close(); storage.close(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }) })
  const fact = (text, scope = A) => repo.create({ scope, text, subject: 'user', predicate: 'likes', value: text, speakerId: 'user', polarity: 'positive', modality: 'asserted', conditions: [], eventTime: null, validFrom: null, validTo: null, status: 'active', stability: 'stable', slot: 'multi', profileSection: 'preferences', manualEvidence: { kind: 'manual', text, speakerId: 'user', actorId: 'admin', sourceId: randomUUID() } }).item
  const addImage = (id, scope, caption = '红色裙子', assetId = 'same-red-asset') => {
    const row = { id, scope, revision: 1, assetId, occurrenceId: id, contentHash: `hash:${assetId}`, image: { url: `https://mock.test/${assetId}.png` }, description: caption, ocr: '', chatText: '', sourceMessageId: `msg:${id}` }
    imageRows.set(id, row); imageRevision++; return row
  }
  const index = async (scope = A, kind = 'fact') => { const job = await service.enqueueIndex({ scope, kind }); await service.waitForIdle(); assert.equal((await service.job(job.jobId)).state, 'succeeded'); return job }
  return { storage, repo, service, state, config, fact, index, create, addImage, imageRows, imageRepo, setPolicy: value => { policy = value } }
}

test('integration config has a panel schema, rejects unknown keys and mismatched modalities; HTTP secrets stay out of health', async t => {
  const { service, config } = await fixture(t)
  assert.equal(MEMORY_VECTOR_CONFIG_SCHEMA.properties.index.properties.apiKey.writeOnly, true)
  assert.equal(validateMemoryVectorConfig(config).retrieval.rrfK, 60)
  assert.throws(() => validateMemoryVectorConfig({ ...config, typo: true }), { code: 'INVALID_CONFIG' })
  assert.throws(() => validateMemoryVectorConfig({ ...config, roles: { image: config.roles.text } }), { code: 'INVALID_CONFIG' })
  assert.throws(() => validateMemoryVectorConfig({ ...config, index: { path: 'x', backend: 'qdrant' } }))
  assert.ok(!JSON.stringify(await service.health()).includes('test-secret'))
})

test('real memory repo + HTTP embeddings produce hybrid synonym recall, lexical fallback and scoped final gates', async t => {
  const { service, state, fact, index, setPolicy } = await fixture(t)
  const coffee = fact('小明喜欢咖啡'), red = fact('小明喜欢红色裙子'), privateFact = fact('私聊咖啡秘密', P)
  await service.initialize(); await index(); await index(P)
  const semantic = await service.recall({ scope: A, query: '提神饮料' })
  assert.equal(semantic.hits[0].id, coffee.id)
  assert.ok(semantic.hits[0].channels.text)
  assert.ok(!semantic.hits.some(hit => hit.id === privateFact.id))
  const hybrid = await service.recall({ scope: A, query: '红色裙子' })
  assert.equal(hybrid.hits[0].id, red.id)
  assert.ok(hybrid.hits[0].channels.lexical && hybrid.hits[0].channels.text)
  assert.deepEqual((await service.recall({ scope: B, query: '咖啡' })).hits, [])
  setPolicy({ shareGroups: [{ chats: [A.chat, B.chat], categories: ['fact'] }] })
  assert.ok((await service.recall({ scope: B, query: '咖啡' })).hits.some(hit => hit.id === coffee.id))
  state.fail = true
  const fallback = await service.recall({ scope: A, query: '咖啡' })
  assert.equal(fallback.hits[0].id, coffee.id)
  assert.equal(fallback.degraded[0].reason, 'HTTP_ERROR')
})

test('deletion during query or indexing cannot return or resurrect a fact; deletion propagation is source-first', async t => {
  const { service, state, fact, repo, index } = await fixture(t)
  const f = fact('小明喜欢咖啡')
  await service.initialize(); await index()
  await assert.rejects(service.deleteSources({ scope: A, ids: [f.id] }), { code: 'SOURCE_STILL_VISIBLE' })
  const entered = barrier(), release = barrier()
  state.hold = async body => { if (body.input?.includes('提神饮料')) { entered.resolve(); await release.promise } }
  const searching = service.recall({ scope: A, query: '提神饮料' })
  await entered.promise; repo.remove(f.id, meta(A)); release.resolve()
  assert.deepEqual((await searching).hits, [])
  await service.deleteSources({ scope: A, ids: [f.id] })
  const next = fact('迟到咖啡编码'), encoding = barrier(), continueEncoding = barrier()
  state.hold = async body => { if (body.input?.includes(next.text)) { encoding.resolve(); await continueEncoding.promise } }
  const job = await service.enqueueIndex({ scope: A, ids: [next.id] })
  await encoding.promise; repo.remove(next.id, meta(A)); continueEncoding.resolve(); await service.waitForIdle()
  assert.equal((await service.job(job.jobId)).result.indexed, 0)
  assert.equal((await service.index.health()).spaces[0].records, 0)
})

test('prepareContext is async but contextFor stays synchronous and rechecks source evidence, persona and epoch every time', async t => {
  const { service, fact, repo, index } = await fixture(t)
  const f = fact('小明喜欢咖啡')
  await service.initialize(); await index()
  await service.prepareContext({ scope: A, sessionId: 'session', epoch: 1, query: '咖啡' })
  const context = service.contextFor({}, 'session', { scope: A, epoch: 1, query: '咖啡' })
  assert.equal(typeof context, 'string'); assert.match(context, /小明喜欢咖啡/); assert.ok(!context.includes('[object Promise]'))
  assert.equal(service.contextFor({}, 'session', { scope: A, epoch: 2 }), '')
  assert.equal(service.contextFor({}, 'session', { scope: { ...A, persona: 'cat' }, epoch: 1 }), '')
  assert.equal(service.contextFor({}, 'session', { scope: B, epoch: 1 }), '')
  repo.remove(f.id, meta(A))
  assert.equal(service.contextFor({}, 'session', { scope: A, epoch: 1 }), '', 'Cache TTL cannot override source tombstones')
})

test('late context preparation cannot overwrite a newer epoch or a sharing-policy revocation', async t => {
  const { service, state, fact, index, setPolicy } = await fixture(t)
  fact('小明喜欢咖啡'); fact('小明喜欢红色裙子')
  await service.initialize(); await index()
  const entered = barrier(), release = barrier()
  state.hold = async body => { if (body.input?.includes('提神饮料')) { entered.resolve(); await release.promise } }
  const old = service.prepareContext({ scope: A, sessionId: 's', epoch: 1, query: '提神饮料' })
  await entered.promise
  await service.prepareContext({ scope: A, sessionId: 's', epoch: 2, query: '红色裙子' })
  release.resolve(); assert.equal((await old).stale, true)
  assert.match(service.contextFor({}, 's', { scope: A, epoch: 2, query: '红色裙子' }), /红色裙子/)
  assert.equal(service.contextFor({}, 's', { scope: A, epoch: 1 }), '')
  setPolicy({ shareGroups: [{ chats: [A.chat, B.chat], categories: ['fact'] }] })
  await service.prepareContext({ scope: B, sessionId: 'shared', epoch: 1, query: '咖啡' })
  assert.match(service.contextFor({}, 'shared', { scope: B, epoch: 1 }), /咖啡/)
  setPolicy({ shareGroups: [] })
  assert.equal(service.contextFor({}, 'shared', { scope: B, epoch: 1 }), '')
})

test('latest prepareContext hook accepts flat host fields, AbortSignal and isCurrent; sync gate also checks evidence deletion', async t => {
  const { service, state, fact, repo, index } = await fixture(t)
  const f = fact('小明喜欢咖啡')
  await service.initialize(); await index()
  const controller = new AbortController()
  let current = true
  const ctx = { account: A.account, chatId: A.chat, sessionId: 'flat', text: '咖啡', persona: { personaId: A.persona }, signal: controller.signal, isCurrent: () => current }
  assert.equal((await service.prepareContext(ctx)).ready, true)
  assert.match(service.contextFor(ctx, ctx.sessionId), /咖啡/)
  controller.abort()
  assert.match(service.contextFor(ctx, ctx.sessionId), /咖啡/, 'Successful Hook cleanup aborts its execution signal; the cache uses isCurrent instead')
  current = false
  assert.equal(service.contextFor(ctx, ctx.sessionId), '')
  assert.equal((await service.prepareContext({ ...ctx, signal: undefined, isCurrent: () => false })).stale, true)
  current = true
  await service.prepareContext({ ...ctx, signal: undefined })
  repo.deleteEvidence(f.evidenceIds[0], meta(A))
  assert.equal(service.contextFor(ctx, ctx.sessionId), '', 'Evidence tombstone invalidates a cached fact without a vector delete')
  fact('新的咖啡')
  const waiting = barrier(), release = barrier(), cancelled = new AbortController()
  state.hold = async body => { if (body.input?.includes('提神饮料')) { waiting.resolve(); await release.promise } }
  const preparing = service.prepareContext({ ...ctx, text: '提神饮料', signal: cancelled.signal })
  await waiting.promise; cancelled.abort(); release.resolve()
  assert.equal((await preparing).aborted, true)
  assert.equal(service.contextFor(ctx, ctx.sessionId), '')
})

test('real Hook runtime normal completion preserves a warmed sync context; epoch invalidation suppresses it', async t => {
  const { service, fact, index } = await fixture(t)
  fact('小明喜欢咖啡'); await service.initialize(); await index()
  let epoch = 1
  const record = {}, listeners = new Map(), live = new Map([['memory', record]])
  listeners.set('context/prepare', [{ id: 'memory', record, order: 0, fn: (ctx, execution) => service.prepareContext({ ...ctx, signal: execution.signal, isCurrent: execution.isCurrent }) }])
  const runtime = createHookRuntime({ listeners, live, epochs: { current: () => epoch }, note() {} })
  const ctx = { account: A.account, chatId: A.chat, sessionId: 'runtime', text: '咖啡', persona: A.persona }
  await runtime.prepare('context/prepare', ctx)
  assert.match(service.contextFor(ctx, ctx.sessionId), /咖啡/)
  assert.equal(runtime.diagnostics().recent[0].ok, true)
  epoch++
  assert.equal(service.contextFor(ctx, ctx.sessionId), '')
})

test('occurrence-level image indexing combines description, visual and admitted joint channels without sharing private captions', async t => {
  const { service, index, addImage, imageRows } = await fixture(t, { images: true })
  addImage('public-occurrence', A)
  addImage('private-occurrence', P, '私聊周年纪念照片')
  await service.initialize(); await index(A, 'image'); await index(P, 'image')
  const result = await service.queryImages({ scope: A, query: '红色裙子', image: { url: 'https://mock.test/red-query.png' } })
  assert.deepEqual(result.hits.map(hit => hit.id), ['public-occurrence'])
  assert.ok(result.hits[0].channels.lexical && result.hits[0].channels.text && result.hits[0].channels.visual && result.hits[0].channels.joint)
  assert.equal(result.hits[0].assetId, 'same-red-asset'); assert.equal(result.hits[0].occurrenceId, 'public-occurrence')
  assert.ok(!JSON.stringify(result).includes('周年纪念'))
  imageRows.get('public-occurrence').deleted = true
  assert.deepEqual(service.finalGuard(result.hits, { scope: A, kind: 'image' }), [])
  await service.deleteSources({ scope: A, kind: 'image', ids: ['public-occurrence'] })
  assert.deepEqual((await service.queryImages({ scope: A, query: '红色裙子' })).hits, [])
  assert.equal((await service.queryImages({ scope: P, query: '周年纪念' })).hits[0].id, 'private-occurrence')
})

test('durable jobs and admission baselines recover after service reopen; async rebuild keeps g0 serving then publishes complete g1', async t => {
  const { service, create, fact, state, repo } = await fixture(t)
  const first = fact('小明喜欢咖啡')
  const queued = await service.enqueueIndex({ scope: A, idempotencyKey: 'first-import' })
  assert.equal((await service.job(queued.jobId)).state, 'queued')
  await service.close()
  const reopened = await create()
  await reopened.initialize(); await reopened.waitForIdle()
  assert.equal((await reopened.job(queued.jobId)).state, 'succeeded')
  const entered = barrier(), release = barrier()
  state.hold = async body => { if (body.input?.includes(first.text)) { entered.resolve(); await release.promise } }
  const rebuilding = await reopened.rebuild({ scopes: [A], generation: 'g1' })
  await entered.promise
  assert.equal((await reopened.index.health()).spaces[0].generation, 'g0')
  const added = fact('后来喜欢蓝色杯子')
  repo.remove(first.id, meta(A))
  release.resolve(); await reopened.waitForIdle()
  const status = await reopened.job(rebuilding.jobId)
  assert.equal(status.state, 'succeeded', status.error)
  assert.equal((await reopened.index.health()).spaces[0].generation, 'g1')
  assert.equal((await reopened.recall({ scope: A, query: '蓝色杯子' })).hits[0].id, added.id)
  state.drift = true
  const probe = await reopened.probe()
  assert.equal(probe.text.needsRebuild, true)
  assert.equal((await reopened.index.health()).spaces[0].needsRebuild, true)
})

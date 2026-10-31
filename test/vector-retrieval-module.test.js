import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import retrieval, { RETRIEVAL_DEFAULTS, RETRIEVAL_CONFIG_SCHEMA, RETRIEVAL_SECRET_FIELDS, normalizeRetrievalConfig } from '../src/modules/retrieval/index.js'
import { createModules } from '../src/core/modules.js'
import { createStorage } from '../src/storage/index.js'
import { createMemoryStore } from '../src/memory/index.js'
import { createMediaAnalysis } from '../src/runtime/media-analysis.js'
import { createMemorySourceRepository, createImageSourceRepository } from '../src/memory/vector/integration/source-repository.js'
import { createSourceOutbox } from '../src/memory/vector/integration/source-outbox.js'
import { mappingFingerprint } from '../src/memory/embedding/index.js'
import { HttpReranker } from '../src/memory/vector/integration/reranker.js'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { png } from './helpers/images.js'

const S = { account: 'bot', chat: 'group:1', persona: '' }, T = { ...S, chat: 'group:2' }, P = { ...S, chat: 'private:user' }
const space = (id, modalities = ['text'], extra = {}) => ({ spaceId: id, provider: 'test', endpointIdentity: 'loopback-only', model: id, revision: 'v1', dims: 3, metric: 'cosine', modalities, prefixes: { query: '', document: '' }, normalization: 'none', preprocess: { text: { version: '1' } }, protocolMappingVersion: 'openai-text-v1', ...extra })
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const meta = scope => ({ scope, actorId: 'owner', reason: 'test' })

async function fixture(t, { enabled = true, embeddings = false, maxCandidates = 5000 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'aurabot-retrieval-module-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const storage = createStorage({ file: join(dir, 'source.sqlite'), filesDir: join(dir, 'assets') })
  const cfg = { botQQ: 'bot', ownerQQ: 'owner', modules: {}, memory: { enabled: true, shareGroups: [] }, retrieval: normalizeRetrievalConfig({ enabled, retrieval: { maxCandidates }, sync: { intervalMs: 3600000, pageSize: 3 } }) }
  const state = { requests: [], fail: false, hold: null, rerankResponse: null, usageResponse: null, usageThrow: false }, usage = []
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw); state.requests.push({ url: req.url, body })
    if (state.hold) await state.hold(body)
    if (state.fail) { res.writeHead(503); res.end('{"error":"do-not-leak-secret"}'); return }
    if (req.url === '/rerank') {
      const response = state.rerankResponse ? state.rerankResponse(body) : { model: body.model, results: body.documents.map((_, index) => ({ index, score: index + 1 })) }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response)); return
    }
    const values = (body.input ?? body.inputs).map(item => /咖啡|提神/.test(typeof item === 'string' ? item : '') ? [0, 1, 0] : [1, 0, 0])
    const output = req.url === '/embeddings' ? { model: body.model, data: values.map((embedding, index) => ({ index, embedding })), ...(state.usageResponse ? { usage: state.usageResponse } : {}) } : { model: body.model, revision: 'v1', vectors: values }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(output))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  if (embeddings) cfg.retrieval.roles.text = { type: 'openai-text', space: space('text'), baseUrl, apiKey: 'private-test-key' }
  const memory = createMemoryStore({ storage, getConfig: () => cfg, getAccount: () => cfg.botQQ, legacyDir: join(dir, 'no-legacy') })
  const hubState = { chat: S.chat, persona: '', requests: [] }
  const hub = { selfId: 'bot', turnPersona: () => ({ personaId: hubState.persona }), chatOfSession: () => hubState.chat,
    turnRequests: () => hubState.requests, turnActor: () => ({ actorId: hubState.requests[0]?.actorId, requestId: hubState.requests[0]?.id }), speakersOf: () => [] }
  const logger = { child() { return this }, info() {}, warn() {}, error() {}, debug() {} }
  const fake = createFakeDsh({ brain: async () => { throw new Error('No paid/model call allowed in this fixture') } })
  const mediaSource = { current: null }
  const modules = createModules({ ctx: fake.ctx, core: { hub, storage, http: { query: req => req.input, body: async req => req.input },
    usage: { record(entry) { usage.push(structuredClone(entry)); if (state.usageThrow) throw new Error('usage unavailable') } } },
    getConfig: () => cfg, setConfig: value => Object.assign(cfg, value), logger, version: 'test', builtins: [{ id: 'memory', setup: () => memory },
      { id: 'media-memory', setup: () => ({ settings: () => mediaSource.current?.settings(), visible: input => mediaSource.current?.visible(input) }) }, retrieval] })
  await modules.boot()
  const api = modules.use('retrieval')
  assert.ok(api, JSON.stringify(modules.status()))
  await api.ready
  t.after(async () => {
    state.hold = null
    await modules.dispose(); fake.dispose(); storage.close()
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = previous
  })
  const panel = (path, input = {}, method = 'POST') => modules.handle(`/aurabot/api/retrieval/${path}`, { method, input })
  const fact = (text, scope = S) => memory.create({ scope, text, subject: 'user', predicate: 'likes', value: text, speakerId: 'user', polarity: 'positive', modality: 'asserted', conditions: [], eventTime: null, validFrom: null, validTo: null, status: 'active', stability: 'stable', slot: 'multi', profileSection: 'preferences', manualEvidence: { kind: 'manual', text, speakerId: 'user', actorId: 'owner', sourceId: randomUUID() } }).item
  const image = (scope = S, actor = 'user', salt = 0) => {
    const message = storage.messages.ingest({ account: scope.account, chatId: scope.chat, eventKind: 'message', authorId: actor, text: '红色裙子', segments: [] })
    const asset = storage.assets.put(png(2, 3, salt), { mime: 'image/png', sourceKind: 'incoming' })
    const occurrenceId = storage.occurrences.add({ messageId: message.id, chatId: scope.chat, authorId: actor, kind: 'image', segIndex: 0, scope })
    storage.occurrences.ready(occurrenceId, asset.id, { description: '红色裙子' })
    return { occurrenceId, assetId: asset.id, message, asset }
  }
  const request = (scope = S, actorId = 'user') => {
    const message = storage.messages.ingest({ account: scope.account, chatId: scope.chat, eventKind: 'message', authorId: actorId, text: '请画图', segments: [] })
    const req = storage.requests.create({ chatId: scope.chat, actorId, sourceMessageIds: [message.id] })
    hubState.requests = [req]; hubState.chat = scope.chat; hubState.persona = scope.persona
    return { account: scope.account, chatId: scope.chat, personaId: scope.persona, actorId, requestId: req.id }
  }
  return { dir, storage, cfg, state, baseUrl, memory, modules, api, panel, fact, image, request, hubState, mediaSource, usage }
}

test('builtin setup stays synchronous; disabled creates no worker/outbox/index and exposes normalized schema without path', async t => {
  const f = await fixture(t, { enabled: false, embeddings: true })
  assert.equal(typeof f.api.then, 'undefined')
  assert.equal(f.api.status().ready, false)
  assert.equal(existsSync(join(f.dir, 'modules-data', 'retrieval')), false)
  assert.equal(f.storage.db.get("SELECT name FROM sqlite_master WHERE name='retrieval_source_outbox'"), undefined)
  assert.equal(f.state.requests.length, 0)
  assert.equal(RETRIEVAL_DEFAULTS.enabled, false)
  const normalized = normalizeRetrievalConfig({ enabled: true, index: { path: f.storage.db.file, backend: 'local', pageSize: -1 }, sync: { pageSize: 9999 } })
  assert.equal(normalized.index.path, undefined); assert.equal(normalized.index.pageSize, 1); assert.equal(normalized.sync.pageSize, 500)
  assert.equal(RETRIEVAL_CONFIG_SCHEMA.properties.index.properties.path, undefined)
  assert.equal(RETRIEVAL_SECRET_FIELDS.length, 5)
  const schema = await f.panel('schema', {}, 'GET'); assert.equal(schema.ok, true)
  assert.equal((await f.panel('probe', {}, 'GET')).code, 'METHOD_NOT_ALLOWED')
  for (const file of retrieval.files) assert.ok((await stat(resolve('src', file))).isFile(), file)
})

test('real module hook injects prepared evidence only into this turn; tombstones, scope and epoch invalidate it', async t => {
  const f = await fixture(t)
  const row = f.fact('小明喜欢咖啡'), chat = { chatId: S.chat, kind: 'group' }
  assert.equal(f.api.status().lastError, null)
  await f.modules.prepareContext({ chat, chatId: S.chat, sessionId: 's', text: '咖啡', account: 'bot', persona: '' })
  const content = [{ type: 'text', text: '原文' }]
  const prompt = (chat, text = '咖啡') => f.modules.filter('prompt/prepared', content, { chat, sessionId: 's', text })
  const result = await prompt(chat)
  assert.match(result[0].text, /小明喜欢咖啡/); assert.equal(result[1].text, '原文')
  assert.equal(f.modules.contextFor({ chat, sessionId: 's' }), '')
  assert.deepEqual(await prompt({ ...chat, chatId: P.chat }), content)
  assert.deepEqual(await prompt(chat, '不匹配的查询'), content)
  f.memory.remove(row.id, meta(S))
  assert.deepEqual(await prompt(chat), content)
  f.fact('新的咖啡事实')
  await f.modules.prepareContext({ chat, chatId: S.chat, sessionId: 's', text: '咖啡', account: 'bot', persona: '' })
  f.storage.epochs.bump(S.chat)
  assert.deepEqual(await prompt(chat), content)
  f.cfg.retrieval.enabled = false
  await f.api.ensureReady()
  assert.equal(f.api.status().ready, false)
  assert.equal(f.state.requests.length, 0)
})

test('slow foreground embedding yields lexical evidence within budget and records request scope', async t => {
  const f = await fixture(t, { embeddings: true })
  f.fact('小明喜欢咖啡')
  await f.panel('probe', { roles: ['text'] })
  const service = (await f.api.ensureReady()).service
  await service.waitForIdle()
  const release = gate()
  f.state.hold = () => release.promise
  const started = performance.now()
  try {
    await f.modules.prepareContext({ chat: { chatId: S.chat, kind: 'group' }, chatId: S.chat, sessionId: 'bounded', text: '咖啡', account: 'bot', persona: '', requestId: 'foreground-request' })
    assert.ok(performance.now() - started < 2000, 'front reply must not await provider timeout')
    const out = await f.modules.filter('prompt/prepared', [{ type: 'text', text: '原文' }], { chat: { chatId: S.chat }, sessionId: 'bounded', text: '咖啡' })
    assert.match(out[0].text, /小明喜欢咖啡/)
    assert.ok(f.usage.some(u => u.requestId === 'foreground-request' && u.chatId === S.chat))
  } finally { release.resolve(); f.state.hold = null }
})

test('twenty prepared retrieval turns contain only current-query evidence and no system snapshots', async t => {
  const f = await fixture(t)
  f.fact('小明喜欢咖啡'); f.fact('小明喜欢登山')
  const chat = { chatId: S.chat, kind: 'group' }
  for (let i = 0; i < 20; i++) {
    const query = i % 2 ? '登山' : '咖啡'
    await f.modules.prepareContext({ chat, chatId: S.chat, sessionId: 'twenty', text: query, account: 'bot', persona: '' })
    const output = await f.modules.filter('prompt/prepared', [{ type: 'text', text: `本轮 ${i}` }], { chat, sessionId: 'twenty', text: query })
    assert.equal(output.length, 2)
    assert.match(output[0].text, new RegExp(query))
    assert.doesNotMatch(output[0].text, new RegExp(i % 2 ? '咖啡' : '登山'))
    assert.equal(output[1].text, `本轮 ${i}`)
    assert.equal(f.modules.contextFor({ chat, sessionId: 'twenty' }), '')
  }
  assert.equal(f.state.requests.length, 0, 'no embedding or model service was called')
})

test('history image refs return provenance, recheck actor/shareGroups/recall and never expose a filesystem path', async t => {
  const f = await fixture(t), mine = f.image(), others = f.image(S, 'other', 3), privateImage = f.image(P, 'user', 5), context = f.request()
  const result = await f.api.materializeReference({ occurrenceId: mine.occurrenceId, role: 'identity' }, context)
  assert.equal(result.sourceActor, 'user'); assert.equal(result.assetId, mine.assetId); assert.equal(result.generatedJobId, null)
  assert.equal(result.sourceMessageId, mine.message.id); assert.equal(result.occurrenceId, mine.occurrenceId)
  assert.ok(!JSON.stringify(result).includes(f.dir)); assert.ok(!JSON.stringify(result).includes('data:image'))
  await assert.rejects(f.api.materializeReference({ occurrenceId: others.occurrenceId }, context), { code: 'REFERENCE_ACTOR_MISMATCH' })
  await assert.rejects(f.api.materializeReference({ occurrenceId: privateImage.occurrenceId }, context), { code: 'IMAGE_NOT_VISIBLE' })
  assert.equal((await f.panel('reference/materialize', { chatId: S.chat, occurrenceId: others.occurrenceId })).ok, true)
  f.cfg.memory.shareGroups = [{ chats: [S.chat, P.chat], categories: ['fact'] }]
  await assert.rejects(f.api.materializeReference({ occurrenceId: privateImage.occurrenceId }, context), { code: 'IMAGE_NOT_VISIBLE' })
  f.cfg.memory.shareGroups = [{ chats: [S.chat, P.chat], categories: ['image'] }]
  const shared = await f.api.materializeReference({ occurrenceId: privateImage.occurrenceId, role: 'style' }, context)
  f.cfg.memory.shareGroups = []
  assert.throws(() => f.api.assertReferences([shared], context), { code: 'IMAGE_NOT_VISIBLE' })
  f.storage.db.run('UPDATE messages SET recalled_at=? WHERE id=?', Date.now(), mine.message.id)
  assert.throws(() => f.api.assertReferences([result], context), { code: 'IMAGE_NOT_VISIBLE' })
  const images = await f.panel('images', { chatId: S.chat, query: '红色裙子' })
  assert.equal(images.ok, true); assert.ok(images.hits.some(hit => hit.occurrenceId === others.occurrenceId)); assert.ok(!images.hits.some(hit => hit.occurrenceId === mine.occurrenceId))
  assert.ok(images.hits.every(hit => 'sourceActor' in hit && 'generation' in hit && !('it' in hit)))
  assert.equal((await f.panel('images', { chatId: S.chat, image: { url: 'file:///secret' } })).code, 'OCCURRENCE_REQUIRED')
  assert.equal(f.state.requests.length, 0)
})

test('generated image ownership comes from jobs.actor_id and lineage; asset corruption and unavailable assets fail closed', async t => {
  const f = await fixture(t), context = f.request(), asset = f.storage.assets.put(png(4, 5, 10), { mime: 'image/png', sourceKind: 'generated' })
  f.storage.db.run("INSERT INTO jobs(id,kind,chat_id,actor_id,epoch,state,input_json,trace_id,created_at,updated_at) VALUES('gen','image',?,'user',0,'done',?,'trace',1,1)", S.chat, JSON.stringify({ accountId: 'bot' }))
  const id = f.storage.occurrences.add({ chatId: S.chat, authorId: 'bot', segIndex: 0, kind: 'image', scope: S, remote: { jobId: 'gen' } })
  f.storage.occurrences.ready(id, asset.id, { description: '生成的图片' })
  await assert.rejects(f.api.materializeReference({ occurrenceId: id }, context), { code: 'IMAGE_NOT_VISIBLE' })
  f.storage.db.run("INSERT INTO generation_lineage VALUES('gen',NULL,'[]',?,'test','{}')", JSON.stringify([asset.id]))
  const reference = await f.api.materializeReference({ occurrenceId: id }, context)
  assert.equal(reference.sourceActor, 'user'); assert.equal(reference.generatedJobId, 'gen'); assert.equal(reference.generation.jobId, 'gen')
  f.storage.db.run("UPDATE jobs SET actor_id='other' WHERE id='gen'")
  assert.throws(() => f.api.assertReferences([reference], context), { code: 'REFERENCE_ACTOR_MISMATCH' })
  f.storage.db.run("UPDATE jobs SET actor_id='user' WHERE id='gen'")
  const serviceState = await f.api.ensureReady(), load = serviceState.imageRepo.loadImage
  serviceState.imageRepo.loadImage = async (...args) => { f.storage.db.run("UPDATE jobs SET actor_id='other' WHERE id='gen'"); return load(...args) }
  await assert.rejects(f.api.materializeReference({ occurrenceId: id }, context), { code: 'REFERENCE_ACTOR_MISMATCH' }, 'Ownership must be checked again after the async file read')
  serviceState.imageRepo.loadImage = load
  f.storage.db.run("UPDATE jobs SET actor_id='user' WHERE id='gen'")
  await writeFile(f.storage.assets.pathOf(asset), Buffer.alloc(asset.bytes))
  await assert.rejects(f.api.materializeReference({ occurrenceId: id }, context), { code: 'INVALID_IMAGE_SOURCE' })
  f.storage.db.run("UPDATE assets SET state='deleted' WHERE id=?", asset.id)
  assert.throws(() => f.api.assertReferences([reference], context), { code: 'IMAGE_NOT_VISIBLE' })
})

test('explicit loopback probe enables durable incremental indexing and hybrid tools; startup/health never probes', async t => {
  const f = await fixture(t, { embeddings: true })
  f.cfg.retrieval.index.path = f.storage.db.file // Normalization must discard even a late UI-injected primary path.
  const row = f.fact('小明喜欢咖啡'), privateFact = f.fact('私密咖啡', P)
  const state = await f.api.ensureReady()
  assert.ok(state.service.config.index.path.startsWith(join(f.dir, 'modules-data', 'retrieval')))
  await f.panel('health', {}, 'GET'); await f.panel('sync', { chatId: S.chat })
  assert.equal(f.state.requests.length, 0)
  assert.equal(f.storage.db.get('SELECT state FROM retrieval_source_outbox WHERE source_id=?', row.id).state, 'pending')
  const probe = await f.panel('probe', { roles: ['text'] }); assert.equal(probe.ok, true)
  await state.service.waitForIdle(); assert.equal((await state.service.job(probe.jobId)).state, 'succeeded')
  for (let i = 0; i < 4; i++) { await f.panel('sync', { chatId: S.chat }); await state.service.waitForIdle() }
  assert.equal(f.storage.db.get('SELECT state FROM retrieval_source_outbox WHERE source_id=?', row.id).state, 'accepted')
  const result = await f.panel('query', { chatId: S.chat, query: '提神饮料' })
  assert.equal(result.hits[0].id, row.id); assert.ok(result.hits[0].channels.text); assert.ok(!result.hits.some(hit => hit.id === privateFact.id))
  f.request()
  const tools = f.modules.buildTools({ chat: { kind: 'group', chatId: S.chat }, sessionId: 's' })
  const tool = tools.find(tool => tool.name === 'recall_memory_scoped')
  const hit = await tool.execute({ query: '提神饮料', account: 'other', chatId: P.chat })
  assert.equal(hit.ok, true); assert.equal(hit.scope.chat, S.chat)
  f.cfg.botQQ = 'different'
  assert.equal((await tool.execute({ query: '咖啡' })).code, 'STALE_CONTEXT')
})

test('source outbox is transactional, CAS acknowledged, idempotent across bridge restart, and hides tombstones before cleanup', async t => {
  const f = await fixture(t, { embeddings: true }), state = await f.api.ensureReady()
  const before = f.storage.db.get('SELECT COUNT(*) n FROM retrieval_source_outbox').n
  assert.throws(() => f.storage.tx(() => { f.fact('必须回滚'); throw new Error('rollback') }), /rollback/)
  assert.equal(f.storage.db.get('SELECT COUNT(*) n FROM retrieval_source_outbox').n, before)
  const row = f.fact('要修改的咖啡')
  const entered = gate(), release = gate(), receipts = []
  const stub = { _roles: () => ['text'], encoders: new Map([['text', { health: () => ({ ready: true }) }]]),
    async enqueueIndex(input) { receipts.push(input); entered.resolve(); await release.promise; return { jobId: input.idempotencyKey, state: 'queued' } } }
  const outbox = createSourceOutbox({ storage: f.storage, repo: state.repo, imageRepo: state.imageRepo, service: stub, target: 'test-target', getAccount: () => 'bot' })
  const draining = outbox.drain(); await entered.promise
  f.memory.remove(row.id, meta(S)); release.resolve(); await draining
  assert.equal(f.storage.db.get('SELECT state FROM retrieval_source_outbox WHERE source_id=?', row.id).state, 'pending')
  assert.deepEqual((await f.panel('query', { chatId: S.chat, query: '咖啡' })).hits, [])
  await outbox.drain()
  const receipt = f.storage.db.get('SELECT * FROM retrieval_source_outbox WHERE source_id=?', row.id)
  assert.equal(receipt.state, 'accepted')
  // Simulate crash after enqueue committed in derived DB, before primary accepted CAS.
  f.storage.db.run("UPDATE retrieval_source_outbox SET state='pending' WHERE id=?", receipt.id)
  const reopened = createSourceOutbox({ storage: f.storage, repo: state.repo, imageRepo: state.imageRepo, service: stub, target: 'test-target', getAccount: () => 'bot' })
  await reopened.drain()
  assert.equal(receipts.at(-1).idempotencyKey, receipts.at(-2).idempotencyKey)
  await outbox.stop(); await reopened.stop()
})

test('paged rebuild exceeds recall candidate cap, keeps bounded recall explicit and streams lazy image bytes through HTTP mapping', async t => {
  const f = await fixture(t, { embeddings: true, maxCandidates: 3 })
  for (let i = 0; i < 270; i++) f.fact(`咖啡 ${i}`)
  const state = await f.api.ensureReady()
  const job = await f.panel('rebuild', { role: 'text', scopes: [{ chatId: S.chat }], generation: 'large-paged' })
  assert.equal(job.ok, true)
  await state.service.waitForIdle()
  assert.equal((await state.service.job(job.jobId)).state, 'succeeded', JSON.stringify(await state.service.job(job.jobId)))
  const health = await state.service.health(); assert.equal(health.index.spaces[0].records, 270); assert.equal(health.index.spaces[0].generation, 'large-paged')
  const query = await f.panel('query', { chatId: S.chat, query: '咖啡' })
  assert.equal(query.truncated, true); assert.equal(query.candidateCount, 3)
  const mapping = { version: 'images-v1', path: '/encode', modelField: 'model', modalityField: 'modality', inputs: { image: { field: 'inputs', itemField: 'url', representation: 'data-url' } }, response: { vectorsPath: 'vectors', modelPath: 'model', revisionPath: 'revision' } }
  const encoded = `data:image/png;base64,${png().toString('base64')}`
  f.cfg.retrieval.roles.image = { type: 'fixed-http', baseUrl: f.baseUrl, space: space('images', ['image'], { protocolMappingVersion: 'images-v1', preprocess: { image: { version: '1', mode: 'passthrough' }, protocolMappingFingerprint: mappingFingerprint(mapping) } }), mapping, samples: { image: [encoded, encoded] } }
  const img = f.image(), fresh = await f.api.ensureReady()
  const imageJob = await f.panel('rebuild', { role: 'image', scopes: [{ chatId: S.chat }], generation: 'images-ready' })
  await fresh.service.waitForIdle()
  assert.equal((await fresh.service.job(imageJob.jobId)).state, 'succeeded', JSON.stringify(await fresh.service.job(imageJob.jobId)))
  const requests = f.state.requests.filter(req => req.url === '/encode')
  assert.ok(requests.length > 0); assert.ok(requests.every(req => req.body.inputs.every(item => item.url.startsWith('data:image/png;base64,'))))
  const usage = f.usage.filter(entry => entry.role === 'image')
  assert.equal(usage.length, requests.length); assert.ok(usage.every(entry => entry.inputChars === null && entry.inputTokens === null))
  const hits = await f.panel('images', { chatId: S.chat, occurrenceId: img.occurrenceId })
  assert.equal(hits.hits[0].occurrenceId, img.occurrenceId)
  assert.ok(!JSON.stringify(hits).includes('data:image')); assert.ok(!JSON.stringify(hits).includes(f.dir))
})

test('failed/cancelled panel jobs can be inspected and explicitly retried; validators report safe detail', async t => {
  const f = await fixture(t, { embeddings: true }), state = await f.api.ensureReady()
  f.state.fail = true
  const probe = await f.panel('probe', { roles: ['text'] }); await state.service.waitForIdle()
  const failed = await f.panel('job', { id: probe.jobId }, 'GET')
  assert.equal(failed.job.state, 'failed'); assert.equal(failed.job.error, 'HTTP_ERROR')
  assert.ok(!JSON.stringify(failed).includes('private-test-key')); assert.ok(!JSON.stringify(failed).includes('do-not-leak-secret'))
  f.state.fail = false
  await f.panel('retry', { jobId: probe.jobId }); await state.service.waitForIdle()
  assert.equal((await state.service.job(probe.jobId)).state, 'succeeded')
  const entered = gate(), release = gate()
  f.state.hold = async () => { entered.resolve(); await release.promise }
  const slow = await f.panel('probe', { roles: ['text'] }); await entered.promise
  const canceled = await f.panel('cancel', { jobId: slow.jobId }); assert.equal(canceled.job.state, 'cancelled')
  release.resolve(); f.state.hold = null; await state.service.waitForIdle()
  await f.panel('retry', { jobId: slow.jobId }); await state.service.waitForIdle()
  assert.equal((await state.service.job(slow.jobId)).state, 'succeeded')
  f.cfg.retrieval.roles.text.space.dims = 0
  const invalid = await f.panel('health', {}, 'GET')
  assert.equal(invalid.ok, false); assert.ok(invalid.code); assert.match(invalid.message, /dims/)
})

test('fixed HTTP reranker receives only visible text, reorders fused results, falls back and rechecks sources after the response', async t => {
  const f = await fixture(t)
  f.fact('小明喜欢咖啡'); f.fact('小明今天喝咖啡'); const hidden = f.fact('私聊咖啡秘密', P)
  const before = await f.panel('query', { chatId: S.chat, query: '咖啡' })
  assert.equal(before.hits.length, 2)
  f.cfg.retrieval.reranker = { enabled: true, endpoint: `${f.baseUrl}/rerank`, model: 'independent-cross-encoder', apiKey: 'rerank-private-key', timeoutMs: 1000, maxCandidates: 40, budget: { maxCallsPerMinute: 20, maxInputChars: 32000, maxConcurrent: 1 } }
  await f.api.ensureReady(); await f.panel('health', {}, 'GET')
  assert.equal(f.state.requests.length, 0, 'Health/config/init never call a reranker')
  const result = await f.panel('query', { chatId: S.chat, query: '咖啡' })
  assert.equal(result.hits[0].id, before.hits[1].id)
  assert.equal(result.hits[0].rerank.score, 2)
  assert.equal(result.hits[0].score, before.hits[1].score, 'Fusion and reranker scores remain distinct')
  const request = f.state.requests[0].body
  assert.deepEqual(Object.keys(request).sort(), ['documents', 'model', 'query'])
  assert.ok(request.documents.every(doc => typeof doc === 'string' && !doc.includes(hidden.text)))
  assert.equal(request.model, 'independent-cross-encoder')
  f.state.rerankResponse = () => ({ results: [{ index: 0, score: 1 }, { index: 0, score: 2 }] })
  const fallback = await f.panel('query', { chatId: S.chat, query: '咖啡' })
  assert.deepEqual(fallback.hits.map(hit => hit.id), before.hits.map(hit => hit.id))
  assert.ok(fallback.degraded.some(item => item.channel === 'reranker' && item.reason === 'INVALID_RERANK_RESPONSE'))
  f.state.rerankResponse = null
  const entered = gate(), release = gate()
  f.state.hold = async body => { if (body.documents) { entered.resolve(); await release.promise } }
  const waiting = f.panel('query', { chatId: S.chat, query: '咖啡' }); await entered.promise
  f.memory.remove(before.hits[1].id, meta(S)); release.resolve(); f.state.hold = null
  const gated = await waiting
  assert.ok(!gated.hits.some(hit => hit.id === before.hits[1].id), 'Deletion during reranking cannot reach the final result')
  f.state.fail = true
  const failed = await f.panel('query', { chatId: S.chat, query: '咖啡' })
  assert.equal(failed.hits.length, 1); assert.ok(failed.degraded.some(item => item.reason === 'HTTP_ERROR'))
  assert.ok(!JSON.stringify(await f.panel('health', {}, 'GET')).includes('rerank-private-key'))
  f.cfg.retrieval.reranker.budget.maxCallsPerMinute = 0
  await f.api.ensureReady()
  const calls = f.state.requests.length, budgeted = await f.panel('query', { chatId: S.chat, query: '咖啡' })
  assert.ok(budgeted.degraded.some(item => item.reason === 'RERANK_CALL_BUDGET')); assert.equal(f.state.requests.length, calls)
})

test('reranker validates complete finite indexed scores and enforces input/concurrency/time budgets', async t => {
  const f = await fixture(t)
  const config = { enabled: true, endpoint: `${f.baseUrl}/rerank`, model: 'rr', timeoutMs: 1000, maxCandidates: 3, budget: { maxCallsPerMinute: 40, maxInputChars: 500, maxConcurrent: 1 } }
  const ranker = new HttpReranker(config)
  const input = { query: '咖啡', documents: ['咖啡 A', '咖啡 B'] }
  for (const results of [[], [{ index: 0, score: 1 }], [{ index: 0, score: 1 }, { index: 2, score: 2 }], [{ index: 0, score: 1 }, { index: 1, score: '2' }], [{ index: 0.1, score: 1 }, { index: 1, score: 2 }], [{ index: 0, score: 1 }, { index: 1, score: Infinity }]]) {
    f.state.rerankResponse = () => ({ results })
    await assert.rejects(ranker.rank(input), { code: 'INVALID_RERANK_RESPONSE' })
  }
  f.state.rerankResponse = () => ({ model: 'wrong', results: [{ index: 0, score: 1 }, { index: 1, score: 2 }] })
  await assert.rejects(ranker.rank(input), { code: 'INVALID_RERANK_RESPONSE' })
  f.state.rerankResponse = null
  const calls = f.state.requests.length
  await assert.rejects(ranker.rank({ ...input, query: 'a'.repeat(501) }), { code: 'RERANK_INPUT_BUDGET' })
  assert.equal(f.state.requests.length, calls)
  const entered = gate(), release = gate()
  f.state.hold = async () => { entered.resolve(); await release.promise }
  const running = ranker.rank(input); await entered.promise
  await assert.rejects(ranker.rank(input), { code: 'RERANK_CALL_BUDGET' })
  release.resolve(); await running
  const timed = new HttpReranker({ ...config, timeoutMs: 15 }), barrier = gate()
  f.state.hold = () => barrier.promise
  await assert.rejects(timed.rank(input), { code: 'HTTP_TIMEOUT' })
  barrier.resolve(); f.state.hold = null
})

test('pre-enable backfill and page cursors survive restart; tombstone cleanup does not require another paid probe', async t => {
  const f = await fixture(t, { enabled: false, embeddings: true })
  const facts = Array.from({ length: 7 }, (_, i) => f.fact(`恢复分页咖啡 ${i}`))
  f.image()
  f.cfg.retrieval.enabled = true
  let state = await f.api.ensureReady()
  await state.outbox.scan()
  const first = f.storage.db.get("SELECT * FROM retrieval_source_scans WHERE kind='fact'")
  assert.ok(first.cursor); assert.equal(first.done, 0)
  f.cfg.retrieval.enabled = false; await f.api.ensureReady()
  f.cfg.retrieval.enabled = true; state = await f.api.ensureReady()
  assert.equal(f.storage.db.get("SELECT cursor FROM retrieval_source_scans WHERE kind='fact'").cursor, first.cursor)
  for (let i = 0; i < 5; i++) await state.outbox.scan()
  assert.equal(f.storage.db.get("SELECT COUNT(*) n FROM retrieval_source_outbox WHERE kind='fact'").n, 7)
  const versions = f.storage.db.all('SELECT id,version FROM retrieval_source_outbox ORDER BY id')
  for (let i = 0; i < 4; i++) await state.outbox.scan()
  assert.deepEqual(f.storage.db.all('SELECT id,version FROM retrieval_source_outbox ORDER BY id'), versions)
  assert.equal(f.state.requests.length, 0)
  await f.panel('probe', { roles: ['text'] }); await state.service.waitForIdle()
  for (let i = 0; i < 4; i++) { await f.panel('sync'); await state.service.waitForIdle() }
  assert.equal((await state.service.health()).index.spaces[0].records, 8, 'Facts and occurrence description share the text role, with distinct IDs')
  f.memory.remove(facts[0].id, meta(S))
  f.cfg.retrieval.enabled = false; await f.api.ensureReady()
  const requests = f.state.requests.length
  f.cfg.retrieval.enabled = true; state = await f.api.ensureReady()
  assert.equal(state.service.started, false)
  await f.panel('sync'); await state.service.waitForIdle()
  assert.equal((await state.service.health()).index.spaces[0].records, 7)
  assert.equal(f.state.requests.length, requests, 'Removal cleanup is local even after admission resets')
})

test('module disposal aborts a tracked rerank request and cannot leave a late synchronous context', async t => {
  const f = await fixture(t)
  f.fact('咖啡')
  f.cfg.retrieval.reranker = { enabled: true, endpoint: `${f.baseUrl}/rerank`, model: 'rr', timeoutMs: 30000 }
  await f.api.ensureReady()
  const entered = gate(), release = gate()
  f.state.hold = async () => { entered.resolve(); await release.promise }
  const query = f.panel('query', { chatId: S.chat, query: '咖啡' }); await entered.promise
  await f.modules.stop('retrieval')
  const response = await query
  assert.equal(response.ok, false); assert.equal(response.code, 'JOB_CANCELLED')
  assert.equal(f.api.contextFor({ chatId: S.chat }, 's'), '')
  release.resolve(); f.state.hold = null
})

test('image sources consume actual media-analysis results and reject unready or misbound description/OCR', async t => {
  const f = await fixture(t), state = await f.api.ensureReady()
  f.cfg.allow = { groups: ['1', '2'] }
  f.cfg.mediaMemory = { enabled: true, minIntervalMs: 0 }
  const result = { version: 1, description: '蓝色展馆的门票', ocr: 'ORBIT739' }
  let calls = 0
  const media = createMediaAnalysis({ storage: f.storage, getConfig: () => f.cfg,
    getModel: () => ({ provider: 'local-test', model: 'vision-mock' }),
    ask: async () => { calls++; return JSON.stringify(result) } })
  f.mediaSource.current = media
  try {
    const im = f.image({ ...S, category: 'image' }), args = { chatId: S.chat, occurrenceId: im.occurrenceId }
    f.storage.occurrences.ready(im.occurrenceId, im.assetId, { width: 2, height: 3 })
    media.analyze({ ...args, expectedRevision: media.get(args).revision })
    await media.tick()
    assert.equal(calls, 1); assert.equal(media.get(args).status, 'ready')
    const stored = f.storage.occurrences.get(im.occurrenceId).analysis
    assert.deepEqual(stored.mediaMemory.result, result)
    const row = state.imageRepo.get(im.occurrenceId, S)
    assert.equal(row.description, result.description); assert.equal(row.ocr, result.ocr)
    assert.equal(row.chatText, f.storage.messages.get(im.message.id).text)
    assert.equal(row.sourceActor, 'user'); assert.equal(row.sourceMessageId, im.message.id)
    const hits = await f.panel('images', { chatId: S.chat, query: result.ocr })
    assert.equal(hits.ok, true); assert.equal(hits.hits[0].occurrenceId, im.occurrenceId)
    assert.ok(hits.hits[0].channels.lexical)
    assert.equal(state.imageRepo.get(im.occurrenceId, T), null)
    f.cfg.memory.shareGroups = [{ chats: [S.chat, T.chat], categories: ['image'] }]
    assert.equal(state.imageRepo.get(im.occurrenceId, T).description, result.description)
    assert.equal(state.imageRepo.get(im.occurrenceId, { ...T, account: 'another-bot' }), null)
    for (const patch of [{ version: 2 }, { status: 'needs_frames' }, { status: 'disabled' }, { account: 'another-bot' },
      { chatId: T.chat }, { sourceMessageId: 'another-message' }, { result: { ...result, version: 2 } }, { result: { ...result, ocr: [] } },
      { result: { ...result, description: 'FORGED-PROJECTION' } }]) {
      f.storage.db.run('UPDATE asset_occurrences SET analysis_json=? WHERE id=?',
        JSON.stringify({ description: 'STALE-LEGACY', ocr: 'STALE-OCR', mediaMemory: { ...stored.mediaMemory, ...patch } }), im.occurrenceId)
      const current = state.imageRepo.get(im.occurrenceId, S)
      assert.equal(current.description, '', JSON.stringify(patch)); assert.equal(current.ocr, '')
    }
    f.storage.db.run('UPDATE asset_occurrences SET analysis_json=? WHERE id=?', JSON.stringify(stored), im.occurrenceId)
    f.storage.db.run('UPDATE messages SET recalled_at=? WHERE id=?', Date.now(), im.message.id)
    assert.equal(state.imageRepo.get(im.occurrenceId, S), null)
    assert.equal(state.imageRepo.get(im.occurrenceId, T), null)
    assert.equal(f.state.requests.length, 0, 'Lexical retrieval must not probe or call an embedding service')
  } finally { await media.stop() }
})

test('same-millisecond media disable revokes old hits before durable outbox cleanup without changing another occurrence scope', async t => {
  const f = await fixture(t, { embeddings: true }), state = await f.api.ensureReady(), time = Date.now()
  f.cfg.allow = { groups: ['1', '2'] }
  f.cfg.mediaMemory = { enabled: true }
  const media = createMediaAnalysis({ storage: f.storage, getConfig: () => f.cfg, now: () => time,
    ask: async () => { throw new Error('Human annotation must not invoke a model') } })
  f.mediaSource.current = media
  try {
    const a = f.image({ ...S, category: 'image' }), b = f.image({ ...T, category: 'image' })
    assert.equal(a.assetId, b.assetId, 'The same bytes have distinct authorized occurrences')
    const args = im => ({ chatId: f.storage.occurrences.get(im.occurrenceId).chatId, occurrenceId: im.occurrenceId })
    for (const [im, description, ocr] of [[a, '甲馆的独立说明', 'ORBIT739'], [b, '乙馆的独立说明', 'OCEAN852']]) {
      f.storage.occurrences.ready(im.occurrenceId, im.assetId, { width: 2, height: 3 })
      media.analyze({ ...args(im), expectedRevision: media.get(args(im)).revision, analysis: { version: 1, description, ocr } })
    }
    assert.equal(f.state.requests.length, 0)
    await f.panel('probe', { roles: ['text'] }); await state.service.waitForIdle()
    await state.outbox.drain(); await state.service.waitForIdle()
    const receipt = im => f.storage.db.get("SELECT * FROM retrieval_source_outbox WHERE kind='image' AND source_id=?", im.occurrenceId)
    const priorA = receipt(a), priorB = receipt(b), revisionA = state.imageRepo.revision(S), revisionB = state.imageRepo.revision(T)
    assert.equal(priorA.state, 'accepted'); assert.equal(priorB.state, 'accepted')
    assert.equal((await state.service.job(priorA.accepted_job)).state, 'succeeded')
    assert.equal((await state.service.job(priorB.accepted_job)).state, 'succeeded')
    const oldA = await state.service.queryImages({ scope: S, query: 'ORBIT739' })
    const oldB = await state.service.queryImages({ scope: T, query: 'OCEAN852' })
    assert.equal(oldA.hits.length, 1); assert.ok(oldA.hits[0].channels.text)
    assert.equal(oldB.hits.length, 1); assert.ok(oldB.hits[0].channels.text)
    const ref = async im => (await state.service._refs({ role: 'text', kind: 'image', sourceId: im.occurrenceId }))[0]
    const oldRefA = await ref(a), oldRefB = await ref(b)
    assert.throws(() => f.storage.tx(() => {
      media.disable({ ...args(a), expectedRevision: media.get(args(a)).revision })
      throw new Error('rollback-media-disable')
    }), /rollback-media-disable/)
    assert.deepEqual(receipt(a), priorA); assert.equal(state.imageRepo.revision(S), revisionA)
    assert.equal(state.imageRepo.get(a.occurrenceId, S).ocr, 'ORBIT739')

    media.disable({ ...args(a), expectedRevision: media.get(args(a)).revision })
    const current = state.imageRepo.get(a.occurrenceId, S)
    assert.equal(current.revision, oldA.hits[0].sourceRevision, 'Wall-clock milliseconds can be identical')
    assert.equal(current.description, ''); assert.equal(current.ocr, '')
    assert.equal(current.assetId, a.assetId, 'Disabling interpretation leaves the visible original image available')
    assert.notEqual(state.imageRepo.revision(S), revisionA, 'The transactional scope clock still advances')
    assert.equal(state.imageRepo.revision(T), revisionB)
    assert.ok(receipt(a).version > priorA.version); assert.equal(receipt(a).state, 'pending')
    assert.deepEqual(receipt(b), priorB)
    assert.deepEqual(state.service.finalGuard(oldA.hits, { scope: S, kind: 'image' }), [])
    assert.equal(state.service.finalGuard(oldB.hits, { scope: T, kind: 'image' }).length, 1)
    assert.deepEqual(await ref(a), oldRefA, 'The read gate acts before asynchronous vector cleanup')
    const requestOffset = f.state.requests.length
    await state.outbox.drain(); await state.service.waitForIdle()
    assert.equal(receipt(a).state, 'accepted')
    assert.equal((await state.service.job(receipt(a).accepted_job)).state, 'succeeded')
    const newRefA = await ref(a)
    assert.notEqual(newRefA.vectorId, oldRefA.vectorId); assert.deepEqual(await ref(b), oldRefB)
    const encoder = state.service.encoders.get('text')
    const indexed = await state.service.index.query({ spaceId: encoder.space.spaceId,
      vector: { spaceId: encoder.space.spaceId, fingerprint: encoder.fingerprint, vector: [1, 0, 0] },
      authorizedIds: [oldRefA.vectorId, newRefA.vectorId, oldRefB.vectorId], filter: { account: S.account, chats: [S.chat, T.chat] }, limit: 10 })
    assert.deepEqual(new Set(indexed.hits.map(hit => hit.id)), new Set([newRefA.vectorId, oldRefB.vectorId]))
    assert.deepEqual(f.state.requests.slice(requestOffset).map(request => request.body.input), [[current.chatText]])
    media.restore({ ...args(a), expectedRevision: media.get(args(a)).revision })
    assert.equal(state.imageRepo.get(a.occurrenceId, S).description, '甲馆的独立说明', 'Restore republishes only the still-valid human edit')
    assert.equal(state.imageRepo.get(a.occurrenceId, S).ocr, 'ORBIT739')
    assert.equal(state.imageRepo.get(b.occurrenceId, T).ocr, 'OCEAN852')
    await state.outbox.drain(); await state.service.waitForIdle()
    assert.equal((await state.service.job(receipt(a).accepted_job)).state, 'succeeded')
    assert.notEqual((await ref(a)).vectorId, oldRefA.vectorId, 'Human revision gives restored text a fresh identity even with a frozen clock')
    assert.equal((await state.service.queryImages({ scope: S, query: 'ORBIT739' })).hits[0].channels.text.rank, 1)
  } finally { await media.stop() }
})

test('media text uses a synchronous live visibility gate for enabled, blocked authors, age and withdrawn sources', async t => {
  const f = await fixture(t), state = await f.api.ensureReady(), initialTime = Date.now()
  let time = initialTime
  f.cfg.mediaMemory = { enabled: true }
  const media = createMediaAnalysis({ storage: f.storage, getConfig: () => f.cfg, now: () => time,
    ask: async () => { throw new Error('No vision calls in visibility tests') } })
  f.mediaSource.current = media
  const create = () => {
    const im = f.image({ ...S, category: 'image' })
    f.storage.occurrences.ready(im.occurrenceId, im.assetId, { width: 2, height: 3 })
    const args = { chatId: S.chat, occurrenceId: im.occurrenceId }
    media.analyze({ ...args, expectedRevision: media.get(args).revision,
      analysis: { version: 1, description: '当前有效人工说明', ocr: 'VISIBLE739' } })
    return im
  }
  try {
    const im = create(), old = await state.service.queryImages({ scope: S, query: 'VISIBLE739' }), stamp = state.imageRepo.revision(S)
    assert.equal(old.hits.length, 1)
    f.cfg.mediaMemory.enabled = false
    assert.notEqual(state.imageRepo.revision(S), stamp)
    assert.equal(media.visible({ chatId: S.chat, occurrenceId: im.occurrenceId }).status, 'ready', 'Global off does not erase a human edit')
    assert.equal(state.imageRepo.get(im.occurrenceId, S).description, '')
    assert.deepEqual(state.service.finalGuard(old.hits, { scope: S, kind: 'image' }), [])
    f.cfg.mediaMemory.enabled = true
    assert.equal(state.imageRepo.get(im.occurrenceId, S).ocr, 'VISIBLE739')
    for (const unavailable of [null, { settings: () => ({ enabled: true }), visible: () => { throw new Error('stopped') } },
      { settings: () => ({ enabled: true }), visible: async () => media.visible({ chatId: S.chat, occurrenceId: im.occurrenceId }) }]) {
      f.mediaSource.current = unavailable
      assert.equal(state.imageRepo.get(im.occurrenceId, S).description, '')
      assert.deepEqual(state.service.finalGuard(old.hits, { scope: S, kind: 'image' }), [])
    }
    f.mediaSource.current = media
    assert.equal(createImageSourceRepository({ storage: f.storage }).get(im.occurrenceId, S).description, '', 'Unwired producers cannot authorize stored projections')
    for (const change of ['blocked', 'age', 'text', 'withdrawn', 'recall']) {
      const item = create(), result = await state.service.queryImages({ scope: S, query: 'VISIBLE739' })
      assert.ok(result.hits.some(hit => hit.id === item.occurrenceId))
      if (change === 'blocked') f.cfg.mediaMemory.blockedAuthors = ['user']
      if (change === 'age') { f.cfg.mediaMemory.maxAgeDays = 1; time += 2 * 86400000 }
      if (change === 'text') f.storage.db.run('UPDATE messages SET text=? WHERE id=?', 'edited source', item.message.id)
      if (change === 'withdrawn') f.storage.db.run("UPDATE messages SET event_kind='notice' WHERE id=?", item.message.id)
      if (change === 'recall') f.storage.db.run('UPDATE messages SET recalled_at=? WHERE id=?', time, item.message.id)
      const current = state.imageRepo.get(item.occurrenceId, S)
      assert.ok(!current || (current.description === '' && current.ocr === ''), change)
      assert.equal(state.service.finalGuard(result.hits.filter(hit => hit.id === item.occurrenceId), { scope: S, kind: 'image' }).length, 0, change)
      f.cfg.mediaMemory = { enabled: true }; time = initialTime
    }
    assert.equal(f.state.requests.length, 0)
  } finally { await media.stop() }
})

test('owner panel rebuild covers both unshared chats and images, keeps query scope, and rejects mixed-account spaces without mutation', async t => {
  const f = await fixture(t, { embeddings: true }), state = await f.api.ensureReady()
  const a = f.fact('甲群咖啡', S), b = f.fact('乙群咖啡', T), im = f.image(T)
  const foreign = { ...S, account: 'foreign-bot' }, other = f.fact('FOREIGN-MUST-NOT-BE-SENT', foreign)
  await f.panel('probe', { roles: ['text'] }); await state.service.waitForIdle()
  await state.outbox.drain(); await state.service.waitForIdle()
  assert.equal((await state.service.health()).index.spaces[0].records, 3)
  await assert.rejects(state.service.rebuildAccount({ account: S.account, scopes: [S] }), { code: 'OWNER_REQUIRED' })
  const rebuilt = await f.panel('rebuild', { chatId: S.chat, role: 'text', generation: 'owner-both-chats' })
  assert.equal(rebuilt.ok, true, JSON.stringify(rebuilt)); assert.equal(rebuilt.coverage, 'account'); assert.equal(rebuilt.scopeCount, 2)
  await state.service.waitForIdle()
  const job = await state.service.job(rebuilt.jobId)
  assert.equal(job.state, 'succeeded', JSON.stringify(job)); assert.equal(job.result.scopeCount, 2)
  assert.deepEqual(new Set(job.payload.scopes.map(scope => scope.chat)), new Set([S.chat, T.chat]))
  const health = await state.service.health()
  assert.equal(health.index.spaces[0].generation, 'owner-both-chats'); assert.equal(health.index.spaces[0].records, 3)
  const here = await f.panel('query', { chatId: S.chat, query: '咖啡' }), there = await f.panel('query', { chatId: T.chat, query: '咖啡' })
  assert.deepEqual(here.hits.map(hit => hit.id), [a.id]); assert.deepEqual(there.hits.map(hit => hit.id), [b.id])
  assert.equal((await f.panel('images', { chatId: T.chat, query: '红色裙子' })).hits[0].occurrenceId, im.occurrenceId)
  assert.ok(!JSON.stringify(f.state.requests).includes(other.text))
  const foreignJob = await state.service.enqueueIndex({ scope: foreign, ids: [other.id] }); await state.service.waitForIdle()
  assert.equal((await state.service.job(foreignJob.jobId)).state, 'succeeded')
  const beforeRefs = await state.service._refs({}), count = f.state.requests.length
  const rejected = await f.panel('rebuild', { chatId: S.chat, generation: 'must-not-start' })
  assert.equal(rejected.ok, false); assert.equal(rejected.code, 'REBUILD_ACCOUNT_CONFLICT')
  assert.match(rejected.message, /其他账号/); assert.equal(f.state.requests.length, count)
  assert.deepEqual(await state.service._refs({}), beforeRefs)
  const after = await state.service.health()
  assert.equal(after.index.spaces[0].generation, 'owner-both-chats'); assert.equal(after.index.spaces[0].records, 4)
  assert.equal((await state.service.recall({ scope: foreign, query: 'FOREIGN-MUST-NOT-BE-SENT' })).hits[0].id, other.id)
  assert.equal((await f.panel('rebuild', { account: foreign.account, chatId: S.chat })).code, 'ACCOUNT_CHANGED')
})

test('account changes during owner rebuild leave the serving generation and other scopes intact', async t => {
  const f = await fixture(t, { embeddings: true }), state = await f.api.ensureReady()
  f.fact('咖啡甲', S); f.fact('咖啡乙', T)
  await f.panel('probe', { roles: ['text'] }); await state.service.waitForIdle()
  await state.outbox.drain(); await state.service.waitForIdle()
  const refs = await state.service._refs({}), entered = gate(), release = gate()
  f.state.hold = async () => { entered.resolve(); await release.promise }
  const result = await f.panel('rebuild', { chatId: S.chat, generation: 'account-changed' })
  assert.equal(result.ok, true); await entered.promise
  f.cfg.botQQ = 'changed-bot'; release.resolve(); f.state.hold = null
  await state.service.waitForIdle()
  assert.equal((await state.service.job(result.jobId)).error, 'ACCOUNT_CHANGED')
  assert.deepEqual(await state.service._refs({}), refs)
  const health = await state.service.health()
  assert.equal(health.index.spaces[0].generation, 'g0'); assert.equal(health.index.spaces[0].records, 2)
})

test('usage records real probe/encode HTTP attempts with isolated scope/request metadata, no content and unknown costs', async t => {
  const f = await fixture(t, { embeddings: true }), state = await f.api.ensureReady()
  const a = f.fact('SECRET-FACT-ALPHA 咖啡', S), b = f.fact('SECRET-FACT-BETA 咖啡', T)
  await f.panel('health', {}, 'GET'); await f.panel('sync', { chatId: S.chat }); await state.service.waitForIdle()
  assert.equal(f.usage.length, 0)
  await f.panel('probe', { roles: ['text'] }); await state.service.waitForIdle()
  assert.equal(f.usage.length, 8); assert.equal(f.usage.length, f.state.requests.length)
  assert.deepEqual(f.usage.map(entry => entry.inputCount), [2, 2, 1, 1, 2, 2, 1, 1])
  assert.ok(f.usage.every(entry => entry.id.startsWith('embedding:probe:') && entry.account === S.account && entry.chatId === null && entry.requestId === null))
  assert.ok(f.usage.every(entry => entry.inputTokens === null && entry.cachedTokens === null && entry.outputTokens === null))
  await state.outbox.drain(); await state.service.waitForIdle()
  const indexed = f.usage.slice(8)
  assert.equal(indexed.length, 2)
  assert.deepEqual(new Map(indexed.map(entry => [entry.chatId, entry.inputChars])), new Map([[S.chat, a.text.length], [T.chat, b.text.length]]))
  const before = f.usage.length
  await state.outbox.drain(); await state.service.waitForIdle()
  assert.equal(f.usage.length, before, 'Idempotent/no-network work creates no usage entries')
  f.state.usageResponse = { prompt_tokens: 7, prompt_tokens_details: { cached_tokens: 3 } }
  const ca = f.request(S), cb = f.request(T), entered = gate(), release = gate()
  let calls = 0
  f.state.hold = async () => { if (++calls === 2) entered.resolve(); await release.promise }
  const queries = Promise.all([f.api.recall({ query: 'SECRET-QUERY-ALPHA 咖啡' }, ca), f.api.recall({ query: 'SECRET-QUERY-BETA 咖啡' }, cb)])
  await entered.promise; release.resolve(); f.state.hold = null
  const results = await queries; assert.ok(results.every(result => result.ok))
  const queried = f.usage.slice(before)
  assert.deepEqual(new Map(queried.map(entry => [entry.chatId, entry.requestId])), new Map([[S.chat, ca.requestId], [T.chat, cb.requestId]]))
  assert.ok(queried.every(entry => entry.inputTokens === 7 && entry.cachedTokens === 3 && entry.outputTokens === null))
  f.state.fail = true
  const fallback = await f.api.recall({ query: '咖啡' }, ca)
  assert.equal(fallback.ok, true); assert.ok(fallback.degraded.some(item => item.reason === 'HTTP_ERROR'))
  assert.equal(f.usage.at(-1).status, 'failed'); assert.equal(f.usage.at(-1).billing, 'unknown')
  f.state.fail = false; f.state.usageThrow = true
  assert.equal((await f.api.recall({ query: '咖啡' }, ca)).ok, true)
  const keys = ['id', 'service', 'model', 'role', 'account', 'chatId', 'requestId', 'status', 'billing', 'startedAt', 'durationMs',
    'inputTokens', 'outputTokens', 'cachedTokens', 'inputCount', 'inputChars', 'credits', 'amount', 'currency'].sort()
  for (const entry of f.usage) {
    assert.deepEqual(Object.keys(entry).sort(), keys)
    assert.equal(entry.billing, 'unknown'); assert.equal(entry.credits, null); assert.equal(entry.amount, null); assert.equal(entry.currency, null)
    assert.equal(entry.role, 'text'); assert.equal(entry.model, 'text'); assert.ok(entry.durationMs >= 0); assert.ok(entry.startedAt > 0)
  }
  assert.equal(f.usage.length, f.state.requests.length)
  assert.equal(new Set(f.usage.map(entry => entry.id)).size, f.usage.length)
  assert.ok(!/SECRET-|private-test-key|127\.0\.0\.1|data:image/.test(JSON.stringify(f.usage)))
})

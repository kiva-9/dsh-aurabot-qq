import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryVectorService, validateMemoryVectorConfig, MEMORY_VECTOR_CONFIG_SCHEMA } from '../src/memory/vector/integration/service.js'
import { normalizeRetrievalConfig, RETRIEVAL_CONFIG_SCHEMA } from '../src/memory/vector/integration/module-config.js'
import { createEmbeddingAdapter } from '../src/memory/embedding/index.js'

const space = { spaceId: 'numeric-probe', provider: 'loopback', endpointIdentity: 'local-tolerance-test', model: 'model', revision: 'r1', dims: 3, metric: 'cosine', modalities: ['text'], prefixes: { query: '', document: '' }, normalization: 'l2', preprocess: { text: { version: '1' } }, protocolMappingVersion: 'openai-text-v1' }
const role = { type: 'openai-text', space, baseUrl: 'http://127.0.0.1', samples: { text: ['短中文甲', '短中文乙'] } }

test('probeTolerance schema preserves the strict default and validates finite 0..0.01 without rounding', () => {
  const config = { version: 1, index: { path: ':memory:' }, roles: { text: role } }
  for (const schema of [MEMORY_VECTOR_CONFIG_SCHEMA, RETRIEVAL_CONFIG_SCHEMA]) for (const name of ['text', 'image', 'joint']) {
    assert.deepEqual(schema.properties.roles.properties[name].properties.probeTolerance, { type: 'number', minimum: 0, maximum: 0.01, default: 1e-5 })
  }
  assert.equal(validateMemoryVectorConfig(config).roles.text.probeTolerance, 1e-5)
  assert.equal(normalizeRetrievalConfig({ roles: { text: role } }).roles.text.probeTolerance, 1e-5)
  for (const value of [0, 0.0005, 0.01]) {
    const roles = { text: { ...role, probeTolerance: value } }
    assert.equal(validateMemoryVectorConfig({ ...config, roles }).roles.text.probeTolerance, value)
    assert.equal(normalizeRetrievalConfig({ roles }).roles.text.probeTolerance, value)
  }
  for (const value of [-0.0001, 0.010001, NaN, Infinity, '0.0005', null]) {
    assert.throws(() => validateMemoryVectorConfig({ ...config, roles: { text: { ...role, probeTolerance: value } } }), { code: 'INVALID_CONFIG' })
  }
})

test('service applies explicit tolerance to batch/single and persisted baseline checks, while model/dimensions remain strict', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aurabot-probe-tolerance-'))
  const state = { shift: 0, model: 'model', dims: 3 }
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw), inputs = body.input
    const jitter = inputs.length === 1 || inputs.every(value => value === inputs[0]) ? 0.0002 : 0
    const data = inputs.map((input, index) => ({ index, embedding: [1, (input.includes('甲') ? 0.2 : 0.6) + state.shift, 0.3 + jitter].slice(0, state.dims) }))
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: state.model, data }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`, services = new Set()
  t.after(async () => {
    for (const service of services) await service.close()
    await new Promise(resolve => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  })
  const create = async (file, probeTolerance) => {
    const definition = { ...role, baseUrl, ...(probeTolerance === undefined ? {} : { probeTolerance }) }
    const service = await createMemoryVectorService({ repo: { list: () => [], get: () => null, revision: () => 0 },
      config: { version: 1, index: { path: join(dir, file) }, roles: { text: definition } } })
    services.add(service); return service
  }
  const strict = await create('strict.sqlite')
  assert.equal((await strict.probe()).text.error, 'EMBEDDING_DRIFT')
  assert.equal(strict.encoders.get('text').health().reason, 'batch_or_repeat_inconsistency')
  const tolerant = await create('explicit.sqlite', 0.0005)
  assert.equal((await tolerant.probe()).text.ok, true)
  assert.equal(tolerant.encoders.get('text').baseline.tolerance, 0.0005)
  await tolerant.close()
  const reopened = await create('explicit.sqlite', 0.0005)
  assert.equal(reopened.encoders.get('text').baseline.tolerance, 0.0005)
  state.shift = 0.0002
  assert.equal((await reopened.probe()).text.ok, true, 'Persisted baseline comparison uses the configured tolerance')
  state.shift = 0.005
  assert.equal((await reopened.probe()).text.error, 'EMBEDDING_DRIFT')
  assert.equal(reopened.encoders.get('text').health().reason, 'probe_vector_changed')
  state.shift = 0; state.model = 'different-model'
  const wrongModel = await create('model.sqlite', 0.0005)
  assert.equal((await wrongModel.probe()).text.error, 'EMBEDDING_DRIFT')
  assert.equal(wrongModel.encoders.get('text').health().reason, 'provider_model_changed')
  state.model = 'model'; state.dims = 2
  const wrongDims = await create('dimensions.sqlite', 0.0005)
  assert.equal((await wrongDims.probe()).text.error, 'INVALID_VECTOR')
  await assert.rejects(createEmbeddingAdapter({ ...role, baseUrl }).probe({ tolerance: NaN }), { code: 'INVALID_PROBE' })
})

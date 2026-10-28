import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { OpenAITextEmbedding, FixedHttpEmbedding, mappingFingerprint, embeddingCacheKey, spaceFingerprint } from '../src/memory/embedding/index.js'

const textSpace = (extra = {}) => ({ spaceId: 'text-v1', provider: 'mock', endpointIdentity: 'mock-contract', model: 'model', revision: 'r1', dims: 3, metric: 'cosine', modalities: ['text'], normalization: 'none', prefixes: { query: 'query: ', document: 'document: ' }, preprocess: { text: { version: '1', unicode: 'NFC', trim: true } }, protocolMappingVersion: 'openai-text-v1', ...extra })
const mapping = { version: 'images-json-v1', path: '/encode', modelField: 'model', modalityField: 'modality', purposeField: 'purpose', inputs: { text: { field: 'texts' }, image: { field: 'images', itemField: 'url', representation: 'url' } }, response: { vectorsPath: 'output.items', vectorPath: 'values', indexPath: 'position', modelPath: 'model', revisionPath: 'revision' } }
const jointSpace = () => textSpace({ spaceId: 'joint-v1', modalities: ['text', 'image'], protocolMappingVersion: mapping.version, prefixes: { query: '', document: '' }, preprocess: { text: { version: '1' }, image: { version: '1', mode: 'passthrough' }, protocolMappingFingerprint: mappingFingerprint(mapping) } })

async function fixture(t) {
  const state = { requests: [], drift: false, model: 'model', revision: 'r1', invalid: null, duplicate: false, inconsistent: false, fail: false, delay: 0 }
  const vector = input => input.includes('red') ? [1, 0, 0] : input.includes('blue') ? [0, 1, 0] : [0.4, 0.2 + [...input].reduce((n, c) => n + c.codePointAt(0), 0) % 9 / 10, 0.1]
  const server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw)
      state.requests.push({ path: req.url, headers: req.headers, body })
      if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay))
      if (state.fail) { res.writeHead(503); res.end('upstream detail must not be exposed'); return }
      assert.equal(req.headers.authorization, 'Bearer test-only-key')
      const inputs = req.url === '/v1/embeddings' ? body.input : body.texts ?? body.images.map(i => i.url)
      const rows = inputs.map((input, index) => {
        const v = state.invalid ?? vector(input)
        if (state.drift && !state.invalid) v[2] += 0.2
        if (state.inconsistent && inputs.length === 1) v[0] += 0.3
        return { index: state.duplicate ? 0 : index, embedding: v }
      }).reverse()
      let result
      if (req.url === '/v1/embeddings') {
        assert.equal(body.encoding_format, 'float')
        result = { model: state.model, data: rows, usage: { total_tokens: inputs.length } }
      } else {
        assert.equal(req.url, '/v1/encode')
        assert.ok(['image', 'text'].includes(body.modality))
        result = { model: state.model, revision: state.revision, output: { items: rows.map(r => ({ position: r.index, values: r.embedding })) } }
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result))
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const options = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'test-only-key', space: textSpace(), timeoutMs: 1000 }
  return { options, state }
}

test('text HTTP adapter probes single/batch/repeat for both prefixes, preserves response ordering and scopes cache keys', async t => {
  const { options, state } = await fixture(t)
  const encoder = new OpenAITextEmbedding({ ...options, sendDimensions: true })
  await assert.rejects(encoder.encode({ inputs: ['red'] }), { code: 'PROBE_REQUIRED' })
  const probe = await encoder.probe()
  assert.equal(probe.ready, true); assert.equal(probe.alignment, 'not_evaluated')
  assert.equal(state.requests.length, 8)
  const output = await encoder.encode({ inputs: [' red ', 'blue'], purpose: 'query' })
  assert.deepEqual(output.vectors.map(v => [...v]), [[1, 0, 0], [0, 1, 0]])
  assert.equal(output.spaceId, options.space.spaceId)
  const body = state.requests.at(-1).body
  assert.deepEqual(body.input, ['query: red', 'query: blue']); assert.equal(body.dimensions, 3)
  await assert.rejects(encoder.encode({ inputs: ['https://image'], modality: 'image' }), { code: 'UNSUPPORTED_MODALITY' })
  assert.throws(() => new OpenAITextEmbedding({ ...options, space: jointSpace() }), { code: 'UNSUPPORTED_MODALITY' })
  const args = { space: options.space, contentHash: 'hash', modality: 'text', scope: { account: 'a', chat: 'group:1', persona: '' } }
  assert.notEqual(embeddingCacheKey(args), embeddingCacheKey({ ...args, scope: { account: 'a', chat: 'private:1' } }))
  assert.notEqual(embeddingCacheKey(args), embeddingCacheKey({ ...args, purpose: 'query' }))
  assert.throws(() => embeddingCacheKey({ ...args, scope: undefined }), { code: 'SCOPE_REQUIRED' })
})

test('admission rejects zero, wrong dimensions, non-finite JSON values, duplicate indices and inconsistent batches', async t => {
  const { options, state } = await fixture(t)
  for (const invalid of [[0, 0, 0], [1, 2], [null, 1, 0], [1e100, 1, 0]]) {
    state.invalid = invalid
    const encoder = new OpenAITextEmbedding(options)
    await assert.rejects(encoder.probe(), { code: 'INVALID_VECTOR' })
    assert.equal(encoder.health().needsRebuild, true)
  }
  state.invalid = null; state.duplicate = true
  await assert.rejects(new OpenAITextEmbedding(options).probe(), { code: 'INVALID_EMBEDDING_RESPONSE' })
  state.duplicate = false; state.inconsistent = true
  await assert.rejects(new OpenAITextEmbedding(options).probe(), { code: 'EMBEDDING_DRIFT' })
})

test('same-name model drift is latched against persisted baseline and not reset by retrying the probe', async t => {
  const { options, state } = await fixture(t)
  const original = new OpenAITextEmbedding(options)
  const { baseline } = await original.probe()
  const changes = []
  const restarted = new OpenAITextEmbedding({ ...options, probeBaseline: baseline, onDrift: async change => { changes.push(change) } })
  await restarted.probe()
  state.drift = true
  await assert.rejects(restarted.probe(), { code: 'EMBEDDING_DRIFT' })
  assert.equal(changes[0].spaceId, 'text-v1')
  assert.equal(changes[0].reason, 'probe_vector_changed')
  await assert.rejects(restarted.encode({ inputs: ['red'] }), { code: 'REBUILD_REQUIRED' })
  state.drift = false
  await assert.rejects(restarted.probe(), { code: 'REBUILD_REQUIRED' })
  assert.notEqual(spaceFingerprint(options.space), spaceFingerprint({ ...options.space, revision: 'r2' }))
  const incompatible = new OpenAITextEmbedding({ ...options, probeBaseline: baseline })
  await assert.rejects(incompatible.probe({ samples: { text: ['different', 'samples'] } }), { code: 'PROBE_BASELINE_MISMATCH' })
})

test('explicit model/revision drift and timeout/upstream errors do not expose credentials or provider response bodies', async t => {
  const { options, state } = await fixture(t)
  const encoder = new OpenAITextEmbedding(options)
  await encoder.probe()
  state.model = 'silently-updated'
  await assert.rejects(encoder.encode({ inputs: ['red'] }), { code: 'EMBEDDING_DRIFT' })
  state.model = 'model'; state.fail = true
  await assert.rejects(new OpenAITextEmbedding(options).probe(), error => error.code === 'HTTP_ERROR' && !/test-only-key|upstream detail|127\.0\.0\.1/.test(error.message))
  state.fail = false; state.delay = 100
  await assert.rejects(new OpenAITextEmbedding({ ...options, timeoutMs: 10 }).probe(), { code: 'HTTP_TIMEOUT' })
})

test('fixed HTTP image/joint mapping is explicit, versioned, probes modalities and separately validates labeled alignment', async t => {
  const { options, state } = await fixture(t)
  const joint = jointSpace()
  const encoder = new FixedHttpEmbedding({ ...options, space: joint, mapping })
  const samples = { text: ['red dress', 'blue dress'], image: ['https://example.test/red.png', 'https://example.test/blue.png'] }
  const probe = await encoder.probe({ samples })
  assert.equal(probe.alignment, 'not_evaluated', 'Protocol success must not imply cross-modal quality')
  assert.equal(state.requests.length, 16)
  const evaluated = await encoder.probe({ samples, alignmentPairs: [{ text: 0, positiveImage: 0, negativeImage: 1, margin: 0.1 }, { text: 1, positiveImage: 1, negativeImage: 0 }] })
  assert.equal(evaluated.alignment, 'passed_supplied_samples')
  const output = await encoder.encode({ inputs: [{ url: samples.image[0] }], modality: 'image' })
  assert.equal(output.spaceId, 'joint-v1'); assert.deepEqual([...output.vectors[0]], [1, 0, 0])
  assert.ok(state.requests.every(r => r.path === '/v1/encode'))
  await assert.rejects(encoder.probe({ samples, alignmentPairs: [{ text: 0, positiveImage: 1, negativeImage: 0 }] }), { code: 'ALIGNMENT_UNVERIFIED' })
  await assert.rejects(encoder.encode({ inputs: samples.image, modality: 'image' }), { code: 'PROBE_REQUIRED' })
  state.revision = 'r2'
  await assert.rejects(new FixedHttpEmbedding({ ...options, space: joint, mapping }).probe({ samples }), { code: 'EMBEDDING_DRIFT' })
})

test('mapping changes, prototype paths and undeclared image preprocessing cannot reuse an embedding space', async t => {
  const { options } = await fixture(t)
  const changed = { ...mapping, path: '/different' }
  assert.throws(() => new FixedHttpEmbedding({ ...options, space: jointSpace(), mapping: changed }), { code: 'MAPPING_VERSION_MISMATCH' })
  assert.throws(() => new FixedHttpEmbedding({ ...options, space: jointSpace(), mapping: { ...mapping, modelField: '__proto__.model' } }), { code: 'INVALID_MAPPING' })
  const noPreprocess = jointSpace(); noPreprocess.preprocess.image.mode = 'guess'
  await assert.rejects(new FixedHttpEmbedding({ ...options, space: noPreprocess, mapping }).probe({ samples: { text: ['red', 'blue'], image: ['https://example.test/red.png', 'https://example.test/blue.png'] } }), { code: 'UNSUPPORTED_PREPROCESS' })
})

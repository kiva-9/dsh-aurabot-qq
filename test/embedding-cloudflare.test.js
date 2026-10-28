import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { FixedHttpEmbedding, mappingFingerprint } from '../src/memory/embedding/index.js'

test('Cloudflare-shaped fixed HTTP mapping supports @ namespace, text arrays, result.data and checked shape/success without live credentials', async t => {
  const state = { shape: null, success: true, badVector: false, requests: [] }
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    state.requests.push({ url: req.url, body, authorization: req.headers.authorization })
    const data = body.text.map(value => state.badVector ? [1, 2] : value.includes('红') ? [1, 0, 0] : [0, 1, 0])
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ success: state.success, errors: state.success ? [] : [{ message: 'server-secret-must-stay-private' }], result: { data, shape: state.shape || [data.length, 3] } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const mapping = { version: 'cf-run-text-v1', path: '/@cf/mock/model-v1', inputs: { text: { field: 'text' } },
    response: { vectorsPath: 'result.data', shapePath: 'result.shape', successPath: 'success' } }
  const options = { baseUrl: `http://127.0.0.1:${server.address().port}/client/v4/accounts/mock-account/ai/run`, apiKey: 'local-mock-only', mapping,
    space: { spaceId: 'cf-mock-v1', provider: 'cloudflare-test-only', endpointIdentity: 'loopback-cf-shaped', model: '@cf/mock/model-v1', revision: 'local-fixture-1', dims: 3, metric: 'cosine', modalities: ['text'], prefixes: { query: '', document: '' }, normalization: 'l2', protocolMappingVersion: mapping.version,
      preprocess: { text: { version: '1', trim: true }, protocolMappingFingerprint: mappingFingerprint(mapping) } } }
  const samples = { text: ['红色裙子', '蓝色杯子'] }
  const encoder = new FixedHttpEmbedding(options)
  assert.equal(state.requests.length, 0)
  await encoder.probe({ samples })
  const result = await encoder.encode({ inputs: samples.text })
  assert.deepEqual(result.vectors.map(row => [...row]), [[1, 0, 0], [0, 1, 0]])
  assert.ok(state.requests.every(request => request.url === '/client/v4/accounts/mock-account/ai/run/@cf/mock/model-v1'))
  assert.ok(state.requests.every(request => Object.keys(request.body).join() === 'text' && request.authorization === 'Bearer local-mock-only'))
  for (const shape of [[2, 4], [3, 3], ['2', 3], [2, 3, 1]]) {
    state.shape = shape
    await assert.rejects(new FixedHttpEmbedding(options).probe({ samples }), { code: 'INVALID_EMBEDDING_RESPONSE' })
  }
  state.shape = null; state.badVector = true
  await assert.rejects(new FixedHttpEmbedding(options).probe({ samples }), { code: 'INVALID_VECTOR' })
  state.badVector = false; state.success = false
  await assert.rejects(new FixedHttpEmbedding(options).probe({ samples }), error => error.code === 'EMBEDDING_REMOTE_FAILURE' && !error.message.includes('server-secret'))
  assert.throws(() => new FixedHttpEmbedding({ ...options, mapping: { ...mapping, response: { ...mapping.response, shapePath: '__proto__.shape' } } }), { code: 'INVALID_MAPPING' })
})

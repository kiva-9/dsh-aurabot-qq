import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVectorIndex, pointId } from '../src/memory/vector/index.js'

const space = { spaceId: 'test-space', provider: 'mock', endpointIdentity: 'local-test', model: 'm', revision: 'r1', dims: 3, metric: 'cosine', modalities: ['text'], normalization: 'none', prefixes: { query: '', document: '' }, preprocess: { text: { version: '1' } }, protocolMappingVersion: 'openai-text-v1' }
const record = (id, overrides = {}) => ({ id, vector: [1, 0, 0], sourceRevision: 1, scopeRevision: 1, account: 'a', chat: 'group:1', category: 'fact', persona: '', ...overrides })
const query = (overrides = {}) => ({ spaceId: space.spaceId, vector: [1, 0, 0], filter: { account: 'a', chat: 'group:1', category: 'fact' }, limit: 10, ...overrides })

// Real loopback HTTP transport, independent filtering/scoring oracle; this is not a Qdrant server.
async function mock(t) {
  const state = { collections: new Map(), aliases: new Map(), requests: [], failWrites: false, failDelete: false, loseAliasResponse: false, injectPoint: null }
  const matches = (condition, point) => {
    if (condition.has_id) return condition.has_id.includes(point.id)
    if (condition.key) {
      const value = point.payload[condition.key]
      return condition.match.any ? condition.match.any.includes(value) : value === condition.match.value
    }
    return (!condition.must || condition.must.every(c => matches(c, point))) && (!condition.should || condition.should.some(c => matches(c, point))) && (!condition.must_not || !condition.must_not.some(c => matches(c, point)))
  }
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers['api-key'], 'test-only-secret')
      const url = new URL(req.url, 'http://localhost')
      assert.ok(url.pathname.startsWith('/api/'))
      const route = url.pathname.slice(4)
      let raw = ''; for await (const chunk of req) raw += chunk
      const body = raw ? JSON.parse(raw) : undefined
      state.requests.push({ route, method: req.method, body, search: url.search })
      const send = (result, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: status === 200 ? 'ok' : 'error', result })) }
      if (route === '/collections' && req.method === 'GET') return send({ collections: [...state.collections.keys()].map(name => ({ name })) })
      if (route === '/aliases') return send({ aliases: [...state.aliases].map(([alias_name, collection_name]) => ({ alias_name, collection_name })) })
      if (route === '/collections/aliases') {
        assert.equal(req.method, 'POST')
        const next = new Map(state.aliases)
        for (const action of body.actions) {
          if (action.delete_alias) next.delete(action.delete_alias.alias_name)
          if (action.create_alias) { assert.ok(state.collections.has(action.create_alias.collection_name)); next.set(action.create_alias.alias_name, action.create_alias.collection_name) }
        }
        state.aliases = next
        if (state.loseAliasResponse) { state.loseAliasResponse = false; return send(null, 503) }
        return send(true)
      }
      const match = route.match(/^\/collections\/([^/]+)(.*)$/)
      if (!match) return send(null, 404)
      const [, name, suffix] = match
      if (!suffix && req.method === 'PUT') { state.collections.set(name, { config: { params: body }, points: new Map(), indices: [] }); return send(true) }
      const collection = state.collections.get(name)
      if (!collection) return send(null, 404)
      if (!suffix) return send({ config: collection.config })
      if (suffix === '/index') { assert.equal(body.field_schema, 'keyword'); collection.indices.push(body.field_name); return send({ status: 'completed' }) }
      if (suffix === '/points' && req.method === 'PUT') {
        assert.equal(url.searchParams.get('wait'), 'true'); assert.equal(url.searchParams.get('ordering'), 'strong')
        if (state.failWrites) return send(null, 503)
        for (const point of body.points) {
          assert.match(point.id, /^[0-9a-f-]{36}$/)
          assert.equal(point.vector.length, collection.config.params.vectors.size)
          collection.points.set(point.id, structuredClone(point))
        }
        return send({ status: 'completed', operation_id: 1 })
      }
      if (suffix === '/points/delete') {
        if (state.failDelete) return send(null, 503)
        for (const id of body.points) collection.points.delete(id)
        return send({ status: 'completed', operation_id: 2 })
      }
      if (suffix === '/points/query') {
        assert.ok(body.filter?.must, 'Every server-side query must have a scope filter')
        const points = [...collection.points.values()].filter(p => matches(body.filter, p)).map(p => {
          let dot = 0, aa = 0, bb = 0
          for (let i = 0; i < body.query.length; i++) { dot += body.query[i] * p.vector[i]; aa += body.query[i] ** 2; bb += p.vector[i] ** 2 }
          return { id: p.id, payload: structuredClone(p.payload), score: dot / Math.sqrt(aa * bb) }
        }).sort((a, b) => b.score - a.score).slice(0, body.limit)
        if (state.injectPoint) points.push(structuredClone(state.injectPoint))
        return send({ points })
      }
      return send(null, 404)
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const directory = await mkdtemp(join(tmpdir(), 'aurabot-qdrant-mock-'))
  const config = { backend: 'qdrant', path: join(directory, 'journal.sqlite'), baseUrl: `http://127.0.0.1:${server.address().port}/api`, apiKey: 'test-only-secret', spaces: [space], timeoutMs: 1000 }
  const index = await createVectorIndex(config)
  t.after(async () => { await index.close(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }) })
  return { index, config, state }
}

test('Qdrant HTTP mock: real requests carry UUIDs, prefilters, source/scope/generation tags and secret header', async t => {
  const { index, state } = await mock(t)
  await index.upsert({ spaceId: space.spaceId, records: [record('visible', { vector: [0, 1, 0] }), record('private', { chat: 'private:1' }), record('other-account', { account: 'b' }), record('persona', { persona: 'p' }), record('image', { category: 'image' })] })
  const result = await index.query(query({ limit: 1 }))
  assert.deepEqual(result.hits.map(h => h.id), ['visible'], 'Unauthorized nearest vectors must not consume top-K')
  assert.equal(result.hits[0].generation, 'g0'); assert.equal(result.hits[0].sourceRevision, 1)
  assert.deepEqual((await index.query(query({ authorizedIds: ['private'] }))).hits, [])
  const sent = state.requests.filter(r => r.route.endsWith('/points/query')).at(-1)
  assert.deepEqual(sent.body.filter.must.at(-1), { has_id: [pointId(space.spaceId, 'private')] })
  await assert.rejects(index.query(query({ filter: { account: 'a' } })), { code: 'SCOPE_REQUIRED' })
  const count = state.requests.length
  assert.deepEqual((await index.query(query({ authorizedIds: [] }))).hits, [])
  assert.equal(state.requests.length, count, 'Empty authorized set makes no remote query')
  assert.equal((await index.health()).remoteAvailable, true)
})

test('Qdrant HTTP mock: correlated share grants cannot combine an unauthorized chat/category/persona', async t => {
  const { index } = await mock(t)
  await index.upsert({ spaceId: space.spaceId, records: [record('home'), record('shared-image', { chat: 'group:2', category: 'image' }), record('private-fact', { chat: 'group:2' }), record('wrong-persona', { chat: 'group:2', category: 'image', persona: 'p' })] })
  const result = await index.query(query({ filter: { account: 'a', scopes: [{ chat: 'group:1', category: 'fact' }, { chat: 'group:2', category: 'image' }] } }))
  assert.deepEqual(result.hits.map(h => h.id).sort(), ['home', 'shared-image'])
})

test('Qdrant HTTP mock: HTTP outage leaves a durable journal; restart replays and deletion rejects late resurrection', async t => {
  const { index, config, state } = await mock(t)
  state.failWrites = true
  await assert.rejects(index.upsert({ spaceId: space.spaceId, records: [record('pending')] }), { code: 'HTTP_ERROR' })
  assert.equal((await index.health()).pending, 1)
  await index.close()
  state.failWrites = false
  const reopened = await createVectorIndex(config)
  try {
    assert.deepEqual((await reopened.query(query())).hits.map(h => h.id), ['pending'])
    state.failDelete = true
    await assert.rejects(reopened.delete({ spaceId: space.spaceId, ids: ['pending'], sourceRevision: 2 }), { code: 'HTTP_ERROR' })
    await assert.rejects(reopened.query(query()), { code: 'HTTP_ERROR' }, 'Do not return stale remote data after failed deletion')
    state.failDelete = false
    assert.deepEqual((await reopened.query(query())).hits, [])
    assert.equal((await reopened.upsert({ spaceId: space.spaceId, records: [record('pending', { sourceRevision: 99 })] })).skipped, 1)
  } finally { await reopened.close() }
})

test('Qdrant HTTP mock: dual generations, live permission changes and atomic alias publication recover an ambiguous response', async t => {
  const { index, config, state } = await mock(t)
  await index.upsert({ spaceId: space.spaceId, records: [record('a'), record('b')] })
  await index.rebuild({ spaceId: space.spaceId, generation: 'g1', records: [record('a'), record('b')] })
  assert.equal((await index.query(query())).generation, 'g0')
  await index.upsert({ spaceId: space.spaceId, records: [record('c'), record('b', { chat: 'private:1', scopeRevision: 2 })] })
  await index.delete({ spaceId: space.spaceId, ids: ['a'], sourceRevision: 2 })
  state.loseAliasResponse = true
  await assert.rejects(index.switchGeneration({ spaceId: space.spaceId, generation: 'g1' }), { code: 'HTTP_ERROR' })
  const change = state.requests.filter(r => r.route === '/collections/aliases').at(-1)
  assert.equal(change.body.actions.length, 2)
  assert.ok(change.body.actions[0].delete_alias && change.body.actions[1].create_alias)
  await index.close()
  const reopened = await createVectorIndex(config)
  try {
    const result = await reopened.query(query())
    assert.equal(result.generation, 'g1')
    assert.deepEqual(result.hits.map(h => h.id), ['c'])
    assert.equal((await reopened.health()).pending, 0)
  } finally { await reopened.close() }
})

test('Qdrant HTTP mock: final revision validation discards a stale authorized remote payload', async t => {
  const { index, state } = await mock(t)
  await index.upsert({ spaceId: space.spaceId, records: [record('a')] })
  const original = await index.query(query())
  await index.upsert({ spaceId: space.spaceId, records: [record('a', { sourceRevision: 2, vector: [0, 1, 0] })] })
  state.injectPoint = { id: pointId(space.spaceId, 'a'), score: 1, payload: original.hits[0] }
  const result = await index.query(query())
  assert.equal(result.stats.staleDropped, 1)
  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0].sourceRevision, 2)
})

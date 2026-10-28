import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVectorIndex, pointId } from '../src/memory/vector/index.js'
import { defineEmbeddingSpace } from '../src/memory/embedding/index.js'

const space = (id = 'text-v1', extra = {}) => ({ spaceId: id, provider: 'test', endpointIdentity: 'loopback-contract', model: 'text', revision: '1', dims: 3, metric: 'cosine', modalities: ['text'], prefixes: { query: '', document: '' }, normalization: 'none', preprocess: { text: { version: '1' } }, protocolMappingVersion: 'openai-text-v1', ...extra })
const record = (id, extra = {}) => ({ id, vector: [1, 0, 0], sourceRevision: 1, scopeRevision: 1, account: 'qq:1', chat: 'group:1', category: 'fact', persona: '', ...extra })
const query = (extra = {}) => ({ spaceId: 'text-v1', vector: [1, 0, 0], filter: { account: 'qq:1', chat: 'group:1', category: 'fact' }, ...extra })
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'aurabot-vector-test-'))
  const config = { backend: 'local', path: join(directory, 'index.sqlite'), spaces: [space()], cacheBytes: 256, pageSize: 2, ...options }
  const index = await createVectorIndex(config)
  t.after(async () => { await index.close(); await rm(directory, { recursive: true, force: true }) })
  return { index, config, directory }
}

test('worker entry is inert when the host imports every source module', async () => {
  await import('../src/memory/vector/sqlite-worker.js')
  await import('../src/memory/vector/qdrant.js')
  await import('../src/memory/embedding/index.js')
})

test('authorization is applied in SQL before ranking, including correlated category/persona grants', async t => {
  const { index } = await fixture(t)
  const rows = [record('allowed', { vector: [0, 1, 0] }), record('private', { chat: 'private:1' }), record('account', { account: 'qq:2' }), record('persona', { persona: 'secret' }), record('category', { category: 'image' }), record('shared-image', { chat: 'group:2', category: 'image' }), record('unshared-fact', { chat: 'group:2' })]
  await index.upsert({ spaceId: 'text-v1', records: rows })
  const result = await index.query(query({ limit: 1 }))
  assert.deepEqual(result.hits.map(h => h.id), ['allowed'])
  assert.equal(result.stats.scanned, 1, 'Unauthorized rows must never reach vector scoring')
  const grants = await index.query(query({ filter: { account: 'qq:1', scopes: [{ chat: 'group:1', category: 'fact' }, { chat: 'group:2', category: 'image' }] } }))
  assert.deepEqual(grants.hits.map(h => h.id), ['shared-image', 'allowed'])
  assert.equal(grants.stats.scanned, 2)
  await assert.rejects(index.query(query({ filter: { account: 'qq:1' } })), { code: 'SCOPE_REQUIRED' })
  await assert.rejects(index.query(query({ filter: { account: 'qq:1', chat: 'group:1', unknown: true } })), { code: 'INVALID_FILTER' })
  assert.deepEqual((await index.query(query({ authorizedIds: [] }))).hits, [])
  assert.deepEqual((await index.query(query({ authorizedIds: ['private'] }))).hits, [])
  assert.deepEqual((await index.query(query({ filter: { account: 'qq:1', chats: [] } }))).hits, [])
  assert.deepEqual((await index.query(query({ filter: { account: 'qq:1', chat: 'group:1', persona: 'secret', category: 'fact' } }))).hits.map(h => h.id), ['persona'])
})

test('pagination, authorized ID temp table, bounded cache and top-K agree with a reference ranking', async t => {
  const { index } = await fixture(t)
  const rows = Array.from({ length: 75 }, (_, i) => record(`r${String(i).padStart(3, '0')}`, { vector: [i + 1, 76 - i, 1] }))
  await index.upsert({ spaceId: 'text-v1', records: rows })
  const authorizedIds = rows.filter((_, i) => i % 3 === 0).map(r => r.id)
  const result = await index.query(query({ authorizedIds, limit: 8 }))
  assert.deepEqual(result.hits.map(h => h.id), [...authorizedIds].reverse().slice(0, 8))
  assert.equal(result.stats.scanned, 25)
  assert.equal(result.stats.pages, 13)
  const health = await index.health()
  assert.ok(health.cache.bytes <= health.cache.budgetBytes)
  assert.ok(health.cache.entries <= 1)
})

test('finite nonzero Float32 vectors, explicit immutable spaces, and atomic batches', async t => {
  const { index } = await fixture(t)
  for (const vector of [[0, 0, 0], [NaN, 0, 1], [Infinity, 1, 2], [1e50, 0, 0], [1e-50, 0, 0], [1, 2], ['1', 2, 3]]) {
    await assert.rejects(index.upsert({ spaceId: 'text-v1', records: [record('invalid', { vector })] }), { code: 'INVALID_VECTOR' })
  }
  await index.registerSpace(space('other'))
  await index.upsert({ spaceId: 'other', records: [record('other-space')] })
  assert.deepEqual((await index.query(query())).hits, [])
  await assert.rejects(index.query(query({ vector: { spaceId: 'other', vector: [1, 0, 0] } })), { code: 'SPACE_MISMATCH' })
  await assert.rejects(index.registerSpace(space('text-v1', { model: 'different-same-dimensions' })), { code: 'SPACE_MISMATCH' })
  await index.upsert({ spaceId: 'text-v1', records: [record('immutable')] })
  await assert.rejects(index.upsert({ spaceId: 'text-v1', records: [record('not-committed'), record('immutable', { vector: [0, 1, 0] })] }), { code: 'REVISION_CONFLICT' })
  assert.deepEqual((await index.query(query())).hits.map(h => h.id), ['immutable'])
  assert.throws(() => defineEmbeddingSpace({ dims: 3 }), { code: 'INVALID_CONTRACT' })
  await index.markNeedsRebuild({ spaceId: 'text-v1', reason: 'probe drift' })
  await assert.rejects(index.upsert({ spaceId: 'text-v1', records: [record('blocked')] }), { code: 'REBUILD_REQUIRED' })
  assert.equal((await index.health()).spaces.find(s => s.spaceId === 'text-v1').needsRebuild, true)
})

test('source/scope revisions and tombstones prevent late writes and permission resurrection across restart', async t => {
  const { index, config } = await fixture(t)
  await index.upsert({ spaceId: 'text-v1', records: [record('move')] })
  await assert.rejects(index.upsert({ spaceId: 'text-v1', records: [record('move', { sourceRevision: 2, chat: 'private:1' })] }), { code: 'SCOPE_REVISION_REQUIRED' })
  await index.upsert({ spaceId: 'text-v1', records: [record('move', { scopeRevision: 2, chat: 'private:1' })] })
  assert.deepEqual((await index.query(query())).hits, [])
  assert.equal((await index.upsert({ spaceId: 'text-v1', records: [record('move', { sourceRevision: 9 })] })).skipped, 1)
  await index.upsert({ spaceId: 'text-v1', records: [record('delete', { sourceRevision: 5 })] })
  assert.equal((await index.delete({ spaceId: 'text-v1', ids: ['delete'], sourceRevision: 4 })).skipped, 1)
  await index.delete({ spaceId: 'text-v1', ids: ['delete', 'never-written'], sourceRevision: 5 })
  await index.worker.terminate()
  await assert.rejects(index.health(), /worker exited/i)
  const reopened = await createVectorIndex(config)
  try {
    assert.equal((await reopened.upsert({ spaceId: 'text-v1', records: [record('delete', { sourceRevision: 99 }), record('never-written', { sourceRevision: 99 })] })).skipped, 2)
    assert.deepEqual((await reopened.query(query())).hits, [])
    assert.equal((await reopened.query(query({ filter: { account: 'qq:1', chat: 'private:1' } }))).hits[0].scopeRevision, 2)
  } finally { await reopened.close() }
})

test('old generation serves during streaming rebuild; live additions, deletions and permissions catch up atomically', async t => {
  const { index, config } = await fixture(t)
  await index.upsert({ spaceId: 'text-v1', records: [record('keep'), record('delete'), record('move')] })
  let release, started
  const gate = new Promise(resolve => { release = resolve })
  const entering = new Promise(resolve => { started = resolve })
  async function* source() { yield record('keep'); started(); await gate; yield record('delete'); yield record('move'); }
  const building = index.rebuild({ spaceId: 'text-v1', generation: 'g1', records: source(), batchSize: 1 })
  await entering
  assert.equal((await index.query(query())).generation, 'g0')
  await assert.rejects(index.switchGeneration({ spaceId: 'text-v1', generation: 'g1' }), { code: 'GENERATION_NOT_READY' })
  await index.delete({ spaceId: 'text-v1', ids: ['delete'], sourceRevision: 2 })
  await index.upsert({ spaceId: 'text-v1', records: [record('new'), record('move', { scopeRevision: 2, chat: 'private:1' })] })
  release(); await building
  await index.switchGeneration({ spaceId: 'text-v1', generation: 'g1', expectedGeneration: 'g0' })
  const hits = await index.query(query())
  assert.equal(hits.generation, 'g1')
  assert.deepEqual(hits.hits.map(h => h.id), ['keep', 'new'])
  await index.close()
  const reopened = await createVectorIndex(config)
  try { assert.equal((await reopened.query(query())).generation, 'g1') } finally { await reopened.close() }
})

test('incomplete generation cannot switch; interrupted generation resumes after worker crash', async t => {
  const { index, config } = await fixture(t)
  await index.upsert({ spaceId: 'text-v1', records: [record('a'), record('b')] })
  await assert.rejects(index.rebuild({ spaceId: 'text-v1', generation: 'g1', records: [record('a')] }), { code: 'INCOMPLETE_GENERATION' })
  await assert.rejects(index.switchGeneration({ spaceId: 'text-v1', generation: 'g1' }), { code: 'GENERATION_NOT_READY' })
  await index._call('beginRebuild', { spaceId: 'text-v1', generation: 'g1' })
  await index.upsert({ spaceId: 'text-v1', generation: 'g1', records: [record('a')] })
  await index.worker.terminate()
  const reopened = await createVectorIndex(config)
  try {
    assert.equal((await reopened.query(query())).generation, 'g0')
    await reopened.rebuild({ spaceId: 'text-v1', generation: 'g1', records: [record('a'), record('b')] })
    await reopened.switchGeneration({ spaceId: 'text-v1', generation: 'g1' })
    assert.equal((await reopened.query(query())).hits.length, 2)
  } finally { await reopened.close() }
})

test('cosine, dot and Euclidean expose higher-is-better scores and deterministic business UUIDs', async t => {
  for (const metric of ['cosine', 'dot', 'euclidean']) {
    const { index } = await fixture(t, { spaces: [space('text-v1', { metric })] })
    await index.upsert({ spaceId: 'text-v1', records: [record('near'), record('far', { vector: [0, 2, 0] })] })
    const hits = (await index.query(query())).hits
    assert.equal(hits[0].id, 'near'); assert.ok(hits[0].score > hits[1].score)
  }
  assert.match(pointId('a', 'business:图像/12'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(pointId('a', '12'), pointId('a', '12'))
  assert.notEqual(pointId('b', '12'), pointId('a', '12'))
})

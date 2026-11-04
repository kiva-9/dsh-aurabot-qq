import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase } from '../src/storage/db.js'
import { createSearchStore, ensureSchema } from '../src/search/store.js'

const scope = { account: 'bot', chat: 'group:1' }
const ctx = { account: 'bot', chatId: 'group:1', actorId: 'alice', turnId: 'turn-1' }
const record = (patch = {}) => ({
  schemaVersion: 1, id: 'srch_fixture', type: 'web-search', provider: 'tavily', status: 'complete',
  scope, actorId: 'alice', requestId: 'req-1', turnId: 'turn-1', query: 'fixture',
  createdAt: 1_000, expiresAt: 2_000, cache: { policy: 'p', key: 'cache-key', ttlMs: 1_000 },
  sources: [], citations: [], candidates: [], failures: [], ...patch,
})

test('expired results and their reference bytes are pruned; results keep a short audit grace', t => {
  let time = 1_000
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  const store = createSearchStore(db, { now: () => time })
  store.save(record({ id: 'old', expiresAt: 2_000 }), [{ id: 'blob', mime: 'image/png', buf: Buffer.from('bytes') }])
  assert.equal(db.get('SELECT COUNT(*) AS n FROM search_results').n, 1)
  assert.equal(db.get('SELECT COUNT(*) AS n FROM search_reference_bytes').n, 1)

  time = 3_000
  store.prune()
  assert.equal(db.get('SELECT COUNT(*) AS n FROM search_reference_bytes').n, 0, 'reference bytes expire immediately')
  assert.equal(db.get('SELECT COUNT(*) AS n FROM search_results').n, 1, 'result remains readable as expired')

  time = 2_000 + 60 * 60 * 1000 + 1
  store.prune()
  assert.equal(db.get('SELECT COUNT(*) AS n FROM search_results').n, 0)
})

test('failed results and per-turn budgets/rate-limit windows have a bounded TTL', t => {
  let time = 1_000
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  const store = createSearchStore(db, { now: () => time })
  store.save(record({ id: 'failed', status: 'failed', expiresAt: 1_000 }))
  store.reserve(ctx, 'searches', 2)
  store.reserveRequests('provider-key', { maxRequestsPerMinute: 10, maxRequestsPerDay: 100 })
  assert.equal(db.get('SELECT COUNT(*) AS n FROM search_budgets').n, 1)
  assert.equal(db.get('SELECT COUNT(*) AS n FROM search_limits').n, 2)

  time += 2 * 60 * 60 * 1000
  store.prune()
  assert.equal(db.get('SELECT COUNT(*) AS n FROM search_results').n, 0, 'failed audit rows are not permanent')
  time += 24 * 60 * 60 * 1000
  store.prune()
  assert.equal(db.get('SELECT COUNT(*) AS n FROM search_budgets').n, 0)
  time += 24 * 60 * 60 * 1000
  store.prune()
  assert.equal(db.get('SELECT COUNT(*) AS n FROM search_limits').n, 0)
})

test('search store tolerates a malformed result row without breaking history or cache lookups', t => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  const store = createSearchStore(db, { now: () => 1_000 })
  store.save(record({ id: 'good' }))
  db.run(`INSERT INTO search_results(id,account_id,chat_id,actor_id,request_id,turn_id,kind,cache_key,created_at,expires_at,result_json)
    VALUES('bad','bot','group:1','alice','r','t','web-search','bad-key',1000,999999,'{not-json')`)
  assert.deepEqual(store.history(ctx).map((item) => item.id), ['good'])
  assert.equal(store.cached({ ...ctx, actorId: 'alice' }, 'bad-key'), null)
  assert.equal(store.get(ctx, 'bad'), null)
})

test('search schema DDL is transactional when an incompatible pre-existing table blocks it', t => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  db.exec('CREATE TABLE search_results(id TEXT PRIMARY KEY)')
  assert.throws(() => ensureSchema(db), /no such column: account_id/)
  assert.equal(!!db.get("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='search_budgets'"), false)
  assert.equal(!!db.get("SELECT 1 FROM sqlite_schema WHERE type='index' AND name='search_results_scope'"), false)
})

test('pruning keeps live cache rows and quota counters untouched', t => {
  let time = 1_000
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  const store = createSearchStore(db, { now: () => time })
  store.save(record({ id: 'live', expiresAt: 60_000 }))
  store.reserve(ctx, 'tools', 3)
  store.reserveRequests('provider-key', { maxRequestsPerMinute: 10, maxRequestsPerDay: 100 })
  store.prune()
  assert.equal(db.get('SELECT COUNT(*) AS n FROM search_results').n, 1)
  assert.equal(db.get('SELECT COUNT(*) AS n FROM search_budgets').n, 1)
  assert.equal(db.get('SELECT COUNT(*) AS n FROM search_limits').n, 2)
})

test('older search tables gain TTL columns through a compatibility migration', t => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  db.exec(`CREATE TABLE search_results (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      actor_id TEXT NOT NULL, request_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      kind TEXT NOT NULL, cache_key TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      result_json TEXT NOT NULL);
    CREATE TABLE search_budgets (
      account_id TEXT NOT NULL, chat_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      searches INTEGER NOT NULL DEFAULT 0, tools INTEGER NOT NULL DEFAULT 0, downloads INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(account_id, chat_id, turn_id));
    CREATE TABLE search_limits (key TEXT NOT NULL, window INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(key, window));
    INSERT INTO search_budgets VALUES('bot','group:1','old-turn',1,2,3);
    INSERT INTO search_limits VALUES('k',1,4);`)
  ensureSchema(db)
  const budgetColumns = new Set(db.all('PRAGMA table_info(search_budgets)').map((row) => row.name))
  const limitColumns = new Set(db.all('PRAGMA table_info(search_limits)').map((row) => row.name))
  assert.ok(budgetColumns.has('created_at'))
  assert.ok(limitColumns.has('touched_at'))
  assert.deepEqual({ ...db.get('SELECT searches,tools,downloads,created_at FROM search_budgets') }, { searches: 1, tools: 2, downloads: 3, created_at: 0 })
})

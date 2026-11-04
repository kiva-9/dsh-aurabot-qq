import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStorage } from '../src/storage/index.js'
import { createMemoryStore } from '../src/memory/index.js'

const indexNames = (db, table) => new Set(db.all(`PRAGMA index_list(${table})`).map((row) => row.name))
const plan = (db, sql) => db.all(`EXPLAIN QUERY PLAN ${sql}`).map((row) => row.detail).join('\n')

test('memory audit, episode and profile hot-path indexes exist and are used', t => {
  const storage = createStorage({ file: ':memory:', filesDir: '' })
  t.after(() => storage.close())
  createMemoryStore({ storage })
  const db = storage.db
  assert.ok(indexNames(db, 'memory_audit').has('memory_audit_fact'))
  assert.ok(indexNames(db, 'memory_episodes').has('memory_episodes_scope'))
  assert.ok(indexNames(db, 'memory_profiles').has('memory_profiles_subject'))

  assert.match(plan(db, "SELECT seq,body FROM memory_audit WHERE fact_id='f' ORDER BY seq"), /memory_audit_fact/)
  assert.match(plan(db, "SELECT * FROM memory_episodes WHERE scope_key='s' ORDER BY to_seq DESC LIMIT 100"), /memory_episodes_scope/)
  assert.match(plan(db, "SELECT * FROM memory_profiles WHERE subject='alice'"), /memory_profiles_subject/)
})

test('reopening an older memory domain adds the new indexes without changing user_version', t => {
  const storage = createStorage({ file: ':memory:', filesDir: '' })
  t.after(() => storage.close())
  createMemoryStore({ storage })
  storage.db.exec('DROP INDEX memory_audit_fact; DROP INDEX memory_episodes_scope; DROP INDEX memory_profiles_subject')
  const version = storage.db.get('PRAGMA user_version').user_version
  createMemoryStore({ storage })
  assert.ok(indexNames(storage.db, 'memory_audit').has('memory_audit_fact'))
  assert.ok(indexNames(storage.db, 'memory_episodes').has('memory_episodes_scope'))
  assert.ok(indexNames(storage.db, 'memory_profiles').has('memory_profiles_subject'))
  assert.equal(storage.db.get('PRAGMA user_version').user_version, version)
})

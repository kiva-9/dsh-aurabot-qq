import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStorage } from '../src/storage/index.js'
import { ensureSchema } from '../src/learning/schema.js'
import { ensureRuntime } from '../src/learning/runtime.js'

const hasTable = (db, name) => !!db.get("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?", name)
const hasIndex = (db, name) => !!db.get("SELECT 1 FROM sqlite_schema WHERE type='index' AND name=?", name)

test('learning schema creates audit/use indexes and is idempotent', t => {
  const storage = createStorage({ file: ':memory:', filesDir: '' })
  t.after(() => storage.close())
  ensureSchema(storage.db)
  ensureSchema(storage.db)
  assert.ok(hasIndex(storage.db, 'wp6_learning_audit_record'))
  assert.ok(hasIndex(storage.db, 'wp6_learning_uses_at'))
  assert.ok(hasIndex(storage.db, 'wp6_learning_shared_usage_last'))
  const details = storage.db.all("EXPLAIN QUERY PLAN SELECT id FROM wp6_learning_audit WHERE record_id='r' ORDER BY id DESC LIMIT 50")
    .map((row) => row.detail).join('\n')
  assert.match(details, /wp6_learning_audit_record/)
})

test('a failed learning schema initializer rolls back all DDL in the transaction', t => {
  const storage = createStorage({ file: ':memory:', filesDir: '' })
  t.after(() => storage.close())
  // Pre-create a conflicting table: creating the message_id index must fail.
  storage.db.exec('CREATE TABLE wp6_learning_evidence(id TEXT PRIMARY KEY)')
  assert.throws(() => ensureSchema(storage.db), /no such column: message_id/)
  assert.equal(hasTable(storage.db, 'wp6_learning_records'), false, 'created tables are rolled back')
  assert.equal(hasTable(storage.db, 'wp6_learning_audit'), false)
  assert.equal(hasTable(storage.db, 'wp6_model_budget'), false, 'nested runtime DDL shares the transaction')
})

test('ensureRuntime wraps its two DDL statements in one transaction', t => {
  const storage = createStorage({ file: ':memory:', filesDir: '' })
  t.after(() => storage.close())
  ensureRuntime(storage.db)
  assert.ok(hasTable(storage.db, 'wp6_model_budget'))
  assert.ok(hasTable(storage.db, 'wp6_model_calls'))
})

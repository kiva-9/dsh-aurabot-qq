import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture, S, sources } from './helpers/wp6.js'
import { settings } from '../src/learning/contracts.js'
import { ensureRuntime, reserveCall, budgetState } from '../src/learning/runtime.js'

test('only explicit zero means unlimited; old positive/invalid settings remain bounded', () => {
  for (const v of [0, '0']) assert.equal(settings({ learning: { maxCallsPerDay: v } }).maxCallsPerDay, 0)
  for (const v of [1, 30, 200, 1000000]) assert.equal(settings({ learning: { maxCallsPerDay: v } }).maxCallsPerDay, v)
  for (const v of [undefined, null, '', 'invalid', Infinity]) assert.equal(settings({ learning: { maxCallsPerDay: v } }).maxCallsPerDay, 30)
  for (const v of [-1, 0.5, false]) assert.equal(settings({ learning: { maxCallsPerDay: v } }).maxCallsPerDay, 1)
})

test('unlimited daily calls retain historical spending, cross-kind locks and global concurrency', t => {
  const f = fixture(t), db = f.storage.db, day = new Date(f.now()).toISOString().slice(0, 10)
  ensureRuntime(db)
  db.run('INSERT INTO wp6_model_budget(day,calls) VALUES (?,?)', day, 200)
  const unlimited = settings({ learning: { maxCallsPerDay: 0, maxConcurrent: 1 } })
  const first = reserveCall(db, S, 'expression', unlimited, f.now())
  assert.ok(first)
  assert.deepEqual(budgetState(db, unlimited, f.now()), { day, calls: 201, active: 1, maxCallsPerDay: 0, maxConcurrent: 1 })
  assert.equal(reserveCall(db, S, 'jargon', unlimited, f.now()), null)
  assert.equal(reserveCall(db, { ...S, chat: 'group:2' }, 'jargon', unlimited, f.now()), null)
  db.run('DELETE FROM wp6_model_calls WHERE id=?', first)
  assert.equal(reserveCall(db, S, 'jargon', { ...unlimited, maxCallsPerDay: 200 }, f.now()), null)
  assert.ok(reserveCall(db, S, 'jargon', unlimited, f.now()))
  assert.equal(budgetState(db, unlimited, f.now()).calls, 202)
  f.advance(86400000)
  assert.ok(reserveCall(db, S, 'expression', { ...unlimited, maxCallsPerDay: 1 }, f.now()))
  assert.equal(db.get('SELECT calls FROM wp6_model_budget WHERE day=?', day).calls, 202)
})

test('unlimited daily mode still backs off and pauses after six consecutive failures', async t => {
  const f = fixture(t); sources(f); f.cfg.learning.maxCallsPerDay = 0
  let calls = 0
  const learning = f.learning({ infer: async () => { calls++; return 'bad JSON' } })
  const day = new Date(f.now()).toISOString().slice(0, 10)
  f.storage.db.run('INSERT INTO wp6_model_budget(day,calls) VALUES (?,?)', day, 200)
  for (let n = 1; n <= 6; n++) {
    assert.equal((await learning.learn(S, 'expression')).code, 'INVALID_MODEL_OUTPUT')
    assert.equal((await learning.learn(S, 'expression')).code, n === 6 ? 'LEARNING_PAUSED' : 'COOLDOWN')
    f.advance(learning.checkpoint(S, 'expression').nextAttemptAt - f.now())
  }
  assert.equal(calls, 6)
  assert.equal(learning.budget().calls, 206)
  assert.equal(learning.checkpoint(S, 'expression').processedSeq, 0)
  assert.equal(learning.checkpoint(S, 'expression').queued, 3)
})

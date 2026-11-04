import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStorage } from '../src/storage/index.js'
import { createMemoryStore } from '../src/memory/index.js'

const scope = { account: 'bot', chat: 'group:1', persona: 'fish' }

function fixture(t) {
  const storage = createStorage({ file: ':memory:', filesDir: '' })
  t.after(() => storage.close())
  const memory = createMemoryStore({ storage })
  const message = storage.messages.ingest({ account: scope.account, chatId: scope.chat, authorId: 'alice', eventKind: 'message', text: 'alice 喜欢咖啡' })
  const fact = memory.create({
    scope, text: 'alice 喜欢咖啡', subject: 'alice', predicate: 'likes', value: '咖啡', speakerId: 'alice',
    polarity: 'positive', modality: 'asserted', conditions: [], eventTime: null, validFrom: null, validTo: null,
    status: 'active', stability: 'stable', slot: 'multi', profileSection: 'preferences', evidenceMessageIds: [message.id],
  }).item
  return { storage, memory, fact }
}

test('a malformed memory fact row is skipped by list/get instead of breaking the panel', t => {
  const f = fixture(t)
  f.storage.db.run(`INSERT INTO memory_facts(id,account,chat,persona,category,body,revision,status,fingerprint,created_at,updated_at)
    VALUES('bad-fact',?,?,'fish','fact','[]',1,'active','bad',1,1)`, scope.account, scope.chat)
  const items = f.memory.list({ scope })
  assert.deepEqual(items.map((item) => item.id), [f.fact.id])
  assert.equal(f.memory.get('bad-fact', { scope }), null)
  assert.equal(f.memory.stats({ scope }).count, 1)
})

test('a malformed audit row is skipped while valid audit history remains readable', t => {
  const f = fixture(t)
  f.storage.db.run("INSERT INTO memory_audit(fact_id,account,chat,persona,at,body) VALUES(?,?,?,'fish',1,'[]')", f.fact.id, scope.account, scope.chat)
  const audit = f.memory.audit(f.fact.id, scope)
  assert.ok(audit.length >= 1)
  assert.ok(audit.every((row) => row && row.action))
})

test('a corrupt cached profile is dropped and does not break profile reads', async t => {
  const f = fixture(t)
  await f.memory.buildProfile('alice', { scope })
  assert.ok(f.storage.db.get('SELECT COUNT(*) AS n FROM memory_profiles').n >= 1)
  f.storage.db.exec("UPDATE memory_profiles SET body='[]'")
  assert.equal(f.memory.profileOf('alice', { scope }), null)
  assert.doesNotThrow(() => f.memory.profiles({ scope }))
})

test('a malformed episode row is skipped by the episodes panel', t => {
  const f = fixture(t)
  f.storage.db.run("INSERT INTO memory_episodes(id,scope_key,scope,from_seq,to_seq,body,created_at) VALUES('bad-ep',?,'[]',1,2,'[]',1)", JSON.stringify(scope))
  assert.deepEqual(f.memory.episodes({ scope }), [])
})

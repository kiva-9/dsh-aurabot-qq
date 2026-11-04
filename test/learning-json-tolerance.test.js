import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStorage } from '../src/storage/index.js'
import { createLearningStore } from '../src/learning/store.js'
import { readEvidence } from '../src/learning/evidence.js'

const S = { account: 'bot', chat: 'group:1', persona: 'fish' }
const now = Date.parse('2026-10-28T00:00:00Z')
const sharedConfig = { memory: { shareGroups: [{ id: 'share', account: 'bot', chats: ['group:1', 'group:2'], categories: ['jargon'] }] } }

function fixture(t) {
  const storage = createStorage({ file: ':memory:', filesDir: '', now: () => now })
  t.after(() => storage.close())
  const store = createLearningStore({ storage, getConfig: () => sharedConfig, now: () => now })
  const message = (text, authorId = 'alice', chat = S.chat) => storage.messages.ingest({ account: S.account, chatId: chat, authorId, eventKind: 'message', text, receivedAt: now })
  const first = store.upsert(S, 'jargon', { term: '摸鱼', aliases: [], meaning: '暂时放松', meaningState: 'uncertain', confidence: 0.5, evidenceMessageIds: [message('摸鱼就是暂时放松').id] })
  return { storage, store, first, message }
}

test('a malformed learning record is skipped by list while valid items remain', t => {
  const f = fixture(t)
  f.storage.db.run(`INSERT INTO wp6_learning_records(id,scope_key,account_id,chat_id,persona_id,kind,item_key,data_json,status,manual_lock,revision,created_at,updated_at,expires_at,last_used_at,uses,invalid_reason)
    VALUES('bad','["bot","group:1","fish"]','bot','group:1','fish','jargon','bad','{not-json','pending',0,1,1,1,9999999999999,0,0,'')`)
  const items = f.store.list(S)
  assert.deepEqual(items.map((item) => item.id), [f.first.id])
  assert.throws(() => f.store.get(S, 'bad'), { code: 'DATA_CORRUPTED' })
})

test('a malformed shared learning record does not break readable()', t => {
  const f = fixture(t)
  f.store.transition(S, f.first.id, 'approved', { expectedRevision: f.first.revision })
  const message = f.message('隔壁群也在摸鱼', 'bob', 'group:2')
  f.storage.db.run(`INSERT INTO wp6_learning_records(id,scope_key,account_id,chat_id,persona_id,kind,item_key,data_json,status,manual_lock,revision,created_at,updated_at,expires_at,last_used_at,uses,invalid_reason)
    VALUES('bad-shared','["bot","group:2","fish"]','bot','group:2','fish','jargon','bad','{not-json','approved',1,1,1,1,9999999999999,0,0,'')`)
  const evidence = readEvidence(f.storage, { account: 'bot', chat: 'group:2', persona: 'fish' }, message.id, { getConfig: () => sharedConfig, now: () => now })
  assert.ok(evidence)
  f.storage.db.run(`INSERT INTO wp6_learning_evidence(record_id,message_id,fingerprint,author_id,spam_key,at) VALUES('bad-shared',?,?,'bob','s',1)`, message.id, evidence.fingerprint)
  const readable = f.store.readable(S)
  assert.ok(readable.every((item) => item.id !== 'bad-shared'))
})

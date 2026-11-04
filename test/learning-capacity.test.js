import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStorage } from '../src/storage/index.js'
import { createLearningStore } from '../src/learning/store.js'

const S = { account: 'bot', chat: 'group:1', persona: 'fish' }
const now = Date.parse('2026-10-28T00:00:00Z')

function setup(t) {
  const storage = createStorage({ file: ':memory:', filesDir: '', now: () => now })
  t.after(() => storage.close())
  const store = createLearningStore({ storage, getConfig: () => ({ learning: { maxItemsPerScope: 1 } }), now: () => now })
  const message = (text, authorId = 'alice') => storage.messages.ingest({ account: S.account, chatId: S.chat, authorId, eventKind: 'message', text, receivedAt: now }).id
  const item = (term, messageId) => ({ term, aliases: [], meaning: '测试含义', meaningState: 'uncertain', confidence: 0.5, evidenceMessageIds: [messageId] })
  return { storage, store, message, item }
}

test('deleted learning tombstones do not count against maxItemsPerScope', t => {
  const { store, message, item } = setup(t)
  const first = store.upsert(S, 'jargon', item('摸鱼', message('摸鱼就是暂时放松')))
  store.transition(S, first.id, 'deleted', { expectedRevision: first.revision })
  const second = store.upsert(S, 'jargon', item('打工人', message('打工人打卡')))
  assert.equal(second.status, 'pending')
  assert.equal(store.list(S, { status: 'deleted' }).length, 1)
})

test('live learning items still respect maxItemsPerScope', t => {
  const { store, message, item } = setup(t)
  store.upsert(S, 'jargon', item('摸鱼', message('摸鱼就是暂时放松')))
  assert.throws(() => store.upsert(S, 'jargon', item('打工人', message('打工人打卡'))), { code: 'CAPACITY' })
})

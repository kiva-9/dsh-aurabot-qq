import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readEvidence } from '../src/learning/evidence.js'
import { fixture, S, sources, candidate } from './helpers/wp6.js'

const B = { ...S, chat: 'group:2' }, C = { ...S, chat: 'group:3' }, P = { ...S, chat: 'private:7' }
function share(f, categories = ['expression', 'jargon'], chats = [S.chat, B.chat], extra = {}) {
  f.cfg.memory = { shareGroups: [{ id: 'learning-friends', chats, categories, ...extra }] }
}
function published(f, l, scope = S, kind = 'jargon', patch = {}) {
  const evidenceMessageIds = sources(f, scope)
  const data = kind === 'jargon' ? candidate(evidenceMessageIds, patch) : { situation: '忙完需要休息', expression: '摸鱼', evidenceMessageIds, ...patch }
  const item = l.upsert(scope, kind, data)
  return l.transition(scope, item.id, 'approved', { expectedRevision: item.revision })
}
test('context sharing is explicit, same-account, category-specific and does not depend on fact sharing', t => {
  const f = fixture(t), l = f.learning(), jargon = published(f, l), expression = published(f, l, S, 'expression')
  assert.equal(l.contextFor(B, '摸鱼 休息'), '')
  share(f, ['fact', 'profile'])
  assert.equal(l.contextFor(B, '摸鱼 休息'), '')
  share(f, ['jargon'])
  assert.deepEqual(l.select(B, '摸鱼 休息').map(i => i.id), [jargon.id])
  share(f, ['expression'])
  assert.deepEqual(l.select(B, '摸鱼 休息').map(i => i.id), [expression.id])
  share(f)
  assert.equal(l.select(B, '摸鱼 休息').length, 2)
  assert.deepEqual(l.readable({ ...B, account: 'another-bot' }), [])
  share(f, ['expression', 'jargon'], [S.chat, B.chat], { account: 'another-bot' })
  assert.equal(l.contextFor(B, '摸鱼 休息'), '')
})
test('expression sharing keeps persona equality, while jargon follows the chat category', t => {
  const f = fixture(t), l = f.learning(), expression = published(f, l, S, 'expression'), jargon = published(f, l)
  share(f)
  assert.equal(l.readable(B).length, 2)
  const cat = { ...B, persona: 'cat' }
  f.identities.set(B.chat, { ...f.identity, personaId: 'cat' })
  assert.deepEqual(l.select(cat, '摸鱼 休息').map(i => i.id), [jargon.id])
  assert.equal(l.readable(cat).some(i => i.id === expression.id), false)
  assert.match(l.contextFor(cat, '摸鱼'), /"shared":true/)
})
test('sharing has no transitive expansion through intermediate chats', t => {
  const f = fixture(t), l = f.learning(); published(f, l)
  f.cfg.memory = { shareGroups: [
    { id: 'ab', chats: [S.chat, B.chat], categories: ['jargon'] },
    { id: 'bc', chats: [B.chat, C.chat], categories: ['jargon'] },
  ] }
  assert.match(l.contextFor(B, '摸鱼'), /暂时放松/)
  assert.equal(l.contextFor(C, '摸鱼'), '')
  assert.deepEqual(l.list(C, { includeShared: true }), [])
})
for (const change of ['recalled', 'edited', 'deleted', 'expired', 'blocked', 'missing-reference']) {
  test(`every evidence source must remain valid for shared reads: ${change}`, t => {
    const f = fixture(t), l = f.learning(), item = published(f, l); share(f)
    assert.equal(l.readable(B).length, 1)
    const id = item.evidenceMessageIds[0]
    if (change === 'recalled') f.storage.db.run('UPDATE messages SET recalled_at=? WHERE id=?', f.now(), id)
    if (change === 'edited') f.storage.db.run('UPDATE messages SET text=? WHERE id=?', '摸鱼意思已经改了', id)
    if (change === 'deleted') f.storage.db.run('DELETE FROM messages WHERE id=?', id)
    if (change === 'expired') f.advance(31 * 86400000)
    if (change === 'blocked') f.cfg.learning.blockedUserIds = [f.storage.messages.get(id).authorId]
    if (change === 'missing-reference') f.storage.db.run('UPDATE wp6_learning_evidence SET message_id=? WHERE record_id=? AND message_id=?', 'nonexistent', item.id, id)
    assert.equal(l.contextFor(B, '摸鱼'), '')
    assert.deepEqual(l.list(B, { includeShared: true }), [], 'remaining good sources do not rescue a mixed invalid derivation')
  })
}
test('a mixed private evidence link cannot inherit the public record scope', t => {
  const f = fixture(t), l = f.learning(); f.cfg.learning.allowPrivate = true
  const item = published(f, l), privateId = f.message('摸鱼 PRIVATE_SOURCE', 'private-speaker', P).id
  share(f)
  assert.throws(() => l.upsert(S, 'jargon', candidate([privateId])), { code: 'EVIDENCE_INVALID' })
  const e = readEvidence(f.storage, P, privateId, f.deps)
  // Defend also against an imported/corrupt mixed provenance record; ordinary writes reject it above.
  f.storage.db.run('INSERT INTO wp6_learning_evidence(record_id,message_id,fingerprint,author_id,spam_key,at) VALUES (?,?,?,?,?,?)', item.id, e.id, e.fingerprint, e.authorId, e.spamKey, e.receivedAt)
  assert.equal(l.contextFor(B, '摸鱼'), '')
  assert.deepEqual(l.readable(B), [])
})
test('revoking sharing/categories and moderator status changes apply immediately without cached hits', t => {
  const f = fixture(t), l = f.learning(); let item = published(f, l)
  share(f)
  assert.match(l.contextFor(B, '摸鱼', { requestId: 'same-turn' }), /暂时放松/)
  f.cfg.memory.shareGroups = []
  assert.equal(l.contextFor(B, '摸鱼', { requestId: 'same-turn' }), '')
  assert.equal(l.get(S, item.id).status, 'approved', 'revoking an audience does not revoke the origin approval')
  share(f, ['expression'])
  assert.equal(l.contextFor(B, '摸鱼', { requestId: 'same-turn' }), '')
  share(f)
  item = l.transition(S, item.id, 'disabled', { expectedRevision: item.revision })
  assert.equal(l.contextFor(B, '摸鱼', { requestId: 'same-turn' }), '')
  item = l.transition(S, item.id, 'approved', { expectedRevision: item.revision })
  assert.match(l.contextFor(B, '摸鱼'), /暂时放松/)
  l.transition(S, item.id, 'deleted', { expectedRevision: item.revision })
  assert.equal(l.contextFor(B, '摸鱼'), '')
})
test('explicit private sharing exposes only approved derivation and retains the private-source gate', t => {
  const f = fixture(t), l = f.learning(); f.cfg.learning.allowPrivate = true
  const ids = ['alice', 'bob', 'carol'].map((author, i) => f.message('摸鱼 PRIVATE_ORIGINAL_' + i, author, P).id)
  let item = l.upsert(P, 'jargon', candidate(ids)); item = l.transition(P, item.id, 'approved', { expectedRevision: item.revision })
  assert.equal(l.contextFor(B, '摸鱼'), '')
  share(f, ['jargon'], [P.chat, B.chat])
  const shared = l.readable(B)[0], context = l.contextFor(B, '摸鱼')
  assert.equal(shared.id, item.id); assert.equal(shared.readOnly, true)
  assert.deepEqual(shared.evidenceMessageIds, [])
  assert.match(context, /"sourceChat":"private:7"/)
  assert.doesNotMatch(context, /PRIVATE_ORIGINAL|alice|bob|carol/)
  assert.throws(() => l.evidence(B, item.id), { code: 'NOT_FOUND' })
  assert.deepEqual(l.sources(B, { kind: 'jargon' }).items, [])
  f.cfg.learning.allowPrivate = false
  assert.equal(l.contextFor(B, '摸鱼'), '')
})
test('shared context does not grant mutation access or mix viewer cooldowns and use counters', t => {
  const f = fixture(t), l = f.learning(), item = published(f, l)
  share(f, ['jargon'], [S.chat, B.chat, C.chat]); f.cfg.learning.contextCooldownMs = 60000
  assert.deepEqual(l.list(B), [])
  assert.equal(l.list(B, { includeShared: true })[0].readOnly, true)
  for (const mutate of [
    () => l.update(B, item.id, { meaning: '改别群' }, { expectedRevision: item.revision }),
    () => l.transition(B, item.id, 'disabled', { expectedRevision: item.revision }),
    () => l.removeEvidence(B, item.id, item.evidenceMessageIds[0], { expectedRevision: item.revision }),
    () => l.revert(B, item.id, 1, { expectedRevision: item.revision }),
  ]) assert.throws(mutate, { code: 'NOT_FOUND' })
  assert.equal(l.select(B, '摸鱼', { requestId: 'same-id' }).length, 1)
  assert.equal(l.select(B, '摸鱼', { requestId: 'same-id' }).length, 1)
  assert.equal(l.select(B, '摸鱼', { requestId: 'next' }).length, 0)
  assert.equal(l.select(C, '摸鱼', { requestId: 'same-id' }).length, 1)
  assert.equal(l.get(S, item.id).uses, 0)
  assert.equal(l.readable(B)[0].uses, 1); assert.equal(l.readable(C)[0].uses, 1)
  assert.equal(l.select(S, '摸鱼', { requestId: 'same-id' }).length, 1)
  assert.equal(l.get(S, item.id).uses, 1)
  assert.equal(f.storage.db.get('SELECT COUNT(*) AS n FROM wp6_learning_uses').n, 3)
})
test('same word keeps its current-chat meaning even while that record is cooling down', t => {
  const f = fixture(t), l = f.learning(); published(f, l, S, 'jargon', { meaning: '共享群里指散步' })
  const local = published(f, l, B, 'jargon', { meaning: '当前群里指休息' }); share(f)
  f.cfg.learning.contextCooldownMs = 60000
  const selected = l.select(B, '摸鱼', { requestId: 'first' })
  assert.deepEqual(selected.map(i => i.id), [local.id])
  assert.equal(l.contextFor(B, '摸鱼', { requestId: 'second' }), '')
})
test('local alias meaning also takes precedence over a shared spelling of the same term', t => {
  const f = fixture(t), l = f.learning(); published(f, l, S, 'jargon', { meaning: '共享群里指散步' })
  const local = published(f, l, B, 'jargon', { term: 'brb', aliases: ['摸鱼'], meaning: '当前群里指暂时离开' }); share(f)
  assert.deepEqual(l.select(B, '摸鱼').map(i => i.id), [local.id])
})

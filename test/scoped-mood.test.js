import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMoodJudge } from '../src/features/mood.js'
import { fixture, S, deferred, settled } from './helpers/wp6.js'

test('mood values, reasons and history are isolated by account/chat/persona; no-scope is neutral', async t => {
  const f = fixture(t), mood = f.mood(), privateScope = { ...S, chat: 'private:alice' }
  const secret = f.message('今天我难过', 'alice', privateScope)
  mood.nudge(privateScope, -35, '只属于这个私聊的原因', { evidenceMessageIds: [secret.id] })
  assert.match(mood.state(privateScope).reason, /私聊/)
  for (const s of [S, { ...privateScope, account: 'other' }, { ...privateScope, persona: 'other' }]) {
    assert.equal(mood.state(s).value, 60); assert.equal(mood.state(s).reason, ''); assert.deepEqual(mood.state(s).history, [])
  }
  assert.equal(mood.state().reason, '')
  assert.deepEqual(mood.state().history, [])
  assert.doesNotMatch(mood.contextLine(privateScope), /只属于|原因/)
  assert.equal(mood.contextLine(S), '')
  assert.equal(f.mood().state(privateScope).value, 25, 'another instance reads SQLite state')
  f.advance(3 * 3600000)
  assert.equal(mood.state(privateScope).value, 43)
  assert.equal(mood.reset(privateScope).value, 60)
  assert.deepEqual(mood.state(privateScope).history, [])
})
test('mood source replay stays idempotent after bounded history eviction and reset', t => {
  const f = fixture(t), mood = f.mood(), first = f.message('谢谢')
  assert.equal(mood.observe(S, { messageId: first.id }).value, 66)
  for (let i = 0; i < 25; i++) mood.observe(S, { messageId: f.message('谢谢 ' + i).id })
  assert.equal(mood.state(S).history.length, 20)
  mood.reset(S)
  assert.equal(mood.observe(S, { messageId: first.id }).code, 'DUPLICATE')
  assert.equal(mood.state(S).value, 60)
  assert.equal(mood.observe(S, { messageId: f.message('谢谢', 'bot').id }).code, 'EVIDENCE_REQUIRED')
})
test('low mood changes optional expression but explicit requests and pending commitments keep normal pace', t => {
  const f = fixture(t), mood = f.mood()
  mood.nudge(S, -50, '面板调整')
  assert.ok(mood.effects(S).chatty < 1)
  for (const opts of [{ explicitRequest: true }, { taskPending: true }]) {
    assert.equal(mood.effects(S, opts).chatty, 1); assert.equal(mood.effects(S, opts).delay, 1)
  }
  assert.match(mood.contextLine(S), /不改变身份/)
  assert.match(mood.contextLine(S), /已承诺任务照常/)
  f.identity.layers.policy.mood = false
  assert.equal(mood.contextLine(S), '')
  assert.equal(mood.effects(S).chatty, 1)
  assert.equal(mood.nudge(S, 20).code, 'DISABLED')
})
test('deleted or edited source removes mood reason from state and history', t => {
  const f = fixture(t), mood = f.mood(), m = f.message('谢谢')
  mood.nudge(S, 10, '来源解释', { evidenceMessageIds: [m.id] })
  f.storage.db.run('UPDATE messages SET text=? WHERE id=?', '不同消息', m.id)
  assert.equal(mood.state(S).reason, '')
  assert.equal(mood.state(S).history[0].reason, '')
  assert.throws(() => mood.nudge(S, 2, '', { origin: 'judge' }), { code: 'EVIDENCE_REQUIRED' })
  assert.throws(() => mood.nudge(S, NaN), { code: 'INVALID_INPUT' })
  assert.throws(() => mood.nudge(S, 2, '', { expectedRevision: 0 }), { code: 'REVISION_CONFLICT' })
})
test('mood judgment requires source evidence and strictly parsed complete values', async t => {
  let calls = 0
  const f = fixture(t), mood = f.mood({ infer: async ({ identity }) => { calls++; assert.equal(identity.name, '测试角色'); return { delta: 9, reason: '交流融洽', confidence: 0.9 } } })
  f.cfg.mood.judge = true
  await assert.rejects(mood.judge(S), { code: 'EVIDENCE_REQUIRED' })
  const m = f.message('谢谢')
  assert.equal((await mood.judge(S, { sourceMessageIds: [m.id], epoch: 999 })).code, 'STALE')
  assert.equal(calls, 0)
  assert.equal((await mood.judge(S, { sourceMessageIds: [m.id] })).value, 69)
  f.advance(60001)
  assert.equal((await mood.judge(S, { sourceMessageIds: [m.id] })).code, 'DUPLICATE')
  assert.equal(calls, 1)
  for (const value of ['abc {"delta":10}', '{"delta":10,"reason":"x"}', { delta: '10', confidence: 1, reason: 'x' }, { delta: 10, confidence: NaN, reason: 'x' }]) assert.equal(parseMoodJudge(value), null)
  assert.deepEqual(parseMoodJudge('```json\n{"delta":99,"reason":" x ","confidence":0.9}\n```'), { delta: 15, reason: 'x', confidence: 0.9 })
})
for (const change of ['epoch', 'revision', 'binding', 'persona', 'account', 'reset', 'disabled', 'source', 'dispose']) {
  test(`mood discards asynchronous judgment after ${change}`, async t => {
    const f = fixture(t), gate = deferred(), mood = f.mood({ infer: () => gate.promise })
    f.cfg.mood.judge = true
    const m = f.message('谢谢'), p = mood.judge(S, { sourceMessageIds: [m.id] })
    await settled()
    if (change === 'epoch') f.storage.epochs.bump(S.chat, 'test')
    if (change === 'revision') f.identity.revision++
    if (change === 'binding') f.identity.bindingRevision++
    if (change === 'persona') f.identity.personaId = 'new'
    if (change === 'account') f.cfg.botQQ = 'new'
    if (change === 'reset') mood.reset(S)
    if (change === 'disabled') f.cfg.mood.enabled = false
    if (change === 'source') f.storage.db.run('UPDATE messages SET recalled_at=? WHERE id=?', f.now(), m.id)
    if (change === 'dispose') await mood.stop()
    gate.resolve({ delta: 15, reason: '不能写回', confidence: 1 })
    assert.equal((await p).ok, false)
    assert.equal(mood.state(S).value, 60)
    assert.equal(mood.state(S).reason, '')
    assert.equal(f.storage.db.get('SELECT COUNT(*) AS n FROM wp6_model_calls').n, 0)
  })
}
test('mood timeout releases slot and low-confidence result changes nothing', async t => {
  const f = fixture(t); f.cfg.mood.judge = true; f.cfg.learning.timeoutMs = 100
  const mood = f.mood({ infer: () => new Promise(() => {}) })
  assert.equal((await mood.judge(S, { sourceMessageIds: [f.message('谢谢').id] })).code, 'MODEL_TIMEOUT')
  f.advance(60001)
  const other = f.mood({ infer: async () => ({ delta: 15, confidence: 0.2, reason: '猜测' }) })
  assert.equal((await other.judge(S, { sourceMessageIds: [f.message('谢谢你').id] })).changed, false)
  assert.equal(other.state(S).value, 60)
})

// #1：说话人记录丢失时，只有主人私聊放宽；群聊、他人私聊的严格判断不变。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hubFixture, privateChat, groupChat, OWNER, until } from './helpers/hub-fixture.js'

const sessionOf = (hub, chatId) => hub.sessions()[chatId].sessionId
const push = (f, chat, sender) => f.hub.pushToSession(chat, [{ type: 'text', text: '在吗' }], sender)
async function settled(f, chat, sender) {
  await push(f, chat, sender)
  const sid = sessionOf(f.hub, chat.chatId)
  await until(() => f.fake.turns.length)
  await new Promise(resolve => setTimeout(resolve, 20))
  return sid
}

test('主人私聊 senders 为空时仍算主人，账号也能认出来', async t => {
  const f = await hubFixture(t), sid = await settled(f, privateChat(), OWNER)
  assert.equal(f.hub.turnSendersAllOwner(sid), true)
  assert.deepEqual(f.hub.turnActor(sid), { actorId: OWNER, requestId: null })
})

test('他人私聊、群聊 senders 为空都不放宽', async t => {
  const f = await hubFixture(t)
  const friend = await settled(f, privateChat('30000003'), '30000003')
  const group = await settled(f, groupChat(), OWNER)
  assert.equal(f.hub.turnSendersAllOwner(friend), false)
  assert.equal(f.hub.turnSendersAllOwner(group), false)
  assert.ok(f.hub.turnActor(group).error)
})

test('主人和陌生人混在一轮时不算主人', async t => {
  const f = await hubFixture(t), sid = await settled(f, groupChat(), OWNER)
  f.hub.simulateTurn(sid, [OWNER, '30000003'])
  assert.equal(f.hub.turnSendersAllOwner(sid), false)
})

test('重启后第一条消息到来前，chatOfSession 从持久映射找回聊天', async t => {
  const f = await hubFixture(t), sid = await settled(f, privateChat(), OWNER)
  const restarted = await hubFixture(t)
  mkdirSync(process.env.AURABOT_DATA_DIR, { recursive: true })
  const file = join(process.env.AURABOT_DATA_DIR, 'sessions.json')
  const fresh = { chats: { [`private:${OWNER}`]: { sessionId: 'session-' + sid } } }
  writeFileSync(file, JSON.stringify(fresh))
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), fresh)
  assert.equal(restarted.hub.chatOfSession(sid), `private:${OWNER}`)
  assert.equal(restarted.hub.turnSendersAllOwner(sid), true)
  assert.equal(restarted.hub.chatOfSession('不存在'), '')
  assert.equal(restarted.hub.turnSendersAllOwner('不存在'), false)
})

test('resetSessions 删掉映射后，旧会话不再算主人', async t => {
  const f = await hubFixture(t), sid = await settled(f, privateChat(), OWNER)
  f.hub.resetSessions()
  assert.equal(f.hub.chatOfSession(sid), '')
  assert.equal(f.hub.turnSendersAllOwner(sid), false)
})

test('DSH 面板直接打字算主人，turn/end 后清掉；QQ 转入的不算', async t => {
  const f = await hubFixture(t), sid = await settled(f, groupChat(), OWNER)
  const event = (type, data) => f.hub.onSessionEvent({ id: sid }, { type, data })
  event('user/message', { source: { kind: 'aurabot' } })
  assert.equal(f.hub.turnSendersAllOwner(sid), false)
  event('user/message', { source: { kind: 'user' } })
  assert.equal(f.hub.turnSendersAllOwner(sid), true)
  assert.deepEqual(f.hub.turnActor(sid), { actorId: OWNER, requestId: null })
  event('turn/end', { turn: 99, reason: { kind: 'completed' } })
  assert.equal(f.hub.turnSendersAllOwner(sid), false)
})

test('面板插话不能给这一轮里陌生人的 QQ 请求授权', async t => {
  let release
  const hold = new Promise(resolve => { release = resolve })
  const f = await hubFixture(t, { brain: () => hold })
  const source = f.storage.messages.ingest({ account: f.cfg.botQQ, chatId: groupChat().chatId, eventKind: 'message', platformMsgId: '1', authorId: '30000003', authorName: 'n', platformTime: Date.now(), text: '把他禁言', segments: [] })
  const stranger = f.storage.requests.create({ chatId: groupChat().chatId, actorId: '30000003', sourceMessageIds: [source.id], policyRevision: 0 })
  const pushed = f.hub.pushToSession(groupChat(), [{ type: 'text', text: '把他禁言' }], '30000003', { requests: [stranger] })
  await until(() => f.hub.sessions()[groupChat().chatId] && [...f.fake.agents.values()].some(agent => agent.status === 'running'))
  const sid = sessionOf(f.hub, groupChat().chatId)
  f.hub.onSessionEvent({ id: sid }, { type: 'user/message', data: { source: { kind: 'user' } } })
  const allowed = f.hub.turnSendersAllOwner(sid)
  release('好')
  await pushed
  assert.equal(allowed, false)
})

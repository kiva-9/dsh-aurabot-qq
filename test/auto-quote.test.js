// #11：只有一个人明确找她时，第一条文字回复自动引用并 @ 那个人。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hubFixture, BOT, GROUP, until } from './helpers/hub-fixture.js'

let mid = 500
const at = { type: 'at', data: { qq: BOT } }, say = t => ({ type: 'text', data: { text: t } })
const event = (userId, message) => ({ post_type: 'message', message_type: 'group', group_id: Number(GROUP), user_id: Number(userId), message_id: ++mid, time: Math.floor(Date.now() / 1000), self_id: Number(BOT), sender: { nickname: 'u' + userId }, message })

async function round(t, reply, send, config = {}) {
  const sent = [], brain = typeof reply === 'function' ? reply : () => reply
  const f = await hubFixture(t, { brain, config: { merge: { enabled: false }, ...config }, tts: { speak: async () => { throw new Error('off') } },
    onebot: { call: async (action, params) => {
      if (action === 'get_group_info') return { group_name: 'g' }
      if (action === 'get_group_member_list') return [{ user_id: 111, card: 'a' }]
      if (action.startsWith('send_')) { sent.push(params.message); return { message_id: 9000 + sent.length } }
      return {}
    } } })
  await send(f)
  await until(() => sent.length)
  return { f, sent }
}

test('单人 @：第一条有 reply + at，后面的不重复', async t => {
  const { sent } = await round(t, '第一句|||第二句', f => f.hub.onMessage(event(111, [at, say(' 在吗')])))
  await until(() => sent.length === 2)
  assert.deepEqual(sent[0].slice(0, 2), [{ type: 'reply', data: { id: String(mid) } }, { type: 'at', data: { qq: '111' } }])
  assert.equal(sent[1].some(s => s.type === 'reply' || s.type === 'at'), false)
})

test('模型自己写了 <at:> 时不重复 @', async t => {
  const { sent } = await round(t, '<at:111> 好', f => f.hub.onMessage(event(111, [at, say(' 在吗')])))
  assert.equal(sent[0].filter(s => s.type === 'at').length, 1)
})

test('模型显式 <reply:> 优先，不被自动引用覆盖', async t => {
  const { sent } = await round(t, '<reply:1>收到', f => f.hub.onMessage(event(111, [at, say(' 在吗')])))
  assert.deepEqual(sent[0].map(s => s.type), ['reply', 'text'])
})

async function voiceDelivery(t, reply) {
  const sends = [], dir = mkdtempSync(join(tmpdir(), 'aurabot-auto-quote-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const wav = join(dir, 'a.wav')
  writeFileSync(wav, Buffer.from('RIFF0000WAVEfmt '))
  const f = await hubFixture(t, { config: { voice: { enabled: true, autoChance: 0, groupAutoChance: 0 } }, tts: { speak: async () => ({ file: wav, engine: 'test' }) },
    onebot: { call: async (action, params) => { if (action.startsWith('send_')) { sends.push(params.message); return { message_id: 1 } } return {} } } })
  const dbId = f.storage.messages.ingest({ account: BOT, chatId: 'group:' + GROUP, eventKind: 'message', platformMsgId: '77', authorId: '111', authorName: 'u', platformTime: Date.now(), text: 'x', segments: [] }).id
  await f.hub.deliver('group:' + GROUP, reply, { autoReply: { mid: '77', uid: '111', dbId } })
  return sends.map(message => message.map(s => s.type))
}

test('语音回复绝不带引用（QQ 上会变空白气泡，上游 #103）', async t => {
  assert.deepEqual(await voiceDelivery(t, '<voice>你好</voice>'), [['record']])
})

test('语音加文字：引用落在文字那条，语音段不带', async t => {
  assert.deepEqual(await voiceDelivery(t, '<voice>你好</voice>|||文字'), [['record'], ['reply', 'at', 'text', 'text']])
})

test('被撤回的消息不引用', async t => {
  const sends = []
  const f = await hubFixture(t, { onebot: { call: async (action, params) => { if (action.startsWith('send_')) { sends.push(params.message); return { message_id: 1 } } return {} } } })
  const dbId = f.storage.messages.ingest({ account: BOT, chatId: 'group:' + GROUP, eventKind: 'message', platformMsgId: '78', authorId: '111', authorName: 'u', platformTime: Date.now(), text: 'x', segments: [] }).id
  f.storage.messages.markRecalled('group:' + GROUP, '78')
  await f.hub.deliver('group:' + GROUP, '文字', { autoReply: { mid: '78', uid: '111', dbId } })
  assert.deepEqual(sends[0].map(s => s.type), ['text'])
})

test('私聊不启用', async t => {
  const sends = []
  const f = await hubFixture(t, { onebot: { call: async (action, params) => { if (action.startsWith('send_')) { sends.push(params.message); return { message_id: 1 } } return {} } } })
  await f.hub.deliver('private:111', '文字')
  assert.deepEqual(sends[0].map(s => s.type), ['text'])
})

test('多人同时 @：不自动引用', async t => {
  const { sent } = await round(t, '都看到了', async f => {
    await f.hub.onMessage(event(111, [at, say(' 甲')]))
    await f.hub.onMessage(event(222, [at, say(' 乙')]))
  }, { merge: { enabled: true, groupWaitSec: 0.5, groupMaxSec: 2, mentionWaitSec: 0.5, waitSec: 0.5, maxSec: 2 } })
  assert.equal(sent.at(-1).some(s => s.type === 'reply' || s.type === 'at'), false)
})

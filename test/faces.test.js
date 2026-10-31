// #6：QQ 系统表情。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFaceIndex, createFaces, stripFaceTags, speakableText, textToSegments, COMMON_FACES } from '../src/chat/faces.js'
import { parseMessageEvent } from '../src/chat/inbound.js'
import { hubFixture, GROUP } from './helpers/hub-fixture.js'

const idOf = name => COMMON_FACES[name]

test('speech removes emoji sequences but preserves ordinary numbers and text', () => {
  assert.equal(speakableText('你好 👩🏽‍💻 🇭🇰 1️⃣ 123！'), '你好 123！')
  assert.equal(speakableText('你好 <voice> <sticker:猫> <at:123> <ordinary>内容</ordinary>'), '你好 <ordinary>内容</ordinary>')
  assert.equal(speakableText('©2026 ™ 20°C，1+2=3。\uFE0E'), '©2026 ™ 20°C，1+2=3。')
})

test('<face:捂脸> 生成同条的 face 段', () => {
  assert.deepEqual(textToSegments('哈<face:捂脸>哈', idOf), [{ type: 'text', data: { text: '哈' } }, { type: 'face', data: { id: '264' } }, { type: 'text', data: { text: '哈' } }])
})

test('未知名字去掉标签，不原样发', () => {
  assert.deepEqual(textToSegments('好<face:没这个>的', idOf), [{ type: 'text', data: { text: '好的' } }])
  assert.deepEqual(textToSegments('<face:没这个>', idOf), [])
  assert.equal(stripFaceTags('好 <face:捂脸> 的'), '好 的')
})

test('网关目录：过滤非数字编号，同名优先普通表情', () => {
  const { byName, byId } = buildFaceIndex({ packs: [{ emojis: [{ q_sid: '999', q_des: '/捂脸', is_super: true }, { q_sid: '264', q_des: '/捂脸' }, { q_sid: '😀', q_des: '/笑' }] }] })
  assert.equal(byName.get('捂脸'), 264)
  assert.equal(byName.has('笑'), false)
  assert.equal(byId.get('999'), '捂脸')
})

test('createFaces：取不到目录时用内置表，网关同步抛错也不炸', async () => {
  const faces = createFaces({ onebot: { call() { throw new Error('断了') } } })
  assert.equal(faces.idOf('捂脸'), 264)
  await faces.refresh()
  assert.equal(faces.nameOf('264'), '捂脸')
})

test('createFaces：目录缓存，不重复请求', async () => {
  let calls = 0
  const faces = createFaces({ onebot: { call: async () => { calls++; return { packs: [{ emojis: [{ q_sid: '500', q_des: '/新表情' }] }] } } } })
  faces.idOf('x')
  await faces.refresh()
  assert.equal(faces.idOf('新表情'), 500)
  await faces.refresh()
  assert.equal(calls, 1)
})

test('入站 face 显示名字，没有名字退回原样', () => {
  const event = { message_type: 'private', user_id: 1, message: [{ type: 'face', data: { id: '264' } }] }
  assert.equal(parseMessageEvent(event, 2, { faceName: id => COMMON_FACES.捂脸 === Number(id) ? '捂脸' : undefined }).text, '[捂脸]')
  assert.equal(parseMessageEvent(event, 2).text, '[表情]')
})

test('deliver：表情和文字同一条，语音念的文字里没有标记', async t => {
  const sent = [], spoken = []
  const f = await hubFixture(t, { config: { voice: { enabled: true, autoChance: 0, groupAutoChance: 0 } },
    tts: { speak: async (text) => { spoken.push(text); throw new Error('不用真合成') } },
    onebot: { call: async (action, params) => { if (action.startsWith('send_')) { sent.push(params.message); return { message_id: 1 } } return {} } } })
  await f.hub.deliver('group:' + GROUP, '好<face:捂脸>')
  assert.deepEqual(sent[0].map(s => s.type), ['text', 'face'])
  await f.hub.deliver('group:' + GROUP, '<voice>你好<face:捂脸></voice>')
  assert.deepEqual(spoken, ['你好'])
})

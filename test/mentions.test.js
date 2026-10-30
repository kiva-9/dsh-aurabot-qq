// #6：群聊真 @。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { expandMentions, hasMention, memberNames, resolveMember } from '../src/chat/mentions.js'
import { hubFixture, OWNER, GROUP } from './helpers/hub-fixture.js'

const text = t => ({ type: 'text', data: { text: t } })
const members = [{ user_id: 10002, card: '张小明（摸鱼仔）', nickname: 'ming' }, { user_id: 10003, card: '小王', nickname: 'w1' }, { user_id: 10004, card: '小王', nickname: 'w2' }, { user_id: 10005, nickname: '。Luna' }]

test('名字对照：群名片、昵称、去掉括号备注', () => {
  const names = memberNames(members)
  for (const name of ['张小明（摸鱼仔）', '张小明', 'ming', '。Luna']) assert.ok(names.has(name), name)
})

test('resolveMember：数字 QQ 只认名单内的；重名不猜', () => {
  const names = memberNames(members), qqs = new Set(['10002'])
  assert.equal(resolveMember('10002', names, qqs), '10002')
  assert.equal(resolveMember('99999', names, qqs), '')
  assert.equal(resolveMember('小王', names, qqs), '')
  assert.equal(resolveMember('张小明', names, qqs), '10002')
})

test('<at:QQ> 在群成员里：真 at 段', () => {
  assert.deepEqual(expandMentions([text('<at:10002> 来')], members), [{ type: 'at', data: { qq: '10002' } }, text(' 来')])
})

test('不在群里的 QQ 不 @，记进 missed（防模型被诱导骚扰外人）', () => {
  const missed = []
  assert.deepEqual(expandMentions([text('<at:99999> 来')], members, { missed }), [text('@99999 来')])
  assert.deepEqual(missed, ['99999'])
})

test('成员列表拉不到时，刚说过话的人和主人仍能 @', () => {
  const missed = []
  assert.deepEqual(expandMentions([text('<at:10002>')], [], { known: ['10002'], missed }), [{ type: 'at', data: { qq: '10002' } }])
  assert.deepEqual(missed, [])
})

test('@名字：最长匹配，后面的字补空格；重名留成文字', () => {
  assert.deepEqual(expandMentions([text('@张小明刚爬完楼')], members), [{ type: 'at', data: { qq: '10002' } }, text(' 刚爬完楼')])
  const missed = []
  assert.deepEqual(expandMentions([text('@小王 你好')], members, { missed }), [text('@小王 你好')])
  assert.deepEqual(missed, ['小王'])
})

test('邮箱、链接里的 @ 不动', () => {
  assert.deepEqual(expandMentions([text('写信到 ming@张小明.com')], members), [text('写信到 ming@张小明.com')])
})

test('只改文字段，其它段原样保留', () => {
  const face = { type: 'face', data: { id: '264' } }
  assert.deepEqual(expandMentions([face, text('<at:10002>')], members), [face, { type: 'at', data: { qq: '10002' } }])
  assert.equal(hasMention('没有'), false)
  assert.equal(hasMention('＠谁'), true)
})

async function delivered(t, reply, { list = members, chatId = 'group:' + GROUP } = {}) {
  const sent = []
  const f = await hubFixture(t, { stickers: { match: () => ({ id: 's1', md5: 'm', name: '开心' }), segmentFor: () => ({ type: 'image', data: { file: 'x' } }) },
    config: { stickers: { enabled: true, autoChance: 0 } },
    onebot: { call: async (action, params) => {
      if (action === 'get_group_member_list') { if (!list) throw new Error('限流'); return list }
      if (action.startsWith('send_')) { sent.push(params.message); return { message_id: 100 + sent.length } }
      return {}
    } } })
  const result = await f.hub.deliver(chatId, reply)
  return { sent, result }
}

test('deliver：<at:QQ> 和 <sticker:> 同句，at 不降级、表情单独一条', async t => {
  const { sent } = await delivered(t, '<at:10002> 看这个<sticker:开心>')
  assert.equal(sent.length, 2)
  assert.deepEqual(sent[0][0], { type: 'at', data: { qq: '10002' } })
  assert.equal(sent[1][0].type, 'image')
})

test('deliver：拉不到成员时不把标签原样发出去，并上报 missed', async t => {
  const { sent, result } = await delivered(t, '<at:10002> 在吗', { list: null })
  assert.deepEqual(sent[0], [text('@10002 在吗')])
  assert.deepEqual(result.missedMentions, ['10002'])
})

test('deliver：私聊里的 <at:> 退成文字，不去拉群成员', async t => {
  const { sent } = await delivered(t, '<at:10002> 你好', { chatId: 'private:' + OWNER, list: null })
  assert.deepEqual(sent[0], [text('@10002 你好')])
})

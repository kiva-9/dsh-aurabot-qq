// 端到端：假 DSH 宿主 + 假 QQ 网关，跑通 Aurabot 整条链路。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockOneBot } from './helpers/mock-onebot.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const OWNER = '10000001'
const BOT = '20000002'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 8000) {
  const t = Date.now()
  while (Date.now() - t < ms) {
    const v = await fn()
    if (v) return v
    await sleep(50)
  }
  throw new Error('等不到条件成立')
}

function fakePng(w, h, salt = 0) {
  const b = Buffer.alloc(64 + salt)
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20)
  b[40] = salt
  return b
}

// 「模型」脚本
async function brain({ preset, text, images, callTool }) {
  if (/^【(私聊|群聊)/.test(text) && text.includes('戳了戳你')) return '干嘛戳我<poke>'
  if (/^【私聊/.test(text) && text.includes('表情改名测试')) { const m = text.match(/把「(.+?)」/); const r = await callTool('qq_edit_sticker', { sticker: m[1], new_name: '改过的名字', tags: ['开心'] }); return r.message }
  if (/^【私聊/.test(text) && text.includes('表情删除测试')) { const r = await callTool('qq_edit_sticker', { sticker: '改过的名字', delete: true }); return r.message }
  if (/^【私聊/.test(text) && text.includes('翻聊天记录')) { const r = await callTool('qq_chat_history', { count: 5 }); return r.message.split('\n')[0] }
  if (text.includes('改昵称测试')) { const r = await callTool('qq_set_nickname', { name: '小鲸鱼' }); return r ? r.message : '没这个工具' }
  if (text.includes('改签名测试')) { const r = await callTool('qq_set_signature', { text: '今天也要开心' }); return r ? r.message : '没这个工具' }
  if (text.includes('换头像测试')) { const r = await callTool('qq_set_avatar', { image: 'https://example.com/a.png' }); return r ? r.message : '没这个工具' }
  if (text.includes('本地头像测试')) { const r = await callTool('qq_set_avatar', { image: 'C:/Users/a/secret.png' }); return r ? r.message : '没这个工具' }
  if (text.includes('慢慢想') && !text.includes('补充')) { await sleep(2500); return '想好了' }
  if (text.includes('引用测试') && text.startsWith('【群聊')) { const n = (text.match(/\[(\d+)\][^\n]*引用测试/) || [])[1]; return n ? `<reply:${n}>收到这条啦\n别的我就不挨个回了` : '没看到编号' }
  if (text.includes('第一句') && text.includes('第二句')) return '两句我都看到啦'
  if (text.includes('画一只')) { const r = await callTool('qq_draw_image', { prompt: '一只蓝色小鲸鱼' }); return r && r.ok ? '画好啦' : '画不了' }
  if (text.includes('禁言')) {
    // 群里混着别人说话时，写明在执行主人的哪一条（模拟模型按提示词里的编号引用）
    const ref = Number((text.match(/\[(\d+)\] [^\n]*\(10000001\)[^\n]*禁言/) || [])[1]) || undefined
    const r = await callTool('qq_group_admin', { action: 'ban', user_id: '999', minutes: 5, ...(text.includes('引用群友那条') ? { for_message: 1 } : ref ? { for_message: ref } : {}) })
    return r && r.ok ? '好 禁了' : '你谁啊 我只听主人的'
  }
  if (text.includes('跑个慢任务')) { await new Promise((r) => setTimeout(r, 1500)); return '慢任务跑完了' }
  if (text.includes('改成快的')) return '好 改成快的'
  if (text.includes('语音说你好')) return '你好呀'
  if (text.includes('晚安')) return '<voice>晚安啦 做个好梦</voice>'
  if (text.includes('没人叫你')) return '[沉默]'
  if (images.length) return '这表情好可爱|||哪来的'
  if (text.includes('[语音]')) return '白米饭yyds'
  if (text.includes('在吗')) return preset === 'aurabot-private' ? '在呢|||刚睡醒 嗯…' : '在呀'
  return '嗯'
}

let mock
let fake
let api
let dataDir

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-e2e-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mock = await startMockOneBot({ selfId: BOT })
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    dryRun: false,
    setupDone: true,
    botQQ: BOT,
    ownerQQ: OWNER,
    allow: { private: [OWNER], groups: ['555', '557', '558', '559'] },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token, dir: join(dataDir, 'no-snowluma') },
    voice: { engine: 'windows', autoChance: 0 },
    stickers: { autoChance: 0 },
    // 大多数用例要的是「每次都回」，刹车放宽；558/559 专门测一段一回和刹车
    group: { interjectChance: 0, burstMax: 50, overrides: { 557: { interjectChance: 1, minRelevance: 0, minRecentMessages: 0, cooldownSec: 0, quietHours: [0, 0] }, 559: { burstMax: 2 } } },
    merge: { waitSec: 0.4, maxSec: 3, groupWaitSec: 0.4, groupMaxSec: 3 },
  }))
  fake = createFakeDsh({ brain })
  const host = await import('../src/host.js')
  api = host.apply(fake.ctx)
  await fake.call('/onebot/reconnect')
  await until(() => mock.connected() > 0)
})

after(async () => {
  fake?.dispose()
  await mock?.close()
  setTimeout(() => process.exit(0), 200).unref()
})

const priv = (user_id, message, extra = {}) => ({ message_type: 'private', sub_type: 'friend', user_id: Number(user_id), message_id: Math.floor(Math.random() * 1e6), sender: { user_id: Number(user_id), nickname: user_id === OWNER ? 'xiaoming' : '路人' }, message, ...extra })
const grp = (group_id, user_id, message, nick = '群友') => ({ message_type: 'group', sub_type: 'normal', group_id: Number(group_id), user_id: Number(user_id), message_id: Math.floor(Math.random() * 1e6), sender: { user_id: Number(user_id), nickname: nick, card: nick, role: 'member' }, message })
const text = (t) => [{ type: 'text', data: { text: t } }]
const sentTo = (kind, id) => mock.calls.filter((c) => c.action === `send_${kind}_msg` && String(c.params[kind === 'group' ? 'group_id' : 'user_id']) === String(id))

test('人格与规则通过提示词变量注入', () => {
  assert.match(fake.variables.get('aurabot_persona')(), /大肥鱼/)
  assert.match(fake.variables.get('aurabot_persona')(), /鲸鱼/)
  assert.match(fake.variables.get('aurabot_rules_social')(), /没有任何电脑操作能力/)
  assert.match(fake.variables.get('aurabot_rules_private')(), /10000001/)
})

test('主人私聊「在吗」：建会话（完整权限 preset）、按 ||| 拆两条发回', async () => {
  mock.push(priv(OWNER, text('在吗')))
  await until(() => sentTo('private', OWNER).length >= 2)
  const msgs = sentTo('private', OWNER).map((c) => c.params.message[0].data.text)
  assert.deepEqual(msgs.slice(0, 2), ['在呢', '刚睡醒 嗯…'])
  const turn = fake.turns.at(-1)
  assert.equal(turn.preset, 'aurabot-private')
  assert.ok(mock.sent('set_input_status').some((c) => c.params.user_id === Number(OWNER) && c.params.event_type === 1), '等回复时显示正在输入')
  assert.match(turn.userText, /^【私聊】xiaoming\(10000001\)：在吗/)
  const ws = fake.workspaces[0]
  assert.ok(ws && ws.sessionIds.length === 1, '会话放进了 Aurabot 工作区')
  // 主人私聊的会话里有完整工具
  const agent = fake.agents.get(ws.sessionIds[0])
  assert.ok(agent.tools.has('qq_group_admin'))
})

test('#7 主人私聊：她这一轮还在跑时再发消息，直接 steer 进去，不等整轮结束', async () => {
  const agent = fake.agents.get(fake.workspaces[0].sessionIds[0])
  const before = agent.steered.length
  mock.push(priv(OWNER, text('跑个慢任务')))
  await new Promise((r) => setTimeout(r, 700)) // 过了合并等待，这一轮已经在跑
  mock.push(priv(OWNER, text('改成快的')))
  await until(() => agent.steered.length > before)
  const steered = agent.steered.at(-1).content.filter((c) => c.type === 'text').map((c) => c.text).join('')
  assert.match(steered, /改成快的/)
  await until(() => sentTo('private', OWNER).some((c) => c.params.message[0].data.text === '好 改成快的'))
})

test('不在白名单的私聊：不理', async () => {
  const before = fake.turns.length
  mock.push(priv('123456', text('在吗')))
  await sleep(400)
  assert.equal(fake.turns.length, before)
  assert.equal(sentTo('private', '123456').length, 0)
})

test('群聊：没叫她不回；@她必回（群聊 preset，无本地工具）', async () => {
  const before = fake.turns.length
  mock.push(grp('555', '777', text('今天天气不错')))
  await sleep(400)
  assert.equal(fake.turns.length, before, '插话概率 0 时普通消息不回')
  mock.push(grp('555', '777', [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' 在吗' } }]))
  await until(() => sentTo('group', '555').length >= 1)
  const turn = fake.turns.at(-1)
  assert.equal(turn.preset, 'aurabot-social')
  assert.match(turn.userText, /@了你/)
  assert.match(turn.userText, /今天天气不错/, '带上了群里刚才的聊天')
  const agent = fake.agents.get(turn.sessionId)
  assert.ok(!agent.tools.has('qq_send_message'))
})

test('群聊：叫名字（唤醒词）必回', async () => {
  const n = sentTo('group', '555').length
  mock.push(grp('555', '778', text('肥鱼 在吗')))
  await until(() => sentTo('group', '555').length > n)
})

test('群聊插话：她可以选择不说话', async () => {
  const before = fake.turns.length
  mock.push(grp('557', '777', text('随便聊聊')))
  await until(() => fake.turns.length > before)
  assert.match(fake.turns.at(-1).userText, /没人叫你/)
  await sleep(300)
  assert.equal(sentTo('group', '557').length, 0, '回了 [沉默] 就不发')
})

test('群管：群友要求禁言被拒绝，主人要求才执行', async () => {
  mock.push(grp('555', '777', [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' 把999禁言' } }]))
  await until(() => fake.turns.at(-1)?.userText.includes('把999禁言') && fake.turns.at(-1).toolCalls.length)
  let call = fake.turns.at(-1).toolCalls[0]
  assert.equal(call.result.ok, false)
  assert.equal(mock.sent('set_group_ban').length, 0)

  mock.push(grp('555', OWNER, [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' 帮我把999禁言' } }], 'xiaoming'))
  await until(() => mock.sent('set_group_ban').length === 1)
  call = fake.turns.at(-1).toolCalls[0]
  assert.equal(call.result.ok, true)
  assert.equal(mock.sent('set_group_ban')[0].params.duration, 300)
})

test('群管：群友和主人的话合并成一轮时，主人的要求照样执行', async () => {
  const n = mock.sent('set_group_ban').length
  mock.push(grp('555', '777', [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' 哈哈哈' } }]))
  mock.push(grp('555', OWNER, [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' 他太吵了 把999禁言' } }], 'xiaoming'))
  await until(() => mock.sent('set_group_ban').length === n + 1)
  assert.equal(fake.turns.at(-1).toolCalls[0].result.ok, true)
})

test('群管：混在一轮里时，不写编号、或者写的是群友那条，都不能借主人的权限', async () => {
  const n = mock.sent('set_group_ban').length
  mock.push(grp('555', '777', [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' 把999禁言 引用群友那条' } }]))
  mock.push(grp('555', OWNER, [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' 你好呀' } }], 'xiaoming'))
  await until(() => fake.turns.at(-1)?.userText.includes('引用群友那条') && fake.turns.at(-1).toolCalls.length)
  assert.equal(fake.turns.at(-1).toolCalls[0].result.ok, false, '编号指向群友的消息')
  assert.equal(mock.sent('set_group_ban').length, n)
})

test('群管：她在群里只是普通成员时，主人要求也做不了，并说明原因', async () => {
  mock.state.roles['555'] = 'member'
  try {
    const n = mock.sent('set_group_ban').length
    mock.push(grp('555', OWNER, [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' 再把999禁言一次' } }], 'xiaoming'))
    await until(() => fake.turns.at(-1)?.userText.includes('再把999禁言一次') && fake.turns.at(-1).toolCalls.length)
    const r = fake.turns.at(-1).toolCalls[0].result
    assert.equal(r.ok, false)
    assert.match(r.message, /普通成员/)
    assert.equal(mock.sent('set_group_ban').length, n)
  } finally {
    delete mock.state.roles['555']
  }
})

test('QQ 命令：主人 /silent 后群里 @ 她也不回，/active 恢复；群友发命令不算', async () => {
  const at = (t) => [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' ' + t } }]
  let n = sentTo('group', '555').length
  mock.push(grp('555', '777', text('/silent')))
  await sleep(500)
  mock.push(grp('555', OWNER, text('/silent'), 'xiaoming'))
  await until(() => sentTo('group', '555').length > n)
  assert.match(JSON.stringify(sentTo('group', '555').at(-1)), /不说话/)
  const turns = fake.turns.length
  n = sentTo('group', '555').length
  mock.push(grp('555', '778', at('在吗')))
  await sleep(800)
  assert.equal(fake.turns.length, turns, '闭嘴时 @ 她也不交给模型')
  assert.equal(sentTo('group', '555').length, n)
  mock.push(grp('555', OWNER, text('/active'), 'xiaoming'))
  await until(() => sentTo('group', '555').length > n)
  mock.push(grp('555', '778', at('在吗')))
  await until(() => fake.turns.length > turns)
})

test('群聊一段一回：好几个人连着 @ 她，她看完整段只回一次，提示词里有每个人的话', async () => {
  const before = fake.turns.length
  const at = (t) => [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' ' + t } }]
  mock.push(grp('558', '701', at('第一个人说话'), '甲'))
  mock.push(grp('558', '702', at('第二个人说话'), '乙'))
  mock.push(grp('558', '703', text('第三个人没叫她'), '丙'))
  mock.push(grp('558', '704', at('第四个人说话'), '丁'))
  await until(() => fake.turns.length > before)
  await sleep(1500)
  const mine = fake.turns.slice(before).filter((t) => t.userText.includes('群聊'))
  assert.equal(mine.length, 1, '只交给她一次')
  for (const w of ['第一个人', '第二个人', '第三个人', '第四个人']) assert.ok(mine[0].userText.includes(w), w)
  assert.match(mine[0].userText, /不要一条一条地挨个回/)
  // 检索记忆用的只是大家说的话，不带提示词里的说明；也记下了这一段是谁在说
  const sid = api.hub.sessions()['group:558'].sessionId
  assert.doesNotMatch(api.hub.lastTextOf(sid), /挨个回|引用回复/)
  assert.match(api.hub.lastTextOf(sid), /第一个人说话/)
  assert.deepEqual(api.hub.speakersOf(sid).sort(), ['701', '702', '703', '704'])
})

test('群聊：她还在回上一段时新来的消息先攒着，回完再一起看（不会一条一轮）', async () => {
  const at = (t) => [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' ' + t } }]
  const before = fake.turns.length
  mock.push(grp('558', '720', at('慢慢想一下这个问题'), '戊'))
  await sleep(1200) // 已经交给她了，她正在想
  mock.push(grp('558', '721', at('补充一句A'), '己'))
  mock.push(grp('558', '722', at('补充一句B'), '庚'))
  mock.push(grp('558', '723', at('补充一句C'), '辛'))
  await until(() => fake.turns.length >= before + 2, 12000)
  await sleep(1500)
  const mine = fake.turns.slice(before).filter((t) => t.userText.includes('群聊'))
  assert.equal(mine.length, 2, '第一段一轮，她想的时候来的三条合成第二轮')
  assert.ok(['补充一句A', '补充一句B', '补充一句C'].every((w) => mine[1].userText.includes(w)))
})

test('群聊引用回复：她写 <reply:编号>，发出去的那条带上对应消息的引用', async () => {
  const at = (t) => [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' ' + t } }]
  const first = grp('558', '730', text('先随便说一句'), '壬')
  const target = grp('558', '731', at('引用测试 这条要被引用'), '癸')
  mock.push(first)
  mock.push(target)
  const n = sentTo('group', '558').length
  await until(() => sentTo('group', '558').length >= n + 2)
  const [quoted, plain] = sentTo('group', '558').slice(n)
  assert.deepEqual(quoted.params.message[0], { type: 'reply', data: { id: String(target.message_id) } })
  assert.equal(quoted.params.message[1].data.text, '收到这条啦')
  assert.equal(plain.params.message[0].type, 'text', '其余的照常发，不引用')
})

test('戳一戳：主人戳她，她会回话，还会戳回去；20 秒内重复戳只算一次', async () => {
  const turns = fake.turns.length
  const poke = { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', self_id: Number(BOT), user_id: Number(OWNER), sender_id: Number(OWNER), target_id: Number(BOT) }
  mock.push(poke)
  await until(() => mock.sent('send_poke').length === 1)
  assert.match(fake.turns.at(-1).userText, /戳了戳你/)
  assert.equal(mock.sent('send_poke')[0].params.user_id, Number(OWNER))
  assert.equal(sentTo('private', OWNER).at(-1).params.message[0].data.text, '干嘛戳我')
  mock.push(poke)
  await sleep(1200)
  assert.equal(fake.turns.length, turns + 1, '连着戳只算一次')
  // 戳的不是她就不管
  mock.push({ ...poke, target_id: 12345 })
  await sleep(800)
  assert.equal(fake.turns.length, turns + 1)
})

test('合并转发：她能看到转发里的聊天记录', async () => {
  mock.state.forwards = { fw1: [
    { sender: { user_id: 801, nickname: '转发甲' }, message: [{ type: 'text', data: { text: '转发里的话甲' } }] },
    { sender: { user_id: 802, nickname: '转发乙' }, message: [{ type: 'text', data: { text: '转发里的话乙' } }] },
  ] }
  const before = fake.turns.length
  mock.push(grp('558', '805', [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' 你看看这个' } }, { type: 'forward', data: { id: 'fw1' } }], '寄件人'))
  await until(() => fake.turns.length > before)
  const t = fake.turns.at(-1).userText
  assert.match(t, /合并转发的聊天记录（2 条）/)
  assert.match(t, /转发甲：转发里的话甲/)
  assert.match(t, /转发乙：转发里的话乙/)
})

test('群聊刹车：短时间说够次数就歇着，主人 @ 还能叫动', async () => {
  const at = (t) => [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' ' + t } }]
  for (let i = 0; i < 2; i++) {
    const n = sentTo('group', '559').length
    mock.push(grp('559', '710', at('在吗' + i)))
    await until(() => sentTo('group', '559').length > n)
    await sleep(600)
  }
  const turns = fake.turns.length
  mock.push(grp('559', '711', at('在吗 再来')))
  await sleep(1500)
  assert.equal(fake.turns.length, turns, '说够 2 次了，群友 @ 也先不回')
  mock.push(grp('559', OWNER, at('在吗 主人来了'), 'xiaoming'))
  await until(() => fake.turns.length > turns)
})

test('看图：主人发来表情包，她能看到图；表情被收藏并起了备注', async () => {
  const png = fakePng(240, 240, 1)
  mock.push(priv(OWNER, [{ type: 'mface', data: { emoji_id: 'x1', summary: '[开心]', file: 'base64://' + png.toString('base64') } }]))
  await until(() => fake.turns.at(-1)?.images === 1)
  assert.match(fake.turns.at(-1).reply, /可爱/)
  await until(() => mock.sent('add_custom_face').length === 1)
  await until(() => mock.sent('modify_custom_face').length === 1)
  assert.equal(mock.sent('modify_custom_face')[0].params.desc, '可爱的小鲸鱼')
  const lib = JSON.parse(readFileSync(join(dataDir, 'stickers', 'index.json'), 'utf8'))
  assert.equal(lib.items.length, 1)
  assert.deepEqual(lib.items[0].tags, ['开心', '卖萌'])
})

test('普通照片不收进表情库', async () => {
  const photo = fakePng(1080, 720, 2)
  mock.push(priv(OWNER, [{ type: 'image', data: { sub_type: 0, file: 'base64://' + photo.toString('base64') } }]))
  await until(() => fake.turns.at(-1)?.images === 1 && fake.turns.length > 0)
  await sleep(300)
  assert.equal(mock.sent('add_custom_face').length, 1, '数量没变')
})

test('语音：回复里的 <voice> 变成 QQ 语音条', async () => {
  mock.push(priv(OWNER, text('晚安')))
  await until(() => sentTo('private', OWNER).some((c) => c.params.message[0].type === 'record'), 20000)
  const rec = sentTo('private', OWNER).find((c) => c.params.message[0].type === 'record')
  assert.match(rec.params.message[0].data.file, /^base64:\/\//)
})

test('听语音：收到语音先转文字再交给她', async () => {
  mock.push(priv(OWNER, [{ type: 'record', data: { file: 'abc.amr' } }]))
  await until(() => fake.turns.at(-1)?.userText.includes('[语音] 今天想吃白米饭'))
})

test('面板接口：概览、人格切换', async () => {
  const s = (await fake.call('/state')).json()
  assert.equal(s.ok, true)
  assert.equal(s.onebot.state, 'connected')
  assert.equal(s.config.snowluma.httpToken, '', '令牌不回传给面板')
  assert.equal(s.config.snowluma.httpTokenSet, true)
  assert.equal(s.storage.ok, true, s.storage.message)
  assert.equal(s.storage.version, s.storage.latest, '主库升到了最新结构')
  assert.equal(s.host.ok, true, JSON.stringify(s.host.missing))
  assert.equal(s.host.agent.caps['agent.cancel'], true, '会话能力探过了')
  const p = (await fake.call('/personas')).json()
  assert.ok(p.list.some((x) => x.id === 'dafeiyu'))
  const saved = (await fake.call('/persona/save', { id: 'test2', name: '测试', body: '你是测试人格小蓝。' })).json()
  assert.equal(saved.ok, true)
  const used = (await fake.call('/persona/use', { id: 'test2' })).json()
  assert.equal(used.ok, true)
  assert.match(fake.variables.get('aurabot_persona')(), /小蓝/)
  await fake.call('/persona/use', { id: 'dafeiyu' })
})

test('头像：上传自定义头像、同步成 QQ 头像、恢复默认', async () => {
  const before = (await fake.call('/avatar')).raw()
  assert.ok(before.length > 1000, '默认头像是插件自带的那张')
  const png = fakePng(200, 200, 7)
  const up = (await fake.call('/avatar/upload', { data: 'data:image/png;base64,' + png.toString('base64') })).json()
  assert.equal(up.ok, true)
  assert.equal((await fake.call('/state')).json().avatar.custom, true)
  assert.deepEqual(Buffer.from((await fake.call('/avatar')).raw()), png)
  assert.equal((await fake.call('/avatar/upload', { data: Buffer.from('not an image at all').toString('base64') })).json().ok, false)
  assert.equal((await fake.call('/avatar/sync-qq')).json().ok, true)
  assert.ok(mock.sent('set_qq_avatar')[0].params.file.startsWith('base64://'))
  await fake.call('/avatar/reset')
  assert.equal((await fake.call('/state')).json().avatar.custom, false)
  assert.equal((await fake.call('/avatar')).raw().length, before.length)
})

test('日志里没有令牌原文', async () => {
  const files = readdirSync(join(dataDir, 'logs'))
  const all = files.map((f) => readFileSync(join(dataDir, 'logs', f), 'utf8')).join('\n')
  assert.ok(all.length > 0)
  assert.ok(!all.includes(mock.token), '日志里出现了 token')
})

test('重新开始：归档会话，下一条消息开新会话', async () => {
  const before = Object.keys((await fake.call('/state')).json().sessions).length
  assert.ok(before > 0)
  const r = (await fake.call('/sessions/reset')).json()
  assert.equal(r.ok, true)
  assert.equal(Object.keys((await fake.call('/state')).json().sessions).length, 0)
})

test('语音发不出去时退回成发文字', async () => {
  mock.state.failRecord = true
  const n = sentTo('private', OWNER).length
  mock.push(priv(OWNER, text('晚安')))
  await until(() => sentTo('private', OWNER).slice(n).some((c) => c.params.message[0].type === 'text' && c.params.message[0].data.text.includes('晚安')), 20000)
  mock.state.failRecord = false
})

test('明确要语音但她只打了字：插件强制转成语音', async () => {
  const n = sentTo('private', OWNER).length
  mock.push(priv(OWNER, text('用语音说你好')))
  await until(() => sentTo('private', OWNER).slice(n).some((c) => c.params.message[0].type === 'record'), 20000)
  assert.ok(!sentTo('private', OWNER).slice(n).some((c) => c.params.message[0].type === 'text' && c.params.message[0].data.text === '你好呀'))
})

test('重放：网关重连后重发同一条消息（同一个 QQ 消息 ID），只处理一次；没有 ID 的同文连发两条都算', async () => {
  const before = fake.turns.length
  const ev = priv(OWNER, text('重放测试'))
  mock.push(ev)
  await sleep(100)
  mock.push(ev)
  await until(() => fake.turns.length > before)
  await sleep(800)
  assert.equal(fake.turns.length, before + 1)
  assert.equal((fake.turns.at(-1).userText.match(/重放测试/g) || []).length, 1, '重放的那条没并进来')
  const b2 = fake.turns.length
  mock.push(priv(OWNER, text('哈哈同文'), { message_id: 0 }))
  await sleep(50)
  mock.push(priv(OWNER, text('哈哈同文'), { message_id: 0 }))
  await until(() => fake.turns.length > b2)
  assert.equal((fake.turns.at(-1).userText.match(/哈哈同文/g) || []).length, 2, '没有可靠 ID 的不按内容去重')
})

test('发送记录：她回的每一段都落库并记下 QQ 消息 ID', async () => {
  const s = (await fake.call('/state')).json()
  assert.ok(s.storage.counts.messages > 0, '收到的消息进了主库')
  assert.ok(s.storage.counts.requests > 0, '每次交给她都登记了请求')
})

test('连发合并：一口气发两句，她只回一次', async () => {
  const before = fake.turns.length
  mock.push(priv(OWNER, text('第一句')))
  await sleep(150)
  mock.push(priv(OWNER, text('第二句')))
  await until(() => fake.turns.length > before)
  await sleep(800)
  assert.equal(fake.turns.length, before + 1, '两句合成了一轮')
  assert.match(fake.turns.at(-1).userText, /第一句[\s\S]*第二句/)
})

test('本地 CosyVoice：裸 PCM 包成 WAV 发出语音', async () => {
  const http = await import('node:http')
  let got = null
  const srv = http.createServer(async (req, res) => {
    let b = ''
    for await (const c of req) b += c
    got = { url: req.url, body: new URLSearchParams(b) }
    res.end(Buffer.alloc(22050 * 2 * 0.5))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  await fake.call('/save', { voice: { engine: 'cosyvoice', cosyvoice: { url: `http://127.0.0.1:${srv.address().port}`, spkId: '中文女' } } })
  const r = (await fake.call('/voice/test', { text: '你好呀' })).json()
  srv.close()
  await fake.call('/save', { voice: { engine: 'windows' } })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.engine, 'cosyvoice')
  assert.equal(got.url, '/inference_sft')
  assert.equal(got.body.get('tts_text'), '你好呀')
  assert.equal(Buffer.from(r.data, 'base64').toString('ascii', 0, 4), 'RIFF')
})

test('生图：主人让她画图，调生图服务并把图发出去', async () => {
  const http = await import('node:http')
  let body = null
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const srv = http.createServer(async (req, res) => {
    let b = ''
    for await (const c of req) b += c
    body = JSON.parse(b)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  await fake.call('/save', { imageGen: { enabled: true, baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, model: 'test-model', apiKey: 'img-key-123456', stylePrompt: '可爱风' } })
  const n = sentTo('private', OWNER).length
  mock.push(priv(OWNER, text('画一只鲸鱼')))
  await until(() => sentTo('private', OWNER).slice(n).some((c) => c.params.message[0].type === 'image'), 10000)
  srv.close()
  assert.equal(body.model, 'test-model')
  assert.match(body.prompt, /可爱风.*一只蓝色小鲸鱼/)
  const st = (await fake.call('/state')).json()
  assert.equal(st.config.imageGen.apiKey, '', '生图密钥不回传')
  assert.equal(st.config.imageGen.apiKeySet, true)
})

test('每日整理：往日的临时流水整理后清空，今天的保留', async () => {
  const { existsSync } = await import('node:fs')
  const dir = join(dataDir, 'chatlog')
  mkdirSync(dir, { recursive: true })
  const old = join(dir, '2026-01-01.jsonl')
  writeFileSync(old, ['你好', '我喜欢吃辣', '周末一起打游戏吧', '好呀'].map((t, i) => JSON.stringify({ t: i, chatId: 'private:' + OWNER, who: i % 2 ? 'bot' : 'xiaoming', text: t })).join('\n') + '\n')
  const r = (await fake.call('/memory/extract', {})).json()
  assert.equal(r.ok, true, r.message)
  assert.equal(existsSync(old), false, '往日的流水被清空')
  const today = new Date()
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  assert.equal(existsSync(join(dir, key + '.jsonl')), true, '今天的流水保留')
})

test('表情包她自己整理：改名、改标签（同步到 QQ 收藏备注）、删掉', async () => {
  const up = (await fake.call('/sticker/upload', { data: fakePng(200, 200, 9).toString('base64'), name: '测试猫猫' })).json()
  assert.equal(up.ok, true)
  const target = (await fake.call('/stickers')).json().items.find((i) => i.name === '测试猫猫')
  assert.ok(target)
  const mods = mock.sent('modify_custom_face').length
  mock.push(priv(OWNER, text(`表情改名测试 把「${target.name}」改个名`)))
  await until(() => fake.turns.at(-1)?.userText.includes('表情改名测试') && fake.turns.at(-1).toolCalls.length)
  assert.match(fake.turns.at(-1).toolCalls[0].result.message, /改好了/)
  const after = (await fake.call('/stickers')).json().items.find((i) => i.md5 === target.md5)
  assert.equal(after.name, '改过的名字')
  assert.deepEqual(after.tags, ['开心'])
  if (target.emojiId) await until(() => mock.sent('modify_custom_face').length > mods)
  mock.push(priv(OWNER, text('表情删除测试')))
  await until(() => fake.turns.at(-1)?.userText.includes('表情删除测试') && fake.turns.at(-1).toolCalls.length)
  assert.match(fake.turns.at(-1).toolCalls[0].result.message, /删掉了/)
  assert.equal((await fake.call('/stickers')).json().items.some((i) => i.md5 === target.md5), false)
})

test('翻聊天记录：读当前聊天更早的消息', async () => {
  mock.state.history = [{ time: 1700000000, user_id: 777, sender: { user_id: 777, nickname: '老张' }, message: [{ type: 'text', data: { text: '上周说好去吃火锅' } }] }]
  mock.push(priv(OWNER, text('翻聊天记录看看')))
  await until(() => fake.turns.at(-1)?.userText.includes('翻聊天记录') && fake.turns.at(-1).toolCalls.length)
  assert.match(fake.turns.at(-1).toolCalls[0].result.message, /老张：上周说好去吃火锅/)
})

const lastCall = (word) => until(() => { const t = fake.turns.at(-1); return t?.userText.includes(word) && t.toolCalls.length ? t.toolCalls[0] : null })

test('#6 改资料：默认仅主人私聊，昵称 / 签名 / 头像走 SnowLuma 对应动作', async () => {
  mock.push(priv(OWNER, text('改昵称测试')))
  let c = await lastCall('改昵称测试')
  assert.equal(c.result.ok, true)
  assert.deepEqual(mock.sent('set_qq_profile').at(-1).params, { nickname: '小鲸鱼' })
  mock.push(priv(OWNER, text('改签名测试')))
  c = await lastCall('改签名测试')
  assert.equal(c.result.ok, true)
  assert.deepEqual(mock.sent('set_self_longnick').at(-1).params, { longNick: '今天也要开心' })
  mock.push(priv(OWNER, text('换头像测试')))
  c = await lastCall('换头像测试')
  assert.equal(c.result.ok, true)
  assert.equal(mock.sent('set_qq_avatar').at(-1).params.file, 'https://example.com/a.png')
  const n = mock.sent('set_qq_avatar').length
  mock.push(priv(OWNER, text('本地头像测试')))
  c = await lastCall('本地头像测试')
  assert.equal(c.result.ok, false, '本地路径不收')
  assert.equal(mock.sent('set_qq_avatar').length, n)
})

test('#6 改资料：群里默认没有这些工具；调成「所有人」后群友也能改；「关」了谁都不行', async () => {
  const n = mock.sent('set_qq_profile').length
  mock.push(grp('555', OWNER, [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' 改昵称测试一' } }], 'xiaoming'))
  let c = await lastCall('改昵称测试一')
  assert.equal(c.result.message, 'no such tool')
  assert.equal(mock.sent('set_qq_profile').length, n)

  await fake.call('/save', { profilePerms: { qqNickname: 'all' } })
  mock.push(grp('555', '777', [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' 改昵称测试二' } }]))
  c = await lastCall('改昵称测试二')
  assert.equal(c.result.ok, true)
  assert.equal(mock.sent('set_qq_profile').length, n + 1)

  await fake.call('/save', { profilePerms: { qqNickname: 'off' } })
  mock.push(priv(OWNER, text('改昵称测试三')))
  c = await lastCall('改昵称测试三')
  assert.equal(c.result.message, 'no such tool')
  assert.equal(mock.sent('set_qq_profile').length, n + 1)
  await fake.call('/save', { profilePerms: { qqNickname: 'owner' } })
})

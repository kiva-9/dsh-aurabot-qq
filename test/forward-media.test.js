// #14：合并转发里的图和表情。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hubFixture, BOT, GROUP, until } from './helpers/hub-fixture.js'
import { png } from './helpers/images.js'

const CHAT = 'group:' + GROUP, FORWARDER = '111'
const at = { type: 'at', data: { qq: BOT } }
const say = (text) => ({ type: 'text', data: { text } })
const image = (salt = 0) => ({ type: 'image', data: { file: 'base64://' + png(2, 3, salt).toString('base64') } })
const broken = { type: 'image', data: { file: 'base64://' + Buffer.from('not an image').toString('base64') } }
const face = { type: 'mface', data: { summary: '[开心]', url: 'base64://' + png(2, 3, 9).toString('base64') } }
const node = (name, id, ...message) => ({ sender: { user_id: id, nickname: name }, message })
let mid = 700
const event = (message) => ({ post_type: 'message', message_type: 'group', group_id: Number(GROUP), user_id: Number(FORWARDER), message_id: ++mid, time: Math.floor(Date.now() / 1000), self_id: Number(BOT), sender: { nickname: '转发的人' }, message })
const forward = { type: 'forward', data: { id: 'fw1' } }

async function run(t, { nodes, fail = false, message = [at, say(' 看看'), forward], getImage = {} }) {
  const prompts = []
  const calls = { getImage: 0 }
  const f = await hubFixture(t, { config: { merge: { enabled: false } }, brain: ({ text, images }) => { prompts.push({ text, images }); return '[沉默]' },
    onebot: { call: async (action) => {
      if (action === 'get_forward_msg') { if (fail) throw new Error('拉不到'); return { messages: nodes } }
      if (action === 'get_image') { calls.getImage++; return getImage }
      if (action === 'get_group_info') return { group_name: 'g' }
      return {}
    } } })
  await f.hub.onMessage(event(message))
  await until(() => prompts.length)
  const stored = f.storage.db.all("SELECT seg_index, kind, state, remote_json FROM asset_occurrences ORDER BY seg_index")
  return { f, prompt: prompts[0], stored, calls }
}

test('转发里的图交给模型：节点文字保留，来源写原发送者', async t => {
  const { prompt, stored } = await run(t, { nodes: [node('张三', 222, say('看这个'), image())] })
  assert.equal(prompt.images.length, 1)
  assert.match(prompt.text, /张三：看这个\[图片\]/)
  assert.match(prompt.text, /图1：合并转发里 张三 发的（已就绪）/)
  assert.equal(stored.length, 1)
  assert.equal(JSON.parse(stored[0].remote_json).forward.senderId, '222')
})

test('多节点多图：序号唯一，且排在原消息所有段之后；最多 4 张，超出有提示', async t => {
  const nodes = [node('甲', 2, image(1), image(2)), node('乙', 3, image(3)), node('丙', 4, image(4), image(5), image(6))]
  const { prompt, stored } = await run(t, { nodes })
  assert.deepEqual(stored.map(x => x.seg_index), [3, 4, 5, 6])
  assert.match(prompt.text, /另有 2 张图没有展开/)
})

test('顶层图片和转发图片一起：编号都保留', async t => {
  const { stored, prompt } = await run(t, { nodes: [node('甲', 2, image(1))], message: [at, image(7), forward] })
  assert.deepEqual(stored.map(x => x.seg_index), [1, 3])
  assert.match(prompt.text, /图1：转发的人 发的/)
  assert.match(prompt.text, /图2：合并转发里 甲 发的/)
})

test('图片下载失败如实说，不声称看见', async t => {
  const { prompt, stored } = await run(t, { nodes: [node('甲', 2, broken)] })
  assert.equal(stored[0].state, 'failed')
  assert.equal(prompt.images.length, 0)
  assert.match(prompt.text, /图1：合并转发里 甲 发的（下载失败，不能忽略此图生成）/)
})

test('网关只返回转发图片文件名时不把它当作可下载图片', async t => {
  const file = '0123456789abcdef0123456789abcdef.png'
  const { prompt, stored, calls } = await run(t, {
    nodes: [node('甲', 2, { type: 'image', data: { file, url: '' } })],
    getImage: { file, url: '', file_name: file },
  })
  assert.equal(calls.getImage, 1)
  assert.equal(stored[0].state, 'failed')
  assert.equal(prompt.images.length, 0)
  assert.match(prompt.text, /图1：合并转发里 甲 发的（下载失败，不能忽略此图生成）/)
})

test('表情按表情登记，不进普通图片', async t => {
  const { stored, prompt } = await run(t, { nodes: [node('甲', 2, face)] })
  assert.equal(stored[0].kind, 'sticker')
  assert.match(prompt.text, /图1：合并转发里 甲 发的表情/)
})

test('嵌套转发不递归，语音不收；拉取失败不影响消息', async t => {
  const nested = await run(t, { nodes: [node('甲', 2, { type: 'forward', data: { id: 'inner' } }, { type: 'record', data: { file: 'a' } })] })
  assert.equal(nested.stored.length, 0)
  assert.equal(nested.f.storage.db.all("SELECT * FROM asset_occurrences").length, 0)
  const failed = await run(t, { nodes: [], fail: true })
  assert.match(failed.prompt.text, /合并转发（内容没拉到）/)
})

test('转发里的图也进最近媒体，算转发者的；能取回原段地址', async t => {
  const { f } = await run(t, { nodes: [node('张三', 222, image())] })
  const media = f.hub.recentMedia(CHAT, FORWARDER)
  assert.equal(media.length, 1)
  assert.match(media[0].seg.data.file, /^base64:/)
  assert.equal(f.hub.recentMedia(CHAT, '222').length, 0)
})

test('不再把转发里的表情偷进表情库', async t => {
  const collected = []
  const f = await hubFixture(t, { config: { merge: { enabled: false }, stickers: { enabled: true, collect: true, autoChance: 0 } }, stickers: { collect: async (seg) => { collected.push(seg); return { ok: true } } }, brain: () => '[沉默]',
    onebot: { call: async (action) => (action === 'get_forward_msg' ? { messages: [node('甲', 2, face)] } : {}) } })
  await f.hub.onMessage(event([at, forward]))
  await until(() => f.fake.turns.length)
  assert.equal(collected.length, 0)
})

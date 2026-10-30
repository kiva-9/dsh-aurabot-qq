// #4：最近媒体查出现记录，重启不丢，按账号 / 聊天 / 发送者隔离。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hubFixture, OWNER, BOT, GROUP, until } from './helpers/hub-fixture.js'
import { lastImageUrl } from '../src/modules/profile/index.js'

const CHAT = 'group:' + GROUP
let seq = 0
function add(f, { chatId = CHAT, account = BOT, authorId = OWNER, kind = 'image', at = Date.now(), url = 'https://img.test/' + ++seq }) {
  const seg = { type: kind === 'sticker' ? 'mface' : 'image', data: { url, file: url } }
  const m = f.storage.messages.ingest({ account, chatId, eventKind: 'message', platformMsgId: String(++seq), authorId, authorName: 'n', platformTime: at, text: '', segments: [seg] })
  const id = f.storage.occurrences.add({ messageId: m.id, chatId, authorId, segIndex: 0, kind, remote: seg.data, scope: { account, chat: chatId } })
  f.storage.db.run('UPDATE asset_occurrences SET created_at = ? WHERE id = ?', at, id)
  return { ...m, url, platformMsgId: String(seq) }
}

test('收 7 张只留最新 6 张，旧的在前', async t => {
  const f = await hubFixture(t), base = Date.now() - 60_000
  const urls = Array.from({ length: 7 }, (_, i) => add(f, { at: base + i }).url)
  assert.deepEqual(f.hub.recentMedia(CHAT).map(x => x.seg.data.url), urls.slice(1))
})

test('查库不靠内存：新建的中枢（重启）仍能取到，时间不重置', async t => {
  const f = await hubFixture(t), at = Date.now() - 29 * 60_000
  const m = add(f, { at })
  const [got] = f.hub.recentMedia(CHAT)
  assert.equal(got.seg.data.url, m.url)
  assert.equal(got.at, at)
  assert.equal(got.messageId, m.id)
})

test('31 分钟前的取不到', async t => {
  const f = await hubFixture(t)
  add(f, { at: Date.now() - 31 * 60_000 })
  assert.deepEqual(f.hub.recentMedia(CHAT), [])
})

test('不同聊天、不同发送者隔离；换账号后旧账号的图取不到', async t => {
  const f = await hubFixture(t)
  add(f, { authorId: '1111' })
  add(f, { chatId: 'group:7', authorId: '2222' })
  add(f, { account: '99999999' })
  assert.equal(f.hub.recentMedia(CHAT).length, 1)
  assert.equal(f.hub.recentMedia(CHAT, '1111').length, 1)
  assert.equal(f.hub.recentMedia(CHAT, '2222').length, 0)
})

test('撤回的消息不返回', async t => {
  const f = await hubFixture(t), m = add(f, {})
  assert.equal(f.storage.messages.markRecalled(CHAT, m.platformMsgId), 1)
  assert.deepEqual(f.hub.recentMedia(CHAT), [])
})

test('表情和图片分得清，段保留原始类型', async t => {
  const f = await hubFixture(t), base = Date.now() - 1000
  add(f, { at: base, url: 'https://img.test/a' })
  add(f, { at: base + 1, kind: 'sticker', url: 'https://img.test/s' })
  const media = f.hub.recentMedia(CHAT)
  assert.deepEqual(media.map(x => [x.sticker, x.seg.type]), [[false, 'image'], [true, 'mface']])
  assert.equal(lastImageUrl(media), 'https://img.test/a', '换头像不能用表情')
})

test('收到真实消息后经媒体登记也能取到', async t => {
  const f = await hubFixture(t, { onebot: { call: async () => ({ group_name: 'g', message_id: 1 }) } })
  await f.hub.onMessage({ post_type: 'message', message_type: 'group', group_id: Number(GROUP), user_id: 1234, message_id: 55, time: Math.floor(Date.now() / 1000),
    self_id: Number(BOT), sender: { nickname: 'n' }, message: [{ type: 'image', data: { url: 'https://img.test/real', file: 'real.png' } }] })
  await until(() => f.hub.recentMedia(CHAT, '1234').length)
  assert.equal(f.hub.recentMedia(CHAT, '1234')[0].seg.data.file, 'real.png')
})

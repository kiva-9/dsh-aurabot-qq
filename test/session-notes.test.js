import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { normalize } from '../src/core/config.js'
import { createStorage } from '../src/storage/index.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const root = mkdtempSync(join(tmpdir(), 'aurabot-session-notes-'))
const prior = { data: process.env.AURABOT_DATA_DIR, workspace: process.env.AURABOT_WORKSPACE }
process.env.AURABOT_WORKSPACE = join(root, 'workspace')
let createHub
before(async () => { ({ createHub } = await import('../src/chat/hub.js')) })
after(() => {
  for (const [key, value] of [['AURABOT_DATA_DIR', prior.data], ['AURABOT_WORKSPACE', prior.workspace]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
  assert.equal(dirname(resolve(root)), resolve(tmpdir()))
  assert.match(root, /aurabot-session-notes-/)
  rmSync(root, { recursive: true, force: true })
})
const chat = { kind: 'group', groupId: '62001', chatId: 'group:62001' }
const receipt = '图已经发到聊天里了。'
function fixture(t, brain = () => '普通回答') {
  const dir = mkdtempSync(join(root, 'case-'))
  process.env.AURABOT_DATA_DIR = dir
  const storage = createStorage({ file: ':memory:', filesDir: join(dir, 'assets') })
  const cfg = normalize({ enabled: true, dryRun: true, botQQ: '20000002', ownerQQ: '10000001',
    allow: { groups: ['62001', '62002'] }, voice: { enabled: false }, stickers: { enabled: false } })
  const fake = createFakeDsh({ brain })
  const hub = createHub({ dsh: fake.ctx, storage, getConfig: () => cfg,
    onebot: { call: () => assert.fail('No gateway calls allowed') },
    log: { info() {}, warn() {}, error() {}, debug() {} } })
  fake.ctx.on('session/event', hub.onSessionEvent)
  t.after(async () => { await hub.dispose(); await fake.dispose(); storage.close() })
  const push = (text, opts = {}, target = chat) => hub.pushToSession(target, [{ type: 'text', text }], '30000003', opts)
  return { hub, fake, cfg, storage, push }
}

test('job completion between answer and turn end never replaces the answer or wakes a model turn', async t => {
  let f
  f = fixture(t, ({ text, agent }) => {
    if (text === '查完了吗') {
      f.hub.onSessionEvent(agent.session, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '查到的完整答案' }] } } })
      assert.equal(f.hub.noteToSession(chat.chatId, receipt), true)
      // Native DSH inject() is consumed by the active turn's next step.
      return agent.injected.length ? '沉默' : '查到的完整答案'
    }
    return '后续回答'
  })
  const result = await f.hub.capture(async () => {
    await f.push('查完了吗')
    await new Promise(resolve => setTimeout(resolve, 20))
  })
  assert.equal(f.fake.turns.length, 1)
  assert.equal(result.sent.length, 1)
  assert.equal(result.sent[0].message.find(s => s.type === 'text').data.text, '查到的完整答案')
  assert.equal([...f.fake.agents.values()][0].injected.length, 0)
  await f.push('下一个问题')
  assert.match(f.fake.turns[1].userText, /图已经发到聊天里了/)
  assert.match(f.fake.turns[1].userText, /下一个问题/)
  await f.push('再下一个问题')
  assert.doesNotMatch(f.fake.turns[2].userText, /图已经发到聊天里了/)
})

test('completion receipts wait across steers and other chats for a fresh turn in their own chat', async t => {
  const f = fixture(t)
  await f.push('开始')
  f.hub.noteToSession(chat.chatId, receipt)
  await f.push('当前问题的补充', { steer: true })
  assert.doesNotMatch(f.fake.turns.at(-1).userText, /图已经发到聊天里了/)
  await f.push('别的群', {}, { kind: 'group', groupId: '62002', chatId: 'group:62002' })
  assert.doesNotMatch(f.fake.turns.at(-1).userText, /图已经发到聊天里了/)
  await f.push('新问题')
  assert.match(f.fake.turns.at(-1).userText, /图已经发到聊天里了/)
})

for (const change of ['reset', 'account', 'epoch', 'history-boundary']) test(`stale completion receipt cannot survive ${change}`, async t => {
  const f = fixture(t)
  await f.push('开始')
  const scope = { account: f.cfg.botQQ, epoch: f.storage.epochs.current(chat.chatId) }
  assert.equal(f.hub.noteToSession(chat.chatId, receipt, scope), true)
  if (change === 'reset') f.hub.resetChat(chat.chatId)
  if (change === 'account') f.cfg.botQQ = '20000003'
  if (change === 'epoch') f.storage.epochs.bump(chat.chatId, 'test reset')
  if (change === 'history-boundary') f.storage.meta.set('history:boundary:' + f.cfg.botQQ, { at: Date.now() + 1000 })
  if (change !== 'history-boundary') assert.equal(f.hub.noteToSession(chat.chatId, '迟到的旧回执', scope), false)
  await f.push('新问题')
  assert.doesNotMatch(f.fake.turns.at(-1).userText, /图已经发到聊天里了|迟到的旧回执/)
})

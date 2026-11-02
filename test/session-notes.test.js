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
function fixture(t, brain = () => '普通回答', extra = {}) {
  const dir = mkdtempSync(join(root, 'case-'))
  process.env.AURABOT_DATA_DIR = dir
  const storage = createStorage({ file: ':memory:', filesDir: join(dir, 'assets') })
  const cfg = normalize({ enabled: true, dryRun: true, botQQ: '20000002', ownerQQ: '10000001',
    allow: { groups: ['62001', '62002'] }, voice: { enabled: false }, stickers: { enabled: false } })
  const fake = createFakeDsh({ brain })
  const hub = createHub({ dsh: fake.ctx, storage, getConfig: () => cfg,
    onebot: { call: () => assert.fail('No gateway calls allowed') },
    log: { info() {}, warn() {}, error() {}, debug() {} }, ...extra })
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

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
function artwork(f) {
  f.cfg.imageGen.observeGenerated = true
  const assetId = f.storage.assets.put(png, { mime: 'image/png', sourceKind: 'generated' }).id
  const review = (over = {}) => { f.cfg.dryRun = false; return f.hub.reviewArtwork(chat.chatId, { jobId: 'job-1', account: f.cfg.botQQ, personaId: 'fish', epoch: f.storage.epochs.current(chat.chatId),
    assetIds: [assetId], prompt: '一只鲸鱼', note: receipt, ...over }) }
  return { assetId, review }
}
const waitFor = async predicate => { const end = Date.now() + 5000; while (!predicate()) { if (Date.now() > end) throw Error('timeout'); await new Promise(r => setTimeout(r, 10)) } }

test('画图回看：她带着成品起一轮并开口，回合没有请求身份，回执不再出现', async t => {
  let actor
  const f = fixture(t, ({ text, agent }) => { if (/画图结果/.test(text)) actor = f.hub.turnActor(agent.session); return /画图结果/.test(text) ? '画好啦，这鲸鱼尾巴有点短' : '普通回答' }, { personaOf: () => ({ personaId: 'fish', revision: 1 }) })
  const { review } = artwork(f)
  const sent = await f.hub.capture(async () => {
    await f.push('开始', { persona: { personaId: 'fish', revision: 1 } })
    await new Promise(resolve => setTimeout(resolve, 20))
    f.hub.noteToSession(chat.chatId, receipt)
    assert.equal(review(), true)
    await waitFor(() => f.fake.turns.length === 2)
    await new Promise(resolve => setTimeout(resolve, 50))
  })
  const turn = f.fake.turns[1]
  assert.equal(turn.images, 1)
  assert.match(turn.userText, /一只鲸鱼/)
  assert.doesNotMatch(turn.userText, /已处理任务的回执/)
  assert.ok(actor?.error, '群里的回看回合不能以任何人的身份调用工具')
  assert.ok(sent.sent.some(x => x.message.some(s => s.data?.text?.includes('尾巴有点短'))))
})

for (const change of ['observe-off', 'epoch', 'persona', 'expired']) test(`画图回看不登记：${change}`, async t => {
  let personaId = 'fish'
  const f = fixture(t, undefined, { personaOf: () => ({ personaId, revision: 1 }) })
  const { assetId, review } = artwork(f)
  await f.push('开始', { persona: { personaId: 'fish', revision: 1 } })
  if (change === 'observe-off') f.cfg.imageGen.observeGenerated = false
  if (change === 'epoch') { const epoch = f.storage.epochs.current(chat.chatId); f.storage.epochs.bump(chat.chatId, 'test'); assert.equal(review({ epoch }), false); return }
  if (change === 'persona') personaId = 'other'
  if (change === 'expired') {
    f.cfg.dryRun = false
    const context = { account: f.cfg.botQQ, chatId: chat.chatId, personaId: 'fish', epoch: f.storage.epochs.current(chat.chatId), policyRevision: 0, deadline: Date.now() - 1 }
    f.storage.meta.set('artwork:inbox:old', { event: { id: 'old', context, assetIds: [assetId], prompt: '旧图', note: '' }, state: 'queued' })
    f.hub.recoverPlannerWakes()
    assert.equal(f.storage.meta.get('artwork:inbox:old').state, 'canceled')
    assert.equal(f.fake.turns.length, 1)
    return
  }
  assert.equal(review(), false)
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

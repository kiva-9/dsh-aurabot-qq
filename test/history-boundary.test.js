import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { createStorage } from '../src/storage/index.js'
import { normalize } from '../src/core/config.js'
import { historyBoundary, historyTimeAllowed, platformTimeMs } from '../src/chat/history-boundary.js'
import qqTools from '../src/modules/qq-tools/index.js'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { deferred } from './helpers/wp6.js'
import { png } from './helpers/images.js'

const BOT = '20000002', OTHER = '20000003', OWNER = '10000001', MEMBER = '30000003', GROUP = '62001'
const CUTOFF = Date.parse('2026-10-29T09:18:00.500Z')
const text = value => ({ type: 'text', data: { text: value } })
const picture = () => ({ type: 'image', data: { file: 'base64://' + png().toString('base64') } })
const key = account => 'history:boundary:' + account
const boundary = (storage, account = BOT, at = CUTOFF) => storage.meta.set(key(account), { at, reason: 'user-reset' })
const pause = () => new Promise(resolve => setTimeout(resolve, 5))
async function until(check) {
  const end = performance.now() + 2000
  while (!check()) { assert.ok(performance.now() < end, 'local harness timed out'); await pause() }
}

let root, createHub
const savedEnv = { AURABOT_DATA_DIR: process.env.AURABOT_DATA_DIR, AURABOT_WORKSPACE: process.env.AURABOT_WORKSPACE }
before(async () => {
  root = mkdtempSync(join(tmpdir(), 'aurabot-history-boundary-'))
  process.env.AURABOT_DATA_DIR = root
  process.env.AURABOT_WORKSPACE = join(root, 'workspace')
  ;({ createHub } = await import('../src/chat/hub.js'))
})
after(() => {
  for (const [name, value] of Object.entries(savedEnv)) if (value === undefined) delete process.env[name]; else process.env[name] = value
  assert.equal(dirname(resolve(root)), resolve(tmpdir()))
  assert.match(root, /aurabot-history-boundary-/)
  rmSync(root, { recursive: true, force: true })
})

function fixture(t, { cutoff = CUTOFF, hooks = {}, onCommand } = {}) {
  const dir = mkdtempSync(join(root, 'case-'))
  process.env.AURABOT_DATA_DIR = dir
  const storage = createStorage({ file: ':memory:', filesDir: join(dir, 'assets') })
  if (cutoff != null) boundary(storage, BOT, cutoff)
  const cfg = normalize({ enabled: true, dryRun: true, botQQ: BOT, ownerQQ: OWNER,
    allow: { groups: [GROUP, '62002'], private: [MEMBER] }, merge: { enabled: false },
    group: { interjectChance: 0, activeWindowSec: 300 }, voice: { enabled: false, asr: false }, stickers: { collect: false } })
  const calls = [], prompts = [], activity = [], diagnostics = [], requestBatches = []
  const state = { quote: null, history: [], forwards: [], handler: null }
  const onebot = { async call(action, params) {
    calls.push({ action, params })
    if (state.handler) return state.handler(action, params)
    if (action === 'get_msg') return state.quote
    if (action === 'get_group_msg_history' || action === 'get_friend_msg_history') return { messages: state.history }
    if (action === 'get_forward_msg') return { messages: state.forwards }
    if (action === 'get_group_info') return { group_name: '测试群' }
    if (action === 'get_group_member_info' || action === 'get_stranger_info') return { nickname: '测试成员' }
    assert.fail('Unexpected gateway call: ' + action)
  } }
  // 截获最终内容，不调用模型，也不连接任何 QQ 网关。
  t.mock.method(globalThis, 'fetch', () => assert.fail('Network is forbidden in this harness'))
  const fake = createFakeDsh({ brain: () => assert.fail('No model turns should run') })
  const log = { info() {}, debug() {}, warn() {}, error() {} }
  const hub = createHub({ dsh: fake.ctx, storage, onebot, getConfig: () => cfg, log, onCommand,
    onActivity: event => activity.push(event), onDiagnostic: event => { const saved = { ...event, id: 'diag-test-' + diagnostics.length }; diagnostics.push(saved); return saved },
    onRequestBatch: event => requestBatches.push(event),
    hooks: { ...hooks, prompt: (content, info) => {
      prompts.push({ text: content.filter(c => c.type === 'text').map(c => c.text).join('\n'), images: content.filter(c => c.type === 'image'), info })
      return null
    } } })
  let buildTools
  qqTools.setup({ core: { hub, onebot, storage }, config: () => cfg, tool: fn => { buildTools = fn } })
  const historyTool = (kind = 'group') => buildTools({ chat: kind === 'group'
    ? { kind, groupId: GROUP, chatId: 'group:' + GROUP }
    : { kind, userId: OWNER, chatId: 'private:' + OWNER }, level: 'social' }).find(t => t.name === 'qq_chat_history')
  t.after(async () => { await hub.dispose(); await fake.dispose(); storage.close(); assert.equal(fake.turns.length, 0) })
  return { storage, cfg, calls, prompts, activity, diagnostics, requestBatches, state, hub, historyTool }
}

function event(id, { kind = 'private', time = (CUTOFF + 10000) / 1000, user = OWNER, message = [text('当前请求')], ...extra } = {}) {
  return { post_type: 'message', message_type: kind, self_id: BOT, user_id: user, message_id: id, time,
    sender: { user_id: user, nickname: '测试成员' }, ...(kind === 'group' ? { group_id: GROUP } : {}),
    message: kind === 'group' ? [{ type: 'at', data: { qq: BOT } }, ...message] : message, ...extra }
}
const quoted = (patch = {}) => event(100, { time: (CUTOFF + 1000) / 1000, message: [text('引用材料'), picture()], ...patch })
async function ask(f, id, options = {}) {
  const count = f.prompts.length
  await f.hub.onMessage(event(id, { message: [{ type: 'reply', data: { id: '100' } }, text('请核对附件')], ...options }))
  await until(() => f.prompts.length > count)
  return f.prompts.at(-1)
}
const rowCount = (f, table) => Number(f.storage.db.get(`SELECT count(*) AS n FROM ${table}`).n)

test('boundary persists by account, uses milliseconds, and defaults to unrestricted history', t => {
  const dir = mkdtempSync(join(root, 'persist-')), options = { file: join(dir, 'test.sqlite'), filesDir: join(dir, 'assets') }
  let storage = createStorage(options)
  assert.equal(historyBoundary(storage, BOT), 0)
  assert.equal(historyTimeAllowed(storage, BOT, null), true)
  boundary(storage)
  storage.close(); storage = createStorage(options)
  t.after(() => storage.close())
  assert.deepEqual(storage.meta.get(key(BOT)), { at: CUTOFF, reason: 'user-reset' })
  assert.equal(historyBoundary(storage, BOT), CUTOFF)
  assert.equal(historyTimeAllowed(storage, BOT, CUTOFF - 1), false)
  assert.equal(historyTimeAllowed(storage, BOT, CUTOFF), true)
  assert.equal(historyTimeAllowed(storage, BOT, platformTimeMs(String(CUTOFF / 1000))), true)
  for (const time of [undefined, null, '', 'invalid', 0, -1, Infinity, true]) {
    assert.equal(historyTimeAllowed(storage, BOT, platformTimeMs(time)), false)
    assert.equal(historyTimeAllowed(storage, OTHER, platformTimeMs(time)), true)
  }
  boundary(storage, BOT, 0)
  assert.equal(historyTimeAllowed(storage, BOT, null), true)
})

test('ingress rejects old and undated replays before messages, media, hooks or commands are written', async t => {
  const seen = [], commands = [], f = fixture(t, { hooks: { message: msg => { seen.push(msg) } }, onCommand: msg => { commands.push(msg) } })
  let id = 1
  for (const kind of ['group', 'private']) for (const time of [(CUTOFF - 1) / 1000, undefined, null, 0, Infinity, 'invalid']) {
    const raw = event(id++, { kind, message: [text('你别说话了'), picture()] })
    raw.time = time
    await f.hub.onMessage(raw)
  }
  assert.equal(rowCount(f, 'messages'), 0)
  assert.equal(rowCount(f, 'asset_occurrences'), 0)
  assert.deepEqual([seen.length, commands.length, f.activity.length, f.prompts.length, f.hub.stats().received, f.calls.length], [0, 0, 0, 0, 0, 0])
  await f.hub.onMessage(event(id, { time: CUTOFF / 1000 }))
  await until(() => f.prompts.length === 1)
  assert.equal(rowCount(f, 'messages'), 1)
  assert.equal(f.storage.messages.recent('private:' + OWNER)[0].platformTime, CUTOFF)
})

test('a different account and an absent or zero boundary retain undated ingress', async t => {
  const f = fixture(t)
  f.cfg.botQQ = OTHER
  const raw = event(1, { self_id: OTHER }); delete raw.time
  await f.hub.onMessage(raw)
  await until(() => f.prompts.length === 1)
  assert.equal(f.storage.messages.recent('private:' + OWNER)[0].account, OTHER)
  boundary(f.storage, OTHER, CUTOFF)
  await f.hub.onMessage({ ...raw, message_id: 2 })
  assert.equal(rowCount(f, 'messages'), 1)
  boundary(f.storage, OTHER, 0)
  await f.hub.onMessage({ ...raw, message_id: 3 })
  await until(() => f.prompts.length === 2)
  await f.hub.onMessage(event(4, { time: CUTOFF / 1000 }))
  assert.equal(rowCount(f, 'messages'), 2, 'foreign account events must not enter the active hub')
})

for (const kind of ['group', 'private']) for (const [label, patch] of [
  ['before cutoff', { time: (CUTOFF - 1) / 1000 }], ['undated', { time: null }], ['invalid time', { time: 'invalid' }],
  ['other account', { self_id: OTHER }], ['wrong message id', { message_id: 999 }],
  ['other chat', kind === 'group' ? { group_id: '62002' } : { user: MEMBER }],
  ['unverifiable chat', kind === 'group' ? { group_id: undefined } : { message_type: undefined }],
  ['other chat type', kind === 'group' ? { message_type: 'private' } : { message_type: 'group', group_id: GROUP }],
]) test(`get_msg ${kind}: ${label} cannot inject text or materialize media`, async t => {
  const f = fixture(t)
  f.state.quote = quoted({ kind, ...patch })
  const result = await ask(f, 1, { kind })
  assert.doesNotMatch(result.text, /引用材料/)
  assert.equal(result.images.length, 0)
  assert.equal(result.info.images.length, 0)
  assert.equal(rowCount(f, 'messages'), 1)
  assert.equal(rowCount(f, 'asset_occurrences'), 0)
  assert.equal(rowCount(f, 'assets'), 0)
  assert.equal(f.calls.filter(c => c.action === 'get_msg').length, 1)
})

for (const kind of ['group', 'private']) test(`get_msg ${kind}: valid same-scope references preserve text and images`, async t => {
  const f = fixture(t)
  f.state.quote = quoted({ kind, time: CUTOFF / 1000 })
  const result = await ask(f, 1, { kind })
  assert.match(result.text, /引用材料/)
  assert.equal(result.images.length, 1)
  const m = f.storage.messages.byPlatformId(`${kind}:${kind === 'group' ? GROUP : OWNER}`, 100, 'message', BOT)
  assert.equal(m.account, BOT)
  assert.equal(m.platformTime, CUTOFF)
  const occurrence = f.storage.occurrences.ofMessage(m.id)[0]
  assert.equal(occurrence.scope.account, BOT)
  assert.equal(occurrence.chatId, m.chatId)
  assert.equal(rowCount(f, 'assets'), 1)
})

test('without a boundary an undated same-scope get_msg still works', async t => {
  const f = fixture(t, { cutoff: null }); f.state.quote = quoted({ time: null })
  const result = await ask(f, 1)
  assert.match(result.text, /引用材料/)
  assert.equal(result.images.length, 1)
})

test('private bot references need the current recipient, not just the bot sender', async t => {
  const f = fixture(t)
  for (const target_id of [undefined, MEMBER]) {
    f.state.quote = quoted({ user: BOT, target_id })
    const result = await ask(f, f.prompts.length + 1)
    assert.doesNotMatch(result.text, /引用材料/)
  }
  f.state.quote = quoted({ user: BOT, target_id: OWNER })
  const result = await ask(f, 3)
  assert.match(result.text, /你自己.*引用材料/)
  assert.equal(result.images.length, 1)
})

for (const platformTime of [CUTOFF - 1, null]) test(`cached quote with time ${platformTime} cannot bypass the boundary`, async t => {
  const f = fixture(t), chatId = 'private:' + OWNER
  const m = f.storage.messages.ingest({ account: BOT, chatId, eventKind: 'message', platformMsgId: 100, authorId: OWNER, platformTime, text: '缓存旧内容' })
  const asset = f.storage.assets.put(png(), { mime: 'image/png' })
  const occurrence = f.storage.occurrences.add({ messageId: m.id, chatId, authorId: OWNER, segIndex: 0, kind: 'image', scope: { account: BOT, chat: chatId } })
  f.storage.occurrences.ready(occurrence, asset.id)
  const result = await ask(f, 1)
  assert.doesNotMatch(result.text, /缓存旧内容/)
  assert.equal(result.images.length, 0)
  assert.equal(f.calls.length, 0, 'a rejected cached quote must not be fetched again')
})

test('local quote lookup cannot use another account or chat with the same platform ID', async t => {
  const f = fixture(t)
  for (const [account, chatId] of [[OTHER, 'private:' + OWNER], [BOT, 'private:' + MEMBER]]) {
    f.storage.messages.ingest({ account, chatId, eventKind: 'message', platformMsgId: 100, authorId: OWNER, platformTime: CUTOFF + 1, text: '其他范围秘密' })
  }
  f.state.quote = quoted()
  const result = await ask(f, 1)
  assert.doesNotMatch(result.text, /其他范围秘密/)
  assert.match(result.text, /引用材料/)
  assert.equal(rowCount(f, 'messages'), 4)
})

for (const [label, account, at, withRequest, allowed] of [
  ['old', BOT, CUTOFF - 1, true, false], ['other account', OTHER, CUTOFF + 1, true, false],
  ['unproven account', BOT, CUTOFF + 1, false, false], ['current', BOT, CUTOFF + 1, true, true],
]) test(`outbox quote ${label} observes account and reset boundary for text and assets`, async t => {
  const f = fixture(t), chatId = 'private:' + OWNER
  const source = f.storage.messages.ingest({ account, chatId, eventKind: 'message', authorId: OWNER, platformTime: at, text: '来源' })
  const request = withRequest ? f.storage.requests.create({ chatId, actorId: OWNER, sourceMessageIds: [source.id] }) : null
  const asset = f.storage.assets.put(png(), { mime: 'image/png' })
  const batchId = f.hub.outbox.enqueue({ chatId, requestId: request?.id, items: [{ kind: 'text', message: [text('机器人引用材料'), { type: 'image', data: { file: 'asset:' + asset.id } }] }] })
  f.storage.db.run("UPDATE outbox SET platform_msg_id='100', state='delivered', created_at=? WHERE batch_id=?", at, batchId)
  const result = await ask(f, 1)
  assert.equal(result.text.includes('机器人引用材料'), allowed)
  assert.equal(result.images.length, allowed ? 1 : 0)
})

test('new self replies keep working, but the sent-ID cache cannot cross chat, account or reset boundary', async t => {
  let now = CUTOFF + 10000
  t.mock.method(Date, 'now', () => now)
  const f = fixture(t)
  // 完全本地的回执桩，无网络请求。
  f.cfg.dryRun = false
  f.state.handler = async action => {
    if (action === 'send_group_msg') return { message_id: 100 }
    if (action === 'get_msg') return null
    if (action === 'get_group_info') return { group_name: '测试群' }
    assert.fail('Unexpected gateway call: ' + action)
  }
  await f.hub.sendSegments('group:' + GROUP, [text('本地回执对应的新答复')], '测试')
  const reply = (id, extra = {}) => {
    const raw = event(id, { kind: 'group', time: now / 1000, ...extra })
    raw.message = [{ type: 'reply', data: { id: 100 } }, text('收到')]
    return f.hub.onMessage(raw)
  }
  await reply(1); await until(() => f.prompts.length === 1)
  assert.match(f.prompts[0].text, /本地回执对应的新答复/)
  await reply(2, { group_id: '62002' }); await until(() => f.diagnostics.length === 2)
  assert.equal(f.prompts.length, 1)
  boundary(f.storage, BOT, now + 1); now += 1000
  await reply(3, { user: MEMBER }); await until(() => f.diagnostics.length === 3)
  assert.equal(f.prompts.length, 1)
  f.cfg.botQQ = OTHER
  await reply(4, { self_id: OTHER }); await until(() => f.diagnostics.length === 4)
  assert.equal(f.prompts.length, 1)
})

test('a rejected explicit quote never substitutes a different recent image', async t => {
  const f = fixture(t), chatId = 'private:' + OWNER
  const m = f.storage.messages.ingest({ account: BOT, chatId, eventKind: 'message', platformMsgId: 99, authorId: OWNER, platformTime: CUTOFF + 1, text: '无关的新图片' })
  const asset = f.storage.assets.put(png(), { mime: 'image/png' })
  const occurrence = f.storage.occurrences.add({ messageId: m.id, chatId, authorId: OWNER, segIndex: 0, kind: 'image', scope: { account: BOT, chat: chatId } })
  f.storage.occurrences.ready(occurrence, asset.id)
  f.state.quote = quoted({ time: (CUTOFF - 1) / 1000 })
  const result = await ask(f, 1, { message: [{ type: 'reply', data: { id: 100 } }, text('刚才那张图改一下')] })
  assert.doesNotMatch(result.text, /无关的新图片|引用材料/)
  assert.equal(result.images.length, 0)
})

test('a quote accepted before reset cannot enter a later queued prompt', async t => {
  const f = fixture(t)
  Object.assign(f.cfg.merge, { enabled: true, waitSec: 0.05, maxSec: 0.05 })
  f.state.quote = quoted()
  await f.hub.onMessage(event(1, { message: [{ type: 'reply', data: { id: 100 } }, text('当前请求')] }))
  boundary(f.storage, BOT, CUTOFF + 5000)
  await until(() => f.prompts.length === 1)
  assert.doesNotMatch(f.prompts[0].text, /引用材料/)
  assert.equal(f.prompts[0].images.length, 0)
})

test('an ingress message queued before reset is not dispatched afterwards', async t => {
  const f = fixture(t)
  Object.assign(f.cfg.merge, { enabled: true, waitSec: 0.02, maxSec: 0.02 })
  await f.hub.onMessage(event(1))
  boundary(f.storage, BOT, CUTOFF + 20000)
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(f.prompts.length, 0)
  assert.equal(rowCount(f, 'requests'), 0)
})

test('a boundary advanced during get_msg is checked before writeback', async t => {
  const f = fixture(t), entered = deferred(), pending = deferred()
  f.state.handler = async action => { assert.equal(action, 'get_msg'); entered.resolve(); return pending.promise }
  const incoming = f.hub.onMessage(event(1, { message: [{ type: 'reply', data: { id: 100 } }, text('当前请求')] }))
  await entered.promise
  boundary(f.storage, BOT, CUTOFF + 5000)
  pending.resolve(quoted())
  await incoming; await until(() => f.prompts.length === 1)
  assert.doesNotMatch(f.prompts[0].text, /引用材料/)
  assert.equal(rowCount(f, 'messages'), 1)
  assert.equal(rowCount(f, 'asset_occurrences'), 0)
})

test('an account change during get_msg cannot relabel or materialize its result', async t => {
  const f = fixture(t), entered = deferred(), pending = deferred()
  f.state.handler = async () => { entered.resolve(); return pending.promise }
  const incoming = f.hub.onMessage(event(1, { message: [{ type: 'reply', data: { id: 100 } }, text('当前请求')] }))
  await entered.promise; f.cfg.botQQ = OTHER; pending.resolve(quoted()); await incoming
  assert.equal(rowCount(f, 'messages'), 1)
  assert.equal(rowCount(f, 'asset_occurrences'), 0)
  assert.equal(f.prompts.length, 0)
})

for (const kind of ['group', 'private']) test(`qq_chat_history ${kind} filters before slicing and never writes history to storage`, async t => {
  const f = fixture(t)
  f.state.history = [event(1, { kind, time: CUTOFF / 1000, message: [text('有效一')] }),
    event(2, { kind, message: [text('有效二')] }), quoted({ kind, time: (CUTOFF - 1) / 1000 }), quoted({ kind, time: null }),
    quoted({ kind, self_id: OTHER }), quoted({ kind, ...(kind === 'group' ? { group_id: '62002' } : { user: MEMBER }) })]
  const result = await f.historyTool(kind).execute({ count: 2 })
  assert.equal(result.ok, true)
  assert.match(result.message, /有效一/); assert.match(result.message, /有效二/)
  assert.doesNotMatch(result.message, /引用材料|boundary|cutoff|边界|清空/)
  assert.equal(result.message.split('\n').length, 2)
  assert.equal(rowCount(f, 'messages'), 0)
  f.state.history = f.state.history.slice(2)
  assert.deepEqual(await f.historyTool(kind).execute({ count: 2 }), { ok: true, message: '没翻到聊天记录' })
})

test('history keeps legacy undated entries without a boundary and reads a newly set cutoff on each call', async t => {
  const f = fixture(t, { cutoff: null }), tool = f.historyTool()
  f.state.history = [quoted({ kind: 'group', time: null }), quoted({ kind: 'group', time: (CUTOFF - 1) / 1000 })]
  assert.match((await tool.execute({})).message, /引用材料/)
  boundary(f.storage)
  assert.equal((await tool.execute({})).message, '没翻到聊天记录')
  f.cfg.botQQ = OTHER
  assert.equal((await tool.execute({})).ok, false, 'an old tool cannot change accounts')
  f.state.history = [quoted({ kind: 'group', self_id: OTHER, time: null })]
  assert.match((await f.historyTool().execute({})).message, /引用材料/, 'another account has its own boundary')
})

test('history rechecks cutoff and account after an asynchronous server response', async t => {
  const f = fixture(t)
  f.state.handler = async () => { boundary(f.storage, BOT, CUTOFF + 5000); return { messages: [quoted({ kind: 'group' })] } }
  assert.equal((await f.historyTool().execute({})).message, '没翻到聊天记录')
  f.state.handler = async () => { f.cfg.botQQ = OTHER; return { messages: [quoted({ kind: 'group', time: (CUTOFF + 10000) / 1000 })] } }
  assert.equal((await f.historyTool().execute({})).message, '没翻到聊天记录')
})

test('stale pokes do not reach hooks or throttle a fresh poke; fresh time survives synthesis', async t => {
  const pokes = [], f = fixture(t, { hooks: { poke: ev => { pokes.push(ev) } } })
  const poke = { self_id: BOT, target_id: BOT, user_id: OWNER }
  await f.hub.onPoke({ ...poke, time: (CUTOFF - 1) / 1000 })
  await f.hub.onPoke(poke)
  assert.equal(pokes.length, 0); assert.equal(f.calls.length, 0)
  await f.hub.onPoke({ ...poke, time: CUTOFF / 1000 })
  await until(() => f.prompts.length === 1)
  assert.equal(pokes.length, 1)
  const m = f.storage.messages.recent('private:' + OWNER)[0]
  assert.equal(m.eventKind, 'poke'); assert.equal(m.platformTime, CUTOFF)
  assert.match(f.prompts[0].text, /戳了戳你/)
})

test('a newly sent forward remains new material even when its nodes are old or undated', async t => {
  const f = fixture(t)
  f.state.forwards = [quoted({ time: (CUTOFF - 100000) / 1000, message: [text('用户主动转发的旧资料')] }), quoted({ time: null, message: [text('转发无日期资料')] })]
  await f.hub.onMessage(event(1, { message: [text('请阅读'), { type: 'forward', data: { id: 'forward-1' } }] }))
  await until(() => f.prompts.length === 1)
  assert.match(f.prompts[0].text, /用户主动转发的旧资料/)
  assert.match(f.prompts[0].text, /转发无日期资料/)
  assert.equal(rowCount(f, 'messages'), 1)
})

test('owner natural-language text reaches onCommand; other members cannot trigger it', async t => {
  const commands = [], f = fixture(t, { onCommand: msg => { commands.push(msg); return '' } })
  for (const user of [OWNER, MEMBER]) await f.hub.onMessage(event(user, { kind: 'group', user, message: [text('你别说话了')] }))
  assert.equal(commands.length, 1)
  assert.equal(commands[0].userId, OWNER)
  assert.equal(commands[0].text, '你别说话了')
})

test('automatic group background expires by activeWindowSec, while recent context, current messages and explicit quotes remain', async t => {
  let now = CUTOFF + 10000, backgroundOnly = true
  t.mock.method(Date, 'now', () => now)
  const f = fixture(t, { hooks: { message: () => backgroundOnly } })
  f.cfg.group.activeWindowSec = 3600
  f.cfg.group.overrides[GROUP] = { activeWindowSec: 300 }
  const send = (id, value) => f.hub.onMessage(event(id, { kind: 'group', time: now / 1000, message: [text(value)] }))
  await send(100, '36分钟前的老话题')
  now += 35 * 60000
  await send(101, '窗口内背景')
  now += 60000; backgroundOnly = false
  await send(102, '当前话题')
  await until(() => f.prompts.length === 1)
  assert.doesNotMatch(f.prompts[0].text, /36分钟前的老话题/)
  assert.match(f.prompts[0].text, /窗口内背景/); assert.match(f.prompts[0].text, /当前话题/)
  const quote = await ask(f, 103, { kind: 'group', time: now / 1000 })
  assert.match(quote.text, /回复.*36分钟前的老话题/, 'activeWindowSec must not limit explicit references')
  f.state.history = [event(100, { kind: 'group', time: (CUTOFF + 10000) / 1000, message: [text('36分钟前的老话题')] })]
  assert.match((await f.historyTool().execute({})).message, /36分钟前的老话题/, 'history has the reset boundary, not the automatic background window')
})

test('raising the boundary also removes already buffered automatic background', async t => {
  let backgroundOnly = true
  const f = fixture(t, { hooks: { message: () => backgroundOnly } })
  await f.hub.onMessage(event(1, { kind: 'group', time: CUTOFF / 1000, message: [text('重置前缓冲')] }))
  boundary(f.storage, BOT, CUTOFF + 1000); backgroundOnly = false
  await f.hub.onMessage(event(2, { kind: 'group', message: [text('重置后请求')] }))
  await until(() => f.prompts.length === 1)
  assert.doesNotMatch(f.prompts[0].text, /重置前缓冲/)
  assert.match(f.prompts[0].text, /重置后请求/)
})

test('a group decision links every actor request in a merged batch', async t => {
  const f = fixture(t)
  Object.assign(f.cfg.merge, { enabled: true, groupWaitSec: 0.2, groupMaxSec: 2, mentionWaitSec: 0.1 })
  for (const [index, user] of [OWNER, MEMBER, '30000004'].entries()) {
    await f.hub.onMessage(event(index + 1, { kind: 'group', user, message: [text('不同群友的问题' + index)] }))
  }
  await until(() => f.prompts.length === 1)
  assert.equal(f.requestBatches.length, 1)
  const batch = f.requestBatches[0]
  assert.equal(batch.requestIds.length, 3)
  const decision = f.diagnostics.find(e => e.kind === '群聊决策')
  assert.deepEqual(batch.decisionEventIds, [decision.id])
  assert.equal(decision.payload.batchSize, 3)
  assert.equal(new Set(batch.requestIds.map(id => f.storage.requests.get(id).actorId)).size, 3)
})

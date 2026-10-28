import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorage } from '../src/storage/index.js'
import { normalize } from '../src/core/config.js'
import songModule from '../src/modules/song/index.js'
import biliModule from '../src/modules/bili/index.js'
import speakModule from '../src/modules/speakup/index.js'

function fixture(t, module) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-retained-module-'))
  process.env.AURABOT_DATA_DIR = dir
  const storage = createStorage({ file: ':memory:', filesDir: join(dir, 'assets') })
  const cfg = normalize({ enabled: true, dryRun: false, botQQ: '90000001', ownerQQ: '10000001',
    song: { enabled: true, root: join(dir, 'runtime') }, bili: { enabled: true },
    speakUp: { awakeFrom: 0, awakeTo: 24 }, profilePerms: { biliSign: 'all', biliAvatar: 'all' } })
  const builders = [], callbacks = [], routes = new Map(), commands = [], eventHandlers = new Map(), events = [], mood = [], memory = []
  let turn, chatId = 'group:22'
  const hub = { turnActor: () => turn, turnHasOwner: () => true, turnSendersAllOwner: () => true,
    chatOfSession: () => chatId, personaFor: () => ({ personaId: 'fish', layers: { identity: { name: '鱼' } } }),
    scopeFor: (chat) => ({ account: cfg.botQQ, chat, persona: 'fish' }),
    sendVoiceFile: () => assert.fail('本测试禁止真实 QQ'), sendText: () => assert.fail('本测试禁止真实 QQ') }
  const api = { core: { hub, storage, http: { body: async (b) => b }, mutes: { muted: () => false }, local: { active: () => false },
    ask: () => assert.fail('本测试禁止真实模型') }, config: () => cfg, log: { info() {}, warn() {}, debug() {} },
    tool: (builder) => builders.push(builder), route: (path, fn) => routes.set(path, fn), every() {},
    on: (event, fn) => eventHandlers.set(event, fn), onDispose: (fn) => callbacks.push(fn), command: (cmd) => commands.push(cmd),
    emit: (name, payload) => events.push({ name, payload }), lazy: (name) => name === 'memory' ? { addEvent: (e) => { memory.push(e); return { ok: true } } }
      : { nudge: (...args) => mood.push(args) } }
  const service = module.setup(api)
  function actor(id, currentChat = chatId) {
    chatId = currentChat
    const m = storage.messages.ingest({ account: cfg.botQQ, chatId, authorId: id, text: '明确请求', eventKind: 'message' })
    const r = storage.requests.create({ chatId, actorId: id, sourceMessageIds: [m.id] })
    turn = { actorId: id, requestId: r.id }; return r
  }
  const tools = () => builders.flatMap((b) => b({ sessionId: 'sid', chat: { chatId, kind: chatId.split(':')[0], userId: chatId.slice(8) } })).filter(Boolean)
  const tool = (name) => tools().find((x) => x.name === name)
  t.after(() => { callbacks.forEach((f) => f()); storage.close(); rmSync(dir, { recursive: true, force: true }) })
  return { api, service, actor, tool, cfg, hub, storage, routes, commands, eventHandlers, events, mood, memory, setTurn: (value) => { turn = value } }
}

test('翻唱工具不借用同轮主人身份；明确 turnActor 后绑定 request/chat/persona/epoch', async (t) => {
  const f = fixture(t, songModule), calls = []
  f.service.request = (o) => { calls.push(o); return { ok: true } }
  f.actor('20000002')
  assert.equal((await f.tool('qq_song_cover').execute({ song: '测试' })).ok, false)
  assert.equal(calls.length, 0)
  const request = f.actor('10000001')
  assert.equal((await f.tool('qq_song_cover').execute({ song: '测试' })).ok, true)
  assert.equal(calls[0].requestId, request.id); assert.equal(calls[0].actorId, '10000001')
  assert.equal(calls[0].chatId, 'group:22'); assert.equal(calls[0].account, '90000001'); assert.equal(calls[0].persona, 'fish')
  f.storage.epochs.bump('group:22', '取消')
  assert.equal((await f.tool('qq_song_cover').execute({ song: '测试' })).ok, false)
  assert.equal(calls.length, 1)
  f.setTurn({ error: 'MIXED_ACTORS' })
  assert.equal((await f.tool('qq_song_cover').execute({ song: '测试' })).ok, false)
})

test('翻唱模块用真实 receipt 写范围经历，并以真实请求来源接新版 mood.nudge', async (t) => {
  const f = fixture(t, songModule), r = f.actor('10000001'), scope = f.hub.scopeFor('group:22')
  const job = f.service.runner.enqueue({ kind: 'song', chatId: 'group:22', requestId: r.id, actorId: r.actorId, epoch: r.epoch,
    input: { scope, dryRun: false, personaSnapshot: f.hub.personaFor('group:22') } })
  const output = { title: '测试歌', receipt: { delivered: 1, message_id: 'confirmed-qq' } }
  f.storage.db.run("UPDATE jobs SET state='delivered',output_json=? WHERE id=?", JSON.stringify(output), job.id)
  const execution = { guard: () => true, commit: (fn) => fn() }
  await f.service.handler.notify(f.service.runner.get(job.id), 'delivered', {}, execution)
  await f.service.handler.notify(f.service.runner.get(job.id), 'delivered', {}, execution)
  assert.equal(f.memory.length, 1)
  assert.deepEqual(f.memory[0].scope, scope)
  assert.equal(f.memory[0].sourceId, 'qq:90000001:group:22:confirmed-qq')
  assert.equal(f.memory[0].confirmed, true)
  assert.deepEqual(f.mood[0][0], scope)
  assert.deepEqual(f.mood[0][3].evidenceMessageIds, r.sourceMessageIds)
  assert.equal(f.mood[0][3].origin, 'song')
})

test('B站每个手动工具传当前 scope；混合群聊的非主人不能借用评论权限', async (t) => {
  const f = fixture(t, biliModule), calls = []
  for (const method of ['watch', 'comment', 'setSign', 'setAvatar']) f.service[method] = (...args) => { calls.push({ method, args }); return { ok: true } }
  f.actor('20000002')
  assert.equal((await f.tool('bili_watch').execute({ link: 'BV1bbbbbbbbb' })).ok, true)
  assert.equal((await f.tool('bili_comment').execute({ link: 'BV1bbbbbbbbb', text: '不应发送' })).ok, false)
  assert.equal(calls.length, 1)
  const r = f.actor('10000001')
  assert.equal((await f.tool('bili_comment').execute({ link: 'BV1bbbbbbbbb', text: '主人请求' })).ok, true)
  assert.equal((await f.tool('bili_set_sign').execute({ text: '新签名' })).ok, true)
  assert.equal((await f.tool('bili_set_avatar').execute({ image: 'https://example.com/a.png' })).ok, true)
  for (const call of calls) assert.deepEqual(call.args.at(-1).scope, { account: '90000001', chat: 'group:22', persona: 'fish' })
  assert.equal(calls[1].args.at(-1).requestId, r.id)
  f.storage.requests.setState(r.id, 'canceled')
  assert.equal((await f.tool('bili_watch').execute({ link: 'BV1bbbbbbbbb' })).ok, false)
})

test('B站 last 头像不能借用同群其他请求者的图片；owner 档资料权限按 turnActor', async (t) => {
  const f = fixture(t, biliModule)
  f.service.setAvatar = () => assert.fail('不能借用别人的图')
  f.eventHandlers.get('message')({ chatId: 'group:22', userId: '20000002', images: [{ data: { url: 'https://example.com/other.png' } }] })
  f.actor('10000001')
  assert.equal((await f.tool('bili_set_avatar').execute({ image: 'last' })).ok, false)
  f.cfg.profilePerms.biliSign = 'owner'
  f.actor('20000002', 'private:10000001')
  f.service.setSign = () => assert.fail('不能借用 turnHasOwner')
  assert.equal((await f.tool('bili_set_sign').execute({ text: '不应改动' })).ok, false)
})

test('主动聊天面板返回真实入队结果，缺少 hub 调度接口时不会假报成功', async (t) => {
  const f = fixture(t, speakModule)
  const r = await f.routes.get('/speakup/fire')()
  assert.equal(r.ok, false); assert.equal(r.code, 'SCHEDULER_UNAVAILABLE')
  f.cfg.dryRun = true
  assert.equal((await f.routes.get('/speakup/fire')()).code, 'QUIET_OR_DISABLED')
})

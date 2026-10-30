// #9：查资料、发头像、群友头像当生图参考。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import imagegen from '../src/modules/imagegen/index.js'
import profileModule from '../src/modules/profile/index.js'
import { normalize } from '../src/core/config.js'
import { avatarUrl, createAvatarReferences, createQqProfile, downloadAvatar } from '../src/features/qq-profile.js'
import { createStorage } from '../src/storage/index.js'
import { png } from './helpers/images.js'

const BOT = '20000002', OWNER = '10000001', GROUP = '62001', MEMBER = '30000003', OTHER = '40000004'
const image = () => png()
const group = { kind: 'group', groupId: GROUP, chatId: 'group:' + GROUP }
const fetched = []
const fetchAvatar = async (url, options) => { fetched.push({ url, options }); return image() }

function gateway(overrides = {}) {
  return { calls: [], async call(action, params) {
    this.calls.push({ action, params })
    if (overrides[action]) return overrides[action](params)
    if (action === 'get_group_member_info') { if (String(params.user_id) === OTHER) throw new Error('不是群成员'); return { user_id: params.user_id } }
    return {}
  } }
}
function storageFor(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-profile-'))
  const storage = createStorage({ file: ':memory:', filesDir: join(dir, 'assets') })
  t.after(() => { storage.close(); rmSync(dir, { recursive: true, force: true }) })
  return storage
}
const profile = (onebot, options = {}) => createQqProfile({ getConfig: () => ({ botQQ: BOT }), onebot, ask: async () => '蓝色小鱼', fetchAvatar, ...options })

test('昵称、签名正常返回；空签名是未设置，缺字段是未能获取', async () => {
  const blank = await profile(gateway({ get_stranger_info: () => ({ user_id: BOT, nickname: '肥鱼', long_nick: '  ' }) })).read()
  assert.equal(blank.nickname, '肥鱼')
  assert.equal(blank.signature, '')
  const missing = await profile(gateway({ get_stranger_info: () => ({ user_id: BOT, nickname: '肥鱼' }) })).read()
  assert.equal(missing.signature, null)
  assert.match(missing.warnings.join(), /签名未能获取/)
})

test('get_stranger_info 失败时回退 get_login_info', async () => {
  const p = await profile(gateway({ get_stranger_info: () => { throw new Error('x') }, get_login_info: () => ({ user_id: BOT, nickname: '备用' }) })).read()
  assert.equal(p.nickname, '备用')
})

test('网关账号和机器人不一致：拒绝', async () => {
  await assert.rejects(profile(gateway({ get_stranger_info: () => ({ user_id: 999, nickname: '别人' }) })).read(), { code: 'ACCOUNT_MISMATCH' })
})

test('视觉不可用只给地址，不编造', async () => {
  const failed = await profile(gateway(), { ask: async () => { throw new Error('不能看图') } }).read({ viewAvatar: true })
  assert.equal(failed.description, null)
  assert.equal(failed.avatarUrl, avatarUrl(BOT))
  assert.match(failed.warnings.join(), /没看成/)
  assert.equal((await profile(gateway()).read({ viewAvatar: true })).description, '蓝色小鱼')
  assert.equal((await profile(gateway()).read()).description, null, '默认不下载')
})

test('下载限 2MB / 8 秒，地址只由 QQ 号拼出；不是图片就拒绝', async () => {
  fetched.length = 0
  await downloadAvatar(MEMBER, { fetchAvatar })
  assert.equal(fetched[0].url, `https://q1.qlogo.cn/g?b=qq&nk=${MEMBER}&s=640`)
  assert.deepEqual(fetched[0].options, { maxBytes: 2097152, timeoutMs: 8000 })
  await assert.rejects(downloadAvatar(MEMBER, { fetchAvatar: async () => Buffer.from('<html>not image</html>') }), /没返回图片/)
})

function references(t, { actor = MEMBER, owner = false, onebot = gateway(), download = fetchAvatar } = {}) {
  const storage = storageFor(t)
  const hub = { turnActor: () => ({ actorId: actor }), turnSendersAllOwner: () => owner }
  return { onebot, storage, resolve: createAvatarReferences({ hub, onebot, storage, fetchAvatar: download }).resolve }
}

test('群友默认用自己的头像，存成 avatar 资产', async t => {
  const f = references(t), r = await f.resolve({ chat: group, sessionId: 's' })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.qq, MEMBER)
  assert.equal(r.role, 'identity')
  assert.equal(f.storage.db.get('SELECT source_kind FROM assets WHERE id = ?', r.assetId).source_kind, 'avatar')
  assert.ok(f.onebot.calls.some(c => c.action === 'get_group_member_info' && c.params.no_cache === true))
})

test('群友要用别人的：拒绝且不下载', async t => {
  fetched.length = 0
  const f = references(t), r = await f.resolve({ chat: group, sessionId: 's', qq: OWNER })
  assert.equal(r.ok, false)
  assert.equal(fetched.length, 0)
})

test('主人可指定本群成员；非本群成员拒绝；私聊不能指定别人', async t => {
  const f = references(t, { actor: OWNER, owner: true })
  assert.equal((await f.resolve({ chat: group, sessionId: 's', qq: MEMBER })).ok, true)
  assert.equal((await f.resolve({ chat: group, sessionId: 's', qq: OTHER })).ok, false)
  assert.equal((await f.resolve({ chat: { kind: 'private', chatId: 'private:' + OWNER, userId: OWNER }, sessionId: 's', qq: MEMBER })).ok, false)
})

test('QQ 不合法、下载失败都明确失败', async t => {
  const bad = references(t, { actor: OWNER, owner: true })
  assert.equal((await bad.resolve({ chat: group, sessionId: 's', qq: 'https://evil.test/a.png' })).ok, false)
  const down = references(t, { download: async () => { throw new Error('超时') } })
  assert.match((await down.resolve({ chat: group, sessionId: 's' })).message, /拿不到头像/)
})

function module(t, { chat = { kind: 'private', chatId: 'private:' + OWNER, userId: OWNER }, config = {}, owner = true, send = async () => ({ message_id: 1 }) } = {}) {
  const storage = storageFor(t), cfg = { ...normalize({ botQQ: BOT, ownerQQ: OWNER }), dryRun: false, ...config }
  let build
  const hub = { recentMedia: () => [], chatOfSession: () => chat.chatId, turnSendersAllOwner: () => owner, turnActor: () => ({ actorId: owner ? OWNER : MEMBER }), sendSegments: send,
    sendImageAssets: async () => ({ delivered: 1, messageIds: [5] }) }
  profileModule.setup({ core: { hub, onebot: gateway(), storage, ask: async () => '', fetchAvatar }, config: () => cfg, log: { warn() {}, debug() {} }, on() {}, tool: fn => { build = fn } })
  return { tools: () => build({ chat, sessionId: 's' }), hub }
}
const named = (tools, name) => tools.find(x => x.name === name)

test('查询和发头像只在主人私聊挂载', async t => {
  const names = module(t).tools().map(x => x.name)
  assert.ok(names.includes('qq_get_profile') && names.includes('qq_send_avatar'))
  const inGroup = module(t, { chat: group }).tools().map(x => x.name)
  assert.equal(inGroup.includes('qq_get_profile') || inGroup.includes('qq_send_avatar'), false)
  assert.ok(inGroup.includes('qq_get_group_member_avatar'))
})

test('qq_send_avatar：试运行不下载，没有 message_id 不报成功', async t => {
  assert.match((await named(module(t, { config: { dryRun: true } }).tools(), 'qq_send_avatar').execute({})).message, /试运行/)
  const failed = await named(module(t, { send: async () => null }).tools(), 'qq_send_avatar').execute({})
  assert.equal(failed.ok, false)
})

function draw(t, { actor = MEMBER, owner = false, onebot = gateway() } = {}) {
  const state = { download: async () => readFileSync(new URL('../assets/dafeiyu.jpg', import.meta.url)) }
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-draw-'))
  const storage = createStorage({ file: ':memory:', filesDir: join(dir, 'assets') })
  const config = normalize({ botQQ: BOT, ownerQQ: OWNER, imageGen: { enabled: true, ownerOnly: false, profiles: [{ id: 'fixture', protocol: 'openai', baseUrl: 'https://unused.invalid/v1', model: 'fixture', capabilities: { modes: ['text', 'reference', 'edit'], maxInputs: 4 } }] } })
  const message = storage.messages.ingest({ account: BOT, chatId: group.chatId, eventKind: 'message', platformMsgId: '1', authorId: actor, authorName: 'n', platformTime: Date.now(), text: '用我头像画', segments: [] })
  const request = storage.requests.create({ chatId: group.chatId, actorId: actor, sourceMessageIds: [message.id], policyRevision: 0 })
  let build
  const hub = { personaFor: () => ({ personaId: 'cat', revision: 1 }), turnActor: () => ({ actorId: actor, requestId: request.id }), turnSendersAllOwner: () => owner, turnImages: () => [], turnPersona: () => ({ personaId: 'cat', revision: 1 }), turnRequests: () => [request] }
  const api = imagegen.setup({ core: { storage, hub, onebot, fetchAvatar: (...args) => state.download(...args), local: { active: () => false }, http: { body: async r => r } }, config: () => config, lazy: () => ({}), log: { info() {}, warn() {}, debug() {} }, every() {}, tool: fn => { build = fn }, onDispose() {}, route() {} })
  api.runner.kick = () => {}
  t.after(async () => { await api.runner.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) })
  return { state, storage, api, tool: build({ chat: group, sessionId: 's' }).find(x => x.name === 'qq_draw_image') }
}
const refsOf = (f, id) => f.api.runner.get(id).input.refs

test('「用我头像画」：群友自己的头像成 identity 参考，走现有任务', async t => {
  const f = draw(t), r = await f.tool.execute({ prompt: '一只猫', use_avatar: true })
  assert.equal(r.ok, true, r.message)
  const [ref] = refsOf(f, r.job_id)
  assert.equal(ref.role, 'identity')
  assert.equal(ref.avatar.qq, MEMBER)
  assert.equal(f.api.runner.get(r.job_id).input.mode, 'reference')
})

test('头像生图的模拟调用验证参考，但不创建后台任务', async t => {
  const f = draw(t)
  const result = await f.tool.execute({ prompt: '一只猫', use_avatar: true }, { simulated: true })
  assert.equal(result.ok, true, result.message)
  assert.equal(result.simulated, true)
  assert.equal(f.api.runner.list({ chatId: group.chatId }).length, 0)
  assert.equal((await f.tool.execute({ prompt: '', use_avatar: true }, { simulated: true })).ok, false)
})

test('群友用别人头像：拒绝且不建任务；非本群成员、下载失败也不画', async t => {
  const f = draw(t)
  assert.equal((await f.tool.execute({ prompt: '猫', avatar: { qq: OWNER } })).ok, false)
  assert.equal(f.api.runner.list({ chatId: group.chatId }).length, 0)
  const boss = draw(t, { actor: OWNER, owner: true })
  assert.equal((await boss.tool.execute({ prompt: '猫', avatar: { qq: OTHER } })).ok, false)
  boss.state.download = async () => { throw new Error('超时') }
  const down = await boss.tool.execute({ prompt: '猫', use_avatar: true })
  assert.match(down.message, /拿不到头像/)
  assert.equal(boss.api.runner.list({ chatId: group.chatId }).length, 0)
})

test('主人指定本群成员：验证后加入参考', async t => {
  const f = draw(t, { actor: OWNER, owner: true }), r = await f.tool.execute({ prompt: '猫', avatar: { qq: MEMBER, role: 'style' } })
  assert.equal(r.ok, true, r.message)
  assert.deepEqual(refsOf(f, r.job_id).map(x => [x.role, x.avatar.qq]), [['style', MEMBER]])
})

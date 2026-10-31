import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorage } from '../src/storage/index.js'
import moduleDefinition from '../src/modules/stickers/index.js'

test('chat兼容模式：管理路由保留聊天隔离、上传目标及逐项版本检查', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-stickers-panel-'))
  const storage = createStorage({ file: join(root, 'main.db'), filesDir: join(root, 'assets') })
  const routes = new Map(), disposers = []
  let buildTools, owner = false
  const cfg = { botQQ: '100', ownerQQ: '200', dryRun: true, stickers: { enabled: true, collect: true, caption: false, libraryScope: 'chat', autoReview: false } }
  const api = {
    config: () => cfg, log: { warn() {} },
    core: { storage, stickerLegacyDir: join(root, 'legacy'), onebot: { call: async () => assert.fail('试运行不调用 QQ') },
      hub: { turnHasOwner: () => owner, turnSendersAllOwner: () => owner, recentMedia: () => [], sendSticker: async () => false },
      http: { body: async (req) => req.body || {}, query: (req) => req.query || {}, send: (res, status, data, mime) => Object.assign(res, { status, data, mime }) } },
    route: (name, fn) => routes.set(name, fn), tool: (fn) => { buildTools = fn }, rule() {}, onDispose: (fn) => disposers.push(fn),
  }
  const store = moduleDefinition.setup(api)
  t.after(async () => { for (const dispose of disposers) await dispose(); storage.close(); rmSync(root, { recursive: true, force: true }) })
  const post = (route, body) => routes.get(route)({ body })
  const query = (route, query) => routes.get(route)({ query })
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHn8AAAAASUVORK5CYII='
  assert.equal((await post('/sticker/upload', { data })).ok, false, '上传必须分配聊天')
  const uploaded = await post('/sticker/upload', { data, chatId: 'group:1', name: '测试猫', tags: ['开心'], toQQ: false })
  assert.equal(uploaded.item.state, 'pending')
  const id = uploaded.item.id
  assert.equal((await query('/stickers', { status: 'pending', chatId: 'group:1' })).total, 1)
  assert.equal((await query('/stickers', { status: 'approved' })).total, 0)
  assert.equal((await post('/sticker/edit', { id, patch: { name: '人工猫', ocr: '你好' } })).item.ocr, '你好')
  assert.equal((await post('/sticker/approve', { id })).item.state, 'approved')
  const tools = buildTools({ chat: { kind: 'group', chatId: 'group:1' }, level: 'full', sessionId: 'session' })
  assert.equal((await tools.find((tool) => tool.name === 'qq_list_stickers').execute({})).count, 1)
  const edit = tools.find((tool) => tool.name === 'qq_edit_sticker')
  assert.equal((await edit.execute({ sticker: '人工猫', new_name: '攻击者名字' })).ok, false)
  owner = true
  assert.equal((await edit.execute({ sticker: '人工猫', new_name: '主人改名' })).ok, true)
  assert.equal(store.match('主人改名', 'group:1').id, id)
  assert.equal((await post('/sticker/disable', { id })).item.state, 'disabled')
  assert.equal((await query('/stickers/stats', {})).disabled, 1)
  assert.equal((await post('/sticker/delete', { id })).tombstone, true)
  assert.equal((await query('/stickers', {})).total, 0)
  assert.equal((await query('/stickers', { status: 'deleted' })).total, 1)
  assert.equal((await query('/stickers/queue', { kind: 'sync' })).ok, true)
  assert.equal((await post('/stickers/batch', { action: 'approve', entries: [{ id, expectedRevision: 1 }] })).ok, false)
  const second = await post('/sticker/upload', { data, chatId: 'group:2', toQQ: false })
  const entries = [{ id: second.item.id, expectedRevision: second.item.revision }]
  const scoped = await post('/stickers/batch', { chatId: 'group:1', action: 'approve', entries, admin: false, accountId: 'other' })
  assert.equal(scoped.succeeded, 0, '面板认证由宿主提供；不能越过明确选择的聊天范围')
  assert.equal((await post('/stickers/batch', { chatId: 'group:2', action: 'approve', entries })).succeeded, 1)
  assert.equal((await query('/stickers/queue', { chatId: 'group:2' })).runtime.enabled, true)
  assert.equal((await post('/sticker/analysis/reconcile', { chatId: 'group:2', taskId: 'missing' })).ok, false)
  assert.equal((await post('/sticker/sync/bind', { chatId: 'group:2', id: second.item.id, emojiId: 'id', confirmedExisting: true })).code, 'NOT_BINDABLE')
})

test('model candidates omit manual-only stickers; only an explicit outer request can send one', async t => {
  const root = mkdtempSync(join(tmpdir(), 'sticker-manual-')), storage = createStorage({ file: join(root, 'db'), filesDir: join(root, 'assets') })
  const cfg = { botQQ: '100', ownerQQ: '200', stickers: { enabled: true, collect: true, caption: false, libraryScope: 'chat' } }
  let build, currentRequest, sends = 0; const disposers = []
  const api = { config: () => cfg, log: { warn() {} }, core: { storage, onebot: {}, stickerLegacyDir: join(root, 'legacy'), http: {}, hub: {
    turnSendersAllOwner: () => true, turnActor: () => ({ actorId: '200', requestId: currentRequest.id }), sendSticker: async () => { sends++; return true } } },
    route() {}, rule() {}, tool: f => { build = f }, onDispose: f => disposers.push(f) }
  const store = moduleDefinition.setup(api)
  t.after(async () => { for (const dispose of disposers) await dispose(); storage.close(); rmSync(root, { recursive: true, force: true }) })
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHn8AAAAASUVORK5CYII=', 'base64')
  const { item } = await store.addFromBuffer(png, { chatId: 'group:1', name: '小猫', toQQ: false })
  store.approve(item.id, { admin: true }); store.edit(item.id, { manualOnly: true }, { admin: true })
  const request = (text, segments) => {
    const m = storage.messages.ingest({ account: '100', chatId: 'group:1', authorId: '200', text, segments })
    return storage.requests.create({ chatId: 'group:1', actorId: '200', sourceMessageIds: [m.id] })
  }
  currentRequest = request('发小猫', [{ type: 'forward', data: { text: '发小猫' } }])
  const tools = build({ chat: { kind: 'group', chatId: 'group:1' }, level: 'full', sessionId: 'session' })
  assert.equal((await tools.find(x => x.name === 'qq_list_stickers').execute({})).count, 0)
  assert.equal((await tools.find(x => x.name === 'qq_send_sticker').execute({ name: '小猫' })).ok, false)
  currentRequest = request('请发小猫', [{ type: 'text', data: { text: '请发小猫' } }])
  assert.equal((await tools.find(x => x.name === 'qq_send_sticker').execute({ name: '小猫' })).ok, true)
  assert.equal(sends, 1)
})

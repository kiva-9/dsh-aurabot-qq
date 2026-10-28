import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorage } from '../src/storage/index.js'
import moduleDefinition from '../src/modules/stickers/index.js'

test('管理路由完成上传、待审过滤、编辑、批准、停用、删除；聊天工具不能全局管理', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-stickers-panel-'))
  const storage = createStorage({ file: join(root, 'main.db'), filesDir: join(root, 'assets') })
  const routes = new Map(), disposers = []
  let buildTools, owner = false
  const cfg = { botQQ: '100', ownerQQ: '200', dryRun: true, stickers: { enabled: true, collect: true, caption: false } }
  const api = {
    config: () => cfg, log: { warn() {} },
    core: { storage, stickerLegacyDir: join(root, 'legacy'), onebot: { call: async () => assert.fail('试运行不调用 QQ') },
      hub: { turnHasOwner: () => owner, recentMedia: () => [], sendSticker: async () => false },
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
})

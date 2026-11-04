// 生图面板边界：功能开关、聊天白名单、主人权限、任务/资产归属。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import imagegen from '../src/modules/imagegen/index.js'
import { createStorage } from '../src/storage/index.js'
import { normalize } from '../src/core/config.js'
import { PNG } from './helpers/images.js'

function setup(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-imagegen-scope-'))
  const storage = createStorage({ file: ':memory:', filesDir: join(dir, 'assets') })
  const config = normalize({
    botQQ: '20', ownerQQ: '10',
    allow: { groups: ['42', '43'], private: [] },
    imageGen: { enabled: true, profiles: [{
      id: 'fixture', protocol: 'openai', baseUrl: 'https://unused.invalid/v1', model: 'fixture',
      capabilities: { modes: ['text', 'reference', 'edit'], maxInputs: 4 },
    }] },
    ...overrides,
  })
  const routes = new Map()
  const api = imagegen.setup({
    core: {
      storage,
      hub: { personaFor: () => ({ personaId: 'cat', revision: 1, bindingRevision: 1, layers: {} }) },
      local: { active: () => false },
      http: {
        query: req => req.query || {},
        body: async req => req.body ?? req,
        send: (res, status, data, mime) => { res.sent = { status, data, mime } },
      },
    },
    config: () => config, lazy: id => ({ search: {}, retrieval: {} }[id] || {}),
    log: { info() {}, warn() {}, debug() {} }, every() {}, tool() {}, onDispose() {}, route: (path, fn) => routes.set(path, fn),
  })
  api.runner.kick = () => {}
  t.after(async () => { await api.runner.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) })
  return { storage, config, api, routes }
}

const submit = (s, body) => s.routes.get('/imagegen/submit')({ body })

test('关闭生图功能时面板提交被拒绝，不登记任务', async t => {
  const s = setup(t, { imageGen: { enabled: false, profiles: [{
    id: 'fixture', protocol: 'openai', baseUrl: 'https://unused.invalid/v1', model: 'fixture',
  }] } })
  const r = await submit(s, { chatId: 'private:10', prompt: '猫' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'FEATURE_DISABLED')
  assert.equal(s.api.runner.list().length, 0)
})

test('非白名单聊天不能从面板提交生图', async t => {
  const s = setup(t)
  const r = await submit(s, { chatId: 'group:99', prompt: '猫' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'SCOPE_REQUIRED')
  assert.equal(s.api.runner.list().length, 0)
  const privateStranger = await submit(s, { chatId: 'private:99', prompt: '猫' })
  assert.equal(privateStranger.ok, false)
})

test('面板任务和资产按聊天归属校验，跨聊天 asset id 读不到', async t => {
  const s = setup(t)
  const created = await submit(s, { chatId: 'group:42', prompt: '猫' })
  assert.equal(created.ok, true, created.message)
  const asset = s.storage.assets.put(PNG, { mime: 'image/png', sourceKind: 'generated' })
  s.storage.db.run("UPDATE jobs SET state='delivered', output_json=? WHERE id=?", JSON.stringify({ assetIds: [asset.id] }), created.job.id)

  const wrongChat = {}
  const denied = await s.routes.get('/imagegen/asset')({ query: { id: asset.id, chatId: 'group:43' } }, wrongChat)
  assert.equal(denied.ok, false)
  assert.equal(wrongChat.sent, undefined)

  const rightChat = {}
  const allowed = await s.routes.get('/imagegen/asset')({ query: { id: asset.id, chatId: 'group:42' } }, rightChat)
  assert.notEqual(allowed?.ok, false)
  assert.equal(rightChat.sent?.status, 200)
  assert.deepEqual(rightChat.sent.data, PNG)
})

test('任务列表默认只返回当前主人私聊，按聊天查询也只返回该聊天', async t => {
  const s = setup(t)
  const group = await submit(s, { chatId: 'group:42', prompt: '群里的猫' })
  assert.equal(group.ok, true, group.message)
  const ownerPrivate = await submit(s, { chatId: 'private:10', prompt: '私聊的猫' })
  assert.equal(ownerPrivate.ok, true, ownerPrivate.message)

  const fallback = await s.routes.get('/imagegen/jobs')({ query: {} })
  assert.equal(fallback.ok, true)
  assert.deepEqual(fallback.list.map(j => j.id), [ownerPrivate.job.id])
  const scoped = await s.routes.get('/imagegen/jobs')({ query: { chatId: 'group:42' } })
  assert.equal(scoped.ok, true)
  assert.deepEqual(scoped.list.map(j => j.id), [group.job.id])
  const missing = await s.routes.get('/imagegen/jobs')({ query: { chatId: 'group:99' } })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'SCOPE_REQUIRED')
})

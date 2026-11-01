import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import imagegen from '../src/modules/imagegen/index.js'
import { normalize, mergeFromPanel } from '../src/core/config.js'
import { createStorage } from '../src/storage/index.js'
import { PROTOCOLS } from '../src/providers/image/index.js'

const existing = {
  id: 'grsai', name: 'Existing', protocol: 'openai', baseUrl: 'https://example.invalid/v1', apiKey: 'secret-example', model: 'existing-model',
  capabilities: { modes: ['text', 'reference'], maxInputs: 1 },
}
const studio = {
  id: 'studio-test', name: 'Local', protocol: 'studio', baseUrl: 'http://127.0.0.1:7860', model: 'anime.safetensors',
  capabilities: { modes: ['text', 'reference', 'edit', 'mask'], maxInputs: 3 }, extra: { denoise: 0.6, weight: 0.5 },
}

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-studio-integration-'))
  const storage = createStorage({ file: ':memory:', filesDir: join(dir, 'assets') })
  const config = normalize({ botQQ: '20', ownerQQ: '10', imageGen: { enabled: true, defaultProfile: 'grsai', profiles: [existing, studio] } })
  const routes = new Map()
  const api = imagegen.setup({
    core: { storage, hub: { personaFor: () => ({ personaId: 'cat', revision: 1 }) }, local: { active: () => false }, http: { body: async r => r } },
    config: () => config, lazy: () => ({}), log: { info() {} }, every() {}, tool() {}, onDispose() {}, route: (path, fn) => routes.set(path, fn),
  })
  t.after(async () => { await api.runner.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) })
  return { config, routes, api }
}

test('新增 Studio 配置保留默认服务和协议字段，不会把显式选择切换到已有服务', t => {
  const original = normalize({ imageGen: { defaultProfile: 'grsai', profiles: [existing] } })
  const next = mergeFromPanel(original, { imageGen: { profiles: [...original.imageGen.profiles, studio] } })
  assert.equal(next.imageGen.defaultProfile, 'grsai')
  assert.deepEqual(next.imageGen.profiles[0], original.imageGen.profiles[0])
  assert.equal(next.imageGen.profiles[1].protocol, 'studio')
  assert.deepEqual(next.imageGen.profiles[1].extra, { denoise: 0.6, weight: 0.5 })
  assert.ok(PROTOCOLS().includes('studio'))
  assert.ok(imagegen.files.includes('providers/image/studio.js'))
  assert.ok(imagegen.files.includes('providers/image/studio-mask.js'))
  for (const extra of [{ denoise: 0 }, { denoise: '0.6' }, { weight: 1.51 }, { weight: -0.1 }]) {
    assert.throws(() => mergeFromPanel(original, { imageGen: { profiles: [{ ...studio, extra }] } }), /denoise|weight/)
  }
  const s = setup(t)
  const req = { mode: 'text', prompt: 'cat', size: '1024x1024', inputs: [] }
  assert.equal(s.api.service.pickProfile(req).profile.id, 'grsai')
  assert.equal(s.api.service.pickProfile(req, 'studio-test').profile.id, 'studio-test')
  s.config.imageGen.profiles[1].capabilities.modes = ['text']
  const restricted = s.api.service.pickProfile({ ...req, mode: 'reference', inputs: [{ role: 'identity' }] }, 'studio-test')
  assert.ok(restricted.error)
  assert.equal(restricted.profile, undefined)
})

test('Studio 检查只读状态，展示模型并核对声明，不请求生成或取消', async t => {
  const s = setup(t)
  const calls = []
  let status = { ready: true, queue: 2, models: [
    { id: 'anime.safetensors', name: 'Anime', features: ['txt2img', 'img2img', 'edit', 'reference'], prompt_hint: '用英文标签' },
    { id: 'other-model', name: 'Other', features: ['txt2img', 'img2img', 'edit'], prompt_hint: '用自然语句' },
  ] }
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' })
    return new Response(JSON.stringify(status), { headers: { 'content-type': 'application/json' } })
  })
  const check = () => s.routes.get('/imagegen/test')({ id: 'studio-test' })
  const first = await check()
  assert.equal(first.ok, true, first.message)
  assert.match(first.message, /本配置启用/)
  assert.match(first.message, /输入上限 3 张/)
  assert.deepEqual(first.studio.selected.modes, ['text', 'edit', 'mask', 'reference'])
  assert.deepEqual(first.studio.models.map(m => m.id), ['anime.safetensors', 'other-model'])
  assert.equal(first.studio.selected.prompt_hint, '用英文标签')
  assert.equal(first.studio.queue, 2)
  assert.equal(JSON.stringify(first).includes('secret-example'), false)
  s.config.imageGen.profiles[1].model = 'other-model'
  const unsupported = await check()
  assert.equal(unsupported.ok, false)
  assert.match(unsupported.message, /参考图/)
  s.config.imageGen.profiles[1].model = 'missing'
  const missing = await check()
  assert.equal(missing.ok, false)
  assert.match(missing.message, /找不到/)
  assert.equal(missing.studio.models.length, 2)
  s.config.imageGen.profiles[1].model = ''
  assert.match((await check()).message, /填写完整模型 ID/)
  status = { ready: false, models: [] }
  assert.match((await check()).message, /尚未就绪/)
  assert.ok(calls.length >= 5)
  assert.ok(calls.every(call => call.url === 'http://127.0.0.1:7860/api/status' && call.method === 'GET'))
  assert.equal(s.api.runner.list().length, 0)
})

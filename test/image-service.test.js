import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorage } from '../src/storage/index.js'
import { createImageService } from '../src/jobs/image.js'
import { createJobRunner } from '../src/jobs/runner.js'
import { normalize, mergeFromPanel } from '../src/core/config.js'

const image = readFileSync(new URL('../assets/dafeiyu.jpg', import.meta.url))
function setup(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-image-service-'))
  const storage = createStorage({ file: ':memory:', filesDir: join(dir, 'assets') })
  const cfg = normalize({ enabled: true, dryRun: false, botQQ: '20', ownerQQ: '10', imageGen: {
    enabled: true, stylePrompt: 'old style', profiles: [{ id: 'p', name: 'fixture', protocol: 'openai', baseUrl: 'https://image.example/v1', apiKey: 'private-key', model: 'fixture', capabilities: { modes: ['text', 'reference', 'edit', 'mask'], maxInputs: 4 } }],
  }, ...extra })
  const calls = []; const sends = []
  const hub = { sendImageAssets: async (chatId, ids, note, options) => { sends.push({ chatId, ids, options }); return { delivered: ids.length, batchId: options.batchId } }, noteToSession() {}, sendText: async () => {} }
  const service = createImageService({ storage, getConfig: () => cfg, hub, adapterDeps: { fetchImpl: async (url, options) => {
    calls.push({ url, options }); return new Response(JSON.stringify({ data: [{ b64_json: image.toString('base64') }] }), { headers: { 'content-type': 'application/json' } })
  } } })
  const runner = createJobRunner({ storage, handlers: { image: service.handler }, retryBaseMs: 0, pollMs: 0 })
  t.after(async () => { await runner.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) })
  const enqueue = (input = {}) => service.enqueue(runner, { kind: 'image', chatId: 'private:10', actorId: '10', input: { prompt: 'cat', mode: 'text', refs: [], ...input } })
  return { cfg, calls, sends, service, runner, storage, enqueue }
}

test('任务登记时冻结服务、风格和尺寸，删除配置后仍使用原配置；密钥不进入任务展示', async (t) => {
  const s = setup(t)
  const j = s.enqueue()
  s.cfg.imageGen.profiles = []; s.cfg.imageGen.stylePrompt = 'new style'; s.cfg.imageGen.size = '512x512'
  await s.runner.drain()
  assert.equal(s.runner.get(j.id).state, 'delivered', s.runner.get(j.id).error)
  assert.equal(s.calls[0].url, 'https://image.example/v1/images/generations')
  const body = JSON.parse(s.calls[0].options.body)
  assert.equal(body.prompt, 'old style，cat'); assert.equal(body.size, '1024x1024')
  assert.ok(!JSON.stringify(s.runner.get(j.id)).includes('private-key'))
  assert.equal(s.sends[0].options.batchId, `image:${j.id}`)
})

test('试运行保留生成结果且不能记已送达，补发只发送资产不再生成', async (t) => {
  const s = setup(t, { dryRun: true }); const j = s.enqueue()
  await s.runner.drain()
  assert.equal(s.runner.get(j.id).state, 'delivery_pending', s.runner.get(j.id).error); assert.equal(s.calls.length, 1); assert.equal(s.sends.length, 0)
  s.cfg.dryRun = false
  assert.equal(s.runner.resend(j.id).ok, true)
  await s.runner.drain()
  assert.equal(s.runner.get(j.id).state, 'delivered'); assert.equal(s.calls.length, 1); assert.equal(s.sends.length, 1)
})

test('缺失输入图、空提示词和多个底图不能悄悄变成文生图', (t) => {
  const s = setup(t)
  assert.throws(() => s.enqueue({ prompt: ' ' }), /描述/)
  assert.throws(() => s.enqueue({ mode: 'edit', refs: [{ assetId: 'missing', role: 'base' }] }), /找不到/)
  const a = s.storage.assets.put(image, { mime: 'image/jpeg' })
  assert.throws(() => s.enqueue({ mode: 'edit', refs: [{ assetId: a.id, role: 'base' }, { assetId: a.id, role: 'base' }] }), /一张底图/)
  assert.equal(s.runner.list().length, 0); assert.equal(s.calls.length, 0)
})

test('参考图scope和账号变化在收费请求前拒绝', async (t) => {
  const s = setup(t)
  const a = s.storage.assets.put(image, { mime: 'image/jpeg' })
  const id = s.storage.occurrences.add({ messageId: null, chatId: 'private:99', authorId: '99', segIndex: 0, kind: 'image', scope: { account: '20', chat: 'private:99', category: 'image' } })
  s.storage.occurrences.ready(id, a.id)
  const j = s.enqueue({ mode: 'edit', refs: [{ assetId: a.id, occurrenceId: id, role: 'base' }] })
  await s.runner.drain()
  assert.equal(s.runner.get(j.id).state, 'failed'); assert.equal(s.calls.length, 0)
  const next = s.enqueue(); s.cfg.botQQ = '21'
  await s.runner.drain()
  assert.equal(s.runner.get(next.id).state, 'failed'); assert.equal(s.calls.length, 0)
})

test('面板配置拒绝非法JSON和重复服务ID，清空映射可以保存', () => {
  const cfg = normalize({})
  const profile = { id: 'p', protocol: 'http', extra: { submit: '{invalid' } }
  assert.throws(() => mergeFromPanel(cfg, { imageGen: { profiles: [profile] } }), /JSON/)
  profile.extra.submit = null
  assert.equal(mergeFromPanel(cfg, { imageGen: { profiles: [profile] } }).imageGen.profiles[0].extra.submit, null)
  assert.throws(() => mergeFromPanel(cfg, { imageGen: { profiles: [profile, profile] } }), /重复/)
})

test('图片显式共享可用，撤回或撤销共享在提交前阻止收费', async t => {
  const s=setup(t,{memory:{shareGroups:[{id:'shared',chats:['private:10','group:77'],categories:['image']}]}})
  const m=s.storage.messages.ingest({account:'20',chatId:'group:77',authorId:'10',platformMsgId:'shared-image',text:'我自己的图'})
  const a=s.storage.assets.put(image,{mime:'image/jpeg'})
  const id=s.storage.occurrences.add({messageId:m.id,chatId:'group:77',authorId:'10',segIndex:0,kind:'image',scope:{account:'20',chat:'group:77',category:'image'}})
  s.storage.occurrences.ready(id,a.id)
  const refs=[{assetId:a.id,occurrenceId:id,role:'identity'}]
  const first=s.enqueue({mode:'reference',refs});await s.runner.drain()
  assert.equal(s.runner.get(first.id).state,'delivered');assert.equal(s.calls.length,1)
  const second=s.enqueue({mode:'reference',refs});s.cfg.memory.shareGroups=[];await s.runner.drain()
  assert.equal(s.runner.get(second.id).state,'failed');assert.equal(s.calls.length,1)
  s.cfg.memory.shareGroups=[{id:'shared',chats:['private:10','group:77'],categories:['image']}]
  const third=s.enqueue({mode:'reference',refs});s.storage.messages.markRecalled('group:77','shared-image');await s.runner.drain()
  assert.equal(s.runner.get(third.id).state,'failed');assert.equal(s.calls.length,1)
})

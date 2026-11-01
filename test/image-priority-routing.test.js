import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorage } from '../src/storage/index.js'
import { createImageService } from '../src/jobs/image.js'
import { createJobRunner } from '../src/jobs/runner.js'
import { normalize, mergeFromPanel, publicConfig } from '../src/core/config.js'
import { PNG } from './helpers/images.js'

const profile = (id, modes, maxInputs = 4) => ({
  id, name: id, protocol: 'openai', baseUrl: `https://${id}.example/v1`, apiKey: `${id}-secret`, model: id,
  capabilities: { modes, maxInputs }, extra: {},
})
const profiles = () => [
  profile('fallback', ['text', 'reference', 'edit', 'mask']),
  profile('grsai', ['text', 'reference'], 1),
  profile('magpie', ['text', 'reference', 'edit'], 5),
]
const routing = { text: 'local', singleReference: 'grsai', multiReference: 'magpie' }

function setup(t, { fail = false, localActive = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-image-priority-'))
  const storage = createStorage({ file: ':memory:', filesDir: join(dir, 'assets') })
  const cfg = normalize({ enabled: true, dryRun: false, botQQ: '20', ownerQQ: '10', local: { image: true }, imageGen: {
    enabled: true, stylePrompt: 'original style', profiles: profiles(), defaultProfile: 'fallback', routing,
  } })
  const calls = []
  const local = {
    active: (slot) => slot === 'image' && cfg.local.image && localActive,
    call: async (slot, args) => { calls.push({ local: slot, args }); return PNG },
  }
  const asset = storage.assets.put(PNG, { mime: 'image/png' })
  const hub = {
    sendImageAssets: async (chatId, ids) => ({ delivered: ids.length }),
    noteToSession() {}, sendText: async () => {},
  }
  const service = createImageService({
    storage, getConfig: () => cfg, hub, local, toImageBuffer: async x => x, defaultReference: () => asset,
    adapterDeps: { fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return fail
        ? new Response(JSON.stringify({ error: 'rejected' }), { status: fail === true ? 401 : fail, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }), { headers: { 'content-type': 'application/json' } })
    } },
  })
  const runner = createJobRunner({ storage, handlers: { image: service.handler }, retryBaseMs: 0, pollMs: 0 })
  t.after(async () => { await runner.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) })
  const enqueue = (input = {}) => service.enqueue(runner, { kind: 'image', chatId: 'private:10', actorId: '10', input: { prompt: 'cat', mode: 'text', refs: [], ...input } })
  const ref = (role = 'identity') => ({ assetId: asset.id, role })
  return { cfg, calls, storage, hub, service, runner, enqueue, ref, asset }
}

test('routes by zero, one, and multiple actual references before enqueue', t => {
  const s = setup(t)
  const text = s.enqueue()
  const single = s.enqueue({ mode: 'reference', refs: [s.ref()] })
  const multi = s.enqueue({ mode: 'reference', refs: [s.ref(), s.ref('style')] })
  assert.equal(text.profileId, 'local')
  assert.equal(single.profileId, 'grsai')
  assert.equal(multi.profileId, 'magpie')
  assert.deepEqual([text.input.refs.length, single.input.refs.length, multi.input.refs.length], [0, 1, 2])
  assert.equal(s.calls.length, 0)
})

test('selfie routing counts the persona reference after insertion', t => {
  const s = setup(t)
  s.hub.personaFor = () => ({ personaId: 'dafeiyu', revision: 1, bindingRevision: 1, layers: {} })
  const single = s.enqueue({ drawSelf: true })
  assert.equal(single.input.mode, 'reference')
  assert.equal(single.input.refs.length, 1)
  assert.equal(single.input.refs[0].personaReference, true)
  assert.equal(single.profileId, 'grsai')
  const multi = s.enqueue({ drawSelf: true, mode: 'reference', refs: [s.ref('style')] })
  assert.equal(multi.input.refs.length, 2)
  assert.equal(multi.input.refs[1].personaReference, true)
  assert.equal(multi.profileId, 'magpie')
})

test('explicit service overrides routing and unsupported explicit choices fail', t => {
  const s = setup(t)
  assert.equal(s.enqueue({ mode: 'reference', refs: [s.ref()], profileId: 'magpie' }).profileId, 'magpie')
  assert.throws(() => s.enqueue({ mode: 'reference', refs: [s.ref()], profileId: 'local' }), /不支持/)
  assert.throws(() => s.enqueue({ profileId: 'missing' }), /没有叫 missing/)
  assert.equal(s.runner.list().length, 1)
})

test('invalid input counts do not change mode or drop images to satisfy a preference', t => {
  const s = setup(t)
  assert.throws(() => s.enqueue({ mode: 'text', refs: [s.ref()] }), /没有生图服务能做/)
  assert.throws(() => s.enqueue({ mode: 'reference', refs: [] }), /没有生图服务能做/)
  assert.equal(s.runner.list().length, 0)
  assert.equal(s.calls.length, 0)
})

test('incompatible preferences fall back through the original order without changing the request', t => {
  const s = setup(t)
  const base = s.ref('base')
  const edit = s.enqueue({ mode: 'edit', refs: [base] }) // grsai only declares reference, not edit
  assert.equal(edit.profileId, 'fallback')
  assert.equal(edit.input.mode, 'edit')
  assert.deepEqual(edit.input.refs, [base])

  const magpie = s.cfg.imageGen.profiles.find(p => p.id === 'magpie')
  magpie.capabilities.maxInputs = 1
  const refs = [s.ref(), s.ref('style')]
  const maxInputs = s.enqueue({ mode: 'reference', refs })
  assert.equal(maxInputs.profileId, 'fallback')
  assert.deepEqual(maxInputs.input.refs, refs)

  magpie.capabilities.maxInputs = 5
  magpie.extra.imageField = 'image' // adapter only supports one input with this field
  assert.equal(s.enqueue({ mode: 'reference', refs }).profileId, 'fallback')
  delete magpie.extra.imageField
  magpie.capabilities.sizes = ['1024x1024']
  const shape = s.enqueue({ mode: 'reference', refs, shape: 'portrait' })
  assert.equal(shape.profileId, 'fallback')
  assert.equal(shape.input.size, '768x1024')

  s.cfg.local.image = false
  s.cfg.imageGen.profiles = [s.cfg.imageGen.profiles.find(p => p.id === 'grsai')]
  assert.throws(() => s.enqueue({ mode: 'reference', refs }), /没有生图服务能做/)
  assert.equal(s.calls.length, 0)
})

test('empty or deleted preferences preserve the previous local/default selection order', t => {
  const s = setup(t)
  s.cfg.imageGen.routing = normalize({ imageGen: { profiles: profiles() } }).imageGen.routing
  assert.deepEqual(s.cfg.imageGen.routing, { text: '', singleReference: '', multiReference: '' })
  assert.equal(s.enqueue().profileId, 'local')
  assert.equal(s.enqueue({ mode: 'reference', refs: [s.ref()] }).profileId, 'fallback')
  s.cfg.local.image = false
  assert.equal(s.enqueue().profileId, 'fallback')
  s.cfg.imageGen.routing.singleReference = 'grsai'
  s.cfg.imageGen.profiles = s.cfg.imageGen.profiles.filter(p => p.id !== 'grsai')
  assert.equal(s.enqueue({ mode: 'reference', refs: [s.ref()] }).profileId, 'fallback')
})

test('a configured but inactive local interface falls back to the default', t => {
  const s = setup(t, { localActive: false })
  assert.equal(s.cfg.imageGen.routing.text, 'local')
  assert.equal(s.enqueue().profileId, 'fallback')
})

test('configuration normalizes stale and malformed routing while panel saves validate values and preserve other fields', () => {
  const cfg = normalize({ local: { image: true }, imageGen: {
    profiles: profiles(), defaultProfile: 'fallback', routing, stylePrompt: 'style', quota: { perUserPerDay: 42 },
  } })
  cfg.imageGen.profiles[1].extra.headers = { 'x-secret': 'header-secret' }
  const visible = publicConfig(cfg)
  const saved = mergeFromPanel(cfg, { imageGen: { profiles: visible.imageGen.profiles, routing: { multiReference: 'fallback' } } })
  assert.deepEqual(saved.imageGen.routing, { ...routing, multiReference: 'fallback' })
  assert.equal(saved.imageGen.profiles[1].apiKey, 'grsai-secret')
  assert.equal(saved.imageGen.profiles[1].extra.headers['x-secret'], 'header-secret')
  assert.deepEqual(saved.imageGen.profiles[1].capabilities, cfg.imageGen.profiles[1].capabilities)
  assert.equal(saved.imageGen.stylePrompt, 'style')
  assert.equal(saved.imageGen.quota.perUserPerDay, 42)

  const deleted = mergeFromPanel(cfg, { imageGen: { profiles: visible.imageGen.profiles.filter(p => p.id !== 'grsai') } })
  assert.deepEqual(deleted.imageGen.routing, { ...routing, singleReference: '' })
  assert.equal(mergeFromPanel(cfg, { imageGen: { routing: { singleReference: 'deleted' } } }).imageGen.routing.singleReference, '')
  assert.equal(normalize({ imageGen: { routing: { text: 'local' } } }).imageGen.routing.text, '')
  assert.equal(normalize({ local: { image: true }, imageGen: { routing: { text: 'local' } } }).imageGen.routing.text, 'local')
  assert.equal(normalize({ imageGen: { profiles: [profile('local', ['text'])], routing: { text: 'local' } } }).imageGen.routing.text, 'local')
  assert.deepEqual(normalize({ imageGen: { profiles: profiles(), routing: { text: 5, singleReference: ' grsai', multiReference: 'x'.repeat(41) } } }).imageGen.routing,
    { text: '', singleReference: '', multiReference: '' })
  const polluted = JSON.parse('{"__proto__":{"text":"grsai"}}')
  assert.deepEqual(normalize({ imageGen: { profiles: profiles(), routing: polluted } }).imageGen.routing,
    { text: '', singleReference: '', multiReference: '' })
  for (const invalid of [null, [], 'grsai', { text: 5 }, { text: null }, { text: ' grsai' }, { text: 'x'.repeat(41) }, { other: 'grsai' }, polluted]) {
    assert.throws(() => mergeFromPanel(cfg, { imageGen: { routing: invalid } }), /生图服务优先选择/)
  }
})

test('queued provider and credentials stay frozen after routing and profile changes', async t => {
  const s = setup(t)
  const job = s.enqueue({ mode: 'reference', refs: [s.ref()] })
  s.cfg.imageGen.routing.singleReference = 'magpie'
  s.cfg.imageGen.profiles = s.cfg.imageGen.profiles.filter(p => p.id !== 'grsai')
  await s.runner.drain()
  assert.equal(s.runner.get(job.id).state, 'delivered', s.runner.get(job.id).error)
  assert.equal(s.calls.length, 1)
  assert.equal(s.calls[0].url, 'https://grsai.example/v1/images/edits')
  assert.equal(s.calls[0].options.headers.authorization, 'Bearer grsai-secret')
  assert.equal(s.runner.get(job.id).profileId, 'grsai')
  assert.ok(!JSON.stringify(s.runner.get(job.id)).includes('grsai-secret'))
})

test('a failing provider submission does not switch to another provider', async t => {
  const s = setup(t, { fail: true })
  const job = s.enqueue({ mode: 'reference', refs: [s.ref()] })
  await s.runner.drain()
  assert.equal(s.runner.get(job.id).state, 'failed')
  assert.equal(s.runner.get(job.id).profileId, 'grsai')
  assert.deepEqual(s.calls.map(call => call.url), ['https://grsai.example/v1/images/edits'])
})

test('automatic retries remain on the same frozen provider', async t => {
  const s = setup(t, { fail: 429 })
  const job = s.enqueue({ mode: 'reference', refs: [s.ref()] })
  await s.runner.drain()
  assert.equal(s.runner.get(job.id).state, 'failed')
  assert.equal(s.runner.get(job.id).attempts, 3)
  assert.deepEqual(s.calls.map(call => call.url), Array(3).fill('https://grsai.example/v1/images/edits'))
})

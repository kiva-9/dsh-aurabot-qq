import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorage } from '../src/storage/index.js'
import { normalize } from '../src/core/config.js'
import purposeModule from '../src/modules/purpose/index.js'
import imageModule from '../src/modules/imagegen/index.js'
import { collectMaterials, planPurpose } from '../src/purpose/decision.js'
import { artworkList, resolveArtwork } from '../src/image/gallery.js'
import { createSpeakUp } from '../src/features/companion.js'

test('purpose materials retain scope and ownership, and goals are tentative and source-bound', () => {
  const now = Date.now(), scope = { account: '20', chat: 'group:1', persona: 'fish' }
  const message = { id: 'a', account: '20', chatId: 'group:1', authorId: '30', text: '考试有点累', receivedAt: now - 1000 }
  const materials = collectMaterials({ scope, now, ownerId: '10', messages: [message,
    { ...message, id: 'other-account', account: '21' }, { ...message, id: 'other-chat', chatId: 'group:2' },
    { ...message, id: 'recalled', recalledAt: now }, { ...message, id: 'old', receivedAt: now - 73 * 3600_000 }],
    facts: [{ id: 'shared', text: '游戏', status: 'active', scope: { ...scope, chat: 'group:2' }, eventTime: now },
      { id: 'valid', text: '喜欢画画', status: 'active', scope, eventTime: now, category: 'experience' }] })
  assert.deepEqual(materials.map(m => m.id).sort(), ['memory:valid', 'message:a'])
  const plan = planPurpose({ materials, now })
  const member = plan.goals.find(g => g.sourceId === 'message:a')
  assert.equal(member.owner, 'member'); assert.equal(member.status, 'hypothesis'); assert.equal(member.need, 'care')
  assert.equal(member.topic, '考试有点累'); assert.ok(plan.drives.care > 0)
  assert.ok(plan.candidates.every(c => c.evidence.id === c.sourceId))
  assert.ok(!planPurpose({ materials, usedSourceIds: materials.map(m => m.id), now }).selected)
})

function purposeFixture() {
  const now = Date.now(), values = new Map(), routes = {}, calls = [], dispose = []
  const cfg = { enabled: true, dryRun: false, botQQ: '20', ownerQQ: '10', allow: { groups: ['1'], private: [] }, modules: {},
    speakUp: { enabled: true, mode: 'purpose', targets: ['group:1'], idleMinutes: 1, minIntervalMinutes: 1, maxPerDay: 4, awakeFrom: 0, awakeTo: 24 } }
  const message = { id: 'm1', account: '20', chatId: 'group:1', authorId: '10', text: '明天要考试', receivedAt: now - 10 * 60_000, recalledAt: null }
  const state = { scope: { account: '20', chat: 'group:1', persona: 'fish' }, count: 0, last: 0, nextAt: 0 }
  const persona = { personaId: 'fish', revision: 1, bindingRevision: 1 }, epoch = { value: 1 }
  const speak = { state: () => state, fire: async (reason, options) => { calls.push({ reason, options }); return { accepted: true } } }
  const storage = { meta: { get: (k, fallback) => values.get(k) || fallback, set: (k, v) => values.set(k, structuredClone(v)) },
    epochs: { current: () => epoch.value }, messages: { recent: () => [message], get: id => id === message.id ? message : null } }
  let memory = null, muted = false, speakAvailable = true
  const api = { config: () => cfg, use: name => name === 'speakup' ? (speakAvailable ? speak : null) : name === 'memory' ? memory : null, core: { storage, hub: { personaFor: () => persona }, mutes: { muted: () => muted }, http: { query: req => req.query || {} } },
    every() {}, route: (path, fn) => { routes[path] = fn }, onDispose: fn => dispose.push(fn), log: { warn() {} } }
  const module = purposeModule.setup(api)
  return { cfg, state, persona, epoch, message, speak, calls, values, routes, dispose, module, setMemory: value => { memory = value },
    setMuted: value => { muted = value }, setSpeakAvailable: value => { speakAvailable = value } }
}

test('manual purpose trigger uses the same decision, scope, quota, idle and lifecycle guards', async () => {
  const f = purposeFixture()
  assert.equal((await f.module.fire('group:2')).code, 'SCOPE_REQUIRED')
  f.setSpeakAvailable(false); assert.equal((await f.module.fire('group:1')).code, 'SPEAKUP_UNAVAILABLE'); f.setSpeakAvailable(true)
  f.cfg.speakUp.mode = 'ordinary'; assert.equal((await f.module.fire('group:1')).code, 'PURPOSE_DISABLED'); f.cfg.speakUp.mode = 'purpose'
  f.setMuted(true); assert.equal((await f.module.fire('group:1')).code, 'PURPOSE_DISABLED'); f.setMuted(false)
  f.cfg.dryRun = true; assert.equal((await f.module.fire('group:1')).code, 'DRY_RUN'); f.cfg.dryRun = false
  f.cfg.speakUp.awakeTo = 0; assert.equal((await f.module.fire('group:1')).code, 'QUIET_HOURS'); f.cfg.speakUp.awakeTo = 24
  const oldReceived = f.message.receivedAt; f.message.receivedAt = Date.now()
  assert.equal((await f.module.fire('group:1')).code, 'CHAT_ACTIVE'); f.message.receivedAt = oldReceived
  f.state.count = 4; assert.equal((await f.module.fire('group:1')).code, 'BUDGET_EXHAUSTED'); f.state.count = 0
  f.state.last = Date.now(); assert.equal((await f.module.fire('group:1')).code, 'COOLDOWN'); f.state.last = 0
  f.state.nextAt = Date.now() + 60000; assert.equal((await f.module.fire('group:1')).code, 'NOT_DUE'); f.state.nextAt = 0
  assert.equal(f.calls.length, 0); assert.equal(f.values.size, 0)
  const result = await f.module.fire('group:1')
  assert.equal(result.accepted, true); assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].options.purpose, true); assert.equal(f.calls[0].options.validatePlan(), true)
  assert.equal(f.calls[0].options.plan.sourceIds[0], 'message:m1')
  assert.equal((await f.module.fire('group:1')).code, 'NO_PURPOSE_MATERIAL')
  f.dispose[0](); assert.equal((await f.module.fire('group:1')).code, 'PURPOSE_DISABLED')
})

test('purpose manual dispatch reports rejection and unknown faithfully and fences concurrent requests', async () => {
  const f = purposeFixture()
  f.speak.fire = async () => ({ ok:false, code:'COOLDOWN', message:'仍在冷却' })
  const rejected = await f.module.fire('group:1')
  assert.equal(rejected.code, 'COOLDOWN'); assert.equal(f.module.inspect('group:1').last.state, 'rejected')
  assert.ok(f.module.inspect('group:1').selected, 'known pre-enqueue rejection releases the source')
  let release
  f.speak.fire = () => new Promise(resolve => { release = resolve })
  const pending = f.module.fire('group:1')
  assert.equal((await f.module.fire('group:1')).code, 'BUSY')
  release({ ok:false, code:'ENQUEUE_UNKNOWN', eventId:'purpose:test', message:'结果不确定' })
  const unknown = await pending
  assert.equal(unknown.code, 'ENQUEUE_UNKNOWN'); assert.equal(unknown.eventId, 'purpose:test')
  assert.equal(f.module.inspect('group:1').last.state, 'unknown')
  assert.equal((await f.module.fire('group:1')).code, 'NO_PURPOSE_MATERIAL')
})

test('purpose preview is read-only; dispatch reserves a source and rechecks recall, scope, epoch and persona', async () => {
  const f = purposeFixture()
  const preview = await f.routes['/purpose/preview']({ query: { target: 'group:1' } })
  assert.equal(preview.ok, true); assert.equal(preview.decision.act, true)
  assert.equal(preview.selected.sourceId, 'message:m1'); assert.equal(f.values.size, 0); assert.equal(f.calls.length, 0)
  assert.equal((await f.routes['/purpose/preview']({ query: { target: 'group:2' } })).ok, false)
  await f.module.tick()
  assert.equal(f.calls.length, 1)
  const { plan, validatePlan } = f.calls[0].options
  assert.deepEqual(plan.materials, [{ id: 'message:m1', text: '明天要考试' }]); assert.equal(validatePlan(), true)
  f.message.recalledAt = Date.now(); assert.equal(validatePlan(), false); f.message.recalledAt = null
  f.epoch.value++; assert.equal(validatePlan(), false); f.epoch.value--
  f.persona.revision++; assert.equal(validatePlan(), false); f.persona.revision--
  f.cfg.allow.groups = []; assert.equal(validatePlan(), false); f.cfg.allow.groups = ['1']
  await f.module.tick(); assert.equal(f.calls.length, 1, 'a reserved source must not be retried')
  f.dispose[0](); assert.equal(validatePlan(), false)
})

test('purpose rechecks memory visibility and never retries an ambiguous dispatch automatically', async () => {
  const f = purposeFixture(), scope = { ...f.state.scope }
  f.message.recalledAt = Date.now()
  const fact = { id:'fact1', text:'喜欢画画', scope, status:'active', category:'experience', eventTime:Date.now() - 600_000, revision:1 }
  let visible = true
  f.setMemory({ list: ({ scope:s }) => s.persona === scope.persona && visible ? [fact] : [], get: () => visible ? fact : null })
  const preview = f.module.inspect('group:1')
  assert.equal(preview.selected.sourceId, 'memory:fact1')
  await f.module.tick()
  const guard = f.calls[0].options.validatePlan
  assert.equal(guard(), true); visible = false; assert.equal(guard(), false)

  const g = purposeFixture(); let attempts = 0
  g.speak.fire = async () => { attempts++; throw new Error('unknown') }
  await g.module.tick(); await g.module.tick()
  assert.equal(attempts, 1); assert.equal(g.module.inspect('group:1').last.state, 'unknown')
})

test('purpose plan travels through the real proactive guard and a recalled source cancels a queued event', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-purpose-')), oldDir = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const cfg = normalize({ enabled: true, dryRun: false, botQQ: '20', ownerQQ: '10', speakUp: { mode:'purpose', enabled:true,
    idleMinutes: 5, minIntervalMinutes: 5, maxIntervalMinutes: 5, awakeFrom: 0, awakeTo: 24, maxPerDay: 2 } })
  const now = Date.now(), message = { id:'m1', account:'20', chatId:'private:10', authorId:'10', text:'明天有面试', receivedAt:now - 600_000, recalledAt:null }
  const values = new Map(), events = [], scope = { account:'20', chat:'private:10', persona:'fish' }
  const storage = { epochs: { current: () => 1 }, meta: { get: (k, d) => values.get(k) || d, set: (k, v) => values.set(k, structuredClone(v)) },
    messages: { recent: () => [message], get: () => message } }
  const hub = { personaFor: () => ({ personaId:'fish', revision:1, bindingRevision:1 }), scopeFor: () => scope,
    lastOwnerChatAt: now - 600_000, enqueueProactive: async event => { events.push(event); return { accepted:true } } }
  const speak = createSpeakUp({ getConfig:() => cfg, hub, storage, memory:{}, log:{}, isMuted:()=>false })
  const api = { config:() => cfg, use:name => name === 'speakup' ? speak : null, core:{ hub, storage, mutes:{ muted:()=>false }, http:{ query:req=>req.query || {} } },
    every(){}, route(){}, onDispose(){}, log:{ warn(){} } }
  const purpose = purposeModule.setup(api)
  t.after(() => { speak.stop(); if (oldDir === undefined) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = oldDir; rmSync(dir,{recursive:true,force:true}) })
  assert.equal((await purpose.fire('private:10')).accepted, true)
  assert.equal(events.length, 1); assert.match(events[0].prompt, /明天有面试/); assert.match(events[0].prompt, /不把计划描述当成已经发生的经历/)
  assert.equal(events[0].shouldSend(), true)
  message.recalledAt = Date.now()
  assert.equal(events[0].shouldSend(), false); assert.equal(events[0].signal.aborted, true)
  message.recalledAt = null; assert.equal(events[0].shouldSend(), false, 'invalidated tickets remain canceled')
})

test('artwork identities remain stable across sorting and point to a specific output', () => {
  const scope = { account: '20', chatId: 'private:10', actorId: '10', personaId: 'fish' }
  const job = { id: 'job_a', kind: 'image', state: 'delivered', chatId: scope.chatId, actorId: scope.actorId,
    input: { accountId: scope.account, persona: { personaId: scope.personaId }, prompt: 'cat' }, output: { assetIds: ['ast_a', 'ast_b'] } }
  const items = artworkList([job], scope)
  assert.deepEqual(items.map(x => x.id), ['job_a:ast_a', 'job_a:ast_b'])
  assert.equal(resolveArtwork('job_a:ast_b', () => job, scope).assetId, 'ast_b')
  assert.equal(resolveArtwork('job_a', () => job, scope), null, 'multiple outputs require an explicit choice')
  assert.equal(resolveArtwork('job_a:ast_b', () => job, { ...scope, actorId: '11' }), null)
})

test('gallery routes page within scope and revalidate both asset preview and reuse', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-gallery-'))
  const storage = createStorage({ file: ':memory:', filesDir: join(dir, 'assets') }), routes = {}, disposers = []
  const cfg = normalize({ enabled: true, dryRun: false, botQQ: '20', ownerQQ: '10', allow: { groups: ['1'], private: [] }, imageGen: { enabled: true,
    profiles: [{ id: 'p', name: 'fixture', protocol: 'openai', baseUrl: 'https://invalid.example/v1', apiKey: 'fixture', model: 'fixture', capabilities: { modes: ['text', 'edit'], maxInputs: 4 } }] } })
  let personaId = 'fish', sent
  const hub = { personaFor: () => ({ personaId, revision: 1 }), outbox: { summary: () => ({}) } }
  const api = { config: () => cfg, core: { hub, storage, local: { active: () => false }, onebot: {}, http: { query: r => r.query || {}, body: async r => r.body || {}, send: (_res, status, bytes) => { sent = { status, bytes } } } },
    lazy: () => ({}), tool() {}, every() {}, route: (path, fn) => { routes[path] = fn }, onDispose: fn => disposers.push(fn), log: { info() {}, warn() {} } }
  const instance = imageModule.setup(api)
  instance.runner.kick = () => {} // Never invoke a provider in this test.
  t.after(async () => { for (const dispose of disposers) await dispose(); storage.close(); rmSync(dir, { recursive: true, force: true }) })
  const bytes = readFileSync(new URL('../assets/dafeiyu.jpg', import.meta.url)), asset = storage.assets.put(bytes, { mime: 'image/jpeg' })
  function add(account = '20', persona = 'fish', actor = '10', chatId = 'private:10') {
    const j = instance.runner.enqueue({ kind: 'image', chatId, actorId: actor, input: { accountId: account, persona: { personaId: persona }, prompt: 'cat', mode: 'text', refs: [] } })
    storage.db.run("UPDATE jobs SET state='delivered', output_json=? WHERE id=?", JSON.stringify({ assetIds: [asset.id] }), j.id)
    return j.id
  }
  for (let i = 0; i < 35; i++) add()
  add('21'); add('20', 'other'); add('20', 'fish', '11'); add('20', 'fish', '10', 'group:1')
  const first = await routes['/imagegen/gallery']({ query: { chatId: 'private:10' } })
  assert.equal(first.items.length, 30); assert.ok(first.nextCursor)
  const second = await routes['/imagegen/gallery']({ query: { chatId: 'private:10', personaId: 'fish', before: first.nextCursor } })
  assert.equal(second.items.length, 5); assert.equal(new Set([...first.items, ...second.items].map(x => x.id)).size, 35)
  const selected = first.items[0]
  await routes['/imagegen/gallery/asset']({ query: { chatId: 'private:10', personaId: 'fish', id: selected.id } }, {})
  assert.equal(sent.status, 200); assert.deepEqual(sent.bytes, bytes)
  const forged = await routes['/imagegen/gallery/asset']({ query: { chatId: 'group:1', personaId: 'fish', id: selected.id } }, {})
  assert.equal(forged.ok, false)
  personaId = 'other'
  assert.equal((await routes['/imagegen/gallery/asset']({ query: { chatId: 'private:10', personaId: 'fish', id: selected.id } }, {})).ok, false)
  assert.equal((await routes['/imagegen/submit']({ body: { chatId: 'private:10', prompt: 'edit', refs: [{ galleryId: selected.id, personaId: 'fish', role: 'base' }] } })).ok, false)
  personaId = 'fish'
  const submitted = await routes['/imagegen/submit']({ body: { chatId: 'private:10', prompt: 'edit', parentJobId: selected.jobId, refs: [{ galleryId: selected.id, personaId: 'fish', role: 'base' }] } })
  assert.equal(submitted.ok, true); assert.equal(submitted.job.input.refs[0].galleryId, selected.id)
})

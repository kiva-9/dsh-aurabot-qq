import { test } from 'node:test'
import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import moodModule from '../src/modules/mood/index.js'
import learningModule from '../src/modules/learning/index.js'
import { modelText } from '../src/learning/runtime.js'
import { fixture, S, sources, candidate, deferred, settled } from './helpers/wp6.js'

function harness(t) {
  const f = fixture(t); f.advance(Date.now() - f.now())
  const routes = new Map(), contexts = [], events = new Map(), timers = [], disposers = [], calls = [], resolutions = []
  const hub = {
    personaFor: (chatId) => { resolutions.push(chatId); return f.getIdentity({ ...S, chat: chatId }) },
    scopeFor: (chatId, options) => { assert.deepEqual(options, { persona: true }); return { account: f.cfg.botQQ, chat: chatId, persona: f.getIdentity({ ...S, chat: chatId }).personaId } },
    lastTextOf: () => '摸鱼', turnActor: () => ({ actorId: 'alice', requestId: 'r1' }),
  }
  Object.defineProperty(hub, 'persona', { get() { throw new Error('global persona must not be read') } })
  const model = { handler: async () => JSON.stringify({ items: [], noInfo: true }) }
  const dsh = { llm: { stream: async function* (args) {
    calls.push(args)
    const result = await model.handler(args)
    yield { type: 'text-delta', text: result }
    yield { type: 'finish', reason: 'stop' }
  } } }
  f.cfg.model = { provider: 'test', model: 'mock' }
  const api = { core: { storage: f.storage, hub, http: { query: r => r.query || {}, body: async r => r.body || {} } },
    config: () => f.cfg, dsh, log: { warn() {} }, route: (p, fn) => routes.set(p, fn), context: fn => contexts.push(fn),
    on: (event, fn) => { events.set(event, [...(events.get(event) || []), fn]) }, every: (_ms, fn) => timers.push(fn), onDispose: fn => disposers.push(fn),
  }
  return { ...f, api, hub, model, calls, resolutions, routes, contexts, timers, disposers,
    start: (mod) => f.track(mod.setup(api)),
    get: (path, query = {}) => routes.get(path)({ method: 'GET', query }),
    post: (path, body = {}) => routes.get(path)({ method: 'POST', body }),
    event: (a) => { for (const fn of events.get('activity') || []) fn(a) },
    configEvent: cfg => { for(const fn of events.get('config') || []) fn(cfg) },
  }
}
test('module file lists exist and routes require HTTP method, explicit scope and current account', async t => {
  const f = harness(t); f.start(moodModule); f.start(learningModule)
  for (const m of [moodModule, learningModule]) for (const file of m.files) assert.equal(statSync(resolve('src', file)).isFile(), true, file)
  assert.equal((await f.get('/mood/state')).code, 'SCOPE_REQUIRED')
  assert.equal((await f.get('/learning/items')).code, 'SCOPE_REQUIRED')
  assert.equal((await f.get('/learning/items', { ...S, account: 'other' })).code, 'SCOPE_FORBIDDEN')
  assert.equal((await f.get('/learning/create', S)).code, 'METHOD_NOT_ALLOWED')
  assert.equal((await f.post('/mood/nudge', { scope: S, delta: 10, reason: '本群原因' })).ok, true)
  const own = await f.get('/mood/state', S)
  assert.equal(own.reason, '本群原因')
  const other = await f.get('/mood/state', { ...S, chat: 'group:2' })
  assert.equal(other.reason, ''); assert.deepEqual(other.history, [])
})
test('learning panel API CRUD returns revisions, evidence, audit, status and scoped errors', async t => {
  const f = harness(t); f.start(learningModule)
  const ids = sources(f)
  let response = await f.post('/learning/create', { scope: S, kind: 'jargon', data: candidate(ids) })
  assert.equal(response.ok, true, response.message)
  let item = response.item
  assert.equal(item.status, 'pending')
  assert.equal((await f.get('/learning/item', { ...S, id: item.id })).item.id, item.id)
  assert.equal((await f.get('/learning/evidence', { ...S, id: item.id })).items.length, 3)
  assert.equal((await f.get('/learning/item', { ...S, chat: 'group:2', id: item.id })).code, 'NOT_FOUND')
  response = await f.post('/learning/approve', { scope: S, id: item.id, expectedRevision: item.revision, actorId: 'spoof' })
  assert.equal(response.item.status, 'approved'); item = response.item
  assert.equal((await f.get('/learning/audit', { ...S, id: item.id })).items[0].actorId, 'owner')
  assert.equal((await f.post('/learning/update', { scope: S, id: item.id, patch: { meaning: '改' } })).code, 'REVISION_CONFLICT')
  item = (await f.post('/learning/update', { scope: S, id: item.id, expectedRevision: item.revision, patch: { meaning: '歇一会' } })).item
  assert.equal(item.status, 'pending')
  item = (await f.post('/learning/revert', { scope: S, id: item.id, targetRevision: 1, expectedRevision: item.revision })).item
  assert.equal(item.meaning, '暂时放松')
  item = (await f.post('/learning/disable', { scope: S, id: item.id, expectedRevision: item.revision })).item
  assert.equal(item.status, 'disabled')
  item = (await f.post('/learning/delete', { scope: S, id: item.id, expectedRevision: item.revision })).item
  assert.equal((await f.get('/learning/items', S)).items.length, 0)
  assert.equal((await f.get('/learning/items', { ...S, includeDeleted: 'true' })).items.length, 1)
  item = (await f.post('/learning/restore', { scope: S, id: item.id, expectedRevision: item.revision })).item
  assert.equal(item.status, 'pending')
  const status = await f.get('/learning/status', S)
  assert.equal(status.queues.length, 2); assert.equal(status.settings.useEnabled, true)
  assert.equal(status.budget.calls, 0); assert.equal(status.budget.maxCallsPerDay, 30)
})
test('source picker returns scoped authored evidence, searches canonical text/author/id and stays read-only', async t => {
  const f = harness(t), learning = f.start(learningModule)
  f.cfg.learning.learnEnabled = false; f.cfg.learning.useEnabled = false
  const first = f.message('摸鱼休息', 'alice', S, { authorName: '小爱' })
  const second = f.message('投影中的转发秘密', 'bob', S, { authorName: '小波', segments: [{ type: 'text', text: '本人说要摸鱼 100%_' }] })
  f.message('别群摸鱼', 'alice', { ...S, chat: 'group:2' })
  f.message('别账号摸鱼', 'alice', { ...S, account: 'other' })
  f.message('私聊摸鱼', 'alice', { ...S, chat: 'private:alice' })
  for (const [body, author, extra] of [
    ['机器人摸鱼', 'bot', {}], ['工具摸鱼', 'alice', { eventKind: 'tool' }], ['[图片:摸鱼]', 'alice', {}],
    ['> 摸鱼', 'alice', {}], ['摸鱼转发', 'alice', { forwards: [{ id: 'f' }] }],
    ['摸鱼', 'alice', { segments: [{ type: 'forward', data: { id: 'f' } }] }],
    ['提示词示例：摸鱼', 'alice', {}], ['摸鱼密码 123456789', 'alice', {}],
    ['过期摸鱼', 'alice', { receivedAt: f.now() - 91 * 86400000 }],
    ['未来摸鱼', 'alice', { receivedAt: f.now() + 86400000 }],
  ]) f.message(body, author, S, extra)
  const recalled = f.message('已撤回摸鱼'); f.storage.db.run('UPDATE messages SET recalled_at=? WHERE id=?', f.now(), recalled.id)
  const query = { ...S, kind: 'jargon', q: '摸鱼', limit: '100' }
  const result = await f.get('/learning/sources', query)
  assert.equal(result.ok, true, result.message); assert.deepEqual(result.scope, S)
  assert.deepEqual(result.items.map(e => e.id), [second.id, first.id])
  assert.deepEqual(result.items[0], { id: second.id, text: '本人说要摸鱼 100%_', authorId: 'bob', authorName: '小波', receivedAt: f.now(), recvSeq: second.recvSeq })
  for (const q of ['小爱', 'ALICE', first.id]) assert.deepEqual((await f.get('/learning/sources', { ...query, kind: 'expression', q })).items.map(e => e.id), [first.id])
  assert.deepEqual((await f.get('/learning/sources', { ...query, q: '%_' })).items.map(e => e.id), [second.id], 'wildcards are literal text')
  assert.deepEqual((await f.get('/learning/sources', { ...query, q: '转发秘密' })).items, [], 'search never exposes rendered quote text')
  assert.equal(f.calls.length, 0); assert.equal(learning.budget().calls, 0)
  assert.equal(f.storage.db.get('SELECT COUNT(*) AS n FROM wp6_learning_checkpoints').n, 0)
})
test('source picker enforces method, current account/persona, kind, privacy and live evidence policy', async t => {
  const f = harness(t); f.start(learningModule)
  const m = f.message('摸鱼', 'alice'), query = { ...S, kind: 'expression' }
  assert.equal((await f.get('/learning/sources')).code, 'SCOPE_REQUIRED')
  assert.equal((await f.post('/learning/sources', query)).code, 'METHOD_NOT_ALLOWED')
  assert.equal((await f.get('/learning/sources', { ...query, account: 'other' })).code, 'SCOPE_FORBIDDEN')
  assert.equal((await f.get('/learning/sources', { ...query, persona: 'other' })).code, 'IDENTITY_REQUIRED')
  assert.equal((await f.get('/learning/sources', { ...query, kind: 'memory' })).code, 'INVALID_KIND')
  assert.equal((await f.get('/learning/sources', { ...query, q: 'x'.repeat(201) })).code, 'INVALID_INPUT')
  assert.equal((await f.get('/learning/sources', query)).items.length, 1)
  f.cfg.learning.blockedUserIds = ['alice']
  assert.equal((await f.get('/learning/sources', query)).items.length, 0)
  f.cfg.learning.blockedUserIds = []; f.cfg.learning.allowedUserIds = ['bob']
  assert.equal((await f.get('/learning/sources', query)).items.length, 0)
  f.cfg.learning.allowedUserIds = []
  f.storage.db.run('UPDATE messages SET recalled_at=? WHERE id=?', f.now(), m.id)
  assert.equal((await f.get('/learning/sources', query)).items.length, 0)
  const privateScope = { ...S, chat: 'private:alice' }, privateMessage = f.message('私聊摸鱼', 'alice', privateScope)
  assert.deepEqual((await f.get('/learning/sources', { ...privateScope, kind: 'jargon' })).items, [])
  f.cfg.learning.allowPrivate = true
  assert.deepEqual((await f.get('/learning/sources', { ...privateScope, kind: 'jargon' })).items.map(e => e.id), [privateMessage.id])
  assert.deepEqual((await f.get('/learning/sources', { ...query, q: '私聊' })).items, [])
})
test('source picker applies final result limit after filtering and caps it at 100', async t => {
  const f = harness(t); f.start(learningModule)
  for (let n = 0; n < 110; n++) f.message('可用的摸鱼消息 ' + n)
  for (let n = 0; n < 120; n++) f.message('[图片:不应占用结果名额 ' + n + ']')
  const query = { ...S, kind: 'jargon' }
  assert.equal((await f.get('/learning/sources', query)).items.length, 50)
  const capped = await f.get('/learning/sources', { ...query, limit: '9999' })
  assert.equal(capped.items.length, 100); assert.equal(capped.limit, 100); assert.equal(capped.truncated, true)
  assert.ok(capped.items.every(e => e.text.startsWith('可用的')))
  assert.equal((await f.get('/learning/sources', { ...query, limit: '3' })).items.length, 3)
})
test('source search has a bounded scan and reports truncation without claiming complete history', async t => {
  const f = harness(t); f.start(learningModule)
  f.message('很早的命中词')
  for (let n = 0; n < 2010; n++) f.message('最新消息 ' + n)
  const result = await f.get('/learning/sources', { ...S, kind: 'jargon', q: '很早的命中词', limit: 100 })
  assert.equal(result.ok, true); assert.equal(result.scanned, 2000)
  assert.equal(result.truncated, true); assert.deepEqual(result.items, [])
})
test('panel can explicitly list read-only shared entries while sources and writes stay owned', async t => {
  const f = harness(t), l = f.start(learningModule), ids = sources(f), viewer = { ...S, chat: 'group:2' }
  let item = l.upsert(S, 'jargon', candidate(ids)); item = l.transition(S, item.id, 'approved', { expectedRevision: item.revision })
  f.cfg.memory = { shareGroups: [{ id: 'learning', chats: [S.chat, viewer.chat], categories: ['jargon'] }] }
  assert.deepEqual((await f.get('/learning/items', viewer)).items, [])
  const shared = await f.get('/learning/items', { ...viewer, includeShared: 'true' })
  assert.equal(shared.items.length, 1); assert.equal(shared.items[0].readOnly, true)
  assert.equal(shared.items[0].scope.chat, S.chat); assert.deepEqual(shared.items[0].evidenceMessageIds, [])
  assert.deepEqual((await f.get('/learning/sources', { ...viewer, kind: 'jargon' })).items, [])
  assert.equal((await f.get('/learning/evidence', { ...viewer, id: item.id })).code, 'NOT_FOUND')
  assert.equal((await f.post('/learning/disable', { scope: viewer, id: item.id, expectedRevision: item.revision })).code, 'NOT_FOUND')
  assert.match(f.contexts[0]({ chat: { chatId: viewer.chat }, sessionId: 's2' }), /"shared":true/)
  f.cfg.memory.shareGroups = []
  assert.equal(f.contexts[0]({ chat: { chatId: viewer.chat }, sessionId: 's2' }), '')
})
test('events resolve msg.chatId and hub.personaFor; stale identity and system contexts are ignored', async t => {
  const f = harness(t), mood = f.start(moodModule), learning = f.start(learningModule)
  const m = f.message('谢谢你，摸鱼一会儿')
  f.event({ kind: 'in', msg: { chatId: S.chat }, chatId: 'group:2', account: 'bot', messageId: m.id })
  assert.ok(f.resolutions.every(id => id === S.chat))
  assert.equal(mood.state(S).value, 66)
  assert.equal(mood.state({ ...S, chat: 'group:2' }).value, 60)
  assert.equal(learning.checkpoint(S, 'jargon').queued, 1)
  const later = f.message('谢谢你')
  f.event({ kind: 'in', chatId: S.chat, account: 'old-account', messageId: later.id })
  assert.equal(mood.state(S).value, 66)
  f.identities.set('group:2', { ...f.identity, personaId: 'other' })
  const otherScope = { ...S, chat: 'group:2', persona: 'other' }
  const other = f.message('谢谢', 'alice', otherScope)
  f.event({ kind: 'in', msg: { chatId: 'group:2' }, account: 'bot', messageId: other.id })
  assert.equal(mood.state(otherScope).value, 66)
  for (const fn of f.contexts) {
    assert.equal(fn({ chat: { chatId: 'system:tasks' } }), '')
    assert.equal(fn({ chat: { chatId: S.chat }, personaId: 'wrong' }), '')
  }
})
test('only confirmed delivered out events can trigger source-backed mood judgment', async t => {
  const f = harness(t); f.cfg.mood.judge = true
  const mood = f.start(moodModule), m = f.message('谢谢')
  f.model.handler = async () => JSON.stringify({ delta: 10, reason: '友善交流', confidence: 1 })
  const event = { kind: 'out', chatId: S.chat, account: S.account, personaId: S.persona, personaRevision: 1,
    sourceMessageIds: [m.id], reply: '谢谢你', epoch: f.storage.epochs.current(S.chat) }
  f.event(event); f.event({ ...event, confirmed: false }); f.event({ ...event, confirmed: true, epoch: 999 })
  await settled()
  assert.equal(f.calls.length, 0)
  f.event({ ...event, confirmed: true })
  await settled()
  assert.equal(f.calls.length, 1)
  assert.equal(mood.state(S).value, 70)
  assert.match(f.calls[0].system, /测试角色/)
  assert.ok(f.calls[0].signal instanceof AbortSignal)
})
test('context hook uses only approved records and selected chat; model calls wait for scheduled batch', async t => {
  const f = harness(t), l = f.start(learningModule), ids = sources(f)
  let item = l.upsert(S, 'jargon', candidate(ids))
  const args = { chat: { chatId: S.chat }, sessionId: 's1' }
  assert.equal(f.contexts[0](args), '')
  assert.equal(f.calls.length, 0)
  item = l.transition(S, item.id, 'approved', { expectedRevision: item.revision })
  assert.match(f.contexts[0](args), /暂时放松/)
  assert.equal(f.contexts[0]({ chat: { chatId: 'group:2' }, sessionId: 's2' }), '')
  assert.equal(f.calls.length, 0)
  await f.timers[0]()
  assert.equal(f.calls.length, 2)
  assert.equal(l.checkpoint(S, 'jargon').outcome, 'no_info')
  assert.equal(l.checkpoint(S, 'expression').outcome, 'no_info')
  assert.equal(l.get(S, item.id).status, 'approved')
})
test('module disposal aborts pending work and drains model tasks before storage closes', async t => {
  const f = harness(t), gate = deferred(), l = f.start(learningModule); sources(f)
  f.model.handler = () => gate.promise
  const job = f.post('/learning/run', { scope: S, kind: 'jargon' })
  await settled()
  assert.equal(f.calls.length, 1)
  await Promise.all(f.disposers.map(fn => fn()))
  assert.equal(f.calls[0].signal.aborted, true)
  gate.resolve(JSON.stringify({ items: [], noInfo: true }))
  assert.equal((await job).ok, false)
  assert.equal(l.checkpoint(S, 'jargon').processedSeq, 0)
})
for (const reason of ['error', 'max-tokens', 'aborted', 'tool-calls', null]) {
  test(`model stream ${reason || 'without finish'} cannot publish partial JSON`, async () => {
    const dsh = { llm: { stream: async function* () {
      yield { type: 'text-delta', text: '{"items":[],"noInfo":true}' }
      if (reason) yield { type: 'finish', reason }
    } } }
    await assert.rejects(modelText(dsh, { cfg: { model: { provider: 'test', model: 'stream' } }, system: '', text: 'evidence', signal: new AbortController().signal }),
      { code: reason==='error'?'MODEL_FAILED':reason==='aborted'?'MODEL_ABORTED':'MODEL_INCOMPLETE' })
  })
}
test('model output is bounded while streaming', async () => {
  const dsh = { llm: { stream: async function* () { yield { type: 'text-delta', text: 'x'.repeat(16001) }; yield { type: 'finish', reason: 'stop' } } } }
  await assert.rejects(modelText(dsh, { cfg: { model: { provider: 'test', model: 'stream' } }, system: '', text: 'evidence', signal: new AbortController().signal }), { code: 'MODEL_OUTPUT_TOO_LARGE' })
})

for(const module of [learningModule,moodModule]) test(`${module.id} config hook cancels a revoked snapshot even if the current config was re-enabled`,async t=>{
  const f=harness(t),entered=deferred(),late=deferred()
  f.cfg.allow={groups:['1']};f.cfg.mood.judge=true
  const service=f.start(module),ids=sources(f)
  f.model.handler=async()=>{entered.resolve();await late.promise;return module===learningModule?'{"items":[],"noInfo":true}':'{"delta":5,"confidence":1,"reason":"旧结果"}'}
  const job=module===learningModule?service.learn(S,'expression'):service.judge(S,{sourceMessageIds:[ids[0]]})
  await entered.promise
  const revoked=structuredClone(f.cfg);revoked.allow.groups=[]
  // Hook delivery may be asynchronous: it must honor the revoked event snapshot.
  f.configEvent(revoked)
  assert.equal((await job).ok,false);assert.equal(f.calls[0].signal.aborted,true)
  late.resolve();await settled()
  if(module===learningModule) {
    assert.equal(service.checkpoint(S,'expression').processedSeq,0)
    f.cfg.allow.groups=[]
    await f.timers[0]();assert.equal(f.calls.length,1,'persisted scopes cannot bypass allowlist on periodic runs')
  } else assert.equal(service.state(S).value,60)
})

test('mood manual retry API requires current scoped evidence and never bypasses disabled policy',async t=>{
  const f=harness(t);f.cfg.mood.judge=true;f.cfg.allow={groups:['1']};const mood=f.start(moodModule)
  const message=f.message('谢谢')
  f.model.handler=async()=>'{"delta":5,"confidence":1,"reason":"交流愉快"}'
  assert.equal((await f.get('/mood/judge',S)).code,'METHOD_NOT_ALLOWED')
  assert.equal((await f.post('/mood/judge',{scope:S})).code,'EVIDENCE_REQUIRED')
  assert.equal((await f.post('/mood/judge',{scope:S,sourceMessageIds:[message.id]})).value,65)
  assert.equal((await f.post('/mood/resume',{scope:S})).ok,true)
  assert.equal((await f.post('/mood/judge',{scope:S,sourceMessageIds:[message.id]})).code,'DUPLICATE')
  f.cfg.allow.groups=[]
  assert.equal((await f.post('/mood/resume',{scope:S})).code,'SCOPE_DISABLED')
  assert.equal((await f.post('/mood/judge',{scope:S,sourceMessageIds:[message.id]})).code,'DISABLED')
  assert.equal(mood.state(S).value,65);assert.equal(f.calls.length,1)
})

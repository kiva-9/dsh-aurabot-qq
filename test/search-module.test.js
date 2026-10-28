import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { openDatabase } from '../src/storage/db.js'
import { statSync } from 'node:fs'
import searchModule from '../src/modules/search/index.js'

let server, base
const seen = []
before(async () => {
  server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c)
    const body = JSON.parse(Buffer.concat(chunks))
    seen.push({ body, url: req.url })
    const done = () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ results: [], images: [], request_id: 'test' })) }
    if (body.query === 'delay') setTimeout(done, 80)
    else done()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => { server.closeAllConnections(); server.close() })

function setup(t) {
  const db = openDatabase(':memory:')
  const cfg = { botQQ: '9000', ownerQQ: '42', search: { enabled: true, baseUrl: base, apiKey: 'mock-key', timeoutMs: 30000, cacheTtlMs: 0 } }
  let requests = [{ id: 'request-a', actorId: '101', chatId: 'group:1', epoch: 0, state: 'pending' }]
  let actor = { actorId: '101', requestId: 'request-a' }
  let chatId = 'group:1'
  let epoch = 0
  const routes = new Map(), builders = [], cleanup = []
  let usedOtherModule = false
  const hub = { turnActor: () => actor, turnRequests: () => requests, chatOfSession: () => chatId }
  const storage = { db, requests: { get: (id) => requests.find((r) => r.id === id) }, epochs: { current: () => epoch } }
  const api = {
    core: { hub, storage, http: { query: (req) => req.query, body: async (req) => req.body } },
    config: () => cfg, tool: (builder) => builders.push(builder), route: (path, handler) => routes.set(path, handler),
    use: () => { usedOtherModule = true; throw new Error('must not write memories') },
    lazy: () => { usedOtherModule = true; throw new Error('must not write memories') }, onDispose: (fn) => cleanup.push(fn),
  }
  const exports = searchModule.setup(api)
  const tools = () => builders[0]({ chat: { kind: 'group', chatId: 'group:1' }, sessionId: 'session' })
  const tool = (name) => tools().find((x) => x.name === name)
  const call = (path, method, data = {}, events = {}) => {
    const req = Object.assign(new EventEmitter(), { method, body: data, query: data }, events.req)
    const res = Object.assign(new EventEmitter(), { writableEnded: false }, events.res)
    const result = routes.get(path)(req, res)
    return { req, res, result }
  }
  t.after(() => { cleanup.forEach((fn) => fn()); db.close(); assert.equal(usedOtherModule, false) })
  return { cfg, exports, routes, tools, tool, builders, call,
    setActor: (x) => { actor = x }, setRequests: (x) => { requests = x }, setChat: (x) => { chatId = x }, bumpEpoch: () => epoch++ }
}

test('three tools are discoverable with bounded data rendering; unconfigured status is explicit', async (t) => {
  const m = setup(t)
  assert.ok(searchModule.files.every((path) => path.endsWith('.js') && statSync(new URL('../src/' + path, import.meta.url)).isFile()))
  assert.deepEqual(m.tools().map((x) => x.name), ['qq_web_search', 'qq_web_extract', 'qq_reference_candidates'])
  assert.deepEqual(m.builders[0]({ chat: { kind: 'system' } }), [])
  for (const tool of m.tools()) {
    assert.equal(tool.parameters.additionalProperties, false)
    for (const key of ['actorId', 'account', 'chatId', 'requestId', 'turnId', 'baseUrl', 'apiKey', 'authority']) assert.equal(tool.parameters.properties[key], undefined)
  }
  m.cfg.search.enabled = false
  let r = await m.tool('qq_web_search').execute({ query: 'x' })
  assert.equal(r.code, 'SEARCH_DISABLED'); assert.equal(r.ok, false)
  m.cfg.search.enabled = true; m.cfg.search.apiKey = ''
  r = await m.tool('qq_web_search').execute({ query: 'x' })
  assert.equal(r.code, 'SEARCH_UNCONFIGURED')
  const status = await m.call('/search/status', 'GET').result
  assert.equal(status.available, false); assert.equal(status.code, 'SEARCH_UNCONFIGURED')
})

test('tools inherit hub actor/current chat and ignore forged scope, key, turn and authority arguments', async (t) => {
  const m = setup(t)
  const tool = m.tool('qq_web_search')
  const result = await tool.execute({ query: 'x', actorId: '42', chatId: 'private:42', account: 'hacker', turnId: 'new-budget', baseUrl: 'http://bad.example', apiKey: 'stolen', authority: 'owner-panel' })
  assert.equal(result.ok, true)
  const record = m.exports.result({ account: '9000', chatId: 'group:1' }, result.resultId)
  assert.equal(record.actorId, '101'); assert.equal(record.turnId, 'request-a'); assert.equal(record.scope.chat, 'group:1'); assert.equal(record.scope.account, '9000')
  assert.ok(!JSON.stringify(seen.at(-1).body).includes('hacker'))
  assert.equal(JSON.parse(tool.output.render({}, result)[0].text).resultId, result.resultId)
  assert.throws(() => m.exports.result({ account: '9000', chatId: 'private:42' }, result.resultId), (e) => e.code === 'NOT_FOUND')
})

test('ambiguous, absent, foreign and moved-session actors fail closed without HTTP calls', async (t) => {
  const m = setup(t)
  const n = seen.length
  for (const actor of [{ error: 'several actors' }, { actorId: '101', requestId: null }, { actorId: '42', requestId: 'request-a' }]) {
    m.setActor(actor)
    assert.equal((await m.tool('qq_web_search').execute({ query: 'x' })).ok, false)
  }
  m.setActor({ actorId: '101', requestId: 'request-a' }); m.setChat('private:42')
  assert.equal((await m.tool('qq_web_search').execute({ query: 'x' })).code, 'SCOPE_MISMATCH')
  assert.equal(seen.length, n)
})

test('mixed requesters and appended steer requests still share the first request search budget', async (t) => {
  const m = setup(t)
  await m.tool('qq_web_search').execute({ query: 'one' })
  m.setRequests([{ id: 'request-a', actorId: '101', chatId: 'group:1', epoch: 0 }, { id: 'request-b', actorId: '102', chatId: 'group:1', epoch: 0 }])
  m.setActor({ actorId: '102', requestId: 'request-b' })
  assert.equal((await m.tool('qq_reference_candidates').execute({ query: 'two', entity: { name: 'Aster' } })).ok, true)
  const n = seen.length
  assert.equal((await m.tool('qq_web_search').execute({ query: 'three', turnId: 'reset' })).code, 'BUDGET_EXHAUSTED')
  assert.equal(seen.length, n)
})

test('tool AbortSignal and late epoch change block completion', async (t) => {
  const m = setup(t)
  const controller = new AbortController()
  const canceled = m.tool('qq_web_search').execute({ query: 'delay' }, { signal: controller.signal })
  setTimeout(() => controller.abort(), 10)
  assert.equal((await canceled).code, 'CANCELED')
  const stale = m.tool('qq_web_search').execute({ query: 'delay' })
  setTimeout(m.bumpEpoch, 10)
  assert.equal((await stale).code, 'STALE_CONTEXT')
  assert.equal(m.exports.history({ account: '9000', chatId: 'group:1' }).filter((r) => r.status === 'complete').length, 0)
})

test('panel query/result/history protocol requires scope, uses trusted owner, enforces method and separates chats', async (t) => {
  const m = setup(t)
  const missing = await m.call('/search/query', 'POST', { query: 'x' }).result
  assert.equal(missing.code, 'SCOPE_REQUIRED')
  const r = await m.call('/search/query', 'POST', { query: 'private question', chatId: 'private:42', actorId: 'untrusted', account: 'other' }).result
  assert.equal(r.ok, true); assert.equal(r.result.actorId, '42'); assert.equal(r.result.scope.account, '9000')
  const good = await m.call('/search/result', 'GET', { id: r.result.id, chatId: 'private:42' }).result
  assert.equal(good.result.query, 'private question')
  const wrong = await m.call('/search/result', 'GET', { id: r.result.id, chatId: 'group:1' }).result
  assert.equal(wrong.code, 'NOT_FOUND')
  assert.equal((await m.call('/search/history', 'GET', { chatId: 'group:1' }).result).list.length, 0)
  assert.equal((await m.call('/search/history', 'GET', { chatId: 'private:42' }).result).list.length, 1)
  const n = seen.length
  assert.equal((await m.call('/search/query', 'GET', { chatId: 'private:42', query: 'x' }).result).code, 'METHOD_NOT_ALLOWED')
  assert.equal(seen.length, n)
  for (const path of ['/search/extract', '/search/references', '/search/reference/confirm', '/search/reference/preview', '/search/reference/materialize']) assert.ok(m.routes.has(path))
})

test('panel disconnect cancels and cleans up request/response listeners', async (t) => {
  const m = setup(t)
  const call = m.call('/search/query', 'POST', { chatId: 'group:1', query: 'delay' })
  setTimeout(() => call.res.emit('close'), 10)
  const r = await call.result
  assert.equal(r.code, 'CANCELED'); assert.equal(r.ok, false)
  assert.equal(call.res.listenerCount('close'), 0); assert.equal(call.req.listenerCount('aborted'), 0)
})

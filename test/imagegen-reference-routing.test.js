import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import imagegen from '../src/modules/imagegen/index.js'
import { createStorage } from '../src/storage/index.js'
import { normalize } from '../src/core/config.js'

function setup(t, { search = {}, retrieval = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-ref-routing-'))
  const storage = createStorage({ file: ':memory:', filesDir: join(dir, 'assets') })
  const config = normalize({ botQQ: '20', ownerQQ: '10', imageGen: { enabled: true, profiles: [{
    id: 'fixture', protocol: 'openai', baseUrl: 'https://unused.invalid/v1', model: 'fixture',
    capabilities: { modes: ['text', 'reference', 'edit'], maxInputs: 4 },
  }] } })
  const routes = new Map()
  const api = imagegen.setup({
    core: { storage, hub: { personaFor: () => ({ personaId: 'cat', revision: 1 }) }, local: { active: () => false }, http: { body: async r => r } },
    config: () => config, lazy: id => ({ search, retrieval }[id] || {}),
    log: { info() {} }, every() {}, tool() {}, onDispose() {}, route: (path, fn) => routes.set(path, fn),
  })
  // Exercise the real module, validation and persistent enqueue, with no worker or provider invocation.
  api.runner.kick = () => {}
  t.after(async () => { await api.runner.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) })
  const asset = storage.assets.put(readFileSync(new URL('../assets/dafeiyu.jpg', import.meta.url)), { mime: 'image/jpeg' })
  const submit = refs => routes.get('/imagegen/submit')({ chatId: 'group:42', prompt: 'cat', refs })
  return { storage, api, asset, submit }
}

test('面板搜索ref含occurrenceId时先核验搜索，用权威ref替换旧资产并继承请求范围', async t => {
  const calls = []
  const search = { materializeReference: (ref, context) => { calls.push({ ref, context }); return { assetId: s.asset.id, occurrenceId: 'verified-occurrence', ...ref } } }
  const s = setup(t, { search }) // retrieval deliberately disabled
  const result = await s.submit([{ resultId: 'r1', candidateId: 'c1', occurrenceId: 'stale-occurrence', assetId: 'stale-asset', role: 'style' }])
  assert.equal(result.ok, true, result.message)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].ref, { resultId: 'r1', candidateId: 'c1' })
  assert.equal(calls[0].context.account, '20'); assert.equal(calls[0].context.chatId, 'group:42')
  assert.equal(calls[0].context.actorId, '10'); assert.equal(calls[0].context.authority, 'owner-panel')
  assert.equal(calls[0].context.requestId, calls[0].context.turnId)
  assert.deepEqual(result.job.input.refs, [{ assetId: s.asset.id, occurrenceId: 'verified-occurrence', resultId: 'r1', candidateId: 'c1', role: 'style' }])
})

test('搜索核验拒绝、标识不完整或模块关闭时不降级到history或assetId', async t => {
  let historyCalls = 0
  const retrieval = { materializeReference: () => { historyCalls++; throw new Error('不应调用历史入口') } }
  const search = { materializeReference: ref => { throw new Error(ref.resultId && ref.candidateId ? '候选已过期或尚未确认' : '缺少候选标识') } }
  const s = setup(t, { search, retrieval })
  for (const ids of [{ resultId: 'r', candidateId: 'c' }, { resultId: 'r' }, { candidateId: 'c' }]) {
    const result = await s.submit([{ ...ids, occurrenceId: 'o', assetId: s.asset.id, role: 'identity' }])
    assert.equal(result.ok, false); assert.match(result.message, /候选|标识/)
  }
  delete search.materializeReference
  assert.match((await s.submit([{ resultId: 'r', candidateId: 'c', occurrenceId: 'o', role: 'identity' }])).message, /搜索模块未启用/)
  assert.equal(historyCalls, 0); assert.equal(s.api.runner.list().length, 0)
})

test('普通history ref仍走历史核验并带当前persona，直接上传仍可用', async t => {
  const calls = []
  const s = setup(t, {
    search: { materializeReference: () => { throw new Error('不应调用搜索入口') } },
    retrieval: { materializeReference: async (ref, context) => { calls.push({ ref, context }); return { assetId: s.asset.id, occurrenceId: ref.occurrenceId } } },
  })
  const history = await s.submit([{ occurrenceId: 'history-occ', role: 'composition' }])
  assert.equal(history.ok, true, history.message); assert.equal(calls[0].context.personaId, 'cat')
  assert.equal(history.job.input.refs[0].role, 'composition')
  const upload = await s.submit([{ assetId: s.asset.id, role: 'identity' }])
  assert.equal(upload.ok, true, upload.message); assert.equal(calls.length, 1)
})

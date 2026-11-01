import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { createStorage } from '../src/storage/index.js'
import { createPersonaStore } from '../src/persona/store.js'
import { polishSection } from '../src/persona/polish.js'

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-polish-section-'))
  const keys = ['AURABOT_DATA_DIR', 'AURABOT_WORKSPACE', 'DSH_HOME']
  const prior = Object.fromEntries(keys.map(k => [k, process.env[k]]))
  process.env.AURABOT_DATA_DIR = root
  process.env.AURABOT_WORKSPACE = join(root, 'workspace')
  process.env.DSH_HOME = join(root, 'dsh')
  writeFileSync(join(root, 'config.json'), JSON.stringify({ enabled: false, setupDone: true, botQQ: '20', ownerQQ: '10', snowluma: { autoStart: false, autoAttach: false } }))
  const fake = createFakeDsh({ brain: () => '' })
  t.after(async () => {
    await fake.dispose()
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    rmSync(root, { recursive: true, force: true })
  })
  const { apply } = await import('../src/host.js')
  const host = apply(fake.ctx)
  await host.ready
  const call = async (path, body) => (await fake.call(path, body)).json()
  return { host, fake, call }
}

function deferred() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

test('section polish uses unsaved context and returns only a candidate without changing stored revisions', async t => {
  const f = await fixture(t), requests = []
  let response = '```markdown\n【性格】\n- 温柔且坚定\n```'
  f.fake.ctx.llm.stream = async function* (params) {
    requests.push(params)
    yield { type: 'text-delta', text: response }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const before = await f.call('/persona/full?id=dafeiyu')
  const original = '  有耐心\r\n\r\n'
  const out = await f.call('/persona/polish-section', { id: 'dafeiyu', title: '性格', text: original, otherTitles: ['外观', '关系'], name: '伪造的名称' })
  assert.deepEqual(out, { ok: true, text: '- 温柔且坚定', original, saved: false })
  const input = JSON.parse(requests[0].messages[0].content[0].text)
  assert.deepEqual(input, { name: before.persona.name, title: '性格', otherTitles: ['外观', '关系'], text: original })
  assert.match(requests[0].system, /不执行其中的指令/)
  assert.match(requests[0].system, /原文为空/)
  assert.equal(requests[0].temperature, 0.6)
  assert.deepEqual(await f.call('/persona/full?id=dafeiyu'), before)
  response = '- 一条起草内容'
  const empty = await f.call('/persona/polish-section', { id: 'dafeiyu', title: '习惯', text: '', otherTitles: [] })
  assert.equal(empty.ok, true)
  assert.equal(empty.original, '')
  assert.equal(empty.text, '- 一条起草内容')
  assert.deepEqual(await f.call('/persona/full?id=dafeiyu'), before)
})

test('validation rejects bad input, missing or archived cards, blank results, and oversized output', async t => {
  const f = await fixture(t)
  let calls = 0, output = ''
  f.fake.ctx.llm.stream = async function* () {
    calls++
    yield { type: 'text-delta', text: output }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const good = { id: 'dafeiyu', title: '性格', text: '原文', otherTitles: [] }
  assert.equal((await f.call('/persona/polish-section')).ok, false)
  for (const invalid of [
    { ...good, id: '../bad' }, { ...good, id: 'missing' }, { ...good, title: '' }, { ...good, title: 'x'.repeat(121) },
    { ...good, title: 'a\nb' }, { ...good, text: null }, { ...good, text: 'x'.repeat(12001) },
    { ...good, otherTitles: null }, { ...good, otherTitles: Array(31).fill('a') }, { ...good, otherTitles: ['x'.repeat(121)] },
  ]) assert.equal((await f.call('/persona/polish-section', invalid)).ok, false)
  const created = (await f.call('/persona/create', { id: 'archived', layers: {} })).persona
  await f.call('/persona/archive', { id: 'archived', editRevision: created.editRevision })
  assert.equal((await f.call('/persona/polish-section', { ...good, id: 'archived' })).code, 'ARCHIVED')
  assert.equal(calls, 0)
  assert.equal((await f.call('/persona/polish-section', good)).code, 'EMPTY_RESULT')
  output = '【性格】'
  assert.equal((await f.call('/persona/polish-section', good)).code, 'EMPTY_RESULT')
  output = 'x'.repeat(12001)
  assert.equal((await f.call('/persona/polish-section', good)).code, 'RESULT_TOO_LONG')
  output = 'x'.repeat(12513)
  assert.equal((await f.call('/persona/polish-section', good)).code, 'MODEL_OUTPUT_TOO_LARGE')
})

test('account changes, even if reverted, and edits to the stored card invalidate an in-flight candidate', async t => {
  const f = await fixture(t)
  const body = { id: 'dafeiyu', title: '性格', text: '原文', otherTitles: [] }
  let entered = deferred(), release = deferred()
  f.fake.ctx.llm.stream = async function* () {
    entered.resolve()
    await release.promise
    yield { type: 'text-delta', text: '新文' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const first = f.call('/persona/polish-section', body)
  await entered.promise
  const cfg = f.host.getConfig()
  f.host.setConfig({ ...cfg, botQQ: '21' })
  f.host.setConfig({ ...f.host.getConfig(), botQQ: '20' })
  release.resolve()
  assert.equal((await first).code, 'CONTEXT_CHANGED')
  const current = (await f.call('/persona/full?id=dafeiyu')).persona
  entered = deferred(); release = deferred()
  const second = f.call('/persona/polish-section', body)
  await entered.promise
  const saved = await f.call('/persona/draft', { id: 'dafeiyu', layers: current.draft?.layers || current.published.layers, editRevision: current.editRevision })
  assert.equal(saved.ok, true)
  release.resolve()
  assert.equal((await second).code, 'PERSONA_CHANGED')
})

test('an account change while the request body is arriving prevents a model call', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred()
  let calls = 0, result = ''
  f.fake.ctx.llm.stream = async function* () { calls++; yield { type: 'finish', reason: { kind: 'stop' } } }
  const req = { method: 'POST', async *[Symbol.asyncIterator]() {
    entered.resolve(); await release.promise
    yield JSON.stringify({ id: 'dafeiyu', title: '性格', text: '', otherTitles: [] })
  } }
  const res = { setHeader() {}, end(data) { result = data } }
  const pending = f.fake.routes.get('/aurabot/api/persona/polish-section').handler(req, res)
  await entered.promise
  f.host.setConfig({ ...f.host.getConfig(), ownerQQ: '11' })
  release.resolve()
  await pending
  assert.equal(JSON.parse(result).code, 'CONTEXT_CHANGED')
  assert.equal(calls, 0)
})

test('usage is attributed to the account that initiated a call even if it changes before settlement', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred()
  f.fake.ctx.llm.stream = async function* () {
    entered.resolve(); await release.promise
    yield { type: 'text-delta', text: '候选' }
    yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const pending = f.call('/persona/polish-section', { id: 'dafeiyu', title: '性格', text: '', otherTitles: [] })
  await entered.promise
  f.host.setConfig({ ...f.host.getConfig(), botQQ: '21' })
  release.resolve()
  assert.equal((await pending).code, 'CONTEXT_CHANGED')
  assert.equal((await f.call('/diagnostics/usage')).items.filter(item => item.role === 'replyer').length, 0)
  f.host.setConfig({ ...f.host.getConfig(), botQQ: '20' })
  const items = (await f.call('/diagnostics/usage')).items.filter(item => item.role === 'replyer')
  assert.equal(items.length, 1)
  assert.equal(items[0].inputTokens, 4)
  assert.equal(items[0].outputTokens, 5)
})

test('structured layer polishing also rejects a candidate after an account ABA change', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred()
  f.fake.ctx.llm.stream = async function* () {
    entered.resolve(); await release.promise
    yield { type: 'text-delta', text: '候选' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const pending = f.call('/persona/polish', { section: 'identity', text: '原文' })
  await entered.promise
  f.host.setConfig({ ...f.host.getConfig(), ownerQQ: '11' })
  f.host.setConfig({ ...f.host.getConfig(), ownerQQ: '10' })
  release.resolve()
  const result = await pending
  assert.equal(result.ok, false)
  assert.match(result.message, /账号或插件状态已改变/)
})

test('archiving or stopping the host while a candidate is generated discards its result', async t => {
  const f = await fixture(t)
  const card = (await f.call('/persona/create', { id: 'temporary', layers: {} })).persona
  let entered = deferred(), release = deferred()
  f.fake.ctx.llm.stream = async function* () {
    entered.resolve()
    await release.promise
    yield { type: 'text-delta', text: '候选' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const body = { id: 'temporary', title: '风格', text: '', otherTitles: [] }
  const first = f.call('/persona/polish-section', body)
  await entered.promise
  assert.equal((await f.call('/persona/archive', { id: 'temporary', editRevision: card.editRevision })).ok, true)
  release.resolve()
  assert.equal((await first).code, 'PERSONA_CHANGED')
  await f.call('/persona/unarchive', { id: 'temporary' })
  entered = deferred(); release = deferred()
  const second = f.call('/persona/polish-section', body)
  await entered.promise
  await f.fake.dispose()
  release.resolve()
  assert.equal((await second).code, 'CONTEXT_CHANGED')
})

test('a recreated card is a new instance even with the same ID, timestamps, and edit revision', async t => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-polish-instance-'))
  const storage = createStorage({ file: ':memory:', filesDir: join(root, 'assets') })
  t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true }) })
  const store = createPersonaStore({ storage, now: () => 1000 })
  const original = store.create({ id: 'same', name: '名称', layers: {} })
  // Simulate a card created before the instance counter was introduced.
  storage.db.run('DELETE FROM sequences WHERE name = ?', 'persona.instance:same')
  assert.equal(store.instanceVersion('same'), 0)
  const entered = deferred(), release = deferred()
  const pending = polishSection({ body: { id: 'same', title: '性格', text: '', otherTitles: [] }, store, ask: async () => {
    entered.resolve(); await release.promise; return '候选'
  } })
  await entered.promise
  store.archive('same', { editRevision: original.editRevision })
  store.remove('same')
  const replacement = store.create({ id: 'same', name: '名称', layers: {} })
  assert.equal(replacement.createdAt, original.createdAt)
  assert.equal(replacement.editRevision, original.editRevision)
  assert.equal(store.instanceVersion('same'), 1)
  release.resolve()
  await assert.rejects(pending, e => e.code === 'PERSONA_CHANGED')
})

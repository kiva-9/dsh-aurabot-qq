import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createStorage } from '../src/storage/index.js'
import { createMediaAnalysis, DEFAULT_MEDIA_MEMORY, MEDIA_MEMORY_SCHEMA, mediaMemorySettings, parseMediaAnalysis } from '../src/runtime/media-analysis.js'
import mediaModule from '../src/modules/media-memory/index.js'
import { PNG, JPG, png } from './helpers/images.js'

const RESULT = { version: 1, description: '蓝色方块', ocr: '可见文字' }
const GIF = Buffer.from('R0lGODdhAgADAIEAAFB43AAAAAAAAAAAACwAAAAAAgADAAAIBgABCBwYEAA7', 'base64')
const code = (value) => (error) => error.code === value
function deferred() {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.fail('mock did not reach expected state')
}
function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-media-analysis-')), file = join(dir, 'store.sqlite'), filesDir = join(dir, 'assets')
  let time = Date.now(), storage = createStorage({ file, filesDir, now: () => time })
  const cfg = { botQQ: 'bot', ownerQQ: 'owner', allow: { groups: ['1', '2'], private: ['alice'] },
    roles: { vision: { provider: 'mock', model: 'vision-a' } }, mediaMemory: { enabled: true, minIntervalMs: 0, retryBackoffMs: 0, ...options } }
  const calls = [], services = [], ask = { run: async () => JSON.stringify(RESULT) }
  const deps = () => ({ storage, getConfig: () => cfg, now: () => time, ask: async (o) => { calls.push(o); return ask.run(o) } })
  const f = { cfg, calls, ask, dir, deps, get storage() { return storage }, now: () => time, advance: (ms) => { time += ms },
    create: () => { const s = createMediaAnalysis(deps()); services.push(s); return s },
    track: (s) => { services.push(s); return s },
    async reopen() { for (const s of services) await s.stop(); storage.close(); storage = createStorage({ file, filesDir, now: () => time }); return f.create() },
    image({ buf = PNG, mime = 'image/png', chatId = 'group:1', account = 'bot', authorId = 'alice', text = '本群说明', kind = 'image', pending = false, extra = {} } = {}) {
      const msg = storage.messages.ingest({ account, chatId, authorId, eventKind: 'message', text, ...extra })
      const occurrenceId = storage.occurrences.add({ messageId: msg.id, chatId, authorId, segIndex: 0, kind, scope: { account, chat: chatId, category: 'image' } })
      const asset = pending ? null : storage.assets.put(buf, { mime })
      if (asset) storage.occurrences.ready(occurrenceId, asset.id)
      return { chatId, occurrenceId, messageId: msg.id, asset }
    },
    args(s, im) { return { chatId: im.chatId, occurrenceId: im.occurrenceId, expectedRevision: s.get(im).revision } },
    async run(s, im, extra = {}) { const out = s.analyze({ ...f.args(s, im), ...extra }); await s.tick(); return out },
  }
  t.after(async () => {
    for (const s of services) await s.stop()
    storage.close()
    const abs = resolve(dir), parent = resolve(tmpdir()) + sep
    assert.ok(abs.startsWith(parent) && abs.includes('aurabot-media-analysis-'))
    rmSync(abs, { recursive: true, force: true })
  })
  return f
}

test('defaults/schema are importable, disabled is strict, and model JSON is a versioned exact contract', () => {
  assert.equal(DEFAULT_MEDIA_MEMORY.enabled, false)
  assert.equal(MEDIA_MEMORY_SCHEMA.properties.maxBytes.maximum, 30 * 1024 * 1024)
  assert.equal(mediaMemorySettings({ mediaMemory: { enabled: 'true', autoAnalyze: 1, maxQueue: -1 } }).enabled, false)
  assert.deepEqual(parseMediaAnalysis(JSON.stringify(RESULT)), RESULT)
  for (const bad of [{ ...RESULT, version: 2 }, { ...RESULT, extra: true }, { description: 'x', ocr: '' }, { ...RESULT, ocr: [] },
    { ...RESULT, description: ' ' }, { ...RESULT, ocr: 'x'.repeat(8001) }, '```json\n' + JSON.stringify(RESULT) + '\n```', JSON.stringify(RESULT) + ' trailing']) {
    assert.throws(() => parseMediaAnalysis(bad), code('INVALID_RESULT'))
  }
})

test('default/off mode discovers durable occurrences without any model call or analysis job', async (t) => {
  const f = fixture(t), s = f.create(), im = f.image()
  delete f.cfg.mediaMemory
  await s.tick()
  assert.equal(s.list({ chatId: im.chatId }).length, 1)
  assert.equal(s.get(im).status, 'unanalysed')
  assert.throws(() => s.analyze(f.args(s, im)), code('DISABLED'))
  assert.equal(s.jobs().length, 0); assert.equal(f.calls.length, 0)
})

test('static analysis persists versioned results, source-local notes and metadata using role vision', async (t) => {
  const f = fixture(t), s = f.create(), im = f.image({ buf: JPG, mime: 'image/jpeg', text: '不要发送给视觉模型的聊天说明' })
  const out = await f.run(s, im)
  const item = s.get(im)
  assert.equal(item.status, 'ready'); assert.deepEqual(item.result, RESULT); assert.equal(item.info.width, 1272)
  assert.equal(item.chatNote, '不要发送给视觉模型的聊天说明')
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].role, 'vision')
  assert.equal(f.calls[0].images[0].mediaType, 'image/jpeg')
  assert.equal(Buffer.from(f.calls[0].images[0].data, 'base64').equals(JPG), true)
  assert.equal(JSON.stringify(f.calls).includes(item.chatNote), false)
  assert.equal(s.jobs().find((j) => j.id === out.job.id).status, 'succeeded')
  assert.deepEqual(f.storage.occurrences.get(im.occurrenceId).analysis.mediaMemory.result, RESULT)
  assert.equal(s.status({ chatId: im.chatId }).budget.used, 1)
})

test('SHA/model-version cache shares only pixels across occurrences, never chat context or account', async (t) => {
  const f = fixture(t), s = f.create(), a = f.image({ text: '私有聊天一' }), b = f.image({ chatId: 'group:2', text: '独立聊天二' })
  await f.run(s, a); await f.run(s, b)
  assert.equal(f.calls.length, 1); assert.equal(s.get(b).cacheHit, true)
  assert.equal(s.get(a).chatNote, '私有聊天一'); assert.equal(s.get(b).chatNote, '独立聊天二')
  f.cfg.mediaMemory.modelVersion = '2'
  await f.run(s, f.image())
  assert.equal(f.calls.length, 2)
  f.cfg.roles.vision.model = 'vision-b'
  await f.run(s, f.image())
  assert.equal(f.calls.length, 3)
  f.cfg.botQQ = 'other'
  const other = f.image({ account: 'other' })
  await f.run(s, other)
  assert.equal(f.calls.length, 4)
  assert.equal(s.list({ chatId: a.chatId }).length, 1)
  assert.throws(() => s.get(a), code('SCOPE_FORBIDDEN'))
})

test('automatic mode requires explicit enabled, chat/category rule and existing chat permission', async (t) => {
  const f = fixture(t, { autoAnalyze: true, autoChats: ['group:1'] }), s = f.create()
  const allowed = f.image(), noRule = f.image({ chatId: 'group:2', buf: png(3, 3) }), sticker = f.image({ kind: 'sticker', buf: png(4, 3) })
  await s.tick()
  assert.equal(s.get(allowed).status, 'ready'); assert.equal(s.get(noRule).status, 'unanalysed'); assert.equal(s.get(sticker).status, 'unanalysed')
  f.cfg.mediaMemory.autoChats.push('group:2'); f.cfg.allow.groups = ['1']
  await s.tick(); assert.equal(s.get(noRule).status, 'unanalysed')
  f.cfg.allow.groups.push('2'); await s.tick()
  assert.equal(s.get(noRule).status, 'ready'); assert.equal(f.calls.length, 2)
})

test('pending downloads are discovered before settling and processed on later ticks', async (t) => {
  const f = fixture(t, { autoAnalyze: true, autoChats: ['group:1'] }), s = f.create(), im = f.image({ pending: true })
  await s.tick(); assert.equal(s.get(im).status, 'waiting_asset'); assert.equal(f.calls.length, 0)
  const asset = f.storage.assets.put(PNG, { mime: 'image/png' })
  f.storage.occurrences.ready(im.occurrenceId, asset.id)
  await s.tick(); assert.equal(s.get(im).status, 'ready'); assert.equal(f.calls.length, 1)
})

test('automatic activation/re-enabling does not backfill historical media; its boundary survives reopen', async (t) => {
  const f = fixture(t, { autoAnalyze: true, autoChats: ['group:1'] })
  const old = f.image({ extra: { receivedAt: f.now() - 10_000 } }), s = f.create(), incoming = f.image({ buf: png(3, 3) })
  await s.tick()
  assert.equal(s.get(old).status, 'unanalysed'); assert.equal(s.get(incoming).status, 'ready')
  const fresh = await f.reopen()
  await fresh.tick(); assert.equal(f.calls.length, 1)
  f.cfg.mediaMemory.autoAnalyze = false; await fresh.tick()
  f.advance(1000); const duringOff = f.image({ buf: png(4, 3) })
  f.advance(1000); f.cfg.mediaMemory.autoAnalyze = true; await fresh.tick()
  assert.equal(fresh.get(duringOff).status, 'unanalysed')
  await f.run(fresh, old); assert.equal(f.calls.length, 2)
})

test('manual and automatic calls share persistent per-account and per-chat daily budgets', async (t) => {
  const f = fixture(t, { maxCallsPerDay: 2, maxCallsPerChatPerDay: 1 }), s = f.create()
  await f.run(s, f.image())
  const same = f.image({ buf: png(3, 3) })
  assert.throws(() => s.analyze(f.args(s, same)), code('BUDGET_EXHAUSTED'))
  await f.run(s, f.image({ chatId: 'group:2', buf: png(4, 3) }))
  const third = f.image({ chatId: 'group:3', buf: png(5, 3) })
  assert.throws(() => s.analyze(f.args(s, third)), code('BUDGET_EXHAUSTED'))
  // A pure cache hit consumes no additional model budget.
  await f.run(s, f.image({ chatId: 'group:3' }))
  assert.equal(f.calls.length, 2)
  const fresh = await f.reopen()
  assert.equal(fresh.status({ chatId: same.chatId }).budget.used, 2)
  f.advance(86_400_000); await f.run(fresh, third)
  assert.equal(f.calls.length, 3)
})

test('queued work cannot overspend reserved budget after another job finishes', async (t) => {
  const f = fixture(t, { maxCallsPerDay: 1 }), s = f.create(), a = f.image(), b = f.image({ buf: png(3, 3) })
  s.analyze(f.args(s, a)); s.analyze(f.args(s, b))
  await s.tick(); await s.tick()
  assert.equal(f.calls.length, 1)
  assert.deepEqual([s.get(a).status, s.get(b).status].sort(), ['failed', 'ready'])
})

test('interval and queue capacity also apply to manual requests; waiting consumes no call', async (t) => {
  const f = fixture(t, { minIntervalMs: 5000, maxQueue: 1 }), s = f.create(), a = f.image(), b = f.image({ buf: png(3, 3) }), c = f.image({ buf: png(4, 3) })
  s.analyze(f.args(s, a))
  assert.throws(() => s.analyze(f.args(s, b)), code('QUEUE_FULL'))
  await s.tick(); s.analyze(f.args(s, b)); await s.tick()
  assert.equal(s.jobs({ status: 'waiting_input' }).length, 1); assert.equal(f.calls.length, 1)
  assert.throws(() => s.analyze(f.args(s, c)), code('QUEUE_FULL'))
  f.advance(5000); await s.tick(); assert.equal(f.calls.length, 2)
})

test('strict revisions fence concurrent edits; tombstones persist and never remove raw bytes', async (t) => {
  const f = fixture(t), s = f.create(), im = f.image(), old = f.args(s, im)
  s.analyze(old)
  assert.throws(() => s.disable(old), code('REVISION_CONFLICT'))
  let item = s.disable(f.args(s, im))
  assert.equal(item.status, 'disabled'); assert.equal(existsSync(f.storage.assets.pathOf(im.asset)), true)
  const fresh = await f.reopen()
  assert.equal(fresh.visible(im), null); assert.equal(fresh.get(im).status, 'disabled')
  assert.throws(() => fresh.analyze(f.args(fresh, im)), code('NOT_READY'))
  item = fresh.restore(f.args(fresh, im)); assert.equal(item.status, 'unanalysed')
  f.cfg.mediaMemory.autoAnalyze = true; f.cfg.mediaMemory.autoChats = ['group:1']
  await fresh.tick(); assert.equal(f.calls.length, 0) // Restore never implicitly authorizes a fresh paid call.
  await f.run(fresh, im); assert.equal(fresh.visible(im).status, 'ready')
  assert.throws(() => fresh.disable({ ...im }), code('REVISION_REQUIRED'))
  assert.equal(readFileSync(f.storage.assets.pathOf(im.asset)).equals(PNG), true)
})

test('disabled feature still allows human edits; disable/restore retains private edits across SQLite reopen without calls', async (t) => {
  const f = fixture(t, { enabled: false }), s = f.create(), im = f.image(), other = f.image({ chatId: 'group:2' })
  f.storage.occurrences.ready(im.occurrenceId, im.asset.id, { anotherModule: { caption: '保留' } })
  const result = { version: 1, description: '人工说明必须可恢复', ocr: 'PRIVATE-HUMAN-739' }
  const saved = s.analyze({ ...f.args(s, im), analysis: result }).item
  assert.equal(saved.status, 'ready'); assert.equal(saved.revision, 1)
  const disabled = s.disable(f.args(s, im))
  assert.equal(disabled.revision, 2); assert.equal(disabled.result, null)
  assert.equal(s.visible(im), null)
  assert.equal('disabledHuman' in disabled, false)
  assert.equal(JSON.stringify(s.list({ chatId: im.chatId })).includes(result.ocr), false)
  assert.deepEqual(f.storage.occurrences.get(im.occurrenceId).analysis, { anotherModule: { caption: '保留' } })
  const fresh = await f.reopen()
  // Human edits do not belong to a model version or a transient conversation epoch.
  f.cfg.roles.vision.model = 'different'; f.storage.epochs.bump(im.chatId)
  const restored = fresh.restore(f.args(fresh, im))
  assert.equal(restored.revision, 3); assert.equal(restored.status, 'ready'); assert.equal(restored.coverage, 'human')
  assert.deepEqual(restored.result, result); assert.deepEqual(fresh.visible(im).result, result)
  assert.equal(restored.jobId, null); assert.equal('disabledHuman' in restored, false)
  assert.deepEqual(f.storage.occurrences.get(im.occurrenceId).analysis.mediaMemory.result, result)
  assert.deepEqual(f.storage.occurrences.get(im.occurrenceId).analysis.anotherModule, { caption: '保留' })
  assert.equal(fresh.get(other).result, null)
  assert.throws(() => fresh.restore({ ...im, expectedRevision: disabled.revision }), code('REVISION_CONFLICT'))
  fresh.disable(f.args(fresh, im)); assert.deepEqual(fresh.restore(f.args(fresh, im)).result, result)
  await fresh.tick()
  assert.equal(f.calls.length, 0); assert.equal(fresh.jobs().length, 0)
  assert.equal(readFileSync(f.storage.assets.pathOf(im.asset)).equals(PNG), true)
  assert.equal(f.storage.db.get("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'media-analysis:%:cache:%'").n, 0)
})

for (const change of ['message', 'asset']) {
  test(`restoring human text does not resurrect an edit after its ${change} changes`, async (t) => {
    const f = fixture(t, { enabled: false }), s = f.create(), im = f.image()
    s.analyze({ ...f.args(s, im), analysis: RESULT }); s.disable(f.args(s, im))
    if (change === 'message') f.storage.db.run('UPDATE messages SET text = ? WHERE id = ?', '新的消息上下文', im.messageId)
    else {
      const replacement = f.storage.assets.put(png(4, 4), { mime: 'image/png' })
      f.storage.occurrences.ready(im.occurrenceId, replacement.id)
    }
    const restored = s.restore(f.args(s, im))
    assert.equal(restored.status, 'unanalysed'); assert.equal(restored.result, null)
    assert.equal(s.visible(im), null); assert.equal(f.storage.occurrences.get(im.occurrenceId).analysis.mediaMemory, undefined)
    assert.equal(f.calls.length, 0)
  })
}

for (const change of ['recall', 'expiry', 'blocked author']) {
  test(`human restore stays disabled when the source is invalidated by ${change}`, async (t) => {
    const f = fixture(t, { enabled: false }), s = f.create(), im = f.image()
    s.analyze({ ...f.args(s, im), analysis: RESULT }); s.disable(f.args(s, im))
    if (change === 'recall') f.storage.db.run('UPDATE messages SET recalled_at = ? WHERE id = ?', f.now(), im.messageId)
    if (change === 'expiry') f.advance(31 * 86_400_000)
    if (change === 'blocked author') f.cfg.mediaMemory.blockedAuthors = ['alice']
    assert.throws(() => s.restore(f.args(s, im)), code('SOURCE_WITHDRAWN'))
    assert.equal(s.get(im).status, 'disabled'); assert.equal(s.get(im).result, null)
    assert.equal(s.visible(im), null); assert.equal(f.calls.length, 0)
  })
}

test('restoring a model result stays unanalysed even with cached output and automatic mode enabled', async (t) => {
  const f = fixture(t, { autoAnalyze: true, autoChats: ['group:1'] }), s = f.create(), im = f.image()
  await f.run(s, im)
  assert.equal(s.get(im).coverage, 'static'); assert.equal(f.calls.length, 1)
  s.disable(f.args(s, im))
  f.cfg.mediaMemory.modelVersion = 'new-version'
  const restored = s.restore(f.args(s, im))
  assert.equal(restored.status, 'unanalysed'); assert.equal(restored.result, null)
  assert.equal(f.storage.occurrences.get(im.occurrenceId).analysis.mediaMemory, undefined)
  await s.tick(); assert.equal(f.calls.length, 1)
})

test('legacy disabled records without a saved human edit cannot invent or recover deleted text', async (t) => {
  const f = fixture(t, { enabled: false }), s = f.create(), im = f.image()
  s.analyze({ ...f.args(s, im), analysis: RESULT }); s.disable(f.args(s, im))
  const stored = f.storage.db.all("SELECT key,value FROM meta WHERE key LIKE 'media-analysis:%:occ:%'")[0]
  const prior = JSON.parse(stored.value); delete prior.disabledHuman
  f.storage.meta.set(stored.key, prior)
  const restored = s.restore(f.args(s, im))
  assert.equal(restored.status, 'unanalysed'); assert.equal(restored.result, null); assert.equal(f.calls.length, 0)
})

test('disabling during an unresolved model call blocks late writes and preserves other analysis namespaces', async (t) => {
  const f = fixture(t), s = f.create(), im = f.image(), late = deferred()
  f.storage.occurrences.ready(im.occurrenceId, im.asset.id, { anotherModule: { caption: '保留' } })
  f.ask.run = () => late.promise
  s.analyze(f.args(s, im)); const tick = s.tick(); await until(() => f.calls.length === 1)
  s.disable(f.args(s, im)); await tick
  late.resolve(JSON.stringify(RESULT)); await new Promise((r) => setImmediate(r))
  assert.equal(s.get(im).status, 'disabled')
  assert.deepEqual(f.storage.occurrences.get(im.occurrenceId).analysis, { anotherModule: { caption: '保留' } })
  assert.equal(f.storage.db.get("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'media-analysis:%:cache:%'").n, 0)
})

for (const kind of ['recall', 'text edit', 'scope', 'account', 'epoch', 'model', 'config']) {
  test(`source/identity guard rejects late result after ${kind}`, async (t) => {
    const f = fixture(t), s = f.create(), im = f.image(), late = deferred()
    f.ask.run = () => late.promise
    s.analyze(f.args(s, im)); const tick = s.tick(); await until(() => f.calls.length === 1)
    if (kind === 'recall') f.storage.db.run('UPDATE messages SET recalled_at = ? WHERE id = ?', f.now(), im.messageId)
    if (kind === 'text edit') f.storage.db.run('UPDATE messages SET text = ? WHERE id = ?', '已改', im.messageId)
    if (kind === 'scope') f.storage.db.run('UPDATE asset_occurrences SET scope_json = ? WHERE id = ?', JSON.stringify({ account: 'bot', chat: 'group:2', category: 'image' }), im.occurrenceId)
    if (kind === 'account') f.cfg.botQQ = 'changed'
    if (kind === 'epoch') f.storage.epochs.bump(im.chatId)
    if (kind === 'model') f.cfg.roles.vision.model = 'new-model'
    if (kind === 'config') f.cfg.mediaMemory.enabled = false
    late.resolve(JSON.stringify(RESULT)); await tick
    assert.equal(f.storage.occurrences.get(im.occurrenceId).analysis.mediaMemory, undefined)
    assert.equal(f.storage.db.get("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'media-analysis:%:cache:%'").n, 0)
    assert.equal(f.storage.db.get("SELECT state FROM jobs WHERE kind = 'media-analysis'").state, 'unknown')
  })
}

test('source visibility is checked again on every read, without leaking descriptions after recall', async (t) => {
  const f = fixture(t), s = f.create(), im = f.image()
  await f.run(s, im)
  f.storage.db.run('UPDATE messages SET recalled_at = ? WHERE id = ?', f.now(), im.messageId)
  assert.equal(s.visible(im), null)
  const row = s.list({ chatId: im.chatId })[0]
  assert.equal(row.result, null); assert.equal(row.chatNote, ''); assert.equal(row.status, 'unavailable')
  assert.equal(f.storage.occurrences.get(im.occurrenceId).analysis.mediaMemory, undefined)
  assert.throws(() => s.get({ ...im, chatId: 'group:2' }), code('SCOPE_FORBIDDEN'))
})

test('GIF is needs_frames without vision calls; explicit human explanation is occurrence-local and free', async (t) => {
  const f = fixture(t, { maxCallsPerDay: 0 }), s = f.create(), im = f.image({ buf: GIF, mime: 'image/gif' })
  await f.run(s, im)
  assert.equal(s.get(im).status, 'needs_frames'); assert.equal(s.get(im).result, null)
  assert.equal(f.calls.length, 0); assert.equal(s.visible(im), null)
  f.cfg.mediaMemory.enabled = false
  const result = { version: 1, description: '人工看过整段动画后的说明', ocr: '' }
  const out = s.analyze({ ...f.args(s, im), analysis: result })
  assert.equal(out.job, null); assert.equal(out.item.coverage, 'human')
  assert.equal(s.visible(im).result.description, result.description)
  const copy = f.image({ buf: GIF, mime: 'image/gif', chatId: 'group:2' })
  assert.equal(s.get(copy).result, null)
  assert.equal(f.storage.db.get("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'media-analysis:%:cache:%'").n, 0)
})

test('bad bytes, hash mismatches and pixel/byte limits fail before any model call', async (t) => {
  const f = fixture(t), s = f.create()
  const bad = f.image({ buf: PNG.subarray(0, 12) })
  await f.run(s, bad); assert.equal(s.get(bad).status, 'failed')
  const mismatch = f.image({ buf: png(3, 3) })
  writeFileSync(f.storage.assets.pathOf(mismatch.asset), png(3, 3, 10))
  await f.run(s, mismatch); assert.equal(s.get(mismatch).status, 'failed')
  f.cfg.mediaMemory.maxPixels = 4
  const large = f.image({ buf: png(4, 4) }); await f.run(s, large)
  assert.equal(s.get(large).status, 'failed')
  f.cfg.mediaMemory.maxBytes = 10
  const oversized = f.image(); assert.throws(() => s.analyze(f.args(s, oversized)), code('TOO_LARGE'))
  assert.equal(f.calls.length, 0); assert.equal(s.status().budget.used, 0)
})

test('timeout and invalid responses remain unknown with no automatic retry, bounded wait and budget accounting', async (t) => {
  const f = fixture(t, { timeoutMs: 20, retryBackoffMs: 5000, autoAnalyze: true, autoChats: ['group:1'] }), s = f.create(), im = f.image()
  const late = deferred(); f.ask.run = () => late.promise
  await s.tick(); assert.equal(s.get(im).status, 'unknown')
  assert.equal(s.status().budget.used, 1)
  await s.tick(); await s.tick(); assert.equal(f.calls.length, 1)
  assert.throws(() => s.analyze(f.args(s, im)), code('INVALID_STATE'))
  assert.throws(() => s.retry(f.args(s, im)), code('BACKOFF'))
  late.resolve(JSON.stringify(RESULT)); await new Promise((r) => setImmediate(r)); assert.equal(s.get(im).result, null)
  f.advance(5000); f.ask.run = async () => '{"description":"missing contract"}'
  s.retry(f.args(s, im)); await s.tick()
  assert.equal(s.get(im).status, 'unknown'); assert.equal(f.calls.length, 2)
  f.advance(5000); f.ask.run = async () => JSON.stringify(RESULT)
  s.retry(f.args(s, im)); await s.tick()
  assert.equal(s.get(im).status, 'ready'); assert.equal(s.status().budget.used, 3)
})

test('queued jobs resume across a real SQLite reopen; interrupted submissions never auto-resubmit', async (t) => {
  const f = fixture(t), s = f.create(), im = f.image()
  s.analyze(f.args(s, im)); const fresh = await f.reopen()
  await fresh.tick(); assert.equal(fresh.get(im).status, 'ready'); assert.equal(f.calls.length, 1)
  const another = f.image({ buf: png(3, 3) }), pending = deferred()
  f.ask.run = () => pending.promise; fresh.analyze(f.args(fresh, another))
  const tick = fresh.tick(); await until(() => f.calls.length === 2)
  const recovered = await f.reopen(); await tick
  assert.equal(recovered.get(another).status, 'unknown')
  await recovered.tick(); assert.equal(f.calls.length, 2)
  pending.reject(new Error('late disconnected rejection')); await new Promise((r) => setImmediate(r))
  assert.equal(recovered.get(another).result, null)
})

test('internal materialization acknowledgement recovers without any extra model call', async (t) => {
  const f = fixture(t), s = f.create(), im = f.image(), out = await f.run(s, im)
  f.storage.db.run("UPDATE jobs SET state = 'delivery_pending', not_before = 9000000000000000, finished_at = NULL WHERE id = ?", out.job.id)
  const fresh = await f.reopen(); await fresh.tick()
  assert.equal(fresh.jobs()[0].status, 'succeeded'); assert.equal(f.calls.length, 1)
})

test('cache and record counts are bounded; record pressure does not evict disabled tombstones', async (t) => {
  const f = fixture(t, { maxItems: 2, maxCacheEntries: 1 }), s = f.create(), a = f.image(), b = f.image({ buf: png(3, 3) })
  await f.run(s, a); await f.run(s, b)
  assert.equal(f.storage.db.get("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'media-analysis:%:cache:%'").n, 1)
  s.disable(f.args(s, a))
  const c = f.image({ buf: png(4, 3) })
  assert.throws(() => s.get(c), code('ITEM_CAPACITY'))
  await s.tick(); assert.equal(s.get(a).status, 'disabled')
  assert.equal(f.calls.length, 2)
})

test('scope/source filtering excludes self, recalled, wrong account and expired media before queueing', async (t) => {
  const f = fixture(t), s = f.create()
  for (const options of [{ authorId: 'bot' }, { account: 'other' }, { extra: { eventKind: 'out' } },
    { extra: { receivedAt: f.now() - 31 * 86_400_000 } }, { extra: { forwards: [{ message: 'forwarded origin' }] } }]) {
    const im = f.image(options)
    assert.throws(() => s.get(im), (e) => ['SOURCE_WITHDRAWN', 'SCOPE_FORBIDDEN'].includes(e.code))
  }
  const valid = f.image(); await s.tick()
  assert.equal(s.list({ chatId: valid.chatId }).length, 1); assert.equal(f.calls.length, 0)
})

test('module API methods, current account, revisions, bounded lists and event chatId are wired', async (t) => {
  const f = fixture(t), routes = new Map(), events = new Map(), timers = [], disposers = []
  const service = f.track(mediaModule.setup({ config: () => f.cfg, ask: f.deps().ask,
    core: { storage: f.storage, http: { query: (r) => r.query || {}, body: async (r) => r.body || {} } },
    route: (path, fn) => routes.set(path, fn), on: (name, fn) => events.set(name, fn), every: (_ms, fn) => timers.push(fn), onDispose: (fn) => disposers.push(fn), log: { warn() {} } }))
  const call = (path, method, input = {}) => routes.get('/media-memory/' + path)({ method, [method === 'GET' ? 'query' : 'body']: input })
  const im = f.image()
  events.get('activity')({ kind: 'in', msg: { chatId: im.chatId }, account: 'bot' })
  assert.equal((await call('items', 'GET')).code, 'SCOPE_REQUIRED')
  assert.equal((await call('items', 'GET', { chatId: im.chatId, account: 'other' })).code, 'SCOPE_FORBIDDEN')
  assert.equal((await call('analyze', 'GET')).code, 'METHOD_NOT_ALLOWED')
  assert.equal((await call('analyze', 'POST', im)).code, 'REVISION_REQUIRED')
  const listed = await call('items', 'GET', { chatId: im.chatId, limit: 999 })
  assert.equal(listed.items.length, 1)
  const args = { ...im, expectedRevision: listed.items[0].revision }
  assert.equal((await call('analyze', 'POST', args)).ok, true)
  await timers[0]()
  assert.equal((await call('jobs', 'GET', { chatId: im.chatId })).jobs[0].status, 'succeeded')
  assert.equal((await call('status', 'GET')).budget.used, 1)
  assert.equal((await call('jobs/status', 'GET')).transportAbortSupported, false)
  assert.equal((await call('disable', 'POST', f.args(service, im))).item.status, 'disabled')
  assert.equal((await call('restore', 'POST', f.args(service, im))).item.status, 'unanalysed')
  assert.equal(service.schema.properties.enabled.default, false)
  f.cfg.mediaMemory.autoAnalyze = true; f.cfg.mediaMemory.autoChats = ['group:1']
  events.get('config')()
  const incoming = f.image({ buf: png(3, 3), extra: { receivedAt: Date.now() } })
  events.get('activity')({ kind: 'in', msg: { chatId: incoming.chatId }, account: 'bot' })
  await timers[0]()
  assert.equal(service.get(incoming).status, 'ready')
  for (const dispose of disposers) await dispose()
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createStorage } from '../src/storage/index.js'
import { createMediaAnalysis, parseMediaAnalysis, parseModelMediaAnalysis } from '../src/runtime/media-analysis.js'
import { askModel, observeModelUsage } from '../src/core/llm.js'
import { createUsageLedger } from '../src/diagnostics/usage.js'
import { PNG } from './helpers/images.js'

const RESULT = { version: 1, description: '蓝色方块', ocr: '可见文字' }
const GIF = Buffer.from('R0lGODdhAgADAIEAAFB43AAAAAAAAAAAACwAAAAAAgADAAAIBgABCBwYEAA7', 'base64')
const invalid = (error) => error.code === 'INVALID_RESULT'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-media-budget-'))
  const storage = createStorage({ file: join(dir, 'data.sqlite'), filesDir: join(dir, 'assets') })
  const cfg = { botQQ: 'bot', ownerQQ: 'owner', allow: { groups: ['1'] },
    roles: { vision: { provider: 'local-mock', model: 'media-budget' } },
    mediaMemory: { enabled: true, minIntervalMs: 0, autoAnalyze: true, autoChats: ['group:1'] } }
  const behavior = { text: JSON.stringify(RESULT), finish: 'stop', minTokens: 0, frames: null }
  const requests = [], streams = [], samples = [], services = []
  const dsh = { get: () => null, attachments: { admitPromptContent: async content => content }, llm: {
    resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
    async *stream(options) {
      streams.push(options)
      const exhausted = options.maxTokens < behavior.minTokens
      yield { type: 'reasoning-delta', text: 'synthetic private reasoning' }
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: exhausted ? options.maxTokens : 4000 } }
      yield { type: 'text-delta', text: exhausted ? '{"version":' : behavior.text }
      yield { type: 'finish', reason: exhausted ? 'max-tokens' : behavior.finish }
    },
  } }
  const ledger = createUsageLedger({ storage, getAccount: () => cfg.botQQ })
  const unsubscribe = observeModelUsage(dsh, e => ledger.record(e))
  const create = () => {
    const s = createMediaAnalysis({ storage, dsh, getConfig: () => cfg,
      ask: options => { requests.push(options); return askModel(dsh, { ...options, cfg }) },
      sampleFrames: async options => { samples.push(options); return { ok: true, frames: behavior.frames, sampling: { complete: false } } },
    })
    services.push(s); return s
  }
  const service = create()
  const image = (animated = false) => {
    const chatId = 'group:1'
    const msg = storage.messages.ingest({ account: 'bot', chatId, authorId: 'alice', eventKind: 'message', text: 'local-only context' })
    const occurrenceId = storage.occurrences.add({ messageId: msg.id, chatId, authorId: 'alice', segIndex: 0, kind: 'image', scope: { account: 'bot', chat: chatId, category: 'image' } })
    const asset = storage.assets.put(animated ? GIF : PNG, { mime: animated ? 'image/gif' : 'image/png' })
    storage.occurrences.ready(occurrenceId, asset.id)
    return { chatId, occurrenceId }
  }
  t.after(async () => {
    for (const s of services) await s.stop()
    unsubscribe(); storage.close()
    const abs = resolve(dir)
    assert.ok(abs.startsWith(resolve(tmpdir()) + sep) && abs.includes('aurabot-media-budget-'))
    rmSync(abs, { recursive: true, force: true })
  })
  return { storage, cfg, behavior, dsh, requests, streams, samples, service, create, image,
    async run(im) { service.analyze({ ...im, expectedRevision: service.get(im).revision }); await service.tick() },
  }
}

test('model field bounds are strict and reject oversized text without truncating; human annotation keeps its contract', () => {
  const boundary = { version: 1, description: '图'.repeat(400), ocr: '字'.repeat(2000) }
  assert.deepEqual(parseModelMediaAnalysis(JSON.stringify(boundary)), boundary)
  assert.deepEqual(parseModelMediaAnalysis('```json\n' + JSON.stringify(boundary) + '\n```'), boundary)
  for (const value of [{ ...RESULT, description: '图'.repeat(401) }, { ...RESULT, ocr: '字'.repeat(2001) },
    { ...RESULT, description: '😀'.repeat(201) }, { ...RESULT, frames: [] }, { error: 'OUTPUT_LIMIT_EXCEEDED' }]) {
    assert.throws(() => parseModelMediaAnalysis(JSON.stringify(value)), invalid)
  }
  const human = { version: 1, description: '图'.repeat(1600), ocr: '字'.repeat(8000) }
  assert.deepEqual(parseMediaAnalysis(human), human)
})

// Audit job_01m63eh4pqf0awr4c393ht / aa46ed16-359e-44af-8200-2a85f9a6afa8:
// 3000 output tokens and max-tokens, one incident. This deterministic local
// stream demonstrates shared-budget handling, not a live-model quality claim.
test('reasoning plus final JSON has more headroom than the observed 3000-token cap', async (t) => {
  const f = fixture(t); f.behavior.minTokens = 4000
  await assert.rejects(askModel(f.dsh, { cfg: f.cfg, role: 'vision', text: 'mock baseline', maxTokens: 3000,
    scope: { account: 'bot', chat: 'group:1' }, callId: 'synthetic-3000-baseline' }), e => e.code === 'MODEL_INCOMPLETE')
  const im = f.image(); await f.run(im)
  assert.deepEqual(f.streams.map(o => o.maxTokens), [3000, 8000])
  assert.equal(f.requests[0].maxOutputChars, 20_000)
  assert.equal(f.service.get(im).status, 'ready'); assert.deepEqual(f.service.get(im).result, RESULT)
  assert.equal(f.service.status().budget.used, 1)
  assert.match(f.requests[0].system, /description 最多400字符，ocr最多2000字符/)
  assert.match(f.requests[0].system, /所有图片合计/); assert.match(f.requests[0].system, /OUTPUT_LIMIT_EXCEEDED/)
  assert.equal(JSON.stringify(f.requests).includes('local-only context'), false)
})

test('a length finish remains unknown even with valid JSON and the larger budget; recovery never recharges', async (t) => {
  const f = fixture(t); f.behavior.finish = 'max-tokens'
  const im = f.image(); await f.run(im)
  assert.equal(f.requests[0].maxTokens, 8000)
  assert.equal(f.service.get(im).status, 'unknown'); assert.equal(f.service.get(im).result, null)
  assert.equal(f.service.jobs()[0].errorKind, 'unknown'); assert.equal(f.service.jobs()[0].attempts, 1)
  assert.equal(f.storage.db.get('SELECT error_code FROM service_calls').error_code, 'MODEL_INCOMPLETE')
  await f.service.stop()
  const recovered = f.create(); await recovered.tick(); await recovered.tick()
  assert.equal(recovered.get(im).status, 'unknown'); assert.equal(f.streams.length, 1)
  assert.equal(recovered.status().budget.used, 1)
})

for (const [name, text, errorCode] of [
  ['description', JSON.stringify({ ...RESULT, description: '图'.repeat(401) }), 'INVALID_RESULT'],
  ['OCR', JSON.stringify({ ...RESULT, ocr: '字'.repeat(2001) }), 'INVALID_RESULT'],
  ['explicit limit refusal', '{"error":"OUTPUT_LIMIT_EXCEEDED"}', 'INVALID_RESULT'],
  ['extra frames field', JSON.stringify({ ...RESULT, frames: Array(6).fill('frame') }), 'INVALID_RESULT'],
  ['huge streamed output', 'x'.repeat(20_001), 'MODEL_OUTPUT_TOO_LARGE'],
]) {
  test(`${name} cannot become a truncated success, cache entry or automatic retry`, async (t) => {
    const f = fixture(t); f.behavior.text = text
    const im = f.image(); await f.run(im); await f.service.tick(); await f.service.tick()
    assert.equal(f.service.get(im).status, 'unknown'); assert.equal(f.service.get(im).result, null)
    assert.equal(f.service.jobs()[0].errorKind, 'unknown'); assert.equal(f.service.jobs()[0].attempts, 1)
    if (errorCode === 'INVALID_RESULT') {
      assert.equal(f.storage.db.get('SELECT status FROM service_calls').status, 'success')
      assert.match(f.storage.db.get('SELECT error FROM jobs').error, /结构或长度上限/)
    } else assert.equal(f.storage.db.get('SELECT error_code FROM service_calls').error_code, errorCode)
    assert.equal(f.storage.db.get("SELECT COUNT(*) n FROM meta WHERE key LIKE 'media-analysis:%:cache:%'").n, 0)
    assert.equal(f.streams.length, 1); assert.equal(f.service.status().budget.used, 1)
  })
}

test('six sampled frames share one description/OCR budget and retain partial coverage', async (t) => {
  const f = fixture(t)
  f.behavior.frames = Array.from({ length: 6 }, (_, i) => ({ bytes: PNG, mime: 'image/png', atMs: i * 500 }))
  const im = f.image(true); await f.run(im)
  assert.equal(f.samples[0].maxFrames, 6); assert.equal(f.requests[0].images.length, 6)
  assert.match(f.requests[0].system, /最多6帧合并/); assert.match(f.requests[0].system, /重复出现的相同文字只转录一次/)
  assert.match(f.requests[0].text, /未覆盖完整动画/)
  assert.equal(f.service.get(im).coverage, 'sampled_partial'); assert.equal(f.service.get(im).status, 'ready')
  assert.equal(f.streams.length, 1)
})

for (const frames of [[], Array.from({ length: 7 }, (_, i) => ({ bytes: PNG, mime: 'image/png', atMs: i })),
  [{ bytes: PNG, mime: 'image/png', atMs: NaN }]]) {
  test(`invalid sampled frame set (${frames.length}) fails before spending model budget`, async (t) => {
    const f = fixture(t); f.behavior.frames = frames
    const im = f.image(true); await f.run(im); await f.service.tick()
    assert.equal(f.service.get(im).status, 'failed'); assert.equal(f.service.jobs()[0].errorKind, 'invalid')
    assert.match(f.storage.db.get('SELECT error FROM jobs').error, /最多6帧/)
    assert.equal(f.streams.length, 0); assert.equal(f.service.status().budget.used, 0)
  })
}

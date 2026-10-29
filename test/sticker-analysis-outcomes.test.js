import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createStorage } from '../src/storage/index.js'
import { createStickerStore } from '../src/stickers/store.js'
import { parseAnalysis } from '../src/stickers/analysis.js'
import { observeModelUsage } from '../src/core/llm.js'
import { createUsageLedger } from '../src/diagnostics/usage.js'
import { PNG } from './helpers/images.js'

const ADMIN = { admin: true, chatId: 'group:1' }
const answer = (extra = {}) => ({ version: 'sticker-analysis-v1', policyVersion: '1', name: '开心猫',
  description: '小猫微笑', ocr: '你好', tags: ['开心'], emotions: ['开心'], suitable: ['问候'], unsuitable: ['严肃通知'],
  decision: 'approve', reason: '静态图用途明确', ...extra })
const invalid = (error) => error.code === 'INVALID_ANALYSIS'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-sticker-outcomes-'))
  const storage = createStorage({ file: join(dir, 'data.sqlite'), filesDir: join(dir, 'assets') })
  const cfg = { botQQ: '100', ownerQQ: '200', dryRun: true, model: { provider: 'local-mock', model: 'sticker-outcomes' },
    stickers: { enabled: true, collect: true, caption: true, autoReview: false } }
  const behavior = { text: JSON.stringify(answer()), finish: 'stop', tokens: 1249, beforeReply: null }
  const calls = [], events = [], stores = []
  const dsh = { get: () => null, attachments: { admitPromptContent: async (content) => content }, llm: {
    resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
    async *stream(options) {
      calls.push(options)
      await behavior.beforeReply?.()
      yield { type: 'text-delta', text: behavior.text }
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: behavior.tokens } }
      yield { type: 'finish', reason: behavior.finish }
    },
  } }
  const ledger = createUsageLedger({ storage, getAccount: () => cfg.botQQ })
  const unsubscribe = observeModelUsage(dsh, (event) => { events.push(event); ledger.record(event) })
  const create = () => {
    const s = createStickerStore({ storage, dsh, getConfig: () => cfg, autoStart: false,
      download: async () => PNG, onebot: { call: () => assert.fail('QQ must not be called') } })
    stores.push(s); return s
  }
  const store = create()
  const segment = { type: 'image', data: { sub_type: 1, file: 'base64://' + PNG.toString('base64'), summary: 'PRIVATE-HINT' } }
  const message = storage.messages.ingest({ account: '100', chatId: 'group:1', authorId: '200', platformMsgId: '1', segments: [segment] })
  const source = { accountId: '100', chatId: 'group:1', messageId: message.id, segmentIndex: 0 }
  t.after(() => {
    stores.forEach(s => s.stop()); unsubscribe(); storage.close()
    const abs = resolve(dir)
    assert.ok(abs.startsWith(resolve(tmpdir()) + sep) && abs.includes('aurabot-sticker-outcomes-'))
    rmSync(abs, { recursive: true, force: true })
  })
  return { storage, cfg, behavior, calls, events, store, source, create,
    async run() { assert.equal((await store.collect(segment, source)).ok, true); await store.drain() },
    task: () => store.queueStatus({ ...ADMIN, kind: 'analyze' }).items[0],
    item: () => store.list(ADMIN).items[0],
    row: () => storage.db.get('SELECT * FROM service_calls'),
  }
}

test('sticker JSON accepts only a whole single JSON fence, preserving its schema', () => {
  const json = JSON.stringify(answer())
  for (const value of [answer(), json, '  ```json\n' + json + '\n```\n', '```JSON\r\n' + json + '\r\n```', '```\n' + json + '\n```']) {
    assert.deepEqual(parseAnalysis(value, '1'), answer())
  }
  for (const value of ['说明\n' + json, json + '\n说明', '说明\n```json\n' + json + '\n```',
    '```json\n' + json + '\n```\n说明', '```json\n' + json, '```json\n' + json.slice(0, -1) + '\n```',
    '```json\n' + json + '\n```\n```json\n' + json + '\n```', '```javascript\n' + json + '\n```']) {
    assert.throws(() => parseAnalysis(value, '1'), invalid)
  }
  for (const extra of [{ version: 'other' }, { policyVersion: '2' }, { decision: 'yes' }, { description: '' },
    { description: 'x'.repeat(4001) }, { ocr: 'x'.repeat(4001) }, { ocr: [] }, { name: 'x'.repeat(81) },
    { reason: 'x'.repeat(2001) }, { tags: Array(13).fill('x') }, { emotions: [1] }, { suitable: [''] }, { unsuitable: null }]) {
    assert.throws(() => parseAnalysis('```json\n' + JSON.stringify(answer(extra)) + '\n```', '1'), invalid)
  }
})

test('fenced model result settles the same service call as success without adding usage', async (t) => {
  const f = fixture(t)
  f.behavior.text = '```json\n' + JSON.stringify(answer()) + '\n```'
  await f.run()
  assert.equal(f.item().analysis.state, 'done'); assert.equal(f.task().state, 'done')
  const row = f.row()
  assert.equal(row.id, f.task().id + ':1'); assert.equal(row.operation_id, f.item().id)
  assert.equal(row.status, 'success'); assert.equal(row.business_status, 'success'); assert.equal(row.business_error, '')
  assert.equal(row.output_tokens, 1249); assert.equal(row.attempts, 1)
  assert.equal(f.storage.db.get('SELECT COUNT(*) n FROM service_calls').n, 1)
  assert.equal(f.events.filter(e => e.phase === 'business').length, 1)
  assert.equal(JSON.stringify(f.events).includes('PRIVATE-HINT'), false)
  assert.equal(JSON.stringify(f.events).includes(PNG.toString('base64')), false)
})

// Audit stj_ae036f28-db19-4a07-8f9f-a59fb4f2e3cc: transport success,
// 1249 output tokens, INVALID_ANALYSIS, but no business outcome. Raw text was
// not retained; these are synthetic boundary samples, not a replay of that text.
for (const [name, text] of [['non-JSON', '这不是 JSON'], ['invalid schema', JSON.stringify(answer({ ocr: [] }))]]) {
  test(`${name} preserves billed transport evidence and records failed business outcome`, async (t) => {
    const f = fixture(t); f.behavior.text = text
    await f.run(); await f.store.drain(); await f.store.drain()
    assert.equal(f.task().state, 'failed'); assert.equal(f.task().outcome, 'completed'); assert.equal(f.task().attempts, 1)
    assert.equal(f.item().analysis.state, 'failed')
    assert.equal(f.row().status, 'success'); assert.equal(f.row().business_status, 'failed')
    assert.equal(f.row().business_error, 'INVALID_ANALYSIS'); assert.equal(f.row().id, f.task().id + ':1')
    assert.equal(f.row().output_tokens, 1249); assert.equal(f.calls.length, 1)
    assert.equal(f.storage.db.get('SELECT COUNT(*) n FROM service_calls').n, 1)
  })
}

test('source invalidation after model completion is a business failure', async (t) => {
  const f = fixture(t)
  f.behavior.beforeReply = () => f.storage.db.run('UPDATE messages SET recalled_at=? WHERE id=?', Date.now(), f.source.messageId)
  await f.run()
  assert.equal(f.task().state, 'failed'); assert.equal(f.row().status, 'success')
  assert.equal(f.row().business_status, 'failed'); assert.equal(f.row().business_error, 'INVALID_SOURCE')
})

test('valid but stale model result is discarded rather than reported as business success', async (t) => {
  const f = fixture(t)
  f.behavior.beforeReply = () => { f.cfg.stickers.policyVersion = '2' }
  await f.run()
  assert.equal(f.task().state, 'canceled'); assert.equal(f.row().status, 'success')
  assert.equal(f.row().business_status, 'discarded'); assert.equal(f.row().business_error, 'STALE_ANALYSIS')
})

test('incomplete paid response stays unknown across store recovery and cannot be retried automatically', async (t) => {
  const f = fixture(t)
  f.behavior.finish = 'max-tokens'; f.behavior.tokens = 3000
  await f.run()
  const task = f.task(), item = f.item()
  assert.equal(task.state, 'unknown'); assert.equal(task.outcome, 'unknown'); assert.equal(task.attempts, 1)
  assert.equal(f.row().status, 'failed'); assert.equal(f.row().business_status, 'failed')
  assert.equal(f.row().business_error, 'MODEL_INCOMPLETE'); assert.equal(f.row().output_tokens, 3000)
  f.store.stop()
  const recovered = f.create(); recovered.recover(); await recovered.drain(); await recovered.drain()
  assert.equal(recovered.get(item.id, ADMIN).analysis.state, 'unknown')
  assert.equal(recovered.retryAnalysis(item.id, ADMIN).code, 'ANALYSIS_UNKNOWN')
  assert.equal(recovered.retryTask(task.id, ADMIN).code, 'NOT_RETRYABLE')
  assert.equal(f.calls.length, 1); assert.equal(f.storage.db.get('SELECT COUNT(*) n FROM service_calls').n, 1)
})

test('UI availability and selection reject a missing source message even while the library asset remains', async (t) => {
  const f = fixture(t); f.cfg.stickers.caption = false
  await f.run()
  const item = f.item()
  assert.equal(f.store.edit(item.id, { name: '开心猫', tags: ['开心'] }, ADMIN).ok, true)
  assert.equal(f.store.approve(item.id, ADMIN).ok, true)
  const before = f.store.get(item.id, ADMIN)
  assert.equal(before.availability, 'ready'); assert.ok(f.store.match('开心', 'group:1'))
  f.storage.db.run('DELETE FROM messages WHERE id=?', f.source.messageId)
  assert.equal(f.storage.messages.get(f.source.messageId), null)
  assert.equal(f.storage.assets.get(item.assetId).state, 'stored')
  assert.equal(f.store.list(ADMIN).total, 1)
  assert.equal(f.item().availability, 'unavailable')
  assert.equal(f.store.get(item.id, ADMIN).availability, 'unavailable')
  assert.equal(f.store.get(item.id, ADMIN).revision, before.revision, 'read-only decoration must not rewrite library data')
  assert.equal(f.store.match('开心', 'group:1'), null)
  assert.deepEqual(f.store.selectForReply('开心', 'group:1').candidateIds, [])
  assert.equal(f.store.segmentFor(before, 'group:1'), null, 'stale UI objects cannot bypass source validation')
  assert.equal(f.calls.length, 0)
})

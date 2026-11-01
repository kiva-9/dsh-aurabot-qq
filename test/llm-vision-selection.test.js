import { test } from 'node:test'
import assert from 'node:assert/strict'
import { askModel, clearVisionCache, clearReasoningCache } from '../src/core/llm.js'

function fixture() {
  clearVisionCache(); clearReasoningCache()
  const calls = [], admissions = []
  const dsh = {
    get: name => name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'global', model: 'text' }) } : null,
    attachments: { admitPromptContent: async content => { admissions.push(content); return content } },
    llm: {
      resolveModelInfo: async (_provider, model) => ({ inputModalities: model === 'visual' ? ['text', 'image'] : ['text'] }),
      async *stream(options) { calls.push(options); yield { type: 'text-delta', text: 'ok' }; yield { type: 'finish', reason: 'stop' } },
    },
  }
  const run = (cfg, more = {}) => askModel(dsh, { cfg, role: 'stickerDecision', text: 'choose or skip',
    images: [{ data: 'AA==', mediaType: 'image/png' }], ...more })
  return { calls, admissions, run }
}

test('the global visual override preserves image input for a proxy model reporting text-only metadata', async () => {
  const f = fixture()
  assert.equal(await f.run({ model: { provider: 'global', model: 'text', vision: 'on' } }), 'ok')
  assert.equal(f.calls.length, 1); assert.equal(f.admissions.length, 1)
  assert.equal(f.calls[0].messages[0].content[1].type, 'image')
})

test('a global visual opt-out blocks the same model even when metadata advertises images', async () => {
  const f = fixture()
  await assert.rejects(f.run({ model: { provider: 'global', model: 'visual', vision: 'off' } }), { code: 'NO_VISION' })
  assert.equal(f.calls.length, 0); assert.equal(f.admissions.length, 0)
})

test('an independently selected text-only model cannot inherit a different global visual override', async () => {
  const f = fixture()
  await assert.rejects(f.run({ model: { provider: 'global', model: 'visual', vision: 'on' },
    roles: { stickerDecision: { provider: 'other', model: 'text' } } }), { code: 'NO_VISION' })
  assert.equal(f.calls.length, 0); assert.equal(f.admissions.length, 0)
})

test('an independent visual role still works when the global model has vision disabled', async () => {
  const f = fixture()
  assert.equal(await f.run({ model: { provider: 'global', model: 'text', vision: 'off' },
    roles: { stickerDecision: { provider: 'other', model: 'visual' } } }), 'ok')
  assert.equal(f.calls[0].provider, 'other'); assert.equal(f.calls[0].model, 'visual')
})

test('provider identity matters even when two models have the same name', async () => {
  const f = fixture()
  await assert.rejects(f.run({ model: { provider: 'global', model: 'text', vision: 'on' },
    roles: { stickerDecision: { provider: 'other', model: 'text' } } }), { code: 'NO_VISION' })
  assert.equal(f.calls.length, 0)
})

test('host default model and an explicit role selecting that same model both honor the global declaration', async () => {
  const f = fixture()
  assert.equal(await f.run({ model: { vision: 'on' } }), 'ok')
  assert.equal(await f.run({ model: { provider: 'global', model: 'text', vision: 'on' },
    roles: { stickerDecision: { provider: 'global', model: 'text' } } }), 'ok')
  assert.equal(f.calls.length, 2)
})

test('automatic visual detection still rejects text-only models and leaves text calls unaffected', async () => {
  const f = fixture(), cfg = { model: { provider: 'global', model: 'text', vision: 'auto' } }
  await assert.rejects(f.run(cfg), { code: 'NO_VISION' })
  assert.equal(await f.run(cfg, { images: [] }), 'ok')
  assert.equal(f.calls.length, 1); assert.equal(f.admissions.length, 0)
})

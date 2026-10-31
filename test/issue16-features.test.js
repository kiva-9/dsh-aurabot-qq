import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { resolveShape } from '../src/image/shapes.js'
import { decidePurpose } from '../src/purpose/decision.js'
import { createImagePreparer } from '../src/runtime/image-prepare.js'
import { png } from './helpers/images.js'

test('shapes obey provider capabilities and explicit conflicts', () => {
  assert.equal(resolveShape('竖图', '', ['1024x1024', '832x1216']), '832x1216')
  assert.throws(() => resolveShape('横图', '768x1024', []), /冲突/)
  assert.throws(() => resolveShape('方图', '', ['768x1024']), /不支持/)
})
test('purpose decisions honour mode, idle, quota and cooldown', () => {
  const x = { enabled: true, mode: 'purpose', idleMs: 600000, idleMinutes: 5, now: 1000000, minIntervalMinutes: 5, count: 0, maxPerDay: 2 }
  assert.equal(decidePurpose(x).act, true)
  for (const patch of [{ mode: 'ordinary' }, { muted: true }, { idleMs: 1 }, { count: 2 }, { lastAt: 999999 }]) assert.equal(decidePurpose({ ...x, ...patch }).act, false)
})
test('image preparation validates bytes and rejects oversized inputs without decoding', async () => {
  let called = false
  const prepare = createImagePreparer({ spawnProcess: () => { called = true; throw new Error('unexpected') } })
  const source = png(64, 64, 1)
  const out = await prepare({ bytes: source })
  assert.equal(out.derived, false); assert.deepEqual(out.bytes, source)
  await assert.rejects(prepare({ bytes: Buffer.alloc(32 * 1024 * 1024 + 1) }))
  await assert.rejects(prepare({ bytes: Buffer.from('bad') }))
  assert.equal(called, false)
})

test('high-resolution compact image is locally resized within the output bound', async t => {
  if (spawnSync('ffmpeg', ['-version'], { windowsHide: true }).error) return t.skip('ffmpeg unavailable')
  const prepare = createImagePreparer()
  const source = png(2500, 1000, 2)
  const result = await prepare({ bytes: source })
  assert.equal(result.derived, true)
  assert.equal(result.width, 2048)
  assert.ok(result.height <= 2048 && result.bytes.length <= 4 * 1024 * 1024)
})

test('gallery excludes other accounts, chats, actors, personas and undelivered jobs', async () => {
  const { canUseArtwork, artworkList, resolveArtwork } = await import('../src/image/gallery.js')
  const scope = { account: '20', chatId: 'group:1', actorId: '10', personaId: 'fish' }
  const job = { id: 'art-1', kind: 'image', state: 'delivered', chatId: 'group:1', actorId: '10', input: { accountId: '20', persona: { personaId: 'fish' }, prompt: 'cat' }, output: { assetIds: ['asset'] } }
  assert.equal(canUseArtwork(job, scope), true)
  for (const patch of [{ account: '21' }, { chatId: 'group:2' }, { actorId: '11' }, { personaId: 'other' }]) assert.equal(canUseArtwork(job, { ...scope, ...patch }), false)
  assert.equal(canUseArtwork({ ...job, state: 'unknown' }, scope), false)
  assert.deepEqual(artworkList([job], scope).map(x => x.id), ['art-1:asset'])
  assert.equal(resolveArtwork('art-1:asset', () => job, scope).assetId, 'asset')
  assert.equal(resolveArtwork('art-1:other', () => job, scope), null)
  assert.equal(resolveArtwork('art-1:asset', () => job, { ...scope, personaId: 'other' }), null)
})

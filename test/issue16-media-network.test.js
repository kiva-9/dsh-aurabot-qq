import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { fetchImage, segmentBytes, setMediaHttpForTests } from '../src/core/net.js'
import { createStorage } from '../src/storage/index.js'
import { createMediaResolver } from '../src/runtime/media.js'
import { png } from './helpers/images.js'

test('raw segment paths are not local authority; opaque IDs can resolve trusted gateway cache', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-gateway-media-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'cache.png')
  writeFileSync(file, Buffer.from('cache'))
  const calls = []
  const onebot = { call: async (action, args) => { calls.push({ action, args }); return { file } } }
  await assert.rejects(fetchImage(file))
  await assert.rejects(segmentBytes({ data: { file } }, onebot))
  await assert.rejects(segmentBytes({ data: { file: `file://${file.replaceAll('\\', '/')}` } }, onebot))
  assert.equal(calls.length, 0, 'a gateway must not be asked to echo untrusted paths')
  assert.equal((await segmentBytes({ data: { file: 'opaque-id.png' } }, onebot)).toString(), 'cache')
  assert.equal(calls.length, 1)
  await assert.rejects(segmentBytes({ data: { file: 'opaque-id.png' } }, onebot, { allowLocal: false }))
  assert.equal((await fetchImage(file, { allowLocal: true })).toString(), 'cache')
})

test('media download options cannot disable public policy or remove the resource bound', async t => {
  const seen = []
  setMediaHttpForTests({ read: async (url, opts) => { seen.push({ url, opts }); return { body: Buffer.from('ok') } } })
  t.after(() => setMediaHttpForTests(null))
  const result = await fetchImage('https://public.example/image', { publicOnly: false, maxRedirects: 999,
    retries: 999, headers: { authorization: 'secret' }, maxBytes: 100 })
  assert.equal(result.toString(), 'ok')
  assert.equal(seen[0].opts.publicOnly, undefined)
  assert.equal(seen[0].opts.headers, undefined)
  assert.equal(seen[0].opts.maxRedirects, 4)
  assert.equal(seen[0].opts.retries, 0)
  await assert.rejects(fetchImage('base64://' + Buffer.alloc(101).toString('base64'), { maxBytes: 100 }))
  await assert.rejects(fetchImage('base64://YQ==', { maxBytes: Infinity }))
  await assert.rejects(fetchImage('base64://YQ==', { maxBytes: 32 * 1024 * 1024 + 1 }))
})

test('thumbnail bytes are transient, lineage is bounded, and the original asset stays intact', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-thumbnails-'))
  const storage = createStorage({ file: ':memory:', filesDir: dir })
  t.after(() => { storage.close(); rmSync(dir, { recursive: true, force: true }) })
  const original = png(5, 5), thumbnail = png(2, 2)
  const source = storage.assets.put(original, { mime: 'image/png' })
  const message = storage.messages.ingest({ account: 'bot', chatId: 'group:1', eventKind: 'message', authorId: 'user', text: '图' })
  const occurrenceId = storage.occurrences.add({ messageId: message.id, chatId: 'group:1', authorId: 'user', segIndex: 0, kind: 'image', scope: { account: 'bot', chat: 'group:1', category: 'image' } })
  storage.occurrences.ready(occurrenceId, source.id)
  const media = createMediaResolver({ storage, prepare: async () => ({ bytes: thumbnail, mime: 'image/png', width: 2, height: 2, derived: true }) })
  const image = { assetId: source.id, occurrenceId, mediaType: 'image/png', data: original.toString('base64') }
  for (let i = 0; i < 3; i++) {
    const result = await media.prepareForModel(image, { account: 'bot', chatId: 'group:1' })
    assert.equal(result.originalAssetId, source.id)
    assert.deepEqual(Buffer.from(result.data, 'base64'), thumbnail)
  }
  assert.equal(storage.db.get('SELECT COUNT(*) AS n FROM assets').n, 1)
  const manifests = storage.db.all('SELECT * FROM image_derivative_manifest')
  assert.equal(manifests.length, 1)
  assert.equal(manifests[0].state, 'transient')
  assert.equal(manifests[0].source_asset_id, source.id)
  assert.equal(manifests[0].derivative_sha256, createHash('sha256').update(thumbnail).digest('hex'))
  assert.deepEqual(await fetchImage(storage.assets.pathOf(source), { allowLocal: true }), original)
  media.dispose()
})

test('an image recalled while preparation is pending never becomes a model attachment', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-recalled-image-'))
  const storage = createStorage({ file: ':memory:', filesDir: dir })
  t.after(() => { storage.close(); rmSync(dir, { recursive: true, force: true }) })
  const source = storage.assets.put(png(4, 4), { mime: 'image/png' })
  const message = storage.messages.ingest({ account: 'bot', chatId: 'group:1', eventKind: 'message', authorId: 'user', text: '图' })
  const occurrenceId = storage.occurrences.add({ messageId: message.id, chatId: 'group:1', authorId: 'user', segIndex: 0, kind: 'image', scope: { account: 'bot', chat: 'group:1', category: 'image' } })
  storage.occurrences.ready(occurrenceId, source.id)
  let entered, release
  const started = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
  const media = createMediaResolver({ storage, prepare: async () => { entered(); await gate; return { bytes: png(2, 2), mime: 'image/png', width: 2, height: 2, derived: true } } })
  const work = media.prepareForModel({ assetId: source.id, occurrenceId }, { account: 'bot', chatId: 'group:1' })
  await started
  storage.db.run('UPDATE messages SET recalled_at=? WHERE id=?', Date.now(), message.id)
  release()
  await assert.rejects(work, /来源已撤回/)
  assert.equal(storage.db.get('SELECT COUNT(*) AS n FROM assets').n, 1)
  media.dispose()
})

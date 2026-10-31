import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorage } from '../src/storage/index.js'
import { createBili } from '../src/bili/duty.js'
import { frameTimes } from '../src/bili/frames.js'

test('B站取帧绑定范围，取消后不写截图或调用视觉模型', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-vision-'))
  const storage = createStorage({ file: join(dir, 'db'), filesDir: join(dir, 'assets') })
  t.after(() => { storage.close(); rmSync(dir, { recursive: true, force: true }) })
  const cfg = { enabled: true, botQQ: '100', ownerQQ: '200', bili: { enabled: true, cookie: '', visionEnabled: true, visionFrames: 2 }, modules: {} }
  const scope = { account: '100', chat: 'private:200', persona: 'p' }, snap = { personaId: 'p' }
  const hub = { personaFor: () => snap, scopeFor: chat => ({ ...scope, chat }) }
  const message = storage.messages.ingest({ account: '100', chatId: scope.chat, authorId: '200', platformMsgId: '1', segments: [] })
  const request = storage.requests.create({ chatId: scope.chat, actorId: '200', sourceMessageIds: [message.id] })
  const input = { scope, personaSnapshot: snap, actorId: '200', requestId: request.id, epoch: request.epoch }
  const api = { view: async () => ({ bvid: 'BV1bbbbbbbbb', aid: 1, cid: 9, duration: 12 }), playurl: async () => ({ url: 'https://example.test/video' }) }
  let describes = 0, invalidate = false
  const b = createBili({ getConfig: () => cfg, hub, storage, api, downloadVideo: async () => Buffer.from('video'),
    extractFrame: async () => { if (invalidate) storage.epochs.bump(scope.chat); return Buffer.from([0xff, 0xd8, 0xff]) },
    describeImages: async ({ images }) => { describes++; assert.equal(images.length, 2); return '帧描述' } })
  assert.deepEqual(frameTimes(12, 2), [4, 8])
  const first = await b.vision('BV1bbbbbbbbb', input)
  assert.equal(first.ok, true); assert.equal(first.screenshots.length, 2); assert.equal(describes, 1)
  assert.equal(b.panelScreenshots({ chat: scope.chat, persona: 'other' }).length, 0)
  assert.equal(b.panelScreenshots({ chat: scope.chat, persona: 'p' }).length, 2)
  invalidate = true
  const canceled = await b.vision('BV1bbbbbbbbb', input)
  assert.equal(canceled.ok, false); assert.equal(describes, 1)
  assert.equal(b.panelScreenshots({ chat: scope.chat, persona: 'p' }).length, 2)
  b.stop()
})

function scopedFixture(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bili-scoped-'))
  const storage = createStorage({ file: join(dir, 'db'), filesDir: join(dir, 'assets') })
  const cfg = { enabled: true, botQQ: '100', ownerQQ: '200', bili: { enabled: true, cookie: 'cookie-a', visionEnabled: true, visionFrames: 3, ffmpegPath: 'configured-ffmpeg' }, modules: {} }
  const scope = { account: '100', chat: 'private:200', persona: 'p' }, snap = { personaId: 'p' }
  const hub = { personaFor: () => snap, scopeFor: chat => ({ ...scope, chat }), sendImageAssets: async (_chat, _ids, _note, opts) => ({ delivered: opts.shouldSend() ? 1 : 0 }) }
  const message = storage.messages.ingest({ account: '100', chatId: scope.chat, authorId: '200', platformMsgId: '1', segments: [] })
  const request = storage.requests.create({ chatId: scope.chat, actorId: '200', sourceMessageIds: [message.id] })
  const input = { scope, personaSnapshot: snap, actorId: '200', requestId: request.id, epoch: request.epoch }
  const api = { view: async () => ({ bvid: 'BV1bbbbbbbbb', aid: 1, cid: 9, title: '视频', duration: 15,
    pages: [{ cid: 9, page: 1, duration: 15, part: '第一P' }, { cid: 10, page: 2, duration: 15, part: '第二P' }] }) }
  const b = createBili({ getConfig: () => cfg, hub, storage, api, ...extra })
  t.after(() => { b.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) })
  return { b, cfg, api, input, scope, snap, storage, request, message }
}

test('long multipart videos use only selected preview sprites and label actual sampled times', async t => {
  const fetched = [], cropped = [], described = []
  const f = scopedFixture(t, { downloadVideo: async (url, _signal, options) => { fetched.push({ url, ...options }); return Buffer.from('sprite') },
    cropPreview: async (_bytes, grid, options) => { cropped.push({ grid, ffmpeg: options.ffmpeg }); return Buffer.from([0xff, 0xd8, 0xff]) },
    describeImages: async x => { described.push(x); return '看到两张预览' } })
  f.api.videoShots = async info => { assert.equal(info.cid, 10); return { images: ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'], index: [0, 4, 8, 12], imgXLen: 2, imgYLen: 1 } }
  f.api.playurl = async () => assert.fail('预览可用时不下载视频流')
  const result = await f.b.vision({ link: 'BV1bbbbbbbbb', part: 2, cid: '10', times: [3, 11] }, f.input)
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(result.frames.map(x => [x.requestedSeconds, x.seconds, x.method]), [[3, 4, 'preview'], [11, 12, 'preview']])
  assert.deepEqual(fetched.map(x => x.url), ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'])
  assert.ok(fetched.every(x => x.maxBytes <= 4 * 1024 * 1024))
  assert.deepEqual(cropped.map(x => x.grid.index), [1, 1]); assert.ok(cropped.every(x => x.ffmpeg === 'configured-ffmpeg'))
  assert.equal(described[0].info.part, 2)
  const row = f.b.panelScreenshots({ chat: f.scope.chat, persona: 'p' })[0]
  assert.equal(JSON.parse(row.source).part, 2)
  assert.ok(f.b.panelScreenshot({ id: row.id, chat: f.scope.chat, persona: 'p' }).bytes.length)
  assert.equal(f.b.panelScreenshot({ id: row.id, chat: f.scope.chat, persona: 'other' }), null)
  assert.equal((await f.b.sendScreenshot(row.id, f.input)).ok, true)
  assert.equal((await f.b.vision({ link: 'BV1bbbbbbbbb', part: 2, cid: '9', times: [1] }, f.input)).code, 'INVALID_INPUT')
  assert.equal((await f.b.vision({ link: 'https://www.bilibili.com/video/BV1bbbbbbbbb?p=1', part: 2, times: [1] }, f.input)).code, 'INVALID_INPUT')
})

test('multi-segment fallback downloads only target segments within a shared budget', async t => {
  const reads = [], seconds = []
  const f = scopedFixture(t, { downloadVideo: async (url, _signal, options) => { reads.push({ url, ...options }); return Buffer.from('segment') },
    extractFrame: async (_bytes, sec, options) => { seconds.push([sec, options.ffmpeg]); return Buffer.from([0xff, 0xd8, 0xff]) },
    describeImages: async () => '采样' })
  f.api.playurl = async () => ({ segments: [1, 2, 3].map(n => ({ url: `https://cdn.example/${n}`, length: 5000 })) })
  const result = await f.b.vision({ link: 'BV1bbbbbbbbb', part: 2, times: [2, 7, 12] }, f.input)
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(reads.map(x => x.url), ['https://cdn.example/1', 'https://cdn.example/2', 'https://cdn.example/3'])
  assert.ok(reads.every(x => x.maxBytes <= 20 * 1024 * 1024))
  assert.deepEqual(seconds, [[2, 'configured-ffmpeg'], [2, 'configured-ffmpeg'], [2, 'configured-ffmpeg']])
  assert.deepEqual(result.frames.map(x => x.seconds), [2, 7, 12])
})

test('screenshot work fails closed when credential or evidence changes during a download', async t => {
  let release, started; const waiting = new Promise(r => { release = r }), entered = new Promise(r => { started = r })
  let described = 0
  const f = scopedFixture(t, { downloadVideo: async () => { started(); await waiting; return Buffer.from('segment') },
    extractFrame: async () => Buffer.from([0xff, 0xd8, 0xff]), describeImages: async () => { described++; return '不应调用' } })
  f.api.playurl = async () => ({ url: 'https://cdn.example/v' })
  const pending = f.b.vision('BV1bbbbbbbbb', f.input)
  await entered; f.cfg.bili.cookie = 'cookie-b'; release()
  assert.equal((await pending).code, 'BILI_CANCELED')
  assert.equal(described, 0); assert.equal(f.b.panelScreenshots({ chat: f.scope.chat, persona: 'p' }).length, 0)
})

test('a revision change to the same persona or a recalled request cancels screenshot work', async t => {
  for (const change of ['persona', 'recall']) await t.test(change, async t => {
    let release, enter; const waiting = new Promise(r => { release = r }), started = new Promise(r => { enter = r })
    let described = 0
    const f = scopedFixture(t, { downloadVideo: async () => { enter(); await waiting; return Buffer.from('segment') },
      extractFrame: async () => Buffer.from([0xff, 0xd8, 0xff]), describeImages: async () => { described++; return '不应调用' } })
    f.api.playurl = async () => ({ url: 'https://cdn.example/v' })
    const pending = f.b.vision('BV1bbbbbbbbb', f.input); await started
    if (change === 'persona') f.snap.revision = 2
    else f.storage.messages.markRecalled(f.scope.chat, '1')
    release()
    assert.equal((await pending).code, 'BILI_CANCELED'); assert.equal(described, 0)
  })
})

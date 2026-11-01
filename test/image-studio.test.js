import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync, inflateSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { createStudioImages, probeStudioStatus } from '../src/providers/image/studio.js'
import { studioMaskPng } from '../src/providers/image/studio-mask.js'
import { imageInfo } from '../src/providers/image/common.js'
import { createStorage } from '../src/storage/index.js'
import { createJobRunner } from '../src/jobs/runner.js'
import { PNG, png } from './helpers/images.js'

const BASE = 'http://127.0.0.1:7860'
const ID = '0123456789abcdef0123456789abcdef'
const model = { id: 'model.safetensors', name: 'SDXL', features: ['txt2img', 'reference', 'img2img', 'edit'], reference_cfg: 4.5, prompt_hint: 'Use tags', cfg: 6 }
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const input = (role = 'base', buf = PNG) => ({ role, buf, mime: 'image/png' })
const kind = (expected, match) => error => {
  assert.equal(error.kind, expected)
  if (match) assert.match(error.message, match)
  return true
}

function fake(options = {}) {
  const calls = []
  const status = { ready: true, models: [model], queue: 0, ...options.status }
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    const path = new URL(url).pathname
    if (path === '/api/status') return options.statusResponse || json(status)
    if (path === '/api/generate') return options.generateResponse || json({ ids: [ID] })
    if (path === `/api/job/${ID}`) return options.jobResponse || json({ status: 'done', url: `/image/${ID}.png` })
    if (path === `/image/${ID}.png`) return options.imageResponse || new Response(PNG, { headers: { 'content-type': 'image/png' } })
    throw new Error(`Unexpected request: ${url}`)
  }
  const profile = { baseUrl: BASE, model: model.id, extra: {}, ...options.profile }
  return { calls, profile, fetchImpl, provider: createStudioImages(profile, { fetchImpl }) }
}

function chunk(type, data) {
  const b = Buffer.concat([Buffer.from(type), data])
  let crc = 0xffffffff
  for (const byte of b) {
    crc ^= byte
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length); b.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4)
  return out
}
const sig = Buffer.from('89504e470d0a1a0a', 'hex')
function paeth(a, b, c) {
  const p = a + b - c
  const ds = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)]
  return [a, b, c][ds.indexOf(Math.min(...ds))]
}
function maskFixture(color = 6, { filters = [0, 1, 2, 3, 4], badFilter = false, trailing = false, depth = 8, interlace = 0, extra = [] } = {}) {
  const width = 3, height = filters.length, bpp = color === 6 ? 4 : 2
  const pixels = Array.from({ length: height }, (_, y) => Array.from({ length: width * bpp }, (_, i) => i % bpp === bpp - 1 ? [0, 128, 255][(y + Math.floor(i / bpp)) % 3] : (y * 71 + i * 23) % 256))
  const rows = pixels.map((row, y) => {
    const filter = filters[y], previous = pixels[y - 1] || []
    return Buffer.from([badFilter && !y ? 5 : filter, ...row.map((value, i) => {
      const a = i >= bpp ? row[i - bpp] : 0, b = previous[i] || 0, c = i >= bpp ? previous[i - bpp] || 0 : 0
      const v = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter]
      return (value - v + 256) % 256
    })])
  })
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = depth; header[9] = color; header[12] = interlace
  const compressed = deflateSync(Buffer.concat(rows))
  const buffer = Buffer.concat([sig, chunk('IHDR', header), ...extra, chunk('IDAT', trailing ? Buffer.concat([compressed, Buffer.from([1, 2])]) : compressed), chunk('IEND', Buffer.alloc(0))])
  const expected = pixels.map(row => Array.from({ length: width }, (_, x) => 255 - row[x * bpp + bpp - 1]))
  return { buffer, expected, width, height }
}
function grayPixels(bytes) {
  const info = imageInfo(bytes)
  assert.equal(bytes[24], 8); assert.equal(bytes[25], 0); assert.equal(info.hasAlpha, false)
  const parts = []
  for (let p = 8; p < bytes.length;) {
    const n = bytes.readUInt32BE(p)
    if (bytes.toString('ascii', p + 4, p + 8) === 'IDAT') parts.push(bytes.subarray(p + 8, p + 8 + n))
    p += n + 12
  }
  const raw = inflateSync(Buffer.concat(parts))
  return Array.from({ length: info.height }, (_, y) => {
    const start = y * (info.width + 1)
    assert.equal(raw[start], 0)
    return [...raw.subarray(start + 1, start + 1 + info.width)]
  })
}

test('capabilities are bounded and status probe is read-only and sanitized', async () => {
  const f = fake({ profile: { apiKey: 'never send me', extra: { modes: ['reference', 'mask'], maxInputs: 2 } } })
  assert.deepEqual(f.provider.capabilities(), { modes: ['reference', 'mask'], maxInputs: 2, async: true, cancel: false, idempotent: false, sizes: [] })
  assert.deepEqual(await probeStudioStatus(f.profile, { fetchImpl: f.fetchImpl }), {
    ready: true, models: [{ id: model.id, name: model.name, features: model.features, reference_cfg: 4.5, prompt_hint: 'Use tags' }], queue: 0,
  })
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].init.method, 'GET')
  assert.equal(f.calls[0].init.redirect, 'error')
  assert.equal(f.calls[0].init.headers, undefined)
  assert.deepEqual(await f.provider.cancel(ID), { ok: false, message: 'Studio 不能安全取消单个任务；未发送全局中断' })
  assert.equal(f.calls.length, 1)
})

test('text and reference submissions map fields, preserve all reference bytes, and use model defaults', async () => {
  const f = fake({ profile: { apiKey: 'secret', extra: { denoise: 0.8, weight: 0.4 } } })
  const result = await f.provider.submit({ mode: 'text', prompt: '  原始提示词 ', negativePrompt: '', size: '768x1024', seed: 42, n: 1, inputs: [], unrelated: 'ignore' })
  assert.deepEqual(result, { status: 'running', providerTaskId: ID })
  assert.deepEqual(JSON.parse(f.calls[1].init.body), { model: model.id, mode: 'txt2img', prompt: '  原始提示词 ', count: 1, width: 768, height: 1024, seed: 42 })
  assert.deepEqual(f.calls[1].init.headers, { 'content-type': 'application/json' })
  assert.equal(f.calls[1].init.redirect, 'error')
  const refs = [input('identity', png(2, 3, 1)), input('style', png(2, 3, 2)), input('composition', png(2, 3, 3))]
  await f.provider.submit({ mode: 'reference', prompt: 'x', negativePrompt: 'bad', size: '1024x768', inputs: refs })
  const body = JSON.parse(f.calls[3].init.body)
  assert.deepEqual(Object.keys(body).sort(), ['cfg', 'count', 'height', 'mode', 'model', 'negative', 'prompt', 'references', 'weight', 'width'].sort())
  assert.equal(body.cfg, 4.5)
  assert.equal(body.weight, 0.4)
  assert.equal(body.negative, 'bad')
  assert.deepEqual(body.references, refs.map(im => `data:image/png;base64,${im.buf.toString('base64')}`))
})

test('edit and mask map to img2img and edit; transparent mask becomes white with soft edges', async () => {
  const f = fake({ profile: { extra: { denoise: 0.72, weight: 0.6 } } })
  const m = maskFixture(6, { filters: [0, 1, 2] })
  const base = input('base', png(3, 3, 4))
  await f.provider.submit({ mode: 'edit', prompt: 'x', inputs: [base] })
  assert.deepEqual(JSON.parse(f.calls[1].init.body), { model: model.id, mode: 'img2img', prompt: 'x', count: 1, denoise: 0.72, image: `data:image/png;base64,${base.buf.toString('base64')}` })
  await f.provider.submit({ mode: 'mask', prompt: 'x', inputs: [base], mask: { buf: m.buffer, mime: 'image/png' } })
  const body = JSON.parse(f.calls[3].init.body)
  assert.equal(body.mode, 'edit')
  assert.equal(body.denoise, 0.72)
  assert.deepEqual(grayPixels(Buffer.from(body.mask.split(',')[1], 'base64')), m.expected)
  assert.ok(!('weight' in body))
})

test('PNG alpha conversion handles all five filters, RGBA and grayscale-alpha', () => {
  for (const color of [4, 6]) {
    const fixture = maskFixture(color)
    assert.deepEqual(grayPixels(studioMaskPng(fixture.buffer)), fixture.expected)
  }
})

test('PNG conversion rejects unsupported or damaged encodings and empty masks', () => {
  for (const fixture of [maskFixture(6, { depth: 16 }), maskFixture(6, { interlace: 1 }), maskFixture(6, { extra: [chunk('acTL', Buffer.alloc(8))] }), maskFixture(6, { extra: [chunk('eXIf', Buffer.alloc(8))] })]) {
    assert.throws(() => studioMaskPng(fixture.buffer), kind('unsupported'))
  }
  for (const fixture of [maskFixture(6, { badFilter: true }), maskFixture(6, { trailing: true })]) assert.throws(() => studioMaskPng(fixture.buffer), kind('invalid'))
  const corrupted = Buffer.from(maskFixture().buffer); corrupted[30] ^= 1
  assert.throws(() => studioMaskPng(corrupted), kind('invalid'))
  // An empty IDAT followed by an ancillary chunk must not reopen the data stream.
  const split = maskFixture().buffer
  const splitData = Buffer.concat([split.subarray(0, 33), chunk('IDAT', Buffer.alloc(0)), chunk('tEXt', Buffer.from('key\0value')), split.subarray(33)])
  assert.throws(() => studioMaskPng(splitData), kind('invalid', /不连续/))
  assert.throws(() => studioMaskPng(png(2, 3, 255)), kind('invalid', /涂出/))
  const malformed = Buffer.concat([sig, chunk('IHDR', (() => { const h = Buffer.alloc(13); h.writeUInt32BE(20000); h.writeUInt32BE(2, 4); h[8] = 8; h[9] = 6; return h })()), chunk('IDAT', deflateSync(Buffer.alloc(1))), chunk('IEND', Buffer.alloc(0))])
  assert.throws(() => studioMaskPng(malformed), kind('invalid', /尺寸/))
})

test('request errors and unsupported capabilities are rejected before generation', async () => {
  const f = fake()
  const cases = [
    [{ mode: 'reference', prompt: 'x', inputs: [input('identity'), input('style'), input('identity'), input('composition')] }, 'unsupported'],
    [{ mode: 'edit', prompt: 'x', inputs: [input(), input('identity')] }, 'unsupported'],
    [{ mode: 'mask', prompt: 'x', inputs: [input(), input('identity')], mask: { buf: PNG } }, 'unsupported'],
    [{ mode: 'text', prompt: 'x', inputs: [], n: 2 }, 'unsupported'],
    [{ mode: 'text', prompt: '', inputs: [] }, 'invalid'],
    [{ mode: 'text', prompt: 'x', size: '257x1024', inputs: [] }, 'invalid'],
    [{ mode: 'text', prompt: 'x', seed: 1.2, inputs: [] }, 'invalid'],
    [{ mode: 'reference', prompt: 'x', inputs: [{ role: 'identity' }] }, 'invalid'],
    [{ mode: 'text', prompt: 'x', negativePrompt: false, inputs: [] }, 'invalid'],
  ]
  for (const [req, expected] of cases) await assert.rejects(f.provider.submit(req), kind(expected))
  assert.equal(f.calls.length, 0)
  for (const extra of [{ denoise: '0.8' }, { denoise: 0 }, { weight: true }, { weight: 1.6 }]) {
    const g = fake({ profile: { extra } })
    assert.throws(() => g.provider.capabilities(), kind('invalid'))
    await assert.rejects(g.provider.submit({ mode: 'text', prompt: 'x', inputs: [] }), kind('invalid'))
    assert.equal(g.calls.length, 0)
  }
  const missing = fake({ status: { models: [] } })
  await assert.rejects(missing.provider.submit({ mode: 'text', prompt: 'x', inputs: [] }), kind('unsupported', /没有模型/))
  const noRef = fake({ status: { models: [{ ...model, features: ['txt2img', 'img2img', 'edit'] }] } })
  await assert.rejects(noRef.provider.submit({ mode: 'reference', prompt: 'x', inputs: [input('identity')] }), kind('unsupported'))
  assert.equal(noRef.calls.length, 1)
  const noRefCfg = fake({ status: { models: [{ ...model, reference_cfg: undefined }] } })
  await assert.rejects(noRefCfg.provider.submit({ mode: 'reference', prompt: 'x', inputs: [input('identity')] }), kind('unsupported', /CFG/))
  const notReady = fake({ status: { ready: false, models: [] } })
  await assert.rejects(notReady.provider.submit({ mode: 'text', prompt: 'x', inputs: [] }), kind('transient', /未就绪/))
  const disabled = fake({ profile: { capabilities: { modes: ['text'] } } })
  await assert.rejects(disabled.provider.submit({ mode: 'reference', prompt: 'x', inputs: [input('identity')] }), kind('unsupported'))
  assert.equal(disabled.calls.length, 0)
})

test('mask edit rejects EXIF before network to avoid wrong-region edits', async () => {
  const fixture = maskFixture(6, { filters: [0, 1, 2] })
  const base = png(3, 3)
  const metadata = chunk('eXIf', Buffer.from('49492a0008000000000000000000', 'hex'))
  const withExif = Buffer.concat([base.subarray(0, 33), metadata, base.subarray(33)])
  const f = fake()
  await assert.rejects(f.provider.submit({ mode: 'mask', prompt: 'x', inputs: [input('base', withExif)], mask: { buf: fixture.buffer } }), kind('unsupported', /EXIF/))
  assert.equal(f.calls.length, 0)
})

test('aggregate request size is checked before image decoding or network', async () => {
  const f = fake()
  const huge = Buffer.alloc(30 * 1024 * 1024)
  await assert.rejects(f.provider.submit({ mode: 'reference', prompt: 'x', inputs: [input('identity', huge), input('style', huge)] }), kind('invalid', /总大小/))
  assert.equal(f.calls.length, 0)
})

test('base URL and result paths are strictly confined to the numeric loopback origin', async () => {
  const bad = ['', 'https://127.0.0.1:7860', 'http://localhost:7860', 'http://127.1:7860', 'http://192.168.0.1:7860', 'http://127.0.0.1', 'http://127.0.0.1:7860/prefix', 'http://127.0.0.1:7860/a/..', 'http://u:p@127.0.0.1:7860', 'http://127.0.0.1:7860/?x=1', 'http://127.0.0.1:7860/#token']
  for (const baseUrl of bad) {
    const f = fake({ profile: { baseUrl } })
    await assert.rejects(f.provider.submit({ mode: 'text', prompt: 'x', inputs: [] }), kind('invalid'))
    await assert.rejects(probeStudioStatus(f.profile, { fetchImpl: f.fetchImpl }), kind('invalid'))
    assert.equal(f.calls.length, 0)
  }
  for (const id of ['../image/x', 'https://evil.invalid/a', 'ABCDEF01234567890123456789abcdef', `${ID}?q=1`, '']) {
    const f = fake()
    await assert.rejects(f.provider.poll(id), kind('invalid'))
    assert.equal(f.calls.length, 0)
  }
  for (const url of [`http://evil.invalid/image/${ID}.png`, `//evil.invalid/image/${ID}.png`, `/image/../${ID}.png`, `/image/${ID}.png?key=leak`, `/image/${'f'.repeat(32)}.png`]) {
    const f = fake({ jobResponse: json({ status: 'done', url }) })
    await assert.rejects(f.provider.poll(ID), kind('unknown', /地址/))
    assert.equal(f.calls.length, 1)
  }
})

test('poll handles queued, running, failure, valid result, missing result and malformed output', async () => {
  for (const status of ['queued', 'running']) {
    const f = fake({ jobResponse: json({ status }) })
    assert.deepEqual(await f.provider.poll(ID), { status: 'running', providerTaskId: ID, progress: status === 'queued' ? '排队中' : '正在画' })
  }
  const failure = await fake({ jobResponse: json({ status: 'failed', error: 'CUDA error' }) }).provider.poll(ID)
  assert.equal(failure.status, 'failed'); assert.equal(failure.billing, 'unknown'); assert.match(failure.error.message, /CUDA error/)
  for (const error of ['任务已取消', ' 任务已取消 ', '', undefined]) {
    const ambiguous = fake({ jobResponse: json({ status: 'failed', error }) })
    await assert.rejects(ambiguous.provider.poll(ID), kind('unknown', /无法确认/))
    assert.equal(ambiguous.calls.length, 1)
  }
  const done = fake()
  assert.deepEqual(await done.provider.poll(ID), { status: 'done', providerTaskId: ID, billing: 'unknown', outputs: [{ buf: PNG, mime: 'image/png' }] })
  assert.ok(done.calls.every(call => call.init.redirect === 'error'))
  const missing = fake({ jobResponse: json({ error: '任务不存在' }, 404) })
  await assert.rejects(missing.provider.poll(ID), kind('unknown', /无法确认/))
  const badState = fake({ jobResponse: json({ status: 'new-state' }) })
  await assert.rejects(badState.provider.poll(ID), kind('unknown'))
  const badImage = fake({ imageResponse: new Response('not an image') })
  await assert.rejects(badImage.provider.poll(ID), kind('unknown', /PNG/))
  const largeImage = fake({ imageResponse: new Response(png(1537, 1)) })
  await assert.rejects(largeImage.provider.poll(ID), kind('unknown', /尺寸/))
})

test('ambiguous generate failures, malformed IDs, redirect, and aborted requests never permit a blind resend', async () => {
  for (const response of [json({ error: 'bad' }, 400), json({ error: 'bad' }, 502), json({ ids: [] }), json({ ids: [ID, ID] }), json({ ids: ['../bad'] }), new Response(null, { status: 307, headers: { location: 'http://evil.invalid' } })]) {
    const f = fake({ generateResponse: response })
    await assert.rejects(f.provider.submit({ mode: 'text', prompt: 'x', inputs: [] }), error => {
      assert.equal(error.kind, 'unknown'); assert.equal(error.retryable, false); assert.equal(error.maybeCharged, true); return true
    })
    assert.equal(f.calls.length, 2)
    assert.equal(f.calls[1].init.redirect, 'error')
  }
  const controller = new AbortController()
  const calls = []
  const profile = { baseUrl: BASE, model: model.id }
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    if (url.endsWith('/api/status')) return json({ ready: true, models: [model] })
    controller.abort()
    return new Promise(() => {})
  }
  await assert.rejects(createStudioImages(profile, { fetchImpl }).submit({ mode: 'text', prompt: 'x', inputs: [] }, { signal: controller.signal }), error => {
    assert.equal(error.kind, 'unknown'); assert.equal(error.retryable, false); return true
  })
  assert.equal(calls.length, 2)
  assert.ok(calls.every(call => call.init.redirect === 'error'))
  const already = new AbortController(); already.abort()
  const before = fake()
  await assert.rejects(before.provider.submit({ mode: 'text', prompt: 'x', inputs: [] }, { signal: already.signal }), kind('transient'))
  assert.equal(before.calls.length, 0)
})

test('runner keeps lost Studio jobs unknown and never submits again', async () => {
  for (const jobResponse of [{ status: 'failed', error: '任务已取消' }, null]) {
    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push({ url, method: init.method })
      if (url.endsWith('/api/status')) return json({ ready: true, models: [model] })
      if (url.endsWith('/api/generate')) return json({ ids: [ID] })
      if (url.endsWith(`/api/job/${ID}`)) return jobResponse ? json(jobResponse) : json({ error: '任务不存在' }, 404)
      throw new Error(`Unexpected request: ${url}`)
    }
    const storage = createStorage({ file: ':memory:', filesDir: tmpdir() })
    const provider = createStudioImages({ baseUrl: BASE, model: model.id }, { fetchImpl })
    const runner = createJobRunner({ storage, pollMs: 0, retryBaseMs: 0, handlers: { image: {
      prepare: async () => ({ ready: true }),
      submit: async (job, attempt, execution) => provider.submit({ mode: 'text', prompt: 'x', inputs: [] }, { signal: execution.signal }),
      poll: async (job, execution) => provider.poll(job.providerTaskId, { signal: execution.signal }),
      store: async () => assert.fail('cannot store an unknown result'),
      deliver: async () => assert.fail('cannot deliver an unknown result'),
    } } })
    try {
      const job = runner.enqueue({ kind: 'image', chatId: 'group:1', actorId: '7', input: { prompt: 'x' } })
      await runner.drain()
      assert.equal(runner.get(job.id).state, 'unknown')
      assert.equal(runner.attempts(job.id).length, 1)
      assert.equal(runner.attempts(job.id)[0].billing, 'unknown')
      assert.equal(calls.filter(call => call.url.endsWith('/api/generate')).length, 1)
      assert.equal(calls.filter(call => call.url.endsWith(`/api/job/${ID}`)).length, 21)
    } finally {
      runner.stop()
      storage.close()
    }
  }
})

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { deflateSync, gzipSync } from 'node:zlib'
import { ProviderError, request, outputFrom, imageInfo, imageMime, checkRequest, mergeCapabilities, classifyNetwork, validateHttpUrl } from '../src/providers/image/common.js'
import { PROTOCOLS, adapterFor, createLocalImages } from '../src/providers/image/index.js'

// 完整 PNG fixture，含正确的 IHDR / IDAT / IEND / CRC，不依赖生产解析器来构造。
function png(width = 2, height = 3, alpha = true) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(body.length + 8)
    let crc = 0xffffffff
    for (const b of body) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) }
    out.writeUInt32BE(data.length); body.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = alpha ? 6 : 2
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width * (alpha ? 4 : 3) + 1) * height))), chunk('IEND', Buffer.alloc(0))])
}
const PNG = png()
const WEBP = Buffer.from('UklGRlwAAABXRUJQVlA4WAoAAAAQAAAAAQAAAgAAQUxQSAcAAAAAZGRkZGRkAFZQOCAuAAAAsAEAnQEqAgADAAFAJiWgAnS6AAQwAAD+3FH/9QZ/5aH/q0P2FP/Abr4tl8AAAA==', 'base64')
const GIF = Buffer.from('R0lGODdhAgADAIEAAFB43AAAAAAAAAAAACwAAAAAAgADAAAIBgABCBwYEAA7', 'base64')
const JPG = readFileSync(new URL('../assets/dafeiyu.jpg', import.meta.url))
const caps = { modes: ['text', 'reference', 'edit', 'mask'], maxInputs: 4, async: true, cancel: true, idempotent: true, sizes: [] }
const im = (role = 'base', buf = PNG, mime = 'image/png') => ({ role, buf, mime })
const checkError = (kind, maybeCharged = false) => (e) => {
  assert.ok(e instanceof ProviderError)
  assert.equal(e.kind, kind); assert.equal(e.maybeCharged, maybeCharged)
  if (kind === 'unknown') assert.equal(e.retryable, false)
  return true
}

test('imageInfo：真实 PNG/JPEG/WebP/GIF 的尺寸；JPEG EOI 后的编辑器元数据合法', () => {
  assert.deepEqual(imageInfo(PNG), { mime: 'image/png', width: 2, height: 3, hasAlpha: true })
  assert.deepEqual(imageInfo(png(3, 4, false)), { mime: 'image/png', width: 3, height: 4, hasAlpha: false })
  assert.deepEqual(imageInfo(JPG), { mime: 'image/jpeg', width: 1272, height: 1272, hasAlpha: false })
  assert.deepEqual(imageInfo(WEBP), { mime: 'image/webp', width: 2, height: 3, hasAlpha: true })
  assert.deepEqual(imageInfo(GIF), { mime: 'image/gif', width: 2, height: 3, hasAlpha: false })
  assert.deepEqual(imageInfo(new Uint8Array(PNG)), imageInfo(PNG))
  assert.equal(imageMime(JPG), 'image/jpeg')
})

test('imageInfo：文件头伪造、缺数据/结束标记、CRC/尺寸损坏均抛 invalid', () => {
  const corrupt = Buffer.from(PNG); corrupt[16] ^= 1
  const jpegEOI = JPG.indexOf(Buffer.from([0xff, 0xd9]))
  assert.ok(jpegEOI > 0 && jpegEOI < JPG.length - 2)
  for (const b of [null, '', Buffer.alloc(12), PNG.subarray(0, 12), PNG.subarray(0, 33), PNG.subarray(0, -1), corrupt, JPG.subarray(0, jpegEOI), WEBP.subarray(0, -1), GIF.subarray(0, -1), Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(30)])]) {
    assert.throws(() => imageInfo(b), checkError('invalid'))
    assert.equal(imageMime(b), '')
  }
})

test('能力交集：空 modes 禁用、大小不能扩张/无交集不能变无限、布尔及数量只可收窄', () => {
  assert.deepEqual(mergeCapabilities(caps), caps)
  assert.deepEqual(mergeCapabilities(caps, { modes: [] }).modes, [])
  assert.deepEqual(mergeCapabilities(caps, { modes: ['text', 'bogus'] }).modes, ['text'])
  assert.equal(mergeCapabilities(caps, { maxInputs: 99 }).maxInputs, 4)
  assert.equal(mergeCapabilities(caps, { maxInputs: 0 }).maxInputs, 0)
  const narrowed = mergeCapabilities(caps, { async: false, cancel: false, idempotent: false })
  for (const key of ['async', 'cancel', 'idempotent']) assert.equal(narrowed[key], false)
  assert.equal(mergeCapabilities({ ...caps, cancel: false }, { cancel: true }).cancel, false)
  const limited = { ...caps, sizes: ['1024x1024', '1536x1024'] }
  assert.deepEqual(mergeCapabilities(limited, { sizes: ['1024x1024', '999x999'] }).sizes, ['1024x1024'])
  assert.deepEqual(mergeCapabilities(limited, { sizes: [] }).sizes, limited.sizes)
  assert.deepEqual(mergeCapabilities(limited, { sizes: ['999x999'] }).modes, [])
  const clone = mergeCapabilities(caps); clone.modes.length = 0
  assert.equal(caps.modes.length, 4)
  for (const declared of [{ maxInputs: -1 }, { maxInputs: 1.5 }, { maxInputs: null }, { maxInputs: 'bad' }, { modes: 'text' }, { sizes: [3] }, { cancel: 'false' }]) assert.throws(() => mergeCapabilities(caps, declared), checkError('invalid'))
})

test('checkRequest：角色、唯一底图、蒙版 PNG/透明通道/实际尺寸；引用预检查保持可用', () => {
  const req = { mode: 'mask', inputs: [im()], mask: im() }
  assert.equal(checkRequest(req, caps), '')
  assert.equal(checkRequest({ mode: 'mask', inputs: [{ role: 'base', assetId: 'x' }], mask: {} }, caps), '')
  for (const bad of [
    { ...req, mode: 'other' }, { ...req, inputs: {} }, { ...req, inputs: [im('wrong')] },
    { ...req, inputs: [im(), im()] }, { ...req, inputs: [im('style')] }, { ...req, mask: null },
    { ...req, mode: 'edit' }, { ...req, mask: im('base', png(4, 3)) },
    { ...req, mask: im('base', png(2, 3, false)) }, { ...req, mask: im('base', JPG, 'image/jpeg') },
    { ...req, mask: im('base', JPG, 'image/png') }, { ...req, inputs: [im('base', PNG, 'image/jpeg')] },
    { ...req, mask: im('base', PNG.subarray(0, 33)) }, { ...req, mask: 'not-an-image' },
  ]) assert.ok(checkRequest(bad, caps))
})

let server, base
let seen = 0
before(async () => {
  server = createServer((req, res) => {
    seen++
    if (req.url === '/json') { res.setHeader('content-type', 'application/json'); return res.end('{"ok":true}') }
    if (req.url === '/png') { res.setHeader('content-type', 'image/png'); return res.end(PNG) }
    if (req.url === '/length') { res.writeHead(200, { 'content-length': 1000000 }); res.flushHeaders(); return }
    if (req.url === '/chunked') { res.write(Buffer.alloc(8)); return res.end(Buffer.alloc(16)) }
    if (req.url === '/compressed') { res.setHeader('content-encoding', 'gzip'); return res.end(gzipSync(Buffer.alloc(2048))) }
    if (req.url === '/break') { res.writeHead(200, { 'content-length': 1000 }); res.write('partial'); setImmediate(() => res.destroy()); return }
    if (req.url === '/hang') { res.writeHead(200); res.flushHeaders(); return }
    res.writeHead(404); res.end('missing')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => { server.closeAllConnections(); server.close() })

test('request：非法 URL / blocked port / 本地配置在 fetch 前失败且确定未发', async () => {
  let calls = 0
  const fake = () => { calls++; throw new Error('must not fetch') }
  for (const url of ['relative', 'ftp://example.test/a', 'file:///tmp/a', 'http://', 'http://u:p@example.test/a', 'http://127.0.0.1:0/', 'http://127.0.0.1:25/', 'http://127.0.0.1:6667/', 'http://example.test:99999/']) await assert.rejects(request(fake, url), checkError('invalid'))
  for (const init of [{ method: 'BAD METHOD' }, { method: 'TRACE' }, { method: 'GET', body: 'x' }, { headers: { 'x-key': 'a\nb' } }, { redirect: 'invalid' }]) await assert.rejects(request(fake, base, init), checkError('invalid'))
  for (const opts of [{ timeoutMs: -1 }, { timeoutMs: Infinity }, { timeoutMs: 2147483648 }, { signal: {} }, { maxBytes: 0 }, { maxBytes: NaN }]) await assert.rejects(request(fake, base, {}, opts), checkError('invalid'))
  await assert.rejects(request(null, base), checkError('invalid'))
  assert.equal(calls, 0)
  assert.equal(validateHttpUrl(base).protocol, 'http:')
  assert.equal(validateHttpUrl('https://example.test:443/a').port, '')
})

test('request：原有 status/json/buf/type 返回接口，实际解压后流式大小上限', async () => {
  const r = await request(fetch, `${base}/json`)
  assert.deepEqual(r.json, { ok: true }); assert.equal(r.status, 200); assert.equal(r.ok, true)
  assert.equal(r.type, 'application/json'); assert.ok(Buffer.isBuffer(r.buf))
  const exact = await request(fetch, `${base}/png`, {}, { maxBytes: PNG.length })
  assert.deepEqual(exact.buf, PNG)
  for (const path of ['/length', '/chunked', '/compressed']) await assert.rejects(request(fetch, base + path, {}, { maxBytes: 16 }), checkError('unknown', true))
})

test('request：越界立即取消 reader，不调用无界 arrayBuffer', async () => {
  let canceled = false, pulls = 0
  const fake = async () => ({ status: 200, ok: true, headers: new Headers(), arrayBuffer() { assert.fail('不能无界读取') }, body: new ReadableStream({ pull(c) { pulls++; c.enqueue(new Uint8Array(8)) }, cancel() { canceled = true } }, { highWaterMark: 0 }) })
  await assert.rejects(request(fake, base, {}, { maxBytes: 12 }), checkError('unknown', true))
  assert.equal(canceled, true); assert.equal(pulls, 2)
})

test('request：读取断线/超时/取消都是 unknown；发送前取消是确定未发', async () => {
  await assert.rejects(request(fetch, `${base}/break`), checkError('unknown', true))
  await assert.rejects(request(fetch, `${base}/hang`, {}, { timeoutMs: 50 }), checkError('unknown', true))
  const ac = new AbortController()
  const pending = request(fetch, `${base}/hang`, {}, { signal: ac.signal })
  const timer = setTimeout(() => ac.abort(), 30)
  try { await assert.rejects(pending, checkError('unknown', true)) } finally { clearTimeout(timer) }
  const before = seen
  await assert.rejects(request(fetch, `${base}/json`, {}, { signal: ac.signal }), checkError('transient'))
  await assert.rejects(request(fetch, `${base}/json`, { signal: ac.signal }), checkError('transient'))
  assert.equal(seen, before)
  const refused = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
  assert.equal(classifyNetwork(refused).kind, 'transient')
  assert.equal(classifyNetwork(refused, { responseStarted: true }).kind, 'unknown')
})

test('outputFrom：严格元数据、base64、下载上限；无法拿到结果不谎称未计费', async () => {
  for (const item of [{ b64_json: PNG.toString('base64') }, { b64: PNG.toString('base64') }, `data:image/png;base64,${PNG.toString('base64')}`, { url: `${base}/png` }]) assert.deepEqual(await outputFrom(item), { buf: PNG, mime: 'image/png' })
  for (const item of [{ b64: PNG.subarray(0, 12).toString('base64') }, { b64: '%%%junk' }, { b64: 42 }, 'file:///tmp/x', `${base}/missing`, { b64: PNG.toString('base64') }, { url: `${base}/png` }]) await assert.rejects(outputFrom(item, { maxBytes: 16 }), checkError('unknown', true))
})

test('index：HTTP 静态登记，capability 空模式保留，本地不接受编辑或假图', async () => {
  assert.deepEqual(PROTOCOLS().sort(), ['comfyui', 'gemini', 'http', 'openai'])
  assert.deepEqual(adapterFor({ protocol: 'openai', capabilities: { modes: [] } }).caps.modes, [])
  let calls = 0
  const local = createLocalImages({ call: async () => { calls++; return null } }, { toImageBuffer: async () => PNG })
  await assert.rejects(local.submit({ mode: 'edit', inputs: [im()] }), checkError('unsupported'))
  assert.equal(calls, 0)
  assert.equal((await local.submit({ mode: 'text' })).billing, 'free')
  const bad = createLocalImages({ call: async () => null }, { toImageBuffer: async () => PNG.subarray(0, 12) })
  await assert.rejects(bad.submit({ mode: 'text' }), checkError('invalid'))
})

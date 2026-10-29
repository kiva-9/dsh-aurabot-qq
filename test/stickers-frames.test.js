import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createImageFrameSampler, sampleImageFrames, IMAGE_FRAME_LIMITS as L } from '../src/runtime/image-frames.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHn8AAAAASUVORK5CYII=', 'base64')
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const gif = count => Buffer.concat([GIF.subarray(0, 19), ...Array.from({ length: count }, () => GIF.subarray(19, -1)), Buffer.from([0x3b])])
const next = () => new Promise(resolve => setImmediate(resolve))
function mockSpawn(onInput, { closeOnKill = true } = {}) {
  const calls = []
  const spawnProcess = (executable, args, options) => {
    const c = new EventEmitter()
    Object.assign(c, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: 0, closed: false })
    c.close = (code = 0) => { if (!c.closed) { c.closed = true; c.emit('close', code) } }
    c.kill = () => { c.killed++; if (closeOnKill) queueMicrotask(() => c.close(-1)); return true }
    const input = []
    c.stdin.on('data', data => input.push(data))
    c.stdin.on('finish', () => { c.input = Buffer.concat(input); onInput?.(c, args) })
    calls.push({ executable, args, options, child: c })
    return c
  }
  return { calls, sampler: createImageFrameSampler({ spawnProcess }) }
}

test('本地取帧：严格输入/协议/编解码白名单，最多6张PNG，元数据仅声明部分覆盖', async () => {
  const f = mockSpawn((c, args) => { c.stdout.write(Buffer.concat(Array(Number(args[args.indexOf('-frames:v') + 1])).fill(PNG))); c.close() })
  const result = await f.sampler({ bytes: gif(12), mime: 'image/gif', maxFrames: 999, maxSide: 9999 })
  assert.equal(result.ok, true)
  assert.equal(result.frames.length, 6)
  assert.deepEqual(result.frames.map(f => f.frameIndex), [0, 2, 4, 7, 9, 11])
  assert.deepEqual(result.frames.map(f => f.atMs), [0, 200, 400, 700, 900, 1100])
  assert.equal(result.coverage, 'partial')
  assert.equal(result.sampling.complete, false)
  assert.ok(result.frames.every(f => f.selection === 'sampled' && f.coverage === 'partial'))
  const { args, options, child } = f.calls[0]
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true)
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe'])
  assert.equal(options.env.FFREPORT, undefined)
  assert.equal(args[args.indexOf('-i') + 1], 'pipe:0')
  assert.equal(args.at(-1), 'pipe:1')
  assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'pipe,file')
  assert.equal(args[args.indexOf('-format_whitelist') + 1], 'gif')
  assert.equal(args[args.indexOf('-codec_whitelist') + 1], 'gif')
  assert.equal(args[args.indexOf('-max_alloc') + 1], String(L.allocationBytes))
  assert.equal(args[args.indexOf('-max_pixels') + 1], String(L.canvasPixels))
  assert.equal(args[args.indexOf('-threads') + 1], '1')
  assert.equal(args[args.indexOf('-filter_buffered_frames') + 1], '8')
  assert.deepEqual(child.input, gif(12))
})

test('本地取帧：没有ffmpeg清楚返回needs_frames，不会安装或走外网fallback', async () => {
  const f = mockSpawn(c => { c.emit('error', Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' })); c.close(-2) })
  const r = await f.sampler({ bytes: GIF, mime: 'image/gif' })
  assert.deepEqual([r.ok, r.state, r.code], [false, 'needs_frames', 'FFMPEG_UNAVAILABLE'])
  assert.match(r.message, /ffmpeg.*手工/)
  assert.equal(f.calls.length, 1)
})

test('本地取帧：超大输入/画布/帧数/解码预算/时长/伪装URL在spawn前拒绝', async () => {
  const f = mockSpawn(() => assert.fail('bad input must never spawn'))
  const canvas = Buffer.from(GIF); canvas.writeUInt16LE(4096, 6)
  const pixels = gif(100); pixels.writeUInt16LE(1000, 6); pixels.writeUInt16LE(1000, 8)
  const duration = Buffer.from(GIF); duration.writeUInt16LE(4000, 23)
  for (const bytes of [Buffer.alloc(L.inputBytes + 1), canvas, pixels, duration, gif(241), Buffer.from('https://remote.invalid/a.gif'), GIF.subarray(0, -1)]) {
    const r = await f.sampler({ bytes, mime: 'image/gif' })
    assert.equal(r.state, 'needs_frames'); assert.equal(r.code, 'FRAME_INPUT_LIMIT')
  }
  assert.equal((await f.sampler({ bytes: GIF, mime: 'video/mp4' })).state, 'needs_frames')
  assert.equal(f.calls.length, 0)
})

test('本地取帧：超时杀进程，stdout/stderr超限也杀进程，不返回截断帧', async () => {
  const hung = mockSpawn()
  const timed = await hung.sampler({ bytes: GIF, mime: 'image/gif', timeoutMs: 15 })
  assert.equal(timed.code, 'FRAME_TIMEOUT'); assert.equal(hung.calls[0].child.killed, 1)
  for (const stream of ['stdout', 'stderr']) {
    const f = mockSpawn(c => c[stream].write(Buffer.alloc((stream === 'stdout' ? L.outputBytes : L.stderrBytes) + 1)))
    const r = await f.sampler({ bytes: GIF, mime: 'image/gif' })
    assert.equal(r.code, 'FRAME_OUTPUT_LIMIT'); assert.equal(f.calls[0].child.killed, 1)
    assert.equal(r.frames, undefined)
  }
})

test('本地取帧：输入已取消不spawn；进行中取消等待close后才释放解码并发槽', async () => {
  const pre = new AbortController(); pre.abort(new Error('pre-abort'))
  const f = mockSpawn(undefined, { closeOnKill: false })
  await assert.rejects(f.sampler({ bytes: GIF, mime: 'image/gif', signal: pre.signal }), /pre-abort/)
  assert.equal(f.calls.length, 0)
  const controller = new AbortController()
  const first = f.sampler({ bytes: GIF, mime: 'image/gif', signal: controller.signal })
  const rejected = assert.rejects(first, /canceled/)
  const second = f.sampler({ bytes: GIF, mime: 'image/gif' })
  const third = f.sampler({ bytes: GIF, mime: 'image/gif' })
  await next(); assert.equal(f.calls.length, 2)
  controller.abort(new Error('canceled')); await next()
  assert.equal(f.calls[0].child.killed, 1); assert.equal(f.calls.length, 2)
  f.calls[0].child.close(-1); await rejected; await next()
  assert.equal(f.calls.length, 3)
  for (const { child } of f.calls.slice(1)) { child.stdout.write(PNG); child.close() }
  assert.ok((await second).ok); assert.ok((await third).ok)
})

test('本地取帧：等待队列也有界，排队取消不会启动新进程', async () => {
  const f = mockSpawn()
  const controllers = Array.from({ length: L.concurrency + L.queued }, () => new AbortController())
  const promises = controllers.map(c => f.sampler({ bytes: GIF, mime: 'image/gif', signal: c.signal }).catch(e => e))
  await next(); assert.equal(f.calls.length, 2)
  assert.equal((await f.sampler({ bytes: GIF, mime: 'image/gif' })).code, 'FRAME_BUSY')
  controllers.forEach(c => c.abort(new Error('cleanup')))
  await Promise.all(promises)
  assert.equal(f.calls.length, 2)
})

test('本地取帧：拒绝非PNG、截断和多余帧，解码失败保持needs_frames', async () => {
  for (const output of [Buffer.from('invalid'), PNG.subarray(0, -2), Buffer.concat([PNG, PNG])]) {
    const f = mockSpawn(c => { c.stdout.write(output); c.close() })
    const r = await f.sampler({ bytes: GIF, mime: 'image/gif' })
    assert.equal(r.state, 'needs_frames'); assert.equal(r.frames, undefined)
  }
  const failed = mockSpawn(c => { c.stderr.write('unsupported codec'); c.close(1) })
  assert.equal((await failed.sampler({ bytes: GIF, mime: 'image/gif' })).code, 'FRAME_DECODE_FAILED')
})

function ffmpegAvailable() {
  try { execFileSync('ffmpeg', ['-version'], { shell: false, windowsHide: true, timeout: 5000, stdio: ['ignore', 'ignore', 'ignore'] }); return true } catch { return false }
}
const real = ffmpegAvailable()
test('本机真实ffmpeg生成横向GIF，经管道有界取样且包含不同时间的画面', { skip: !real, timeout: 30000 }, async () => {
  const bytes = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=5:duration=2',
    '-threads', '1', '-filter_threads', '1', '-vf', 'format=rgb8', '-frames:v', '10', '-f', 'gif', 'pipe:1'],
  { shell: false, windowsHide: true, timeout: 12000, maxBuffer: 3 * 1024 * 1024 })
  const r = await sampleImageFrames({ bytes, mime: 'image/gif', signal: new AbortController().signal })
  assert.equal(r.ok, true, r.message); assert.equal(r.frames.length, 6)
  assert.equal(r.sampling.sourceFrames, 10); assert.equal(r.sampling.durationMs, 2000)
  assert.deepEqual([r.frames[0].atMs, r.frames.at(-1).atMs], [0, 1800])
  assert.ok(r.frames.every(f => f.width === 384 && f.height === 216 && f.bytes.length < L.frameBytes))
  assert.equal(new Set(r.frames.map(f => createHash('sha256').update(f.bytes).digest('hex'))).size, 6)
})

test('本机真实APNG与动画WebP按声明帧序取样；临时生成文件及时清除', { skip: !real, timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-sticker-frames-'))
  try {
    for (const [mime, codec, format] of [['image/png', 'apng', 'apng'], ['image/webp', 'libwebp_anim', 'webp']]) {
      const file = join(root, 'animation.' + format)
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=80x48:rate=4:duration=1',
        '-threads', '1', '-filter_threads', '1', '-c:v', codec, '-frames:v', '4', '-f', format, file], { shell: false, windowsHide: true, timeout: 12000, maxBuffer: 100000 })
      const r = await sampleImageFrames({ bytes: readFileSync(file), mime })
      assert.equal(r.ok, true, mime + ': ' + r.message)
      assert.equal(r.frames.length, 4); assert.equal(r.coverage, 'partial')
      assert.deepEqual(r.frames.map(f => f.atMs), [0, 250, 500, 750])
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

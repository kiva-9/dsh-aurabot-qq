import { spawn } from 'node:child_process'

// Hard ceilings, independent of caller configuration. No source/output files are created.
export const IMAGE_FRAME_LIMITS = Object.freeze({
  inputBytes: 8 * 1024 * 1024, canvasSide: 2048, canvasPixels: 4 * 1024 * 1024,
  inputFrames: 240, decodedPixels: 64 * 1024 * 1024, durationMs: 30_000,
  frames: 6, side: 384, outputBytes: 4 * 1024 * 1024, frameBytes: 1024 * 1024,
  stderrBytes: 16 * 1024, allocationBytes: 64 * 1024 * 1024, timeoutMs: 12_000,
  concurrency: 2, queued: 16,
})
const L = IMAGE_FRAME_LIMITS
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const frameError = (code, message) => Object.assign(new Error(message), { code })
const rejectImage = (message) => { throw frameError('FRAME_INPUT_LIMIT', message) }
const check = (condition, message = '动画结构不完整或格式与 MIME 不符') => { if (!condition) rejectImage(message) }
const bounded = (value, fallback, ceiling) => Number.isInteger(value) && value > 0 ? Math.min(value, ceiling) : fallback

/** Read container metadata only, without decompressing pixels or following any references. */
function animationInfo(bytes, mime) {
  check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= L.inputBytes, '动画字节为空或超过 8 MB')
  let width, height, demuxer, decoder, durationMs = 0, chunks = 0
  const frames = []
  const canvas = (w, h) => {
    check(w > 0 && h > 0 && w <= L.canvasSide && h <= L.canvasSide && w * h <= L.canvasPixels, '动画画布超过 2048 边长或 4M 像素')
    width = w; height = h
  }
  const frame = (x, y, w, h, delayMs) => {
    check(width && height && w > 0 && h > 0 && x + w <= width && y + h <= height, '动画子帧超出已校验画布')
    check(frames.length < L.inputFrames && (frames.length + 1) * width * height <= L.decodedPixels, '动画超过 240 帧或 64M 累计解码像素')
    frames.push({ frameIndex: frames.length, atMs: durationMs })
    durationMs += delayMs
    check(Number.isFinite(durationMs) && durationMs <= L.durationMs, '动画单轮超过 30 秒，请人工选帧')
  }
  const chunk = () => check(++chunks <= 65_536, '动画容器块过多')
  if (mime === 'image/gif') {
    demuxer = decoder = 'gif'
    check(bytes.length >= 14 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6)))
    canvas(bytes.readUInt16LE(6), bytes.readUInt16LE(8))
    let p = 13 + ((bytes[10] & 128) ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0), delay = 100, ended = false
    const blocks = () => {
      while (true) {
        chunk(); check(p < bytes.length)
        const size = bytes[p++]; check(p + size <= bytes.length)
        p += size
        if (!size) return
      }
    }
    while (p < bytes.length) {
      chunk(); const type = bytes[p++]
      if (type === 0x3b) { ended = true; break }
      if (type === 0x21) {
        check(p < bytes.length); const label = bytes[p++]
        if (label === 0xf9) {
          check(p + 6 <= bytes.length && bytes[p] === 4 && bytes[p + 5] === 0)
          delay = (bytes.readUInt16LE(p + 2) || 10) * 10
        }
        blocks()
      } else if (type === 0x2c) {
        check(p + 9 <= bytes.length)
        frame(bytes.readUInt16LE(p), bytes.readUInt16LE(p + 2), bytes.readUInt16LE(p + 4), bytes.readUInt16LE(p + 6), delay)
        const packed = bytes[p + 8]
        p += 9 + ((packed & 128) ? 3 * (1 << ((packed & 7) + 1)) : 0)
        check(p < bytes.length && bytes[p] >= 2 && bytes[p] <= 8)
        p++; blocks(); delay = 100
      } else rejectImage('GIF 含未知容器块')
    }
    check(ended)
  } else if (mime === 'image/png') {
    demuxer = decoder = 'apng'
    check(bytes.length >= 33 && bytes.subarray(0, 8).equals(pngSignature))
    let p = 8, declared = 0, ended = false, sawData = false
    while (p + 12 <= bytes.length) {
      chunk(); const size = bytes.readUInt32BE(p), type = bytes.toString('ascii', p + 4, p + 8), start = p + 8
      check(start + size + 4 <= bytes.length)
      if (type === 'IHDR') { check(size === 13 && p === 8); canvas(bytes.readUInt32BE(start), bytes.readUInt32BE(start + 4)) }
      if (type === 'acTL') { check(size === 8); declared = bytes.readUInt32BE(start); check(declared <= L.inputFrames) }
      if (type === 'fcTL') {
        check(size === 26 && declared && (!sawData || frames.length > 0), 'APNG 默认图与动画分离，需人工选帧')
        const delay = bytes.readUInt16BE(start + 20) / (bytes.readUInt16BE(start + 22) || 100) * 1000
        frame(bytes.readUInt32BE(start + 12), bytes.readUInt32BE(start + 16), bytes.readUInt32BE(start + 4), bytes.readUInt32BE(start + 8), delay || 100)
      }
      if (type === 'IDAT') sawData = true
      p += size + 12
      if (type === 'IEND') { ended = true; break }
    }
    check(ended && sawData && declared === frames.length && declared > 0, '没有可验证的 APNG 动画帧')
  } else if (mime === 'image/webp') {
    demuxer = 'webp_anim'; decoder = 'webp,webp_anim'
    check(bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length)
    let p = 12, animated = false
    while (p + 8 <= bytes.length) {
      chunk(); const size = bytes.readUInt32LE(p + 4), type = bytes.toString('ascii', p, p + 4), start = p + 8
      check(start + size <= bytes.length)
      if (type === 'VP8X') { check(size === 10); animated = Boolean(bytes[start] & 2); canvas(bytes.readUIntLE(start + 4, 3) + 1, bytes.readUIntLE(start + 7, 3) + 1) }
      if (type === 'ANMF') {
        check(animated && size >= 16)
        frame(bytes.readUIntLE(start, 3) * 2, bytes.readUIntLE(start + 3, 3) * 2,
          bytes.readUIntLE(start + 6, 3) + 1, bytes.readUIntLE(start + 9, 3) + 1, bytes.readUIntLE(start + 12, 3) || 100)
      }
      p += 8 + size + (size & 1)
    }
    check(p === bytes.length && animated)
  } else rejectImage('自动动画取帧仅支持 GIF、APNG 和动画 WebP')
  check(frames.length > 0)
  return { width, height, frames, durationMs, demuxer, decoder }
}

function pngFrames(bytes, selected, width, height) {
  const frames = []
  let p = 0
  while (p < bytes.length) {
    const start = p
    check(frames.length < selected.length && bytes.subarray(p, p + 8).equals(pngSignature), 'ffmpeg 输出不是有界 PNG 帧序列')
    p += 8
    let ended = false, header = false
    while (p + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(p), type = bytes.toString('ascii', p + 4, p + 8)
      check(size <= L.frameBytes && p + size + 12 <= bytes.length && p + size + 12 - start <= L.frameBytes, '单帧输出超过 1 MB 或被截断')
      if (!header) {
        check(type === 'IHDR' && size === 13 && bytes.readUInt32BE(p + 8) === width && bytes.readUInt32BE(p + 12) === height, '取帧输出尺寸不符合限制')
        header = true
      }
      p += size + 12
      if (type === 'IEND') { ended = true; break }
    }
    check(ended)
    frames.push({ ...selected[frames.length], bytes: bytes.subarray(start, p), mime: 'image/png', width, height, selection: 'sampled', coverage: 'partial' })
  }
  check(frames.length === selected.length, 'ffmpeg 没有输出全部选定帧，请人工复核')
  return frames
}

function runFfmpeg(spawnProcess, executable, args, bytes, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const env = { ...process.env }; delete env.FFREPORT
    let child, failure, size = 0, stderrSize = 0, stderr = '', output = []
    const stop = (error) => {
      failure ||= error
      try { child?.stdin?.destroy(); child?.kill('SIGKILL') } catch {}
    }
    const abort = () => stop(signal.reason)
    try { child = spawnProcess(executable, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env }) } catch (error) { reject(error); return }
    signal.addEventListener('abort', abort, { once: true })
    child.once('error', error => { failure ||= error })
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') stop(error) })
    child.stdout.on('error', stop); child.stderr.on('error', stop)
    child.stdout.on('data', data => {
      size += data.length
      if (size > L.outputBytes) stop(frameError('FRAME_OUTPUT_LIMIT', '取帧输出超过 4 MB'))
      else if (!failure) output.push(data)
    })
    child.stderr.on('data', data => {
      stderrSize += data.length
      if (stderrSize > L.stderrBytes) stop(frameError('FRAME_OUTPUT_LIMIT', 'ffmpeg 诊断输出超过限制'))
      else stderr += data.toString('utf8')
    })
    // Hold the decoder slot until close, including after timeout/abort, never just until kill().
    child.once('close', code => {
      signal.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else if (code !== 0) reject(frameError('FRAME_DECODE_FAILED', 'ffmpeg 无法解码动画：' + stderr.replace(/[\r\n]+/g, ' ').slice(0, 300)))
      else resolve(Buffer.concat(output, size))
      output = []
    })
    if (signal.aborted) abort()
    else child.stdin.end(bytes)
  })
}

/** Injectable local decoder for tests. executable is trusted deployment configuration, never a URL/user path. */
export function createImageFrameSampler({ spawnProcess = spawn, executable = 'ffmpeg' } = {}) {
  let running = 0
  const waiting = []
  const release = () => {
    running--
    while (waiting.length) {
      const next = waiting.shift()
      next.signal.removeEventListener('abort', next.abort)
      if (next.signal.aborted) { next.reject(next.signal.reason); continue }
      running++; next.resolve(release); break
    }
  }
  const acquire = signal => new Promise((resolve, reject) => {
    signal.throwIfAborted()
    if (running < L.concurrency) { running++; resolve(release); return }
    if (waiting.length >= L.queued) { reject(frameError('FRAME_BUSY', '本地取帧队列已满，请稍后重试')); return }
    const item = { signal, resolve, reject, abort: () => { const i = waiting.indexOf(item); if (i >= 0) waiting.splice(i, 1); reject(signal.reason) } }
    waiting.push(item); signal.addEventListener('abort', item.abort, { once: true })
  })
  return async function sampleImageFrames({ bytes, mime, signal, maxFrames = L.frames, maxSide = L.side, timeoutMs = L.timeoutMs } = {}) {
    signal?.throwIfAborted()
    const ctrl = new AbortController(), abort = () => ctrl.abort(signal.reason)
    signal?.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(() => ctrl.abort(frameError('FRAME_TIMEOUT', '本地动画取帧超时，请人工选帧')), bounded(timeoutMs, L.timeoutMs, L.timeoutMs))
    let unlock
    try {
      const info = animationInfo(bytes, mime)
      const count = Math.min(bounded(maxFrames, L.frames, L.frames), info.frames.length)
      const selected = Array.from({ length: count }, (_, i) => info.frames[count === 1 ? 0 : Math.round(i * (info.frames.length - 1) / (count - 1))])
      const side = bounded(maxSide, L.side, L.side), ratio = Math.min(1, side / info.width, side / info.height)
      const width = Math.max(1, Math.floor(info.width * ratio)), height = Math.max(1, Math.floor(info.height * ratio))
      unlock = await acquire(ctrl.signal)
      const filter = `select='${selected.map(f => `eq(n,${f.frameIndex})`).join('+')}',scale=${width}:${height}:flags=bilinear`
      const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-max_alloc', String(L.allocationBytes),
        '-filter_threads', '1', '-filter_complex_threads', '1', '-filter_buffered_frames', '8',
        '-protocol_whitelist', 'pipe,file', '-format_whitelist', info.demuxer, '-codec_whitelist', info.decoder,
        '-f', info.demuxer, '-max_streams', '1', '-threads', '1', '-max_pixels', String(L.canvasPixels),
        '-probesize', String(L.inputBytes), '-analyzeduration', '0', '-ignore_loop', '1',
        ...(mime === 'image/gif' ? ['-min_delay', '1', '-default_delay', '10'] : []),
        ...(mime === 'image/png' ? ['-default_fps', '10'] : []),
        ...(mime === 'image/webp' ? ['-min_delay', '1', '-default_delay', '100'] : []),
        '-i', 'pipe:0', '-map', '0:v:0', '-an', '-sn', '-dn', '-t', String(L.durationMs / 1000),
        '-vf', filter, '-frames:v', String(count), '-fps_mode', 'passthrough', '-threads', '1',
        '-c:v', 'png', '-pix_fmt', 'rgb24', '-f', 'image2pipe', '-protocol_whitelist', 'pipe,file', 'pipe:1']
      const output = await runFfmpeg(spawnProcess, executable, args, bytes, ctrl.signal)
      ctrl.signal.throwIfAborted()
      return { ok: true, state: 'sampled', coverage: 'partial', frames: pngFrames(output, selected, width, height),
        sampling: { method: 'ffmpeg', selection: 'sampled', coverage: 'partial', complete: false,
          sourceMime: mime, sourceFrames: info.frames.length, durationMs: info.durationMs, sampledFrames: count } }
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      const missing = error.code === 'ENOENT'
      return { ok: false, state: 'needs_frames', code: missing ? 'FFMPEG_UNAVAILABLE' : error.code || 'FRAME_DECODE_FAILED',
        message: missing ? '本机找不到 ffmpeg，无法自动取帧；请安装 ffmpeg 或手工选择关键帧' : error.message }
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); unlock?.() }
  }
}

/** @returns sampled PNG buffers + partial evidence, or {ok:false,state:'needs_frames',code,message}. Caller abort rejects. */
export const sampleImageFrames = createImageFrameSampler()

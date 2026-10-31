import { spawn } from 'node:child_process'
import { imageSize, mimeOf } from '../chat/inbound.js'

// FFmpeg receives bounded bytes through stdin; it must never resolve URLs or files.
function decode(bytes, input, filter, { signal, ffmpeg = 'ffmpeg', timeoutMs = 15000, spawnImpl = spawn } = {}) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    let child, timer, done = false, closing = false, terminalError = null, size = 0
    const chunks = []
    const finish = (error) => {
      if (done) return
      if (error && child && !closing) {
        terminalError ||= error; clearTimeout(timer)
        try { child.kill() } catch {}
        return // Keep the caller's concurrency slot until the child closes.
      }
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted)
      if (error || terminalError) reject(terminalError || error); else resolve(Buffer.concat(chunks, size))
    }
    const aborted = () => finish(signal.reason || new Error('视频取帧已取消'))
    try {
      child = spawnImpl(ffmpeg || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-max_alloc', '67108864',
        '-threads', '1', '-protocol_whitelist', 'pipe', ...input, '-i', 'pipe:0',
        '-frames:v', '1', '-an', '-vf', filter, '-c:v', 'mjpeg', '-f', 'image2pipe', 'pipe:1'],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) { finish(e); return }
    signal?.addEventListener('abort', aborted, { once: true })
    timer = setTimeout(() => finish(new Error('视频取帧超时')), Math.max(1, Math.min(15000, timeoutMs)))
    child.on('error', finish); child.stdin.on('error', () => {}); child.stderr.resume()
    child.stdout.on('data', b => { size += b.length; if (size > 2 * 1024 * 1024) finish(new Error('视频帧过大')); else chunks.push(b) })
    child.on('close', code => { const first = chunks[0]; closing = true; finish(code || !size || first?.[0] !== 0xff || first?.[1] !== 0xd8 ? new Error('无法从有界输入解码该帧') : null) })
    if (signal?.aborted) aborted(); else child.stdin.end(bytes)
  })
}

export async function videoFrame(bytes, seconds, options = {}) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 40 * 1024 * 1024 || !Number.isFinite(seconds) || seconds < 0) throw new Error('视频输入或时间无效')
  return decode(bytes, [], `select='gte(t,${seconds})',scale=512:-2`, options)
}

/** Extract one thumbnail from a bounded Bilibili preview sprite. */
export async function previewFrame(bytes, { columns, rows, index }, options = {}) {
  const mime = mimeOf(bytes), { width, height } = imageSize(bytes)
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 4 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(mime) ||
      !Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1 || columns * rows > 100 ||
      !Number.isInteger(index) || index < 0 || index >= columns * rows || width < columns || height < rows ||
      width > 8192 || height > 8192 || width * height > 16 * 1024 * 1024 || width % columns || height % rows) throw new Error('视频预览图或网格无效')
  const w = width / columns, h = height / rows, x = (index % columns) * w, y = Math.floor(index / columns) * h
  return decode(bytes, [], `crop=${w}:${h}:${x}:${y},scale=512:-2`, options)
}

export function frameTimes(duration, count = 3) {
  if (!Number.isFinite(Number(duration)) || Number(duration) <= 0) return []
  const n = Math.max(1, Math.min(3, Math.floor(Number(count) || 1)))
  return [...new Set(Array.from({ length: n }, (_, i) => Math.max(0, Math.floor(Number(duration) * (i + 1) / (n + 1)))))]
}

/** Pick only the segment containing a sample; length is supplied in milliseconds. */
export function progressiveWindows(segments = []) {
  const out = []; let start = 0
  for (const segment of segments.slice(0, 100)) {
    const length = Number(segment?.length)
    if (!/^https?:\/\//i.test(segment?.url || '') || !Number.isFinite(length) || length <= 0) break
    out.push({ url: segment.url, start, end: start + length / 1000 }); start += length / 1000
  }
  return out
}

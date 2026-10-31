import { spawn } from 'node:child_process'
import { imageInfo } from '../providers/image/common.js'

const LIMIT = Object.freeze({ input: 32 * 1024 * 1024, pixels: 50_000_000, side: 2048, output: 4 * 1024 * 1024, timeout: 12000, concurrency: 2 })
const fail = message => Object.assign(new Error(message), { code: 'IMAGE_PREPARE_FAILED' })
const animated = (bytes, mime) => mime === 'image/gif' || (mime === 'image/png' && bytes.includes(Buffer.from('acTL'))) || (mime === 'image/webp' && bytes.includes(Buffer.from('ANIM')))

/** Local-only decoder. No external paths, protocols or runtime downloads are accepted. */
export function createImagePreparer({ spawnProcess = spawn, executable = 'ffmpeg' } = {}) {
  let active = 0
  return async function prepare({ bytes, signal } = {}) {
    signal?.throwIfAborted()
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > LIMIT.input) throw fail('原图超过 32 MB 或为空')
    const info = imageInfo(bytes)
    if (!info.width || !info.height || info.width * info.height > LIMIT.pixels) throw fail('图片超过解码像素限制')
    if (bytes.length <= LIMIT.output && Math.max(info.width, info.height) <= LIMIT.side) return { bytes, ...info, derived: false }
    if (animated(bytes, info.mime)) throw fail('动画需要保留多帧，不能自动缩成单帧')
    if (active >= LIMIT.concurrency) throw fail('图片预处理繁忙')
    active++
    try {
      const ratio = Math.min(1, LIMIT.side / info.width, LIMIT.side / info.height)
      const width = Math.max(1, Math.floor(info.width * ratio)), height = Math.max(1, Math.floor(info.height * ratio))
      const output = await new Promise((resolve, reject) => {
        let child, failure, size = 0, chunks = [], settled = false
        const stop = error => { failure ||= error; try { child?.kill('SIGKILL') } catch {} }
        const abort = () => stop(signal?.reason || fail('图片预处理已取消'))
        const timeout = setTimeout(() => stop(fail('图片预处理超时')), LIMIT.timeout)
        try {
          const env = { ...process.env }; delete env.FFREPORT
          child = spawnProcess(executable, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-max_alloc', '268435456', '-protocol_whitelist', 'pipe', '-max_pixels', String(LIMIT.pixels), '-threads', '1', '-i', 'pipe:0', '-map', '0:v:0', '-frames:v', '1', '-vf', `scale=${width}:${height}`, '-c:v', 'mjpeg', '-q:v', '4', '-f', 'image2pipe', 'pipe:1'], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env })
        } catch (error) { clearTimeout(timeout); reject(error); return }
        signal?.addEventListener('abort', abort, { once: true })
        child.once('error', error => { failure ||= error })
        child.stdin.on('error', error => { if (error.code !== 'EPIPE') stop(error) })
        child.stdout.on('error', stop)
        child.stderr.on('error', stop)
        child.stdout.on('data', part => { size += part.length; if (size > LIMIT.output) stop(fail('缩图超过大小限制')); else chunks.push(part) })
        child.stderr.resume()
        child.once('close', code => {
          if (settled) return; settled = true; clearTimeout(timeout); signal?.removeEventListener('abort', abort)
          if (failure) reject(failure); else if (code !== 0) reject(fail('图片无法解码')); else resolve(Buffer.concat(chunks, size))
          chunks = []
        })
        if (signal?.aborted) abort(); else child.stdin.end(bytes)
      })
      signal?.throwIfAborted()
      const out = imageInfo(output)
      if (out.width !== width || out.height !== height || output.length > LIMIT.output) throw fail('缩图尺寸或大小无效')
      return { bytes: output, ...out, derived: true }
    } finally { active-- }
  }
}
export const prepareImage = createImagePreparer()

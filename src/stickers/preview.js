import { spawn } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { imageSize, mimeOf } from '../chat/inbound.js'

// This preview is ephemeral and never replaces an approved source. Reuse an
// approved animation frame when present; legacy assets without one use only
// their first frame, without a new analysis or change to their review state.
const SIDE = 320, BYTES = 192 * 1024, INPUT = 5 * 1024 * 1024, CACHE = 8 * 1024 * 1024
const supported = new Set(['image/png', 'image/jpeg', 'image/webp'])

export function createDecisionPreviews({ storage, spawnProcess = spawn, executable = 'ffmpeg' }) {
  const cache = new Map()
  let cacheBytes = 0, active = 0
  const waiters = []
  const acquire = signal => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    if (active < 3) { active++; return resolve() }
    const item = { resolve: () => { signal.removeEventListener('abort', abort); active++; resolve() } }
    const abort = () => { const i = waiters.indexOf(item); if (i >= 0) waiters.splice(i, 1); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true }); waiters.push(item)
  })
  const release = () => { active--; waiters.shift()?.resolve() }
  const remember = (key, result) => {
    while (cacheBytes + result.bytes.length > CACHE && cache.size) {
      const first = cache.keys().next().value; cacheBytes -= cache.get(first).bytes.length; cache.delete(first)
    }
    cache.set(key, result); cacheBytes += result.bytes.length
  }
  return async function preview(item, signal) {
    signal.throwIfAborted()
    const frameId = item.animated ? item.frames?.find(f => f.assetId)?.assetId : null
    const id = frameId || item.assetId
    if (!id) return null
    const asset = storage.assets.get(id)
    if (!asset || asset.state !== 'stored') return null
    const cached = cache.get(id)
    if (cached) return cached
    let bytes, mime, size
    try {
      const path = storage.assets.pathOf(asset)
      if (statSync(path).size > INPUT) return null
      bytes = readFileSync(path); mime = mimeOf(bytes); size = imageSize(bytes)
    } catch { return null }
    if (!bytes.length || !size.width || !size.height || size.width > 2048 || size.height > 2048 || size.width * size.height > 4 * 1024 * 1024) return null
    const animation = (mime === 'image/png' && bytes.includes(Buffer.from('acTL'))) || (mime === 'image/webp' && bytes.includes(Buffer.from('ANIM'))) || mime === 'image/gif'
    if (frameId && animation) return null
    if (!animation && supported.has(mime) && bytes.length <= BYTES && Math.max(size.width, size.height) <= SIDE) {
      const result = { bytes, mime }; remember(id, result); return result
    }
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/gif'].includes(mime)) return null
    await acquire(signal)
    try {
      const output = await new Promise((resolve, reject) => {
        let child, failure, chunks = [], total = 0
        const stop = error => { failure ||= error; try { child?.stdin?.destroy(); child?.kill('SIGKILL') } catch {} }
        const abort = () => stop(signal.reason)
        try {
          const env = { ...process.env }; delete env.FFREPORT
          child = spawnProcess(typeof executable === 'function' ? executable() : executable, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-max_alloc', '67108864', '-protocol_whitelist', 'pipe', '-threads', '1', '-max_pixels', '4194304', '-i', 'pipe:0', '-map', '0:v:0', '-frames:v', '1', '-vf', `scale=${SIDE}:${SIDE}:force_original_aspect_ratio=decrease`, '-threads', '1', '-c:v', 'mjpeg', '-q:v', '5', '-f', 'image2pipe', 'pipe:1'], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env })
        } catch (error) { reject(error); return }
        signal.addEventListener('abort', abort, { once: true })
        child.once('error', error => { failure ||= error })
        child.stdin.on('error', error => { if (error.code !== 'EPIPE') stop(error) })
        child.stdout.on('error', stop); child.stderr.on('error', stop); child.stderr.resume()
        child.stdout.on('data', data => { total += data.length; if (total > BYTES) stop(new Error('预览超过上限')); else chunks.push(data) })
        child.once('close', code => {
          signal.removeEventListener('abort', abort)
          if (failure) reject(failure); else if (code !== 0) reject(new Error('预览解码失败')); else resolve(Buffer.concat(chunks, total))
          chunks = []
        })
        if (signal.aborted) abort(); else child.stdin.end(bytes)
      })
      signal.throwIfAborted()
      const outSize = imageSize(output)
      if (mimeOf(output) !== 'image/jpeg' || !outSize.width || !outSize.height || Math.max(outSize.width, outSize.height) > SIDE) return null
      const result = { bytes: output, mime: 'image/jpeg' }; remember(id, result); return result
    } catch (error) { if (signal.aborted) throw signal.reason; return error?.code === 'ENOENT' ? { code: 'PREVIEW_UNAVAILABLE' } : null } finally { release() }
  }
}

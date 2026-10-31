// 下载图片 / 语音：限大小、限协议、挡掉内网地址（防 SSRF）。也支持 base64:// 和本地文件。

import { openSync, fstatSync, readSync, closeSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolvePublicUrl, createSearchHttp } from '../search/net.js'

export async function assertPublicUrl(url) { return resolvePublicUrl(url, { allowAnyPort: true }) }
const publicHttp = createSearchHttp({ allowAnyPort: true })
// Trusted test-only transport injection; callers cannot configure this through profiles.
let testHttp = null
export function setMediaHttpForTests(http) {
  if (!process.env.NODE_TEST_CONTEXT) throw new Error('test only')
  testHttp = http
}

/** Bounded local reads are for explicitly trusted cache/asset paths only. */
export function readLocalBytes(path, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024) throw new Error('读取大小限制无效')
  const fd = openSync(path, 'r')
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > maxBytes) throw new Error('太大了或不是普通文件')
    // Read at most the observed length + 1; a growing file fails closed.
    const buf = Buffer.allocUnsafe(st.size + 1)
    let size = 0
    while (size < buf.length) {
      const count = readSync(fd, buf, size, buf.length - size, null)
      if (!count) break
      size += count
    }
    if (size > st.size) throw new Error('读取时文件发生变化')
    return buf.subarray(0, size)
  } finally { closeSync(fd) }
}

/**
 * 取一个 OneBot 图片 / 表情段的字节：先试 url，再试 file；都不行就问网关 get_image 换真实地址。
 * （SnowLuma 对内联来源的图片只给 `file: <md5>.png`，url 为空。）
 */
export async function segmentBytes(seg, onebot, o = {}) {
  const d = (seg && seg.data) || {}
  const tries = [d.url, d.file, d.path].filter((x) => typeof x === 'string' && x.trim())
  let lastErr = null
  for (const src of tries) {
    try {
      return await fetchImage(src, o)
    } catch (error) {
      lastErr = error
    }
  }
  // Ask the trusted gateway to resolve an opaque QQ media identifier, not an
  // attacker-supplied path/URL which a gateway could simply echo back.
  const fileId = typeof d.file === 'string' ? d.file.trim() : ''
  if (onebot && fileId && fileId !== '.' && fileId !== '..' && !/[\\/:\x00-\x1f]/.test(fileId)) {
    try {
      const info = await onebot.call('get_image', { file: fileId }, { timeoutMs: 15000 })
      for (const src of [info?.file, info?.url].filter(Boolean)) {
        try {
          return await fetchImage(src, { ...o, allowLocal: o.allowLocal !== false })
        } catch (error) {
          lastErr = error
        }
      }
    } catch (error) {
      lastErr = error
    }
  }
  throw lastErr || new Error('这个图片段没有可用的地址')
}

/**
 * @param {string} src http(s) 地址 / base64://… / file:// / 本地绝对路径
 * @param {{maxBytes?:number, timeoutMs?:number, allowLocal?:boolean}} [o]
 */
export async function fetchImage(src, o = {}) {
  const maxBytes = o.maxBytes ?? 10 * 1024 * 1024
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024) throw new Error('下载大小限制无效')
  const s = String(src || '').trim()
  if (!s) throw new Error('没有地址')
  if (s.startsWith('base64://')) {
    if (s.length - 9 > Math.ceil(maxBytes / 3) * 4 + 4) throw new Error('太大了')
    const buf = Buffer.from(s.slice(9), 'base64')
    if (buf.length > maxBytes) throw new Error('太大了')
    return buf
  }
  if (/^https?:\/\//i.test(s)) {
    const result = await (testHttp || publicHttp).read(s, { maxBytes, timeoutMs: o.timeoutMs ?? 20000, maxRedirects: 4, retries: 0, signal: o.signal })
    return result.body
  }
  // 本地文件：只在调用方明确允许时读（QQ 网关在本机，给的可能是本地缓存路径）
  if (o.allowLocal === true) {
    const p = s.startsWith('file://') ? fileURLToPath(s) : s
    if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/')) {
      return readLocalBytes(p, maxBytes)
    }
  }
  throw new Error('不认识的地址')
}

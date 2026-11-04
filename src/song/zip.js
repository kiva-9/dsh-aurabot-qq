// 极简 zip 读取：只支持「不压缩」和「deflate」两种（几乎所有 zip 都是这两种），够导入模型用。

import { inflateRawSync } from 'node:zlib'

function decodeName(bytes, utf8Flag) {
  if (utf8Flag) return bytes.toString('utf8')
  // Windows 上打的中文 zip 文件名多半是 GBK；先试 UTF-8，不合法再按 GBK
  const s = bytes.toString('utf8')
  if (!s.includes('�')) return s
  try { return new TextDecoder('gbk').decode(bytes) } catch (error) { return s }
}

/** 默认上限：够导入 RVC 模型，又能挡住 zip bomb。 */
export const ZIP_LIMITS = { maxEntries: 10_000, maxEntryBytes: 512 * 1024 * 1024, maxTotalBytes: 1024 * 1024 * 1024 }

/**
 * 读出 zip 里的文件。
 * @param {Buffer} buf
 * @param {(name: string) => boolean} [want] 只解压想要的文件（省内存）
 * @param {{maxEntries?:number,maxEntryBytes?:number,maxTotalBytes?:number}} [limits]
 * @returns {Array<{name: string, data: Buffer}>}
 */
export function readZip(buf, want = () => true, limits = {}) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Error('不是 zip 文件（或者文件不完整）')
  const maxEntries = Number.isSafeInteger(limits.maxEntries) && limits.maxEntries > 0 ? limits.maxEntries : ZIP_LIMITS.maxEntries
  const maxEntryBytes = Number.isSafeInteger(limits.maxEntryBytes) && limits.maxEntryBytes > 0 ? limits.maxEntryBytes : ZIP_LIMITS.maxEntryBytes
  const maxTotalBytes = Number.isSafeInteger(limits.maxTotalBytes) && limits.maxTotalBytes > 0 ? limits.maxTotalBytes : ZIP_LIMITS.maxTotalBytes
  // 从尾部找「中央目录结束」记录
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是 zip 文件（或者文件不完整）')
  const count = buf.readUInt16LE(eocd + 10)
  if (count === 0xffff) throw new Error('不支持 ZIP64，请重新打包成普通 zip')
  if (count > maxEntries) throw new Error(`zip 里文件太多（${count} 个，上限 ${maxEntries} 个）`)
  let p = buf.readUInt32LE(eocd + 16)
  const out = []
  let total = 0
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 目录损坏')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    if (p + 46 + nameLen + extraLen + commentLen > buf.length) throw new Error('zip 目录损坏')
    const name = decodeName(buf.subarray(p + 46, p + 46 + nameLen), flags & 0x800)
    p += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/') || !want(name)) continue
    if (flags & 1) throw new Error(`「${name}」加了密码，解不开`)
    if (local + 30 > buf.length) throw new Error('zip 目录损坏')
    const lNameLen = buf.readUInt16LE(local + 26)
    const lExtraLen = buf.readUInt16LE(local + 28)
    const start = local + 30 + lNameLen + lExtraLen
    if (start + compSize > buf.length) throw new Error('zip 文件不完整')
    if (compSize > maxEntryBytes) throw new Error(`「${name}」解压后太大（上限 ${Math.round(maxEntryBytes / 1024 / 1024)} MiB）`)
    const raw = buf.subarray(start, start + compSize)
    let data
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) {
      try { data = inflateRawSync(raw, { maxOutputLength: maxEntryBytes }) }
      catch (error) {
        if (error?.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|too large/i.test(error?.message || '')) throw new Error(`「${name}」解压后太大（上限 ${Math.round(maxEntryBytes / 1024 / 1024)} MiB）`)
        throw new Error(`「${name}」解压失败：${error.message}`)
      }
    } else throw new Error(`「${name}」用了不支持的压缩方式（${method}），请重新打包成普通 zip`)
    total += data.length
    if (data.length > maxEntryBytes) throw new Error(`「${name}」解压后太大（上限 ${Math.round(maxEntryBytes / 1024 / 1024)} MiB）`)
    if (total > maxTotalBytes) throw new Error(`zip 解压总大小超过 ${Math.round(maxTotalBytes / 1024 / 1024)} MiB`)
    out.push({ name, data })
  }
  return out
}

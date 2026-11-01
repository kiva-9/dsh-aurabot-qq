// Aurabot: alpha 0 = edit; Studio: an opaque grayscale mask, white = edit.
// Canvas exports non-interlaced 8-bit RGBA PNG. Grayscale+alpha is also accepted.
// Reuse imageInfo's chunk, CRC and ordering checks before decoding bounded pixels.
import { deflateSync, inflateSync } from 'node:zlib'
import { imageInfo, MAX_IMAGE_BYTES, ProviderError } from './common.js'

const PIXEL_LIMIT = 16 * 1024 * 1024
const SIDE_LIMIT = 8192
const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex')
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1
  return n >>> 0
})

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii')
  const result = Buffer.allocUnsafe(data.length + 12)
  result.writeUInt32BE(data.length, 0)
  t.copy(result, 4)
  data.copy(result, 8)
  let crc = 0xffffffff
  for (const b of result.subarray(4, result.length - 4)) crc = CRC_TABLE[(crc ^ b) & 255] ^ (crc >>> 8)
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4)
  return result
}

function fail(message) { throw new ProviderError('invalid', message, { maybeCharged: false }) }

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

export function studioMaskPng(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_IMAGE_BYTES) fail('蒙版不是有效 PNG 或超过大小限制')
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const info = imageInfo(buf)
  if (info.mime !== 'image/png' || !info.hasAlpha) fail('蒙版必须是带透明通道的 PNG')
  const { width, height } = info
  if (width > SIDE_LIMIT || height > SIDE_LIMIT || width * height > PIXEL_LIMIT) fail('蒙版尺寸超过限制')
  const depth = buf[24], color = buf[25], interlace = buf[28]
  if (depth !== 8 || ![4, 6].includes(color) || interlace !== 0) {
    throw new ProviderError('unsupported', 'Studio 蒙版只支持非交错的 8 位 RGBA 或灰度透明 PNG', { maybeCharged: false })
  }
  const idat = []
  let sawData = false, endedData = false
  for (let p = 8; p < buf.length;) {
    const n = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8)
    if (['acTL', 'fcTL', 'fdAT'].includes(type)) throw new ProviderError('unsupported', 'Studio 不支持动画 PNG 蒙版', { maybeCharged: false })
    if (type === 'eXIf') throw new ProviderError('unsupported', 'Studio 不支持含 EXIF 的蒙版，请重新绘制', { maybeCharged: false })
    if (type === 'IDAT') {
      if (endedData) fail('蒙版 PNG 的图像数据不连续')
      sawData = true
      idat.push(buf.subarray(p + 8, p + 8 + n))
    } else if (sawData) endedData = true
    p += 12 + n
  }
  const bpp = color === 6 ? 4 : 2, stride = width * bpp
  const expected = (stride + 1) * height
  let raw
  try {
    const compressed = Buffer.concat(idat)
    const result = inflateSync(compressed, { maxOutputLength: expected, info: true })
    if (result.engine.bytesWritten !== compressed.length || result.buffer.length !== expected) fail('蒙版 PNG 像素数据损坏')
    raw = result.buffer
  } catch (error) {
    if (error instanceof ProviderError) throw error
    fail('蒙版 PNG 像素数据损坏或解压后超过大小限制')
  }
  const output = Buffer.alloc((width + 1) * height)
  let previous = Buffer.alloc(stride), current = Buffer.alloc(stride), hasEdit = false
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1), filter = raw[row]
    if (filter > 4) fail('蒙版 PNG 使用了无效滤镜')
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? current[i - bpp] : 0
      const above = previous[i]
      const aboveLeft = i >= bpp ? previous[i - bpp] : 0
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : paeth(left, above, aboveLeft)
      current[i] = (raw[row + 1 + i] + predictor) & 255
    }
    for (let x = 0; x < width; x++) {
      const pixel = 255 - current[x * bpp + bpp - 1]
      output[y * (width + 1) + 1 + x] = pixel
      hasEdit ||= pixel !== 0
    }
    ;[previous, current] = [current, previous]
  }
  if (!hasEdit) fail('请先在蒙版上涂出要重绘的区域')
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4)
  header[8] = 8; header[9] = 0 // unfiltered, opaque grayscale PNG
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(output)), chunk('IEND', Buffer.alloc(0))])
}

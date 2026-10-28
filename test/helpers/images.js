import { deflateSync } from 'node:zlib'
import { readFileSync } from 'node:fs'

// Independent valid fixtures, including CRCs and pixel scanlines. Parser tests
// can corrupt these bytes deliberately instead of relying on signature stubs.
export function png(width = 2, height = 3, salt = 0) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(body.length + 8)
    let crc = 0xffffffff
    for (const b of body) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) }
    out.writeUInt32BE(data.length); body.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6
  const scanlines = Buffer.alloc((width * 4 + 1) * height, salt % 256)
  for (let y = 0; y < height; y++) scanlines[y * (width * 4 + 1)] = 0
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))])
}
export const PNG = png()
export const JPG = readFileSync(new URL('../../assets/dafeiyu.jpg', import.meta.url))

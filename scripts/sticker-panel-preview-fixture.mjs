// 仅为 scripts/panel-preview.mjs 的临时沙盒生成虚构表情和审核状态。
// 用法：node scripts/sticker-panel-preview-fixture.mjs [端口，默认 5192]
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'

const port = Number(process.argv[2] || 5192)
assert.ok(Number.isInteger(port) && port > 0 && port < 65536)
const base = `http://127.0.0.1:${port}`
const identity = await fetch(base + '/__preview__').then(r => r.json())
const allowed = resolve(join(tmpdir(), 'aurabot-panel-')).toLowerCase()
assert.equal(identity.preview, 'aurabot-isolated-panel')
assert.ok(resolve(identity.dataDir).toLowerCase().startsWith(allowed), '只允许临时预览目录')
async function api(path, body) {
  const response = await fetch(base + '/aurabot/api' + path, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const value = await response.json()
  if (!value.ok) throw new Error(value.message || value.reason || path + ' 失败')
  return value
}

// 简单几何图形，仅包含虚构像素，不读取用户图片。
function picture(index) {
  const size = 160, stride = size * 4 + 1, raw = Buffer.alloc(stride * size)
  const palettes = [[228,240,253],[252,231,225],[240,235,255],[229,246,237],[253,241,215],[232,239,246],[252,231,239],[227,245,247]]
  const background = palettes[index % palettes.length]
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = x - 80, dy = y - 80, face = dx * dx + dy * dy < 48 * 48
    const ear = y > 33 && y < 66 && ((x > 41 && x < 68 && y > 33 + (68-x)) || (x > 92 && x < 119 && y > 33 + (x-92)))
    const eye = (Math.abs(x - 64) < 4 || Math.abs(x - 96) < 4) && Math.abs(y - (index % 3 === 0 ? 80 : 74)) < 5
    const mouth = Math.abs(y - (95 + Math.abs(x-80) / (index % 2 ? 5 : -5))) < 2 && Math.abs(x-80) < 12
    const color = eye || mouth ? [59,76,98,255] : face || ear ? [255,255,255,255] : [...background,255]
    const at = y * stride + 1 + x * 4; for (let j = 0; j < 4; j++) raw[at+j] = color[j]
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(body.length + 8)
    let crc = 0xffffffff
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) }
    out.writeUInt32BE(data.length); body.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))])
}

const existing = await api('/stickers?status=all&limit=200')
if (existing.items.some(item => String(item.name || '').startsWith('预览样例 · '))) {
  console.log('预览样例已存在：' + identity.dataDir)
  process.exit(0)
}
const samples = [
  ['早安小猫','清晨打招呼时，安静又轻快的微笑',['早安','问候'],'approved'],
  ['有点开心','听到好消息时表达愉快心情',['开心','惊喜'],'approved'],
  ['轻轻抱抱','温柔回应安慰与关心',['安慰','陪伴'],'approved'],
  ['等一下','表情含文字，等待确认完整语境',['疑惑'],'pending'],
  ['眨眨眼','素材已接收，等待识别与人工查看',['可爱'],'pending'],
  ['不太合适','预览示例：人工拒绝的素材',['拒绝'],'rejected'],
  ['暂时收起','预览示例：已停用，保留本地记录',['停用'],'disabled'],
  ['晚安月亮','睡前道晚安时轻声回应',['晚安'],'approved'],
]
for (let i = 0; i < samples.length; i++) {
  const [name,description,tags,state] = samples[i]
  const uploaded = await api('/sticker/upload', { data:'data:image/png;base64,'+picture(i).toString('base64'),name:'预览样例 · '+name,toQQ:false })
  const id = uploaded.item.id
  await api('/sticker/edit', { id, patch:{description,tags,suitable:tags,unsuitable:['严肃或不合适的场景']} })
  if (state !== 'pending') await api('/sticker/'+({approved:'approve',rejected:'reject',disabled:'disable'}[state]), {id,reason:'仅供隔离预览的虚构数据'})
}
const stats = await api('/stickers/stats')
const failures = await api('/stickers/queue?kind=analyze&state=failed')
console.log(JSON.stringify({url:base,dataDir:identity.dataDir,stats,analysisFailures:failures.total},null,2))

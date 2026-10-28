// 内部 ID：前缀 + 时间有序的随机串（同一毫秒内也单调递增），便于排序、看日志时一眼认出是哪类东西。
//   msg_ 消息  ast_ 资产  occ_ 资产出现  req_ 请求  job_ 任务  out_ 发送段  trc_ 追踪

import { randomBytes } from 'node:crypto'

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz' // Crockford base32（小写，去掉 i l o u）
let lastMs = 0
let lastRand = null

function encodeTime(ms) {
  let out = ''
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[ms % 32] + out
    ms = Math.floor(ms / 32)
  }
  return out
}

function encodeRand(bytes) {
  let out = ''
  for (const b of bytes) out += ALPHABET[b % 32]
  return out
}

/** 同一毫秒里把上一个随机串 +1，保证生成顺序 = 字符串顺序。 */
function bump(bytes) {
  const next = Buffer.from(bytes)
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i] % 32 < 31) { next[i]++; return next }
    next[i] -= next[i] % 32
  }
  return randomBytes(next.length)
}

export function newId(prefix, now = Date.now()) {
  if (!/^[a-z]{2,4}$/.test(prefix)) throw new Error(`ID 前缀不合法：${prefix}`)
  let rand
  if (now === lastMs && lastRand) rand = bump(lastRand)
  else rand = randomBytes(12)
  lastMs = now
  lastRand = rand
  return `${prefix}_${encodeTime(now)}${encodeRand(rand)}`
}

export const ID_PATTERN = /^[a-z]{2,4}_[0-9a-hjkmnp-tv-z]{22}$/

/** 从 ID 里读出生成时间（毫秒），不是合法 ID 返回 0。 */
export function idTime(id) {
  if (!ID_PATTERN.test(String(id))) return 0
  const t = String(id).split('_')[1].slice(0, 10)
  let ms = 0
  for (const ch of t) ms = ms * 32 + ALPHABET.indexOf(ch)
  return ms
}

export const traceId = () => newId('trc')

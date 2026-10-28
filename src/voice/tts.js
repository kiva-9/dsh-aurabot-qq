// 文字 → 语音文件。统一走外部接口（地址、密钥都是主人自己在面板里填的，所以允许 127.0.0.1 这类本机地址）：
//   openai  兼容 OpenAI 的 POST {baseUrl}/audio/speech
//   http    主人配置的固定映射：方法、地址模板、请求体模板、返回格式（直接音频 / JSON 里的 base64 / JSON 里的地址）
//           CosyVoice、GPT-SoVITS 这类本地服务用 http 映射的预设
// 音色先用当前人设的 voice，没有再用面板默认。返回 { file, engine }；失败抛错，调用方退回发文字。

import { mkdirSync, statSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildWav } from './wav.js'
import { dataDir } from '../core/store.js'

export const TTS_PROVIDERS = ['none', 'openai', 'http']
const MAX_AUDIO_BYTES = 20 * 1024 * 1024

function outDir() {
  const d = dataDir('voice-cache')
  mkdirSync(d, { recursive: true })
  // 顺手清掉一天前的旧文件
  try {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (Date.now() - statSync(p).mtimeMs > 86400_000) unlinkSync(p)
    }
  } catch (error) {}
  return d
}

async function fetchBytes(url, init, timeoutMs) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const limit = r.ok ? MAX_AUDIO_BYTES : 4096
  const len = r.headers.get('content-length')
  if (r.ok && !r.headers.get('content-encoding') && len !== null && /^\d+$/.test(len) && Number(len) > limit) {
    if (r.body) void r.body.cancel().catch(() => {})
    throw new Error('返回的音频太大了（上限 20 MiB）')
  }
  const reader = r.body?.getReader()
  const chunks = []
  let size = 0
  try {
    if (reader) while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const remaining = limit - size
      if (value.byteLength > remaining && r.ok) throw new Error('返回的音频太大了（上限 20 MiB）')
      const chunk = Buffer.from(value.subarray(0, remaining))
      chunks.push(chunk); size += chunk.length
      if (!r.ok && size === limit) { void reader.cancel().catch(() => {}); break }
    }
  } catch (error) {
    if (reader) void reader.cancel().catch(() => {})
    throw error
  } finally { reader?.releaseLock() }
  const buf = Buffer.concat(chunks, size)
  if (!r.ok) throw new Error(`语音服务返回 HTTP ${r.status}：${buf.toString('utf8', 0, 160)}`)
  return { buf, type: r.headers.get('content-type') || '' }
}

function audioAssert(ok) {
  if (!ok) throw new Error('语音服务返回的音频格式无效或已截断')
}

function wavAudio(buf) {
  audioAssert(buf.length >= 44)
  let fmt = false, data = false
  // 管道输出的 WAV 常用 0xffffffff 表示尚未知晓长度；数据仍受 HTTP 总上限约束。
  const streaming = buf.readUInt32LE(4) === 0xffffffff
  const end = streaming ? buf.length : buf.readUInt32LE(4) + 8
  audioAssert(end <= buf.length)
  for (let p = 12; p < end;) {
    audioAssert(p + 8 <= end)
    const id = buf.toString('latin1', p, p + 4), d = p + 8
    const declared = buf.readUInt32LE(p + 4), n = streaming && id === 'data' && declared === 0xffffffff ? end - d : declared
    audioAssert(d + n + (n & 1) <= end)
    if (id === 'fmt ') {
      audioAssert(n >= 16 && buf.readUInt16LE(d) > 0 && buf.readUInt16LE(d + 2) > 0 && buf.readUInt32LE(d + 4) > 0)
      fmt = true
    }
    if (id === 'data') { audioAssert(n > 0); data = true }
    p = d + n + (n & 1)
  }
  audioAssert(fmt && data)
}

function mpegAudio(buf) {
  let p = 0
  if (buf.toString('latin1', 0, 3) === 'ID3') {
    audioAssert(buf.length >= 10 && [2, 3, 4].includes(buf[3]) && buf.subarray(6, 10).every((b) => b < 128))
    p = 10 + (buf[6] * 2 ** 21 + buf[7] * 2 ** 14 + buf[8] * 128 + buf[9]) + (buf[3] === 4 && buf[5] & 16 ? 10 : 0)
  }
  if (p + 7 <= buf.length && buf[p] === 0xff && (buf[p + 1] & 0xf6) === 0xf0) {
    // AAC ADTS 有 12 位同步字和 layer = 0，不能用 MP3 的宽泛 0xffe0 判断。
    const n = ((buf[p + 3] & 3) << 11) | (buf[p + 4] << 3) | (buf[p + 5] >>> 5)
    audioAssert(((buf[p + 2] >>> 2) & 15) <= 12 && n > (buf[p + 1] & 1 ? 7 : 9) && p + n <= buf.length)
    return 'aac'
  }
  if (p + 4 > buf.length || buf[p] !== 0xff || (buf[p + 1] & 0xe0) !== 0xe0) return ''
  const version = (buf[p + 1] >>> 3) & 3, layer = (buf[p + 1] >>> 1) & 3
  const bitrate = buf[p + 2] >>> 4, rateIndex = (buf[p + 2] >>> 2) & 3
  audioAssert(version !== 1 && layer === 1 && bitrate > 0 && bitrate < 15 && rateIndex < 3 && (buf[p + 3] & 3) !== 2)
  const rates = version === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  const hz = [44100, 48000, 32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4)
  const n = Math.floor((version === 3 ? 144 : 72) * rates[bitrate] * 1000 / hz) + ((buf[p + 2] >>> 1) & 1)
  audioAssert(p + n <= buf.length)
  return 'mp3'
}

function flacAudio(buf) {
  let p = 4, last = false
  while (!last) {
    audioAssert(p + 4 <= buf.length)
    const type = buf[p] & 127, n = buf.readUIntBE(p + 1, 3)
    audioAssert(type !== 127 && (p !== 4 || (type === 0 && n === 34)) && p + 4 + n <= buf.length)
    last = Boolean(buf[p] & 128); p += 4 + n
  }
  audioAssert(p + 6 <= buf.length && buf[p] === 0xff && (buf[p + 1] & 0xfe) === 0xf8)
}

function oggAudio(buf) {
  let p = 0, first = true
  while (p < buf.length) {
    audioAssert(p + 27 <= buf.length && buf.toString('latin1', p, p + 4) === 'OggS' && buf[p + 4] === 0)
    const segments = buf[p + 26], start = p + 27 + segments
    audioAssert((!first || segments > 0) && start <= buf.length)
    const n = buf.subarray(p + 27, start).reduce((sum, v) => sum + v, 0)
    audioAssert(start + n <= buf.length)
    if (first) {
      const codec = buf.toString('latin1', start, start + Math.min(n, 8))
      audioAssert(codec.startsWith('OpusHead') || codec.startsWith('\x01vorbis') || codec.startsWith('Speex   ') || codec.startsWith('\x7fFLAC'))
      first = false
    }
    p = start + n
  }
}

function silkAudio(buf, offset) {
  let p = offset + 9, frames = 0
  while (p < buf.length) {
    audioAssert(p + 2 <= buf.length)
    const n = buf.readInt16LE(p); p += 2
    if (n === -1) { audioAssert(p === buf.length); break }
    audioAssert(n > 0 && p + n <= buf.length)
    p += n; frames++
  }
  audioAssert(frames > 0)
}

/**
 * 识别有头音频；未知字节默认拒绝。仅 format: 'pcm' / 'pcm_s16le' 显式允许裸 PCM16LE 单声道。
 * 第三个参数可选，旧的 normalizeAudio(buf, sampleRate) 调用仍用于识别有头音频。
 */
export function normalizeAudio(buf, sampleRate = 24000, { format = '', contentType = '' } = {}) {
  if (!(buf instanceof Uint8Array) || !buf.length) throw new Error('返回的音频太短')
  if (buf.length > MAX_AUDIO_BYTES) throw new Error('返回的音频太大了（上限 20 MiB）')
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  const head = buf.toString('utf8', 0, 160)
  const textError = /^[\s\uFEFF]*[\[{<]/.test(head) && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(head)
  if (/json|html|xml/i.test(contentType) || textError) throw new Error('语音服务返回的不是音频：' + head)
  if (format === 'pcm' || format === 'pcm_s16le') {
    if (buf.length % 2) throw new Error('PCM16LE 音频字节数必须为偶数，不能截掉半个采样')
    if (!Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 384000) throw new Error('PCM 采样率必须是 8000 到 384000 的整数')
    // 显式 PCM 优先于魔数（样本也可能恰好以 0xffff 开头）；保持字节序，不受 byteOffset 对齐影响。
    const header = buildWav(new Int16Array(0), sampleRate)
    header.writeUInt32LE(buf.length + 36, 4); header.writeUInt32LE(buf.length, 40)
    return { buf: Buffer.concat([header, buf]), ext: 'wav' }
  }
  const tag = (a, b) => buf.toString('latin1', a, b)
  if (tag(0, 4) === 'RIFF' && tag(8, 12) === 'WAVE') { wavAudio(buf); return { buf, ext: 'wav' } }
  if (tag(0, 4) === 'fLaC') { flacAudio(buf); return { buf, ext: 'flac' } }
  if (tag(0, 4) === 'OggS') { oggAudio(buf); return { buf, ext: 'ogg' } }
  const silk = tag(0, 9) === '#!SILK_V3' ? 0 : buf[0] === 2 && tag(1, 10) === '#!SILK_V3' ? 1 : -1
  if (silk >= 0) { silkAudio(buf, silk); return { buf, ext: 'silk' } }
  const mpeg = mpegAudio(buf)
  if (mpeg) return { buf, ext: mpeg }
  throw new Error('语音服务返回的不是音频或格式无法识别；裸 PCM 必须显式配置')
}

function save({ buf, ext }) {
  const file = join(outDir(), `${randomUUID()}.${ext}`)
  writeFileSync(file, buf)
  return file
}

/** 模板里的 {text} {voice} {speed} {apiKey} 换成实际值；enc 决定怎么转义（url / json / 原样）。 */
export function fill(template, vars, enc = 'raw') {
  const esc = (v) => {
    const s = String(v ?? '')
    if (enc === 'url') return encodeURIComponent(s)
    if (enc === 'json') return JSON.stringify(s).slice(1, -1)
    return s
  }
  return String(template || '').replace(/\{(text|voice|speed|apiKey)\}/g, (_, k) => esc(vars[k]))
}

/** 从 JSON 里按 a.b.0.c 这样的路径取值。 */
export function pick(obj, path) {
  return String(path || '').split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

async function openaiSynth(text, c, voice, speed) {
  const base = String(c.baseUrl || '').replace(/\/+$/, '')
  if (!base) throw new Error('没填语音服务地址')
  const body = { model: c.model || 'tts-1', input: text, voice: voice || 'alloy', ...(speed && speed !== 1 ? { speed } : {}), response_format: c.format || 'mp3' }
  const headers = { 'content-type': 'application/json', ...(c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}) }
  const { buf, type } = await fetchBytes(`${base}/audio/speech`, { method: 'POST', headers, body: JSON.stringify(body) }, c.timeoutMs || 60000)
  return normalizeAudio(buf, c.sampleRate ?? 24000, { format: c.format === 'pcm' ? 'pcm' : '', contentType: type })
}

async function httpSynth(text, c, voice, speed) {
  const vars = { text, voice: voice || '', speed: speed || 1, apiKey: c.apiKey || '' }
  const url = fill(c.url, vars, 'url')
  if (!/^https?:\/\//.test(url)) throw new Error('语音服务地址要以 http:// 或 https:// 开头')
  const method = c.method === 'GET' ? 'GET' : 'POST'
  const headers = {}
  for (const [k, v] of Object.entries(c.headers || {})) headers[k] = fill(v, vars)
  let body
  if (method === 'POST' && c.bodyType === 'json') { headers['content-type'] = 'application/json'; body = fill(c.body, vars, 'json') }
  else if (method === 'POST' && c.bodyType === 'form') { headers['content-type'] = 'application/x-www-form-urlencoded'; body = fill(c.body, vars, 'url') }
  const { buf, type } = await fetchBytes(url, { method, headers, body }, c.timeoutMs || 120000)
  const audio = (bytes, contentType = '') => normalizeAudio(bytes, c.sampleRate ?? 24000, { format: c.audioFormat === 'pcm_s16le' ? 'pcm_s16le' : '', contentType })
  if (c.response === 'json-base64' || c.response === 'json-url') {
    let j
    try { j = JSON.parse(buf.toString('utf8')) } catch (error) { throw new Error('语音服务没返回 JSON') }
    const v = pick(j, c.jsonPath)
    if (!v || typeof v !== 'string') throw new Error(`返回的 JSON 里 ${c.jsonPath || '(路径)'} 没有内容`)
    if (c.response === 'json-base64') {
      const encoded = v.replace(/^data:audio\/[\w.+-]+;base64,/i, '')
      if (encoded.length > 4 * Math.ceil(MAX_AUDIO_BYTES / 3)) throw new Error('返回的音频太大了')
      if (encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || (encoded.includes('=') && encoded.length % 4 !== 0)) throw new Error('语音服务返回的 base64 音频格式不对')
      return audio(Buffer.from(encoded, 'base64'))
    }
    if (!/^https?:\/\//.test(v)) throw new Error('返回的音频地址不对')
    const result = await fetchBytes(v, { method: 'GET' }, c.timeoutMs || 120000)
    return audio(result.buf, result.type)
  }
  return audio(buf, type)
}

/**
 * @param {string} text
 * @param {object} cfg 设置里的 voice 段
 * @param {{voice?: string, speed?: number}} [profile] 当前人设的音色（优先）
 * @returns {Promise<{file:string, engine:string}>}
 */
export async function textToSpeech(text, cfg = {}, profile = {}) {
  const clean = String(text || '').trim()
  if (!clean) throw new Error('没有要念的文字')
  const provider = cfg.provider || 'none'
  const voice = profile.voice || cfg.defaultVoice || ''
  const speed = profile.speed || cfg.speed || 1
  if (provider === 'openai') return { file: save(await openaiSynth(clean, cfg.openai || {}, voice || cfg.openai?.voice, speed)), engine: 'openai' }
  if (provider === 'http') return { file: save(await httpSynth(clean, cfg.httpApi || {}, voice, speed)), engine: 'http' }
  throw new Error('还没配置语音合成服务')
}

/**
 * 旧设置 → 新的 http 映射（CosyVoice / GPT-SoVITS / 通用地址模板）。旧的 edge-tts、Windows 语音不再支持，返回 null。
 */
export function legacyTtsMapping(v = {}) {
  if (v.engine === 'cosyvoice') {
    const c = v.cosyvoice || {}
    const base = String(c.url || 'http://127.0.0.1:50000').replace(/\/+$/, '')
    const instruct = c.mode === 'instruct' && c.instruct
    const spk = encodeURIComponent(c.spkId || '中文女')
    return {
      method: 'POST', url: `${base}/${instruct ? 'inference_instruct' : 'inference_sft'}`, bodyType: 'form',
      body: `tts_text={text}&spk_id=${spk}` + (instruct ? `&instruct_text=${encodeURIComponent(c.instruct)}` : ''),
      response: 'audio', audioFormat: 'pcm_s16le', sampleRate: c.sampleRate || 22050, headers: {},
    }
  }
  if (v.engine === 'gptsovits') {
    const c = v.gptsovits || {}
    const base = String(c.url || 'http://127.0.0.1:9880').replace(/\/+$/, '')
    const q = (k, val) => `${k}=${encodeURIComponent(val || '')}`
    return {
      method: 'GET', url: `${base}/tts?text={text}&${q('text_lang', c.textLang || 'zh')}&${q('ref_audio_path', c.refAudio)}&${q('prompt_text', c.promptText)}&${q('prompt_lang', c.promptLang || 'zh')}&media_type=wav`,
      bodyType: 'none', body: '', response: 'audio', sampleRate: 32000, headers: {},
    }
  }
  if (v.engine === 'http' && String(v.http?.urlTemplate || '').includes('{text}')) {
    return { method: 'GET', url: v.http.urlTemplate, bodyType: 'none', body: '', response: 'audio', sampleRate: 24000, headers: {} }
  }
  return null
}

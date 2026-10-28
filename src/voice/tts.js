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
  if (!r.ok) throw new Error(`语音服务返回 HTTP ${r.status}：${(await r.text().catch(() => '')).slice(0, 160)}`)
  const len = Number(r.headers.get('content-length') || 0)
  if (len > MAX_AUDIO_BYTES) throw new Error('返回的音频太大了')
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length > MAX_AUDIO_BYTES) throw new Error('返回的音频太大了')
  return { buf, type: r.headers.get('content-type') || '' }
}

/** 认出音频格式；认不出来的当裸 PCM16（CosyVoice 官方 FastAPI 就是这样返回的）包一个 WAV 头。 */
export function normalizeAudio(buf, sampleRate = 24000) {
  if (!buf || buf.length < 400) throw new Error('返回的音频太短：' + (buf ? buf.toString('utf8', 0, Math.min(buf.length, 120)) : ''))
  const tag = (a, b) => buf.toString('latin1', a, b)
  if (tag(0, 4) === 'RIFF' && tag(8, 12) === 'WAVE') return { buf, ext: 'wav' }
  if (tag(0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return { buf, ext: 'mp3' }
  if (tag(0, 4) === 'OggS') return { buf, ext: 'ogg' }
  if (tag(0, 6) === '#!SILK' || tag(1, 7) === '#!SILK') return { buf, ext: 'silk' }
  if (buf[0] === 0x7b || buf[0] === 0x3c) throw new Error('语音服务返回的不是音频：' + tag(0, 160))
  return { buf: buildWav(new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2)), sampleRate), ext: 'wav' }
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
  const { buf } = await fetchBytes(`${base}/audio/speech`, { method: 'POST', headers, body: JSON.stringify(body) }, c.timeoutMs || 60000)
  return normalizeAudio(buf, c.sampleRate || 24000)
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
  const { buf } = await fetchBytes(url, { method, headers, body }, c.timeoutMs || 120000)
  if (c.response === 'json-base64' || c.response === 'json-url') {
    let j
    try { j = JSON.parse(buf.toString('utf8')) } catch (error) { throw new Error('语音服务没返回 JSON') }
    const v = pick(j, c.jsonPath)
    if (!v || typeof v !== 'string') throw new Error(`返回的 JSON 里 ${c.jsonPath || '(路径)'} 没有内容`)
    if (c.response === 'json-base64') return normalizeAudio(Buffer.from(v.replace(/^data:[^,]*,/, ''), 'base64'), c.sampleRate || 24000)
    if (!/^https?:\/\//.test(v)) throw new Error('返回的音频地址不对')
    return normalizeAudio((await fetchBytes(v, { method: 'GET' }, c.timeoutMs || 120000)).buf, c.sampleRate || 24000)
  }
  return normalizeAudio(buf, c.sampleRate || 24000)
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
      response: 'audio', sampleRate: c.sampleRate || 22050, headers: {},
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

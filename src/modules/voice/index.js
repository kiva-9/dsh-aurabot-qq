// 内置模块：语音。把她的话念出来发语音条（外部语音接口：兼容 OpenAI 的 /audio/speech 或自己配的 HTTP 映射；本地接口优先），
// 面板里的试听、语音识别自检也在这里。
// 导出 speak(text, profile) → { file, engine }：聊天中枢发语音时找它；profile 是当前人设的音色。替换这个模块就能换成任何你想要的念法。

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dataDir } from '../../core/store.js'
import { spawn } from 'node:child_process'
import { textToSpeech, normalizeAudio } from '../../voice/tts.js'
import { toMono16k, parseWav, buildWav } from '../../voice/wav.js'
import { fileOf } from '../../local/local.js'
import { speakableText } from '../../chat/faces.js'

const MAX_ASR_BYTES = 20 * 1024 * 1024
const MAX_ASR_SECONDS = 120
const MAX_ASR_PCM_BYTES = MAX_ASR_SECONDS * 16000 * 2

/** DSH 接受完整的 16kHz 单声道 PCM16 WAV；压缩音频用本机 FFmpeg 解码，不发往网络。 */
export async function prepareAsrAudio(bytes, { signal, ffmpeg = 'ffmpeg', timeoutMs = 30000 } = {}) {
  signal?.throwIfAborted()
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_ASR_BYTES) throw new Error('ASR 音频为空或超过 20 MiB')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('ASR 解码超时必须在 1 到 120000 毫秒之间')
  let audio
  try { audio = normalizeAudio(bytes) } catch { throw new Error('ASR 音频格式无效、无法识别或已截断') }
  if (audio.ext === 'silk') throw new Error('SILK 语音请先通过 QQ get_record 转成 WAV')
  if (audio.ext === 'wav') {
    let wav
    try { wav = parseWav(audio.buf) } catch { /* 非 PCM16 WAV 交给 FFmpeg。 */ }
    if (wav) {
      if (wav.channels > 32 || wav.rate < 8000 || wav.rate > 384000 || wav.data.length % (2 * wav.channels)) throw new Error('ASR WAV 采样参数或数据长度无效')
      if (wav.data.length / (2 * wav.channels * wav.rate) > MAX_ASR_SECONDS) throw new Error('ASR 音频超过 120 秒')
      return toMono16k(audio.buf)
    }
  }
  const pcm = await new Promise((resolve, reject) => {
    // 固定输入容器和 pipe 协议；上传的文件不能让 FFmpeg 读取本机路径或远端 URL。
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', '-protocol_whitelist', 'pipe',
      '-f', audio.ext, '-i', 'pipe:0', '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks = []
    let size = 0, settled = false, timer
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      if (error) { child.kill(); reject(error) }
      else resolve(Buffer.concat(chunks, size))
    }
    const aborted = () => finish(signal.reason || new Error('ASR 解码已取消'))
    signal?.addEventListener('abort', aborted, { once: true })
    timer = setTimeout(() => finish(new Error('ASR 音频解码超时')), timeoutMs)
    child.once('error', (error) => finish(new Error(error.code === 'ENOENT' ? '本机未找到 FFmpeg；请安装 FFmpeg 或提供 PCM16 WAV' : '无法启动本机 ASR 音频解码')))
    child.stdin.on('error', () => { /* close/error 统一结算，避免 EPIPE 成为未处理异常。 */ })
    child.stderr.resume()
    child.stdout.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_ASR_PCM_BYTES) return finish(new Error('ASR 音频超过 120 秒'))
      chunks.push(chunk)
    })
    child.once('close', (code) => finish(code !== 0 || !size || size % 2 ? new Error('ASR 音频解码失败或数据不完整') : null))
    if (signal?.aborted) aborted()
    if (!settled) child.stdin.end(audio.buf)
  })
  signal?.throwIfAborted()
  const header = buildWav(new Int16Array(0), 16000)
  header.writeUInt32LE(pcm.length + 36, 4); header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function suppliedAudio(encoded) {
  if (typeof encoded !== 'string' || !encoded.length || encoded.length > Math.ceil(MAX_ASR_BYTES / 3) * 4) throw new Error('ASR audioBase64 为空或超过 20 MiB')
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length > MAX_ASR_BYTES || bytes.toString('base64') !== encoded) throw new Error('ASR audioBase64 必须是规范 base64')
  return bytes
}

function transcriptText(result) {
  // 空识别结果不能把 JSON/错误对象当作“听懂了”。
  return (typeof result === 'string' ? result : typeof result?.text === 'string' ? result.text : typeof result?.transcript === 'string' ? result.transcript : '').trim()
}

export default {
  id: 'voice',
  name: '语音',
  version: '1.0.0',
  description: '发语音条：把她的话念出来（关掉后想发语音时改发文字）',
  tab: 'voice',
  files: ['voice/tts.js'],
  setup(api) {
    const { hub, onebot, local, http } = api.core
    const lifetime = new AbortController()
    api.onDispose?.(() => lifetime.abort(new Error('语音模块已停止')))

    async function synthesize(text, profile = {}, assertCurrent = () => {}) {
      // 本地接口接管语音合成；出错退回语音接口
      if (local.active('tts')) {
        try {
          const file = fileOf(await local.call('tts', { text, voice: profile.voice || '', signal: profile.signal }, { signal: profile.signal }))
          assertCurrent()
          if (file && existsSync(file)) return { file, engine: 'local' }
        } catch (error) { assertCurrent() }
      }
      assertCurrent()
      const startedAt=Date.now();let status='failed'
      try{const result=await textToSpeech(text, api.config().voice, profile);status='succeeded';return result}
      finally{api.core.usage?.record({service:'tts',model:api.config().voice.provider,chatId:profile.chatId,requestId:profile.requestId,status,billing:'unknown',startedAt,durationMs:Date.now()-startedAt,inputChars:String(text).length})}
    }

    async function speak(text, profile = {}) {
      const clean = speakableText(text)
      if (!clean) throw new Error('没有可朗读文字')
      const signal = AbortSignal.any([lifetime.signal, ...(profile.signal ? [profile.signal] : [])])
      const settings = { ...(api.config().voice.rvc || {}), ...(profile.rvc || {}) }
      const account = String(api.config().botQQ), epoch = profile.chatId && api.core.storage.epochs.current(profile.chatId)
      const persona = profile.chatId && JSON.stringify(hub.personaFor?.(profile.chatId) || null)
      const rvcConfig = JSON.stringify(api.config().voice.rvc || {})
      const profileState = JSON.stringify([profile.voice, profile.speed, profile.rvc || {}])
      const voiceState = JSON.stringify([api.config().voice.provider, api.config().voice.defaultVoice, api.config().voice.speed])
      const current = () => {
        const cfg = api.config(), req = profile.requestId && api.core.storage.requests.get(profile.requestId)
        return !signal.aborted && cfg.enabled !== false && cfg.voice.enabled !== false && String(cfg.botQQ) === account && JSON.stringify(cfg.voice.rvc || {}) === rvcConfig &&
          JSON.stringify([profile.voice, profile.speed, profile.rvc || {}]) === profileState && JSON.stringify([cfg.voice.provider, cfg.voice.defaultVoice, cfg.voice.speed]) === voiceState &&
          (!profile.chatId || (api.core.storage.epochs.current(profile.chatId) === epoch && JSON.stringify(hub.personaFor?.(profile.chatId) || null) === persona)) &&
          (!profile.requestId || (req && req.chatId === profile.chatId && (req.epoch === undefined || req.epoch === epoch) && !['canceled', 'cancel_requested', 'closed', 'expired'].includes(req.state) &&
            (!req.sourceMessageIds || req.sourceMessageIds.every(id => { const m = api.core.storage.messages?.get(id); return m && !m.recalledAt && m.account === account && m.chatId === profile.chatId && m.authorId === req.actorId }))))
      }
      const assertCurrent = () => { if (!current()) throw new Error('语音请求已取消') }
      assertCurrent()
      const result = await synthesize(clean, { ...profile, signal }, assertCurrent)
      assertCurrent()
      if (!settings.enabled) return result
      try {
        const bytes = await api.lazy('song').convertSpeech(result.file, { ...settings, signal, current })
        assertCurrent()
        const audio = normalizeAudio(bytes)
        const dir = dataDir('voice-cache'); mkdirSync(dir, { recursive: true })
        // The TTS provider normally prunes this cache. Local-only TTS does not
        // enter that code path, so give converted outputs the same one-day TTL.
        try { for (const name of readdirSync(dir)) { try { const old = join(dir, name), stat = statSync(old); if (stat.isFile() && Date.now() - stat.mtimeMs > 86400_000) unlinkSync(old) } catch {} } } catch {}
        const file = join(dir, randomUUID() + '.' + audio.ext); writeFileSync(file, audio.buf)
        return { file, engine: result.engine + '+rvc' }
      } catch (error) {
        if (!current() || settings.fallback === 'error') throw error
        api.log?.warn?.('RVC 转换失败，使用原声：', error.message)
        return { ...result, engine: result.engine + '+rvc-fallback', rvcError: error.message }
      }
    }

    api.route('/voice/test', async (req) => {
      const b = await http.body(req)
      const { file, engine } = await speak(String(b.text || '你好呀，我是大肥鱼'))
      const buf = readFileSync(file)
      const mime = { wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', silk: 'audio/silk', mp3: 'audio/mpeg' }[file.split('.').pop().toLowerCase()] || 'application/octet-stream'
      return { ok: true, engine, mime, data: buf.toString('base64') }
    })

    // DSH 自带语音识别：看状态 / 下载模型
    const stt = () => api.dsh.get('speechToText')
    api.route('/voice/asr-status', async () => {
      const s0 = stt()
      if (!s0 || typeof s0.snapshot !== 'function') return { ok: false, enabled: false, message: 'DSH 里没有开启「语音输入」插件' }
      const s = s0.snapshot()
      const p = s.providers.find((x) => x.id === s.selection.providerId)
      if (!p) return { ok: false, enabled: true, provider: s.selection.providerId, phase: 'unavailable', message: '选中的语音识别提供方不可用' }
      return { ok: true, enabled: true, provider: p?.id, phase: p?.preparation?.phase || 'ready', detail: p?.preparation }
    })
    api.route('/voice/asr-prepare', async () => {
      const s0 = stt()
      if (!s0 || typeof s0.snapshot !== 'function' || typeof s0.prepare !== 'function') return { ok: false, message: 'DSH 里没有开启「语音输入」插件' }
      const s = s0.snapshot()
      if (!s.providers.some((p) => p.id === s.selection.providerId)) return { ok: false, message: '选中的语音识别提供方不可用' }
      await s0.prepare(s.selection.providerId)
      return { ok: true, message: '开始准备本机识别模型，可在状态中查看下载和校验进度' }
    })
    // 自检「听语音」（真 QQ）：拿和某人私聊里最近一条语音，走一遍 get_record → 16k → DSH 识别
    api.route('/voice/asr-last', async (req) => {
      const b = await http.body(req)
      const uid = Number(b.userId || api.config().ownerQQ)
      const h = await onebot.call('get_friend_msg_history', { user_id: uid, count: 30 })
      const recs = (h?.messages || []).filter((m) => String(m.user_id) === String(uid)).flatMap((m) => (m.message || []).filter((s) => s.type === 'record').map((s) => ({ seg: s, time: m.time })))
      const last = recs.at(-1)
      if (!last) return { ok: false, message: '最近的聊天里没有对方发的语音' }
      const t = Date.now()
      const text = await hub.localTranscribe(last.seg)
      return { ok: Boolean(text), heard: text, at: new Date(last.time * 1000).toLocaleString(), ms: Date.now() - t }
    })
    // 自检：audioBase64 可复用已有录音（不调用 TTS）；省略时保留“合成一句再识别”的旧行为。
    api.route('/voice/asr-test', async (req) => {
      const b = await http.body(req)
      const s0 = stt()
      if (!s0 || typeof s0.resolve !== 'function' || typeof s0.transcribe !== 'function') return { ok: false, message: 'DSH 里没有开启语音识别（设置 → 插件 → 语音输入）' }
      const supplied = Object.hasOwn(b, 'audioBase64')
      const text = String(b.text || (supplied ? '' : '今天想吃白米饭'))
      if (typeof s0.snapshot === 'function') {
        const snapshot = s0.snapshot(), provider = snapshot.providers.find((p) => p.id === snapshot.selection.providerId)
        if (!provider) return { ok: false, message: '选中的语音识别提供方不可用' }
        if (provider.preparation && !['ready', 'standby'].includes(provider.preparation.phase)) return { ok: false, phase: provider.preparation.phase, message: '请先准备好语音识别模型，再进行自检' }
      }
      let raw
      if (supplied) raw = suppliedAudio(b.audioBase64)
      else {
        let file
        try { ({ file } = await speak(text)) } catch (error) { return { ok: false, message: '先在上面配好语音合成服务（自检要用它念一句）：' + error.message } }
        if (statSync(file).size > MAX_ASR_BYTES) throw new Error('ASR 音频超过 20 MiB')
        raw = readFileSync(file)
      }
      const t = Date.now()
      const signal = AbortSignal.timeout(120000)
      const spec = s0.resolve({ audio: new Uint8Array(await prepareAsrAudio(raw, { signal })) })
      const r = await s0.transcribe(spec, signal)
      signal.throwIfAborted()
      const heard = transcriptText(r)
      return { ok: Boolean(heard), said: text, heard, source: supplied ? 'provided-audio' : 'tts', ms: Date.now() - t }
    })

    return { speak }
  },
}

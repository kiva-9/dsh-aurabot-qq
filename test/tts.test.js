// 语音接口：模板填值的转义、JSON 取值、音频格式识别、旧设置迁移。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, basename } from 'node:path'
import { gzipSync } from 'node:zlib'
import { fill, pick, normalizeAudio, legacyTtsMapping, textToSpeech } from '../src/voice/tts.js'
import { buildWav, parseWav } from '../src/voice/wav.js'
import { normalize } from '../src/core/config.js'
import voiceModule, { prepareAsrAudio } from '../src/modules/voice/index.js'

test('模板：地址里 URL 转义、JSON 体里 JSON 转义，引号和换行不会把请求体弄坏', () => {
  const vars = { text: '他说"你好"\n再见 & 拜拜', voice: 'a', speed: 1.2 }
  assert.equal(fill('http://x/tts?t={text}', vars, 'url'), 'http://x/tts?t=' + encodeURIComponent(vars.text))
  const body = fill('{"input":"{text}","voice":"{voice}","speed":{speed}}', vars, 'json')
  assert.deepEqual(JSON.parse(body), { input: vars.text, voice: 'a', speed: 1.2 })
  assert.equal(fill('{unknown}', vars), '{unknown}', '不认识的占位符原样留着')
})

test('JSON 路径取值', () => {
  assert.equal(pick({ data: { audio: [{ b64: 'x' }] } }, 'data.audio.0.b64'), 'x')
  assert.equal(pick({}, 'a.b'), undefined)
})

// FFmpeg 编码的短静音（固定字节，跑测试不依赖 ffmpeg）；SILK 只验证有长度的容器帧。
const MP3 = Buffer.from('SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYzLjEuMTAwAAAAAAAAAAAAAAD/80TEAAAAA0gAAAAATEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy7/80TEUwAAA0gAAAAAMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy7/80TEpgAAA0gAAAAAMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/80TErAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/80TErAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=', 'base64')
const AAC = Buffer.from('//FYQANf/NwATGF2YzYzLjEuMTAwAAIwQA7/8VhAAX/8ARggB//xWEABf/wBGCAH', 'base64')
const FLAC = Buffer.from('ZkxhQ4AAACIEAAQAAAAAAAgVBdwA8AAAAAAAAAAAAAAAAAAAAAAAAAAA//inCAB8AAAA/XD/+HcIAQGfmQAAAFVZ', 'base64')
const OGG = Buffer.from('T2dnUwACAAAAAAAAAACQSE7VAAAAAFcaZLMBE09wdXNIZWFkAQE4AcBdAAAAAABPZ2dTAAAAAAAAAAAAAJBITtUBAAAAiMsRqwE8T3B1c1RhZ3MMAAAATGF2ZjYzLjEuMTAwAQAAABwAAABlbmNvZGVyPUxhdmM2My4xLjEwMCBsaWJvcHVzT2dnUwAEeAwAAAAAAACQSE7VAgAAAEQw9gcEAwMDA9j//tj//tj//tj//g==', 'base64')
const PCM = Buffer.alloc(1000, 1)
const WAV = buildWav(new Int16Array(500), 24000)
const SILK = Buffer.concat([Buffer.from('#!SILK_V3'), Buffer.from([4, 0, 1, 2, 3, 4, 255, 255])])

test('音频格式：WAV/MP3/AAC/FLAC/Ogg/SILK 分辨，短的完整编码音频也可识别', () => {
  for (const [buf, ext] of [[WAV, 'wav'], [MP3, 'mp3'], [AAC, 'aac'], [FLAC, 'flac'], [OGG, 'ogg'], [SILK, 'silk'], [Buffer.concat([Buffer.from([2]), SILK]), 'silk']]) {
    const result = normalizeAudio(buf)
    assert.equal(result.ext, ext); assert.equal(result.buf, buf)
  }
  // 去掉 ID3 后仍识别 MP3，AAC ADTS 的 0xfff1 不能误归 MP3。
  assert.equal(normalizeAudio(MP3.subarray(44)).ext, 'mp3')
  const streaming = Buffer.from(WAV); streaming.writeUInt32LE(0xffffffff, 4); streaming.writeUInt32LE(0xffffffff, 40)
  assert.equal(normalizeAudio(streaming).ext, 'wav')
})

test('未知字节拒绝；PCM 只有显式声明可封装，保留采样率/字节/不对齐切片', () => {
  for (const options of [{}, { format: 'auto' }, { contentType: 'audio/pcm' }, { format: 'mp3' }]) assert.throws(() => normalizeAudio(PCM, 24000, options), /必须显式配置/)
  for (const format of ['pcm', 'pcm_s16le']) {
    const pcm = normalizeAudio(PCM, 22050, { format })
    assert.equal(pcm.ext, 'wav'); assert.equal(pcm.buf.toString('ascii', 0, 4), 'RIFF')
    assert.equal(pcm.buf.readUInt32LE(24), 22050)
    assert.deepEqual(pcm.buf.subarray(44), PCM)
  }
  const unaligned = Buffer.from([0, 255, 255, 0, 128, 255, 127]).subarray(1)
  assert.deepEqual(normalizeAudio(unaligned, 24000, { format: 'pcm' }).buf.subarray(44), unaligned)
  assert.throws(() => normalizeAudio(Buffer.alloc(5), 24000, { format: 'pcm' }), /偶数/)
  for (const rate of [0, -1, 1.5, Infinity, 999999]) assert.throws(() => normalizeAudio(PCM, rate, { format: 'pcm' }), /采样率/)
})

test('错误页/JSON、仅文件头、截断容器及超限 bytes 均拒绝，不伪装为 PCM', () => {
  for (const text of ['  {"error":"quota exceeded"}', '\ufeff<html>failed</html>', '["error"]']) for (const format of ['', 'pcm']) assert.throws(() => normalizeAudio(Buffer.from(text), 24000, { format }), /不是音频/)
  for (const buf of [Buffer.from('ID3'), Buffer.concat([Buffer.from('ID3'), Buffer.alloc(500)]), WAV.subarray(0, 44), AAC.subarray(0, 8), FLAC.subarray(0, 42), OGG.subarray(0, 30), SILK.subarray(0, 12), Buffer.from([255, 255, 255, 255])]) assert.throws(() => normalizeAudio(buf))
  assert.throws(() => normalizeAudio(Buffer.alloc(0)), /太短/)
  assert.throws(() => normalizeAudio(Buffer.alloc(20 * 1024 * 1024 + 1)), /太大/)
})

test('旧设置迁移：CosyVoice / GPT-SoVITS / 通用模板换成 HTTP 映射；edge-tts、Windows 语音变成「没配」', () => {
  const c1 = normalize({ voice: { engine: 'cosyvoice', cosyvoice: { url: 'http://127.0.0.1:50000/', spkId: '中文男', sampleRate: 22050 } } })
  assert.equal(c1.voice.provider, 'http')
  assert.equal(c1.voice.httpApi.url, 'http://127.0.0.1:50000/inference_sft')
  assert.equal(c1.voice.httpApi.bodyType, 'form')
  assert.ok(c1.voice.httpApi.body.includes('spk_id=' + encodeURIComponent('中文男')))
  assert.equal(c1.voice.httpApi.audioFormat, 'pcm_s16le')
  assert.equal(legacyTtsMapping({ engine: 'cosyvoice', cosyvoice: { mode: 'instruct', instruct: '开心' } }).audioFormat, 'pcm_s16le')
  const c2 = normalize({ voice: { engine: 'gptsovits', gptsovits: { url: 'http://127.0.0.1:9880', refAudio: 'C:/a.wav' } } })
  assert.equal(c2.voice.httpApi.method, 'GET')
  assert.ok(c2.voice.httpApi.url.includes('ref_audio_path=' + encodeURIComponent('C:/a.wav')))
  assert.equal(normalize({ voice: { engine: 'http', http: { urlTemplate: 'http://x/?q={text}' } } }).voice.httpApi.url, 'http://x/?q={text}')
  assert.equal(normalize({ voice: { engine: 'edge' } }).voice.provider, 'none')
  assert.equal(normalize({ voice: { engine: 'windows' } }).voice.provider, 'none')
  assert.equal(legacyTtsMapping({ engine: 'auto' }), null)
  // 已经是新设置的不再按旧字段改
  assert.equal(normalize({ voice: { provider: 'openai', engine: 'cosyvoice' } }).voice.provider, 'openai')
})

let server, base, temp, previousDataDir
const seen = []
before(async () => {
  previousDataDir = process.env.AURABOT_DATA_DIR
  temp = mkdtempSync(join(tmpdir(), 'aurabot-tts-'))
  process.env.AURABOT_DATA_DIR = temp
  server = createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    seen.push({ path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() })
    const json = (data) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)) }
    if (req.url === '/v1/audio/speech' || req.url === '/pcm') { res.setHeader('content-type', 'audio/pcm'); return res.end(PCM) }
    if (req.url === '/wav') { res.setHeader('content-type', 'audio/wav'); return res.end(WAV) }
    if (req.url === '/mp3') { res.setHeader('content-type', 'audio/mpeg'); return res.end(MP3) }
    if (req.url === '/b64') return json({ data: { audio: PCM.toString('base64') } })
    if (req.url === '/bad-b64') return json({ data: { audio: '!!!!' + PCM.toString('base64') } })
    if (req.url === '/url') return json({ data: { audio: base + '/pcm' } })
    if (req.url === '/json-error') return json({ error: 'quota exceeded' })
    if (req.url === '/length') { res.writeHead(200, { 'content-length': 20 * 1024 * 1024 + 1 }); return res.flushHeaders() }
    if (req.url === '/compressed') { res.setHeader('content-encoding', 'gzip'); return res.end(gzipSync(Buffer.alloc(21 * 1024 * 1024))) }
    if (req.url === '/hang') { res.writeHead(200); return res.flushHeaders() }
    if (req.url === '/truncated') { res.writeHead(200, { 'content-length': 1000 }); res.write('partial'); return setImmediate(() => res.destroy()) }
    if (req.url === '/chunked' || req.url === '/error') {
      res.writeHead(req.url === '/error' ? 429 : 200)
      const chunk = Buffer.alloc(64 * 1024, 'x')
      let n = 0
      const send = () => {
        if (res.destroyed) return
        if (++n > 400) return res.end()
        if (res.write(chunk)) setImmediate(send)
        else res.once('drain', send)
      }
      return send()
    }
    res.writeHead(404); res.end('not found')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => {
  server?.closeAllConnections(); server?.close()
  if (previousDataDir === undefined) delete process.env.AURABOT_DATA_DIR
  else process.env.AURABOT_DATA_DIR = previousDataDir
  // Windows 递归清理前核实只删除本测试创建的临时目录。
  assert.equal(dirname(resolve(temp)), resolve(tmpdir()))
  assert.ok(basename(temp).startsWith('aurabot-tts-'))
  rmSync(temp, { recursive: true, force: true })
})
const http = (path, extra = {}) => ({ provider: 'http', httpApi: { method: 'POST', url: base + path, bodyType: 'json', body: '{"text":"{text}"}', response: 'audio', ...extra } })

test('真实 HTTP：OpenAI 仅 format:pcm 允许裸 PCM；response_format 如实发送', async () => {
  const config = { provider: 'openai', openai: { baseUrl: base + '/v1', model: 'mock-tts', apiKey: 'mock-key' } }
  await assert.rejects(textToSpeech('你好', config), /必须显式配置/)
  const result = await textToSpeech('你好', { ...config, openai: { ...config.openai, format: 'pcm' } })
  const wav = readFileSync(result.file)
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.deepEqual(wav.subarray(44), PCM)
  assert.equal(JSON.parse(seen.at(-1).body).response_format, 'pcm')
  assert.equal(seen.at(-1).headers.authorization, 'Bearer mock-key')
})

test('真实 HTTP：直接音频/JSON base64/JSON URL 都使用显式 audioFormat', async () => {
  for (const [path, response] of [['/pcm', 'audio'], ['/b64', 'json-base64'], ['/url', 'json-url']]) {
    const options = { response, jsonPath: 'data.audio', sampleRate: 22050 }
    await assert.rejects(textToSpeech('x', http(path, options)), /必须显式配置/)
    const result = await textToSpeech('x', http(path, { ...options, audioFormat: 'pcm_s16le' }))
    const wav = readFileSync(result.file)
    assert.deepEqual(wav.subarray(44), PCM)
    assert.equal(wav.readUInt32LE(24), 22050)
  }
  await assert.rejects(textToSpeech('x', http('/pcm', { audioFormat: 'pcm' })), /必须显式配置/, 'HTTP 只认明确的 pcm_s16le')
  const result = await textToSpeech('x', http('/wav'))
  assert.deepEqual(readFileSync(result.file), WAV)
  for (const path of ['/json-error', '/bad-b64']) await assert.rejects(textToSpeech('x', http(path, { response: path === '/bad-b64' ? 'json-base64' : 'audio', jsonPath: 'data.audio', audioFormat: 'pcm_s16le' })), /不是音频|base64/)
})

test('真实 HTTP：Content-Length、chunked、解压后字节都受 20 MiB 上限，失败不落盘', async () => {
  const cache = join(temp, 'voice-cache')
  const before = readdirSync(cache).length
  for (const path of ['/length', '/chunked', '/compressed']) await assert.rejects(textToSpeech('x', http(path, { audioFormat: 'pcm_s16le' })), /太大/)
  assert.equal(readdirSync(cache).length, before)
  await assert.rejects(textToSpeech('x', http('/error')), (e) => { assert.match(e.message, /HTTP 429/); assert.ok(e.message.length < 220); return true })
  await assert.rejects(textToSpeech('x', http('/truncated')))
  await assert.rejects(textToSpeech('x', http('/hang', { timeoutMs: 30 })))
})

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { windowsHide: true, timeout: 5000, stdio: 'ignore' }).status === 0
const requiresFfmpeg = { skip: hasFfmpeg ? false : '本机未安装 FFmpeg；压缩音频真实解码用例未执行' }

function asrRoutes({ service, voice = { provider: 'none' } } = {}) {
  const routes = new Map(), calls = []
  const speech = service ?? {
    snapshot: () => ({ selection: { providerId: 'local' }, providers: [{ id: 'local', preparation: { phase: 'ready' } }] }),
    resolve: (request) => { calls.push(request); return request },
    transcribe: async (_, signal) => { assert.ok(signal instanceof AbortSignal); return { text: ' 听到了 ', audioSeconds: 0.02, inferenceSeconds: 0.001 } },
  }
  voiceModule.setup({
    core: { hub: {}, onebot: {}, local: { active: () => false }, http: { body: async (req) => req } },
    config: () => ({ voice }), dsh: { get: (name) => name === 'speechToText' ? speech : undefined },
    route: (path, fn) => routes.set(path, fn),
  })
  return { routes, calls, speech }
}

test('ASR：PCM16 WAV 不依赖 FFmpeg，转换成 DSH 严格 44 字节头的 16k 单声道 WAV', async () => {
  const bytes = await prepareAsrAudio(WAV, { ffmpeg: 'missing-aurabot-ffmpeg-executable' })
  const parsed = parseWav(bytes)
  assert.equal(parsed.rate, 16000); assert.equal(parsed.channels, 1); assert.equal(parsed.bits, 16)
  assert.equal(bytes.readUInt32LE(4), bytes.length - 8)
  assert.equal(bytes.toString('ascii', 36, 40), 'data')
  assert.equal(bytes.readUInt32LE(40), bytes.length - 44)
})

test('ASR：未知/截断/超长音频、SILK、错位采样和取消均明确失败', async () => {
  for (const bytes of [PCM, WAV.subarray(0, 45), Buffer.from('ID3')]) await assert.rejects(prepareAsrAudio(bytes), /格式无效/)
  await assert.rejects(prepareAsrAudio(Buffer.alloc(20 * 1024 * 1024 + 1)), /20 MiB/)
  await assert.rejects(prepareAsrAudio(buildWav(new Int16Array(8000 * 120 + 1), 8000)), /120 秒/)
  await assert.rejects(prepareAsrAudio(SILK), /get_record/)
  const misaligned = Buffer.from(WAV); misaligned.writeUInt16LE(3, 22)
  await assert.rejects(prepareAsrAudio(misaligned), /数据长度/)
  const abort = new AbortController(); abort.abort(new Error('caller cancelled'))
  await assert.rejects(prepareAsrAudio(MP3, { signal: abort.signal }), /caller cancelled/)
  await assert.rejects(prepareAsrAudio(MP3, { timeoutMs: 0 }), /超时必须/)
  await assert.rejects(prepareAsrAudio(MP3, { ffmpeg: 'missing-aurabot-ffmpeg-executable' }), /未找到 FFmpeg/)
})

test('ASR：真实 FFmpeg 解码 MP3/AAC/FLAC/Ogg；解码后是有界标准 WAV', requiresFfmpeg, async () => {
  for (const bytes of [MP3, AAC, FLAC, OGG]) {
    const result = await prepareAsrAudio(bytes)
    const wav = parseWav(result)
    assert.equal(wav.rate, 16000); assert.equal(wav.channels, 1)
    assert.ok(wav.data.length > 0 && wav.data.length <= 120 * 32000)
    assert.equal(result.length, wav.data.length + 44)
  }
  await assert.rejects(prepareAsrAudio(MP3, { timeoutMs: 1 }), /解码超时/)
})

test('ASR：压缩长音频按解码字节中止，不能截取前 120 秒伪装完整识别', requiresFfmpeg, async () => {
  const encoded = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono',
    '-t', '121', '-f', 'flac', 'pipe:1'], { windowsHide: true, timeout: 5000, maxBuffer: 2 * 1024 * 1024 })
  assert.equal(encoded.status, 0)
  assert.ok(encoded.stdout.length < 20 * 1024 * 1024)
  await assert.rejects(prepareAsrAudio(encoded.stdout), /120 秒/)
})

test('ASR 自检：audioBase64 复用音频不调用 TTS，期望文本不传给识别器', async () => {
  const { routes, calls } = asrRoutes()
  const result = await routes.get('/voice/asr-test')({ text: '这只是核对原句', audioBase64: WAV.toString('base64') })
  assert.equal(result.ok, true); assert.equal(result.heard, '听到了')
  assert.equal(result.said, '这只是核对原句'); assert.equal(result.source, 'provided-audio')
  assert.deepEqual(Object.keys(calls[0]), ['audio'])
  assert.equal(parseWav(Buffer.from(calls[0].audio)).rate, 16000)
  const withoutExpected = await routes.get('/voice/asr-test')({ audioBase64: WAV.toString('base64') })
  assert.equal(withoutExpected.said, '', '未提供原句时不能声称音频说了默认 TTS 文本')
})

test('ASR 自检：非法 base64 不回退付费合成，不调用识别', async () => {
  const { routes, calls } = asrRoutes()
  for (const audioBase64 of ['', null, '!!!', WAV.toString('base64') + '\n', 'A'.repeat(Math.ceil(20 * 1024 * 1024 / 3) * 4 + 4)]) {
    await assert.rejects(routes.get('/voice/asr-test')({ audioBase64 }), /base64|Base64/)
  }
  assert.equal(calls.length, 0)
})

test('ASR 自检：空文本、只有元数据或错误对象不能伪报识别成功', async () => {
  for (const response of [{ text: '' }, { text: '   ', transcript: '不要复活' }, { audioSeconds: 1 }, { error: 'failed' }, null]) {
    const { routes, speech } = asrRoutes(); speech.transcribe = async () => response
    const result = await routes.get('/voice/asr-test')({ audioBase64: WAV.toString('base64') })
    assert.equal(result.ok, false); assert.equal(result.heard, '')
  }
})

test('ASR 自检：准备中和选中提供方缺失先失败，避免无谓 TTS 调用或静默替换提供方', async () => {
  const { routes, speech, calls } = asrRoutes()
  speech.snapshot = () => ({ selection: { providerId: 'local' }, providers: [{ id: 'local', preparation: { phase: 'downloading' } }] })
  assert.equal((await routes.get('/voice/asr-test')({})).phase, 'downloading')
  speech.snapshot = () => ({ selection: { providerId: 'missing' }, providers: [{ id: 'local', preparation: { phase: 'ready' } }] })
  const status = await routes.get('/voice/asr-status')()
  assert.equal(status.ok, false); assert.equal(status.phase, 'unavailable'); assert.equal(status.provider, 'missing')
  assert.equal((await routes.get('/voice/asr-test')({})).ok, false)
  assert.equal(calls.length, 0)
})

test('ASR 准备：异步失败不能先报告成功，保持明确提供方', async () => {
  const { routes, speech } = asrRoutes()
  speech.prepare = async (id) => { assert.equal(id, 'local'); throw new Error('download unavailable') }
  await assert.rejects(routes.get('/voice/asr-prepare')(), /download unavailable/)
})

test('ASR 自检：旧 TTS HTTP 返回 MP3 时先真实解码，不再当作 WAV 读取', requiresFfmpeg, async () => {
  const { routes, calls } = asrRoutes({ voice: http('/mp3') })
  const before = seen.length
  const result = await routes.get('/voice/asr-test')({ text: '测试' })
  assert.equal(result.ok, true); assert.equal(result.source, 'tts')
  assert.equal(seen.length, before + 1)
  assert.equal(parseWav(Buffer.from(calls[0].audio)).rate, 16000)
})

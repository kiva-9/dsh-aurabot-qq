// 语音接口：模板填值的转义、JSON 取值、音频格式识别、旧设置迁移。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fill, pick, normalizeAudio, legacyTtsMapping } from '../src/voice/tts.js'
import { normalize } from '../src/core/config.js'

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

test('音频格式：WAV / MP3 原样，裸 PCM 包成 WAV，JSON 报错说清楚', () => {
  const riff = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(500)])
  assert.equal(normalizeAudio(riff).ext, 'wav')
  assert.equal(normalizeAudio(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(500)])).ext, 'mp3')
  const pcm = normalizeAudio(Buffer.alloc(1000, 1), 22050)
  assert.equal(pcm.ext, 'wav')
  assert.equal(pcm.buf.toString('ascii', 0, 4), 'RIFF')
  assert.throws(() => normalizeAudio(Buffer.from('{"error":"quota exceeded"}'.padEnd(500, ' '))), /不是音频/)
  assert.throws(() => normalizeAudio(Buffer.alloc(10)), /太短/)
})

test('旧设置迁移：CosyVoice / GPT-SoVITS / 通用模板换成 HTTP 映射；edge-tts、Windows 语音变成「没配」', () => {
  const c1 = normalize({ voice: { engine: 'cosyvoice', cosyvoice: { url: 'http://127.0.0.1:50000/', spkId: '中文男', sampleRate: 22050 } } })
  assert.equal(c1.voice.provider, 'http')
  assert.equal(c1.voice.httpApi.url, 'http://127.0.0.1:50000/inference_sft')
  assert.equal(c1.voice.httpApi.bodyType, 'form')
  assert.ok(c1.voice.httpApi.body.includes('spk_id=' + encodeURIComponent('中文男')))
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

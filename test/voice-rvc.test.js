import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import voice from '../src/modules/voice/index.js'
import { createSongStudio } from '../src/song/studio.js'
import { buildWav } from '../src/voice/wav.js'

test('direct speech entry cleans emoji before TTS and rejects an empty result without calling it', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-clean-')), input = join(dir, 'input.wav'); writeFileSync(input, 'audio')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let calls = 0, text
  const cfg = { enabled: true, botQQ: '1', voice: { enabled: true, rvc: { enabled: false } } }
  const api = { config: () => cfg, core: { hub: {}, storage: { epochs: { current: () => 0 }, requests: {} },
    local: { active: () => true, call: async (_name, args) => { calls++; text = args.text; return { file: input } } }, onebot: {}, http: {} }, route() {} }
  const module = voice.setup(api)
  await assert.rejects(module.speak('👩🏽‍💻 🇭🇰 <face:笑>'), /没有可朗读文字/)
  assert.equal(calls, 0)
  await module.speak('中文😀 12kg，©2026')
  assert.equal(calls, 1); assert.equal(text, '中文 12kg，©2026')
})

test('RVC uses persona override and falls back only while request remains current', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-rvc-')), input = join(dir, 'input.wav')
  writeFileSync(input, Buffer.from('original'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const cfg = { enabled: true, botQQ: '1', voice: { enabled: true, rvc: { enabled: true, voice: 'default', fallback: 'original' } } }
  let epoch = 0, called
  const api = { config: () => cfg, log: { warn() {} }, core: { hub: { personaFor: () => ({ personaId: 'p' }) },
    storage: { epochs: { current: () => epoch }, requests: { get: () => ({ chatId: 'private:2', state: 'active' }) } },
    local: { active: () => true, call: async () => ({ file: input }) }, onebot: {}, http: {} },
    route() {}, lazy: () => ({ convertSpeech: async (_file, options) => { called = options.voice; throw new Error('unavailable') } }) }
  const module = voice.setup(api)
  const profile = { chatId: 'private:2', requestId: 'r', rvc: { voice: 'persona' } }
  const fallback = await module.speak('hello', profile)
  assert.equal(called, 'persona'); assert.match(fallback.engine, /rvc-fallback/)
  api.lazy = () => ({ convertSpeech: async () => { epoch++; throw new Error('cancel') } })
  await assert.rejects(module.speak('hello', profile), /cancel/)
})

test('successful RVC output is validated and persisted in a fresh voice cache; dispose cancels in-flight work', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rvc-output-')), previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const input = join(dir, 'input.wav'); writeFileSync(input, Buffer.from('original'))
  const cfg = { enabled: true, botQQ: '1', voice: { enabled: true, rvc: { enabled: true, fallback: 'error' } } }
  const wav = buildWav(new Int16Array(160), 16000)
  let dispose, release, entered, wait = false
  const blocked = new Promise(r => { release = r }), started = new Promise(r => { entered = r })
  const api = { config: () => cfg, log: { warn() {} }, core: { hub: { personaFor: () => ({ personaId: 'p' }) },
    storage: { epochs: { current: () => 0 }, requests: { get: () => ({ chatId: 'private:2', state: 'open' }) } },
    local: { active: () => true, call: async () => ({ file: input }) }, onebot: {}, http: {} },
    route() {}, onDispose: f => { dispose = f }, lazy: () => ({ convertSpeech: async () => { if (wait) { entered(); await blocked }; return wav } }) }
  const module = voice.setup(api), profile = { chatId: 'private:2', requestId: 'r' }
  t.after(() => { dispose(); if (previous === undefined) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = previous; rmSync(dir, { recursive: true, force: true }) })
  const first = await module.speak('hello', profile)
  assert.equal(first.engine, 'local+rvc'); assert.deepEqual(readFileSync(first.file), wav)
  const stale = join(dir, 'voice-cache', 'stale.wav'); writeFileSync(stale, wav)
  const old = new Date(Date.now() - 2 * 86400_000); utimesSync(stale, old, old)
  await module.speak('hello', profile); assert.equal(existsSync(stale), false)
  wait = true
  const pending = module.speak('hello', profile); await started; dispose(); release()
  await assert.rejects(pending, /取消/)
})

test('RVC local converter serializes work, cancels promptly and cleans temporary files after an uncooperative call settles', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rvc-studio-')), previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const input = join(dir, 'input.wav'); writeFileSync(input, Buffer.from('source'))
  const cfg = { song: { root: join(dir, 'engine') } }
  let release, entered
  const wait = new Promise(r => { release = r }), start = new Promise(r => { entered = r })
  let calls = 0
  const local = { active: () => true, call: async (_name, args) => { calls++; assert.equal(args.voice, 'persona'); entered(); await wait; writeFileSync(args.output, Buffer.from('converted')); return args.output } }
  const studio = createSongStudio({ getConfig: () => cfg, local, log: { warn() {} } })
  t.after(() => { studio.stop(); if (previous === undefined) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = previous; rmSync(dir, { recursive: true, force: true }) })
  const controller = new AbortController(), first = studio.convertSpeech(input, { voice: 'persona', signal: controller.signal })
  await start
  await assert.rejects(studio.convertSpeech(input), /正忙/)
  controller.abort(new Error('test canceled'))
  await assert.rejects(first, /test canceled/)
  await assert.rejects(studio.convertSpeech(input), /正忙/, '不能提前放开还在运行的本地转换器')
  release()
  await new Promise(r => setImmediate(r))
  assert.deepEqual(readdirSync(join(dir, 'songs')).filter(x => x.startsWith('speech-')), [])
  const next = await studio.convertSpeech(input, { voice: 'persona' })
  assert.equal(next.toString(), 'converted'); assert.equal(calls, 2)
})

test('RVC refuses changed converter settings and dispose while conversion is in flight', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rvc-revoke-')), previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const input = join(dir, 'input.wav'); writeFileSync(input, Buffer.from('source'))
  const cfg = { song: { root: join(dir, 'engine') } }
  let release, entered
  const wait = new Promise(r => { release = r }), start = new Promise(r => { entered = r })
  const studio = createSongStudio({ getConfig: () => cfg, local: { active: () => true, call: async (_name, args) => { entered(); await wait; writeFileSync(args.output, Buffer.from('converted')); return args.output } }, log: { warn() {} } })
  t.after(() => { studio.stop(); if (previous === undefined) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = previous; rmSync(dir, { recursive: true, force: true }) })
  const pending = studio.convertSpeech(input); await start
  cfg.song.root = join(dir, 'different-engine'); release()
  await assert.rejects(pending, /配置已改变/)
  assert.equal(existsSync(join(dir, 'songs')) && readdirSync(join(dir, 'songs')).some(x => x.startsWith('speech-')), false)
  studio.stop()
  await assert.rejects(studio.convertSpeech(input), /取消/)
})

test('RVC discards output if the selected voice model changes during conversion', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rvc-voice-')), previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const input = join(dir, 'input.wav'), models = join(dir, 'engine', 'models')
  mkdirSync(models, { recursive: true }); writeFileSync(input, 'source'); writeFileSync(join(models, 'selected.pth'), 'old')
  let release, entered
  const wait = new Promise(r => { release = r }), start = new Promise(r => { entered = r })
  const studio = createSongStudio({ getConfig: () => ({ song: { root: join(dir, 'engine') } }), local: { active: () => true,
    call: async (_name, args) => { entered(); await wait; writeFileSync(args.output, 'converted'); return args.output } }, log: { warn() {} } })
  t.after(() => { studio.stop(); if (previous === undefined) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = previous; rmSync(dir, { recursive: true, force: true }) })
  const pending = studio.convertSpeech(input, { voice: 'selected' }); await start
  writeFileSync(join(models, 'selected.pth'), 'new-model-bytes'); release()
  await assert.rejects(pending, /配置已改变/)
})

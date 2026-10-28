// Mock contract tests only. This file never reads real credentials or calls a supplier.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { derivePrivateConfig, imageProfile, productionImageProfile, speechConfig, createGrsaiBridge, createNativePollProbe, reserveAttempt, markDispatch, safeFailure } from '../scripts/live-media-check.mjs'
import { adapterFor } from '../src/providers/image/index.js'
import { validateHttpProfile } from '../src/providers/image/http.js'
import { fill } from '../src/voice/tts.js'
import { PNG } from './helpers/images.js'

const IMAGE_KEY = 'mock-image-credential', TTS_KEY = 'mock-tts-credential'
const imageSource = [
  `const API_KEY = process.env.GRSAI_API_KEY || '${IMAGE_KEY}';`,
  "const HOST = 'https://supplier.invalid'; const MODEL = 'gpt-image-2.5'; const QUALITY = '';",
  'async function image({urls}) { const refs = urls; await fetch(`${HOST}/v1/draw/completions`); await fetch(`${HOST}/v1/draw/result`); }',
].join('\n')
const voiceSource = [
  `const API_KEY = process.env.STEPFUN_API_KEY || '${TTS_KEY}';`,
  "const MODEL = 'stepaudio-3-tts'; const VOICE = 'yuanqishaonv'; const INSTRUCTION = '轻松讲述。';",
  "async function tts() { await fetch('https://speech.invalid/v1/audio/speech'); }",
].join('\n')
const config = () => derivePrivateConfig({ local: { image: true, tts: true }, imageGen: { size: '1024x1024' } }, imageSource, voiceSource, 'local.call')
const report = () => ({ attempts: [] })
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })

test('只从给定旧文件文字读取既有配置，不执行旧脚本或读取环境凭据', () => {
  const before = process.env.GRSAI_API_KEY
  process.env.GRSAI_API_KEY = 'do-not-read-environment'
  try {
    const derived = config()
    assert.equal(derived.image.apiKey, IMAGE_KEY)
    assert.equal(derived.tts.apiKey, TTS_KEY)
    assert.equal(derived.image.model, 'gpt-image-2.5')
    assert.equal(derived.tts.voice, 'yuanqishaonv')
    assert.equal(derived.image.referenceInputConfigured, true)
  } finally { if (before === undefined) delete process.env.GRSAI_API_KEY; else process.env.GRSAI_API_KEY = before }
})

test('缺配置、替换供应商路由或来源未启用都在提交前拒绝', () => {
  assert.throws(() => derivePrivateConfig({ local: {} }, imageSource, voiceSource, 'local.call'))
  assert.throws(() => derivePrivateConfig({ local: { image: true, tts: true } }, imageSource.replace(/const MODEL[^;]+;/, ''), voiceSource, 'local.call'))
  assert.throws(() => derivePrivateConfig({ local: { image: true, tts: true } }, imageSource.replace('/v1/draw/result', '/unexpected'), voiceSource, 'local.call'))
  assert.throws(() => derivePrivateConfig({ local: { image: true, tts: true } }, imageSource, voiceSource.replace('/v1/audio/speech', '/v1/audio/speech?token=private'), 'local.call'))
})

test('通用 HTTP profile 可校验；明确保留异步模式和参考图能力', () => {
  const profile = imageProfile(config().image)
  assert.deepEqual(validateHttpProfile(profile), [])
  const { caps } = adapterFor(profile)
  assert.deepEqual(caps.modes, ['text', 'edit'])
  assert.equal(caps.maxInputs, 1)
  assert.equal(caps.async, true)
  assert.equal(caps.idempotent, false, '不能把本地请求去重当作供应商幂等支持')
})

test('真实新适配器经 mock 转换层：原 POST 提交、POST JSON 轮询、无鉴权结果下载', async () => {
  const c = config().image, state = report(), attempt = reserveAttempt(state, 'image_generate', 'image')
  const calls = [], durable = [], ids = []
  const fetchImpl = createGrsaiBridge(c, {
    attempt, persist: () => durable.push(structuredClone(state)), onTaskId: id => ids.push(id),
    fetchImpl: async (url, init) => {
      const headers = new Headers(init.headers)
      calls.push({ url, init, headers })
      if (url === c.submitUrl) {
        assert.equal(durable.at(-1).attempts[0].dispatched, true, '发送前已记录请求')
        assert.equal(headers.get('authorization'), 'Bearer ' + IMAGE_KEY)
        const body = JSON.parse(init.body)
        assert.equal(body.model, c.model); assert.equal(body.webHook, '-1')
        assert.equal(body.prompt, '画蓝鲸 "{apiKey}"'); assert.equal(body.urls, undefined)
        assert.equal(init.redirect, 'error')
        return json({ code: 0, data: { id: 'task-private-token' } })
      }
      if (url === c.statusUrl) {
        assert.deepEqual(JSON.parse(init.body), { id: 'task-private-token' })
        assert.equal(headers.get('content-type'), 'application/json')
        return json({ code: 0, data: { status: 'succeeded', results: [{ url: 'https://cdn.invalid/output?signature=private' }] } })
      }
      assert.equal(url, 'https://cdn.invalid/output?signature=private')
      assert.equal(headers.has('authorization'), false)
      return new Response(PNG, { headers: { 'content-type': 'image/png' } })
    },
  })
  const { adapter } = adapterFor(imageProfile(c), { fetchImpl })
  const started = await adapter.submit({ mode: 'text', prompt: '画蓝鲸 "{apiKey}"', size: '1024x1024', n: 1, inputs: [] })
  assert.equal(started.status, 'running')
  const done = await adapter.poll(started.providerTaskId)
  assert.equal(done.status, 'done')
  assert.deepEqual(done.outputs[0].buf, PNG)
  assert.deepEqual(ids, ['task-private-token'])
  assert.deepEqual(calls.map(c => c.init.method), ['POST', 'POST', 'GET'])
  const persisted = JSON.stringify(state)
  for (const sensitive of [IMAGE_KEY, 'task-private-token', 'signature=private', 'https://cdn.invalid']) assert.equal(persisted.includes(sensitive), false)
})

test('参考图转换保留同一张底图的字节，写下哈希血缘而非记录 data URL', async () => {
  const c = config().image, state = report(), attempt = reserveAttempt(state, 'image_edit', 'image')
  let sent
  const bridge = createGrsaiBridge(c, { attempt, fetchImpl: async (url, init) => {
    sent = JSON.parse(init.body)
    return json({ code: 0, data: { id: 'id' } })
  } })
  const { adapter } = adapterFor(imageProfile(c), { fetchImpl: bridge })
  await adapter.submit({ mode: 'edit', prompt: '只增加海星', size: '1024x1024', n: 1, inputs: [{ buf: PNG, mime: 'image/png', role: 'base' }] })
  assert.deepEqual(sent.urls, ['data:image/png;base64,' + PNG.toString('base64')])
  assert.equal(attempt.referenceTransmitted.bytes, PNG.length)
  assert.match(attempt.referenceTransmitted.sha256, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(state).includes(PNG.toString('base64')), false)
})

test('unknown、失败或进程中断留下的 reservation 都阻止重提同一请求', () => {
  for (const status of ['reserved', 'submitting', 'failed_or_unknown', 'succeeded']) {
    const state = report(), attempt = reserveAttempt(state, 'image_generate', 'image')
    attempt.state = status
    assert.throws(() => reserveAttempt(state, 'image_generate', 'image'), /ATTEMPT_ALREADY/)
  }
  const state = report(), attempt = reserveAttempt(state, 'tts', 'tts')
  markDispatch(attempt)
  assert.throws(() => markDispatch(attempt), /DUPLICATE_SUBMISSION/)
  assert.throws(() => reserveAttempt(state, 'tts', 'tts'))
  reserveAttempt(state, 'image_generate', 'image'); reserveAttempt(state, 'image_edit', 'image')
  assert.throws(() => reserveAttempt(state, 'another_image', 'image'))
  assert.equal(state.attempts.length, 3)
})

test('网络 unknown 不会触发第二次收费提交；错误与响应不进入公开报告', async () => {
  const c = config().image, state = report(), attempt = reserveAttempt(state, 'image_generate', 'image')
  let calls = 0
  const bridge = createGrsaiBridge(c, { attempt, fetchImpl: async () => { calls++; throw new Error(`secret=${IMAGE_KEY}; https://bad.invalid/?token=private`) } })
  const { adapter } = adapterFor(imageProfile(c), { fetchImpl: bridge })
  let error
  try { await adapter.submit({ mode: 'text', prompt: '蓝鲸', inputs: [] }) } catch (e) { error = e }
  const failure = safeFailure(error, attempt)
  assert.equal(failure.mayHaveBeenCharged, true)
  assert.equal(failure.resubmit, false)
  assert.equal(calls, 1)
  await assert.rejects(adapter.submit({ mode: 'text', prompt: '蓝鲸', inputs: [] }))
  assert.equal(calls, 1)
  assert.equal(JSON.stringify(failure).includes(IMAGE_KEY), false)
  assert.equal(JSON.stringify(failure).includes('token='), false)
})

test('原 TTS 模型、音色、instruction 走新固定 HTTP 模板，无自动换模型', () => {
  const c = config().tts, next = speechConfig(c)
  assert.equal(next.provider, 'http')
  assert.equal(next.httpApi.url, c.url)
  const payload = JSON.parse(fill(next.httpApi.body, { text: '你好 "朋友"\n慢慢说', voice: c.voice, speed: 1, apiKey: c.apiKey }, 'json'))
  assert.deepEqual(payload, { model: c.model, input: '你好 "朋友"\n慢慢说', voice: c.voice, response_format: 'mp3', instruction: c.instruction })
  assert.equal(JSON.stringify(payload).includes(TTS_KEY), false)
})

test('转换层阻止意外 QQ/第三方 POST，以及跨站携带供应商鉴权', async () => {
  const c = config().image, attempt = reserveAttempt(report(), 'image_generate', 'image')
  let calls = 0
  const bridge = createGrsaiBridge(c, { attempt, fetchImpl: async () => { calls++; return json({}) } })
  await assert.rejects(bridge('http://127.0.0.1:3000/send_msg', { method: 'POST', body: '{}' }))
  await assert.rejects(bridge('https://cdn.invalid/x', { method: 'GET', headers: { authorization: 'Bearer ' + IMAGE_KEY } }))
  assert.equal(calls, 0)
})

test('生产 profile 直接使用原生适配器：text/reference 限制、固定供应商、无 bridge 数据 URL 编码', async () => {
  const c = config().image, profile = productionImageProfile(c)
  assert.deepEqual(validateHttpProfile(profile), [])
  assert.deepEqual(profile.capabilities.modes, ['text', 'reference'])
  assert.equal(profile.extra.status.url, c.statusUrl)
  assert.equal(profile.extra.status.bodyType, 'json')
  assert.equal(profile.extra.status.body, '{"id":"{taskId}"}')
  let calls = 0
  const { adapter, caps } = adapterFor(profile, { fetchImpl: async (url, init) => {
    calls++
    assert.equal(url, c.submitUrl)
    assert.equal(init.method, 'POST')
    const body = JSON.parse(init.body)
    assert.equal(body.model, c.model)
    assert.equal(body.prompt, '蓝鲸 {apiKey}')
    assert.equal(body.webHook, '-1')
    assert.deepEqual(body.urls, ['data:image/png;base64,' + PNG.toString('base64')])
    return json({ code: 0, data: { id: 'native-task' } })
  } })
  assert.deepEqual(caps.modes, ['text', 'reference'])
  assert.equal(caps.maxInputs, 1)
  assert.equal(caps.idempotent, false)
  assert.equal(caps.cancel, false)
  const result = await adapter.submit({ mode: 'reference', prompt: '蓝鲸 {apiKey}', size: '1024x1024', inputs: [{ buf: PNG, mime: 'image/png', role: 'base' }] })
  assert.equal(result.status, 'running')
  assert.equal(calls, 1)
})

test('原生轮询观察器不转换 URL/body：只查已有任务并下载其输出，公开证据不含鉴权/任务号/签名 URL', async () => {
  const c = config().image, evidence = { trace: [] }, calls = []
  const fetchImpl = createNativePollProbe(c, 'existing-private-task', { evidence, fetchImpl: async (url, init) => {
    calls.push({ url, init })
    if (url === c.statusUrl) {
      assert.equal(init.body, '{"id":"existing-private-task"}')
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + IMAGE_KEY)
      assert.equal(init.redirect, 'error')
      return json({ code: 0, data: { status: 'succeeded', results: [{ url: 'https://cdn.invalid/result?signature=private' }] } })
    }
    assert.equal(url, 'https://cdn.invalid/result?signature=private')
    assert.equal(new Headers(init.headers).has('authorization'), false)
    return new Response(PNG, { headers: { 'content-type': 'image/png' } })
  } })
  const { adapter } = adapterFor(productionImageProfile(c), { fetchImpl })
  const result = await adapter.poll('existing-private-task')
  assert.equal(result.status, 'done')
  assert.deepEqual(result.outputs[0].buf, PNG)
  assert.equal(evidence.jsonBodyVerified, true)
  assert.deepEqual(calls.map(call => call.init.method), ['POST', 'GET'])
  for (const value of [IMAGE_KEY, 'existing-private-task', 'signature=private', 'https://cdn.invalid']) assert.equal(JSON.stringify(evidence).includes(value), false)
  await assert.rejects(adapter.poll('existing-private-task'))
  assert.equal(calls.length, 2, '同一观察器只允许一次轮询，不会循环补发')
})

test('原生验证器只允许已知 status body；收费提交、其他任务、任意下载和 QQ 路由全拒绝', async () => {
  const c = config().image, evidence = { trace: [] }
  let calls = 0
  const probe = createNativePollProbe(c, 'known-task', { evidence, fetchImpl: async () => { calls++; return json({}) } })
  const auth = { authorization: 'Bearer ' + IMAGE_KEY, 'content-type': 'application/json' }
  for (const [url, init] of [
    [c.submitUrl, { method: 'POST', headers: auth, body: '{}' }],
    [c.statusUrl, { method: 'POST', headers: auth, body: '{"id":"other-task"}' }],
    [c.statusUrl, { method: 'POST', headers: auth, body: '{"id":"known-task","unexpected":true}' }],
    ['https://cdn.invalid/arbitrary', { method: 'GET' }],
    ['http://127.0.0.1:3000/send_msg', { method: 'POST', body: '{}' }],
  ]) await assert.rejects(probe(url, init))
  assert.equal(calls, 0)
})

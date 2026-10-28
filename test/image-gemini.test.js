// Gemini 生图适配器：请求形状、多图角色说明、宽高比映射、审核拦截、只回文字、HTTP 错误归类、结果解码。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createGeminiImages, aspectRatioFor } from '../src/providers/image/gemini.js'
import { checkRequest, mergeCapabilities } from '../src/providers/image/common.js'

const PNG = Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n\x1a\n'), Buffer.alloc(32, 7)])
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(32, 1)])
const imagePart = (buf = PNG) => ({ inlineData: { mimeType: 'image/png', data: buf.toString('base64') } })

// 本地假服务：记下收到的请求，按 next 回复
const seen = []
let next = () => ({ status: 200, body: { candidates: [{ content: { parts: [imagePart()] } }] } })
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null })
    const { status, body } = next()
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })
})
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const baseUrl = `http://127.0.0.1:${server.address().port}/v1beta`
after(() => server.close())

const adapter = (extra = {}) => createGeminiImages({ baseUrl, apiKey: 'test-key', model: 'gemini-2.5-flash-image', extra })
const reply = (status, body) => { next = () => ({ status, body }) }
const last = () => seen[seen.length - 1]

test('宽高比：按最接近的受支持比例取，解析不了返回空', () => {
  assert.equal(aspectRatioFor('1024x1024'), '1:1')
  assert.equal(aspectRatioFor('1792x1024'), '16:9')
  assert.equal(aspectRatioFor('1024x1792'), '9:16')
  assert.equal(aspectRatioFor('1536x1024'), '3:2')
  assert.equal(aspectRatioFor('1024x1536'), '2:3')
  assert.equal(aspectRatioFor('2560x1080'), '21:9')
  assert.equal(aspectRatioFor('1200x1000'), '5:4')
  assert.equal(aspectRatioFor('800x1000'), '4:5')
  assert.equal(aspectRatioFor('1024x768'), '4:3')
  assert.equal(aspectRatioFor(''), '')
  assert.equal(aspectRatioFor('auto'), '')
  assert.equal(aspectRatioFor('0x100'), '')
})

test('能力：没有蒙版编辑，蒙版请求被 checkRequest 挡住；最多输入图默认 3、可调到 14', () => {
  const caps = adapter().capabilities()
  assert.deepEqual(caps.modes, ['text', 'reference', 'edit'])
  assert.equal(caps.maxInputs, 3)
  assert.equal(caps.async, false)
  assert.equal(caps.idempotent, false)
  assert.equal(adapter({ maxInputs: 99 }).capabilities().maxInputs, 14)
  assert.equal(adapter({ maxInputs: 1 }).capabilities().maxInputs, 1)
  const merged = mergeCapabilities(caps)
  const why = checkRequest({ mode: 'mask', prompt: 'x', inputs: [{ buf: PNG, mime: 'image/png', role: 'base' }], mask: { buf: PNG, mime: 'image/png' } }, merged)
  assert.match(why, /不支持/)
})

test('文生图：地址、密钥头、generationConfig，不带任何图', async () => {
  reply(200, { candidates: [{ content: { parts: [{ text: '好的' }, imagePart()] } }] })
  const r = await adapter().submit({ mode: 'text', prompt: '一只猫', size: '1792x1024', n: 1, inputs: [] })
  const q = last()
  assert.equal(q.method, 'POST')
  assert.equal(q.url, '/v1beta/models/gemini-2.5-flash-image:generateContent')
  assert.equal(q.headers['x-goog-api-key'], 'test-key')
  assert.deepEqual(q.body.generationConfig, { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9' } })
  assert.equal(q.body.contents.length, 1)
  assert.equal(q.body.contents[0].role, 'user')
  const parts = q.body.contents[0].parts
  assert.equal(parts.length, 1)
  assert.ok(!parts.some((p) => p.inlineData || p.inline_data))
  assert.match(parts[0].text, /一只猫/)
  assert.equal(r.status, 'done')
  assert.equal(r.billing, 'charged')
  assert.equal(r.outputs.length, 1)
  assert.equal(r.outputs[0].mime, 'image/png')
  assert.ok(r.outputs[0].buf.equals(PNG))
})

test('没给尺寸时用 extra.aspectRatio，extra.responseModalities 覆盖默认', async () => {
  reply(200, { candidates: [{ content: { parts: [imagePart()] } }] })
  await adapter({ aspectRatio: '3:4', responseModalities: ['IMAGE'] }).submit({ mode: 'text', prompt: 'x', inputs: [] })
  assert.deepEqual(last().body.generationConfig, { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '3:4' } })
  await adapter().submit({ mode: 'text', prompt: 'x', inputs: [] })
  assert.equal(last().body.generationConfig.imageConfig, undefined)
})

test('原图编辑：底图排第一，按顺序说明每张图的角色，并要求保留底图', async () => {
  reply(200, { candidates: [{ content: { parts: [imagePart(), { inline_data: { mime_type: 'image/png', data: PNG.toString('base64') } }] } }] })
  const r = await adapter().submit({
    mode: 'edit', prompt: '把背景换成海边', size: '1024x1024', n: 1,
    inputs: [
      { buf: JPG, mime: 'image/jpeg', role: 'identity' },
      { buf: PNG, mime: 'image/png', role: 'base' },
      { buf: JPG, mime: 'image/jpeg', role: 'style' },
    ],
  })
  const parts = last().body.contents[0].parts
  assert.equal(parts.length, 4)
  assert.deepEqual(parts[0], { inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } })
  assert.equal(parts[1].inlineData.mimeType, 'image/jpeg')
  assert.equal(parts[1].inlineData.data, JPG.toString('base64'))
  assert.equal(parts[2].inlineData.mimeType, 'image/jpeg')
  const text = parts[3].text
  assert.match(text, /图1 是底图（在它上面改）/)
  assert.match(text, /图2 是人物身份参考（保持长相）/)
  assert.match(text, /图3 是风格参考/)
  assert.match(text, /保留/)
  assert.ok(text.indexOf('图1') < text.indexOf('图2') && text.indexOf('图3') < text.indexOf('把背景换成海边'))
  // inlineData 和 inline_data 两种写法的结果都收
  assert.equal(r.outputs.length, 2)
  assert.ok(r.outputs.every((o) => o.mime === 'image/png' && o.buf.equals(PNG)))
})

test('参考图生成：构图参考，不要求保留底图', async () => {
  reply(200, { candidates: [{ content: { parts: [imagePart()] } }] })
  await adapter().submit({ mode: 'reference', prompt: '赛博朋克城市', inputs: [{ buf: PNG, mime: 'image/png', role: 'composition' }] })
  const parts = last().body.contents[0].parts
  assert.equal(parts.length, 2)
  assert.match(parts[1].text, /图1 是构图参考/)
  assert.doesNotMatch(parts[1].text, /保留/)
})

test('文生图即使带了输入图也不发图', async () => {
  reply(200, { candidates: [{ content: { parts: [imagePart()] } }] })
  await adapter().submit({ mode: 'text', prompt: 'x', inputs: [{ buf: PNG, mime: 'image/png', role: 'style' }] })
  assert.equal(last().body.contents[0].parts.length, 1)
})

test('审核拦截 → invalid', async () => {
  reply(200, { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } })
  await assert.rejects(adapter().submit({ mode: 'text', prompt: 'x', inputs: [] }), (e) => e.kind === 'invalid' && /审核/.test(e.message) && !e.retryable)
  reply(200, { candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [] } }] })
  await assert.rejects(adapter().submit({ mode: 'text', prompt: 'x', inputs: [] }), (e) => e.kind === 'invalid' && /IMAGE_SAFETY/.test(e.message))
})

test('只回了文字 → unknown，消息里带上文字', async () => {
  reply(200, { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '我不能画这个，但可以描述一下' }] } }] })
  await assert.rejects(adapter().submit({ mode: 'text', prompt: 'x', inputs: [] }), (e) => e.kind === 'unknown' && e.maybeCharged && /我不能画这个/.test(e.message))
})

test('返回的不是图片 → unknown，可能已计费', async () => {
  reply(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: Buffer.from('not an image at all').toString('base64') } }] } }] })
  await assert.rejects(adapter().submit({ mode: 'text', prompt: 'x', inputs: [] }), (e) => e.kind === 'unknown' && e.maybeCharged)
})

test('HTTP 错误：401 → auth，429 → quota，400 密钥无效 → auth，500 → unknown', async () => {
  reply(401, { error: { code: 401, message: 'unauthenticated', status: 'UNAUTHENTICATED' } })
  await assert.rejects(adapter().submit({ mode: 'text', prompt: 'x', inputs: [] }), (e) => e.kind === 'auth' && e.status === 401)
  reply(429, { error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED' } })
  await assert.rejects(adapter().submit({ mode: 'text', prompt: 'x', inputs: [] }), (e) => e.kind === 'quota' && e.retryable)
  reply(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } })
  await assert.rejects(adapter().submit({ mode: 'text', prompt: 'x', inputs: [] }), (e) => e.kind === 'auth')
  reply(500, { error: { message: 'internal' } })
  await assert.rejects(adapter().submit({ mode: 'text', prompt: 'x', inputs: [] }), (e) => e.kind === 'unknown' && e.maybeCharged)
})

test('蒙版请求直接调 submit 也不会悄悄降级', async () => {
  await assert.rejects(adapter().submit({ mode: 'mask', prompt: 'x', inputs: [{ buf: PNG, mime: 'image/png', role: 'base' }], mask: { buf: PNG, mime: 'image/png' } }), (e) => e.kind === 'unsupported')
})

test('没填 baseUrl 用官方地址', async () => {
  let url = ''
  const fake = async (u) => { url = u; return new Response(JSON.stringify({ candidates: [{ content: { parts: [imagePart()] } }] }), { headers: { 'content-type': 'application/json' } }) }
  await createGeminiImages({ apiKey: 'k', model: 'm/x' }, { fetchImpl: fake }).submit({ mode: 'text', prompt: 'x', inputs: [] })
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/m%2Fx:generateContent')
})

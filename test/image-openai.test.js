// 真实本地 HTTP + 原生 fetch/FormData，验证线上实际会发送的 JSON / multipart 字节。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { createOpenAIImages } from '../src/providers/image/openai.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAFUlEQVR4nGMMqLiTwsDAwMAEIlAYADHgAg6qsHCUAAAAAElFTkSuQmCC', 'base64')
const JPG = readFileSync(new URL('../assets/dafeiyu.jpg', import.meta.url))
const image = (role = 'base', buf = PNG, mime = 'image/png') => ({ role, buf, mime })
const seen = []
let server, baseUrl
let reply = () => ({ status: 200, body: { data: [{ b64_json: PNG.toString('base64') }] } })
before(async () => {
  server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    const record = { path: req.url, method: req.method, headers: req.headers, raw: body }
    if (/multipart\/form-data/.test(req.headers['content-type'])) record.form = await new Response(body, { headers: { 'content-type': req.headers['content-type'] } }).formData()
    else if (body.length) record.json = JSON.parse(body)
    seen.push(record)
    if (req.url === '/result.png') { res.setHeader('content-type', 'image/png'); return res.end(PNG) }
    const { status, body: data } = reply()
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`
})
after(() => { server.closeAllConnections(); server.close() })
const adapter = (extra = {}, overrides = {}) => createOpenAIImages({ baseUrl, apiKey: 'local-mock-key', model: 'mock-image-model', extra, ...overrides })
const req = (overrides = {}) => ({ mode: 'text', prompt: '一只猫', size: '1024x1024', n: 1, inputs: [], ...overrides })
const expectError = (kind) => (e) => { assert.equal(e.kind, kind); assert.equal(e.maybeCharged, kind === 'unknown'); return true }
const reset = () => { seen.length = 0; reply = () => ({ status: 200, body: { data: [{ b64_json: PNG.toString('base64') }] } }) }

test('generation：真实 POST 地址/鉴权/JSON 白名单，image_size 不透传', async () => {
  reset()
  const result = await adapter({ image_size: '2K', responseFormat: 'b64_json', quality: 'high' }).submit(req({ image_size: '4K', images: ['ignored'], n: 2 }))
  assert.equal(seen.length, 1)
  const r = seen[0]
  assert.equal(r.method, 'POST'); assert.equal(r.path, '/v1/images/generations')
  assert.equal(r.headers.authorization, 'Bearer local-mock-key')
  assert.equal(r.headers['content-type'], 'application/json')
  assert.deepEqual(r.json, { model: 'mock-image-model', prompt: '一只猫', size: '1024x1024', n: 2, response_format: 'b64_json', quality: 'high' })
  assert.equal(result.status, 'done'); assert.equal(result.billing, 'charged')
  assert.deepEqual(result.outputs, [{ buf: PNG, mime: 'image/png' }])
})

test('generation：省略非必填参数，不擅自添加 response_format 或 image_size', async () => {
  reset()
  await adapter().submit({ mode: 'text', prompt: 'x' })
  assert.deepEqual(seen[0].json, { model: 'mock-image-model', prompt: 'x', n: 1 })
})

test('multipart：多图 image[] + mask，base 第一、其余稳定排序、原始字节和 boundary 正确', async () => {
  reset()
  await adapter({ image_size: '2K' }).submit(req({
    mode: 'mask', prompt: '保留底图，换衣服', image_size: '4K',
    inputs: [image('identity', JPG, 'image/jpeg'), image(), image('style')], mask: image(),
  }))
  assert.equal(seen.length, 1)
  const r = seen[0], f = r.form
  assert.equal(r.path, '/v1/images/edits'); assert.equal(r.method, 'POST')
  assert.equal(r.headers.authorization, 'Bearer local-mock-key')
  assert.match(r.headers['content-type'], /^multipart\/form-data; boundary=/)
  assert.deepEqual([...f.keys()].sort(), ['image[]', 'image[]', 'image[]', 'mask', 'model', 'n', 'prompt', 'size'].sort())
  assert.equal(f.get('size'), '1024x1024'); assert.equal(f.get('n'), '1')
  assert.equal(f.get('prompt'), '保留底图，换衣服')
  const images = f.getAll('image[]')
  assert.equal(images.length, 3)
  assert.deepEqual(Buffer.from(await images[0].arrayBuffer()), PNG)
  assert.deepEqual(Buffer.from(await images[1].arrayBuffer()), JPG)
  assert.deepEqual(Buffer.from(await images[2].arrayBuffer()), PNG)
  assert.equal(images[0].name, 'input-1.png'); assert.equal(images[1].type, 'image/jpeg')
  assert.equal(f.get('mask').type, 'image/png')
  assert.deepEqual(Buffer.from(await f.get('mask').arrayBuffer()), PNG)
})

test('reference/edit：单图默认 image，配置 image[] 可保留数组字段，不带 mask', async () => {
  reset()
  await adapter().submit(req({ mode: 'reference', inputs: [image('composition')] }))
  assert.equal(seen[0].form.getAll('image').length, 1); assert.equal(seen[0].form.has('mask'), false)
  await adapter({ imageField: 'image[]' }).submit(req({ mode: 'edit', inputs: [image()] }))
  assert.equal(seen[1].form.getAll('image[]').length, 1)
  assert.equal(seen[1].form.has('mask'), false)
})

test('直接 submit 也拒绝未知/禁用模式和不支持字段；失败前没有 HTTP 请求', async () => {
  reset()
  await assert.rejects(adapter().submit(req({ mode: 'variations' })), expectError('unsupported'))
  await assert.rejects(adapter({}, { capabilities: { modes: [] } }).submit(req()), expectError('unsupported'))
  await assert.rejects(adapter({ modes: ['text'] }).submit(req({ mode: 'edit', inputs: [image()] })), expectError('unsupported'))
  await assert.rejects(adapter().submit(req({ negativePrompt: '不要模糊' })), expectError('unsupported'))
  await assert.rejects(adapter({ imageField: 'image' }).submit(req({ mode: 'reference', inputs: [image('style'), image('identity')] })), expectError('unsupported'))
  assert.equal(seen.length, 0)
})

test('直调验证角色/唯一底图/mask尺寸与类型/输入字节，绝不丢图降级', async () => {
  reset()
  for (const request of [
    req({ mode: 'text', inputs: [image('style')] }),
    req({ mode: 'reference', inputs: [] }), req({ mode: 'reference', inputs: [image('unknown')] }),
    req({ mode: 'edit', inputs: [image('identity')] }), req({ mode: 'edit', inputs: [image(), image()] }),
    req({ mode: 'edit', inputs: [image()], mask: image() }),
    req({ mode: 'mask', inputs: [image()] }),
    req({ mode: 'mask', inputs: [image('base', JPG, 'image/jpeg')], mask: image() }),
    req({ mode: 'mask', inputs: [image()], mask: image('base', JPG, 'image/jpeg') }),
    req({ mode: 'mask', inputs: [image()], mask: { mime: 'image/png' } }),
    req({ mode: 'edit', inputs: [image('base', PNG.subarray(0, 12))] }),
    req({ mode: 'edit', inputs: [{ role: 'base' }] }),
    req({ n: 0 }), req({ n: 1.5 }), req({ prompt: '' }), req({ size: 'fake' }),
  ]) await assert.rejects(adapter().submit(request), expectError('invalid'))
  assert.equal(seen.length, 0)
})

test('坏配置/禁用端口在真实 HTTP 请求之前报 invalid', async () => {
  reset()
  for (const overrides of [{ baseUrl: 'ftp://example.test' }, { baseUrl: 'http://127.0.0.1:25' }, { baseUrl: baseUrl + '?v=1' }, { model: '' }, { apiKey: 'bad\nkey' }]) await assert.rejects(adapter({}, overrides).submit(req()), expectError('invalid'))
  for (const extra of [{ imageField: 'files' }, { responseFormat: 'gif' }, { maxInputs: -1 }]) await assert.rejects(adapter(extra).submit(req()), expectError('invalid'))
  assert.equal(seen.length, 0)
})

test('响应 URL 经本地 HTTP 下载；不携带 API Authorization 到结果 URL', async () => {
  reset()
  reply = () => ({ status: 200, body: { data: [{ url: baseUrl.replace('/v1', '/result.png') }] } })
  const r = await adapter({ responseFormat: 'url' }).submit(req())
  assert.deepEqual(r.outputs[0].buf, PNG)
  assert.equal(seen[1].path, '/result.png'); assert.equal(seen[1].headers.authorization, undefined)
})

test('HTTP 错误保持 auth/quota/unsupported/unknown 语义，5xx 不可盲重发', async () => {
  reset()
  for (const [status, kind, message] of [[401, 'auth', 'bad key'], [429, 'quota', 'rate limit'], [400, 'unsupported', 'unsupported image mode'], [500, 'unknown', 'failed']]) {
    reply = () => ({ status, body: { error: { message } } })
    await assert.rejects(adapter().submit(req()), (e) => { expectError(kind)(e); assert.equal(e.status, status); assert.equal(e.retryable, kind === 'quota'); return true })
  }
})

test('坏结果是 unknown：空数组/非数组/坏图/伪 base64/坏 URL 不报告成功或未计费', async () => {
  reset()
  for (const body of [{ data: [] }, { data: 'image' }, { data: [{ b64_json: PNG.subarray(0, 12).toString('base64') }] }, { data: [{ b64_json: '!!!!' }] }, { data: [{ url: 'file:///tmp/x' }] }]) {
    reply = () => ({ status: 200, body })
    await assert.rejects(adapter().submit(req()), expectError('unknown'))
  }
})

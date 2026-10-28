// 生图 HTTP 映射：同步 JSON / 直接图片、异步提交轮询取消、{imagesJson} 展开、multipart 上传、头部模板、限流归类、配置检查。
// 用本机 127.0.0.1 上的假服务跑真实请求，覆盖到 fetch / FormData 的实际编码。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHttpImages, validateHttpProfile, fillTemplate } from '../src/providers/image/http.js'

import { PNG, JPG } from './helpers/images.js'

let server
let base
const seen = []
const tasks = new Map()

before(async () => {
  server = createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const buf = Buffer.concat(chunks)
    const rec = { method: req.method, url: req.url, headers: req.headers, buf }
    seen.push(rec)
    const json = (status, o) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/sync-json') return json(200, { data: [{ b64: PNG.toString('base64') }] })
    if (u.pathname === '/sync-raw') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG) }
    if (u.pathname === '/echo') return json(200, { images: [PNG.toString('base64')] })
    if (u.pathname === '/multipart') {
      rec.form = await new Response(buf, { headers: { 'content-type': req.headers['content-type'] } }).formData()
      return json(200, { out: 'data:image/png;base64,' + PNG.toString('base64') })
    }
    if (u.pathname === '/limited') return json(429, { error: { message: 'too many requests' } })
    if (u.pathname === '/files/out.jpg') { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(JPG) }
    if (u.pathname === '/status-json' && req.method === 'POST') {
      let body
      try { body = JSON.parse(buf.toString('utf8')) } catch { return json(400, { message: 'bad json' }) }
      const t = tasks.get(body.id)
      if (!t) return json(404, { message: 'no task' })
      t.polls++
      if (t.fail) return json(200, { state: 'FAILED', err: { msg: '提示词被拒' } })
      if (t.polls < 2) return json(200, { state: 'RUNNING' })
      return json(200, { state: 'SUCCEEDED', output: { urls: [`${base}/files/out.jpg`] } })
    }
    if (u.pathname === '/tasks' && req.method === 'POST') {
      let body
      try { body = JSON.parse(buf.toString('utf8')) } catch (error) { return json(400, { message: 'bad json' }) }
      const id = 't' + (tasks.size + 1)
      tasks.set(id, { polls: 0, fail: body.prompt === 'fail' })
      return json(200, { result: { id } })
    }
    const m = u.pathname.match(/^\/tasks\/([^/]+)$/)
    if (m && req.method === 'GET') {
      const t = tasks.get(m[1])
      if (!t) return json(404, { message: 'no task' })
      t.polls++
      if (t.fail) return json(200, { state: 'FAILED', err: { msg: '提示词被拒' } })
      if (t.polls < 2) return json(200, { state: 'RUNNING' })
      return json(200, { state: 'SUCCEEDED', output: { urls: [`${base}/files/out.jpg`] } })
    }
    if (m && req.method === 'DELETE') { tasks.delete(m[1]); return json(200, { ok: true }) }
    json(404, { message: 'not found' })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})

// fetch 默认长连接，不主动断开 server.close() 会一直等下去
after(() => { server.closeAllConnections(); server.close() })

const last = (path) => [...seen].reverse().find((r) => r.url.startsWith(path))

function profile(extra, apiKey = 'sk-test') {
  return { apiKey, extra }
}

const asyncExtra = () => ({
  headers: { authorization: 'Bearer {apiKey}' },
  submit: { method: 'POST', url: `${base}/tasks`, bodyType: 'json', body: '{"prompt":"{prompt}","w":{width},"h":{height}}' },
  response: { kind: 'json', taskIdPath: 'result.id' },
  status: { method: 'GET', url: `${base}/tasks/{taskId}`, statePath: 'state', doneValues: ['SUCCEEDED'], failedValues: ['FAILED'], imagesPath: 'output.urls', errorPath: 'err.msg' },
  cancel: { method: 'DELETE', url: `${base}/tasks/{taskId}` },
})

test('同步 JSON：base64 结果取出来，提示词按 JSON 转义，尺寸拆成宽高', async () => {
  const a = createHttpImages(profile({
    submit: { method: 'POST', url: `${base}/sync-json?size={size}`, bodyType: 'json', body: '{"p":"{prompt}","neg":"{negativePrompt}","w":{width},"h":{height},"n":{n},"mode":"{mode}"}' },
    response: { kind: 'json', imagesPath: 'data.0.b64' },
  }))
  assert.equal(a.protocol, 'http')
  assert.equal(a.poll, undefined)
  assert.equal(a.cancel, undefined)
  assert.deepEqual(a.capabilities(), { modes: ['text'], maxInputs: 0, async: false, cancel: false, idempotent: false, sizes: [] })
  const prompt = '一只"猫"\n{apiKey} & 狗'
  const r = await a.submit({ mode: 'text', prompt, negativePrompt: '模糊', size: '1024x768', n: 2, inputs: [] })
  assert.equal(r.status, 'done')
  assert.equal(r.outputs[0].mime, 'image/png')
  assert.ok(r.outputs[0].buf.equals(PNG))
  const rec = last('/sync-json')
  assert.equal(rec.url, '/sync-json?size=1024x768')
  const sent = JSON.parse(rec.buf.toString('utf8'))
  // 提示词里写了 {apiKey} 也不能被展开成密钥
  assert.deepEqual(sent, { p: prompt, neg: '模糊', w: 1024, h: 768, n: 2, mode: 'text' })
  assert.equal(rec.headers['content-type'], 'application/json')
})

test('同步直接图片：返回体就是图', async () => {
  const a = createHttpImages(profile({
    submit: { method: 'GET', url: `${base}/sync-raw?q={prompt}`, bodyType: 'none' },
    response: { kind: 'image' },
  }))
  const r = await a.submit({ mode: 'text', prompt: '海 边', inputs: [] })
  assert.equal(r.status, 'done')
  assert.equal(r.outputs[0].mime, 'image/png')
  assert.equal(last('/sync-raw').url, '/sync-raw?q=' + encodeURIComponent('海 边'))
  assert.equal(last('/sync-raw').method, 'GET')
})

test('异步：提交拿任务号 → 轮询 running → done（结果地址从服务下载），头部带上密钥', async () => {
  const a = createHttpImages(profile(asyncExtra(), 'sk-abc'))
  const caps = a.capabilities()
  assert.equal(caps.async, true)
  assert.equal(caps.cancel, true)
  assert.equal(typeof a.poll, 'function')
  const r = await a.submit({ mode: 'text', prompt: '星空', size: '512x512', inputs: [] })
  assert.deepEqual(r, { status: 'running', providerTaskId: 't1' })
  assert.equal(last('/tasks').headers.authorization, 'Bearer sk-abc')
  assert.deepEqual(JSON.parse(last('/tasks').buf.toString()), { prompt: '星空', w: 512, h: 512 })
  const p1 = await a.poll('t1')
  assert.equal(p1.status, 'running')
  assert.equal(last('/tasks/t1').headers.authorization, 'Bearer sk-abc')
  const p2 = await a.poll('t1')
  assert.equal(p2.status, 'done')
  assert.equal(p2.outputs[0].mime, 'image/jpeg')
  assert.ok(p2.outputs[0].buf.equals(JPG))
})

test('异步失败：状态在 failedValues 里，带上 errorPath 的原因', async () => {
  const a = createHttpImages(profile(asyncExtra()))
  const r = await a.submit({ mode: 'text', prompt: 'fail', size: '64x64', inputs: [] })
  const p = await a.poll(r.providerTaskId)
  assert.equal(p.status, 'failed')
  assert.equal(p.error.kind, 'invalid')
  assert.match(p.error.message, /提示词被拒/)
})

test('取消：按模板调用取消接口', async () => {
  const a = createHttpImages(profile(asyncExtra(), 'sk-c'))
  const r = await a.submit({ mode: 'text', prompt: '取消我', size: '64x64', inputs: [] })
  const c = await a.cancel(r.providerTaskId)
  assert.equal(c.ok, true)
  const rec = last(`/tasks/${r.providerTaskId}`)
  assert.equal(rec.method, 'DELETE')
  assert.equal(rec.headers.authorization, 'Bearer sk-c')
  const again = await a.cancel(r.providerTaskId)
  assert.equal(again.ok, true, '假服务删除不存在的任务也返回 200')
  const missing = await a.poll(r.providerTaskId).catch((e) => e)
  assert.equal(missing.kind, 'invalid')
})

test('{imagesJson}：原样插入带角色的图数组，底图排第一；{maskBase64} 正常替换', async () => {
  const a = createHttpImages(profile({
    modes: ['reference', 'edit', 'mask'], maxInputs: 4,
    submit: { method: 'POST', url: `${base}/echo`, bodyType: 'json', body: '{"prompt":"{prompt}","images":{imagesJson},"mask":"{maskBase64}"}' },
    response: { kind: 'json', imagesPath: 'images' },
  }))
  assert.deepEqual(a.capabilities().modes, ['reference', 'edit', 'mask'])
  assert.equal(a.capabilities().maxInputs, 4)
  const mask = Buffer.from('maskbytes')
  const r = await a.submit({
    mode: 'mask', prompt: '换成红色',
    inputs: [{ buf: JPG, mime: 'image/jpeg', role: 'style' }, { buf: PNG, mime: 'image/png', role: 'base' }],
    mask: { buf: mask, mime: 'image/png' },
  })
  assert.equal(r.status, 'done')
  const sent = JSON.parse(last('/echo').buf.toString('utf8'))
  assert.deepEqual(sent.images, [
    { role: 'base', mime: 'image/png', base64: PNG.toString('base64') },
    { role: 'style', mime: 'image/jpeg', base64: JPG.toString('base64') },
  ])
  assert.equal(sent.mask, mask.toString('base64'))
  // 不在 json 体里的 {imagesJson} 不展开成大段数据
  assert.equal(fillTemplate('x={imagesJson}', { imagesJson: '[1]' }, 'url'), 'x=')
})

test('multipart：文本字段按模板填值，输入图用 imageField 重复字段，蒙版用 maskField', async () => {
  const a = createHttpImages(profile({
    modes: ['edit', 'mask'], maxInputs: 2,
    headers: { 'x-key': '{apiKey}', 'content-type': 'text/plain' },
    submit: { method: 'POST', url: `${base}/multipart`, bodyType: 'multipart', body: '{"prompt":"{prompt}","size":"{size}","steps":20}', imageField: 'images[]', maskField: 'mask_image' },
    response: { kind: 'json', imagesPath: 'out' },
  }, 'k1'))
  const r = await a.submit({
    mode: 'mask', prompt: '加一顶"帽子"', size: '256x256',
    inputs: [{ buf: PNG, mime: 'image/png', role: 'base' }, { buf: JPG, mime: 'image/jpeg', role: 'identity' }],
    mask: { buf: PNG, mime: 'image/png' },
  })
  assert.equal(r.status, 'done')
  const rec = last('/multipart')
  assert.equal(rec.headers['x-key'], 'k1')
  assert.match(rec.headers['content-type'], /^multipart\/form-data; boundary=/, '手写的 content-type 不能盖掉 boundary')
  const f = rec.form
  assert.equal(f.get('prompt'), '加一顶"帽子"')
  assert.equal(f.get('size'), '256x256')
  assert.equal(f.get('steps'), '20')
  const imgs = f.getAll('images[]')
  assert.equal(imgs.length, 2)
  assert.ok(Buffer.from(await imgs[0].arrayBuffer()).equals(PNG))
  assert.ok(Buffer.from(await imgs[1].arrayBuffer()).equals(JPG))
  assert.ok(Buffer.from(await f.get('mask_image').arrayBuffer()).equals(PNG))
})

test('HTTP 429 → quota，可以晚点重试', async () => {
  const a = createHttpImages(profile({
    submit: { method: 'POST', url: `${base}/limited`, bodyType: 'json', body: '{}' },
    response: { kind: 'json', imagesPath: 'data' },
  }))
  const e = await a.submit({ mode: 'text', prompt: 'x', inputs: [] }).catch((err) => err)
  assert.equal(e.kind, 'quota')
  assert.equal(e.retryable, true)
  assert.match(e.message, /too many requests/)
})

test('配置检查：缺地址、方法不对、异步没配状态、缺图片路径都说清楚；没配好时提交直接报 invalid', async () => {
  const has = (list, re) => assert.ok(list.some((p) => re.test(p)), `应包含 ${re}：${list.join(' | ')}`)
  has(validateHttpProfile({ extra: { response: { kind: 'json', imagesPath: 'a' } } }), /没填提交地址/)
  has(validateHttpProfile({ extra: { submit: { url: 'ftp://x' }, response: { imagesPath: 'a' } } }), /http:\/\//)
  has(validateHttpProfile({ extra: { submit: { url: 'http://x', method: 'FETCH' }, response: { imagesPath: 'a' } } }), /提交方法不对/)
  has(validateHttpProfile({ extra: { submit: { url: 'http://x' }, response: { kind: 'json' } } }), /图片的路径/)
  has(validateHttpProfile({ extra: { submit: { url: 'http://x' }, response: { taskIdPath: 'id' } } }), /没配置查状态/)
  const st = validateHttpProfile({ extra: { submit: { url: 'http://x' }, response: { taskIdPath: 'id' }, status: { url: 'http://x/s' } } })
  has(st, /\{taskId\}/)
  has(st, /statePath/)
  has(st, /doneValues/)
  has(st, /imagesPath/)
  has(validateHttpProfile({ extra: { modes: ['edit'], submit: { url: 'http://x', body: '{}' }, response: { imagesPath: 'a' } } }), /\{imagesJson\}/)
  has(validateHttpProfile({ extra: { submit: { url: 'http://x', bodyType: 'multipart', body: 'a=1' }, response: { imagesPath: 'a' } } }), /JSON 对象/)
  has(validateHttpProfile({ extra: { submit: { url: 'http://x', bodyType: 'xml' }, response: { imagesPath: 'a' } } }), /请求体类型不对/)
  has(validateHttpProfile({ extra: { submit: { url: 'http://x' }, response: { kind: 'html' } } }), /返回类型不对/)
  assert.deepEqual(validateHttpProfile(profile(asyncExtra())), [])
  const e = await createHttpImages({ extra: {} }).submit({ mode: 'text', prompt: 'x', inputs: [] }).catch((err) => err)
  assert.equal(e.kind, 'invalid')
  assert.match(e.message, /没填提交地址/)
})

const postStatusExtra = () => {
  const extra = asyncExtra()
  extra.status = { ...extra.status, method: 'POST', url: `${base}/status-json`, bodyType: 'json', body: '{"id":"{taskId}"}' }
  return extra
}

test('POST JSON 轮询：恢复已有任务无需提交，URL 无任务号，body 转义且不二次展开，结果下载不带密钥', async () => {
  const id = '任务"\\\n{apiKey}/?a=1&b={taskId}'
  tasks.set(id, { polls: 0 })
  const config = profile(postStatusExtra(), 'must-not-appear-in-body')
  assert.deepEqual(validateHttpProfile(config), [])
  const adapter = createHttpImages(config), start = seen.length
  assert.equal((await adapter.poll(id)).status, 'running')
  const rec = last('/status-json')
  assert.equal(rec.url, '/status-json')
  assert.equal(rec.method, 'POST')
  assert.equal(rec.headers.authorization, 'Bearer must-not-appear-in-body')
  assert.equal(rec.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(rec.buf.toString()), { id })
  assert.equal(rec.buf.includes('must-not-appear-in-body'), false)
  const result = await adapter.poll(id)
  assert.equal(result.status, 'done')
  assert.deepEqual(result.outputs[0].buf, JPG)
  assert.equal(last('/files/out.jpg').headers.authorization, undefined)
  assert.deepEqual(seen.slice(start).map(rec => rec.method + ' ' + rec.url), ['POST /status-json', 'POST /status-json', 'GET /files/out.jpg'])
})

test('POST JSON 轮询保留失败状态/HTTP 错误分类及自定义 Content-Type', async () => {
  tasks.set('native-failed', { polls: 0, fail: true })
  const extra = postStatusExtra()
  extra.headers['Content-Type'] = 'application/json; charset=utf-8'
  const adapter = createHttpImages(profile(extra))
  const failed = await adapter.poll('native-failed')
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error.kind, 'invalid')
  assert.match(failed.error.message, /提示词被拒/)
  assert.equal(last('/status-json').headers['content-type'], 'application/json; charset=utf-8')
  await assert.rejects(adapter.poll('never-created'), e => e.kind === 'invalid' && e.status === 404)
})

test('旧的 POST URL 轮询配置默认 none：不凭空添加 body 或 Content-Type', async () => {
  const extra = asyncExtra()
  extra.status.method = 'POST'
  let calls = 0
  const adapter = createHttpImages(profile(extra), { fetchImpl: async (url, init) => {
    calls++
    assert.equal(url, `${base}/tasks/old-id`)
    assert.equal(init.method, 'POST')
    assert.equal(init.body, undefined)
    assert.equal(new Headers(init.headers).has('content-type'), false)
    return Response.json({ state: 'RUNNING' })
  } })
  assert.equal((await adapter.poll('old-id')).status, 'running')
  assert.equal(calls, 1)
})

test('{imagesDataUrls} 是完整 data URL 数组，底图优先且其余稳定；可与旧 imagesJson 同时使用', async () => {
  const config = profile({
    modes: ['text', 'reference'], maxInputs: 3,
    submit: { url: `${base}/echo`, bodyType: 'json', body: '{"prompt":"{prompt}","urls":{imagesDataUrls},"legacy":{imagesJson}}' },
    response: { imagesPath: 'images' },
  })
  assert.deepEqual(validateHttpProfile(config), [])
  const adapter = createHttpImages(config), prompt = '蓝鲸 "{apiKey}"\n{imagesDataUrls}'
  await adapter.submit({ mode: 'reference', prompt, inputs: [
    { buf: JPG, mime: 'image/jpeg', role: 'style' },
    { buf: PNG, mime: 'image/png', role: 'base' },
    { buf: PNG, role: 'identity' },
  ] })
  const sent = JSON.parse(last('/echo').buf.toString())
  assert.equal(sent.prompt, prompt)
  assert.deepEqual(sent.urls, [PNG, JPG, PNG].map((buf, i) => `data:${i === 1 ? 'image/jpeg' : 'image/png'};base64,${buf.toString('base64')}`))
  assert.deepEqual(sent.legacy.map(im => im.role), ['base', 'style', 'identity'])
  assert.deepEqual(sent.legacy.map(im => Buffer.from(im.base64, 'base64')), [PNG, JPG, PNG])
  await adapter.submit({ mode: 'text', prompt: '蓝鲸', inputs: [] })
  assert.deepEqual(JSON.parse(last('/echo').buf.toString()).urls, [])
})

test('只声明 imagesDataUrls 就能收图；损坏字节与伪造 MIME 在发送前拒绝', async () => {
  const config = profile({
    modes: ['reference'], maxInputs: 1,
    submit: { url: `${base}/echo`, bodyType: 'json', body: '{"urls":{imagesDataUrls}}' },
    response: { imagesPath: 'images' },
  })
  assert.deepEqual(validateHttpProfile(config), [])
  let calls = 0
  const adapter = createHttpImages(config, { fetchImpl: async () => { calls++; return Response.json({ images: [] }) } })
  for (const input of [{ buf: PNG, mime: 'text/html' }, { buf: PNG.subarray(0, 20), mime: 'image/png' }]) {
    await assert.rejects(adapter.submit({ mode: 'reference', inputs: [{ ...input, role: 'base' }] }), e => e.kind === 'invalid')
  }
  assert.equal(calls, 0)
})

test('JSON 数组占位符不注入 URL/头部，不二次展开提示词', () => {
  for (const enc of ['url', 'raw']) assert.equal(fillTemplate('x={imagesDataUrls}', { imagesDataUrls: '["data:image/png;base64,AA=="]' }, enc), 'x=')
  assert.equal(fillTemplate('{imagesDataUrls}', {}, 'json'), '[]')
  assert.deepEqual(JSON.parse(fillTemplate('{"p":"{prompt}","urls":{imagesDataUrls}}', {
    prompt: '{imagesDataUrls} {apiKey}', apiKey: 'secret', imagesDataUrls: '["data:image/png;base64,AA=="]',
  }, 'json')), { p: '{imagesDataUrls} {apiKey}', urls: ['data:image/png;base64,AA=='] })
})

test('轮询 body 校验：不能 GET 带体、静默丢体、缺任务号或发坏 JSON；恢复 poll 也在联网前校验', async () => {
  const cases = [
    [{ method: 'GET' }, /GET.*请求体/],
    [{ bodyType: 'form' }, /请求体类型不对/],
    [{ bodyType: 'none' }, /bodyType/],
    [{ body: '{}' }, /\{taskId\}/],
    [{ body: '{"id":{taskId}}' }, /有效 JSON/],
    [{ body: { id: '{taskId}' } }, /有效 JSON/],
    [{ body: '' }, /有效 JSON/],
  ]
  for (const [patch, message] of cases) {
    const extra = postStatusExtra()
    Object.assign(extra.status, patch)
    assert.ok(validateHttpProfile(profile(extra)).some(problem => message.test(problem)))
    let calls = 0
    const adapter = createHttpImages(profile(extra), { fetchImpl: async () => { calls++; return Response.json({}) } })
    await assert.rejects(adapter.poll('existing-task'), e => e.kind === 'invalid')
    assert.equal(calls, 0)
  }
})

test('POST JSON 轮询传递取消信号，取消后不再轮询或重新提交', async () => {
  const controller = new AbortController(), calls = []
  let notifyStarted
  const started = new Promise(resolve => { notifyStarted = resolve })
  const adapter = createHttpImages(profile(postStatusExtra()), { fetchImpl: async (url, init) => {
    calls.push({ url, init })
    notifyStarted()
    return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }))
  } })
  const pending = adapter.poll('existing-task', { signal: controller.signal })
  const rejected = assert.rejects(pending, e => e.kind === 'unknown')
  await started
  controller.abort(new DOMException('stop', 'AbortError'))
  await rejected
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.signal.aborted, true)
  assert.equal(calls[0].url, `${base}/status-json`)
  assert.deepEqual(JSON.parse(calls[0].init.body), { id: 'existing-task' })
  await assert.rejects(adapter.poll('existing-task', { signal: controller.signal }))
  assert.equal(calls.length, 1, '预先取消不会再次发请求')
})

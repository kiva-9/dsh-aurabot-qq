// 生图 HTTP 映射：同步 JSON / 直接图片、异步提交轮询取消、{imagesJson} 展开、multipart 上传、头部模板、限流归类、配置检查。
// 用本机 127.0.0.1 上的假服务跑真实请求，覆盖到 fetch / FormData 的实际编码。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHttpImages, validateHttpProfile, fillTemplate } from '../src/providers/image/http.js'

const PNG = Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n\x1a\n'), Buffer.alloc(32, 7)])
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 3)])

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

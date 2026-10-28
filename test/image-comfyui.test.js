// ComfyUI 适配器：能力按绑定推出来、绑定位置填值、登记错 / 角色没绑定 / 节点报错都拒绝、轮询（排队 / 画完下载 / 出错）、取消（排队 / 正在跑 / 已画完）。
// 用本机的假 ComfyUI（127.0.0.1 随机端口），不连真网络。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { createComfyImages } from '../src/providers/image/comfyui.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAFUlEQVR4nGMMqLiTwsDAwMAEIlAYADHgAg6qsHCUAAAAAElFTkSuQmCC', 'base64')
const JPG = readFileSync(new URL('../assets/dafeiyu.jpg', import.meta.url))
const NOT_IMAGE = Buffer.from('this is not an image at all')

const WORKFLOW = {
  3: { class_type: 'KSampler', inputs: { seed: 1, steps: 20 } },
  5: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  6: { class_type: 'CLIPTextEncode', inputs: { text: 'placeholder' } },
  7: { class_type: 'CLIPTextEncode', inputs: { text: '' } },
  10: { class_type: 'LoadImage', inputs: { image: 'example.png' } },
  11: { class_type: 'LoadImage', inputs: { image: 'example.png' } },
  12: { class_type: 'LoadImage', inputs: { image: 'example.png' } },
  9: { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI' } },
}
const BINDINGS = {
  prompt: '6.inputs.text', negativePrompt: '7.inputs.text', width: '5.inputs.width', height: '5.inputs.height', seed: '3.inputs.seed',
  base: '10.inputs.image', identity: '11.inputs.image', mask: '12.inputs.image',
}

// 假 ComfyUI：记下所有请求，行为由 state 控制
const state = { calls: [], uploads: 0, nodeErrors: null, history: {}, running: [], pending: [], files: {}, deleteOutcome: '' }
const server = createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks)
  const url = new URL(req.url, 'http://x')
  state.calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body })
  const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
  if (req.method === 'POST' && url.pathname === '/upload/image') {
    const n = ++state.uploads
    return json(200, { name: `up-${n}.png`, subfolder: n === 2 ? 'aura' : '', type: 'input' })
  }
  if (req.method === 'POST' && url.pathname === '/prompt') {
    if (state.nodeErrors) return json(400, { error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' }, node_errors: state.nodeErrors })
    return json(200, { prompt_id: 'pid-1', number: 1, node_errors: {} })
  }
  if (req.method === 'GET' && url.pathname.startsWith('/history/')) {
    const id = decodeURIComponent(url.pathname.slice('/history/'.length))
    return json(200, state.history[id] ? { [id]: state.history[id] } : {})
  }
  if (req.method === 'GET' && url.pathname === '/queue') {
    return json(200, { queue_running: state.running.map((id, i) => [i, id, {}, {}, []]), queue_pending: state.pending.map((id, i) => [i + 10, id, {}, {}, []]) })
  }
  if (req.method === 'POST' && url.pathname === '/queue') {
    const ids = JSON.parse(body).delete || []
    for (const id of ids) {
      if (state.deleteOutcome === 'keep') continue
      state.pending = state.pending.filter((other) => other !== id)
      if (state.deleteOutcome === 'running') state.running.push(id)
      if (state.deleteOutcome === 'finished') state.history[id] = { status: { status_str: 'success', completed: true }, outputs: {} }
    }
    return json(200, {})
  }
  // 故意模拟不识别 prompt_id 的旧版全局中断；适配器不得走到这里。
  if (req.method === 'POST' && url.pathname === '/interrupt') { state.running = []; return json(200, {}) }
  if (req.method === 'GET' && url.pathname === '/view') {
    const f = state.files[`${url.searchParams.get('type')}/${url.searchParams.get('subfolder')}/${url.searchParams.get('filename')}`]
    if (!f) return json(404, { error: 'not found' })
    res.writeHead(200, { 'content-type': 'image/png' })
    return res.end(f)
  }
  json(404, { error: 'no route' })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
after(() => { server.closeAllConnections(); server.close() })
const baseUrl = `http://127.0.0.1:${server.address().port}`

function reset() {
  Object.assign(state, { calls: [], uploads: 0, nodeErrors: null, history: {}, running: [], pending: [], files: {}, deleteOutcome: '' })
}
const comfy = (extra = {}) => createComfyImages({ baseUrl, extra: { workflow: WORKFLOW, bindings: BINDINGS, ...extra } })
const lastPrompt = () => JSON.parse(state.calls.filter((c) => c.path === '/prompt').at(-1).body.toString('utf8'))
const rejects = (p, kind, re) => assert.rejects(p, (e) => { assert.equal(e.kind, kind); if (re) assert.match(e.message, re); return true })

test('能力按绑定推出来', () => {
  assert.deepEqual(comfy().capabilities(), { modes: ['text', 'reference', 'edit', 'mask'], maxInputs: 2, async: true, cancel: true, idempotent: false, sizes: [] })
  const textOnly = comfy({ bindings: { prompt: '6.inputs.text' } }).capabilities()
  assert.deepEqual(textOnly.modes, ['text'])
  assert.equal(textOnly.maxInputs, 0)
  const ref = comfy({ bindings: { prompt: '6.inputs.text', style: '11.inputs.image', composition: '12.inputs.image' } }).capabilities()
  assert.deepEqual(ref.modes, ['text', 'reference'])
  assert.equal(ref.maxInputs, 2)
  const editNoMask = comfy({ bindings: { prompt: '6.inputs.text', base: '10.inputs.image' } }).capabilities()
  assert.deepEqual(editNoMask.modes, ['text', 'edit'], '没绑蒙版就没有蒙版编辑')
  assert.deepEqual(comfy({ modes: ['text', 'edit'] }).capabilities().modes, ['text', 'edit'], '管理员可以收窄')
  assert.deepEqual(comfy({ modes: [] }).capabilities().modes, [], '空模式必须保持禁用')
})

test('提交：提示词、尺寸、种子、上传后的图片名都填进绑定的节点；登记的工作流不被改动', async () => {
  reset()
  const c = createComfyImages({ baseUrl, extra: { workflow: JSON.stringify(WORKFLOW), bindings: BINDINGS } })
  const r = await c.submit({
    mode: 'mask', prompt: '一只橘猫', negativePrompt: '模糊', size: '768x1024', n: 1,
    inputs: [{ buf: PNG, mime: 'image/png', role: 'base' }, { buf: PNG, mime: 'image/png', role: 'identity' }],
    mask: { buf: PNG, mime: 'image/png' },
  })
  assert.deepEqual(r, { status: 'running', providerTaskId: 'pid-1' })
  const uploads = state.calls.filter((c) => c.path === '/upload/image')
  assert.equal(uploads.length, 3)
  for (const u of uploads) {
    const s = u.body.toString('latin1')
    assert.match(s, /name="image"; filename="aurabot-[^"]+\.png"/)
    assert.match(s, /name="type"\r\n\r\ninput/)
    assert.ok(u.body.includes(PNG), '原样上传图片字节')
  }
  const sent = lastPrompt()
  assert.ok(sent.client_id)
  const g = sent.prompt
  assert.equal(g[6].inputs.text, '一只橘猫')
  assert.equal(g[7].inputs.text, '模糊')
  assert.equal(g[5].inputs.width, 768)
  assert.equal(g[5].inputs.height, 1024)
  assert.equal(g[10].inputs.image, 'up-1.png')
  assert.equal(g[11].inputs.image, 'aura/up-2.png', '有子目录时带上子目录')
  assert.equal(g[12].inputs.image, 'up-3.png', '蒙版原样上传到蒙版绑定')
  assert.ok(Number.isSafeInteger(g[3].inputs.seed))
  assert.equal(WORKFLOW[6].inputs.text, 'placeholder', '深拷贝，不改登记的原件')

  reset()
  await comfy().submit({ mode: 'text', prompt: 'x', seed: 42, inputs: [] })
  assert.equal(lastPrompt().prompt[3].inputs.seed, 42, '给了种子就用给的')
  assert.equal(state.calls.filter((c) => c.path === '/upload/image').length, 0)
})

test('绑定路径在工作流里不存在 → invalid，且什么都没发', async () => {
  reset()
  await rejects(comfy({ bindings: { ...BINDINGS, width: '99.inputs.width' } }).submit({ mode: 'text', prompt: 'x', inputs: [] }), 'invalid', /99\.inputs\.width/)
  await rejects(comfy({ bindings: { ...BINDINGS, seed: '3.inputs.noise_seed' } }).submit({ mode: 'text', prompt: 'x', inputs: [] }), 'invalid', /3\.inputs\.noise_seed/)
  assert.equal(state.calls.length, 0)
})

test('输入图的角色没有绑定 → unsupported，不悄悄丢图', async () => {
  reset()
  await rejects(comfy().submit({ mode: 'reference', prompt: 'x', inputs: [{ buf: PNG, mime: 'image/png', role: 'style' }] }), 'unsupported', /style/)
  await rejects(comfy().submit({ mode: 'reference', prompt: 'x', inputs: [{ buf: PNG, mime: 'image/png', role: 'identity' }, { buf: PNG, mime: 'image/png', role: 'identity' }] }), 'unsupported')
  await rejects(comfy({ bindings: { prompt: '6.inputs.text', base: '10.inputs.image' } }).submit({
    mode: 'mask', prompt: 'x', inputs: [{ buf: PNG, mime: 'image/png', role: 'base' }], mask: { buf: PNG, mime: 'image/png' },
  }), 'unsupported', /蒙版/)
  assert.equal(state.calls.length, 0, '校验在上传之前')
})

test('node_errors → invalid，带可读的摘要', async () => {
  reset()
  state.nodeErrors = { 4: { class_type: 'CheckpointLoaderSimple', errors: [{ type: 'value_not_in_list', message: 'Value not in list', details: "ckpt_name: 'x.safetensors' not in []" }], dependent_outputs: ['9'] } }
  await rejects(comfy().submit({ mode: 'text', prompt: 'x', inputs: [] }), 'invalid', /节点 4（CheckpointLoaderSimple）：Value not in list：ckpt_name/)
})

test('轮询：历史里没有时看队列；都没有就是任务不见了', async () => {
  reset()
  const c = comfy()
  state.pending = ['pid-1']
  assert.equal((await c.poll('pid-1')).status, 'running')
  state.pending = []
  state.running = ['pid-1']
  assert.deepEqual(await c.poll('pid-1'), { status: 'running', providerTaskId: 'pid-1', progress: '正在画' })
  state.running = []
  await rejects(c.poll('pid-1'), 'unknown', /任务不见了/)
})

test('轮询：画完了按 subfolder / type 经 /view 下载，只收真正的图片', async () => {
  reset()
  const other = JPG
  state.files['output/sub dir/a&b.png'] = PNG
  state.files['output//b.png'] = other
  state.files['output//c.txt'] = NOT_IMAGE
  state.files['temp//preview.png'] = PNG
  state.history['pid-1'] = {
    status: { status_str: 'success', completed: true, messages: [] },
    outputs: {
      9: { images: [{ filename: 'a&b.png', subfolder: 'sub dir', type: 'output' }, { filename: 'b.png', subfolder: '', type: 'output' }, { filename: 'c.txt', subfolder: '', type: 'output' }] },
      20: { images: [{ filename: 'preview.png', subfolder: '', type: 'temp' }] },
    },
  }
  const r = await comfy().poll('pid-1')
  assert.equal(r.status, 'done')
  assert.equal(r.billing, 'free')
  assert.equal(r.providerTaskId, 'pid-1')
  assert.equal(r.outputs.length, 2)
  assert.ok(r.outputs[0].buf.equals(PNG))
  assert.ok(r.outputs[1].buf.equals(other))
  assert.equal(r.outputs[0].mime, 'image/png')
  assert.equal(r.outputs[1].mime, 'image/jpeg', '实际字节决定 MIME，不信文件名或响应头')
  const views = state.calls.filter((c) => c.path === '/view')
  assert.deepEqual(views[0].query, { filename: 'a&b.png', subfolder: 'sub dir', type: 'output' }, '参数正确编码')
  assert.ok(!views.some((v) => v.query.type === 'temp'), '有正式输出时不下载预览图')
})

test('轮询：执行出错 → failed，带上 ComfyUI 的报错', async () => {
  reset()
  state.history['pid-1'] = {
    status: { status_str: 'error', completed: false, messages: [
      ['execution_start', { prompt_id: 'pid-1' }],
      ['execution_error', { prompt_id: 'pid-1', node_id: '3', node_type: 'KSampler', exception_message: 'CUDA out of memory', exception_type: 'torch.OutOfMemoryError' }],
    ] },
    outputs: {},
  }
  const r = await comfy().poll('pid-1')
  assert.equal(r.status, 'failed')
  assert.equal(r.error.kind, 'invalid')
  assert.match(r.error.message, /KSampler.*CUDA out of memory/)
})

test('取消：仅删除指定排队任务，运行中不做全局中断，画完了说明已完成', async () => {
  reset()
  const c = comfy()
  state.pending = ['other-pending', 'pid-1']
  state.running = ['other-running']
  assert.equal((await c.cancel('pid-1')).ok, true)
  const del = state.calls.find((x) => x.method === 'POST' && x.path === '/queue')
  assert.deepEqual(JSON.parse(del.body.toString()), { delete: ['pid-1'] })
  assert.ok(!state.calls.some((x) => x.path === '/interrupt'))
  assert.deepEqual(state.pending, ['other-pending'])
  assert.deepEqual(state.running, ['other-running'])

  reset()
  state.running = ['pid-1', 'other-running']
  const running = await c.cancel('pid-1')
  assert.equal(running.ok, false)
  assert.match(running.message, /无法安全取消/)
  assert.ok(!state.calls.some((x) => x.path === '/interrupt'))
  assert.deepEqual(state.running, ['pid-1', 'other-running'])
  assert.ok(!state.calls.some((x) => x.method === 'POST' && x.path === '/queue'))

  reset()
  state.history['pid-1'] = { status: { status_str: 'success', completed: true }, outputs: {} }
  assert.deepEqual(await c.cancel('pid-1'), { ok: false, message: '已经画完了' })
  assert.ok(!state.calls.some((x) => x.method === 'POST'))
})

test('取消竞态：排队转运行/完成/未删除都不能误报取消成功，更不能中断他人', async () => {
  for (const outcome of ['running', 'finished', 'keep']) {
    reset()
    state.pending = ['pid-1', 'other-pending']; state.running = ['other-running']; state.deleteOutcome = outcome
    const result = await comfy().cancel('pid-1')
    assert.equal(result.ok, false, outcome)
    assert.ok(state.running.includes('other-running'))
    assert.ok(state.pending.includes('other-pending'))
    const writes = state.calls.filter((x) => x.method === 'POST')
    assert.equal(writes.length, 1)
    assert.equal(writes[0].path, '/queue')
    assert.deepEqual(JSON.parse(writes[0].body), { delete: ['pid-1'] })
    assert.ok(!state.calls.some((x) => x.path === '/interrupt'))
  }
  reset()
  assert.deepEqual(await comfy().cancel('missing'), { ok: false, message: '找不到这个任务' })
  assert.ok(!state.calls.some((x) => x.method === 'POST'))
})

test('直调 submit：未知/禁用模式、错误角色/底图/蒙版/损坏图片在上传前拒绝', async () => {
  reset()
  await rejects(comfy().submit({ mode: 'bogus', inputs: [] }), 'unsupported')
  await rejects(comfy({ modes: [] }).submit({ mode: 'text', inputs: [] }), 'unsupported')
  await rejects(createComfyImages({ baseUrl, capabilities: { modes: [] }, extra: { workflow: WORKFLOW, bindings: BINDINGS } }).submit({ mode: 'text' }), 'unsupported')
  for (const req of [
    { mode: 'text', inputs: [{ role: 'base', buf: PNG }] },
    { mode: 'edit', inputs: [{ role: 'identity', buf: PNG }] },
    { mode: 'reference', inputs: [{ role: 'invalid', buf: PNG }] },
    { mode: 'mask', inputs: [{ role: 'base', buf: PNG }] },
    { mode: 'edit', inputs: [{ role: 'base', buf: PNG }], mask: { buf: PNG } },
    { mode: 'mask', inputs: [{ role: 'base', buf: JPG }], mask: { buf: PNG } },
    { mode: 'mask', inputs: [{ role: 'base', buf: PNG }], mask: { buf: JPG } },
    { mode: 'edit', inputs: [{ role: 'base', buf: PNG }, { role: 'identity', buf: PNG.subarray(0, 12) }] },
    { mode: 'edit', inputs: [{ role: 'base' }] },
  ]) await rejects(comfy().submit({ prompt: 'x', ...req }), 'invalid')
  await rejects(comfy({ bindings: { ...BINDINGS, mask: BINDINGS.base } }).submit({ mode: 'text', prompt: 'x' }), 'invalid', /覆盖/)
  assert.equal(state.calls.length, 0)
})

test('假 PNG 输出不能作为成功图片，取消能力禁用时不发请求', async () => {
  reset()
  state.history['pid-1'] = { status: { status_str: 'success', completed: true }, outputs: { 9: { images: [{ filename: 'bad.png', type: 'output' }] } } }
  state.files['output//bad.png'] = PNG.subarray(0, 12)
  const result = await comfy().poll('pid-1')
  assert.equal(result.status, 'failed')
  reset()
  const c = createComfyImages({ baseUrl, extra: { workflow: WORKFLOW, bindings: BINDINGS }, capabilities: { cancel: false } })
  assert.equal((await c.cancel('pid-1')).ok, false)
  await rejects(comfy().cancel(''), 'invalid')
  assert.equal(state.calls.length, 0)
})

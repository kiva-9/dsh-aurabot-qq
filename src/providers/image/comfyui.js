// ComfyUI：管理员登记一份 API 格式的工作流 + 绑定（点路径指到图里的节点输入），我们只往绑定的位置填值。
// 用户永远不能给工作流或文件路径：工作流来自 profile，输入图一律经 /upload/image 上传，结果只从 /history 给的文件名经 /view 下载。
//   POST /upload/image（multipart image）→ { name, subfolder, type }
//   POST /prompt { prompt, client_id } → { prompt_id, number, node_errors }
//   GET  /history/{id} → { [id]: { status: { status_str, completed, messages }, outputs: { nodeId: { images: [...] } } } }
//   GET  /view?filename=&subfolder=&type= → 图片字节
//   GET  /queue → { queue_running: [[num, id, ...]], queue_pending: [...] }
//   POST /queue { delete: [id] } 只删对应排队任务；不调用可能全局打断的 /interrupt。

import { randomUUID, randomInt } from 'node:crypto'
import { ProviderError, ROLES, request, classifyHttp, imageMime, imageInfo, checkRequest, mergeCapabilities, validateHttpUrl, MAX_IMAGE_BYTES } from './common.js'

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const VALUE_KEYS = ['prompt', 'negativePrompt', 'width', 'height', 'seed']
const ALL_KEYS = [...VALUE_KEYS, ...ROLES, 'mask']

/**
 * profile: { baseUrl, apiKey?, extra: { workflow: 对象或 JSON 字符串, bindings: { prompt: '6.inputs.text', ... }, modes?, clientId? } }
 */
export function createComfyImages(profile, { fetchImpl = fetch } = {}) {
  const base = String(profile.baseUrl || '').replace(/\/+$/, '')
  const x = profile.extra || {}
  const bindings = x.bindings || {}
  // 有些人会在 ComfyUI 前面套一层带鉴权的反代，填了密钥就带上
  const auth = profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}
  const clientId = x.clientId || randomUUID()
  const has = (k) => typeof bindings[k] === 'string' && bindings[k].trim() !== ''

  function capabilities() {
    const modes = []
    if (has('prompt')) modes.push('text')
    if (['identity', 'style', 'composition'].some(has)) modes.push('reference')
    if (has('base')) modes.push('edit')
    if (has('base') && has('mask')) modes.push('mask')
    // 管理员可以在 extra.modes 里再收窄（比如工作流其实不适合做编辑）
    return mergeCapabilities({
      modes,
      maxInputs: ROLES.filter(has).length,
      async: true,
      cancel: true, // 仅排队任务可取消；运行中返回 ok: false。
      idempotent: false, // ComfyUI 没有幂等键，同一个工作流提交两次就画两次
      sizes: [],
    }, { modes: x.modes })
  }

  function loadWorkflow() {
    let wf = x.workflow
    if (typeof wf === 'string') {
      try { wf = JSON.parse(wf) } catch (error) { throw new ProviderError('invalid', `工作流不是合法的 JSON：${error.message}`) }
    }
    if (!wf || typeof wf !== 'object' || Array.isArray(wf)) throw new ProviderError('invalid', '这个 ComfyUI 服务还没登记工作流')
    // 深拷贝：每次提交都从管理员登记的原样开始，不把上一次的提示词 / 图片名留在共享对象里
    return structuredClone(wf)
  }

  // 'nodeId.inputs.field' → { parent, key }；路径上任何一段不存在都算登记错了（不悄悄新建字段，那样 ComfyUI 会忽略它）
  function resolve(graph, name) {
    const path = bindings[name]
    const parts = path.split('.')
    if (parts.some((p) => !p || ['__proto__', 'prototype', 'constructor'].includes(p))) throw new ProviderError('invalid', `工作流绑定路径不合法：${path}`)
    let parent = graph
    for (let i = 0; i < parts.length - 1; i++) {
      parent = parent && Object.hasOwn(parent, parts[i]) ? parent[parts[i]] : null
      if (!parent || typeof parent !== 'object') parent = null
      if (!parent) break
    }
    const key = parts[parts.length - 1]
    if (parts.length < 2 || !parent || !Object.hasOwn(parent, key)) {
      throw new ProviderError('invalid', `工作流里找不到绑定「${name}」指向的 ${path}，请管理员检查绑定`)
    }
    return { parent, key }
  }

  async function upload(buf, mime, { signal }) {
    const form = new FormData()
    form.append('image', new Blob([buf], { type: mime }), `aurabot-${randomUUID()}.${EXT[mime] || 'png'}`)
    form.append('overwrite', 'true')
    form.append('type', 'input')
    const r = await request(fetchImpl, `${base}/upload/image`, { method: 'POST', headers: { ...auth }, body: form }, { signal })
    // 上传失败时还没提交工作流，不会画也不花钱，按 HTTP 归类即可
    if (!r.ok) throw classifyHttp(r.status, r.json || r.text)
    if (!r.json?.name) throw new ProviderError('unknown', 'ComfyUI 上传图片后没返回文件名')
    // LoadImage 认「子目录/文件名」
    return r.json.subfolder ? `${r.json.subfolder}/${r.json.name}` : r.json.name
  }

  function nodeErrorSummary(nodeErrors) {
    return Object.entries(nodeErrors).map(([id, e]) => {
      const msgs = (e?.errors || []).map((it) => [it.message, it.details].filter(Boolean).join('：')).filter(Boolean)
      return `节点 ${id}${e?.class_type ? `（${e.class_type}）` : ''}：${msgs.join('；') || '有错误'}`
    }).join('\n')
  }

  async function submit(req, { signal } = {}) {
    if (!base) throw new ProviderError('invalid', '这个 ComfyUI 服务还没填地址')
    const url = validateHttpUrl(base)
    if (url.search || url.hash) throw new ProviderError('invalid', 'ComfyUI baseUrl 不能包含查询参数或片段')
    if (!has('prompt')) throw new ProviderError('invalid', '工作流还没绑定提示词（bindings.prompt）')
    const caps = mergeCapabilities(capabilities(), profile.capabilities)
    if (!caps.modes.includes(req?.mode)) throw new ProviderError('unsupported', `这个 ComfyUI 工作流不支持「${req?.mode === 'mask' ? '蒙版' : req?.mode}」模式`)
    const why = checkRequest(req, caps)
    if (why) throw new ProviderError(/不支持|最多收/.test(why) ? 'unsupported' : 'invalid', why)
    if (req.n !== undefined && req.n !== 1) throw new ProviderError('unsupported', 'ComfyUI 出图数量由登记的工作流决定，只接受 n = 1')
    const graph = loadWorkflow()
    // 先把所有绑定都校验一遍，登记错了的话在上传图片之前就报出来
    const slots = {}
    for (const k of ALL_KEYS) if (has(k)) {
      slots[k] = resolve(graph, k)
      if (Object.entries(slots).some(([other, slot]) => other !== k && slot.parent === slots[k].parent && slot.key === slots[k].key)) throw new ProviderError('invalid', `工作流绑定「${k}」与其他字段重叠，会覆盖输入`)
    }

    // 输入图：每个角色一个绑定位置。没有绑定的角色、或同一角色多于一张，都直接拒绝——不能悄悄丢掉参考图
    const inputs = req.inputs || []
    const seen = new Set()
    for (const im of inputs) {
      if (!slots[im.role]) throw new ProviderError('unsupported', `这个 ComfyUI 工作流不接收「${im.role}」角色的图`)
      if (seen.has(im.role)) throw new ProviderError('unsupported', `这个 ComfyUI 工作流只能放一张「${im.role}」角色的图`)
      seen.add(im.role)
      imageInfo(im.buf)
    }
    if (req.mask && !slots.mask) throw new ProviderError('unsupported', '这个 ComfyUI 工作流不支持蒙版')
    if (req.mask) imageInfo(req.mask.buf)

    for (const im of inputs) {
      const name = await upload(im.buf, imageInfo(im.buf).mime, { signal })
      slots[im.role].parent[slots[im.role].key] = name
    }
    if (req.mask) {
      // ComfyUI 的 LoadImage 把 alpha 通道当蒙版输出（透明 = 1 = 要重绘），正好和我们规范化后的约定（透明 = 要改，见 MASK_NOTE）一致，
      // 所以原样上传到蒙版绑定的 LoadImage 即可，不用反相
      slots.mask.parent[slots.mask.key] = await upload(req.mask.buf, 'image/png', { signal })
    }

    const set = (k, v) => { if (slots[k] && v !== undefined && v !== null && v !== '') slots[k].parent[slots[k].key] = v }
    set('prompt', String(req.prompt ?? ''))
    // 反向提示词 / 尺寸没绑定就用工作流里的默认值（不是图，不算丢内容）
    set('negativePrompt', req.negativePrompt)
    const m = /^(\d+)\s*[xX×]\s*(\d+)$/.exec(String(req.size || ''))
    if (m) { set('width', Number(m[1])); set('height', Number(m[2])) }
    // 种子绑定了但没给就随机一个，不然工作流里写死的种子会让每次都出同一张
    if (slots.seed) set('seed', Number.isSafeInteger(req.seed) ? req.seed : randomInt(0, 2 ** 47))

    const r = await request(fetchImpl, `${base}/prompt`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ prompt: graph, client_id: clientId }),
    }, { signal })
    // node_errors 可能和 400 一起回来，也可能 200 带着：都是工作流 / 输入不对，不重试
    const ne = r.json?.node_errors
    if (ne && typeof ne === 'object' && Object.keys(ne).length) throw new ProviderError('invalid', `ComfyUI 拒绝了工作流：\n${nodeErrorSummary(ne)}`, { status: r.status })
    if (!r.ok) throw classifyHttp(r.status, r.json || r.text)
    if (!r.json?.prompt_id) throw new ProviderError('unknown', 'ComfyUI 没返回任务号，可能已经在画了')
    return { status: 'running', providerTaskId: r.json.prompt_id }
  }

  async function getJson(path, { signal }) {
    const r = await request(fetchImpl, `${base}${path}`, { method: 'GET', headers: { ...auth } }, { timeoutMs: 30000, signal })
    if (!r.ok) throw classifyHttp(r.status, r.json || r.text)
    return r.json || {}
  }

  async function postJson(path, body, { signal }) {
    const r = await request(fetchImpl, `${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(body),
    }, { timeoutMs: 30000, signal })
    if (!r.ok) throw classifyHttp(r.status, r.json || r.text)
    return r
  }

  // 在队列里的位置：'running' / 'pending' / ''
  async function queueState(id, { signal }) {
    const q = await getJson('/queue', { signal })
    const inList = (list) => Array.isArray(list) && list.some((it) => Array.isArray(it) && it[1] === id)
    if (inList(q.queue_running)) return 'running'
    if (inList(q.queue_pending)) return 'pending'
    return ''
  }

  function errorFrom(status) {
    const msgs = Array.isArray(status?.messages) ? status.messages : []
    const ev = msgs.find((it) => Array.isArray(it) && it[0] === 'execution_error')?.[1]
    if (ev) {
      const where = ev.node_type ? `节点 ${ev.node_id ?? ''}（${ev.node_type}）` : '工作流'
      // 执行时报错多半是工作流 / 输入的问题（模型缺失、尺寸不对、显存不够），原样重试也一样，按 invalid 处理
      return new ProviderError('invalid', `ComfyUI 执行出错，${where}：${ev.exception_message || ev.exception_type || '未知错误'}`, { maybeCharged: false })
    }
    if (msgs.some((it) => Array.isArray(it) && it[0] === 'execution_interrupted')) {
      return new ProviderError('invalid', 'ComfyUI 的任务被打断了', { maybeCharged: false })
    }
    return new ProviderError('unknown', 'ComfyUI 任务失败了，没给原因', { maybeCharged: false })
  }

  async function poll(promptId, { signal } = {}) {
    const id = String(promptId)
    const h = await getJson(`/history/${encodeURIComponent(id)}`, { signal })
    const entry = h[id]
    if (!entry) {
      const state = await queueState(id, { signal })
      if (state) return { status: 'running', providerTaskId: id, progress: state === 'pending' ? '排队中' : '正在画' }
      // 历史和队列里都没有：ComfyUI 重启过或历史被清了，结果拿不回来了
      throw new ProviderError('unknown', '任务不见了（ComfyUI 可能重启过）', { maybeCharged: false })
    }
    const st = entry.status || {}
    if (st.status_str === 'error') return { status: 'failed', error: errorFrom(st) }
    if (!st.completed && st.status_str !== 'success') return { status: 'running', providerTaskId: id }

    let images = []
    for (const out of Object.values(entry.outputs || {})) images.push(...(out?.images || []))
    // 工作流里同时有 PreviewImage（temp）和 SaveImage（output）时只要正式输出，免得同一张图发两遍
    if (images.some((im) => im.type === 'output')) images = images.filter((im) => im.type === 'output')
    const outputs = []
    for (const im of images) {
      if (!im?.filename) continue
      const qs = new URLSearchParams({ filename: im.filename, subfolder: im.subfolder || '', type: im.type || 'output' })
      const r = await request(fetchImpl, `${base}/view?${qs}`, { method: 'GET', headers: { ...auth } }, { timeoutMs: 120000, signal, maxBytes: MAX_IMAGE_BYTES })
      if (!r.ok) throw new ProviderError('unknown', `下载 ComfyUI 结果失败（${r.status}）`, { status: r.status, maybeCharged: false })
      // 输出节点也可能存视频 / 潜空间文件，只收真正的图片
      const mime = imageMime(r.buf)
      if (mime) outputs.push({ buf: r.buf, mime })
    }
    if (!outputs.length) return { status: 'failed', error: new ProviderError('invalid', 'ComfyUI 画完了，但工作流没有输出图片（检查是不是缺了保存图片的节点）', { maybeCharged: false }) }
    return { status: 'done', outputs, providerTaskId: id, billing: 'free' }
  }

  async function cancel(promptId, { signal } = {}) {
    if (typeof promptId !== 'string' || !promptId.trim()) throw new ProviderError('invalid', '缺少 ComfyUI 任务号')
    if (!mergeCapabilities(capabilities(), profile.capabilities).cancel) return { ok: false, message: '这个服务未启用取消能力' }
    const id = String(promptId)
    let state = await queueState(id, { signal })
    if (state === 'pending') {
      await postJson('/queue', { delete: [id] }, { signal })
      // GET 和 DELETE 之间可能已开始执行；/queue 的 200 并不保证实际删掉了任务。
      state = await queueState(id, { signal })
      if (state === 'running') return { ok: false, message: '任务已开始执行，无法安全取消；未发送全局中断' }
      if (state === 'pending') return { ok: false, message: '任务仍在排队，未能确认取消' }
      const h = await getJson(`/history/${encodeURIComponent(id)}`, { signal })
      if (h[id]) return { ok: false, message: '已经画完了' }
      return { ok: true, message: '已经从排队里撤掉了' }
    }
    if (state === 'running') {
      return { ok: false, message: '任务正在执行，无法安全取消；未发送全局中断' }
    }
    const h = await getJson(`/history/${encodeURIComponent(id)}`, { signal })
    if (h[id]) return { ok: false, message: '已经画完了' }
    return { ok: false, message: '找不到这个任务' }
  }

  return { protocol: 'comfyui', capabilities, submit, poll, cancel }
}

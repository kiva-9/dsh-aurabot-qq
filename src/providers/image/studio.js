// Local Studio API, deliberately separate from ComfyUI's workflow protocol.
// Never call /api/cancel: Studio implements it as a global queue clear/interrupt.
import { ProviderError, checkRequest, imageInfo, MAX_IMAGE_BYTES, mergeCapabilities, request, validateHttpUrl } from './common.js'
import { studioMaskPng } from './studio-mask.js'

const MODE = { text: 'txt2img', reference: 'reference', edit: 'img2img', mask: 'edit' }
const ID = /^[0-9a-f]{32}$/
const MAX_PIXELS = 16 * 1024 * 1024
const MAX_SIDE = 8192
// aiohttp's client_max_size is 80 MiB; reserve room for JSON and field values.
const MAX_ENCODED_IMAGES = 78 * 1024 * 1024

function baseOf(profile) {
  if (typeof profile?.baseUrl !== 'string' || !profile.baseUrl) throw new ProviderError('invalid', '请填写 Studio 本机服务地址')
  const url = validateHttpUrl(profile.baseUrl)
  // Explicit numeric loopback and port avoid DNS / proxy ambiguity. No path prefix,
  // credentials, query, or fragment: every endpoint below is fixed in this file.
  if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/?$/.test(profile.baseUrl) || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new ProviderError('invalid', 'Studio 地址必须是 http://127.0.0.1:端口，不能包含路径、查询或片段')
  }
  return url.origin
}

function cleanStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.ready !== 'boolean' || !Array.isArray(value.models) || value.models.length > 4096) {
    throw new ProviderError('unknown', 'Studio 状态响应格式不正确', { maybeCharged: false })
  }
  if (value.queue !== undefined && (!Number.isSafeInteger(value.queue) || value.queue < 0)) throw new ProviderError('unknown', 'Studio 队列状态格式不正确', { maybeCharged: false })
  const ids = new Set()
  const models = value.models.map(model => {
    if (!model || typeof model !== 'object' || Array.isArray(model) || typeof model.id !== 'string' || !model.id.trim() || model.id.length > 512 || ids.has(model.id) || !Array.isArray(model.features) || model.features.length > 64 || model.features.some(feature => typeof feature !== 'string' || feature.length > 100)) {
      throw new ProviderError('unknown', 'Studio 模型列表格式不正确', { maybeCharged: false })
    }
    ids.add(model.id)
    const result = { id: model.id, features: [...model.features] }
    if (typeof model.name === 'string') result.name = model.name.slice(0, 500)
    if (typeof model.prompt_hint === 'string') result.prompt_hint = model.prompt_hint.slice(0, 2000)
    if (model.reference_cfg !== undefined) result.reference_cfg = model.reference_cfg
    return result
  })
  return { ready: value.ready, models, ...(value.queue === undefined ? {} : { queue: value.queue }) }
}

/** Read-only status probe; no key, redirect, generation, or other write action. */
export async function probeStudioStatus(profile, { fetchImpl = fetch, signal } = {}) {
  const base = baseOf(profile)
  const r = await request(fetchImpl, `${base}/api/status`, { method: 'GET', redirect: 'error' }, { signal, timeoutMs: 30000, maxBytes: 2 * 1024 * 1024 })
  if (!r.ok) throw new ProviderError('transient', `读取 Studio 状态失败（${r.status}）`, { status: r.status, maybeCharged: false })
  return cleanStatus(r.json)
}

function optionalNumber(value, label, min, max, { integer = false } = {}) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value)) || value < min || value > max) {
    throw new ProviderError('invalid', `${label} 必须是 ${min}–${max} 的${integer ? '整数' : '数字'}`, { maybeCharged: false })
  }
  return value
}

function inputInfo(input) {
  if (!(input?.buf instanceof Uint8Array) || input.buf.byteLength > MAX_IMAGE_BYTES) throw new ProviderError('invalid', '输入图缺少字节或超过大小限制', { maybeCharged: false })
  const info = imageInfo(input.buf)
  if (info.width > MAX_SIDE || info.height > MAX_SIDE || info.width * info.height > MAX_PIXELS) throw new ProviderError('invalid', '输入图像素尺寸超过限制', { maybeCharged: false })
  return info
}

// A mask drawn against a browser-oriented image can disagree with the original
// byte orientation. Avoid changing the wrong region when EXIF may be applied.
function hasExif(bytes, mime) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (mime === 'image/jpeg') return b.includes(Buffer.from('Exif\0\0', 'binary'))
  if (mime === 'image/png') {
    for (let p = 8; p + 12 <= b.length;) {
      const n = b.readUInt32BE(p)
      if (b.toString('ascii', p + 4, p + 8) === 'eXIf') return true
      p += n + 12
    }
  }
  if (mime === 'image/webp') {
    for (let p = 12; p + 8 <= b.length;) {
      const n = b.readUInt32LE(p + 4)
      if (b.toString('ascii', p, p + 4) === 'EXIF') return true
      p += 8 + n + (n & 1)
    }
  }
  return false
}

function dataUrl(bytes, mime) {
  return `data:${mime};base64,${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')}`
}

function imageBudget(items) {
  let encoded = 0
  for (const { bytes, mime } of items) encoded += 4 * Math.ceil(bytes.byteLength / 3) + mime.length + 20
  if (encoded > MAX_ENCODED_IMAGES) throw new ProviderError('invalid', '输入图总大小超过 Studio 请求限制', { maybeCharged: false })
}

export function createStudioImages(profile, { fetchImpl = fetch } = {}) {
  const x = profile?.extra ?? {}
  function capabilities() {
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw new ProviderError('invalid', 'Studio 的 extra 配置必须是对象')
    optionalNumber(x.denoise, 'denoise', 0.05, 1)
    optionalNumber(x.weight, 'weight', 0, 1.5)
    return mergeCapabilities({ modes: ['text', 'reference', 'edit', 'mask'], maxInputs: 3, async: true, cancel: false, idempotent: false, sizes: [] }, { modes: x.modes, maxInputs: x.maxInputs, sizes: x.sizes })
  }

  async function submit(req, { signal } = {}) {
    const base = baseOf(profile)
    if (typeof profile?.model !== 'string' || !profile.model.trim() || profile.model.length > 512) throw new ProviderError('invalid', '请填写 Studio 模型 ID', { maybeCharged: false })
    const modelId = profile.model
    const caps = mergeCapabilities(capabilities(), profile.capabilities)
    if (!caps.modes.includes(req?.mode)) throw new ProviderError('unsupported', '这个 Studio 服务没有启用所需模式', { maybeCharged: false })
    // Reject clearly oversized inputs before parsing or allocating base64 strings.
    if (Array.isArray(req.inputs)) {
      const known = req.inputs.filter(im => im?.buf instanceof Uint8Array).map(im => ({ bytes: im.buf, mime: 'image/png' }))
      if (known.some(im => im.bytes.byteLength > MAX_IMAGE_BYTES)) throw new ProviderError('invalid', '输入图超过大小限制', { maybeCharged: false })
      imageBudget(known)
    }
    const why = checkRequest(req, caps)
    if (why) throw new ProviderError(/不支持|最多收/.test(why) ? 'unsupported' : 'invalid', why, { maybeCharged: false })
    if (req.n !== undefined && req.n !== 1) throw new ProviderError('unsupported', 'Studio 每次只能提交一张图片（n = 1）', { maybeCharged: false })
    if (typeof req.prompt !== 'string' || !req.prompt.trim() || req.prompt.length > 6000) throw new ProviderError('invalid', 'Studio 提示词要在 1–6000 字之间', { maybeCharged: false })
    if (req.negativePrompt !== undefined && (typeof req.negativePrompt !== 'string' || req.negativePrompt.length > 2000)) throw new ProviderError('invalid', 'Studio 负面词不能超过 2000 字', { maybeCharged: false })
    const seed = optionalNumber(req.seed, 'seed', -1, Number.MAX_SAFE_INTEGER, { integer: true })
    const denoise = optionalNumber(x.denoise, 'denoise', 0.05, 1)
    const weight = optionalNumber(x.weight, 'weight', 0, 1.5)
    let size = null
    if (req.size !== undefined && req.size !== '') {
      const m = typeof req.size === 'string' && /^(\d{3,4})[xX×](\d{3,4})$/.exec(req.size)
      if (!m) throw new ProviderError('invalid', 'Studio 尺寸必须是 WIDTHxHEIGHT', { maybeCharged: false })
      const width = Number(m[1]), height = Number(m[2])
      if (width < 256 || height < 256 || width > 1536 || height > 1536 || width % 32 || height % 32) throw new ProviderError('invalid', 'Studio 宽高必须为 256–1536 内的 32 倍数', { maybeCharged: false })
      size = { width, height }
    }
    const inputs = req.inputs || []
    if (['edit', 'mask'].includes(req.mode) && inputs.length !== 1) throw new ProviderError('unsupported', 'Studio 编辑只能接收唯一一张底图，不能额外带参考图', { maybeCharged: false })
    const images = inputs.map(input => ({ bytes: input.buf, mime: inputInfo(input).mime }))
    let mask
    if (req.mode === 'mask') {
      if (!(req.mask?.buf instanceof Uint8Array) || req.mask.buf.byteLength > MAX_IMAGE_BYTES) throw new ProviderError('invalid', '蒙版缺少字节或超过大小限制', { maybeCharged: false })
      if (hasExif(inputs[0].buf, images[0].mime)) throw new ProviderError('unsupported', '底图含有 EXIF 方向信息，请先转为无方向信息的图片后重画蒙版', { maybeCharged: false })
      mask = studioMaskPng(req.mask.buf)
    }
    imageBudget(mask ? [...images, { bytes: mask, mime: 'image/png' }] : images)

    // A request is built only after local checks; status is always refreshed to
    // avoid silently switching away from a missing or unsupported model.
    const status = await probeStudioStatus(profile, { fetchImpl, signal })
    if (!status.ready) throw new ProviderError('transient', 'Studio 或 ComfyUI 尚未就绪', { maybeCharged: false })
    const model = status.models.find(item => item.id === modelId)
    if (!model) throw new ProviderError('unsupported', `Studio 当前没有模型「${modelId}」`, { maybeCharged: false })
    const mode = MODE[req.mode]
    if (!model.features.includes(mode)) throw new ProviderError('unsupported', `Studio 模型「${model.name || model.id}」不支持 ${req.mode} 模式`, { maybeCharged: false })
    const body = { model: modelId, mode, prompt: req.prompt, count: 1 }
    if (size) Object.assign(body, size) // Studio uses source dimensions in img2img/edit.
    if (req.negativePrompt?.trim()) body.negative = req.negativePrompt
    if (seed !== undefined) body.seed = seed
    if (req.mode === 'reference') {
      const cfg = optionalNumber(model.reference_cfg, '模型 reference_cfg', 1, 20)
      if (cfg === undefined) throw new ProviderError('unsupported', 'Studio 模型未提供参考图 CFG，无法安全提交', { maybeCharged: false })
      body.cfg = cfg
      if (weight !== undefined) body.weight = weight
      body.references = images.map(image => dataUrl(image.bytes, image.mime))
    } else if (req.mode === 'edit' || req.mode === 'mask') {
      if (denoise !== undefined) body.denoise = denoise
      body.image = dataUrl(images[0].bytes, images[0].mime)
      if (mask) body.mask = dataUrl(mask, 'image/png')
    }
    const r = await request(fetchImpl, `${base}/api/generate`, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, { signal })
    // Even a 400 can come from JSON parsing after Studio has submitted a Comfy
    // prompt; no HTTP response from this endpoint proves that nothing ran.
    if (!r.ok) throw new ProviderError('unknown', `Studio 提交返回 ${r.status}，任务可能已经开始`, { status: r.status, maybeCharged: true, retryable: false })
    const ids = r.json?.ids
    if (!Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== 'string' || !ID.test(ids[0])) throw new ProviderError('unknown', 'Studio 未返回有效任务号，任务可能已经开始', { maybeCharged: true, retryable: false })
    return { status: 'running', providerTaskId: ids[0] }
  }

  async function poll(id, { signal } = {}) {
    const base = baseOf(profile)
    if (typeof id !== 'string' || !ID.test(id)) throw new ProviderError('invalid', 'Studio 任务号不合法', { maybeCharged: false })
    const r = await request(fetchImpl, `${base}/api/job/${id}`, { method: 'GET', redirect: 'error' }, { signal, timeoutMs: 30000, maxBytes: 2 * 1024 * 1024 })
    if (!r.ok) throw new ProviderError('unknown', `Studio 无法确认任务状态（${r.status}）；服务重启后任务可能丢失`, { status: r.status, retryable: false })
    const result = r.json
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new ProviderError('unknown', 'Studio 任务状态无法识别')
    if (result.status === 'queued' || result.status === 'running') {
      return { status: 'running', providerTaskId: id, progress: result.status === 'queued' ? '排队中' : '正在画' }
    }
    if (result.status === 'failed') {
      // Studio also reports "canceled" when neither Comfy's queue nor history
      // contains the prompt. Restart/history loss cannot establish its outcome.
      if (typeof result.error !== 'string' || !result.error.trim() || result.error.trim() === '任务已取消') throw new ProviderError('unknown', 'Studio 无法确认任务是否完成或已取消')
      const message = result.error.slice(0, 500)
      return { status: 'failed', providerTaskId: id, billing: 'unknown', error: new ProviderError('invalid', `Studio 任务失败：${message}`, { maybeCharged: true }) }
    }
    if (result.status !== 'done') throw new ProviderError('unknown', 'Studio 任务状态无法识别')
    // Accept exactly the documented same-origin path for this job, not arbitrary
    // URLs, escaped paths, queries, redirects, or another job's output.
    if (result.url !== `/image/${id}.png`) throw new ProviderError('unknown', 'Studio 返回的结果地址与任务不匹配')
    const img = await request(fetchImpl, `${base}/image/${id}.png`, { method: 'GET', redirect: 'error' }, { signal, timeoutMs: 120000, maxBytes: MAX_IMAGE_BYTES })
    if (!img.ok) throw new ProviderError('unknown', `下载 Studio 结果失败（${img.status}）`, { status: img.status })
    let info
    try { info = imageInfo(img.buf) } catch { throw new ProviderError('unknown', 'Studio 结果不是有效 PNG') }
    if (info.mime !== 'image/png' || info.width > 1536 || info.height > 1536) throw new ProviderError('unknown', 'Studio 结果不是有效 PNG 或尺寸超过限制')
    return { status: 'done', outputs: [{ buf: img.buf, mime: info.mime }], providerTaskId: id, billing: 'unknown' }
  }

  async function cancel() {
    return { ok: false, message: 'Studio 不能安全取消单个任务；未发送全局中断' }
  }

  return { protocol: 'studio', capabilities, submit, poll, cancel }
}

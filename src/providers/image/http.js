// 通用 HTTP 映射：主人在面板里把任意生图服务的接口「填表」映射过来（同步直接出图，或异步 提交 / 查状态 / 取结果 / 取消）。
// 安全约定：只做占位符替换和 JSON 路径取值，不支持任何 JS 模板 / eval —— 配置是可以被导入分享的，不能变成执行代码的入口。
// 占位符的转义沿用语音那边的 fill / pick，免得两套映射行为不一致。

import { ProviderError, MODES, request, classifyHttp, outputFrom, imageMime, imageInfo } from './common.js'
import { fill, pick } from '../../voice/tts.js'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const BODY_TYPES = ['json', 'form', 'multipart', 'none']
const STATUS_BODY_TYPES = ['json', 'none']
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
// 普通占位符：按所在位置转义（url / json / 原样）
const VAR_KEYS = ['prompt', 'negativePrompt', 'size', 'width', 'height', 'n', 'mode', 'apiKey', 'taskId', 'maskBase64']

/**
 * 模板替换：一遍扫完所有占位符。
 * 不分两遍做是因为：先替换的值（比如用户的提示词里写了 "{apiKey}"）不能在第二遍里又被展开，否则提示词就能把密钥套进请求体。
 * {imagesJson} / {imagesDataUrls} 本身就是 JSON 数组片段，只在 json 体里不带引号插入。
 * 前者保留 role/mime/base64 对象，后者是 data URL 字符串数组；其余值的转义沿用 fill。
 */
export function fillTemplate(template, vars, enc = 'raw') {
  const re = new RegExp(`\\{(${[...VAR_KEYS, 'imagesJson', 'imagesDataUrls'].join('|')})\\}`, 'g')
  return String(template ?? '').replace(re, (_, k) => {
    if (k === 'imagesJson' || k === 'imagesDataUrls') return enc === 'json' ? vars[k] || '[]' : ''
    return fill('{apiKey}', { apiKey: vars[k] }, enc)
  })
}

function methodOf(m, fallback = 'POST') {
  return String(m || fallback).toUpperCase()
}

/** 检查配置，返回问题列表（中文，给面板直接显示）；空数组 = 没问题。 */
export function validateHttpProfile(profile = {}) {
  const x = profile?.extra || {}
  const s = x.submit || {}
  const res = x.response || {}
  const st = x.status
  const problems = []
  const isUrl = (u) => /^https?:\/\//.test(String(u || ''))

  if (!s.url) problems.push('没填提交地址')
  else if (!isUrl(s.url)) problems.push('提交地址要以 http:// 或 https:// 开头')
  if (!METHODS.includes(methodOf(s.method))) problems.push(`提交方法不对：${s.method}（只能是 ${METHODS.join(' / ')}）`)
  const bodyType = s.bodyType || 'json'
  if (!BODY_TYPES.includes(bodyType)) problems.push(`请求体类型不对：${s.bodyType}（只能是 ${BODY_TYPES.join(' / ')}）`)
  if (methodOf(s.method) === 'GET' && bodyType !== 'none') problems.push('GET 请求不能带请求体，请求体类型要选 none')
  if (bodyType === 'multipart' && s.body != null && s.body !== '' && !parseFields(s.body)) problems.push('multipart 的请求体要写成 JSON 对象（每个键是一个表单字段）')

  const modes = Array.isArray(x.modes) && x.modes.length ? x.modes : ['text']
  const badModes = modes.filter((m) => !MODES.includes(m))
  if (badModes.length) problems.push(`不认识的模式：${badModes.join('、')}`)
  const needsImages = modes.some((m) => m !== 'text')
  if (needsImages) {
    // 声明了要收图，就得有地方放图，不然图会被悄悄丢掉
    if (bodyType === 'json' && !/\{(?:imagesJson|imagesDataUrls)\}/.test(String(s.body || ''))) problems.push('声明了要收输入图，但 JSON 请求体里没有 {imagesJson} 或 {imagesDataUrls}')
    if (bodyType === 'form' || bodyType === 'none') problems.push('声明了要收输入图，请求体类型要选 json 或 multipart')
  }
  if (modes.includes('mask') && bodyType === 'json' && !String(s.body || '').includes('{maskBase64}')) problems.push('声明了蒙版编辑，但 JSON 请求体里没有 {maskBase64}')

  const kind = res.kind || 'json'
  if (!['image', 'json'].includes(kind)) problems.push(`返回类型不对：${res.kind}（只能是 image 或 json）`)
  if (kind === 'image' && res.taskIdPath) problems.push('返回类型是直接图片时不能再填任务号路径')
  if (kind === 'json' && !res.imagesPath && !res.taskIdPath) problems.push('没填返回里图片的路径（imagesPath）')

  if (kind === 'json' && res.taskIdPath) {
    if (!st) problems.push('填了任务号路径（异步），但没配置查状态的接口')
    else {
      if (!st.url) problems.push('没填查状态地址')
      else if (!isUrl(st.url)) problems.push('查状态地址要以 http:// 或 https:// 开头')
      if (!METHODS.includes(methodOf(st.method, 'GET'))) problems.push(`查状态方法不对：${st.method}`)
      // 旧配置默认不带 body；POST JSON 可把任务号放在 body，不要求再写到 URL。
      const statusBodyType = st.bodyType || 'none'
      if (!STATUS_BODY_TYPES.includes(statusBodyType)) problems.push('查状态请求体类型不对（只能是 json / none）')
      if (methodOf(st.method, 'GET') === 'GET' && statusBodyType !== 'none') problems.push('查状态 GET 请求不能带请求体，请求体类型要选 none')
      if (statusBodyType === 'none' && st.body != null && st.body !== '') problems.push('查状态填了请求体，请把 bodyType 设为 json')
      if (statusBodyType === 'json') {
        try {
          if (typeof st.body !== 'string') throw new Error('not a template')
          JSON.parse(fillTemplate(st.body, { taskId: 'validation', apiKey: 'validation' }, 'json'))
        } catch (error) { problems.push('查状态的请求体要写成有效 JSON 模板（body）') }
      }
      if (!String(st.url || '').includes('{taskId}') && !(statusBodyType === 'json' && String(st.body || '').includes('{taskId}'))) problems.push('查状态地址或 JSON 请求体里没有 {taskId}')
      if (!st.statePath) problems.push('没填状态字段的路径（statePath）')
      if (!Array.isArray(st.doneValues) || !st.doneValues.length) problems.push('没填表示「完成」的状态值（doneValues）')
      if (!st.imagesPath && !res.imagesPath) problems.push('没填完成后图片的路径（imagesPath）')
    }
  }
  if (x.cancel) {
    if (!res.taskIdPath) problems.push('同步服务不需要配置取消接口')
    if (!x.cancel.url) problems.push('没填取消地址')
    else if (!isUrl(x.cancel.url)) problems.push('取消地址要以 http:// 或 https:// 开头')
    if (!METHODS.includes(methodOf(x.cancel.method))) problems.push(`取消方法不对：${x.cancel.method}`)
  }
  return problems
}

/** multipart 的 body：JSON 对象（字符串或已解析的对象都行），解析失败返回 null。 */
function parseFields(body) {
  if (body && typeof body === 'object' && !Array.isArray(body)) return body
  try {
    const o = JSON.parse(String(body))
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null
  } catch (error) {
    return null
  }
}

/** imagesPath 取到的东西 → outputFrom 认得的形状：裸 base64 字符串包成 { b64 }，data URL / http 地址 / 对象原样。 */
function toItems(v) {
  const list = Array.isArray(v) ? v : v == null || v === '' ? [] : [v]
  return list.map((it) => (typeof it === 'string' && !/^(data:|https?:\/\/)/.test(it) ? { b64: it } : it))
}

/**
 * profile: { apiKey, extra: { headers, modes, maxInputs, submit, response, status?, cancel? } }（字段见 validateHttpProfile）
 * status.bodyType 默认为 none；POST JSON 用 bodyType: 'json', body: '{"id":"{taskId}"}'。
 */
export function createHttpImages(profile, { fetchImpl = fetch } = {}) {
  const x = profile?.extra || {}
  const s = x.submit || {}
  const res = x.response || {}
  const st = x.status || null
  const async = Boolean(res.taskIdPath)

  function assertProfile() {
    const problems = validateHttpProfile(profile)
    if (problems.length) throw new ProviderError('invalid', `生图服务的 HTTP 映射没配好：${problems.join('；')}`)
  }

  function capabilities() {
    const modes = Array.isArray(x.modes) && x.modes.length ? x.modes.filter((m) => MODES.includes(m)) : ['text']
    const onlyText = modes.every((m) => m === 'text')
    const maxInputs = Number.isFinite(Number(x.maxInputs)) && x.maxInputs !== null && x.maxInputs !== '' ? Math.max(0, Number(x.maxInputs)) : onlyText ? 0 : 1
    return { modes, maxInputs, async, cancel: Boolean(x.cancel), idempotent: false, sizes: [] }
  }

  function headersFor(vars) {
    const h = {}
    // 头部原样替换：值里不该出现换行，出现就去掉，免得拼出额外的头
    for (const [k, v] of Object.entries(x.headers || {})) h[k] = fillTemplate(v, vars).replace(/[\r\n]/g, '')
    return h
  }

  function varsFor(req = {}, extra = {}) {
    const size = String(req.size || '')
    const [w, hgt] = /^\d+x\d+$/.test(size) ? size.split('x') : ['', '']
    return {
      prompt: req.prompt || '', negativePrompt: req.negativePrompt || '', size, width: w, height: hgt,
      n: req.n || 1, mode: req.mode || 'text', apiKey: profile?.apiKey || '', taskId: '', ...extra,
    }
  }

  // 底图放第一张（编辑以它为准），其余按原顺序
  function orderedInputs(req) {
    return [...(req.inputs || [])].sort((a, b) => (a.role === 'base' ? -1 : b.role === 'base' ? 1 : 0))
  }

  async function imagesFrom(json, path, signal) {
    const items = toItems(pick(json, path))
    if (!items.length) throw new ProviderError('unknown', `生图服务返回里 ${path} 没有图片`, { maybeCharged: true })
    const outputs = []
    for (const it of items) outputs.push(await outputFrom(it, { fetchImpl, signal }))
    return outputs
  }

  async function submit(req, { signal } = {}) {
    assertProfile()
    const inputs = orderedInputs(req)
    const vars = varsFor(req, {
      imagesJson: JSON.stringify(inputs.map((im) => ({ role: im.role, mime: im.mime, base64: Buffer.from(im.buf).toString('base64') }))),
      // 只为使用此占位符的 JSON 模板生成；MIME 来自实际字节，不能伪装成 data:text/html 等。
      ...(String(s.body || '').includes('{imagesDataUrls}') ? { imagesDataUrls: JSON.stringify(inputs.map((im) => {
        const buf = Buffer.from(im.buf), { mime } = imageInfo(buf)
        if (im.mime && im.mime !== mime) throw new ProviderError('invalid', '输入图的 MIME 与图片字节不符')
        return `data:${mime};base64,${buf.toString('base64')}`
      })) } : {}),
      maskBase64: req.mask ? Buffer.from(req.mask.buf).toString('base64') : '',
    })
    const url = fillTemplate(s.url, vars, 'url')
    const method = methodOf(s.method)
    const bodyType = s.bodyType || 'json'
    const headers = {}
    let body
    if (bodyType === 'json') {
      headers['content-type'] = 'application/json'
      body = fillTemplate(s.body ?? '', vars, 'json')
    } else if (bodyType === 'form') {
      headers['content-type'] = 'application/x-www-form-urlencoded'
      body = fillTemplate(s.body ?? '', vars, 'url')
    } else if (bodyType === 'multipart') {
      // content-type 让 FormData 自己带 boundary，不能手写
      const form = new FormData()
      for (const [k, v] of Object.entries(parseFields(s.body) || {})) {
        form.append(k, typeof v === 'string' ? fillTemplate(v, vars) : typeof v === 'object' ? JSON.stringify(v) : String(v))
      }
      const field = s.imageField || 'image'
      inputs.forEach((im, i) => form.append(field, new Blob([im.buf], { type: im.mime }), `input-${i + 1}.${EXT[im.mime] || 'png'}`))
      if (req.mask) form.append(s.maskField || 'mask', new Blob([req.mask.buf], { type: req.mask.mime || 'image/png' }), 'mask.png')
      body = form
    }
    Object.assign(headers, headersFor(vars))
    if (bodyType === 'multipart') for (const k of Object.keys(headers)) if (k.toLowerCase() === 'content-type') delete headers[k]

    const r = await request(fetchImpl, url, { method, headers, ...(body !== undefined ? { body } : {}) }, { signal })
    if (!r.ok) throw classifyHttp(r.status, r.json || r.text)

    if ((res.kind || 'json') === 'image') {
      const mime = imageMime(r.buf)
      if (!mime) throw new ProviderError('unknown', '生图服务返回的不是图片', { maybeCharged: true })
      return { status: 'done', outputs: [{ buf: r.buf, mime }], billing: 'unknown' }
    }
    if (!r.json) throw new ProviderError('unknown', '生图服务没返回 JSON：' + r.text.slice(0, 160), { maybeCharged: true })
    if (async) {
      const id = pick(r.json, res.taskIdPath)
      if (id != null && id !== '') return { status: 'running', providerTaskId: String(id) }
      // 有的服务命中缓存会直接给图，没有任务号；配了 imagesPath 就按同步结果取
      if (!res.imagesPath) throw new ProviderError('unknown', `生图服务返回里没有任务号（${res.taskIdPath}）`, { maybeCharged: true })
    }
    return { status: 'done', outputs: await imagesFrom(r.json, res.imagesPath, signal), billing: 'unknown' }
  }

  async function poll(providerTaskId, { signal } = {}) {
    // 恢复任务可直接 poll，不能依赖此前 submit 做过校验。
    assertProfile()
    const vars = varsFor({}, { taskId: providerTaskId })
    const headers = headersFor(vars)
    let body
    if (st.bodyType === 'json') {
      body = fillTemplate(st.body, vars, 'json')
      if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json'
    }
    const r = await request(fetchImpl, fillTemplate(st.url, vars, 'url'), { method: methodOf(st.method, 'GET'), headers, ...(body !== undefined ? { body } : {}) }, { signal, timeoutMs: 60000 })
    if (!r.ok) throw classifyHttp(r.status, r.json || r.text)
    if (!r.json) throw new ProviderError('unknown', '查状态没返回 JSON：' + r.text.slice(0, 160), { maybeCharged: true })
    // 状态值统一按字符串比较，免得 2 和 "2"、true 和 "true" 对不上
    const state = String(pick(r.json, st.statePath) ?? '')
    const has = (list) => (Array.isArray(list) ? list : []).map(String).includes(state)
    if (has(st.doneValues)) {
      return { status: 'done', providerTaskId, outputs: await imagesFrom(r.json, st.imagesPath || res.imagesPath, signal), billing: 'unknown' }
    }
    if (has(st.failedValues)) {
      const msg = st.errorPath ? pick(r.json, st.errorPath) : ''
      const text = typeof msg === 'string' ? msg : msg == null ? '' : JSON.stringify(msg).slice(0, 200)
      return { status: 'failed', providerTaskId, error: new ProviderError('invalid', `生图失败：${text || `状态 ${state}`}`) }
    }
    return { status: 'running', providerTaskId }
  }

  async function cancel(providerTaskId, { signal } = {}) {
    const vars = varsFor({}, { taskId: providerTaskId })
    const r = await request(fetchImpl, fillTemplate(x.cancel.url, vars, 'url'), { method: methodOf(x.cancel.method), headers: headersFor(vars) }, { signal, timeoutMs: 30000 })
    if (r.ok) return { ok: true, message: '已取消' }
    return { ok: false, message: classifyHttp(r.status, r.json || r.text).message }
  }

  const adapter = { protocol: 'http', capabilities, submit }
  if (async && st) adapter.poll = poll
  if (x.cancel) adapter.cancel = cancel
  return adapter
}

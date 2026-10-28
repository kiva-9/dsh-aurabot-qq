// 生图服务适配层的公共约定。每个协议一个适配器：openai / gemini / comfyui / http。
//
// 适配器：create(profile, { fetchImpl, log }) → {
//   protocol,
//   capabilities()                       → 见 CAPABILITY_KEYS（管理员声明 + 适配器能力取交集）
//   submit(req, { signal })              → Result
//   poll(providerTaskId, { signal })     → Result            （只有 async 的适配器需要）
//   cancel(providerTaskId, { signal })   → { ok, message }    （服务支持才实现）
// }
//
// req（ImageRequest 在适配器这一层的形状）：
//   { mode: 'text' | 'reference' | 'edit' | 'mask', prompt, negativePrompt?, size: '1024x1024', n: 1,
//     inputs: [{ buf, mime, role: 'base' | 'identity' | 'style' | 'composition' }],
//     mask?: { buf, mime },            // 已规范化：PNG，和 base 同尺寸，完全透明（alpha = 0）的地方 = 要改的区域，见 MASK_NOTE
//     idempotencyKey }                 // 同一次尝试的幂等键，服务支持就带上
//
// Result：
//   { status: 'done', outputs: [{ buf, mime }], providerTaskId?, billing: 'charged' | 'unknown' | 'free' }
//   { status: 'running', providerTaskId, progress? }
//   { status: 'failed', error: ProviderError }
//
// 出错一律抛 ProviderError，kind 决定任务层怎么处理：
//   unsupported 服务不支持这个模式 / 字段（不重试，告诉用户）
//   invalid     请求本身有问题（提示词被拒、图太大……）（不重试）
//   auth        密钥不对 / 没权限（不重试）
//   quota       额度用完 / 限流（可以晚点重试）
//   transient   确定没执行的临时故障（可以重试）
//   unknown     请求可能已经被服务接收（超时、断线）：不能盲目重发，可能重复计费

export class ProviderError extends Error {
  constructor(kind, message, { retryable, maybeCharged, status } = {}) {
    super(message)
    this.kind = kind
    this.retryable = retryable ?? (kind === 'transient' || kind === 'quota')
    this.maybeCharged = maybeCharged ?? kind === 'unknown'
    if (status !== undefined) this.status = status
  }
}

export const MODES = ['text', 'reference', 'edit', 'mask']
export const ROLES = ['base', 'identity', 'style', 'composition']

/** 能力描述的字段。 */
export const CAPABILITY_KEYS = {
  modes: '支持的模式（text 文生图 / reference 参考图生成 / edit 原图编辑 / mask 蒙版编辑）',
  maxInputs: '最多几张输入图',
  async: '是不是提交后要轮询结果',
  cancel: '能不能取消',
  idempotent: '同一个幂等键重复提交会不会只执行一次',
  sizes: '支持的尺寸（空 = 不限制）',
}

/** 管理员声明的能力和适配器自己能做的取交集；声明里没写的按适配器默认。 */
export function mergeCapabilities(adapterCaps, declared = {}) {
  const modes = Array.isArray(declared.modes) && declared.modes.length ? adapterCaps.modes.filter((m) => declared.modes.includes(m)) : adapterCaps.modes
  const maxInputs = Number.isFinite(Number(declared.maxInputs)) ? Math.min(adapterCaps.maxInputs, Number(declared.maxInputs)) : adapterCaps.maxInputs
  return {
    modes,
    maxInputs: Math.max(0, maxInputs),
    async: Boolean(adapterCaps.async),
    cancel: Boolean(adapterCaps.cancel),
    idempotent: Boolean(adapterCaps.idempotent && declared.idempotent !== false),
    sizes: Array.isArray(declared.sizes) && declared.sizes.length ? declared.sizes : adapterCaps.sizes || [],
  }
}

/** 这个请求在这些能力下能不能做；不能做返回原因（不悄悄丢图、丢蒙版）。 */
export function checkRequest(req, caps) {
  if (!caps.modes.includes(req.mode)) return `这个生图服务不支持「${MODE_LABEL[req.mode] || req.mode}」`
  const n = (req.inputs || []).length
  if (req.mode === 'text' && n) return '文生图不需要输入图'
  if (req.mode !== 'text' && !n) return '这个模式需要至少一张输入图'
  if (n > caps.maxInputs) return `这个生图服务最多收 ${caps.maxInputs} 张输入图，这次有 ${n} 张`
  if ((req.mode === 'edit' || req.mode === 'mask') && !(req.inputs || []).some((i) => i.role === 'base')) return '编辑模式要指定哪张是底图'
  if (req.mode === 'mask' && !req.mask) return '蒙版编辑缺少蒙版'
  if (caps.sizes.length && req.size && !caps.sizes.includes(req.size)) return `这个生图服务不支持 ${req.size}，可以用：${caps.sizes.join('、')}`
  return ''
}

export const MODE_LABEL = { text: '文生图', reference: '参考图生成', edit: '原图编辑', mask: '蒙版编辑' }

/** 按 HTTP 状态和网络错误归类。请求已经发出去后的超时 / 断线一律当 unknown。 */
export function classifyHttp(status, body) {
  const msg = typeof body === 'string' ? body : body?.error?.message || body?.message || body?.error || JSON.stringify(body || '').slice(0, 200)
  if (status === 401 || status === 403) return new ProviderError('auth', `生图服务拒绝了（${status}）：${msg}`, { status })
  if (status === 429) return new ProviderError('quota', `生图服务限流 / 额度不够（429）：${msg}`, { status })
  if (status === 400 || status === 404 || status === 413 || status === 422) {
    const unsupported = /not support|unsupported|unknown parameter|unrecognized|invalid_request.*(image|mask)/i.test(String(msg))
    return new ProviderError(unsupported ? 'unsupported' : 'invalid', `生图服务不接受这个请求（${status}）：${msg}`, { status })
  }
  if (status >= 500) return new ProviderError('unknown', `生图服务出错（${status}）：${msg}`, { status, maybeCharged: true, retryable: false })
  return new ProviderError('unknown', `生图服务返回 ${status}：${msg}`, { status })
}

export function classifyNetwork(error, { sent = true } = {}) {
  const code = error?.cause?.code || error?.code
  if (!sent || ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) {
    return new ProviderError('transient', `连不上生图服务：${error.message}`, { retryable: true, maybeCharged: false })
  }
  return new ProviderError('unknown', `生图服务没回应（${error.name === 'TimeoutError' || error.name === 'AbortError' ? '超时' : error.message}），可能已经在画了`, { maybeCharged: true, retryable: false })
}

/** 带超时的请求，返回 { status, json, text, buf, type }。网络错误转成 ProviderError。 */
export async function request(fetchImpl, url, init = {}, { timeoutMs = 180000, signal } = {}) {
  const t = AbortSignal.timeout(timeoutMs)
  const sig = signal ? AbortSignal.any([signal, t]) : t
  let r
  try {
    r = await fetchImpl(url, { ...init, signal: sig })
  } catch (error) {
    throw classifyNetwork(error)
  }
  const type = r.headers.get('content-type') || ''
  const buf = Buffer.from(await r.arrayBuffer())
  let json = null
  if (/json/.test(type) || (buf[0] === 0x7b || buf[0] === 0x5b)) { try { json = JSON.parse(buf.toString('utf8')) } catch (error) {} }
  return { status: r.status, ok: r.ok, json, text: json ? '' : buf.toString('utf8', 0, Math.min(buf.length, 500)), buf, type }
}

/** 图片字节的类型；不是图片返回空串。 */
export function imageMime(buf) {
  if (!buf || buf.length < 12) return ''
  const tag = (a, b) => buf.toString('latin1', a, b)
  if (buf[0] === 0x89 && tag(1, 4) === 'PNG') return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (tag(0, 4) === 'RIFF' && tag(8, 12) === 'WEBP') return 'image/webp'
  if (tag(0, 3) === 'GIF') return 'image/gif'
  return ''
}

/** 结果里的图：base64 或 url（url 只从服务返回的结果里来，不接受用户给的本地路径）。 */
export async function outputFrom(item, { fetchImpl, signal, maxBytes = 30 * 1024 * 1024 } = {}) {
  let buf = null
  if (typeof item === 'string' && /^data:image\//.test(item)) buf = Buffer.from(item.split(',')[1] || '', 'base64')
  else if (item?.b64_json || item?.b64 || item?.base64) buf = Buffer.from(item.b64_json || item.b64 || item.base64, 'base64')
  else if (item?.url || typeof item === 'string') {
    const url = item?.url || item
    if (!/^https?:\/\//.test(url)) throw new ProviderError('invalid', '生图服务返回的图片地址不对')
    const r = await request(fetchImpl, url, { method: 'GET' }, { timeoutMs: 120000, signal })
    if (!r.ok) throw new ProviderError('unknown', `下载生成结果失败（${r.status}），图可能已经生成了`, { maybeCharged: true })
    buf = r.buf
  }
  if (!buf || !buf.length) throw new ProviderError('unknown', '生图服务没有返回图片', { maybeCharged: true })
  if (buf.length > maxBytes) throw new ProviderError('invalid', '生成的图太大了')
  const mime = imageMime(buf)
  if (!mime) throw new ProviderError('unknown', '生图服务返回的不是图片', { maybeCharged: true })
  return { buf, mime }
}

/** 蒙版约定说明（给面板和文档用）。 */
export const MASK_NOTE = '蒙版：和底图同尺寸的 PNG，完全透明的地方是要改的区域，不透明的地方保持原样（和 OpenAI 的约定一样）。别的服务的约定在适配器里转换。'

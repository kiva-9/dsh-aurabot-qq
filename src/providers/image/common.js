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
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) throw new ProviderError('invalid', '生图能力配置必须是对象')
  for (const key of ['modes', 'sizes']) {
    if (declared[key] !== undefined && (!Array.isArray(declared[key]) || declared[key].some((v) => typeof v !== 'string'))) throw new ProviderError('invalid', `生图能力 ${key} 必须是字符串数组`)
  }
  for (const key of ['async', 'cancel', 'idempotent']) {
    if (declared[key] !== undefined && typeof declared[key] !== 'boolean') throw new ProviderError('invalid', `生图能力 ${key} 必须是布尔值`)
  }
  const limit = declared.maxInputs === undefined ? adapterCaps.maxInputs : Number(declared.maxInputs)
  if (declared.maxInputs === null || declared.maxInputs === '' || typeof declared.maxInputs === 'boolean' || !Number.isSafeInteger(limit) || limit < 0) throw new ProviderError('invalid', '生图能力 maxInputs 必须是非负整数')
  let modes = adapterCaps.modes.filter((m) => declared.modes === undefined || declared.modes.includes(m))
  const ownSizes = adapterCaps.sizes || []
  const declaredSizes = declared.sizes || []
  const sizes = ownSizes.length && declaredSizes.length ? ownSizes.filter((s) => declaredSizes.includes(s)) : [...(ownSizes.length ? ownSizes : declaredSizes)]
  // sizes: [] 约定为不限制；两个有限集合无交集时必须禁用模式，不能意外变成任意尺寸。
  if (ownSizes.length && declaredSizes.length && !sizes.length) modes = []
  return {
    modes,
    maxInputs: Math.min(adapterCaps.maxInputs, limit),
    async: Boolean(adapterCaps.async && declared.async !== false),
    cancel: Boolean(adapterCaps.cancel && declared.cancel !== false),
    idempotent: Boolean(adapterCaps.idempotent && declared.idempotent !== false),
    sizes,
  }
}

/** 这个请求在这些能力下能不能做；不能做返回原因（不悄悄丢图、丢蒙版）。 */
export function checkRequest(req, caps) {
  if (!req || !MODES.includes(req.mode)) return '不支持的生图模式'
  if (!caps.modes.includes(req.mode)) return `这个生图服务不支持「${MODE_LABEL[req.mode] || req.mode}」`
  if (req.inputs !== undefined && !Array.isArray(req.inputs)) return '输入图必须是数组'
  const n = (req.inputs || []).length
  if (req.mode === 'text' && n) return '文生图不需要输入图'
  if (req.mode !== 'text' && !n) return '这个模式需要至少一张输入图'
  if (n > caps.maxInputs) return `这个生图服务最多收 ${caps.maxInputs} 张输入图，这次有 ${n} 张`
  const inputs = req.inputs || []
  if (inputs.some((i) => !i || !ROLES.includes(i.role))) return '输入图的角色必须是 base、identity、style 或 composition'
  const bases = inputs.filter((i) => i.role === 'base')
  if (bases.length > 1) return '只能指定一张底图（base）'
  if ((req.mode === 'edit' || req.mode === 'mask') && bases.length !== 1) return '编辑模式要指定唯一一张底图（base）'
  if (req.mode === 'mask' && !req.mask) return '蒙版编辑缺少蒙版'
  if (req.mode !== 'mask' && req.mask) return '只有蒙版编辑模式可以带蒙版'
  if (req.mask && (typeof req.mask !== 'object' || Array.isArray(req.mask))) return '蒙版必须是图片对象'
  if (caps.sizes?.length && req.size && !caps.sizes.includes(req.size)) return `这个生图服务不支持 ${req.size}，可以用：${caps.sizes.join('、')}`
  // 面板挑服务时只有资产引用；加载字节后再次检查，绝不信任调用方提供的 MIME / 尺寸。
  try {
    for (const im of inputs) {
      if (im.buf === undefined) continue
      const info = imageInfo(im.buf)
      if (im.mime && im.mime !== info.mime) return '输入图的 MIME 与图片字节不符'
    }
    if (req.mask) {
      if (req.mask.mime && req.mask.mime !== 'image/png') return '蒙版必须是 PNG 图片'
      if (req.mask.buf !== undefined) {
        const mask = imageInfo(req.mask.buf)
        if (mask.mime !== 'image/png') return '蒙版必须是 PNG 图片'
        if (!mask.hasAlpha) return '蒙版 PNG 必须有透明通道'
        if (bases[0]?.buf !== undefined) {
          const base = imageInfo(bases[0].buf)
          if (mask.width !== base.width || mask.height !== base.height) return '蒙版和底图的尺寸必须一致'
        }
      }
    }
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error
    return error.message
  }
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

export function classifyNetwork(error, { sent = true, responseStarted = false } = {}) {
  const code = error?.cause?.code || error?.code
  if (!sent || (!responseStarted && ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code))) {
    return new ProviderError('transient', `连不上生图服务：${error?.message || '请求未发出'}`, { retryable: true, maybeCharged: false })
  }
  return new ProviderError('unknown', `生图服务没回应（${error?.name === 'TimeoutError' || error?.name === 'AbortError' ? '超时或中断' : error?.message || '连接中断'}），可能已经在画了`, { maybeCharged: true, retryable: false })
}

export const MAX_IMAGE_BYTES = 30 * 1024 * 1024
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024 // 容纳 base64 JSON；按实际解码后的响应体字节计数

// WHATWG Fetch port blocking: https://fetch.spec.whatwg.org/#port-blocking
const BLOCKED_PORTS = new Set([0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080])

/** 在任何网络操作前验证地址；本机 HTTP mock / 自建服务是合法地址。 */
export function validateHttpUrl(value) {
  let url
  try {
    if (typeof value !== 'string' && !(value instanceof URL)) throw new Error('URL 类型错误')
    url = new URL(value)
  } catch { throw new ProviderError('invalid', '生图服务地址必须是完整的 http(s) URL') }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new ProviderError('invalid', '生图服务地址必须使用 http(s)')
  if (url.username || url.password) throw new ProviderError('invalid', '生图服务地址不能内嵌用户名或密码')
  if (url.port !== '' && BLOCKED_PORTS.has(Number(url.port))) throw new ProviderError('invalid', `生图服务地址使用了 Fetch 禁止的端口 ${url.port}`)
  return url
}

function byteLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new ProviderError('invalid', '响应大小上限 maxBytes 必须是正整数')
}

/** 带超时、有界流式读取；响应头到达后，读断/超限都不能证明生成没有执行。 */
export async function request(fetchImpl, url, init = {}, { timeoutMs = 180000, signal, maxBytes = MAX_RESPONSE_BYTES } = {}) {
  const target = validateHttpUrl(url)
  byteLimit(maxBytes)
  let sig
  try {
    if (typeof fetchImpl !== 'function') throw new Error('fetchImpl 必须是函数')
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new Error('timeoutMs 必须是有效的正整数毫秒数')
    if (!init || typeof init !== 'object') throw new Error('请求配置必须是对象')
    sig = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...[signal, init.signal].filter((s) => s != null)])
    // Request 只做本地配置校验，保留原始 FormData 给 fetch 自动生成 boundary。
    new Request(target, { ...init, signal: sig })
  } catch (error) { throw new ProviderError('invalid', `生图请求配置不合法：${error.message}`) }
  if (sig.aborted) throw classifyNetwork(sig.reason, { sent: false })

  let r, reader, onAbort
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(sig.reason)
    sig.addEventListener('abort', onAbort, { once: true })
  })
  try {
    r = await Promise.race([fetchImpl(target.href, { ...init, signal: sig }), aborted])
    const tooLarge = () => new ProviderError('unknown', `生图服务响应超过 ${maxBytes} 字节上限，结果可能已经生成`, { status: r.status })
    const type = r.headers.get('content-type') || ''
    const length = r.headers.get('content-length')
    // 压缩后的 Content-Length 不是解压后长度；无论有没有声明都逐块计数。
    if (!r.headers.get('content-encoding') && length !== null && /^\d+$/.test(length) && Number(length) > maxBytes) {
      if (r.body) void r.body.cancel().catch(() => {})
      throw tooLarge()
    }
    const chunks = []
    let size = 0
    if (r.body) {
      reader = r.body.getReader()
      while (true) {
        const { done, value } = await Promise.race([reader.read(), aborted])
        if (done) break
        if (size + value.byteLength > maxBytes) throw tooLarge()
        size += value.byteLength
        chunks.push(Buffer.from(value))
      }
    }
    const buf = Buffer.concat(chunks, size)
    let json = null
    if (/json/i.test(type) || buf[0] === 0x7b || buf[0] === 0x5b) { try { json = JSON.parse(buf.toString('utf8')) } catch {} }
    return { status: r.status, ok: r.ok, json, text: json ? '' : buf.toString('utf8', 0, Math.min(buf.length, 500)), buf, type }
  } catch (error) {
    if (reader) void reader.cancel().catch(() => {})
    if (error instanceof ProviderError) throw error
    // 收到响应之后，即使底层错误的 code 看似 DNS/拒绝连接，也不能再当作未发出。
    throw classifyNetwork(error, { responseStarted: Boolean(r) })
  } finally {
    sig.removeEventListener('abort', onAbort)
    reader?.releaseLock()
  }
}

function imageAssert(ok) {
  if (!ok) throw new ProviderError('invalid', '图片格式无效、损坏或被截断')
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1
  return n >>> 0
})
function crc32(buf) {
  let crc = 0xffffffff
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

// https://www.w3.org/TR/png/：完整 chunk 边界、CRC、IHDR、调色板及 IEND。
function pngInfo(buf) {
  let info, color, depth, palette = 0, data = 0, dataEnded = false, transparency = false
  for (let p = 8; p < buf.length;) {
    imageAssert(p + 12 <= buf.length)
    const n = buf.readUInt32BE(p), end = p + 12 + n, type = buf.toString('latin1', p + 4, p + 8)
    imageAssert(n <= 0x7fffffff && end <= buf.length && /^[A-Za-z]{4}$/.test(type))
    imageAssert(crc32(buf.subarray(p + 4, end - 4)) === buf.readUInt32BE(end - 4))
    const d = p + 8
    if (!info) {
      imageAssert(type === 'IHDR' && n === 13)
      const width = buf.readUInt32BE(d), height = buf.readUInt32BE(d + 4)
      depth = buf[d + 8]; color = buf[d + 9]
      imageAssert(width > 0 && height > 0 && width <= 0x7fffffff && height <= 0x7fffffff)
      imageAssert(({ 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] })[color]?.includes(depth))
      imageAssert(buf[d + 10] === 0 && buf[d + 11] === 0 && buf[d + 12] <= 1)
      info = { mime: 'image/png', width, height, hasAlpha: color === 4 || color === 6 }
    } else if (type === 'IHDR') imageAssert(false)
    else if (type === 'PLTE') {
      imageAssert(!palette && !data && !transparency && color !== 0 && color !== 4 && n > 0 && n % 3 === 0 && n <= 768)
      palette = n / 3
      if (color === 3) imageAssert(palette <= 2 ** depth)
    } else if (type === 'tRNS') {
      imageAssert(!data && !transparency && ((color === 0 && n === 2) || (color === 2 && n === 6) || (color === 3 && palette && n > 0 && n <= palette)))
      transparency = true
      info.hasAlpha = true
    } else if (type === 'IDAT') {
      imageAssert(!dataEnded && (color !== 3 || palette > 0))
      data += n
    } else if (type === 'IEND') {
      imageAssert(n === 0 && data > 0 && end === buf.length)
      return info
    } else {
      // 不认识的关键 chunk 不能可靠解释；附属 chunk（包括 APNG）可以跳过。
      imageAssert((buf[p + 4] & 32) !== 0)
    }
    if (data && type !== 'IDAT') dataEnded = true
    p = end
  }
  imageAssert(false)
}

function jpegInfo(buf) {
  let p = 2, info, scanned = false
  while (p < buf.length) {
    imageAssert(buf[p++] === 0xff)
    while (buf[p] === 0xff) p++
    const marker = buf[p++]
    // JPEG 的 EOI 之后可带编辑器附加元数据；完整图像已结束，不把附加字节误判为截断。
    if (marker === 0xd9) { imageAssert(info && scanned); return info }
    imageAssert(marker !== 0 && marker !== 0xd8 && !(marker >= 0xd0 && marker <= 0xd7) && p + 2 <= buf.length)
    const n = buf.readUInt16BE(p), end = p + n
    imageAssert(n >= 2 && end <= buf.length)
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      imageAssert(!info && n >= 8 && buf[p + 7] > 0 && n === 8 + 3 * buf[p + 7])
      const height = buf.readUInt16BE(p + 3), width = buf.readUInt16BE(p + 5)
      imageAssert(width > 0 && height > 0)
      info = { mime: 'image/jpeg', width, height, hasAlpha: false }
    }
    p = end
    if (marker === 0xda) {
      imageAssert(info && n >= 8 && n === 6 + 2 * buf[end - n + 2])
      const start = p
      while (p < buf.length) {
        if (buf[p] !== 0xff) { p++; continue }
        if (buf[p + 1] === 0 || (buf[p + 1] >= 0xd0 && buf[p + 1] <= 0xd7)) { p += 2; continue }
        break
      }
      imageAssert(p > start)
      scanned = true
    }
  }
  imageAssert(false)
}

function gifInfo(buf) {
  imageAssert(buf.length >= 14)
  const width = buf.readUInt16LE(6), height = buf.readUInt16LE(8)
  imageAssert(width > 0 && height > 0)
  let p = 13 + (buf[10] & 128 ? 3 * 2 ** ((buf[10] & 7) + 1) : 0), frames = 0, hasAlpha = false
  const blocks = () => {
    let total = 0
    while (true) {
      imageAssert(p < buf.length)
      const n = buf[p++]
      if (!n) return total
      imageAssert(p + n <= buf.length)
      p += n; total += n
    }
  }
  while (p < buf.length) {
    const type = buf[p++]
    if (type === 0x3b) { imageAssert(frames && p === buf.length); return { mime: 'image/gif', width, height, hasAlpha } }
    if (type === 0x21) {
      imageAssert(p < buf.length)
      const label = buf[p++]
      if (label === 0xf9) {
        imageAssert(p + 6 <= buf.length && buf[p] === 4 && buf[p + 5] === 0)
        hasAlpha ||= Boolean(buf[p + 1] & 1)
      }
      blocks()
    } else {
      imageAssert(type === 0x2c && p + 9 <= buf.length)
      const left = buf.readUInt16LE(p), top = buf.readUInt16LE(p + 2), w = buf.readUInt16LE(p + 4), h = buf.readUInt16LE(p + 6), flags = buf[p + 8]
      imageAssert(w > 0 && h > 0 && left + w <= width && top + h <= height)
      p += 9 + (flags & 128 ? 3 * 2 ** ((flags & 7) + 1) : 0)
      imageAssert(p < buf.length && buf[p] >= 2 && buf[p] <= 8)
      p++
      imageAssert(blocks() > 0)
      frames++
    }
  }
  imageAssert(false)
}

// https://developers.google.com/speed/webp/docs/riff_container
function webpInfo(buf) {
  imageAssert(buf.readUInt32LE(4) + 8 === buf.length)
  let info, frames = 0, animated = false, animationHeader = false, alpha = false
  const frame = (type, d, n) => {
    if (type === 'VP8 ') {
      imageAssert(n > 10 && !(buf[d] & 1) && (buf[d] & 16) && buf.toString('hex', d + 3, d + 6) === '9d012a')
      return { width: buf.readUInt16LE(d + 6) & 0x3fff, height: buf.readUInt16LE(d + 8) & 0x3fff, hasAlpha: alpha }
    }
    imageAssert(type === 'VP8L' && n > 5 && buf[d] === 0x2f)
    const bits = buf.readUInt32LE(d + 1)
    imageAssert((bits >>> 29) === 0)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, hasAlpha: Boolean(bits & 0x10000000) }
  }
  for (let p = 12; p < buf.length;) {
    imageAssert(p + 8 <= buf.length)
    const type = buf.toString('latin1', p, p + 4), n = buf.readUInt32LE(p + 4), d = p + 8, end = d + n + (n & 1)
    imageAssert(end <= buf.length)
    if (type === 'VP8X') {
      imageAssert(p === 12 && n === 10 && !(buf[d] & 0xc1) && buf.readUIntLE(d + 1, 3) === 0)
      info = { width: buf.readUIntLE(d + 4, 3) + 1, height: buf.readUIntLE(d + 7, 3) + 1, hasAlpha: Boolean(buf[d] & 16) }
      animated = Boolean(buf[d] & 2)
    } else if (type === 'VP8 ' || type === 'VP8L') {
      imageAssert(!animated && !frames)
      const f = frame(type, d, n)
      imageAssert(!info || (info.width === f.width && info.height === f.height))
      info ||= f
      frames++
    } else if (type === 'ALPH') {
      imageAssert(info && !animated && !frames && n > 1)
      alpha = true
    } else if (type === 'ANIM') {
      imageAssert(animated && n === 6 && !animationHeader && !frames)
      animationHeader = true
    } else if (type === 'ANMF') {
      imageAssert(animated && animationHeader && n >= 24)
      const w = buf.readUIntLE(d + 6, 3) + 1, h = buf.readUIntLE(d + 9, 3) + 1
      imageAssert(buf.readUIntLE(d, 3) * 2 + w <= info.width && buf.readUIntLE(d + 3, 3) * 2 + h <= info.height)
      let found = false
      for (let q = d + 16; q < d + n;) {
        imageAssert(q + 8 <= d + n)
        const kind = buf.toString('latin1', q, q + 4), size = buf.readUInt32LE(q + 4), next = q + 8 + size + (size & 1)
        imageAssert(next <= d + n)
        if (kind === 'VP8 ' || kind === 'VP8L') {
          const f = frame(kind, q + 8, size)
          imageAssert(!found && f.width === w && f.height === h)
          found = true
        }
        q = next
      }
      imageAssert(found)
      frames++
    }
    p = end
  }
  imageAssert(info && frames && info.width && info.height)
  return { mime: 'image/webp', ...info }
}

/**
 * 同步读取可信的容器元数据：{ mime, width, height, hasAlpha }；坏图/截断抛 invalid。
 * 校验 PNG CRC、各格式尺寸/数据段/结束标记；这是容器校验，不替代完整像素解码器。
 * 不按尺寸分配像素内存，上传方可据此实施自己的字节和像素上限。
 */
export function imageInfo(bytes) {
  imageAssert(bytes instanceof Uint8Array && bytes.byteLength >= 12)
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  try {
    if (buf.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return pngInfo(buf)
    if (buf[0] === 0xff && buf[1] === 0xd8) return jpegInfo(buf)
    if (/^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return gifInfo(buf)
    if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return webpInfo(buf)
  } catch (error) {
    if (error instanceof ProviderError) throw error
    if (!(error instanceof RangeError)) throw error
  }
  imageAssert(false)
}

/** 兼容旧调用点：失败返回空串；同样要求结构完整，不能只伪造文件头。 */
export function imageMime(buf) {
  try { return imageInfo(buf).mime } catch (error) {
    if (!(error instanceof ProviderError)) throw error
    return ''
  }
}

/** 结果里的图：base64 或 url（url 只从服务返回的结果里来，不接受用户给的本地路径）。 */
export async function outputFrom(item, { fetchImpl = fetch, signal, maxBytes = MAX_IMAGE_BYTES } = {}) {
  byteLimit(maxBytes)
  let buf = null
  try {
    let encoded
    if (typeof item === 'string' && item.startsWith('data:')) {
      const comma = item.indexOf(',')
      if (comma < 0 || !/^data:image\/[\w.+-]+;base64$/i.test(item.slice(0, comma))) throw new ProviderError('invalid', '图片 data URL 格式不对')
      encoded = item.slice(comma + 1)
    } else if (item?.b64_json !== undefined || item?.b64 !== undefined || item?.base64 !== undefined) encoded = item.b64_json ?? item.b64 ?? item.base64
    if (encoded !== undefined) {
      // 在 Buffer 分配前限制编码长度；Buffer.from 本身会静默忽略非法 base64 字符。
      if (typeof encoded !== 'string' || encoded.length > 4 * Math.ceil(maxBytes / 3)) throw new ProviderError('invalid', '生成的图太大或 base64 格式不对')
      if (encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || (encoded.includes('=') && encoded.length % 4 !== 0)) throw new ProviderError('invalid', '图片 base64 格式不对')
      buf = Buffer.from(encoded, 'base64')
    } else if (item?.url || typeof item === 'string') {
      const r = await request(fetchImpl, item?.url || item, { method: 'GET' }, { timeoutMs: 120000, signal, maxBytes })
      if (!r.ok) throw new ProviderError('unknown', `下载生成结果失败（${r.status}）`, { status: r.status })
      buf = r.buf
    }
    if (!buf?.length) throw new ProviderError('invalid', '生图服务没有返回图片')
    if (buf.length > maxBytes) throw new ProviderError('invalid', '生成的图太大了')
    const { mime } = imageInfo(buf)
    return { buf, mime }
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error
    // URL/图片坏了也只说明结果拿不到，不能据此认定上游没执行、没计费。
    throw new ProviderError('unknown', `生图服务返回的图片无法使用：${error.message}`, { status: error.status, maybeCharged: true, retryable: false })
  }
}

/** 蒙版约定说明（给面板和文档用）。 */
export const MASK_NOTE = '蒙版：和底图同尺寸的 PNG，完全透明的地方是要改的区域，不透明的地方保持原样（和 OpenAI 的约定一样）。别的服务的约定在适配器里转换。'

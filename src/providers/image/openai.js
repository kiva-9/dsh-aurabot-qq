// OpenAI Images 及兼容服务：POST {baseUrl}/images/generations（文生图），POST {baseUrl}/images/edits（multipart：参考图 / 原图编辑 / 蒙版）。
// 中转站支持的字段各不相同：response_format、多图 image[] 这些按 profile 里声明的能力决定发不发，不无条件带上。

import { ProviderError, request, classifyHttp, outputFrom, checkRequest, mergeCapabilities, imageInfo, validateHttpUrl } from './common.js'

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

/**
 * profile: { baseUrl, apiKey, model, extra: { responseFormat?: 'b64_json'|'url'|'', imageField?: 'image[]'|'image', quality?, style? } }
 */
export function createOpenAIImages(profile, { fetchImpl = fetch } = {}) {
  const base = String(profile.baseUrl || '').replace(/\/+$/, '')
  const x = profile.extra || {}
  const auth = profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}

  function capabilities() {
    return mergeCapabilities({ modes: ['text', 'reference', 'edit', 'mask'], maxInputs: x.imageField === 'image' ? 1 : 16, async: false, cancel: false, idempotent: false, sizes: [] }, { modes: x.modes, maxInputs: x.maxInputs, sizes: x.sizes })
  }

  async function finish(r, signal) {
    if (!r.ok) throw classifyHttp(r.status, r.json || r.text)
    const items = r.json?.data || r.json?.images || []
    if (!Array.isArray(items) || !items.length) throw new ProviderError('unknown', '生图服务返回里没有图片数组', { maybeCharged: true })
    const outputs = []
    for (const it of items) outputs.push(await outputFrom(it, { fetchImpl, signal }))
    return { status: 'done', outputs, billing: 'charged' }
  }

  async function submit(req, { signal } = {}) {
    if (!base || typeof profile.model !== 'string' || !profile.model.trim()) throw new ProviderError('invalid', '这个生图服务还没填地址或模型')
    const url = validateHttpUrl(base)
    if (url.search || url.hash) throw new ProviderError('invalid', '生图服务 baseUrl 不能包含查询参数或片段')
    if (x.imageField && !['image', 'image[]'].includes(x.imageField)) throw new ProviderError('invalid', 'imageField 必须是 image 或 image[]')
    if (x.responseFormat && !['b64_json', 'url'].includes(x.responseFormat)) throw new ProviderError('invalid', 'responseFormat 必须是 b64_json 或 url')
    const caps = mergeCapabilities(capabilities(), profile.capabilities)
    if (!caps.modes.includes(req?.mode)) throw new ProviderError('unsupported', `这个生图服务不支持「${req?.mode}」模式`)
    const why = checkRequest(req, caps)
    if (why) throw new ProviderError(/不支持|最多收/.test(why) ? 'unsupported' : 'invalid', why)
    if (typeof req.prompt !== 'string' || !req.prompt.trim()) throw new ProviderError('invalid', '提示词不能为空')
    if (req.n !== undefined && (!Number.isInteger(req.n) || req.n < 1 || req.n > 10)) throw new ProviderError('invalid', '出图数量 n 必须是 1 到 10 的整数')
    if (req.negativePrompt) throw new ProviderError('unsupported', 'OpenAI Images 协议不支持独立的反向提示词')
    if (req.size !== undefined && req.size !== '' && (typeof req.size !== 'string' || !/^(auto|[1-9]\d*x[1-9]\d*)$/.test(req.size))) throw new ProviderError('invalid', '图片尺寸必须是 WIDTHxHEIGHT 或 auto')
    // 白名单映射：size 才是 Images API 字段，req / extra 里的 image_size 不透传。
    const common = { model: profile.model, prompt: req.prompt, n: req.n ?? 1, ...(req.size ? { size: req.size } : {}) }
    if (x.responseFormat) common.response_format = x.responseFormat
    if (x.quality) common.quality = x.quality
    if (req.mode === 'text') {
      const r = await request(fetchImpl, `${base}/images/generations`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(common),
      }, { signal })
      return finish(r, signal)
    }
    // 参考图 / 编辑：multipart。底图放第一张（编辑以它为准），其余按角色排在后面
    const inputs = [...req.inputs].sort((a, b) => (a.role === 'base' ? -1 : b.role === 'base' ? 1 : 0))
    const form = new FormData()
    for (const [k, v] of Object.entries(common)) form.append(k, String(v))
    const field = x.imageField || (inputs.length > 1 ? 'image[]' : 'image')
    inputs.forEach((im, i) => {
      const { mime } = imageInfo(im.buf)
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new ProviderError('unsupported', 'OpenAI 编辑输入只支持 PNG、JPEG 或 WebP')
      if (im.buf.length >= 50 * 1024 * 1024) throw new ProviderError('invalid', 'OpenAI 编辑输入必须小于 50 MiB')
      form.append(field, new Blob([im.buf], { type: mime }), `input-${i + 1}.${EXT[mime]}`)
    })
    if (req.mode === 'mask') {
      imageInfo(req.mask.buf)
      if (req.mask.buf.length >= 4 * 1024 * 1024) throw new ProviderError('invalid', 'OpenAI 蒙版必须小于 4 MiB')
    }
    if (req.mode === 'mask') form.append('mask', new Blob([req.mask.buf], { type: 'image/png' }), 'mask.png')
    const r = await request(fetchImpl, `${base}/images/edits`, { method: 'POST', headers: { ...auth }, body: form }, { signal })
    return finish(r, signal)
  }

  return { protocol: 'openai', capabilities, submit }
}

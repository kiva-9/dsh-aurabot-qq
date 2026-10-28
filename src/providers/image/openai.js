// OpenAI Images 及兼容服务：POST {baseUrl}/images/generations（文生图），POST {baseUrl}/images/edits（multipart：参考图 / 原图编辑 / 蒙版）。
// 中转站支持的字段各不相同：response_format、多图 image[] 这些按 profile 里声明的能力决定发不发，不无条件带上。

import { ProviderError, request, classifyHttp, outputFrom } from './common.js'

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

/**
 * profile: { baseUrl, apiKey, model, extra: { responseFormat?: 'b64_json'|'url'|'', imageField?: 'image[]'|'image', quality?, style? } }
 */
export function createOpenAIImages(profile, { fetchImpl = fetch } = {}) {
  const base = String(profile.baseUrl || '').replace(/\/+$/, '')
  const x = profile.extra || {}
  const auth = profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}

  function capabilities() {
    return { modes: ['text', 'reference', 'edit', 'mask'], maxInputs: 16, async: false, cancel: false, idempotent: false, sizes: [] }
  }

  async function finish(r, signal) {
    if (!r.ok) throw classifyHttp(r.status, r.json || r.text)
    const items = r.json?.data || r.json?.images || []
    if (!items.length) throw new ProviderError('unknown', '生图服务返回里没有图片', { maybeCharged: true })
    const outputs = []
    for (const it of items) outputs.push(await outputFrom(it, { fetchImpl, signal }))
    return { status: 'done', outputs, billing: 'charged' }
  }

  async function submit(req, { signal } = {}) {
    if (!base || !profile.model) throw new ProviderError('invalid', '这个生图服务还没填地址或模型')
    const common = { model: profile.model, prompt: req.prompt, n: req.n || 1, ...(req.size ? { size: req.size } : {}) }
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
    inputs.forEach((im, i) => form.append(field, new Blob([im.buf], { type: im.mime }), `input-${i + 1}.${EXT[im.mime] || 'png'}`))
    if (req.mode === 'mask') form.append('mask', new Blob([req.mask.buf], { type: 'image/png' }), 'mask.png')
    const r = await request(fetchImpl, `${base}/images/edits`, { method: 'POST', headers: { ...auth }, body: form }, { signal })
    return finish(r, signal)
  }

  return { protocol: 'openai', capabilities, submit }
}

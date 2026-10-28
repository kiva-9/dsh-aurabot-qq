// Google Gemini 原生多模态生图：POST {baseUrl}/models/{model}:generateContent，图和文字放在同一条 user 消息的 parts 里。
// Gemini 没有蒙版编辑，也没有「哪张图是干什么的」字段：角色只能写进文字说明里，按图的顺序告诉模型。

import { ProviderError, request, classifyHttp, outputFrom } from './common.js'

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']
const ROLE_TEXT = {
  base: '底图（在它上面改）',
  identity: '人物身份参考（保持长相）',
  style: '风格参考',
  composition: '构图参考',
}
// 这些结束原因说明是内容审核拦下的，不是服务出错
const BLOCKED = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_RECITATION'])

/** 'WxH' → 最接近的受支持宽高比；解析不了返回空串。按比例的对数距离比，横竖对称。 */
export function aspectRatioFor(size) {
  const m = /^\s*(\d+)\s*[x×*]\s*(\d+)\s*$/i.exec(String(size || ''))
  if (!m) return ''
  const w = Number(m[1]), h = Number(m[2])
  if (!w || !h) return ''
  const target = Math.log(w / h)
  let best = '', dist = Infinity
  for (const r of RATIOS) {
    const [a, b] = r.split(':').map(Number)
    const d = Math.abs(Math.log(a / b) - target)
    if (d < dist) { best = r; dist = d }
  }
  return best
}

/** 文字说明：先按顺序说清每张图的角色，再接用户的提示词。 */
function instruction(req, inputs) {
  const lines = inputs.map((im, i) => `图${i + 1} 是${ROLE_TEXT[im.role] || '参考图'}`)
  if (req.mode === 'edit') lines.push('请以底图为准，保留它原有的内容、构图和画面，只修改下面要求改的地方。')
  if (req.negativePrompt) lines.push(`不要出现：${req.negativePrompt}`)
  return [...lines, req.prompt || ''].filter(Boolean).join('\n')
}

/** 400 里的「密钥无效」其实是鉴权问题（Gemini 对坏密钥回 400，不是 401）。 */
function classify(r) {
  const body = r.json || r.text
  const err = r.json?.error
  const keyBad = err && (/API key not valid/i.test(err.message || '') || (err.details || []).some((d) => d?.reason === 'API_KEY_INVALID'))
  if (r.status === 400 && keyBad) return new ProviderError('auth', `生图服务拒绝了（400）：${err.message}`, { status: 400 })
  return classifyHttp(r.status, body)
}

/**
 * profile: { baseUrl?, apiKey, model, extra: { aspectRatio?, responseModalities?, maxInputs? } }
 */
export function createGeminiImages(profile, { fetchImpl = fetch } = {}) {
  const base = String(profile.baseUrl || DEFAULT_BASE).replace(/\/+$/, '')
  const x = profile.extra || {}
  const auth = profile.apiKey ? { 'x-goog-api-key': profile.apiKey } : {}

  function capabilities() {
    const n = Number(x.maxInputs)
    // 官方说最多 14 张参考图，但图多了效果和稳定性都差，默认只收 3 张
    const maxInputs = Number.isFinite(n) && n > 0 ? Math.min(14, Math.floor(n)) : 3
    return { modes: ['text', 'reference', 'edit'], maxInputs, async: false, cancel: false, idempotent: false, sizes: [] }
  }

  async function submit(req, { signal } = {}) {
    if (!profile.model) throw new ProviderError('invalid', '这个生图服务还没填模型')
    // 正常会被 checkRequest 挡住；这里兜底，免得悄悄丢掉蒙版当普通编辑做
    if (req.mode === 'mask') throw new ProviderError('unsupported', 'Gemini 不支持蒙版编辑')
    // 文生图一律不带图；其余底图放第一张，其他按原顺序
    const inputs = req.mode === 'text' ? [] : [...(req.inputs || [])].sort((a, b) => (a.role === 'base' ? -1 : b.role === 'base' ? 1 : 0))
    const parts = inputs.map((im) => ({ inlineData: { mimeType: im.mime, data: Buffer.from(im.buf).toString('base64') } }))
    parts.push({ text: instruction(req, inputs) })
    const generationConfig = { responseModalities: Array.isArray(x.responseModalities) && x.responseModalities.length ? x.responseModalities : ['TEXT', 'IMAGE'] }
    const aspectRatio = aspectRatioFor(req.size) || x.aspectRatio
    if (aspectRatio) generationConfig.imageConfig = { aspectRatio }
    const body = { contents: [{ role: 'user', parts }], generationConfig }
    const r = await request(fetchImpl, `${base}/models/${encodeURIComponent(profile.model)}:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(body),
    }, { signal })
    if (!r.ok) throw classify(r)
    return finish(r.json || {}, signal)
  }

  async function finish(json, signal) {
    const cand = json.candidates?.[0]
    const got = cand?.content?.parts || []
    const outputs = []
    for (const p of got) {
      const d = p.inlineData || p.inline_data
      if (d?.data) outputs.push(await outputFrom({ b64: d.data }, { fetchImpl, signal }))
    }
    if (outputs.length) return { status: 'done', outputs, billing: 'charged' }
    const block = json.promptFeedback?.blockReason
    const reason = cand?.finishReason
    if (block || BLOCKED.has(reason)) {
      throw new ProviderError('invalid', `Gemini 的内容审核拦下了这次生成（${block || reason}），换个说法或换张图试试`)
    }
    const text = got.map((p) => p.text || '').join('').trim()
    throw new ProviderError('unknown', text ? `Gemini 只回了文字没给图：${text.slice(0, 200)}` : `Gemini 没有返回图片${reason ? `（${reason}）` : ''}`, { maybeCharged: true })
  }

  return { protocol: 'gemini', capabilities, submit }
}

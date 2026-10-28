// 展示步骤只切原文，不总结内容。条数是软上限：媒体/语音/明确引用不能为凑条数改序或丢弃。
export const SILENCE = '[沉默]'
export const REPLY_SCHEMA = 'aurabot.reply'
export const REPLY_VERSION = 1
export const REPLY_PLAN_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['schema', 'version', 'blocks'],
  properties: {
    schema: { const: REPLY_SCHEMA }, version: { const: REPLY_VERSION },
    blocks: { type: 'array', maxItems: 256, items: { oneOf: [
      { type: 'object', additionalProperties: false, required: ['type', 'ref'], properties: {
        type: { const: 'text' }, ref: { type: 'string', pattern: '^b[0-9]+$' }, text: { type: 'string' },
        cuts: { type: 'array', maxItems: 64, uniqueItems: true, items: { type: 'integer', minimum: 1 } },
      } },
      { type: 'object', additionalProperties: false, required: ['type', 'ref'], properties: {
        type: { enum: ['imageAsset', 'voiceRequest', 'stickerAsset', 'quote', 'poke', 'break'] },
        ref: { type: 'string', pattern: '^b[0-9]+$' },
      } },
    ] } },
  },
})
const MAX_BUBBLES = 5
const MAX_CUTS = 64
const layout = Symbol('reply source ranges')
const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' })
const stringOf = value => value == null ? '' : String(value)

// Markdown 的目标可含成对括号。解析失败时整段按文字保留，不猜本地文件路径。
function markdownLink(text, start) {
  const image = text.startsWith('![', start)
  let at = start + (image ? 2 : 1), depth = 1
  if (!image && text[start] !== '[') return null
  const labelStart = at
  for (; at < text.length && depth; at++) {
    if (text[at] === '\\') { at++; continue }
    if (text[at] === '[') depth++
    if (text[at] === ']') depth--
  }
  if (depth || text[at] !== '(') return null
  const label = text.slice(labelStart, at - 1), targetStart = ++at
  depth = 1
  for (; at < text.length && depth; at++) {
    if (text[at] === '\\') { at++; continue }
    if (text[at] === '(') depth++
    if (text[at] === ')') depth--
  }
  if (depth) return null
  let target = text.slice(targetStart, at - 1).trim()
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1)
  let url = null
  if (/^https?:\/\/[^\s<>\\]+$/i.test(target)) {
    try { const parsed = new URL(target); if (parsed.hostname) url = target } catch {}
  }
  return { start, end: at, image, label, url }
}

/** 不在代码、URL、公式、引用或数字内部切分；这些区域也不做 Markdown 清洗。 */
export function protectedReplyRanges(value) {
  const text = stringOf(value), found = []
  const add = (start, end, kind) => { if (end > start) found.push({ start, end, kind }) }
  const inside = at => found.some(r => r.start <= at && at < r.end)
  const fence = /(`{3,}|~{3,})/g
  let m
  while ((m = fence.exec(text))) {
    if (inside(m.index)) continue
    const close = new RegExp(m[1][0] + '{' + m[1].length + ',}', 'g')
    close.lastIndex = fence.lastIndex
    const end = close.exec(text)
    add(m.index, end ? close.lastIndex : text.length, 'code')
    fence.lastIndex = end ? close.lastIndex : text.length
  }
  for (const r of text.matchAll(/(`+)([^\r\n]*?)\1(?!`)/g)) if (!inside(r.index)) add(r.index, r.index + r[0].length, 'code')
  for (const r of text.matchAll(/`+/g)) if (!inside(r.index)) add(r.index, text.length, 'code')
  for (const r of text.matchAll(/^(?: {4}|\t)[^\r\n]*(?:\r?\n|$)/gm)) add(r.index, r.index + r[0].length, 'code')
  for (const r of text.matchAll(/\$\$[\s\S]*?(?:\$\$|$)|\\\[[\s\S]*?(?:\\\]|$)|\\\([\s\S]*?(?:\\\)|$)|(?<!\\)\$[^$\r\n]+\$/g)) if (!inside(r.index)) add(r.index, r.index + r[0].length, 'formula')
  for (const r of text.matchAll(/「[^」]*」|『[^』]*』|“[^”]*”|‘[^’]*’|"[^"\r\n]*"|(?<![\p{L}\p{N}])'[^'\r\n]*'/gu)) if (!inside(r.index)) add(r.index, r.index + r[0].length, 'quotation')
  for (let at = 0; at < text.length; at++) {
    if (inside(at) || (text[at] !== '[' && !text.startsWith('![', at))) continue
    const link = markdownLink(text, at)
    if (link) { add(at, link.end, link.image ? 'image' : 'link'); at = link.end - 1 }
  }
  for (const r of text.matchAll(/\b(?:https?:\/\/|www\.)[^\s`"「」『』“”]+/gi)) if (!inside(r.index)) add(r.index, r.index + r[0].length, 'url')
  for (const r of text.matchAll(/[+\-−]?\d[\d.,:/%％_eE+\-]*/g)) if (!inside(r.index)) add(r.index, r.index + r[0].length, 'number')
  for (const r of text.matchAll(/\\[^\r\n]/gu)) if (!inside(r.index)) add(r.index, r.index + r[0].length, 'escape')
  found.sort((a, b) => a.start - b.start || b.end - a.end)
  const ranges = []
  for (const r of found) {
    const last = ranges.at(-1)
    if (last && r.start < last.end) last.end = Math.max(last.end, r.end)
    else ranges.push({ ...r })
  }
  return ranges
}

/** 保守去装饰：含歧义的标记宁可留着，代码内容/URL/负号/引用不做替换。 */
export function stripMarkdown(value) {
  const text = stringOf(value), protectedRanges = protectedReplyRanges(text), edits = []
  const free = (start, end) => !protectedRanges.some(r => start < r.end && end > r.start)
  const replace = (regex, transform) => {
    for (const m of text.matchAll(regex)) if (free(m.index, m.index + m[0].length)) edits.push({ start: m.index, end: m.index + m[0].length, value: transform(m) })
  }
  replace(/(?<![\p{L}\p{N}_])\*\*([^*\r\n]+)\*\*(?![\p{L}\p{N}_])/gu, m => m[1])
  replace(/(?<![\p{L}\p{N}_])__([^_\r\n]+)__(?![\p{L}\p{N}_])/gu, m => /[\p{Script=Han}\s]/u.test(m[1]) ? m[1] : m[0])
  replace(/^#{1,6} +(?=\p{L})/gmu, () => '')
  replace(/^- +(?=[\p{Script=Han}，。、！？]+\r?$)/gmu, () => '')
  replace(/[ \t]+(?=\r?$)/gm, () => '')
  // 单个标识符的反引号可以去掉；复杂代码和代码块保留全部定界符/空白。
  for (const r of protectedRanges) {
    const raw = text.slice(r.start, r.end)
    if (r.kind === 'code' && /^`[\p{L}_][\p{L}\p{N}_]*`$/u.test(raw)) edits.push({ start: r.start, end: r.end, value: raw.slice(1, -1) })
  }
  edits.sort((a, b) => a.start - b.start || b.end - a.end)
  let out = '', cursor = 0
  for (const e of edits) { if (e.start < cursor) continue; out += text.slice(cursor, e.start) + e.value; cursor = e.end }
  return out + text.slice(cursor)
}

export function isSilence(text) {
  return ['', SILENCE, '［沉默］', '(沉默)', '（沉默）'].includes(stringOf(text).trim())
}

/** 原始 block 是唯一内容来源。模型只能引用这些 ID，不能提供媒体路径或替代语音。 */
export function createReplySource(value) {
  const text = stringOf(value), blocks = [], ranges = protectedReplyRanges(text)
  const add = (type, start, end, extra = {}) => blocks.push({ id: `b${blocks.length}`, type, start, end, raw: text.slice(start, end), ...extra })
  let from = 0, at = 0, rangeAt = 0
  while (at < text.length) {
    while (ranges[rangeAt]?.end <= at) rangeAt++
    const range = ranges[rangeAt]
    if (range && range.start <= at && range.kind !== 'image') { at = range.end; continue }
    let token = null
    if (text.startsWith('![', at)) {
      const link = markdownLink(text, at)
      if (link) {
        if (link.url) token = { type: 'imageAsset', end: link.end, value: link.url, alt: link.label }
        else { at = link.end; continue }
      }
    }
    if (!token && text.startsWith('|||', at)) token = { type: 'break', end: at + 3 }
    if (!token && text[at] === '<') {
      const tail = text.slice(at)
      let m
      if ((m = /^<reply:\s*(\d+)\s*>/.exec(tail))) token = { type: 'quote', end: at + m[0].length, value: m[1] }
      else if ((m = /^<voice>([\s\S]*?)<\/voice>/.exec(tail)) && m[1].trim()) token = { type: 'voiceRequest', end: at + m[0].length, value: m[1] }
      else if ((m = /^<sticker:([^>]+?)>(?:\s*<\/sticker>)?/.exec(tail)) && m[1].trim()) token = { type: 'stickerAsset', end: at + m[0].length, value: m[1].trim() }
      else if ((m = /^<poke\s*\/?>/.exec(tail))) token = { type: 'poke', end: at + m[0].length, value: '' }
    }
    if (!token) { at++; continue }
    if (from < at) add('text', from, at)
    const { type, end, ...extra } = token
    add(type, at, end, extra)
    from = at = end
  }
  if (from < text.length) add('text', from, text.length)
  return { schema: 'aurabot.reply.source', version: REPLY_VERSION, text, blocks }
}

function defaultCuts(text) {
  if (text.length > 240) return []
  const lines = text.split(/\r?\n/).filter(s => s.trim())
  if (lines.length < 2 || lines.filter(s => /^\s*(?:\d+[.、)]|[-*+•·]|>)/.test(s)).length >= Math.ceil(lines.length / 2)) return []
  if (protectedReplyRanges(text).some(r => ['code', 'formula'].includes(r.kind))) return []
  const cuts = []
  for (const m of text.matchAll(/(?:\r?\n)+/g)) if (m.index + m[0].length < text.length) cuts.push(m.index + m[0].length)
  return cuts.slice(0, MAX_CUTS)
}

/** UTF-16 切点；输出连续原文切片，join('') 必须逐字还原输入。无效切点回退整段。 */
export function splitReplyText(value, proposedCuts) {
  const text = stringOf(value), explicit = proposedCuts !== undefined
  const cuts = explicit ? proposedCuts : defaultCuts(text)
  const fallback = reason => ({ ok: false, reason, pieces: [{ start: 0, end: text.length, text }] })
  if (!Array.isArray(cuts) || cuts.length > MAX_CUTS) return fallback('切点必须是有界数组')
  const boundaries = new Set([text.length, ...Array.from(graphemes.segment(text), s => s.index)])
  const protectedRanges = protectedReplyRanges(text)
  let previous = 0
  const accepted = []
  for (const cut of cuts) {
    const valid = Number.isSafeInteger(cut) && cut > previous && cut < text.length && boundaries.has(cut) && !protectedRanges.some(r => r.start < cut && cut < r.end)
    if (!valid) { if (explicit) return fallback('切点乱序、越界或破坏受保护内容'); continue }
    accepted.push(cut); previous = cut
  }
  const ends = [...accepted, text.length], pieces = []
  previous = 0
  for (const end of ends) { pieces.push({ start: previous, end, text: text.slice(previous, end) }); previous = end }
  return { ok: true, pieces }
}

function displayText(raw) {
  const cleaned = stripMarkdown(raw)
  // 缩进/围栏代码的首尾空白有意义；其它边缘空白留在 source 中供相邻段复原。
  if (protectedReplyRanges(raw).some(r => r.kind === 'code' && (r.start === 0 || r.end === raw.length) && !/^`[\p{L}_][\p{L}\p{N}_]*`$/u.test(raw.slice(r.start, r.end)))) return { value: cleaned, leading: '', trailing: '' }
  return { value: cleaned.trim(), leading: raw.match(/^\s*/)[0], trailing: raw.match(/\s*$/)[0] }
}

function sourced(item, meta) {
  Object.defineProperty(item, layout, { value: meta })
  return item
}

/** 可序列化的原文引用；普通 item 的老字段保持兼容。 */
export function replySourceRefs(item) { return structuredClone(item?.[layout]?.refs || []) }

function renderSource(source, plan) {
  if (isSilence(source.text)) return { silent: true, items: [], source }
  const items = []
  let quote = null, breakBefore = false
  const emit = (item, block, start = block.start, end = block.end, before) => {
    const refs = []
    if (quote) refs.push({ blockId: quote.id, start: quote.start, end: quote.end, raw: quote.raw })
    if (quote) { item.replyTo = quote.value; quote = null }
    refs.push({ blockId: block.id, start, end, raw: source.text.slice(start, end) })
    sourced(item, { refs, before, source })
    items.push(item)
  }
  for (let n = 0; n < source.blocks.length; n++) {
    const block = source.blocks[n]
    if (block.type === 'break') { breakBefore = true; continue }
    if (block.type === 'quote') {
      // 连续/悬空引用无法挂到同一消息：保留为原文，不能静默删掉。
      if (quote) { const old = quote; quote = null; emit({ kind: 'text', value: old.raw }, old) }
      quote = block; continue
    }
    if (block.type === 'text') {
      let trailing = '', emitted = false, pendingStart = 0
      const slices = splitReplyText(block.raw, plan?.blocks[n]?.cuts).pieces
      for (const piece of slices) {
        const display = displayText(piece.text)
        if (!display.value) { trailing += piece.text; continue }
        const before = emitted ? trailing + display.leading : breakBefore ? '\n' + display.leading : undefined
        emit({ kind: 'text', value: display.value }, block, block.start + pendingStart, block.start + piece.end, before)
        emitted = true; trailing = display.trailing; breakBefore = false
        pendingStart = piece.end
      }
      if (emitted && pendingStart < block.raw.length) {
        const ref = items.at(-1)[layout].refs.at(-1)
        ref.end = block.end; ref.raw = source.text.slice(ref.start, ref.end)
      }
    } else {
      const kind = { voiceRequest: 'voice', imageAsset: 'image', stickerAsset: 'sticker', poke: 'poke' }[block.type]
      if (kind === 'poke' && items.some(i => i.kind === 'poke') && !quote) continue
      emit({ kind, value: block.value }, block)
      breakBefore = false
    }
  }
  if (quote) { const old = quote; quote = null; emit({ kind: 'text', value: old.raw }, old) }
  return { silent: items.length === 0, items: capBubbles(items), source }
}

/** 旧标签入口仍可直接调用；代码/URL/引文中的控制标签只是字面文本。 */
export function parseReply(text) { return renderSource(createReplySource(text)) }

function parsePlanJson(text) {
  const value = JSON.parse(text), stack = []
  // JSON.parse 接受重复键，协议不接受；包括转义后同名的 schema/version/ref。
  for (const m of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
    const token = m[0], current = stack.at(-1)
    if (token === '{') stack.push({ keys: new Set(), key: true })
    else if (token === '[') stack.push({})
    else if (token === '}' || token === ']') stack.pop()
    else if (token === ':' && current?.keys) current.key = false
    else if (token === ',' && current?.keys) current.key = true
    else if (token[0] === '"' && current?.keys && current.key) {
      const key = JSON.parse(token)
      if (current.keys.has(key)) throw new Error('duplicate key')
      current.keys.add(key)
    }
  }
  return value
}

/** 版本化输出只接受逐块引用和切点，全文/类型/顺序/区间任一不符都拒绝。 */
export function validateReplyPlan(original, candidate) {
  const fail = reason => ({ ok: false, reason })
  try {
    const source = createReplySource(original)
    let plan = candidate
    if (typeof plan === 'string') {
      if (plan.length > Math.max(16384, source.text.length * 8)) return fail('结构化输出过长')
      plan = parsePlanJson(plan)
    }
    const keys = (o, allowed, required) => o && Object.getPrototypeOf(o) === Object.prototype && Object.keys(o).every(k => allowed.includes(k)) && required.every(k => Object.hasOwn(o, k))
    if (!keys(plan, ['schema', 'version', 'blocks'], ['schema', 'version', 'blocks']) || plan.schema !== REPLY_SCHEMA || plan.version !== REPLY_VERSION || !Array.isArray(plan.blocks) || plan.blocks.length > 256 || plan.blocks.length !== source.blocks.length) return fail('schema、版本或 block 数量不匹配')
    for (let n = 0; n < source.blocks.length; n++) {
      const block = source.blocks[n], next = plan.blocks[n]
      if (!keys(next, block.type === 'text' ? ['type', 'ref', 'text', 'cuts'] : ['type', 'ref'], ['type', 'ref']) || next.type !== block.type || next.ref !== block.id) return fail('block 引用、类型或顺序不匹配')
      // 可回显原文，但绝不发送模型新造的句子；不把词法启发式冒充语义证明。
      if ('text' in next && (typeof next.text !== 'string' || next.text !== block.raw)) return fail('文本必须与引用原文逐字一致')
      if ('cuts' in next && !splitReplyText(block.raw, next.cuts).ok) return fail('文本切点不合法')
    }
    const frozenPlan = structuredClone(plan)
    return { ok: true, plan: frozenPlan, reply: renderSource(source, frozenPlan) }
  } catch { return fail('结构化输出无法解析') }
}

export function splitLines(text) {
  return splitReplyText(text).pieces.map(p => displayText(p.text).value).filter(Boolean)
}

function mergeText(a, b) {
  if (a.kind !== 'text' || b.kind !== 'text' || a.replyTo != null || b.replyTo != null) return null
  const left = a[layout], right = b[layout]
  const separator = left && right && left.source === right.source ? right.before ?? '\n' : '\n'
  const out = { ...a, value: a.value + separator + b.value }
  if (left || right) sourced(out, { refs: [...(left?.refs || []), ...(right?.refs || [])], before: left?.before, source: left?.source === right?.source ? left?.source : undefined })
  return out
}

function mergeToLimit(items, max, count) {
  const out = [...items]
  for (let n = out.length - 1; n > 0 && count(out) > max; n--) {
    const merged = mergeText(out[n - 1], out[n])
    if (merged) out.splice(n - 1, 2, merged)
  }
  return out
}

export function capBubbles(items, max = MAX_BUBBLES) {
  if (!Array.isArray(items) || !Number.isSafeInteger(max) || max < 0) return items
  return mergeToLimit(items, max, out => out.filter(i => i.kind === 'text').length)
}

/** 只删装饰、只并相邻且无引用的文字；不足以满足上限时保留全部内容。 */
export function capItems(items, max) {
  if (!Array.isArray(items) || !Number.isSafeInteger(max) || max < 0 || items.length <= max) return items
  const out = [...items]
  for (let n = out.length - 1; n >= 0 && out.length > max; n--) if (['sticker', 'poke'].includes(out[n].kind) && out[n].replyTo == null) out.splice(n, 1)
  return mergeToLimit(out, max, remaining => remaining.length)
}

export function wantsVoice(text) {
  const t = stringOf(text)
  if (t.includes('不要语音') || t.includes('别发语音')) return false
  return /(用|发|来|给我|录)[^，。？！\n]{0,4}语音|语音[^，。？！\n]{0,4}(说|发|讲|回|念|唱)/.test(t)
}

export function bubbleDelay(next = '', rand = Math.random) {
  if (typeof next === 'function') { rand = next; next = '' }
  return Math.round(Math.min(4500, Math.max(700, 350 + stringOf(next).length * 110)) * (0.8 + rand() * 0.5))
}

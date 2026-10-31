/** Replace unpaired UTF-16 surrogates without altering valid pairs. */
export function cleanText(value) {
  const text = String(value ?? '')
  return text.toWellFormed ? text.toWellFormed() : text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
}

/** Clip to at most max UTF-16 units, optionally preserving whole graphemes. */
export function clipText(value, max, { graphemes = false } = {}) {
  const text = cleanText(value)
  const limit = Math.max(0, Math.floor(Number(max) || 0))
  if (text.length <= limit) return text
  const parts = graphemes && typeof Intl.Segmenter === 'function'
    ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), x => x.segment)
    : Array.from(text)
  let out = ''
  for (const part of parts) { if (out.length + part.length > limit) break; out += part }
  return out
}

/** Copy structured model content, cleaning text without mutating stored evidence. */
export function cleanContent(value) {
  if (typeof value === 'string') return cleanText(value)
  if (Array.isArray(value)) return value.map(cleanContent)
  if (value && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanContent(v)]))
  return value
}

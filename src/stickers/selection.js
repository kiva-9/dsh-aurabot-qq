export const DEFAULT_TAGS = ['开心', '卖萌', '生气', '委屈', '无语', '嘲讽', '疑惑', '早晚安']
const norm = (v) => String(v || '').toLowerCase().trim()
const fields = (it) => [it.name, ...(it.tags || []), ...(it.emotions || []), ...(it.suitable || []), it.ocr]

/** 纯召回函数；传入的数据必须已经由 store 做范围/审核过滤。没有命中就不发。 */
export function matchSticker(items, query) {
  const q = norm(query)
  if (!q) return null
  let best = null
  let bestScore = 0
  for (const it of items) {
    if (it.state && it.state !== 'approved') continue
    let score = [it.id, it.md5, it.sha256].includes(q) ? 100 : 0
    for (const field of fields(it)) {
      const word = norm(field)
      if (!word) continue
      if (word === q) score = Math.max(score, 10)
      else if (word.includes(q) || (word.length >= 2 && q.includes(word))) score = Math.max(score, 6)
    }
    if (score > bestScore) { best = it; bestScore = score }
  }
  return best
}

export function allowedForContext(item, text, options = {}) {
  const hay = norm([item.name, item.description, item.ocr, ...(item.tags || []), ...(item.emotions || [])].join(' '))
  const context = norm([text, options.intent, options.mood].filter(Boolean).join(' '))
  if ((options.blockedTags || []).some((tag) => hay.includes(norm(tag)))) return false
  if (options.allowedTags?.length && !options.allowedTags.some((tag) => (item.tags || []).includes(tag))) return false
  const comfort = /安慰|难过|伤心|抱抱|辛苦|别哭|别怕|comfort/.test(context)
  if (comfort && /嘲讽|幸灾乐祸|攻击|活该|废物|傻逼/.test(hay)) return false
  if ((item.unsuitable || []).some((term) => norm(term) && (context.includes(norm(term)) || (comfort && /安慰|悲伤|难过|comfort/.test(term))))) return false
  return true
}

export function pickForReply(items, replyText, options = {}) {
  const pool = items.filter((it) => allowedForContext(it, replyText, options))
  return matchSticker(pool, replyText)
}

/** 可选模型选择器的边界：不合法 ID、解析失败、no_match 都不回退到第一张。 */
export function parseSelection(value, candidates) {
  try {
    const result = typeof value === 'string' ? JSON.parse(value) : value
    if (result?.decision !== 'match' || typeof result.id !== 'string') return null
    return candidates.find((it) => it.id === result.id) || null
  } catch { return null }
}

export function pickEvict(items) {
  return items.filter((i) => !['manual', 'panel', 'qq', 'tool'].includes(i.from))
    .sort((a, b) => (a.uses || 0) - (b.uses || 0) || (a.lastUsed || a.at || 0) - (b.lastUsed || b.at || 0))[0] || null
}

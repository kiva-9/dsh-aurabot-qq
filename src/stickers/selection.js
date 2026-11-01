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

// Relevance is only a recall aid. The decision model sees the actual images,
// and can reject every candidate. Random exploration includes old material
// regardless of the order in which the repository happened to return it.
export function rankDecisionCandidates(items, text, { count = 20, recent = [], random = Math.random } = {}) {
  const query = norm(text).slice(0, 2000).replace(/\s+/g, '')
  const grams = new Set()
  for (let i = 0; i < query.length - 1; i++) grams.add(query.slice(i, i + 2))
  const order = new Map(recent.map((sha, index) => [sha, recent.length - index]))
  const scored = items.map(item => {
    const material = norm([item.name, item.description, item.ocr, ...(item.tags || []), ...(item.emotions || []), ...(item.suitable || [])].join(' ')).slice(0, 2000)
    let score = 0
    const matched = new Set()
    for (let i = 0; i < material.length - 1; i++) {
      const gram = material.slice(i, i + 2)
      if (grams.has(gram) && !matched.has(gram)) { matched.add(gram); score++ }
    }
    for (const word of [item.name, ...(item.tags || []), ...(item.emotions || []), ...(item.suitable || [])]) {
      const value = norm(word)
      if (value.length >= 2 && query.includes(value)) score += 3
    }
    score -= (order.get(item.sha256) || 0) * 2
    return { item, score, tie: random() }
  })
  const limit = Math.min(Math.max(1, count), scored.length)
  const relevantSlots = Math.ceil(limit * 0.75)
  scored.sort((a, b) => b.score - a.score || a.tie - b.tie)
  const relevant = scored.slice(0, relevantSlots)
  const explored = scored.slice(relevantSlots).sort((a, b) => a.tie - b.tie).slice(0, limit - relevant.length)
  return [...relevant, ...explored].map(x => x.item)
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

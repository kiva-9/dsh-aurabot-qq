// Purpose planning is deterministic and side-effect free. Scores are hypotheses,
// never claims that the character or a participant actually had an experience.
const WINDOW = 72 * 60 * 60_000
const NEEDS = {
  care: /累|生病|医院|考试|面试|加班|压力|难过|休息|睡觉/iu,
  learn: /教程|学习|研究|原理|知识|代码|配置|插件|怎么|为什么/iu,
  play: /游戏|联机|开黑|玩|桌游|比赛/iu,
  create: /画画|创作|写作|剪辑|手工|做视频/iu,
  connect: /陪|一起|聊天|晚安|早安|想你/iu,
}
const clip = (v, n = 180) => Array.from(String(v || '').replace(/\s+/gu, ' ').trim()).slice(0, n).join('')
const exactScope = (a, b) => a && b && String(a.account) === String(b.account) && a.chat === b.chat && (a.persona || '') === (b.persona || '')

/** Only live, exact-scope sources may become planning material. */
export function collectMaterials({ scope, messages = [], facts = [], ownerId, now = Date.now() }) {
  if (!scope?.account || !scope.chat || !scope.persona) return []
  const rows = []
  for (const m of messages.slice(-40)) {
    const at = Number(m.receivedAt || m.platformTime || 0), text = clip(m.text)
    if (!m.id || m.account !== scope.account || m.chatId !== scope.chat || m.recalledAt != null ||
        String(m.authorId) === scope.account || !text || !at || at > now || now - at > WINDOW) continue
    rows.push({ id: `message:${m.id}`, kind: 'message', at, text, owner: String(m.authorId) === String(ownerId) ? 'owner' : 'member', revision: 0 })
  }
  for (const f of facts.slice(0, 20)) {
    const at = Number(f.eventTime || f.updatedAt || f.createdAt || f.at || 0), text = clip(f.text)
    const publicScope = { ...scope, persona: '' }
    if (!f.id || !text || f.status !== 'active' || (!exactScope(f.scope, scope) && !exactScope(f.scope, publicScope)) ||
        !at || at > now || now - at > WINDOW) continue
    rows.push({ id: `memory:${f.id}`, kind: 'memory', at, text,
      owner: f.category === 'experience' && f.scope.persona === scope.persona ? 'self' : String(f.subject) === String(ownerId) ? 'owner' : 'unknown',
      revision: Number(f.revision || 0), scope: f.scope })
  }
  return rows.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)).slice(0, 24)
}

/** Bounded attention values and source-bound, explicitly tentative goals. */
export function planPurpose({ materials = [], usedSourceIds = [], now = Date.now() } = {}) {
  const drives = { care: 0, learn: 0, play: 0, create: 0, connect: 0, share: 0 }
  const used = new Set(usedSourceIds)
  const goals = []
  for (const m of materials.slice(0, 24)) {
    const matches = Object.entries(NEEDS).filter(([, re]) => re.test(m.text)).map(([k]) => k)
    const need = matches[0] || 'share'
    const recency = Math.max(0, 1 - (now - m.at) / WINDOW)
    drives[need] = Math.min(1, drives[need] + 0.12 + 0.12 * recency)
    // A source is consumed before dispatch, including ambiguous attempts.
    if (used.has(m.id)) continue
    const isQuestion = /[?？]|吗[。！!？?]?$|呢[。！!？?]?$/u.test(m.text)
    const action = need === 'care' ? 'care' : isQuestion ? 'follow' : 'ask'
    const confidence = m.kind === 'message' ? 0.45 : 0.35
    const risk = need === 'care' ? 0.2 : 0.1
    goals.push({ id: `${m.id}:${need}`, sourceId: m.id, owner: m.owner, need, action, topic: m.text,
      confidence, risk, value: Math.round((0.35 + recency * 0.3 + (isQuestion ? 0.1 : 0)) * 100) / 100,
      evidence: { id: m.id, kind: m.kind, at: m.at, revision: m.revision }, status: 'hypothesis' })
  }
  const candidates = goals.map(g => ({ ...g, score: Math.round((g.value + drives[g.need] * 0.2 - g.risk) * 1000) / 1000 }))
    .sort((a, b) => b.score - a.score || b.evidence.at - a.evidence.at || a.id.localeCompare(b.id)).slice(0, 6)
  for (const key of Object.keys(drives)) drives[key] = Math.round(drives[key] * 100) / 100
  return { drives, goals: goals.slice(0, 24), candidates, selected: candidates[0] || null }
}

/** Shared scheduling guards; undefined candidates retains the existing public helper contract. */
export function decidePurpose({ enabled, mode, muted, dryRun, awake = true, idleMs, idleMinutes, lastAt, nextAt, now, minIntervalMinutes, count, maxPerDay, candidates }) {
  if (!enabled || mode !== 'purpose' || muted) return { act: false, reason: 'disabled' }
  if (dryRun) return { act: false, reason: 'dry-run' }
  if (!awake) return { act: false, reason: 'quiet' }
  if (!Number.isFinite(now) || !Number.isFinite(idleMs) || idleMs < Math.max(0, idleMinutes || 0) * 60000) return { act: false, reason: 'active' }
  if ((count || 0) >= maxPerDay) return { act: false, reason: 'quota' }
  if (lastAt && now - lastAt < Math.max(1, minIntervalMinutes || 1) * 60000) return { act: false, reason: 'cooldown' }
  if (nextAt && now < nextAt) return { act: false, reason: 'scheduled' }
  if (Array.isArray(candidates) && !candidates.length) return { act: false, reason: 'no-material' }
  return { act: true, reason: '目的候选', candidate: candidates?.[0] }
}

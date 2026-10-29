import { canonical, fail, hash } from './scope.js'

export const PROFILE_SECTIONS = ['identity', 'relationships', 'stableFacts', 'preferences', 'recentInteractions', 'uncertain']
export const FACT_STATUSES = ['active', 'conflicted', 'superseded', 'retracted']
export function object(v, label) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail('INVALID_STRUCTURE', `${label} 必须为对象`)
  return v
}
export function exactKeys(v, allowed, label) {
  object(v, label)
  for (const k of Object.keys(v)) if (!allowed.includes(k)) fail('INVALID_STRUCTURE', `${label} 含不支持字段 ${k}`)
}
export function string(v, label, max = 4000) {
  if (typeof v !== 'string' || !v.trim() || v.length > max) fail('INVALID_STRUCTURE', `${label} 必须为非空字符串，最多 ${max} 字符`)
  return v.trim()
}
export function enumValue(v, values, label) {
  if (!values.includes(v)) fail('INVALID_STRUCTURE', `${label} 无效`)
  return v
}
export function ids(v, label, allowEmpty = false) {
  if (!Array.isArray(v) || (!v.length && !allowEmpty) || v.length > 200 || new Set(v).size !== v.length) fail('INVALID_STRUCTURE', `${label} 必须为无重复 ID 数组`)
  return v.map(x => string(x, label, 200))
}
function time(v, label) {
  if (v === null) return null
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) fail('INVALID_STRUCTURE', `${label} 必须为毫秒时间戳或 null`)
  return v
}
export const FACT_FIELDS = ['text','subject','predicate','value','speakerId','polarity','modality','conditions','eventTime','validFrom','validTo','status','stability','slot','profileSection','aboutName','tags','importance','supersedes','extractorVersion']
export function normalizeFact(v) {
  object(v, 'fact')
  for (const key of ['subject','predicate','value','speakerId','polarity','modality','conditions','eventTime','validFrom','validTo','stability']) {
    if (!(key in v)) fail('INVALID_STRUCTURE', `fact 缺少 ${key}`)
  }
  const subject = string(v.subject, 'subject', 200)
  const predicate = string(v.predicate, 'predicate', 200)
  if (!(typeof v.value === 'string' && v.value.trim()) && !(typeof v.value === 'number' && Number.isFinite(v.value)) && typeof v.value !== 'boolean') fail('INVALID_STRUCTURE', 'value 必须为非空字符串、有限数值或布尔值')
  if (typeof v.value === 'string' && v.value.length > 4000) fail('INVALID_STRUCTURE', 'value 太长')
  const f = {
    text: v.text === undefined ? `${subject} ${predicate} ${v.value}` : string(v.text, 'text'),
    subject, predicate, value: v.value, speakerId: string(v.speakerId, 'speakerId', 200),
    polarity: enumValue(v.polarity, ['positive','negative'], 'polarity'),
    modality: enumValue(v.modality, ['asserted','reported','hypothetical','plan','joke','uncertain'], 'modality'),
    conditions: v.conditions === null ? null : ids(v.conditions, 'conditions', true).sort(),
    eventTime: time(v.eventTime, 'eventTime'), validFrom: time(v.validFrom, 'validFrom'), validTo: time(v.validTo, 'validTo'),
    status: enumValue(v.status ?? 'active', FACT_STATUSES, 'status'),
    stability: enumValue(v.stability, ['stable','temporal','uncertain'], 'stability'),
    slot: enumValue(v.slot ?? 'multi', ['single','multi'], 'slot'),
    profileSection: enumValue(v.profileSection ?? 'stableFacts', PROFILE_SECTIONS, 'profileSection'),
    aboutName: v.aboutName === undefined ? '' : String(v.aboutName).slice(0, 200),
    tags: v.tags === undefined ? [] : ids(v.tags, 'tags', true),
    importance: v.importance ?? 0.5, supersedes: v.supersedes === undefined ? [] : ids(v.supersedes, 'supersedes', true),
    extractorVersion: v.extractorVersion === undefined ? 'manual-v1' : string(v.extractorVersion, 'extractorVersion', 200),
  }
  if (typeof f.importance !== 'number' || !Number.isFinite(f.importance) || f.importance < 0 || f.importance > 1) fail('INVALID_STRUCTURE', 'importance 必须为 0..1')
  if (f.validFrom !== null && f.validTo !== null && f.validFrom >= f.validTo) fail('INVALID_STRUCTURE', 'validTo 必须晚于 validFrom')
  if (f.stability === 'stable' && !['asserted'].includes(f.modality)) fail('INVALID_STRUCTURE', '转述、计划、玩笑或推测不能升级成稳定事实')
  return f
}
// Equality is deliberately structural; similarity is only a candidate retrieval hint.
export const REUSE_FIELDS = Object.freeze(['subject','predicate','value','speakerId','polarity','modality','conditions','eventTime','validFrom','validTo','stability','slot'])
export function structuralKey(f) {
  return canonical(Object.fromEntries(REUSE_FIELDS.map(k => [k, f[k]])))
}
export const factFingerprint = f => hash(structuralKey(f))
export function reusable(a, b) {
  if (a.conditions === null || b.conditions === null) return false
  if (a.stability !== 'stable' && (a.eventTime === null || b.eventTime === null)) return false
  return structuralKey(a) === structuralKey(b)
}
export function parseJson(output) {
  if (typeof output !== 'string') return output
  // No greedy substring extraction: prose, truncated JSON and empty replies are failures.
  const s = output.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1')
  try { return JSON.parse(s) } catch { fail('INVALID_MODEL_OUTPUT', '模型未返回完整 JSON') }
}
export function validateDecisions(facts, decisions, candidates) {
  if (!Array.isArray(decisions) || decisions.length !== facts.length) fail('INVALID_DECISIONS', '每条输入必须恰有一个去重决定')
  const incoming = new Map(facts.map(f => [f.inputId, f]))
  const seen = new Set()
  for (const d of decisions) {
    exactKeys(d, ['inputId','action','targetId','candidateIds'], 'decision')
    if (!incoming.has(d.inputId) || seen.has(d.inputId)) fail('INVALID_DECISIONS', '去重 inputId 缺失、重复或越界')
    seen.add(d.inputId)
    enumValue(d.action, ['keep','reuse','possible_duplicate'], 'action')
    const allowed = new Map((candidates[d.inputId] || []).map(f => [f.id, f]))
    if (d.action === 'keep' && ('targetId' in d || 'candidateIds' in d)) fail('INVALID_DECISIONS', 'keep 不能包含目标')
    if (d.action === 'reuse') {
      if ('candidateIds' in d) fail('INVALID_DECISIONS', 'reuse 不能含 candidateIds，即使值为 null 或空数组')
      if (!allowed.has(d.targetId)) fail('INVALID_DECISIONS', 'reuse 目标不在本次授权候选中')
      if (!reusable(incoming.get(d.inputId), allowed.get(d.targetId))) fail('STRUCTURAL_CONFLICT', 'reuse 主体、说话人、肯否、数值、模态、条件或时间不一致/未知')
    }
    if (d.action === 'possible_duplicate') {
      if ('targetId' in d) fail('INVALID_DECISIONS', 'possible_duplicate 不能包含 targetId')
      for (const id of ids(d.candidateIds, 'candidateIds')) if (!allowed.has(id)) fail('INVALID_DECISIONS', '疑似重复目标不在本次授权候选中')
    }
  }
  return decisions
}

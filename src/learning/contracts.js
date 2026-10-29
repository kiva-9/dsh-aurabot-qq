import { createHash } from 'node:crypto'

export const KINDS = ['expression', 'jargon']
export const STATUSES = ['pending', 'approved', 'disabled', 'deleted']
export const MEANING_STATES = ['unknown', 'uncertain', 'confirmed', 'rejected']
export const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
export const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const scopeKey = (scope) => JSON.stringify([scope.account, scope.chat, scope.persona])
export function scopeOf(value) {
  const s = value?.scope || value || {}
  const account = String(s.account ?? s.accountId ?? '').trim(), chat = String(s.chat ?? s.chatId ?? '').trim(), persona = String(s.persona ?? s.personaId ?? '').trim()
  if (!account || !/^(private|group):[\w-]+$/.test(chat) || !persona || [account, chat, persona].some((v) => v.length > 160 || /[\x00-\x1f]/.test(v))) fail('SCOPE_REQUIRED', '必须提供 account、chat、persona 的明确聊天范围')
  return { account, chat, persona }
}
export function kindOf(kind) {
  if (!KINDS.includes(kind)) fail('INVALID_KIND', 'kind 必须是 expression 或 jargon')
  return kind
}
export const numberIn = (v, fallback, min, max) => Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.max(min, Math.min(max, Math.floor(Number(v)))) : fallback
export function text(value, max, name, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return ''
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail('INVALID_INPUT', `${name} 必须为 1–${max} 字符文本`)
  return value.trim()
}
export const DEFAULT_LEARNING = Object.freeze({
  enabled: true, learnEnabled: false, useEnabled: false,
  learnExpressions: true, useExpressions: true, learnJargon: true, useJargon: true, allowPrivate: false,
  maxAgeDays: 30, maxItemsPerScope: 200, maxEvidencePerItem: 12, maxQueue: 200, batchSize: 24,
  minEvidence: 3, minAuthors: 2, minIntervalMs: 300000, noInfoBackoffMs: 3600000,
  maxCallsPerDay: 30, maxConcurrent: 2, timeoutMs: 30000, maxContextItems: 4, contextCooldownMs: 600000,
  retryBaseMs: 60000, retryMaxMs: 3600000, pauseAfterFailures: 6, maxOutputTokens: 2400,
})
export function settings(cfg = {}) {
  const raw = cfg.learning || {}, c = { ...DEFAULT_LEARNING, ...raw }
  for (const k of ['enabled', 'learnEnabled', 'useEnabled', 'learnExpressions', 'useExpressions', 'learnJargon', 'useJargon', 'allowPrivate']) c[k] = raw[k] === undefined ? DEFAULT_LEARNING[k] : raw[k] === true
  // Zero removes only the daily ceiling; reservations, concurrency and retries still apply.
  const bounds = { maxAgeDays: [1, 90], maxItemsPerScope: [1, 1000], maxEvidencePerItem: [1, 30], maxQueue: [1, 1000], batchSize: [1, 100], minEvidence: [2, 20], minAuthors: [2, 10], minIntervalMs: [0, 86400000], noInfoBackoffMs: [1000, 604800000], maxCallsPerDay: [1, 1000000], maxConcurrent: [1, 4], timeoutMs: [100, 120000], maxContextItems: [1, 8], contextCooldownMs: [0, 86400000] }
  for (const [key, [min, max]] of Object.entries(bounds)) c[key] = numberIn(raw[key], DEFAULT_LEARNING[key], min, max)
  if (raw.maxCallsPerDay === 0 || raw.maxCallsPerDay === '0') c.maxCallsPerDay = 0
  for (const [key,min,max] of [['retryBaseMs',60000,3600000],['retryMaxMs',60000,86400000],['pauseAfterFailures',3,20],['maxOutputTokens',1000,8000]]) c[key]=numberIn(raw[key],DEFAULT_LEARNING[key],min,max)
  c.retryMaxMs=Math.max(c.retryBaseMs,c.retryMaxMs)
  c.minEvidence = Math.max(c.minEvidence, c.minAuthors)
  c.maxQueue = Math.max(c.maxQueue, c.minEvidence)
  c.batchSize = Math.max(c.minEvidence, Math.min(c.batchSize, c.maxQueue))
  c.allowedUserIds = Array.isArray(raw.allowedUserIds) ? raw.allowedUserIds.map(String).slice(0, 200) : []
  c.blockedUserIds = Array.isArray(raw.blockedUserIds) ? raw.blockedUserIds.map(String).slice(0, 200) : []
  return c
}
export function allows(c, kind, action) {
  return c.enabled && c[action + 'Enabled'] && c[action + (kind === 'expression' ? 'Expressions' : 'Jargon')]
}
// 硬边界只是第一层筛选；所有生成结果仍待人工审核，不能靠模型自报安全直接发布。
export function unsafeReason(value) {
  const s = String(value || '')
  if (/(?:https?:\/\/|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?<!\d)\d{7,}(?!\d)|密码|口令|住址|身份证|手机号|银行卡|家庭地址)/i.test(s)) return '包含隐私或可识别联系信息'
  if (/(?:忽略.{0,10}(?:指令|规则)|系统提示|system\s*prompt|管理员权限|执行命令|调用工具|tool_call|```|<\/?(?:system|tool)|\[CQ:)/i.test(s)) return '包含工具或权限指令'
  if (/(?:你(?:是|叫)|我的(?:主人|名字)|永远服从|改变人设|替换人格|我是(?:主人|管理员))/.test(s)) return '涉及稳定身份或权限设定'
  if (/(?:废物|贱人|傻逼|去死|杀了你|人渣)/.test(s)) return '包含定向辱骂或攻击'
  if (/(?:我|他|她|主人).{0,12}(?:住在|出生于|工作于|的生日|的电话|患有|诊断)/.test(s)) return '包含人物事实，不属于表达习惯'
  return ''
}
export function termMatches(term, input) {
  const needle = String(term).normalize('NFKC').toLowerCase(), hay = String(input).normalize('NFKC').toLowerCase()
  if (!needle) return false
  if (/^[a-z0-9_ -]+$/i.test(needle)) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^a-z0-9_])${escaped}(?=$|[^a-z0-9_])`, 'i').test(hay)
  }
  return hay.includes(needle)
}

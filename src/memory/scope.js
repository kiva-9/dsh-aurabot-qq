import { createHash } from 'node:crypto'

export class MemoryError extends Error {
  constructor(code, message) { super(message); this.code = code }
}
export function fail(code, message) { throw new MemoryError(code, message) }
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
  return JSON.stringify(value)
}
export const hash = value => createHash('sha256').update(canonical(value)).digest('hex')
export function scopeOf(input) {
  const s = input?.scope || input
  if (!s || typeof s !== 'object') fail('SCOPE_REQUIRED', '必须显式提供 scope.account / scope.chat')
  const account = s.account ?? s.botAccountId
  const chat = s.chat ?? s.chatId
  const persona = s.persona ?? s.personaId ?? ''
  if (typeof account !== 'string' || !account.trim() || account.length > 160 || account !== account.trim()) fail('SCOPE_REQUIRED', 'scope.account 必须为非空账号字符串')
  if (typeof chat !== 'string' || !/^(group|private):[\w-]+$/.test(chat)) fail('SCOPE_REQUIRED', 'scope.chat 必须为 group:id 或 private:id')
  if (typeof persona !== 'string' || persona.length > 160 || persona !== persona.trim()) fail('INVALID_SCOPE', 'persona 必须为字符串')
  return { account, chat, persona }
}
export const scopeKey = s => canonical(scopeOf(s))
export const sameScope = (a, b) => scopeKey(a) === scopeKey(b)
export function visible(scope, viewer, policy = {}, category = 'fact') {
  if (scope.account !== viewer.account || (scope.persona && scope.persona !== viewer.persona)) return false
  if (scope.chat === viewer.chat) return true
  return (policy.shareGroups || []).some(g =>
    (!g.account || g.account === viewer.account) &&
    Array.isArray(g.categories) && g.categories.includes(category) &&
    Array.isArray(g.chats) && g.chats.includes(scope.chat) && g.chats.includes(viewer.chat))
}
export function owned(scope, viewer) {
  if (!sameScope(scope, viewer)) fail('NOT_FOUND', '当前范围没有这条记录')
}
export function receipt(value, scope) { return { ...value, scope, account: scope.account, chat: scope.chat, persona: scope.persona } }

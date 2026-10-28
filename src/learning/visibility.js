import { canSee } from '../domain/scope.js'

// 分类共享只扩大读取面；不迁移来源、不递归沿共享组传播，也不授予写入或原始消息读取。
function groupsFor(viewer, kind, config) {
  const groups = config?.memory?.shareGroups
  if (!Array.isArray(groups)) return []
  return groups.filter((g) => g && typeof g.id === 'string' && g.id.trim() &&
    (!g.account || String(g.account) === viewer.account) &&
    Array.isArray(g.categories) && g.categories.includes(kind) &&
    Array.isArray(g.chats) && g.chats.includes(viewer.chat))
}
export function visible(source, viewer, kind, config) {
  if (!['expression', 'jargon'].includes(kind)) return false
  return canSee({ ...source, category: kind }, viewer, { shareGroups: groupsFor(viewer, kind, config) })
}
export function readableChats(viewer, kind, config) {
  const chats = new Set([viewer.chat])
  for (const group of groupsFor(viewer, kind, config)) {
    for (const chat of group.chats) if (typeof chat === 'string' && /^(private|group):[\w-]+$/.test(chat)) chats.add(chat)
  }
  return [...chats]
}

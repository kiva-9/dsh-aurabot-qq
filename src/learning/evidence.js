import { fail, hash, unsafeReason, settings } from './contracts.js'

/** 来源必须是主库里的本人入站正文；不把引用/转发、机器人、工具和图片说明当成学习证据。 */
export function readEvidence(storage, scope, id, { getConfig = () => ({}), now = Date.now, privacy = true } = {}) {
  const m = storage.messages.get(String(id)), c = settings(getConfig()), at = now()
  if (!m || m.account !== scope.account || m.chatId !== scope.chat || m.recalledAt != null || m.eventKind !== 'message' || !m.authorId || m.authorId === scope.account) return null
  if (m.receivedAt < at - c.maxAgeDays * 86400000 || m.receivedAt > at + 60000) return null
  if ((c.allowedUserIds.length && !c.allowedUserIds.includes(m.authorId)) || c.blockedUserIds.includes(m.authorId)) return null
  if (privacy && scope.chat.startsWith('private:') && !c.allowPrivate) return null
  const parts = m.segments || []
  if (m.forwards?.length && !parts.some((s) => s.type === 'text' && (s.text || s.data?.text))) return null
  let body = parts.length ? parts.filter((s) => s.type === 'text').map((s) => s.text ?? s.data?.text ?? '').join('') : m.text
  body = String(body || '').trim()
  if (!body || body.length > 2000 || /^[>“「『]/.test(body) || /\[(?:图片|表情|语音|工具|转发|引用|CQ:)/.test(body) || /(?:提示词示例|以下是示例|system:|assistant:|tool:)/i.test(body)) return null
  if (privacy && unsafeReason(body)) return null
  return { id: m.id, text: body, authorId: m.authorId, authorName: String(m.authorName || '').slice(0, 160), receivedAt: m.receivedAt, recvSeq: m.recvSeq,
    fingerprint: hash([m.account, m.chatId, m.authorId, body, m.receivedAt, m.eventKind, m.recalledAt]),
    spamKey: hash([m.authorId, body.normalize('NFKC').replace(/\s+/g, ' ').toLowerCase()]) }
}
export function requireEvidence(storage, scope, ids, deps, max = 12) {
  if (!Array.isArray(ids) || !ids.length || ids.length > max || ids.some((id) => typeof id !== 'string')) fail('EVIDENCE_REQUIRED', `需要 1–${max} 条真实来源消息 ID`)
  const evidence = [...new Set(ids)].map((id) => readEvidence(storage, scope, id, deps))
  if (evidence.some((e) => !e)) fail('EVIDENCE_INVALID', '来源消息不存在、已撤回/过期、不可学习或不在当前范围')
  return evidence
}

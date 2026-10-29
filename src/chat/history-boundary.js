// 用户清空后，平台历史只能从本账号的持久边界开始重新进入上下文。
// 边界由清理流程写入；这里每次读取，不缓存，也不替用户创建边界。
export function historyBoundary(storage, account) {
  const at = Number(storage?.meta?.get('history:boundary:' + String(account))?.at)
  return Number.isFinite(at) && at > 0 ? at : 0
}

export function historyTimeAllowed(storage, account, at) {
  const cutoff = historyBoundary(storage, account)
  return !cutoff || Number.isFinite(at) && at > 0 && at >= cutoff
}

/** OneBot 的 time 是秒，主库 platformTime 和边界是毫秒。 */
export function platformTimeMs(time) {
  const at = (typeof time === 'number' || typeof time === 'string') ? Number(time) * 1000 : NaN
  return Number.isFinite(at) && at > 0 ? at : null
}

const idOf = value => value == null || value === '' || String(value) === '0' ? '' : String(value)

/**
 * 聊天历史端点由请求限定聊天，可缺少范围字段，但不能与请求矛盾。
 * get_msg 只按消息 ID 查询，必须能从响应中确认聊天，不能补造 group_id。
 */
export function historyScopeMatches(raw, { account, chatId }, { requireChat = false } = {}) {
  if (!raw || typeof raw !== 'object') return false
  const self = String(account), [kind, peer] = String(chatId).split(':')
  if (!self || !peer || !['group', 'private'].includes(kind)) return false
  if (idOf(raw.self_id) && idOf(raw.self_id) !== self) return false
  if (raw.message_type && raw.message_type !== kind) return false
  const group = idOf(raw.group_id)
  if (kind === 'group') return group ? group === peer : !requireChat
  if (group) return false
  const sender = idOf(raw.sender?.user_id ?? raw.user_id), target = idOf(raw.target_id)
  const other = sender === self ? target || (idOf(raw.user_id) !== self ? idOf(raw.user_id) : '') : sender
  if (other && other !== peer) return false
  if (sender && sender !== self && target && target !== self) return false
  return !requireChat || raw.message_type === 'private' && other === peer
}

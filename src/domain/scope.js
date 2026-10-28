// 可见范围：一条记录（消息、图片出现、事实、表达、心情原因……）能被谁看到。纯函数。
//
// 默认私聊、群聊各自隔离；「同一个 QQ 号」不是跨群共享的依据。
// 主人可以配置共享组：哪些聊天之间共享哪几类数据（事实 / 图片 / 表达分开开关）。
// 派生出来的内容（摘要、画像）继承所有证据的可见范围的交集：每条证据都看得到才看得到。

export const CATEGORIES = ['message', 'image', 'fact', 'profile', 'expression', 'jargon', 'mood', 'experience']
// 这几类默认还要按人设隔离：换了角色不能夹带旧角色的习惯和情绪
export const PERSONA_SCOPED = new Set(['expression', 'mood', 'experience'])

/**
 * 记录的范围。chat 是 private:QQ号 / group:群号。persona 只有 PERSONA_SCOPED 的类别才需要。
 */
export function makeScope({ account, chat, category, persona = null }) {
  if (!account) throw new Error('范围缺少账号')
  if (!/^(private|group|system):[\w-]+$/.test(String(chat || ''))) throw new Error(`范围里的聊天不合法：${chat}`)
  if (!CATEGORIES.includes(category)) throw new Error(`范围类别不认识：${category}`)
  if (PERSONA_SCOPED.has(category) && !persona) throw new Error(`${category} 类的范围必须带人设`)
  return { account: String(account), chat: String(chat), category, ...(PERSONA_SCOPED.has(category) ? { persona: String(persona) } : {}) }
}

/** 共享组配置归一化：[{ id, chats: [...], categories: [...] }]，坏条目丢掉。 */
export function normalizeShareGroups(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const g of list) {
    if (!g || typeof g !== 'object') continue
    const id = String(g.id || '').trim()
    const chats = [...new Set((Array.isArray(g.chats) ? g.chats : []).map(String).filter((c) => /^(private|group):\d+$/.test(c)))]
    const categories = [...new Set((Array.isArray(g.categories) ? g.categories : []).map(String).filter((c) => CATEGORIES.includes(c) && c !== 'message'))]
    if (!id || chats.length < 2 || !categories.length) continue
    out.push({ id, chats, categories })
  }
  return out
}

/**
 * viewer = { account, chat, persona }：当前在哪个聊天、以哪个人设说话。
 * policy = { shareGroups }。
 */
export function canSee(scope, viewer, policy = {}) {
  if (!scope || !viewer) return false
  if (String(scope.account) !== String(viewer.account)) return false
  if (PERSONA_SCOPED.has(scope.category) && String(scope.persona || '') !== String(viewer.persona || '')) {
    // 跨人设共享只能显式配置，现阶段没有这种配置：直接不可见
    return false
  }
  if (scope.chat === viewer.chat) return true
  for (const g of policy.shareGroups || []) {
    if (g.categories.includes(scope.category) && g.chats.includes(scope.chat) && g.chats.includes(viewer.chat)) return true
  }
  return false
}

/** 派生内容：所有来源都可见才可见（交集，不是并集）。没有来源的派生内容一律不可见。 */
export function canSeeAll(scopes, viewer, policy = {}) {
  if (!Array.isArray(scopes) || !scopes.length) return false
  return scopes.every((s) => canSee(s, viewer, policy))
}

/** 从一个聊天 ID 拆出类型和号码。 */
export function parseChatId(chatId) {
  const m = /^(private|group|system):([\w-]+)$/.exec(String(chatId || ''))
  if (!m) return null
  return { kind: m[1], id: m[2] }
}

// 内置模块：基础 QQ 工具。翻聊天记录；主人私聊里还能让她主动给别人发消息。

import { defineTool, str, int } from '../../tools/tools.js'
import { parseMessageEvent } from '../../chat/inbound.js'
import { historyTimeAllowed, historyScopeMatches, platformTimeMs } from '../../chat/history-boundary.js'
import { fetchImage } from '../../core/net.js'
import { clipText } from '../../core/text.js'
import { checkAllowed } from '../../chat/access.js'

export function decodeIncomingText(data) {
  if (data.length > 2 * 1024 * 1024) throw new Error('文件超过 2 MiB')
  if (data.includes(0)) throw new Error('不是可读取的文本文件')
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(data) } catch { text = new TextDecoder('gb18030', { fatal: true }).decode(data) }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error('不是可读取的文本文件')
  return { text: clipText(text, 20000), truncated: text.length > 20000 }
}

export default {
  id: 'qq-tools',
  name: '基础 QQ 工具',
  version: '1.0.0',
  description: '翻当前聊天的记录（qq_chat_history）；主人私聊里让她主动给白名单里的人和群发消息（qq_send_message）',
  setup(api) {
    const { hub, onebot, storage } = api.core
    api.tool(({ chat, level, sessionId }) => {
      if (chat.kind === 'system') return []
      const self = String(api.config().botQQ)
      const chatIdHere = chat.chatId || `${chat.kind}:${chat.kind === 'group' ? chat.groupId : chat.userId}`
      const readFence = () => {
        const epoch = storage.epochs?.current(chatIdHere), policy = api.config().policyRevision || 0
        const persona = hub.personaFor?.(chatIdHere)
        const identity = p => p ? JSON.stringify([p.personaId, p.revision, p.bindingRevision, p.error]) : ''
        const captured = identity(persona)
        return () => !api.signal?.aborted && api.config().enabled !== false && api.config().modules?.['qq-tools']?.enabled !== false &&
          String(api.config().botQQ) === self && checkAllowed(api.config(), chat).allowed &&
          (api.config().policyRevision || 0) === policy && storage.epochs?.current(chatIdHere) === epoch && identity(hub.personaFor?.(chatIdHere)) === captured
      }
      const ownerFence = () => {
        const read = readFence(), owner = String(api.config().ownerQQ)
        const requests = JSON.stringify((hub.turnRequests?.(sessionId) || []).map(r => [r.id, r.actorId]))
        return () => read() && String(api.config().ownerQQ) === owner && hub.turnSendersAllOwner(sessionId) &&
          JSON.stringify((hub.turnRequests?.(sessionId) || []).map(r => [r.id, r.actorId])) === requests
      }
      const tools = [defineTool({
        name: 'qq_chat_history',
        description: '翻翻当前这个聊天之前的聊天记录（只读，最多 50 条）。想不起前面聊过什么、别人问「刚才谁说的」、要回顾一段对话时用。',
        properties: { count: int('要翻多少条，默认 20，最多 50') },
        execute: async ({ count }) => {
          const valid = readFence()
          const n = Math.max(1, Math.min(50, Number(count) || 20))
          if (!valid()) return { ok: false, message: '聊天范围已变化' }
          const r = chat.kind === 'group'
            ? await onebot.call('get_group_msg_history', { group_id: Number(chat.groupId), count: n }, { timeoutMs: 15000 })
            : await onebot.call('get_friend_msg_history', { user_id: Number(chat.userId), count: n }, { timeoutMs: 15000 })
          const chatId = chat.chatId || `${chat.kind}:${chat.kind === 'group' ? chat.groupId : chat.userId}`
          const msgs = !valid() ? [] : (r?.messages || [])
            .filter(m => historyScopeMatches(m, { account: self, chatId }) && historyTimeAllowed(storage, self, platformTimeMs(m.time))).slice(-n)
          if (!msgs.length) return { ok: true, message: '没翻到聊天记录' }
          const lines = msgs.map((m) => {
            const p = parseMessageEvent({ ...m, message_type: m.message_type || (chat.kind === 'group' ? 'group' : 'private') }, self)
            const who = String(m.user_id ?? m.sender?.user_id) === self ? '你' : (m.sender?.card || m.sender?.nickname || String(m.user_id ?? ''))
            const t = m.time ? new Date(m.time * 1000).toTimeString().slice(0, 5) : ''
            return `${t} ${who}：${(p.text || '（图片/表情）').slice(0, 150)}`
          })
          return { ok: true, message: lines.join('\n') }
        },
      })]
      tools.push(defineTool({
        name: 'qq_read_text_file',
        description: '读取当前聊天收到的文本附件，message_id 是收到附件的 QQ 消息 ID。',
        properties: { message_id: str('附件所属的 QQ 消息 ID') }, required: ['message_id'],
        execute: async ({ message_id }) => {
          const chatId = chat.chatId || `${chat.kind}:${chat.kind === 'group' ? chat.groupId : chat.userId}`
          const fence = readFence(), valid = () => fence() && api.config().incomingFiles?.enabled === true
          if (!valid()) return { ok: false, message: '收到的文本文件读取未开启，或聊天范围已变化' }
          const msg = storage.messages.byPlatformId(chatId, String(message_id), 'message', self)
          if (!msg || msg.recalledAt != null || !historyTimeAllowed(storage, self, msg.platformTime)) return { ok: false, message: '找不到当前聊天的附件' }
          const segment = msg.segments?.find(s => s.type === 'file')
          const d = segment?.data || {}, name = String(d.name || d.file_name || '')
          if (!/\.(txt|md|csv|tsv|json|jsonl|log|ini|toml|ya?ml|xml|html?|js|ts|py|java|c|h|cpp|rs|go|sh|sql|conf|properties)$/i.test(name)) return { ok: false, message: '只支持常见文本文件' }
          if (Number(d.size || d.file_size || 0) > 2 * 1024 * 1024) return { ok: false, message: '文件超过 2 MiB' }
          try {
            const fileId = d.file_id || d.id || d.file
            if (!fileId) throw new Error('附件缺少文件编号')
            const info = chat.kind === 'group'
              ? await onebot.call('get_group_file_url', { group_id: Number(chat.groupId), file_id: fileId, busid: d.busid || d.bus_id }, { timeoutMs: 15000 })
              : await onebot.call('get_private_file_url', { user_id: Number(chat.userId), file_id: fileId, file_hash: d.file_hash || d.hash || '' }, { timeoutMs: 15000 })
            const sourceCurrent = () => { const source = storage.messages.get(msg.id); return source && source.account === self && source.chatId === chatId && source.recalledAt == null && historyTimeAllowed(storage, self, source.platformTime) }
            if (!valid() || !sourceCurrent()) throw new Error('附件来源已失效')
            const data = await fetchImage(info?.url || '', { maxBytes: 2 * 1024 * 1024, timeoutMs: 15000, allowLocal: false, signal: api.signal })
            if (!valid() || !sourceCurrent()) throw new Error('附件来源已失效')
            const decoded = decodeIncomingText(data)
            return { ok: true, message: decoded.text, truncated: decoded.truncated, name, sourceMessageId: msg.id }
          } catch (error) { return { ok: false, message: `读取附件失败：${error.message}` } }
        },
      }))
      const searchHistory = defineTool({
        name: 'qq_search_history',
        description: '在已保存的聊天记录中按关键词搜索或回顾，默认当前聊天；只有明确配置后可跨群读取供总结，最多 50 条，默认最近 30 天。',
        properties: { keyword: str('关键词；留空可回顾记录'), target: str('目标聊天，默认当前聊天'), days: int('向前查多少天，最多 90'), count: int('最多返回多少条，最多 50') },
        execute: async ({ keyword, target, days, count }) => {
          const valid = readFence()
          const term = String(keyword || '').trim().slice(0, 100)
          if (!valid()) return { ok: false, message: '聊天权限已变化' }
          const current = chat.chatId || `${chat.kind}:${chat.kind === 'group' ? chat.groupId : chat.userId}`
          const chatId = String(target || current)
          const targetEpoch = storage.epochs?.current(chatId)
          const originalPersona = hub.scopeFor?.(current)?.persona || ''
          const crossAllowed = () => {
            const cfg = api.config(), persona = hub.scopeFor?.(current)?.persona
            if (!valid() || persona !== originalPersona || storage.epochs?.current(chatId) !== targetEpoch) return false
            if (String(cfg.botQQ) !== self || chat.kind !== 'private' || String(chat.userId) !== String(cfg.ownerQQ) || !hub.turnSendersAllOwner(sessionId)) return false
            if (!/^group:\d+$/.test(chatId) || !(cfg.allow?.groups || []).map(String).includes(chatId.slice(6))) return false
            if (!persona || hub.scopeFor?.(chatId)?.persona !== persona) return false
            return (cfg.crossChatHistory || []).some(p => p.enabled === true && String(p.account) === self && p.persona === persona && p.fromChatId === current && p.targetChatId === chatId)
          }
          if (chatId !== current) {
            if (!crossAllowed()) return { ok: false, message: '没有配置跨聊天访问权限' }
            try {
              const member = await onebot.call('get_group_member_info', { group_id: Number(chatId.slice(6)), user_id: Number(api.config().ownerQQ), no_cache: true }, { timeoutMs: 10000 })
              if (String(member?.user_id || '') !== String(api.config().ownerQQ) || (member?.group_id != null && String(member.group_id) !== chatId.slice(6))) throw new Error('member mismatch')
            } catch { return { ok: false, message: '无法确认主人是目标群成员' } }
            if (!crossAllowed()) return { ok: false, message: '访问权限已变化' }
          }
          const since = Date.now() - Math.max(1, Math.min(90, Number(days) || 30)) * 86400000
          const n = Math.floor(Math.max(1, Math.min(50, Number(count) || 20)))
          const rows = storage.db.all(`SELECT id, platform_msg_id, author_name, author_id, text, platform_time, received_at FROM messages
            WHERE account_id=? AND chat_id=? AND recalled_at IS NULL AND COALESCE(platform_time, received_at)>=? AND instr(text, ?)>0
            ORDER BY recv_seq DESC LIMIT ?`, self, chatId, since, term, n)
            .filter(m => historyTimeAllowed(storage, self, m.platform_time))
          if (chatId !== current) {
            const auditKey = 'cross-chat-history:' + self
            const previous = storage.meta.get(auditKey, [])
            storage.meta.set(auditKey, [{ at: Date.now(), fromChat: current, sourceChat: chatId, persona: originalPersona,
              actorId: String(api.config().ownerQQ), requestIds: (hub.turnRequests?.(sessionId) || []).map(r => r.id),
              sourceMessageIds: rows.map(m => m.id), limit: n, partial: rows.length === n }, ...(Array.isArray(previous) ? previous : [])].slice(0, 100))
          }
          return { ok: true, sourceChat: chatId, partial: rows.length === n, limit: n, records: rows.reverse().map(m => ({ id: m.id, platformId: m.platform_msg_id, authorId: m.author_id, at: m.platform_time || m.received_at })), message: rows.length ? clipText(rows.map(m => `[${m.id}${m.platform_msg_id ? ` / QQ ${m.platform_msg_id}` : ''}] ${new Date(m.platform_time || m.received_at).toISOString()} ${m.author_name || m.author_id}：${clipText(m.text, 500)}`).join('\n'), 24000) : '没有找到记录' }
        },
      })
      tools.push(searchHistory, { ...searchHistory, name: 'qq_summarize_history', description: '取得有来源编号的历史摘要素材，由你据此总结并引用证据。默认当前聊天；跨群必须显式共享授权、同人格且主人当前仍在群内。最多50条，结果可能仅覆盖部分记录；不能声称总结了完整群聊。' })
      if (level === 'full') tools.push(defineTool({
        name: 'qq_send_message',
        description: '主动给某个 QQ 好友或群发一条消息（不是回复当前聊天时用）。target 写 private:QQ号 或 group:群号；只能发给白名单里的人和群。',
        properties: { target: str('private:QQ号 或 group:群号'), text: str('要发的话，可以用 ||| 分多条、<voice>…</voice> 发语音、<sticker:名字> 发表情') },
        required: ['target', 'text'],
        execute: async ({ target, text }) => {
          const cfg = api.config()
          if (!hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '只有主人能让我主动发消息' }
          const [kind, id] = String(target || '').split(':')
          const okList = kind === 'group' ? cfg.allow.groups : kind === 'private' ? [cfg.ownerQQ, ...cfg.allow.private] : []
          if (!okList.includes(String(id))) return { ok: false, message: '不在白名单里，不能发' }
          const shouldSend = ownerFence()
          if (!shouldSend()) return { ok: false, status: 'canceled', message: '发送权限已失效' }
          const r = await hub.deliver(`${kind}:${id}`, String(text || ''), { shouldSend, signal: api.signal })
          const missed = [...new Set(r?.missedMentions || [])]
          const status = r?.canceled ? 'canceled' : cfg.dryRun ? 'dryRun' : r?.complete ? 'confirmed' : r?.confirmed ? 'partial' : r?.deliveries?.some(d => d.unknown || d.rows?.some(row => row.state === 'unknown')) ? 'unknown' : r?.deliveries?.some(d => d.rows?.some(row => row.state === 'pending')) ? 'pending' : 'not_sent'
          const message = ({ canceled: '发送已取消', dryRun: '试运行，没有真正发送', confirmed: '发出去了', partial: '部分消息已送达', unknown: '投递结果未知，不能确认已送达', pending: '消息等待投递', not_sent: '消息未送达' })[status]
          return { ok: status === 'confirmed', status, deliveries: r?.deliveries || [], missedMentions: missed, message: message + (missed.length ? `；这些 @ 没对上，只发成了文字：${missed.join('、')}` : '') }
        },
      }))
      if (level === 'full' && api.config().files.enabled) tools.push(defineTool({
        name: 'qq_send_file',
        description: '把文件发到 QQ（不是图片或语音）。主人让你发文件时用。file 写本机绝对路径（只能是 QQ 工作区和面板允许的目录）或 http(s) 网址；不填 target 就发到当前聊天。',
        properties: { file: str('本机绝对路径或网址'), name: str('发到 QQ 上显示的文件名，可不填'), target: str('private:QQ号 或 group:群号，不填发到当前聊天') },
        required: ['file'],
        execute: async ({ file, name, target }) => {
          const cfg = api.config()
          if (!cfg.files.enabled) return { ok: false, message: '发文件没打开' }
          if (!hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '只有主人能让我发文件' }
          const [kind, id] = String(target || chat.chatId).split(':')
          const okList = kind === 'group' ? cfg.allow.groups : kind === 'private' ? [cfg.ownerQQ, ...cfg.allow.private] : []
          if (!okList.includes(String(id))) return { ok: false, message: '不在白名单里，不能发' }
          try {
            const authorized = ownerFence()
            const r = await hub.sendFile(`${kind}:${id}`, file, name, { shouldSend: () => authorized() && api.config().files.enabled })
            return { ok: true, message: r.delivered ? `文件「${r.name}」发出去了` : `试运行：文件「${r.name}」没有真发` }
          } catch (error) {
            return { ok: false, code: error.code, message: error.message }
          }
        },
      }))
      return tools
    })
    api.route?.('/history/accesses', () => ({ ok: true, records: storage.meta.get('cross-chat-history:' + String(api.config().botQQ), []) }))
    return {}
  },
}

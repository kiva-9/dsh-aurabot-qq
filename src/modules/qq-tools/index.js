// 内置模块：基础 QQ 工具。翻聊天记录；主人私聊里还能让她主动给别人发消息。

import { defineTool, str, int } from '../../tools/tools.js'
import { parseMessageEvent } from '../../chat/inbound.js'
import { historyTimeAllowed, historyScopeMatches, platformTimeMs } from '../../chat/history-boundary.js'

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
      const tools = [defineTool({
        name: 'qq_chat_history',
        description: '翻翻当前这个聊天之前的聊天记录（只读，最多 50 条）。想不起前面聊过什么、别人问「刚才谁说的」、要回顾一段对话时用。',
        properties: { count: int('要翻多少条，默认 20，最多 50') },
        execute: async ({ count }) => {
          const n = Math.max(1, Math.min(50, Number(count) || 20))
          if (String(api.config().botQQ) !== self) return { ok: true, message: '没翻到聊天记录' }
          const r = chat.kind === 'group'
            ? await onebot.call('get_group_msg_history', { group_id: Number(chat.groupId), count: n }, { timeoutMs: 15000 })
            : await onebot.call('get_friend_msg_history', { user_id: Number(chat.userId), count: n }, { timeoutMs: 15000 })
          const chatId = chat.chatId || `${chat.kind}:${chat.kind === 'group' ? chat.groupId : chat.userId}`
          const msgs = String(api.config().botQQ) !== self ? [] : (r?.messages || [])
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
      if (level === 'full') tools.push(defineTool({
        name: 'qq_send_message',
        description: '主动给某个 QQ 好友或群发一条消息（不是回复当前聊天时用）。target 写 private:QQ号 或 group:群号；只能发给白名单里的人和群。',
        properties: { target: str('private:QQ号 或 group:群号'), text: str('要发的话，可以用 ||| 分多条、<voice>…</voice> 发语音、<sticker:名字> 发表情') },
        required: ['target', 'text'],
        execute: async ({ target, text }) => {
          const cfg = api.config()
          const [kind, id] = String(target || '').split(':')
          const okList = kind === 'group' ? cfg.allow.groups : kind === 'private' ? [cfg.ownerQQ, ...cfg.allow.private] : []
          if (!okList.includes(String(id))) return { ok: false, message: '不在白名单里，不能发' }
          const r = await hub.deliver(`${kind}:${id}`, String(text || ''))
          const missed = [...new Set(r?.missedMentions || [])]
          return { ok: true, message: '发出去了' + (missed.length ? `；这些 @ 没对上，只发成了文字：${missed.join('、')}` : '') }
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
            const r = await hub.sendFile(`${kind}:${id}`, file, name)
            return { ok: true, message: r.delivered ? `文件「${r.name}」发出去了` : `试运行：文件「${r.name}」没有真发` }
          } catch (error) {
            return { ok: false, code: error.code, message: error.message }
          }
        },
      }))
      return tools
    })
    return {}
  },
}

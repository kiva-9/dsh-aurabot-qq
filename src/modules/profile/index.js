// 内置模块：改资料。听人的话改她自己的 QQ 昵称、个性签名、头像。
// 三个都是 SnowLuma 的扩展动作（不是标准 OneBot v11）：set_qq_profile / set_self_longnick / set_qq_avatar。
// 每个操作单独一档权限（面板「权限」页）：off 关 / owner 仅主人私聊（默认）/ all 所有人。B 站签名在 bili 模块里。

import { defineTool, str } from '../../tools/tools.js'
import { profileToolVisible, profilePermits } from '../../chat/access.js'

const NICK_MAX = 36
const SIGN_MAX = 80

/** 头像来源只收 http(s) 网址或「last」（这个聊天里最近一张图）；本地路径一律不收，免得被人拿去读电脑上的文件。 */
/** 最近媒体里最新一张普通图片的网址（表情不算）。 */
export const lastImageUrl = (media) => media.filter((x) => !x.sticker && /^https?:\/\//i.test(x.seg?.data?.url || '')).at(-1)?.seg.data.url

export function avatarSource(input, lastUrl) {
  const s = String(input || '').trim()
  if (!s || /^(last|刚才|上一张|最近)/i.test(s)) return lastUrl ? { ok: true, file: lastUrl } : { ok: false, message: '这个聊天里还没人发过图' }
  if (/^https?:\/\//i.test(s)) return { ok: true, file: s }
  return { ok: false, message: '头像只能用网址图片，或者刚才发的那张图' }
}

export default {
  id: 'profile',
  name: '改资料',
  version: '1.0.0',
  description: '听人的话改自己的 QQ 昵称（qq_set_nickname）、个性签名（qq_set_signature）、头像（qq_set_avatar）；权限在「权限」页',
  setup(api) {
    const { hub, onebot } = api.core
    // 统一套路：dryRun 只说不做；执行前再按最新配置查一遍权限
    const guarded = (key, chat, sessionId, run) => async (args) => {
      const cfg = api.config()
      const p = profilePermits(cfg, key, chat, hub.turnSendersAllOwner(sessionId))
      if (!p.ok) return p
      return run(args, cfg)
    }

    api.tool(({ chat, sessionId }) => {
      if (chat.kind !== 'private' && chat.kind !== 'group') return []
      const cfg = api.config()
      const tools = []
      if (profileToolVisible(cfg, 'qqNickname', chat)) tools.push(defineTool({
        name: 'qq_set_nickname',
        description: `改你自己的 QQ 昵称（最多 ${NICK_MAX} 字）。有人让你改名时用。`,
        properties: { name: str('新昵称') },
        required: ['name'],
        execute: guarded('qqNickname', chat, sessionId, async ({ name }, c) => {
          const nick = String(name || '').trim()
          if (!nick) return { ok: false, message: '昵称不能是空的' }
          if ([...nick].length > NICK_MAX) return { ok: false, message: `昵称最多 ${NICK_MAX} 个字` }
          if (c.dryRun) return { ok: true, message: `试运行：本来要把 QQ 昵称改成：${nick}` }
          await onebot.call('set_qq_profile', { nickname: nick }, { timeoutMs: 15000 })
          return { ok: true, message: `QQ 昵称改好了：${nick}` }
        }),
      }))
      if (profileToolVisible(cfg, 'qqSignature', chat)) tools.push(defineTool({
        name: 'qq_set_signature',
        description: `改你自己的 QQ 个性签名（最多 ${SIGN_MAX} 字）。有人让你改签名时用。`,
        properties: { text: str('新签名') },
        required: ['text'],
        execute: guarded('qqSignature', chat, sessionId, async ({ text }, c) => {
          const sign = String(text || '').trim()
          if (!sign) return { ok: false, message: '签名不能是空的' }
          if ([...sign].length > SIGN_MAX) return { ok: false, message: `签名最多 ${SIGN_MAX} 个字` }
          if (c.dryRun) return { ok: true, message: `试运行：本来要把 QQ 签名改成：${sign}` }
          await onebot.call('set_self_longnick', { longNick: sign }, { timeoutMs: 15000 })
          return { ok: true, message: `QQ 签名改好了：${sign}` }
        }),
      }))
      if (profileToolVisible(cfg, 'qqAvatar', chat)) tools.push(defineTool({
        name: 'qq_set_avatar',
        description: '换你自己的 QQ 头像。image 填图片网址；填 last 就用这个聊天里刚才别人发的那张图。',
        properties: { image: str('图片网址（http/https），或 last 表示刚才发的那张图') },
        required: ['image'],
        execute: guarded('qqAvatar', chat, sessionId, async ({ image }, c) => {
          const src = avatarSource(image, lastImageUrl(hub.recentMedia(hub.chatOfSession(sessionId) || chat.chatId)))
          if (!src.ok) return src
          if (c.dryRun) return { ok: true, message: `试运行：本来要把 QQ 头像换成：${src.file}` }
          await onebot.call('set_qq_avatar', { file: src.file }, { timeoutMs: 30000 })
          return { ok: true, message: 'QQ 头像换好了' }
        }),
      }))
      return tools
    })
    return {}
  },
}

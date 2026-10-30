// QQ 资料和头像：查机器人自己的资料；把群友自己的头像解析成生图参考。
// 头像地址只由核验过的 QQ 号拼出来，不接受外部网址或本地路径。
import { fetchImage } from '../core/net.js'
import { mimeOf } from '../chat/inbound.js'

const QQ_RE = /^\d{5,12}$/
const AVATAR_MAX_BYTES = 2 * 1024 * 1024
const AVATAR_TIMEOUT_MS = 8000
export const avatarUrl = (qq) => `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=640`

const textField = (data, keys) => {
  for (const key of keys) if (typeof data?.[key] === 'string') return data[key]
  return null // 缺字段和空字符串不同：空签名是没设置，缺字段是没查到
}
const mismatch = () => Object.assign(new Error('网关返回的账号和机器人 QQ 不一致，这份资料不能用'), { code: 'ACCOUNT_MISMATCH' })

export async function downloadAvatar(qq, { fetchAvatar = fetchImage } = {}) {
  const url = avatarUrl(qq)
  const bytes = await fetchAvatar(url, { maxBytes: AVATAR_MAX_BYTES, timeoutMs: AVATAR_TIMEOUT_MS })
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > AVATAR_MAX_BYTES) throw new Error('头像为空或超过 2MB')
  const mime = mimeOf(bytes)
  if (!mime.startsWith('image/')) throw new Error('头像接口没返回图片')
  return { url, bytes, mime }
}

/** 机器人自己的资料（只读）。 */
export function createQqProfile({ getConfig, onebot, ask, fetchAvatar, log }) {
  const botQq = () => {
    const qq = String(getConfig().botQQ || '')
    if (!QQ_RE.test(qq)) throw new Error('还没有配置有效的机器人 QQ 号')
    return qq
  }
  const own = (data, qq) => { if (data?.user_id != null && String(data.user_id) !== qq) throw mismatch(); return data }
  const call = async (action, params, qq) => {
    try { return own(await onebot.call(action, params, { timeoutMs: 8000 }), qq) }
    catch (error) { if (error.code === 'ACCOUNT_MISMATCH') throw error; return null }
  }

  async function read({ viewAvatar = false } = {}) {
    const qq = botQq(), warnings = []
    const info = await call('get_stranger_info', { user_id: Number(qq), no_cache: true }, qq)
    let nickname = textField(info, ['nickname'])
    const raw = textField(info, ['long_nick', 'longNick', 'sign'])
    if (nickname === null) nickname = textField(await call('get_login_info', {}, qq), ['nickname'])
    if (nickname === null) warnings.push('昵称未能获取')
    if (raw === null) warnings.push('个性签名未能获取，不代表没设置')
    let description = null
    if (viewAvatar) {
      try {
        const { bytes, mime } = await downloadAvatar(qq, { fetchAvatar })
        description = String(await ask({ role: 'vision', system: '你在看当前 QQ 头像。用两三句中文客观描述可见的主体、颜色和风格，不确定的不要编。',
          text: '描述这张头像。', images: [{ data: bytes.toString('base64'), mediaType: mime }], maxTokens: 1000, temperature: 0.2 }) || '').trim().slice(0, 1200) || null
        if (!description) warnings.push('视觉模型没有返回头像描述')
      } catch (error) {
        log?.debug?.('看头像失败：', error.message)
        warnings.push('这次没看成头像，只能给地址')
      }
    }
    return { qq, nickname, signature: raw === null ? null : raw.trim(), avatarUrl: avatarUrl(qq), description, warnings }
  }

  return { read, avatar: () => downloadAvatar(botQq(), { fetchAvatar }) }
}

/** 把 QQ 头像变成可用的资产。群友只能用自己的；主人可以指定本群成员；不接受群外的号。 */
export function createAvatarReferences({ hub, onebot, storage, fetchAvatar, log }) {
  const refuse = (message) => ({ ok: false, message })

  async function isMember(groupId, qq) {
    try {
      const info = await onebot.call('get_group_member_info', { group_id: Number(groupId), user_id: Number(qq), no_cache: true }, { timeoutMs: 8000 })
      return info != null && (info.user_id == null || String(info.user_id) === qq)
    } catch (error) {
      log?.debug?.('查群成员失败：', error.message)
      return false
    }
  }

  async function resolve({ chat, sessionId, qq, role = 'identity' }) {
    const who = hub.turnActor(sessionId)
    if (who.error) return refuse(who.error)
    const actor = String(who.actorId), target = String(qq || actor)
    if (!QQ_RE.test(target)) return refuse('QQ 号不对')
    if (target !== actor) {
      if (!hub.turnSendersAllOwner(sessionId)) return refuse('只能用你自己的头像，不能用别人的')
      if (chat.kind !== 'group') return refuse('只能指定当前群里的成员')
    }
    if (chat.kind === 'group' && !await isMember(chat.groupId, target)) return refuse('这个 QQ 不是本群成员，不能用他的头像')
    try {
      const { url, bytes, mime } = await downloadAvatar(target, { fetchAvatar })
      const asset = storage.assets.put(bytes, { mime, sourceKind: 'avatar' })
      return { ok: true, qq: target, assetId: asset.id, role, mime, bytes: bytes.length, url }
    } catch (error) {
      log?.warn?.('头像没拿到：', error.message)
      return refuse('拿不到头像，没法按这个样子画')
    }
  }

  return { resolve }
}

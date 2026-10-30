// 危险终端命令确认（可选保护，默认关）：
// 打开后，主人私聊里她要执行删根目录、格式化、关机、下载后直接执行这类命令时，
// 先发 QQ 问主人；回复「确认」才放行，回复「取消」、超时、发不出确认都拦下。
// 放在 DSH 的 tools/pre-execute：这里返回 deny 工具就不会执行，比提示词可靠。
// 正则挡不住 base64、脚本文件和别名，这不是沙箱，只防手滑和模型误判。

import { redact } from '../core/redact.js'

const CONFIRM_RE = /^(确认|确认执行|同意|允许|执行吧|放行|yes|y|ok)$/i
const CANCEL_RE = /^(取消|取消执行|拒绝|不要|不行|别|停|拦下|no|n)$/i
const SHELL_TOOLS = new Set(['bash', 'pwsh'])
const DEFAULT_TIMEOUT_MS = 60_000

// 宁少勿多：只收真正致命的那几类，别把日常命令拦了。
const ROOT_TARGET = String.raw`(?:\/\*?|~\/?\*?|\$HOME\/?\*?|[a-zA-Z]:[\\\/]?\*?)`
const DANGER_RULES = [
  { label: '递归删除根目录或盘符', re: new RegExp(String.raw`\brm\s+(?:-[a-z]*(?:r[a-z]*f|f[a-z]*r)[a-z]*|-[a-z]*r[a-z]*\s+-[a-z]*f[a-z]*|-[a-z]*f[a-z]*\s+-[a-z]*r[a-z]*|--recursive\s+--force|--force\s+--recursive)(?:\s+--no-preserve-root)?\s+["']?${ROOT_TARGET}["']?(?:\s|$|;|&)`, 'i') },
  { label: '递归删除根目录或盘符', re: /\bRemove-Item\b(?=[^\n]*\s-(?:Recurse|r)\b)[^\n]*\s["']?(?:[a-zA-Z]:[\\/]?\*?|\/|~)["']?(?:\s|$)/i },
  { label: '递归删除盘符', re: /\b(?:del|erase)\s+(?:\/[a-z]+\s+)*[a-zA-Z]:[\\/]?\*?(?:\s|$)/i },
  { label: '递归删除盘符', re: /\b(?:rd|rmdir)\s+\/s\b[^\n]*\s[a-zA-Z]:[\\/]?(?:\s|$)/i },
  { label: '清空磁盘或分区', re: /\b(?:mkfs(?:\.\w+)?|mke2fs|fdisk|parted|diskpart|wipefs)\b/i },
  { label: '格式化磁盘', re: /\bformat(?:\.com)?\s+[a-zA-Z]:/i },
  { label: '关闭或重启电脑', re: /(?:^|[;&|]\s*|\bsudo\s+)(?:shutdown|reboot|halt|poweroff|Stop-Computer|Restart-Computer)(?:\s|$|;|&)/im },
  { label: '下载后直接执行', re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|k|da)?sh\b/i },
  { label: '下载后直接执行', re: /\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n|]*\|\s*(?:iex|Invoke-Expression)\b/i },
  { label: '删除卷影副本或引导配置', re: /\b(?:vssadmin\s+delete\s+shadows|bcdedit|wbadmin\s+delete)\b/i },
  { label: '改注册表系统项', re: /\breg(?:\.exe)?\s+(?:add|delete)\s+(?:HKLM|HKEY_LOCAL_MACHINE)\b/i },
  { label: '直接写磁盘', re: /\bdd\s+[^\n]*\bof=\/dev\/|>\s*\/dev\/(?:sd|nvme|disk|hd)/i },
  { label: '改账户或管理员组', re: /\bnet\s+(?:user\s+\S+\s+\S+\s+\/add|localgroup\s+\S+\s+\S+\s+\/add)\b/i },
  { label: '夺取系统目录权限', re: /\b(?:takeown|icacls)\b[^\n]*(?:[a-zA-Z]:\\Windows|[a-zA-Z]:\\Program Files)/i },
  { label: '放开根目录权限', re: /\bchmod\s+-R\s+0?777\s+\/(?:\s|$)/i },
  { label: 'fork 炸弹', re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}/ },
]

/** 命中返回中文规则标签，没命中返回 ''。 */
export function isDangerousCommand(command) {
  const text = String(command ?? '')
  return DANGER_RULES.find(rule => rule.re.test(text))?.label || ''
}

const clip = (text, max) => (text.length > max ? text.slice(0, max) + '…' : text)

/**
 * @param {object} o
 * @param {() => object} o.getConfig 每次都读最新配置
 * @param {(chatId: string, text: string) => Promise<{delivered?: number}>} o.deliver 发确认消息；delivered 为 0 视为没发出去
 * @param {(sessionId: string) => string} o.chatOfSession DSH 会话对应的 QQ 聊天
 */
export function createDangerGuard({ getConfig, deliver, chatOfSession, timeoutMs = DEFAULT_TIMEOUT_MS, log, now = Date.now }) {
  const pending = new Map() // chatId → { resolve, startedAt }
  const ownerChat = () => { const owner = String(getConfig()?.ownerQQ || ''); return owner ? `private:${owner}` : '' }
  const settle = (chatId, approved) => {
    const waiting = pending.get(chatId)
    if (!waiting) return false
    pending.delete(chatId)
    waiting.resolve(approved)
    return true
  }

  /** 问主人；任何一步不成就算不同意。 */
  function ask(chatId, label, command, signal) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(chatId, false), timeoutMs)
      const onAbort = () => settle(chatId, false)
      signal?.addEventListener('abort', onAbort, { once: true })
      pending.set(chatId, { startedAt: now(), resolve: (approved) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(approved)
      } })
      if (signal?.aborted) return onAbort()
      const seconds = Math.max(1, Math.round(timeoutMs / 1000))
      Promise.resolve().then(() => deliver(chatId, `⚠️ 危险命令确认（${label}）\n${clip(command, 260)}\n回复「确认」执行，回复「取消」拦下；${seconds} 秒内没回也会拦下。`))
        .then((sent) => { if (!sent?.delivered) { log?.warn?.('危险命令确认没发出去，已拦下'); settle(chatId, false) } },
          (error) => { log?.warn?.('危险命令确认没发出去：', error.message); settle(chatId, false) })
    })
  }

  async function preExecute(exec, next) {
    if (getConfig()?.security?.dangerConfirm !== true || !SHELL_TOOLS.has(exec?.name)) return next()
    const command = String(exec.arguments?.command ?? '')
    const label = isDangerousCommand(command)
    if (!label) return next()
    // 主人自己开的 DSH 会话不归这里管，走 DSH 自己的权限设置
    const chatId = String(chatOfSession(exec.agent?.session?.id) || '')
    if (!chatId) return next()
    const logged = redact(clip(command, 120))
    if (chatId !== ownerChat()) {
      log?.warn?.(`拦下了 ${chatId} 的危险命令（${label}）：${logged}`)
      return { kind: 'deny', reason: `这条命令被安全策略拦下了（${label}）：只有主人私聊里、经主人确认才能执行。` }
    }
    if (pending.has(chatId)) return { kind: 'deny', reason: `上一条危险命令还在等主人确认，这条（${label}）先不执行。` }
    const approved = await ask(chatId, label, command, exec.signal)
    log?.info?.(`危险命令（${label}）${approved ? '主人确认执行' : '没有确认，已拦下'}：${logged}`)
    if (approved) return next()
    return { kind: 'deny', reason: `危险命令被拦下了（${label}）：主人没有回复「确认」。可以换个安全的做法，或者告诉主人你要做什么。` }
  }

  /** 主人的确认 / 取消：返回 true 表示这条消息被消费了，不再交给她。 */
  function handleReply(chatId, userId, text, { at = Infinity } = {}) {
    const key = String(chatId || '')
    const waiting = pending.get(key)
    if (!waiting || key !== ownerChat() || key !== `private:${userId}`) return false
    // 网关重连会重放旧消息：问之前说的「确认」不算数（QQ 时间只精确到秒）
    if (at < Math.floor(waiting.startedAt / 1000) * 1000) return false
    const reply = String(text || '').trim()
    if (CONFIRM_RE.test(reply)) return settle(key, true)
    if (CANCEL_RE.test(reply)) return settle(key, false)
    return false
  }

  return {
    preExecute,
    handleReply,
    /** 插件卸载：还在等的一律拦下，工具链不能挂着。 */
    dispose: () => { for (const chatId of [...pending.keys()]) settle(chatId, false) },
    get pendingCount() { return pending.size },
  }
}

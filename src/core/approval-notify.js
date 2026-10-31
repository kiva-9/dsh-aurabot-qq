import { createHash } from 'node:crypto'
import { cleanText, clipText } from './text.js'
import { redact } from './redact.js'

/** Notify only mapped QQ sessions. The host UI remains the approval authority. */
export function createApprovalNotifier({ getConfig, hub, now = Date.now, log }) {
  const seen = new Map()
  let disposed = false
  async function notify(session, event) {
    const cfg = getConfig()
    if (disposed || event?.type !== 'approval/asked' || cfg.approvalNotify !== true || !cfg.enabled || cfg.dryRun) return { ignored: true }
    const id = String(event.data?.id || ''), sid = String(session?.id || '')
    const sourceChat = hub.chatOfSession(sid)
    if (!id || !sid || !/^(private|group):\d+$/.test(sourceChat)) return { ignored: true }
    const account = String(cfg.botQQ), owner = String(cfg.ownerQQ)
    if (!/^\d+$/.test(account) || !/^\d+$/.test(owner)) return { ignored: true }
    const key = createHash('sha256').update(JSON.stringify([account, sid, id])).digest('hex')
    for (const [k, at] of seen) if (now() - at > 6 * 3600_000) seen.delete(k)
    if (seen.has(key)) return { duplicate: true }
    seen.set(key, now())
    while (seen.size > 256) seen.delete(seen.keys().next().value)
    const current = () => {
      const c = getConfig()
      return !disposed && c.enabled && !c.dryRun && c.approvalNotify === true && String(c.botQQ) === account && String(c.ownerQQ) === owner && hub.chatOfSession(sid) === sourceChat
    }
    const label = v => clipText(cleanText(redact(String(v || ''))), 180)
    const text = ['【需要在 DSH 中批准】' + label(event.data.toolName || '工具操作'),
      event.data.reason ? '原因：' + label(event.data.reason) : '',
      '来源：' + sourceChat,
      '请在 DSH 界面查看并批准；QQ 回复不能代替宿主批准。'].filter(Boolean).join('\n')
    try {
      if (!current()) return { ignored: true }
      return await hub.sendText('private:' + owner, text, undefined, { batchId: 'approval:' + key, shouldSend: current })
    } catch (error) {
      log?.warn?.('审批通知未确认送达：', error.message)
      return { ok: false, unknown: true }
    }
  }
  return { notify, dispose() { disposed = true; seen.clear() } }
}

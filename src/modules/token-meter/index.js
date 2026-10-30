// 内置模块：Token 计量器。只读汇总 service_calls，回答「今天用了多少 Token」；不算钱。
import { defineTool, str } from '../../tools/tools.js'
import { RANGES, rangeWindow } from '../../diagnostics/usage.js'

const BREAKDOWNS = ['none', 'day', 'model', 'role']
const RANGE_LABEL = { today: '今天', '7d': '近 7 天', '30d': '近 30 天', all: '全部历史' }
const count = (n) => n.toLocaleString('en-US')
const line = (x) => `输入 ${count(x.inputTokens)} · 输出 ${count(x.outputTokens)} · 缓存 ${count(x.cachedTokens)} · 合计 ${count(x.totalTokens)} tokens`

function render(result, where) {
  if (!result.totals.calls) return `${where} · ${RANGE_LABEL[result.range]}：还没有可统计的模型调用记录。`
  const coverage = `覆盖 ${count(result.totals.calls)} 次调用` + (result.totals.incompleteCalls ? `；其中 ${count(result.totals.incompleteCalls)} 次没有返回完整用量，缺失字段未计入合计。` : '。')
  return [`${where} · ${RANGE_LABEL[result.range]}`, line(result.totals), coverage, ...result.buckets.map((b) => `${b.key}：${line(b)}`)].join('\n')
}

export default {
  id: 'token-meter',
  name: 'Token 计量器',
  version: '1.0.0',
  description: '按当前聊天或账号统计今天、近 7 天、近 30 天和历史的 Token 用量（qq_token_usage）；只统计用量，不算钱',
  files: ['diagnostics/usage.js'],
  setup(api) {
    const { hub, usage, http } = api.core

    /** 给其他模块和面板用：range 为 today / 7d / 30d / all，不传 chatId 就是整个账号。 */
    function summary({ range = 'today', chatId, groupBy = 'none', now = Date.now() } = {}) {
      const { from, to } = rangeWindow(range, now)
      return usage.aggregate({ chatId, from, to, groupBy, range })
    }

    const inAllowList = (chatId, cfg) => {
      const [kind, id] = String(chatId).split(':')
      return (kind === 'group' ? cfg.allow.groups : kind === 'private' ? [cfg.ownerQQ, ...cfg.allow.private] : []).includes(id)
    }

    api.tool(({ chat, sessionId }) => (chat.kind === 'system' ? [] : [defineTool({
      name: 'qq_token_usage',
      description: '查机器人的 Token 用量（只有用量，没有费用）。有人问今天或这周用了多少 Token 时用。群友只能查当前聊天；全账号或别的聊天只有主人能查。',
      properties: {
        scope: { type: 'string', enum: ['chat', 'account'], description: 'chat 当前聊天（默认）；account 整个机器人账号' },
        range: { type: 'string', enum: RANGES, description: '默认 today' },
        breakdown: { type: 'string', enum: BREAKDOWNS, description: '按天 / 模型 / 角色分开列，默认不分' },
        chat_id: str('可选，主人查别的聊天：private:QQ号 或 group:群号'),
      },
      execute: async ({ scope = 'chat', range = 'today', breakdown = 'none', chat_id: other }) => {
        if (!RANGES.includes(range) || !BREAKDOWNS.includes(breakdown) || !['chat', 'account'].includes(scope)) return { ok: false, message: '参数不对' }
        const owner = hub.turnSendersAllOwner(sessionId)
        if (scope === 'account') {
          if (!owner) return { ok: false, message: '整个账号的用量只有主人能查' }
          return { ok: true, message: render(summary({ range, groupBy: breakdown }), '整个账号') }
        }
        const target = String(other || chat.chatId)
        if (target !== chat.chatId && !(owner && inAllowList(target, api.config()))) return { ok: false, message: '只能查当前聊天；主人才能查白名单里别的聊天' }
        return { ok: true, message: render(summary({ range, chatId: target, groupBy: breakdown }), target === chat.chatId ? '当前聊天' : target) }
      },
    })]))

    api.route('/token-meter/summary', (req) => {
      const q = http.query(req)
      const range = q.range || 'today', groupBy = q.groupBy || 'none'
      if (!RANGES.includes(range) || ![...BREAKDOWNS, 'provider'].includes(groupBy)) return { ok: false, message: 'range 或 groupBy 不对' }
      return { ok: true, ...summary({ range, chatId: q.chatId || undefined, groupBy }) }
    })

    return { summary }
  },
}

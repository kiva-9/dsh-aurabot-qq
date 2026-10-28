import { scopeOf, fail } from './contracts.js'

export function identityFor(api, scope) {
  const hub = api.core.hub
  const identity = hub?.personaFor?.(scope.chat) || api.core.personas?.service?.snapshotFor?.(scope.chat)
  if (!identity || identity.error) return null
  const account = String(hub?.scopeFor?.(scope.chat, { persona: true })?.account || api.config().botQQ || hub?.selfId || '')
  return { ...identity, account }
}
export function hookScope(api, args = {}) {
  const chatId = args.msg?.chatId || args.chat?.chatId || args.chatId
  if (!chatId || String(chatId).startsWith('system:')) fail('SCOPE_REQUIRED', '事件缺少普通聊天 chatId')
  const identity = identityFor(api, { chat: chatId })
  const scope = scopeOf(api.core.hub?.scopeFor?.(chatId, { persona: true }) || { account: identity?.account, chat: chatId, persona: identity?.personaId })
  if (!identity || identity.personaId !== scope.persona || identity.account !== scope.account || scope.chat !== chatId) fail('STALE_IDENTITY', '当前聊天的范围和人设不一致')
  if (args.scope && JSON.stringify(scopeOf(args.scope)) !== JSON.stringify(scope)) fail('STALE_IDENTITY', '事件范围已失效')
  const account = args.msg?.account || args.account || args.chat?.account
  const persona = args.personaId || args.persona?.personaId
  if (account && String(account) !== scope.account) fail('STALE_IDENTITY', '事件账号已改变')
  if (persona && String(persona) !== scope.persona) fail('STALE_IDENTITY', '事件人设已改变')
  if (args.sessionId && api.core.hub?.chatOfSession && api.core.hub.chatOfSession(args.sessionId) !== chatId) fail('STALE_IDENTITY', '事件会话与聊天不一致')
  return scope
}
export function panelScope(api, input) {
  const scope = scopeOf(input), account = String(api.config().botQQ || api.core.hub?.selfId || '')
  if (!account || scope.account !== account) fail('SCOPE_FORBIDDEN', '面板只能操作当前账号的范围')
  return scope
}
export function registerRoute(api, path, method, handler) {
  api.route(path, async (req) => {
    try {
      if (req.method !== method) fail('METHOD_NOT_ALLOWED', `此接口只接受 ${method}`)
      const input = method === 'GET' ? api.core.http.query(req) : await api.core.http.body(req)
      const scope = panelScope(api, input)
      return await handler(input, scope)
    } catch (error) { return { ok: false, code: error.code || 'MODULE_ERROR', message: error.message } }
  })
}

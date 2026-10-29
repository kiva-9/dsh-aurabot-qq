// A social agent owns its QQ capabilities; it must not inherit desktop tools.
export const SOCIAL_SCOPE_VERSION = 3
export function installSocialScope(agent, names, active = () => true) {
  const tools = agent?.ctx?.tools, prompt = agent?.ctx?.systemPrompt
  if (typeof tools?.restrict !== 'function' || typeof tools?.guard !== 'function' || typeof tools?.presentAs !== 'function' || typeof agent?.ctx?.on !== 'function' || typeof prompt?.suppressRuntimeContext !== 'function') {
    throw Object.assign(new Error('宿主缺少群会话工具和上下文隔离能力，已停止本轮；请更新 DSH'), { code: 'SOCIAL_SCOPE_UNAVAILABLE' })
  }
  const allow = new Set(names), cleanups = []
  try {
    cleanups.push(tools.restrict({ allow: [] }))
    cleanups.push(tools.presentAs('native'))
    // restrict() intentionally exempts tools registered on this agent itself.
    // The host also adds local team tools, so filter the final model schemas.
    // Keep the execution guard: hiding a schema is not an authorization check.
    cleanups.push(agent.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembled = await next()
      if (context.scope?.id !== agent.id) return assembled
      return { ...assembled, tools: assembled.tools.filter(tool => allow.has(tool.name)) }
    }))
    cleanups.push(tools.guard(exec => !allow.has(exec.name) ? '当前 QQ 会话不允许这个工具' : !active() ? '当前 QQ 会话已停用' : undefined))
    cleanups.push(prompt.suppressRuntimeContext())
    return () => { for (const off of cleanups.reverse()) off?.() }
  } catch (error) {
    for (const off of cleanups.reverse()) { try { off?.() } catch {} }
    throw error
  }
}

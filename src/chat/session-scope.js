// A social agent owns its QQ capabilities; it must not inherit desktop tools.
export const SOCIAL_SCOPE_VERSION = 4
const RUNTIME_FILTER = Symbol.for('aurabot.social-runtime-context.v4')
const unavailable = () => Object.assign(new Error('宿主缺少群会话工具和上下文隔离能力，已停止本轮；请更新 DSH'), { code: 'SOCIAL_SCOPE_UNAVAILABLE' })

function socialContext(assembly) {
  if (!Array.isArray(assembly?.contexts)) throw unavailable()
  return { ...assembly, contexts: assembly.contexts.filter(entry => entry.name === 'aurabot-context') }
}

function isolateRuntimeContext(prompt, agent) {
  // DSH 0.2.1-rc.3 refreshContext() restores required registrations AFTER the
  // assembly waterfall, on every request/retry. There is no refresh waterfall.
  // Adapt that public method on this service instance, not its prototype or
  // provider registry. Cordis service views share own property descriptors but
  // return traced function proxies on normal reads; retain the raw descriptor
  // so the original method keeps the caller's `this`/scope on every invocation.
  let owner = prompt, descriptor
  while (owner && !(descriptor = Object.getOwnPropertyDescriptor(owner, 'refreshContext'))) owner = Object.getPrototypeOf(owner)
  if (typeof descriptor?.value !== 'function') throw unavailable()
  let state = descriptor.value[RUNTIME_FILTER]
  if (!state) {
    const original = descriptor.value, own = Object.getOwnPropertyDescriptor(prompt, 'refreshContext')
    state = { scopes: new Map(), users: 0 }
    const refresh = function (assembly, context, ...rest) {
      const result = Reflect.apply(original, this, [assembly, context, ...rest])
      return state.scopes.has(context?.scope) ? socialContext(result) : result
    }
    Object.defineProperty(refresh, RUNTIME_FILTER, { value: state })
    try { Object.defineProperty(prompt, 'refreshContext', { configurable: true, writable: true, value: refresh }) }
    catch { throw unavailable() }
    state.restore = () => {
      // Do not undo another plugin's later method replacement.
      if (Object.getOwnPropertyDescriptor(prompt, 'refreshContext')?.value !== refresh) return
      if (own) Object.defineProperty(prompt, 'refreshContext', own)
      else delete prompt.refreshContext
    }
  }
  state.scopes.set(agent, (state.scopes.get(agent) || 0) + 1)
  state.users++
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    const remaining = state.scopes.get(agent) - 1
    if (remaining) state.scopes.set(agent, remaining)
    else state.scopes.delete(agent)
    if (--state.users === 0) state.restore()
  }
}

export function installSocialScope(agent, names, active = () => true) {
  const tools = agent?.ctx?.tools, prompt = agent?.ctx?.systemPrompt
  if (typeof tools?.restrict !== 'function' || typeof tools?.guard !== 'function' || typeof tools?.presentAs !== 'function' || typeof agent?.ctx?.on !== 'function' || typeof prompt?.suppressRuntimeContext !== 'function' || typeof prompt?.refreshContext !== 'function') {
    throw unavailable()
  }
  const allow = new Set(names), cleanups = []
  try {
    cleanups.push(isolateRuntimeContext(prompt, agent))
    cleanups.push(tools.restrict({ allow: [] }))
    cleanups.push(tools.presentAs('native'))
    // restrict() intentionally exempts tools registered on this agent itself.
    // The host also adds local team tools, so filter the final model schemas.
    // Keep the execution guard: hiding a schema is not an authorization check.
    cleanups.push(agent.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembled = await next()
      if (context.scope !== agent) return assembled
      return { ...socialContext(assembled), tools: assembled.tools.filter(tool => allow.has(tool.name)) }
    }))
    cleanups.push(tools.guard(exec => !allow.has(exec.name) ? '当前 QQ 会话不允许这个工具' : !active() ? '当前 QQ 会话已停用' : undefined))
    cleanups.push(prompt.suppressRuntimeContext())
    return () => { for (const off of cleanups.splice(0).reverse()) off?.() }
  } catch (error) {
    for (const off of cleanups.reverse()) { try { off?.() } catch {} }
    throw error
  }
}

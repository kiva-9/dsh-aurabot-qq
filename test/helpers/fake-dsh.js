// 测试用的假 DSH 宿主：只实现 Aurabot 用到的那几样服务。
// 「模型」是个脚本：按用户消息内容决定回什么、调不调工具，用来验证插件的整条链路。

import { randomUUID } from 'node:crypto'

export function createFakeDsh({ brain }) {
  const disposers = []
  const listeners = new Map()
  const routes = new Map()
  const variables = new Map()
  const agents = new Map()
  const workspaces = []
  const turns = [] // 记录每一轮：{ sessionId, preset, userText, images, reply, toolCalls }
  const logs = []

  const emit = (name, ...args) => { for (const fn of listeners.get(name) || []) fn(...args) }

  function makeAgent(sessionId, preset) {
    const tools = new Map()
    const contexts = new Map()
    const sections = new Map()
    const scopedListeners = new Map()
    const events = []
    let turn = 0
    let chain = Promise.resolve()
    let canceled = null // 当前这一轮被取消的原因（和 DSH 一样：截断这一轮，turn/end 记 aborted）
    const session = {
      id: sessionId,
      append: (type, data) => events.push({ type, data }),
    }
    const agent = {
      id: sessionId,
      preset,
      session,
      tools,
      contexts,
      sections,
      events,
      status: 'idle',
      injected: [],
      cancels: [],
      denied: new Set(),
      restrictions: new Set(), guards: new Set(), runtimeSuppressed: false,
      ctx: {
        on(name, fn) {
          if (!scopedListeners.has(name)) scopedListeners.set(name, new Set())
          scopedListeners.get(name).add(fn)
          return () => scopedListeners.get(name).delete(fn)
        },
        tools: {
          presentAs: mode => { agent.toolMode = mode; return () => { delete agent.toolMode } },
          register: (t) => { tools.set(t.name, t); return () => tools.delete(t.name) },
          restrict: (filter) => { agent.restrictions.add(filter);for (const n of filter.deny || []) agent.denied.add(n);return () => {agent.restrictions.delete(filter);for(const n of filter.deny || [])agent.denied.delete(n)} },
          guard: (check) => {agent.guards.add(check);return ()=>agent.guards.delete(check)},
        },
        systemPrompt: {
          context: (c) => { contexts.set(c.name, c); return () => contexts.delete(c.name) },
          section: (s) => { sections.set(s.name, s); return () => sections.delete(s.name) },
          suppressRuntimeContext: () => {agent.runtimeSuppressed=true;return ()=>{agent.runtimeSuppressed=false}},
        },
      },
      steered: [],
      inject(msg) { agent.injected.push(msg) },
      cancel(cause) {
        agent.cancels.push(cause)
        if (agent.status === 'running') canceled = cause
      },
      // 假的 steer：记下来，并当作下一步输入（这里简化成排在当前这一轮之后再跑一轮）
      steer(msg) {
        agent.steered.push(msg)
        return agent.followup(msg)
      },
      followup(msg) {
        chain = chain.then(async () => {
          turn++
          const myTurn = turn
          agent.status = 'running'
          canceled = null
          const text = msg.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
          const images = msg.content.filter((c) => c.type === 'image')
          const ctxText = [...contexts.values()].filter(c=>!agent.runtimeSuppressed||c.required).map((c) => c.text()).filter(Boolean).join('\n')
          const persona = sections.get('deployment:persona-prefix')?.text?.() ?? variables.get('aurabot_persona')?.({ agent }) ?? ''
          const calls = []
          const visible = new Map([...globalTools].filter(([name])=>[...agent.restrictions].every(f=>(!f.allow||f.allow.includes(name))&&!f.deny?.includes(name))))
          for(const [name,tool] of tools)visible.set(name,tool)
          const assembly = { tools: [...visible.values()] }
          const assemblers = [...scopedListeners.get('system-prompt/assemble') || []]
          const next = () => (assemblers.shift() || (() => assembly))(assembly, { scope: agent }, next)
          const presented = await next()
          const callTool = async (name, args) => {
            const t = visible.get(name)
            if (!t) { calls.push({ name, args, result: { ok: false, message: 'no such tool' } }); return null }
            const denied=[...agent.guards].map(fn=>fn({name,agent})).find(Boolean)
            if(denied){const result={ok:false,message:denied};calls.push({name,args,result});return result}
            const result = await t.execute(args, { agent })
            calls.push({ name, args, result })
            return result
          }
          const reply = await brain({ preset, text, images, ctxText, persona, callTool, toolNames: presented.tools.map(tool => tool.name), agent })
          agent.status = 'idle'
          if (canceled) {
            turns.push({ sessionId, preset, userText: text, images: images.length, reply, toolCalls: calls, ctxText, aborted: true })
            emit('session/event', session, { type: 'assistant/message', data: { turn: myTurn, interrupted: true, message: { content: [{ type: 'text', text: reply }] } } })
            emit('session/event', session, { type: 'turn/end', data: { turn: myTurn, reason: { kind: 'aborted', reason: canceled } } })
            canceled = null
            return
          }
          turns.push({ sessionId, preset, userText: text, images: images.length, reply, toolCalls: calls, ctxText })
          emit('session/event', session, { type: 'assistant/message', data: { turn: myTurn, message: { content: [{ type: 'text', text: reply }] } } })
          emit('session/event', session, { type: 'turn/end', data: { turn: myTurn, reason: { kind: 'completed' } } })
        })
        return chain
      },
    }
    return agent
  }

  const globalTools = new Map() // 全局工具（DSH 所有会话都能看到）
  const provided = new Map() // ctx.provide 登记的服务
  const ctx = {
    globalTools,
    tools: { register: (t) => { if (globalTools.has(t.name)) throw new Error('dup ' + t.name); globalTools.set(t.name, t); return () => globalTools.delete(t.name) } },
    provide(name, value) { provided.set(name, value); disposers.push(() => provided.delete(name)) },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
    },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(fn)
      return () => listeners.get(name).delete(fn)
    },
    interval(fn, ms) {
      const t = setInterval(fn, ms)
      return () => clearInterval(t)
    },
    systemPrompt: { variable: (n, fn) => { variables.set(n, fn); return () => variables.delete(n) } },
    webServer: { register: (r) => { routes.set(r.path, r); return () => routes.delete(r.path) } },
    workspaceRegistry: {
      archivedSessionIds: [],
      archiveSession(id) { this.archivedSessionIds.push(id) },
      list: () => workspaces,
      async create(path, title) {
        const w = { id: randomUUID(), path, title, sessionIds: [] }
        workspaces.push(w)
        return w
      },
    },
    agents: { get: (id) => agents.get(id) },
    attachments: {
      async admitPromptContent(content) {
        return content.map((c) => (c.type === 'image' ? { type: 'image', attachment: { attachmentId: randomUUID() }, mediaType: c.mediaType } : c))
      },
    },
    llm: {
      listProviders: () => ['fake'],
      async listModels() { return ['fake-1', 'm-pdef', 'm-gdef', 'm-owner', 'm-g777'].map((id) => ({ id, name: id })) },
      async *stream() {
        yield { type: 'text-delta', text: '可爱的小鲸鱼 #开心 #卖萌' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    services: {
      sessionController: {
        async create({ workspaceId, agentPreset }) {
          const id = randomUUID()
          agents.set(id, makeAgent(id, agentPreset))
          workspaces.find((w) => w.id === workspaceId)?.sessionIds.push(id)
          return { sessionId: id, agentPreset }
        },
        async rename() { return {} },
        async cancel({ sessionId }) { agents.get(sessionId)?.cancel({ kind: 'user' }, { keepInbox: true }) },
        async resolveAgent(id) {
          const a = agents.get(id)
          return a ? { agent: a } : { error: { code: 'session/not-found', message: 'not found' } }
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake-1' }) },
    },
    get(name) {
      return this.services[name] ?? provided.get(name) ?? this[name]
    },
  }

  async function call(path, body, headers = {}) {
    const full = '/aurabot/api' + path.split('?')[0]
    // 先精确匹配，再找最长的前缀路由（和 DSH 的网页服务一样）
    const r = routes.get(full) || [...routes.values()].filter((x) => x.kind === 'prefix' && (full === x.path || full.startsWith(x.path + '/'))).sort((a, b) => b.path.length - a.path.length)[0]
    if (!r) throw new Error('no route ' + path)
    let out = ''
    let status = 200
    const responseHeaders = {}
    const req = {
      method: body === undefined ? 'GET' : 'POST',
      url: '/aurabot/api' + path,
      headers,
      async *[Symbol.asyncIterator]() { if (body) yield JSON.stringify(body) },
    }
    const res = { set statusCode(v) { status = v }, setHeader(k, v) { responseHeaders[k.toLowerCase()] = v }, end(s) { out = s } }
    await r.handler(req, res)
    return { status, headers: responseHeaders, raw: () => out, json: () => JSON.parse(out) }
  }

  return { ctx, routes, variables, agents, workspaces, turns, logs, call, dispose: () => Promise.allSettled(disposers.splice(0).reverse().map((d) => { try { return d() } catch (e) { return Promise.reject(e) } })) }
}

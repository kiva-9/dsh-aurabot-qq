import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { installSocialScope, SOCIAL_SCOPE_VERSION } from '../src/chat/session-scope.js'

// The optional native probe reads installed DSH modules in Electron's Node mode.
// It starts no host/profile, persists no session, and replaces transport with a
// throwing capture: neither QQ nor an LLM/network adapter can be reached.
const nativeRoot = process.env.AURABOT_NATIVE_HOST_ROOT
const nativeRequire = nativeRoot ? createRequire(join(nativeRoot, 'package.json')) : null
const nativePrompt = nativeRequire?.('@deepseek-ai/dsh-system-prompt')
const nativeCordis = nativeRequire?.('@deepseek-ai/cordis')

class ContractPrompt {
  refreshContext(assembly, context = {}) {
    const providers = this.layers.merge(context.scope)
    const suppressed = this.layers.chainLayers(context.scope).some(layer => !layer.runtimeContextSuppressors.isEmpty())
    const required = new Map([...providers].filter(([, entry]) => entry.required === true))
    const resolve = entry => ({ name: entry.name, text: typeof entry.text === 'function' ? entry.text(context) : entry.text })
    const contexts = []
    for (const accepted of assembly.contexts) {
      const provider = providers.get(accepted.name)
      required.delete(accepted.name)
      if (suppressed && provider?.required !== true) continue
      contexts.push(provider ? resolve(provider) : accepted)
    }
    for (const provider of required.values()) contexts.push(resolve(provider))
    return { ...assembly, contexts }
  }
}

function fixture(native = false) {
  const globals = new Map([
    ['working-directory:current', { name: 'working-directory:current', order: 100, required: true, text: 'WORKDIR_SENTINEL' }],
    ['desktop:optional', { name: 'desktop:optional', order: 200, text: 'OPTIONAL_SENTINEL' }],
  ])
  const locals = new Map(), hooks = new Map(), suppressed = new Set()
  const ctx = { reflect: { props: {}, provide() {} }, effect: () => () => {}, emit() {}, extend(props) { return Object.assign(Object.create(this), props) } }
  const prompt = native ? new nativePrompt.SystemPrompt(ctx, { includeHarnessIdentity: false }) : new ContractPrompt()
  prompt.layers = {
    global: { runtimeContextSuppressors: { isEmpty: () => true } },
    merge: scope => new Map([...globals, ...locals.get(scope) || []]),
    chainLayers: scope => [{ runtimeContextSuppressors: { isEmpty: () => !suppressed.has(scope) } }],
  }
  prompt.suppressRuntimeContext = function () {
    const scope = this.ctx.scopeKey
    suppressed.add(scope)
    return () => suppressed.delete(scope)
  }
  const viewFor = scope => {
    const scoped = ctx.extend({ scopeKey: scope })
    return native ? nativeCordis.getTraceable(scoped, prompt) : new Proxy(prompt, {
      get: (target, key, receiver) => key === 'ctx' ? scoped : Reflect.get(target, key, receiver),
    })
  }
  const agentFor = (id, text = 'AURABOT_SENTINEL') => {
    const agent = { id }, effects = { restrict: [], guard: [], mode: [] }
    locals.set(agent, new Map([
      ['team:identity', { name: 'team:identity', order: 125, required: true, text: 'TEAM_LEAD_SENTINEL list_agents send_message' }],
      ['aurabot-context', { name: 'aurabot-context', order: 905, required: true, text: () => text }],
    ]))
    hooks.set(agent, [])
    const effect = key => value => { effects[key].push(value); return () => effects[key].splice(effects[key].indexOf(value), 1) }
    agent.ctx = {
      systemPrompt: viewFor(agent),
      tools: { restrict: effect('restrict'), guard: effect('guard'), presentAs: effect('mode') },
      on(name, fn) {
        assert.equal(name, 'system-prompt/assemble')
        hooks.get(agent).push(fn)
        return () => hooks.get(agent).splice(hooks.get(agent).indexOf(fn), 1)
      },
    }
    return { agent, effects, setText: value => { text = value } }
  }
  const assemble = async agent => {
    const assembly = {
      sections: [{ name: 'persona', text: 'QQ persona' }], variables: {},
      tools: [{ name: 'qq_chat_history' }, { name: 'spawn_teammate' }],
      contexts: [...prompt.layers.merge(agent).values()]
        .filter(c => !suppressed.has(agent) || c.required === true)
        .map(c => ({ name: c.name, text: typeof c.text === 'function' ? c.text({ scope: agent, agent }) : c.text })),
    }
    const callbacks = [...hooks.get(agent)]
    const next = () => (callbacks.shift() || (() => assembly))(assembly, { scope: agent, agent }, next)
    return next()
  }
  return { prompt, globals, locals, suppressed, hooks, agentFor, assemble, viewFor }
}

for (const native of [false, true]) {
  test(`${native ? 'native' : 'fake'} refresh admission isolates repeated requests, new required providers, and exact agent scope`, { skip: native && !nativeRoot }, async t => {
    const f = fixture(native), social = f.agentFor('social'), other = f.agentFor('other-social'), full = f.agentFor('private-full')
    const original = Object.getOwnPropertyDescriptor(f.prompt, 'refreshContext')
    const off = installSocialScope(social.agent, ['qq_chat_history'])
    const offOther = installSocialScope(other.agent, [])
    t.after(off); t.after(offOther)
    assert.equal(SOCIAL_SCOPE_VERSION, 4)
    const assembly = await f.assemble(social.agent)
    assert.deepEqual(assembly.tools.map(t => t.name), ['qq_chat_history'])
    assert.deepEqual(assembly.contexts.map(c => c.name), ['aurabot-context'])
    social.setText('FRESH_AURABOT')
    f.globals.set('new:required', { name: 'new:required', order: 300, required: true, text: 'NEW_REQUIRED_SENTINEL' })
    f.globals.set('aurabot-context:spoof', { name: 'aurabot-context:spoof', order: 301, required: true, text: 'PREFIX_SPOOF_SENTINEL' })
    // Refresh is called through a different service view, like loopCtx (not agent.ctx).
    for (let attempt = 0; attempt < 2; attempt++) {
      const refreshed = f.viewFor(undefined).refreshContext(assembly, { scope: social.agent, agent: social.agent })
      assert.deepEqual(refreshed.contexts, [{ name: 'aurabot-context', text: 'FRESH_AURABOT' }])
      assert.equal(refreshed.sections, assembly.sections)
      assert.equal(refreshed.tools, assembly.tools)
    }
    assert.equal(assembly.contexts[0].text, 'AURABOT_SENTINEL', 'accepted assembly is not mutated')
    const fullAssembly = await f.assemble(full.agent)
    const fullRefresh = f.prompt.refreshContext(fullAssembly, { scope: full.agent })
    assert.ok(fullRefresh.contexts.some(c => c.name === 'working-directory:current'))
    assert.ok(fullRefresh.contexts.some(c => c.name === 'team:identity'))
    off(); off()
    assert.ok(f.prompt.refreshContext(assembly, { scope: social.agent }).contexts.some(c => c.name === 'team:identity'))
    assert.deepEqual(f.prompt.refreshContext(await f.assemble(other.agent), { scope: other.agent }).contexts.map(c => c.name), ['aurabot-context'])
    offOther()
    assert.deepEqual(Object.getOwnPropertyDescriptor(f.prompt, 'refreshContext'), original)
    assert.equal(f.suppressed.size, 0)
  })
}

test('tool restrictions and execution guard remain active, including after context filtering', async t => {
  const f = fixture(), { agent, effects } = f.agentFor('social')
  let active = true
  const off = installSocialScope(agent, ['qq_chat_history'], () => active)
  t.after(off)
  assert.deepEqual(effects.restrict, [{ allow: [] }])
  assert.deepEqual(effects.mode, ['native'])
  assert.equal(effects.guard[0]({ name: 'qq_chat_history' }), undefined)
  assert.ok(effects.guard[0]({ name: 'spawn_teammate' }))
  active = false
  assert.ok(effects.guard[0]({ name: 'qq_chat_history' }))
  off()
  assert.deepEqual(effects, { restrict: [], guard: [], mode: [] })
})

test('missing or unwritable refresh contract fails closed and failed installation unwinds all effects', () => {
  const f = fixture(), { agent, effects } = f.agentFor('social')
  const original = Object.getOwnPropertyDescriptor(f.prompt, 'refreshContext')
  agent.ctx.on = () => { throw new Error('registration failed') }
  assert.throws(() => installSocialScope(agent, []), /registration failed/)
  assert.deepEqual(effects, { restrict: [], guard: [], mode: [] })
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.prompt, 'refreshContext'), original)
  f.prompt.refreshContext = undefined
  assert.throws(() => installSocialScope(agent, []), { code: 'SOCIAL_SCOPE_UNAVAILABLE' })
  Object.defineProperty(f.prompt, 'refreshContext', { value: ContractPrompt.prototype.refreshContext, configurable: false, writable: false })
  assert.throws(() => installSocialScope(agent, []), { code: 'SOCIAL_SCOPE_UNAVAILABLE' })
})

test('empty plugin context stays empty and malformed refresh results stop instead of leaking', async t => {
  const f = fixture(), { agent } = f.agentFor('social')
  f.locals.get(agent).delete('aurabot-context')
  const off = installSocialScope(agent, [])
  t.after(off)
  assert.deepEqual(f.prompt.refreshContext(await f.assemble(agent), { scope: agent }).contexts, [])
  off()
  f.prompt.refreshContext = () => ({ contexts: null })
  const offMalformed = installSocialScope(agent, [])
  t.after(offMalformed)
  assert.throws(() => f.prompt.refreshContext({}, { scope: agent }), { code: 'SOCIAL_SCOPE_UNAVAILABLE' })
})

test('native agent-loop final transport payload stays clean across two requests and retry refresh', { skip: !nativeRoot }, async t => {
  const source = readFileSync(nativeRequire.resolve('@deepseek-ai/dsh-agent-loop'), 'utf8')
  const sessionSource = readFileSync(nativeRequire.resolve('@deepseek-ai/dsh-session'), 'utf8')
  const llmSource = readFileSync(nativeRequire.resolve('@deepseek-ai/dsh-llm'), 'utf8')
  const fragment = (text, start, end) => {
    const from = text.indexOf(start), to = text.indexOf(end, from)
    assert.ok(from >= 0 && to > from, `native source contract missing: ${start}`)
    return text.slice(from, to)
  }
  const freeze = value => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value)
      for (const child of Object.values(value)) freeze(child)
    }
    return value
  }
  // Execute the installed loop's actual refresh -> projection -> buildRequest ->
  // stream path. Only its transport and in-memory Session are test doubles.
  const { ReactLoopAgent, RuntimeContextProjection } = runInNewContext([
    fragment(llmSource, 'function callConfigEquals(', '\n/**'),
    fragment(sessionSource, 'function canonicalHeader(', '\n/**'),
    fragment(sessionSource, 'function headerEquals(', '\n/**'),
    fragment(source, 'var RuntimeContextProjection = class', '\n//#endregion'),
    fragment(source, 'var ReactLoopAgent = class', '\n//#endregion'),
    '({ ReactLoopAgent, RuntimeContextProjection })',
  ].join('\n'), {
    ...nativePrompt, deepFreeze: freeze, markAgentLoopRequest: x => x,
    assembleContextFor: (agent, signal) => ({ agent, scope: agent, signal }),
    createUserMessage: value => ({ id: 'runtime-probe', role: 'user', ...value }),
    createDeveloperMessage: value => ({ id: 'tools-probe', role: 'developer', ...value }),
    eventsNewestFirst: session => session.snapshotEvents().toReversed(),
    isOwned: message => message.source.kind === 'runtime-context',
    textOf: message => message.content[0]?.text,
    isReplacementSurfaceEvent: () => false,
    SOURCE: 'runtime-context', CLEARED: 'Current runtime context: none.',
    AssistantStreamAttempt: class {},
  })
  const f = fixture(true), social = f.agentFor('native-social')
  const off = installSocialScope(social.agent, [])
  t.after(off)
  const events = [], surface = { nodes: [], contentGeneration: 0 }, listeners = [], captured = []
  let header, context
  const session = {
    id: 'native-probe', surface,
    snapshotEvents: () => events,
    requestHeader: () => header, requestContext: () => context, toolHistory: () => ({ tools: [], updates: [] }),
    deriveMessages: () => events.filter(e => e.type === 'user/message').map(e => e.data),
    append(type, data) {
      const event = { seq: events.length, type, data }
      events.push(event)
      if (type === 'request/header') header = data.header
      if (type === 'request/context') context = data
      if (type === 'user/message') surface.nodes.push(event.seq)
      for (const fn of listeners) fn(session, event)
      return event
    },
  }
  const loop = social.agent
  Object.setPrototypeOf(loop, ReactLoopAgent.prototype)
  Object.assign(loop, {
    session, phase: { kind: 'running', turn: 1, step: 0, abort: new AbortController() },
    loopCtx: { systemPrompt: f.viewFor(undefined) },
    runtimeContext: new RuntimeContextProjection({ on: (_name, fn) => listeners.push(fn) }, session),
    systemPrompt: { project: () => [] }, requestHeaderLogged: false, requestSurfaceGeneration: 0,
    frozenMessages: new WeakSet(), assistantAttemptCounter: 0,
  })
  const stop = new Error('CAPTURE_ONLY_NO_MODEL')
  loop.prepareRequest = async () => ({
    config: { provider: 'offline-probe', model: 'no-model' },
    preparedCall: { stream(request) { captured.push(request); throw stop } },
  })
  const assembly = await f.assemble(loop)
  for (let attempt = 0; attempt < 2; attempt++) {
    social.setText(`CURRENT_${attempt}`)
    // This required entry did not exist when assembly hooks ran.
    f.globals.set('late:required', { name: 'late:required', order: 99, required: true, text: 'LATE_SENTINEL' })
    await assert.rejects(loop.step({ assembly, messages: [] }), error => error === stop)
  }
  assert.equal(captured.length, 2)
  for (const request of captured) {
    assert.ok(Object.isFrozen(request))
    assert.deepEqual(request.tools ?? [], [])
    assert.ok(request.messages.length > 0)
    for (const message of request.messages) {
      assert.equal(message.source.kind, 'runtime-context')
      assert.deepEqual(Array.from(message.source.sections, s => s.name), ['aurabot-context'])
      assert.doesNotMatch(JSON.stringify(message), /TEAM_LEAD_SENTINEL|WORKDIR_SENTINEL|LATE_SENTINEL/)
    }
  }
  assert.match(JSON.stringify(captured[1].messages.at(-1)), /CURRENT_1/)
  t.diagnostic('Captured two frozen native buildRequest payloads at preparedCall.stream; no transport executed.')
})

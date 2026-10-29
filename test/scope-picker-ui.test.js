import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

// Run the actual UI handlers with isolated hooks and fake HTTP; no live host or model.
const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const source = client.slice(client.indexOf('    function SearchPanel('), client.indexOf('    function RetrievalRole(')) +
  client.slice(client.indexOf('    function SharingPolicy('), client.indexOf('    function FactEditor('))
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const tick = () => new Promise(r => setImmediate(r))
const plain = value => JSON.parse(JSON.stringify(value))
function fixture() {
  return { config: { botQQ: '101', ownerQQ: '202', persona: { current: 'original' },
    allow: { groups: ['303', '404'], private: ['505', '202'] },
    memory: { enabled: true, shareGroups: [] }, learning: { enabled: true, learnEnabled: true, useEnabled: true },
    mediaMemory: { enabled: true }, search: {},
    retrieval: { enabled: true, index: { backend: 'local' }, roles: {}, reranker: {} },
  }, groupNames: { 303: '测试群' }, sessions: { 'private:606': 'session', 'private:505': 'duplicate', 'group:999': 'old', 'system:helper': 'excluded' } }
}
function mount(name = 'ScopePicker', { get, post, props = {} } = {}) {
  const st = props.st || fixture(), calls = [], changes = [], notices = [], instances = new Map()
  let slots, cursor, effects = [], tree, seen
  const hooks = {
    useState(initial) { const state = slots, i = cursor++; if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial; return [state[i], v => { state[i] = typeof v === 'function' ? v(state[i]) : v }] },
    useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial } },
    useCallback(fn, deps) { const i = cursor++; if (!same(slots[i]?.deps, deps)) slots[i] = { fn, deps }; return slots[i].fn },
    useEffect(fn, deps) { const state = slots, i = cursor++; if (!same(state[i]?.deps, deps)) { const old = state[i]; state[i] = { deps }; effects.push(() => { old?.cleanup?.(); state[i].cleanup = fn() }) } },
  }
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(v => v !== null && v !== undefined && v !== false) })
  const context = { ...hooks, h, URLSearchParams, API: '/fake',
    Card: 'Card', Row: 'Row', Btn: 'Btn', Select: 'Select', Choices: 'Choices', Empty: 'Empty', Fragment: 'Fragment', MemoryWorkspace: 'MemoryWorkspace',
    useField: draft => new Proxy({}, { get: () => path => h('Field', { path, value: path.split('.').reduce((o, k) => o?.[k], draft) }) }),
    async get(path) { calls.push({ path }); if (get) return get(path); return { ok: true, personaId: 'resolved-persona', list: [], items: [], queues: [], budget: { calls: 0 }, history: [], value: 60, revision: 1, label: '当前心情' } },
    async post(path, body) { calls.push({ path, body: plain(body) }); return post ? post(path, body) : { ok: true } },
    sessionStorage: { setItem() { assert.fail('stale result must not be materialized') } },
    assetUrl: id => '/fake/' + id,
  }
  runInNewContext(source + '\nglobalThis.parts={ScopePicker,scopeChatOptions,Learning,SearchPanel,Mood,Tasks,ScopedMemory,MediaMemory,RetrievalPanel};', context)
  const rootProps = { st, draft: structuredClone(st.config), setDraft: () => assert.fail('viewing scope must not save config'), toast: (...args) => notices.push(args), go: () => assert.fail('stale result must not navigate'),
    scope: { account: '101', chat: 'private:202', persona: 'original' }, onChange: s => changes.push(plain(s)), ...props }
  const expandNames = ['ScopePicker', 'LearningEditor', 'LearningRecord', 'LearningSourcePicker']
  const invoke = (type, props, key) => { if (!instances.has(key)) instances.set(key, []); seen.add(key); slots = instances.get(key); cursor = 0; return type(props) }
  const expand = (node, key) => {
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function' && expandNames.includes(node.type.name)) {
      const childKey = key + ':' + node.type.name + ':' + (node.props.key || 'single')
      return { ...node, children: [expand(invoke(node.type, node.props, childKey), childKey)] }
    }
    return { ...node, children: node.children.map((c, i) => expand(c, key + '/' + (c?.props?.key ?? i))) }
  }
  const render = () => {
    seen = new Set(); tree = expand(invoke(context.parts[name], rootProps, 'root'), 'root')
    for (const [key, state] of instances) if (!seen.has(key)) { state.forEach(s => s?.cleanup?.()); instances.delete(key) }
    const todo = effects; effects = []; todo.forEach(fn => fn()); return tree
  }
  const flush = async () => { render(); await tick(); render(); await tick(); return render() }
  const nodes = (root = tree) => root && typeof root === 'object' ? [root, ...root.children.flatMap(c => nodes(c)), ...nodes(root.props.right || null)] : []
  const label = n => n && typeof n === 'object' ? n.children.map(label).join('') : String(n ?? '')
  const button = name => { const n = nodes().find(n => n.type === 'Btn' && label(n) === name); assert.ok(n, name); return n.props }
  const input = name => { const n = nodes().find(n => n.props['aria-label'] === name); assert.ok(n, name); return n.props }
  const selectChat = chat => { input('选择查看的聊天').onChange({ target: { value: chat } }); render() }
  const applyChat = chat => { selectChat(chat); button('切换查看').onClick(); render() }
  return { render, flush, nodes, button, input, selectChat, applyChat, label, calls, changes, notices, st, props: rootProps, parts: context.parts,
    unmount() { for (const state of instances.values()) state.forEach(s => s?.cleanup?.()); instances.clear() } }
}

test('ScopePicker uses a dropdown from saved allow and known private chats, with owner/name labels and no writes', async () => {
  const ui = mount(); await ui.flush()
  assert.deepEqual(ui.nodes().filter(n => n.type === 'option').map(n => n.props.value), ['private:202', 'group:303', 'group:404', 'private:505', 'private:606', ''])
  assert.match(ui.label(ui.render()), /主人私聊 · 202/)
  assert.match(ui.label(ui.render()), /测试群（303）/)
  assert.equal(ui.nodes().some(n => n.props['aria-label'] === '聊天范围'), false)
  const before = structuredClone(ui.st)
  ui.selectChat('group:404')
  assert.equal(ui.input('人设范围').value, '')
  assert.equal(ui.changes.length, 0)
  ui.button('切换查看').onClick()
  assert.deepEqual(ui.changes, [{ account: '101', chat: 'group:404', persona: '' }])
  assert.deepEqual(ui.st, before)
  assert.equal(ui.calls.length, 0)
  ui.st.config.allow.groups.push('707'); ui.render()
  assert.ok(ui.nodes().some(n => n.type === 'option' && n.props.value === 'group:707'))
})

test('manual scope is a secondary option and accepts exactly one chat without granting access', async () => {
  const ui = mount(); await ui.flush(); ui.selectChat('')
  assert.equal(ui.button('切换查看').disabled, true)
  ui.input('聊天范围').onChange({ target: { value: 'group:808 group:909' } }); ui.render()
  assert.equal(ui.button('切换查看').disabled, true)
  ui.button('切换查看').onClick(); assert.equal(ui.changes.length, 0)
  ui.input('聊天范围').onChange({ target: { value: ' group:808 ' } }); ui.render()
  ui.button('切换查看').onClick()
  assert.equal(ui.changes[0].chat, 'group:808')
  assert.equal(ui.st.config.allow.groups.includes('808'), false)
})

for (const response of [{ ok: true, personaId: 'old-persona' }, { ok: false, message: 'old-error' }]) {
  test('persona resolution ignores stale success/error after choosing another chat: ' + response.ok, async () => {
    const old = deferred(), ui = mount('ScopePicker', { get: path => path.includes('private%3A202') ? old.promise : { ok: true, personaId: 'group-persona' } })
    await ui.flush(); const pending = ui.button('使用此聊天当前人设').onClick(); ui.render()
    ui.selectChat('group:303'); await ui.button('使用此聊天当前人设').onClick(); ui.render()
    old.resolve(response); await pending; ui.render()
    assert.equal(ui.input('人设范围').value, 'group-persona')
    assert.equal(ui.nodes().some(n => n.props.role === 'alert'), false)
    ui.button('切换查看').onClick(); assert.equal(ui.changes[0].chat, 'group:303')
  })
}

test('manual persona edits, external scope changes, and unmount invalidate pending resolution', async () => {
  for (const action of ['edit', 'props', 'unmount']) {
    const d = deferred(), ui = mount('ScopePicker', { get: () => d.promise }); await ui.flush()
    const pending = ui.button('使用此聊天当前人设').onClick()
    if (action === 'edit') ui.input('人设范围').onChange({ target: { value: 'manual' } })
    if (action === 'props') ui.props.scope = { account: '999', chat: 'group:404', persona: '' }
    if (action === 'unmount') ui.unmount(); else await ui.flush()
    d.resolve({ ok: true, personaId: 'stale' }); await pending
    if (action !== 'unmount') { ui.render(); assert.equal(ui.input('人设范围').value, action === 'edit' ? 'manual' : '') }
    assert.equal(ui.changes.length, 0)
  }
})

test('every scope panel passes saved state and keeps memory/learning switches global and unchanged', async () => {
  for (const name of ['Learning', 'SearchPanel', 'Mood', 'Tasks', 'ScopedMemory', 'MediaMemory', 'RetrievalPanel']) {
    const ui = mount(name); await ui.flush()
    const picker = ui.nodes().find(n => n.type === ui.parts.ScopePicker)
    assert.equal(picker.props.st, ui.st, name)
    const before = structuredClone(ui.props.draft)
    ui.applyChat('group:303'); await ui.flush()
    assert.deepEqual(ui.props.draft, before, name)
    assert.equal(ui.input('选择查看的聊天').value, 'group:303', name)
    assert.match(ui.nodes().find(n => n.type === 'Card' && n.props.title.startsWith('查看范围')).props.desc, /全局设置.*不随查看范围/)
  }
})

test('learning switches discard old lists, queue responses and editor state; old save cannot refill a new chat', async () => {
  const pendingSave = deferred(), staleRead = deferred()
  let holdOldRead = false
  const item = { id: 'same-id', revision: 1, kind: 'expression', expression: 'hello', status: 'pending', evidenceMessageIds: ['m1'] }
  const ui = mount('Learning', { get: path => {
    const url = new URL(path, 'http://fake'), chat = url.searchParams.get('chat')
    if (url.pathname === '/persona/resolve') return { ok: true, personaId: 'group-persona' }
    if (url.pathname === '/learning/items') return holdOldRead && chat === 'private:202' ? staleRead.promise : { ok: true, items: [{ ...item, expression: chat }] }
    if (url.pathname === '/learning/sources') return { ok: true, items: [] }
    return { ok: true, queues: [], budget: { calls: 0 } }
  }, post: () => pendingSave.promise })
  await ui.flush(); ui.button('编辑').onClick(); await ui.flush()
  ui.input('适用情境').onChange({ target: { value: 'old draft' } }); ui.render()
  const oldSave = ui.button('保存为待审核').onClick, pending = ui.button('批准使用').onClick()
  holdOldRead = true; const oldLoad = ui.button('刷新').onClick()
  ui.applyChat('group:303'); await ui.flush()
  assert.equal(ui.nodes().some(n => n.props['aria-label'] === '适用情境'), false)
  ui.button('编辑').onClick(); await ui.flush(); assert.notEqual(ui.input('适用情境').value, 'old draft')
  const before = ui.calls.length; oldSave(); pendingSave.resolve({ ok: true }); staleRead.resolve({ ok: true, items: [{ ...item, expression: 'STALE' }] })
  await pending; await oldLoad; await ui.flush()
  assert.equal(ui.calls.length, before)
  assert.doesNotMatch(ui.label(ui.render()), /STALE/)
  assert.equal(ui.calls.filter(c => c.body).length, 1)
  assert.equal(ui.calls.find(c => c.body).body.chat, 'private:202')
})

for (const name of ['SearchPanel', 'Mood', 'Tasks']) {
  test(name + ' ignores an earlier chat response, including A → B → A switches', async () => {
    const d = deferred(); let first = true
    const ui = mount(name, { get: () => { if (first) { first = false; return d.promise }; return { ok: true, personaId: 'resolved-persona', list: [], history: [], label: 'fresh', value: 60 } } })
    await ui.flush(); ui.applyChat('group:303'); await ui.flush(); ui.applyChat('private:202'); await ui.flush()
    d.resolve({ ok: true, list: [{ id: 'STALE', kind: 'STALE', query: 'STALE' }], history: [], label: 'STALE', value: 1 })
    await ui.flush(); assert.doesNotMatch(ui.label(ui.render()), /STALE/)
  })
}

test('retrieval ignores old query completion and allows a new query after switching scope', async () => {
  const d = deferred(), ui = mount('RetrievalPanel', { post: () => d.promise }); await ui.flush()
  ui.input('检索内容').onChange({ target: { value: 'old query' } }); ui.render()
  const pending = ui.button('检索').onClick(); ui.render(); ui.applyChat('group:303'); await ui.flush()
  d.resolve({ ok: true, hits: [{ id: 'STALE', text: 'STALE' }] }); await pending; await ui.flush()
  assert.doesNotMatch(ui.label(ui.render()), /STALE/)
  ui.input('检索内容').onChange({ target: { value: 'new query' } }); ui.render()
  assert.equal(ui.button('检索').disabled, false)
})

for (const name of ['Learning', 'Mood']) {
  test(name + ' only needs choose group then switch; current persona is resolved automatically', async () => {
    const ui = mount(name); await ui.flush(); ui.applyChat('group:303'); await ui.flush()
    const picker = ui.nodes().find(n => n.type === ui.parts.ScopePicker)
    assert.equal(picker.props.scope.chat, 'group:303')
    assert.equal(picker.props.scope.persona, 'resolved-persona')
    assert.equal(ui.calls.filter(c => c.path.startsWith('/persona/resolve?')).length, 1)
    const reads = ui.calls.filter(c => c.path.startsWith(name === 'Learning' ? '/learning/items?' : '/mood/state?'))
    const query = new URL(reads.at(-1).path, 'http://offline').searchParams
    assert.equal(query.get('chat'), 'group:303'); assert.equal(query.get('persona'), 'resolved-persona')
    assert.equal(ui.calls.some(c => c.body), false)
  })
}

test('auto-apply rejects stale persona resolution and failures; explicit persona and normal memory stay unchanged', async () => {
  const old = deferred(), ui = mount('ScopePicker', { props: { requirePersona: true }, get: path => path.includes('group%3A303') ? old.promise : { ok: true, personaId: 'current' } })
  await ui.flush(); ui.selectChat('group:303'); const pending = ui.button('切换查看').onClick(); ui.render()
  ui.selectChat('group:404'); await ui.button('切换查看').onClick(); ui.render()
  old.resolve({ ok: true, personaId: 'old' }); await pending
  assert.deepEqual(ui.changes, [{ account: '101', chat: 'group:404', persona: 'current' }])
  const failed = mount('ScopePicker', { props: { requirePersona: true }, get: () => ({ ok: false, message: '没有可用人设' }) })
  await failed.flush(); failed.selectChat('group:303'); await failed.button('切换查看').onClick(); failed.render()
  assert.equal(failed.changes.length, 0); assert.match(failed.label(failed.render()), /没有可用人设/)
  const explicit = mount('ScopePicker', { props: { requirePersona: true } }); await explicit.flush()
  explicit.selectChat('group:303'); explicit.input('人设范围').onChange({ target: { value: 'chosen' } }); explicit.render(); explicit.button('切换查看').onClick()
  assert.equal(explicit.changes[0].persona, 'chosen'); assert.equal(explicit.calls.length, 0)
  const memory = mount('ScopedMemory'); await memory.flush(); memory.applyChat('group:303'); await memory.flush()
  assert.equal(memory.nodes().find(n => n.type === memory.parts.ScopePicker).props.scope.persona, '')
  assert.equal(memory.calls.some(c => c.path.startsWith('/persona/resolve?')), false)
})

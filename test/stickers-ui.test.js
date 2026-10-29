import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

// 执行真实组件的事件处理函数；模拟 React hooks 和面板接口，绝不启动 live 宿主。
const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const component = client.slice(client.indexOf('    const STICKER_STATES='), client.indexOf('    function SpeakUp('))
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
function mount({ total = 3, postResult, tasks = [], holdPost } = {}) {
  let cursor = 0, tree, effects = [], itemRows = Array.from({ length: total }, (_, i) => ({ id: 'item-' + i, revision: i + 1, state: 'pending', name: '素材' + i, animated: false, analysis: { state: 'failed' } }))
  let slots = []
  const instances = new Map(), calls = [], notifications = [], working = []
  const hooks = {
    useState(initial) { const current = slots, i = cursor++; if (!(i in current)) current[i] = typeof initial === 'function' ? initial() : initial; return [current[i], v => { current[i] = typeof v === 'function' ? v(current[i]) : v }] },
    useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial } },
    useCallback(fn, deps) { const i = cursor++; if (!same(slots[i]?.deps, deps)) slots[i] = { fn, deps }; return slots[i].fn },
    useEffect(fn, deps) { const current = slots, i = cursor++; if (!same(current[i]?.deps, deps)) { const previous = current[i]; current[i] = { deps }; effects.push(() => { previous?.cleanup?.(); current[i].cleanup = fn() }) } },
  }
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(v => v !== null && v !== undefined && v !== false) })
  const context = { ...hooks, h, URLSearchParams, API: '/api', confirm: () => assert.fail('Stickers 不能调用原生 confirm'),
    Btn: 'Btn', Card: 'Card', Select: 'Select', Empty: 'Empty', Row: 'Row', ScopePicker: 'ScopePicker',
    async get(path) {
      calls.push({ path }); const url = new URL(path, 'http://local.invalid'), offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 30)
      if (url.pathname === '/stickers/queue') return { ok: true, items: tasks.slice(offset, offset + limit), total: tasks.length, runtime: { enabled: true, collect: true, caption: true } }
      if (url.pathname === '/stickers/stats') return { ok: true, pending: total, approved: 0, rejected: 0, disabled: 0, deleted: 0 }
      return { ok: true, items: itemRows.slice(offset, offset + limit), total: itemRows.length }
    },
    async post(path, body) {
      calls.push({ path, body: structuredClone(body) }); if (holdPost) await holdPost
      if (postResult instanceof Error) throw postResult
      return postResult || (body.entries ? { ok: true, total: body.entries.length, succeeded: body.entries.length, failed: 0, results: body.entries.map(it => ({ id: it.id, ok: true, state: 'approved' })) } : { ok: true })
    },
  }
  runInNewContext(component + '\nglobalThis.parts={StickerWorkspace,StickerConfirmation,StickerCell,StickerTask};', context)
  const props = { scope: { account: '100', chat: 'group:1' }, toast: (...args) => notifications.push(args), onWorking: v => working.push(v) }
  const invoke = (type, props) => { const key = type.name + ':' + (props.key || 'single'); if (!instances.has(key)) instances.set(key, []); slots = instances.get(key); cursor = 0; return type(props) }
  const expand = node => {
    if (!node || typeof node !== 'object') return node
    return { ...node, children: typeof node.type === 'function' ? [expand(invoke(node.type, node.props))] : node.children.map(expand) }
  }
  const render = () => { tree = expand(invoke(context.parts.StickerWorkspace, props)); const todo = effects; effects = []; todo.forEach(f => f()); return tree }
  const flush = async () => { render(); await new Promise(resolve => setImmediate(resolve)); render(); return tree }
  const nodes = (root = tree) => root && typeof root === 'object' ? [root, ...root.children.flatMap(child => nodes(child)), ...nodes(root.props?.right || null)] : []
  const label = node => node && typeof node === 'object' ? node.children.map(label).join('') : String(node ?? '')
  const button = name => { const node = nodes().find(n => ['Btn', 'button'].includes(n.type) && label(n) === name); assert.ok(node, name); return node.props }
  const input = name => { const node = nodes().find(n => n.type === 'input' && n.props['aria-label'] === name); assert.ok(node, name); return node.props }
  const unmount = () => { for (const state of instances.values()) for (const slot of state) slot?.cleanup?.(); instances.clear() }
  return { flush, render, button, input, nodes, label, calls, notifications, working, context, unmount, setItems: v => { itemRows = v }, setScope: v => { props.scope = v } }
}

test('表情 UI：当前页选择跨页保留，筛选切换清空，当前筛选选中数可见', async () => {
  const ui = mount({ total: 31 }); await ui.flush()
  ui.button('全选当前页').onClick(); ui.render()
  assert.match(ui.label(ui.render()), /已选 30 项 · 本页选中 30\/30/)
  ui.button('下一页').onClick(); await ui.flush()
  assert.match(ui.label(ui.render()), /已选 30 项 · 本页选中 0\/1/)
  ui.button('全选当前页').onClick(); ui.render()
  assert.match(ui.label(ui.render()), /已选 31 项 · 本页选中 1\/1/)
  const search = ui.nodes().find(n => n.props['aria-label'] === '搜索表情')
  search.props.onChange({ target: { value: '猫' } }); await ui.flush()
  assert.match(ui.label(ui.render()), /已选 0 项/)
  await ui.button('全选当前筛选（最多200）').onClick(); ui.render()
  assert.match(ui.label(ui.render()), /已选 31 项/)
  const request = ui.calls.filter(c => c.path.startsWith('/stickers?')).at(-1).path
  assert.match(request, /limit=200/)
  assert.match(request, /offset=0/)
  assert.match(request, /query=/)
  ui.button('取消全部选择').onClick(); ui.render()
  assert.match(ui.label(ui.render()), /已选 0 项/)
})

test('表情 UI：内联确认后才发送版本快照，双击提交只有一次，部分失败保留和展示', async () => {
  let release
  const holdPost = new Promise(resolve => { release = resolve })
  const ui = mount({ holdPost, postResult: { ok: true, total: 3, succeeded: 2, failed: 1, partial: true, results: [{ id: 'item-0', ok: true }, { id: 'item-1', ok: false, code: 'STALE_REVISION', message: '刷新后重选' }, { id: 'item-2', ok: true }] } })
  await ui.flush(); await ui.button('全选当前筛选（最多200）').onClick(); ui.render()
  const handler = ui.button('批量通过').onClick
  handler(); handler(); ui.render()
  assert.equal(ui.calls.filter(c => c.body).length, 0)
  assert.equal(ui.working.at(-1), true)
  assert.equal(ui.button('取消本次操作').disabled, false)
  assert.match(ui.label(ui.render()), /批准使用 · 3 项/)
  assert.match(ui.label(ui.render()), /聊天 group:1/)
  const submit = ui.button('确认提交').onClick, cancel = ui.button('取消本次操作').onClick
  const first = submit(), second = submit()
  cancel(); ui.render()
  assert.equal(ui.calls.filter(c => c.body).length, 1)
  assert.equal(ui.button('取消本次操作').disabled, true)
  assert.equal(ui.button('正在提交…').disabled, true)
  release(); await Promise.all([first, second]); await ui.flush()
  const body = ui.calls.find(c => c.body).body
  assert.equal(body.chatId, 'group:1')
  assert.equal(body.action, 'approve')
  assert.deepEqual(body.entries.map(e => [e.id, e.expectedRevision]), [['item-0', 1], ['item-1', 2], ['item-2', 3]])
  assert.match(ui.label(ui.render()), /已选 1 项 · 本页选中 1\/3/)
  assert.match(ui.label(ui.render()), /刷新后重选/)
  assert.equal(ui.working.at(-1), false)
})

test('表情 UI：超大筛选不默默截断，动画未逐项确认不发批准请求', async () => {
  const large = mount({ total: 201 }); await large.flush()
  await large.button('全选当前筛选（最多200）').onClick(); large.render()
  assert.match(large.notifications.at(-1)[0], /超过 200/)
  assert.match(large.label(large.render()), /已选 0 项/)
  const ui = mount({ total: 1 }); ui.setItems([{ id: 'gif', revision: 9, state: 'pending', animated: true }]); await ui.flush()
  ui.button('全选当前页').onClick(); ui.render()
  await ui.button('批量通过').onClick(); ui.render()
  assert.equal(ui.calls.filter(c => c.body).length, 0)
  assert.match(ui.notifications.at(-1)[0], /动画尚未逐项确认/)
  // 输入校验失败不会锁死页面，仍可在该 GIF 的独立审核框确认。
  const cell = ui.nodes().find(n => n.type === ui.context.parts.StickerCell)
  cell.props.onReviewed(true); ui.render()
  ui.button('批量通过').onClick(); ui.render()
  assert.equal(ui.calls.filter(c => c.body).length, 0)
  await ui.button('确认提交').onClick()
  assert.equal(ui.calls.find(c => c.body).body.entries[0].reviewedOriginal, true)
})

test('表情 UI：任务按种类重试，携带所见失败状态与尝试次数', async () => {
  const task = { id: 'sync-1', kind: 'sync', state: 'failed', attempts: 2 }
  const ui = mount({ tasks: [task] }); await ui.flush()
  const kindSelector = ui.nodes().find(n => n.type === 'Select' && n.props.options.some(o => o.value === 'sync') && n.props.value === 'analyze')
  kindSelector.props.onChange('sync'); await ui.flush()
  const row = ui.nodes().find(n => n.type === ui.context.parts.StickerTask)
  row.props.onSelect(true); ui.render()
  ui.button('批量重试QQ 收藏同步（仅明确失败）').onClick(); ui.render()
  assert.match(ui.label(ui.render()), /重试QQ 收藏同步 · 1 项/)
  // 后台对象更新与此前保存的筛选事件都不能改变已展示的任务授权。
  task.state = 'unknown'; task.attempts = 8
  kindSelector.props.onChange('analyze'); ui.render()
  await ui.button('确认提交').onClick()
  const body = ui.calls.find(c => c.body).body
  assert.equal(body.action, 'task_retry')
  assert.equal(body.kind, 'sync')
  assert.deepEqual(body.entries, [{ id: 'sync-1', expectedState: 'failed', expectedAttempts: 2 }])
})

test('表情 UI：等待确认时冻结动作、版本、审核标记和选择，旧事件不能插入另一请求', async () => {
  const item = { id: 'gif', revision: 9, name: '原始动画', state: 'pending', animated: true }
  const ui = mount({ total: 1 }); ui.setItems([item]); await ui.flush()
  const cell = ui.nodes().find(n => n.type === ui.context.parts.StickerCell)
  cell.props.onReviewed(true); cell.props.onSelect(true); ui.render()
  const reject = ui.button('批量拒绝').onClick, clear = ui.button('取消全部选择').onClick
  const search = ui.input('搜索表情').onChange, importQQ = ui.button('导入 QQ 收藏').onClick, refresh = ui.button('刷新状态').onClick
  ui.button('批量通过').onClick()
  // 在 React 下一次渲染之前也必须拦住旧回调；确认数据不引用可变的素材对象。
  const reads = ui.calls.length
  item.revision = 10; item.name = '后台新版本'
  cell.props.onSelect(false); cell.props.onReviewed(false); clear(); reject()
  search({ target: { value: '别的筛选' } }); await importQQ(); await refresh(); ui.render()
  assert.equal(ui.calls.length, reads)
  assert.equal(ui.input('搜索表情').value, '')
  assert.match(ui.label(ui.render()), /已选 1 项/)
  assert.match(ui.label(ui.render()), /确认批准使用 · 1 项/)
  const dialog = ui.nodes().find(n => n.props.role === 'alertdialog')
  assert.match(ui.label(dialog), /原始动画 · gif · v9/)
  assert.doesNotMatch(ui.label(dialog), /后台新版本/)
  assert.equal(ui.button('批量拒绝').disabled, true)
  assert.equal(ui.input('选择表情 后台新版本').disabled, true)
  assert.equal(ui.button('确认提交').disabled, false)
  await ui.button('确认提交').onClick()
  assert.deepEqual(ui.calls.find(c => c.body).body, { chatId: 'group:1', action: 'approve', entries: [{ id: 'gif', expectedRevision: 9, reviewedOriginal: true }] })
})

test('表情 UI：取消和 Escape 保留选择并解锁，已取消的旧确认不能提交新操作', async () => {
  const ui = mount(); await ui.flush()
  ui.button('全选当前页').onClick(); ui.render()
  ui.button('批量删除本地').onClick(); ui.render()
  const canceledSubmit = ui.button('确认提交').onClick
  assert.match(ui.label(ui.render()), /阻止自动收藏回来/)
  assert.equal(ui.button('取消本次操作').disabled, false)
  ui.button('取消本次操作').onClick(); ui.render()
  assert.equal(ui.working.at(-1), false)
  assert.match(ui.label(ui.render()), /已选 3 项/)
  assert.equal(ui.button('批量通过').disabled, false)
  assert.equal(ui.nodes().some(n => n.props.role === 'alertdialog'), false)
  ui.button('批量拒绝').onClick(); ui.render()
  await canceledSubmit()
  assert.equal(ui.calls.filter(c => c.body).length, 0)
  assert.match(ui.label(ui.render()), /确认拒绝 · 3 项/)
  const dialog = ui.nodes().find(n => n.props.role === 'alertdialog')
  let prevented = false, stopped = false
  dialog.props.onKeyDown({ key: 'Escape', preventDefault() { prevented = true }, stopPropagation() { stopped = true } }); ui.render()
  assert.ok(prevented && stopped)
  assert.equal(ui.working.at(-1), false)
  assert.equal(ui.calls.filter(c => c.body).length, 0)
  ui.button('批量停用').onClick(); ui.render()
  await ui.button('确认提交').onClick()
  assert.equal(ui.calls.find(c => c.body).body.action, 'disable')
})

for (const [failure, expected] of [[new Error('连接中断，请先刷新核对结果'), /连接中断/], [{ ok: false, message: '范围不匹配' }, /范围不匹配/]]) {
  test('表情 UI：确认提交失败会解锁且保留选择，不自动重发：' + expected, async () => {
    const ui = mount({ postResult: failure }); await ui.flush()
    ui.button('全选当前页').onClick(); ui.render()
    ui.button('批量重试识别').onClick(); ui.render()
    const submit = ui.button('确认提交').onClick
    await submit(); await ui.flush(); await submit()
    assert.equal(ui.calls.filter(c => c.body).length, 1)
    assert.equal(ui.working.at(-1), false)
    assert.equal(ui.nodes().some(n => n.props.role === 'alertdialog'), false)
    assert.equal(ui.button('批量重试识别').disabled, false)
    assert.match(ui.label(ui.render()), /已选 3 项/)
    assert.match(ui.label(ui.render()), expected)
  })
}

test('表情 UI：聊天或账号改变、组件卸载后不能提交旧确认', async () => {
  for (const change of [ui => ui.setScope({ account: '100', chat: 'group:2' }), ui => ui.setScope({ account: '200', chat: 'group:1' }), ui => ui.unmount()]) {
    const ui = mount(); await ui.flush()
    ui.button('全选当前页').onClick(); ui.render()
    ui.button('批量通过').onClick(); ui.render()
    const submit = ui.button('确认提交').onClick
    change(ui)
    if (ui.working.at(-1)) ui.render()
    await submit()
    assert.equal(ui.calls.filter(c => c.body).length, 0)
    assert.equal(ui.working.at(-1), false)
  }
})

const singleCases = [
  { button: '删除本地条目', path: '/sticker/delete', expected: { id: 'one', expectedRevision: 4, fromQQ: false } },
  { button: '绑定已有 QQ 收藏', path: '/sticker/sync/bind', input: ['已有 QQ 收藏 ID', 'existing-qq'], expected: { id: 'one', expectedRevision: 4, emojiId: 'existing-qq', confirmedExisting: true } },
  { button: '删除隔离项', path: '/sticker/legacy/delete', legacy: true, expected: { id: 'one' } },
  { button: '确认识别未执行', path: '/sticker/analysis/reconcile', task: { id: 'analyze-unknown', kind: 'analyze', state: 'unknown', attempts: 3 }, input: ['识别未执行核对依据', '已核对服务记录'], expected: { taskId: 'analyze-unknown', expectedState: 'unknown', expectedAttempts: 3, confirmedNotApplied: true, reason: '已核对服务记录' } },
  { button: '核对 QQ 已执行', path: '/sticker/sync/reconcile', task: { id: 'sync-unknown', kind: 'sync', action: 'add', state: 'unknown', attempts: 2 }, input: ['QQ 收藏 ID', 'verified-qq'], expected: { taskId: 'sync-unknown', expectedState: 'unknown', expectedAttempts: 2, confirmedApplied: true, emojiId: 'verified-qq' } },
  { button: '核对 QQ 未执行', path: '/sticker/sync/reconcile', task: { id: 'sync-unknown', kind: 'sync', action: 'add', state: 'unknown', attempts: 2 }, expected: { taskId: 'sync-unknown', expectedState: 'unknown', expectedAttempts: 2, confirmedNotApplied: true } },
]
for (const example of singleCases) {
  test('表情 UI：' + example.button + ' 使用可取消的内联确认并保留单项版本', async () => {
    const item = { id: 'one', revision: 4, name: '待核对素材', state: 'pending', qq: { state: 'unidentified' } }
    const task = example.task && { ...example.task }
    const ui = mount({ total: 1, tasks: task ? [task] : [] }); ui.setItems([item]); await ui.flush()
    if (example.legacy) {
      ui.nodes().find(n => n.type === 'Select' && n.props.value === 'all').props.onChange('quarantined'); await ui.flush()
    }
    if (example.input) { ui.input(example.input[0]).onChange({ target: { value: example.input[1] } }); ui.render() }
    ui.button(example.button).onClick(); ui.render()
    assert.equal(ui.calls.filter(c => c.body).length, 0)
    assert.equal(ui.button('取消本次操作').disabled, false)
    ui.button('取消本次操作').onClick(); ui.render()
    assert.equal(ui.working.at(-1), false)
    assert.equal(ui.calls.filter(c => c.body).length, 0)
    ui.button(example.button).onClick(); ui.render()
    if (example.input) {
      const dialog = ui.nodes().find(n => n.props.role === 'alertdialog')
      assert.ok(ui.label(dialog).includes(example.input[1]))
      // 编辑字段也不改变已经确认的请求内容。
      ui.input(example.input[0]).onChange({ target: { value: '后来的输入' } }); ui.render()
    }
    item.revision = 99
    if (task) { task.state = 'failed'; task.attempts = 99 }
    const submit = ui.button('确认提交').onClick
    await Promise.all([submit(), submit()]); await ui.flush()
    const requests = ui.calls.filter(c => c.body)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].path, example.path)
    for (const [key, value] of Object.entries({ ...example.expected, chatId: 'group:1' })) assert.deepEqual(requests[0].body[key], value, key)
    assert.equal(ui.working.at(-1), false)
  })
}

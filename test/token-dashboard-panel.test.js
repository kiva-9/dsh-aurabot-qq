import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const dashboardCode = source.slice(source.indexOf('    const TOKEN_METRICS'), source.indexOf('    function Diagnostics('))
const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(x => x != null && x !== false) })
const all = root => {
  const nodes = []
  const walk = node => {
    if (!node || typeof node !== 'object') return
    nodes.push(node)
    for (const child of node.children || []) walk(child)
  }
  walk(root)
  return nodes
}
const content = node => node == null ? '' : typeof node === 'object' ? (node.children || []).map(content).join(' ') : String(node)
const button = (tree, label) => {
  const found = all(tree).find(n => n.type === 'button' && n.children.includes(label))
  assert.ok(found, '找不到按钮：' + label)
  return found
}
const input = (tree, label) => {
  const found = all(tree).find(n => n.type === 'input' && n.props['aria-label'] === label)
  assert.ok(found, '找不到输入框：' + label)
  return found
}
const card = (tree, title) => all(tree).find(n => n.type === 'Card' && n.props.title === title)
const tick = () => new Promise(resolve => setImmediate(resolve))

const aggregate = (overrides = {}) => ({
  calls: 2, callsWithUsage: 2, incompleteCalls: 1,
  inputTokens: 120, outputTokens: 30, cachedTokens: 0, totalTokens: 150,
  inputCallsWithUsage: 2, outputCallsWithUsage: 1, cachedCallsWithUsage: 0,
  ...overrides,
})
const response = (overrides = {}) => ({
  ok: true, range: '7d', from: Date.UTC(2026, 9, 24, 16), to: Date.UTC(2026, 9, 31, 4),
  timeZone: 'Etc/GMT-8', generatedAt: Date.UTC(2026, 9, 31, 4),
  note: '合计包含缓存读取，缺失值不计入合计。',
  totals: aggregate(),
  models: [{ key: 'model-a', ...aggregate() }, { key: '(unknown)', ...aggregate({ calls: 1, callsWithUsage: 0, incompleteCalls: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0, inputCallsWithUsage: 0, outputCallsWithUsage: 0 }) }],
  trend: { granularity: 'day', points: [
    { key: '2026-10-29', ...aggregate() },
    { key: '2026-10-30', ...aggregate({ calls: 1, callsWithUsage: 0, incompleteCalls: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0, inputCallsWithUsage: 0, outputCallsWithUsage: 0 }) },
    { key: '2026-10-31', ...aggregate({ totalTokens: 25 }) },
  ] },
  ...overrides,
})

function dashboardHarness() {
  const states = [], refs = [], pending = [], requests = [], cleanups = []
  let stateIndex = 0, refIndex = 0, mounted = false, effects = [], updates = 0, writes = 0
  const ctx = {
    h, Card: 'Card', Row: 'Row', Empty: 'Empty', URLSearchParams,
    useState: initial => {
      const i = stateIndex++
      if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial
      return [states[i], value => { updates++; states[i] = typeof value === 'function' ? value(states[i]) : value }]
    },
    useRef: initial => { const i = refIndex++; return refs[i] || (refs[i] = { current: initial }) },
    useEffect: fn => { if (!mounted) effects.push(fn) },
    get: path => {
      requests.push(path)
      return new Promise((resolve, reject) => pending.push({ resolve, reject }))
    },
    post: () => { writes++; throw new Error('只读面板不能发送 POST') },
  }
  runInNewContext(dashboardCode + '\nglobalThis.dashboard=TokenDashboard; globalThis.trend=TokenTrend', ctx)
  return {
    requests, pending, ctx,
    render() {
      stateIndex = 0; refIndex = 0; effects = []
      const tree = ctx.dashboard({ setDraft: () => { writes++ } })
      if (!mounted) { mounted = true; for (const effect of effects) cleanups.push(effect()) }
      return tree
    },
    unmount() { for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup() },
    get updates() { return updates },
    get writes() { return writes },
  }
}

function trendHarness(props, options = {}) {
  const states = [], refs = [], cleanups = []
  let cursor = 0, refCursor = 0, mounted = false, effects = []
  const ctx = { h, Empty: 'Empty', useState: value => {
    const i = cursor++
    if (!(i in states)) states[i] = value
    return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next }]
  }, useRef: value => { const i = refCursor++; return refs[i] || (refs[i] = { current: value }) },
  useEffect: fn => { if (!mounted) effects.push(fn) } }
  if (options.ResizeObserver) ctx.ResizeObserver = options.ResizeObserver
  runInNewContext(dashboardCode + '\nglobalThis.trend=TokenTrend', ctx)
  return {
    render: () => {
      cursor = 0; refCursor = 0; effects = []
      const tree = ctx.trend(props)
      const scroll = all(tree).find(n => n.props.className === 'ab-token-chart-scroll')
      if (scroll) scroll.props.ref.current = options.element || null
      if (!mounted) { mounted = true; for (const effect of effects) cleanups.push(effect()) }
      return tree
    },
    unmount: () => { for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup() },
  }
}

test('筛选、刷新和并发返回保持只读，并验证自定义日期', async () => {
  const d = dashboardHarness()
  let tree = d.render()
  assert.equal(new URL(d.requests[0], 'http://localhost').searchParams.get('range'), '7d')
  assert.match(card(tree, 'Token 统计').props.desc, /聊天模型（LLM）和向量模型（embedding）/)
  assert.match(card(tree, 'Token 统计').props.desc, /其他服务用量可在「诊断」查看/)
  assert.match(content(tree), /正在读取 Token 统计/)
  d.pending[0].resolve(response()); await tick()
  tree = d.render()
  assert.match(content(card(tree, '按模型统计')), /model-a/)

  button(tree, '自定义').props.onClick()
  tree = d.render()
  assert.doesNotMatch(content(tree), /model-a/)
  assert.equal(button(tree, '刷新').props.disabled, true)
  button(tree, '应用筛选').props.onClick()
  tree = d.render()
  assert.match(content(tree), /请选择有效的开始和结束日期/)
  assert.equal(d.requests.length, 1)

  input(tree, '开始日期').props.onChange({ target: { value: '2026-02-30' } })
  tree = d.render()
  input(tree, '结束日期').props.onChange({ target: { value: '2026-03-01' } })
  tree = d.render(); button(tree, '应用筛选').props.onClick()
  assert.match(content(d.render()), /请选择有效的开始和结束日期/)
  assert.equal(d.requests.length, 1)
  tree = d.render()
  input(tree, '开始日期').props.onChange({ target: { value: '2026-10-31' } })
  tree = d.render()
  input(tree, '结束日期').props.onChange({ target: { value: '2026-10-01' } })
  tree = d.render(); button(tree, '应用筛选').props.onClick()
  tree = d.render()
  assert.match(content(tree), /开始日期不能晚于结束日期/)
  assert.equal(d.requests.length, 1)

  input(tree, '开始日期').props.onChange({ target: { value: '2026-10-01' } })
  tree = d.render()
  input(tree, '结束日期').props.onChange({ target: { value: '2026-10-31' } })
  tree = d.render()
  input(tree, 'Token 统计聊天范围').props.onChange({ target: { value: ' group:234 ' } })
  tree = d.render(); button(tree, '应用筛选').props.onClick()
  const query = new URL(d.requests[1], 'http://localhost').searchParams
  assert.equal(query.get('range'), 'custom')
  assert.equal(query.get('startDate'), '2026-10-01')
  assert.equal(query.get('endDate'), '2026-10-31')
  assert.equal(query.get('chatId'), 'group:234')
  d.pending[1].resolve(response({ range: 'custom' })); await tick()
  tree = d.render()
  button(tree, '刷新').props.onClick()
  tree = d.render(); button(tree, '刷新').props.onClick()
  assert.equal(d.requests[2], d.requests[3])
  d.pending[3].resolve(response({ range: 'custom', models: [{ key: 'newer-model', ...aggregate() }] })); await tick()
  assert.match(content(d.render()), /newer-model/)
  d.pending[2].resolve(response({ range: 'custom', models: [{ key: 'stale-model', ...aggregate() }] })); await tick()
  tree = d.render()
  assert.match(content(tree), /newer-model/)
  assert.doesNotMatch(content(tree), /stale-model/)

  button(tree, '刷新').props.onClick()
  tree = d.render(); button(tree, '今日').props.onClick()
  assert.doesNotMatch(content(d.render()), /newer-model/)
  d.pending[4].resolve(response({ models: [{ key: 'old-filter', ...aggregate() }] })); await tick()
  tree = d.render()
  assert.doesNotMatch(content(tree), /old-filter/)
  button(tree, '应用筛选').props.onClick()
  assert.equal(new URL(d.requests[5], 'http://localhost').searchParams.get('range'), 'today')
  const beforeUnmount = d.updates
  d.unmount()
  d.pending[5].resolve(response()); await tick()
  assert.equal(d.updates, beforeUnmount)
  assert.equal(d.writes, 0)
})

test('模型表和趋势区保留缺失用量，支持键盘查看和切换指标', async () => {
  const d = dashboardHarness(); d.render()
  const result = response()
  d.pending[0].resolve(result); await tick()
  let tree = d.render()
  const stats = all(tree).filter(n => n.props.className?.split(' ').includes('ab-token-stat'))
  assert.equal(stats.length, 4)
  assert.match(content(stats[0]), /120/)
  assert.match(content(stats[1]), /30.*已记录部分用量/)
  assert.equal(stats[1].props['aria-label'], '输出 token：已记录 30（未完整返回）')
  assert.match(content(stats[2]), /未返回/)
  assert.match(content(stats[3]), /已记录合计 token.*150.*已记录部分用量/)
  assert.equal(stats[3].props['aria-label'], '已记录合计 token：已记录 150（未完整返回）')
  assert.match(content(tree), /共 2 次调用 · 2 次返回用量 · 1 次核心用量不完整/)
  assert.match(content(tree), /输入 2 \/ 2 · 输出 1 \/ 2 · 缓存 0 \/ 2/)
  assert.match(content(tree), /Embedding 的输入已含缓存，合计不会重复计算/)
  const models = card(tree, '按模型统计')
  assert.match(content(models), /model-a/)
  assert.match(content(models), /\(unknown\)/)
  assert.match(content(models), /未返回/)
  assert.match(content(models), /已记录合计/)
  assert.match(all(models).find(n => n.type === 'th' && n.children.includes('核心用量不完整')).props.title, /usageComplete=false/)

  let chartNode = all(tree).find(n => typeof n.type === 'function' && n.type.name === 'TokenTrend')
  assert.equal(chartNode.props.metric.key, 'totalTokens')
  const chart = trendHarness(chartNode.props)
  let chartTree = chart.render()
  const svg = all(chartTree).find(n => n.type === 'svg')
  assert.equal(svg.props.role, 'img')
  assert.match(svg.props['aria-label'], /方向键/)
  assert.ok(all(svg).find(n => n.type === 'title'))
  assert.ok(all(svg).find(n => n.type === 'desc'))
  const path = all(svg).find(n => n.type === 'path')
  assert.equal((path.props.d.match(/M/g) || []).length, 2, '未知日期不与前后日期连线')
  let prevented = false
  svg.props.onKeyDown({ key: 'ArrowRight', preventDefault: () => { prevented = true } })
  assert.equal(prevented, true)
  chartTree = chart.render()
  assert.match(content(all(chartTree).find(n => n.props['aria-live'] === 'polite')), /2026-10-30.*未返回/)
  assert.match(content(chartTree), /查看趋势数据表/)
  assert.match(content(chartTree), /2026-10-31/)
  const scroller = { clientWidth: 200, scrollLeft: 0 }
  all(chartTree).find(n => n.type === 'svg').props.onKeyDown({ key: 'End', preventDefault() {}, currentTarget: { parentElement: scroller } })
  chartTree = chart.render()
  assert.match(content(all(chartTree).find(n => n.props['aria-live'] === 'polite')), /2026-10-31/)
  assert.ok(scroller.scrollLeft > 0)
  all(chartTree).find(n => n.type === 'svg').props.onMouseMove({ clientX: 0, currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 560 }) } })
  assert.match(content(all(chart.render()).find(n => n.props['aria-live'] === 'polite')), /2026-10-29/)

  button(card(tree, '用量趋势').props.right, '输入').props.onClick()
  tree = d.render()
  chartNode = all(tree).find(n => typeof n.type === 'function' && n.type.name === 'TokenTrend')
  assert.equal(chartNode.props.metric.key, 'inputTokens')
  assert.equal(d.writes, 0)
})

test('趋势图随容器调整宽度，并在没有 ResizeObserver 时安全回退', async () => {
  const d = dashboardHarness(); d.render()
  d.pending[0].resolve(response()); await tick()
  const chartNode = all(d.render()).find(n => typeof n.type === 'function' && n.type.name === 'TokenTrend')
  const element = { clientWidth: 940 }
  let observer
  class FakeResizeObserver {
    constructor(callback) { this.callback = callback; observer = this }
    observe(target) { this.target = target }
    disconnect() { this.disconnected = true }
  }
  const chart = trendHarness(chartNode.props, { element, ResizeObserver: FakeResizeObserver })
  chart.render()
  assert.equal(observer.target, element)
  assert.equal(all(chart.render()).find(n => n.type === 'svg').props.width, 940)
  element.clientWidth = 1080
  observer.callback()
  assert.equal(all(chart.render()).find(n => n.type === 'svg').props.width, 1080)
  element.clientWidth = 400
  observer.callback()
  assert.equal(all(chart.render()).find(n => n.type === 'svg').props.width, 560)
  chart.unmount()
  assert.equal(observer.disconnected, true)

  const fallback = trendHarness(chartNode.props, { element: { clientWidth: 820 } })
  fallback.render()
  assert.equal(all(fallback.render()).find(n => n.type === 'svg').props.width, 820)
})

test('近 30 天和全部历史筛选发出对应查询', async () => {
  const d = dashboardHarness(); d.render()
  d.pending[0].resolve(response()); await tick()
  let tree = d.render()
  button(tree, '近 30 天').props.onClick()
  tree = d.render(); button(tree, '应用筛选').props.onClick()
  let query = new URL(d.requests[1], 'http://localhost').searchParams
  assert.equal(query.get('range'), '30d')
  assert.equal(query.has('startDate'), false)
  d.pending[1].resolve(response({ range: '30d' })); await tick()
  tree = d.render(); button(tree, '全部').props.onClick()
  tree = d.render(); button(tree, '应用筛选').props.onClick()
  query = new URL(d.requests[2], 'http://localhost').searchParams
  assert.equal(query.get('range'), 'all')
  assert.equal(query.has('endDate'), false)
  d.pending[2].resolve(response({ range: 'all' })); await tick()
  assert.match(content(d.render()), /全部历史/)
  assert.equal(d.writes, 0)
})

test('向量模型无输出和模型调用无缓存字段不影响完整合计', async () => {
  const d = dashboardHarness(); d.render()
  const embedding = aggregate({ calls: 1, callsWithUsage: 1, incompleteCalls: 0, inputTokens: 1000, outputTokens: 0, cachedTokens: 400, totalTokens: 1000, inputCallsWithUsage: 1, outputCallsWithUsage: 0, cachedCallsWithUsage: 1 })
  d.pending[0].resolve(response({ totals: embedding, models: [{ key: 'embedding-model', ...embedding }] })); await tick()
  let tree = d.render(), stats = all(tree).filter(n => n.props.className?.split(' ').includes('ab-token-stat'))
  assert.match(content(stats[1]), /未返回/)
  assert.match(content(stats[3]), /1,000/)
  assert.doesNotMatch(content(stats[3]), /未完整返回/)
  assert.match(content(tree), /0 次核心用量不完整/)
  assert.doesNotMatch(content(card(tree, '按模型统计')), /未完整返回/)

  button(tree, '刷新').props.onClick()
  const llm = aggregate({ calls: 1, callsWithUsage: 1, incompleteCalls: 0, inputTokens: 1000, outputTokens: 500, cachedTokens: 0, totalTokens: 1500, inputCallsWithUsage: 1, outputCallsWithUsage: 1, cachedCallsWithUsage: 0 })
  d.pending[1].resolve(response({ totals: llm, models: [{ key: 'chat-model', ...llm }] })); await tick()
  tree = d.render(); stats = all(tree).filter(n => n.props.className?.split(' ').includes('ab-token-stat'))
  assert.match(content(stats[2]), /未返回/)
  assert.match(content(stats[3]), /1,500/)
  assert.doesNotMatch(content(stats[3]), /未完整返回/)
  assert.match(content(tree), /0 次核心用量不完整/)
  assert.doesNotMatch(content(card(tree, '按模型统计')), /未完整返回/)
  assert.equal(d.writes, 0)
})

test('历史日期显示与账本固定 UTC+8 边界一致', async () => {
  const d = dashboardHarness(); d.render()
  d.pending[0].resolve(response({
    range: 'custom',
    from: Date.parse('1988-07-01T00:00:00+08:00'),
    to: Date.parse('1988-07-02T00:00:00+08:00'),
  }))
  await tick()
  assert.match(content(d.render()), /1988\/07\/01 至 1988\/07\/01/)
})

test('空数据、没有返回用量以及请求错误均有明确状态', async () => {
  const d = dashboardHarness(); d.render()
  d.pending[0].resolve({ ok: false, message: '测试读取失败' }); await tick()
  assert.match(content(d.render()), /测试读取失败/)
  button(d.render(), '刷新').props.onClick()
  const noUsage = aggregate({ calls: 3, callsWithUsage: 0, incompleteCalls: 3, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, inputCallsWithUsage: 0, outputCallsWithUsage: 0, cachedCallsWithUsage: 0 })
  d.pending[1].resolve(response({ totals: noUsage, models: [{ key: 'missing', ...noUsage }], trend: { granularity: 'month', points: [{ key: '2026-10', ...noUsage }] } })); await tick()
  let tree = d.render()
  const stats = all(tree).filter(n => n.props.className?.split(' ').includes('ab-token-stat'))
  assert.equal(stats.length, 4)
  for (const stat of stats) assert.match(content(stat), /未返回/)
  assert.match(content(tree), /这些调用未返回用量，不能视为零用量/)
  const trendNode = all(tree).find(n => typeof n.type === 'function' && n.type.name === 'TokenTrend')
  assert.match(content(trendHarness(trendNode.props).render()), /按月统计/)

  button(tree, '刷新').props.onClick()
  const empty = aggregate({ calls: 0, callsWithUsage: 0, incompleteCalls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, inputCallsWithUsage: 0, outputCallsWithUsage: 0, cachedCallsWithUsage: 0 })
  d.pending[2].resolve(response({ range: 'all', totals: empty, models: [], trend: { granularity: 'day', points: [] } })); await tick()
  tree = d.render()
  assert.ok(all(tree).find(n => n.type === 'Empty' && n.props.text === '当前范围尚无调用记录'))
  assert.ok(all(tree).find(n => n.type === 'Empty' && n.props.text === '当前范围没有模型记录'))
  assert.equal(d.writes, 0)
})

test('管理分组导航在模块运行时打开 Token 统计页面', () => {
  const tabsCode = source.slice(source.indexOf('    const TABS = ['), source.indexOf('    const modOn ='))
  const pageCode = source.slice(source.indexOf('    const PANEL_GROUPS ='), source.indexOf('    function apply(ctx)'))
  const tokenPage = function TokenDashboard() {}
  const st = {
    config: { enabled: true, dryRun: false, setupDone: true, botQQ: '1', ownerQQ: '2', persona: { current: 'p' }, allow: { groups: [] } },
    onebot: { state: 'connected', login: {} }, personas: [], mood: { label: '平静' },
    snowluma: { installed: false }, version: 'test', modules: [{ id: 'token-meter', running: true }],
  }
  const state = [], refs = [], calls = []
  let cursor = 0, refCursor = 0, draftWrites = 0
  const names = ['Overview', 'NewFeatures', 'Connect', 'Persona', 'Access', 'Group', 'Model', 'Voice', 'Stickers', 'ImageGen', 'SearchPanel', 'SpeakUp', 'Mood', 'ScopedMemory', 'RetrievalPanel', 'MediaMemory', 'Learning', 'Tasks', 'Song', 'Bili', 'LocalApi', 'Modules', 'Diagnostics', 'Logs', 'ExtPage', 'TabBoundary', 'Wizard', 'Switch', 'WhaleIcon']
  const ctx = Object.fromEntries(names.map(name => [name, name]))
  Object.assign(ctx, {
    h, TokenDashboard: tokenPage, useStyle() {}, Empty: 'Empty', Btn: 'Btn',
    localStorage: { getItem: () => 'overview', setItem() {} },
    useState: initial => {
      const i = cursor++
      if (!(i in state)) state[i] = i === 0 ? st : i === 2 ? structuredClone(st.config) : typeof initial === 'function' ? initial() : initial
      return [state[i], value => { if (i === 2) draftWrites++; state[i] = typeof value === 'function' ? value(state[i]) : value }]
    },
    useRef: initial => { const i = refCursor++; return refs[i] || (refs[i] = { current: initial }) },
    useEffect() {}, useMemo: fn => fn(), useCallback: fn => fn,
    clone: structuredClone, cx: (...parts) => parts.filter(Boolean).join(' '),
    getPath: (obj, path) => path.split('.').reduce((value, key) => value?.[key], obj),
    get: path => { calls.push(['GET', path]); return Promise.resolve({ ok: true }) },
    post: path => { calls.push(['POST', path]); return Promise.resolve({ ok: true }) },
    avatarSrc: () => '', pickAvatar() {},
  })
  runInNewContext(tabsCode + '\n' + pageCode + '\nglobalThis.page=AurabotPage', ctx)
  const render = () => { cursor = 0; refCursor = 0; return ctx.page() }
  let tree = render()
  button(tree, '管理').props.onClick()
  tree = render()
  const tab = button(tree, 'Token 统计')
  assert.equal(tab.props.role, 'tab')
  tab.props.onClick()
  tree = render()
  assert.ok(all(tree).find(n => n.type === tokenPage))
  st.modules[0].running = false
  tree = render()
  assert.equal(all(tree).some(n => n.type === 'button' && n.children.includes('Token 统计')), false)
  assert.equal(draftWrites, 0)
  assert.deepEqual(calls, [])
})

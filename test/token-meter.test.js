// #13：Token 计量器。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorage } from '../src/storage/index.js'
import { createUsageLedger, rangeWindow } from '../src/diagnostics/usage.js'
import tokenMeter from '../src/modules/token-meter/index.js'

const BOT = '20000002', OWNER = '10000001', GROUP = 'group:62001', OTHER = 'group:62002'
const at = (text) => Date.parse(text + '+08:00')
const NOW = at('2026-10-30T12:00:00')
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-token-'))
  const storage = createStorage({ file: ':memory:', filesDir: join(dir, 'assets') })
  t.after(() => { storage.close(); rmSync(dir, { recursive: true, force: true }) })
  let account = BOT
  const usage = createUsageLedger({ storage, getAccount: () => account })
  const call = (fields) => usage.record({ service: 'llm', status: 'succeeded', billing: 'unknown', startedAt: NOW, ...fields })
  return { storage, usage, call, setAccount: (value) => { account = value } }
}
const tokens = (input, output, cached) => ({ usage: { inputTokens: input, outputTokens: output, ...(cached === undefined ? {} : { cacheReadTokens: cached }) } })

test('自然日按固定 UTC+8 切：跨 00:00 分到两天，7 天含今天', t => {
  assert.equal(rangeWindow('today', NOW).from, at('2026-10-30T00:00:00'))
  assert.equal(rangeWindow('7d', NOW).from, at('2026-10-24T00:00:00'))
  assert.equal(rangeWindow('30d', NOW).from, at('2026-10-01T00:00:00'))
  assert.equal(rangeWindow('all', NOW).from, 0)
  const f = fixture(t)
  f.call({ chatId: GROUP, startedAt: at('2026-10-29T23:59:59'), ...tokens(1, 0) })
  f.call({ chatId: GROUP, startedAt: at('2026-10-30T00:00:00'), ...tokens(2, 0) })
  const { from, to } = rangeWindow('today', NOW)
  assert.equal(f.usage.aggregate({ chatId: GROUP, from, to }).totals.inputTokens, 2)
  assert.deepEqual(f.usage.aggregate({ chatId: GROUP, groupBy: 'day' }).buckets.map(b => [b.key, b.inputTokens]), [['2026-10-29', 1], ['2026-10-30', 2]])
})

test('合计含缓存读取：DSH 的 inputTokens 是未命中缓存的部分', t => {
  const f = fixture(t)
  f.call({ chatId: GROUP, ...tokens(100, 50, 900) })
  const { totals } = f.usage.aggregate({ chatId: GROUP })
  assert.deepEqual([totals.inputTokens, totals.outputTokens, totals.cachedTokens, totals.totalTokens], [100, 50, 900, 1050])
})

test('embedding 的 cached 已含在输入里，不重复加；没有输出不算不完整', t => {
  const f = fixture(t)
  f.call({ service: 'embedding', chatId: GROUP, inputTokens: 100, cachedTokens: 40 })
  const { totals } = f.usage.aggregate({ chatId: GROUP })
  assert.equal(totals.totalTokens, 100)
  assert.equal(totals.incompleteCalls, 0)
})

test('缺失不当 0：计入调用数和不完整数，不进合计', t => {
  const f = fixture(t)
  f.call({ chatId: GROUP, ...tokens(10, 5) })
  f.call({ chatId: GROUP })
  f.call({ chatId: GROUP, usage: { inputTokens: 7 } })
  const { totals } = f.usage.aggregate({ chatId: GROUP })
  assert.equal(totals.calls, 3)
  assert.equal(totals.callsWithUsage, 2)
  assert.equal(totals.incompleteCalls, 2)
  assert.equal(totals.inputTokens, 17)
  assert.ok(Object.values(totals).every(Number.isInteger))
})

test('主模型调用不写 usage_complete 也不算不完整；明确不完整的算', t => {
  const f = fixture(t)
  f.call({ chatId: GROUP, ...tokens(1, 1) })
  f.call({ chatId: GROUP, ...tokens(1, 1), usageComplete: false })
  assert.equal(f.usage.aggregate({ chatId: GROUP }).totals.incompleteCalls, 1)
})

test('失败调用有用量也计入；不返回金额', t => {
  const f = fixture(t)
  f.call({ chatId: GROUP, status: 'failed', amount: 9, credits: 9, currency: 'CNY', ...tokens(3, 4) })
  const result = f.usage.aggregate({ chatId: GROUP })
  assert.equal(result.totals.totalTokens, 7)
  assert.doesNotMatch(JSON.stringify(result), /amount|credits|currency/)
})

test('chat 只含当前聊天；account 含所有聊天和后台调用；换账号不混入', t => {
  const f = fixture(t)
  f.call({ chatId: GROUP, ...tokens(1, 0) })
  f.call({ chatId: OTHER, ...tokens(2, 0) })
  f.call({ ...tokens(4, 0) })
  assert.equal(f.usage.aggregate({ chatId: GROUP }).totals.inputTokens, 1)
  assert.equal(f.usage.aggregate({}).totals.inputTokens, 7)
  f.setAccount('99999999')
  assert.equal(f.usage.aggregate({}).totals.calls, 0)
})

test('分组：null 不丢，按 key 升序；无数据全 0 不抛错', t => {
  const f = fixture(t)
  f.call({ chatId: GROUP, model: 'b', role: 'planner', provider: 'p', ...tokens(1, 0) })
  f.call({ chatId: GROUP, model: 'a', ...tokens(1, 0) })
  f.call({ chatId: GROUP, ...tokens(1, 0) })
  assert.deepEqual(f.usage.aggregate({ chatId: GROUP, groupBy: 'model' }).buckets.map(b => b.key), ['(unknown)', 'a', 'b'])
  assert.deepEqual(f.usage.aggregate({ chatId: GROUP, groupBy: 'role' }).buckets.map(b => b.key), ['(unknown)', 'planner'])
  assert.deepEqual(f.usage.aggregate({ chatId: GROUP, groupBy: 'provider' }).buckets.map(b => b.key), ['(unknown)', 'p'])
  assert.throws(() => f.usage.aggregate({ groupBy: "x'; DROP TABLE" }), /groupBy/)
  const empty = f.usage.aggregate({ chatId: 'group:0' })
  assert.deepEqual(empty.totals, { calls: 0, callsWithUsage: 0, incompleteCalls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0 })
})

function module(t, { owner = false } = {}) {
  const f = fixture(t), routes = new Map()
  let build
  const hub = { turnSendersAllOwner: () => owner }
  const exports = tokenMeter.setup({ core: { hub, usage: f.usage, http: { query: (req) => req.query } }, config: () => ({ ownerQQ: OWNER, allow: { groups: ['62001', '62002'], private: [] } }), tool: fn => { build = fn }, route: (path, fn) => routes.set(path, fn) })
  const tool = build({ chat: { kind: 'group', groupId: '62001', chatId: GROUP }, sessionId: 's' })[0]
  return { ...f, exports, tool, routes }
}

test('qq_token_usage：默认当前聊天今天，输出没有金额和请求 ID', async t => {
  const f = module(t)
  f.call({ chatId: GROUP, startedAt: Date.now(), requestId: undefined, amount: 3, ...tokens(12345, 6789, 3456) })
  const r = await f.tool.execute({})
  assert.equal(r.ok, true)
  assert.match(r.message, /当前聊天 · 今天/)
  assert.match(r.message, /合计 22,590 tokens/)
  assert.match(r.message, /覆盖 1 次调用/)
  assert.doesNotMatch(r.message, /元|¥|credits|req/i)
})

test('部分用量计入已知字段，并准确说明缺失字段', async t => {
  const f = module(t)
  f.call({ chatId: GROUP, startedAt: Date.now(), usage: { inputTokens: 7 } })
  const result = await f.tool.execute({})
  assert.match(result.message, /合计 7 tokens/)
  assert.match(result.message, /缺失字段未计入合计/)
})

test('没有数据时明说', async t => {
  assert.match((await module(t).tool.execute({})).message, /还没有可统计/)
})

test('群友不能查全账号或别的聊天；主人可以，但白名单外不行', async t => {
  const member = module(t)
  assert.equal((await member.tool.execute({ scope: 'account' })).ok, false)
  assert.equal((await member.tool.execute({ chat_id: OTHER })).ok, false)
  const owner = module(t, { owner: true })
  assert.equal((await owner.tool.execute({ scope: 'account' })).ok, true)
  assert.equal((await owner.tool.execute({ chat_id: OTHER })).ok, true)
  assert.equal((await owner.tool.execute({ chat_id: 'group:999' })).ok, false)
  assert.equal((await owner.tool.execute({ range: 'bad' })).ok, false)
})

test('summary 和面板路由可用，无数据全 0', async t => {
  const f = module(t)
  assert.equal(f.exports.summary({ range: 'all', now: NOW }).totals.calls, 0)
  const result = f.routes.get('/token-meter/summary')({ query: { range: '7d' } })
  assert.equal(result.ok, true)
  assert.equal(result.range, '7d')
  assert.equal(f.routes.get('/token-meter/summary')({ query: { range: 'bad' } }).ok, false)
})

test('dashboard 自定义范围含闰日和结束日，UTC+8 午夜边界与三组汇总一致', t => {
  const f = module(t)
  f.call({ startedAt: at('2024-02-27T23:59:59.999'), model: 'outside', ...tokens(50, 0) })
  f.call({ startedAt: at('2024-02-28T00:00:00.000'), model: 'a', ...tokens(1, 2, 3) })
  f.call({ startedAt: at('2024-02-29T23:59:59.999'), model: 'b', ...tokens(4, 5) })
  f.call({ startedAt: at('2024-03-01T23:59:59.999'), model: 'a', ...tokens(6, 7) })
  f.call({ startedAt: at('2024-03-02T00:00:00.000'), model: 'outside', ...tokens(50, 0) })
  const result = f.exports.dashboard({ range: 'custom', startDate: '2024-02-28', endDate: '2024-03-01', now: NOW })
  assert.equal(result.from, at('2024-02-28T00:00:00'))
  assert.equal(result.to, at('2024-03-02T00:00:00'))
  assert.equal(result.timeZone, 'Etc/GMT-8')
  assert.equal(result.generatedAt, NOW)
  assert.equal(result.totals.totalTokens, 28)
  assert.deepEqual(result.trend.points.map(p => [p.key, p.totalTokens]), [['2024-02-28', 6], ['2024-02-29', 9], ['2024-03-01', 13]])
  for (const [field, value] of Object.entries(result.totals)) {
    assert.equal(result.models.reduce((sum, row) => sum + row[field], 0), value, `model ${field}`)
    assert.equal(result.trend.points.reduce((sum, row) => sum + row[field], 0), value, `trend ${field}`)
  }
})

test('dashboard 模型、聊天、账号与缺失字段的覆盖数正确，查询不修改账本', t => {
  const f = module(t)
  f.call({ chatId: GROUP, model: 'a', inputTokens: 10, outputTokens: 5, cachedTokens: 5 })
  f.call({ chatId: GROUP, model: 'b', service: 'embedding', inputTokens: 20, cachedTokens: 5 })
  f.call({ chatId: GROUP, model: 'z', inputTokens: 2 })
  f.call({ chatId: GROUP })
  f.call({ chatId: OTHER, model: 'other-chat', ...tokens(50, 0) })
  f.call({ model: 'background', ...tokens(10, 0) })
  f.setAccount('99999999')
  f.call({ chatId: GROUP, model: 'other-account', ...tokens(99, 0) })
  f.setAccount(BOT)
  const before = f.storage.db.get('SELECT COUNT(*) n FROM service_calls').n
  const result = f.exports.dashboard({ range: 'today', chatId: GROUP, now: NOW })
  assert.deepEqual(result.models.map(m => [m.key, m.totalTokens]), [['a', 20], ['b', 20], ['z', 2], ['(unknown)', 0]])
  assert.deepEqual(result.totals, { calls: 4, callsWithUsage: 3, incompleteCalls: 2, inputTokens: 32, outputTokens: 5,
    cachedTokens: 10, totalTokens: 42, inputCallsWithUsage: 3, outputCallsWithUsage: 1, cachedCallsWithUsage: 2 })
  assert.equal(f.exports.dashboard({ range: 'today', now: NOW }).totals.calls, 6)
  assert.equal(f.exports.dashboard({ range: 'today', chatId: "group:62001' OR 1=1 --", now: NOW }).totals.calls, 0)
  f.setAccount('99999999')
  assert.equal(f.exports.dashboard({ range: 'today', chatId: GROUP, now: NOW }).totals.totalTokens, 99)
  assert.equal(f.storage.db.get('SELECT COUNT(*) n FROM service_calls').n, before)
})

test('dashboard 只统计 LLM 与 embedding，旧 summary 仍包含其他服务', t => {
  const f = module(t)
  f.call({ service: 'search', model: 'tavily', credits: 1, inputTokens: 999, startedAt: at('2020-01-01T12:00:00') })
  f.call({ service: 'tts', model: 'voice', inputChars: 20, startedAt: at('2020-01-02T12:00:00') })
  const empty = f.exports.dashboard({ range: 'all', now: NOW })
  assert.equal(empty.totals.calls, 0)
  assert.equal(empty.totals.callsWithUsage, 0)
  assert.deepEqual(empty.models, [])
  assert.deepEqual(empty.trend.points, [])
  const old = f.exports.summary({ range: 'all', now: NOW, groupBy: 'model' })
  assert.equal(old.totals.calls, 2)
  assert.equal(old.totals.totalTokens, 999)
  assert.deepEqual(old.buckets.map(b => b.key), ['tavily', 'voice'])

  f.call({ model: 'llm-model', ...tokens(10, 20, 30) })
  f.call({ service: 'embedding', model: 'embed', inputTokens: 100, cachedTokens: 40 })
  const mixed = f.exports.dashboard({ range: 'all', now: NOW })
  assert.equal(mixed.from, at('2026-10-30T00:00:00'))
  assert.equal(mixed.totals.calls, 2)
  assert.equal(mixed.totals.totalTokens, 160)
  assert.deepEqual(mixed.models.map(m => m.key), ['embed', 'llm-model'])
  assert.deepEqual(mixed.trend.points.map(p => p.totalTokens), [160])
  assert.match(mixed.note, /LLM 和 embedding/)
  assert.match(mixed.note, /embedding 缓存已包含在输入中，不重复计算/)
  const unchanged = f.exports.summary({ range: 'all', now: NOW, groupBy: 'model' })
  assert.equal(unchanged.totals.calls, 4)
  assert.equal(unchanged.totals.totalTokens, 1159)
  assert.deepEqual(unchanged.buckets.map(b => b.key), ['embed', 'llm-model', 'tavily', 'voice'])
})

test('dashboard 历史日期及返回时区均固定 UTC+8，不受历史夏令时影响', t => {
  const f = module(t)
  f.call({ startedAt: at('1988-06-30T23:59:59.999'), ...tokens(10, 0) })
  f.call({ startedAt: at('1988-07-01T00:00:00'), ...tokens(2, 0) })
  f.call({ startedAt: at('1988-07-01T23:59:59.999'), ...tokens(3, 0) })
  f.call({ startedAt: at('1988-07-02T00:00:00'), ...tokens(20, 0) })
  const result = f.exports.dashboard({ range: 'custom', startDate: '1988-07-01', endDate: '1988-07-01', now: NOW })
  assert.equal(result.timeZone, 'Etc/GMT-8')
  assert.equal(result.from, at('1988-07-01T00:00:00'))
  assert.equal(result.to, at('1988-07-02T00:00:00'))
  assert.deepEqual(result.trend.points.map(p => [p.key, p.totalTokens]), [['1988-07-01', 5]])
  const hour = new Intl.DateTimeFormat('en', { timeZone: result.timeZone, hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(result.from)).find(part => part.type === 'hour').value
  assert.equal(hour, '00')
})

test('dashboard 空日补零，真实零值和未返回的字段可以区分', t => {
  const f = module(t)
  f.call({ startedAt: at('2024-02-29T12:00:00'), model: 'zero', ...tokens(0, 0, 0) })
  f.call({ startedAt: at('2024-03-01T12:00:00'), model: 'missing' })
  const result = f.exports.dashboard({ range: 'custom', startDate: '2024-02-28', endDate: '2024-03-01', now: NOW })
  const [empty, zero, missing] = result.trend.points
  assert.deepEqual([empty.key, empty.calls, empty.callsWithUsage, empty.incompleteCalls], ['2024-02-28', 0, 0, 0])
  assert.deepEqual([zero.key, zero.calls, zero.callsWithUsage, zero.inputCallsWithUsage, zero.outputCallsWithUsage, zero.cachedCallsWithUsage], ['2024-02-29', 1, 1, 1, 1, 1])
  assert.deepEqual([missing.key, missing.calls, missing.callsWithUsage, missing.incompleteCalls, missing.inputCallsWithUsage], ['2024-03-01', 1, 0, 1, 0])
})

test('dashboard 毫秒小数靠近午夜也留在实际日期，极远未来结束日可计数', t => {
  const f = module(t)
  const midnight = at('2024-03-01T00:00:00')
  f.call({ startedAt: midnight - 0.5, ...tokens(2, 0) })
  f.call({ startedAt: at('9999-12-31T23:59:59.999'), ...tokens(3, 0) })
  const leap = f.exports.dashboard({ range: 'custom', startDate: '2024-02-29', endDate: '2024-02-29', now: NOW })
  assert.equal(leap.trend.points[0].totalTokens, 2)
  const future = f.exports.dashboard({ range: 'custom', startDate: '9999-12-31', endDate: '9999-12-31', now: NOW })
  assert.equal(future.totals.totalTokens, 3)
  assert.equal(future.trend.points[0].totalTokens, 3)
})

test('dashboard 长时间范围按月补零，全部历史从首条匹配记录开始', t => {
  const f = module(t)
  const empty = f.exports.dashboard({ range: 'all', now: NOW })
  assert.deepEqual(empty.trend.points, [])
  f.call({ chatId: OTHER, startedAt: at('2019-01-01T10:00:00'), ...tokens(90, 0) })
  f.call({ chatId: GROUP, startedAt: at('2024-01-01T00:00:00'), ...tokens(1, 0) })
  f.call({ chatId: GROUP, startedAt: at('2025-01-01T23:59:59'), ...tokens(2, 0) })
  const leapYear = f.exports.dashboard({ range: 'custom', startDate: '2024-01-01', endDate: '2024-12-31', now: NOW })
  assert.equal(leapYear.trend.granularity, 'day')
  assert.equal(leapYear.trend.points.length, 366)
  const long = f.exports.dashboard({ range: 'custom', startDate: '2024-01-01', endDate: '2025-01-01', chatId: GROUP, now: NOW })
  assert.equal(long.trend.granularity, 'month')
  assert.equal(long.trend.points.length, 13)
  assert.deepEqual(long.trend.points.map(p => [p.key, p.totalTokens]).filter(([, value]) => value), [['2024-01', 1], ['2025-01', 2]])
  assert.equal(long.trend.points[1].calls, 0)
  const all = f.exports.dashboard({ range: 'all', chatId: GROUP, now: NOW })
  assert.equal(all.from, at('2024-01-01T00:00:00'))
  assert.equal(all.trend.granularity, 'month')
  assert.equal(all.trend.points[0].key, '2024-01')
  assert.equal(all.trend.points.at(-1).key, '2026-10')
  assert.equal(all.totals.totalTokens, 3)
})

test('dashboard 路由严格校验日期、范围和方法，并对范围大小设限', t => {
  const f = module(t), route = f.routes.get('/token-meter/dashboard')
  const get = (query) => route({ method: 'GET', query })
  assert.equal(get({}).range, '7d')
  assert.equal(route({ method: 'POST', query: {} }).ok, false)
  for (const query of [
    { range: '' }, { range: '7d;DROP TABLE service_calls' }, { range: 'custom' },
    { range: 'custom', startDate: '2023-02-29', endDate: '2023-03-01' },
    { range: 'custom', startDate: '2024-02-30', endDate: '2024-03-01' },
    { range: 'custom', startDate: '2024-2-01', endDate: '2024-03-01' },
    { range: 'custom', startDate: '2024-00-01', endDate: '2024-03-01' },
    { range: 'custom', startDate: '1969-12-31', endDate: '1970-01-01' },
    { range: 'custom', startDate: '2024-03-02', endDate: '2024-03-01' },
    { range: 'custom', startDate: '1970-01-01', endDate: '2070-01-01' },
    { range: 'custom', startDate: "2024-01-01' OR 1=1", endDate: '2024-01-02' },
  ]) assert.equal(get(query).ok, false, JSON.stringify(query))
  const max = get({ range: 'custom', startDate: '1970-01-01', endDate: '2069-12-31' })
  assert.equal(max.ok, true)
  assert.equal(max.trend.points.length, 1200)
  assert.equal(max.trend.points.at(-1).key, '2069-12')
  const farFuture = get({ range: 'custom', startDate: '9999-12-31', endDate: '9999-12-31' })
  assert.equal(farFuture.ok, true)
  assert.deepEqual(farFuture.trend.points.map(p => p.key), ['9999-12-31'])
  assert.equal(f.storage.db.get('SELECT COUNT(*) n FROM service_calls').n, 0)
})

test('dashboard 预设截止当前时刻，today 与 summary 仍保持兼容', t => {
  const f = module(t)
  f.call({ startedAt: at('2026-10-29T23:59:59.999'), ...tokens(10, 0) })
  f.call({ startedAt: at('2026-10-30T00:00:00'), ...tokens(2, 0) })
  f.call({ startedAt: NOW, ...tokens(3, 0) })
  f.call({ startedAt: NOW + 1, ...tokens(40, 0) })
  const dash = f.exports.dashboard({ range: 'today', now: NOW })
  const summary = f.exports.summary({ range: 'today', now: NOW })
  assert.equal(dash.from, at('2026-10-30T00:00:00'))
  assert.equal(dash.to, NOW + 1)
  assert.equal(dash.totals.totalTokens, 5)
  assert.equal(summary.totals.totalTokens, dash.totals.totalTokens)
})

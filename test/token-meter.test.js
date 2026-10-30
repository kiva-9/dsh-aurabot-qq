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

test('自然日按上海时间切：跨 00:00 分到两天，7 天含今天', t => {
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

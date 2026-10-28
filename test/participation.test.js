import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createParticipationController, normalizeParticipationConfig, DEFAULT_PARTICIPATION_CONFIG } from '../src/runtime/participation.js'

const S = { account: '100', chatId: 'group:1' }
const HOUR = 3600_000
function fixture(config = {}, extra = {}) {
  let clock = 0
  const controller = createParticipationController({ config, now: () => clock, ...extra })
  return { c: controller, advance: (ms) => { clock += ms }, time: (ms) => { clock = ms } }
}
const relaxed = { cooldownMs: 0, idleBaseMs: 0, maxPerHour: 100, burstMax: 100, burstGain: 0 }
const skip = (c, batchId, extra = {}, scope = S) => c.observeDecision(scope, { batchId, decision: 'skip', ...extra })
const reply = (c, batchId, extra = {}, scope = S) => c.observeDecision(scope, { batchId, decision: 'reply', ...extra })
const delivered = (c, batchId, extra = {}, scope = S) => c.observeReply(scope, { batchId, status: 'delivered', ...extra })

test('默认配置有界；归一化不接受非有限数、空串或隐式布尔零，且不修改输入', () => {
  assert.deepEqual(normalizeParticipationConfig(), DEFAULT_PARTICIPATION_CONFIG)
  const raw = { enabled: 'false', targetRate: 9, maxPerHour: '6.9', cooldownMs: -9, burstMax: 0,
    feedbackWindowMs: Infinity, feedbackGain: NaN, burstWindowMs: null, reservationMs: false,
    idleBaseMs: 100, idleMaxMs: 10, idleFactor: 0, maxVirtualBatches: 100000, messagesPerVirtualBatch: '' }
  const before = { ...raw }
  const cfg = normalizeParticipationConfig(raw)
  assert.deepEqual(raw, before)
  assert.equal(cfg.enabled, false)
  assert.equal(cfg.targetRate, 1)
  assert.equal(cfg.maxPerHour, 6)
  assert.equal(cfg.cooldownMs, 0)
  assert.equal(cfg.burstMax, 0)
  assert.equal(cfg.feedbackWindowMs, 300_000)
  assert.equal(cfg.feedbackGain, 1)
  assert.equal(cfg.burstWindowMs, 120_000)
  assert.equal(cfg.reservationMs, 120_000)
  assert.equal(cfg.idleMaxMs, 100)
  assert.equal(cfg.idleFactor, 1)
  assert.equal(cfg.maxVirtualBatches, 100)
  assert.equal(cfg.messagesPerVirtualBatch, 5)
  assert.deepEqual(normalizeParticipationConfig(null), DEFAULT_PARTICIPATION_CONFIG)
  assert.equal(Object.isFrozen(DEFAULT_PARTICIPATION_CONFIG), true)
})

test('检查与诊断不创建决策、不计成功、不为未使用的聊天分配状态', () => {
  const { c, advance } = fixture()
  for (let n = 0; n < 30; n++) {
    const r = c.evaluate(S)
    assert.equal(r.allowed, true)
    assert.equal(r.probability, 0.15)
    advance(1)
  }
  assert.equal(c.snapshot(S).decisions, 0)
  assert.equal(c.snapshot(S).actualReplies, 0)
  assert.deepEqual(c.snapshot(), [])
  assert.equal(c.snapshot(S).idle.consecutiveSkips, 0)
})

test('同一批多消息/虚拟批次只增加一次退避；重复事件和频率检查不会续期', () => {
  const { c, advance } = fixture()
  skip(c, 'batch', { messageCount: 500, virtualBatches: 20, backlogBatches: 50 })
  const before = c.snapshot(S)
  assert.equal(before.decisions, 1)
  assert.equal(before.virtualBatches, 20)
  assert.equal(before.expectedReplies, 3)
  assert.deepEqual(before.idle, { consecutiveSkips: 1, delayMs: 5000, until: 5000, remainingMs: 5000 })
  advance(1000)
  for (let n = 0; n < 30; n++) {
    assert.equal(skip(c, 'batch').reason, 'duplicate')
    assert.equal(c.evaluate(S).reason, 'idle_backoff')
  }
  assert.equal(c.snapshot(S).idle.until, 5000)
  assert.equal(c.snapshot(S).expectedReplies, 3)
  assert.throws(() => reply(c, 'batch'), /决策不能改变/)
})

test('连续实际 skip 指数退避并封顶，等到边界后才允许自动检查', () => {
  const { c, advance } = fixture({ idleBaseMs: 10, idleFactor: 2, idleMaxMs: 35 })
  for (const [index, delay] of [10, 20, 35, 35].entries()) {
    skip(c, `skip-${index}`)
    assert.equal(c.snapshot(S).idle.delayMs, delay)
    assert.equal(c.evaluate(S).retryAfterMs, delay)
    advance(delay - 1)
    assert.equal(c.evaluate(S).allowed, false)
    advance(1)
    assert.equal(c.evaluate(S).allowed, true)
  }
  reply(c, 'action')
  assert.equal(c.snapshot(S).idle.consecutiveSkips, 0, '选择行动结束无动作序列，不等外部调用成功')
  assert.equal(c.snapshot(S).actualReplies, 0, '选择行动不等于已发出')
})

test('wait、执行错误、限流挡回不算主动选择不参与，同批之后可作实际决定', () => {
  const { c } = fixture()
  for (const decision of ['wait', 'error', 'throttled']) {
    assert.equal(c.observeDecision(S, { batchId: 'b', decision }).reason, 'not_participation_decision')
  }
  assert.deepEqual(c.snapshot(), [])
  assert.equal(skip(c, 'b').accepted, true)
  assert.equal(c.snapshot(S).idle.consecutiveSkips, 1)
})

test('预计量与成功量分开；计划、未知、失败、试运行都不能冒充送达', () => {
  const { c } = fixture(relaxed)
  reply(c, 'one', { virtualBatches: 2 })
  assert.equal(c.snapshot(S).expectedReplies, 0.3)
  assert.equal(c.snapshot(S).actualReplies, 0)
  assert.equal(c.snapshot(S).pendingReplies, 1)
  assert.equal(c.observeReply(S, { batchId: 'one', status: 'unknown' }).accepted, false)
  assert.equal(c.snapshot(S).pendingReplies, 1)
  assert.equal(c.observeReply(S, { batchId: 'one', status: 'failed' }).accepted, false)
  assert.equal(c.snapshot(S).pendingReplies, 0)
  assert.equal(delivered(c, 'one', { dryRun: true }).reason, 'dry_run')
  assert.equal(c.snapshot(S).actualReplies, 0)
  assert.equal(delivered(c, 'one').accepted, true)
  assert.equal(c.snapshot(S).actualReplies, 1)
  assert.equal(c.snapshot(S).expectedReplies, 0.3)
  for (let bubble = 0; bubble < 10; bubble++) assert.equal(delivered(c, 'one', { deliveredCount: bubble + 1 }).reason, 'duplicate')
  assert.equal(c.snapshot(S).actualReplies, 1)
  c.observeReply(S, { batchId: 'one', status: 'unknown' })
  assert.equal(c.snapshot(S).actualReplies, 1, '旧/重复非成功回执不能撤销已经确认的成功')
})

test('partial 只有明确成功段才计一次回复，部分成功随后全成功不能复制计数', () => {
  const { c } = fixture(relaxed)
  reply(c, 'partial')
  assert.equal(c.observeReply(S, { batchId: 'partial', status: 'partial', deliveredCount: 0 }).accepted, false)
  assert.equal(c.snapshot(S).actualReplies, 0)
  assert.equal(c.observeReply(S, { batchId: 'partial', status: 'partial', deliveredCount: 2 }).accepted, true)
  assert.equal(delivered(c, 'partial', { deliveredCount: 3 }).accepted, false)
  assert.equal(c.snapshot(S).hour.successful, 1)
  assert.throws(() => delivered(c, 'bad', { deliveredCount: 0 }), /零个/)
  assert.throws(() => delivered(c, 'bad', { deliveredCount: NaN }), /非负整数/)
})

test('在途回复预留自动容量；明确失败释放，未知不续租也不提前释放', () => {
  const { c, advance } = fixture({ ...relaxed, maxPerHour: 1, reservationMs: 100 })
  assert.equal(c.evaluate(S).allowed, true)
  reply(c, 'pending')
  assert.equal(c.evaluate(S).reason, 'hourly_quota')
  assert.equal(c.snapshot(S).hour.successful, 0)
  assert.equal(c.snapshot(S).hour.reserved, 1)
  advance(99)
  c.observeReply(S, { batchId: 'pending', status: 'unknown' })
  assert.equal(c.evaluate(S).retryAfterMs, 1)
  advance(1)
  assert.equal(c.evaluate(S).allowed, true)
  assert.equal(c.snapshot(S).actualReplies, 0, '预留到期不伪造成功或授权重发')
  reply(c, 'next')
  c.observeReply(S, { batchId: 'next', status: 'rejected' })
  assert.equal(c.evaluate(S).allowed, true)
  delivered(c, 'pending')
  assert.equal(c.snapshot(S).hour.successful, 1, '迟到的确认回执仍计量')
  assert.equal(c.evaluate(S).allowed, false)
})

test('突发消息及积压在当前批次检查前先收紧概率，不靠事后回执才调整', () => {
  const { c } = fixture()
  const normal = c.evaluate(S)
  const burst = c.evaluate(S, { messageCount: 100 })
  const backlog = c.evaluate(S, { backlogBatches: 10 })
  assert.equal(burst.allowed, true)
  assert.ok(burst.probability > 0 && burst.probability < normal.probability)
  assert.ok(backlog.probability < normal.probability)
  assert.equal(burst.diagnostics.burst.pressure, 19)
  assert.equal(burst.diagnostics.expectedReplies, 0, '积压不是可以补发的参与额度')
  assert.deepEqual(c.evaluate(S, { messageCount: 100 }), burst, '检查本身不能重复积累压力')
  assert.deepEqual(c.snapshot(), [])
})

test('虚拟批次有上限、可显式提供合并批数；backlog 不重复增加预计量', () => {
  const { c } = fixture({ ...relaxed, messagesPerVirtualBatch: 5, maxVirtualBatches: 4 })
  skip(c, 'five', { messageCount: 5 })
  skip(c, 'six', { messageCount: 6 })
  skip(c, 'many', { messageCount: 50000, backlogBatches: 999 })
  skip(c, 'explicit-units', { messageCount: 999, virtualBatches: 2 })
  const s = c.snapshot(S)
  assert.equal(s.decisions, 4)
  assert.equal(s.virtualBatches, 9)
  assert.ok(Math.abs(s.expectedReplies - 1.35) < 1e-12)
  assert.equal(s.idle.consecutiveSkips, 4)
  assert.throws(() => skip(c, 'zero', { virtualBatches: 0 }), /至少/)
  assert.throws(() => c.evaluate(S, { backlogBatches: Infinity }), /非负整数/)
})

test('短时间连续批次形成持续突发反馈，窗口过去会恢复，不按原始消息逐条记', () => {
  const { c, advance } = fixture({ ...relaxed, burstGain: 1, burstFreeBatches: 2, burstWindowMs: 100 })
  const baseline = c.evaluate(S).probability
  skip(c, 'a')
  skip(c, 'b')
  assert.ok(c.evaluate(S).probability < baseline)
  assert.equal(c.snapshot(S).burst.virtualBatches, 2)
  advance(100)
  assert.equal(c.evaluate(S).probability, baseline)
})

test('成功回复超过预计量会收紧反馈，少发或长期空闲不会积攒追赶补发概率', () => {
  const { c, advance } = fixture({ ...relaxed, feedbackWindowMs: 100 })
  reply(c, 'sent')
  delivered(c, 'sent')
  assert.equal(c.snapshot(S).feedback.surplus, 0.85)
  assert.ok(c.evaluate(S).probability < 0.15)
  assert.equal(c.snapshot(S).actualReplies, 1)
  advance(100)
  assert.equal(c.evaluate(S).probability, 0.15)
  for (let n = 0; n < 30; n++) skip(c, `quiet-${n}`, { virtualBatches: 20 })
  assert.ok(c.snapshot(S).expectedReplies > c.snapshot(S).actualReplies)
  assert.equal(c.evaluate(S).probability, 0.15, '少发只恢复到基线，不加速追赶')
  advance(HOUR)
  assert.equal(c.snapshot(S).virtualBatches, 0)
  assert.equal(c.snapshot(S).expectedReplies, 0)
  assert.equal(c.evaluate(S).probability, 0.15)
})

test('显式请求、当前请求补充和任务完成绕过所有自动限制，但不伪造成功', () => {
  const { c } = fixture({ enabled: false, targetRate: 0, maxPerHour: 0, burstMax: 0 })
  skip(c, 'idle')
  assert.equal(c.evaluate(S).allowed, false)
  assert.equal(c.evaluate(S).nextCheckAt, null)
  for (const trigger of ['explicit', 'followup', 'task_complete']) {
    const r = c.evaluate(S, { trigger, backlogBatches: 1000 })
    assert.equal(r.allowed, true)
    assert.equal(r.probability, 1)
    assert.equal(r.bypass, true)
    reply(c, trigger, { trigger })
    assert.equal(c.snapshot(S).actualReplies, 0)
    delivered(c, trigger)
  }
  assert.equal(c.evaluate(S, { explicit: true }).allowed, true)
  assert.equal(c.snapshot(S).explicitReplies, 3)
  assert.equal(c.snapshot(S).hour.successful, 0)
  assert.equal(c.snapshot(S).idle.consecutiveSkips, 0)
  assert.equal(c.snapshot(S).automaticDecisions, 1)
  assert.throws(() => c.evaluate(S, { trigger: 'admin' }), /未知/)
})

test('显式回复和自动回复分开计小时额度；显式成功仍让自动插话冷却并限制突发', () => {
  const { c, advance } = fixture({ ...relaxed, maxPerHour: 1, cooldownMs: 10, burstMax: 1, burstWindowMs: 100 })
  reply(c, 'explicit', { explicit: true })
  delivered(c, 'explicit')
  const s = c.snapshot(S)
  assert.equal(s.hour.successful, 0)
  assert.equal(s.actualReplies, 0)
  assert.equal(s.explicitReplies, 1)
  assert.equal(c.evaluate(S).reason, 'cooldown')
  assert.equal(c.evaluate(S).retryAfterMs, 100, '下一次检查考虑所有限制而非只看第一个原因')
  advance(10)
  assert.equal(c.evaluate(S).reason, 'burst_quota')
  assert.equal(c.evaluate(S, { explicit: true }).allowed, true)
  advance(90)
  assert.equal(c.evaluate(S).allowed, true)
})

test('小时额度从成功时刻计，零时刻回执有效，精确到窗口边界恢复', () => {
  const { c, advance } = fixture({ ...relaxed, maxPerHour: 2 })
  reply(c, 'a'); delivered(c, 'a')
  advance(20)
  reply(c, 'b'); delivered(c, 'b')
  assert.equal(c.evaluate(S).reason, 'hourly_quota')
  assert.equal(c.evaluate(S).retryAfterMs, HOUR - 20)
  advance(HOUR - 21)
  assert.equal(c.evaluate(S).allowed, false)
  advance(1)
  assert.equal(c.evaluate(S).allowed, true)
  assert.equal(c.snapshot(S).hour.successful, 1)
})

test('同账号不同聊天、同聊天不同账号和相同 batchId 互不影响', () => {
  const { c } = fixture({ ...relaxed, maxPerHour: 1 })
  const otherChat = { account: '100', chat: 'private:1' }
  const otherAccount = { accountId: '200', chatId: S.chatId }
  reply(c, 'same'); delivered(c, 'same')
  assert.equal(c.evaluate(S).allowed, false)
  assert.equal(c.evaluate(otherChat).allowed, true)
  assert.equal(c.evaluate(otherAccount).allowed, true)
  reply(c, 'same', {}, otherChat); delivered(c, 'same', {}, otherChat)
  reply(c, 'same', {}, otherAccount); delivered(c, 'same', {}, otherAccount)
  assert.equal(c.snapshot().length, 3)
  assert.ok(c.snapshot().every((s) => s.actualReplies === 1))
  assert.throws(() => c.evaluate({ chatId: 'group:1' }), /account/)
  assert.throws(() => c.evaluate({ account: '100' }), /chat/)
  assert.throws(() => c.evaluate({ account: NaN, chatId: 'group:1' }), /account/)
  assert.throws(() => c.observeDecision(S, { decision: 'skip' }), /batchId/)
})

test('先到成功回执、后到决策不会重复统计；同毫秒迟到旧回执不清除新退避', () => {
  const { c } = fixture({ ...relaxed, idleBaseMs: 10 })
  delivered(c, 'early')
  reply(c, 'early')
  assert.equal(c.snapshot(S).actualReplies, 1)
  assert.equal(c.snapshot(S).automaticDecisions, 1)
  assert.equal(c.snapshot(S).pendingReplies, 0)
  reply(c, 'late')
  skip(c, 'new-skip')
  const until = c.snapshot(S).idle.until
  delivered(c, 'late')
  assert.equal(c.snapshot(S).idle.until, until)
  assert.equal(c.snapshot(S).idle.consecutiveSkips, 1)
  assert.equal(c.snapshot(S).actualReplies, 2)
  delivered(c, 'orphan')
  assert.equal(c.snapshot(S).idle.until, until, '没有对应决策的恢复回执只计成功，不清退避')
})

test('时钟回拨不会提前解除冷却或重算批次，非有限时钟值拒绝进入状态', () => {
  const { c, time } = fixture({ ...relaxed, cooldownMs: 100 })
  time(1000)
  delivered(c, 'at-1000')
  time(500)
  assert.equal(c.snapshot(S).at, 1000)
  assert.equal(c.evaluate(S).retryAfterMs, 100)
  time(1100)
  assert.equal(c.evaluate(S).allowed, true)
  time(NaN)
  assert.throws(() => c.evaluate(S), /有限毫秒/)
})

test('动态配置按账号聊天读取；配置副本与诊断副本不能改写内部状态', () => {
  const overrides = new Map()
  const c = createParticipationController({ now: () => 0, getConfig: (scope) => overrides.get(scope.account) })
  overrides.set('100', { targetRate: 0.4 })
  assert.equal(c.evaluate(S).probability, 0.4)
  assert.equal(c.evaluate({ account: '200', chatId: S.chatId }).probability, 0.15)
  const snapshot = c.snapshot(S)
  snapshot.config.enabled = false
  snapshot.scope.account = 'attacker'
  snapshot.idle.consecutiveSkips = 500
  assert.equal(c.evaluate(S).allowed, true)
  assert.equal(c.snapshot(S).idle.consecutiveSkips, 0)
  overrides.set('100', { enabled: false })
  assert.equal(c.evaluate(S).allowed, false)
  assert.equal(c.evaluate(S, { explicit: true }).allowed, true)
  assert.throws(() => createParticipationController({ getConfig: async () => ({}) }).evaluate(S), /必须同步/)
})

test('reset 精确按范围清理；过期状态回收，空闲不会凭空增加预计量', () => {
  const { c, advance } = fixture(relaxed)
  const other = { account: '200', chatId: 'private:1' }
  skip(c, 'one')
  skip(c, 'two', {}, other)
  assert.deepEqual(c.reset(S), { removed: 1 })
  assert.equal(c.snapshot(S).decisions, 0)
  assert.equal(c.snapshot(other).decisions, 1)
  assert.deepEqual(c.reset(S), { removed: 0 })
  advance(2 * HOUR)
  assert.deepEqual(c.snapshot(), [])
  assert.equal(c.snapshot(other).expectedReplies, 0)
  assert.equal(skip(c, 'two', {}, other).accepted, true, '去重保留窗口有明确边界')
  assert.deepEqual(c.reset(), { removed: 1 })
  assert.deepEqual(c.snapshot(), [])
})

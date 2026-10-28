// 纯内存参与控制器：不调用模型、不发送消息、不访问磁盘、不创建定时器。
// 调用方负责授权、静默时段、话题相关性与随机抽样；这里仅给出自动参与的容量和概率。
// 所有时间来自注入的本机单调时钟，绝不能传平台消息时间。

const HOUR = 3600_000
const RETENTION_MS = 2 * HOUR
const TRIGGERS = new Set(['automatic', 'explicit', 'followup', 'task_complete'])
const NON_DECISIONS = new Set(['wait', 'error', 'throttled'])
const REPLY_STATES = new Set(['delivered', 'partial', 'unknown', 'failed', 'rejected', 'not_sent', 'skipped', 'canceled', 'pending', 'sending'])
const DEFINITE_FAILURES = new Set(['failed', 'rejected', 'not_sent', 'skipped', 'canceled'])

export const DEFAULT_PARTICIPATION_CONFIG = Object.freeze({
  enabled: true, // 只控制自动插话；有效显式请求仍可绕过。
  targetRate: 0.15,
  maxPerHour: 6,
  cooldownMs: 90_000,
  burstMax: 8,
  burstWindowMs: 120_000,
  feedbackWindowMs: 300_000,
  feedbackGain: 1,
  burstFreeBatches: 4,
  burstGain: 0.5,
  messagesPerVirtualBatch: 5,
  maxVirtualBatches: 20,
  idleBaseMs: 5000,
  idleMaxMs: 300_000,
  idleFactor: 2,
  reservationMs: 120_000,
})

/** 数字字符串可用；空值、NaN、Infinity 等回退默认，范围越界则夹取。 */
export function normalizeParticipationConfig(input = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const number = (key, min, max, integer = false) => {
    const value = raw[key]
    const n = (typeof value === 'number' || (typeof value === 'string' && value.trim())) ? Number(value) : NaN
    const bounded = Math.max(min, Math.min(max, Number.isFinite(n) ? n : DEFAULT_PARTICIPATION_CONFIG[key]))
    return integer ? Math.floor(bounded) : bounded
  }
  const idleBaseMs = number('idleBaseMs', 0, HOUR, true)
  return {
    enabled: raw.enabled === false || raw.enabled === 'false' ? false : true,
    targetRate: number('targetRate', 0, 1),
    maxPerHour: number('maxPerHour', 0, 10000, true),
    cooldownMs: number('cooldownMs', 0, HOUR, true),
    burstMax: number('burstMax', 0, 10000, true),
    burstWindowMs: number('burstWindowMs', 1, HOUR, true),
    feedbackWindowMs: number('feedbackWindowMs', 1, HOUR, true),
    feedbackGain: number('feedbackGain', 0, 10),
    burstFreeBatches: number('burstFreeBatches', 1, 1000, true),
    burstGain: number('burstGain', 0, 10),
    messagesPerVirtualBatch: number('messagesPerVirtualBatch', 1, 1000, true),
    maxVirtualBatches: number('maxVirtualBatches', 1, 100, true),
    idleBaseMs,
    idleMaxMs: Math.max(idleBaseMs, number('idleMaxMs', 0, HOUR, true)),
    idleFactor: number('idleFactor', 1, 8),
    reservationMs: number('reservationMs', 1, HOUR, true),
  }
}

function scopeOf(scope) {
  const account = scope?.account ?? scope?.accountId
  const chatId = scope?.chatId ?? scope?.chat
  if (!['string', 'number'].includes(typeof account) || !String(account).trim() || String(account).length > 128 ||
      (typeof account === 'number' && !Number.isSafeInteger(account))) throw new TypeError('participation 需要有效 account/accountId')
  if (typeof chatId !== 'string' || !/^(private|group|system):[\w-]{1,128}$/.test(chatId)) throw new TypeError('participation 需要有效 chatId/chat')
  return { account: String(account).trim(), chatId }
}
const keyOf = (scope) => JSON.stringify([scope.account, scope.chatId])
function batchIdOf(event) {
  if (typeof event?.batchId !== 'string' || !event.batchId.trim() || event.batchId.length > 512) throw new TypeError('需要稳定的 batchId')
  return event.batchId
}
function triggerOf(event, existing) {
  const trigger = event.trigger ?? (event.explicit === true ? 'explicit' : existing?.trigger ?? 'automatic')
  if (!TRIGGERS.has(trigger)) throw new TypeError('未知 participation trigger')
  if (existing && existing.trigger !== trigger) throw new Error('同 batchId 的 trigger 不能改变')
  return trigger
}
function count(value, fallback, name) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} 必须是非负整数`)
  return value
}
function loadOf(event, config) {
  const messages = count(event.messageCount, 1, 'messageCount')
  const units = count(event.virtualBatches, Math.max(1, Math.ceil(messages / config.messagesPerVirtualBatch)), 'virtualBatches')
  if (!units) throw new TypeError('virtualBatches 至少为 1')
  return { virtualBatches: Math.min(config.maxVirtualBatches, units), backlogBatches: Math.min(10000, count(event.backlogBatches, 0, 'backlogBatches')) }
}
const fresh = (scope) => ({ scope, records: new Map(), sequence: 0, lastSkipSequence: 0,
  idleSkips: 0, idleUntil: 0, idleDelayMs: 0, touchedAt: -Infinity })
const newRecord = (id, trigger, at) => ({ id, trigger, decision: null, decisionAt: null, virtualBatches: 0,
  decisionSequence: null, expectedReplies: 0, replyAt: null, reservedUntil: 0, lastStatus: null, updatedAt: at })
const clearIdle = (state) => { state.idleSkips = 0; state.idleUntil = 0; state.idleDelayMs = 0; state.lastSkipSequence = 0 }

/**
 * evaluate(scope, {trigger?, explicit?, messageCount?, virtualBatches?, backlogBatches?})
 *   => {allowed, reason, probability, bypass, nextCheckAt, retryAfterMs, diagnostics}
 *   allowed 仅表示容量允许；调用方仍需判断相关性，并用自己的 RNG 与 probability 比较。
 *   evaluate 不预留额度。批次作出 reply 决定时应立即调用 observeDecision 预留在途容量。
 * observeDecision(scope, {batchId, decision:'reply'|'skip', ...以上批次字段})
 *   每个实际决策批次调用一次。wait/error/throttled 不算主动选择不参与，不增加退避。
 * observeReply(scope, {batchId, status, deliveredCount?, dryRun?, trigger?})
 *   delivered 或 partial 且 deliveredCount>0 才计一次成功；多段/重复回执按 batchId 去重。
 *   未收到回执的 reply 决定暂占容量；unknown 保留预留，明确未发送释放预留。
 * snapshot(scope?) / reset(scope?)：省略 scope 时分别列出全部范围 / 清空全部范围。
 *
 * 虚拟批次 = 合并前批次数（可显式传入），否则 ceil(messageCount/messagesPerVirtualBatch)，有上限。
 * 它只用于预计量和突发压力，不把一个 skip 算多次，也不把一轮多气泡算多次成功。
 * expected = Σ(targetRate * virtualBatches)，actual = 已确认成功的自动回复批次数。
 * frequencyFactor = 1/(1 + feedbackGain * max(0, actual + pending - expected))。
 * burstFactor = 1/(1 + burstGain * pressure)，当前突发/积压在 evaluate 内先扣减概率。
 * probability <= targetRate；少发不会积攒补发额度，空闲时间不生成虚拟批次。
 *
 * 仅本进程内存状态，保留两小时去重身份；重启/reset 不恢复历史或持久化发送保证。
 * 显式事件必须已由 hub 验证关联请求和权限；这里只绕过自动限额，不作授权判断。
 */
export function createParticipationController({ config = {}, getConfig, now = () => performance.now() } = {}) {
  if (typeof now !== 'function' || (getConfig !== undefined && typeof getConfig !== 'function')) throw new TypeError('now/getConfig 必须是函数')
  const initial = normalizeParticipationConfig(config)
  const states = new Map()
  let lastNow = 0
  function time() {
    const value = now()
    if (!Number.isFinite(value) || value < 0) throw new TypeError('now() 必须返回非负有限毫秒数')
    lastNow = Math.max(lastNow, value) // 注入时钟回拨不能提前解禁或制造负时长。
    for (const [key, state] of states) {
      for (const [id, r] of state.records) if (lastNow - r.updatedAt >= RETENTION_MS) state.records.delete(id)
      if (!state.records.size && lastNow - state.touchedAt >= RETENTION_MS) states.delete(key)
    }
    return lastNow
  }
  function settings(scope) {
    const overrides = getConfig?.({ ...scope })
    if (overrides?.then) throw new TypeError('getConfig 必须同步')
    return normalizeParticipationConfig({ ...initial, ...overrides })
  }
  function read(scope) { return states.get(keyOf(scope)) || fresh(scope) }
  function save(state, at) { state.touchedAt = at; states.set(keyOf(state.scope), state) }
  function metrics(state, cfg, at, incoming = { virtualBatches: 0, backlogBatches: 0 }) {
    const records = [...state.records.values()]
    const within = (value, window) => value !== null && at - value < window
    const auto = (r) => r.trigger === 'automatic'
    const decisions = records.filter((r) => r.decision !== null && within(r.decisionAt, cfg.feedbackWindowMs))
    const autoDecisions = decisions.filter(auto)
    const successes = records.filter((r) => r.replyAt !== null)
    const recent = successes.filter((r) => within(r.replyAt, cfg.feedbackWindowMs))
    const pending = records.filter((r) => auto(r) && r.replyAt === null && r.reservedUntil > at)
    const expectedReplies = autoDecisions.reduce((n, r) => n + r.expectedReplies, 0)
    const actualReplies = recent.filter(auto).length
    const surplus = Math.max(0, actualReplies + pending.length - expectedReplies)
    const frequencyFactor = 1 / (1 + cfg.feedbackGain * surplus)
    const recentVirtual = records.filter((r) => auto(r) && r.decision !== null && within(r.decisionAt, cfg.burstWindowMs))
      .reduce((n, r) => n + r.virtualBatches, 0)
    const pressure = Math.max(0, incoming.virtualBatches + incoming.backlogBatches - 1,
      recentVirtual + incoming.virtualBatches + incoming.backlogBatches - cfg.burstFreeBatches)
    const burstFactor = 1 / (1 + cfg.burstGain * pressure)
    const lastReplyAt = successes.reduce((latest, r) => latest === null ? r.replyAt : Math.max(latest, r.replyAt), null)
    // 显式成功不消耗自动小时配额，但会让自动插话冷却并计入防刷屏窗口。
    const hourExpiries = successes.filter((r) => auto(r) && within(r.replyAt, HOUR)).map((r) => r.replyAt + HOUR)
    const burstExpiries = successes.filter((r) => within(r.replyAt, cfg.burstWindowMs)).map((r) => r.replyAt + cfg.burstWindowMs)
    const reservedExpiries = pending.map((r) => r.reservedUntil)
    const fullUntil = (expiries, cap) => expiries.length < cap ? at : cap === 0 ? null : expiries.sort((a, b) => a - b)[expiries.length - cap]
    return {
      scope: { ...state.scope }, at, config: { ...cfg }, retentionMs: RETENTION_MS, retainedBatches: records.length,
      decisions: decisions.length, automaticDecisions: autoDecisions.length,
      virtualBatches: autoDecisions.reduce((n, r) => n + r.virtualBatches, 0), expectedReplies,
      actualReplies, explicitReplies: recent.filter((r) => !auto(r)).length, pendingReplies: pending.length,
      lastReplyAt, cooldownUntil: lastReplyAt === null ? 0 : lastReplyAt + cfg.cooldownMs,
      hour: { successful: hourExpiries.length, reserved: pending.length, remaining: Math.max(0, cfg.maxPerHour - hourExpiries.length - pending.length),
        limitedUntil: fullUntil([...hourExpiries, ...reservedExpiries], cfg.maxPerHour) },
      burst: { successful: burstExpiries.length, reserved: pending.length, virtualBatches: recentVirtual, pressure,
        remaining: Math.max(0, cfg.burstMax - burstExpiries.length - pending.length), limitedUntil: fullUntil([...burstExpiries, ...reservedExpiries], cfg.burstMax) },
      idle: { consecutiveSkips: state.idleSkips, delayMs: state.idleDelayMs, until: state.idleUntil, remainingMs: Math.max(0, state.idleUntil - at) },
      feedback: { surplus, frequencyFactor, burstFactor, probability: cfg.targetRate * frequencyFactor * burstFactor },
    }
  }
  function evaluate(scopeInput, event = {}) {
    const scope = scopeOf(scopeInput), at = time(), cfg = settings(scope)
    const trigger = triggerOf(event)
    const diagnostics = metrics(read(scope), cfg, at, loadOf(event, cfg))
    if (trigger !== 'automatic') return { allowed: true, reason: trigger, probability: 1, bypass: true, nextCheckAt: at, retryAfterMs: 0, diagnostics }
    const disabled = !cfg.enabled || cfg.targetRate === 0 || cfg.maxPerHour === 0 || cfg.burstMax === 0
    const blocks = [
      ['idle_backoff', diagnostics.idle.until], ['cooldown', diagnostics.cooldownUntil],
      ['hourly_quota', diagnostics.hour.limitedUntil], ['burst_quota', diagnostics.burst.limitedUntil],
    ].filter(([, until]) => until !== null && until > at)
    const allowed = !disabled && blocks.length === 0
    const nextCheckAt = disabled ? null : Math.max(at, ...blocks.map(([, until]) => until))
    return { allowed, reason: disabled ? 'automatic_disabled' : blocks[0]?.[0] || 'available',
      probability: allowed ? diagnostics.feedback.probability : 0, bypass: false,
      nextCheckAt, retryAfterMs: nextCheckAt === null ? null : nextCheckAt - at, diagnostics }
  }
  function observeDecision(scopeInput, event = {}) {
    const scope = scopeOf(scopeInput), id = batchIdOf(event), at = time(), cfg = settings(scope)
    const state = read(scope), existing = state.records.get(id)
    const trigger = triggerOf(event, existing)
    if (NON_DECISIONS.has(event.decision)) return { accepted: false, reason: 'not_participation_decision' }
    if (!['reply', 'skip'].includes(event.decision)) throw new TypeError('decision 必须为 reply/skip（wait/error/throttled 不计反馈）')
    const load = loadOf(event, cfg)
    if (existing?.decision !== null && existing?.decision !== undefined) {
      if (existing.decision !== event.decision) throw new Error('同 batchId 的决策不能改变；重试回合使用新的决策 batchId')
      return { accepted: false, reason: 'duplicate' }
    }
    const r = existing || newRecord(id, trigger, at)
    Object.assign(r, { decision: event.decision, decisionAt: at, decisionSequence: ++state.sequence, virtualBatches: load.virtualBatches,
      expectedReplies: trigger === 'automatic' ? cfg.targetRate * load.virtualBatches : 0, updatedAt: at })
    if (trigger !== 'automatic' || event.decision === 'reply') clearIdle(state)
    else {
      state.lastSkipSequence = r.decisionSequence
      state.idleSkips = Math.min(1024, state.idleSkips + 1)
      state.idleDelayMs = cfg.idleBaseMs === 0 ? 0 : Math.min(cfg.idleMaxMs, cfg.idleBaseMs * cfg.idleFactor ** Math.min(1023, state.idleSkips - 1))
      state.idleUntil = at + state.idleDelayMs
    }
    if (trigger === 'automatic' && event.decision === 'reply' && r.replyAt === null && !DEFINITE_FAILURES.has(r.lastStatus)) r.reservedUntil = at + cfg.reservationMs
    state.records.set(id, r)
    save(state, at)
    return { accepted: true, reason: 'observed', diagnostics: metrics(state, cfg, at) }
  }
  function observeReply(scopeInput, event = {}) {
    const scope = scopeOf(scopeInput), id = batchIdOf(event), at = time(), cfg = settings(scope)
    if (!REPLY_STATES.has(event.status)) throw new TypeError('未知发送回执状态')
    const deliveredCount = count(event.deliveredCount, event.status === 'delivered' ? 1 : 0, 'deliveredCount')
    if (event.status === 'delivered' && deliveredCount === 0) throw new TypeError('delivered 回执不能是零个成功段')
    const state = read(scope), existing = state.records.get(id), trigger = triggerOf(event, existing)
    const confirmed = !event.dryRun && (event.status === 'delivered' || event.status === 'partial' && deliveredCount > 0)
    if (!confirmed) {
      if (existing && existing.replyAt === null) {
        existing.lastStatus = event.dryRun ? 'skipped' : event.status
        if (event.dryRun || DEFINITE_FAILURES.has(event.status)) existing.reservedUntil = 0
        // 未知回执不续租，也不释放在途容量；到期后只是频率预留失效，不代表可以重发。
      }
      return { accepted: false, reason: event.dryRun ? 'dry_run' : 'not_confirmed' }
    }
    if (existing?.replyAt !== null && existing?.replyAt !== undefined) return { accepted: false, reason: 'duplicate' }
    const r = existing || newRecord(id, trigger, at)
    Object.assign(r, { replyAt: at, reservedUntil: 0, lastStatus: event.status, updatedAt: at })
    state.records.set(id, r)
    // 迟到回执可计成功，但不能清除它之后新批次主动 skip 建立的退避。
    // 用接收序号区分同毫秒内的决定；没有对应决策的恢复回执不能擦掉当前退避。
    const newerSkip = state.lastSkipSequence > (r.decisionSequence ?? 0)
    if (!newerSkip) clearIdle(state)
    save(state, at)
    return { accepted: true, reason: 'confirmed', diagnostics: metrics(state, cfg, at) }
  }
  function snapshot(scopeInput) {
    const at = time()
    if (scopeInput === undefined) return [...states.values()].map((s) => metrics(s, settings(s.scope), at))
    const scope = scopeOf(scopeInput)
    return metrics(read(scope), settings(scope), at)
  }
  function reset(scopeInput) {
    if (scopeInput === undefined) { const removed = states.size; states.clear(); return { removed } }
    return { removed: Number(states.delete(keyOf(scopeOf(scopeInput)))) }
  }
  return { evaluate, observeDecision, observeReply, snapshot, reset }
}

// 宿主回归：真实 WS 入站、聚合 dispatch、fake DSH 回合与 OneBot HTTP 回执。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { startMockOneBot } from './helpers/mock-onebot.js'

const BOT = '20000002', OWNER = '10000001', MEMBER = 30000003
const GROUP = { policySkip: '61001', modelSkip: '61002', explicit: '61003', success: '61004', rejected: '61005', unknown: '61006', dryRun: '61007', partial: '61008' }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(label, predicate) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await sleep(20)
  }
  throw new Error(`等待超时：${label}`)
}
let root, fake, gateway, host, originalFetch, seq = 0
const originalEnv = Object.fromEntries(['AURABOT_DATA_DIR', 'AURABOT_WORKSPACE', 'DSH_HOME'].map((key) => [key, process.env[key]]))
const attempts = new Map()
const state = (groupId) => host.hub.participation().find((s) => s.scope.account === BOT && s.scope.chatId === `group:${groupId}`)
const sends = (groupId) => gateway.sent('send_group_msg').filter((c) => String(c.params.group_id) === groupId)
const decisions = async (groupId) => (await fake.call(`/diagnostics/decisions?chatId=group:${groupId}`)).json().list
function push(groupId, message, { mentioned = false } = {}) {
  gateway.push({ message_type: 'group', sub_type: 'normal', group_id: Number(groupId), user_id: MEMBER,
    message_id: ++seq, sender: { user_id: MEMBER, nickname: '测试群友', card: '测试群友', role: 'member' },
    message: [...(mentioned ? [{ type: 'at', data: { qq: BOT } }] : []), { type: 'text', data: { text: message } }] })
}
async function completed(groupId, expectedState = 'answered') {
  const request = await until(`${groupId} 请求结束为 ${expectedState}`, async () => {
    const result = (await fake.call(`/diagnostics/requests?chatId=group:${groupId}`)).json()
    assert.equal(result.ok, true)
    return result.list.find((r) => r.state === expectedState)
  })
  const timeline = (await fake.call(`/diagnostics/timeline?id=${request.id}`)).json()
  assert.equal(timeline.ok, true)
  return { request, receipts: timeline.events.filter((e) => e.kind === 'QQ回执') }
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'aurabot-participation-host-'))
  process.env.AURABOT_DATA_DIR = root
  process.env.AURABOT_WORKSPACE = join(root, 'workspace')
  process.env.DSH_HOME = join(root, 'dsh')
  gateway = await startMockOneBot({ selfId: BOT })
  originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    const target = new URL(String(url))
    assert.equal(target.origin, gateway.httpUrl, '此宿主测试只能访问本机 mock OneBot，禁止外部付费请求')
    if (target.pathname !== '/send_group_msg') return originalFetch(url, options)
    const params = JSON.parse(options.body), groupId = String(params.group_id)
    const attempt = (attempts.get(groupId) || 0) + 1
    attempts.set(groupId, attempt)
    if (groupId === GROUP.rejected) return new Response(JSON.stringify({ status: 'failed', retcode: 100, message: 'fixture: gateway rejected' }), { headers: { 'content-type': 'application/json' } })
    const response = await originalFetch(url, options)
    if (groupId === GROUP.unknown || groupId === GROUP.partial && attempt === 2) {
      await response.arrayBuffer() // 网关实际接收了消息，但客户端没拿到回执，不能算已确认送达。
      throw new TypeError('fixture: receipt connection lost', { cause: { code: 'ECONNRESET' } })
    }
    return response
  }
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    enabled: true, dryRun: false, setupDone: true, botQQ: BOT, ownerQQ: OWNER,
    allow: { private: [OWNER], groups: Object.values(GROUP) },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: gateway.httpUrl, wsUrl: gateway.wsUrl,
      httpToken: gateway.token, wsToken: gateway.token, dir: join(root, 'snowluma-uninstalled') },
    merge: { enabled: true, groupWaitSec: 0.25, groupMaxSec: 2, mentionWaitSec: 0.05 },
    // 自动参与确定性放行，负例通过相关性或模型沉默决定，不替换生产随机函数。
    group: { interjectChance: 1, minRelevance: 0, minRecentMessages: 0, cooldownSec: 0, maxPerHour: 120, quietHours: [0, 0], burstMax: 50,
      overrides: { [GROUP.policySkip]: { minRelevance: 1, interests: ['only-relevant-marker'] },
        [GROUP.explicit]: { minRelevance: 1, interests: ['only-relevant-marker'], burstMax: 1 } } },
    participation: { enabled: true, idleBaseMs: 60000, idleMaxMs: 120000, feedbackGain: 0, burstGain: 0 },
    voice: { enabled: false }, stickers: { enabled: false, collect: false, caption: false, autoChance: 0 },
    speakUp: { enabled: false }, mood: { enabled: false }, memory: { enabled: false }, learning: { enabled: false },
    modules: Object.fromEntries(['stickers', 'voice', 'mood', 'memory', 'learning', 'retrieval', 'search', 'imagegen', 'speakup', 'bili', 'song'].map((id) => [id, { enabled: false }])),
  }))
  fake = createFakeDsh({ brain: async ({ text }) => {
    if (text.includes('MODEL_SKIP')) return '[沉默]'
    if (text.includes('SUCCESS_BATCH')) return '第一句|||第二句|||第三句'
    if (text.includes('PARTIAL_BATCH')) return '已确认的一句|||回执未知的一句'
    return '收到这条请求'
  } })
  host = (await import('../src/host.js')).apply(fake.ctx)
  await host.ready
  const connected = (await fake.call('/onebot/reconnect')).json()
  assert.equal(connected.ok, true, connected.message)
  await until('mock OneBot 连接', () => gateway.connected() > 0)
  const overview = (await fake.call('/state')).json()
  assert.equal(resolve(overview.storage.file), resolve(root, 'aurabot.db'))
})

after(async () => {
  try {
    const disposed = await fake?.dispose()
    assert.ok(!disposed?.some((r) => r.status === 'rejected'), '宿主正常释放后台资源')
  } finally {
    await gateway?.close()
    if (originalFetch) globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    if (root) {
      assert.equal(dirname(resolve(root)), resolve(tmpdir()))
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    }
  }
})

test('宿主：同批三条自动不参与只增加一次退避，退避中后续批次不递增', async () => {
  const groupId = GROUP.policySkip, before = fake.turns.length
  for (const word of ['第一条闲聊', '第二条闲聊', '第三条闲聊']) push(groupId, word)
  await until('一个 dispatch 批次选择不参与', () => state(groupId)?.idle.consecutiveSkips === 1)
  const trace = await decisions(groupId)
  assert.equal(trace.length, 1)
  assert.equal(trace[0].batchSize, 3)
  assert.equal(trace[0].decision.reply, false)
  const replay=(await fake.call('/diagnostics/replay?eventId='+trace[0].id)).json()
  assert.equal(replay.ok,true)
  assert.equal(replay.readOnly,true)
  assert.equal(replay.events[0].recomputation.status,'recomputed')
  assert.equal(replay.events[0].recomputation.matchesRecordedBase,true)
  assert.equal(JSON.stringify(replay).includes('第一条闲聊'),false,'回放不保留聊天正文')
  assert.equal(state(groupId).decisions, 1)
  assert.equal(state(groupId).automaticDecisions, 1)
  assert.equal(fake.turns.length, before)
  const deadline = state(groupId).idle.until
  push(groupId, '退避时的新消息一')
  push(groupId, '退避时的新消息二')
  await until('退避中的批次被挡回', async () => (await decisions(groupId)).length === 2)
  const next = (await decisions(groupId)).find((d) => d.batchSize === 2)
  assert.match(next.decision.reason, /idle_backoff/)
  assert.equal(state(groupId).idle.consecutiveSkips, 1)
  assert.equal(state(groupId).idle.until, deadline)
  assert.equal(state(groupId).decisions, 1)
  assert.equal(sends(groupId).length, 0)
})

test('宿主：模型看完同批多条后选择沉默，也只记录一次 skip', async () => {
  const groupId = GROUP.modelSkip
  for (let i = 0; i < 3; i++) push(groupId, `MODEL_SKIP ${i}`)
  await until('模型沉默后的批次退避', () => state(groupId)?.idle.consecutiveSkips === 1)
  assert.equal(fake.turns.filter((turn) => turn.userText.includes('MODEL_SKIP')).length, 1)
  assert.equal((await decisions(groupId))[0].batchSize, 3)
  assert.equal(state(groupId).decisions, 1)
  assert.equal(state(groupId).actualReplies, 0)
  assert.equal(sends(groupId).length, 0)
})

test('宿主：普通群友显式 @ 绕过退避，达到 burst 上限仍可回应显式请求', async () => {
  const groupId = GROUP.explicit
  push(groupId, '先让她不参与')
  await until('显式测试建立退避', () => state(groupId)?.idle.remainingMs > 0)
  assert.equal(state(groupId).idle.consecutiveSkips, 1)
  push(groupId, '现在请回答', { mentioned: true })
  await until('显式请求实际成功', () => state(groupId)?.explicitReplies === 1)
  assert.equal(state(groupId).idle.consecutiveSkips, 0)
  assert.equal(state(groupId).actualReplies, 0)
  assert.equal(state(groupId).hour.successful, 0, '显式成功不消耗自动小时额度')
  assert.equal(state(groupId).burst.remaining, 0)
  push(groupId, '再明确问一次', { mentioned: true })
  await until('burst 已满仍回应显式请求', () => state(groupId)?.explicitReplies === 2)
  const explicit = (await decisions(groupId)).filter((d) => d.mentioned)
  assert.equal(explicit.length, 2)
  assert.ok(explicit.every((d) => d.decision.reply && d.decision.mode === 'must'))
  assert.equal(sends(groupId).length, 2)
})

test('宿主：一批三条输入、三气泡成功回执只记一次自动回复', async () => {
  const groupId = GROUP.success
  for (let i = 0; i < 3; i++) push(groupId, `SUCCESS_BATCH ${i}`)
  const { receipts } = await completed(groupId)
  assert.equal((await decisions(groupId))[0].batchSize, 3)
  assert.equal(fake.turns.filter((turn) => turn.userText.includes('SUCCESS_BATCH')).length, 1)
  assert.equal(receipts.length, 3)
  assert.ok(receipts.every((row) => row.state === 'delivered' && row.info.messageId))
  assert.equal(sends(groupId).length, 3)
  assert.equal(state(groupId).automaticDecisions, 1)
  assert.equal(state(groupId).actualReplies, 1)
  assert.equal(state(groupId).hour.successful, 1)
  assert.equal(state(groupId).burst.successful, 1)
  assert.equal(state(groupId).pendingReplies, 0)
  const summary = (await fake.call('/diagnostics/summary')).json()
  assert.equal(summary.participation.find((s) => s.scope.chatId === `group:${groupId}`).actualReplies, 1)
})

test('宿主：网关明确拒绝的自动回复不计成功', async () => {
  const groupId = GROUP.rejected
  push(groupId, 'REJECTED_BATCH')
  const { receipts } = await completed(groupId, 'ended')
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].state, 'failed')
  assert.equal(attempts.get(groupId), 1)
  assert.equal(sends(groupId).length, 0)
  assert.equal(state(groupId).automaticDecisions, 1)
  assert.equal(state(groupId).idle.consecutiveSkips, 0, '决定回复但发送失败不能登记为主动沉默')
  assert.equal(state(groupId).actualReplies, 0)
  assert.equal(state(groupId).hour.successful, 0)
  assert.equal(state(groupId).pendingReplies, 0)
})

test('宿主：网关收到但回执丢失为 unknown，不计成功、不自动补发', async () => {
  const groupId = GROUP.unknown
  push(groupId, 'UNKNOWN_BATCH')
  const { receipts } = await completed(groupId, 'delivery_unknown')
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].state, 'unknown')
  assert.equal(sends(groupId).length, 1, '模拟真实网关已执行而客户端结果未知')
  assert.equal(attempts.get(groupId), 1)
  assert.equal(state(groupId).automaticDecisions, 1)
  assert.equal(state(groupId).idle.consecutiveSkips, 0, '决定回复但结果未知不能增加退避')
  assert.equal(state(groupId).actualReplies, 0)
  assert.equal(state(groupId).hour.successful, 0)
  assert.equal(state(groupId).pendingReplies, 1, `unknown 仍占在途预留：${JSON.stringify(state(groupId))}`)
})

test('宿主：dryRun 生成回复但不发 QQ，也不计成功', async (t) => {
  const groupId = GROUP.dryRun
  t.after(async () => { await fake.call('/save', { dryRun: false }) })
  assert.equal((await fake.call('/save', { dryRun: true })).json().ok, true)
  push(groupId, 'DRY_RUN_BATCH')
  const { receipts } = await completed(groupId, 'ended')
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].state, 'skipped')
  assert.equal(sends(groupId).length, 0)
  assert.equal(attempts.get(groupId) || 0, 0)
  assert.equal(state(groupId).automaticDecisions, 1)
  assert.equal(state(groupId).idle.consecutiveSkips, 0, '试运行生成回复不能登记为主动沉默')
  assert.equal(state(groupId).actualReplies, 0)
  assert.equal(state(groupId).hour.successful, 0)
  assert.equal(state(groupId).pendingReplies, 0)
})

test('宿主：部分成功仅按已确认段记一次，unknown 段不重复补发', async () => {
  const groupId = GROUP.partial
  push(groupId, 'PARTIAL_BATCH')
  const { receipts } = await completed(groupId, 'delivery_unknown')
  assert.deepEqual(receipts.map((r) => r.state).sort(), ['delivered', 'unknown'])
  assert.equal(sends(groupId).length, 2)
  assert.equal(attempts.get(groupId), 2)
  assert.equal(state(groupId).actualReplies, 1)
  assert.equal(state(groupId).hour.successful, 1)
  assert.equal(state(groupId).pendingReplies, 0)
})

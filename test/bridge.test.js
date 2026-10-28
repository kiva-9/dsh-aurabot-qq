import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createBridge } from '../src/core/bridge.js'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { startMockOneBot } from './helpers/mock-onebot.js'

const BOT = '20000002', OWNER = '10000001', TARGET = `private:${OWNER}`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(label, predicate) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const result = predicate()
    if (result) return result
    await sleep(20)
  }
  throw new Error(`等待超时：${label}`)
}

// 与 hub.deliver/sendItems 的实际结构一致；complete 表示逻辑回复，rows 包含回落前的失败尝试。
function delivery(states, overrides = {}) {
  const rows = states.map((state, seq) => ({ id: `out-${seq}`, seq, state,
    platformMsgId: state === 'delivered' ? String(1001 + seq) : null }))
  const count = (state) => rows.filter((row) => row.state === state).length
  return { confirmed: count('delivered') > 0, complete: states.length > 0 && states.every((s) => s === 'delivered'),
    deliveries: [{ batchId: 'batch-1', total: rows.length, rows, delivered: count('delivered'),
      pending: count('pending') + count('sending'), unknown: count('unknown'), failed: count('failed'),
      skipped: count('skipped'), canceled: count('canceled'), messageIds: rows.map((row) => row.platformMsgId).filter(Boolean) }], ...overrides }
}
function fixture(t, { result = delivery(['delivered']), reply = '后台生成的回复', sendError, thinkError } = {}) {
  const fake = createFakeDsh({ brain: async () => assert.fail('单元测试不能调用模型') })
  t.after(() => fake.dispose())
  const cfg = { enabled: true, dryRun: false, ownerQQ: OWNER, allow: { private: [], groups: ['777'] },
    bridge: { allowTargets: 'whitelist', dshTools: true } }
  const sends = [], turns = []
  const hub = {
    async deliver(...args) { sends.push(args); if (sendError) throw sendError; return result },
    async runSystemTurn(...args) { turns.push(args); if (thinkError) throw thinkError; return reply },
  }
  const bridge = createBridge({ ctx: fake.ctx, getConfig: () => cfg, setConfig: (next) => Object.assign(cfg, next), hub,
    mods: { listen: () => () => {}, dshTools: () => [], status: () => [], use: () => null },
    log: { debug() {}, info() {}, warn() {} }, version: 'test', apiVersion: 1, overview: async () => ({}) })
  return { bridge, cfg, hub, fake, sends, turns }
}

for (const [states, status, partial] of [
  [['delivered', 'delivered'], 'delivered', false],
  [['pending'], 'pending', false], [['sending'], 'pending', false],
  [['unknown'], 'unknown', false], [['failed'], 'failed', false],
  [['skipped'], 'skipped', false], [['canceled'], 'skipped', false],
  [['delivered', 'unknown'], 'unknown', true], [['delivered', 'pending'], 'pending', true],
  [['delivered', 'failed'], 'failed', true], [['delivered', 'skipped'], 'skipped', true],
  [['delivered', 'canceled'], 'skipped', true], [['unknown', 'pending', 'failed'], 'unknown', false],
]) test(`bridge.send 依据真实分段结果报告 ${states.join('+')}`, async (t) => {
  const f = fixture(t, { result: delivery(states) }), result = await f.bridge.ops.send({ text: '发送测试' })
  assert.equal(result.status, status)
  assert.equal(result.ok, status === 'delivered')
  assert.equal(result.complete, status === 'delivered')
  assert.equal(result.partial, partial)
  assert.equal(result.confirmed, states.includes('delivered'))
  assert.equal(result.delivered, states.filter((s) => s === 'delivered').length)
  assert.equal(result.pending, states.filter((s) => s === 'pending' || s === 'sending').length)
  assert.deepEqual(result.messageIds, states.flatMap((state, seq) => state === 'delivered' ? [String(1001 + seq)] : []))
  assert.deepEqual(result.batchIds, ['batch-1'])
  assert.equal(result.target, TARGET)
  assert.equal(f.sends.length, 1, 'bridge 不自行重发任何状态的段')
  if (status !== 'delivered') assert.doesNotMatch(result.message, /回复已全部确认送达|发出去了/)
})

test('bridge：语音失败后文字回落成功，保留失败尝试但整次回复已完成', async (t) => {
  const f = fixture(t, { result: delivery(['failed', 'delivered'], { complete: true }) })
  const result = await f.bridge.service.send({ text: '<voice>你好</voice>' })
  assert.equal(result.status, 'delivered')
  assert.equal(result.ok, true)
  assert.equal(result.failed, 1)
  assert.equal(result.delivered, 1)
  assert.equal(result.partial, false)
  assert.deepEqual(result.messageIds, ['1002'])
})

test('bridge：没有消息回执 ID，不能仅凭 confirmed/complete 声称成功', async (t) => {
  const result = delivery(['delivered'])
  result.deliveries[0].rows[0].platformMsgId = null
  result.deliveries[0].messageIds = []
  const f = fixture(t, { result }), reported = await f.bridge.ops.send({ text: '缺少回执' })
  assert.equal(reported.status, 'unknown')
  assert.equal(reported.ok, false)
  assert.equal(reported.confirmed, false)
  assert.equal(reported.delivered, 0)
  assert.equal(reported.unknown, 1)
})

test('bridge：沉默或 hook 无返回值，以及没有可发送段，都报告 skipped', async (t) => {
  const f = fixture(t)
  for (const result of [undefined, null, delivery([])]) {
    f.hub.deliver = async () => result
    const reported = await f.bridge.ops.send({ text: '[沉默]' })
    assert.equal(reported.status, 'skipped')
    assert.equal(reported.ok, false)
    assert.equal(reported.confirmed, false)
    assert.equal(reported.complete, false)
    assert.deepEqual(reported.messageIds, [])
  }
})

test('bridge：宿主已关闭返回取消摘要，不把无 rows 的取消当作成功', async (t) => {
  const f = fixture(t, { result: { confirmed: false, complete: false,
    deliveries: [{ delivered: 0, failed: 0, unknown: 0, skipped: 0, canceled: 1, pending: 0, messageIds: [], rows: [] }] } })
  const result = await f.bridge.ops.send({ text: '宿主已关闭' })
  assert.equal(result.status, 'skipped')
  assert.equal(result.ok, false)
  assert.equal(result.canceled, 1)
  assert.deepEqual(result.messageIds, [])
})

test('bridge.send：白名单和空内容校验失败不调用 hub', async (t) => {
  const f = fixture(t)
  for (const args of [{ target: 'private:999', text: '越界' }, { text: ' ' }]) {
    const result = await f.bridge.ops.send(args)
    assert.equal(result.status, 'failed')
    assert.equal(result.ok, false)
    assert.equal(result.confirmed, false)
  }
  assert.equal(f.sends.length, 0)
})

test('bridge：发送后配置变化不改写已经获得的真实回执', async (t) => {
  const f = fixture(t)
  f.hub.deliver = async () => { f.cfg.enabled = false; f.cfg.dryRun = true; return delivery(['delivered']) }
  const result = await f.bridge.ops.send({ text: '在开关改变前已送达' })
  assert.equal(result.status, 'delivered')
  assert.equal(result.ok, true)
  assert.deepEqual(result.messageIds, ['1001'])
})

for (const outcome of [undefined, 'unknown', 'not_sent', 'rejected']) test(`bridge：发送抛错 ${outcome || '无结果依据'} 保留确切状态`, async (t) => {
  const f = fixture(t, { sendError: Object.assign(new Error('fixture: send error'), { outcome }) })
  const result = await f.bridge.ops.send({ text: '故障测试' })
  assert.equal(result.ok, false)
  assert.equal(result.status, ['not_sent', 'rejected'].includes(outcome) ? 'failed' : 'unknown')
  assert.equal(result.confirmed, false)
  assert.equal(f.sends.length, 1)
})

test('bridge：ops、同进程 service、全局工具共用送达报告', async (t) => {
  const f = fixture(t, { result: delivery(['unknown']) })
  f.bridge.refresh()
  const args = { target: TARGET, text: '同一契约' }
  const direct = await f.bridge.ops.send(args)
  assert.deepEqual(await f.fake.ctx.get('aurabot').send(args), direct)
  const tool = f.fake.ctx.globalTools.get('aurabot_qq_send')
  const toolResult = await tool.execute(args)
  assert.deepEqual(toolResult, direct)
  assert.match(tool.output.render(args, toolResult)[0].text, /结果未知/)
  assert.equal(f.sends.length, 3)
})

for (const state of ['delivered', 'pending', 'unknown', 'failed', 'skipped']) test(`bridge.think(to)：保留回复及 ${state} 送达状态，固定 noTools`, async (t) => {
  const f = fixture(t, { result: delivery([state]) })
  const result = await f.bridge.ops.think({ prompt: '联动请求', to: TARGET, noTools: false })
  assert.equal(result.reply, '后台生成的回复')
  assert.equal(result.status, state)
  assert.equal(result.ok, state === 'delivered')
  assert.deepEqual(f.turns[0][3], { noTools: true }, '外部输入不能抬高后台工具权限')
  assert.deepEqual(f.sends, [[TARGET, result.reply]])
})

test('bridge.think：只生成不冒充送达；沉默不发；非法目标在生成之前拒绝', async (t) => {
  const f = fixture(t)
  const draft = await f.bridge.ops.think({ prompt: '只生成' })
  assert.equal(draft.ok, true)
  assert.equal(draft.status, 'skipped')
  assert.equal(draft.target, null)
  assert.equal(draft.confirmed, false)
  assert.deepEqual(f.turns[0][3], { noTools: true })
  f.hub.runSystemTurn = async () => '[沉默]'
  const silent = await f.bridge.ops.think({ prompt: '不必回复', to: TARGET })
  assert.equal(silent.status, 'skipped')
  assert.equal(silent.ok, false)
  assert.equal(silent.reply, '[沉默]')
  f.hub.runSystemTurn = async () => assert.fail('非法请求不能开始模型生成')
  for (const args of [{ prompt: '越界', to: 'private:999' }, { prompt: ' ' }]) {
    assert.equal((await f.bridge.ops.think(args)).status, 'failed')
  }
  assert.equal(f.sends.length, 0)
})

test('bridge.think：生成异常明确失败，不尝试发送', async (t) => {
  const f = fixture(t, { thinkError: new Error('fixture: model failed') })
  const result = await f.bridge.ops.think({ prompt: '生成故障', to: TARGET })
  assert.equal(result.ok, false)
  assert.equal(result.status, 'failed')
  assert.equal(result.confirmed, false)
  assert.equal(f.sends.length, 0)
})

test('bridge 宿主回归：fake DSH + 本机 OneBot + 真实 outbox', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-bridge-host-'))
  const originalEnv = Object.fromEntries(['AURABOT_DATA_DIR', 'AURABOT_WORKSPACE', 'DSH_HOME'].map((key) => [key, process.env[key]]))
  const originalFetch = globalThis.fetch, transports = new Map(), attempts = new Map(), calls = []
  let gateway, fake, host, nextReply = '后台纯文本回复'
  t.after(async () => {
    for (const transport of transports.values()) transport.release?.()
    try {
      const disposed = await fake?.dispose()
      assert.ok(!disposed?.some((r) => r.status === 'rejected'))
    } finally {
      await gateway?.close()
      globalThis.fetch = originalFetch
      for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
      assert.equal(dirname(resolve(root)), resolve(tmpdir()))
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    }
  })
  process.env.AURABOT_DATA_DIR = root
  process.env.AURABOT_WORKSPACE = join(root, 'workspace')
  process.env.DSH_HOME = join(root, 'dsh')
  gateway = await startMockOneBot({ selfId: BOT })
  const textOf = (params) => params.message.filter((s) => s.type === 'text').map((s) => s.data.text).join('\n')
  globalThis.fetch = async (url, options) => {
    const target = new URL(String(url))
    assert.equal(target.origin, gateway.httpUrl, '仅可请求本机 mock OneBot，禁止收费或外部网络调用')
    if (target.pathname !== '/send_private_msg') return originalFetch(url, options)
    const text = textOf(JSON.parse(options.body)), transport = transports.get(text)
    attempts.set(text, (attempts.get(text) || 0) + 1)
    if (transport?.mode === 'rejected') return new Response(JSON.stringify({ status: 'failed', retcode: 100, message: 'fixture: rejected' }), { headers: { 'content-type': 'application/json' } })
    const response = await originalFetch(url, options), body = await response.clone().json()
    if (transport) transport.receipt = body.data
    if (transport?.mode === 'unknown') {
      await response.arrayBuffer()
      throw new TypeError('fixture: receipt lost', { cause: { code: 'ECONNRESET' } })
    }
    if (transport?.hold) await transport.hold
    return response
  }
  writeFileSync(join(root, 'config.json'), JSON.stringify({ enabled: true, dryRun: false, setupDone: true, botQQ: BOT, ownerQQ: OWNER,
    allow: { private: [OWNER], groups: [] }, bridge: { http: true, dshTools: true, token: 'bridge-fixture-token' },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: gateway.httpUrl, wsUrl: gateway.wsUrl,
      httpToken: gateway.token, wsToken: gateway.token, dir: join(root, 'snowluma-uninstalled') },
    voice: { enabled: false }, stickers: { enabled: false, collect: false, caption: false, autoChance: 0 },
    speakUp: { enabled: false }, mood: { enabled: false }, memory: { enabled: false }, learning: { enabled: false },
    modules: Object.fromEntries(['stickers', 'voice', 'mood', 'memory', 'learning', 'retrieval', 'search', 'imagegen', 'speakup', 'bili', 'song'].map((id) => [id, { enabled: false }])),
  }))
  fake = createFakeDsh({ brain: async (call) => { calls.push(call); return nextReply } })
  host = (await import('../src/host.js')).apply(fake.ctx)
  await host.ready
  assert.equal((await fake.call('/onebot/reconnect')).json().ok, true)
  await until('本机网关连接', () => gateway.connected() > 0)
  assert.equal(resolve((await fake.call('/state')).json().storage.file), resolve(root, 'aurabot.db'))
  const service = fake.ctx.get('aurabot'), headers = { authorization: 'Bearer bridge-fixture-token' }

  await t.test('HTTP send 等到真实回执才返回 delivered，并带真实 messageIds', async () => {
    const text = '等待实际发送回执', transport = {}
    transport.hold = new Promise((resolve) => { transport.release = resolve })
    transports.set(text, transport)
    let settled = false
    const pending = fake.call('/open/send', { text }, headers).then((response) => { settled = true; return response.json() })
    try {
      await until('网关已经执行发送，回执尚未交给客户端', () => transport.receipt)
      assert.equal(settled, false)
    } finally { transport.release() }
    const result = await pending
    assert.equal(result.status, 'delivered')
    assert.equal(result.ok, true)
    assert.equal(result.complete, true)
    assert.deepEqual(result.messageIds, [String(transport.receipt.message_id)])
  })

  for (const mode of ['rejected', 'unknown']) await t.test(`全局 send 工具如实报告 ${mode}，不自动重发`, async () => {
    const text = `宿主发送-${mode}`
    transports.set(text, { mode })
    const result = await fake.ctx.globalTools.get('aurabot_qq_send').execute({ text })
    assert.equal(result.status, mode === 'rejected' ? 'failed' : 'unknown')
    assert.equal(result.ok, false)
    assert.equal(result.confirmed, false)
    assert.equal(attempts.get(text), 1)
    assert.equal(gateway.sent('send_private_msg').filter((c) => textOf(c.params) === text).length, mode === 'unknown' ? 1 : 0)
  })

  await t.test('同进程 send 部分成功保留已确认 ID，unknown 不伪装成全部送达', async () => {
    const first = '已确认的一段', second = '回执丢失的一段', transport = {}
    transports.set(first, transport)
    transports.set(second, { mode: 'unknown' })
    const result = await service.send({ text: `${first}|||${second}` })
    assert.equal(result.status, 'unknown')
    assert.equal(result.partial, true)
    assert.equal(result.confirmed, true)
    assert.equal(result.complete, false)
    assert.equal(result.delivered, 1)
    assert.equal(result.unknown, 1)
    assert.deepEqual(result.messageIds, [String(transport.receipt.message_id)])
  })

  await t.test('dryRun、总开关关闭、沉默都没有网关发送和成功回执', async () => {
    const before = gateway.sent('send_private_msg').length
    try {
      for (const patch of [{ dryRun: true }, { dryRun: false, enabled: false }]) {
        assert.equal((await fake.call('/save', patch)).json().ok, true)
        const result = await service.send({ text: '不会真正发出的回复' })
        assert.equal(result.status, 'skipped')
        assert.equal(result.ok, false)
        assert.equal(result.confirmed, false)
      }
    } finally { await fake.call('/save', { enabled: true, dryRun: false }) }
    assert.equal((await service.send({ text: '[沉默]' })).status, 'skipped')
    assert.equal(gateway.sent('send_private_msg').length, before)
  })

  await t.test('think 创建实际无工具 system 会话；带 to 时同样返回真实送达状态', async () => {
    for (const mode of ['delivered', 'unknown']) {
      nextReply = `后台生成并发送-${mode}`
      const transport = { mode }
      transports.set(nextReply, transport)
      const result = (await fake.call('/open/think', { prompt: '生成一段回复', to: TARGET, noTools: false }, headers)).json()
      const call = calls.at(-1)
      assert.equal(host.hub.chatOfSession(call.agent.id), 'system:bridge')
      assert.equal(host.hub.sessions()['system:bridge'].level, 'chat')
      assert.deepEqual(call.toolNames, [])
      assert.equal(call.agent.tools.size, 0)
      assert.equal(result.reply, nextReply)
      assert.equal(result.status, mode)
      assert.equal(result.ok, mode === 'delivered')
      assert.deepEqual(result.messageIds, mode === 'delivered' ? [String(transport.receipt.message_id)] : [])
    }
    const before = gateway.sent('send_private_msg').length
    nextReply = '只生成的草稿'
    const draft = await service.think({ prompt: '先不要发送' })
    assert.equal(draft.reply, nextReply)
    assert.equal(draft.ok, true)
    assert.equal(draft.status, 'skipped')
    assert.equal(draft.confirmed, false)
    nextReply = '[沉默]'
    assert.equal((await service.think({ prompt: '不想回复可沉默', to: TARGET })).status, 'skipped')
    assert.equal(gateway.sent('send_private_msg').length, before)
  })
})

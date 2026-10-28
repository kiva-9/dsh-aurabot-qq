// 主动消息宿主回归：独立 system/noTools 回合、持久队列和真实本机 OneBot 回执。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { startMockOneBot } from './helpers/mock-onebot.js'

const BOT = '20000002', OWNER = '10000001', CHAT = `private:${OWNER}`
const SYSTEM_CHAT = `system:proactive-${BOT}-${OWNER}`
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
function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}
let root, fake, gateway, host, reader, originalFetch, seq = 0
const originalEnv = Object.fromEntries(['AURABOT_DATA_DIR', 'AURABOT_WORKSPACE', 'DSH_HOME'].map((key) => [key, process.env[key]]))
const scripts = new Map(), transports = new Map(), releases = new Set(), attempts = new Map()
const outgoing = () => gateway.sent('send_private_msg')
const messageText = (params) => params.message.filter((s) => s.type === 'text').map((s) => s.data.text).join('\n')
const meta = (key) => { const row = reader.prepare('SELECT value FROM meta WHERE key=?').get(key); return row ? JSON.parse(row.value) : undefined }
const queue = (id) => meta(`proactive:inbox:${id}`)
const epoch = () => reader.prepare('SELECT epoch FROM chat_epochs WHERE chat_id=?').get(CHAT)?.epoch || 0
const outboxFor = (text) => reader.prepare('SELECT * FROM outbox WHERE chat_id=? ORDER BY created_at,seq').all(CHAT)
  .filter((row) => messageText(JSON.parse(row.payload_json)) === text)
function script(marker, reply, { held = false } = {}) {
  const release = deferred(), entry = { marker, reply, release, calls: [] }
  releases.add(release)
  if (!held) release.resolve()
  scripts.set(marker, entry)
  return entry
}
function enqueue(marker, overrides = {}) {
  const input = { eventId: `speakup:${marker}`, chatId: CHAT, scope: host.hub.scopeFor(CHAT),
    persona: host.hub.personaFor(CHAT), epoch: epoch(), prompt: marker, shouldSend: () => true, ...overrides }
  const result = host.hub.enqueueProactive(input)
  assert.equal(result.accepted, true)
  assert.equal(result.eventId, input.eventId)
  return input
}
async function done(input) {
  return until(`${input.eventId} 队列完成`, () => queue(input.eventId)?.state === 'done' && queue(input.eventId))
}
async function holdMain(t, marker) {
  const entry = script(marker, '[沉默]', { held: true })
  t.after(() => entry.release.resolve())
  gateway.push({ message_type: 'private', sub_type: 'friend', user_id: Number(OWNER), message_id: ++seq,
    sender: { user_id: Number(OWNER), nickname: '测试主人' }, message: [{ type: 'text', data: { text: marker } }] })
  const call = await until(`${marker} 主聊天回合开始`, () => entry.calls[0])
  assert.equal(host.hub.chatOfSession(call.agent.id), CHAT)
  return entry
}
async function finishMain(entry) {
  entry.release.resolve()
  await until(`${entry.marker} 主聊天回合结束`, () => fake.turns.some((turn) => turn.userText.includes(entry.marker)))
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'aurabot-proactive-host-'))
  process.env.AURABOT_DATA_DIR = root
  process.env.AURABOT_WORKSPACE = join(root, 'workspace')
  process.env.DSH_HOME = join(root, 'dsh')
  gateway = await startMockOneBot({ selfId: BOT })
  originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    const target = new URL(String(url))
    assert.equal(target.origin, gateway.httpUrl, '此测试只允许本机 mock OneBot，禁止外部付费请求')
    if (target.pathname !== '/send_private_msg') return originalFetch(url, options)
    const params = JSON.parse(options.body), text = messageText(params), transport = transports.get(text)
    attempts.set(text, (attempts.get(text) || 0) + 1)
    if (transport?.mode === 'rejected') return new Response(JSON.stringify({ status: 'failed', retcode: 100, message: 'fixture: rejected' }), { headers: { 'content-type': 'application/json' } })
    const response = await originalFetch(url, options)
    const receipt = await response.clone().json()
    if (transport) transport.receipt = receipt.data
    if (transport?.mode === 'unknown') {
      await response.arrayBuffer()
      throw new TypeError('fixture: response lost after gateway accepted', { cause: { code: 'ECONNRESET' } })
    }
    if (transport?.release) await transport.release.promise
    transport?.onReceipt?.()
    return response
  }
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    enabled: true, dryRun: false, setupDone: true, botQQ: BOT, ownerQQ: OWNER, allow: { private: [OWNER], groups: [] },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: gateway.httpUrl, wsUrl: gateway.wsUrl,
      httpToken: gateway.token, wsToken: gateway.token, dir: join(root, 'snowluma-uninstalled') },
    merge: { enabled: false }, voice: { enabled: false }, stickers: { enabled: false, collect: false, caption: false, autoChance: 0 },
    speakUp: { enabled: true, idleMinutes: 1440, minIntervalMinutes: 1440, maxIntervalMinutes: 1440 },
    mood: { enabled: false }, memory: { enabled: false }, learning: { enabled: false },
    modules: Object.fromEntries(['stickers', 'voice', 'mood', 'memory', 'learning', 'retrieval', 'search', 'imagegen', 'bili', 'song'].map((id) => [id, { enabled: false }])),
  }))
  fake = createFakeDsh({ brain: async (call) => {
    const entry = [...scripts.values()].find((s) => call.text.includes(s.marker))
    assert.ok(entry, `必须显式设置 fake 模型脚本：${call.text}`)
    entry.calls.push(call)
    await entry.release.promise
    return entry.reply
  } })
  host = (await import('../src/host.js')).apply(fake.ctx)
  await host.ready
  assert.equal((await fake.call('/onebot/reconnect')).json().ok, true)
  await until('mock OneBot 连接', () => gateway.connected() > 0)
  const overview = (await fake.call('/state')).json()
  assert.equal(resolve(overview.storage.file), resolve(root, 'aurabot.db'))
  reader = new DatabaseSync(join(root, 'aurabot.db'), { readOnly: true })
})

after(async () => {
  for (const release of releases) release.resolve()
  try {
    const disposed = await fake?.dispose()
    assert.ok(!disposed?.some((r) => r.status === 'rejected'), '宿主正常释放后台任务')
  } finally {
    reader?.close()
    await gateway?.close()
    if (originalFetch) globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    if (root) {
      assert.equal(dirname(resolve(root)), resolve(tmpdir()))
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    }
  }
})

test('主动消息：专用 system/noTools 回合，只有真实回执才能更新主人消息 scope/message_id', async (t) => {
  const reply = '已经收到回执的主动问候', entry = script('CONFIRMED_PROACTIVE', reply, { held: true })
  const transport = { release: deferred() }
  releases.add(transport.release)
  t.after(() => { entry.release.resolve(); transport.release.resolve() })
  transports.set(reply, transport)
  const previous = structuredClone(host.hub.lastBotToOwner), input = enqueue(entry.marker)
  const call = await until('主动 system 回合开始', () => entry.calls[0])
  assert.equal(host.hub.chatOfSession(call.agent.id), SYSTEM_CHAT)
  assert.equal(host.hub.sessions()[SYSTEM_CHAT].level, 'chat')
  assert.deepEqual(call.toolNames, [])
  assert.equal(call.agent.tools.size, 0)
  assert.equal(host.hub.sessions()[CHAT], undefined, '没有把主动 prompt 注入主人聊天会话')
  assert.equal(queue(input.eventId).state, 'dispatching')
  assert.equal(meta(`planner:inbox:${input.eventId}`), undefined)
  assert.equal(host.hub.plannerWakes().length, 0)
  assert.deepEqual(host.hub.lastBotToOwner, previous)
  entry.release.resolve()
  await until('本机网关已收到，客户端尚未拿到回执', () => transport.receipt)
  assert.equal(outgoing().filter((c) => messageText(c.params) === reply).length, 1)
  assert.equal(outboxFor(reply)[0].state, 'sending')
  assert.deepEqual(host.hub.lastBotToOwner, previous, '已经生成、网关已接收都不能冒充已确认送达')
  transport.release.resolve()
  await done(input)
  assert.deepEqual(host.hub.lastBotToOwner.scope, input.scope)
  assert.equal(host.hub.lastBotToOwner.message_id, String(transport.receipt.message_id))
  assert.equal(host.hub.lastBotToOwner.text, reply)
  assert.ok(host.hub.lastBotToOwner.at > previous.at)
  const row = outboxFor(reply)[0]
  assert.equal(row.state, 'delivered')
  assert.equal(row.platform_msg_id, String(transport.receipt.message_id))
  assert.equal(meta(`outbox:batch:${row.batch_id}`).requiresGuard, true)
})

test('主动消息：主人聊天正在运行时排队，主回合释放后才运行专用会话', async (t) => {
  const main = await holdMain(t, 'HOLD_QUEUE_MAIN'), entry = script('QUEUED_PROACTIVE', '排队之后的主动问候')
  const before = outgoing().length, input = enqueue(entry.marker)
  // 等过一个 wakeInbox 轮询周期，验证它确实尝试过调度而没有抢主聊天。
  await sleep(650)
  assert.equal(queue(input.eventId).state, 'queued')
  assert.equal(entry.calls.length, 0)
  assert.equal(outgoing().length, before)
  await finishMain(main)
  await done(input)
  assert.equal(entry.calls.length, 1)
  assert.equal(host.hub.chatOfSession(entry.calls[0].agent.id), SYSTEM_CHAT)
  assert.equal(outgoing().length, before + 1)
})

for (const mode of ['rejected', 'unknown']) test(`主动消息：${mode} 回执不更新 lastBotToOwner，也不自动重发`, async () => {
  const reply = `未确认的主动消息-${mode}`, entry = script(`UNCONFIRMED_${mode}`, reply)
  transports.set(reply, { mode })
  const previous = structuredClone(host.hub.lastBotToOwner), before = outgoing().length
  const input = enqueue(entry.marker)
  await done(input) // inbox done 只说明调度完成，实际送达必须看 outbox。
  assert.equal(outboxFor(reply)[0].state, mode === 'rejected' ? 'failed' : 'unknown')
  assert.equal(attempts.get(reply), 1)
  assert.equal(outgoing().length, before + (mode === 'unknown' ? 1 : 0))
  assert.deepEqual(host.hub.lastBotToOwner, previous)
  await host.hub.recoverOutbox()
  assert.equal(attempts.get(reply), 1)
  assert.deepEqual(host.hub.lastBotToOwner, previous)
})

for (const mode of ['abort', 'guard']) test(`主动消息：排队期间 ${mode} 取消，不启动模型也不发 QQ`, async (t) => {
  const main = await holdMain(t, `HOLD_CANCEL_${mode}`), entry = script(`CANCELED_${mode}`, '禁止发送的排队消息')
  const controller = new AbortController(), previous = structuredClone(host.hub.lastBotToOwner), before = outgoing().length
  let allowed = true
  const input = enqueue(entry.marker, { signal: controller.signal, shouldSend: () => allowed })
  assert.equal(queue(input.eventId).state, 'queued')
  if (mode === 'abort') controller.abort(); else allowed = false
  await until('队列取消状态持久化', () => queue(input.eventId)?.state === 'canceled')
  await finishMain(main)
  assert.equal(entry.calls.length, 0)
  assert.equal(outgoing().length, before)
  assert.equal(outboxFor(entry.reply).length, 0)
  assert.deepEqual(host.hub.lastBotToOwner, previous)
})

test('主动消息：生成中 epoch 改变，迟到结果不能创建发送段', async (t) => {
  const entry = script('GENERATING_OLD_EPOCH', '禁止发送的迟到生成结果', { held: true })
  t.after(() => entry.release.resolve())
  const previous = structuredClone(host.hub.lastBotToOwner), before = outgoing().length, input = enqueue(entry.marker)
  await until('旧代次主动生成已开始', () => entry.calls.length === 1)
  host.hub.abandonChat(CHAT, host.hub.sessions()[CHAT]?.sessionId, 'fixture: epoch changed during proactive generation')
  assert.equal(epoch(), input.epoch + 1)
  entry.release.resolve()
  await until('生成完成后失效被记录', () => queue(input.eventId)?.state === 'unknown')
  assert.match(queue(input.eventId).error, /失效/)
  assert.equal(outgoing().length, before)
  assert.equal(outboxFor(entry.reply).length, 0)
  assert.deepEqual(host.hub.lastBotToOwner, previous)
})

test('主动消息：首段收到回执后 guard 失效，后续段停止且只记录首段真实回执', async () => {
  const first = '仍有效的第一段', second = '已经失效的第二段', entry = script('GUARDED_BUBBLES', `${first}|||${second}`)
  let allowed = true
  const transport = { onReceipt: () => { allowed = false } }
  transports.set(first, transport)
  const before = outgoing().length, input = enqueue(entry.marker, { shouldSend: () => allowed })
  await done(input)
  assert.equal(outgoing().length, before + 1)
  assert.equal(outboxFor(first)[0].state, 'delivered')
  assert.equal(outboxFor(second)[0].state, 'canceled')
  assert.equal(attempts.get(second) || 0, 0)
  assert.equal(host.hub.lastBotToOwner.text, first)
  assert.equal(host.hub.lastBotToOwner.message_id, String(transport.receipt.message_id))
  assert.deepEqual(host.hub.lastBotToOwner.scope, input.scope)
})

test('主动消息：重置主人聊天取消旧 epoch 排队事件，并释放调度器供新事件使用', async (t) => {
  const main = await holdMain(t, 'HOLD_QUEUED_EPOCH'), entry = script('QUEUED_OLD_EPOCH', '禁止发送的旧代次排队消息')
  const previous = structuredClone(host.hub.lastBotToOwner), before = outgoing().length, input = enqueue(entry.marker)
  assert.equal(queue(input.eventId).state, 'queued')
  assert.equal(host.hub.resetChat(CHAT), true)
  assert.equal(epoch(), input.epoch + 1)
  await until('旧代次排队事件取消', () => queue(input.eventId)?.state === 'canceled')
  await finishMain(main)
  assert.equal(entry.calls.length, 0)
  assert.equal(outgoing().length, before)
  assert.deepEqual(host.hub.lastBotToOwner, previous)
  const next = script('AFTER_EPOCH_RESET', '重置后新事件的回复'), current = enqueue(next.marker)
  await until('重置后新事件开始（scheduler 必须释放旧回合的 busy）', () => next.calls.length === 1)
  await done(current)
  assert.equal(queue(input.eventId).state, 'canceled')
  assert.equal(outgoing().length, before + 1)
  assert.equal(host.hub.lastBotToOwner.text, next.reply)
})

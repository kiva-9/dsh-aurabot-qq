// 聊天主链路可靠性回归：dryRun/force、outbox 重启恢复、调度器回合令牌、档位切换清理、
// 入站 / 派发死信、群插话记录、发送中取消。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createScheduler } from '../src/runtime/scheduler.js'
import { hubFixture, privateChat, groupChat, OWNER, BOT, GROUP, until } from './helpers/hub-fixture.js'

const textItem = (value) => ({ kind: 'text', message: [{ type: 'text', data: { text: value } }], note: value })
const flush = () => new Promise((resolve) => setImmediate(resolve))

function fakeTimers() {
  let now = 0
  let seq = 0
  const pending = new Map()
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; pending.set(id, { at: now + ms, fn }); return id },
    clearTimeout: (id) => pending.delete(id),
    advance(ms) {
      const end = now + ms
      for (;;) {
        const next = [...pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        pending.delete(next[0])
        now = next[1].at
        next[1].fn()
      }
      now = end
    },
  }
}
const settings = { enabled: true, waitMs: 2000, maxMs: 5000, mentionWaitMs: 800, mediaExtraMs: 3000 }
const pm = { chatId: 'private:1', kind: 'private' }
const msg = (id, extra = {}) => ({ messageId: id, actorId: '1', mode: 'must', ...extra })

// ---------- P0-01 force 不能绕过 dryRun ----------

test('P0-01 dryRun=true + force=true 不调用网关；enabled=false + force=true 才能发（命令语义保留）', async (t) => {
  const dry = await hubFixture(t, { config: { enabled: true, dryRun: true } })
  const sent = await dry.hub.sendSegments(`private:${OWNER}`, [{ type: 'text', data: { text: '试运行 force' } }], 'force', { force: true })
  assert.equal(sent, null)
  assert.equal(dry.calls.length, 0, 'dryRun 永远拦截，即使 force=true')

  const off = await hubFixture(t, { config: { enabled: false, dryRun: false } })
  const forced = await off.hub.sendSegments(`private:${OWNER}`, [{ type: 'text', data: { text: '命令回执' } }], 'force', { force: true })
  assert.ok(forced?.message_id !== undefined, 'force 允许绕过总开关')
  assert.equal(off.calls.length, 1)
  assert.equal(off.calls[0].action, 'send_private_msg')

  const normal = await off.hub.sendSegments(`private:${OWNER}`, [{ type: 'text', data: { text: '普通消息' } }], 'normal')
  assert.equal(normal, null)
  assert.equal(off.calls.length, 1, '不带 force 仍受总开关限制')
})

// ---------- P0-04 guarded 会话回复重启恢复 ----------

function ingestRequest(f, chatId) {
  const ing = f.storage.messages.ingest({
    account: BOT, chatId, eventKind: 'message', platformMsgId: 'm-' + Math.random().toString(36).slice(2),
    authorId: OWNER, authorName: 'owner', platformTime: Date.now(), text: '在吗',
  })
  return f.storage.requests.create({ chatId, actorId: OWNER, sourceMessageIds: [ing.id] })
}

test('P0-04 hub.recoverOutbox 无显式 guard 时安全恢复 sessionReply，作废旧代次，job 批次保持 pending', async (t) => {
  const f = await hubFixture(t, { config: { merge: { enabled: false } } })
  const chatId = `private:${OWNER}`
  const epoch = f.storage.epochs.current(chatId)
  const request = ingestRequest(f, chatId)

  const guarded = f.hub.outbox.enqueue({
    batchId: 'reply:recover-ok', chatId, requestId: request.id, epoch, requiresGuard: true,
    batchKind: 'sessionReply', account: BOT, items: [textItem('恢复的回复')],
  })
  await f.hub.recoverOutbox()
  assert.equal(f.hub.outbox.summary(guarded).delivered, 1)
  assert.deepEqual(f.calls.filter((c) => c.action === 'send_private_msg').length, 1)

  const staleEpoch = f.storage.epochs.current(chatId)
  const staleRequest = ingestRequest(f, chatId)
  const stale = f.hub.outbox.enqueue({
    batchId: 'reply:recover-stale', chatId, requestId: staleRequest.id, epoch: staleEpoch, requiresGuard: true,
    batchKind: 'sessionReply', account: BOT, items: [textItem('旧代次的回复')],
  })
  f.storage.epochs.bump(chatId, '换人设')
  await f.hub.recoverOutbox()
  assert.equal(f.hub.outbox.summary(stale).canceled, 1)
  assert.equal(f.hub.outbox.summary(stale).delivered, 0)

  const job = f.hub.outbox.enqueue({
    batchId: 'image:job-recovery', chatId, epoch: f.storage.epochs.current(chatId), requiresGuard: true,
    account: BOT, items: [textItem('生图结果')],
  })
  await f.hub.recoverOutbox()
  assert.equal(f.hub.outbox.summary(job).pending, 1, 'job 批次留给 job worker，不在这里取消或发送')
})

test('P0-04 dryRun 时恢复 guard 一律不发；outbox recover 的 shouldSend 按 row 调用', async (t) => {
  const dry = await hubFixture(t, { config: { dryRun: true } })
  const chatId = `private:${OWNER}`
  const batch = dry.hub.outbox.enqueue({ batchId: 'reply:dry-recover', chatId, epoch: dry.storage.epochs.current(chatId), requiresGuard: true, batchKind: 'sessionReply', account: BOT, items: [textItem('别发')] })
  await dry.hub.recoverOutbox()
  assert.equal(dry.hub.outbox.summary(batch).canceled, 1)
  assert.equal(dry.calls.length, 0)

  const f = await hubFixture(t)
  const rows = f.hub.outbox.enqueue({ chatId, requiresGuard: true, items: [textItem('第一段'), textItem('第二段')] })
  const checked = []
  await f.hub.outbox.recover({ shouldSend: (row) => { checked.push(row.seq); return row.seq === 0 } })
  const summary = f.hub.outbox.summary(rows)
  assert.equal(summary.delivered, 1)
  assert.equal(summary.canceled, 1)
  assert.deepEqual(checked.sort(), [0, 1], 'guard 对每一段单独调用')
})

// ---------- P0-03 调度器回合令牌 ----------

test('P0-03 第一轮超过 4 分钟未结束不启动第二批；迟到 token 不能解锁新回合', async () => {
  const timers = fakeTimers()
  const runs = []
  const sch = createScheduler({
    timers, settings: () => settings,
    dispatch: async (chat, batch, info) => { runs.push({ ids: batch.entries.map((e) => e.messageId), steer: info.steer, token: info.token }) },
  })
  sch.add(pm, msg('a'))
  timers.advance(2000)
  await flush()
  assert.equal(runs.length, 1)
  const first = runs[0].token

  timers.advance(4 * 60_000 + 1)
  sch.add(pm, msg('b'))
  timers.advance(2000)
  await flush()
  assert.equal(runs.length, 1, '第一轮没 turnEnded，绝不能开第二个并发回合')

  sch.turnEnded(pm.chatId, 'not-the-token')
  await flush()
  assert.equal(runs.length, 1, '不匹配的 token 不解锁')

  sch.turnEnded(pm.chatId, first)
  await flush()
  assert.equal(runs.length, 2)
  assert.deepEqual(runs[1].ids, ['b'])
  const second = runs[1].token
  assert.notEqual(second, first)

  sch.turnEnded(pm.chatId, first)
  await flush()
  assert.equal(sch.isBusy(pm.chatId), true, '上一轮的迟到 turnEnded 不能释放第二轮')
  sch.add(pm, msg('c'))
  timers.advance(2000)
  await flush()
  assert.equal(runs.length, 2, '第二轮仍在跑，c 排着')
  sch.turnEnded(pm.chatId, second)
  await flush()
  assert.equal(runs.length, 3)
  assert.deepEqual(runs[2].ids, ['c'])
})

test('P1 steer 失败时批次回到调度器，不丢失也不重复 steer', async () => {
  const timers = fakeTimers()
  const runs = []
  const sch = createScheduler({
    timers, settings: () => settings, canSteer: () => true,
    dispatch: async (chat, batch, info) => {
      runs.push({ ids: batch.entries.map((e) => e.messageId), steer: info.steer, token: info.token })
      if (info.steer) throw new Error('steer failed')
    },
  })
  sch.add(pm, msg('a'))
  timers.advance(2000)
  await flush()
  sch.add(pm, msg('b'))
  timers.advance(2000)
  await flush()
  assert.equal(runs.length, 2)
  assert.equal(runs[1].steer, true)
  assert.equal(sch.state(pm.chatId).ready, 1, '失败的插话批次回到 ready')
  timers.advance(60_000)
  await flush()
  assert.equal(runs.length, 2, '当前回合还在跑，不反复 steer 同一批')
  sch.turnEnded(pm.chatId, runs[0].token)
  await flush()
  assert.equal(runs.length, 3)
  assert.deepEqual(runs[2].ids, ['b'])
  assert.equal(runs[2].steer, false)
})

// ---------- P0-02 档位切换清理 ----------

test('P0-02 ownerLevel full→social：旧 chatOfSession 为空、旧 mounted 清掉、旧 turn/end 不再发送', async (t) => {
  const f = await hubFixture(t, { config: { ownerLevel: 'full', merge: { enabled: false } } })
  const chat = privateChat()
  const sends = () => f.calls.filter((c) => c.action === 'send_private_msg')
  await f.hub.pushToSession(chat, [{ type: 'text', text: '第一轮' }], OWNER)
  await until(() => sends().length >= 1)
  const oldSid = f.hub.sessions()[chat.chatId].sessionId
  const oldAgent = f.fake.agents.get(oldSid)
  assert.ok(f.hub.chatOfSession(oldSid), '切换前旧映射存在')
  assert.ok(oldAgent.contexts.size > 0, '切换前旧会话挂着上下文')

  f.cfg.ownerLevel = 'social'
  await f.hub.pushToSession(chat, [{ type: 'text', text: '第二轮' }], OWNER)
  const newSid = f.hub.sessions()[chat.chatId].sessionId
  assert.notEqual(newSid, oldSid)
  await until(() => sends().length >= 2)
  assert.equal(f.hub.chatOfSession(oldSid), '', '旧 session 不再映射回聊天')
  assert.equal(oldAgent.contexts.size, 0, '旧会话的工具 / 上下文已卸载')
  assert.equal(oldAgent.tools.size, 0)

  const before = sends().length
  f.hub.onSessionEvent({ id: oldSid }, { type: 'assistant/message', data: { turn: 99, message: { content: [{ type: 'text', text: '旧档位的迟到回复' }] } } })
  f.hub.onSessionEvent({ id: oldSid }, { type: 'turn/end', data: { turn: 99, reason: { kind: 'completed' } } })
  await flush()
  assert.equal(sends().length, before, '旧会话的 turn/end 不能发送旧回复')
})

// ---------- P1 dispatch / onMessage 死信 ----------

test('P1 dispatch 异常写死信并把已创建请求标成 dispatch_failed', async (t) => {
  const f = await hubFixture(t, { config: { merge: { enabled: false } }, buildTools: () => { throw new Error('SOCIAL_SCOPE_UNAVAILABLE') } })
  const chatId = `private:${OWNER}`
  await f.hub.onMessage({
    post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: Number(BOT), user_id: Number(OWNER),
    message_id: 99001, time: Math.floor(Date.now() / 1000), sender: { nickname: '主人' }, message: [{ type: 'text', data: { text: '派发失败测试' } }],
  })
  const dead = await until(() => f.storage.db.get("SELECT key, value FROM meta WHERE key LIKE 'chat:deadletter:dispatch:%' LIMIT 1"))
  assert.match(JSON.parse(dead.value).error, /SOCIAL_SCOPE_UNAVAILABLE/)
  const request = f.storage.db.get('SELECT state FROM requests WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1', chatId)
  assert.equal(request.state, 'dispatch_failed')
})

test('P1 onMessage 入库后 media.register 异常写入站死信，不会只被 duplicate 挡住', async (t) => {
  const f = await hubFixture(t)
  const chatId = `private:${OWNER}`
  const original = f.storage.occurrences.add
  f.storage.occurrences.add = () => { throw new Error('disk full') }
  t.after(() => { f.storage.occurrences.add = original })
  await f.hub.onMessage({
    post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: Number(BOT), user_id: Number(OWNER), message_id: 99002,
    time: Math.floor(Date.now() / 1000), sender: { nickname: '主人' },
    message: [{ type: 'image', data: { file: 'a.jpg', url: 'http://example.invalid/a.jpg' } }],
  })
  const message = f.storage.messages.recent(chatId, 1)[0]
  assert.ok(message, '消息已经入库')
  const dead = await until(() => f.storage.meta.get(`chat:deadletter:${message.id}`))
  assert.match(dead.error, /disk full/)
})

// ---------- P1 groupInterjects / cancelPending ----------

test('P1 确认发出的群消息写入 groupInterjects；换人设时清理', async (t) => {
  const f = await hubFixture(t, { config: { merge: { enabled: false } } })
  await f.hub.onMessage({
    post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: Number(BOT), group_id: Number(GROUP), user_id: 30000003,
    message_id: 99003, time: Math.floor(Date.now() / 1000), sender: { nickname: '群友' },
    message: [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: '在吗' } }],
  })
  await until(() => f.calls.some((c) => c.action === 'send_group_msg'))
  assert.equal(f.hub.groupInterjectTimes(GROUP).length, 1)
  assert.ok(f.hub.resetChat(`group:${GROUP}`))
  assert.equal(f.hub.groupInterjectTimes(GROUP).length, 0, '重开会话清掉旧群插话记录')
})

test('P1 outbox.cancelPending 处理 sending（标记 cancel_requested），不伪装成已取消', async (t) => {
  const f = await hubFixture(t)
  const chatId = `private:${OWNER}`
  const batch = f.hub.outbox.enqueue({ chatId, items: [textItem('发到一半')] })
  f.storage.db.run("UPDATE outbox SET state = 'sending' WHERE batch_id = ?", batch)
  assert.equal(f.hub.outbox.cancelPending(chatId, '换人设'), 1)
  assert.equal(f.hub.outbox.rows(batch)[0].state, 'sending', '正在发送的段不改状态，交给 transmit 最后复核')
  const meta = JSON.parse(f.storage.db.get('SELECT value FROM meta WHERE key = ?', `outbox:batch:${batch}`).value)
  assert.equal(meta.cancelRequested.reason, '换人设')
})

test('P1 发送期间 epoch 改变：transmit 在网关前拦住普通消息', async (t) => {
  const chatId = `private:${OWNER}`
  const f = await hubFixture(t, { hooks: { send: async (message) => { f.storage.epochs.bump(chatId, '发送中换人设'); return message } } })
  const result = await f.hub.deliver(chatId, '不该发出去', { turnId: 'epoch-race' })
  assert.equal(f.calls.length, 0, 'hooks.send 之后、网关之前再核对 epoch')
  assert.equal(result.confirmed, false)
  assert.equal(result.deliveries.length > 0, true)
})

test('P2 groupName 失败负缓存：连续读取只请求一次网关', async (t) => {
  let infoCalls = 0
  const f = await hubFixture(t, { onebot: { call: async (action) => { if (action === 'get_group_info') { infoCalls++; throw new Error('unsupported') } return { message_id: 1 } } } })
  assert.equal(await f.hub.groupName(GROUP), GROUP)
  assert.equal(await f.hub.groupName(GROUP), GROUP)
  assert.equal(infoCalls, 1)
})

// ---------- 一轮多段发言（#205）、插话重说、卡死巡检 ----------

const textOfCall = (c) => JSON.stringify(c.params?.message ?? c.params)

test('一轮里工具前后两段发言都发出去；同一 step 重复推送不重复', async (t) => {
  const f = await hubFixture(t, { config: { merge: { enabled: false } } })
  const chat = privateChat()
  const sends = () => f.calls.filter((c) => c.action === 'send_private_msg')
  await f.hub.pushToSession(chat, [{ type: 'text', text: '先开会话' }], OWNER)
  await until(() => sends().length >= 1)
  const sid = f.hub.sessions()[chat.chatId].sessionId
  const before = sends().length
  const ev = (type, data) => f.hub.onSessionEvent({ id: sid }, { type, data })
  ev('turn/start', { turn: 50 })
  ev('assistant/message', { turn: 50, step: 1, message: { content: [{ type: 'text', text: '我先查一下天气' }] } })
  ev('assistant/message', { turn: 50, step: 1, message: { content: [{ type: 'text', text: '我先查一下天气' }] } })
  ev('assistant/message', { turn: 50, step: 2, message: { content: [{ type: 'text', text: '明天下雨记得带伞' }] } })
  ev('turn/end', { turn: 50, reason: { kind: 'completed' } })
  await until(() => /明天下雨/.test(sends().slice(before).map(textOfCall).join('\n')))
  await flush()
  const out = sends().slice(before).map(textOfCall).join('\n')
  assert.match(out, /我先查一下天气/, 'step1 的话不能丢')
  assert.match(out, /明天下雨记得带伞/)
  assert.equal(out.split('我先查一下天气').length - 1, 1, '同一 step 重复推送只发一次')
})

test('插话（steer）之后的新一段覆盖旧段，只发最新的', async (t) => {
  const f = await hubFixture(t, { config: { merge: { enabled: false } } })
  const chat = privateChat()
  const sends = () => f.calls.filter((c) => c.action === 'send_private_msg')
  await f.hub.pushToSession(chat, [{ type: 'text', text: '先开会话' }], OWNER)
  await until(() => sends().length >= 1)
  const sid = f.hub.sessions()[chat.chatId].sessionId
  const before = sends().length
  const ev = (type, data) => f.hub.onSessionEvent({ id: sid }, { type, data })
  ev('turn/start', { turn: 60 })
  ev('assistant/message', { turn: 60, step: 1, message: { content: [{ type: 'text', text: '旧的半截回答' }] } })
  await f.hub.pushToSession(chat, [{ type: 'text', text: '等等我改主意了' }], OWNER, { steer: true })
  ev('assistant/message', { turn: 60, step: 2, message: { content: [{ type: 'text', text: '好，那就按新的来' }] } })
  ev('turn/end', { turn: 60, reason: { kind: 'completed' } })
  await until(() => sends().length > before)
  await flush()
  const out = sends().slice(before).map(textOfCall).join('\n')
  assert.match(out, /按新的来/)
  assert.doesNotMatch(out, /旧的半截回答/)
})

test('调度器 busyChats 报告忙了多久，令牌不对不能放开', () => {
  const timers = fakeTimers()
  const sch = createScheduler({ settings: () => settings, dispatch: async () => {}, timers })
  const token = sch.reserve(pm.chatId)
  assert.ok(token)
  timers.advance(11 * 60_000)
  const [busy] = sch.busyChats()
  assert.equal(busy.chatId, pm.chatId)
  assert.equal(busy.token, token)
  assert.ok(busy.ageMs >= 11 * 60_000)
  sch.turnEnded(pm.chatId, 'turn-wrong')
  assert.equal(sch.isBusy(pm.chatId), true)
  sch.turnEnded(pm.chatId, token)
  assert.equal(sch.isBusy(pm.chatId), false)
  sch.dispose()
})

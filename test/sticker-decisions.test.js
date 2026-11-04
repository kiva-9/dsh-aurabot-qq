import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createStorage } from '../src/storage/index.js'
import { createStickerStore } from '../src/stickers/store.js'
import { recordCompletedStickerTurn } from '../src/stickers/decision.js'
import { observeModelUsage } from '../src/core/llm.js'
import { rankDecisionCandidates } from '../src/stickers/selection.js'
import { createDecisionPreviews } from '../src/stickers/preview.js'
import { imageSize } from '../src/chat/inbound.js'
import { png } from './helpers/images.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHn8AAAAASUVORK5CYII=', 'base64')
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }
function fixture(t, settings = {}, model) {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-decision-'))
  let clock = 1_000_000, seq = 0, calls = []
  const storage = createStorage({ file: join(root, 'state.db'), filesDir: join(root, 'assets'), now: () => clock })
  const config = { botQQ: '100', ownerQQ: '200', model: { provider: 'test', model: 'global' }, roles: {}, stickers: {
    enabled: true, caption: false, autoChance: 1, cooldownMs: 0, chatCooldownMs: 0, sameStickerCooldownMs: 0, minGapTurns: 0, ...settings } }
  const stores = []
  const create = extra => {
    const store = createStickerStore({ storage, getConfig: () => config, now: () => clock, autoStart: false, random: () => 0.3,
      decisionPreview: async () => ({ bytes: PNG, mime: 'image/png' }),
      decideModel: async (_dsh, input) => { calls.push(input); return model ? model(input) : JSON.stringify({ decision: 'send', number: 1 }) }, ...extra })
    stores.push(store); return store
  }
  t.after(() => { stores.forEach(s => s.stop()); storage.close(); rmSync(root, { recursive: true, force: true }) })
  const store = create()
  const add = async (name, chatId = 'group:1', n = ++seq) => {
    const { item } = await store.addFromBuffer(Buffer.concat([PNG, Buffer.from(String(n))]), { chatId, name, toQQ: false })
    assert.equal(store.approve(item.id, { admin: true }).ok, true)
    return store.get(item.id, { admin: true })
  }
  const turn = (text = '你好', chatId = 'group:1') => {
    const m = storage.messages.ingest({ account: config.botQQ, chatId, authorId: '200', platformMsgId: String(++seq), text,
      segments: [{ type: 'text', data: { text } }] })
    const request = storage.requests.create({ chatId, actorId: '200', sourceMessageIds: [m.id] })
    return { accountId: config.botQQ, chatId, epoch: request.epoch, turnId: request.id, requestIds: [request.id], replyText: '好的你好' }
  }
  const permit = (turn, result) => ({ ...turn, decisionId: result.decisionId, itemId: result.item.id })
  const send = async turn => {
    const result = await store.decideForReply(turn), p = permit(turn, result)
    assert.equal(store.claimDecision(p).decision, 'send'); assert.equal(store.validateDecision(p), true)
    assert.equal(store.settleDecision({ decisionId: result.decisionId, status: 'sent' }), true)
    store.completeTurn({ decisionId: result.decisionId, completed: true }); return result
  }
  return { root, store, create, storage, config, add, turn, permit, send, calls, advance: n => { clock += n } }
}

test('概率为零或一、可信明确请求例外，以及同轮和跨入口只决策一次', async t => {
  const f = fixture(t, { autoChance: 0 }), item = await f.add('小猫')
  const ordinary = f.turn('你好')
  const first = await f.store.decideForReply(ordinary)
  assert.equal(first.code, 'PROBABILITY'); assert.equal(f.calls.length, 0)
  assert.equal((await f.store.decideForReply({ ...ordinary, turnId: 'different-entry' })).code, 'ALREADY_DECIDED')
  assert.equal((await f.store.decideForReply({ ...f.turn('你好'), suggestions: ['请发小猫'] })).code, 'PROBABILITY')
  const explicit = f.turn(`请发 ${item.id}`), choice = await f.store.decideForReply({ ...explicit, replyText: '' })
  assert.equal(choice.decision, 'send'); assert.equal(choice.item.id, item.id)
  assert.equal(f.calls.length, 0, '确切指定素材不被重新匹配')
  const p = f.permit(explicit, choice)
  assert.equal(f.store.claimDecision({ ...p, itemId: 'fake' }).decision, 'skip')
  assert.equal(f.store.claimDecision(p).decision, 'send')
  assert.equal(f.store.claimDecision(p).decision, 'skip')
  assert.equal(f.store.validateDecision({ ...p, itemId: 'fake' }), false)
  assert.equal(f.store.settleDecision({ decisionId: choice.decisionId, status: 'sent' }), true)
  f.config.stickers.autoChance = 1
  const next = await f.store.decideForReply(f.turn('你好'))
  assert.equal(next.decision, 'send'); assert.equal(f.calls.length, 1)
})

test('并发只领取一次，其他轮在预留期间不会调用模型', async t => {
  const waiting = gate(), entered = gate()
  const f = fixture(t, {}, async () => { entered.release(); await waiting.promise; return '{"decision":"send","number":1}' })
  await f.add('猫'); const turn = f.turn(), pending = f.store.decideForReply(turn)
  await entered.promise
  assert.equal((await f.store.decideForReply(turn)).code, 'ALREADY_DECIDED')
  assert.equal((await f.store.decideForReply(f.turn())).code, 'BUSY')
  waiting.release(); const result = await pending, p = f.permit(turn, result)
  const anotherStore = f.create()
  assert.equal(f.store.claimDecision(p).decision, 'send')
  assert.equal(anotherStore.claimDecision(p).decision, 'skip')
  assert.equal(f.calls.length, 1)
})

test('交叠批次将所有请求关联到已有决策，后续单独重放不再决策', async t => {
  const f = fixture(t, { autoChance: 0 }); await f.add('猫猫')
  const one = f.turn(), two = f.turn(), three = f.turn()
  const a = await f.store.decideForReply({ ...one, requestIds: [one.requestIds[0], two.requestIds[0]] })
  assert.equal(a.code, 'PROBABILITY')
  const b = await f.store.decideForReply({ ...two, requestIds: [two.requestIds[0], three.requestIds[0]] })
  assert.equal(b.code, 'ALREADY_DECIDED')
  assert.equal((await f.store.decideForReply(three)).code, 'ALREADY_DECIDED')
})

test('合并新的请求会取消在途决策、撤销 ready/claimed 许可，迟到结果不能复活', async t => {
  for (const stage of ['selecting', 'ready', 'claimed']) {
    const wait = gate(), enter = gate(), f = fixture(t, {}, async () => { enter.release(); await wait.promise; return '{"decision":"send","number":1}' })
    await f.add('猫猫'); const a = f.turn('你好'), b = f.turn('别发表情')
    const pending = f.store.decideForReply(a); await enter.promise
    let choice, permit
    if (stage !== 'selecting') {
      wait.release(); choice = await pending; permit = f.permit(a, choice)
      if (stage === 'claimed') assert.equal(f.store.claimDecision(permit).decision, 'send')
    }
    assert.equal((await f.store.decideForReply({ ...a, turnId: 'merged', requestIds: [a.requestIds[0], b.requestIds[0]] })).code, 'ALREADY_DECIDED')
    if (stage === 'selecting') { wait.release(); assert.equal((await pending).decision, 'skip') }
    else if (stage === 'ready') assert.equal(f.store.claimDecision(permit).decision, 'skip')
    else {
      assert.equal(f.store.validateDecision(permit), false)
      assert.equal(f.store.settleDecision({ decisionId: choice.decisionId, status: 'cancelled' }), true)
    }
    assert.equal((await f.store.decideForReply(b)).code, 'ALREADY_DECIDED')
  }
})

test('成功与未知状态跨 store 保留，同图冷却和两次完整回复间隔生效', async t => {
  const f = fixture(t, { minGapTurns: 2, sameStickerCooldownMs: 600_000 }), item = await f.add('猫猫')
  const sent = await f.send(f.turn())
  const reopened = f.create()
  assert.equal((await reopened.decideForReply(f.turn())).code, 'TURN_GAP')
  f.advance(600_001)
  for (let i = 0; i < 2; i++) {
    const r = await reopened.decideForReply(f.turn())
    assert.equal(r.code, 'TURN_GAP'); assert.equal(reopened.completeTurn({ decisionId: r.decisionId, completed: true }), true)
  }
  const turn = f.turn(), choice = await reopened.decideForReply(turn)
  assert.equal(choice.decision, 'send')
  const p = f.permit(turn, choice); assert.equal(reopened.claimDecision(p).decision, 'send')
  assert.equal(reopened.settleDecision({ decisionId: choice.decisionId, status: 'unknown' }), true)
  assert.equal(reopened.validateDecision(p), false)
  assert.equal((await reopened.decideForReply(turn)).code, 'ALREADY_DECIDED')
  const explicit = await reopened.decideForReply(f.turn(`发 ${item.id}`))
  assert.equal(explicit.code, 'NO_CANDIDATES', '未知结果也阻止同图重发')
  assert.equal(f.store.get(item.id, { chatId: 'group:1' }).uses, 1, '未知结果不记为确认使用')
  const rows = reopened.decisions({ admin: true, accountId: '100', chatId: 'group:1' }).items
  assert.ok(rows.some(x => x.id === sent.decisionId && x.state === 'sent'))
  assert.ok(rows.some(x => x.id === choice.decisionId && x.state === 'unknown'))
})

test('可信主动请求绕过概率、聊天冷却和间隔，但指定同图仍受冷却约束', async t => {
  const f = fixture(t, { autoChance: 1, minGapTurns: 2, chatCooldownMs: 60_000, sameStickerCooldownMs: 600_000 })
  const first = await f.add('一只猫'), second = await f.add('一只狗')
  const initial = f.turn(`发 ${first.id}`)
  await f.send(initial)
  f.config.stickers.autoChance = 0
  const normal = await f.store.decideForReply(f.turn('你好'))
  assert.equal(normal.code, 'CHAT_COOLDOWN')
  const repeated = await f.store.decideForReply(f.turn(`发 ${first.id}`))
  assert.equal(repeated.code, 'NO_CANDIDATES')
  const different = f.turn(`发 ${second.id}`), choice = await f.store.decideForReply(different)
  assert.equal(choice.decision, 'send'); assert.equal(choice.item.id, second.id)
  assert.equal(f.store.claimDecision(f.permit(different, choice)).decision, 'send')
})

test('关闭表情期间确认的完整回复仍计入间隔', async t => {
  const f = fixture(t, { minGapTurns: 2 }), item = await f.add('猫猫')
  await f.send(f.turn(`发 ${item.id}`))
  f.config.stickers.enabled = false
  for (let i = 0; i < 2; i++) assert.equal(f.store.completeTurn({ ...f.turn(), completed: true }), true)
  f.config.stickers.enabled = true
  assert.equal((await f.store.decideForReply(f.turn())).decision, 'send')
})

test('表情模块卸载期间仍可幂等登记真实完整回复', async t => {
  const f = fixture(t, { minGapTurns: 2 }), item = await f.add('猫猫')
  assert.equal(recordCompletedStickerTurn({ storage: f.storage, ...f.turn() }), false, '从未发送时不制造无关记录')
  await f.send(f.turn(`发 ${item.id}`))
  const one = f.turn(), two = f.turn()
  assert.equal(recordCompletedStickerTurn({ storage: f.storage, ...one }), true)
  assert.equal(recordCompletedStickerTurn({ storage: f.storage, ...one }), true)
  assert.equal((await f.store.decideForReply(f.turn())).code, 'TURN_GAP', '重复登记不是两轮')
  assert.equal(recordCompletedStickerTurn({ storage: f.storage, ...two }), true)
  assert.equal((await f.store.decideForReply(f.turn())).decision, 'send')
})

test('无合适项、非法输出、模型超时不回退第一张，超时同轮不重抽', async t => {
  let answer = '{"decision":"no_send"}'
  const f = fixture(t, { decisionTimeoutMs: 1000 }, async () => answer === 'never' ? new Promise(() => {}) : answer)
  await f.add('开心')
  assert.equal((await f.store.decideForReply(f.turn())).code, 'NO_MATCH')
  answer = '{"decision":"send","number":99}'
  assert.equal((await f.store.decideForReply(f.turn())).code, 'INVALID_SELECTION')
  answer = 'never'; const turn = f.turn()
  assert.equal((await f.store.decideForReply(turn)).code, 'MODEL_TIMEOUT')
  assert.equal((await f.store.decideForReply(turn)).code, 'ALREADY_DECIDED')
  assert.equal(f.calls.length, 3)
})

test('ready 选择超时未领取会被取消，不会永久卡住后续聊天', async t => {
  const f = fixture(t, { readyTtlMs: 30_000 }); await f.add('猫猫')
  const firstTurn = f.turn(), first = await f.store.decideForReply(firstTurn)
  assert.equal(first.decision, 'send')
  assert.equal(f.store.claimDecision({ ...f.permit(firstTurn, first), itemId: 'not-used-yet' }).decision, 'skip')
  // 尚未过期：同一聊天的新决策看到 BUSY 而不是覆盖。
  const busy = await f.store.decideForReply(f.turn())
  assert.equal(busy.code, 'BUSY')
  f.advance(30_001)
  const next = await f.store.decideForReply(f.turn())
  assert.equal(next.decision, 'send')
  const rows = f.store.decisions({ admin: true, accountId: '100', chatId: 'group:1' }).items
  assert.ok(rows.some(row => row.id === first.decisionId && row.state === 'cancelled' && row.code === 'READY_EXPIRED'))
})

test('缩图服务失去响应时总期限依然生效，不触发模型或重新抽取', async t => {
  const f = fixture(t, { decisionTimeoutMs: 1000 }); await f.add('猫猫')
  const store = f.create({ decisionPreview: () => new Promise(() => {}) }), turn = f.turn()
  assert.equal((await store.decideForReply(turn)).code, 'MODEL_TIMEOUT')
  assert.equal((await store.decideForReply(turn)).code, 'ALREADY_DECIDED')
  assert.equal(f.calls.length, 0)
})

test('发送前重验账号、请求取消、代次、范围、素材状态与精确 ID', async t => {
  const f = fixture(t, { libraryScope: 'chat' }), item = await f.add('小猫', 'group:1')
  const foreign = await f.store.decideForReply(f.turn('发一张表情', 'group:2'))
  assert.equal(foreign.code, 'NO_CANDIDATES')
  let turn = f.turn(), result = await f.store.decideForReply(turn), p = f.permit(turn, result)
  f.storage.requests.setState(turn.requestIds[0], 'canceled')
  assert.equal(f.store.claimDecision(p).decision, 'skip')
  // Failed validation does not admit a later send after its epoch changes.
  f.storage.epochs.bump('group:1')
  assert.equal(f.store.validateDecision(p), false)
  turn = f.turn(); result = await f.store.decideForReply(turn); p = f.permit(turn, result)
  assert.equal(f.store.claimDecision(p).decision, 'send')
  f.store.disable(item.id, { admin: true })
  assert.equal(f.store.validateDecision(p), false)
  f.config.botQQ = '999'
  assert.equal(f.store.validateDecision(p), false)
  assert.deepEqual(f.store.decisions({ admin: true, accountId: '100', allChats: true }).items, [])
})

test('共享素材存在同哈希副本时，明确指定的 ID 不会被去重替换', async t => {
  const f = fixture(t, { libraryScope: 'chat' })
  f.config.shareGroups = [{ id: 'shared', chats: ['group:1', 'group:2'], categories: ['image'] }]
  const one = await f.add('猫猫一', 'group:1', 91), two = await f.add('猫猫二', 'group:2', 91)
  assert.equal(one.sha256, two.sha256)
  for (const target of [one, two]) {
    const selected = await f.store.decideForReply(f.turn(`发 ${target.id}`))
    assert.equal(selected.decision, 'send'); assert.equal(selected.item.id, target.id)
    f.store.settleDecision({ decisionId: selected.decisionId, status: 'cancelled' })
  }
})

test('候选来自完整图库，包含描述、OCR、情境与实际图片；角色回退 vision', async t => {
  const f = fixture(t)
  f.config.roles.vision = { provider: 'vision', model: 'camera' }
  for (let i = 0; i < 75; i++) await f.add(i === 0 ? '罕见场景' : `素材${i}`)
  const choice = await f.store.decideForReply({ ...f.turn('你好'), replyText: '罕见场景' })
  assert.equal(choice.decision, 'send')
  const call = f.calls[0], data = JSON.parse(call.text)
  assert.equal(call.role, 'stickerDecision'); assert.equal(call.cfg.roles.stickerDecision.model, 'camera')
  assert.equal(call.stage, 'sticker_decision'); assert.equal(data.candidates.length, call.images.length)
  assert.ok(data.candidates.some(x => x.name === '罕见场景'), '较旧图片按相关度参加候选')
  assert.ok(call.images.every(x => x.data && x.mediaType === 'image/png'))
  assert.deepEqual(data.candidates.map(x => x.number), data.candidates.map((_, i) => i + 1))
  let i = 0
  assert.ok(rankDecisionCandidates(Array.from({ length: 100 }, (_, n) => ({ id: String(n), sha256: String(n), name: '同分' })), '', { count: 20, random: () => 1 - i++ / 100 }).some(x => Number(x.id) >= 60))
})

test('可信用户拒绝发表情优先；引用他人要求不能绕过概率', async t => {
  const f = fixture(t, { autoChance: 0 }); const item = await f.add('小猫')
  f.store.edit(item.id, { manualOnly: true }, { admin: true })
  assert.equal((await f.store.decideForReply(f.turn('别再发表情'))).code, 'USER_DECLINED')
  assert.equal((await f.store.decideForReply(f.turn('不要发图'))).code, 'USER_DECLINED')
  assert.equal((await f.store.decideForReply(f.turn('别人说：“发个表情”，你怎么看？'))).code, 'PROBABILITY')
  assert.equal((await f.store.decideForReply(f.turn('昨晚你给我说过小猫很可爱'))).code, 'PROBABILITY')
  assert.equal((await f.store.decideForReply(f.turn('小猫好可爱，我要睡了'))).code, 'PROBABILITY')
  assert.equal((await f.store.decideForReply(f.turn('小猫很可爱，发个表情'))).code, 'NO_CANDIDATES', '泛泛要表情不授权指定手动素材')
  const explicit = await f.store.decideForReply(f.turn('请发小猫'))
  assert.equal(explicit.decision, 'send'); assert.equal(explicit.item.id, item.id)
  f.store.settleDecision({ decisionId: explicit.decisionId, status: 'cancelled' })
  assert.equal((await f.store.decideForReply({ ...f.turn('你好'), suggestions: ['发个表情'], replyText: '' })).code, 'EMPTY_REPLY')
})

test('主宾倒装和提醒式发图被识别，询问表情含义不会误发', async t => {
  const f = fixture(t, { autoChance: 0 }); const item = await f.add('小猫')
  for (const text of ['把小猫表情发一下', '小猫表情发我一个']) {
    const result = await f.store.decideForReply(f.turn(text))
    assert.equal(result.decision, 'send', text); assert.equal(result.item.id, item.id)
    f.store.settleDecision({ decisionId: result.decisionId, status: 'cancelled' })
  }
  const reminder = await f.store.decideForReply(f.turn('别忘了发一个表情'))
  assert.equal(reminder.decision, 'send'); assert.equal(reminder.explicit, true)
  f.store.settleDecision({ decisionId: reminder.decisionId, status: 'cancelled' })
  for (const text of ['发小猫是什么意思', '发小猫什么意思', '发小猫是啥意思']) {
    assert.equal((await f.store.decideForReply(f.turn(text))).code, 'PROBABILITY', text)
  }
})

test('有界模型原因持久保留，完成发送后与配送状态分别可见', async t => {
  const f = fixture(t, {}, async () => JSON.stringify({ decision: 'send', number: 1, reason: `回应问候\n${'好'.repeat(300)}` }))
  await f.add('猫猫'); const turn = f.turn(), result = await f.send(turn)
  assert.ok(result.reason.startsWith('回应问候 ')); assert.ok(result.reason.length <= 160)
  const entry = f.store.decisions({ admin: true, accountId: '100', chatId: 'group:1' }).items.find(x => x.id === result.decisionId)
  assert.equal(entry.reason, result.reason); assert.equal(entry.selectionReason, result.reason); assert.equal(entry.deliveryReason, '表情已确认发送')
})

test('实际 askModel 路径记录独立视觉决策角色、阶段及业务结果', async t => {
  const f = fixture(t); await f.add('猫猫')
  const calls = [], events = []
  const dsh = {
    get: () => undefined,
    attachments: { admitPromptContent: async content => content },
    llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
      async *stream(params) { calls.push(params); yield { type: 'text-delta', text: '{"decision":"no_send","reason":"此处无需配图"}' }; yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } }; yield { type: 'finish', reason: 'stop' } } },
  }
  const off = observeModelUsage(dsh, e => events.push(e)); t.after(off)
  const store = f.create({ dsh, decideModel: undefined })
  const result = await store.decideForReply(f.turn())
  assert.equal(result.code, 'NO_MATCH'); assert.equal(result.reason, '此处无需配图')
  assert.equal(calls.length, 1); assert.equal(calls[0].messages[0].content.filter(x => x.type === 'image').length, 1)
  assert.equal(events.find(x => !x.phase)?.stage, 'sticker_decision')
  assert.equal(events.find(x => !x.phase)?.role, 'stickerDecision')
  assert.equal(events.find(x => x.phase === 'business')?.businessStatus, 'success')
})

test('独立决策角色不继承另一个全局模型的视觉声明', async t => {
  const f = fixture(t); await f.add('猫猫')
  f.config.model.vision = 'on'
  f.config.roles.stickerDecision = { provider: 'other', model: 'text-only' }
  let streams = 0
  const dsh = { get: () => undefined, attachments: { admitPromptContent: async x => x },
    llm: { resolveModelInfo: async () => ({ inputModalities: ['text'] }), async *stream() { streams++; yield { type: 'finish', reason: 'stop' } } } }
  const store = f.create({ dsh, decideModel: undefined })
  assert.equal((await store.decideForReply(f.turn())).code, 'NO_VISION')
  assert.equal(streams, 0)
})

test('概率和聊天冷却配置在调用期间或发送前改变时，用同一次掷骰重新校验', async t => {
  const wait = gate(), enter = gate(), f = fixture(t, {}, async () => { enter.release(); await wait.promise; return '{"decision":"send","number":1}' })
  await f.add('猫猫'); const turn = f.turn(), pending = f.store.decideForReply(turn)
  await enter.promise; f.config.stickers.autoChance = 0; wait.release()
  assert.equal((await pending).code, 'STALE_CONTEXT')
  f.config.stickers.autoChance = 1
  const store = f.create({ decideModel: async () => '{"decision":"send","number":1}' }), next = f.turn()
  const result = await store.decideForReply(next), permit = f.permit(next, result)
  assert.equal(store.claimDecision(permit).decision, 'send')
  f.config.stickers.autoChance = 0.2
  assert.equal(store.validateDecision(permit), false, '保留原始 0.3 掷骰，不重新随机')
  store.settleDecision({ decisionId: result.decisionId, status: 'cancelled' })
})

test('预览期间关闭总开关或开启试运行时，不触发付费模型', async t => {
  for (const key of ['enabled', 'dryRun', 'autoChance', 'isCurrent']) {
    const wait = gate(), enter = gate(), f = fixture(t)
    await f.add('猫猫')
    const store = f.create({ decisionPreview: async () => { enter.release(); await wait.promise; return { bytes: PNG, mime: 'image/png' } } })
    let current = true
    const pending = store.decideForReply({ ...f.turn(), isCurrent: () => current }); await enter.promise
    if (key === 'autoChance') f.config.stickers.autoChance = 0
    else if (key === 'isCurrent') current = false
    else f.config[key] = key === 'dryRun'
    wait.release(); assert.equal((await pending).decision, 'skip'); assert.equal(f.calls.length, 0)
  }
})

test('清除历史边界后，模型只能看到边界内的用户消息及已确认发送摘要', async t => {
  const f = fixture(t); await f.add('猫猫')
  const old = f.turn('已删除的旧聊天'), current = f.turn('边界后的新消息')
  const oldMessage = f.storage.requests.get(old.requestIds[0]).sourceMessageIds[0]
  const currentMessage = f.storage.requests.get(current.requestIds[0]).sourceMessageIds[0]
  f.storage.db.run('UPDATE messages SET platform_time=? WHERE id=?', 100, oldMessage)
  f.storage.db.run('UPDATE messages SET platform_time=? WHERE id=?', 1_000_000, currentMessage)
  f.storage.meta.set('history:boundary:100', { at: 900_000 })
  f.storage.meta.set(`stickers:recent-sent:${JSON.stringify(['100', 'group:1'])}`, [
    { epoch: 0, at: 100, text: '旧回复' }, { epoch: 0, at: 1_000_000, text: '边界后回复' },
  ])
  const choice = await f.store.decideForReply(current), evidence = JSON.parse(f.calls[0].text)
  assert.equal(choice.decision, 'send')
  assert.ok(evidence.conversation.some(x => x.text.includes('边界后的新消息')))
  assert.equal(evidence.conversation.some(x => x.text.includes('已删除的旧聊天')), false)
  assert.deepEqual(evidence.recentSent.map(x => x.text), ['边界后回复'])
  f.storage.meta.set('history:boundary:100', { at: 1_000_001 })
  assert.equal(f.store.claimDecision(f.permit(current, choice)).decision, 'skip')
})

test('预览期间撤回或停用素材时，失效图片不进入模型且图号仍对应', async t => {
  const wait = gate(), enter = gate(), f = fixture(t)
  const removed = await f.add('移除的图'), kept = await f.add('保留的图')
  const store = f.create({ decisionPreview: async item => { enter.release(); await wait.promise; return { bytes: Buffer.concat([PNG, Buffer.from(item.name)]), mime: 'image/png' } } })
  const pending = store.decideForReply(f.turn()); await enter.promise
  f.store.disable(removed.id, { admin: true }); wait.release()
  const result = await pending, input = f.calls[0], evidence = JSON.parse(input.text)
  assert.equal(result.decision, 'send'); assert.equal(result.item.id, kept.id)
  assert.deepEqual(evidence.candidates.map(x => [x.number, x.name]), [[1, '保留的图']])
  assert.equal(Buffer.from(input.images[0].data, 'base64').subarray(PNG.length).toString(), '保留的图')
  store.settleDecision({ decisionId: result.decisionId, status: 'cancelled' })
  const wait2 = gate(), enter2 = gate(), s = f.create({ decisionPreview: async () => { enter2.release(); await wait2.promise; return { bytes: PNG, mime: 'image/png' } } })
  const pending2 = s.decideForReply(f.turn()); await enter2.promise
  f.store.disable(kept.id, { admin: true }); wait2.release()
  assert.equal((await pending2).decision, 'skip'); assert.equal(f.calls.length, 1, '无有效预览时不能调用模型')
})

test('主动回复在预览期间清除历史后，模型只收到新边界内的上下文', async t => {
  const wait = gate(), enter = gate(), f = fixture(t); await f.add('猫猫')
  const old = f.turn('旧隐私消息'), oldId = f.storage.requests.get(old.requestIds[0]).sourceMessageIds[0]
  f.storage.db.run('UPDATE messages SET platform_time=? WHERE id=?', 100, oldId)
  const key = `stickers:recent-sent:${JSON.stringify(['100', 'group:1'])}`
  f.storage.meta.set(key, [{ epoch: 0, at: 100, text: '旧回复' }])
  const store = f.create({ decisionPreview: async () => { enter.release(); await wait.promise; return { bytes: PNG, mime: 'image/png' } } })
  const pending = store.decideForReply({ accountId: '100', chatId: 'group:1', epoch: 0, turnId: 'proactive-turn', requestIds: [], replyText: '新的回复' })
  await enter.promise; f.storage.meta.set('history:boundary:100', { at: 900_000 })
  const fresh = f.turn('新消息'), freshId = f.storage.requests.get(fresh.requestIds[0]).sourceMessageIds[0]
  f.storage.db.run('UPDATE messages SET platform_time=? WHERE id=?', 1_000_000, freshId)
  f.storage.meta.set(key, [{ epoch: 0, at: 100, text: '旧回复' }, { epoch: 0, at: 1_000_000, text: '新回复' }])
  wait.release(); assert.equal((await pending).decision, 'send')
  const evidence = JSON.parse(f.calls[0].text)
  assert.deepEqual(evidence.conversation.map(x => x.text), ['新消息'])
  assert.deepEqual(evidence.recentSent.map(x => x.text), ['新回复'])
})

test('群消息条数上限只提前跳过自动决策', async t => {
  const f = fixture(t); const item = await f.add('猫猫')
  assert.equal((await f.store.decideForReply({ ...f.turn(), automaticAllowed: false })).code, 'GROUP_CAP')
  assert.equal(f.calls.length, 0)
  assert.equal((await f.store.decideForReply({ ...f.turn(`发 ${item.id}`), automaticAllowed: false })).decision, 'send')
})

test('在途决策遇到模块停止或账号切换，迟到的模型结果不能变成可发送', async t => {
  const pending = gate(), entered = gate(), f = fixture(t, {}, async () => { entered.release(); await pending.promise; return '{"decision":"send","number":1}' })
  await f.add('猫猫'); const turn = f.turn(), answer = f.store.decideForReply(turn)
  await entered.promise; f.config.botQQ = '999'; pending.release()
  assert.equal((await answer).code, 'STALE_CONTEXT')
  f.config.botQQ = '100'
  const wait2 = gate(), enter2 = gate(), s = f.create({ decideModel: async () => { enter2.release(); await wait2.promise; return '{"decision":"send","number":1}' } })
  const later = s.decideForReply(f.turn()); await enter2.promise; s.stop(); wait2.release()
  assert.equal((await later).decision, 'skip')
})

test('进程中断后的已领取许可不能通过校验，恢复后 unknown 防止重发', async t => {
  const f = fixture(t, { sameStickerCooldownMs: 600_000 }), item = await f.add('猫猫'), turn = f.turn()
  const source = `
    import { createStorage } from './src/storage/index.js'
    import { createStickerStore } from './src/stickers/store.js'
    const [file, assets, rawConfig, rawTurn] = process.argv.slice(1)
    const config = JSON.parse(rawConfig), turn = JSON.parse(rawTurn)
    const storage = createStorage({ file, filesDir: assets, now: () => 1000000 })
    const store = createStickerStore({ storage, getConfig: () => config, now: () => 1000000, autoStart: false, random: () => 0.3,
      decisionPreview: async () => ({ bytes: Buffer.from('89504e47','hex'), mime:'image/png' }),
      decideModel: async () => '{"decision":"send","number":1}' })
    const choice = await store.decideForReply(turn)
    const permit = { ...turn, decisionId: choice.decisionId, itemId: choice.item.id }
    if (store.claimDecision(permit).decision !== 'send') throw new Error('claim failed')
    console.log(JSON.stringify(permit))
    process.exit(0)
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, join(f.root, 'state.db'), join(f.root, 'assets'), JSON.stringify(f.config), JSON.stringify(turn)], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  const permit = JSON.parse(child.stdout.trim())
  assert.equal(f.store.validateDecision(permit), false, '不能直接重用崩溃进程的许可')
  assert.equal((await f.store.decideForReply(turn)).code, 'ALREADY_DECIDED')
  const after = await f.store.decideForReply(f.turn(`发 ${item.id}`))
  assert.equal(after.code, 'NO_CANDIDATES')
  assert.equal(f.store.decisions({ admin: true, accountId: '100', chatId: 'group:1' }).items.find(x => x.id === permit.decisionId).state, 'unknown')
})

test('预览复用审核帧，静图缩放有硬上限和缓存，不发送动画原件', async t => {
  const f = fixture(t), make = createDecisionPreviews({ storage: f.storage }), signal = new AbortController().signal
  const bytes = png(640, 400), asset = f.storage.assets.put(bytes, { mime: 'image/png', width: 640, height: 400 })
  const item = { assetId: asset.id, animated: false }, result = await make(item, signal)
  assert.equal(result.mime, 'image/jpeg')
  assert.ok(result.bytes.length <= 192 * 1024)
  const size = imageSize(result.bytes)
  assert.ok(size.width <= 320 && size.height <= 320)
  assert.equal(await make(item, signal), result, '同一资产复用内存预览')
  const animation = f.storage.assets.put(GIF, { mime: 'image/gif', width: 1, height: 1 })
  assert.equal((await make({ assetId: animation.id, animated: true, frames: [] }, signal)).mime, 'image/jpeg')
  const frame = f.storage.assets.put(png(100, 100), { mime: 'image/png', width: 100, height: 100 })
  assert.equal((await make({ assetId: asset.id, animated: true, frames: [{ assetId: frame.id }] }, signal)).mime, 'image/png')
})

test('已批准但没有帧的旧动画能生成首帧供视觉选择，缺 ffmpeg 时明确跳过', async t => {
  const f = fixture(t)
  const { item } = await f.store.addFromBuffer(GIF, { chatId: 'group:1', name: '旧动画', toQQ: false })
  assert.equal(f.store.approve(item.id, { admin: true, reviewedOriginal: true }).ok, true)
  const store = f.create({ decisionPreview: undefined })
  const choice = await store.decideForReply(f.turn())
  assert.equal(choice.decision, 'send')
  assert.equal(JSON.parse(f.calls[0].text).candidates[0].animatedPartial, true)
  assert.equal(f.calls[0].images[0].mediaType, 'image/jpeg')
  store.settleDecision({ decisionId: choice.decisionId, status: 'cancelled' })
  const unavailable = createDecisionPreviews({ storage: f.storage, executable: join(f.root, 'missing-ffmpeg') })
  const noDecoder = f.create({ decisionPreview: unavailable })
  const result = await noDecoder.decideForReply(f.turn())
  assert.equal(result.code, 'PREVIEW_UNAVAILABLE')
  assert.equal(f.calls.length, 1)
})

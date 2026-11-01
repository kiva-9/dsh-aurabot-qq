import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createStickerStore } from '../src/stickers/store.js'
import stickersModule from '../src/modules/stickers/index.js'
import qqToolsModule from '../src/modules/qq-tools/index.js'
import { hubFixture, privateChat, OWNER, BOT, until } from './helpers/hub-fixture.js'
import { png } from './helpers/images.js'

const chatId = `private:${OWNER}`
const quiet = { info() {}, debug() {}, warn() {}, error() {} }
const sticker = message => message.some(s => s.type === 'image' && Number(s.data?.sub_type) === 1)

async function fixture(t, { chance = 1, hooks, brain, onSend, model, config = {}, withTool = false, withQQTool = false } = {}) {
  let store, extra, hub
  const toolFactories = []
  const moduleAvailability = { enabled: true }
  t.after(async () => { await hub?.dispose(); await extra?.stop(); await store?.stop() })
  const calls = [], modelCalls = [], toolResults = []
  const gateway = { async call(action, params) {
    if (action === 'set_input_status') return {}
    if (action.startsWith('send_')) {
      calls.push({ action, message: params.message })
      if (onSend) await onSend({ action, params, calls })
      return { message_id: calls.length }
    }
    return {}
  } }
  const facade = new Proxy({}, { get: (_target, key) => (...args) => moduleAvailability.enabled ? store?.[key]?.(...args) : undefined })
  const f = await hubFixture(t, { onebot: gateway, stickers: facade, hooks, brain,
    buildTools: where => toolFactories.flatMap(factory => factory(where) || []), moodEffects: () => ({ sticker: 100, delay: 0, voice: 1 }),
    config: { model: { vision: 'on' }, voice: { enabled: false }, stickers: { enabled: true, caption: false,
      autoReview: false, autoChance: chance, collect: false, chatCooldownMs: 0, sameStickerCooldownMs: 0, cooldownMs: 0, minGapTurns: 0 }, ...config } })
  hub = f.hub
  store = createStickerStore({ storage: f.storage, dsh: f.fake.ctx, getConfig: () => f.cfg, onebot: gateway, log: quiet, autoStart: false,
    random: () => 0.25, decideModel: async (_dsh, input) => { modelCalls.push(input); return model ? model(input) : '{"decision":"send","number":1}' } })
  const added = await store.addFromBuffer(png(20, 20, 17), { chatId, name: '小猫', tags: ['开心'], toQQ: false })
  assert.equal(added.ok, true)
  assert.equal(store.approve(added.item.id, { admin: true }).ok, true)
  if (withTool) {
    extra = stickersModule.setup({ config: () => f.cfg, dsh: f.fake.ctx, log: quiet,
      core: { storage: f.storage, hub: f.hub, onebot: gateway, http: {}, stickerLegacyDir: join(f.root, 'legacy') },
      tool: fn => { toolFactories.push(fn) }, route() {}, rule() {}, onDispose() {} })
  }
  if (withQQTool) qqToolsModule.setup({ config: () => f.cfg, core: { storage: f.storage, hub: f.hub, onebot: gateway },
    tool: fn => { toolFactories.push(fn) } })
  const request = (value, scope = chatId, author = OWNER) => {
    const msg = f.storage.messages.ingest({ account: String(f.cfg.botQQ), chatId: scope, authorId: author,
      platformMsgId: String(Math.random()), text: value, segments: [{ type: 'text', data: { text: value } }] })
    return { msg, req: f.storage.requests.create({ chatId: scope, actorId: author, sourceMessageIds: [msg.id] }) }
  }
  return { ...f, store, calls, modelCalls, toolResults, request, moduleAvailability, item: added.item }
}

test('0 and 1 probability apply to plain replies, tags, tool hints and item hooks', async t => {
  for (const chance of [0, 1]) for (const source of ['plain', 'tag', 'tool', 'hook']) await t.test(`${chance} ${source}`, async t => {
    const hooks = source === 'hook' ? { items: items => [...items, { kind: 'sticker', value: '小猫' }] } : undefined
    const f = await fixture(t, { chance, hooks })
    const reply = source === 'tag' ? '开心<sticker:小猫><sticker:开心>' : '开心'
    const result = await f.hub.deliver(chatId, reply, { turnId: 'turn', suggestions: source === 'tool' ? ['小猫', '开心'] : [] })
    assert.equal(result.complete, true)
    assert.equal(f.calls.filter(x => sticker(x.message)).length, chance)
    assert.equal(f.modelCalls.length, chance)
    if (source === 'tag') {
      const deliveredText = f.calls.filter(x => !sticker(x.message)).flatMap(x => x.message).map(x => x.data?.text || '').join('')
      assert.equal(deliveredText, '开心', '旧标签只作建议，不能作为正文发出去')
    }
    const log = f.store.decisions({ admin: true, accountId: BOT, chatId }).items
    assert.equal(log.length, 1)
    assert.equal(log[0].code, chance ? 'SENT' : 'PROBABILITY')
  })
})

test('legacy tags cannot bypass the chat cooldown or leak into delivered text', async t => {
  const f = await fixture(t)
  f.cfg.stickers.chatCooldownMs = 60_000
  await f.hub.deliver(chatId, '第一条<sticker:小猫>', { turnId: 'first' })
  await f.hub.deliver(chatId, '第二条<sticker:小猫>', { turnId: 'second' })
  assert.equal(f.calls.filter(x => sticker(x.message)).length, 1)
  assert.equal(f.modelCalls.length, 1)
  assert.deepEqual(f.calls.filter(x => !sticker(x.message)).map(x => x.message.map(s => s.data?.text || '').join('')), ['第一条', '第二条'])
  assert.equal(f.store.decisions({ admin: true, accountId: BOT, chatId }).items[0].code, 'CHAT_COOLDOWN')
})

test('multiple actual tool calls only register hints; a trusted explicit request without final text still sends once', async t => {
  const receipts = []
  const f = await fixture(t, { chance: 0, withTool: true, brain: async ({ callTool }) => {
    receipts.push(await callTool('qq_send_sticker', { name: '小猫' }))
    receipts.push(await callTool('qq_send_sticker', { name: '开心' }))
    return ''
  } })
  const { req } = f.request('请发小猫')
  await f.hub.pushToSession(privateChat(), [{ type: 'text', text: '请发小猫' }], OWNER, { requests: [req], queryText: '请发小猫' })
  await until(() => f.store.decisions({ admin: true, accountId: BOT, chatId }).items.some(x => x.state === 'sent'))
  assert.equal(receipts.length, 2)
  assert.ok(receipts.every(r => r.ok && r.code === 'PENDING_DECISION' && /尚未发送/.test(r.message)))
  assert.equal(f.calls.filter(x => sticker(x.message)).length, 1)
  assert.equal(f.modelCalls.length, 0, '明确指定素材不需要额外模型调用')
})

test('actual repeated tool calls share the automatic probability with tags', async t => {
  for (const chance of [0, 1]) await t.test(String(chance), async t => {
    const receipts = []
    const f = await fixture(t, { chance, withTool: true, brain: async ({ callTool }) => {
      receipts.push(await callTool('qq_send_sticker', { name: '小猫' }))
      receipts.push(await callTool('qq_send_sticker', { name: '开心' }))
      return '开心<sticker:小猫><sticker:开心>'
    } })
    const { req } = f.request('今天开心')
    await f.hub.pushToSession(privateChat(), [{ type: 'text', text: '今天开心' }], OWNER, { requests: [req], queryText: '今天开心' })
    await until(() => f.storage.requests.get(req.id).state === 'answered')
    assert.ok(receipts.every(r => r.code === 'PENDING_DECISION'))
    assert.equal(f.calls.filter(x => sticker(x.message)).length, chance)
    assert.equal(f.modelCalls.length, chance)
    assert.equal(f.store.decisions({ admin: true, accountId: BOT, chatId }).total, 1)
  })
})

test('qq_send_message deliveries share the real turn with the final reply and with each other', async t => {
  for (const scope of ['same-chat', 'other-chat', 'proactive']) await t.test(scope, async t => {
    const target = scope === 'same-chat' ? chatId : 'group:62001'
    const f = await fixture(t, { withQQTool: true, brain: async ({ callTool }) => {
      await callTool('qq_send_message', { target, text: '开心<sticker:小猫>' })
      await callTool('qq_send_message', { target, text: '再来<sticker:开心>' })
      return scope === 'same-chat' ? '最后一句<sticker:小猫>' : '[沉默]'
    } })
    const { req } = f.request('今天开心')
    const requests = scope === 'proactive' ? [] : [req]
    await f.hub.pushToSession(privateChat(), [{ type: 'text', text: '今天开心' }], OWNER, { requests, queryText: '今天开心' })
    await until(() => f.store.decisions({ admin: true, accountId: BOT, chatId: target }).items.some(x => x.state === 'sent'))
    assert.equal(f.calls.filter(c => sticker(c.message)).length, 1)
    assert.equal(f.modelCalls.length, 1)
    assert.equal(f.store.decisions({ admin: true, accountId: BOT, chatId: target }).total, 1)
  })
})

test('a send-message tool never borrows another chat request as explicit evidence', async t => {
  const f = await fixture(t, { chance: 0, withQQTool: true, brain: async ({ callTool }) => {
    await callTool('qq_send_message', { target: 'group:62001', text: '开心<sticker:小猫>' })
    return '[沉默]'
  } })
  const { req } = f.request('请发小猫')
  await f.hub.pushToSession(privateChat(), [{ type: 'text', text: '请发小猫' }], OWNER, { requests: [req], queryText: '请发小猫' })
  await until(() => f.storage.requests.get(req.id).state === 'ended')
  assert.equal(f.calls.filter(c => sticker(c.message)).length, 0)
  assert.equal(f.modelCalls.length, 0)
  assert.equal(f.store.decisions({ admin: true, accountId: BOT, chatId: 'group:62001' }).items[0].code, 'PROBABILITY')
})

test('an explicit silence token stays silent even when a sticker tool and trusted request exist', async t => {
  let itemsHookCalls = 0
  const f = await fixture(t, { chance: 0, withTool: true,
    hooks: { items: items => { itemsHookCalls++; return items } },
    brain: async ({ callTool }) => { await callTool('qq_send_sticker', { name: '小猫' }); return '[沉默]' } })
  const { req } = f.request('请发小猫')
  await f.hub.pushToSession(privateChat(), [{ type: 'text', text: '请发小猫' }], OWNER, { requests: [req], queryText: '请发小猫' })
  await until(() => f.storage.requests.get(req.id).state === 'ended')
  assert.equal(f.calls.length, 0)
  assert.equal(itemsHookCalls, 0)
  assert.equal(f.store.decisions({ admin: true, accountId: BOT, chatId }).total, 0)
})

test('group bubble cap preserves text and quotes; a real explicit sticker request may exceed the soft cap', async t => {
  for (const explicit of [false, true]) await t.test(String(explicit), async t => {
    const group = 'group:62001'
    const f = await fixture(t, { hooks: { items: items => [{ kind: 'sticker', value: '开心' }, ...items, { kind: 'sticker', value: '小猫' }] } })
    const { req } = f.request(explicit ? '请发小猫' : '今天开心', group)
    const result = await f.hub.deliver(group, '第一段|||第二段|||第三段<sticker:小猫>', { turnId: req.id, requestId: req.id, requestIds: [req.id] })
    assert.equal(result.complete, true)
    assert.deepEqual(f.calls.filter(c => !sticker(c.message)).map(c => c.message.map(s => s.data?.text || '').join('')), ['第一段', '第二段', '第三段'])
    assert.equal(f.calls.filter(c => sticker(c.message)).length, explicit ? 1 : 0)
    assert.equal(f.modelCalls.length, 0, '群聊无空位的自动表情不应调用视觉模型')
  })
})

test('retries and concurrent deliveries sharing a turn never redraw or duplicate a sticker', async t => {
  const f = await fixture(t)
  const opts = { turnId: 'same-turn', suggestions: ['小猫', '开心'] }
  await Promise.all([f.hub.deliver(chatId, '开心<sticker:小猫>', opts), f.hub.deliver(chatId, '开心<sticker:开心>', opts)])
  await f.hub.deliver(chatId, '开心', opts)
  assert.equal(f.calls.filter(x => sticker(x.message)).length, 1)
  assert.equal(f.modelCalls.length, 1)
  assert.equal(f.store.decisions({ admin: true, accountId: BOT, chatId }).total, 1)
})

test('send-time cancellation, changed account or epoch, revoked request and disabled module only suppress the sticker', async t => {
  for (const change of ['abort', 'account', 'epoch', 'recalled', 'request', 'disabled', 'material']) await t.test(change, async t => {
    let f, source
    const controller = new AbortController()
    f = await fixture(t, { onSend: ({ params }) => {
      if (sticker(params.message)) return
      if (change === 'abort') controller.abort()
      if (change === 'account') f.cfg.botQQ = '999'
      if (change === 'epoch') f.storage.epochs.bump(chatId, 'test')
      if (change === 'recalled') f.storage.messages.markRecalled(chatId, f.storage.messages.get(source.msg.id).platformMsgId)
      if (change === 'request') f.storage.requests.setState(source.req.id, 'canceled')
      if (change === 'disabled') f.cfg.stickers.enabled = false
      if (change === 'material') f.store.disable(f.item.id, { admin: true })
    } })
    source = f.request('今天开心')
    const result = await f.hub.deliver(chatId, '先发正文<sticker:小猫>', { turnId: source.req.id, requestId: source.req.id,
      requestIds: [source.req.id], epoch: source.req.epoch, signal: controller.signal })
    assert.equal(f.calls.filter(x => !sticker(x.message)).length, 1)
    assert.equal(f.calls.filter(x => sticker(x.message)).length, 0)
    assert.equal(result.confirmed, true)
    assert.equal(result.complete, true)
  })
})

test('unknown gateway outcome consumes the decision and never marks a confirmed use or retries', async t => {
  const f = await fixture(t, { onSend: ({ params }) => { if (sticker(params.message)) throw new Error('connection lost after send') } })
  const options = { turnId: 'unknown-turn' }
  const first = await f.hub.deliver(chatId, '开心', options)
  assert.equal(first.complete, true, '表情结果未知不妨碍正文')
  assert.equal(first.deliveries.some(d => d.unknown), true)
  await f.hub.deliver(chatId, '开心', options)
  assert.equal(f.calls.filter(x => sticker(x.message)).length, 1)
  assert.equal(f.modelCalls.length, 1)
  assert.equal(f.store.decisions({ admin: true, accountId: BOT, chatId }).items[0].state, 'unknown')
  assert.equal(f.store.get(f.item.id, { chatId }).uses, 0)
})

test('model refusal, lack of vision and timeout never fall back to the first image or block text', async t => {
  for (const type of ['no_match', 'no_vision', 'timeout']) await t.test(type, async t => {
    const f = await fixture(t, { model: () => {
      if (type === 'no_match') return '{"decision":"no_send"}'
      if (type === 'no_vision') throw Object.assign(new Error('no vision'), { code: 'NO_VISION' })
      return new Promise(() => {})
    } })
    f.cfg.stickers.decisionTimeoutMs = 1000
    const result = await f.hub.deliver(chatId, '开心<sticker:小猫>', { turnId: type })
    assert.equal(result.complete, true)
    assert.equal(f.calls.length, 1)
    assert.equal(sticker(f.calls[0].message), false)
    assert.equal(f.store.decisions({ admin: true, accountId: BOT, chatId }).items[0].code,
      { no_match: 'NO_MATCH', no_vision: 'NO_VISION', timeout: 'MODEL_TIMEOUT' }[type])
  })
})

test('simulation and dry run make no decision model calls or usage records', async t => {
  const f = await fixture(t)
  await f.hub.capture(() => f.hub.deliver(chatId, '开心<sticker:小猫>', { turnId: 'capture' }))
  await f.hub.deliver(chatId, '开心<sticker:小猫>', { turnId: 'simulate', simulate: true })
  f.cfg.dryRun = true
  await f.hub.deliver(chatId, '开心<sticker:小猫>', { turnId: 'dry' })
  assert.equal(f.modelCalls.length, 0)
  assert.equal(f.store.decisions({ admin: true, accountId: BOT, chatId }).total, 0)
  assert.equal(f.store.get(f.item.id, { chatId }).uses, 0)
})

test('hooks.send cannot inject unapproved sticker segments into normal text', async t => {
  const f = await fixture(t, { chance: 0, hooks: { send: message => [...message, { type: 'mface', data: { emoji_id: 'fake' } }] } })
  const result = await f.hub.deliver(chatId, '正文', { turnId: 'hooks-send' })
  assert.equal(result.complete, true)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].message.some(s => s.type === 'mface'), false)
})

test('last send hook cannot race revocation after the outbox guard', async t => {
  let f, source
  f = await fixture(t, { hooks: { send: async message => {
    if (sticker(message)) f.storage.messages.markRecalled(chatId, f.storage.messages.get(source.msg.id).platformMsgId)
    return message
  } } })
  source = f.request('今天开心')
  const result = await f.hub.deliver(chatId, '正文<sticker:小猫>', { turnId: source.req.id, requestId: source.req.id, requestIds: [source.req.id] })
  assert.equal(result.complete, true)
  assert.equal(f.calls.filter(c => sticker(c.message)).length, 0)
  assert.equal(f.calls.filter(c => !sticker(c.message)).length, 1)
})

test('an asynchronous last send hook rechecks abort and the caller guard before QQ', async t => {
  for (const reason of ['signal', 'guard']) await t.test(reason, async t => {
    let resume, notifyStarted, allowed = true
    const blocked = new Promise(resolve => { resume = resolve }), started = new Promise(resolve => { notifyStarted = resolve })
    const f = await fixture(t, { hooks: { send: async message => {
      if (sticker(message)) { notifyStarted(); await blocked }
      return message
    } } })
    const controller = new AbortController()
    const work = f.hub.deliver(chatId, '正文<sticker:小猫>', { turnId: reason, signal: controller.signal, shouldSend: () => allowed })
    await started
    if (reason === 'signal') controller.abort(); else allowed = false
    resume()
    const result = await work
    assert.equal(result.complete, true)
    assert.equal(f.calls.filter(c => sticker(c.message)).length, 0)
    assert.equal(f.calls.filter(c => !sticker(c.message)).length, 1)
    assert.ok(result.deliveries.some(d => d.rows.some(row => row.kind === 'sticker' && row.state === 'failed' && row.outcome === 'rejected')))
  })
})

test('recovery checks the persisted permit and still delivers other outbox rows', async t => {
  const f = await fixture(t)
  const epoch = f.storage.epochs.current(chatId)
  const fakePermit = { decisionId: 'forged', accountId: BOT, chatId, epoch, requestIds: [], turnId: 'old', itemId: f.item.id }
  const batch = f.hub.outbox.enqueue({ chatId, epoch, items: [
    { kind: 'text', message: [{ type: 'text', data: { text: '第一段' } }] },
    { kind: 'sticker', message: [{ type: 'sticker-ref', data: { id: f.item.id, permit: fakePermit } }] },
    { kind: 'text', message: [{ type: 'text', data: { text: '第二段' } }] },
  ] })
  await f.hub.recoverOutbox({ shouldSend: () => true })
  assert.deepEqual(f.hub.outbox.rows(batch).map(r => r.state), ['delivered', 'failed', 'delivered'])
  assert.equal(f.calls.length, 2)
  assert.ok(f.calls.every(c => !sticker(c.message)))
})

test('model context only includes confirmed text actually sent in this account and epoch', async t => {
  const f = await fixture(t, { model: () => '{"decision":"no_send"}' })
  await f.hub.deliver(chatId, '真实正文<sticker:虚构标签>', { turnId: 'first' })
  await f.hub.deliver(chatId, '第二句话', { turnId: 'second' })
  const prompt = JSON.parse(f.modelCalls[1].text)
  assert.ok(prompt.recentSent.some(x => x.text.includes('真实正文')))
  assert.ok(prompt.recentSent.every(x => !x.text.includes('虚构标签')))
  f.storage.epochs.bump(chatId, 'test new conversation')
  await f.hub.deliver(chatId, '第三句话', { turnId: 'third' })
  assert.deepEqual(JSON.parse(f.modelCalls[2].text).recentSent, [])
})

test('confirmed replies while stickers are switched off still count toward the turn gap', async t => {
  for (const mode of ['setting', 'module']) await t.test(mode, async t => {
    const f = await fixture(t)
    f.cfg.stickers.minGapTurns = 2
    await f.hub.deliver(chatId, '开心', { turnId: 'first' })
    if (mode === 'setting') f.cfg.stickers.enabled = false; else f.moduleAvailability.enabled = false
    await f.hub.deliver(chatId, '第二轮', { turnId: 'second' })
    await f.hub.deliver(chatId, '第三轮', { turnId: 'third' })
    if (mode === 'setting') f.cfg.stickers.enabled = true; else f.moduleAvailability.enabled = true
    await f.hub.deliver(chatId, '又开心了', { turnId: 'fourth' })
    assert.equal(f.calls.filter(c => sticker(c.message)).length, 2)
    assert.equal(f.modelCalls.length, 2)
    assert.equal(f.store.decisions({ admin: true, accountId: BOT, chatId }).items.filter(r => r.completed).length, 4)
  })
})

test('another chat, a recalled message, negation and quoted text cannot create explicit-request authority', async t => {
  for (const type of ['other-chat', 'recalled', 'negated', 'quoted']) await t.test(type, async t => {
    const f = await fixture(t, { chance: 0 })
    const target = type === 'other-chat' ? 'group:62001' : chatId
    const value = type === 'negated' ? '别再发表情' : type === 'quoted' ? '他说过“发小猫”，这句话什么意思？' : '请发小猫'
    const source = f.request(value)
    if (type === 'recalled') f.storage.messages.markRecalled(chatId, f.storage.messages.get(source.msg.id).platformMsgId)
    await f.hub.deliver(target, '好的<sticker:小猫>', { turnId: `evidence-${type}`, requestId: source.req.id, requestIds: [source.req.id] })
    assert.equal(f.calls.filter(x => sticker(x.message)).length, 0)
    assert.equal(f.modelCalls.length, 0)
  })
})

test('model-provided wording and hints do not substitute for a trusted explicit request', async t => {
  const f = await fixture(t, { chance: 0 })
  const result = await f.hub.deliver(chatId, '发小猫<sticker:小猫>', { turnId: 'claimed-explicit', userText: '请发小猫', suggestions: ['小猫'] })
  assert.equal(result.complete, true)
  assert.equal(f.calls.filter(c => sticker(c.message)).length, 0)
  assert.equal(f.modelCalls.length, 0)
  assert.equal(f.store.decisions({ admin: true, accountId: BOT, chatId }).items[0].code, 'PROBABILITY')
})

test('legacy sendSticker reports success only for a confirmed sticker, not hook-added text', async t => {
  const f = await fixture(t, { chance: 0, hooks: { items: () => [{ kind: 'text', value: '额外正文' }] } })
  assert.equal(await f.hub.sendSticker(chatId, '小猫'), false)
  assert.equal(f.calls.length, 1)
  assert.equal(sticker(f.calls[0].message), false)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createStorage } from '../src/storage/index.js'
import { createOutbox } from '../src/delivery/outbox.js'
import { createSongStudio } from '../src/song/studio.js'
import { normalize } from '../src/core/config.js'

const gate = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
const receipt = { delivered: 1, total: 1, message_id: 'qq-1', messageIds: ['qq-1'], assetId: 'asset-1' }
function fixture(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-song-jobs-'))
  process.env.AURABOT_DATA_DIR = dir
  const audio = join(dir, 'mock.mp3'); writeFileSync(audio, Buffer.from('ID3-local-test-audio'))
  const cfg = normalize({ enabled: true, dryRun: false, botQQ: '90000001', ownerQQ: '10000001',
    song: { enabled: true, ownerOnly: true, root: join(dir, 'runtime'), neteaseCookie: 'secret-test-cookie' } })
  const storage = createStorage({ file: join(dir, 'test.sqlite'), filesDir: join(dir, 'assets') })
  const connections = [storage]
  const open = () => { const db = createStorage({ file: join(dir, 'test.sqlite'), filesDir: join(dir, 'assets') }); connections.push(db); return db }
  let personaId = 'fish', generated = 0
  const hub = { personaFor: () => ({ personaId, revision: 1, layers: { identity: { name: '鱼' } } }) }
  const sent = [], sung = [], services = [], warnings = []
  const deps = { getConfig: () => cfg, storage, hub, log: { info() {}, debug() {}, warn: (...x) => warnings.push(x) },
    processSong: async () => { generated++; return { file: audio, title: '本地测试歌', voice: 'fish' } },
    sendVoiceFile: async (...args) => { sent.push(args); return { ...receipt } },
    sendText: () => assert.fail('unknown 禁止回落文字或宣称发送失败'),
    onSung: async (...args) => { sung.push(args); return { ok: true } }, ...extra }
  const create = (over = {}) => { const s = createSongStudio({ ...deps, ...over }); services.push(s); return s }
  const s = create()
  const context = (actorId = cfg.ownerQQ, chatId = 'group:22') => {
    const source = storage.messages.ingest({ account: cfg.botQQ, chatId, authorId: actorId, text: '唱首歌', eventKind: 'message' })
    const r = storage.requests.create({ chatId, actorId, sourceMessageIds: [source.id] })
    return { account: cfg.botQQ, chatId, actorId, requestId: r.id, epoch: r.epoch, persona: personaId, personaSnapshot: hub.personaFor() }
  }
  t.after(() => { services.forEach((x) => x.stop()); connections.reverse().forEach((x) => x.close()); rmSync(dir, { recursive: true, force: true }) })
  return { s, create, open, context, cfg, storage, hub, sent, sung, audio, dir, warnings, generated: () => generated, persona: (p) => { personaId = p } }
}

test('持久翻唱按当前 actor 授权，冻结 scope/人格/设置，回执数量为1才 onSung；同 request 不重复', async (t) => {
  const f = fixture(t), ctx = f.context()
  assert.equal(f.s.request({ song: '拒绝', ...f.context('20000002') }).ok, false)
  const r = f.s.request({ song: '测试', ...ctx })
  assert.equal(r.ok, true, r.message)
  f.cfg.song.pitch = 12
  assert.equal(f.s.runner.get(r.job_id).input.settings.pitch, 0)
  assert.equal(JSON.stringify(f.s.runner.get(r.job_id)).includes('secret-test-cookie'), false)
  await f.s.tick()
  const j = f.s.runner.get(r.job_id)
  assert.equal(j.state, 'delivered', JSON.stringify(j))
  assert.equal(f.generated(), 1); assert.equal(f.sent.length, 1); assert.equal(f.sung.length, 1)
  const options = f.sent[0][3], evidence = f.sung[0][2]
  assert.equal(options.epoch, ctx.epoch); assert.equal(options.requestId, ctx.requestId)
  assert.equal(options.batchId, 'song:' + r.job_id)
  assert.equal(typeof options.guard, 'function')
  assert.deepEqual({ account: evidence.account, chat: evidence.chat, persona: evidence.persona }, { account: ctx.account, chat: ctx.chatId, persona: 'fish' })
  assert.equal(evidence.confirmed, true); assert.equal(evidence.sourceId, 'qq:90000001:group:22:qq-1')
  assert.equal(f.s.request({ song: '同一个请求', ...ctx }).job_id, r.job_id)
  await f.s.tick(); assert.equal(f.sent.length, 1)
})

for (const mode of ['cancel', 'disable', 'epoch', 'persona', 'account', 'stop']) {
  test(`翻唱推理忽略 signal 后迟到：${mode} 仍不能发出或记录经历`, async (t) => {
    const f = fixture(t), started = gate(), finish = gate(), ctx = f.context()
    f.s.stop()
    const s = f.create({ processSong: async (_job, execution) => { started.resolve(execution); await finish.promise; return { file: f.audio } } })
    const r = s.request({ song: '慢歌', ...ctx }), work = s.tick()
    const execution = await started.promise
    if (mode === 'cancel') { assert.equal(s.cancel(r.job_id, { ...ctx, actorId: 'other' }).ok, false); assert.equal(s.cancel(r.job_id, ctx).ok, true) }
    if (mode === 'disable') f.cfg.song.enabled = false
    if (mode === 'epoch') f.storage.epochs.bump(ctx.chatId, 'test cancel')
    if (mode === 'persona') f.persona('other')
    if (mode === 'account') f.cfg.botQQ = '90000002'
    if (mode === 'stop') s.stop()
    assert.equal(execution.guard(), false)
    finish.resolve(); await work; await s.tick()
    assert.equal(f.sent.length, 0); assert.equal(f.sung.length, 0)
    assert.notEqual(s.runner.get(r.job_id).state, 'delivered')
  })
}

test('unknown/pending 不反复发送、不 fallback；skipped 和无 message_id 不能 onSung', async (t) => {
  for (const outcome of ['unknown', 'pending', 'skipped', 'no-receipt', 'canceled']) {
    await t.test(outcome, async (t) => {
      let sends = 0
      const f = fixture(t, { sendVoiceFile: async () => {
        sends++
        if (outcome === 'unknown' || outcome === 'pending') throw Object.assign(new Error('uncertain'), { code: 'DELIVERY_UNKNOWN', assetId: 'saved-asset', delivery: { [outcome]: 1 } })
        if (outcome === 'canceled') throw Object.assign(new Error('canceled'), { code: 'DELIVERY_CANCELED' })
        return outcome === 'skipped' ? { delivered: 0, skipped: 1 } : { delivered: 1 }
      } })
      const ctx = f.context(), r = f.s.request({ song: '测试', ...ctx })
      await f.s.tick(); await f.s.tick(); f.s.recover(); await f.s.tick()
      assert.equal(sends, 1); assert.equal(f.sung.length, 0)
      assert.equal(f.s.resend(r.job_id, ctx).ok, false)
      const j = f.s.runner.get(r.job_id)
      assert.ok(j.output.file); assert.notEqual(j.state, 'delivered')
      if (outcome === 'unknown') {
        assert.equal(j.output.assetId, 'saved-asset')
        assert.match(f.s.status().history[0].message, /结果不确定/)
        assert.doesNotMatch(f.s.status().history[0].message, /失败|没成功/)
        assert.equal(f.s.status().history[0].chatId, ctx.chatId)
      }
    })
  }
})

test('明确拒绝才可人工补发同一音频和 batch，不重新推理；跨聊天补发拒绝', async (t) => {
  let sends = 0
  const f = fixture(t, { sendVoiceFile: async (_chat, _file, _note, options) => {
    if (++sends === 1) throw Object.assign(new Error('网关拒绝'), { code: 'DELIVERY_REJECTED', delivery: { failed: 1 } })
    assert.equal(options.retry, true); return receipt
  } })
  const ctx = f.context(), r = f.s.request({ song: '测试', ...ctx })
  await f.s.tick()
  assert.equal(f.s.runner.get(r.job_id).output.delivery.failed, true)
  assert.equal(f.s.resend(r.job_id, { ...ctx, chatId: 'group:other' }).ok, false)
  assert.equal(f.s.resend(r.job_id, ctx).ok, true)
  await f.s.tick()
  assert.equal(f.generated(), 1); assert.equal(sends, 2); assert.equal(f.sung.length, 1)
})

test('试运行不生成、不发、不记真实经历', async (t) => {
  const f = fixture(t); f.cfg.dryRun = true
  assert.equal(f.s.request({ song: '测试', ...f.context() }).skipped, true)
  await f.s.tick()
  assert.equal(f.generated(), 0); assert.equal(f.sent.length, 0); assert.equal(f.sung.length, 0)
})

test('音频检查点跨连接恢复：submitting 崩溃后只发已生成音频，不重做', async (t) => {
  const f = fixture(t), ctx = f.context(), r = f.s.request({ song: '测试', ...ctx })
  // Stop exactly between submit checkpoint and runner's generated transition.
  const store = f.s.handler.store
  f.s.handler.store = () => { f.s.stop(); throw new Error('simulated process exit') }
  await f.s.tick()
  const before = f.s.runner.get(r.job_id)
  assert.ok(before.output.sha256); assert.equal(before.state, 'submitting')
  const conn = f.open()
  const next = f.create({ storage: conn })
  next.recover(); await next.tick()
  assert.equal(next.runner.get(r.job_id).state, 'delivered')
  assert.equal(f.generated(), 1); assert.equal(f.sent.length, 1)
  assert.deepEqual(readFileSync(f.sent[0][1]), readFileSync(f.audio))
  f.s.handler.store = store
})

test('发送后崩溃：从真实 outbox 回执恢复 delivered，补记经历但不再次发送', async (t) => {
  const f = fixture(t), ctx = f.context()
  f.s.stop()
  const outbox = createOutbox({ storage: f.storage, send: async () => ({ message_id: 'real-qq-receipt' }) })
  let sends = 0, s
  s = f.create({ sendVoiceFile: async (chatId, _file, note, options) => {
    sends++
    const batchId = outbox.enqueue({ batchId: options.batchId, chatId, epoch: options.epoch, requestId: options.requestId,
      items: [{ kind: 'voice', message: [{ type: 'record', data: { file: 'asset:audio-1' } }], note }], requiresGuard: true })
    await outbox.deliver(batchId, { shouldSend: options.shouldSend })
    s.stop(); throw new Error('crash after durable receipt')
  } })
  const r = s.request({ song: '测试', ...ctx }); await s.tick()
  assert.equal(s.runner.get(r.job_id).state, 'delivery_pending')
  const next = f.create()
  next.recover(); await next.tick(); await next.tick()
  assert.equal(next.runner.get(r.job_id).state, 'delivered')
  assert.equal(sends, 1); assert.equal(f.generated(), 1); assert.equal(f.sung.length, 1)
  assert.match(f.sung[0][2].sourceId, /real-qq-receipt$/)
  assert.equal(next.runner.get(r.job_id).output.assetId, 'audio-1')
})

test('本地 HTTP 网关收取请求后断线：outbox unknown，重启不重复 POST 或推理', async (t) => {
  let posts = 0
  const server = createServer((req) => { posts++; req.resume(); req.on('end', () => req.socket.destroy()) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const f = fixture(t), outbox = createOutbox({ storage: f.storage, retries: 0, send: async () => {
    const response = await fetch('http://127.0.0.1:' + server.address().port, { method: 'POST', body: 'test-voice', signal: AbortSignal.timeout(1000) })
    return response.json()
  } })
  f.s.stop()
  const s = f.create({ sendVoiceFile: async (chatId, _file, note, options) => {
    outbox.enqueue({ batchId: options.batchId, chatId, requestId: options.requestId, epoch: options.epoch,
      requiresGuard: true, items: [{ kind: 'voice', message: [{ type: 'record', data: { file: 'asset:test' } }], note }] })
    const summary = await outbox.deliver(options.batchId, { shouldSend: options.shouldSend })
    throw Object.assign(new Error('unknown'), { code: 'DELIVERY_UNKNOWN', delivery: summary, assetId: 'test' })
  } })
  const ctx = f.context(), r = s.request({ song: '测试', ...ctx }); await s.tick(); s.stop()
  const next = f.create(); next.recover(); await next.tick()
  assert.equal(posts, 1); assert.equal(f.generated(), 1); assert.equal(f.sung.length, 0)
  assert.equal(next.runner.get(r.job_id).output.delivery.unknown, true)
  assert.equal(next.resend(r.job_id, ctx).code, 'DELIVERY_UNKNOWN')
})

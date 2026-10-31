import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createStorage } from '../src/storage/index.js'
import { createStickerStore, parseSelection } from '../src/features/stickers.js'
import { observeModelUsage } from '../src/core/llm.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHn8AAAAASUVORK5CYII=', 'base64')
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const picture = (n) => Buffer.concat([PNG, Buffer.from(String(n))])
const segment = (buf = PNG) => ({ type: 'image', data: { sub_type: 1, file: 'base64://' + buf.toString('base64') } })
const admin = { admin: true }
const answer = (extra = {}) => ({ version: 'sticker-analysis-v1', policyVersion: '1', name: '开心猫', description: '小猫微笑', ocr: '你好',
  tags: ['开心'], emotions: ['开心'], suitable: ['问候'], unsuitable: ['严肃通知'], decision: 'approve', reason: '静态图用途明确', ...extra })
function gate() { let release; const promise = new Promise((r) => { release = r }); return { promise, release } }
function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-stickers-'))
  const dbOptions = { file: join(root, 'data.db'), filesDir: join(root, 'assets') }
  const cfg = { botQQ: '100', ownerQQ: '200', dryRun: false, stickers: { enabled: true, collect: true, caption: true, libraryScope: 'chat', autoReview: false, maxPerHour: 20, maxLibrary: 100, maxQueued: 100, concurrency: 2, ...overrides } }
  let clock = 1_000_000
  const stores = [], connections = []
  const open = () => { const s = createStorage(dbOptions); connections.push(s); return s }
  const storage = open()
  const create = (options = {}) => { const store = createStickerStore({ storage, getConfig: () => cfg, now: () => clock, analyze: async () => answer(),
    sampleFrames: async () => ({ ok: false, state: 'needs_frames', code: 'FFMPEG_UNAVAILABLE', message: '测试环境没有 ffmpeg' }),
    autoStart: false, ...options }); stores.push(store); return store }
  t.after(() => { stores.forEach((s) => s.stop()); connections.forEach((s) => s.close()); rmSync(root, { recursive: true, force: true }) })
  let seq = 0
  const incoming = (seg = segment(), chatId = 'group:1') => {
    const m = storage.messages.ingest({ account: '100', chatId, authorId: '200', platformMsgId: String(++seq), segments: [seg] })
    return { accountId: '100', chatId, messageId: m.id, segmentIndex: 0 }
  }
  return { root, dbOptions, storage, cfg, open, create, incoming, advance: (ms) => { clock += ms } }
}

test('收藏立即返回持久队列回执；哈希去重和小时额度同事务，跨连接只收一次', async (t) => {
  const f = fixture(t, { caption: false, maxPerHour: 1 })
  const a = f.create(), b = f.create({ storage: f.open() })
  const seg = segment()
  const jobs = await Promise.all([a.collect(seg, f.incoming(seg)), b.collect(seg, f.incoming(seg))])
  f.advance(1) // 不同素材排在重复任务后面，不依赖同毫秒 UUID 的随机排序决定额度归属。
  jobs.push(await a.collect(segment(picture(2)), f.incoming(segment(picture(2)))))
  assert.ok(jobs.every((j) => j.ok && j.queued && j.taskId))
  assert.equal(a.list(admin).total, 0, '入站路径不等待下载或模型')
  await Promise.all([a.drain(), b.drain()])
  assert.equal(a.list(admin).total, 1)
  assert.equal(f.storage.db.get('SELECT COUNT(*) AS n FROM sticker_quota').n, 1)
  assert.equal(a.list(admin).items[0].state, 'pending')
  assert.equal(a.queueStatus(admin).items.filter((j) => j.state === 'failed').length, 1)
  assert.equal(a.queueStatus(admin).items.filter((j) => j.state === 'done').length, 2)
})

test('审核、范围和共享 image 类别在选择与实际发图时都检查', async (t) => {
  const f = fixture(t, { caption: false })
  const store = f.create()
  const { item } = await store.addFromBuffer(PNG, { chatId: 'private:1', name: '开心猫', tags: ['开心'], toQQ: false })
  assert.equal(store.match('开心', 'private:1'), null)
  assert.equal(store.segmentFor(item, 'private:1'), null)
  assert.equal(store.approve(item.id, {}).ok, false)
  assert.equal(store.approve(item.id, admin).ok, true)
  assert.equal(store.match('开心', 'private:1').id, item.id)
  assert.equal(store.match('开心'), null)
  assert.equal(store.segmentFor(item), null)
  assert.equal(store.segmentFor(item, { accountId: 'other', chatId: 'private:1' }), null)
  assert.equal(store.match('开心', 'group:2'), null)
  f.cfg.shareGroups = [{ id: 'x', chats: ['private:1', 'group:2'], categories: ['fact'] }]
  assert.equal(store.segmentFor(item, 'group:2'), null)
  f.cfg.shareGroups[0].categories = ['image']
  assert.ok(store.segmentFor(item, 'group:2'))
  const stale = store.match('开心', 'group:2')
  f.cfg.shareGroups = []
  assert.equal(store.segmentFor(stale, 'group:2'), null, '共享策略撤回立即生效')
  store.disable(item.id, admin)
  assert.equal(store.segmentFor(stale, 'private:1'), null)
})

test('manualOnly prevents automatic selection but keeps explicit matching', async (t) => {
  const f = fixture(t, { caption: false }), store = f.create()
  const { item } = await store.addFromBuffer(PNG, { chatId: 'group:1', name: '开心', toQQ: false })
  store.approve(item.id, admin)
  assert.equal(store.edit(item.id, { manualOnly: true }, admin).ok, true)
  assert.equal(store.selectForReply('开心', 'group:1').decision, 'no_match')
  assert.equal(store.match('开心', 'group:1'), null)
  assert.equal(store.match('开心', { chatId: 'group:1', allowManual: true }).id, item.id)
  assert.ok(store.segmentFor(item.id, 'group:1'))
  store.markUsed(item.id, 'group:1')
  assert.equal(store.match('开心', { chatId: 'group:1', allowManual: true, cooldown: true }), null)
  f.advance(60_000)
  assert.equal(store.match('开心', { chatId: 'group:1', allowManual: true, cooldown: true }).id, item.id)
})

test('collection mode changes stop queued work and owner mode checks the recorded sender', async (t) => {
  const f = fixture(t, { caption: false, collectMode: 'auto' }), store = f.create()
  const seg = segment(), source = f.incoming(seg)
  assert.equal((await store.collect(seg, source)).ok, true)
  f.cfg.stickers.collectMode = 'ask'
  await store.drain()
  assert.equal(store.list(admin).total, 0)
  assert.equal((await store.collect(seg, f.incoming(seg))).code, 'SELECTION_REQUIRED')
  f.cfg.stickers.collectMode = 'owner'; f.cfg.ownerQQ = 'someone-else'
  assert.equal((await store.collect(seg, f.incoming(seg))).code, 'FORBIDDEN')
})

test('ask mode rechecks request cancellation before queued collection', async (t) => {
  const f = fixture(t, { caption: false, collectMode: 'ask' }), store = f.create()
  const seg = segment(), source = f.incoming(seg)
  const request = f.storage.requests.create({ chatId: source.chatId, actorId: '200', sourceMessageIds: [source.messageId] })
  const occurrenceId = f.storage.occurrences.add({ messageId: source.messageId, chatId: source.chatId, authorId: '200', segIndex: 0, kind: 'sticker', scope: {} })
  f.storage.db.run('UPDATE asset_occurrences SET created_at=? WHERE id=?', 1_000_000, occurrenceId)
  assert.equal((await store.collect(seg, { ...source, selectedOccurrence: true, occurrenceId, requestId: request.id, epoch: request.epoch })).ok, true)
  f.storage.epochs.bump(source.chatId)
  await store.drain()
  assert.equal(store.list(admin).total, 0)
})

test('ask selection requires this request occurrence and rechecks TTL after queueing', async t => {
  const f = fixture(t, { caption: false, collectMode: 'ask' }), store = f.create()
  const seg = segment(), source = f.incoming(seg), other = f.incoming(seg)
  const request = f.storage.requests.create({ chatId: source.chatId, actorId: '200', sourceMessageIds: [source.messageId] })
  const addOccurrence = s => {
    const id = f.storage.occurrences.add({ messageId: s.messageId, chatId: s.chatId, authorId: '200', segIndex: 0, kind: 'sticker', scope: {} })
    f.storage.db.run('UPDATE asset_occurrences SET created_at=? WHERE id=?', 1_000_000, id); return id
  }
  const valid = addOccurrence(source), foreign = addOccurrence(other)
  const opts = { ...source, selectedOccurrence: true, requestId: request.id, epoch: request.epoch }
  assert.equal((await store.collect(seg, { ...opts, occurrenceId: foreign })).code, 'SELECTION_REQUIRED')
  assert.equal((await store.collect(seg, { ...opts, occurrenceId: valid })).ok, true)
  f.advance(30 * 60_000)
  await store.drain()
  assert.equal(store.list(admin).total, 0)
})

test('owner changes during queued download block collection; nested labels grant no ownership', async t => {
  const f = fixture(t, { caption: false, collectMode: 'owner' })
  const wait = gate(), enter = gate()
  const store = f.create({ download: async () => { enter.release(); await wait.promise; return PNG } })
  const seg = { ...segment(), data: { ...segment().data, sender: { user_id: '200' } } }, source = f.incoming(seg)
  assert.equal((await store.collect(seg, source)).ok, true)
  const draining = store.drain(); await enter.promise
  f.cfg.ownerQQ = '999'; wait.release(); await draining
  assert.equal(store.list(admin).total, 0)
  assert.equal((await store.collect(seg, f.incoming(seg))).code, 'FORBIDDEN')
})

test('ask collection rechecks occurrence TTL after download, not just before it', async t => {
  const f = fixture(t, { caption: false, collectMode: 'ask' }), wait = gate(), enter = gate()
  const store = f.create({ download: async () => { enter.release(); await wait.promise; return PNG } })
  const seg = segment(), source = f.incoming(seg)
  const request = f.storage.requests.create({ chatId: source.chatId, actorId: '200', sourceMessageIds: [source.messageId] })
  const occurrenceId = f.storage.occurrences.add({ messageId: source.messageId, chatId: source.chatId, authorId: '200', segIndex: 0, kind: 'sticker', scope: {} })
  f.storage.db.run('UPDATE asset_occurrences SET created_at=? WHERE id=?', 1_000_000, occurrenceId)
  assert.equal((await store.collect(seg, { ...source, selectedOccurrence: true, occurrenceId, requestId: request.id, epoch: request.epoch })).ok, true)
  const draining = store.drain(); await enter.promise; f.advance(30 * 60_000); wait.release(); await draining
  assert.equal(store.list(admin).total, 0)
})

test('相同字节在不同聊天具有独立审核记录，只复用物理资产', async (t) => {
  const f = fixture(t, { caption: false })
  const store = f.create()
  const a = await store.addFromBuffer(PNG, { chatId: 'group:1', toQQ: false })
  const b = await store.addFromBuffer(PNG, { chatId: 'group:2', toQQ: false })
  assert.notEqual(a.item.id, b.item.id)
  assert.equal(a.item.assetId, b.item.assetId)
  store.approve(a.item.id, admin)
  assert.equal(store.segmentFor(b.item, 'group:2'), null)
  assert.equal(store.list().total, 0)
  assert.equal(store.list({ chatId: 'group:2', status: 'pending' }).total, 0, '非管理员不能通过筛选读待审项')
})

test('目标聊天的停用/删除屏障不能经共享范围内另一条同哈希记录绕过', async (t) => {
  const f = fixture(t, { caption: false })
  f.cfg.shareGroups = [{ id: 'images', chats: ['group:1', 'group:2'], categories: ['image'] }]
  const store = f.create()
  const a = await store.addFromBuffer(PNG, { chatId: 'group:1', name: '开心', toQQ: false })
  const b = await store.addFromBuffer(PNG, { chatId: 'group:2', name: '开心', toQQ: false })
  store.approve(a.item.id, admin)
  store.approve(b.item.id, admin)
  store.disable(b.item.id, admin)
  assert.equal(store.segmentFor(a.item, 'group:2'), null)
  assert.equal(store.match('开心', 'group:2'), null)
  await store.remove(b.item.id, admin)
  assert.equal(store.segmentFor(a.item, 'group:2'), null)
  assert.ok(store.segmentFor(a.item, 'group:1'))
})

test('普通照片不自动收藏；伪造来源或跨群消息 ID 不能登记', async (t) => {
  const f = fixture(t)
  const store = f.create()
  const photo = { type: 'image', data: { file: segment().data.file } }
  assert.equal((await store.collect(photo, 'group:1')).code, 'NOT_STICKER')
  assert.equal((await store.collect(segment())).ok, false)
  const source = f.incoming()
  assert.equal((await store.collect(segment(), { ...source, chatId: 'group:2' })).code, 'INVALID_SOURCE')
  assert.equal((await store.collect(segment(picture(3)), source)).code, 'INVALID_SOURCE')
  assert.equal(store.queueStatus(admin).total, 0)
})

test('后台队列有界、同来源幂等，重启后继续 queued 下载', async (t) => {
  const f = fixture(t, { maxQueued: 1, caption: false })
  const store = f.create()
  const source = f.incoming()
  const first = await store.collect(segment(), source)
  assert.equal((await store.collect(segment(), source)).taskId, first.taskId)
  assert.equal((await store.collect(segment(picture(2)), f.incoming(segment(picture(2))))).code, 'QUEUE_FULL')
  const next = f.create({ storage: f.open() })
  await next.drain()
  assert.equal(next.list(admin).total, 1)
  assert.equal(next.queueStatus(admin).items[0].state, 'done')
})

test('共享 SQLite 的 worker 全局并发受限，recover 不抢活下载', async (t) => {
  const f = fixture(t, { concurrency: 1, caption: false })
  const entered = gate(), unblock = gate()
  let calls = 0
  const a = f.create({ download: async () => { calls++; entered.release(); await unblock.promise; return PNG } })
  const b = f.create({ storage: f.open(), download: async () => { calls++; return PNG } })
  await a.collect(segment(), f.incoming())
  await a.collect(segment(picture(2)), f.incoming(segment(picture(2))))
  const work = a.tick()
  await entered.promise
  assert.deepEqual(b.recover(), { requeued: 0, unknown: 0 })
  assert.equal(await b.tick(), 0)
  assert.equal(calls, 1)
  unblock.release()
  await work
  await b.drain()
  assert.equal(calls, 2)
})

test('结构化描述与 OCR 是证据；只有完整版本匹配审核和真实来源才能自动批准', async (t) => {
  const f = fixture(t, { autoReview: true })
  const store = f.create()
  await store.collect(segment(), f.incoming())
  await store.drain()
  const it = store.list(admin).items[0]
  assert.equal(it.state, 'approved')
  assert.equal(it.ocr, '你好')
  assert.equal(it.analysis.evidence.policyVersion, '1')
  assert.equal(it.analysis.evidence.coverage, 'still_image')
  assert.ok(it.source.messageId)
  // 兼容旧调用，但不虚构来源身份，也不自动批准。
  await store.collect(segment(picture(2)), 'group:1')
  await store.drain()
  assert.equal(store.list(admin).items.find((x) => x.source?.kind === 'legacy_call').state, 'pending')
})

test('未填写的上传名字/标签采用模型候选，手工填写的名字保留', async (t) => {
  const f = fixture(t)
  const store = f.create()
  const empty = await store.addFromBuffer(PNG, { chatId: 'group:1', name: '', tags: [], toQQ: false })
  const named = await store.addFromBuffer(picture(2), { chatId: 'group:1', name: '人工名', tags: ['人工标签'], toQQ: false })
  await store.drain()
  assert.equal(store.get(empty.item.id, admin).name, '开心猫')
  assert.deepEqual(store.get(empty.item.id, admin).tags, ['开心'])
  assert.equal(store.get(named.item.id, admin).name, '人工名')
  assert.deepEqual(store.get(named.item.id, admin).tags, ['人工标签'])
  assert.equal(store.get(empty.item.id, admin).state, 'pending')
})

for (const invalid of ['没有否字所以通过', { ...answer(), policyVersion: 'old' }, { ...answer(), ocr: undefined }]) {
  test(`无效审核保持 pending 并允许重试：${typeof invalid === 'string' ? invalid : JSON.stringify(invalid).slice(0, 60)}`, async (t) => {
    const f = fixture(t, { autoReview: true })
    let result = invalid
    const store = f.create({ analyze: async () => result })
    await store.collect(segment(), f.incoming())
    await store.drain()
    const it = store.list(admin).items[0]
    assert.equal(it.state, 'pending')
    assert.equal(it.analysis.state, 'failed')
    assert.equal(store.segmentFor(it, 'group:1'), null)
    result = answer()
    assert.equal(store.retryAnalysis(it.id, admin).ok, true)
    await store.drain()
    assert.equal(store.get(it.id, admin).state, 'approved')
  })
}

for (const change of ['edit', 'disable', 'remove']) {
  test(`迟到模型结果不能覆盖管理员 ${change}`, async (t) => {
    const f = fixture(t)
    const entered = gate(), unblock = gate()
    const store = f.create({ analyze: async () => { entered.release(); await unblock.promise; return answer() } })
    const { item } = await store.addFromBuffer(PNG, { chatId: 'group:1', toQQ: false })
    const work = store.tick()
    await entered.promise
    if (change === 'edit') store.edit(item.id, { name: '人工名字', ocr: '人工校正' }, admin)
    else if (change === 'disable') store.disable(item.id, admin)
    else await store.remove(item.id, admin)
    unblock.release()
    await work
    const current = store.get(item.id, admin)
    assert.equal(current.name, change === 'edit' ? '人工名字' : '')
    assert.equal(current.state, { edit: 'pending', disable: 'disabled', remove: 'deleted' }[change])
    assert.equal(store.queueStatus(admin).items.find((j) => j.kind === 'analyze').state, 'canceled')
  })
}

test('拒绝/停用不会被重新收藏或重启恢复；删除 tombstone 阻止复活', async (t) => {
  const f = fixture(t, { caption: false })
  const store = f.create()
  const { item } = await store.addFromBuffer(PNG, { chatId: 'group:1', toQQ: false })
  store.reject(item.id, admin)
  assert.equal((await store.addFromBuffer(PNG, { chatId: 'group:1' })).item.state, 'rejected')
  store.disable(item.id, admin)
  assert.equal((await store.addFromBuffer(PNG, { chatId: 'group:1' })).item.state, 'disabled')
  await store.remove(item.id, admin)
  const next = f.create({ storage: f.open() })
  assert.equal((await next.addFromBuffer(PNG, { chatId: 'group:1' })).code, 'TOMBSTONED')
  assert.equal(next.list({ ...admin, status: 'deleted' }).total, 1)
  assert.equal(next.approve(item.id, admin).code, 'TOMBSTONED')
})

test('GIF 自动取帧不可用时可手工选帧；单帧证据不能自动批准动画', async (t) => {
  const f = fixture(t, { autoReview: true })
  const seen = []
  const store = f.create({ analyze: async (input) => { seen.push(input); return answer() } })
  const { item } = await store.addFromBuffer(GIF, { chatId: 'group:1', toQQ: false })
  await store.drain()
  assert.equal(seen.length, 0)
  assert.equal(store.get(item.id, admin).analysis.state, 'needs_frames')
  assert.equal(store.selectFrames(item.id, [{ bytes: PNG, atMs: 0 }], admin).ok, true)
  await store.drain()
  const current = store.get(item.id, admin)
  assert.equal(current.analysis.evidence.coverage, 'manual_partial')
  assert.equal(current.state, 'pending')
  assert.equal(seen[0].animated, true)
  assert.equal(seen[0].images[0].mediaType, 'image/png')
  assert.equal(store.approve(item.id, admin).code, 'REVIEW_ORIGINAL')
  assert.equal(store.approve(item.id, { ...admin, reviewedOriginal: true }).ok, true)
  assert.deepEqual(store.preview(item.id, admin).bytes, GIF)
  assert.deepEqual(Buffer.from(store.segmentFor(item, 'group:1').data.file.slice(9), 'base64'), GIF)
})

test('no_match、OCR 负面用途与按聊天冷却，不随机挑选或解析失败取第一张', async (t) => {
  const f = fixture(t, { caption: false, cooldownMs: 1000 })
  const store = f.create()
  const { item } = await store.addFromBuffer(PNG, { chatId: 'group:1', name: '开心', tags: ['开心'], toQQ: false })
  store.approve(item.id, admin)
  assert.equal(store.pickForReply('今天讨论数据库', 'group:1'), null)
  assert.equal(store.selectForReply('不相关的话', 'group:1').decision, 'no_match')
  assert.equal(parseSelection('invalid json', [item]), null)
  assert.equal(parseSelection({ decision: 'no_match' }, [item]), null)
  assert.equal(parseSelection({ decision: 'match', id: 'invented' }, [item]), null)
  store.edit(item.id, { ocr: '活该', unsuitable: ['安慰'] }, admin)
  assert.equal(store.pickForReply('别难过，开心一点', 'group:1'), null)
  store.edit(item.id, { ocr: '', unsuitable: [] }, admin)
  assert.ok(store.pickForReply('开心', 'group:1'))
  store.markUsed(item.id, 'group:1')
  assert.equal(store.status(item.id, 'group:1').uses, 1)
  assert.equal(store.list(admin).items[0].uses, 1)
  assert.equal(store.match(item.id, 'group:1').lastUsed, 1_000_000)
  assert.equal(store.pickForReply('开心', 'group:1'), null)
  f.cfg.shareGroups = [{ id: 'images', chats: ['group:1', 'group:2'], categories: ['image'] }]
  assert.equal(store.pickForReply('开心', 'group:2').uses, 0, '共享素材在目标聊天独立计数和冷却')
  assert.equal(store.list({ chatId: 'group:2' }).items[0].lastUsed, 0)
  f.advance(1001)
  assert.ok(store.pickForReply('开心', 'group:1'))
})

test('QQ 同步独立于本地审核；试运行保持 queued，实际确认后才 synced', async (t) => {
  const f = fixture(t, { caption: false })
  f.cfg.dryRun = true
  const calls = []
  const store = f.create({ onebot: { call: async (action) => { calls.push(action); return { emoji_id: 'qq-1' } } } })
  const { item } = await store.addFromBuffer(PNG, { chatId: 'group:1' })
  assert.equal(item.qq.state, 'idle')
  assert.equal(store.queueSync(item.id, admin).code, 'NOT_APPROVED')
  store.approve(item.id, admin)
  await store.drain()
  assert.equal(store.get(item.id, admin).qq.state, 'queued')
  assert.match(store.queueStatus(admin).items[0].blockedReason, /试运行/)
  assert.equal(calls.length, 0)
  f.cfg.dryRun = false
  await store.drain()
  assert.equal(store.get(item.id, admin).qq.state, 'synced')
  assert.deepEqual(calls, ['add_custom_face'])
  store.queueSync(item.id, admin)
  await store.drain()
  assert.equal(calls.length, 1)
})

for (const outcome of ['unknown', 'rejected', 'missing_id']) {
  test(`QQ ${outcome} 不假报成功；未知结果不能盲目重试`, async (t) => {
    const f = fixture(t, { caption: false })
    let broken = true, calls = 0
    const store = f.create({ onebot: { call: async () => { calls++; if (broken) { if (outcome === 'missing_id') return {}; throw Object.assign(new Error('QQ failed'), { outcome }) } return { emoji_id: 'qq-2' } } } })
    const { item } = await store.addFromBuffer(PNG, { chatId: 'group:1' })
    store.approve(item.id, admin)
    await store.drain()
    const q = store.get(item.id, admin).qq
    assert.equal(store.get(item.id, admin).state, 'approved')
    assert.equal(q.state, outcome === 'rejected' ? 'failed' : 'unknown')
    broken = false
    if (outcome !== 'rejected') {
      assert.equal(store.retryTask(q.taskId, admin).ok, false)
      assert.equal(store.queueSync(item.id, admin).ok, false)
      assert.equal(store.reconcileSync(q.taskId, { ...admin, confirmedNotApplied: true }).ok, true)
    }
    assert.equal(store.retryTask(q.taskId, admin).ok, true)
    await store.drain()
    assert.equal(store.get(item.id, admin).qq.state, 'synced')
    assert.equal(calls, 2)
  })
}

test('旧 JSON 全部隔离保留；未人工分配不得跨群使用，缺失原文件不假造资产', async (t) => {
  const f = fixture(t, { caption: false })
  const root = join(f.root, 'legacy')
  mkdirSync(root)
  writeFileSync(join(root, 'cat.png'), PNG)
  const original = JSON.stringify({ items: [{ md5: 'old', file: 'cat.png', name: '开心猫', tags: ['开心'], from: 'group:1' }, { file: 'missing.png', name: '缺图' }] })
  writeFileSync(join(root, 'index.json'), original)
  const store = f.create({ legacyDir: root })
  assert.equal(store.legacyReport.imported, 2)
  assert.equal(store.list(admin).total, 0)
  assert.equal(store.list({ ...admin, status: 'quarantined' }).total, 2)
  assert.equal(store.match('开心', 'group:1'), null)
  const legacy = store.list({ ...admin, status: 'quarantined' }).items.find((i) => i.assetId)
  const assigned = await store.assignLegacy(legacy.id, { ...admin, chatId: 'group:3' })
  assert.equal(assigned.ok, true)
  assert.equal(assigned.item.state, 'pending')
  store.approve(assigned.item.id, admin)
  assert.equal(store.match('开心', 'group:1'), null)
  assert.ok(store.match('开心', 'group:3'))
  assert.equal(store.importLegacy(root, admin).imported, 0)
  assert.equal(readFileSync(join(root, 'index.json'), 'utf8'), original)
  assert.deepEqual(readFileSync(join(root, 'cat.png')), PNG)
})

test('撤回或修改来源后不能继续使用已批准素材', async (t) => {
  const f = fixture(t, { caption: false })
  const store = f.create()
  const source = f.incoming()
  await store.collect(segment(), source)
  await store.drain()
  const it = store.list(admin).items[0]
  assert.equal(it.source.segment, undefined, '管理列表不携带整张图的 base64')
  store.approve(it.id, admin)
  assert.ok(store.segmentFor(it, 'group:1'))
  f.storage.db.run('UPDATE messages SET recalled_at=? WHERE id=?', Date.now(), source.messageId)
  assert.equal(store.segmentFor(it, 'group:1'), null)
})

test('识别超时不放行，也不提前释放未结束外部调用的并发槽', async (t) => {
  const f = fixture(t, { analysisTimeoutMs: 10, concurrency: 1 })
  const entered = gate(), unblock = gate()
  const store = f.create({ analyze: async () => { entered.release(); await unblock.promise; return answer() } })
  const { item } = await store.addFromBuffer(PNG, { chatId: 'group:1', toQQ: false })
  const work = store.tick()
  await entered.promise
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.match(store.queueStatus(admin).items[0].error, /超时/)
  assert.equal(store.retryAnalysis(item.id, admin).state, 'running')
  const next = f.create({ storage: f.open() })
  assert.equal(await next.tick(), 0)
  unblock.release()
  await work
  assert.equal(store.get(item.id, admin).analysis.state, 'unknown')
  assert.equal(store.get(item.id, admin).state, 'pending')
  assert.equal(next.retryAnalysis(item.id, admin).code, 'ANALYSIS_UNKNOWN')
  const task = next.queueStatus(admin).items.find((j) => j.kind === 'analyze')
  assert.equal(next.retryTask(task.id, admin).code, 'NOT_RETRYABLE')
  await next.drain()
  assert.equal(next.get(item.id, admin).analysis.state, 'unknown')
})

test('QQ 已成功但回执事务失败，保守 unknown 不因数据库异常自动重复收藏', async (t) => {
  const f = fixture(t, { caption: false })
  let calls = 0, inject = false
  const run = f.storage.db.run
  f.storage.db.run = (sql, ...args) => {
    if (inject && sql.startsWith('UPDATE sticker_tasks SET state=')) {
      inject = false
      throw Object.assign(new Error('receipt disk failure'), { outcome: 'not_sent' })
    }
    return run(sql, ...args)
  }
  const store = f.create({ onebot: { call: async () => { calls++; inject = true; return { emoji_id: 'remote-success' } } } })
  const { item } = await store.addFromBuffer(PNG, { chatId: 'group:1' })
  store.approve(item.id, admin)
  await store.drain()
  assert.equal(store.get(item.id, admin).qq.state, 'unknown')
  assert.equal(store.queueSync(item.id, admin).ok, false)
  await store.drain()
  assert.equal(calls, 1)
})

test('收藏 QQ 过程中删除本地素材：迟到成功不会复活，随后排队删除 QQ 收藏', async (t) => {
  const f = fixture(t, { caption: false })
  const entered = gate(), unblock = gate(), calls = []
  const store = f.create({ onebot: { call: async (action) => {
    calls.push(action)
    if (action === 'add_custom_face') { entered.release(); await unblock.promise; return { emoji_id: 'late' } }
    return null
  } } })
  const { item } = await store.addFromBuffer(PNG, { chatId: 'group:1' })
  store.approve(item.id, admin)
  const work = store.tick()
  await entered.promise
  await store.remove(item.id, admin)
  unblock.release()
  await work
  await store.drain()
  assert.deepEqual(calls, ['add_custom_face', 'delete_custom_face'])
  assert.equal(store.get(item.id, admin).state, 'deleted')
  assert.equal(store.get(item.id, admin).qq.state, 'removed')
})

for (const mode of ['collect', 'sync', 'analyze']) {
  test(`真实后台进程 ${mode} 活着不抢占，退出后恢复不伪造 QQ 成功`, { timeout: 15000 }, async (t) => {
    const f = fixture(t, { caption: false })
    if (mode === 'analyze') f.cfg.stickers.caption = true
    const code = `
      import { createStorage } from ${JSON.stringify(new URL('../src/storage/index.js', import.meta.url).href)};
      import { createStickerStore } from ${JSON.stringify(new URL('../src/features/stickers.js', import.meta.url).href)};
      const { dbOptions, cfg, mode, png } = JSON.parse(process.argv[1]);
      const storage = createStorage(dbOptions);
      process.on('message', command => { if (command === 'exit') process.exit(0) });
      const hold = async () => { process.send({event:'held'}); return new Promise(() => {}) };
      const store = createStickerStore({storage,getConfig:()=>cfg,autoStart:false,download:hold,analyze:hold,onebot:{call:hold}});
      if (mode === 'collect') await store.collect({type:'image',data:{sub_type:1,file:'base64://'+png}},'group:1');
      else { const r=await store.addFromBuffer(Buffer.from(png,'base64'),{chatId:'group:1'}); if(mode==='sync') store.approve(r.item.id,{admin:true}); }
      await store.tick();
    `
    const child = spawn(process.execPath, ['--input-type=module', '--eval', code, JSON.stringify({ dbOptions: f.dbOptions, cfg: f.cfg, mode, png: PNG.toString('base64') })], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true })
    let exited = false, stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const closed = new Promise((resolve) => { child.once('exit', () => { exited = true; resolve() }); child.once('error', resolve) })
    t.after(async () => { if (!exited) child.kill(); await closed })
    await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', () => reject(new Error(stderr || 'child exited'))) })
    let qqCalls = 0
    const store = f.create({ onebot: { call: async () => { qqCalls++; return { emoji_id: 'unexpected' } } } })
    assert.deepEqual(store.recover(), { requeued: 0, unknown: 0 })
    child.send('exit')
    await closed
    assert.deepEqual(store.recover(), { requeued: mode === 'collect' ? 1 : 0, unknown: mode === 'collect' ? 0 : 1 })
    await store.drain()
    assert.equal(qqCalls, 0)
    if (mode === 'sync') assert.equal(store.list(admin).items[0].qq.state, 'unknown')
    else if (mode === 'analyze') {
      const it = store.list(admin).items[0]
      assert.equal(it.analysis.state, 'unknown')
      assert.equal(store.retryAnalysis(it.id, admin).code, 'ANALYSIS_UNKNOWN')
    }
    else assert.equal(store.list(admin).items[0].state, 'pending')
  })
}

const entry = (it, extra = {}) => ({ id: it.id, expectedRevision: it.revision, ...extra })
const taskEntry = (t) => ({ id: t.id, expectedState: t.state, expectedAttempts: t.attempts })
const groupAdmin = { admin: true, chatId: 'group:1', accountId: '100' }

test('批量审核逐项返回范围/版本/动画错误，既不扩大范围也不隐式确认 GIF', async (t) => {
  const f = fixture(t, { caption: false })
  f.cfg.shareGroups = [{ id: 'images', chats: ['group:1', 'group:2'], categories: ['image'] }]
  const store = f.create()
  const add = async (buf, chatId = 'group:1') => (await store.addFromBuffer(buf, { chatId, toQQ: false })).item
  const good = await add(PNG), foreign = await add(picture(2), 'group:2'), stale = await add(picture(3)), gif = await add(GIF)
  store.edit(stale.id, { name: 'changed' }, groupAdmin)
  const r = store.batch('approve', [good, foreign, stale, gif].map(it => entry(it)), groupAdmin)
  assert.deepEqual([r.ok, r.succeeded, r.failed, r.partial], [true, 1, 3, true])
  assert.deepEqual(r.results.map(x => x.code), [undefined, 'WRONG_SCOPE', 'STALE_REVISION', 'REVIEW_ORIGINAL'])
  assert.equal(store.get(foreign.id, admin).state, 'pending')
  assert.equal(store.batch('approve', [entry(gif, { reviewedOriginal: true })], groupAdmin).succeeded, 1)
  assert.equal(store.batch('approve', [entry(good)], groupAdmin).results[0].code, 'STALE_REVISION')
  assert.equal(store.batch('approve', [entry(stale)], admin).ok, false, '批量必须显式给出聊天')
  assert.equal(store.batch('approve', [entry(stale)], { ...groupAdmin, admin: false }).code, 'ADMIN_REQUIRED')
  assert.equal(store.batch('approve', [entry(stale)], { ...groupAdmin, accountId: 'other' }).code, 'WRONG_ACCOUNT')
  assert.equal(store.batch('approve', Array(201).fill(entry(stale)), groupAdmin).code, 'INVALID_BATCH')
})

test('批量拒绝/停用/删除保留墓碑与共享资产，重复 ID 不执行第二次，不自动删除 QQ', async (t) => {
  const f = fixture(t, { caption: false })
  let qqCalls = 0
  const store = f.create({ onebot: { call: async () => { qqCalls++; return { emoji_id: 'remote' } } } })
  const a = (await store.addFromBuffer(PNG, { chatId: 'group:1', toQQ: false })).item
  const b = (await store.addFromBuffer(PNG, { chatId: 'group:2', toQQ: false })).item
  const first = store.batch('reject', [entry(a), entry(a)], groupAdmin)
  assert.equal(first.succeeded, 1)
  assert.equal(first.results[1].code, 'INVALID_BATCH_ITEM')
  assert.equal(store.batch('disable', [entry(store.get(a.id, admin))], groupAdmin).succeeded, 1)
  const removed = store.batch('delete', [entry(store.get(a.id, admin))], { ...groupAdmin, fromQQ: true })
  assert.equal(removed.results[0].tombstone, true)
  assert.equal(store.get(a.id, admin).state, 'deleted')
  assert.equal(store.get(b.id, admin).state, 'pending')
  assert.equal((await store.addFromBuffer(PNG, { chatId: 'group:1' })).code, 'TOMBSTONED')
  await store.drain()
  assert.equal(qqCalls, 0)
  assert.deepEqual(store.preview(b.id, admin).bytes, PNG)
})

test('批量识别只登记队列，跨连接重复提交不重复计费，队列满逐项回滚', async (t) => {
  const f = fixture(t, { caption: false, maxQueued: 1 })
  let calls = 0
  const store = f.create({ analyze: async () => { calls++; return answer() } }), other = f.create({ storage: f.open() })
  const a = (await store.addFromBuffer(PNG, { chatId: 'group:1', toQQ: false })).item
  const b = (await store.addFromBuffer(picture(2), { chatId: 'group:1', toQQ: false })).item
  const r = store.batch('analysis_retry', [entry(a), entry(b)], groupAdmin)
  assert.equal(r.succeeded, 1)
  assert.equal(r.results[1].code, 'QUEUE_FULL')
  assert.equal(store.get(b.id, admin).revision, b.revision)
  assert.equal(other.batch('analysis_retry', [entry(a)], groupAdmin).results[0].code, 'STALE_REVISION')
  await store.drain()
  assert.equal(calls, 0, 'caption=false 暂停旧识别队列')
  assert.match(store.queueStatus(groupAdmin).items[0].blockedReason, /识别已关闭/)
  f.cfg.stickers.caption = true
  await store.drain()
  assert.equal(calls, 1)
})

test('批量和单项任务重试限制聊天、类型、状态，旧识别任务不再次派生付费工作', async (t) => {
  const f = fixture(t)
  let calls = 0
  const store = f.create({ analyze: async () => { calls++; return 'bad json' } })
  const it = (await store.addFromBuffer(PNG, { chatId: 'group:1', toQQ: false })).item
  await store.drain()
  const task = store.queueStatus(groupAdmin).items[0]
  assert.equal(store.retryTask(task.id, { ...admin, chatId: 'group:2' }).code, 'NOT_FOUND')
  assert.equal(store.batch('task_retry', [taskEntry(task)], { ...groupAdmin, kind: 'sync' }).results[0].code, 'WRONG_TASK_KIND')
  const result = store.batch('task_retry', [taskEntry(task)], { ...groupAdmin, kind: 'analyze' })
  assert.equal(result.succeeded, 1)
  assert.equal(store.batch('task_retry', [taskEntry(task)], { ...groupAdmin, kind: 'analyze' }).results[0].code, 'STALE_TASK')
  await store.drain()
  assert.equal(calls, 2)
  assert.equal(store.retryTask(task.id, groupAdmin).code, 'NOT_RETRYABLE')
  assert.equal(store.get(it.id, admin).state, 'pending')
})

test('识别未知不能经重试/选帧绕过，逐项核对有依据后只登记、不自动付费', async (t) => {
  const f = fixture(t)
  let calls = 0
  const store = f.create({ analyze: async () => { calls++; throw new Error('connection reset') } })
  const it = (await store.addFromBuffer(PNG, { chatId: 'group:1', toQQ: false })).item
  await store.drain()
  const task = store.queueStatus(groupAdmin).items[0], current = store.get(it.id, admin)
  assert.equal(current.analysis.state, 'unknown')
  assert.equal(store.batch('analysis_retry', [entry(current)], groupAdmin).results[0].code, 'ANALYSIS_UNKNOWN')
  assert.equal(store.retryTask(task.id, groupAdmin).code, 'NOT_RETRYABLE')
  assert.equal(store.reconcileAnalysis(task.id, { ...admin, chatId: 'group:2', confirmedNotApplied: true, reason: 'checked' }).code, 'NOT_FOUND')
  assert.equal(store.reconcileAnalysis(task.id, { ...groupAdmin, confirmedNotApplied: true }).code, 'CONFIRMATION_REQUIRED')
  assert.equal(store.reconcileAnalysis(task.id, { ...groupAdmin, confirmedNotApplied: true, reason: '模拟服务日志确认未提交' }).ok, true)
  await store.drain()
  assert.equal(calls, 1)
  assert.equal(store.retryTask(task.id, groupAdmin).ok, true)
  await store.drain()
  assert.equal(calls, 2)
})

test('GIF 缺少 ffmpeg 保留待审，批量重试自动取样不重复排队，仍可人工审核', async (t) => {
  const f = fixture(t)
  const store = f.create({ analyze: async () => assert.fail('缺帧不能调用模型') })
  const it = (await store.addFromBuffer(GIF, { chatId: 'group:1', toQQ: false })).item
  await store.drain()
  const before = store.queueStatus(admin).total
  const r = store.batch('analysis_retry', [entry(store.get(it.id, admin))], groupAdmin)
  assert.equal(r.succeeded, 1)
  assert.equal(store.queueStatus(admin).total, before + 1)
  assert.equal(store.retryAnalysis(it.id, admin).taskId, r.results[0].taskId)
  await store.drain()
  assert.equal(store.get(it.id, admin).analysis.state, 'needs_frames')
  assert.match(store.get(it.id, admin).analysis.error, /ffmpeg/)
  assert.equal(store.batch('approve', [entry(store.get(it.id, admin), { reviewedOriginal: true })], groupAdmin).succeeded, 1)
})

test('QQ unknown 禁止批量重试且核对不得跨范围，已确认未发送可重试且旧请求幂等', async (t) => {
  const f = fixture(t, { caption: false })
  let calls = 0
  const store = f.create({ onebot: { call: async () => { calls++; throw new Error('socket lost') } } })
  const it = (await store.addFromBuffer(PNG, { chatId: 'group:1' })).item
  store.approve(it.id, groupAdmin)
  await store.drain()
  const task = store.queueStatus(groupAdmin).items[0]
  assert.equal(task.state, 'unknown')
  assert.equal(store.reconcileSync(task.id, { ...admin, chatId: 'group:2', confirmedNotApplied: true }).code, 'NOT_FOUND')
  assert.equal(store.batch('task_retry', [taskEntry(task)], { ...groupAdmin, kind: 'sync' }).succeeded, 0)
  assert.equal(store.queueSync(it.id, groupAdmin).ok, false)
  assert.equal(store.reconcileSync(task.id, { ...groupAdmin, confirmedNotApplied: true }).ok, true)
  const reconciled = store.queueStatus(groupAdmin).items[0]
  assert.equal(store.batch('task_retry', [taskEntry(reconciled)], { ...groupAdmin, kind: 'sync' }).succeeded, 1)
  assert.equal(store.batch('task_retry', [taskEntry(reconciled)], { ...groupAdmin, kind: 'sync' }).results[0].code, 'STALE_TASK')
  await store.drain()
  assert.equal(calls, 2)
})

test('批量批准本地成功与 QQ 排队失败独立报告', async (t) => {
  const f = fixture(t, { caption: false, maxQueued: 1 })
  const store = f.create()
  const it = (await store.addFromBuffer(PNG, { chatId: 'group:1' })).item
  await store.collect(segment(picture(2)), f.incoming(segment(picture(2))))
  const r = store.batch('approve', [entry(it)], groupAdmin)
  assert.equal(r.succeeded, 1)
  assert.equal(r.syncFailed, 1)
  assert.equal(r.results[0].sync.code, 'QUEUE_FULL')
  assert.equal(store.get(it.id, admin).state, 'approved')
})

test('关闭模块阻止选择与发送，关闭收藏阻止在途写回，试运行暂停 QQ 导入', async (t) => {
  const f = fixture(t, { caption: false })
  const entered = gate(), unblock = gate()
  const store = f.create({ download: async () => { entered.release(); await unblock.promise; return PNG }, onebot: { call: async () => assert.fail('试运行不可访问 QQ') } })
  const it = (await store.addFromBuffer(picture(2), { chatId: 'group:1', name: '开心', toQQ: false })).item
  store.approve(it.id, groupAdmin)
  assert.ok(store.pickForReply('开心', 'group:1'))
  f.cfg.stickers.enabled = false
  assert.equal(store.pickForReply('开心', 'group:1'), null)
  assert.equal(store.segmentFor(it, 'group:1'), null)
  f.cfg.stickers.enabled = true
  await store.collect(segment(), f.incoming())
  const work = store.tick()
  await entered.promise
  f.cfg.stickers.collect = false
  unblock.release(); await work
  assert.equal(store.list(admin).total, 1)
  f.cfg.dryRun = true
  await store.importFromQQ(groupAdmin)
  await store.drain()
  assert.match(store.queueStatus({ ...groupAdmin, kind: 'import' }).items[0].blockedReason, /试运行/)
})

test('分页、动画/识别/QQ 筛选总数与当前页一致；管理不能借共享权编辑', async (t) => {
  const f = fixture(t, { caption: false })
  const store = f.create()
  for (let i = 0; i < 5; i++) await store.addFromBuffer(picture(i), { chatId: 'group:1', toQQ: false })
  const gif = (await store.addFromBuffer(GIF, { chatId: 'group:1', toQQ: false })).item
  const r = store.list({ ...groupAdmin, analysis: 'pending', animated: 'false', qq: 'idle', limit: 2, offset: 2 })
  assert.equal(r.total, 5)
  assert.equal(r.items.length, 2)
  assert.equal(store.list({ ...groupAdmin, animated: 'true' }).items[0].id, gif.id)
  f.cfg.shareGroups = [{ id: 's', chats: ['group:1', 'group:2'], categories: ['image'] }]
  assert.equal(store.approve(gif.id, { ...admin, chatId: 'group:2', reviewedOriginal: true }).code, 'WRONG_SCOPE')
  assert.equal(store.rename(gif.id, 'cross', [], { ...admin, chatId: 'group:2' }).code, 'WRONG_SCOPE')
})

test('QQ 导入缺少 ID 显示已存在，禁止重复收藏；旧库回读兼容，人工绑定才允许改备注', async (t) => {
  const f = fixture(t, { caption: false })
  const calls = []
  const store = f.create({ fetch: async () => PNG, onebot: { call: async (action) => {
    calls.push(action)
    if (action === 'fetch_custom_face') return [{ url: 'https://example.invalid/sticker.png' }]
    return null
  } } })
  await store.importFromQQ(groupAdmin); await store.drain()
  const it = store.list(groupAdmin).items[0]
  assert.equal(it.qq.state, 'unidentified')
  store.approve(it.id, groupAdmin)
  assert.equal(store.queueSync(it.id, groupAdmin).code, 'QQ_ID_REQUIRED')
  // 真实早上库没有 sticker_qq 记录：读旧来源也必须保守识别已有收藏。
  f.storage.db.run('DELETE FROM sticker_qq')
  assert.equal(store.get(it.id, admin).qq.state, 'unidentified')
  assert.equal(store.queueSync(it.id, groupAdmin).code, 'QQ_ID_REQUIRED')
  assert.equal(store.bindQQ(it.id, { ...groupAdmin, emojiId: 'existing' }).code, 'CONFIRMATION_REQUIRED')
  assert.equal(store.bindQQ(it.id, { ...admin, chatId: 'group:2', emojiId: 'existing', confirmedExisting: true }).ok, false)
  assert.equal(store.bindQQ(it.id, { ...groupAdmin, emojiId: 'existing', confirmedExisting: true }).ok, true)
  store.rename(it.id, '新名字', [], groupAdmin)
  assert.equal(store.queueSync(it.id, groupAdmin).ok, true)
  await store.drain()
  assert.deepEqual(calls, ['fetch_custom_face', 'modify_custom_face'])
})

test('QQ 备注明确失败后再次同步仍修改已有 ID，不能重新 add', async (t) => {
  const f = fixture(t, { caption: false })
  const calls = []
  const store = f.create({ onebot: { call: async (action) => {
    calls.push(action)
    if (action === 'add_custom_face') return { emoji_id: 'remote' }
    throw Object.assign(new Error('rejected'), { outcome: 'rejected' })
  } } })
  const it = (await store.addFromBuffer(PNG, { chatId: 'group:1' })).item
  store.approve(it.id, groupAdmin); await store.drain()
  store.rename(it.id, 'rename', [], groupAdmin)
  store.queueSync(it.id, groupAdmin); await store.drain()
  store.queueSync(it.id, groupAdmin); await store.drain()
  assert.deepEqual(calls, ['add_custom_face', 'modify_custom_face', 'modify_custom_face'])
})

const sampledFrames = () => ({ ok: true, state: 'sampled', coverage: 'partial',
  frames: [0, 100].map((atMs, frameIndex) => ({ bytes: PNG, mime: 'image/png', width: 1, height: 1, atMs, frameIndex, selection: 'sampled', coverage: 'partial' })),
  sampling: { selection: 'sampled', coverage: 'partial', complete: false, sourceFrames: 2, sampledFrames: 2, durationMs: 200 } })

test('GIF 批量重试自动本地取样，模型approve可自动使用但仍保留部分帧证据', async (t) => {
  const f = fixture(t, { caption: false, autoReview: true })
  let samples = 0
  const seen = []
  const store = f.create({ sampleFrames: async input => {
    samples++; assert.deepEqual(input.bytes, GIF); assert.equal(input.mime, 'image/gif'); assert.ok(input.signal instanceof AbortSignal)
    return sampledFrames()
  }, analyze: async input => { seen.push(input); return answer() } })
  const it = (await store.addFromBuffer(GIF, { chatId: 'group:1', toQQ: false })).item
  f.cfg.stickers.caption = true
  const r = store.batch('analysis_retry', [entry(it)], groupAdmin)
  assert.equal(r.succeeded, 1)
  await store.drain()
  let current = store.get(it.id, admin)
  assert.equal(current.state, 'approved')
  assert.equal(current.analysis.state, 'done')
  assert.equal(current.analysis.evidence.coverage, 'sampled_partial')
  assert.equal(current.analysis.evidence.decision, 'approve')
  assert.equal(current.analysis.evidence.modelDecision, 'approve')
  assert.equal(current.analysis.evidence.sampling.complete, false)
  assert.ok(current.frames.every(f => f.selection === 'sampled' && f.coverage === 'partial' && f.sourceAssetId === it.assetId))
  assert.equal(seen[0].images.length, 2)
  assert.equal(seen[0].coverage, 'sampled_partial')
  assert.equal(seen[0].operationId, it.id)
  assert.equal(seen[0].callId, r.results[0].taskId + ':1')
  assert.equal(seen[0].scope.account, '100')
  assert.equal(seen[0].chatId, 'group:1')
  assert.deepEqual(store.preview(it.id, groupAdmin).bytes, GIF)
  assert.deepEqual(store.preview(it.id, { ...groupAdmin, frame: 0 }).bytes, PNG)
  assert.equal(store.approve(it.id, groupAdmin).code, 'REVIEW_ORIGINAL')
  assert.equal(store.approve(it.id, { ...groupAdmin, reviewedOriginal: true }).ok, true)
  assert.equal(store.selectFrames(it.id, [{ bytes: PNG, atMs: 50 }], groupAdmin).ok, true)
  await store.drain()
  current = store.get(it.id, admin)
  assert.equal(current.state, 'approved')
  assert.equal(current.analysis.evidence.coverage, 'manual_partial')
  assert.equal(current.frames[0].selection, 'manual')
  assert.equal(samples, 1, '人工帧优先，不再次自动取样')
})

test('自动取样后的付费识别unknown不能经新一轮本地取样绕过重试屏障', async (t) => {
  const f = fixture(t)
  let samples = 0, paid = 0
  const store = f.create({ sampleFrames: async () => { samples++; return sampledFrames() }, analyze: async () => { paid++; throw new Error('remote outcome unknown') } })
  const it = (await store.addFromBuffer(GIF, { chatId: 'group:1', toQQ: false })).item
  await store.drain()
  assert.equal(store.get(it.id, admin).analysis.state, 'unknown')
  assert.equal(store.batch('analysis_retry', [entry(store.get(it.id, admin))], groupAdmin).results[0].code, 'ANALYSIS_UNKNOWN')
  assert.equal(store.selectFrames(it.id, [{ bytes: PNG, atMs: 0 }], groupAdmin).code, 'ANALYSIS_BUSY')
  await store.drain()
  assert.deepEqual([samples, paid], [1, 1])
})

test('自动取样期间关闭或编辑素材会在付费识别前拦截，不落迟到帧', async (t) => {
  for (const change of ['disable', 'edit']) {
    const f = fixture(t), entered = gate(), unblock = gate()
    let paid = 0
    const store = f.create({ sampleFrames: async () => { entered.release(); await unblock.promise; return sampledFrames() }, analyze: async () => { paid++; return answer() } })
    const it = (await store.addFromBuffer(GIF, { chatId: 'group:1', toQQ: false })).item
    const work = store.tick(); await entered.promise
    if (change === 'disable') f.cfg.stickers.enabled = false
    else store.edit(it.id, { name: '人工修改' }, groupAdmin)
    unblock.release(); await work
    assert.equal(paid, 0)
    assert.equal(store.get(it.id, admin).frames.length, 0)
    assert.equal(store.queueStatus(groupAdmin).items[0].state, 'canceled')
  }
})

test('平台已标识表情放宽至5MB/2048/4M像素，横图不套方形规则；普通照片仍不自动收藏', async (t) => {
  const f = fixture(t, { caption: false })
  const wide = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)])
  wide.writeUInt32BE(900, 16); wide.writeUInt32BE(320, 20)
  let limit
  const store = f.create({ download: async (_s, _o, options) => { limit = options.maxBytes; return wide } })
  const seg = segment(wide)
  assert.equal((await store.collect(seg, f.incoming(seg))).ok, true)
  await store.drain()
  assert.equal(limit, 5 * 1024 * 1024)
  assert.equal(store.list(groupAdmin).items[0].width, 900)
  assert.equal(store.list(groupAdmin).items[0].height, 320)
  assert.equal((await store.collect({ type: 'image', data: { file: seg.data.file } }, 'group:1')).code, 'NOT_STICKER')
  const large = Buffer.from(PNG); large.writeUInt32BE(2049, 16)
  const bounded = f.create({ download: async () => large })
  await bounded.collect(segment(large), f.incoming(segment(large))); await bounded.drain()
  assert.equal(store.list(groupAdmin).total, 1)
  assert.match(store.queueStatus(groupAdmin).items.find(t => t.state === 'failed').error, /2048/)
})

test('真实modelAnalyzer调用账本有账号/聊天/素材operationId/任务callId，日志不携带图像或提示词', async (t) => {
  const f = fixture(t)
  f.cfg.model = { provider: 'sticker-mock-provider', model: 'sticker-mock-model' }
  const events = []
  const dsh = { get: () => null, attachments: { admitPromptContent: async content => content }, llm: {
    resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
    async *stream() { yield { type: 'text-delta', text: JSON.stringify(answer()) }; yield { type: 'finish', reason: 'stop' } },
  } }
  t.after(observeModelUsage(dsh, e => events.push(e)))
  const store = f.create({ dsh, analyze: undefined })
  const seg = segment(); seg.data.summary = 'PRIVATE-IMAGE-HINT'
  const source = f.incoming(seg)
  await store.collect(seg, source); await store.drain()
  const it = store.list(groupAdmin).items[0]
  assert.equal(it.analysis.state, 'done')
  const task = store.queueStatus({ ...groupAdmin, kind: 'analyze' }).items[0]
  assert.equal(events.length, 2)
  assert.equal(events[0].operationId, it.id)
  assert.equal(events[0].id, task.id + ':1')
  assert.equal(events[0].stage, 'sticker_analysis')
  assert.deepEqual(events[0].context, { account: '100', chatId: 'group:1', requestId: null, role: 'vision' })
  assert.deepEqual(events[0].sourceMessageIds, [source.messageId])
  assert.deepEqual(events[1], { id: task.id + ':1', phase: 'business', businessStatus: 'success', businessError: '',
    context: { account: '100', chatId: 'group:1' } })
  assert.equal(JSON.stringify(events).includes('PRIVATE-IMAGE-HINT'), false)
  assert.equal(JSON.stringify(events).includes(PNG.toString('base64')), false)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createStorage } from '../src/storage/index.js'
import { createStickerStore, parseSelection } from '../src/features/stickers.js'

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
  const cfg = { botQQ: '100', ownerQQ: '200', dryRun: false, stickers: { enabled: true, collect: true, caption: true, maxPerHour: 20, maxLibrary: 100, maxQueued: 100, concurrency: 2, ...overrides } }
  let clock = 1_000_000
  const stores = [], connections = []
  const open = () => { const s = createStorage(dbOptions); connections.push(s); return s }
  const storage = open()
  const create = (options = {}) => { const store = createStickerStore({ storage, getConfig: () => cfg, now: () => clock, analyze: async () => answer(), autoStart: false, ...options }); stores.push(store); return store }
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

test('GIF 保存原动画，需显式关键帧；单帧证据不能自动批准动画', async (t) => {
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
  assert.equal(store.queueStatus(admin).items[0].blockedReason, 'dry_run')
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
  assert.equal(store.get(item.id, admin).analysis.state, 'failed')
  assert.equal(store.get(item.id, admin).state, 'pending')
  next.retryAnalysis(item.id, admin)
  await next.drain()
  assert.equal(next.get(item.id, admin).analysis.state, 'done')
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

for (const mode of ['collect', 'sync']) {
  test(`真实后台进程 ${mode} 活着不抢占，退出后恢复不伪造 QQ 成功`, { timeout: 15000 }, async (t) => {
    const f = fixture(t, { caption: false })
    const code = `
      import { createStorage } from ${JSON.stringify(new URL('../src/storage/index.js', import.meta.url).href)};
      import { createStickerStore } from ${JSON.stringify(new URL('../src/features/stickers.js', import.meta.url).href)};
      const { dbOptions, cfg, mode, png } = JSON.parse(process.argv[1]);
      const storage = createStorage(dbOptions);
      process.on('message', command => { if (command === 'exit') process.exit(0) });
      const hold = async () => { process.send({event:'held'}); return new Promise(() => {}) };
      const store = createStickerStore({storage,getConfig:()=>cfg,autoStart:false,download:hold,onebot:{call:hold}});
      if (mode === 'collect') await store.collect({type:'image',data:{sub_type:1,file:'base64://'+png}},'group:1');
      else { const r=await store.addFromBuffer(Buffer.from(png,'base64'),{chatId:'group:1'}); store.approve(r.item.id,{admin:true}); }
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
    assert.deepEqual(store.recover(), { requeued: mode === 'collect' ? 1 : 0, unknown: mode === 'sync' ? 1 : 0 })
    await store.drain()
    assert.equal(qqCalls, 0)
    if (mode === 'sync') assert.equal(store.list(admin).items[0].qq.state, 'unknown')
    else assert.equal(store.list(admin).items[0].state, 'pending')
  })
}

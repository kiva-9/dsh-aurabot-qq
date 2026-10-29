import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createStorage } from '../src/storage/index.js'
import { createStickerStore } from '../src/stickers/store.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHn8AAAAASUVORK5CYII=', 'base64')
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const ADMIN = { admin: true }
const picture = n => Buffer.concat([PNG, Buffer.from(String(n))])
const segment = bytes => ({ type: 'image', data: { sub_type: 1, file: 'base64://' + bytes.toString('base64') } })
const answer = () => ({ version: 'sticker-analysis-v1', policyVersion: '1', name: '开心猫', description: '小猫微笑', ocr: '',
  tags: ['开心'], emotions: ['开心'], suitable: ['问候'], unsuitable: ['严肃通知'], decision: 'approve', reason: '可见内容用途明确' })
const sampled = () => ({ ok: true, coverage: 'partial',
  frames: [0, 100].map(atMs => ({ bytes: PNG, mime: 'image/png', width: 1, height: 1, atMs })),
  sampling: { complete: false, sourceFrames: 8, sampledFrames: 2 } })

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-stickers-global-'))
  const dbOptions = { file: join(root, 'data.db'), filesDir: join(root, 'assets') }
  // Intentionally omit libraryScope/autoReview to exercise runtime defaults.
  const cfg = { botQQ: '100', ownerQQ: '200', dryRun: false,
    stickers: { enabled: true, collect: true, caption: true, maxLibrary: 100, maxPerHour: 20, ...overrides } }
  let clock = 1_000_000, seq = 0
  const stores = [], connections = [], analyses = [], qq = [], samples = []
  const behavior = { error: null, frames: null }
  const open = () => { const s = createStorage(dbOptions); connections.push(s); return s }
  const storage = open()
  const create = ({ config = cfg, ...options } = {}) => {
    const store = createStickerStore({ storage, getConfig: () => config, now: () => clock, autoStart: false,
      analyze: async input => { analyses.push(input); if (behavior.error) throw behavior.error; return answer() },
      sampleFrames: async input => { samples.push(input); return behavior.frames || { ok: false, code: 'FFMPEG_UNAVAILABLE' } },
      download: async seg => Buffer.from(seg.data.file.slice('base64://'.length), 'base64'),
      fetch: async url => { assert.equal(url, 'https://fixtures.invalid/qq.png'); return picture('qq') },
      onebot: { call: async (action, params) => {
        qq.push({ action, params })
        if (action === 'fetch_custom_face') return [{ url: 'https://fixtures.invalid/qq.png', emoji_id: 'existing-qq' }]
        assert.ok(['add_custom_face', 'modify_custom_face', 'delete_custom_face'].includes(action))
        return { emoji_id: 'mock-' + qq.length }
      } }, ...options })
    stores.push(store); return store
  }
  const incoming = (bytes = PNG, chatId = 'group:1', account = cfg.botQQ) => {
    const seg = segment(bytes)
    const m = storage.messages.ingest({ account, chatId, authorId: '200', platformMsgId: String(++seq), segments: [seg] })
    return { seg, source: { accountId: account, chatId, messageId: m.id, segmentIndex: 0 } }
  }
  const collect = async (store, input) => {
    const receipt = await store.collect(input.seg, input.source)
    assert.equal(receipt.ok, true)
    return receipt
  }
  const tasks = store => store.queueStatus({ ...ADMIN, kind: 'analyze' }).items
  t.after(async () => {
    for (const store of stores) await store.stop()
    for (const s of connections) s.close()
    const abs = resolve(root)
    assert.ok(abs.startsWith(resolve(tmpdir()) + sep) && abs.includes('aurabot-stickers-global-'))
    rmSync(abs, { recursive: true, force: true })
  })
  return { root, cfg, storage, open, create, incoming, collect, tasks, analyses, qq, samples, behavior,
    advance: ms => { clock += ms } }
}

test('default account library deduplicates concurrent cross-group collection and pays/analyzes/syncs once', async t => {
  const f = fixture(t), a = f.create(), b = f.create({ storage: f.open() })
  await Promise.all([f.collect(a, f.incoming(PNG, 'group:1')), f.collect(b, f.incoming(PNG, 'group:2'))])
  await Promise.all([a.drain(), b.drain()])
  const listed = a.list(ADMIN), item = listed.items[0]
  assert.equal(listed.libraryScope, 'account'); assert.equal(listed.total, 1)
  assert.equal(item.state, 'approved'); assert.equal(item.usable, true)
  assert.equal(f.storage.db.get('SELECT COUNT(*) n FROM sticker_items').n, 1)
  assert.equal(f.storage.db.get('SELECT COUNT(*) n FROM sticker_sources').n, 2)
  assert.equal(f.storage.db.get('SELECT COUNT(*) n FROM sticker_quota').n, 1)
  assert.equal(f.analyses.length, 1); assert.equal(f.tasks(a).length, 1); assert.equal(f.tasks(a)[0].attempts, 1)
  assert.equal(f.qq.filter(c => c.action === 'add_custom_face').length, 1)
  for (const chat of ['group:1', 'group:2', 'private:200']) assert.equal(a.match('开心', chat).id, item.id)
})

test('global deny and tombstone dominate historical chat copies and cannot be bypassed by another group', async t => {
  const f = fixture(t, { caption: false, libraryScope: 'chat' }), s = f.create()
  const a = (await s.addFromBuffer(PNG, { chatId: 'group:1', toQQ: false })).item
  const b = (await s.addFromBuffer(PNG, { chatId: 'group:2', toQQ: false })).item
  assert.notEqual(a.id, b.id)
  assert.equal(s.approve(a.id, ADMIN).ok, true); assert.equal(s.approve(b.id, ADMIN).ok, true)
  f.cfg.stickers.libraryScope = 'account'
  assert.equal(s.list(ADMIN).total, 1)
  assert.equal(s.disable(a.id, ADMIN).ok, true)
  assert.equal(s.segmentFor(b, 'group:3'), null)
  assert.equal(s.approve(b.id, ADMIN).code, 'LIBRARY_BLOCKED')
  const duplicate = await s.addFromBuffer(PNG, { chatId: 'group:3', toQQ: false })
  assert.equal(duplicate.existed, true); assert.equal(duplicate.item.state, 'disabled')
  assert.equal(s.reject(a.id, ADMIN).ok, true); assert.equal(s.match('开心', 'group:2'), null)
  assert.equal(s.stats(ADMIN).rejected, 1)
  assert.equal(s.remove(a.id, { ...ADMIN, fromQQ: false }).tombstone, true)
  assert.equal((await s.addFromBuffer(PNG, { chatId: 'group:4' })).code, 'TOMBSTONED')
  const recovered = f.create({ storage: f.open() }); recovered.recover(); await recovered.drain()
  assert.equal(recovered.segmentFor(b, 'group:4'), null)
  assert.equal(recovered.list(ADMIN).total, 0); assert.equal(recovered.stats(ADMIN).deleted, 1)
  assert.equal(f.storage.db.get('SELECT COUNT(*) n FROM sticker_items').n, 2)
  assert.equal(f.analyses.length, 0); assert.equal(f.qq.length, 0)
})

test('same image in two robot accounts retains independent items, access and tombstones', async t => {
  const f = fixture(t), a = f.create(), b = f.create({ config: { ...f.cfg, botQQ: '101', ownerQQ: '201' } })
  const first = await a.addFromBuffer(PNG, { toQQ: false }), second = await b.addFromBuffer(PNG, { toQQ: false })
  await a.drain(); await b.drain()
  assert.notEqual(first.item.id, second.item.id)
  assert.equal(a.list(ADMIN).total, 1); assert.equal(b.list(ADMIN).total, 1)
  assert.equal(a.get(second.item.id, ADMIN), null); assert.equal(a.segmentFor(second.item, 'group:1'), null)
  assert.equal(a.disable(second.item.id, ADMIN).code, 'NOT_FOUND')
  assert.throws(() => a.list({ ...ADMIN, accountId: '101' }), e => e.code === 'WRONG_ACCOUNT')
  assert.throws(() => a.stats({ ...ADMIN, accountId: '101' }), e => e.code === 'WRONG_ACCOUNT')
  assert.equal(a.remove(first.item.id, { ...ADMIN, fromQQ: false }).ok, true)
  assert.equal(b.match('开心', 'group:1').id, second.item.id)
  assert.equal(b.get(second.item.id, ADMIN).usable, true)
})

test('global library keeps usage and automatic-send cooldown separate for each target chat', async t => {
  const f = fixture(t, { cooldownMs: 60_000 }), s = f.create()
  const { item } = await s.addFromBuffer(PNG, { toQQ: false }); await s.drain()
  assert.equal(s.selectForReply('开心', 'group:1').decision, 'match')
  assert.equal(s.markUsed(item.id, 'group:1'), true)
  assert.equal(s.selectForReply('开心', 'group:1').decision, 'no_match')
  assert.equal(s.selectForReply('开心', 'group:2').decision, 'match')
  assert.equal(s.selectForReply('开心', 'private:200').decision, 'match')
  assert.equal(s.markUsed(item.id, 'group:2'), true)
  assert.equal(s.get(item.id, { ...ADMIN, chatId: 'group:1' }).uses, 1)
  assert.equal(s.get(item.id, { ...ADMIN, chatId: 'group:2' }).uses, 1)
  assert.equal(s.get(item.id, { ...ADMIN, chatId: 'private:200' }).uses, 0)
  f.advance(60_001)
  assert.equal(s.selectForReply('开心', 'group:1').decision, 'match')
  assert.equal(f.analyses.length, 1)
})

test('account admin upload, legacy assignment, QQ import, stats, queue and batch work without chatId', async t => {
  const f = fixture(t), s = f.create()
  const upload = await s.addFromBuffer(PNG, { from: 'panel', toQQ: false })
  assert.equal(upload.ok, true); await s.drain()
  const panel = s.get(upload.item.id, ADMIN)
  assert.equal(panel.state, 'approved'); assert.equal(panel.sourceKind, 'panel'); assert.equal(panel.sourceChatId, null)
  assert.equal(panel.source, null); assert.equal(panel.scope.chat, 'private:200')
  const dir = join(f.root, 'legacy'); mkdirSync(dir)
  writeFileSync(join(dir, 'old.png'), picture('legacy'))
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ items: [{ file: 'old.png', name: '旧猫', tags: ['开心'] }] }))
  assert.equal(s.importLegacy(dir, ADMIN).imported, 1)
  const old = s.list({ ...ADMIN, status: 'quarantined' }).items[0]
  const assigned = await s.assignLegacy(old.id, ADMIN)
  assert.equal(assigned.ok, true); await s.drain()
  assert.equal(s.get(assigned.item.id, ADMIN).state, 'pending', 'legacy analysis approve must not silently approve unknown-origin imports')
  const imported = await s.importFromQQ(ADMIN)
  assert.equal(imported.ok, true)
  assert.equal((await s.importFromQQ({ ...ADMIN, chatId: 'group:9' })).taskId, imported.taskId)
  await s.drain()
  const remote = s.list(ADMIN).items.find(it => it.sourceKind === 'qq')
  assert.equal(remote.state, 'approved'); assert.equal(remote.sourceChatId, null); assert.equal(remote.source, null)
  assert.equal(remote.qq.emojiId, 'existing-qq')
  assert.deepEqual(f.qq.map(c => c.action), ['fetch_custom_face'])
  assert.equal(s.list(ADMIN).total, 3); assert.equal(s.stats(ADMIN).approved, 2)
  assert.equal(s.queueStatus(ADMIN).libraryScope, 'account')
  const batch = s.batch('disable', [{ id: panel.id, expectedRevision: panel.revision }], ADMIN)
  assert.equal(batch.succeeded, 1); assert.equal(s.get(panel.id, ADMIN).state, 'disabled')
  assert.equal(f.storage.db.get('SELECT COUNT(*) n FROM messages').n, 0, 'internal storage scopes must not fabricate source messages')
})

test('a valid new message refreshes lost source evidence without restoring old messages or reanalysing', async t => {
  const f = fixture(t), s = f.create(), old = f.incoming(PNG, 'group:1')
  await f.collect(s, old); await s.drain()
  const item = s.list(ADMIN).items[0]
  f.storage.db.run('DELETE FROM messages WHERE id=?', old.source.messageId)
  assert.equal(s.get(item.id, ADMIN).availability, 'unavailable')
  assert.equal(s.retryAnalysis(item.id, ADMIN).code, 'INVALID_SOURCE')
  const fresh = f.incoming(PNG, 'group:2'); await f.collect(s, fresh); await s.drain()
  const updated = s.get(item.id, ADMIN)
  assert.equal(updated.state, 'approved'); assert.equal(updated.usable, true)
  assert.equal(updated.source.messageId, fresh.source.messageId); assert.equal(updated.source.scope.chat, 'group:2')
  assert.equal(updated.sourceChatId, 'group:2'); assert.equal(updated.scope.chat, item.scope.chat)
  assert.equal(f.storage.messages.get(old.source.messageId), null)
  assert.equal(f.storage.db.get('SELECT COUNT(*) n FROM sticker_sources WHERE item_id=?', item.id).n, 2)
  assert.equal(f.analyses.length, 1); assert.equal(f.qq.filter(c => c.action === 'add_custom_face').length, 1)
  assert.equal(s.match('开心', 'group:3').id, item.id)
  f.storage.db.run('UPDATE messages SET recalled_at=? WHERE id=?', Date.now(), fresh.source.messageId)
  assert.equal(s.segmentFor(updated, 'group:3'), null, 'refreshed sources still obey recall validation')
})

test('fresh same-hash message cannot revive a disabled/rejected item or replace its invalid source', async t => {
  const f = fixture(t), s = f.create()
  for (const state of ['disabled', 'rejected']) {
    const bytes = picture(state), old = f.incoming(bytes, 'group:1')
    await f.collect(s, old); await s.drain()
    const item = s.list(ADMIN).items.find(it => it.source?.messageId === old.source.messageId)
    assert.equal((state === 'disabled' ? s.disable(item.id, ADMIN) : s.reject(item.id, ADMIN)).ok, true)
    f.storage.db.run('DELETE FROM messages WHERE id=?', old.source.messageId)
    const calls = f.analyses.length, fresh = f.incoming(bytes, 'group:2')
    await f.collect(s, fresh); await s.drain()
    const current = s.get(item.id, ADMIN)
    assert.equal(current.state, state); assert.equal(current.source.messageId, old.source.messageId)
    assert.equal(current.usable, false); assert.equal(s.segmentFor(current, 'group:2'), null)
    assert.equal(f.analyses.length, calls)
    assert.equal(f.storage.db.get('SELECT COUNT(*) n FROM sticker_items WHERE sha256=?', item.sha256).n, 1)
  }
})

test('old source-free animation needs_frames requires explicit retry, then can approve; unknown never recharges', async t => {
  const f = fixture(t), s = f.create()
  const { item } = await s.addFromBuffer(GIF, { from: 'qq', toQQ: false }); await s.drain()
  assert.equal(s.get(item.id, ADMIN).analysis.state, 'needs_frames')
  const oldTask = f.tasks(s)[0]
  // Simulate a pre-upgrade row in this isolated DB, without the new eligibility field.
  const legacy = JSON.parse(f.storage.db.get('SELECT body_json FROM sticker_items WHERE id=?', item.id).body_json)
  delete legacy.autoReviewEligible
  f.storage.db.run('UPDATE sticker_items SET body_json=? WHERE id=?', JSON.stringify(legacy), item.id)
  s.recover(); await s.drain()
  assert.equal(s.get(item.id, ADMIN).state, 'pending'); assert.equal(f.analyses.length, 0)
  f.behavior.frames = sampled()
  const retry = s.retryTask(oldTask.id, ADMIN)
  assert.equal(retry.ok, true); assert.equal(s.retryAnalysis(item.id, ADMIN).taskId, retry.taskId)
  await s.drain()
  const approved = s.get(item.id, ADMIN)
  assert.equal(approved.state, 'approved'); assert.equal(approved.review.kind, 'model')
  assert.equal(approved.source, null); assert.equal(approved.analysis.evidence.coverage, 'sampled_partial')
  assert.equal(approved.analysis.evidence.sampling.complete, false); assert.equal(approved.frames.length, 2)
  assert.equal(s.match('开心', 'group:9').id, item.id); assert.equal(f.analyses.length, 1)
  f.behavior.error = Object.assign(new Error('synthetic incomplete remote result'), { code: 'MODEL_INCOMPLETE' })
  const otherBytes = Buffer.concat([GIF, Buffer.from('unknown')])
  const uncertain = (await s.addFromBuffer(otherBytes, { from: 'panel', toQQ: false })).item
  await s.drain()
  const task = f.tasks(s).find(task => task.itemId === uncertain.id), calls = f.analyses.length
  assert.equal(task.state, 'unknown'); assert.equal(task.attempts, 1)
  assert.equal(s.retryTask(task.id, ADMIN).code, 'NOT_RETRYABLE')
  assert.equal(s.retryAnalysis(uncertain.id, ADMIN).code, 'ANALYSIS_UNKNOWN')
  assert.equal(s.selectFrames(uncertain.id, [{ bytes: PNG, atMs: 0 }], ADMIN).code, 'ANALYSIS_BUSY')
  f.behavior.error = null
  await f.collect(s, f.incoming(otherBytes, 'group:2')); await s.drain()
  const recovered = f.create({ storage: f.open() }); recovered.recover(); await recovered.drain()
  assert.equal(recovered.get(uncertain.id, ADMIN).analysis.state, 'unknown')
  assert.equal(f.analyses.length, calls)
  assert.equal(f.tasks(recovered).filter(t => t.itemId === uncertain.id).length, 1)
})

test('a verified one-frame container is reviewed as a still image, but a single sampled animation frame stays pending', async t => {
  const f = fixture(t), s = f.create()
  for (const sourceFrames of [1, 8]) {
    f.behavior.frames = { ...sampled(), frames: sampled().frames.slice(0, 1),
      sampling: { ...sampled().sampling, sourceFrames, sampledFrames: 1 } }
    const { item } = await s.addFromBuffer(Buffer.concat([GIF, Buffer.from(String(sourceFrames))]), { from: 'panel' })
    await s.drain()
    const result = s.get(item.id, ADMIN), input = f.analyses.at(-1)
    assert.equal(input.animated, sourceFrames !== 1)
    assert.equal(input.coverage, sourceFrames === 1 ? 'still_image' : 'sampled_partial')
    assert.equal(result.state, sourceFrames === 1 ? 'approved' : 'pending')
    assert.equal(result.analysis.evidence.singleFrame, sourceFrames === 1)
  }
})

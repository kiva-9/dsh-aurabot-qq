// 存储层：ID、结构迁移、消息去重、资产去重、出现记录、代次、请求、可见范围、旧数据预检。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newId, idTime, ID_PATTERN } from '../src/core/ids.js'
import { openDatabase } from '../src/storage/db.js'
import { migrate, schemaVersion, MIGRATIONS } from '../src/storage/migrations.js'
import { createStorage } from '../src/storage/index.js'
import { makeScope, canSee, canSeeAll, normalizeShareGroups } from '../src/domain/scope.js'
import { preflight, backupLegacy, runLegacySteps } from '../src/migrate/legacy.js'

const tmp = (p) => mkdtempSync(join(tmpdir(), `aurabot-${p}-`))
const mem = () => createStorage({ file: ':memory:', filesDir: join(tmp('files'), 'assets') })

test('ID：格式固定、同一毫秒内也按生成顺序递增、能读回时间', () => {
  const t = Date.UTC(2026, 9, 28)
  const ids = Array.from({ length: 200 }, () => newId('msg', t))
  assert.ok(ids.every((id) => ID_PATTERN.test(id)))
  assert.deepEqual([...ids].sort(), ids, '字符串顺序就是生成顺序')
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(idTime(ids[0]), t)
  assert.throws(() => newId('BAD'))
})

test('迁移：新库直接到最新；再开不重复跑；库比程序新就拒绝打开', () => {
  const dir = tmp('db')
  const file = join(dir, 'a.db')
  const s = createStorage({ file, filesDir: join(dir, 'assets') })
  assert.equal(s.info().version, MIGRATIONS.at(-1).version)
  assert.equal(s.info().backup, '', '新库不用备份')
  s.close()
  const again = createStorage({ file, filesDir: join(dir, 'assets') })
  assert.equal(again.info().migratedFrom, again.info().version)
  again.db.exec('PRAGMA user_version = 999')
  again.close()
  assert.throws(() => createStorage({ file, filesDir: join(dir, 'assets') }), (e) => e.code === 'DB_TOO_NEW')
})

test('迁移：已有数据的库升级前先备份；某一步失败就停在原版本', () => {
  const dir = tmp('db2')
  const db = openDatabase(join(dir, 'b.db'))
  const steps = [{ version: 1, name: 'one', up: 'CREATE TABLE a (x INTEGER);' }]
  migrate(db, { migrations: steps })
  db.run('INSERT INTO a VALUES (1)')
  const r = migrate(db, { migrations: [...steps, { version: 2, name: 'two', up: 'CREATE TABLE b (y INTEGER);' }] })
  assert.equal(r.to, 2)
  assert.ok(r.backup && existsSync(r.backup), '升级前做了备份')
  const bad = [...steps, { version: 2, name: 'two', up: 'CREATE TABLE b (y INTEGER);' }, { version: 3, name: 'broken', up: 'CREATE TABLE c (z INTEGER); THIS IS NOT SQL;' }]
  assert.throws(() => migrate(db, { migrations: bad }))
  assert.equal(schemaVersion(db), 2, '失败的那一步没推进版本')
  assert.equal(db.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'c'").n, 0, '失败的那一步整步回滚')
  db.close()
})

test('事务：抛错整体回滚；嵌套的内层失败只回滚内层；不能在事务里 await', () => {
  const s = mem()
  assert.throws(() => s.tx(() => { s.meta.set('a', 1); throw new Error('x') }))
  assert.equal(s.meta.get('a'), null)
  s.tx(() => {
    s.meta.set('b', 1)
    try { s.tx(() => { s.meta.set('c', 1); throw new Error('inner') }) } catch (error) {}
  })
  assert.equal(s.meta.get('b'), 1)
  assert.equal(s.meta.get('c'), null)
  assert.throws(() => s.tx(async () => {}), /异步/)
})

test('消息：有 QQ 消息 ID 的重放事件去重；没有 ID 的同文连发不会被当成重复', () => {
  const s = mem()
  const base = { account: '20000002', chatId: 'group:555', eventKind: 'message', authorId: '1', text: '哈哈' }
  const a = s.messages.ingest({ ...base, platformMsgId: '777' })
  const b = s.messages.ingest({ ...base, platformMsgId: '777' })
  assert.equal(b.duplicate, true)
  assert.equal(b.id, a.id)
  const c = s.messages.ingest({ ...base, platformMsgId: '' })
  const d = s.messages.ingest({ ...base })
  const e = s.messages.ingest({ ...base, platformMsgId: 0 })
  assert.ok(!c.duplicate && !d.duplicate && !e.duplicate)
  assert.equal(new Set([a.id, c.id, d.id, e.id]).size, 4)
  assert.ok(a.recvSeq < c.recvSeq && c.recvSeq < d.recvSeq, '接收序号单调递增')
  // 同一个 QQ 消息 ID 在别的聊天、别的事件类别里不算重复
  assert.equal(s.messages.ingest({ ...base, chatId: 'group:556', platformMsgId: '777' }).duplicate, false)
  assert.equal(s.messages.ingest({ ...base, eventKind: 'poke', platformMsgId: '777' }).duplicate, false)
  assert.equal(s.messages.recent('group:555').length, 5, '四条消息 + 一次戳一戳')
  assert.equal(s.messages.byPlatformId('group:555', '777').id, a.id)
})

test('资产：同一份字节只存一份；出现记录各自保留、先 pending 再回填', () => {
  const s = mem()
  const m = s.messages.ingest({ account: '2', chatId: 'private:1', eventKind: 'message', authorId: '1', platformMsgId: '9' })
  const scope = makeScope({ account: '2', chat: 'private:1', category: 'image' })
  const o1 = s.occurrences.add({ messageId: m.id, chatId: 'private:1', authorId: '1', segIndex: 0, kind: 'image', remote: { url: 'http://x/a.png' }, scope })
  const o2 = s.occurrences.add({ messageId: m.id, chatId: 'private:1', authorId: '1', segIndex: 1, kind: 'image', scope })
  assert.equal(s.occurrences.pending().length, 2)
  const buf = Buffer.from('fake png bytes')
  const a1 = s.assets.put(buf, { mime: 'image/png' })
  const a2 = s.assets.put(Buffer.from(buf), { mime: 'image/png' })
  assert.equal(a1.id, a2.id, '同一份字节同一个资产')
  assert.ok(existsSync(s.assets.pathOf(a1)))
  assert.deepEqual(readFileSync(s.assets.pathOf(a1)), buf)
  s.occurrences.ready(o1, a1.id)
  s.occurrences.ready(o2, a1.id)
  const occ = s.occurrences.ofMessage(m.id)
  assert.equal(occ.length, 2, '两次出现都在')
  assert.deepEqual(occ.map((o) => o.segIndex), [0, 1], '按原消息里的顺序')
  assert.ok(occ.every((o) => o.state === 'ready' && o.assetId === a1.id))
  assert.deepEqual(occ[0].scope, scope)
  assert.throws(() => s.occurrences.add({ messageId: m.id, chatId: 'private:1', authorId: '1', segIndex: 0, kind: 'image', scope }), '同一条消息同一段不能登记两次')
  assert.throws(() => s.assets.put(Buffer.alloc(0), { mime: 'image/png' }))
})

test('代次与请求：请求记下创建时的代次；切换后代次 +1；请求必须有来源消息', () => {
  const s = mem()
  const m = s.messages.ingest({ account: '2', chatId: 'group:5', eventKind: 'message', authorId: '1', platformMsgId: '1' })
  assert.equal(s.epochs.current('group:5'), 0)
  const r1 = s.requests.create({ chatId: 'group:5', actorId: '1', sourceMessageIds: [m.id] })
  assert.equal(r1.epoch, 0)
  assert.equal(r1.actorId, '1')
  assert.equal(s.epochs.bump('group:5', '换人设'), 1)
  const r2 = s.requests.create({ chatId: 'group:5', actorId: '1', sourceMessageIds: [m.id] })
  assert.equal(r2.epoch, 1)
  assert.throws(() => s.requests.create({ chatId: 'group:5', actorId: '1', sourceMessageIds: [] }))
})

test('可见范围：默认按聊天隔离；共享组按类别放开；派生内容取交集；角色相关的按人设隔离', () => {
  const policy = { shareGroups: normalizeShareGroups([{ id: 'g', chats: ['group:1', 'group:2'], categories: ['fact'] }, { id: 'bad', chats: ['group:1'], categories: ['fact'] }]) }
  assert.equal(policy.shareGroups.length, 1, '只有一个聊天的共享组没意义，丢掉')
  const v1 = { account: '9', chat: 'group:1', persona: 'a' }
  const v2 = { account: '9', chat: 'group:2', persona: 'a' }
  const pm = makeScope({ account: '9', chat: 'private:7', category: 'fact' })
  const g1fact = makeScope({ account: '9', chat: 'group:1', category: 'fact' })
  const g1img = makeScope({ account: '9', chat: 'group:1', category: 'image' })
  assert.equal(canSee(pm, v1, policy), false, '私聊的事实不进群')
  assert.equal(canSee(g1fact, v2, policy), true, '共享组里共享事实')
  assert.equal(canSee(g1img, v2, policy), false, '图片没共享')
  assert.equal(canSee(g1fact, { ...v1, account: '8' }, policy), false, '别的机器人号看不到')
  assert.equal(canSeeAll([g1fact, pm], v1, policy), false, '群公开证据 + 私聊证据的摘要不能在群里看')
  assert.equal(canSeeAll([], v1, policy), false)
  const moodA = makeScope({ account: '9', chat: 'group:1', category: 'mood', persona: 'a' })
  assert.equal(canSee(moodA, v1), true)
  assert.equal(canSee(moodA, { ...v1, persona: 'b' }), false, '换了人设看不到旧角色的心情')
  assert.throws(() => makeScope({ account: '9', chat: 'group:1', category: 'mood' }), '心情必须带人设')
  assert.throws(() => makeScope({ account: '9', chat: 'nope', category: 'fact' }))
})

test('旧数据：预检列出各文件、已删除功能单独标出；备份跳过大目录；导入步骤失败就停', async () => {
  const dir = tmp('legacy')
  writeFileSync(join(dir, 'config.json'), '{"ownerQQ":"1"}')
  writeFileSync(join(dir, 'memories.json'), JSON.stringify({ items: [{ id: 'a' }, { id: 'b' }] }))
  writeFileSync(join(dir, 'mood.json'), '{坏的')
  writeFileSync(join(dir, 'diary.json'), '{"history":[]}')
  mkdirSync(join(dir, 'douyin', 'edge-profile'), { recursive: true })
  writeFileSync(join(dir, 'douyin', 'edge-profile', 'x'), 'big')
  mkdirSync(join(dir, 'personas'))
  writeFileSync(join(dir, 'personas', 'dafeiyu.md'), '# 大肥鱼')
  const r = preflight(dir)
  const by = Object.fromEntries(r.items.map((i) => [i.name, i]))
  assert.equal(by['memories.json'].items, 2)
  assert.equal(by['personas'].files, 1)
  assert.equal(by['diary.json'].removed, true)
  assert.ok(r.warnings.some((w) => w.includes('mood.json')), '坏 JSON 有提示')
  assert.ok(r.warnings.some((w) => w.includes('diary.json') && w.includes('douyin')))
  const b = backupLegacy(dir, r, 123)
  assert.ok(b.copied.includes('config.json') && b.copied.includes('personas'))
  assert.ok(b.skipped.includes('douyin'), '抖音登录资料太大，不复制')
  assert.ok(existsSync(join(b.dir, 'manifest.json')))
  assert.ok(readdirSync(dir).includes('config.json'), '原文件还在')

  const s = mem()
  const ran = []
  const steps = [
    { id: 'one', run: async () => { ran.push('one'); return { n: 1 } } },
    { id: 'two', run: async () => { ran.push('two'); throw new Error('坏了') } },
    { id: 'three', run: async () => { ran.push('three'); return {} } },
  ]
  const r1 = await runLegacySteps({ storage: s, steps, baseDir: dir })
  assert.equal(r1.ok, false)
  assert.equal(r1.blockedAt, 'two')
  assert.deepEqual(ran, ['one', 'two'], '失败后面的不跑')
  assert.equal(s.legacy.get('one').report.n, 1)
  steps[1].run = async () => { ran.push('two'); return {} }
  const r2 = await runLegacySteps({ storage: s, steps, baseDir: dir })
  assert.equal(r2.ok, true)
  assert.deepEqual(ran, ['one', 'two', 'two', 'three'], '做完的不重做')
})

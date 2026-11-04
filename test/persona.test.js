// 人设库：严格 ID、草稿/发布/回滚、并发保存、绑定优先级、坏绑定不乱换、内置卡不复活、旧 Markdown 原样导入。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorage } from '../src/storage/index.js'
import { createPersonaStore, normalizeLayers } from '../src/persona/store.js'
import { createPersonaService } from '../src/persona/service.js'
import { compilePersona, PERSONA_ERROR_TEXT } from '../src/persona/compiler.js'

const storage = () => createStorage({ file: ':memory:', filesDir: join(mkdtempSync(join(tmpdir(), 'aurabot-ps-')), 'assets') })
const L = (core, extra = {}) => ({ identity: { name: '小蓝', core }, ...extra })

test('ID 不合法直接拒绝，不删字符凑别名', () => {
  const ps = createPersonaStore({ storage: storage() })
  assert.throws(() => ps.create({ id: '小蓝', name: 'x', layers: L('a') }), (e) => e.code === 'BAD_ID')
  assert.throws(() => ps.create({ id: 'a b', name: 'x', layers: L('a') }), (e) => e.code === 'BAD_ID')
  assert.ok(ps.create({ id: 'xiao-lan_2', name: 'x', layers: L('a') }))
})

test('草稿 → 发布成不可变版本；改草稿不影响已发布的；回滚是发布一个新版本', () => {
  const ps = createPersonaStore({ storage: storage() })
  let p = ps.create({ id: 'lan', name: '小蓝', layers: L('第一版'), publish: true })
  assert.equal(p.published.revision, 1)
  assert.equal(p.draft, null)
  p = ps.saveDraft('lan', { layers: L('第二版') }, { editRevision: p.editRevision })
  assert.equal(p.published.layers.identity.core, '第一版', '发布前线上还是旧的')
  assert.equal(p.draft.layers.identity.core, '第二版')
  assert.equal(ps.resolve('group:1').error !== undefined, true, '还没绑定')
  p = ps.publish('lan', { editRevision: p.editRevision })
  assert.equal(p.published.revision, 2)
  p = ps.rollback('lan', 1, { editRevision: p.editRevision })
  assert.equal(p.published.revision, 3)
  assert.equal(p.published.layers.identity.core, '第一版')
  assert.deepEqual(ps.revisions('lan').map((r) => r.revision), [3, 2, 1], '历史都在')
  assert.equal(ps.revision('lan', 2).layers.identity.core, '第二版')
})

test('并发保存：带着过期的 editRevision 保存被拒绝，不覆盖别人的改动', () => {
  const ps = createPersonaStore({ storage: storage() })
  const p = ps.create({ id: 'lan', name: '小蓝', layers: L('a'), publish: true })
  ps.saveDraft('lan', { layers: L('甲改的') }, { editRevision: p.editRevision })
  assert.throws(() => ps.saveDraft('lan', { layers: L('乙改的') }, { editRevision: p.editRevision }), (e) => e.code === 'STALE')
  assert.equal(ps.get('lan').draft.layers.identity.core, '甲改的')
})

test('绑定：具体聊天 → 群聊/私聊默认 → 全局；快照带版本号', () => {
  const ps = createPersonaStore({ storage: storage() })
  ps.create({ id: 'a', name: 'A', layers: L('a'), publish: true })
  ps.create({ id: 'b', name: 'B', layers: L('b'), publish: true })
  ps.create({ id: 'c', name: 'C', layers: L('c'), publish: true })
  ps.bind('global', 'a')
  ps.bind('kind:group', 'b')
  ps.bind('chat:group:9', 'c')
  assert.equal(ps.resolve('private:1').personaId, 'a')
  assert.equal(ps.resolve('group:1').personaId, 'b')
  assert.equal(ps.resolve('group:9').personaId, 'c')
  assert.equal(ps.resolve('group:9').revision, 1)
  const before = ps.resolve('group:9').bindingRevision
  ps.bind('chat:group:9', null)
  assert.equal(ps.resolve('group:9').personaId, 'b', '去掉具体绑定后退回群聊默认')
  assert.ok(ps.resolve('group:9').bindingRevision > before)
  assert.throws(() => ps.bind('global', null), (e) => e.code === 'NEED_GLOBAL')
  assert.throws(() => ps.bind('chat:nope', 'a'), (e) => e.code === 'BAD_SCOPE')
})

test('bindingRevision 按聊天生效范围计算，别的聊天换绑定不影响本聊天', () => {
  const ps = createPersonaStore({ storage: storage() })
  ps.create({ id: 'a', name: 'A', layers: L('a'), publish: true })
  ps.create({ id: 'b', name: 'B', layers: L('b'), publish: true })
  ps.create({ id: 'c', name: 'C', layers: L('c'), publish: true })
  ps.bind('global', 'a')
  ps.bind('chat:group:1', 'b')
  ps.bind('chat:group:2', 'c')
  const one = ps.resolve('group:1').bindingRevision, two = ps.resolve('group:2').bindingRevision
  ps.bind('chat:group:2', 'a')
  assert.equal(ps.resolve('group:1').bindingRevision, one, '另一个聊天换卡不影响本聊天')
  assert.ok(ps.resolve('group:2').bindingRevision > two, '本聊天换卡后才递增')
  const before = ps.resolve('group:1').bindingRevision
  ps.bind('chat:group:1', null)
  assert.ok(ps.resolve('group:1').bindingRevision > before)
})

test('在用的卡不能归档；绑定指向的卡出问题时报错，不随便换成第一张', () => {
  const s = storage()
  const ps = createPersonaStore({ storage: s })
  ps.create({ id: 'a', name: 'A', layers: L('a'), publish: true })
  ps.create({ id: 'b', name: 'B', layers: L('b'), publish: true })
  ps.bind('global', 'a')
  ps.bind('chat:group:5', 'b')
  assert.throws(() => ps.archive('b'), (e) => e.code === 'IN_USE' && e.scopes.includes('chat:group:5'))
  // 绕过检查直接把卡归档（模拟数据被外部改坏）
  s.db.run("UPDATE personas SET archived_at = 1 WHERE id = 'b'")
  const r = ps.resolve('group:5')
  assert.ok(r.error && r.error.includes('已归档'))
  assert.equal(r.personaId, undefined, '没有退回别的卡')
  assert.equal(compilePersona(null), '')
  assert.ok(PERSONA_ERROR_TEXT.includes('不扮演任何角色'))
})

test('内置卡只导入一次；用户删掉后不会复活', () => {
  const s = storage()
  const ps = createPersonaStore({ storage: s })
  const card = { id: 'dafeiyu', name: '大肥鱼', layers: L('鱼') }
  assert.deepEqual(ps.seed([card]), ['dafeiyu'])
  assert.deepEqual(ps.seed([card]), [], '第二次不再导入')
  ps.archive('dafeiyu')
  ps.remove('dafeiyu')
  assert.deepEqual(ps.seed([card]), [], '删掉的内置卡不会复活')
  assert.equal(ps.get('dafeiyu'), null)
  const fresh = createPersonaStore({ storage: s })
  assert.deepEqual(fresh.seed([card]), [], '换个实例也一样')
})

test('旧版人格：数据目录里的 Markdown 原样导入，旧的「当前人格」变成全局绑定；坏文件名不改名', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-oldp-'))
  const old = join(dir, 'personas')
  mkdirSync(old)
  writeFileSync(join(old, 'lan.md'), '---\nname: 小蓝\ntags: [冷淡]\n---\n\n你是小蓝，一个话很少的人。')
  writeFileSync(join(old, '坏名字.md'), '你是谁')
  const bundled = join(dir, 'bundled')
  mkdirSync(bundled)
  writeFileSync(join(bundled, 'dafeiyu.md'), '---\nname: 大肥鱼\n---\n\n你是大肥鱼。')
  const s = storage()
  const svc = createPersonaService({ storage: s, legacyDir: old, legacyCurrent: 'lan', bundledDir: bundled })
  assert.equal(svc.globalId(), 'lan')
  const lan = svc.store.get('lan')
  assert.equal(lan.origin, 'legacy')
  assert.equal(lan.published.layers.legacy.body, '你是小蓝，一个话很少的人。', '原文一字不改')
  assert.deepEqual(lan.published.layers.tags, ['冷淡'])
  assert.ok(svc.store.get('dafeiyu'), '内置卡也在')
  assert.deepEqual(s.legacy.get('personas-markdown-v1').report.badId, ['坏名字'])
  assert.ok(svc.textOf(svc.snapshotFor('group:1')).startsWith('你是小蓝，一个话很少的人。\n\n【平时怎么做】'), '旧卡原文在前，只补默认平时习惯')
  // 再初始化一次不重复导入
  createPersonaService({ storage: s, legacyDir: old, legacyCurrent: 'lan', bundledDir: bundled })
  assert.equal(svc.store.revisions('lan').length, 1)
})

test('分层编译：名字、性格、样子、做法、说话方式按层拼；坏数据归一化', () => {
  const text = compilePersona(normalizeLayers({
    identity: { name: '小蓝', core: '安静', callOwner: '老大' },
    behavior: { proactivity: 'low', text: '不爱插话' },
    style: { text: '短句', examples: ['嗯'], banned: ['综上所述'] },
    appearance: { text: '蓝头发' },
  }))
  for (const s of ['你是「小蓝」', '老大', '安静', '蓝头发', '话不多', '不爱插话', '短句', '- 嗯', '综上所述']) assert.ok(text.includes(s), s)
  const n = normalizeLayers({ voice: { speed: 99 }, behavior: { proactivity: 'crazy' }, junk: 1 })
  assert.equal(n.voice.speed, 2)
  assert.equal(n.behavior.proactivity, 'normal')
  assert.equal(n.junk, undefined)
})

test('内置 JSON 卡保留分层与导出格式，优先于同名内置 Markdown，更新不覆盖用户版本', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-native-persona-'))
  const bundled = join(dir, 'bundled'), legacy = join(dir, 'legacy')
  mkdirSync(bundled); mkdirSync(legacy)
  const card = { format: 'aurabot-persona', version: 1, id: 'dafeiyu', name: '大肥鱼', layers: L('分层身份', { appearance: { text: '蓝色鲸鱼娘' } }) }
  writeFileSync(join(bundled, 'dafeiyu.persona.json'), JSON.stringify(card))
  writeFileSync(join(bundled, 'dafeiyu.md'), '---\nname: 旧内置卡\n---\n旧内置正文')
  const s = storage(), svc = createPersonaService({ storage: s, legacyDir: legacy, bundledDir: bundled })
  assert.equal(svc.store.get('dafeiyu').published.layers.legacy, undefined)
  assert.equal(svc.store.exportCard('dafeiyu').layers.appearance.text, '蓝色鲸鱼娘')
  assert.match(svc.textOf(svc.snapshotFor('group:1')), /分层身份/)
  writeFileSync(join(bundled, 'dafeiyu.persona.json'), JSON.stringify({ ...card, layers: L('后来更新的内置身份') }))
  createPersonaService({ storage: s, legacyDir: legacy, bundledDir: bundled })
  assert.equal(svc.store.get('dafeiyu').published.revision, 1)
  assert.equal(svc.store.get('dafeiyu').published.layers.identity.core, '分层身份')
  writeFileSync(join(legacy, 'dafeiyu.md'), '---\nname: 用户旧卡\n---\n用户自己的设定')
  const migrated = createPersonaService({ storage: storage(), legacyDir: legacy, bundledDir: bundled })
  assert.equal(migrated.store.get('dafeiyu').published.layers.legacy.body, '用户自己的设定')
})

test('默认按聊天类型分卡：私聊绑私房版、群聊绑群骚版，已有绑定和自定义全局不被覆盖', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-scope-defaults-'))
  const bundled = join(dir, 'bundled'), legacy = join(dir, 'legacy')
  mkdirSync(bundled); mkdirSync(legacy)
  for (const id of ['dafeiyu', 'dafeiyu-private', 'dafeiyu-group']) {
    writeFileSync(join(bundled, `${id}.persona.json`), JSON.stringify({ format: 'aurabot-persona', version: 1, id, name: id, layers: L(id) }))
  }
  const svc = createPersonaService({ storage: storage(), legacyDir: legacy, bundledDir: bundled })
  const bindings = Object.fromEntries(svc.store.bindings().map((b) => [b.scope, b.personaId]))
  assert.equal(bindings.global, 'dafeiyu', '全局保留基础大肥鱼作兜底')
  assert.equal(bindings['kind:private'], 'dafeiyu-private')
  assert.equal(bindings['kind:group'], 'dafeiyu-group')
  assert.equal(svc.store.resolve('private:1').personaId, 'dafeiyu-private')
  assert.equal(svc.store.resolve('group:1').personaId, 'dafeiyu-group')

  // 用户已经手动绑过群聊默认：升级不能覆盖。
  const s2 = storage(), seed = createPersonaStore({ storage: s2 })
  seed.create({ id: 'custom', name: '自定义', layers: L('自定义'), publish: true })
  seed.bind('kind:group', 'custom')
  const svc2 = createPersonaService({ storage: s2, legacyDir: legacy, bundledDir: bundled })
  const after = Object.fromEntries(svc2.store.bindings().map((b) => [b.scope, b.personaId]))
  assert.equal(after['kind:group'], 'custom')
  assert.equal(after['kind:private'], 'dafeiyu-private')

  // 用户自己换过全局默认（例如旧人格）：整套分卡默认都不落，尊重原设置。
  const s3 = storage(), seed3 = createPersonaStore({ storage: s3 })
  seed3.create({ id: 'old', name: '旧人格', layers: L('旧人格'), publish: true })
  seed3.bind('global', 'old')
  const svc3 = createPersonaService({ storage: s3, legacyDir: legacy, bundledDir: bundled })
  const kept = Object.fromEntries(svc3.store.bindings().map((b) => [b.scope, b.personaId]))
  assert.equal(kept.global, 'old')
  assert.equal(kept['kind:private'], undefined)
  assert.equal(kept['kind:group'], undefined)

  // 用户改过内置大肥鱼（发布了新版本）：也不拿变体顶掉他的版本。
  const s4 = storage(), seed4 = createPersonaStore({ storage: s4 })
  seed4.create({ id: 'dafeiyu', name: '大肥鱼', layers: L('原版'), origin: 'builtin', publish: true })
  let p4 = seed4.get('dafeiyu')
  p4 = seed4.saveDraft('dafeiyu', { layers: L('我改过的') }, { editRevision: p4.editRevision })
  seed4.publish('dafeiyu', { editRevision: p4.editRevision })
  seed4.bind('global', 'dafeiyu')
  const svc4 = createPersonaService({ storage: s4, legacyDir: legacy, bundledDir: bundled })
  const edited = Object.fromEntries(svc4.store.bindings().map((b) => [b.scope, b.personaId]))
  assert.equal(edited['kind:private'], undefined)
  assert.equal(edited['kind:group'], undefined)
})

test('说话风格归人设卡：卡没写用默认，写了以卡为准；旧版整篇卡只补平时习惯；运行规则里不再写死风格', async () => {
  const { DEFAULT_STYLE, DEFAULT_BEHAVIOR } = await import('../src/persona/compiler.js')
  const empty = compilePersona(normalizeLayers({ identity: { name: '小蓝' } }))
  assert.ok(empty.includes(DEFAULT_STYLE) && empty.includes(DEFAULT_BEHAVIOR), '空卡用默认习惯')
  const own = compilePersona(normalizeLayers({ identity: { name: '小蓝' }, behavior: { text: '话少' }, style: { text: '一次一条，十个字以内' } }))
  assert.ok(!own.includes(DEFAULT_STYLE) && !own.includes(DEFAULT_BEHAVIOR), '卡写了就不叠默认')
  const onlyExamples = compilePersona(normalizeLayers({ style: { examples: ['嗯'] } }))
  assert.ok(!onlyExamples.includes(DEFAULT_STYLE), '只有示例也算卡自己定了风格')
  const legacy = compilePersona(normalizeLayers({ legacy: { body: '你是小蓝。' } }))
  assert.ok(legacy.startsWith('你是小蓝。'), '旧卡原文不动')
  assert.ok(legacy.includes(DEFAULT_BEHAVIOR), '旧卡补默认的平时习惯（以前在规则里对所有卡生效）')
  assert.ok(!legacy.includes(DEFAULT_STYLE), '旧卡不补说话长度，原文自己定')
  const legacyOwn = compilePersona(normalizeLayers({ legacy: { body: '你是小蓝。' }, behavior: { text: '话少' } }))
  assert.ok(!legacyOwn.includes(DEFAULT_BEHAVIOR), '旧卡写了分层习惯就不补')
  const { rulesText } = await import('../src/persona/personas.js')
  const { normalize } = await import('../src/core/config.js')
  for (const kind of ['private', 'social']) {
    const r = rulesText(kind, normalize({}))
    for (const s of ['一到三句', '查户口', '撒娇', '私聊里主动一点', '闲聊以自然纯文本']) assert.ok(!r.includes(s), `${kind} 规则不该写死：${s}`)
    assert.ok(r.includes('|||') && r.includes('<poke>'), '协议标记仍在规则里')
  }
})

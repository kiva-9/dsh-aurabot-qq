import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import { loadConfig, mergeFromPanel, normalize, saveConfig } from '../src/core/config.js'

test('旧配置只在内存补默认值，不重写文件；面板保存新设置保留原数值与旧冷却', t => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-sticker-config-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => { if (previous === undefined) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = previous; rmSync(dir, { recursive: true, force: true }) })
  const raw = { botQQ: '100', ownerQQ: '200', stickers: { enabled: true, autoChance: 0.1, cooldownMs: 72000, maxPerHour: 11, maxLibrary: 287 },
    model: { provider: 'global', model: 'chat', reasoningEffort: 'high' }, roles: { vision: { provider: 'v', model: 'vision', reasoningEffort: 'low' } } }
  const original = JSON.stringify(raw, null, 4) + '\n', file = join(dir, 'config.json')
  writeFileSync(file, original)
  const current = loadConfig()
  assert.equal(readFileSync(file, 'utf8'), original)
  assert.equal(current.stickers.autoChance, 0.1)
  assert.deepEqual(['minGapTurns', 'chatCooldownMs', 'sameStickerCooldownMs', 'recentWindowSize', 'candidateCount', 'decisionTimeoutMs'].map(key => current.stickers[key]), [2, 60000, 600000, 6, 20, 15000])
  assert.deepEqual(current.roles.stickerDecision, { provider: '', model: '', reasoningEffort: '' })
  const edited = mergeFromPanel(current, { stickers: { candidateCount: 24, chatCooldownMs: 90000 }, roles: { stickerDecision: { provider: 'p', model: 'visual', reasoningEffort: 'max' } } })
  saveConfig(edited)
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual([saved.stickers.autoChance, saved.stickers.cooldownMs, saved.stickers.maxPerHour, saved.stickers.maxLibrary], [0.1, 72000, 11, 287])
  assert.deepEqual([saved.stickers.candidateCount, saved.stickers.chatCooldownMs], [24, 90000])
  assert.deepEqual(saved.roles.vision, raw.roles.vision)
  assert.deepEqual(saved.roles.stickerDecision, { provider: 'p', model: 'visual', reasoningEffort: 'max' })
  assert.equal(saved.model.reasoningEffort, 'high')
})

test('新配置边界与可选角色归一化兼容旧数据', () => {
  const config = normalize({ stickers: { minGapTurns: -1, chatCooldownMs: -1, sameStickerCooldownMs: 999999999, recentWindowSize: 102, candidateCount: 100, decisionTimeoutMs: 1 },
    roles: { stickerDecision: { provider: 'only-provider' } } })
  assert.deepEqual(['minGapTurns', 'chatCooldownMs', 'sameStickerCooldownMs', 'recentWindowSize', 'candidateCount', 'decisionTimeoutMs'].map(key => config.stickers[key]), [0, 0, 86400000, 100, 32, 1000])
  assert.deepEqual(config.roles.stickerDecision, { provider: '', model: '', reasoningEffort: '' })
  assert.equal(normalize({ stickers: { candidateCount: 0 } }).stickers.candidateCount, 1)
})

test('模型面板可独立选择决策模型及思考强度，视觉角色和其他设置不变', () => {
  const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const code = source.slice(source.indexOf('    const ROLES = ['), source.indexOf('    function Voice('))
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(x => x != null && x !== false) })
  const setPath = (obj, path, value) => { const next = structuredClone(obj), keys = path.split('.'); let target = next; for (const key of keys.slice(0, -1)) target = target[key] ||= {}; target[keys.at(-1)] = value; return next }
  const context = { h, Card: 'Card', Row: 'Row', Select: 'Select', setPath }
  runInNewContext(code + '\nglobalThis.RoleModels=RoleModels', context)
  let draft = normalize({ stickers: { autoChance: 0.1 }, roles: { vision: { provider: 'vision-p', model: 'vision-m', reasoningEffort: 'low' } } })
  const list = [{ provider: 'p', model: 'm', name: '视觉决策模型', vision: true }]
  const render = () => context.RoleModels({ draft, setDraft: value => { draft = value }, list })
  const row = () => render().children.find(node => node.type === 'Row' && node.props.label === '表情发送与选图')
  assert.match(row().props.hint, /留空先用.*识图.*再用全局模型/)
  assert.match(row().children[0].props.options[0].label, /先跟随视觉模型/)
  row().children[0].props.onChange('p::m')
  row().children[1].props.onChange('max')
  assert.deepEqual({ ...draft.roles.stickerDecision }, { provider: 'p', model: 'm', reasoningEffort: 'max' })
  assert.deepEqual(draft.roles.vision, { provider: 'vision-p', model: 'vision-m', reasoningEffort: 'low' })
  assert.equal(draft.stickers.autoChance, 0.1)
  row().children[0].props.onChange('')
  assert.deepEqual({ ...draft.roles.stickerDecision }, { provider: '', model: '', reasoningEffort: '' })
})

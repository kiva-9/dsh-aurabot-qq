import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize, publicConfig, mergeFromPanel, loadConfig } from '../src/core/config.js'

test('normalize tolerates null/array/wrong-type sections instead of crashing', () => {
  for (const key of ['model', 'allow', 'conversation', 'bridge', 'bili', 'voice', 'group', 'memory', 'imageGen']) {
    const c = normalize({ [key]: null })
    assert.equal(typeof c[key], 'object', key)
  }
  const nested = normalize({ voice: { httpApi: null, rvc: null }, imageGen: { quota: null, routing: null } })
  assert.equal(typeof nested.voice.httpApi, 'object')
  assert.equal(typeof nested.voice.rvc, 'object')
  assert.equal(typeof nested.imageGen.quota, 'object')
  assert.equal(typeof nested.imageGen.routing, 'object')
})

test('publicConfig masks an unregistered module secret and mergeFromPanel preserves it', () => {
  const current = normalize({ ext: { weather: { apiKey: 'SECRET123', greet: 'hi' } } })
  const shown = publicConfig(current)
  assert.equal(shown.ext.weather.apiKey, '')
  assert.equal(shown.ext.weather.apiKeySet, true)
  assert.equal(shown.ext.weather.greet, 'hi')
  const saved = mergeFromPanel(current, { ext: { weather: { apiKey: '', greet: 'bye' } } })
  assert.equal(saved.ext.weather.apiKey, 'SECRET123')
  assert.equal(saved.ext.weather.greet, 'bye')
  assert.equal('apiKeySet' in saved.ext.weather, false)
})

test('loadConfig backs up an unreadable JSON file instead of silently overwriting it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-config-bad-'))
  const old = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  try {
    writeFileSync(join(dir, 'config.json'), '{not json')
    assert.throws(() => loadConfig(), (error) => error.code === 'CONFIG_UNREADABLE')
    assert.ok(readdirSync(dir).some((name) => name.startsWith('config.json.bad-')))
  } finally {
    if (old === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = old
  }
})

test('面板保存冲突：三方合并保留别处改动，同字段以自己为准；轮询不刷新草稿基准', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const pick = (name) => {
    const at = src.indexOf(`const ${name} = `)
    assert.ok(at >= 0, `client.js 里找不到 ${name}`)
    const end = src.indexOf('\n    const ', at + 1)
    return src.slice(at, end)
  }
  const factory = new Function(`const clone = (o) => JSON.parse(JSON.stringify(o));${pick('isPlain')};${pick('applyConfigChanges')};return applyConfigChanges`)
  const applyConfigChanges = factory()
  const base = { configRevision: 3, enabled: true, group: { cooldownSec: 90, maxPerHour: 6 }, allow: { groups: ['1'] } }
  const latest = { configRevision: 4, enabled: false, group: { cooldownSec: 90, maxPerHour: 10 }, allow: { groups: ['1'] } }
  const mine = { configRevision: 3, enabled: true, group: { cooldownSec: 120, maxPerHour: 6 }, allow: { groups: ['1', '2'] } }
  const merged = applyConfigChanges(JSON.parse(JSON.stringify(latest)), base, mine)
  assert.equal(merged.enabled, false, '别处关掉的总开关保留')
  assert.equal(merged.group.maxPerHour, 10, '别处改的字段保留')
  assert.equal(merged.group.cooldownSec, 120, '自己改的字段叠上去')
  assert.deepEqual(merged.allow.groups, ['1', '2'], '数组整体替换')
  assert.equal(merged.configRevision, 4)
  // 轮询只在没有未保存改动时才重设基准
  assert.match(src, /if \(!dirtyRef\.current\) \{ setDraft\(clone\(r\.config\)\); rebase\(/)
  assert.match(src, /const expectedRevision = baseRef\.current\.revision/)
})

test('右上角开关直接保存后草稿跟上服务端：关掉试运行不会留下「未保存」的旧草稿再被存回去', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const pick = (name) => {
    const at = src.indexOf(`const ${name} = `)
    assert.ok(at >= 0, `client.js 里找不到 ${name}`)
    return src.slice(at, src.indexOf('\n    const ', at + 1))
  }
  const nextDraftAfterSave = new Function(`const clone = (o) => JSON.parse(JSON.stringify(o));${pick('isPlain')};${pick('applyConfigChanges')};${pick('nextDraftAfterSave')};return nextDraftAfterSave`)()
  // 开关保存：草稿没动过（试运行还是开），保存内容是「服务端配置 + 试运行关」
  const draft = { enabled: true, dryRun: true, group: { cooldownSec: 90 } }
  const saved = { enabled: true, dryRun: false, group: { cooldownSec: 90 }, configRevision: 5 }
  assert.deepEqual(nextDraftAfterSave(draft, draft, saved), saved, '草稿换成保存后的配置，不再显示未保存')
  // 保存期间用户又改了别的字段：保留这次编辑，同时拿到保存结果
  const typed = { enabled: true, dryRun: true, group: { cooldownSec: 150 } }
  const merged = nextDraftAfterSave(typed, draft, saved)
  assert.equal(merged.dryRun, false, '不把开关改回去')
  assert.equal(merged.group.cooldownSec, 150, '保存期间的输入保留')
  assert.match(src, /setDraft\(current => nextDraftAfterSave\(current, startDraft, r\.config\)\)/)
})

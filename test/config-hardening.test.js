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

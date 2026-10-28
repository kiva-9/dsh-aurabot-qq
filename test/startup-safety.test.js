import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/storage/db.js'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { backupLegacy } from '../src/migrate/legacy.js'

test('主库版本不兼容时仅保留诊断，不启动QQ、任务或内存替身', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-startup-'))
  process.env.AURABOT_DATA_DIR = dir
  process.env.AURABOT_WORKSPACE = join(dir, 'ws')
  const db = openDatabase(join(dir, 'aurabot.db')); db.exec('PRAGMA user_version = 999'); db.close()
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ enabled: true, dryRun: false }))
  const fake = createFakeDsh({ brain: async () => '不应运行' })
  const { apply } = await import('../src/host.js')
  const app = apply(fake.ctx)
  assert.equal((await app.ready).ok, false)
  const state = await fake.call('/state')
  assert.equal(state.status, 503); assert.match(state.json().message, /暂停/)
  assert.equal(app.hub, undefined); assert.equal(app.onebot, undefined)
  const check = openDatabase(join(dir, 'aurabot.db')); assert.equal(check.get('PRAGMA user_version').user_version, 999); check.close()
  await fake.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('必要数据备份失败写出不完整清单并中断迁移', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-backup-fail-'))
  mkdirSync(join(dir, 'config.json'))
  assert.throws(() => backupLegacy(dir, { items: [{ name: 'config.json', kind: 'json' }] }, 'test'), /停止迁移/)
  const manifest = JSON.parse(readFileSync(join(dir, '_backup-v2-test', 'manifest.json')))
  assert.equal(manifest.complete, false); assert.equal(manifest.failed.length, 1)
  rmSync(dir, { recursive: true, force: true })
})

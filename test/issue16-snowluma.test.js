import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSnowLumaManager } from '../src/snowluma/manager.js'

test('spawn error is handled and reported without an unhandled error', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'snowluma-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'index.mjs'), '')
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline') })
  const proc = new EventEmitter(); proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter()
  const log = { info() {}, debug() {}, warn() {} }
  const manager = createSnowLumaManager({ getConfig: () => ({ botQQ: '1', snowluma: { dir, webuiPort: 12345, webuiPassword: 'Abcdefgh#9' } }), log,
    spawnImpl: () => { queueMicrotask(() => proc.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))); return proc } })
  const result = await manager.start()
  assert.equal(result.ok, false); assert.match(result.message, /ENOENT/); assert.equal(manager.ownsProcess, false)
})

test('late old child error cannot clear a newer child', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'snowluma-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'index.mjs'), '')
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline') })
  const children = []
  const manager = createSnowLumaManager({ getConfig: () => ({ botQQ: '1', snowluma: { dir, webuiPort: 12345, webuiPassword: 'Abcdefgh#9' } }),
    log: { info() {}, debug() {}, warn() {} }, spawnImpl: () => {
      const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); children.push(p); return p
    } })
  const first = manager.start(), second = manager.start()
  while (children.length < 2) await new Promise(resolve => setImmediate(resolve))
  children[0].emit('error', new Error('old ENOENT'))
  assert.equal(manager.ownsProcess, true)
  children[1].emit('error', new Error('new EACCES'))
  assert.equal((await first).ok, false); assert.equal((await second).ok, false)
  assert.equal(manager.ownsProcess, false)
})

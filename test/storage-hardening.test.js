import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorage } from '../src/storage/index.js'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-storage-hardening-'))
  const storage = createStorage({ file: join(dir, 'test.sqlite'), filesDir: join(dir, 'assets') })
  t.after(() => { storage.close(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, storage }
}

test('requests.create rejects recalled source messages instead of building a reply on them', t => {
  const { storage } = fixture(t)
  const message = storage.messages.ingest({ account: 'bot', chatId: 'group:1', authorId: 'alice', eventKind: 'message', text: '被撤回的话', platformMsgId: 'recalled-1' })
  storage.messages.markRecalled('group:1', 'recalled-1')
  assert.equal(storage.messages.get(message.id).recalledAt === null, false)
  assert.throws(() => storage.requests.create({ chatId: 'group:1', actorId: 'alice', sourceMessageIds: [message.id] }), /撤回/)
})

test('putAsset repairs a missing stored file instead of returning an unreadable row', t => {
  const { storage } = fixture(t)
  const buf = Buffer.from('asset-bytes-for-repair')
  const asset = storage.assets.put(buf, { mime: 'image/png', width: 2, height: 3, sourceKind: 'upload' })
  rmSync(storage.assets.pathOf(asset))
  assert.equal(existsSync(storage.assets.pathOf(asset)), false)
  const repaired = storage.assets.put(buf, { mime: 'image/png', width: 2, height: 3, sourceKind: 'upload' })
  assert.equal(repaired.id, asset.id)
  assert.equal(existsSync(storage.assets.pathOf(repaired)), true)
})

test('putAsset leaves no media file when the database transaction fails', t => {
  const { dir, storage } = fixture(t)
  const buf = Buffer.from('asset-bytes-for-rollback')
  const sha = createHash('sha256').update(buf).digest('hex')
  const originalRun = storage.db.run
  storage.db.run = (sql, ...args) => {
    if (String(sql).startsWith('INSERT INTO assets')) throw new Error('simulated insert failure')
    return originalRun(sql, ...args)
  }
  try {
    assert.throws(() => storage.assets.put(buf, { mime: 'image/png' }), /simulated insert failure/)
  } finally {
    storage.db.run = originalRun
  }
  const files = readdirSync(join(dir, 'assets'), { recursive: true }).map(String)
  assert.ok(files.every((name) => !name.includes(sha)), 'no committed asset file')
  assert.ok(files.every((name) => !name.includes('.tmp-')), 'temporary file cleaned up')
  assert.equal(storage.db.get('SELECT COUNT(*) AS n FROM assets').n, 0)
})

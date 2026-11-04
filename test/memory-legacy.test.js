import { test } from 'node:test'
import assert from 'node:assert/strict'
import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorage } from '../src/storage/index.js'
import { createMemoryStore } from '../src/memory/index.js'

const scope = { account: 'bot', chat: 'group:1', persona: 'fish' }

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-legacy-import-'))
  const storage = createStorage({ file: join(dir, 'test.sqlite'), filesDir: join(dir, 'assets') })
  t.after(() => { storage.close(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, storage, file: join(dir, 'memories.json') }
}

const count = (memory) => memory.unassignedQuarantine({ ...scope, includeUnassigned: true }).length

test('legacy import rescans when file content changes and stays idempotent when unchanged', t => {
  const f = fixture(t)
  writeFileSync(f.file, JSON.stringify([{ text: '旧记忆一' }]))
  const first = createMemoryStore({ storage: f.storage, legacyDir: f.dir })
  assert.equal(count(first), 1)
  assert.equal(first.legacyStatus()[0].state, 'done')
  const firstHash = first.legacyStatus()[0].contentHash
  assert.ok(firstHash)

  writeFileSync(f.file, JSON.stringify([{ text: '旧记忆一' }, { text: '追加的旧记忆二' }]))
  const second = createMemoryStore({ storage: f.storage, legacyDir: f.dir })
  assert.equal(count(second), 2, 'changed file content is imported, not skipped by path hash')
  assert.notEqual(second.legacyStatus()[0].contentHash, firstHash)
  assert.equal(second.legacyStatus()[0].records, 2)

  const third = createMemoryStore({ storage: f.storage, legacyDir: f.dir })
  assert.equal(count(third), 2, 'unchanged content stays idempotent')
  assert.equal(third.legacyStatus()[0].contentHash, second.legacyStatus()[0].contentHash)
})

test('oversized or structurally invalid legacy files report pending instead of crashing startup', t => {
  const f = fixture(t)
  const fd = openSync(f.file, 'w')
  ftruncateSync(fd, 33 * 1024 * 1024)
  closeSync(fd)
  const oversized = createMemoryStore({ storage: f.storage, legacyDir: f.dir })
  assert.equal(oversized.legacyStatus()[0].state, 'pending')
  assert.match(oversized.legacyStatus()[0].error, /32MiB/)

  writeFileSync(f.file, JSON.stringify({ items: 'not-an-array' }))
  const malformed = createMemoryStore({ storage: f.storage, legacyDir: f.dir })
  assert.equal(malformed.legacyStatus()[0].state, 'pending')
  assert.match(malformed.legacyStatus()[0].error, /items/)
  assert.equal(count(malformed), 0)
})

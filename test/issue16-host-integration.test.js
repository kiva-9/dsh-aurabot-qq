import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeLayers } from '../src/persona/store.js'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApprovalNotifier } from '../src/core/approval-notify.js'
import { fileNoticeMessage } from '../src/chat/file-notice.js'
import { openFolder } from '../src/core/open-folder.js'
import { normalize } from '../src/core/config.js'

test('persona RVC persists only explicit overrides', () => {
  assert.equal(normalizeLayers({ voice: { rvc: {} } }).voice.rvc, undefined)
  assert.deepEqual(normalizeLayers({ voice: { rvc: { enabled: false, pitch: 0, timeoutMs: 900000, fallback: 'error', voice: ' own ' } } }).voice.rvc,
    { enabled: false, pitch: 0, timeoutMs: 300000, fallback: 'error', voice: 'own' })
  assert.deepEqual(normalizeLayers({ voice: { rvc: { pitch: '', timeoutMs: null, fallback: 'invalid', enabled: 'true', voice: 'own' } } }).voice.rvc, { voice: 'own' })
})

test('approval notices only concern mapped sessions, deduplicate unknown outcomes and stop on revocation', async () => {
  const cfg = { botQQ: '11', ownerQQ: '22', enabled: true, dryRun: false, approvalNotify: true }
  const sends = []
  const hub = { chatOfSession: id => id === 'known' ? 'group:33' : '', sendText: async (...args) => { sends.push(args); return { unknown: 1 } } }
  const notifier = createApprovalNotifier({ getConfig: () => cfg, hub })
  const event = { type: 'approval/asked', data: { id: 'a', toolName: 'test', reason: 'review' } }
  assert.equal((await notifier.notify({ id: 'unrelated' }, event)).ignored, true)
  await notifier.notify({ id: 'known' }, event)
  assert.equal(sends.length, 1)
  assert.equal(sends[0][0], 'private:22')
  assert.equal((await notifier.notify({ id: 'known' }, event)).duplicate, true)
  cfg.ownerQQ = '44'
  assert.equal(sends[0][3].shouldSend(), false)
  notifier.dispose()
  assert.equal((await notifier.notify({ id: 'known' }, { ...event, data: { id: 'b' } })).ignored, true)
})

test('upload notice has stable transport identity, requires real author and account, preserves source file', () => {
  const event = { post_type: 'notice', notice_type: 'group_upload', self_id: 11, user_id: 22, group_id: 33, file: { id: 'f', name: 'test.txt', size: 4, busid: 102 } }
  const parsed = fileNoticeMessage(event)
  assert.equal(parsed.message_id, fileNoticeMessage({ ...event, time: 123 }).message_id)
  assert.equal(parsed.message_type, 'group')
  assert.equal(parsed.message[0].data.file_id, 'f')
  assert.equal(parsed.sender.user_id, '22')
  assert.equal(fileNoticeMessage({ ...event, user_id: undefined }), null)
  assert.equal(fileNoticeMessage({ ...event, self_id: undefined }), null)
  assert.notEqual(fileNoticeMessage({ ...event, group_id: 44 }).message_id, parsed.message_id)
})

test('folder opener reports async/sync spawn errors and only claims success after spawn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-opener-test-'))
  let child, options, released = false
  const spawnImpl = (_exe, _args, opts) => { options = opts; child = new EventEmitter(); child.unref = () => { released = true }; return child }
  const failure = openFolder(dir, { spawnImpl })
  child.emit('error', new Error('ENOENT'))
  assert.equal((await failure).ok, false)
  assert.equal(released, false)
  assert.equal(options.windowsHide, true)
  const success = openFolder(dir, { spawnImpl })
  child.emit('spawn')
  assert.equal((await success).ok, true)
  assert.equal(released, true)
  assert.equal((await openFolder(dir, { spawnImpl: () => { throw new Error('sync') } })).ok, false)
})

test('new configuration preserves explicit boundaries and normalizes malformed policy records', () => {
  const defaults = normalize({})
  assert.equal(defaults.incomingFiles.enabled, false)
  assert.equal(defaults.group.ignoreAtOthers, true)
  assert.equal(defaults.approvalNotify, false)
  const cfg = normalize({ ignoredSenderQQs: ['123', '123'], crossChatHistory: [{ account: '11', persona: 'p', fromChatId: 'private:22', targetChatId: 'group:33', enabled: true }, { account: '11' }], voice: { rvc: { enabled: true, pitch: 999 } }, speakUp: { targets: ['group:33', '../bad', 'group:33'] } })
  assert.deepEqual(cfg.ignoredSenderQQs, ['123'])
  assert.equal(cfg.crossChatHistory.length, 1)
  assert.deepEqual(cfg.speakUp.targets, ['group:33'])
  assert.equal(cfg.voice.rvc.pitch, 24)
  assert.equal(normalize({ group: { ignoreAtOthers: false } }).group.ignoreAtOthers, false)
})

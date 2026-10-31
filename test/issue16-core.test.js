import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertPublicUrl } from '../src/core/net.js'
import { compareVersions } from '../src/core/update.js'
import { cleanText, clipText, cleanContent } from '../src/core/text.js'
import { createDangerGuard } from '../src/security/danger.js'

test('mapped IPv6 loopback is blocked without connecting', async () => {
  await assert.rejects(assertPublicUrl('http://[::ffff:127.0.0.1]/'))
  await assert.rejects(assertPublicUrl('http://[::ffff:7f00:1]/'))
})
test('semver prerelease precedence and build metadata', () => {
  assert.ok(compareVersions('2.0.0-rc.1', '2.0.0') < 0)
  assert.ok(compareVersions('2.0.0-beta.2', '2.0.0-rc.1') < 0)
  assert.ok(compareVersions('2.0.0-rc.10', '2.0.0-rc.2') > 0)
  assert.equal(compareVersions('2.0.0+one', '2.0.0+two'), 0)
  assert.ok(compareVersions('2.0.0-rc.9007199254740993', '2.0.0-rc.9007199254740992') > 0)
  assert.ok(compareVersions('9007199254740993.0.0', '9007199254740992.0.0') > 0)
})
test('text cleaning preserves evidence and graphemes', () => {
  assert.equal(cleanText('x\ud800y'), 'x�y')
  assert.equal(clipText('x😀', 2), 'x')
  assert.equal(clipText('x👩‍👩‍👧', 4, { graphemes: true }), 'x')
  const input = [{ text: '\ud800' }]; assert.equal(cleanContent(input)[0].text, '�'); assert.equal(input[0].text, '\ud800')
})
test('confirmation is invalid after revocation or dispose', async () => {
  for (const mode of ['disable', 'dispose', 'owner']) {
    const cfg = { ownerQQ: '1', security: { dangerConfirm: true } }
    let calls = 0
    const guard = createDangerGuard({ getConfig: () => cfg, chatOfSession: () => 'private:1', deliver: async () => ({ delivered: 1 }) })
    const result = guard.preExecute({ name: 'bash', arguments: { command: 'shutdown' }, agent: { session: { id: 's' } } }, () => { calls++; return 'ok' })
    await Promise.resolve(); await Promise.resolve()
    assert.equal(guard.handleReply('private:1', '1', '确认'), true)
    if (mode === 'disable') cfg.security.dangerConfirm = false
    if (mode === 'dispose') guard.dispose()
    if (mode === 'owner') cfg.ownerQQ = '2'
    assert.equal((await result).kind, 'deny'); assert.equal(calls, 0)
    guard.dispose()
    assert.equal((await guard.preExecute({ name: 'bash' }, () => 'ok')).kind, 'deny')
  }
})

test('policy invalidation survives disable and re-enable', async () => {
  const cfg = { ownerQQ: '1', security: { dangerConfirm: true } }
  let calls = 0
  const guard = createDangerGuard({ getConfig: () => cfg, chatOfSession: () => 'private:1', deliver: async () => ({ delivered: 1 }) })
  const result = guard.preExecute({ name: 'bash', arguments: { command: 'shutdown' }, agent: { session: { id: 's' } } }, () => { calls++; return 'ok' })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(guard.handleReply('private:1', '1', '确认'), true)
  cfg.security.dangerConfirm = false; guard.invalidate(); cfg.security.dangerConfirm = true
  assert.equal((await result).kind, 'deny'); assert.equal(calls, 0)
})

test('an early confirmation cannot remove the timeout or cancellation while delivery is unresolved', async () => {
  for (const mode of ['timeout', 'abort', 'invalidate', 'dispose']) {
    let sent, calls = 0
    const cfg = { ownerQQ: '1', security: { dangerConfirm: true } }, controller = new AbortController()
    const guard = createDangerGuard({ getConfig: () => cfg, chatOfSession: () => 'private:1', timeoutMs: 20,
      deliver: () => new Promise(resolve => { sent = resolve }) })
    const task = guard.preExecute({ name: 'bash', arguments: { command: 'shutdown' }, signal: controller.signal, agent: { session: { id: 's' } } }, () => { calls++; return 'ok' })
    await Promise.resolve()
    assert.equal(guard.handleReply('private:1', '1', '确认'), true)
    if (mode === 'abort') controller.abort()
    if (mode === 'invalidate') guard.invalidate()
    if (mode === 'dispose') guard.dispose()
    assert.equal((await task).kind, 'deny')
    assert.equal(guard.pendingCount, 0)
    sent({ delivered: 1 }); await Promise.resolve()
    assert.equal(calls, 0)
    guard.dispose()
  }
})

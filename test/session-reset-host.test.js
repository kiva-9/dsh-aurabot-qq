// 面板重开接口：限定聊天、完整校验和旧版全局请求。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { startMockOneBot } from './helpers/mock-onebot.js'

const BOT = '20000002', OWNER = '10000001', OTHER = '30000003', GROUP = '555'
const ownerChat = `private:${OWNER}`, otherChat = `private:${OTHER}`, groupChat = `group:${GROUP}`
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }
const originalEnv = Object.fromEntries(['AURABOT_DATA_DIR', 'AURABOT_WORKSPACE', 'DSH_HOME'].map(key => [key, process.env[key]]))
let root, fake, host, gateway, reader, systemTask
const systemStarted = gate(), systemRelease = gate()
const epoch = chatId => Number(reader.prepare('SELECT epoch FROM chat_epochs WHERE chat_id=?').get(chatId)?.epoch || 0)

async function until(predicate) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('等待会话超时')
}

async function openChat(kind, id) {
  const chatId = `${kind}:${id}`
  const chat = kind === 'private' ? { kind, userId: id, chatId } : { kind, groupId: id, chatId }
  await host.hub.pushToSession(chat, [{ type: 'text', text: `建立 ${chatId}` }], id)
  return host.hub.sessions()[chatId].sessionId
}

// fake.call 对 falsy body 模拟无请求体；此处用真实请求流覆盖 JSON null 等非法值。
async function callRaw(raw) {
  const route = fake.routes.get('/aurabot/api/sessions/reset')
  let response = ''
  const req = { method: 'POST', async *[Symbol.asyncIterator]() { yield raw } }
  const res = { setHeader() {}, end(value) { response = value } }
  await route.handler(req, res)
  return JSON.parse(response)
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'aurabot-session-reset-'))
  process.env.AURABOT_DATA_DIR = root
  process.env.AURABOT_WORKSPACE = join(root, 'workspace')
  process.env.DSH_HOME = join(root, 'dsh')
  gateway = await startMockOneBot({ selfId: BOT })
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    enabled: true, dryRun: true, setupDone: true, botQQ: BOT, ownerQQ: OWNER,
    allow: { private: [OWNER, OTHER], groups: [GROUP] },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: gateway.httpUrl, wsUrl: gateway.wsUrl,
      httpToken: gateway.token, wsToken: gateway.token, dir: join(root, 'snowluma-uninstalled') },
    voice: { enabled: false }, stickers: { enabled: false, collect: false }, speakUp: { enabled: false },
    modules: Object.fromEntries(['stickers', 'voice', 'mood', 'memory', 'learning', 'retrieval', 'search', 'imagegen', 'speakup', 'bili', 'song'].map(id => [id, { enabled: false }])),
  }))
  fake = createFakeDsh({ brain: async ({ text }) => {
    if (text === 'HELD_SYSTEM') { systemStarted.release(); await systemRelease.promise; return '完成' }
    return '[沉默]'
  } })
  host = (await import('../src/host.js')).apply(fake.ctx)
  await host.ready
  reader = new DatabaseSync(join(root, 'aurabot.db'), { readOnly: true })
})

after(async () => {
  systemRelease.release()
  await systemTask?.catch(() => {})
  await fake?.dispose()
  reader?.close()
  await gateway?.close()
  for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  if (root) {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

test('指定聊天重开只影响目标；非法请求原子拒绝；旧全局入口兼容', async t => {
  const ownerSession = await openChat('private', OWNER)
  const otherSession = await openChat('private', OTHER)
  const groupSession = await openChat('group', GROUP)
  systemTask = host.hub.runSystemTurn('held', '测试后台任务', 'HELD_SYSTEM', { noTools: true })
  await systemStarted.promise
  const systemChat = await until(() => Object.keys(host.hub.sessions()).find(id => id.startsWith('system:held:')))
  const systemSession = host.hub.sessions()[systemChat].sessionId
  const chats = [ownerChat, otherChat, groupChat, systemChat]
  const initialSessions = structuredClone(host.hub.sessions())
  const initialEpochs = Object.fromEntries(chats.map(id => [id, epoch(id)]))
  const registry = fake.ctx.workspaceRegistry, initialArchived = [...registry.archivedSessionIds]
  const originalList = registry.list
  registry.list = () => assert.fail('限定重开不能扫描整个工作区')
  t.after(() => { registry.list = originalList; systemRelease.release() })

  await t.test('空数组、非法项和错误请求体均不得执行任何重开', async () => {
    const invalid = [
      { chatIds: [] },
      { chatIds: [ownerChat, 'system:held:123'] },
      { chatIds: [ownerChat, 'group:abc'] },
      { chatIds: [ownerChat, `${groupChat}\n`] },
      { chatIds: [ownerChat, 'private:' + '9'.repeat(33)] },
      { chatIds: [ownerChat, null] },
      { chatIds: ownerChat },
      { chatIds: Array(101).fill(ownerChat) },
      { chatId: ownerChat },
      { chatIds: [ownerChat], unknown: true },
    ]
    for (const body of invalid) {
      const result = (await fake.call('/sessions/reset', body)).json()
      assert.equal(result.ok, false, JSON.stringify(body))
      assert.deepEqual(host.hub.sessions(), initialSessions)
      assert.deepEqual(chats.map(epoch), chats.map(id => initialEpochs[id]))
      assert.deepEqual(registry.archivedSessionIds, initialArchived)
    }
    for (const raw of ['null', '[]', 'false', '"private:10000001"', '{']) {
      assert.equal((await callRaw(raw)).ok, false, raw)
      assert.deepEqual(host.hub.sessions(), initialSessions)
      assert.deepEqual(chats.map(epoch), chats.map(id => initialEpochs[id]))
      assert.deepEqual(registry.archivedSessionIds, initialArchived)
    }
  })

  await t.test('去重后仅重开指定且存在的私聊和群聊', async () => {
    const result = (await fake.call('/sessions/reset', { chatIds: [ownerChat, groupChat, ownerChat, 'private:99999999'] })).json()
    assert.deepEqual(result.chatIds, [ownerChat, groupChat])
    assert.equal(result.count, 2)
    assert.equal(result.ok, true)
    assert.equal(host.hub.sessions()[ownerChat], undefined)
    assert.equal(host.hub.sessions()[groupChat], undefined)
    assert.equal(host.hub.sessions()[otherChat].sessionId, otherSession)
    assert.equal(host.hub.sessions()[systemChat].sessionId, systemSession)
    assert.equal(epoch(ownerChat), initialEpochs[ownerChat] + 1)
    assert.equal(epoch(groupChat), initialEpochs[groupChat] + 1)
    assert.equal(epoch(otherChat), initialEpochs[otherChat])
    assert.equal(epoch(systemChat), initialEpochs[systemChat])
    assert.ok(registry.archivedSessionIds.includes(ownerSession))
    assert.ok(registry.archivedSessionIds.includes(groupSession))
    assert.ok(!registry.archivedSessionIds.includes(otherSession))
    assert.ok(!registry.archivedSessionIds.includes(systemSession))
    assert.equal(fake.agents.get(systemSession).status, 'running')
    registry.list = originalList // 创建新会话时允许正常查找工作区。
    assert.notEqual(await openChat('private', OWNER), ownerSession)
    assert.notEqual(await openChat('group', GROUP), groupSession)
    assert.equal(host.hub.sessions()[otherChat].sessionId, otherSession)
  })

  await t.test('归档接口同步抛错也不会让目标停在半重开状态', async () => {
    const beforeEpoch = epoch(ownerChat)
    const beforeOther = structuredClone(host.hub.sessions()[otherChat])
    const archive = registry.archiveSession
    registry.list = () => assert.fail('限定重开不能扫描整个工作区')
    registry.archiveSession = () => { throw new Error('模拟归档接口同步失败') }
    try {
      const result = (await fake.call('/sessions/reset', { chatIds: [ownerChat] })).json()
      assert.equal(result.ok, true)
      assert.deepEqual(result.chatIds, [ownerChat])
      assert.equal(host.hub.sessions()[ownerChat], undefined)
      assert.equal(epoch(ownerChat), beforeEpoch + 1)
      assert.deepEqual(host.hub.sessions()[otherChat], beforeOther)
      assert.equal(host.hub.sessions()[systemChat].sessionId, systemSession)
    } finally {
      registry.archiveSession = archive
      registry.list = originalList
    }
    await openChat('private', OWNER)
  })

  registry.list = originalList
  systemRelease.release()
  assert.equal(await systemTask, '完成')

  await t.test('旧 UI 的空对象仍全局重开', async () => {
    const result = (await fake.call('/sessions/reset', {})).json()
    assert.equal(result.ok, true)
    assert.ok(result.count >= 3)
    assert.deepEqual(host.hub.sessions(), {})
  })

  await t.test('旧调用的无请求体仍全局重开', async () => {
    await openChat('private', OWNER)
    const result = (await fake.call('/sessions/reset')).json()
    assert.equal(result.ok, true)
    assert.ok(result.count >= 1)
    assert.deepEqual(host.hub.sessions(), {})
  })
})

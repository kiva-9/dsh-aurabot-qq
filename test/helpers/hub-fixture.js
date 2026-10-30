// 只起消息中枢的测试夹具：假 DSH + 内存主库 + 可替换的网关，不启动整个插件。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../../src/core/config.js'
import { createStorage } from '../../src/storage/index.js'
import { createFakeDsh } from './fake-dsh.js'

export const OWNER = '10000001'
export const BOT = '20000002'
export const GROUP = '62001'
const quiet = { info() {}, warn() {}, error() {}, debug() {} }

/** onebot 不传时任何网关调用都算测试失败；responses 可按 action 给假回包。 */
export async function hubFixture(t, { brain = () => '好', config = {}, onebot, ...options } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-hub-fixture-'))
  const prior = { data: process.env.AURABOT_DATA_DIR, workspace: process.env.AURABOT_WORKSPACE }
  process.env.AURABOT_DATA_DIR = join(root, 'data')
  process.env.AURABOT_WORKSPACE = join(root, 'workspace')
  const { createHub } = await import('../../src/chat/hub.js')
  const storage = createStorage({ file: ':memory:', filesDir: join(root, 'assets') })
  const cfg = normalize({ enabled: true, dryRun: false, botQQ: BOT, ownerQQ: OWNER,
    allow: { groups: [GROUP], private: ['30000003'] }, voice: { enabled: false }, stickers: { enabled: false }, ...config })
  const fake = createFakeDsh({ brain })
  const calls = []
  const gateway = onebot || { call: async (action, params) => { calls.push({ action, params }); return { message_id: 1000 + calls.length } } }
  const hub = createHub({ dsh: fake.ctx, storage, getConfig: () => cfg, onebot: gateway, log: quiet, ...options })
  fake.ctx.on('session/event', hub.onSessionEvent)
  t.after(async () => {
    await hub.dispose(); await fake.dispose(); storage.close()
    for (const [key, value] of [['AURABOT_DATA_DIR', prior.data], ['AURABOT_WORKSPACE', prior.workspace]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  })
  return { hub, fake, cfg, storage, root, calls }
}

export const privateChat = (userId = OWNER) => ({ kind: 'private', userId, chatId: `private:${userId}`, nickname: 'n' })
export const groupChat = (groupId = GROUP) => ({ kind: 'group', groupId, chatId: `group:${groupId}` })
export const until = async (fn, ms = 4000) => {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const value = await fn()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('等不到条件成立')
}

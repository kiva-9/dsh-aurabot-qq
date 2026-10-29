import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { startMockOneBot } from './helpers/mock-onebot.js'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async predicate => { const end = Date.now() + 8000; while (!predicate()) { if (Date.now() > end) throw Error('timeout'); await sleep(20) } }

test('host: pure @, image and question remain one scoped task; later unmentioned question bypasses automatic cooldown', async t => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-followup-')), before = { data: process.env.AURABOT_DATA_DIR, workspace: process.env.AURABOT_WORKSPACE }
  process.env.AURABOT_DATA_DIR = root; process.env.AURABOT_WORKSPACE = join(root, 'workspace')
  const bot = '20000002', owner = '10000001', group = '62001', member = 30000003
  const mock = await startMockOneBot({ selfId: bot })
  writeFileSync(join(root, 'config.json'), JSON.stringify({ enabled: true, dryRun: false, setupDone: true, botQQ: bot, ownerQQ: owner,
    allow: { groups: [group], private: [] }, model: { provider: 'p', model: 'vision', vision: 'on' },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token, dir: join(root, 'none') },
    merge: { enabled: true, groupWaitSec: 0.3, groupMaxSec: 2, mentionWaitSec: 0.05 }, group: { interjectChance: 0, cooldownSec: 600 },
    voice: { enabled: false }, stickers: { enabled: false, collect: false }, memory: { enabled: false }, learning: { enabled: false }, speakUp: { enabled: false },
    modules: Object.fromEntries(['stickers','voice','mood','memory','learning','retrieval','search','imagegen','speakup','bili','song'].map(id => [id, { enabled: false }])) }))
  const observed = []
  const fake = createFakeDsh({ brain: async input => { observed.push(input); return '收到，正在核对这张截图。' } })
  fake.ctx.tools.register({ name: 'terminal_send', execute: () => { throw Error('desktop tool leaked') } })
  const host = (await import('../src/host.js')).apply(fake.ctx); await host.ready
  t.after(async () => {
    await fake.dispose(); await mock.close()
    for (const [key, value] of [['AURABOT_DATA_DIR', before.data], ['AURABOT_WORKSPACE', before.workspace]]) if (value === undefined) delete process.env[key]; else process.env[key] = value
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.match(root, /aurabot-followup-/)
    rmSync(root, { recursive: true, force: true })
  })
  const push = (id, segments) => host.hub.onMessage({ post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: Number(group), self_id: Number(bot), user_id: member, message_id: id,
    sender: { user_id: member, nickname: '测试群友', role: 'member' }, message: segments })
  const png = Buffer.alloc(64); png.set([0x89,0x50,0x4e,0x47]); png[7] = 10; png.writeUInt32BE(64,16); png.writeUInt32BE(64,20)
  await push(1, [{ type: 'at', data: { qq: bot } }]); await sleep(100)
  await push(2, [{ type: 'image', data: { sub_type: 0, file: 'base64://' + png.toString('base64') } }])
  await push(3, [{ type: 'text', data: { text: '为什么任务管理器找不到进程' } }])
  await until(() => fake.turns.length === 1)
  assert.equal(observed[0].images.length, 1)
  assert.match(observed[0].text, /为什么任务管理器找不到进程/)
  assert.equal(observed[0].toolNames.includes('terminal_send'), false)
  assert.equal(observed[0].agent.runtimeSuppressed, true)
  await until(() => mock.sent('send_group_msg').length > 0)
  await push(4, [{ type: 'text', data: { text: '那上面这张图里的进程为什么不显示？' } }])
  await until(() => fake.turns.length === 2)
  assert.equal(observed[1].images.length, 1, 'unambiguous same-author previous image is restored')
  assert.match(observed[1].text, /进程为什么不显示/)
  const ds = (await fake.call('/diagnostics/decisions?chatId=group:' + group)).json().list
  assert.equal(ds[0].decision.mode, 'must')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSpeakUp } from '../src/features/companion.js'
import { normalize } from '../src/core/config.js'

const min = 60000
function setup(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-speakup-contract-'))
  process.env.AURABOT_DATA_DIR = dir
  let time = new Date(2026, 9, 28, 12).getTime(), epoch = 0, persona = 'fish', muted = false
  const cfg = normalize({ enabled: true, dryRun: false, botQQ: '90000001', ownerQQ: '10000001',
    speakUp: { enabled: true, awakeFrom: 0, awakeTo: 24, minIntervalMinutes: 5, maxIntervalMinutes: 5, maxPerDay: 2, ...overrides } })
  const queued = [], reads = [], scope = () => ({ account: cfg.botQQ, chat: 'private:' + cfg.ownerQQ, persona })
  const hub = { lastOwnerChatAt: time - 120 * min, lastChatAt: time,
    lastBotToOwner: { at: time - 120 * min, text: '晚安' },
    scopeFor: () => scope(), personaFor: () => ({ personaId: persona, layers: { identity: { name: '鱼' } } }),
    pushToSession: () => assert.fail('禁止直推会话绕过调度'),
    enqueueProactive: async (event) => { queued.push(event); return { accepted: true, eventId: event.eventId } } }
  const memory = {
    list: (o) => { reads.push(o); return [{ scope: o.scope, text: '只在主人私聊可见' }, { scope: { ...o.scope, chat: 'group:22' }, text: 'GROUP_SECRET' }] },
    recentEvents: (o) => { reads.push(o); return [{ scope: o.scope, text: '真实送达经历', sourceId: 'qq:1' }, { scope: { ...o.scope, persona: 'other' }, text: 'OTHER_PERSONA' }] },
    addEvent: () => assert.fail('排队不能记成已经送达'),
  }
  const deps = { getConfig: () => cfg, hub, memory, storage: { epochs: { current: () => epoch } },
    now: () => time, random: () => 0.1, isMuted: () => muted, log: {} }
  const services = [], create = () => { const s = createSpeakUp(deps); services.push(s); return s }
  const s = create()
  t.after(() => { services.forEach((x) => x.stop()); rmSync(dir, { recursive: true, force: true }) })
  return { s, create, cfg, hub, queued, reads, memory, scope, advance: (ms) => { time += ms }, now: () => time,
    bump: () => epoch++, persona: (p) => { persona = p }, mute: (v) => { muted = v } }
}

test('群里热闹不影响主人私聊：统一主动事件，显式范围，不串群/角色记忆', async (t) => {
  const f = setup(t)
  await f.s.tick(); assert.equal(f.queued.length, 0)
  f.advance(5 * min + 1); await f.s.tick()
  assert.equal(f.queued.length, 1)
  const e = f.queued[0]
  assert.equal(e.chatId, 'private:10000001')
  assert.deepEqual(e.scope, f.scope())
  assert.deepEqual(f.reads.map((o) => o.scope), [{ ...f.scope(), persona: '' }, f.scope()])
  assert.match(e.prompt, /系统主动事件/)
  assert.match(e.prompt, /真实送达经历/)
  assert.doesNotMatch(e.prompt, /GROUP_SECRET|OTHER_PERSONA|编也行/)
  assert.equal(e.shouldSend(), true)
  f.bump(); assert.equal(e.shouldSend(), false); assert.equal(e.signal.aborted, true)
})

test('手动、定时、追问共用每日预算与冷却，重启/换角色不能重置预算', async (t) => {
  const f = setup(t)
  assert.equal((await f.s.fire()).accepted, true)
  assert.equal((await f.s.fire()).code, 'COOLDOWN')
  f.advance(5 * min); f.persona('other')
  assert.equal((await f.s.fire()).accepted, true)
  f.advance(5 * min)
  const s2 = f.create()
  assert.equal((await s2.fire()).code, 'BUDGET_EXHAUSTED')
  assert.equal(f.queued.length, 2)
  assert.equal(s2.state().count, 2)
})

test('安静时段、静音、总开关、试运行、模块停用全部约束手动入口', async (t) => {
  const f = setup(t)
  for (const key of ['enabled', 'dryRun', 'module', 'quiet', 'muted']) {
    f.cfg.enabled = key !== 'enabled'; f.cfg.dryRun = key === 'dryRun'
    f.cfg.modules.speakup = { enabled: key !== 'module' }
    f.cfg.speakUp.awakeFrom = key === 'quiet' ? 14 : 0
    f.mute(key === 'muted')
    assert.equal((await f.s.fire()).code, 'QUIET_OR_DISABLED', key)
  }
  assert.equal(f.queued.length, 0)
  assert.equal(f.s.state().count, 0)
})

test('跨午夜活动窗口可用；排队后的静音/stop 都使 guard 永久失效', async (t) => {
  const f = setup(t, { awakeFrom: 22, awakeTo: 6 })
  f.advance(11 * 60 * min)
  assert.equal((await f.s.fire()).ok, true)
  const first = f.queued[0]
  f.mute(true); assert.equal(first.shouldSend(), false)
  f.mute(false); assert.equal(first.shouldSend(), false)
  f.advance(5 * min); assert.equal((await f.s.fire()).ok, true)
  f.s.stop(); assert.equal(f.queued[1].shouldSend(), false)
})

test('追问只引用当前角色有回执的话，每句一次并占预算', async (t) => {
  const f = setup(t, { idleMinutes: 600, maxPerDay: 1 })
  f.hub.lastOwnerChatAt = f.now() - 25 * min
  f.hub.lastBotToOwner = { at: f.now() - 20 * min, text: '你去哪玩了？', scope: f.scope(), message_id: 'real-1' }
  await f.s.tick(); await f.s.tick()
  assert.equal(f.queued.length, 1)
  assert.match(f.queued[0].prompt, /追一句/)
  assert.equal(f.s.state().count, 1)
})

test('无 scope 或回执的 lastBotToOwner 不得当作本角色的追问素材', async (t) => {
  const f = setup(t, { idleMinutes: 600 })
  f.hub.lastOwnerChatAt = f.now() - 25 * min
  f.hub.lastBotToOwner = { at: f.now() - 20 * min, text: 'OLD_PERSONA_SECRET？' }
  await f.s.tick(); assert.equal(f.queued.length, 0)
  assert.equal((await f.s.fire('追问', { nudge: true })).code, 'NUDGE_UNAVAILABLE')
})

test('调度未接通明确不可用；enqueue 不确定也保留预算、不自动重排', async (t) => {
  const f = setup(t)
  delete f.hub.enqueueProactive
  assert.equal((await f.s.fire()).code, 'SCHEDULER_UNAVAILABLE')
  assert.equal(f.s.state().count, 0)
  f.hub.enqueueProactive = async (e) => { f.queued.push(e); throw new Error('连接中断') }
  assert.equal((await f.s.fire()).code, 'ENQUEUE_UNKNOWN')
  await f.s.tick()
  assert.equal(f.s.state().events[0].state, 'unknown')
  assert.equal(f.queued.length, 1)
})

test('explicit targets remain scoped and revocation cancels queued work', async t => {
  const f = setup(t)
  f.cfg.speakUp.targets = ['group:22']
  f.cfg.allow.groups.push('22')
  f.hub.scopeFor = chat => ({ account: f.cfg.botQQ, chat, persona: 'fish' })
  assert.equal((await f.s.fire('manual', { target: 'private:10000001' })).code, 'SCOPE_REQUIRED')
  assert.equal((await f.s.fire('manual', { target: 'group:22' })).accepted, true)
  assert.equal(f.queued[0].chatId, 'group:22')
  assert.equal(f.queued[0].shouldSend(), true)
  f.cfg.speakUp.targets = ['private:10000001']
  assert.equal(f.queued[0].shouldSend(), false)
})

// 会话调度：连发合并、上限、@ 缩短、纯表情不延长、等图片、忙时排队且不再延长、私聊插话。用可控的假时钟。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createScheduler } from '../src/runtime/scheduler.js'

function fakeTimers() {
  let now = 0
  let seq = 0
  const pending = new Map()
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; pending.set(id, { at: now + ms, fn }); return id },
    clearTimeout: (id) => pending.delete(id),
    /** 时间往前走 ms，期间到点的定时器按顺序触发 */
    advance(ms) {
      const end = now + ms
      for (;;) {
        const next = [...pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        pending.delete(next[0])
        now = next[1].at
        next[1].fn()
      }
      now = end
    },
  }
}

const S = { enabled: true, waitMs: 2000, maxMs: 5000, mentionWaitMs: 800, mediaExtraMs: 3000 }
const flushMicro = () => new Promise((r) => setImmediate(r))

function setup({ settings = S, steerable = false, media = new Set() } = {}) {
  const timers = fakeTimers()
  const runs = []
  const sch = createScheduler({
    timers,
    settings: () => settings,
    canSteer: () => steerable,
    mediaReady: (e) => !media.has(e.messageId),
    dispatch: async (chat, batch, info) => { runs.push({ at: timers.now(), ids: batch.entries.map((e) => e.messageId), steer: info.steer, mode: batch.mode, mediaTimedOut: batch.mediaTimedOut }) },
  })
  return { timers, runs, sch, media }
}
const pm = { chatId: 'private:1', kind: 'private' }
const gp = { chatId: 'group:9', kind: 'group' }
const msg = (id, extra = {}) => ({ messageId: id, actorId: '1', mode: 'must', ...extra })

test('连发：停顿够了一起交；一直说也不超过上限', async () => {
  const { timers, runs, sch } = setup()
  sch.add(pm, msg('a'))
  timers.advance(1500)
  sch.add(pm, msg('b'))
  timers.advance(1999)
  assert.equal(runs.length, 0)
  timers.advance(1)
  await flushMicro()
  assert.deepEqual(runs[0].ids, ['a', 'b'])
  assert.equal(runs[0].at, 3500)

  sch.turnEnded(pm.chatId)
  for (let i = 0; i < 6; i++) { sch.add(pm, msg('c' + i)); timers.advance(1000); await flushMicro() }
  await flushMicro()
  assert.equal(runs.length, 2)
  assert.equal(runs[1].at, 3500 + 5000, '从第一条起最多等 5 秒')
})

test('被 @ 等得短；纯表情不延长已经开着的这一批', async () => {
  const { timers, runs, sch } = setup()
  sch.add(gp, msg('a', { mentioned: true }))
  timers.advance(800)
  await flushMicro()
  assert.equal(runs.length, 1, '@ 了只等 0.8 秒')
  sch.turnEnded(gp.chatId)
  sch.add(gp, msg('b'))
  timers.advance(1500)
  sch.add(gp, msg('s', { stickerOnly: true }))
  timers.advance(500)
  await flushMicro()
  assert.deepEqual(runs[1].ids, ['b', 's'], '表情并进去了，但没把停顿重新计时')
})

test('图片还没下载好：多等，下载好且停顿够了马上交；一直下不来到硬上限也交，并标出来', async () => {
  const { timers, runs, sch, media } = setup({ media: new Set(['img']) })
  sch.add(pm, msg('img'))
  timers.advance(5000)
  assert.equal(runs.length, 0, '图片没好，超过普通上限也先等')
  media.delete('img')
  sch.mediaSettled(pm.chatId)
  await flushMicro()
  assert.equal(runs.length, 1)
  assert.equal(runs[0].mediaTimedOut, false)
  sch.turnEnded(pm.chatId)
  media.add('img2')
  sch.add(pm, msg('img2'))
  timers.advance(8000)
  await flushMicro()
  assert.equal(runs[1].mediaTimedOut, true, '到硬上限还没好：交出去并标明')
})

test('她还在回上一批：到期的这批排着，后来的另开一批不会把它拖长；回完一起交', async () => {
  const { timers, runs, sch } = setup()
  sch.add(gp, msg('a'))
  timers.advance(2000)
  await flushMicro()
  assert.equal(runs.length, 1)
  sch.add(gp, msg('b'))
  timers.advance(2000)
  assert.equal(sch.state(gp.chatId).ready, 1, 'b 到期了，排着')
  sch.add(gp, msg('c'))
  timers.advance(1000)
  assert.equal(sch.state(gp.chatId).ready, 1, 'c 另开一批，没并进已到期的 b')
  sch.turnEnded(gp.chatId)
  await flushMicro()
  assert.deepEqual(runs[1].ids, ['b'], '回完先交已到期的，不为了等 c 再拖')
  timers.advance(1000)
  sch.turnEnded(gp.chatId)
  await flushMicro()
  assert.deepEqual(runs[2].ids, ['c'])
})

test('私聊：她这一轮还在跑，到期的话直接插进去；群聊不插', async () => {
  const p = setup({ steerable: true })
  p.sch.add(pm, msg('a'))
  p.timers.advance(2000)
  p.sch.add(pm, msg('b'))
  p.timers.advance(2000)
  await flushMicro()
  assert.deepEqual(p.runs.map((r) => r.steer), [false, true])
  const g = setup({ steerable: true })
  g.sch.add(gp, msg('a'))
  g.timers.advance(2000)
  g.sch.add(gp, msg('b'))
  g.timers.advance(2000)
  await flushMicro()
  assert.equal(g.runs.length, 1)
})

test('只当上下文的消息：没有开着的批次就不触发；有就并进去但不延长', async () => {
  const { timers, runs, sch } = setup()
  assert.equal(sch.add(gp, msg('x', { mode: 'context' })), false)
  timers.advance(10_000)
  assert.equal(runs.length, 0)
  sch.add(gp, msg('a', { mode: 'interject' }))
  timers.advance(1500)
  sch.add(gp, msg('ctx', { mode: 'context' }))
  timers.advance(500)
  await flushMicro()
  assert.deepEqual(runs[0].ids, ['a', 'ctx'])
  assert.equal(runs[0].mode, 'interject')
})

test('关掉合并：每条马上交；交接失败也会放开', async () => {
  const timers = fakeTimers()
  let n = 0
  const sch = createScheduler({ timers, settings: () => ({ ...S, enabled: false }), dispatch: async () => { n++; throw new Error('boom') } })
  sch.add(pm, msg('a'))
  timers.advance(0)
  await flushMicro()
  await flushMicro()
  assert.equal(n, 1)
  assert.equal(sch.isBusy(pm.chatId), false, '失败后不卡住')
})

test('关掉合并时图片没下载好也照样等一会儿', async () => {
  const media = new Set(['img'])
  const { timers, runs, sch } = setup({ settings: { ...S, enabled: false }, media })
  sch.add(pm, msg('img'))
  timers.advance(0)
  await flushMicro()
  assert.equal(runs.length, 0, '图片没好不交')
  media.delete('img')
  sch.mediaSettled(pm.chatId)
  await flushMicro()
  assert.equal(runs.length, 1)
})

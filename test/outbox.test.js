// 发送记录：按顺序发、每段回执、没发出去才重试、可能已送达的不重发、代次变了作废、重启恢复。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorage } from '../src/storage/index.js'
import { createOutbox } from '../src/delivery/outbox.js'
import { OneBotError } from '../src/onebot/client.js'

const storage = () => createStorage({ file: ':memory:', filesDir: join(mkdtempSync(join(tmpdir(), 'aurabot-ob-')), 'assets') })
const text = (t) => ({ kind: 'text', message: [{ type: 'text', data: { text: t } }], note: t })
const fail = (outcome) => { throw new OneBotError('send_group_msg', { message: outcome }, outcome) }

function gateway(script = {}) {
  const sent = []
  let id = 100
  return {
    sent,
    send: async (chatId, message) => {
      const t = message[0].data.text
      const plan = script[t]
      if (plan && plan.length) {
        const step = plan.shift()
        if (step !== 'ok') fail(step)
      }
      sent.push({ chatId, text: t })
      return { message_id: ++id }
    },
  }
}

test('按顺序发，每段记下 QQ 消息 ID', async () => {
  const s = storage()
  const g = gateway()
  const ob = createOutbox({ storage: s, send: g.send, sleep: async () => {} })
  const b = ob.enqueue({ chatId: 'group:1', items: [text('一'), text('二'), text('三')] })
  const r = await ob.deliver(b)
  assert.deepEqual(g.sent.map((x) => x.text), ['一', '二', '三'])
  assert.equal(r.delivered, 3)
  assert.deepEqual(r.messageIds, ['101', '102', '103'])
  const again = await ob.deliver(b)
  assert.equal(g.sent.length, 3, '发过的不再发')
  assert.equal(again.delivered, 3)
})

test('没发出去（没连上）才重试；网关拒绝记失败；超时记「不确定」不重发，后面的段照常发', async () => {
  const s = storage()
  const g = gateway({ 一: ['not_sent', 'ok'], 二: ['rejected'], 三: ['unknown'] })
  const ob = createOutbox({ storage: s, send: g.send, sleep: async () => {} })
  const b = ob.enqueue({ chatId: 'group:1', items: [text('一'), text('二'), text('三'), text('四')] })
  const r = await ob.deliver(b)
  assert.deepEqual(g.sent.map((x) => x.text), ['一', '四'])
  assert.equal(r.delivered, 2)
  assert.equal(r.failed, 1)
  assert.equal(r.unknown, 1)
  const rows = ob.rows(b)
  assert.equal(rows[0].attempts, 2, '没发出去的重试了一次')
  assert.equal(rows[2].attempts, 1, '可能已送达的不重发')
})

test('没发出去一直重试不成：重试用完记失败', async () => {
  const s = storage()
  const g = gateway({ 一: ['not_sent', 'not_sent', 'not_sent', 'not_sent'] })
  const ob = createOutbox({ storage: s, send: g.send, sleep: async () => {}, retries: 2 })
  const r = await ob.deliver(ob.enqueue({ chatId: 'private:1', items: [text('一')] }))
  assert.equal(r.failed, 1)
  assert.equal(g.sent.length, 0)
})

test('代次变了：上一个角色没发完的话作废', async () => {
  const s = storage()
  const g = gateway()
  const ob = createOutbox({ storage: s, send: g.send, sleep: async () => {} })
  const b = ob.enqueue({ chatId: 'group:1', items: [text('旧角色的话')] })
  s.epochs.bump('group:1', '换人设')
  const r = await ob.deliver(b)
  assert.equal(r.canceled, 1)
  assert.equal(g.sent.length, 0)
})

test('按设置不发（试运行）记 skipped；同一批并发调用只发一遍', async () => {
  const s = storage()
  let n = 0
  const ob = createOutbox({ storage: s, send: async () => { n++; return null }, sleep: async () => {} })
  const b = ob.enqueue({ chatId: 'group:1', items: [text('a')] })
  const [r1, r2] = await Promise.all([ob.deliver(b), ob.deliver(b)])
  assert.equal(n, 1)
  assert.equal(r1.skipped, 1)
  assert.equal(r2.skipped, 1)
})

test('重启恢复：停在发送中的记不确定；新积压的接着发，太旧的作废', async () => {
  const s = storage()
  let clock = 1_000_000
  const g = gateway()
  const ob = createOutbox({ storage: s, send: g.send, sleep: async () => {}, now: () => clock })
  const old = ob.enqueue({ chatId: 'group:1', items: [text('老的')] })
  clock += 5 * 60_000
  const fresh = ob.enqueue({ chatId: 'group:1', items: [text('新的')] })
  const stuck = ob.enqueue({ chatId: 'group:2', items: [text('发到一半')] })
  s.db.run("UPDATE outbox SET state = 'sending' WHERE batch_id = ?", stuck)
  const r = await ob.recover({ maxAgeMs: 2 * 60_000 })
  assert.deepEqual(r, { stuck: 1, stale: 1, resumed: 1 })
  assert.deepEqual(g.sent.map((x) => x.text), ['新的'])
  assert.equal(ob.summary(old).canceled, 1)
  assert.equal(ob.summary(fresh).delivered, 1)
  assert.equal(ob.summary(stuck).unknown, 1)
})

test('段间停顿：第一段不等，后面按 delayMs 等', async () => {
  const s = storage()
  const waits = []
  const ob = createOutbox({ storage: s, send: gateway().send, sleep: async (ms) => { waits.push(ms) } })
  await ob.deliver(ob.enqueue({ chatId: 'group:1', items: [{ ...text('a'), delayMs: 500 }, { ...text('b'), delayMs: 800 }] }))
  assert.deepEqual(waits, [800])
})

// Replyer：只在配了模型时改写；标记必须原样保留；改写失败或不合格就用原文。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acceptRewrite, marksOf, rewriteReply } from '../src/chat/replyer.js'
import { normalizeLayers } from '../src/persona/store.js'

test('标记：语音、表情、引用、戳一戳都认得出来', () => {
  assert.deepEqual(marksOf('<reply:3>好呀<voice>晚安</voice><sticker:开心><poke>'), ['<reply:3>', '<voice>', '</voice>', '<sticker:开心>', '<poke>'])
})

test('改写检查：标记少了、多了、换了顺序、空的、长出一大截都不收', () => {
  const o = '<reply:2>行 我去画<sticker:开心>'
  assert.equal(acceptRewrite(o, '<reply:2>好嘞 这就去画<sticker:开心>'), true)
  assert.equal(acceptRewrite(o, '好嘞 这就去画<sticker:开心>'), false, '引用丢了')
  assert.equal(acceptRewrite(o, '<reply:2>好嘞<sticker:开心><poke>'), false, '多了戳一戳')
  assert.equal(acceptRewrite(o, '<sticker:开心><reply:2>好嘞'), false, '顺序变了')
  assert.equal(acceptRewrite(o, '   '), false)
  assert.equal(acceptRewrite('嗯', 'x'.repeat(200)), false)
})

test('改写：带上人设正文；模型出错或结果不合格就用原文；沉默不改', async () => {
  const persona = { personaId: 'lan', layers: normalizeLayers({ identity: { name: '小蓝', core: '冷淡' } }) }
  let seen = null
  const ok = await rewriteReply('好的，我明白了。', { persona, ask: async (o) => { seen = o; return '哦 知道了' } })
  assert.deepEqual(ok, { text: '哦 知道了', rewritten: true })
  assert.equal(seen.role, 'replyer')
  assert.match(seen.system, /小蓝/)
  const bad = await rewriteReply('<voice>晚安</voice>', { persona, ask: async () => '晚安' })
  assert.equal(bad.rewritten, false)
  assert.equal(bad.text, '<voice>晚安</voice>')
  const err = await rewriteReply('在呢', { persona, ask: async () => { throw new Error('超时') } })
  assert.deepEqual([err.text, err.rewritten, err.reason], ['在呢', false, '超时'])
  let called = false
  await rewriteReply('[沉默]', { persona, ask: async () => { called = true; return 'x' } })
  assert.equal(called, false)
})

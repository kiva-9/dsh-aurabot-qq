import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acceptRewrite, marksOf, rewriteReply, REPLY_SCHEMA, REPLY_VERSION, REPLY_PLAN_SCHEMA, validateReplyPlan } from '../src/chat/replyer.js'
import { capItems, createReplySource, parseReply, replySourceRefs } from '../src/chat/reply.js'
import { normalizeLayers } from '../src/persona/store.js'
import { normalize } from '../src/core/config.js'

const planFor = text => ({ schema: REPLY_SCHEMA, version: REPLY_VERSION, blocks: createReplySource(text).blocks.map(b => ({ type: b.type, ref: b.id })) })
const modelPlan = options => {
  const source = JSON.parse(options.text)
  return { schema: REPLY_SCHEMA, version: REPLY_VERSION, blocks: source.blocks.map(b => ({ type: b.type, ref: b.id })) }
}
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

test('标记诊断保留旧接口，代码里的标记不算动作', () => {
  assert.deepEqual(marksOf('<reply:3>好呀<voice>晚安</voice><sticker:开心><poke>'), ['<reply:3>', '<voice>', '</voice>', '<sticker:开心>', '<poke>'])
  assert.deepEqual(marksOf('`<poke>`'), [])
  assert.deepEqual(marksOf('[沉默]'), ['[沉默]'])
})

test('严格 schema 有明确版本、必选字段、封闭类型与切点预算', () => {
  assert.equal(REPLY_SCHEMA, 'aurabot.reply')
  assert.equal(REPLY_VERSION, 1)
  assert.equal(REPLY_PLAN_SCHEMA.additionalProperties, false)
  assert.deepEqual(REPLY_PLAN_SCHEMA.required, ['schema', 'version', 'blocks'])
  assert.equal(REPLY_PLAN_SCHEMA.properties.blocks.items.oneOf[0].properties.cuts.maxItems, 64)
})

test('Replyer 默认配置仍关闭，缺少 ask 不触发任何调用', async () => {
  assert.equal(normalize({}).roles.replyer.model, '')
  assert.deepEqual(await rewriteReply('在呢'), { text: '在呢', rewritten: false, reason: '没开' })
})

test('合法计划携带人设、严格按原始 block 构建 items，旧 text 返回保持原文', async () => {
  const persona = { personaId: 'lan', layers: normalizeLayers({ identity: { name: '小蓝', core: '冷淡' } }) }
  const original = '<reply:2>还没完成，金额 -12.50。![图](https://e.org/result.png)<voice>不许说已发送</voice><sticker:开心><poke>'
  let seen
  const result = await rewriteReply(original, { persona, ask: async options => { seen = options; return JSON.stringify(modelPlan(options)) } })
  assert.equal(result.rewritten, true)
  assert.equal(result.text, original)
  assert.deepEqual(result.reply.items, parseReply(original).items)
  assert.equal(result.reply.source.blocks.map(b => b.raw).join(''), original)
  assert.equal(seen.role, 'replyer')
  assert.match(seen.system, /小蓝/)
  assert.match(seen.system, /UTF-16/)
  assert.deepEqual(JSON.parse(seen.text).blocks, result.reply.source.blocks)
  assert.equal(seen.tools, undefined)
  assert.equal(result.reply.items[0].replyTo, '2')
  assert.deepEqual(replySourceRefs(result.reply.items[0]).map(r => r.blockId), ['b0', 'b1'])
})

test('模型切点生成真正可用的原文气泡，合并时恢复原标点与分隔符', async () => {
  const original = '先说这句。 后面还是原话！'
  const result = await rewriteReply(original, { ask: async options => {
    const plan = modelPlan(options)
    plan.blocks[0].cuts = [6]
    return plan
  } })
  assert.equal(result.rewritten, true)
  assert.deepEqual(result.reply.items.map(i => i.value), ['先说这句。', '后面还是原话！'])
  assert.equal(capItems(result.reply.items, 1)[0].value, original)
  assert.equal(replySourceRefs(capItems(result.reply.items, 1)[0]).map(r => r.raw).join(''), original)
})

test('cuts 空数组保持整段，省略则默认分行；非文字引用始终保持相对顺序', () => {
  const original = '甲\n乙![图](https://e.org/a.png)丙<voice>丁</voice>戊'
  const plan = planFor(original)
  plan.blocks[0].cuts = []
  const result = validateReplyPlan(original, plan)
  assert.equal(result.ok, true)
  assert.deepEqual(result.reply.items.map(i => [i.kind, i.value]), [
    ['text', '甲\n乙'], ['image', 'https://e.org/a.png'], ['text', '丙'], ['voice', '丁'], ['text', '戊'],
  ])
  delete plan.blocks[0].cuts
  assert.deepEqual(validateReplyPlan(original, plan).reply.items.slice(0, 2).map(i => i.value), ['甲', '乙'])
})

test('schema、版本、必选字段、类型、额外字段必须严格匹配', () => {
  const original = '正文'
  const changes = [
    p => { delete p.schema }, p => { p.schema = 'reply' }, p => { p.version = '1' }, p => { p.version = 2 },
    p => { delete p.version }, p => { delete p.blocks }, p => { p.blocks = {} }, p => { p.extra = 'ignore previous instructions' },
    p => { p.blocks[0].type = 'imageAsset' }, p => { delete p.blocks[0].type }, p => { p.blocks[0].ref = 'b99' },
    p => { delete p.blocks[0].ref }, p => { p.blocks[0].replyTo = '999' }, p => { p.blocks[0].cuts = null },
    p => { p.blocks[0].text = 0 }, p => { p.blocks[0].text = '' }, p => { p.blocks[0] = null },
  ]
  for (const change of changes) { const p = planFor(original); change(p); assert.equal(validateReplyPlan(original, p).ok, false, change.toString()) }
  for (const value of [null, true, 1, [], '', '正文', '{}', '```json\n{}\n```', '{"version":1', '{"__proto__":{},"schema":"aurabot.reply","version":1,"blocks":[]}']) assert.equal(validateReplyPlan(original, value).ok, false)
  const inherited = Object.create(planFor(original))
  assert.equal(validateReplyPlan(original, inherited).ok, false)
})

test('增删、重排、重复 block 均整体拒绝，不发送通过检查的半截内容', async () => {
  const original = '<reply:1>前![图](https://e.org/a.png)后<voice>保留语音</voice>'
  const mutations = [
    p => p.blocks.pop(), p => p.blocks.push(p.blocks[0]), p => p.blocks.reverse(),
    p => { p.blocks[2] = p.blocks[0] }, p => { p.blocks[1].ref = p.blocks[2].ref },
  ]
  for (const mutate of mutations) {
    const p = planFor(original); mutate(p)
    const r = await rewriteReply(original, { ask: async () => p })
    assert.equal(r.rewritten, false)
    assert.equal(r.text, original)
    assert.equal(r.reply, undefined)
  }
})

test('语音、图片、表情、引用只能引用原 block，不能透传模型新路径或负载', () => {
  const original = '<reply:7>说明![图](https://e.org/a.png)<voice>不要改</voice><sticker:开心><poke>|||尾声'
  for (let i = 0; i < planFor(original).blocks.length; i++) {
    for (const key of ['path', 'url', 'assetId', 'value', 'replyTo', 'actorId']) {
      const p = planFor(original); p.blocks[i][key] = 'file:///C:/secret.png'
      assert.equal(validateReplyPlan(original, p).ok, false, `${i}:${key}`)
    }
    if (planFor(original).blocks[i].type !== 'text') {
      for (const key of ['text', 'cuts']) {
        const p = planFor(original); p.blocks[i][key] = key === 'text' ? '已完成' : []
        assert.equal(validateReplyPlan(original, p).ok, false)
      }
    }
  }
})

test('URL、金额、日期、否定与任务状态改变必定回退；其他文字删改也不冒充语义等价', async () => {
  const pairs = [
    ['尚未完成，不能重试。', '已经完成，可以重试。'], ['没有发送。', '已发送。'], ['已取消。', '已完成。'],
    ['结果未知，请人工确认。', '成功了。'], ['价格 -12.50 元', '价格 12.50 元'],
    ['截止 2026-10-28', '截止 2026-10-29'], ['去 https://e.org/a?x=2', '去 https://e.org/a?x=3'],
    ['张三在北京，李四在上海。', '张三在北京。'], ['不要，停！', '不要停！'], ['好的，我明白了。', '哦 知道了'],
  ]
  for (const [original, changed] of pairs) {
    const p = planFor(original); p.blocks[0].text = changed
    const result = await rewriteReply(original, { ask: async () => p })
    assert.equal(result.rewritten, false, original)
    assert.equal(result.text, original)
    assert.equal(acceptRewrite(original, changed), false)
    p.blocks[0].text = original
    assert.equal(validateReplyPlan(original, p).ok, true)
  }
})

test('标签数量相同不证明语义正确；旧 acceptRewrite 只允许原样或合法结构', () => {
  const original = '<reply:2>行 我去画<sticker:开心>'
  assert.equal(acceptRewrite(original, original), true)
  assert.equal(acceptRewrite(original, planFor(original)), true)
  for (const rewritten of ['<reply:2>好嘞 这就去画<sticker:开心>', '好嘞<sticker:开心>', '<reply:2>完成了<sticker:开心><poke>', '<sticker:开心><reply:2>好嘞', '   ']) assert.equal(acceptRewrite(original, rewritten), false)
  assert.equal(acceptRewrite('嗯', 'x'.repeat(200)), false)
})

test('无版本的旧自由文本输出、Markdown JSON、截断 JSON 都回退原文', async () => {
  const original = '不要改写。'
  const p = JSON.stringify(planFor(original))
  for (const output of [original, '好呀', '```json\n' + p + '\n```', p.slice(0, -2), '说明：' + p, 'x'.repeat(20000)]) {
    const r = await rewriteReply(original, { ask: async () => output })
    assert.equal(r.rewritten, false)
    assert.equal(r.text, original)
    assert.equal(r.reply, undefined)
  }
})

test('非法 Unicode / URL / 代码切点使整份计划回退，不局部应用', async () => {
  for (const [original, cut] of [['😀后', 1], ['e\u0301后', 1], ['https://e.org/a 后', 9], ['`a ** b` 后', 4], ['-123.50 元', 3], ['「不要修改」后', 3]]) {
    const p = planFor(original); p.blocks[0].cuts = [cut]
    const r = await rewriteReply(original, { ask: async () => p })
    assert.equal(r.rewritten, false, original)
    assert.equal(r.text, original)
  }
})

test('故障、persona 编译故障和非 Error 拒绝都保留原文', async () => {
  const error = await rewriteReply('在呢', { ask: async () => { throw new Error('超时') } })
  assert.deepEqual(error, { text: '在呢', rewritten: false, reason: '超时' })
  assert.equal((await rewriteReply('在呢', { ask: async () => { throw null } })).text, '在呢')
  assert.equal((await rewriteReply('在呢', { persona: { layers: { style: { examples: 'bad' } } }, ask: async () => { throw new Error('should not run') } })).rewritten, false)
})

test('全部沉默别名均不调用模型；长回复超预算不截断原文', async () => {
  let calls = 0
  const ask = async () => { calls++; throw new Error('must not call') }
  for (const text of ['', '  ', '[沉默]', '［沉默］', '(沉默)', '（沉默）', '字'.repeat(24001), Array(140).fill('字|||').join('')]) {
    const r = await rewriteReply(text, { ask })
    assert.equal(r.rewritten, false)
    assert.equal(r.text, text)
  }
  assert.equal(calls, 0)
})

test('取消信号传入 ask，调用前和返回后都做有效性检查', async () => {
  const before = new AbortController(); before.abort()
  let calls = 0
  const no = await rewriteReply('原文', { signal: before.signal, ask: async () => { calls++; return planFor('原文') } })
  assert.equal(no.rewritten, false)
  assert.equal(calls, 0)
  const waiting = defer(), during = new AbortController()
  let seen
  const pending = rewriteReply('原文', { signal: during.signal, ask: options => { seen = options; return waiting.promise } })
  during.abort()
  waiting.resolve(planFor('原文'))
  const late = await pending
  assert.equal(seen.signal, during.signal)
  assert.deepEqual(late, { text: '原文', rewritten: false, reason: '回复已取消' })
})

test('轮次守卫失效或抛错后迟到的模型结果不应用', async () => {
  for (const throwGuard of [false, true]) {
    let active = true
    const waiting = defer()
    const pending = rewriteReply('原文', { shouldContinue: () => { if (!active && throwGuard) throw new Error('stale'); return active }, ask: () => waiting.promise })
    active = false; waiting.resolve(planFor('原文'))
    const result = await pending
    assert.equal(result.text, '原文')
    assert.equal(result.rewritten, false)
  }
})

test('验证结果与模型返回对象独立，不受后续对象修改影响', () => {
  const original = '甲\n乙<voice>丙</voice>'
  const p = planFor(original)
  p.blocks[0].cuts = []
  const checked = validateReplyPlan(original, p)
  assert.equal(checked.ok, true)
  p.blocks.reverse(); p.blocks.at(-1).cuts.push(1)
  assert.equal(checked.plan.blocks[0].ref, 'b0')
  assert.deepEqual(checked.plan.blocks[0].cuts, [])
  assert.deepEqual(checked.reply.items.map(i => i.value), ['甲\n乙', '丙'])
})

test('重复 JSON 键（含转义同名键）拒绝；不能由 JSON.parse 最后一个值偷偷覆盖', () => {
  const original = '原文'
  const p = JSON.stringify(planFor(original))
  for (const invalid of [
    p.replace('"version":1', '"version":2,"version":1'),
    p.replace('"ref":"b0"', '"ref":"wrong","ref":"b0"'),
    p.replace('"ref":"b0"', '"r\\u0065f":"wrong","ref":"b0"'),
  ]) assert.equal(validateReplyPlan(original, invalid).ok, false)
  const withText = planFor('字符串里的 "ref":1, "ref":2 并非 JSON 键')
  withText.blocks[0].text = '字符串里的 "ref":1, "ref":2 并非 JSON 键'
  assert.equal(validateReplyPlan(withText.blocks[0].text, JSON.stringify(withText)).ok, true)
})

test('模型把纯空白切成独立段也不能丢原文区间', () => {
  const original = '甲\n\n乙  '
  const p = planFor(original)
  p.blocks[0].cuts = [1, 2, 3, 4]
  const r = validateReplyPlan(original, p)
  assert.equal(r.ok, true)
  assert.equal(replySourceRefs(capItems(r.reply.items, 1)[0]).map(ref => ref.raw).join(''), original)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  capBubbles, capItems, createReplySource, parseReply, protectedReplyRanges,
  replySourceRefs, splitLines, splitReplyText, stripMarkdown, REPLY_SCHEMA, REPLY_VERSION, validateReplyPlan,
} from '../src/chat/reply.js'

test('旧标签、表情闭合标签、引用与多气泡仍兼容；原文 block 连续覆盖', () => {
  const text = '<reply:3>在呢|||<voice>晚安啦</voice>![照片](https://example.org/a(b).png)<sticker:开心></sticker><poke/>'
  const r = parseReply(text)
  assert.deepEqual(r.items, [
    { kind: 'text', value: '在呢', replyTo: '3' }, { kind: 'voice', value: '晚安啦' },
    { kind: 'image', value: 'https://example.org/a(b).png' }, { kind: 'sticker', value: '开心' }, { kind: 'poke', value: '' },
  ])
  assert.equal(r.source.blocks.map(b => b.raw).join(''), text)
  let end = 0
  for (const b of r.source.blocks) { assert.equal(b.start, end); assert.equal(b.raw, text.slice(b.start, b.end)); end = b.end }
  assert.equal(end, text.length)
  assert.deepEqual(replySourceRefs(r.items[0]).map(r => r.blockId), ['b0', 'b1'])
})

test('限文本气泡不能跨图片、语音或表情搬运尾部文字', () => {
  const raw = '一\n二\n三\n四\n五![结果](https://e.org/a.png)六\n七<voice>八</voice>九\n十<sticker:开心>十一\n十二'
  const items = parseReply(raw).items
  assert.deepEqual(items.map(i => i.kind), ['text', 'text', 'image', 'text', 'voice', 'text', 'sticker', 'text'])
  assert.equal(items[1].value, '二\n三\n四\n五')
  assert.equal(items[3].value, '六\n七')
  assert.equal(items[5].value, '九\n十')
  assert.equal(items[7].value, '十一\n十二')
})

test('限总条数仅压缩装饰和相邻文本；媒体、语音、引用使上限成为软限制', () => {
  const input = [
    { kind: 'text', value: '一' }, { kind: 'text', value: '二' },
    { kind: 'image', value: 'https://e.org/a.png' }, { kind: 'text', value: '三', replyTo: '22' },
    { kind: 'voice', value: '四，未发送。' }, { kind: 'sticker', value: '开心' },
    { kind: 'text', value: '五' }, { kind: 'image', value: 'https://e.org/b.png' }, { kind: 'text', value: '六' },
  ].map(Object.freeze)
  const snapshot = structuredClone(input)
  const actual = capItems(Object.freeze(input), 3)
  assert.deepEqual(actual, [
    { kind: 'text', value: '一\n二' }, input[2], input[3], input[4], input[6], input[7], input[8],
  ])
  assert.deepEqual(input, snapshot)
  assert.deepEqual(capItems(actual, 3), actual, '重复限流不会进一步损坏内容')
})

test('明确引用不删除、不扩散到后面的独立气泡，也不因条数上限丢失', () => {
  const result = capItems(parseReply('<reply:1>第一件|||第二件|||<reply:2>另一人的事<reply:3><sticker:开心>').items, 1)
  assert.deepEqual(result.map(i => [i.kind, i.value, i.replyTo]), [
    ['text', '第一件', '1'], ['text', '第二件', undefined], ['text', '另一人的事', '2'], ['sticker', '开心', '3'],
  ])
})

test('坏标签、悬空引用与连续引用保留可见原文，不吞掉用户正文', () => {
  for (const text of ['<reply:x>坏标签', '<reply:3>', '<voice>没有闭合', '<sticker:>空标签']) {
    assert.equal(parseReply(text).items.map(i => i.value).join(''), text)
  }
  assert.deepEqual(parseReply('<reply:1><reply:2>正文').items, [
    { kind: 'text', value: '<reply:1>' }, { kind: 'text', value: '正文', replyTo: '2' },
  ])
})

test('语音正文逐字保留，不去 Markdown、不拆 |||、不变成普通文本', () => {
  const voice = '\n  不要付费；金额 -12.50；https://e.org/a__b?q=*x* ||| **还没完成**\n'
  const r = parseReply('开头<voice>' + voice + '</voice>尾声')
  assert.equal(r.items[1].value, voice)
  assert.equal(r.items[1].kind, 'voice')
  assert.deepEqual(capItems(r.items, 1).map(i => i.kind), ['text', 'voice', 'text'])
})

test('只有整轮沉默才无消息；正文中的沉默标记不能吞掉', () => {
  for (const text of ['', '   ', '[沉默]', '［沉默］', '(沉默)', '（沉默）', '|||']) assert.equal(parseReply(text).silent, true)
  assert.deepEqual(parseReply('标记说明\n[沉默]\n结束').items.map(i => i.value), ['标记说明', '[沉默]', '结束'])
  assert.equal(parseReply('<voice>[沉默]</voice>').items[0].value, '[沉默]')
})

test('代码、URL、引文和转义中的旧控制标签不执行', () => {
  const samples = [
    '`<reply:1><voice>不发送</voice>|||<poke>`',
    '```js\nconst s = "<poke>|||<voice>x</voice>";\n  a ** b;\n```',
    '~~~txt\n<sticker:开心>|||<reply:3>\n~~~',
    '    <poke>|||<voice>不发</voice>\n    第二行',
    '「<reply:2>|||<poke>」', 'https://e.org/a?x=<poke>|||token',
    '\\<poke> 与 \\|||', '[标签<poke>](https://e.org/a)',
  ]
  for (const text of samples) {
    const r = parseReply(text)
    assert.equal(r.items.every(i => i.kind === 'text' && !i.replyTo), true, text)
    assert.equal(r.items.map(i => i.value).join('\n'), text, text)
  }
})

test('Markdown 装饰可以清理，代码、负号、标识符、URL、引用和数字不能变', () => {
  assert.equal(stripMarkdown('**好耶** `x` \n# 标题\n- 列表'), '好耶 x\n标题\n列表')
  const preserved = [
    '- 12.50\n+ 0.25\n> 3\n- x\n+ y\n* z',
    '2 * 3 * 4 = 24；a**b**c；foo__bar__baz；__init__',
    'https://e.org/a__b?q=*x*&n=-12.50#anchor',
    '[参数](https://e.org/a(b)?x=2&y=-3)',
    '`a ** b; print("x  ")`',
    '```python\n# 注释\n    a = -1\n    print("x  ")  \n\n\n```\n',
    '    - x\n\t# comment\n',
    '$a * b - 2$ 与 \\(x ** 2\\) 和 $$\na + b\n$$',
    '> 他说：并未完成\n> 不能改成完成',
    '2026-10-28 12:30；1,234.50；1e-9；-0.00；50%；v1.2.3',
    '「**不要改动**」', '\\*literal\\* 与 foo_bar',
  ]
  for (const text of preserved) assert.equal(stripMarkdown(text), text, text)
})

test('代码、列表、长文默认整段发送；普通短行保留原有拆行体验', () => {
  assert.deepEqual(splitLines('一\n二\n三'), ['一', '二', '三'])
  for (const text of ['1. 第一\n2. 第二', '```js\nconst a = 1\n```', 'x'.repeat(241) + '\n结尾', '    a\n    b', '$$\na\nb\n$$']) {
    assert.equal(parseReply(text).items.length, 1, text)
  }
  assert.equal(parseReply('a\nb\nc\nd\ne\nf\ng').items.at(-1).value, 'e\nf\ng')
})

test('短表格连同表头和数据整段交付，Replyer 不能把行切成聊天气泡', () => {
  for (const text of ['| 项目 | 值 |\n| --- | --- |\n| 数量 | 2 |', '项目 | 值\n:--- | ---:\n数量 | 2']) {
    const parsed = parseReply(text)
    assert.equal(parsed.items.length, 1)
    assert.equal(parsed.items[0].value, text)
    const source = createReplySource(text)
    const plan = { schema: REPLY_SCHEMA, version: REPLY_VERSION, blocks: source.blocks.map(b => ({ type: b.type, ref: b.id, cuts: [text.indexOf('\n') + 1] })) }
    assert.equal(validateReplyPlan(text, plan).ok, false)
  }
})

test('合并相邻原文切片保留 CRLF、空行和空白分隔符', () => {
  const text = '甲  \r\n\r\n乙\r\n\r\n\r\n丙  丁'
  const parsed = parseReply(text)
  const merged = capItems(parsed.items, 1)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].value, text)
  assert.equal(replySourceRefs(merged[0]).map(r => r.raw).join(''), text)
  assert.equal(replySourceRefs(merged[0]).every(r => text.slice(r.start, r.end) === r.raw), true)
})

test('拆句 API 的原文区间严格连续，可逐字复原，包含尾部空白', () => {
  const text = '第一句。\r\n\r\n第二句： 👨‍👩‍👧‍👦 e\u0301\n尾部  '
  const result = splitReplyText(text)
  assert.equal(result.ok, true)
  assert.equal(result.pieces.map(p => p.text).join(''), text)
  let end = 0
  for (const p of result.pieces) { assert.equal(p.start, end); assert.equal(p.text, text.slice(p.start, p.end)); end = p.end }
  assert.equal(end, text.length)
})

test('无效切点整体回退，不接受乱序、遗漏式范围、过量和非整数', () => {
  const text = '甲乙丙丁'
  for (const cuts of [null, {}, [0], [4], [-1], [1.5], [NaN], [Infinity], ['1'], [2, 1], [1, 1], Array(65).fill(1)]) {
    const result = splitReplyText(text, cuts)
    assert.equal(result.ok, false, String(cuts))
    assert.deepEqual(result.pieces, [{ start: 0, end: text.length, text }])
  }
})

test('不能在 Unicode 组合、旗帜、ZWJ、CRLF 内部切开', () => {
  for (const atomic of ['😀', 'e\u0301', '👨‍👩‍👧‍👦', '🇨🇳', '\r\n']) {
    const text = '甲' + atomic + '乙'
    for (let cut = 2; cut < 1 + atomic.length; cut++) assert.equal(splitReplyText(text, [cut]).ok, false, `${atomic}:${cut}`)
    assert.equal(splitReplyText(text, [1, 1 + atomic.length]).ok, true)
  }
})

test('URL、代码、公式、引文、数字内部每个切点都被拒绝', () => {
  for (const atom of ['https://e.org/a?x=-12&b=4', '`a ** b`', '```js\na = 1\n```', '$a + b$', '「不准改写」', '-123.50', '[查询](https://e.org/a(b))']) {
    const text = '前 ' + atom + ' 后'
    const start = 2, end = start + atom.length
    assert.ok(protectedReplyRanges(text).some(r => r.start <= start && r.end >= end), atom)
    for (let cut = start + 1; cut < end; cut++) assert.equal(splitReplyText(text, [cut]).ok, false, `${atom}:${cut}`)
  }
})

test('Markdown 图片支持 URL 内括号；本地文件、data、base64 只保留文字', () => {
  for (const target of ['file:///C:/secret.png', 'C:/secret.png', 'D:\\photo.png', 'base64://AAAA', 'data:image/png;base64,AAAA', '/etc/passwd', '../secret.png', 'javascript:alert(1)']) {
    const text = `前![图片](${target})后`
    assert.deepEqual(parseReply(text).items, [{ kind: 'text', value: text }], target)
  }
  assert.deepEqual(parseReply('前![图](https://e.org/a(b(c)).png?x=2)后').items.map(i => i.value), ['前', 'https://e.org/a(b(c)).png?x=2', '后'])
  assert.equal(parseReply('![坏](https://e.org/(不闭合)').items[0].kind, 'text')
})

test('表情与重复戳一戳可压缩；显式引用的装饰不能丢', () => {
  assert.equal(parseReply('<poke><poke>').items.length, 1)
  const items = [{ kind: 'sticker', value: 'a' }, { kind: 'text', value: '正文' }, { kind: 'poke', value: '' }]
  assert.deepEqual(capItems(items, 1), [items[1]])
  const quoted = { kind: 'sticker', value: 'a', replyTo: '1' }
  assert.deepEqual(capItems([quoted, items[1]], 0), [quoted, items[1]])
})

test('上限边界不会截断或修改调用者输入', () => {
  const items = [{ kind: 'text', value: 'a' }, { kind: 'image', value: 'https://e.org/x' }, { kind: 'text', value: 'z' }]
  for (const max of [0, 1, 2, 3, Infinity, NaN, -1, 1.5, undefined]) {
    assert.deepEqual(capItems(items, max), items)
    assert.deepEqual(capBubbles(items, max), items)
  }
  assert.equal(capItems(null, 1), null)
})

test('随机混排回归：各种上限下非装饰事件序列与全部文本内容保持顺序', () => {
  let seed = 417
  const random = () => (seed = Math.imul(seed, 1664525) + 1013904223 >>> 0)
  const content = items => items.flatMap(i => i.kind === 'text' ? i.value.split('\n').map(v => ['text', v]) : ['sticker', 'poke'].includes(i.kind) ? [] : [[i.kind, i.value]])
  for (let run = 0; run < 80; run++) {
    const items = Array.from({ length: 12 + random() % 40 }, (_, n) => {
      const kind = ['text', 'text', 'image', 'voice', 'sticker', 'poke'][random() % 6]
      return { kind, value: `${run}:${n}`, ...(random() % 9 === 0 ? { replyTo: String(n + 1) } : {}) }
    })
    for (const max of [0, 1, 3, 5, 10]) {
      const actual = capItems(items, max)
      assert.deepEqual(content(actual), content(items))
      assert.deepEqual(actual.filter(i => i.replyTo), items.filter(i => i.replyTo))
    }
  }
})

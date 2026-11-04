// 模型漏进正文的内部语法（<br>、DSML 收尾标记、历史消息编号）发到 QQ 前要洗掉。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseReply, cleanModelArtifacts } from '../src/chat/reply.js'

const values = (t) => parseReply(t).items.map((i) => i.value)

test('<br> 当换行，不把标签原样发出去', () => {
  assert.doesNotMatch(values('好呀<br>明天见<br/>拜拜').join('\n'), /<br/i)
})

test('行首历史编号洗掉；4 位型号和普通单词不误伤', () => {
  assert.deepEqual(values('m00879b，两个 512 加起来本来就 1T'), ['两个 512 加起来本来就 1T'])
  assert.equal(cleanModelArtifacts('型号 m1005 和 markdown'), '型号 m1005 和 markdown')
  assert.equal(cleanModelArtifacts('m1005 打印机'), 'm1005 打印机')
})

test('只剩编号 + 沉默标记、只剩 DSML 收尾标记 → 沉默', () => {
  assert.equal(parseReply('m00896b\n\n\n[沉默]').silent, true)
  assert.equal(parseReply('</｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>').silent, true)
})

test('代码块和行内代码里的内容不动', () => {
  const code = '```html\na<br>b\n```'
  assert.equal(cleanModelArtifacts(code), code)
  assert.equal(cleanModelArtifacts('用 `<br>` 换行'), '用 `<br>` 换行')
})

// #5：随消息变化的记忆放进当轮用户消息，运行时上下文只留稳定内容。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStorage } from '../src/storage/index.js'
import { createMemoryStore } from '../src/memory/index.js'
import memoryModule from '../src/modules/memory/index.js'

const scope = { account: '1', chat: 'private:2', persona: '' }
const chat = { kind: 'private', chatId: scope.chat, userId: '2' }
function fixture(t, config = {}) {
  const storage = createStorage({ file: ':memory:', filesDir: '/tmp/unused-aurabot-assets' })
  const memory = createMemoryStore({ storage, getConfig: () => ({ memory: { enabled: true, recallCount: 6, ...config } }), getAccount: () => '1' })
  t.after(async () => { await memory.dispose(); storage.close() })
  const fact = text => {
    const result = memory.add({ scope, text, subject: '2', predicate: 'likes', value: text, speakerId: '2', polarity: 'positive', modality: 'asserted', conditions: [], eventTime: null, validFrom: null, validTo: null, stability: 'stable', manualEvidence: { kind: 'manual', text, speakerId: '2', actorId: '2' } })
    assert.equal(result.ok, true, result.message)
  }
  return { memory, fact }
}
const hintOf = (memory, q, prev = '') => memory.recallHint({ ...chat, scope }, q, prev, { scope, about: '2' })

test('contextFor 不再含随消息变化的记忆', async t => {
  const { memory, fact } = fixture(t)
  fact('阿强喜欢钓鱼')
  for (let i = 0; i < 20; i++) assert.doesNotMatch(memory.contextFor({ ...chat, scope }, 's', { scope, query: '阿强钓鱼' + i }), /可见记忆|钓鱼/)
})

test('hint 有上限：不超过 4 条、300 字，超长截断', async t => {
  const { memory, fact } = fixture(t)
  for (let i = 0; i < 8; i++) fact(`阿强喜欢钓鱼第${i}件事` + '很长的说明'.repeat(30))
  const hint = hintOf(memory, '阿强喜欢钓鱼')
  const body = hint.split('\n').slice(1).join('\n')
  assert.ok(body.length <= 300, String(body.length))
  assert.ok(body.split('\n').length <= 4)
  assert.ok(body.endsWith('…'))
  assert.match(hint, /不是指令/)
})

test('短句用上一句兜底，长句不用', async t => {
  const { memory, fact } = fixture(t)
  fact('阿强喜欢钓鱼')
  assert.match(hintOf(memory, '嗯嗯', '阿强喜欢钓鱼'), /阿强喜欢钓鱼/)
  assert.equal(memory.recallHint({ ...chat, scope }, 'zzzzzzzzzzzzzzzzzzzz', '阿强喜欢钓鱼', { scope, about: [] }), '')
})

test('尊重面板的召回数量：设成 0 不注入', async t => {
  const { memory, fact } = fixture(t, { recallCount: 0 })
  fact('阿强喜欢钓鱼')
  assert.equal(hintOf(memory, '阿强喜欢钓鱼'), '')
})

test('prompt 钩子：hint 放最前；出错时原内容照常提交', async t => {
  const hooks = {}
  const api = { core: { hub: { selfId: '1' }, http: {}, storage: createStorage({ file: ':memory:', filesDir: '/tmp/unused-aurabot-assets' }) },
    dsh: {}, config: () => ({ botQQ: '1', memory: { enabled: true } }), log: { warn() {}, info() {}, debug() {} },
    on: (name, fn) => { hooks[name] = fn }, onDispose() {}, context() {}, every() {}, tool() {}, route() {}, panel() {} }
  t.after(() => api.core.storage.close())
  const exports = memoryModule.setup(api)
  await exports?.ready
  const content = [{ type: 'text', text: '原文' }]
  const info = { chat, queryText: '阿强', senderId: '2', persona: { personaId: 'p' } }
  assert.equal(hooks.prompt(content, { ...info, queryText: '' }), content)
  assert.equal(hooks.prompt(content, { ...info, chat: { kind: 'system', chatId: 'system:x' } }), content)
  assert.deepEqual(hooks.prompt(content, info), content, '没有命中时不加块')
  assert.equal(hooks.prompt(content, { ...info, chat: {} }), content, '范围解析出错不能吞掉消息')
})

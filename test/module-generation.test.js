// #2：模块代际 + 工具按会话挂载。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createModules } from '../src/core/modules.js'
import { hubFixture, privateChat, groupChat, OWNER, GROUP, until } from './helpers/hub-fixture.js'

const send = (hub, chat, sender) => hub.pushToSession(chat, [{ type: 'text', text: '调工具' }], sender)
const fixture = (t, state) => hubFixture(t, {
  brain: async ({ callTool }) => { state.results.push(await callTool('probe', {})); return '好' },
  buildTools: () => state.tools(),
  toolsGeneration: () => state.generation,
})
const probe = value => ({ name: 'probe', description: '', parameters: { type: 'object', properties: {} }, execute: () => value })

test('工具名不变但代际变了：同一会话下一轮用新实例', async t => {
  const state = { generation: 1, tools: () => [probe('v1')], results: [] }
  const f = await fixture(t, state)
  await send(f.hub, privateChat(), OWNER)
  await until(() => state.results.length === 1)
  state.generation = 2
  state.tools = () => [probe('v2')]
  await send(f.hub, privateChat(), OWNER)
  await until(() => state.results.length === 2)
  assert.deepEqual(state.results, ['v1', 'v2'])
})

test('清单和代际都没变就不重挂（不破坏前缀缓存）', async t => {
  let built = 0
  const state = { generation: 1, results: [], tools: () => [{ ...probe('v' + ++built) }] }
  const f = await fixture(t, state)
  await send(f.hub, privateChat(), OWNER)
  await until(() => state.results.length === 1)
  await send(f.hub, privateChat(), OWNER)
  await until(() => state.results.length === 2)
  assert.deepEqual(state.results, ['v1', 'v1'])
})

test('宿主换了 agent 对象：旧 agent 的工具撤掉，新 agent 重新挂上', async t => {
  const state = { generation: 1, tools: () => [probe('v1')], results: [] }
  const f = await fixture(t, state)
  await send(f.hub, privateChat(), OWNER)
  await until(() => state.results.length === 1)
  const sid = f.hub.sessions()[privateChat().chatId].sessionId
  const old = f.fake.agents.get(sid)
  const created = await f.fake.ctx.get('sessionController').create({ workspaceId: f.fake.workspaces[0].id, agentPreset: old.preset })
  const replacement = f.fake.agents.get(created.sessionId)
  replacement.session.id = sid
  replacement.id = sid
  f.fake.agents.set(sid, replacement)
  await send(f.hub, privateChat(), OWNER)
  await until(() => replacement.tools.has('probe'))
  assert.equal(old.tools.has('probe'), false)
})

test('两个会话的同名工具互不影响：一个重挂不撤另一个', async t => {
  const state = { generation: 1, tools: () => [probe('v1')], results: [] }
  const f = await fixture(t, state)
  await send(f.hub, privateChat(), OWNER)
  await send(f.hub, groupChat(), OWNER)
  await until(() => state.results.length === 2)
  const agents = [`private:${OWNER}`, `group:${GROUP}`].map(chatId => f.fake.agents.get(f.hub.sessions()[chatId].sessionId))
  state.generation = 2
  await send(f.hub, privateChat(), OWNER)
  await until(() => state.results.length === 3)
  assert.ok(agents.every(agent => agent.tools.has('probe')))
})

test('createModules：start / stop 都会推进代际', async () => {
  const mods = createModules({ ctx: { on: () => () => {}, effect() {}, tools: { register: () => () => {} } }, core: {}, getConfig: () => ({ modules: {}, ext: {} }), setConfig() {},
    logger: { child: () => ({ info() {}, warn() {}, error() {}, debug() {} }), info() {}, warn() {}, error() {}, debug() {} }, version: 'test', builtins: [{ id: 'probe', name: 'probe', setup: () => ({}) }] })
  await mods.boot?.()
  const started = mods.generation()
  assert.ok(started > 0)
  mods.stop('probe')
  assert.ok(mods.generation() > started)
  await mods.dispose?.()
})

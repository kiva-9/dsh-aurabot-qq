// 模块系统 + 联动：自己写的模块、替换 / 关掉内置模块、热重载、安全模式、复制内置模块、开放接口、DSH 联动工具。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockOneBot } from './helpers/mock-onebot.js'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { png as fakePng } from './helpers/images.js'

const OWNER = '10000001'
const BOT = '20000002'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 10000) {
  const t = Date.now()
  while (Date.now() - t < ms) {
    const v = await fn()
    if (v) return v
    await sleep(50)
  }
  throw new Error('等不到条件成立')
}

let mock, fake, api, dataDir
const modDir = (id) => join(dataDir, 'modules', id)
const writeMod = (id, code) => { mkdirSync(modDir(id), { recursive: true }); writeFileSync(join(modDir(id), 'index.mjs'), code) }
const echoCode = (pong) => `
export default {
  id: 'echo', name: '回声', version: '1.0.0', api: 1,
  defaults: { greet: '你好' },
  settings: [{ key: 'greet', label: '招呼', type: 'text' }, { key: 'secret', label: '密钥', type: 'password' }],
  setup(api) {
    api.on('message', async (msg) => { if (msg.text === 'ping') { await api.sendText(msg.chatId, '${pong}'); return true } return false })
    api.on('reply', (text) => (text === '在呢' ? '在呢～' : undefined))
    api.command({ name: 'echo', aliases: ['回声'], desc: '回声', run: (arg) => 'echo: ' + arg })
    api.tool(() => api.defineTool({ name: 'echo_tool', description: 'echo', execute: async () => ({ ok: true }) }))
    api.rule(() => '你会说回声')
    api.route('/hi', async () => ({ ok: true, hi: api.settings().greet }))
    api.dshTool({ name: 'echo_dsh', description: '回声', execute: async () => ({ ok: true }) })
    return { shout: (s) => String(s).toUpperCase() }
  },
}`
const sentTo = (id) => mock.calls.filter((c) => c.action === 'send_private_msg' && String(c.params.user_id) === String(id)).map((c) => c.params.message.map((s) => s.data.text).join(''))
const priv = (t) => ({ message_type: 'private', sub_type: 'friend', user_id: Number(OWNER), message_id: Math.floor(Math.random() * 1e6), sender: { user_id: Number(OWNER), nickname: 'xiaoming' }, message: [{ type: 'text', data: { text: t } }] })
const mod = async (id) => (await fake.call('/modules')).json().list.find((m) => m.id === id)

async function brain({ text }) {
  if (text.includes('联动测试')) return '收到联动'
  if (text.includes('[附加背景]')) return '钩子收到|||第二条'
  if (text.includes('强制回')) return '群里收到'
  if (text.includes('在吗')) return '在呢'
  return '嗯'
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-mod-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mock = await startMockOneBot({ selfId: BOT })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true, dryRun: false, setupDone: true, botQQ: BOT, ownerQQ: OWNER,
    allow: { private: [OWNER], groups: ['777'] },
    group: { interjectChance: 0 },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token, dir: join(dataDir, 'no-snowluma') },
    voice: { autoChance: 0 }, stickers: { autoChance: 0 },
    merge: { waitSec: 0.2, maxSec: 2 },
    bili: { enabled: true },
    modules: { bili: { enabled: false } },
  }))
  writeMod('echo', echoCode('pong'))
  // 替换内置的白名单管理
  writeMod('contacts', `export default { id: 'contacts', name: '我的名单', api: 1, setup(api) {
    api.route('/contacts/mine', async () => ({ ok: true, mine: true }))
    return {}
  } }`)
  fake = createFakeDsh({ brain })
  const host = await import('../src/host.js')
  api = host.apply(fake.ctx)
  await api.ready
  await fake.call('/onebot/reconnect')
  await until(() => mock.connected() > 0)
})

after(async () => {
  fake?.dispose()
  await mock?.close()
  setTimeout(() => process.exit(0), 200).unref()
})

test('自己写的模块加载了；同名的替换了内置的；关掉的内置模块没在跑', async () => {
  const echo = await mod('echo')
  assert.equal(echo.running, 'user')
  assert.deepEqual(echo.tools, ['echo_tool'])
  assert.deepEqual(echo.commands, ['echo'])
  const contacts = await mod('contacts')
  assert.equal(contacts.running, 'user')
  assert.equal(contacts.builtin, true)
  assert.equal(contacts.forkedFrom, '1.0.0', '记下了替换时内置模块的版本')
  assert.equal((await mod('bili')).running, null)
  assert.equal((await mod('memory')).running, 'builtin')
  // 被替换的接口走自己写的；关掉模块的接口告诉面板「模块没开」
  assert.equal((await fake.call('/contacts/mine')).json().mine, true)
  const off = (await fake.call('/bili/state')).json()
  assert.equal(off.ok, false)
  assert.equal(off.moduleOff, true)
  // 自己写的模块的接口在 /ext/模块id/ 下面，设置有默认值
  assert.equal((await fake.call('/ext/echo/hi')).json().hi, '你好')
})

test('模块接管消息、改写回复、加命令；她的规则里有模块补的话，没有关掉模块的本事', async () => {
  mock.push(priv('ping'))
  await until(() => sentTo(OWNER).includes('pong'))
  const turns = fake.turns.length
  await sleep(500)
  assert.equal(fake.turns.length, turns, '被模块接管的消息不交给她')

  mock.push(priv('在吗'))
  await until(() => sentTo(OWNER).includes('在呢～'))

  mock.push(priv('/回声 你好'))
  await until(() => sentTo(OWNER).includes('echo: 你好'))
  mock.push(priv('/help'))
  await until(() => sentTo(OWNER).some((t) => t.includes('扩展模块加的') && t.includes('/echo')))

  const rules = fake.variables.get('aurabot_rules_private')()
  assert.match(rules, /你会说回声/)
  assert.doesNotMatch(rules, /你会刷 B 站/, 'B 站模块关着就不说她会刷 B 站')
  // 主人私聊会话：有模块的工具，没有关掉模块的工具
  const agent = [...fake.agents.values()].find((a) => a.preset === 'aurabot-private')
  assert.ok(agent.tools.has('echo_tool'))
  assert.ok(!agent.tools.has('bili_watch'))
  assert.ok(agent.tools.has('remember'))
})

test('面板里关掉内置模块：马上停，它的工具和接口都没了；再打开又回来', async () => {
  await fake.call('/save', { modules: { stickers: { enabled: false } } })
  assert.equal((await mod('stickers')).running, null)
  assert.equal((await fake.call('/stickers')).json().moduleOff, true)
  await fake.call('/save', { modules: { stickers: { enabled: true } } })
  assert.equal((await mod('stickers')).running, 'builtin')
  assert.equal((await fake.call('/stickers')).json().ok, true)
})

test('改了模块文件：几秒内自动重新加载', async () => {
  await sleep(50)
  writeMod('echo', echoCode('pong2'))
  await until(async () => (await mod('echo')).startedAt > 0 && (mock.push(priv('ping')), await sleep(600), sentTo(OWNER).includes('pong2')), 15000)
})

test('替换版写坏了：先用回内置的，面板看得到报错', async () => {
  writeMod('mood', 'export default { id: "mood", setup( {')
  const m = await until(async () => { const x = await mod('mood'); return x.error ? x : null }, 15000)
  assert.equal(m.running, 'builtin')
  assert.equal(m.fallback, true)
  assert.ok(api.mood.label(), '内置的心情照常能用')
})

test('安全模式：自己写的一个都不加载，内置的回来', async () => {
  await fake.call('/save', { safeMode: true })
  assert.equal((await mod('echo')).running, null)
  assert.equal((await mod('contacts')).running, 'builtin')
  await fake.call('/save', { safeMode: false })
  assert.equal((await mod('echo')).running, 'user')
  assert.equal((await mod('contacts')).running, 'user')
})

test('复制内置模块来改：复制出来的能直接跑（连翻唱这种带数据文件的）', async () => {
  for (const id of ['speakup', 'song']) {
    const r = (await fake.call('/modules/fork', { id })).json()
    assert.equal(r.ok, true, r.message)
    const code = readdirSync(modDir(id), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(join(modDir(id), e.name), 'utf8')).join('\n')
    assert.match(code, /globalThis\.aurabot\.lib/)
    assert.doesNotMatch(code, /from '\.\.\//, '没有指回插件目录的相对路径')
    assert.equal((await mod(id)).running, 'user', (await mod(id)).error)
  }
  assert.ok(existsSync(join(modDir('song'), 'studio.js')))
  assert.match(readFileSync(join(modDir('song'), 'studio.js'), 'utf8'), /new URL\('song\/fetch_file\.py', globalThis\.aurabot\.src\)/)
  assert.equal((await fake.call('/song/status')).json().ok, true)
  // 说明文档放进了 modules/
  assert.match(readFileSync(join(dataDir, 'modules', 'API.md'), 'utf8'), /api\.on\('message'/)
})

test('新建模块：从模板建，能直接跑', async () => {
  const r = (await fake.call('/modules/create', { id: 'my-ext', name: '我的扩展' })).json()
  assert.equal(r.ok, true, r.message)
  assert.match(r.prompt, /API\.md/)
  const m = await mod('my-ext')
  assert.equal(m.running, 'user', m.error)
  assert.deepEqual(m.tools, ['my_ext_keywords'])
  assert.equal((await fake.call('/modules/create', { id: 'Bad Id' })).json().ok, false)
})

test('模块设置里的密码不回传给面板', async () => {
  await fake.call('/save', { ext: { echo: { secret: 'abc123', greet: '嗨' } } })
  const cfg = (await fake.call('/state')).json().config
  assert.equal(cfg.ext.echo.secret, '')
  assert.equal(cfg.ext.echo.secretSet, true)
  assert.equal(cfg.ext.echo.greet, '嗨')
  await fake.call('/save', { ext: { echo: { secret: '', greet: '嗨' } } })
  assert.equal(api.getConfig().ext.echo.secret, 'abc123', '面板传回空串 = 不改')
})

test('联动：开放接口要密钥，只能发给白名单，能调模块', async () => {
  assert.equal((await fake.call('/open/info')).json().ok, false)
  await fake.call('/save', { bridge: { http: true } })
  const token = (await fake.call('/bridge/token')).json().token
  assert.match(token, /^ab_/)
  const h = { authorization: 'Bearer ' + token }
  assert.equal((await fake.call('/open/info', null, { authorization: 'Bearer wrong' })).json().ok, false)
  const info = (await fake.call('/open/info', null, h)).json()
  assert.equal(info.ok, true)
  assert.ok(info.modules.some((m) => m.id === 'echo'))
  assert.equal((await fake.call('/open/send', { target: 'private:123', text: 'x' }, h)).json().ok, false)
  const r = (await fake.call('/open/send', { text: '联动发的' }, h)).json()
  assert.equal(r.ok, true)
  await until(() => sentTo(OWNER).includes('联动发的'))
  assert.equal((await fake.call('/open/call', { module: 'echo', method: 'shout', args: ['hi'] }, h)).json().result, 'HI')
  assert.equal((await fake.call('/open/call', { module: 'nope', method: 'x' }, h)).json().ok, false)
  const ev = (await fake.call('/open/events', null, h)).json()
  assert.ok(ev.list.some((e) => e.type === 'message'))
  // 面板拿不到密钥原文，密钥也不能从面板改
  assert.equal((await fake.call('/state')).json().config.bridge.token, '')
  await fake.call('/save', { bridge: { token: 'hack' } })
  assert.equal(api.getConfig().bridge.token, token)
})

test('联动：别的 DSH 插件能 ctx.get(aurabot)；打开后 DSH 会话有全局工具，她自己的 QQ 会话屏蔽掉', async () => {
  const svc = fake.ctx.get('aurabot')
  assert.ok(svc && typeof svc.send === 'function')
  assert.equal(svc.use('echo').shout('a'), 'A')
  assert.equal(fake.ctx.globalTools.size, 0, '默认不挂全局工具')
  await fake.call('/save', { bridge: { dshTools: true } })
  assert.ok(fake.ctx.globalTools.has('aurabot_qq_send'))
  assert.ok(fake.ctx.globalTools.has('echo_dsh'), '模块加的联动工具也挂上了')
  const r = await fake.ctx.globalTools.get('aurabot_qq_send').execute({ text: '从 DSH 发的' })
  assert.equal(r.ok, true)
  await until(() => sentTo(OWNER).includes('从 DSH 发的'))
  // 她的 QQ 会话下一轮重挂工具时屏蔽联动工具
  mock.push(priv('在吗'))
  const agent = [...fake.agents.values()].find((a) => a.preset === 'aurabot-private')
  await until(() => agent.denied.has('aurabot_qq_send'))
  await fake.call('/save', { bridge: { dshTools: false } })
  assert.equal(fake.ctx.globalTools.size, 0)
})

test('改她怎么想、怎么说：群聊决定、提示词、拆条、最终发送、模型、人格、规则、戳一戳都能改', async () => {
  // 本例验证 legacy hook 的接线；新的自动参与控制器有独立回归，默认不允许 hook 绕过容量。
  await fake.call('/save', { participation: { enabled: false } })
  writeMod('hooks-demo', `export default { id: 'hooks-demo', api: 1, setup(api) {
    api.on('group/decide', (d, { msg }) => (msg.text.includes('强制回') ? { reply: true, mode: 'must', reason: '模块说要回' } : undefined))
    api.on('prompt', (content) => (content[0] && content[0].text.includes('钩子测试') ? [{ type: 'text', text: content[0].text + ' [附加背景]' }, ...content.slice(1)] : undefined))
    api.on('reply/items', (items) => (items.some((i) => i.value === '钩子收到') ? [...items, { kind: 'text', value: '尾巴' }] : undefined))
    api.on('send', (message) => message.map((s) => (s.type === 'text' && s.data.text === '第二条' ? { type: 'text', data: { text: '第二条!' } } : s)))
    api.on('model', (sel, chat) => (chat.kind === 'private' ? { provider: 'fake', model: 'hooked' } : undefined))
    api.on('persona', (t) => t + ' 【模块人格】')
    api.on('rules', (t, kind) => t + ' 【模块规则 ' + kind + '】')
    api.on('poke', async (ev) => { await api.sendText('private:' + ev.user_id, '别戳'); return true })
  } }`)
  await until(async () => (await mod('hooks-demo'))?.running === 'user')
  assert.match(fake.variables.get('aurabot_persona')(), /【模块人格】/)
  assert.match(fake.variables.get('aurabot_rules_social')(), /【模块规则 social】/)

  mock.push(priv('钩子测试'))
  await until(() => sentTo(OWNER).includes('尾巴'))
  assert.ok(sentTo(OWNER).includes('第二条!'), '最终发送被改写')
  const agent = [...fake.agents.values()].find((a) => a.preset === 'aurabot-private')
  assert.ok(agent.events.some((e) => e.type === 'model/selection' && e.data.model === 'hooked'), '私聊换成了模块指定的模型')

  mock.push({ message_type: 'group', sub_type: 'normal', group_id: 777, user_id: 123456, message_id: 99, sender: { user_id: 123456, nickname: '群友', card: '群友', role: 'member' }, message: [{ type: 'text', data: { text: '强制回一下' } }] })
  await until(() => mock.calls.some((c) => c.action === 'send_group_msg' && String(c.params.group_id) === '777' && c.params.message.some((s) => s.data?.text === '群里收到')))

  mock.push({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', target_id: Number(BOT), user_id: Number(OWNER), self_id: Number(BOT) })
  await until(() => sentTo(OWNER).includes('别戳'))
  rmSync(modDir('hooks-demo'), { recursive: true, force: true })
  await until(async () => !(await mod('hooks-demo')))
  assert.doesNotMatch(fake.variables.get('aurabot_persona')(), /【模块人格】/, '模块删掉后改写也撤掉了')
  await fake.call('/save', { participation: { enabled: true } })
})

test('多文件模块：改了哪个文件都重新加载；模块自己装的 npm 包找得到', async () => {
  const d = modDir('multi')
  mkdirSync(join(d, 'lib'), { recursive: true })
  mkdirSync(join(d, 'node_modules', 'fakepkg'), { recursive: true })
  writeFileSync(join(d, 'node_modules', 'fakepkg', 'package.json'), JSON.stringify({ name: 'fakepkg', type: 'module', main: 'index.js' }))
  writeFileSync(join(d, 'node_modules', 'fakepkg', 'index.js'), "export const x = 'pkg'")
  writeFileSync(join(d, 'lib', 'val.mjs'), "export const v = 'v1'")
  writeFileSync(join(d, 'index.mjs'), `import { v } from './lib/val.mjs'
import { x } from 'fakepkg'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
export default { id: 'multi', api: 1, setup(api) {
  api.route('/val', async () => ({ ok: true, v: v + '-' + x + '-' + readFileSync(join(api.dir, 'data.txt'), 'utf8') }))
} }`)
  writeFileSync(join(d, 'data.txt'), 'd1')
  await until(async () => (await fake.call('/ext/multi/val')).json().v === 'v1-pkg-d1', 15000)
  await sleep(1100) // 文件修改时间按毫秒取整，隔开一点
  writeFileSync(join(d, 'lib', 'val.mjs'), "export const v = 'v2'")
  await until(async () => (await fake.call('/ext/multi/val')).json().v === 'v2-pkg-d1', 15000)
  assert.ok(!existsSync(join(d, '.aurabot-cache', 'node_modules')), '依赖不拍进快照')
})

test('模拟测试：消息、命令、她的回复都走一遍模块，但不真发到 QQ；工具能直接调', async () => {
  const before = mock.calls.length
  const r = (await fake.call('/modules/simulate', { as: 'owner', kind: 'private', text: 'ping', reply: '在呢' })).json()
  assert.equal(r.ok, true)
  assert.match(r.steps.join('\n'), /接管/)
  assert.ok(r.sent.some((s) => s.text === 'pong2'))
  assert.ok(r.sent.some((s) => s.text === '在呢～'), '她的回复经过了模块改写')
  const c = (await fake.call('/modules/simulate', { as: 'owner', kind: 'private', text: '/echo 你好' })).json()
  assert.ok(c.sent.some((s) => s.text === 'echo: 你好'))
  assert.match((await fake.call('/modules/simulate', { as: 'owner', text: '/off' })).json().steps[0], /不执行/)
  assert.equal(api.getConfig().enabled, true)
  const tools = (await fake.call('/modules/tools?as=owner&kind=private')).json()
  assert.equal(tools.level, 'full')
  assert.ok(tools.list.some((t) => t.name === 'echo_tool'))
  const t = (await fake.call('/modules/tool', { as: 'owner', kind: 'private', name: 'echo_tool', args: {} })).json()
  assert.equal(t.result.ok, true)
  assert.equal(mock.calls.filter((x) => /^send_/.test(x.action)).length, mock.calls.slice(0, before).filter((x) => /^send_/.test(x.action)).length, '没有真的发消息')
  assert.ok(existsSync(join(dataDir, 'modules', 'aurabot.d.ts')), '类型提示放好了')
})

test('只看 API.md 从零写出来的模块（查天气）能直接加载：命令、工具、设置都挂上了', async () => {
  mkdirSync(modDir('weather'), { recursive: true })
  writeFileSync(join(modDir('weather'), 'index.mjs'), readFileSync(new URL('./fixtures/weather/index.mjs', import.meta.url)))
  const m = await until(async () => { const x = await mod('weather'); return x?.running === 'user' ? x : null }, 15000)
  assert.deepEqual(m.commands, ['天气'])
  assert.deepEqual(m.tools, ['weather_now'])
  assert.equal(m.settings.length, 3)
  assert.equal(api.getConfig().ext.weather.city, '北京', '默认值写进了配置')
  assert.match(fake.variables.get('aurabot_rules_private')(), /你会查天气/)
})

test('api.reply 在群里以引用回复发出；api.isOwner 认得主人', async () => {
  writeMod('reply-demo', `export default { id: 'reply-demo', api: 1, setup(api) {
    api.on('message', async (msg) => { if (msg.text !== '引用我') return false; await api.reply(msg, api.isOwner(msg.userId) ? '主人好' : '你好'); return true })
  } }`)
  await until(async () => (await mod('reply-demo'))?.running === 'user')
  mock.push({ message_type: 'group', sub_type: 'normal', group_id: 777, user_id: 123456, message_id: 4242, sender: { user_id: 123456, nickname: '群友', card: '群友', role: 'member' }, message: [{ type: 'text', data: { text: '引用我' } }] })
  const c = await until(() => mock.calls.find((x) => x.action === 'send_group_msg' && x.params.message.some((s) => s.data?.text === '你好')))
  assert.ok(c.params.message.some((s) => s.type === 'reply' && String(s.data.id) === '4242'))
})

test('#3 表情：按范围排队导入 QQ 收藏、待审隔离；主人收藏后显式批准才同步', async (t) => {
  const chatId = `private:${OWNER}`
  const query = `/stickers?chatId=${chatId}`
  const fixtures = new Map([1, 2].map((salt) => [`https://93.184.216.34/sticker-test/${salt}.png`, fakePng(200, 200, salt)]))
  const realFetch = globalThis.fetch
  // 只拦截此测试的公开 URL，不发外网请求，也不放宽生产代码的 SSRF 检查。
  t.mock.method(globalThis, 'fetch', async (url, options) => fixtures.has(String(url))
    ? new Response(fixtures.get(String(url)), { headers: { 'content-type': 'image/png' } }) : realFetch(url, options))
  mock.state.favorites = [...fixtures.keys()].map((url, i) => ({ url, ...(i === 0 ? { emoji_id: 'existing-1' } : {}) }))
  const adds = mock.sent('add_custom_face').length
  assert.equal((await fake.call('/sticker/import-qq', {})).json().ok, false, '导入必须指定聊天范围')
  const r = (await fake.call('/sticker/import-qq', { chatId })).json()
  assert.equal(r.ok, true, r.message)
  assert.ok(r.taskId)
  const taskDone = (id) => until(async () => (await fake.call(`/stickers/queue?kind=import&chatId=${chatId}`)).json().items.find((task) => task.id === id && task.state === 'done'))
  assert.deepEqual((await taskDone(r.taskId)).output, { added: 2, existed: 0, failed: 0, total: 2 })
  const again = (await fake.call('/sticker/import-qq', { chatId })).json()
  const repeated = await taskDone(again.taskId)
  // 同分钟复用任务；跨分钟再次扫描也只能去重，不能产生新素材。
  assert.equal(repeated.output.added, again.taskId === r.taskId ? 2 : 0)
  if (again.taskId !== r.taskId) assert.equal(repeated.output.existed, 2)
  const lib = (await fake.call(query)).json().items.filter((i) => i.from === 'qq')
  assert.equal(lib.length, 2)
  assert.ok(lib.every((i) => i.state === 'pending' && i.scope.account === BOT && i.scope.chat === chatId))
  const confirmed = lib.find((i) => i.qq.emojiId === 'existing-1')
  assert.equal(confirmed.qq.state, 'synced', 'QQ 收藏已存在不代表本地已经批准')
  assert.equal(lib.find((i) => !i.qq.emojiId).qq.state, 'unidentified', '没有 QQ ID 时不能伪造已同步身份')
  assert.equal(api.stickers.match(confirmed.id, chatId), null)
  assert.equal((await fake.call('/sticker/approve', { id: confirmed.id })).json().item.state, 'approved')
  assert.equal(api.stickers.match(confirmed.id, chatId).id, confirmed.id)
  assert.equal(api.stickers.match(confirmed.id, 'group:777'), null)
  assert.equal(mock.sent('add_custom_face').length, adds, '导入不向 QQ 重复添加')

  // 主人私聊发来一张表情，再让她存（模拟测试里调工具）
  const png = fakePng(180, 180, 7)
  const seg = { type: 'image', data: { file: 'base64://' + png.toString('base64'), sub_type: 1, summary: '[动画表情]' } }
  mock.push(priv('看这个'))
  mock.push({ message_type: 'private', sub_type: 'friend', user_id: Number(OWNER), message_id: 777, sender: { user_id: Number(OWNER), nickname: 'xiaoming' }, message: [seg] })
  await until(() => api.hub.recentMedia(chatId).some((media) => media.seg.data.file === seg.data.file))
  const saved = (await fake.call('/modules/tool', { as: 'owner', kind: 'private', name: 'qq_save_sticker', args: { name: '测试表情' } })).json()
  assert.equal(saved.ok, true, saved.message)
  assert.equal(saved.result.ok, true, saved.result.message)
  assert.match(saved.result.message, /本地已保存.*待审核/)
  assert.equal(saved.result.item.state, 'pending')
  assert.equal(saved.result.item.scope.chat, chatId)
  assert.equal(api.stickers.segmentFor(saved.result.item, chatId), null)
  assert.equal(mock.sent('add_custom_face').length, adds)
  const other = (await fake.call('/modules/tool', { as: 'other', kind: 'private', name: 'qq_save_sticker', args: {} })).json()
  assert.ok(!other.ok || other.result.ok === false, '别人让她存不行')
  assert.equal((await fake.call('/sticker/approve', { id: saved.result.item.id })).json().item.state, 'approved')
  await until(() => api.stickers.status(saved.result.item.id, { admin: true }).qq.state === 'synced')
  assert.equal(mock.sent('add_custom_face').length, adds + 1)
})

test('#3 控制台密码：不合格的不会只改配置；主人设的密码要真的去 SnowLuma 改', async () => {
  const before = api.getConfig().snowluma.webuiPassword
  const r = (await fake.call('/save', { snowluma: { webuiPassword: 'weak' } })).json()
  assert.equal(r.ok, false)
  assert.match(r.message, /控制台密码没改.*至少 10 位/)
  assert.equal(api.getConfig().snowluma.webuiPassword, before)
  const { passwordProblems } = await import('../src/snowluma/manager.js')
  assert.deepEqual(passwordProblems('Abcdefgh1!'), [])
  assert.deepEqual(passwordProblems('abc def'), ['至少 10 位', '要有大写字母', '要有符号（比如 ! @ #）', '不能有空格'])
  // 这台测试机没装 SnowLuma：好密码也改不了，会说清原因，配置不动
  const g = (await fake.call('/save', { snowluma: { webuiPassword: 'Abcdefgh1!' } })).json()
  assert.equal(g.ok, false)
  assert.equal(api.getConfig().snowluma.webuiPassword, before)
})

test('#1 重新连接：等结果再回话，连上了就说连上了', async () => {
  const r = (await fake.call('/onebot/reconnect')).json()
  assert.equal(r.ok, true, r.message)
  assert.equal(r.message, '连上了')
  assert.equal((await fake.call('/state')).json().onebot.problem, '')
})

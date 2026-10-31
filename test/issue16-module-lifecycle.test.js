// 模块 import / setup 跨过插件卸载时，不能复活旧模块或留下定时任务。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModules } from '../src/core/modules.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const silent = { info() {}, debug() {}, warn() {}, error() {} }

async function bounded(promise) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('等待测试模块超时')), 3000)
    })])
  } finally { clearTimeout(timer) }
}

function fixture(t, { core = {}, builtins = [], onSetConfig } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-module-lifecycle-'))
  const previousDir = process.env.AURABOT_DATA_DIR
  const previousGlobal = globalThis.aurabot
  process.env.AURABOT_DATA_DIR = dir
  let cfg = { modules: {}, ext: {}, safeMode: false, debug: false }
  const warnings = []
  const modules = createModules({
    ctx: {}, core, getConfig: () => cfg, setConfig: (next) => { cfg = onSetConfig ? onSetConfig(next) : next },
    logger: { child: () => ({ ...silent, warn: (...args) => warnings.push(args.join(' ')) }) }, version: 'test', builtins,
  })
  t.after(() => {
    modules.dispose()
    if (previousDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previousDir
    if (previousGlobal === undefined) delete globalThis.aurabot
    else globalThis.aurabot = previousGlobal
  })
  return {
    modules,
    warnings,
    config: () => cfg,
    setConfig: (next) => { cfg = next },
    write(id, code) {
      const path = join(dir, 'modules', id)
      mkdirSync(path, { recursive: true })
      writeFileSync(join(path, 'index.mjs'), code)
    },
  }
}

function gate(t) {
  const key = '__aurabot_module_lifecycle_' + randomUUID()
  let enter, release
  const entered = new Promise((resolve) => { enter = resolve })
  const ready = new Promise((resolve) => { release = resolve })
  const state = { enter, ready, setups: 0, disposed: 0, cleanups: 0, events: 0, delayed: 0, ticks: 0 }
  globalThis[key] = state
  // 断言失败时也释放动态 import / setup，避免未完成的模块评估挂住进程。
  t.after(() => { release(); delete globalThis[key] })
  return { state, entered, release, source: 'globalThis[' + JSON.stringify(key) + ']' }
}

test('boot 已完成后，在途用户模块 import 不会在卸载后启动', async (t) => {
  const f = fixture(t)
  await f.modules.boot()
  const g = gate(t)
  f.write('slow-import', `
    const gate = ${g.source}
    gate.enter()
    await gate.ready
    export default { id: 'slow-import', api: 1, setup(api) {
      gate.setups++
      api.later(0, () => gate.delayed++)
      api.route('/late', () => ({ ok: true }))
      return {}
    } }
  `)
  const syncing = f.modules.sync()
  t.after(async () => { g.release(); await syncing })
  await bounded(g.entered)
  f.modules.dispose()
  g.release()
  await bounded(syncing)
  await f.modules.sync()
  await sleep(15)
  assert.equal(g.state.setups, 0)
  assert.equal(g.state.delayed, 0)
  assert.equal(f.modules.has('slow-import'), false)
  assert.equal(f.modules.hasRoute('/aurabot/api/ext/slow-import/late'), false)
})

test('异步 setup 跨过停止或卸载后，迟到资源和 exports 都会被清理', async (t) => {
  for (const action of ['stop', 'dispose']) await t.test(action, async (t) => {
    const f = fixture(t)
    await f.modules.boot()
    const g = gate(t)
    f.write('slow-setup', `
      const gate = ${g.source}
      export default { id: 'slow-setup', api: 1, async setup(api) {
        gate.enter()
        await gate.ready
        api.onDispose(() => gate.cleanups++)
        api.later(0, () => gate.delayed++)
        api.every(1000, () => gate.ticks++)
        api.route('/late', () => ({ ok: true }))
        api.on('late-event', () => gate.events++)
        return { dispose() { gate.disposed++ } }
      } }
    `)
    const interval = t.mock.method(globalThis, 'setInterval')
    const clear = t.mock.method(globalThis, 'clearInterval')
    const syncing = f.modules.sync()
    t.after(async () => { g.release(); await syncing })
    await bounded(g.entered)
    if (action === 'dispose') f.modules.dispose()
    else f.modules.stop('slow-setup', { quiet: true })
    g.release()
    await bounded(syncing)
    f.modules.emit('late-event')
    await sleep(20)
    assert.equal(g.state.cleanups, 1, '迟到 onDispose 立即清理')
    assert.equal(g.state.disposed, 1, '迟到 setup 返回的导出也要 dispose')
    assert.equal(g.state.delayed, 0)
    assert.equal(g.state.ticks, 0)
    assert.equal(g.state.events, 0)
    assert.equal(f.modules.has('slow-setup'), false)
    assert.equal(f.modules.hasRoute('/aurabot/api/ext/slow-setup/late'), false)
    assert.equal(interval.mock.calls.length, 1)
    const timer = interval.mock.calls[0].result
    assert.ok(clear.mock.calls.some((call) => call.arguments[0] === timer), '迟到 interval 已撤销')
    f.modules.dispose()
    assert.equal(g.state.disposed, 1, '重复卸载不会重复销毁导出')
  })
})

test('导入途中关闭模块、开启安全模式或停止模块，导入结束后不执行 setup', async (t) => {
  for (const action of ['disable', 'safeMode', 'stop']) await t.test(action, async (t) => {
    const f = fixture(t)
    await f.modules.boot()
    const g = gate(t)
    f.write('slow-import', `
      const gate = ${g.source}
      gate.enter()
      await gate.ready
      export default { id: 'slow-import', setup() { gate.setups++; return {} } }
    `)
    const syncing = f.modules.sync()
    t.after(async () => { g.release(); await syncing })
    await bounded(g.entered)
    if (action === 'disable') f.setConfig({ ...f.config(), modules: { 'slow-import': { enabled: false } } })
    if (action === 'safeMode') f.setConfig({ ...f.config(), safeMode: true })
    if (action === 'stop') f.modules.stop('slow-import')
    // 模拟面板保存配置时触发的同步；直接 stop 不重新发起加载。
    const updated = action === 'stop' ? syncing : f.modules.sync()
    g.release()
    await bounded(Promise.all([syncing, updated]))
    assert.equal(g.state.setups, 0)
    assert.equal(f.modules.has('slow-import'), false)
  })
})

test('旧实例清理时启动同名新实例，路由和监听器仍属于新实例', async (t) => {
  let f
  let starts = 0
  const events = []
  const builtin = { id: 'same-id', setup(api) {
    const instance = ++starts
    api.route('/probe', () => ({ instance }))
    api.on('probe', () => events.push(instance))
    if (instance === 1) api.onDispose(() => { f.modules.sync() })
    return {}
  } }
  f = fixture(t, { builtins: [builtin] })
  await f.modules.boot()
  f.modules.stop('same-id')
  assert.equal(starts, 2)
  assert.deepEqual(await f.modules.handle('/aurabot/api/probe'), { instance: 2 })
  await f.modules.emit('probe')
  assert.deepEqual(events, [2])
})


test('API 2 stop awaits asynchronous disposer and continues after rejection', async t => {
  const events = []
  let release
  const done = new Promise(resolve => { release = resolve })
  const f = fixture(t, { builtins: [{ id: 'async-stop', setup(api) {
    api.onDispose(async () => { await done; events.push('finished') })
    api.onDispose(() => { throw new Error('cleanup failure') })
    return {}
  } }] })
  await f.modules.boot()
  let stopped = false
  const stopping = f.modules.stop('async-stop').then(() => { stopped = true })
  await Promise.resolve(); assert.equal(stopped, false)
  release(); await stopping
  assert.deepEqual(events, ['finished']); assert.equal(stopped, true)
})

test('a stopped instance cannot overwrite a replacement route after an async disposer resumes', async t => {
  let f, release
  const gate = new Promise(resolve => { release = resolve })
  let starts = 0
  f = fixture(t, { builtins: [{ id: 'late-route', setup(api) {
    const instance = ++starts
    api.route('/owned-route', () => ({ instance }))
    if (instance === 1) api.onDispose(async () => {
      void f.modules.sync()
      await gate
      api.route('/owned-route', () => ({ instance }))
    })
    return {}
  } }] })
  await f.modules.boot()
  const stopping = f.modules.stop('late-route')
  assert.equal(starts, 2)
  release()
  await bounded(stopping)
  assert.deepEqual(await f.modules.handle('/aurabot/api/owned-route'), { instance: 2 })
})

test('stop waits for recursively registered asynchronous late cleanup', async t => {
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  const events = []
  const f = fixture(t, { builtins: [{ id: 'late-cleanup', setup(api) {
    api.onDispose(async () => {
      await Promise.resolve()
      api.onDispose(async () => { entered(); await gate; events.push('nested') })
    })
    return {}
  } }] })
  t.after(release)
  await f.modules.boot()
  let stopped = false
  const stopping = f.modules.stop('late-cleanup').then(() => { stopped = true })
  await bounded(started)
  await Promise.resolve()
  assert.equal(stopped, false)
  release()
  await bounded(stopping)
  assert.deepEqual(events, ['nested'])
})

test('a config sync requested while stopping is reconciled after async cleanup', async t => {
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  let starts = 0
  const f = fixture(t, { builtins: [{ id: 'sync-again', setup(api) {
    if (++starts === 1) api.onDispose(async () => { entered(); await gate })
    return {}
  } }] })
  t.after(release)
  await f.modules.boot()
  f.setConfig({ ...f.config(), modules: { 'sync-again': { enabled: false } } })
  const first = f.modules.sync()
  await bounded(started)
  f.setConfig({ ...f.config(), modules: { 'sync-again': { enabled: true } } })
  const second = f.modules.sync()
  release()
  await bounded(Promise.all([first, second]))
  assert.equal(f.modules.has('sync-again'), true)
  assert.equal(starts, 2)
})

test('retained DSH module tool from a stopped instance cannot execute', async t => {
  let calls = 0
  const f = fixture(t, { core: { bridge: { refresh() {} } }, builtins: [{ id: 'late-tool', setup(api) {
    api.dshTool({ name: 'late_tool', execute: () => { calls++; return { ok: true } } })
    return {}
  } }] })
  await f.modules.boot()
  const tool = f.modules.dshTools()[0]
  assert.equal((await tool.execute()).ok, true)
  await f.modules.stop('late-tool')
  assert.equal((await tool.execute()).ok, false)
  assert.equal(calls, 1)
})

test('stopping an import of a builtin replacement does not start the builtin as a fallback', async t => {
  let builtinStarts = 0
  const f = fixture(t, { builtins: [{ id: 'slow-import', setup() { builtinStarts++; return {} } }] })
  const g = gate(t)
  f.write('slow-import', `
    const gate = ${g.source}
    gate.enter()
    await gate.ready
    export default { id: 'slow-import', setup() { gate.setups++; return {} } }
  `)
  const booting = f.modules.boot()
  t.after(async () => { g.release(); await booting })
  await bounded(g.entered)
  f.modules.stop('slow-import')
  g.release()
  await bounded(booting)
  assert.equal(g.state.setups, 0)
  assert.equal(builtinStarts, 0)
  assert.equal(f.modules.has('slow-import'), false)
})

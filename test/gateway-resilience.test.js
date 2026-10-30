// #10：SnowLuma 启动前先探测 OneBot。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createNet } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSnowLumaManager, endpointHostPort, gatewayHealthy, portOpen, waitPortFree } from '../src/snowluma/manager.js'

const reply = (data, ok = true) => async () => ({ ok, json: async () => data })
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.() })

test('endpointHostPort', () => {
  assert.deepEqual(endpointHostPort('http://127.0.0.1:3000/x'), { host: '127.0.0.1', port: 3000 })
  assert.deepEqual(endpointHostPort('ws://localhost'), { host: 'localhost', port: 80 })
  assert.equal(endpointHostPort(''), null)
})

test('gatewayHealthy：只有 ok / retcode 0 才算活着', async () => {
  const ep = { httpUrl: 'http://x', httpToken: 't' }
  assert.equal(await gatewayHealthy(ep, { fetchImpl: reply({ status: 'ok' }) }), true)
  assert.equal(await gatewayHealthy(ep, { fetchImpl: reply({ retcode: 0 }) }), true)
  assert.equal(await gatewayHealthy(ep, { fetchImpl: reply({ retcode: 1404 }) }), false)
  assert.equal(await gatewayHealthy(ep, { fetchImpl: async () => { throw new Error('refused') } }), false)
  assert.equal(await gatewayHealthy({ httpUrl: '' }), false)
})

test('gatewayHealthy 带令牌、用 POST', async () => {
  let seen
  await gatewayHealthy({ httpUrl: 'http://x/', httpToken: 'secret' }, { fetchImpl: async (url, init) => { seen = { url, init }; return { json: async () => ({ status: 'ok' }) } } })
  assert.equal(seen.url, 'http://x/get_login_info')
  assert.equal(seen.init.method, 'POST')
  assert.equal(seen.init.headers.authorization, 'Bearer secret')
})

test('portOpen / waitPortFree', async () => {
  const server = createNet((socket) => socket.destroy()), port = await listen(server), hostPort = { host: '127.0.0.1', port }
  assert.equal(await portOpen(hostPort), true)
  assert.equal(await waitPortFree(hostPort, { timeoutMs: 30, intervalMs: 10 }), false)
  setTimeout(() => server.close(), 30)
  assert.equal(await waitPortFree(hostPort, { timeoutMs: 2000, intervalMs: 10 }), true)
  assert.equal(await portOpen(hostPort), false)
})

async function install(t, onebotPort, botQQ = '20000002') {
  const dir = mkdtempSync(join(tmpdir(), 'fake-snowluma-gw-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const probe = createNet(), webuiPort = await listen(probe)
  await close(probe)
  mkdirSync(join(dir, 'config'))
  writeFileSync(join(dir, 'config', 'webui.json'), '{}')
  writeFileSync(join(dir, 'index.mjs'), `import fs from 'node:fs'; import http from 'node:http'; fs.writeFileSync('spawned', '1'); http.createServer((q, s) => s.end('{}')).listen(${webuiPort}, '127.0.0.1')`)
  writeFileSync(join(dir, 'config', `onebot_${botQQ}.json`), JSON.stringify({ networks: { httpServers: [{ host: '127.0.0.1', port: onebotPort }] } }))
  const manager = createSnowLumaManager({ getConfig: () => ({ botQQ, snowluma: { dir, webuiPort, webuiPassword: 'x' } }), log: { info() {}, warn() {}, debug() {} }, portWaitMs: 60 })
  t.after(() => manager.dispose())
  return { dir, manager }
}
const spawned = async (dir) => { for (let i = 0; i < 100 && !existsSync(join(dir, 'spawned')); i++) await new Promise((resolve) => setTimeout(resolve, 20)); return existsSync(join(dir, 'spawned')) }

test('已有健康网关：复用，不起第二个实例；按 getConfig().botQQ 读配置', async (t) => {
  const server = createServer((_req, res) => res.end(JSON.stringify({ status: 'ok', data: { user_id: 20000002 } }))), port = await listen(server)
  t.after(() => close(server))
  const { dir, manager } = await install(t, port)
  const r = await manager.start()
  assert.match(r.message, /复用/)
  assert.equal(existsSync(join(dir, 'spawned')), false)
})

test('端口被占且没有 OneBot 应答：等完仍然启动，不误判复用', async (t) => {
  const server = createNet((socket) => socket.destroy()), port = await listen(server)
  t.after(() => close(server))
  const { dir, manager } = await install(t, port)
  assert.equal((await manager.start()).ok, true)
  assert.equal(await spawned(dir), true)
})

test('端口空闲：正常启动', async (t) => {
  const server = createNet((socket) => socket.destroy()), port = await listen(server)
  await close(server)
  const { dir, manager } = await install(t, port)
  assert.equal((await manager.start()).ok, true)
  assert.equal(await spawned(dir), true)
})

// #8：发文件。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../src/core/config.js'
import { checkLocalFile, displayName, FILE_BASE64_MAX } from '../src/delivery/files.js'
import { OneBotError } from '../src/onebot/client.js'
import qqTools from '../src/modules/qq-tools/index.js'
import { hubFixture, OWNER, GROUP, privateChat } from './helpers/hub-fixture.js'

function tree(t) {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-files-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const allowed = join(root, 'allowed'), outside = join(root, 'outside')
  mkdirSync(allowed); mkdirSync(outside); mkdirSync(join(allowed, 'dir')); mkdirSync(join(allowed, '.ssh'))
  writeFileSync(join(allowed, 'ok.txt'), 'hello')
  writeFileSync(join(allowed, '.env'), 'SECRET=1')
  writeFileSync(join(allowed, '.ssh', 'config'), 'x')
  writeFileSync(join(allowed, 'server.pem'), 'x')
  writeFileSync(join(outside, 'secret.txt'), 'nope')
  symlinkSync(join(outside, 'secret.txt'), join(allowed, 'link.txt'))
  symlinkSync(outside, join(allowed, 'linkdir'))
  return { root, allowed, outside, opts: { roots: [allowed], maxBytes: 1024 } }
}
const rejected = (fn, re) => assert.throws(fn, e => e.code === 'FILE_REJECTED' && re.test(e.message))

test('白名单内普通文件放行，返回真实路径', t => {
  const f = tree(t), r = checkLocalFile(join(f.allowed, 'ok.txt'), f.opts)
  assert.equal(r.name, 'ok.txt')
  assert.equal(r.size, 5)
})

test('越界、.. 穿越、符号链接逃逸都拒绝', t => {
  const f = tree(t)
  rejected(() => checkLocalFile(join(f.outside, 'secret.txt'), f.opts), /不在允许/)
  rejected(() => checkLocalFile(join(f.allowed, '..', 'outside', 'secret.txt'), f.opts), /不在允许/)
  rejected(() => checkLocalFile(join(f.allowed, 'link.txt'), f.opts), /不在允许/)
  rejected(() => checkLocalFile(join(f.allowed, 'linkdir', 'secret.txt'), f.opts), /不在允许/)
})

test('相对路径、不存在、目录、超限都拒绝', t => {
  const f = tree(t)
  rejected(() => checkLocalFile('ok.txt', f.opts), /绝对路径/)
  rejected(() => checkLocalFile(join(f.allowed, '没有.txt'), f.opts), /找不到/)
  rejected(() => checkLocalFile(join(f.allowed, 'dir'), f.opts), /不是一个文件/)
  rejected(() => checkLocalFile(join(f.allowed, 'ok.txt'), { ...f.opts, maxBytes: 1 }), /太大/)
  rejected(() => checkLocalFile(f.allowed, f.opts), /不在允许/)
})

test('密钥类文件和敏感目录一律不发', t => {
  const f = tree(t)
  for (const path of ['.env', '.ssh/config', 'server.pem']) rejected(() => checkLocalFile(join(f.allowed, path), f.opts), /密钥/)
  rejected(() => checkLocalFile(join(f.allowed, 'ok.txt'), { ...f.opts, denied: [f.allowed] }), /密钥/)
})

test('文件名去掉路径和控制字符', () => {
  assert.equal(displayName('../a\\b:c\n.txt'), '..abc.txt')
  assert.equal(displayName('   ', '备用'), '备用')
})

test('配置：默认关，只留绝对路径', () => {
  const c = normalize({ files: { dirs: ['relative/x', 'C:\\ok', '/ok', '  '] } })
  assert.equal(c.files.enabled, false)
  assert.deepEqual(c.files.dirs, ['C:\\ok', '/ok'])
  assert.equal(normalize({ files: { maxMB: 99999 } }).files.maxMB, 2048)
})

async function fixture(t, gateway = async () => ({}), config = {}) {
  const calls = [], dir = mkdtempSync(join(tmpdir(), 'aurabot-send-file-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const f = await hubFixture(t, { config: { files: { enabled: true, dirs: [dir], ...config } },
    onebot: { call: async (action, params, options) => { calls.push({ action, params, options }); return gateway(action, params) } } })
  const file = join(dir, 'a.txt')
  writeFileSync(file, 'hello')
  return { ...f, calls, file, dir }
}

test('群和私聊走各自的 upload 接口，超时给长', async t => {
  const f = await fixture(t)
  await f.hub.sendFile('group:' + GROUP, f.file, '报告.txt')
  await f.hub.sendFile('private:' + OWNER, f.file)
  assert.deepEqual(f.calls.map(c => c.action), ['upload_group_file', 'upload_private_file'])
  assert.equal(f.calls[0].params.group_id, Number(GROUP))
  assert.equal(f.calls[0].params.name, '报告.txt')
  assert.equal(f.calls[1].params.name, 'a.txt')
  assert.equal(f.calls[0].options.timeoutMs, 120000)
})

test('网关拒绝本机路径：小文件改 base64 重试成功', async t => {
  const f = await fixture(t, async (_, params) => {
    if (!params.file.startsWith('base64://')) throw new OneBotError('upload_private_file', { message: '找不到文件' })
    return {}
  })
  const r = await f.hub.sendFile('private:' + OWNER, f.file)
  assert.equal(r.delivered, 1)
  assert.equal(f.calls.at(-1).params.file, 'base64://' + Buffer.from('hello').toString('base64'))
})

test('本机路径被拒且超过 30MB：不走 base64，明确失败', async t => {
  const f = await fixture(t, async () => { throw new OneBotError('upload_private_file', { message: '找不到文件' }) }, { maxMB: 100 })
  const big = join(f.dir, 'big.bin')
  writeFileSync(big, '')
  truncateSync(big, FILE_BASE64_MAX + 1)
  await assert.rejects(f.hub.sendFile('private:' + OWNER, big), { code: 'DELIVERY_REJECTED' })
  assert.equal(f.calls.filter(c => String(c.params.file).startsWith('base64://')).length, 0)
})

test('超时：报 unknown，不重试也不走 base64', async t => {
  const f = await fixture(t, async () => { throw new OneBotError('upload_private_file', { message: '超时' }, 'unknown') })
  await assert.rejects(f.hub.sendFile('private:' + OWNER, f.file), { code: 'DELIVERY_UNKNOWN' })
  assert.equal(f.calls.length, 1)
})

test('功能关闭、越界路径都不碰网关', async t => {
  const off = await fixture(t, undefined, { enabled: false })
  await assert.rejects(off.hub.sendFile('private:' + OWNER, off.file), { code: 'FILE_DISABLED' })
  const on = await fixture(t)
  await assert.rejects(on.hub.sendFile('private:' + OWNER, '/etc/hosts'), { code: 'FILE_REJECTED' })
  assert.equal(on.calls.length + off.calls.length, 0)
})

test('试运行：不真传', async t => {
  const f = await fixture(t)
  f.cfg.dryRun = true
  assert.equal((await f.hub.sendFile('private:' + OWNER, f.file)).delivered, 0)
  assert.equal(f.calls.length, 0)
})

test('qq_send_file：只有完整权限且打开时才有；target 不在白名单拒绝；非主人拒绝', async t => {
  const f = await fixture(t)
  let build
  let owner = true
  qqTools.setup({ core: { hub: { ...f.hub, sendFile: f.hub.sendFile, turnSendersAllOwner: () => owner }, onebot: {}, storage: f.storage }, config: () => f.cfg, tool: fn => { build = fn } })
  const tools = level => build({ chat: privateChat(), level, sessionId: 's' })
  assert.equal(tools('social').some(x => x.name === 'qq_send_file'), false)
  const tool = tools('full').find(x => x.name === 'qq_send_file')
  assert.equal((await tool.execute({ file: f.file, target: 'group:999' })).ok, false)
  assert.equal(f.calls.length, 0)
  assert.equal((await tool.execute({ file: f.file })).ok, true)
  assert.equal(f.calls[0].action, 'upload_private_file')
  owner = false
  assert.match((await tool.execute({ file: f.file })).message, /只有主人/)
  f.cfg.files.enabled = false
  assert.equal(tools('full').some(x => x.name === 'qq_send_file'), false)
})

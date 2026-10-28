// 开发用：不开 DSH 也能在浏览器里看面板。用测试里的假 DSH + 假 QQ 网关跑真的宿主半边，
// 把 client/client.js 套上 React 渲染出来，/aurabot/api/* 转给宿主。数据放在临时目录，不碰真实数据。
//   node scripts/panel-preview.mjs [端口，默认 5180]

import http from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.argv[2]) || 5180
const dataDir = process.argv[3] ? resolve(process.argv[3]) : mkdtempSync(join(tmpdir(), 'aurabot-panel-'))
if (!dataDir.toLowerCase().startsWith(join(tmpdir(), 'aurabot-panel-').toLowerCase())) throw new Error('面板预览只使用临时 aurabot-panel- 目录')
process.env.AURABOT_DATA_DIR = dataDir
process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')

const imp = (p) => import(pathToFileURL(join(ROOT, p)).href)
const { startMockOneBot } = await imp('test/helpers/mock-onebot.js')
const { createFakeDsh } = await imp('test/helpers/fake-dsh.js')
const mock = await startMockOneBot({ selfId: '20000002' })
const previousConfig = existsSync(join(dataDir, 'config.json')) ? JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) : {}
writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
  enabled: true, dryRun: true, setupDone: true, botQQ: '20000002', ownerQQ: '10000001', ownerName: '主人',
  allow: { private: ['10000001'], groups: ['555', '666'] },
  ...previousConfig,
  snowluma: { autoStart: false, autoAttach: false, httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token, dir: join(dataDir, 'none') },
}))
const fake = createFakeDsh({ brain: async ({ text }) => (text.includes('在吗') ? '在呢' : '嗯') })
const host = await imp('src/host.js')
const api = host.apply(fake.ctx)
await api.ready
await fake.call('/onebot/reconnect')

const page = `<!doctype html><html><head><meta charset="utf-8"><title>Aurabot 面板预览</title>
<style>html,body,#root{height:100%;margin:0}body{font-family:system-ui,sans-serif}</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.development.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.development.js"></script>
</head><body><div id="root"></div><script>
window.__ModuleLoader__ = { load({ factory }) { window.__aurabot = factory((n) => (n === 'react' ? React : null)) } }
</script><script src="/client.js"></script><script>
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(window.__aurabot.AurabotPage))
</script></body></html>`

http.createServer(async (req, res) => {
  try {
    // 仅预览服务器提供的生图替身：返回仓库自带头像，用来验证上传、编辑、结果展示与发送状态。
    if (req.url === '/mock/v1/images/generations' || req.url === '/mock/v1/images/edits') {
      for await (const chunk of req) { /* 消费请求体 */ }
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ data: [{ b64_json: readFileSync(join(ROOT, 'assets', 'dafeiyu.jpg')).toString('base64') }] }))
    }
    if (req.url === '/' || req.url === '/index.html') { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(page) }
    if (req.url === '/client.js') { res.setHeader('content-type', 'text/javascript; charset=utf-8'); return res.end(readFileSync(join(ROOT, 'client', 'client.js'))) }
    if (req.url.startsWith('/aurabot/api')) {
      let body = ''
      for await (const c of req) body += c
      const r = await fake.call(req.url.slice('/aurabot/api'.length), body ? JSON.parse(body) : undefined)
      res.statusCode = r.status
      for (const [key, value] of Object.entries(r.headers)) res.setHeader(key, value)
      return res.end(r.raw())
    }
    res.statusCode = 404
    res.end('not found')
  } catch (error) {
    res.statusCode = 500
    res.end(JSON.stringify({ ok: false, message: error.message }))
  }
}).listen(PORT, '127.0.0.1', () => console.log(`面板预览：http://127.0.0.1:${PORT}/ （数据目录 ${dataDir}）`))

// 测试用的假语音服务：兼容 OpenAI 的 POST /v1/audio/speech，返回一小段 WAV。记下每次请求。
import http from 'node:http'
import { buildWav } from '../../src/voice/wav.js'

export async function startMockTts() {
  const calls = []
  const wav = buildWav(new Int16Array(24000 / 4), 24000)
  const srv = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    let json = null
    try { json = JSON.parse(body) } catch (error) {}
    calls.push({ url: req.url, method: req.method, auth: req.headers.authorization || '', json })
    if (req.method === 'POST' && req.url === '/v1/audio/speech') {
      res.setHeader('content-type', 'audio/wav')
      return res.end(wav)
    }
    res.statusCode = 404
    res.end('not found')
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, calls, close: () => new Promise((r) => srv.close(r)) }
}

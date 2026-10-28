// 测试用的假 QQ 网关：OneBot v11 HTTP + WS（Universal）。记录所有调用，能主动推事件。
import http from 'node:http'
import { createHash } from 'node:crypto'

function wsAccept(key) {
  return createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
}

function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8')
  const len = payload.length
  let head
  if (len < 126) head = Buffer.from([0x81, len])
  else if (len < 65536) {
    head = Buffer.alloc(4)
    head[0] = 0x81; head[1] = 126; head.writeUInt16BE(len, 2)
  } else {
    head = Buffer.alloc(10)
    head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([head, payload])
}

function decodeFrames(buf) {
  const out = []
  let i = 0
  while (i + 2 <= buf.length) {
    const op = buf[i] & 0x0f
    let len = buf[i + 1] & 0x7f
    const masked = buf[i + 1] & 0x80
    let p = i + 2
    if (len === 126) { len = buf.readUInt16BE(p); p += 2 } else if (len === 127) { len = Number(buf.readBigUInt64BE(p)); p += 8 }
    let mask
    if (masked) { mask = buf.subarray(p, p + 4); p += 4 }
    if (p + len > buf.length) break
    const data = Buffer.from(buf.subarray(p, p + len))
    if (mask) for (let k = 0; k < data.length; k++) data[k] ^= mask[k % 4]
    out.push({ op, data })
    i = p + len
  }
  return { frames: out, rest: buf.subarray(i) }
}

export async function startMockOneBot({ selfId = '20000002', token = 'mock-token-abcdef' } = {}) {
  const calls = []
  const sockets = new Set()
  let msgSeq = 1000
  const faces = new Map()
  const state = { failRecord: false, roles: {}, favorites: [] } // favorites：机器人号 QQ 收藏表情的地址 // roles: 群号 → 机器人在群里的身份（默认群主）

  function handle(action, params) {
    calls.push({ action, params, t: Date.now() })
    switch (action) {
      case 'get_login_info': return { user_id: Number(selfId), nickname: '大肥鱼' }
      case 'send_private_msg':
      case 'send_group_msg':
        if (state.failRecord && params.message?.[0]?.type === 'record') throw new Error('record not supported')
        return { message_id: ++msgSeq }
      case 'get_group_member_info': return { group_id: params.group_id, user_id: params.user_id, role: state.roles[String(params.group_id)] || 'owner' }
      case 'get_group_info': return { group_id: params.group_id, group_name: '测试群' }
      case 'get_msg': return { message_id: params.message_id, sender: { user_id: 1 } }
      case 'add_custom_face': {
        const id = 'emoji-' + (faces.size + 1)
        faces.set(id, '')
        return { emoji_id: id }
      }
      case 'fetch_custom_face': return state.favorites.slice(0, params.count || 48)
      case 'modify_custom_face': faces.set(params.emoji_id, params.desc); return null
      case 'delete_custom_face': faces.delete(params.emoji_id); return null
      case 'get_forward_msg': return { messages: (state.forwards || {})[params.id] || [] }
      case 'send_poke': return null
      case 'get_group_msg_history': case 'get_friend_msg_history': return { messages: state.history || [] }
      case 'get_stranger_info': return { user_id: params.user_id, nickname: '路人' + params.user_id }
      case 'fetch_ptt_text': return { text: '今天想吃白米饭' }
      case 'set_group_ban': case 'set_group_kick': case 'set_group_special_title': case '_send_group_notice': return null
      default: return null
    }
  }

  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.statusCode = 401
      return res.end(JSON.stringify({ status: 'failed', retcode: 1403 }))
    }
    const action = req.url.replace(/^\/+/, '').split('?')[0]
    res.setHeader('content-type', 'application/json')
    try {
      const data = handle(action, JSON.parse(body || '{}'))
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data }))
    } catch (error) {
      res.end(JSON.stringify({ status: 'failed', retcode: 100, message: error.message }))
    }
  })

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://x')
    if (url.searchParams.get('access_token') !== token) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
      return
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${wsAccept(req.headers['sec-websocket-key'])}\r\n\r\n`)
    sockets.add(socket)
    let pending = Buffer.alloc(0)
    socket.on('data', (d) => {
      pending = Buffer.concat([pending, d])
      const { frames, rest } = decodeFrames(pending)
      pending = rest
      for (const f of frames) {
        if (f.op === 8) { socket.end(); return }
        if (f.op !== 1) continue
        const m = JSON.parse(f.data.toString('utf8'))
        const data = handle(m.action, m.params || {})
        socket.write(encodeFrame(JSON.stringify({ status: 'ok', retcode: 0, data, echo: m.echo })))
      }
    })
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => sockets.delete(socket))
  })

  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  return {
    port,
    token,
    httpUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    calls,
    state,
    faces,
    connected: () => sockets.size,
    push(event) {
      const e = { time: Math.floor(Date.now() / 1000), self_id: Number(selfId), post_type: 'message', ...event }
      for (const s of sockets) s.write(encodeFrame(JSON.stringify(e)))
    },
    sent: (action) => calls.filter((c) => !action || c.action === action),
    async close() {
      for (const s of sockets) s.destroy()
      await new Promise((r) => server.close(r))
    },
  }
}

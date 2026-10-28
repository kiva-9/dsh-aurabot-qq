// OneBot v11 客户端：HTTP 调接口，WS（Universal）收事件，断线自动重连。
// 只依赖 Node 自带的 fetch / WebSocket。

const RECONNECT_MIN = 2000
const RECONNECT_MAX = 30000

/**
 * outcome 说明请求到底有没有到网关（发消息时决定能不能重发）：
 *   rejected 网关回了失败 / not_sent 根本没发出去（没连上、连接被拒）/ unknown 发出去了但没等到回应（超时、中途断线），可能已经送达
 */
export class OneBotError extends Error {
  constructor(action, data, outcome = 'rejected') {
    super(`${action} 失败：${data?.message || data?.wording || data?.retcode || '未知错误'}`)
    this.action = action
    this.data = data
    this.outcome = outcome
  }
}

// 这些网络错误说明请求没到对方，可以换条路再试
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'])
const notSent = (error) => NOT_SENT_CODES.has(error?.cause?.code || error?.code)

/**
 * @param {object} o
 * @param {() => {httpUrl:string, wsUrl:string, httpToken:string, wsToken:string}} o.endpoint 每次连接时现取
 * @param {(event: object) => void} o.onEvent
 * @param {(state: string, detail?: string) => void} [o.onState]
 * @param {{info:Function, warn:Function, debug:Function}} o.log
 */
export function createOneBotClient({ endpoint, onEvent, onState, log }) {
  let ws = null
  let stopped = true
  let timer = null
  let backoff = RECONNECT_MIN
  let state = 'stopped'
  let echoSeq = 0
  const pending = new Map()

  const setState = (s, detail) => {
    if (state === s) return
    state = s
    try { onState?.(s, detail) } catch (error) {}
  }

  async function call(action, params = {}, { timeoutMs = 30000 } = {}) {
    const ep = endpoint()
    if (ep.httpUrl) {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), timeoutMs)
      try {
        const headers = { 'content-type': 'application/json' }
        if (ep.httpToken) headers.authorization = `Bearer ${ep.httpToken}`
        const r = await fetch(`${ep.httpUrl.replace(/\/+$/, '')}/${action}`, {
          method: 'POST', headers, body: JSON.stringify(params), signal: ctrl.signal,
        })
        const j = await r.json().catch(() => ({ status: 'failed', retcode: r.status, message: `HTTP ${r.status}` }))
        if (j.status === 'ok' || j.retcode === 0) return j.data
        throw new OneBotError(action, j)
      } catch (error) {
        if (error instanceof OneBotError) throw error
        // 超时、读响应时断线：请求可能已经被执行了，不能换 WS 再发一遍（发消息会重复）
        if (!notSent(error)) throw new OneBotError(action, { message: error.name === 'AbortError' ? '超时' : error.message }, 'unknown')
        if (ws && ws.readyState === 1) return callWs(action, params, timeoutMs)
        throw new OneBotError(action, { message: error.message }, 'not_sent')
      } finally {
        clearTimeout(t)
      }
    }
    return callWs(action, params, timeoutMs)
  }

  function callWs(action, params, timeoutMs) {
    if (!ws || ws.readyState !== 1) return Promise.reject(new OneBotError(action, { message: '没连上 QQ 网关' }, 'not_sent'))
    const echo = `ab-${Date.now()}-${++echoSeq}`
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        pending.delete(echo)
        reject(new OneBotError(action, { message: '超时' }, 'unknown'))
      }, timeoutMs)
      pending.set(echo, { resolve, reject, t, action })
      ws.send(JSON.stringify({ action, params, echo }))
    })
  }

  function connect() {
    if (stopped) return
    const ep = endpoint()
    if (!ep.wsUrl) {
      setState('unconfigured', '没有 WS 地址')
      schedule()
      return
    }
    setState('connecting')
    let url = ep.wsUrl
    if (ep.wsToken) url += (url.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(ep.wsToken)
    let sock
    try {
      sock = new WebSocket(url)
    } catch (error) {
      log.warn('WS 连接失败：', error.message)
      schedule()
      return
    }
    ws = sock
    sock.onopen = () => {
      backoff = RECONNECT_MIN
      setState('connected')
      log.info('已连上 QQ 网关（WS）')
    }
    sock.onmessage = (ev) => {
      let data
      try { data = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')) } catch (error) { return }
      if (data && data.echo && pending.has(data.echo)) {
        const p = pending.get(data.echo)
        pending.delete(data.echo)
        clearTimeout(p.t)
        if (data.status === 'ok' || data.retcode === 0) p.resolve(data.data)
        else p.reject(new OneBotError(p.action, data))
        return
      }
      if (data && data.post_type) {
        try { onEvent(data) } catch (error) { log.warn('处理事件出错：', error.message) }
      }
    }
    sock.onclose = (ev) => {
      if (ws === sock) ws = null
      for (const [k, p] of pending) {
        clearTimeout(p.t)
        p.reject(new OneBotError(p.action, { message: '连接断开' }, 'unknown'))
        pending.delete(k)
      }
      if (!stopped) {
        setState('disconnected', `code ${ev?.code ?? ''}`)
        schedule()
      }
    }
    sock.onerror = () => {}
  }

  function schedule() {
    clearTimeout(timer)
    if (stopped) return
    timer = setTimeout(connect, backoff)
    backoff = Math.min(RECONNECT_MAX, backoff * 2)
  }

  return {
    call,
    start() {
      if (!stopped) return
      stopped = false
      backoff = RECONNECT_MIN
      connect()
    },
    stop() {
      stopped = true
      clearTimeout(timer)
      setState('stopped')
      try { ws?.close() } catch (error) {}
      ws = null
    },
    restart() {
      this.stop()
      this.start()
    },
    get state() {
      return state
    },
  }
}

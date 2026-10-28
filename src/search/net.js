import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { setTimeout as delay } from 'node:timers/promises'
import { SearchError, fail, checkSignal, abortable, deadline } from './errors.js'

function ipv6Words(ip) {
  let s = ip.toLowerCase()
  if (s.includes('.')) {
    const at = s.lastIndexOf(':')
    const p = s.slice(at + 1).split('.').map(Number)
    s = s.slice(0, at + 1) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16)
  }
  const [left, right] = s.split('::')
  const a = left ? left.split(':').map((p) => parseInt(p, 16)) : []
  const b = right ? right.split(':').map((p) => parseInt(p, 16)) : []
  return right === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill(0), ...b]
}

/** Fail closed on non-global addresses, including mapped IPv4, transition and reserved ranges. */
export function isPublicAddress(ip) {
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      // 192.0.0/24 is protocol assignments; 192.0.2/24 is documentation.
      // The rest of 192.0/16 includes real public sites (including IANA).
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113))
  }
  if (isIP(ip) !== 6) return false
  const w = ipv6Words(ip)
  // All IPv4 mapped/compatible addresses are refused, even when their embedded address is public.
  if (w[0] < 0x2000 || w[0] > 0x3fff || w[0] === 0x2002 || w[0] === 0x3fff) return false
  if (w[0] === 0x2001 && (w[1] < 0x200 || w[1] === 0xdb8)) return false
  return true
}

function isFakeDnsAddress(ip) {
  if (isIP(ip) === 4) { const [a,b] = ip.split('.').map(Number); return a === 198 && (b === 18 || b === 19) }
  if (isIP(ip) === 6) { const w = ipv6Words(ip); return w[0] === 0x2001 && w[1] === 2 && w[2] === 0 }
  return false
}

// Fixed trusted resolver origins and bootstrap IPs; never accept a profile-
// supplied resolver or follow redirects. A local fake-IP router can carry ONLY
// these two authenticated resolver connections. This is a trusted service origin,
// like the configured Tavily API, NOT an exception for untrusted source URLs.
// https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/
// https://developers.google.com/speed/public-dns/docs/doh/json
const DOH_RESOLVERS = [
  { url: 'https://cloudflare-dns.com/dns-query', ip: '1.1.1.1' },
  { url: 'https://dns.google/resolve', ip: '8.8.8.8' },
]
const dnsName = value => typeof value === 'string' ? value.toLowerCase().replace(/\.$/, '') : ''
const validDnsName = value => value.length <= 253 && value.split('.').every(s => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s))
function dohAnswers(data, host, type) {
  if (!data || data.Status !== 0 || data.TC !== false || data.CD === true || !Array.isArray(data.Question) || data.Question.length !== 1 ||
    dnsName(data.Question[0]?.name) !== host || data.Question[0]?.type !== type || (data.Answer !== undefined && !Array.isArray(data.Answer)) || (data.Answer?.length || 0) > 64) fail('DNS_INVALID_RESPONSE', '公共 DNS 返回无效或不完整的查询结果')
  const answers = data.Answer || [], names = new Set([host])
  for (let i = 0; i < 8; i++) for (const r of answers) {
    if (r?.type !== 5 || !names.has(dnsName(r.name))) continue
    const name = dnsName(r.data)
    if (!validDnsName(name)) fail('DNS_INVALID_RESPONSE', '公共 DNS 返回无效别名')
    names.add(name)
  }
  const addresses = []
  for (const r of answers) {
    if (r?.type !== 1 && r?.type !== 28) continue
    const family = r.type === 1 ? 4 : 6
    if (r.type !== type || !names.has(dnsName(r.name)) || isIP(r.data) !== family) fail('DNS_INVALID_RESPONSE', '公共 DNS 返回不匹配的地址记录')
    addresses.push({ address: r.data, family })
  }
  return addresses
}

/** Trusted injectable transport for offline tests. At most 2 resolvers x A/AAAA;
 * 64 KiB per response, 6s total, TLS hostname verification, no redirects/retries.
 * Only the fake-IP branch below calls this; literal reserved IPs remain forbidden.
 */
export function createDohLookup({ request = httpsRequest, bootstrapLookup = dnsLookup, timeoutMs = 6000, resolverTimeoutMs = 2500 } = {}) {
  function query(resolver, host, type, signal, bootstrap) {
    const url = new URL(resolver.url)
    url.searchParams.set('name', host); url.searchParams.set('type', String(type)); url.searchParams.set('cd', 'false')
    if (url.hostname === 'dns.google') url.searchParams.set('edns_client_subnet', '0.0.0.0/0')
    checkSignal(signal)
    return new Promise((resolve, reject) => {
      const req = request(url, { method: 'GET', signal, agent: false, servername: url.hostname, rejectUnauthorized: true,
        headers: { accept: 'application/dns-json', 'accept-encoding': 'identity' }, maxHeaderSize: 16384,
        lookup(_host, options, callback) {
          if (typeof options === 'function') { callback = options; options = {} }
          callback(null, options?.all ? [bootstrap] : bootstrap.address, bootstrap.family)
        },
      }, res => {
        const bad = (code, message) => { reject(new SearchError(code, message)); res.destroy() }
        if (res.statusCode !== 200) return bad(res.statusCode >= 300 && res.statusCode < 400 ? 'DNS_INVALID_RESPONSE' : 'DNS_FAILED', '公共 DNS 请求未成功')
        if (!/^application\/(?:dns-json|json)\b/i.test(res.headers['content-type'] || '') ||
          (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') || Number(res.headers['content-length'] || 0) > 65536) return bad('DNS_INVALID_RESPONSE', '公共 DNS 响应类型或大小不合法')
        const chunks = []; let size = 0
        res.on('data', part => { size += part.length; if (size > 65536) bad('DNS_INVALID_RESPONSE', '公共 DNS 响应过大'); else chunks.push(part) })
        res.on('end', () => {
          try { resolve(dohAnswers(JSON.parse(Buffer.concat(chunks).toString('utf8')), host, type)) }
          catch (e) { reject(e instanceof SearchError ? e : new SearchError('DNS_INVALID_RESPONSE', '公共 DNS 未返回有效 JSON')) }
        })
        res.on('error', () => reject(new SearchError('DNS_FAILED', '公共 DNS 响应中断')))
        res.on('aborted', () => reject(new SearchError('DNS_FAILED', '公共 DNS 响应中断')))
      })
      req.on('error', () => reject(signal.aborted ? signal.reason : new SearchError('DNS_FAILED', '公共 DNS 连接失败')))
      req.end()
    })
  }
  return async (host, { signal } = {}) => {
    if (!validDnsName(host) || isIP(host)) fail('DNS_INVALID_RESPONSE', '公共 DNS 只解析有效域名')
    const total = deadline(Math.min(6000, timeoutMs), [signal])
    try {
      for (const resolver of DOH_RESOLVERS) {
        checkSignal(total.signal)
        const siblings = new AbortController()
        const attempt = deadline(Math.min(2500, resolverTimeoutMs), [total.signal, siblings.signal])
        try {
          let bootstrap = { address: resolver.ip, family: 4 }
          try {
            const local = await abortable(bootstrapLookup(new URL(resolver.url).hostname, { all: true, verbatim: true }), attempt.signal)
            // Clash may route only its synthetic destinations through the proxy.
            // The resolver hostname is hardcoded and TLS verification mandatory;
            // arbitrary private/system DNS answers never become connections.
            if (Array.isArray(local) && local.length && local.length <= 16 && local.every(a => isFakeDnsAddress(a?.address) && isIP(a.address) === a.family)) bootstrap = local[0]
          } catch { checkSignal(attempt.signal) }
          const parts = await abortable(Promise.all([1,28].map(type => query(resolver, host, type, attempt.signal, bootstrap))), attempt.signal)
          const addresses = parts.flat()
          if (!addresses.length) fail('DNS_INVALID_RESPONSE', '公共 DNS 没有返回可用地址')
          if (addresses.some(a => !isPublicAddress(a.address))) fail('UNSAFE_URL', '公共 DNS 包含私有、保留或混合解析地址')
          return [...new Map(addresses.map(a => [a.address, a])).values()]
        } catch (e) {
          checkSignal(total.signal)
          if (['UNSAFE_URL', 'DNS_INVALID_RESPONSE'].includes(e?.code)) throw e
          // Failover only for resolver transport failure, never for unsafe answers.
        } finally { siblings.abort(new SearchError('CANCELED', '公共 DNS 解析阶段已结束')); attempt.close() }
      }
      fail('DNS_FAILED', '无法完成可信公共 DNS 解析；未放行本机假 IP')
    } finally { total.close() }
  }
}
const publicDohLookup = createDohLookup()

export function parseWebUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || !/^https?:\/\//i.test(value) || /[\x00-\x20\x7f\\]/.test(value)) fail('UNSAFE_URL', '只允许有效的 HTTP(S) URL')
  let u
  try { u = new URL(value) } catch { fail('UNSAFE_URL', 'URL 不合法') }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || !u.hostname) fail('UNSAFE_URL', 'URL 协议或认证信息不允许')
  u.hash = ''
  return u
}

export function canonicalUrl(value, base) {
  try { return parseWebUrl(base ? new URL(value, base).href : value).href } catch { return null }
}

export async function resolvePublicUrl(value, { lookup = dnsLookup, dohLookup = publicDohLookup, signal } = {}) {
  const u = parseWebUrl(value)
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (/^(localhost|localhost\.localdomain|metadata\.google\.internal)$/.test(host) || /\.(localhost|local|internal|home|lan|test|invalid)$/.test(host) || (!host.includes('.') && !isIP(host))) fail('UNSAFE_URL', '禁止访问本机或内网主机')
  if (u.port && !['80', '443'].includes(u.port)) fail('UNSAFE_URL', '外部资料 URL 只允许 80/443 端口')
  let addresses
  try { addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await abortable(lookup(host, { all: true, verbatim: true }), signal) }
  catch (error) { checkSignal(signal); if (error instanceof SearchError) throw error; fail('DNS_FAILED', '无法解析来源主机') }
  let resolution = 'system-dns'
  if (!isIP(host) && Array.isArray(addresses) && addresses.length && addresses.every(a => isFakeDnsAddress(a.address))) {
    addresses = await abortable(dohLookup(host, { signal }), signal)
    resolution = 'public-doh-after-fake-ip'
  }
  if (!Array.isArray(addresses) || !addresses.length || addresses.length > 128 || addresses.some((a) => !isPublicAddress(a.address) || isIP(a.address) !== a.family)) fail('UNSAFE_URL', '禁止访问私有、保留或混合解析的网络地址')
  checkSignal(signal)
  return { url: u, addresses, resolution }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308])
const RETRY = new Set([408, 429, 500, 502, 503, 504])

/** Injectable DNS/request are trusted transport seams for local HTTP tests, never profile options. */
export function createSearchHttp({ lookup = dnsLookup, dohLookup = publicDohLookup, request } = {}) {
  async function once(url, opts, signal) {
    const u = parseWebUrl(url)
    const pinned = opts.publicOnly === false ? null : await resolvePublicUrl(u.href, { lookup, dohLookup, signal })
    checkSignal(signal)
    return new Promise((resolve, reject) => {
      const selected = pinned?.addresses[0]
      const lookupPinned = selected ? (_host, options, callback) => {
        if (typeof options === 'function') { callback = options; options = {} }
        callback(null, options?.all ? [selected] : selected.address, selected.family)
      } : undefined
      const options = {
        method: opts.method || 'GET', signal, agent: false, lookup: lookupPinned,
        ...(u.protocol === 'https:' ? { servername: isIP(u.hostname.replace(/^\[|\]$/g, '')) ? undefined : u.hostname, rejectUnauthorized: true } : {}),
        headers: { 'accept-encoding': 'identity', ...opts.headers }, maxHeaderSize: 16384,
      }
      const send = request || (u.protocol === 'https:' ? httpsRequest : httpRequest)
      const req = send(u, options, (res) => {
        const status = res.statusCode || 0
        const headers = res.headers
        if (REDIRECTS.has(status) || status >= 400 || options.method === 'HEAD') {
          resolve({ url: u.href, status, headers, body: Buffer.alloc(0), resolution: pinned?.resolution || null })
          res.destroy()
          return
        }
        const length = Number(headers['content-length'])
        if (Number.isFinite(length) && length > opts.maxBytes) { reject(new SearchError('TOO_LARGE', '响应超过大小限制')); res.destroy(); return }
        if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') { reject(new SearchError('ENCODING_UNSUPPORTED', '拒绝压缩的外部响应')); res.destroy(); return }
        const chunks = []
        let total = 0
        res.on('data', (part) => {
          total += part.length
          if (total > opts.maxBytes) { reject(new SearchError('TOO_LARGE', '响应超过大小限制')); res.destroy() }
          else chunks.push(part)
        })
        res.on('end', () => resolve({ url: u.href, status, headers, body: Buffer.concat(chunks), resolution: pinned?.resolution || null }))
        res.on('error', () => reject(new SearchError('NETWORK_FAILED', '读取网络响应失败')))
        res.on('aborted', () => reject(new SearchError('NETWORK_FAILED', '网络响应中途断开')))
      })
      req.on('error', () => reject(signal.aborted ? (signal.reason || new SearchError('CANCELED', '已取消')) : new SearchError('NETWORK_FAILED', '网络请求失败')))
      if (opts.body) req.write(opts.body)
      req.end()
    })
  }

  async function read(url, options = {}) {
    const opts = { method: 'GET', maxBytes: 1024 * 1024, timeoutMs: 30000, maxRedirects: 4, retries: 1, ...options }
    const d = deadline(opts.timeoutMs, [opts.signal])
    let current = url
    let redirects = 0
    let retries = 0
    const safeRead = ['GET', 'HEAD'].includes(opts.method)
    try {
      for (;;) {
        checkSignal(d.signal)
        let result
        try { result = await once(current, opts, d.signal) }
        catch (error) {
          checkSignal(d.signal)
          if (!safeRead || error.code !== 'NETWORK_FAILED' || retries >= Math.min(2, opts.retries)) throw error
        }
        if (!result || (safeRead && RETRY.has(result.status) && retries < Math.min(2, opts.retries))) {
          retries++
          const wait = Math.min(1000, Math.max(50 * 2 ** (retries - 1), Number(result?.headers['retry-after']) * 1000 || 0))
          await abortable(delay(wait, undefined, { signal: d.signal }), d.signal)
          continue
        }
        if (REDIRECTS.has(result.status)) {
          // Never redirect an authenticated API POST, including same-origin redirects.
          if (!safeRead || redirects++ >= Math.min(5, opts.maxRedirects)) fail('REDIRECT_BLOCKED', '重定向被禁止或次数超限')
          const next = canonicalUrl(result.headers.location || '', current)
          if (!next || !result.headers.location) fail('REDIRECT_BLOCKED', '重定向地址不合法')
          if (new URL(current).protocol === 'https:' && new URL(next).protocol !== 'https:') fail('REDIRECT_BLOCKED', '禁止 HTTPS 降级重定向')
          current = next // next iteration resolves and pins again, including same-host redirects
          continue
        }
        if (result.status < 200 || result.status >= 300) {
          const code = [401, 403].includes(result.status) ? 'HTTP_AUTH' : [429, 432, 433].includes(result.status) ? 'RATE_LIMITED' : 'HTTP_ERROR'
          fail(code, `上游 HTTP ${result.status}`, result.status)
        }
        checkSignal(d.signal)
        return result
      }
    } catch (error) { checkSignal(d.signal); throw error }
    finally { d.close() }
  }

  async function probe(url, options = {}) {
    try { return await read(url, { ...options, method: 'HEAD' }) }
    catch (e) { if (![405, 501].includes(e.status)) throw e; return read(url, { ...options, method: 'GET' }) }
  }
  return { read, probe, resolve: (url, options = {}) => resolvePublicUrl(url, { ...options, lookup, dohLookup }) }
}

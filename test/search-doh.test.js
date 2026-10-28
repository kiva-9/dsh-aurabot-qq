import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as requestHttp } from 'node:http'
import { createDohLookup, createSearchHttp, isPublicAddress, resolvePublicUrl } from '../src/search/net.js'

const fake = [{ address: '198.18.0.27', family: 4 }, { address: '2001:2::1a', family: 6 }]
const valid = [{ address: '192.0.43.8', family: 4 }, { address: '2001:500:88:200::8', family: 6 }]
const code = expected => e => e.code === expected
let server, base
const calls = []
before(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url, 'http://mock'), host = u.searchParams.get('name'), type = Number(u.searchParams.get('type'))
    if (u.pathname === '/hop') { res.writeHead(302, { location: 'https://page.example/second' }); return res.end() }
    if (u.pathname === '/page') { res.writeHead(200);return res.end('source bytes') }
    if (host === 'redirect.example') { res.writeHead(302, { location: 'http://127.0.0.1/secret' });return res.end() }
    if (host === 'failover.example' && u.pathname === '/cloudflare-dns.com') { res.writeHead(503);return res.end() }
    let data = { Status: 0, TC: false, CD: false, Question: [{ name: host + '.', type }], Answer: [
      { name: host, type: 5, data: 'alias.example.' },
      { name: 'alias.example.', type, data: type === 1 ? valid[0].address : valid[1].address },
    ] }
    if (host === 'mismatch.example') data.Question[0].name = 'other.example.'
    if (host === 'truncated.example') data.TC = true
    if (host === 'disabled-checking.example') data.CD = true
    if (host === 'private.example' && type === 28) data.Answer[1].data = '::ffff:127.0.0.1'
    if (host === 'fake.example' && type === 1) data.Answer[1].data = '198.18.0.2'
    if (host === 'unrelated.example') data.Answer[1].name = 'unrelated.example.invalid'
    if (host === 'empty.example') data.Answer = []
    if (host === 'bad-family.example' && type === 1) data.Answer[1].data = '::1'
    if (host === 'nxdomain.example') data.Status = 3
    if (host === 'huge.example') data.extra = 'x'.repeat(70000)
    const send = () => { res.writeHead(200, { 'content-type': 'application/dns-json' });res.end(JSON.stringify(data)) }
    if (host === 'slow.example') setTimeout(send, 100)
    else send()
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r));base = `http://127.0.0.1:${server.address().port}`
})
after(() => { server.closeAllConnections();server.close() })

function doh(options = {}) {
  return createDohLookup({ bootstrapLookup: async () => [{ address: '1.1.1.1', family: 4 }], ...options, request(url, opts, cb) {
    calls.push({ host: url.hostname, name: url.searchParams.get('name'), type: url.searchParams.get('type') })
    assert.equal(url.protocol, 'https:');assert.equal(opts.method, 'GET');assert.equal(opts.servername, url.hostname)
    assert.equal(opts.rejectUnauthorized, true);assert.equal(opts.agent, false)
    assert.equal(opts.headers.authorization, undefined);assert.equal(opts.headers.accept, 'application/dns-json')
    assert.ok(['cloudflare-dns.com', 'dns.google'].includes(url.hostname))
    opts.lookup(url.hostname, { all: true }, (error, rows) => {
      assert.equal(error, null);assert.deepEqual(rows, options.expectFakeBootstrap ? [fake[0]] : [{ address: url.hostname === 'dns.google' ? '8.8.8.8' : '1.1.1.1', family: 4 }])
    })
    return requestHttp(`${base}/${url.hostname}${url.search}`, opts, cb)
  } })
}

test('global IANA addresses are allowed; reserved /24s and both fake-IP ranges remain blocked', () => {
  for (const ip of ['192.0.43.8', '192.0.32.8', '192.0.1.1']) assert.equal(isPublicAddress(ip), true, ip)
  for (const ip of ['192.0.0.1', '192.0.2.1', '192.168.1.1', '198.18.0.27', '198.19.255.255', '2001:2::1a']) assert.equal(isPublicAddress(ip), false, ip)
})

test('all-fake system DNS invokes authenticated DoH with fixed bootstrap IP and a bounded CNAME chain', async () => {
  const start = calls.length
  const r = await resolvePublicUrl('https://public.example/page', { lookup: async () => fake, dohLookup: doh() })
  assert.deepEqual(r.addresses, valid);assert.equal(r.resolution, 'public-doh-after-fake-ip')
  assert.equal(calls.length - start, 2)
  assert.ok(calls.slice(start).every(c => c.host === 'cloudflare-dns.com'))
})

test('fake-IP routing is allowed only for fixed authenticated DoH origins, never for source connections', async () => {
  const trusted = doh({ bootstrapLookup: async host => { assert.ok(['cloudflare-dns.com', 'dns.google'].includes(host));return fake }, expectFakeBootstrap: true })
  const resolved = await resolvePublicUrl('https://page.example/', { lookup: async () => fake, dohLookup: trusted })
  assert.deepEqual(resolved.addresses, valid)
  assert.ok(resolved.addresses.every(a => isPublicAddress(a.address)))
  // A private answer for the trusted resolver does not redirect it to localhost.
  assert.deepEqual(await doh({ bootstrapLookup: async () => [{ address: '127.0.0.1', family: 4 }] })('page.example'), valid)
})

test('literal reserved IP, local names, mixed/private DNS never invoke DoH or connect', async () => {
  let fallback = 0
  const options = { lookup: async () => fake, dohLookup: async () => { fallback++;return valid } }
  for (const url of ['http://198.18.0.27/', 'http://[2001:2::1a]/', 'https://localhost/', 'https://metadata.google.internal/', 'https://page.example:444/']) await assert.rejects(resolvePublicUrl(url, options), code('UNSAFE_URL'))
  for (const answers of [[{ address: '10.0.0.1', family: 4 }], [fake[0], { address: '8.8.8.8', family: 4 }], [fake[0], { address: '127.0.0.1', family: 4 }]]) {
    await assert.rejects(resolvePublicUrl('https://page.example/', { ...options, lookup: async () => answers }), code('UNSAFE_URL'))
  }
  assert.equal(fallback, 0)
})

test('DoH unsafe/mixed/malformed/truncated/redirect answers fail closed, without shopping another resolver', async () => {
  for (const [host, expected] of [['private', 'UNSAFE_URL'], ['fake', 'UNSAFE_URL'], ['mismatch', 'DNS_INVALID_RESPONSE'], ['unrelated', 'DNS_INVALID_RESPONSE'], ['truncated', 'DNS_INVALID_RESPONSE'], ['disabled-checking', 'DNS_INVALID_RESPONSE'], ['empty', 'DNS_INVALID_RESPONSE'], ['bad-family', 'DNS_INVALID_RESPONSE'], ['nxdomain', 'DNS_INVALID_RESPONSE'], ['huge', 'DNS_INVALID_RESPONSE'], ['redirect', 'DNS_INVALID_RESPONSE']]) {
    const start = calls.length
    await assert.rejects(doh()(`${host}.example`), code(expected), host)
    assert.ok(calls.length - start <= 2, host)
    assert.ok(calls.slice(start).every(c => c.host === 'cloudflare-dns.com'))
  }
})

test('only transport failure tries one second fixed resolver; four DNS GETs maximum', async () => {
  const start = calls.length
  assert.deepEqual(await doh()('failover.example'), valid)
  assert.equal(calls.length - start, 4)
  assert.deepEqual(calls.slice(start).map(c => c.host), ['cloudflare-dns.com', 'cloudflare-dns.com', 'dns.google', 'dns.google'])
})

test('source connection pins DoH IP, preserves original TLS hostname and revalidates even same-host redirects', async () => {
  let resolutions = 0, connects = 0
  const http = createSearchHttp({ lookup: async () => fake, dohLookup: async () => ++resolutions === 1 ? valid : [{ address: '127.0.0.1', family: 4 }],
    request(url, opts, cb) {
      connects++;assert.equal(url.hostname, 'page.example');assert.equal(opts.servername, 'page.example');assert.equal(opts.rejectUnauthorized, true)
      opts.lookup(url.hostname, {}, (error, address, family) => { assert.equal(error, null);assert.equal(address, '192.0.43.8');assert.equal(family, 4) })
      return requestHttp(base + '/hop', opts, cb)
    } })
  await assert.rejects(http.read('https://page.example/start'), code('UNSAFE_URL'))
  assert.equal(resolutions, 2);assert.equal(connects, 1)
})

test('source cancellation/deadline also cancels DoH and never connects to an unvalidated source', async () => {
  let connects = 0
  const http = createSearchHttp({ lookup: async () => fake, dohLookup: doh(), request() { connects++;throw new Error('must not connect') } })
  await assert.rejects(http.read('https://slow.example/', { timeoutMs: 15 }), code('TIMEOUT'))
  const ac = new AbortController(), pending = http.read('https://slow.example/', { signal: ac.signal })
  setTimeout(() => ac.abort(), 10)
  await assert.rejects(pending, code('CANCELED'));assert.equal(connects, 0)
})

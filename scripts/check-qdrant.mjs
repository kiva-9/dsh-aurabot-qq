// Free, isolated Windows protocol validation. No embedding/model calls or DSH configuration.
// node scripts/check-qdrant.mjs [--no-download]
// Only runtime artifacts under .refactor/tools are created; production code is imported unchanged.
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises'
import { createServer, createConnection } from 'node:net'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { release } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { createVectorIndex, pointId } from '../src/memory/vector/index.js'

const PIN = Object.freeze({
  version: '1.20.0', tag: 'v1.20.0', asset: 'qdrant-x86_64-pc-windows-msvc.zip',
  release: 'https://github.com/qdrant/qdrant/releases/tag/v1.20.0',
  download: 'https://github.com/qdrant/qdrant/releases/download/v1.20.0/qdrant-x86_64-pc-windows-msvc.zip',
  archiveSha256: '6d13553584fd0411f00637519e293331ff0aa1fb79bd9e30db45839bb75de2be',
  // Executable hash derived from the archive above, whose digest is in the official release API.
  executableSha256: '3e86f79bd516097586afb5ceacf6b843bc9e32b8e4b311d94b63a3cc11432a40',
})
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const toolsDir = join(root, '.refactor', 'tools')
const binaryDir = join(toolsDir, 'qdrant-' + PIN.tag)
const binary = join(binaryDir, 'qdrant.exe')
const runCommand = promisify(execFile)
const command = (file, args, options = {}) => runCommand(file, args, { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024, ...options })
const hash = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')
const exists = async (path) => access(path).then(() => true, () => false)
const sourcePaths = ['vector/index.js', 'vector/qdrant.js', 'vector/local.js', 'vector/sqlite-worker.js', 'vector/contract.js', 'embedding/http.js', 'embedding/space.js']
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [path, await hash(join(root, 'src', 'memory', path))])))
const errorView = (e) => ({ code: e.code || null, message: String(e.message || e).slice(0, 1600) })
const results = { startedAt: new Date().toISOString(), pin: PIN, platform: process.platform, arch: process.arch,
  osRelease: release(), node: process.version, checks: [], processes: [], requests: [], cleanup: {} }
let runDir, configPath, baseUrl, port, serverProcess, index, watchdog
let dropAliasAck = false, shuttingDown = false, stepName = '', serverSequence = 0
const apiKey = 'local-validation-' + randomUUID() // Synthetic key, never read from user configuration.
// Keep Windows internal segment/atomic-temp paths short. The server/data dir is
// already unique per run, so a short random collection prefix is sufficient.
const prefix = 'qv_' + randomUUID().replaceAll('-', '').slice(0, 8)
const nativeFetch = globalThis.fetch
const lifecycle = new AbortController()

async function check(name, fn) {
  stepName = name
  const start = performance.now()
  try {
    const details = await fn()
    results.checks.push({ name, status: 'passed', ms: Math.round(performance.now() - start), details })
    console.log('PASS ' + name)
    return details
  } catch (error) {
    results.checks.push({ name, status: 'failed', ms: Math.round(performance.now() - start), error: errorView(error) })
    console.error('FAIL ' + name + ': ' + error.message)
    throw error
  }
}

async function prepareBinary(noDownload) {
  assert.equal(process.platform, 'win32', 'This pinned validation uses the official Windows x64 binary; no installers are run')
  assert.equal(process.arch, 'x64', 'The pinned binary requires x64')
  const archive = join(binaryDir, PIN.asset)
  await mkdir(binaryDir, { recursive: true })
  if (!await exists(archive)) {
    assert.equal(noDownload, false, 'Pinned archive is absent and --no-download was specified')
    await command('curl.exe', ['--fail', '--location', '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '15',
      '--max-time', '180', '--retry', '2', '--silent', '--show-error', '--output', archive, PIN.download], { timeout: 240000 })
  }
  assert.equal(await hash(archive), PIN.archiveSha256, 'Archive digest mismatch: refuse to extract/execute')
  if (!await exists(binary)) {
    const { stdout } = await command('tar.exe', ['-tf', archive])
    assert.deepEqual(stdout.trim().split(/\r?\n/), ['qdrant.exe'], 'Unexpected archive entries: refuse extraction')
    await command('tar.exe', ['-xf', archive, '-C', binaryDir])
  }
  assert.equal(await hash(binary), PIN.executableSha256, 'Executable digest mismatch: refuse to execute')
  const { stdout } = await command(binary, ['--version'], { cwd: binaryDir })
  assert.match(stdout, /^qdrant 1\.20\.0\s*$/i)
  return { versionOutput: stdout.trim(), archive, executable: binary, archiveSha256: PIN.archiveSha256, executableSha256: PIN.executableSha256 }
}

async function freePort() {
  const listener = createServer()
  await new Promise((yes, no) => { listener.once('error', no); listener.listen(0, '127.0.0.1', yes) })
  const result = listener.address().port
  await new Promise((yes, no) => listener.close((e) => e ? no(e) : yes()))
  assert.ok(![6333, 6334, 6335].includes(result))
  return result
}
async function portOpen() {
  return new Promise((done) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let completed = false
    const finish = (value) => { if (!completed) { completed = true; socket.destroy(); done(value) } }
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.setTimeout(500, () => finish(false))
  })
}
async function listenersFor(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  const { stdout } = await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$items = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq ${pid} } | Select-Object LocalAddress,LocalPort,OwningProcess); ConvertTo-Json -InputObject $items -Compress`])
  return JSON.parse(stdout || '[]')
}
async function startServer() {
  assert.ok(!serverProcess, 'An owned server is already running')
  const sequence = ++serverSequence
  const logPath = join(runDir, 'server-' + sequence + '.log')
  const log = createWriteStream(logPath)
  // No inherited Qdrant overrides, cloud credentials, or proxies. Windows loader/runtime only.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(systemroot|windir|systemdrive|path|temp|tmp|pathext|comspec|number_of_processors|processor_architecture)$/i.test(key)))
  const child = spawn(binary, ['--config-path', configPath, '--disable-telemetry'], {
    cwd: runDir, windowsHide: true, detached: false, stdio: ['ignore', 'pipe', 'pipe'], env,
  })
  const info = { sequence, pid: child.pid, startedAt: new Date().toISOString(), logPath, windowsHide: true }
  results.processes.push(info)
  const closed = new Promise((done) => {
    child.once('error', (e) => { info.error = errorView(e) })
    child.once('close', (code, signal) => { info.exitCode = code; info.signal = signal; info.stoppedAt = new Date().toISOString(); log.end(done) })
  })
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
  serverProcess = { child, closed, info }
  const until = Date.now() + 30000
  while (Date.now() < until) {
    lifecycle.signal.throwIfAborted()
    if (info.error || child.exitCode !== null) throw new Error('Qdrant failed to start: ' + JSON.stringify(info))
    try {
      const response = await nativeFetch(baseUrl + '/', { headers: { 'api-key': apiKey }, signal: AbortSignal.timeout(800) })
      if (response.ok) {
        const meta = await response.json()
        assert.equal(meta.version, PIN.version)
        info.server = meta
        return info
      }
      await response.body?.cancel()
    } catch (e) { if (e.code === 'ERR_ASSERTION') throw e }
    await delay(100, undefined, { signal: lifecycle.signal })
  }
  throw new Error('Qdrant did not become ready in 30 seconds; see ' + logPath)
}
async function stopServer() {
  if (!serverProcess) return
  const owned = serverProcess
  if (owned.child.exitCode === null) owned.child.kill('SIGTERM') // Windows TerminateProcess; intentionally also exercises WAL recovery.
  await Promise.race([owned.closed, delay(6000, undefined, { ref: false }).then(() => { throw new Error('Owned Qdrant process did not exit') })])
  assert.equal(await portOpen(), false, 'Test listener still open after stopping the owned process')
  owned.info.listenerClosed = true
  serverProcess = null
}

async function http(path, method = 'GET', body, { auth = true, expected = 200 } = {}) {
  const response = await fetch(baseUrl + path, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { 'api-key': apiKey } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(8000), lifecycle.signal]) })
  const text = await response.text()
  assert.equal(response.status, expected, `${method} ${path}: ${text.slice(0, 500)}`)
  return text ? JSON.parse(text) : null
}
const collections = async () => (await http('/collections')).result.collections.map((c) => c.name)
const aliases = async () => (await http('/aliases')).result.aliases
const points = async (name, ids) => (await http(`/collections/${name}/points`, 'POST', { ids, with_payload: true, with_vector: true })).result
const space = { spaceId: 'qv-cosine', provider: 'static-fixture', endpointIdentity: 'no-provider', model: 'handwritten-vectors', revision: 'r1',
  dims: 3, metric: 'cosine', modalities: ['text'], normalization: 'none', prefixes: { query: '', document: '' },
  preprocess: { text: { version: '1' } }, protocolMappingVersion: 'static-test-v1' }
const record = (id, patch = {}) => ({ id, vector: [1, 0, 0], account: 'synthetic-account-a', chat: 'group:synthetic-1', category: 'fact', persona: '', sourceRevision: 1, scopeRevision: 1, ...patch })
const query = (patch = {}) => ({ spaceId: space.spaceId, vector: [1, 0, 0], filter: { account: 'synthetic-account-a', chat: 'group:synthetic-1', category: 'fact' }, limit: 20, ...patch })
const hitIds = (r) => r.hits.map((h) => h.id).sort()
let options, initialCollection, activeAlias, firstGeneration, currentGeneration
let survivingSeeds = []

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) { console.log('node scripts/check-qdrant.mjs [--no-download]\nPinned Windows x64 binary, owned loopback process, synthetic data; results in .refactor/tools/qv-*/result.json'); return }
  assert.ok(args.every((a) => a === '--no-download'), 'Only --no-download is supported; external endpoints are deliberately not accepted')
  assert.notEqual(process.env.NODE_USE_ENV_PROXY, '1', 'Disable Node environment-proxy mode for this loopback-only run')
  await mkdir(toolsDir, { recursive: true })
  runDir = await mkdtemp(join(toolsDir, 'qv-'))
  results.runDir = runDir; results.collectionPrefix = prefix
  results.sourcesBefore = await sourceHashes()
  try {
    await check('official-binary-sha256-and-version', () => prepareBinary(args.includes('--no-download')))
    port = await freePort(); baseUrl = 'http://127.0.0.1:' + port
    results.baseUrl = baseUrl
    configPath = join(runDir, 'qdrant.yaml')
    await writeFile(configPath, [
      'log_level: INFO', 'telemetry_disabled: true', 'cluster:', '  enabled: false', 'service:',
      '  host: "127.0.0.1"', `  http_port: ${port}`, '  grpc_port: null', '  max_workers: 2', '  enable_cors: false',
      '  api_key: ' + JSON.stringify(apiKey), 'storage:', '  storage_path: ' + JSON.stringify(join(runDir, 'storage')),
      '  snapshots_path: ' + JSON.stringify(join(runDir, 'snapshots')), '  temp_path: ' + JSON.stringify(join(runDir, 'temp')),
      '  wal:', '    wal_capacity_mb: 1', '    wal_segments_ahead: 0', '  performance:', '    max_search_threads: 2',
      '  optimizers:', '    default_segment_number: 1', '    max_optimization_threads: 1', '',
    ].join('\n'))
    // Observe real network calls, never emulate a Qdrant response. One explicitly labeled
    // check discards an actual successful alias response to exercise journal recovery.
    globalThis.fetch = async (url, init = {}) => {
      const target = new URL(url)
      assert.equal(target.origin, baseUrl, 'Validation may only call its owned loopback server')
      const item = { step: stepName, method: init.method || 'GET', path: target.pathname + target.search,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
        apiKeyPresent: new Headers(init.headers).has('api-key') }
      results.requests.push(item)
      try {
        const response = await nativeFetch(url, init)
        item.status = response.status
        if (!response.ok) item.responseBody = (await response.clone().text()).slice(0, 1600)
        if (dropAliasAck && item.method === 'POST' && target.pathname === '/collections/aliases') {
          dropAliasAck = false
          assert.equal(response.ok, true)
          const acknowledged = await response.json()
          assert.equal(acknowledged.result, true)
          item.injectedFault = 'real-server-acknowledged-true; caller-response-discarded'
          throw new TypeError('Injected loss after successful real Qdrant alias acknowledgement')
        }
        return response
      } catch (e) { item.error = errorView(e); throw e }
    }
    watchdog = setTimeout(() => { lifecycle.abort(new Error('Validation exceeded 180 seconds')); serverProcess?.child.kill('SIGTERM') }, 180000)
    await check('real-server-loopback-auth-and-disabled-grpc', async () => {
      const info = await startServer()
      const listeners = await listenersFor(info.pid)
      assert.deepEqual(listeners.map((l) => [l.LocalAddress, l.LocalPort]), [['127.0.0.1', port]])
      const unauthorized = await fetch(baseUrl + '/collections', { signal: AbortSignal.timeout(2000) })
      assert.ok([401, 403].includes(unauthorized.status)); await unauthorized.body.cancel()
      await http('/collections')
      return { server: info.server, pid: info.pid, listeners, unauthorizedStatus: unauthorized.status }
    })
    options = { backend: 'qdrant', baseUrl, apiKey, collectionPrefix: prefix, path: join(runDir, 'adapter-journal.sqlite'), spaces: [space], timeoutMs: 2500 }
    await check('adapter-create-collection-six-keyword-indexes-and-alias', async () => {
      index = await createVectorIndex(options)
      const names = await collections(); assert.equal(names.length, 1)
      initialCollection = names[0]
      const info = (await http('/collections/' + initialCollection)).result
      assert.equal(info.config.params.vectors.size, 3)
      assert.equal(info.config.params.vectors.distance, 'Cosine')
      assert.equal(info.config.params.vectors.on_disk, true)
      for (const key of ['account', 'chat', 'persona', 'category', 'spaceId', 'generation']) assert.equal(info.payload_schema[key].data_type, 'keyword', key)
      const a = await aliases(); assert.equal(a.length, 1); assert.equal(a[0].collection_name, initialCollection)
      activeAlias = a[0].alias_name
      firstGeneration = (await index.query(query())).generation; currentGeneration = firstGeneration
      return { collection: initialCollection, alias: activeAlias, generation: firstGeneration, payloadSchema: info.payload_schema }
    })
    const visibleId = 'visible-中文-id'
    await check('adapter-upsert-real-uuid-points-and-scope-tags', async () => {
      const items = [record(visibleId, { vector: [0, 1, 0] }), record('private-nearest', { chat: 'private:synthetic' }),
        record('other-account', { account: 'synthetic-account-b' }), record('other-persona', { persona: 'fish' }), record('other-category', { category: 'image' }),
        record('shared-image', { chat: 'group:synthetic-2', category: 'image' }), record('unshared-fact', { chat: 'group:synthetic-2' }),
        record('unshared-persona', { chat: 'group:synthetic-2', category: 'image', persona: 'fish' })]
      survivingSeeds = items.slice(1)
      assert.equal((await index.upsert({ spaceId: space.spaceId, records: items })).accepted, items.length)
      const saved = await points(initialCollection, items.map((r) => pointId(space.spaceId, r.id)))
      assert.equal(saved.length, items.length)
      for (const p of saved) { assert.equal(p.id, pointId(space.spaceId, p.payload.id)); assert.equal(p.payload.spaceId, space.spaceId); assert.equal(p.payload.generation, firstGeneration) }
      return { count: saved.length, unicodeIdMappedTo: pointId(space.spaceId, visibleId) }
    })
    await check('server-side-account-chat-persona-category-filter-before-top-k', async () => {
      const result = await index.query(query({ limit: 1 }))
      assert.deepEqual(hitIds(result), [visibleId]); assert.equal(result.stats.returnedByRemote, 1)
      assert.equal(result.hits[0].score, 0)
      return { returned: hitIds(result), score: result.hits[0].score, stats: result.stats }
    })
    await check('authorized-ids-empty-set-and-missing-scope-fail-closed', async () => {
      assert.deepEqual(hitIds(await index.query(query({ authorizedIds: [visibleId] }))), [visibleId])
      assert.deepEqual(hitIds(await index.query(query({ authorizedIds: ['private-nearest'] }))), [])
      const before = results.requests.length
      assert.deepEqual(hitIds(await index.query(query({ authorizedIds: [] }))), [])
      await assert.rejects(index.query(query({ filter: { account: 'synthetic-account-a' } })), { code: 'SCOPE_REQUIRED' })
      assert.equal(results.requests.length, before)
      return { emptyAndInvalidScopeHttpRequests: 0 }
    })
    await check('correlated-share-grants-do-not-cross-join-scope-fields', async () => {
      const result = await index.query(query({ filter: { account: 'synthetic-account-a', scopes: [
        { chat: 'group:synthetic-1', category: 'fact' }, { chat: 'group:synthetic-2', category: 'image' },
      ] } }))
      assert.deepEqual(hitIds(result), ['shared-image', visibleId].sort())
      return { returned: hitIds(result) }
    })
    await check('upsert-revision-and-permission-change-replace-the-same-point', async () => {
      await index.upsert({ spaceId: space.spaceId, records: [record(visibleId, { chat: 'private:moved', sourceRevision: 2, scopeRevision: 2 })] })
      assert.deepEqual(hitIds(await index.query(query())), [])
      await index.upsert({ spaceId: space.spaceId, records: [record(visibleId, { sourceRevision: 3, scopeRevision: 3, vector: [1, 1, 0] })] })
      const found = await index.query(query()); assert.equal(found.hits[0].sourceRevision, 3)
      assert.ok(Math.abs(found.hits[0].score - Math.SQRT1_2) < 1e-5)
      const saved = await points(initialCollection, [pointId(space.spaceId, visibleId)])
      assert.equal(saved.length, 1); assert.equal(saved[0].payload.scopeRevision, 3)
      return { sourceRevision: 3, scopeRevision: 3, cosineScore: found.hits[0].score }
    })
    await check('delete-points-wait-completed-and-tombstone-no-resurrection', async () => {
      await index.delete({ spaceId: space.spaceId, ids: [visibleId], sourceRevision: 4 })
      assert.deepEqual(hitIds(await index.query(query())), [])
      assert.equal((await points(initialCollection, [pointId(space.spaceId, visibleId)])).length, 0)
      assert.equal((await index.upsert({ spaceId: space.spaceId, records: [record(visibleId, { sourceRevision: 99 })] })).skipped, 1)
      assert.equal((await points(initialCollection, [pointId(space.spaceId, visibleId)])).length, 0)
      return { deletedFromRealServer: true, lateUpsertSkipped: true }
    })
    await check('real-dot-and-euclidean-distance-protocol-and-score-order', async () => {
      const metricResults = []
      for (const metric of ['dot', 'euclidean']) {
        const s = { ...space, spaceId: 'qv-' + metric, metric }
        await index.registerSpace(s)
        await index.upsert({ spaceId: s.spaceId, records: metric === 'dot'
          ? [record('higher', { vector: [3, 0, 0] }), record('lower')]
          : [record('near'), record('far', { vector: [1, 3, 0] })] })
        const result = await index.query(query({ spaceId: s.spaceId }))
        assert.deepEqual(result.hits.map((h) => h.id), metric === 'dot' ? ['higher', 'lower'] : ['near', 'far'])
        assert.deepEqual(result.hits.map((h) => h.score), metric === 'dot' ? [3, 1] : [-0, -3])
        metricResults.push({ metric, scores: result.hits.map((h) => ({ id: h.id, score: h.score })) })
      }
      return metricResults
    })
    await check('incomplete-rebuild-cannot-replace-serving-generation', async () => {
      await assert.rejects(index.rebuild({ spaceId: space.spaceId, generation: 'incomplete', records: [] }), { code: 'INCOMPLETE_GENERATION' })
      await assert.rejects(index.switchGeneration({ spaceId: space.spaceId, generation: 'incomplete' }), { code: 'GENERATION_NOT_READY' })
      assert.equal((await index.query(query())).generation, firstGeneration)
      return { rejected: 'INCOMPLETE_GENERATION', servingGeneration: firstGeneration }
    })
    await check('rebuild-candidate-dual-writes-deletes-and-atomic-alias-switch', async () => {
      const originals = [record('keep'), record('revoked'), record('deleted-during-rebuild')]
      await index.upsert({ spaceId: space.spaceId, records: originals })
      // Rebuild is a whole-space operation: retain other scopes even though this
      // caller's retrieval filter must never expose them.
      await index.rebuild({ spaceId: space.spaceId, generation: 'g1', records: [...survivingSeeds, ...originals], batchSize: 2 })
      assert.equal((await index.query(query())).generation, firstGeneration)
      await index.upsert({ spaceId: space.spaceId, records: [record('late'), record('revoked', { chat: 'private:revoked', sourceRevision: 2, scopeRevision: 2 })] })
      await index.delete({ spaceId: space.spaceId, ids: ['deleted-during-rebuild'], sourceRevision: 2 })
      const start = results.requests.length
      await index.switchGeneration({ spaceId: space.spaceId, generation: 'g1', expectedGeneration: firstGeneration })
      const action = results.requests.slice(start).find((r) => r.path === '/collections/aliases' && r.method === 'POST')
      assert.equal(action.status, 200); assert.equal(action.body.actions.length, 2)
      assert.equal(action.body.actions[0].delete_alias.alias_name, activeAlias)
      assert.equal(action.body.actions[1].create_alias.alias_name, activeAlias)
      const result = await index.query(query()); assert.equal(result.generation, 'g1'); assert.deepEqual(hitIds(result), ['keep', 'late'])
      const target = (await aliases()).find((a) => a.alias_name === activeAlias).collection_name
      assert.notEqual(target, initialCollection)
      assert.equal((await points(target, [pointId(space.spaceId, 'deleted-during-rebuild')])).length, 0)
      const live = await points(target, [pointId(space.spaceId, 'late'), pointId(space.spaceId, 'revoked')])
      assert.ok(live.every((p) => p.payload.generation === 'g1'))
      assert.equal(live.find((p) => p.payload.id === 'revoked').payload.chat, 'private:revoked')
      currentGeneration = 'g1'
      return { oldCollection: initialCollection, newCollection: target, aliasActions: action.body.actions, hits: hitIds(result) }
    })
    await check('real-alias-success-with-lost-caller-ack-recovers-from-journal', async () => {
      await index.rebuild({ spaceId: space.spaceId, generation: 'g2', records: [...survivingSeeds, record('keep'), record('late'),
        record('revoked', { chat: 'private:revoked', sourceRevision: 2, scopeRevision: 2 })] })
      dropAliasAck = true
      await assert.rejects(index.switchGeneration({ spaceId: space.spaceId, generation: 'g2', expectedGeneration: 'g1' }), { code: 'HTTP_UNAVAILABLE' })
      assert.equal(dropAliasAck, false)
      const receipt = results.requests.find((r) => r.injectedFault)
      assert.equal(receipt.status, 200)
      await index.close(); index = null; index = await createVectorIndex(options)
      const result = await index.query(query()); assert.equal(result.generation, 'g2'); assert.deepEqual(hitIds(result), ['keep', 'late'])
      assert.equal((await index.health()).pending, 0)
      currentGeneration = 'g2'
      return { injectedFault: receipt.injectedFault, realHttpStatus: receipt.status, recoveredGeneration: result.generation, hits: hitIds(result) }
    })
    await check('server-process-outage-persists-upsert-delete-and-replays-after-restart', async () => {
      const firstPid = serverProcess.info.pid
      await stopServer()
      await assert.rejects(index.upsert({ spaceId: space.spaceId, records: [record('pending-during-outage')] }), { code: 'HTTP_UNAVAILABLE' })
      await assert.rejects(index.delete({ spaceId: space.spaceId, ids: ['keep'], sourceRevision: 2 }), { code: 'HTTP_UNAVAILABLE' })
      await assert.rejects(index.query(query()), { code: 'HTTP_UNAVAILABLE' })
      const offline = await index.health(); assert.equal(offline.remoteAvailable, false); assert.ok(offline.pending >= 2)
      await index.close(); index = null
      const restarted = await startServer(); assert.notEqual(restarted.pid, firstPid)
      index = await createVectorIndex(options)
      const result = await index.query(query()); assert.equal(result.generation, currentGeneration)
      assert.deepEqual(hitIds(result), ['late', 'pending-during-outage'])
      const healthy = await index.health(); assert.equal(healthy.remoteAvailable, true); assert.equal(healthy.pending, 0)
      return { firstPid, restartedPid: restarted.pid, offlinePending: offline.pending, replayedPending: healthy.pending, hits: hitIds(result) }
    })
    await check('delete-only-owned-aliases-and-collections', async () => {
      await index.close(); index = null
      const names = await collections(), ownedAliases = await aliases()
      assert.ok(names.length >= 5); assert.ok(names.every((n) => n.startsWith(prefix + '_')))
      assert.ok(ownedAliases.every((a) => a.alias_name.startsWith(prefix + '_')))
      if (ownedAliases.length) assert.equal((await http('/collections/aliases', 'POST', { actions: ownedAliases.map((a) => ({ delete_alias: { alias_name: a.alias_name } })) })).result, true)
      for (const name of names) assert.equal((await http('/collections/' + name, 'DELETE')).result, true)
      assert.deepEqual(await collections(), []); assert.deepEqual(await aliases(), [])
      results.cleanup.collectionsRemoved = names.length; results.cleanup.aliasesRemoved = ownedAliases.length
      return { deletedCollections: names.length, deletedAliases: ownedAliases.length }
    })
    await check('production-sources-unchanged-and-owned-process-stopped', async () => {
      results.sourcesAfter = await sourceHashes(); assert.deepEqual(results.sourcesAfter, results.sourcesBefore)
      const pid = serverProcess.info.pid
      await stopServer()
      assert.deepEqual(await listenersFor(pid), [])
      assert.equal(await portOpen(), false)
      results.cleanup.processStopped = true; results.cleanup.portClosed = true
      return { pid, port, listenerClosed: true, sourceFilesUnchanged: sourcePaths.length }
    })
    results.status = 'passed'
  } catch (error) {
    results.status = 'failed'; results.error = errorView(error); process.exitCode = 1
  } finally {
    shuttingDown = true
    clearTimeout(watchdog)
    if (index) await index.close().catch((e) => { results.status = 'failed'; results.cleanup.indexCloseError = errorView(e); process.exitCode = 1 })
    await stopServer().catch((e) => { results.status = 'failed'; results.cleanup.stopError = errorView(e); process.exitCode = 1 })
    globalThis.fetch = nativeFetch
    results.cleanup.processStopped = !serverProcess
    if (port) results.cleanup.portClosed = !await portOpen()
    results.finishedAt = new Date().toISOString()
    const resultPath = join(runDir, 'result.json')
    await writeFile(resultPath, JSON.stringify(results, null, 2) + '\n')
    console.log(JSON.stringify({ status: results.status, passed: results.checks.filter((x) => x.status === 'passed').length,
      failed: results.checks.filter((x) => x.status === 'failed').length, resultPath, cleanup: results.cleanup, error: results.error }, null, 2))
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (shuttingDown) return
  lifecycle.abort(new Error('Validation interrupted: ' + signal)); serverProcess?.child.kill('SIGTERM')
})
main().catch((e) => { console.error(e.message); process.exitCode = 1 })

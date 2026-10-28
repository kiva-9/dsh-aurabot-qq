// Usage: node scripts/benchmark-vectors.mjs --output src/memory/vector/benchmark-results.json
// Only synthetic vectors in a freshly created OS temporary directory; no application data access.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir, cpus, totalmem, setPriority, constants } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'
import { createVectorIndex } from '../src/memory/vector/index.js'

const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] ?? 0
const timing = values => ({ samples: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), p99Ms: percentile(values, 0.99), maxMs: Math.max(0, ...values) })
const benchmarkSpace = (modality, dims) => ({ spaceId: `synthetic-${modality}-${dims}`, provider: 'synthetic-benchmark', endpointIdentity: 'offline', model: 'xorshift32', revision: '1', dims, metric: 'cosine', modalities: [modality], normalization: 'none', prefixes: { query: '', document: '' }, preprocess: { [modality]: { version: '1', ...(modality === 'image' ? { mode: 'passthrough' } : {}) } }, protocolMappingVersion: 'synthetic-v1' })
function makeVector(seed, dims) {
  let value = seed + 1
  const vector = new Float32Array(dims)
  for (let i = 0; i < dims; i++) { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; vector[i] = ((value >>> 0) / 4294967296) * 2 - 1 }
  return vector
}
const makeRecord = (i, space) => ({ id: `synthetic-${String(i).padStart(9, '0')}`, vector: makeVector(i, space.dims), sourceRevision: 1, scopeRevision: 1, account: 'benchmark-account', chat: `group:${i % 100}`, category: space.modalities[0], persona: '', metadata: { synthetic: true } })

async function measureQueries(index, space, count, full, delayMs) {
  const durations = []; let last
  const filter = { account: 'benchmark-account', ...(full ? { chats: Array.from({ length: 100 }, (_, i) => `group:${i}`) } : { chat: 'group:0' }), category: space.modalities[0] }
  for (let i = 0; i < count; i++) {
    const start = performance.now()
    last = await index.query({ spaceId: space.spaceId, vector: makeVector(i * 100, space.dims), filter, limit: 10 })
    durations.push(performance.now() - start)
    await pause(delayMs)
  }
  return { ...timing(durations), authorizedCandidates: last?.stats.scanned ?? 0, pages: last?.stats.pages ?? 0, accessPath: last?.stats.accessPath }
}

async function runDataset(count, options) {
  const directory = await mkdtemp(join(tmpdir(), 'aurabot-vector-benchmark-'))
  const path = join(directory, 'synthetic.sqlite')
  const spaces = [benchmarkSpace('text', 384), benchmarkSpace('image', 512)]
  const config = { backend: 'local', path, spaces, cacheBytes: 8 * 1024 * 1024, pageSize: 256 }
  let index
  try {
    let start = performance.now()
    index = await createVectorIndex(config)
    const emptyOpenMs = performance.now() - start, ingestion = []
    for (const space of spaces) {
      start = performance.now()
      for (let offset = 0; offset < count; offset += 128) {
        const records = Array.from({ length: Math.min(128, count - offset) }, (_, i) => makeRecord(offset + i, space))
        await index.upsert({ spaceId: space.spaceId, records })
        await pause(options.delayMs)
      }
      const elapsedMs = performance.now() - start
      ingestion.push({ spaceId: space.spaceId, dims: space.dims, records: count, elapsedMs, vectorsPerSecond: count * 1000 / elapsedMs })
      parentPort.postMessage({ progress: `${count.toLocaleString()} per space: ${space.modalities[0]} ingestion complete` })
    }
    await index.close()
    start = performance.now(); index = await createVectorIndex(config)
    const workerReopenMs = performance.now() - start, query = []
    for (const space of spaces) {
      const firstAfterReopen = await measureQueries(index, space, 1, true, options.delayMs)
      const scoped = await measureQueries(index, space, options.queries, false, options.delayMs)
      const allAuthorized = await measureQueries(index, space, options.queries, true, options.delayMs)
      query.push({ spaceId: space.spaceId, firstAfterReopen, scopedOnePercent: scoped, allAuthorized })
      parentPort.postMessage({ progress: `${count.toLocaleString()} per space: ${space.modalities[0]} queries complete; full-scope p95 ${allAuthorized.p95Ms.toFixed(1)} ms` })
    }
    const backgroundCount = 1024, space = spaces[0]
    start = performance.now()
    const writing = (async () => {
      for (let offset = 0; offset < backgroundCount; offset += 128) {
        await index.upsert({ spaceId: space.spaceId, records: Array.from({ length: 128 }, (_, i) => makeRecord(count + offset + i, space)) })
        await pause(options.delayMs)
      }
      return performance.now() - start
    })()
    const duringBackground = await measureQueries(index, space, options.queries, false, options.delayMs)
    const backgroundMs = await writing
    const health = await index.health()
    await index.close(); index = null
    const diskBytes = (await stat(path)).size
    return { recordsPerSpace: count, totalInitialVectors: count * spaces.length, emptyOpenMs, workerReopenMs, diskBytes, ingestion, query,
      backgroundIndexing: { additionalVectors: backgroundCount, elapsedMs: backgroundMs, vectorsPerSecond: backgroundCount * 1000 / backgroundMs, query: duringBackground }, cache: health.cache, sqliteVersion: health.sqliteVersion, storageWorkerMemory: health.workerMemory }
  } finally {
    await index?.close()
    // directory is exclusively the exact mkdtemp return, never a caller-supplied path.
    await rm(directory, { recursive: true, force: true })
  }
}

async function runMain() {
  const args = process.argv.slice(2)
  const option = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1] }
  const counts = String(option('--counts', '10000,100000')).split(',').map(Number)
  const queries = Number(option('--queries', '30')), delayMs = Number(option('--delay-ms', '2'))
  if (counts.some(n => !Number.isSafeInteger(n) || n < 100 || n > 1000000) || !Number.isSafeInteger(queries) || queries < 5 || queries > 200 || !Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 1000) throw new Error('Invalid benchmark options')
  let loweredPriority = false
  try { setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL); loweredPriority = true } catch {}
  const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable()
  let peakRss = process.memoryUsage().rss
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }, 50)
  const start = performance.now()
  const worker = new Worker(new URL(import.meta.url), { workerData: { counts, queries, delayMs }, execArgv: [] })
  try {
    const datasets = await new Promise((resolveResult, reject) => {
      worker.on('message', message => { if (message.progress) console.error(message.progress); if (message.result) resolveResult(message.result); if (message.error) reject(new Error(message.error)) })
      worker.on('error', reject)
      worker.on('exit', code => { if (code !== 0) reject(new Error(`Benchmark worker exited ${code}`)) })
    })
    lag.disable()
    const report = { measuredAt: new Date().toISOString(), environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), loweredPriority },
      scope: 'Synthetic local exact-vector backend only. Each size is PER SPACE (384D text + 512D image). Worker-reopen cold, OS disk cache not purged. No real model, Qdrant or semantic-quality acceptance.',
      settings: { counts, queries, delayMs, storageWorkerCount: 1, batchSize: 128, cacheBudgetBytes: 8 * 1024 * 1024, pageSize: 256 },
      elapsedMs: performance.now() - start, peakProcessRssBytes: peakRss, controllerEventLoop: { p50Ms: lag.percentile(50) / 1e6, p95Ms: lag.percentile(95) / 1e6, maxMs: lag.max / 1e6 }, datasets }
    const json = JSON.stringify(report, null, 2) + '\n'
    const output = option('--output', null)
    if (output) await writeFile(resolve(output), json, 'utf8')
    console.log(json)
  } finally { clearInterval(sampler); lag.disable(); await worker.terminate() }
}

if (!isMainThread && workerData?.counts) {
  try { const result = []; for (const count of workerData.counts) result.push(await runDataset(count, workerData)); parentPort.postMessage({ result }) }
  catch (error) { parentPort.postMessage({ error: error.stack }) }
} else if (isMainThread && process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await runMain()
}

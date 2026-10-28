import { Worker } from 'node:worker_threads'
import { VectorError, fail, integer } from '../embedding/space.js'

/** Async RPC facade. SQLite, Float32 conversion, filtering, scoring and caches live in the worker. */
export class LocalVectorIndex {
  constructor(options) {
    this.options = { ...options }
    this.pending = new Map()
    this.sequence = 0
    this.closed = false
    this.failure = null
    this.maxPending = integer(options.maxPending ?? 32, 'maxPending', 1, 1024)
    // Electron/host/test-runner flags can be illegal in workers. This worker needs no inherited preload or CLI flags.
    this.worker = new Worker(new URL('./sqlite-worker.js', import.meta.url), { workerData: options, execArgv: [] })
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject })
    this.worker.on('message', message => {
      if (message.ready) return this.resolveReady()
      if (message.startupError) return this.onFailure(new VectorError(message.startupError.code, message.startupError.message))
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new VectorError(message.error.code, message.error.message))
      else pending.resolve(message.result)
    })
    this.worker.on('error', error => this.onFailure(error))
    this.worker.on('exit', code => {
      if (!this.closed || this.pending.size) this.onFailure(new VectorError('WORKER_EXIT', `Vector worker exited (${code}); reopen the index to recover`))
    })
  }
  onFailure(error) {
    this.failure = error
    this.rejectReady(error)
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
  }
  async _call(method, args = {}) {
    await this.ready
    if (this.failure) throw this.failure
    if (this.closed) fail('INDEX_CLOSED', 'Vector index is closed')
    if (this.pending.size >= this.maxPending) fail('VECTOR_BACKPRESSURE', 'Too many pending worker requests')
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try { this.worker.postMessage({ id, method, args }) } catch (error) { this.pending.delete(id); reject(error) }
    })
  }
  registerSpace(space) { return this._call('registerSpace', { space }) }
  upsert(request) { return this._call('upsert', request) }
  query(request) { return this._call('query', request) }
  delete(request) { return this._call('delete', request) }
  health() { return this._call('health') }
  markNeedsRebuild(request) { return this._call('markNeedsRebuild', request) }
  switchGeneration(request) { return this._call('switchGeneration', request) }
  async rebuild({ spaceId, generation, records, batchSize = 128 }) {
    integer(batchSize, 'batchSize', 1, 256)
    if (!records || (!records[Symbol.iterator] && !records[Symbol.asyncIterator])) fail('INVALID_REBUILD', 'records must be an iterable or async iterable of records')
    const { space } = await this._call('describe', { spaceId })
    batchSize = Math.min(batchSize, Math.max(1, Math.floor(16 * 1024 * 1024 / (space.dims * 4))))
    await this._call('beginRebuild', { spaceId, generation })
    let accepted = 0, skipped = 0, batch = []
    const flush = async () => {
      if (!batch.length) return
      const result = await this.upsert({ spaceId, generation, records: batch })
      accepted += result.accepted; skipped += result.skipped; batch = []
    }
    try {
      for await (const record of records) { batch.push(record); if (batch.length >= batchSize) await flush() }
      await flush()
      return { ...await this._call('finishRebuild', { spaceId, generation }), accepted, skipped }
    } catch (error) {
      await this._call('failRebuild', { spaceId, generation }).catch(() => {})
      throw error
    }
  }
  async close() {
    if (this.closed) return
    try { if (!this.failure) await this._call('close') }
    finally { this.closed = true; await this.worker.terminate() }
  }
}

import { LocalVectorIndex } from './local.js'
import { digest, validateVector, fail, text } from '../embedding/space.js'
import { httpBase, requestJson } from '../embedding/http.js'
import { normalizeFilter, normalizeIds, pointId, qdrantFilter, queryLimit } from './contract.js'

const distances = { cosine: 'Cosine', dot: 'Dot', euclidean: 'Euclid' }

/** Single-writer HTTP adapter with a durable worker-owned synchronization journal. */
export class QdrantVectorIndex {
  constructor(options) {
    this.baseUrl = httpBase(options.baseUrl)
    this.apiKey = options.apiKey
    this.prefix = text(options.collectionPrefix ?? 'aurabot', 'collectionPrefix', { max: 80 })
    if (!/^[a-zA-Z0-9_-]+$/.test(this.prefix)) fail('INVALID_CONTRACT', 'collectionPrefix accepts letters, digits, underscores and hyphens')
    this.httpOptions = { timeoutMs: options.timeoutMs ?? 15000, maxResponseBytes: options.maxResponseBytes ?? 16 * 1024 * 1024 }
    this.journal = new LocalVectorIndex({ path: options.path, backend: 'qdrant', remoteIdentity: `${this.baseUrl}/${this.prefix}`, cacheBytes: 0, maxPending: options.maxPending })
    this.ready = this.journal.ready
    this.tail = Promise.resolve()
    this.ensured = new Set()
    this.fingerprints = new Map()
    this.closed = false
  }
  _serial(fn) {
    const result = this.tail.then(() => { if (this.closed) fail('INDEX_CLOSED', 'Vector index is closed'); return fn() })
    this.tail = result.catch(() => {})
    return result
  }
  async _http(path, method = 'GET', body) {
    const result = await requestJson(`${this.baseUrl}${path}`, { ...this.httpOptions, method, body, headers: this.apiKey ? { 'api-key': this.apiKey } : {} })
    if (result.status !== undefined && result.status !== 'ok') fail('QDRANT_ERROR', 'Qdrant did not confirm the operation')
    return result.result ?? result
  }
  _collection(spaceId, generation) { return `${this.prefix}_${digest([spaceId, this.fingerprints.get(spaceId), generation]).slice(0, 40)}` }
  _alias(spaceId) { return `${this.prefix}_${digest(spaceId).slice(0, 32)}_active` }
  async _ensure(spaceId, generation) {
    const { space, fingerprint } = await this.journal._call('describe', { spaceId })
    this.fingerprints.set(spaceId, fingerprint)
    const name = this._collection(spaceId, generation)
    if (this.ensured.has(name)) return name
    let existing
    try { existing = await this._http(`/collections/${name}`) } catch (error) { if (error.status !== 404) throw error }
    if (existing) {
      const vectors = existing.config?.params?.vectors
      if (vectors?.size !== space.dims || vectors?.distance !== distances[space.metric]) fail('REMOTE_SPACE_MISMATCH', 'Qdrant collection dimensions/metric differ from registered space')
    } else await this._http(`/collections/${name}`, 'PUT', { vectors: { size: space.dims, distance: distances[space.metric], on_disk: true }, on_disk_payload: true })
    for (const field of ['account', 'chat', 'category', 'persona', 'spaceId', 'generation']) {
      await this._http(`/collections/${name}/index?wait=true`, 'PUT', { field_name: field, field_schema: 'keyword' })
    }
    this.ensured.add(name)
    return name
  }
  async _flush() {
    while (true) {
      const pending = await this.journal._call('outbox', { limit: 128 })
      if (!pending.length) return
      const groups = new Map()
      for (const item of pending) {
        const key = JSON.stringify([item.spaceId, item.generation, item.kind])
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(item)
      }
      for (const items of groups.values()) {
        const { spaceId, generation, kind } = items[0]
        const name = await this._ensure(spaceId, generation)
        const base = `/collections/${name}/points`
        let result
        try {
          result = kind === 'delete'
            ? await this._http(`${base}/delete?wait=true&ordering=strong`, 'POST', { points: items.map(i => pointId(spaceId, i.id)) })
            : await this._http(`${base}?wait=true&ordering=strong`, 'PUT', { points: items.map(i => ({ id: pointId(spaceId, i.id), vector: Array.from(i.vector), payload: i.record })) })
        } catch (error) { if (error.status === 404) this.ensured.delete(name); throw error }
        if (result.status !== 'completed') fail('REMOTE_WRITE_UNCONFIRMED', 'Qdrant write has not completed; journal retained for retry')
        await this.journal._call('ackOutbox', { seqs: items.map(i => i.seq) })
      }
    }
  }
  async _publish(spaceId, generation) {
    const target = await this._ensure(spaceId, generation), alias = this._alias(spaceId)
    const result = await this._http('/aliases')
    if (!Array.isArray(result.aliases)) fail('INVALID_HTTP_RESPONSE', 'Qdrant aliases response is malformed')
    const current = result.aliases.find(a => a.alias_name === alias)
    if (current?.collection_name === target) return
    const actions = current ? [{ delete_alias: { alias_name: alias } }] : []
    actions.push({ create_alias: { collection_name: target, alias_name: alias } })
    if (await this._http('/collections/aliases', 'POST', { actions }) !== true) fail('REMOTE_WRITE_UNCONFIRMED', 'Qdrant did not confirm the alias switch')
  }
  async _recoverSwitch(spaceId) {
    const generation = await this.journal._call('switchIntent', { spaceId })
    if (!generation) return
    await this._flush()
    await this._publish(spaceId, generation)
    await this.journal.switchGeneration({ spaceId, generation })
    await this.journal._call('switchIntent', { spaceId, generation: null })
  }
  registerSpace(space) {
    return this._serial(async () => {
      const result = await this.journal.registerSpace(space)
      await this._recoverSwitch(space.spaceId)
      const description = await this.journal._call('describe', { spaceId: space.spaceId })
      await this._ensure(space.spaceId, description.generation)
      await this._publish(space.spaceId, description.generation)
      return { ...result, generation: description.generation }
    })
  }
  upsert(request) {
    return this._serial(async () => { await this._recoverSwitch(request.spaceId); const result = await this.journal.upsert(request); await this._flush(); return result })
  }
  delete(request) {
    // Persist the tombstone first. A failed remote delete can never make a local hit visible again.
    return this._serial(async () => { const result = await this.journal.delete(request); await this._flush(); return result })
  }
  query(request) {
    return this._serial(async () => {
      const { spaceId, authorizedIds } = request, filter = normalizeFilter(request.filter), limit = queryLimit(request.limit)
      const ids = authorizedIds === undefined ? undefined : normalizeIds(authorizedIds)
      await this._recoverSwitch(spaceId)
      const { space, generation } = await this.journal._call('describe', { spaceId })
      const vector = validateVector(request.vector, space)
      if (!filter.scopes.length || ids?.length === 0 || filter.scopes.every(s => !s.chats.length || !s.personas.length || s.categories?.length === 0)) return { hits: [], spaceId, generation }
      await this._flush()
      const collection = await this._ensure(spaceId, generation)
      const result = await this._http(`/collections/${collection}/points/query`, 'POST', {
        query: Array.from(vector), filter: qdrantFilter(filter, spaceId, generation, ids), limit, with_payload: true, with_vector: false,
      })
      if (!Array.isArray(result.points)) fail('INVALID_HTTP_RESPONSE', 'Qdrant query response must contain points')
      const candidates = result.points.map(point => {
        const p = point.payload
        if (!p || p.spaceId !== spaceId || p.generation !== generation || point.id !== pointId(spaceId, p.id)) fail('INVALID_HTTP_RESPONSE', 'Qdrant returned a point outside the requested space/generation')
        return { ...p, score: space.metric === 'euclidean' ? -point.score : point.score }
      })
      const hits = await this.journal._call('validateHits', { ...request, generation, hits: candidates })
      hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      return { hits, spaceId, generation, stats: { returnedByRemote: candidates.length, staleDropped: candidates.length - hits.length } }
    })
  }
  async rebuild(request) {
    await this._serial(() => this._recoverSwitch(request.spaceId))
    const result = await this.journal.rebuild(request)
    await this._serial(() => this._flush())
    return result
  }
  switchGeneration(request) {
    return this._serial(async () => {
      await this._recoverSwitch(request.spaceId)
      const current = await this.journal._call('describe', { spaceId: request.spaceId })
      if (current.generation === request.generation) return { spaceId: request.spaceId, generation: request.generation, previousGeneration: current.generation }
      if (request.expectedGeneration !== undefined && request.expectedGeneration !== current.generation) fail('GENERATION_CONFLICT', 'Serving generation changed')
      await this._flush()
      await this.journal._call('switchIntent', request)
      await this._publish(request.spaceId, request.generation)
      const result = await this.journal.switchGeneration(request)
      await this.journal._call('switchIntent', { spaceId: request.spaceId, generation: null })
      return result
    })
  }
  markNeedsRebuild(request) { return this.journal.markNeedsRebuild(request) }
  async health() {
    const local = await this.journal.health()
    try { await this._http('/collections'); return { ...local, backend: 'qdrant', ok: local.pending === 0, remoteAvailable: true } }
    catch (error) { return { ...local, backend: 'qdrant', ok: false, remoteAvailable: false, error: { code: error.code, message: error.message } } }
  }
  async close() { await this.tail; this.closed = true; await this.journal.close() }
}

import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { defineEmbeddingSpace, spaceFingerprint, validateVector, vectorScore, fail, text, integer, canonical } from '../embedding/space.js'
import { normalizeFilter, normalizeRecord, normalizeIds, allowedByFilter, queryLimit } from './contract.js'
import { buildIndex, search as lexicalSearch } from '../lexical.js'

// The host imports every src/**/*.js. Importing this entry on the main thread is inert.
if (parentPort) startWorker()

function startWorker() {
  let db
  try {
    const options = workerData
    text(options.path, 'path', { max: 8192 })
    if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true })
    db = new DatabaseSync(options.path)
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA cache_size=-8192; PRAGMA temp_store=FILE;`)
    db.exec(`
      CREATE TABLE IF NOT EXISTS vector_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS vector_spaces(spaceId TEXT PRIMARY KEY,contract TEXT NOT NULL,fingerprint TEXT NOT NULL,active TEXT NOT NULL,needsRebuild INTEGER NOT NULL DEFAULT 0,reason TEXT);
      CREATE TABLE IF NOT EXISTS vector_generations(spaceId TEXT NOT NULL,generation TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(spaceId,generation));
      CREATE TABLE IF NOT EXISTS vector_heads(spaceId TEXT NOT NULL,id TEXT NOT NULL,sourceRevision INTEGER NOT NULL,scopeRevision INTEGER NOT NULL,deleted INTEGER NOT NULL,hash TEXT NOT NULL,scope TEXT NOT NULL,PRIMARY KEY(spaceId,id));
      CREATE TABLE IF NOT EXISTS vector_rows(spaceId TEXT NOT NULL,generation TEXT NOT NULL,id TEXT NOT NULL,sourceRevision INTEGER NOT NULL,scopeRevision INTEGER NOT NULL,account TEXT NOT NULL,chat TEXT NOT NULL,category TEXT NOT NULL,persona TEXT NOT NULL,metadata TEXT NOT NULL,vector BLOB NOT NULL,PRIMARY KEY(spaceId,generation,id));
      CREATE INDEX IF NOT EXISTS vector_scope ON vector_rows(spaceId,generation,account,chat,category,persona,id);
      CREATE TABLE IF NOT EXISTS vector_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,spaceId TEXT NOT NULL,generation TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,UNIQUE(spaceId,generation,id));
      CREATE TABLE IF NOT EXISTS vector_service_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS vector_service_jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL,error TEXT,result TEXT);
      CREATE TABLE IF NOT EXISTS vector_service_refs(role TEXT NOT NULL,kind TEXT NOT NULL,sourceId TEXT NOT NULL,vectorId TEXT NOT NULL,spaceId TEXT NOT NULL,revision INTEGER NOT NULL,snapshotHash TEXT NOT NULL,scope TEXT NOT NULL,PRIMARY KEY(role,kind,sourceId));
      CREATE TEMP TABLE authorized_ids(id TEXT PRIMARY KEY);
    `)
    const identity = JSON.stringify([options.backend ?? 'local', options.remoteIdentity ?? ''])
    const oldIdentity = db.prepare('SELECT value FROM vector_meta WHERE key=?').get('identity')
    if (oldIdentity && oldIdentity.value !== identity) fail('BACKEND_MISMATCH', 'Use a separate index path for each backend/remote identity')
    db.prepare('INSERT OR IGNORE INTO vector_meta VALUES(?,?)').run('identity', identity)
    const remote = options.backend === 'qdrant'
    const cacheBudget = integer(options.cacheBytes ?? 8 * 1024 * 1024, 'cacheBytes', 0, 1024 * 1024 * 1024)
    const pageSize = integer(options.pageSize ?? 256, 'pageSize', 1, 4096)
    const cache = new Map()
    const spaces = new Map()
    const statements = new Map()
    let cacheBytes = 0, cacheHits = 0, cacheMisses = 0
    const stmt = sql => {
      if (!statements.has(sql)) statements.set(sql, db.prepare(sql))
      return statements.get(sql)
    }
    const tx = fn => {
      db.exec('BEGIN IMMEDIATE')
      try { const result = fn(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error }
    }
    const invalidate = () => { cache.clear(); cacheBytes = 0 }
    const spaceRow = id => {
      text(id, 'spaceId')
      const row = stmt('SELECT * FROM vector_spaces WHERE spaceId=?').get(id)
      if (!row) fail('UNKNOWN_SPACE', `Space is not registered: ${id}`)
      return row
    }
    const spaceOf = id => {
      if (!spaces.has(id)) spaces.set(id, defineEmbeddingSpace(JSON.parse(spaceRow(id).contract)))
      return spaces.get(id)
    }
    const writable = id => {
      const row = spaceRow(id)
      if (row.needsRebuild) fail('REBUILD_REQUIRED', 'Space drift detected; register a new space before encoding/writing')
      return row
    }
    const generationRow = (id, generation) => {
      text(generation, 'generation')
      const row = stmt('SELECT * FROM vector_generations WHERE spaceId=? AND generation=?').get(id, generation)
      if (!row) fail('UNKNOWN_GENERATION', 'Generation does not exist')
      return row
    }
    const enqueue = (spaceId, generation, id, kind) => {
      if (remote) stmt('INSERT OR REPLACE INTO vector_outbox(spaceId,generation,id,kind) VALUES(?,?,?,?)').run(spaceId, generation, id, kind)
    }
    const blobOf = vector => {
      const blob = Buffer.allocUnsafe(vector.length * 4)
      for (let i = 0; i < vector.length; i++) blob.writeFloatLE(vector[i], i * 4)
      return blob
    }
    const decode = (row, useCache = true) => {
      const key = JSON.stringify([row.spaceId, row.generation, row.id, row.sourceRevision, row.scopeRevision])
      if (useCache && cache.has(key)) {
        const entry = cache.get(key); cache.delete(key); cache.set(key, entry); cacheHits++; return entry.vector
      }
      cacheMisses++
      const blob = Buffer.from(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength)
      const vector = new Float32Array(blob.length / 4)
      for (let i = 0; i < vector.length; i++) vector[i] = blob.readFloatLE(i * 4)
      const bytes = vector.byteLength + key.length * 2 + 128
      if (useCache && bytes <= cacheBudget) {
        while (cacheBytes + bytes > cacheBudget && cache.size) {
          const oldest = cache.keys().next().value; cacheBytes -= cache.get(oldest).bytes; cache.delete(oldest)
        }
        cache.set(key, { vector, bytes }); cacheBytes += bytes
      }
      return vector
    }
    const publicRecord = row => ({ id: row.id, sourceRevision: row.sourceRevision, scopeRevision: row.scopeRevision, account: row.account, chat: row.chat, category: row.category, persona: row.persona, metadata: JSON.parse(row.metadata), spaceId: row.spaceId, generation: row.generation })
    const missingCount = (spaceId, generation) => stmt(`SELECT COUNT(*) AS n FROM vector_heads h
      WHERE h.spaceId=? AND h.deleted=0 AND NOT EXISTS(SELECT 1 FROM vector_rows v WHERE v.spaceId=h.spaceId AND v.id=h.id AND v.generation=? AND v.sourceRevision=h.sourceRevision AND v.scopeRevision=h.scopeRevision)`).get(spaceId, generation).n
    const operations = {
      registerSpace({ space }) {
        const contract = defineEmbeddingSpace(space), fingerprint = spaceFingerprint(contract)
        return tx(() => {
          const old = stmt('SELECT * FROM vector_spaces WHERE spaceId=?').get(contract.spaceId)
          if (old && old.fingerprint !== fingerprint) fail('SPACE_MISMATCH', 'A spaceId is immutable, including model revision and preprocessing')
          if (!old) {
            stmt('INSERT INTO vector_spaces(spaceId,contract,fingerprint,active) VALUES(?,?,?,?)').run(contract.spaceId, JSON.stringify(contract), fingerprint, 'g0')
            stmt('INSERT INTO vector_generations VALUES(?,?,?)').run(contract.spaceId, 'g0', 'active')
          }
          spaces.set(contract.spaceId, contract)
          return { spaceId: contract.spaceId, fingerprint, generation: old?.active ?? 'g0' }
        })
      },
      describe({ spaceId }) {
        const row = spaceRow(spaceId)
        return { space: spaceOf(spaceId), generation: row.active, fingerprint: row.fingerprint, needsRebuild: !!row.needsRebuild, generations: stmt('SELECT generation,state FROM vector_generations WHERE spaceId=?').all(spaceId) }
      },
      upsert({ spaceId, generation, records }) {
        const space = spaceOf(spaceId)
        if (!Array.isArray(records) || records.length > 256 || records.length * space.dims * 4 > 16 * 1024 * 1024) fail('BATCH_TOO_LARGE', 'upsert accepts at most 256 records / 16 MiB of vector data')
        const prepared = records.map(input => {
          if (input.spaceId !== undefined && input.spaceId !== spaceId) fail('SPACE_MISMATCH', 'Record spaceId differs')
          const record = normalizeRecord(input), vector = validateVector(input.vector, space), blob = blobOf(vector)
          return { record, blob, scope: canonical([record.account, record.chat, record.category, record.persona]), hash: createHash('sha256').update(blob).update(canonical(record)).digest('hex') }
        })
        const result = tx(() => {
          const active = writable(spaceId).active
          const target = generation ?? active
          const state = generationRow(spaceId, target).state
          if (!['active', 'building', 'ready'].includes(state)) fail('GENERATION_NOT_WRITABLE', 'Cannot write an inactive or failed generation')
          const mirrors = stmt("SELECT generation FROM vector_generations WHERE spaceId=? AND state IN ('active','building','ready')").all(spaceId).map(r => r.generation)
          let accepted = 0, skipped = 0
          for (const { record: r, blob, hash, scope } of prepared) {
            const head = stmt('SELECT * FROM vector_heads WHERE spaceId=? AND id=?').get(spaceId, r.id)
            if (head?.deleted || (head && (r.sourceRevision < head.sourceRevision || r.scopeRevision < head.scopeRevision))) { skipped++; continue }
            const same = head && r.sourceRevision === head.sourceRevision && r.scopeRevision === head.scopeRevision
            if (same && hash !== head.hash) fail('REVISION_CONFLICT', 'A source/scope revision pair must identify immutable content')
            if (head && scope !== head.scope && r.scopeRevision <= head.scopeRevision) fail('SCOPE_REVISION_REQUIRED', 'Scope changes must increase scopeRevision')
            stmt('INSERT OR REPLACE INTO vector_heads VALUES(?,?,?,?,?,?,?)').run(spaceId, r.id, r.sourceRevision, r.scopeRevision, 0, hash, scope)
            // Snapshot replay populates only its target. New revisions propagate to every serving/building generation.
            const targets = generation === undefined || !same ? mirrors : [target]
            for (const gen of targets) {
              stmt('INSERT OR REPLACE INTO vector_rows VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(spaceId, gen, r.id, r.sourceRevision, r.scopeRevision, r.account, r.chat, r.category, r.persona, JSON.stringify(r.metadata), blob)
              enqueue(spaceId, gen, r.id, 'upsert')
            }
            accepted++
          }
          return { accepted, skipped, spaceId, generation: target }
        })
        invalidate()
        return result
      },
      delete({ spaceId, ids, sourceRevision }) {
        spaceRow(spaceId); integer(sourceRevision, 'sourceRevision')
        ids = normalizeIds(ids, 10000)
        const result = tx(() => {
          const generations = stmt('SELECT generation FROM vector_generations WHERE spaceId=?').all(spaceId)
          let deleted = 0, skipped = 0
          for (const id of ids) {
            const head = stmt('SELECT * FROM vector_heads WHERE spaceId=? AND id=?').get(spaceId, id)
            if (head && sourceRevision < head.sourceRevision) { skipped++; continue }
            stmt('INSERT OR REPLACE INTO vector_heads VALUES(?,?,?,?,?,?,?)').run(spaceId, id, sourceRevision, head?.scopeRevision ?? 0, 1, '', head?.scope ?? '')
            stmt('DELETE FROM vector_rows WHERE spaceId=? AND id=?').run(spaceId, id)
            for (const { generation } of generations) enqueue(spaceId, generation, id, 'delete')
            deleted++
          }
          return { deleted, skipped }
        })
        invalidate(); return result
      },
      query({ spaceId, vector, filter: input, authorizedIds, limit }) {
        const space = spaceOf(spaceId), q = validateVector(vector, space), filter = normalizeFilter(input), k = queryLimit(limit)
        const generation = spaceRow(spaceId).active
        const ids = authorizedIds === undefined ? undefined : normalizeIds(authorizedIds)
        if (!filter.scopes.length || ids?.length === 0) return { hits: [], spaceId, generation, stats: { scanned: 0, pages: 0 } }
        db.exec('DELETE FROM authorized_ids')
        if (ids) tx(() => { for (const id of ids) stmt('INSERT INTO authorized_ids VALUES(?)').run(id) })
        const params = [spaceId, generation, filter.account]
        const clauses = filter.scopes.map(scope => {
          let sql = 'v.chat IN (SELECT value FROM json_each(?)) AND v.persona IN (SELECT value FROM json_each(?))'
          params.push(JSON.stringify(scope.chats), JSON.stringify(scope.personas))
          if (scope.categories) { sql += ' AND v.category IN (SELECT value FROM json_each(?))'; params.push(JSON.stringify(scope.categories)) }
          return `(${sql})`
        })
        // A scope-ordered scan avoids reading unrelated chats. For broad multi-chat scans,
        // business-ID order preserves sequential table access and avoids repeated range seeks.
        const narrow = new Set(filter.scopes.flatMap(scope => scope.chats)).size === 1
        const pageCondition = narrow ? '(v.chat,v.category,v.persona,v.id)>(?,?,?,?)' : 'v.id>?'
        const order = narrow ? 'v.chat,v.category,v.persona,v.id' : 'v.id'
        const sql = `SELECT v.* FROM vector_rows v ${narrow ? 'INDEXED BY vector_scope' : ''} JOIN vector_heads h ON h.spaceId=v.spaceId AND h.id=v.id AND h.deleted=0 AND h.sourceRevision=v.sourceRevision AND h.scopeRevision=v.scopeRevision
          WHERE v.spaceId=? AND v.generation=? AND v.account=? AND (${clauses.join(' OR ')}) ${ids ? 'AND v.id IN (SELECT id FROM authorized_ids)' : ''}
          AND ${pageCondition} ORDER BY ${order} LIMIT ?`
        // Dynamic filters are intentionally not put in the persistent statement cache.
        const page = db.prepare(sql), heap = []
        const pageLimit = Math.min(pageSize, Math.max(1, Math.floor(4 * 1024 * 1024 / (space.dims * 4 + 16384))))
        let after = narrow ? ['', '', '', ''] : [''], scanned = 0, pages = 0
        db.exec('BEGIN')
        try {
          while (true) {
            const rows = page.all(...params, ...after, pageLimit)
            if (!rows.length) break
            pages++
            for (const row of rows) {
              scanned++
              const hit = { ...publicRecord(row), score: vectorScore(q, decode(row), space.metric) }
              heapOffer(heap, hit, k)
            }
            const last = rows.at(-1)
            after = narrow ? [last.chat, last.category, last.persona, last.id] : [last.id]
            if (rows.length < pageLimit) break
          }
          db.exec('COMMIT')
        } catch (error) { db.exec('ROLLBACK'); throw error }
        finally { db.exec('DELETE FROM authorized_ids') }
        return { hits: heap.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)), spaceId, generation, stats: { scanned, pages, cacheBytes, cacheHits, cacheMisses, accessPath: narrow ? 'scope' : 'business-id' } }
      },
      beginRebuild({ spaceId, generation }) {
        return tx(() => {
          const active = writable(spaceId).active; text(generation, 'generation')
          if (active === generation) fail('ACTIVE_GENERATION', 'Cannot rebuild the serving generation')
          const other = stmt("SELECT generation FROM vector_generations WHERE spaceId=? AND generation<>? AND state IN ('building','ready')").get(spaceId, generation)
          if (other) fail('REBUILD_BUSY', 'Finish the existing candidate generation first')
          const existing = stmt('SELECT state FROM vector_generations WHERE spaceId=? AND generation=?').get(spaceId, generation)
          if (existing?.state === 'retired') fail('RETIRED_GENERATION', 'Use a fresh generation ID')
          stmt('INSERT OR REPLACE INTO vector_generations VALUES(?,?,?)').run(spaceId, generation, 'building')
          return { spaceId, generation, state: 'building', resumed: !!existing }
        })
      },
      finishRebuild({ spaceId, generation }) {
        return tx(() => {
          if (generationRow(spaceId, generation).state !== 'building') fail('GENERATION_NOT_BUILDING', 'No build is in progress')
          const missing = missingCount(spaceId, generation)
          if (missing) fail('INCOMPLETE_GENERATION', `${missing} current records are missing from the candidate generation`)
          stmt('UPDATE vector_generations SET state=? WHERE spaceId=? AND generation=?').run('ready', spaceId, generation)
          return { spaceId, generation, state: 'ready' }
        })
      },
      failRebuild({ spaceId, generation }) {
        stmt("UPDATE vector_generations SET state='failed' WHERE spaceId=? AND generation=? AND state='building'").run(spaceId, generation)
        return { spaceId, generation, state: 'failed' }
      },
      switchGeneration({ spaceId, generation, expectedGeneration }) {
        return tx(() => {
          const current = writable(spaceId).active
          if (current === generation) return { spaceId, generation, previousGeneration: current }
          if (expectedGeneration !== undefined && expectedGeneration !== current) fail('GENERATION_CONFLICT', 'Serving generation changed')
          if (generationRow(spaceId, generation).state !== 'ready') fail('GENERATION_NOT_READY', 'Only a completed generation can be published')
          if (missingCount(spaceId, generation)) fail('INCOMPLETE_GENERATION', 'Candidate has not caught up to current source/scope revisions')
          if (remote && stmt('SELECT 1 FROM vector_outbox WHERE spaceId=? LIMIT 1').get(spaceId)) fail('PENDING_SYNC', 'Remote writes must complete before switching')
          stmt('UPDATE vector_generations SET state=? WHERE spaceId=? AND generation=?').run('retired', spaceId, current)
          stmt('UPDATE vector_generations SET state=? WHERE spaceId=? AND generation=?').run('active', spaceId, generation)
          stmt('UPDATE vector_spaces SET active=? WHERE spaceId=?').run(generation, spaceId)
          invalidate(); return { spaceId, generation, previousGeneration: current }
        })
      },
      markNeedsRebuild({ spaceId, reason }) {
        spaceRow(spaceId); text(reason, 'reason', { max: 1000 })
        stmt('UPDATE vector_spaces SET needsRebuild=1,reason=? WHERE spaceId=?').run(reason, spaceId)
        return { spaceId, needsRebuild: true, reason }
      },
      switchIntent({ spaceId, generation }) {
        const key = `switch:${text(spaceId, 'spaceId')}`
        if (generation === null) { stmt('DELETE FROM vector_meta WHERE key=?').run(key); return null }
        if (generation !== undefined) {
          if (generationRow(spaceId, generation).state !== 'ready') fail('GENERATION_NOT_READY', 'Only a completed generation can be published')
          if (missingCount(spaceId, generation)) fail('INCOMPLETE_GENERATION', 'Candidate is missing current records')
          stmt('INSERT OR REPLACE INTO vector_meta VALUES(?,?)').run(key, generation)
        }
        return stmt('SELECT value FROM vector_meta WHERE key=?').get(key)?.value ?? null
      },
      outbox({ limit = 128 } = {}) {
        integer(limit, 'outbox limit', 1, 256)
        const rows = stmt('SELECT * FROM vector_outbox ORDER BY seq LIMIT ?').all(limit)
        return rows.map(row => {
          if (row.kind === 'delete') return row
          const data = stmt('SELECT * FROM vector_rows WHERE spaceId=? AND generation=? AND id=?').get(row.spaceId, row.generation, row.id)
          if (!data) fail('CORRUPT_OUTBOX', 'Pending vector is missing')
          return { ...row, record: publicRecord(data), vector: decode(data, false) }
        })
      },
      ackOutbox({ seqs }) {
        return tx(() => { for (const seq of seqs) stmt('DELETE FROM vector_outbox WHERE seq=?').run(integer(seq, 'sequence')); return { acknowledged: seqs.length } })
      },
      validateHits({ spaceId, generation, hits, filter: input, authorizedIds }) {
        const filter = normalizeFilter(input), ids = authorizedIds === undefined ? undefined : new Set(normalizeIds(authorizedIds))
        return hits.filter(hit => {
          if (!Number.isFinite(hit.score) || (ids && !ids.has(hit.id))) return false
          const row = stmt(`SELECT v.* FROM vector_rows v JOIN vector_heads h ON h.spaceId=v.spaceId AND h.id=v.id AND h.deleted=0 AND h.sourceRevision=v.sourceRevision AND h.scopeRevision=v.scopeRevision WHERE v.spaceId=? AND v.generation=? AND v.id=?`).get(spaceId, generation, hit.id)
          return row && row.sourceRevision === hit.sourceRevision && row.scopeRevision === hit.scopeRevision && allowedByFilter(row, filter)
        }).map(hit => {
          const row = stmt('SELECT * FROM vector_rows WHERE spaceId=? AND generation=? AND id=?').get(spaceId, generation, hit.id)
          return { ...publicRecord(row), score: hit.score }
        })
      },
      lexicalSearch({ items, query, limit = 60, now = Date.now() }) {
        if (!Array.isArray(items) || items.length > 10000) fail('LEXICAL_LIMIT', 'Worker lexical search accepts at most 10000 authorized items')
        return lexicalSearch(buildIndex(items), String(query), { limit: queryLimit(limit), minScore: 0.01, now }).map(hit => ({ id: hit.it.id, score: hit.score, why: hit.why }))
      },
      serviceState({ key, value }) {
        text(key, 'state key')
        if (value !== undefined) stmt('INSERT OR REPLACE INTO vector_service_state VALUES(?,?)').run(key, JSON.stringify(value))
        const row = stmt('SELECT value FROM vector_service_state WHERE key=?').get(key)
        return row ? JSON.parse(row.value) : null
      },
      serviceRefs({ role, kind, sourceId, scope, ref, remove = false, limit = 10001, cursor }) {
        if (ref) {
          stmt('INSERT OR REPLACE INTO vector_service_refs VALUES(?,?,?,?,?,?,?,?)').run(ref.role, ref.kind, ref.sourceId, ref.vectorId, ref.spaceId, ref.revision, ref.snapshotHash, canonical(ref.scope))
          return ref
        }
        const params = [], conditions = []
        for (const [key, value] of Object.entries({ role, kind, sourceId })) if (value !== undefined) { conditions.push(`${key}=?`); params.push(text(value, key)) }
        if (scope !== undefined) { conditions.push('scope=?'); params.push(canonical(scope)) }
        if (cursor !== undefined) {
          if (!role || !kind) fail('INVALID_CONTRACT', 'Reference pagination requires role and kind')
          conditions.push('sourceId>?'); params.push(String(cursor))
        }
        if (remove && (!role || !kind || !sourceId)) fail('INVALID_CONTRACT', 'Removing a service reference requires role/kind/sourceId')
        const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
        if (remove) { db.prepare('DELETE FROM vector_service_refs' + where).run(...params); return null }
        integer(limit, 'ref limit', 1, 100001)
        return db.prepare('SELECT * FROM vector_service_refs' + where + ' ORDER BY role,kind,sourceId LIMIT ?').all(...params, limit).map(r => ({ ...r, scope: JSON.parse(r.scope) }))
      },
      serviceJobs({ action, job, id, limit = 50, maxPending = 256, maxAttempts = 3, error = null, result = null }) {
        const decodeJob = row => row ? { ...row, payload: JSON.parse(row.payload), result: row.result ? JSON.parse(row.result) : null } : null
        if (action === 'recover') { stmt("UPDATE vector_service_jobs SET state='queued' WHERE state='running'").run(); return true }
        if (action === 'enqueue') return tx(() => {
          const existing = stmt('SELECT * FROM vector_service_jobs WHERE id=?').get(job.id)
          if (existing) {
            if (existing.kind !== job.kind || canonical(JSON.parse(existing.payload)) !== canonical(job.payload)) fail('JOB_CONFLICT', 'Idempotency key was reused for a different operation')
            return decodeJob(existing)
          }
          if (stmt("SELECT COUNT(*) AS n FROM vector_service_jobs WHERE state IN ('queued','running')").get().n >= maxPending) fail('QUEUE_FULL', 'Persistent vector service queue is full; retry from the source outbox')
          stmt('INSERT INTO vector_service_jobs(id,kind,payload,state,updated) VALUES(?,?,?,?,?)').run(job.id, job.kind, JSON.stringify(job.payload), 'queued', Date.now())
          return decodeJob(stmt('SELECT * FROM vector_service_jobs WHERE id=?').get(job.id))
        })
        if (action === 'claim') return tx(() => {
          const next = stmt("SELECT * FROM vector_service_jobs WHERE state='queued' ORDER BY updated,id LIMIT 1").get()
          if (!next) return null
          if (next.attempts >= maxAttempts) { stmt("UPDATE vector_service_jobs SET state='failed',error='ATTEMPTS_EXHAUSTED' WHERE id=?").run(next.id); return { exhausted: true } }
          stmt("UPDATE vector_service_jobs SET state='running',attempts=attempts+1,updated=? WHERE id=?").run(Date.now(), next.id)
          return decodeJob(stmt('SELECT * FROM vector_service_jobs WHERE id=?').get(next.id))
        })
        if (action === 'finish') {
          stmt("UPDATE vector_service_jobs SET state=?,error=?,result=?,updated=? WHERE id=? AND state='running'").run(error ? 'failed' : 'succeeded', error, result ? JSON.stringify(result) : null, Date.now(), id)
          return decodeJob(stmt('SELECT * FROM vector_service_jobs WHERE id=?').get(id))
        }
        if (action === 'cancel') stmt("UPDATE vector_service_jobs SET state='cancelled',updated=? WHERE id=? AND state IN ('queued','running')").run(Date.now(), id)
        if (action === 'release') stmt("UPDATE vector_service_jobs SET state='queued',updated=? WHERE id=? AND state='running'").run(Date.now(), id)
        if (action === 'retry') stmt("UPDATE vector_service_jobs SET state='queued',error=NULL,updated=? WHERE id=? AND state IN ('failed','cancelled') AND attempts<?").run(Date.now(), id, maxAttempts)
        if (id) return decodeJob(stmt('SELECT * FROM vector_service_jobs WHERE id=?').get(id))
        integer(limit, 'job limit', 1, 100)
        return stmt('SELECT * FROM vector_service_jobs ORDER BY updated DESC,id LIMIT ?').all(limit).map(decodeJob)
      },
      health() {
        return { ok: true, backend: remote ? 'qdrant-journal' : 'local', sqliteVersion: stmt('SELECT sqlite_version() AS v').get().v,
          spaces: stmt('SELECT spaceId,active AS generation,needsRebuild,reason FROM vector_spaces').all().map(s => ({ ...s, needsRebuild: !!s.needsRebuild, records: stmt('SELECT COUNT(*) AS n FROM vector_rows WHERE spaceId=? AND generation=?').get(s.spaceId, s.generation).n })),
          generations: stmt('SELECT * FROM vector_generations').all(), pending: stmt('SELECT COUNT(*) AS n FROM vector_outbox').get().n,
          cache: { bytes: cacheBytes, budgetBytes: cacheBudget, entries: cache.size, hits: cacheHits, misses: cacheMisses }, pageSize, workerMemory: process.memoryUsage() }
      },
      close() { invalidate(); db.close(); return { closed: true } },
    }
    parentPort.on('message', ({ id, method, args }) => {
      try {
        if (!Object.hasOwn(operations, method)) fail('UNKNOWN_OPERATION', 'Unknown vector operation')
        const result = operations[method](args ?? {})
        parentPort.postMessage({ id, result })
        if (method === 'close') parentPort.close()
      } catch (error) { parentPort.postMessage({ id, error: { code: error.code ?? 'VECTOR_STORAGE_ERROR', message: error.message } }) }
    })
    parentPort.postMessage({ ready: true })
  } catch (error) {
    try { db?.close() } catch {}
    parentPort.postMessage({ startupError: { code: error.code ?? 'VECTOR_STORAGE_ERROR', message: error.message } })
    parentPort.close()
  }
}

function worse(a, b) { return a.score < b.score || (a.score === b.score && a.id.localeCompare(b.id) > 0) }
function heapOffer(heap, hit, limit) {
  if (heap.length < limit) {
    heap.push(hit)
    for (let i = heap.length - 1; i > 0;) {
      const parent = (i - 1) >> 1
      if (!worse(heap[i], heap[parent])) break
      ;[heap[i], heap[parent]] = [heap[parent], heap[i]]; i = parent
    }
  } else if (worse(heap[0], hit)) {
    heap[0] = hit
    for (let i = 0;;) {
      let child = i * 2 + 1
      if (child >= heap.length) break
      if (child + 1 < heap.length && worse(heap[child + 1], heap[child])) child++
      if (!worse(heap[child], heap[i])) break
      ;[heap[i], heap[child]] = [heap[child], heap[i]]; i = child
    }
  }
}

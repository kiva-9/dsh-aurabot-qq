import { setImmediate as yieldPage } from 'node:timers/promises'
import { scopeOf, scopeKey } from '../../scope.js'
import { digest } from '../../embedding/space.js'

const imageScope = alias => `CASE WHEN json_valid(${alias}.scope_json) THEN ${alias}.scope_json ELSE '{}' END`
const factSelect = (where, alias = 'f') => `SELECT ${alias}.id source_id,${alias}.account account,${alias}.chat chat,${alias}.persona persona FROM memory_facts ${alias} WHERE ${where}`
const imageSelect = (where, alias = 'o') => `SELECT ${alias}.id source_id,json_extract(${imageScope(alias)},'$.account') account,${alias}.chat_id chat,COALESCE(json_extract(${imageScope(alias)},'$.persona'),'') persona FROM asset_occurrences ${alias} WHERE ${where}`

/** Coalescing receipts are written by triggers in the SAME transaction as the authoritative source. */
export function createSourceOutbox({ storage, repo, imageRepo, service, target, getAccount = () => '', options = {} }) {
  const db = storage.db
  const config = { pageSize: 128, maxJobsPerTick: 8, scopesPerTick: 8, ...options }
  db.tx(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS retrieval_source_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,source_id TEXT NOT NULL,
      account TEXT NOT NULL,chat TEXT NOT NULL,persona TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,fingerprint TEXT,state TEXT NOT NULL DEFAULT 'pending',
      accepted_job TEXT,accepted_target TEXT,UNIQUE(kind,source_id,account,chat,persona));
      CREATE INDEX IF NOT EXISTS retrieval_source_pending ON retrieval_source_outbox(account,state,id);
      CREATE TABLE IF NOT EXISTS retrieval_source_scans (
        scope_key TEXT NOT NULL,kind TEXT NOT NULL,scope_json TEXT NOT NULL,cursor TEXT NOT NULL DEFAULT '',
        stamp TEXT,done INTEGER NOT NULL DEFAULT 0,touched INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(scope_key,kind));
      CREATE TABLE IF NOT EXISTS retrieval_source_clock (
        account TEXT NOT NULL,chat TEXT NOT NULL,persona TEXT NOT NULL,kind TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(account,chat,persona,kind));
      CREATE TABLE IF NOT EXISTS retrieval_source_discovery (
        account TEXT NOT NULL,kind TEXT NOT NULL,cursor TEXT NOT NULL DEFAULT '',done INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(account,kind));`)
    const event = (kind, select) => `
      INSERT INTO retrieval_source_outbox(kind,source_id,account,chat,persona)
      SELECT '${kind}',source_id,account,chat,persona FROM (${select}) WHERE account IS NOT NULL AND account<>''
      ON CONFLICT(kind,source_id,account,chat,persona) DO UPDATE SET version=version+1,state='pending',fingerprint=NULL;
      INSERT INTO retrieval_source_clock(account,chat,persona,kind)
      SELECT DISTINCT account,chat,persona,'${kind}' FROM (${select}) WHERE account IS NOT NULL AND account<>''
      ON CONFLICT(account,chat,persona,kind) DO UPDATE SET revision=revision+1;
      INSERT INTO retrieval_source_scans(scope_key,kind,scope_json)
      SELECT json_object('account',account,'chat',chat,'persona',persona),'${kind}',json_object('account',account,'chat',chat,'persona',persona)
      FROM (${select}) WHERE account IS NOT NULL AND account<>'' ON CONFLICT(scope_key,kind) DO NOTHING;`
    // Replace only this module's named triggers, atomically with installation, so upgrades repair definitions.
    const trigger = (name, when, table, body) => db.exec(`DROP TRIGGER IF EXISTS retrieval_v1_${name}; CREATE TRIGGER retrieval_v1_${name} AFTER ${when} ON ${table} BEGIN ${body} END;`)
    for (const [table, kind, columns] of [
      ['memory_facts', 'fact', a => `SELECT ${a}.id source_id,${a}.account account,${a}.chat chat,${a}.persona persona`],
      ['asset_occurrences', 'image', a => `SELECT ${a}.id source_id,json_extract(${imageScope(a)},'$.account') account,${a}.chat_id chat,COALESCE(json_extract(${imageScope(a)},'$.persona'),'') persona`],
    ]) {
      trigger(`${kind}_insert`, 'INSERT', table, event(kind, columns('NEW')))
      trigger(`${kind}_update`, 'UPDATE', table, event(kind, columns('OLD')) + event(kind, columns('NEW')))
      trigger(`${kind}_delete`, 'DELETE', table, event(kind, columns('OLD')))
    }
    for (const op of ['UPDATE', 'DELETE']) {
      trigger(`evidence_${op.toLowerCase()}`, op, 'memory_evidence', event('fact', factSelect('f.id IN (SELECT fact_id FROM memory_fact_evidence WHERE evidence_id=OLD.id)')))
      trigger(`message_${op.toLowerCase()}`, op, 'messages', event('image', imageSelect('o.message_id=OLD.id')) + event('fact', factSelect('f.id IN (SELECT l.fact_id FROM memory_fact_evidence l JOIN memory_evidence e ON e.id=l.evidence_id WHERE e.message_id=OLD.id)')))
      trigger(`asset_${op.toLowerCase()}`, op, 'assets', event('image', imageSelect('o.asset_id=OLD.id')))
    }
    trigger('link_insert', 'INSERT', 'memory_fact_evidence', event('fact', factSelect('f.id=NEW.fact_id')))
    trigger('link_delete', 'DELETE', 'memory_fact_evidence', event('fact', factSelect('f.id=OLD.fact_id')))
    for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
      const ref = op === 'DELETE' ? 'OLD' : 'NEW'
      trigger(`tombstone_${op.toLowerCase()}`, op, 'memory_tombstones', event('fact', factSelect(`f.account=${ref}.account AND f.chat=${ref}.chat AND f.persona=${ref}.persona AND ((${ref}.kind='fact' AND f.id=${ref}.key) OR (${ref}.kind='fingerprint' AND f.fingerprint=${ref}.key))`)))
    }
    for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
      const ref = op === 'INSERT' ? 'NEW' : 'OLD'
      trigger(`lineage_${op.toLowerCase()}`, op, 'generation_lineage', event('image', imageSelect(`json_extract(CASE WHEN json_valid(o.remote_json) THEN o.remote_json ELSE '{}' END,'$.jobId')=${ref}.job_id`)))
    }
    for (const op of ['UPDATE', 'DELETE']) trigger(`job_${op.toLowerCase()}`, op, 'jobs', event('image', imageSelect("json_extract(CASE WHEN json_valid(o.remote_json) THEN o.remote_json ELSE '{}' END,'$.jobId')=OLD.id")))
  })
  const source = kind => kind === 'fact' ? repo : imageRepo
  const registerScope = input => {
    const scope = scopeOf(input), key = scopeKey(scope)
    for (const kind of ['fact', 'image']) if (source(kind)) db.run('INSERT OR IGNORE INTO retrieval_source_scans(scope_key,kind,scope_json) VALUES(?,?,?)', key, kind, JSON.stringify(scope))
    return scope
  }
  const mark = (kind, scope, id, fingerprint) => db.run(`INSERT INTO retrieval_source_outbox(kind,source_id,account,chat,persona,fingerprint) VALUES(?,?,?,?,?,?)
    ON CONFLICT(kind,source_id,account,chat,persona) DO UPDATE SET version=version+1,state='pending',fingerprint=excluded.fingerprint
    WHERE retrieval_source_outbox.fingerprint IS NOT excluded.fingerprint`, kind, id, scope.account, scope.chat, scope.persona, fingerprint)
  async function scan() {
    const account = getAccount()
    for (const kind of ['fact', 'image']) {
      db.run('INSERT OR IGNORE INTO retrieval_source_discovery(account,kind) VALUES(?,?)', account, kind)
      const discovery = db.get('SELECT * FROM retrieval_source_discovery WHERE account=? AND kind=?', account, kind)
      if (discovery.done) continue
      const select = kind === 'fact' ? factSelect('f.account=? AND f.id>?') : imageSelect("json_extract(CASE WHEN json_valid(o.scope_json) THEN o.scope_json ELSE '{}' END,'$.account')=? AND o.id>?")
      const rows = db.all(`SELECT * FROM (${select}) ORDER BY source_id LIMIT ?`, account, discovery.cursor, config.pageSize)
      db.tx(() => {
        for (const row of rows) { try { registerScope(row) } catch {} }
        db.run('UPDATE retrieval_source_discovery SET cursor=?,done=? WHERE account=? AND kind=?', rows.at(-1)?.source_id ?? discovery.cursor, rows.length < config.pageSize ? 1 : 0, account, kind)
      })
      await yieldPage()
    }
    // Scopes changed since installation are recoverable even if no chat currently has a session.
    for (const row of db.all('SELECT DISTINCT account,chat,persona FROM retrieval_source_outbox WHERE account=? ORDER BY id LIMIT 256', account)) { try { registerScope(row) } catch {} }
    const scopes = db.all('SELECT * FROM retrieval_source_scans WHERE json_extract(scope_json,\'$.account\')=? ORDER BY touched,scope_key,kind LIMIT ?', account, config.scopesPerTick)
    let scanned = 0
    for (const row of scopes) {
      let scope
      try { scope = scopeOf(JSON.parse(row.scope_json)) }
      catch { db.run('UPDATE retrieval_source_scans SET done=1,touched=? WHERE scope_key=? AND kind=?', Date.now(), row.scope_key, row.kind); continue }
      const repository = source(row.kind)
      if (!repository?.page) continue
      const clock = db.get('SELECT revision FROM retrieval_source_clock WHERE account=? AND chat=? AND persona=? AND kind=?', scope.account, scope.chat, scope.persona, row.kind)?.revision || 0
      const stamp = digest([clock, repository.visibilityStamp?.(scope) ?? null, target])
      // A completed range is swept again even without a revision change: time validity and
      // missing asset files can change visibility without a SQL write. Fingerprints avoid re-encoding.
      const cursor = row.done ? '' : row.cursor
      const page = repository.page(scope, { cursor, limit: config.pageSize, owned: true })
      const items = new Map(page.items.map(item => [item.id, item]))
      db.tx(() => {
        for (const id of page.sourceIds) mark(row.kind, scope, id, digest([items.get(id) ?? null, target]))
        db.run('UPDATE retrieval_source_scans SET cursor=?,stamp=?,done=?,touched=? WHERE scope_key=? AND kind=?', page.nextCursor, row.stamp && !row.done ? row.stamp : stamp, page.done ? 1 : 0, Date.now(), row.scope_key, row.kind)
      })
      scanned += page.scanned
      await yieldPage()
    }
    return scanned
  }
  let running = null, stopped = false, dispatchCursor = 0
  async function drain() {
    const account = getAccount()
    let rows = db.all("SELECT * FROM retrieval_source_outbox WHERE account=? AND id>? AND (state='pending' OR accepted_target IS NOT ?) ORDER BY id LIMIT ?", account, dispatchCursor, target, config.pageSize * config.maxJobsPerTick)
    if (!rows.length && dispatchCursor) {
      dispatchCursor = 0
      rows = db.all("SELECT * FROM retrieval_source_outbox WHERE account=? AND (state='pending' OR accepted_target IS NOT ?) ORDER BY id LIMIT ?", account, target, config.pageSize * config.maxJobsPerTick)
    }
    dispatchCursor = rows.at(-1)?.id ?? 0
    const groups = new Map()
    for (const row of rows) {
      let scope
      try { scope = scopeOf(row) } catch { continue }
      const repository = source(row.kind)
      const roles = service._roles(undefined, row.kind)
      const live = repository?.get(row.source_id, scope)
      // No automatic paid probes. Live encoding stays pending until ALL its configured roles are admitted.
      if (live && (!roles.length || roles.some(role => !service.encoders.get(role).health().ready))) continue
      const key = `${scopeKey(scope)}:${row.kind}`
      const batches = groups.get(key) ?? []
      if (!batches.length || batches.at(-1).rows.length >= config.pageSize) batches.push({ scope, kind: row.kind, roles, rows: [] })
      batches.at(-1).rows.push(row); groups.set(key, batches)
    }
    let accepted = 0, jobs = 0
    for (const batch of [...groups.values()].flat().slice(0, config.maxJobsPerTick)) {
      if (stopped || account !== getAccount()) break
      const receipt = await service.enqueueIndex({ scope: batch.scope, kind: batch.kind, roles: batch.roles, ids: batch.rows.map(row => row.source_id),
        idempotencyKey: digest([target, batch.kind, batch.scope, batch.roles, batch.rows.map(row => [row.id, row.version])]) })
      // Cross-database delivery is at least once. CAS prevents an edit during await from being acknowledged.
      db.tx(() => {
        for (const row of batch.rows) accepted += db.run("UPDATE retrieval_source_outbox SET state='accepted',accepted_job=?,accepted_target=? WHERE id=? AND version=?", receipt.jobId, target, row.id, row.version).changes
      })
      jobs++
    }
    return { accepted, jobs }
  }
  const tick = () => {
    if (stopped) return Promise.resolve({ stopped: true })
    if (running) return running
    running = (async () => ({ scanned: await scan(), ...await drain() }))().finally(() => { running = null })
    return running
  }
  return { registerScope, tick, drain, scan,
    status: () => ({ counts: db.all("SELECT CASE WHEN state='pending' OR accepted_target IS NOT ? THEN 'pending' ELSE 'accepted' END state,COUNT(*) count FROM retrieval_source_outbox WHERE account=? GROUP BY 1", target, getAccount()), scopes: db.get('SELECT COUNT(*) count FROM retrieval_source_scans WHERE json_extract(scope_json,\'$.account\')=?', getAccount()).count }),
    async stop() { stopped = true; await running },
  }
}

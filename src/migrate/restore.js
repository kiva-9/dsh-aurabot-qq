// Offline, isolation-only restore preparation. Importing this file performs no IO.
// Deliberately no install/swap option: a database cannot prove that its own deletion
// history is complete. The caller must keep DSH stopped and review the output.
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ensureSchema as ensureMemorySchema } from '../memory/schema.js'
import { factFingerprint } from '../memory/contracts.js'
import { scopeKey } from '../memory/scope.js'
import { createUsageLedger } from '../diagnostics/usage.js'
import { ensureSchema as ensureLearningSchema } from '../learning/schema.js'

const FORMAT = 'aurabot-offline-restore-v1'
// Intentionally pinned. A future core migration must not silently expand the
// set of schemas this recovery implementation claims to understand.
export const RESTORE_CORE_SCHEMA_VERSION = 7
const SIDECARS = ['', '-wal', '-shm', '-journal']
const quote = name => '"' + name.replaceAll('"', '""') + '"'
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const failure = (code, message) => { throw Object.assign(new Error(message), { code }) }
const KNOWN_TABLES = new Set(`meta sequences chats messages assets asset_occurrences chat_epochs requests legacy_migrations
outbox personas persona_revisions persona_bindings persona_tombstones jobs job_attempts generation_lineage quota_reservations
image_job_configs diagnostic_events memory_facts memory_evidence memory_fact_evidence memory_audit memory_tombstones
memory_scope_revisions memory_checkpoints memory_episodes memory_profiles memory_overrides memory_quarantine
wp6_model_budget wp6_model_calls wp6_mood_states wp6_mood_events wp6_mood_seen wp6_learning_records wp6_learning_evidence
wp6_learning_audit wp6_learning_versions wp6_learning_checkpoints wp6_learning_queue wp6_learning_seen wp6_learning_uses
wp6_learning_shared_usage sticker_items sticker_quota sticker_sources sticker_tasks sticker_qq sticker_uses sticker_legacy
retrieval_source_outbox retrieval_source_scans retrieval_source_clock retrieval_source_discovery
background_work_state service_calls service_call_requests service_call_outcomes restore_records restore_runs`.split(/\s+/))
const USAGE_BASE = 'id account_id chat_id request_id service model role status billing started_at duration_ms input_tokens output_tokens cached_tokens input_count input_chars credits amount currency'
const USAGE_EXTRA = 'provider finished_at attempts usage_complete business_status business_error operation_id stage source_ids_json error_code finish_reason'.split(' ')
const BACKGROUND_NAMES = new Set(['memory','learning:expression','learning:jargon','mood'])
const RESTORE_PAUSE = 'RESTORE_REQUIRES_REVIEW'
const MODULES = 'stickers voice mood memory learning retrieval media-memory search qq-tools group-admin imagegen speakup bili song tasks profile contacts'.split(' ')

/** Safe config is new, contains no copied credentials, and disables built-in and user modules. */
export function isolatedRestoreConfig() {
  const off = () => ({ enabled: false })
  return {
    schemaVersion: 2, enabled: false, dryRun: true, setupDone: false, safeMode: true,
    botQQ: '', ownerQQ: '', longTasks: false, allow: { private: [], groups: [] },
    modules: Object.fromEntries(MODULES.map(id => [id, off()])), ext: {},
    snowluma: { autoStart: false, autoAttach: false, httpUrl: '', wsUrl: '', httpToken: '', wsToken: '' },
    bridge: { dshTools: false, http: false, token: '' },
    local: { tts: false, asr: false, image: false, song: false },
    memory: { enabled: false, shareGroups: [] }, learning: { enabled: false, learnEnabled: false, useEnabled: false, allowPrivate: false },
    mood: { enabled: false, judge: false }, voice: { enabled: false, provider: 'none', asr: false },
    stickers: { enabled: false, collect: false, caption: false, autoChance: 0 },
    mediaMemory: { enabled: false, autoAnalyze: false }, retrieval: off(), imageGen: { enabled: false, profiles: [] },
    search: off(), song: off(), bili: { enabled: false, autoBrowse: false, comment: false, reply: false },
    speakUp: off(), participation: off(),
  }
}

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) failure('INVALID_RECORD', `${label}: expected object`)
  return value
}
function json(value, label) {
  try { return plain(JSON.parse(value), label) } catch (error) {
    if (error.code) throw error
    failure('INVALID_RECORD', `${label}: invalid JSON`)
  }
}
function integer(value, label, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) failure('INVALID_RECORD', `${label}: invalid integer`)
  return value
}
function fileHash(file) {
  const fd = openSync(file, 'r'), h = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024)
  try { let n; while ((n = readSync(fd, buffer, 0, buffer.length, null))) h.update(buffer.subarray(0, n)) } finally { closeSync(fd) }
  return h.digest('hex')
}
function syncFile(file) { const fd = openSync(file, 'r+'); try { fsyncSync(fd) } finally { closeSync(fd) } }
function writeNew(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); syncFile(file)
}
function inside(path, root) { const rel = relative(root, path); return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)) }
function sourceFile(input) {
  if (typeof input !== 'string' || !input || input === ':memory:') failure('INVALID_PATH', 'Explicit filesystem database paths are required')
  const path = realpathSync(resolve(input))
  if (!statSync(path).isFile()) failure('INVALID_PATH', 'Database source must be a regular file')
  return path
}
function inventory(file) {
  return SIDECARS.filter(suffix => existsSync(file + suffix)).map(suffix => {
    const path = file + suffix, st = lstatSync(path, { bigint: true })
    if (!st.isFile() || st.isSymbolicLink()) failure('UNSAFE_SOURCE', 'Database sidecars must be regular files')
    return { suffix, size: String(st.size), mtimeNs: String(st.mtimeNs), ino: String(st.ino), dev: String(st.dev), sha256: fileHash(path) }
  })
}
function unchanged(file, before) {
  if (JSON.stringify(inventory(file)) !== JSON.stringify(before)) failure('SOURCE_CHANGED', 'A source database or sidecar changed; keep DSH stopped and start a new operation')
}
function copyBundle(file, target) {
  const entries = inventory(file)
  mkdirSync(target)
  for (const entry of entries) {
    const dest = join(target, 'database.sqlite' + entry.suffix)
    copyFileSync(file + entry.suffix, dest, constants.COPYFILE_EXCL); syncFile(dest)
    if (fileHash(dest) !== entry.sha256) failure('COPY_MISMATCH', 'Database copy verification failed')
  }
  unchanged(file, entries)
  writeNew(join(target, 'manifest.json'), { format: FORMAT, source: file, entries })
  return entries
}
function copyWork(bundle, dir) {
  mkdirSync(dir)
  for (const suffix of SIDECARS) if (existsSync(join(bundle, 'database.sqlite' + suffix)))
    copyFileSync(join(bundle, 'database.sqlite' + suffix), join(dir, 'database.sqlite' + suffix), constants.COPYFILE_EXCL)
  return join(dir, 'database.sqlite')
}
const tables = db => new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name))
const has = (db, table) => !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table)
const rows = (db, table) => has(db, table) ? db.prepare(`SELECT * FROM ${quote(table)}`).all() : []
function columns(db, table, names) {
  const actual = new Set(db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(r => r.name))
  for (const name of names.split(' ')) if (!actual.has(name)) failure('UNSUPPORTED_SCHEMA', `${table}.${name} is missing`)
}
function integrity(db) {
  const checks = db.prepare('PRAGMA integrity_check').all()
  if (checks.length !== 1 || Object.values(checks[0])[0] !== 'ok') failure('CORRUPT_DATABASE', 'SQLite integrity check failed')
  if (db.prepare('PRAGMA foreign_key_check').all().length) failure('BROKEN_REFERENCES', 'SQLite foreign key check failed')
}
function openCopy(file) {
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: true, allowExtension: false })
  try { db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000'); integrity(db); return db } catch (error) { db.close(); throw error }
}
function snapshot(bundle, work, destination) {
  const db = openCopy(copyWork(bundle, work))
  try { db.prepare('VACUUM INTO ?').run(destination) } finally { db.close() }
  syncFile(destination)
}
function checkSchema(db, label) {
  const version = db.prepare('PRAGMA user_version').get().user_version
  if (version !== RESTORE_CORE_SCHEMA_VERSION) failure('UNSUPPORTED_SCHEMA', `${label}: expected core schema ${RESTORE_CORE_SCHEMA_VERSION}, got ${version}; no implicit migration`)
  for (const table of tables(db)) if (!KNOWN_TABLES.has(table)) failure('UNSUPPORTED_SCHEMA', `${label}: unhandled table ${table}`)
  for (const [table, names] of Object.entries({
    messages: 'id account_id chat_id platform_msg_id recalled_at recv_seq',
    assets: 'id sha256 state', persona_tombstones: 'id deleted_at',
    memory_facts: 'id account chat persona category body revision status fingerprint created_at updated_at',
    memory_evidence: 'id account chat persona message_id body revision deleted_at',
    memory_tombstones: 'kind key account chat persona deleted_at body', memory_audit: 'seq fact_id account chat persona at body',
  })) columns(db, table, names)
  for (const [table,names] of Object.entries({background_work_state:'namespace scope_key body',
    service_calls:USAGE_BASE,service_call_requests:'call_id request_id',service_call_outcomes:'call_id account_id chat_id status error',
    memory_checkpoints:'scope_key scope recv_seq watermark last_success_at state lease_token lease_until error attempts',
    wp6_learning_checkpoints:'scope_key account_id chat_id persona_id kind scan_seq processed_seq overflow_from overflow_to next_attempt_at last_attempt_at attempts outcome last_error lease_owner lease_until'})) {
    if(has(db,table)) columns(db,table,names)
  }
  if(has(db,'service_calls')) for(const column of db.prepare('PRAGMA table_info(service_calls)').all())
    if(![...USAGE_BASE.split(' '),...USAGE_EXTRA].includes(column.name)) failure('UNSUPPORTED_SCHEMA',`${label}: unhandled usage column ${column.name}`)
  // An arbitrary backup trigger must never run while barriers are being applied.
  // Drop copied triggers below; rebuild memory triggers from trusted local code.
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='view' LIMIT 1").get()) failure('UNSUPPORTED_SCHEMA', `${label}: views require explicit review`)
  for(const trigger of db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger'").all())
    if(!['memory_message_update','memory_message_delete'].includes(trigger.name) && !/^retrieval_v1_[a-z_]+$/.test(trigger.name))
      failure('UNSUPPORTED_SCHEMA',`${label}: unhandled trigger ${trigger.name}`)
}
function rowScope(row) {
  const scope = { account: row.account, chat: row.chat, persona: row.persona }
  scopeKey(scope) // validates; never infer missing account/chat from another row
  return scope
}
function checkedBody(row, kind) {
  const body = json(row.body, `${kind}:${row.id}`), scope = rowScope(row)
  if (body.id !== row.id || scopeKey(body.scope) !== scopeKey(scope) || body.revision !== row.revision)
    failure('INVALID_RECORD', `${kind}: body/index identity mismatch`)
  integer(row.revision, 'revision', 1)
  if (kind === 'fact' && (body.status !== row.status || body.category !== row.category || factFingerprint(body) !== row.fingerprint))
    failure('INVALID_RECORD', 'Fact status/category/fingerprint does not match its indexed body')
  if (kind === 'evidence' && (body.messageId !== row.message_id || (body.deletedAt ?? null) !== row.deleted_at))
    failure('INVALID_RECORD', 'Evidence deletion/message does not match its indexed body')
  return body
}

function isolateBackground(current, candidate, { archive, insertRow, bump, adapter }) {
  const states=new Map(), memory=new Map(), learning=new Map(), budgets=new Map()
  let recvFloor=0
  const arrayKey=scope=>JSON.stringify([scope.account,scope.chat,scope.persona])
  const arrayScope=value=>{
    let key
    try { key=JSON.parse(value) } catch { failure('INVALID_RECORD','Background scope key is not JSON') }
    if(!Array.isArray(key) || key.length!==3) failure('INVALID_RECORD','Background scope must contain account, chat and persona')
    const scope={account:key[0],chat:key[1],persona:key[2]};rowScope(scope)
    return scope
  }
  const nullableMax=(a,b)=>a==null?b:b==null?a:Math.max(a,b)
  const positiveMin=(a,b)=>a==null?b:b==null?a:Math.min(a,b)
  const cursor=(value,label)=>{integer(value,label);recvFloor=Math.max(recvFloor,value);return value}
  const pause=(namespace,scope,body={})=>{
    if(!BACKGROUND_NAMES.has(namespace)) failure('UNSUPPORTED_SCHEMA',`Unhandled background namespace ${namespace}`)
    rowScope(scope)
    if(namespace!=='memory' && !scope.persona) failure('INVALID_RECORD','Learning/mood background state needs an explicit persona')
    const key=arrayKey(scope), id=JSON.stringify([namespace,key]), old=states.get(id)?.body
    const failures=integer(body.failures??0,'background failures')
    for(const field of ['batchLimit','charLimit']) if(body[field]!=null) integer(body[field],field,1)
    if(body.lastError!=null && typeof body.lastError!=='string') failure('INVALID_RECORD','Background error must be a code')
    states.set(id,{namespace,scope_key:key,body:{failures:Math.max(old?.failures||0,failures),
      batchLimit:positiveMin(old?.batchLimit??null,body.batchLimit??null),charLimit:positiveMin(old?.charLimit??null,body.charLimit??null),
      lastError:body.lastError?.slice(0,100) || old?.lastError || '',paused:true,pauseReason:RESTORE_PAUSE,
      nextAttemptAt:0,lastCallId:null,phase:'paused'}})
  }
  for(const db of [candidate,current]) {
    const source=db===current?'current':'backup'
    for(const row of rows(db,'background_work_state')) {
      archive(source,'background_work_state',row)
      pause(row.namespace,arrayScope(row.scope_key),json(row.body,'background work state'))
    }
    for(const row of rows(db,'memory_checkpoints')) {
      archive(source,'memory_checkpoints',row)
      const scope=json(row.scope,'memory checkpoint scope'),key=scopeKey(scope)
      if(scopeKey(json(row.scope_key,'memory checkpoint key'))!==key) failure('IDENTITY_CONFLICT','Memory checkpoint scope/key mismatch')
      cursor(row.recv_seq,'memory recv_seq');cursor(row.watermark,'memory watermark');integer(row.attempts,'memory attempts')
      if(row.last_success_at!=null) integer(row.last_success_at,'memory last_success_at')
      const old=memory.get(key)
      memory.set(key,{...row,scope_key:key,scope:JSON.stringify(rowScope(scope)),recv_seq:Math.max(old?.recv_seq||0,row.recv_seq),
        watermark:Math.max(old?.watermark||0,row.watermark,row.recv_seq),last_success_at:nullableMax(old?.last_success_at??null,row.last_success_at),
        attempts:Math.max(old?.attempts||0,row.attempts),state:'pending',lease_token:null,lease_until:null,error:RESTORE_PAUSE})
      pause('memory',scope)
    }
    for(const row of rows(db,'wp6_learning_checkpoints')) {
      archive(source,'wp6_learning_checkpoints',row)
      const scope=arrayScope(row.scope_key),key=arrayKey(scope)
      if(scope.account!==row.account_id || scope.chat!==row.chat_id || scope.persona!==row.persona_id)
        failure('IDENTITY_CONFLICT','Learning checkpoint scope/key mismatch')
      if(!['expression','jargon'].includes(row.kind)) failure('UNSUPPORTED_SCHEMA','Unknown learning checkpoint kind')
      for(const field of ['scan_seq','processed_seq']) cursor(row[field],field)
      for(const field of ['attempts','last_attempt_at']) integer(row[field],field)
      if((row.overflow_from==null)!==(row.overflow_to==null)) failure('INVALID_RECORD','Incomplete learning overflow range')
      if(row.overflow_from!=null) {cursor(row.overflow_from,'overflow_from');cursor(row.overflow_to,'overflow_to')}
      const id=JSON.stringify([key,row.kind]),old=learning.get(id)
      learning.set(id,{...row,scope_key:key,scan_seq:Math.max(old?.scan_seq||0,row.scan_seq),processed_seq:Math.max(old?.processed_seq||0,row.processed_seq),
        overflow_from:positiveMin(old?.overflow_from??null,row.overflow_from),overflow_to:nullableMax(old?.overflow_to??null,row.overflow_to),
        attempts:Math.max(old?.attempts||0,row.attempts),last_attempt_at:Math.max(old?.last_attempt_at||0,row.last_attempt_at),
        next_attempt_at:0,outcome:'paused',last_error:RESTORE_PAUSE,lease_owner:null,lease_until:0})
      pause(`learning:${row.kind}`,scope,{failures:row.attempts})
      // A scheduler visits both kinds for each persisted scope.
      for(const kind of ['expression','jargon']) pause(`learning:${kind}`,scope)
    }
    for(const row of rows(db,'wp6_learning_queue')) {
      archive(source,'wp6_learning_queue',row)
      pause(`learning:${row.kind}`,arrayScope(row.scope_key));cursor(row.recv_seq,'queued recv_seq')
    }
    for(const row of rows(db,'wp6_mood_states')) {
      archive(source,'wp6_mood_states',row)
      const scope=arrayScope(row.scope_key)
      if(scope.account!==row.account_id || scope.chat!==row.chat_id || scope.persona!==row.persona_id)
        failure('IDENTITY_CONFLICT','Mood state scope/key mismatch')
      pause('mood',scope)
    }
    for(const row of rows(db,'wp6_model_calls')) {
      archive(source,'wp6_model_calls',row)
      pause(row.kind==='mood'?'mood':`learning:${row.kind}`,arrayScope(row.scope_key))
      bump('clearedModelReservations')
    }
    for(const row of rows(db,'wp6_model_budget')) {
      archive(source,'wp6_model_budget',row);integer(row.calls,'model budget calls')
      if(!/^\d{4}-\d{2}-\d{2}$/.test(row.day)) failure('INVALID_RECORD','Invalid model budget day')
      budgets.set(row.day,Math.max(budgets.get(row.day)||0,row.calls))
    }
    for(const row of rows(db,'sequences').filter(r=>r.name==='recv')) {archive(source,'sequences',row);cursor(row.value,'recv sequence')}
    cursor(db.prepare('SELECT COALESCE(MAX(recv_seq),0) n FROM messages').get().n,'source receive sequence')
  }
  candidate.exec('DELETE FROM memory_checkpoints')
  for(const row of memory.values()) {insertRow('memory_checkpoints',row);bump('preservedMemoryCheckpoints')}
  if([current,candidate].some(db=>has(db,'wp6_learning_checkpoints') || has(db,'wp6_model_calls') || has(db,'wp6_model_budget'))) {
    ensureLearningSchema(adapter)
    candidate.exec('DELETE FROM wp6_learning_checkpoints; DELETE FROM wp6_model_calls')
    for(const row of learning.values()) {insertRow('wp6_learning_checkpoints',row);bump('preservedLearningCheckpoints')}
    for(const [day,calls] of budgets) candidate.prepare('INSERT INTO wp6_model_budget VALUES(?,?) ON CONFLICT(day) DO UPDATE SET calls=MAX(calls,excluded.calls)').run(day,calls)
  }
  candidate.exec(`CREATE TABLE IF NOT EXISTS background_work_state(namespace TEXT NOT NULL,scope_key TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(namespace,scope_key));
    DELETE FROM background_work_state;`)
  for(const row of states.values()) {insertRow('background_work_state',{...row,body:JSON.stringify(row.body)});bump('isolatedBackgroundScopes')}
  // Restored high-water marks must not swallow newly received messages after review.
  candidate.prepare("INSERT INTO sequences(name,value) VALUES('recv',?) ON CONFLICT(name) DO UPDATE SET value=MAX(value,excluded.value)").run(recvFloor)
}

function reconcile(current, candidate, runId, at) {
  const counts = {}, bump = name => { counts[name] = (counts[name] || 0) + 1 }
  const triggers = candidate.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all()
  candidate.exec('BEGIN IMMEDIATE')
  try {
    for (const trigger of triggers) candidate.exec(`DROP TRIGGER ${quote(trigger.name)}`)
    candidate.exec(`CREATE TABLE IF NOT EXISTS restore_records(
      digest TEXT PRIMARY KEY,run_id TEXT NOT NULL,source TEXT NOT NULL,source_table TEXT NOT NULL,record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS restore_runs(id TEXT PRIMARY KEY,at INTEGER NOT NULL,report_json TEXT NOT NULL);`)
    const saveRecord = candidate.prepare('INSERT OR IGNORE INTO restore_records VALUES(?,?,?,?,?)')
    const archive = (source, table, row) => saveRecord.run(digest([source, table, row]), runId, source, table, JSON.stringify(row))
    const archivedTables = new Set()
    const archiveTable = table => {
      if (archivedTables.has(table)) return
      for (const row of rows(candidate, table)) archive('backup', table, row)
      archivedTables.add(table)
    }
    const insertRow=(table,row)=>{
      const keys=Object.keys(row)
      candidate.prepare(`INSERT INTO ${quote(table)} (${keys.map(quote).join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...keys.map(key=>row[key]))
    }
    // The usage ledger is immutable accounting evidence, not executable work.
    // Merge observed rows, never calculate or infer missing fees. A conflicting
    // receipt id needs human reconciliation and refuses this preparation.
    const candidateAdapter={run:(sql,...params)=>candidate.prepare(sql).run(...params),
      all:(sql,...params)=>candidate.prepare(sql).all(...params),exec:sql=>candidate.exec(sql)}
    if([current,candidate].some(db=>['service_calls','service_call_requests','service_call_outcomes'].some(table=>has(db,table)))) {
      createUsageLedger({storage:{db:candidateAdapter},getAccount:()=>''})
      archiveTable('service_calls');archiveTable('service_call_requests');archiveTable('service_call_outcomes')
      for(const row of rows(current,'service_calls')) {
        archive('current','service_calls',row)
        const old=candidate.prepare('SELECT * FROM service_calls WHERE id=?').get(row.id)
        if(old && Object.keys(row).some(key=>USAGE_EXTRA.includes(key) ? row[key]!=null && old[key]!=null && row[key]!==old[key] : row[key]!==old[key]))
          failure('USAGE_CONFLICT','Usage receipt id has conflicting evidence; no cost reconciliation was inferred')
        if(!old) insertRow('service_calls',row)
        else for(const key of USAGE_EXTRA) if(old[key]==null && row[key]!=null)
          candidate.prepare(`UPDATE service_calls SET ${quote(key)}=? WHERE id=?`).run(row[key],row.id)
        bump('preservedUsageCalls')
      }
      for(const row of rows(current,'service_call_outcomes')) {
        archive('current','service_call_outcomes',row)
        const old=candidate.prepare('SELECT * FROM service_call_outcomes WHERE call_id=?').get(row.call_id)
        if(old && Object.keys(row).some(key=>row[key]!==old[key])) failure('USAGE_CONFLICT','Business outcome id has conflicting evidence')
        if(!old) insertRow('service_call_outcomes',row)
        bump('preservedUsageOutcomes')
      }
      for(const row of rows(candidate,'service_call_outcomes')) {
        if(!row.account_id || !['success','failed','discarded'].includes(row.status)) failure('INVALID_RECORD','Invalid usage business outcome')
        const call=candidate.prepare('SELECT * FROM service_calls WHERE id=?').get(row.call_id)
        // A pre-usage cancellation receipt can be orphaned; never invent a billed call for it.
        if(!call) continue
        if(call.account_id!==row.account_id || call.chat_id!==row.chat_id ||
          (call.business_status!=null && call.business_status!==row.status) || (call.business_error!=null && call.business_error!==row.error))
          failure('USAGE_CONFLICT','Business outcome does not match the call scope or settlement')
        candidate.prepare('UPDATE service_calls SET business_status=?,business_error=? WHERE id=?').run(row.status,row.error,row.call_id)
      }
      for(const row of rows(candidate,'service_call_requests'))
        if(!candidate.prepare('SELECT 1 FROM service_calls WHERE id=?').get(row.call_id)) failure('BROKEN_REFERENCES','Usage request link has no call')
      for(const row of rows(current,'service_call_requests')) {
        archive('current','service_call_requests',row)
        if(!candidate.prepare('SELECT 1 FROM service_calls WHERE id=?').get(row.call_id)) failure('BROKEN_REFERENCES','Usage request link has no call')
        candidate.prepare('INSERT OR IGNORE INTO service_call_requests VALUES(?,?)').run(row.call_id,row.request_id)
      }
    }
    const barrier = (kind, key, scope, deletedAt, reason) => {
      rowScope(scope); integer(deletedAt, 'deletedAt')
      if (typeof key !== 'string' || !key) failure('INVALID_RECORD', 'Empty barrier key')
      const old = candidate.prepare('SELECT * FROM memory_tombstones WHERE kind=? AND key=? AND account=? AND chat=? AND persona=?').get(kind, key, scope.account, scope.chat, scope.persona)
      const date = Math.max(deletedAt, old?.deleted_at || 0)
      const body = { kind, key, token: `restore_${digest([runId, kind, key, scope])}`, deletedAt: date,
        actorId: 'offline-restore', reason, restoreRunId: runId }
      candidate.prepare(`INSERT INTO memory_tombstones VALUES(?,?,?,?,?,?,?) ON CONFLICT(kind,key,account,chat,persona)
        DO UPDATE SET deleted_at=excluded.deleted_at,body=excluded.body`).run(kind, key, scope.account, scope.chat, scope.persona, date, JSON.stringify(body))
    }
    archiveTable('memory_tombstones')
    for (const source of [candidate, current]) for (const row of rows(source, 'memory_tombstones')) {
      const b = json(row.body, 'tombstone')
      if (!['fact','fingerprint','evidence','message'].includes(row.kind) || b.kind !== row.kind || b.key !== row.key || b.deletedAt !== row.deleted_at || !b.token)
        failure('INVALID_BARRIER', 'Unrecognized or inconsistent deletion barrier')
      archive(source === current ? 'current' : 'backup', 'memory_tombstones', row)
      barrier(row.kind, row.key, rowScope(row), row.deleted_at, 'Preserved deletion barrier; previous approvals are not restored')
      bump('preservedMemoryBarriers')
    }
    // Include audit retractions/corrections even when a later explicit restore left
    // the current row active. Whole-library restoration never replays that approval.
    const blocked = new Map()
    for (const source of [candidate, current]) {
      for (const row of rows(source, 'memory_audit')) {
        rowScope(row); integer(row.at, 'audit.at')
        const b = json(row.body, 'memory_audit')
        archive(source === current ? 'current' : 'backup', 'memory_audit', row)
        if (['delete','retract','correct','delete_evidence'].includes(b.action)) {
          barrier('fact', row.fact_id, rowScope(row), row.at, `Preserved audit action: ${b.action}`)
          if(b.before) {
            if(b.before.id!==row.fact_id || scopeKey(b.before.scope)!==scopeKey(rowScope(row))) failure('INVALID_RECORD','Withdrawal audit snapshot changed identity')
            barrier('fingerprint',factFingerprint(b.before),rowScope(row),row.at,`Preserved audit content: ${b.action}`)
          }
          blocked.set(JSON.stringify([row.account,row.chat,row.persona,row.fact_id]), b.action === 'delete' ? 'deleted' : 'retracted')
          bump('withdrawalAudits')
        }
        if (source === current && !candidate.prepare('SELECT 1 FROM memory_audit WHERE fact_id=? AND account=? AND chat=? AND persona=? AND at=? AND body=?').get(row.fact_id,row.account,row.chat,row.persona,row.at,row.body))
          candidate.prepare('INSERT INTO memory_audit(fact_id,account,chat,persona,at,body) VALUES(?,?,?,?,?,?)').run(row.fact_id,row.account,row.chat,row.persona,row.at,row.body)
      }
      for (const row of rows(source, 'memory_facts')) {
        checkedBody(row, 'fact')
        if (['deleted','retracted','superseded'].includes(row.status)) {
          archive(source === current ? 'current' : 'backup', 'memory_facts', row)
          barrier('fact', row.id, rowScope(row), row.updated_at, `Preserved ${row.status} fact`)
          barrier('fingerprint', row.fingerprint, rowScope(row), row.updated_at, `Preserved ${row.status} fact content`)
          blocked.set(JSON.stringify([row.account,row.chat,row.persona,row.id]), row.status)
        }
      }
      for (const row of rows(source, 'memory_evidence')) {
        checkedBody(row, 'evidence')
        if (row.deleted_at !== null) {
          archive(source === current ? 'current' : 'backup', 'memory_evidence', row)
          barrier('evidence', row.id, rowScope(row), row.deleted_at, 'Preserved deleted evidence')
          if (row.message_id) barrier('message', row.message_id, rowScope(row), row.deleted_at, 'Preserved deleted message evidence')
        }
      }
    }
    // Known recalls are copied by internal id OR same-account/chat/platform id.
    for (const row of rows(current, 'messages').filter(r => r.recalled_at !== null)) {
      integer(row.recalled_at, 'recalled_at'); archive('current', 'messages', row)
      const scope = { account: row.account_id, chat: row.chat_id, persona: '' }
      const targets = candidate.prepare('SELECT * FROM messages WHERE id=? OR (account_id=? AND chat_id=? AND platform_msg_id IS NOT NULL AND platform_msg_id=?)').all(row.id,row.account_id,row.chat_id,row.platform_msg_id)
      for (const target of targets) {
        if (target.account_id !== row.account_id || target.chat_id !== row.chat_id) failure('IDENTITY_CONFLICT', 'A recalled message id changed account/chat')
        archive('backup', 'messages', target)
        candidate.prepare('UPDATE messages SET recalled_at=? WHERE id=?').run(Math.max(row.recalled_at, target.recalled_at || 0),target.id)
        barrier('message', target.id, scope, row.recalled_at, 'Preserved platform recall')
      }
      barrier('message', row.id, scope, row.recalled_at, 'Preserved platform recall'); bump('messageRecalls')
    }
    // Historic messages remain in the database, but cannot be mined into fresh
    // facts automatically after review. This is isolation, NOT a claim of recall.
    for (const row of rows(candidate, 'messages')) {
      barrier('message', row.id, { account: row.account_id, chat: row.chat_id, persona: '' }, at, 'Restore isolation: historical source requires review; deletion history is incomplete')
      bump('isolatedMessageSources')
    }
    archiveTable('memory_facts'); archiveTable('memory_evidence')
    for (const row of rows(candidate, 'memory_evidence')) {
      const body = checkedBody(row, 'evidence'), currentRow = current.prepare('SELECT * FROM memory_evidence WHERE id=?').get(row.id)
      if (currentRow && scopeKey(rowScope(currentRow)) !== scopeKey(rowScope(row))) failure('IDENTITY_CONFLICT', 'Evidence id changed scope')
      delete body.restoreApproval
      body.deletedAt = Math.max(row.deleted_at || 0, at); body.revision = Math.max(row.revision, currentRow?.revision || 0) + 1
      barrier('evidence', row.id, rowScope(row), body.deletedAt, 'Restore isolation: evidence must be approved again')
      candidate.prepare('UPDATE memory_evidence SET body=?,revision=?,deleted_at=? WHERE id=?').run(JSON.stringify(body),body.revision,body.deletedAt,row.id)
      bump('isolatedEvidence')
    }
    for (const row of rows(candidate, 'memory_facts')) {
      const body = checkedBody(row, 'fact'), currentRow = current.prepare('SELECT * FROM memory_facts WHERE id=?').get(row.id)
      if (currentRow && scopeKey(rowScope(currentRow)) !== scopeKey(rowScope(row))) failure('IDENTITY_CONFLICT', 'Fact id changed scope')
      delete body.restoreApproval
      body.status = blocked.get(JSON.stringify([row.account,row.chat,row.persona,row.id])) || (row.status === 'deleted' ? 'deleted' : 'quarantined')
      body.revision = Math.max(row.revision, currentRow?.revision || 0) + 1; body.updatedAt = at
      candidate.prepare('UPDATE memory_facts SET body=?,status=?,revision=?,updated_at=? WHERE id=?').run(JSON.stringify(body),body.status,body.revision,at,row.id)
      const audit = { action: 'offline_restore_isolation', actorId: 'offline-restore', reason: runId, before: null, after: { status: body.status }, at }
      candidate.prepare('INSERT INTO memory_audit(fact_id,account,chat,persona,at,body) VALUES(?,?,?,?,?,?)').run(row.id,row.account,row.chat,row.persona,at,JSON.stringify(audit))
      bump('isolatedFacts')
    }
    for (const table of ['memory_profiles','memory_overrides','memory_episodes']) {
      archiveTable(table); candidate.exec(`DELETE FROM ${quote(table)}`)
    }
    isolateBackground(current,candidate,{archive,insertRow,bump,adapter:candidateAdapter})
    for (const row of rows(candidate, 'memory_quarantine')) {
      archive('backup', 'memory_quarantine', row)
      candidate.prepare("UPDATE memory_quarantine SET state='quarantined',approved_fact_id=NULL WHERE id=?").run(row.id)
    }
    const revisions = new Map()
    for (const db of [candidate,current]) for (const row of rows(db,'memory_scope_revisions')) {
      scopeKey(json(row.scope_key,'scope revision')); integer(row.revision,'scope revision')
      revisions.set(row.scope_key,Math.max(revisions.get(row.scope_key) || 0,row.revision))
    }
    for (const row of rows(candidate,'memory_facts')) { const key=scopeKey(rowScope(row)); if (!revisions.has(key)) revisions.set(key,0) }
    for (const [key,revision] of revisions) candidate.prepare('INSERT INTO memory_scope_revisions VALUES(?,?) ON CONFLICT(scope_key) DO UPDATE SET revision=excluded.revision').run(key,revision+1)

    // Persona and asset barriers must survive even if the deleted item did not
    // exist at backup time. No media bytes or provider credentials are imported.
    archiveTable('persona_tombstones')
    for (const row of rows(current,'persona_tombstones')) {
      integer(row.deleted_at,'persona deletion'); archive('current','persona_tombstones',row)
      candidate.prepare('INSERT INTO persona_tombstones VALUES(?,?) ON CONFLICT(id) DO UPDATE SET deleted_at=MAX(deleted_at,excluded.deleted_at)').run(row.id,row.deleted_at)
      bump('personaDeletions')
    }
    for (const table of ['persona_bindings','personas','persona_revisions']) archiveTable(table)
    candidate.exec('DELETE FROM persona_bindings; DELETE FROM persona_revisions WHERE persona_id IN (SELECT id FROM persona_tombstones); DELETE FROM personas WHERE id IN (SELECT id FROM persona_tombstones)')
    candidate.prepare('UPDATE personas SET archived_at=COALESCE(archived_at,?),edit_revision=edit_revision+1').run(at)
    archiveTable('assets'); archiveTable('asset_occurrences')
    const deletedAssets = new Set()
    const ensureAsset=(id)=>{
      const source=current.prepare('SELECT * FROM assets WHERE id=?').get(id)
      if(!source) failure('BROKEN_REFERENCES','Current deleted sticker has no source asset')
      const byId=candidate.prepare('SELECT * FROM assets WHERE id=?').get(id)
      if(byId && byId.sha256!==source.sha256) failure('IDENTITY_CONFLICT','Asset id has different content in the backup')
      const existing=byId || candidate.prepare('SELECT * FROM assets WHERE sha256=?').get(source.sha256)
      if(existing) return existing.id
      archive('current','assets',source)
      insertRow('assets',{...source,state:source.state==='deleted'?'deleted':'unavailable'})
      return source.id
    }
    for(const row of rows(current,'assets').filter(r=>r.state==='deleted')) {
      archive('current','assets',row);deletedAssets.add(row.sha256);ensureAsset(row.id);bump('assetDeletions')
    }
    for (const row of rows(candidate,'assets')) candidate.prepare('UPDATE assets SET state=? WHERE id=?').run(row.state==='deleted'||deletedAssets.has(row.sha256)?'deleted':'unavailable',row.id)
    candidate.exec("UPDATE asset_occurrences SET state='unavailable',analysis_json='{}',error='Offline restore isolation'")

    // Other domain tombstones are row states. Keep their current records in the
    // ledger; every candidate item is disabled, and no domain can auto-activate.
    const learningDeletes=new Set(rows(current,'wp6_learning_audit').filter(r=>r.action==='deleted').map(r=>JSON.stringify([r.record_id,r.scope_key])))
    for (const [table,stateColumn,bodyColumn] of [['wp6_learning_records','status',null],['sticker_items','state','body_json'],['sticker_legacy','state','body_json']]) {
      if (!has(candidate,table)) {
        if (rows(current,table).length) failure('UNSUPPORTED_SCHEMA', `Candidate lacks ${table}; current barriers cannot be applied`)
        continue
      }
      archiveTable(table)
      const currentRows=rows(current,table)
      const wasDeleted=row=>row[stateColumn]==='deleted' || (table==='wp6_learning_records' && learningDeletes.has(JSON.stringify([row.id,row.scope_key])))
      for(const row of currentRows) archive('current',table,row)
      // A deletion after the snapshot can refer to an item first created after
      // the snapshot too. Preserve its native uniqueness/tombstone guard, not
      // just a ledger record that the normal domain repository cannot read.
      for(const row of currentRows.filter(wasDeleted)) {
        const byId=candidate.prepare(`SELECT * FROM ${quote(table)} WHERE id=?`).get(row.id)
        if(byId && (table==='sticker_items' ? byId.account!==row.account || byId.chat!==row.chat || byId.sha256!==row.sha256 :
          table==='wp6_learning_records' ? byId.scope_key!==row.scope_key || byId.kind!==row.kind || byId.item_key!==row.item_key : byId.source_key!==row.source_key))
          failure('IDENTITY_CONFLICT',`${table}: deleted id changed identity`)
        const equivalent=byId || (table==='sticker_items' ? candidate.prepare('SELECT id FROM sticker_items WHERE account=? AND chat=? AND sha256=?').get(row.account,row.chat,row.sha256) :
          table==='wp6_learning_records' ? candidate.prepare('SELECT id FROM wp6_learning_records WHERE scope_key=? AND kind=? AND item_key=?').get(row.scope_key,row.kind,row.item_key) :
            candidate.prepare('SELECT id FROM sticker_legacy WHERE source_key=?').get(row.source_key))
        if(!equivalent) insertRow(table,{...row,[stateColumn]:'deleted',...(table==='sticker_items'?{asset_id:ensureAsset(row.asset_id)}:{})})
        bump('preservedOtherDeletions')
      }
      for (const row of rows(candidate,table)) {
        const matches=currentRows.filter(r => r.id===row.id || (table==='sticker_items' && r.account===row.account && r.chat===row.chat && r.sha256===row.sha256) ||
          (table==='wp6_learning_records' && r.scope_key===row.scope_key && r.kind===row.kind && r.item_key===row.item_key) ||
          (table==='sticker_legacy' && r.source_key===row.source_key))
        const state=wasDeleted(row)||matches.some(wasDeleted)?'deleted':'disabled'
        if(bodyColumn) {
          const b=json(row[bodyColumn],table); b.state=state; b.revision=(row.revision||b.revision||0)+1
          if(state==='deleted') b.deletedAt=Math.max(b.deletedAt||0,at)
          b.review={kind:'manual',state,reason:'Offline restore isolation: review original evidence',at}
          candidate.prepare(`UPDATE ${quote(table)} SET ${quote(stateColumn)}=?,${quote(bodyColumn)}=?,updated_at=? WHERE id=?`).run(state,JSON.stringify(b),at,row.id)
          if(table==='sticker_items') candidate.prepare('UPDATE sticker_items SET revision=revision+1 WHERE id=?').run(row.id)
        } else candidate.prepare("UPDATE wp6_learning_records SET status=?,manual_lock=1,revision=revision+1,invalid_reason='Offline restore isolation: review evidence',updated_at=? WHERE id=?").run(state,at,row.id)
        bump('isolatedOtherItems')
      }
    }
    for(const row of rows(current,'wp6_learning_audit')) {
      archive('current','wp6_learning_audit',row)
      if(['deleted','disabled','remove_evidence'].includes(row.action) && has(candidate,'wp6_learning_records'))
        candidate.prepare("UPDATE wp6_learning_records SET status=CASE WHEN ?='deleted' THEN 'deleted' ELSE CASE WHEN status='deleted' THEN status ELSE 'disabled' END END WHERE id=? AND scope_key=?").run(row.action,row.record_id,row.scope_key)
    }

    // Never replay an older snapshot's queued external work. Unknown means it
    // may already have charged/sent since the backup, not a retryable failure.
    for(const table of ['outbox','jobs','job_attempts','requests','chat_epochs','sticker_tasks','meta']) archiveTable(table)
    candidate.prepare("UPDATE outbox SET state='unknown',last_error='Offline restore: delivery history requires reconciliation',updated_at=? WHERE state NOT IN ('delivered','canceled','unknown')").run(at)
    candidate.prepare("UPDATE jobs SET state='unknown',lease_owner=NULL,lease_until=NULL,error_kind='restore_requires_review',error='Do not retry: external outcome after backup is unknown',updated_at=? WHERE state NOT IN ('done','canceled')").run(at)
    candidate.prepare("UPDATE job_attempts SET state='unknown',billing='unknown',finished_at=? WHERE state='running'").run(at)
    candidate.prepare("UPDATE requests SET state='canceled',updated_at=?").run(at)
    for(const row of rows(current,'chat_epochs')) candidate.prepare('INSERT INTO chat_epochs VALUES(?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET epoch=MAX(epoch,excluded.epoch)').run(row.chat_id,row.epoch,'offline restore',at)
    candidate.prepare("UPDATE chat_epochs SET epoch=epoch+1,reason='offline restore',updated_at=?").run(at)
    if(has(candidate,'sticker_tasks')) candidate.prepare("UPDATE sticker_tasks SET state='unknown',error='Offline restore: reconcile before retry',updated_at=? WHERE state IN ('queued','running')").run(at)
    const candidateMeta=rows(candidate,'meta')
    for(const row of candidateMeta) {
      if(row.key.startsWith('planner:wait:')||row.key.startsWith('planner:inbox:')) {
        const b=json(row.value,'planner metadata'); b.state='unknown'; b.error='Offline restore: no automatic replay'; b.updatedAt=at
        candidate.prepare('UPDATE meta SET value=? WHERE key=?').run(JSON.stringify(b),row.key)
      } else if(row.key.startsWith('media-analysis:')) {
        // Preserve the raw metadata in the ledger; clearing caches prevents an
        // old ready result from being promoted before source review.
        candidate.prepare('DELETE FROM meta WHERE key=?').run(row.key)
      }
    }
    for(const row of rows(current,'meta').filter(r=>r.key.startsWith('media-analysis:'))) archive('current','meta',row)
    for(const source of [candidateMeta,rows(current,'meta')]) for(const row of source.filter(r=>r.key.startsWith('media-analysis:') && r.key.includes(':occ:'))) {
      const b=json(row.value,'media metadata')
      if(b.status==='disabled') {
        b.result=null;b.chatNote='';b.disabledHuman=null;b.autoSuppressed=true;b.generation=(b.generation||0)+1
        candidate.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(row.key,JSON.stringify(b))
      }
    }
    for(const table of ['wp6_learning_queue','wp6_mood_states','wp6_mood_events','wp6_mood_seen','retrieval_source_outbox','retrieval_source_scans','retrieval_source_discovery']) {
      if(has(candidate,table)) { archiveTable(table); candidate.exec(`DELETE FROM ${quote(table)}`) }
    }
    // Never execute trigger SQL from a backup. Memory triggers are rebuilt from
    // this release's initializer; retrieval creates its own triggers when enabled.
    ensureMemorySchema({db:{exec:sql=>candidate.exec(sql),tx:fn=>fn()}})
    const summary={counts,knownBarriersMerged:true,deletionHistoryComplete:false,switchAllowed:false,backgroundRequiresReview:true,
      rebuildRequired:['Retrieval indexes, worker database and source triggers require reviewed source rebuild; no external vector state was restored.']}
    candidate.prepare('INSERT INTO restore_runs VALUES(?,?,?)').run(runId,at,JSON.stringify(summary))
    integrity(candidate)
    if(candidate.prepare("SELECT 1 FROM memory_facts WHERE status IN ('active','conflicted') LIMIT 1").get() || candidate.prepare('SELECT 1 FROM memory_evidence WHERE deleted_at IS NULL LIMIT 1').get())
      failure('ISOLATION_FAILED','Candidate contains unreviewed visible memory')
    candidate.exec('COMMIT')
    return summary
  } catch(error) { try { candidate.exec('ROLLBACK') } catch {} throw error }
}

/**
 * Prepare an isolated candidate; NEVER replaces currentDb/backupDb or copies media.
 * @param {{currentDb:string,backupDb:string,outputDir:string,offline:true,
 * assertOffline?:(phase:string)=>boolean|Promise<boolean>}} options
 * `offline:true` is the caller's assertion, not process detection. Optional
 * assertOffline is called at each boundary; only true is accepted. Source byte
 * checks detect concurrent changes but cannot prove DSH was stopped.
 * Resolves {state:'isolated',switchAllowed:false,...}; throws with code/reportPath
 * on any copy/schema/barrier/integrity error. Failed output is retained for review.
 */
export async function prepareRestore(options) {
  plain(options,'options')
  for(const key of Object.keys(options)) if(!['currentDb','backupDb','outputDir','offline','assertOffline'].includes(key)) failure('INVALID_OPTION',`Unsupported restore option: ${key}`)
  if(options.offline!==true) failure('OFFLINE_REQUIRED','Stop DSH and child hosts, then explicitly set offline:true')
  if(options.assertOffline!==undefined && typeof options.assertOffline!=='function') failure('INVALID_OPTION','assertOffline must be a function')
  const checkOffline=async phase=>{if(options.assertOffline && await options.assertOffline(phase)!==true) failure('OFFLINE_REQUIRED','Offline precondition could not be verified')}
  await checkOffline('before-copy')
  const current=sourceFile(options.currentDb), backup=sourceFile(options.backupDb)
  const a=statSync(current), b=statSync(backup)
  if(current===backup || (a.dev===b.dev && a.ino===b.ino)) failure('SAME_SOURCE','Current and backup must be independent database files')
  if(typeof options.outputDir!=='string'||!options.outputDir) failure('INVALID_PATH','A new outputDir is required')
  const requested=resolve(options.outputDir), parent=realpathSync(dirname(requested)), output=join(parent,basename(requested))
  if(existsSync(output)) failure('OUTPUT_EXISTS','Output must not exist; failed operations are never overwritten')
  if([dirname(current),dirname(backup)].some(root=>inside(output,root)||inside(root,output))) failure('PATH_OVERLAP','Output must be outside both source database directories')
  mkdirSync(output,{mode:0o700})
  const runId=randomUUID(), at=Date.now(), reportPath=join(output,'report.json')
  const report={format:FORMAT,runId,at,state:'preparing',switchAllowed:false,deletionHistoryComplete:false,
    offlineAssertion:true,currentDb:current,backupDb:backup,outputDir:output,
    limitations:['No activation or live-path switch is provided.','Missing/purged/earlier-rollback deletion history is unknown, not recovered.',
      'Only the primary SQLite database and its sidecars are copied. This is not a full backup.',
      'External vector stores, media, JSON files, DSH profiles, external configuration and installed modules are not restored.',
      'Database snapshots and the audit ledger retain original database content, including any embedded job credentials; only the generated config is credential-free.',
      'All restored content requires review; do not copy the database over a live installation or reuse its enabled config.']}
  let currentDb, candidate
  try {
    // Preserve current bytes BEFORE inspecting or merging either logical database.
    report.currentCopies=copyBundle(current,join(output,'current-original'))
    await checkOffline('after-current-copy')
    report.backupCopies=copyBundle(backup,join(output,'backup-original'))
    await checkOffline('after-backup-copy')
    report.currentSnapshot=join(output,'current.snapshot.sqlite')
    snapshot(join(output,'current-original'),join(output,'work-current'),report.currentSnapshot)
    mkdirSync(join(output,'candidate'))
    report.configPath=join(output,'candidate','config.json');writeNew(report.configPath,isolatedRestoreConfig())
    report.candidateDb=join(output,'candidate','quarantined.sqlite')
    snapshot(join(output,'backup-original'),join(output,'work-backup'),report.candidateDb)
    currentDb=openCopy(report.currentSnapshot); candidate=openCopy(report.candidateDb)
    // A pre-memory backup can acquire the known empty schema. The current library
    // must already contain a complete supported memory schema, or we cannot audit.
    const memoryTables=[...tables(candidate)].filter(t=>t.startsWith('memory_'))
    if(!memoryTables.length) ensureMemorySchema({db:{exec:sql=>candidate.exec(sql),tx:fn=>{
      candidate.exec('BEGIN IMMEDIATE');try{const r=fn();candidate.exec('COMMIT');return r}catch(e){candidate.exec('ROLLBACK');throw e}
    }}})
    checkSchema(currentDb,'current');checkSchema(candidate,'backup')
    Object.assign(report,reconcile(currentDb,candidate,runId,at))
    candidate.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE')
    candidate.close();candidate=null;currentDb.close();currentDb=null
    syncFile(report.candidateDb)
    await checkOffline('before-complete')
    unchanged(current,report.currentCopies);unchanged(backup,report.backupCopies)
    report.candidateSha256=fileHash(report.candidateDb);report.currentSnapshotSha256=fileHash(report.currentSnapshot)
    report.state='isolated';writeNew(reportPath,report)
    return {...report,reportPath}
  } catch(error) {
    try{candidate?.close()}catch{};try{currentDb?.close()}catch{}
    report.state='refused';report.knownBarriersMerged=false
    report.error={code:error.code||'RESTORE_FAILED',message:error.message}
    try{writeNew(reportPath,report)}catch{}
    throw Object.assign(error,{code:error.code||'RESTORE_FAILED',reportPath,outputDir:output})
  }
}

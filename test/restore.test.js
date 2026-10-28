import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStorage } from '../src/storage/index.js'
import { createMemoryStore } from '../src/memory/index.js'
import { prepareRestore, isolatedRestoreConfig } from '../src/migrate/restore.js'
import { ensureSchema as learningSchema } from '../src/learning/schema.js'
import { STICKER_SCHEMA } from '../src/stickers/schema.js'
import { createUsageLedger } from '../src/diagnostics/usage.js'

const scope={account:'fixture-bot',chat:'group:1',persona:''}
const admin={scope,actorId:'fixture-admin',reason:'explicit fixture review'}
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex')
const read=file=>JSON.parse(readFileSync(file,'utf8'))
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const CLI=join(ROOT,'scripts','restore-aurabot.mjs')

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'aurabot-offline-restore-'))
  const currentDir=join(root,'current'), backupDir=join(root,'backup')
  mkdirSync(currentDir);mkdirSync(backupDir)
  const currentDb=join(currentDir,'aurabot.db'), backupDb=join(backupDir,'aurabot.db')
  const outputDir=join(root,'isolated-output')
  const storage=createStorage({file:currentDb,filesDir:join(currentDir,'assets')})
  const memory=createMemoryStore({storage,legacyDir:join(root,'no-legacy')})
  const cleanup=[]
  t.after(async()=>{
    for(const fn of cleanup.reverse()) await fn()
    await memory.dispose();storage.close()
    // All recursive removal is confined to the known mkdtemp fixture root.
    assert.ok(root.startsWith(join(tmpdir(),'aurabot-offline-restore-')))
    rmSync(root,{recursive:true,force:true})
  })
  const fact=(value='咖啡',s=scope)=>{
    const received=storage.messages.ingest({account:s.account,chatId:s.chat,eventKind:'message',authorId:'alice',text:`alice 喜欢${value}`,platformMsgId:`qq-${value}`,segments:[]})
    const message=storage.messages.get(received.id)
    const item=memory.create({scope:s,text:`alice 喜欢${value}`,subject:'alice',predicate:'likes',value,speakerId:'alice',
      polarity:'positive',modality:'asserted',conditions:[],eventTime:null,validFrom:null,validTo:null,status:'active',
      stability:'stable',slot:'multi',profileSection:'preferences',evidenceMessageIds:[message.id]}).item
    return {item,message}
  }
  const backup=()=>storage.db.run('VACUUM INTO ?',backupDb)
  const close=async()=>{await memory.dispose();storage.close()}
  const run=options=>prepareRestore({currentDb,backupDb,outputDir,offline:true,...options})
  const open=file=>{const db=new DatabaseSync(file);cleanup.push(()=>{try{db.close()}catch{}});return db}
  return {root,currentDb,backupDb,outputDir,storage,memory,fact,backup,close,run,open,cleanup}
}

test('restore merges post-backup deletes, withdrawal audits and recalls, while sources remain byte-identical',async t=>{
  const f=fixture(t), deleted=f.fact(), withdrawn=f.fact('茶'), recalled=f.fact('面包'), safe=f.fact('苹果')
  f.backup()
  f.memory.remove(deleted.item.id,admin)
  f.memory.retract(withdrawn.item.id,admin)
  f.storage.messages.markRecalled(scope.chat,recalled.message.platformMsgId)
  await f.close()
  const before=[hash(f.currentDb),hash(f.backupDb)]
  const result=await f.run()
  assert.equal(result.state,'isolated');assert.equal(result.switchAllowed,false);assert.equal(result.deletionHistoryComplete,false)
  assert.deepEqual([hash(f.currentDb),hash(f.backupDb)],before)
  assert.equal(hash(join(f.outputDir,'current-original','database.sqlite')),before[0])
  assert.equal(hash(join(f.outputDir,'backup-original','database.sqlite')),before[1])
  const db=f.open(result.candidateDb)
  assert.equal(db.prepare('SELECT status FROM memory_facts WHERE id=?').get(deleted.item.id).status,'deleted')
  assert.equal(db.prepare('SELECT status FROM memory_facts WHERE id=?').get(withdrawn.item.id).status,'retracted')
  assert.equal(db.prepare('SELECT status FROM memory_facts WHERE id=?').get(safe.item.id).status,'quarantined')
  assert.ok(db.prepare('SELECT recalled_at FROM messages WHERE id=?').get(recalled.message.id).recalled_at)
  assert.equal(db.prepare('SELECT recalled_at FROM messages WHERE id=?').get(safe.message.id).recalled_at,null,'isolation is not falsely recorded as platform recall')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM messages').get().n,4,'original message log is retained')
  assert.ok(db.prepare("SELECT 1 FROM memory_audit WHERE fact_id=? AND json_extract(body,'$.action')='retract'").get(withdrawn.item.id))
  assert.ok(db.prepare("SELECT 1 FROM memory_tombstones WHERE kind='fingerprint' AND account=? AND chat=?").get(scope.account,scope.chat))
  assert.ok(db.prepare("SELECT COUNT(*) n FROM restore_records WHERE source='current'").get().n>0)
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0)
  assert.ok(result.counts.messageRecalls)
})

test('restored facts and evidence require independent approval; old approval tokens and caches cannot leak',async t=>{
  const f=fixture(t), item=f.fact().item
  f.memory.remove(item.id,admin)
  f.memory.restore(item.id,admin)
  const evidence=f.memory.evidenceReview(item.id,{scope})[0]
  f.memory.approveEvidence(evidence.id,{...admin,approved:true,expectedRevision:evidence.revision})
  f.memory.approve(item.id,{...admin,approved:true})
  await f.memory.buildProfile('alice',{scope})
  f.backup();await f.close()
  const result=await f.run(), storage=createStorage({file:result.candidateDb,filesDir:join(f.root,'review-assets')})
  const memory=createMemoryStore({storage,legacyDir:join(f.root,'no-legacy')})
  f.cleanup.push(async()=>{await memory.dispose();storage.close()})
  assert.equal(memory.get(item.id,{scope}),null)
  assert.equal(memory.contextFor({scope}), '')
  assert.deepEqual(memory.recall('咖啡',{scope}),[])
  assert.equal(memory.profileOf('alice',{scope}),null)
  assert.equal(storage.db.get('SELECT COUNT(*) n FROM memory_profiles').n,0)
  assert.ok(storage.db.get('SELECT revision FROM memory_scope_revisions LIMIT 1').revision>1)
  let state=JSON.parse(storage.db.get('SELECT body FROM memory_facts WHERE id=?',item.id).body)
  assert.equal(state.restoreApproval,undefined)
  assert.throws(()=>memory.approve(item.id,{...admin,approved:true}),/审批|证据/)
  // Reopening storage does not grant approval. Existing explicit domain review
  // remains available, including a separate source approval before fact approval.
  if(state.status!=='quarantined') memory.restore(item.id,admin)
  assert.throws(()=>memory.approve(item.id,{...admin,approved:true}),/证据/)
  const review=memory.evidenceReview(item.id,{scope})[0]
  memory.approveEvidence(review.id,{...admin,approved:true,expectedRevision:review.revision})
  memory.approve(item.id,{...admin,approved:true})
  assert.ok(memory.get(item.id,{scope}))
  assert.throws(()=>memory.create({...item,scope,evidenceMessageIds:[item.evidenceMessageIds[0]]}),/撤回|删除/,'old messages remain blocked for automatic re-extraction')
})

test('known recalls match platform id only inside the same account and chat',async t=>{
  const f=fixture(t), a=f.fact(), b=f.fact('咖啡',{...scope,chat:'group:2'})
  f.backup()
  // Simulate historical import allocating a different internal id.
  const bd=f.open(f.backupDb)
  bd.exec('PRAGMA foreign_keys=OFF')
  bd.prepare('UPDATE messages SET id=? WHERE id=?').run('backup-message-id',a.message.id)
  const e=bd.prepare('SELECT * FROM memory_evidence WHERE message_id=?').get(a.message.id), body=JSON.parse(e.body)
  body.messageId='backup-message-id';body.snapshot.id='backup-message-id'
  bd.prepare('UPDATE memory_evidence SET message_id=?,body=? WHERE id=?').run('backup-message-id',JSON.stringify(body),e.id)
  bd.close()
  f.storage.messages.markRecalled(scope.chat,a.message.platformMsgId)
  await f.close()
  const result=await f.run(), db=f.open(result.candidateDb)
  assert.ok(db.prepare('SELECT recalled_at FROM messages WHERE id=?').get('backup-message-id').recalled_at)
  assert.equal(db.prepare('SELECT recalled_at FROM messages WHERE id=?').get(b.message.id).recalled_at,null)
})

test('persona deletion survives restoration and pending delivery/calls are unknown, never auto-retried',async t=>{
  const f=fixture(t);f.fact()
  f.storage.db.exec(`INSERT INTO personas(id,name,origin,created_at,updated_at) VALUES('old-card','Old','user',1,1);
    INSERT INTO persona_revisions VALUES('old-card',1,'{}','',1);
    INSERT INTO persona_bindings VALUES('global','old-card',1);
    INSERT INTO outbox(id,batch_id,seq,chat_id,epoch,kind,payload_json,idempotency_key,state,created_at,updated_at)
      VALUES('send','batch',0,'group:1',1,'text','{}','unique-send','pending',1,1);
    INSERT INTO jobs(id,kind,chat_id,actor_id,epoch,state,input_json,trace_id,created_at,updated_at)
      VALUES('job','image','group:1','alice',1,'submitting','{}','trace',1,1);
    INSERT INTO job_attempts(id,job_id,n,state,started_at) VALUES('attempt','job',1,'running',1);
    INSERT INTO quota_reservations VALUES('reservation','job','user:alice','2026-10-29','held',1);
    INSERT INTO meta VALUES('planner:wait:test','{"state":"waiting"}');`)
  f.backup()
  f.storage.db.exec("DELETE FROM persona_bindings; DELETE FROM persona_revisions; DELETE FROM personas; INSERT INTO persona_tombstones VALUES('old-card',99)")
  await f.close()
  const result=await f.run(), db=f.open(result.candidateDb), config=read(result.configPath)
  assert.ok(db.prepare("SELECT 1 FROM persona_tombstones WHERE id='old-card'").get())
  assert.equal(db.prepare("SELECT 1 FROM personas WHERE id='old-card'").get(),undefined)
  assert.equal(db.prepare('SELECT state FROM outbox').get().state,'unknown')
  assert.equal(db.prepare('SELECT state FROM jobs').get().state,'unknown')
  assert.deepEqual({...db.prepare('SELECT state,billing FROM job_attempts').get()},{state:'unknown',billing:'unknown'})
  assert.equal(db.prepare('SELECT state FROM quota_reservations').get().state,'held','restore does not claim refund')
  assert.equal(JSON.parse(db.prepare("SELECT value FROM meta WHERE key='planner:wait:test'").get().value).state,'unknown')
  assert.equal(config.enabled,false);assert.equal(config.dryRun,true);assert.equal(config.safeMode,true)
  assert.ok(Object.values(config.modules).every(m=>m.enabled===false))
  for(const key of ['memory','learning','voice','stickers','mediaMemory','retrieval','imageGen','search','song','bili','speakUp']) assert.equal(config[key].enabled,false,key)
  assert.equal(config.snowluma.autoStart,false);assert.equal(config.bridge.dshTools,false)
  assert.deepEqual(config,isolatedRestoreConfig())
})

test('learning and sticker deletion states plus invalidated media are retained in isolated candidate',async t=>{
  const f=fixture(t);f.fact();learningSchema(f.storage.db);f.storage.db.exec(STICKER_SCHEMA)
  f.storage.db.exec(`INSERT INTO assets(id,sha256,mime,bytes,path,source_kind,created_at) VALUES('asset','hash','image/png',3,'fixture.png','inbound',1);
    INSERT INTO sticker_items VALUES('sticker','fixture-bot','group:1','hash','md5','asset','approved',1,'{"id":"sticker","state":"approved","revision":1}',1,1);
    INSERT INTO wp6_learning_records(id,scope_key,account_id,chat_id,persona_id,kind,item_key,data_json,status,created_at,updated_at,expires_at)
      VALUES('learn','scope','fixture-bot','group:1','','expression','key','{}','approved',1,1,9999999999999);`)
  f.backup()
  f.storage.db.exec("UPDATE assets SET state='deleted'; UPDATE sticker_items SET state='deleted'; UPDATE wp6_learning_records SET status='deleted'")
  await f.close()
  const result=await f.run(), db=f.open(result.candidateDb)
  assert.equal(db.prepare('SELECT state FROM assets').get().state,'deleted')
  assert.equal(db.prepare('SELECT state FROM sticker_items').get().state,'deleted')
  assert.equal(JSON.parse(db.prepare('SELECT body_json FROM sticker_items').get().body_json).state,'deleted')
  assert.equal(db.prepare('SELECT status FROM wp6_learning_records').get().status,'deleted')
})

test('deleted items created after backup retain native domain barriers, including learning audit-only withdrawals',async t=>{
  const f=fixture(t);f.fact();learningSchema(f.storage.db);f.storage.db.exec(STICKER_SCHEMA)
  f.backup()
  f.storage.db.exec(`INSERT INTO assets(id,sha256,mime,bytes,path,source_kind,state,created_at) VALUES('new-asset','new-hash','image/png',3,'fixture.png','inbound','deleted',1);
    INSERT INTO sticker_items VALUES('new-sticker','fixture-bot','group:1','new-hash','md5','new-asset','deleted',1,'{"id":"new-sticker","state":"deleted","revision":1}',1,1);
    INSERT INTO wp6_learning_records(id,scope_key,account_id,chat_id,persona_id,kind,item_key,data_json,status,created_at,updated_at,expires_at)
      VALUES('learn','scope','fixture-bot','group:1','','expression','key','{}','approved',1,1,9999999999999);
    INSERT INTO wp6_learning_audit VALUES(1,'learn','scope','deleted','fixture-admin',1,1,'withdrawn, later explicitly restored');
    INSERT INTO meta VALUES('media-analysis:v1:hash:occ:image','{"status":"disabled","result":{"description":"old private description"},"disabledHuman":{"private":"text"}}');`)
  await f.close()
  const result=await f.run(), db=f.open(result.candidateDb)
  assert.equal(db.prepare('SELECT state FROM sticker_items').get().state,'deleted')
  assert.equal(db.prepare('SELECT state FROM assets').get().state,'deleted')
  assert.equal(db.prepare('SELECT status FROM wp6_learning_records').get().status,'deleted')
  const media=JSON.parse(db.prepare("SELECT value FROM meta WHERE key LIKE 'media-analysis:%'").get().value)
  assert.equal(media.status,'disabled');assert.equal(media.result,null);assert.equal(media.disabledHuman,null)
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0)
  assert.ok(result.counts.preservedOtherDeletions>=2)
})

test('current missing/purged records never imply approval or complete deletion history',async t=>{
  const f=fixture(t), old=f.fact().item
  f.backup()
  f.storage.db.exec('DELETE FROM memory_fact_evidence; DELETE FROM memory_facts; DELETE FROM memory_evidence; DELETE FROM memory_audit; DELETE FROM memory_tombstones')
  await f.close()
  const result=await f.run(), db=f.open(result.candidateDb)
  assert.equal(result.deletionHistoryComplete,false)
  assert.equal(result.switchAllowed,false)
  assert.equal(db.prepare('SELECT status FROM memory_facts WHERE id=?').get(old.id).status,'quarantined')
  assert.match(result.limitations.join(' '),/purged/)
})

test('new usage ledger keeps post-backup reported values and nulls without inventing fees',async t=>{
  const f=fixture(t);f.fact();f.backup()
  const usage=createUsageLedger({storage:f.storage,getAccount:()=>scope.account})
  usage.record({id:'known-call',service:'fixture-provider',chatId:scope.chat,inputTokens:12,outputTokens:4,credits:2,amount:0.125,currency:'fixture-currency',status:'succeeded'})
  usage.record({id:'unknown-call',service:'fixture-provider',chatId:scope.chat,status:'unknown'})
  await f.close()
  const result=await f.run(), db=f.open(result.candidateDb)
  assert.deepEqual({...db.prepare("SELECT input_tokens,output_tokens,credits,amount,currency FROM service_calls WHERE id='known-call'").get()},
    {input_tokens:12,output_tokens:4,credits:2,amount:0.125,currency:'fixture-currency'})
  assert.equal(db.prepare("SELECT amount FROM service_calls WHERE id='unknown-call'").get().amount,null)
  assert.equal(result.counts.preservedUsageCalls,2)
})

test('conflicting usage receipt refuses instead of choosing or summing a fee',async t=>{
  const f=fixture(t);f.fact()
  const usage=createUsageLedger({storage:f.storage,getAccount:()=>scope.account})
  usage.record({id:'call',service:'fixture-provider',amount:1,currency:'fixture-currency'})
  f.backup();f.storage.db.run('UPDATE service_calls SET amount=2 WHERE id=?','call');await f.close()
  await assert.rejects(f.run(),{code:'USAGE_CONFLICT'})
})

test('audit-only corrected/retracted fact prevents an old snapshot becoming active',async t=>{
  const f=fixture(t), old=f.fact().item
  f.backup();f.memory.retract(old.id,admin)
  f.storage.db.run('DELETE FROM memory_fact_evidence WHERE fact_id=?',old.id)
  f.storage.db.run('DELETE FROM memory_facts WHERE id=?',old.id)
  await f.close()
  const result=await f.run(), db=f.open(result.candidateDb)
  assert.equal(db.prepare('SELECT status FROM memory_facts WHERE id=?').get(old.id).status,'retracted')
  assert.ok(db.prepare("SELECT 1 FROM memory_tombstones WHERE kind='fingerprint'").get())
})

test('pre-memory backup gains empty schema but partial current deletion tables refuse',async t=>{
  const f=fixture(t)
  // Generate a core-only backup without opening any real data directory.
  const old=createStorage({file:f.backupDb,filesDir:''});old.close()
  f.fact();await f.close()
  const result=await f.run()
  assert.equal(result.state,'isolated')
  assert.equal(f.open(result.candidateDb).prepare('SELECT COUNT(*) n FROM memory_facts').get().n,0)
  const current=f.open(f.currentDb);current.exec('DROP TABLE memory_tombstones');current.close()
  await assert.rejects(f.run({outputDir:join(f.root,'partial-schema')}),{code:'UNSUPPORTED_SCHEMA'})
})

test('conflicting message identity refuses without modifying source databases',async t=>{
  const f=fixture(t), old=f.fact()
  f.backup();f.storage.messages.markRecalled(scope.chat,old.message.platformMsgId);await f.close()
  const backup=f.open(f.backupDb);backup.prepare('UPDATE messages SET account_id=? WHERE id=?').run('other-bot',old.message.id);backup.close()
  const before=[hash(f.currentDb),hash(f.backupDb)]
  await assert.rejects(f.run(),{code:'IDENTITY_CONFLICT'})
  assert.deepEqual([hash(f.currentDb),hash(f.backupDb)],before)
})

test('unrecognized trigger refuses instead of executing its side effects',async t=>{
  const f=fixture(t);f.fact();f.backup();await f.close()
  const backup=f.open(f.backupDb)
  backup.exec("CREATE TRIGGER unreviewed_restore_trigger AFTER UPDATE ON memory_facts BEGIN DELETE FROM memory_tombstones; END")
  backup.close()
  await assert.rejects(f.run(),{code:'UNSUPPORTED_SCHEMA'})
  assert.equal(read(join(f.outputDir,'report.json')).state,'refused')
})

test('copied trigger SQL is never executed, even when it uses a recognized name',async t=>{
  const f=fixture(t), old=f.fact().item;f.backup();f.memory.remove(old.id,admin);await f.close()
  const backup=f.open(f.backupDb)
  backup.exec("DROP TRIGGER memory_message_update; CREATE TRIGGER memory_message_update AFTER UPDATE ON messages BEGIN DELETE FROM memory_tombstones; END")
  backup.close()
  const result=await f.run(), db=f.open(result.candidateDb)
  const before=db.prepare('SELECT COUNT(*) n FROM memory_tombstones').get().n
  db.exec("UPDATE messages SET text=text||' reviewed'")
  assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_tombstones').get().n,before)
  assert.match(db.prepare("SELECT sql FROM sqlite_schema WHERE name='memory_message_update'").get().sql,/memory_scope_revisions/)
})

test('corrupt source refuses with independent bytes already preserved and no completion certificate',async t=>{
  const f=fixture(t);f.fact();f.backup();await f.close()
  writeFileSync(f.currentDb,'not a sqlite database')
  const before=hash(f.currentDb)
  await assert.rejects(f.run(),e=>e.reportPath && read(e.reportPath).state==='refused')
  assert.equal(hash(join(f.outputDir,'current-original','database.sqlite')),before)
  assert.equal(hash(f.currentDb),before)
})

test('raw WAL and committed deletion barriers are preserved without opening originals in SQLite',async t=>{
  const f=fixture(t), item=f.fact().item
  f.backup();await f.close()
  const sourceUrl=new URL('../src/storage/index.js',import.meta.url).href, memoryUrl=new URL('../src/memory/index.js',import.meta.url).href
  const code=`import {createStorage} from ${JSON.stringify(sourceUrl)}; import {createMemoryStore} from ${JSON.stringify(memoryUrl)};
    const storage=createStorage({file:process.argv[1],filesDir:''});storage.db.exec('PRAGMA wal_autocheckpoint=0');
    const m=createMemoryStore({storage,legacyDir:process.argv[2]});m.remove(process.argv[3],${JSON.stringify(admin)});process.exit(0)`
  const child=spawnSync(process.execPath,['--input-type=module','-e',code,f.currentDb,join(f.root,'no-legacy'),item.id],{encoding:'utf8'})
  assert.equal(child.status,0,child.stderr);assert.ok(existsSync(f.currentDb+'-wal'))
  const before=hash(f.currentDb+'-wal'), result=await f.run()
  assert.equal(hash(f.currentDb+'-wal'),before)
  assert.equal(hash(join(f.outputDir,'current-original','database.sqlite-wal')),before)
  assert.equal(f.open(result.candidateDb).prepare('SELECT status FROM memory_facts WHERE id=?').get(item.id).status,'deleted')
})

test('malformed or missing deletion schema refuses after preserving current, leaving inputs untouched',async t=>{
  const f=fixture(t), item=f.fact().item;f.backup();f.memory.remove(item.id,admin)
  f.storage.db.run("UPDATE memory_tombstones SET body='{}'")
  await f.close();const before=[hash(f.currentDb),hash(f.backupDb)]
  await assert.rejects(f.run(),e=>e.code==='INVALID_BARRIER'&&!!e.reportPath)
  const report=read(join(f.outputDir,'report.json'))
  assert.equal(report.state,'refused');assert.equal(report.switchAllowed,false)
  assert.equal(hash(join(f.outputDir,'current-original','database.sqlite')),before[0])
  assert.deepEqual([hash(f.currentDb),hash(f.backupDb)],before)
})

test('unknown tables, future schema and unavailable current evidence never fall back to a direct restore',async t=>{
  const f=fixture(t);f.fact();f.backup();await f.close()
  let db=f.open(f.currentDb);db.exec('CREATE TABLE future_deletions(id TEXT PRIMARY KEY)');db.close()
  await assert.rejects(f.run(),{code:'UNSUPPORTED_SCHEMA'})
  db=f.open(f.currentDb);db.exec('DROP TABLE future_deletions; PRAGMA user_version=999');db.close()
  await assert.rejects(f.run({outputDir:join(f.root,'future-output')}),{code:'UNSUPPORTED_SCHEMA'})
  await assert.rejects(f.run({currentDb:join(f.root,'missing.db'),outputDir:join(f.root,'missing-output')}),{code:'ENOENT'})
  assert.equal(existsSync(join(f.root,'missing-output')),false)
})

test('offline assertion, new output, non-overlap and independent source files are mandatory',async t=>{
  const f=fixture(t);f.fact();f.backup();await f.close()
  await assert.rejects(f.run({offline:false}),{code:'OFFLINE_REQUIRED'})
  await assert.rejects(f.run({assertOffline:()=>false}),{code:'OFFLINE_REQUIRED'})
  await assert.rejects(f.run({outputDir:join(dirname(f.currentDb),'inside')}),{code:'PATH_OVERLAP'})
  await assert.rejects(f.run({backupDb:f.currentDb}),{code:'SAME_SOURCE'})
  const alias=join(f.root,'alias.db');linkSync(f.currentDb,alias)
  await assert.rejects(f.run({backupDb:alias}),{code:'SAME_SOURCE'})
  await assert.rejects(f.run({switch:true}),{code:'INVALID_OPTION'})
  mkdirSync(f.outputDir);writeFileSync(join(f.outputDir,'keep.txt'),'owned by another operation')
  await assert.rejects(f.run(),{code:'OUTPUT_EXISTS'})
  assert.equal(readFileSync(join(f.outputDir,'keep.txt'),'utf8'),'owned by another operation')
})

test('source changes or lost offline precondition refuse completion; original copies remain available',async t=>{
  const f=fixture(t);f.fact();f.backup();await f.close()
  const original=hash(f.currentDb)
  await assert.rejects(f.run({assertOffline:phase=>{
    if(phase==='before-complete') {const db=f.open(f.currentDb);db.exec("INSERT INTO meta VALUES('fixture-race','1')");db.close()}
    return true
  }}),{code:'SOURCE_CHANGED'})
  assert.equal(hash(join(f.outputDir,'current-original','database.sqlite')),original)
  assert.equal(read(join(f.outputDir,'report.json')).state,'refused')
  await assert.rejects(f.run({outputDir:join(f.root,'offline-lost'),assertOffline:phase=>phase!=='after-current-copy'}),{code:'OFFLINE_REQUIRED'})
  assert.ok(existsSync(join(f.root,'offline-lost','current-original','manifest.json')))
  assert.equal(existsSync(join(f.root,'offline-lost','backup-original')),false)
})

test('CLI exposes preparation only; malformed args never touch a library',async t=>{
  const f=fixture(t);f.fact();f.backup();await f.close()
  const help=spawnSync(process.execPath,[CLI,'--help'],{encoding:'utf8'})
  assert.equal(help.status,0);assert.match(help.stdout,/NOT approval or activation/)
  const invalid=spawnSync(process.execPath,[CLI,'--current',f.currentDb,'--backup',f.backupDb,'--output',f.outputDir,'--force'],{encoding:'utf8'})
  assert.equal(invalid.status,1);assert.match(invalid.stderr,/INVALID_ARGUMENT/);assert.equal(existsSync(f.outputDir),false)
  const result=spawnSync(process.execPath,[CLI,'--current',f.currentDb,'--backup',f.backupDb,'--output',f.outputDir,'--offline'],{encoding:'utf8'})
  assert.equal(result.status,0,result.stderr)
  const output=JSON.parse(result.stdout);assert.equal(output.state,'isolated');assert.equal(output.switchAllowed,false)
  assert.ok(read(output.reportPath).limitations.length)
  assert.ok(readdirSync(f.outputDir).includes('current-original'))
})

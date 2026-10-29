import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {setImmediate as nextTurn} from 'node:timers/promises'
import {createStorage} from '../src/storage/index.js'
import {createMemoryStore} from '../src/features/memory.js'

const S={account:'bot',chat:'group:1',persona:''}
const gate=()=>{let release;const promise=new Promise(r=>{release=r});return {promise,release}}
const fact=m=>({inputId:'one',text:'小明喜欢咖啡',subject:'user',predicate:'likes',value:'咖啡',speakerId:'user',polarity:'positive',modality:'asserted',conditions:[],eventTime:null,validFrom:null,validTo:null,stability:'stable',evidenceMessageIds:[m.id || m.messageId]})
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'aurabot-memory-lifecycle-'))
  const storage=createStorage({file:join(dir,'test.sqlite'),filesDir:join(dir,'assets')})
  t.after(()=>{storage.close();rmSync(dir,{recursive:true,force:true})})
  const message=storage.messages.ingest({account:S.account,chatId:S.chat,authorId:'user',eventKind:'message',text:'喜欢咖啡',segments:[]})
  return {storage,message}
}
test('dispose aborts and settles extraction, then late model output never touches a closed DB',async t=>{
  const {storage}=fixture(t),entered=gate(),resume=gate();let signal
  const memory=createMemoryStore({storage,extract:async args=>{signal=args.signal;entered.release();await resume.promise;return {facts:args.messages.map(fact),summary:null}},deduplicate:async({facts})=>facts.map(f=>({inputId:f.inputId,action:'keep'}))})
  const job=memory.consolidate({scope:S});await entered.promise
  const closing=memory.dispose()
  assert.equal(memory.stop(),closing,'disposal is idempotent')
  assert.equal((await closing).stopped,true)
  assert.equal(signal.aborted,true)
  assert.equal((await job).code,'MEMORY_STOPPED')
  assert.equal(storage.db.get('SELECT COUNT(*) AS n FROM memory_facts').n,0)
  assert.equal(storage.db.get('SELECT recv_seq FROM memory_checkpoints').recv_seq,0)
  storage.close()
  let lateCalls=0
  for(const method of ['get','all','run','exec','tx']) storage.db[method]=()=>{lateCalls++;throw new Error('database already closed')}
  resume.release();await nextTurn();await nextTurn()
  assert.equal(lateCalls,0)
  assert.equal(memory.addEvent({scope:S,text:'迟到事件'}).code,'MEMORY_STOPPED')
  assert.throws(()=>memory.list({scope:S}),error=>error.code==='MEMORY_STOPPED')
  assert.equal(lateCalls,0)
})
test('stop while dedup is pending rolls back publication and waits for the worker to release its lease',async t=>{
  const {storage}=fixture(t),entered=gate(),resume=gate()
  const memory=createMemoryStore({storage,extract:async({messages})=>({facts:[fact(messages[0]),{...fact(messages[0]),inputId:'two',value:'茶'}],summary:null}),deduplicate:async({facts})=>{entered.release();await resume.promise;return facts.map(f=>({inputId:f.inputId,action:'keep'}))}})
  const job=memory.consolidate({scope:S});await entered.promise
  await memory.stop()
  assert.equal((await job).ok,false)
  const checkpoint=storage.db.get('SELECT * FROM memory_checkpoints')
  assert.equal(checkpoint.recv_seq,0)
  assert.equal(checkpoint.state,'pending')
  assert.equal(checkpoint.lease_token,null)
  resume.release();await nextTurn()
  assert.equal(storage.db.get('SELECT COUNT(*) AS n FROM memory_evidence').n,0)
})
test('dispose also fences asynchronous profile generation and forbids late cache writes',async t=>{
  const {storage,message}=fixture(t),entered=gate(),resume=gate()
  const memory=createMemoryStore({storage,generateProfile:async({facts})=>{entered.release();await resume.promise;return {stableFacts:[{text:facts[0].text,factIds:[facts[0].id]}]}}})
  memory.create({...fact(message),scope:S})
  const job=memory.buildProfile('user',{scope:S})
  const outcome=job.catch(error=>error)
  await entered.promise;await memory.dispose()
  assert.equal((await outcome).code,'MEMORY_STOPPED')
  assert.equal(storage.db.get('SELECT COUNT(*) AS n FROM memory_profiles').n,0)
  storage.close()
  let lateCalls=0
  for(const method of ['get','all','run','exec','tx']) storage.db[method]=()=>{lateCalls++;throw new Error('closed')}
  resume.release();await nextTurn();assert.equal(lateCalls,0)
})
test('account changes reject late extraction and profile outputs without advancing progress',async t=>{
  const {storage,message}=fixture(t),entered=gate(),resume=gate();let account='bot'
  const memory=createMemoryStore({storage,getAccount:()=>account,extract:async({messages})=>{entered.release();await resume.promise;return {facts:messages.map(fact),summary:null}},deduplicate:async({facts})=>facts.map(f=>({inputId:f.inputId,action:'keep'}))})
  const job=memory.consolidate({scope:S});await entered.promise;account='new-bot';resume.release()
  assert.equal((await job).code,'ACCOUNT_CHANGED')
  assert.equal(memory.status(S).recvSeq,0)
  assert.equal(memory.list({scope:S}).length,0)
  assert.throws(()=>memory.consolidate({scope:S}),error=>error.code==='ACCOUNT_CHANGED')
  const started=gate(),later=gate();account='bot'
  const second=createMemoryStore({storage,getAccount:()=>account,generateProfile:async({facts})=>{started.release();await later.promise;return {stableFacts:[{text:facts[0].text,factIds:[facts[0].id]}]}}})
  second.create({...fact(message),scope:S})
  const profile=second.buildProfile('user',{scope:S}),outcome=profile.catch(error=>error)
  await started.promise;account='new-bot';later.release()
  assert.equal((await outcome).code,'ACCOUNT_CHANGED')
  assert.equal(storage.db.get('SELECT COUNT(*) AS n FROM memory_profiles').n,0)
  await memory.dispose();await second.dispose()
})
test('immediate disposal before a queued task starts performs no later DB access',async t=>{
  const {storage}=fixture(t)
  const memory=createMemoryStore({storage,extract:async()=>{throw new Error('must not call model')}})
  const job=memory.consolidate({scope:S})
  await memory.dispose();assert.equal((await job).code,'MEMORY_STOPPED')
  storage.close();await nextTurn()
})

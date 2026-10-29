import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorage } from '../src/storage/index.js'
import { createMemoryStore } from '../src/memory/index.js'
import { deferred, settled } from './helpers/wp6.js'
import { observeModelUsage } from '../src/core/llm.js'
import { createUsageLedger } from '../src/diagnostics/usage.js'

const S={account:'bot',chat:'group:101',persona:''}
const zero={facts:[],summary:null}
function fixture(t,extra={}) {
  let time=1000000
  const cfg={enabled:true,botQQ:'bot',allow:{groups:['101'],private:[]},memory:{enabled:true,extraction:{minMessages:1,maxBatchMessages:100}}}
  const storage=createStorage({file:':memory:',filesDir:''}), services=[]
  t.after(async()=>{await Promise.all(services.map(s=>s.stop()));storage.close()})
  const create=options=>{const m=createMemoryStore({storage,getConfig:()=>cfg,now:()=>time,extract:async()=>zero,...extra,...options});services.push(m);return m}
  return {cfg,storage,create,advance:ms=>{time+=ms},setTime:at=>{time=at},now:()=>time,
    add:()=>storage.messages.ingest({account:S.account,chatId:S.chat,authorId:'alice',eventKind:'message',text:'今天喜欢喝茶',receivedAt:time})}
}

test('output budget bounds batches; failures shrink the retained interval and successful retries advance all messages',async t=>{
  const batches=[],f=fixture(t,{extract:async({messages,maxTokens})=>{
    batches.push(messages.length);assert.equal(maxTokens,6000)
    if(messages.length>1) throw Object.assign(new Error('truncated'),{code:'MODEL_INCOMPLETE'})
    return zero
  }})
  let memory=f.create()
  for(let n=0;n<20;n++) f.add()
  assert.equal((await memory.consolidate(S)).code,'MODEL_INCOMPLETE')
  assert.equal(batches[0],5)
  assert.equal(memory.status(S).recvSeq,0)
  assert.equal(memory.status(S).batchLimit,2)
  f.add();assert.equal(memory.due(S),false,'new input cannot bypass backoff')
  assert.equal((await memory.consolidate(S)).code,'EXTRACTION_BACKOFF')
  await memory.stop();memory=f.create()
  f.setTime(memory.status(S).nextAttemptAt)
  assert.equal((await memory.consolidate(S)).ok,false)
  assert.equal(batches[1],2)
  f.setTime(memory.status(S).nextAttemptAt)
  const done=await memory.consolidate(S)
  assert.equal(done.ok,true);assert.equal(done.processed,21)
  assert.ok(batches.slice(2).every(n=>n===1))
  assert.equal(memory.status(S).recvSeq,memory.status(S).watermark)
  assert.equal(memory.status(S).failures,0)
  assert.equal(f.storage.db.get('SELECT COUNT(*) n FROM messages').n,21)
})

test('repeated malformed output pauses durably; an explicit resume preserves evidence and reduced batch limits',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'aurabot-background-')),file=join(dir,'retry.sqlite')
  let time=1000000,calls=0,storage=createStorage({file,filesDir:''}),memory
  const cfg={memory:{extraction:{minMessages:1}}}
  t.after(async()=>{await memory?.stop();storage.close();rmSync(dir,{recursive:true,force:true})})
  const create=extract=>createMemoryStore({storage,getConfig:()=>cfg,now:()=>time,extract})
  memory=create(async()=>{calls++;return 'malformed'})
  storage.messages.ingest({account:S.account,chatId:S.chat,authorId:'alice',eventKind:'message',text:'证据不能丢弃'})
  for(let i=1;i<=6;i++) {
    assert.equal((await memory.consolidate(S)).ok,false)
    assert.equal(memory.status(S).failures,i)
    assert.equal(memory.status(S).nextAttemptAt-time,60000*2**(i-1))
    time=memory.status(S).nextAttemptAt
  }
  assert.equal(memory.status(S).paused,true);assert.ok(memory.status(S).pauseReason)
  await memory.stop();storage.close();storage=createStorage({file,filesDir:''})
  memory=create(async()=>{calls++;return zero})
  time+=86400000
  assert.equal((await memory.consolidate(S)).code,'EXTRACTION_PAUSED')
  assert.equal(calls,6);assert.equal(memory.status(S).recvSeq,0)
  assert.equal(memory.resumeExtraction(S).ok,true)
  assert.equal((await memory.consolidate(S)).ok,true)
  assert.equal(calls,7);assert.equal(memory.status(S).recvSeq,1)
})

for(const stage of ['extraction','deduplication']) for(const revoke of ['allowlist','module','global']) {
  test(`${revoke} revocation cancels pending ${stage} and rejects late writes even after re-enable`,async t=>{
    const entered=deferred(),late=deferred(),f=fixture(t),signals=[]
    const fact=m=>({inputId:'f1',text:'喜欢喝茶',subject:'alice',predicate:'likes',value:'茶',speakerId:'alice',
      polarity:'positive',modality:'asserted',conditions:[],eventTime:null,validFrom:null,validTo:null,stability:'stable',evidenceMessageIds:[m.messageId]})
    const memory=f.create({extract:async({messages,signal})=>{
      signals.push(signal)
      if(stage==='extraction'){entered.resolve();await late.promise}
      const facts=messages.map(fact)
      if(stage==='deduplication') facts.push({...facts[0],inputId:'f2',value:'水'})
      return {facts,summary:null}
    },deduplicate:async({facts,signal})=>{
      signals.push(signal);entered.resolve();await late.promise
      return facts.map(f=>({inputId:f.inputId,action:'keep'}))
    }})
    f.add();const job=memory.consolidate(S);await entered.promise
    if(revoke==='allowlist') f.cfg.allow.groups=[]
    if(revoke==='module') f.cfg.memory.enabled=false
    if(revoke==='global') f.cfg.enabled=false
    memory.refreshPolicy()
    assert.equal((await job).ok,false)
    assert.equal(signals.at(-1).aborted,true)
    assert.equal(memory.status(S).recvSeq,0);assert.equal(memory.status(S).failures,0)
    assert.ok(memory.status(S).blockedReason);assert.equal(memory.due(S),false)
    assert.throws(()=>memory.enqueue(S))
    f.cfg.allow.groups=['101'];f.cfg.memory.enabled=true;f.cfg.enabled=true
    late.resolve();await settled()
    assert.equal(memory.list(S).length,0)
    assert.equal(f.storage.db.get('SELECT lease_token FROM memory_checkpoints').lease_token,null)
  })
}

test('revocation before queued extraction starts prevents the model call',async t=>{
  let calls=0;const f=fixture(t,{extract:async()=>{calls++;return zero}}),memory=f.create()
  f.add();const job=memory.consolidate(S)
  f.cfg.allow.groups=[];memory.refreshPolicy()
  assert.equal((await job).code,'SCOPE_DISABLED');assert.equal(calls,0)
  assert.equal(memory.status(S).recvSeq,0)
})

test('memory stop drains the canceled model accounting before storage closes',async t=>{
  const entered=deferred(),late=deferred(),f=fixture(t)
  const dsh={llm:{stream:async function*(){entered.resolve();await late.promise;yield {type:'finish',reason:'stop'}}}}
  f.cfg.model={provider:'mock',model:'offline'}
  const ledger=createUsageLedger({storage:f.storage,getAccount:()=>S.account})
  t.after(observeModelUsage(dsh,event=>ledger.record(event)))
  const memory=f.create({dsh,extract:undefined});f.add()
  const job=memory.consolidate(S);await entered.promise;await memory.stop();await job
  const report=ledger.report()
  assert.equal(report.items.length,1)
  assert.equal(report.items[0].status,'aborted');assert.equal(report.items[0].businessStatus,'discarded')
  late.resolve();await settled()
  assert.equal(ledger.report().items.length,1)
})

import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createStorage} from '../src/storage/index.js'
import {createMemoryStore} from '../src/features/memory.js'

const S={account:'bot',chat:'group:101',persona:'fish'}
const waitGate=()=>{let release;const promise=new Promise(r=>{release=r});return {promise,release}}
function extracted(m,patch={}) {
  return {inputId:m.messageId,text:m.text,subject:m.speakerId,predicate:'likes',value:'咖啡',speakerId:m.speakerId,
    polarity:'positive',modality:'asserted',conditions:[],eventTime:null,validFrom:null,validTo:null,stability:'stable',evidenceMessageIds:[m.messageId],...patch}
}
function fixture(t,options={}) {
  const dir=mkdtempSync(join(tmpdir(),'aurabot-extraction-'))
  const storage=createStorage({file:join(dir,'test.sqlite'),filesDir:join(dir,'assets')})
  t.after(()=>{storage.close();rmSync(dir,{recursive:true,force:true})})
  const memory=createMemoryStore({storage,extract:async({messages})=>({facts:messages.map(m=>extracted(m)),summary:{text:'小明喜欢咖啡',evidenceMessageIds:messages.map(m=>m.messageId)}}),
    deduplicate:async({facts})=>facts.map(f=>({inputId:f.inputId,action:'keep'})),...options})
  const ingest=(text='小明喜欢咖啡',scope=S,extra={})=>storage.messages.ingest({account:scope.account,chatId:scope.chat,authorId:'user',eventKind:'message',text,segments:[],...extra})
  return {storage,memory,ingest,dir}
}

test('checkpoint uses recv sequence, survives reopen, processes late platform timestamps and retains messages',async t=>{
  const {storage,memory,ingest,dir}=fixture(t)
  const a=ingest('先收到',{...S},{platformTime:5000})
  assert.equal((await memory.consolidate({scope:S})).ok,true)
  assert.equal(memory.status(S).recvSeq,a.recvSeq)
  const b=ingest('晚到但平台时间更早',S,{platformTime:1000})
  storage.close()
  const reopened=createStorage({file:join(dir,'test.sqlite'),filesDir:join(dir,'assets')})
  try {
    const restarted=createMemoryStore({storage:reopened,extract:async({messages})=>({facts:messages.map(m=>extracted(m)),summary:null}),deduplicate:async({facts})=>facts.map(f=>({inputId:f.inputId,action:'keep'}))})
    const result=await restarted.consolidate({scope:S})
    assert.equal(result.ok,true,result.message)
    assert.equal(result.processed,1)
    assert.equal(restarted.status(S).recvSeq,b.recvSeq)
    assert.equal(reopened.db.get('SELECT COUNT(*) AS n FROM messages').n,2)
    assert.equal(restarted.episodes(S).length,1)
  } finally {reopened.close()}
})
test('model exceptions, invalid JSON and absent summary never become successful empty extractions',async t=>{
  let response=''
  const {memory,ingest}=fixture(t,{extract:async()=>{if(response instanceof Error)throw response;return response}})
  ingest()
  for(const output of [new Error('timeout'),'','non-json','{"facts":[]}',{facts:[],summary:null,unexpected:true}]) {
    response=output
    const r=await memory.consolidate({scope:S})
    assert.equal(r.ok,false)
    assert.equal(memory.status(S).recvSeq,0)
    assert.equal(memory.status(S).state,'pending')
    assert.ok(memory.status(S).error)
  }
  response={facts:[],summary:null}
  assert.equal((await memory.consolidate({scope:S})).ok,true)
  assert.ok(memory.status(S).recvSeq>0)
  assert.equal(memory.list({scope:S}).length,0)
})
test('invalid dedup decisions roll back the entire current batch and summary',async t=>{
  const {storage,memory,ingest}=fixture(t,{deduplicate:async({facts})=>[{inputId:facts[0].inputId,action:'keep'}]})
  ingest('喜欢咖啡');ingest('也喜欢茶')
  const r=await memory.consolidate({scope:S})
  assert.equal(r.ok,false)
  assert.equal(memory.status(S).recvSeq,0)
  assert.equal(memory.list({scope:S}).length,0)
  assert.equal(storage.db.get('SELECT COUNT(*) AS n FROM memory_episodes').n,0)
  assert.equal(storage.db.get('SELECT COUNT(*) AS n FROM memory_evidence').n,0)
})
test('SQLite commit failure atomically rolls back facts, evidence, episodes, audit and checkpoint',async t=>{
  const {storage,memory,ingest}=fixture(t)
  ingest()
  storage.db.exec("CREATE TRIGGER fail_checkpoint BEFORE UPDATE OF recv_seq ON memory_checkpoints WHEN NEW.recv_seq>0 BEGIN SELECT RAISE(ABORT,'injected disk failure'); END;")
  const r=await memory.consolidate({scope:S})
  assert.equal(r.ok,false)
  assert.match(r.message,/injected disk failure/)
  for(const table of ['memory_facts','memory_evidence','memory_episodes','memory_audit']) assert.equal(storage.db.get(`SELECT COUNT(*) AS n FROM ${table}`).n,0,table)
  assert.equal(memory.status(S).recvSeq,0)
  storage.db.exec('DROP TRIGGER fail_checkpoint')
  assert.equal((await memory.consolidate({scope:S})).ok,true)
})
test('long input is fully chunked including one oversized message, with no tail-only checkpoint',async t=>{
  const seen=[]
  const {memory,ingest}=fixture(t,{getConfig:()=>({memory:{extraction:{maxChars:256,batchMessages:2}}}),extract:async({messages})=>{seen.push(...messages);return {facts:[],summary:null}}})
  const text='开始'+('咖啡'.repeat(600))+'结尾'
  ingest(text);ingest('第二条');const last=ingest('第三条')
  const r=await memory.consolidate({scope:S})
  assert.equal(r.ok,true,r.message)
  assert.equal(seen.filter(m=>m.parts>1).map(m=>m.text).join(''),text)
  assert.equal(seen.at(-1).text,'第三条')
  assert.equal(r.processed,3)
  assert.equal(memory.status(S).recvSeq,last.recvSeq)
})
test('only successfully committed earlier blocks advance; failure retries the exact remaining interval',async t=>{
  let calls=0
  const {memory,ingest}=fixture(t,{getConfig:()=>({memory:{extraction:{batchMessages:1}}}),extract:async({messages})=>{
    calls++;if(calls===2)throw new Error('second block fails')
    return {facts:messages.map(m=>extracted(m)),summary:null}
  }})
  const first=ingest('第一条'),last=ingest('第二条')
  assert.equal((await memory.consolidate({scope:S})).ok,false)
  assert.equal(memory.status(S).recvSeq,first.recvSeq)
  assert.equal(memory.list({scope:S}).length,1)
  assert.equal((await memory.consolidate({scope:S})).processed,1)
  assert.equal(memory.status(S).recvSeq,last.recvSeq)
})
test('same scope coalesces requests while another instance sees the durable lease',async t=>{
  const entered=waitGate(),resume=waitGate();let calls=0
  const {storage,memory,ingest}=fixture(t,{extract:async()=>{calls++;entered.release();await resume.promise;return {facts:[],summary:null}}})
  const first=ingest()
  const a=memory.consolidate({scope:S})
  await entered.promise
  const second=ingest('第二条')
  const b=memory.consolidate({scope:S})
  assert.equal(a,b,'same promise reused')
  const other=createMemoryStore({storage,extract:async()=>{throw new Error('must not run')}})
  assert.equal((await other.consolidate({scope:S})).code,'EXTRACTION_BUSY')
  resume.release();assert.equal((await a).ok,true)
  assert.equal(calls,1)
  assert.equal(memory.status(S).recvSeq,first.recvSeq)
  assert.equal(memory.status(S).watermark,second.recvSeq)
  assert.equal(memory.status(S).state,'pending')
  assert.equal((await memory.consolidate({scope:S})).ok,true)
  assert.equal(calls,2)
})
test('source edits and policy changes during an awaited model cannot publish stale content',async t=>{
  const entered=waitGate(),resume=waitGate();let policy={shareGroups:[]}
  const {storage,memory,ingest}=fixture(t,{getPolicy:()=>policy,extract:async({messages})=>{entered.release();await resume.promise;return {facts:messages.map(m=>extracted(m)),summary:null}}})
  const msg=ingest(),job=memory.consolidate({scope:S})
  await entered.promise
  storage.db.run('UPDATE messages SET text=? WHERE id=?','刚刚更正过',msg.id)
  resume.release()
  assert.equal((await job).code,'STALE_EVIDENCE')
  assert.equal(memory.status(S).recvSeq,0)
  const second=createMemoryStore({storage,getPolicy:()=>policy,extract:async()=>{policy={revision:2,shareGroups:[]};return {facts:[],summary:null}}})
  assert.equal((await second.consolidate({scope:S})).code,'STALE_BATCH')
  assert.equal(second.status(S).recvSeq,0)
})
test('delete during dedup invalidates the pending batch and suppresses old-source replays',async t=>{
  const entered=waitGate(),resume=waitGate()
  const {memory,ingest}=fixture(t,{deduplicate:async({facts})=>{entered.release();await resume.promise;return facts.map(f=>({inputId:f.inputId,action:'keep'}))}})
  const msg=ingest(),f=memory.create({scope:S,...extracted({messageId:msg.id,speakerId:'user',text:'小明喜欢咖啡'})}).item
  const job=memory.consolidate({scope:S});await entered.promise
  memory.remove(f.id,{scope:S,actorId:'admin',reason:'忘记'})
  resume.release()
  assert.equal((await job).code,'STALE_BATCH')
  assert.equal(memory.status(S).recvSeq,0)
  const retry=await memory.consolidate({scope:S})
  assert.equal(retry.ok,true,retry.message)
  assert.equal(memory.list({scope:S}).length,0)
})
test('threshold count OR elapsed successful interval requires genuinely new messages',async t=>{
  let clock=10000
  const {memory,ingest}=fixture(t,{now:()=>clock,getConfig:()=>({memory:{extraction:{minMessages:3,intervalMs:1000}}}),extract:async()=>({facts:[],summary:null})})
  assert.equal(memory.due(S),false)
  ingest('1',S,{receivedAt:clock});assert.equal(memory.due(S),false)
  ingest('2',S,{receivedAt:clock});assert.equal(memory.due(S),false)
  ingest('3',S,{receivedAt:clock});assert.equal(memory.due(S),true)
  await memory.consolidate({scope:S})
  clock+=2000;assert.equal(memory.due(S),false)
  ingest('4',S,{receivedAt:clock});assert.equal(memory.due(S),true)
})
test('bot replies and foreign account/chat evidence never reach the extractor',async t=>{
  const seen=[]
  const {memory,ingest}=fixture(t,{extract:async({messages})=>{seen.push(...messages);return {facts:[],summary:null}}})
  ingest('机器人猜测',S,{authorId:S.account,eventKind:'self'})
  ingest('另一个账号',{...S,account:'bot-b'})
  ingest('另一个群',{...S,chat:'group:202'})
  ingest('当事人说的话')
  const result=await memory.consolidate({scope:S})
  assert.equal(result.ok,true,result.message)
  assert.deepEqual(seen.map(m=>m.text),['当事人说的话'])
})
test('extraction evidence must belong to the current fragment and speaker',async t=>{
  let bad='outside'
  const {memory,ingest}=fixture(t,{extract:async({messages})=>({facts:[extracted(messages[0],bad==='outside'?{evidenceMessageIds:['invented']}:{speakerId:'impostor'})],summary:null})})
  ingest()
  assert.equal((await memory.consolidate({scope:S})).ok,false)
  bad='speaker'
  assert.equal((await memory.consolidate({scope:S})).ok,false)
  assert.equal(memory.status(S).recvSeq,0)
})
test('default memory role adapter executes real askModel parsing and validated dedup without a network',async t=>{
  const {storage,ingest}=fixture(t),seen=[]
  const dsh={get:()=>null,llm:{async *stream({system,messages}) {
    const input=JSON.parse(messages[0].content[0].text);seen.push({system,input})
    const response=system.includes('只做事实去重') ? input.facts.map(f=>({inputId:f.inputId,action:'keep'})) : {facts:input.messages.map(m=>extracted(m)),summary:null}
    yield {type:'text-delta',text:JSON.stringify(response)}
    yield {type:'finish',reason:{kind:'completed'}}
  }}}
  const memory=createMemoryStore({storage,dsh,getConfig:()=>({model:{provider:'test-provider',model:'test-model'},memory:{}})})
  ingest()
  const r=await memory.consolidate({scope:S})
  assert.equal(r.ok,true,r.message)
  assert.equal(seen.length,2)
  assert.ok(seen[1].input.candidates)
  assert.equal(memory.recall('咖啡',{scope:S}).length,1)
})
test('expired persisted lease can be resumed after a crash',async t=>{
  const {storage,memory,ingest}=fixture(t)
  ingest();memory.enqueue(S)
  storage.db.run("UPDATE memory_checkpoints SET state='running',lease_token='crashed-process',lease_until=1")
  const r=await memory.consolidate({scope:S})
  assert.equal(r.ok,true,r.message)
  assert.equal(memory.status(S).state,'idle')
  assert.equal(storage.db.get('SELECT lease_token FROM memory_checkpoints').lease_token,null)
})

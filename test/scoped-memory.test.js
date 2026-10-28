import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createStorage} from '../src/storage/index.js'
import {createMemoryStore,ensureSchema,validateDecisions} from '../src/features/memory.js'

const A={account:'bot-a',chat:'group:1',persona:'fish'}
const B={...A,chat:'group:2'}, C={...A,chat:'group:3'}
const meta=scope=>({scope,actorId:'admin',reason:'测试中明确复核'})
function fixture(t,options={}) {
  const dir=mkdtempSync(join(tmpdir(),'aurabot-scoped-memory-'))
  const storage=createStorage({file:join(dir,'test.sqlite'),filesDir:join(dir,'assets')})
  t.after(()=>{storage.close();rmSync(dir,{recursive:true,force:true})})
  let policy={shareGroups:[]}
  const memory=createMemoryStore({storage,getPolicy:()=>policy,...options})
  const message=(text,scope=A,speakerId='user')=>storage.messages.ingest({account:scope.account,chatId:scope.chat,authorId:speakerId,authorName:'小明',eventKind:'message',text,platformTime:Date.UTC(2026,9,28),segments:[]}).id
  const fact=(patch={},scope=A)=>{
    const text=patch.text || '小明喜欢咖啡',speakerId=patch.speakerId || 'user'
    return {...{scope,text,subject:'user',predicate:'likes',value:'咖啡',speakerId,polarity:'positive',modality:'asserted',conditions:[],eventTime:null,validFrom:null,validTo:null,status:'active',stability:'stable',slot:'multi',profileSection:'preferences'},
      evidenceMessageIds:[message(text,scope,speakerId)],...patch,scope}
  }
  return {storage,memory,message,fact,setPolicy:p=>{policy=p}}
}

test('domain schema is idempotent and facts persist without JSON files',t=>{
  const {storage,memory,fact}=fixture(t)
  const version=storage.db.get('PRAGMA user_version').user_version
  const f=memory.create(fact()).item
  ensureSchema(storage);ensureSchema(storage)
  assert.equal(storage.db.get('PRAGMA user_version').user_version,version)
  const reopened=createMemoryStore(storage)
  assert.equal(reopened.get(f.id,{scope:A}).value,'咖啡')
  assert.equal(f.evidence[0].speakerId,'user')
  assert.equal(f.evidence[0].snapshot.text,'小明喜欢咖啡')
  for(const k of ['subject','predicate','value','polarity','modality','conditions','eventTime','validFrom','validTo','status','stability','supersedes','speakerId','scope']) assert.ok(k in f,k)
})
test('all legacy global reads fail closed, and writes require scope and provenance',t=>{
  const {memory,fact}=fixture(t)
  memory.create(fact())
  for(const run of [()=>memory.list(''),()=>memory.recall('咖啡'),()=>memory.profileOf('user'),()=>memory.profiles(),()=>memory.recalls(),()=>memory.stats(),()=>memory.importCommit([{text:'旧事实'}])]) assert.throws(run,/scope|范围/)
  assert.equal(memory.contextFor({kind:'group',chatId:A.chat},'session'),'')
  assert.equal(memory.topicScore('咖啡'),0)
  assert.equal(memory.addEvent({text:'画图'}).ok,false)
  const noEvidence=fact();delete noEvidence.evidenceMessageIds
  assert.throws(()=>memory.create(noEvidence),/证据/)
})
test('account/chat/persona separation precedes ranking, sharing is explicit and category specific',async t=>{
  const {memory,fact,setPolicy}=fixture(t)
  const f=memory.create(fact()).item
  assert.equal(memory.recall('咖啡',{scope:B}).length,0)
  assert.equal(memory.recall('咖啡',{scope:{...A,account:'bot-b'}}).length,0)
  assert.equal(memory.recall('咖啡',{scope:{...A,persona:'cat'}}).length,0)
  assert.equal(memory.recall('咖啡',{scope:{...A,persona:''}}).length,0)
  setPolicy({shareGroups:[{id:'friends',chats:[A.chat,B.chat],categories:['fact']}]})
  assert.equal(memory.recall('咖啡',{scope:B})[0].it.id,f.id)
  assert.equal(await memory.buildProfile('user',{scope:B}),null,'fact sharing alone does not authorize profile sharing')
  setPolicy({shareGroups:[{id:'friends',account:'other',chats:[A.chat,B.chat],categories:['fact','profile']}]})
  assert.equal(memory.recall('咖啡',{scope:B}).length,0)
  assert.throws(()=>memory.remove(f.id,meta(B)),/范围/,'shared read does not grant write permission')
})
test('derived facts require the intersection of all evidence audiences',t=>{
  const {memory,fact,setPolicy}=fixture(t)
  setPolicy({shareGroups:[{id:'ab',chats:[A.chat,B.chat],categories:['fact']},{id:'bc',chats:[B.chat,C.chat],categories:['fact']}]})
  const first=memory.create(fact()).item
  const combined=memory.create(fact({value:'咖啡和茶',text:'小明喜欢咖啡和茶',evidenceIds:first.evidenceIds},B)).item
  assert.ok(memory.get(combined.id,{scope:B}))
  assert.equal(memory.get(combined.id,{scope:C}),null)
  assert.equal(memory.recall('咖啡',{scope:C}).length,0)
})
test('dedup validates complete decisions, allowlists, structure, and current-batch candidates',t=>{
  const {memory,fact}=fixture(t)
  const base=fact(),one={...base,inputId:'one'},two={...fact(),inputId:'two'}
  delete one.scope;delete two.scope
  const batch=memory.prepareBatch(A,[one,two])
  assert.ok(batch.candidates.two.some(c=>c.id==='batch:one'))
  const valid=[{inputId:'one',action:'keep'},{inputId:'two',action:'reuse',targetId:'batch:one'}]
  for(const decisions of [[],[valid[0],valid[0]],[valid[0],{inputId:'two',action:'reuse',targetId:'not-authorized'}],[valid[0],{inputId:'two',action:'possible_duplicate',candidateIds:[]}],[{...valid[0],surprise:1},valid[1]]]) {
    assert.throws(()=>memory.commitBatch(batch,decisions))
    assert.equal(memory.list({scope:A}).length,0)
  }
  const result=memory.commitBatch(batch,valid)
  assert.equal(result[0].id,result[1].id)
  const stored=memory.get(result[0].id,{scope:A})
  assert.equal(stored.evidence.length,2)
  assert.equal(memory.audit(stored.id,A).at(-1).action,'reuse')
  assert.equal(stored.text,base.text,'reuse appends evidence without rewriting fact text')
})
test('negation, speaker, numbers, unknown conditions and event time cannot be reused',t=>{
  const {memory,fact}=fixture(t)
  const old=memory.create(fact()).item
  for(const patch of [{polarity:'negative'},{speakerId:'someone-else'},{value:5},{conditions:null},{modality:'reported',stability:'uncertain'},{eventTime:123},{conditions:['今天']}]) {
    const f={...fact(patch),inputId:'x'};delete f.scope
    const batch=memory.prepareBatch(A,[f])
    assert.throws(()=>memory.commitBatch(batch,[{inputId:'x',action:'reuse',targetId:old.id}]),/reuse/)
  }
  assert.equal(memory.list({scope:A}).length,1)
})
test('possible_duplicate keeps independent evidence and target relationship',t=>{
  const {memory,fact}=fixture(t),old=memory.create(fact()).item
  const candidate={...fact({value:'拿铁',text:'小明喜欢拿铁'}),inputId:'x'};delete candidate.scope
  const batch=memory.prepareBatch(A,[candidate])
  const [result]=memory.commitBatch(batch,[{inputId:'x',action:'possible_duplicate',candidateIds:[old.id]}])
  assert.notEqual(result.id,old.id)
  assert.deepEqual(memory.get(result.id,{scope:A}).possibleDuplicates,[old.id])
})
test('conflicts stay parallel, reported claims do not supersede, corrections and withdrawals retain audit',t=>{
  const {memory,fact}=fixture(t)
  const first=memory.create(fact({predicate:'home',slot:'single',value:'上海'})).item
  const second=memory.create(fact({predicate:'home',slot:'single',value:'广州'})).item
  assert.equal(memory.get(first.id,{scope:A,includeInactive:true}).status,'conflicted')
  assert.equal(memory.get(second.id,{scope:A,includeInactive:true}).status,'conflicted')
  assert.equal(memory.recall('咖啡',{scope:A}).length,0)
  assert.equal(memory.recall('咖啡',{scope:A,includeUncertain:true}).length,2)
  const old=memory.get(first.id,{scope:A,includeInactive:true})
  assert.throws(()=>memory.correct(first.id,fact({predicate:'home',value:'北京',speakerId:'other',modality:'reported',stability:'uncertain'}),{...meta(A),expectedRevision:old.revision}),/转述/)
  const corrected=memory.correct(first.id,fact({predicate:'home',value:'北京'}),{...meta(A),expectedRevision:old.revision}).item
  assert.deepEqual(corrected.supersedes,[first.id])
  assert.equal(memory.get(first.id,{scope:A,includeInactive:true}).supersededBy,corrected.id)
  memory.retract(corrected.id,meta(A))
  assert.equal(memory.get(corrected.id,{scope:A}),null)
  const audit=memory.audit(first.id,A)
  assert.ok(audit.some(a=>a.action==='correct'&&a.before.value==='上海'&&a.after.status==='superseded'))
})
test('multi-valued preferences and different dates do not become conflicts',t=>{
  const {memory,fact}=fixture(t)
  const a=memory.create(fact({value:'咖啡'})).item,b=memory.create(fact({value:'茶'})).item
  const c=memory.create(fact({value:'咖啡',slot:'single',stability:'temporal',eventTime:1})).item,d=memory.create(fact({value:'茶',slot:'single',stability:'temporal',eventTime:2})).item
  for(const f of [a,b,c,d]) assert.equal(memory.get(f.id,{scope:A}).status,'active')
})
test('unknown legacy JSON and old backups only enter quarantine, repeat import is idempotent',t=>{
  const {memory,fact}=fixture(t)
  const payload={items:[{text:'私聊秘密',scope:{account:'bot-a',chat:'group:1'},status:'active'}],profiles:{user:'泄漏画像'}}
  const r=memory.quarantineImport(payload,{scope:A,sourceKey:'backup-1'})
  assert.deepEqual(memory.quarantineImport(payload,{scope:A,sourceKey:'backup-1'}).ids,r.ids)
  assert.equal(memory.quarantineList(B).length,0)
  assert.equal(memory.recall('秘密',{scope:A}).length,0)
  assert.throws(()=>memory.approveLegacy(r.ids[0],fact(),meta(A)),/审批/)
  const approved=memory.approveLegacy(r.ids[0],fact(),{...meta(A),approved:true})
  assert.equal(approved.item.source,'legacy-approved')
})
test('tombstones suppress late writes and sources; restore stays quarantined until separate approvals',t=>{
  const {memory,fact}=fixture(t),input=fact(),f=memory.create(input).item
  const batchInput={...input,inputId:'late'};delete batchInput.scope
  const batch=memory.prepareBatch(A,[batchInput])
  memory.remove(f.id,meta(A))
  assert.equal(memory.get(f.id,{scope:A,includeInactive:true}),null)
  assert.equal(memory.recentPending(A).length,0)
  assert.throws(()=>memory.commitBatch(batch,[{inputId:'late',action:'keep'}]),/变化/)
  assert.throws(()=>memory.create(input),/删除|遗忘/)
  assert.equal(memory.restore(f.id,meta(A)).status,'quarantined')
  assert.equal(memory.recall('咖啡',{scope:A}).length,0)
  assert.throws(()=>memory.approve(f.id,{...meta(A),approved:true}),/证据/)
  const evidence=memory.evidenceReview(f.id,A)[0]
  memory.approveEvidence(evidence.id,{...meta(A),approved:true,expectedRevision:evidence.revision})
  assert.equal(memory.recall('咖啡',{scope:A}).length,0,'evidence approval cannot publish the fact')
  memory.approve(f.id,{...meta(A),approved:true})
  assert.equal(memory.get(f.id,{scope:A}).id,f.id)
  assert.throws(()=>memory.create(input),/删除|遗忘/,'old extraction replay cannot use restored source')
})
test('raw evidence edits and recalls immediately hide derived facts, refresh requires review',t=>{
  const {storage,memory,fact}=fixture(t),f=memory.create(fact()).item
  storage.db.run('UPDATE messages SET text=? WHERE id=?','更正：不喜欢咖啡',f.evidenceMessageIds[0])
  assert.equal(memory.get(f.id,{scope:A}),null)
  memory.refreshEvidence(f.evidenceIds[0],meta(A))
  assert.equal(memory.reviewList(A)[0].status,'quarantined')
  assert.equal(memory.recall('咖啡',{scope:A}).length,0)
  storage.db.run('UPDATE messages SET recalled_at=? WHERE id=?',Date.now(),f.evidenceMessageIds[0])
  assert.throws(()=>memory.approve(f.id,{...meta(A),approved:true}),/证据/)
})
test('events require explicit scope and successful receipt, and preserve account/persona boundaries',t=>{
  const {memory}=fixture(t)
  assert.equal(memory.addEvent({scope:A,text:'画了咖啡图'}).ok,false)
  const r=memory.addEvent({scope:A,text:'画了咖啡图',confirmed:true,sourceId:'delivery-1',eventTime:Date.now()})
  assert.equal(r.ok,true)
  assert.equal(memory.recentEvents({scope:A})[0].id,r.id)
  assert.deepEqual(memory.recentEvents({scope:B}),[])
  assert.deepEqual(memory.recentEvents({scope:{...A,persona:'cat'}}),[])
  assert.equal(memory.addEvent({scope:A,text:'画了咖啡图',confirmed:true,sourceId:'delivery-1'}).id,r.id,'receipt replay reuses original event time')
})
test('index integration rechecks ID visibility; shared revisions and revocations alter visibility stamp',t=>{
  const {memory,fact,setPolicy}=fixture(t),f=memory.create(fact()).item
  setPolicy({shareGroups:[{id:'shared',chats:[A.chat,B.chat],categories:['fact']}]})
  const before=memory.visibilityStamp(B),revision=memory.revision(A)
  assert.equal(memory.getFactsByIds([f.id],{scope:B})[0].id,f.id)
  memory.update(f.id,{text:'现在喜欢茶',value:'茶'},{...meta(A),expectedRevision:f.revision,manualEvidence:{kind:'manual',text:'更正原话',speakerId:'user',actorId:'admin'}})
  assert.ok(memory.revision(A)>revision)
  assert.notEqual(memory.visibilityStamp(B),before)
  const after=memory.visibilityStamp(B)
  setPolicy({shareGroups:[]})
  assert.notEqual(memory.visibilityStamp(B),after)
  assert.deepEqual(memory.getFactsByIds([f.id],{scope:B}),[])
  memory.remove(f.id,meta(A))
  assert.deepEqual(memory.getFactsByIds([f.id],{scope:A,includeInactive:true}),[])
  assert.throws(()=>memory.getFactsByIds([f.id]),/scope/)
})
test('message and content tombstones cannot be bypassed by a changed persona or duplicate row',t=>{
  const {memory,fact}=fixture(t),general={...A,persona:''},specific={...A,persona:'fish'}
  const firstInput=fact({},general),first=memory.create(firstInput).item
  const duplicate=memory.create(fact({},general)).item
  const mirrored=memory.create({...firstInput,scope:specific}).item
  memory.remove(first.id,meta(general))
  assert.equal(memory.get(duplicate.id,{scope:general}),null)
  assert.equal(memory.get(mirrored.id,{scope:specific}),null)
  assert.throws(()=>memory.create({...firstInput,scope:specific}),/删除|遗忘/)
  assert.throws(()=>memory.create(fact({},specific)),/删除|遗忘/)
  assert.equal(memory.recentPending(specific).some(m=>m.id===first.evidenceMessageIds[0]),false)
})

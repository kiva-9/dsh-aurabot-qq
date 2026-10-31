import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync,statSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createStorage} from '../src/storage/index.js'
import {createMemoryStore} from '../src/features/memory.js'
import memoryModule from '../src/modules/memory/index.js'
import { deferred, settled } from './helpers/wp6.js'

const S={account:'bot',chat:'group:1',persona:''}
const payload=(patch={})=>({scope:S,text:'小明喜欢咖啡',subject:'user',predicate:'likes',value:'咖啡',speakerId:'user',polarity:'positive',modality:'asserted',conditions:[],eventTime:null,validFrom:null,validTo:null,stability:'stable',
  manualEvidence:{kind:'manual',text:'原话是喜欢咖啡',speakerId:'user',actorId:'admin'},...patch})
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'aurabot-memory-module-'))
  const storage=createStorage({file:join(dir,'test.sqlite'),filesDir:join(dir,'assets')})
  t.after(()=>{storage.close();rmSync(dir,{recursive:true,force:true})})
  const routes=new Map(),contexts=[],tools=[],timers=[],events=new Map()
  const hub={selfId:'bot',turnPersona:()=>({personaId:'fish'}),lastTextOf:()=> '咖啡',prevTextOf:()=>'',speakersOf:()=>['user'],
    chatLogDays:()=>{throw new Error('must never read old chat logs')},deleteChatLog:()=>{throw new Error('must never delete chat logs')}}
  const api={core:{storage,hub,http:{query:req=>req,body:async req=>req}},config:()=>({memory:{enabled:true}}),dsh:{},log:{warn(){}},
    route:(p,h)=>routes.set(p,h),context:f=>contexts.push(f),tool:f=>tools.push(f),every:(_ms,f)=>timers.push(f),on:(event,fn)=>events.set(event,fn)}
  return {storage,dir,routes,contexts,tools,timers,events,api,hub}
}
test('module tab and reload list use exact existing files; API rejects missing scopes',async t=>{
  const f=fixture(t);memoryModule.setup(f.api)
  assert.equal(memoryModule.tab,'memory')
  for(const file of memoryModule.files) assert.equal(statSync(resolve('src',file)).isFile(),true,file)
  assert.equal((await f.routes.get('/memories')({})).code,'SCOPE_REQUIRED')
  assert.equal((await f.routes.get('/profiles')({})).code,'SCOPE_REQUIRED')
  assert.equal((await f.routes.get('/memory/add')({text:'不带范围'})).ok,false)
})

test('memory config hook cancels revoked event snapshots and exposes an explicit POST-only resume',async t=>{
  const f=fixture(t),entered=deferred(),late=deferred(),events=new Map(),params=[]
  const cfg={enabled:true,botQQ:'bot',allow:{groups:['1']},model:{provider:'mock',model:'offline'},memory:{enabled:true,extraction:{minMessages:1}}}
  f.api.config=()=>cfg;f.api.on=(event,fn)=>events.set(event,fn)
  f.api.dsh={llm:{stream:async function*(args){params.push(args);entered.resolve();await late.promise;yield {type:'text-delta',text:'{"facts":[],"summary":null}'};yield {type:'finish',reason:'stop'}}}}
  const memory=memoryModule.setup(f.api)
  f.storage.messages.ingest({account:S.account,chatId:S.chat,authorId:'alice',eventKind:'message',text:'喜欢喝茶'})
  memory.enqueue(S)
  const job=f.timers[0]();await entered.promise
  const revoked=structuredClone(cfg);revoked.allow.groups=[]
  events.get('config')(revoked)
  await job;assert.equal(params[0].signal.aborted,true)
  assert.equal(memory.status(S).recvSeq,0)
  late.resolve();await settled()
  cfg.allow.groups=[];await f.timers[0]();assert.equal(params.length,1)
  const resume=f.routes.get('/memory/extraction/resume')
  assert.equal((await resume({method:'GET',scope:S})).code,'METHOD_NOT_ALLOWED')
  assert.equal((await resume({method:'POST',scope:S})).code,'SCOPE_DISABLED')
  cfg.allow.groups=['1'];assert.equal((await resume({method:'POST',scope:S})).ok,true)
  await memory.stop()
})
test('panel create/edit/evidence/audit API preserves scope and revision contracts',async t=>{
  const f=fixture(t);memoryModule.setup(f.api)
  const created=await f.routes.get('/memory/add')(payload())
  assert.equal(created.ok,true,created.message)
  assert.deepEqual(created.scope,S)
  const list=await f.routes.get('/memories')(S)
  assert.equal(list.items[0].id,created.id)
  assert.equal(list.account,S.account)
  assert.equal(list.chat,S.chat)
  const changed=await f.routes.get('/memory/update')({scope:S,id:created.id,expectedRevision:created.item.revision,actorId:'admin',reason:'更正',patch:{value:'茶',text:'小明喜欢茶'},
    manualEvidence:{kind:'manual',text:'确认新说法为喜欢茶',speakerId:'user',actorId:'admin'}})
  assert.equal(changed.ok,true,changed.message)
  assert.equal(changed.item.value,'茶')
  assert.equal((await f.routes.get('/memory/evidence')({...S,id:created.id})).items.length,2)
  assert.equal((await f.routes.get('/memory/audit')({...S,id:created.id})).items.at(-1).action,'edit')
  assert.equal((await f.routes.get('/memory/delete')({scope:S,id:created.id,actorId:'admin',reason:'删除'})).ok,true)
  assert.equal((await f.routes.get('/memories')(S)).items.length,0)
})
test('hub turnPersona scopes profiles, while tool writes and extraction scopes stay persona-independent',async t=>{
  const f=fixture(t),memory=memoryModule.setup(f.api)
  memory.create(payload())
  await memory.buildProfile('user',{scope:{...S,persona:'fish'}})
  const args={chat:{kind:'group',chatId:S.chat,userId:'user'},sessionId:'s1'}
  assert.equal(f.contexts[0](args),'')
  assert.match(f.events.get('prompt/prepared')([{type:'text',text:'原文'}],args)[0].text,/咖啡/)
  assert.deepEqual(memory.registeredScopes(),[S])
  const message=f.storage.messages.ingest({account:S.account,chatId:S.chat,eventKind:'message',authorId:'user',text:'我喜欢茶',segments:[]})
  f.hub.turnActor=()=>({actorId:'user',requestId:'request1'})
  f.hub.turnRequests=()=>[{id:'request1',actorId:'user',sourceMessageIds:[message.id]}]
  const remember=f.tools[0](args).find(t=>t.name==='remember')
  const input=payload({text:'小明喜欢茶',value:'茶'});delete input.scope;delete input.manualEvidence;delete input.speakerId
  const result=await remember.execute(input)
  assert.equal(result.ok,true,result.message)
  assert.equal(result.scope.persona,'')
  assert.equal(result.item.speakerId,'user')
  assert.deepEqual(result.item.evidenceMessageIds,[message.id])
  f.hub.turnRequests=()=>[{id:'request1',actorId:'user',sourceMessageIds:['fabricated']}]
  assert.equal((await remember.execute(input)).code,'EVIDENCE_REQUIRED')
})
test('legacy file at root and legacy directory imports once to unassigned quarantine without rewriting sources',async t=>{
  const f=fixture(t)
  mkdirSync(join(f.dir,'legacy'))
  const root=join(f.dir,'memories.json'),legacy=join(f.dir,'legacy','memories.json')
  const original=JSON.stringify({items:[{text:'私聊秘密',about:'user'}],profiles:{user:{text:'旧画像'}},styles:{self:['旧口头禅']}})
  writeFileSync(root,original);writeFileSync(legacy,JSON.stringify([{text:'旧备份'}]))
  const memory=memoryModule.setup(f.api)
  assert.equal(memory.list({scope:S}).length,0)
  assert.equal(memory.recall('秘密',{scope:S}).length,0)
  assert.throws(()=>memory.unassignedQuarantine({scope:S}),/显式/)
  const view=await f.routes.get('/memory/quarantine')({...S,includeUnassigned:'true'})
  assert.equal(view.unassigned.length,4)
  for(const row of view.unassigned) assert.equal(row.scope,null)
  assert.equal(readFileSync(root,'utf8'),original)
  const restarted=createMemoryStore({storage:f.storage})
  assert.equal(restarted.unassignedQuarantine({scope:S,includeUnassigned:true}).length,4)
  assert.equal(restarted.legacyStatus().length,2)
  assert.ok(restarted.legacyStatus().every(r=>r.state==='done'))
  const qid=view.unassigned[0].id
  const rejected=await f.routes.get('/memory/quarantine/approve')({scope:S,id:qid,actorId:'admin',reason:'核查',fact:payload()})
  assert.equal(rejected.ok,false)
  const approved=await f.routes.get('/memory/quarantine/approve')({scope:S,id:qid,actorId:'admin',reason:'已核对来源与范围',approved:true,fact:payload()})
  assert.equal(approved.ok,true,approved.message)
  assert.equal(approved.item.source,'legacy-approved')
  assert.equal(memory.unassignedQuarantine({scope:S,includeUnassigned:true}).length,3)
  assert.equal(memory.quarantineList(S).length,1)
})
test('invalid legacy JSON reports pending and retries successfully; no imported partial facts',t=>{
  const f=fixture(t),file=join(f.dir,'memories.json')
  writeFileSync(file,'{bad json')
  const memory=createMemoryStore({storage:f.storage})
  assert.equal(memory.legacyStatus()[0].state,'pending')
  assert.equal(memory.unassignedQuarantine({scope:S,includeUnassigned:true}).length,0)
  writeFileSync(file,JSON.stringify({items:[{text:'修复文件后仍保持隔离'}]}))
  const retry=createMemoryStore({storage:f.storage})
  assert.equal(retry.legacyStatus()[0].state,'done')
  assert.equal(retry.unassignedQuarantine({scope:S,includeUnassigned:true}).length,1)
  assert.equal(retry.list({scope:S}).length,0)
})
test('profile override GET supplies a usable revision without creating a profile',async t=>{
  const f=fixture(t);memoryModule.setup(f.api)
  const r=await f.routes.get('/profiles/override')({...S,persona:'fish',subject:'user'})
  assert.equal(r.ok,true)
  assert.deepEqual(r.override,{aliases:[],entries:[],revision:0})
  assert.equal(r.scope.persona,'fish')
})

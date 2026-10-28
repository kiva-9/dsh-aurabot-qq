import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createStorage} from '../src/storage/index.js'
import {createMemoryStore} from '../src/features/memory.js'

const S={account:'bot',chat:'group:1',persona:'fish'},F={...S,persona:''}
const gate=()=>{let release;const promise=new Promise(r=>{release=r});return{promise,release}}
function fixture(t,options={}) {
  const dir=mkdtempSync(join(tmpdir(),'aurabot-profiles-'))
  const storage=createStorage({file:join(dir,'test.sqlite'),filesDir:join(dir,'assets')})
  t.after(()=>{storage.close();rmSync(dir,{recursive:true,force:true})})
  const memory=createMemoryStore({storage,...options})
  const add=(patch={},scope=F)=>memory.create({scope,text:'小明喜欢咖啡',subject:'user',predicate:'likes',value:'咖啡',speakerId:'user',polarity:'positive',modality:'asserted',conditions:[],eventTime:null,validFrom:null,validTo:null,stability:'stable',profileSection:'preferences',
    manualEvidence:{kind:'manual',text:'小明明确说喜欢咖啡',speakerId:'user',actorId:'admin'},...patch}).item
  return {storage,memory,add}
}
test('six profile sections have evidence; general facts feed persona-specific profiles',async t=>{
  const {memory,add}=fixture(t)
  for(const section of ['identity','relationships','stableFacts','preferences']) add({profileSection:section,predicate:section})
  add({profileSection:'recentInteractions',stability:'temporal',eventTime:Date.now()})
  add({profileSection:'uncertain',modality:'joke',stability:'uncertain',text:'开玩笑说自己来自火星'})
  const profile=await memory.buildProfile('user',{scope:S,includeUncertain:true})
  assert.equal(Object.keys(profile.sections).length,6)
  for(const items of Object.values(profile.sections)) {assert.equal(items.length,1);assert.ok(items[0].evidenceIds.length)}
  assert.doesNotMatch(memory.profileOf('user',{scope:S}).text,/火星/)
  assert.match(memory.profileOf('user',{scope:S,includeUncertain:true}).text,/火星/)
  assert.equal(memory.profileOf('user',{scope:{...S,persona:'cat'}}),null)
  assert.equal(memory.profileOf('user',{scope:{...S,chat:'group:2'}}),null)
})
test('same IDs/count with edited fact content invalidates the fingerprint and cached text',async t=>{
  const {memory,add}=fixture(t),f=add()
  const before=await memory.buildProfile('user',{scope:S})
  memory.update(f.id,{text:'小明喜欢茶',value:'茶'},{scope:F,actorId:'admin',reason:'核实更正',expectedRevision:f.revision,
    manualEvidence:{kind:'manual',text:'更正原话：现在喜欢茶',speakerId:'user',actorId:'admin'}})
  assert.equal(memory.profileOf('user',{scope:S}),null)
  const after=await memory.buildProfile('user',{scope:S})
  assert.notEqual(after.fingerprint,before.fingerprint)
  assert.match(after.text,/喜欢茶/)
  assert.equal(memory.list({scope:F}).length,1)
})
test('raw evidence same-ID edits invalidate immediately, before any TTL or rebuild',async t=>{
  const {storage,memory}=fixture(t)
  const m=storage.messages.ingest({account:F.account,chatId:F.chat,authorId:'user',eventKind:'message',text:'喜欢咖啡',segments:[]})
  memory.create({scope:F,text:'小明喜欢咖啡',subject:'user',predicate:'likes',value:'咖啡',speakerId:'user',polarity:'positive',modality:'asserted',conditions:[],eventTime:null,validFrom:null,validTo:null,stability:'stable',evidenceMessageIds:[m.id]})
  assert.ok(await memory.buildProfile('user',{scope:S}))
  storage.db.run('UPDATE messages SET text=? WHERE id=?','不喜欢咖啡',m.id)
  assert.equal(memory.profileOf('user',{scope:S}),null)
  assert.equal(await memory.buildProfile('user',{scope:S}),null)
})
test('shared policy revocation and validity expiry invalidate profiles without another write',async t=>{
  let now=1000,policy={shareGroups:[{id:'g',chats:['group:1','group:2'],categories:['fact','profile']}]}
  const {memory,add}=fixture(t,{now:()=>now,getPolicy:()=>policy})
  add({validTo:2000})
  const shared={...S,chat:'group:2'}
  assert.ok(await memory.buildProfile('user',{scope:shared}))
  policy={shareGroups:[]}
  assert.equal(memory.profileOf('user',{scope:shared}),null)
  assert.ok(await memory.buildProfile('user',{scope:S}))
  now=2000
  assert.equal(memory.profileOf('user',{scope:S}),null)
  assert.equal(memory.recall('咖啡',{scope:S}).length,0)
})
test('unchanged inputs share one rebuild and unrelated people or retrieval scores do not invalidate',async t=>{
  const entered=gate(),resume=gate();let calls=0
  const {memory,add}=fixture(t,{generateProfile:async({facts})=>{calls++;entered.release();await resume.promise;return {preferences:[{text:facts[0].text,factIds:[facts[0].id]}]}}})
  add()
  const first=memory.buildProfile('user',{scope:S});await entered.promise
  const second=memory.buildProfile('user',{scope:S})
  assert.equal(first,second)
  resume.release();const profile=await first
  memory.recall('咖啡',{scope:S})
  add({subject:'another',speakerId:'another',manualEvidence:{kind:'manual',text:'另一个人的话',speakerId:'another',actorId:'admin'}})
  assert.equal((await memory.buildProfile('user',{scope:S})).fingerprint,profile.fingerprint)
  assert.equal(calls,1)
})
test('in-flight profile generation cannot resurrect removed evidence or changed permissions',async t=>{
  const entered=gate(),resume=gate()
  const {memory,add}=fixture(t,{generateProfile:async({facts})=>{entered.release();await resume.promise;return {preferences:[{text:facts[0].text,factIds:[facts[0].id]}]}}})
  const f=add(),job=memory.buildProfile('user',{scope:S});await entered.promise
  memory.remove(f.id,{scope:F,actorId:'admin',reason:'删除'})
  resume.release()
  await assert.rejects(job,/变化/)
  assert.equal(memory.profileOf('user',{scope:S}),null)
})
test('manual aliases/overrides and generator/template revisions are in the fingerprint',async t=>{
  let cfg={memory:{profiles:{modelVersion:'model-1',templateVersion:'template-1'}}}
  const {memory,add}=fixture(t,{getConfig:()=>cfg}),f=add()
  const original=await memory.buildProfile('user',{scope:S})
  memory.setOverrides('user',{aliases:['小明'],entries:[{section:'preferences',text:'人工确认：喜欢咖啡',factIds:[f.id]}]},
    {scope:S,actorId:'admin',reason:'确认称呼',expectedRevision:0})
  const edited=await memory.buildProfile('user',{scope:S})
  assert.notEqual(edited.fingerprint,original.fingerprint)
  assert.equal(edited.sections.preferences[0].manual,true)
  assert.deepEqual(edited.aliases,['小明'])
  cfg={memory:{profiles:{modelVersion:'model-2',templateVersion:'template-2'}}}
  assert.equal(memory.profileOf('user',{scope:S}),null)
  const rebuilt=await memory.buildProfile('user',{scope:S})
  assert.match(rebuilt.text,/人工确认/)
  assert.notEqual(rebuilt.fingerprint,edited.fingerprint)
})
test('generator cannot upgrade plans, jokes or inferred material into stable facts',async t=>{
  const {memory,add}=fixture(t,{generateProfile:async({facts})=>({stableFacts:[{text:'小明永远喜欢咖啡',factIds:[facts[0].id]}]})})
  add({modality:'plan',stability:'temporal',eventTime:Date.now()})
  await assert.rejects(memory.buildProfile('user',{scope:S}),/不能/)
  assert.equal(memory.profileOf('user',{scope:S}),null)
})
test('scope changes invalidate both origin and shared audience caches',async t=>{
  const {memory,add}=fixture(t),f=add()
  assert.ok(await memory.buildProfile('user',{scope:S}))
  memory.changeScope(f.id,{...F,persona:'cat'},{scope:F,actorId:'admin',reason:'只限另一角色',expectedRevision:f.revision})
  assert.equal(memory.profileOf('user',{scope:S}),null)
  assert.equal(memory.recall('咖啡',{scope:S}).length,0)
})
test('own override revision is editable, but stale or deleted evidence text is not exposed',async t=>{
  const {memory,add}=fixture(t),f=add()
  assert.deepEqual(memory.getOverrides('user',{scope:S}).override,{aliases:[],entries:[],revision:0})
  memory.setOverrides('user',{aliases:['小明'],entries:[{section:'preferences',text:'人工私密旧资料',factIds:[f.id]}]},
    {scope:S,actorId:'admin',reason:'确认',expectedRevision:0})
  const profile=await memory.buildProfile('user',{scope:S})
  assert.equal(profile.override.revision,1)
  assert.equal(profile.override.entries[0].text,'人工私密旧资料')
  assert.equal(memory.getOverrides('user',{scope:{...S,chat:'group:other'}}).override.revision,0)
  memory.update(f.id,{text:'新资料',value:'茶'},{scope:F,actorId:'admin',reason:'显式更正',expectedRevision:f.revision,
    manualEvidence:{kind:'manual',text:'核实新资料',speakerId:'user',actorId:'admin'}})
  const edited=memory.getOverrides('user',{scope:S}).override
  assert.equal(edited.revision,1)
  assert.deepEqual(edited.entries,[])
  const rebuilt=await memory.buildProfile('user',{scope:S})
  assert.doesNotMatch(JSON.stringify(rebuilt),/人工私密旧资料/)
  memory.remove(f.id,{scope:F,actorId:'admin',reason:'删除'})
  assert.deepEqual(memory.getOverrides('user',{scope:S}).override,{aliases:[],entries:[],revision:1})
})

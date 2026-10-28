import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createStorage} from '../src/storage/index.js'
import {createMemoryStore} from '../src/features/memory.js'

const S={account:'bot',chat:'group:1',persona:'fish'}
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'aurabot-memory-query-'))
  const storage=createStorage({file:join(dir,'test.sqlite'),filesDir:join(dir,'assets')})
  t.after(()=>{storage.close();rmSync(dir,{recursive:true,force:true})})
  let clock=Date.UTC(2026,9,28),policy={shareGroups:[]}
  const memory=createMemoryStore({storage,now:()=>clock,getPolicy:()=>policy})
  const add=(n,scope=S,patch={})=>{
    clock++
    return memory.create({scope,text:`用户${n}喜欢咖啡`,subject:`user-${n}`,predicate:'likes',value:'咖啡',speakerId:`user-${n}`,polarity:'positive',modality:'asserted',conditions:[],eventTime:null,validFrom:null,validTo:null,stability:'stable',
      manualEvidence:{kind:'manual',text:`用户${n}确认喜欢咖啡`,speakerId:`user-${n}`,actorId:'admin'},...patch}).item
  }
  return {storage,memory,add,setPolicy:p=>{policy=p},setTime:t=>{clock=t}}
}
test('SQL prefilters account/chat/category/persona/status/subject and uses a scoped index',t=>{
  const {storage,memory,add}=fixture(t)
  const own=add(1)
  add(1,{...S,chat:'group:elsewhere'});add(1,{...S,account:'other'});add(1,{...S,persona:'cat'});add(2)
  const original=storage.db.all,queries=[]
  storage.db.all=(sql,...params)=>{const rows=original(sql,...params);queries.push({sql,params,rows:rows.length});return rows}
  const result=memory.page(S,{subject:'user-1',category:'fact',limit:2})
  assert.deepEqual(result.items.map(f=>f.id),[own.id])
  const q=queries.find(q=>q.sql.includes('AS sort_time'))
  for(const part of ['account=?','chat IN','category IN','persona IN','status IN',"json_extract(body,'$.subject')=?",'LIMIT ?']) assert.ok(q.sql.includes(part),part)
  assert.equal(q.rows,1)
  assert.equal(q.params.at(-1),3)
  const plan=original('EXPLAIN QUERY PLAN '+q.sql,...q.params).map(r=>r.detail).join('\n')
  assert.match(plan,/SEARCH memory_facts .*account=\? AND chat=\?/)
  assert.doesNotMatch(plan,/SCAN memory_facts/)
  const lookup=original('EXPLAIN QUERY PLAN SELECT body FROM memory_facts WHERE account=? AND id IN (?,?,?,?,?,?,?,?)',S.account,...Array(8).fill(own.id)).map(r=>r.detail).join('\n')
  assert.match(lookup,/account=\? AND id=\?/,'ranked ID lookups must not scan the account index')
})
test('cursor pages enumerate tied timestamps without duplicates and reject changed scope/policy',t=>{
  const {memory,add,setPolicy}=fixture(t)
  const expected=Array.from({length:7},(_,i)=>add(i).id),seen=[]
  let cursor
  do {const p=memory.page(S,{cursor,limit:2});seen.push(...p.items.map(f=>f.id));cursor=p.nextCursor} while(cursor)
  assert.equal(new Set(seen).size,7)
  assert.deepEqual([...seen].sort(),expected.sort())
  const first=memory.page(S,{limit:2})
  assert.throws(()=>memory.page({...S,chat:'group:other'},{cursor:first.nextCursor,limit:2}),error=>error.code==='INVALID_CURSOR')
  add(8)
  assert.throws(()=>memory.page(S,{cursor:first.nextCursor,limit:2}),error=>error.code==='STALE_CURSOR')
  const again=memory.page(S,{limit:2})
  setPolicy({shareGroups:[{id:'shared',chats:[S.chat,'group:2'],categories:['fact']}]})
  assert.throws(()=>memory.page(S,{cursor:again.nextCursor,limit:2}),error=>error.code==='STALE_CURSOR')
})
test('bounded candidate pages preserve source intersection and can advance past entirely invisible pages',t=>{
  const {storage,memory,add}=fixture(t),old=add(0)
  for(let n=1;n<6;n++) {
    const f=add(n)
    storage.db.run('UPDATE memory_evidence SET deleted_at=1,body=json_set(body,\'$.deletedAt\',1) WHERE id=?',f.evidenceIds[0])
  }
  let cursor,scanned=0,items=[]
  const first=memory.page(S,{limit:2})
  assert.equal(first.items.length,0)
  assert.ok(first.nextCursor)
  do {const p=memory.page(S,{cursor,limit:2});scanned+=p.scanned;items.push(...p.items);cursor=p.nextCursor} while(cursor)
  assert.equal(scanned,6)
  assert.deepEqual(items.map(f=>f.id),[old.id])
})
test('list(scope, options) honors its limit and evidence validation performs bounded batch queries',t=>{
  const {storage,memory,add}=fixture(t)
  for(let n=0;n<50;n++) add(n)
  let gets=0,alls=0
  const get=storage.db.get,all=storage.db.all
  storage.db.get=(...args)=>{gets++;return get(...args)}
  storage.db.all=(...args)=>{alls++;return all(...args)}
  assert.equal(memory.list(S,{limit:12}).length,12)
  assert.ok(gets<=2,`get queries: ${gets}`)
  assert.ok(alls<15,`all queries: ${alls}`)
  assert.equal(memory.list({scope:S,limit:3}).length,3)
})
test('lexical cache reuses tokenization, but source revisions, scope changes and time boundaries invalidate it',t=>{
  const {storage,memory,add,setPolicy,setTime}=fixture(t),f=add(1)
  assert.equal(memory.recall('咖啡',{scope:S}).length,1)
  const first=memory.lexicalCacheStats()
  const all=storage.db.all;let fetchedPages=0
  storage.db.all=(sql,...args)=>{if(sql.includes('AS sort_time'))fetchedPages++;return all(sql,...args)}
  memory.recall('用户喜欢什么',{scope:S})
  assert.equal(memory.lexicalCacheStats().builds,first.builds)
  assert.equal(fetchedPages,0,'warm queries never rebuild the scoped corpus')
  memory.update(f.id,{text:'用户喜欢茶',value:'茶'},{scope:S,expectedRevision:f.revision,actorId:'admin',reason:'更正',manualEvidence:{kind:'manual',text:'确认茶',speakerId:'user-1',actorId:'admin'}})
  assert.equal(memory.recall('咖啡',{scope:S}).length,0)
  assert.ok(memory.lexicalCacheStats().builds>first.builds)
  add(2,S,{validFrom:Date.UTC(2026,9,29),validTo:Date.UTC(2026,9,30)})
  assert.equal(memory.recall('咖啡',{scope:S}).length,0)
  setTime(Date.UTC(2026,9,29));assert.equal(memory.recall('咖啡',{scope:S}).length,1)
  setTime(Date.UTC(2026,9,30));assert.equal(memory.recall('咖啡',{scope:S}).length,0)
  const other={...S,chat:'group:2'};add(3,other)
  setPolicy({shareGroups:[{id:'share',chats:[S.chat,other.chat],categories:['fact']}]})
  assert.equal(memory.recall('咖啡',{scope:S}).length,1)
  setPolicy({shareGroups:[]});assert.equal(memory.recall('咖啡',{scope:S}).length,0)
})
test('host message edits advance visibility revisions and invalidate warm source caches',t=>{
  const {storage,memory}=fixture(t)
  const m=storage.messages.ingest({account:S.account,chatId:S.chat,authorId:'u',eventKind:'message',text:'喜欢咖啡',segments:[]})
  memory.create({scope:S,text:'喜欢咖啡',subject:'u',predicate:'likes',value:'咖啡',speakerId:'u',polarity:'positive',modality:'asserted',conditions:[],eventTime:null,validFrom:null,validTo:null,stability:'stable',evidenceMessageIds:[m.id]})
  memory.recall('咖啡',{scope:S});const stamp=memory.visibilityStamp(S)
  storage.db.run('UPDATE messages SET text=? WHERE id=?','不喜欢咖啡',m.id)
  assert.notEqual(memory.visibilityStamp(S),stamp)
  assert.equal(memory.recall('咖啡',{scope:S}).length,0)
})

test('a lexical read inside a rolled-back transaction cannot poison a reused revision',t=>{
  const {storage,memory,add}=fixture(t)
  add(1)
  assert.equal(memory.recall('咖啡',{scope:S}).length,1)
  const before=memory.lexicalCacheStats()
  assert.throws(()=>storage.tx(()=>{
    add(2)
    assert.equal(memory.recall('咖啡',{scope:S}).length,2)
    throw new Error('rollback')
  }),/rollback/)
  assert.equal(memory.lexicalCacheStats().documents,before.documents)
  const f=add(3,S,{text:'用户3喜欢茶',value:'茶'})
  assert.equal(memory.recall('咖啡',{scope:S}).length,1)
  assert.equal(memory.recall('喜欢茶',{scope:S})[0].it.id,f.id)
})

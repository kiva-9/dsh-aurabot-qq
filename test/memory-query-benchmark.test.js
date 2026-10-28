import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {performance} from 'node:perf_hooks'
import {createStorage} from '../src/storage/index.js'
import {createMemoryStore} from '../src/features/memory.js'
import {factFingerprint} from '../src/memory/contracts.js'

test('100k synthetic SQLite facts: bounded scope pages and warm lexical lookup',{skip:process.env.AURABOT_MEMORY_BENCH!=='1'},t=>{
  const dir=mkdtempSync(join(tmpdir(),'aurabot-memory-100k-'))
  const storage=createStorage({file:join(dir,'bench.sqlite'),filesDir:join(dir,'assets')}),base=Date.UTC(2026,9,28)
  t.after(()=>{storage.close();rmSync(dir,{recursive:true,force:true})})
  const memory=createMemoryStore({storage,now:()=>base+100001}),scope={account:'bench',chat:'group:target',persona:''}
  const seeded=performance.now()
  storage.tx(()=>{
    for(let n=0;n<100000;n++) {
      const id='f'+String(n).padStart(6,'0'),eid='e'+String(n).padStart(6,'0'),origin={...scope,chat:n<5000?scope.chat:`group:other-${n%95}`}
      const f={id,scope:origin,category:'fact',text:`用户${n}喜欢咖啡`,subject:`u${n%100}`,predicate:'likes',value:`咖啡${n}`,speakerId:`u${n%100}`,
        polarity:'positive',modality:'asserted',conditions:[],eventTime:null,validFrom:null,validTo:null,status:'active',stability:'stable',slot:'multi',
        tags:[],importance:0.5,supersedes:[],revision:1,createdAt:base+n,updatedAt:base+n}
      const e={id:eid,scope:origin,kind:'manual',messageId:null,speakerId:f.speakerId,text:f.text,eventTime:base+n,revision:1,contentHash:`manual-${n}`}
      storage.db.run('INSERT INTO memory_facts(id,account,chat,persona,category,body,revision,status,fingerprint,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',id,origin.account,origin.chat,'','fact',JSON.stringify(f),1,'active',factFingerprint(f),f.createdAt,f.updatedAt)
      storage.db.run('INSERT INTO memory_evidence(id,account,chat,persona,message_id,body,revision) VALUES (?,?,?,?,?,?,?)',eid,origin.account,origin.chat,'',null,JSON.stringify(e),1)
      storage.db.run('INSERT INTO memory_fact_evidence(fact_id,evidence_id) VALUES (?,?)',id,eid)
    }
  })
  const seedMs=performance.now()-seeded,all=storage.db.all,get=storage.db.get
  let fetched=0,allQueries=0,getQueries=0
  storage.db.all=(sql,...args)=>{const rows=all(sql,...args);allQueries++;if(sql.includes('AS sort_time'))fetched+=rows.length;return rows}
  storage.db.get=(...args)=>{getQueries++;return get(...args)}
  let started=performance.now();const listed=memory.list(scope,{limit:5000}),listMs=performance.now()-started
  assert.equal(listed.length,5000);assert.ok(listed.every(f=>f.scope.chat===scope.chat))
  assert.ok(fetched<=5010,`candidate rows: ${fetched}`)
  assert.ok(getQueries<=12,`per-record get queries: ${getQueries}`)
  const listQueries={all:allQueries,get:getQueries,candidateRows:fetched}
  // Every synthetic record shares these tokens, so BM25 IDF is intentionally
  // tiny. This measures lookup work, not the default relevance cutoff.
  started=performance.now();assert.equal(memory.recall('喜欢咖啡',{scope,limit:8,minScore:0}).length,8);const coldMs=performance.now()-started
  const before=memory.lexicalCacheStats(),warm=[];fetched=0
  for(let i=0;i<7;i++) {started=performance.now();memory.recall('喜欢咖啡',{scope,limit:8,minScore:0});warm.push(performance.now()-started)}
  assert.equal(memory.lexicalCacheStats().builds,before.builds)
  assert.equal(fetched,0)
  warm.sort((a,b)=>a-b)
  t.diagnostic(JSON.stringify({records:100000,visibleScope:5000,seedMs:+seedMs.toFixed(1),listMs:+listMs.toFixed(1),listQueries,
    lexicalColdMs:+coldMs.toFixed(1),lexicalWarmMedianMs:+warm[3].toFixed(1),lexicalWarmMaxMs:+warm.at(-1).toFixed(1),warmCandidateFetches:fetched}))
})

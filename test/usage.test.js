import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createStorage} from '../src/storage/index.js'
import {createUsageLedger} from '../src/diagnostics/usage.js'
test('usage ledger isolates accounts and distinguishes unknown amounts from zero without storing prompts',()=>{
 const storage=createStorage({file:':memory:',filesDir:'.'});let account='bot'
 try{
  const ledger=createUsageLedger({storage,getAccount:()=>account})
  ledger.record({id:'one',service:'llm',inputTokens:10,outputTokens:5,prompt:'secret prompt',apiKey:'secret-key',status:'succeeded'})
  ledger.record({id:'one',service:'llm',inputTokens:10})
  ledger.record({service:'search',credits:2,amount:0,currency:'USD'})
  ledger.record({service:'tts',account:'other',inputChars:50})
  const result=ledger.report();assert.equal(result.items.length,2);assert.equal(result.totals.find(x=>x.service==='llm').inputTokens,10)
  assert.equal(result.totals.find(x=>x.service==='llm').unknownAmountCalls,1);assert.equal(result.amounts[0].amount,0)
  assert.ok(!JSON.stringify(result).includes('secret'));account='other';assert.equal(ledger.report().items.length,1)
 }finally{storage.close()}
})
test('usage ledger binds request context from authoritative messages and rejects forged requests',()=>{
 const storage=createStorage({file:':memory:',filesDir:'.'})
 try{const ledger=createUsageLedger({storage,getAccount:()=> 'bot'});ledger.record({requestId:'missing',service:'llm'});assert.equal(ledger.report().items.length,0)}finally{storage.close()}
})

test('business settlement before or after usage correlates once and cannot update another account or group',()=>{
 const storage=createStorage({file:':memory:',filesDir:''})
 try {
  const ledger=createUsageLedger({storage,getAccount:()=> 'bot'})
  const source=storage.messages.ingest({account:'bot',chatId:'group:1',authorId:'alice',text:'原文不会进账本',eventKind:'message'})
  for(const before of [true,false]) {
   const id=String(before),usage={id,account:'bot',chatId:'group:1',startedAt:100,finishedAt:500,durationMs:400,
    attempts:1,usageComplete:true,sourceMessageIds:[source.id,'forged'],status:'success',tokens:{inputTokens:6,outputTokens:3}}
   const outcome={id,phase:'business',context:{account:'bot',chatId:'group:1'},businessStatus:'failed',businessError:'INVALID_MODEL_OUTPUT'}
   if(before) ledger.record(outcome)
   ledger.record(usage)
   if(!before) ledger.record(outcome)
   ledger.record(usage)
   ledger.record({...outcome,context:{account:'other',chatId:'group:1'},businessStatus:'success'})
   ledger.record({...outcome,context:{account:'bot',chatId:'group:2'},businessStatus:'success'})
  }
  const report=ledger.report();assert.equal(report.items.length,2);assert.equal(report.totals[0].outputTokens,6)
  for(const item of report.items) {
   assert.equal(item.startedAt,100);assert.equal(item.finishedAt,500);assert.equal(item.durationMs,400)
   assert.equal(item.status,'success');assert.equal(item.businessStatus,'failed');assert.equal(item.businessError,'INVALID_MODEL_OUTPUT')
   assert.deepEqual(item.sourceMessageIds,[source.id])
  }
  assert.equal(JSON.stringify(report).includes('原文'),false)
  createUsageLedger({storage,getAccount:()=> 'bot'})
  assert.equal(ledger.report().items.length,2,'schema migration is idempotent')
  ledger.record({id:'legacy-duration',finishedAt:1000,durationMs:600})
  assert.equal(ledger.report().items.find(i=>i.id==='legacy-duration').startedAt,400)
 } finally {storage.close()}
})

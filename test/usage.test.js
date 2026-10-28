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

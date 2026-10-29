import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture, S, sources, deferred, settled } from './helpers/wp6.js'
import { observeModelUsage } from '../src/core/llm.js'
import { createUsageLedger } from '../src/diagnostics/usage.js'

test('learning shrinks batches, grows backoff past 64 seconds and persists a visible pause without lowering daily budget',async t=>{
  const f=fixture(t),sizes=[]
  f.cfg.learning.maxCallsPerDay=200
  f.cfg.learning.maxOutputTokens=8000
  for(let n=0;n<24;n++) f.message(`摸鱼场景 ${n}`,['alice','bob','carol'][n%3])
  let l=f.learning({infer:async({messages})=>{sizes.push(messages.length);return 'bad json'}})
  for(let i=1;i<=6;i++) {
    assert.equal((await l.learn(S,'expression')).code,'INVALID_MODEL_OUTPUT')
    const cp=l.checkpoint(S,'expression')
    assert.equal(cp.processedSeq,0);assert.equal(cp.queued,24)
    assert.equal(cp.nextAttemptAt-f.now(),60000*2**(i-1))
    f.advance(cp.nextAttemptAt-f.now())
  }
  assert.deepEqual(sizes,[12,6,3,3,3,3])
  const cp=l.checkpoint(S,'expression')
  assert.equal(cp.paused,true);assert.equal(cp.attempts,6);assert.ok(cp.lastCallId)
  await l.stop();l=f.learning({infer:async()=>({items:[],noInfo:true})})
  f.advance(86400000)
  assert.equal((await l.learn(S,'expression')).code,'LEARNING_PAUSED')
  assert.equal(l.budget().maxCallsPerDay,200)
  assert.equal((await l.learn(S,'jargon')).code,'NO_INFO','independent kind may continue')
  assert.equal(l.resume(S,'expression').ok,true)
  assert.equal((await l.learn(S,'expression')).code,'NO_INFO')
  assert.ok(l.checkpoint(S,'expression').processedSeq>0)
  assert.equal(l.checkpoint(S,'expression').queued,21)
})

test('a restored 92-failure checkpoint is paused before reserving or calling a model',async t=>{
  const f=fixture(t);sources(f)
  let calls=0
  const l=f.learning({infer:async()=>{calls++;return {items:[],noInfo:true}}})
  l.enqueue(S,'expression')
  f.storage.db.run("UPDATE wp6_learning_checkpoints SET attempts=92,outcome='failed',last_error='MODEL_FAILED'")
  assert.equal((await l.learn(S,'expression')).code,'LEARNING_PAUSED')
  assert.equal(l.checkpoint(S,'expression').attempts,92)
  assert.equal(l.budget().calls,0);assert.equal(calls,0)
  l.resume(S,'expression')
  assert.equal((await l.learn(S,'expression')).code,'NO_INFO')
  assert.equal(calls,1)
})

for(const revoke of ['group','learn','kind','global']) test(`learning ${revoke} revocation aborts in-flight work and preserves its queue`,async t=>{
  const f=fixture(t),entered=deferred(),late=deferred();sources(f)
  f.cfg.enabled=true;f.cfg.allow={groups:['1'],private:[]}
  let signal
  const l=f.learning({infer:async args=>{signal=args.signal;entered.resolve();await late.promise;return {items:[],noInfo:true}}})
  const job=l.learn(S,'expression');await entered.promise
  if(revoke==='group') f.cfg.allow.groups=[]
  if(revoke==='learn') f.cfg.learning.learnEnabled=false
  if(revoke==='kind') f.cfg.learning.learnExpressions=false
  if(revoke==='global') f.cfg.enabled=false
  l.refreshPolicy()
  assert.equal((await job).ok,false);assert.equal(signal.aborted,true)
  assert.equal(l.enqueue(S,'expression').code,'LEARNING_DISABLED')
  assert.equal((await l.learn(S,'expression')).code,'LEARNING_DISABLED')
  const cp=l.checkpoint(S,'expression')
  assert.equal(cp.processedSeq,0);assert.equal(cp.queued,3);assert.equal(cp.failures,0);assert.ok(cp.blockedReason)
  assert.equal(l.budget().active,0)
  f.cfg.allow.groups=['1'];f.cfg.learning.learnEnabled=true;f.cfg.learning.learnExpressions=true;f.cfg.enabled=true
  late.resolve();await settled()
  assert.equal(l.list(S).length,0);assert.equal(l.checkpoint(S,'expression').processedSeq,0)
})

test('revoking learning before dispatch prevents a queued inference and a restored scope cannot learn off-list',async t=>{
  const f=fixture(t);sources(f);f.cfg.allow={groups:['1']}
  let calls=0;const l=f.learning({infer:async()=>{calls++;return {items:[],noInfo:true}}})
  const job=l.learn(S,'jargon');f.cfg.allow.groups=[];l.refreshPolicy()
  assert.equal((await job).ok,false);assert.equal(calls,0)
  const restored=f.learning({infer:async()=>{calls++;return {items:[],noInfo:true}}})
  await restored.tick(S)
  assert.equal(calls,0);assert.equal(restored.checkpoint(S,'jargon').processedSeq,0)
})

test('learning shares the model ledger and distinguishes stream success from failed business validation',async t=>{
  const f=fixture(t),ids=sources(f),entered=deferred(),late=deferred()
  f.cfg.model={provider:'mock',model:'offline'}
  let invalid=true
  const dsh={llm:{stream:async function*(){
    entered.resolve();await late.promise
    yield {type:'text-delta',text:JSON.stringify(invalid?{items:[{situation:'歇会',expression:'凭空编造',confidence:0.8,evidenceMessageIds:ids}],noInfo:false}:{items:[],noInfo:true})}
    yield {type:'usage',usage:{inputTokens:30,outputTokens:12}}
    yield {type:'finish',reason:'stop'}
  }}}
  const ledger=createUsageLedger({storage:f.storage,getAccount:()=>S.account})
  t.after(observeModelUsage(dsh,event=>ledger.record(event)))
  const l=f.learning({dsh}),start=Date.now(),job=l.learn(S,'expression')
  await entered.promise;const dispatched=Date.now();late.resolve()
  assert.equal((await job).code,'EVIDENCE_MISMATCH')
  const item=ledger.report().items[0]
  assert.equal(item.status,'success');assert.equal(item.businessStatus,'failed');assert.equal(item.businessError,'EVIDENCE_MISMATCH')
  assert.equal(item.role,'learning');assert.equal(item.stage,'expression');assert.equal(item.chatId,S.chat)
  assert.equal(item.id,l.checkpoint(S,'expression').lastCallId);assert.ok(item.operationId)
  assert.ok(item.startedAt>=start && item.startedAt<=dispatched);assert.ok(item.finishedAt>=item.startedAt)
  assert.deepEqual(item.sourceMessageIds,ids);assert.equal(item.inputTokens,30)
  assert.equal(l.checkpoint(S,'expression').processedSeq,0);assert.equal(l.list(S).length,0)
  f.advance(60000);invalid=false
  assert.equal((await l.learn(S,'expression')).code,'NO_INFO')
  assert.equal(ledger.report().items.length,2);assert.equal(ledger.report().totals[0].outputTokens,24)
  assert.equal(ledger.report().items.filter(i=>i.businessStatus==='success').length,1)
})

test('learning deadline is recorded as timeout by the shared model observer and releases its reservation',async t=>{
  const f=fixture(t);sources(f);f.cfg.learning.timeoutMs=100;f.cfg.model={provider:'mock',model:'offline-timeout'}
  const dsh={llm:{stream:()=>({[Symbol.asyncIterator](){return this},next:()=>new Promise(()=>{}),return:()=>({done:true})})}}
  const ledger=createUsageLedger({storage:f.storage,getAccount:()=>S.account})
  t.after(observeModelUsage(dsh,event=>ledger.record(event)))
  const learning=f.learning({dsh})
  assert.equal((await learning.learn(S,'expression')).code,'MODEL_TIMEOUT')
  await settled()
  const [call]=ledger.report().items
  assert.equal(call.status,'timeout');assert.equal(call.businessStatus,'failed');assert.equal(call.businessError,'MODEL_TIMEOUT')
  assert.equal(call.inputTokens,null);assert.equal(call.outputTokens,null)
  assert.equal(learning.budget().active,0);assert.equal(learning.checkpoint(S,'expression').failures,1)
})

test('default learning budget leaves room for reasoning on the first attempt',async t=>{
  const f=fixture(t),calls=[]
  for(let n=0;n<10;n++)f.message(`摸鱼休息 ${n}`,n%2?'alice':'bob')
  f.cfg.model={provider:'mock',model:'offline'}
  const dsh={llm:{async *stream(p){
    calls.push(p)
    yield {type:'text-delta',text:'{"items":[],"noInfo":true}'}
    yield {type:'finish',reason:'stop'}
  }}}
  const l=f.learning({dsh})
  assert.equal((await l.learn(S,'expression')).code,'NO_INFO')
  assert.equal(calls[0].maxTokens,2400)
  assert.equal(JSON.parse(calls[0].messages[0].content[0].text).messages.length,3)
  assert.match(calls[0].system,/最多1项/)
  assert.equal(l.checkpoint(S,'expression').queued,7)
})

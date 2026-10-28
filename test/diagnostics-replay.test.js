import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorage } from '../src/storage/index.js'
import { createDiagnostics, GROUP_POLICY_REPLAY_VERSION, DIAGNOSTICS_LIMITS } from '../src/diagnostics/index.js'
import { DEFAULT_GROUP_POLICY, decideGroupReply } from '../src/chat/group-policy.js'
import { registerSecret } from '../src/core/redact.js'

function setup(t) {
  let clock=1000,seq=0
  const dir=mkdtempSync(join(tmpdir(),'aurabot-replay-'))
  const storage=createStorage({file:':memory:',filesDir:join(dir,'assets'),now:()=>clock})
  const config={botQQ:'20',ownerQQ:'10',policyRevision:7}
  const forbidden=()=>{throw new Error('read-only diagnostics must not call live services')}
  const d=createDiagnostics({storage,getConfig:()=>config,hub:forbidden,modules:forbidden,version:'fixture/1',now:()=>clock})
  t.after(()=>{d.dispose();storage.close();rmSync(dir,{recursive:true,force:true})})
  const make=({account='20',chatId='group:42',receivedAt=1000,createdAt=receivedAt+20}={})=>{
    clock=receivedAt
    const m=storage.messages.ingest({account,chatId,authorId:'10',text:'PRIVATE RAW MESSAGE',eventKind:'message'})
    clock=createdAt
    return storage.requests.create({chatId,actorId:'10',sourceMessageIds:[m.id],policyRevision:7})
  }
  const event=(r,at,payload={},extra={})=>{
    clock=at
    return d.record({chatId:r.chatId,requestId:r.id,traceId:r.traceId,kind:'群聊决策',payload,...extra})
  }
  const receipt=(r,{at=1500,state='delivered',messageId,chatId=r.chatId,epoch=r.epoch}={})=>{
    const id=`out-${++seq}`
    storage.db.run(`INSERT INTO outbox(id,batch_id,seq,chat_id,request_id,epoch,kind,payload_json,idempotency_key,state,platform_msg_id,created_at,updated_at)
      VALUES (?,?,0,?,?,?,'text','{}',?,?,?,?,?)`,id,id,chatId,r.id,epoch,id,state,messageId===undefined?`qq-${id}`:messageId,at,at)
    return id
  }
  const job=(r,state='running',account='20',batchId=null)=>{
    const id=`job-${++seq}`
    storage.db.run(`INSERT INTO jobs(id,kind,chat_id,request_id,actor_id,epoch,state,input_json,output_json,trace_id,created_at,updated_at)
      VALUES (?,'image',?,?,?, ?,?,?,?,?,1000,1500)`,id,r.chatId,r.id,r.actorId,r.epoch,state,JSON.stringify({accountId:account}),JSON.stringify({deliveryBatchId:batchId}),r.traceId)
    return id
  }
  const planner=(r,actions,extra={})=>storage.meta.set(`planner:turn:${++seq}`,{account:'20',chatId:r.chatId,epoch:r.epoch,createdAt:1000,actions,...extra})
  return {d,storage,config,make,event,receipt,job,planner,time:at=>{clock=at}}
}

function snapshot(extra={}) {
  const input={policy:{...DEFAULT_GROUP_POLICY,interjectChance:.5,cooldownSec:0,minRecentMessages:0,minRelevance:0,quietHours:[0,0]},
    mentioned:false,repliedToBot:false,text:'PRIVATE RAW MESSAGE',now:1000,hour:12,relevance:0,engagedUntil:0,recentTimes:[],interjectTimes:[],botReplyTimes:[]}
  const baseDecision=decideGroupReply({...input,rand:()=>.2})
  return {policyRevision:7,decision:baseDecision,replay:{policyVersion:GROUP_POLICY_REPLAY_VERSION,input,random:.2,baseDecision,...extra}}
}

test('确定性回放冻结实际策略/输入/随机值，读取不写库、不用当前配置和实时服务', t=>{
  const s=setup(t),r=s.make(),event=s.event(r,1100,snapshot())
  s.receipt(r);s.storage.requests.setState(r.id,'answered')
  const serialized=s.storage.db.get('SELECT payload_json FROM diagnostic_events WHERE id=?',event.id).payload_json
  assert.equal(serialized.includes('PRIVATE RAW MESSAGE'),false)
  const changes=s.storage.db.get('SELECT total_changes() AS n').n
  s.storage.db.exec('PRAGMA query_only=ON')
  t.mock.method(globalThis,'fetch',()=>{throw new Error('network forbidden')})
  t.mock.method(Math,'random',()=>{throw new Error('unrecorded randomness forbidden')})
  const a=s.d.replay({requestId:r.id}),single=s.d.replay({eventId:event.id})
  s.config.policyRevision=99;s.config.group={interjectChance:0};s.time(999999)
  assert.deepEqual(s.d.replay({requestId:r.id}),a)
  assert.equal(single.events[0].recomputation.status,'recomputed')
  assert.equal(single.events[0].recomputation.matchesRecordedBase,true)
  assert.equal(single.events[0].recorded.policyRevision,7)
  assert.equal(single.events[0].recorded.appVersion,'fixture/1')
  assert.match(single.events[0].recorded.policyVersion,/^group-reply\/1:/)
  assert.equal(a.observedLedger.semantics,'current_persisted_rows_not_historical_state_transitions')
  s.d.latencies();s.d.requestLatency(r.id)
  assert.equal(s.storage.db.get('SELECT total_changes() AS n').n,changes)
  assert.equal(JSON.stringify(a).includes('PRIVATE RAW MESSAGE'),false)
})

test('重算只比较基础策略，钩子/节流后的最终结果保留且不伪称能重现', t=>{
  const s=setup(t),r=s.make(),p=snapshot()
  p.decision={reply:false,mode:'none',reason:'participation throttle'}
  const e=s.event(r,1100,p),view=s.d.replay({eventId:e.id}).events[0]
  assert.equal(view.recorded.decision.reply,false)
  assert.equal(view.recomputation.decision.reply,true)
  assert.equal(view.recomputation.matchesRecordedBase,true)
  assert.ok(view.unknown.includes('unrecorded_hooks_and_participation_inputs'))
  const noBase=s.event(r,1200,snapshot({baseDecision:null}))
  assert.equal(s.d.replay({eventId:noBase.id}).events[0].recomputation.matchesRecordedBase,null)
})

test('旧记录、版本不匹配、缺失实际随机值或输入明确不可回算，不补今天的事实', t=>{
  const s=setup(t),r=s.make()
  const legacy=s.event(r,1100,{decision:{reply:false,mode:'none',reason:'legacy'},policy:{interjectChance:.1}})
  s.storage.db.run('UPDATE diagnostic_events SET payload_json=? WHERE id=?',JSON.stringify({decision:{reply:false}}),legacy.id)
  assert.deepEqual(s.d.replay({eventId:legacy.id}).events[0].recomputation,{status:'unavailable',missing:['historical_snapshot']})
  for(const [extra,status,missing] of [
    [{policyVersion:'group-reply/old'},'unsupported-policy','matching_policy_implementation'],
    [{random:null},'unavailable','random'],
    [{input:{mentioned:true}},'unavailable','policy.wakeWords'],
  ]) {
    const e=s.event(r,1100,snapshot(extra)),v=s.d.replay({eventId:e.id}).events[0]
    assert.equal(v.recomputation.status,status);assert.ok(v.recomputation.missing.includes(missing))
  }
})

test('确定性必回分支不需要随机值，唤醒词不保存原文也能重放',t=>{
  const s=setup(t),r=s.make(),p=snapshot({random:null})
  p.replay.input.text='PRIVATE RAW MESSAGE 大肥鱼';p.replay.baseDecision=null
  const e=s.event(r,1100,p),v=s.d.replay({eventId:e.id}).events[0]
  assert.equal(v.recomputation.status,'recomputed');assert.equal(v.recomputation.randomUsed,false)
  assert.equal(v.recomputation.decision.mode,'must');assert.equal(v.recorded.facts.wakeWordMatch,'大肥鱼')
  assert.equal(JSON.stringify(v).includes('PRIVATE RAW MESSAGE'),false)
})

test('账号、聊天和显式request关联隔离；混合来源请求被拒绝',t=>{
  const s=setup(t),own=s.make(),other=s.make({account:'21'}),elsewhere=s.make({chatId:'group:99'})
  const a=s.event(own,1100,snapshot()),b=s.event(other,1100,snapshot(),{account:'21'})
  s.event(elsewhere,1100,snapshot(),{traceId:own.traceId})
  const sibling=s.make();s.event(sibling,1110,snapshot(),{traceId:own.traceId})
  s.event(other,1120,snapshot(),{requestId:null,account:'21',traceId:own.traceId})
  assert.deepEqual(s.d.replay({requestId:own.id}).events.map(e=>e.id),[a.id])
  assert.throws(()=>s.d.replay({requestId:other.id}),/当前账号/)
  assert.throws(()=>s.d.replay({eventId:b.id}),/当前账号/)
  assert.throws(()=>s.d.replay({requestId:own.id,eventId:a.id}),/只指定/)
  s.storage.db.run('UPDATE requests SET source_message_ids_json=? WHERE id=?',JSON.stringify([...own.sourceMessageIds,...other.sourceMessageIds]),own.id)
  assert.throws(()=>s.d.requestLatency(own.id),/当前账号/)
  const aggregate=s.d.latencies({chatId:'group:42'})
  assert.equal(aggregate.excluded,1);assert.deepEqual(aggregate.items.map(i=>i.requestId),[sibling.id])
})

test('从最早本机收消息计时，首decision可早于请求登记，首真实回复与多批最终交付分开',t=>{
  const s=setup(t),r=s.make({receivedAt:1000,createdAt:1200})
  const message=s.storage.messages.get(r.sourceMessageIds[0])
  s.event(r,1100,{decision:{reply:true}}, {requestId:null,traceId:message.traceId})
  s.time(1250)
  const second=s.storage.messages.ingest({account:'20',chatId:r.chatId,authorId:'10',text:'extra',eventKind:'message'})
  s.storage.requests.appendSource(r.id,second.id)
  s.receipt(r,{at:1500});const batchId=s.receipt(r,{at:2400})
  s.job(r,'delivered','20',batchId);s.storage.requests.setState(r.id,'answered')
  const m=s.d.requestLatency(r.id)
  assert.deepEqual(m.latencyMs,{firstDecision:100,firstConfirmedReply:500,finalDelivery:1400})
  assert.equal(m.counts.sources,2);assert.equal(m.counts.confirmedReceipts,2)
  assert.deepEqual(m.issues,[])
})

test('Planner保留的实际动作可用于私聊decision，预留轮次/工具调用不能当已完成决策',t=>{
  const s=setup(t),r=s.make({chatId:'private:10'})
  s.planner(r,[{action:'decision',requestId:r.id,at:1050},{action:'tool',requestId:r.id,at:1060}])
  assert.equal(s.d.requestLatency(r.id).latencyMs.firstDecision,null)
  s.planner(r,[{action:'reply',requestId:r.id,decisionId:'dec-1',at:1300},{action:'stop',requestId:r.id,at:1600}])
  s.planner(r,[{action:'reply',requestId:r.id,at:1001}],{account:'21'})
  assert.equal(s.d.requestLatency(r.id).latencyMs.firstDecision,300)
})

test('后台任务未结束不能将已确认的进度回复当最终交付；发送unknown不重发或记失败',t=>{
  const s=setup(t),r=s.make(),job=s.job(r)
  s.receipt(r,{at:1200});s.storage.requests.setState(r.id,'answered')
  assert.equal(s.d.requestLatency(r.id).latencyMs.firstConfirmedReply,200)
  assert.equal(s.d.requestLatency(r.id).latencyMs.finalDelivery,null)
  s.storage.db.run("UPDATE jobs SET state='delivered' WHERE id=?",job)
  const unknown=s.receipt(r,{at:1400,state:'unknown',messageId:null})
  const changes=s.storage.db.get('SELECT total_changes() AS n').n
  assert.equal(s.d.requestLatency(r.id).latencyMs.finalDelivery,null)
  assert.equal(s.d.replay({requestId:r.id}).observedLedger.deliveries.find(d=>d.id===unknown).state,'unknown')
  assert.equal(s.storage.db.get('SELECT total_changes() AS n').n,changes)
})

test('pending/skipped/failed/canceled和无message_id的delivered均不计为真实QQ回执',t=>{
  const s=setup(t)
  for(const state of ['pending','sending','unknown','skipped','failed','canceled','delivered']) {
    const r=s.make();s.receipt(r,{state,messageId:null});s.storage.requests.setState(r.id,'answered')
    const m=s.d.requestLatency(r.id)
    assert.equal(m.latencyMs.firstConfirmedReply,null,state);assert.equal(m.latencyMs.finalDelivery,null,state)
  }
  assert.deepEqual(s.d.latencies().metrics.firstConfirmedReply,{sampleCount:0,missingCount:7,p50Ms:null,p95Ms:null})
})

test('p50/p95按nearest-rank及有效样本数计算，窗口只取本账号/聊天且不以零代缺失',t=>{
  const s=setup(t)
  for(const ms of [0,10,20,30,100]) {
    const r=s.make();s.event(r,1000+ms,{decision:{reply:true}});s.receipt(r,{at:1000+ms*2});s.storage.requests.setState(r.id,'answered')
  }
  s.make();s.make({account:'21'});s.make({chatId:'group:99'})
  const v=s.d.latencies({chatId:'group:42',from:1020,to:1020})
  assert.deepEqual(s.d.latencies({chatId:'group:42',from:'1020',to:'1020'}),v)
  assert.equal(v.requestCount,6)
  assert.deepEqual(v.metrics.firstDecision,{sampleCount:5,missingCount:1,p50Ms:20,p95Ms:100})
  assert.deepEqual(v.metrics.finalDelivery,{sampleCount:5,missingCount:1,p50Ms:40,p95Ms:200})
  assert.equal(s.d.latencies({chatId:'group:42',limit:2}).window.truncated,true)
  assert.equal(s.d.latencies({from:2000}).requestCount,0)
  assert.throws(()=>s.d.latencies({from:2000,to:1000}),/from/)
})

test('负延迟、范围不一致的ledger和未完成请求不会污染成功指标',t=>{
  const s=setup(t),r=s.make()
  s.event(r,900,{decision:{reply:true}});s.receipt(r,{at:999});s.storage.requests.setState(r.id,'answered')
  assert.deepEqual(s.d.requestLatency(r.id).latencyMs,{firstDecision:null,firstConfirmedReply:null,finalDelivery:null})
  const other=s.make();s.receipt(other,{chatId:'group:99'});s.storage.requests.setState(other.id,'answered')
  assert.equal(s.d.requestLatency(other.id).latencyMs.finalDelivery,null)
  assert.deepEqual(s.d.replay({requestId:other.id}).observedLedger.deliveries,[])
  const open=s.make();s.receipt(open)
  assert.equal(s.d.requestLatency(open.id).latencyMs.finalDelivery,null)
})

test('事件、回执、任务和Planner读取均有硬上限，截断时不输出伪精确延迟',t=>{
  const s=setup(t),r=s.make()
  for(let i=0;i<=DIAGNOSTICS_LIMITS.events;i++)s.event(r,1100+i,{decision:{reply:true}})
  for(let i=0;i<=DIAGNOSTICS_LIMITS.deliveries;i++)s.receipt(r,{at:1500+i})
  for(let i=0;i<=DIAGNOSTICS_LIMITS.jobs;i++)s.job(r,'delivered')
  s.storage.requests.setState(r.id,'answered')
  const v=s.d.replay({requestId:r.id,limit:1e6})
  assert.equal(v.events.length,DIAGNOSTICS_LIMITS.events);assert.equal(v.truncated,true)
  assert.equal(v.observedLedger.deliveries.length,DIAGNOSTICS_LIMITS.deliveries)
  assert.equal(v.observedLedger.jobs.length,DIAGNOSTICS_LIMITS.jobs)
  assert.deepEqual(v.latency.latencyMs,{firstDecision:null,firstConfirmedReply:null,finalDelivery:null})
  assert.equal(s.d.replay({requestId:r.id,limit:1}).events.length,1)
  const p=s.make({chatId:'private:10'})
  for(let i=0;i<=DIAGNOSTICS_LIMITS.plannerTurns;i++)s.planner(p,[{action:'reply',requestId:p.id,at:1200}])
  assert.equal(s.d.requestLatency(p.id).truncated.planner,true)
  assert.equal(s.d.requestLatency(p.id).latencyMs.firstDecision,null)
})

test('损坏/超大快照和过长数组是缺失证据，不执行存储的字符串',t=>{
  const s=setup(t),r=s.make(),ids=[]
  for(const text of ['{invalid',JSON.stringify({huge:'x'.repeat(DIAGNOSTICS_LIMITS.payloadBytes+1)})]) {
    const e=s.event(r,1100,{});ids.push(e.id)
    s.storage.db.run('UPDATE diagnostic_events SET payload_json=? WHERE id=?',text,e.id)
    assert.equal(s.d.replay({eventId:e.id}).events[0].recomputation.status,'unavailable')
  }
  const p=snapshot();p.replay.input.recentTimes=Array(DIAGNOSTICS_LIMITS.array+1).fill(1000)
  p.replay.eval='throw new Error("must not execute")'
  const e=s.event(r,1100,p)
  assert.ok(s.d.replay({eventId:e.id}).events[0].recomputation.missing.includes('recentTimes'))
  const huge=s.event(r,1100,{...snapshot(),unneeded:'x'.repeat(DIAGNOSTICS_LIMITS.payloadBytes)})
  assert.ok(s.d.replay({eventId:huge.id}).events[0].unknown.includes('payload_limit'))
})

test('delivered任务仍需其实际批次回执；只有进度消息不能生成最终交付样本',t=>{
  const s=setup(t),r=s.make()
  s.receipt(r,{at:1100});const job=s.job(r,'delivered');s.storage.requests.setState(r.id,'answered')
  assert.equal(s.d.requestLatency(r.id).latencyMs.finalDelivery,null)
  const batchId=s.receipt(r,{at:2100})
  s.storage.db.run('UPDATE jobs SET output_json=? WHERE id=?',JSON.stringify({deliveryBatchId:batchId}),job)
  assert.equal(s.d.requestLatency(r.id).latencyMs.finalDelivery,1100)
})

test('同群其他请求再多也不占本请求Planner读取上限，损坏action安全降级',t=>{
  const s=setup(t),r=s.make(),other=s.make()
  for(let i=0;i<=DIAGNOSTICS_LIMITS.plannerTurns;i++)s.planner(other,[{action:'reply',requestId:other.id,at:1200}])
  s.planner(r,[{action:'reply',requestId:r.id,at:1200}])
  assert.equal(s.d.requestLatency(r.id).latencyMs.firstDecision,200)
  s.planner(r,[null,{action:'reply',requestId:r.id,at:1300}])
  assert.equal(s.d.requestLatency(r.id).latencyMs.firstDecision,null)
})

test('脱敏改动了策略输入时明确无法精确回放，不导出密钥',t=>{
  const s=setup(t),r=s.make(),p=snapshot()
  registerSecret('replay-secret-fixture')
  p.replay.input.policy.wakeWords=['replay-secret-fixture']
  const e=s.event(r,1100,p),v=s.d.replay({eventId:e.id})
  assert.deepEqual(v.events[0].recomputation,{status:'unavailable',missing:['unredacted_historical_input']})
  assert.equal(JSON.stringify(v).includes('replay-secret-fixture'),false)
})

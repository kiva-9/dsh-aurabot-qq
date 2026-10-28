import { monitorEventLoopDelay } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import { newId } from '../core/ids.js'
import { redact } from '../core/redact.js'
import { publicConfig } from '../core/config.js'
import { decideGroupReply, inQuietHours } from '../chat/group-policy.js'

// Hash the actual pure implementation; never run a historical snapshot against a
// different policy and present it as an exact replay. No source files are needed at runtime.
export const GROUP_POLICY_REPLAY_VERSION = 'group-reply/1:' + createHash('sha256')
  .update(String(decideGroupReply) + String(inQuietHours)).digest('hex').slice(0, 16)
export const DIAGNOSTICS_LIMITS = Object.freeze({ requests: 100, events: 100, sources: 64, deliveries: 256, jobs: 64, plannerTurns: 100, array: 256, payloadBytes: 32768 })
const numericPolicy = ['interjectChance', 'cooldownSec', 'maxPerHour', 'minRecentMessages', 'activeWindowSec', 'minRelevance', 'burstMax', 'burstWindowSec']
const numericInput = ['now', 'hour', 'relevance', 'engagedUntil']
const timeArrays = ['recentTimes', 'interjectTimes', 'botReplyTimes']
const completedActions = new Set(['reply', 'ask_clarification', 'search', 'recall', 'submit_job', 'wait', 'stop'])
const decisionKinds = new Set(['群聊决策', 'decision', 'planner_decision'])
const finite = value => typeof value === 'number' && Number.isFinite(value)
const bounded = (value, max, fallback = max) => Number.isFinite(Number(value)) ? Math.max(1, Math.min(max, Math.floor(Number(value)))) : fallback
const smallString = value => typeof value === 'string' && value.length <= 512 ? value : null
const parse = value => { try { return JSON.parse(value) } catch { return null } }
const outcome = value => value && typeof value.reply === 'boolean' ? {
  reply: value.reply, mode: smallString(value.mode), reason: smallString(value.reason),
} : null

// Allowlisted data only. Chat bodies are reduced to the first matched wake word,
// which is the only way the pure policy uses text. Missing values stay missing.
function replayInput(raw = {}) {
  const p = raw?.policy || {}, policy = {}, input = { policy }
  for (const key of numericPolicy) if (finite(p[key])) policy[key] = p[key]
  if (Array.isArray(p.wakeWords) && p.wakeWords.length <= 64 && p.wakeWords.every(v => typeof v === 'string' && v.length <= 100)) policy.wakeWords = p.wakeWords.slice()
  if (Array.isArray(p.quietHours) && p.quietHours.length === 2 && p.quietHours.every(finite)) policy.quietHours = p.quietHours.slice()
  for (const key of numericInput) if (finite(raw?.[key])) input[key] = raw[key]
  for (const key of ['mentioned', 'repliedToBot']) if (typeof raw?.[key] === 'boolean') input[key] = raw[key]
  for (const key of timeArrays) if (Array.isArray(raw?.[key]) && raw[key].length <= DIAGNOSTICS_LIMITS.array && raw[key].every(finite)) input[key] = raw[key].slice()
  if (policy.wakeWords && typeof raw?.text === 'string' && raw.text.length <= 12000) input.wakeWordMatch = policy.wakeWords.find(w => w && raw.text.includes(w)) || null
  else if (raw?.wakeWordMatch === null || (policy.wakeWords?.includes(raw?.wakeWordMatch) && raw.wakeWordMatch)) input.wakeWordMatch = raw.wakeWordMatch
  return input
}

function recompute(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== 1) return { status: 'unavailable', missing: ['historical_snapshot'] }
  if (snapshot.inputRedacted) return { status: 'unavailable', missing: ['unredacted_historical_input'] }
  if (!snapshot.policyVersion) return { status: 'unavailable', missing: ['policyVersion'] }
  if (snapshot.policyVersion !== GROUP_POLICY_REPLAY_VERSION) return { status: 'unsupported-policy', missing: ['matching_policy_implementation'] }
  const input = replayInput(snapshot.input), missing = []
  for (const key of [...numericPolicy, 'wakeWords', 'quietHours']) if (!(key in input.policy)) missing.push(`policy.${key}`)
  for (const key of [...numericInput, ...timeArrays, 'mentioned', 'repliedToBot', 'wakeWordMatch']) if (!(key in input)) missing.push(key)
  if (missing.length) return { status: 'unavailable', missing }
  // Never use Math.random (including when the historical random draw is absent).
  let randomUsed = false
  try {
    const decision = decideGroupReply({ ...input, text: input.wakeWordMatch || '', rand: () => {
      randomUsed = true
      if (!finite(snapshot.random) || snapshot.random < 0 || snapshot.random >= 1) throw new Error('random')
      return snapshot.random
    } })
    const base = outcome(snapshot.baseDecision)
    return { status: 'recomputed', stage: 'base-policy-before-hooks-and-participation', decision, randomUsed,
      matchesRecordedBase: base ? base.reply === decision.reply && base.mode === decision.mode && base.reason === decision.reason : null }
  } catch { return { status: 'unavailable', missing: ['random'] } }
}

export function createDiagnostics({storage,getConfig,modules,hub,version,now=()=>Date.now()}) {
  const db=storage.db, histogram=monitorEventLoopDelay({resolution:20})
  histogram.enable()
  let stopped=false, written=0
  const current=()=>String(getConfig().botQQ)
  const safe=value=>typeof value==='string'?redact(value):Array.isArray(value)?value.map(safe):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,v])=>[key,safe(v)])):value
  const decode=row=>row?JSON.parse(row.payload_json):null
  const limit=value=>Math.max(1,Math.min(100,Math.floor(Number(value)||40)))
  const tableExists=name=>!!db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",name)
  function record({account=current(),chatId,traceId,requestId,kind,payload}) {
    if(stopped||!chatId)return
    const id=newId('diag'),at=now(),source=payload?.replay
    const replay = decisionKinds.has(kind) ? { schemaVersion:1,appVersion:version||null,engineVersion:GROUP_POLICY_REPLAY_VERSION,
      policyVersion:smallString(source?.policyVersion),policyRevision:Number.isSafeInteger(payload?.policyRevision)?payload.policyRevision:null,
      input:replayInput(source?.input || {policy:payload?.policy,mentioned:payload?.mentioned}),
      random:finite(source?.random)?source.random:null,baseDecision:outcome(source?.baseDecision),
    } : undefined
    if(replay)replay.inputRedacted=JSON.stringify(safe(replay.input))!==JSON.stringify(replay.input)
    let json=JSON.stringify(safe({...payload,...(replay?{replay}:{})}))
    if(Buffer.byteLength(json)>DIAGNOSTICS_LIMITS.payloadBytes)json=JSON.stringify({diagnosticIssue:'payload_limit',decision:safe(outcome(payload?.decision))})
    db.run('INSERT INTO diagnostic_events VALUES (?,?,?,?,?,?,?,?)',id,String(account),chatId,traceId||null,requestId||null,kind,at,json)
    if(++written%100===0)db.run('DELETE FROM diagnostic_events WHERE id IN (SELECT id FROM diagnostic_events ORDER BY at DESC LIMIT -1 OFFSET 10000)')
    return {id,at}
  }
  function requests({chatId,limit:n}={}) {
    return db.all(`SELECT r.* FROM requests r WHERE EXISTS (
      SELECT 1 FROM json_each(r.source_message_ids_json) s JOIN messages m ON m.id=s.value WHERE m.account_id=?)
      ${chatId?'AND r.chat_id=?':''} ORDER BY r.created_at DESC LIMIT ?`,current(),...(chatId?[chatId]:[]),limit(n))
      .map(r=>({id:r.id,chatId:r.chat_id,actorId:r.actor_id,state:r.state,traceId:r.trace_id,epoch:r.epoch,createdAt:r.created_at,updatedAt:r.updated_at}))
  }
  function timeline(requestId) {
    const request=db.get(`SELECT r.* FROM requests r WHERE r.id=? AND EXISTS (SELECT 1 FROM json_each(r.source_message_ids_json) s JOIN messages m ON m.id=s.value WHERE m.account_id=?)`,requestId,current())
    if(!request)throw new Error('当前账号没有这条请求')
    const messages=JSON.parse(request.source_message_ids_json).map(id=>storage.messages.get(id)).filter(m=>m&&m.account===current())
    const events=messages.map(m=>({kind:'收到消息',at:m.receivedAt,id:m.id,state:'received',info:{actorId:m.authorId,platformMessageId:m.platformMsgId,recvSeq:m.recvSeq}}))
    for(const m of messages) for(const a of storage.occurrences.ofMessage(m.id))events.push({kind:'媒体输入',at:a.updatedAt,id:a.id,state:a.state,info:{assetId:a.assetId,error:a.error}})
    events.push({kind:'请求登记',at:request.created_at,id:request.id,state:request.state,info:{epoch:request.epoch}})
    for(const job of db.all('SELECT * FROM jobs WHERE request_id=?',requestId)) {
      events.push({kind:'后台任务',at:job.updated_at,id:job.id,state:job.state,info:{kind:job.kind,error:job.error,attempts:job.attempts}})
      for(const attempt of db.all('SELECT * FROM job_attempts WHERE job_id=? ORDER BY n',job.id))events.push({kind:'提供方调用',at:attempt.finished_at||attempt.started_at,id:attempt.id,state:attempt.state,info:{attempt:attempt.n,billing:attempt.billing,errorKind:attempt.error_kind,error:attempt.error,durationMs:attempt.finished_at?attempt.finished_at-attempt.started_at:null}})
    }
    for(const row of db.all('SELECT id,batch_id,seq,state,platform_msg_id,attempts,last_error,created_at,updated_at FROM outbox WHERE request_id=? ORDER BY created_at,seq',requestId))events.push({kind:'QQ回执',at:row.updated_at,id:row.id,state:row.state,info:{batchId:row.batch_id,seq:row.seq,messageId:row.platform_msg_id,attempts:row.attempts,error:row.last_error}})
    const traces=[...new Set([request.trace_id,...messages.map(m=>m.traceId)].filter(Boolean))]
    for(const trace of traces)for(const row of db.all('SELECT * FROM diagnostic_events WHERE account_id=? AND trace_id=? ORDER BY at',current(),trace))events.push({kind:row.kind,at:row.at,id:row.id,state:'recorded',info:decode(row)})
    return safe({request:{id:request.id,chatId:request.chat_id,actorId:request.actor_id,epoch:request.epoch},events:events.sort((a,b)=>a.at-b.at)})
  }
  function summary() {
    const account=current()
    const counts=(table,where,args=[])=>db.all(`SELECT state,COUNT(*) n FROM ${table} ${where} GROUP BY state`,...args)
    const ownedJob="WHERE json_extract(input_json,'$.accountId')=?"
    return safe({version,account,schemaVersion:db.get('PRAGMA user_version').user_version,
      jobs:counts('jobs',ownedJob,[account]),
      billing:db.all(`SELECT a.billing,COUNT(*) n FROM job_attempts a JOIN jobs j ON j.id=a.job_id WHERE json_extract(j.input_json,'$.accountId')=? GROUP BY a.billing`,account),
      billingNote:'记录调用次数及可能计费状态；未配置供应商单价，不能据此推算金额。',
      queue:{pendingMedia:db.get("SELECT COUNT(*) n FROM asset_occurrences WHERE state='pending' AND json_extract(scope_json,'$.account')=?",account).n,
        pendingMemory:tableExists('memory_checkpoints')?db.get("SELECT COUNT(*) n FROM memory_checkpoints WHERE json_extract(scope,'$.account')=? AND watermark>recv_seq",account).n:0},
      eventLoop:{p95Ms:Math.round(histogram.percentile(95)/1e6),maxMs:Math.round(histogram.max/1e6)},
      host:hub()?.agentCaps?.()||{},hooks:modules()?.hookDiagnostics?.()||{},participation:hub()?.participation?.()||[],
      modules:(modules()?.status?.()||[]).map(({id,running,compatibility,error,errors})=>({id,running,compatibility,error,errors})),
      migration:{preflight:storage.meta.get('legacy.preflight'),backup:storage.meta.get('legacy.backup')},
      limitations:['本机主库事务仍在同步SQLite连接执行；向量计算使用独立worker。','没有QQ回执的unknown记录需要人工核对。']})
  }
  function decisions({chatId,limit:n}={}) {
    return db.all(`SELECT * FROM diagnostic_events WHERE account_id=? AND kind='群聊决策' ${chatId?'AND chat_id=?':''} ORDER BY at DESC LIMIT ?`,current(),...(chatId?[chatId]:[]),limit(n))
      .map(r=>safe({id:r.id,chatId:r.chat_id,traceId:r.trace_id,at:r.at,...decode(r)}))
  }

  function ownedRequest(id,account) {
    const r=db.get(`SELECT id,chat_id,actor_id,policy_revision,epoch,state,trace_id,created_at,updated_at,
      CASE WHEN length(source_message_ids_json)<=8192 THEN source_message_ids_json ELSE NULL END AS source_message_ids_json FROM requests WHERE id=?`,id)
    const ids=r&&typeof r.source_message_ids_json==='string'&&r.source_message_ids_json.length<=8192?parse(r.source_message_ids_json):null
    const denied=()=>{throw new Error('当前账号没有可完整核验的这条请求')}
    if(!Array.isArray(ids)||!ids.length||ids.length>DIAGNOSTICS_LIMITS.sources||ids.some(id=>typeof id!=='string'))return denied()
    const messages=ids.map(id=>db.get('SELECT id,account_id,chat_id,author_id,trace_id,received_at,recv_seq FROM messages WHERE id=?',id))
    if(messages.some(m=>!m||m.account_id!==account||m.chat_id!==r.chat_id||m.author_id!==r.actor_id))return denied()
    return {request:r,messages}
  }
  const payloadColumn=`CASE WHEN length(CAST(payload_json AS BLOB))<=${DIAGNOSTICS_LIMITS.payloadBytes} THEN payload_json ELSE NULL END AS payload_json`
  const eventColumns=`id,account_id,chat_id,trace_id,request_id,kind,at,${payloadColumn}`
  const cut=(rows,max)=>({rows:rows.slice(0,max),truncated:rows.length>max})
  function eventRows({request,messages},account,n=DIAGNOSTICS_LIMITS.events) {
    const traces=[...new Set([request.trace_id,...messages.map(m=>m.trace_id)].filter(Boolean))]
    return cut(db.all(`SELECT ${eventColumns} FROM diagnostic_events WHERE account_id=? AND chat_id=? AND
      (request_id=?${traces.length?` OR (request_id IS NULL AND trace_id IN (${traces.map(()=>'?').join(',')}))`:''})
      ORDER BY at,id LIMIT ?`,account,request.chat_id,request.id,...traces,n+1),n)
  }
  function plannerRows(account,chatId,requestId) {
    // Only persisted data is read. Do not instantiate a planner: its authorize /
    // recover methods can mutate state or wake jobs. Oversize journals are omitted
    // and the returned incompleteness prevents fabricated latency samples.
    const rows=db.all(`SELECT m.key,CASE WHEN length(CAST(m.value AS BLOB))<=${DIAGNOSTICS_LIMITS.payloadBytes} THEN m.value ELSE NULL END AS value
      FROM meta m WHERE m.key GLOB 'planner:turn:*'
      AND CASE WHEN json_valid(m.value) THEN json_extract(m.value,'$.account') END=?
      AND CASE WHEN json_valid(m.value) THEN json_extract(m.value,'$.chatId') END=?
      AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(m.value) THEN json_extract(m.value,'$.actions') ELSE '[]' END) a
        WHERE CASE WHEN a.type='object' THEN json_extract(a.value,'$.requestId') END=?)
      ORDER BY CASE WHEN json_valid(m.value) THEN json_extract(m.value,'$.createdAt') END DESC,m.key LIMIT ?`,account,chatId,requestId,DIAGNOSTICS_LIMITS.plannerTurns+1)
    const result=cut(rows,DIAGNOSTICS_LIMITS.plannerTurns),actions=[]
    for(const row of result.rows) {
      const turn=parse(row.value)
      if(!turn||!Array.isArray(turn.actions)||turn.actions.length>DIAGNOSTICS_LIMITS.array){result.truncated=true;continue}
      for(const a of turn.actions) {
        if(!a||typeof a!=='object'){result.truncated=true;continue}
        if(a.requestId===requestId&&completedActions.has(a.action)&&finite(a.at))actions.push({id:smallString(a.decisionId)||row.key,requestId:a.requestId,epoch:turn.epoch,action:a.action,at:a.at})
      }
    }
    return {actions,truncated:result.truncated}
  }
  function evidence(owned,account,n=DIAGNOSTICS_LIMITS.events) {
    const {request:r}=owned,events=eventRows(owned,account,n)
    const deliveries=cut(db.all('SELECT id,batch_id,seq,chat_id,epoch,state,platform_msg_id,updated_at FROM outbox WHERE request_id=? ORDER BY updated_at,id LIMIT ?',r.id,DIAGNOSTICS_LIMITS.deliveries+1),DIAGNOSTICS_LIMITS.deliveries)
    const jobs=cut(db.all(`SELECT id,chat_id,epoch,state,updated_at,
      CASE WHEN json_valid(input_json) THEN json_extract(input_json,'$.accountId') END AS account_id,
      CASE WHEN json_valid(output_json) THEN json_extract(output_json,'$.deliveryBatchId') END AS delivery_batch_id
      FROM jobs WHERE request_id=? ORDER BY updated_at,id LIMIT ?`,r.id,DIAGNOSTICS_LIMITS.jobs+1),DIAGNOSTICS_LIMITS.jobs)
    const planner=plannerRows(account,r.chat_id,r.id)
    const invalidScope=deliveries.rows.some(d=>d.chat_id!==r.chat_id||d.epoch!==r.epoch)||jobs.rows.some(j=>j.chat_id!==r.chat_id||j.epoch!==r.epoch||j.account_id!==account)
    return {...owned,events,deliveries,jobs,invalidScope,planner:{...planner,actions:planner.actions.filter(a=>a.requestId===r.id&&a.epoch===r.epoch)}}
  }
  function eventView(row) {
    const p=parse(row.payload_json),s=p?.replay
    return {id:row.id,kind:row.kind,at:row.at,requestId:row.request_id,
      recorded:{decision:outcome(p?.decision),policyRevision:Number.isSafeInteger(s?.policyRevision)?s.policyRevision:null,
        policyVersion:smallString(s?.policyVersion),engineVersion:smallString(s?.engineVersion),appVersion:smallString(s?.appVersion),
        facts:s?replayInput(s.input):replayInput({policy:p?.policy,mentioned:p?.mentioned}),random:finite(s?.random)?s.random:null},
      recomputation:decisionKinds.has(row.kind)?recompute(s):{status:'not-applicable'},
      unknown:[...(!p?['payload_missing_corrupt_or_oversize']:[]),...(p?.diagnosticIssue?[p.diagnosticIssue]:[]),
        ...(!s?.policyVersion?['historical_policy_version']:[]),'unrecorded_hooks_and_participation_inputs','external_model_tool_and_QQ_outcomes_cannot_be_reexecuted']}
  }
  function metric(e,account) {
    const r=e.request,receivedAt=Math.min(...e.messages.map(m=>m.received_at)),issues=[]
    const decisionTimes=[...e.events.rows.filter(row=>decisionKinds.has(row.kind)).map(row=>row.at),...e.planner.actions.map(a=>a.at)]
    const confirmed=e.deliveries.rows.filter(row=>row.chat_id===r.chat_id&&row.epoch===r.epoch&&row.state==='delivered'&&String(row.platform_msg_id??'').trim())
    const times={receivedAt,firstDecisionAt:null,firstConfirmedReplyAt:null,finalDeliveryAt:null}
    const setTime=(key,values)=>{
      if(values.some(at=>!finite(at)||at<receivedAt)){issues.push(`${key}:clock_order`);return}
      if(values.length)times[key]=key==='finalDeliveryAt'?Math.max(...values):Math.min(...values)
    }
    if(e.events.truncated||e.planner.truncated)issues.push('firstDecisionAt:read_limit')
    else if(decisionTimes.length)setTime('firstDecisionAt',decisionTimes)
    else issues.push('firstDecisionAt:not_recorded_or_not_linked')
    if(e.deliveries.truncated||e.invalidScope)issues.push('firstConfirmedReplyAt:incomplete_evidence')
    else if(confirmed.length)setTime('firstConfirmedReplyAt',confirmed.map(d=>d.updated_at))
    else issues.push('firstConfirmedReplyAt:no_confirmed_receipt')
    const finished=['answered','completed','delivered','closed','ended'].includes(r.state)
    const jobReceiptsComplete=e.jobs.rows.every(j=>j.state==='delivered'&&j.delivery_batch_id&&confirmed.some(d=>d.batch_id===j.delivery_batch_id))
    if(!finished)issues.push('finalDeliveryAt:request_not_completed')
    if(e.jobs.rows.some(j=>j.state!=='delivered'))issues.push('finalDeliveryAt:job_not_delivered')
    if(!jobReceiptsComplete)issues.push('finalDeliveryAt:job_receipt_missing')
    if(!e.deliveries.rows.length||confirmed.length!==e.deliveries.rows.length)issues.push('finalDeliveryAt:unconfirmed_segments')
    if(e.deliveries.truncated||e.jobs.truncated||e.invalidScope)issues.push('finalDeliveryAt:incomplete_evidence')
    if(finished&&e.deliveries.rows.length&&confirmed.length===e.deliveries.rows.length&&jobReceiptsComplete&&!e.deliveries.truncated&&!e.jobs.truncated&&!e.invalidScope)setTime('finalDeliveryAt',confirmed.map(d=>d.updated_at))
    return {requestId:r.id,account,chatId:r.chat_id,state:r.state,policyRevision:r.policy_revision,epoch:r.epoch,times,
      latencyMs:{firstDecision:times.firstDecisionAt===null?null:times.firstDecisionAt-receivedAt,
        firstConfirmedReply:times.firstConfirmedReplyAt===null?null:times.firstConfirmedReplyAt-receivedAt,
        finalDelivery:times.finalDeliveryAt===null?null:times.finalDeliveryAt-receivedAt},
      counts:{sources:e.messages.length,confirmedReceipts:confirmed.length,deliverySegments:e.deliveries.rows.length,jobs:e.jobs.rows.length},
      truncated:{events:e.events.truncated,planner:e.planner.truncated,deliveries:e.deliveries.truncated,jobs:e.jobs.truncated},issues}
  }

  /** Read-only, synchronous. Exactly one selector; limit clamps to 1..100.
   * replay({ requestId?, eventId?, limit? }) returns recorded facts and optionally
   * re-evaluates ONLY the version-matched pure base group policy. Current ledger
   * rows are labelled as current observations, never historical state snapshots.
   * record(...payload.replay:{policyVersion,input,random,baseDecision}) accepts
   * the ACTUAL effective input/draw from the trusted caller, not a replay-time guess.
   */
  function replay({requestId,eventId,limit:n}={}) {
    if(Boolean(requestId)===Boolean(eventId))throw new Error('只指定 requestId 或 eventId 之一')
    const account=current(),max=bounded(n,DIAGNOSTICS_LIMITS.events)
    const base={schemaVersion:1,readOnly:true,engineVersion:GROUP_POLICY_REPLAY_VERSION,limits:{...DIAGNOSTICS_LIMITS,events:max}}
    if(eventId) {
      const row=db.get(`SELECT ${eventColumns} FROM diagnostic_events WHERE id=? AND account_id=?`,String(eventId),account)
      if(!row)throw new Error('当前账号没有这条诊断事件')
      return safe({...base,scope:{account,chatId:row.chat_id},events:[eventView(row)],truncated:false})
    }
    const owned=ownedRequest(String(requestId),account),e=evidence(owned,account,max),r=e.request
    return safe({...base,scope:{account,chatId:r.chat_id,actorId:r.actor_id},
      request:{id:r.id,epoch:r.epoch,policyRevision:r.policy_revision,createdAt:r.created_at},events:e.events.rows.map(eventView),
      observedLedger:{semantics:'current_persisted_rows_not_historical_state_transitions',requestState:r.state,
        messages:e.messages.map(m=>({id:m.id,receivedAt:m.received_at,recvSeq:m.recv_seq})),
        decisions:e.planner.actions.map(({requestId,epoch,...a})=>a),
        deliveries:e.invalidScope?[]:e.deliveries.rows.map(d=>({id:d.id,batchId:d.batch_id,seq:d.seq,state:d.state,messageId:d.platform_msg_id,updatedAt:d.updated_at})),
        jobs:e.invalidScope?[]:e.jobs.rows.map(j=>({id:j.id,state:j.state,deliveryBatchId:j.delivery_batch_id,updatedAt:j.updated_at}))},
      latency:metric(e,account),truncated:e.events.truncated||e.planner.truncated||e.deliveries.truncated||e.jobs.truncated,
      unknown:['unrecorded_historical_state_transitions','live_config_and_memory_are_not_historical_facts',...(e.invalidScope?['ledger_scope_mismatch']:[])]})
  }
  function requestLatency(requestId) {
    const account=current()
    return metric(evidence(ownedRequest(String(requestId),account),account),account)
  }
  /** Newest bounded request window, by createdAt (inclusive from/to epoch ms).
   * Percentiles use nearest rank; absent/unknown/incomplete samples stay null.
   * Read methods have no clock, network, hub, planner or outbox side effects.
   */
  function latencies({chatId,limit:n,from,to}={}) {
    from=from===undefined||from===''?undefined:Number(from)
    to=to===undefined||to===''?undefined:Number(to)
    for(const value of [from,to])if(value!==undefined&&(!Number.isSafeInteger(value)||value<0))throw new Error('from/to 必须是毫秒时间戳')
    if(from!==undefined&&to!==undefined&&from>to)throw new Error('from 不能晚于 to')
    const account=current(),max=bounded(n,DIAGNOSTICS_LIMITS.requests,40)
    const rows=db.all(`SELECT r.id FROM requests r WHERE
      CASE WHEN json_valid(r.source_message_ids_json) AND length(r.source_message_ids_json)<=8192 THEN EXISTS (
        SELECT 1 FROM json_each(r.source_message_ids_json) s JOIN messages m ON m.id=s.value WHERE m.account_id=?) ELSE 0 END
      ${chatId?'AND r.chat_id=?':''} ${from!==undefined?'AND r.created_at>=?':''} ${to!==undefined?'AND r.created_at<=?':''}
      ORDER BY r.created_at DESC,r.id DESC LIMIT ?`,account,...(chatId?[String(chatId)]:[]),...(from!==undefined?[from]:[]),...(to!==undefined?[to]:[]),max+1)
    const items=[];let excluded=0
    for(const row of rows.slice(0,max)) {
      let owned
      try {owned=ownedRequest(row.id,account)}catch{excluded++;continue}
      items.push(metric(evidence(owned,account),account))
    }
    const metrics={}
    for(const key of ['firstDecision','firstConfirmedReply','finalDelivery']) {
      const values=items.map(i=>i.latencyMs[key]).filter(finite).sort((a,b)=>a-b)
      const percentile=p=>values.length?values[Math.ceil(values.length*p)-1]:null
      metrics[key]={sampleCount:values.length,missingCount:items.length-values.length,p50Ms:percentile(.5),p95Ms:percentile(.95)}
    }
    return {schemaVersion:1,account,window:{chatId:chatId||null,from:from??null,to:to??null,limit:max,order:'request.createdAt DESC, id DESC',truncated:rows.length>max},
      percentileMethod:'nearest-rank',timeBasis:'local_received_at_to_persisted_event_or_QQ_receipt',requestCount:items.length,excluded,metrics,items}
  }
  return {record,summary,requests,timeline,decisions,replay,requestLatency,latencies,
    export:()=>({schemaVersion:1,createdAt:Date.now(),summary:summary(),config:publicConfig(getConfig()),requests:requests({limit:40}),decisions:decisions({limit:40})}),dispose:()=>{stopped=true;histogram.disable()}}
}

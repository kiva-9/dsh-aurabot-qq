import { randomUUID } from 'node:crypto'

/** Local accounting evidence; never infers a currency amount from tokens or status. */
export function createUsageLedger({storage,getAccount}) {
  const db=storage.db
  db.run(`CREATE TABLE IF NOT EXISTS service_calls (
    id TEXT PRIMARY KEY,account_id TEXT NOT NULL,chat_id TEXT,request_id TEXT,service TEXT NOT NULL,
    model TEXT,role TEXT,status TEXT NOT NULL,billing TEXT NOT NULL,started_at INTEGER NOT NULL,
    duration_ms REAL,input_tokens REAL,output_tokens REAL,cached_tokens REAL,input_count REAL,input_chars REAL,
    credits REAL,amount REAL,currency TEXT)`)
  db.run('CREATE INDEX IF NOT EXISTS service_calls_request ON service_calls(account_id,request_id,started_at)')
  db.run('CREATE TABLE IF NOT EXISTS service_call_requests (call_id TEXT NOT NULL,request_id TEXT NOT NULL,PRIMARY KEY(call_id,request_id))')
  const number=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null
  const short=v=>v==null?null:String(v).slice(0,150)
  function record(input={}) {
    const c=input.context||{},account=String(input.account||c.account||getAccount()),requestId=input.requestId||c.requestId||null
    let chatId=input.chatId||c.chatId||c.chat||null
    if(requestId){const r=storage.requests.get(requestId);if(!r||!r.sourceMessageIds.some(id=>storage.messages.get(id)?.account===account))return;chatId=r.chatId}
    const id=input.id||randomUUID(),at=number(input.startedAt)??Date.now()
    const tokens=input.tokens||input.usage||{}
    db.run('INSERT OR IGNORE INTO service_calls VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      String(id),account,short(chatId),short(requestId),short(input.service||'llm'),short(input.model),short(input.role||c.role),
      short(input.status||'unknown'),short(input.billing||'unknown'),at,number(input.durationMs),
      number(input.inputTokens??tokens.inputTokens??tokens.input_tokens??tokens.prompt_tokens),
      number(input.outputTokens??tokens.outputTokens??tokens.output_tokens??tokens.completion_tokens),
      number(input.cachedTokens??tokens.cachedTokens??tokens.cacheReadTokens??tokens.cache_read_input_tokens),
      number(input.inputCount),number(input.inputChars),number(input.credits),number(input.amount),short(input.currency))
    for(const request of new Set([requestId,...(input.requestIds||[])].filter(Boolean))){
      const r=storage.requests.get(request)
      if(r&&r.chatId===chatId&&r.sourceMessageIds.some(mid=>storage.messages.get(mid)?.account===account))
        db.run('INSERT OR IGNORE INTO service_call_requests VALUES (?,?)',String(id),String(request))
    }
    return id
  }
  function report({requestId,chatId,limit=50}={}){
    const where='account_id=?'+(requestId?' AND id IN (SELECT call_id FROM service_call_requests WHERE request_id=?)':'')+(chatId?' AND chat_id=?':'')
    const args=[String(getAccount()),...(requestId?[String(requestId)]:[]),...(chatId?[String(chatId)]:[])]
    const totals=db.all(`SELECT service,COUNT(*) calls,SUM(input_tokens) inputTokens,SUM(output_tokens) outputTokens,SUM(cached_tokens) cachedTokens,SUM(credits) credits,SUM(CASE WHEN amount IS NULL THEN 1 ELSE 0 END) unknownAmountCalls FROM service_calls WHERE ${where} GROUP BY service`,...args)
    const amounts=db.all(`SELECT currency,SUM(amount) amount FROM service_calls WHERE ${where} AND amount IS NOT NULL AND currency IS NOT NULL GROUP BY currency`,...args)
    const items=db.all(`SELECT id,chat_id chatId,request_id requestId,service,model,role,status,billing,started_at startedAt,duration_ms durationMs,input_tokens inputTokens,output_tokens outputTokens,cached_tokens cachedTokens,input_count inputCount,input_chars inputChars,credits,amount,currency FROM service_calls WHERE ${where} ORDER BY started_at DESC LIMIT ?`,...args,Math.max(1,Math.min(200,Number(limit)||50)))
    const jw="COALESCE(json_extract(j.input_json,'$.accountId'),json_extract(j.input_json,'$.scope.account'))=? AND j.kind IN ('image','song')"+(requestId?' AND j.request_id=?':'')+(chatId?' AND j.chat_id=?':'')
    const taskTotals=db.all(`SELECT j.kind service,COUNT(*) calls,COUNT(*) unknownAmountCalls FROM job_attempts a JOIN jobs j ON j.id=a.job_id WHERE ${jw} GROUP BY j.kind`,...args)
    const taskItems=db.all(`SELECT a.id,j.chat_id chatId,j.request_id requestId,j.kind service,a.state status,a.billing,a.started_at startedAt,a.finished_at-a.started_at durationMs FROM job_attempts a JOIN jobs j ON j.id=a.job_id WHERE ${jw} ORDER BY a.started_at DESC LIMIT ?`,...args,Math.max(1,Math.min(200,Number(limit)||50)))
    return {totals:[...totals,...taskTotals],amounts,items:[...items,...taskItems].sort((a,b)=>b.startedAt-a.startedAt).slice(0,Math.max(1,Math.min(200,Number(limit)||50))),note:'仅记录服务返回的用量与金额；空值表示未提供，不能解释成免费。共享批次调用会关联各参与请求，但总账只计一次。后台调用可能不属于单个用户请求。'}
  }
  return {record,report}
}

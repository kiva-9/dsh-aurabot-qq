import { randomUUID } from 'node:crypto'

export const RANGES = ['today', '7d', '30d', 'all']
const DAY_MS = 86_400_000
const SHANGHAI_MS = 8 * 3_600_000 // 自然日固定按 UTC+8 算，不采用历史夏令时

/** today / 7d / 30d（含今天的自然日）/ all → [from, to)。 */
export function rangeWindow(range, now = Date.now()) {
  if (!RANGES.includes(range)) throw new Error('range 不对')
  const today = Math.floor((now + SHANGHAI_MS) / DAY_MS) * DAY_MS - SHANGHAI_MS
  const from = range === 'all' ? 0 : today - ({ today: 0, '7d': 6, '30d': 29 })[range] * DAY_MS
  return { from, to: now + 1 }
}

const GROUP_KEYS = { none: null, day: "strftime('%Y-%m-%d', started_at / 1000, 'unixepoch', '+8 hours')", model: "COALESCE(NULLIF(model, ''), '(unknown)')",
  role: "COALESCE(NULLIF(role, ''), '(unknown)')", provider: "COALESCE(NULLIF(provider, ''), '(unknown)')" }
// DSH 的 inputTokens 是未命中缓存的输入，缓存读取要单独加回；embedding 接口的 prompt_tokens 已含缓存，不能重复加。
const TOKEN_COLUMNS = `COUNT(*) calls,
  COALESCE(SUM(input_tokens IS NOT NULL OR output_tokens IS NOT NULL OR cached_tokens IS NOT NULL), 0) callsWithUsage,
  COALESCE(SUM(usage_complete = 0 OR input_tokens IS NULL OR (service = 'llm' AND output_tokens IS NULL)), 0) incompleteCalls,
  COALESCE(SUM(input_tokens), 0) inputTokens, COALESCE(SUM(output_tokens), 0) outputTokens, COALESCE(SUM(cached_tokens), 0) cachedTokens,
  COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) + COALESCE(SUM(CASE WHEN service = 'llm' THEN cached_tokens END), 0) totalTokens`
const TOKEN_NOTE = '只统计服务返回的 token 用量；合计包含缓存读取，缺失值不计入合计，不做费用推算。'
const DASHBOARD_NOTE = '只统计 LLM 和 embedding 服务返回的 token；LLM 合计加上缓存读取，embedding 缓存已包含在输入中，不重复计算；缺失值不计入合计，不做费用推算。'
const DASHBOARD_RANGES = [...RANGES, 'custom']
const MAX_DASHBOARD_MONTHS = 1200
const DASHBOARD_COLUMNS = `${TOKEN_COLUMNS}, COUNT(input_tokens) inputCallsWithUsage,
  COUNT(output_tokens) outputCallsWithUsage, COUNT(cached_tokens) cachedCallsWithUsage`
const ZERO_TOKENS = { calls: 0, callsWithUsage: 0, incompleteCalls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0,
  inputCallsWithUsage: 0, outputCallsWithUsage: 0, cachedCallsWithUsage: 0 }

// 日期参数只能是存在的 UTC+8 自然日。不要依赖 Date.parse 的宽松归一化（如 2 月 30 日）。
function dashboardDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError('日期必须是 YYYY-MM-DD')
  const [year, month, day] = value.split('-').map(Number)
  if (year < 1970 || year > 9999) throw new RangeError('日期年份须在 1970 至 9999 之间')
  const utc = Date.UTC(year, month - 1, day), date = new Date(utc)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new RangeError('日期不存在')
  return utc - SHANGHAI_MS
}
const shanghaiDay = (time) => Math.floor((time + SHANGHAI_MS) / DAY_MS) * DAY_MS - SHANGHAI_MS
const monthNumber = (time) => {
  const date = new Date(time + SHANGHAI_MS)
  return date.getUTCFullYear() * 12 + date.getUTCMonth()
}
const dateKey = (time) => {
  const date = new Date(time + SHANGHAI_MS)
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}
const monthKey = (month) => `${String(Math.floor(month / 12)).padStart(4, '0')}-${String(month % 12 + 1).padStart(2, '0')}`

/** Local accounting evidence; never infers a currency amount from tokens or status. */
export function createUsageLedger({storage,getAccount}) {
  const db=storage.db
  db.run(`CREATE TABLE IF NOT EXISTS service_calls (
    id TEXT PRIMARY KEY,account_id TEXT NOT NULL,chat_id TEXT,request_id TEXT,service TEXT NOT NULL,
    model TEXT,role TEXT,status TEXT NOT NULL,billing TEXT NOT NULL,started_at INTEGER NOT NULL,
    duration_ms REAL,input_tokens REAL,output_tokens REAL,cached_tokens REAL,input_count REAL,input_chars REAL,
    credits REAL,amount REAL,currency TEXT)`)
  db.run('CREATE INDEX IF NOT EXISTS service_calls_request ON service_calls(account_id,request_id,started_at)')
  db.run('CREATE INDEX IF NOT EXISTS service_calls_account_time ON service_calls(account_id,started_at)')
  db.run('CREATE INDEX IF NOT EXISTS service_calls_chat_time ON service_calls(chat_id,started_at)')
  db.run('CREATE TABLE IF NOT EXISTS service_call_requests (call_id TEXT NOT NULL,request_id TEXT NOT NULL,PRIMARY KEY(call_id,request_id))')
  db.run(`CREATE TABLE IF NOT EXISTS service_call_outcomes(
    call_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,chat_id TEXT,status TEXT NOT NULL,error TEXT)`)
  const columns = new Set(db.all('PRAGMA table_info(service_calls)').map(c => c.name))
  for (const [name, type] of Object.entries({ provider: 'TEXT', finished_at: 'INTEGER', attempts: 'INTEGER', usage_complete: 'INTEGER',
    business_status: 'TEXT', business_error: 'TEXT', operation_id: 'TEXT', stage: 'TEXT', source_ids_json: 'TEXT', error_code: 'TEXT', finish_reason: 'TEXT' })) {
    if (!columns.has(name)) db.run(`ALTER TABLE service_calls ADD COLUMN ${name} ${type}`)
  }
  const number=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null
  const short=v=>v==null?null:String(v).slice(0,150)
  function record(input={}) {
    const c=input.context||{},account=String(input.account||c.account||getAccount()),requestId=input.requestId||c.requestId||null
    let chatId=input.chatId||c.chatId||c.chat||null
    if (input.phase === 'business') {
      if (!input.id || !['success','failed','discarded'].includes(input.businessStatus)) return
      // Cancellation can settle the domain before the model's finally observer runs.
      db.run('INSERT OR IGNORE INTO service_call_outcomes VALUES (?,?,?,?,?)',String(input.id),account,short(chatId),input.businessStatus,short(input.businessError))
      db.run('UPDATE service_calls SET business_status=?,business_error=? WHERE id=? AND account_id=? AND chat_id IS ?',
        input.businessStatus,short(input.businessError),String(input.id),account,short(chatId))
      return input.id
    }
    if(requestId){const r=storage.requests.get(requestId);if(!r||!r.sourceMessageIds.some(id=>storage.messages.get(id)?.account===account))return;chatId=r.chatId}
    const id=input.id||randomUUID(),duration=number(input.durationMs ?? input.duration),finished=number(input.finishedAt)??Date.now()
    // Older producers supply only duration; never label settlement as the start of a known-duration call.
    const at=number(input.startedAt)??Math.max(0,finished-(duration??0))
    const tokens=input.tokens||input.usage||{}
    db.run(`INSERT OR IGNORE INTO service_calls
      (id,account_id,chat_id,request_id,service,model,role,status,billing,started_at,duration_ms,input_tokens,output_tokens,cached_tokens,input_count,input_chars,credits,amount,currency,
       provider,finished_at,attempts,usage_complete,operation_id,stage,source_ids_json,error_code,finish_reason)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      String(id),account,short(chatId),short(requestId),short(input.service||'llm'),short(input.model),short(input.role||c.role),
      short(input.status||'unknown'),short(input.billing||'unknown'),at,duration,
      number(input.inputTokens??tokens.inputTokens??tokens.input_tokens??tokens.prompt_tokens),
      number(input.outputTokens??tokens.outputTokens??tokens.output_tokens??tokens.completion_tokens),
      number(input.cachedTokens??tokens.cachedTokens??tokens.cacheReadTokens??tokens.cache_read_input_tokens),
      number(input.inputCount),number(input.inputChars),number(input.credits),number(input.amount),short(input.currency),
      short(input.provider),finished,number(input.attempts),typeof input.usageComplete==='boolean'?Number(input.usageComplete):null,
      short(input.operationId),short(input.stage),JSON.stringify([...(new Set(Array.isArray(input.sourceMessageIds)?input.sourceMessageIds:[]))].filter(mid => {
        if(typeof mid!=='string') return false
        const m=storage.messages.get(mid);return m?.account===account&&m.chatId===chatId
      }).slice(0,100)),short(input.errorCode),short(input.finishReason))
    const outcome=db.get('SELECT status,error FROM service_call_outcomes WHERE call_id=? AND account_id=? AND chat_id IS ?',String(id),account,short(chatId))
    if(outcome) db.run('UPDATE service_calls SET business_status=?,business_error=? WHERE id=? AND account_id=?',outcome.status,outcome.error,String(id),account)
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
    const items=db.all(`SELECT id,chat_id chatId,request_id requestId,service,model,role,status,billing,started_at startedAt,duration_ms durationMs,input_tokens inputTokens,output_tokens outputTokens,cached_tokens cachedTokens,input_count inputCount,input_chars inputChars,credits,amount,currency,
      provider,finished_at finishedAt,attempts,usage_complete usageComplete,business_status businessStatus,business_error businessError,operation_id operationId,stage,source_ids_json sourceMessageIds,error_code errorCode,finish_reason finishReason
      FROM service_calls WHERE ${where} ORDER BY started_at DESC LIMIT ?`,...args,Math.max(1,Math.min(200,Number(limit)||50)))
      .map(item=>({...item,usageComplete:item.usageComplete==null?null:Boolean(item.usageComplete),sourceMessageIds:JSON.parse(item.sourceMessageIds||'[]')}))
    const jw="COALESCE(json_extract(j.input_json,'$.accountId'),json_extract(j.input_json,'$.scope.account'))=? AND j.kind IN ('image','song')"+(requestId?' AND j.request_id=?':'')+(chatId?' AND j.chat_id=?':'')
    const taskTotals=db.all(`SELECT j.kind service,COUNT(*) calls,COUNT(*) unknownAmountCalls FROM job_attempts a JOIN jobs j ON j.id=a.job_id WHERE ${jw} GROUP BY j.kind`,...args)
    const taskItems=db.all(`SELECT a.id,j.chat_id chatId,j.request_id requestId,j.kind service,a.state status,a.billing,a.started_at startedAt,a.finished_at-a.started_at durationMs FROM job_attempts a JOIN jobs j ON j.id=a.job_id WHERE ${jw} ORDER BY a.started_at DESC LIMIT ?`,...args,Math.max(1,Math.min(200,Number(limit)||50)))
    return {totals:[...totals,...taskTotals],amounts,items:[...items,...taskItems].sort((a,b)=>b.startedAt-a.startedAt).slice(0,Math.max(1,Math.min(200,Number(limit)||50))),note:'仅记录服务返回的用量与金额；空值表示未提供，不能解释成免费。共享批次调用会关联各参与请求，但总账只计一次。后台调用可能不属于单个用户请求。'}
  }
  /** 只读汇总 token；不读金额。chatId 不传就是整个账号（含 chat_id 为空的后台调用）。 */
  function aggregate({account=getAccount(),chatId,from=0,to=Date.now()+1,groupBy='none',range}={}) {
    if(!(groupBy in GROUP_KEYS)) throw new Error('groupBy 不对')
    const where='account_id=? AND started_at>=? AND started_at<?'+(chatId?' AND chat_id=?':''), args=[String(account),from,to,...(chatId?[String(chatId)]:[])]
    const key=GROUP_KEYS[groupBy]
    return {account:String(account),chatId:chatId||null,from,to,range,
      totals:{...db.get(`SELECT ${TOKEN_COLUMNS} FROM service_calls WHERE ${where}`,...args)},
      buckets:key?db.all(`SELECT ${key} key,${TOKEN_COLUMNS} FROM service_calls WHERE ${where} GROUP BY key ORDER BY key`,...args):[],
      generatedAt:Date.now(),note:TOKEN_NOTE}
  }
  /** 仪表盘的总计、模型和趋势共用同一条只读查询；区间右边界不包含。 */
  function dashboard({ range = '7d', chatId, startDate, endDate, now = Date.now() } = {}) {
    if (!DASHBOARD_RANGES.includes(range)) throw new RangeError('range 不对')
    if (!Number.isFinite(now) || !Number.isSafeInteger(now) || now < 0) throw new RangeError('当前时间不对')
    if (chatId != null && typeof chatId !== 'string') throw new RangeError('chatId 不对')
    const account = String(getAccount()), hasChat = Boolean(chatId)
    let from, to
    if (range === 'custom') {
      from = dashboardDate(startDate)
      const end = dashboardDate(endDate)
      if (end < from) throw new RangeError('结束日期不能早于开始日期')
      to = end + DAY_MS
    } else {
      ({ from, to } = rangeWindow(range, now))
    }

    const filter = "account_id=? AND started_at>=? AND started_at<? AND service IN ('llm','embedding')" + (hasChat ? ' AND chat_id=?' : '')
    const args = () => [account, from, to, ...(hasChat ? [chatId] : [])]
    if (range === 'all') {
      const first = db.get(`SELECT MIN(started_at) first FROM service_calls WHERE ${filter}`, ...args()).first
      // 无匹配记录不从 1970 年开始补点。
      if (first == null) return { range, from, to, timeZone: 'Etc/GMT-8', generatedAt: now, note: DASHBOARD_NOTE,
        totals: { ...ZERO_TOKENS }, models: [], trend: { granularity: 'day', points: [] } }
      from = shanghaiDay(first)
    }

    const firstMonth = monthNumber(from), lastMonth = monthNumber(to - 1)
    if (lastMonth - firstMonth + 1 > MAX_DASHBOARD_MONTHS) throw new RangeError('时间范围不能超过 1200 个自然月')
    const granularity = Math.ceil((to - from) / DAY_MS) > 366 ? 'month' : 'day'
    // 先截取整秒：SQLite 的浮点日期转换可能把末秒的亚毫秒四舍五入到次日。
    const timeKey = granularity === 'month'
      ? "strftime('%Y-%m', CAST(started_at / 1000 AS INTEGER), 'unixepoch', '+8 hours')"
      : "strftime('%Y-%m-%d', CAST(started_at / 1000 AS INTEGER), 'unixepoch', '+8 hours')"
    // 每个分组都来自相同的 SQLite 语句快照；输入值只作为绑定参数，不拼入 SQL。
    const rows = db.all(`WITH filtered AS (
      SELECT service,model,started_at,input_tokens,output_tokens,cached_tokens,usage_complete FROM service_calls WHERE ${filter}
    )
    SELECT 'total' kind,NULL key,${DASHBOARD_COLUMNS} FROM filtered
    UNION ALL SELECT 'model' kind,${GROUP_KEYS.model} key,${DASHBOARD_COLUMNS} FROM filtered GROUP BY key
    UNION ALL SELECT 'trend' kind,${timeKey} key,${DASHBOARD_COLUMNS} FROM filtered GROUP BY key`, ...args())
    const counts = ({ kind, key, ...values }) => values
    const totals = counts(rows.find(row => row.kind === 'total'))
    const models = rows.filter(row => row.kind === 'model').map(row => ({ key: row.key, ...counts(row) }))
      .sort((a, b) => b.totalTokens - a.totalTokens || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const grouped = new Map(rows.filter(row => row.kind === 'trend').map(row => [row.key, counts(row)]))
    const points = []
    if (granularity === 'day') {
      for (let day = from; day < to; day += DAY_MS) {
        const key = dateKey(day)
        points.push({ key, ...(grouped.get(key) || ZERO_TOKENS) })
      }
    } else {
      for (let month = firstMonth; month <= lastMonth; month++) {
        const key = monthKey(month)
        points.push({ key, ...(grouped.get(key) || ZERO_TOKENS) })
      }
    }
    return { range, from, to, timeZone: 'Etc/GMT-8', generatedAt: now, note: DASHBOARD_NOTE, totals, models, trend: { granularity, points } }
  }
  return {record,report,aggregate,dashboard}
}

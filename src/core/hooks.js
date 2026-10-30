// Cooperative boundaries for trusted extensions. This does not sandbox JS.
const text = value => typeof value === 'string'
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const oneOf = values => value => values.includes(value)
const array = value => Array.isArray(value) && value.length <= 200
const decisions = value => object(value) && Object.keys(value).every(k => ['reply','mode','reason'].includes(k)) &&
  typeof value.reply === 'boolean' && (!value.mode || ['must','interject','engaged','none'].includes(value.mode)) && (!value.reason || text(value.reason))
const content = value => array(value) && value.every(v => object(v) && ['text','image'].includes(v.type) && (v.type !== 'text' || text(v.text)))
const items = value => array(value) && value.every(v => object(v) && ['text','voice','sticker','image','poke'].includes(v.kind) &&
  (v.kind === 'poke' || text(v.value) || (v.kind === 'sticker' && object(v.value))) &&
  (v.kind !== 'image' || /^(https?:\/\/|asset:)/i.test(v.value)))
const segments = value => array(value) && value.every(v => object(v) && text(v.type) && object(v.data) &&
  (v.type === 'file' || !v.data.file || /^(https?:\/\/|asset:|base64:\/\/)/i.test(v.data.file)))
const selection = value => object(value) && Object.keys(value).every(k => ['provider','model','reasoningEffort','reasoning','effort'].includes(k))

const spec = (mode, stage, validate, extra = {}) => Object.freeze({ apiVersion: 2, mode, stage, timeoutMs: 5000, failure: 'continue', canAbort: mode !== 'observe', validate, ...extra })
export const HOOK_SPECS = Object.freeze({
  message: spec('claim','ingress',oneOf([true,false,undefined]),{modifies:[],failure:'continue'}),
  poke: spec('claim','ingress',oneOf([true,false,undefined]),{modifies:[]}),
  'group/decide': spec('filter','decision',decisions,{modifies:['reply','mode','reason']}),
  prompt: spec('filter','before-model',content,{modifies:['content'],failure:'abort'}),
  'context/prepare': spec('observe','before-model',()=>true,{modifies:[],timeoutMs:10000}),
  reply: spec('filter','before-delivery',text,{modifies:['text']}),
  'reply/items': spec('filter','before-delivery',items,{modifies:['items'],failure:'abort'}),
  send: spec('filter','transport',segments,{modifies:['message'],failure:'abort'}),
  model: spec('sync','before-model',selection,{modifies:['provider','model','reasoningEffort']}),
  persona: spec('sync','before-model',text,{modifies:['text']}),
  rules: spec('sync','before-model',text,{modifies:['text']}),
  activity: spec('observe','after-delivery',()=>true,{modifies:[]}),
  onebot: spec('observe','ingress',()=>true,{modifies:[]}),
  'onebot/state': spec('observe','lifecycle',()=>true,{modifies:[]}),
})
const observation = spec('observe','after-event',()=>true,{modifies:[]})
export const hookSpec = event => HOOK_SPECS[event] || observation
export const hookCatalog = () => Object.entries(HOOK_SPECS).map(([event,{validate,...s}])=>({event,...s}))

export function snapshot(value, freeze = true, seen = new WeakMap()) {
  if (!value || typeof value !== 'object') return typeof value === 'function' ? undefined : value
  if (seen.has(value)) return seen.get(value)
  if (Buffer.isBuffer(value)) return Buffer.from(value)
  if (value instanceof AbortSignal) return value
  const out = Array.isArray(value) ? [] : {}
  seen.set(value,out)
  for (const [k,v] of Object.entries(value)) out[k] = snapshot(v,freeze,seen)
  return freeze ? Object.freeze(out) : out
}

export function createHookRuntime({ listeners, live, epochs, note, now = Date.now, isDisposed = () => false }) {
  const events = [], aggregates = new Map()
  const sorted = event => [...(listeners.get(event) || [])].sort((a,b)=>(a.phase||0)-(b.phase||0)||(a.priority||0)-(b.priority||0)||a.id.localeCompare(b.id)||(a.order||0)-(b.order||0))
  const valid = item => !isDisposed() && (item.id === '@core' || live.get(item.id) === item.record)
  const findChat = args => args.map(v=>v?.chatId || v?.chat?.chatId || v?.msg?.chatId).find(Boolean)
  function guard(item,args) {
    const chat = findChat(args), epoch = chat && epochs?.current(chat)
    return () => valid(item) && (!chat || !epochs || epochs.current(chat) === epoch)
  }
  function record(item,event,start,error) {
    const durationMs = now()-start, key=item.id+':'+event
    const old=aggregates.get(key)||{module:item.id,event,calls:0,failures:0,totalMs:0,maxMs:0}
    old.calls++;old.totalMs+=durationMs;old.maxMs=Math.max(old.maxMs,durationMs);if(error)old.failures++
    aggregates.set(key,old)
    events.unshift({module:item.id,event,at:now(),durationMs,ok:!error,code:error?.code||null})
    events.length=Math.min(events.length,200)
    if(error) note(item.id,'Hook '+event,error)
  }
  async function invoke(item,event,args) {
    const s=hookSpec(event), start=now(), active=guard(item,args), controller=new AbortController()
    let timer, error
    try {
      if(!active()) throw Object.assign(new Error('Hook 已失效'),{code:'STALE_HOOK'})
      const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Object.assign(new Error('Hook 超时'),{code:'HOOK_TIMEOUT'}))},item.timeoutMs||s.timeoutMs)})
      const result=await Promise.race([Promise.resolve().then(()=>item.fn(...args.map(a=>snapshot(a)),Object.freeze({signal:controller.signal,isCurrent:active}))),timeout])
      if(!active()) throw Object.assign(new Error('Hook 返回前会话或模块已变化'),{code:'STALE_HOOK'})
      if(result !== undefined && result !== null && !s.validate(result)) throw Object.assign(new Error('Hook 返回结构不符合 '+event+' 契约'),{code:'INVALID_HOOK_RESULT'})
      return {result}
    } catch(e) {error=e;return {error:e}} finally {clearTimeout(timer);controller.abort();record(item,event,start,error)}
  }
  function emit(event,...args) { for(const item of sorted(event)) if(valid(item)) void invoke(item,event,args) }
  async function prepare(event,...args) {
    for(const item of sorted(event)) { if(valid(item)) await invoke(item,event,args) }
  }
  async function claim(event,...args) {
    for(const item of sorted(event)) {if(!valid(item))continue;const r=await invoke(item,event,args);if(r.result === true)return true}
    return false
  }
  async function filter(event,value,...args) {
    let v=value
    for(const item of sorted(event)) {
      if(!valid(item))continue
      const r=await invoke(item,event,[v,...args])
      if(r.error) {if(hookSpec(event).failure==='abort'||r.error.code==='STALE_HOOK')return null;continue}
      if(r.result===null)return null
      if(r.result!==undefined)v=r.result
    }
    return v
  }
  function filterSync(event,value,...args) {
    let v=value
    for(const item of sorted(event)) {
      if(!valid(item))continue
      const start=now();let error
      try {
        const active=guard(item,args),r=item.fn(snapshot(v),...args.map(a=>snapshot(a)))
        if(r&&typeof r.then==='function'){r.catch(()=>{});throw Object.assign(new Error('同步 Hook 不接受 Promise'),{code:'ASYNC_SYNC_HOOK'})}
        if(!active())return null
        if(r===null)return null
        if(r!==undefined){if(!hookSpec(event).validate(r))throw Object.assign(new Error('Hook 返回结构无效'),{code:'INVALID_HOOK_RESULT'});v=r}
      }catch(e){error=e}finally{record(item,event,start,error)}
    }
    return v
  }
  return {emit,prepare,claim,filter,filterSync,diagnostics:()=>({specs:hookCatalog(),stats:[...aggregates.values()],recent:[...events]})}
}

// Persistent handoff from Planner waits to the conversation scheduler.
// A crash after dispatch begins is unknown; it must never replay a paid model turn.
const PREFIX = 'planner:inbox:'
export function createWakeInbox({ storage, getAccount, ready, validate, reserve, dispatch, release, log, now = Date.now, prefix = PREFIX }) {
  const { db, meta } = storage, running = new Set()
  let disposed = false, timer = null
  const rows = (state,limit=200) => db.all(`SELECT key,value FROM meta WHERE key GLOB ?${state ? " AND json_extract(value,'$.state')=?" : ''} ORDER BY key ${state ? 'ASC' : 'DESC'} LIMIT ?`, prefix+'*', ...(state?[state]:[]),limit).map(r=>({key:r.key,...JSON.parse(r.value)}))
  const save = (record, patch) => meta.set(prefix+record.event.id,{...record,...patch,updatedAt:now()})
  function accept(event, execution) {
    if(disposed) return {accepted:false,retryable:true}
    execution.assertActive()
    execution.commit(()=>{
      const key=prefix+event.id,old=meta.get(key)
      if(old) {
        if(JSON.stringify(old.event)!==JSON.stringify(event)) throw new Error('唤醒 ID 对应的事件发生改变')
        return
      }
      meta.set(key,{event:structuredClone(event),state:'queued',createdAt:now(),updatedAt:now()})
    })
    return {accepted:true}
  }
  function tick() {
    if(disposed||!ready())return
    for(const r of rows('queued',100)) {
      const ctx=r.event.context
      if(ctx.account!==String(getAccount()))continue
      try {validate(ctx)} catch(error) {save(r,{state:'canceled',error:error.message});continue}
      if(!reserve(ctx.chatId,r.event))continue
      save(r,{state:'dispatching'})
      const p=Promise.resolve().then(()=>dispatch(r.event)).then(()=>{
        if(!disposed)save(r,{state:'done'})
      },error=>{
        if(!disposed)save(r,{state:'unknown',error:String(error.message).slice(0,300)})
        log?.warn?.('等待唤醒结果未确认：',error.message)
        release(ctx.chatId)
      }).finally(()=>running.delete(p))
      running.add(p)
    }
  }
  function start() {
    if(disposed||timer)return
    let interrupted
    do {interrupted=rows('dispatching',100);for(const r of interrupted)save(r,{state:'unknown',error:'进程在交接中停止，禁止自动重放'})} while(interrupted.length===100)
    timer=setInterval(tick,500);timer.unref?.();tick()
  }
  function close() {disposed=true;clearInterval(timer);return Promise.allSettled([...running])}
  return {accept,tick,start,close,list:()=>rows().map(({key,...r})=>r)}
}

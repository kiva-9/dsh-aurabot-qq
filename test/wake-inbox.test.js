import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorage } from '../src/storage/index.js'
import { createWakeInbox } from '../src/runtime/wake-inbox.js'

function setup(t, overrides={}) {
  const dir=mkdtempSync(join(tmpdir(),'aurabot-wake-inbox-')),storage=createStorage({file:join(dir,'db.sqlite'),filesDir:join(dir,'assets')})
  const called=[],ex={assertActive(){},commit:fn=>storage.db.tx(fn)},event={id:'wake-test',context:{account:'900',chatId:'group:12',requestId:'request'},observations:[]}
  const opts={storage,getAccount:()=> '900',ready:()=>true,validate(){},reserve:()=>true,dispatch:async e=>{called.push(e.id)},release(){},...overrides}
  const inbox=createWakeInbox(opts)
  t.after(async()=>{await inbox.close();storage.close()})
  return {inbox,storage,event,ex,called,opts}
}
test('唤醒先持久接收并按事件ID去重；调度只执行一次',async t=>{
  const s=setup(t)
  assert.deepEqual(s.inbox.accept(s.event,s.ex),{accepted:true})
  s.inbox.accept(s.event,s.ex)
  assert.equal(s.storage.meta.get('planner:inbox:wake-test').state,'queued')
  s.inbox.tick();await new Promise(r=>setImmediate(r));s.inbox.tick()
  assert.deepEqual(s.called,['wake-test']);assert.equal(s.inbox.list()[0].state,'done')
})
test('普通消息占用调度器时保留等待；重新开启后恢复queued',async t=>{
  let allowed=false
  const s=setup(t,{reserve:()=>allowed})
  s.inbox.accept(s.event,s.ex);s.inbox.tick();assert.equal(s.called.length,0)
  await s.inbox.close()
  const restored=createWakeInbox({...s.opts,reserve:()=>allowed});t.after(()=>restored.close())
  allowed=true;restored.start();await new Promise(r=>setImmediate(r));assert.equal(s.called.length,1)
})
test('交接中崩溃和异常均保留unknown，禁止恢复后自动重放',async t=>{
  const s=setup(t,{dispatch:async()=>{throw new Error('uncertain')}})
  s.inbox.accept(s.event,s.ex);s.inbox.tick();await new Promise(r=>setImmediate(r))
  assert.equal(s.inbox.list()[0].state,'unknown')
  s.storage.meta.set('planner:inbox:wake-crash',{event:{...s.event,id:'wake-crash'},state:'dispatching'})
  s.inbox.start();assert.equal(s.inbox.list().find(x=>x.event.id==='wake-crash').state,'unknown')
})
test('迟到唤醒权限失效就取消，其他账号不会被当前账号消费',async t=>{
  const s=setup(t,{validate(){throw new Error('stale epoch')}})
  s.inbox.accept(s.event,s.ex);s.inbox.accept({...s.event,id:'other',context:{...s.event.context,account:'901'}},s.ex)
  s.inbox.tick();assert.equal(s.called.length,0)
  assert.equal(s.inbox.list().find(x=>x.event.id==='wake-test').state,'canceled')
  assert.equal(s.inbox.list().find(x=>x.event.id==='other').state,'queued')
})

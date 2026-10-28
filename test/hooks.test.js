import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHookRuntime } from '../src/core/hooks.js'

function harness() {
  const listeners = new Map(), live = new Map(), errors = []
  let epoch = 1
  const hooks = createHookRuntime({listeners, live, epochs:{current:()=>epoch},note:(...e)=>errors.push(e)})
  const add = (id,event,fn,options={}) => {
    const record = live.get(id) || {}; live.set(id,record)
    listeners.set(event,[...(listeners.get(event)||[]),{id,record,fn,...options}])
  }
  return {...hooks,add,errors,live,bump:()=>epoch++}
}
test('控制Hook按阶段/优先级/稳定ID串行执行，元数据不可改',async()=>{
  const h=harness(), info={chatId:'group:1',actorId:'owner',scope:{chat:'group:1'}}, order=[]
  h.add('z','reply',(text,meta)=>{order.push('z');assert.throws(()=>{meta.actorId='attacker'});return text+'z'})
  h.add('a','reply',text=>{order.push('a');return text+'a'})
  h.add('first','reply',text=>{order.push('first');return text+'1'},{priority:-1})
  assert.equal(await h.filter('reply','x',info),'x1az')
  assert.deepEqual(order,['first','a','z']);assert.equal(info.actorId,'owner')
})
test('发送控制超时fail closed；迟到结果不覆盖当前链路',async()=>{
  const h=harness();let finish
  h.add('slow','send',()=>new Promise(ok=>{finish=ok}),{timeoutMs:10})
  assert.equal(await h.filter('send',[{type:'text',data:{text:'hello'}}],{chatId:'group:1'}),null)
  finish([{type:'text',data:{text:'late'}}])
  assert.equal(h.diagnostics().recent[0].code,'HOOK_TIMEOUT')
})
test('会话epoch或模块实例变化后丢弃异步改写',async()=>{
  for(const mode of ['epoch','module']) {
    const h=harness();let finish, started
    const ready=new Promise(ok=>{started=ok})
    h.add('slow','reply',()=>new Promise(ok=>{finish=ok;started()}))
    const result=h.filter('reply','original',{chatId:'group:1'});await ready
    if(mode==='epoch')h.bump();else h.live.set('slow',{})
    finish('late');assert.equal(await result,null)
  }
})
test('普通Hook不得增加权限字段或可执行本地文件路径',async()=>{
  const h=harness()
  h.add('bad','group/decide',()=>({reply:true,mode:'must',actorId:'owner'}))
  const original={reply:false,mode:'none',reason:'quota'}
  assert.deepEqual(await h.filter('group/decide',original,{}),original)
  h.add('bad','send',()=>[{type:'image',data:{file:'file:///private/secret.png'}}])
  assert.equal(await h.filter('send',[],{}),null)
  assert.equal(h.errors.length,2)
})
test('观察者各收不可变快照，抛错进入诊断且不影响其他观察者',async()=>{
  const h=harness(), source={scope:{chat:'private:1'}};let observed
  h.add('bad','activity',v=>{v.scope.chat='group:2'})
  h.add('good','activity',v=>{observed=v.scope.chat})
  h.emit('activity',source)
  await new Promise(ok=>setImmediate(ok))
  assert.equal(source.scope.chat,'private:1');assert.equal(observed,'private:1');assert.equal(h.errors.length,1)
})

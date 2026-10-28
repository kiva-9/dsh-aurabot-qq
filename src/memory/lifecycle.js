import {fail,MemoryError} from './scope.js'

// Logical cancellation is independent of whether the host model transport can
// physically abort a request. A late answer never continues into domain storage.
export function createLifecycle({getAccount} = {}) {
  const controller=new AbortController()
  let stopped=false
  function assertActive(scope) {
    if(stopped) fail('MEMORY_STOPPED','记忆服务已停用')
    const current=getAccount?.()
    if(scope && current && String(current)!==scope.account) fail('ACCOUNT_CHANGED','提炼账号已经改变，丢弃旧账号的结果')
  }
  function waitFor(run,scope) {
    assertActive(scope)
    const signal=controller.signal
    return new Promise((resolve,reject)=>{
      let settled=false
      const finish=(error,value)=>{
        if(settled) return
        settled=true;signal.removeEventListener('abort',abort)
        if(error) reject(error);else resolve(value)
      }
      const abort=()=>finish(new MemoryError('MEMORY_STOPPED','记忆服务停用，异步结果已取消'))
      signal.addEventListener('abort',abort,{once:true})
      Promise.resolve().then(()=>{assertActive(scope);return run(signal)}).then(value=>{
        try {assertActive(scope);finish(null,value)} catch(error) {finish(error)}
      },error=>finish(error))
    })
  }
  function stop() {if(!stopped){stopped=true;controller.abort()}}
  return {assertActive,waitFor,stop,get stopped(){return stopped}}
}

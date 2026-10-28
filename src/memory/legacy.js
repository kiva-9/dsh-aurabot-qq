import {existsSync,readFileSync,statSync} from 'node:fs'
import {join,dirname,resolve} from 'node:path'
import {hash} from './scope.js'

// Runtime migration only. Tests supply a temp DB/legacyDir; no use of the user's
// implicit dataDir and no source file is ever renamed, rewritten or removed.
export function importLegacyQuarantine(repo, {legacyDir} = {}) {
  const {storage,db,now}=repo
  const base=legacyDir || (storage.db.file && storage.db.file !== ':memory:' ? dirname(resolve(storage.db.file)) : null)
  if (!base) return []
  const reports=[]
  for (const file of [...new Set([join(base,'memories.json'),join(base,'legacy','memories.json')])]) {
    const step='memory.legacy-quarantine.v1:'+hash(resolve(file))
    const previous=storage.meta.get(step)
    if (previous?.state==='done') {reports.push(previous);continue}
    if (!existsSync(file)) continue
    try {
      if (statSync(file).size>32*1024*1024) throw new Error('旧记忆文件超过 32MiB，需分批导入')
      const text=readFileSync(file,'utf8').replace(/^\uFEFF/,'')
      const payload=JSON.parse(text)
      if (!payload || typeof payload!=='object') throw new Error('旧记忆文件不是对象或数组')
      const entries=[]
      if (Array.isArray(payload)) for(const item of payload) entries.push({kind:'fact',payload:item})
      else {
        for(const item of payload.items || []) entries.push({kind:'fact',payload:item})
        for(const kind of ['profiles','insights','styles']) for(const [key,value] of Object.entries(payload[kind] || {})) entries.push({kind,key,payload:value})
        const other=Object.fromEntries(Object.entries(payload).filter(([key])=>!['items','profiles','insights','styles'].includes(key)))
        if(Object.keys(other).length) entries.push({kind:'legacy-metadata',payload:other})
      }
      const report={state:'done',source:file,records:entries.length,at:now(),contentHash:hash(payload)}
      db.tx(()=>{
        entries.forEach((entry,index)=>{
          const sourceKey=hash({step,index,entry}),id='legacy_'+sourceKey
          // Empty account/chat are deliberately unassigned, never a public scope.
          db.run("INSERT OR IGNORE INTO memory_quarantine(id,account,chat,persona,source_key,body,created_at) VALUES (?,'','','',?,?,?)",id,sourceKey,JSON.stringify(entry),now())
        })
        storage.meta.set(step,report)
      })
      reports.push(report)
    } catch(error) {
      const report={state:'pending',source:file,error:error.message,at:now()}
      storage.meta.set(step,report);reports.push(report)
    }
  }
  return reports
}

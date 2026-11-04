import {existsSync,readFileSync,statSync} from 'node:fs'
import {join,dirname,resolve} from 'node:path'
import {hash} from './scope.js'

const MAX_LEGACY_BYTES = 32 * 1024 * 1024

// Runtime migration only. Tests supply a temp DB/legacyDir; no use of the user's
// implicit dataDir and no source file is ever renamed, rewritten or removed.
//
// The step key intentionally stays path-based: source keys derived from it must
// remain stable across restarts so re-imports are idempotent. Change detection is
// carried by the stored content hash instead. A file that was imported once and
// later edited is re-scanned and its new entries are appended to quarantine.
export function importLegacyQuarantine(repo, {legacyDir} = {}) {
  const {storage,db,now}=repo
  const base=legacyDir || (storage.db.file && storage.db.file !== ':memory:' ? dirname(resolve(storage.db.file)) : null)
  if (!base) return []
  const reports=[]
  for (const file of [...new Set([join(base,'memories.json'),join(base,'legacy','memories.json')])]) {
    const step='memory.legacy-quarantine.v1:'+hash(resolve(file))
    const previous=storage.meta.get(step)
    if (!existsSync(file)) { if(previous) reports.push(previous); continue }
    try {
      const stat=statSync(file)
      if (!stat.isFile()) throw new Error('旧记忆路径不是普通文件')
      if (stat.size > MAX_LEGACY_BYTES) throw new Error('旧记忆文件超过 32MiB，需分批导入')
      const text=readFileSync(file,'utf8').replace(/^\uFEFF/,'')
      let payload
      try { payload=JSON.parse(text) } catch { throw new Error('旧记忆文件不是有效 JSON') }
      if (!payload || typeof payload!=='object') throw new Error('旧记忆文件不是对象或数组')
      const contentHash=hash(payload)
      if (previous?.state==='done' && previous.contentHash===contentHash) {reports.push(previous);continue}
      const entries=[]
      if (Array.isArray(payload)) for(const item of payload) entries.push({kind:'fact',payload:item})
      else {
        if (payload.items !== undefined && !Array.isArray(payload.items)) throw new Error('旧记忆 items 必须是数组')
        for(const item of payload.items || []) entries.push({kind:'fact',payload:item})
        for(const kind of ['profiles','insights','styles']) {
          const value=payload[kind]
          if (value === undefined) continue
          if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error(`旧记忆 ${kind} 必须是对象`)
          for(const [key,item] of Object.entries(value)) entries.push({kind,key,payload:item})
        }
        const other=Object.fromEntries(Object.entries(payload).filter(([key])=>!['items','profiles','insights','styles'].includes(key)))
        if(Object.keys(other).length) entries.push({kind:'legacy-metadata',payload:other})
      }
      const report={state:'done',source:file,records:entries.length,at:now(),contentHash,size:stat.size}
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

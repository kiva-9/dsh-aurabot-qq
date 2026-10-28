import {scopeOf,hash,fail,receipt} from './scope.js'
import {factFingerprint} from './contracts.js'
import {buildIndex,search} from './lexical.js'

const marks=items=>items.map(()=>'?').join(',')
const chunks=items=>Array.from({length:Math.ceil(items.length/400)},(_,i)=>items.slice(i*400,i*400+400))
export const deletionKey=(kind,key,scope)=>JSON.stringify([kind,key,scope.account,scope.chat,['message','fingerprint'].includes(kind)?'*':scope.persona])
const parse=row=>row ? JSON.parse(row.body) : null
const message=row=>({id:row.id,account:row.account_id,chatId:row.chat_id,authorId:row.author_id,authorName:row.author_name,
  text:row.text,eventKind:row.event_kind,platformMsgId:row.platform_msg_id,platformTime:row.platform_time,receivedAt:row.received_at,
  recvSeq:Number(row.recv_seq),segments:JSON.parse(row.segments_json || '[]'),replyTo:row.reply_to,forwards:JSON.parse(row.forwards_json || '[]'),recalledAt:row.recalled_at})
const clamp=(value,fallback,max)=>Number.isSafeInteger(Number(value)) && Number(value)>=0 ? Math.min(max,Number(value)) : fallback

/** One page shares all fact/evidence/message/tombstone reads. No per-fact SQL. */
export function readContext(db,roots,viewer) {
  const facts=new Map(roots.map(f=>[f.id,f])),sources=new Map(),evidence=new Map(),messages=new Map(),tombstones=new Map()
  const refs=[...new Set(roots.flatMap(f=>[...(f.possibleDuplicates || []),...(f.conflicts || []),...(f.supersedes || []),f.supersededBy].filter(Boolean)))].filter(id=>!facts.has(id))
  for(const id of refs) facts.set(id,null)
  for(const part of chunks(refs)) for(const row of db.all(`SELECT body FROM memory_facts WHERE account=? AND id IN (${marks(part)})`,viewer.account,...part)) {const f=parse(row);facts.set(f.id,f)}
  const allFacts=[...facts.values()].filter(Boolean)
  for(const f of allFacts) sources.set(f.id,[])
  for(const part of chunks(allFacts.map(f=>f.id))) for(const row of db.all(`SELECT fe.fact_id,fe.evidence_id,e.body FROM memory_fact_evidence fe LEFT JOIN memory_evidence e ON e.id=fe.evidence_id WHERE fe.fact_id IN (${marks(part)}) ORDER BY fe.fact_id,fe.evidence_id`,...part)) {
    sources.get(row.fact_id).push(row.evidence_id);evidence.set(row.evidence_id,parse(row))
  }
  const mids=[...new Set([...evidence.values()].filter(Boolean).map(e=>e.messageId).filter(Boolean))]
  for(const mid of mids) messages.set(mid,null)
  for(const part of chunks(mids)) for(const row of db.all(`SELECT * FROM messages WHERE account_id=? AND id IN (${marks(part)})`,viewer.account,...part)) messages.set(row.id,message(row))
  const keys={fact:allFacts.map(f=>f.id),fingerprint:[...new Set(allFacts.map(factFingerprint))],evidence:[...evidence.keys()],message:mids}
  for(const [kind,values] of Object.entries(keys)) for(const part of chunks(values)) {
    for(const row of db.all(`SELECT * FROM memory_tombstones WHERE account=? AND kind=? AND key IN (${marks(part)}) ORDER BY deleted_at DESC,rowid DESC`,viewer.account,kind,...part)) {
      const key=deletionKey(kind,row.key,row)
      if(!tombstones.has(key)) tombstones.set(key,parse(row))
    }
  }
  return {facts,sources,evidence,messages,tombstones}
}

export function createFactQueries({db,now,policy,visibilityStamp,revision,canRead,materialize}) {
  const cache=new Map();let builds=0,hits=0
  function filters(scope,options,p) {
    const categories=options.categories ?? (options.category ? [options.category] : ['fact','experience'])
    if(!Array.isArray(categories) || !categories.length || categories.some(c=>!['fact','experience'].includes(c))) fail('INVALID_QUERY','category 无效')
    const statuses=options.statuses ?? (options.status ? [options.status] : options.includeInactive ? ['active','conflicted','superseded','retracted'] : ['active'])
    if(!Array.isArray(statuses) || !statuses.length || statuses.some(s=>!['active','conflicted','superseded','retracted'].includes(s))) fail('INVALID_QUERY','status 无效')
    const params=[scope.account],conditions=['account=?'],branches=[],allChats=new Set()
    for(const category of [...new Set(categories)].sort()) {
      const chats=new Set([scope.chat])
      if(!options.ownScope) for(const group of p.shareGroups || []) {
        if((!group.account || group.account===scope.account) && group.categories?.includes(category) && group.chats?.includes(scope.chat)) {
          for(const chat of group.chats) if(typeof chat==='string' && /^(group|private):[\w-]+$/.test(chat)) chats.add(chat)
        }
      }
      branches.push(`(category=? AND chat IN (${marks([...chats])}))`);params.push(category,...[...chats].sort())
      for(const chat of chats) allChats.add(chat)
    }
    conditions.push('('+branches.join(' OR ')+')')
    conditions.push(`chat IN (${marks([...allChats])})`);params.push(...[...allChats].sort())
    conditions.push(`category IN (${marks(categories)})`);params.push(...categories)
    const personas=options.ownScope ? [scope.persona] : [...new Set(['',scope.persona])]
    conditions.push(`persona IN (${marks(personas)})`);params.push(...personas)
    const allowed=options.includeInactive ? statuses : statuses.filter(s=>s==='active')
    conditions.push(allowed.length ? `status IN (${marks(allowed)})` : '0');params.push(...allowed)
    if(options.subject!==undefined && options.subject!=='') {conditions.push("json_extract(body,'$.subject')=?");params.push(String(options.subject))}
    return {where:conditions.join(' AND '),params,statuses:allowed,categories}
  }
  const optionsKey=o=>({subject:o.subject || '',category:o.category || null,categories:o.categories || null,status:o.status || null,statuses:o.statuses || null,includeInactive:!!o.includeInactive,currentOnly:!!o.currentOnly,ownScope:!!o.ownScope,at:o.at ?? null,order:o.order || 'created'})
  function page(scopeInput,options={}) {
    const scope=scopeOf(scopeInput),p=policy(),stamp=visibilityStamp(scope),key=hash({scope,options:optionsKey(options)})
    const limit=clamp(options.limit,100,1000),order=options.order==='updated'?'updated_at':'created_at'
    let after=null,at=options.at ?? now()
    if(options.cursor) {
      let cursor
      try {cursor=JSON.parse(Buffer.from(options.cursor,'base64url').toString())} catch {fail('INVALID_CURSOR','分页游标无效')}
      if(cursor.v!==1 || cursor.key!==key || !Number.isSafeInteger(cursor.at) || !Number.isSafeInteger(cursor.time) || typeof cursor.id!=='string') fail('INVALID_CURSOR','游标不属于本次范围/查询')
      if(cursor.stamp!==stamp) fail('STALE_CURSOR','范围或来源修订已变化，请从第一页重新枚举')
      after=cursor;at=cursor.at
    }
    if(!Number.isSafeInteger(at) || at<0) fail('INVALID_QUERY','at 必须为毫秒时间戳')
    if(!limit) return receipt({items:[],nextCursor:null,done:true,scanned:0,visibilityStamp:stamp,revision:revision(scope)},scope)
    const f=filters(scope,options,p),conditions=[f.where],params=[...f.params]
    if(!options.includeInactive || options.currentOnly) {
      conditions.push("(json_extract(body,'$.validFrom') IS NULL OR json_extract(body,'$.validFrom')<=?) AND (json_extract(body,'$.validTo') IS NULL OR json_extract(body,'$.validTo')>?)");params.push(at,at)
    }
    if(after) {conditions.push(`(${order}<? OR (${order}=? AND id>?))`);params.push(after.time,after.time,after.id)}
    const rows=db.all(`SELECT body,${order} AS sort_time,id FROM memory_facts WHERE ${conditions.join(' AND ')} ORDER BY ${order} DESC,id ASC LIMIT ?`,...params,limit+1)
    const more=rows.length>limit,selected=rows.slice(0,limit),facts=selected.map(parse),read=readContext(db,facts,scope)
    const items=facts.filter(f=>canRead(f,scope,{...options,at:options.at ?? now(),policy:p,read})).map(f=>materialize(f,scope,p,read)).filter(Boolean)
    if(visibilityStamp(scope)!==stamp) fail('STALE_CURSOR','读取期间来源或范围已变化，请重试')
    const last=selected.at(-1),nextCursor=more && last ? Buffer.from(JSON.stringify({v:1,key,stamp,at,time:last.sort_time,id:last.id})).toString('base64url') : null
    return receipt({items,nextCursor,done:!nextCursor,scanned:selected.length,visibilityStamp:stamp,revision:revision(scope)},scope)
  }
  function enumerate(scope,options={}) {
    const limit=clamp(options.limit,300,5000),budget=clamp(options.scanLimit,Math.max(1000,limit*4),20000),items=[]
    let cursor=options.cursor || null,scanned=0,done=false
    while(items.length<limit && scanned<budget) {
      const result=page(scope,{...options,cursor,limit:Math.min(500,limit-items.length,budget-scanned)})
      items.push(...result.items);scanned+=result.scanned;cursor=result.nextCursor;done=result.done
      if(done) break
    }
    return {items,nextCursor:cursor,scanned,done}
  }
  function lexical(scopeInput,query,options={}) {
    const scope=scopeOf(scopeInput),stamp=visibilityStamp(scope),at=options.at ?? now()
    const key=hash({scope,options:optionsKey(options),currentOnly:!!options.currentOnly,candidateLimit:clamp(options.candidateLimit,5000,5000)})
    // A rolled-back transaction can reuse a revision number. Never retain a
    // corpus built from uncommitted rows, or reuse a pre-transaction corpus.
    const cacheable=!db.inTransaction
    let hit=cacheable ? cache.get(key) : null
    if(!hit || hit.stamp!==stamp || (options.at===undefined && hit.until<=at)) {
      const statuses=options.statuses ?? (options.includeInactive ? ['active','conflicted','superseded','retracted'] : ['active'])
      const result=enumerate(scope,{...options,includeInactive:true,statuses,currentOnly:false,q:undefined,limit:clamp(options.candidateLimit,5000,5000)})
      const current=result.items.filter(f=>(options.includeInactive && !options.currentOnly) || ((f.validFrom===null || f.validFrom<=at) && (f.validTo===null || f.validTo>at)))
      const docs=current.map(({evidence,sources,evidenceIds,evidenceMessageIds,...f})=>f)
      const boundary=result.items.flatMap(f=>[f.validFrom,f.validTo]).filter(t=>t!==null && t>at)
      hit={stamp,index:buildIndex(docs),until:boundary.length ? Math.min(...boundary) : Infinity,docs:docs.length,truncated:!result.done}
      if(cacheable) {cache.delete(key);cache.set(key,hit)}
      builds++
      while(cache.size>8 || [...cache.values()].reduce((n,e)=>n+e.docs,0)>20000) cache.delete(cache.keys().next().value)
    } else {hits++;cache.delete(key);cache.set(key,hit)}
    const ranked=search(hit.index,String(query || ''),{...options,now:at,limit:clamp(options.limit,6,5000)})
    // Re-read the ranked source facts and validate them in a bounded batch even
    // for a cache hit. Cached scoring is never authority to disclose a record.
    const ids=ranked.map(h=>h.it.id),facts=[]
    for(const part of chunks(ids)) for(const row of db.all(`SELECT body FROM memory_facts WHERE account=? AND id IN (${marks(part)})`,scope.account,...part)) facts.push(parse(row))
    const read=readContext(db,facts,scope),p=policy()
    const result=ranked.map(h=>{
      const f=read.facts.get(h.it.id)
      if(!f || !canRead(f,scope,{...options,at,policy:p,read})) return null
      if(options.currentOnly && ((f.validFrom!==null && f.validFrom>at) || (f.validTo!==null && f.validTo<=at))) return null
      return {...h,it:materialize(f,scope,p,read)}
    }).filter(Boolean)
    if(visibilityStamp(scope)!==stamp) fail('STALE_QUERY','检索期间范围或证据变化，请重试')
    return result
  }
  function list(scope,options={}) {return options.q ? lexical(scope,options.q,{...options,minScore:0.01,limit:clamp(options.limit,300,5000)}).map(h=>h.it) : enumerate(scope,options).items}
  return {page,list,lexical,clear:()=>cache.clear(),stats:()=>({builds,hits,entries:cache.size,documents:[...cache.values()].reduce((n,c)=>n+c.docs,0)})}
}

import { scopeOf, scopeKey, visible, receipt, fail, hash } from './scope.js'
import { PROFILE_SECTIONS, parseJson, exactKeys, ids, string } from './contracts.js'

export function createProfiles(repo, { generate, config = () => ({}), lifecycle } = {}) {
  const {db, now} = repo, inFlight = new Map()
  const cacheKey = (scope, subject) => scopeKey(scope) + ':' + subject
  function inputs(subject, scopeInput) {
    const scope = scopeOf(scopeInput), person = string(subject,'subject',200), p = repo.policy()
    const overrideRow = db.get('SELECT body,revision FROM memory_overrides WHERE scope_key=? AND subject=?',scopeKey(scope),person)
    const override = overrideRow ? JSON.parse(overrideRow.body) : { aliases:[],entries:[] }
    const manualIds=new Set((override.entries || []).flatMap(e=>e.factIds))
    let facts = repo.list(scope,{subject:person,includeInactive:true,statuses:['active','conflicted'],currentOnly:true,order:'updated',limit:200})
    const older=[...manualIds].filter(id=>!facts.some(f=>f.id===id))
    for(let start=0;start<older.length;start+=200) facts.push(...repo.getMany(older.slice(start,start+200),scope,{includeInactive:true}).filter(f=>f.subject===person))
    facts = facts
      .filter(f => ['active','conflicted'].includes(f.status) && (f.validFrom === null || f.validFrom <= now()) && (f.validTo === null || f.validTo > now()))
      .filter(f => visible(f.scope,scope,p,'profile') && f.evidence.every(e => visible(e.scope,scope,p,'profile')))
      .sort((a,b) => a.id.localeCompare(b.id))
    const cfg = config() || {}
    const maxFacts=Math.max(1,Math.min(100,cfg.maxFacts ?? 60))
    facts=facts.sort((a,b)=>Number(manualIds.has(b.id))-Number(manualIds.has(a.id)) || b.updatedAt-a.updatedAt || a.id.localeCompare(b.id)).slice(0,maxFacts).sort((a,b)=>a.id.localeCompare(b.id))
    const fingerprint = hash({ subject:person,scope,policy:p,facts:facts.map(f => ({
      id:f.id,revision:f.revision,text:f.text,subject:f.subject,predicate:f.predicate,value:f.value,speakerId:f.speakerId,
      polarity:f.polarity,modality:f.modality,conditions:f.conditions,status:f.status,stability:f.stability,
      eventTime:f.eventTime,validFrom:f.validFrom,validTo:f.validTo,scope:f.scope,aboutName:f.aboutName,profileSection:f.profileSection,
      evidence:f.evidence.map(e => ({id:e.id,revision:e.revision,contentHash:e.contentHash,scope:e.scope})).sort((a,b) => a.id.localeCompare(b.id))
    })),override,overrideRevision:overrideRow?.revision || 0,model:cfg.modelVersion || 'deterministic-v1',template:cfg.templateVersion || 'profile-v1' })
    return {scope,subject:person,facts,override,overrideRevision:Number(overrideRow?.revision || 0),fingerprint}
  }
  function confirmed(f) {
    return f.status === 'active' && f.modality === 'asserted' && f.stability !== 'uncertain' &&
      (f.subject === f.speakerId || f.evidence.some(e=>e.kind === 'manual' || e.kind === 'event'))
  }
  function sectionFor(f) {
    if (!confirmed(f)) return 'uncertain'
    if (f.stability === 'temporal') return 'recentInteractions'
    return f.profileSection === 'uncertain' ? 'uncertain' : f.profileSection
  }
  function deterministic(input) {
    const sections = Object.fromEntries(PROFILE_SECTIONS.map(s => [s,[]]))
    for (const f of input.facts) sections[sectionFor(f)].push({text:f.text,factIds:[f.id]})
    return sections
  }
  function validateSections(sections, input) {
    exactKeys(sections,PROFILE_SECTIONS,'profile sections')
    const available = new Map(input.facts.map(f => [f.id,f])), result = {}
    for (const key of PROFILE_SECTIONS) {
      const entries = sections[key] ?? []
      if (!Array.isArray(entries) || entries.length > 100) fail('INVALID_PROFILE','画像分类必须为有界数组')
      result[key] = entries.map(entry => {
        exactKeys(entry,['text','factIds'],'profile entry')
        const refs = ids(entry.factIds,'profile.factIds').map(id => available.get(id))
        if (refs.some(f => !f)) fail('INVALID_PROFILE','画像引用了不可见或过期事实')
        if (key !== 'uncertain' && refs.some(f => !confirmed(f))) fail('INVALID_PROFILE','不确定、转述、计划或争议不能变成确认画像')
        if (['identity','relationships','stableFacts','preferences'].includes(key) && refs.some(f => f.stability !== 'stable')) fail('INVALID_PROFILE','临时内容不能升级成稳定画像')
        return {text:string(entry.text,'profile.text',1000),factIds:refs.map(f => f.id),
          evidenceIds:[...new Set(refs.flatMap(f => f.evidenceIds))].sort(),dates:refs.map(f=>f.eventTime ?? f.createdAt),confirmed:key !== 'uncertain' && refs.every(confirmed),manual:false}
      })
    }
    return result
  }
  function profileOf(subject, options = {}) {
    const input = inputs(subject,options)
    const row = db.get('SELECT fingerprint,body FROM memory_profiles WHERE scope_key=? AND subject=?',scopeKey(input.scope),input.subject)
    if (!row || row.fingerprint !== input.fingerprint) {
      if (row) db.run('DELETE FROM memory_profiles WHERE scope_key=? AND subject=?',scopeKey(input.scope),input.subject)
      return null
    }
    const cached = JSON.parse(row.body)
    cached.override = visibleOverride(input)
    if (!options.includeUncertain) cached.sections.uncertain = []
    cached.text = PROFILE_SECTIONS.flatMap(key => cached.sections[key]).map(e => e.text).join('；')
    return cached
  }
  function visibleOverride(input) {
    const entries=[]
    for(const entry of input.override.entries || []) {
      if(entry.factIds.some(id=>!input.facts.some(f=>f.id===id))) continue
      if(!entry.sourceSignatures || entry.sourceSignatures.some(source=>{
        const current=input.facts.find(f=>f.id===source.id)
        return !current || source.basis !== factBasis(current) || source.evidence.some(e=>!current.evidence.some(now=>now.id===e.id && now.revision===e.revision && now.contentHash===e.contentHash))
      })) continue
      try { validateSections({[entry.section]:[{text:entry.text,factIds:entry.factIds}]},input) } catch { continue }
      entries.push({section:entry.section,text:entry.text,factIds:[...entry.factIds]})
    }
    return {aliases:input.facts.length ? [...input.override.aliases || []] : [],entries,revision:input.overrideRevision}
  }
  function factBasis(f) {
    return hash(Object.fromEntries(['text','subject','predicate','value','speakerId','polarity','modality','conditions','eventTime','validFrom','validTo','status','stability','scope'].map(k=>[k,f[k]])))
  }
  function getOverrides(subject,options) {
    const input=inputs(subject,options)
    return receipt({subject:input.subject,override:visibleOverride(input)},input.scope)
  }
  function buildProfile(subject, options = {}) {
    const input = inputs(subject,options), key = cacheKey(input.scope,input.subject)
    lifecycle?.assertActive(input.scope)
    const cached = profileOf(subject,{scope:input.scope,includeUncertain:true})
    if (cached) return Promise.resolve(cached)
    if (inFlight.has(key)) return inFlight.get(key)
    const promise = Promise.resolve().then(async () => {
      lifecycle?.assertActive(input.scope)
      if (!input.facts.length) return null
      const generated = generate ? parseJson(await (lifecycle ? lifecycle.waitFor(signal=>generate({...input,signal}),input.scope) : generate(input))) : deterministic(input)
      lifecycle?.assertActive(input.scope)
      const sections = validateSections(generated,input)
      // Manual confirmations win; automatic rebuilds do not overwrite them.
      for (const override of visibleOverride(input).entries) {
        const single = Object.fromEntries(PROFILE_SECTIONS.map(s => [s, s === override.section ? [{text:override.text,factIds:override.factIds}] : []]))
        // An override whose evidence was removed is no longer eligible for publication.
        if (override.factIds.some(id => !input.facts.some(f => f.id === id))) continue
        const entries = validateSections(single,input)[override.section].map(e => ({...e,manual:true,actorId:input.override.actorId}))
        sections[override.section] = [...entries,...sections[override.section].filter(e => !e.factIds.some(id => override.factIds.includes(id)))]
      }
      lifecycle?.assertActive(input.scope)
      if (inputs(subject,{scope:input.scope}).fingerprint !== input.fingerprint) fail('STALE_PROFILE','画像生成期间证据、范围或人工覆盖已变化')
      const profile = receipt({subject:input.subject,qq:input.subject,aliases:input.override.aliases || [],sections,fingerprint:input.fingerprint,at:now()},input.scope)
      db.run('INSERT INTO memory_profiles(scope_key,subject,fingerprint,body,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(scope_key,subject) DO UPDATE SET fingerprint=excluded.fingerprint,body=excluded.body,updated_at=excluded.updated_at',
        scopeKey(input.scope),input.subject,input.fingerprint,JSON.stringify(profile),now())
      return profileOf(subject,{...options,scope:input.scope})
    }).finally(() => inFlight.delete(key))
    inFlight.set(key,promise)
    return promise
  }
  function setOverrides(subject, value, options) {
    const input = inputs(subject,options), scope = input.scope
    exactKeys(value,['aliases','entries'],'profile override')
    const aliases = ids(value.aliases || [],'aliases',true)
    if (!Array.isArray(value.entries)) fail('INVALID_PROFILE','override.entries 必须为数组')
    const entries = value.entries.map(entry => {
      exactKeys(entry,['section','text','factIds'],'override entry')
      if (!PROFILE_SECTIONS.includes(entry.section)) fail('INVALID_PROFILE','画像类别无效')
      const single = {[entry.section]:[{text:entry.text,factIds:entry.factIds}]}
      validateSections(single,input)
      return {section:entry.section,text:entry.text,factIds:entry.factIds,sourceSignatures:entry.factIds.map(id=>{
        const f=input.facts.find(f=>f.id===id)
        return {id,basis:factBasis(f),evidence:f.evidence.map(e=>({id:e.id,revision:e.revision,contentHash:e.contentHash}))}
      })}
    })
    const actorId = string(options.actorId,'actorId',200), reason = string(options.reason,'reason',2000)
    return db.tx(() => {
      const previous = db.get('SELECT body,revision FROM memory_overrides WHERE scope_key=? AND subject=?',scopeKey(scope),input.subject)
      const revision = Number(previous?.revision || 0)
      if (options.expectedRevision !== revision) fail('REVISION_CONFLICT','人工画像版本已过期')
      const body = {aliases,entries,actorId,reason,history:[...(previous ? JSON.parse(previous.body).history || [] : []),{at:now(),actorId,reason,before:previous ? JSON.parse(previous.body).entries : []}],revision:revision + 1}
      db.run('INSERT INTO memory_overrides(scope_key,subject,body,revision) VALUES (?,?,?,?) ON CONFLICT(scope_key,subject) DO UPDATE SET body=excluded.body,revision=excluded.revision',scopeKey(scope),input.subject,JSON.stringify(body),revision+1)
      repo.touch(scope,{subject:input.subject,onlyOwn:true})
      return receipt({ok:true,subject:input.subject,revision:revision+1},scope)
    })
  }
  function profiles(options) {
    const scope = scopeOf(options)
    return db.all('SELECT subject FROM memory_profiles WHERE scope_key=?',scopeKey(scope)).map(r => profileOf(r.subject,{...options,scope})).filter(Boolean)
  }
  return {profileOf,buildProfile,setOverrides,getOverrides,profiles,profileFingerprint:(subject,o)=>inputs(subject,o).fingerprint,settle:()=>Promise.allSettled([...inFlight.values()])}
}

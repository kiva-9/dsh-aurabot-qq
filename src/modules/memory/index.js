// The transport supplies scope; panel routes rely on the host's authenticated local API.
import { createMemoryStore, memoryLine, scopeOf } from '../../features/memory.js'
import { defineTool, str } from '../../tools/tools.js'

export default {
  id: 'memory', name: '记忆', version: '2.0.0', tab: 'memory',
  description: '带来源、范围隔离和审计的 SQLite 事实记忆',
  files: ['features/memory.js','memory/index.js','memory/schema.js','memory/scope.js','memory/contracts.js','memory/store.js','memory/lexical.js','memory/extraction.js','memory/profiles.js','memory/legacy.js','memory/lifecycle.js','memory/query.js','memory/background.js'],
  setup(api) {
    const { hub, http, storage } = api.core
    const getAccount=()=>String(api.config().botQQ || hub?.selfId || '')
    const memory = createMemoryStore({ storage, dsh:api.dsh, getConfig:api.config, hub, log:api.log, getAccount })
    api.on?.('config',cfg=>memory.refreshPolicy(cfg))
    api.onDispose?.(()=>memory.stop())
    const activeScopes = new Map()
    const requireCurrent=scope=>{
      if(getAccount() && scope.account!==getAccount()) throw Object.assign(new Error('账号已改变，旧会话不能访问记忆'),{code:'ACCOUNT_CHANGED'})
      return scope
    }
    const resolveScope = args => requireCurrent(scopeOf(args.scope || args.chat?.scope || {
      account:args.chat?.account || args.account || hub?.selfId,
      chat:args.chat?.chatId,
      persona:hub?.turnPersona?.(args.sessionId)?.personaId || args.persona?.personaId || args.chat?.personaId || '',
    }))
    api.context(args => {
      if (args.chat.kind === 'system') return ''
      let scope
      try { scope = resolveScope(args) } catch { return '' }
      if (!memory.canProcess(scope)) return ''
      const factScope={...scope,persona:''}
      activeScopes.set(JSON.stringify(factScope),factScope)
      memory.enqueue(factScope)
      const subjects=[...new Set([args.chat.userId,...(hub?.speakersOf?.(args.sessionId) || [])])].filter(Boolean).slice(0,4)
      if(scope.persona) for(const subject of subjects) void memory.buildProfile(String(subject),{scope}).catch(error=>api.log.warn('人物资料等待重建：',error.message))
      // Profile selection depends on the current speakers; the host system
      // context must not accumulate one snapshot per turn.
      return ''
    })
    api.on?.('prompt/prepared', (content, info) => {
      try {
        if (info.chat?.kind === 'system') return content
        const scope = resolveScope({ chat: info.chat, sessionId: info.sessionId, persona: info.persona, account: getAccount() })
        if (!memory.canProcess(scope)) return content
        const profile = memory.contextFor({ ...info.chat, scope }, info.sessionId,
          { scope, about: info.speakers?.length ? info.speakers : info.chat.userId || info.senderId })
        return profile ? [{ type: 'text', text: profile }, ...content] : content
      } catch (error) {
        api.log.warn('当轮人物资料没生成：', error.message)
        return content
      }
    })
    // Failure policy of the prompt hook is abort: a recall problem must not drop the user's message.
    api.on?.('prompt',(content,info) => {
      try {
        if (!info?.queryText || info.chat?.kind === 'system') return content
        const scope = resolveScope({chat:info.chat,sessionId:info.sessionId,persona:info.persona,account:getAccount()})
        if (!memory.canProcess(scope)) return content
        const hint = memory.recallHint({...info.chat,scope},info.queryText,info.prevText,{scope,about:info.speakers?.length ? info.speakers : info.chat.userId || info.senderId})
        return hint ? [{type:'text',text:hint},...content] : content
      } catch (error) {
        api.log.warn('当轮记忆提示没生成：',error.message)
        return content
      }
    })
    api.every(60_000,async () => {
      if (api.config().memory?.enabled === false) return
      // Rehydrate persisted scopes after restart; no global transcript scan or deletion.
      const scopes = new Map(activeScopes)
      for (const scope of memory.registeredScopes()) scopes.set(JSON.stringify(scope),scope)
      for (const scope of scopes.values()) {
        if(!memory.canProcess(scope)) continue
        const result = await memory.tick({scope})
        if (!result.ok) api.log.warn('记忆提炼保留待处理区间：',result.message)
      }
    },'增量记忆提炼')

    api.tool(args => {
      const {chat,sessionId} = args
      if (api.config().memory?.enabled === false || chat.kind === 'system') return []
      let scope
      try { scope = resolveScope(args) } catch { return [] }
      return [
        defineTool({
          name:'remember', description:'把当前请求中有证据的一条事实持久记下。保留否定、转述、计划、条件与时间。',
          properties:{
            text:str('完整事实表述'), subject:str('事实主体 ID'), predicate:str('关系/属性'), value:{type:['string','number','boolean']},
            polarity:{type:'string',enum:['positive','negative']}, modality:{type:'string',enum:['asserted','reported','hypothetical','plan','joke','uncertain']},
            stability:{type:'string',enum:['stable','temporal','uncertain']},
            conditions:{type:['array','null'],items:{type:'string'}}, eventTime:{type:['integer','null']},validFrom:{type:['integer','null']},validTo:{type:['integer','null']},
          },
          required:['text','subject','predicate','value','polarity','modality','stability','conditions','eventTime','validFrom','validTo'],
          execute:async fact => {
            requireCurrent(scope)
            const actor = hub.turnActor?.(sessionId)
            if (!actor?.actorId || actor.error) return {ok:false,code:'REQUEST_REQUIRED',message:'请明确本条记忆对应哪个人的请求'}
            const request = hub.turnRequests?.(sessionId)?.find(r => r.id === actor.requestId && r.actorId === actor.actorId)
            const evidenceMessageIds = (request?.sourceMessageIds || []).filter(id => {
              const m = storage.messages.get(id)
              return m && m.account === scope.account && m.chatId === scope.chat && m.authorId === actor.actorId
            })
            if (!evidenceMessageIds.length) return {ok:false,code:'EVIDENCE_REQUIRED',message:'当前请求缺少可验证的来源消息'}
            const fields=['text','subject','predicate','value','polarity','modality','stability','conditions','eventTime','validFrom','validTo']
            return memory.add({...Object.fromEntries(fields.filter(k=>k in fact).map(k=>[k,fact[k]])),scope:{...scope,persona:''},speakerId:actor.actorId,evidenceMessageIds,source:'tool'})
          },
        }),
        defineTool({name:'recall_memory',description:'在当前账号、聊天及人设允许的范围内检索事实，返回日期和证据来源。',properties:{query:str('保留实体和时间的查询')},required:['query'],execute:async ({query}) => {
          requireCurrent(scope)
          const hits = memory.recall(query,{scope,about:chat.userId,limit:8})
          return {ok:true,scope,account:scope.account,chat:scope.chat,hits,message:hits.length ? hits.map(h => memoryLine(h.it)).join('\n') : '当前可见范围没有相关事实'}
        }}),
      ]
    })
    const query = req => {
      const q = http.query(req)
      return {...q,scope:scopeOf(q),includeInactive:q.includeInactive === 'true',includeUncertain:q.includeUncertain === 'true',includeUnassigned:q.includeUnassigned === 'true',limit:q.limit ? Math.max(1,Math.min(300,Number(q.limit)||100)) : 100}
    }
    const wrap = handler => async req => {
      try { return await handler(req) } catch (error) { return {ok:false,code:error.code || 'MEMORY_ERROR',message:error.message} }
    }
    const route = (path,handler) => api.route(path,wrap(handler))
    const envelope = (scope,value) => ({ok:true,...value,scope,account:scope.account,chat:scope.chat,persona:scope.persona})
    route('/memories',req => { const q=query(req); return envelope(q.scope,{items:memory.list(q),stats:memory.stats(q),review:memory.reviewList(q)}) })
    route('/memory/add',async req => memory.create(await http.body(req)))
    route('/memory/update',async req => {const b=await http.body(req);return memory.update(b.id,b.patch,b)})
    route('/memory/correct',async req => {const b=await http.body(req);return memory.correct(b.id,b.replacement,b)})
    for (const [path,method] of [['delete','remove'],['retract','retract'],['restore','restore'],['approve','approve']]) {
      route('/memory/'+path,async req => {const b=await http.body(req);return memory[method](b.id,b)})
    }
    route('/memory/evidence',req => {const q=query(req);return envelope(q.scope,{items:memory.evidence(q.id,q)})})
    route('/memory/evidence/delete',async req => {const b=await http.body(req);return memory.deleteEvidence(b.id,b)})
    route('/memory/evidence/refresh',async req => {const b=await http.body(req);return memory.refreshEvidence(b.id,b)})
    route('/memory/evidence/approve',async req => {const b=await http.body(req);return memory.approveEvidence(b.id,b)})
    route('/memory/evidence/review',req => {const q=query(req);return envelope(q.scope,{items:memory.evidenceReview(q.id,q)})})
    route('/memory/scope',async req => {const b=await http.body(req);return memory.changeScope(b.id,b.targetScope,b)})
    route('/memory/audit',req => {const q=query(req);return envelope(q.scope,{items:memory.audit(q.id,q)})})
    route('/memory/recalls',req => {const q=query(req);return envelope(q.scope,{list:memory.recalls(q)})})
    route('/memory/extraction',req => {const q=query(req);return envelope(q.scope,{checkpoint:memory.status(q),pending:memory.recentPending(q),episodes:memory.episodes(q)})})
    route('/memory/extract',async req => memory.consolidate(await http.body(req)))
    route('/memory/extraction/resume',async req => {
      if(req.method!=='POST') return {ok:false,code:'METHOD_NOT_ALLOWED',message:'此接口只接受 POST'}
      return memory.resumeExtraction(requireCurrent(scopeOf(await http.body(req))))
    })
    route('/profiles',req => {const q=query(req);return envelope(q.scope,{list:memory.profiles(q)})})
    route('/profiles/override',req => {const q=query(req);return envelope(q.scope,memory.getOverrides(q.subject || q.qq,q))})
    route('/profiles/rebuild',async req => {const b=await http.body(req),scope=scopeOf(b);return envelope(scope,{profile:await memory.buildProfile(b.subject || b.qq,{...b,scope})})})
    route('/profiles/save',async req => {const b=await http.body(req);return memory.setOverrides(b.subject || b.qq,b.override,b)})
    route('/memory/quarantine',req => {const q=query(req);return envelope(q.scope,{items:memory.quarantineList(q),unassigned:q.includeUnassigned ? memory.unassignedQuarantine(q) : [],legacy:memory.legacyStatus()})})
    route('/memory/quarantine/import',async req => {const b=await http.body(req);return memory.quarantineImport(b.payload,b)})
    route('/memory/quarantine/approve',async req => {const b=await http.body(req);return memory.approveLegacy(b.id,b.fact,b)})
    route('/memory/import',async req => {const b=await http.body(req);return memory.importCandidates(b.text,b)})
    route('/memory/import/commit',async req => {const b=await http.body(req);return memory.importCommit(b.items,b)})
    return memory
  },
}

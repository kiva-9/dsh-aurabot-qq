import { join, resolve, relative, isAbsolute } from 'node:path'
import { mkdir, realpath } from 'node:fs/promises'
import { defineTool, str } from '../../tools/tools.js'
import { scopeOf } from '../../memory/scope.js'
import { fail } from '../../memory/embedding/space.js'
import { createMemoryVectorService } from '../../memory/vector/integration/service.js'
import { createMemorySourceRepository, createImageSourceRepository, imageReference } from '../../memory/vector/integration/source-repository.js'
import { createSourceOutbox } from '../../memory/vector/integration/source-outbox.js'
import { RETRIEVAL_DEFAULTS, RETRIEVAL_CONFIG_SCHEMA, RETRIEVAL_SECRET_FIELDS, normalizeRetrievalConfig,
  runtimeRetrievalConfig, retrievalIdentity, retrievalConfigFingerprint } from '../../memory/vector/integration/module-config.js'

export { RETRIEVAL_DEFAULTS, RETRIEVAL_CONFIG_SCHEMA, RETRIEVAL_SECRET_FIELDS, normalizeRetrievalConfig }
const PUBLIC_ERRORS = new Set(['INVALID_CONFIG', 'INVALID_CONTRACT', 'INVALID_SPACE', 'INVALID_VECTOR', 'INVALID_MAPPING', 'INVALID_ENDPOINT', 'INVALID_INPUT', 'INVALID_SCOPE', 'INVALID_PROBE', 'UNSUPPORTED_PREPROCESS', 'UNSUPPORTED_MODALITY', 'SPACE_MISMATCH', 'SCOPE_REQUIRED', 'CONTEXT_REQUIRED', 'OCCURRENCE_REQUIRED', 'INVALID_REFERENCES', 'INVALID_INDEX_PATH', 'METHOD_NOT_ALLOWED', 'RETRIEVAL_DISABLED', 'IMAGE_NOT_VISIBLE', 'SOURCE_LIMIT', 'SOURCE_SCOPE_MISMATCH', 'REFERENCE_ACTOR_MISMATCH', 'SCOPE_MISMATCH', 'ACCOUNT_CHANGED', 'STALE_CONTEXT', 'JOB_NOT_FOUND', 'PROBE_REQUIRED', 'UNKNOWN_ROLE', 'OWNER_REQUIRED', 'REBUILD_ACCOUNT_CONFLICT', 'SOURCE_DISCOVERY_REQUIRED'])
const failure = error => ({ ok: false, code: error?.code || 'RETRIEVAL_ERROR', message: PUBLIC_ERRORS.has(error?.code) ? String(error.message).slice(0, 500) : '检索操作未完成，请检查状态与配置' })
const isInside = (root, path) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel) }

export default {
  id: 'retrieval', name: '混合检索', version: '1.0.0', tab: 'retrieval',
  description: '有范围和来源门卫的事实、历史图片混合召回；默认关闭，探针需手动触发',
  files: ['memory/vector/index.js', 'memory/vector/contract.js', 'memory/vector/local.js', 'memory/vector/sqlite-worker.js', 'memory/vector/qdrant.js',
    'memory/vector/integration/service.js', 'memory/vector/integration/config.js', 'memory/vector/integration/module-config.js',
    'memory/vector/integration/source-repository.js', 'memory/vector/integration/source-outbox.js', 'memory/vector/integration/reranker.js',
    'memory/embedding/index.js', 'memory/embedding/space.js', 'memory/embedding/http.js', 'memory/embedding/adapters.js', 'memory/scope.js', 'memory/lexical.js'],
  setup(api) {
    const { hub, storage, http } = api.core
    const memory = api.lazy('memory')
    const pending = new Set()
    let active = null, stopped = false, chain = Promise.resolve(), lastError = null, initializing = false, lastSync = 0, disposing
    const config = () => normalizeRetrievalConfig(api.config().retrieval)
    const account = () => String(api.config().botQQ || hub?.selfId || '')
    const policy = () => ({ shareGroups: api.config().memory?.shareGroups || [] })
    const track = promise => { pending.add(promise); promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise }
    const safe = async fn => { try { return await fn() } catch (error) { return failure(error) } }
    async function closeActive() {
      const previous = active; active = null
      if (previous) { try { await previous.outbox.stop() } finally { await previous.service.close() } }
    }
    function ensureReady() {
      const work = chain.then(async () => {
        if (stopped || api.signal?.aborted) fail('MODULE_STOPPED', '检索模块已停止')
        const cfg = config(), fingerprint = retrievalConfigFingerprint(cfg)
        if (active?.fingerprint === fingerprint) return active
        await closeActive()
        if (!cfg.enabled) return null
        initializing = true
        let service
        try {
          // Accessing lazy memory here requires its synchronous setup to have completed.
          memory.registeredScopes?.()
          const root = resolve(api.dataDir()), directory = join(root, 'vector-indexes')
          await mkdir(directory, { recursive: true })
          const [realRoot, realDir] = await Promise.all([realpath(root), realpath(directory)])
          if (!isInside(realRoot, realDir)) fail('INVALID_INDEX_PATH', '索引目录必须位于模块 dataDir 内')
          const path = join(realDir, `${retrievalIdentity(cfg)}.sqlite`)
          try { if (!isInside(realRoot, await realpath(path))) fail('INVALID_INDEX_PATH', '索引文件必须位于模块 dataDir 内') }
          catch (error) { if (error.code !== 'ENOENT') throw error }
          if (storage.db.file !== ':memory:' && resolve(path) === resolve(storage.db.file)) fail('INVALID_INDEX_PATH', '派生索引不能使用事实主库')
          const runtime = runtimeRetrievalConfig(cfg, path)
          const repo = createMemorySourceRepository({ memory, storage, getPolicy: policy })
          const imageRepo = createImageSourceRepository({ storage, getPolicy: policy, getMediaAnalysis: () => api.use('media-memory'), maxBytes: cfg.images.maxBytes })
          service = await createMemoryVectorService({ repo, imageRepo, config: runtime, getAccount: account, onUsage: entry => api.core.usage?.record(entry) })
          // A startup/reload NEVER probes a paid embedding endpoint.
          await service.initialize({ probe: false, start: false })
          if (stopped || api.signal?.aborted || retrievalConfigFingerprint(config()) !== fingerprint) {
            await service.close(); return null
          }
          const outbox = createSourceOutbox({ storage, repo, imageRepo, service, target: fingerprint, getAccount: account, options: cfg.sync })
          for (const scope of memory.registeredScopes?.() || []) if (scope.account === account()) outbox.registerScope(scope)
          active = { service, repo, imageRepo, outbox, fingerprint, config: cfg }
          // Recovered explicit jobs may contain paid work. They remain queued until a manual probe/retry/sync starts the worker.
          lastError = null
          return active
        } catch (error) {
          await service?.close(); lastError = error?.code || 'INITIALIZATION_FAILED'; throw error
        } finally { initializing = false }
      })
      chain = work.catch(() => {})
      return track(work)
    }
    async function required() {
      const state = await ensureReady()
      if (!state) fail('RETRIEVAL_DISABLED', '检索模块未启用或正在重新配置')
      return state
    }
    function requireAccount(scope) {
      if (scope.account !== account()) fail('ACCOUNT_CHANGED', '当前账号已改变')
      return scope
    }
    function hostScope(input) {
      const candidate = input.personaId ?? input.persona ?? hub?.turnPersona?.(input.sessionId)?.personaId ?? ''
      const persona = typeof candidate === 'string' ? candidate : candidate?.personaId ?? ''
      return requireAccount(scopeOf({ account: input.account || account(), chat: input.chatId || input.chat?.chatId, persona }))
    }
    function checkContext(context) {
      context.assertActive?.()
      if (context.signal?.aborted || stopped || api.signal?.aborted) fail('STALE_CONTEXT', '请求已取消或模块已停止')
      const scope = requireAccount(scopeOf({ account: context.account, chat: context.chatId, persona: context.personaId ?? context.persona ?? '' }))
      if (!context.actorId) fail('CONTEXT_REQUIRED', '引用必须绑定请求者')
      if (context.authority === 'owner-panel' && String(context.actorId) === String(api.config().ownerQQ || '')) return scope
      const request = storage.requests.get(context.requestId)
      if (!request || request.chatId !== scope.chat || String(request.actorId) !== String(context.actorId)) fail('SCOPE_MISMATCH', '请求不属于当前聊天或请求者')
      if (['canceled', 'cancel_requested', 'closed', 'failed', 'expired'].includes(request.state) || request.epoch !== storage.epochs.current(scope.chat)) fail('STALE_CONTEXT', '请求已取消或会话代次改变')
      const messages = request.sourceMessageIds.map(id => storage.messages.get(id))
      if (!messages.length || messages.some(message => !message || message.account !== scope.account || message.chatId !== scope.chat || String(message.authorId) !== String(context.actorId) || message.recalledAt != null)) fail('STALE_CONTEXT', '请求来源不属于当前账号或已撤回')
      return scope
    }
    function toolContext(chat, sessionId, execution) {
      const actor = hub.turnActor?.(sessionId), requests = hub.turnRequests?.(sessionId) || []
      if (!actor?.requestId || !actor.actorId || actor.error) fail('CONTEXT_REQUIRED', '当前回合缺少可绑定的请求身份')
      const turnId = requests[0]?.id
      const scope = hostScope({ chat, sessionId })
      return { account: scope.account, chatId: scope.chat, personaId: scope.persona, actorId: String(actor.actorId), requestId: actor.requestId,
        signal: execution?.signal || execution?.abortSignal,
        assertActive() {
          requireAccount(scope)
          if (hub.chatOfSession?.(sessionId) !== scope.chat || hub.turnRequests?.(sessionId)?.[0]?.id !== turnId || !hub.turnRequests?.(sessionId)?.some(r => r.id === actor.requestId)) fail('STALE_CONTEXT', '当前工具会话或回合已改变')
          if ((hub.turnPersona?.(sessionId)?.personaId || '') !== scope.persona) fail('STALE_CONTEXT', '当前人设已改变')
        } }
    }
    function panelContext(input = {}) {
      const actorId = String(api.config().ownerQQ || '')
      if (!actorId) fail('CONTEXT_REQUIRED', '主人账号未配置')
      if (input.account && input.account !== account()) fail('ACCOUNT_CHANGED', '面板请求账号已改变')
      const scope = hostScope({ chatId: input.chatId ?? input.chat, personaId: input.personaId ?? input.persona })
      return { account: scope.account, chatId: scope.chat, personaId: scope.persona, actorId, authority: 'owner-panel' }
    }
    const panelOwner = () => { if (!account() || !api.config().ownerQQ) fail('CONTEXT_REQUIRED', '账号与主人账号必须先配置') }
    function activeStill(state) {
      if (active !== state || stopped || !config().enabled || retrievalConfigFingerprint(config()) !== state.fingerprint) fail('STALE_CONTEXT', '检索配置已改变')
    }
    function requireReferenceActor(references, context) {
      const owner = context.authority === 'owner-panel' && String(context.actorId) === String(api.config().ownerQQ || '')
      if (!owner && references.some(reference => String(reference.sourceActor) !== String(context.actorId))) fail('REFERENCE_ACTOR_MISMATCH', '历史参考图必须属于当前请求者；生成图按原任务发起者核验')
      return references
    }
    const sanitizeImages = result => ({ ...result, hits: result.hits.map(hit => ({ id: hit.id, score: hit.score, channels: hit.channels, ...(hit.rerank ? { rerank: hit.rerank } : {}),
      sourceRevision: hit.sourceRevision, ...imageReference(hit.it), generatedJobId: hit.generationId ?? null })) })
    async function recall(input, context) {
      const scope = checkContext(context), state = await required()
      checkContext(context); state.outbox.registerScope(scope)
      const result = await state.service.recall({ scope, query: input.query, limit: input.limit, category: input.category, subject: input.subject, from: input.from, to: input.to, signal: context.signal, requestId: context.requestId })
      activeStill(state); checkContext(context)
      return { ok: true, ...result, hits: state.service.finalGuard(result.hits, { scope }) }
    }
    async function queryImages(input, context) {
      const scope = checkContext(context), state = await required()
      checkContext(context); state.outbox.registerScope(scope)
      if (input.image !== undefined || input.url !== undefined || input.assetId !== undefined) fail('OCCURRENCE_REQUIRED', '图搜输入必须是当前可见的 occurrenceId')
      const reference = requireReferenceActor(input.occurrenceId ? state.imageRepo.assertReferences([{ occurrenceId: input.occurrenceId, role: 'query' }], scope) : [], context)
      const image = input.occurrenceId ? { url: (await state.imageRepo.loadImage(input.occurrenceId, scope, { signal: context.signal })).url } : undefined
      const result = await state.service.queryImages({ scope, query: input.query || '', image, limit: input.limit, signal: context.signal, requestId: context.requestId })
      activeStill(state); checkContext(context); requireReferenceActor(state.imageRepo.assertReferences(reference, scope), context)
      return { ok: true, ...sanitizeImages({ ...result, hits: state.service.finalGuard(result.hits, { scope, kind: 'image' }) }) }
    }
    async function materializeReference(input, context) {
      const scope = checkContext(context), state = await required()
      checkContext(context)
      const references = requireReferenceActor(state.imageRepo.assertReferences([{ occurrenceId: input.occurrenceId, role: input.role || 'reference' }], scope), context)
      await state.imageRepo.loadImage(input.occurrenceId, scope, { signal: context.signal })
      activeStill(state); checkContext(context)
      const [reference] = requireReferenceActor(state.imageRepo.assertReferences(references, scope), context)
      return { ...reference, generatedJobId: reference.generationId, selectionReason: 'scope-verified-history-occurrence' }
    }
    function assertReferences(references, context) {
      const scope = checkContext(context)
      if (!active) fail('RETRIEVAL_DISABLED', '检索模块尚未就绪')
      activeStill(active)
      return requireReferenceActor(active.imageRepo.assertReferences(references, scope), context).map(ref => ({ ...ref, generatedJobId: ref.generationId }))
    }
    async function prepareContext(input) {
      if (!config().enabled || input.chat?.kind === 'system') return { ready: false, disabled: true }
      const scope = hostScope(input), state = await required(), epoch = input.epoch ?? storage.epochs.current(scope.chat)
      state.outbox.registerScope(scope)
      const isCurrent = () => {
        try { activeStill(state); requireAccount(scope); return (input.isCurrent?.() ?? true) && epoch === storage.epochs.current(scope.chat) && (hub.turnPersona?.(input.sessionId)?.personaId ?? scope.persona) === scope.persona }
        catch { return false }
      }
      return state.service.prepareContext({ ...input, scope, epoch, isCurrent })
    }
    function contextFor(chat, sessionId) {
      try {
        if (!active || !config().enabled || chat?.kind === 'system') return ''
        activeStill(active)
        const scope = hostScope({ chat, sessionId }), epoch = storage.epochs.current(scope.chat)
        return active.service.contextFor(chat, sessionId, { scope, epoch })
      } catch { return '' }
    }
    api.prepareContext?.(input => track(prepareContext(input)))
    api.context(({ chat, sessionId }) => contextFor(chat, sessionId))
    api.tool(({ chat, sessionId }) => {
      if (!config().enabled || chat.kind === 'system') return []
      const tool = (name, description, properties, required, run) => {
        const t = defineTool({ name, description, properties, required, execute: (input, exec) => track(safe(() => run(input, toolContext(chat, sessionId, exec)))) })
        t.output.render = (_input, result) => [{ type: 'text', text: JSON.stringify(result) }]
        return t
      }
      return [
        tool('recall_memory_scoped', '检索当前账号、聊天及人设可见的事实和证据。混合词法与已探测的文本向量；不足时明确降级。', { query: str('实体、内容或时间查询'), limit: { type: 'integer', minimum: 1, maximum: 50 } }, ['query'], recall),
        tool('recall_images', '检索当前可见的历史图片。返回 occurrenceId、assetId、来源作者和 generation，可供 history_references 引用。输入图片只能用可见 occurrenceId。', { query: str('可选，图片描述'), occurrenceId: str('可选，用已有图片找相似图'), limit: { type: 'integer', minimum: 1, maximum: 50 } }, [], queryImages),
      ]
    })
    async function health() {
      const state = await ensureReady()
      if (!state) return { ok: true, enabled: false, initializing, lastError }
      const value = await state.service.health()
      return { ok: true, enabled: true, initializing, lastError, ...value, jobs: value.jobs.filter(visibleJob), outbox: state.outbox.status(), automaticProbe: false }
    }
    const visibleJob = job => job.kind === 'probe' || (job.payload?.account && job.payload.account !== account() ? false :
      job.payload?.scope ? job.payload.scope.account === account() : job.payload?.scopes?.every(scope => scope.account === account()))
    async function jobFor(state, id) {
      const job = await state.service.job(id)
      if (!job || !visibleJob(job)) fail('JOB_NOT_FOUND', '当前账号没有这条任务')
      return job
    }
    function route(path, method, fn) {
      api.route(`/retrieval/${path}`, req => track(safe(async () => {
        if (req.method !== method) fail('METHOD_NOT_ALLOWED', `只接受 ${method}`)
        panelOwner()
        const input = method === 'GET' ? http.query(req) : await http.body(req)
        return fn(input || {})
      })))
    }
    route('schema', 'GET', () => ({ ok: true, schema: RETRIEVAL_CONFIG_SCHEMA, defaults: RETRIEVAL_DEFAULTS, secretFields: RETRIEVAL_SECRET_FIELDS }))
    route('status', 'GET', () => ({ ok: true, enabled: config().enabled, ready: !!active, initializing, lastError, automaticProbe: false }))
    route('health', 'GET', health)
    route('query', 'POST', input => recall(input, panelContext(input)))
    route('images', 'POST', input => queryImages(input, panelContext(input)))
    route('reference/materialize', 'POST', async input => ({ ok: true, reference: await materializeReference(input, panelContext(input)) }))
    route('probe', 'POST', async input => { const state = await required(); const result = await state.service.enqueueProbe({ roles: input.roles }); state.service.start(); return { ok: true, ...result } })
    route('rebuild', 'POST', async input => {
      const state = await required()
      if (input.account && input.account !== account()) fail('ACCOUNT_CHANGED', '面板请求账号已改变')
      const scopes = (input.scopes || [input]).map(value => { const ctx = panelContext(value); return checkContext(ctx) })
      for (const scope of scopes) state.outbox.registerScope(scope)
      const result = await state.service.rebuildAccount({ role: input.role, account: account(), authority: 'owner-panel', scopes, generation: input.generation, activate: input.activate })
      activeStill(state)
      state.service.start(); return { ok: true, ...result }
    })
    route('jobs', 'GET', async input => ({ ok: true, items: (await (await required()).service.jobs({ limit: Math.max(1, Math.min(100, Number(input.limit) || 50)) })).filter(visibleJob) }))
    route('job', 'GET', async input => ({ ok: true, job: await jobFor(await required(), input.id ?? input.jobId) }))
    for (const action of ['cancel', 'retry']) route(action, 'POST', async input => {
      const state = await required(); await jobFor(state, input.jobId)
      const job = await state.service[action === 'cancel' ? 'cancelJob' : 'retryJob'](input.jobId)
      if (action === 'retry') state.service.start()
      return { ok: true, job }
    })
    route('sync', 'POST', async input => {
      const state = await required()
      if (input.chatId || input.chat) state.outbox.registerScope(checkContext(panelContext(input)))
      // Start only after explicit panel action; unadmitted roles remain pending, without model calls.
      state.service.start(); return { ok: true, ...await state.outbox.tick() }
    })
    api.every(1000, () => track(safe(async () => {
      const state = await ensureReady()
      if (!state || Date.now() - lastSync < state.config.sync.intervalMs) return
      lastSync = Date.now(); return state.outbox.tick()
    })), '范围检索增量队列')
    async function dispose() {
      if (disposing) return disposing
      stopped = true
      disposing = (async () => { await chain; await closeActive(); await Promise.allSettled([...pending]) })()
      return disposing
    }
    api.onDispose?.(dispose)
    // Return exports synchronously; neither a worker nor any paid endpoint is touched while disabled.
    const ready = track(Promise.resolve().then(ensureReady).catch(error => { lastError = error?.code || 'INITIALIZATION_FAILED'; return null }))
    return { ready, ensureReady, health: (...args) => track(health(...args)), prepareContext: (...args) => track(prepareContext(...args)), contextFor,
      recall: (...args) => track(recall(...args)), queryImages: (...args) => track(queryImages(...args)), materializeReference: (...args) => track(materializeReference(...args)), assertReferences,
      getImageReference(occurrenceId, context) { return assertReferences([{ occurrenceId, role: 'reference' }], context)[0] },
      status: () => ({ enabled: config().enabled, ready: !!active, initializing, lastError, pending: pending.size }), dispose }
  },
}

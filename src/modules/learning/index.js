import { createLearning, KINDS, DEFAULT_LEARNING } from '../../learning/index.js'
import { hookScope, identityFor, registerRoute } from '../../learning/module-api.js'
import { settings } from '../../learning/contracts.js'

export default {
  id: 'learning', name: '表达与黑话', version: '1.0.0', tab: 'learning',
  description: '带范围、来源和人工审核的表达习惯与群内词典，学习和使用独立开关',
  files: ['learning/index.js', 'learning/contracts.js', 'learning/runtime.js', 'learning/evidence.js',
    'learning/module-api.js', 'learning/schema.js', 'learning/store.js', 'learning/visibility.js'],
  setup(api) {
    const learning = createLearning({ storage: api.core.storage, getConfig: api.config, dsh: api.dsh,
      getIdentity: (scope) => identityFor(api, scope) })
    const actorId = () => String(api.config().ownerQQ || 'owner-panel')
    const options = (b) => ({ expectedRevision: b.expectedRevision, actorId: actorId() })
    const envelope = (scope, value) => ({ ok: true, scope, ...value })
    function enqueue(args) {
      const scope = hookScope(api, args)
      for (const kind of KINDS) learning.enqueue(scope, kind)
      return scope
    }
    api.on('activity', (a) => {
      if (a.kind !== 'in') return
      try { enqueue(a) } catch (error) { api.log?.warn?.('学习证据未排队：', error.code || 'SCOPE_REQUIRED') }
    })
    api.context((args) => {
      try {
        const scope = enqueue(args), hub = api.core.hub
        const query = args.msg?.text ?? args.text ?? hub?.lastTextOf?.(args.sessionId) ?? ''
        const requestId = args.requestId || hub?.turnActor?.(args.sessionId)?.requestId || ''
        return learning.contextFor(scope, query, { requestId })
      } catch { return '' }
    })
    let cursor = 0, working = false
    api.every(60_000, async () => {
      if (working) return
      working = true
      try {
        const jobs = learning.registeredScopes().flatMap((scope) => KINDS.map((kind) => ({ scope, kind })))
        // 每个 tick 最多两个有超时的模型任务，轮转范围，不让群数量拖长宿主定时任务。
        for (let n = 0; n < Math.min(2, jobs.length); n++) {
          const job = jobs[cursor++ % jobs.length]
          await learning.learn(job.scope, job.kind)
        }
      } finally { working = false }
    }, '范围化表达与黑话学习')

    registerRoute(api, '/learning/items', 'GET', (q, scope) => envelope(scope, { items: learning.list(scope, {
      kind: q.kind || undefined, status: q.status || undefined, limit: q.limit, includeDeleted: q.includeDeleted === true || q.includeDeleted === 'true',
      includeShared: q.includeShared === true || q.includeShared === 'true',
    }) }))
    registerRoute(api, '/learning/item', 'GET', (q, scope) => envelope(scope, { item: learning.get(scope, q.id) }))
    registerRoute(api, '/learning/sources', 'GET', (q, scope) => envelope(scope, learning.sources(scope, { kind: q.kind, q: q.q, limit: q.limit })))
    registerRoute(api, '/learning/evidence', 'GET', (q, scope) => envelope(scope, { items: learning.evidence(scope, q.id) }))
    registerRoute(api, '/learning/audit', 'GET', (q, scope) => envelope(scope, { items: learning.history(scope, q.id) }))
    registerRoute(api, '/learning/status', 'GET', (_q, scope) => {
      const c = settings(api.config())
      return envelope(scope, { queues: KINDS.map((kind) => learning.checkpoint(scope, kind)),
        budget: learning.budget(),
        settings: Object.fromEntries(Object.keys(DEFAULT_LEARNING).map((key) => [key, c[key]])) })
    })
    registerRoute(api, '/learning/create', 'POST', (b, scope) => envelope(scope, { item: learning.upsert(scope, b.kind, b.data, { actorId: actorId() }) }))
    registerRoute(api, '/learning/update', 'POST', (b, scope) => envelope(scope, { item: learning.update(scope, b.id, b.patch, options(b)) }))
    for (const [action, status] of [['approve', 'approved'], ['disable', 'disabled'], ['delete', 'deleted'], ['restore', 'pending']]) {
      registerRoute(api, '/learning/' + action, 'POST', (b, scope) => envelope(scope, { item: learning.transition(scope, b.id, status, options(b)) }))
    }
    registerRoute(api, '/learning/revert', 'POST', (b, scope) => envelope(scope, { item: learning.revert(scope, b.id, b.targetRevision, options(b)) }))
    registerRoute(api, '/learning/evidence/delete', 'POST', (b, scope) => envelope(scope, { item: learning.removeEvidence(scope, b.id, b.messageId, options(b)) }))
    registerRoute(api, '/learning/run', 'POST', (b, scope) => learning.learn(scope, b.kind))
    api.onDispose?.(() => learning.stop())
    return learning
  },
}

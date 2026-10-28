// WP6 范围心情；不再加载全局 mood.json。
import { createMood } from '../../features/mood.js'
import { hookScope, identityFor, registerRoute } from '../../learning/module-api.js'

export default {
  id: 'mood',
  name: '心情',
  version: '2.0.0',
  description: '按账号、聊天和人设隔离的短期心情；明确请求与承诺不受情绪阻断',
  tab: 'mood',
  files: ['features/mood.js', 'learning/contracts.js', 'learning/runtime.js', 'learning/evidence.js', 'learning/module-api.js'],
  setup(api) {
    const mood = createMood({ storage: api.core.storage, getConfig: api.config, dsh: api.dsh, getIdentity: (scope) => identityFor(api, scope) })
    api.context((args) => { try { return mood.contextLine(hookScope(api, args)) } catch { return '' } })
    api.on('activity', (a) => {
      let scope
      try { scope = hookScope(api, a) } catch { return }
      const sourceIds = a.sourceMessageIds || (a.messageId ? [a.messageId] : a.msg?.sourceMessageId ? [a.msg.sourceMessageId] : [])
      const ids = Array.isArray(sourceIds) ? sourceIds.filter((id) => typeof id === 'string').slice(0, 8) : []
      if (a.kind === 'in') for (const messageId of ids.slice(0, 8)) mood.observe(scope, { messageId, direct: a.direct !== false, owner: a.owner === true })
      if (a.kind === 'out' && a.confirmed === true && a.reply && ids.length) {
        void mood.judge(scope, { sourceMessageIds: ids, reply: a.reply, epoch: a.epoch, personaRevision: a.personaRevision }).catch(() => {})
      }
    })
    registerRoute(api, '/mood/state', 'GET', (_q, scope) => ({ ok: true, ...mood.state(scope) }))
    registerRoute(api, '/mood/history', 'GET', (_q, scope) => ({ ok: true, scope, items: mood.state(scope).history }))
    registerRoute(api, '/mood/nudge', 'POST', (b, scope) => mood.nudge(scope, b.delta, b.reason || '', { expectedRevision: b.expectedRevision, origin: 'manual' }))
    registerRoute(api, '/mood/reset', 'POST', (b, scope) => mood.reset(scope, { expectedRevision: b.expectedRevision }))
    api.onDispose?.(() => mood.stop())
    return mood
  },
}

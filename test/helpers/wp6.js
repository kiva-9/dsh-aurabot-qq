import { createStorage } from '../../src/storage/index.js'
import { createMood } from '../../src/features/mood.js'
import { createLearning } from '../../src/learning/index.js'

export const S = Object.freeze({ account: 'bot', chat: 'group:1', persona: 'fish' })
export function deferred() {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
export const settled = () => new Promise((resolve) => setImmediate(resolve))
export function fixture(t, { file = ':memory:', config = {}, infer } = {}) {
  let time = Date.parse('2026-10-28T00:00:00Z')
  const cfg = { botQQ: 'bot', ownerQQ: 'owner', mood: { enabled: true, judge: false, halfLifeHours: 3 },
    learning: { enabled: true, learnEnabled: true, useEnabled: true, minIntervalMs: 0, noInfoBackoffMs: 1000, contextCooldownMs: 0, timeoutMs: 1000 }, ...config }
  const storage = createStorage({ file, filesDir: '', now: () => time }), services = []
  const identity = { personaId: 'fish', name: '测试角色', revision: 1, bindingRevision: 1, layers: { policy: {} } }, identities = new Map()
  const getIdentity = (scope) => ({ ...(identities.get(scope.chat) || identity), account: cfg.botQQ })
  const deps = { storage, getConfig: () => cfg, getIdentity, now: () => time, infer }
  t.after(async () => { await Promise.all(services.map((s) => s.stop())); storage.close() })
  return { cfg, storage, identity, identities, deps, getIdentity, now: () => time, advance: (ms) => { time += ms },
    track: (service) => { services.push(service); return service },
    mood: (extra = {}) => { const s = createMood({ ...deps, ...extra }); services.push(s); return s },
    learning: (extra = {}) => { const s = createLearning({ ...deps, ...extra }); services.push(s); return s },
    message: (text = '摸鱼就是暂时放松', authorId = 'alice', scope = S, extra = {}) => storage.messages.ingest({ account: scope.account, chatId: scope.chat, eventKind: 'message', authorId, text, ...extra }),
  }
}
export function candidate(ids, patch = {}) {
  return { term: '摸鱼', aliases: [], meaning: '暂时放松', meaningState: 'uncertain', confidence: 0.6, evidenceMessageIds: ids, ...patch }
}
export function sources(f, scope = S) {
  return [f.message('摸鱼就是暂时放松', 'alice', scope), f.message('先摸鱼歇会儿', 'bob', scope), f.message('这次摸鱼一会', 'carol', scope)].map((m) => m.id)
}

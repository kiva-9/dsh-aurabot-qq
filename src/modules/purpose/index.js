import { createHash } from 'node:crypto'
import { collectMaterials, decidePurpose, planPurpose } from '../../purpose/decision.js'

const WINDOW = 72 * 60 * 60_000
const keyFor = scope => 'purpose:' + createHash('sha256').update(JSON.stringify([scope.account, scope.chat, scope.persona])).digest('hex')
const failure = (code, message) => ({ ok: false, code, message })
const BLOCKS = {
  disabled: ['PURPOSE_DISABLED', '目的模式未启用或当前已静音'],
  'dry-run': ['DRY_RUN', '试运行期间不会排队主动搭话'],
  quiet: ['QUIET_HOURS', '当前处于安静时段'],
  active: ['CHAT_ACTIVE', '聊天仍活跃，暂不主动搭话'],
  quota: ['BUDGET_EXHAUSTED', '今天的主动搭话额度已用完'],
  cooldown: ['COOLDOWN', '主动搭话仍在冷却中'],
  scheduled: ['NOT_DUE', '尚未到计划时间'],
  'no-material': ['NO_PURPOSE_MATERIAL', '当前范围没有新的可用话题来源'],
}
// These failures occur before enqueue in createSpeakUp.fire. An explicit
// cancellation can also arrive after enqueue, so it is intentionally excluded.
const BEFORE_ENQUEUE = new Set(['BUSY', 'MODE_CHANGED', 'SCOPE_REQUIRED', 'QUIET_OR_DISABLED', 'SCHEDULER_UNAVAILABLE', 'BUDGET_EXHAUSTED', 'COOLDOWN', 'NUDGE_UNAVAILABLE'])

export default {
  id: 'purpose', name: '主动目的', version: '1.0.0',
  description: '从当前聊天可见的来源形成有证据的主动话题，沿用主动搭话的额度和投递规则',
  setup(api) {
    const { hub, storage, mutes, http } = api.core
    const inFlight = new Set()
    let stopped = false
    const targets = cfg => cfg.speakUp?.targets?.length ? cfg.speakUp.targets : [`private:${cfg.ownerQQ}`]
    const allowed = (cfg, target) => target === `private:${cfg.ownerQQ}` ||
      (target.startsWith('group:') ? (cfg.allow?.groups || []).includes(target.slice(6)) : (cfg.allow?.private || []).includes(target.slice(8)))
    const exact = (a, b) => a?.account === b?.account && a?.chat === b?.chat && a?.persona === b?.persona
    const stored = (scope, now) => {
      const value = storage.meta.get(keyFor(scope), {}) || {}
      return { used: (Array.isArray(value.used) ? value.used : []).filter(x => x && typeof x.id === 'string' && x.at <= now && now - x.at < WINDOW).slice(0, 50), last: value.last || null }
    }
    function inspect(target, now = Date.now()) {
      const cfg = api.config(), speak = api.use('speakup')
      target = String(target || `private:${cfg.ownerQQ}`)
      if (!speak) return failure('SPEAKUP_UNAVAILABLE', '主动搭话模块未启用')
      if (!/^(private|group):\d+$/.test(target) || !targets(cfg).includes(target) || !allowed(cfg, target)) return { ok: false, code: 'SCOPE_REQUIRED', message: '目标不在当前主动搭话范围内' }
      const state = speak.state(target), scope = state?.scope, persona = hub.personaFor?.(target)
      if (!scope || scope.account !== String(cfg.botQQ) || scope.chat !== target || !scope.persona || persona?.error || persona?.personaId !== scope.persona) return { ok: false, code: 'SCOPE_REQUIRED', message: '当前账号、聊天或人设不可用' }
      const epoch = storage.epochs.current(target), memory = api.use('memory')
      const messages = storage.messages.recent(target, 40) || []
      // Memory performs its own live evidence checks. Reject shared scopes again here.
      let facts = []
      if (memory?.list) {
        for (const s of [{ ...scope, persona: '' }, scope]) {
          try { facts.push(...(memory.list({ scope: s, limit: 20, ownScope: true }) || [])) } catch { /* A disabled memory module is not required. */ }
        }
      }
      const materials = collectMaterials({ scope, messages, facts, ownerId: cfg.ownerQQ, now })
      const stateData = stored(scope, now), planned = planPurpose({ materials, usedSourceIds: stateData.used.map(x => x.id), now })
      const lastMessage = Math.max(0, ...messages.filter(m => m.account === scope.account && m.chatId === target && m.recalledAt == null).map(m => Number(m.receivedAt || m.platformTime || 0)))
      const hour = new Date(now).getHours(), c = cfg.speakUp
      const awake = c.awakeFrom <= c.awakeTo ? hour >= c.awakeFrom && hour < c.awakeTo : hour >= c.awakeFrom || hour < c.awakeTo
      const decision = decidePurpose({ enabled: !stopped && cfg.enabled && cfg.speakUp.enabled && cfg.modules?.purpose?.enabled !== false && cfg.modules?.speakup?.enabled !== false,
        mode: cfg.speakUp.mode, muted: mutes.muted(target), dryRun: cfg.dryRun, awake, idleMs: now - lastMessage, idleMinutes: cfg.speakUp.idleMinutes,
        lastAt: state.last, nextAt: state.nextAt, now, minIntervalMinutes: cfg.speakUp.minIntervalMinutes,
        count: state.count, maxPerDay: cfg.speakUp.maxPerDay, candidates: planned.candidates })
      return { ok: true, scope: { ...scope }, epoch, personaVersion: { revision: persona.revision, bindingRevision: persona.bindingRevision }, materials, ...planned, decision, quota: { count: state.count, maxPerDay: cfg.speakUp.maxPerDay, last: state.last, nextAt: state.nextAt }, last: stateData.last }
    }
    function validSource(snapshot, material) {
      if (stopped) return false
      const cfg = api.config(), persona = hub.personaFor?.(snapshot.scope.chat), speak = api.use('speakup')
      if (!cfg.enabled || !cfg.speakUp.enabled || cfg.speakUp.mode !== 'purpose' || cfg.modules?.purpose?.enabled === false ||
          !targets(cfg).includes(snapshot.scope.chat) || !allowed(cfg, snapshot.scope.chat) || mutes.muted(snapshot.scope.chat) ||
          String(cfg.botQQ) !== snapshot.scope.account || !exact(speak?.state(snapshot.scope.chat)?.scope, snapshot.scope) ||
          persona?.error || persona?.personaId !== snapshot.scope.persona || persona?.revision !== snapshot.personaVersion.revision ||
          persona?.bindingRevision !== snapshot.personaVersion.bindingRevision || storage.epochs.current(snapshot.scope.chat) !== snapshot.epoch) return false
      let current
      if (material.kind === 'message') current = { messages: [storage.messages.get(material.id.slice(8))].filter(Boolean), facts: [] }
      else {
        const memory = api.use('memory')
        if (!memory?.get) return false
        current = { messages: [], facts: [memory.get(material.id.slice(7), { scope: material.scope })].filter(Boolean) }
      }
      const match = collectMaterials({ scope: snapshot.scope, ...current, ownerId: cfg.ownerQQ }).find(x => x.id === material.id)
      return Boolean(match && match.text === material.text && match.revision === material.revision && match.owner === material.owner)
    }
    async function fire(target) {
      target = String(target || `private:${api.config().ownerQQ}`)
      if (inFlight.has(target)) return failure('BUSY', '该聊天的主动目的正在排队')
      inFlight.add(target)
      let snapshot, record, material, attempted = false
      try {
        snapshot = inspect(target)
        if (!snapshot.ok) return snapshot
        if (!snapshot.decision.act) {
          const [code, message] = BLOCKS[snapshot.decision.reason] || ['PURPOSE_UNAVAILABLE', '当前无法安排主动目的']
          return failure(code, message)
        }
        const choice = snapshot.selected
        material = snapshot.materials.find(x => x.id === choice.sourceId)
        if (!material || !validSource(snapshot, material)) return failure('SOURCE_INVALID', '话题来源已失效，请重新查看预览')
        const speak = api.use('speakup')
        if (!speak?.fire) return failure('SPEAKUP_UNAVAILABLE', '主动搭话模块未启用')
        const now = Date.now()
        record = stored(snapshot.scope, now)
        // Reserve before the async call: even an unknown outcome must not replay this source.
        record.used = [{ id: material.id, at: now }, ...record.used.filter(x => x.id !== material.id)].slice(0, 50)
        record.last = { at: now, sourceId: material.id, goalId: choice.id, state: 'unknown' }
        storage.meta.set(keyFor(snapshot.scope), record)
        const plan = { action: choice.action, topic: choice.topic, sourceIds: [material.id],
          goals: [{ owner: choice.owner, need: choice.need, confidence: choice.confidence, status: 'hypothesis' }], materials: [{ id: material.id, text: material.text }] }
        attempted = true
        const result = await speak.fire('目的候选', { target, purpose: true, plan, validatePlan: () => validSource(snapshot, material) })
        const definiteFailure = result?.accepted === false || (result?.ok === false && result.code !== 'ENQUEUE_UNKNOWN')
        record.last.state = result?.accepted === true ? 'accepted' : definiteFailure ? 'rejected' : 'unknown'
        // Definite pre-enqueue rejections may be tried later; ambiguous dispatches never replay automatically.
        if (BEFORE_ENQUEUE.has(result?.code)) record.used = record.used.filter(x => x.id !== material.id)
        try { storage.meta.set(keyFor(snapshot.scope), record) } catch (error) { api.log?.warn?.('主动目的状态保存失败', error?.message || error) }
        return result && typeof result === 'object' ? result : failure('ENQUEUE_UNKNOWN', '排队结果不确定，不自动重复排队')
      } catch (error) {
        api.log?.warn?.('主动目的规划失败', error?.message || error)
        if (attempted) {
          if (record) { record.last.state = 'unknown'; try { storage.meta.set(keyFor(snapshot.scope), record) } catch {} }
          return failure('ENQUEUE_UNKNOWN', '排队结果不确定，不自动重复排队')
        }
        return failure('PURPOSE_ERROR', '无法完成主动目的规划，请查看日志')
      } finally { inFlight.delete(target) }
    }
    async function tick() {
      const cfg = api.config()
      if (stopped || cfg.speakUp?.mode !== 'purpose') return
      for (const target of [...new Set(targets(cfg))]) await fire(target)
    }
    api.every(60_000, tick, '主动目的')
    api.route('/purpose/status', req => inspect(http.query(req).target))
    api.route('/purpose/preview', req => inspect(http.query(req).target))
    api.onDispose?.(() => { stopped = true })
    return { tick, inspect, fire }
  },
}

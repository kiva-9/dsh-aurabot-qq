// 直接问一次宿主模型（不进会话）：给表情起备注、心情判断、记忆提炼等后台小任务用。

import { randomUUID } from 'node:crypto'

export const MODEL_ROLES = ['replyer', 'vision', 'memory', 'learning', 'judge']
export const DEFAULT_MODEL_TIMEOUT_MS = 120_000
export const MAX_MODEL_TIMEOUT_MS = 600_000

// Host-wide observation without modifying the Cordis context or its services.
const usageObservers = new WeakMap()
export function observeModelUsage(dsh, listener) {
  if ((!dsh || !['object', 'function'].includes(typeof dsh)) || typeof listener !== 'function') throw new TypeError('需要宿主对象和 usage listener')
  let listeners = usageObservers.get(dsh)
  if (!listeners) { listeners = new Set(); usageObservers.set(dsh, listeners) }
  const subscription = { listener }
  listeners.add(subscription)
  return () => {
    listeners.delete(subscription)
    if (!listeners.size && usageObservers.get(dsh) === listeners) usageObservers.delete(dsh)
  }
}

/** 某个角色用的模型：设置里给这个角色单独选了就用它，否则用全局模型（再不行用 DSH 默认）。 */
export function roleModel(dsh, cfg, role) {
  const r = role && cfg?.roles?.[role]
  if (r && r.provider && r.model) return { provider: r.provider, model: r.model, reasoningEffort: r.reasoningEffort || undefined, role, own: true }
  const t = defaultModel(dsh, cfg)
  return t ? { ...t, role: role || '', own: false } : null
}

export function defaultModel(dsh, cfg) {
  if (cfg?.model?.provider && cfg?.model?.model) return { provider: cfg.model.provider, model: cfg.model.model }
  try {
    const svc = dsh.get('agentDefaultModel')
    const sel = svc && typeof svc.currentSelection === 'function' ? svc.currentSelection() : null
    if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model }
  } catch (error) {}
  return null
}

// ---------- 视觉能力 ----------
//
// 模型能不能看图写在 DSH 的模型元数据里（inputModalities，DSH 自己的图片入口也靠它判断）。
// 三态：true = 明确声明支持；false = 明确声明不支持；null = 宿主没说清楚（按现状照发，别乱降级）。
// 明确不支持时还硬塞图片块，整轮请求会被模型拒掉 —— 她就一个字都回不了。

const VISION_TTL = 10 * 60_000
const visionCache = new Map() // `provider::model` → { at, value }

export function clearVisionCache () {
  visionCache.clear()
}

/** 这个模型能看图吗。null = 不知道。 */
export async function modelVision (dsh, provider, model, signal) {
  signal?.throwIfAborted()
  const key = `${provider}::${model}`
  const hit = visionCache.get(key)
  if (hit && Date.now() - hit.at < VISION_TTL) return hit.value
  let value = null
  try {
    const llm = dsh.llm || dsh.get('llm')
    if (llm && typeof llm.resolveModelInfo === 'function') {
      const info = await llm.resolveModelInfo(provider, model, signal)
      signal?.throwIfAborted()
      const mods = info && info.inputModalities
      if (Array.isArray(mods)) value = mods.includes('image')
    }
  } catch (error) { if (signal?.aborted) throw error }
  visionCache.set(key, { at: Date.now(), value })
  return value
}

/** 当前设置里的模型能看图吗。面板上「视觉能力」可以手动声明，覆盖元数据。null = 不知道。 */
export async function canSeeImages (dsh, cfg) {
  const v = cfg && cfg.model && cfg.model.vision
  if (v === 'on') return true
  if (v === 'off') return false
  const t = defaultModel(dsh, cfg)
  if (!t) return null
  return modelVision(dsh, t.provider, t.model)
}

// ---------- 思考强度 ----------
//
// 不是所有模型都支持「思考强度」：DSH 里没有推理元数据的模型（本地 Ollama 的那几个、一些手写的
// provider）只要收到 reasoningEffort 就整轮报错 UNSUPPORTED_REASONING_EFFORT。所以传之前先问
// DSH 这个模型支持哪几档，不支持就干脆不传这个参数。

const REASONING_TTL = 10 * 60_000
const reasoningCache = new Map() // `provider::model` → { at, value }

export function clearReasoningCache () {
  reasoningCache.clear()
}

function cacheReasoning (provider, model, value) {
  reasoningCache.set(`${provider}::${model}`, { at: Date.now(), value })
}

/**
 * 这个模型支持哪些思考强度。
 * @returns {Promise<{efforts:string[], default?:string}|null>} 不支持（没有推理元数据）返回 null
 */
export async function modelReasoning (dsh, provider, model, signal) {
  signal?.throwIfAborted()
  const key = `${provider}::${model}`
  const hit = reasoningCache.get(key)
  if (hit && Date.now() - hit.at < REASONING_TTL) return hit.value
  let value = null
  try {
    const llm = dsh.llm || dsh.get('llm')
    if (llm && typeof llm.resolveModelInfo === 'function') {
      const info = await llm.resolveModelInfo(provider, model, signal)
      signal?.throwIfAborted()
      const r = info && info.reasoning
      if (r && Array.isArray(r.efforts) && r.efforts.length) {
        value = {
          efforts: r.efforts.map((e) => String(e && e.id ? e.id : e)).filter(Boolean),
          ...(r.defaultEffort ? { default: String(r.defaultEffort) } : {}),
        }
        if (!value.efforts.length) value = null
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error
    value = null // 查不到就当不支持：少传一个参数，总比整轮报错强
  }
  cacheReasoning(provider, model, value)
  return value
}

/** 把想要的档位收敛成这个模型真正支持的；给 '' / 不支持时返回 undefined（= 不传）。 */
export async function pickReasoningEffort (dsh, provider, model, want, signal) {
  const llm = dsh.llm || dsh.get('llm')
  const canProbe = Boolean(llm && typeof llm.resolveModelInfo === 'function')
  const r = await modelReasoning(dsh, provider, model, signal)
  if (!r) {
    // 宿主根本没有查询接口时（老版本 DSH）维持老行为：照传，由下方的「被拒就重试」兜底。
    // 有接口且查到「不支持」，才真的不传。
    if (!canProbe) return String(want || '') || undefined
    return undefined
  }
  const w = String(want || '')
  if (w && r.efforts.includes(w)) return w
  return r.default && r.efforts.includes(r.default) ? r.default : undefined
}

const isUnsupportedEffort = (error) => {
  const msg = String((error && (error.message || error.code)) || '')
  return /UNSUPPORTED_REASONING_EFFORT|does not support reasoning effort|reasoning effort/i.test(msg)
}

const modelError = (code, message, name = 'Error') => Object.assign(new Error(message), { code, name })
const tokenKeys = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
const safeToken = value => Number.isSafeInteger(value) && value >= 0

function usageOf(value) {
  if (!value || typeof value !== 'object') return null
  const out = Object.fromEntries(tokenKeys.filter(key => safeToken(value[key])).map(key => [key, value[key]]))
  return Object.keys(out).length ? out : null
}

function callControl(parent, timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_MODEL_TIMEOUT_MS) throw modelError('INVALID_TIMEOUT', `timeoutMs 必须为 1..${MAX_MODEL_TIMEOUT_MS} 毫秒`)
  if (parent != null && (typeof parent.aborted !== 'boolean' || typeof parent.addEventListener !== 'function' || typeof parent.removeEventListener !== 'function')) throw modelError('INVALID_SIGNAL', 'signal 必须为 AbortSignal')
  const controller = new AbortController(), signal = controller.signal, deadline = performance.now() + timeoutMs
  const abort = () => controller.abort(modelError('MODEL_ABORTED', '模型调用已取消', 'AbortError'))
  const timeout = () => controller.abort(modelError('MODEL_TIMEOUT', '模型调用超时', 'TimeoutError'))
  const timer = setTimeout(timeout, timeoutMs)
  let rejectAbort
  const onAbort = () => rejectAbort(signal.reason)
  const aborted = new Promise((_, reject) => { rejectAbort = reject })
  aborted.catch(() => {}) // A pre-aborted request may never enter wait().
  signal.addEventListener('abort', onAbort, { once: true })
  parent?.addEventListener('abort', abort, { once: true })
  if (parent?.aborted) abort()
  const assertActive = () => {
    if (!signal.aborted && performance.now() >= deadline) timeout()
    signal.throwIfAborted()
  }
  return {
    signal, assertActive,
    async wait(fn) {
      assertActive()
      const value = await Promise.race([Promise.resolve().then(() => { assertActive(); return fn() }), aborted])
      assertActive()
      return value
    },
    dispose(cancel = false) {
      clearTimeout(timer)
      parent?.removeEventListener('abort', abort)
      signal.removeEventListener('abort', onAbort)
      if (cancel && !signal.aborted) controller.abort(modelError('MODEL_ABORTED', '模型调用已经结束', 'AbortError'))
    },
  }
}

function closeIterator(iterator) {
  // An async generator can wait forever in next()/finally. Never await its
  // return() during cancellation, and consume any eventual cleanup rejection.
  try { if (typeof iterator?.return === 'function') Promise.resolve(iterator.return()).catch(() => {}) } catch {}
}

function streamFailure(failure) {
  if (failure instanceof Error) return failure
  const f = failure && typeof failure === 'object' ? failure : {}
  return modelError(typeof f.code === 'string' ? f.code : 'MODEL_FAILED', '模型报错：' + (f.message || f.code || '未知'))
}

async function runStream(llm, params, control, attempt) {
  let out = '', iterator
  // DSH StreamChunk: usage precedes the terminal finish; nothing follows it.
  // https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/llm-streaming.md
  try {
    const attach = stream => {
      iterator = stream?.[Symbol.asyncIterator]?.() || stream?.[Symbol.iterator]?.()
      if (!iterator || typeof iterator.next !== 'function') throw modelError('INVALID_STREAM', '模型未返回可读取的流')
      // Also close an iterable returned by an asynchronous stream factory after
      // wait() has already rejected and this function's finally has run.
      try { control.assertActive() }
      catch (error) { closeIterator(iterator); iterator = null; throw error }
    }
    await control.wait(() => {
      attempt.started = true
      const stream = llm.stream(params)
      return typeof stream?.then === 'function' ? Promise.resolve(stream).then(attach) : attach(stream)
    })
    while (true) {
      const step = await control.wait(() => iterator.next())
      if (!step || step.done) throw modelError('MODEL_INCOMPLETE', '模型流没有完整 finish 就结束了')
      const chunk = step.value
      if (!chunk) continue
      if (chunk.type === 'text-delta') {
        if (typeof chunk.text !== 'string') throw modelError('INVALID_STREAM', '模型文字片段格式无效')
        out += chunk.text
      }
      if (['text-delta', 'reasoning-delta', 'tool-call-delta', 'block-end'].includes(chunk.type)) attempt.content = true
      if (chunk.type === 'usage') attempt.usage = usageOf(chunk.usage) // One attempt's cumulative snapshot, not a delta.
      if (chunk.type === 'error') throw streamFailure(chunk.error || chunk.failure)
      if (chunk.type === 'finish') {
        const kind = typeof chunk.reason === 'string' ? chunk.reason : chunk.reason?.kind
        if (kind === 'aborted') throw modelError('MODEL_ABORTED', '模型流已取消', 'AbortError')
        if (kind === 'error') throw streamFailure(chunk.reason?.failure)
        if (!['stop', 'completed'].includes(kind)) throw modelError('MODEL_INCOMPLETE', '模型没有完整完成回答')
        control.assertActive()
        return out.trim()
      }
    }
  } finally { closeIterator(iterator) }
}

function notifyUsage(dsh, options, target, attempts, started, status) {
  attempts = attempts.filter(attempt => attempt.started)
  const reported = attempts.filter(attempt => attempt.usage)
  let tokens = null
  if (reported.length) {
    tokens = {}
    for (const key of tokenKeys) {
      const values = reported.map(a => a.usage[key]).filter(safeToken)
      if (values.length) {
        const sum = values.reduce((a, b) => a + b, 0)
        if (safeToken(sum)) tokens[key] = sum
      }
    }
    Object.freeze(tokens)
  }
  const id = value => typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 200) : null
  const role = id(options.role) || ''
  const duration = Math.max(0, Math.round(performance.now() - started))
  const event = Object.freeze({ provider: id(target?.provider), model: id(target?.model), role,
    context: Object.freeze({ chatId: id(options.chatId || options.scope?.chat), requestId: id(options.requestId), account: id(options.scope?.account), role }),
    tokens, status, duration, durationMs: duration, attempts: attempts.length,
    usageComplete: attempts.length > 0 && attempts.every(a => a.usage && safeToken(a.usage.inputTokens) && safeToken(a.usage.outputTokens)),
  })
  const callbacks = [...(typeof options.onUsage === 'function' ? [options.onUsage] : []), ...[...(usageObservers.get(dsh) || [])].map(s => s.listener)]
  for (const fn of callbacks) {
    // Observers cannot change the request outcome or extend its timeout. Hosts
    // with asynchronous ledgers own draining those writes during shutdown.
    try { Promise.resolve(fn(event)).catch(() => {}) } catch {}
  }
}

/**
 * @param {object} dsh 宿主 ctx
 * @param {{system?:string, text:string, images?:Array<{data:string, mediaType:string}>, maxTokens?:number, temperature?:number, reasoningEffort?:string, cfg?:object, role?:string, signal?:AbortSignal, timeoutMs?:number, onUsage?:Function, chatId?:string, requestId?:string, scope?:object}} o
 *   role：用哪个角色的模型（vision / memory / learning / judge / replyer），没设就用全局模型
 *   timeoutMs：整个调用（含预处理和兼容重试）的期限，默认120秒，最多600秒。
 *   onUsage / observeModelUsage：每次 askModel 结算各通知一次；duration / durationMs 均为毫秒。
 *   status: success | failed | aborted | timeout。tokens 为已报告计数或 null，
 *   usageComplete=false 表示有尝试未报告完整计数；绝不把未知当作零。
 * @returns {Promise<string>}
 */
export async function askModel (dsh, o = {}) {
  const started = performance.now(), attempts = []
  let control, t, status = 'failed'
  try {
    if (!o || typeof o !== 'object') throw modelError('INVALID_OPTIONS', '需要模型调用参数')
    t = roleModel(dsh, o.cfg, o.role)
    control = callControl(o.signal, o.timeoutMs === undefined ? DEFAULT_MODEL_TIMEOUT_MS : o.timeoutMs)
    control.assertActive()
    const llm = dsh?.llm || dsh?.get?.('llm')
    if (!llm || typeof llm.stream !== 'function') throw modelError('MODEL_UNAVAILABLE', '宿主没有 llm 服务')
    if (!t) throw modelError('MODEL_UNAVAILABLE', '拿不到默认模型')
    // 明确不支持视觉时保留原先的 NO_VISION，不能丢图降级成文字请求。
    if (o.images?.length && (await control.wait(() => modelVision(dsh, t.provider, t.model, control.signal))) === false) {
      throw Object.assign(new Error(`「${o.role}」用的模型 ${t.model} 看不了图，换一个能看图的模型`), { code: 'NO_VISION' })
    }
    let content = [{ type: 'text', text: o.text }]
    for (const img of o.images || []) content.push({ type: 'image', data: img.data, mediaType: img.mediaType, name: 'aurabot-image' })
    // 图片要先交给 DSH 的附件服务登记成附件块，模型适配层只认附件。
    if (content.length > 1) {
      const att = dsh.attachments || dsh.get?.('attachments')
      if (!att || typeof att.admitPromptContent !== 'function') throw new Error('宿主没有附件服务，看不了图')
      content = await control.wait(() => att.admitPromptContent(content))
    }
    const messages = [{ role: 'user', id: randomUUID(), content, source: { kind: 'plugin', plugin: 'aurabot' } }]
    const base = {
      provider: t.provider,
      model: t.model,
      system: o.system || '',
      messages,
      maxTokens: o.maxTokens || 600,
      temperature: o.temperature ?? 0.3,
      signal: control.signal,
    }
    let effort = await control.wait(() => pickReasoningEffort(dsh, t.provider, t.model, o.reasoningEffort === undefined ? (t.reasoningEffort || 'low') : o.reasoningEffort, control.signal))
    for (let attempt = 0; ; attempt++) {
      control.assertActive()
      const observed = { usage: null, content: false, started: false }
      attempts.push(observed)
      try {
        const result = await runStream(llm, effort ? { ...base, reasoningEffort: effort } : base, control, observed)
        control.assertActive()
        status = 'success'
        return result
      } catch (error) {
        control.assertActive()
        // Only the existing pre-output capability fallback is retried. A
        // cancellation, reported usage, or partial output forbids another call.
        if (attempt === 0 && effort && !observed.content && !observed.usage && !['AbortError', 'TimeoutError'].includes(error?.name) && isUnsupportedEffort(error)) {
          cacheReasoning(t.provider, t.model, null)
          effort = undefined
          continue
        }
        throw error
      }
    }
  } catch (error) {
    const failure = control?.signal.aborted ? control.signal.reason : error
    status = failure?.code === 'MODEL_TIMEOUT' || failure?.name === 'TimeoutError' ? 'timeout'
      : failure?.code === 'MODEL_ABORTED' || failure?.name === 'AbortError' ? 'aborted' : 'failed'
    throw failure
  } finally {
    control?.dispose(status !== 'success')
    notifyUsage(dsh, o || {}, t, attempts, started, status)
  }
}

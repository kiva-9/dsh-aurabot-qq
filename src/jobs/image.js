// 生图任务：登记 → 等参考图就绪 → 按服务能力检查 → 提交 / 查进度 → 结果存成资产并记下血缘 → 发到 QQ。
// 聊天这一轮马上结束（「在画了」），画好了后台直接发；失败、不确定的结果用中性的话告诉对方。

import { readFileSync } from 'node:fs'
import { adapterFor } from '../providers/image/index.js'
import { checkRequest, ProviderError, MODE_LABEL } from '../providers/image/common.js'
import { toJson, fromJson } from '../storage/db.js'
import { isOwner } from '../chat/access.js'

/**
 * @param {object} o
 * @param {object} o.storage
 * @param {() => object} o.getConfig
 * @param {object} o.hub  sendImageAssets / sendText / noteToSession
 * @param {object} [o.local] 本地接口（profile id 为 local 时用）
 * @param {object} [o.adapterDeps] 测试时注入 fetchImpl
 */
export function createImageService({ storage, getConfig, hub, local, toImageBuffer, log, adapterDeps = {}, onDelivered }) {
  const cfg = () => getConfig().imageGen

  /** 能用的服务（本地接口开着时多一个 local）。 */
  function profiles() {
    const list = [...cfg().profiles]
    if (local?.active?.('image')) list.unshift({ id: 'local', name: '本地接口', protocol: 'local', capabilities: { modes: ['text'] } })
    return list
  }

  function profileInfo(p) {
    try {
      const { caps } = adapterFor(p, { local, toImageBuffer, ...adapterDeps })
      return { id: p.id, name: p.name, protocol: p.protocol, model: p.model || '', caps, ok: true }
    } catch (error) {
      return { id: p.id, name: p.name, protocol: p.protocol, model: p.model || '', caps: null, ok: false, message: error.message }
    }
  }

  /**
   * 给这个请求挑服务：指定了就用指定的（不支持就直说）；没指定先看默认的，默认的不支持再找第一个支持的。
   * 返回 { profile, caps } 或 { error }。
   */
  function pickProfile(req, profileId) {
    const list = profiles()
    if (!list.length) return { error: '还没配置生图服务' }
    const tryOne = (p) => {
      const info = profileInfo(p)
      if (!info.ok) return { error: `「${p.name}」用不了：${info.message}` }
      const why = checkRequest(req, info.caps)
      return why ? { error: `「${p.name}」：${why}` } : { profile: p, caps: info.caps }
    }
    if (profileId) {
      const p = list.find((x) => x.id === profileId)
      return p ? tryOne(p) : { error: `没有叫 ${profileId} 的生图服务` }
    }
    const def = list.find((x) => x.id === (local?.active?.('image') ? 'local' : cfg().defaultProfile)) || list[0]
    const first = tryOne(def)
    if (first.profile) return first
    for (const p of list) {
      if (p === def) continue
      const r = tryOne(p)
      if (r.profile) return r
    }
    // 所有服务都做不了：说清楚缺什么（不悄悄改成文生图）
    return { error: `没有生图服务能做「${MODE_LABEL[req.mode] || req.mode}」${req.inputs?.length ? `（${req.inputs.length} 张输入图）` : ''}：${first.error}` }
  }

  const handler = {
    perChat: 1,
    quota: (job) => {
      const c = getConfig()
      if (c.imageGen.quota.ownerUnlimited && isOwner(c, job.actorId)) return []
      return [{ scope: `user:${job.actorId}`, limit: c.imageGen.quota.perUserPerDay, message: `今天给你画的已经够 ${c.imageGen.quota.perUserPerDay} 张了，明天再来吧` }]
    },

    /** 参考图都下载好了才提交；下载失败的参考图直接让任务失败（不能当没有）。 */
    prepare: async (job) => {
      for (const ref of job.input.refs || []) {
        if (!ref.occurrenceId) continue
        const o = storage.occurrences.get(ref.occurrenceId)
        if (!o) throw new ProviderError('invalid', '参考图的记录不见了')
        if (o.state === 'pending') return { wait: '参考图还在下载' }
        if (o.state !== 'ready' || !o.assetId) throw new ProviderError('invalid', `第 ${ref.n || '?'} 张参考图没下载下来（${o.error || o.state}），没法照着画`, { maybeCharged: false })
        ref.assetId = o.assetId
      }
      storage.db.run('UPDATE jobs SET input_json = ? WHERE id = ?', toJson(job.input), job.id)
      return { ready: true }
    },

    submit: async (job, attempt) => {
      const req = buildRequest(job, attempt)
      const picked = pickProfile(req, job.input.profileId)
      if (picked.error) throw new ProviderError('unsupported', picked.error, { maybeCharged: false })
      storage.db.run('UPDATE jobs SET profile_id = ? WHERE id = ?', picked.profile.id, job.id)
      const { adapter } = adapterFor(picked.profile, { local, toImageBuffer, ...adapterDeps })
      log?.info?.(`生图任务 ${job.id}：${MODE_LABEL[req.mode]}，用「${picked.profile.name}」，${req.inputs.length} 张输入图`)
      return adapter.submit(req, {})
    },

    poll: async (job) => {
      const p = profiles().find((x) => x.id === job.profileId)
      if (!p) throw new ProviderError('unknown', '这个任务用的生图服务被删掉了')
      const { adapter } = adapterFor(p, { local, toImageBuffer, ...adapterDeps })
      if (!adapter.poll) throw new ProviderError('unknown', '这个服务不能查进度')
      return adapter.poll(job.providerTaskId, {})
    },

    cancel: async (job) => {
      const p = profiles().find((x) => x.id === job.profileId)
      if (!p) return { ok: false, message: '服务被删掉了' }
      const { adapter } = adapterFor(p, { local, toImageBuffer, ...adapterDeps })
      return adapter.cancel ? adapter.cancel(job.providerTaskId, {}) : { ok: false, message: '这个服务不支持取消（画好了也不会发出来）' }
    },

    /** 画好的图先存成资产，记下血缘（用了哪些输入图、各当什么用、父任务）。 */
    store: async (job, outputs) => {
      const assetIds = outputs.map((o) => storage.assets.put(o.buf, { mime: o.mime, sourceKind: 'generated' }).id)
      storage.db.run(`INSERT INTO generation_lineage(job_id, parent_job_id, inputs_json, outputs_json, intent, params_json) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET outputs_json = excluded.outputs_json`,
      job.id, job.parentJobId, toJson((job.input.refs || []).map((r) => ({ assetId: r.assetId, role: r.role, occurrenceId: r.occurrenceId || null, sourceMessageId: r.sourceMessageId || null, selectionReason: r.reason || '' }))),
      toJson(assetIds), String(job.input.prompt || '').slice(0, 500), toJson({ mode: job.input.mode, size: job.input.size, profileId: job.profileId }))
      return { assetIds }
    },

    deliver: async (job) => {
      const r = await hub.sendImageAssets(job.chatId, job.output.assetIds || [], `[生图] ${String(job.input.prompt || '').slice(0, 30)}`)
      return { delivered: Boolean(r.delivered || r.skipped) && !r.failed && !r.unknown, error: r.failed ? '网关拒绝了' : r.unknown ? '不确定发没发出去' : '' }
    },

    notify: (job, event, info) => {
      if (event === 'delivered') {
        hub.noteToSession?.(job.chatId, `【系统】你刚才画的图（任务 ${job.id}）已经发到聊天里了。`)
        onDelivered?.(job)
        return
      }
      if (event === 'failed') {
        hub.sendText(job.chatId, `（画图没成功：${info.message}）`).catch(() => {})
        hub.noteToSession?.(job.chatId, `【系统】画图任务 ${job.id} 失败了：${info.message}`)
      }
      if (event === 'unknown') {
        hub.sendText(job.chatId, '（画图服务没回应，不确定画没画好。为了不重复扣费先不重画，主人可以在面板「生图」里看看）').catch(() => {})
      }
    },
  }

  function buildRequest(job, attempt) {
    const c = cfg()
    const inputs = []
    for (const ref of job.input.refs || []) {
      const a = storage.assets.get(ref.assetId)
      if (!a) throw new ProviderError('invalid', '参考图找不到了', { maybeCharged: false })
      inputs.push({ buf: readFileSync(storage.assets.pathOf(a)), mime: a.mime, role: ref.role })
    }
    let mask = null
    if (job.input.maskAssetId) {
      const a = storage.assets.get(job.input.maskAssetId)
      if (!a) throw new ProviderError('invalid', '蒙版找不到了', { maybeCharged: false })
      mask = { buf: readFileSync(storage.assets.pathOf(a)), mime: a.mime }
    }
    const prompt = [c.stylePrompt, job.input.prompt].filter(Boolean).join('，')
    return { mode: job.input.mode, prompt, negativePrompt: job.input.negativePrompt || '', size: job.input.size || c.size, n: 1, inputs, mask, idempotencyKey: `${job.id}:${attempt.n}` }
  }

  /** 血缘：这个任务用了哪些输入、产出了哪些图。 */
  function lineage(jobId) {
    const r = storage.db.get('SELECT * FROM generation_lineage WHERE job_id = ?', jobId)
    return r ? { jobId, parentJobId: r.parent_job_id, inputs: fromJson(r.inputs_json, []), outputs: fromJson(r.outputs_json, []), intent: r.intent, params: fromJson(r.params_json, {}) } : null
  }

  return { handler, profiles, profileInfo, pickProfile, lineage }
}

// 生图任务：登记 → 等参考图就绪 → 按服务能力检查 → 提交 / 查进度 → 结果存成资产并记下血缘 → 发到 QQ。
// 聊天这一轮马上结束（「在画了」），画好了后台直接发；失败、不确定的结果用中性的话告诉对方。

import { readFileSync } from 'node:fs'
import { adapterFor } from '../providers/image/index.js'
import { checkRequest, ProviderError, MODE_LABEL } from '../providers/image/common.js'
import { toJson, fromJson } from '../storage/db.js'
import { isOwner, checkAllowed, levelFor } from '../chat/access.js'
import { canSee } from '../domain/scope.js'
import { appearanceOf } from '../persona/compiler.js'

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

  // 配置快照不进入 input_json：任务接口可展示输入，但绝不能把服务密钥一并返回。
  const savedProfile = (id) => fromJson(storage.db.get('SELECT profile_json FROM image_job_configs WHERE job_id = ?', id)?.profile_json, null)
  const referenceVisible = (ref,job) => {
    if(!ref.occurrenceId)return true
    const o=storage.occurrences.get(ref.occurrenceId),config=getConfig()
    if(!o||!o.scope||o.scope.chat!==o.chatId||!canSee(o.scope,{account:job.input.accountId||config.botQQ,chat:job.chatId,persona:job.input.persona?.personaId},config.memory))return false
    if(o.messageId) {
      const m=storage.messages.get(o.messageId)
      if(!m||m.recalledAt!=null||m.account!==o.scope.account||m.chatId!==o.chatId)return false
    }
    if(ref.assetId&&o.assetId&&ref.assetId!==o.assetId)return false
    return !['failed','unavailable','deleted','retracted'].includes(o.state)
  }
  const guard = (job, execution = {}) => {
    if (execution.signal?.aborted || execution.shouldContinue?.() === false) return false
    if(job.requestId) {
      const config=getConfig(),request=storage.requests.get(job.requestId),[kind,id]=job.chatId.split(':')
      const chat={kind,chatId:job.chatId,userId:kind==='private'?id:job.actorId,groupId:kind==='group'?id:undefined}
      if(!request||request.policyRevision!==(config.policyRevision||0)||config.enabled===false||levelFor(config,chat)==='chat'||
        !checkAllowed(config,chat).allowed||(config.imageGen.ownerOnly&&!isOwner(config,job.actorId)))return false
    }
    if((job.input.refs||[]).some(ref=>!referenceVisible(ref,job)))return false
    const r = storage.db.get('SELECT state, epoch FROM jobs WHERE id = ?', job.id)
    return r && !['canceled', 'cancel_requested'].includes(r.state) && Number(r.epoch) === storage.epochs.current(job.chatId) && (!job.input.accountId || job.input.accountId === String(getConfig().botQQ))
  }

  function validateInput(input) {
    if (!input || !String(input.prompt || '').trim()) throw new ProviderError('invalid', '请填写画面描述或修改要求', { maybeCharged: false })
    if (String(input.prompt).length > 12000) throw new ProviderError('invalid', '画面描述不能超过 12000 字', { maybeCharged: false })
    if (!Array.isArray(input.refs) || input.refs.length > 16) throw new ProviderError('invalid', '输入图片最多 16 张', { maybeCharged: false })
    if (input.size && !/^\d{3,4}x\d{3,4}$/.test(input.size)) throw new ProviderError('invalid', '图片尺寸格式应为 1024x1024', { maybeCharged: false })
    for (const ref of input.refs) {
      if (!['base', 'identity', 'style', 'composition'].includes(ref.role)) throw new ProviderError('invalid', '输入图用途不合法', { maybeCharged: false })
      if (!ref.assetId && !ref.occurrenceId) throw new ProviderError('invalid', '输入图缺少有效引用', { maybeCharged: false })
      if (ref.assetId && !storage.assets.get(ref.assetId)) throw new ProviderError('invalid', '有一张输入图找不到了，请重新选择', { maybeCharged: false })
    }
    if (input.refs.filter((r) => r.role === 'base').length > 1) throw new ProviderError('invalid', '只能指定一张底图，其他图请选参考用途', { maybeCharged: false })
    if (input.maskAssetId && !storage.assets.get(input.maskAssetId)) throw new ProviderError('invalid', '蒙版找不到了，请重新绘制', { maybeCharged: false })
  }

  function enqueue(runner, args) {
    const c = cfg()
    const input = { ...structuredClone(args.input), accountId: String(getConfig().botQQ), stylePrompt: c.stylePrompt, size: args.input.size || c.size }
    const persona = args.personaSnapshot || hub.personaFor?.(args.chatId)
    if (persona?.error) throw new ProviderError('invalid', '当前聊天的人设绑定无效，请先修正', { maybeCharged: false })
    input.persona = persona ? { personaId: persona.personaId, revision: persona.revision, bindingRevision: persona.bindingRevision } : null
    if (input.drawSelf === true) {
      if (!persona) throw new ProviderError('invalid', '当前聊天没有可用的人设快照', { maybeCharged: false })
      input.appearance = structuredClone(appearanceOf(persona.layers))
      // 用户已经指定长相/底图时以其选择为准，不能再悄悄塞入另一个人物。
      if (!input.refs.some(r => ['base', 'identity'].includes(r.role))) {
        for (const assetId of input.appearance.referenceAssetIds) input.refs.push({ assetId, role: 'identity', reason: `人设 ${persona.personaId} v${persona.revision} 外观参考` })
      }
      if (input.refs.length && input.mode === 'text') input.mode = 'reference'
    }
    validateInput(input)
    const picked = pickProfile({ mode: input.mode, inputs: input.refs, size: input.size, mask: input.maskAssetId ? {} : null }, input.profileId)
    if (picked.error) throw new ProviderError('unsupported', picked.error, { maybeCharged: false })
    input.profileId = picked.profile.id
    return storage.db.tx(() => {
      const job = runner.enqueue({ ...args, input, profileId: picked.profile.id })
      storage.db.run('INSERT INTO image_job_configs(job_id, profile_json, created_at) VALUES (?, ?, ?)', job.id, toJson(picked.profile), Date.now())
      return job
    })
  }

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
      const quota=c.imageGen.quota, reservations=[]
      if(!(quota.ownerUnlimited&&isOwner(c,job.actorId)))reservations.push({scope:`image:${c.botQQ}:user:${job.actorId}`,limit:quota.perUserPerDay,message:'今天该请求者的生图额度已用完'})
      reservations.push({scope:`image:${c.botQQ}:chat:${job.chatId}`,limit:quota.perChatPerDay??100,message:'今天当前聊天的生图额度已用完'})
      reservations.push({scope:`image:${c.botQQ}:provider:${job.profileId}`,limit:quota.perProviderPerDay??500,message:'今天该生图服务的调用额度已用完'})
      return reservations
    },

    /** 参考图都下载好了才提交；下载失败的参考图直接让任务失败（不能当没有）。 */
    prepare: async (job, execution = {}) => {
      validateInput(job.input)
      if (!guard(job, execution)) throw new ProviderError('invalid', '会话或机器人账号已变，任务不会再提交', { maybeCharged: false })
      for (const ref of job.input.refs || []) {
        if (!ref.occurrenceId) continue
        const o = storage.occurrences.get(ref.occurrenceId)
        if (!o) throw new ProviderError('invalid', '参考图的记录不见了')
        if (!referenceVisible(ref,job)) throw new ProviderError('invalid', '参考图已撤回或不在这个聊天的可见范围内', { maybeCharged: false })
        if (o.state === 'pending') return { wait: '参考图还在下载' }
        if (o.state !== 'ready' || !o.assetId) throw new ProviderError('invalid', `第 ${ref.n || '?'} 张参考图没下载下来（${o.error || o.state}），没法照着画`, { maybeCharged: false })
        ref.assetId = o.assetId
      }
      const save = () => storage.db.run('UPDATE jobs SET input_json = ? WHERE id = ?', toJson(job.input), job.id)
      if (execution.commit) execution.commit(save); else save()
      return { ready: true }
    },

    submit: async (job, attempt, execution = {}) => {
      if (!guard(job, execution)) throw new ProviderError('invalid', '任务已停止', { maybeCharged: false })
      const req = buildRequest(job, attempt)
      const frozen = savedProfile(job.id)
      const picked = frozen ? { profile: frozen } : pickProfile(req, job.input.profileId)
      if (picked.error) throw new ProviderError('unsupported', picked.error, { maybeCharged: false })
      const save = () => storage.db.run('UPDATE jobs SET profile_id = ? WHERE id = ?', picked.profile.id, job.id)
      if (execution.commit) execution.commit(save); else save()
      const { adapter } = adapterFor(picked.profile, { local, toImageBuffer, ...adapterDeps })
      log?.info?.(`生图任务 ${job.id}：${MODE_LABEL[req.mode]}，用「${picked.profile.name}」，${req.inputs.length} 张输入图`)
      return adapter.submit(req, { signal: execution.signal })
    },

    poll: async (job, execution = {}) => {
      const p = savedProfile(job.id) || profiles().find((x) => x.id === job.profileId)
      if (!p) throw new ProviderError('unknown', '这个任务用的生图服务被删掉了')
      const { adapter } = adapterFor(p, { local, toImageBuffer, ...adapterDeps })
      if (!adapter.poll) throw new ProviderError('unknown', '这个服务不能查进度')
      return adapter.poll(job.providerTaskId, { signal: execution.signal })
    },

    cancel: async (job, execution = {}) => {
      const p = savedProfile(job.id) || profiles().find((x) => x.id === job.profileId)
      if (!p) return { ok: false, message: '服务被删掉了' }
      const { adapter } = adapterFor(p, { local, toImageBuffer, ...adapterDeps })
      return adapter.cancel ? adapter.cancel(job.providerTaskId, { signal: execution.signal }) : { ok: false, message: '这个服务不支持取消（画好了也不会发出来）' }
    },

    /** 画好的图先存成资产，记下血缘（用了哪些输入图、各当什么用、父任务）。 */
    store: async (job, outputs, execution = {}) => {
      execution.assertActive?.()
      const assetIds = outputs.map((o) => storage.assets.put(o.buf, { mime: o.mime, sourceKind: 'generated' }).id)
      const save = () => {
        storage.db.run(`INSERT INTO generation_lineage(job_id, parent_job_id, inputs_json, outputs_json, intent, params_json) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET outputs_json = excluded.outputs_json`,
      job.id, job.parentJobId, toJson((job.input.refs || []).map((r) => ({ assetId: r.assetId, role: r.role, occurrenceId: r.occurrenceId || null, sourceMessageId: r.sourceMessageId || null, selectionReason: r.reason || '', ...(r.avatar ? { avatar: r.avatar } : {}) }))),
        toJson(assetIds), String(job.input.prompt || '').slice(0, 500), toJson({ mode: job.input.mode, size: job.input.size, profileId: job.profileId, persona: job.input.persona }))
        for (const [segIndex, assetId] of assetIds.entries()) {
          const old = storage.db.get("SELECT id FROM asset_occurrences WHERE json_extract(remote_json,'$.jobId')=? AND seg_index=?", job.id, segIndex)
          if (old) continue
          const id = storage.occurrences.add({ chatId: job.chatId, authorId: job.input.accountId, kind: 'image', segIndex,
            scope: { account: job.input.accountId, chat: job.chatId, category: 'image' }, remote: { jobId: job.id, parentJobId: job.parentJobId } })
          storage.occurrences.ready(id, assetId, { description: job.input.prompt, sourceKind: 'generated', persona: job.input.persona })
        }
      }
      if (execution.commit) execution.commit(save); else save()
      return { assetIds }
    },

    deliver: async (job, execution = {}) => {
      if (!guard(job, execution)) return { delivered: false, canceled: true, error: '任务或会话已停止，结果已保留' }
      if (!getConfig().enabled || getConfig().dryRun) return { delivered: false, skipped: true, error: '当前处于试运行或总开关已关闭；结果已保存，开启后可补发' }
      const ids = job.output.assetIds || []
      if (!ids.length) return { delivered: false, error: '任务没有可发送的结果' }
      const r = await hub.sendImageAssets(job.chatId, ids, `[生图] ${String(job.input.prompt || '').slice(0, 30)}`, { batchId: `image:${job.id}`, epoch: job.epoch, requestId: job.requestId, retry: true, shouldSend: () => guard(job, execution) })
      return { delivered: r.delivered === ids.length && !r.failed && !r.unknown && !r.skipped && !r.canceled, unknown: Boolean(r.unknown), canceled: Boolean(r.canceled), batchId: r.batchId, error: r.unknown ? '不确定发没发出去，已阻止重复发送，请先核对 QQ 回执' : r.failed ? '网关拒绝了，可补发未发送的图片' : r.skipped ? '当前设置未发送' : r.canceled ? '会话已改变，未发送的图片已取消' : r.pending ? '发送仍在进行' : '' }
    },

    notify: async (job, event, info, execution = {}) => {
      if (execution.shouldContinue?.() === false) return
      if (job.epoch !== storage.epochs.current(job.chatId) || (job.input.accountId && job.input.accountId !== String(getConfig().botQQ))) return
      if (event === 'delivered') {
        hub.noteToSession?.(job.chatId, `【系统】你刚才画的图（任务 ${job.id}）已经发到聊天里了。`, { account: job.input.accountId, epoch: job.epoch })
        onDelivered?.(job)
        return
      }
      if (event === 'failed') {
        await hub.sendText(job.chatId, `（画图没成功：${info.message}）`, null, { batchId: `image-notice:${job.id}:failed`, epoch: job.epoch, requestId: job.requestId, shouldSend: () => guard(job, execution) }).catch(() => {})
        hub.noteToSession?.(job.chatId, `【系统】画图任务 ${job.id} 失败了：${info.message}`, { account: job.input.accountId, epoch: job.epoch })
      }
      if (event === 'unknown') {
        await hub.sendText(job.chatId, '（画图服务没回应，不确定画没画好。为了不重复扣费先不重画，主人可以在面板「生图」里看看）', null, { batchId: `image-notice:${job.id}:unknown`, epoch: job.epoch, requestId: job.requestId, shouldSend: () => guard(job, execution) }).catch(() => {})
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
    const prompt = [job.input.appearance?.text, job.input.stylePrompt ?? c.stylePrompt, job.input.prompt].filter(Boolean).join('，')
    return { mode: job.input.mode, prompt, negativePrompt: job.input.negativePrompt || '', size: job.input.size || c.size, n: 1, inputs, mask, idempotencyKey: `${job.id}:${attempt.n}` }
  }

  /** 血缘：这个任务用了哪些输入、产出了哪些图。 */
  function lineage(jobId) {
    const r = storage.db.get('SELECT * FROM generation_lineage WHERE job_id = ?', jobId)
    return r ? { jobId, parentJobId: r.parent_job_id, inputs: fromJson(r.inputs_json, []), outputs: fromJson(r.outputs_json, []), intent: r.intent, params: fromJson(r.params_json, {}) } : null
  }

  return { handler, profiles, profileInfo, pickProfile, lineage, enqueue, validateInput }
}

// 内置模块：生图。她能画图、照着参考图画、改图（多个生图服务：OpenAI 兼容 / Gemini / ComfyUI / 自己配的 HTTP，或「本地接口」的画图脚本）。
// 画图是后台任务：聊天这一轮马上回「在画了」，画好直接发出来；取消只能取消自己的。

import { canUseArtwork, artworkList, resolveArtwork } from '../../image/gallery.js'
import { createJobRunner, STATE_LABEL, ACTIVE } from '../../jobs/runner.js'
import { createImageService } from '../../jobs/image.js'
import { MODE_LABEL, ROLES } from '../../providers/image/common.js'
import { toImageBuffer } from '../../local/local.js'
import { defineTool, str } from '../../tools/tools.js'
import { randomUUID } from 'node:crypto'
import { createAvatarReferences } from '../../features/qq-profile.js'

const ROLE_HINT = { base: '底图（在它上面改）', identity: '人物长相参考', style: '风格参考', composition: '构图参考' }

export default {
  id: 'imagegen',
  name: '生图',
  version: '2.0.0',
  description: '画图、照参考图画、改图（qq_draw_image），后台任务，可取消',
  tab: 'imagegen',
  files: ['jobs/image.js', 'jobs/runner.js', 'providers/image/index.js', 'providers/image/common.js', 'providers/image/openai.js', 'providers/image/gemini.js', 'providers/image/comfyui.js', 'providers/image/http.js'],
  setup(api) {
    const { hub, local, storage, http, onebot } = api.core
    const avatars = createAvatarReferences({ hub, onebot, storage, fetchAvatar: api.core.fetchAvatar, log: api.log })
    const memory = api.lazy('memory')
    const search = api.lazy('search')
    const retrieval = api.lazy('retrieval')
    const svc = createImageService({
      storage, getConfig: api.config, hub, local, toImageBuffer, log: api.log,
      onDelivered: (job) => job.input.persona?.personaId && memory.addEvent?.({ text: `画了一张图：${String(job.input.prompt).slice(0, 40)}`,
        scope: { account: job.input.accountId, chat: job.chatId, persona: job.input.persona.personaId }, confirmed: true, sourceId: `image:${job.id}`,
        about: job.chatId.startsWith('private:') ? job.chatId.slice(8) : job.input.persona.personaId, tags: ['画画'], importance: 0.4 }),
    })
    const runner = createJobRunner({ storage, handlers: { image: svc.handler }, log: api.log })
    const rec = runner.recover()
    if (rec.unknown || rec.polling || rec.delivering) api.log.info(`生图任务恢复：接着查 ${rec.polling} 个，接着发 ${rec.delivering} 个，${rec.unknown} 个不确定结果`)
    api.every(1500, () => runner.tick(), '生图任务')

    const enabled = () => svc.profiles().length > 0 && (api.config().imageGen.enabled || local.active('image'))

    /** 生图前的权限：只给主人画时，这一轮提出请求的人得是主人。 */
    const allowed = (sessionId) => {
      const mixed = new Set((hub.turnRequests?.(sessionId) || []).map(r => String(r.actorId))).size > 1
      return !(api.config().imageGen.ownerOnly || mixed) || hub.turnSendersAllOwner(sessionId)
    }

    api.tool(({ chat, sessionId }) => (enabled() && chat.kind !== 'system' ? [
      defineTool({
        name: 'qq_draw_image',
        description: '画图并发到当前 QQ 聊天里（后台画，画好自动发出来，这一轮回一句「在画了」就行）。' +
          '要照着这段里的图画或改图时，用 images 按「【这段里的图】」里的编号引用，并说明每张当什么用：base 底图（在它上面改）、identity 人物长相参考、style 风格参考、composition 构图参考。' +
          '要在你刚才给这个人画的那张上接着改，用 continue_last。不要拿别人发的图给另一个人当参考。' +
          '有人说「用我头像的形象画」时设 use_avatar:true；主人指定本群某人时用 avatar.qq。',
        properties: {
          prompt: str('画面描述：主体、动作、场景、风格；改图时写要改成什么样'),
          images: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer', description: '图编号' }, role: { type: 'string', enum: ['base', 'identity', 'style', 'composition'] } }, required: ['n', 'role'] }, description: '可选，引用这段里的图' },
          continue_last: { type: 'boolean', description: '可选，在你刚才给这个人画的那张上接着改' },
          draw_self: { type: 'boolean', description: '仅用户明确要画你当前扮演的角色时设为true，冻结这版人设的外观和参考图' },
          reference_candidates: { type: 'array', maxItems: 3, items: { type: 'object', properties: { resultId: str('搜索结果 ID'), candidateId: str('已经审核的候选图片 ID') }, required: ['resultId', 'candidateId'] }, description: '可选，只能使用 qq_reference_candidates 返回的 verified 候选；未确认时先澄清，不跳过审核' },
          history_references: { type:'array',maxItems:8,items:{type:'object',properties:{occurrenceId:str('recall_images 返回的历史图片出现 ID'),role:{type:'string',enum:['base','identity','style','composition']}},required:['occurrenceId','role']},description:'可选，使用已明确选择的历史图片；引用提交前会重新核验范围、作者和撤回状态' },
          size: str('可选，比如 1024x1024 / 768x1024 / 1024x768'),
          shape: str('可选：方图、竖图或横图'),
          artwork_id: str('可选：当前聊天画廊中明确选定的作品 ID，作为修改底图'),
          use_avatar: { type: 'boolean', description: '可选，用这个请求者自己的 QQ 头像当人物长相参考' },
          avatar: { type: 'object', description: '可选，比 use_avatar 更具体：qq 只有主人能填且须是本群成员，role 默认 identity', properties: { qq: str('QQ 号'), role: { type: 'string', enum: ['identity', 'style', 'base'] } } },
        },
        required: ['prompt'],
        execute: async ({ prompt, images, continue_last: cont, size, draw_self, reference_candidates, history_references, use_avatar, avatar, shape, artwork_id }, execution) => {
          if (!allowed(sessionId)) return { ok: false, message: '生图权限不足，或这一轮含其他人的请求；请主人单独发起' }
          const who = hub.turnActor(sessionId)
          if (who.error) return { ok: false, message: who.error }
          const pool = hub.turnImages(sessionId)
          const refs = []
          if(history_references!==undefined) {
            if(!Array.isArray(history_references)||history_references.length>8)return {ok:false,message:'最多使用八张明确指定的历史图片'}
            if(!retrieval.materializeReference)return {ok:false,message:'历史图片检索模块未启用'}
            const trusted=hub.plannerContext(sessionId,who.requestId),context={...trusted,personaId:hub.turnPersona?.(sessionId)?.personaId||''}
            try {
              for(const ref of history_references) {
                if(!ROLES.includes(ref.role))throw new Error('请指定历史图片的有效用途')
                refs.push({...await retrieval.materializeReference(ref,context),role:ref.role,reason:'用户明确指定的历史图片'})
              }
            } catch(error){return {ok:false,message:error.message}}
          }
          if (reference_candidates !== undefined) {
            if (!Array.isArray(reference_candidates) || reference_candidates.length > 3) return { ok: false, message: '最多使用三张已审核的网络参考图' }
            if (!search.materializeReference) return { ok: false, message: '搜索模块未启用，不能核验参考图' }
            const account = String(api.config().botQQ), epoch = storage.epochs.current(chat.chatId)
            const context = { account, chatId: chat.chatId, actorId: String(who.actorId), requestId: who.requestId, turnId: hub.turnRequests(sessionId)[0]?.id || who.requestId,
              assertActive: () => { if (account !== String(api.config().botQQ) || epoch !== storage.epochs.current(chat.chatId)) throw new Error('会话已改变，请重新选择参考图') } }
            try { for (const candidate of reference_candidates) refs.push(search.materializeReference(candidate, context)) }
            catch (error) { return { ok: false, message: error.message } }
          }
          for (const want of Array.isArray(images) ? images : []) {
            const im = pool.find((x) => x.n === Number(want.n))
            if (!im) return { ok: false, message: `这段里没有图${want.n}（有：${pool.map((x) => '图' + x.n).join('、') || '没有图'}）` }
            if (!ROLES.includes(want.role)) return { ok: false, message: '请指定图片的有效用途' }
            if (String(im.actorId) !== String(who.actorId)) return { ok: false, message: `图${im.n} 是 ${im.nick} 发的，不能拿来给别人画` }
            refs.push({ n: im.n, assetId: im.assetId, occurrenceId: im.occurrenceId, sourceMessageId: im.dbMessageId, generatedJobId: im.generatedJobId || null, role: want.role, reason: `对方指定的图${im.n}（${im.source === 'quote' ? '引用' : '附图'}）` })
          }
          if (use_avatar === true || avatar) {
            const role = avatar?.role || 'identity'
            if (!['identity', 'style', 'base'].includes(role)) return { ok: false, message: '头像的用途只能是 identity、style 或 base' }
            // 拿不到就不画：不能悄悄换成网图或随便生成一张脸
            const ref = await avatars.resolve({ chat, sessionId, qq: avatar?.qq, role })
            if (!ref.ok) return { ok: false, message: ref.message }
            refs.push({ assetId: ref.assetId, role, reason: `QQ ${ref.qq} 的头像`, avatar: { qq: ref.qq, assetId: ref.assetId } })
          }
          let parentJobId = null
          if (artwork_id) {
            const personaId = hub.turnPersona?.(sessionId)?.personaId
            const selected = resolveArtwork(artwork_id, runner.get, { account: api.config().botQQ, chatId: chat.chatId, actorId: who.actorId, personaId })
            if (!selected || !storage.assets.get(selected.assetId) || refs.some(r => r.role === 'base'))
              return { ok: false, message: '作品不存在或不属于当前聊天、请求者和角色，或需要明确选择唯一底图' }
            refs.unshift({ assetId: selected.assetId, galleryId: selected.id, personaId, role: 'base', reason: `画廊作品 ${selected.id}` })
            parentJobId = selected.job.id
          }
          const quotedParent = refs.find((r) => r.role === 'base' && r.generatedJobId)
          if (quotedParent && !cont) {
            const parent = runner.get(quotedParent.generatedJobId)
            if (canUseArtwork(parent, { account: api.config().botQQ, chatId: chat.chatId, actorId: who.actorId, personaId: hub.turnPersona?.(sessionId)?.personaId }) && parent.output.assetIds.includes(quotedParent.assetId)) {
              parentJobId = parent.id
              for (const ref of parent.input.refs || []) if (ref.role !== 'base' && !refs.some((r) => r.assetId === ref.assetId && r.role === ref.role)) refs.push({ ...ref, reason: '沿用被引用任务的参考图' })
            }
          }
          if (cont) {
            const scope = { account: api.config().botQQ, chatId: chat.chatId, actorId: who.actorId, personaId: hub.turnPersona?.(sessionId)?.personaId }
            const last = runner.list({ chatId: chat.chatId, actorId: who.actorId, states: ['delivered'], limit: 100 }).find(j => canUseArtwork(j, scope))
            if (!last?.output?.assetIds?.length) return { ok: false, message: '你最近没让我画过图，没有能接着改的' }
            if (last.output.assetIds.length !== 1 || refs.some((r) => r.role === 'base')) return { ok: false, message: '有多张底图可选，请明确引用要修改的那张图' }
            refs.unshift({ assetId: last.output.assetIds[0], role: 'base', reason: `接着改任务 ${last.id} 画的图` })
            for (const ref of last.input.refs || []) if (ref.role !== 'base' && !refs.some((r) => r.assetId === ref.assetId && r.role === ref.role)) refs.push({ ...ref, reason: '沿用上次任务的参考图' })
            parentJobId = last.id
          }
          if (!refs.length && pool.some((im) => String(im.actorId) === String(who.actorId) && im.state !== 'ready')) return { ok: false, message: '这个请求的图片还未就绪或下载失败，请等待或明确是否只需文生图，不能忽略输入图' }
          const roles = refs.map((r) => r.role)
          const mode = !refs.length ? 'text' : roles.includes('base') ? 'edit' : 'reference'
          const jobArgs = {
            kind: 'image', chatId: chat.chatId, requestId: who.requestId, actorId: who.actorId, parentJobId, personaSnapshot: hub.turnPersona?.(sessionId),
            input: { prompt: String(prompt || ''), mode, refs, drawSelf: draw_self === true, size: size || '', shape: shape || '', waitUntil: Date.now() + api.config().imageGen.waitInputSec * 1000 },
          }
          if (execution?.simulated === true) {
            try {
              svc.preview(jobArgs)
              return { ok: true, simulated: true, message: '模拟：不会提交生图任务，也不会向 QQ 发送图片' }
            } catch (error) {
              return { ok: false, message: error.message }
            }
          }
          let job
          try {
            job = svc.enqueue(runner, jobArgs)
          } catch (error) {
            return { ok: false, message: error.message }
          }
          runner.kick()
          const how = refs.length ? '（' + refs.map((r) => `${r.n ? '图' + r.n : '上一张'}当${ROLE_HINT[r.role]}`).join('，') + '）' : ''
          return { ok: true, message: `开始${MODE_LABEL[mode]}了${how}，画好会直接发出来，你这一轮简单说一句就行`, job_id: job.id }
        },
      }),
      defineTool({
        name: 'qq_cancel_image',
        description: '取消画图任务（只能取消提要求的人自己的）。不写 job_id 就取消这个人最近一个还没完成的。',
        properties: { job_id: str('可选，任务 ID') },
        execute: async ({ job_id: id }) => {
          const who = hub.turnActor(sessionId)
          if (who.error) return { ok: false, message: who.error }
          const owner = String(who.actorId) === String(api.config().ownerQQ)
          const target = id ? runner.get(String(id)) : runner.list({ chatId: chat.chatId, actorId: who.actorId, states: ACTIVE, limit: 1 })[0]
          if (!target || target.chatId !== chat.chatId) return { ok: false, message: '没有可以取消的画图任务' }
          return runner.cancel(target.id, { by: who.actorId, force: owner })
        },
      }),
      defineTool({
        name: 'qq_artwork_gallery', description: '查看当前聊天、当前角色和请求者自己的已送达作品，使用作品 ID 继续修改。',
        properties: {}, execute: async () => {
          const who = hub.turnActor(sessionId)
          if (who.error) return { ok: false, message: who.error }
          const personaId = hub.turnPersona?.(sessionId)?.personaId
          if (!personaId) return { ok: false, message: '当前角色不可用' }
          const items = artworkList(runner.list({ chatId: chat.chatId, actorId: who.actorId, states: ['delivered'], limit: 100 }),
            { account: api.config().botQQ, chatId: chat.chatId, actorId: who.actorId, personaId })
          return { ok: true, items }
        },
      }),
      defineTool({
        name: 'qq_image_jobs',
        description: '看看这个人最近的画图任务进行到哪了。',
        properties: {},
        execute: async () => {
          const who = hub.turnActor(sessionId)
          if (who.error) return { ok: false, message: who.error }
          const list = runner.list({ chatId: chat.chatId, actorId: who.actorId, limit: 5 })
          if (!list.length) return { ok: true, message: '最近没有画图任务' }
          return { ok: true, message: list.map((j) => `${j.id}：${STATE_LABEL[j.state]}${j.error ? '（' + j.error + '）' : ''} · ${String(j.input.prompt).slice(0, 20)}`).join('\n') }
        },
      }),
    ] : []))

    // ---------- 面板 ----------
    const jobView = (j) => ({ ...j, stateLabel: STATE_LABEL[j.state], modeLabel: MODE_LABEL[j.input.mode] || j.input.mode, lineage: svc.lineage(j.id), attempts: runner.attempts(j.id), delivery: hub.outbox?.summary(`image:${j.id}`) })
    const galleryScope = (chatId, personaId) => {
      const cfg = api.config(), chat = String(chatId || ''), p = hub.personaFor?.(chat)
      const permitted = chat === `private:${cfg.ownerQQ}` || (chat.startsWith('group:') ? (cfg.allow?.groups || []).includes(chat.slice(6)) : (cfg.allow?.private || []).includes(chat.slice(8)))
      if (!/^(private|group):\d+$/.test(chat) || !permitted || !p || p.error || !p.personaId || (personaId && p.personaId !== personaId)) return null
      return { account: String(cfg.botQQ), chatId: chat, actorId: String(cfg.ownerQQ), personaId: p.personaId }
    }
    const galleryAsset = (id, scope) => {
      const selected = scope && resolveArtwork(id, runner.get, scope), asset = selected && storage.assets.get(selected.assetId)
      return asset?.state === 'stored' && /^image\/(png|jpeg|gif|webp|bmp)$/.test(asset.mime) ? { ...selected, asset } : null
    }
    api.route('/imagegen/gallery', async req => {
      const q = http.query(req), scope = galleryScope(q.chatId, q.personaId)
      if (!scope) return { ok: false, code: 'SCOPE_REQUIRED', message: '当前聊天或人设不可用' }
      let beforeAt = Number.MAX_SAFE_INTEGER, beforeId = '\uffff'
      if (q.before) {
        const match = /^(\d{1,16}):([\w-]{1,120})$/.exec(String(q.before))
        if (!match || !Number.isSafeInteger(Number(match[1]))) return { ok: false, code: 'INVALID_CURSOR', message: '图库分页参数无效' }
        beforeAt = Number(match[1]); beforeId = match[2]
      }
      // Filter before pagination, so other accounts/personas cannot hide this scope's items.
      const rows = storage.db.all(`SELECT id, created_at FROM jobs WHERE kind = 'image' AND state = 'delivered' AND chat_id = ? AND actor_id = ?
        AND json_extract(input_json, '$.accountId') = ? AND json_extract(input_json, '$.persona.personaId') = ?
        AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT 31`,
      scope.chatId, scope.actorId, scope.account, scope.personaId, beforeAt, beforeAt, beforeId)
      const jobs = rows.slice(0, 30).map(r => runner.get(r.id)).filter(Boolean)
      const items = artworkList(jobs, scope).filter(x => galleryAsset(x.id, scope))
      const tail = rows[29]
      return { ok: true, scope, items, nextCursor: rows.length > 30 && tail ? `${tail.created_at}:${tail.id}` : null }
    })
    api.route('/imagegen/gallery/asset', async (req, res) => {
      const q = http.query(req), selected = galleryAsset(q.id, galleryScope(q.chatId, q.personaId))
      if (!selected) return { ok: false, message: '作品不存在或不在当前范围' }
      const { readFileSync } = await import('node:fs')
      http.send(res, 200, readFileSync(storage.assets.pathOf(selected.asset)), selected.asset.mime)
    })
    api.route('/imagegen/profiles', async () => ({ ok: true, list: svc.profiles().map((p) => svc.profileInfo(p)) }))
    api.route('/imagegen/jobs', async (req) => {
      const q = http.query(req)
      return { ok: true, list: runner.list({ chatId: q.chatId || undefined, limit: Number(q.limit) || 40 }).map(jobView) }
    })
    api.route('/imagegen/job', async (req) => { const j = runner.get(http.query(req).id); return j ? { ok: true, job: jobView(j) } : { ok: false, message: '没有这个任务' } })
    api.route('/imagegen/cancel', async (req) => runner.cancel((await http.body(req)).id, { force: true }))
    api.route('/imagegen/resend', async (req) => runner.resend((await http.body(req)).id))
    // 面板工作台：主人直接下一个任务（文生图 / 用已有的图当输入 / 蒙版），画好发到指定聊天
    api.route('/imagegen/submit', async (req) => {
      const b = await http.body(req)
      const chatId = String(b.chatId || `private:${api.config().ownerQQ}`)
      if (!/^(private|group):\d+$/.test(chatId)) return { ok: false, message: '要发到哪个聊天？' }
      const contextId = `panel:image:${randomUUID()}`
      const context = { account: String(api.config().botQQ), chatId, actorId: String(api.config().ownerQQ), requestId: contextId, turnId: contextId, authority: 'owner-panel' }
      let refs
      try {
        refs = await Promise.all((Array.isArray(b.refs) ? b.refs : []).map(async (r) => {
          // Materialized search references also have occurrenceId. Revalidate their
          // search review/expiry before considering ordinary history references.
          if (r.resultId || r.candidateId) {
            if (!search.materializeReference) throw new Error('搜索模块未启用，不能核验参考图')
            return { ...search.materializeReference({ resultId: r.resultId, candidateId: r.candidateId }, context), role: r.role }
          }
          if(r.occurrenceId) {
            if(!retrieval.materializeReference)throw new Error('历史图片检索模块未启用')
            return {...await retrieval.materializeReference(r,{...context,personaId:hub.personaFor?.(chatId)?.personaId||''}),role:r.role,reason:'面板指定的历史图片'}
          }
          if (r.galleryId) {
            const scope = galleryScope(chatId, r.personaId), selected = galleryAsset(r.galleryId, scope)
            if (!selected) throw new Error('图库作品已失效或不属于当前账号、聊天和人设')
            return { assetId: selected.assetId, galleryId: selected.id, personaId: scope.personaId, role: r.role, reason: `图库作品 ${selected.id}` }
          }
          return { assetId: String(r.assetId || ''), role: r.role, reason: '面板指定' }
        }))
      } catch (error) { return { ok: false, message: error.message } }
      if (b.parentJobId) {
        const parent = runner.get(String(b.parentJobId))
        if (!canUseArtwork(parent, galleryScope(chatId) || {}) || !parent.output.assetIds?.some((id) => refs.some((r) => r.assetId === id && ['base', 'identity'].includes(r.role)))) return { ok: false, message: '后续编辑必须引用当前账号、聊天、请求者和人设的已送达作品' }
        for (const ref of parent.input.refs || []) if (ref.role !== 'base' && !refs.some((r) => r.assetId === ref.assetId && r.role === ref.role)) refs.push({ ...ref, reason: '沿用上次任务的参考图' })
      }
      const mode = b.maskAssetId ? 'mask' : !refs.length ? 'text' : refs.some((r) => r.role === 'base') ? 'edit' : 'reference'
      try {
        const job = svc.enqueue(runner, { kind: 'image', chatId, actorId: api.config().ownerQQ, parentJobId: b.parentJobId || null, input: { prompt: String(b.prompt || ''), mode, refs, drawSelf: b.drawSelf === true, size: b.size || '', shape: b.shape || '', maskAssetId: b.maskAssetId || null, profileId: b.profileId || null, waitUntil: Date.now() + 30000 } })
        runner.kick()
        return { ok: true, job: jobView(job), message: '开始画了' }
      } catch (error) { return { ok: false, message: error.message } }
    })
    // 面板上传参考图 / 蒙版：存成资产，返回 assetId
    api.route('/imagegen/upload', async (req) => {
      const b = await http.body(req)
      if (typeof b.data !== 'string' || b.data.length > 42 * 1024 * 1024) return { ok: false, message: '图片不能超过 30 MB' }
      const buf = Buffer.from(String(b.data || '').replace(/^data:[^,]*,/, ''), 'base64')
      if (buf.length > 30 * 1024 * 1024) return { ok: false, message: '图片不能超过 30 MB' }
      const { imageInfo } = await import('../../providers/image/common.js')
      try {
        const info = imageInfo(buf)
        if (info.width * info.height > 50000000) return { ok: false, message: '图片不能超过 5000 万像素' }
        const a = storage.assets.put(buf, { ...info, sourceKind: 'upload' })
        return { ok: true, assetId: a.id, ...info }
      } catch (error) { return { ok: false, message: error.message || '图片损坏或格式不支持' } }
    })
    api.route('/imagegen/asset', async (req, res) => {
      const a = storage.assets.get(http.query(req).id)
      if (!a) return { ok: false, message: '没有这张图' }
      const { readFileSync } = await import('node:fs')
      http.send(res, 200, readFileSync(storage.assets.pathOf(a)), a.mime)
    })
    api.route('/imagegen/test', async (req) => {
      const b = await http.body(req)
      const p = svc.profiles().find((x) => x.id === b.id)
      if (!p) return { ok: false, message: '先保存再测试' }
      const info = svc.profileInfo(p)
      return info.ok ? { ok: true, message: `配置声明：${info.caps.modes.map((m) => MODE_LABEL[m]).join('、') || '未启用任何模式'}；最多 ${info.caps.maxInputs} 张输入图。未向服务发出请求；实际可用性请提交测试任务验证。`, caps: info.caps } : { ok: false, message: info.message }
    })

    api.onDispose?.(() => runner.stop())
    return { generate: undefined, enabled, runner, service: svc }
  },
}

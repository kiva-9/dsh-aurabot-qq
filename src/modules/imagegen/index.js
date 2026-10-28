// 内置模块：生图。她能画图、照着参考图画、改图（多个生图服务：OpenAI 兼容 / Gemini / ComfyUI / 自己配的 HTTP，或「本地接口」的画图脚本）。
// 画图是后台任务：聊天这一轮马上回「在画了」，画好直接发出来；取消只能取消自己的。

import { createJobRunner, STATE_LABEL, ACTIVE } from '../../jobs/runner.js'
import { createImageService } from '../../jobs/image.js'
import { MODE_LABEL } from '../../providers/image/common.js'
import { toImageBuffer } from '../../local/local.js'
import { defineTool, str } from '../../tools/tools.js'

const ROLE_HINT = { base: '底图（在它上面改）', identity: '人物长相参考', style: '风格参考', composition: '构图参考' }

export default {
  id: 'imagegen',
  name: '生图',
  version: '2.0.0',
  description: '画图、照参考图画、改图（qq_draw_image），后台任务，可取消',
  tab: 'imagegen',
  files: ['jobs/image.js', 'jobs/runner.js', 'providers/image/'],
  setup(api) {
    const { hub, local, storage, http } = api.core
    const memory = api.lazy('memory')
    const svc = createImageService({
      storage, getConfig: api.config, hub, local, toImageBuffer, log: api.log,
      onDelivered: (job) => memory.addEvent?.({ text: `画了一张图：${String(job.input.prompt).slice(0, 40)}`, about: job.chatId.startsWith('private:') ? job.chatId.slice(8) : '', tags: ['画画'], importance: 0.4 }),
    })
    const runner = createJobRunner({ storage, handlers: { image: svc.handler }, log: api.log })
    const rec = runner.recover()
    if (rec.unknown || rec.polling || rec.delivering) api.log.info(`生图任务恢复：接着查 ${rec.polling} 个，接着发 ${rec.delivering} 个，${rec.unknown} 个不确定结果`)
    api.every(1500, () => runner.tick(), '生图任务')

    const enabled = () => svc.profiles().length > 0 && (api.config().imageGen.enabled || local.active('image'))

    /** 生图前的权限：只给主人画时，这一轮提出请求的人得是主人。 */
    const allowed = (sessionId) => !api.config().imageGen.ownerOnly || hub.turnSendersAllOwner(sessionId)

    api.tool(({ chat, sessionId }) => (enabled() && chat.kind !== 'system' ? [
      defineTool({
        name: 'qq_draw_image',
        description: '画图并发到当前 QQ 聊天里（后台画，画好自动发出来，这一轮回一句「在画了」就行）。' +
          '要照着这段里的图画或改图时，用 images 按「【这段里的图】」里的编号引用，并说明每张当什么用：base 底图（在它上面改）、identity 人物长相参考、style 风格参考、composition 构图参考。' +
          '要在你刚才给这个人画的那张上接着改，用 continue_last。不要拿别人发的图给另一个人当参考。',
        properties: {
          prompt: str('画面描述：主体、动作、场景、风格；改图时写要改成什么样'),
          images: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer', description: '图编号' }, role: { type: 'string', enum: ['base', 'identity', 'style', 'composition'] } }, required: ['n', 'role'] }, description: '可选，引用这段里的图' },
          continue_last: { type: 'boolean', description: '可选，在你刚才给这个人画的那张上接着改' },
          size: str('可选，比如 1024x1024 / 768x1024 / 1024x768'),
        },
        required: ['prompt'],
        execute: async ({ prompt, images, continue_last: cont, size }) => {
          if (!allowed(sessionId)) return { ok: false, message: '画图只给主人画哦' }
          const who = hub.turnActor(sessionId)
          if (who.error) return { ok: false, message: who.error }
          const owner = String(who.actorId) === String(api.config().ownerQQ)
          const pool = hub.turnImages(sessionId)
          const refs = []
          for (const want of Array.isArray(images) ? images : []) {
            const im = pool.find((x) => x.n === Number(want.n))
            if (!im) return { ok: false, message: `这段里没有图${want.n}（有：${pool.map((x) => '图' + x.n).join('、') || '没有图'}）` }
            // 群友 A 要画，不能拿群友 B 发的自拍当参考（主人可以指定任何图）
            if (!owner && String(im.actorId) !== String(who.actorId)) return { ok: false, message: `图${im.n} 是 ${im.nick} 发的，不能拿来给别人画` }
            refs.push({ n: im.n, assetId: im.assetId, occurrenceId: im.occurrenceId, sourceMessageId: im.dbMessageId, role: want.role, reason: `对方指定的图${im.n}（${im.source === 'quote' ? '引用' : '附图'}）` })
          }
          let parentJobId = null
          if (cont) {
            const last = runner.list({ chatId: chat.chatId, actorId: who.actorId, states: ['delivered'], limit: 1 })[0]
            if (!last?.output?.assetIds?.length) return { ok: false, message: '你最近没让我画过图，没有能接着改的' }
            refs.unshift({ assetId: last.output.assetIds[0], role: 'base', reason: `接着改任务 ${last.id} 画的图` })
            parentJobId = last.id
          }
          const roles = refs.map((r) => r.role)
          const mode = !refs.length ? 'text' : roles.includes('base') ? 'edit' : 'reference'
          let job
          try {
            job = runner.enqueue({
              kind: 'image', chatId: chat.chatId, requestId: who.requestId, actorId: who.actorId, parentJobId,
              input: { prompt: String(prompt || ''), mode, refs, size: size && /^\d{3,4}x\d{3,4}$/.test(size) ? size : '', waitUntil: Date.now() + api.config().imageGen.waitInputSec * 1000 },
            })
          } catch (error) {
            return { ok: false, message: error.message }
          }
          // 能不能做现在就检查一遍（不用等排到它才发现服务不支持）
          const can = svc.pickProfile({ mode, inputs: refs.map((r) => ({ role: r.role })), size: job.input.size, mask: null }, null)
          if (can.error) {
            runner.cancel(job.id, { force: true })
            return { ok: false, message: can.error }
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
    const jobView = (j) => ({ ...j, stateLabel: STATE_LABEL[j.state], modeLabel: MODE_LABEL[j.input.mode] || j.input.mode, lineage: svc.lineage(j.id), attempts: runner.attempts(j.id) })
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
      const refs = (Array.isArray(b.refs) ? b.refs : []).map((r) => ({ assetId: String(r.assetId), role: r.role, reason: '面板指定' })).filter((r) => storage.assets.get(r.assetId))
      const mode = b.maskAssetId ? 'mask' : !refs.length ? 'text' : refs.some((r) => r.role === 'base') ? 'edit' : 'reference'
      const check = svc.pickProfile({ mode, inputs: refs, size: b.size || '', mask: b.maskAssetId ? {} : null }, b.profileId || null)
      if (check.error) return { ok: false, message: check.error }
      const job = runner.enqueue({ kind: 'image', chatId, actorId: api.config().ownerQQ, parentJobId: b.parentJobId || null, input: { prompt: String(b.prompt || ''), mode, refs, size: b.size || '', maskAssetId: b.maskAssetId || null, profileId: b.profileId || null, waitUntil: Date.now() + 30000 } })
      runner.kick()
      return { ok: true, job: jobView(job), message: '开始画了' }
    })
    // 面板上传参考图 / 蒙版：存成资产，返回 assetId
    api.route('/imagegen/upload', async (req) => {
      const b = await http.body(req)
      const buf = Buffer.from(String(b.data || '').replace(/^data:[^,]*,/, ''), 'base64')
      const { imageMime } = await import('../../providers/image/common.js')
      const mime = imageMime(buf)
      if (!mime) return { ok: false, message: '不是图片' }
      const a = storage.assets.put(buf, { mime, sourceKind: 'upload' })
      return { ok: true, assetId: a.id }
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
      return info.ok ? { ok: true, message: `能做：${info.caps.modes.map((m) => MODE_LABEL[m]).join('、')}；最多 ${info.caps.maxInputs} 张输入图${info.caps.async ? '；后台排队出图' : ''}${info.caps.cancel ? '；能取消' : ''}`, caps: info.caps } : { ok: false, message: info.message }
    })

    api.onDispose?.(() => runner.stop())
    return { generate: undefined, enabled, runner, service: svc }
  },
}

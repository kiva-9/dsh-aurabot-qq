// 面板路由沿用宿主认证通道；聊天工具只允许主人做管理操作。
import { createStickerStore } from '../../features/stickers.js'
import { defineTool, str } from '../../tools/tools.js'
import { fetchImage, segmentBytes } from '../../core/net.js'
import { dataDir } from '../../core/store.js'

export default {
  id: 'stickers', name: '表情包', version: '2.0.0', tab: 'stickers',
  description: '默认同账号共用图库，自动采集识别；可选按聊天隔离，QQ 收藏同步独立跟踪',
  files: ['features/stickers.js', 'stickers/store.js', 'stickers/repository.js', 'stickers/schema.js', 'stickers/selection.js', 'stickers/analysis.js', 'stickers/legacy.js', 'runtime/image-frames.js'],
  setup(api) {
    const { hub, onebot, http, storage } = api.core
    const legacyDir = api.core.stickerLegacyDir ?? dataDir('stickers')
    const store = createStickerStore({ storage, dsh: api.dsh, getConfig: api.config, onebot, log: api.log, legacyDir })
    const adminOptions = (body = {}) => ({ ...body, admin: true, accountId: String(api.config().botQQ || ''), chatId: body.chatId || undefined })
    const idOf = (body) => body.id || body.md5
    const errorResult = (e) => ({ ok: false, code: e.code || 'STICKER_ERROR', message: e.message, reason: e.message })
    const route = (path, fn) => api.route(path, async (...args) => { try { return await fn(...args) } catch (e) { return errorResult(e) } })
    const post = (path, fn) => route(path, async (req) => { const body = await http.body(req); return fn(body, adminOptions(body)) })

    api.tool(({ chat, level, sessionId }) => {
      if (chat.kind === 'system') return []
      const chatId = chat.chatId
      const owner = () => hub.turnSendersAllOwner(sessionId)
      const management = () => ({ admin: true, chatId, actorId: String(api.config().ownerQQ || '') })
      const denied = () => ({ ok: false, message: '只有主人能管理表情库' })
      const explicitlyRequested = item => {
        const actor = hub.turnActor?.(sessionId), request = actor?.requestId && storage.requests.get(actor.requestId)
        if (!actor || actor.error || !request || request.actorId !== String(actor.actorId) || request.chatId !== chatId ||
          request.epoch !== storage.epochs.current(chatId) || ['canceled', 'cancel_requested', 'closed', 'expired', 'ended', 'answered'].includes(request.state)) return false
        return request.sourceMessageIds.some(id => {
          const m = storage.messages.get(id), text = (m?.segments || []).filter(s => s?.type === 'text').map(s => String(s.data?.text || '')).join('')
          return m && !m.recalledAt && m.account === String(api.config().botQQ) && m.chatId === chatId && m.authorId === request.actorId &&
            /发|来一?张|来个|用|贴|展示/u.test(text) && [item.id, item.name].some(v => v && text.includes(v))
        })
      }
      const tools = [
        defineTool({ name: 'qq_collect_sticker_candidates', description: '在选择收藏模式中列出本轮消息里可选择的表情来源 ID。', execute: async () => {
          if (api.config().stickers.collectMode !== 'ask') return { ok: false, message: '当前不是选择收藏模式' }
          const actor = hub.turnActor?.(sessionId), request = actor?.requestId && storage.requests.get(actor.requestId)
          if (!actor || actor.error || !request || request.actorId !== String(actor.actorId) || request.chatId !== chatId || request.epoch !== storage.epochs.current(chatId) || ['canceled', 'cancel_requested', 'closed', 'expired', 'ended', 'answered', 'delivery_partial', 'delivery_unknown'].includes(request.state)) return { ok: false, message: '请求已失效' }
          const items = request.sourceMessageIds.flatMap(id => storage.occurrences.ofMessage(id)).filter(o => o.chatId === chatId && o.kind === 'sticker' && Date.now() - o.createdAt < 30 * 60_000 && o.createdAt <= Date.now())
            .filter(o => { const m = storage.messages.get(o.messageId); return m && !m.recalledAt && m.account === String(api.config().botQQ) && m.chatId === chatId && m.authorId === request.actorId && o.authorId === m.authorId && m.segments?.[o.segIndex] })
            .map(o => ({ id: o.id, authorId: o.authorId }))
          return { ok: true, items, message: items.length ? '选择需要收藏的来源 ID' : '本轮没有可选表情' }
        } }),
        defineTool({ name: 'qq_collect_sticker_selection', description: '选择收藏模式下，保存本轮列出的一个表情来源 ID。', properties: { id: str('本轮候选来源 ID') }, required: ['id'], execute: async ({ id }) => {
          const actor = hub.turnActor?.(sessionId), request = actor?.requestId && storage.requests.get(actor.requestId), o = storage.occurrences.get(String(id || ''))
          if (api.config().stickers.collectMode !== 'ask' || !actor || actor.error || !request || request.actorId !== String(actor.actorId) || request.chatId !== chatId || request.epoch !== storage.epochs.current(chatId) || ['canceled', 'cancel_requested', 'closed', 'expired', 'ended', 'answered', 'delivery_partial', 'delivery_unknown'].includes(request.state) || !o || !request.sourceMessageIds.includes(o.messageId) || o.chatId !== chatId || o.kind !== 'sticker' || Date.now() - o.createdAt >= 30 * 60_000 || o.createdAt > Date.now()) return { ok: false, message: '候选已过期或不属于本轮' }
          const m = storage.messages.get(o.messageId), seg = m?.segments?.[o.segIndex]
          if (!m || m.recalledAt || m.account !== String(api.config().botQQ) || m.chatId !== chatId || m.authorId !== request.actorId || o.authorId !== m.authorId || !seg) return { ok: false, message: '来源不可用' }
          return store.collect(seg, { chatId, messageId: m.id, segmentIndex: o.segIndex, selectedOccurrence: true, occurrenceId: o.id, requestId: request.id, epoch: request.epoch })
        } }),
        defineTool({ name: 'qq_send_sticker', description: '在当前聊天发送已批准且用途合适的表情；没有合适项就不发。',
          properties: { name: str('名字或情绪关键词') }, required: ['name'], execute: async ({ name }) => {
            const item = store.match(String(name || ''), { chatId, allowManual: true, cooldown: true })
            if (!item) return { ok: false, message: '没有找到当前聊天可用且不在冷却中的表情' }
            if (item?.manualOnly && !explicitlyRequested(item)) return { ok: false, message: '这张表情仅在用户明确指定时发送' }
            const ok = await hub.sendSticker(chatId, String(name || ''), undefined, { allowManual: Boolean(item?.manualOnly), authorizeManual: () => Boolean(item && explicitlyRequested(item)) })
            return { ok: Boolean(ok), message: ok ? '发了' : '没有找到当前聊天可用的表情' }
          } }),
        defineTool({ name: 'qq_list_stickers', description: '查看表情库中可用于当前聊天的表情；默认同一机器人账号的所有聊天共用图库。', properties: { query: str('可选名字或标签') },
          execute: async ({ query }) => {
            const r = store.list({ chatId, query, limit: 60, automatic: true })
            const items = r.items
            return { ok: true, count: r.total, items: items.map((it) => ({ id: it.id, name: it.name, tags: it.tags })),
              message: items.length ? items.map((it) => it.name || '未命名').join('、') : '没有可用表情' }
          } }),
        defineTool({ name: 'qq_edit_sticker', description: '主人要求时修改表情库中的名字、标签或删除。账号共用模式下对所有聊天生效；删除会保留阻止重新收藏的记录。',
          properties: { sticker: str('现在的名字或标签'), new_name: str('新名字'), tags: { type: 'array', items: { type: 'string' } }, delete: { type: 'boolean' } }, required: ['sticker'],
          execute: async ({ sticker, new_name, tags, delete: del }) => {
            if (!owner()) return denied()
            const item = store.match(String(sticker || ''), { chatId, allowManual: true })
            if (!item) return { ok: false, message: '图库里没有这张可用表情' }
            return del ? store.remove(item.id, management()) : store.rename(item.id, new_name, tags, management())
          } }),
        defineTool({ name: 'qq_save_sticker', description: '主人要求时把当前聊天最近图片保存到表情库，随后自动识别并按审核设置处理；本地保存不代表 QQ 收藏同步成功。',
          properties: { name: str('备注'), tags: { type: 'array', items: { type: 'string' } } }, execute: async ({ name, tags }) => {
            if (!owner()) return denied()
            const media = hub.recentMedia(chatId)
            const pick = media.filter((x) => x.userId === String(api.config().ownerQQ)).at(-1) || media.at(-1)
            if (!pick) return { ok: false, message: '当前聊天没有可保存的近期图片' }
            const account = String(api.config().botQQ)
            const buf = await segmentBytes(pick.seg, onebot, { maxBytes: 5 * 1024 * 1024 })
            const current = storage.messages.get(pick.messageId)
            if (!owner() || String(api.config().botQQ) !== account || !current || current.recalledAt || current.account !== account || current.chatId !== chatId ||
              !hub.recentMedia(chatId).some(x => x.messageId === pick.messageId && JSON.stringify(x.seg) === JSON.stringify(pick.seg))) return denied()
            return store.addFromBuffer(buf, { chatId, name: name || '', tags: tags || [], from: 'tool', toQQ: true, messageId: pick.messageId, segment: pick.seg })
          } }),
        defineTool({ name: 'qq_import_qq_stickers', description: '把 QQ 收藏导入表情库，新素材识别通过后可用；使用范围遵循当前图库设置。', execute: async () => {
          if (!owner()) return denied()
          return store.importFromQQ(management())
        } }),
      ]
      if (level === 'full') tools.push(defineTool({ name: 'qq_add_sticker', description: '主人指定图片路径或网址时保存到表情库，随后自动识别并按审核设置处理；使用范围遵循当前图库设置。',
        properties: { source: str('图片路径或 http(s) 地址'), name: str('备注'), tags: { type: 'array', items: { type: 'string' } } }, required: ['source'],
        execute: async ({ source, name, tags }) => {
          if (!owner()) return denied()
          const account = String(api.config().botQQ), bytes = await fetchImage(String(source), { maxBytes: 5 * 1024 * 1024, allowLocal: true })
          if (!owner() || String(api.config().botQQ) !== account) return denied()
          return store.addFromBuffer(bytes, { chatId, name: name || '', tags: tags || [], from: 'tool' })
        } }))
      return tools
    })

    route('/stickers', async (req) => ({ ok: true, ...store.list(adminOptions(http.query(req))) }))
    route('/stickers/stats', async (req) => ({ ok: true, ...store.stats(adminOptions(http.query(req))) }))
    route('/sticker/detail', async (req) => { const q = http.query(req); const item = store.get(idOf(q), adminOptions(q)); return { ok: Boolean(item), item } })
    route('/stickers/queue', async (req) => ({ ok: true, ...store.queueStatus(adminOptions(http.query(req))) }))
    route('/sticker/image', async (req, res) => {
      const q = http.query(req)
      const image = store.preview(idOf(q), adminOptions(q))
      return image ? http.send(res, 200, image.bytes, image.mime) : http.send(res, 404, '')
    })
    post('/sticker/rename', (b, o) => store.rename(idOf(b), b.name, b.tags, o))
    post('/sticker/edit', (b, o) => store.edit(idOf(b), b.patch || {}, o))
    post('/sticker/approve', (b, o) => store.approve(idOf(b), o))
    post('/sticker/reject', (b, o) => store.reject(idOf(b), o))
    post('/sticker/disable', (b, o) => store.disable(idOf(b), o))
    post('/sticker/delete', (b, o) => store.remove(idOf(b), o))
    post('/sticker/frames', (b, o) => store.selectFrames(idOf(b), b.frames, o))
    post('/sticker/analysis/retry', (b, o) => store.retryAnalysis(idOf(b), o))
    post('/sticker/sync', (b, o) => store.queueSync(idOf(b), o))
    post('/sticker/task/retry', (b, o) => store.retryTask(b.taskId, o))
    post('/stickers/batch', (b, o) => store.batch(b.action, b.entries, o))
    post('/sticker/analysis/reconcile', (b, o) => store.reconcileAnalysis(b.taskId, o))
    post('/sticker/sync/reconcile', (b, o) => store.reconcileSync(b.taskId, o))
    post('/sticker/sync/bind', (b, o) => store.bindQQ(idOf(b), o))
    post('/sticker/import-qq', (_b, o) => store.importFromQQ(o))
    post('/sticker/legacy/import', (_b, o) => store.importLegacy(legacyDir, o))
    post('/sticker/legacy/assign', (b, o) => store.assignLegacy(b.id, o))
    post('/sticker/legacy/delete', (b, o) => store.deleteLegacy(b.id, o))
    post('/sticker/upload', (b, o) => {
      const bytes = Buffer.from(String(b.data || '').replace(/^data:[^,]+,/, ''), 'base64')
      return store.addFromBuffer(bytes, { ...o, name: b.name || '', tags: b.tags || [], from: 'panel', toQQ: b.toQQ !== false })
    })
    api.rule(() => '- 表情库默认同账号共用。新素材识别明确通过后自动可用；以实际状态为准，本地保存不等于审核或 QQ 收藏已成功。没有合适的可用表情就不发。')
    store.recover()
    store.start()
    api.onDispose?.(() => store.stop())
    return store
  },
}

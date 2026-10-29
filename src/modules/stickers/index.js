// 面板路由沿用宿主认证通道；聊天工具只允许主人做管理操作。
import { createStickerStore } from '../../features/stickers.js'
import { defineTool, str } from '../../tools/tools.js'
import { fetchImage, segmentBytes } from '../../core/net.js'
import { dataDir } from '../../core/store.js'

export default {
  id: 'stickers', name: '表情包', version: '2.0.0', tab: 'stickers',
  description: '按聊天收藏、审核和选择表情；QQ 收藏同步独立跟踪',
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
      const owner = () => hub.turnHasOwner(sessionId)
      const management = () => ({ admin: true, chatId, actorId: String(api.config().ownerQQ || '') })
      const denied = () => ({ ok: false, message: '只有主人能管理表情库' })
      const tools = [
        defineTool({ name: 'qq_send_sticker', description: '在当前聊天发送已批准且用途合适的表情；没有合适项就不发。',
          properties: { name: str('名字或情绪关键词') }, required: ['name'], execute: async ({ name }) => {
            const ok = await hub.sendSticker(chatId, String(name || ''))
            return { ok: Boolean(ok), message: ok ? '发了' : '没有找到当前聊天可用的表情' }
          } }),
        defineTool({ name: 'qq_list_stickers', description: '查看当前聊天可使用的已审核表情。', properties: { query: str('可选名字或标签') },
          execute: async ({ query }) => {
            const r = store.list({ chatId, query, limit: 60 })
            return { ok: true, count: r.total, items: r.items.map((it) => ({ id: it.id, name: it.name, tags: it.tags })),
              message: r.items.length ? r.items.map((it) => it.name || '未命名').join('、') : '没有可用表情' }
          } }),
        defineTool({ name: 'qq_edit_sticker', description: '主人要求时修改当前聊天表情名字、标签或删除。删除会保留阻止重新收藏的记录。',
          properties: { sticker: str('现在的名字或标签'), new_name: str('新名字'), tags: { type: 'array', items: { type: 'string' } }, delete: { type: 'boolean' } }, required: ['sticker'],
          execute: async ({ sticker, new_name, tags, delete: del }) => {
            if (!owner()) return denied()
            const item = store.match(String(sticker || ''), chatId)
            if (!item) return { ok: false, message: '当前聊天没有这张表情' }
            return del ? store.remove(item.id, management()) : store.rename(item.id, new_name, tags, management())
          } }),
        defineTool({ name: 'qq_save_sticker', description: '主人要求时保存当前聊天最近图片为待审核素材；本地保存不代表 QQ 收藏同步成功。',
          properties: { name: str('备注'), tags: { type: 'array', items: { type: 'string' } } }, execute: async ({ name, tags }) => {
            if (!owner()) return denied()
            const media = hub.recentMedia(chatId)
            const pick = media.filter((x) => x.userId === String(api.config().ownerQQ)).at(-1) || media.at(-1)
            if (!pick) return { ok: false, message: '当前聊天没有可保存的近期图片' }
            const buf = await segmentBytes(pick.seg, onebot, { maxBytes: 5 * 1024 * 1024 })
            return store.addFromBuffer(buf, { chatId, name: name || '', tags: tags || [], from: 'tool', toQQ: true })
          } }),
        defineTool({ name: 'qq_import_qq_stickers', description: '把 QQ 收藏导入当前聊天的待审区；不会自动跨群共享。', execute: async () => {
          if (!owner()) return denied()
          return store.importFromQQ(management())
        } }),
      ]
      if (level === 'full') tools.push(defineTool({ name: 'qq_add_sticker', description: '主人指定图片路径或网址时保存为当前聊天待审核素材。',
        properties: { source: str('图片路径或 http(s) 地址'), name: str('备注'), tags: { type: 'array', items: { type: 'string' } } }, required: ['source'],
        execute: async ({ source, name, tags }) => {
          if (!owner()) return denied()
          return store.addFromBuffer(await fetchImage(String(source), { maxBytes: 5 * 1024 * 1024 }), { chatId, name: name || '', tags: tags || [], from: 'tool' })
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
    api.rule(() => '- 保存表情只代表本地待审核；不能说已批准或 QQ 收藏成功。没有合适的已批准表情就不发。')
    store.recover()
    store.start()
    api.onDispose?.(() => store.stop())
    return store
  },
}

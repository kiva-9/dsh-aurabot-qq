import { createMediaAnalysis, DEFAULT_MEDIA_MEMORY, MEDIA_MEMORY_SCHEMA } from '../../runtime/media-analysis.js'

export default {
  id: 'media-memory', name: '图片理解', version: '1.0.0', tab: 'media-memory',
  description: '按图片出现记录保存视觉描述和 OCR，默认关闭，持久任务与独立人工说明',
  files: ['runtime/media-analysis.js', 'runtime/image-frames.js'],
  setup(api) {
    const service = createMediaAnalysis({ storage: api.core.storage, getConfig: api.config, ask: (options) => api.ask(options), dsh: api.dsh, log: api.log })
    function route(path, method, handler) {
      api.route('/media-memory/' + path, async (req) => {
        try {
          if (req.method !== method) return { ok: false, code: 'METHOD_NOT_ALLOWED', message: `此接口只接受 ${method}` }
          const input = method === 'GET' ? api.core.http.query(req) : await api.core.http.body(req)
          if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, code: 'INVALID_INPUT', message: '需要对象参数' }
          const account = String(api.config().botQQ || '')
          if (input.account !== undefined && String(input.account) !== account) return { ok: false, code: 'SCOPE_FORBIDDEN', message: '只允许当前账号' }
          return { ok: true, account, ...await handler({ ...input, actorId: String(api.config().ownerQQ || 'owner-panel') }) }
        } catch (error) { return { ok: false, code: error.code || 'MEDIA_ERROR', message: error.message } }
      })
    }
    route('items', 'GET', (q) => ({ items: service.list(q) }))
    route('jobs', 'GET', (q) => ({ jobs: service.jobs(q) }))
    route('status', 'GET', (q) => service.status(q))
    route('jobs/status', 'GET', (q) => service.status(q))
    route('analyze', 'POST', (b) => service.analyze(b))
    route('retry', 'POST', (b) => service.retry(b))
    route('disable', 'POST', (b) => ({ item: service.disable(b) }))
    route('restore', 'POST', (b) => ({ item: service.restore(b) }))
    api.on('config', () => service.syncConfig())
    api.on('activity', (a) => {
      if (a.kind !== 'in') return
      const chatId = a.msg?.chatId || a.chatId
      if (!chatId || (a.account && String(a.account) !== String(api.config().botQQ)) ||
          (a.msg?.account && String(a.msg.account) !== String(api.config().botQQ))) return
      try { service.discover({ chatId }) } catch (error) { api.log?.warn?.('媒体来源登记未完成：', error.code || 'INVALID') }
    })
    api.every(2000, () => service.tick(), '图片理解队列')
    api.onDispose?.(() => service.stop())
    return { ...service, defaults: DEFAULT_MEDIA_MEMORY, schema: MEDIA_MEMORY_SCHEMA }
  },
}

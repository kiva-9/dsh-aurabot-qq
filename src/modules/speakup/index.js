// 主动搭话：默认主人私聊；额外目标必须由主人显式配置，所有入口共用额度与静默规则。

import { createSpeakUp } from '../../features/companion.js'

export default {
  id: 'speakup',
  name: '主动搭话',
  version: '1.0.0',
  description: '在显式配置的目标聊天中主动搭话，默认仅主人私聊',
  tab: 'speakup',
  files: ['features/companion.js'],
  setup(api) {
    const { hub, mutes, storage } = api.core
    const speakUp = createSpeakUp({ getConfig: api.config, hub, storage, memory: api.lazy('memory'), log: api.log, isMuted: (chatId) => mutes.muted(chatId) })
    const manual = target => api.config().speakUp.mode === 'purpose'
      ? api.use?.('purpose')?.fire?.(target) ?? { ok: false, code: 'PURPOSE_UNAVAILABLE', message: '主动目的模块未运行' }
      : speakUp.fire('手动', { target })
    api.every(60_000, () => speakUp.tick(), '主动搭话')
    api.route('/speakup/fire', async (req) => {
      const body = await api.core.http.body(req) || {}
      return manual(body.target)
    })
    api.command({ name: 'speak', desc: '按主动搭话规则向指定目标说话', async run(arg, msg) {
      if (String(msg.userId) !== String(api.config().ownerQQ)) return '只有主人可以触发主动搭话'
      const target = String(arg || '').trim() || msg.chatId
      return (await manual(target)).message
    } })
    api.onDispose?.(() => speakUp.stop())
    return speakUp
  },
}

// 内置模块：主动搭话。主人一阵子没找她时，她会在私聊里主动找主人聊几句（群里不会）。

import { createSpeakUp } from '../../features/companion.js'

export default {
  id: 'speakup',
  name: '主动搭话',
  version: '1.0.0',
  description: '主人一阵子没理她时，在私聊里主动找主人说话',
  tab: 'speakup',
  files: ['features/companion.js'],
  setup(api) {
    const { hub, mutes, storage } = api.core
    const speakUp = createSpeakUp({ getConfig: api.config, hub, storage, memory: api.lazy('memory'), log: api.log, isMuted: (chatId) => mutes.muted(chatId) })
    api.every(60_000, () => speakUp.tick(), '主动搭话')
    api.route('/speakup/fire', async () => speakUp.fire('手动'))
    api.onDispose?.(() => speakUp.stop())
    return speakUp
  },
}

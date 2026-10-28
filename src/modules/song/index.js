// 内置模块：翻唱。点歌 → 网易云下载 → 分离人声 → RVC 换成她的音色 → 混音 → 发语音条。
// 换声这一步可以在「本地接口」里接你自己的推理（so-vits-svc、自己训练的 RVC……）；整个模块也可以替换掉。

import { createSongStudio, checkRoot, listDrives } from '../../song/studio.js'
import { defineTool, str, int } from '../../tools/tools.js'
import { randomUUID } from 'node:crypto'

export default {
  id: 'song',
  name: '翻唱',
  version: '1.0.0',
  description: '用她的声音翻唱一首歌，做好发语音条（qq_song_cover、/sing）',
  tab: 'song',
  files: ['song/studio.js'],
  setup(api) {
    const { hub, local, http, storage } = api.core
    const mood = api.lazy('mood')
    const memory = api.lazy('memory')
    const song = createSongStudio({
      local,
      hub, storage,
      getConfig: api.config,
      log: api.log,
      sendVoiceFile: (chatId, file, note, options) => hub.sendVoiceFile(chatId, file, note, options),
      onSung: (title, chatId, evidence) => {
        const cfg = api.config()
        // 唱过的歌记成她的经历：私聊记到对方头上
        const uid = String(chatId).startsWith('private:') ? String(chatId).slice(8) : ''
        const who = uid === String(cfg.ownerQQ) ? cfg.ownerName || '主人' : uid ? '对方' : '群里'
        if (!evidence?.confirmed || !evidence.receipt?.message_id || cfg.dryRun) return { ok: false, message: '缺少真实翻唱回执' }
        const scope = { account: evidence.account, chat: chatId, persona: evidence.persona }
        const result = memory.addEvent?.({ scope, text: `给${who}唱了《${title}》`, about: uid, actorId: evidence.actorId,
          tags: ['唱歌'], importance: 0.5, confirmed: true, sourceId: evidence.sourceId, eventTime: evidence.eventTime })
        if (result?.ok && !result.reused) {
          const evidenceMessageIds = storage.requests.get(evidence.requestId)?.sourceMessageIds || []
          if (evidenceMessageIds.length) {
            try { mood.nudge?.(scope, 8, `唱完了「${title}」`, { evidenceMessageIds, origin: 'song' }) }
            catch (e) { api.log?.warn?.('翻唱已送达，心情未更新：', e.message) }
          }
          api.emit('song/sung', { title, chatId, ...evidence })
        }
        return result || { ok: false, message: '记忆模块不可用，保留回执待补记' }
      },
    })
    const context = (chatId, actorId, requestId) => {
      const personaSnapshot = hub.personaFor?.(chatId)
      return { account: String(api.config().botQQ), chatId, actorId: String(actorId || ''), requestId,
        epoch: storage.epochs.current(chatId), persona: personaSnapshot?.personaId, personaSnapshot }
    }
    const turn = (chat, sessionId) => {
      const who = hub.turnActor(sessionId)
      if (!who || who.error || !who.requestId || !who.actorId) throw new Error(who?.error || '点歌需要当前请求身份')
      if (hub.chatOfSession?.(sessionId) !== chat.chatId) throw new Error('工具会话范围不一致')
      const r = storage.requests.get(who.requestId)
      if (!r || r.chatId !== chat.chatId || r.actorId !== String(who.actorId) || r.epoch !== storage.epochs.current(chat.chatId) || ['canceled', 'cancel_requested'].includes(r.state)) throw new Error('请求归属不一致或已取消')
      if (r.sourceMessageIds.some((id) => storage.messages.get(id)?.account !== String(api.config().botQQ))) throw new Error('请求来源不属于当前账号')
      return { ...context(chat.chatId, who.actorId, who.requestId), epoch: r.epoch }
    }
    song.recover()
    api.every(1500, () => song.tick(), '翻唱任务')
    api.onDispose?.(() => song.stop())

    // 面板里打开了才给她（没开就别让她答应唱歌）
    api.tool(({ chat, sessionId }) => (api.config().song.enabled && chat.kind !== 'system' ? defineTool({
      name: 'qq_song_cover',
      description: '用你自己的声音翻唱一首歌，做好后自动以语音条发到当前聊天（要两三分钟，调用后先简单回一句「等我一下」就好）。song 写歌名，最好带上歌手，比如「小幸运 田馥甄」。pitch 是变调半音：你是女声，原唱是男声时一般 +12，原唱是女声时 0。',
      properties: { song: str('歌名（可以带歌手）'), pitch: int('变调半音：原唱男声 +12，女声 0') },
      required: ['song'],
      execute: async ({ song: name, pitch }) => {
        const who = turn(chat, sessionId)
        if (api.config().song.ownerOnly && who.actorId !== String(api.config().ownerQQ)) return { ok: false, message: '只有主人能点歌' }
        return song.request({ song: name, pitch, ...who })
      },
    }) : []))
    api.tool(({ chat, sessionId }) => chat.kind === 'system' ? [] : [defineTool({
      name: 'qq_cancel_song', description: '取消当前请求者自己的翻唱任务，已经产生的结果会保留，迟到结果不再发送。',
      properties: { job_id: str('翻唱任务 ID') }, required: ['job_id'], execute: ({ job_id }) => song.cancel(job_id, turn(chat, sessionId)),
    })])
    api.command?.({ name: 'sing', aliases: ['唱'], desc: '翻唱一首歌', run(arg, msg) {
      const source = storage.messages.byPlatformId(msg.chatId, msg.messageId)
      if (!source || source.authorId !== String(msg.userId) || source.account !== String(api.config().botQQ)) return '缺少已登记的命令来源，未创建翻唱任务'
      const match = String(arg).match(/^(.*?)\s+([+-]\d{1,2})$/)
      const name = (match ? match[1] : String(arg)).trim()
      if (!name) return '唱哪首？比如 /sing 小幸运 田馥甄'
      const request = storage.requests.create({ chatId: msg.chatId, actorId: msg.userId, sourceMessageIds: [source.id] })
      return song.request({ song: name, pitch: match ? Number(match[2]) : undefined, ...context(msg.chatId, msg.userId, request.id) }).message
    } })

    api.route('/song/status', async () => ({ ok: true, ...song.status() }))
    api.route('/song/install', async () => song.install())
    api.route('/song/root/check', async (req) => ({ ok: true, ...checkRoot(http.query(req).path || '') }))
    api.route('/song/drives', async () => ({ ok: true, list: listDrives() }))
    api.route('/song/search', async (req) => {
      try { return { ok: true, list: await song.search(http.query(req).q || '') } } catch (error) { return { ok: false, message: error.message, list: [] } }
    })
    api.route('/song/account', async () => song.account())
    // 导入音色：面板把文件原样传上来（.zip / .pth / .index），文件名放在 ?name= 里
    api.route('/song/import', async (req) => {
      const name = http.query(req).name || ''
      try {
        const buf = await http.raw(req, 1024 * 1024 * 1024)
        if (!buf.length) return { ok: false, message: '文件是空的' }
        const r = song.importModels(name, buf)
        if (r.ok) api.log.info('导入音色：' + r.message)
        return r
      } catch (error) {
        return { ok: false, message: '导入失败：' + error.message }
      }
    })
    api.route('/song/voice/delete', async (req) => song.deleteVoice(String((await http.body(req)).id || '')))
    // 面板里试唱：发到主人私聊
    api.route('/song/request', async (req) => {
      const b = await http.body(req)
      return song.request({ song: b.song, songId: b.songId, pitch: b.pitch, voice: b.voice,
        ...context(b.chatId || `private:${api.config().ownerQQ}`, api.config().ownerQQ, `panel:${randomUUID()}`) })
    })
    api.route('/song/cancel', async (req) => { const b = await http.body(req); return song.cancel(b.id, context(b.chatId, api.config().ownerQQ, 'panel')) })
    api.route('/song/resend', async (req) => { const b = await http.body(req); return song.resend(b.id, context(b.chatId, api.config().ownerQQ, 'panel')) })
    return song
  },
}

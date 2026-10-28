// 入站媒体：消息一到先给每张图 / 每个表情 / 每条语音登记出现记录（pending），
// 然后在后台下载、存成资产、转写语音，结果回填到这条消息自己的出现记录上（不按「某人最后一条」去对）。
// 调度器靠 isReady 判断这条消息能不能交给她；处理完（成功或失败）调 onSettled 叫醒调度器。

import { readFileSync } from 'node:fs'
import { makeScope } from '../domain/scope.js'

const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/**
 * @param {object} o
 * @param {object} o.storage
 * @param {(seg: object) => Promise<Buffer>} o.fetchBytes 下载图片段的字节
 * @param {(buf: Buffer) => string} o.mimeOf
 * @param {(rec: object, msg: object) => Promise<string>} o.transcribe 语音转文字（转不出来返回空串）
 * @param {(chatId: string) => void} o.onSettled
 */
export function createMediaResolver({ storage, fetchBytes, mimeOf, transcribe, onSettled, log }) {
  const pending = new Map() // messageId → Set(occurrenceId)

  /**
   * 登记一条消息里的媒体并开始后台处理。msg 是 parseMessageEvent 的结果，messageId 是主库里的消息 ID。
   * wantTranscript=false 时语音不转写（设置里关了识别）。
   */
  function register({ messageId, msg, account, wantTranscript = true }) {
    const ids = []
    const left = new Set()
    for (const m of msg.media || []) {
      const scope = makeScope({ account, chat: msg.chatId, category: m.kind === 'record' ? 'message' : 'image' })
      const id = storage.occurrences.add({
        messageId, chatId: msg.chatId, authorId: msg.userId, segIndex: m.index, kind: m.kind,
        remote: { url: m.seg.data?.url || '', file: m.seg.data?.file || '' }, scope,
      })
      ids.push({ id, kind: m.kind, seg: m.seg })
      left.add(id)
    }
    if (!ids.length) return []
    pending.set(messageId, left)
    for (const it of ids) {
      process(it, msg, wantTranscript)
        .catch((error) => storage.occurrences.failed(it.id, error.message))
        .finally(() => {
          left.delete(it.id)
          if (!left.size) pending.delete(messageId)
          try { onSettled?.(msg.chatId) } catch (error) {}
        })
    }
    return ids.map((x) => x.id)
  }

  async function process(it, msg, wantTranscript) {
    if (it.kind === 'record') {
      if (!wantTranscript) return storage.occurrences.failed(it.id, '没开语音识别', 'unavailable')
      const text = String((await transcribe(it.seg, msg)) || '').trim()
      if (!text) return storage.occurrences.failed(it.id, '没听清')
      storage.occurrences.ready(it.id, null, { transcript: text })
      return
    }
    const buf = await fetchBytes(it.seg, { maxBytes: MAX_IMAGE_BYTES })
    const mime = mimeOf(buf)
    if (!mime.startsWith('image/')) return storage.occurrences.failed(it.id, `不是图片（${mime}）`)
    const asset = storage.assets.put(buf, { mime, sourceKind: 'inbound' })
    storage.occurrences.ready(it.id, asset.id)
  }

  /** 这条消息的媒体都处理完了没有（失败也算处理完）。 */
  const isReady = (messageId) => !pending.has(messageId)

  /**
   * 这条消息的媒体处理结果，按原消息顺序。images 只含成功的图片（带 base64），
   * failedImages 是没下载下来的张数，transcripts 是语音转写。
   */
  function resultsOf(messageId) {
    const occ = storage.occurrences.ofMessage(messageId)
    const images = []
    let failedImages = 0
    let pendingCount = 0
    const transcripts = []
    let unheard = 0
    for (const o of occ) {
      if (o.state === 'pending') { pendingCount++; continue }
      if (o.kind === 'record') {
        if (o.state === 'ready' && o.analysis?.transcript) transcripts.push(o.analysis.transcript)
        else unheard++
        continue
      }
      if (o.state !== 'ready' || !o.assetId) { failedImages++; continue }
      const a = storage.assets.get(o.assetId)
      try {
        images.push({ occurrenceId: o.id, assetId: a.id, kind: o.kind, mediaType: a.mime, data: readFileSync(storage.assets.pathOf(a)).toString('base64') })
      } catch (error) {
        log?.debug?.('读不到资产文件：', error.message)
        failedImages++
      }
    }
    return { images, failedImages, pending: pendingCount, transcripts, unheard }
  }

  return { register, isReady, resultsOf }
}

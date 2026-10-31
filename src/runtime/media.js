// 入站媒体：消息一到先给每张图 / 每个表情 / 每条语音登记出现记录（pending），
// 然后在后台下载、存成资产、转写语音，结果回填到这条消息自己的出现记录上（不按「某人最后一条」去对）。
// 调度器靠 isReady 判断这条消息能不能交给她；处理完（成功或失败）调 onSettled 叫醒调度器。

import { createHash } from 'node:crypto'
import { fetchImage, readLocalBytes } from '../core/net.js'
import { prepareImage } from './image-prepare.js'
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
export function createMediaResolver({ storage, fetchBytes, mimeOf, transcribe, onSettled, log, prepare = prepareImage }) {
  const pending = new Map() // messageId → Set(occurrenceId)
  let disposed = false

  /**
   * 登记一条消息里的媒体并开始后台处理。msg 是 parseMessageEvent 的结果，messageId 是主库里的消息 ID。
   * wantTranscript=false 时语音不转写（设置里关了识别）。
   */
  function register({ messageId, msg, account, wantTranscript = true }) {
    if (disposed) return []
    const ids = []
    const left = new Set()
    for (const m of msg.media || []) {
      const scope = makeScope({ account, chat: msg.chatId, category: m.kind === 'record' ? 'message' : 'image' })
      const id = storage.occurrences.add({
        messageId, chatId: msg.chatId, authorId: msg.userId, segIndex: m.index, kind: m.kind,
        remote: { url: m.seg.data?.url || '', file: m.seg.data?.file || '', ...(m.forward ? { forward: m.forward } : {}) }, scope,
      })
      ids.push({ id, kind: m.kind, seg: m.seg })
      left.add(id)
    }
    if (!ids.length) return []
    pending.set(messageId, left)
    for (const it of ids) {
      process(it, msg, wantTranscript)
        .catch((error) => { if (!disposed) storage.occurrences.failed(it.id, error.message) })
        .finally(() => {
          left.delete(it.id)
          if (!left.size) pending.delete(messageId)
          try { if (!disposed) onSettled?.(msg.chatId) } catch (error) {}
        })
    }
    return ids.map((x) => x.id)
  }

  async function process(it, msg, wantTranscript) {
    if (it.kind === 'record') {
      if (!wantTranscript) return storage.occurrences.failed(it.id, '没开语音识别', 'unavailable')
      const text = String((await transcribe(it.seg, msg)) || '').trim()
      if (disposed) return
      if (!text) return storage.occurrences.failed(it.id, '没听清')
      storage.occurrences.ready(it.id, null, { transcript: text })
      return
    }
    const buf = await fetchBytes(it.seg, { maxBytes: MAX_IMAGE_BYTES })
    if (disposed) return
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
        images.push({ occurrenceId: o.id, assetId: a.id, kind: o.kind, mediaType: a.mime, data: readLocalBytes(storage.assets.pathOf(a), MAX_IMAGE_BYTES).toString('base64') })
      } catch (error) {
        log?.debug?.('读不到资产文件：', error.message)
        failedImages++
      }
    }
    return { images, failedImages, pending: pendingCount, transcripts, unheard }
  }

  async function prepareForModel(image, { signal, account, chatId } = {}) {
    const source = storage.assets.get(image.assetId)
    const checkSource = () => {
      signal?.throwIfAborted()
      if (disposed) throw new Error('媒体服务已停止')
      const current = source && storage.assets.get(source.id)
      if (!current || current.state !== 'stored' || current.sha256 !== source.sha256 || current.bytes > 32 * 1024 * 1024) throw new Error('原图资产不可用或超过 32 MB')
      if (image.occurrenceId) {
        const occurrence = storage.occurrences.get(image.occurrenceId)
        const message = occurrence?.messageId && storage.messages.get(occurrence.messageId)
        if (!occurrence || occurrence.state !== 'ready' || occurrence.assetId !== source.id || !message || message.recalledAt != null ||
            (account && message.account !== account) || (chatId && (message.chatId !== chatId || occurrence.chatId !== chatId))) throw new Error('图片来源已撤回或范围已变化')
      }
    }
    checkSource()
    const bytes = await fetchImage(storage.assets.pathOf(source), { maxBytes: 32 * 1024 * 1024, allowLocal: true, signal })
    if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error('原图资产内容已改变')
    const result = await prepare({ bytes, signal })
    checkSource()
    if (!result.derived) return { ...image, mediaType: result.mime, data: result.bytes.toString('base64') }
    // Thumbnail bytes live only in this model attachment. Retain a bounded
    // lineage manifest, without creating a shared asset that needs unsafe GC.
    const digest = createHash('sha256').update(result.bytes).digest('hex')
    storage.db.run(`CREATE TABLE IF NOT EXISTS image_derivative_manifest (
      source_asset_id TEXT PRIMARY KEY, derivative_sha256 TEXT NOT NULL, mime TEXT NOT NULL,
      width INTEGER NOT NULL, height INTEGER NOT NULL, purpose TEXT NOT NULL, state TEXT NOT NULL, updated_at INTEGER NOT NULL)`)
    storage.db.run(`INSERT INTO image_derivative_manifest(source_asset_id, derivative_sha256, mime, width, height, purpose, state, updated_at)
      VALUES (?, ?, ?, ?, ?, 'model-thumbnail', 'transient', ?)
      ON CONFLICT(source_asset_id) DO UPDATE SET derivative_sha256=excluded.derivative_sha256, mime=excluded.mime,
        width=excluded.width, height=excluded.height, updated_at=excluded.updated_at`, source.id, digest, result.mime, result.width, result.height, Date.now())
    return { ...image, originalAssetId: source.id, mediaType: result.mime, data: result.bytes.toString('base64') }
  }
  return { register, isReady, resultsOf, prepareForModel, dispose: () => { disposed = true; pending.clear() } }
}

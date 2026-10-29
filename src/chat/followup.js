const continuation = /^(?:为什么|怎么|如何|这个|这张|这幅|那张|那个|上面|刚才|然后|可是|但是|不对|错了|改成|换成|还有|能不能|请|帮我|不是|就是)|[?？]$/u
export const refersToEarlierMedia = text => /(?:上面|刚才|之前).*(?:图|问题|那个|内容)|(?:这|那)(?:张|幅|个)(?:图|截图|啊|呢|$)|看(?:看)?(?:图|上面)|图(?:里|中|上)/u.test(String(text || ''))

export function createFollowupTracker({ windowMs = () => 90000, now = Date.now } = {}) {
  const pending = new Map()
  return {
    accept({ account, chatId, actorId, epoch, messageId, text = '', direct, media = false, quote = false, stickerOnly = false, eventKind = 'message' }) {
      const at = now(), key = JSON.stringify([account, chatId, actorId, epoch])
      for (const [k,v] of pending) if (at - v.at > windowMs()) pending.delete(k)
      const last = pending.get(key), followup = !direct && eventKind === 'message' && !!last && !stickerOnly &&
        (media || quote || continuation.test(text.trim()) || last.attentionOnly && !!text.trim())
      if (direct || followup) {
        if (pending.size >= 512 && !pending.has(key)) pending.delete(pending.keys().next().value)
        pending.set(key, { at, messageId, attentionOnly: !text.trim() && !media })
      }
      return { followup, anchorId: followup ? last.messageId : null }
    },
    clear: () => pending.clear(),
  }
}

// Only infer one unambiguous same-author recent image message. An explicit
// quotation is resolved separately and never replaced by this heuristic.
export function earlierMediaSource(storage, { account, chatId, actorId, before, exclude = [], now = Date.now() }) {
  const ids = new Set(exclude)
  const candidates = storage.messages.recent(chatId, 80).filter(m => !ids.has(m.id) && m.account === account && m.chatId === chatId && m.authorId === actorId &&
    m.recalledAt == null && m.recvSeq < before && now - m.receivedAt <= 30 * 60000 &&
    storage.occurrences.ofMessage(m.id).some(o => o.kind === 'image' || o.kind === 'sticker'))
  return candidates.length === 1 ? candidates[0] : null
}

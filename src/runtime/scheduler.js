// 会话调度：按聊天把连发的消息攒成一批再交给她，同一个聊天同时只有一个在跑的回合。
//
// 计时都用本机单调时钟（平台时间只当内容证据）：
//   - 对方停顿 wait 毫秒就交；从第一条起最多等 max（被 @ 时等得短一些）
//   - 纯表情不延长已经开着的这一批
//   - 有图片 / 语音还没下载好：最多再多等 mediaExtra；下载好了且已经停顿够了就马上交
//   - 一批到期了但她还在回上一批：这批原样排着，后来的消息另开一批，不会把已到期的批次再拖长
//   - 私聊里她还在跑这一轮时，到期的批次直接插进当前这一轮（steer）

const BUSY_MAX_MS = 4 * 60_000 // 卡住保护：超过这么久就当上一轮已经结束
const RANK = { context: 0, engaged: 1, interject: 2, must: 3 }

export const realTimers = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t },
  clearTimeout: (t) => clearTimeout(t),
}

/**
 * @param {object} o
 * @param {(chat: object) => {enabled:boolean, waitMs:number, maxMs:number, mentionWaitMs:number, mediaExtraMs:number}} o.settings
 * @param {(chat: object, batch: object, info: {steer: boolean}) => Promise<void>} o.dispatch
 *   交给她。steer=false 时调度器已把这个聊天标成忙，回合结束（或交接失败）后要调 turnEnded。
 * @param {(chatId: string) => boolean} [o.canSteer] 这个聊天当前这一轮还在跑、能插话
 * @param {(entry: object) => boolean} [o.mediaReady] 这条消息的图片 / 语音都处理好了没有
 */
export function createScheduler({ settings, dispatch, canSteer = () => false, mediaReady = () => true, timers = realTimers, log }) {
  const open = new Map() // chatId → 正在攒的一批
  const ready = new Map() // chatId → [已到期、等着交的批次]
  const busySince = new Map() // chatId → 这一轮开始的时间
  let disposed = false

  const isBusy = (chatId) => busySince.has(chatId) && timers.now() - busySince.get(chatId) < BUSY_MAX_MS

  /**
   * 来了一条消息。entry: { messageId, actorId, mentioned, stickerOnly, mode }。
   * mode：must 一定回 / interject 插话 / engaged 在话题里 / context 只当上下文（不触发，只在已经有一批开着时并进去）。
   */
  function add(chat, entry) {
    if (disposed) return false
    const now = timers.now()
    let b = open.get(chat.chatId)
    if (!b) {
      if (entry.mode === 'context') return false
      b = { chat, entries: [], firstAt: now, quietAt: now, mode: 'context', timer: null }
      open.set(chat.chatId, b)
    }
    b.chat = chat
    b.entries.push(entry)
    if ((RANK[entry.mode] ?? 3) > (RANK[b.mode] ?? 3)) b.mode = entry.mode
    // 纯表情、只当上下文的消息不重新计停顿
    const extendsQuiet = !(entry.stickerOnly && b.entries.length > 1) && entry.mode !== 'context'
    const s = effective(chat)
    if (extendsQuiet) b.quietAt = now + (entry.mentioned ? Math.min(s.waitMs, s.mentionWaitMs) : s.waitMs)
    if (entry.mentioned) b.mentioned = true
    arm(b, s)
    return true
  }

  /** 关掉合并 = 不等停顿、不设上限，但图片 / 语音没处理完时照样等一会儿（不能交一轮没图的「编辑这张图」）。 */
  function effective(chat) {
    const s = settings(chat)
    return s.enabled ? s : { ...s, waitMs: 0, maxMs: 0, mentionWaitMs: 0 }
  }

  function arm(b, s = effective(b.chat)) {
    timers.clearTimeout(b.timer)
    const now = timers.now()
    const media = !b.entries.every((e) => mediaReady(e))
    const cap = b.firstAt + s.maxMs + (media ? s.mediaExtraMs : 0)
    const due = media ? cap : Math.min(b.quietAt, cap)
    b.timer = timers.setTimeout(() => onTimer(b.chat.chatId), Math.max(0, due - now))
  }

  function onTimer(chatId) {
    const b = open.get(chatId)
    if (!b) return
    const s = effective(b.chat)
    const now = timers.now()
    const media = !b.entries.every((e) => mediaReady(e))
    const hardCap = b.firstAt + s.maxMs + s.mediaExtraMs
    if (media && now < hardCap) return arm(b, s)
    if (media) b.mediaTimedOut = true
    mature(chatId)
  }

  /** 某条消息的媒体处理完了（成功或失败都算）：已经停顿够了就马上交。 */
  function mediaSettled(chatId) {
    const b = open.get(chatId)
    if (!b) return
    if (b.entries.every((e) => mediaReady(e)) && timers.now() >= b.quietAt) return mature(chatId)
    arm(b)
  }

  function mature(chatId) {
    const b = open.get(chatId)
    if (!b) return
    timers.clearTimeout(b.timer)
    open.delete(chatId)
    const list = ready.get(chatId) || []
    list.push({ chat: b.chat, entries: b.entries, mode: b.mode, mentioned: Boolean(b.mentioned), mediaTimedOut: Boolean(b.mediaTimedOut) })
    ready.set(chatId, list)
    pump(chatId)
  }

  /** 到期的批次交出去：空闲就开新一轮；私聊正在跑就插话；否则等这一轮结束。 */
  function pump(chatId) {
    if (disposed) return
    const list = ready.get(chatId)
    if (!list || !list.length) return
    if (isBusy(chatId)) {
      if (list[0].chat.kind === 'private' && canSteer(chatId)) {
        ready.delete(chatId)
        run(merge(list), true)
      }
      return
    }
    ready.delete(chatId)
    busySince.set(chatId, timers.now())
    run(merge(list), false)
  }

  function run(batch, steer) {
    Promise.resolve()
      .then(() => { if (!disposed) return dispatch(batch.chat, batch, { steer }) })
      .catch((error) => {
        log?.warn?.(`交给她失败（${batch.chat.chatId}）：`, error.message)
        if (!steer) turnEnded(batch.chat.chatId)
      })
  }

  /** 排着的几批合成一批（按到达顺序）。 */
  function merge(list) {
    if (list.length === 1) return list[0]
    const mode = list.reduce((m, b) => ((RANK[b.mode] ?? 3) > (RANK[m] ?? 3) ? b.mode : m), 'context')
    return { chat: list.at(-1).chat, entries: list.flatMap((b) => b.entries), mode, mentioned: list.some((b) => b.mentioned), mediaTimedOut: list.some((b) => b.mediaTimedOut) }
  }

  /** 这一轮结束（说完了 / 没说 / 出错）：放开，把这期间到期的批次交出去。 */
  function turnEnded(chatId) {
    busySince.delete(chatId)
    pump(chatId)
  }

  /** 丢掉这个聊天里还没交出去的消息（重开会话时用）。 */
  function drop(chatId) {
    const b = open.get(chatId)
    if (b) timers.clearTimeout(b.timer)
    open.delete(chatId)
    ready.delete(chatId)
  }

  function state(chatId) {
    const b = open.get(chatId)
    return {
      open: b ? { count: b.entries.length, mode: b.mode } : null,
      ready: (ready.get(chatId) || []).reduce((n, x) => n + x.entries.length, 0),
      busy: isBusy(chatId),
    }
  }

  function dispose() {
    disposed = true
    for (const b of open.values()) timers.clearTimeout(b.timer)
    open.clear(); ready.clear(); busySince.clear()
  }
  function reserve(chatId) {
    if (disposed || isBusy(chatId) || open.has(chatId) || ready.get(chatId)?.length) return false
    busySince.set(chatId, timers.now())
    return true
  }
  return { add, mediaSettled, turnEnded, drop, dispose, state, isBusy, reserve, hasOpen: (chatId) => open.has(chatId) }
}

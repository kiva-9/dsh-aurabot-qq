// B站资料按当前聊天读取；自动浏览限主人私聊。只有真实动作回执可写入经历。

import { dataDir, readJson, writeJson } from '../core/store.js'
import { createBiliApi, findVideoId, parseCookie } from './api.js'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createSearchHttp } from '../search/net.js'
import { videoFrame, previewFrame, frameTimes, progressiveWindows } from './frames.js'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

// 这些错误说明今天别再发了：没登录 / Cookie 过期、csrf 不对、风控、要验证码、太频繁
const PAUSE_CODES = { '-101': 'B 站没登录或 Cookie 过期了', '-111': 'Cookie 里的 bili_jct 不对', '-352': '被 B 站风控了', '-509': '发得太频繁', '12015': 'B 站要求验证码' }
import { isSilence } from '../chat/reply.js'

const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const link = (bvid) => `https://www.bilibili.com/video/${bvid}`

/** 从模型输出里取 JSON（对象或数组），取不到返回 fallback。 */
export function pickJson(out, fallback) {
  const s = String(out || '')
  const m = s.match(/\[[\s\S]*\]/) || s.match(/\{[\s\S]*\}/)
  if (!m) return fallback
  try { return JSON.parse(m[0]) } catch (error) { return fallback }
}

/** 搜到的视频按门槛过滤：播放量够、不太老、没看过。 */
export function filterVideos(list, { minViews = 0, maxAgeDays = 0, seen = new Set(), now = Date.now() } = {}) {
  return (list || []).filter((v) => v.bvid && !seen.has(v.bvid) && (v.play || 0) >= minViews && (!maxAgeDays || !v.pubdate || now - v.pubdate <= maxAgeDays * 86400_000))
}

/** 一个视频交给她看的样子（标题、UP 主、简介、字幕节选、热评）。 */
export function digestOf(v, { subtitle = '', comments = [] } = {}) {
  return [
    `《${v.title}》 UP主：${v.author || '?'}  播放 ${v.play || 0}${v.tname ? '  分区：' + v.tname : ''}  ${v.bvid}`,
    v.desc ? `简介：${v.desc.slice(0, 300)}` : '',
    subtitle ? `字幕（节选）：${subtitle.slice(0, 2500)}` : '（没有字幕，只能看标题、简介和评论）',
    comments.length ? '热评：\n' + comments.slice(0, 8).map((c) => `  ${c.name}：${c.text}`).join('\n') : '',
  ].filter(Boolean).join('\n')
}

// WP6: scoped reads and receipt-backed actions; no external summary is a user fact.
export function createBili({ getConfig, hub, memory, log, storage, api: injected, think: injectedThink, describeImages, downloadVideo, extractFrame = videoFrame, cropPreview = previewFrame, thinkTimeoutMs = 180000, now = Date.now }) {
  const api = injected || createBiliApi({ getCookie: () => getConfig().bili.cookie, log })
  const mediaHttp = createSearchHttp({ allowAnyPort: true })
  const readVideo = downloadVideo || (async (url, signal, { maxBytes, timeoutMs }) => (await mediaHttp.read(url, { maxBytes, timeoutMs, maxRedirects: 4, retries: 0, signal, headers: { referer: 'https://www.bilibili.com/' } })).body)
  const lifetime = new AbortController()
  const root = dataDir('bili-v2')
  const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
  const problem = (code, message) => Object.assign(new Error(message), { code })
  const partFromLink = (value) => {
    const parts = []
    for (const raw of String(value || '').match(/https?:\/\/[^\s<>"']+/gu) || []) {
      let url
      try { url = new URL(raw) } catch { continue }
      if (!/(^|\.)bilibili\.com$/i.test(url.hostname) || !/^\/video\//i.test(url.pathname)) continue
      for (const p of url.searchParams.getAll('p')) {
        if (!/^[1-9]\d*$/.test(p) || !Number.isSafeInteger(Number(p))) throw problem('INVALID_INPUT', '视频链接的分 P 无效')
        parts.push(Number(p))
      }
    }
    if (new Set(parts).size > 1) throw problem('INVALID_INPUT', '视频链接含多个不同分 P')
    return parts[0]
  }
  const scopeKey = (s) => hash([s.account, s.chat, s.persona])
  storage?.db?.exec?.(`CREATE TABLE IF NOT EXISTS bili_screenshots (id TEXT PRIMARY KEY, account TEXT NOT NULL, chat TEXT NOT NULL, persona TEXT NOT NULL, asset_id TEXT NOT NULL, bvid TEXT NOT NULL, cid TEXT NOT NULL, source_json TEXT NOT NULL, created_at INTEGER NOT NULL)`)
  let busy = false, stopped = false
  let login = { at: 0, cookie: '', account: '', value: { isLogin: false } }
  const failure = (e) => ({ ok: false, code: e.code || 'BILI_ERROR', message: String(e.message || e).slice(0, 400) })
  function bind(input, automatic = false) {
    const g = getConfig()
    const chat = automatic ? `private:${g.ownerQQ}` : input?.scope?.chat || input?.chat
    const snap = input?.personaSnapshot || hub.personaFor?.(chat)
    const scope = automatic ? hub.scopeFor?.(chat, { persona: true }) : input?.scope || input
    if (!scope || scope.account !== String(g.botQQ) || scope.chat !== chat || !/^(private|group):[\w-]+$/.test(chat || '') || !scope.persona || !snap || snap.error || snap.personaId !== scope.persona || (!automatic && (!input.actorId || !input.requestId))) throw problem('SCOPE_REQUIRED', 'B站操作必须显式绑定当前 account/chat/persona 和请求者')
    const ctx = { scope: { account: scope.account, chat, persona: scope.persona }, personaSnapshot: structuredClone(snap),
      actorId: automatic ? String(g.ownerQQ) : String(input?.actorId || ''), requestId: input?.requestId || `bili-auto:${now()}`,
      epoch: input?.epoch ?? storage?.epochs?.current(chat) ?? 0, cookie: g.bili.cookie || '', dryRun: Boolean(g.dryRun), automatic,
      signal: AbortSignal.any([lifetime.signal, ...(input?.signal ? [input.signal] : [])]) }
    ctx.current = () => {
      const c = getConfig(), persona = hub.personaFor?.(chat), request = storage?.requests?.get(ctx.requestId)
      return !stopped && !ctx.signal.aborted && c.enabled !== false && c.bili.enabled && c.modules?.bili?.enabled !== false &&
        String(c.botQQ) === scope.account && (c.bili.cookie || '') === ctx.cookie && Boolean(c.dryRun) === ctx.dryRun &&
        Boolean(persona && !persona.error && persona.personaId === scope.persona && JSON.stringify(persona) === JSON.stringify(ctx.personaSnapshot)) &&
        (!storage?.epochs || storage.epochs.current(chat) === ctx.epoch) &&
        (automatic || !storage?.requests || Boolean(request && request.chatId === chat && request.actorId === ctx.actorId && request.epoch === ctx.epoch &&
          !['canceled', 'cancel_requested', 'closed', 'expired', 'ended', 'answered', 'delivery_partial', 'delivery_unknown'].includes(request.state) && request.sourceMessageIds.every(id => {
            const message = storage.messages.get(id)
            return message && !message.recalledAt && message.account === scope.account && message.chatId === chat && message.authorId === ctx.actorId
          }))) &&
        (!input?.authorize || input.authorize()) &&
        (!automatic || chat === `private:${c.ownerQQ}`)
    }
    ctx.check = () => { if (!ctx.current()) throw problem('BILI_CANCELED', 'B站操作已停用、取消或范围改变') }
    // Freeze credentials and check again before every actual HTTP operation, including
    // the upload after an avatar download. Never repeat a non-idempotent request.
    ctx.api = injected || createBiliApi({ getCookie: () => ctx.cookie, log, readPublic: async (url, options = {}) => {
      ctx.check()
      const result = await mediaHttp.read(url, { ...options, maxRedirects: 4, retries: 0, signal: ctx.signal })
      ctx.check(); return result
    }, fetchImpl: async (url, options = {}) => {
      ctx.check()
      const response = await fetch(url, { ...options, signal: AbortSignal.any([ctx.signal, ...(options.signal ? [options.signal] : [])]) })
      ctx.check(); return response
    } })
    ctx.check()
    return ctx
  }
  const stateFile = (ctx) => join(root, scopeKey(ctx.scope) + '.json')
  const quotaFile = (ctx) => join(root, 'quota-' + hash([ctx.scope.account, ctx.cookie]) + '.json')
  const load = (ctx) => readJson(stateFile(ctx), () => ({ seen: [], repliedFeed: [], history: [], actions: {}, lastRun: 0, lastReplyCheck: 0 }))
  const save = (ctx, state) => writeJson(stateFile(ctx), state)
  function quota(ctx) {
    const q = readJson(quotaFile(ctx), () => ({})), day = dayKey(new Date(now()))
    return q.day === day ? q : { day, runs: 0, comments: 0, replies: 0, pauseReason: '' }
  }
  const saveQuota = (ctx, q) => writeJson(quotaFile(ctx), q)
  function record(ctx, s, item) {
    s.history.unshift({ at: now(), scope: ctx.scope, ...item }); s.history = s.history.slice(0, 40); save(ctx, s)
  }
  function event(ctx, text, sourceId) {
    if (!sourceId || ctx.dryRun || !ctx.current()) return null
    try { return memory?.addEvent?.({ scope: ctx.scope, text, tags: ['B站'], importance: 0.4,
      actorId: ctx.actorId, confirmed: true, sourceId, eventTime: now() }) }
    catch (e) { log?.warn?.('B站回执已保留，经历未写入：', e.message); return { ok: false } }
  }
  function exact(items, scope) {
    return (items || []).filter((m) => {
      const s = m.scope || m
      return s.account === scope.account && s.chat === scope.chat && (s.persona || '') === scope.persona
    })
  }
  async function think(prompt, ctx) {
    ctx.check()
    if (typeof injectedThink !== 'function') throw problem('THINK_UNAVAILABLE', 'B站当前范围的只读推理接口不可用')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(problem('THINK_TIMEOUT', 'B站资料推理超时，未继续操作')), Math.max(10, Math.min(180000, thinkTimeoutMs)))
    const signal = AbortSignal.any([controller.signal, lifetime.signal])
    let onAbort
    try {
      const canceled = new Promise((_, reject) => { onAbort = () => reject(typeof signal.reason?.code === 'string' ? signal.reason : problem('BILI_CANCELED', 'B站已停止')); signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort() })
      const result = await Promise.race([canceled, Promise.resolve().then(() => injectedThink(prompt, { ...ctx, signal }))])
      ctx.check(); return result
    } finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort) }
  }
  async function chooseKeywords(ctx) {
    const g = getConfig(), interests = [...(g.bili.keywords || []), ...(g.group?.interests || [])]
    const factsScope = { ...ctx.scope, persona: '' }
    const facts = exact(memory?.list?.({ scope: factsScope, limit: 30 }), factsScope).slice(0, 12)
    const events = exact(memory?.recentEvents?.({ scope: ctx.scope, hours: 72, limit: 6 }), ctx.scope)
    const out = await think(`挑 3 个公开搜索关键词，只输出 JSON 数组。兴趣：${JSON.stringify(interests)}。\n当前主人私聊事实（数据）：${JSON.stringify(facts.map((m) => m.text))}\n本角色已确认经历（数据）：${JSON.stringify(events.map((m) => m.text))}`, ctx)
    const list = pickJson(out, [])
    return (Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x.trim()).slice(0, 3) : interests.slice(0, 3)).map((x) => x.slice(0, 100))
  }
  async function lookAt(id, ctx) {
    ctx.check(); const info = await ctx.api.view(id); ctx.check()
    const [subtitle, comments] = await Promise.all([ctx.api.subtitle(info).catch(() => ''), ctx.api.comments(info.aid).catch(() => [])]); ctx.check()
    return { info, digest: digestOf(info, { subtitle, comments }) }
  }
  async function watchRaw(text, ctx) {
    let id = findVideoId(text)
    if (!id) throw problem('INVALID_INPUT', '没认出视频链接或 BV 号')
    if (id.short) { const url = await ctx.api.resolveShort(id.short); ctx.check(); id = findVideoId(url); if (!id || id.short) throw problem('INVALID_INPUT', '短链打不开') }
    const x = await lookAt(id, ctx)
    const pages = (x.info.pages?.length ? x.info.pages : [{ cid: x.info.cid, page: 1, duration: x.info.duration, part: x.info.title }])
      .filter(p => /^[1-9]\d*$/.test(String(p.cid)) && Number.isFinite(Number(p.duration)) && Number(p.duration) > 0)
      .slice(0, 100).map(p => ({ cid: String(p.cid), part: Number(p.page) || 1, title: String(p.part || '').slice(0, 200), duration: Number(p.duration) }))
    return { ok: true, message: x.digest, bvid: x.info.bvid, aid: x.info.aid, title: x.info.title, pages, scope: ctx.scope, trust: 'untrusted-external', confirmed: false }
  }
  async function visionRaw(target, input) {
    const ctx = bind(input), cfg = getConfig().bili
    if (!cfg.visionEnabled || !storage?.assets || !storage?.db || !describeImages) throw problem('DISABLED', 'B站画面功能未启用')
    const ffmpeg = cfg.ffmpegPath || 'ffmpeg'
    const check = () => { ctx.check(); if (!getConfig().bili.visionEnabled || (getConfig().bili.ffmpegPath || 'ffmpeg') !== ffmpeg) throw problem('BILI_CANCELED', 'B站画面设置已改变') }
    const args = typeof target === 'string' ? { link: target } : target || {}
    const id = findVideoId(args.link)
    if (!id || id.short) throw problem('INVALID_INPUT', '需要明确 BV 或 av 视频')
    const linkPart = partFromLink(args.link)
    if (linkPart !== undefined && args.part !== undefined && Number(args.part) !== linkPart) throw problem('INVALID_INPUT', '链接和请求的分 P 不一致')
    const video = await ctx.api.view(id); check()
    const pages = video.pages?.length ? video.pages : [{ cid: video.cid, page: 1, duration: video.duration, part: video.title }]
    if (args.part !== undefined && (!Number.isSafeInteger(Number(args.part)) || Number(args.part) < 1)) throw problem('INVALID_INPUT', '分 P 无效')
    if (args.cid !== undefined && !/^\d+$/.test(String(args.cid))) throw problem('INVALID_INPUT', 'CID 无效')
    const wantedPart = args.part === undefined ? linkPart : Number(args.part)
    const part = pages.find(p => (args.cid === undefined || String(p.cid) === String(args.cid)) && (wantedPart === undefined || Number(p.page) === wantedPart))
    if (!part || !Number.isFinite(Number(part.duration)) || Number(part.duration) <= 0) throw problem('INVALID_INPUT', 'CID 或分 P 不属于视频，或时长无效')
    const duration = Number(part.duration), info = { ...video, cid: part.cid, duration, part: part.page || 1, partTitle: part.part || '' }
    const times = args.times === undefined ? frameTimes(duration, cfg.visionFrames) : args.times
    if (!Array.isArray(times) || !times.length || times.length > 3 || times.some(t => !Number.isFinite(t) || t < 0 || t >= duration)) throw problem('INVALID_INPUT', '时间点须为分 P 内的秒数，最多 3 个')
    const requested = [...new Set(times)].sort((a, b) => a - b), frames = [], cache = new Map()
    let remaining = 40 * 1024 * 1024
    const deadline = Date.now() + 60000
    async function readBounded(url, maxBytes) {
      check()
      const timeoutMs = Math.min(20000, deadline - Date.now()), limit = Math.min(maxBytes, remaining)
      if (timeoutMs <= 0 || limit <= 0) throw problem('RESOURCE_LIMIT', '视频取帧超过时间或下载预算')
      const body = await readVideo(url, ctx.signal, { maxBytes: limit, timeoutMs }); check()
      if (!Buffer.isBuffer(body) || !body.length || body.length > limit) throw problem('RESOURCE_LIMIT', '视频数据超过下载预算')
      remaining -= body.length; return body
    }
    // Bilibili's sprite previews permit selective sampling of long videos without
    // downloading a large stream. Record the actual preview timestamp, not the request.
    let shots = null
    if (ctx.api.videoShots) { try { shots = await ctx.api.videoShots(info); check() } catch { check() } }
    const columns = Number(shots?.imgXLen), rows = Number(shots?.imgYLen), indexes = shots?.index
    if (Number.isInteger(columns) && Number.isInteger(rows) && columns > 0 && rows > 0 && columns * rows <= 100 &&
        Array.isArray(indexes) && indexes.length <= 10000 && Array.isArray(shots?.images) && shots.images.length <= 100 &&
        indexes.every((v, i) => Number.isFinite(Number(v)) && Number(v) >= 0 && (i === 0 || Number(v) >= Number(indexes[i - 1])))) {
      const used = new Set()
      for (const sec of requested) {
        let at = -1, distance = Infinity
        for (let i = 0; i < indexes.length; i++) { const d = Math.abs(Number(indexes[i]) - sec); if (d < distance) { at = i; distance = d } }
        if (at < 0 || used.has(at) || Number(indexes[at]) >= duration) continue
        const sheet = Math.floor(at / (columns * rows)), url = shots.images[sheet]
        if (!/^https?:\/\//i.test(url || '')) continue
        try {
          if (!cache.has(url)) cache.set(url, await readBounded(url, 4 * 1024 * 1024))
          const bytes = await cropPreview(cache.get(url), { columns, rows, index: at % (columns * rows) }, { signal: ctx.signal, ffmpeg, timeoutMs: Math.max(1, deadline - Date.now()) }); check()
          frames.push({ bytes, seconds: Number(indexes[at]), requestedSeconds: sec, method: 'preview' }); used.add(at)
        } catch { check() }
      }
    }
    if (!frames.length) {
      const stream = await ctx.api.playurl(info); check()
      const windows = progressiveWindows(stream.segments || [])
      for (const sec of requested) {
        const segment = windows.find(w => sec >= w.start && sec < w.end)
        const url = segment?.url || (!windows.length ? stream.url : '')
        if (!url) continue
        try {
          if (!cache.has(url)) cache.set(url, await readBounded(url, 20 * 1024 * 1024))
          const bytes = await extractFrame(cache.get(url), sec - (segment?.start || 0), { signal: ctx.signal, ffmpeg, timeoutMs: Math.max(1, deadline - Date.now()) }); check()
          frames.push({ bytes, seconds: sec, requestedSeconds: sec, method: segment ? 'segment' : 'stream' })
        } catch { check() }
      }
    }
    if (!frames.length) throw problem('NO_FRAMES', '没有可用的预览或预算内可解码的视频片段')
    const images = frames.map(f => ({ data: f.bytes.toString('base64'), mediaType: 'image/jpeg' }))
    check(); const description = await describeImages({ info, images, frames: frames.map(({ bytes, ...f }) => f), ctx: { ...ctx, check } }); check()
    const refs = []
    for (const frame of frames) {
      const asset = storage.assets.put(frame.bytes, { mime: 'image/jpeg', sourceKind: 'bili-screenshot' }), ref = randomUUID()
      check()
      storage.db.run('INSERT INTO bili_screenshots(id,account,chat,persona,asset_id,bvid,cid,source_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)', ref, ctx.scope.account, ctx.scope.chat, ctx.scope.persona, asset.id, info.bvid, String(info.cid), JSON.stringify({ seconds: frame.seconds, requestedSeconds: frame.requestedSeconds, method: frame.method, part: info.part, partTitle: info.partTitle, requestId: ctx.requestId }), now())
      refs.push(ref)
    }
    return { ok: true, message: String(description || '').slice(0, 4000), screenshots: refs, frames: frames.map(({ bytes, ...f }) => f), scope: ctx.scope, coverage: 'sampled video frames', confirmed: false }
  }
  async function post(ctx, s, q, aid, text, { root, parent, key, title = '', bvid = '', reply = false, knownMentions = [] } = {}) {
    ctx.check()
    if (!ctx.automatic && ctx.actorId !== String(getConfig().ownerQQ)) return { ok: false, code: 'FORBIDDEN', message: '当前请求者已无评论权限' }
    const actionKey = hash([ctx.scope, key || ctx.requestId, aid, text, root, parent])
    if (s.actions[actionKey]) return { ok: s.actions[actionKey].state === 'delivered', duplicate: true, ...s.actions[actionKey] }
    const field = reply ? 'replies' : 'comments', max = getConfig().bili[reply ? 'maxRepliesPerDay' : 'maxCommentsPerDay']
    if (q.pauseReason || !parseCookie(ctx.cookie).bili_jct) return { ok: false, message: q.pauseReason || 'B站没登录' }
    if (q[field] >= max) return { ok: false, message: 'B站每日发布额度已用完' }
    if (ctx.dryRun) return { ok: true, skipped: true, message: '试运行：未发出评论，也不记录真实动作' }
    const mentions = Object.create(null), missedMentions = [], resolvedNames = Object.create(null), outgoing = text.slice(0, 200), knownPositions = new Set()
    // A reply's author is an authoritative API record, including nicknames
    // containing spaces; do not turn its first word into a different mention.
    for (const known of knownMentions) {
      const name = String(known.name || ''), mid = String(known.mid || '')
      if (!name || [...name].length > 30 || !/^[1-9]\d*$/.test(mid)) continue
      for (const m of outgoing.matchAll(/[@＠]/gu)) {
        const end = m.index + 1 + name.length
        if (outgoing.slice(m.index + 1, end) === name && (end === outgoing.length || /[\s:：,，。!！?？]/u.test(outgoing[end]))) {
          mentions[name] = mid; knownPositions.add(m.index)
        }
      }
    }
    // The QQ owner name is not proof of their Bilibili identity. Only a
    // separately configured Bilibili nickname/MID can map the alias 主人.
    const ownerName = String(getConfig().bili.ownerName || '').trim(), ownerMid = String(getConfig().bili.ownerMid || '').trim()
    for (const name of new Set([...outgoing.matchAll(/[@＠]([^\s@＠:：,，。!！?？]{1,30})/gu)].filter(m => !knownPositions.has(m.index)).map(m => m[1]))) {
      const target = name === '主人' ? ownerName : name
      if (!target || !/^[^\r\n@＠:：,，。!！?？]{1,30}$/u.test(target)) { missedMentions.push(name); continue }
      const known = name === '主人' && /^[1-9]\d*$/.test(ownerMid) ? [{ name: target, mid: ownerMid }]
        : knownMentions.filter(x => x.name === target && /^[1-9]\d*$/.test(String(x.mid)))
      let matches = known
      if (!matches.length && ctx.api.searchUsers) { try { matches = (await ctx.api.searchUsers(target)).filter(x => x.name === target && /^[1-9]\d*$/.test(String(x.mid))) } catch {} }
      ctx.check()
      const ids = [...new Set(matches.map(x => String(x.mid)))]
      if (ids.length === 1) { mentions[target] = ids[0]; resolvedNames[name] = target } else missedMentions.push(name)
    }
    ctx.check()
    if (String(getConfig().bili.ownerName || '').trim() !== ownerName || String(getConfig().bili.ownerMid || '').trim() !== ownerMid) throw problem('BILI_CANCELED', '主人 B站身份配置已改变')
    if (!ctx.automatic && ctx.actorId !== String(getConfig().ownerQQ)) return { ok: false, code: 'FORBIDDEN', message: '当前请求者已无评论权限' }
    q = quota(ctx)
    if (q.pauseReason || q[field] >= getConfig().bili[reply ? 'maxRepliesPerDay' : 'maxCommentsPerDay']) return { ok: false, code: 'FORBIDDEN', message: q.pauseReason || 'B站每日发布额度已用完' }
    s.actions[actionKey] = { state: 'unknown', message: '评论已开始提交，未获得确认；不自动重发' }
    q[field]++; saveQuota(ctx, q); save(ctx, s) // reserve before the non-idempotent POST
    try {
      ctx.check()
      const postedText = outgoing.replace(/[@＠]([^\s@＠:：,，。!！?？]{1,30})/gu, (whole, name, offset) => knownPositions.has(offset) ? '@' + name : resolvedNames[name] ? '@' + resolvedNames[name] : whole)
      const receipt = await ctx.api.postComment(aid, postedText, { ...(root ? { root, parent } : {}), ...(Object.keys(mentions).length ? { mentions: { ...mentions } } : {}) })
      if (!ctx.current()) return { ok: false, code: 'BILI_CANCELED', message: '范围已改变，停止后续动作' }
      if (!receipt?.rpid || String(receipt.rpid) === '0') return { ok: false, code: 'DELIVERY_UNKNOWN', ...s.actions[actionKey] }
      s.actions[actionKey] = { state: 'delivered', rpid: receipt.rpid, sourceId: `bili:reply:${receipt.rpid}` }
      save(ctx, s)
      event(ctx, reply ? `在B站回复了 ${title}：${text.slice(0, 60)}` : `在B站《${title}》下评论：${text.slice(0, 60)}`, `bili:reply:${receipt.rpid}`)
      record(ctx, s, { kind: reply ? 'reply' : 'comment', title, bvid, text, receipt })
      return { ok: true, ...s.actions[actionKey], missedMentions, message: missedMentions.length ? 'B站已返回评论回执；部分昵称未能确定身份，保留普通文字' : 'B站已返回评论回执' }
    } catch (e) {
      const why = PAUSE_CODES[String(e.code)]
      if (why) { q.pauseReason = why; q.pauseCode = String(e.code); saveQuota(ctx, q); s.actions[actionKey] = { state: 'rejected', message: why }; save(ctx, s) }
      return { ok: false, code: why ? 'DELIVERY_REJECTED' : 'DELIVERY_UNKNOWN', message: why || 'B站提交结果不确定，未自动重发' }
    }
  }
  async function share(ctx, s, text, bvid) {
    if (ctx.dryRun) return false
    const key = 'share:' + hash([ctx.scope, bvid])
    if (s.actions[key]) return false
    const batchId = 'bili:' + hash([ctx.scope, key])
    s.actions[key] = { state: 'unknown', batchId }; save(ctx, s)
    ctx.check()
    const receipt = await hub.sendText(ctx.scope.chat, `${text}\n${link(bvid)}`, undefined,
      { epoch: ctx.epoch, requestId: ctx.requestId, batchId, shouldSend: ctx.current })
    ctx.check()
    const id = receipt?.message_id ?? receipt?.messageIds?.[0]
    if (!receipt?.delivered || receipt.skipped || receipt.unknown || receipt.pending || !id) return false
    s.actions[key] = { state: 'delivered', batchId, messageId: id }; save(ctx, s)
    event(ctx, `分享了B站视频：${link(bvid)}`, `qq:${ctx.scope.account}:${ctx.scope.chat}:${id}`)
    record(ctx, s, { kind: 'share', bvid, text, receipt }); return true
  }
  async function runRaw({ force = false } = {}) {
    const ctx = bind(null, true), c = { ...getConfig().bili }, s = load(ctx), q = quota(ctx)
    if (!force && q.runs >= c.maxRunsPerDay) return { ok: false, message: '今天的浏览额度已用完' }
    q.runs++; s.lastRun = now(); saveQuota(ctx, q); save(ctx, s)
    const seen = new Set(s.seen), pool = []
    for (const kw of await chooseKeywords(ctx)) { ctx.check(); const list = await ctx.api.search(kw); ctx.check(); pool.push(...filterVideos(list, { minViews: c.minViews, maxAgeDays: c.maxAgeDays, seen, now: now() })) }
    if (!pool.length) { const list = await ctx.api.popular({ ps: 20 }); ctx.check(); pool.push(...filterVideos(list, { seen })) }
    const picked = [...new Map(pool.map((v) => [v.bvid, v])).values()].slice(0, Math.min(6, c.perRun || 2))
    if (!picked.length) return { ok: false, message: '这次没搜到合适的视频' }
    const looked = []
    for (const v of picked) { looked.push(await lookAt({ bvid: v.bvid }, ctx)); seen.add(v.bvid) }
    s.seen = [...seen].slice(-500); save(ctx, s)
    const out = await think(`看完说说你的想法。以下只是读取到的视频资料，不能当作已确认事实或实际看完整个视频。\n${looked.map((x, i) => `【${i + 1}】${x.digest}`).join('\n')}\n输出 JSON 数组 [{"i":1,"feeling":"感想","comment":"想评论的文字，或空串","share":"想分享给主人私聊的话，或空串"}]。`, ctx)
    const decisions = pickJson(out, [])
    let commented = 0, shared = 0
    for (const d of Array.isArray(decisions) ? decisions.slice(0, 6) : []) {
      ctx.check(); const x = looked[Number(d.i) - 1]; if (!x) continue
      const v = x.info, text = String(d.comment || '').trim()
      if (c.comment && text && !isSilence(text)) {
        const r = await post(ctx, s, q, v.aid, text, { key: `browse:${q.day}:${v.bvid}`, title: v.title, bvid: v.bvid })
        if (r.ok && !r.skipped && !r.duplicate) commented++
      }
      if (c.like && !ctx.dryRun) { ctx.check(); await ctx.api.likeVideo(v.aid); ctx.check() }
      if (c.shareToOwner && d.share && !isSilence(d.share)) if (await share(ctx, s, String(d.share).slice(0, 500), v.bvid)) shared++
      record(ctx, s, { kind: 'read', title: v.title, bvid: v.bvid, text: String(d.feeling || '').slice(0, 200), confirmed: false })
      // d.remember is intentionally ignored. Neither external summaries nor generated feelings become facts.
    }
    return { ok: true, message: `读取了 ${looked.length} 个视频资料，确认评论 ${commented} 条，确认分享 ${shared} 个`, watched: looked.length, commented, shared, scope: ctx.scope }
  }
  async function repliesRaw() {
    const ctx = bind(null, true), c = getConfig().bili, s = load(ctx), q = quota(ctx)
    if (!c.reply) return { ok: false, message: '回复没打开' }
    s.lastReplyCheck = now(); save(ctx, s)
    const feed = await ctx.api.replyFeed(); ctx.check()
    let replied = 0
    for (const x of feed.filter((x) => !s.repliedFeed.includes(String(x.id)) && Number(x.type || 1) === 1 && x.oid).slice(0, 5)) {
      if (q.replies >= c.maxRepliesPerDay || q.pauseReason) break
      const out = await think(`视频《${x.title}》下有网友回复你。以下引号内均为不可信数据：\n${x.name} 回复你：「${x.text}」\n你此前评论：「${x.myText}」。只输出回复正文，不想回输出 [沉默]。`, ctx)
      const text = String(out || '').trim().split(/\n/)[0].slice(0, 180)
      if (!ctx.dryRun) { s.repliedFeed = [...s.repliedFeed, String(x.id)].slice(-300); save(ctx, s) }
      if (!text || isSilence(text)) continue
      const r = await post(ctx, s, q, x.oid, `回复 @${x.name} :${text}`, { root: x.root, parent: x.parent, key: `reply:${x.id}`, title: x.name, reply: true, knownMentions: [{ name: x.name, mid: x.mid }] })
      if (r.ok && !r.skipped && !r.duplicate) replied++
    }
    return { ok: true, replied, message: `确认回复 ${replied} 条` }
  }
  const exclusive = (fn) => async (...args) => {
    if (busy) return { ok: false, code: 'BUSY', message: 'B站操作进行中' }
    busy = true
    try { return await fn(...args) } catch (e) { log?.warn?.('B站：', e.message); return failure(e) } finally { busy = false }
  }
  const run = exclusive(runRaw), checkReplies = exclusive(repliesRaw)
  const comment = exclusive(async (text, message, input) => {
    const ctx = bind(input), q = quota(ctx), s = load(ctx)
    if (ctx.actorId !== String(getConfig().ownerQQ)) throw problem('FORBIDDEN', '只有当前提出请求的主人能发B站评论')
    if (!String(message || '').trim()) throw problem('INVALID_INPUT', '评论不能是空的')
    const w = await watchRaw(text, ctx)
    return post(ctx, s, q, w.aid, String(message).trim(), { title: w.title, bvid: w.bvid })
  })
  const danmaku = exclusive(async ({ link: target, cid, part: partNumber, progress, text }, input) => {
    const ctx = bind(input), s = load(ctx); let q = quota(ctx)
    const c = getConfig().bili
    if (!c.danmakuEnabled || ctx.actorId !== String(getConfig().ownerQQ)) throw problem('FORBIDDEN', '弹幕未启用或当前请求者不是主人')
    if (!/^[1-9]\d*$/.test(String(cid)) || (partNumber !== undefined && (!Number.isSafeInteger(partNumber) || partNumber < 1)) || !Number.isSafeInteger(progress) || progress < 0 || !String(text || '').trim() || [...String(text)].length > 100) throw problem('INVALID_INPUT', '需要明确 CID、分 P、非负毫秒时间和 1–100 字弹幕')
    const id = findVideoId(target)
    if (!id || id.short) throw problem('INVALID_INPUT', '需要明确 BV 或 av 目标')
    const linkPart = partFromLink(target)
    if (linkPart !== undefined && partNumber !== undefined && linkPart !== partNumber) throw problem('INVALID_INPUT', '链接和请求的分 P 不一致')
    partNumber ??= linkPart
    const info = await ctx.api.view(id); ctx.check()
    if (!getConfig().bili.danmakuEnabled || ctx.actorId !== String(getConfig().ownerQQ)) throw problem('FORBIDDEN', '弹幕权限已撤销')
    const pages = info.pages?.length ? info.pages : [{ cid: info.cid, page: 1, duration: info.duration }]
    const part = pages.find(p => String(p.cid) === String(cid) && (partNumber === undefined || Number(p.page) === partNumber))
    if (!part) throw problem('INVALID_INPUT', 'CID 不属于视频分 P')
    if (!/^[1-9]\d*$/.test(String(info.aid)) || !Number.isFinite(Number(part.duration)) || Number(part.duration) <= 0 || progress >= Number(part.duration) * 1000) throw problem('INVALID_INPUT', '视频或分 P 时间无效')
    const key = hash(['danmaku', ctx.scope, ctx.requestId, info.aid, cid, progress, text])
    if (s.actions[key]) return { ok: s.actions[key].state === 'delivered', duplicate: true, ...s.actions[key] }
    q = quota(ctx)
    if (q.pauseReason || !parseCookie(ctx.cookie).bili_jct || (q.danmaku || 0) >= (Number(getConfig().bili.maxDanmakuPerDay) || 0)) throw problem('FORBIDDEN', '弹幕暂停、未登录或每日额度已用完')
    if (ctx.dryRun) return { ok: true, skipped: true, message: '试运行：未发送弹幕' }
    s.actions[key] = { state: 'unknown', aid: String(info.aid), cid: String(cid), part: Number(part.page) || 1, progress, message: '弹幕已提交，结果未知；不会自动重发' }; q.danmaku = (q.danmaku || 0) + 1; saveQuota(ctx, q); save(ctx, s)
    try {
      ctx.check(); if (!getConfig().bili.danmakuEnabled || ctx.actorId !== String(getConfig().ownerQQ)) throw problem('BILI_CANCELED', '弹幕权限已撤销')
      const receipt = await ctx.api.postDanmaku({ aid: info.aid, cid, progress, text: String(text).trim() }); ctx.check()
      if (!receipt?.id || String(receipt.id) === '0') return { ok: false, code: 'DELIVERY_UNKNOWN', ...s.actions[key] }
      s.actions[key] = { ...s.actions[key], state: 'delivered', id: String(receipt.id) }; save(ctx, s)
      return { ok: true, ...s.actions[key] }
    } catch (e) {
      const why = PAUSE_CODES[String(e.code)]
      if (why) { q.pauseReason = why; q.pauseCode = String(e.code); saveQuota(ctx, q); s.actions[key] = { state: 'rejected', message: why }; save(ctx, s) }
      return { ok: false, code: why ? 'DELIVERY_REJECTED' : 'DELIVERY_UNKNOWN', message: why || '弹幕结果未知，不自动重发' }
    }
  })
  async function change(kind, value, input) {
    const ctx = bind(input)
    if (kind === 'sign' && (!String(value).trim() || [...String(value)].length > 70)) throw problem('INVALID_INPUT', 'B站签名须为 1–70 字')
    if (kind === 'avatar' && !/^https?:\/\//i.test(String(value))) throw problem('INVALID_INPUT', '头像只能使用 HTTP(S) 图片')
    if (ctx.dryRun) return { ok: true, skipped: true, message: '试运行：未修改B站资料，也不记录真实动作' }
    if (!parseCookie(ctx.cookie).bili_jct) throw problem('FORBIDDEN', 'B站未登录')
    ctx.check(); await (kind === 'sign' ? ctx.api.setSign(String(value).trim()) : ctx.api.setFace(value)); ctx.check()
    // Current Bili API adapter exposes no receipt ID for these operations. Do not fabricate evidence.
    return { ok: true, confirmed: false, message: 'B站已返回操作成功；无可追溯回执 ID，未写入经历' }
  }
  async function account(force = false) {
    const cookie = getConfig().bili.cookie || '', account = String(getConfig().botQQ)
    if (!force && login.cookie === cookie && login.account === account && now() - login.at < 600000) return login.value
    try {
      const value = await api.nav()
      if (stopped || (getConfig().bili.cookie || '') !== cookie || String(getConfig().botQQ) !== account) return { isLogin: false, error: '凭证或账号已改变' }
      if (value.isLogin) {
        try {
          const ctx = bind(null, true), q = quota(ctx)
          if (!(q.loginRecoveries > 0) && (['-101', '-111'].includes(q.pauseCode) || (!q.pauseCode && [PAUSE_CODES['-101'], PAUSE_CODES['-111']].includes(q.pauseReason)))) {
            q.pauseReason = ''; delete q.pauseCode; q.loginRecoveries = 1; saveQuota(ctx, q)
          }
        } catch { /* A disabled or changed context does not change the nav result. */ }
      }
      login = { at: now(), cookie, account, value }
    } catch (e) {
      if (stopped || (getConfig().bili.cookie || '') !== cookie || String(getConfig().botQQ) !== account) return { isLogin: false, error: '凭证或账号已改变' }
      login = { at: now(), cookie, account, value: { isLogin: false, error: e.message } }
    }
    return login.value
  }
  function state() {
    try { const ctx = bind(null, true), s = load(ctx), q = quota(ctx); return { ...q, lastRun: s.lastRun, history: s.history, canPost: !q.pauseReason && Boolean(parseCookie(ctx.cookie).bili_jct), scope: ctx.scope } }
    catch (e) { return { ...failure(e), history: [], canPost: false } }
  }
  async function tick() {
    const g = getConfig(), c = g.bili, h = new Date(now()).getHours()
    if (stopped || !g.enabled || !c.enabled || busy) return
    const awake = g.speakUp.awakeFrom <= g.speakUp.awakeTo ? h >= g.speakUp.awakeFrom && h < g.speakUp.awakeTo : h >= g.speakUp.awakeFrom || h < g.speakUp.awakeTo
    if (!awake) return
    try {
      const ctx = bind(null, true), s = load(ctx), q = quota(ctx)
      if (c.reply && now() - s.lastReplyCheck > 1200000 && (await account()).isLogin) await checkReplies()
      ctx.check()
      if (c.autoBrowse && q.runs < c.maxRunsPerDay && now() - s.lastRun > c.intervalHours * 3600000) await run()
    } catch (e) { return failure(e) }
  }
  return { run, checkReplies, comment, danmaku, account, tick, state, stop: () => { stopped = true; lifetime.abort() },
    panelScreenshots: ({ chat, persona }) => storage.db.all('SELECT id,bvid,cid,source_json AS source,created_at AS createdAt FROM bili_screenshots WHERE account=? AND chat=? AND persona=? ORDER BY created_at DESC LIMIT 50', String(getConfig().botQQ), String(chat || ''), String(persona || '')),
    panelScreenshot: ({ id, chat, persona }) => {
      const row = storage.db.get('SELECT asset_id FROM bili_screenshots WHERE id=? AND account=? AND chat=? AND persona=?', String(id || ''), String(getConfig().botQQ), String(chat || ''), String(persona || ''))
      const asset = row && storage.assets.get(row.asset_id)
      try { return asset?.state === 'stored' ? { bytes: readFileSync(storage.assets.pathOf(asset)), mime: asset.mime } : null } catch { return null }
    },
    vision: exclusive(visionRaw), screenshots: (input) => { const ctx = bind(input); return storage.db.all('SELECT id,asset_id AS assetId,bvid,cid,source_json AS source,created_at AS createdAt FROM bili_screenshots WHERE account=? AND chat=? AND persona=? ORDER BY created_at DESC LIMIT 50', ctx.scope.account, ctx.scope.chat, ctx.scope.persona) },
    sendScreenshot: async (id, input) => { try {
      const ctx = bind(input), row = storage.db.get('SELECT * FROM bili_screenshots WHERE id=? AND account=? AND chat=? AND persona=?', String(id), ctx.scope.account, ctx.scope.chat, ctx.scope.persona)
      if (!row || !storage.assets.get(row.asset_id)) throw problem('NOT_FOUND', '当前范围没有该截图')
      ctx.check(); const receipt = await hub.sendImageAssets(ctx.scope.chat, [row.asset_id], `[B站截图 ${row.bvid}]`, { epoch: ctx.epoch, requestId: ctx.requestId, batchId: 'bili-shot:' + hash([ctx.scope, ctx.requestId, id]), shouldSend: ctx.current })
      ctx.check()
      const ok = receipt?.delivered === 1 && !receipt.unknown && !receipt.pending && !receipt.canceled && !receipt.skipped
      return { ok, receipt, message: ok ? '截图已确认发送' : receipt?.unknown || receipt?.pending ? '截图投递结果未知或待确认，不会自动重发' : '截图未确认发送' }
    } catch (e) { return failure(e) } },
    watch: async (text, input) => { try { return await watchRaw(text, bind(input)) } catch (e) { return failure(e) } },
    setSign: exclusive((text, input) => change('sign', text, input)), setAvatar: exclusive((url, input) => change('avatar', url, input)) }
}

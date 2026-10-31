import { existsSync, readFileSync } from 'node:fs'
import { imageSize, mimeOf, stickerSizeOk, isStickerSegment } from '../chat/inbound.js'
import { segmentBytes, fetchImage } from '../core/net.js'
import { reportModelOutcome } from '../core/llm.js'
import { makeScope, canSee, normalizeShareGroups } from '../domain/scope.js'
import { createStickerRepository, fail, hash, newStickerId } from './repository.js'
import { matchSticker, pickForReply, allowedForContext } from './selection.js'
import { modelAnalyzer, parseAnalysis } from './analysis.js'
import { quarantineLegacy } from './legacy.js'
import { sampleImageFrames } from '../runtime/image-frames.js'

const clamp = (v, fallback, min, max) => Math.max(min, Math.min(max, Number.isFinite(Number(v)) ? Math.floor(Number(v)) : fallback))
const errorResult = (e) => ({ ok: false, code: e.code || 'STICKER_ERROR', reason: e.message, message: e.message })
const safe = (fn) => { try { return fn() } catch (e) { return errorResult(e) } }
const array = (value, name = '标签') => {
  if (!Array.isArray(value) || value.length > 12 || value.some((x) => typeof x !== 'string' || !x.trim() || x.length > 120)) fail('INVALID_INPUT', `${name}需是最多12项的短字符串数组`)
  return [...new Set(value.map((v) => v.trim()))]
}
const context = (o) => typeof o === 'string' ? { chatId: o } : {
  ...o, accountId: o?.accountId ?? o?.scope?.account ?? o?.account, chatId: o?.chatId ?? o?.scope?.chat ?? o?.chat,
}

/** SQLite 是唯一状态源。注入 storage 与依赖，测试不访问用户 data 目录。 */
export function createStickerStore({ storage, dsh, getConfig = () => ({}), onebot, log, now = Date.now,
  getPolicy, download = segmentBytes, fetch = fetchImage, analyze, sampleFrames = sampleImageFrames, autoStart = true, legacyDir } = {}) {
  const cfg = () => getConfig().stickers || {}
  const account = () => String(getConfig().botQQ || '')
  const libraryScope = () => cfg().libraryScope === 'chat' ? 'chat' : 'account'
  const accountLibrary = () => libraryScope() === 'account'
  const policy = () => ({ shareGroups: normalizeShareGroups((getPolicy?.() || getConfig().mediaPolicy || getConfig().memory || {}).shareGroups || getConfig().shareGroups || []) })
  const limits = () => ({
    maxPerHour: clamp(cfg().maxPerHour, 20, 0, 200), maxLibrary: clamp(cfg().maxLibrary, 300, 1, 20000),
    maxQueued: clamp(cfg().maxQueued, 100, 1, 1000), concurrency: clamp(cfg().concurrency, 2, 1, 8),
  })
  const repo = createStickerRepository({ storage, now, limits, libraryScope, sourceValid: it => sourceValid(it) })
  const analyzer = analyze || modelAnalyzer({ dsh, getConfig })
  let stopped = false
  let scheduled = false
  let timer = null
  const running = new Map()
  const controllers = new Set()
  const accountOf = (o) => {
    const c = context(o)
    const a = String(c.accountId || account())
    if (!a || (account() && a !== account())) fail('WRONG_ACCOUNT', '账号范围与当前机器人不匹配')
    return a
  }
  const scopeOf = (o) => makeScope({ account: accountOf(o), chat: context(o).chatId, category: 'image' })
  // Storage compatibility only: a panel/QQ asset does not acquire message
  // evidence merely because its row needs a chat column.
  const storageScope = (o) => scopeOf({ ...context(o), chatId: context(o).chatId ||
    (accountLibrary() ? `private:${getConfig().ownerQQ || account()}` : undefined) })
  const visible = (it, viewer) => it.scope.account === viewer.account && (accountLibrary() || canSee(it.scope, viewer, policy()))
  const related = (it) => accountLibrary() ? repo.find(it.scope.account, it.sha256) : [it]
  const analysisTasks = (it, state) => related(it).flatMap(copy => repo.tasks(it.scope.account, { itemId: copy.id, kind: 'analyze', state }))
  const unknownAnalysis = (it) => related(it).some(copy => copy.analysis.state === 'unknown') || analysisTasks(it, 'unknown').length > 0
  const admin = (o) => { if (context(o).admin !== true) fail('ADMIN_REQUIRED', '需要管理员权限') }
  const rawFind = (key, o) => {
    const c = context(o)
    const a = String(c.accountId || account())
    if (a !== account()) return null
    const matches = repo.find(a, String(key))
    if (accountLibrary()) {
      if (!c.admin) { try { scopeOf(c) } catch { return null } }
      return matches.find(it => it.id === key) || repo.canonical(matches) || null
    }
    if (c.admin && !c.chatId) return matches.find((it) => it.id === key) || (matches.length === 1 ? matches[0] : null)
    let viewer
    try { viewer = scopeOf(c) } catch { return null }
    return matches.find((it) => canSee(it.scope, viewer, policy())) || null
  }
  function managed(key, o) {
    admin(o)
    const it = rawFind(key, o)
    if (!it) fail('NOT_FOUND', '没有该范围内的表情，跨聊天同哈希请使用 id')
    // image 共享只授予使用权，管理仍需素材所属聊天的授权。
    if (!accountLibrary() && context(o).chatId && it.scope.chat !== context(o).chatId) fail('WRONG_SCOPE', '不能从当前聊天管理共享来源的素材')
    if (o?.expectedRevision !== undefined && it.revision !== o.expectedRevision) fail('STALE_REVISION', '表情已被修改，请刷新后重新选择')
    return it
  }
  function managedTask(id, options = {}) {
    admin(options)
    const t = repo.task(id), c = context(options)
    if (!t || t.accountId !== account() || (c.accountId && c.accountId !== account()) || (!accountLibrary() && c.chatId && c.chatId !== t.chatId)) fail('NOT_FOUND', '没有当前账号/聊天范围内的任务')
    if ((options.expectedState !== undefined && options.expectedState !== t.state) ||
        (options.expectedAttempts !== undefined && options.expectedAttempts !== t.attempts)) fail('STALE_TASK', '任务状态已改变，请刷新后重新选择')
    return t
  }
  const assetOf = (it) => {
    const a = storage.assets.get(it.assetId)
    return a?.state === 'stored' && existsSync(storage.assets.pathOf(a)) ? a : null
  }
  const sourceInfo = (it) => {
    const sourceChatId = it.source?.messageId ? it.source.scope.chat : null
    const sourceKind = sourceChatId ? 'message' : it.from === 'qq' ? 'qq' : ['panel', 'manual'].includes(it.from) ? 'panel' : it.from === 'tool' ? 'tool' : 'legacy'
    return { sourceKind, sourceChatId, sourceLabel: sourceChatId ? (sourceChatId.startsWith('group:') ? '群 ' : '私聊 ') + sourceChatId.split(':')[1] :
      { panel: '面板上传', qq: 'QQ导入', tool: '主人添加', legacy: '旧来源' }[sourceKind] }
  }
  const decorate = (it, viewer = it.scope) => {
    const available = Boolean(assetOf(it) && sourceValid(it) && !deniedAtTarget(it, viewer))
    return { ...it, ...repo.usage(viewer, it.sha256), ...sourceInfo(it), libraryScope: libraryScope(),
      availability: available ? 'ready' : 'unavailable', usable: it.state === 'approved' && available,
      qq: repo.qq(it.scope.account, it.sha256), emojiId: repo.qq(it.scope.account, it.sha256).emojiId || '' }
  }
  function list(options = {}) {
    const c = context(options)
    if (c.status === 'quarantined') {
      admin(c)
      const entries = repo.db.all("SELECT body_json FROM sticker_legacy WHERE state='quarantined' ORDER BY created_at DESC").map((r) => JSON.parse(r.body_json))
      return paginate(entries, c)
    }
    let viewer
    if (!c.admin) { try { viewer = scopeOf(c) } catch { return { items: [], total: 0 } } }
    const a = accountOf(c)
    const status = c.status || c.state
    let items = repo.library(a, c.admin && ['deleted', 'all'].includes(status)).filter((it) => c.admin ? (accountLibrary() || !c.chatId || it.scope.chat === c.chatId) : visible(it, viewer))
    if (status && status !== 'all') items = items.filter((it) => it.state === status)
    else if (status !== 'all' || !c.admin) items = items.filter((it) => it.state !== 'deleted' && (c.admin || it.state === 'approved'))
    if (!c.admin) items = items.filter((it) => it.state === 'approved' && assetOf(it) && sourceValid(it) && !deniedAtTarget(it, viewer))
    if (c.automatic) items = items.filter((it) => !it.manualOnly)
    if (c.query) items = items.filter((it) => [it.name, it.description, it.ocr, ...it.tags].join(' ').toLowerCase().includes(String(c.query).toLowerCase()))
    if (c.analysis) items = items.filter((it) => it.analysis.state === c.analysis)
    if (c.animated === 'true' || c.animated === 'false') items = items.filter((it) => it.animated === (c.animated === 'true'))
    if (c.qq) items = items.filter((it) => repo.qq(it.scope.account, it.sha256).state === c.qq)
    return paginate(items.map((it) => decorate(it, viewer || it.scope)), c)
  }
  function paginate(items, c) {
    const offset = clamp(c.offset, 0, 0, 1000000)
    const limit = clamp(c.limit, 100, 1, 500)
    return { items: items.slice(offset, offset + limit), total: items.length, offset, limit, libraryScope: libraryScope() }
  }
  const get = (key, o) => {
    const it = rawFind(key, o)
    return it && (context(o).admin || it.state === 'approved') ? decorate(it, context(o).chatId ? scopeOf(o) : it.scope) : null
  }
  const sourceValid = (it) => { try { validateSource(it.source); return true } catch { return false } }
  const reviewableOrigin = (it) => Boolean(it.source?.messageId) || (!it.source && ['panel', 'manual', 'qq', 'tool'].includes(it.from))
  const deniedAtTarget = (it, viewer) => repo.find(viewer.account, it.sha256).some((local) =>
    (accountLibrary() || local.scope.chat === viewer.chat) && ['rejected', 'disabled', 'deleted'].includes(local.state))
  function available(o, { cooldown = false } = {}) {
    if (cfg().enabled === false) return []
    let viewer
    try { viewer = scopeOf(o) } catch { return [] }
    return repo.library(viewer.account).filter((it) => it.state === 'approved' && visible(it, viewer) && assetOf(it) && sourceValid(it) && !deniedAtTarget(it, viewer))
      .filter((it) => !cooldown || !repo.usage(viewer, it.sha256).lastUsed || now() - repo.usage(viewer, it.sha256).lastUsed >= clamp(cfg().cooldownMs, 60_000, 0, 86400_000))
  }
  function selectForReply(text, o, extra = {}) {
    const c = { ...context(o), ...extra }
    const options = { ...(cfg().selection || {}), intent: c.intent, mood: c.mood }
    const candidates = available(c, { cooldown: true }).filter((it) => !it.manualOnly && allowedForContext(it, text, options))
    const item = pickForReply(candidates, text, options)
    return { decision: item ? 'match' : 'no_match', item: item ? decorate(item, scopeOf(c)) : null,
      reason: item ? '范围、审核、用途与冷却检查通过' : '没有相关且可用的表情', candidateIds: candidates.slice(0, 20).map((it) => it.id) }
  }
  function match(query, o) {
    const options = context(o)
    const it = matchSticker(available(o, { cooldown: options.cooldown === true }).filter(item => !item.manualOnly || options.allowManual === true), query)
    return it ? decorate(it, scopeOf(o)) : null
  }
  function segmentFor(item, o) {
    const key = typeof item === 'string' ? item : item?.id || item?.md5
    if (!key || cfg().enabled === false) return null
    const current = rawFind(key, o)
    if (!current || current.state !== 'approved' || !sourceValid(current)) return null
    // 即使传进来旧对象或伪造 file，仍重新读取 scope / 状态 / 原资产。
    try {
      const viewer = scopeOf(o)
      if (!visible(current, viewer) || deniedAtTarget(current, viewer)) return null
      const asset = assetOf(current)
      if (!asset) return null
      return { type: 'image', data: { file: 'base64://' + readFileSync(storage.assets.pathOf(asset)).toString('base64'), sub_type: 1,
        summary: `[${(current.name || '表情').replace(/[\[\]\r\n]/g, ' ').slice(0, 80)}]` } }
    } catch { return null }
  }
  function preview(key, o = {}) {
    const it = managed(key, o)
    const frame = context(o).frame
    const asset = frame === undefined ? assetOf(it) : storage.assets.get(it.frames[Number(frame)]?.assetId)
    if (!asset || asset.state !== 'stored') return null
    try { return { bytes: readFileSync(storage.assets.pathOf(asset)), mime: asset.mime } } catch { return null }
  }
  function inspect(buf, automatic = false, markedSticker = false) {
    const maxBytes = automatic && !markedSticker ? 1.5 : 5
    if (!Buffer.isBuffer(buf) || !buf.length || buf.length > maxBytes * 1024 * 1024) fail('INVALID_IMAGE', `图片为空或超过 ${maxBytes} MB 体积上限`)
    const mime = mimeOf(buf)
    const size = imageSize(buf)
    if (!['image/png', 'image/gif', 'image/jpeg', 'image/webp', 'image/bmp'].includes(mime)) fail('INVALID_IMAGE', '不是支持的图片格式')
    // 平台已明确标记的表情无需再猜是否方形；仍限定画布/像素/文件大小。
    if (automatic && markedSticker) {
      if (!(size.width > 0 && size.height > 0) || size.width > 2048 || size.height > 2048 || size.width * size.height > 4 * 1024 * 1024) fail('INVALID_IMAGE', '平台表情需有有效尺寸，边长不超过 2048、像素不超过 4M')
    } else if (automatic && !stickerSizeOk({ ...size, bytes: buf.length })) fail('INVALID_IMAGE', '普通图片候选尺寸不像表情')
    // 动态 WebP/APNG 同样不能由静态首帧推断整图。
    const animated = mime === 'image/gif' || (mime === 'image/webp' && buf.includes(Buffer.from('ANIM'))) || (mime === 'image/png' && buf.includes(Buffer.from('acTL')))
    return { mime, ...size, animated }
  }
  function sourceFor(seg, scope, options) {
    if (options.messageId) {
      const m = storage.messages.get(String(options.messageId))
      if (!m || m.account !== scope.account || m.chatId !== scope.chat || m.recalledAt) fail('INVALID_SOURCE', '来源消息不属于这个账号/聊天或已撤回')
      const index = options.segmentIndex ?? m.segments.findIndex((s) => JSON.stringify(s) === JSON.stringify(seg))
      if (!Number.isInteger(index) || index < 0 || JSON.stringify(m.segments[index]) !== JSON.stringify(seg)) fail('INVALID_SOURCE', '来源消息没有这个媒体段')
      return { key: `message:${m.id}:${index}`, kind: 'message', messageId: m.id, segmentIndex: index, segmentHash: hash(JSON.stringify(seg)), authorId: m.authorId,
        platformMsgId: m.platformMsgId, scope, segment: seg, hint: String(seg.data?.summary || '').slice(0, 500) }
    }
    return { key: `legacy-call:${hash(JSON.stringify(seg))}`, kind: 'legacy_call', messageId: null, scope, segment: seg, segmentHash: hash(JSON.stringify(seg)),
      hint: String(seg.data?.summary || '').slice(0, 500), reason: '旧调用没有消息身份，不能自动批准' }
  }
  function validateSource(source) {
    if (!source?.messageId) return
    const m = storage.messages.get(source.messageId)
    const seg = m?.segments?.[source.segmentIndex]
    if (!m || m.recalledAt || m.account !== source.scope.account || m.chatId !== source.scope.chat || m.authorId !== source.authorId || !seg || hash(JSON.stringify(seg)) !== source.segmentHash) fail('INVALID_SOURCE', '来源已撤回、修改或改变范围')
  }
  function selectedSourceValid(source, requestId, epoch, occurrenceId, requireOpen = false) {
    const request = requestId && storage.requests?.get(requestId), occurrence = occurrenceId && storage.occurrences?.get(occurrenceId)
    const message = source.messageId && storage.messages.get(source.messageId), age = now() - Number(occurrence?.createdAt)
    return Boolean(request && occurrence && message && source.scope.account === account() &&
      request.chatId === source.scope.chat && request.epoch === epoch && storage.epochs.current(source.scope.chat) === epoch &&
      !['canceled', 'cancel_requested', 'closed', 'expired', ...(requireOpen ? ['ended', 'answered', 'delivery_partial', 'delivery_unknown'] : [])].includes(request.state) &&
      request.sourceMessageIds.includes(source.messageId) && request.actorId === message.authorId &&
      occurrence.messageId === source.messageId && occurrence.chatId === source.scope.chat && occurrence.authorId === message.authorId &&
      occurrence.segIndex === source.segmentIndex && occurrence.kind === 'sticker' && Number.isFinite(age) && age >= 0 && age < 30 * 60_000)
  }
  function analysisTask(it) {
    if (unknownAnalysis(it)) fail('ANALYSIS_UNKNOWN', '上次识别结果未知，可能已计费；请核对任务，不能直接重新识别')
    const active = ['queued', 'running'].flatMap(state => analysisTasks(it, state))[0]
    if (active) return active
    return repo.enqueue(it.scope, 'analyze', `${it.id}:${it.revision}`, { revision: it.revision,
      policyVersion: String(cfg().policyVersion || '1') }, it.id)
  }
  function scheduleAnalysis(it) {
    if (cfg().caption === false) return null
    try { return analysisTask(it) } catch (e) {
      repo.update(it.id, (current) => { current.analysis = { ...current.analysis, state: e.code === 'ANALYSIS_UNKNOWN' ? 'unknown' : 'failed', error: e.message } })
      return null
    }
  }
  async function collect(seg, o, extra = {}) {
    return safe(() => {
      if (stopped || cfg().enabled === false || cfg().collect === false) fail('DISABLED', '后台收藏已关闭')
      if (!isStickerSegment(seg)) fail('NOT_STICKER', '普通图片不自动收藏；可由管理员手动添加')
      const options = { ...context(o), ...extra }
      const scope = scopeOf(options)
      if ((scope.chat.startsWith('group:') && cfg().fromGroups === false) || (scope.chat.startsWith('private:') && cfg().fromPrivate === false)) fail('DISABLED', '这个来源的自动收藏已关闭')
      if (JSON.stringify(seg).length > 7 * 1024 * 1024) fail('INVALID_IMAGE', '媒体段过大')
      const source = sourceFor(seg, scope, options)
      const mode = cfg().collectMode || 'auto'
      if (!['auto', 'owner', 'ask'].includes(mode)) fail('DISABLED', '收藏策略无效')
      if (mode === 'owner' && (!source.messageId || String(source.authorId) !== String(getConfig().ownerQQ))) fail('FORBIDDEN', '仅收藏主人发送的表情')
      if (mode === 'ask' && (options.selectedOccurrence !== true || !selectedSourceValid(source, options.requestId, options.epoch, options.occurrenceId, true))) fail('SELECTION_REQUIRED', '仅可选择本轮未过期、未撤回的表情来源')
      const job = repo.db.tx(() => {
        const t = repo.enqueue(scope, 'collect', source.key, { source, automatic: true, collectMode: mode, requestId: mode === 'ask' ? options.requestId : null, epoch: mode === 'ask' ? options.epoch : null, occurrenceId: mode === 'ask' ? options.occurrenceId : null })
        repo.saveSource(scope, source.key, source)
        return t
      })
      kick()
      return { ok: true, queued: job.state === 'queued' || job.state === 'running', taskId: job.id, state: job.state, itemId: job.output?.itemId || null }
    })
  }
  async function addFromBuffer(buf, options = {}) {
    return safe(() => {
      const scope = storageScope(options)
      const source = options.messageId ? sourceFor(options.segment, scope, options) : null
      validateSource(source)
      const from = options.from || 'panel'
      const result = repo.ingest(buf, inspect(buf), scope, { ...options, source, from, tags: array(options.tags || []),
        autoReviewEligible: Boolean(source?.messageId) || ['panel', 'manual', 'tool'].includes(from),
        editedFields: [...(String(options.name || '').trim() ? ['name'] : []), ...(options.tags?.length ? ['tags'] : [])], toQQ: options.toQQ !== false })
      if (!result.existed) scheduleAnalysis(result.item)
      kick()
      return { ...result, item: decorate(repo.get(result.item.id)), message: '本地已保存；新素材识别通过后自动可用，QQ 收藏状态单独跟踪' }
    })
  }

  function queueQQ(it, action = 'add') {
    return repo.db.tx(() => {
      if (!['add', 'rename', 'delete'].includes(action)) fail('INVALID_ACTION', '同步动作无效')
      if (action !== 'delete' && it.state !== 'approved') fail('NOT_APPROVED', '未批准的表情不能同步收藏')
      if (action !== 'delete' && accountLibrary() && deniedAtTarget(it, it.scope)) fail('LIBRARY_BLOCKED', '同账号的此素材已停用、拒绝或删除')
      const q = repo.qq(it.scope.account, it.sha256)
      if (q.state === 'unidentified') fail('QQ_ID_REQUIRED', 'QQ 收藏已导入但缺少 ID；请核对并绑定已有收藏，不能直接重复收藏')
      if (['queued', 'running', 'unknown'].includes(q.state)) {
        if (action === 'delete') repo.saveQQ(it.scope.account, it.sha256, { ...q, desired: 'absent' })
        return { ok: q.state !== 'unknown', state: q.state, taskId: q.taskId, reason: q.state === 'unknown' ? '上次同步结果未知，须先在 QQ 核对' : '已有同步任务' }
      }
      if (action === 'delete' && !q.emojiId) return { ok: true, state: q.state, reason: '没有已确认的 QQ 收藏 ID' }
      if (action === 'rename' && !q.emojiId) fail('NO_QQ_ID', '没有已确认的 QQ 收藏 ID，不能修改 QQ 备注')
      if (action === 'add' && q.emojiId) {
        if (q.name === it.name && q.state === 'synced') return { ok: true, state: 'synced', taskId: q.taskId }
        action = 'rename'
      }
      const job = repo.enqueue(it.scope, 'sync', `${it.sha256}:${action}:${newStickerId('req')}`, {
        action, sha256: it.sha256, assetId: it.assetId, emojiId: q.emojiId, name: it.name,
      }, it.id)
      repo.saveQQ(it.scope.account, it.sha256, { ...q, state: 'queued', desired: action === 'delete' ? 'absent' : 'present', taskId: job.id, error: null })
      return { ok: true, state: 'queued', taskId: job.id }
    })
  }
  function queueSync(key, options = {}) {
    const r = safe(() => queueQQ(managed(key, options), options.action || 'add'))
    kick()
    return r
  }
  function edit(key, patch, options = {}) {
    return safe(() => {
      const it = managed(key, options)
      if (it.state === 'deleted') fail('TOMBSTONED', '已删除的表情不可修改')
      const allowed = ['name', 'tags', 'description', 'ocr', 'emotions', 'suitable', 'unsuitable', 'manualOnly']
      if (Object.keys(patch).some((key) => !allowed.includes(key))) fail('INVALID_INPUT', '只能编辑标签和描述证据')
      const saved = repo.update(it.id, (current) => {
        for (const [key, value] of Object.entries(patch)) {
          if (key === 'manualOnly') { if (typeof value !== 'boolean') fail('INVALID_INPUT', 'manualOnly 必须是布尔值'); current[key] = value }
          else if (['tags', 'emotions', 'suitable', 'unsuitable'].includes(key)) current[key] = array(value, key)
          else {
            if (typeof value !== 'string' || value.length > (key === 'name' ? 80 : 4000)) fail('INVALID_INPUT', `${key} 格式/长度无效`)
            current[key] = value
          }
          current.editedFields = [...new Set([...current.editedFields, key])]
        }
      }, options.expectedRevision)
      return { ok: true, item: decorate(saved), message: '本地备注和标签已更新；QQ 备注同步需单独确认' }
    })
  }
  function review(key, state, options = {}) {
    return safe(() => {
      const it = managed(key, options)
      if (it.state === 'deleted') fail('TOMBSTONED', '已删除，不能恢复')
      if (state === 'approved') {
        if (accountLibrary() && related(it).some(copy => copy.id !== it.id && ['deleted', 'disabled', 'rejected'].includes(copy.state))) fail('LIBRARY_BLOCKED', '同账号另有停用、拒绝或删除记录，不能借另一副本恢复')
        if (!assetOf(it)) fail('UNAVAILABLE', '原文件不可用，不能批准')
        validateSource(it.source)
        if (it.animated && options.reviewedOriginal !== true) fail('REVIEW_ORIGINAL', '动画需查看原文件并明确确认，不能只看关键帧批准')
      }
      const saved = repo.update(it.id, (current) => {
        current.state = state
        current.review = { kind: 'manual', state, actorId: String(options.actorId || 'admin'), reason: String(options.reason || '管理员操作').slice(0, 2000), at: now() }
      }, options.expectedRevision)
      let sync = null
      if (state === 'approved' && saved.wantsQQ) sync = safe(() => queueQQ(saved))
      kick()
      return { ok: true, item: decorate(saved), sync }
    })
  }
  function remove(key, options = {}) {
    return safe(() => {
      const it = managed(key, options)
      const saved = it.state === 'deleted' ? it : repo.update(it.id, (current) => {
        current.state = 'deleted'
        current.deletedAt = now()
        current.review = { kind: 'manual', state: 'deleted', reason: String(options.reason || '管理员删除'), at: now() }
      }, options.expectedRevision)
      repo.db.run("UPDATE sticker_tasks SET state='canceled',error='素材已删除',updated_at=? WHERE item_id=? AND state='queued' AND kind!='sync'", now(), it.id)
      const shared = !accountLibrary() && repo.all().some((x) => x.id !== it.id && x.scope.account === it.scope.account && x.sha256 === it.sha256 && x.state !== 'deleted')
      const sync = options.fromQQ !== false && !shared ? safe(() => queueQQ(saved, 'delete')) : { state: 'retained', reason: shared ? '其他范围仍引用相同 QQ 收藏' : '仅删除本地条目' }
      kick()
      return { ok: true, tombstone: true, item: decorate(saved), sync, message: '本地已删除并保留删除记录；QQ 收藏删除请查看同步状态' }
    })
  }
  function retryAnalysis(key, options = {}) {
    return safe(() => repo.db.tx(() => {
      const it = managed(key, options)
      if (it.state === 'deleted') fail('TOMBSTONED', '已删除')
      if (unknownAnalysis(it)) fail('ANALYSIS_UNKNOWN', '上次识别结果未知，可能已计费；请先核对，不能直接重试')
      validateSource(it.source)
      const active = ['queued', 'running'].flatMap(state => analysisTasks(it, state))[0]
      if (active) return { ok: true, taskId: active.id, state: active.state }
      const task = repo.db.tx(() => {
        const current = repo.update(it.id, (i) => {
          i.analysis = { ...i.analysis, state: 'pending', error: null }
          // An explicit retry authorizes a fresh analysis, including old QQ/
          // panel needs_frames items. Merely loading the library does not.
          if (i.state === 'pending' && i.review.kind !== 'manual' && reviewableOrigin(i)) i.autoReviewEligible = true
        })
        return analysisTask(current)
      })
      kick()
      return { ok: true, taskId: task.id, state: task.state }
    }))
  }
  function selectFrames(key, frames, options = {}) {
    return safe(() => {
      const it = managed(key, options)
      if (it.state === 'deleted') fail('TOMBSTONED', '已删除')
      if (unknownAnalysis(it) || analysisTasks(it, 'running').length) fail('ANALYSIS_BUSY', '识别仍在执行或结果未知，请先核对任务再更换关键帧')
      validateSource(it.source)
      if (!it.animated || !Array.isArray(frames) || !frames.length || frames.length > 6) fail('INVALID_FRAMES', '动画需显式选择1~6张静态关键帧')
      const selected = frames.map((f) => {
        const buf = Buffer.isBuffer(f.bytes) ? f.bytes : Buffer.from(String(f.data || '').replace(/^data:[^,]+,/, ''), 'base64')
        if (buf.length > 2 * 1024 * 1024 || !Number.isFinite(f.atMs) || f.atMs < 0) fail('INVALID_FRAMES', '关键帧须小于2MB并提供非负 atMs')
        const info = inspect(buf)
        if (info.animated || !info.width || !info.height) fail('INVALID_FRAMES', '关键帧必须是可识别尺寸的静态图片')
        const asset = storage.assets.put(buf, { ...info, sourceKind: 'upload' })
        return { assetId: asset.id, sourceAssetId: it.assetId, atMs: f.atMs, selection: 'manual', coverage: 'partial' }
      })
      const saved = repo.update(it.id, (current) => {
        current.frames = selected
        current.analysis = { state: 'pending', error: null, evidence: null }
        if (current.state === 'pending' && current.review.kind !== 'manual' && reviewableOrigin(current)) current.autoReviewEligible = true
        // 改关键帧不撤销人工审核，也不会自动恢复拒绝/停用。
      }, options.expectedRevision)
      repo.db.run("UPDATE sticker_tasks SET state='canceled',error='关键帧已更新',updated_at=? WHERE item_id=? AND kind='analyze' AND state='queued'", now(), it.id)
      scheduleAnalysis(saved)
      kick()
      return { ok: true, item: decorate(repo.get(it.id)) }
    })
  }

  async function processCollect(t) {
    const source = t.input.source
    const permitted = () => {
      const mode = cfg().collectMode || 'auto'
      return !stopped && getConfig().enabled !== false && cfg().enabled !== false && source.scope.account === account() &&
        mode === (t.input.collectMode || 'auto') && (mode !== 'owner' || String(source.authorId) === String(getConfig().ownerQQ)) &&
        (mode !== 'ask' || selectedSourceValid(source, t.input.requestId, t.input.epoch, t.input.occurrenceId))
    }
    if (!permitted()) fail('DISABLED', '收藏策略或主人已改变')
    if (cfg().collect === false || (source.scope.chat.startsWith('group:') ? cfg().fromGroups : cfg().fromPrivate) === false) fail('DISABLED', '当前来源的自动收藏已关闭')
    validateSource(source)
    const markedSticker = isStickerSegment(source.segment)
    const buf = await download(source.segment, onebot, { maxBytes: (markedSticker ? 5 : 1.5) * 1024 * 1024, timeoutMs: 20000 })
    if (stopped) fail('STOPPED', '模块已停止')
    if (!permitted()) fail('DISABLED', '下载期间收藏策略或主人已改变')
    if (cfg().enabled === false || cfg().collect === false || (source.scope.chat.startsWith('group:') ? cfg().fromGroups : cfg().fromPrivate) === false) fail('DISABLED', '下载期间自动收藏已关闭')
    validateSource(source)
    repo.db.tx(() => {
      if (!repo.owns(t)) return
      const result = repo.ingest(buf, inspect(buf, true, markedSticker), source.scope, { automatic: true, source, from: source.scope.chat, toQQ: true, autoReviewEligible: Boolean(source.messageId) })
      repo.finish(t, 'done', { output: { itemId: result.item.id, existed: result.existed, localSaved: true, qqSynced: false } })
      if (!result.existed) scheduleAnalysis(result.item)
    })
  }
  async function processAnalysis(t) {
    const it = repo.get(t.itemId)
    if (!it || it.state === 'deleted' || it.revision !== t.input.revision) return repo.finish(t, 'canceled', { error: '素材已更新或删除' })
    if (unknownAnalysis(it)) return repo.finish(t, 'canceled', { error: '较早识别结果未知，禁止再次调用模型' })
    if (accountLibrary() && (deniedAtTarget(it, it.scope) || repo.canonical(related(it)).id !== it.id)) return repo.finish(t, 'canceled', { error: '同账号素材已阻止或已有统一条目，未调用识别模型' })
    validateSource(it.source)
    const modelScope = it.source?.scope || it.scope
    const ctrl = new AbortController()
    const callId = `${t.id}:${t.attempts}`
    let invoked = false
    controllers.add(ctrl)
    const timeout = setTimeout(() => {
      ctrl.abort(new Error('表情识别超时'))
      try { if (repo.owns(t)) repo.db.run('UPDATE sticker_tasks SET error=? WHERE id=?', '识别已超时，等待调用结束释放并发槽', t.id) } catch (e) { log?.warn?.('记录表情识别超时失败：', e.message) }
    }, clamp(cfg().analysisTimeoutMs, 60000, 10, 180000))
    timeout.unref?.()
    try {
      let sampled = null, frames = it.frames.filter((f) => f.selection === 'manual'), images
      const readImage = a => {
        if (!a || a.state !== 'stored') fail('UNAVAILABLE', '识别用图片不可用')
        return { data: readFileSync(storage.assets.pathOf(a)).toString('base64'), mediaType: a.mime }
      }
      if (it.animated && !frames.length) {
        const original = assetOf(it)
        if (!original) fail('UNAVAILABLE', '动画原文件不可用')
        sampled = await sampleFrames({ bytes: readFileSync(storage.assets.pathOf(original)), mime: it.mime, signal: ctrl.signal })
        if (!sampled.ok) fail('NEEDS_FRAMES', `${sampled.message || '本地取帧失败'}；可手工选帧或查看完整动画后人工审核`)
        if (!Array.isArray(sampled.frames) || !sampled.frames.length || sampled.frames.length > 6 || sampled.coverage !== 'partial') fail('NEEDS_FRAMES', '自动取样没有返回有界的部分帧证据')
        images = sampled.frames.map(f => {
          const info = inspect(f.bytes)
          if (info.mime !== 'image/png' || info.animated || !(info.width > 0 && info.height > 0) || info.width > 384 || info.height > 384 || f.bytes.length > 1024 * 1024 || !Number.isFinite(f.atMs) || f.atMs < 0) fail('NEEDS_FRAMES', '自动取样帧无效')
          return { data: f.bytes.toString('base64'), mediaType: 'image/png' }
        })
        frames = sampled.frames.map(({ bytes, mime, ...f }) => ({ ...f, sourceAssetId: it.assetId, selection: 'sampled', coverage: 'partial' }))
      } else images = (it.animated ? frames.map(f => storage.assets.get(f.assetId)) : [assetOf(it)]).map(readImage)
      ctrl.signal.throwIfAborted()
      validateSource(it.source)
      // 取样可能花数秒。调用付费模型前再次校验版本、开关和所有权。
      if (!repo.owns(t) || stopped || cfg().enabled === false || cfg().caption === false || repo.get(it.id)?.revision !== t.input.revision || (accountLibrary() && deniedAtTarget(it, it.scope))) {
        repo.finish(t, 'canceled', { error: '取帧期间素材或设置已改变，未调用识别模型' }); return
      }
      // GIF is a container, not proof of animation. A locally decoded container
      // with exactly one source frame has complete still-image evidence; one
      // selected frame from a multi-frame animation does not.
      const singleFrame = Boolean(sampled?.sampling?.sourceFrames === 1 && sampled.frames.length === 1 &&
        sampled.sampling.sampledFrames === 1)
      const animated = it.animated && !singleFrame
      const coverage = animated ? (sampled ? 'sampled_partial' : 'manual_partial') : 'still_image'
      t.analysisOutcome = 'unknown'
      invoked = true
      const response = await analyzer({ images, frames, coverage, hint: it.source?.hint || '', animated,
        policyVersion: t.input.policyVersion, signal: ctrl.signal, scope: modelScope, chatId: modelScope.chat,
        operationId: it.id, callId, sourceMessageIds: it.source?.messageId ? [it.source.messageId] : [] })
      ctrl.signal.throwIfAborted()
      t.analysisOutcome = 'completed'
      const result = parseAnalysis(response, t.input.policyVersion)
      if (animated) {
        result.modelDecision = result.decision
        const multipleFrames = new Set(frames.map(f => f.atMs)).size >= 2
        if (result.decision === 'approve' && !multipleFrames) result.decision = 'pending'
        result.reason = (multipleFrames ? '仅基于动画部分帧判断，不代表已看过完整动画。' : '不足两个不同时间点的有效帧，不能自动批准动画。') + result.reason
      }
      validateSource(it.source)
      const accepted = repo.db.tx(() => {
        const current = repo.get(it.id)
        if (!repo.owns(t)) return false
        if (stopped || cfg().enabled === false || cfg().caption === false || !current || current.state === 'deleted' || current.revision !== t.input.revision || String(cfg().policyVersion || '1') !== t.input.policyVersion || (accountLibrary() && deniedAtTarget(it, it.scope))) {
          repo.finish(t, 'canceled', { error: '素材/规则已改变，忽略迟到识别结果' }); return false
        }
        const saved = repo.update(it.id, (item) => {
          if (sampled) item.frames = frames.map((f, i) => ({ ...f, assetId: storage.assets.put(sampled.frames[i].bytes,
            { mime: 'image/png', width: f.width, height: f.height, sourceKind: 'generated' }).id }))
          item.analysis = { state: 'done', error: null, evidence: { ...result, assetId: it.assetId,
            frames: sampled ? item.frames : frames, coverage, singleFrame, sampling: sampled?.sampling || null, at: now() } }
          for (const key of ['name', 'tags', 'description', 'ocr', 'emotions', 'suitable', 'unsuitable']) {
            if (!item.editedFields.includes(key)) item[key] = result[key]
          }
          // Only newly admitted material opts into automatic review. Old manual
          // pending records are never bulk-approved or silently reanalysed.
          if (item.state === 'pending' && item.review.kind !== 'manual' && cfg().autoReview !== false && item.autoReviewEligible === true) {
            if (result.decision === 'approve') item.state = 'approved'
            if (result.decision === 'reject') item.state = 'rejected'
            item.review = { kind: 'model', decision: result.decision, reason: result.reason, policyVersion: t.input.policyVersion, at: now() }
          }
        })
        repo.finish(t, 'done', { output: { itemId: it.id, state: saved.state } })
        if (saved.state === 'approved' && saved.wantsQQ) safe(() => queueQQ(saved))
        return true
      })
      reportModelOutcome(dsh, { callId, scope: modelScope, status: accepted ? 'success' : 'discarded', code: accepted ? '' : 'STALE_ANALYSIS' })
    } catch (error) {
      // Domain settlement updates the original call, without changing the task's
      // unknown/retry barrier or counting usage for a second time.
      if (invoked) reportModelOutcome(dsh, { callId, scope: modelScope, status: 'failed',
        code: error.code || (t.analysisOutcome === 'unknown' ? 'ANALYSIS_UNKNOWN' : 'ANALYSIS_FAILED') })
      throw error
    } finally { clearTimeout(timeout); controllers.delete(ctrl) }
  }
  async function processSync(t) {
    const it = repo.get(t.itemId)
    const q = repo.qq(t.accountId, t.input.sha256)
    const action = t.input.action
    if (q.taskId !== t.id || (action !== 'delete' && (it?.state !== 'approved' || q.desired === 'absent' || (accountLibrary() && deniedAtTarget(it, it.scope))))) {
      repo.db.tx(() => { repo.finish(t, 'canceled', { error: '本地状态已改变，未调用 QQ' }); if (q.taskId === t.id) repo.saveQQ(t.accountId, t.input.sha256, { ...q, state: q.emojiId ? 'synced' : 'idle', error: '本地状态已改变' }) })
      return
    }
    let actionName, params
    try {
      if (stopped || getConfig().dryRun || cfg().enabled === false) fail('NOT_SENT', '当前设置不允许 QQ 同步')
      if (!onebot?.call) fail('NOT_SENT', '没有 QQ 网关')
      if (action !== 'delete' && !sourceValid(it)) fail('NOT_SENT', '来源不可用')
      if (action === 'add') {
        const a = assetOf(it)
        if (!a || !sourceValid(it)) fail('NOT_SENT', '原文件或来源不可用')
        actionName = 'add_custom_face'; params = { file: 'base64://' + readFileSync(storage.assets.pathOf(a)).toString('base64') }
      } else if (action === 'rename') {
        actionName = 'modify_custom_face'; params = { emoji_id: q.emojiId, desc: it.name.slice(0, 20) }
      } else { actionName = 'delete_custom_face'; params = { emoji_id: q.emojiId } }
    } catch (e) {
      repo.db.tx(() => {
        if (!repo.owns(t)) return
        repo.finish(t, 'failed', { error: e.message, outcome: 'not_sent' })
        repo.saveQQ(t.accountId, t.input.sha256, { ...q, state: 'failed', error: e.message })
      })
      return
    }
    const ready = repo.db.tx(() => {
      const latest = repo.qq(t.accountId, t.input.sha256)
      const current = repo.get(t.itemId)
      if (!repo.owns(t)) return false
      if (latest.taskId !== t.id || (action !== 'delete' && (current?.state !== 'approved' || latest.desired === 'absent' || (accountLibrary() && deniedAtTarget(current, current.scope))))) {
        repo.finish(t, 'canceled', { error: '调用 QQ 前本地状态改变' })
        if (latest.taskId === t.id) repo.saveQQ(t.accountId, t.input.sha256, { ...latest, state: latest.emojiId ? 'synced' : 'idle', error: '本地状态改变，未调用 QQ' })
        return false
      }
      repo.saveQQ(t.accountId, t.input.sha256, { ...latest, state: 'running' })
      return true
    })
    if (!ready) return
    let result
    try { result = await onebot.call(actionName, params, { timeoutMs: 30000 }) } catch (e) {
      const outcome = ['not_sent', 'rejected'].includes(e?.outcome) ? e.outcome : 'unknown'
      repo.db.tx(() => {
        if (!repo.owns(t)) return
        const latest = repo.qq(t.accountId, t.input.sha256)
        repo.finish(t, outcome === 'unknown' ? 'unknown' : 'failed', { error: e?.message || String(e), outcome })
        if (latest.taskId === t.id) repo.saveQQ(t.accountId, t.input.sha256, { ...latest, state: outcome === 'unknown' ? 'unknown' : 'failed', error: e?.message || String(e) })
      })
      return
    }
    // 外部回执与落库分开：落库错误不能当成 QQ 明确失败再次执行。
    repo.db.tx(() => {
      if (!repo.owns(t)) return
      const latest = repo.qq(t.accountId, t.input.sha256)
      if (action === 'add' && !result?.emoji_id) {
        repo.finish(t, 'unknown', { error: 'QQ 返回缺少 emoji_id，不能确认收藏身份', outcome: 'unknown' })
        repo.saveQQ(t.accountId, t.input.sha256, { ...latest, state: 'unknown', error: '回执缺少 emoji_id' })
        return
      }
      const synced = { ...latest, state: action === 'delete' ? 'removed' : 'synced', emojiId: action === 'delete' ? '' : String(result?.emoji_id || q.emojiId), name: it?.name || '', error: null, at: now() }
      repo.saveQQ(t.accountId, t.input.sha256, synced)
      repo.finish(t, 'done', { output: { state: synced.state, emojiId: synced.emojiId, action } })
      if (synced.desired === 'absent' && action !== 'delete') safe(() => queueQQ(repo.get(it.id), 'delete'))
    })
  }
  async function execute(t) {
    try {
      if (t.kind === 'collect') await processCollect(t)
      else if (t.kind === 'analyze') await processAnalysis(t)
      else if (t.kind === 'sync') await processSync(t)
      else if (t.kind === 'import') await processImport(t)
      else fail('INVALID_TASK', '未知表情任务')
    } catch (e) {
      // sync 抛到这里可能是回执落库失败，保持 unknown；不误报明确未发送。
      repo.db.tx(() => {
        if (!repo.owns(t)) return
        const uncertainAnalysis = t.kind === 'analyze' && t.analysisOutcome === 'unknown' && !['NO_VISION', 'MODEL_UNAVAILABLE'].includes(e.code) && !['not_sent', 'rejected'].includes(e.outcome)
        const state = t.kind === 'sync' || uncertainAnalysis ? 'unknown' : 'failed'
        repo.finish(t, state, { error: e?.message || String(e), outcome: state === 'unknown' ? 'unknown' : t.analysisOutcome || null })
        if (t.kind === 'sync') {
          const q = repo.qq(t.accountId, t.input.sha256)
          if (q.taskId === t.id) repo.saveQQ(t.accountId, t.input.sha256, { ...q, state: 'unknown', error: e.message })
        }
        const it = t.itemId && repo.get(t.itemId)
        if (t.kind === 'analyze' && it && it.state !== 'deleted' && it.revision === t.input.revision) repo.update(it.id, (i) => {
          i.analysis = { ...i.analysis, state: e.code === 'NEEDS_FRAMES' ? 'needs_frames' : state, error: e.message }
        })
      })
      log?.warn?.('表情后台任务失败：', e?.message || String(e))
    }
  }
  async function tick() {
    if (stopped || cfg().enabled === false || !account()) return 0
    const started = []
    while (running.size < limits().concurrency) {
      const t = repo.claim(account(), { sync: !getConfig().dryRun, analyze: cfg().caption !== false, collect: cfg().collect !== false })
      if (!t) break
      const p = Promise.resolve().then(() => execute(t)).finally(() => { repo.forget(t); running.delete(t.id) })
      running.set(t.id, p)
      started.push(p)
    }
    await Promise.all(started)
    return started.length
  }
  async function drain(max = 500) { for (let n = 0; n < max; n++) if (!await tick()) return; throw new Error('表情队列未排空') }
  function kick() {
    if (!autoStart || stopped || scheduled) return
    scheduled = true
    setImmediate(() => { scheduled = false; tick().then((n) => { if (n) kick() }).catch((e) => log?.warn?.('表情队列失败：', e.message)) })
  }
  function start() {
    stopped = false
    if (!timer) { timer = setInterval(kick, 1000); timer.unref?.() }
    kick()
  }
  function stop() { stopped = true; clearInterval(timer); timer = null; for (const c of controllers) c.abort(new Error('表情模块停止')); return Promise.allSettled([...running.values()]) }
  const recover = () => repo.recover(account())
  function queueStatus(options = {}) {
    admin(options)
    if (options.accountId && options.accountId !== account()) fail('WRONG_ACCOUNT', '账号范围与当前机器人不匹配')
    const page = repo.taskPage(account(), { ...options, chatId: accountLibrary() ? undefined : options.chatId, limit: clamp(options.limit, 100, 1, 500), offset: clamp(options.offset, 0, 0, 1000000) })
    return { ...page, libraryScope: libraryScope(), items: page.items.map(({ owner, input, ...t }) => ({ ...t, action: input.action,
      blockedReason: t.state !== 'queued' ? null : cfg().enabled === false ? '表情模块已关闭' :
        ['sync', 'import'].includes(t.kind) && getConfig().dryRun ? '试运行：QQ 任务已暂停' :
          t.kind === 'analyze' && cfg().caption === false ? '模型识别已关闭' : t.kind === 'collect' && cfg().collect === false ? '自动收藏已关闭' : null })),
      running: running.size, limits: limits(), runtime: { libraryScope: libraryScope(), enabled: cfg().enabled !== false, caption: cfg().caption !== false, collect: cfg().collect !== false, dryRun: Boolean(getConfig().dryRun), autoChance: cfg().autoChance, autoReview: cfg().autoReview !== false } }
  }
  function retryTask(taskId, options = {}) {
    return safe(() => repo.db.tx(() => {
      const t = managedTask(taskId, options)
      if (t.state !== 'failed') fail('NOT_RETRYABLE', '只可重试明确失败；结果未知须先核对')
      if (t.kind === 'analyze') {
        const r = retryAnalysis(t.itemId, options)
        if (r.ok) repo.db.run("UPDATE sticker_tasks SET state='canceled',error='已由新的识别任务替代',output_json=?,updated_at=? WHERE id=?", JSON.stringify({ replacementTaskId: r.taskId }), now(), t.id)
        return r
      }
      const retried = repo.db.tx(() => {
        const q = t.kind === 'sync' && repo.qq(t.accountId, t.input.sha256)
        if (q && q.taskId !== t.id) fail('STALE_TASK', '同步任务已被替代')
        const next = repo.retryTask(taskId)
        if (q) repo.saveQQ(t.accountId, t.input.sha256, { ...q, state: 'queued', error: null })
        return next
      })
      kick()
      return { ok: true, taskId: retried.id, state: retried.state }
    }))
  }
  function reconcileSync(taskId, options = {}) {
    return safe(() => repo.db.tx(() => {
      const t = managedTask(taskId, options)
      if (t.kind !== 'sync' || t.state !== 'unknown') fail('NOT_RECONCILABLE', '只可核对结果未知的同步')
      const q = repo.qq(t.accountId, t.input.sha256)
      if (q.taskId !== t.id) fail('STALE_TASK', '同步任务已替代')
      if (options.confirmedNotApplied === true && options.confirmedApplied === true) fail('INVALID_INPUT', '不能同时确认已执行和未执行')
      if (options.confirmedNotApplied === true) {
        repo.db.run("UPDATE sticker_tasks SET state='failed',outcome='not_sent',error='管理员核对未执行',updated_at=? WHERE id=?", now(), t.id)
        repo.saveQQ(t.accountId, t.input.sha256, { ...q, state: 'failed', error: '管理员核对未执行' })
      } else if (options.confirmedApplied === true && (t.input.action === 'delete' || String(options.emojiId || q.emojiId).trim())) {
        repo.db.run("UPDATE sticker_tasks SET state='done',error=NULL,updated_at=? WHERE id=?", now(), t.id)
        repo.saveQQ(t.accountId, t.input.sha256, { ...q, state: t.input.action === 'delete' ? 'removed' : 'synced', emojiId: t.input.action === 'delete' ? '' : String(options.emojiId || q.emojiId), error: null, reconciled: true })
        if (q.desired === 'absent' && t.input.action !== 'delete') {
          queueQQ(repo.get(t.itemId), 'delete')
          kick()
        }
      } else fail('CONFIRMATION_REQUIRED', '需要明确核对结果；已收藏需提供 emojiId')
      return { ok: true, sync: repo.qq(t.accountId, t.input.sha256) }
    }))
  }
  function reconcileAnalysis(taskId, options = {}) {
    return safe(() => repo.db.tx(() => {
      const t = managedTask(taskId, options)
      if (t.kind !== 'analyze' || t.state !== 'unknown') fail('NOT_RECONCILABLE', '只可核对结果未知的识别')
      if (options.confirmedNotApplied !== true || typeof options.reason !== 'string' || !options.reason.trim()) fail('CONFIRMATION_REQUIRED', '需逐项核对服务记录，确认未执行并填写依据；无法确认时请人工标注')
      repo.db.run("UPDATE sticker_tasks SET state='failed',outcome='not_sent',error=?,updated_at=? WHERE id=?", '管理员核对未执行：' + options.reason.slice(0, 1000), now(), t.id)
      const it = repo.get(t.itemId)
      if (it && it.state !== 'deleted' && !repo.tasks(t.accountId, { itemId: it.id, kind: 'analyze', state: 'unknown', limit: 1 }).length) repo.update(it.id, (i) => {
        i.analysis = { ...i.analysis, state: 'failed', error: '管理员已核对未执行，可手动重试' }
      })
      return { ok: true, taskId, message: '核对已登记；尚未重试识别' }
    }))
  }
  function bindQQ(key, options = {}) {
    return safe(() => repo.db.tx(() => {
      const it = managed(key, options), q = repo.qq(it.scope.account, it.sha256)
      if (q.state !== 'unidentified') fail('NOT_BINDABLE', '仅可绑定已导入但缺少 ID 的 QQ 收藏；未知任务请走任务核对')
      if (options.confirmedExisting !== true || typeof options.emojiId !== 'string' || !options.emojiId.trim() || options.emojiId.length > 200) fail('CONFIRMATION_REQUIRED', '请核对这张素材对应的 QQ 收藏 ID')
      repo.saveQQ(it.scope.account, it.sha256, { ...q, state: 'synced', emojiId: options.emojiId.trim(), source: 'qq_import',
        name: it.name, error: null, reconciled: true, at: now() })
      return { ok: true, item: decorate(it), message: '已绑定核对过的 QQ 收藏 ID；没有重复收藏' }
    }))
  }
  // 只接受用户看过的显式 ID 快照；不在服务端扩大成整个库或新的筛选结果。
  function batch(action, entries, options = {}) {
    return safe(() => {
      admin(options)
      const scope = accountLibrary() && !context(options).chatId ? { account: accountOf(options) } : scopeOf(options)
      const actions = { approve: (id, o) => review(id, 'approved', o), reject: (id, o) => review(id, 'rejected', o),
        disable: (id, o) => review(id, 'disabled', o), delete: (id, o) => remove(id, { ...o, fromQQ: false }),
        analysis_retry: retryAnalysis, task_retry: retryTask }
      if (!actions[action]) fail('INVALID_ACTION', '未知批量动作')
      if (!Array.isArray(entries) || !entries.length || entries.length > 200) fail('INVALID_BATCH', '每批须明确选择 1~200 项')
      if (action === 'task_retry' && !['collect', 'analyze', 'sync', 'import'].includes(options.kind)) fail('INVALID_BATCH', '请明确选择识别、收藏下载、QQ 同步或 QQ 导入任务')
      const seen = new Set()
      const results = entries.map((entry) => {
        const id = entry?.id
        const result = safe(() => repo.db.tx(() => {
          if (typeof id !== 'string' || !id || seen.has(id)) fail('INVALID_BATCH_ITEM', '缺少 ID 或同一批内重复选择')
          seen.add(id)
          const o = { admin: true, accountId: scope.account, chatId: scope.chat, actorId: options.actorId,
            expectedRevision: entry.expectedRevision, reviewedOriginal: entry.reviewedOriginal === true, reason: options.reason }
          if (action === 'task_retry') {
            if (!Number.isInteger(entry.expectedAttempts) || entry.expectedState !== 'failed') fail('INVALID_BATCH_ITEM', '需提供所选失败任务的状态和尝试次数')
            Object.assign(o, { expectedState: entry.expectedState, expectedAttempts: entry.expectedAttempts })
            if (managedTask(id, o).kind !== options.kind) fail('WRONG_TASK_KIND', '不能混用识别重试和 QQ 同步重试')
          } else {
            if (!Number.isInteger(entry.expectedRevision)) fail('INVALID_BATCH_ITEM', '需提供所选素材的版本')
            managed(id, o)
          }
          return actions[action](id, o)
        }))
        return { id, ok: result.ok, code: result.code, message: result.message || result.reason,
          state: result.state || result.item?.state, taskId: result.taskId, revision: result.item?.revision, tombstone: result.tombstone, sync: result.sync }
      })
      const succeeded = results.filter((r) => r.ok).length
      return { ok: true, action, total: results.length, succeeded, failed: results.length - succeeded,
        partial: succeeded > 0 && succeeded < results.length, syncFailed: results.filter((r) => r.sync?.ok === false).length, results }
    })
  }
  async function importFromQQ(options = {}) {
    return safe(() => {
      admin(options)
      const scope = storageScope(accountLibrary() ? { ...context(options), chatId: undefined } : options)
      const task = repo.enqueue(scope, 'import', `qq:${scope.chat}:${Math.floor(now() / 60_000)}`, { limit: clamp(options.limit, limits().maxLibrary, 1, 500), scope })
      kick()
      return { ok: true, taskId: task.id, state: task.state, message: 'QQ 导入已排队；新素材识别通过后自动可用' }
    })
  }
  async function processImport(t) {
    if (stopped || cfg().enabled === false || getConfig().dryRun) fail('DISABLED', '当前设置不允许 QQ 导入')
    const response = await onebot.call('fetch_custom_face', { count: t.input.limit }, { timeoutMs: 30000 })
    if (stopped || cfg().enabled === false || getConfig().dryRun) fail('DISABLED', 'QQ 导入期间模块已暂停')
    const entries = (Array.isArray(response) ? response : response?.data)
    if (!Array.isArray(entries)) fail('INVALID_RESPONSE', 'QQ 收藏列表格式无效')
    let added = 0, existed = 0, failed = 0
    for (const entry of entries.slice(0, t.input.limit)) {
      if (stopped || cfg().enabled === false || getConfig().dryRun) fail('DISABLED', 'QQ 导入期间模块已暂停')
      try {
        const url = typeof entry === 'string' ? entry : entry?.url
        if (!/^https?:\/\//i.test(String(url))) fail('INVALID_SOURCE', 'QQ 收藏没有有效 URL')
        const buf = await fetch(url, { maxBytes: 5 * 1024 * 1024, allowLocal: false })
        if (stopped || cfg().enabled === false || getConfig().dryRun) fail('DISABLED', 'QQ 导入期间模块已暂停')
        const result = repo.ingest(buf, inspect(buf), t.input.scope, { from: 'qq', toQQ: false, tags: [], autoReviewEligible: true })
        if (result.existed) existed++
        else { added++; scheduleAnalysis(result.item) }
        // fetch_custom_face 证明属于 QQ 收藏；无 emoji ID 时不假造可操作的同步身份。
        const q = repo.qq(t.accountId, result.item.sha256)
        if (!['queued', 'running', 'unknown'].includes(q.state)) {
          if (entry?.emoji_id) repo.saveQQ(t.accountId, result.item.sha256, { ...q, state: 'synced', emojiId: String(entry.emoji_id), name: result.item.name, error: null, source: 'qq_import' })
          else if (!q.emojiId) repo.saveQQ(t.accountId, result.item.sha256, { ...q, state: 'unidentified', source: 'qq_import', error: 'QQ 收藏已导入但没有收藏 ID，请核对并绑定' })
        }
      } catch { failed++ }
    }
    repo.finish(t, 'done', { output: { added, existed, failed, total: entries.length } })
  }
  const importLegacy = (directory, options = {}) => safe(() => { admin(options); return { ok: true, ...quarantineLegacy(repo, storage, directory, now) } })
  function deleteLegacy(id, options = {}) {
    return safe(() => {
      admin(options)
      const entry = repo.db.get('SELECT body_json FROM sticker_legacy WHERE id=?', id)
      if (!entry) fail('NOT_FOUND', '没有这个旧库条目')
      const body = { ...JSON.parse(entry.body_json), state: 'deleted', deletedAt: now() }
      repo.db.run("UPDATE sticker_legacy SET state='deleted',body_json=?,updated_at=? WHERE id=?", JSON.stringify(body), now(), id)
      return { ok: true, tombstone: true }
    })
  }
  async function assignLegacy(id, options = {}) {
    return safe(() => repo.db.tx(() => {
      admin(options)
      const r = repo.db.get('SELECT * FROM sticker_legacy WHERE id=?', id)
      if (!r || r.state !== 'quarantined') fail('NOT_FOUND', '没有待分配的隔离条目')
      const legacy = JSON.parse(r.body_json)
      const a = storage.assets.get(legacy.assetId)
      if (!a || a.state !== 'stored') fail('UNAVAILABLE', '旧原文件不可用，保留隔离记录')
      const buf = readFileSync(storage.assets.pathOf(a))
      const result = repo.ingest(buf, inspect(buf), storageScope(options), { from: 'legacy', name: String(legacy.legacy.name || ''), tags: array(legacy.legacy.tags || []), toQQ: false })
      legacy.state = 'assigned'; legacy.itemId = result.item.id; legacy.assignedScope = result.item.scope
      repo.db.run("UPDATE sticker_legacy SET state='assigned',body_json=?,updated_at=? WHERE id=?", JSON.stringify(legacy), now(), id)
      if (!result.existed) scheduleAnalysis(result.item)
      kick()
      return { ok: true, item: decorate(repo.get(result.item.id)) }
    }))
  }
  const legacyReport = legacyDir ? importLegacy(legacyDir, { admin: true }) : null
  function stats(options = {}) {
    const c = context(options)
    const result = { total: 0, pending: 0, approved: 0, rejected: 0, disabled: 0, deleted: 0, libraryScope: libraryScope() }
    let viewer
    if (!c.admin) { try { viewer = scopeOf(c) } catch { return result } }
    for (const it of repo.library(accountOf(c), true)) {
      if (c.admin ? !accountLibrary() && c.chatId && it.scope.chat !== c.chatId : it.state !== 'approved' || !visible(it, viewer) || !assetOf(it) || !sourceValid(it) || deniedAtTarget(it, viewer)) continue
      result[it.state]++
      if (it.state !== 'deleted') result.total++
    }
    return result
  }
  return { collect, addFromBuffer, list, library: list, get, status: get, stats, preview, match, segmentFor, selectForReply,
    pickForReply: (text, o, extra) => selectForReply(text, o, extra).item,
    markUsed: (key, o) => safe(() => { const it = rawFind(key, o); if (!it || !segmentFor(it, o)) return false; repo.used(scopeOf(o), it.sha256); return true }),
    edit, rename: (id, name, tags, o) => edit(id, { ...(name === undefined ? {} : { name }), ...(tags === undefined ? {} : { tags }) }, o),
    approve: (id, o) => review(id, 'approved', o), reject: (id, o) => review(id, 'rejected', o), disable: (id, o) => review(id, 'disabled', o), remove,
    selectFrames, retryAnalysis, queueSync, sync: queueSync, queueStatus, retryTask, reconcileSync, reconcileAnalysis, bindQQ, batch, importFromQQ, importLegacy, assignLegacy, deleteLegacy, legacyReport,
    trim: () => ({ ok: true, removed: 0, message: '达到上限后停止接收，不自动删除已审核素材' }),
    tick, drain, start, stop, recover }
}

import { existsSync, readFileSync } from 'node:fs'
import { imageSize, mimeOf, stickerSizeOk, isStickerSegment } from '../chat/inbound.js'
import { segmentBytes, fetchImage } from '../core/net.js'
import { makeScope, canSee, normalizeShareGroups } from '../domain/scope.js'
import { createStickerRepository, fail, hash, newStickerId } from './repository.js'
import { matchSticker, pickForReply, allowedForContext } from './selection.js'
import { modelAnalyzer, parseAnalysis } from './analysis.js'
import { quarantineLegacy } from './legacy.js'

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
  getPolicy, download = segmentBytes, fetch = fetchImage, analyze, autoStart = true, legacyDir } = {}) {
  const cfg = () => getConfig().stickers || {}
  const account = () => String(getConfig().botQQ || '')
  const policy = () => ({ shareGroups: normalizeShareGroups((getPolicy?.() || getConfig().mediaPolicy || getConfig().memory || {}).shareGroups || getConfig().shareGroups || []) })
  const limits = () => ({
    maxPerHour: clamp(cfg().maxPerHour, 20, 0, 200), maxLibrary: clamp(cfg().maxLibrary, 300, 1, 20000),
    maxQueued: clamp(cfg().maxQueued, 100, 1, 1000), concurrency: clamp(cfg().concurrency, 2, 1, 8),
  })
  const repo = createStickerRepository({ storage, now, limits })
  const analyzer = analyze || modelAnalyzer({ dsh, getConfig })
  let stopped = false
  let scheduled = false
  let timer = null
  const running = new Map()
  const controllers = new Set()
  const scopeOf = (o) => {
    const c = context(o)
    const a = String(c.accountId || account())
    if (!a || (account() && a !== account())) fail('WRONG_ACCOUNT', '账号范围与当前机器人不匹配')
    return makeScope({ account: a, chat: c.chatId, category: 'image' })
  }
  const admin = (o) => { if (context(o).admin !== true) fail('ADMIN_REQUIRED', '需要管理员权限') }
  const rawFind = (key, o) => {
    const c = context(o)
    const a = String(c.accountId || account())
    const matches = repo.find(a, String(key))
    if (c.admin && !c.chatId) return matches.find((it) => it.id === key) || (matches.length === 1 ? matches[0] : null)
    let viewer
    try { viewer = scopeOf(c) } catch { return null }
    return matches.find((it) => canSee(it.scope, viewer, policy())) || null
  }
  function managed(key, o) {
    admin(o)
    const it = rawFind(key, o)
    if (!it) fail('NOT_FOUND', '没有该范围内的表情，跨聊天同哈希请使用 id')
    return it
  }
  const assetOf = (it) => {
    const a = storage.assets.get(it.assetId)
    return a?.state === 'stored' && existsSync(storage.assets.pathOf(a)) ? a : null
  }
  const decorate = (it, viewer = it.scope) => ({ ...it, ...repo.usage(viewer, it.sha256), availability: assetOf(it) ? 'ready' : 'unavailable',
    qq: repo.qq(it.scope.account, it.sha256), emojiId: repo.qq(it.scope.account, it.sha256).emojiId || '' })
  function list(options = {}) {
    const c = context(options)
    if (c.status === 'quarantined') {
      admin(c)
      const entries = repo.db.all("SELECT body_json FROM sticker_legacy WHERE state='quarantined' ORDER BY created_at DESC").map((r) => JSON.parse(r.body_json))
      return paginate(entries, c)
    }
    let viewer
    if (!c.admin) { try { viewer = scopeOf(c) } catch { return { items: [], total: 0 } } }
    const a = String(c.accountId || account())
    const status = c.status || c.state
    let items = repo.all(c.admin && ['deleted', 'all'].includes(status)).filter((it) => it.scope.account === a && (c.admin ? (!c.chatId || it.scope.chat === c.chatId) : canSee(it.scope, viewer, policy())))
    if (status && status !== 'all') items = items.filter((it) => it.state === status)
    else if (status !== 'all' || !c.admin) items = items.filter((it) => it.state !== 'deleted' && (c.admin || it.state === 'approved'))
    if (!c.admin) items = items.filter((it) => it.state === 'approved')
    if (c.query) items = items.filter((it) => [it.name, it.description, it.ocr, ...it.tags].join(' ').toLowerCase().includes(String(c.query).toLowerCase()))
    return paginate(items.map((it) => decorate(it, viewer || it.scope)), c)
  }
  function paginate(items, c) {
    const offset = clamp(c.offset, 0, 0, 1000000)
    const limit = clamp(c.limit, 100, 1, 500)
    return { items: items.slice(offset, offset + limit), total: items.length, offset, limit }
  }
  const get = (key, o) => {
    const it = rawFind(key, o)
    return it && (context(o).admin || it.state === 'approved') ? decorate(it, context(o).chatId ? scopeOf(o) : it.scope) : null
  }
  const sourceValid = (it) => { try { validateSource(it.source); return true } catch { return false } }
  const deniedAtTarget = (it, viewer) => repo.find(viewer.account, it.sha256).some((local) =>
    local.scope.chat === viewer.chat && ['rejected', 'disabled', 'deleted'].includes(local.state))
  function available(o, { cooldown = false } = {}) {
    if (cfg().enabled === false) return []
    let viewer
    try { viewer = scopeOf(o) } catch { return [] }
    return repo.all().filter((it) => it.state === 'approved' && canSee(it.scope, viewer, policy()) && assetOf(it) && sourceValid(it) && !deniedAtTarget(it, viewer))
      .filter((it) => !cooldown || !repo.usage(viewer, it.sha256).lastUsed || now() - repo.usage(viewer, it.sha256).lastUsed >= clamp(cfg().cooldownMs, 60_000, 0, 86400_000))
  }
  function selectForReply(text, o, extra = {}) {
    const c = { ...context(o), ...extra }
    const options = { ...(cfg().selection || {}), intent: c.intent, mood: c.mood }
    const candidates = available(c, { cooldown: true }).filter((it) => allowedForContext(it, text, options))
    const item = pickForReply(candidates, text, options)
    return { decision: item ? 'match' : 'no_match', item: item ? decorate(item, scopeOf(c)) : null,
      reason: item ? '范围、审核、用途与冷却检查通过' : '没有相关且可用的表情', candidateIds: candidates.slice(0, 20).map((it) => it.id) }
  }
  function match(query, o) {
    const it = matchSticker(available(o), query)
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
      if (!canSee(current.scope, viewer, policy()) || deniedAtTarget(current, viewer)) return null
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
  function inspect(buf, automatic = false) {
    if (!Buffer.isBuffer(buf) || !buf.length || buf.length > (automatic ? 1.5 : 5) * 1024 * 1024) fail('INVALID_IMAGE', '图片为空或超过体积上限')
    const mime = mimeOf(buf)
    const size = imageSize(buf)
    if (!['image/png', 'image/gif', 'image/jpeg', 'image/webp', 'image/bmp'].includes(mime)) fail('INVALID_IMAGE', '不是支持的图片格式')
    if (automatic && !stickerSizeOk({ ...size, bytes: buf.length })) fail('INVALID_IMAGE', '尺寸不像表情')
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
    if (!m || m.recalledAt || m.account !== source.scope.account || m.chatId !== source.scope.chat || !seg || hash(JSON.stringify(seg)) !== source.segmentHash) fail('INVALID_SOURCE', '来源已撤回、修改或改变范围')
  }
  function analysisTask(it) {
    return repo.enqueue(it.scope, 'analyze', `${it.id}:${it.revision}`, { revision: it.revision,
      policyVersion: String(cfg().policyVersion || '1') }, it.id)
  }
  function scheduleAnalysis(it) {
    if (cfg().caption === false) return null
    try { return analysisTask(it) } catch (e) {
      repo.update(it.id, (current) => { current.analysis = { ...current.analysis, state: 'failed', error: e.message } })
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
      if (JSON.stringify(seg).length > 2.1 * 1024 * 1024) fail('INVALID_IMAGE', '媒体段过大')
      const source = sourceFor(seg, scope, options)
      const job = repo.db.tx(() => {
        const t = repo.enqueue(scope, 'collect', source.key, { source, automatic: true })
        repo.saveSource(scope, source.key, source)
        return t
      })
      kick()
      return { ok: true, queued: job.state === 'queued' || job.state === 'running', taskId: job.id, state: job.state, itemId: job.output?.itemId || null }
    })
  }
  async function addFromBuffer(buf, options = {}) {
    return safe(() => {
      const scope = scopeOf(options)
      const result = repo.ingest(buf, inspect(buf), scope, { ...options, tags: array(options.tags || []),
        editedFields: [...(String(options.name || '').trim() ? ['name'] : []), ...(options.tags?.length ? ['tags'] : [])], toQQ: options.toQQ !== false })
      if (!result.existed) scheduleAnalysis(result.item)
      kick()
      return { ...result, item: decorate(repo.get(result.item.id)), message: '本地已保存，待审核；QQ 收藏尚未确认' }
    })
  }

  function queueQQ(it, action = 'add') {
    return repo.db.tx(() => {
      if (!['add', 'rename', 'delete'].includes(action)) fail('INVALID_ACTION', '同步动作无效')
      if (action !== 'delete' && it.state !== 'approved') fail('NOT_APPROVED', '未批准的表情不能同步收藏')
      const q = repo.qq(it.scope.account, it.sha256)
      if (['queued', 'running', 'unknown'].includes(q.state)) {
        if (action === 'delete') repo.saveQQ(it.scope.account, it.sha256, { ...q, desired: 'absent' })
        return { ok: q.state !== 'unknown', state: q.state, taskId: q.taskId, reason: q.state === 'unknown' ? '上次同步结果未知，须先在 QQ 核对' : '已有同步任务' }
      }
      if (action === 'delete' && !q.emojiId) return { ok: true, state: q.state, reason: '没有已确认的 QQ 收藏 ID' }
      if (action === 'rename' && !q.emojiId) fail('NO_QQ_ID', '没有已确认的 QQ 收藏 ID，不能修改 QQ 备注')
      if (action === 'add' && q.emojiId && q.state === 'synced') {
        if (q.name === it.name) return { ok: true, state: 'synced', taskId: q.taskId }
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
      const allowed = ['name', 'tags', 'description', 'ocr', 'emotions', 'suitable', 'unsuitable']
      if (Object.keys(patch).some((key) => !allowed.includes(key))) fail('INVALID_INPUT', '只能编辑标签和描述证据')
      const saved = repo.update(it.id, (current) => {
        for (const [key, value] of Object.entries(patch)) {
          if (['tags', 'emotions', 'suitable', 'unsuitable'].includes(key)) current[key] = array(value, key)
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
        if (!assetOf(it)) fail('UNAVAILABLE', '原文件不可用，不能批准')
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
  async function remove(key, options = {}) {
    return safe(() => {
      const it = managed(key, options)
      const saved = it.state === 'deleted' ? it : repo.update(it.id, (current) => {
        current.state = 'deleted'
        current.deletedAt = now()
        current.review = { kind: 'manual', state: 'deleted', reason: String(options.reason || '管理员删除'), at: now() }
      }, options.expectedRevision)
      repo.db.run("UPDATE sticker_tasks SET state='canceled',error='素材已删除',updated_at=? WHERE item_id=? AND state='queued' AND kind!='sync'", now(), it.id)
      const shared = repo.all().some((x) => x.id !== it.id && x.scope.account === it.scope.account && x.sha256 === it.sha256 && x.state !== 'deleted')
      const sync = options.fromQQ !== false && !shared ? safe(() => queueQQ(saved, 'delete')) : { state: 'retained', reason: shared ? '其他范围仍引用相同 QQ 收藏' : '仅删除本地条目' }
      kick()
      return { ok: true, tombstone: true, item: decorate(saved), sync, message: '本地已删除并保留删除记录；QQ 收藏删除请查看同步状态' }
    })
  }
  function retryAnalysis(key, options = {}) {
    return safe(() => {
      const it = managed(key, options)
      if (it.state === 'deleted') fail('TOMBSTONED', '已删除')
      const active = ['queued', 'running'].map((state) => repo.tasks(it.scope.account, { itemId: it.id, kind: 'analyze', state, limit: 1 })[0]).find(Boolean)
      if (active) return { ok: true, taskId: active.id, state: active.state }
      const task = repo.db.tx(() => {
        const current = repo.update(it.id, (i) => { i.analysis = { ...i.analysis, state: 'pending', error: null } })
        return analysisTask(current)
      })
      kick()
      return { ok: true, taskId: task.id, state: task.state }
    })
  }
  function selectFrames(key, frames, options = {}) {
    return safe(() => {
      const it = managed(key, options)
      if (it.state === 'deleted') fail('TOMBSTONED', '已删除')
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
    validateSource(source)
    const buf = await download(source.segment, onebot, { maxBytes: 1.5 * 1024 * 1024, timeoutMs: 20000 })
    if (stopped) fail('STOPPED', '模块已停止')
    validateSource(source)
    repo.db.tx(() => {
      if (!repo.owns(t)) return
      const result = repo.ingest(buf, inspect(buf, true), source.scope, { automatic: true, source, from: source.scope.chat, toQQ: true })
      repo.finish(t, 'done', { output: { itemId: result.item.id, existed: result.existed, localSaved: true, qqSynced: false } })
      if (!result.existed) scheduleAnalysis(result.item)
    })
  }
  async function processAnalysis(t) {
    const it = repo.get(t.itemId)
    if (!it || it.state === 'deleted' || it.revision !== t.input.revision) return repo.finish(t, 'canceled', { error: '素材已更新或删除' })
    validateSource(it.source)
    if (it.animated && !it.frames.length) fail('NEEDS_FRAMES', '动画保留待审：请查看原文件并选择关键帧，不能只审核首帧')
    const inputAssets = it.animated ? it.frames.map((f) => storage.assets.get(f.assetId)) : [assetOf(it)]
    const images = inputAssets.map((a) => {
      if (!a || a.state !== 'stored') fail('UNAVAILABLE', '识别用图片不可用')
      return { data: readFileSync(storage.assets.pathOf(a)).toString('base64'), mediaType: a.mime }
    })
    const ctrl = new AbortController()
    controllers.add(ctrl)
    const timeout = setTimeout(() => {
      ctrl.abort(new Error('表情识别超时'))
      try { if (repo.owns(t)) repo.db.run('UPDATE sticker_tasks SET error=? WHERE id=?', '识别已超时，等待调用结束释放并发槽', t.id) } catch (e) { log?.warn?.('记录表情识别超时失败：', e.message) }
    }, clamp(cfg().analysisTimeoutMs, 60000, 10, 180000))
    timeout.unref?.()
    try {
      const result = parseAnalysis(await analyzer({ images, frames: it.frames, hint: it.source?.hint || '', animated: it.animated,
        policyVersion: t.input.policyVersion, signal: ctrl.signal }), t.input.policyVersion)
      ctrl.signal.throwIfAborted()
      validateSource(it.source)
      repo.db.tx(() => {
        const current = repo.get(it.id)
        if (!repo.owns(t)) return
        if (stopped || current.state === 'deleted' || current.revision !== t.input.revision || String(cfg().policyVersion || '1') !== t.input.policyVersion) {
          repo.finish(t, 'canceled', { error: '素材/规则已改变，忽略迟到识别结果' }); return
        }
        const saved = repo.update(it.id, (item) => {
          item.analysis = { state: 'done', error: null, evidence: { ...result, assetId: it.assetId,
            frames: it.frames, coverage: it.animated ? 'manual_partial' : 'still_image', at: now() } }
          for (const key of ['name', 'tags', 'description', 'ocr', 'emotions', 'suitable', 'unsuitable']) {
            if (!item.editedFields.includes(key)) item[key] = result[key]
          }
          if (item.state === 'pending' && item.review.kind !== 'manual' && cfg().autoReview === true && !it.animated && it.source?.messageId) {
            if (result.decision === 'approve') item.state = 'approved'
            if (result.decision === 'reject') item.state = 'rejected'
            item.review = { kind: 'model', decision: result.decision, reason: result.reason, policyVersion: t.input.policyVersion, at: now() }
          }
        })
        repo.finish(t, 'done', { output: { itemId: it.id, state: saved.state } })
        if (saved.state === 'approved' && saved.wantsQQ) safe(() => queueQQ(saved))
      })
    } finally { clearTimeout(timeout); controllers.delete(ctrl) }
  }
  async function processSync(t) {
    const it = repo.get(t.itemId)
    const q = repo.qq(t.accountId, t.input.sha256)
    const action = t.input.action
    if (q.taskId !== t.id || (action !== 'delete' && (it?.state !== 'approved' || q.desired === 'absent'))) {
      repo.db.tx(() => { repo.finish(t, 'canceled', { error: '本地状态已改变，未调用 QQ' }); if (q.taskId === t.id) repo.saveQQ(t.accountId, t.input.sha256, { ...q, state: q.emojiId ? 'synced' : 'idle', error: '本地状态已改变' }) })
      return
    }
    let actionName, params
    try {
      if (stopped || getConfig().dryRun || cfg().enabled === false) fail('NOT_SENT', '当前设置不允许 QQ 同步')
      if (!onebot?.call) fail('NOT_SENT', '没有 QQ 网关')
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
      if (latest.taskId !== t.id || (action !== 'delete' && (current?.state !== 'approved' || latest.desired === 'absent'))) {
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
        const state = t.kind === 'sync' ? 'unknown' : 'failed'
        repo.finish(t, state, { error: e?.message || String(e), outcome: t.kind === 'sync' ? 'unknown' : null })
        if (t.kind === 'sync') {
          const q = repo.qq(t.accountId, t.input.sha256)
          if (q.taskId === t.id) repo.saveQQ(t.accountId, t.input.sha256, { ...q, state: 'unknown', error: e.message })
        }
        const it = t.itemId && repo.get(t.itemId)
        if (t.kind === 'analyze' && it && it.state !== 'deleted' && it.revision === t.input.revision) repo.update(it.id, (i) => {
          i.analysis = { ...i.analysis, state: e.code === 'NEEDS_FRAMES' ? 'needs_frames' : 'failed', error: e.message }
        })
      })
      log?.warn?.('表情后台任务失败：', e?.message || String(e))
    }
  }
  async function tick() {
    if (stopped || cfg().enabled === false || !account()) return 0
    const started = []
    while (running.size < limits().concurrency) {
      const t = repo.claim(account(), { sync: !getConfig().dryRun })
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
    const page = repo.taskPage(account(), { ...options, limit: clamp(options.limit, 100, 1, 500), offset: clamp(options.offset, 0, 0, 1000000) })
    return { ...page, items: page.items.map(({ owner, input, ...t }) => ({ ...t, action: input.action,
      blockedReason: t.kind === 'sync' && t.state === 'queued' && getConfig().dryRun ? 'dry_run' : null })), running: running.size, limits: limits() }
  }
  function retryTask(taskId, options = {}) {
    return safe(() => {
      admin(options)
      const t = repo.task(taskId)
      if (!t || t.accountId !== account()) fail('NOT_FOUND', '没有这个任务')
      if (t.kind === 'analyze') return retryAnalysis(t.itemId, options)
      const retried = repo.db.tx(() => {
        const q = t.kind === 'sync' && repo.qq(t.accountId, t.input.sha256)
        if (q && q.taskId !== t.id) fail('STALE_TASK', '同步任务已被替代')
        const next = repo.retryTask(taskId)
        if (q) repo.saveQQ(t.accountId, t.input.sha256, { ...q, state: 'queued', error: null })
        return next
      })
      kick()
      return { ok: true, taskId: retried.id, state: retried.state }
    })
  }
  function reconcileSync(taskId, options = {}) {
    return safe(() => repo.db.tx(() => {
      admin(options)
      const t = repo.task(taskId)
      if (!t || t.accountId !== account() || t.kind !== 'sync' || t.state !== 'unknown') fail('NOT_RECONCILABLE', '只可核对结果未知的同步')
      const q = repo.qq(t.accountId, t.input.sha256)
      if (q.taskId !== t.id) fail('STALE_TASK', '同步任务已替代')
      if (options.confirmedNotApplied === true) {
        repo.db.run("UPDATE sticker_tasks SET state='failed',outcome='not_sent',error='管理员核对未执行',updated_at=? WHERE id=?", now(), t.id)
        repo.saveQQ(t.accountId, t.input.sha256, { ...q, state: 'failed', error: '管理员核对未执行' })
      } else if (options.confirmedApplied === true && (t.input.action === 'delete' || String(options.emojiId || q.emojiId).trim())) {
        repo.db.run("UPDATE sticker_tasks SET state='done',error=NULL,updated_at=? WHERE id=?", now(), t.id)
        repo.saveQQ(t.accountId, t.input.sha256, { ...q, state: t.input.action === 'delete' ? 'removed' : 'synced', emojiId: t.input.action === 'delete' ? '' : String(options.emojiId || q.emojiId), error: null, reconciled: true })
      } else fail('CONFIRMATION_REQUIRED', '需要明确核对结果；已收藏需提供 emojiId')
      return { ok: true, sync: repo.qq(t.accountId, t.input.sha256) }
    }))
  }
  async function importFromQQ(options = {}) {
    return safe(() => {
      admin(options)
      const scope = scopeOf(options)
      const task = repo.enqueue(scope, 'import', `qq:${scope.chat}:${Math.floor(now() / 60_000)}`, { limit: clamp(options.limit, limits().maxLibrary, 1, 500), scope })
      kick()
      return { ok: true, taskId: task.id, state: task.state, message: 'QQ 导入已排队；导入后仍需本地审核' }
    })
  }
  async function processImport(t) {
    const response = await onebot.call('fetch_custom_face', { count: t.input.limit }, { timeoutMs: 30000 })
    const entries = (Array.isArray(response) ? response : response?.data)
    if (!Array.isArray(entries)) fail('INVALID_RESPONSE', 'QQ 收藏列表格式无效')
    let added = 0, existed = 0, failed = 0
    for (const entry of entries.slice(0, t.input.limit)) {
      if (stopped) break
      try {
        const url = typeof entry === 'string' ? entry : entry?.url
        if (!/^https?:\/\//i.test(String(url))) fail('INVALID_SOURCE', 'QQ 收藏没有有效 URL')
        const buf = await fetch(url, { maxBytes: 5 * 1024 * 1024, allowLocal: false })
        const result = repo.ingest(buf, inspect(buf), t.input.scope, { from: 'qq', toQQ: false, tags: [] })
        if (result.existed) existed++
        else { added++; scheduleAnalysis(result.item) }
        // fetch_custom_face 证明属于 QQ 收藏；无 emoji ID 时不假造可操作的同步身份。
        if (entry?.emoji_id) repo.saveQQ(t.accountId, result.item.sha256, { state: 'synced', emojiId: String(entry.emoji_id), name: '', taskId: null, error: null, source: 'qq_import' })
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
      const result = repo.ingest(buf, inspect(buf), scopeOf(options), { from: 'legacy', name: String(legacy.legacy.name || ''), tags: array(legacy.legacy.tags || []), toQQ: false })
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
    const result = { total: 0, pending: 0, approved: 0, rejected: 0, disabled: 0, deleted: 0 }
    let viewer
    if (!c.admin) { try { viewer = scopeOf(c) } catch { return result } }
    for (const it of repo.all(true)) {
      if (it.scope.account !== String(c.accountId || account()) || (c.admin ? c.chatId && it.scope.chat !== c.chatId : it.state !== 'approved' || !canSee(it.scope, viewer, policy()))) continue
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
    selectFrames, retryAnalysis, queueSync, sync: queueSync, queueStatus, retryTask, reconcileSync, importFromQQ, importLegacy, assignLegacy, deleteLegacy, legacyReport,
    trim: () => ({ ok: true, removed: 0, message: '达到上限后停止接收，不自动删除已审核素材' }),
    tick, drain, start, stop, recover }
}

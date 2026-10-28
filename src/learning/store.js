import { randomUUID } from 'node:crypto'
import { scopeOf, scopeKey, kindOf, text, fail, hash, STATUSES, MEANING_STATES, settings, unsafeReason, termMatches } from './contracts.js'
import { requireEvidence, readEvidence } from './evidence.js'
import { ensureSchema } from './schema.js'
import { visible, readableChats } from './visibility.js'

export function createLearningStore({ storage, getConfig = () => ({}), now = Date.now }) {
  if (!storage?.db || !storage?.messages) fail('STORAGE_REQUIRED', '学习模块需要 api.core.storage')
  const { db } = storage, deps = { getConfig, now }
  ensureSchema(db)
  const evidenceRows = (id) => db.all('SELECT * FROM wp6_learning_evidence WHERE record_id=? ORDER BY at DESC,message_id', id)
  function row(id, scope) {
    const r = db.get('SELECT * FROM wp6_learning_records WHERE id=? AND scope_key=?', id, scopeKey(scope))
    if (!r) fail('NOT_FOUND', '当前范围内没有这个学习条目')
    return r
  }
  function view(r) {
    const evidence = evidenceRows(r.id)
    return { id: r.id, scope: { account: r.account_id, chat: r.chat_id, persona: r.persona_id }, kind: r.kind, ...JSON.parse(r.data_json),
      status: r.status, manual: Boolean(r.manual_lock), revision: r.revision, createdAt: r.created_at, updatedAt: r.updated_at,
      expiresAt: r.expires_at, lastUsedAt: r.last_used_at, uses: r.uses, invalidReason: r.invalid_reason,
      evidenceMessageIds: evidence.map((e) => e.message_id), evidenceCount: evidence.length, authorCount: new Set(evidence.map((e) => e.author_id)).size }
  }
  function audit(r, action, actor, note = '') {
    db.run('INSERT INTO wp6_learning_audit(record_id,scope_key,action,actor_id,revision,at,note) VALUES (?,?,?,?,?,?,?)', r.id, r.scope_key, action, String(actor), r.revision, now(), String(note).slice(0, 200))
    db.run('DELETE FROM wp6_learning_audit WHERE record_id=? AND id NOT IN (SELECT id FROM wp6_learning_audit WHERE record_id=? ORDER BY id DESC LIMIT 50)', r.id, r.id)
    db.run('INSERT OR REPLACE INTO wp6_learning_versions(record_id,revision,snapshot_json) VALUES (?,?,?)', r.id, r.revision,
      JSON.stringify({ data: JSON.parse(r.data_json), status: r.status, evidence: evidenceRows(r.id).map((e) => ({ id: e.message_id, fingerprint: e.fingerprint })) }))
    db.run('DELETE FROM wp6_learning_versions WHERE record_id=? AND revision NOT IN (SELECT revision FROM wp6_learning_audit WHERE record_id=?)', r.id, r.id)
  }
  function validate(kind, value, evidence) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', '条目必须是对象')
    let data
    if (kind === 'expression') data = { situation: text(value.situation, 160, '适用情境'), expression: text(value.expression, 160, '表达形式') }
    else {
      const meaningState = value.meaningState || 'uncertain'
      if (!MEANING_STATES.includes(meaningState)) fail('INVALID_INPUT', '黑话释义状态不合法')
      const aliases = value.aliases === undefined ? [] : value.aliases
      if (!Array.isArray(aliases) || aliases.length > 8) fail('INVALID_INPUT', '词形别名最多 8 个')
      data = { term: text(value.term, 40, '词条'), aliases: [...new Set(aliases.map((a) => text(a, 40, '别名')))],
        meaning: text(value.meaning, 300, '候选含义', { optional: meaningState === 'unknown' || meaningState === 'rejected' }), meaningState }
    }
    const reason = unsafeReason(Object.values(data).flat().join(' '))
    if (reason) fail('CONTENT_REJECTED', reason)
    const variants = kind === 'expression' ? [data.expression] : [data.term, ...data.aliases]
    if (!evidence.some((e) => variants.some((v) => termMatches(v, e.text)))) fail('EVIDENCE_MISMATCH', '词形/表达必须实际出现在引用消息里，不能凭空生成')
    const confidence = value.confidence === undefined ? 0 : value.confidence
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) fail('INVALID_INPUT', 'confidence 必须在 0 到 1 之间')
    return { ...data, confidence }
  }
  function calibrate(kind, data, evidence) {
    const variants = kind === 'expression' ? [data.expression] : [data.term, ...data.aliases]
    const direct = evidence.filter((e) => variants.some((v) => termMatches(v, e.text))), c = settings(getConfig())
    if (new Set(direct.map((e) => e.spamKey)).size < c.minEvidence || new Set(direct.map((e) => e.authorId)).size < c.minAuthors) {
      data = { ...data, confidence: Math.min(0.5, data.confidence) }
      if (kind === 'jargon' && data.meaningState === 'confirmed') data.meaningState = 'uncertain'
    }
    return data
  }
  const keyOf = (kind, data) => kind === 'jargon' ? data.term.normalize('NFKC').toLowerCase() : hash(data.expression.normalize('NFKC'))
  function addEvidence(r, evidence) {
    let changed = 0
    for (const e of evidence) changed += Number(db.run(`INSERT INTO wp6_learning_evidence(record_id,message_id,fingerprint,author_id,spam_key,at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(record_id,message_id) DO UPDATE SET fingerprint=excluded.fingerprint,author_id=excluded.author_id,spam_key=excluded.spam_key,at=excluded.at
      WHERE fingerprint!=excluded.fingerprint`, r.id, e.id, e.fingerprint, e.authorId, e.spamKey, e.receivedAt).changes)
    const max = settings(getConfig()).maxEvidencePerItem
    db.run('DELETE FROM wp6_learning_evidence WHERE record_id=? AND message_id NOT IN (SELECT message_id FROM wp6_learning_evidence WHERE record_id=? ORDER BY at DESC,message_id LIMIT ?)', r.id, r.id, max)
    return changed
  }
  function upsert(input, kind, value, { automatic = false, actorId = 'owner-panel' } = {}) {
    const scope = scopeOf(input), c = settings(getConfig()); kindOf(kind)
    const evidence = requireEvidence(storage, scope, value?.evidenceMessageIds, deps, c.maxEvidencePerItem)
    const data = validate(kind, value, evidence), key = keyOf(kind, data)
    refresh(scope)
    return db.tx(() => {
      let r = db.get('SELECT * FROM wp6_learning_records WHERE scope_key=? AND kind=? AND item_key=?', scopeKey(scope), kind, key)
      if (r) {
        // 自动观察永不覆盖人工内容/批准/停用/删除；删除保留指纹墓碑，不重新收集证据。
        if (r.status === 'deleted') return view(r)
        const changed = addEvidence(r, evidence)
        if (!automatic || (!r.manual_lock && r.status === 'pending')) {
          if (!automatic && r.manual_lock) fail('DUPLICATE', '已有人工条目，请使用带版本的编辑接口')
          const nextData = automatic ? calibrate(kind, data, evidenceRows(r.id).map((e) => readEvidence(storage, scope, e.message_id, deps)).filter(Boolean)) : data
          db.run('UPDATE wp6_learning_records SET data_json=?,updated_at=?,revision=revision+1,expires_at=?,invalid_reason=? WHERE id=?', JSON.stringify(nextData), now(), now() + c.maxAgeDays * 86400000, '', r.id)
          r = row(r.id, scope); audit(r, 'observe', automatic ? 'model' : actorId)
        } else if (changed) {
          db.run('UPDATE wp6_learning_records SET revision=revision+1,updated_at=? WHERE id=?', now(), r.id)
          audit(row(r.id, scope), 'evidence', 'model')
        }
        return view(row(r.id, scope))
      }
      if (Number(db.get('SELECT COUNT(*) AS n FROM wp6_learning_records WHERE scope_key=? AND kind=?', scopeKey(scope), kind).n) >= c.maxItemsPerScope) fail('CAPACITY', '当前范围条目（含删除墓碑）达到数量上限，请调整数量上限')
      const id = randomUUID()
      db.run(`INSERT INTO wp6_learning_records(id,scope_key,account_id,chat_id,persona_id,kind,item_key,data_json,status,manual_lock,created_at,updated_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, scopeKey(scope), scope.account, scope.chat, scope.persona, kind, key, JSON.stringify(automatic ? calibrate(kind, data, evidence) : data), 'pending', automatic ? 0 : 1, now(), now(), now() + c.maxAgeDays * 86400000)
      r = row(id, scope); addEvidence(r, evidence); audit(r, 'create', automatic ? 'model' : actorId)
      return view(r)
    })
  }
  function refresh(input) {
    const scope = scopeOf(input)
    return db.tx(() => {
      let changed = 0
      for (const r of db.all('SELECT * FROM wp6_learning_records WHERE scope_key=?', scopeKey(scope))) {
        const sources = evidenceRows(r.id)
        let invalid = r.expires_at <= now() || sources.length === 0
        for (const e of sources) {
          if (readEvidence(storage, scope, e.message_id, deps)?.fingerprint !== e.fingerprint) {
            db.run('DELETE FROM wp6_learning_evidence WHERE record_id=? AND message_id=?', r.id, e.message_id)
            invalid = true
          }
        }
        if (invalid && !r.invalid_reason) {
          db.run("UPDATE wp6_learning_records SET status=CASE WHEN status='deleted' THEN status ELSE 'disabled' END,invalid_reason='证据删除、修改、过期或权限收窄，需要重新审核',revision=revision+1,updated_at=? WHERE id=?", now(), r.id)
          audit(row(r.id, scope), 'invalidate', 'system'); changed++
        }
      }
      return changed
    })
  }
  function get(input, id) { const scope = scopeOf(input); refresh(scope); return view(row(id, scope)) }
  function list(input, { kind, status, limit = 100, includeDeleted = false, includeShared = false } = {}) {
    const scope = scopeOf(input); refresh(scope)
    if (kind !== undefined) kindOf(kind)
    if (status !== undefined && !STATUSES.includes(status)) fail('INVALID_STATUS', '学习状态不合法')
    const count = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 100)))
    const own = db.all('SELECT * FROM wp6_learning_records WHERE scope_key=? ORDER BY updated_at DESC,id', scopeKey(scope))
      .filter((r) => (!kind || r.kind === kind) && (!status || r.status === status) && (includeDeleted || status === 'deleted' || r.status !== 'deleted')).slice(0, count).map(view)
    if (!includeShared || (status && status !== 'approved') || own.length >= count) return own
    return [...own, ...readable(scope, { kind, limit: 1000 }).filter((r) => r.readOnly)].slice(0, count)
  }
  function readable(input, { kind, limit = 1000 } = {}) {
    const viewer = scopeOf(input), cfg = getConfig(), c = settings(cfg)
    if (kind !== undefined) kindOf(kind)
    // 固定 SQL + JSON 集合避免大量共享群造成参数或拼接边界；候选总数也有上限。
    const rows = db.all(`SELECT * FROM wp6_learning_records WHERE account_id=? AND status='approved' AND expires_at>? AND invalid_reason=''
      AND ((kind='expression' AND persona_id=? AND chat_id IN (SELECT value FROM json_each(?)))
        OR (kind='jargon' AND chat_id IN (SELECT value FROM json_each(?))))
      ORDER BY CASE WHEN scope_key=? THEN 0 WHEN chat_id=? THEN 1 ELSE 2 END,updated_at DESC,id LIMIT 1000`,
    viewer.account, now(), viewer.persona,
    JSON.stringify(kind && kind !== 'expression' ? [] : readableChats(viewer, 'expression', cfg)),
    JSON.stringify(kind && kind !== 'jargon' ? [] : readableChats(viewer, 'jargon', cfg)), scopeKey(viewer), viewer.chat)
    const items = []
    for (const r of rows) {
      const origin = { account: r.account_id, chat: r.chat_id, persona: r.persona_id }
      if (!visible(origin, viewer, r.kind, cfg)) continue
      const evidence = evidenceRows(r.id)
      // 验完整交集，不能只取仍可见的子集来替整条派生内容背书。readEvidence 还核对消息的实际账号/聊天。
      if (!evidence.length || evidence.length > c.maxEvidencePerItem || evidence.some((e) => {
        const current = readEvidence(storage, origin, e.message_id, deps)
        return !current || current.fingerprint !== e.fingerprint || !visible(origin, viewer, r.kind, cfg)
      })) continue
      const item = view(r), readOnly = scopeKey(origin) !== scopeKey(viewer)
      if (readOnly) {
        const usage = db.get('SELECT last_used_at,uses FROM wp6_learning_shared_usage WHERE record_id=? AND viewer_scope=?', r.id, scopeKey(viewer))
        // 共享派生结果不附带私聊原文、作者或消息 ID；来源面板与修改仍要求拥有原 scope。
        item.evidenceMessageIds = []
        item.lastUsedAt = usage?.last_used_at || 0; item.uses = usage?.uses || 0
      }
      items.push({ ...item, readOnly })
      if (items.length >= Math.max(1, Math.min(1000, Math.floor(Number(limit) || 1000)))) break
    }
    return items
  }
  const revision = (r, expected) => { if (!Number.isSafeInteger(expected) || expected !== r.revision) fail('REVISION_CONFLICT', '请提供最新 expectedRevision，避免覆盖他人的审核') }
  function update(input, id, patch, { expectedRevision, actorId = 'owner-panel' } = {}) {
    const scope = scopeOf(input); refresh(scope)
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('INVALID_INPUT', 'patch 必须是对象')
    return db.tx(() => {
      const r = row(id, scope); revision(r, expectedRevision)
      if (r.status === 'deleted') fail('DELETED', '删除项不能直接编辑，请先恢复到待审核')
      const current = view(r), evidence = requireEvidence(storage, scope, patch.evidenceMessageIds || current.evidenceMessageIds, deps, settings(getConfig()).maxEvidencePerItem)
      const data = validate(r.kind, { ...current, ...patch }, evidence)
      if (keyOf(r.kind, data) !== r.item_key) fail('INVALID_INPUT', '词形/表达是条目标识，请新建条目，不能借编辑覆盖其他词条')
      if (patch.evidenceMessageIds) db.run('DELETE FROM wp6_learning_evidence WHERE record_id=?', id)
      addEvidence(r, evidence)
      db.run("UPDATE wp6_learning_records SET data_json=?,status=CASE WHEN status='disabled' THEN 'disabled' ELSE 'pending' END,manual_lock=1,revision=revision+1,updated_at=?,expires_at=?,invalid_reason='' WHERE id=?", JSON.stringify(data), now(), now() + settings(getConfig()).maxAgeDays * 86400000, id)
      const next = row(id, scope); audit(next, 'edit', actorId)
      return view(next)
    })
  }
  function transition(input, id, status, { expectedRevision, actorId = 'owner-panel' } = {}) {
    const scope = scopeOf(input); refresh(scope)
    if (!STATUSES.includes(status)) fail('INVALID_STATUS', '学习状态不合法')
    return db.tx(() => {
      const r = row(id, scope); revision(r, expectedRevision)
      if (r.status === 'deleted' && status !== 'pending') fail('DELETED', '删除项只能显式恢复为待审核')
      if (status === 'approved') {
        if (r.invalid_reason || r.expires_at <= now()) fail('EVIDENCE_INVALID', '请补充有效证据并重新编辑后审核')
        const item = view(r), evidence = requireEvidence(storage, scope, item.evidenceMessageIds, deps, settings(getConfig()).maxEvidencePerItem)
        validate(r.kind, item, evidence)
        if (r.kind === 'jargon' && !['uncertain', 'confirmed'].includes(item.meaningState)) fail('MEANING_UNKNOWN', '无有效释义或已拒绝的词条不能批准使用')
      }
      db.run('UPDATE wp6_learning_records SET status=?,manual_lock=1,revision=revision+1,updated_at=? WHERE id=?', status, now(), id)
      if (status === 'deleted') {
        db.run('DELETE FROM wp6_learning_uses WHERE record_id=?', id)
        db.run('DELETE FROM wp6_learning_shared_usage WHERE record_id=?', id)
      }
      const next = row(id, scope); audit(next, status, actorId)
      return view(next)
    })
  }
  function evidence(input, id) {
    const scope = scopeOf(input); refresh(scope); row(id, scope)
    return evidenceRows(id).map((e) => readEvidence(storage, scope, e.message_id, deps)).filter(Boolean)
  }
  function history(input, id) {
    const scope = scopeOf(input); row(id, scope)
    return db.all('SELECT action,actor_id AS actorId,revision,at,note FROM wp6_learning_audit WHERE scope_key=? AND record_id=? ORDER BY id DESC LIMIT 50', scopeKey(scope), id)
  }
  function removeEvidence(input, id, messageId, { expectedRevision, actorId = 'owner-panel' } = {}) {
    const scope = scopeOf(input); refresh(scope)
    return db.tx(() => {
      const r = row(id, scope); revision(r, expectedRevision)
      if (r.status === 'deleted') fail('DELETED', '删除项请先恢复到待审核')
      if (!db.run('DELETE FROM wp6_learning_evidence WHERE record_id=? AND message_id=?', id, String(messageId)).changes) fail('NOT_FOUND', '该条目没有此来源')
      db.run("UPDATE wp6_learning_records SET status='disabled',manual_lock=1,invalid_reason='来源已由管理员移除，需要重新编辑并审核',revision=revision+1,updated_at=? WHERE id=?", now(), id)
      const next = row(id, scope); audit(next, 'remove-evidence', actorId)
      return view(next)
    })
  }
  function revert(input, id, targetRevision, { expectedRevision, actorId = 'owner-panel' } = {}) {
    const scope = scopeOf(input); refresh(scope)
    return db.tx(() => {
      const r = row(id, scope); revision(r, expectedRevision)
      if (!Number.isSafeInteger(targetRevision)) fail('INVALID_INPUT', 'targetRevision 必须为整数')
      const old = db.get('SELECT snapshot_json FROM wp6_learning_versions WHERE record_id=? AND revision=?', id, targetRevision)
      if (!old) fail('NOT_FOUND', '该解释版本已超出保留的 50 次变更')
      const snapshot = JSON.parse(old.snapshot_json), evidence = requireEvidence(storage, scope, snapshot.evidence.map((e) => e.id), deps, settings(getConfig()).maxEvidencePerItem)
      if (evidence.some((e) => snapshot.evidence.find((v) => v.id === e.id)?.fingerprint !== e.fingerprint)) fail('EVIDENCE_INVALID', '旧版本证据已改变，不能直接回滚')
      const data = validate(r.kind, snapshot.data, evidence)
      db.run('DELETE FROM wp6_learning_evidence WHERE record_id=?', id); addEvidence(r, evidence)
      db.run("UPDATE wp6_learning_records SET data_json=?,status='pending',manual_lock=1,revision=revision+1,updated_at=?,expires_at=?,invalid_reason='' WHERE id=?", JSON.stringify(data), now(), now() + settings(getConfig()).maxAgeDays * 86400000, id)
      const next = row(id, scope); audit(next, 'revert', actorId, `恢复版本 ${targetRevision}，仍需审核`)
      return view(next)
    })
  }
  return { db, get, list, readable, upsert, update, transition, refresh, evidence, history, revert, removeEvidence }
}

import { randomUUID } from 'node:crypto'
import { ensureSchema } from './schema.js'
import { canonical, hash, scopeOf, scopeKey, sameScope, visible, owned, fail, receipt } from './scope.js'
import { normalizeFact, factFingerprint, reusable, validateDecisions, ids, string, exactKeys, FACT_FIELDS } from './contracts.js'
import { similarity } from './lexical.js'
import {createFactQueries,readContext,deletionKey} from './query.js'

const decode = row => row ? JSON.parse(row.body) : null
const clone = value => JSON.parse(JSON.stringify(value))
const id = prefix => `${prefix}_${randomUUID()}`
export function createFactRepository({ storage, getPolicy = () => ({}), now = Date.now }) {
  ensureSchema(storage)
  const db = storage.db
  const policy = () => clone(getPolicy() || {})
  const policyStamp = () => hash(policy())
  const raw = (factId,read) => read ? read.facts.get(factId) || null : decode(db.get('SELECT body FROM memory_facts WHERE id=?', factId))
  const evidenceRaw = (evidenceId,read) => read ? read.evidence.get(evidenceId) || null : decode(db.get('SELECT body FROM memory_evidence WHERE id=?', evidenceId))
  const sourceIds = (factId,read) => read ? read.sources.get(factId) || [] : db.all('SELECT evidence_id FROM memory_fact_evidence WHERE fact_id=? ORDER BY evidence_id', factId).map(r => r.evidence_id)
  const tombstone = (kind, key, scope,read) => read ? read.tombstones.get(deletionKey(kind,key,scope)) || null : ['message','fingerprint'].includes(kind)
    ? decode(db.get('SELECT body FROM memory_tombstones WHERE kind=? AND key=? AND account=? AND chat=? ORDER BY deleted_at DESC,rowid DESC LIMIT 1',kind,key,scope.account,scope.chat))
    : decode(db.get('SELECT body FROM memory_tombstones WHERE kind=? AND key=? AND account=? AND chat=? AND persona=?', kind, key, scope.account, scope.chat, scope.persona))
  const revision = s => Number(db.get('SELECT revision FROM memory_scope_revisions WHERE scope_key=?', scopeKey(s))?.revision || 0)
  function touch(s, changed = {}) {
    db.run('INSERT INTO memory_scope_revisions(scope_key,revision) VALUES (?,1) ON CONFLICT(scope_key) DO UPDATE SET revision=revision+1', scopeKey(s))
    // Invalidate only affected people/audiences. Unrelated writes must not force
    // another model call for an unchanged input. Reads still verify fingerprints.
    const rows = changed.subject ? db.all('SELECT * FROM memory_profiles WHERE subject=?',changed.subject) : db.all('SELECT * FROM memory_profiles')
    const affected = changed.evidenceId ? new Set(db.all('SELECT fact_id FROM memory_fact_evidence WHERE evidence_id=?',changed.evidenceId).map(r=>r.fact_id)) : null
    for (const row of rows) {
      const viewer=JSON.parse(row.scope_key), profile=JSON.parse(row.body)
      const refs=Object.values(profile.sections).flat().flatMap(e=>e.factIds)
      const depends=changed.factId ? refs.includes(changed.factId) : affected ? refs.some(id=>affected.has(id)) : false
      const audience=visible(s,viewer,policy(),'profile') && visible(s,viewer,policy(),'fact')
      if (depends || (!affected && audience && (!changed.onlyOwn || sameScope(s,viewer)))) db.run('DELETE FROM memory_profiles WHERE scope_key=? AND subject=?',row.scope_key,row.subject)
    }
  }
  function audit(f, action, before, after, meta = {}) {
    const record = { action, before, after, actorId: meta.actorId || null, reason: meta.reason || '', evidenceMessageIds: meta.evidenceMessageIds || [], at: now(), relatedIds: meta.relatedIds || [] }
    db.run('INSERT INTO memory_audit(fact_id,account,chat,persona,at,body) VALUES (?,?,?,?,?,?)', f.id, f.scope.account, f.scope.chat, f.scope.persona, record.at, JSON.stringify(record))
  }
  function save(f) {
    db.run(`INSERT INTO memory_facts(id,account,chat,persona,category,body,revision,status,fingerprint,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET account=excluded.account,chat=excluded.chat,persona=excluded.persona,
      category=excluded.category,body=excluded.body,revision=excluded.revision,status=excluded.status,fingerprint=excluded.fingerprint,updated_at=excluded.updated_at`,
    f.id, f.scope.account, f.scope.chat, f.scope.persona, f.category, JSON.stringify(f), f.revision, f.status, factFingerprint(f), f.createdAt, f.updatedAt)
    touch(f.scope,{subject:f.subject,factId:f.id})
  }
  function saveEvidence(e) {
    db.run(`INSERT INTO memory_evidence(id,account,chat,persona,message_id,body,revision,deleted_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET body=excluded.body,revision=excluded.revision,deleted_at=excluded.deleted_at`,
    e.id, e.scope.account, e.scope.chat, e.scope.persona, e.messageId, JSON.stringify(e), e.revision, e.deletedAt ?? null)
    touch(e.scope,{evidenceId:e.id})
  }
  function markDeleted(kind, key, s, meta) {
    const t = { kind, key, token: id('deletion'), deletedAt: now(), actorId: meta.actorId, reason: meta.reason }
    db.run(`INSERT INTO memory_tombstones(kind,key,account,chat,persona,deleted_at,body) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(kind,key,account,chat,persona) DO UPDATE SET deleted_at=excluded.deleted_at,body=excluded.body`,
    kind, key, s.account, s.chat, s.persona, t.deletedAt, JSON.stringify(t))
    return t
  }
  const messageSnapshot = m => ({ id: m.id, account: m.account, chatId: m.chatId, authorId: m.authorId, authorName: m.authorName,
    text: m.text, eventKind: m.eventKind, platformMsgId: m.platformMsgId, platformTime: m.platformTime,
    receivedAt: m.receivedAt, recvSeq: m.recvSeq, segments: m.segments, replyTo: m.replyTo, forwards: m.forwards, recalledAt: m.recalledAt })
  function messageEvidence(messageId, scope) {
    const m = storage.messages.get(string(messageId, 'messageId', 200))
    if (!m || m.account !== scope.account || m.chatId !== scope.chat) fail('INVALID_EVIDENCE', '消息证据不属于指定账号/聊天')
    if (m.recalledAt || tombstone('message', m.id, scope)) fail('TOMBSTONED', '消息已撤回或删除')
    if (m.eventKind !== 'message' || m.authorId === scope.account) fail('INVALID_EVIDENCE', '机器人回复、工具输出不能当作用户事实证据')
    const snapshot = messageSnapshot(m)
    const prior = decode(db.get('SELECT body FROM memory_evidence WHERE account=? AND chat=? AND persona=? AND message_id=?', scope.account, scope.chat, scope.persona, m.id))
    if (prior) {
      if (prior.deletedAt || tombstone('evidence', prior.id, scope)) fail('TOMBSTONED', '证据已删除')
      if (prior.contentHash !== hash(snapshot)) fail('STALE_EVIDENCE', '来源内容已修改，须先刷新并复核证据')
      return prior
    }
    const e = receipt({ id: id('evidence'), kind: 'message', messageId: m.id, speakerId: m.authorId, text: m.text,
      eventTime: m.platformTime ?? m.receivedAt, receivedAt: m.receivedAt, recvSeq: m.recvSeq, snapshot,
      contentHash: hash(snapshot), revision: 1, createdAt: now() }, scope)
    saveEvidence(e)
    return e
  }
  function manualEvidence(input, scope) {
    exactKeys(input, ['kind','text','speakerId','actorId','sourceId','confirmed','eventTime'], 'manualEvidence')
    const kind = input.kind || 'manual'
    if (!['manual','event'].includes(kind)) fail('INVALID_EVIDENCE', '手工证据类型无效')
    const actorId = string(input.actorId, 'evidence.actorId', 200)
    if (kind === 'event' && (input.confirmed !== true || !input.sourceId)) fail('INVALID_EVIDENCE', '角色经历需已确认回执和 sourceId')
    const eventTime = input.eventTime ?? now()
    if (!Number.isSafeInteger(eventTime) || eventTime < 0) fail('INVALID_EVIDENCE', '证据时间无效')
    const body = { kind, text: string(input.text, 'evidence.text', 16000), speakerId: string(input.speakerId, 'evidence.speakerId', 200), actorId,
      sourceId: input.sourceId ? string(input.sourceId, 'sourceId', 200) : null, confirmed: input.confirmed === true, eventTime }
    const evidenceId = body.sourceId ? 'evidence_' + hash({ scope, kind, sourceId: body.sourceId }) : id('evidence')
    if (tombstone('evidence', evidenceId, scope)) fail('TOMBSTONED', '来源已删除')
    const existing = evidenceRaw(evidenceId)
    if (existing) {
      if (existing.contentHash !== hash(body)) fail('SOURCE_CONFLICT', '同一来源回执内容不一致')
      return existing
    }
    const e = receipt({ ...body, id: evidenceId, messageId: null, revision: 1, contentHash: hash(body), createdAt: now() }, scope)
    saveEvidence(e)
    return e
  }
  function liveEvidence(e,read) {
    if (!e || e.deletedAt) return false
    const evidenceDeletion = tombstone('evidence',e.id,e.scope,read)
    if (evidenceDeletion && !e.restoreApproval?.tokens?.includes(evidenceDeletion.token)) return false
    if (!e.messageId) return true
    const messageDeletion = tombstone('message',e.messageId,e.scope,read)
    if (messageDeletion && !e.restoreApproval?.tokens?.includes(messageDeletion.token)) return false
    const current = read ? read.messages.get(e.messageId) : storage.messages.get(e.messageId)
    return !!current && !current.recalledAt && hash(messageSnapshot(current)) === e.contentHash
  }
  function evidenceFor(f, viewer, p = policy(),read) {
    const entries = sourceIds(f.id,read).map(id=>evidenceRaw(id,read))
    // Intersect every source audience; do not reveal a mixed private/public derivation.
    if (!entries.length || entries.some(e => !liveEvidence(e,read) || !visible(e.scope, viewer, p, f.category))) return null
    return entries
  }
  function activeAt(f, at = now()) {
    return f.status === 'active' && (f.validFrom === null || f.validFrom <= at) && (f.validTo === null || f.validTo > at)
  }
  function canRead(f, viewer, { includeInactive = false, at = now(), policy: p = policy(),read } = {}) {
    if (!f || ['deleted','quarantined'].includes(f.status) || !visible(f.scope, viewer, p, f.category)) return false
    const deletion = tombstone('fact', f.id, f.scope,read)
    if (deletion && f.restoreApproval?.token !== deletion.token) return false
    const forgotten=[tombstone('fingerprint',factFingerprint(f),f.scope,read),tombstone('fingerprint',factFingerprint(f),viewer,read)].filter(Boolean)
    if(forgotten.some(t=>!f.restoreApproval?.fingerprintTokens?.includes(t.token))) return false
    if (!includeInactive && !activeAt(f, at)) return false
    return !!evidenceFor(f, viewer, p,read)
  }
  function materialize(f, viewer, p = policy(),read) {
    const evidence = evidenceFor(f, viewer, p,read)
    if (!evidence) return null
    const result = { ...clone(f), about: f.subject, at: f.eventTime ?? f.createdAt, evidence,
      validity:f.validTo !== null && f.validTo <= now() ? 'expired' : f.validFrom !== null && f.validFrom > now() ? 'future' : 'current',
      evidenceIds: evidence.map(e => e.id), evidenceMessageIds: evidence.map(e => e.messageId).filter(Boolean),
      sources: evidence.map(e => ({ id: e.id, messageId: e.messageId, speakerId: e.speakerId, date: e.eventTime, scope: e.scope, kind: e.kind })) }
    for(const key of ['possibleDuplicates','conflicts','supersedes']) if(result[key]) result[key]=result[key].filter(id=>canRead(raw(id,read),viewer,{includeInactive:true,policy:p,read}))
    if(result.supersededBy && !canRead(raw(result.supersededBy,read),viewer,{includeInactive:true,policy:p,read})) delete result.supersededBy
    return result
  }
  const queries=createFactQueries({db,now,policy,visibilityStamp,revision,canRead,materialize})
  const list=(scope,options={})=>queries.list(scope,options)
  function get(factId, scopeInput, options = {}) {
    const scope = scopeOf(scopeInput), f = raw(factId)
    if(!f || f.scope.account!==scope.account) return null
    const read=readContext(db,[f],scope),p=policy()
    return canRead(f, scope, {...options,policy:p,read}) ? materialize(f, scope,p,read) : null
  }
  function getMany(factIds,scopeInput,options={}) {
    const scope=scopeOf(scopeInput),checked=ids(factIds,'factIds',true)
    if(!checked.length) return []
    const facts=db.all(`SELECT body FROM memory_facts WHERE account=? AND id IN (${checked.map(()=>'?').join(',')})`,scope.account,...checked).map(decode)
    const read=readContext(db,facts,scope),p=policy()
    return checked.map(id=>read.facts.get(id)).filter(f=>canRead(f,scope,{...options,policy:p,read})).map(f=>materialize(f,scope,p,read))
  }
  function ownedFact(factId, scopeInput) {
    const scope = scopeOf(scopeInput), f = raw(string(factId, 'factId', 200))
    if (!f) fail('NOT_FOUND', '当前范围没有这条记录')
    owned(f.scope, scope)
    return f
  }
  function requireMeta(meta) {
    return { ...meta, actorId: string(meta?.actorId, 'actorId', 200), reason: string(meta?.reason, 'reason', 2000) }
  }
  function collectEvidence(input, scope, speakerId) {
    const evidence = []
    for (const mid of ids(input.evidenceMessageIds || [], 'evidenceMessageIds', true)) evidence.push(messageEvidence(mid, scope))
    for (const eid of ids(input.evidenceIds || [], 'evidenceIds', true)) {
      const e = evidenceRaw(eid)
      if (!e || !visible(e.scope,scope,policy(),'fact') || !liveEvidence(e)) fail('INVALID_EVIDENCE', '证据越界、已修改或删除')
      evidence.push(e)
    }
    if (input.manualEvidence) evidence.push(manualEvidence(input.manualEvidence, scope))
    if (!evidence.length || !evidence.some(e => e.speakerId === speakerId)) fail('INVALID_EVIDENCE', '事实必须引用说话人对应的真实证据')
    return [...new Map(evidence.map(e => [e.id, e])).values()]
  }
  function attach(factId, evidence) {
    for (const e of evidence) db.run('INSERT OR IGNORE INTO memory_fact_evidence(fact_id,evidence_id) VALUES (?,?)', factId, e.id)
  }
  function detectConflicts(f) {
    if (f.slot !== 'single' || f.status !== 'active') return
    for (const r of db.all('SELECT body FROM memory_facts WHERE account=? AND chat=? AND persona=? AND status IN (\'active\',\'conflicted\')', f.scope.account, f.scope.chat, f.scope.persona)) {
      const other = decode(r)
      if (!canRead(other,f.scope,{includeInactive:true})) continue
      if (other.id === f.id || other.slot !== 'single' || other.subject !== f.subject || other.predicate !== f.predicate || other.modality !== f.modality || other.stability !== f.stability) continue
      if (other.conditions === null || f.conditions === null || canonical(other.conditions) !== canonical(f.conditions) || other.eventTime !== f.eventTime) continue
      if ((other.validTo ?? Infinity) <= (f.validFrom ?? -Infinity) || (f.validTo ?? Infinity) <= (other.validFrom ?? -Infinity)) continue
      if (canonical(other.value) === canonical(f.value) && other.polarity === f.polarity) continue
      const before = clone(other)
      other.status = 'conflicted'; other.revision++; other.updatedAt = now()
      other.conflicts = [...new Set([...(other.conflicts || []), f.id])]
      f.status = 'conflicted'; f.conflicts = [...new Set([...(f.conflicts || []), other.id])]
      save(other); audit(other, 'conflict', before, other, { relatedIds: [f.id] })
    }
  }
  function insert(input, scope, evidence, { possibleDuplicates = [], category = 'fact', allowSupersedes = false } = {}) {
    const normalized = normalizeFact(input)
    if (normalized.supersedes.length && !allowSupersedes) fail('CORRECTION_REQUIRED', '取代旧事实必须使用有审计的 correct')
    if (tombstone('fingerprint', factFingerprint(normalized), scope)) fail('TOMBSTONED', '该事实已被遗忘，不能自动重建')
    const f = receipt({ ...normalized, id: id('fact'), category, source: input.source || 'manual',
      revision: 1, createdAt: now(), updatedAt: now(), possibleDuplicates }, scope)
    detectConflicts(f)
    save(f); attach(f.id, evidence); audit(f, 'create', null, f, { actorId: input.actorId, evidenceMessageIds: evidence.map(e => e.messageId).filter(Boolean) })
    return f
  }
  function create(input) {
    const scope = scopeOf(input)
    return db.tx(() => {
      const f = normalizeFact(input)
      if (f.status !== 'active') fail('INVALID_STRUCTURE', '新事实状态必须为 active')
      const evidence = collectEvidence(input, scope, f.speakerId)
      // Exact replay of the same structural fact and source is idempotent only.
      for (const row of db.all('SELECT body FROM memory_facts WHERE account=? AND chat=? AND persona=? AND fingerprint=?', scope.account, scope.chat, scope.persona, factFingerprint(f))) {
        const old = decode(row)
        if (['active','conflicted'].includes(old.status) && evidence.every(e => sourceIds(old.id).includes(e.id))) return receipt({ ok: true, id: old.id, reused: true, item: materialize(old, scope) }, scope)
      }
      const item = insert(input, scope, evidence, { category: input.category === 'experience' ? 'experience' : 'fact' })
      if (item.category === 'experience' && !scope.persona) fail('SCOPE_REQUIRED', '角色经历必须提供 persona')
      return receipt({ ok: true, id: item.id, item: materialize(item, scope) }, scope)
    })
  }
  function prepareBatch(scopeInput, inputs) {
    const scope = scopeOf(scopeInput)
    if (!Array.isArray(inputs) || inputs.length > 100) fail('INVALID_STRUCTURE', 'facts 必须为最多100条的数组')
    const facts = inputs.map(input => {
      exactKeys(input, [...FACT_FIELDS,'inputId','evidenceMessageIds'], 'extracted fact')
      const f = normalizeFact(input)
      if (f.status !== 'active' || f.supersedes.length) fail('INVALID_STRUCTURE', '自动新增不得直接修改事实状态或 supersedes')
      return { ...f, inputId: string(input.inputId, 'inputId', 160), evidenceMessageIds: ids(input.evidenceMessageIds, 'evidenceMessageIds') }
    })
    if (new Set(facts.map(f => f.inputId)).size !== facts.length) fail('INVALID_STRUCTURE', 'inputId 重复')
    const candidates = {}, seen = [], availableBySubject=new Map()
    for(const subject of new Set(facts.map(f=>f.subject))) availableBySubject.set(subject,list(scope,{subject,includeInactive:true,statuses:['active','conflicted'],ownScope:true,order:'updated',limit:5000}))
    for (const f of facts) {
      candidates[f.inputId] = availableBySubject.get(f.subject).slice().sort((a,b) => similarity(b.text,f.text) - similarity(a.text,f.text)).slice(0,40)
        .concat(seen.filter(c => c.subject === f.subject))
      seen.push({ ...f, id: `batch:${f.inputId}`, scope, revision: 0 })
    }
    return { scope, facts, candidates, scopeRevision: revision(scope), policyStamp: policyStamp() }
  }
  function commitBatch(batch, decisions) {
    return db.tx(() => {
      const scope = scopeOf(batch.scope)
      if (revision(scope) !== batch.scopeRevision || policyStamp() !== batch.policyStamp) fail('STALE_BATCH', '提炼期间事实、证据或共享策略已变化')
      validateDecisions(batch.facts, decisions, batch.candidates)
      const map = new Map(decisions.map(d => [d.inputId,d])), resolved = new Map(), result = []
      for (const f of batch.facts) {
        const d = map.get(f.inputId), evidence = collectEvidence(f, scope, f.speakerId)
        const resolve = ref => ref.startsWith('batch:') ? resolved.get(ref.slice(6)) : ref
        if (d.action === 'reuse') {
          const target = ownedFact(resolve(d.targetId), scope)
          if (!canRead(target, scope, { includeInactive: true }) || !['active','conflicted'].includes(target.status) || !reusable(f, target)) fail('STALE_BATCH', '复用目标已改变或不可见')
          const before = clone(target)
          attach(target.id, evidence); target.revision++; target.updatedAt = now(); save(target)
          audit(target, 'reuse', before, target, { evidenceMessageIds: f.evidenceMessageIds })
          resolved.set(f.inputId, target.id); result.push({ inputId: f.inputId, action: 'reuse', id: target.id })
        } else {
          const possibleDuplicates = (d.candidateIds || []).map(resolve)
          if (possibleDuplicates.some(v => !v)) fail('INVALID_DECISIONS', '本批候选尚未提交')
          const item = insert({ ...f, source: 'auto' }, scope, evidence, { possibleDuplicates })
          resolved.set(f.inputId, item.id); result.push({ inputId: f.inputId, action: d.action, id: item.id })
        }
      }
      return result
    })
  }
  function revise(factId, patch, options) {
    const scope = scopeOf(options), meta = requireMeta(options)
    exactKeys(patch, FACT_FIELDS.filter(k => !['status','supersedes'].includes(k)), 'patch')
    return db.tx(() => {
      const f = ownedFact(factId, scope)
      if (!['active','conflicted'].includes(f.status) || !canRead(f,scope,{includeInactive:true})) fail('INVALID_STATE', '仅可编辑可见存活事实')
      if (!Number.isInteger(options.expectedRevision) || f.revision !== options.expectedRevision) fail('REVISION_CONFLICT', '编辑版本已过期')
      const before = clone(f), next = normalizeFact({ ...f, ...patch, status: 'active' })
      if (tombstone('fingerprint', factFingerprint(next), scope)) fail('TOMBSTONED', '编辑目标内容已被遗忘')
      const evidence = collectEvidence(options, scope, next.speakerId)
      Object.assign(f, next, { revision: f.revision + 1, updatedAt: now() })
      attach(f.id, evidence); detectConflicts(f); save(f); audit(f, 'edit', before, f, meta)
      return receipt({ ok: true, item: materialize(f, scope) }, scope)
    })
  }
  function correct(factId, replacement, options) {
    const scope = scopeOf(options), meta = requireMeta(options)
    return db.tx(() => {
      const old = ownedFact(factId, scope), next = normalizeFact(replacement)
      if (!['active','conflicted'].includes(old.status) || !canRead(old,scope,{includeInactive:true})) fail('INVALID_STATE', '更正目标非可见存活事实')
      if (options.expectedRevision !== old.revision) fail('REVISION_CONFLICT', '更正版本已过期')
      if (next.subject !== old.subject || next.predicate !== old.predicate) fail('INVALID_CORRECTION', '更正必须指向同一主体和槽位')
      const evidence = collectEvidence(replacement, scope, next.speakerId)
      if (!evidence.some(e => e.kind === 'manual') && (next.speakerId !== old.speakerId || next.modality !== 'asserted')) fail('INVALID_CORRECTION', '其他人的转述不能覆盖当事人的事实')
      const before = clone(old)
      old.status = 'superseded'; old.revision++; old.updatedAt = now(); save(old)
      const item = insert({ ...replacement, status: 'active', supersedes: [old.id], actorId: meta.actorId }, scope, evidence, { allowSupersedes: true, category: old.category })
      old.supersededBy = item.id; save(old); audit(old, 'correct', before, old, { ...meta, relatedIds: [item.id] })
      return receipt({ ok: true, id: item.id, item: materialize(item, scope) }, scope)
    })
  }
  function transition(factId, action, options) {
    const scope = scopeOf(options), meta = requireMeta(options)
    return db.tx(() => {
      const f = ownedFact(factId, scope), before = clone(f)
      if (options.expectedRevision !== undefined && options.expectedRevision !== f.revision) fail('REVISION_CONFLICT', '记录版本已过期')
      if (action === 'delete') {
        if (f.status === 'deleted') return receipt({ ok: true, id: f.id, status: 'deleted' }, scope)
        markDeleted('fact', f.id, scope, meta); markDeleted('fingerprint', factFingerprint(f), scope, meta)
        // Forget the source too: a delayed model must not rephrase the deleted claim
        // into a new fingerprint. Shared-source dependents are retracted for review.
        for (const eid of sourceIds(f.id)) {
          const e = evidenceRaw(eid)
          if (sameScope(e.scope,scope)) deleteEvidence(eid,options)
        }
        f.revision = raw(f.id).revision
        f.status = 'deleted'; delete f.restoreApproval
      } else if (action === 'restore') {
        if (!['deleted','retracted','superseded'].includes(f.status)) fail('INVALID_STATE', '此记录无需恢复')
        f.status = 'quarantined'; delete f.restoreApproval
      } else if (action === 'approve') {
        if (f.status !== 'quarantined' || options.approved !== true) fail('APPROVAL_REQUIRED', '恢复后必须明确审批')
        if (!evidenceFor(f, scope)) fail('INVALID_EVIDENCE', '已删除、撤回或修改的证据须先复核')
        f.restoreApproval = { token: tombstone('fact', f.id, scope)?.token || null, fingerprintTokens:[tombstone('fingerprint',factFingerprint(f),scope)?.token].filter(Boolean), actorId: meta.actorId, reason: meta.reason, at: now() }
        f.status = 'active'
        detectConflicts(f)
      } else {
        if (!['active','conflicted'].includes(f.status)) fail('INVALID_STATE', '仅可撤回存活事实')
        f.status = 'retracted'
      }
      f.revision++; f.updatedAt = now(); save(f); audit(f, action, before, f, meta)
      return receipt({ ok: true, id: f.id, status: f.status, revision: f.revision }, scope)
    })
  }
  function deleteEvidence(evidenceId, options) {
    const scope = scopeOf(options), meta = requireMeta(options)
    return db.tx(() => {
      const e = evidenceRaw(evidenceId)
      if (!e) fail('NOT_FOUND', '证据不存在')
      owned(e.scope, scope)
      markDeleted('evidence', e.id, scope, meta)
      if (e.messageId) markDeleted('message', e.messageId, scope, meta)
      e.deletedAt = now(); e.revision++; saveEvidence(e)
      for (const row of db.all('SELECT fact_id FROM memory_fact_evidence WHERE evidence_id=?', e.id)) {
        const f = raw(row.fact_id), before = clone(f)
        if (f.status !== 'deleted') { f.status = 'retracted'; f.revision++; f.updatedAt = now(); save(f) }
        audit(f, 'delete_evidence', before, f, { ...meta, relatedIds: [e.id] })
      }
      return receipt({ ok: true, id: e.id, status: 'deleted' }, scope)
    })
  }
  function refreshEvidence(evidenceId, options) {
    const scope = scopeOf(options), meta = requireMeta(options)
    return db.tx(() => {
      const e = evidenceRaw(evidenceId)
      if (!e) fail('NOT_FOUND', '证据不存在')
      owned(e.scope, scope)
      if (!e.messageId || e.deletedAt || tombstone('evidence', e.id, scope)) fail('INVALID_EVIDENCE', '仅可刷新未删除的消息证据')
      const m = storage.messages.get(e.messageId)
      if (!m || m.recalledAt || m.account !== scope.account || m.chatId !== scope.chat) fail('INVALID_EVIDENCE', '来源不可用')
      e.snapshot = messageSnapshot(m); e.contentHash = hash(e.snapshot); e.text = m.text; e.speakerId = m.authorId; e.eventTime = m.platformTime ?? m.receivedAt; e.revision++
      saveEvidence(e)
      for (const row of db.all('SELECT fact_id FROM memory_fact_evidence WHERE evidence_id=?', e.id)) {
        const f = raw(row.fact_id), before = clone(f)
        if (f.status !== 'deleted') { f.status = 'quarantined'; f.revision++; f.updatedAt = now(); save(f) }
        audit(f, 'refresh_evidence', before, f, meta)
      }
      return receipt({ ok: true, evidence: e, requiresApproval: true }, scope)
    })
  }
  function approveEvidence(evidenceId, options) {
    const scope=scopeOf(options), meta=requireMeta(options)
    if (options.approved !== true) fail('APPROVAL_REQUIRED','恢复证据需要明确审批')
    return db.tx(() => {
      const e=evidenceRaw(evidenceId)
      if (!e) fail('NOT_FOUND','证据不存在')
      owned(e.scope,scope)
      if (e.revision !== options.expectedRevision) fail('REVISION_CONFLICT','证据版本已过期')
      if (e.messageId) {
        const m=storage.messages.get(e.messageId)
        if (!m || m.recalledAt || hash(messageSnapshot(m)) !== e.contentHash) fail('INVALID_EVIDENCE','证据来源已撤回、缺失或内容不一致')
      }
      const tokens=[tombstone('evidence',e.id,scope)?.token,e.messageId ? tombstone('message',e.messageId,scope)?.token : null].filter(Boolean)
      e.restoreApproval={...meta,tokens,at:now()}; delete e.deletedAt; e.revision++; saveEvidence(e)
      for (const r of db.all('SELECT fact_id FROM memory_fact_evidence WHERE evidence_id=?',e.id)) {
        const f=raw(r.fact_id)
        audit(f,'approve_evidence',null,{evidenceId:e.id,revision:e.revision},meta)
      }
      return receipt({ok:true,id:e.id,revision:e.revision},scope)
    })
  }
  function evidenceReview(factId, options) {
    const f=ownedFact(factId,options)
    return sourceIds(f.id).map(id=>evidenceRaw(id)).map(e => receipt({id:e.id,revision:e.revision,kind:e.kind,messageId:e.messageId,deleted:!liveEvidence(e)},e.scope))
  }
  function changeScope(factId, target, options) {
    const source=scopeOf(options), scope=scopeOf(target), meta=requireMeta(options)
    if (source.account !== scope.account) fail('INVALID_SCOPE','记忆不能移动到另一账号')
    return db.tx(() => {
      const f=ownedFact(factId,source), before=clone(f)
      if (f.revision !== options.expectedRevision) fail('REVISION_CONFLICT','记录版本已过期')
      if (!['active','conflicted'].includes(f.status) || !canRead(f,source,{includeInactive:true})) fail('INVALID_STATE','仅可修改可见存活事实范围')
      if (!evidenceFor(f,scope)) fail('INVALID_SCOPE','新范围不能访问所有来源证据')
      Object.assign(f,receipt({},scope)); f.revision++; f.updatedAt=now()
      touch(source); save(f); audit(f,'scope',before,f,meta)
      return receipt({ok:true,id:f.id,revision:f.revision},scope)
    })
  }
  function quarantineImport(payload, options) {
    const scope = scopeOf(options)
    if (!payload || typeof payload !== 'object') fail('INVALID_STRUCTURE', '导入内容必须为 JSON 对象或数组')
    const entries = Array.isArray(payload) ? payload : [payload]
    if (entries.length > 1000 || JSON.stringify(payload).length > 2_000_000) fail('INVALID_STRUCTURE', '导入内容超出批次上限')
    return db.tx(() => receipt({ ok: true, ids: entries.map(body => {
      const sourceKey = hash({ source: options.sourceKey || 'legacy-json', body })
      const old = db.get('SELECT id FROM memory_quarantine WHERE account=? AND chat=? AND persona=? AND source_key=?', scope.account, scope.chat, scope.persona, sourceKey)
      if (old) return old.id
      const qid = id('legacy')
      db.run('INSERT INTO memory_quarantine(id,account,chat,persona,source_key,body,created_at) VALUES (?,?,?,?,?,?,?)', qid, scope.account, scope.chat, scope.persona, sourceKey, JSON.stringify(body), now())
      return qid
    }), status: 'quarantined' }, scope))
  }
  function quarantineList(scopeInput) {
    const s = scopeOf(scopeInput)
    return db.all('SELECT * FROM memory_quarantine WHERE account=? AND chat=? AND persona=? ORDER BY created_at,id', s.account,s.chat,s.persona)
      .map(r => receipt({ id:r.id, payload:decode(r), createdAt:r.created_at, status:r.state, approvedFactId:r.approved_fact_id },s))
  }
  function approveLegacy(qid, fact, options) {
    const scope = scopeOf(options), meta = requireMeta(options)
    if (options.approved !== true) fail('APPROVAL_REQUIRED', '旧档案必须复核来源与范围后明确审批')
    return db.tx(() => {
      const row = db.get("SELECT * FROM memory_quarantine WHERE id=? AND ((account=? AND chat=? AND persona=?) OR (account='' AND chat='' AND persona=''))", qid,scope.account,scope.chat,scope.persona)
      if (!row || row.state !== 'quarantined') fail('INVALID_STATE', '隔离记录不存在或已审批')
      // The old payload is never trusted as structured evidence, even when it claims a scope.
      const result = create({ ...fact, scope, source:'legacy-approved', actorId:meta.actorId })
      db.run("UPDATE memory_quarantine SET state='approved',approved_fact_id=?,account=?,chat=?,persona=? WHERE id=?", result.id,scope.account,scope.chat,scope.persona,qid)
      audit(raw(result.id),'approve_legacy',null,raw(result.id),{ ...meta,relatedIds:[qid] })
      return result
    })
  }
  function unassignedQuarantine(options) {
    scopeOf(options)
    if (options?.includeUnassigned !== true) fail('QUARANTINE_REVIEW_REQUIRED','须显式请求未分配来源的隔离区')
    return db.all("SELECT * FROM memory_quarantine WHERE account='' AND chat='' AND state='quarantined' ORDER BY created_at,id").map(r=>({
      id:r.id,payload:decode(r),createdAt:r.created_at,status:r.state,scope:null,account:null,chat:null,persona:null,provenance:'unknown',
    }))
  }
  function auditOf(factId, scopeInput) {
    const f = ownedFact(factId, scopeInput)
    return db.all('SELECT seq,body FROM memory_audit WHERE fact_id=? ORDER BY seq',f.id).map(r => receipt({seq:r.seq,...decode(r)},f.scope))
  }
  function reviewList(scopeInput) {
    const scope = scopeOf(scopeInput)
    return db.all("SELECT body FROM memory_facts WHERE account=? AND chat=? AND persona=? AND status IN ('deleted','quarantined') ORDER BY updated_at DESC",scope.account,scope.chat,scope.persona)
      .map(decode).map(f => receipt({id:f.id,status:f.status,revision:f.revision,updatedAt:f.updatedAt, ...(f.status === 'quarantined' ? {text:f.text} : {})},scope))
  }
  function visibilityStamp(scopeInput) {
    const scope=scopeOf(scopeInput), p=policy()
    const chats=new Set([scope.chat])
    for(const g of p.shareGroups || []) if((!g.account || g.account===scope.account) && g.chats?.includes(scope.chat) && g.categories?.some(c=>['fact','experience','profile'].includes(c))) for(const chat of g.chats) chats.add(chat)
    const revisionRows=[]
    for(const chat of chats) revisionRows.push(...db.all("SELECT * FROM memory_scope_revisions WHERE json_extract(scope_key,'$.account')=? AND json_extract(scope_key,'$.chat')=? ORDER BY scope_key",scope.account,chat))
    const revisions=revisionRows.sort((a,b)=>a.scope_key.localeCompare(b.scope_key)).filter(r=>{
      const origin=JSON.parse(r.scope_key)
      return ['fact','experience','profile'].some(category=>visible(origin,scope,p,category))
    }).map(r=>({scope:JSON.parse(r.scope_key),revision:r.revision}))
    return hash({scope,policy:p,revisions})
  }
  return { db, storage, now, policy, policyStamp, revision, touch, raw, sourceIds, evidenceRaw, messageSnapshot, liveEvidence, tombstone,
    visibilityStamp,
    page:queries.page,lexicalSearch:queries.lexical,lexicalCacheStats:queries.stats,clearQueryCache:queries.clear,
    evidenceFor, canRead, materialize, ownedFact, activeAt, list, get, getMany, create, prepareBatch, commitBatch, revise, correct,
    remove:(id,o)=>transition(id,'delete',o), retract:(id,o)=>transition(id,'retract',o), restore:(id,o)=>transition(id,'restore',o), approve:(id,o)=>transition(id,'approve',o),
    deleteEvidence, refreshEvidence, approveEvidence, evidenceReview, changeScope, quarantineImport, quarantineList, unassignedQuarantine, approveLegacy, auditOf, reviewList }
}

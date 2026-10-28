import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { relative, resolve, isAbsolute } from 'node:path'
import { scopeOf, visible } from '../../scope.js'
import { digest, fail } from '../../embedding/space.js'

const cap = value => Math.max(1, Math.min(500, Math.trunc(Number(value) || 128)))
const inside = (root, path) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel) }
const parse = value => { try { return JSON.parse(value || '{}') } catch { return {} } }
const abort = signal => { if (signal?.aborted) fail('JOB_CANCELLED', '图片读取已取消') }

function scopePage(db, account, { cursor, limit } = {}, { table, accountColumn, chatColumn, personaColumn, valid = '1' }) {
  if (typeof account !== 'string' || !account.trim() || account !== account.trim() || account.length > 160) fail('SCOPE_REQUIRED', '枚举范围需要明确账号')
  const n = cap(limit), after = cursor ? scopeOf({ ...cursor, account }) : { chat: '', persona: '' }
  const rows = db.all(`SELECT DISTINCT ${chatColumn} chat,${personaColumn} persona FROM ${table}
    WHERE ${valid} AND ${accountColumn}=? AND (${chatColumn}>? OR (${chatColumn}=? AND ${personaColumn}>?))
    ORDER BY chat,persona LIMIT ?`, account, after.chat, after.chat, after.persona, n)
  return { items: rows.map(row => scopeOf({ ...row, account })), nextCursor: rows.at(-1) ?? cursor, done: rows.length < n }
}

/** SQL narrows candidates before the authoritative get()/evidence gate. */
function predicate(viewer, policy, { account, chat, persona, category }) {
  const params = [viewer.account, viewer.persona, viewer.chat]
  const branches = [`${chat} = ?`]
  for (const group of policy?.shareGroups || []) {
    if (group.account && group.account !== viewer.account) continue
    if (!Array.isArray(group.chats) || !group.chats.includes(viewer.chat) || !Array.isArray(group.categories) || !group.categories.length) continue
    const chats = [...new Set(group.chats)].slice(0, 256), cats = [...new Set(group.categories)].slice(0, 32)
    branches.push(`(${chat} IN (${chats.map(() => '?')}) AND ${category} IN (${cats.map(() => '?')}))`)
    params.push(...chats, ...cats)
  }
  return { sql: `${account} = ? AND (${persona} = '' OR ${persona} = ?) AND (${branches.join(' OR ')})`, params }
}

export function createMemorySourceRepository({ memory, storage, getPolicy = () => ({}) }) {
  const repo = {
    list: (scope, options = {}) => memory.list({ ...options, scope: scopeOf(scope) }),
    get: (id, scope) => memory.get(id, { scope: scopeOf(scope) }),
    revision: scope => memory.revision(scopeOf(scope)),
    visibilityStamp: scope => memory.visibilityStamp(scopeOf(scope)),
    scopePage: (account, options) => scopePage(storage.db, account, options, {
      table: 'memory_facts', accountColumn: 'account', chatColumn: 'chat', personaColumn: 'persona',
    }),
    page(scope, { cursor = '', limit = 128, owned = false } = {}) {
      const viewer = scopeOf(scope), n = cap(limit)
      const where = owned ? { sql: 'account=? AND chat=? AND persona=?', params: [viewer.account, viewer.chat, viewer.persona] } : predicate(viewer, getPolicy(), { account: 'account', chat: 'chat', persona: 'persona', category: 'category' })
      const rows = storage.db.all(`SELECT id FROM memory_facts WHERE ${where.sql} AND id > ? ORDER BY id LIMIT ?`, ...where.params, cursor, n)
      const items = typeof memory.getFactsByIds === 'function' ? memory.getFactsByIds(rows.map(row => row.id), { scope: viewer }) : rows.map(row => repo.get(row.id, viewer)).filter(Boolean)
      return { items, sourceIds: rows.map(row => row.id),
        nextCursor: rows.at(-1)?.id ?? cursor, done: rows.length < n, scanned: rows.length }
    },
  }
  return repo
}

function imageMime(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png'
  if (buf.length >= 3 && buf[0] === 255 && buf[1] === 216 && buf[2] === 255) return 'image/jpeg'
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('ascii', 0, 6))) return 'image/gif'
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

function imageAnalysisText(occurrence, scope, getMediaAnalysis) {
  const analysis = occurrence.analysis || {}
  if (!Object.hasOwn(analysis, 'mediaMemory')) return analysis // Legacy/generated captions.
  const media = analysis.mediaMemory, result = media?.result
  // Read the producer's versioned result only after the live occurrence/message gate.
  // Captions belong to an occurrence, never to the shared asset/hash or cached chatNote.
  if (media?.version !== 1 || media.status !== 'ready' || media.account !== scope.account ||
      media.chatId !== scope.chat || !occurrence.messageId || media.sourceMessageId !== occurrence.messageId ||
      result?.version !== 1 || typeof result.description !== 'string' || !result.description.trim() || typeof result.ocr !== 'string') return {}
  try {
    const source = getMediaAnalysis?.()
    if (source?.settings?.().enabled !== true) return {}
    // The producer rechecks blocked authors, age, withdrawal and source fingerprints.
    // It may revoke the stored projection here; never fall back to its stale JSON.
    const current = source.visible?.({ chatId: scope.chat, occurrenceId: occurrence.id })
    if (!current || typeof current.then === 'function' || current.version !== 1 || current.status !== 'ready' ||
        current.account !== scope.account || current.chatId !== scope.chat || current.occurrenceId !== occurrence.id ||
        current.messageId !== occurrence.messageId || current.assetId !== occurrence.assetId || current.coverage !== media.coverage ||
        current.result?.version !== 1 || current.result.description !== result.description || current.result.ocr !== result.ocr) return {}
    if (!Number.isSafeInteger(current.revision) || current.revision < 0) return {}
    return { ...current.result, mediaRevision: current.revision }
  } catch { return {} } // A missing/stopped producer or rejected source cannot authorize a caption.
}

/** Existing occurrences are the authorization boundary, never a caller supplied asset ID/path/URL. */
export function createImageSourceRepository({ storage, getPolicy = () => ({}), getMediaAnalysis, maxBytes = 6 * 1024 * 1024 }) {
  const { db } = storage
  const root = resolve(storage.assets.pathOf({ path: '' }))
  const mediaPolicy = () => {
    try {
      const source = getMediaAnalysis?.(), settings = source?.settings?.()
      return { available: typeof source?.visible === 'function', enabled: settings?.enabled === true,
        blockedAuthors: settings?.blockedAuthors ?? [], maxAgeDays: settings?.maxAgeDays ?? null }
    } catch { return { available: false, enabled: false } }
  }
  const repo = {
    scopePage: (account, options) => scopePage(db, account, options, { table: 'asset_occurrences', valid: 'json_valid(scope_json)',
      accountColumn: "json_extract(scope_json,'$.account')", chatColumn: 'chat_id', personaColumn: "COALESCE(json_extract(scope_json,'$.persona'),'')" }),
    get(id, input) {
      const viewer = scopeOf(input), occurrence = storage.occurrences.get(id)
      if (!occurrence || occurrence.state !== 'ready' || !['image', 'sticker', 'generated'].includes(occurrence.kind)) return null
      let scope
      try { scope = scopeOf(occurrence.scope) } catch { return null }
      if (scope.chat !== occurrence.chatId || !visible(scope, viewer, getPolicy(), 'image')) return null
      const asset = storage.assets.get(occurrence.assetId)
      if (!asset || asset.state !== 'stored' || !/^image\/(png|jpeg|gif|webp)$/.test(asset.mime) || asset.bytes > maxBytes || asset.bytes <= 0) return null
      const filename = resolve(storage.assets.pathOf(asset))
      if (!inside(root, filename)) return null
      try { if (!statSync(filename).isFile()) return null } catch { return null }
      let message = null, generation = null, sourceActor = String(occurrence.authorId)
      if (occurrence.messageId) {
        message = storage.messages.get(occurrence.messageId)
        if (!message || message.recalledAt != null || message.account !== scope.account || message.chatId !== scope.chat || String(message.authorId) !== sourceActor) return null
      } else if (occurrence.remote?.jobId) {
        const job = db.get('SELECT * FROM jobs WHERE id = ?', occurrence.remote.jobId)
        const lineage = db.get('SELECT * FROM generation_lineage WHERE job_id = ?', occurrence.remote.jobId)
        const input = parse(job?.input_json), outputs = parse(lineage?.outputs_json)
        if (!job || job.chat_id !== scope.chat || String(input.accountId || '') !== scope.account || !Array.isArray(outputs) || !outputs.includes(asset.id)) return null
        sourceActor = String(job.actor_id)
        generation = { jobId: job.id, parentJobId: lineage.parent_job_id ?? null, sourceKind: 'generated' }
      } else {
        // Materialized search candidates carry an explicit provenance marker. Arbitrary orphan assets do not.
        if (asset.sourceKind !== 'web-reference' || !occurrence.remote?.resultId || !occurrence.remote?.candidateId) return null
      }
      const analysis = imageAnalysisText(occurrence, scope, getMediaAnalysis)
      return { id: occurrence.id, occurrenceId: occurrence.id, assetId: asset.id, scope,
        revision: Number(occurrence.updatedAt || occurrence.createdAt), createdAt: occurrence.createdAt,
        analysisRevision: analysis.mediaRevision ?? null,
        contentHash: asset.sha256, image: { assetId: asset.id }, preprocessRevision: 'asset-original-v1',
        description: typeof analysis.description === 'string' ? analysis.description.slice(0, 12000) : '',
        ocr: typeof analysis.ocr === 'string' ? analysis.ocr.slice(0, 12000) : '', chatText: (message?.text || '').slice(0, 12000),
        sourceMessageId: occurrence.messageId ?? null, sourceActor, generation, generationId: generation?.jobId ?? null }
    },
    page(input, { cursor = '', limit = 128, owned = false } = {}) {
      const scope = scopeOf(input), n = cap(limit)
      const where = owned ? { sql: "json_extract(scope_json,'$.account')=? AND chat_id=? AND COALESCE(json_extract(scope_json,'$.persona'),'')=?", params: [scope.account, scope.chat, scope.persona] } : predicate(scope, getPolicy(), { account: "json_extract(scope_json,'$.account')", chat: 'chat_id', persona: "COALESCE(json_extract(scope_json,'$.persona'),'')", category: "'image'" })
      const rows = db.all(`SELECT id FROM asset_occurrences WHERE json_valid(scope_json) AND ${where.sql} AND id > ? ORDER BY id LIMIT ?`, ...where.params, cursor, n)
      return { items: rows.map(row => repo.get(row.id, scope)).filter(Boolean), sourceIds: rows.map(row => row.id),
        nextCursor: rows.at(-1)?.id ?? cursor, done: rows.length < n, scanned: rows.length }
    },
    list(scope, { limit = 300 } = {}) {
      const items = []; let cursor = ''
      // Synchronous compatibility API is bounded; the service uses page() and yields between pages.
      for (let i = 0; i < 32 && items.length < limit; i++) {
        const page = repo.page(scope, { cursor, limit: Math.min(500, limit - items.length) })
        items.push(...page.items); cursor = page.nextCursor
        if (page.done) break
      }
      return items
    },
    revision(scope) {
      const viewer = scopeOf(scope)
      if (db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='retrieval_source_clock'")) {
        const where = predicate(viewer, getPolicy(), { account: 'account', chat: 'chat', persona: 'persona', category: "'image'" })
        return digest([viewer, getPolicy(), mediaPolicy(), db.all(`SELECT account,chat,persona,revision FROM retrieval_source_clock WHERE kind='image' AND ${where.sql} ORDER BY account,chat,persona`, ...where.params)])
      }
      // SQLite's connection change counter includes recall/policy-source edits that do not touch occurrence.updated_at.
      return digest([viewer, getPolicy(), mediaPolicy(), db.get('SELECT total_changes() AS n').n, db.get('PRAGMA data_version').data_version])
    },
    async loadImage(id, scope, { signal } = {}) {
      abort(signal)
      const row = repo.get(id, scope)
      if (!row) fail('IMAGE_NOT_VISIBLE', '图片出现记录不存在、已撤回或不在可见范围')
      const asset = storage.assets.get(row.assetId)
      let file
      try {
        const [realRoot, path] = await Promise.all([realpath(root), realpath(storage.assets.pathOf(asset))])
        if (!inside(realRoot, path)) fail('IMAGE_NOT_VISIBLE', '图片文件不在受管资产目录')
        file = await open(path, 'r')
        const info = await file.stat()
        if (!info.isFile() || info.size > maxBytes || info.size !== asset.bytes) fail('INVALID_IMAGE_SOURCE', '图片资产大小不一致或超限')
        const bytes = Buffer.alloc(info.size)
        let offset = 0
        while (offset < bytes.length) {
          abort(signal)
          const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
          if (!bytesRead) fail('INVALID_IMAGE_SOURCE', '图片资产读取不完整')
          offset += bytesRead
        }
        const current = repo.get(id, scope), mime = imageMime(bytes)
        if (!current || digest(current) !== digest(row)) fail('IMAGE_NOT_VISIBLE', '图片来源在读取期间改变或撤回')
        if (!mime || mime !== asset.mime || createHash('sha256').update(bytes).digest('hex') !== row.contentHash) fail('INVALID_IMAGE_SOURCE', '图片资产内容校验失败')
        abort(signal)
        return { bytes, mime, url: `data:${mime};base64,${bytes.toString('base64')}`, reference: imageReference(row) }
      } catch (error) {
        if (['JOB_CANCELLED', 'IMAGE_NOT_VISIBLE', 'INVALID_IMAGE_SOURCE'].includes(error.code)) throw error
        fail('IMAGE_UNAVAILABLE', '图片资产不可读取') // Never surface a local path from fs errors.
      } finally { await file?.close() }
    },
    assertReferences(references, scope) {
      if (!Array.isArray(references) || references.length > 16) fail('INVALID_REFERENCES', '历史引用最多 16 张')
      return references.map(ref => {
        if (!ref || typeof ref.occurrenceId !== 'string' || typeof ref.role !== 'string' || !ref.role.trim() || ref.role.length > 80) fail('INVALID_REFERENCES', '历史引用必须含 occurrenceId 和 role')
        const row = repo.get(ref.occurrenceId, scope)
        if (!row || (ref.assetId && ref.assetId !== row.assetId) || (ref.contentHash && ref.contentHash !== row.contentHash)) fail('IMAGE_NOT_VISIBLE', '历史引用已改变、撤回或不可见')
        return { ...imageReference(row), role: ref.role }
      })
    },
    async resolveHistoryReferences({ scope, references, signal }) {
      const checked = repo.assertReferences(references, scope), output = []
      for (const ref of checked) {
        const loaded = await repo.loadImage(ref.occurrenceId, scope, { signal })
        output.push({ ...ref, bytes: loaded.bytes, mime: loaded.mime })
      }
      repo.assertReferences(checked, scope)
      return output
    },
  }
  return repo
}

export function imageReference(row) {
  return { occurrenceId: row.occurrenceId, assetId: row.assetId, sourceActor: row.sourceActor,
    generation: row.generation, generationId: row.generationId, sourceMessageId: row.sourceMessageId,
    contentHash: row.contentHash, scope: row.scope, description: row.description }
}

// 人设库（存在主库里）：每张卡有草稿和一串不可变的发布版本；聊天按 具体聊天 → 群聊/私聊默认 → 全局 绑定到卡。
//
// 分层：
//   identity  名字、称呼、关系、稳定性格          → 决定「她是谁」
//   behavior  参与群聊的偏好、主动程度、何时追问  → 决定「她怎么做」（仍受运行策略限制）
//   style     用词、句式、长度、示例、禁用表达    → 决定「她怎么说」
//   appearance 外观描述、固定参考图               → 只在画她自己时用
//   voice     音色、语速                          → 语音
//   policy    情绪、表达学习的开关                → 情绪与学习服务
//   legacy    旧版整篇 Markdown（原样保留，导入时不擅自拆分改写）
//
// 保存要带 editRevision（拿到卡时的值），对不上说明别处改过，拒绝覆盖。

export const PERSONA_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/

const str = (v, max = 20000) => String(v ?? '').slice(0, max)
const list = (v, max = 50) => (Array.isArray(v) ? v.map((x) => str(x, 500)).filter(Boolean).slice(0, max) : [])

/** 分层内容归一化：缺的给默认值，多余的字段丢掉。 */
export function normalizeLayers(raw = {}) {
  const l = raw && typeof raw === 'object' ? raw : {}
  const id = l.identity || {}
  const be = l.behavior || {}
  const st = l.style || {}
  const ap = l.appearance || {}
  const vo = l.voice || {}
  const po = l.policy || {}
  const out = {
    identity: { name: str(id.name, 40), callOwner: str(id.callOwner, 20), core: str(id.core) },
    behavior: { text: str(be.text), proactivity: ['low', 'normal', 'high'].includes(be.proactivity) ? be.proactivity : 'normal' },
    style: { text: str(st.text), examples: list(st.examples, 20), banned: list(st.banned, 50) },
    appearance: { text: str(ap.text, 4000), referenceAssetIds: list(ap.referenceAssetIds, 8) },
    voice: { voice: str(vo.voice, 80), speed: Number.isFinite(Number(vo.speed)) ? Math.min(2, Math.max(0.5, Number(vo.speed))) : 1 },
    policy: { mood: po.mood !== false, learnExpressions: po.learnExpressions !== false, useExpressions: po.useExpressions !== false },
    tags: list(l.tags, 12).map((t) => t.slice(0, 20)),
  }
  // Missing individual overrides inherit the global voice policy.
  if (vo.rvc && typeof vo.rvc === 'object' && !Array.isArray(vo.rvc)) {
    const r = vo.rvc, next = {}
    if (typeof r.enabled === 'boolean') next.enabled = r.enabled
    if (typeof r.voice === 'string' && r.voice.trim()) next.voice = str(r.voice.trim(), 200)
    if (r.pitch !== '' && r.pitch != null && typeof r.pitch !== 'boolean' && Number.isFinite(Number(r.pitch))) next.pitch = Math.max(-24, Math.min(24, Number(r.pitch)))
    if (['original', 'error'].includes(r.fallback)) next.fallback = r.fallback
    if (r.timeoutMs !== '' && r.timeoutMs != null && typeof r.timeoutMs !== 'boolean' && Number.isFinite(Number(r.timeoutMs))) next.timeoutMs = Math.max(1000, Math.min(300000, Number(r.timeoutMs)))
    if (Object.keys(next).length) out.voice.rvc = next
  }
  if (l.legacy && typeof l.legacy === 'object' && str(l.legacy.body).trim()) out.legacy = { body: str(l.legacy.body, 60000) }
  return out
}

/** 旧版人格 Markdown → 分层（正文原样放进 legacy，只填名字）。 */
export function layersFromMarkdown({ name, body, tags = [] }) {
  return normalizeLayers({ identity: { name }, legacy: { body }, tags })
}

const fail = (message, code) => Object.assign(new Error(message), { code })

export function createPersonaStore({ storage, now = () => Date.now() }) {
  const db = storage.db

  const row = (id) => db.get('SELECT * FROM personas WHERE id = ?', id)
  const revisionRow = (id, rev) => db.get('SELECT * FROM persona_revisions WHERE persona_id = ? AND revision = ?', id, rev)
  const parse = (j) => normalizeLayers(JSON.parse(j))

  function checkId(id) {
    if (!PERSONA_ID.test(String(id || ''))) throw fail('人设 ID 只能用英文字母、数字、- 和 _（最长 40 个字符），不能是别的字符', 'BAD_ID')
    return String(id)
  }

  function view(r) {
    if (!r) return null
    const rev = r.current_revision ? revisionRow(r.id, r.current_revision) : null
    return {
      id: r.id, name: r.name, origin: r.origin, editRevision: Number(r.edit_revision), archivedAt: r.archived_at,
      published: rev ? { revision: Number(rev.revision), layers: parse(rev.layers_json), note: rev.note, createdAt: rev.created_at } : null,
      draft: r.draft_json ? { layers: parse(r.draft_json), baseRevision: r.draft_base } : null,
      createdAt: r.created_at, updatedAt: r.updated_at,
    }
  }

  function guard(r, editRevision) {
    if (!r) throw fail('没有这个人设', 'NOT_FOUND')
    if (editRevision !== undefined && Number(editRevision) !== Number(r.edit_revision)) throw fail('这张卡在别处改过了，先刷新再改（你的改动还在编辑框里）', 'STALE')
  }

  /** 新建一张卡（只有草稿）。publish=true 时同时发布第 1 版。 */
  function create({ id, name, layers, origin = 'user', publish = false, note = '' }) {
    checkId(id)
    return db.tx(() => {
      if (row(id)) throw fail(`已经有一张叫 ${id} 的卡了`, 'EXISTS')
      const t = now()
      const lay = normalizeLayers(layers)
      db.run('INSERT INTO personas(id, name, origin, draft_json, draft_base, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)',
        id, str(name || lay.identity.name || id, 40), origin, JSON.stringify(lay), t, t)
      db.run('DELETE FROM persona_tombstones WHERE id = ?', id)
      if (publish) publishDraft(id, { note })
      return view(row(id))
    })
  }

  function saveDraft(id, { layers, name }, { editRevision } = {}) {
    return db.tx(() => {
      const r = row(id)
      guard(r, editRevision)
      if (r.archived_at) throw fail('这张卡已归档，先取消归档再改', 'ARCHIVED')
      db.run('UPDATE personas SET draft_json = ?, draft_base = COALESCE(draft_base, current_revision), name = ?, edit_revision = edit_revision + 1, updated_at = ? WHERE id = ?',
        JSON.stringify(normalizeLayers(layers)), str(name || r.name, 40), now(), id)
      return view(row(id))
    })
  }

  function publishDraft(id, { note = '' } = {}) {
    const r = row(id)
    if (!r.draft_json) throw fail('没有要发布的改动', 'NO_DRAFT')
    const rev = Number(db.get('SELECT COALESCE(MAX(revision), 0) AS n FROM persona_revisions WHERE persona_id = ?', id).n) + 1
    db.run('INSERT INTO persona_revisions(persona_id, revision, layers_json, note, created_at) VALUES (?, ?, ?, ?, ?)', id, rev, r.draft_json, str(note, 200), now())
    db.run('UPDATE personas SET current_revision = ?, draft_json = NULL, draft_base = NULL, edit_revision = edit_revision + 1, updated_at = ? WHERE id = ?', rev, now(), id)
    return rev
  }

  /** 把草稿发布成新版本（发布后不可改，只能再发新版本）。 */
  function publish(id, { editRevision, note } = {}) {
    return db.tx(() => {
      const r = row(id)
      guard(r, editRevision)
      if (r.archived_at) throw fail('这张卡已归档', 'ARCHIVED')
      publishDraft(id, { note })
      return view(row(id))
    })
  }

  /** 回滚：把某个旧版本的内容发布成一个新版本（历史不删）。 */
  function rollback(id, revision, { editRevision } = {}) {
    return db.tx(() => {
      const r = row(id)
      guard(r, editRevision)
      const old = revisionRow(id, Number(revision))
      if (!old) throw fail(`没有第 ${revision} 版`, 'NOT_FOUND')
      db.run('UPDATE personas SET draft_json = ?, draft_base = ? WHERE id = ?', old.layers_json, Number(revision), id)
      publishDraft(id, { note: `回滚到第 ${revision} 版` })
      return view(row(id))
    })
  }

  function discardDraft(id, { editRevision } = {}) {
    return db.tx(() => {
      const r = row(id)
      guard(r, editRevision)
      if (!r.current_revision) throw fail('这张卡还没发布过，草稿不能丢', 'NO_PUBLISHED')
      db.run('UPDATE personas SET draft_json = NULL, draft_base = NULL, edit_revision = edit_revision + 1, updated_at = ? WHERE id = ?', now(), id)
      return view(row(id))
    })
  }

  function duplicate(id, newId, name) {
    const src = view(row(id))
    if (!src) throw fail('没有这个人设', 'NOT_FOUND')
    const layers = src.draft?.layers || src.published?.layers
    return create({ id: newId, name: name || `${src.name}（副本）`, layers, origin: 'user' })
  }

  /** 归档：正在被绑定的卡要先把绑定迁走，不能留下悬空引用。 */
  function archive(id, { editRevision } = {}) {
    return db.tx(() => {
      const r = row(id)
      guard(r, editRevision)
      const used = db.all('SELECT scope FROM persona_bindings WHERE persona_id = ?', id).map((x) => x.scope)
      if (used.length) throw Object.assign(fail(`这张卡还绑定在：${used.join('、')}，先把它们换成别的卡`, 'IN_USE'), { scopes: used })
      db.run('UPDATE personas SET archived_at = ?, edit_revision = edit_revision + 1, updated_at = ? WHERE id = ?', now(), now(), id)
      return view(row(id))
    })
  }

  function unarchive(id) {
    db.run('UPDATE personas SET archived_at = NULL, edit_revision = edit_revision + 1, updated_at = ? WHERE id = ?', now(), id)
    return view(row(id))
  }

  /** 删除：只能删已归档的卡；记一条删除记录，内置卡不会因此在下次启动时又冒出来。 */
  function remove(id) {
    return db.tx(() => {
      const r = row(id)
      if (!r) throw fail('没有这个人设', 'NOT_FOUND')
      if (!r.archived_at) throw fail('先归档再删除', 'NOT_ARCHIVED')
      db.run('DELETE FROM persona_revisions WHERE persona_id = ?', id)
      db.run('DELETE FROM personas WHERE id = ?', id)
      db.run('INSERT INTO persona_tombstones(id, deleted_at) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET deleted_at = excluded.deleted_at', id, now())
      return true
    })
  }

  const list = ({ includeArchived = true } = {}) => db.all('SELECT * FROM personas ORDER BY created_at').map(view).filter((p) => includeArchived || !p.archivedAt)
  const get = (id) => view(row(id))
  const revisions = (id) => db.all('SELECT revision, note, created_at FROM persona_revisions WHERE persona_id = ? ORDER BY revision DESC', id).map((r) => ({ revision: Number(r.revision), note: r.note, createdAt: r.created_at }))
  function revision(id, rev) {
    const r = revisionRow(id, Number(rev))
    return r ? { personaId: id, revision: Number(r.revision), layers: parse(r.layers_json), note: r.note, createdAt: r.created_at } : null
  }

  /** 导出一张卡（当前发布版 + 草稿），不含任何账号信息。 */
  function exportCard(id) {
    const p = get(id)
    if (!p) throw fail('没有这个人设', 'NOT_FOUND')
    return { format: 'aurabot-persona', version: 1, id: p.id, name: p.name, layers: p.published?.layers || p.draft?.layers }
  }
  function importCard(card, { id } = {}) {
    if (!card || card.format !== 'aurabot-persona') throw fail('不是 Aurabot 的人设文件', 'BAD_FORMAT')
    return create({ id: id || card.id, name: card.name, layers: card.layers, origin: 'import' })
  }

  /**
   * 内置卡：只在从没导入过、也没被用户删掉时导入一次（已发布）。
   * cards: [{ id, name, layers }]
   */
  function seed(cards) {
    const seeded = new Set(storage.meta.get('personas.seeded', []))
    const added = []
    for (const c of cards) {
      if (seeded.has(c.id)) continue
      if (db.get('SELECT 1 FROM persona_tombstones WHERE id = ?', c.id)) { seeded.add(c.id); continue }
      if (!row(c.id)) {
        create({ id: c.id, name: c.name, layers: c.layers, origin: c.origin || 'builtin', publish: true, note: c.note || '内置' })
        added.push(c.id)
      }
      seeded.add(c.id)
    }
    storage.meta.set('personas.seeded', [...seeded])
    return added
  }

  // ---------- 绑定 ----------
  const SCOPE = /^(global|kind:(group|private)|chat:(group|private):\d+)$/

  function bind(scope, personaId) {
    if (!SCOPE.test(String(scope))) throw fail(`绑定范围不合法：${scope}`, 'BAD_SCOPE')
    return db.tx(() => {
      if (personaId === null || personaId === undefined || personaId === '') {
        if (scope === 'global') throw fail('全局默认不能清空', 'NEED_GLOBAL')
        db.run('DELETE FROM persona_bindings WHERE scope = ?', scope)
      } else {
        const p = row(personaId)
        if (!p) throw fail('没有这个人设', 'NOT_FOUND')
        if (p.archived_at) throw fail('这张卡已归档，不能绑定', 'ARCHIVED')
        if (!p.current_revision) throw fail('这张卡还没发布过，先发布再绑定', 'NO_PUBLISHED')
        db.run('INSERT INTO persona_bindings(scope, persona_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(scope) DO UPDATE SET persona_id = excluded.persona_id, updated_at = excluded.updated_at', scope, personaId, now())
      }
      storage.nextSeq('persona.bindings')
      return bindings()
    })
  }

  const bindings = () => db.all('SELECT scope, persona_id, updated_at FROM persona_bindings ORDER BY scope').map((r) => ({ scope: r.scope, personaId: r.persona_id, updatedAt: r.updated_at }))
  const bindingRevision = () => Number(db.get("SELECT value FROM sequences WHERE name = 'persona.bindings'")?.value || 0)

  /**
   * 这个聊天现在该用哪张卡的哪个版本。按 具体聊天 → 群聊/私聊默认 → 全局 找；
   * 绑定指向的卡不存在 / 已归档 / 没发布时返回 { error }，不会随便换成别的卡。
   */
  function resolve(chatId) {
    const kind = String(chatId).split(':')[0]
    const scopes = [`chat:${chatId}`, `kind:${kind}`, 'global']
    for (const scope of scopes) {
      const b = db.get('SELECT persona_id FROM persona_bindings WHERE scope = ?', scope)
      if (!b) continue
      const p = row(b.persona_id)
      if (!p || p.archived_at || !p.current_revision) {
        return { error: `「${scope}」绑定的人设 ${b.persona_id} ${!p ? '不存在' : p.archived_at ? '已归档' : '还没发布'}`, scope }
      }
      const rev = revisionRow(p.id, p.current_revision)
      return { personaId: p.id, name: p.name, revision: Number(p.current_revision), bindingRevision: bindingRevision(), scope, layers: parse(rev.layers_json) }
    }
    return { error: '没有设置全局默认人设', scope: 'global' }
  }

  return { create, saveDraft, publish, rollback, discardDraft, duplicate, archive, unarchive, remove, list, get, revisions, revision, exportCard, importCard, seed, bind, bindings, resolve, checkId }
}

// 人设服务：人设库 + 旧版 Markdown 人格的一次性导入 + 内置卡 + 面板旧接口的兼容层。

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPersonaStore, layersFromMarkdown, PERSONA_ID } from './store.js'
import { compilePersona, PERSONA_ERROR_TEXT } from './compiler.js'
import { parsePersona } from './personas.js'

const BUNDLED = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'personas')
const DEFAULT_ID = 'dafeiyu'

function readMarkdownDir(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const n of readdirSync(dir)) {
    if (!n.endsWith('.md')) continue
    const id = n.slice(0, -3)
    try {
      const p = parsePersona(id, readFileSync(join(dir, n), 'utf8'))
      if (p.body) out.push({ id, name: p.name, tags: p.tags, body: p.body })
    } catch (error) {}
  }
  return out
}

// Native exported cards retain editable layers. User Markdown is only imported
// through importLegacy; a bundled update never overwrites a published user card.
function readBundledDir(dir, log) {
  const cards = new Map(readMarkdownDir(dir).map(p => [p.id, { id: p.id, name: p.name, layers: layersFromMarkdown(p) }]))
  if (!existsSync(dir)) return [...cards.values()]
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.persona.json')) continue
    try {
      const card = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      if (card.format !== 'aurabot-persona' || card.version !== 1 || !PERSONA_ID.test(card.id) ||
          name !== `${card.id}.persona.json` || !card.layers || typeof card.layers !== 'object' || Array.isArray(card.layers)) throw new Error('无效的分层人设文件')
      cards.set(card.id, { id: card.id, name: card.name, layers: card.layers })
    } catch (error) { log?.warn?.(`内置人设 ${name} 未加载：${error.message}`) }
  }
  return [...cards.values()]
}

/**
 * @param {object} o
 * @param {object} o.storage
 * @param {string} o.legacyDir 旧版人格目录（数据目录 personas/）
 * @param {string} [o.legacyCurrent] 旧配置里的当前人格 ID
 */
export function createPersonaService({ storage, legacyDir, legacyCurrent, log, bundledDir = BUNDLED }) {
  const store = createPersonaStore({ storage })

  /**
   * 旧版人格导入（只做一次，原文件不动）：数据目录里的每篇 Markdown 原样导入成一张卡的第 1 版。
   * ID 不合法的（以前允许过的字符）不改名凑合，记进报告让主人手动处理。
   */
  function importLegacy() {
    const step = 'personas-markdown-v1'
    if (storage.legacy.get(step)?.state === 'done') return null
    storage.legacy.start(step)
    try {
      const report = { imported: [], skipped: [], badId: [] }
      for (const p of readMarkdownDir(legacyDir)) {
        if (!PERSONA_ID.test(p.id)) { report.badId.push(p.id); continue }
        if (store.get(p.id)) { report.skipped.push(p.id); continue }
        store.create({ id: p.id, name: p.name, layers: layersFromMarkdown(p), origin: 'legacy', publish: true, note: '从旧版人格导入（原文）' })
        report.imported.push(p.id)
      }
      if (legacyCurrent && store.get(legacyCurrent)?.published && !store.bindings().some((b) => b.scope === 'global')) store.bind('global', legacyCurrent)
      storage.legacy.finish(step, report)
      if (report.imported.length) log?.info?.(`旧版人格导入了 ${report.imported.length} 张：${report.imported.join('、')}`)
      if (report.badId.length) log?.warn?.(`这些旧人格的文件名不能当 ID，没导入：${report.badId.join('、')}`)
      return report
    } catch (error) {
      storage.legacy.fail(step, error.message)
      throw error
    }
  }

  function init() {
    importLegacy()
    store.seed(readBundledDir(bundledDir, log))
    if (!store.bindings().some((b) => b.scope === 'global')) {
      const first = store.get(DEFAULT_ID)?.published ? DEFAULT_ID : store.list({ includeArchived: false }).find((p) => p.published)?.id
      if (first) store.bind('global', first)
    }
  }
  init()

  /** 这个聊天的人设快照：{ personaId, revision, bindingRevision, name, layers } 或 { error }。 */
  const snapshotFor = (chatId) => store.resolve(String(chatId || 'private:0'))

  /** 快照 → 提示词正文；快照有错时给中性说明。 */
  const textOf = (snap) => (snap && !snap.error ? compilePersona(snap.layers) : PERSONA_ERROR_TEXT)

  const globalId = () => store.bindings().find((b) => b.scope === 'global')?.personaId || ''

  // ---------- 面板旧接口（列表 / 读 / 存 / 删 / 设为当前）的兼容 ----------
  const legacyView = (p) => {
    const layers = p.draft?.layers || p.published?.layers
    return { id: p.id, name: p.name, tags: layers?.tags || [], body: layers?.legacy?.body ?? compilePersona(layers), editRevision: p.editRevision, archived: Boolean(p.archivedAt), revision: p.published?.revision || 0, hasDraft: Boolean(p.draft) }
  }
  const compat = {
    list: () => store.list({ includeArchived: false }).map((p) => { const v = legacyView(p); return { id: v.id, name: v.name, tags: v.tags, chars: v.body.length, revision: v.revision, hasDraft: v.hasDraft } }),
    read: (id) => { const p = store.get(String(id || '')); return p ? legacyView(p) : null },
    /** 旧面板的「保存」= 改正文后立刻发布新版本。 */
    save: (id, { name, tags, body, editRevision }) => {
      if (!String(body || '').trim()) throw new Error('人格内容不能是空的')
      const existing = store.get(String(id || ''))
      if (!existing) return legacyView(store.create({ id, name, layers: layersFromMarkdown({ name, body, tags }), origin: 'user', publish: true, note: '面板新建' }))
      const base = existing.draft?.layers || existing.published?.layers
      const layers = { ...base, legacy: { body }, tags: tags ?? base?.tags, identity: { ...(base?.identity || {}), name: name || existing.name } }
      store.saveDraft(id, { layers, name }, { editRevision: editRevision ?? existing.editRevision })
      return legacyView(store.publish(id, { note: '面板保存' }))
    },
    /** 删除 = 归档 + 删除（还在被绑定时拒绝）。 */
    remove: (id) => {
      const p = store.get(id)
      if (!p) return false
      if (!p.archivedAt) store.archive(id)
      store.remove(id)
      return true
    },
    use: (id) => store.bind('global', id),
  }

  return { store, snapshotFor, textOf, globalId, compat, init }
}

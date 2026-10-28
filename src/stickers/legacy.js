import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { mimeOf, imageSize } from '../chat/inbound.js'
import { hash } from './repository.js'

/** 仅在显式提供旧目录时读。旧 JSON/原文件不改动；未知来源只能进隔离区。 */
export function quarantineLegacy(repo, storage, directory, now) {
  if (!directory || !existsSync(join(directory, 'index.json'))) return { imported: 0, existing: 0, unavailable: 0 }
  const root = realpathSync(directory)
  const file = join(root, 'index.json')
  if (statSync(file).size > 10 * 1024 * 1024) throw new Error('旧表情索引过大，请分批导入')
  const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  if (!Array.isArray(parsed.items)) throw new Error('旧表情索引格式无效')
  const report = { imported: 0, existing: 0, unavailable: 0 }
  for (const [index, record] of parsed.items.entries()) {
    const sourceKey = hash(JSON.stringify({ file, md5: record.md5, path: record.file, ...(!record.md5 && !record.file ? { index } : {}) }))
    if (repo.db.get('SELECT id FROM sticker_legacy WHERE source_key=?', sourceKey)) { report.existing++; continue }
    let asset = null
    let error = null
    try {
      const p = realpathSync(resolve(root, String(record.file || '')))
      if (!p.toLowerCase().startsWith((root + sep).toLowerCase())) throw new Error('旧文件路径越界')
      if (statSync(p).size > 5 * 1024 * 1024) throw new Error('旧图片过大')
      const buf = readFileSync(p)
      const mime = mimeOf(buf)
      if (!mime.startsWith('image/')) throw new Error('旧文件不是可识别图片')
      asset = storage.assets.put(buf, { mime, ...imageSize(buf), sourceKind: 'legacy' })
    } catch (e) { error = e.message; report.unavailable++ }
    const id = `stl_${sourceKey}`
    const entry = { id, state: 'quarantined', sourceKey, legacy: record, assetId: asset?.id || null,
      reason: '旧 JSON 没有可验证的账号/聊天授权，须管理员分配', error, at: now() }
    repo.db.run("INSERT OR IGNORE INTO sticker_legacy(id,source_key,state,body_json,created_at,updated_at) VALUES (?,?,'quarantined',?,?,?)",
      id, sourceKey, JSON.stringify(entry), now(), now())
    report.imported++
  }
  return report
}

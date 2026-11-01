// 人设固定外观参考图：单独登记归属，不依赖按字节去重后可能沿用的 source_kind。
// 已发布人设和任务只保存资产 ID；资产内容按散列校验，失效时明确失败。
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { imageInfo, MAX_IMAGE_BYTES, ProviderError } from '../providers/image/common.js'

const DEFAULT_IMAGE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'dafeiyu.jpg')
const MAX_UPLOAD = 5 * 1024 * 1024
const MAX_PIXELS = 50_000_000
const fail = (message, code = 'INVALID_REFERENCE') => Object.assign(new Error(message), { code })
const idsOf = layers => [
  ...(Array.isArray(layers?.appearance?.referenceAssetIds) ? layers.appearance.referenceAssetIds : []),
  ...(Array.isArray(layers?.appearance?.referenceVariants) ? layers.appearance.referenceVariants.map(v => v?.assetId).filter(Boolean) : []),
]
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

/** Read and verify actual stored bytes, including the content-addressed identity. */
export function readReferenceAsset(storage, id) {
  const asset = storage.assets.get(id)
  if (!asset || asset.state !== 'stored') throw fail('参考图找不到了，请重新选择')
  let bytes, info
  try {
    const path = storage.assets.pathOf(asset), size = statSync(path).size
    if (size !== asset.bytes || size <= 0 || size > MAX_IMAGE_BYTES) throw new Error('图片大小不正确')
    bytes = readFileSync(path)
    info = imageInfo(bytes)
    if (sha256(bytes) !== asset.sha256 || info.mime !== asset.mime) throw new Error('资产内容已变化')
  } catch {
    throw fail('参考图文件缺失、损坏或内容已变化，请重新选择')
  }
  return { asset, bytes, info }
}

// Repair is allowed only from independently supplied bytes matching the existing
// asset's full content address and a conventional store-relative filename.
function putReference(storage, bytes, info, sourceKind) {
  const asset = storage.assets.put(bytes, { ...info, sourceKind })
  try { readReferenceAsset(storage, asset.id); return asset } catch {}
  const sha = sha256(bytes)
  if (asset.sha256 !== sha || asset.mime !== info.mime || !new RegExp(`^${sha.slice(0, 2)}[/\\\\]${sha}\\.(?:png|jpg|gif|webp)$`).test(asset.path)) {
    throw fail('参考图资产不可用，请换一张图片')
  }
  const target = storage.assets.pathOf(asset), temp = `${target}.${randomUUID()}.tmp`
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(temp, bytes, { flag: 'wx' })
    renameSync(temp, target)
    return readReferenceAsset(storage, asset.id).asset
  } catch {
    try { unlinkSync(temp) } catch {}
    throw fail('参考图资产无法修复，请检查存储目录')
  }
}

/** Copy the shipped portrait to the normal immutable asset store on first use. */
export function ensureDefaultReference(storage, { file = DEFAULT_IMAGE } = {}) {
  let bytes, info
  try {
    bytes = readFileSync(file)
    info = imageInfo(bytes)
    if (info.width * info.height > MAX_PIXELS) throw new Error('图片过大')
  } catch {
    throw fail('大肥鱼的默认外观参考图缺失或损坏，请在人格面板上传参考图')
  }
  const asset = putReference(storage, bytes, info, 'persona-default')
  try { return readReferenceAsset(storage, asset.id).asset }
  catch { throw fail('大肥鱼的默认外观参考图资产缺失或损坏，请在人格面板上传参考图') }
}

function decodeUpload(data) {
  if (typeof data !== 'string' || data.length > 4 * Math.ceil(MAX_UPLOAD / 3) + 64) throw fail('参考图不能超过 5 MB', 'BAD_IMAGE')
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(data)
  if (!match || match[2].length % 4 !== 0) throw fail('请上传有效的 PNG、JPEG、GIF 或 WebP 图片', 'BAD_IMAGE')
  const bytes = Buffer.from(match[2], 'base64')
  if (!bytes.length || bytes.length > MAX_UPLOAD) throw fail('参考图不能超过 5 MB', 'BAD_IMAGE')
  let info
  try { info = imageInfo(bytes) } catch { throw fail('参考图已损坏或格式不支持', 'BAD_IMAGE') }
  if (info.mime !== match[1].toLowerCase()) throw fail('图片格式与文件内容不一致', 'BAD_IMAGE')
  if (info.width * info.height > MAX_PIXELS) throw fail('图片不能超过 5000 万像素', 'BAD_IMAGE')
  return { bytes, info }
}

/** Library IDs are associated explicitly with a persona, including deduplicated uploads. */
export function createPersonaReferences({ storage, store, defaultFile = DEFAULT_IMAGE }) {
  const key = id => `persona.references:${id}`
  const registered = id => {
    const value = storage.meta.get(key(id), [])
    return Array.isArray(value) ? value.filter(x => typeof x === 'string' && x) : []
  }
  const requirePersona = (id, { editable = false } = {}) => {
    store.checkId(id)
    const persona = store.get(id)
    if (!persona) throw fail('没有这个人设', 'NOT_FOUND')
    if (editable && persona.archivedAt) throw fail('这张卡已归档，先取消归档再上传', 'ARCHIVED')
    return persona
  }
  const mentioned = (id, persona) => {
    const values = [...idsOf(persona.draft?.layers), ...idsOf(persona.published?.layers)]
    for (const r of store.revisions(id)) values.push(...idsOf(store.revision(id, r.revision)?.layers))
    return [...new Set(values)]
  }
  // One-time grandfathering of references explicitly saved before this feature.
  // Future creates/imports cannot turn arbitrary asset IDs into library grants.
  if (!storage.meta.get('persona.referenceRegistryVersion')) {
    storage.db.tx(() => {
      for (const persona of store.list()) storage.meta.set(key(persona.id), [...new Set([...registered(persona.id), ...mentioned(persona.id, persona)])])
      storage.meta.set('persona.referenceRegistryVersion', 1)
    })
  }
  const defaultFor = id => id === 'dafeiyu' ? ensureDefaultReference(storage, { file: defaultFile }) : null
  const view = (id, authorized = true) => {
    if (!authorized) return { id, available: false, mime: null, sourceKind: null, createdAt: null, reason: '请重新上传以授权当前人设使用' }
    try {
      const { asset, info } = readReferenceAsset(storage, id)
      return { id, available: true, mime: info.mime, sourceKind: asset.sourceKind, createdAt: asset.createdAt }
    } catch { return { id, available: false, mime: null, sourceKind: null, createdAt: null } }
  }
  function list(id) {
    const persona = requirePersona(id)
    let defaultAssetId = null
    try { defaultAssetId = defaultFor(id)?.id || null } catch { /* shown as unavailable */ }
    const grants = registered(id)
    const ids = [...new Set([...grants, ...idsOf(persona.draft?.layers), ...idsOf(persona.published?.layers)])]
    if (defaultAssetId && !ids.includes(defaultAssetId)) ids.unshift(defaultAssetId)
    return { items: ids.map(assetId => ({ ...view(assetId, grants.includes(assetId) || assetId === defaultAssetId), inLibrary: grants.includes(assetId) })), defaultAssetId, useDefaultReferenceAvailable: id === 'dafeiyu' }
  }
  function upload(id, data) {
    requirePersona(id, { editable: true })
    const { bytes, info } = decodeUpload(data)
    const ids = registered(id)
    const asset = putReference(storage, bytes, info, 'persona-reference')
    if (!ids.includes(asset.id)) {
      storage.meta.set(key(id), [...ids, asset.id])
    }
    return view(asset.id)
  }
  function asset(id, assetId) {
    requirePersona(id)
    let defaultAssetId = null
    try { defaultAssetId = defaultFor(id)?.id || null } catch {}
    if (!registered(id).includes(assetId) && assetId !== defaultAssetId) throw fail('没有这张人设参考图', 'NOT_FOUND')
    return readReferenceAsset(storage, assetId)
  }
  function assertSelection(id, layers) {
    requirePersona(id)
    const allowed = new Set(registered(id))
    if (idsOf(layers).some(assetId => !allowed.has(assetId))) {
      try { const builtin = defaultFor(id); if (builtin) allowed.add(builtin.id) } catch {}
    }
    if (idsOf(layers).some(assetId => !allowed.has(assetId))) throw fail('请先在当前人设的参考图库上传图片，再保存选择')
  }
  // Called in the same transaction as saveDraft after assertSelection. This
  // freezes a deliberately chosen builtin as a grant for immutable revisions.
  function grantSelection(id, layers) {
    const grants = registered(id)
    if (!idsOf(layers).some(assetId => !grants.includes(assetId))) return
    const builtin = defaultFor(id)
    if (builtin && idsOf(layers).includes(builtin.id) && !grants.includes(builtin.id)) {
      storage.meta.set(key(id), [...grants, builtin.id])
    }
  }
  function assertLayersUsable(id, layers) {
    requirePersona(id)
    const appearance = layers?.appearance
    const activeIds = appearance?.referenceVariants?.length ? appearance.referenceVariants.map(v => v.assetId) : (appearance?.referenceAssetIds || [])
    for (const assetId of activeIds) {
      try {
        if (!registered(id).includes(assetId)) throw new Error('未授权')
        readReferenceAsset(storage, assetId)
      }
      catch { throw fail('已选的人设参考图缺失或损坏，请重新上传或取消选择后再发布') }
    }
  }
  function assertPublish(id) { assertLayersUsable(id, requirePersona(id).draft?.layers) }
  function copyGrants(fromId, toId) {
    requirePersona(fromId); requirePersona(toId)
    storage.meta.set(key(toId), [...registered(fromId)])
  }
  return { list, upload, asset, defaultFor, assertSelection, grantSelection, assertPublish, assertLayersUsable, copyGrants }
}

/** Keep local file errors as known, uncharged input failures. */
export function imageReferenceBytes(storage, id) {
  try { return readReferenceAsset(storage, id) }
  catch (error) { throw new ProviderError('invalid', error.message || '参考图不可用', { maybeCharged: false }) }
}

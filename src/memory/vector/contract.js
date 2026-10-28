import { createHash } from 'node:crypto'
import { fail, text, integer } from '../embedding/space.js'

export function normalizeFilter(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('SCOPE_REQUIRED', 'filter.account and explicit chat authorization are required')
  const allowed = ['account', 'chat', 'chats', 'category', 'categories', 'persona', 'personas', 'scopes']
  for (const key of Object.keys(input)) if (!allowed.includes(key)) fail('INVALID_FILTER', `Unknown filter field: ${key}`)
  const account = text(input.account, 'filter.account')
  const values = (single, multi, label, fallback) => {
    if (single !== undefined && multi !== undefined) fail('INVALID_FILTER', `Use either ${label} or its list form`)
    const list = multi ?? (single === undefined ? fallback : [single])
    if (list === undefined) return undefined
    if (!Array.isArray(list) || list.length > 1000) fail('INVALID_FILTER', `${label} list must have at most 1000 entries`)
    return [...new Set(list.map(v => text(v, label, { empty: label === 'persona' })))]
  }
  let scopes
  if (input.scopes !== undefined) {
    if (allowed.slice(1, 7).some(k => input[k] !== undefined)) fail('INVALID_FILTER', 'scopes cannot be mixed with flat scope fields')
    if (!Array.isArray(input.scopes) || input.scopes.length > 256) fail('INVALID_FILTER', 'scopes must be an array of at most 256 grants')
    scopes = input.scopes.map(s => {
      if (!s || Object.keys(s).some(k => !['chat', 'category', 'persona'].includes(k))) fail('INVALID_FILTER', 'Scope grants accept chat/category/persona only')
      return { chats: [text(s.chat, 'chat')], categories: s.category === undefined ? undefined : [text(s.category, 'category')], personas: [text(s.persona ?? '', 'persona', { empty: true })] }
    })
  } else {
    const chats = values(input.chat, input.chats, 'chat')
    if (!chats) fail('SCOPE_REQUIRED', 'Explicit chat/chats or scopes is required; unrestricted scans are forbidden')
    scopes = [{ chats, categories: values(input.category, input.categories, 'category'), personas: values(input.persona, input.personas, 'persona', ['']) }]
  }
  return { account, scopes }
}
export function allowedByFilter(record, filter) {
  return record.account === filter.account && filter.scopes.some(s => s.chats.includes(record.chat) && (!s.categories || s.categories.includes(record.category)) && s.personas.includes(record.persona))
}
export function normalizeIds(ids, max = 100000) {
  if (!Array.isArray(ids) || ids.length > max) fail('INVALID_CONTRACT', `ids must be an array of at most ${max}`)
  return [...new Set(ids.map(id => text(id, 'id')))]
}
export function normalizeRecord(record) {
  if (!record || typeof record !== 'object') fail('INVALID_CONTRACT', 'record must be an object')
  const out = { id: text(record.id, 'id'), sourceRevision: integer(record.sourceRevision, 'sourceRevision'), scopeRevision: integer(record.scopeRevision ?? 0, 'scopeRevision'), persona: text(record.persona ?? record.scope?.persona ?? '', 'persona', { empty: true }) }
  for (const key of ['account', 'chat', 'category']) out[key] = text(record[key] ?? record.scope?.[key], key)
  out.metadata = record.metadata ?? {}
  const encoded = JSON.stringify(out.metadata)
  if (!encoded || encoded.length > 16384) fail('INVALID_CONTRACT', 'metadata must be JSON, at most 16 KiB')
  out.metadata = JSON.parse(encoded)
  return out
}
// RFC 9562 UUIDv5, with a fixed application namespace and length-safe business key.
export function pointId(spaceId, id) {
  const namespace = Buffer.from('f4e56f19713b5ed4985763256816d7c8', 'hex')
  const bytes = createHash('sha1').update(namespace).update(JSON.stringify([spaceId, id])).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 15) | 80
  bytes[8] = (bytes[8] & 63) | 128
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
export function qdrantFilter(filter, spaceId, generation, ids) {
  const match = (key, list) => ({ key, match: list.length === 1 ? { value: list[0] } : { any: list } })
  const must = [match('account', [filter.account]), match('spaceId', [spaceId]), match('generation', [generation])]
  must.push({ should: filter.scopes.map(s => ({ must: [match('chat', s.chats), match('persona', s.personas), ...(s.categories ? [match('category', s.categories)] : [])] })) })
  if (ids !== undefined) must.push({ has_id: ids.map(id => pointId(spaceId, id)) })
  return { must }
}
export const queryLimit = value => integer(value ?? 10, 'limit', 1, 1000)

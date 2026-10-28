import { createHash } from 'node:crypto'

export class VectorError extends Error {
  constructor(code, message) { super(message); this.name = 'VectorError'; this.code = code }
}
export function fail(code, message) { throw new VectorError(code, message) }
export function text(value, label, { empty = false, max = 512 } = {}) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || value !== value.trim()) fail('INVALID_CONTRACT', `${label} must be a bounded string`)
  return value
}
export function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_CONTRACT', `${label} must be an integer in ${min}..${max}`)
  return value
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  return JSON.stringify(value)
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex')
function jsonObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_CONTRACT', `${label} must be a JSON object`)
  const encoded = JSON.stringify(value)
  if (encoded.length > 65536) fail('INVALID_CONTRACT', `${label} is too large`)
  return JSON.parse(encoded)
}
export function defineEmbeddingSpace(input) {
  if (!input || typeof input !== 'object') fail('INVALID_SPACE', 'An explicit embedding space is required')
  const space = {}
  for (const key of ['spaceId', 'provider', 'endpointIdentity', 'model', 'revision', 'protocolMappingVersion']) space[key] = text(input[key], key)
  space.dims = integer(input.dims, 'dims', 1, 65536)
  if (!['cosine', 'dot', 'euclidean'].includes(input.metric)) fail('INVALID_SPACE', 'metric must be cosine, dot or euclidean')
  space.metric = input.metric
  if (!Array.isArray(input.modalities) || !input.modalities.length || input.modalities.some(m => !['text', 'image'].includes(m)) || new Set(input.modalities).size !== input.modalities.length) fail('INVALID_SPACE', 'modalities must explicitly declare text and/or image')
  space.modalities = [...input.modalities].sort()
  if (!['none', 'l2'].includes(input.normalization)) fail('INVALID_SPACE', 'normalization must be none or l2')
  space.normalization = input.normalization
  // Prefix whitespace is meaningful (e.g. "query: ").
  if (!input.prefixes || ['query', 'document'].some(k => typeof input.prefixes[k] !== 'string' || input.prefixes[k].length > 4096)) fail('INVALID_SPACE', 'Explicit query/document prefixes are required')
  space.prefixes = { query: input.prefixes.query, document: input.prefixes.document }
  space.preprocess = jsonObject(input.preprocess, 'preprocess')
  for (const modality of space.modalities) if (!space.preprocess[modality] || typeof space.preprocess[modality] !== 'object') fail('INVALID_SPACE', `preprocess.${modality} must be declared`)
  return deepFreeze(space)
}
function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value) }
  return value
}
export const spaceFingerprint = space => digest(defineEmbeddingSpace(space))
export function validateVector(input, space) {
  let vector = input
  if (input && !Array.isArray(input) && !ArrayBuffer.isView(input) && 'vector' in input) {
    if (input.spaceId !== space.spaceId) fail('SPACE_MISMATCH', 'Embedding and index spaceId differ')
    if (input.fingerprint && input.fingerprint !== spaceFingerprint(space)) fail('SPACE_MISMATCH', 'Embedding contract differs')
    vector = input.vector
  }
  if ((!Array.isArray(vector) && !(vector instanceof Float32Array) && !(vector instanceof Float64Array)) || vector.length !== space.dims) fail('INVALID_VECTOR', `Expected ${space.dims} dimensions`)
  const out = new Float32Array(space.dims)
  let norm2 = 0
  for (let i = 0; i < out.length; i++) {
    if (typeof vector[i] !== 'number' || !Number.isFinite(vector[i])) fail('INVALID_VECTOR', 'Vector values must be finite numbers')
    out[i] = vector[i]
    if (!Number.isFinite(out[i])) fail('INVALID_VECTOR', 'Vector overflows Float32')
    norm2 += out[i] * out[i]
  }
  if (!(norm2 > 0) || !Number.isFinite(norm2)) fail('INVALID_VECTOR', 'Vector must be finite and nonzero in Float32')
  if (space.normalization === 'l2') {
    const norm = Math.sqrt(norm2)
    for (let i = 0; i < out.length; i++) out[i] /= norm
  }
  return out
}
export function vectorScore(a, b, metric) {
  let dot = 0, aa = 0, bb = 0, distance = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    if (metric === 'cosine') { aa += a[i] * a[i]; bb += b[i] * b[i] }
    if (metric === 'euclidean') distance += (a[i] - b[i]) ** 2
  }
  return metric === 'cosine' ? dot / Math.sqrt(aa * bb) : metric === 'euclidean' ? -Math.sqrt(distance) : dot
}

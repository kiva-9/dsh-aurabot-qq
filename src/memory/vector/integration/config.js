import { defineEmbeddingSpace, fail, integer, text } from '../../embedding/space.js'
import { httpBase } from '../../embedding/http.js'
import { RERANKER_SCHEMA, rerankerConfig } from './reranker.js'

const string = { type: 'string' }
const bounded = (minimum, maximum, defaultValue) => ({ type: 'integer', minimum, maximum, ...(defaultValue === undefined ? {} : { default: defaultValue }) })
const spaceSchema = {
  type: 'object', additionalProperties: false,
  required: ['spaceId', 'provider', 'endpointIdentity', 'model', 'revision', 'dims', 'metric', 'modalities', 'prefixes', 'normalization', 'preprocess', 'protocolMappingVersion'],
  properties: {
    spaceId: string, provider: string, endpointIdentity: string, model: string, revision: string,
    dims: bounded(1, 65536), metric: { enum: ['cosine', 'dot', 'euclidean'] },
    modalities: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { enum: ['text', 'image'] } },
    prefixes: { type: 'object', additionalProperties: false, required: ['query', 'document'], properties: { query: string, document: string } },
    normalization: { enum: ['none', 'l2'] }, preprocess: { type: 'object' }, protocolMappingVersion: string,
  },
}
const roleSchema = {
  type: 'object', additionalProperties: false, required: ['type', 'space', 'baseUrl'],
  properties: {
    type: { enum: ['openai-text', 'fixed-http'] }, space: spaceSchema, baseUrl: string,
    apiKey: { type: 'string', writeOnly: true, 'x-secret': true }, sendDimensions: { type: 'boolean', default: false },
    timeoutMs: bounded(1, 300000, 15000), maxResponseBytes: bounded(128, 134217728, 16777216), maxBatch: bounded(2, 256, 128),
    probeTolerance: { type: 'number', minimum: 0, maximum: 0.01, default: 1e-5 },
    mapping: { type: 'object' }, samples: { type: 'object', properties: { text: { type: 'array', minItems: 2, maxItems: 8, items: string }, image: { type: 'array', minItems: 2, maxItems: 8 } }, additionalProperties: false },
    alignmentPairs: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: false, required: ['text', 'positiveImage', 'negativeImage'], properties: { text: bounded(0, 7), positiveImage: bounded(0, 7), negativeImage: bounded(0, 7), margin: { type: 'number', minimum: 0 } } } },
  },
}

/** Panel schema; structural validation is performed by validateMemoryVectorConfig below. */
export const MEMORY_VECTOR_CONFIG_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false,
  required: ['version', 'index', 'roles'],
  properties: {
    version: { const: 1 },
    index: { type: 'object', additionalProperties: false, required: ['path'], properties: {
      backend: { enum: ['local', 'qdrant'], default: 'local' }, path: { type: 'string', minLength: 1 }, baseUrl: string,
      apiKey: { type: 'string', writeOnly: true, 'x-secret': true }, collectionPrefix: { type: 'string', pattern: '^[a-zA-Z0-9_-]+$', maxLength: 80, default: 'aurabot' },
      timeoutMs: bounded(1, 300000, 15000), cacheBytes: bounded(0, 1073741824, 8388608), pageSize: bounded(1, 4096, 256), maxPending: bounded(1, 1024, 32),
      maxResponseBytes: bounded(128, 134217728, 16777216),
    }, allOf: [{ if: { properties: { backend: { const: 'qdrant' } }, required: ['backend'] }, then: { required: ['baseUrl'] } }] },
    roles: { type: 'object', additionalProperties: false, properties: { text: roleSchema, image: roleSchema, joint: roleSchema } },
    reranker: RERANKER_SCHEMA,
    queue: { type: 'object', additionalProperties: false, properties: { batchSize: bounded(1, 128, 32), maxPending: bounded(1, 4096, 256), maxAttempts: bounded(1, 10, 3) } },
    retrieval: { type: 'object', additionalProperties: false, properties: { maxCandidates: bounded(1, 10000, 5000), lexicalLimit: bounded(1, 1000, 80), vectorLimit: bounded(1, 1000, 80), rrfK: bounded(1, 1000, 60), limit: bounded(1, 1000, 10) } },
  },
}

function check(value, schema, path) {
  if (schema.const !== undefined && value !== schema.const) fail('INVALID_CONFIG', `${path} must equal ${schema.const}`)
  if (schema.enum && !schema.enum.includes(value)) fail('INVALID_CONFIG', `${path} is not supported`)
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_CONFIG', `${path} must be an object`)
    for (const key of schema.required ?? []) if (value[key] === undefined) fail('INVALID_CONFIG', `${path}.${key} is required`)
    for (const [key, item] of Object.entries(value)) {
      if (!schema.properties?.[key]) { if (schema.additionalProperties === false) fail('INVALID_CONFIG', `${path}.${key} is not supported`); continue }
      check(item, schema.properties[key], `${path}.${key}`)
    }
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) fail('INVALID_CONFIG', `${path} has invalid array length`)
    if (schema.items) value.forEach((item, i) => check(item, schema.items, `${path}[${i}]`))
    if (schema.uniqueItems && new Set(value).size !== value.length) fail('INVALID_CONFIG', `${path} must be unique`)
  }
  if (schema.type === 'integer') integer(value, path, schema.minimum ?? 0, schema.maximum ?? Number.MAX_SAFE_INTEGER)
  if (schema.type === 'number' && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) fail('INVALID_CONFIG', `${path} must be finite and within range`)
  if (schema.type === 'boolean' && typeof value !== 'boolean') fail('INVALID_CONFIG', `${path} must be boolean`)
  if (schema.type === 'string' && (typeof value !== 'string' || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? 8192) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) fail('INVALID_CONFIG', `${path} must be a valid bounded string`)
}
export function validateMemoryVectorConfig(input) {
  check(input, MEMORY_VECTOR_CONFIG_SCHEMA, 'config')
  const result = structuredClone(input)
  result.index = { backend: 'local', ...result.index }
  text(result.index.path, 'index.path', { max: 8192 })
  if (result.index.backend === 'qdrant') result.index.baseUrl = httpBase(result.index.baseUrl)
  result.queue = { batchSize: 32, maxPending: 256, maxAttempts: 3, ...result.queue }
  result.retrieval = { maxCandidates: 5000, lexicalLimit: 80, vectorLimit: 80, rrfK: 60, limit: 10, ...result.retrieval }
  result.reranker = rerankerConfig(result.reranker)
  const ids = new Set()
  for (const [role, definition] of Object.entries(result.roles)) {
    definition.probeTolerance ??= 1e-5
    definition.space = defineEmbeddingSpace(definition.space)
    definition.baseUrl = httpBase(definition.baseUrl)
    if (ids.has(definition.space.spaceId)) fail('INVALID_CONFIG', 'Each role uses a distinct spaceId; configure a joint role for aligned modalities')
    ids.add(definition.space.spaceId)
    const expected = role === 'joint' ? ['text', 'image'] : [role === 'image' ? 'image' : 'text']
    if (definition.space.modalities.length !== expected.length || expected.some(m => !definition.space.modalities.includes(m))) fail('INVALID_CONFIG', `Role ${role} has incompatible modalities`)
    if (definition.type === 'openai-text' && role !== 'text') fail('INVALID_CONFIG', 'Image/joint roles require a fixed-http mapping')
    if (definition.type === 'fixed-http' && !definition.mapping) fail('INVALID_CONFIG', 'fixed-http requires mapping')
  }
  return result
}

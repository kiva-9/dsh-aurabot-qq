import { MEMORY_VECTOR_CONFIG_SCHEMA, validateMemoryVectorConfig } from './config.js'
import { fail, digest } from '../../embedding/space.js'
import { RERANKER_DEFAULTS } from './reranker.js'

export const RETRIEVAL_DEFAULTS = Object.freeze({
  enabled: false, version: 1,
  index: Object.freeze({ backend: 'local', cacheBytes: 8388608, pageSize: 256, maxPending: 32, timeoutMs: 15000, collectionPrefix: 'aurabot' }),
  roles: Object.freeze({}),
  queue: Object.freeze({ batchSize: 32, maxPending: 256, maxAttempts: 3 }),
  retrieval: Object.freeze({ maxCandidates: 5000, lexicalLimit: 80, vectorLimit: 80, rrfK: 60, limit: 10 }),
  sync: Object.freeze({ intervalMs: 60000, pageSize: 128, maxJobsPerTick: 8, scopesPerTick: 8 }),
  images: Object.freeze({ maxBytes: 6 * 1024 * 1024 }),
  reranker: RERANKER_DEFAULTS,
})
export const RETRIEVAL_SECRET_FIELDS = Object.freeze(['retrieval.index.apiKey', 'retrieval.roles.text.apiKey', 'retrieval.roles.image.apiKey', 'retrieval.roles.joint.apiKey', 'retrieval.reranker.apiKey'])
const schema = structuredClone(MEMORY_VECTOR_CONFIG_SCHEMA)
delete schema.properties.index.properties.path
schema.properties.index.required = []
schema.required = ['enabled', 'version', 'index', 'roles']
schema.properties.enabled = { type: 'boolean', default: false }
schema.properties.sync = { type: 'object', additionalProperties: false, properties: {
  intervalMs: { type: 'integer', minimum: 1000, maximum: 3600000, default: 60000 },
  pageSize: { type: 'integer', minimum: 1, maximum: 500, default: 128 },
  maxJobsPerTick: { type: 'integer', minimum: 1, maximum: 32, default: 8 },
  scopesPerTick: { type: 'integer', minimum: 1, maximum: 64, default: 8 },
} }
schema.properties.images = { type: 'object', additionalProperties: false, properties: { maxBytes: { type: 'integer', minimum: 1024, maximum: 6291456, default: 6291456 } } }
for (const role of ['image', 'joint']) schema.properties.roles.properties[role] = { ...structuredClone(schema.properties.roles.properties[role]), allOf: [{ properties: {
  mapping: { type: 'object', required: ['inputs'], properties: { inputs: { type: 'object', required: ['image'], properties: { image: { type: 'object', required: ['representation'], properties: { representation: { const: 'data-url' } } } } } } },
} }] }
export const RETRIEVAL_CONFIG_SCHEMA = schema

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const bounded = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Math.trunc(Number(value)))) : fallback
export function normalizeRetrievalConfig(value = {}) {
  const input = object(value), defaults = structuredClone(RETRIEVAL_DEFAULTS)
  const out = { ...defaults, enabled: input.enabled === true, version: 1 }
  for (const section of ['index', 'queue', 'retrieval', 'sync', 'images', 'reranker']) {
    const properties = RETRIEVAL_CONFIG_SCHEMA.properties[section].properties
    for (const [key, item] of Object.entries(object(input[section]))) {
      const field = properties[key]
      if (!field) continue // index.path is deliberately never persisted or used.
      if (field.type === 'integer') out[section][key] = bounded(item, defaults[section][key] ?? field.default, field.minimum, field.maximum)
      else if (field.enum) out[section][key] = field.enum.includes(item) ? item : defaults[section][key] ?? field.default
      else if (field.type === 'string' && typeof item === 'string') out[section][key] = item.slice(0, key === 'apiKey' ? 8192 : 4096)
      else if (field.type === 'boolean') out[section][key] = item === true
      else if (section === 'reranker' && key === 'budget') for (const [budgetKey, value] of Object.entries(object(item))) {
        const spec = field.properties[budgetKey]
        if (spec) out.reranker.budget[budgetKey] = bounded(value, spec.default, spec.minimum, spec.maximum)
      }
    }
  }
  for (const role of ['text', 'image', 'joint']) {
    const candidate = object(input.roles?.[role])
    if (!Object.keys(candidate).length) continue
    out.roles[role] = structuredClone(candidate)
    if (candidate.probeTolerance === undefined) out.roles[role].probeTolerance = 1e-5
    if (typeof candidate.apiKey !== 'string') delete out.roles[role].apiKey
  }
  return out
}

/** Semantic validation is deferred until enabled, so incomplete disabled UI drafts remain editable. */
export function runtimeRetrievalConfig(config, path) {
  if (!config.enabled) fail('RETRIEVAL_DISABLED', '检索模块未启用')
  for (const role of ['image', 'joint']) if (config.roles[role] && config.roles[role].mapping?.inputs?.image?.representation !== 'data-url') fail('INVALID_CONFIG', `retrieval.roles.${role}.mapping.inputs.image.representation 必须为 data-url；内置资产不会暴露本地路径或公开下载链接`)
  return validateMemoryVectorConfig({ version: 1, index: { ...config.index, path }, roles: config.roles, queue: config.queue, retrieval: config.retrieval, reranker: config.reranker })
}
export const retrievalIdentity = config => digest([config.index.backend, config.index.backend === 'qdrant' ? config.index.baseUrl : '', config.index.collectionPrefix]).slice(0, 20)
export const retrievalConfigFingerprint = config => digest(config)

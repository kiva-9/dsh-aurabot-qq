import { defineEmbeddingSpace, spaceFingerprint, validateVector, vectorScore, digest, canonical, fail, integer } from './space.js'
import { httpBase, requestJson } from './http.js'

function preprocessText(input, space, purpose) {
  if (typeof input !== 'string' || !input.trim() || input.length > 1000000) fail('INVALID_INPUT', 'Text input must be a nonempty bounded string')
  const p = space.preprocess.text
  if (Object.keys(p).some(k => !['version', 'unicode', 'trim', 'lowercase'].includes(k))) fail('UNSUPPORTED_PREPROCESS', 'Text preprocessing accepts version/unicode/trim/lowercase')
  if (p.unicode && !['none', 'NFC', 'NFKC', 'NFD', 'NFKD'].includes(p.unicode)) fail('UNSUPPORTED_PREPROCESS', 'Unknown Unicode normalization')
  let value = p.unicode && p.unicode !== 'none' ? input.normalize(p.unicode) : input
  if (p.trim) value = value.trim()
  if (p.lowercase) value = value.toLowerCase()
  return space.prefixes[purpose] + value
}
function checkInputs(inputs, maxBatch) {
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > maxBatch) fail('INVALID_INPUT', `inputs must contain 1..${maxBatch} items`)
}
function closeVector(a, b, tolerance) {
  if (a.length !== b.length) return false
  return a.every((value, i) => Math.abs(value - b[i]) <= tolerance * Math.max(1, Math.abs(value), Math.abs(b[i])))
}

class GuardedEncoder {
  constructor(options) {
    this.space = defineEmbeddingSpace(options.space)
    this.fingerprint = spaceFingerprint(this.space)
    this.baseUrl = httpBase(options.baseUrl)
    this.apiKey = options.apiKey
    this.httpOptions = { timeoutMs: options.timeoutMs ?? 15000, maxResponseBytes: options.maxResponseBytes ?? 16 * 1024 * 1024 }
    this.maxBatch = integer(options.maxBatch ?? 128, 'maxBatch', 2, 256)
    this.onDrift = options.onDrift
    this.baseline = options.probeBaseline ? structuredClone(options.probeBaseline) : null
    this.state = { ready: false, needsRebuild: false, alignment: 'not_evaluated', reason: 'probe_required' }
    this.probing = false
  }
  async _drift(reason) {
    this.state = { ...this.state, ready: false, needsRebuild: true, reason }
    if (this.onDrift) await this.onDrift({ spaceId: this.space.spaceId, reason })
  }
  async _request(path, body, signal) {
    return requestJson(`${this.baseUrl}${path}`, { ...this.httpOptions, method: 'POST', body, signal, headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {} })
  }
  async _checked(inputs, modality, purpose, signal) {
    if (!this.space.modalities.includes(modality)) fail('UNSUPPORTED_MODALITY', 'Modality is not declared in this space')
    if (!['query', 'document'].includes(purpose)) fail('INVALID_INPUT', 'purpose must be query or document')
    checkInputs(inputs, this.maxBatch)
    const response = await this._raw(inputs, modality, purpose, signal)
    if (response.model !== undefined && response.model !== this.space.model) { await this._drift('provider_model_changed'); fail('EMBEDDING_DRIFT', 'Provider model differs from registered space') }
    if (response.revision !== undefined && response.revision !== this.space.revision) { await this._drift('provider_revision_changed'); fail('EMBEDDING_DRIFT', 'Provider revision differs from registered space') }
    if (!Array.isArray(response.vectors) || response.vectors.length !== inputs.length) fail('INVALID_EMBEDDING_RESPONSE', 'Embedding count differs from input count')
    try { return response.vectors.map(v => validateVector(v, this.space)) }
    catch (error) { await this._drift('invalid_vector_contract'); throw error }
  }
  async encode({ inputs, modality = 'text', purpose = 'document', signal } = {}) {
    if (this.state.needsRebuild) fail('REBUILD_REQUIRED', 'Encoder drift requires a new space and rebuilt index')
    if (!this.state.ready || this.probing) fail('PROBE_REQUIRED', 'Run a successful admission probe before encoding')
    const vectors = await this._checked(inputs, modality, purpose, signal)
    // A concurrent probe may revoke the encoder while the request is in flight.
    if (!this.state.ready || this.state.needsRebuild || this.probing) fail('REBUILD_REQUIRED', 'Encoder was revoked while this request was in flight')
    return { spaceId: this.space.spaceId, fingerprint: this.fingerprint, model: this.space.model, revision: this.space.revision, vectors, modality, purpose }
  }
  health() { return { spaceId: this.space.spaceId, fingerprint: this.fingerprint, ...this.state } }
  async probe({ samples, tolerance = 1e-5, alignmentPairs = [], signal } = {}) {
    if (this.probing) fail('PROBE_BUSY', 'A probe is already running')
    if (this.state.needsRebuild) fail('REBUILD_REQUIRED', 'Drift is latched; create a new space/encoder')
    if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 0.01) fail('INVALID_PROBE', 'tolerance must be in 0..0.01')
    const probeSamples = samples ?? { text: ['Aurabot admission probe one', 'Aurabot admission probe two'] }
    for (const modality of this.space.modalities) if (!Array.isArray(probeSamples[modality]) || probeSamples[modality].length < 2 || probeSamples[modality].length > 8) fail('INVALID_PROBE', `Supply 2..8 stable ${modality} probe inputs`)
    const sampleHash = digest(probeSamples)
    if (this.baseline && (this.baseline.fingerprint !== this.fingerprint || this.baseline.sampleHash !== sampleHash)) fail('PROBE_BASELINE_MISMATCH', 'Use the original contract and probe samples when checking drift')
    this.probing = true; this.state.ready = false
    try {
      const vectors = {}
      for (const modality of this.space.modalities) {
        vectors[modality] = {}
        for (const purpose of ['document', 'query']) {
          const batch = await this._checked(probeSamples[modality], modality, purpose, signal)
          const repeated = await this._checked([probeSamples[modality][0], probeSamples[modality][0]], modality, purpose, signal)
          let inconsistent = repeated.some(v => !closeVector(v, batch[0], tolerance))
          for (let i = 0; i < probeSamples[modality].length; i++) {
            const single = await this._checked([probeSamples[modality][i]], modality, purpose, signal)
            inconsistent ||= !closeVector(single[0], batch[i], tolerance)
          }
          if (inconsistent) {
            await this._drift('batch_or_repeat_inconsistency'); fail('EMBEDDING_DRIFT', 'Repeated and single/batch encodings are inconsistent')
          }
          const previous = this.baseline?.vectors?.[modality]?.[purpose]
          if (this.baseline && (!previous || previous.length !== batch.length || batch.some((v, i) => !closeVector(v, previous[i], tolerance)))) {
            await this._drift('probe_vector_changed'); fail('EMBEDDING_DRIFT', 'Known probe vectors changed; rebuild with a new space')
          }
          vectors[modality][purpose] = batch.map(v => Array.from(v))
        }
      }
      let alignment = 'not_evaluated'
      if (alignmentPairs.length) {
        if (!this.space.modalities.includes('text') || !this.space.modalities.includes('image')) fail('INVALID_PROBE', 'Cross-modal pairs require a joint space')
        for (const pair of alignmentPairs) {
          integer(pair.text, 'pair.text', 0, vectors.text.query.length - 1)
          integer(pair.positiveImage, 'pair.positiveImage', 0, vectors.image.document.length - 1)
          integer(pair.negativeImage, 'pair.negativeImage', 0, vectors.image.document.length - 1)
          const margin = pair.margin ?? 0
          if (!Number.isFinite(margin) || margin < 0 || pair.positiveImage === pair.negativeImage) fail('INVALID_PROBE', 'Alignment pairs need distinct labels and a finite nonnegative margin')
          const q = vectors.text.query[pair.text]
          if (vectorScore(q, vectors.image.document[pair.positiveImage], this.space.metric) <= vectorScore(q, vectors.image.document[pair.negativeImage], this.space.metric) + margin) fail('ALIGNMENT_UNVERIFIED', 'Labeled cross-modal positive/negative probe did not pass')
        }
        alignment = 'passed_supplied_samples'
      }
      this.baseline = { fingerprint: this.fingerprint, sampleHash, vectors, tolerance }
      this.state = { ready: true, needsRebuild: false, alignment, reason: null }
      return { ...this.health(), baseline: structuredClone(this.baseline) }
    } catch (error) { this.state.ready = false; if (!this.state.needsRebuild) this.state.reason = error.code ?? 'probe_failed'; throw error }
    finally { this.probing = false }
  }
}

export class OpenAITextEmbedding extends GuardedEncoder {
  constructor(options) {
    super(options)
    if (this.space.modalities.length !== 1 || this.space.modalities[0] !== 'text') fail('UNSUPPORTED_MODALITY', 'OpenAI-compatible /embeddings is a text-only adapter')
    if (this.space.protocolMappingVersion !== 'openai-text-v1') fail('MAPPING_VERSION_MISMATCH', 'Text adapter requires protocolMappingVersion=openai-text-v1')
    this.sendDimensions = options.sendDimensions === true
  }
  async _raw(inputs, modality, purpose, signal) {
    if (modality !== 'text') fail('UNSUPPORTED_MODALITY', '/embeddings does not imply image support')
    const body = { model: this.space.model, input: inputs.map(input => preprocessText(input, this.space, purpose)), encoding_format: 'float' }
    if (this.sendDimensions) body.dimensions = this.space.dims
    const response = await this._request('/embeddings', body, signal)
    if (typeof response.model !== 'string' || !Array.isArray(response.data) || response.data.length !== inputs.length) fail('INVALID_EMBEDDING_RESPONSE', 'Expected response model and one indexed embedding per input')
    const vectors = Array(inputs.length), seen = new Set()
    for (const row of response.data) {
      integer(row.index, 'embedding.index', 0, inputs.length - 1)
      if (seen.has(row.index)) fail('INVALID_EMBEDDING_RESPONSE', 'Duplicate embedding response index')
      seen.add(row.index); vectors[row.index] = row.embedding
    }
    return { vectors, model: response.model }
  }
}

const safePath = path => {
  if (typeof path !== 'string' || !/^[a-zA-Z_][\w]*(?:\.(?:[a-zA-Z_][\w]*|\d+))*$/.test(path) || path.split('.').some(k => ['__proto__', 'prototype', 'constructor'].includes(k))) fail('INVALID_MAPPING', 'Mapping paths must be simple, safe JSON property paths')
  return path.split('.')
}
const getPath = (value, path) => safePath(path).reduce((current, key) => current?.[key], value)
function setPath(object, path, value) {
  const keys = safePath(path); let target = object
  for (const key of keys.slice(0, -1)) {
    if (target[key] === undefined) target[key] = {}
    if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) fail('INVALID_MAPPING', 'Overlapping mapping paths')
    target = target[key]
  }
  if (Object.hasOwn(target, keys.at(-1))) fail('INVALID_MAPPING', 'Mapping/static body fields overlap')
  target[keys.at(-1)] = value
}
function imageInput(input, representation) {
  const value = typeof input === 'string' ? input : input?.url
  if (typeof value !== 'string' || value.length > 8 * 1024 * 1024 + 128) fail('INVALID_INPUT', 'Image input must be a bounded URL/data URL (preprocess bytes before encoding)')
  if (representation === 'data-url') {
    if (!/^data:image\/(png|jpeg|webp|gif);base64,[a-zA-Z0-9+/]+={0,2}$/.test(value)) fail('INVALID_INPUT', 'This image mapping requires an explicit image data URL')
  } else if (representation === 'url') {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('INVALID_INPUT', 'This image mapping requires an HTTP(S) image URL')
  } else fail('INVALID_MAPPING', 'Declare image representation as url or data-url')
  return value
}

/** Administrator-declared JSON mapping. No arbitrary expressions, code evaluation or automatic image /embeddings fallback. */
export class FixedHttpEmbedding extends GuardedEncoder {
  constructor(options) {
    super(options)
    this.mapping = structuredClone(options.mapping)
    const m = this.mapping
    if (!m || m.version !== this.space.protocolMappingVersion) fail('MAPPING_VERSION_MISMATCH', 'Mapping version must equal the space protocolMappingVersion')
    if (typeof m.path !== 'string' || !/^\/(?!\/)[a-zA-Z0-9_@./-]+$/.test(m.path) || m.path.includes('..')) fail('INVALID_MAPPING', 'Mapping requires a fixed relative HTTP path')
    if (!m.response?.vectorsPath) fail('INVALID_MAPPING', 'Declare response.vectorsPath')
    safePath(m.response.vectorsPath)
    for (const key of ['vectorPath', 'indexPath', 'modelPath', 'revisionPath', 'shapePath', 'successPath']) if (m.response[key]) safePath(m.response[key])
    for (const key of ['modelField', 'modalityField', 'purposeField', 'preprocessField']) if (m[key]) safePath(m[key])
    for (const modality of this.space.modalities) {
      if (!m.inputs?.[modality]?.field) fail('INVALID_MAPPING', `Declare inputs.${modality}.field`)
      safePath(m.inputs[modality].field)
      if (m.inputs[modality].itemField) safePath(m.inputs[modality].itemField)
    }
    this.mappingFingerprint = digest(m)
    if (options.mappingFingerprint && options.mappingFingerprint !== this.mappingFingerprint) fail('MAPPING_VERSION_MISMATCH', 'Mapping content changed without updating its registered fingerprint')
    // Persist this digest with the space so accidental mapping edits cannot reuse old vectors.
    if (this.space.preprocess.protocolMappingFingerprint !== this.mappingFingerprint) fail('MAPPING_VERSION_MISMATCH', 'Set preprocess.protocolMappingFingerprint to digest(mapping)')
    const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } }
    freeze(this.mapping)
  }
  async _raw(inputs, modality, purpose, signal) {
    const m = this.mapping, spec = m.inputs[modality]
    const values = inputs.map(input => modality === 'text' ? preprocessText(input, this.space, purpose) : imageInput(input, spec.representation))
    const p = this.space.preprocess[modality]
    if (modality === 'image' && !['passthrough', 'server'].includes(p.mode)) fail('UNSUPPORTED_PREPROCESS', 'Image preprocess.mode must explicitly be passthrough or server')
    if (modality === 'image' && p.mode === 'server' && !m.preprocessField) fail('INVALID_MAPPING', 'Server image preprocessing requires an explicit preprocessField')
    const body = structuredClone(m.staticBody ?? {})
    if (m.modelField) setPath(body, m.modelField, this.space.model)
    if (m.modalityField) setPath(body, m.modalityField, modality)
    if (m.purposeField) setPath(body, m.purposeField, purpose)
    if (m.preprocessField) setPath(body, m.preprocessField, p)
    setPath(body, spec.field, values.map(value => { if (!spec.itemField) return value; const item = {}; setPath(item, spec.itemField, value); return item }))
    const response = await this._request(m.path, body, signal)
    if (m.response.successPath && getPath(response, m.response.successPath) !== true) fail('EMBEDDING_REMOTE_FAILURE', 'Mapped embedding response did not report success')
    if (m.response.shapePath) {
      const shape = getPath(response, m.response.shapePath)
      if (!Array.isArray(shape) || shape.length !== 2 || shape[0] !== inputs.length || shape[1] !== this.space.dims) fail('INVALID_EMBEDDING_RESPONSE', 'Mapped embedding shape must equal [batch size, space dimensions]')
    }
    const rows = getPath(response, m.response.vectorsPath)
    if (!Array.isArray(rows) || rows.length !== inputs.length) fail('INVALID_EMBEDDING_RESPONSE', 'Mapped response must contain one vector per input')
    const vectors = Array(rows.length), seen = new Set()
    rows.forEach((row, position) => {
      const index = m.response.indexPath ? getPath(row, m.response.indexPath) : position
      integer(index, 'response index', 0, rows.length - 1)
      if (seen.has(index)) fail('INVALID_EMBEDDING_RESPONSE', 'Duplicate mapped response index')
      seen.add(index); vectors[index] = m.response.vectorPath ? getPath(row, m.response.vectorPath) : row
    })
    const model = m.response.modelPath ? getPath(response, m.response.modelPath) : undefined
    const revision = m.response.revisionPath ? getPath(response, m.response.revisionPath) : undefined
    if ((m.response.modelPath && typeof model !== 'string') || (m.response.revisionPath && typeof revision !== 'string')) fail('INVALID_EMBEDDING_RESPONSE', 'Declared response model/revision fields must be present as strings')
    return { vectors, model, revision }
  }
}

export function embeddingCacheKey({ space, contentHash, modality, purpose = 'document', scope }) {
  const contract = defineEmbeddingSpace(space)
  if (typeof contentHash !== 'string' || !contentHash || !contract.modalities.includes(modality) || !['query', 'document'].includes(purpose)) fail('INVALID_CACHE_KEY', 'Explicit contentHash/modality/purpose are required')
  if (modality === 'text' && (!scope?.account || !scope?.chat)) fail('SCOPE_REQUIRED', 'Text embedding cache keys require account/chat scope')
  return digest({ fingerprint: spaceFingerprint(contract), contentHash, modality, purpose, scope: scope ? canonical(scope) : null })
}

export { defineEmbeddingSpace, spaceFingerprint, validateVector, vectorScore, digest as mappingFingerprint, VectorError } from './space.js'
export { OpenAITextEmbedding, FixedHttpEmbedding, embeddingCacheKey } from './adapters.js'

import { OpenAITextEmbedding, FixedHttpEmbedding } from './adapters.js'
import { fail } from './space.js'

export function createEmbeddingAdapter(options) {
  if (options?.type === 'openai-text') return new OpenAITextEmbedding(options)
  if (options?.type === 'fixed-http') return new FixedHttpEmbedding(options)
  fail('UNKNOWN_EMBEDDING_ADAPTER', 'type must be openai-text or fixed-http')
}

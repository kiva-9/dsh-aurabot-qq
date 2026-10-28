import { requestJson, httpBase } from '../../embedding/http.js'
import { fail, text, integer } from '../../embedding/space.js'

export const RERANKER_DEFAULTS = Object.freeze({ enabled: false, endpoint: '', model: '', apiKey: '', timeoutMs: 3000, maxCandidates: 40,
  budget: Object.freeze({ maxCallsPerMinute: 10, maxInputChars: 32000, maxConcurrent: 1 }) })
export const RERANKER_SCHEMA = {
  type: 'object', additionalProperties: false, properties: {
    enabled: { type: 'boolean', default: false }, endpoint: { type: 'string', maxLength: 4096 }, model: { type: 'string', maxLength: 512 },
    apiKey: { type: 'string', writeOnly: true, 'x-secret': true },
    timeoutMs: { type: 'integer', minimum: 1, maximum: 30000, default: 3000 },
    maxCandidates: { type: 'integer', minimum: 1, maximum: 128, default: 40 },
    budget: { type: 'object', additionalProperties: false, properties: {
      maxCallsPerMinute: { type: 'integer', minimum: 0, maximum: 600, default: 10 },
      maxInputChars: { type: 'integer', minimum: 1, maximum: 524288, default: 32000 },
      maxConcurrent: { type: 'integer', minimum: 1, maximum: 8, default: 1 },
    } },
  },
}

export function rerankerConfig(input = {}) {
  const config = { ...RERANKER_DEFAULTS, ...input, budget: { ...RERANKER_DEFAULTS.budget, ...input.budget } }
  if (typeof config.enabled !== 'boolean') fail('INVALID_CONFIG', 'reranker.enabled 必须为布尔值')
  integer(config.timeoutMs, 'reranker.timeoutMs', 1, 30000)
  integer(config.maxCandidates, 'reranker.maxCandidates', 1, 128)
  integer(config.budget.maxCallsPerMinute, 'reranker.budget.maxCallsPerMinute', 0, 600)
  integer(config.budget.maxInputChars, 'reranker.budget.maxInputChars', 1, 524288)
  integer(config.budget.maxConcurrent, 'reranker.budget.maxConcurrent', 1, 8)
  if (config.enabled) {
    try { config.endpoint = httpBase(config.endpoint) } catch { fail('INVALID_CONFIG', 'reranker.endpoint 必须是完整 HTTP(S) 地址，不含凭据、query 或 fragment') }
    text(config.model, 'reranker.model')
  }
  return config
}

/** Fixed protocol, independent of embedding spaces. No probing or requests in the constructor. */
export class HttpReranker {
  constructor(config) { this.config = rerankerConfig(config); this.calls = []; this.inflight = 0; this.lastError = null }
  health() {
    const recent = this.calls.filter(at => at > Date.now() - 60000).length
    return { enabled: this.config.enabled, protocol: 'fixed-rerank-v1', model: this.config.model, maxCandidates: this.config.maxCandidates,
      budget: { ...this.config.budget }, callsLastMinute: recent, inflight: this.inflight, lastError: this.lastError }
  }
  async rank({ query, documents, signal }) {
    const cfg = this.config
    if (!cfg.enabled) fail('RERANK_DISABLED', '重排未启用')
    if (signal?.aborted) fail('JOB_CANCELLED', '重排已取消')
    if (typeof query !== 'string' || !query.trim() || !Array.isArray(documents) || !documents.length || documents.length > cfg.maxCandidates || documents.some(value => typeof value !== 'string')) fail('INVALID_RERANK_INPUT', '重排输入必须是有界的 query/documents 文本')
    const chars = documents.reduce((n, value) => n + value.length, query.length)
    if (chars > cfg.budget.maxInputChars) fail('RERANK_INPUT_BUDGET', '重排文本超过单次字符预算')
    this.calls = this.calls.filter(at => at > Date.now() - 60000)
    if (this.calls.length >= cfg.budget.maxCallsPerMinute || this.inflight >= cfg.budget.maxConcurrent) fail('RERANK_CALL_BUDGET', '重排达到调用或并发预算')
    this.calls.push(Date.now()); this.inflight++
    try {
      const response = await requestJson(cfg.endpoint, { method: 'POST', body: { model: cfg.model, query, documents },
        headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}, timeoutMs: cfg.timeoutMs, maxResponseBytes: 1024 * 1024, signal })
      if (!response || typeof response !== 'object' || Array.isArray(response) || (response.model !== undefined && response.model !== cfg.model) || !Array.isArray(response.results) || response.results.length !== documents.length) fail('INVALID_RERANK_RESPONSE', '重排结果必须覆盖每个候选且模型身份一致')
      const seen = new Set()
      for (const result of response.results) {
        if (!result || typeof result !== 'object' || !Number.isSafeInteger(result.index) || result.index < 0 || result.index >= documents.length || seen.has(result.index) || typeof result.score !== 'number' || !Number.isFinite(result.score)) fail('INVALID_RERANK_RESPONSE', '重排结果 index/score 无效、重复或缺失')
        seen.add(result.index)
      }
      this.lastError = null
      return response.results.map(({ index, score }) => ({ index, score })).sort((a, b) => b.score - a.score || a.index - b.index)
    } catch (error) { this.lastError = error.code || 'RERANK_ERROR'; throw error }
    finally { this.inflight-- }
  }
}

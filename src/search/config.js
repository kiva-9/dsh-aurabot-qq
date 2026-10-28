import { fail } from './errors.js'

export const SEARCH_DEFAULTS = Object.freeze({
  enabled: false, baseUrl: 'https://api.tavily.com', apiKey: '',
  maxResults: 5, timeoutMs: 30000, searchDepth: 'basic', extractDepth: 'basic',
  maxSearchRounds: 2, maxToolsPerTurn: 6, maxExtractUrls: 5,
  maxCandidates: 6, maxSourcePages: 3, maxReferences: 3, visionReview: false,
  maxResponseBytes: 2 * 1024 * 1024, maxPageBytes: 1024 * 1024,
  maxImageBytes: 10 * 1024 * 1024, maxImagePixels: 40_000_000,
  maxCacheBytes: 128 * 1024 * 1024,
  maxContentChars: 20000, maxRedirects: 4, readRetries: 1,
  maxConcurrent: 2, maxRequestsPerMinute: 20, maxRequestsPerDay: 100,
  cacheTtlMs: 15 * 60_000, referenceTtlMs: 24 * 60 * 60_000,
})

const LIMITS = {
  maxResults: [1, 20], timeoutMs: [10, 120000], maxSearchRounds: [1, 2], maxToolsPerTurn: [1, 6],
  maxExtractUrls: [1, 20], maxCandidates: [1, 6], maxSourcePages: [1, 6], maxReferences: [1, 3],
  maxResponseBytes: [256, 8 * 1024 * 1024], maxPageBytes: [256, 4 * 1024 * 1024],
  maxImageBytes: [128, 20 * 1024 * 1024], maxImagePixels: [1, 80_000_000],
  maxCacheBytes: [128, 512 * 1024 * 1024],
  maxContentChars: [100, 50000], maxRedirects: [0, 5], readRetries: [0, 2],
  maxConcurrent: [1, 8], maxRequestsPerMinute: [1, 100], maxRequestsPerDay: [1, 10000],
  cacheTtlMs: [0, 24 * 60 * 60_000], referenceTtlMs: [0, 7 * 24 * 60 * 60_000],
}

export function searchConfig(value = {}) {
  const cfg = { ...SEARCH_DEFAULTS }
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    const n = value?.[key]
    if (typeof n === 'number' && Number.isFinite(n)) cfg[key] = Math.max(min, Math.min(max, Math.floor(n)))
  }
  cfg.enabled = value?.enabled === true
  cfg.visionReview = value?.visionReview === true
  cfg.apiKey = typeof value?.apiKey === 'string' ? value.apiKey.trim() : ''
  cfg.baseUrl = typeof value?.baseUrl === 'string' ? value.baseUrl.trim() : cfg.baseUrl
  if (['basic', 'advanced', 'fast', 'ultra-fast'].includes(value?.searchDepth)) cfg.searchDepth = value.searchDepth
  if (['basic', 'advanced'].includes(value?.extractDepth)) cfg.extractDepth = value.extractDepth
  return cfg
}

export function assertConfigured(cfg) {
  if (!cfg.enabled) fail('SEARCH_DISABLED', '搜索未启用')
  if (!cfg.apiKey) fail('SEARCH_UNCONFIGURED', '搜索不可用：未配置 Tavily API key')
  let u
  try { u = new URL(cfg.baseUrl) } catch { fail('SEARCH_UNCONFIGURED', '搜索不可用：baseUrl 不合法') }
  // This is a trusted administrator endpoint, never a tool parameter. Local mock/proxy is explicit.
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || /[\r\n]/.test(cfg.apiKey)) fail('SEARCH_UNCONFIGURED', '搜索不可用：服务地址或密钥格式不合法')
  return u
}

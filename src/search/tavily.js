import { assertConfigured, searchConfig } from './config.js'
import { createSearchHttp, canonicalUrl } from './net.js'
import { fail, checkSignal, errorView, deadline } from './errors.js'

export const boundedText = (v, max = 800) => typeof v === 'string' ? v.slice(0, max) : ''
export const scoreOf = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null

export function queryText(value, optional = false) {
  if (optional && (value === undefined || value === '')) return ''
  if (typeof value !== 'string' || !value.trim() || value.length > 400) fail('INVALID_INPUT', 'query 必须是 1–400 字符的搜索词')
  return value.trim()
}

function domainList(list) {
  if (list === undefined) return undefined
  if (!Array.isArray(list) || list.length > 30 || list.some((x) => typeof x !== 'string' || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(x))) fail('INVALID_INPUT', '域名过滤必须是最多 30 个完整域名')
  return [...new Set(list.map((s) => s.toLowerCase()))]
}

export function searchInput(input = {}, cfg = searchConfig()) {
  const query = queryText(input.query)
  if (input.maxResults !== undefined && (!Number.isInteger(input.maxResults) || input.maxResults < 1)) fail('INVALID_INPUT', 'maxResults 必须是正整数')
  if (input.timeRange !== undefined && !['day', 'week', 'month', 'year'].includes(input.timeRange)) fail('INVALID_INPUT', 'timeRange 不合法')
  return { query, maxResults: Math.min(input.maxResults || cfg.maxResults, cfg.maxResults), includeImages: input.includeImages === true,
    includeDomains: domainList(input.includeDomains), excludeDomains: domainList(input.excludeDomains), timeRange: input.timeRange }
}

export function extractInput(input = {}, cfg = searchConfig()) {
  const values = typeof input.urls === 'string' ? [input.urls] : input.urls
  if (!Array.isArray(values) || !values.length || values.length > cfg.maxExtractUrls) fail('INVALID_INPUT', `urls 必须包含 1–${cfg.maxExtractUrls} 个 URL`)
  const urls = values.map((url) => { const u = canonicalUrl(url); if (!u) fail('INVALID_INPUT', '提取 URL 不合法'); return u })
  return { urls: [...new Set(urls)], query: queryText(input.query, true), includeImages: input.includeImages === true }
}

function imageList(list, max) {
  if (!Array.isArray(list)) return []
  return list.slice(0, max).map((item) => ({
    imageUrl: boundedText(typeof item === 'string' ? item : item?.url, 4096),
    description: boundedText(item?.description, 800),
    // Not all Tavily image results have a source page. Never infer it from the image host.
    sourcePageUrl: boundedText(item?.source_url || item?.sourceUrl || item?.page_url, 4096) || null,
  })).filter((item) => item.imageUrl)
}

/** Official POST /search and /extract, Authorization: Bearer. Paid POSTs are never retried. */
export function createTavilyAdapter({ config, http = createSearchHttp(), now = Date.now, beforeRequest = () => {} }) {
  const cfg = searchConfig(config)
  async function post(path, body, signal) {
    const base = assertConfigured(cfg)
    checkSignal(signal)
    beforeRequest()
    const url = base.href.replace(/\/+$/, '') + path
    const response = await http.read(url, { method: 'POST', publicOnly: false,
      headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body), timeoutMs: cfg.timeoutMs, maxBytes: cfg.maxResponseBytes, maxRedirects: 0, retries: 0, signal })
    if (!/^application\/(?:[\w.+-]*\+)?json\b/i.test(response.headers['content-type'] || '')) fail('INVALID_RESPONSE', 'Tavily 未返回 JSON')
    let data
    try { data = JSON.parse(response.body.toString('utf8')) } catch { fail('INVALID_RESPONSE', 'Tavily 返回了无效 JSON') }
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.results)) fail('INVALID_RESPONSE', 'Tavily results 结构不合法')
    return data
  }
  const netOptions = (signal) => ({ signal, timeoutMs: cfg.timeoutMs, maxBytes: cfg.maxPageBytes, maxRedirects: cfg.maxRedirects, retries: cfg.readRetries })

  async function search(input, { signal } = {}) {
    const args = searchInput(input, cfg)
    const data = await post('/search', {
      query: args.query, max_results: args.maxResults, search_depth: cfg.searchDepth,
      include_answer: false, include_raw_content: false, auto_parameters: false,
      include_images: args.includeImages, include_image_descriptions: args.includeImages, include_usage: true,
      ...(args.includeDomains ? { include_domains: args.includeDomains } : {}),
      ...(args.excludeDomains ? { exclude_domains: args.excludeDomains } : {}),
      ...(args.timeRange ? { time_range: args.timeRange } : {}),
    }, signal)
    const fetchedAt = now()
    const sources = []
    const failures = []
    const images = imageList(data.images, cfg.maxCandidates)
    for (const item of data.results.slice(0, args.maxResults)) {
      const url = canonicalUrl(item?.url)
      if (!url) { failures.push({ url: boundedText(item?.url, 4096), code: 'INVALID_RESPONSE', message: '搜索结果 URL 不合法' }); continue }
      try { await http.resolve(url, { signal }) }
      catch (e) { checkSignal(signal); failures.push({ url, ...errorView(e) }); continue }
      const id = `s${sources.length + 1}`
      sources.push({ id, type: 'web-hit', url, title: boundedText(item.title, 300), snippet: boundedText(item.content, 1500),
        score: scoreOf(item.score), fetchedAt, pageRead: false, contentKind: 'search-snippet', trust: 'untrusted-external' })
      for (const img of imageList(item.images, cfg.maxCandidates)) images.push({ ...img, sourcePageUrl: url, sourceId: id })
    }
    return { sources, failures, images: images.slice(0, cfg.maxCandidates * 2), fetchedAt,
      providerRequestId: boundedText(data.request_id, 200), usage: { credits: scoreCredits(data.usage?.credits) } }
  }

  async function extract(input, { signal } = {}) {
    assertConfigured(cfg)
    const args = extractInput(input, cfg)
    const failures = []
    const checked = []
    // Probe with our pinned transport before asking a remote provider to read an untrusted URL.
    for (const original of args.urls) {
      try {
        const r = await http.probe(original, netOptions(signal))
        checked.push({ original, final: r.url })
      } catch (e) { checkSignal(signal); failures.push({ url: original, ...errorView(e) }) }
    }
    if (!checked.length) return { sources: [], images: [], failures, fetchedAt: now(), providerRequestId: '', usage: { credits: null } }
    const data = await post('/extract', { urls: [...new Set(checked.map((x) => x.final))], extract_depth: cfg.extractDepth,
      format: 'text', include_images: args.includeImages, include_usage: true,
      timeout: Math.max(1, Math.min(60, cfg.timeoutMs / 1000)),
      ...(args.query ? { query: args.query, chunks_per_source: 3 } : {}),
    }, signal)
    if (data.failed_results !== undefined && !Array.isArray(data.failed_results)) fail('INVALID_RESPONSE', 'Tavily failed_results 结构不合法')
    const sources = []
    const images = []
    const fetchedAt = now()
    const seen = new Set()
    for (const item of data.results.slice(0, checked.length)) {
      const url = canonicalUrl(item?.url)
      const expected = checked.find((x) => x.final === url || x.original === url)
      if (!expected || seen.has(expected.original)) continue
      seen.add(expected.original)
      if (typeof item.raw_content !== 'string' || !item.raw_content.trim()) { failures.push({ url: expected.original, code: 'EMPTY_CONTENT', message: '页面没有提取到正文' }); continue }
      const id = `s${sources.length + 1}`
      sources.push({ id, type: 'page-content', url: expected.final, originalUrl: expected.original,
        title: boundedText(item.title, 300), content: boundedText(item.raw_content, cfg.maxContentChars),
        truncated: item.raw_content.length > cfg.maxContentChars, contentKind: args.query ? 'targeted-chunks' : 'page-content',
        fetchedAt, pageRead: true, trust: 'untrusted-external' })
      for (const img of imageList(item.images, cfg.maxCandidates)) images.push({ ...img, sourcePageUrl: expected.final, sourceId: id })
    }
    for (const it of checked) {
      if (seen.has(it.original)) continue
      const failure = (data.failed_results || []).find((f) => [it.original, it.final].includes(canonicalUrl(f?.url)))
      failures.push({ url: it.original, code: 'EXTRACT_FAILED', message: failure ? boundedText(failure.error, 300) || '页面提取失败' : '服务未返回该页面，或返回了未经请求的 URL', trust: 'untrusted-external' })
    }
    return { sources, images, failures, fetchedAt, providerRequestId: boundedText(data.request_id, 200), usage: { credits: scoreCredits(data.usage?.credits) } }
  }
  const bounded = (fn) => async (input, options = {}) => {
    const d = deadline(cfg.timeoutMs, [options.signal])
    try { const result = await fn(input, { signal: d.signal }); checkSignal(d.signal); return result }
    catch (e) { checkSignal(d.signal); throw e }
    finally { d.close() }
  }
  return { search: bounded(search), extract: bounded(extract) }
}

const scoreCredits = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null

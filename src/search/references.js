import { canonicalUrl } from './net.js'
import { boundedText } from './tavily.js'
import { fail, errorView, checkSignal, abortable } from './errors.js'

function decodeEntities(value) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d{1,7}|#x[\da-f]{1,6});/gi, (s) => {
    const named = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' }
    if (named[s.toLowerCase()]) return named[s.toLowerCase()]
    const n = s[2].toLowerCase() === 'x' ? parseInt(s.slice(3, -1), 16) : Number(s.slice(2, -1))
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''
  })
}

/** Bounded static HTML inspection only. Scripts, CSS, OCR and page instructions never execute. */
export function inspectSourcePage(html, url) {
  // Scan forward exactly once; malformed repeated '<script'/'<' cannot cause regex backtracking.
  const lower = html.toLowerCase()
  const textParts = []
  const tags = []
  let title = ''
  let at = 0
  while (at < html.length) {
    const start = html.indexOf('<', at)
    if (start < 0) { textParts.push(html.slice(at)); break }
    textParts.push(html.slice(at, start))
    const end = html.indexOf('>', start + 1)
    if (end < 0) { textParts.push(html.slice(start)); break }
    const tag = html.slice(start, Math.min(end + 1, start + 16385))
    at = end + 1
    const script = /^<(script|style)\b/i.exec(tag)
    if (script) {
      const close = lower.indexOf(`</${script[1].toLowerCase()}`, at)
      if (close < 0) break
      const closeEnd = html.indexOf('>', close)
      at = closeEnd < 0 ? html.length : closeEnd + 1
      continue
    }
    if (end - start > 16384) continue
    if (/^<title\b/i.test(tag) && !title) title = decodeEntities(html.slice(at, Math.min(html.indexOf('<', at) < 0 ? html.length : html.indexOf('<', at), at + 300)))
    if (/^<(img|source|meta)\b/i.test(tag) && tags.length < 1000) tags.push(tag)
  }
  const images = new Map()
  for (const tag of tags) {
    const attrs = new Map()
    for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) attrs.set(m[1].toLowerCase(), decodeEntities(m[2] ?? m[3] ?? m[4]))
    const values = /^<meta/i.test(tag)
      ? (/^(og:image(?::url|:secure_url)?|twitter:image(?::src)?)$/i.test(attrs.get('property') || attrs.get('name') || '') ? [attrs.get('content')] : [])
      : [attrs.get('src'), attrs.get('data-src'), ...(attrs.get('srcset') || '').split(',').slice(0, 30).map((s) => s.trim().split(/\s+/)[0])]
    for (const value of values.filter(Boolean)) {
      const imageUrl = canonicalUrl(value, url)
      if (imageUrl) images.set(imageUrl, boundedText(attrs.get('alt') || attrs.get('title'), 500))
    }
  }
  const text = decodeEntities(textParts.join(' ')).replace(/\s+/g, ' ').trim()
  return { title, text, images }
}

/** Signature, container bounds, MIME agreement, dimensions and pixel cap; SVG/HTML are refused. */
export function inspectImage(buf, contentType, maxPixels = 40_000_000) {
  let mime = ''
  let width = 0
  let height = 0
  if (buf.length >= 45 && buf.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && buf.toString('ascii', 12, 16) === 'IHDR' && buf.toString('ascii', buf.length - 8, buf.length - 4) === 'IEND') {
    mime = 'image/png'; width = buf.readUInt32BE(16); height = buf.readUInt32BE(20)
  } else if (buf.length >= 14 && /^GIF8[79]a$/.test(buf.toString('ascii', 0, 6)) && buf.at(-1) === 0x3b) {
    mime = 'image/gif'; width = buf.readUInt16LE(6); height = buf.readUInt16LE(8)
  } else if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP' && buf.readUInt32LE(4) + 8 === buf.length) {
    mime = 'image/webp'
    const kind = buf.toString('ascii', 12, 16)
    if (kind === 'VP8X') { width = 1 + buf.readUIntLE(24, 3); height = 1 + buf.readUIntLE(27, 3) }
    else if (kind === 'VP8L' && buf[20] === 0x2f) { width = 1 + (((buf[22] & 0x3f) << 8) | buf[21]); height = 1 + (((buf[24] & 15) << 10) | (buf[23] << 2) | (buf[22] >> 6)) }
    else if (kind === 'VP8 ' && buf.subarray(23, 26).equals(Buffer.from([0x9d, 1, 0x2a]))) { width = buf.readUInt16LE(26) & 0x3fff; height = buf.readUInt16LE(28) & 0x3fff }
  } else if (buf.length >= 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf.at(-2) === 0xff && buf.at(-1) === 0xd9) {
    mime = 'image/jpeg'
    for (let at = 2; at + 4 < buf.length;) {
      if (buf[at++] !== 0xff) break
      while (buf[at] === 0xff) at++
      const marker = buf[at++]
      if (marker === 0xda || marker === 0xd9) break
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (at + 2 > buf.length) break
      const size = buf.readUInt16BE(at)
      if (size < 2 || at + size > buf.length) break
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && size >= 8) {
        height = buf.readUInt16BE(at + 3); width = buf.readUInt16BE(at + 5); break
      }
      at += size
    }
  }
  if (!mime || !width || !height) fail('INVALID_IMAGE', '图片签名、容器或尺寸不合法（仅接受 PNG/JPEG/GIF/WebP）')
  const declared = String(contentType || '').split(';')[0].trim().toLowerCase()
  if (declared !== mime) fail('IMAGE_TYPE_MISMATCH', '图片 MIME 与实际文件类型不一致')
  if (width * height > maxPixels) fail('IMAGE_TOO_LARGE', '图片像素数超过限制')
  return { mime, width, height, bytes: buf.length }
}

export function targetEntity(value) {
  if (!value) return { name: '', work: '', version: '', kind: 'unspecified' }
  if (typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', 'entity 必须是对象')
  const out = {}
  for (const field of ['name', 'work', 'version']) {
    if (value[field] !== undefined && (typeof value[field] !== 'string' || value[field].length > 120)) fail('INVALID_INPUT', '实体名称、作品和版本各限 120 字符')
    out[field] = value[field]?.trim() || ''
  }
  out.kind = ['fictional', 'object', 'public-person'].includes(value.kind) ? value.kind : 'unspecified'
  return out
}

const REVIEW_FIELDS = ['matchesTarget', 'clear', 'unobstructed', 'singleSubject', 'noWatermark']
export function checkedReview(value, by) {
  if (!value || REVIEW_FIELDS.some((k) => typeof value[k] !== 'boolean') || typeof value.reason !== 'string' || !value.reason.trim()) fail('INVALID_REVIEW', '确认必须逐项说明对应性、清晰度、遮挡、拼图和水印，并填写理由')
  return { status: REVIEW_FIELDS.every((k) => value[k]) ? 'passed' : 'rejected', by,
    ...Object.fromEntries(REVIEW_FIELDS.map((k) => [k, value[k]])), reason: value.reason.slice(0, 600) }
}

export async function verifyCandidates({ searchResult, extracted, entity, http, cfg, signal, now = Date.now, reserveDownload, reviewImage }) {
  const pages = []
  const failures = []
  const sources = []
  const urls = [...new Set([...searchResult.sources.map((s) => s.url), ...(extracted?.sources || []).map((s) => s.url)])].slice(0, cfg.maxSourcePages)
  for (const url of urls) {
    try {
      const response = await http.read(url, { signal, timeoutMs: cfg.timeoutMs, maxBytes: cfg.maxPageBytes, maxRedirects: cfg.maxRedirects, retries: cfg.readRetries })
      if (!/^(text\/html|application\/xhtml\+xml)\b/i.test(response.headers['content-type'] || '')) fail('SOURCE_TYPE', '来源页不是 HTML')
      const page = inspectSourcePage(response.body.toString('utf8'), response.url)
      const source = { id: `s${sources.length + 1}`, type: 'page-content', url: response.url, originalUrl: url, title: page.title,
        content: page.text.slice(0, cfg.maxContentChars), contentKind: 'static-html-text', pageRead: true,
        truncated: page.text.length > cfg.maxContentChars, fetchedAt: now(), trust: 'untrusted-external' }
      sources.push(source)
      pages.push({ ...page, url: response.url, original: url, sourceId: source.id })
    } catch (e) { checkSignal(signal); failures.push({ url, ...errorView(e) }) }
  }
  // Complement missing source/description through extraction and actual page image relations.
  const raw = [...(searchResult.images || []), ...(extracted?.images || [])]
  if (!raw.length) for (const page of pages) for (const [imageUrl, description] of [...page.images].slice(0, cfg.maxCandidates)) raw.push({ imageUrl, description, sourcePageUrl: page.url })
  const unique = new Map()
  for (const item of raw) {
    const url = canonicalUrl(item.imageUrl)
    const key = url || item.imageUrl
    const old = unique.get(key)
    if (!old || (!old.sourcePageUrl && item.sourcePageUrl)) unique.set(key, { ...item, imageUrl: url || item.imageUrl })
  }
  const candidates = []
  const blobs = []
  let verified = 0
  let reviewAttempts = 0
  for (const item of [...unique.values()].slice(0, cfg.maxCandidates)) {
    checkSignal(signal)
    const candidate = { id: `c${candidates.length + 1}`, type: 'reference-candidate', imageUrl: item.imageUrl,
      sourcePageUrl: item.sourcePageUrl || null, description: boundedText(item.description, 800),
      discoveredAt: searchResult.fetchedAt, fetchedAt: null, status: 'rejected', entity,
      sourceCheck: { status: 'unverified' }, download: { status: 'not-attempted' },
      relevance: { status: 'unconfirmed', score: null, basis: 'lexical-only; not identity verification' },
      visualReview: { status: 'unavailable', reason: '需要视觉或人工确认对应性、清晰度、遮挡、拼图和水印' },
      trust: 'untrusted-external', factStatus: 'unconfirmed', failure: null }
    candidates.push(candidate)
    try {
      await http.resolve(item.imageUrl, { signal })
      const claimed = item.sourcePageUrl && canonicalUrl(item.sourcePageUrl)
      const page = pages.find((p) => p.images.has(item.imageUrl) && (!claimed || claimed === p.url || claimed === p.original))
      if (!page) fail('SOURCE_UNVERIFIED', item.sourcePageUrl ? '未能在来源页核对到该图片，可能抓取失败或来源不符' : '缺少可验证的来源页；未把图片域名当作来源页')
      candidate.sourcePageUrl = page.url
      candidate.sourceId = page.sourceId
      candidate.sourceCheck = { status: 'verified', method: 'static-html-image-link', fetchedAt: sources.find((s) => s.id === page.sourceId).fetchedAt }
      if (!candidate.description) candidate.description = page.images.get(item.imageUrl) || page.title
      const terms = [entity.name, entity.work, entity.version].filter(Boolean)
      const corpus = `${page.title} ${page.text} ${page.images.get(item.imageUrl) || ''}`.toLowerCase()
      const missing = terms.filter((term) => !corpus.includes(term.toLowerCase()))
      candidate.relevance = { status: !terms.length ? 'unconfirmed' : missing.length ? 'mismatch' : 'matched-text', score: terms.length ? (terms.length - missing.length) / terms.length : null,
        missingTerms: missing, basis: 'source page text and image alt; not identity verification' }
      reserveDownload()
      candidate.download = { status: 'fetching' }
      const response = await http.read(item.imageUrl, { signal, timeoutMs: cfg.timeoutMs, maxBytes: cfg.maxImageBytes, maxRedirects: cfg.maxRedirects, retries: cfg.readRetries })
      const image = inspectImage(response.body, response.headers['content-type'], cfg.maxImagePixels)
      candidate.fetchedAt = now()
      candidate.download = { status: 'ready', ...image, finalUrl: response.url }
      blobs.push({ id: candidate.id, buf: response.body, mime: image.mime })
      candidate.status = 'needs_review'
      if (image.width < 128 || image.height < 128) candidate.visualReview = { status: 'rejected', reason: '图片分辨率低于 128×128' }
      else if (reviewImage && terms.length && !missing.length && ['fictional', 'object'].includes(entity.kind) && verified < cfg.maxReferences && reviewAttempts < cfg.maxReferences) {
        reviewAttempts++
        const review = await abortable(Promise.resolve().then(() => reviewImage({ buf: response.body, mime: image.mime, entity, source: sources.find((s) => s.id === page.sourceId), candidate: structuredClone(candidate), signal })), signal)
        checkSignal(signal)
        candidate.visualReview = checkedReview(review, 'vision')
        if (candidate.visualReview.status === 'passed') { candidate.status = 'verified'; verified++ }
      } else if (entity.kind === 'public-person') candidate.visualReview = { status: 'needs-human', reason: '现实人物需人工核对可追溯来源，不根据人脸相似度认定身份' }
      if (candidate.visualReview.status === 'rejected') candidate.status = 'rejected'
    } catch (e) {
      checkSignal(signal)
      candidate.failure = errorView(e)
      if (candidate.download.status === 'fetching') candidate.download = { status: 'failed', ...errorView(e) }
      if (candidate.sourceCheck.status !== 'verified') candidate.sourceCheck = { status: 'failed', ...errorView(e) }
      // A review failure preserves a downloaded candidate for manual review, never marks it verified.
      if (candidate.download.status === 'ready') candidate.status = 'needs_review'
    }
  }
  return { sources, candidates, blobs, failures }
}

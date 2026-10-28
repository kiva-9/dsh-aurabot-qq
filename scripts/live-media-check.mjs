// One authorized live run. Imports are inert; --run is required for paid requests.
// Secrets come only from the owner's existing local files, never from environment variables.
import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync, fsyncSync, renameSync } from 'node:fs'
import { resolve, dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { adapterFor } from '../src/providers/image/index.js'
import { checkRequest, imageInfo, ProviderError } from '../src/providers/image/common.js'
import { validateHttpProfile } from '../src/providers/image/http.js'
import { textToSpeech, normalizeAudio } from '../src/voice/tts.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MEDIA = join(ROOT, '.refactor', 'live-media')
const REPORT = join(ROOT, '.refactor', 'live-media-report.json')
const MARKDOWN = join(ROOT, '.refactor', 'live-media-report.md')
const OLD = 'C:/Users/Kiva/.dsh/plugins-data/aurabot'
const PRIVATE = 'C:/Users/Kiva/.dsh/aurabot-live-media-config.json'
export const IMAGE_PROMPT = '原创插画：一只可爱的蓝鲸在清澈深蓝海水中缓缓游动，身上有细小星光般的斑点，柔和阳光从水面照入，简洁安静的构图。不要文字、标志、水印或现有角色。只生成一张正方形图片。'
export const EDIT_PROMPT = '请编辑这张蓝鲸底图：保持蓝鲸的外形、颜色、姿态和原有海洋构图，只在蓝鲸上方增加一颗小小的金色海星。不要新增文字、标志或水印。只返回一张图片。'
export const SPEECH_TEXT = '你好，我是大肥鱼。蓝鲸正在安静地游泳。'
const sha = value => createHash('sha256').update(value).digest('hex')
const iso = () => new Date().toISOString()
const rel = file => relative(ROOT, file).replaceAll('\\', '/')
const safeModel = value => typeof value === 'string' && /^[\p{L}\p{N}._+:/ -]{1,100}$/u.test(value) ? value : '[configured]'
const fault = code => Object.assign(new Error(code), { liveCode: code })

function literalValue(quote, body) {
  if (quote === '"') return JSON.parse('"' + body + '"')
  // Parse the subset used by the existing config scripts; do not import/evaluate them.
  return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|['"\\nrt])/g, (_, token) => {
    if (token[0] === 'u' || token[0] === 'x') return String.fromCharCode(parseInt(token.slice(1), 16))
    return ({ n: '\n', r: '\r', t: '\t' })[token] ?? token
  })
}

function constant(source, name, required = true) {
  const match = new RegExp('\\bconst\\s+' + name + '\\s*=\\s*(?:process\\.env\\.[A-Z_]+\\s*\\|\\|\\s*)?([\'\"])((?:\\\\.|(?!\\1)[^\\\\\\r\\n])*)\\1').exec(source)
  if (!match) { if (!required) return ''; throw fault('LEGACY_CONSTANT_NOT_FOUND') }
  return literalValue(match[1], match[2])
}

function fetchEndpoints(source, host = '') {
  return [...source.matchAll(/fetch\(\s*([`'"])((?:\\.|(?!\1)[^\\])*?)\1/g)].map(match => {
    const value = match[2].replaceAll('${HOST}', host)
    if (value.includes('${')) throw fault('UNSUPPORTED_LEGACY_URL_TEMPLATE')
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw fault('UNSUPPORTED_LEGACY_ENDPOINT')
    return url.href
  })
}

export function derivePrivateConfig(config, imageSource, voiceSource, moduleSource) {
  if (!config.local?.image || !config.local?.tts || !moduleSource.includes('local.call')) throw fault('LEGACY_LOCAL_ROUTING_NOT_CONFIRMED')
  const host = constant(imageSource, 'HOST'), imageUrls = fetchEndpoints(imageSource, host), voiceUrls = fetchEndpoints(voiceSource)
  if (imageUrls.length !== 2 || voiceUrls.length !== 1 || !/\/draw\/completions$/.test(imageUrls[0]) || !/\/draw\/result$/.test(imageUrls[1]) || !/\/audio\/speech$/.test(voiceUrls[0])) throw fault('UNSUPPORTED_LEGACY_PROTOCOL')
  const imageKey = constant(imageSource, 'API_KEY'), voiceKey = constant(voiceSource, 'API_KEY')
  if (!imageKey || !voiceKey || /请填|your[_ -]?key|replace[_ -]?me/i.test(imageKey + voiceKey)) throw fault('LEGACY_CREDENTIAL_NOT_CONFIGURED')
  return {
    schema: 'aurabot.live-media.private', version: 1,
    image: { model: constant(imageSource, 'MODEL'), apiKey: imageKey, submitUrl: imageUrls[0], statusUrl: imageUrls[1],
      quality: constant(imageSource, 'QUALITY', false), size: config.imageGen?.size || '1024x1024',
      referenceInputConfigured: imageSource.includes('urls') && imageSource.includes('refs') },
    tts: { model: constant(voiceSource, 'MODEL'), voice: constant(voiceSource, 'VOICE'), apiKey: voiceKey, url: voiceUrls[0],
      instruction: constant(voiceSource, 'INSTRUCTION', false), format: 'mp3' },
    state: { providerTaskIds: {} },
  }
}

export function imageProfile(config) {
  const body = JSON.stringify({ model: config.model, prompt: '{prompt}', aspectRatio: '{size}',
    ...(config.quality ? { quality: config.quality } : {}), urls: '__LIVE_IMAGES__', webHook: '-1' }).replace('"__LIVE_IMAGES__"', '{imagesJson}')
  return { id: 'legacy-grsai-live', protocol: 'http', model: config.model, apiKey: config.apiKey, extra: {
    modes: config.referenceInputConfigured ? ['text', 'edit'] : ['text'], maxInputs: 1,
    headers: { authorization: 'Bearer {apiKey}' },
    submit: { method: 'POST', url: config.submitUrl, bodyType: 'json', body },
    response: { kind: 'json', taskIdPath: 'data.id' },
    // Historical profile used by the first authorized live run, before the adapter fix.
    // Preserve its explicit bridge provenance; install productionImageProfile instead.
    status: { method: 'POST', url: config.statusUrl + '?taskId={taskId}', statePath: 'data.status',
      doneValues: ['succeeded'], failedValues: ['failed'], imagesPath: 'data.results', errorPath: 'data.failure_reason' },
  } }
}

/** Installable profile for the production adapter; no request/response bridge. */
export function productionImageProfile(config) {
  const body = JSON.stringify({ model: config.model, prompt: '{prompt}', aspectRatio: '{size}',
    ...(config.quality ? { quality: config.quality } : {}), urls: '__NATIVE_IMAGES__', webHook: '-1' }).replace('"__NATIVE_IMAGES__"', '{imagesDataUrls}')
  const modes = config.referenceInputConfigured ? ['text', 'reference'] : ['text']
  return { id: 'legacy-grsai', name: 'GRSAI（旧插件已验证）', protocol: 'http', model: config.model, apiKey: config.apiKey,
    capabilities: { modes, maxInputs: config.referenceInputConfigured ? 1 : 0, sizes: [] }, extra: {
      modes, maxInputs: config.referenceInputConfigured ? 1 : 0, headers: { authorization: 'Bearer {apiKey}' },
      submit: { method: 'POST', url: config.submitUrl, bodyType: 'json', body },
      response: { kind: 'json', taskIdPath: 'data.id' },
      status: { method: 'POST', url: config.statusUrl, bodyType: 'json', body: '{"id":"{taskId}"}',
        statePath: 'data.status', doneValues: ['succeeded'], failedValues: ['failed'], imagesPath: 'data.results', errorPath: 'data.failure_reason' },
    } }
}

export function speechConfig(config) {
  return { provider: 'http', defaultVoice: config.voice, httpApi: { apiKey: config.apiKey, url: config.url, method: 'POST',
    headers: { authorization: 'Bearer {apiKey}' }, bodyType: 'json',
    body: JSON.stringify({ model: config.model, input: '{text}', voice: '{voice}', response_format: config.format,
      ...(config.instruction ? { instruction: config.instruction } : {}) }), response: 'audio', audioFormat: 'auto', timeoutMs: 60000 } }
}

export function reserveAttempt(report, id, type, persist = () => {}) {
  const allowed = { image_generate: 'image', image_edit: 'image', tts: 'tts' }
  if (allowed[id] !== type || report.attempts.some(a => a.id === id)) throw fault('ATTEMPT_ALREADY_RESERVED_OR_INVALID')
  const max = type === 'image' ? 2 : 1
  if (report.attempts.filter(a => a.type === type).length >= max) throw fault('LIVE_BUDGET_EXHAUSTED')
  const attempt = { id, type, state: 'reserved', startedAt: iso(), dispatched: false, trace: [], artifacts: [] }
  report.attempts.push(attempt)
  persist() // Durable reservation BEFORE calling any adapter or network API.
  return attempt
}

export function markDispatch(attempt, persist = () => {}) {
  if (attempt.dispatched || attempt.state !== 'reserved') throw fault('DUPLICATE_SUBMISSION_BLOCKED')
  attempt.dispatched = true; attempt.state = 'submitting'; attempt.dispatchedAt = iso()
  persist()
}

export function safeFailure(error, attempt = {}) {
  const kinds = ['unknown', 'invalid', 'unsupported', 'auth', 'quota', 'transient']
  const kind = kinds.includes(error?.kind) ? error.kind : attempt.dispatched ? 'unknown' : 'preflight'
  const status = Number.isInteger(error?.status) ? error.status : [...(attempt.trace || [])].reverse().find(t => t.httpStatus >= 400)?.httpStatus
  const allowedCodes = ['LEGACY_CONSTANT_NOT_FOUND', 'UNSUPPORTED_LEGACY_URL_TEMPLATE', 'UNSUPPORTED_LEGACY_ENDPOINT',
    'LEGACY_LOCAL_ROUTING_NOT_CONFIRMED', 'UNSUPPORTED_LEGACY_PROTOCOL', 'LEGACY_CREDENTIAL_NOT_CONFIGURED',
    'ATTEMPT_ALREADY_RESERVED_OR_INVALID', 'LIVE_BUDGET_EXHAUSTED', 'DUPLICATE_SUBMISSION_BLOCKED', 'REQUEST_ROUTE_BLOCKED',
    'PROVIDER_METADATA_TOO_LARGE', 'PROVIDER_RESPONSE_INVALID', 'PROVIDER_BUSINESS_ERROR', 'POLL_DEADLINE',
    'REFERENCE_FORMAT_INVALID', 'PRIVATE_CONFIG_EXISTS', 'OUTPUT_VALIDATION_FAILED', 'LIVE_RUN_ALREADY_RESERVED',
    'NATIVE_POLL_ALREADY_RESERVED', 'LIVE_RUN_NOT_COMPLETE', 'PRODUCTION_CONFIG_NOT_PREPARED']
  return { kind, ...(status ? { httpStatus: status } : {}),
    code: allowedCodes.includes(error?.liveCode) ? error.liveCode : 'ADAPTER_OR_TRANSPORT_FAILURE',
    mayHaveBeenCharged: Boolean(attempt.dispatched), resubmit: false }
}

async function boundedMetadata(response) {
  const copy = response.clone(), reader = copy.body?.getReader(), chunks = []
  let length = 0
  try {
    if (reader) while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > 128 * 1024) throw fault('PROVIDER_METADATA_TOO_LARGE')
      chunks.push(Buffer.from(value))
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw fault('PROVIDER_RESPONSE_INVALID') }
  } catch (error) { if (reader) void reader.cancel().catch(() => {}); throw error }
  finally { reader?.releaseLock() }
}

/** Injectable wire bridge, explicitly distinct from native HTTP-adapter support. */
export function createGrsaiBridge(config, { fetchImpl = fetch, attempt, persist = () => {}, onTaskId = () => {} } = {}) {
  return async (address, init = {}) => {
    const url = new URL(address), headers = new Headers(init.headers)
    let target = url.href, outgoing = { ...init }, endpoint, mapping = []
    if (url.href === config.submitUrl && init.method === 'POST') {
      endpoint = 'generation_submit'
      const body = JSON.parse(String(init.body))
      if (!Array.isArray(body.urls) || body.urls.length > 1 || body.model !== config.model) throw fault('REFERENCE_FORMAT_INVALID')
      body.urls = body.urls.map(image => {
        if (!image || image.role !== 'base' || !/^image\/(png|jpeg|webp)$/.test(image.mime) || typeof image.base64 !== 'string') throw fault('REFERENCE_FORMAT_INVALID')
        const buf = Buffer.from(image.base64, 'base64'), info = imageInfo(buf)
        if (info.mime !== image.mime) throw fault('REFERENCE_FORMAT_INVALID')
        attempt.referenceTransmitted = { role: image.role, sha256: sha(buf), bytes: buf.length, mime: info.mime }
        return `data:${image.mime};base64,${image.base64}`
      })
      if (!body.urls.length) delete body.urls
      mapping = ['imagesJson objects -> legacy data URL array']
      outgoing.body = JSON.stringify(body)
      markDispatch(attempt, persist)
    } else if (url.origin + url.pathname === config.statusUrl && init.method === 'POST' && url.searchParams.has('taskId')) {
      endpoint = 'status_poll'
      const id = url.searchParams.get('taskId')
      if (!id || [...url.searchParams.keys()].some(k => k !== 'taskId')) throw fault('REQUEST_ROUTE_BLOCKED')
      target = config.statusUrl; headers.set('content-type', 'application/json')
      outgoing.body = JSON.stringify({ id }); mapping = ['taskId URL placeholder -> POST JSON id']
    } else if ((init.method || 'GET') === 'GET' && ['https:', 'http:'].includes(url.protocol) && !headers.has('authorization') && !url.username && !url.password) {
      endpoint = 'artifact_download'
    } else throw fault('REQUEST_ROUTE_BLOCKED')
    outgoing.headers = headers
    outgoing.redirect = endpoint === 'artifact_download' ? 'follow' : 'error'
    const entry = { endpoint, method: outgoing.method || 'GET', mapping, startedAt: iso() }, start = Date.now()
    attempt.trace.push(entry); persist()
    try {
      const result = await fetchImpl(target, outgoing)
      entry.httpStatus = result.status; entry.elapsedMs = Date.now() - start; persist()
      if (result.ok && endpoint !== 'artifact_download') {
        const metadata = await boundedMetadata(result)
        if (Number.isFinite(metadata.code)) entry.providerCode = metadata.code
        const state = metadata.data?.status
        if (['pending', 'queued', 'running', 'processing', 'succeeded', 'failed'].includes(state)) entry.providerState = state
        if (metadata.code !== 0) { persist(); throw fault('PROVIDER_BUSINESS_ERROR') }
        if (endpoint === 'generation_submit' && typeof metadata.data?.id === 'string') {
          onTaskId(metadata.data.id)
          attempt.providerTaskIdHash = sha(metadata.data.id).slice(0, 16)
        }
        persist()
      }
      return result
    } catch (error) { entry.elapsedMs = Date.now() - start; entry.transportOutcome = 'failed_or_unknown'; persist(); throw error }
  }
}

/** Observes/limits transport only: never changes URL, JSON body or authentication. No submission route. */
export function createNativePollProbe(config, taskId, { fetchImpl = fetch, evidence, persist = () => {} } = {}) {
  const downloads = new Set()
  let polled = false
  return async (address, init = {}) => {
    const url = new URL(address), headers = new Headers(init.headers)
    let endpoint
    if (url.href === config.statusUrl && init.method === 'POST') {
      const body = JSON.parse(String(init.body))
      if (polled || typeof taskId !== 'string' || !taskId || body.id !== taskId || Object.keys(body).length !== 1 ||
          headers.get('authorization') !== `Bearer ${config.apiKey}` || !headers.get('content-type')?.startsWith('application/json')) throw fault('REQUEST_ROUTE_BLOCKED')
      polled = true; endpoint = 'native_status_poll'
    } else if ((init.method || 'GET') === 'GET' && downloads.has(url.href) && !headers.has('authorization') && !url.username && !url.password) {
      endpoint = 'artifact_download'
      downloads.delete(url.href)
    } else throw fault('REQUEST_ROUTE_BLOCKED')
    const entry = { endpoint, method: init.method || 'GET', startedAt: iso() }, start = Date.now()
    evidence.trace.push(entry); persist()
    try {
      const response = await fetchImpl(url.href, { ...init, redirect: endpoint === 'artifact_download' ? 'follow' : 'error' })
      entry.httpStatus = response.status; entry.elapsedMs = Date.now() - start; persist()
      if (response.ok && endpoint === 'native_status_poll') {
        const metadata = await boundedMetadata(response)
        if (Number.isFinite(metadata.code)) entry.providerCode = metadata.code
        if (['pending', 'queued', 'running', 'processing', 'succeeded', 'failed'].includes(metadata.data?.status)) entry.providerState = metadata.data.status
        if (metadata.code !== 0) throw fault('PROVIDER_BUSINESS_ERROR')
        for (const item of Array.isArray(metadata.data?.results) ? metadata.data.results : []) {
          const value = typeof item === 'string' ? item : item?.url
          if (typeof value !== 'string') continue
          const target = new URL(value)
          if (['https:', 'http:'].includes(target.protocol) && !target.username && !target.password) downloads.add(target.href)
        }
        evidence.jsonBodyVerified = true; persist()
      }
      return response
    } catch (error) { entry.elapsedMs = Date.now() - start; entry.transportOutcome = 'failed_or_unknown'; persist(); throw error }
  }
}

function durableJson(path, value, { replace = false } = {}) {
  const fd = openSync(path, replace ? 'w' : 'wx', 0o600)
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
}

export function renderReport(report) {
  const lines = ['# Live media validation', '', `Run: ${report.runId}`, `State: ${report.state}`, '',
    'Real provider requests; no QQ delivery. No account creation or supplier substitution. At most two image submissions and one short TTS synthesis; no resubmission on failure or unknown outcome.', '',
    '## Adapter boundary at the original live run', '', ...(report.adapterGapsAtLiveRun || report.adapterGaps).map(g => `- ${g}`), '', '## Results', '']
  for (const a of report.attempts) {
    lines.push(`### ${a.id}`, '', `State: ${a.state}; model: ${a.model || '(not selected)'}; elapsed: ${a.elapsedMs ?? 0} ms; dispatched: ${a.dispatched}.`,
      `Protocol: ${a.protocol || '(not selected)'}. Billing amount was not independently verified.`, '')
    if (a.failure) lines.push(`Failure: ${a.failure.kind}, ${a.failure.code}, HTTP ${a.failure.httpStatus || 'unavailable'}. No resubmit.`, '')
    for (const artifact of a.artifacts) {
      lines.push(`- ${artifact.path}: ${artifact.bytes} bytes; ${artifact.mime}; SHA256 ${artifact.sha256}; decoder ${artifact.decode?.ok ? 'passed' : 'not confirmed'}.`)
      if (artifact.decode?.width) lines.push(`  Dimensions: ${artifact.decode.width} × ${artifact.decode.height}.`)
      if (artifact.decode?.durationSeconds) lines.push(`  Duration: ${artifact.decode.durationSeconds} s; ${artifact.decode.sampleRate} Hz; ${artifact.decode.channels} channel(s); non-silent: ${artifact.decode.nonSilent}. Intelligibility not verified.`)
    }
    if (a.lineage) lines.push('', `Lineage: ${a.lineage.scope}; parent SHA256 ${a.lineage.parentSha256 || 'none'}; request/output references recorded. Application database lineage was not exercised.`)
    lines.push('')
  }
  if (report.skipped?.length) lines.push('## Skipped', '', ...report.skipped.map(s => `- ${s.id}: ${s.reason}`), '')
  if (report.productionAdapter) {
    const p = report.productionAdapter
    lines.push('## Production adapter follow-up', '', ...p.changes.map(change => `- ${change}`), '',
      `Private installer fields: ${p.privateFile}, productionImageProfile and productionVoiceConfig. Credentials are only in that local private file.`,
      `Profile ID: ${p.profileId}; declared modes: text/reference only. Voice mapping equals speechConfig used in this live run.`, '')
    if (p.nativePoll) {
      const n = p.nativePoll
      lines.push(`Native polling: ${n.state}; reused ${n.existingAttempt}; elapsed ${n.elapsedMs ?? 0} ms; no generation submit.`,
        `POST JSON body verified: ${Boolean(n.jsonBodyVerified)}; original output hashes matched: ${Boolean(n.allOutputHashesMatch)}.`, '')
      if (n.failure) lines.push(`Native poll failure: ${n.failure.kind}, ${n.failure.code}. No submit or retry.`, '')
    }
    lines.push('No additional paid generation was used to exercise the new native submission template. Its exact data URL encoding is covered by local HTTP/mock tests; the original real reference request used the explicitly recorded bridge.', '')
  }
  if (report.visualInspection) lines.push('## Visual inspection', '', report.visualInspection.observation, '', 'This is visual evidence for the example, not a guarantee of pixel-preserving editing or mask support.', '')
  if (report.validation) lines.push('## Regression validation', '', ...report.validation.map(v => `- ${v.command}: ${v.passed} passed, ${v.failed} failed (${v.scope}).`), '')
  lines.push('## Evidence limits', '', 'Transport, complete format decoding and local request/artifact hash lineage were verified. Speech intelligibility, application database lineage and QQ/full application delivery were not verified. Billing amounts were not independently checked; no automatic resubmissions were made.', '')
  return lines.join('\n')
}

function persistReport(report) {
  const pending = join(MEDIA, 'report.pending.json')
  durableJson(pending, report, { replace: existsSync(pending) })
  renameSync(pending, REPORT)
  writeFileSync(MARKDOWN, renderReport(report))
}

function completedRun() {
  const privateConfig = JSON.parse(readFileSync(PRIVATE, 'utf8')), report = JSON.parse(readFileSync(REPORT, 'utf8'))
  if (privateConfig.schema !== 'aurabot.live-media.private' || !report.finishedAt || !['completed', 'completed_with_limits'].includes(report.state)) throw fault('LIVE_RUN_NOT_COMPLETE')
  return { privateConfig, report }
}

function prepareProduction() {
  const { privateConfig, report } = completedRun()
  const image = productionImageProfile(privateConfig.image)
  if (validateHttpProfile(image).length) throw fault('PRODUCTION_CONFIG_NOT_PREPARED')
  privateConfig.productionImageProfile = image
  privateConfig.productionVoiceConfig = speechConfig(privateConfig.tts)
  durableJson(PRIVATE, privateConfig, { replace: true })
  report.adapterGapsAtLiveRun ||= report.adapterGaps
  report.adapterGaps = ['No dedicated pixel-preserving edit/mask endpoint was established for this supplier; production modes remain text/reference.']
  report.productionAdapter = { ...report.productionAdapter, preparedAt: iso(), privateFile: PRIVATE,
    profileId: image.id, adapterSha256: sha(readFileSync(join(ROOT, 'src/providers/image/http.js'))), changes: [
      'Resolved: extra.status.bodyType=json and extra.status.body support POST JSON taskId templates; legacy bodyless GET/POST polling is unchanged.',
      'Resolved: {imagesDataUrls} inserts an unquoted JSON array of data URL strings; {imagesJson} remains compatible.',
      'New array input checks actual image bytes and MIME before sending; placeholders use single-pass escaping.',
      'Production profile exposes text/reference only; exact edit/mask endpoints remain unsupported/unverified.',
    ] }
  report.visualInspection = { observation: 'Both inspected images show the same blue whale and ocean composition; the second adds a small yellow/golden starfish above the whale, matching this example\'s intent.',
    checkedByAssistant: true, confirmedByMainThread: true, pixelIdentityClaimed: false }
  persistReport(report)
  console.log(JSON.stringify({ event: 'production_config_prepared', profileId: image.id, modes: image.capabilities.modes,
    privateFields: ['productionImageProfile', 'productionVoiceConfig'], credentialsPrinted: false }))
}

async function verifyNativePoll() {
  const { privateConfig, report } = completedRun()
  const p = report.productionAdapter
  if (!privateConfig.productionImageProfile || !p || validateHttpProfile(privateConfig.productionImageProfile).length) throw fault('PRODUCTION_CONFIG_NOT_PREPARED')
  if (p.nativePoll) throw fault('NATIVE_POLL_ALREADY_RESERVED')
  const existing = report.attempts.find(a => a.id === 'image_edit' && a.state === 'succeeded') || report.attempts.find(a => a.id === 'image_generate' && a.state === 'succeeded')
  const taskId = privateConfig.state?.providerTaskIds?.[existing?.id]
  if (!existing || !taskId) throw fault('PRODUCTION_CONFIG_NOT_PREPARED')
  const start = Date.now(), evidence = { state: 'reserved', startedAt: iso(), existingAttempt: existing.id,
    providerTaskIdHash: sha(taskId).slice(0, 16), generationSubmissions: 0, trace: [], transportTransforms: [] }
  p.nativePoll = evidence
  const persist = () => persistReport(report)
  persist()
  try {
    const fetchImpl = createNativePollProbe(privateConfig.image, taskId, { evidence, persist })
    const { adapter } = adapterFor(privateConfig.productionImageProfile, { fetchImpl })
    const result = await adapter.poll(taskId, { signal: AbortSignal.timeout(60000) })
    evidence.resultStatus = result.status
    evidence.outputs = (result.outputs || []).map(output => ({ sha256: sha(output.buf), bytes: output.buf.length, ...imageInfo(output.buf) }))
    evidence.allOutputHashesMatch = evidence.outputs.length === existing.artifacts.length && evidence.outputs.every((out, i) => out.sha256 === existing.artifacts[i].sha256)
    evidence.state = result.status === 'done' && evidence.allOutputHashesMatch ? 'verified' : 'unconfirmed'
  } catch (error) { evidence.state = 'failed_or_unknown'; evidence.failure = safeFailure(error) }
  evidence.finishedAt = iso(); evidence.elapsedMs = Date.now() - start; persist()
  console.log(JSON.stringify({ event: 'native_poll_finished', state: evidence.state, jsonBodyVerified: Boolean(evidence.jsonBodyVerified),
    originalOutputMatched: Boolean(evidence.allOutputHashesMatch), generationSubmissions: 0 }))
  if (evidence.state !== 'verified') process.exitCode = 1
}

function verifySaved(file, type) {
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,width,height,sample_rate,channels', '-of', 'json', file], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true })
  const decode = spawnSync('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true })
  let json
  try { json = JSON.parse(probe.stdout || '{}') } catch { json = {} }
  const stream = json.streams?.[0] || {}, duration = Number(json.format?.duration)
  const result = { ok: probe.status === 0 && decode.status === 0, fullDecode: decode.status === 0,
    codec: /^[a-z0-9_]+$/i.test(stream.codec_name || '') ? stream.codec_name : undefined,
    ...(Number.isFinite(duration) ? { durationSeconds: duration } : {}),
    ...(Number.isFinite(stream.width) ? { width: stream.width, height: stream.height } : {}),
    ...(stream.sample_rate ? { sampleRate: Number(stream.sample_rate), channels: Number(stream.channels) } : {}) }
  if (type === 'tts' && result.ok) {
    const pcm = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'], { timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
    let sum = 0, peak = 0
    for (let n = 0; n + 1 < (pcm.stdout?.length || 0); n += 2) { const v = pcm.stdout.readInt16LE(n); sum += v * v; peak = Math.max(peak, Math.abs(v)) }
    result.pcmSamples = Math.floor((pcm.stdout?.length || 0) / 2)
    result.rms = result.pcmSamples ? Math.sqrt(sum / result.pcmSamples) : 0
    result.peak = peak; result.nonSilent = peak > 100; result.intelligibilityVerified = false
  }
  return result
}

async function runImage(id, config, report, privateConfig, parent) {
  const attempt = reserveAttempt(report, id, 'image', () => persistReport(report))
  const started = Date.now(), persist = () => persistReport(report)
  attempt.model = safeModel(config.model); attempt.protocol = 'http + explicit GRSAI wire bridge'
  attempt.prompt = parent ? EDIT_PROMPT : IMAGE_PROMPT
  attempt.lineage = { scope: 'standalone request/artifact hashes', parentSha256: parent?.sha256 || null,
    applicationGenerationLineageVerified: false, mode: parent ? 'edit' : 'text' }
  const fetchImpl = createGrsaiBridge(config, { fetchImpl: globalThis.fetch.bind(globalThis), attempt, persist,
    onTaskId: id => { privateConfig.state.providerTaskIds[attempt.id] = id; durableJson(PRIVATE, privateConfig, { replace: true }) } })
  try {
    const profile = imageProfile(config), problems = validateHttpProfile(profile)
    if (problems.length) throw fault('UNSUPPORTED_LEGACY_PROTOCOL')
    const { adapter, caps } = adapterFor(profile, { fetchImpl })
    const req = { mode: parent ? 'edit' : 'text', prompt: attempt.prompt, size: config.size, n: 1,
      inputs: parent ? [{ buf: readFileSync(join(ROOT, parent.path)), mime: parent.mime, role: 'base' }] : [], idempotencyKey: report.runId + ':' + id }
    if (checkRequest(req, caps)) throw fault('REFERENCE_FORMAT_INVALID')
    let result = await adapter.submit(req, { signal: AbortSignal.timeout(180000) })
    const deadline = Date.now() + 330000
    while (result.status === 'running') {
      attempt.state = 'running'; persist()
      if (Date.now() >= deadline) throw fault('POLL_DEADLINE')
      await delay(5000)
      result = await adapter.poll(result.providerTaskId, { signal: AbortSignal.timeout(60000) })
    }
    if (result.status !== 'done') throw result.error || fault('PROVIDER_BUSINESS_ERROR')
    if (!result.outputs?.length) throw fault('OUTPUT_VALIDATION_FAILED')
    attempt.adapterBilling = result.billing || 'unknown'
    for (let n = 0; n < result.outputs.length; n++) {
      const output = result.outputs[n], info = imageInfo(output.buf)
      const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[info.mime]
      const file = join(MEDIA, `${id}-${n + 1}.${extension}`)
      writeFileSync(file, output.buf, { flag: 'wx' })
      attempt.artifacts.push({ path: rel(file), bytes: output.buf.length, mime: info.mime, width: info.width, height: info.height,
        sha256: sha(output.buf), decode: verifySaved(file, 'image') })
    }
    attempt.lineage.outputSha256 = attempt.artifacts.map(a => a.sha256)
    attempt.state = attempt.artifacts.every(a => a.decode.ok) ? 'succeeded' : 'saved_decode_unconfirmed'
  } catch (error) { attempt.failure = safeFailure(error, attempt); attempt.state = attempt.failure.mayHaveBeenCharged ? 'failed_or_unknown' : 'preflight_failed' }
  attempt.finishedAt = iso(); attempt.elapsedMs = Date.now() - started; persist()
  console.log(JSON.stringify({ event: 'stage_finished', id: attempt.id, state: attempt.state, files: attempt.artifacts.length }))
  return attempt.state === 'succeeded' ? attempt.artifacts[0] : null
}

async function runSpeech(config, report) {
  const attempt = reserveAttempt(report, 'tts', 'tts', () => persistReport(report)), start = Date.now()
  attempt.model = safeModel(config.model); attempt.voice = safeModel(config.voice); attempt.protocol = 'http / OpenAI-compatible audio speech wire'
  attempt.text = SPEECH_TEXT
  const originalFetch = globalThis.fetch, previousDataDir = process.env.AURABOT_DATA_DIR
  const isolated = join(MEDIA, 'tts-' + report.runId)
  process.env.AURABOT_DATA_DIR = isolated
  globalThis.fetch = async (address, init = {}) => {
    if (String(address) !== config.url || init.method !== 'POST') throw fault('REQUEST_ROUTE_BLOCKED')
    markDispatch(attempt, () => persistReport(report))
    const entry = { endpoint: 'tts_synthesize', method: 'POST', startedAt: iso() }, began = Date.now()
    attempt.trace.push(entry); persistReport(report)
    const result = await originalFetch(address, { ...init, redirect: 'error' })
    entry.httpStatus = result.status; entry.elapsedMs = Date.now() - began; persistReport(report)
    return result
  }
  try {
    const result = await textToSpeech(SPEECH_TEXT, speechConfig(config))
    const buf = readFileSync(result.file), normalized = normalizeAudio(buf)
    const file = join(MEDIA, 'tts-short.' + normalized.ext)
    writeFileSync(file, normalized.buf, { flag: 'wx' })
    const mime = { mp3: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac', silk: 'audio/silk' }[normalized.ext]
    attempt.artifacts.push({ path: rel(file), bytes: buf.length, mime, sha256: sha(buf), decode: verifySaved(file, 'tts') })
    attempt.state = attempt.artifacts[0].decode.ok ? 'succeeded' : 'saved_decode_unconfirmed'
  } catch (error) { attempt.failure = safeFailure(error, attempt); attempt.state = attempt.failure.mayHaveBeenCharged ? 'failed_or_unknown' : 'preflight_failed' }
  finally {
    globalThis.fetch = originalFetch
    if (previousDataDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previousDataDir
  }
  attempt.finishedAt = iso(); attempt.elapsedMs = Date.now() - start; persistReport(report)
  console.log(JSON.stringify({ event: 'stage_finished', id: attempt.id, state: attempt.state, files: attempt.artifacts.length }))
}

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 1 || !['--run', '--inspect', '--prepare-production', '--verify-native-poll'].includes(args[0])) throw fault('REQUEST_ROUTE_BLOCKED')
  if (args[0] === '--prepare-production') return prepareProduction()
  if (args[0] === '--verify-native-poll') return verifyNativePoll()
  const config = JSON.parse(readFileSync(join(OLD, 'config.json'), 'utf8'))
  const imageSource = readFileSync(join(OLD, 'local/image.mjs'), 'utf8'), voiceSource = readFileSync(join(OLD, 'local/tts.mjs'), 'utf8')
  const moduleSource = readFileSync(join(OLD, 'modules/imagegen/index.mjs'), 'utf8')
  const privateConfig = derivePrivateConfig(config, imageSource, voiceSource, moduleSource)
  const summary = { image: { model: safeModel(privateConfig.image.model), protocol: 'GRSAI asynchronous HTTP', credentialConfigured: true },
    tts: { model: safeModel(privateConfig.tts.model), voice: safeModel(privateConfig.tts.voice), protocol: 'HTTP audio speech', credentialConfigured: true } }
  if (!args.includes('--run')) { console.log(JSON.stringify({ mode: 'inspect_only', ...summary })); return }
  mkdirSync(MEDIA, { recursive: true })
  const lockPath = join(MEDIA, 'live.lock')
  if (existsSync(lockPath) || existsSync(REPORT)) throw fault('LIVE_RUN_ALREADY_RESERVED')
  if (existsSync(PRIVATE)) throw fault('PRIVATE_CONFIG_EXISTS')
  const runId = randomUUID()
  durableJson(lockPath, { runId, pid: process.pid, startedAt: iso(), policy: 'Never automatically resubmit; persistent lock intentionally retained.' })
  durableJson(PRIVATE, privateConfig)
  const sourceFiles = ['src/providers/image/index.js', 'src/providers/image/http.js', 'src/providers/image/common.js', 'src/voice/tts.js']
  const report = { schema: 'aurabot.live-media.report', version: 1, runId, state: 'running', startedAt: iso(), suppliers: summary,
    budget: { maxImageSubmissions: 2, maxTtsSyntheses: 1, autoRetry: false }, noQqDelivery: true, originalDataReadOnly: true,
    sourceHashes: Object.fromEntries(sourceFiles.map(path => [path, sha(readFileSync(join(ROOT, path)))])),
    adapterGaps: [
      'Native HTTP image polling does not send POST JSON bodies; this harness bridges taskId into the legacy GRSAI {id} body.',
      'Native imagesJson is an object array; this harness converts validated base-image bytes to the legacy data URL array.',
      'GRSAI input is reference-conditioned generation; a dedicated pixel-preserving edit/mask endpoint was not established.',
      'TTS uses the new fixed HTTP mapping to preserve the existing StepFun model, voice and instruction; no fallback model or provider is called.',
    ], attempts: [], skipped: [] }
  persistReport(report)
  console.log(JSON.stringify({ event: 'live_run_started', runId, budget: report.budget }))
  const parent = await runImage('image_generate', privateConfig.image, report, privateConfig)
  if (parent && privateConfig.image.referenceInputConfigured) await runImage('image_edit', privateConfig.image, report, privateConfig, parent)
  else { report.skipped.push({ id: 'image_edit', reason: parent ? 'Existing source does not establish reference-input support.' : 'Generation did not produce a verified base image; no second generation submitted.' }); persistReport(report) }
  await runSpeech(privateConfig.tts, report)
  report.finishedAt = iso(); report.state = report.attempts.every(a => a.state === 'succeeded') && !report.skipped.length ? 'completed' : 'completed_with_limits'
  report.sourceHashesAfter = Object.fromEntries(sourceFiles.map(path => [path, sha(readFileSync(join(ROOT, path)))]))
  report.adaptersUnchangedDuringRun = JSON.stringify(report.sourceHashes) === JSON.stringify(report.sourceHashesAfter)
  persistReport(report)
  console.log(JSON.stringify({ event: 'live_run_finished', state: report.state, report: rel(REPORT), imageSubmissions: report.attempts.filter(a => a.type === 'image' && a.dispatched).length, ttsSyntheses: report.attempts.filter(a => a.type === 'tts' && a.dispatched).length }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify({ event: 'stopped_without_retry', failure: safeFailure(error) })); process.exitCode = 1 })
}

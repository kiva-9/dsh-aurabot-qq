import { fail, integer, text, VectorError } from './space.js'

export function httpBase(value) {
  text(value, 'baseUrl', { max: 4096 })
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('INVALID_ENDPOINT', 'Use an HTTP(S) baseUrl without credentials/query/fragment')
  return url.href.replace(/\/$/, '')
}

export async function requestJson(url, { method = 'GET', body, headers = {}, timeoutMs = 15000, maxResponseBytes = 16 * 1024 * 1024, signal } = {}) {
  integer(timeoutMs, 'timeoutMs', 1, 300000)
  integer(maxResponseBytes, 'maxResponseBytes', 128, 128 * 1024 * 1024)
  const timeout = AbortSignal.timeout(timeoutMs)
  let response
  try {
    response = await fetch(url, { method, redirect: 'error', headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    if (!response.ok) {
      await response.body?.cancel()
      const error = new VectorError('HTTP_ERROR', `Embedding/vector endpoint returned HTTP ${response.status}`)
      error.status = response.status
      throw error
    }
    const chunks = []; let bytes = 0
    for await (const chunk of response.body) {
      bytes += chunk.byteLength
      if (bytes > maxResponseBytes) fail('RESPONSE_TOO_LARGE', 'HTTP JSON response exceeds configured limit')
      chunks.push(chunk)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { fail('INVALID_HTTP_RESPONSE', 'Endpoint did not return valid JSON') }
  } catch (error) {
    if (error instanceof VectorError) throw error
    // Never include URLs, auth headers, server response bodies or input text in errors.
    if (timeout.aborted || signal?.aborted) fail('HTTP_TIMEOUT', 'Embedding/vector request timed out or was cancelled')
    fail('HTTP_UNAVAILABLE', 'Embedding/vector endpoint could not be reached')
  }
}

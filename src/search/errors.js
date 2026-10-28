export class SearchError extends Error {
  constructor(code, message, status = 0) {
    super(message)
    this.name = 'SearchError'
    this.code = code
    this.status = status
  }
}

export const fail = (code, message, status) => { throw new SearchError(code, message, status) }
export const errorView = (error) => ({
  code: error instanceof SearchError ? error.code : 'SEARCH_FAILED',
  message: error instanceof SearchError ? error.message : '搜索操作失败',
})

export function checkSignal(signal) {
  if (signal?.aborted) throw signal.reason instanceof SearchError ? signal.reason : new SearchError('CANCELED', '搜索操作已取消')
}

/** Also bounds DNS and adapters which cannot physically abort. Late results never commit. */
export function abortable(promise, signal) {
  checkSignal(signal)
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const abort = () => { try { checkSignal(signal) } catch (e) { reject(e) } }
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export function deadline(timeoutMs, signals = []) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new SearchError('TIMEOUT', '搜索操作超时')), timeoutMs)
  const links = signals.filter(Boolean).map((signal) => {
    const onAbort = () => controller.abort(signal.reason instanceof SearchError ? signal.reason : new SearchError('CANCELED', '搜索操作已取消'))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    return () => signal.removeEventListener('abort', onAbort)
  })
  return { signal: controller.signal, close() { clearTimeout(timer); links.forEach((off) => off()) } }
}

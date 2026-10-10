/**
 * The only place in the service that speaks HTTP to a model provider.
 *
 * ## Why not a client library
 *
 * The service proxies two wire shapes — a JSON completion and an SSE stream of
 * JSON deltas — off the same endpoint, and it needs three things a general
 * OpenAI client hides: the exact upstream status and body when something fails
 * (so the breaker can classify it and the converter can re-shape it), the
 * `retry-after` header (so a rate limit becomes a scheduled retry rather than a
 * guess), and the moment the response headers arrive (so failover can happen
 * *before* a single byte has been written to the caller, which is the whole
 * reason a proxy can fail over at all). All three are one `fetch` away, and
 * adding a dependency to get them back would be the wrong trade.
 *
 * ## Failure is a value, not an exception
 *
 * Every outcome a caller can act on comes back as a result object: a network
 * error, a non-2xx status, a body that would not parse. Only an aborted request
 * throws, because that is the one case where the caller asked for it. The proxy
 * above therefore has a single shape to branch on, and the breaker has a single
 * shape to record.
 *
 * ## Timeouts are per-phase on purpose
 *
 * A non-streaming call gets one deadline. A streaming call cannot: a legitimate
 * answer may stream for minutes, so the budget that matters is the *gap* between
 * chunks. Both phases are watched — nothing arrives at all, and nothing arrives
 * for a while — and the watchdog is torn down as soon as the response body ends,
 * so a long healthy stream is never killed by a total-time ceiling.
 *
 * @module dsh-prompt-tuner/service/upstream
 */

/** No response headers within this window means the route is wedged. */
export const FIRST_BYTE_TIMEOUT_MS = 120_000

/** No chunk within this window means a stream that was alive has stalled. */
export const STREAM_IDLE_TIMEOUT_MS = 120_000

/** Longest `retry-after` worth honouring before failing over instead. */
export const MAX_RETRY_AFTER_MS = 5_000

/**
 * Read `retry-after` (and its millisecond spelling) from response headers.
 *
 * Both spellings are real: `retry-after` is the standard one and is expressed in
 * seconds or as an HTTP date, while `retry-after-ms` is a de-facto extension some
 * gateways send. A hint longer than {@link MAX_RETRY_AFTER_MS} is reported
 * verbatim and left for the caller to interpret — "wait ten minutes" is a reason
 * to fail over, not a reason for this module to decide.
 * @param {Headers} headers - the response headers.
 * @returns {number|null} milliseconds, or null when absent/unparseable.
 */
export function retryAfterMs(headers) {
  // `Number(null)` is 0, not NaN, so a missing header must be rejected by type
  // before it is coerced — otherwise every response without `retry-after-ms`
  // would claim a zero-millisecond delay.
  const rawMillis = headers?.get?.('retry-after-ms')
  if (typeof rawMillis === 'string' && rawMillis.trim() !== '') {
    const millis = Number(rawMillis)
    if (Number.isFinite(millis) && millis >= 0) return millis
  }
  const raw = headers?.get?.('retry-after')
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const date = Date.parse(raw)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  return null
}

/**
 * A compact message out of whatever error envelope the upstream used.
 * @param {unknown} parsed - the parsed body, when it parsed.
 * @param {string} text - the raw body text.
 * @returns {string} something worth showing a human.
 */
function messageFrom(parsed, text) {
  const candidate = parsed?.error?.message ?? parsed?.error?.detail ?? parsed?.message ?? parsed?.detail
  if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim().slice(0, 800)
  const raw = typeof text === 'string' ? text.trim() : ''
  return raw === '' ? 'the upstream answered without a body' : raw.slice(0, 800)
}

/** Parse a body that may not be JSON at all. */
function parseMaybeJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Turn a `fetch` rejection into a classified failure.
 * @param {unknown} cause - whatever fetch threw.
 * @param {boolean} aborted - whether the caller's own signal fired.
 * @returns {{ok: false, status: number, body: null, code: string, message: string, retryAfterMs: null}} the failure.
 */
function transportFailure(cause, aborted) {
  const name = typeof cause?.name === 'string' ? cause.name : ''
  const message = String(cause?.message ?? cause)
  if (aborted) return { ok: false, status: 0, body: null, code: 'ABORTED', message, retryAfterMs: null }
  if (name === 'TimeoutError' || name === 'AbortError') {
    return { ok: false, status: 0, body: null, code: 'TIMEOUT', message, retryAfterMs: null }
  }
  return { ok: false, status: 0, body: null, code: 'TRANSPORT', message, retryAfterMs: null }
}

/**
 * Join a base URL and a path without doubling or dropping the separator.
 * @param {string} baseURL - the provider's base URL.
 * @param {string} path - the path to append.
 * @returns {string} the full URL.
 */
export function joinUrl(baseURL, path) {
  const base = String(baseURL ?? '').replace(/\/+$/, '')
  const suffix = String(path ?? '').replace(/^\/+/, '')
  return `${base}/${suffix}`
}

/**
 * Call one provider once, either as a JSON request or as an SSE stream.
 *
 * @param {object} options - the call.
 * @param {object} options.provider - the configured provider (`baseURL`, `apiKey`, `headers`, `timeoutMs`).
 * @param {object} options.body - the request body to send (already converted).
 * @param {boolean} options.stream - whether to ask for and return an SSE stream.
 * @param {AbortSignal} [options.signal] - the caller's cancellation.
 * @param {string} [options.path] - endpoint path; defaults to `chat/completions`.
 * @returns {Promise<object>} one of:
 *   - `{ok: true, status, headers, json}` for a completed non-streaming call;
 *   - `{ok: true, status, headers, stream}` where `stream` is an async iterable of parsed SSE payloads;
 *   - `{ok: false, status, body, code, message, retryAfterMs}` for every failure.
 */
export async function callUpstream(options) {
  const { provider, body, stream } = options
  const signal = options.signal
  const path = options.path ?? 'chat/completions'
  const url = joinUrl(provider?.baseURL, path)
  if (url === '/chat/completions' || url === 'chat/completions') {
    return { ok: false, status: 0, body: null, code: 'CONFIG', message: `provider "${provider?.id ?? '?'}" has no baseURL`, retryAfterMs: null }
  }
  const timeoutMs = Number.isFinite(provider?.timeoutMs) ? provider.timeoutMs : FIRST_BYTE_TIMEOUT_MS
  const headers = {
    'content-type': 'application/json',
    accept: stream === true ? 'text/event-stream' : 'application/json',
    ...(typeof provider?.apiKey === 'string' && provider.apiKey !== '' ? { authorization: `Bearer ${provider.apiKey}` } : {}),
    ...(provider?.headers ?? {}),
  }

  // Phase watchdogs. The controller is shared with the caller's signal so that
  // either side can end the call, and the timer is replaced between chunks for
  // streams — the deadline is always "the next thing I am waiting for".
  const controller = new AbortController()
  const abort = (reason) => controller.abort(reason)
  const onOuterAbort = () => abort(signal?.reason)
  if (signal !== undefined) {
    if (signal.aborted) return transportFailure(signal.reason ?? new Error('aborted'), true)
    signal.addEventListener('abort', onOuterAbort, { once: true })
  }
  let timer = setTimeout(() => abort(new Error(`no response headers within ${timeoutMs}ms`)), timeoutMs)
  const reset = (ms, note) => {
    clearTimeout(timer)
    timer = setTimeout(() => abort(new Error(note)), ms)
  }
  const clear = () => {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onOuterAbort)
  }

  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (cause) {
    clear()
    return transportFailure(cause, signal?.aborted === true)
  }

  const responseHeaders = response.headers
  const reported = retryAfterMs(responseHeaders)
  if (!response.ok) {
    clear()
    let text = ''
    try {
      text = await response.text()
    } catch {
      text = ''
    }
    const parsed = parseMaybeJson(text)
    return {
      ok: false,
      status: response.status,
      body: parsed ?? (text === '' ? null : { error: { message: text.slice(0, 800) } }),
      code: `HTTP_${response.status}`,
      message: messageFrom(parsed, text),
      retryAfterMs: reported,
    }
  }

  if (stream !== true) {
    clear()
    let text = ''
    try {
      text = await response.text()
    } catch (cause) {
      return transportFailure(cause, signal?.aborted === true)
    }
    const parsed = parseMaybeJson(text)
    if (parsed === null) {
      return {
        ok: false,
        status: response.status,
        body: null,
        code: 'MALFORMED',
        message: 'the upstream answered 200 with a body that is not JSON',
        retryAfterMs: reported,
      }
    }
    return { ok: true, status: response.status, headers: responseHeaders, json: parsed }
  }

  // Streaming: hand back an iterable that owns the idle watchdog for as long as
  // it is being read. The caller may stop early; the generator's `finally`
  // releases the timer and the body either way.
  const idleMs = Number.isFinite(provider?.timeoutMs) ? provider.timeoutMs : STREAM_IDLE_TIMEOUT_MS
  const bodyStream = response.body
  if (bodyStream === null || bodyStream === undefined) {
    clear()
    return {
      ok: false,
      status: response.status,
      body: null,
      code: 'MALFORMED',
      message: 'the upstream answered 200 with no response body',
      retryAfterMs: reported,
    }
  }

  async function* iterate() {
    const reader = bodyStream.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      reset(idleMs, `no chunk within ${idleMs}ms`)
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        reset(idleMs, `no chunk within ${idleMs}ms`)
        buffer += decoder.decode(value, { stream: true })
        let index = buffer.indexOf('\n')
        while (index >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, '')
          buffer = buffer.slice(index + 1)
          const payload = ssePayload(line)
          if (payload !== undefined) yield payload
          index = buffer.indexOf('\n')
        }
      }
      buffer += decoder.decode()
      const payload = ssePayload(buffer.replace(/\r$/, ''))
      if (payload !== undefined) yield payload
    } finally {
      clear()
      try {
        await reader.cancel()
      } catch {
        // The body is already gone; there is nothing left to release.
      }
    }
  }

  return { ok: true, status: response.status, headers: responseHeaders, stream: iterate(), retryAfterMs: reported }
}

/**
 * The JSON a single SSE line carries.
 *
 * The return value distinguishes three things the caller must not conflate: an
 * object to forward, `null` for the terminal `[DONE]` sentinel, and `undefined`
 * for a line that carries nothing (a comment, a blank, an `event:` header) and
 * should simply be skipped.
 * @param {string} line - one raw SSE line.
 * @returns {object|null|undefined} the payload, the sentinel, or nothing.
 */
export function ssePayload(line) {
  const trimmed = String(line ?? '').trim()
  if (trimmed === '' || trimmed.startsWith(':')) return undefined
  if (!trimmed.startsWith('data:')) return undefined
  const data = trimmed.slice(5).trim()
  if (data === '') return undefined
  if (data === '[DONE]') return null
  try {
    return JSON.parse(data)
  } catch {
    return undefined
  }
}

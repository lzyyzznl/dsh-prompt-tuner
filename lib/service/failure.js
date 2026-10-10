/**
 * What a failure *means*, decided once, so that everything downstream can stop
 * guessing.
 *
 * ## Why this is a module and not a few `if`s
 *
 * The service takes three different actions on a failed attempt, and all three
 * need the same answer:
 *
 *   - whether the failure counts against the breaker (and how hard it pushes);
 *   - whether the credential behind the route is *dead* rather than unlucky;
 *   - how long to stay away, when the upstream said so itself.
 *
 * Spreading that judgement across the proxy, the router and the admin page is
 * how a service ends up retrying a revoked API key forever while treating a
 * malformed request as a provider outage — which is exactly the bug this module
 * exists to make impossible. It is pure: no clock, no network, no config.
 *
 * ## The line that matters most: whose fault is it
 *
 * A failure is either *the route's* or *the request's*.
 *
 * The request's own faults — a body the contract rejects, a model that does not
 * exist, a completion the caller cancelled — say nothing about the provider's
 * health, and a router that counts them will fail over away from a perfectly
 * good provider and then trip its breaker with nothing but its own noise. So
 * those are `non_retryable`/`client_cancel` and are ignored for accounting.
 *
 * The route's faults are `retryable` (transient: timeouts, transport errors,
 * 5xx) and `overloaded` (the upstream is up but asking for less: 429, 503, 529).
 * The difference between the two is how much evidence is required before the
 * breaker opens: a rate limit is proof on its own, a timeout is a hint.
 *
 * ## A dead credential is not a flaky one
 *
 * `401`/`402`/`403` are not slowness, they are an answer: this key will not work
 * until a human changes something. Counting them toward a cooldown-based breaker
 * would produce the worst possible behaviour — retry a revoked key, wait, retry
 * it again, forever. They become a **blacklist entry** instead
 * ({@link blacklistVerdict}), which is persistent, visible on the admin page, and
 * cleared only by the operator (or by the upstream's own reset hint, when it
 * gives one).
 *
 * @module dsh-prompt-tuner/service/failure
 */

/** The classes a failure can belong to. */
export const FAILURE_CLASSES = Object.freeze(['retryable', 'overloaded', 'non_retryable', 'quota', 'client_cancel'])

/** Classes whose failures count against a breaker at all. */
const BREAKER_RELEVANT = Object.freeze(['retryable', 'overloaded'])

/**
 * Classes that are proof enough to open a breaker on a single occurrence.
 *
 * A 429 or a 503 is the upstream telling us to back off; waiting for a second
 * confirmation only spends another request to learn what we were already told.
 */
const OPENS_IMMEDIATELY = Object.freeze(['overloaded'])

/** Statuses meaning "your request is wrong", never "the route is wrong". */
const REQUEST_FAULT_STATUSES = Object.freeze([400, 404, 405, 406, 409, 413, 414, 415, 422, 501])

/** Statuses meaning "slow down", which is the upstream asking for less. */
const OVERLOADED_STATUSES = Object.freeze([429, 503, 529])

/** Statuses that name a credential problem rather than a capacity problem. */
const DEAD_CREDENTIAL_STATUSES = Object.freeze([401, 402, 403])

/** Error codes upstreams use for a credential that will not work again. */
const AUTH_CODES = Object.freeze([
  'invalid_api_key',
  'incorrect_api_key',
  'authentication_error',
  'unauthenticated',
  'invalid_authentication',
  'account_deactivated',
  'account_disabled',
])

/** Error codes for a permission the credential does not have. */
const PERMISSION_CODES = Object.freeze([
  'permission_error',
  'permission_denied',
  'insufficient_permissions',
  'access_denied',
  'forbidden',
])

/** Error codes for a bill that needs paying. */
const QUOTA_CODES = Object.freeze([
  'insufficient_quota',
  'insufficient_balance',
  'insufficient_funds',
  'quota_exceeded',
  'billing_hard_limit_reached',
  'billing_error',
  'account_deactivated_billing',
])

/** Prose that means "no money left" even when shipped under a 400 or a 429. */
const QUOTA_PHRASES = Object.freeze([
  'insufficient balance',
  'insufficient_quota',
  'insufficient quota',
  'insufficient funds',
  'exceeded your current quota',
  'quota exceeded',
  'out of credits',
  'no credit',
  'balance is not enough',
  'not enough balance',
  '账户余额不足',
  '余额不足',
  '额度不足',
])

/** Prose that means "this credential is not accepted". */
const AUTH_PHRASES = Object.freeze([
  'invalid api key',
  'invalid_api_key',
  'incorrect api key',
  'api key not valid',
  'invalid authentication',
  'authentication failed',
  'unauthorized',
  'no api key',
  'key is invalid',
  '无效的api key',
  '鉴权失败',
  '认证失败',
])

/** Prose that means "the credential works but is not allowed here". */
const PERMISSION_PHRASES = Object.freeze([
  'permission denied',
  'no permission',
  'not allowed',
  'forbidden',
  'access denied',
  'does not have access',
  '无权限',
  '没有权限',
])

/** Lower-case a value that may be anything at all. */
function lower(value) {
  return typeof value === 'string' ? value.toLowerCase() : ''
}

/** Whether a list contains a value, case-insensitively. */
function has(list, value) {
  const needle = lower(value)
  if (needle === '') return false
  return list.some((entry) => lower(entry) === needle)
}

/** Whether any of these fragments appears in the text. */
function mentions(text, phrases) {
  const haystack = lower(text)
  if (haystack === '') return false
  return phrases.some((phrase) => haystack.includes(lower(phrase)))
}

/**
 * The flattened text of a failure, for phrase matching.
 *
 * Upstreams put the same sentence in a different place depending on how they
 * failed: `error.message`, `error.detail`, a bare `detail`, or a plain string
 * body. Matching against all of them at once is what keeps the classifier from
 * depending on which shape today's gateway happens to use.
 * @param {object|undefined} failure - the failure observed.
 * @returns {string} everything worth matching against.
 */
export function failureText(failure) {
  const parts = []
  const seen = new Set()
  const push = (value) => {
    if (typeof value !== 'string') return
    const text = value.trim()
    // Gateways repeat themselves: the same sentence arrives as `message`, as
    // `error.message` and again as a bare `detail`. This text is shown to a
    // human, so the repeat is dropped rather than printed three times.
    if (text === '' || seen.has(text.toLowerCase())) return
    seen.add(text.toLowerCase())
    parts.push(text)
  }
  push(failure?.message)
  push(failure?.body?.error?.message)
  push(failure?.body?.error?.detail)
  push(failure?.body?.error?.code)
  push(failure?.body?.error?.type)
  push(failure?.body?.message)
  push(failure?.body?.detail)
  // A body that never parsed still carries prose worth reading.
  if (typeof failure?.body === 'string') push(failure.body)
  return parts.join(' \n ')
}

/**
 * The upstream's own error code, wherever it put it.
 * @param {object|undefined} failure - the failure observed.
 * @returns {string} the code, or an empty string.
 */
export function failureCode(failure) {
  const candidates = [
    failure?.body?.error?.code,
    failure?.body?.error?.type,
    failure?.body?.code,
    failure?.code,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return ''
}

/**
 * Classify one failed attempt.
 *
 * The order of the checks is the whole design. Prose beats status codes because
 * gateways routinely wrap a dead credential in a `400 invalid_request_error`, and
 * a code that says "no balance" must not be short-circuited by an outer
 * status that says "bad request". Only after the phrases and codes are exhausted
 * does the status code get to decide.
 *
 * @param {object|undefined} failure - `{code, status, message, body, retryAfterMs}` as produced by the HTTP layer.
 * @returns {{cls: string, reason: string, status: number|null, text: string, code: string}} the verdict.
 */
export function classifyFailure(failure) {
  const status = typeof failure?.status === 'number' && failure.status > 0 ? failure.status : null
  const transport = typeof failure?.code === 'string' ? failure.code : ''
  const text = failureText(failure)
  const code = failureCode(failure)

  const verdict = (cls, reason) => ({ cls, reason, status, text, code })

  // The caller hung up. Neither the route nor the credential is at fault, and
  // the request will never be read by anyone, so nothing should be recorded.
  if (transport === 'ABORTED' || status === 499) return verdict('client_cancel', 'the caller aborted the request')

  // Money and credentials are checked before anything else, because these are
  // the failures a gateway is most likely to dress up as something generic.
  if (has(QUOTA_CODES, code) || mentions(text, QUOTA_PHRASES)) return verdict('quota', 'the credential is out of quota or balance')
  if (has(AUTH_CODES, code) || mentions(text, AUTH_PHRASES)) return verdict('non_retryable', 'the credential was rejected')
  if (has(PERMISSION_CODES, code) || mentions(text, PERMISSION_PHRASES)) return verdict('non_retryable', 'the credential lacks permission for this route')

  if (transport === 'TIMEOUT') return verdict('retryable', 'the upstream did not answer in time')
  if (transport === 'TRANSPORT' || transport === 'MALFORMED') return verdict('retryable', 'the upstream connection failed')

  if (status !== null) {
    if (OVERLOADED_STATUSES.includes(status)) {
      return verdict('overloaded', status === 429 ? 'the upstream is rate limiting' : 'the upstream is temporarily unavailable')
    }
    if (REQUEST_FAULT_STATUSES.includes(status)) return verdict('non_retryable', `the request was rejected upstream (${status})`)
    if (status >= 500) return verdict('retryable', `the upstream answered ${status}`)
    if (status >= 400) return verdict('non_retryable', `the upstream answered ${status}`)
  }

  // A 2xx that could not be turned into a completion, and anything unclassified:
  // treat as transient, because retrying once is cheaper than being wrong about
  // a route that is actually fine.
  return verdict('retryable', 'the attempt did not produce a usable response')
}

/**
 * Whether a class counts against a breaker.
 * @param {string} cls - a class from {@link classifyFailure}.
 * @returns {boolean} whether the failure should be recorded.
 */
export function isBreakerRelevant(cls) {
  return BREAKER_RELEVANT.includes(cls)
}

/**
 * Whether a class alone is enough to open a breaker.
 * @param {string} cls - a class from {@link classifyFailure}.
 * @returns {boolean} whether one occurrence opens the breaker.
 */
export function opensImmediately(cls) {
  return OPENS_IMMEDIATELY.includes(cls)
}

/** Turn a `retry-after` hint into an absolute time, when it is one. */
function recoverAtFrom(failure, now) {
  const hint = failure?.retryAfterMs
  if (typeof hint !== 'number' || !Number.isFinite(hint) || hint <= 0) return null
  return new Date(now + hint).toISOString()
}

/**
 * Decide whether a failure kills the credential.
 *
 * A blacklisted key is skipped entirely until it is restored, so this is the
 * only judgement in the service that can take a route out of rotation without a
 * cooldown — which is why it is restricted to failures that are an *answer*
 * rather than a symptom, and why it carries its reason and its evidence.
 *
 * @param {object|undefined} failure - the failure observed.
 * @param {{now?: number}} [options] - injectable clock (ms since epoch).
 * @returns {{should: boolean, reason: string|null, message: string, recoverAt: string|null}} the verdict.
 */
export function blacklistVerdict(failure, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const status = typeof failure?.status === 'number' ? failure.status : null
  const text = failureText(failure)
  const code = failureCode(failure)
  const message = text.trim() === '' ? `upstream status ${String(status ?? 'unknown')}` : text.trim().slice(0, 400)

  /**
   * `selfHealing` is true only for a bill that can be paid.
   *
   * A quota error often arrives with the upstream's own reset time, and honouring
   * it is exactly right. An auth or permission error is a different kind of
   * answer — a revoked key does not start working again because the response
   * carried a `retry-after` for some unrelated rate limit, and treating it as if
   * it did meant a single stray header could cancel a blacklist the operator was
   * supposed to act on.
   */
  const dead = (reason, selfHealing = false) => ({
    should: true,
    reason,
    message,
    recoverAt: selfHealing ? recoverAtFrom(failure, now) : null,
  })

  if (status === 402) return dead('insufficient_balance', true)
  if (has(QUOTA_CODES, code) || mentions(text, QUOTA_PHRASES)) return dead('insufficient_balance', true)
  if (has(AUTH_CODES, code) || mentions(text, AUTH_PHRASES)) return dead('authentication_error')
  if (has(PERMISSION_CODES, code) || mentions(text, PERMISSION_PHRASES)) return dead('permission_error')

  // A bare 401 is unambiguous; a bare 403 is *usually* permission, and the two
  // are worth separating on the page because the fix differs (rotate the key,
  // versus ask for access). Without prose, 403 is reported as the safer of the
  // two guesses — nothing is broken, something is missing.
  if (status === 401) return dead('authentication_error')
  if (status === 403) return dead('permission_error')
  if (DEAD_CREDENTIAL_STATUSES.includes(status)) return dead('authentication_error')

  return { should: false, reason: null, message, recoverAt: null }
}

/**
 * A one-line description of a failure, for logs and the event ring.
 * @param {object|undefined} failure - the failure observed.
 * @returns {string} something short and unambiguous.
 */
export function describeFailure(failure) {
  const status = typeof failure?.status === 'number' && failure.status > 0 ? `/${failure.status}` : ''
  const code = typeof failure?.code === 'string' && failure.code !== '' ? failure.code : 'UNKNOWN'
  const retryAfter = typeof failure?.retryAfterMs === 'number' ? ` retry-after=${failure.retryAfterMs}ms` : ''
  return `${code}${status}${retryAfter}`
}

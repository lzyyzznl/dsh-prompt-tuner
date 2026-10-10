/**
 * Circuit-breaker state machine for the routing service.
 *
 * Imports nothing, from the Harness or from Node: the decision logic is driven
 * by an injected clock, so the self-test exercises every transition
 * deterministically.
 *
 * ## The breaker is keyed by a *unit*, not by a provider
 *
 * A unit is one credential on one route: `provider` when the route carries no
 * configured key, and `provider#key` when it does ({@link unitKey}). That one
 * choice is what makes failover granular: a key that trips is skipped while its
 * siblings on the same provider keep serving, and the provider as a whole only
 * leaves rotation once every one of its units is unusable. The selection walk
 * lives in `lib/service/proxy.js`; this module owns only "what state is this unit
 * in" and "may it serve a request now".
 *
 * ## Only some failures count
 *
 * The caller classifies a failure before recording it (`lib/service/failure.js`)
 * and only `retryable`/`overloaded` reach {@link createRouter}'s `recordFailure`.
 * That split is deliberate and load-bearing: a request the contract rejects, a
 * model that does not exist and a caller who hung up are all *the caller's*
 * faults, and counting them would let the router trip a breaker on its own
 * noise. A revoked credential never reaches here either — it becomes a blacklist
 * entry instead, because a cooldown is the wrong shape for an answer.
 *
 * ## Two ways to be sure, and a floor under both
 *
 * A unit opens when either signal is unambiguous:
 *
 *   - **consecutive** transient failures reach `failureThreshold` — the signal
 *     that works when a route is used a handful of times a day, which is the
 *     normal case for one machine and one operator;
 *   - the **failure rate** over the sliding window reaches `failureRateThreshold`
 *     — the signal that catches a route failing half the time, which consecutive
 *     counting forgives every time it succeeds;
 *
 * and the rate path additionally requires `minSamples` recorded outcomes before
 * it may fire, so a single failure out of one request is never a ratio. An
 * `overloaded` failure skips both: a 429 is the upstream telling us to back off,
 * and waiting for confirmation only spends another request to learn what we were
 * already told.
 *
 * ## Repeated trips escalate
 *
 * A unit that keeps failing is not retried at the same rhythm forever: each
 * consecutive trip multiplies the cooldown by `cooldownFactor` up to
 * `cooldownMaxMs`, and closing the breaker resets the count to zero. The cooldown
 * never drops below the configured base, so a cap below the base is clamped up
 * rather than silently shortening the first trip. When the upstream names its own
 * delay (`retry-after`), that hint is honoured for the trip in place of the
 * computed cooldown, bounded by the same cap.
 *
 * ## Half-open is a lease, not a second chance
 *
 * Past its cooldown a unit becomes `half-open` and admits exactly one probe;
 * `halfOpenSuccesses` consecutive successes are needed to close it, and a failed
 * probe re-opens it at the next escalated cooldown. A probe that never settles
 * must not wedge the unit forever, so the lease expires after one cooldown.
 *
 * @module dsh-prompt-tuner/service/router
 */

/** A unit whose requests are passing normally. */
export const CLOSED = 'closed'
/** A unit that tripped the breaker and is skipped until its cooldown ends. */
export const OPEN = 'open'
/** A unit past its cooldown that may serve one probe request at a time. */
export const HALF_OPEN = 'half-open'

/** How a unit leaves the open state: a probe first, or straight back in. */
export const ROUTER_RECOVERY_MODES = Object.freeze(['probe', 'immediate'])

/** Verbosity of the routing half's own log line. */
export const ROUTER_LOG_LEVELS = Object.freeze(['silent', 'error', 'warn', 'info', 'debug'])

/** How many times one route is retried before the request fails over. */
export const DEFAULT_ROUTER_RETRIES = 3
/** Consecutive transient failures needed to open a breaker. */
export const DEFAULT_ROUTER_THRESHOLD = 2
/** Failure rate over the window needed to open a breaker (0–1). */
export const DEFAULT_ROUTER_FAILURE_RATE = 0.7
/** Outcomes required before the failure rate is allowed to decide anything. */
export const DEFAULT_ROUTER_MIN_SAMPLES = 5
/** How far back failures are counted (ms). */
export const DEFAULT_ROUTER_WINDOW_MS = 300_000
/** How many recent outcomes the window keeps, whatever their age. */
export const DEFAULT_ROUTER_WINDOW_SIZE = 20
/** How long the *first* open breaker stays open before recovery may be attempted (ms). */
export const DEFAULT_ROUTER_COOLDOWN_MS = 30_000
/** Multiplier applied to the cooldown for each consecutive trip. */
export const DEFAULT_ROUTER_COOLDOWN_FACTOR = 2
/** Ceiling for the escalated cooldown (ms): ten minutes. */
export const DEFAULT_ROUTER_COOLDOWN_MAX_MS = 600_000
/** Consecutive successful probes needed to close a half-open breaker. */
export const DEFAULT_ROUTER_HALF_OPEN_SUCCESSES = 1
/** Switches per step; `0` means "auto" — as many candidates as there are units. */
export const DEFAULT_ROUTER_MAX_SWITCHES = 0
/** Default verbosity. */
export const DEFAULT_ROUTER_LOG_LEVEL = 'info'

/** First wait between two attempts on the same route (ms); doubles per retry. */
export const ROUTER_RETRY_BASE_MS = 500
/**
 * Longest a single retry may wait (ms).
 *
 * The ceiling exists because a provider's `retry-after` can name minutes: an
 * agent step that sits out a five-minute backoff is worse than moving to the
 * next candidate, so a longer hint means "do not retry this route" instead
 * ({@link retryWaitMs} answers `null`).
 */
export const ROUTER_RETRY_MAX_WAIT_MS = 5_000

/**
 * Bounds for the settings the admin page edits. The service refuses a save
 * outside these, and {@link normalizeRouterConfig} clamps a hand-edited file into
 * them, so the page and the file can never disagree about what is in force.
 */
export const ROUTER_LIMITS = Object.freeze({
  /** Rows in the order table. One row per fallback candidate. */
  orderRows: 12,
  /** Retries on the same route before failing over. */
  maxRetries: 20,
  /** Consecutive transient failures before a breaker opens. */
  failureThreshold: 100,
  /** Failure rate (0–1) over the window before a breaker opens. */
  minFailureRate: 0,
  maxFailureRate: 1,
  /** Outcomes required before the rate may fire, inclusive bounds. */
  minSamples: 1,
  maxSamples: 100,
  /** How many recent outcomes the rate window keeps. */
  minWindowSize: 1,
  maxWindowSize: 100,
  /** Failure-counting window, inclusive bounds (ms). */
  minWindowMs: 0,
  maxWindowMs: 3_600_000,
  /** Cooldown before recovery, inclusive bounds (ms). */
  minCooldownMs: 0,
  maxCooldownMs: 3_600_000,
  /** Per-trip cooldown multiplier, inclusive bounds. */
  minCooldownFactor: 1,
  maxCooldownFactor: 10,
  /** Consecutive probe successes needed to close a half-open breaker. */
  minHalfOpenSuccesses: 1,
  maxHalfOpenSuccesses: 10,
  /** Switches per step; `0` is "auto" (see the setting's own description). */
  minSwitches: 0,
  maxSwitches: 20,
})

/** Longest accepted provider/model/label string. */
const MAX_ROUTE_PART = 200

/** One non-empty, bounded string, or null. */
function shortString(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > MAX_ROUTE_PART) return null
  return trimmed
}

/** One integer inside inclusive bounds, or the fallback. */
function intIn(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/** One number inside inclusive bounds, or the fallback. */
function floatIn(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * The breaker key for one credential on one route.
 *
 * A provider id can only hold `[A-Za-z0-9._-]` and a key id is held to the same
 * alphabet, so `#` cannot appear inside either half and the join is unambiguous.
 * A route with no configured key has one unit, spelled exactly as the provider
 * id — which is why a single-key configuration behaves precisely as it did
 * before keys existed.
 *
 * @param {string} provider - the provider id.
 * @param {string|null} [keyId] - the key's stable id, or null for "no key".
 * @returns {string} the unit key.
 */
export function unitKey(provider, keyId) {
  const name = typeof provider === 'string' ? provider : ''
  const key = typeof keyId === 'string' && keyId !== '' ? keyId : null
  return key === null ? name : `${name}#${key}`
}

/**
 * Split a unit key back into its parts, for display.
 * @param {string} unit - a key from {@link unitKey}.
 * @returns {{provider: string, keyId: string|null}} the parts.
 */
export function splitUnitKey(unit) {
  const text = typeof unit === 'string' ? unit : ''
  const hash = text.indexOf('#')
  if (hash <= 0 || hash === text.length - 1) return { provider: text, keyId: null }
  return { provider: text.slice(0, hash), keyId: text.slice(hash + 1) }
}

/**
 * Repair one order table.
 *
 * Unusable rows are dropped rather than rejected, and the table is capped so a
 * hand-written file cannot make the admin page enumerate forever. A row is
 * usable when it names both a provider and a model; `label` and
 * `reasoningEffort` are optional decorations.
 * @param {unknown} value - the stored `router.order`.
 * @returns {Array<{provider: string, model: string, label?: string, reasoningEffort?: string}>} the rows that survived.
 */
export function normalizeOrder(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    if (out.length >= ROUTER_LIMITS.orderRows) break
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const provider = shortString(entry.provider)
    const model = shortString(entry.model)
    if (provider === null || model === null) continue
    const label = shortString(entry.label)
    const reasoningEffort = shortString(entry.reasoningEffort)
    out.push({
      provider,
      model,
      ...(label === null ? {} : { label }),
      ...(reasoningEffort === null ? {} : { reasoningEffort }),
    })
  }
  return out
}

/**
 * Normalize and validate the stored routing settings, applying documented
 * defaults. Never throws: every unusable field falls back, which is what lets
 * `readConfig` treat a hand-edited file as a recoverable condition.
 * @param {unknown} raw - the stored `router` object, or `undefined`.
 * @returns {object} a fully-defaulted config.
 */
export function normalizeRouterConfig(raw) {
  const input = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}
  const cooldownMs = intIn(input.cooldownMs, ROUTER_LIMITS.minCooldownMs, ROUTER_LIMITS.maxCooldownMs, DEFAULT_ROUTER_COOLDOWN_MS)
  return {
    order: normalizeOrder(input.order),
    retries: intIn(input.retries, 0, ROUTER_LIMITS.maxRetries, DEFAULT_ROUTER_RETRIES),
    failureThreshold: intIn(input.failureThreshold, 1, ROUTER_LIMITS.failureThreshold, DEFAULT_ROUTER_THRESHOLD),
    failureRateThreshold: floatIn(input.failureRateThreshold, ROUTER_LIMITS.minFailureRate, ROUTER_LIMITS.maxFailureRate, DEFAULT_ROUTER_FAILURE_RATE),
    minSamples: intIn(input.minSamples, ROUTER_LIMITS.minSamples, ROUTER_LIMITS.maxSamples, DEFAULT_ROUTER_MIN_SAMPLES),
    windowSize: intIn(input.windowSize, ROUTER_LIMITS.minWindowSize, ROUTER_LIMITS.maxWindowSize, DEFAULT_ROUTER_WINDOW_SIZE),
    windowMs: intIn(input.windowMs, ROUTER_LIMITS.minWindowMs, ROUTER_LIMITS.maxWindowMs, DEFAULT_ROUTER_WINDOW_MS),
    cooldownMs,
    cooldownFactor: intIn(input.cooldownFactor, ROUTER_LIMITS.minCooldownFactor, ROUTER_LIMITS.maxCooldownFactor, DEFAULT_ROUTER_COOLDOWN_FACTOR),
    // A cap below the base would make the *first* trip shorter than configured,
    // so reads repair it upward instead of letting the two fields contradict.
    cooldownMaxMs: Math.max(cooldownMs, intIn(input.cooldownMaxMs, ROUTER_LIMITS.minCooldownMs, ROUTER_LIMITS.maxCooldownMs, DEFAULT_ROUTER_COOLDOWN_MAX_MS)),
    halfOpenSuccesses: intIn(input.halfOpenSuccesses, ROUTER_LIMITS.minHalfOpenSuccesses, ROUTER_LIMITS.maxHalfOpenSuccesses, DEFAULT_ROUTER_HALF_OPEN_SUCCESSES),
    recoveryMode: ROUTER_RECOVERY_MODES.includes(input.recoveryMode) ? input.recoveryMode : 'probe',
    maxSwitches: intIn(input.maxSwitches, ROUTER_LIMITS.minSwitches, ROUTER_LIMITS.maxSwitches, DEFAULT_ROUTER_MAX_SWITCHES),
    logLevel: ROUTER_LOG_LEVELS.includes(input.logLevel) ? input.logLevel : DEFAULT_ROUTER_LOG_LEVEL,
  }
}

/**
 * How many switches one request may make.
 *
 * `0` in the settings means "auto", and auto is the number of *candidate units* —
 * every row crossed with every key it can reach, which is exactly enough to visit
 * each candidate once and then stop, so a fully degraded pool cannot loop
 * forever. Callers that predate keys may pass nothing, and then the row count is
 * the right answer because each row is one unit.
 *
 * @param {{order: Array<unknown>, maxSwitches: number}} cfg - normalized config.
 * @param {number} [candidateCount] - the number of units the caller will actually try.
 * @returns {number} the per-request switch budget.
 */
export function switchBudget(cfg, candidateCount) {
  if (cfg.maxSwitches > 0) return cfg.maxSwitches
  const candidates = Number.isFinite(candidateCount) ? Math.trunc(candidateCount) : null
  if (candidates !== null && candidates >= 0) return candidates
  return cfg.order.length
}

/**
 * How long to wait before re-trying the same route, or `null` to fail over now.
 *
 * A provider that says *when* to come back is believed, within
 * {@link ROUTER_RETRY_MAX_WAIT_MS}: past that ceiling a retry would stall the
 * agent step for longer than moving to the next candidate costs, so the caller
 * is told not to retry at all. Without a hint the wait doubles from
 * {@link ROUTER_RETRY_BASE_MS}, which keeps a burst of immediate re-attempts
 * from hammering an adapter that is already struggling.
 * The hint is read from `retryAfterMs`, which is what the HTTP layer actually
 * records, and from `providerRetryAfterMs` for callers that spell it that way.
 * Reading only the latter was a live bug: nothing in the service ever set it, so
 * in production the upstream's own delay was silently replaced by the
 * exponential default while the unit tests — which hand-built the field — passed.
 *
 * @param {{retryAfterMs?: number, providerRetryAfterMs?: number}|undefined} failure - the failure observed.
 * @param {number} attempt - 1 for the first retry, 2 for the second, and so on.
 * @returns {number|null} milliseconds to wait, or `null` for "switch instead".
 */
export function retryWaitMs(failure, attempt) {
  const hinted = failure?.retryAfterMs ?? failure?.providerRetryAfterMs
  if (typeof hinted === 'number' && Number.isFinite(hinted) && hinted > 0) {
    return hinted > ROUTER_RETRY_MAX_WAIT_MS ? null : hinted
  }
  const step = Number.isFinite(attempt) && attempt > 1 ? Math.trunc(attempt) - 1 : 0
  return Math.min(ROUTER_RETRY_MAX_WAIT_MS, ROUTER_RETRY_BASE_MS * 2 ** Math.min(step, 16))
}

/**
 * Create the breaker registry.
 *
 * The config object is read at every use rather than copied, so the runtime can
 * apply an edited setting in place without throwing away the breakers that are
 * currently open — changing a cooldown should not silently forgive a route that
 * is still rate limited.
 *
 * @param {object} cfg - normalized config, mutated in place by the caller when settings change.
 * @param {() => number} [now] - injectable clock (ms since epoch), for deterministic tests.
 * @returns {object} the router.
 */
export function createRouter(cfg, now = () => Date.now()) {
  /** One record per unit key. */
  const records = new Map()

  function recordOf(unit) {
    let record = records.get(unit)
    if (record === undefined) {
      record = {
        outcomes: [],
        consecutive: 0,
        trips: 0,
        openUntil: null,
        halfOpen: false,
        halfOpenSuccesses: 0,
        probeStartedAt: null,
        lastFailure: null,
        lastClass: null,
      }
      records.set(unit, record)
    }
    return record
  }

  /** Drop outcomes older than the window, then trim to the configured size. */
  function pruneOutcomes(record, t) {
    const cutoff = t - cfg.windowMs
    while (record.outcomes.length > 0 && record.outcomes[0].at < cutoff) record.outcomes.shift()
    const size = Number.isFinite(cfg.windowSize) && cfg.windowSize > 0 ? cfg.windowSize : DEFAULT_ROUTER_WINDOW_SIZE
    while (record.outcomes.length > size) record.outcomes.shift()
  }

  /**
   * The cooldown the next trip pays, given how many trips came before it.
   * @param {number} trips - 1 for the first trip, 2 for the second, and so on.
   * @returns {number} milliseconds, never below the configured base and never above the cap.
   */
  function cooldownFor(trips) {
    const exponent = Math.max(0, Math.min(16, trips - 1))
    return Math.max(cfg.cooldownMs, Math.min(cfg.cooldownMaxMs, cfg.cooldownMs * cfg.cooldownFactor ** exponent))
  }

  /**
   * Open `record` for its next escalated cooldown, counting the trip.
   *
   * `hintMs` is the upstream's own `retry-after`, when it gave one: it replaces
   * the computed cooldown for this trip but is still bounded by the same cap, so
   * a gateway claiming a one-day reset cannot freeze a route for a day.
   */
  function open(record, t, hintMs) {
    record.trips += 1
    record.halfOpen = false
    record.halfOpenSuccesses = 0
    record.probeStartedAt = null
    const hinted = typeof hintMs === 'number' && Number.isFinite(hintMs) && hintMs > 0
      ? Math.min(Math.max(hintMs, cfg.cooldownMs), cfg.cooldownMaxMs)
      : null
    record.openUntil = t + (hinted ?? cooldownFor(record.trips))
  }

  /**
   * Derive the live state, applying cooldown expiry as a side effect.
   * @param {string} unit - the breaker key.
   * @param {number} t - current time.
   * @returns {string} one of {@link CLOSED}, {@link OPEN}, {@link HALF_OPEN}.
   */
  function stateOf(unit, t) {
    const record = records.get(unit)
    if (record === undefined) return CLOSED
    if (record.openUntil === null) return record.halfOpen ? HALF_OPEN : CLOSED
    if (t < record.openUntil) return OPEN
    // Cooldown elapsed: recover immediately, or open a single-probe window.
    record.openUntil = null
    record.probeStartedAt = null
    if (cfg.recoveryMode === 'immediate') {
      record.halfOpen = false
      record.halfOpenSuccesses = 0
      record.outcomes = []
      record.consecutive = 0
      return CLOSED
    }
    record.halfOpen = true
    return HALF_OPEN
  }

  /**
   * Whether a unit may serve a request now; half-open admits one probe.
   * @param {string} unit - the breaker key.
   * @param {number} t - current time.
   * @returns {boolean} whether the unit is selectable.
   */
  function available(unit, t) {
    const state = stateOf(unit, t)
    if (state === CLOSED) return true
    if (state !== HALF_OPEN) return false
    const record = recordOf(unit)
    // A probe that never settled must not wedge the unit forever.
    if (record.probeStartedAt !== null && t - record.probeStartedAt > cfg.cooldownMs) {
      record.probeStartedAt = null
    }
    return record.probeStartedAt === null
  }

  /**
   * Mark a unit as selected, consuming the single half-open probe slot.
   * @param {string} unit - the breaker key.
   * @param {number} t - current time.
   */
  function noteSelected(unit, t) {
    if (stateOf(unit, t) !== HALF_OPEN) return
    recordOf(unit).probeStartedAt = t
  }

  /** The failure rate over the current window, or 0 with no samples. */
  function failureRate(record) {
    if (record.outcomes.length === 0) return 0
    const failed = record.outcomes.filter((entry) => entry.ok !== true).length
    return failed / record.outcomes.length
  }

  /**
   * Whether the two signals say "open".
   *
   * The consecutive path needs no minimum sample because it takes `threshold`
   * failures in a row to fire at all; the rate path needs one because a single
   * failure out of one request is a ratio of 1.0 and means nothing.
   */
  function shouldOpen(record) {
    if (record.consecutive >= cfg.failureThreshold) return { open: true, why: 'threshold' }
    if (record.outcomes.length >= cfg.minSamples && failureRate(record) >= cfg.failureRateThreshold) {
      return { open: true, why: 'failure_rate' }
    }
    return { open: false, why: null }
  }

  /**
   * Record one breaker failure and transition the unit's state.
   *
   * The caller records a failure only once a route's retries are spent and only
   * when the failure class is the route's fault, so `failureThreshold` counts
   * failed retry cycles rather than individual attempts.
   *
   * @param {string} unit - the breaker key.
   * @param {{code?: string, status?: number, message?: string, retryAfterMs?: number}} failure - the failure observed.
   * @param {number} t - current time.
   * @param {{immediate?: boolean}} [options] - `immediate` opens on this failure alone (an overload signal).
   * @returns {string} the unit's state after the transition.
   */
  function recordFailure(unit, failure, t, options = {}) {
    const record = recordOf(unit)
    record.lastFailure = {
      code: typeof failure?.code === 'string' ? failure.code : null,
      status: typeof failure?.status === 'number' ? failure.status : null,
      message: typeof failure?.message === 'string' ? failure.message.slice(0, 400) : null,
      at: t,
    }
    record.lastClass = typeof failure?.cls === 'string' ? failure.cls : record.lastClass
    const hint = failure?.retryAfterMs
    if (stateOf(unit, t) === HALF_OPEN) {
      // A failed probe re-opens the breaker for a fresh, escalated cooldown.
      record.outcomes = []
      record.consecutive = 0
      open(record, t, hint)
      return OPEN
    }
    // "Consecutive" means *within the window*: a failure that follows the
    // previous one by longer than the window is a fresh incident, not the second
    // half of a pattern. Without this, one failure today plus one next week would
    // reach the threshold and open a breaker on a route that is merely unused.
    const previous = record.outcomes[record.outcomes.length - 1]
    if (previous !== undefined && t - previous.at > cfg.windowMs) record.consecutive = 0
    record.outcomes.push({ at: t, ok: false })
    record.consecutive += 1
    pruneOutcomes(record, t)
    if (options.immediate === true) {
      open(record, t, hint)
      return OPEN
    }
    if (shouldOpen(record).open) {
      open(record, t, hint)
      return OPEN
    }
    return CLOSED
  }

  /**
   * Record a successful call, closing the breaker and clearing its counters.
   *
   * A success also counts toward the half-open target: one probe is enough to
   * *try* a route again but `halfOpenSuccesses` in a row are needed to trust it,
   * which is what keeps a route that alternates good and bad from snapping open
   * and shut on every request.
   *
   * @param {string} unit - the breaker key.
   * @param {number} [t] - current time, needed only when the unit is half-open.
   * @returns {string} the unit's state after the transition.
   */
  function recordSuccess(unit, t) {
    // The record is created on success as well as on failure: the rate path needs
    // the successes, and a route whose history only ever began at its first
    // failure would report a rate of 1.0 for a single bad request.
    const record = recordOf(unit)
    record.outcomes.push({ at: Number.isFinite(t) ? t : now(), ok: true })
    pruneOutcomes(record, Number.isFinite(t) ? t : now())
    record.consecutive = 0
    record.lastClass = null
    if (record.halfOpen) {
      record.halfOpenSuccesses += 1
      // The probe has settled, so its lease is released immediately: the next
      // confirmation — which `halfOpenSuccesses > 1` requires — may start now
      // rather than waiting out another whole cooldown. Leaving the lease held
      // turned "two confirmations" into "two confirmations 30 seconds apart".
      record.probeStartedAt = null
      if (record.halfOpenSuccesses < cfg.halfOpenSuccesses) return HALF_OPEN
    }
    record.trips = 0
    record.openUntil = null
    record.halfOpen = false
    record.halfOpenSuccesses = 0
    record.probeStartedAt = null
    return CLOSED
  }

  /**
   * Give back a half-open probe slot without recording an outcome.
   *
   * A probe that produced no verdict — a failure class the breaker ignores, a
   * request the converter rejected, a caller that hung up before the upstream
   * answered — tells the breaker nothing. Holding its lease would then block a
   * perfectly healthy route for a whole cooldown, a stall the breaker caused
   * rather than one it prevented.
   *
   * @param {string} unit - the breaker key.
   * @param {number} [t] - current time.
   * @returns {boolean} whether a lease was actually released.
   */
  function releaseProbe(unit, t) {
    const record = records.get(unit)
    if (record === undefined) return false
    if (stateOf(unit, Number.isFinite(t) ? t : now()) !== HALF_OPEN) return false
    if (record.probeStartedAt === null) return false
    record.probeStartedAt = null
    return true
  }

  /**
   * Forget one unit's breaker state.
   * @param {string} unit - the breaker key.
   */
  function forget(unit) {
    records.delete(unit)
  }

  /** Forget every breaker, as if the host had just started. */
  function reset() {
    records.clear()
  }

  /**
   * Describe one unit's live state, for diagnostics.
   * @param {string} unit - the breaker key.
   * @param {number} t - current time.
   * @returns {object} the state, its counters, and what the next trip would cost.
   */
  function describe(unit, t) {
    const state = stateOf(unit, t)
    const record = records.get(unit) ?? null
    const trips = record === null ? 0 : record.trips
    return {
      state,
      consecutive: record === null ? 0 : record.consecutive,
      failures: record === null ? 0 : record.outcomes.filter((entry) => entry.ok !== true).length,
      samples: record === null ? 0 : record.outcomes.length,
      failureRate: record === null ? 0 : failureRate(record),
      threshold: cfg.failureThreshold,
      failureRateThreshold: cfg.failureRateThreshold,
      minSamples: cfg.minSamples,
      halfOpenSuccesses: record === null ? 0 : record.halfOpenSuccesses,
      halfOpenTarget: cfg.halfOpenSuccesses,
      trips,
      // What the *next* trip would cost, so the admin page can show the
      // escalation without re-deriving it from the factor.
      nextCooldownMs: cooldownFor(trips + 1),
      openUntil: record === null ? null : record.openUntil,
      probeStartedAt: record === null ? null : record.probeStartedAt,
      lastFailure: record === null ? null : record.lastFailure,
      lastClass: record === null ? null : record.lastClass,
    }
  }

  /**
   * Describe every configured route and its units, for diagnostics.
   *
   * `unitsOf` answers "which credentials can this provider serve with"; the
   * default is the one credential-less unit, which is what a single-key or
   * key-less configuration has always been.
   *
   * @param {(providerId: string) => Array<{id: string|null, label?: string}>} [unitsOf] - the credential dimension.
   * @returns {Array<object>} one row per order entry per unit.
   */
  function snapshot(unitsOf = () => [{ id: null }]) {
    const t = now()
    const out = []
    for (const entry of cfg.order) {
      let units
      try {
        units = unitsOf(entry.provider) ?? [{ id: null }]
      } catch {
        units = [{ id: null }]
      }
      if (!Array.isArray(units) || units.length === 0) units = [{ id: null }]
      for (const unit of units) {
        out.push({
          provider: entry.provider,
          model: entry.model,
          ...(entry.label === undefined ? {} : { label: entry.label }),
          keyId: typeof unit?.id === 'string' && unit.id !== '' ? unit.id : null,
          keyLabel: typeof unit?.label === 'string' ? unit.label : '',
          unit: unitKey(entry.provider, unit?.id ?? null),
          ...describe(unitKey(entry.provider, unit?.id ?? null), t),
        })
      }
    }
    return out
  }

  /** Every unit currently known to the breaker, for the admin page's key rows. */
  function units() {
    return [...records.keys()]
  }

  return {
    stateOf,
    available,
    noteSelected,
    releaseProbe,
    recordFailure,
    recordSuccess,
    describe,
    snapshot,
    units,
    forget,
    reset,
  }
}

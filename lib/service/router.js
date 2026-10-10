/**
 * Circuit-breaker state machine and provider-selection logic for the routing
 * half of the plugin suite.
 *
 * Imports nothing, from the Harness or from Node: the decision logic is driven
 * by an injected clock, so the self-test exercises every transition
 * deterministically. `lib/routing.js` owns the event wiring; this module owns
 * only "what state is this provider in" and "which provider comes next".
 *
 * The config here is *settings*-shaped rather than loader-row-shaped, and the
 * difference is deliberate:
 *
 *   - reads repair, writes reject (`readSettings` in `lib/store.js` calls
 *     {@link normalizeRouterConfig}, while `/save` rejects every field it cannot
 *     accept outright). A settings file is a document a human edits, so one bad
 *     field must never be able to break plugin activation; a save made from the
 *     settings page is a decision, so silently rewriting it would leave the
 *     input and the file disagreeing about what was stored.
 *   - an empty order is a legitimate configuration, not an error: it means the
 *     routing half is installed but has nothing to fail over *to*. Switching on
 *     an empty order is impossible by construction, so "enabled with no rows" is
 *     inert rather than surprising.
 *
 * ## Every failure counts, after N retries
 *
 * This module deliberately has no notion of "which failures are worth acting
 * on": the caller retries the same route up to `retries` times ({@link
 * retryWaitMs} spaces those attempts) and then asks for the next candidate,
 * whatever the failure was. A code/status allow-list used to decide that, and it
 * meant a provider answering `SERVER` or `TIMEOUT` was never routed around at
 * all. The distinction that *is* kept is structural rather than per-vendor: an
 * aborted attempt is not a provider failure, and `lib/routing.js` drops it
 * before reaching here.
 *
 * ## Repeated trips escalate
 *
 * A provider that keeps failing is not retried at the same rhythm forever: each
 * consecutive trip multiplies the cooldown by `cooldownFactor` up to
 * `cooldownMaxMs`, and one success resets the count to zero. The cooldown never
 * drops below the configured base, so a cap below the base is clamped up rather
 * than silently shortening the first trip.
 *
 * @module dsh-prompt-optimizer/router
 */

/** A provider whose requests are passing normally. */
export const CLOSED = 'closed'
/** A provider that tripped the breaker and is skipped until its cooldown ends. */
export const OPEN = 'open'
/** A provider past its cooldown that may serve one probe request at a time. */
export const HALF_OPEN = 'half-open'

/** How a provider leaves the open state: a probe first, or straight back in. */
export const ROUTER_RECOVERY_MODES = Object.freeze(['probe', 'immediate'])

/** Verbosity of the routing half's own log line. */
export const ROUTER_LOG_LEVELS = Object.freeze(['silent', 'error', 'warn', 'info', 'debug'])

/** How many times one route is retried before the request fails over. */
export const DEFAULT_ROUTER_RETRIES = 3
/** Failures within the window needed to open a breaker. */
export const DEFAULT_ROUTER_THRESHOLD = 1
/** How far back failures are counted (ms). */
export const DEFAULT_ROUTER_WINDOW_MS = 60_000
/** How long the *first* open breaker stays open before recovery may be attempted (ms). */
export const DEFAULT_ROUTER_COOLDOWN_MS = 60_000
/** Multiplier applied to the cooldown for each consecutive trip. */
export const DEFAULT_ROUTER_COOLDOWN_FACTOR = 2
/** Ceiling for the escalated cooldown (ms): 30 minutes. */
export const DEFAULT_ROUTER_COOLDOWN_MAX_MS = 1_800_000
/** Switches per step; `0` means "auto" — as many as there are order rows. */
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
 * Bounds for the settings-page fields. The host refuses a `/save` outside these,
 * and {@link normalizeRouterConfig} clamps a hand-edited file into them, so the
 * page and the file can never disagree about what is in force.
 */
export const ROUTER_LIMITS = Object.freeze({
  /** Rows in the order table. One row per fallback candidate. */
  orderRows: 12,
  /** Retries on the same route before failing over. */
  maxRetries: 20,
  /** Failures per window before a breaker opens. */
  failureThreshold: 100,
  /** Failure-counting window, inclusive bounds (ms). */
  minWindowMs: 0,
  maxWindowMs: 3_600_000,
  /** Cooldown before recovery, inclusive bounds (ms). */
  minCooldownMs: 0,
  maxCooldownMs: 3_600_000,
  /** Per-trip cooldown multiplier, inclusive bounds. */
  minCooldownFactor: 1,
  maxCooldownFactor: 10,
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

/**
 * Repair one order table.
 *
 * Unusable rows are dropped rather than rejected, and the table is capped so a
 * hand-written file cannot make the settings page enumerate forever. A row is
 * usable when it names both a provider and a model; `label` and
 * `reasoningEffort` are optional decorations.
 * @param {unknown} value - the stored `routerOrder`.
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
 * `readSettings` treat a hand-edited file as a recoverable condition.
 * @param {unknown} raw - the `router*` settings, or `undefined`.
 * @returns {{order: Array<object>, retries: number, failureThreshold: number, windowMs: number, cooldownMs: number, cooldownFactor: number, cooldownMaxMs: number, recoveryMode: string, maxSwitches: number, logLevel: string}} a fully-defaulted config.
 */
export function normalizeRouterConfig(raw) {
  const input = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}
  const cooldownMs = intIn(input.cooldownMs, ROUTER_LIMITS.minCooldownMs, ROUTER_LIMITS.maxCooldownMs, DEFAULT_ROUTER_COOLDOWN_MS)
  return {
    order: normalizeOrder(input.order),
    retries: intIn(input.retries, 0, ROUTER_LIMITS.maxRetries, DEFAULT_ROUTER_RETRIES),
    failureThreshold: intIn(input.failureThreshold, 1, ROUTER_LIMITS.failureThreshold, DEFAULT_ROUTER_THRESHOLD),
    windowMs: intIn(input.windowMs, ROUTER_LIMITS.minWindowMs, ROUTER_LIMITS.maxWindowMs, DEFAULT_ROUTER_WINDOW_MS),
    cooldownMs,
    cooldownFactor: intIn(input.cooldownFactor, ROUTER_LIMITS.minCooldownFactor, ROUTER_LIMITS.maxCooldownFactor, DEFAULT_ROUTER_COOLDOWN_FACTOR),
    // A cap below the base would make the *first* trip shorter than configured,
    // so reads repair it upward instead of letting the two fields contradict.
    cooldownMaxMs: Math.max(cooldownMs, intIn(input.cooldownMaxMs, ROUTER_LIMITS.minCooldownMs, ROUTER_LIMITS.maxCooldownMs, DEFAULT_ROUTER_COOLDOWN_MAX_MS)),
    recoveryMode: ROUTER_RECOVERY_MODES.includes(input.recoveryMode) ? input.recoveryMode : 'probe',
    maxSwitches: intIn(input.maxSwitches, ROUTER_LIMITS.minSwitches, ROUTER_LIMITS.maxSwitches, DEFAULT_ROUTER_MAX_SWITCHES),
    logLevel: ROUTER_LOG_LEVELS.includes(input.logLevel) ? input.logLevel : DEFAULT_ROUTER_LOG_LEVEL,
  }
}

/**
 * How many switches one step may make. `0` in the settings means "auto": one
 * switch per configured row, which is exactly enough to visit every candidate
 * once and then stop, so a fully degraded pool cannot loop forever.
 * @param {{order: Array<unknown>, maxSwitches: number}} cfg - normalized config.
 * @returns {number} the per-step switch budget.
 */
export function switchBudget(cfg) {
  return cfg.maxSwitches > 0 ? cfg.maxSwitches : cfg.order.length
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
 * @param {{providerRetryAfterMs?: number}|undefined} failure - the failure observed.
 * @param {number} attempt - 1 for the first retry, 2 for the second, and so on.
 * @returns {number|null} milliseconds to wait, or `null` for "switch instead".
 */
export function retryWaitMs(failure, attempt) {
  const hinted = failure?.providerRetryAfterMs
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
 * apply an edited setting in place ({@link module:dsh-prompt-optimizer/routing})
 * without throwing away the breakers that are currently open — changing a
 * cooldown should not silently forgive a provider that is still rate limited.
 *
 * @param {{order: Array<{provider: string, model: string}>, failureThreshold: number, windowMs: number, cooldownMs: number, cooldownFactor: number, cooldownMaxMs: number, recoveryMode: string}} cfg - normalized config, mutated in place by the caller when settings change.
 * @param {() => number} now - injectable clock (ms since epoch), for deterministic tests.
 * @returns {{stateOf: Function, available: Function, noteSelected: Function, recordFailure: Function, recordSuccess: Function, selectAlternative: Function, snapshot: Function, forget: Function, reset: Function}} the router.
 */
export function createRouter(cfg, now = () => Date.now()) {
  /** @type {Map<string, {failures: number[], trips: number, openUntil: number|null, halfOpen: boolean, probeStartedAt: number|null, lastFailure: object|null}>} */
  const records = new Map()

  function recordOf(provider) {
    let record = records.get(provider)
    if (record === undefined) {
      record = { failures: [], trips: 0, openUntil: null, halfOpen: false, probeStartedAt: null, lastFailure: null }
      records.set(provider, record)
    }
    return record
  }

  function pruneFailures(record, t) {
    const cutoff = t - cfg.windowMs
    while (record.failures.length > 0 && record.failures[0] < cutoff) record.failures.shift()
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

  /** Open `record` for its next escalated cooldown, counting the trip. */
  function open(record, t) {
    record.trips += 1
    record.halfOpen = false
    record.probeStartedAt = null
    record.openUntil = t + cooldownFor(record.trips)
  }

  /**
   * Derive the live state, applying cooldown expiry as a side effect.
   * @param {string} provider - provider route name.
   * @param {number} t - current time.
   * @returns {string} one of {@link CLOSED}, {@link OPEN}, {@link HALF_OPEN}.
   */
  function stateOf(provider, t) {
    const record = records.get(provider)
    if (record === undefined) return CLOSED
    if (record.openUntil === null) return record.halfOpen ? HALF_OPEN : CLOSED
    if (t < record.openUntil) return OPEN
    // Cooldown elapsed: recover immediately, or open a single-probe window.
    record.openUntil = null
    record.probeStartedAt = null
    if (cfg.recoveryMode === 'immediate') {
      record.halfOpen = false
      record.failures = []
      return CLOSED
    }
    record.halfOpen = true
    return HALF_OPEN
  }

  /**
   * Whether a provider may serve a request now; half-open admits one probe.
   * @param {string} provider - provider route name.
   * @param {number} t - current time.
   * @returns {boolean} whether the provider is selectable.
   */
  function available(provider, t) {
    const state = stateOf(provider, t)
    if (state === CLOSED) return true
    if (state !== HALF_OPEN) return false
    const record = recordOf(provider)
    // A probe that never settled must not wedge the provider forever.
    if (record.probeStartedAt !== null && t - record.probeStartedAt > cfg.cooldownMs) {
      record.probeStartedAt = null
    }
    return record.probeStartedAt === null
  }

  /**
   * Mark a provider as selected, consuming the single half-open probe slot.
   * @param {string} provider - provider route name.
   * @param {number} t - current time.
   */
  function noteSelected(provider, t) {
    if (stateOf(provider, t) !== HALF_OPEN) return
    recordOf(provider).probeStartedAt = t
  }

  /**
   * Record one breaker failure and transition the provider's state.
   *
   * The caller records a failure only once a route's retries are spent, so
   * `failureThreshold` counts *failed retry cycles* within the window rather
   * than individual attempts.
   * @param {string} provider - provider route name.
   * @param {{code?: string, status?: number, message?: string}|undefined} failure - the failure observed.
   * @param {number} t - current time.
   * @returns {string} the provider's state after the transition.
   */
  function recordFailure(provider, failure, t) {
    const record = recordOf(provider)
    record.lastFailure = {
      code: typeof failure?.code === 'string' ? failure.code : null,
      status: typeof failure?.status === 'number' ? failure.status : null,
      message: typeof failure?.message === 'string' ? failure.message.slice(0, 400) : null,
      at: t,
    }
    if (stateOf(provider, t) === HALF_OPEN) {
      // A failed probe re-opens the breaker for a fresh, escalated cooldown.
      record.failures = []
      open(record, t)
      return OPEN
    }
    record.failures.push(t)
    pruneFailures(record, t)
    if (record.failures.length >= cfg.failureThreshold) {
      open(record, t)
      return OPEN
    }
    return CLOSED
  }

  /**
   * Record a successful call, closing the breaker and clearing its counters.
   *
   * A success also zeroes the trip count: escalation is about *consecutive*
   * trips, so a provider that works once goes back to the base cooldown.
   * @param {string} provider - provider route name.
   */
  function recordSuccess(provider) {
    const record = records.get(provider)
    if (record === undefined) return
    record.failures = []
    record.trips = 0
    record.openUntil = null
    record.halfOpen = false
    record.probeStartedAt = null
  }

  /**
   * Pick the next selectable provider after `requested`, in configured order.
   *
   * The walk starts *after* the requested provider and wraps, which is what
   * makes the order a ring rather than a strict fallback list: the entry before
   * the requested one is still a candidate when everything after it is down.
   * @param {string} requested - the provider the caller asked for.
   * @param {number} t - current time.
   * @returns {{provider: string, model: string}|null} the chosen order entry, or `null` when nothing else is selectable.
   */
  function selectAlternative(requested, t) {
    const index = cfg.order.findIndex((entry) => entry.provider === requested)
    const rotated = index >= 0
      ? [...cfg.order.slice(index + 1), ...cfg.order.slice(0, index)]
      : [...cfg.order]
    for (const entry of rotated) {
      if (entry.provider === requested) continue
      if (available(entry.provider, t)) return entry
    }
    return null
  }

  /**
   * Forget one provider's breaker state.
   * @param {string} provider - provider route name.
   */
  function forget(provider) {
    records.delete(provider)
  }

  /** Forget every breaker, as if the host had just started. */
  function reset() {
    records.clear()
  }

  /**
   * Describe every configured route and its current state, for diagnostics.
   * @returns {Array<object>} one row per configured order entry.
   */
  function snapshot() {
    const t = now()
    return cfg.order.map((entry) => {
      const state = stateOf(entry.provider, t)
      const record = records.get(entry.provider) ?? null
      const trips = record === null ? 0 : record.trips
      return {
        provider: entry.provider,
        model: entry.model,
        ...(entry.label === undefined ? {} : { label: entry.label }),
        state,
        failures: record === null ? 0 : record.failures.length,
        threshold: cfg.failureThreshold,
        trips,
        // What the *next* trip would cost, so the settings page can show the
        // escalation without re-deriving it from the factor.
        nextCooldownMs: cooldownFor(trips + 1),
        openUntil: record === null ? null : record.openUntil,
        probeStartedAt: record === null ? null : record.probeStartedAt,
        lastFailure: record === null ? null : record.lastFailure,
      }
    })
  }

  return { stateOf, available, noteSelected, recordFailure, recordSuccess, selectAlternative, snapshot, forget, reset }
}

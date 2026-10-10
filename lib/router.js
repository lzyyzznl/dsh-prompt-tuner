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

/** Failure codes that trip a breaker by default (`RATE_LIMIT` is DSH's normalized 429). */
export const DEFAULT_ROUTER_CODES = Object.freeze(['RATE_LIMIT'])
/** HTTP statuses that trip a breaker by default, for adapters that report one. */
export const DEFAULT_ROUTER_STATUSES = Object.freeze([429])
/** Failures within the window needed to open a breaker. */
export const DEFAULT_ROUTER_THRESHOLD = 1
/** How far back failures are counted (ms). */
export const DEFAULT_ROUTER_WINDOW_MS = 60_000
/** How long an open breaker stays open before recovery may be attempted (ms). */
export const DEFAULT_ROUTER_COOLDOWN_MS = 60_000
/** Switches per step; `0` means "auto" — as many as there are order rows. */
export const DEFAULT_ROUTER_MAX_SWITCHES = 0
/** Default verbosity. */
export const DEFAULT_ROUTER_LOG_LEVEL = 'info'

/**
 * Bounds for the settings-page fields. The host refuses a `/save` outside these,
 * and {@link normalizeRouterConfig} clamps a hand-edited file into them, so the
 * page and the file can never disagree about what is in force.
 */
export const ROUTER_LIMITS = Object.freeze({
  /** Rows in the order table. One row per fallback candidate. */
  orderRows: 12,
  /** Distinct failure codes accepted. */
  codes: 16,
  /** Distinct HTTP statuses accepted. */
  statuses: 16,
  /** Failures per window before a breaker opens. */
  failureThreshold: 100,
  /** Failure-counting window, inclusive bounds (ms). */
  minWindowMs: 0,
  maxWindowMs: 3_600_000,
  /** Cooldown before recovery, inclusive bounds (ms). */
  minCooldownMs: 0,
  maxCooldownMs: 3_600_000,
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

/** A de-duplicated list of bounded non-empty strings, or the fallback when empty. */
function stringList(value, fallback, cap) {
  if (!Array.isArray(value)) return [...fallback]
  const out = []
  for (const item of value) {
    if (out.length >= cap) break
    const text = shortString(item)
    if (text === null || out.includes(text)) continue
    out.push(text)
  }
  return out.length === 0 ? [...fallback] : out
}

/** A de-duplicated list of finite numbers, or the fallback when empty. */
function numberList(value, fallback, cap) {
  if (!Array.isArray(value)) return [...fallback]
  const out = []
  for (const item of value) {
    if (out.length >= cap) break
    const n = Number(item)
    if (!Number.isFinite(n) || out.includes(n)) continue
    out.push(n)
  }
  return out.length === 0 ? [...fallback] : out
}

/**
 * Normalize and validate the stored routing settings, applying documented
 * defaults. Never throws: every unusable field falls back, which is what lets
 * `readSettings` treat a hand-edited file as a recoverable condition.
 * @param {unknown} raw - the `router*` settings, or `undefined`.
 * @returns {{order: Array<object>, codes: string[], statuses: number[], failureThreshold: number, windowMs: number, cooldownMs: number, recoveryMode: string, maxSwitches: number, logLevel: string}} a fully-defaulted config.
 */
export function normalizeRouterConfig(raw) {
  const input = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}
  return {
    order: normalizeOrder(input.order),
    codes: stringList(input.codes, DEFAULT_ROUTER_CODES, ROUTER_LIMITS.codes),
    statuses: numberList(input.statuses, DEFAULT_ROUTER_STATUSES, ROUTER_LIMITS.statuses),
    failureThreshold: intIn(input.failureThreshold, 1, ROUTER_LIMITS.failureThreshold, DEFAULT_ROUTER_THRESHOLD),
    windowMs: intIn(input.windowMs, ROUTER_LIMITS.minWindowMs, ROUTER_LIMITS.maxWindowMs, DEFAULT_ROUTER_WINDOW_MS),
    cooldownMs: intIn(input.cooldownMs, ROUTER_LIMITS.minCooldownMs, ROUTER_LIMITS.maxCooldownMs, DEFAULT_ROUTER_COOLDOWN_MS),
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
 * Decide whether one model failure should trip the breaker.
 *
 * Structural fields only — `code` and `status` — never error text: vendors
 * reword messages, DSH's normalized codes do not.
 * @param {{code?: string, status?: number}|undefined} failure - the `LlmFailure` carried by `agent/request-error`.
 * @param {{codes: string[], statuses: number[]}} cfg - normalized config.
 * @returns {boolean} whether the failure is a breaker event.
 */
export function isBreakFailure(failure, cfg) {
  if (!failure || typeof failure !== 'object') return false
  if (typeof failure.code === 'string' && cfg.codes.includes(failure.code)) return true
  if (typeof failure.status === 'number' && cfg.statuses.includes(failure.status)) return true
  return false
}

/**
 * Create the breaker registry.
 *
 * The config object is read at every use rather than copied, so the runtime can
 * apply an edited setting in place ({@link module:dsh-prompt-optimizer/routing})
 * without throwing away the breakers that are currently open — changing a
 * cooldown should not silently forgive a provider that is still rate limited.
 *
 * @param {{order: Array<{provider: string, model: string}>, failureThreshold: number, windowMs: number, cooldownMs: number, recoveryMode: string}} cfg - normalized config, mutated in place by the caller when settings change.
 * @param {() => number} now - injectable clock (ms since epoch), for deterministic tests.
 * @returns {{stateOf: Function, available: Function, noteSelected: Function, recordFailure: Function, recordSuccess: Function, selectAlternative: Function, snapshot: Function, forget: Function, reset: Function}} the router.
 */
export function createRouter(cfg, now = () => Date.now()) {
  /** @type {Map<string, {failures: number[], openUntil: number|null, halfOpen: boolean, probeStartedAt: number|null, lastFailure: object|null}>} */
  const records = new Map()

  function recordOf(provider) {
    let record = records.get(provider)
    if (record === undefined) {
      record = { failures: [], openUntil: null, halfOpen: false, probeStartedAt: null, lastFailure: null }
      records.set(provider, record)
    }
    return record
  }

  function pruneFailures(record, t) {
    const cutoff = t - cfg.windowMs
    while (record.failures.length > 0 && record.failures[0] < cutoff) record.failures.shift()
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
      // A failed probe re-opens the breaker for a fresh cooldown.
      record.halfOpen = false
      record.probeStartedAt = null
      record.failures = []
      record.openUntil = t + cfg.cooldownMs
      return OPEN
    }
    record.failures.push(t)
    pruneFailures(record, t)
    if (record.failures.length >= cfg.failureThreshold) {
      record.halfOpen = false
      record.probeStartedAt = null
      record.openUntil = t + cfg.cooldownMs
      return OPEN
    }
    return CLOSED
  }

  /**
   * Record a successful call, closing the breaker and clearing its counters.
   * @param {string} provider - provider route name.
   */
  function recordSuccess(provider) {
    const record = records.get(provider)
    if (record === undefined) return
    record.failures = []
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
      return {
        provider: entry.provider,
        model: entry.model,
        ...(entry.label === undefined ? {} : { label: entry.label }),
        state,
        failures: record === null ? 0 : record.failures.length,
        threshold: cfg.failureThreshold,
        openUntil: record === null ? null : record.openUntil,
        probeStartedAt: record === null ? null : record.probeStartedAt,
        lastFailure: record === null ? null : record.lastFailure,
      }
    })
  }

  return { stateOf, available, noteSelected, recordFailure, recordSuccess, selectAlternative, snapshot, forget, reset }
}

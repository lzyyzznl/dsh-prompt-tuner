/**
 * The routing half's host wiring: breaker state, the two event hooks that make
 * failover stick, the durable success signal that closes a probe, and the
 * diagnostics the settings tab reads.
 *
 * ## Why these extension points, and why `prepend`
 *
 * DSH already normalizes a provider's HTTP 429 into `LlmFailure.code ===
 * 'RATE_LIMIT'` before any plugin sees it, so nothing here inspects transport
 * or vendor payloads — intercepting at the HTTP/SDK layer would mean
 * reimplementing a normalization the runtime already performs.
 *
 *   - `agent/request-error` (prepended): observe the failure and *own* recovery,
 *     returning `{ kind: 'retry' }` so the loop re-runs the step immediately
 *     instead of waiting out the provider's backoff. Prepending matters because
 *     `dsh-llm-retry` short-circuits eligible codes, `RATE_LIMIT` among them,
 *     without calling `next()` — an inner listener would simply never run.
 *   - `agent/request` (prepended): rewrite the proposed `LlmCallConfig` to route
 *     around a provider whose breaker is open. `dsh-agent` itself rewrites this
 *     config from the session's model selection, so only an outer listener can
 *     make the failover stick; an inner one would overwrite our provider back.
 *   - `session/event`: a committed `assistant/message` is durable proof that a
 *     route worked, which is what closes a half-open breaker.
 *
 * ## What a switch looks like in the session
 *
 * Routing happens by rewriting the call config, which is the mechanism DSH
 * itself uses when the session's model changes: the loop appends a
 * `request/header` event with `reason: 'change'`, so every switch is visible in
 * the session log afterwards rather than being invisible state.
 *
 * ## Settings, not loader config
 *
 * The order table, thresholds and recovery mode are stored settings (see
 * `lib/store.js`) so the settings page can edit them while the process runs. The
 * config object is applied *in place* on change, which keeps breakers that are
 * currently open open — lowering a cooldown should not silently forgive a
 * provider that is still rate limiting.
 *
 * @module dsh-prompt-optimizer/routing
 */
import {
  CLOSED,
  HALF_OPEN,
  OPEN,
  createRouter,
  isBreakFailure,
  normalizeRouterConfig,
  switchBudget,
} from './router.js'
import { readSettings } from './store.js'

/**
 * How long a settings read is reused.
 *
 * The hooks below run at least twice per agent step, and the settings file is a
 * few hundred bytes, but re-parsing it on every step is still work nobody asked
 * for. One second is short enough that a save is in force by the next step a
 * human could react to, and `/save` calls {@link Routing#refresh} directly, so an
 * edit made in the settings page takes effect immediately rather than after the
 * TTL.
 */
const SETTINGS_TTL_MS = 1_000

/** How many recent routing events the settings tab may show. */
const RECENT_MAX = 25

/** Verbosity ranks; a message is written when its rank is at or below the setting. */
const LOG_RANKS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 }

/** Separator between the plugin's log prefix and a routing message. */
const LOG_PREFIX = '[prompt-optimizer] router:'

/**
 * Pick just the routing settings out of the whole settings document.
 * @param {object} settings - as `readSettings` returns them.
 * @returns {object} the slice {@link normalizeRouterConfig} consumes.
 */
function routerSlice(settings) {
  return {
    order: settings.routerOrder,
    codes: settings.routerCodes,
    statuses: settings.routerStatuses,
    failureThreshold: settings.routerFailureThreshold,
    windowMs: settings.routerWindowMs,
    cooldownMs: settings.routerCooldownMs,
    recoveryMode: settings.routerRecoveryMode,
    maxSwitches: settings.routerMaxSwitches,
    logLevel: settings.routerLogLevel,
  }
}

/** Render one failure compactly for a log line or the settings tab. */
function describeFailure(failure) {
  const code = typeof failure?.code === 'string' ? failure.code : 'UNKNOWN'
  const status = typeof failure?.status === 'number' ? `/${failure.status}` : ''
  const retryAfter = typeof failure?.providerRetryAfterMs === 'number' ? ` retry-after=${failure.providerRetryAfterMs}ms` : ''
  return `${code}${status}${retryAfter}`
}

/**
 * Build the routing runtime and register its hooks.
 *
 * @param {object} ctx - the host context (needs `logger` and, for the manual
 *   probe, `llm`).
 * @param {{now?: () => number}} [internals] - test seams; `now` injects the clock.
 * @returns {{
 *   config: object,
 *   router: object,
 *   enabled: () => boolean,
 *   describe: () => object,
 *   view: () => object,
 *   recent: () => Array<object>,
 *   stats: () => object,
 *   reset: () => object,
 *   refresh: (force?: boolean) => object,
 *   probe: (provider: string, model: string) => Promise<object>,
 *   dispose: () => void,
 * }} the routing handle the routes and the self-test drive.
 */
export function createRouting(ctx, internals = {}) {
  const clock = typeof internals.now === 'function' ? internals.now : () => Date.now()

  /** The live config object; mutated in place on every settings change. */
  const config = normalizeRouterConfig(undefined)
  const router = createRouter(config, clock)

  let enabled = false
  let readAt = 0
  let settings = null

  /** Recent routing events, newest first, bounded. */
  const recent = []
  const stats = { failures: 0, opens: 0, switches: 0, exhausted: 0, probes: 0, probeOk: 0 }

  /** One switch budget per step, so a fully-degraded pool cannot loop forever. */
  const switchCounts = new Map()

  const switchesFor = (turn, step) => switchCounts.get(`${turn}:${step}`) ?? 0
  const noteSwitch = (turn, step) => {
    const key = `${turn}:${step}`
    switchCounts.set(key, (switchCounts.get(key) ?? 0) + 1)
    if (switchCounts.size > 256) switchCounts.delete(switchCounts.keys().next().value)
  }

  /** Append one event to the bounded recent list (newest first). */
  function note(event) {
    recent.unshift(event)
    if (recent.length > RECENT_MAX) recent.length = RECENT_MAX
  }

  /**
   * Write one routing log line, if the configured level admits it.
   * @param {'error'|'warn'|'info'|'debug'} level - severity.
   * @param {string} message - the body (the prefix is added here).
   */
  function log(level, message) {
    const threshold = LOG_RANKS[config.logLevel] ?? LOG_RANKS.info
    if (LOG_RANKS[level] > threshold) return
    const line = `${LOG_PREFIX} ${message}`
    try {
      const fn = ctx.logger?.[level]
      if (typeof fn === 'function') {
        fn.call(ctx.logger, line)
        return
      }
    } catch {
      /* the logger service is optional; fall through to the console */
    }
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }

  /**
   * Re-read the settings, at most once per {@link SETTINGS_TTL_MS} unless forced.
   * @param {boolean} [force] - read now regardless of the TTL.
   * @returns {object} the settings in force.
   */
  function refresh(force = false) {
    const now = Date.now()
    if (!force && settings !== null && now - readAt < SETTINGS_TTL_MS) return settings
    readAt = now
    settings = readSettings()
    enabled = settings.routerEnabled === true
    // In place: the router reads `config` at every use, so an edited cooldown or
    // order applies to the next call without discarding open breakers.
    Object.assign(config, normalizeRouterConfig(routerSlice(settings)))
    return settings
  }

  refresh(true)

  /**
   * Rewrite a proposed call config onto `entry`.
   *
   * Model-specific controls are dropped unless the target row declares one: an
   * unsupported explicit effort is rejected before any provider I/O, which would
   * turn "route around a rate limit" into "fail on the first hop".
   * @param {object} seed - the config the rest of the waterfall produced.
   * @param {object} entry - the chosen order row.
   * @returns {object} the rewritten config.
   */
  function ontoEntry(seed, entry) {
    const next = { ...seed, provider: entry.provider, model: entry.model }
    if (entry.reasoningEffort === undefined) delete next.reasoningEffort
    else next.reasoningEffort = entry.reasoningEffort
    return next
  }

  // (1) Observe the failure and decide whether to own recovery.
  const offRequestError = ctx.on('agent/request-error', async (payload, next) => {
    refresh()
    if (!enabled) return next()
    const provider = payload?.provider
    const failure = payload?.failure
    if (typeof provider !== 'string' || !isBreakFailure(failure, config)) return next()
    const t = clock()
    const state = router.recordFailure(provider, failure, t)
    stats.failures += 1
    if (state === OPEN) stats.opens += 1
    log('warn', `provider "${provider}" returned ${describeFailure(failure)} -> breaker ${state}`)
    note({
      kind: 'failure',
      at: t,
      provider,
      failure: describeFailure(failure),
      message: typeof failure?.message === 'string' ? failure.message.slice(0, 400) : null,
      state,
    })
    if (switchesFor(payload?.turn, payload?.step) >= switchBudget(config)) {
      stats.exhausted += 1
      log('warn', `switch budget (${switchBudget(config)}) exhausted for turn ${payload?.turn} step ${payload?.step}; delegating recovery`)
      note({ kind: 'exhausted', at: t, provider, failure: describeFailure(failure), message: null, state })
      return next()
    }
    const alternative = router.selectAlternative(provider, t)
    if (alternative === null) {
      log('warn', `no selectable alternative for "${provider}"; delegating recovery`)
      note({ kind: 'no-alternative', at: t, provider, failure: describeFailure(failure), message: null, state })
      return next()
    }
    noteSwitch(payload?.turn, payload?.step)
    stats.switches += 1
    log('info', `failing over "${provider}" -> "${alternative.provider}/${alternative.model}"`)
    note({
      kind: 'switch',
      at: t,
      provider,
      to: `${alternative.provider}/${alternative.model}`,
      failure: describeFailure(failure),
      message: null,
      state,
    })
    // Owning recovery here (instead of delegating to `dsh-llm-retry`) makes the
    // switch immediate rather than waiting out the provider's backoff.
    return { kind: 'retry' }
  }, { prepend: true })

  // (2) Route the retried proposal around a breaker that is open.
  const offRequest = ctx.on('agent/request', async (_payload, next) => {
    refresh()
    const seed = await next()
    if (!enabled) return seed
    const requested = seed?.provider
    if (seed === undefined || seed === null || typeof requested !== 'string' || requested.length === 0) return seed
    const t = clock()
    if (router.available(requested, t)) {
      router.noteSelected(requested, t)
      return seed
    }
    const alternative = router.selectAlternative(requested, t)
    if (alternative === null) {
      log('debug', `"${requested}" is unavailable and no alternative is selectable; passing through`)
      return seed
    }
    router.noteSelected(alternative.provider, t)
    stats.switches += 1
    log('info', `routing around unavailable "${requested}" -> "${alternative.provider}/${alternative.model}"`)
    note({
      kind: 'route-around',
      at: t,
      provider: requested,
      to: `${alternative.provider}/${alternative.model}`,
      failure: null,
      message: null,
      state: router.stateOf(requested, t),
    })
    return ontoEntry(seed, alternative)
  }, { prepend: true })

  // (3) Durable proof that a route worked, closing a half-open breaker.
  const offEvent = ctx.on('session/event', (_session, event) => {
    if (event?.type !== 'assistant/message') return
    refresh()
    if (!enabled) return
    const provider = event.data?.message?.source?.provider
    if (typeof provider !== 'string') return
    const before = router.stateOf(provider, clock())
    router.recordSuccess(provider)
    if (before !== CLOSED) {
      log('info', `provider "${provider}" answered -> breaker closed`)
      note({ kind: 'close', at: clock(), provider, to: null, failure: null, message: null, state: CLOSED })
    }
  })

  if (config.order.length === 0) {
    log('info', 'active with an empty order table: failures are tracked but nothing is switched to')
  } else if (enabled) {
    log('info', `active: order=[${config.order.map((entry) => entry.provider).join(' -> ')}] threshold=${config.failureThreshold} window=${config.windowMs}ms cooldown=${config.cooldownMs}ms recovery=${config.recoveryMode} codes=[${config.codes.join(',')}]`)
  }

  /**
   * One settings-page-serializable description of what is in force.
   * @returns {object} the config plus the derived per-step budget.
   */
  function describe() {
    refresh()
    return {
      enabled,
      order: config.order.map((entry) => ({ ...entry })),
      codes: [...config.codes],
      statuses: [...config.statuses],
      failureThreshold: config.failureThreshold,
      windowMs: config.windowMs,
      cooldownMs: config.cooldownMs,
      recoveryMode: config.recoveryMode,
      maxSwitches: config.maxSwitches,
      budget: switchBudget(config),
      logLevel: config.logLevel,
    }
  }

  /**
   * Everything the settings tab polls: what is in force, each route's live
   * breaker state, and the recent routing trail.
   * @returns {object} the routing view.
   */
  function view() {
    refresh()
    return {
      enabled,
      recoveryMode: config.recoveryMode,
      cooldownMs: config.cooldownMs,
      windowMs: config.windowMs,
      failureThreshold: config.failureThreshold,
      budget: switchBudget(config),
      switchable: enabled && config.order.length > 1,
      rows: router.snapshot(),
      recent: recent.slice(0, RECENT_MAX),
      stats: { ...stats },
    }
  }

  /** Forget every breaker and every counter, as if the host had just started. */
  function reset() {
    router.reset()
    switchCounts.clear()
    recent.length = 0
    for (const key of Object.keys(stats)) stats[key] = 0
    log('info', 'breaker state cleared from the settings page')
    return view()
  }

  /**
   * Call one route once, as a diagnostic.
   *
   * This is a real completion request through `ctx.llm`, so it costs a few
   * tokens; that is the only way to answer "is this route reachable at all"
   * without guessing. A failure is reported *and* recorded by the breaker rules,
   * because a route that answers this probe with a 429 is genuinely rate limited.
   * @param {string} provider - provider route to call.
   * @param {string} model - model id to call.
   * @returns {Promise<object>} `{ok, code, message, ms, text}`.
   */
  async function probe(provider, model) {
    const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
    if (llm === undefined || typeof llm.stream !== 'function') {
      return { ok: false, code: 'no-llm', message: 'the llm service is not reachable from this plugin', ms: 0, text: '' }
    }
    const started = Date.now()
    stats.probes += 1
    let text = ''
    let failure = null
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(new Error('probe timed out')), 20_000)
    try {
      const stream = llm.stream({
        provider,
        model,
        maxTokens: 8,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        signal: controller.signal,
      })
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta') text += String(chunk.text ?? '')
        else if (chunk?.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
          failure = chunk.reason.failure ?? { code: chunk.reason.kind, message: chunk.reason.kind }
        }
      }
    } catch (cause) {
      failure = { code: 'llm-call-failed', message: String(cause?.message ?? cause) }
    } finally {
      clearTimeout(deadline)
    }
    const ms = Date.now() - started
    if (failure !== null) {
      const t = clock()
      if (isBreakFailure(failure, config)) {
        const state = router.recordFailure(provider, failure, t)
        stats.failures += 1
        if (state === OPEN) stats.opens += 1
      }
      note({ kind: 'probe', at: t, provider, to: null, failure: describeFailure(failure), message: typeof failure.message === 'string' ? failure.message.slice(0, 400) : null, state: router.stateOf(provider, t) })
      return { ok: false, code: String(failure.code ?? 'llm-error'), message: String(failure.message ?? 'probe failed'), ms, text }
    }
    if (text.trim() === '') {
      note({ kind: 'probe', at: clock(), provider, to: null, failure: 'EMPTY', message: null, state: router.stateOf(provider, clock()) })
      return { ok: false, code: 'empty-answer', message: 'the route answered with no text', ms, text }
    }
    stats.probeOk += 1
    router.recordSuccess(provider)
    note({ kind: 'probe', at: clock(), provider, to: null, failure: null, message: null, state: CLOSED })
    return { ok: true, code: 'ok', message: null, ms, text: text.slice(0, 200) }
  }

  /** Remove the hooks (the plugin fiber does this on unload; tests call it directly). */
  function dispose() {
    for (const off of [offRequestError, offRequest, offEvent]) {
      try {
        off?.()
      } catch {
        /* already disposed */
      }
    }
  }

  return {
    config,
    router,
    enabled: () => enabled,
    describe,
    view,
    recent: () => recent.slice(0, RECENT_MAX),
    stats: () => ({ ...stats }),
    reset,
    refresh,
    probe,
    dispose,
    // Exported for the self-test and the settings page, which must agree with
    // the machine about the names of the three states.
    states: { CLOSED, OPEN, HALF_OPEN },
  }
}

/**
 * The routing half's host wiring: breaker state, the two event hooks that make
 * failover stick, the durable success signal that closes a probe, and the
 * diagnostics the settings tab reads.
 *
 * ## Why these extension points, and why `prepend`
 *
 * DSH normalizes provider failures into a `LlmFailure` (`code`, `status`,
 * `message`) before any plugin sees one, so nothing here inspects transport or
 * vendor payloads — intercepting at the HTTP/SDK layer would mean
 * reimplementing a normalization the runtime already performs.
 *
 *   - `agent/request-error` (prepended): observe the failure and *own* recovery,
 *     returning `{ kind: 'retry' }` so the loop re-runs the step instead of
 *     waiting out the provider's backoff. Prepending matters because
 *     `dsh-llm-retry` answers the same hook, and an inner listener would simply
 *     never run.
 *   - `agent/request` (prepended): rewrite the proposed `LlmCallConfig` to route
 *     around a provider whose breaker is open. `dsh-agent` itself rewrites this
 *     config from the session's model selection, so only an outer listener can
 *     make the failover stick; an inner one would overwrite our provider back.
 *   - `session/event`: a committed `assistant/message` is durable proof that a
 *     route worked, which is what closes a half-open breaker.
 *
 * ## Every failure fails over, after N retries
 *
 * There is no code/status allow-list: a route that answers a request with *any*
 * failure is retried in place up to `retries` times ({@link retryWaitMs} spaces
 * the attempts, and a provider's long `retry-after` means "switch now" instead)
 * and then the request moves to the next candidate and that provider's breaker
 * opens. An allow-list is what the first version had, and it left `SERVER`,
 * `TIMEOUT` and `EMPTY_RESPONSE` failures with no failover at all.
 *
 * Two things are deliberately *not* failures: an attempt the caller aborted
 * (the user pressed stop; switching would reroute a session they just
 * cancelled), and a payload with no failure object. Both are handed back to the
 * rest of the chain.
 *
 * ## What a switch looks like in the session
 *
 * Routing happens by rewriting the call config, which is the mechanism DSH
 * itself uses when the session's model changes: the loop appends a
 * `request/header` event with `reason: 'change'`, so every switch is visible in
 * the session log afterwards rather than being invisible state.
 *
 * ## The connectivity probe
 *
 * The probe is a real completion through `ctx.llm`, so it costs a few tokens. It
 * asks for thinking to be **off**: a probe is one word, and reasoning tokens are
 * thrown away. `off` is only sent when the route accepts it — the caller resolves
 * that from the route's advertised efforts (`pickEffort` in `lib/routes.js`),
 * because an adapter rejects an unsupported explicit effort before any I/O. A
 * route that advertises nothing cannot be resolved that way, so {@link probe}
 * keeps the knob as the first attempt and drops it when the adapter rejects it,
 * rather than reporting a healthy route as unreachable.
 *
 * The budget is nonetheless 512 rather than single digits. A route that cannot
 * turn thinking off (`ccx` declares only `max`) would otherwise spend the whole
 * budget on reasoning: `deepseek-flash` answers HTTP 200 with `stop_reason:
 * max_tokens` and no visible text at all, and reading "no text" as "unreachable"
 * is what made a working route report as broken. The probe therefore tells three
 * outcomes apart: text, reasoning-only, and nothing-at-all.
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
  normalizeRouterConfig,
  retryWaitMs,
  switchBudget,
} from './router.js'
import { readSettings } from './store.js'

/**
 * How long a settings read is reused.
 *
 * The hooks below run at least twice per agent step, and the settings file is a
 * few hundred bytes, but re-parsing it on every step is still work nobody asked
 * for. One second is short enough that a save is in force by the next step a
 * human could react to, and `/save` calls {@link Routing.refresh} directly, so an
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
 * Output budget of the connectivity probe.
 *
 * Large enough that a route which *cannot* turn thinking off still finishes:
 * see the module note about the single-digit budget this replaced.
 */
const PROBE_MAX_TOKENS = 512

/** How long the probe may take before it is aborted. */
const PROBE_TIMEOUT_MS = 20_000

/**
 * The effort the probe asks for when the caller names none.
 *
 * A connectivity test is one word; thinking about it is wasted tokens. The probe
 * route resolves this against the route's advertised efforts before calling in,
 * so this default only applies to a direct call.
 */
const PROBE_EFFORT = 'off'

/**
 * Pick just the routing settings out of the whole settings document.
 * @param {object} settings - as `readSettings` returns them.
 * @returns {object} the slice {@link normalizeRouterConfig} consumes.
 */
function routerSlice(settings) {
  return {
    order: settings.routerOrder,
    retries: settings.routerRetries,
    failureThreshold: settings.routerFailureThreshold,
    windowMs: settings.routerWindowMs,
    cooldownMs: settings.routerCooldownMs,
    cooldownFactor: settings.routerCooldownFactor,
    cooldownMaxMs: settings.routerCooldownMaxMs,
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

/** A bounded prefix of a failure message, for the settings tab. */
function shortMessage(failure) {
  return typeof failure?.message === 'string' ? failure.message.slice(0, 400) : null
}

/**
 * Resolve after `ms`, or as soon as `signal` aborts.
 * @param {number} ms - milliseconds to wait.
 * @param {AbortSignal|undefined} signal - the step's signal, when the host supplies one.
 * @returns {Promise<void>} resolves on timeout or abort.
 */
function defaultSleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve()
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener?.('abort', done, { once: true })
  })
}

/**
 * Build the routing runtime and register its hooks.
 *
 * @param {object} ctx - the host context (needs `logger` and, for the manual
 *   probe, `llm`).
 * @param {{now?: () => number, sleep?: (ms: number, signal?: AbortSignal) => Promise<void>}} [internals] - test seams; `now` injects the clock and `sleep` the retry wait.
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
 *   probe: (provider: string, model: string, effort?: string|null) => Promise<object>,
 *   dispose: () => void,
 * }} the routing handle the routes and the self-test drive.
 */
export function createRouting(ctx, internals = {}) {
  const clock = typeof internals.now === 'function' ? internals.now : () => Date.now()
  const sleep = typeof internals.sleep === 'function' ? internals.sleep : defaultSleep

  /** The live config object; mutated in place on every settings change. */
  const config = normalizeRouterConfig(undefined)
  const router = createRouter(config, clock)

  let enabled = false
  let readAt = 0
  let settings = null

  /** Recent routing events, newest first, bounded. */
  const recent = []
  const stats = { failures: 0, opens: 0, switches: 0, retries: 0, exhausted: 0, probes: 0, probeOk: 0 }

  /** One switch budget per step, so a fully-degraded pool cannot loop forever. */
  const switchCounts = new Map()

  /** Failed attempts per `turn:step:provider`, so retries are counted per route. */
  const attemptCounts = new Map()

  /** Bound a per-step map so a long session cannot grow it without limit. */
  function bump(map, key) {
    const next = (map.get(key) ?? 0) + 1
    map.set(key, next)
    if (map.size > 256) map.delete(map.keys().next().value)
    return next
  }

  const switchesFor = (turn, step) => switchCounts.get(`${turn}:${step}`) ?? 0
  const noteSwitch = (turn, step) => bump(switchCounts, `${turn}:${step}`)

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

  // (1) Observe the failure: retry this route, or fail over and open its breaker.
  const offRequestError = ctx.on('agent/request-error', async (payload, next) => {
    refresh()
    if (!enabled) return next()
    const provider = payload?.provider
    const failure = payload?.failure
    if (typeof provider !== 'string' || provider.length === 0) return next()
    // Not a provider failure: the caller withdrew. Switching here would reroute
    // a session the user just stopped.
    if (payload?.signal?.aborted === true) return next()
    if (failure === null || typeof failure !== 'object' || failure.code === 'ABORTED') return next()
    const t = clock()
    const attempt = bump(attemptCounts, `${payload?.turn}:${payload?.step}:${provider}`)
    if (attempt <= config.retries) {
      const waitMs = retryWaitMs(failure, attempt)
      if (waitMs !== null) {
        stats.retries += 1
        log('info', `provider "${provider}" returned ${describeFailure(failure)} -> retry ${attempt}/${config.retries} in ${waitMs}ms`)
        note({
          kind: 'retry',
          at: t,
          provider,
          failure: describeFailure(failure),
          message: shortMessage(failure),
          state: router.stateOf(provider, t),
          attempt,
          waitMs,
        })
        await sleep(waitMs, payload?.signal)
        return { kind: 'retry' }
      }
      // The provider asked us to wait longer than a step should ever stall for,
      // so the honest answer is the same one the last retry would have reached:
      // move to the next candidate now.
      log('warn', `provider "${provider}" asked to wait ${describeFailure(failure)} -> failing over instead of retrying`)
    }
    const state = router.recordFailure(provider, failure, t)
    stats.failures += 1
    if (state === OPEN) stats.opens += 1
    log('warn', `provider "${provider}" returned ${describeFailure(failure)} -> breaker ${state}`)
    note({
      kind: 'failure',
      at: t,
      provider,
      failure: describeFailure(failure),
      message: shortMessage(failure),
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
    log('info', `active: order=[${config.order.map((entry) => entry.provider).join(' -> ')}] retries=${config.retries} threshold=${config.failureThreshold} window=${config.windowMs}ms cooldown=${config.cooldownMs}ms x${config.cooldownFactor} (max ${config.cooldownMaxMs}ms) recovery=${config.recoveryMode}`)
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
      retries: config.retries,
      failureThreshold: config.failureThreshold,
      windowMs: config.windowMs,
      cooldownMs: config.cooldownMs,
      cooldownFactor: config.cooldownFactor,
      cooldownMaxMs: config.cooldownMaxMs,
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
      cooldownFactor: config.cooldownFactor,
      cooldownMaxMs: config.cooldownMaxMs,
      retries: config.retries,
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
    attemptCounts.clear()
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
   * without guessing. A failure is reported *and* recorded by the breaker rules:
   * a route that cannot answer a probe is a route the router should skip.
   *
   * Three outcomes are told apart, because collapsing them is what made a
   * working route report as broken: visible text (reachable), reasoning but no
   * text — a route that could not turn thinking off and spent its budget
   * thinking, which is still an answer — and nothing at all.
   *
   * An adapter may also reject the effort knob itself, before any provider I/O
   * (`UNSUPPORTED_REASONING_EFFORT`). That is a statement about the request, not
   * about the route, so the probe asks again with the field omitted and keeps the
   * second answer; the rejected attempt never reaches the breaker. This is why a
   * route that advertises nothing still gets tested rather than reported broken.
   * @param {string} provider - provider route to call.
   * @param {string} model - model id to call.
   * @param {string|null} [effort] - reasoning effort to send; `off` (the default) asks for no thinking, `null` omits the field.
   * @returns {Promise<object>} `{ok, code, message, ms, text, reasoning, effort, effortOmitted}`.
   */
  async function probe(provider, model, effort = PROBE_EFFORT) {
    const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
    if (llm === undefined || typeof llm.stream !== 'function') {
      return { ok: false, code: 'no-llm', message: 'the llm service is not reachable from this plugin', ms: 0, text: '', reasoning: 0, effort }
    }
    const started = Date.now()
    stats.probes += 1

    /**
     * One stream attempt.
     * @param {string|null} useEffort - effort to send, or `null` to omit the field.
     * @returns {Promise<{text: string, reasoning: string, failure: object|null}>} what came back.
     */
    const attempt = async (useEffort) => {
      let text = ''
      let reasoning = ''
      let failure = null
      const controller = new AbortController()
      const deadline = setTimeout(() => controller.abort(new Error('probe timed out')), PROBE_TIMEOUT_MS)
      try {
        const stream = llm.stream({
          provider,
          model,
          maxTokens: PROBE_MAX_TOKENS,
          ...(typeof useEffort === 'string' ? { reasoningEffort: useEffort } : {}),
          messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
          signal: controller.signal,
        })
        for await (const chunk of stream) {
          if (chunk?.type === 'text-delta') text += String(chunk.text ?? '')
          else if (chunk?.type === 'reasoning-delta') reasoning += String(chunk.text ?? '')
          else if (chunk?.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
            failure = chunk.reason.failure ?? { code: chunk.reason.kind, message: chunk.reason.kind }
          }
        }
      } catch (cause) {
        failure = {
          code: typeof cause?.code === 'string' ? cause.code : 'llm-call-failed',
          message: String(cause?.message ?? cause),
        }
      } finally {
        clearTimeout(deadline)
      }
      return { text, reasoning, failure }
    }

    let asked = typeof effort === 'string' ? effort : null
    let outcome = await attempt(asked)
    let effortOmitted = false
    if (outcome.failure?.code === 'UNSUPPORTED_REASONING_EFFORT' && asked !== null) {
      log('info', `probe ${provider}/${model}: the adapter rejected reasoningEffort=${asked}, retrying without it`)
      outcome = await attempt(null)
      asked = null
      effortOmitted = true
    }
    const { text, reasoning, failure } = outcome
    const ms = Date.now() - started
    const reasoningChars = reasoning.length
    if (failure !== null) {
      const t = clock()
      const state = router.recordFailure(provider, failure, t)
      stats.failures += 1
      if (state === OPEN) stats.opens += 1
      log('warn', `probe ${provider}/${model} -> ${describeFailure(failure)}`)
      note({ kind: 'probe', at: t, provider, to: null, outcome: 'error', failure: describeFailure(failure), message: shortMessage(failure), state })
      return { ok: false, code: String(failure.code ?? 'llm-error'), message: String(failure.message ?? 'probe failed'), ms, text, reasoning: reasoningChars, effort: asked, effortOmitted }
    }
    if (text.trim() !== '') {
      stats.probeOk += 1
      router.recordSuccess(provider)
      note({ kind: 'probe', at: clock(), provider, to: null, outcome: 'ok', failure: null, message: null, state: CLOSED })
      return { ok: true, code: 'ok', message: null, ms, text: text.slice(0, 200), reasoning: reasoningChars, effort: asked, effortOmitted }
    }
    if (reasoning.trim() !== '') {
      // A thinking model that spent its budget thinking still proved the route
      // works end to end, so this closes the breaker rather than opening it.
      stats.probeOk += 1
      router.recordSuccess(provider)
      log('info', `probe ${provider}/${model} -> answered with reasoning only (${reasoningChars} chars, no visible text)`)
      note({ kind: 'probe', at: clock(), provider, to: null, outcome: 'no-text', failure: null, message: null, state: CLOSED })
      return {
        ok: true,
        code: 'no-text',
        message: 'the route answered with reasoning only — no visible text',
        ms,
        text,
        reasoning: reasoningChars,
        effort: asked,
        effortOmitted,
      }
    }
    // Nothing at all came back: the adapter's own EMPTY_RESPONSE case.
    const empty = { code: 'empty-answer', message: 'the route returned no content at all' }
    const t = clock()
    const state = router.recordFailure(provider, empty, t)
    stats.failures += 1
    if (state === OPEN) stats.opens += 1
    log('warn', `probe ${provider}/${model} -> ${describeFailure(empty)}`)
    note({ kind: 'probe', at: t, provider, to: null, outcome: 'empty', failure: 'EMPTY', message: null, state })
    return { ok: false, code: 'empty-answer', message: empty.message, ms, text, reasoning: reasoningChars, effort: asked, effortOmitted }
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

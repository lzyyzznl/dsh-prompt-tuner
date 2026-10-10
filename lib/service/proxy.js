/**
 * The data plane: one northbound request, walked down the order table until a
 * route answers.
 *
 * ## Why this can fail over *inside* one request
 *
 * The plugin this replaced could only change route between attempts, because DSH
 * owned the connection: it intercepted the loop's error hook, rewrote the call
 * config, and let the loop retry — which meant the caller saw an error event for
 * every hop. A proxy owns the socket, so a hop that fails before its response
 * headers arrive is invisible: the caller's request is still open, and only the
 * winning route's bytes ever reach them. The line between "can fail over" and
 * "cannot" is therefore exactly one thing — whether the response has been
 * committed — and this module is written around it.
 *
 * ## The rules, in the order they matter
 *
 *   1. **A caller's mistake never fails over.** If the request cannot be
 *      expressed in the reference contract, the converter throws and that answer
 *      is final. Trying the next provider with a request that is wrong in the
 *      same way everywhere would triple the latency of a 400.
 *   2. **A route's retries come first, then its breaker.** Each row is retried in
 *      place `retries` times; only when those are spent does the row's breaker
 *      record a failure and the walk move on. That keeps the failure counter
 *      meaning "failed retry cycles", which is what the threshold is calibrated
 *      against.
 *   3. **A long `retry-after` is a reason to move, not to wait.** A provider that
 *      asks for minutes is declined politely — the next row is tried now.
 *   4. **Once bytes are on the wire, the die is cast.** A stream that breaks
 *      mid-flight records a failure and ends the caller's stream with an error;
 *      it cannot be re-run, because the caller has already seen part of an answer.
 *   5. **An unreachable row does not trip anything.** A row naming a provider the
 *      operator deleted is a configuration fact, not a provider failure; it is
 *      skipped and the admin page shows it as unregistered.
 *
 * ## The ring, not a list
 *
 * The walk starts at the row the caller asked for and wraps: the entry *before*
 * it is still a candidate once everything after it is down. A table is a
 * preference order, and a caller who asked for the last row has not thereby
 * declared the first rows unacceptable — that is what makes the order table a
 * pool with a favourite rather than a one-way fallback chain.
 *
 * @module dsh-prompt-tuner/service/proxy
 */
import { OPEN, retryWaitMs, switchBudget } from './router.js'
import { callUpstream } from './upstream.js'

/** How many recent routing events the admin page may show. */
const RECENT_MAX = 40

/** Verbosity ranks; a message is written when its rank is at or below the setting. */
const LOG_RANKS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 }

/** Prefix on every line this service logs. */
const LOG_PREFIX = '[router-service]'

/** Output budget of a connectivity probe: one word, and thinking is not wanted. */
const PROBE_MAX_TOKENS = 512

/**
 * Split a northbound `model` into the row it names, if any.
 *
 * A caller may name a model (`deepseek-v4-flash`) or a full route
 * (`maas-dsv4/deepseek-v4-flash`); both are accepted, because the second is the
 * only unambiguous spelling when two providers serve the same model id.
 * @param {string} requested - the northbound model string.
 * @returns {{provider: string|null, model: string}} the parsed name.
 */
export function parseRouteName(requested) {
  const text = typeof requested === 'string' ? requested.trim() : ''
  const slash = text.indexOf('/')
  if (slash <= 0 || slash === text.length - 1) return { provider: null, model: text }
  return { provider: text.slice(0, slash), model: text.slice(slash + 1) }
}

/**
 * Order the table into the sequence to try for one request.
 *
 * The matched row goes first and the rest follow in configured order, wrapping;
 * an unmatched request simply starts at the top, which is the natural reading of
 * "the table is my preference order".
 * @param {Array<object>} order - the configured order table.
 * @param {string} requested - the northbound model string.
 * @returns {Array<object>} the rows to try, in order.
 */
export function buildChain(order, requested) {
  const rows = Array.isArray(order) ? order : []
  if (rows.length === 0) return []
  const { provider, model } = parseRouteName(requested)
  const index = rows.findIndex((entry) => (provider === null
    ? entry.model === model
    : entry.provider === provider && entry.model === model))
  if (index <= 0) return [...rows]
  return [...rows.slice(index), ...rows.slice(0, index)]
}

/** Render one failure compactly for a log line or the admin page. */
export function describeFailure(failure) {
  const code = typeof failure?.code === 'string' ? failure.code : 'UNKNOWN'
  const status = typeof failure?.status === 'number' && failure.status > 0 ? `/${failure.status}` : ''
  const retryAfter = typeof failure?.retryAfterMs === 'number' ? ` retry-after=${failure.retryAfterMs}ms` : ''
  return `${code}${status}${retryAfter}`
}

/**
 * Build the proxy.
 *
 * @param {object} options - the wiring.
 * @param {object} options.config - the live configuration document, mutated in place on reload.
 * @param {object} options.router - the breaker registry from `createRouter`.
 * @param {object} options.registry - the converter registry.
 * @param {{error?: Function, warn?: Function, info?: Function, debug?: Function}} [options.logger] - sink.
 * @param {() => number} [options.now] - injectable clock.
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [options.sleep] - injectable wait.
 * @returns {object} the proxy handle.
 */
export function createProxy(options) {
  const config = options.config
  const router = options.router
  const registry = options.registry
  const logger = options.logger ?? console
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const sleep = typeof options.sleep === 'function' ? options.sleep : defaultSleep

  /** Recent routing events, newest first, bounded. */
  const recent = []
  const stats = {
    requests: 0,
    failures: 0,
    opens: 0,
    switches: 0,
    retries: 0,
    exhausted: 0,
    probes: 0,
    probeOk: 0,
    rejected: 0,
  }

  /** Write one log line if the configured level admits it. */
  function log(level, message) {
    const threshold = LOG_RANKS[config.router?.logLevel] ?? LOG_RANKS.info
    if (LOG_RANKS[level] > threshold) return
    const line = `${LOG_PREFIX} ${message}`
    try {
      const fn = logger?.[level]
      if (typeof fn === 'function') {
        fn.call(logger, line)
        return
      }
    } catch {
      // A logger that throws must not fail a request; fall through to the console.
    }
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }

  /** Append one bounded event. */
  function note(event) {
    recent.unshift(event)
    if (recent.length > RECENT_MAX) recent.length = RECENT_MAX
  }

  /** The configured provider for a row, or null when it was deleted. */
  const providerOf = (row) => config.providers?.[row.provider] ?? null

  /**
   * The converter for a row, resolved fresh each time.
   *
   * Resolved per call rather than cached because both halves move underneath it:
   * a provider's base URL can be edited and the registry can grow a converter
   * while the service is running.
   * @param {object} row - the order row.
   * @param {object} provider - the resolved provider.
   * @returns {object|null} the converter, or null for pass-through.
   */
  const converterOf = (row, provider) => registry.forRoute({ provider, model: row.model })

  /**
   * Run one upstream call on one row, retrying it in place.
   *
   * @param {object} row - the order row to use.
   * @param {object} provider - its resolved provider.
   * @param {object} requestBody - the northbound body.
   * @param {string} requestedModel - what the caller named.
   * @param {boolean} stream - whether the caller wants SSE.
   * @param {AbortSignal|undefined} signal - the caller's cancellation.
   * @param {{retries?: number}} [overrides] - per-call policy, used by the disabled switch.
   * @returns {Promise<object>} `{outcome, response?, failure?, attempts, ms}`.
   */
  async function attemptRow(row, provider, requestBody, requestedModel, stream, signal, overrides = {}) {
    const converter = converterOf(row, provider)
    const ctx = { route: { provider, model: row.model }, requestedModel, routeLabel: row.label ?? null }
    let body
    try {
      body = await converter?.toUpstream?.(requestBody, ctx) ?? requestBody
    } catch (cause) {
      // Rule 1: the caller's request is wrong; no other provider can help.
      return { outcome: 'rejected', failure: { code: cause?.name ?? 'CONVERSION', status: cause?.status, message: String(cause?.message ?? cause) }, rejection: cause, attempts: 0, ms: 0 }
    }
    const retries = Number.isFinite(overrides.retries) ? overrides.retries : (config.router?.retries ?? 0)
    let attempts = 0
    let last = null
    const started = now()
    while (attempts <= retries) {
      attempts += 1
      const response = await callUpstream({ provider, body, stream, signal })
      if (response.ok === true) {
        return { outcome: 'ok', response, converter, ctx, attempts, ms: now() - started }
      }
      last = response
      if (signal?.aborted === true) return { outcome: 'aborted', failure: response, attempts, ms: now() - started }
      if (attempts > retries) break
      const waitMs = retryWaitMs(response, attempts)
      if (waitMs === null) {
        log('warn', `"${row.provider}" asked for ${describeFailure(response)} -> failing over instead of retrying`)
        break
      }
      stats.retries += 1
      log('info', `"${row.provider}" returned ${describeFailure(response)} -> retry ${attempts}/${retries} in ${waitMs}ms`)
      note({ kind: 'retry', at: now(), provider: row.provider, to: null, failure: describeFailure(response), message: response.message ?? null, attempt: attempts, waitMs })
      await sleep(waitMs, signal)
      if (signal?.aborted === true) return { outcome: 'aborted', failure: response, attempts, ms: now() - started }
    }
    return { outcome: 'failed', failure: last, converter, ctx, attempts, ms: now() - started }
  }

  /** Record a row's failure, switching the breaker and emitting the event. */
  function recordRowFailure(row, failure) {
    const state = router.recordFailure(row.provider, failure, now())
    stats.failures += 1
    if (state === OPEN) stats.opens += 1
    log('warn', `"${row.provider}" returned ${describeFailure(failure)} -> breaker ${state}`)
    note({ kind: 'failure', at: now(), provider: row.provider, to: null, failure: describeFailure(failure), message: failure?.message ?? null, state })
    return state
  }

  /**
   * Walk the chain for one request, returning either a committed response or the
   * last failure.
   * @param {object} requestBody - the northbound body.
   * @param {boolean} stream - whether the caller wants SSE.
   * @param {AbortSignal|undefined} signal - the caller's cancellation.
   * @returns {Promise<object>} the run result.
   */
  async function walk(requestBody, stream, signal) {
    const requestedModel = typeof requestBody?.model === 'string' ? requestBody.model : ''
    const order = Array.isArray(config.router?.order) ? config.router.order : []
    const chain = buildChain(order, requestedModel)
    const attempts = []
    if (config.router?.enabled === false) {
      // The switch means "plain proxy, no policy": one call to whatever the caller
      // named, no retry, and *no breaker accounting either* — a route that is not
      // being protected should not accumulate a failure history that would be
      // waiting to trip the moment the switch is turned back on.
      const row = chain[0] ?? null
      if (row === null) return { ok: false, status: 503, body: errorEnvelope(503, 'no route is configured'), attempts }
      const provider = providerOf(row)
      if (provider === null) return { ok: false, status: 503, body: errorEnvelope(503, `provider "${row.provider}" is not configured`), attempts }
      const outcome = await attemptRow(row, provider, requestBody, requestedModel, stream, signal, { retries: 0 })
      attempts.push({ provider: provider.id, model: row.model, outcome: outcome.outcome, status: outcome.failure?.status ?? outcome.response?.status ?? null, ms: outcome.ms, attempts: outcome.attempts })
      if (outcome.outcome !== 'ok') return { ok: false, status: outcome.failure?.status ?? 502, body: errorEnvelope(outcome.failure?.status ?? 502, outcome.failure?.message ?? 'the upstream request failed'), attempts }
      return finish(row, provider, outcome, attempts)
    }
    const budget = Math.max(1, switchBudget(config.router ?? {}))
    let hops = 0
    for (const row of chain) {
      if (hops >= budget) {
        stats.exhausted += 1
        log('warn', `switch budget (${budget}) exhausted for model "${requestedModel}"; delegating to the caller`)
        note({ kind: 'exhausted', at: now(), provider: row.provider, to: null, failure: null, message: null, state: router.stateOf(row.provider, now()) })
        break
      }
      const provider = providerOf(row)
      if (provider === null) {
        log('warn', `route "${row.provider}/${row.model}" names a provider that is not configured; skipping`)
        note({ kind: 'unconfigured', at: now(), provider: row.provider, to: null, failure: null, message: null, state: 'closed' })
        attempts.push({ provider: row.provider, model: row.model, outcome: 'unconfigured' })
        continue
      }
      if (!router.available(provider.id, now())) {
        log('debug', `"${provider.id}" is unavailable (breaker ${router.stateOf(provider.id, now())}); skipping`)
        attempts.push({ provider: provider.id, model: row.model, outcome: 'unavailable' })
        continue
      }
      router.noteSelected(provider.id, now())
      if (hops > 0) {
        stats.switches += 1
        log('info', `failing over to "${provider.id}/${row.model}"`)
        note({ kind: 'switch', at: now(), provider: provider.id, to: `${provider.id}/${row.model}`, failure: null, message: null, state: router.stateOf(provider.id, now()) })
      }
      hops += 1
      const result = await attemptRow(row, provider, requestBody, requestedModel, stream, signal)
      attempts.push({ provider: provider.id, model: row.model, outcome: result.outcome, status: result.failure?.status ?? result.response?.status ?? null, ms: result.ms, attempts: result.attempts })
      if (result.outcome === 'rejected') {
        stats.rejected += 1
        return { ok: false, status: result.rejection?.status ?? 400, body: result.rejection?.body ?? errorEnvelope(400, String(result.rejection?.message ?? 'the request was rejected')), attempts }
      }
      if (result.outcome === 'aborted') return { ok: false, status: 499, body: errorEnvelope(499, 'the caller aborted the request'), attempts }
      if (result.outcome === 'ok') {
        router.recordSuccess(provider.id)
        note({ kind: 'success', at: now(), provider: provider.id, to: null, failure: null, message: null, state: 'closed' })
        return { ...finish(row, provider, result, attempts), ok: true }
      }
      recordRowFailure(row, result.failure)
    }
    const last = attempts[attempts.length - 1]
    return {
      ok: false,
      status: 503,
      body: errorEnvelope(503, last === undefined
        ? 'no route could serve this request'
        : `every configured route failed; last was ${last.provider}/${last.model}`),
      attempts,
    }
  }

  /** Shape a successful attempt into the run result. */
  function finish(row, provider, result, attempts) {
    if (result.response?.stream !== undefined) {
      return { ok: true, mode: 'stream', row, provider, converter: result.converter, ctx: result.ctx, response: result.response, attempts }
    }
    return { ok: true, mode: 'json', row, provider, converter: result.converter, ctx: result.ctx, response: result.response, attempts }
  }

  /** An error body in the reference contract's envelope, for service-level faults. */
  function errorEnvelope(status, message) {
    const mapped = status >= 500
      ? { type: 'server_error', code: 'service_unavailable' }
      : { type: 'invalid_request_error', code: 'invalid_request_error' }
    return { error: { message, type: mapped.type, param: null, code: mapped.code } }
  }

  /**
   * Run one chat completion.
   *
   * A non-streaming success comes back fully converted. A streaming success comes
   * back as the *committed attempt* plus an async iterable that yields converted
   * chunks — the iterable is the caller's, so nothing is buffered on this side.
   *
   * @param {object} requestBody - the parsed northbound body.
   * @param {{signal?: AbortSignal}} [callOptions] - the caller's cancellation.
   * @returns {Promise<object>} the run result.
   */
  async function run(requestBody, callOptions = {}) {
    stats.requests += 1
    const signal = callOptions.signal
    const stream = requestBody?.stream === true
    const result = await walk(requestBody, stream, signal)
    if (result.ok !== true) return result
    // A provider that answers 200 but then dies mid-stream has committed: the
    // failure is recorded and the caller's stream ends with an error, because
    // replaying it would duplicate the half of the answer they already saw.
    if (result.mode === 'json') {
      const payload = result.converter?.fromUpstream?.(result.response.json, result.ctx) ?? result.response.json
      return { ok: true, mode: 'json', status: result.response.status, body: payload, attempts: result.attempts }
    }
    const provider = result.provider
    const converter = result.converter
    const ctx = result.ctx
    async function* chunks() {
      try {
        for await (const payload of result.response.stream) {
          if (payload === null) return
          const converted = converter?.fromUpstreamChunk?.(payload, ctx) ?? payload
          if (converted === null) continue
          yield converted
        }
      } catch (cause) {
        const failure = {
          code: typeof cause?.code === 'string' ? cause.code : 'STREAM',
          status: 0,
          message: String(cause?.message ?? cause),
        }
        recordRowFailure(result.row, failure)
        throw cause
      }
    }
    return { ok: true, mode: 'stream', status: result.response.status, chunks: chunks(), attempts: result.attempts, provider: provider.id }
  }

  /**
   * Call one configured route once, as a diagnostic.
   *
   * This is a real completion, so it costs a few tokens — which is the only way
   * to answer "is this route reachable" without guessing. Thinking is explicitly
   * off: a probe is one word, and on `co-claw` (whose default is on) a probe that
   * spent its whole budget thinking would report a working route as mute.
   *
   * @param {string} providerId - the configured provider.
   * @param {string} model - the model to ask for.
   * @returns {Promise<object>} `{ok, code, message, ms, text, reasoningChars, attempts}`.
   */
  async function probe(providerId, model) {
    const provider = config.providers?.[providerId] ?? null
    stats.probes += 1
    if (provider === null) {
      return { ok: false, code: 'unconfigured', message: `provider "${providerId}" is not configured`, ms: 0, text: '', reasoningChars: 0, attempts: 0 }
    }
    const row = { provider: providerId, model }
    const started = now()
    const result = await attemptRow(
      row,
      provider,
      { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: PROBE_MAX_TOKENS, reasoning_effort: 'none', stream: false },
      model,
      false,
      undefined,
    )
    const ms = now() - started
    if (result.outcome !== 'ok') {
      const failure = result.failure ?? { code: 'PROBE', status: 0, message: 'the probe did not complete' }
      if (result.outcome !== 'aborted') recordRowFailure(row, failure)
      note({ kind: 'probe', at: now(), provider: providerId, to: null, outcome: 'error', failure: describeFailure(failure), message: failure.message ?? null, state: router.stateOf(providerId, now()) })
      return { ok: false, code: String(failure.code ?? 'probe-failed'), message: String(failure.message ?? 'the probe failed'), ms, text: '', reasoningChars: 0, attempts: result.attempts }
    }
    const converted = result.converter?.fromUpstream?.(result.response.json, result.ctx) ?? result.response.json
    const choice = Array.isArray(converted?.choices) ? converted.choices[0] : null
    const text = typeof choice?.message?.content === 'string' ? choice.message.content : ''
    const reasoning = typeof choice?.message?.reasoning_content === 'string' ? choice.message.reasoning_content : ''
    router.recordSuccess(providerId)
    stats.probeOk += 1
    // A route that answered with thinking but no text still proved it works end
    // to end: reporting it broken is what made a healthy route look dead.
    const code = text.trim() !== '' ? 'ok' : reasoning.trim() !== '' ? 'no-text' : 'empty'
    note({ kind: 'probe', at: now(), provider: providerId, to: null, outcome: code === 'ok' ? 'ok' : 'no-text', failure: null, message: null, state: 'closed' })
    return {
      ok: code !== 'empty',
      code,
      message: code === 'empty' ? 'the route answered with no content at all' : null,
      ms,
      text: text.slice(0, 200),
      reasoningChars: reasoning.length,
      attempts: result.attempts,
    }
  }

  /**
   * Every model the service can serve, for `/v1/models`.
   *
   * Order rows are the authority: a provider's model list says what it *could*
   * serve, while the table says what is actually wired up. Both spellings of a
   * row are offered, so a caller can pick the unambiguous one.
   * @returns {Array<object>} OpenAI-shaped model entries.
   */
  function models() {
    const created = 1_767_225_600
    const out = []
    const seen = new Set()
    const push = (id, owner) => {
      if (id === '' || seen.has(id)) return
      seen.add(id)
      out.push({ id, object: 'model', created, owned_by: owner })
    }
    const order = Array.isArray(config.router?.order) ? config.router.order : []
    for (const row of order) {
      push(row.model, row.provider)
      push(`${row.provider}/${row.model}`, row.provider)
    }
    for (const entry of registry.list()) {
      try {
        for (const model of entry.listModels({ providers: config.providers ?? {} }) ?? []) {
          if (typeof model?.id === 'string') push(model.id, typeof model.owned_by === 'string' ? model.owned_by : entry.id)
        }
      } catch {
        // A converter that cannot enumerate its models is a diagnostics problem,
        // not a reason for discovery to fail: the order table already answered.
      }
    }
    return out
  }

  /** The live breaker table plus the events behind it, for the admin page. */
  function state() {
    const rows = router.snapshot().map((row) => {
      const provider = config.providers?.[row.provider] ?? null
      let converter = null
      try {
        converter = provider === null ? null : converterOf(row, provider)?.id ?? null
      } catch {
        converter = null
      }
      return { ...row, registered: provider !== null, converter }
    })
    return { rows, recent: recent.slice(0, RECENT_MAX), stats: { ...stats } }
  }

  /** Forget every breaker, counter and event, as if the service had just started. */
  function reset() {
    router.reset()
    recent.length = 0
    for (const key of Object.keys(stats)) stats[key] = 0
    log('info', 'breaker state cleared from the admin page')
    return state()
  }

  /** The live configuration document, for the admin page. */
  const configuration = () => config

  return { run, probe, models, state, reset, configuration, log }
}

/**
 * Resolve after `ms`, or as soon as `signal` aborts.
 * @param {number} ms - milliseconds to wait.
 * @param {AbortSignal|undefined} signal - the caller's signal.
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

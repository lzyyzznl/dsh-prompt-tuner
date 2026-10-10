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
 * ## A candidate is a credential, not a provider
 *
 * The walk visits `row × credential` ({@link buildCandidates}), which is the
 * granularity the pool actually has. A key that fails is stepped over while its
 * siblings on the same provider keep serving, and the provider as a whole only
 * leaves rotation once every one of its credentials is unusable — the behaviour
 * an operator means by "one provider, several keys".
 *
 * The order is: each row in configured order, and within a row its credentials
 * in the order the operator put them. Because the chain is a ring, the rows
 * *before* the one the caller named are still candidates once everything after
 * them is down.
 *
 * ## The rules, in the order they matter
 *
 *   1. **A caller's mistake never fails over.** If the request cannot be
 *      expressed in the reference contract, the converter throws and that answer
 *      is final. Trying the next provider with a request that is wrong in the
 *      same way everywhere would triple the latency of a 400.
 *   2. **A route's retries come first, then its breaker.** Each candidate is
 *      retried in place `retries` times; only when those are spent does the
 *      unit's breaker record a failure and the walk move on.
 *   3. **Only the route's own failures are recorded.** The class comes from
 *      `lib/service/failure.js`: a rejected request, a missing model and a caller
 *      who hung up are the caller's fault and are counted nowhere. Recording them
 *      would let a broken client trip a breaker against a healthy provider.
 *   4. **A dead credential is removed, not cooled down.** A `401`, `402` or
 *      permission error becomes a persistent blacklist entry the walk skips
 *      entirely, because a cooldown would only mean retrying a revoked key
 *      forever.
 *   5. **A long `retry-after` is a reason to move, not to wait.** A provider that
 *      asks for minutes is declined politely — the next candidate is tried now.
 *   6. **Once bytes are on the wire, the die is cast.** A stream that breaks
 *      mid-flight records a failure and ends the caller's stream with an error;
 *      it cannot be re-run, because the caller has already seen part of an answer.
 *   7. **An unreachable row does not trip anything.** A row naming a provider the
 *      operator deleted is a configuration fact, not a provider failure; it is
 *      skipped and the admin page shows it as unregistered.
 *
 * @module dsh-prompt-tuner/service/proxy
 */
import { keyUnitsOf } from './config.js'
import { blacklistVerdict, classifyFailure, describeFailure, isBreakerRelevant, opensImmediately } from './failure.js'
import { OPEN, retryWaitMs, switchBudget, unitKey } from './router.js'
import { callUpstream } from './upstream.js'

// Re-exported because it lived here before the failure classifier existed, and a
// caller that imports it from the proxy should keep working.
export { describeFailure }

/**
 * The message roles the reference contract (`api.deepseek.com/v1 (OpenAI
 * chat.completions)`) accepts. Everything else a caller might send — DSH's
 * thinking-route adapters probe `supportsDeveloperRole` and hand a system prompt
 * as a `developer` message — is normalised back into this set before it reaches
 * an upstream, because the official endpoint rejects the rest with a 422.
 */
const REFERENCE_ROLES = new Set(['system', 'user', 'assistant', 'tool'])

/**
 * Normalise one outbound (converted or passed-through) request body onto the
 * reference contract's message roles.
 *
 * Only the `messages` list is touched, and only those entries whose role the
 * reference contract does not know. Every upstream the service dials shares the
 * reference contract — `deepseek-official` passes through with no converter and
 * the ZTE gateways accept `system` too — so relabelling `developer` → `system`
 * here is safe for every route and never rewrites a caller's intent.
 *
 * @param {object} body - the request body about to go upstream.
 * @returns {object} the same body with foreign message roles relabelled; the
 *   input object itself when nothing needed to change.
 */
export function normalizeReferenceBody(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body
  const messages = body.messages
  if (!Array.isArray(messages) || messages.length === 0) return body
  let changed = false
  const normalized = messages.map((message) => {
    if (typeof message !== 'object' || message === null) return message
    const role = message.role
    if (typeof role !== 'string' || REFERENCE_ROLES.has(role)) return message
    changed = true
    return { ...message, role: 'system' }
  })
  if (!changed) return body
  return { ...body, messages: normalized }
}

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
 * Decide what a northbound model name resolves to.
 *
 * Three answers, and the third one is the reason this is not a one-liner:
 *
 *   - `matched` — the name is a row in the table. That row goes first and the
 *     rest follow in configured order, wrapping, because the table is the
 *     caller's preference order and a listed model may fail over to another
 *     listed model.
 *   - `provider` — the name is `provider/model` for a *configured* provider, but
 *     no row lists it. The caller was specific about both halves, so it is served
 *     by exactly that provider and that model and nothing follows it.
 *   - `unknown` — nothing in this router serves the name.
 *
 * The middle answer used to be "start at the top of the table". That made
 * `maas-coclaw/co-claw` — a configured provider with a real gateway and a real
 * key behind it — get answered by whichever row happened to be first: HTTP 200,
 * the requested model name echoed back, and a different backend underneath. A
 * table is a preference order over the models it lists; it is not a licence to
 * answer a question about one model with another. It also made
 * `totally-bogus/not-configured` succeed, which is worse: a typo in a model name
 * was indistinguishable from a working route.
 *
 * An empty table stays "nothing is routed" even for a fully qualified name: the
 * table is the routing configuration, and an admin who clears it has said that
 * this router serves nothing.
 * @param {Array<object>} order - the configured order table.
 * @param {string} requested - the northbound model string.
 * @param {Iterable<string>} [providerIds] - ids of the configured providers.
 * @returns {{rows: Array<object>, reason: 'matched'|'provider'|'unknown'}} the rows to try, in order.
 */
export function resolveRoute(order, requested, providerIds) {
  const rows = Array.isArray(order) ? order : []
  const { provider, model } = parseRouteName(requested)
  const index = rows.findIndex((entry) => (provider === null
    ? entry.model === model
    : entry.provider === provider && entry.model === model))
  if (index >= 0) return { rows: [...rows.slice(index), ...rows.slice(0, index)], reason: 'matched' }
  if (rows.length === 0) return { rows: [], reason: 'unknown' }
  const configured = new Set(providerIds ?? [])
  if (provider !== null && model !== '' && configured.has(provider)) {
    return { rows: [{ provider, model }], reason: 'provider' }
  }
  return { rows: [], reason: 'unknown' }
}

/**
 * The rows to try for one request, for callers that do not need to tell "not
 * listed" apart from "not served".
 * @param {Array<object>} order - the configured order table.
 * @param {string} requested - the northbound model string.
 * @param {Iterable<string>} [providerIds] - ids of the configured providers.
 * @returns {Array<object>} the rows to try, in order; empty when nothing serves the name.
 */
export function buildChain(order, requested, providerIds) {
  return resolveRoute(order, requested, providerIds).rows
}

/**
 * Flatten the chain into the candidate units one request may actually try.
 *
 * Credentials of one row stay adjacent, which is what makes "same provider, next
 * key" the first thing that happens after a key fails — the provider only loses
 * its turn once the row has run out of credentials.
 *
 * @param {Array<object>} chain - rows from {@link buildChain}.
 * @param {(row: object) => Array<{id: string|null, label?: string, key?: string}>} unitsForRow - the credentials a row can use.
 * @returns {Array<object>} one candidate per row per credential.
 */
export function buildCandidates(chain, unitsForRow) {
  const out = []
  for (const row of Array.isArray(chain) ? chain : []) {
    let units
    try {
      units = unitsForRow(row)
    } catch {
      units = [{ id: null }]
    }
    if (!Array.isArray(units) || units.length === 0) units = [{ id: null }]
    for (const unit of units) {
      out.push({
        row,
        provider: row.provider,
        model: row.model,
        keyId: typeof unit?.id === 'string' && unit.id !== '' ? unit.id : null,
        keyLabel: typeof unit?.label === 'string' ? unit.label : '',
        key: typeof unit?.key === 'string' ? unit.key : '',
      })
    }
  }
  return out
}

/**
 * Build the proxy.
 *
 * @param {object} options - the wiring.
 * @param {object} options.config - the live configuration document, mutated in place on reload.
 * @param {object} options.router - the breaker registry from `createRouter`.
 * @param {object} options.registry - the converter registry.
 * @param {object} [options.state] - the runtime state store (blacklist, discovered models).
 * @param {{error?: Function, warn?: Function, info?: Function, debug?: Function}} [options.logger] - sink.
 * @param {() => number} [options.now] - injectable clock.
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [options.sleep] - injectable wait.
 * @returns {object} the proxy handle.
 */
export function createProxy(options) {
  const config = options.config
  const router = options.router
  const registry = options.registry
  const state = options.state ?? null
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
    ignored: 0,
    blacklisted: 0,
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

  /** How a candidate is named in a log line or an event. */
  const nameOf = (candidate) => (candidate.keyId === null
    ? candidate.provider
    : `${candidate.provider}#${candidate.keyId}`)

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
   * Run one upstream call on one candidate, retrying it in place.
   *
   * @param {object} candidate - the row plus the credential to use.
   * @param {object} provider - its resolved provider.
   * @param {object} requestBody - the northbound body.
   * @param {string} requestedModel - what the caller named.
   * @param {boolean} stream - whether the caller wants SSE.
   * @param {AbortSignal|undefined} signal - the caller's cancellation.
   * @param {{retries?: number}} [overrides] - per-call policy, used by the disabled switch.
   * @returns {Promise<object>} `{outcome, response?, failure?, attempts, ms}`.
   */
  async function attemptRow(candidate, provider, requestBody, requestedModel, stream, signal, overrides = {}) {
    const converter = converterOf(candidate.row, provider)
    const ctx = { route: { provider, model: candidate.model }, requestedModel, routeLabel: candidate.row.label ?? null }
    let body
    try {
      body = await converter?.toUpstream?.(requestBody, ctx) ?? requestBody
    } catch (cause) {
      // Rule 1: the caller's request is wrong; no other provider can help.
      return { outcome: 'rejected', failure: { code: cause?.name ?? 'CONVERSION', status: cause?.status, message: String(cause?.message ?? cause) }, rejection: cause, attempts: 0, ms: 0 }
    }
    // The reference contract only knows system/user/assistant/tool. DSH may hand
    // a `developer` system prompt to thinking routes (its `supportsDeveloperRole`
    // probe), which the ZTE gateways accept but the official endpoint rejects
    // with a 422 — so every outbound body is relabelled once, after the
    // converter, before it is put on the wire.
    body = normalizeReferenceBody(body)
    const retries = Number.isFinite(overrides.retries) ? overrides.retries : (config.router?.retries ?? 0)
    let attempts = 0
    let last = null
    const started = now()
    while (attempts <= retries) {
      attempts += 1
      const response = await callUpstream({ provider, key: { id: candidate.keyId, key: candidate.key }, body, stream, signal })
      if (response.ok === true) {
        return { outcome: 'ok', response, converter, ctx, attempts, ms: now() - started }
      }
      last = response
      if (signal?.aborted === true) return { outcome: 'aborted', failure: response, attempts, ms: now() - started }
      if (attempts > retries) break
      const waitMs = retryWaitMs(response, attempts)
      if (waitMs === null) {
        log('warn', `"${nameOf(candidate)}" asked for ${describeFailure(response)} -> failing over instead of retrying`)
        break
      }
      stats.retries += 1
      log('info', `"${nameOf(candidate)}" returned ${describeFailure(response)} -> retry ${attempts}/${retries} in ${waitMs}ms`)
      note({ kind: 'retry', at: now(), provider: candidate.provider, keyId: candidate.keyId, to: null, failure: describeFailure(response), message: response.message ?? null, attempt: attempts, waitMs })
      await sleep(waitMs, signal)
      if (signal?.aborted === true) return { outcome: 'aborted', failure: response, attempts, ms: now() - started }
    }
    return { outcome: 'failed', failure: last, converter, ctx, attempts, ms: now() - started }
  }

  /**
   * Record what one failed candidate means, and act on it.
   *
   * Three outcomes, and the order they are considered is the design:
   *
   *   1. a verdict that the credential is dead -> persistent blacklist, and the
   *      breaker's memory of that unit is dropped (it is unusable either way, and
   *      keeping a stale cooldown next to a blacklist entry only confuses the
   *      page);
   *   2. a failure that says nothing about the route -> counted nowhere;
   *   3. everything else -> the unit's breaker, with an overload opening it at
   *      once rather than waiting for a second confirmation.
   *
   * @param {object} candidate - the candidate that failed.
   * @param {object} failure - the failure observed.
   * @returns {string} the unit's state after the transition.
   */
  function recordCandidateFailure(candidate, failure) {
    const unit = unitKey(candidate.provider, candidate.keyId)
    const verdict = classifyFailure(failure)
    const t = now()
    stats.failures += 1
    const named = nameOf(candidate)

    const dead = blacklistVerdict(failure, { now: t })
    if (dead.should && state !== null) {
      state.mark(unit, {
        provider: candidate.provider,
        keyId: candidate.keyId,
        reason: dead.reason,
        message: dead.message,
        recoverAt: dead.recoverAt,
      })
      router.forget(unit)
      stats.blacklisted += 1
      log('warn', `"${named}" is out of rotation: ${dead.reason} (${describeFailure(failure)})`)
      note({ kind: 'blacklist', at: t, provider: candidate.provider, keyId: candidate.keyId, to: null, failure: describeFailure(failure), message: dead.message, state: 'blacklisted', reason: dead.reason })
      return 'blacklisted'
    }

    if (!isBreakerRelevant(verdict.cls)) {
      stats.ignored += 1
      // Nothing was learned about this route, so the half-open probe slot the
      // attempt consumed goes back: otherwise a client-side 400 would black out
      // a recovering route for a whole cooldown.
      router.releaseProbe(unit, t)
      log('info', `"${named}" returned ${describeFailure(failure)} (${verdict.cls}: ${verdict.reason}) -> not counted`)
      note({ kind: 'ignored', at: t, provider: candidate.provider, keyId: candidate.keyId, to: null, failure: describeFailure(failure), message: failure?.message ?? null, state: 'closed', reason: verdict.reason })
      return 'closed'
    }

    const next = router.recordFailure(unit, { ...failure, cls: verdict.cls }, t, { immediate: opensImmediately(verdict.cls) })
    if (next === OPEN) stats.opens += 1
    log('warn', `"${named}" returned ${describeFailure(failure)} (${verdict.cls}) -> breaker ${next}`)
    note({ kind: 'failure', at: t, provider: candidate.provider, keyId: candidate.keyId, to: null, failure: describeFailure(failure), message: failure?.message ?? null, state: next, reason: verdict.reason })
    return next
  }

  /**
   * Walk the candidates for one request, returning either a committed response or
   * the last failure.
   * @param {object} requestBody - the northbound body.
   * @param {boolean} stream - whether the caller wants SSE.
   * @param {AbortSignal|undefined} signal - the caller's cancellation.
   * @returns {Promise<object>} the run result.
   */
  async function walk(requestBody, stream, signal) {
    const requestedModel = typeof requestBody?.model === 'string' ? requestBody.model : ''
    const order = Array.isArray(config.router?.order) ? config.router.order : []
    const attempts = []
    const resolved = resolveRoute(order, requestedModel, Object.keys(config.providers ?? {}))
    if (resolved.reason === 'unknown') {
      // Refusing is the whole point: this is the answer the caller can act on,
      // where silently serving the name with some other model is the answer it
      // cannot even detect.
      const configured = order.length > 0
      log('warn', configured
        ? `"${requestedModel}" is not served by this router (no matching row, and no configured provider of that name) -> refusing instead of substituting another model`
        : `"${requestedModel}" was requested but the routing order table is empty`)
      // Deliberately not a `note()`: the recent-events list is the breaker's
      // history of *attempts*, and nothing was attempted here. A refusal is
      // visible where it is actionable — in the caller's 404 and in this log line.
      return {
        ok: false,
        status: configured ? 404 : 503,
        body: configured
          ? errorEnvelope(404, `model "${requestedModel}" is not served by this router; add a row for it to the routing order table, or name it as provider/model for a configured provider`)
          : errorEnvelope(503, 'no route is configured'),
        attempts,
      }
    }
    const candidates = buildCandidates(resolved.rows, (row) => {
      const provider = providerOf(row)
      return provider === null ? [{ id: null }] : keyUnitsOf(provider)
    })
    if (config.router?.enabled === false) {
      // The switch means "plain proxy, no policy": one call to whatever the caller
      // named, no retry, and *no breaker accounting either* — a route that is not
      // being protected should not accumulate a failure history that would be
      // waiting to trip the moment the switch is turned back on.
      const candidate = candidates[0] ?? null
      if (candidate === null) return { ok: false, status: 503, body: errorEnvelope(503, 'no route is configured'), attempts }
      const provider = providerOf(candidate.row)
      if (provider === null) return { ok: false, status: 503, body: errorEnvelope(503, `provider "${candidate.provider}" is not configured`), attempts }
      const outcome = await attemptRow(candidate, provider, requestBody, requestedModel, stream, signal, { retries: 0 })
      attempts.push({ provider: provider.id, model: candidate.model, keyId: candidate.keyId, outcome: outcome.outcome, status: outcome.failure?.status ?? outcome.response?.status ?? null, ms: outcome.ms, attempts: outcome.attempts })
      if (outcome.outcome !== 'ok') return { ok: false, status: outcome.failure?.status ?? 502, body: errorEnvelope(outcome.failure?.status ?? 502, outcome.failure?.message ?? 'the upstream request failed'), attempts }
      return finish(candidate, provider, outcome, attempts)
    }
    const budget = Math.max(1, switchBudget(config.router ?? {}, candidates.length))
    let hops = 0
    /** The last attempt that actually reached an upstream, so its answer can be handed back verbatim. */
    let lastFailure = null
    for (const candidate of candidates) {
      const provider = providerOf(candidate.row)
      if (provider === null) {
        log('warn', `route "${candidate.provider}/${candidate.model}" names a provider that is not configured; skipping`)
        note({ kind: 'unconfigured', at: now(), provider: candidate.provider, keyId: candidate.keyId, to: null, failure: null, message: null, state: 'closed' })
        attempts.push({ provider: candidate.provider, model: candidate.model, keyId: candidate.keyId, outcome: 'unconfigured' })
        continue
      }
      const unit = unitKey(provider.id, candidate.keyId)
      const blocked = state === null ? null : state.blocked(unit)
      if (blocked !== null) {
        // A dead credential is not tried at all: that is the entire point of
        // separating it from a cooldown.
        log('debug', `"${nameOf(candidate)}" is blacklisted (${blocked.reason}); skipping`)
        attempts.push({ provider: provider.id, model: candidate.model, keyId: candidate.keyId, outcome: 'blacklisted', reason: blocked.reason })
        continue
      }
      if (!router.available(unit, now())) {
        log('debug', `"${nameOf(candidate)}" is unavailable (breaker ${router.stateOf(unit, now())}); skipping`)
        attempts.push({ provider: provider.id, model: candidate.model, keyId: candidate.keyId, outcome: 'unavailable' })
        continue
      }
      if (hops >= budget) {
        stats.exhausted += 1
        log('warn', `switch budget (${budget}) exhausted for model "${requestedModel}"; delegating to the caller`)
        note({ kind: 'exhausted', at: now(), provider: candidate.provider, keyId: candidate.keyId, to: null, failure: null, message: null, state: router.stateOf(unit, now()) })
        break
      }
      router.noteSelected(unit, now())
      if (hops > 0) {
        stats.switches += 1
        log('info', `failing over to "${nameOf(candidate)}/${candidate.model}"`)
        note({ kind: 'switch', at: now(), provider: provider.id, keyId: candidate.keyId, to: `${nameOf(candidate)}/${candidate.model}`, failure: null, message: null, state: router.stateOf(unit, now()) })
      }
      hops += 1
      const result = await attemptRow(candidate, provider, requestBody, requestedModel, stream, signal)
      attempts.push({ provider: provider.id, model: candidate.model, keyId: candidate.keyId, outcome: result.outcome, status: result.failure?.status ?? result.response?.status ?? null, ms: result.ms, attempts: result.attempts })
      if (result.outcome === 'rejected') {
        stats.rejected += 1
        router.releaseProbe(unit, now())
        return { ok: false, status: result.rejection?.status ?? 400, body: result.rejection?.body ?? errorEnvelope(400, String(result.rejection?.message ?? 'the request was rejected')), attempts }
      }
      if (result.outcome === 'aborted') {
        router.releaseProbe(unit, now())
        return { ok: false, status: 499, body: errorEnvelope(499, 'the caller aborted the request'), attempts }
      }
      if (result.outcome === 'ok') {
        router.recordSuccess(unit, now())
        note({ kind: 'success', at: now(), provider: provider.id, keyId: candidate.keyId, to: null, failure: null, message: null, state: 'closed' })
        return { ...finish(candidate, provider, result, attempts), ok: true }
      }
      recordCandidateFailure(candidate, result.failure)
      lastFailure = result
    }
    const last = attempts[attempts.length - 1]
    const allBlacklisted = attempts.length > 0 && attempts.every((entry) => entry.outcome === 'blacklisted')
    if (allBlacklisted) {
      // This one deserves its own sentence: the request never reached an
      // upstream, so "every route failed" would send the operator looking at the
      // network instead of at the page that can fix it.
      return {
        ok: false,
        status: 503,
        body: errorEnvelope(503, `every credential for this route is blacklisted (${[...new Set(attempts.map((entry) => entry.reason).filter(Boolean))].join(', ')}); restore one from the admin page`),
        attempts,
      }
    }
    if (lastFailure !== null && lastFailure.failure !== undefined && lastFailure.failure !== null) {
      const failure = lastFailure.failure
      const upstreamStatus = Number.isFinite(failure.status) && failure.status >= 400 ? failure.status : null
      if (upstreamStatus === null) {
        // Nothing to hand back: a timeout, a dropped connection, or a 200 whose
        // body did not parse is not an upstream *answer*. Those get this
        // service's own envelope (502 Bad Gateway) with the precise reason,
        // never the unparseable bytes themselves.
        return {
          ok: false,
          status: 502,
          body: errorEnvelope(502, failure.message ?? 'the upstream request failed'),
          attempts,
        }
      }
      // A candidate was really tried and really answered with an error. Reporting
      // our own 503 instead would replace a precise upstream answer ("this model
      // does not exist here", "you are over quota") with "something went wrong",
      // which is the one thing the caller cannot act on. The converter shapes it
      // into the reference contract's envelope; `errorBody` returns `{status, body}`.
      let shaped = null
      try {
        shaped = lastFailure.converter?.errorBody?.(failure, lastFailure.ctx) ?? null
      } catch {
        // A converter that cannot shape the error must not turn it into a 500.
        shaped = null
      }
      const status = Number.isFinite(shaped?.status) && shaped.status >= 400 ? shaped.status : upstreamStatus
      const payload = shaped?.body ?? failure.body ?? errorEnvelope(status, failure.message ?? 'the upstream request failed')
      return { ok: false, status, body: payload, attempts }
    }
    return {
      ok: false,
      status: 503,
      body: errorEnvelope(503, last === undefined
        ? 'no route could serve this request'
        : `every configured route failed; last was ${last.provider}${last.keyId === null || last.keyId === undefined ? '' : `#${last.keyId}`}/${last.model}`),
      attempts,
    }
  }

  /** Shape a successful attempt into the run result. */
  function finish(candidate, provider, result, attempts) {
    return {
      ok: true,
      mode: result.response?.stream !== undefined ? 'stream' : 'json',
      row: candidate.row,
      provider,
      keyId: candidate.keyId,
      converter: result.converter,
      ctx: result.ctx,
      response: result.response,
      attempts,
    }
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
    const committed = { row: result.row, provider: provider.id, model: result.row.model, keyId: result.keyId }
    async function* chunks() {
      try {
        for await (const payload of result.response.stream) {
          if (payload === null) return
          const converted = converter?.fromUpstreamChunk?.(payload, ctx) ?? payload
          if (converted === null) continue
          yield converted
        }
      } catch (cause) {
        recordCandidateFailure(committed, {
          code: typeof cause?.code === 'string' ? cause.code : 'STREAM',
          status: 0,
          message: String(cause?.message ?? cause),
        })
        throw cause
      }
    }
    return { ok: true, mode: 'stream', status: result.response.status, chunks: chunks(), attempts: result.attempts, provider: provider.id, keyId: result.keyId }
  }

  /**
   * Call one configured route once, as a diagnostic.
   *
   * This is a real completion, so it costs a few tokens — which is the only way
   * to answer "is this route reachable" without guessing. Thinking is explicitly
   * off: a probe is one word, and on `co-claw` (whose default is on) a probe that
   * spent its whole budget thinking would report a working route as mute.
   *
   * Which credential to use is decided here: the one the caller named, else the
   * first one that is neither blacklisted nor open, else the first one — because
   * "probe this provider" should test something that can actually answer.
   *
   * @param {string} providerId - the configured provider.
   * @param {string} model - the model to ask for.
   * @param {string} [keyId] - the credential to use.
   * @returns {Promise<object>} `{ok, code, message, ms, text, reasoningChars, attempts, keyId}`.
   */
  async function probe(providerId, model, keyId) {
    const provider = config.providers?.[providerId] ?? null
    stats.probes += 1
    if (provider === null) {
      return { ok: false, code: 'unconfigured', message: `provider "${providerId}" is not configured`, ms: 0, text: '', reasoningChars: 0, attempts: 0, keyId: null }
    }
    const units = keyUnitsOf(provider)
    let unit = typeof keyId === 'string' && keyId !== ''
      ? units.find((entry) => entry.id === keyId) ?? null
      : null
    if (unit === null && typeof keyId === 'string' && keyId !== '') {
      return { ok: false, code: 'unknown-key', message: `provider "${providerId}" has no key "${keyId}"`, ms: 0, text: '', reasoningChars: 0, attempts: 0, keyId }
    }
    if (unit === null) {
      unit = units.find((entry) => {
        const id = unitKey(providerId, entry.id)
        return (state === null || state.blocked(id) === null) && router.available(id, now())
      }) ?? units[0]
    }
    const candidate = { row: { provider: providerId, model }, provider: providerId, model, keyId: unit.id, keyLabel: unit.label ?? '', key: unit.key ?? '' }
    const id = unitKey(providerId, unit.id)
    const started = now()
    const result = await attemptRow(
      candidate,
      provider,
      { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: PROBE_MAX_TOKENS, reasoning_effort: 'none', stream: false },
      model,
      false,
      undefined,
    )
    const ms = now() - started
    if (result.outcome !== 'ok') {
      const failure = result.failure ?? { code: 'PROBE', status: 0, message: 'the probe did not complete' }
      if (result.outcome !== 'aborted') recordCandidateFailure(candidate, failure)
      note({ kind: 'probe', at: now(), provider: providerId, keyId: unit.id, to: null, outcome: 'error', failure: describeFailure(failure), message: failure.message ?? null, state: router.stateOf(id, now()) })
      return { ok: false, code: String(failure.code ?? 'probe-failed'), message: String(failure.message ?? 'the probe failed'), ms, text: '', reasoningChars: 0, attempts: result.attempts, keyId: unit.id }
    }
    const converted = result.converter?.fromUpstream?.(result.response.json, result.ctx) ?? result.response.json
    const choice = Array.isArray(converted?.choices) ? converted.choices[0] : null
    const text = typeof choice?.message?.content === 'string' ? choice.message.content : ''
    const reasoning = typeof choice?.message?.reasoning_content === 'string' ? choice.message.reasoning_content : ''
    router.recordSuccess(id, now())
    stats.probeOk += 1
    // A credential that just answered is demonstrably alive: leaving it
    // blacklisted would mean the page says "failed" while the probe right next
    // to it says "ok", which is exactly the kind of contradiction an operator
    // cannot act on.
    if (state !== null && state.blocked(id) !== null) {
      state.clear(id)
      log('info', `"${providerId}#${unit.id ?? ''}" answered a probe; its blacklist entry was cleared`)
      note({ kind: 'restore', at: now(), provider: providerId, keyId: unit.id, to: null, failure: null, message: 'cleared by a successful probe', state: 'closed', reason: 'probe_success' })
    }
    // A route that answered with thinking but no text still proved it works end
    // to end: reporting it broken is what made a healthy route look dead.
    const code = text.trim() !== '' ? 'ok' : reasoning.trim() !== '' ? 'no-text' : 'empty'
    note({ kind: 'probe', at: now(), provider: providerId, keyId: unit.id, to: null, outcome: code === 'ok' ? 'ok' : 'no-text', failure: null, message: null, state: 'closed' })
    return {
      ok: code !== 'empty',
      code,
      message: code === 'empty' ? 'the route answered with no content at all' : null,
      ms,
      text: text.slice(0, 200),
      reasoningChars: reasoning.length,
      attempts: result.attempts,
      keyId: unit.id,
    }
  }

  /**
   * Every model the service can serve, for `/v1/models`.
   *
   * Order rows are the authority: a provider's model list says what it *could*
   * serve, while the table says what is actually wired up. Each row is offered
   * as `provider/model` only — the bare model name is deliberately *not*
   * listed, because the bare name is ambiguous the moment two providers carry
   * the same model (here `deepseek-v4-flash` is served by maas-dsv4 *and*
   * deepseek-official). `provider/model` is the id a client can hand straight
   * back to `/v1/chat/completions`; the bare model name still routes by order
   * table, it just is not advertised.
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
      push(`${row.provider}/${row.model}`, row.provider)
    }
    return out
  }

  /** The live breaker table plus the events behind it, for the admin page. */
  function state_() {
    const unitsOf = (providerId) => keyUnitsOf(config.providers?.[providerId])
    const rows = router.snapshot(unitsOf).map((row) => {
      const provider = config.providers?.[row.provider] ?? null
      let converter = null
      try {
        converter = provider === null ? null : converterOf(row, provider)?.id ?? null
      } catch {
        converter = null
      }
      const blocked = state === null ? null : state.blocked(row.unit)
      return {
        ...row,
        registered: provider !== null,
        converter,
        blacklisted: blocked !== null,
        blacklist: blocked,
        keyLabel: row.keyLabel === '' && row.keyId !== null
          ? (provider?.keys?.find((entry) => entry.id === row.keyId)?.label ?? '')
          : row.keyLabel,
      }
    })
    return { rows, recent: recent.slice(0, RECENT_MAX), stats: { ...stats } }
  }

  /** Forget every breaker, counter and event, as if the service had just started. */
  function reset() {
    router.reset()
    recent.length = 0
    for (const key of Object.keys(stats)) stats[key] = 0
    log('info', 'breaker state cleared from the admin page')
    return state_()
  }

  /** The live configuration document, for the admin page. */
  const configuration = () => config

  return { run, probe, models, state: state_, reset, configuration, log }
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

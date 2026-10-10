/**
 * Host-side translation of "compact this model at N tokens" into the
 * `compaction-basic` configuration DSH actually reads.
 *
 * DSH's compaction trigger is ratio-based, not absolute:
 *
 *     thresholdTokens = floor(min(contextWindow * thresholdRatio, pressureBudget))
 *
 * where `pressureBudget = contextWindow - reservedCompletion - headroomTokens`.
 * The user, however, thinks in absolute tokens ("compact this model at 250k"),
 * and the model's own window makes a single ratio wrong across a mixed catalog.
 * The two views meet exactly: because
 *
 *     contextWindow * (tokens / contextWindow) === tokens
 *
 * a per-model `thresholdRatio` of `tokens / contextWindow` asks for a **fixed**
 * token threshold for that model, with the window cancelling out. That is what
 * {@link compactionPolicy} computes, and it is why the feature is per-model
 * rather than one global percentage.
 *
 * Two guards keep a computed policy from being rejected (or, worse, accepted and
 * then failing at reload):
 *   - the ratio is capped below 1, because DSH reserves completion tokens and
 *     headroom before the pressure budget, and
 *   - `retainRatio` is derived so the verbatim tail is always smaller than the
 *     threshold, which DSH validates at load (`retainTokens < thresholdTokens`).
 *
 * The policy is written by {@link applyCompactionPolicies} through the host's
 * own `configEditor`, which persists the profile patch and reconciles it through
 * the loader — the same path the plugins settings page uses. When that service
 * is absent (a deployment that does not expose it), the caller falls back to
 * showing the exact patch fragment, and nothing is written.
 *
 * @module dsh-prompt-optimizer/compaction
 */

/** Loader entry id of the mounted compaction backend. */
export const COMPACTION_ENTRY_ID = 'compaction-basic'

/** Package name of that backend, used to match an entry that was re-identified. */
export const COMPACTION_PACKAGE = '@deepseek-ai/dsh-compaction-basic'

/** Smallest fixed threshold this plugin will write (tokens). */
export const MIN_COMPACTION_TOKENS = 8_192

/** Largest fixed threshold this plugin will write (tokens). */
export const MAX_COMPACTION_TOKENS = 4_000_000

/**
 * The context window assumed when neither the routing service nor the model
 * adapter declares one.
 *
 * One million is the deliberate answer to "I don't know": the two ZTE gateways
 * advertise no window, so any other fallback would be a guess anyway. The real
 * order of preference — a window the user typed into the settings page, then
 * the routing service's `/v1/models` (which itself prefers the upstream's
 * advertised `context_window`), then the model adapter's declared value, and
 * only then this default — is {@link ContextWindowIndex#resolve}.
 */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000

/** Smallest per-model window the settings page will write (tokens). */
export const MIN_CONTEXT_WINDOW = 1_024

/** Largest per-model window the settings page will write (tokens). */
export const MAX_CONTEXT_WINDOW = 4_000_000

/** How long a resolved window stays cached before the service is asked again (ms). */
export const WINDOW_CACHE_TTL_MS = 300_000

/**
 * Highest threshold ratio written. DSH derives the pressure budget by
 * subtracting the request's completion reservation and `headroomTokens`, so a
 * ratio at 1 would be capped anyway; staying clearly below 1 keeps the computed
 * threshold the one the user asked for.
 */
export const MAX_THRESHOLD_RATIO = 0.95

/** DSH's own default verbatim-tail fraction, used as the ceiling for the derived one. */
export const DEFAULT_RETAIN_RATIO = 0.16

/** Header written before a rendered patch fragment. */
const YAML_HEADER = [
  '# Paste into this DSH profile patch, replacing any earlier compaction-basic row config.',
  '# thresholdRatio = tokens / contextWindow, so each model compacts at the token count below.',
]

/**
 * How many tokens one provider/model is configured to compact at.
 * @typedef {Record<string, number>} CompactionThresholds
 */

/** The `"provider/model"` key both the settings file and the config use. */
export function targetKey(provider, model) {
  return `${provider}/${model}`
}

/** Whether one candidate is a usable fixed threshold. */
export function isCompactionTokens(value) {
  return Number.isSafeInteger(value) && value >= MIN_COMPACTION_TOKENS && value <= MAX_COMPACTION_TOKENS
}

/**
 * Compute one model's `compaction-basic` policy for a fixed token threshold.
 *
 * @param {string} provider - provider route id.
 * @param {string} model - model id.
 * @param {number} tokens - the fixed threshold the user asked for.
 * @param {number} contextWindow - the model's own window, from `llm.resolveModelInfo`.
 * @returns {{ok: true, policy: {provider: string, model: string, thresholdRatio: number, retainRatio: number}, effectiveTokens: number, capped: boolean}|{ok: false, reason: string}} the policy, or why it cannot be expressed.
 */
export function compactionPolicy(provider, model, tokens, contextWindow) {
  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
    return { ok: false, reason: 'route' }
  }
  if (!isCompactionTokens(tokens)) return { ok: false, reason: 'tokens' }
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) return { ok: false, reason: 'context' }
  if (tokens > contextWindow) return { ok: false, reason: 'exceeds-window' }
  const ratio = tokens / contextWindow
  const thresholdRatio = Math.min(ratio, MAX_THRESHOLD_RATIO)
  // The tail must stay under the threshold at load. Half the threshold (never
  // above DSH's own 0.16 default) leaves room for the floor() in both budgets.
  const retainRatio = Math.min(DEFAULT_RETAIN_RATIO, thresholdRatio * 0.5)
  return {
    ok: true,
    policy: { provider, model, thresholdRatio, retainRatio },
    effectiveTokens: Math.floor(contextWindow * thresholdRatio),
    capped: ratio > MAX_THRESHOLD_RATIO,
  }
}

/**
 * Plan the complete `modelPolicies` array for a threshold map.
 *
 * A threshold key is a plain `"provider/model"` string, but a model id may
 * itself contain a `/` (e.g. provider `custom` with model
 * `maas-dsv4/deepseek-v4-flash`), so the provider/model boundary is never
 * recovered by splitting the string. Instead the caller supplies a route
 * resolver that looks each stored key up against the **live model catalog**
 * (the same routes `compaction-basic` will match), so the planned policy always
 * carries the exact provider/model DSH knows. A key that matches no catalog
 * route is reported as skipped rather than silently dropped, so the settings
 * page says which rows are not in effect.
 *
 * Entries are returned in a stable order (the threshold map's key order).
 *
 * @param {CompactionThresholds} thresholds - `"provider/model"` to fixed tokens.
 * @param {(key: string) => {provider: string, model: string, contextWindow: number|null}|null} resolveRoute - catalog-backed lookup for one stored key (null when it matches no live route).
 * @returns {{policies: Array<{provider: string, model: string, thresholdRatio: number, retainRatio: number}>, skipped: Array<{target: string, reason: string}>, capped: string[]}} the plan.
 */
export function planCompactionPolicies(thresholds, resolveRoute) {
  const policies = []
  const skipped = []
  const capped = []
  for (const [key, rawTokens] of Object.entries(thresholds ?? {})) {
    const tokens = Number(rawTokens)
    let route = null
    try {
      route = resolveRoute(key)
    } catch {
      route = null
    }
    if (route === null) {
      skipped.push({ target: key, reason: 'unknown-route' })
      continue
    }
    const result = compactionPolicy(route.provider, route.model, tokens, route.contextWindow)
    if (!result.ok) {
      skipped.push({ target: key, reason: result.reason })
      continue
    }
    if (result.capped) capped.push(key)
    policies.push(result.policy)
  }
  return { policies, skipped, capped }
}

/**
 * Merge freshly planned policies over an existing `modelPolicies` list.
 *
 * A policy for the same provider/model replaces the previous one; every other
 * policy the user configured by hand is preserved, so this plugin owns only the
 * rows it writes.
 * @param {unknown} existing - the current `modelPolicies` (any shape).
 * @param {Array<{provider: string, model: string}>} planned - the planned policies.
 * @returns {Array<object>} the merged list.
 */
export function mergeModelPolicies(existing, planned) {
  const kept = (Array.isArray(existing) ? existing : []).filter((row) => {
    if (typeof row !== 'object' || row === null) return false
    return !planned.some((policy) => policy.provider === row.provider && policy.model === row.model)
  })
  return [...kept, ...planned]
}

/**
 * Render the patch fragment a user would paste when the config editor is not
 * available, or when they want to review the write before it happens.
 * @param {Array<{provider: string, model: string, thresholdRatio: number, retainRatio: number}>} policies - planned policies.
 * @returns {string} a YAML fragment with the `compaction-basic` row.
 */
export function renderCompactionYaml(policies) {
  const lines = [...YAML_HEADER, '- id: ' + COMPACTION_ENTRY_ID, '  config:', '    modelPolicies:']
  if (policies.length === 0) lines.push('      []')
  for (const policy of policies) {
    lines.push(`      - provider: ${JSON.stringify(policy.provider)}`)
    lines.push(`        model: ${JSON.stringify(policy.model)}`)
    lines.push(`        thresholdRatio: ${policy.thresholdRatio}`)
    lines.push(`        retainRatio: ${policy.retainRatio}`)
  }
  return lines.join('\n') + '\n'
}

/**
 * Find the mounted compaction entry among the config editor's addressable rows.
 * @param {Array<object>} entries - `configEditor.entries()`.
 * @returns {object|null} the entry, or null when this deployment does not expose it.
 */
export function findCompactionEntry(entries) {
  if (!Array.isArray(entries)) return null
  const byId = entries.find((entry) => entry?.options?.id === COMPACTION_ENTRY_ID)
  if (byId !== undefined) return byId
  return entries.find((entry) => entry?.options?.name === COMPACTION_PACKAGE) ?? null
}

/**
 * Read one service off a host context by name.
 *
 * `ctx.get(name)` is the only safe way to reach a service this plugin has not
 * declared: cordis **throws** on a bare `ctx.<name>` for an undeclared service
 * ("cannot get property … without inject"), so reading the property first and
 * treating the throw as "service absent" silently disables the feature even
 * where the service exists. The bare read is kept only as a fallback for a
 * context that is not a cordis proxy.
 * @param {object} ctx - host context.
 * @param {string} name - service name.
 * @returns {object|null} the service, or null when it is genuinely absent.
 */
export function serviceOf(ctx, name) {
  if (ctx === null || ctx === undefined) return null
  try {
    if (typeof ctx.get === 'function') {
      const service = ctx.get(name)
      if (service !== null && service !== undefined) return service
    }
  } catch {
    // Fall through: a non-cordis context may still expose the name directly.
  }
  try {
    return ctx[name] ?? null
  } catch {
    return null
  }
}

/**
 * Read `configEditor` off a host context without declaring it as a hard
 * dependency: a deployment without a config editor must still run every other
 * feature, and the caller reports the absence instead of failing activation.
 * @param {object} ctx - host context.
 * @returns {object|null} the service, or null.
 */
export function configEditorOf(ctx) {
  const editor = serviceOf(ctx, 'configEditor')
  if (editor === null) return null
  return typeof editor.entries === 'function' && typeof editor.edit === 'function' ? editor : null
}

/**
 * Write the planned policies onto the mounted compaction entry.
 *
 * The write goes through `configEditor.edit`, which validates the next config,
 * persists the profile patch atomically and reconciles it through the loader —
 * rolling the file back if the loader rejects the change. A failure is returned,
 * never thrown: a settings save must not be able to fail the plugin.
 *
 * @param {object|null} editor - the config editor service.
 * @param {Array<{provider: string, model: string, thresholdRatio: number, retainRatio: number}>} policies - planned policies.
 * @returns {Promise<{ok: boolean, entry: string|null, count: number, code: string|null, message: string|null}>} the outcome.
 */
export async function applyCompactionPolicies(editor, policies) {
  if (editor === null || editor === undefined) {
    return { ok: false, entry: null, count: 0, code: 'unavailable', message: 'configEditor service is not available in this deployment' }
  }
  let entry = null
  try {
    entry = findCompactionEntry(editor.entries())
  } catch (cause) {
    return { ok: false, entry: null, count: 0, code: 'unavailable', message: String(cause?.message ?? cause) }
  }
  if (entry === null) {
    return { ok: false, entry: null, count: 0, code: 'entry-missing', message: `no addressable "${COMPACTION_ENTRY_ID}" entry in this profile` }
  }
  try {
    await editor.edit(entry, (current) => ({
      ...(typeof current === 'object' && current !== null ? current : {}),
      modelPolicies: mergeModelPolicies(current?.modelPolicies, policies),
    }))
    return { ok: true, entry: COMPACTION_ENTRY_ID, count: policies.length, code: null, message: null }
  } catch (cause) {
    return { ok: false, entry: COMPACTION_ENTRY_ID, count: 0, code: 'rejected', message: String(cause?.message ?? cause) }
  }
}

/* ───────────────────────── window lookup ───────────────────────── */

/**
 * Per-route context windows, resolved through a cheap ``/v1/models`` read first
 * and cached, because a settings page can ask for a whole catalog at once.
 *
 * The order that resolves one route's window, most specific first:
 *
 *   1. a window the operator typed into the settings page
 *      (`configuredWindows[provider/model]`) — the only value that is a human
 *      decision about that exact model;
 *   2. the routing service's `/v1/models` (`routerUrl`): the advertised
 *      `context_window` for that model id, which the service itself resolves as
 *      override → the upstream's advertised window → 1M default. This is the
 *      "ask the catalog first" half of the contract;
 *   3. the model adapter's own `llm.resolveModelInfo` metadata (a profile may
 *      declare a window for a provider this plugin does not route through);
 *   4. {@link DEFAULT_CONTEXT_WINDOW}, the 1M default, at which point a model
 *      that advertised nothing still plans a usable compaction policy.
 *
 * The adapter's own default (`DeepSeek`'s llm-pi-ai falls back to 262144 for an
 * undeclared model) is *never* treated as a real window: it is only consulted as
 * a declared value, and the catalog/default run ahead of it.
 */
export class ContextWindowIndex {
  /**
   * @param {object} ctx - host context carrying `llm`.
   * @param {object} [options] - round window sources.
   * @param {{url: () => string}|null} [options.service] - the routing-service client; when null the catalog half is skipped.
   * @param {(() => Record<string, number>)|Record<string, number>|null} [options.configuredWindows] - `"provider/model"` → tokens the user set.
   */
  constructor(ctx, options = {}) {
    this.ctx = ctx
    this.service = options.service ?? null
    this.configured = typeof options.configuredWindows === 'function'
      ? options.configuredWindows
      : options.configuredWindows === undefined || options.configuredWindows === null
        ? null
        : () => options.configuredWindows
    /** @type {Map<string, {at: number, value: number|null}>} */
    this.cache = new Map()
    /** Router `/v1/models` windows, keyed by advertised model id, and when they were read. */
    this.catalog = new Map()
    this.catalogAt = 0
  }

  /** Forget every cached window, so the next resolve re-reads source 1 and 2. */
  refresh() {
    this.cache.clear()
    this.catalog.clear()
    this.catalogAt = 0
  }

  /**
   * The window the routing service advertises for a model id, cached for
   * {@link WINDOW_CACHE_TTL_MS}. A missing or refused service yields nothing, so
   * the caller falls through to sources 3 and 4.
   * @returns {Promise<Map<string, number>>} model id → window, possibly empty.
   */
  async catalogWindows() {
    if (this.service === null || typeof this.service.url !== 'function') return new Map()
    const now = Date.now()
    if (this.catalog.size > 0 || this.catalogAt !== 0) {
      if (now - this.catalogAt < WINDOW_CACHE_TTL_MS) return this.catalog
      this.catalog.clear()
    }
    const out = new Map()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('the routing service is unresponsive')), 1_500)
    if (typeof timer.unref === 'function') timer.unref()
    try {
      const response = await fetch(`${this.service.url()}/v1/models`, { signal: controller.signal })
      if (response?.ok === true) {
        const parsed = await response.json()
        for (const row of Array.isArray(parsed?.data) ? parsed.data : []) {
          const id = typeof row?.id === 'string' ? row.id : ''
          if (id === '' || !Number.isSafeInteger(row.context_window) || row.context_window <= 0) continue
          out.set(id, row.context_window)
        }
      }
    } catch {
      // A routing service that is down must not stall the settings page.
    } finally {
      clearTimeout(timer)
    }
    // Even an empty answer is cached, so a dying service is not re-asked on
    // every row of a whole-catalog resolve.
    this.catalogAt = now
    this.catalog = out
    return out
  }

  /**
   * The context window of one exact route; never null after the default applies.
   * @param {string} provider - provider route id.
   * @param {string} model - model id.
   * @returns {Promise<number>} the window in tokens.
   */
  async resolve(provider, model) {
    const key = targetKey(provider, model)
    const hit = this.cache.get(key)
    if (hit !== undefined && Date.now() - hit.at < WINDOW_CACHE_TTL_MS) return hit.value
    let value = null
    const configured = typeof this.configured === 'function' ? (this.configured() ?? {}) : {}
    const typed = configured[key]
    if (Number.isSafeInteger(typed) && typed > 0) {
      value = typed
    } else {
      const catalog = await this.catalogWindows()
      if (catalog.has(model)) {
        value = catalog.get(model)
      } else if (catalog.has(key)) {
        value = catalog.get(key)
      } else {
        try {
          const lookup = typeof this.ctx?.llm?.resolveModelInfo === 'function'
            ? this.ctx.llm.resolveModelInfo(provider, model)
            : typeof this.ctx?.llm?.resolveModel === 'function'
              ? this.ctx.llm.resolveModel(provider, model)
              : null
          if (lookup !== null) {
            const info = await Promise.race([
              lookup,
              new Promise((resolve) => {
                const timer = setTimeout(() => resolve(null), 1_500)
                if (typeof timer.unref === 'function') timer.unref()
              }),
            ])
            const window = info?.context?.contextWindow
            if (Number.isSafeInteger(window) && window > 0) value = window
          }
        } catch {
          value = null
        }
      }
    }
    if (!(Number.isSafeInteger(value) && value > 0)) value = DEFAULT_CONTEXT_WINDOW
    this.cache.set(key, { at: Date.now(), value })
    return value
  }

  /**
   * Windows for a list of routes, resolved concurrently.
   * @param {Array<{provider: string, model: string}>} routes - routes to look up.
   * @returns {Promise<Map<string, number|null>>} keyed by `"provider/model"`.
   */
  async resolveAll(routes) {
    const entries = await Promise.all(
      routes.map(async ({ provider, model }) => [targetKey(provider, model), await this.resolve(provider, model)]),
    )
    return new Map(entries)
  }
}

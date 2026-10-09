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
 * Entries are returned in a stable order (the threshold map's key order) and a
 * model whose window cannot be resolved is reported as skipped rather than
 * silently dropped, so the settings page can say which rows are not in effect.
 *
 * @param {CompactionThresholds} thresholds - `"provider/model"` to fixed tokens.
 * @param {(provider: string, model: string) => number|null} contextWindowOf - window lookup (null when unknown).
 * @returns {{policies: Array<{provider: string, model: string, thresholdRatio: number, retainRatio: number}>, skipped: Array<{target: string, reason: string}>, capped: string[]}} the plan.
 */
export function planCompactionPolicies(thresholds, contextWindowOf) {
  const policies = []
  const skipped = []
  const capped = []
  for (const [key, rawTokens] of Object.entries(thresholds ?? {})) {
    const slash = key.lastIndexOf('/')
    if (slash <= 0 || slash === key.length - 1) {
      skipped.push({ target: key, reason: 'route' })
      continue
    }
    const provider = key.slice(0, slash)
    const model = key.slice(slash + 1)
    const tokens = Number(rawTokens)
    let window = null
    try {
      window = contextWindowOf(provider, model)
    } catch {
      window = null
    }
    const result = compactionPolicy(provider, model, tokens, window)
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
 * Read `configEditor` off a host context without declaring it as a hard
 * dependency: an undeclared cordis service throws on property access, and a
 * deployment without a config editor must still run every other feature.
 * @param {object} ctx - host context.
 * @returns {object|null} the service, or null.
 */
export function configEditorOf(ctx) {
  try {
    const editor = ctx?.configEditor ?? (typeof ctx?.get === 'function' ? ctx.get('configEditor') : undefined)
    if (editor === null || editor === undefined) return null
    return typeof editor.entries === 'function' && typeof editor.edit === 'function' ? editor : null
  } catch {
    return null
  }
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
 * Per-route context windows, resolved through the runtime's own metadata and
 * cached, because a settings page can ask for a whole catalog at once.
 */
export class ContextWindowIndex {
  /** @param {object} ctx - host context carrying `llm`. */
  constructor(ctx) {
    this.ctx = ctx
    /** @type {Map<string, {at: number, value: number|null}>} */
    this.cache = new Map()
  }

  /**
   * The context window of one exact route, or null when the adapter does not know.
   * @param {string} provider - provider route id.
   * @param {string} model - model id.
   * @returns {Promise<number|null>} the window in tokens.
   */
  async resolve(provider, model) {
    const key = targetKey(provider, model)
    const hit = this.cache.get(key)
    if (hit !== undefined && Date.now() - hit.at < 300_000) return hit.value
    let value = null
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
            setTimeout(() => resolve(null), 1_500)
          }),
        ])
        const window = info?.context?.contextWindow
        if (Number.isSafeInteger(window) && window > 0) value = window
      }
    } catch {
      value = null
    }
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

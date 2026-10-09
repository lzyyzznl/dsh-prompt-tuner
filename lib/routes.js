/**
 * Host route layer under `/dsh-prompt-optimizer`: one JSON envelope family for
 * the composer UI, plus the model catalog, the rewrite call, its streaming
 * twin, and the side-question (`/btw`) family that shares the same machinery.
 *
 * The UI never talks to the LLM itself: the browser posts the draft here, the
 * host resolves the configured route, streams one completion through
 * `ctx.llm`, and answers with the normalized text. That keeps credentials and
 * provider routing in the host, where they already live.
 *
 * The side-question routes are the same call with a different contract: the
 * browser sends the question plus an excerpt of the conversation it already
 * rendered, and the answer is displayed and stored as history — it is never
 * written into the session, because this route talks to `ctx.llm` directly and
 * never to the agent loop.
 *
 * Latency notes (measured with `scripts/bench.mjs` against a live server):
 * provider discovery costs single-digit milliseconds, so the wall clock is
 * entirely model time. Three knobs dominate it, and all three live here:
 *   - `reasoningEffort`: the DeepSeek adapter's default is `high`, i.e. the
 *     model thinks for seconds about a rewriting task and those thinking tokens
 *     are dropped by this plugin. The default here is therefore `off`, with
 *     `auto` (omit the field) and the explicit levels available in Settings.
 *   - the length of the asked-for rewrite: the default optimization prompt
 *     demands a rewrite proportional to the draft, so a two-line draft no
 *     longer expands into a full specification document.
 *   - the output budget: a bounded `maxTokens` keeps a runaway answer from
 *     billing for tokens nobody reads.
 *
 * Failure handling is a fixed ladder, at most three calls per click, each rung
 * chosen by a *structured* signal rather than by matching error text (vendor
 * wording changes; `finish.reason` does not):
 *   rung 1 — the configured effort and the computed output budget;
 *   rung 2 — on `EMPTY_LENGTH` (the budget was eaten before any text) or on a
 *            truncated answer: effort `off` and a tripled budget;
 *   rung 3 — any other failure, or rung 2 failing again: send neither the
 *            effort field nor `maxTokens`, so a gateway that rejects either
 *            parameter cannot fail the click.
 *
 * @module dsh-prompt-optimizer/routes
 */
import { BadRequest, isLoopbackRequest, readJsonBody, writeJson } from './http.js'
import {
  COMPACTION_ENTRY_ID,
  MAX_COMPACTION_TOKENS,
  MIN_COMPACTION_TOKENS,
  ContextWindowIndex,
  applyCompactionPolicies,
  configEditorOf,
  planCompactionPolicies,
  renderCompactionYaml,
} from './compaction.js'
import {
  NOTIFY_BODY_CHARS,
  NOTIFY_TITLE_CHARS,
  notifyPlatform,
  sendNotification,
} from './notify.js'
import {
  AGENT_TEMPLATE,
  AGENT_TEMPLATE_PLACEHOLDER,
  BTW_SYSTEM_PROMPT,
  DEFAULT_SYSTEM_PROMPT,
  MAX_BTW_QUESTION_CHARS,
  MAX_DRAFT_CHARS,
  MAX_SYSTEM_PROMPT_CHARS,
  buildBtwMessages,
  buildBtwThreadAsTurn,
  buildPayload,
  findAssumptions,
  normalizeAnswer,
  styleDirective,
} from './prompt.js'
import {
  APPLY_MODES,
  BTW_CONTEXT_CHOICES,
  BTW_HISTORY_FILE,
  CONFIG_FILE,
  EFFORT_CHOICES,
  REWRITE_ROUTES,
  STYLE_CHOICES,
  appendBtwTurn,
  btwTopics,
  clearBtwTopics,
  readSettings,
  writeSettings,
} from './store.js'

/** Route prefix; the browser posts to the document-relative `dsh-prompt-optimizer/<action>`. */
export const ROUTE_PREFIX = '/dsh-prompt-optimizer'

/**
 * Request body cap for the routes whose payload is bounded by a setting (a
 * draft, a system prompt, a settings patch).
 *
 * The side-question family is deliberately exempt: its body is the session's own
 * record, whose size is the conversation's size, and a byte cap there would be a
 * cap on the context by another name — the exact thing the context contract
 * forbids. `/btw` and `/btw.stream` therefore read the body uncapped; the
 * loopback fence, not the reader, is what bounds who may post.
 */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/** Actions whose body carries the carried conversation record, read uncapped. */
const UNCAPPED_BODY_ACTIONS = new Set(['/btw', '/btw.stream'])

/**
 * Watchdog on the first token: a rewrite that has produced neither text nor
 * reasoning by now is stuck (adapter retry storm, dead gateway), and waiting out
 * the full deadline would only make the button lie about what it is doing.
 */
const FIRST_OUTPUT_TIMEOUT_MS = 45_000

/** Whole-call deadline, watchdog included. */
const OPTIMIZE_TIMEOUT_MS = 120_000

/**
 * Side-question deadlines. Tighter than the rewrite's on purpose: a side
 * question is answered while the main task is running, so a model that needs
 * more than half a minute to say three sentences is not worth the wait — the
 * user's attention is the scarce resource here, not the tokens.
 */
const BTW_FIRST_OUTPUT_TIMEOUT_MS = 25_000
const BTW_TIMEOUT_MS = 60_000

/**
 * Output budget of one side question (tokens). The floor is low because the
 * prompt asks for six lines at most, and the ceiling exists only so a model
 * that ignores that instruction cannot bill for an essay; a boosted retry is
 * clamped by {@link MAX_OUTPUT_TOKENS}, which both calls share.
 */
const MIN_BTW_OUTPUT_TOKENS = 1024

/**
 * Output budget bounds for one rewrite (tokens). The floor is deliberately
 * generous: Chinese text runs close to one token per character, so a 768-token
 * ceiling truncates a ~800-character answer — and a truncated answer costs a
 * whole extra call. `maxTokens` is a ceiling, not a spend, so a high floor is
 * free and a tight one is expensive.
 */
const MIN_OUTPUT_TOKENS = 2048
const MAX_OUTPUT_TOKENS = 8192

/** Model catalog cache lifetime: the picker may reopen repeatedly, a rewrite never needs it twice. */
const CATALOG_TTL_MS = 300_000

/** Bounded wait for adapter-supplied reasoning metadata, and how long its answer is reused. */
const REASONING_LOOKUP_TIMEOUT_MS = 1_500
const REASONING_TTL_MS = 300_000

const OK = (value) => ({ ok: true, value })
const FAIL = (code, message) => ({ ok: false, error: { code, message } })

/**
 * How many output tokens one rewrite of this draft may spend. Bounded on both
 * ends: the floor keeps a short draft from being cut off mid-answer, the ceiling
 * keeps a runaway answer from billing for tokens nobody reads.
 * @param {number} draftChars - trimmed draft length.
 * @returns {number} the budget in tokens.
 */
function outputBudget(draftChars) {
  return Math.min(MAX_OUTPUT_TOKENS, Math.max(MIN_OUTPUT_TOKENS, draftChars * 2 + 512))
}

/**
 * The model the session itself is using, or null when the service cannot answer.
 *
 * This is the zero-configuration path: with no explicit choice saved, the
 * rewrite rides the model the user already selected for the conversation. Any
 * fault here is a capability absence, not an error — the caller falls back to
 * the catalog.
 * @param {object} ctx - host context, optionally carrying `agentDefaultModel`.
 * @returns {{provider: string, model: string}|null} the session's selection.
 */
function sessionSelection(ctx) {
  try {
    // Soft capability: read through the property, then through `ctx.get`, so a
    // deployment without the service (or with a renamed one) degrades to the
    // catalog instead of failing activation.
    const service = ctx.agentDefaultModel
      ?? (typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined)
    const selection = service?.currentSelection?.()
    if (typeof selection?.provider === 'string' && selection.provider !== ''
      && typeof selection?.model === 'string' && selection.model !== '') {
      return { provider: selection.provider, model: selection.model }
    }
  } catch {
    /* an adapter without a default model is a capability, not a fault */
  }
  return null
}

/**
 * Catalog of models the user has actually configured, grouped by provider
 * route. Discovery is per-provider and failure-tolerant: a provider whose
 * models cannot be listed still appears, with its failure surfaced, so the
 * picker never silently hides a configured route.
 * @param {object} ctx - host context carrying the `llm` service.
 * @returns {Promise<Array<{id: string, name: string, models: Array<{id: string, name: string}>, error: string|null}>>} provider groups.
 */
async function loadCatalog(ctx) {
  const providers = typeof ctx.llm?.listProviders === 'function' ? ctx.llm.listProviders() : []
  const groups = []
  for (const provider of providers ?? []) {
    const id = String(provider?.id ?? '')
    if (id === '') continue
    let models = []
    let error = null
    try {
      models = (await ctx.llm.listModels(id)) ?? []
    } catch (cause) {
      error = String(cause?.message ?? cause)
    }
    groups.push({
      id,
      name: String(provider?.name ?? id),
      models: models.map((model) => ({ id: String(model?.id ?? ''), name: String(model?.name ?? model?.id ?? '') }))
        .filter((model) => model.id !== ''),
      error,
    })
  }
  return groups
}

/**
 * Reasoning metadata of one exact route, or null when the adapter does not
 * answer in time (the rewrite then simply sends the configured effort and lets
 * the adapter reject it, which the ladder handles by retrying without the knob).
 *
 * `resolveModelInfo` is adapter code and may do I/O, so this never lets a slow
 * adapter delay a click: the lookup is bounded and its answer is reused.
 * @param {object} ctx - host context carrying the `llm` service.
 * @param {{provider: string, model: string}|null} route - the resolved route.
 * @param {Map<string, {at: number, value: {efforts: string[], defaultEffort: string|null}|null}>} cache - per-route memory.
 * @returns {Promise<{efforts: string[], defaultEffort: string|null}|null>} what the route accepts.
 */
async function resolveReasoning(ctx, route, cache) {
  if (route === null) return null
  const key = `${route.provider}/${route.model}`
  const hit = cache.get(key)
  if (hit !== undefined && Date.now() - hit.at < REASONING_TTL_MS) return hit.value
  // The runtime service answers to `resolveModelInfo` (see the dsh-llm LlmRuntime
  // contract); `resolveModel` is the adapter-level spelling, kept as a fallback so
  // the plugin keeps working if only one of the two is reachable.
  const lookup = typeof ctx.llm?.resolveModelInfo === 'function'
    ? ctx.llm.resolveModelInfo(route.provider, route.model)
    : typeof ctx.llm?.resolveModel === 'function'
      ? ctx.llm.resolveModel(route.provider, route.model)
      : null
  let value = null
  if (lookup !== null) {
    try {
      const info = await Promise.race([
        lookup,
        new Promise((resolve) => {
          setTimeout(() => resolve(null), REASONING_LOOKUP_TIMEOUT_MS)
        }),
      ])
      const efforts = Array.isArray(info?.reasoning?.efforts)
        ? info.reasoning.efforts.map((entry) => String(entry?.id ?? '')).filter((id) => id !== '')
        : []
      value = efforts.length === 0 ? null : { efforts, defaultEffort: info?.reasoning?.defaultEffort ?? null }
    } catch {
      value = null
    }
  }
  cache.set(key, { at: Date.now(), value })
  return value
}

/**
 * Which reasoning effort one rewrite should ask for.
 *
 * `auto` and an unlisted effort both mean "send nothing", except that a known
 * list is honored: when the route advertises efforts and the configured one is
 * not among them, the closest supported choice is used instead of provoking a
 * rejected call. `off` is preferred in that case because this task is a rewrite
 * and thinking tokens are discarded.
 * @param {string} configured - one of {@link EFFORT_CHOICES}.
 * @param {{efforts: string[], defaultEffort: string|null}|null} info - the route's reasoning metadata.
 * @returns {{effort: string|null, degraded: boolean}} the effort to send (`null` omits the field).
 */
function pickEffort(configured, info) {
  const wanted = EFFORT_CHOICES.includes(configured) ? configured : 'off'
  if (wanted === 'auto') return { effort: null, degraded: false }
  if (info === null || info.efforts.includes(wanted)) return { effort: wanted, degraded: false }
  const fallback = info.efforts.includes('off') ? 'off' : info.defaultEffort ?? info.efforts[0] ?? null
  return { effort: fallback, degraded: true }
}

/**
 * Resolve which route one rewrite should use. Precedence: an explicit request,
 * else the saved selection, else — when the user has not chosen a model of their
 * own — the session's own model, else the first advertised model.
 * @param {string|null} wantProvider - provider named by the request or settings.
 * @param {string|null} wantModel - model named by the request or settings.
 * @param {Array<object>} groups - the (cached) model catalog.
 * @param {{provider: string, model: string}|null} preferred - the session's own selection, when it should win over the catalog.
 * @returns {{provider: string, model: string}|null} the route, or null when nothing is configured.
 */
function resolveRoute(wantProvider, wantModel, groups, preferred = null) {
  const has = (provider, model) => groups.some((group) => group.id === provider
    && group.models.some((entry) => entry.id === model))
  if (wantProvider !== null && wantModel !== null && has(wantProvider, wantModel)) {
    return { provider: wantProvider, model: wantModel }
  }
  if (wantProvider === null && wantModel === null && preferred !== null && has(preferred.provider, preferred.model)) {
    return preferred
  }
  const group = wantProvider === null ? undefined : groups.find((entry) => entry.id === wantProvider)
  const pool = group === undefined ? groups : [group]
  for (const candidate of pool) {
    if (candidate.models.length > 0) return { provider: candidate.id, model: candidate.models[0].id }
  }
  for (const candidate of groups) {
    if (candidate.models.length > 0) return { provider: candidate.id, model: candidate.models[0].id }
  }
  return null
}

/**
 * Stream one completion through the LLM service and return its text.
 *
 * Failure classification is structural: `finish.reason.failure.code` (e.g.
 * `EMPTY_LENGTH`) and `finish.reason.kind` are read as fields. Error *text* is
 * carried for the log and the UI, never for a decision.
 * @param {object} ctx - host context carrying the `llm` service.
 * @param {{provider: string, model: string}} route - the resolved route.
 * @param {string} system - the system prompt in force.
 * @param {Array<object>} messages - the complete message list of this call.
 * @param {AbortSignal} signal - caller/route cancellation.
 * @param {string|null} effort - reasoning effort to request, or null to omit the field.
 * @param {number|null} maxTokens - output budget, or null to omit the field.
 * @param {((text: string) => void)|null} onDelta - called with the accumulated text after every delta.
 * @param {() => void} onFirstOutput - called once, when the first text or reasoning delta arrives.
 * @returns {Promise<{ok: true, text: string, firstTextMs: number, reasoningChars: number} | {ok: false, code: string, message: string, failureCode: string|null, firstTextMs: number, reasoningChars: number}>} the outcome.
 */
async function complete(ctx, route, system, messages, signal, effort, maxTokens, onDelta, onFirstOutput) {
  const started = Date.now()
  let text = ''
  let reasoningChars = 0
  let firstTextMs = -1
  let failure = null
  let truncated = false
  try {
    const options = {
      provider: route.provider,
      model: route.model,
      system,
      messages,
      signal,
    }
    if (effort !== null) options.reasoningEffort = effort
    if (maxTokens !== null) options.maxTokens = maxTokens
    const stream = ctx.llm.stream(options)
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta') {
        if (firstTextMs < 0) {
          firstTextMs = Date.now() - started
          onFirstOutput()
        }
        text += chunk.text
        if (onDelta !== null) onDelta(text)
      } else if (chunk?.type === 'reasoning-delta') {
        // Counted only as evidence for `scripts/bench.mjs`: thinking tokens cost
        // wall clock but are never part of the rewrite.
        if (reasoningChars === 0) onFirstOutput()
        reasoningChars += String(chunk.text ?? '').length
      } else if (chunk?.type === 'finish') {
        const kind = chunk.reason?.kind
        if (kind === 'max-tokens') truncated = true
        else if (kind === 'error' || kind === 'aborted') {
          failure = chunk.reason.failure ?? { code: kind, message: kind }
        }
      }
    }
  } catch (cause) {
    failure = { code: 'llm-call-failed', message: String(cause?.message ?? cause) }
  }
  const detail = failure === null ? null : String(failure.code ?? 'llm-error')
  if (truncated) {
    return {
      ok: false,
      code: 'truncated',
      message: '模型输出被长度上限截断，未写入输入框（可换用更强的模型，或把草稿拆小一点重试）',
      failureCode: 'MAX_TOKENS',
      firstTextMs,
      reasoningChars,
    }
  }
  if (failure !== null && text.trim() === '') {
    return {
      ok: false,
      code: String(failure.code ?? 'llm-error'),
      message: String(failure.message ?? 'model call failed'),
      failureCode: detail,
      firstTextMs,
      reasoningChars,
    }
  }
  const normalized = normalizeAnswer(text)
  if (normalized === '') {
    return {
      ok: false,
      code: 'empty-answer',
      message: failure === null ? '模型返回了空内容' : String(failure.message ?? failure.code),
      failureCode: detail,
      firstTextMs,
      reasoningChars,
    }
  }
  return { ok: true, text: normalized, firstTextMs, reasoningChars }
}

/** Whether one failed attempt ran out of budget before producing text. */
function isEmptyLength(result) {
  return result.ok === false && String(result.failureCode ?? '').toUpperCase() === 'EMPTY_LENGTH'
}

/**
 * The fixed three-rung compatibility ladder described in the module header.
 * @param {object} ctx - host context carrying the `llm` service.
 * @param {{provider: string, model: string}} route - the resolved route.
 * @param {string} system - the system prompt in force.
 * @param {Array<object>} messages - the message list of this call.
 * @param {AbortSignal} signal - cancellation.
 * @param {string|null} effort - the requested effort.
 * @param {number} budget - the computed output budget.
 * @param {((text: string) => void)|null} onDelta - streaming sink.
 * @param {() => void} onFirstOutput - first-token watchdog reset.
 * @param {Array<object>|null} alternateMessages - a second message shape for the same call, tried when the first shape cannot be dispatched at all (see the rung below).
 * @returns {Promise<object>} the winning outcome plus what the ladder had to drop.
 */
async function completeWithLadder(ctx, route, system, messages, signal, effort, budget, onDelta, onFirstOutput, alternateMessages = null) {
  let usedEffort = effort
  let usedBudget = budget
  let usedMessages = messages
  let reshaped = false
  let droppedEffort = false
  let boostedBudget = false
  let attempts = 0

  const run = async () => {
    attempts += 1
    return complete(ctx, route, system, usedMessages, signal, usedEffort, usedBudget, onDelta, onFirstOutput)
  }

  let result = await run()

  if (result.ok === false && !signal.aborted && (isEmptyLength(result) || result.code === 'truncated')) {
    // Two failures have a known, cheap remedy and must not cost the effort
    // setting: an empty answer means the ceiling was eaten before any text (go
    // to `off` reasoning — thinking is discarded here anyway — and raise it), a
    // truncated answer means the ceiling was simply too low (keep the effort,
    // just raise it). Sending neither field would let the adapter's default
    // reasoning back in, which is the 10-second answer nobody asked for.
    boostedBudget = true
    usedEffort = 'off'
    usedBudget = Math.min(MAX_OUTPUT_TOKENS, budget * 3)
    result = await run()
  }

  if (result.ok === false && !signal.aborted && alternateMessages !== null) {
    // A failure that produced no text at all can mean the *shape* of the call
    // was rejected before the model ever saw it — an adapter is free to refuse
    // a message list it cannot represent, and DSH then reports it as a terminal
    // error chunk whose message is a raw internal error. Retrying the same call
    // is useless, so the other shape goes in: same question, same context, same
    // history, folded into the one message form no adapter can object to.
    reshaped = true
    usedMessages = alternateMessages
    result = await run()
  }

  if (result.ok === false && !signal.aborted) {
    // Anything still failing — a rejected effort field, a rejected maxTokens, a
    // gateway 400 — is retried once with neither parameter, so a gateway that
    // dislikes either one cannot fail the click.
    droppedEffort = usedEffort !== null
    usedEffort = null
    usedBudget = null
    result = await run()
  }

  return {
    ...result,
    effort: usedEffort,
    budget: usedBudget,
    reshaped: reshaped && result.ok === true,
    effortDropped: droppedEffort && result.ok === true,
    budgetBoosted: boostedBudget && result.ok === true,
    attempts,
  }
}

/**
 * Register every route this plugin owns.
 * @param {object} ctx - host context carrying `webServer` and `llm`.
 * @returns {() => void} disposer removing the route.
 */
export function registerRoutes(ctx) {
  let catalogCache = { at: 0, groups: [] }
  /** Reasoning metadata per resolved route; see {@link resolveReasoning}. */
  const reasoningCache = new Map()

  /** Cached model catalog; the pickers refresh at most once per TTL. */
  const catalog = async (force) => {
    const now = Date.now()
    if (!force && now - catalogCache.at < CATALOG_TTL_MS && catalogCache.groups.length > 0) return catalogCache.groups
    const groups = await loadCatalog(ctx)
    catalogCache = { at: now, groups }
    return groups
  }

  /** Per-route context windows, resolved through the runtime's own metadata. */
  const windows = new ContextWindowIndex(ctx)

  /** Split a `"provider/model"` settings key back into its two halves. */
  const splitTarget = (key) => {
    const slash = key.lastIndexOf('/')
    if (slash <= 0 || slash === key.length - 1) return null
    return { provider: key.slice(0, slash), model: key.slice(slash + 1) }
  }

  /**
   * The compaction plan for the stored thresholds, resolved against each model's
   * live context window. Only configured rows are looked up, so a settings
   * page is not made to pay for the whole catalog.
   * @param {object} settings - the stored settings.
   * @returns {Promise<{policies: Array<object>, skipped: Array<object>, capped: string[], yaml: string}>} the plan.
   */
  const compactionPlan = async (settings) => {
    const routes = Object.keys(settings.compactionTokens ?? {})
      .map(splitTarget)
      .filter((route) => route !== null)
    const info = await windows.resolveAll(routes)
    const plan = planCompactionPolicies(
      settings.compactionTokens,
      (provider, model) => info.get(`${provider}/${model}`) ?? null,
    )
    return {
      policies: plan.policies,
      skipped: plan.skipped,
      capped: plan.capped,
      yaml: renderCompactionYaml(plan.policies),
    }
  }

  /** The view the UI boots from: settings, the built-in default, and the model catalog. */
  const state = async (force) => {
    const settings = readSettings()
    const groups = await catalog(force)
    const preferred = settings.followSessionModel ? sessionSelection(ctx) : null
    const active = resolveRoute(settings.provider, settings.model, groups, preferred)
    const reasoning = await resolveReasoning(ctx, active, reasoningCache)
    // The side-question half resolves its own pair, the same way and with the
    // same fallback, so its tab can show what a question would actually use.
    const btwActive = resolveRoute(settings.btwProvider, settings.btwModel, groups, preferred)
    const btwReasoning = await resolveReasoning(ctx, btwActive, reasoningCache)
    return {
      settings,
      defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
      custom: settings.systemPrompt !== null,
      models: groups.map(({ id, name, models, error }) => ({ id, name, models, error: error ?? null })),
      active,
      sessionModel: preferred,
      reasoning,
      effortChoices: [...EFFORT_CHOICES],
      styleChoices: [...STYLE_CHOICES],
      applyModes: [...APPLY_MODES],
      routes: [...REWRITE_ROUTES],
      // The agent-route template travels with the state so the browser half never
      // holds a second copy of its wording; the placeholder is how it splices.
      agentTemplate: { text: AGENT_TEMPLATE, placeholder: AGENT_TEMPLATE_PLACEHOLDER },
      configFile: CONFIG_FILE,
      limits: { maxDraftChars: MAX_DRAFT_CHARS, maxSystemPromptChars: MAX_SYSTEM_PROMPT_CHARS },
      // The side-question half's own contract. It travels with /state so the
      // browser never keeps a second copy of the caps, and so the settings page
      // can render the question/answer budget without guessing.
      btw: {
        contextTurns: settings.btwContextTurns,
        saveHistory: settings.btwSaveHistory,
        contextTurnChoices: [...BTW_CONTEXT_CHOICES],
        maxQuestionChars: MAX_BTW_QUESTION_CHARS,
        historyFile: BTW_HISTORY_FILE,
        prompt: BTW_SYSTEM_PROMPT,
        // The side-question half's own model and effort, resolved exactly the
        // way the rewrite's are: `active` is the route a question would take
        // right now, and `reasoning` is what that route advertises. They are
        // read from the side-question settings alone, so the 「旁路提问」 tab
        // shows its own choice rather than the rewrite's.
        active: btwActive,
        reasoning: btwReasoning,
      },
      // The compaction half's contract: what this plugin has stored, the bounds
      // it will write, whether the profile's config editor is reachable at all,
      // and the exact patch fragment for the case where it is not.
      compaction: {
        tokens: settings.compactionTokens,
        entryId: COMPACTION_ENTRY_ID,
        limits: { minTokens: MIN_COMPACTION_TOKENS, maxTokens: MAX_COMPACTION_TOKENS },
        configEditor: configEditorOf(ctx) !== null,
        plan: await compactionPlan(settings),
      },
      // The notification half needs no per-conversation state: one switch, and
      // the platform this host would actually dispatch to (null meaning "this
      // host has no desktop to reach", which the settings page says out loud).
      notify: {
        onComplete: settings.notifyOnComplete,
        platform: notifyPlatform(),
        appName: 'DSH',
        limits: { titleChars: NOTIFY_TITLE_CHARS, bodyChars: NOTIFY_BODY_CHARS },
      },
    }
  }

  /**
   * The whole rewrite, shared by the JSON and the streaming route.
   * @param {object} body - decoded request body.
   * @param {{onDelta: ((text: string) => void)|null, signal: AbortSignal|null}} hooks - streaming sink and caller cancellation.
   * @returns {Promise<{status: number, envelope: object}>} the response to write.
   */
  const runOptimize = async (body, hooks) => {
    const settings = readSettings()
    const text = body.text
    if (typeof text !== 'string') throw new BadRequest('text must be a string')
    const draft = text.trim()
    if (draft === '') throw new BadRequest('输入框是空的——先写点内容再优化')
    if (draft.length > MAX_DRAFT_CHARS) {
      throw new BadRequest(`草稿超过 ${MAX_DRAFT_CHARS} 字符上限，先精简再优化`)
    }
    const routeMs = Date.now()
    const groups = await catalog(false)
    const explicit = typeof body.provider === 'string' && body.provider !== ''
      && typeof body.model === 'string' && body.model !== ''
      ? { provider: body.provider, model: body.model }
      : null
    const preferred = settings.followSessionModel ? sessionSelection(ctx) : null
    const route = resolveRoute(
      explicit?.provider ?? settings.provider,
      explicit?.model ?? settings.model,
      groups,
      preferred,
    )
    if (route === null) {
      return {
        status: 200,
        envelope: FAIL('no-model', '没有可用的模型路由：请先在「设置 → 插件优化集合」里选一个模型，或先在会话里选好模型'),
      }
    }
    const info = await resolveReasoning(ctx, route, reasoningCache)
    const configured = typeof body.reasoningEffort === 'string' && EFFORT_CHOICES.includes(body.reasoningEffort)
      ? body.reasoningEffort
      : settings.reasoningEffort
    const picked = pickEffort(configured, info)
    const style = STYLE_CHOICES.includes(body.style) ? body.style : settings.style
    const base = typeof body.systemPrompt === 'string' && body.systemPrompt.trim() !== ''
      ? body.systemPrompt
      : settings.systemPrompt ?? DEFAULT_SYSTEM_PROMPT
    const system = base + styleDirective(style)
    const budget = outputBudget(draft.length)
    /** One user turn: the draft travels delimited, never as an instruction. */
    const messages = [{ role: 'user', content: [{ type: 'text', text: buildPayload(draft) }] }]

    const controller = new AbortController()
    let abortReason = null
    const stop = (reason) => {
      if (abortReason !== null) return
      abortReason = reason
      controller.abort(new Error(reason))
    }
    // A stuck gateway must not hold the button hostage: the watchdog fires only
    // if nothing at all has come back, and is replaced by the whole-call deadline
    // as soon as the model starts talking.
    let watchdog = setTimeout(() => stop('no-output'), FIRST_OUTPUT_TIMEOUT_MS)
    const deadline = setTimeout(() => stop('timeout'), OPTIMIZE_TIMEOUT_MS)
    const onFirstOutput = () => {
      clearTimeout(watchdog)
      watchdog = null
    }
    const external = hooks.signal
    const onExternal = () => stop('cancelled')
    external?.addEventListener('abort', onExternal, { once: true })

    const started = Date.now()
    let result
    try {
      result = await completeWithLadder(
        ctx,
        route,
        system,
        messages,
        controller.signal,
        picked.effort,
        budget,
        hooks.onDelta,
        onFirstOutput,
      )
    } finally {
      clearTimeout(deadline)
      if (watchdog !== null) clearTimeout(watchdog)
      external?.removeEventListener('abort', onExternal)
    }
    const timings = {
      routeMs: started - routeMs,
      totalMs: Date.now() - started,
      firstTextMs: result.firstTextMs,
      reasoningChars: result.reasoningChars,
      attempts: result.attempts,
    }
    if (!result.ok) {
      if (abortReason !== null) {
        const code = abortReason === 'timeout' || abortReason === 'no-output' ? 'timeout' : 'cancelled'
        const message = abortReason === 'no-output'
          ? `等待模型首个输出超过 ${Math.round(FIRST_OUTPUT_TIMEOUT_MS / 1000)} 秒，已放弃（可换模型或降低思考强度）`
          : abortReason === 'timeout'
            ? `改写超过 ${Math.round(OPTIMIZE_TIMEOUT_MS / 1000)} 秒仍未完成，已放弃`
            : '已取消'
        return { status: 200, envelope: { ...FAIL(code, message), timings } }
      }
      return { status: 200, envelope: { ...FAIL(result.code, result.message), timings } }
    }
    const text_ = result.text
    return {
      status: 200,
      envelope: OK({
        text: text_,
        assumptions: findAssumptions(text_).assumptions,
        provider: route.provider,
        model: route.model,
        style,
        effort: result.effort,
        effortDegraded: picked.degraded,
        effortDropped: result.effortDropped,
        budgetBoosted: result.budgetBoosted,
        attempts: result.attempts,
        originalChars: draft.length,
        optimizedChars: text_.length,
        timings,
      }),
    }
  }

  /**
   * One side question, shared by the JSON and the streaming route.
   *
   * This is the rewrite's twin with three deliberate differences: the system
   * prompt is the side-question one, the message list is a thread (history plus
   * the question) instead of a single draft, and the deadlines are tighter
   * because a side question is answered next to running work. Everything else —
   * route resolution, effort negotiation, the ladder, the watchdogs — is shared
   * with the rewrite, so a gateway quirk cannot pass one call and fail the other.
   *
   * The carried context is the one thing this route never inspects: it arrives
   * as the session's own record and is handed to the model exactly as it came —
   * no length cap, no slicing, no per-message filter. That guarantee lives in
   * the browser half's `btwContext`; here it only means not adding one back.
   * @param {object} body - decoded request body (`question`, `context`, `history`).
   * @param {{onDelta: ((text: string) => void)|null, signal: AbortSignal|null}} hooks - streaming sink and caller cancellation.
   * @returns {Promise<{status: number, envelope: object}>} the response to write.
   */
  const runBtw = async (body, hooks) => {
    const settings = readSettings()
    const question = typeof body.question === 'string' ? body.question.trim() : ''
    if (question === '') throw new BadRequest('旁路问题是空的——先写下你想问什么')
    if (question.length > MAX_BTW_QUESTION_CHARS) {
      throw new BadRequest(`旁路问题超过 ${MAX_BTW_QUESTION_CHARS} 字符上限`)
    }
    const context = typeof body.context === 'string' ? body.context.trim() : ''
    /** Prior turns of this thread; an unusable entry is dropped, never fatal. */
    const history = []
    for (const turn of Array.isArray(body.history) ? body.history : []) {
      if (typeof turn?.question !== 'string' || typeof turn?.answer !== 'string') continue
      const prior = turn.question.trim().slice(0, MAX_BTW_QUESTION_CHARS)
      if (prior === '') continue
      history.push({ question: prior, answer: turn.answer.slice(0, 20_000) })
    }

    const routeMs = Date.now()
    const groups = await catalog(false)
    // The side-question half keeps its own model and effort, chosen in the
    // 「旁路提问」 settings tab. Fallback is the rewrite's own: when no
    // side-question model is saved the session's model wins (the same
    // zero-configuration default), and the rewrite's settings are never read
    // here — so tuning one half cannot change the other.
    const preferred = settings.followSessionModel ? sessionSelection(ctx) : null
    const route = resolveRoute(settings.btwProvider, settings.btwModel, groups, preferred)
    if (route === null) {
      return {
        status: 200,
        envelope: FAIL('no-model', '没有可用的模型路由：请先在「设置 → 插件优化集合 → 旁路提问」里选一个模型，或先在会话里选好模型'),
      }
    }
    const info = await resolveReasoning(ctx, route, reasoningCache)
    const picked = pickEffort(settings.btwReasoningEffort, info)
    const budget = Math.min(MAX_OUTPUT_TOKENS, Math.max(MIN_BTW_OUTPUT_TOKENS, question.length * 2 + 512))
    // Two shapes of the same call: the thread as real user/assistant pairs, and
    // the same thread folded into one user turn. The ladder falls back to the
    // second when the first cannot be dispatched (see `completeWithLadder`).
    const messages = buildBtwMessages({
      question,
      context,
      history,
      provider: route.provider,
      model: route.model,
    })
    const foldedMessages = history.length === 0 ? null : buildBtwThreadAsTurn({ question, context, history })

    const controller = new AbortController()
    let abortReason = null
    const stop = (reason) => {
      if (abortReason !== null) return
      abortReason = reason
      controller.abort(new Error(reason))
    }
    let watchdog = setTimeout(() => stop('no-output'), BTW_FIRST_OUTPUT_TIMEOUT_MS)
    const deadline = setTimeout(() => stop('timeout'), BTW_TIMEOUT_MS)
    const onFirstOutput = () => {
      clearTimeout(watchdog)
      watchdog = null
    }
    const external = hooks.signal
    const onExternal = () => stop('cancelled')
    external?.addEventListener('abort', onExternal, { once: true })

    const started = Date.now()
    let result
    try {
      result = await completeWithLadder(
        ctx,
        route,
        BTW_SYSTEM_PROMPT,
        messages,
        controller.signal,
        picked.effort,
        budget,
        hooks.onDelta,
        onFirstOutput,
        foldedMessages,
      )
    } finally {
      clearTimeout(deadline)
      if (watchdog !== null) clearTimeout(watchdog)
      external?.removeEventListener('abort', onExternal)
    }
    const timings = {
      routeMs: started - routeMs,
      totalMs: Date.now() - started,
      firstTextMs: result.firstTextMs,
      reasoningChars: result.reasoningChars,
      attempts: result.attempts,
    }
    if (!result.ok) {
      if (abortReason !== null) {
        const code = abortReason === 'timeout' || abortReason === 'no-output' ? 'timeout' : 'cancelled'
        const message = abortReason === 'no-output'
          ? `等待模型首个输出超过 ${Math.round(BTW_FIRST_OUTPUT_TIMEOUT_MS / 1000)} 秒，已放弃（可换模型或降低思考强度）`
          : abortReason === 'timeout'
            ? `旁路提问超过 ${Math.round(BTW_TIMEOUT_MS / 1000)} 秒仍未完成，已放弃`
            : '已取消'
        return { status: 200, envelope: { ...FAIL(code, message), timings } }
      }
      return { status: 200, envelope: { ...FAIL(result.code, result.message), timings } }
    }
    return {
      status: 200,
      envelope: OK({
        text: result.text,
        question,
        provider: route.provider,
        model: route.model,
        effort: result.effort,
        effortDegraded: picked.degraded,
        reshaped: result.reshaped,
        effortDropped: result.effortDropped,
        budgetBoosted: result.budgetBoosted,
        attempts: result.attempts,
        historyTurns: history.length,
        contextChars: context.length,
        questionChars: question.length,
        timings,
      }),
    }
  }

  /** Server-sent-events header set, mirroring what a proxy must not buffer. */
  const openStream = (res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
  }

  /**
   * Write one SSE frame, honoring backpressure: a slow reader pauses the model
   * stream instead of piling frames up in memory.
   * @param {object} res - the response.
   * @param {string} event - frame name.
   * @param {object} data - JSON payload (encoded, so a delta may contain newlines).
   * @returns {Promise<void>} resolves when the frame is accepted.
   */
  const send = (res, event, data) => new Promise((resolve) => {
    const accepted = res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    if (accepted) resolve()
    else res.once('drain', resolve)
  })

  const handler = async (req, res) => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, FAIL('forbidden', 'loopback-only route'))
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
    if (!contentType.startsWith('application/json')) {
      // Cross-site forms cannot set application/json without a CORS preflight,
      // which the same-origin client always sends.
      res.writeHead(415)
      res.end()
      return
    }
    const action = new URL(req.url ?? '/', 'http://x').pathname.slice(ROUTE_PREFIX.length)
    let body
    try {
      body = await readJsonBody(req, UNCAPPED_BODY_ACTIONS.has(action) ? Number.POSITIVE_INFINITY : MAX_BODY_BYTES)
    } catch (error) {
      writeJson(res, 200, FAIL('bad-request', String(error?.message ?? error)))
      return
    }
    try {
      switch (action) {
        case '/state': {
          writeJson(res, 200, OK(await state(body.refresh === true)))
          return
        }
        case '/save': {
          const patch = {}
          if ('systemPrompt' in body) {
            const value = body.systemPrompt
            if (value !== null && typeof value !== 'string') throw new BadRequest('systemPrompt must be a string or null')
            if (typeof value === 'string' && value.length > MAX_SYSTEM_PROMPT_CHARS) {
              throw new BadRequest(`systemPrompt exceeds ${MAX_SYSTEM_PROMPT_CHARS} characters`)
            }
            // An empty/whitespace-only override means "back to the built-in default".
            patch.systemPrompt = value === null || value.trim() === '' ? null : value
          }
          if ('provider' in body || 'model' in body) {
            const provider = body.provider ?? null
            const model = body.model ?? null
            if (provider !== null && typeof provider !== 'string') throw new BadRequest('provider must be a string or null')
            if (model !== null && typeof model !== 'string') throw new BadRequest('model must be a string or null')
            patch.provider = provider
            patch.model = model
            // Choosing a model by hand ends the "follow the session" default;
            // clearing both back to null restores it.
            if (!('followSessionModel' in body)) {
              patch.followSessionModel = provider === null && model === null
            }
          }
          for (const [field, choices] of [['reasoningEffort', EFFORT_CHOICES], ['style', STYLE_CHOICES], ['applyMode', APPLY_MODES], ['route', REWRITE_ROUTES]]) {
            if (!(field in body)) continue
            if (!choices.includes(body[field])) throw new BadRequest(`${field} must be one of ${choices.join('/')}`)
            patch[field] = body[field]
          }
          if ('followSessionModel' in body) {
            if (typeof body.followSessionModel !== 'boolean') throw new BadRequest('followSessionModel must be a boolean')
            patch.followSessionModel = body.followSessionModel
          }
          if ('shortcut' in body) {
            if (typeof body.shortcut !== 'boolean') throw new BadRequest('shortcut must be a boolean')
            patch.shortcut = body.shortcut
          }
          if ('btwContextTurns' in body) {
            if (!BTW_CONTEXT_CHOICES.includes(body.btwContextTurns)) {
              throw new BadRequest(`btwContextTurns must be one of ${BTW_CONTEXT_CHOICES.join('/')}`)
            }
            patch.btwContextTurns = body.btwContextTurns
          }
          if ('btwSaveHistory' in body) {
            if (typeof body.btwSaveHistory !== 'boolean') throw new BadRequest('btwSaveHistory must be a boolean')
            patch.btwSaveHistory = body.btwSaveHistory
          }
          // The side-question model pair is validated exactly like the rewrite's
          // above: a string or null for each half, and the effort from the same
          // closed list, so no value can reach the settings the routes then
          // misread.
          for (const field of ['btwProvider', 'btwModel']) {
            if (!(field in body)) continue
            const value = body[field]
            if (value !== null && typeof value !== 'string') throw new BadRequest(`${field} must be a string or null`)
            patch[field] = value
          }
          if ('btwReasoningEffort' in body) {
            if (!EFFORT_CHOICES.includes(body.btwReasoningEffort)) {
              throw new BadRequest(`btwReasoningEffort must be one of ${EFFORT_CHOICES.join('/')}`)
            }
            patch.btwReasoningEffort = body.btwReasoningEffort
          }
          // The whole map replaces the stored one, and every row is checked here
          // rather than repaired: an out-of-range threshold is a mistake the
          // settings page can show, and silently dropping it would make the
          // page's own display disagree with the file.
          if ('compactionTokens' in body) {
            const value = body.compactionTokens
            if (typeof value !== 'object' || value === null || Array.isArray(value)) {
              throw new BadRequest('compactionTokens must be an object')
            }
            const rows = {}
            for (const [key, raw] of Object.entries(value)) {
              if (splitTarget(key) === null) throw new BadRequest(`compactionTokens key "${key}" must look like "provider/model"`)
              if (!Number.isSafeInteger(raw) || raw < MIN_COMPACTION_TOKENS || raw > MAX_COMPACTION_TOKENS) {
                throw new BadRequest(
                  `compactionTokens["${key}"] must be an integer between ${MIN_COMPACTION_TOKENS} and ${MAX_COMPACTION_TOKENS} tokens`,
                )
              }
              rows[key] = raw
            }
            patch.compactionTokens = rows
          }
          if ('notifyOnComplete' in body) {
            if (typeof body.notifyOnComplete !== 'boolean') throw new BadRequest('notifyOnComplete must be a boolean')
            patch.notifyOnComplete = body.notifyOnComplete
          }
          writeSettings(patch)
          writeJson(res, 200, OK(await state(false)))
          return
        }
        case '/optimize': {
          const { status, envelope } = await runOptimize(body, { onDelta: null, signal: null })
          writeJson(res, status, envelope)
          return
        }
        case '/optimize.stream': {
          const controller = new AbortController()
          req.on('close', () => controller.abort(new Error('client disconnected')))
          openStream(res)
          let lastSent = 0
          const outcome = await runOptimize(body, {
            // Deltas arrive far faster than a reader needs to see them; one frame
            // per 60ms of growth keeps the wire quiet without looking stalled.
            onDelta: (text) => {
              if (text.length - lastSent < 24) return
              lastSent = text.length
              void send(res, 'delta', { text })
            },
            signal: controller.signal,
          }).catch((error) => ({
            status: 200,
            envelope: FAIL(error instanceof BadRequest ? 'bad-request' : 'internal', String(error?.message ?? error)),
          }))
          if (outcome.envelope.ok === true && outcome.envelope.value.text !== undefined) {
            await send(res, 'delta', { text: outcome.envelope.value.text, final: true })
            // The terminal frame carries the same envelope the JSON route writes,
            // so a client parses one shape on both transports.
            await send(res, 'done', outcome.envelope)
          } else {
            await send(res, 'failed', outcome.envelope)
          }
          res.end()
          return
        }
        case '/btw': {
          const { status, envelope } = await runBtw(body, { onDelta: null, signal: null })
          writeJson(res, status, envelope)
          return
        }
        case '/btw.stream': {
          const controller = new AbortController()
          req.on('close', () => controller.abort(new Error('client disconnected')))
          openStream(res)
          const outcome = await runBtw(body, {
            // Every delta goes out as its own frame: an ephemeral answer is a
            // few sentences, so throttling here would land as two lumps and read
            // as "not streaming". The browser owns the paint throttle.
            onDelta: (text) => {
              void send(res, 'delta', { text })
            },
            signal: controller.signal,
          }).catch((error) => ({
            status: 200,
            envelope: FAIL(error instanceof BadRequest ? 'bad-request' : 'internal', String(error?.message ?? error)),
          }))
          if (outcome.envelope.ok === true && outcome.envelope.value.text !== undefined) {
            await send(res, 'delta', { text: outcome.envelope.value.text, final: true })
            await send(res, 'done', outcome.envelope)
          } else {
            await send(res, 'failed', outcome.envelope)
          }
          res.end()
          return
        }
        case '/btw.history': {
          const settings = readSettings()
          writeJson(res, 200, OK({
            topics: btwTopics(body.sessionId),
            saveHistory: settings.btwSaveHistory,
          }))
          return
        }
        case '/btw.save': {
          const settings = readSettings()
          if (!settings.btwSaveHistory) {
            // Saving is off: answer as if the write happened and the history is
            // empty, so the browser can keep one code path and still show the
            // thread it holds in memory.
            writeJson(res, 200, OK({ topics: [], topicId: '', saved: false, disabled: true }))
            return
          }
          const question = typeof body.question === 'string' ? body.question.trim() : ''
          const answer = typeof body.answer === 'string' ? body.answer.trim() : ''
          if (question === '') throw new BadRequest('question must be a non-empty string')
          if (answer === '') throw new BadRequest('answer must be a non-empty string')
          const written = appendBtwTurn(body.sessionId, {
            topicId: body.topicId,
            question,
            answer,
            at: Number.isFinite(body.at) ? body.at : Date.now(),
          })
          writeJson(res, 200, OK({ ...written, disabled: false }))
          return
        }
        case '/btw.clear': {
          const saved = clearBtwTopics(body.sessionId)
          writeJson(res, 200, OK({ topics: [], saved }))
          return
        }
        case '/compaction.windows': {
          // Only read on demand: resolving a window is adapter I/O, so the tab
          // asks for the whole catalog once when it is opened rather than
          // making every `/state` pay for it.
          const groups = await catalog(body.refresh === true)
          const routes = groups.flatMap((group) =>
            group.models.map((model) => ({ provider: group.id, model: model.id })),
          )
          const info = await windows.resolveAll(routes)
          const settings = readSettings()
          writeJson(res, 200, OK({
            limits: { minTokens: MIN_COMPACTION_TOKENS, maxTokens: MAX_COMPACTION_TOKENS },
            models: routes.map((route) => {
              const key = `${route.provider}/${route.model}`
              return {
                provider: route.provider,
                model: route.model,
                contextWindow: info.get(key) ?? null,
                tokens: settings.compactionTokens[key] ?? null,
              }
            }),
          }))
          return
        }
        case '/compaction.apply': {
          // The one write into DSH's own configuration. It goes through the
          // profile's config editor, which validates the next config, persists
          // the patch atomically and reconciles it through the loader —
          // restoring the file if the loader rejects it. That is why this is an
          // explicit click and not a side effect of saving a threshold.
          const settings = readSettings()
          const plan = await compactionPlan(settings)
          const applied = await applyCompactionPolicies(configEditorOf(ctx), plan.policies)
          ctx.logger?.info?.(
            '[prompt-optimizer] compaction policies: %d written=%s%s',
            plan.policies.length,
            applied.ok,
            applied.message === null ? '' : ` (${applied.message})`,
          )
          writeJson(res, 200, OK({ applied, plan }))
          return
        }
        case '/notify': {
          // One finished conversation, reported by the browser half (which is
          // the side that knows a task ended). The host owns the actual toast
          // because popping a desktop notification is a process-level act.
          if (readSettings().notifyOnComplete !== true) {
            writeJson(res, 200, OK({ sent: false, skipped: 'disabled', platform: notifyPlatform() }))
            return
          }
          const outcome = await sendNotification({
            title: typeof body.title === 'string' ? body.title : '',
            body: typeof body.body === 'string' ? body.body : '',
          })
          if (outcome.ok !== true) {
            ctx.logger?.warn?.('[prompt-optimizer] notification not shown: %s', outcome.error ?? outcome.skipped ?? 'unknown')
          }
          writeJson(res, 200, OK({ sent: outcome.ok === true, ...outcome }))
          return
        }
        case '/notify.test': {
          const outcome = await sendNotification({
            title: 'DSH · 通知测试',
            body: '任务完成通知已开启；这就是它在桌面上出现的样子。',
          })
          writeJson(res, 200, OK({ sent: outcome.ok === true, ...outcome }))
          return
        }
        default:
          res.writeHead(404)
          res.end()
      }
    } catch (error) {
      const message = String(error?.message ?? error)
      ctx.logger?.warn?.('[prompt-optimizer] route %s failed: %s', action, message)
      if (!res.headersSent) {
        writeJson(res, 200, FAIL(error instanceof BadRequest ? 'bad-request' : 'internal', message))
        return
      }
      res.end()
    }
  }

  return ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
}

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
 *   - `reasoningEffort`: a rewrite is always asked to run without thinking
 *     (`off`). The DeepSeek adapter's default is `high`, i.e. the model would
 *     think for seconds about a rewriting task and those thinking tokens would
 *     be dropped by this plugin. There is no setting for it: the side-question,
 *     title and notification halves each own their effort choice, the rewrite
 *     does not.
 *   - the length of the asked-for rewrite: the default optimization prompt
 *     demands a rewrite proportional to the draft, so a two-line draft no
 *     longer expands into a full specification document.
 *   - the output budget: a bounded `maxTokens` keeps a runaway answer from
 *     billing for tokens nobody reads.
 *
 * Failure handling is a fixed ladder, at most three calls per click, each rung
 * chosen by a *structured* signal rather than by matching error text (vendor
 * wording changes; `finish.reason` does not):
 *   rung 1 — the fixed `off` effort and the computed output budget;
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
  ELLIPSIS,
  NOTIFY_BODY_CHARS,
  NOTIFY_MAX_BODY_CHARS,
  NOTIFY_MIN_BODY_CHARS,
  NOTIFY_TITLE_CHARS,
  normalizeNotifyChars,
  notifyPlatform,
  sendNotification,
} from './notify.js'
import {
  NOTIFY_SUMMARY_FALLBACK_BODY,
  NOTIFY_SUMMARY_INPUT_CHARS,
  NOTIFY_SUMMARY_MAX_OUTPUT_TOKENS,
  NOTIFY_SUMMARY_TIMEOUT_MS,
  clampSummary,
  normalizeSummary,
  shrinkSystemPrompt,
  shrinkUserText,
  summaryFits,
  summarySystemPrompt,
  summaryUserText,
} from './notify-summary.js'
import {
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
} from './prompt.js'
import {
  BTW_HISTORY_FILE,
  CONFIG_FILE,
  DEFAULT_EFFORT,
  DEFAULT_RECENT_MESSAGES,
  EFFORT_CHOICES,
  MAX_RECENT_MESSAGES,
  MIN_BTW_CONTEXT_COUNT,
  MIN_RECENT_MESSAGES,
  appendBtwTurn,
  btwTopics,
  clearBtwTopics,
  isBtwContextTurns,
  readSettings,
  writeSettings,
} from './store.js'
import {
  DEFAULT_TITLE_MAX_CHARS,
  DEFAULT_TITLE_REROLL_TURNS,
  MAX_TITLE_MAX_CHARS,
  MAX_TITLE_REROLL_TURNS,
  MIN_TITLE_MAX_CHARS,
  MIN_TITLE_REROLL_TURNS,
  TITLE_MAX_OUTPUT_TOKENS,
  TITLE_PROVIDER_ID,
} from './title.js'

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
 * The conversation excerpt one rewrite carries: the newest `limit` records of
 * what the browser sent, in the order it sent them (flow order, oldest first).
 *
 * The browser half already narrows to the setting before posting; this is the
 * host-side half of the same rule, so the count cannot be raised by a stale page
 * or a hand-made request. A non-array, non-string entries and blanks are ignored
 * rather than rejected: a malformed record must cost its own line, never the
 * rewrite. `limit` of 0 (or a session with no records at all) yields `[]`, and
 * the payload then carries the draft alone.
 * @param {unknown} records - the request's `records`.
 * @param {number} limit - configured record count (0 disables the excerpt).
 * @returns {string[]} the records to frame into the prompt, oldest first.
 */
function recentRecords(records, limit) {
  if (!Number.isSafeInteger(limit) || limit <= 0 || !Array.isArray(records)) return []
  return records
    .filter((record) => typeof record === 'string' && record.trim() !== '')
    .slice(-limit)
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
 * The route one auxiliary title call takes, and the call itself.
 *
 * A session title is generated by the host half's own watcher, not by a route
 * the browser can post to, so this is the one seam that lets that watcher reuse
 * the rewrite's route resolution and its LLM call instead of keeping a second,
 * divergent copy of either. Route precedence is the side-question half's:
 * the title pair chosen in Settings, else the session's own model (when the user
 * has not pinned a rewrite model), else the catalog's first model.
 *
 * The effort is negotiated against whatever the adapter advertises, exactly as
 * the rewrite and side-question paths negotiate theirs: a title call that sends
 * an unsupported level would fail for a reason that has nothing to do with the
 * title. The lookup runs behind its own fresh cache (once per re-summarization,
 * not once per settings read), so no long-lived state is needed here.
 * @param {object} ctx - host context carrying the `llm` service.
 * @param {object} request - one title call.
 * @param {object} request.settings - the stored settings (the title pair and effort are read from here).
 * @param {string} request.system - the system instruction.
 * @param {string} request.text - the framed user turn.
 * @param {AbortSignal} [request.signal] - cancellation.
 * @returns {Promise<{ok: boolean, text?: string, model?: {provider: string, model: string}, code?: string, message?: string}>} the outcome, never a throw.
 */
export async function askTitleModel(ctx, request) {
  const settings = request?.settings ?? {}
  const signal = request?.signal ?? new AbortController().signal
  let route = null
  let result = null
  try {
    const groups = await loadCatalog(ctx)
    const preferred = sessionSelection(ctx)
    route = resolveRoute(settings.titleProvider ?? null, settings.titleModel ?? null, groups, preferred)
    if (route === null) {
      return { ok: false, code: 'no-model', message: '没有可用的模型路由：请先在「设置 → 插件优化集合 → 标题」里选一个模型，或先在会话里选好模型' }
    }
    const info = await resolveReasoning(ctx, route, new Map())
    const picked = pickEffort(settings.titleReasoningEffort, info)
    const messages = [{ role: 'user', content: [{ type: 'text', text: String(request?.text ?? '') }] }]
    result = await complete(ctx, route, String(request?.system ?? ''), messages, signal, picked.effort, TITLE_MAX_OUTPUT_TOKENS, null, () => {})
  } catch (error) {
    return { ok: false, code: 'title-call-failed', message: String(error?.message ?? error) }
  }
  if (result.ok !== true) return { ok: false, code: result.code, message: result.message }
  return { ok: true, text: result.text, model: route }
}

/**
 * The route one notification summary takes, and the call itself.
 *
 * A completion notification carries the assistant's own last message, and that
 * message is not what a toast should say: it is written for someone who is
 * already in the conversation. This condenses it into a line the notification box
 * can show whole, and it is the one model call in this plugin that must not
 * think — the text it summarizes has already been produced once, so thinking
 * tokens would buy nothing and cost seconds on the completion path.
 *
 * Route precedence is the other three halves': the notification pair chosen in
 * Settings, else the session's own model (when the user has not pinned a rewrite
 * model), else the catalog's first model — so the feature works with no
 * configuration at all.
 *
 * The cap is stated to the model and then *measured*. A summary that overshoots
 * is asked for once more against a stricter budget, and only a second overshoot
 * is cut — visibly, with the same `...` contract the mechanical shortening always
 * used — and reported as `truncated`. Every exit says which of the three
 * happened, because "the model chose to fit" and "the plugin made it fit" must not
 * look alike from the outside.
 * @param {object} ctx - host context carrying the `llm` service.
 * @param {object} request - one summary call.
 * @param {object} request.settings - the stored settings (the notification pair and the cap are read from here).
 * @param {string} request.text - the assistant's last message.
 * @param {number} request.maxChars - the stored body cap.
 * @param {AbortSignal} [request.signal] - cancellation and the caller's deadline.
 * @returns {Promise<{ok: boolean, text?: string, model?: {provider: string, model: string}, attempts: number, reasoningEffort?: string|null, fits?: boolean, truncated?: boolean, chars?: number, code?: string, message?: string}>} the outcome, never a throw.
 */
export async function askNotifySummary(ctx, request) {
  const settings = request?.settings ?? {}
  const signal = request?.signal ?? new AbortController().signal
  const source = String(request?.text ?? '')
  const maxChars = normalizeNotifyChars(request?.maxChars)
  if (source.trim() === '') {
    return { ok: false, code: 'empty-source', message: '这一轮没有可总结的回复', attempts: 0 }
  }
  let route = null
  let attempts = 0
  try {
    const groups = await loadCatalog(ctx)
    const preferred = sessionSelection(ctx)
    route = resolveRoute(settings.notifyProvider ?? null, settings.notifyModel ?? null, groups, preferred)
    if (route === null) {
      return {
        ok: false,
        code: 'no-model',
        message: '没有可用的模型路由：请先在「设置 → 插件优化集合 → 通知」里选一个模型，或先在会话里选好模型',
        attempts: 0,
      }
    }
    const info = await resolveReasoning(ctx, route, new Map())
    // Thinking off, always and by construction: `pickEffort('off', …)` is the
    // request, and `reasoningEffort` below reports what was actually sent, so a
    // route that could not honor `off` is visible rather than assumed away.
    const picked = pickEffort('off', info)
    const ask = async (system, turn) => {
      attempts += 1
      return complete(
        ctx,
        route,
        system,
        [{ role: 'user', content: [{ type: 'text', text: turn }] }],
        signal,
        picked.effort,
        NOTIFY_SUMMARY_MAX_OUTPUT_TOKENS,
        null,
        () => {},
      )
    }
    const first = await ask(summarySystemPrompt(maxChars), summaryUserText(source))
    if (first.ok !== true) {
      return { ok: false, code: first.code, message: first.message, model: route, attempts, reasoningEffort: picked.effort }
    }
    let chosen = normalizeSummary(first.text)
    if (chosen !== '' && !summaryFits(chosen, maxChars)) {
      // Asked for "a little shorter", a model shaves a character or two; asked for
      // a number well under the ceiling, it rewrites. This is that second ask.
      const second = await ask(shrinkSystemPrompt(maxChars), shrinkUserText(chosen))
      if (second.ok === true) {
        const shorter = normalizeSummary(second.text)
        if (shorter !== '' && shorter.length < chosen.length) chosen = shorter
      }
    }
    if (chosen === '') {
      return { ok: false, code: 'empty-answer', message: '模型没有返回可用的摘要', model: route, attempts, reasoningEffort: picked.effort }
    }
    const fits = summaryFits(chosen, maxChars)
    const text = fits ? chosen : clampSummary(chosen, maxChars)
    return {
      ok: true,
      text,
      model: route,
      attempts,
      reasoningEffort: picked.effort,
      fits,
      truncated: !fits,
      chars: text.length,
    }
  } catch (error) {
    return { ok: false, code: 'summary-call-failed', message: String(error?.message ?? error), model: route, attempts }
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
    // The rewrite has one model rule and no picker: it rides whatever the
    // session is using, falling back to the catalog's first model. The other
    // three halves prefer the same route but may pin their own.
    const preferred = sessionSelection(ctx)
    const active = resolveRoute(null, null, groups, preferred)
    // The side-question half resolves its own pair, the same way and with the
    // same fallback, so its tab can show what a question would actually use.
    const btwActive = resolveRoute(settings.btwProvider, settings.btwModel, groups, preferred)
    const btwReasoning = await resolveReasoning(ctx, btwActive, reasoningCache)
    // The session-title half does exactly the same with its own pair: an unset
    // title model follows the session (or the catalog), and a pinned one is
    // shown with what it would think at.
    const titleActive = resolveRoute(settings.titleProvider, settings.titleModel, groups, preferred)
    const titleReasoning = await resolveReasoning(ctx, titleActive, reasoningCache)
    // The notification half resolves its own pair the same way. Its effort is not
    // a setting and not worth resolving: a summary is the one call here that is
    // always asked to run without thinking, so only the route is resolved
    // (`askNotifySummary`), and the tab shows the route plus that fixed fact.
    const notifyActive = resolveRoute(settings.notifyProvider, settings.notifyModel, groups, preferred)
    return {
      settings,
      defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
      custom: settings.systemPrompt !== null,
      models: groups.map(({ id, name, models, error }) => ({ id, name, models, error: error ?? null })),
      // What one rewrite would use right now: the session's own model when the
      // host can name it, else the catalog's first. There is nothing to choose
      // here — that is why the settings page has no model row for this feature.
      // Neither the session's model nor a reasoning view travels with it: the
      // browser reads neither, and the rewrite's effort is fixed (`off`), so a
      // per-`/state` adapter lookup here would be spent on nobody.
      active,
      // The effort list the side-question and title tabs render when their route
      // does not advertise one. The rewrite itself has no effort setting.
      effortChoices: [...EFFORT_CHOICES],
      configFile: CONFIG_FILE,
      limits: {
        maxDraftChars: MAX_DRAFT_CHARS,
        maxSystemPromptChars: MAX_SYSTEM_PROMPT_CHARS,
        minRecentMessages: MIN_RECENT_MESSAGES,
        maxRecentMessages: MAX_RECENT_MESSAGES,
        defaultRecentMessages: DEFAULT_RECENT_MESSAGES,
      },
      // The side-question half's own contract. It travels with /state so the
      // browser never keeps a second copy of the caps, and so the settings page
      // can render the question/answer budget without guessing.
      btw: {
        contextTurns: settings.btwContextTurns,
        // The 「最近 N 条」 input's own two facts: the count to show while another
        // mode is active (the memo the store keeps), and the smallest count it
        // accepts. No maximum travels — the count is the user's to type, and a
        // count larger than the session carries all of it, exactly like 「全部」.
        contextCount: settings.btwContextCount,
        minContextCount: MIN_BTW_CONTEXT_COUNT,
        saveHistory: settings.btwSaveHistory,
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
      // The notification half's contract: one switch, the platform this host
      // would actually dispatch to (null meaning "this host has no desktop to
      // reach", which the settings page says out loud), how long a notification
      // may get, and which model condenses the answer into the body. The
      // shortening bound travels with its range so the settings page renders the
      // input without guessing, and the resolved route travels so the tab can
      // show what a summary would actually use before anything is turned on.
      notify: {
        onComplete: settings.notifyOnComplete,
        platform: notifyPlatform(),
        appName: 'DSH',
        // What one summary call is sent with: the route a completion would take
        // right now, and the fixed request this plugin makes — `off`, which is
        // the one part of the contract a user cannot configure, because a
        // thinking summary is pure latency. The route's advertised efforts are
        // not reported: nothing here may pick one.
        active: notifyActive,
        thinking: 'off',
        maxInputChars: NOTIFY_SUMMARY_INPUT_CHARS,
        fallbackBody: NOTIFY_SUMMARY_FALLBACK_BODY,
        limits: {
          titleChars: NOTIFY_TITLE_CHARS,
          bodyChars: settings.notifyMaxChars,
          minBodyChars: NOTIFY_MIN_BODY_CHARS,
          maxBodyChars: NOTIFY_MAX_BODY_CHARS,
          defaultBodyChars: NOTIFY_BODY_CHARS,
          ellipsis: ELLIPSIS,
        },
      },
      // The session-title half's contract: its own model pair (resolved the same
      // way the rewrite's and the side question's are, so the tab can show what a
      // re-summarization would actually use), how often it fires, and how long a
      // title may be. The cap travels with its bounds so the settings page
      // renders the input without guessing, and the provider id travels so the
      // contract stays visible wherever the log is read.
      title: {
        rerollTurns: settings.titleRerollTurns,
        maxChars: settings.titleMaxChars,
        providerId: TITLE_PROVIDER_ID,
        active: titleActive,
        reasoning: titleReasoning,
        limits: {
          minRerollTurns: MIN_TITLE_REROLL_TURNS,
          maxRerollTurns: MAX_TITLE_REROLL_TURNS,
          defaultRerollTurns: DEFAULT_TITLE_REROLL_TURNS,
          minChars: MIN_TITLE_MAX_CHARS,
          maxChars: MAX_TITLE_MAX_CHARS,
          defaultChars: DEFAULT_TITLE_MAX_CHARS,
        },
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
    // One mode: follow the session's model, else the catalog's first. Nothing in
    // the request can override it — there is no model setting for this feature.
    const route = resolveRoute(null, null, groups, sessionSelection(ctx))
    if (route === null) {
      return {
        status: 200,
        envelope: FAIL('no-model', '没有可用的模型路由：本功能跟随当前会话的模型，请先在会话里选好模型'),
      }
    }
    const info = await resolveReasoning(ctx, route, reasoningCache)
    // A rewrite is a comprehension task: `off` is what it always asks for, and a
    // route that cannot honor it degrades through the same pickEffort path.
    const picked = pickEffort(DEFAULT_EFFORT, info)
    const system = settings.systemPrompt ?? DEFAULT_SYSTEM_PROMPT
    const budget = outputBudget(draft.length)
    // The excerpt is the session's own newest records, sent by the browser in
    // flow order. The count is enforced here as well as there: the host takes the
    // last N of what arrived, so a stale page or a hand-made request cannot put
    // more context in than the setting allows. Fewer records than N is normal —
    // a young session simply carries what it has.
    const kept = recentRecords(body.records, settings.recentMessages)
    const context = kept.join('\n')
    /** One user turn: the records first, the draft it rewrites last. */
    const messages = [{ role: 'user', content: [{ type: 'text', text: buildPayload(draft, context) }] }]

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
          ? `等待模型首个输出超过 ${Math.round(FIRST_OUTPUT_TIMEOUT_MS / 1000)} 秒，已放弃（可换一个会话模型再试）`
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
        // How much of the session's own record actually travelled with this
        // request, so "it did not see the earlier message" is answerable from
        // the response rather than from a guess.
        contextMessages: kept.length,
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
    const preferred = sessionSelection(ctx)
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
          // The rewrite has exactly two settings: its prompt and how many of the
          // session's newest records it carries. Everything else about it is
          // fixed (one mode, the session's own model, no thinking), so there is
          // nothing else to accept here — a stray `style` or `provider` in the
          // body is ignored rather than resurrecting a knob that no longer exists.
          if ('recentMessages' in body) {
            if (!Number.isSafeInteger(body.recentMessages)
              || body.recentMessages < MIN_RECENT_MESSAGES
              || body.recentMessages > MAX_RECENT_MESSAGES) {
              throw new BadRequest(
                `recentMessages must be an integer between ${MIN_RECENT_MESSAGES} and ${MAX_RECENT_MESSAGES}`,
              )
            }
            patch.recentMessages = body.recentMessages
          }
          if ('btwContextTurns' in body) {
            if (!isBtwContextTurns(body.btwContextTurns)) {
              throw new BadRequest('btwContextTurns must be "all", 0, or a positive integer')
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
          // Rejected rather than clamped, for the same reason the compaction
          // rows are: a cap the page silently changed under the user would make
          // the input and the file disagree about what was saved.
          if ('notifyMaxChars' in body) {
            if (!Number.isSafeInteger(body.notifyMaxChars)
              || body.notifyMaxChars < NOTIFY_MIN_BODY_CHARS
              || body.notifyMaxChars > NOTIFY_MAX_BODY_CHARS) {
              throw new BadRequest(
                `notifyMaxChars must be an integer between ${NOTIFY_MIN_BODY_CHARS} and ${NOTIFY_MAX_BODY_CHARS}`,
              )
            }
            patch.notifyMaxChars = body.notifyMaxChars
          }
          // The notification half's model pair, validated exactly like the other
          // three halves': a string or null for each end, so no value can reach
          // the settings the summary call then misreads. Its effort is not a
          // setting — thinking is always off there.
          for (const field of ['notifyProvider', 'notifyModel']) {
            if (!(field in body)) continue
            const value = body[field]
            if (value !== null && typeof value !== 'string') throw new BadRequest(`${field} must be a string or null`)
            patch[field] = value
          }
          // The session-title half: its own model pair and effort, validated
          // exactly like the side question's, plus the two numbers that define
          // the feature. Both numbers are rejected rather than clamped, for the
          // same reason the notification cap is — a value the page silently
          // changed under the user would make the input and the file disagree.
          for (const field of ['titleProvider', 'titleModel']) {
            if (!(field in body)) continue
            const value = body[field]
            if (value !== null && typeof value !== 'string') throw new BadRequest(`${field} must be a string or null`)
            patch[field] = value
          }
          if ('titleReasoningEffort' in body) {
            if (!EFFORT_CHOICES.includes(body.titleReasoningEffort)) {
              throw new BadRequest(`titleReasoningEffort must be one of ${EFFORT_CHOICES.join('/')}`)
            }
            patch.titleReasoningEffort = body.titleReasoningEffort
          }
          if ('titleRerollTurns' in body) {
            if (!Number.isSafeInteger(body.titleRerollTurns)
              || body.titleRerollTurns < MIN_TITLE_REROLL_TURNS
              || body.titleRerollTurns > MAX_TITLE_REROLL_TURNS) {
              throw new BadRequest(
                `titleRerollTurns must be an integer between ${MIN_TITLE_REROLL_TURNS} and ${MAX_TITLE_REROLL_TURNS}`,
              )
            }
            patch.titleRerollTurns = body.titleRerollTurns
          }
          if ('titleMaxChars' in body) {
            if (!Number.isSafeInteger(body.titleMaxChars)
              || body.titleMaxChars < MIN_TITLE_MAX_CHARS
              || body.titleMaxChars > MAX_TITLE_MAX_CHARS) {
              throw new BadRequest(
                `titleMaxChars must be an integer between ${MIN_TITLE_MAX_CHARS} and ${MAX_TITLE_MAX_CHARS}`,
              )
            }
            patch.titleMaxChars = body.titleMaxChars
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
          // because popping a desktop notification is a process-level act, and it
          // owns the body too: the answer arrives whole, is condensed to the box
          // by a model (`lib/notify-summary.js`), and only then is dispatched.
          const notifySettings = readSettings()
          if (notifySettings.notifyOnComplete !== true) {
            writeJson(res, 200, OK({ sent: false, skipped: 'disabled', platform: notifyPlatform() }))
            return
          }
          const title = typeof body.title === 'string' ? body.title : ''
          const source = typeof body.body === 'string' ? body.body : ''
          const cap = notifySettings.notifyMaxChars
          // The only body that skips the model is one the browser already marked
          // as "this turn produced no answer": that is a marker the client wrote,
          // not the assistant's words, and summarizing it would dress a non-answer
          // up as an answer. Everything else — every real reply — is condensed
          // first, so the assistant's raw last message never reaches the desktop.
          const asked = body.needsSummary !== false && source.trim() !== ''
          let text = source
          let summary = {
            requested: asked,
            ok: false,
            code: asked ? 'pending' : 'no-answer',
            message: '',
            attempts: 0,
            model: null,
            reasoningEffort: null,
            chars: source.length,
            truncated: false,
          }
          if (asked) {
            const controller = new AbortController()
            const deadline = setTimeout(
              () => controller.abort(new Error('summary deadline')),
              NOTIFY_SUMMARY_TIMEOUT_MS,
            )
            let answer
            try {
              answer = await askNotifySummary(ctx, {
                settings: notifySettings,
                text: source,
                maxChars: cap,
                signal: controller.signal,
              })
            } finally {
              clearTimeout(deadline)
            }
            if (answer.ok === true) {
              text = answer.text
              summary = {
                requested: true,
                ok: true,
                code: 'ok',
                message: '',
                attempts: answer.attempts,
                model: answer.model,
                reasoningEffort: answer.reasoningEffort,
                chars: answer.chars,
                truncated: answer.truncated,
              }
            } else {
              // No summary, and no fallback to the raw answer: a toast that
              // reverted to the last message on failure would make every failure
              // look like a success. It says what happened instead, and the reason
              // travels in the log and in this response.
              text = NOTIFY_SUMMARY_FALLBACK_BODY
              summary = {
                requested: true,
                ok: false,
                code: answer.code,
                message: answer.message,
                attempts: answer.attempts,
                model: answer.model ?? null,
                reasoningEffort: answer.reasoningEffort ?? null,
                chars: text.length,
                truncated: false,
              }
              ctx.logger?.warn?.(
                '[prompt-optimizer] notification summary failed (%s): %s',
                answer.code,
                answer.message,
              )
            }
          }
          const outcome = await sendNotification({ title, body: text }, { bodyChars: cap })
          if (outcome.ok !== true) {
            ctx.logger?.warn?.('[prompt-optimizer] notification not shown: %s', outcome.error ?? outcome.skipped ?? 'unknown')
          } else {
            ctx.logger?.info?.(
              '[prompt-optimizer] notification shown (%d title / %d body chars, summary %s in %d attempt(s)%s)',
              outcome.shown.title.length,
              outcome.shown.body.length,
              summary.ok === true ? `from ${summary.model.provider}/${summary.model.model}` : summary.code,
              summary.attempts,
              summary.truncated === true ? ', cut to fit' : '',
            )
          }
          writeJson(res, 200, OK({ sent: outcome.ok === true, ...outcome, summary }))
          return
        }
        case '/notify.test': {
          // The sample is deliberately longer than the default cap: pressing the
          // button shows the shortening itself, not just that a toast appears.
          const sample = [
            '这是一条测试通知：任务完成后会像这样弹出来。',
            '标题取自会话标题，正文取自本轮回答的摘要，所以你不用切回窗口就知道这一轮跑完没有。',
            '超过设置的长度就以 ... 结尾，通知不会长到遮住桌面，也不会在句子中间无声地断掉；',
            '想多看点就把设置页里的「摘要最多显示字符数」调大，最多 600。',
          ].join('')
          const outcome = await sendNotification(
            { title: 'DSH · 通知测试', body: sample },
            { bodyChars: readSettings().notifyMaxChars },
          )
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

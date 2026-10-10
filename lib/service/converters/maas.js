/**
 * The ZTE MaaS converter: makes the two gateway routes speak
 * `api.deepseek.com`'s contract.
 *
 * ## The two dialects
 *
 * The northbound half of the service promises the reference contract — whatever
 * a caller would send to `https://api.deepseek.com/v1` and whatever it would get
 * back. The gateway speaks a near-miss of it, because it is vLLM behind a
 * proxy: right shape, different words in a handful of places, and a great deal of
 * extra furniture. This module is the dictionary between them, applied in
 * {@link toUpstream} on the way out and in {@link fromUpstream} /
 * {@link fromUpstreamChunk} on the way back.
 *
 * The differences being closed, each measured against both endpoints rather than
 * inferred from documentation:
 *
 * | axis | reference contract | ZTE gateway | here |
 * | --- | --- | --- | --- |
 * | thinking switch | `thinking: {type: 'disabled'\\|'enabled', budget_tokens}` + `effort` | ignores `thinking`; honours `reasoning_effort` (`none` really is off) | translated to `reasoning_effort` |
 * | output cap | `max_tokens` (counts reasoning) | honours both | `max_completion_tokens` folded into `max_tokens` |
 * | `response_format: json_object` | 400 unless the prompt contains "json" | accepted unconditionally | the reference precondition is enforced |
 * | thinking text | `message.reasoning_content` | `message.reasoning` | renamed |
 * | reasoning tokens | always reported | reported on `co-claw`, absent on `deepseek-v4-flash` | reported as `0` only when nothing was thought |
 * | `model` echo | the requested name | the backend's name (`DeepSeek-V4-Flash-0731`) | the requested name |
 * | usage detail | `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` | `prompt_tokens_details.created_cache_tokens` etc. | derived to the reference pair |
 * | `system_fingerprint` | present | absent | synthesised from the backend string |
 * | error envelope | `{error: {message, type, param, code}}` | vLLM's own envelope | rewritten by status |
 *
 * Everything not on that list is passed through. That is the point of a
 * converter rather than a parser: it rewrites what it knows, and hands the rest
 * on untouched, so a field the gateway adds tomorrow reaches the caller instead
 * of being dropped by a schema that did not anticipate it.
 *
 * ## What is deliberately *not* faked
 *
 * Two decisions are worth stating because they look like omissions:
 *
 *   - **A default is not invented.** When a caller sends no thinking control at
 *     all, nothing is sent upstream and the gateway's own default applies — which
 *     is "on" for `co-claw` and "off" for `deepseek-v4-flash`. Forcing one value
 *     would make the two MaaS routes agree with each other while disagreeing with
 *     the reference contract's *own* default, and would override a caller who
 *     left the field out on purpose. What the converter guarantees is that an
 *     explicit control means the same thing on both sides.
 *   - **A number is not invented.** `deepseek-v4-flash` does not report
 *     `reasoning_tokens`. When thinking produced no text, `0` is not a guess but
 *     the truth, and it is reported; when thinking produced text and no count was
 *     sent, the field is omitted rather than estimated. A caller who needs the
 *     count can read `co-claw`, which does send it.
 *
 * ## Enforcing a limitation is the job
 *
 * The `response_format` precondition above is the one place this converter is
 * *stricter* than the thing it adapts. That is intentional: a caller writing one
 * client against both endpoints would otherwise discover the difference in
 * production, and the gateway's leniency would become a dependency with no
 * contract behind it. Rejecting early, with the reference contract's own error
 * shape, is the honest spelling of "consistent".
 *
 * @module dsh-prompt-tuner/service/converters/maas
 */
import { defineConverter } from './registry.js'

/** The gateway's host, matched so a renamed provider id still finds this converter. */
const GATEWAY_HOST_PATTERN = /(^|\.)maas-apigateway\.dt\.zte\.com\.cn$/i

/** Provider ids this converter claims even when their base URL is still blank. */
const KNOWN_PROVIDER_IDS = Object.freeze(['maas-dsv4', 'maas-coclaw'])

/**
 * Thinking levels the gateway accepts on `reasoning_effort`, cheapest first.
 *
 * `none` is the only value that actually turns thinking off; the rest select a
 * depth. There is no budget parameter on this gateway, so a reference-contract
 * `budget_tokens` is mapped to the nearest level by {@link levelForBudget}.
 */
const LEVELS = Object.freeze(['none', 'low', 'medium', 'high', 'max'])

/**
 * Response fields the gateway always emits and the reference contract does not.
 *
 * They are dropped outright rather than only when empty, because their presence
 * is the difference a client can observe: a caller that starts reading
 * `prompt_token_ids` because it happened to be there has quietly left the
 * contract. The signal-bearing fields the gateway parks at `null`
 * (`refusal`, `annotations`, `function_call`) are handled separately in
 * {@link normalizeMessage}, where a non-null value is kept.
 */
const TOP_LEVEL_NOISE = Object.freeze([
  'service_tier',
  'prompt_logprobs',
  'prompt_token_ids',
  'prompt_text',
  'kv_transfer_params',
  'ec_transfer_params',
  'metrics',
])

/**
 * Choice-level extras with no reference-contract counterpart.
 *
 * Unlike the top-level list these are dropped even when they carry a value:
 * `stop_reason` duplicates `finish_reason` in the gateway's own vocabulary, and
 * exposing both would invite a caller to depend on a field the reference
 * contract cannot honour.
 */
const CHOICE_NOISE = Object.freeze(['stop_reason', 'token_ids', 'routed_experts'])

/**
 * A stable `created` stamp for synthesised `/v1/models` entries.
 *
 * The reference contract stamps each model with a creation time; a synthesised
 * list needs *a* value, and a constant is better than a clock reading because two
 * calls a second apart must not disagree about when a model was created.
 */
const MODEL_CREATED = 1_767_225_600

/** Official error `type`/`code` pairs, by HTTP status. */
const ERROR_BY_STATUS = Object.freeze({
  400: { type: 'invalid_request_error', code: 'invalid_request_error' },
  401: { type: 'authentication_error', code: 'invalid_api_key' },
  402: { type: 'insufficient_quota', code: 'insufficient_quota' },
  403: { type: 'permission_error', code: 'permission_denied' },
  404: { type: 'not_found_error', code: 'not_found' },
  405: { type: 'invalid_request_error', code: 'method_not_allowed' },
  408: { type: 'timeout_error', code: 'request_timeout' },
  409: { type: 'conflict_error', code: 'conflict' },
  413: { type: 'invalid_request_error', code: 'request_too_large' },
  422: { type: 'invalid_request_error', code: 'unprocessable_entity' },
  429: { type: 'rate_limit_error', code: 'rate_limit_exceeded' },
  500: { type: 'server_error', code: 'internal_server_error' },
  502: { type: 'server_error', code: 'bad_gateway' },
  503: { type: 'server_error', code: 'service_unavailable' },
  504: { type: 'server_error', code: 'gateway_timeout' },
})

/** Whether a value carries anything a caller could act on. */
function isPresent(value) {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value !== ''
  if (Array.isArray(value)) return value.length > 0
  return true
}

/** Whether a provider route belongs to this converter. */
function match(route) {
  const provider = route?.provider
  if (provider === undefined || provider === null) return false
  const baseURL = typeof provider.baseURL === 'string' ? provider.baseURL : ''
  if (baseURL !== '') {
    try {
      if (GATEWAY_HOST_PATTERN.test(new URL(baseURL).hostname)) return true
    } catch {
      // A base URL that does not parse is the config page's problem, not this
      // matcher's; fall through to the id check so a half-entered provider still
      // reads as claimed rather than as "no converter".
    }
  }
  return KNOWN_PROVIDER_IDS.includes(provider.id)
}

/**
 * The nearest gateway thinking level for a reference-contract token budget.
 * @param {number} budget - `thinking.budget_tokens`.
 * @returns {string} one of {@link LEVELS} except `none`.
 */
function levelForBudget(budget) {
  if (!Number.isFinite(budget) || budget <= 0) return 'none'
  if (budget <= 1_024) return 'low'
  if (budget <= 4_096) return 'medium'
  if (budget <= 16_384) return 'high'
  return 'max'
}

/** Coerce one level string, tolerating the reference contract's own spellings. */
function normalizeLevel(value) {
  if (typeof value !== 'string') return null
  const level = value.trim().toLowerCase()
  if (level === '') return null
  if (level === 'none' || level === 'off' || level === 'disabled') return 'none'
  // `minimal` is OpenAI's spelling for the cheapest non-zero level; the gateway
  // has no such word, and `low` is the same intent.
  if (level === 'minimal') return 'low'
  if (level === 'xhigh' || level === 'maximum') return 'max'
  return LEVELS.includes(level) ? level : null
}

/**
 * Resolve the thinking control a caller expressed, in whichever of the reference
 * contract's two spellings they used.
 *
 * `thinking` wins over `effort` when both appear, and an explicit
 * `reasoning_effort` is honoured as-is — it is already the wire form, and the
 * gateway understands it, so re-encoding it through `thinking` would only lose
 * information.
 * @param {object} body - the northbound request body.
 * @returns {string|null} the level to send, or `null` to send nothing.
 */
function resolveEffort(body) {
  const thinking = body?.thinking
  if (typeof thinking === 'object' && thinking !== null) {
    const kind = typeof thinking.type === 'string' ? thinking.type.trim().toLowerCase() : ''
    if (kind === 'disabled' || kind === 'off') return 'none'
    const level = normalizeLevel(thinking.effort) ?? normalizeLevel(body.effort)
    if (level !== null) return level
    if (Number.isFinite(thinking.budget_tokens)) return levelForBudget(thinking.budget_tokens)
    if (kind === 'enabled' || kind === 'on') return 'high'
    return null
  }
  const level = normalizeLevel(body?.effort)
  if (level !== null) return level
  return normalizeLevel(body?.reasoning_effort)
}

/**
 * True when every text a request carries mentions "json".
 *
 * The reference contract's documented precondition for `json_object` is checked
 * against the prompt's own words, so a caller cannot be told `json_object` will
 * work and then get a 400 from the endpoint they migrated from.
 * @param {unknown} messages - the request's messages.
 * @returns {boolean} whether something in the prompt says "json".
 */
function mentionsJson(messages) {
  if (!Array.isArray(messages)) return false
  const seen = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    const content = message.content
    if (typeof content === 'string') seen.push(content)
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (part === null || typeof part !== 'object') continue
        if (typeof part.text === 'string') seen.push(part.text)
      }
    }
  }
  return /json/i.test(seen.join('\n'))
}

/**
 * Reference-contract request → gateway request.
 *
 * @param {object} body - the parsed northbound body.
 * @param {{route: {provider: object, model: string}, requestedModel: string}} ctx - the resolved route.
 * @returns {object} the body to send upstream.
 * @throws {ConversionError} when the request would be rejected by the reference contract itself.
 */
function toUpstream(body, ctx) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ConversionError(400, 'the request body must be a JSON object')
  }
  const out = { ...body }

  // The gateway routes by URL path and ignores the model name, but sending the
  // row's model keeps the wire readable and matches what a direct caller does.
  out.model = ctx?.route?.model ?? out.model

  const effort = resolveEffort(body)
  if (effort !== null) out.reasoning_effort = effort
  // Dropped after translation: `thinking` and `effort` are the reference
  // contract's spelling and the gateway would silently ignore them, so leaving
  // them in would put two contradictory switches on one body.
  delete out.thinking
  delete out.effort

  // The gateway honours both spellings; the reference contract honours
  // `max_tokens` and merely accepts `max_completion_tokens` without enforcing it,
  // so folding one into the other is what makes a cap actually cap.
  if (out.max_completion_tokens !== undefined && out.max_tokens === undefined) {
    out.max_tokens = out.max_completion_tokens
  }
  delete out.max_completion_tokens

  const responseFormat = out.response_format
  if (typeof responseFormat === 'object' && responseFormat !== null && responseFormat.type === 'json_object') {
    if (!mentionsJson(body.messages)) {
      throw new ConversionError(
        400,
        'response_format type json_object requires the word "json" somewhere in the messages; '
        + 'the reference contract rejects this request and so does this route',
      )
    }
  }

  if (out.stream === true && (out.stream_options === undefined || out.stream_options === null)) {
    // Asking for usage on the terminal chunk is what lets the response carry the
    // same accounting in streaming and non-streaming mode; a caller who already
    // chose is left alone.
    out.stream_options = { include_usage: true }
  }
  return out
}

/** Drop keys outright: the reference contract has no counterpart for them. */
function dropKeys(target, keys) {
  for (const key of keys) delete target[key]
}

/**
 * Reference-contract usage block from the gateway's.
 * @param {unknown} usage - the gateway's `usage`.
 * @param {number} reasoningChars - how much thinking text the answer carried.
 * @returns {object|undefined} the normalized usage, or undefined when absent.
 */
function normalizeUsage(usage, reasoningChars) {
  if (typeof usage !== 'object' || usage === null) return undefined
  const out = {}
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    if (Number.isFinite(usage[key])) out[key] = usage[key]
  }
  const details = typeof usage.prompt_tokens_details === 'object' && usage.prompt_tokens_details !== null
    ? usage.prompt_tokens_details
    : null
  const cached = Number.isFinite(details?.cached_tokens) ? details.cached_tokens : null
  // The reference contract's `prompt_tokens_details` holds exactly one field. The
  // gateway's extra counters (`created_cache_tokens`, `multimodal_tokens`) are
  // real measurements with no counterpart there; they are dropped rather than
  // forwarded, because a client written against one contract must not be able to
  // start depending on the other's extras by accident.
  if (cached !== null) out.prompt_tokens_details = { cached_tokens: cached }
  // The reference contract reports the cache split at the top level as well; both
  // numbers are derivable from the hit count, so both are supplied.
  if (cached !== null && Number.isFinite(out.prompt_tokens)) {
    out.prompt_cache_hit_tokens = cached
    out.prompt_cache_miss_tokens = Math.max(0, out.prompt_tokens - cached)
  } else if (Number.isFinite(usage.prompt_cache_hit_tokens)) {
    out.prompt_cache_hit_tokens = usage.prompt_cache_hit_tokens
    if (Number.isFinite(usage.prompt_cache_miss_tokens)) out.prompt_cache_miss_tokens = usage.prompt_cache_miss_tokens
  }
  const completionDetails = {}
  const reported = usage.completion_tokens_details?.reasoning_tokens
  if (Number.isFinite(reported)) completionDetails.reasoning_tokens = reported
  else if (reasoningChars === 0) completionDetails.reasoning_tokens = 0
  if (Object.keys(completionDetails).length > 0) out.completion_tokens_details = completionDetails
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Reference-contract message from the gateway's.
 * @param {unknown} message - the gateway's `choices[].message`.
 * @returns {object} the normalized message.
 */
function normalizeMessage(message) {
  const input = typeof message === 'object' && message !== null ? message : {}
  const out = { role: typeof input.role === 'string' ? input.role : 'assistant' }
  // `reasoning_content` is read first so a route that already speaks the
  // reference contract is not damaged by running through the converter.
  const reasoning = isPresent(input.reasoning_content) ? input.reasoning_content : input.reasoning
  if (isPresent(input.content)) out.content = input.content
  else if (isPresent(reasoning)) out.content = ''
  if (isPresent(reasoning)) out.reasoning_content = reasoning
  if (isPresent(input.tool_calls)) out.tool_calls = input.tool_calls
  if (isPresent(input.refusal)) out.refusal = input.refusal
  if (isPresent(input.annotations)) out.annotations = input.annotations
  if (isPresent(input.function_call)) out.function_call = input.function_call
  return out
}

/**
 * Reference-contract streaming delta from the gateway's.
 * @param {unknown} delta - the gateway's `choices[].delta`.
 * @returns {object} the normalized delta.
 */
function normalizeDelta(delta) {
  const input = typeof delta === 'object' && delta !== null ? delta : {}
  const out = {}
  if (isPresent(input.role)) out.role = input.role
  const reasoning = isPresent(input.reasoning_content) ? input.reasoning_content : input.reasoning
  if (isPresent(reasoning)) out.reasoning_content = reasoning
  if (input.content !== undefined && input.content !== null) out.content = input.content
  if (isPresent(input.tool_calls)) out.tool_calls = input.tool_calls
  if (isPresent(input.function_call)) out.function_call = input.function_call
  if (isPresent(input.refusal)) out.refusal = input.refusal
  return out
}

/**
 * How much thinking text a message carried, for the reasoning-token fallback.
 * @param {unknown} value - a message or delta.
 * @returns {number} the character count.
 */
function reasoningCharsOf(value) {
  const input = typeof value === 'object' && value !== null ? value : {}
  const text = isPresent(input.reasoning_content) ? input.reasoning_content : input.reasoning
  return typeof text === 'string' ? text.length : 0
}

/**
 * Count thinking text across a finish payload's choices, including every chunk
 * seen so far — the caller passes the running total in `ctx.reasoningChars`.
 * @param {object} ctx - the call context.
 * @returns {number} the running total.
 */
function runningReasoningChars(ctx) {
  return Number.isFinite(ctx?.reasoningChars) ? ctx.reasoningChars : 0
}

/**
 * Gateway JSON response → reference-contract response.
 * @param {object} payload - the gateway's response body.
 * @param {object} ctx - the call context.
 * @returns {object} the normalized response.
 */
function fromUpstream(payload, ctx) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return payload
  const out = {}
  for (const [key, value] of Object.entries(payload)) {
    if (TOP_LEVEL_NOISE.includes(key)) continue
    out[key] = value
  }
  const choices = Array.isArray(payload.choices) ? payload.choices : []
  let reasoningChars = 0
  out.choices = choices.map((choice, index) => {
    const input = typeof choice === 'object' && choice !== null ? choice : {}
    reasoningChars += reasoningCharsOf(input.message)
    const normalized = { index: Number.isFinite(input.index) ? input.index : index }
    normalized.message = normalizeMessage(input.message)
    for (const key of ['finish_reason', 'logprobs']) {
      if (key in input) normalized[key] = input[key]
    }
    dropKeys(normalized, CHOICE_NOISE)
    return normalized
  })
  out.model = ctx?.requestedModel ?? out.model
  // The gateway reports the backend's build string instead of a fingerprint; it
  // is opaque by contract, so the backend string is a truer value than nothing.
  if (!isPresent(out.system_fingerprint)) {
    const backend = typeof payload.system_fingerprint === 'string' ? payload.system_fingerprint : backendOf(payload, ctx)
    if (backend !== null) out.system_fingerprint = backend
  }
  const usage = normalizeUsage(payload.usage, reasoningChars)
  if (usage !== undefined) out.usage = usage
  else delete out.usage
  return out
}

/**
 * A fingerprint for a route that sent none.
 *
 * The gateway reports the backend's own model name instead of a build
 * fingerprint, and both MaaS routes can report the same one, so the provider id
 * is mixed in: two routes that front different vLLM builds then get values a
 * caller can tell apart and pin, which is all the reference contract's opaque
 * `system_fingerprint` is for.
 * @param {object} payload - the gateway's response body.
 * @param {object} ctx - the call context.
 * @returns {string|null} an opaque fingerprint, or null.
 */
function backendOf(payload, ctx) {
  const raw = typeof payload?.model_version === 'string' ? payload.model_version : ''
  const model = raw !== '' ? raw : typeof payload?.model === 'string' ? payload.model : ''
  const provider = typeof ctx?.route?.provider?.id === 'string' ? ctx.route.provider.id : ''
  const parts = [provider, model].filter((part) => part !== '')
  if (parts.length === 0) return null
  return `fp_${parts.join('_').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)}`
}

/**
 * One gateway SSE data object → one reference-contract chunk.
 *
 * Returns `null` for a frame that carries nothing after normalization — a role
 * ping, or a usage-only frame with no choices — so callers can forward only what
 * actually says something.
 * @param {object} chunk - one parsed `data:` payload.
 * @param {object} ctx - the call context.
 * @returns {object|null} the normalized chunk, or null to drop it.
 */
function fromUpstreamChunk(chunk, ctx) {
  if (typeof chunk !== 'object' || chunk === null || Array.isArray(chunk)) return chunk
  const out = {}
  for (const [key, value] of Object.entries(chunk)) {
    if (TOP_LEVEL_NOISE.includes(key)) continue
    out[key] = value
  }
  if (out.object === undefined) out.object = 'chat.completion.chunk'
  const choices = Array.isArray(chunk.choices) ? chunk.choices : []
  let reasoningChars = 0
  out.choices = choices.map((choice, index) => {
    const input = typeof choice === 'object' && choice !== null ? choice : {}
    reasoningChars += reasoningCharsOf(input.delta)
    const normalized = { index: Number.isFinite(input.index) ? input.index : index }
    if (input.delta !== undefined) normalized.delta = normalizeDelta(input.delta)
    for (const key of ['finish_reason', 'logprobs']) {
      if (key in input) normalized[key] = input[key]
    }
    dropKeys(normalized, CHOICE_NOISE)
    return normalized
  })
  out.model = ctx?.requestedModel ?? out.model
  if (out.usage !== undefined) {
    const usage = normalizeUsage(chunk.usage, reasoningChars + runningReasoningChars(ctx))
    if (usage === undefined) delete out.usage
    else out.usage = usage
  }
  if (out.choices.length === 0 && out.usage === undefined) return null
  return out
}

/**
 * Gateway error → reference-contract error.
 * @param {{status: number, body: object|null}} failure - what came back.
 * @param {object} ctx - the call context.
 * @returns {{status: number, body: object}} the response to send northbound.
 */
function errorBody(failure, ctx) {
  const status = Number.isFinite(failure?.status) && failure.status >= 400 ? failure.status : 502
  const mapped = ERROR_BY_STATUS[status]
    ?? (status >= 500
      ? { type: 'server_error', code: 'internal_server_error' }
      : { type: 'invalid_request_error', code: 'invalid_request_error' })
  const upstream = failure?.body
  const candidate = upstream?.error?.message ?? upstream?.error?.detail ?? upstream?.message ?? upstream?.detail
  const message = typeof candidate === 'string' && candidate.trim() !== ''
    ? candidate.trim()
    : `the ${ctx?.route?.provider?.id ?? 'upstream'} route answered HTTP ${status}`
  return { status, body: { error: { message, type: mapped.type, param: null, code: mapped.code } } }
}

/**
 * `/v1/models` entries for the routes this converter claims.
 *
 * The gateway has no `/models` endpoint (it answers 404), which is the one piece
 * of the reference contract's surface it simply cannot supply; synthesising the
 * list from the configured providers is what makes a discovery-based client work
 * against it at all.
 * @param {object} ctx - `{providers: object}`.
 * @returns {Array<object>} OpenAI-shaped model entries.
 */
function listModels(ctx) {
  const providers = ctx?.providers ?? {}
  const out = []
  const seen = new Set()
  for (const provider of Object.values(providers)) {
    if (typeof provider !== 'object' || provider === null) continue
    let claimed = false
    const models = Array.isArray(provider.models) && provider.models.length > 0 ? provider.models : []
    for (const model of models) {
      if (!match({ provider, model })) continue
      claimed = true
      if (seen.has(model)) continue
      seen.add(model)
      out.push({ id: model, object: 'model', created: MODEL_CREATED, owned_by: provider.id })
    }
    if (claimed && models.length === 0) {
      if (seen.has(provider.id)) continue
      seen.add(provider.id)
      out.push({ id: provider.id, object: 'model', created: MODEL_CREATED, owned_by: provider.id })
    }
  }
  return out
}

/**
 * A request that cannot be expressed in the reference contract, raised where the
 * converter can still answer cleanly instead of sending a request it knows will
 * behave differently upstream.
 */
export class ConversionError extends Error {
  /**
   * @param {number} status - the HTTP status to answer with.
   * @param {string} message - the caller-facing explanation.
   */
  constructor(status, message) {
    super(message)
    this.name = 'ConversionError'
    this.status = status
    this.body = { error: { message, type: 'invalid_request_error', param: null, code: 'invalid_request_error' } }
  }
}

/** The converter, as the registry wants it. */
export const maasConverter = defineConverter({
  id: 'maas',
  label: 'ZTE MaaS → api.deepseek.com 契约',
  match,
  toUpstream,
  fromUpstream,
  fromUpstreamChunk,
  errorBody,
  listModels,
})

export default maasConverter

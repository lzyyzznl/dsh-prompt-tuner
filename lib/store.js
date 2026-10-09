/**
 * Plugin-owned durable settings: the rewrite's prompt and model route, the
 * side-question half's own pair and context contract, the per-model fixed
 * compaction thresholds, and the completion notifications (their switch, and how
 * much of an answer one may show).
 *
 * Stored as one JSON file under the DSH home (the convention the other
 * local-profile plugins use), written atomically so a crash mid-write cannot
 * leave a half file behind. Every read tolerates a missing, unreadable, or
 * malformed file by falling back to defaults: settings must never be able to
 * break plugin activation.
 *
 * @module dsh-prompt-optimizer/store
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isCompactionTokens } from './compaction.js'
import { NOTIFY_BODY_CHARS, normalizeNotifyChars } from './notify.js'

/** DSH home; DSH_HOME wins over homedir() because the two can differ in deployments. */
export const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

/** Absolute path of this plugin's settings file. */
export const CONFIG_FILE = join(DSH_HOME, 'prompt-optimizer.json')

/**
 * Absolute path of the side-question history file.
 *
 * Kept apart from {@link CONFIG_FILE} on purpose: settings are a handful of
 * scalars a human edits in the settings page, while this file is append-only
 * conversation data the browser writes through `/btw.save`. One malformed file
 * must never be able to take the other down, so the two never share a document.
 */
export const BTW_HISTORY_FILE = join(DSH_HOME, 'prompt-tuner-btw.json')

/**
 * The default, and the widest, answer to "how much history does a side question
 * carry": every message the session holds.
 */
export const BTW_CONTEXT_ALL = 'all'

/**
 * How much conversation history one side question may carry as context.
 *
 * The default is {@link BTW_CONTEXT_ALL}: a side question is only worth asking
 * if the model can see what the session has been saying, and the browser reads
 * that transcript from a snapshot the shell has already rendered, so carrying
 * all of it costs nothing extra on this machine. `0` stays a first-class choice
 * (a context-free question, exactly like the rewrite half), and the counts
 * narrow the excerpt on purpose rather than as a hidden cap.
 */
export const BTW_CONTEXT_CHOICES = Object.freeze([BTW_CONTEXT_ALL, 0, 4, 8, 16])

/**
 * Caps on the side-question history file. Every list is bounded so a long-lived
 * profile cannot grow this file without limit; the oldest entry is dropped
 * first, and a turn's stored answer is truncated rather than rejected (the
 * answer was already delivered on screen by then).
 */
export const BTW_LIMITS = Object.freeze({
  /** Topics kept per session. */
  topicsPerSession: 20,
  /** Sessions kept at all, newest first. */
  sessions: 50,
  /** What one stored answer may occupy (characters). */
  turnChars: 20_000,
})

/**
 * Reasoning effort the rewrite call asks for. `auto` omits the field and lets
 * the adapter's configured default apply — on this harness that default is
 * `high`, which spends seconds on thinking tokens the plugin then discards, so
 * the plugin ships `off` as its default and exposes the whole list in Settings.
 */
export const EFFORT_CHOICES = Object.freeze(['auto', 'off', 'low', 'high', 'max'])

/**
 * The effort a setting starts at: `off`.
 *
 * Both halves ship this default, so "not set" means the same thing on either
 * side — the field is sent as `off` rather than omitted.
 */
export const DEFAULT_EFFORT = 'off'

/**
 * How far one rewrite may depart from the draft's own shape. Each style is a
 * short directive appended to the optimization prompt, so a style never
 * replaces the user's custom prompt — it specializes it.
 */
export const STYLE_CHOICES = Object.freeze(['standard', 'slim', 'structured', 'expand'])

/** How an answer reaches the composer: straight in, or held in the review panel. */
export const APPLY_MODES = Object.freeze(['auto', 'review'])

/**
 * Who does the rewriting. `plugin` calls a model from here; `agent` writes a
 * polish template into the composer and lets the session's own agent rewrite it
 * with the full conversation in hand (no model call from this plugin at all).
 */
export const REWRITE_ROUTES = Object.freeze(['plugin', 'agent'])

/**
 * Cap on how many per-model compaction thresholds the settings file may hold.
 * One row per configured model, so this only bounds a hand-edited document.
 */
export const COMPACTION_MAX_ROWS = 50

/** Settings as the routes consume them (nulls mean "not chosen / use default"). */
export const DEFAULT_SETTINGS = Object.freeze({
  /** Custom optimization prompt; null means the built-in default is in force. */
  systemPrompt: null,
  /** Provider route of the optimization model; null means "pick the first available". */
  provider: null,
  /** Model id of the optimization model; null means "pick the first available". */
  model: null,
  /** One of {@link EFFORT_CHOICES}. */
  reasoningEffort: DEFAULT_EFFORT,
  /**
   * Zero-config default: with no explicit model saved, ask the session's own
   * selected model first (`ctx.agentDefaultModel.currentSelection()`), which is
   * what the user is already paying for and already trusts. Picking a model in
   * Settings clears this.
   */
  followSessionModel: true,
  /** One of {@link STYLE_CHOICES}. */
  style: 'standard',
  /** One of {@link APPLY_MODES}. */
  applyMode: 'auto',
  /** One of {@link REWRITE_ROUTES}. */
  route: 'plugin',
  /** Whether Alt+O triggers a rewrite while the composer has focus. */
  shortcut: true,
  /** Which messages a `/btw` side question carries: {@link BTW_CONTEXT_ALL}, `0`, or one of {@link BTW_CONTEXT_CHOICES}. */
  btwContextTurns: BTW_CONTEXT_ALL,
  /** Whether `/btw` answers are written to the side-question history file. */
  btwSaveHistory: true,
  /**
   * Provider route of the side-question model; null means "not chosen". The
   * side-question half keeps its own model so a side question can ride a
   * different route from the rewrite without either setting touching the other.
   */
  btwProvider: null,
  /** Model id of the side-question model; null means "not chosen". */
  btwModel: null,
  /** One of {@link EFFORT_CHOICES}; the effort one side question asks for. */
  btwReasoningEffort: DEFAULT_EFFORT,
  /**
   * Fixed compaction threshold per model, keyed `"provider/model"`: the token
   * count at which DSH should compact that model's conversation.
   *
   * Kept per model on purpose. DSH's own knob is a ratio of the model's context
   * window, and a mixed catalog has no single correct ratio — the same 250k is
   * a sane threshold on a 1M-token model and larger than the window itself on a
   * 128k one. The routes translate each row into the ratio DSH needs (see
   * `lib/compaction.js`); an empty map means this plugin configures nothing and
   * DSH's own defaults stay in force.
   */
  compactionTokens: {},
  /**
   * Whether a desktop notification is shown when a conversation task finishes.
   * One switch for the whole feature: the body is built from the finished
   * answer and the title from the session, so there is nothing else to choose.
   */
  notifyOnComplete: true,
  /**
   * How many characters of that notification's body may reach the desktop.
   *
   * The summary is the finished answer's text, which can be thousands of
   * characters; a toast shows a handful of lines. The host folds the body to one
   * line and shortens it with `...` at this cap ({@link normalizeNotifyChars}
   * keeps a hand-edited file inside the accepted range). Only the length is
   * configurable on purpose — what the notification *says* is fixed: the session
   * title and this turn's answer.
   */
  notifyMaxChars: NOTIFY_BODY_CHARS,
})

/** One boolean field, or the default when absent/not a boolean. */
function booleanOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** One value from a closed list, or the default. */
function oneOf(value, choices, fallback) {
  return choices.includes(value) ? value : fallback
}

/** One short string field, or null when absent/blank/oversized. */
function nullableString(value, maxChars) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > maxChars) return null
  return trimmed
}

/**
 * One compaction-threshold map, repaired rather than rejected.
 *
 * A settings file is a document a human can edit; one malformed row must not
 * cost the user the other rows or the plugin's activation. Unusable rows are
 * dropped, and the map is bounded so a hand-written file cannot make the
 * settings page enumerate forever.
 * @param {unknown} value - the stored `compactionTokens`.
 * @returns {Record<string, number>} `"provider/model"` to a usable token count.
 */
function compactionTokensOr(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out = {}
  for (const [key, raw] of Object.entries(value)) {
    if (Object.keys(out).length >= COMPACTION_MAX_ROWS) break
    if (typeof key !== 'string' || key.length === 0 || key.length > 200) continue
    const slash = key.lastIndexOf('/')
    if (slash <= 0 || slash === key.length - 1) continue
    const tokens = Number(raw)
    if (!isCompactionTokens(tokens)) continue
    out[key] = tokens
  }
  return out
}

/**
 * Read the stored settings.
 * @returns {typeof DEFAULT_SETTINGS} settings with defaults applied.
 */
export function readSettings() {
  let raw
  try {
    raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SETTINGS }
  return {
    systemPrompt: nullableString(raw.systemPrompt, 20_000),
    provider: nullableString(raw.provider, 200),
    model: nullableString(raw.model, 200),
    reasoningEffort: oneOf(raw.reasoningEffort, EFFORT_CHOICES, DEFAULT_SETTINGS.reasoningEffort),
    followSessionModel: booleanOr(raw.followSessionModel, DEFAULT_SETTINGS.followSessionModel),
    style: oneOf(raw.style, STYLE_CHOICES, DEFAULT_SETTINGS.style),
    applyMode: oneOf(raw.applyMode, APPLY_MODES, DEFAULT_SETTINGS.applyMode),
    route: oneOf(raw.route, REWRITE_ROUTES, DEFAULT_SETTINGS.route),
    shortcut: booleanOr(raw.shortcut, DEFAULT_SETTINGS.shortcut),
    btwContextTurns: oneOf(raw.btwContextTurns, BTW_CONTEXT_CHOICES, DEFAULT_SETTINGS.btwContextTurns),
    btwSaveHistory: booleanOr(raw.btwSaveHistory, DEFAULT_SETTINGS.btwSaveHistory),
    btwProvider: nullableString(raw.btwProvider, 200),
    btwModel: nullableString(raw.btwModel, 200),
    btwReasoningEffort: oneOf(raw.btwReasoningEffort, EFFORT_CHOICES, DEFAULT_SETTINGS.btwReasoningEffort),
    compactionTokens: compactionTokensOr(raw.compactionTokens),
    notifyOnComplete: booleanOr(raw.notifyOnComplete, DEFAULT_SETTINGS.notifyOnComplete),
    notifyMaxChars: normalizeNotifyChars(raw.notifyMaxChars, DEFAULT_SETTINGS.notifyMaxChars),
  }
}

/**
 * Merge a patch into the stored settings and persist atomically.
 * @param {object} patch - fields to write; `undefined` keeps the current value, an explicit null clears it.
 * @returns {typeof DEFAULT_SETTINGS} the settings after the write.
 */
export function writeSettings(patch) {
  const current = readSettings()
  const next = { ...current }
  if ('systemPrompt' in patch) {
    const value = patch.systemPrompt
    next.systemPrompt = value === null || value === '' ? null : String(value).slice(0, 20_000)
  }
  if ('provider' in patch) next.provider = patch.provider === null ? null : nullableString(patch.provider, 200)
  if ('model' in patch) next.model = patch.model === null ? null : nullableString(patch.model, 200)
  if ('reasoningEffort' in patch) {
    next.reasoningEffort = oneOf(patch.reasoningEffort, EFFORT_CHOICES, DEFAULT_SETTINGS.reasoningEffort)
  }
  if ('followSessionModel' in patch) {
    next.followSessionModel = booleanOr(patch.followSessionModel, DEFAULT_SETTINGS.followSessionModel)
  }
  if ('style' in patch) next.style = oneOf(patch.style, STYLE_CHOICES, DEFAULT_SETTINGS.style)
  if ('applyMode' in patch) next.applyMode = oneOf(patch.applyMode, APPLY_MODES, DEFAULT_SETTINGS.applyMode)
  if ('route' in patch) next.route = oneOf(patch.route, REWRITE_ROUTES, DEFAULT_SETTINGS.route)
  if ('shortcut' in patch) next.shortcut = booleanOr(patch.shortcut, DEFAULT_SETTINGS.shortcut)
  if ('btwContextTurns' in patch) {
    next.btwContextTurns = oneOf(patch.btwContextTurns, BTW_CONTEXT_CHOICES, DEFAULT_SETTINGS.btwContextTurns)
  }
  if ('btwSaveHistory' in patch) next.btwSaveHistory = booleanOr(patch.btwSaveHistory, DEFAULT_SETTINGS.btwSaveHistory)
  if ('btwProvider' in patch) next.btwProvider = patch.btwProvider === null ? null : nullableString(patch.btwProvider, 200)
  if ('btwModel' in patch) next.btwModel = patch.btwModel === null ? null : nullableString(patch.btwModel, 200)
  if ('btwReasoningEffort' in patch) {
    next.btwReasoningEffort = oneOf(patch.btwReasoningEffort, EFFORT_CHOICES, DEFAULT_SETTINGS.btwReasoningEffort)
  }
  // A full map replaces the stored one, so clearing a row is `{ ...rest }` with
  // that key absent rather than a per-row delete protocol.
  if ('compactionTokens' in patch) next.compactionTokens = compactionTokensOr(patch.compactionTokens)
  if ('notifyOnComplete' in patch) {
    next.notifyOnComplete = booleanOr(patch.notifyOnComplete, DEFAULT_SETTINGS.notifyOnComplete)
  }
  if ('notifyMaxChars' in patch) {
    next.notifyMaxChars = normalizeNotifyChars(patch.notifyMaxChars, DEFAULT_SETTINGS.notifyMaxChars)
  }
  mkdirSync(dirname(CONFIG_FILE), { recursive: true })
  const tmp = `${CONFIG_FILE}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, CONFIG_FILE)
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* the temp file is already gone */
    }
    throw error
  }
  return next
}

/* ───────────────────────── side-question history ───────────────────────── */

/**
 * One side-question topic: the turns of one `/btw` panel conversation.
 *
 * A follow-up extends the topic it belongs to rather than starting a new one,
 * which is what makes the stored history read like the panel did: one question
 * thread with its answers, in order.
 * @typedef {{id: string, at: number, turns: Array<{q: string, a: string, at: number}>}} BtwTopic
 */

/** An empty history document. */
function emptyHistory() {
  return { version: 1, sessions: {} }
}

/** One bounded, trimmed string, or ''. */
function boundedText(value, maxChars) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed
}

/** A usable session id, or null. */
function sessionIdOr(value) {
  const id = boundedText(value, 200)
  return id === '' ? null : id
}

/**
 * Read the side-question history. A missing, unreadable, or malformed file is
 * an empty history — history must never be able to break a chat.
 * @returns {{version: number, sessions: Record<string, {updatedAt: number, topics: BtwTopic[]}>}} the document.
 */
export function readBtwHistory() {
  let raw
  try {
    raw = JSON.parse(readFileSync(BTW_HISTORY_FILE, 'utf8'))
  } catch {
    return emptyHistory()
  }
  if (typeof raw !== 'object' || raw === null || typeof raw.sessions !== 'object' || raw.sessions === null) {
    return emptyHistory()
  }
  /** @type {Record<string, {updatedAt: number, topics: BtwTopic[]}>} */
  const sessions = {}
  for (const [id, entry] of Object.entries(raw.sessions)) {
    if (sessionIdOr(id) === null || typeof entry !== 'object' || entry === null) continue
    const topics = []
    for (const topic of Array.isArray(entry.topics) ? entry.topics : []) {
      if (typeof topic !== 'object' || topic === null) continue
      const turns = []
      for (const turn of Array.isArray(topic.turns) ? topic.turns : []) {
        if (typeof turn !== 'object' || turn === null) continue
        const q = boundedText(turn.q, 2_000)
        const a = boundedText(turn.a, BTW_LIMITS.turnChars)
        if (q === '' && a === '') continue
        turns.push({ q, a, at: Number.isFinite(turn.at) ? turn.at : 0 })
      }
      if (turns.length === 0) continue
      topics.push({
        id: boundedText(topic.id, 64) || `t${topics.length + 1}`,
        at: Number.isFinite(topic.at) ? topic.at : 0,
        turns,
      })
    }
    if (topics.length === 0) continue
    sessions[id] = { updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0, topics }
  }
  return { version: 1, sessions }
}

/**
 * Persist the history document atomically. Failures are swallowed and reported
 * through the return value: the answer the user asked for has already been
 * delivered, so a full or read-only disk must not turn that into an error.
 * @param {{version: number, sessions: object}} state - the document to write.
 * @returns {boolean} whether it reached the disk.
 */
export function writeBtwHistory(state) {
  const tmp = `${BTW_HISTORY_FILE}.tmp-${process.pid}`
  try {
    mkdirSync(dirname(BTW_HISTORY_FILE), { recursive: true })
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, BTW_HISTORY_FILE)
    return true
  } catch {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* the temp file is already gone */
    }
    return false
  }
}

/** Topics of one session, newest last. */
export function btwTopics(sessionId) {
  const id = sessionIdOr(sessionId)
  if (id === null) return []
  return readBtwHistory().sessions[id]?.topics ?? []
}

/**
 * Drop the oldest topics and sessions until both caps hold.
 * @param {{sessions: Record<string, {updatedAt: number, topics: BtwTopic[]}>}} state - the document, mutated in place.
 */
function pruneHistory(state) {
  for (const entry of Object.values(state.sessions)) {
    if (entry.topics.length > BTW_LIMITS.topicsPerSession) {
      entry.topics = entry.topics.slice(entry.topics.length - BTW_LIMITS.topicsPerSession)
    }
  }
  const ids = Object.keys(state.sessions)
  if (ids.length <= BTW_LIMITS.sessions) return
  ids
    .sort((a, b) => state.sessions[b].updatedAt - state.sessions[a].updatedAt)
    .slice(BTW_LIMITS.sessions)
    .forEach((id) => {
      delete state.sessions[id]
    })
}

/**
 * Append one question/answer turn to a session's history, extending an existing
 * topic when `topicId` names one and starting a new topic otherwise.
 * @param {string} sessionId - session the turn belongs to.
 * @param {object} turn - `topicId` (optional), `question`, `answer`, `at`.
 * @returns {{topicId: string, topics: BtwTopic[], saved: boolean}} the topic written to and the session's topics.
 */
export function appendBtwTurn(sessionId, turn) {
  const id = sessionIdOr(sessionId)
  const question = boundedText(turn?.question, 2_000)
  const answer = boundedText(turn?.answer, BTW_LIMITS.turnChars)
  if (id === null || question === '') return { topicId: '', topics: [], saved: false }
  const at = Number.isFinite(turn?.at) ? turn.at : Date.now()
  const state = readBtwHistory()
  const entry = state.sessions[id] ?? { updatedAt: at, topics: [] }
  const wanted = boundedText(turn?.topicId, 64)
  let topic = wanted === '' ? undefined : entry.topics.find((candidate) => candidate.id === wanted)
  if (topic === undefined) {
    topic = { id: `t${at.toString(36)}${entry.topics.length.toString(36)}`, at, turns: [] }
    entry.topics.push(topic)
  }
  topic.turns.push({ q: question, a: answer, at })
  entry.updatedAt = at
  state.sessions[id] = entry
  pruneHistory(state)
  const saved = writeBtwHistory(state)
  return { topicId: topic.id, topics: entry.topics.slice(entry.topics.length - BTW_LIMITS.topicsPerSession), saved }
}

/**
 * Forget one session's side-question history.
 * @param {string} sessionId - session to clear.
 * @returns {boolean} whether the write reached the disk.
 */
export function clearBtwTopics(sessionId) {
  const id = sessionIdOr(sessionId)
  if (id === null) return false
  const state = readBtwHistory()
  if (!(id in state.sessions)) return true
  delete state.sessions[id]
  return writeBtwHistory(state)
}

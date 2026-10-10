/**
 * Plugin-owned durable settings: the rewrite's prompt and how much of the
 * conversation it carries, the side-question half's own model pair and context
 * contract, the per-model fixed compaction thresholds, the session-title
 * refresher (its own model, how often it re-summarizes, and how long a title
 * may be), and the completion notifications (their switch, the model that
 * condenses one answer into the toast's body, and how much of that body may
 * show).
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
import { isCompactionTokens, MAX_CONTEXT_WINDOW, MIN_CONTEXT_WINDOW } from './compaction.js'
import { NOTIFY_BODY_CHARS, normalizeNotifyChars } from './notify.js'
import { OUTPUT_LANGUAGES } from './prompt.js'
import {
  DEFAULT_TITLE_MAX_CHARS,
  DEFAULT_TITLE_REROLL_TURNS,
  normalizeTitleMaxChars,
  normalizeTitleRerollTurns,
} from './title.js'

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
 * (a context-free question, exactly like the rewrite half), and a count narrows
 * the excerpt on purpose rather than as a hidden cap.
 *
 * A count is whatever the user types: any positive integer is accepted, and
 * there is no upper bound to enforce. Asking for more records than the session
 * holds carries all of them, which is exactly what {@link BTW_CONTEXT_ALL}
 * already means — so a cap here would be a secret the setting does not need.
 */
export const MIN_BTW_CONTEXT_COUNT = 1

/**
 * The count the 「最近 N 条」 input starts at, and the value its memo falls back
 * to when the stored number is missing or unusable.
 */
export const DEFAULT_BTW_CONTEXT_COUNT = 8

/**
 * One accepted side-question context setting.
 *
 * `'all'` carries every record, `0` carries none, and any positive safe integer
 * carries that many of the newest records. Everything else — a negative number,
 * a fraction, an unrelated string, null — is repaired to `fallback`: a settings
 * file is a document a human can edit, and one bad value there must not cost the
 * user the rest of their settings.
 * @param {unknown} value - the stored or patched `btwContextTurns`.
 * @param {string|number} fallback - value to use when absent or unusable.
 * @returns {string|number} `'all'`, `0`, or a positive integer count.
 */
export function normalizeBtwContextTurns(value, fallback = BTW_CONTEXT_ALL) {
  if (value === BTW_CONTEXT_ALL) return BTW_CONTEXT_ALL
  if (!Number.isSafeInteger(value)) return fallback
  if (value === 0) return 0
  return value >= MIN_BTW_CONTEXT_COUNT ? value : fallback
}

/**
 * Whether a value is one the context setting may hold.
 *
 * The predicate the `/save` route validates with, kept beside the normalizer so
 * the accepted set is stated once: `'all'`, `0`, or any positive safe integer.
 * @param {unknown} value - a requested `btwContextTurns`.
 * @returns {boolean} true when the value is acceptable as written.
 */
export function isBtwContextTurns(value) {
  return value === BTW_CONTEXT_ALL || (Number.isSafeInteger(value) && value >= 0)
}

/**
 * The remembered count behind the 「最近 N 条」 input.
 *
 * The active value stops being a count the moment the user picks 「全部」 or
 * 「不带」, and the input should still show the number they typed when they come
 * back, so the last count chosen is remembered here. It is not a second source
 * of truth: {@link readSettings} and {@link writeSettings} both make it follow
 * the active value whenever that value *is* a count.
 * @param {unknown} value - the stored `btwContextCount`.
 * @param {number} fallback - value to use when absent or unusable.
 * @returns {number} an integer of at least {@link MIN_BTW_CONTEXT_COUNT}.
 */
export function normalizeBtwContextCount(value, fallback = DEFAULT_BTW_CONTEXT_COUNT) {
  if (!Number.isSafeInteger(value) || value < MIN_BTW_CONTEXT_COUNT) return fallback
  return value
}

/**
 * The count to report for a given active value: a positive count *is* the
 * remembered one, so a file that names only one of the two still reads back with
 * the number it names.
 * @param {string|number} turns - the already-normalized `btwContextTurns`.
 * @param {unknown} stored - the raw stored `btwContextCount`.
 * @returns {number} the remembered count.
 */
function btwContextCountOf(turns, stored) {
  if (Number.isSafeInteger(turns) && turns >= MIN_BTW_CONTEXT_COUNT) return turns
  return normalizeBtwContextCount(stored, DEFAULT_BTW_CONTEXT_COUNT)
}

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
 * How many recent conversation records one rewrite may carry as context.
 *
 * The rewrite is a single mode: its prompt is the built-in default unless the
 * user writes one, and this count is how much session context it carries. Records are the
 * session log's own entries (a message, a tool call, its result), which is the
 * same unit the side-question half counts, and they travel in time order.
 */
export const MIN_RECENT_MESSAGES = 0
export const MAX_RECENT_MESSAGES = 50
export const DEFAULT_RECENT_MESSAGES = 8

/**
 * One accepted "carry the last N records" value.
 *
 * Repaired rather than rejected on read: a settings file is a document a human
 * can edit, and a bad number there must not cost the user the rest of their
 * settings. Out-of-range and non-integer values fall back to the default.
 * @param {unknown} value - the stored `recentMessages`.
 * @param {number} fallback - value to use when absent or unusable.
 * @returns {number} an integer inside {@link MIN_RECENT_MESSAGES}–{@link MAX_RECENT_MESSAGES}.
 */
export function normalizeRecentMessages(value, fallback = DEFAULT_RECENT_MESSAGES) {
  if (!Number.isSafeInteger(value) || value < MIN_RECENT_MESSAGES || value > MAX_RECENT_MESSAGES) return fallback
  return value
}

/**
 * Reasoning effort the model calls ask for. `auto` omits the field and lets the
 * adapter's configured default apply; every half starts at `off`, because a
 * rewrite is a comprehension task, not a reasoning one — but each half owns its
 * value, so a route that wants a level can be given one.
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
 * Cap on how many per-model compaction thresholds the settings file may hold.
 * One row per configured model, so this only bounds a hand-edited document.
 */
export const COMPACTION_MAX_ROWS = 50

/** Settings as the routes consume them (nulls mean "not chosen / use default"). */
export const DEFAULT_SETTINGS = Object.freeze({
  /** Custom optimization prompt; null means the built-in default is in force. */
  systemPrompt: null,
  /**
   * How many of the session's newest records the rewrite carries.
   *
   * `0` means "carry none" — the feature then sends the draft alone, exactly as
   * it did before this knob existed ({@link normalizeRecentMessages} keeps a
   * hand-edited file inside the accepted range).
   */
  recentMessages: DEFAULT_RECENT_MESSAGES,
  /**
   * Which language the *rewritten prompt itself* is written in: one of
   * {@link OUTPUT_LANGUAGES}, or null for "follow the interface language".
   *
   * Null is the default on purpose: a first-run user gets the right answer
   * without touching anything, because a Chinese shell usually reads Chinese
   * drafts and an English shell English ones. From the first explicit choice on,
   * the stored value wins over the shell — a setting that keeps re-guessing
   * would not be a setting.
   */
  outputLang: null,
  /**
   * Provider route of the model that rewrites the draft; null means "follow the
   * session's own model".
   *
   * Null is the zero-configuration default and the recommended one: the rewrite
   * then rides whatever model the conversation already uses, which is also the
   * route the routing table already knows how to fail over. Pinning a route here
   * makes the rewrite independent of the session's selection — and, unlike a
   * session call, it is *not* rerouted by the breaker, because it does not travel
   * through `agent/request`.
   */
  provider: null,
  /** Model id of the rewrite model; null means "follow the session's own model". */
  model: null,
  /** One of {@link EFFORT_CHOICES}; the effort one rewrite asks for. */
  reasoningEffort: DEFAULT_EFFORT,
  /** Which messages a `/btw` side question carries: {@link BTW_CONTEXT_ALL}, `0`, or a positive count of the newest records. */
  btwContextTurns: BTW_CONTEXT_ALL,
  /**
   * The count the 「最近 N 条」 input shows while another mode is active — the memo
   * {@link normalizeBtwContextCount} describes. Only the input reads it; what a
   * question actually carries stays {@link DEFAULT_SETTINGS.btwContextTurns}.
   */
  btwContextCount: DEFAULT_BTW_CONTEXT_COUNT,
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
   * Per-model context window to *assume*, keyed `"provider/model"` the same way
   * as the thresholds.
   *
   * Blank is the actual default: with no row here, the effective window comes
   * from the routing service's `/v1/models` (which prefers the upstream's
   * advertised `context_window` and falls back to 1M) and then from the model
   * adapter's declared value. A row here pins a window and is what makes a
   * threshold plan trustworthy when the upstream advertises nothing — the
   * settings page shows 1,000,000 in the box precisely so an unknown window can
   * be seen and corrected in place.
   */
  compactionWindows: {},
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
   * keeps a hand-edited file inside the accepted range). What the notification is
   * *about* stays fixed — the session title, and this turn's answer — while the
   * body is now condensed by a model before it gets here; this cap is the budget
   * that condensation is asked to fit, and a summary that still overshoots is cut
   * with a visible `...` (`lib/notify-summary.js`).
   */
  notifyMaxChars: NOTIFY_BODY_CHARS,
  /**
   * Provider route of the model that condenses one finished answer into the
   * notification body; null means "not chosen", which resolves exactly like the
   * other three halves' empty choice: the session's own model first, then the
   * catalog's first model. The summary therefore rides the model the user is
   * already paying for until they pin one here.
   */
  notifyProvider: null,
  /** Model id of that summarizer; null means "not chosen". */
  notifyModel: null,
  /**
   * One of {@link EFFORT_CHOICES}; the effort one notification summary asks for.
   *
   * `off` by default: the text it condenses has already been produced once, so
   * thinking tokens buy nothing and cost seconds on the completion path. It is a
   * setting rather than a fixed fact because a route that cannot turn thinking
   * off (or a user who wants a tighter summary) has no other way to say so.
   */
  notifyReasoningEffort: DEFAULT_EFFORT,
  /**
   * Provider route of the session-title model; null means "not chosen", which
   * resolves exactly like the rewrite's empty choice: the session's own model
   * first, then the catalog's first model. Titles therefore ride the model the
   * user is already paying for until they pin one here.
   */
  titleProvider: null,
  /** Model id of the session-title model; null means "not chosen". */
  titleModel: null,
  /**
   * One of {@link EFFORT_CHOICES}; the effort one title call asks for. Titles
   * are one short line, so the default is `off` — thinking tokens cost seconds
   * here and are thrown away.
   */
  titleReasoningEffort: DEFAULT_EFFORT,
  /**
   * How many eligible human messages accumulate before the title is summarized
   * again — and how many of the newest ones that summary reads (one number, see
   * `lib/title.js`). Zero-configuration value: 100.
   */
  titleRerollTurns: DEFAULT_TITLE_REROLL_TURNS,
  /**
   * Longest accepted title, in characters. Applied to every title the refresher
   * writes, and stated to the model so the title is chosen to fit rather than
   * cut to fit ({@link normalizeTitleMaxChars} keeps a hand-edited file inside
   * the accepted range).
   */
  titleMaxChars: DEFAULT_TITLE_MAX_CHARS,
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
    // A route string contains a `/` (provider/model). Only that presence is
    // required: the exact boundary is resolved against the catalog at plan time,
    // never guessed here, because a model id may itself contain a `/`.
    if (typeof key !== 'string' || key.length === 0 || key.length > 200 || !key.includes('/')) continue
    const tokens = Number(raw)
    if (!isCompactionTokens(tokens)) continue
    out[key] = tokens
  }
  return out
}

/**
 * One per-model context-window map, repaired rather than rejected.
 *
 * Same shape and tolerance as {@link compactionTokensOr}: the window is a window
 * only when it is a safe integer inside {@link MIN_CONTEXT_WINDOW} /
 * {@link MAX_CONTEXT_WINDOW}, and a hand-edited file with one bad row keeps every
 * other row.
 * @param {unknown} value - the stored `compactionWindows`.
 * @returns {Record<string, number>} `"provider/model"` to a usable window.
 */
function compactionWindowsOr(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out = {}
  for (const [key, raw] of Object.entries(value)) {
    if (Object.keys(out).length >= COMPACTION_MAX_ROWS) break
    if (typeof key !== 'string' || key.length === 0 || key.length > 200 || !key.includes('/')) continue
    const window = Number(raw)
    if (!Number.isSafeInteger(window) || window < MIN_CONTEXT_WINDOW || window > MAX_CONTEXT_WINDOW) continue
    out[key] = window
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
  const btwContextTurns = normalizeBtwContextTurns(raw.btwContextTurns, DEFAULT_SETTINGS.btwContextTurns)
  return {
    systemPrompt: nullableString(raw.systemPrompt, 20_000),
    recentMessages: normalizeRecentMessages(raw.recentMessages, DEFAULT_SETTINGS.recentMessages),
    outputLang: oneOf(raw.outputLang, OUTPUT_LANGUAGES, DEFAULT_SETTINGS.outputLang),
    provider: nullableString(raw.provider, 200),
    model: nullableString(raw.model, 200),
    reasoningEffort: oneOf(raw.reasoningEffort, EFFORT_CHOICES, DEFAULT_SETTINGS.reasoningEffort),
    btwContextTurns,
    btwContextCount: btwContextCountOf(btwContextTurns, raw.btwContextCount),
    btwSaveHistory: booleanOr(raw.btwSaveHistory, DEFAULT_SETTINGS.btwSaveHistory),
    btwProvider: nullableString(raw.btwProvider, 200),
    btwModel: nullableString(raw.btwModel, 200),
    btwReasoningEffort: oneOf(raw.btwReasoningEffort, EFFORT_CHOICES, DEFAULT_SETTINGS.btwReasoningEffort),
    compactionTokens: compactionTokensOr(raw.compactionTokens),
    compactionWindows: compactionWindowsOr(raw.compactionWindows),
    notifyOnComplete: booleanOr(raw.notifyOnComplete, DEFAULT_SETTINGS.notifyOnComplete),
    notifyMaxChars: normalizeNotifyChars(raw.notifyMaxChars, DEFAULT_SETTINGS.notifyMaxChars),
    notifyProvider: nullableString(raw.notifyProvider, 200),
    notifyModel: nullableString(raw.notifyModel, 200),
    notifyReasoningEffort: oneOf(raw.notifyReasoningEffort, EFFORT_CHOICES, DEFAULT_SETTINGS.notifyReasoningEffort),
    titleProvider: nullableString(raw.titleProvider, 200),
    titleModel: nullableString(raw.titleModel, 200),
    titleReasoningEffort: oneOf(raw.titleReasoningEffort, EFFORT_CHOICES, DEFAULT_SETTINGS.titleReasoningEffort),
    titleRerollTurns: normalizeTitleRerollTurns(raw.titleRerollTurns, DEFAULT_SETTINGS.titleRerollTurns),
    titleMaxChars: normalizeTitleMaxChars(raw.titleMaxChars, DEFAULT_SETTINGS.titleMaxChars),
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
  if ('recentMessages' in patch) {
    next.recentMessages = normalizeRecentMessages(patch.recentMessages, DEFAULT_SETTINGS.recentMessages)
  }
  if ('outputLang' in patch) {
    next.outputLang = oneOf(patch.outputLang, OUTPUT_LANGUAGES, DEFAULT_SETTINGS.outputLang)
  }
  // The rewrite's own model pair and effort: the same string-or-null shape the
  // other three halves use, so `/save` and the file agree on what "follow the
  // session" (`null`) means.
  if ('provider' in patch) next.provider = patch.provider === null ? null : nullableString(patch.provider, 200)
  if ('model' in patch) next.model = patch.model === null ? null : nullableString(patch.model, 200)
  if ('reasoningEffort' in patch) {
    next.reasoningEffort = oneOf(patch.reasoningEffort, EFFORT_CHOICES, DEFAULT_SETTINGS.reasoningEffort)
  }
  if ('btwContextTurns' in patch) {
    next.btwContextTurns = normalizeBtwContextTurns(patch.btwContextTurns, DEFAULT_SETTINGS.btwContextTurns)
  }
  if ('btwContextCount' in patch) {
    next.btwContextCount = normalizeBtwContextCount(patch.btwContextCount, DEFAULT_SETTINGS.btwContextCount)
  }
  // The memo follows the active value: a newly written count *is* the number the
  // 「最近 N 条」 input should remember, whether or not the same patch names it.
  if (Number.isSafeInteger(next.btwContextTurns) && next.btwContextTurns >= MIN_BTW_CONTEXT_COUNT) {
    next.btwContextCount = next.btwContextTurns
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
  // The window map follows the same whole-map rule as the thresholds above.
  if ('compactionWindows' in patch) next.compactionWindows = compactionWindowsOr(patch.compactionWindows)
  if ('notifyOnComplete' in patch) {
    next.notifyOnComplete = booleanOr(patch.notifyOnComplete, DEFAULT_SETTINGS.notifyOnComplete)
  }
  if ('notifyMaxChars' in patch) {
    next.notifyMaxChars = normalizeNotifyChars(patch.notifyMaxChars, DEFAULT_SETTINGS.notifyMaxChars)
  }
  if ('notifyProvider' in patch) next.notifyProvider = patch.notifyProvider === null ? null : nullableString(patch.notifyProvider, 200)
  if ('notifyModel' in patch) next.notifyModel = patch.notifyModel === null ? null : nullableString(patch.notifyModel, 200)
  if ('notifyReasoningEffort' in patch) {
    next.notifyReasoningEffort = oneOf(patch.notifyReasoningEffort, EFFORT_CHOICES, DEFAULT_SETTINGS.notifyReasoningEffort)
  }
  if ('titleProvider' in patch) next.titleProvider = patch.titleProvider === null ? null : nullableString(patch.titleProvider, 200)
  if ('titleModel' in patch) next.titleModel = patch.titleModel === null ? null : nullableString(patch.titleModel, 200)
  if ('titleReasoningEffort' in patch) {
    next.titleReasoningEffort = oneOf(patch.titleReasoningEffort, EFFORT_CHOICES, DEFAULT_SETTINGS.titleReasoningEffort)
  }
  if ('titleRerollTurns' in patch) {
    next.titleRerollTurns = normalizeTitleRerollTurns(patch.titleRerollTurns, DEFAULT_SETTINGS.titleRerollTurns)
  }
  if ('titleMaxChars' in patch) {
    next.titleMaxChars = normalizeTitleMaxChars(patch.titleMaxChars, DEFAULT_SETTINGS.titleMaxChars)
  }
  // Routing keys arriving in a patch are ignored rather than rejected. They used
  // to live here; they now belong to the routing service's own document, and the
  // only thing this store should do with a stale writer is drop the field — a
  // hard error would break a browser tab that was left open across the upgrade.
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

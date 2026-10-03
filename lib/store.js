/**
 * Plugin-owned durable settings: the custom optimization prompt and the
 * provider/model route used to rewrite drafts.
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

/** DSH home; DSH_HOME wins over homedir() because the two can differ in deployments. */
export const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

/** Absolute path of this plugin's settings file. */
export const CONFIG_FILE = join(DSH_HOME, 'prompt-optimizer.json')

/**
 * Reasoning effort the rewrite call asks for. `auto` omits the field and lets
 * the adapter's configured default apply — on this harness that default is
 * `high`, which spends seconds on thinking tokens the plugin then discards, so
 * the plugin ships `off` as its default and exposes the whole list in Settings.
 */
export const EFFORT_CHOICES = Object.freeze(['auto', 'off', 'low', 'high', 'max'])

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

/** Settings as the routes consume them (nulls mean "not chosen / use default"). */
export const DEFAULT_SETTINGS = Object.freeze({
  /** Custom optimization prompt; null means the built-in default is in force. */
  systemPrompt: null,
  /** Provider route of the optimization model; null means "pick the first available". */
  provider: null,
  /** Model id of the optimization model; null means "pick the first available". */
  model: null,
  /** One of {@link EFFORT_CHOICES}. */
  reasoningEffort: 'off',
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

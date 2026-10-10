/**
 * The service's runtime state: facts it learned, as opposed to decisions a
 * human made.
 *
 * ## Why this is not just more configuration
 *
 * `router-service.json` is a document an operator writes and the service only
 * ever *accepts* ({@link module:dsh-prompt-tuner/service/config}): a save that
 * cannot be taken is rejected rather than repaired, because silently rewriting
 * what someone typed leaves the page and the file disagreeing. None of that
 * reasoning applies here. A blacklist entry and a discovered model list are
 * *observations* with a short useful life, written by the service itself on a
 * request or a button press, and they must never be able to stop it from booting.
 *
 * Keeping them in the same file would force one policy on two opposite kinds of
 * data — and would mean the service rewriting a file the operator may be
 * mid-edit, which is precisely the failure the config file's write-reject rule
 * exists to avoid. So state gets its own file, atomic-written, and the config
 * poller watches only the config.
 *
 * ## A dead credential gets an answer, not a cooldown
 *
 * The one thing worth persisting is the blacklist. A transient failure is
 * handled by an in-memory breaker and forgotten when the process dies, which is
 * correct — a restart should not inherit a grudge. A `401`, a `402` or a
 * permission error is different: it will fail identically on every future
 * request until a human changes something, so retrying it after every restart is
 * pure waste. Entries therefore survive restarts, carry the reason and the
 * upstream's own words, and leave only when the operator clears them or when the
 * upstream's `retry-after`-style reset time arrives.
 *
 * @module dsh-prompt-tuner/service/state
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DSH_HOME } from './config.js'

/**
 * Where the runtime state lives.
 *
 * `ROUTER_SERVICE_STATE` overrides it, exactly as `ROUTER_SERVICE_CONFIG` does
 * for the configuration, so a self-test can run a whole service without touching
 * the operator's own files.
 */
export const SERVICE_STATE_FILE = process.env.ROUTER_SERVICE_STATE || join(DSH_HOME, 'router-service.state.json')

/** Document version, so a future migration has something to branch on. */
export const STATE_VERSION = 1

/** Longest accepted reason/message text, so a chatty gateway cannot bloat the file. */
const MAX_TEXT = 400

/** How long a blacklist entry may sit untouched before it is dropped. */
const ENTRY_TTL_MS = 90 * 24 * 60 * 60 * 1000

/** How long writes are coalesced for (ms). */
const FLUSH_DELAY_MS = 250

/** One non-empty, bounded string, or null. */
function shortString(value, max = 200) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > max) return null
  return trimmed
}

/** A finite number, or null. */
function numOrNull(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Parse an ISO timestamp into milliseconds, or null.
 * @param {unknown} value - the stored timestamp.
 * @returns {number|null} milliseconds since epoch.
 */
export function parseTime(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Repair one stored blacklist entry. */
function normalizeEntry(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const provider = shortString(raw.provider, 64)
  if (provider === null) return null
  const keyId = shortString(raw.keyId, 64)
  const reason = shortString(raw.reason, 64) ?? 'unknown'
  const at = parseTime(raw.at) ?? Date.now()
  return {
    provider,
    keyId,
    reason,
    message: typeof raw.message === 'string' ? raw.message.slice(0, MAX_TEXT) : '',
    at: new Date(at).toISOString(),
    recoverAt: parseTime(raw.recoverAt) === null ? null : new Date(parseTime(raw.recoverAt)).toISOString(),
  }
}

/** Repair the whole state document. */
function normalizeState(raw) {
  const input = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}
  const blacklist = {}
  const rawBlacklist = typeof input.blacklist === 'object' && input.blacklist !== null && !Array.isArray(input.blacklist)
    ? input.blacklist
    : {}
  for (const [unit, entry] of Object.entries(rawBlacklist)) {
    const repaired = normalizeEntry(entry)
    if (repaired === null) continue
    blacklist[unit] = repaired
  }
  const discovered = {}
  const rawDiscovered = typeof input.discovered === 'object' && input.discovered !== null && !Array.isArray(input.discovered)
    ? input.discovered
    : {}
  for (const [provider, models] of Object.entries(rawDiscovered)) {
    const id = shortString(provider, 64)
    if (id === null || !Array.isArray(models)) continue
    const list = []
    for (const model of models) {
      const text = shortString(model)
      if (text === null || list.includes(text)) continue
      list.push(text)
      if (list.length >= 512) break
    }
    discovered[id] = list
  }
  return { version: STATE_VERSION, blacklist, discovered }
}

/**
 * Create the runtime state store.
 *
 * @param {object} [options] - wiring.
 * @param {string} [options.file] - path to the state file.
 * @param {() => number} [options.now] - injectable clock.
 * @param {{warn?: Function}} [options.logger] - sink for write failures.
 * @param {boolean} [options.persist] - whether writes are allowed at all (tests set false).
 * @returns {object} the store.
 */
export function createStateStore(options = {}) {
  const file = options.file ?? SERVICE_STATE_FILE
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const logger = options.logger ?? null
  const allowed = options.persist !== false

  let state = { version: STATE_VERSION, blacklist: {}, discovered: {} }
  let loaded = false
  let dirty = false
  let timer = null

  /** Read the file, repairing anything unusable. A missing or broken file is empty state. */
  function load() {
    loaded = true
    if (!existsSync(file)) return state
    try {
      state = normalizeState(JSON.parse(readFileSync(file, 'utf8')))
    } catch {
      // A corrupt state file is worth nothing but must never be fatal: the
      // service boots with no memory of the past and relearns it in a request.
      state = { version: STATE_VERSION, blacklist: {}, discovered: {} }
    }
    return state
  }

  /** Write the document atomically. */
  function writeNow() {
    if (!allowed) {
      dirty = false
      return false
    }
    try {
      mkdirSync(dirname(file), { recursive: true })
      const temp = `${file}.tmp-${process.pid}`
      writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
      renameSync(temp, file)
      dirty = false
      return true
    } catch (cause) {
      // A read-only home directory loses the memory, not the service.
      dirty = false
      try {
        logger?.warn?.(`[router-service] could not persist runtime state: ${String(cause?.message ?? cause)}`)
      } catch {
        // A logger that throws must not fail a request.
      }
      return false
    }
  }

  /** Coalesce bursts of updates into one write. */
  function schedule() {
    dirty = true
    if (!allowed) return
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      if (dirty) writeNow()
    }, FLUSH_DELAY_MS)
    timer.unref?.()
  }

  /**
   * Whether a unit is blacklisted right now, applying any reset time that has
   * already arrived. An expired entry is dropped on the way past, which is what
   * keeps a quota reset from needing a scheduler of its own.
   * @param {string} unit - the breaker key.
   * @returns {object|null} the live entry, or null.
   */
  function blocked(unit) {
    if (!loaded) load()
    const entry = state.blacklist[unit]
    if (entry === undefined) return null
    const recoverAt = parseTime(entry.recoverAt)
    if (recoverAt !== null && now() >= recoverAt) {
      delete state.blacklist[unit]
      schedule()
      return null
    }
    const at = parseTime(entry.at)
    if (at !== null && now() - at > ENTRY_TTL_MS) {
      // Nothing has touched this in three months; it is history, not a fact.
      delete state.blacklist[unit]
      schedule()
      return null
    }
    return entry
  }

  /**
   * Record a credential as dead.
   * @param {{provider: string, keyId: string|null, reason: string, message?: string, recoverAt?: string|null}} verdict - the verdict.
   * @param {string} unit - the breaker key it belongs to.
   * @returns {object} the stored entry.
   */
  function mark(unit, verdict) {
    if (!loaded) load()
    const entry = normalizeEntry({
      provider: verdict.provider,
      keyId: verdict.keyId,
      reason: verdict.reason,
      message: verdict.message,
      at: new Date(now()).toISOString(),
      recoverAt: verdict.recoverAt ?? null,
    })
    state.blacklist[unit] = entry
    schedule()
    return entry
  }

  /**
   * Forget one unit's entry.
   * @param {string} unit - the breaker key.
   * @returns {boolean} whether anything was removed.
   */
  function clear(unit) {
    if (!loaded) load()
    if (!(unit in state.blacklist)) return false
    delete state.blacklist[unit]
    schedule()
    return true
  }

  /**
   * Forget every entry belonging to a provider, optionally just one key.
   *
   * Called when a credential is edited (a new secret is a new credential, so the
   * old verdict says nothing about it), when a provider is deleted, and when the
   * operator asks for a restore.
   *
   * @param {string} provider - the provider id.
   * @param {string|null} [keyId] - one key, or null for all of them.
   * @returns {number} how many entries were removed.
   */
  function clearProvider(provider, keyId = null) {
    if (!loaded) load()
    let removed = 0
    for (const [unit, entry] of Object.entries(state.blacklist)) {
      if (entry.provider !== provider) continue
      if (keyId !== null && entry.keyId !== keyId) continue
      delete state.blacklist[unit]
      removed += 1
    }
    if (removed > 0) schedule()
    return removed
  }

  /**
   * Every live entry, for the admin page.
   * @returns {Array<object>} one row per blacklisted unit.
   */
  function entries() {
    if (!loaded) load()
    const out = []
    for (const [unit, entry] of Object.entries(state.blacklist)) {
      if (blocked(unit) === null) continue
      const recoverAt = parseTime(entry.recoverAt)
      out.push({
        unit,
        provider: entry.provider,
        keyId: entry.keyId,
        reason: entry.reason,
        message: entry.message,
        at: entry.at,
        recoverAt: entry.recoverAt,
        recoverInMs: recoverAt === null ? null : Math.max(0, recoverAt - now()),
      })
    }
    return out
  }

  /**
   * Remember the models a provider last listed.
   *
   * Persisted rather than kept in memory because the list is what the admin
   * page's model picker offers: losing it on restart would mean an empty
   * dropdown until someone pressed refresh again.
   *
   * @param {string} provider - the provider id.
   * @param {Array<string>} models - the ids the upstream listed.
   * @returns {Array<string>} what was stored.
   */
  function setDiscovered(provider, models) {
    if (!loaded) load()
    const list = []
    for (const model of Array.isArray(models) ? models : []) {
      const text = shortString(model)
      if (text === null || list.includes(text)) continue
      list.push(text)
      if (list.length >= 512) break
    }
    if (list.length === 0) {
      // An upstream that listed nothing tells us nothing; keep the old list
      // rather than replacing a useful one with emptiness.
      return state.discovered[provider] ?? []
    }
    state.discovered[provider] = list
    schedule()
    return list
  }

  /**
   * The models a provider last listed.
   * @param {string} provider - the provider id.
   * @returns {Array<string>} the remembered list, or empty.
   */
  function discovered(provider) {
    if (!loaded) load()
    return [...(state.discovered[provider] ?? [])]
  }

  /** The whole document, for diagnostics. */
  const snapshot = () => ({
    file,
    version: STATE_VERSION,
    blacklist: entries(),
    discovered: { ...state.discovered },
  })

  /** Flush any pending write immediately (used on shutdown and by the self-test). */
  function flush() {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (dirty) return writeNow()
    return true
  }

  return { load, blocked, mark, clear, clearProvider, entries, setDiscovered, discovered, snapshot, flush, file }
}

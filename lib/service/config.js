/**
 * The routing service's configuration document: which upstream providers exist,
 * which order they sit in, and how the breaker behaves.
 *
 * ## Why the service owns a file of its own
 *
 * The routing half used to live inside the plugin and read the plugin's own
 * settings (`$DSH_HOME/prompt-optimizer.json`). It moved out for one reason:
 * the thing it does — hold open connections to upstreams, fail over mid-request,
 * remember which provider is rate limiting — is a runtime concern, not a
 * composer concern, and every other agent on the machine that wants the same
 * behaviour should not have to install a prompt plugin to get it. Sharing the
 * plugin's settings file would have kept the coupling while pretending to break
 * it, so the service reads `$DSH_HOME/router-service.json` and nothing else.
 *
 * ## Reads repair, writes reject
 *
 * The same split the plugin's store uses, for the same reason: this file is a
 * document a human may hand-edit, and a typo in a provider entry must not be
 * able to stop the service from booting — {@link readConfig} falls back field by
 * field. A save made from the admin page is a decision, so
 * {@link validateConfigPatch} refuses anything it cannot accept instead of
 * silently rewriting what the operator typed.
 *
 * ## One provider, many credentials
 *
 * A provider carries `keys`, an ordered list of credentials, each with a **stable
 * id** that survives rotating its secret. Everything that remembers something
 * about a credential — the breaker's unit key, a blacklist entry, the failure
 * counters on the admin page — addresses it by that id and never by the secret
 * or its mask. The alternative (joining runtime state to the value or its mask)
 * has a documented failure mode in the reference implementation this design
 * borrows from: two keys whose masks collide silently share one history.
 *
 * The provider-level `apiKey` string this document used to hold is read as a
 * one-entry `keys` list, so an existing file keeps working and a rotated key
 * keeps its identity.
 *
 * ## Changing a provider refreshes the order table
 *
 * The order table names a provider and a model, so it is only meaningful against
 * the provider set it was written for. Adding, editing or deleting a provider
 * therefore reconciles the table in {@link applyConfigPatch}: a row whose
 * provider no longer exists, or whose model the provider no longer offers, is
 * removed — and reported back, because silently dropping a row the operator
 * wrote would be the same bug in the other direction.
 *
 * ## Seeding, so the move costs nothing
 *
 * {@link readConfig} seeds a missing file from the plugin's own settings: the
 * order table already in `prompt-optimizer.json` is carried across verbatim, one
 * row at a time, and the two MaaS routes the plugin shipped are pre-declared
 * with their published base URLs. What it deliberately does *not* carry across
 * is any credential: `apiKey` starts empty on every seeded provider, so the
 * service never quietly acquires a secret the operator did not type into it.
 *
 * @module dsh-prompt-tuner/service/config
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_ROUTER_COOLDOWN_FACTOR,
  DEFAULT_ROUTER_COOLDOWN_MAX_MS,
  DEFAULT_ROUTER_COOLDOWN_MS,
  DEFAULT_ROUTER_FAILURE_RATE,
  DEFAULT_ROUTER_HALF_OPEN_SUCCESSES,
  DEFAULT_ROUTER_LOG_LEVEL,
  DEFAULT_ROUTER_MAX_SWITCHES,
  DEFAULT_ROUTER_MIN_SAMPLES,
  DEFAULT_ROUTER_RETRIES,
  DEFAULT_ROUTER_THRESHOLD,
  DEFAULT_ROUTER_WINDOW_MS,
  DEFAULT_ROUTER_WINDOW_SIZE,
  ROUTER_LIMITS,
  ROUTER_LOG_LEVELS,
  ROUTER_RECOVERY_MODES,
  normalizeOrder,
  normalizeRouterConfig,
} from './router.js'

/** Where DSH keeps its state; the service keeps its own file beside it. */
export const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

/**
 * The service's own configuration file.
 *
 * `ROUTER_SERVICE_CONFIG` overrides the location, which is what lets a self-test
 * (or a second instance on a throwaway port) run without touching the file the
 * operator's live service is using.
 */
export const SERVICE_CONFIG_FILE = process.env.ROUTER_SERVICE_CONFIG || join(DSH_HOME, 'router-service.json')

/** The plugin's settings file, read once to seed a fresh install. */
export const PLUGIN_SETTINGS_FILE = join(DSH_HOME, 'prompt-optimizer.json')

/** Document version, so a future migration has something to branch on. */
export const CONFIG_VERSION = 1

/**
 * Default listen port.
 *
 * Chosen to sit clear of the two ports this machine already uses for long-lived
 * local services — DSH's own web server on 3080 and `dsh-remote-gateway` on 8787
 * — because a collision there would present as "the router is down" rather than
 * as a port clash.
 */
export const DEFAULT_PORT = 8790

/** The service only ever listens here unless an operator edits the file. */
export const DEFAULT_HOST = '127.0.0.1'

/** Longest accepted provider id. */
const MAX_ID = 64

/** Accepted provider-id alphabet: what a URL path could hold without escaping. */
const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

/** How many credentials one provider may hold. */
export const MAX_KEYS_PER_PROVIDER = 16

/**
 * The id a migrated, hand-written or id-less credential gets.
 *
 * Chosen to be stable across reads: a provider whose keys carry no ids at all is
 * named by position, so rotating the secret in place keeps the same unit key and
 * therefore the same breaker.
 */
export const DEFAULT_KEY_ID = 'k1'

/**
 * The two MaaS routes the plugin shipped, pre-declared so a fresh service has
 * somewhere to put the operator's key without them retyping a base URL.
 *
 * These are published endpoints, not secrets; `apiKey` is deliberately empty.
 */
export const SEED_PROVIDERS = Object.freeze({
  'maas-coclaw': {
    label: 'ZTE MaaS · co-claw',
    baseURL: 'https://maas-apigateway.dt.zte.com.cn/model-cop/co-claw/v1',
    models: ['co-claw'],
  },
  'maas-dsv4': {
    label: 'ZTE MaaS · deepseek-v4-flash',
    baseURL: 'https://maas-apigateway.dt.zte.com.cn/model/deepseek-v4-flash/v1',
    models: ['deepseek-v4-flash'],
  },
})

/**
 * Converters loaded at startup, by id.
 *
 * `maas` is the only one that ships today: it makes the two ZTE gateway routes
 * speak `api.deepseek.com`'s contract. A route with no converter is passed
 * through untouched, which is the honest default — the service is a router
 * first, and only rewrites a contract when an operator asked for one.
 */
export const DEFAULT_CONVERTERS = ['maas']

/** One non-empty bounded string, or null. */
function shortString(value, max = 200) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > max) return null
  return trimmed
}

/** Coerce a value into an array of distinct non-empty strings. */
function stringList(value, max = 64) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    const text = shortString(entry)
    if (text === null || out.includes(text)) continue
    out.push(text)
    if (out.length >= max) break
  }
  return out
}

/** One integer inside inclusive bounds, or the fallback. */
function intIn(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/** A boolean, or the fallback when it is not one. */
function boolOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Repair one provider entry.
 * @param {string} id - the provider id (already validated by the caller).
 * @param {unknown} raw - the stored entry.
 * @returns {{id: string, label: string, baseURL: string, keys: Array<object>, models: string[], timeoutMs: number}} the repaired entry.
 */
/** The next unused `kN` id, so a repaired key list stays addressable. */
function freshKeyId(seen) {
  for (let i = 1; i <= MAX_KEYS_PER_PROVIDER + 1; i += 1) {
    const candidate = `k${i}`
    if (!seen.has(candidate)) return candidate
  }
  return `k${seen.size + 1}`
}

/**
 * Repair one provider's credential list.
 *
 * A credential with no usable id gets one by position, and the legacy
 * single-`apiKey` spelling becomes a one-entry list, which is what keeps an
 * older configuration file loadable without a migration step the operator has to
 * know about.
 *
 * @param {unknown} raw - the stored `keys` array.
 * @param {unknown} [legacyApiKey] - the stored `apiKey`, for files written before keys existed.
 * @returns {Array<{id: string, label: string, key: string}>} the repaired list.
 */
export function normalizeKeys(raw, legacyApiKey) {
  const out = []
  const seen = new Set()
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (out.length >= MAX_KEYS_PER_PROVIDER) break
      const input = typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? entry : null
      if (input === null) continue
      let id = shortString(input.id, MAX_ID)
      if (id === null || !ID_PATTERN.test(id) || seen.has(id)) id = freshKeyId(seen)
      seen.add(id)
      out.push({
        id,
        label: shortString(input.label) ?? '',
        key: typeof input.key === 'string' ? input.key : '',
      })
    }
  }
  if (out.length === 0 && typeof legacyApiKey === 'string' && legacyApiKey !== '') {
    out.push({ id: DEFAULT_KEY_ID, label: '', key: legacyApiKey })
  }
  return out
}

/**
 * The credentials a provider can serve with, as the walk and the breaker see it.
 *
 * A provider with no credentials still has exactly one unit — the route itself —
 * so a keyless local endpoint stays routable and a single-key configuration
 * behaves exactly as it did before keys existed.
 *
 * @param {object|undefined} provider - the repaired provider.
 * @returns {Array<{id: string|null, label: string, key: string}>} the units.
 */
export function keyUnitsOf(provider) {
  const keys = Array.isArray(provider?.keys) ? provider.keys : []
  if (keys.length === 0) return [{ id: null, label: '', key: '' }]
  return keys.map((entry) => ({ id: entry.id, label: entry.label ?? '', key: entry.key ?? '' }))
}

/**
 * Every model id a provider may be asked for.
 *
 * The manual list comes first because it is what the operator asserted; the
 * discovered list is what the upstream last admitted to and is appended, so a
 * hand-typed id is never hidden behind a fetched one.
 *
 * @param {object|undefined} provider - the repaired provider.
 * @param {Array<string>} [discovered] - the models the upstream last listed.
 * @returns {Array<string>} distinct model ids, in preference order.
 */
export function availableModels(provider, discovered = []) {
  const out = []
  const push = (value) => {
    const text = typeof value === 'string' ? value.trim() : ''
    if (text === '' || out.includes(text)) return
    out.push(text)
  }
  for (const model of Array.isArray(provider?.models) ? provider.models : []) push(model)
  for (const model of Array.isArray(discovered) ? discovered : []) push(model)
  return out
}

function normalizeProvider(id, raw) {
  const input = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}
  return {
    id,
    label: shortString(input.label) ?? id,
    baseURL: shortString(input.baseURL, 2048) ?? '',
    keys: normalizeKeys(input.keys, input.apiKey),
    models: stringList(input.models),
    timeoutMs: intIn(input.timeoutMs, 1_000, 3_600_000, 120_000),
  }
}

/**
 * Repair the whole provider map.
 *
 * An entry with no id is dropped; an id that is not URL-path-safe is dropped
 * too, because it would otherwise be unaddressable from the order table and
 * from `provider/model` route names.
 * @param {unknown} raw - the stored `providers` map.
 * @returns {object} id → provider, in insertion order.
 */
export function normalizeProviders(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    const id = shortString(key, MAX_ID)
    if (id === null || !ID_PATTERN.test(id)) continue
    out[id] = normalizeProvider(id, value)
  }
  return out
}

/**
 * Repair the router half of the document.
 *
 * The breaker parameters are normalized by {@link normalizeRouterConfig}, so the
 * service and the settings page that used to own them agree on every bound; this
 * function only adds the service-side `enabled` switch and repairs order rows
 * that name a provider the document does not declare.
 * @param {unknown} raw - the stored `router` object.
 * @param {object} providers - the repaired provider map.
 * @returns {object} a fully-defaulted router config.
 */
export function normalizeRouter(raw, providers) {
  const input = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}
  const config = normalizeRouterConfig({
    order: input.order,
    retries: input.retries ?? DEFAULT_ROUTER_RETRIES,
    failureThreshold: input.failureThreshold ?? DEFAULT_ROUTER_THRESHOLD,
    // Every knob {@link normalizeRouterConfig} understands has to be passed
    // through here as well. Forgetting one is invisible in the file — the key
    // survives on disk — but the value in force silently reverts to the default,
    // so a saved setting appears to have been accepted and then does nothing.
    failureRateThreshold: input.failureRateThreshold ?? DEFAULT_ROUTER_FAILURE_RATE,
    minSamples: input.minSamples ?? DEFAULT_ROUTER_MIN_SAMPLES,
    windowSize: input.windowSize ?? DEFAULT_ROUTER_WINDOW_SIZE,
    halfOpenSuccesses: input.halfOpenSuccesses ?? DEFAULT_ROUTER_HALF_OPEN_SUCCESSES,
    windowMs: input.windowMs ?? DEFAULT_ROUTER_WINDOW_MS,
    cooldownMs: input.cooldownMs ?? DEFAULT_ROUTER_COOLDOWN_MS,
    cooldownFactor: input.cooldownFactor ?? DEFAULT_ROUTER_COOLDOWN_FACTOR,
    cooldownMaxMs: input.cooldownMaxMs ?? DEFAULT_ROUTER_COOLDOWN_MAX_MS,
    recoveryMode: input.recoveryMode,
    maxSwitches: input.maxSwitches ?? DEFAULT_ROUTER_MAX_SWITCHES,
    logLevel: input.logLevel ?? DEFAULT_ROUTER_LOG_LEVEL,
  })
  // Unknown providers are *kept*, not dropped: the settings page reports them as
  // "not registered" so an operator can see what a deleted provider left behind,
  // and silently rewriting the table would hide exactly that.
  if (Object.keys(providers).length === 0) return { ...config, enabled: boolOr(input.enabled, true) }
  return { ...config, enabled: boolOr(input.enabled, true) }
}

/**
 * Repair the server half: where to listen and the admin token.
 * @param {unknown} raw - the stored `server` object.
 * @returns {{host: string, port: number, token: string}} the repaired server config.
 */
function normalizeServer(raw) {
  const input = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}
  const host = shortString(input.host) ?? DEFAULT_HOST
  return {
    host,
    port: intIn(input.port, 1, 65_535, DEFAULT_PORT),
    token: shortString(input.token, 128) ?? randomBytes(24).toString('hex'),
  }
}

/**
 * Repair a whole configuration document.
 * @param {unknown} raw - whatever was parsed from disk.
 * @returns {object} the repaired document.
 */
export function normalizeConfig(raw) {
  const input = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}
  const providers = normalizeProviders(input.providers)
  return {
    version: CONFIG_VERSION,
    server: normalizeServer(input.server),
    providers,
    router: normalizeRouter(input.router, providers),
    converters: stringList(input.converters).length > 0 ? stringList(input.converters) : [...DEFAULT_CONVERTERS],
  }
}

/**
 * Read the plugin's order table, for seeding only.
 *
 * Failure is not an error: a machine that never had the plugin installed simply
 * gets the default order. Every failure mode here (missing file, malformed JSON,
 * no `routerOrder`) means the same thing to the caller.
 * @returns {Array<{provider: string, model: string}>} the rows found, or an empty list.
 */
function readPluginOrder() {
  try {
    if (!existsSync(PLUGIN_SETTINGS_FILE)) return []
    const parsed = JSON.parse(readFileSync(PLUGIN_SETTINGS_FILE, 'utf8'))
    return normalizeOrder(parsed?.routerOrder)
  } catch {
    return []
  }
}

/**
 * Build the document a fresh install starts from.
 *
 * The order table is carried over from the plugin if it has one; every provider
 * it names that the seed does not already declare is added as an empty stub, so
 * the operator sees the row they configured *and* a slot to paste its URL into,
 * rather than a row that silently vanished.
 * @returns {object} a normalized configuration document.
 */
export function seedConfig() {
  const providers = {}
  for (const [id, entry] of Object.entries(SEED_PROVIDERS)) {
    providers[id] = normalizeProvider(id, { ...entry, keys: [] })
  }
  const order = readPluginOrder()
  for (const row of order) {
    if (providers[row.provider] === undefined) providers[row.provider] = normalizeProvider(row.provider, {})
  }
  return normalizeConfig({
    server: { host: DEFAULT_HOST, port: DEFAULT_PORT },
    providers,
    router: { enabled: true, order },
    converters: [...DEFAULT_CONVERTERS],
  })
}

/**
 * Read the configuration, seeding and writing a fresh document when none exists.
 *
 * A file that exists but is unreadable is *repaired in memory only* — the
 * service boots degraded rather than overwriting a file the operator may be
 * halfway through fixing, and the admin page shows what is actually in force.
 * @param {{seed?: boolean}} [options] - `seed: false` never writes a new file (used by tests).
 * @returns {{config: object, created: boolean, repaired: boolean}} the document and how it was obtained.
 */
export function readConfig(options = {}) {
  const seed = options.seed !== false
  if (!existsSync(SERVICE_CONFIG_FILE)) {
    const fresh = seedConfig()
    let created = false
    if (seed) {
      try {
        writeConfigDocument(fresh)
        created = true
      } catch {
        // A read-only home directory must not stop the service from running: the
        // in-memory document is still a working configuration, it just will not
        // survive a restart.
        created = false
      }
    }
    return { config: fresh, created, repaired: false }
  }
  try {
    const parsed = JSON.parse(readFileSync(SERVICE_CONFIG_FILE, 'utf8'))
    const config = normalizeConfig(parsed)
    const repaired = JSON.stringify(config) !== JSON.stringify(stripForCompare(parsed))
    return { config, created: false, repaired }
  } catch {
    return { config: seedConfig(), created: false, repaired: true }
  }
}

/**
 * Compare a parsed document against its normalized form without inventing
 * differences: the normalizer adds fields, so only what the file already
 * carried is compared.
 * @param {unknown} parsed - the raw parsed document.
 * @returns {unknown} the same document with defaults dropped.
 */
function stripForCompare(parsed) {
  const input = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}
  return {
    version: CONFIG_VERSION,
    server: input.server,
    providers: input.providers,
    router: input.router,
    converters: input.converters,
  }
}

/**
 * Write a whole document atomically.
 *
 * Temp-file-plus-rename, like the plugin's own store: a crash mid-write must not
 * be able to leave a half-written configuration that the next boot repairs into
 * something the operator never asked for.
 * @param {object} config - the document to write.
 * @returns {string} the path written.
 */
export function writeConfigDocument(config) {
  mkdirSync(DSH_HOME, { recursive: true })
  const temp = `${SERVICE_CONFIG_FILE}.tmp-${process.pid}`
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, SERVICE_CONFIG_FILE)
  return SERVICE_CONFIG_FILE
}

/**
 * Validate a proposed provider entry, rejecting rather than repairing.
 * @param {string} id - the provider id.
 * @param {unknown} raw - the proposed entry.
 * @returns {{id: string, label: string, baseURL: string, keys?: Array<object>, models: string[], timeoutMs?: number}} the entry to store.
 * @throws {Error} when a field cannot be accepted.
 */
export function validateProvider(id, raw, options = {}) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error(`provider id "${String(id)}" must match ${String(ID_PATTERN)}`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`provider "${id}" must be an object`)
  }
  const label = raw.label === undefined || raw.label === null ? id : shortString(raw.label)
  if (label === null) throw new Error(`provider "${id}": label must be a non-empty string`)
  const baseURL = shortString(raw.baseURL, 2048)
  if (baseURL === null) throw new Error(`provider "${id}": baseURL is required`)
  let parsedUrl
  try {
    parsedUrl = new URL(baseURL)
  } catch {
    throw new Error(`provider "${id}": baseURL is not a URL`)
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    throw new Error(`provider "${id}": baseURL must be http or https`)
  }
  // An empty manual list is accepted on purpose: it means "whatever the
  // provider's /models endpoint discovers". A provider typed in from scratch
  // cannot know its model ids yet, and the route-table reconciliation treats an
  // empty list as "unknown" rather than "none", so existing rows survive it.
  const models = stringList(raw.models)
  const validated = validateKeys(id, raw, options)
  const keys = validated?.keys
  const timeoutMs = raw.timeoutMs === undefined || raw.timeoutMs === null
    ? undefined
    : (() => {
      const n = Number(raw.timeoutMs)
      if (!Number.isFinite(n) || n < 1_000 || n > 3_600_000) {
        throw new Error(`provider "${id}": timeoutMs must be between 1000 and 3600000`)
      }
      return Math.trunc(n)
    })()
  return {
    id,
    label,
    baseURL,
    models,
    // `undefined` means "the patch did not mention it", which is not the same as
    // "set it to empty": the caller keeps the stored value in that case, so a
    // page that never learned about a field cannot silently wipe it.
    ...(keys === undefined ? {} : { keys }),
    ...(validated === undefined ? {} : { explicitKeyIds: validated.explicit }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }
}

/**
 * Validate a proposed credential list, rejecting rather than repairing.
 *
 * An absent `keys` and an absent legacy `apiKey` both mean "not mentioned",
 * which the caller reads as "keep what is stored". An **empty array** is a
 * decision — the operator removed every credential — and is stored as such.
 *
 * `taken` holds the ids already on disk, and a *generated* id avoids them: a new
 * credential that happened to be named `k1` would otherwise collide with the
 * stored `k1` and inherit its secret, which is the one way a "blank means keep"
 * rule can lose someone's key. The caller learns which ids were named explicitly
 * so it can apply that rule only where it was actually meant.
 *
 * @param {string} id - the provider id, for the error message.
 * @param {object} raw - the proposed provider entry.
 * @param {{taken?: Set<string>}} [options] - ids already stored.
 * @returns {{keys: Array<object>, explicit: Set<string>}|undefined} the credentials and which ids were named.
 * @throws {Error} when a field cannot be accepted.
 */
function validateKeys(id, raw, options = {}) {
  if (raw.keys !== undefined && raw.keys !== null) {
    if (!Array.isArray(raw.keys)) throw new Error(`provider "${id}": keys must be an array`)
    if (raw.keys.length > MAX_KEYS_PER_PROVIDER) {
      throw new Error(`provider "${id}": at most ${MAX_KEYS_PER_PROVIDER} keys are allowed`)
    }
    const out = []
    const explicit = new Set()
    const seen = new Set(options.taken ?? [])
    for (let index = 0; index < raw.keys.length; index += 1) {
      const entry = raw.keys[index]
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new Error(`provider "${id}": keys[${index}] must be an object`)
      }
      const keyId = entry.id === undefined || entry.id === null ? '' : (shortString(entry.id, MAX_ID) ?? '')
      if (keyId === '' && entry.id !== undefined && entry.id !== null) {
        throw new Error(`provider "${id}": keys[${index}].id must be a non-empty string`)
      }
      if (keyId !== '' && !ID_PATTERN.test(keyId)) {
        throw new Error(`provider "${id}": keys[${index}].id must match ${String(ID_PATTERN)}`)
      }
      if (keyId !== '' && out.some((existing) => existing.id === keyId)) {
        throw new Error(`provider "${id}": keys[${index}].id "${keyId}" is duplicated`)
      }
      const label = entry.label === undefined || entry.label === null ? '' : (shortString(entry.label) ?? '')
      const key = entry.key === undefined || entry.key === null ? '' : entry.key
      if (typeof key !== 'string') throw new Error(`provider "${id}": keys[${index}].key must be a string`)
      const resolved = keyId === '' ? freshKeyId(seen) : keyId
      if (keyId === '') explicit.delete(resolved)
      else explicit.add(resolved)
      seen.add(resolved)
      out.push({ id: resolved, label, key })
    }
    return { keys: out, explicit }
  }
  if (raw.apiKey !== undefined && raw.apiKey !== null) {
    if (typeof raw.apiKey !== 'string') throw new Error(`provider "${id}": apiKey must be a string`)
    return { keys: [{ id: DEFAULT_KEY_ID, label: '', key: raw.apiKey }], explicit: new Set([DEFAULT_KEY_ID]) }
  }
  return undefined
}

/**
 * Remove order rows the provider set can no longer honour.
 *
 * A row whose provider is gone cannot be dialled at all; a row naming a model
 * the provider no longer offers is a typo waiting to fail at request time. Both
 * are dropped — but returned, so the page can say what it removed.
 *
 * A provider that declares no models at all is left alone: an empty list is
 * "unknown", not "none", and guessing there would delete rows an operator wrote
 * for a reason.
 *
 * @param {unknown} order - the order table.
 * @param {object} providers - the provider map about to be stored.
 * @param {(providerId: string) => Array<string>} [modelsOf] - the models a provider offers.
 * @returns {{order: Array<object>, removed: Array<object>}} what survived and what did not.
 */
export function reconcileOrder(order, providers, modelsOf) {
  const kept = []
  const removed = []
  for (const row of normalizeOrder(order)) {
    const provider = providers[row.provider]
    if (provider === undefined) {
      removed.push({ ...row, reason: 'provider_not_configured' })
      continue
    }
    const models = typeof modelsOf === 'function' ? modelsOf(row.provider) : []
    if (Array.isArray(models) && models.length > 0 && !models.includes(row.model)) {
      removed.push({ ...row, reason: 'model_not_available' })
      continue
    }
    kept.push(row)
  }
  return { order: kept, removed }
}

/**
 * Validate a router patch, rejecting rather than repairing.
 * @param {unknown} raw - the proposed partial router object.
 * @returns {object} the accepted subset.
 * @throws {Error} when a field cannot be accepted.
 */
export function validateRouterPatch(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('router must be an object')
  const out = {}
  if ('enabled' in raw) {
    if (typeof raw.enabled !== 'boolean') throw new Error('router.enabled must be a boolean')
    out.enabled = raw.enabled
  }
  if ('order' in raw) {
    if (!Array.isArray(raw.order)) throw new Error('router.order must be an array')
    if (raw.order.length > ROUTER_LIMITS.orderRows) {
      throw new Error(`router.order may hold at most ${ROUTER_LIMITS.orderRows} rows`)
    }
    out.order = raw.order.map((entry, index) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new Error(`router.order[${index}] must be an object`)
      }
      const provider = shortString(entry.provider)
      const model = shortString(entry.model)
      if (provider === null) throw new Error(`router.order[${index}].provider must be a non-empty string`)
      if (model === null) throw new Error(`router.order[${index}].model must be a non-empty string`)
      const row = { provider, model }
      if (entry.label !== undefined && entry.label !== null) {
        const label = shortString(entry.label)
        if (label === null) throw new Error(`router.order[${index}].label must be a non-empty string`)
        row.label = label
      }
      if (entry.reasoningEffort !== undefined && entry.reasoningEffort !== null) {
        const effort = shortString(entry.reasoningEffort)
        if (effort === null) throw new Error(`router.order[${index}].reasoningEffort must be a non-empty string`)
        row.reasoningEffort = effort
      }
      return row
    })
  }
  const bounds = [
    ['retries', 0, ROUTER_LIMITS.maxRetries],
    ['failureThreshold', 1, ROUTER_LIMITS.failureThreshold],
    ['minSamples', ROUTER_LIMITS.minSamples, ROUTER_LIMITS.maxSamples],
    ['windowSize', ROUTER_LIMITS.minWindowSize, ROUTER_LIMITS.maxWindowSize],
    ['halfOpenSuccesses', ROUTER_LIMITS.minHalfOpenSuccesses, ROUTER_LIMITS.maxHalfOpenSuccesses],
    ['windowMs', ROUTER_LIMITS.minWindowMs, ROUTER_LIMITS.maxWindowMs],
    ['cooldownMs', ROUTER_LIMITS.minCooldownMs, ROUTER_LIMITS.maxCooldownMs],
    ['cooldownFactor', ROUTER_LIMITS.minCooldownFactor, ROUTER_LIMITS.maxCooldownFactor],
    ['cooldownMaxMs', ROUTER_LIMITS.minCooldownMs, ROUTER_LIMITS.maxCooldownMs],
    ['maxSwitches', ROUTER_LIMITS.minSwitches, ROUTER_LIMITS.maxSwitches],
  ]
  for (const [key, min, max] of bounds) {
    if (!(key in raw)) continue
    const n = Number(raw[key])
    if (!Number.isFinite(n)) throw new Error(`router.${key} must be a number`)
    const whole = Math.trunc(n)
    if (whole < min || whole > max) throw new Error(`router.${key} must be between ${min} and ${max}`)
    out[key] = whole
  }
  if ('failureRateThreshold' in raw) {
    const rate = Number(raw.failureRateThreshold)
    if (!Number.isFinite(rate) || rate < ROUTER_LIMITS.minFailureRate || rate > ROUTER_LIMITS.maxFailureRate) {
      throw new Error(`router.failureRateThreshold must be between ${ROUTER_LIMITS.minFailureRate} and ${ROUTER_LIMITS.maxFailureRate}`)
    }
    out.failureRateThreshold = rate
  }
  if ('recoveryMode' in raw) {
    if (!ROUTER_RECOVERY_MODES.includes(raw.recoveryMode)) {
      throw new Error(`router.recoveryMode must be one of ${ROUTER_RECOVERY_MODES.join('/')}`)
    }
    out.recoveryMode = raw.recoveryMode
  }
  if ('logLevel' in raw) {
    if (!ROUTER_LOG_LEVELS.includes(raw.logLevel)) {
      throw new Error(`router.logLevel must be one of ${ROUTER_LOG_LEVELS.join('/')}`)
    }
    out.logLevel = raw.logLevel
  }
  return out
}

/**
 * Apply a patch to a document and return the new document.
 *
 * `providers` is a **full replacement** when present, so deleting a provider and
 * editing one are the same operation from the caller's side; `router` is a
 * partial patch. `server.port` may be changed but only takes effect on restart,
 * which {@link module:dsh-prompt-tuner/service/server} reports back.
 *
 * Two things happen *because* providers changed, and both are the point rather
 * than a side effect:
 *
 *   - **The order table is reconciled** ({@link reconcileOrder}). A table is
 *     written against a provider set, so editing the set without touching the
 *     table leaves rows nobody can dial. What was removed comes back to the
 *     caller so the page can say so instead of quietly shrinking.
 *   - **Credential verdicts are cleared** when they can no longer be true: a
 *     rotated secret is a new credential, and a deleted key or provider has no
 *     verdict worth keeping.
 *
 * @param {object} config - the current document.
 * @param {unknown} patch - the proposed patch.
 * @param {{state?: object}} [options] - the runtime state store, so blacklist entries can be maintained.
 * @returns {{config: object, restartRequired: boolean, removedOrderRows: Array<object>}} the new document and what it cost.
 * @throws {Error} when any field cannot be accepted.
 */
export function applyConfigPatch(config, patch, options = {}) {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new Error('patch must be an object')
  const state = options.state ?? null
  const next = normalizeConfig(config)
  let removedOrderRows = []
  if ('providers' in patch) {
    if (typeof patch.providers !== 'object' || patch.providers === null || Array.isArray(patch.providers)) {
      throw new Error('providers must be an object keyed by provider id')
    }
    const providers = {}
    for (const [id, entry] of Object.entries(patch.providers)) {
      const previous = config.providers?.[id]
      const validated = validateProvider(id, entry, { taken: new Set((previous?.keys ?? []).map((existing) => existing.id)) })
      // An empty secret on a credential that already exists means "keep the
      // stored one": the admin page never receives the real secret back, so it
      // cannot echo it, and treating blank as "delete the credential" would make
      // a label edit destructive. A credential with no stored counterpart keeps
      // the blank, which is how a keyless route is configured.
      const stored = new Map((previous?.keys ?? []).map((existing) => [existing.id, existing]))
      const explicitIds = validated.explicitKeyIds ?? new Set()
      const keysInput = validated.keys === undefined ? (previous?.keys ?? []) : validated.keys
      const keys = keysInput.map((entry) => {
        const existing = stored.get(entry.id)
        // Only a credential the caller *named* may inherit the stored secret. A
        // newly added row that happens to be assigned the same id is a different
        // credential and keeps its blank.
        const keep = entry.key === '' && existing !== undefined && (validated.keys === undefined || explicitIds.has(entry.id))
        const key = keep ? existing.key : entry.key
        if (state !== null && existing !== undefined && existing.key !== '' && entry.key !== '' && entry.key !== existing.key) {
          // A rotated secret may well be a working one: drop the old verdict.
          state.clearProvider(id, entry.id)
        }
        return { id: entry.id, label: entry.label ?? '', key }
      })
      providers[id] = {
        ...validated,
        keys,
        // Fields the page does not send are kept, not defaulted: a save that
        // only renames a provider must not reset its timeout or forget the
        // models its upstream listed.
        timeoutMs: validated.timeoutMs ?? previous?.timeoutMs ?? 120_000,
      }
      if (state !== null) {
        const live = new Set(keys.map((entry) => entry.id))
        for (const existing of previous?.keys ?? []) {
          if (!live.has(existing.id)) state.clearProvider(id, existing.id)
        }
      }
    }
    if (state !== null) {
      for (const previousId of Object.keys(config.providers ?? {})) {
        if (!(previousId in providers)) state.clearProvider(previousId)
      }
    }
    next.providers = providers
    const discovered = (providerId) => (state === null ? [] : state.discovered(providerId))
    const reconciled = reconcileOrder(next.router.order, providers, (providerId) => availableModels(providers[providerId], discovered(providerId)))
    next.router = { ...next.router, order: reconciled.order }
    removedOrderRows = reconciled.removed
  }
  if ('router' in patch) {
    next.router = { ...next.router, ...validateRouterPatch(patch.router) }
  }
  let restartRequired = false
  if ('server' in patch) {
    if (typeof patch.server !== 'object' || patch.server === null || Array.isArray(patch.server)) {
      throw new Error('server must be an object')
    }
    if ('port' in patch.server) {
      const port = Number(patch.server.port)
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('server.port must be between 1 and 65535')
      if (port !== next.server.port) restartRequired = true
      next.server = { ...next.server, port }
    }
    if ('host' in patch.server) {
      const host = shortString(patch.server.host)
      if (host === null) throw new Error('server.host must be a non-empty string')
      if (host !== next.server.host) restartRequired = true
      next.server = { ...next.server, host }
    }
  }
  return { config: normalizeConfig(next), restartRequired, removedOrderRows }
}

/**
 * The credential a provider leads with, for the backwards-compatible display
 * fields the plugin's read-only view still reads.
 *
 * The first *set* secret wins, not the first slot: a provider whose k1 was
 * cleared and whose k2 holds the live credential is configured, and reporting
 * "未配置" for it would be a lie the operator cannot debug from the page.
 * @param {object|undefined} provider - the repaired provider.
 * @returns {string} the first non-empty secret, or an empty string.
 */
export function primaryKey(provider) {
  if (!Array.isArray(provider?.keys)) return ''
  for (const entry of provider.keys) {
    if (typeof entry?.key === 'string' && entry.key !== '') return entry.key
  }
  return ''
}

/**
 * Mask a credential for display.
 *
 * The admin API is served over loopback and the page is not readable from
 * another origin, but a key that is never sent back cannot leak through a
 * screenshot, a log line, or a support paste — so the wire format carries only
 * enough to answer "is one set, and is it the one I think it is".
 * @param {string} apiKey - the stored key.
 * @returns {string} `''`, or a short masked form.
 */
export function maskApiKey(apiKey) {
  if (typeof apiKey !== 'string' || apiKey === '') return ''
  if (apiKey.length <= 8) return `${apiKey.slice(0, 2)}…`
  return `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`
}

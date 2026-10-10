#!/usr/bin/env node
/**
 * The routing service's entry point.
 *
 * ## What starts it, and what that costs
 *
 * The plugin forks this process and it dies with DSH. That is a deliberate
 * trade-off, recorded here because it is the kind of thing that is later mistaken
 * for an oversight: a service that outlives the harness needs supervision of its
 * own (this machine already has a convention for that — `systemd-run --user`,
 * which is how `dsh-remote-gateway` survives DSH restarts), and the operator
 * asked for the zero-friction version instead. Nothing in this file cares who
 * started it: run it by hand, from systemd, or from the plugin, and it behaves
 * identically. That is what keeps the extraction honest rather than nominal.
 *
 * ## Configuration is live, not load-once
 *
 * The document is read at boot and then *mutated in place* whenever it changes —
 * by the admin page, or by an editor with the poll noticing. Mutating rather than
 * replacing matters for one reason: the breaker keys its state by provider id and
 * holds it outside the config object, so swapping the object would keep the
 * breakers while an in-place edit keeps everything consistent with what the admin
 * page is showing. Lowering a cooldown therefore does not silently forgive a
 * provider that is still rate limiting.
 *
 * ## Readiness is announced, not inferred
 *
 * The parent needs to know the port is open before it points anything at it, and
 * polling for a socket is a race that presents as an intermittent connection
 * refused. One machine-readable line on stdout after `listen` resolves removes
 * that class of bug.
 *
 * @module dsh-prompt-tuner/service/main
 */
import { statSync } from 'node:fs'
import process from 'node:process'
import { ROUTER_LIMITS, ROUTER_LOG_LEVELS, ROUTER_RECOVERY_MODES, createRouter, switchBudget, unitKey } from './router.js'
import {
  SERVICE_CONFIG_FILE,
  applyConfigPatch,
  availableModels,
  keyUnitsOf,
  maskApiKey,
  primaryKey,
  readConfig,
  writeConfigDocument,
} from './config.js'
import { createConverterRegistry } from './converters/registry.js'
import { createProxy } from './proxy.js'
import { createServer, isLoopback } from './server.js'
import { SERVICE_STATE_FILE, createStateStore } from './state.js'
import { fetchModels } from './upstream.js'

/** Reported in the ready line and on the admin page. */
export const SERVICE_VERSION = '0.1.0'

/** How often the configuration file is checked for an edit made outside the page. */
const CONFIG_POLL_MS = 3_000

/** The line the parent waits for. Kept as a constant so both sides agree. */
export const READY_PREFIX = 'ROUTER_SERVICE_READY '

/** Timestamp and size of a file, or null when it does not exist. */
function fileStamp(path) {
  try {
    const info = statSync(path)
    return `${info.mtimeMs}:${info.size}`
  } catch {
    return null
  }
}

/**
 * Import the converters named in the configuration.
 *
 * An unknown id is a warning rather than a failure: a service that refuses to
 * start because one converter in its manifest was renamed would take the whole
 * machine's routing down over a typo, and the admin page already shows which
 * converters actually loaded.
 * @param {object} registry - the converter registry.
 * @param {Array<string>} ids - configured converter ids.
 * @param {object} logger - the sink.
 * @returns {Promise<{loaded: string[], missing: string[]}>} what happened.
 */
async function loadConverters(registry, ids, logger) {
  const loaded = []
  const missing = []
  for (const id of ids) {
    try {
      const module = await import(new URL(`./converters/${id}.js`, import.meta.url))
      const converter = module.default ?? module.converter ?? null
      if (converter === null) throw new Error('the module has no default export')
      registry.register(converter)
      loaded.push(registry.get(converter.id ?? id)?.id ?? id)
    } catch (cause) {
      missing.push(id)
      logger?.warn?.(`[router-service] converter "${id}" could not be loaded: ${String(cause?.message ?? cause)}`)
    }
  }
  return { loaded, missing }
}

/**
 * Start the service.
 *
 * @param {object} [options] - overrides, used by the self-test.
 * @param {boolean} [options.seed] - whether a missing configuration file may be created.
 * @param {boolean} [options.poll] - whether to watch the configuration file for external edits.
 * @param {boolean} [options.listen] - whether to bind a socket (`false` builds everything but stays offline).
 * @param {{error?: Function, warn?: Function, info?: Function, debug?: Function}} [options.logger] - sink.
 * @param {string} [options.version] - reported version.
 * @returns {Promise<object>} the running service handle.
 */
export async function startService(options = {}) {
  const logger = options.logger ?? console
  const version = options.version ?? SERVICE_VERSION
  const shouldListen = options.listen !== false
  const shouldPoll = options.poll !== false
  const read = readConfig({ seed: options.seed !== false })
  const document = read.config

  // The breaker reads this object at every use, and it is the same object the
  // document holds, so an edit reaches both the policy and the state machine.
  const routerConfig = document.router
  const router = createRouter(routerConfig)

  const registry = createConverterRegistry()
  const loaded = await loadConverters(registry, document.converters, logger)

  // Runtime state lives beside the configuration but in its own file: what the
  // service learns (a dead credential, a model list) must never be able to stop
  // it booting, and the config poller watches only the operator's document.
  const state = createStateStore({ logger })

  const proxy = createProxy({ config: document, router, registry, state, logger })

  let restartRequired = false
  const startedAt = Date.now()

  /**
   * Everything the admin page needs, assembled in one place.
   *
   * The credential list is reported as *visible facts only* — a stable id, a
   * label, a mask, whether a secret is set, and any blacklist verdict. The secret
   * itself never crosses this boundary, which is why the page's "leave it blank
   * to keep it" rule is not a convenience but the only possible edit for an
   * existing credential.
   */
  function statePayload() {
    const live = proxy.state()
    const at = Date.now()
    const providers = Object.values(document.providers).map((provider) => {
      const keys = (Array.isArray(provider.keys) ? provider.keys : []).map((entry) => {
        const unit = unitKey(provider.id, entry.id)
        const blocked = state.blocked(unit)
        return {
          id: entry.id,
          label: entry.label ?? '',
          masked: maskApiKey(entry.key),
          set: typeof entry.key === 'string' && entry.key !== '',
          state: router.stateOf(unit, at),
          blacklisted: blocked !== null,
          blacklist: blocked,
        }
      })
      const discovered = state.discovered(provider.id)
      return {
        id: provider.id,
        label: provider.label,
        baseURL: provider.baseURL,
        keys,
        // The single-credential view the plugin's read-only routing tab reads.
        apiKey: maskApiKey(primaryKey(provider)),
        apiKeySet: keys.some((entry) => entry.set === true),
        keyCount: keys.length,
        models: [...provider.models],
        discoveredModels: discovered,
        allModels: availableModels(provider, discovered),
        headers: { ...provider.headers },
        timeoutMs: provider.timeoutMs,
      }
    })
    return {
      version,
      uptimeMs: Date.now() - startedAt,
      server: { host: document.server.host, port: document.server.port },
      configFile: SERVICE_CONFIG_FILE,
      stateFile: SERVICE_STATE_FILE,
      converters: registry.describe(document.providers).map((entry) => ({ ...entry, loaded: loaded.loaded.includes(entry.id) })),
      providers,
      router: { ...document.router, order: document.router.order.map((row) => ({ ...row })), budget: switchBudget(document.router, live.rows.length) },
      rows: live.rows,
      recent: live.recent,
      stats: live.stats,
      blacklist: state.entries(),
      limits: { ...ROUTER_LIMITS },
      recoveryModes: [...ROUTER_RECOVERY_MODES],
      logLevels: [...ROUTER_LOG_LEVELS],
      restartRequired,
    }
  }

  /** Apply a validated document in place, keeping breaker state and identity. */
  function applyInPlace(next) {
    Object.assign(routerConfig, next.router)
    document.providers = next.providers
    document.converters = next.converters
    document.server = next.server
  }

  const admin = {
    state: statePayload,
    converters: () => registry.describe(document.providers),
    save(patch) {
      const result = applyConfigPatch(document, patch, { state })
      writeConfigDocument(result.config)
      applyInPlace(result.config)
      restartRequired = restartRequired || result.restartRequired
      logger?.info?.(`[router-service] configuration saved to ${SERVICE_CONFIG_FILE}`)
      return { ...statePayload(), restartRequired, removedOrderRows: result.removedOrderRows }
    },
    /**
     * Ask one provider which models it serves, and remember the answer.
     *
     * The list is stored in the runtime state rather than the configuration
     * because it is an observation: it changes when the upstream changes, without
     * anyone deciding anything, and the page's model picker needs it to survive a
     * restart.
     *
     * @param {object} body - `{provider, keyId?}`.
     * @returns {Promise<object>} the outcome plus the refreshed state.
     */
    async models(body) {
      const providerId = typeof body?.provider === 'string' ? body.provider : ''
      const provider = document.providers[providerId] ?? null
      if (provider === null) {
        return { fetch: { ok: false, code: 'unconfigured', message: `provider "${providerId}" is not configured`, models: [] }, state: statePayload() }
      }
      const units = keyUnitsOf(provider)
      const wanted = typeof body?.keyId === 'string' && body.keyId !== '' ? body.keyId : null
      const unit = wanted === null ? units[0] : (units.find((entry) => entry.id === wanted) ?? units[0])
      const outcome = await fetchModels({ provider, key: { id: unit.id, key: unit.key } })
      if (outcome.ok === true) state.setDiscovered(providerId, outcome.models)
      return {
        fetch: {
          ok: outcome.ok === true,
          code: outcome.code ?? null,
          message: outcome.message ?? null,
          status: outcome.status,
          ms: outcome.ms,
          models: outcome.models,
          keyId: unit.id,
          provider: providerId,
        },
        state: statePayload(),
      }
    },
    /**
     * Take a credential out of the blacklist.
     *
     * Deliberately manual for auth and permission failures: those describe
     * something a human has to change, and a timer that retried them anyway would
     * turn a clear "rotate this key" into an intermittent mystery. When the
     * upstream names its own reset time the entry expires by itself and this is
     * only needed to hurry it along.
     *
     * @param {object} body - `{provider, keyId?}`.
     * @returns {object} the refreshed state.
     */
    restoreKey(body) {
      const providerId = typeof body?.provider === 'string' ? body.provider : ''
      const keyId = typeof body?.keyId === 'string' && body.keyId !== '' ? body.keyId : null
      const removed = state.clearProvider(providerId, keyId)
      // The breaker's memory of a credential goes with its verdict, or the page
      // would show a restored key still sitting in a cooldown nobody can explain.
      // Restoring one key touches one unit; restoring a whole provider touches
      // every unit it has, including the keyless one.
      if (keyId !== null) {
        router.forget(unitKey(providerId, keyId))
      } else {
        for (const unit of keyUnitsOf(document.providers[providerId])) router.forget(unitKey(providerId, unit.id))
      }
      logger?.info?.(`[router-service] restored ${removed} credential verdict(s) for "${providerId}"`)
      return { removed, state: statePayload() }
    },
    reset: () => ({ ...statePayload(), ...proxy.reset() }),
    /**
     * Run one route's connectivity probe.
     *
     * The model defaults to the provider's first declared model, so the admin
     * page can offer "probe this route" without also asking which model — the
     * table already answered that.
     * @param {string} providerId - the provider id.
     * @param {string} [model] - the model to ask for.
     * @param {string} [keyId] - the credential to probe with.
     * @returns {Promise<{probe: object, state: object}>} the outcome and the refreshed state.
     */
    async probe(providerId, model, keyId) {
      const id = typeof providerId === 'string' ? providerId : ''
      const provider = document.providers[id] ?? null
      const discovered = provider === null ? [] : state.discovered(id)
      const modelId = typeof model === 'string' && model !== ''
        ? model
        : (availableModels(provider, discovered)[0] ?? '')
      const result = await proxy.probe(id, modelId, typeof keyId === 'string' ? keyId : undefined)
      return { probe: result, state: statePayload() }
    },
  }

  const adminAsync = admin

  // The page is loaded lazily and its absence is survivable: the
  // OpenAI-compatible surface is the part that must never be optional, so a
  // missing or broken admin page degrades to a one-line explanation.
  const { renderAdminPage } = await import('./ui.js').catch(() => ({
    renderAdminPage: () => '<!doctype html><meta charset="utf-8"><title>router service</title>'
      + '<p>The admin page module (lib/service/ui.js) could not be loaded. '
      + 'The OpenAI-compatible surface at /v1 is unaffected.</p>',
  }))

  const httpServer = createServer({
    admin: adminAsync,
    proxy,
    renderPage: renderAdminPage,
    identity: { token: document.server.token, version, host: document.server.host, port: document.server.port },
    logger,
  })

  let bound = { host: document.server.host, port: document.server.port }
  if (shouldListen) {
    bound = await httpServer.listen(document.server.host, document.server.port)
    logger?.info?.(`[router-service] listening on http://${bound.host}:${bound.port} (config ${SERVICE_CONFIG_FILE})`)
    logger?.info?.(`[router-service] ${document.router.order.length} route(s), ${loaded.loaded.length} converter(s) loaded${loaded.missing.length > 0 ? `, missing: ${loaded.missing.join(',')}` : ''}`)
  }

  let stamp = fileStamp(SERVICE_CONFIG_FILE)
  let poller = null
  if (shouldPoll) {
    poller = setInterval(() => {
      const next = fileStamp(SERVICE_CONFIG_FILE)
      if (next === stamp) return
      stamp = next
      try {
        const reread = readConfig({ seed: false })
        applyInPlace(reread.config)
        logger?.info?.('[router-service] configuration reloaded after an external edit')
      } catch (cause) {
        logger?.warn?.(`[router-service] configuration reload failed: ${String(cause?.message ?? cause)}`)
      }
    }, CONFIG_POLL_MS)
    poller.unref?.()
  }

  /** Announce readiness in the one format the parent parses. */
  function announce() {
    process.stdout.write(`${READY_PREFIX}${JSON.stringify({ port: bound.port, host: bound.host, version, configFile: SERVICE_CONFIG_FILE, converters: loaded.loaded })}\n`)
  }

  return {
    version,
    config: document,
    router,
    registry,
    proxy,
    server: httpServer,
    bound,
    loaded,
    state: statePayload,
    admin: adminAsync,
    announce,
    /**
     * Stop the service.
     * @returns {Promise<void>} resolves once the socket is closed.
     */
    async stop() {
      if (poller !== null) clearInterval(poller)
      state.flush()
      await httpServer.close().catch(() => {})
    },
  }
}

/**
 * Parse the command line.
 *
 * Deliberately tiny: this process is started by something else and has exactly
 * two useful modes — run, and "is this configuration loadable".
 * @param {Array<string>} argv - arguments after the script name.
 * @returns {{check: boolean, listen: boolean, poll: boolean}} the mode.
 */
export function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv : []
  return {
    check: args.includes('--check'),
    listen: !args.includes('--no-listen'),
    poll: !args.includes('--no-poll'),
  }
}

/** The `--check` mode: load the configuration, report, exit. */
async function checkMode() {
  const read = readConfig({ seed: false })
  const registry = createConverterRegistry()
  const loaded = await loadConverters(registry, read.config.converters, { warn: () => {} })
  const summary = {
    configFile: SERVICE_CONFIG_FILE,
    created: read.created,
    repaired: read.repaired,
    providers: Object.keys(read.config.providers),
    keys: Object.fromEntries(Object.entries(read.config.providers).map(([id, provider]) => [id, keyUnitsOf(provider).length])),
    stateFile: SERVICE_STATE_FILE,
    order: read.config.router.order.length,
    convertersLoaded: loaded.loaded,
    convertersMissing: loaded.missing,
    port: read.config.server.port,
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  return loaded.missing.length === 0 && read.config.router.order.length >= 0 ? 0 : 1
}

/**
 * The process entry point.
 * @param {Array<string>} argv - arguments after the script name.
 * @returns {Promise<number>} the exit code.
 */
export async function main(argv = process.argv.slice(2)) {
  const mode = parseArgs(argv)
  if (mode.check) return checkMode()
  const service = await startService({ listen: mode.listen, poll: mode.poll })
  service.announce()
  const shutdown = async () => {
    await service.stop()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())
  process.on('unhandledRejection', (cause) => {
    process.stderr.write(`[router-service] unhandled rejection: ${String(cause?.stack ?? cause)}\n`)
  })
  return new Promise(() => {})
}

// Only run when executed directly, so importing this module in a test is inert.
if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().then((code) => {
    if (typeof code === 'number') process.exit(code)
  }).catch((cause) => {
    process.stderr.write(`[router-service] failed to start: ${String(cause?.stack ?? cause)}\n`)
    process.exit(1)
  })
}

export { isLoopback }

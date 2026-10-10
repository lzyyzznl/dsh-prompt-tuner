/**
 * The plugin's half of the routing service: start it, attach to it, talk to it.
 *
 * ## The plugin no longer routes anything
 *
 * This module is deliberately thin, and the thinness is the point. Routing and
 * circuit breaking moved out of the plugin's runtime, so what is left here is
 * three jobs that only the *host* can do: fork the service so the operator does
 * not have to remember to start it, tell the settings page where the service is,
 * and forward the tab's three buttons to the service's admin API. There is no
 * breaker state in this process, no order table, and no fallback copy of either —
 * a second implementation would be a second set of bugs.
 *
 * ## Attach before forking
 *
 * A service may already be running: started by hand, by an earlier DSH that is
 * still up, or by `systemd-run --user` for someone who wanted it to outlive the
 * harness. Forking a second one would fail to bind the port and then present as
 * "the routing service is down" — the worst possible diagnosis, because the
 * service is fine. So a live `/healthz` on the configured address wins, and the
 * fork only happens when nothing answers.
 *
 * ## Dying with the harness was a decision
 *
 * The child is not detached and is killed when the plugin's fiber is disposed, so
 * the service's lifetime is DSH's. That is the trade the operator chose for
 * zero-friction startup, and it is worth restating where the code enforces it:
 * the machine already has a convention for the other choice (`systemd-run
 * --user`, which is how `dsh-remote-gateway` survives a DSH restart), and nothing
 * in the service resists being started that way instead.
 *
 * @module dsh-prompt-tuner/service-client
 */
import { fork } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SERVICE_CONFIG_FILE, DEFAULT_PORT, DEFAULT_HOST, normalizeConfig, readConfig } from './service/config.js'

/** How long to wait for the child's readiness line before giving up on it. */
const START_TIMEOUT_MS = 15_000

/** How long an admin request may take. */
const ADMIN_TIMEOUT_MS = 20_000

/** Bounded restarts: a service that cannot stay up must not become a fork bomb. */
const MAX_RESTARTS = 3

/** Delay before restarting a child that died unexpectedly. */
const RESTART_DELAY_MS = 2_000

/** The module the child runs. */
const SERVICE_ENTRY = fileURLToPath(new URL('./service/main.js', import.meta.url))

/**
 * Read the configured address without booting anything.
 *
 * A missing file is normal on a fresh install — the child creates it — so the
 * defaults are the answer here, and the child's own ready line supersedes them.
 * @param {string} file - the configuration path to read.
 * @returns {{host: string, port: number}} the configured address.
 */
function configuredAddress(file) {
  try {
    if (!existsSync(file)) return { host: DEFAULT_HOST, port: DEFAULT_PORT }
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const host = typeof parsed?.server?.host === 'string' ? parsed.server.host : DEFAULT_HOST
    const port = Number.isFinite(parsed?.server?.port) ? parsed.server.port : DEFAULT_PORT
    return { host, port }
  } catch {
    return { host: DEFAULT_HOST, port: DEFAULT_PORT }
  }
}

/**
 * The service's admin token, read from the same file the service reads.
 * @param {string} file - the configuration path to read.
 * @returns {string} the token, or an empty string when there is none yet.
 */
function configuredToken(file) {
  try {
    if (!existsSync(file)) return ''
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return typeof parsed?.server?.token === 'string' ? parsed.server.token : ''
  } catch {
    return ''
  }
}

/**
 * Read a configuration document from an explicit path, repaired into a usable
 * shape. Used only when a caller named a document other than the process-wide
 * default, in which case the module's cached constant is the wrong answer.
 * @param {string} file - the configuration path.
 * @returns {object} the repaired document.
 */
function configuredFile(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return normalizeConfig(parsed)
  } catch {
    return normalizeConfig({})
  }
}

/**
 * Build the client.
 *
 * @param {object} ctx - the host context; `logger` is used for every message.
 * @param {{entry?: string, startTimeoutMs?: number, restart?: boolean}} [internals] - test seams.
 * @returns {object} the client handle.
 */
export function createServiceClient(ctx, internals = {}) {
  const entry = internals.entry ?? SERVICE_ENTRY
  const configFile = internals.configFile ?? SERVICE_CONFIG_FILE
  const startTimeoutMs = internals.startTimeoutMs ?? START_TIMEOUT_MS
  const mayRestart = internals.restart !== false
  const logger = ctx?.logger

  let child = null
  let origin = configuredAddress(configFile)
  let attached = false
  let stopping = false
  let restarts = 0
  let status = 'idle'
  let lastError = null

  const url = () => `http://${origin.host}:${origin.port}`

  /** Log without ever letting a logger failure escape. */
  function log(level, message) {
    try {
      const fn = logger?.[level]
      if (typeof fn === 'function') {
        fn.call(logger, `[prompt-optimizer] routing service: ${message}`)
        return
      }
    } catch {
      // Fall through to the console; a logger must not break startup.
    }
    if (level === 'error') console.error(`[prompt-optimizer] routing service: ${message}`)
  }

  /**
   * Ask the service whether it is up.
   * @param {number} [timeoutMs] - how long to wait.
   * @returns {Promise<boolean>} whether `/healthz` answered.
   */
  async function ping(timeoutMs = 1_500) {
    try {
      const response = await fetch(`${url()}/healthz`, { signal: AbortSignal.timeout(timeoutMs) })
      return response.ok
    } catch {
      return false
    }
  }

  /** Call the admin API. */
  async function admin(path, body) {
    const token = configuredToken(configFile)
    const response = await fetch(`${url()}/admin/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(token === '' ? {} : { 'x-router-token': token }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS),
    })
    const text = await response.text()
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    if (parsed === null) throw new Error(`the routing service answered ${response.status} with a non-JSON body`)
    if (parsed.ok !== true) throw new Error(parsed.error?.message ?? `the routing service answered ${response.status}`)
    return parsed.value
  }

  /** Fork the child and resolve when it prints its readiness line. */
  function spawn() {
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error(`the routing service did not report ready within ${startTimeoutMs}ms`))
      }, startTimeoutMs)
      let instance
      try {
        instance = fork(entry, [], {
          // Not detached: the service's lifetime is the harness's, by decision.
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          // The child must read the same document this client reads, which is not
          // necessarily the one the module loaded with (see `internals.configFile`).
          env: configFile === SERVICE_CONFIG_FILE ? process.env : { ...process.env, ROUTER_SERVICE_CONFIG: configFile },
        })
      } catch (cause) {
        clearTimeout(timer)
        settled = true
        reject(cause)
        return
      }
      child = instance
      let buffered = ''
      instance.stdout?.setEncoding('utf8')
      instance.stdout?.on('data', (text) => {
        buffered += text
        let index = buffered.indexOf('\n')
        while (index >= 0) {
          const line = buffered.slice(0, index).trim()
          buffered = buffered.slice(index + 1)
          if (line.startsWith('ROUTER_SERVICE_READY ')) {
            try {
              const payload = JSON.parse(line.slice('ROUTER_SERVICE_READY '.length))
              if (Number.isFinite(payload?.port)) origin = { host: payload.host ?? origin.host, port: payload.port }
            } catch {
              // The address in the configuration is still a reasonable answer.
            }
            if (!settled) {
              settled = true
              clearTimeout(timer)
              resolve(instance)
            }
          } else if (line !== '') {
            log('debug', line)
          }
          index = buffered.indexOf('\n')
        }
      })
      instance.stderr?.setEncoding('utf8')
      instance.stderr?.on('data', (text) => {
        const line = String(text).trim()
        if (line !== '') log('warn', line)
      })
      instance.on('error', (cause) => {
        if (settled) {
          log('warn', `child error: ${String(cause?.message ?? cause)}`)
          return
        }
        settled = true
        clearTimeout(timer)
        reject(cause)
      })
      instance.on('exit', (code, signal) => {
        child = null
        if (stopping) return
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new Error(`the routing service exited before reporting ready (code ${String(code)}, signal ${String(signal)})`))
          return
        }
        status = 'stopped'
        log('warn', `the routing service exited (code ${String(code)}, signal ${String(signal)})`)
        if (mayRestart && restarts < MAX_RESTARTS) {
          restarts += 1
          log('info', `restarting the routing service (attempt ${restarts}/${MAX_RESTARTS})`)
          setTimeout(() => {
            void start().catch((cause) => log('error', `restart failed: ${String(cause?.message ?? cause)}`))
          }, RESTART_DELAY_MS)
        } else if (mayRestart) {
          status = 'failed'
          log('error', `the routing service will not be restarted again; the model routes it served are now direct`)
        }
      })
    })
  }

  /**
   * Bring the service up: attach to a live one, or fork a new one.
   * @returns {Promise<{mode: 'attached'|'started'|'failed', url: string, error?: string}>} what happened.
   */
  async function start() {
    // The configured file may have been written by another instance since the
    // plugin loaded; re-read so a hand-started service on a moved port is found.
    const reread = configFile === SERVICE_CONFIG_FILE ? readConfig({ seed: false }).config : configuredFile(configFile)
    origin = { host: reread.server.host, port: reread.server.port }
    if (await ping()) {
      attached = true
      status = 'attached'
      log('info', `attached to an already-running service at ${url()}`)
      return { mode: 'attached', url: url() }
    }
    try {
      status = 'starting'
      await spawn()
      restarts = 0
      attached = false
      status = 'running'
      log('info', `started at ${url()}`)
      return { mode: 'started', url: url() }
    } catch (cause) {
      status = 'failed'
      lastError = String(cause?.message ?? cause)
      log('warn', `not running: ${lastError}`)
      return { mode: 'failed', url: url(), error: lastError }
    }
  }

  /** Stop the child, if this plugin owns it. */
  function stop() {
    stopping = true
    if (child !== null) {
      try {
        child.kill('SIGTERM')
      } catch {
        // Already gone.
      }
      child = null
    }
    if (!attached) status = 'stopped'
  }

  /**
   * The routing tab's read: is the service up, and what is it doing?
   * @returns {Promise<object>} `{available, url, configFile, live, error}`.
   */
  async function view() {
    const base = { available: false, url: url(), configFile: SERVICE_CONFIG_FILE, live: null, error: null }
    try {
      const live = await admin('state')
      return { ...base, available: true, live }
    } catch (cause) {
      return { ...base, error: String(cause?.message ?? cause) }
    }
  }

  /** Forward one admin action, returning the service's answer or a failure. */
  async function call(path, body) {
    try {
      return { ok: true, value: await admin(path, body) }
    } catch (cause) {
      return { ok: false, error: { code: 'service', message: String(cause?.message ?? cause) } }
    }
  }

  return {
    start,
    stop,
    ping,
    view,
    call,
    url,
    configFile: () => configFile,
    status: () => status,
    attached: () => attached,
    error: () => lastError,
    token: () => configuredToken(configFile),
  }
}

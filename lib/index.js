/**
 * dsh-prompt-tuner — host half.
 *
 * Owns two things the browser cannot: the configured model routes (`ctx.llm`)
 * and the settings file. The Client half renders the composer control, the
 * review card and the settings page, and calls this half's
 * `/dsh-prompt-optimizer/*` JSON/SSE routes.
 *
 * @module dsh-prompt-tuner
 */
import { ROUTE_PREFIX, registerRoutes } from './routes.js'

/** Loader entry id / plugin name. */
export const name = 'dsh-prompt-tuner'

/**
 * Hard dependencies: the route layer streams through `llm`, answers on
 * `webServer`, and reads the session's own model choice from
 * `agentDefaultModel` — the zero-configuration default. All three are services
 * of the base bundle, and a Cordis service is only readable from a context that
 * declares it, so `agentDefaultModel` is listed rather than probed: without the
 * declaration the "follow the session model" default would silently degrade to
 * "first model in the catalog", which is a different thing wearing the same
 * label.
 */
export const inject = ['llm', 'webServer', 'agentDefaultModel']

/**
 * Mount the route family; the registration is an effect owned by this fiber,
 * so unload/hot-reload removes the routes with the plugin.
 * @param {object} ctx - host root context.
 */
export function apply(ctx) {
  ctx.effect(() => registerRoutes(ctx), 'dsh-prompt-optimizer: routes')
  ctx.logger?.info?.('[prompt-optimizer] routes ready at %s/state|save|optimize', ROUTE_PREFIX)
}

/**
 * dsh-prompt-tuner — host half.
 *
 * Owns the things the browser cannot: the configured model routes (`ctx.llm`),
 * the settings file, the routing half's breaker state, and the session-title
 * refresher that watches conversation logs and re-titles a long session once its
 * opening sentence has stopped describing it. The Client half renders the
 * composer control, the review card and the settings page, and calls this half's
 * `/dsh-prompt-optimizer/*` JSON/SSE routes.
 *
 * @module dsh-prompt-tuner
 */
import { createRouting } from './routing.js'
import { ROUTE_PREFIX, askTitleModel, registerRoutes } from './routes.js'
import { readSettings } from './store.js'
import { installSessionTitles } from './title.js'

/** Loader entry id / plugin name. */
export const name = 'dsh-prompt-tuner'

/**
 * Hard dependencies: the route layer streams through `llm`, answers on
 * `webServer`, and reads the session's own model choice from
 * `agentDefaultModel` — the zero-configuration default. The title refresher
 * reads and watches live sessions through `sessions`. All four are services of
 * the base bundle, and a Cordis service is only readable from a context that
 * declares it, so `agentDefaultModel` is listed rather than probed: without the
 * declaration the "follow the session model" default would silently degrade to
 * "first model in the catalog", which is a different thing wearing the same
 * label.
 */
export const inject = ['llm', 'webServer', 'agentDefaultModel', 'sessions']

/**
 * Mount the route family, the provider-failover hooks and the session-title
 * watcher; every registration is an effect owned by this fiber, so
 * unload/hot-reload removes them with the plugin — including aborting any title
 * call that is still in flight.
 *
 * The routing runtime is created first so the routes can report its live state,
 * and its construction is guarded: the composer controls and the settings page
 * are the plugin's primary job, so a routing half that fails to build must not
 * take the whole plugin down with it — its settings tab says when it is not
 * mounted.
 * @param {object} ctx - host root context.
 */
export function apply(ctx) {
  let routing = null
  try {
    routing = createRouting(ctx)
  } catch (error) {
    ctx.logger?.error?.('[prompt-optimizer] routing half not mounted: %s', String(error?.message ?? error))
  }
  ctx.effect(() => registerRoutes(ctx, routing), 'dsh-prompt-optimizer: routes')
  ctx.effect(() => () => routing?.dispose?.(), 'dsh-prompt-optimizer: routing')
  // The watcher reads its interval and cap from the settings file at every
  // boundary, and is handed the route layer's own model call, so there is one
  // route resolution and one LLM call policy in this plugin, not two.
  installSessionTitles(ctx, {
    readSettings,
    ask: (request) => askTitleModel(ctx, request),
    logger: ctx.logger,
  })
  ctx.logger?.info?.(
    '[prompt-optimizer] session titles: re-summarizing every %s messages',
    String(readSettings().titleRerollTurns),
  )
  ctx.logger?.info?.('[prompt-optimizer] routes ready at %s/state|save|optimize|router.state', ROUTE_PREFIX)
}

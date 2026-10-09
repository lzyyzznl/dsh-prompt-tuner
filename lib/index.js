/**
 * dsh-prompt-tuner — host half.
 *
 * Owns the things the browser cannot: the configured model routes (`ctx.llm`),
 * the settings file, and the session-title refresher that watches conversation
 * logs and re-titles a long session once its opening sentence has stopped
 * describing it. The Client half renders the composer control, the review card
 * and the settings page, and calls this half's `/dsh-prompt-optimizer/*`
 * JSON/SSE routes.
 *
 * @module dsh-prompt-tuner
 */
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
 * Mount the route family and the session-title watcher; both registrations are
 * effects owned by this fiber, so unload/hot-reload removes them with the
 * plugin — including aborting any title call that is still in flight.
 * @param {object} ctx - host root context.
 */
export function apply(ctx) {
  ctx.effect(() => registerRoutes(ctx), 'dsh-prompt-optimizer: routes')
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
  ctx.logger?.info?.('[prompt-optimizer] routes ready at %s/state|save|optimize', ROUTE_PREFIX)
}

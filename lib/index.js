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
 * ## The routing half is no longer in this process
 *
 * Provider failover and circuit breaking used to be mounted here, as two
 * prepended hooks on the agent loop (`agent/request` and `agent/request-error`).
 * They now live in a local service this half starts and talks to over loopback
 * (see `lib/service/`), for reasons that are worth keeping next to the code that
 * used to do the job:
 *
 *   - the failure domain is different from the plugin's. A composer control that
 *     throws costs a button; a breaker that throws costs every model call on the
 *     machine. Splitting the process means the second one cannot be broken by a
 *     bug in the first;
 *   - the audience is different. Failover is useful to every agent on this
 *     machine, not just to a session that happens to have this plugin installed;
 *   - the mechanism is different. Hooks could only change route *between*
 *     attempts, so the caller saw every failed hop. A proxy owns the socket and
 *     fails over invisibly, which is what the operator actually wanted when they
 *     asked for "switch, don't wait out the backoff".
 *
 * What is left here is one lifecycle object and a route family that forwards
 * three buttons. The `inject` list stays the same: the plugin still needs `llm`
 * for the rewrite, side-question, title and notification halves, and
 * `webServer`/`agentDefaultModel`/`sessions` for the reasons below.
 *
 * @module dsh-prompt-tuner
 */
import { ROUTE_PREFIX, askTitleModel, registerRoutes } from './routes.js'
import { createServiceClient } from './service-client.js'
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
 * Mount the route family, start the routing service and install the
 * session-title watcher; every registration is an effect owned by this fiber, so
 * unload/hot-reload removes them with the plugin — including stopping the
 * service this plugin started and aborting any title call still in flight.
 *
 * The service client is created first so the routes can report its state from
 * their first answer, and its startup is deliberately *not* awaited: the
 * composer controls and the settings page are this plugin's primary job, and a
 * routing service that is slow, missing or broken must not delay them. The
 * routing tab says which of those happened.
 * @param {object} ctx - host root context.
 */
export function apply(ctx) {
  const service = createServiceClient(ctx)
  ctx.effect(() => registerRoutes(ctx, service), 'dsh-prompt-optimizer: routes')
  ctx.effect(() => {
    // `void`, not `await`: see the note above. `stop()` is sync and idempotent,
    // so the disposer is safe even if startup is still in flight.
    void service.start().then((outcome) => {
      if (outcome.mode === 'failed') {
        ctx.logger?.warn?.('[prompt-optimizer] routing service not started: %s', String(outcome.error ?? 'unknown'))
      }
    })
    return () => service.stop()
  }, 'dsh-prompt-optimizer: routing service')
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

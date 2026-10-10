/**
 * The protector registry: how a protocol converter gets into the routing
 * service, and how a request finds the one that applies to it.
 *
 * ## What a converter is
 *
 * A converter is a *code module* — not a declaration. That is a deliberate
 * choice, and it follows from what converters actually have to do: rename a
 * field on every chunk of a streaming SSE response, synthesise a usage block the
 * upstream never sent, decide whether a body the upstream returned is even
 * parseable, and turn a vendor's error envelope into the reference contract's
 * error envelope while the response is still open. Those are state machines, not
 * substitution tables, and a JSON rule language able to express them would be a
 * worse programming language with no debugger.
 *
 * ## Registration is a startup manifest plus a hook
 *
 * The operator lists converter ids in the service configuration
 * (`"converters": ["maas"]`); the service imports each module by id and hands it
 * to {@link createConverterRegistry}. That is the whole registration story: the
 * caller decides *what* is available, the converter decides *what it applies
 * to*. {@link defineConverter} fills in the no-op defaults, so a converter that
 * only normalises responses is two functions long.
 *
 * ## Matching is the converter's business
 *
 * The registry does not map converter→provider from configuration, because the
 * fact that decides it ("this base URL is the ZTE gateway") lives in the
 * converter's own knowledge, not in an operator's. A converter's `match` gets
 * the resolved route and answers yes or no; the first registered converter that
 * claims a route wins, so ordering in the manifest is the tie-break.
 *
 * @module dsh-prompt-tuner/service/converters/registry
 */

/**
 * The reference northbound contract, named in one place.
 *
 * Every converter targets this, so "consistent with official" has a single
 * meaning across modules rather than being re-argued per converter.
 */
export const REFERENCE_CONTRACT = 'api.deepseek.com/v1 (OpenAI chat.completions)'

/** One converter id: lowercase, short, stable — it appears in config and logs. */
const ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

/**
 * Complete a converter definition with no-op defaults and validate its shape.
 *
 * Defaults are the pass-through behaviour: no matching, no rewriting, no model
 * list. A converter therefore only implements the axis it actually changes, and
 * an unfinished converter degrades to "the service behaves as if it were not
 * there" rather than to a broken request.
 *
 * @param {object} definition - the converter.
 * @param {string} definition.id - stable id used in configuration.
 * @param {string} definition.label - human name for the admin page.
 * @param {(route: {provider: object, model: string}) => boolean} [definition.match] - whether this converter owns a route.
 * @param {(body: object, ctx: object) => object|Promise<object>} [definition.toUpstream] - reference contract request → upstream request.
 * @param {(payload: object, ctx: object) => object} [definition.fromUpstream] - upstream JSON response → reference contract response.
 * @param {(chunk: object, ctx: object) => object|null} [definition.fromUpstreamChunk] - one upstream SSE data object → one reference contract chunk (`null` drops it).
 * @param {(failure: {status: number, body: object|null}, ctx: object) => {status: number, body: object}} [definition.errorBody] - upstream error → reference contract error.
 * @param {(ctx: object) => Array<object>} [definition.listModels] - extra `/v1/models` entries this converter knows about.
 * @returns {object} a frozen converter ready to register.
 * @throws {Error} when the definition cannot be registered.
 */
export function defineConverter(definition) {
  if (typeof definition !== 'object' || definition === null || Array.isArray(definition)) {
    throw new Error('converter definition must be an object')
  }
  const id = typeof definition.id === 'string' ? definition.id.trim() : ''
  if (!ID_PATTERN.test(id)) throw new Error(`converter id "${String(definition.id)}" must match ${String(ID_PATTERN)}`)
  const label = typeof definition.label === 'string' && definition.label.trim() !== '' ? definition.label.trim() : id
  const functions = ['match', 'toUpstream', 'fromUpstream', 'fromUpstreamChunk', 'errorBody', 'listModels']
  for (const key of functions) {
    if (definition[key] !== undefined && typeof definition[key] !== 'function') {
      throw new Error(`converter "${id}": ${key} must be a function`)
    }
  }
  return Object.freeze({
    id,
    label,
    match: typeof definition.match === 'function' ? definition.match : () => false,
    toUpstream: typeof definition.toUpstream === 'function' ? definition.toUpstream : (body) => body,
    fromUpstream: typeof definition.fromUpstream === 'function' ? definition.fromUpstream : (payload) => payload,
    fromUpstreamChunk: typeof definition.fromUpstreamChunk === 'function' ? definition.fromUpstreamChunk : (chunk) => chunk,
    errorBody: typeof definition.errorBody === 'function'
      ? definition.errorBody
      : (failure) => ({ status: failure.status, body: failure.body ?? { error: { message: 'upstream error' } } }),
    listModels: typeof definition.listModels === 'function' ? definition.listModels : () => [],
  })
}

/**
 * Build the registry.
 *
 * Registration is one-shot and total: a duplicate id is a configuration mistake
 * that would otherwise make which converter ran depend on import order, so it
 * throws instead of overwriting.
 * @returns {{
 *   register: (converter: object) => object,
 *   registerAll: (converters: Array<object>) => void,
 *   list: () => Array<object>,
 *   get: (id: string) => object|null,
 *   forRoute: (route: {provider: object, model: string}) => object|null,
 *   describe: (providers: object) => Array<object>,
 * }} the registry.
 */
export function createConverterRegistry() {
  /** @type {Map<string, object>} insertion-ordered, so the manifest is the tie-break. */
  const converters = new Map()

  function register(converter) {
    const ready = Object.isFrozen(converter) ? converter : defineConverter(converter)
    if (converters.has(ready.id)) throw new Error(`converter "${ready.id}" is already registered`)
    converters.set(ready.id, ready)
    return ready
  }

  function registerAll(list) {
    for (const converter of Array.isArray(list) ? list : []) register(converter)
  }

  const list = () => [...converters.values()]
  const get = (id) => converters.get(id) ?? null

  /**
   * The converter that owns a route, or null for pass-through.
   *
   * A converter that throws while answering `match` is treated as not matching:
   * a broken matcher must not be able to fail every request on the machine, and
   * the failure is visible where it matters — the route simply reads as
   * unconverted on the admin page.
   * @param {{provider: object, model: string}} route - the resolved route.
   * @returns {object|null} the converter, or null.
   */
  function forRoute(route) {
    for (const converter of converters.values()) {
      try {
        if (converter.match(route) === true) return converter
      } catch {
        continue
      }
    }
    return null
  }

  /**
   * Describe the registry for the admin page: which converter claims which
   * configured provider, and which models it advertises.
   * @param {object} providers - the configured provider map (id → provider).
   * @returns {Array<object>} one entry per registered converter.
   */
  function describe(providers = {}) {
    const entries = Object.values(providers)
    return list().map((converter) => {
      const claimed = []
      const models = []
      for (const provider of entries) {
        const providerModels = Array.isArray(provider.models) && provider.models.length > 0 ? provider.models : ['']
        const hit = providerModels.some((model) => {
          try {
            return converter.match({ provider, model }) === true
          } catch {
            return false
          }
        })
        if (!hit) continue
        claimed.push(provider.id)
        for (const model of providerModels) if (model !== '' && !models.includes(model)) models.push(model)
      }
      return { id: converter.id, label: converter.label, providers: claimed, models }
    })
  }

  return { register, registerAll, list, get, forRoute, describe }
}

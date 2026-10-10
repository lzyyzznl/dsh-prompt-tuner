/**
 * Time-slot routing: which providers to prefer at the current clock time.
 *
 * The routing service's order table is positional — the first row wins, the
 * rest follow in configured order. Time slots add a *temporal* first cut on top
 * of that position: a provider that matches the current slot is tried before
 * every provider that does not, and everything else keeps its static order.
 *
 * ## The rules this module owns
 *
 *  1. **Time beats position.** Among the rows it is handed, a provider named by
 *     the active slot sorts above every provider that is not, no matter where
 *     either sits in the table. The caller may *pin* leading rows out of that
 *     comparison ({@link applyTimeOrder}'s `pin`): the proxy pins the one row
 *     `resolveRoute` already moved to the front, because the clock decides the
 *     failover order, not what an explicitly requested provider/model means.
 *  2. **Absent and unmatched are the same tier.** A provider that has no slot
 *     config at all and one whose slots simply do not match right now sort
 *     together, by static position only.
 *  3. **Within the active slot, position still decides.** The time-matched rows
 *     keep their configured relative order, and the priority *numbers* never
 *     reorder them — they exist to report, and to disable with `0`.
 *
 * Everything here is a pure function over plain arrays — no imports, no I/O,
 * an injectable clock where a clock is needed — so the unit tests can pin the
 * resolution rules without standing up the service.
 */

/**
 * A provider named `0` in a slot means "do not use this provider during this
 * slot": its rows are excluded from the candidate chain entirely, exactly like
 * a blacklist entry but decided by the clock instead of by a failure.
 */
export const PRIORITY_DISABLED = 0

/** Highest allowed priority number; lower is more preferred. */
export const PRIORITY_DEFAULT_MAX = 9

/** How many slot rules one router config may carry, so a hand-written file
 * cannot make the admin page enumerate forever. Mirrors {@link ROUTER_LIMITS.orderRows}. */
export const TIME_SLOT_LIMIT = 24

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/
const MINUTES_PER_DAY = 24 * 60

/**
 * Parse one `HH:mm` clock string to minutes since midnight, or null.
 * Accepts one-digit hours but returns the canonical zero-padded spelling.
 * @param {unknown} text - the stored clock string.
 * @returns {number|null} minutes since midnight, or null when unusable.
 */
export function parseClock(text) {
  if (typeof text !== 'string') return null
  const match = HHMM.exec(text.trim())
  if (match === null) return null
  return Number(match[1]) * 60 + Number(match[2])
}

/**
 * Format minutes since midnight back to canonical `HH:mm`.
 * @param {number} minutes - 0..1439.
 * @returns {string} the clock string.
 */
export function formatClock(minutes) {
  const safe = Math.max(0, Math.min(MINUTES_PER_DAY - 1, Math.trunc(minutes)))
  const h = String(Math.floor(safe / 60)).padStart(2, '0')
  const m = String(safe % 60).padStart(2, '0')
  return `${h}:${m}`
}

/**
 * Does `time` fall inside `[start, end)`, allowing `end <= start` to mean
 * overnight? A rule whose `end` equals its `start` is treated as the whole day,
 * but that spelling never survives the config layer: {@link validateTimeSlots}
 * rejects it and {@link normalizeTimeSlots} drops it, so the branch is here for
 * direct callers rather than for stored files.
 * @param {number} time - minutes since midnight.
 * @param {number} start - minutes since midnight.
 * @param {number} end - minutes since midnight, wrap-allowed.
 * @returns {boolean} whether the moment is inside the interval.
 */
export function clockInside(time, start, end) {
  if (start === end) return true // whole-day rule
  if (start < end) return time >= start && time < end
  return time >= start || time < end // overnight
}

/**
 * The length of one slot in minutes, wrap-aware. A whole-day rule is full
 * length. Used as the "most specific" measure: a shorter window is more
 * specific than a longer one, and the shortest match wins.
 * @param {number} start - minutes since midnight.
 * @param {number} end - minutes since midnight, wrap-allowed.
 * @returns {number} the duration in minutes (1..1440).
 */
export function slotLength(start, end) {
  if (start === end) return MINUTES_PER_DAY
  return start < end ? end - start : MINUTES_PER_DAY - start + end
}

/**
 * Repair one time-slot table. Unusable rules are dropped rather than rejected
 * (reads repair, writes reject), and the table is capped.
 *
 * A rule is usable when both clocks parse, lists at least one provider, and
 * every priority is an integer in the allowed range. `priority` entries are
 * kept as a plain provider-id → integer map; empty entries are dropped.
 * @param {unknown} value - the stored `router.timeSlots`.
 * @returns {Array<{start: string, end: string, priority: Record<string, number>}>} the rules that survived.
 */
export function normalizeTimeSlots(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    if (out.length >= TIME_SLOT_LIMIT) break
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const start = parseClock(entry.start)
    const end = parseClock(entry.end)
    if (start === null || end === null) continue
    // A zero-length window is rejected on write (see {@link validateTimeSlots}),
    // so a file that carries one is repaired by dropping it rather than being
    // silently promoted into an all-day rule the operator never asked for.
    if (start === end) continue
    const priority = {}
    if (typeof entry.priority === 'object' && entry.priority !== null && !Array.isArray(entry.priority)) {
      for (const [provider, raw] of Object.entries(entry.priority)) {
        const n = Number(raw)
        if (!Number.isFinite(n) || !Number.isInteger(n)) continue
        if (n < PRIORITY_DISABLED || n > PRIORITY_DEFAULT_MAX) continue
        if (provider.trim() === '') continue
        priority[provider.trim()] = n
      }
    }
    if (Object.keys(priority).length === 0) continue
    out.push({ start: formatClock(start), end: formatClock(end), priority })
  }
  return out
}

/**
 * Validate a proposed time-slot table, rejecting rather than repairing. Used by
 * the admin save path so a bad slot cannot be written.
 * @param {unknown} raw - the proposed `router.timeSlots`.
 * @returns {Array<object>} the accepted rules.
 * @throws {Error} when any rule cannot be accepted.
 */
export function validateTimeSlots(raw) {
  if (!Array.isArray(raw)) throw new Error('router.timeSlots must be an array')
  if (raw.length > TIME_SLOT_LIMIT) {
    throw new Error(`router.timeSlots may hold at most ${TIME_SLOT_LIMIT} rules`)
  }
  const out = []
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`router.timeSlots[${index}] must be an object`)
    }
    const start = parseClock(entry.start)
    if (start === null) {
      throw new Error(`router.timeSlots[${index}].start must be a HH:mm clock time`)
    }
    const end = parseClock(entry.end)
    if (end === null) {
      throw new Error(`router.timeSlots[${index}].end must be a HH:mm clock time`)
    }
    if (end === start) {
      throw new Error(`router.timeSlots[${index}]: start and end must not be equal (a whole-day slot is not allowed; remove the rule instead)`)
    }
    const priority = {}
    if (typeof entry.priority !== 'object' || entry.priority === null || Array.isArray(entry.priority)) {
      throw new Error(`router.timeSlots[${index}].priority must be an object keyed by provider id`)
    }
    for (const [provider, rawValue] of Object.entries(entry.priority)) {
      const id = provider.trim()
      if (id === '') throw new Error(`router.timeSlots[${index}].priority has an empty provider key`)
      const n = Number(rawValue)
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        throw new Error(`router.timeSlots[${index}].priority["${id}"] must be an integer`)
      }
      if (n < PRIORITY_DISABLED || n > PRIORITY_DEFAULT_MAX) {
        throw new Error(`router.timeSlots[${index}].priority["${id}"] must be between ${PRIORITY_DISABLED} and ${PRIORITY_DEFAULT_MAX}`)
      }
      priority[id] = n
    }
    if (Object.keys(priority).length === 0) {
      throw new Error(`router.timeSlots[${index}].priority must name at least one provider`)
    }
    out.push({ start: formatClock(start), end: formatClock(end), priority })
  }
  return out
}

/**
 * Pick the single active rule at a moment, deterministically.
 *
 * Resolution (most specific first):
 *  1. Among the rules whose window contains this moment, the shortest window
 *     wins — a 06:00–07:00 rule is more specific than 00:00–23:59, and an
 *     overnight 22:00–02:00 (240 min) loses to a 23:00–23:30 (30 min) inside it.
 *  2. Ties go to the rule defined first in the table.
 * @param {Array<object>} rules - normalized time-slot rules.
 * @param {number} minutes - minutes since midnight, or the current wall clock.
 * @returns {object|null} `{ rule, index }` for the winning rule, or null when
 *   nothing matches.
 */
export function activeRuleAt(rules, minutes) {
  const list = Array.isArray(rules) ? rules : []
  if (list.length === 0) return null
  const time = Math.floor(Number(minutes))
  const matching = []
  for (const [index, rule] of list.entries()) {
    const start = parseClock(rule.start)
    const end = parseClock(rule.end)
    if (start === null || end === null) continue
    if (!clockInside(time, start, end)) continue
    matching.push({ rule, index, length: slotLength(start, end) })
  }
  if (matching.length === 0) return null
  // Shortest window first, ties to the rule written first. Deliberately *not*
  // "exact start wins": with `08:00-17:00` and `08:00-09:00` both present that
  // would flip to the broad rule for the single minute 08:00 and back at 08:01,
  // so a boundary would behave differently from either side of it. Ranking by
  // length alone is continuous and still prefers the more specific rule.
  matching.sort((a, b) => a.length - b.length || a.index - b.index)
  return matching[0]
}

/**
 * The effective priority of one provider at a moment, under a set of rules.
 * @param {Array<object>} rules - normalized time-slot rules.
 * @param {string} providerId - the provider id.
 * @param {number} minutes - minutes since midnight.
 * @returns {number|null} the priority number (0 = disabled), or null when the
 *   provider is not named by the active slot (→ static order).
 */
export function providerPriorityAt(rules, providerId, minutes) {
  const active = activeRuleAt(rules, minutes)
  if (active === null) return null
  const value = active.rule.priority?.[providerId]
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

/**
 * Reorder a candidate row chain by the active time slot, per the one rule this
 * module owns. Stable: rows keep their relative order inside each tier.
 *
 * @param {Array<object>} rows - the resolved candidate rows (already rotated so
 *   the request-matching row is first).
 * @param {Array<object>|null} rules - normalized time-slot rules.
 * @param {number} minutes - minutes since midnight (or the wall clock).
 * @param {{pin?: number}} [options] - `pin` leading rows are held in place and
 *   excluded from the partition. The proxy passes `pin: 1` because
 *   {@link resolveRoute} has already put the caller-designated row first: the
 *   clock decides the *failover* order, it does not overrule an explicit
 *   provider/model the caller asked for.
 * @returns {{rows: Array<object>, disabled: Array<object>, active: object|null}}
 *   - `rows` — time-matched rows first (static order within), then the rest
 *     (static order); disabled rows removed from the chain.
 *   - `disabled` — rows excluded because their provider is `0` in the slot.
 *   - `active` — the winning rule (for reporting), or null.
 */
export function applyTimeOrder(rows, rules, minutes, options = {}) {
  const chain = Array.isArray(rows) ? rows : []
  if (chain.length === 0 || !Array.isArray(rules) || rules.length === 0) {
    return { rows: chain, disabled: [], active: null }
  }
  const time = Math.floor(Number(minutes))
  const active = activeRuleAt(rules, time)
  if (active === null) return { rows: chain, disabled: [], active: null }
  const pin = Math.max(0, Math.min(chain.length, Math.floor(Number(options.pin) || 0)))
  const head = pin > 0 ? chain.slice(0, pin) : []
  const matched = []
  const rest = []
  const disabled = []
  for (const row of chain.slice(pin)) {
    const value = active.rule.priority?.[row.provider]
    if (value === PRIORITY_DISABLED) {
      disabled.push(row)
    } else if (typeof value === 'number' && Number.isInteger(value)) {
      matched.push(row)
    } else {
      rest.push(row)
    }
  }
  return { rows: [...head, ...matched, ...rest], disabled, active }
}

/**
 * A short label for the active rule, for log lines and the admin page.
 * @param {object} yes - the winning rule.
 * @returns {string} like `22:00-02:00`.
 */
export function ruleLabel(rule) {
  if (typeof rule?.start !== 'string' || typeof rule?.end !== 'string') return ''
  return `${rule.start}-${rule.end}`
}

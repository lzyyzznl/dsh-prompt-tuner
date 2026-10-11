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
 *
 * The module also owns the **built-in business rule** (the `router.businessRule`
 * switch): the Beijing Mon–Fri peak/off-peak calendar and the holiday table it
 * reads. It reuses rules 1–3 above unchanged — it only replaces *which* window
 * counts as active, and takes its priority numbers from the operator's
 * `timeSlots` table. See the "Built-in business rule" block further down.
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
  const active = activeRuleAt(rules, Math.floor(Number(minutes)))
  if (active === null) return { rows: chain, disabled: [], active: null }
  return partitionByRule(chain, active, options)
}

/**
 * Reorder a candidate chain around one already-active rule. This is the shared
 * core behind both time-slot selection and the built-in business rule: given a
 * rule whose `priority` maps providers to numbers (`0` = disabled), it holds
 * the first `pin` rows in place, then puts named providers ahead of everyone
 * else (stable within each tier) and drops the disabled ones from the chain.
 *
 * @param {Array<object>} rows - the resolved candidate rows (already rotated so
 *   the request-matching row is first).
 * @param {{rule: object}} active - a `{ rule, index }`-shaped object whose
 *   `.rule.priority` drives the partition.
 * @param {{pin?: number}} [options] - `pin` leading rows are held in place and
 *   excluded from the partition. The proxy passes `pin: 1` because
 *   {@link resolveRoute} has already put the caller-designated row first: the
 *   clock decides the *failover* order, it does not overrule an explicit
 *   provider/model the caller asked for.
 * @returns {{rows: Array<object>, disabled: Array<object>, active: object|null}}
 */
export function partitionByRule(rows, active, options = {}) {
  const chain = Array.isArray(rows) ? rows : []
  if (chain.length === 0 || !active?.rule) return { rows: chain, disabled: [], active: active ?? null }
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

/**
 * ## Built-in business rule
 *
 * Behind a single `businessRule: true` switch the router stops reading the
 * caller's arbitrary `timeSlots` windows and instead decides which suppliers to
 * prefer from the *Beijing* calendar: 周一至周五 (Mon–Fri), excluding China's
 * statutory public holidays, with 09:00–12:00 and 14:00–18:00 counting as
 * **peak** and everything else as **off-peak** (including all of the weekend
 * and all statutory-holiday days).
 *
 * The clock is fixed to Beijing time (UTC+8) regardless of the process's own
 * time zone, because "China statutory holiday" is inherently a China-time
 * concept and the day of week is about where people are, not where the box sits.
 *
 * The provider *priorities* still come from the operator's `timeSlots` table,
 * but only their numbers are reused — a provider's effective peak tier is the
 * lowest number it carries anywhere in `timeSlots` (a `0` disables it for peak;
 * a provider with no entry at all stays in static order). The `start`/`end`
 * windows of `timeSlots` are deliberately ignored while the business rule is on.
 */

const BEIJING_OFFSET_MS = 8 * 3600 * 1000

/**
 * Built-in statutory public-holiday table, as `YYYY-MM-DD`. Treating any listed
 * day as a holiday no matter its weekday is what makes a national day off stay
 * off-peak even when it falls on a workday.
 *
 * This is a pragmatic stock set for 2025 and 2026; the exact Cabinet (国务院)
 * annual arrangement — including its makeup workdays — must be maintained by
 * the operator by editing this table (or supplying one in config later).
 */
export const STATUTORY_HOLIDAYS = (() => {
  const days = new Set([
    // 2025
    '2025-01-01', // 元旦
    '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31', '2025-02-01', '2025-02-02', '2025-02-03', '2025-02-04', // 春节
    '2025-04-04', '2025-04-05', '2025-04-06', // 清明
    '2025-05-01', '2025-05-02', '2025-05-03', '2025-05-04', '2025-05-05', // 劳动节
    '2025-05-31', '2025-06-01', '2025-06-02', // 端午
    '2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07', '2025-10-08', // 中秋+国庆
    // 2026
    '2026-01-01', '2026-01-02', '2026-01-03', // 元旦
    '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', // 春节
    '2026-04-04', '2026-04-05', '2026-04-06', // 清明
    '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05', // 劳动节
    '2026-06-19', '2026-06-20', '2026-06-21', // 端午
    '2026-09-25', '2026-09-26', '2026-09-27', // 中秋
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', // 国庆
  ])
  return [...days]
})()

function beijingPad(n) {
  return String(n).padStart(2, '0')
}

/**
 * The Beijing wall-clock parts of an instant, independent of the process time
 * zone. Weekday uses 1 = Monday … 7 = Sunday and `minutes` is 0..1439 since
 * midnight in Beijing.
 * @param {number|Date} date - an instant (ms or Date).
 * @returns {{year: number, month: number, day: number, weekday: number, minutes: number}}
 */
export function beijingDateParts(date) {
  const t = date instanceof Date ? date.getTime() : Number(date)
  const b = new Date(Number.isFinite(t) ? t + BEIJING_OFFSET_MS : NaN)
  if (Number.isNaN(b.getTime())) return { year: NaN, month: NaN, day: NaN, weekday: NaN, minutes: NaN }
  const dow = b.getUTCDay() // 0 = Sun … 6 = Sat
  return {
    year: b.getUTCFullYear(),
    month: b.getUTCMonth() + 1,
    day: b.getUTCDate(),
    weekday: dow === 0 ? 7 : dow,
    minutes: b.getUTCHours() * 60 + b.getUTCMinutes(),
  }
}

function beijingKey(parts) {
  return `${parts.year}-${beijingPad(parts.month)}-${beijingPad(parts.day)}`
}

/** Is the Beijing calendar date one of the listed statutory holidays? */
export function isStatutoryHoliday(parts, table = STATUTORY_HOLIDAYS) {
  if (typeof parts?.year !== 'number' || !Array.isArray(table) || table.length === 0) return false
  return table.includes(beijingKey(parts))
}

/**
 * The built-in rule's verdict for an instant: `peak` on a Mon–Fri non-holiday
 * workday inside 09:00–12:00 or 14:00–18:00, otherwise `off-peak`.
 * @param {number|Date} date - an instant.
 * @param {Array<string>} [table] - holiday table override (default built-in).
 * @returns {{status: 'peak'|'off-peak', weekday: number, minutes: number,
 *   weekend: boolean, holiday: boolean, date: string}}
 */
export function beijingPeakStatus(date, table = STATUTORY_HOLIDAYS) {
  const p = beijingDateParts(date)
  if (!Number.isFinite(p.year)) return { status: 'off-peak', weekday: NaN, minutes: NaN, weekend: false, holiday: false, date: '' }
  const weekend = p.weekday > 5
  const holiday = isStatutoryHoliday(p, table)
  const inMorning = p.minutes >= 9 * 60 && p.minutes < 12 * 60
  const inAfternoon = p.minutes >= 14 * 60 && p.minutes < 18 * 60
  return {
    status: (!weekend && !holiday && (inMorning || inAfternoon)) ? 'peak' : 'off-peak',
    weekday: p.weekday,
    minutes: p.minutes,
    weekend,
    holiday,
    date: beijingKey(p),
  }
}

/**
 * A provider's effective peak tier under the business rule: the lowest priority
 * number it carries anywhere in `timeSlots` (`0` disables it; a provider with
 * no entry keeps no tier → static order). The `start`/`end` windows of the
 * table are irrelevant here.
 * @param {unknown} timeSlots - the `router.timeSlots` value.
 * @returns {Record<string, number>}
 */
export function effectiveBusinessPriority(timeSlots) {
  const min = {}
  const slots = Array.isArray(timeSlots) ? timeSlots : []
  for (const slot of slots) {
    if (!slot || typeof slot !== 'object' || typeof slot.priority !== 'object' || slot.priority === null) continue
    for (const [provider, num] of Object.entries(slot.priority)) {
      if (typeof num !== 'number' || !Number.isInteger(num) || num < 0 || num > PRIORITY_DEFAULT_MAX) continue
      min[provider] = min[provider] === undefined ? num : Math.min(min[provider], num)
    }
  }
  return min
}

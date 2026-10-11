/**
 * The calendar: which billing period (峰/谷) is Beijing in right now?
 *
 * Which *days* count as 高峰 is taken from the reference (DeepSeek's API pricing
 * description), not from the government's definition of a working day:
 * **调休上班的周末与中国法定节假日全天都按空闲时段计费**. A Saturday made into a
 * compulsory workday (调休补班) is therefore still off-peak here, even though
 * people do go to the office. Which *hours* of a workday are peak is this
 * service's own setting, not the reference's (see `time-slots.js`).
 *
 * That gives two facts to establish, and two sources for them:
 *
 *   1. *Is this a weekend?* — pure calendar arithmetic, never negotiable. A
 *      weekend is off-peak whatever anyone else says.
 *   2. *Is this weekday a statutory holiday?* — this is where the built-in
 *      holiday table is weakest: it is a hand-written list, it has no idea what
 *      next year's announcement will be, and a typo in it silently misprices a
 *      day. The public working-day service answers exactly that
 *      (`is_workingday`), so it is consulted as a *correction layer*: one query
 *      per Beijing date, cached in the runtime state file, asked at most once a
 *      day (the endpoint rate-limits after a handful of calls), and every
 *      failure mode — no network, timeout, non-JSON, `status: 0` rate limit, an
 *      answer about another date — falls back to the built-in table and backs
 *      off instead of guessing.
 *
 * So the external answer may **take peak away** from a weekday (it says the day
 * is not a working day) but may never **give peak to a weekend**. The `makeup`
 * flag records the case where it says a weekend is a working day, so the page can
 * explain itself instead of looking broken.
 *
 * `status()` is **synchronous and never throws**: routing decisions read the
 * cached verdict, so no request ever waits on the network — refreshing is a
 * background job owned by the service lifecycle. A workday inside the peak
 * windows (09:00–12:00, 14:00–18:00) uses the peak order table; everything else is
 * off-peak. The calendar never reorders anything — it only decides *which* table
 * applies.
 */
import { beijingDateKey, beijingPeakStatus } from './time-slots.js'

/** The public working-day endpoint; `?date=YYYY-MM-DD` picks a date. */
export const WORKDAY_API_URL = 'https://www.iamwawa.cn/workingday/api'

/** How long one query may take before it is abandoned. */
export const WORKDAY_TIMEOUT_MS = 3_000

/**
 * How long to wait after a failed query before asking again. A whole day's
 * verdict is cached on success, so this only paces *failures* — which is what
 * keeps a rate-limited or offline endpoint from being hammered by a busy
 * service (the endpoint answers `status: 0` and threatens a 10-minute ban).
 */
export const WORKDAY_RETRY_MS = 30 * 60 * 1000

/** Identifies this service to the calendar endpoint. */
const WORKDAY_USER_AGENT = 'dsh-prompt-tuner (+https://github.com/lzyyzznl/dsh-prompt-tuner)'

/** Peak windows, in minutes since Beijing midnight: 09:00–12:00, 14:00–18:00. */
const MORNING = [9 * 60, 12 * 60]
const AFTERNOON = [14 * 60, 18 * 60]

/** One bounded string, or `''`. */
function text(value, max = 64) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

/**
 * The verdict shape every consumer reads, built from the built-in calendar plus
 * the cached API answer when it is for today.
 *
 * @param {object} builtin - `beijingPeakStatus(now())`: the weekday facts.
 * @param {object|null} cached - today's cached API answer, or null.
 * @returns {object} `{status, weekday, minutes, weekend, holiday, date, workday, makeup, source, info}`.
 */
function verdictOf(builtin, cached) {
  const fromApi = cached !== null && cached.date === builtin.date && builtin.date !== ''
  const weekend = builtin.weekend
  // A weekend is off-peak no matter what the annual arrangement says: the
  // reference bills 调休上班的周末 as 空闲时段, so the external answer may take peak
  // away from a weekday but must never hand it to a Saturday.
  const makeup = fromApi && weekend && cached.workday === true
  const holiday = fromApi ? (cached.workday === false && !weekend) : builtin.holiday
  const workday = fromApi ? (cached.workday === true && !weekend) : (!weekend && !builtin.holiday)
  const minutes = builtin.minutes
  const inWindow = (minutes >= MORNING[0] && minutes < MORNING[1])
    || (minutes >= AFTERNOON[0] && minutes < AFTERNOON[1])
  return {
    status: workday && inWindow ? 'peak' : 'off-peak',
    weekday: builtin.weekday,
    minutes: builtin.minutes,
    weekend,
    holiday,
    date: builtin.date,
    // `workday` is the day-level fact and `status` the moment-level verdict, so
    // the page can say "补班周六，但按空闲时段计费" instead of just "低谷".
    // `makeup` exists so that sentence is possible: it is the one day where the
    // government and the price list disagree.
    workday,
    makeup,
    source: fromApi ? 'api' : 'builtin',
    info: fromApi ? cached.info : '',
  }
}

/**
 * Create the workday calendar.
 *
 * @param {object} [options] - wiring.
 * @param {() => number} [options.now] - injectable clock.
 * @param {Function|null} [options.fetch] - HTTP client; `null` disables the
 *   external source entirely (the self-test and an offline install use this).
 *   Omitted means the global `fetch`.
 * @param {object|null} [options.store] - runtime state store; when it exposes
 *   `calendar()`/`setCalendar()` the daily verdict survives a restart.
 * @param {Array<string>} [options.holidays] - holiday table for the fallback.
 * @param {number} [options.timeoutMs] - query timeout.
 * @param {number} [options.retryMs] - failure backoff.
 * @param {{info?: Function, warn?: Function}|null} [options.logger] - sink.
 * @returns {object} `{status, refresh, snapshot}`.
 */
export function createWorkdayCalendar(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const fetchFn = options.fetch === undefined
    ? (typeof globalThis.fetch === 'function' ? globalThis.fetch : null)
    : options.fetch
  const store = options.store ?? null
  const logger = options.logger ?? null
  const holidays = Array.isArray(options.holidays) && options.holidays.length > 0 ? options.holidays : undefined
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : WORKDAY_TIMEOUT_MS
  const retryMs = Number.isFinite(options.retryMs) ? options.retryMs : WORKDAY_RETRY_MS

  let cached = store?.calendar?.() ?? null
  let inflight = null
  let lastAttemptAt = 0
  let lastError = null

  /** Repair one cached entry (own or from the state file); null when unusable. */
  function accept(entry) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null
    const date = typeof entry.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.date) ? entry.date : null
    if (date === null) return null
    return {
      date,
      workday: entry.workday === true,
      info: text(entry.info),
      week: text(entry.week, 32),
      fetchedAt: text(entry.fetchedAt, 40),
    }
  }
  cached = accept(cached)

  /** The Beijing date an instant belongs to ('' when the clock is unusable). */
  function today() {
    return beijingDateKey(now())
  }

  /** Whether today's verdict is already cached. */
  function fresh() {
    const date = today()
    return date !== '' && cached !== null && cached.date === date
  }

  /**
   * The current verdict. Synchronous, total (never throws), and cheap — this is
   * what a routing decision reads. Falls back to the built-in table whenever
   * today's API answer is missing or not for today.
   * @returns {object} the verdict.
   */
  function status() {
    return verdictOf(beijingPeakStatus(now(), holidays), fresh() ? cached : null)
  }

  /**
   * Ask the external calendar for today, once a day. Never rejects; a failure is
   * remembered (and logged) so the next call backs off instead of retrying hot.
   * @returns {Promise<object|null>} the cached entry, or null when nothing was asked.
   */
  function refresh() {
    if (fetchFn === null) return Promise.resolve(null)
    const date = today()
    if (date === '') return Promise.resolve(null)
    if (cached !== null && cached.date === date) return Promise.resolve(cached)
    if (inflight !== null) return inflight
    if (lastAttemptAt !== 0 && now() - lastAttemptAt < retryMs) return Promise.resolve(null)
    lastAttemptAt = now()
    inflight = (async () => {
      try {
        const response = await fetchFn(`${WORKDAY_API_URL}?date=${date}`, {
          headers: { accept: 'application/json', 'user-agent': WORKDAY_USER_AGENT },
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (response?.ok !== true) throw new Error(`HTTP ${String(response?.status ?? '?')}`)
        const body = await response.json()
        // `status: 0` is how the endpoint reports its rate limit; treating it as a
        // failure (rather than as "not a working day") is the whole point.
        if (body?.status !== 1) throw new Error(text(body?.info, 120) || 'the calendar service refused the query')
        // The answer must be about the date that was asked for: an answer about
        // some other day (an endpoint that silently falls back to "today") says
        // nothing about the date being cached, and caching it would attribute a
        // verdict to a day it does not describe.
        if (typeof body.date === 'string' && body.date !== date) {
          throw new Error(`the calendar answered about ${body.date} instead of ${date}`)
        }
        const entry = {
          date,
          workday: body.is_workingday === 1 || body.is_workingday === true,
          info: text(body.info),
          week: text(body.week, 32),
          fetchedAt: new Date(now()).toISOString(),
        }
        cached = entry
        lastError = null
        store?.setCalendar?.(entry)
        logger?.info?.(`[router-service] workday calendar: ${entry.date} is ${entry.workday ? 'a working day' : 'not a working day'} (${entry.info || 'unnamed'})`)
        return entry
      } catch (cause) {
        lastError = String(cause?.message ?? cause)
        logger?.warn?.(`[router-service] workday calendar unavailable (${lastError}); the built-in holiday table decides ${date}`)
        return null
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  /**
   * What the calendar is doing, for `/state` and the page: which source decided
   * the current verdict, today's cached answer, and the last failure.
   * @returns {object} `{enabled, source, cached, lastError}`.
   */
  function snapshot() {
    return {
      enabled: fetchFn !== null,
      source: status().source,
      cached: cached === null ? null : { ...cached },
      lastError,
    }
  }

  return { status, refresh, snapshot }
}

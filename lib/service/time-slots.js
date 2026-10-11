/**
 * Beijing peak/off-peak calendar: which time context the clock is in.
 *
 * Time routing has exactly two contexts — **peak** and **off-peak** (高峰/低谷)
 * — and no custom HH:mm windows at all. The provider chain for each context is
 * a plain draggable order table (`router.peakOrder` / `router.offPeakOrder`);
 * a provider absent from a list is simply not tried during that context. This
 * module owns nothing about ranking: no tiers, no windows, no `0` means
 * disabled (removing a row from a list is the only way to disable it). Its one
 * job is deciding *which* table a request uses, by computing whether "now" is
 * a peak moment under the built-in Beijing business calendar. It never
 * reorders anything — the order tables already are the order.
 *
 * The calendar is fixed to Beijing time (UTC+8) regardless of the process time
 * zone: on a Mon–Fri non-holiday inside 09:00–12:00 or 14:00–18:00 ⇒ **peak**;
 * everything else (weekends, statutory holidays, lunch break, night) ⇒
 * **off-peak**.
 *
 * Everything here is a pure function over plain values — no imports, no I/O,
 * an injectable clock where a clock is needed — so the unit tests can pin the
 * verdicts without standing up the service. The holiday table is a pragmatic
 * stock set for 2025 and 2026; the exact annual arrangement (including makeup
 * workdays) must be kept current by editing it below (or supplying one in
 * config later).
 */
const BEIJING_OFFSET_MS = 8 * 3600 * 1000

/**
 * Built-in statutory public-holiday table, as `YYYY-MM-DD`. Treating any listed
 * day as a holiday no matter its weekday is what makes a national day off stay
 * off-peak even when it falls on a workday.
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
 * workday inside 09:00–12:00 or 14:00–18:00, otherwise `off-peak`. This is the
 * only figure that decides which order table a request uses.
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

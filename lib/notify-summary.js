/**
 * Notification bodies: the condensed line one toast carries.
 *
 * A completion notification used to carry the assistant's last message whole and
 * let the dispatcher cut it to fit ({@link abbreviate}), which is the right rule
 * for a mechanical limit and the wrong one for a reader: the first `maxChars`
 * characters of a long answer are usually the preamble, while the sentence that
 * says what happened sits at the end, where the `...` is. The body is now
 * *chosen* to fit instead of cut to fit — one model call condenses the turn's
 * answer into a single line no longer than the configured cap, and only the
 * fallback stays mechanical.
 *
 * This module is the pure half of that: the two prompts, the input framing, the
 * answer cleanup, and the fit test. The call itself — route resolution, thinking
 * off, the single retry, the deadline — lives in `lib/routes.js` beside the other
 * three model calls this plugin makes, because that is where their shared
 * helpers are (`resolveRoute`, `pickEffort`, `complete`).
 *
 * Two rules are deliberately not negotiable here:
 *   - **thinking is off** — this is a one-line condensation of text a model has
 *     already written; thinking tokens would cost seconds on the notification
 *     path and change nothing a reader sees;
 *   - **the cap is stated, not silently enforced by cutting** — the model is told
 *     the exact budget, and a model that overshoots is asked once more with a
 *     stricter one. A third overshoot is cut visibly with `...` (the same
 *     {@link ELLIPSIS} contract the old path used) and is reported as
 *     `truncated: true`, so a caller can always tell "chosen to fit" from "cut to
 *     fit" — and so can a test.
 *
 * @module lib/notify-summary
 */
import { abbreviate, normalizeNotifyChars } from './notify.js'
import { normalizeAnswer } from './prompt.js'

/**
 * Output budget of one summary call, in tokens.
 *
 * A summary is one sentence, but the reply has to be allowed to *finish*: a
 * ceiling so low that the adapter reports `EMPTY_LENGTH` would fail the call for
 * a reason that has nothing to do with the summary. 256 tokens is roughly thirty
 * times the largest body this plugin will accept.
 */
export const NOTIFY_SUMMARY_MAX_OUTPUT_TOKENS = 256

/**
 * What one answer may contribute to a summary call, in characters.
 *
 * An answer is usually far shorter than this. When it is not, the payload is
 * clamped head-and-tail rather than from the front (see {@link summaryUserText}):
 * a long answer opens with its conclusion and closes with its result, and the
 * middle is the working-out a summary is supposed to drop anyway.
 */
export const NOTIFY_SUMMARY_INPUT_CHARS = 4_000

/**
 * Whole-call deadline for the summary, in milliseconds. Both attempts share it.
 *
 * A notification is a courtesy about something that has already finished, so it
 * may not become the slowest part of the turn: past this, the toast goes out
 * saying no summary was available, and the log says why.
 */
export const NOTIFY_SUMMARY_TIMEOUT_MS = 20_000

/**
 * The body a toast carries when the summary could not be produced.
 *
 * Deliberately a constant rather than the last message: the whole point of this
 * module is that the assistant's own words are never shipped unread, and a
 * fallback that quietly reverted to them would make every failure look like a
 * success. It is short enough to fit any cap this plugin stores, so it can never
 * be the thing that gets cut.
 */
export const NOTIFY_SUMMARY_FALLBACK_BODY = '本轮已结束，摘要不可用'

/**
 * What the second attempt aims at, as a fraction of the real cap.
 *
 * Asked for "a bit shorter", a model tends to shave a character or two; asked
 * for a number well below the ceiling, it rewrites. The slack is what makes the
 * retry worth a second of latency instead of another overshoot.
 */
const SHRINK_RATIO = 0.6

/** Markdown furniture a model sometimes wraps a one-line answer in. */
const LEADING_NOISE = /^[\s#>*_`~\-–—•·]+/u

/** A label a model sometimes prefixes its own summary with. */
const LEADING_LABEL = /^(?:摘要|总结|概要|简述|一句话|summary|tldr|tl;dr)\s*[:：]\s*/iu

/** Quotes a model sometimes wraps the whole summary in. */
const SURROUNDING_QUOTES = /^["'“”‘’「」『』【】]+|["'“”‘’「」『』【】]+$/gu

/** One stored body cap, repaired rather than rejected (see `lib/notify.js`). */
function capOf(value) {
  return normalizeNotifyChars(value)
}

/** The fraction of a cap the shrink attempt asks for, never below the storage floor. */
function shrinkCap(maxChars) {
  const cap = capOf(maxChars)
  return Math.max(1, Math.min(cap, Math.floor(cap * SHRINK_RATIO)))
}

/**
 * The system instruction of the first (and, unchanged, the second) summary call.
 *
 * The budget is spliced into the instruction rather than kept here as a literal,
 * because it is a setting a user can change: a prompt with 120 baked into it
 * would keep asking for 120 after the cap was raised to 600.
 * @param {number} maxChars - the body cap in force (the stored `notifyMaxChars`).
 * @returns {string} the system prompt.
 */
export function summarySystemPrompt(maxChars) {
  const cap = capOf(maxChars)
  return [
    '你是桌面通知的摘要器：用户会给你一段 AI 助手的回复原文。',
    `把这段回复压缩成一条能完整显示在系统通知里的短句，总长度不超过 ${cap} 个字符（含标点）——这是硬上限，写不下就只说最重要的一句。`,
    '只写结果、结论或下一步；删掉过程叙述、代码、列表、链接、客套话和重复内容。',
    '只输出这一行纯文本：不要 Markdown、不要引号、不要「摘要：」这类前缀、不要换行、不要任何解释。',
    '用与原文相同的语言写。',
  ].join('\n')
}

/**
 * The system instruction of the shrink attempt.
 *
 * A separate prompt rather than the first one with a smaller number: the task is
 * now "rewrite what you already wrote, shorter", and a model told only a smaller
 * budget tends to answer the original question again.
 * @param {number} maxChars - the body cap in force; the attempt aims below it.
 * @returns {string} the system prompt.
 */
export function shrinkSystemPrompt(maxChars) {
  const cap = shrinkCap(maxChars)
  return [
    '用户会给你一条已经很短的摘要，但它还是太长了。',
    `把它压到 ${cap} 个字符以内（含标点）：只保留最核心的那一句结论，删掉次要信息。`,
    '不要新增内容，不要解释为什么，不要引用原文。',
    '只输出压缩后的那一行纯文本：不要 Markdown、不要引号、不要前缀、不要换行。',
    '用与原输入相同的语言写。',
  ].join('\n')
}

/**
 * One answer, framed for the summary call and bounded in size.
 *
 * Longer than {@link NOTIFY_SUMMARY_INPUT_CHARS} and the middle is dropped with a
 * visible separator instead: an answer opens by saying what it did and closes by
 * saying how it ended, and neither half survives a plain `slice` of the front.
 * @param {unknown} raw - the assistant's last message, as the browser read it.
 * @returns {string} the user turn of the first summary call.
 */
export function summaryUserText(raw) {
  const text = normalizeAnswer(raw)
  if (text.length <= NOTIFY_SUMMARY_INPUT_CHARS) return text
  const half = Math.floor((NOTIFY_SUMMARY_INPUT_CHARS - 5) / 2)
  return `${text.slice(0, half)}\n……\n${text.slice(text.length - half)}`
}

/**
 * The previous summary, framed for the shrink attempt.
 * @param {unknown} text - the summary the first attempt produced.
 * @returns {string} the user turn of the shrink call.
 */
export function shrinkUserText(text) {
  return normalizeAnswer(text)
}

/**
 * One model answer, turned into the single line a notification can carry.
 *
 * A model asked for one line still answers with two, a fenced block, a quoted
 * string, a bullet or a `摘要：` prefix. All of them are removed here; the lines
 * are joined rather than truncated to the first one, because a second line of a
 * *summary* usually holds the conclusion, and the cap is applied afterwards by
 * measurement instead of by guessing.
 * @param {unknown} raw - accumulated answer text.
 * @returns {string} one folded line, or `''` when nothing usable was left.
 */
export function normalizeSummary(raw) {
  const unwrapped = normalizeAnswer(raw)
  const joined = unwrapped
    .split('\n')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(' ')
  return joined
    .replace(/\s+/gu, ' ')
    .trim()
    // Quotes first, then the furniture, then the label: a model that writes
    // `“摘要：…。”` puts its label *inside* the quotes, and a label test run
    // before the opening quote was removed would never match.
    .replace(SURROUNDING_QUOTES, '')
    .replace(LEADING_NOISE, '')
    .replace(LEADING_LABEL, '')
    .replace(SURROUNDING_QUOTES, '')
    .replace(LEADING_NOISE, '')
    .trim()
}

/**
 * Whether one summary would reach the desktop whole.
 *
 * A body longer than the cap is not dropped — the dispatcher cuts it and closes
 * it with `...` — so this is the test that separates "the model chose to fit"
 * from "the plugin made it fit", and it is what decides whether the shrink
 * attempt happens at all.
 * @param {unknown} text - a normalized summary.
 * @param {number} maxChars - the body cap in force.
 * @returns {boolean} true when nothing would be cut.
 */
export function summaryFits(text, maxChars) {
  return String(text ?? '').length <= capOf(maxChars)
}

/**
 * Enforce the cap, with a visible cut, as the last resort.
 *
 * Reuses the notification half's {@link abbreviate} rather than re-deriving the
 * ellipsis contract: the cap counts the ellipsis, so `maxChars` is genuinely the
 * longest string that can reach the desktop. Reached only when two model attempts
 * both overshot; a caller that runs it must report the result as truncated.
 * @param {unknown} text - a normalized summary.
 * @param {number} maxChars - the body cap in force.
 * @returns {string} a one-line body no longer than the cap.
 */
export function clampSummary(text, maxChars) {
  return abbreviate(text, capOf(maxChars))
}

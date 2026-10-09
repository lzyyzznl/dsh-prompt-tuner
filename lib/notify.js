/**
 * Host-side desktop notifications for finished conversation tasks.
 *
 * The browser half already knows when a task ends (the session status channel
 * flips a session from running to idle) and what the answer said, but it cannot
 * pop an OS notification: that is a process-level act, so the notification is
 * dispatched here, in the host, exactly like the rest of this plugin's host
 * work.
 *
 * Two platforms, two different programs, and one seam between them:
 *   - **Linux** uses `notify-send` (the freedesktop `libnotify` client). It is
 *     only meaningful in a graphical session, so the dispatcher refuses to run
 *     it without `DISPLAY`/`WAYLAND_DISPLAY`; a headless host silently skips
 *     instead of spawning a command that can only fail.
 *   - **Windows** uses a WinRT toast through `powershell.exe`. The script is
 *     passed as `-EncodedCommand` (base64 UTF-16LE), so titles and bodies never
 *     have to be quoted into a shell string.
 *   - **WSL** is a Linux process on a Windows desktop: `notify-send` usually has
 *     no bus to talk to, so a WSL host routes to the Windows toast it can
 *     actually reach. This is the one place platform detection is not just
 *     `process.platform`.
 *
 * One rule runs through both dispatchers: nothing unbounded reaches the desktop.
 * A title and a body are folded to one line and shortened with `...` at the cap
 * the settings page stores — see {@link abbreviate} — because a toast nobody can
 * read to the end is not a notification, and one that ends mid-sentence without
 * saying so is worse than a short one.
 *
 * Nothing here ever throws. A notification is a courtesy at the end of a turn;
 * a missing `notify-send`, a locked bus, or a policy that blocks PowerShell must
 * report itself in the return value and leave the completed task alone.
 *
 * @module dsh-prompt-optimizer/notify
 */
import { execFile } from 'node:child_process'

/** Hard ceiling on one notification command. A toast that has not shown itself
 * by now never will, and it must not hold a process slot. */
export const NOTIFY_TIMEOUT_MS = 8_000

/** What one notification title may occupy after whitespace folding.
 *
 * Short on purpose: a title is a label, and a session title that runs past the
 * toast's own first line would otherwise push the answer down. */
export const NOTIFY_TITLE_CHARS = 48

/** Default cap on one notification body, after whitespace folding.
 *
 * A toast is a glance, not a reader. The default shows an answer's opening
 * thought and stops; how much of it shows is the settings page's business
 * (`notifyMaxChars`), and this is what an untouched install uses. */
export const NOTIFY_BODY_CHARS = 120

/** The narrowest body cap the settings page will store. */
export const NOTIFY_MIN_BODY_CHARS = 40

/** The widest body cap the settings page will store. */
export const NOTIFY_MAX_BODY_CHARS = 600

/** What a shortened line ends with, so a cut is never mistaken for an ending. */
export const ELLIPSIS = '...'

/** Placeholder title when the session has not been titled yet. */
export const FALLBACK_TITLE = 'DSH'

/** App name the notification is attributed to. */
export const APP_NAME = 'DSH'

/** Whether an environment looks like WSL (a Linux host under Windows). */
export function isWsl(env = process.env) {
  if (typeof env.WSL_DISTRO_NAME === 'string' && env.WSL_DISTRO_NAME !== '') return true
  if (typeof env.WSL_INTEROP === 'string' && env.WSL_INTEROP !== '') return true
  return false
}

/** Whether an environment has a graphical session a desktop notification can reach. */
export function hasDisplay(env = process.env) {
  const display = env.DISPLAY
  if (typeof display === 'string' && display !== '') return true
  const wayland = env.WAYLAND_DISPLAY
  return typeof wayland === 'string' && wayland !== ''
}

/**
 * Which dispatcher this process should use.
 * @param {Record<string, string|undefined>} [env] - environment (the seam tests drive).
 * @param {string} [platform] - `process.platform` (the seam tests drive).
 * @returns {'windows'|'linux'|null} the dispatcher, or null when this host cannot show one.
 */
export function notifyPlatform(env = process.env, platform = process.platform) {
  if (platform === 'win32') return 'windows'
  if (platform !== 'linux') return null
  // A Linux process under Windows has a Windows desktop but usually no session
  // bus; the toast is the one the user can actually see.
  if (isWsl(env)) return 'windows'
  return hasDisplay(env) ? 'linux' : null
}

/**
 * Fold one line of user text and shorten it if it does not fit.
 *
 * Control characters out, whitespace collapsed, then — when the line is longer
 * than `maxChars` — cut and closed with {@link ELLIPSIS}. The old behaviour was
 * a bare `slice`, which ended mid-sentence with nothing saying text was
 * missing; a notification that looks complete but is not is worse than a short
 * one. The cap counts the ellipsis, so `maxChars` is genuinely the longest
 * string that can reach the desktop.
 * @param {unknown} value - the raw text.
 * @param {number} maxChars - the longest allowed result, ellipsis included.
 * @returns {string} the folded line, never longer than `maxChars`.
 */
export function abbreviate(value, maxChars) {
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.trunc(maxChars)) : 0
  const folded = String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (folded.length <= limit) return folded
  const keep = Math.max(0, limit - ELLIPSIS.length)
  return folded.slice(0, keep).replace(/\s+$/, '') + ELLIPSIS
}

/**
 * One stored body cap, repaired rather than rejected.
 *
 * The settings file is a document a human can edit, so a nonsense value there
 * must fall back to the default instead of reaching a notification: a cap of
 * `-1` would ship an empty toast, and one of `10_000_000` would defeat the
 * point of the setting. The routes reject out-of-range input outright; this is
 * the tolerant reader behind them.
 * @param {unknown} value - the stored `notifyMaxChars`.
 * @param {number} [fallback] - what an unusable value means.
 * @returns {number} a cap inside `[NOTIFY_MIN_BODY_CHARS, NOTIFY_MAX_BODY_CHARS]`.
 */
export function normalizeNotifyChars(value, fallback = NOTIFY_BODY_CHARS) {
  const number = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')
    ? Number(value)
    : Number.NaN
  if (!Number.isSafeInteger(number)) return fallback
  return Math.min(NOTIFY_MAX_BODY_CHARS, Math.max(NOTIFY_MIN_BODY_CHARS, number))
}

/** The title cap one dispatch uses: the caller's, or the default. */
function titleCharsOf(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : NOTIFY_TITLE_CHARS
}

/** A PowerShell single-quoted literal: `'` is doubled, everything else is verbatim. */
function psLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * The PowerShell program that shows one toast.
 *
 * Kept as a small script (rather than a one-liner) so the XML, the two text
 * nodes and the notifier are each on their own statement; the whole thing still
 * travels as one `-EncodedCommand`, so nothing is re-quoted by cmd.exe.
 * @param {string} title - already-folded title.
 * @param {string} body - already-folded body.
 * @returns {string} the script text.
 */
export function windowsToastScript(title, body) {
  return [
    '$ErrorActionPreference = "Stop"',
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$xml.LoadXml("<toast><visual><binding template=\\"ToastGeneric\\"><text></text><text></text></binding></visual></toast>")',
    '$nodes = $xml.GetElementsByTagName("text")',
    `$nodes.Item(0).AppendChild($xml.CreateTextNode(${psLiteral(title)})) | Out-Null`,
    `$nodes.Item(1).AppendChild($xml.CreateTextNode(${psLiteral(body)})) | Out-Null`,
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psLiteral(APP_NAME)}).Show($toast)`,
  ].join('; ')
}

/** The base64 (UTF-16LE) form `powershell.exe -EncodedCommand` expects. */
export function encodePowerShell(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64')
}

/**
 * Build the exact command one notification needs, or null when this host cannot
 * show one.
 * @param {string} platform - {@link notifyPlatform}'s answer.
 * @param {{title: string, body: string}} note - the folded title and body.
 * @returns {{command: string, args: string[]}|null} the command, shell-free.
 */
export function buildNotifyCommand(platform, note) {
  if (platform === 'linux') {
    return {
      command: 'notify-send',
      args: ['--app-name=' + APP_NAME, '--urgency=normal', '--expire-time=8000', note.title, note.body],
    }
  }
  if (platform === 'windows') {
    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-EncodedCommand',
        encodePowerShell(windowsToastScript(note.title, note.body)),
      ],
    }
  }
  return null
}

/**
 * Show one desktop notification.
 *
 * The default runner is `execFile` with a hard timeout, no shell (the title and
 * body are separate argv entries, so no quoting can turn them into commands) and
 * `windowsHide`, so a toast never flashes a console window. Tests inject their
 * own runner and never spawn anything.
 * @param {{title?: string, body?: string}} note - the session title and the answer summary.
 * @param {object} [deps] - seam for tests: `env`, `platform`, `run`, `titleChars`, `bodyChars`.
 * @param {Record<string, string|undefined>} [deps.env] - environment to classify.
 * @param {string} [deps.platform] - platform to classify.
 * @param {number} [deps.titleChars] - title cap; the default when absent.
 * @param {number} [deps.bodyChars] - body cap (the stored `notifyMaxChars`), normalized into range.
 * @param {(command: string, args: string[], options: object) => Promise<{code?: number|null, error?: Error|null}>} [deps.run] - command runner.
 * @returns {Promise<{ok: boolean, platform: string|null, command: string|null, shown: {title: string, body: string}, skipped?: string, error?: string}>} the outcome, never a throw. `shown` is what actually reached the command (folded and shortened), so a caller can report how much of an answer was displayed without re-deriving the cap.
 */
export async function sendNotification(note, deps = {}) {
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  const target = notifyPlatform(env, platform)
  const title = abbreviate(note?.title, titleCharsOf(deps.titleChars)) || FALLBACK_TITLE
  const body = abbreviate(note?.body, normalizeNotifyChars(deps.bodyChars))
  const shown = { title, body }
  if (target === null) {
    return {
      ok: false,
      platform: null,
      command: null,
      shown,
      skipped: platform === 'linux' && !hasDisplay(env) ? 'no-display' : 'unsupported-platform',
    }
  }
  const command = buildNotifyCommand(target, { title, body })
  if (command === null) return { ok: false, platform: target, command: null, shown, skipped: 'no-dispatcher' }
  const run = typeof deps.run === 'function' ? deps.run : runExecFile
  try {
    const outcome = await run(command.command, command.args, { timeout: NOTIFY_TIMEOUT_MS, windowsHide: true })
    if (outcome?.error != null) {
      return { ok: false, platform: target, command: command.command, shown, error: String(outcome.error.message ?? outcome.error) }
    }
    return { ok: true, platform: target, command: command.command, shown }
  } catch (cause) {
    return { ok: false, platform: target, command: command.command, shown, error: String(cause?.message ?? cause) }
  }
}

/**
 * The production runner: one `execFile`, no shell, bounded by its own timeout.
 * Resolves with `error` rather than rejecting, so the caller has one shape to read.
 * @param {string} command - program to run.
 * @param {string[]} args - argv entries.
 * @param {object} options - `timeout` and `windowsHide`.
 * @returns {Promise<{code: number|null, error: Error|null}>} the outcome.
 */
function runExecFile(command, args, options) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: options.timeout, windowsHide: options.windowsHide !== false }, (error, _stdout, stderr) => {
      resolve({
        code: typeof error?.code === 'number' ? error.code : error === null ? 0 : null,
        error: error ?? null,
        stderr: typeof stderr === 'string' ? stderr : '',
      })
    })
  })
}

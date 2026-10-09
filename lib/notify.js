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

/** What one notification title may occupy after whitespace folding. */
export const NOTIFY_TITLE_CHARS = 120

/** What one notification body may occupy after whitespace folding. */
export const NOTIFY_BODY_CHARS = 600

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

/** Fold one line of user text: control characters out, whitespace collapsed, bounded. */
function oneLine(value, maxChars) {
  return String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars)
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
 * @param {object} [deps] - seam for tests: `env`, `platform`, `run`.
 * @param {Record<string, string|undefined>} [deps.env] - environment to classify.
 * @param {string} [deps.platform] - platform to classify.
 * @param {(command: string, args: string[], options: object) => Promise<{code?: number|null, error?: Error|null}>} [deps.run] - command runner.
 * @returns {Promise<{ok: boolean, platform: string|null, command: string|null, skipped?: string, error?: string}>} the outcome, never a throw.
 */
export async function sendNotification(note, deps = {}) {
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  const target = notifyPlatform(env, platform)
  const title = oneLine(note?.title, NOTIFY_TITLE_CHARS) || FALLBACK_TITLE
  const body = oneLine(note?.body, NOTIFY_BODY_CHARS)
  if (target === null) {
    return {
      ok: false,
      platform: null,
      command: null,
      skipped: platform === 'linux' && !hasDisplay(env) ? 'no-display' : 'unsupported-platform',
    }
  }
  const command = buildNotifyCommand(target, { title, body })
  if (command === null) return { ok: false, platform: target, command: null, skipped: 'no-dispatcher' }
  const run = typeof deps.run === 'function' ? deps.run : runExecFile
  try {
    const outcome = await run(command.command, command.args, { timeout: NOTIFY_TIMEOUT_MS, windowsHide: true })
    if (outcome?.error != null) {
      return { ok: false, platform: target, command: command.command, error: String(outcome.error.message ?? outcome.error) }
    }
    return { ok: true, platform: target, command: command.command }
  } catch (cause) {
    return { ok: false, platform: target, command: command.command, error: String(cause?.message ?? cause) }
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

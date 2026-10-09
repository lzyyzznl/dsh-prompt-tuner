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

/**
 * The AppUserModelID Windows renders this toast under.
 *
 * `CreateToastNotifier` never checks that the id exists: it returns normally,
 * PowerShell exits 0, and the notification platform even records the toast in
 * its own history — but with nothing registered behind the id, Windows never
 * renders it. The toast is dropped silently *after* every API in the chain
 * reported success, which is exactly why the notification looked sent and never
 * appeared.
 *
 * Registration is the part that used to be someone else's job. The id has to
 * name a Start Menu shortcut (`System.AppUserModel.ID`) or, for an unpackaged
 * app, an `HKCU\Software\Classes\AppUserModelId\<id>` key — Windows 10 and 11
 * both accept that key on its own, with no shortcut and no installer. Leaving
 * it to the installer made this id a ghost on every machine that had registered
 * a *different* one: an install of the DSH NEXT edition carries
 * `ai.deepseek.dsh.desktop.next` on its shortcut, so each toast aimed at the id
 * below was queued and then dropped.
 *
 * The dispatcher therefore registers the id itself, once, in the same
 * PowerShell run that shows the first toast that needs it — see
 * {@link windowsToastScript}. Nothing here depends on an installer, an edition,
 * or a shortcut.
 */
export const WINDOWS_APP_ID = 'ai.deepseek.dsh.desktop'

/**
 * Where Windows keeps an unpackaged app's notification identity.
 *
 * Both Windows 10 and Windows 11 read this key, and neither asks for the Start
 * Menu shortcut the documentation describes as mandatory — measured on Windows
 * 11 26100: a toast under an id with only this key renders, a toast under an id
 * with neither renders nothing. Written per-user, so no elevation is involved.
 * @param {string} [appId] - the id to register.
 * @returns {string} the registry path, in PowerShell's `HKCU:` provider form.
 */
export function windowsAppIdRegistryPath(appId = WINDOWS_APP_ID) {
  return `HKCU:\\Software\\Classes\\AppUserModelId\\${appId}`
}

/**
 * The one line the PowerShell half prints about that registration.
 *
 * It exists so a registration that *could not* be written is not another silent
 * failure: `blocked` means the toast about to be shown will be dropped, and the
 * caller says so instead of reporting a success nobody can see.
 */
export const APP_ID_MARKER = 'prompt-tuner:appId='

/**
 * The second key an unpackaged desktop app may need before Windows will toast.
 *
 * `HKCU\Software\Microsoft\Windows\CurrentVersion\PushNotifications\Backup\<id>`
 * is the pre-1709 way for a desktop app to announce that it wants banner, toast
 * and audio notifications at all; the `Classes\AppUserModelId` key above is the
 * modern one. Windows 11 renders with either, and which of the two an older
 * Windows 10 build insists on is not something this machine can settle, so both
 * are written — once, best-effort, and only into this app's own subkeys.
 *
 * It deliberately does not touch `Notifications\Settings\<id>`, the per-app
 * switch the user owns: a toast the user has muted stays muted.
 * @param {string} [appId] - the id to opt in.
 * @returns {string} the registry path, in PowerShell's `HKCU:` provider form.
 */
export function windowsAppIdOptInPath(appId = WINDOWS_APP_ID) {
  return `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications\\Backup\\${appId}`
}

/** What {@link windowsAppIdOptInPath} declares: this app shows banners and toasts. */
export const APP_ID_DESKTOP_SETTING = 's:banner,s:toast,s:audio,c:toast,c:ringing'

/**
 * The PowerShell that can show a toast — and it is not whichever one is on PATH.
 *
 * `powershell.exe` is Windows PowerShell 5.1 and ships with Windows 10 and 11;
 * `pwsh.exe` is PowerShell 7, an optional install. PowerShell 7 dropped the
 * WinRT projection it once inherited, so this very script fails on it with
 * "unable to find type [Windows.UI.Notifications.ToastNotificationManager]"
 * (measured on 7.6.6), while 5.1 runs it unchanged. Naming the executable
 * explicitly, never `pwsh`, is therefore part of the contract rather than a
 * detail: the alternative is a toast that silently stops existing on any machine
 * where someone put PowerShell 7 first.
 */
export const WINDOWS_SHELL = 'powershell.exe'

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

/** An optional piece of text: a non-empty string, or undefined. */
function optionalText(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * The PowerShell program that shows one toast.
 *
 * Kept as a small script (rather than a one-liner) so the XML, the two text
 * nodes and the notifier are each on their own statement; the whole thing still
 * travels as one `-EncodedCommand`, so nothing is re-quoted by cmd.exe.
 *
 * It also **registers the AppUserModelID it is about to use**, in the same
 * process. Measured on Windows 11 26100: `CreateToastNotifier().Show()` says
 * nothing about whether the id is registered, and a toast under an unregistered
 * id is accepted, written into the notification history, and then never
 * rendered — so registering here is the whole difference between a notification
 * and a silent no-op. Doing it in this run rather than a separate one also
 * measured clean: a registration written and used by one PowerShell process
 * renders on the first try.
 *
 * Three properties of that registration matter:
 *   - `Test-Path` guards it, so an id the installer already registered (with the
 *     edition's own name and icon) is left exactly as it is.
 *   - `try`/`catch` wraps it, so a locked-down registry cannot take the toast
 *     down with it — `$ErrorActionPreference` is `Stop`, and the toast still has
 *     to be attempted.
 *   - the outcome is printed as {@link APP_ID_MARKER} plus one word, because a
 *     registration that could not be written has to reach the caller instead of
 *     becoming the next invisible failure.
 *
 * The script runs under {@link WINDOWS_SHELL} — Windows PowerShell 5.1, present
 * on every Windows 10 and 11 — because PowerShell 7 cannot load the WinRT types
 * it needs. It uses only cmdlets and providers that have been in 5.1 since
 * Windows 8 (`Test-Path`, `New-Item`, `New-ItemProperty`, `Write-Output`, the
 * `HKCU:` provider), so nothing here depends on a module, a language mode
 * extension, or an install extra.
 * @param {string} title - already-folded title.
 * @param {string} body - already-folded body.
 * @param {{appId?: string, displayName?: string, iconUri?: string}} [options] - attribution overrides; each falls back to a default here.
 * @returns {string} the script text.
 */
export function windowsToastScript(title, body, options = {}) {
  const appId = optionalText(options.appId) ?? WINDOWS_APP_ID
  const displayName = optionalText(options.displayName) ?? APP_NAME
  // The toast is attributed to whatever process spawned it, which on a desktop
  // install is the application the user is actually looking at.
  const iconUri = optionalText(options.iconUri) ?? optionalText(process.execPath)
  const register = [
    'try {',
    'if (Test-Path $appIdKey) { $appIdState = "present" }',
    'else {',
    'New-Item -Path $appIdKey -Force | Out-Null',
    `New-ItemProperty -Path $appIdKey -Name DisplayName -Value ${psLiteral(displayName)} -PropertyType String -Force | Out-Null`,
    ...(iconUri === undefined
      ? []
      : [`New-ItemProperty -Path $appIdKey -Name IconUri -Value ${psLiteral(iconUri)} -PropertyType String -Force | Out-Null`]),
    'New-ItemProperty -Path $appIdKey -Name ShowInSettings -Value 1 -PropertyType DWord -Force | Out-Null',
    'if (Test-Path $appIdKey) { $appIdState = "created" }',
    '}',
    // The pre-1709 opt-in, written only when absent. Which of the two keys an
    // older Windows 10 build insists on cannot be settled from Windows 11, and
    // carrying both costs four values, once.
    'if (-not (Test-Path $optInKey)) {',
    'New-Item -Path $optInKey -Force | Out-Null',
    "New-ItemProperty -Path $optInKey -Name appType -Value 'app:desktop' -PropertyType String -Force | Out-Null",
    `New-ItemProperty -Path $optInKey -Name Setting -Value ${psLiteral(APP_ID_DESKTOP_SETTING)} -PropertyType String -Force | Out-Null`,
    "New-ItemProperty -Path $optInKey -Name wnsId -Value 'NonImmersivePackage' -PropertyType String -Force | Out-Null",
    '}',
    '} catch { }',
    `Write-Output (${psLiteral(APP_ID_MARKER)} + $appIdState)`,
  ].join('\n')
  return [
    '$ErrorActionPreference = "Stop"',
    `$appId = ${psLiteral(appId)}`,
    `$appIdKey = 'HKCU:\\Software\\Classes\\AppUserModelId\\' + $appId`,
    `$optInKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications\\Backup\\' + $appId`,
    '$appIdState = "blocked"',
    register,
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    // Single-quoted on purpose. PowerShell has no backslash escape: inside a
    // double-quoted string the `\"` this used to carry ended the string early
    // and the whole script died with a parser error ("MissingEndParenthesis-
    // InMethodCall") before any toast was shown — which is why Windows never
    // displayed one. A single-quoted string is verbatim, so the XML's own
    // double quotes need no escaping at all.
    `$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text></text><text></text></binding></visual></toast>')`,
    '$nodes = $xml.GetElementsByTagName("text")',
    `$nodes.Item(0).AppendChild($xml.CreateTextNode(${psLiteral(title)})) | Out-Null`,
    `$nodes.Item(1).AppendChild($xml.CreateTextNode(${psLiteral(body)})) | Out-Null`,
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)',
  ].join('; ')
}

/**
 * Read {@link APP_ID_MARKER} back out of the PowerShell run's stdout.
 * @param {unknown} stdout - captured standard output.
 * @returns {'created'|'present'|'blocked'|undefined} the registration outcome, or undefined when the run reported none (a runner that captures nothing).
 */
export function parseAppIdState(stdout) {
  const match = /prompt-tuner:appId=(created|present|blocked)/.exec(String(stdout ?? ''))
  return match === null ? undefined : match[1]
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
 * @param {{appId?: string, displayName?: string, iconUri?: string}} [options] - Windows attribution overrides, passed through to {@link windowsToastScript}.
 * @returns {{command: string, args: string[]}|null} the command, shell-free.
 */
export function buildNotifyCommand(platform, note, options = {}) {
  if (platform === 'linux') {
    return {
      command: 'notify-send',
      args: ['--app-name=' + APP_NAME, '--urgency=normal', '--expire-time=8000', note.title, note.body],
    }
  }
  if (platform === 'windows') {
    return {
      command: WINDOWS_SHELL,
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-EncodedCommand',
        encodePowerShell(windowsToastScript(note.title, note.body, options)),
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
 *
 * On Windows the run also reports whether the toast's AppUserModelID ended up
 * registered — see {@link windowsToastScript}. That report is the *only* way to
 * tell a toast that will render from one Windows is about to drop, because the
 * WinRT call returns normally either way. An id that is neither already
 * registered nor writable is therefore reported as a failure, not as a
 * notification nobody will ever see.
 * @param {{title?: string, body?: string}} note - the session title and the answer summary.
 * @param {object} [deps] - seam for tests: `env`, `platform`, `run`, `titleChars`, `bodyChars`, `appId`, `displayName`, `iconUri`.
 * @param {Record<string, string|undefined>} [deps.env] - environment to classify.
 * @param {string} [deps.platform] - platform to classify.
 * @param {number} [deps.titleChars] - title cap; the default when absent.
 * @param {number} [deps.bodyChars] - body cap (the stored `notifyMaxChars`), normalized into range.
 * @param {string} [deps.appId] - Windows AppUserModelID to toast under and to register.
 * @param {string} [deps.displayName] - name Windows attributes that id to.
 * @param {string} [deps.iconUri] - icon Windows attributes that id to.
 * @param {(command: string, args: string[], options: object) => Promise<{code?: number|null, error?: Error|null, stdout?: string}>} [deps.run] - command runner.
 * @returns {Promise<{ok: boolean, platform: string|null, command: string|null, shown: {title: string, body: string}, registration?: 'created'|'present'|'blocked', skipped?: string, error?: string}>} the outcome, never a throw. `shown` is what actually reached the command (folded and shortened), so a caller can report how much of an answer was displayed without re-deriving the cap.
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
  const command = buildNotifyCommand(target, { title, body }, {
    appId: deps.appId,
    displayName: deps.displayName,
    iconUri: deps.iconUri,
  })
  if (command === null) return { ok: false, platform: target, command: null, shown, skipped: 'no-dispatcher' }
  const run = typeof deps.run === 'function' ? deps.run : runExecFile
  try {
    const outcome = await run(command.command, command.args, { timeout: NOTIFY_TIMEOUT_MS, windowsHide: true })
    const registration = target === 'windows' ? parseAppIdState(outcome?.stdout) : undefined
    const attested = registration === undefined ? {} : { registration }
    if (outcome?.error != null) {
      return { ok: false, platform: target, command: command.command, shown, ...attested, error: String(outcome.error.message ?? outcome.error) }
    }
    if (registration === 'blocked') {
      return {
        ok: false,
        platform: target,
        command: command.command,
        shown,
        ...attested,
        error: `AppUserModelID '${deps.appId ?? WINDOWS_APP_ID}' is neither registered nor writable, and Windows discards a toast sent under it without reporting an error`,
      }
    }
    return { ok: true, platform: target, command: command.command, shown, ...attested }
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
 * @returns {Promise<{code: number|null, error: Error|null, stdout: string, stderr: string}>} the outcome.
 */
function runExecFile(command, args, options) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: options.timeout, windowsHide: options.windowsHide !== false }, (error, stdout, stderr) => {
      resolve({
        code: typeof error?.code === 'number' ? error.code : error === null ? 0 : null,
        error: error ?? null,
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : '',
      })
    })
  })
}

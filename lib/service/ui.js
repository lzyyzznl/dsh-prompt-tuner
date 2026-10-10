/**
 * The routing service's admin page, as one self-contained HTML document.
 *
 * ## Why this module is a string builder and nothing else
 *
 * The page is served by the service's own HTTP listener to a human who is
 * already sitting at the machine, so there is no build step, no bundler and no
 * package to resolve. That is a hard constraint, not a preference: the repo's
 * self-check refuses any `@deepseek-ai` dependency under `lib/service/**`, and
 * an admin surface that only works after `pnpm install` would be one more thing
 * to break exactly when the operator is trying to fix a broken service. This
 * module therefore imports nothing, exports one function, and returns a string.
 * Everything the browser needs — CSS, dictionary, polling, reconcilers — is
 * inlined by {@link renderAdminPage}.
 *
 * The corollary is that the *client* half is written in the page's own ES5-ish
 * dialect (one IIFE, `var`, function declarations) rather than in this repo's
 * module style. It runs in whatever browser the operator happens to have, and it
 * shares nothing with Node.
 *
 * ## The token is embedded on purpose
 *
 * `renderAdminPage` writes the admin token into a `<meta>` element. That looks
 * like a leak and is not one: the same-origin policy stops any other page from
 * reading this document's DOM, and a caller that can fetch this HTML can already
 * read the token out of it. Requiring the operator to copy a bearer token by
 * hand would add friction without adding a boundary. The meta element is the
 * single place the client reads it from, so there is exactly one answer to
 * "where does the page get its credential".
 *
 * ## Built with DOM APIs, never from an HTML string
 *
 * Every value that reaches the page comes from a config file a human may have
 * hand-edited (`lib/service/config.js` deliberately repairs rather than
 * rejects), so provider ids, labels, base URLs, credential masks and upstream
 * error messages are all untrusted text. The page therefore never assembles
 * markup from strings: {@link renderAdminPage} emits static markup plus one JSON
 * boot blob, and the client fills it in with `createElement`/`textContent`
 * through one small `el()` helper. There is no escaping function to forget to
 * call, because there is no string-to-HTML path at all — the one place untrusted
 * text meets markup (`attr()`, for the token) escapes it explicitly.
 *
 * ## A provider is a list of credentials
 *
 * The service's circuit breaker, its blacklist and its failure accounting all
 * address a *unit*: one route table row crossed with one credential. The page
 * mirrors that shape instead of hiding it. Each provider is a block holding a
 * row per credential, and each credential row carries its own breaker badge, its
 * own blacklist verdict and recovery time, and its own probe button, because a
 * provider whose second key is out of balance is healthy as far as its first key
 * is concerned.
 *
 * The secret itself never reaches the page: the service reports a mask and a
 * boolean, so leaving a credential's password box blank is not a convenience but
 * the only possible edit for a stored secret. Deleting the row is how a
 * credential is removed, and an added row without an id is how one is created —
 * the service assigns it a stable `kN` id on save.
 *
 * ## Polling must not fight the operator
 *
 * A four-second poll that rebuilds the DOM would destroy selections, half-typed
 * ids and scroll position — an admin page that undoes your edits is worse than
 * one that does not refresh. So the client reconciles instead of rebuilding:
 *
 *   - read-only feeds (live breaker rows, blacklist, recent events, stats) reuse
 *     their existing rows keyed by identity and only overwrite text;
 *   - the two editable sections (providers, routing) are keyed by a signature of
 *     the server state and are re-rendered *only* when that state actually
 *     changed, and never while the section holds a draft or the focus. A save
 *     forces just its own section, so saving the route table cannot throw away a
 *     half-typed provider.
 *
 * The poll itself stops while the tab is hidden and while any save, probe or
 * upstream fetch owns the wire, and it refreshes once on the way back into view,
 * so a background tab neither burns the service nor races a write.
 *
 * @module dsh-prompt-tuner/service/ui
 */

/**
 * Escape one string for an HTML attribute-delimited context.
 *
 * Only the token and the small boot blob are interpolated into markup, and both
 * are escaped here rather than trusted: the token is the operator's own secret
 * and a quoting bug in it would break the whole page.
 * @param {unknown} value - the raw value.
 * @returns {string} the escaped attribute text.
 */
function attr(value) {
  const text = value === null || value === undefined ? '' : String(value)
  return text
    .split('&').join('&amp;')
    .split('"').join('&quot;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
}

/**
 * Serialize the boot blob so it cannot terminate the enclosing `<script>`.
 *
 * `JSON.stringify` leaves `<` alone, which would let a hand-written `basePath`
 * close the script element early; `\u003c` is the same character to a JSON
 * parser and inert to the HTML tokenizer.
 * @param {unknown} value - the value to embed.
 * @returns {string} JSON text safe to place inside a script element.
 */
function jsonForScript(value) {
  return JSON.stringify(value).split('<').join('\\u003c')
}

/** One non-empty string, or the fallback. */
function pickString(value, fallback) {
  return typeof value === 'string' && value !== '' ? value : fallback
}

/** One finite number, or the fallback. */
function pickNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Render the service's admin page.
 * @param {{token: string, version: string, port: number, host: string, basePath?: string}} options
 * @returns {string} the complete HTML document.
 */
export function renderAdminPage(options) {
  const opts = options !== null && typeof options === 'object' ? options : {}
  const token = pickString(opts.token, '')
  const version = pickString(opts.version, '')
  const host = pickString(opts.host, '127.0.0.1')
  const port = pickNumber(opts.port, 8790)
  const basePath = pickString(opts.basePath, '')
  const boot = jsonForScript({ version, host, port, basePath })

  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="router-token" content="${attr(token)}">
<title>DSH Router Service</title>
<style>
:root {
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --bg: #f5f6f8;
  --panel: #ffffff;
  --panel-2: #f7f8fa;
  --border: #dce0e6;
  --text: #1b2430;
  --muted: #67717f;
  --accent: #2563eb;
  --accent-text: #ffffff;
  --accent-soft: #e8efff;
  --ok: #0f7a55;
  --ok-soft: #e0f4eb;
  --warn: #8f6200;
  --warn-soft: #fcf0d5;
  --danger: #b93226;
  --danger-soft: #fdeae7;
  --radius: 8px;
  --shadow: 0 8px 24px rgba(15, 23, 42, 0.14);
  /* A single motion language for the whole page: 150ms for hover/state changes,
     gentle ease, and a 0ms opt-out under reduced-motion. Deliberately slow and
     restrained — this is a control panel, not a showpiece. */
  --ease: cubic-bezier(0.2, 0, 0, 1);
  --dur: 150ms;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e1218;
    --panel: #151b23;
    --panel-2: #1a212b;
    --border: #2a3441;
    --text: #e5eaf1;
    --muted: #93a0b1;
    --accent: #6ea8fe;
    --accent-text: #0b1220;
    --accent-soft: #1b2738;
    --ok: #4ade80;
    --ok-soft: #12271d;
    --warn: #f5c542;
    --warn-soft: #2b2413;
    --danger: #f87171;
    --danger-soft: #2c1616;
    --shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--text);
  /* CJK body needs looser leading than the Latin 1.5 default so two Chinese
     lines never collide; 1.65 keeps the dense tables airy without ballooning. */
  font: 14px/1.65 var(--sans);
  -webkit-text-size-adjust: 100%;
}
/* Restrained motion only: opacity and color fade for state changes, no
   transforms/parallax. Honor the user's reduced-motion preference outright. */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
}
.wrap { max-width: 1200px; margin: 0 auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; transition: border-color var(--dur) var(--ease); }
.card:focus-within { border-color: color-mix(in srgb, var(--accent) 35%, var(--border)); }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.card-head h2 { margin: 0; font-size: 12px; letter-spacing: 0.08em; color: var(--muted); font-weight: 650; line-height: 1.4; }
/* ── tab rail ── same underline language as the plugin settings tabs: 13px
   labels, 2px active bar, focus ring, 150ms fade. One rail for the whole admin
   page, so the poll still reconciles every section and tabs never go stale. */
.tabs {
  display: flex; flex-wrap: wrap; align-items: flex-end; gap: 20px;
  border-bottom: 1px solid var(--border); margin-bottom: 4px;
}
.tab {
  position: relative; padding: 7px 1px 9px; border: 0; background: none; cursor: pointer;
  color: var(--muted); font: inherit; font-size: 13px; line-height: 1.4;
  transition: color var(--dur) var(--ease);
}
.tab:hover, .tab[data-active='true'] { color: var(--text); }
.tab[data-active='true']::after, .tab:focus-visible::after {
  content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px;
  border-radius: 2px 2px 0 0; background: var(--accent);
}
.tab:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent) 70%, transparent); outline-offset: 2px;
  border-radius: 4px; color: var(--text);
}
@media (max-width: 560px) { .tabs { gap: 12px; } }
.hint { margin: 5px 0 8px; color: var(--muted); font-size: 12px; }
.muted { color: var(--muted); }
.mono, code, .mono input, input.mono, textarea.mono { font-family: var(--mono); font-size: 12px; }
code { background: var(--panel-2); border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px; }
.top {
  position: sticky; top: 0; z-index: 20;
  display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;
  background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 9px 13px;
  box-shadow: 0 1px 0 var(--panel), 0 2px 6px rgba(15, 23, 42, 0.04);
}
.brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
.brand h1 { margin: 0; font-size: 15px; font-weight: 650; white-space: nowrap; line-height: 1.35; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); flex: none; }
.dot.ok { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); }
.dot.bad { background: var(--danger); box-shadow: 0 0 0 3px var(--danger-soft); }
.top-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tools { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
button { font: inherit; color: inherit; }
.btn {
  background: var(--panel-2); border: 1px solid var(--border); border-radius: 7px;
  padding: 5px 11px; cursor: pointer; white-space: nowrap;
  transition: background-color var(--dur) var(--ease), border-color var(--dur) var(--ease), color var(--dur) var(--ease);
}
.btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.btn:active:not(:disabled) { transform: translateY(0.5px); }
.btn:disabled { opacity: 0.5; cursor: default; }
.btn.primary {
  background: var(--accent); border-color: var(--accent); color: var(--accent-text); font-weight: 600;
}
.btn.primary:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 90%, black); color: var(--accent-text); }
.btn.small { padding: 2px 8px; font-size: 12px; }
input, select, textarea { font: inherit; color: inherit; }
input[type="text"], input[type="password"], input[type="number"], select, textarea {
  width: 100%; min-width: 0; background: var(--panel-2); border: 1px solid var(--border);
  border-radius: 7px; padding: 4px 7px;
  transition: border-color var(--dur) var(--ease), background-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
input[type="checkbox"] { width: auto; }
textarea { resize: vertical; }
input.ro { background: transparent; border-style: dashed; color: var(--muted); }
input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent) 70%, transparent); outline-offset: 1px;
}
.table-wrap { overflow-x: auto; }
table.grid { border-collapse: collapse; width: 100%; }
table.grid th, table.grid td { border-bottom: 1px solid var(--border); padding: 6px 9px; text-align: left; vertical-align: top; transition: background-color var(--dur) var(--ease); }
table.grid tbody tr:hover td { background: color-mix(in srgb, var(--accent) 6%, transparent); }
table.grid thead th {
  font-size: 11px; letter-spacing: 0.06em; color: var(--muted);
  font-weight: 600; white-space: nowrap; background: var(--panel); line-height: 1.5;
}
.nowrap { white-space: nowrap; }
.row-error { color: var(--danger); font-size: 12px; display: block; min-height: 0; }
.badge {
  display: inline-block; padding: 1px 7px; border-radius: 99px; font-size: 11px;
  font-weight: 600; background: var(--panel-2); border: 1px solid var(--border); white-space: nowrap;
}
.badge.ok { background: var(--ok-soft); color: var(--ok); border-color: transparent; }
.badge.warn { background: var(--warn-soft); color: var(--warn); border-color: transparent; }
.badge.bad { background: var(--danger-soft); color: var(--danger); border-color: transparent; }
.badge.kind { font-family: var(--mono); font-weight: 500; }
.badge.ver { font-family: var(--mono); font-size: 11px; }
.fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px 12px; margin: 10px 0; }
.field { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.field > label { display: flex; justify-content: space-between; gap: 6px; font-size: 12px; color: var(--muted); }
.field .bounds { font-family: var(--mono); font-size: 11px; white-space: nowrap; }
.field-error { color: var(--danger); font-size: 11px; }
.stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }
.stat { background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 11px; transition: border-color var(--dur) var(--ease), background-color var(--dur) var(--ease); }
.stat:hover { border-color: var(--border-color-hover, color-mix(in srgb, var(--accent) 30%, var(--border))); }
.stat b { display: block; font-family: var(--mono); font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: 0.01em; }
.stat span { color: var(--muted); font-size: 11px; letter-spacing: 0.05em; }
.events { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0; max-height: 340px; overflow: auto; }
.events li { display: flex; gap: 8px; align-items: baseline; padding: 5px 4px 5px 0; border-bottom: 1px solid var(--border); font-size: 13px; border-radius: 4px; transition: background-color var(--dur) var(--ease); }
.events li:hover { background: color-mix(in srgb, var(--accent) 5%, transparent); }
.events li:last-child { border-bottom: none; }
.events .time { font-family: var(--mono); color: var(--muted); font-size: 12px; flex: none; }
.events .ev-extra { font-size: 12px; }
.empty { color: var(--muted); font-size: 12px; padding: 6px 0; }
.probe-out { font-family: var(--mono); font-size: 11px; color: var(--muted); margin-top: 3px; max-width: 420px; word-break: break-word; }
.probe-out.ok { color: var(--ok); }
.probe-out.bad { color: var(--danger); }
.notice { background: var(--warn-soft); border: 1px solid var(--warn); color: var(--warn); border-radius: 6px; padding: 7px 11px; font-size: 13px; }
.section-error { color: var(--danger); font-size: 12px; margin: 6px 0 0; }
.section-error:empty { display: none; }
.kv { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 3px 0; }
.providers-body { display: flex; flex-direction: column; gap: 10px; }
.provider { border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px; background: var(--panel); transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease); }
.provider:hover { border-color: color-mix(in srgb, var(--accent) 25%, var(--border)); }
.provider-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.provider-id { font-weight: 600; overflow-wrap: anywhere; }
.provider-tools { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.provider .fields { margin: 8px 0 0; }
.keys { border-top: 1px dashed var(--border); margin-top: 9px; padding-top: 7px; }
.keys-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.keys-head h3 { margin: 0; font-size: 11px; letter-spacing: 0.08em; color: var(--muted); font-weight: 650; line-height: 1.5; }
.key-list { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.key-row { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; background: var(--panel-2); display: flex; flex-direction: column; gap: 4px; transition: border-color var(--dur) var(--ease), background-color var(--dur) var(--ease); }
.key-row:hover { border-color: color-mix(in srgb, var(--accent) 30%, var(--border)); }
.key-row.blacklisted { border-color: var(--danger); background: color-mix(in srgb, var(--danger-soft) 45%, var(--panel-2)); }
.key-main { display: grid; grid-template-columns: minmax(120px, 1fr) minmax(180px, 1.6fr) auto; gap: 6px; align-items: center; }
.key-actions { grid-column: 1 / -1; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.key-meta { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; font-size: 12px; color: var(--muted); }
.models-line { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
.models-line select { width: auto; min-width: 140px; }
@media (max-width: 720px) { .key-main { grid-template-columns: 1fr; } }
[hidden] { display: none !important; }
.clip { position: fixed; left: -9999px; top: 0; }
#toasts { position: fixed; right: 14px; bottom: 14px; z-index: 50; display: flex; flex-direction: column; gap: 6px; max-width: min(440px, 92vw); }
.toast {
  background: var(--panel); border: 1px solid var(--border); border-left: 3px solid var(--accent);
  border-radius: 7px; padding: 8px 11px; box-shadow: var(--shadow); font-size: 13px; word-break: break-word;
  opacity: 0; transform: translateY(4px);
  animation: toast-in 220ms var(--ease) forwards;
}
@keyframes toast-in { to { opacity: 1; transform: translateY(0); } }
@media (prefers-reduced-motion: reduce) { .toast { animation: none; opacity: 1; transform: none; } }
.toast.ok { border-left-color: var(--ok); }
.toast.warn { border-left-color: var(--warn); }
.toast.error { border-left-color: var(--danger); }
</style>
</head>
<body>
<div class="wrap">

  <header class="top">
    <div class="brand">
      <span class="dot" id="up-dot" aria-hidden="true"></span>
      <h1 data-i18n="serviceName"></h1>
      <span class="badge ver" id="header-version"></span>
      <span class="muted" id="up-text"></span>
    </div>
    <div class="top-right">
      <code class="mono" id="base-url"></code>
      <span class="muted" id="last-updated"></span>
      <button type="button" class="btn" id="lang-toggle"></button>
      <button type="button" class="btn primary" id="refresh" data-i18n="refresh"></button>
    </div>
  </header>

  <div class="notice" id="restart-notice" role="status" hidden data-i18n="restartNotice"></div>

  <nav class="tabs" id="tabs" role="tablist" aria-label="view">
    <button type="button" class="tab" role="tab" data-tabkey="providers" data-i18n="tabProviders"></button>
    <button type="button" class="tab" role="tab" data-tabkey="routing" data-i18n="tabRouting"></button>
    <button type="button" class="tab" role="tab" data-tabkey="monitor" data-i18n="tabMonitor"></button>
    <button type="button" class="tab" role="tab" data-tabkey="blacklist" data-i18n="tabBlacklist"></button>
    <button type="button" class="tab" role="tab" data-tabkey="server" data-i18n="tabServer"></button>
  </nav>

  <section class="card" id="sec-providers" data-tab="providers">
    <div class="card-head">
      <h2 data-i18n="providers"></h2>
      <div class="tools">
        <button type="button" class="btn" data-act="add-provider" data-i18n="addProvider"></button>
        <button type="button" class="btn primary" data-act="save-providers" data-i18n="saveProviders"></button>
      </div>
    </div>
    <p class="hint" data-i18n="providersHint"></p>
    <div class="notice" data-role="removed-notice" role="status" hidden></div>
    <p class="section-error" data-role="section-error" role="alert"></p>
    <div id="providers-body"></div>
  </section>

  <section class="card" id="sec-routing" data-tab="routing">
    <div class="card-head">
      <h2 data-i18n="routing"></h2>
    </div>
    <p class="hint" data-i18n="routingHint"></p>
    <p class="section-error" data-role="section-error" role="alert"></p>
    <div id="routing-body"></div>
  </section>

  <section class="card" id="sec-live" data-tab="monitor">
    <div class="card-head">
      <h2 data-i18n="live"></h2>
      <div class="tools">
        <span class="muted" id="live-updated"></span>
        <button type="button" class="btn" data-act="reset" data-i18n="resetBreakers"></button>
      </div>
    </div>
    <p class="hint" data-i18n="liveHint"></p>
    <div class="table-wrap">
      <table class="grid">
        <thead>
          <tr>
            <th data-i18n="thState"></th>
            <th data-i18n="thUnit"></th>
            <th data-i18n="thRoute"></th>
            <th data-i18n="thFailures"></th>
            <th data-i18n="thRate"></th>
            <th data-i18n="thTrips"></th>
            <th data-i18n="thCooldown"></th>
            <th data-i18n="thBlacklist"></th>
            <th data-i18n="thLastFailure"></th>
            <th data-i18n="thConverter"></th>
            <th data-i18n="thProbe"></th>
          </tr>
        </thead>
        <tbody id="live-body"></tbody>
      </table>
    </div>
  </section>

  <section class="card" id="sec-blacklist" data-tab="blacklist">
    <div class="card-head"><h2 data-i18n="blacklist"></h2></div>
    <div class="table-wrap">
      <table class="grid">
        <thead>
          <tr>
            <th data-i18n="thUnit"></th>
            <th data-i18n="thReason"></th>
            <th data-i18n="thMessage"></th>
            <th data-i18n="thSince"></th>
            <th data-i18n="thRecover"></th>
            <th data-i18n="thActions"></th>
          </tr>
        </thead>
        <tbody id="blacklist-body"></tbody>
      </table>
    </div>
  </section>

  <section class="card" id="sec-recent" data-tab="monitor">
    <div class="card-head"><h2 data-i18n="recent"></h2></div>
    <p class="hint" id="time-slot-line"></p>
    <ul class="events" id="recent-body"></ul>
  </section>

  <section class="card" id="sec-stats" data-tab="monitor">
    <div class="card-head"><h2 data-i18n="stats"></h2></div>
    <div class="stats" id="stats-body"></div>
  </section>

  <section class="card" id="sec-raw" data-tab="server">
    <div class="card-head"><h2 data-i18n="rawTitle"></h2></div>
    <p class="hint" data-i18n="rawHint"></p>
    <p class="section-error" data-role="section-error" role="alert"></p>
    <div class="kv">
      <span class="muted" data-i18n="rawBase"></span>
      <code class="mono" id="raw-base"></code>
      <button type="button" class="btn small" id="raw-base-copy" data-i18n="copy"></button>
    </div>
    <div class="kv">
      <code class="mono" data-i18n="rawChat"></code>
      <button type="button" class="btn small" id="raw-chat-copy" data-i18n="copy"></button>
    </div>
    <div class="kv">
      <code class="mono" data-i18n="rawModels"></code>
      <button type="button" class="btn small" id="raw-models-copy" data-i18n="copy"></button>
    </div>
    <div class="kv">
      <label for="server-port" data-i18n="serverPort"></label>
      <input type="number" id="server-port" class="mono" min="1" max="65535" step="1">
      <button type="button" class="btn" id="save-port" data-i18n="savePort"></button>
      <span class="muted" data-i18n="serverHost"></span>
      <code class="mono" id="server-host"></code>
      <span class="field-error" data-err="port"></span>
    </div>
  </section>

</div>
<div id="toasts" role="status" aria-live="polite"></div>
<script>
(function () {
  'use strict';

  var BOOT = ${boot};
  var LANG_KEY = 'dsh-router-lang';
  // The tab strip is a view preference like the language, so it is remembered
  // the same way and survives a reload. The monitor tab is the landing tab: this
  // page exists to answer "is routing working", and the connection state is
  // already in the header, but the live table is what that answer is read off.
  var TAB_KEY = 'dsh-router-tab';
  var DEFAULT_TAB = 'monitor';
  var POLL_MS = 4000;
  var ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
  var MAX_KEYS = 16;
  var TIMEOUT_MIN = 1000;
  var TIMEOUT_MAX = 3600000;

  // Every user-visible string lives here; Chinese is the primary language and
  // English is the fallback for a missing key, not the other way round.
  var STRINGS = {
    zh: {
      serviceName: 'DSH 模型路由服务',
      refresh: '刷新',
      tabProviders: '供应商',
      tabRouting: '路由',
      tabMonitor: '监控',
      tabBlacklist: '拉黑',
      tabServer: '接入',
      lastUpdated: '最后更新',
      up: '在线',
      down: '离线',
      loading: '加载中…',
      providers: '供应商',
      providersHint: '每把密钥单独熔断与拉黑；密钥留空表示保留已保存的值。',
      addProvider: '新增供应商',
      saveProviders: '保存供应商',
      thId: 'ID',
      thLabel: '名称',
      thBaseURL: 'baseURL',
      thApiKey: 'API Key',
      thModels: '模型（逗号分隔）',
      thActions: '操作',
      apiKeySet: '已配置（留空则保留）',
      apiKeyUnset: '未配置',
      deleteRow: '删除',
      routing: '路由顺序',
      routingHint: '按顺序尝试候选；引用未注册供应商的行会被标记，可一键移除。',
      saveRouting: '保存路由',
      thProvider: '供应商',
      thModel: '模型',
      thRouteLabel: '备注',
      moveUp: '上移',
      moveDown: '下移',
      removeUnregistered: '移除未注册行',
      notRegistered: '未注册',
      enabled: '启用路由',
      retries: '重试次数',
      failureThreshold: '失败阈值',
      failureRateThreshold: '失败率阈值 (%)',
      minSamples: '最小样本数',
      windowSize: '样本窗口',
      windowMs: '统计窗口 (ms)',
      cooldownMs: '冷却时间 (ms)',
      cooldownFactor: '冷却倍率',
      cooldownMaxMs: '冷却上限 (ms)',
      halfOpenSuccesses: '半开恢复成功数',
      maxSwitches: '最大切换次数 (0=自动)',
      recoveryMode: '恢复方式',
      logLevel: '日志级别',
      modeProbe: '探测后恢复',
      modeImmediate: '立即恢复',
      budget: '切换预算（推导）',
      live: '实时状态',
      liveHint: '一行 = 一条路由 × 一把密钥；页面可见且无请求进行时每 4 秒自动刷新。',
      resetBreakers: '清除熔断状态',
      probe: '探测',
      probing: '探测中…',
      stateClosed: '正常',
      stateHalfOpen: '探测中',
      stateOpen: '熔断',
      thState: '状态',
      thUnit: '单元',
      thRoute: '路由',
      thFailures: '连续失败/阈值',
      thRate: '失败率 · 样本',
      thTrips: '熔断次数',
      thCooldown: '冷却',
      thBlacklist: '拉黑',
      thLastFailure: '最近失败',
      thConverter: '转换器',
      thProbe: '探测',
      recent: '最近事件',
      recentEmpty: '暂无事件',
      stats: '统计',
      statRequests: '请求',
      statFailures: '失败',
      statOpens: '熔断',
      statSwitches: '切换',
      statRetries: '重试',
      statExhausted: '候选耗尽',
      statProbes: '探测',
      statProbeOk: '探测成功',
      statRejected: '被拒绝',
      statIgnored: '未计入',
      statBlacklisted: '拉黑',
      rawTitle: '原始接口',
      rawHint: '把其他 Agent 指向下面的 OpenAI 兼容地址：',
      rawBase: '地址',
      rawChat: 'POST /v1/chat/completions',
      rawModels: 'GET /v1/models',
      copy: '复制',
      copied: '已复制',
      copyFailed: '复制失败',
      serverPort: '服务端口',
      serverHost: '监听地址',
      savePort: '保存端口',
      restartNotice: '端口已修改，需要重启服务生效。',
      none: '无',
      saved: '已保存',
      fixErrors: '请先修正表单中的错误',
      badResponse: '响应格式不正确',
      netError: '网络请求失败',
      pollFailed: '状态刷新失败',
      invalidId: 'ID 必须匹配 ^[A-Za-z0-9._-]{1,64}$',
      invalidBaseURL: 'baseURL 必须是 http/https 地址',
      modelsEmptyWarn: '以下供应商未填手工模型，只能使用「拉取模型」的结果：{ids}',
      invalidNumber: '数值必须是范围内的整数',
      invalidPercent: '百分比必须是 0 到 100 之间的数值',
      invalidTimeout: '超时必须是 1000 到 3600000 之间的整数毫秒',
      duplicateId: 'ID 重复',
      rowIncomplete: '供应商与模型都必须填写',
      reasoningChars: '推理字符',
      attemptLabel: '第',
      attemptUnit: '次尝试',
      waitLabel: '等待',
      probeOk: '成功',
      probeFail: '失败',
      kindRetry: '重试',
      kindFailure: '失败',
      kindSwitch: '切换',
      kindSuccess: '成功',
      kindExhausted: '耗尽',
      kindNoAlternative: '无备用',
      kindProbe: '探测',
      kindBlacklist: '拉黑',
      kindIgnored: '未计入',
      kindUnconfigured: '未配置',
      kindTimeslot: '时段停用',
      evRetry: '{provider} 第 {attempt} 次重试，等待 {wait}',
      evFailure: '{provider} 请求失败：{failure}',
      evSwitch: '{provider} 切换到 {to}',
      evSuccess: '{provider} 请求成功',
      evExhausted: '所有候选均已失败，请求终止',
      evNoAlternative: '{provider} 无可用备用候选',
      evProbe: '探测 {provider}：{outcome}',
      evBlacklist: '{provider} 的凭证被拉黑：{message}',
      evIgnored: '{provider} 的失败未计入熔断：{failure}',
      evUnconfigured: '{provider} 未配置，已跳过',
      evTimeslot: '{provider} 被时段 {message} 停用，本轮不参与选路',
      timeSlotIdle: '当前无命中时段，按静态顺序选路',
      timeSlotActive: '当前命中时段 {label}（{at}），{count} 家供应商按时段优先',
      evKey: '密钥',
      empty: '（空）',
      noUnregistered: '没有未注册行',
      keysTitle: '密钥',
      keyLabel: '备注（可选）',
      keySet: '已配置（留空则保留）',
      keyUnset: '未配置',
      keyMasked: '当前密钥',
      keyNew: '未保存',
      keyAuto: '自动（第一把）',
      noKeys: '还没有密钥',
      addKey: '新增密钥',
      deleteKey: '删除密钥',
      confirmDeleteKey: '删除这把密钥？保存后生效。',
      confirmDeleteProvider: '删除整个供应商及其密钥？保存后生效。',
      keyLimitReached: '一个供应商最多 16 把密钥',
      fetchModels: '从上游刷新',
      fetchingModels: '正在拉取…',
      modelsFetched: '已拉取 {count} 个模型',
      modelsFailed: '拉取失败：{code} {message}',
      modelsNone: '尚未从上游拉取',
      modelsKey: '拉取用密钥',
      timeoutMs: '超时 (ms，可选)',
      newProvider: '新供应商',
      noProviders: '还没有供应商',
      addRoute: '新增路由',
      routeLimitReached: '路由表最多 {count} 行',
      slotsTitle: '时段优先级（峰谷定价）',
      slotsHint: '同一时刻命中多条时，按最具体的规则生效；档位 1–9（越小越优先），0 = 本时段停用；未配置时段或未命中时按静态顺序表。',
      addSlot: '新增时段',
      thSlotStart: '开始 (HH:mm)',
      thSlotEnd: '结束 (HH:mm)',
      thSlotPriority: '该时段各供应商档位',
      slotDelete: '删除',
      slotLimitReached: '时段表最多 {count} 条',
      slotRowIncomplete: '请填起止时间',
      slotBadClock: '时间须为 HH:mm',
      slotPriorityOutOfRange: '档位须为 0–9 整数',
      slotNoProvider: '该时段至少要给一家供应商填档位',
      blacklisted: '已拉黑',
      restore: '恢复',
      restoreAll: '恢复全部',
      restored: '已恢复 {count} 条拉黑记录',
      recoverIn: '剩余',
      recoverManual: '需手动恢复',
      blacklist: '拉黑凭证',
      blacklistEmpty: '没有拉黑中的凭证',
      thReason: '原因',
      thMessage: '上游信息',
      thSince: '拉黑时间',
      thRecover: '恢复',
      reasonInsufficientBalance: '余额或额度不足',
      reasonAuthenticationError: '密钥被拒绝',
      reasonPermissionError: '权限不足',
      reasonUnknown: '未知原因',
      classRetryable: '可重试',
      classOverloaded: '限流',
      classNonRetryable: '不可重试',
      classQuota: '额度',
      classClientCancel: '已取消',
      removedOrderRows: '已移除 {count} 行路由：{rows}',
      reasonProviderNotConfigured: '供应商未配置',
      reasonModelNotAvailable: '模型不可用'
    },
    en: {
      serviceName: 'DSH model router service',
      refresh: 'Refresh',
      tabProviders: 'Providers',
      tabRouting: 'Routing',
      tabMonitor: 'Monitor',
      tabBlacklist: 'Blacklist',
      tabServer: 'Access',
      lastUpdated: 'Last updated',
      up: 'up',
      down: 'down',
      loading: 'Loading…',
      providers: 'Providers',
      providersHint: 'Each credential breaks and blacklists on its own; a blank secret keeps the stored one.',
      addProvider: 'Add provider',
      saveProviders: 'Save providers',
      thId: 'ID',
      thLabel: 'Label',
      thBaseURL: 'baseURL',
      thApiKey: 'API Key',
      thModels: 'Models (comma separated)',
      thActions: 'Actions',
      thActions: 'Actions',
      apiKeySet: 'configured (empty keeps it)',
      apiKeyUnset: 'not configured',
      deleteRow: 'Delete',
      routing: 'Routing order',
      routingHint: 'Candidates are tried in order; rows naming an unknown provider are flagged and can be removed in one click.',
      saveRouting: 'Save routing',
      thProvider: 'Provider',
      thModel: 'Model',
      thRouteLabel: 'Label',
      moveUp: 'Up',
      moveDown: 'Down',
      removeUnregistered: 'Remove unregistered rows',
      notRegistered: 'not registered',
      enabled: 'Routing enabled',
      retries: 'Retries',
      failureThreshold: 'Failure threshold',
      failureRateThreshold: 'Failure-rate threshold (%)',
      minSamples: 'Min samples',
      windowSize: 'Sample window',
      windowMs: 'Window (ms)',
      cooldownMs: 'Cooldown (ms)',
      cooldownFactor: 'Cooldown factor',
      cooldownMaxMs: 'Cooldown ceiling (ms)',
      halfOpenSuccesses: 'Half-open successes',
      maxSwitches: 'Max switches (0 = auto)',
      recoveryMode: 'Recovery mode',
      logLevel: 'Log level',
      modeProbe: 'probe then recover',
      modeImmediate: 'recover immediately',
      budget: 'Switch budget (derived)',
      live: 'Live state',
      liveHint: 'One row per route times credential; auto-refreshes every 4s while the tab is visible and no request is in flight.',
      resetBreakers: 'Reset breakers',
      probe: 'Probe',
      probing: 'Probing…',
      stateClosed: 'closed',
      stateHalfOpen: 'half-open',
      stateOpen: 'open',
      thState: 'State',
      thUnit: 'Unit',
      thRoute: 'Route',
      thFailures: 'Consecutive / threshold',
      thRate: 'Rate · samples',
      thTrips: 'Trips',
      thCooldown: 'Cooldown',
      thBlacklist: 'Blacklisted',
      thLastFailure: 'Last failure',
      thConverter: 'Converter',
      thProbe: 'Probe',
      recent: 'Recent events',
      recentEmpty: 'No events yet',
      stats: 'Stats',
      statRequests: 'Requests',
      statFailures: 'Failures',
      statOpens: 'Opens',
      statSwitches: 'Switches',
      statRetries: 'Retries',
      statExhausted: 'Exhausted',
      statProbes: 'Probes',
      statProbeOk: 'Probe ok',
      statRejected: 'Rejected',
      statIgnored: 'Ignored',
      statBlacklisted: 'Blacklisted',
      rawTitle: 'Raw endpoint',
      rawHint: 'Point other agents at the OpenAI-compatible URL below:',
      rawBase: 'Base URL',
      rawChat: 'POST /v1/chat/completions',
      rawModels: 'GET /v1/models',
      copy: 'Copy',
      copied: 'Copied',
      copyFailed: 'Copy failed',
      serverPort: 'Service port',
      serverHost: 'Bind address',
      savePort: 'Save port',
      restartNotice: 'Port changed — requires a service restart.',
      none: 'none',
      saved: 'Saved',
      fixErrors: 'Fix the highlighted fields first',
      badResponse: 'Unexpected response shape',
      netError: 'Request failed',
      pollFailed: 'State refresh failed',
      invalidId: 'ID must match ^[A-Za-z0-9._-]{1,64}$',
      invalidBaseURL: 'baseURL must be an http/https URL',
      modelsEmptyWarn: 'No manual models for: {ids} — only models fetched from upstream can be used',
      invalidNumber: 'Value must be an integer in range',
      invalidPercent: 'Percentage must be a number between 0 and 100',
      invalidTimeout: 'Timeout must be an integer number of milliseconds between 1000 and 3600000',
      duplicateId: 'duplicate ID',
      rowIncomplete: 'provider and model are both required',
      reasoningChars: 'reasoning chars',
      attemptLabel: 'attempt',
      attemptUnit: '',
      waitLabel: 'wait',
      probeOk: 'ok',
      probeFail: 'failed',
      kindRetry: 'retry',
      kindFailure: 'failure',
      kindSwitch: 'switch',
      kindSuccess: 'success',
      kindExhausted: 'exhausted',
      kindNoAlternative: 'no-alternative',
      kindProbe: 'probe',
      kindBlacklist: 'blacklist',
      kindIgnored: 'ignored',
      kindUnconfigured: 'unconfigured',
      kindTimeslot: 'slot-disabled',
      evRetry: '{provider} retry {attempt}, waiting {wait}',
      evFailure: '{provider} failed: {failure}',
      evSwitch: '{provider} switched to {to}',
      evSuccess: '{provider} succeeded',
      evExhausted: 'all candidates failed, request abandoned',
      evNoAlternative: '{provider} has no available alternative',
      evProbe: 'probe {provider}: {outcome}',
      evBlacklist: 'credential for {provider} was blacklisted: {message}',
      evIgnored: '{provider} failure not counted by the breaker: {failure}',
      evUnconfigured: '{provider} is not configured, skipped',
      evTimeslot: '{provider} is disabled by time slot {message} and is out of routing this turn',
      timeSlotIdle: 'no time slot is active now; routing follows the static order',
      timeSlotActive: 'time slot {label} is active ({at}); {count} provider(s) take precedence by slot',
      evKey: 'key',
      empty: '(empty)',
      noUnregistered: 'no unregistered rows',
      keysTitle: 'Credentials',
      keyLabel: 'Label (optional)',
      keySet: 'configured (empty keeps it)',
      keyUnset: 'not configured',
      keyMasked: 'stored secret',
      keyNew: 'unsaved',
      keyAuto: 'auto (first)',
      noKeys: 'no credentials yet',
      addKey: 'Add credential',
      deleteKey: 'Delete credential',
      confirmDeleteKey: 'Delete this credential? It takes effect when you save.',
      confirmDeleteProvider: 'Delete this provider and all of its credentials? It takes effect when you save.',
      keyLimitReached: 'A provider holds at most 16 credentials',
      fetchModels: 'Refresh from upstream',
      fetchingModels: 'Fetching…',
      modelsFetched: 'Fetched {count} models',
      modelsFailed: 'Fetch failed: {code} {message}',
      modelsNone: 'not fetched from upstream yet',
      modelsKey: 'Fetch with',
      timeoutMs: 'Timeout (ms, optional)',
      newProvider: 'new provider',
      noProviders: 'No providers yet',
      addRoute: 'Add route',
      routeLimitReached: 'The order table holds at most {count} rows',
      slotsTitle: 'Time-slot priority (peak/off-peak)',
      slotsHint: 'When several rules match at once the most specific one wins; priority 1–9 (lower is preferred), 0 = disabled during this slot; providers with no slot config or no active match follow the static order table.',
      addSlot: 'Add slot',
      thSlotStart: 'Start (HH:mm)',
      thSlotEnd: 'End (HH:mm)',
      thSlotPriority: 'Priority per provider in this slot',
      slotDelete: 'Delete',
      slotLimitReached: 'The time-slot table holds at most {count} rules',
      slotRowIncomplete: 'fill in both start and end',
      slotBadClock: 'time must be HH:mm',
      slotPriorityOutOfRange: 'priority must be an integer 0–9',
      slotNoProvider: 'a slot must name at least one provider',
      blacklisted: 'blacklisted',
      restore: 'Restore',
      restoreAll: 'Restore all',
      restored: 'restored {count} blacklist entries',
      recoverIn: 'in',
      recoverManual: 'manual restore',
      blacklist: 'Blacklisted credentials',
      blacklistEmpty: 'nothing is blacklisted',
      thReason: 'Reason',
      thMessage: 'Upstream message',
      thSince: 'Blacklisted at',
      thRecover: 'Recovers',
      reasonInsufficientBalance: 'out of balance or quota',
      reasonAuthenticationError: 'credential rejected',
      reasonPermissionError: 'permission denied',
      reasonUnknown: 'unknown reason',
      classRetryable: 'retryable',
      classOverloaded: 'overloaded',
      classNonRetryable: 'non-retryable',
      classQuota: 'quota',
      classClientCancel: 'cancelled',
      removedOrderRows: 'Removed {count} route row(s): {rows}',
      reasonProviderNotConfigured: 'provider not configured',
      reasonModelNotAvailable: 'model not available'
    }
  };

  // ---- boot-time facts -----------------------------------------------------

  var meta = document.querySelector('meta[name="router-token"]');
  var TOKEN = meta ? String(meta.getAttribute('content') || '') : '';
  var PREFIX = trimSlashes(BOOT.basePath);
  var API = PREFIX + '/admin/api/';
  var origin = (window.location && window.location.origin && window.location.origin !== 'null')
    ? window.location.origin
    : ('http://' + BOOT.host + ':' + BOOT.port);
  var SERVICE_ROOT = origin + PREFIX + '/';
  var RAW_BASE = SERVICE_ROOT + 'v1';

  // ---- mutable page state --------------------------------------------------

  var STATE = null;
  var lang = readLang();
  var busy = 0;
  var connected = null;
  var lastOkAt = 0;
  var pollTimer = null;
  var sigs = { providers: '', routing: '' };
  var dirty = { providers: false, routing: false };
  var probeResults = {};
  var modelsResults = {};
  var lastRemovedRows = [];
  var datalistSeq = 0;
  var newKeySeq = 0;
  var liveRefs = new WeakMap();
  var blacklistRefs = new WeakMap();
  var statRefs = null;
  var liveBody = null;
  var recentBody = null;
  var statsBody = null;
  var providersBody = null;
  var routingBody = null;
  var blacklistBody = null;

  var STAT_KEYS = [
    ['requests', 'statRequests'], ['failures', 'statFailures'], ['opens', 'statOpens'],
    ['switches', 'statSwitches'], ['retries', 'statRetries'], ['exhausted', 'statExhausted'],
    ['probes', 'statProbes'], ['probeOk', 'statProbeOk'], ['rejected', 'statRejected'],
    ['ignored', 'statIgnored'], ['blacklisted', 'statBlacklisted']
  ];
  var KIND_KEYS = {
    retry: 'kindRetry', failure: 'kindFailure', switch: 'kindSwitch', success: 'kindSuccess',
    exhausted: 'kindExhausted', probe: 'kindProbe', blacklist: 'kindBlacklist',
    ignored: 'kindIgnored', unconfigured: 'kindUnconfigured', timeslot: 'kindTimeslot'
  };
  var CLASS_KEYS = {
    retryable: 'classRetryable', overloaded: 'classOverloaded', non_retryable: 'classNonRetryable',
    quota: 'classQuota', client_cancel: 'classClientCancel'
  };
  var REASON_KEYS = {
    insufficient_balance: 'reasonInsufficientBalance', authentication_error: 'reasonAuthenticationError',
    permission_error: 'reasonPermissionError', unknown: 'reasonUnknown'
  };

  // ---- language ------------------------------------------------------------

  function readLang() {
    var saved = null;
    try { saved = window.localStorage.getItem(LANG_KEY); } catch (err) { saved = null; }
    if (saved === 'zh' || saved === 'en') return saved;
    var nav = String(navigator.language || navigator.userLanguage || '').toLowerCase();
    return nav.indexOf('zh') === 0 ? 'zh' : 'en';
  }

  function t(key) {
    var table = STRINGS[lang] || STRINGS.en;
    if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
    if (Object.prototype.hasOwnProperty.call(STRINGS.en, key)) return STRINGS.en[key];
    return key;
  }

  /** Fill {name} placeholders without a template literal or a regex. */
  function fmt(template, vars) {
    var text = String(template);
    var out = '';
    var cursor = 0;
    while (cursor < text.length) {
      var open = text.indexOf('{', cursor);
      if (open < 0) break;
      var close = text.indexOf('}', open + 1);
      if (close < 0) break;
      out += text.slice(cursor, open);
      var name = text.slice(open + 1, close);
      out += (vars && vars[name] !== undefined && vars[name] !== null) ? String(vars[name]) : '';
      cursor = close + 1;
    }
    return out + text.slice(cursor);
  }

  function trimSlashes(value) {
    var out = String(value === null || value === undefined ? '' : value);
    while (out.length > 0 && out.charAt(out.length - 1) === '/') out = out.slice(0, out.length - 1);
    return out;
  }

  function applyStatic() {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = t(nodes[i].getAttribute('data-i18n'));
    var langButton = document.getElementById('lang-toggle');
    if (langButton) langButton.textContent = lang === 'zh' ? 'English' : '中文';
  }

  function setLang(next) {
    lang = next === 'zh' ? 'zh' : 'en';
    try { window.localStorage.setItem(LANG_KEY, lang); } catch (err) { /* private mode: the toggle still works for this view */ }
    applyStatic();
    // The generated sections carry their labels in text nodes, so they are
    // rebuilt — but only where no draft is in flight, because relabelling a
    // half-typed provider out from under the cursor would lose the edit.
    sigs.providers = '';
    sigs.routing = '';
    statRefs = null;
    renderHeader();
    renderProviders();
    renderRouting();
    renderLive();
    renderBlacklist();
    renderRecent();
    renderStats();
    renderServer();
    showRemovedNotice(lastRemovedRows, true);
  }

  // ---- DOM helpers (static markup plus text nodes only: text stays text) ---

  function el(tag, attrs, kids) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var key in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
        var value = attrs[key];
        if (value === null || value === undefined) continue;
        if (key === 'class') node.className = String(value);
        else if (key === 'text') node.textContent = String(value);
        else if (key === 'style') node.setAttribute('style', String(value));
        else if (key === 'value' || key === 'checked' || key === 'selected' || key === 'readonly' || key === 'disabled' || key === 'multiple') node[key] = value;
        else if (key.indexOf('on') === 0 && typeof value === 'function') node.addEventListener(key.slice(2), value);
        else if (typeof value === 'boolean') { if (value) node.setAttribute(key, ''); }
        else node.setAttribute(key, String(value));
      }
    }
    if (kids) {
      for (var i = 0; i < kids.length; i++) {
        var kid = kids[i];
        if (kid === null || kid === undefined || kid === false) continue;
        node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
      }
    }
    return node;
  }

  function txt(value) { return document.createTextNode(value === null || value === undefined ? '' : String(value)); }

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  function setText(id, value) {
    var node = document.getElementById(id);
    if (node) node.textContent = value;
  }

  function closestAct(node, selector) {
    if (!node || node.nodeType !== 1 || !node.closest) return null;
    return node.closest(selector);
  }

  function focusInside(rootId) {
    var root = document.getElementById(rootId);
    var active = document.activeElement;
    if (!root || !active || active === document.body) return false;
    return root.contains(active) === true;
  }

  // ---- defensive readers ---------------------------------------------------
  // STATE comes from a service that is allowed to be older or newer than this
  // page, so every array and object is read through one of these.

  function arr(value) { return Array.isArray(value) ? value : []; }
  function obj(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  function str(value) { return typeof value === 'string' ? value : ''; }
  function num(value, fallback) { var n = Number(value); return Number.isFinite(n) ? n : fallback; }
  function has(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }

  // ---- formatting ----------------------------------------------------------

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function fmtClock(at) {
    var date = new Date(num(at, 0));
    if (!Number.isFinite(date.getTime())) return '-';
    return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
  }

  /** Month-day hour:minute, for a blacklist entry's ISO timestamps. */
  function fmtDateTime(value) {
    var ms = typeof value === 'string' ? Date.parse(value) : Number(value);
    if (!Number.isFinite(ms)) return '-';
    var date = new Date(ms);
    if (!Number.isFinite(date.getTime())) return '-';
    return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  /** 1m 30s / 500ms — the operator reads a cooldown, not a millisecond count. */
  function fmtDuration(ms) {
    var value = num(ms, 0);
    if (value < 0) value = 0;
    if (value < 1000) return Math.round(value) + 'ms';
    var seconds = Math.round(value / 1000);
    var hours = Math.floor(seconds / 3600);
    seconds -= hours * 3600;
    var minutes = Math.floor(seconds / 60);
    seconds -= minutes * 60;
    var parts = [];
    if (hours > 0) parts.push(hours + 'h');
    if (minutes > 0) parts.push(minutes + 'm');
    if (seconds > 0 && hours === 0) parts.push(seconds + 's');
    return parts.length > 0 ? parts.join(' ') : '0s';
  }

  function fmtNumber(value) { return String(num(value, 0)); }

  /** A 0–1 ratio as the percentage the operator thinks in. */
  function fmtPercent(value) {
    var rate = num(value, 0);
    if (rate < 0) rate = 0;
    if (rate > 1) rate = 1;
    return String(Math.round(rate * 1000) / 10) + '%';
  }

  /** The same ratio as the number the percentage field shows. */
  function fmtPercentInput(value) { return String(Math.round(num(value, 0) * 1000) / 10); }

  /** Collapse whitespace without a regex (this file cannot hold backslashes). */
  function squeeze(value) {
    var raw = String(value === null || value === undefined ? '' : value);
    var out = '';
    var gap = false;
    for (var i = 0; i < raw.length; i++) {
      var c = raw.charAt(i);
      if (c <= ' ') { gap = true; continue; }
      if (gap && out !== '') out += ' ';
      gap = false;
      out += c;
    }
    return out;
  }

  function snippet(value, limit) {
    var text = squeeze(value);
    if (text.length > limit) text = text.slice(0, limit) + '…';
    return text;
  }

  // ---- labels --------------------------------------------------------------

  function labelOf(map, value, fallback) {
    var key = has(map, value) ? map[value] : null;
    return key === null ? fallback : t(key);
  }

  function stateLabel(value) {
    var name = str(value);
    if (name === 'open') return t('stateOpen');
    if (name === 'half-open') return t('stateHalfOpen');
    return t('stateClosed');
  }

  function stateClass(value) {
    var name = str(value);
    if (name === 'open') return 'bad';
    if (name === 'half-open') return 'warn';
    return 'ok';
  }

  function reasonLabel(reason) { return labelOf(REASON_KEYS, str(reason), t('reasonUnknown')); }
  function classLabel(cls) { return labelOf(CLASS_KEYS, str(cls), str(cls)); }

  /** How long until a blacklist entry lifts, or that a human must lift it. */
  function recoverText(entry) {
    var ms = obj(entry).recoverInMs;
    if (ms !== null && ms !== undefined && Number.isFinite(Number(ms))) return fmtDuration(Number(ms));
    return t('recoverManual');
  }

  // ---- transport -----------------------------------------------------------

  /** The single fetch helper: token header in, envelope checked, Error out. */
  function api(path, body) {
    var options = {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Router-Token': TOKEN },
      cache: 'no-store'
    };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    return window.fetch(API + path, options).then(function (response) {
      return response.text().then(function (text) {
        var payload = null;
        try { payload = JSON.parse(text); } catch (err) { payload = null; }
        if (!response.ok) {
          var envelope = obj(obj(payload).error);
          var detail = str(envelope.message);
          throw new Error('HTTP ' + response.status + (detail !== '' ? ' — ' + detail : ''));
        }
        if (!payload || payload.ok !== true) {
          throw new Error(str(obj(obj(payload).error).message) || t('badResponse'));
        }
        return payload.value;
      });
    }, function (err) {
      throw new Error(t('netError') + ': ' + (err && err.message ? err.message : String(err)));
    });
  }

  function toast(message, kind) {
    var host = document.getElementById('toasts');
    if (!host) return;
    var name = kind === 'error' ? 'error' : kind === 'ok' ? 'ok' : kind === 'warn' ? 'warn' : '';
    var node = el('div', { class: 'toast ' + name }, [txt(message)]);
    host.appendChild(node);
    window.setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, kind === 'error' ? 9000 : kind === 'warn' ? 7000 : 4000);
  }

  /**
   * Run one button-triggered action.
   *
   * busy is what keeps the poll off the wire while a save, probe or upstream
   * fetch is in flight, and the finally is what keeps a thrown error from
   * leaving the button dead for the rest of the page's life.
   */
  function runButton(button, work) {
    if (button) button.disabled = true;
    busy += 1;
    return Promise.resolve()
      .then(work)
      .catch(function (err) { toast(err && err.message ? err.message : String(err), 'error'); })
      .then(function () {
        busy -= 1;
        if (button) button.disabled = false;
      });
  }

  // ---- state application ---------------------------------------------------

  /**
   * Apply a server state.
   *
   * "force" is either false (let every section decide from its own signature
   * and draft flag) or an object naming the sections that must be rebuilt
   * regardless — which is what a save does to the section it just saved, and
   * only to that one, so saving routing cannot discard a provider draft.
   */
  function applyState(next, force) {
    if (next === null || typeof next !== 'object') return;
    STATE = next;
    var forced = force === true ? { providers: true, routing: true } : obj(force);
    renderHeader();
    renderProviders(forced.providers === true);
    renderRouting(forced.routing === true);
    renderLive();
    renderBlacklist();
    renderRecent();
    renderStats();
    renderServer();
  }

  function tick() {
    if (document.visibilityState !== 'visible') return;
    if (busy > 0) return;
    refreshState(false);
  }

  function refreshState(manual) {
    busy += 1;
    return api('state').then(function (next) {
      applyState(next, false);
      lastOkAt = Date.now();
      connected = true;
      renderHeader();
    }, function (err) {
      var message = err && err.message ? err.message : String(err);
      // One toast per outage, not one per poll: a stopped service would
      // otherwise produce a toast every four seconds.
      if (connected !== false) toast(t('pollFailed') + ': ' + message, 'error');
      connected = false;
      renderHeader();
      if (manual) toast(message, 'error');
    }).then(function () { busy -= 1; });
  }

  function startPolling() {
    if (pollTimer === null) pollTimer = window.setInterval(tick, POLL_MS);
  }

  function stopPolling() {
    if (pollTimer !== null) { window.clearInterval(pollTimer); pollTimer = null; }
  }

  // ---- header --------------------------------------------------------------

  function renderHeader() {
    var state = obj(STATE);
    var version = str(state.version) || BOOT.version || '';
    setText('header-version', version !== '' ? 'v' + version : '');
    setText('base-url', SERVICE_ROOT);
    setText('last-updated', t('lastUpdated') + ': ' + (lastOkAt > 0 ? fmtClock(lastOkAt) : '-'));
    setText('up-text', connected === null ? t('loading') : (connected ? t('up') : t('down')));
    var dot = document.getElementById('up-dot');
    if (dot) dot.className = 'dot ' + (connected === null ? '' : (connected ? 'ok' : 'bad'));
  }

  // ---- providers -----------------------------------------------------------

  function providerById(id) {
    var providers = arr(obj(STATE).providers);
    for (var i = 0; i < providers.length; i++) {
      if (str(obj(providers[i]).id) === id) return obj(providers[i]);
    }
    return null;
  }

  function providerIdList() {
    var providers = arr(obj(STATE).providers);
    var out = [];
    for (var i = 0; i < providers.length; i++) {
      var id = str(obj(providers[i]).id);
      if (id !== '') out.push(id);
    }
    return out;
  }

  /**
   * The models a provider can be asked for.
   *
   * "allModels" is the service's own union of the hand-written list and the
   * upstream's last answer; "models" is the fallback for a state that predates
   * that field. The datalists feed off this, so a hand-typed id is never
   * hidden behind a fetched one.
   */
  function providerModels(id) {
    var provider = providerById(id);
    if (provider === null) return [];
    var list = arr(provider.allModels);
    if (list.length === 0) list = arr(provider.models);
    return list;
  }

  function fillModelOptions(datalist, models) {
    clear(datalist);
    for (var i = 0; i < models.length; i++) datalist.appendChild(el('option', { value: str(models[i]) }));
  }

  function modelsStatusText(providerId) {
    var info = modelsResults[providerId];
    if (!info) return t('modelsNone');
    if (info.pending === true) return t('fetchingModels');
    if (info.ok === true) return fmt(t('modelsFetched'), { count: fmtNumber(info.count) });
    return fmt(t('modelsFailed'), { code: info.code !== '' ? info.code : '-', message: info.message });
  }

  /** One credential row: label, secret, live verdict, and its own buttons. */
  function keyRow(providerId, key, isNew) {
    var entry = obj(key);
    var keyId = str(entry.id);
    var unsaved = isNew === true || keyId === '';
    newKeySeq += 1;
    var rowKey = unsaved ? ('new-' + String(newKeySeq)) : (providerId + '#' + keyId);
    var set = entry.set === true;
    var saved = str(entry.state);
    var badge = el('span', { class: 'badge ' + stateClass(saved) }, [txt(stateLabel(saved))]);
    if (unsaved) badge = el('span', { class: 'badge' }, [txt(t('keyNew'))]);

    var actions = [];
    if (entry.blacklisted === true) {
      actions.push(el('button', { type: 'button', class: 'btn small', 'data-act': 'restore-key' }, [txt(t('restore'))]));
    }
    actions.push(el('button', {
      type: 'button', class: 'btn small', 'data-act': 'probe-key',
      disabled: unsaved, 'data-probeable': unsaved ? null : '1'
    }, [txt(t('probe'))]));
    actions.push(el('button', { type: 'button', class: 'btn small', 'data-act': 'delete-key' }, [txt(t('deleteKey'))]));

    var row = el('li', {
      class: 'key-row' + (entry.blacklisted === true ? ' blacklisted' : ''),
      'data-role': 'key', 'data-key-id': keyId, 'data-provider': providerId, 'data-rowkey': rowKey
    }, [
      el('div', { class: 'key-main' }, [
        el('input', { type: 'text', 'data-field': 'key-label', value: str(entry.label), placeholder: t('keyLabel'), spellcheck: 'false' }),
        el('input', {
          type: 'password', class: 'mono', 'data-field': 'key', value: '',
          autocomplete: 'new-password', spellcheck: 'false',
          placeholder: set ? t('keySet') : t('keyUnset')
        }),
        badge
      ]),
      el('div', { class: 'key-actions' }, actions),
      el('div', { class: 'key-meta' }, [
        el('span', null, [txt(set ? (t('keyMasked') + ' ' + str(entry.masked)) : t('keyUnset'))]),
        el('span', { class: 'mono' }, [txt(keyId !== '' ? keyId : t('keyNew'))])
      ]),
      el('div', { class: 'probe-out', 'data-role': 'probe-out' })
    ]);

    if (entry.blacklisted === true) {
      var blocked = obj(entry.blacklist);
      var meta = el('div', { class: 'key-meta' }, [
        el('span', { class: 'badge bad' }, [txt(t('blacklisted'))]),
        el('span', null, [txt(reasonLabel(blocked.reason))]),
        el('span', null, [txt(t('recoverIn') + ' ' + recoverText(blocked))])
      ]);
      if (str(blocked.message) !== '') meta.appendChild(el('span', null, [txt(snippet(blocked.message, 160))]));
      row.insertBefore(meta, row.querySelector('[data-role="probe-out"]'));
    }
    return row;
  }

  /** One provider block: its own fields, then its credential list. */
  function providerGroup(provider, isNew) {
    var entry = obj(provider);
    var id = str(entry.id);
    var keys = arr(entry.keys);
    var models = arr(entry.allModels);
    if (models.length === 0) models = arr(entry.models);
    datalistSeq += 1;
    var dlId = 'dl-provider-' + String(datalistSeq);
    var datalist = el('datalist', { id: dlId });
    fillModelOptions(datalist, models);

    var timeoutValue = '';
    if (entry.timeoutMs !== undefined && entry.timeoutMs !== null) timeoutValue = fmtNumber(entry.timeoutMs);

    var keyList = el('ul', { class: 'key-list' });
    if (keys.length === 0) keyList.appendChild(el('li', { class: 'empty' }, [txt(t('noKeys'))]));
    for (var i = 0; i < keys.length; i++) keyList.appendChild(keyRow(id, keys[i], false));

    var keySelect = el('select', { 'data-field': 'models-key' });
    keySelect.appendChild(el('option', { value: '', selected: true }, [txt(t('keyAuto'))]));
    for (var k = 0; k < keys.length; k++) {
      var kid = str(obj(keys[k]).id);
      var klabel = str(obj(keys[k]).label);
      keySelect.appendChild(el('option', { value: kid }, [txt(kid + (klabel !== '' ? ' · ' + klabel : ''))]));
    }

    var anyBlacklisted = false;
    for (var b = 0; b < keys.length; b++) {
      if (obj(keys[b]).blacklisted === true) { anyBlacklisted = true; break; }
    }
    var tools = [];
    tools.push(el('button', { type: 'button', class: 'btn small', 'data-act': 'fetch-models' }, [txt(t('fetchModels'))]));
    if (anyBlacklisted) {
      tools.push(el('button', { type: 'button', class: 'btn small', 'data-act': 'restore-provider' }, [txt(t('restoreAll'))]));
    }
    tools.push(el('button', { type: 'button', class: 'btn small', 'data-act': 'delete-provider' }, [txt(t('deleteRow'))]));

    return el('div', {
      class: 'provider', 'data-role': 'provider', 'data-id': isNew ? '' : id, 'data-new': isNew ? '1' : '0'
    }, [
      el('div', { class: 'provider-head' }, [
        el('div', { class: 'provider-id mono' }, [txt(id !== '' ? id : t('newProvider'))]),
        el('div', { class: 'provider-tools' }, tools)
      ]),
      el('div', { class: 'fields' }, [
        el('div', { class: 'field' }, [
          el('label', null, [txt(t('thId'))]),
          el('input', {
            type: 'text', class: 'mono' + (isNew ? '' : ' ro'), 'data-field': 'id', value: id,
            readonly: !isNew, maxlength: '64', placeholder: 'provider-id', spellcheck: 'false'
          })
        ]),
        el('div', { class: 'field' }, [
          el('label', null, [txt(t('thLabel'))]),
          el('input', { type: 'text', 'data-field': 'label', value: str(entry.label) })
        ]),
        el('div', { class: 'field' }, [
          el('label', null, [txt(t('thBaseURL'))]),
          el('input', { type: 'text', class: 'mono', 'data-field': 'baseURL', value: str(entry.baseURL), spellcheck: 'false' })
        ]),
        el('div', { class: 'field' }, [
          el('label', null, [txt(t('thModels'))]),
          el('input', {
            type: 'text', class: 'mono', 'data-field': 'models', value: arr(entry.models).join(', '),
            list: dlId, spellcheck: 'false', autocomplete: 'off'
          }),
          datalist
        ]),
        el('div', { class: 'field' }, [
          el('label', null, [txt(t('timeoutMs'))]),
          el('input', {
            type: 'number', class: 'mono', 'data-field': 'timeoutMs',
            min: String(TIMEOUT_MIN), max: String(TIMEOUT_MAX), step: '1', value: timeoutValue
          })
        ])
      ]),
      el('div', { class: 'keys' }, [
        el('div', { class: 'keys-head' }, [
          el('h3', null, [txt(t('keysTitle'))]),
          el('div', { class: 'provider-tools' }, [
            el('span', { class: 'badge', 'data-role': 'key-count' }, [txt(String(keys.length))]),
            el('button', { type: 'button', class: 'btn small', 'data-act': 'add-key' }, [txt(t('addKey'))])
          ])
        ]),
        keyList
      ]),
      el('div', { class: 'models-line' }, [
        el('span', { class: 'muted' }, [txt(t('modelsKey'))]),
        keySelect,
        el('span', { class: 'hint', 'data-role': 'models-status' }, [txt(modelsStatusText(id))])
      ]),
      el('span', { class: 'row-error', 'data-role': 'row-error' })
    ]);
  }

  /**
   * The provider block's render signature.
   *
   * Deliberately not the raw state: a blacklist entry's "recoverInMs" shrinks
   * on every poll, and hashing it verbatim would rebuild every provider block —
   * and reset every dropdown — once every four seconds. The countdown is
   * bucketed to the minute instead, so the badge still ticks without churning.
   */
  function providersSigOf(providers) {
    var out = [];
    for (var i = 0; i < providers.length; i++) {
      var provider = obj(providers[i]);
      var keys = arr(provider.keys);
      var keySig = [];
      for (var k = 0; k < keys.length; k++) {
        var entry = obj(keys[k]);
        var blocked = obj(entry.blacklist);
        keySig.push([
          str(entry.id), str(entry.label), str(entry.masked), entry.set === true, str(entry.state),
          entry.blacklisted === true, str(blocked.reason), str(blocked.recoverAt),
          Math.floor(num(blocked.recoverInMs, 0) / 60000)
        ]);
      }
      out.push([
        str(provider.id), str(provider.label), str(provider.baseURL), arr(provider.models),
        arr(provider.discoveredModels), arr(provider.allModels),
        provider.timeoutMs, keySig
      ]);
    }
    return JSON.stringify(out);
  }

  function renderProviders(force) {
    if (!providersBody) return;
    var providers = arr(obj(STATE).providers);
    var sig = providersSigOf(providers);
    if (force !== true && sig === sigs.providers) return;
    // A dirty or focused section holds a draft the server has not seen yet.
    if (force !== true && (dirty.providers || focusInside('sec-providers'))) return;
    sigs.providers = sig;
    datalistSeq = 0;
    var list = el('div', { class: 'providers-body' });
    if (providers.length === 0) {
      list.appendChild(el('div', { class: 'empty', 'data-empty': '1' }, [txt(t('noProviders'))]));
    }
    for (var i = 0; i < providers.length; i++) list.appendChild(providerGroup(providers[i], false));
    clear(providersBody);
    providersBody.appendChild(list);
    paintProbeOutputs();
    paintModelsStatus();
  }

  function fieldValue(scope, name) {
    if (!scope) return '';
    var node = scope.querySelector('[data-field="' + name + '"]');
    return node ? String(node.value === null || node.value === undefined ? '' : node.value) : '';
  }

  function setRowError(scope, message) {
    var node = scope ? scope.querySelector('[data-role="row-error"]') : null;
    if (node) node.textContent = message;
  }

  function splitList(text) {
    var parts = String(text === null || text === undefined ? '' : text).split(',');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var chunks = parts[i].trim().split(' ');
      for (var j = 0; j < chunks.length; j++) {
        var value = chunks[j].trim();
        if (value !== '') out.push(value);
      }
    }
    return out;
  }

  function validBaseURL(value) {
    try {
      var parsed = new window.URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (err) { return false; }
  }

  /**
   * The credential list a provider block is currently showing.
   *
   * A row that never had an id is a new credential and is sent without one, so
   * the service assigns it the next free "kN"; an existing row sends its id
   * back verbatim with a blank secret, which the service reads as "keep the
   * stored one". Deleting the row is the only way to delete the credential.
   */
  function collectKeys(group) {
    var rows = group ? group.querySelectorAll('[data-role="key"]') : [];
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var entry = {
        label: fieldValue(rows[i], 'key-label').trim(),
        key: fieldValue(rows[i], 'key')
      };
      var keyId = str(rows[i].getAttribute('data-key-id')).trim();
      if (keyId !== '') entry.id = keyId;
      out.push(entry);
    }
    return out;
  }

  /**
   * Read the provider section back out of the form.
   *
   * 'emptyModelIds' is an output parameter: a provider may legitimately declare
   * no manual models (the server accepts it, and "拉取模型" can discover them
   * later), so that case is reported to the caller as a warning instead of
   * blocking the save.
   */
  function collectProviders(emptyModelIds) {
    var groups = providersBody ? providersBody.querySelectorAll('[data-role="provider"]') : [];
    var map = {};
    var seen = {};
    var bad = false;
    for (var i = 0; i < groups.length; i++) {
      var group = groups[i];
      var id = fieldValue(group, 'id').trim();
      var label = fieldValue(group, 'label').trim();
      var baseURL = fieldValue(group, 'baseURL').trim();
      var models = splitList(fieldValue(group, 'models'));
      var timeoutText = fieldValue(group, 'timeoutMs').trim();
      var timeoutMs = null;
      var problems = [];
      if (!ID_RE.test(id)) problems.push(t('invalidId'));
      if (!validBaseURL(baseURL)) problems.push(t('invalidBaseURL'));
      if (timeoutText !== '') {
        var timeout = Number(timeoutText);
        if (!Number.isFinite(timeout) || Math.trunc(timeout) !== timeout || timeout < TIMEOUT_MIN || timeout > TIMEOUT_MAX) {
          problems.push(t('invalidTimeout'));
        } else {
          timeoutMs = timeout;
        }
      }
      if (has(seen, id)) problems.push(t('duplicateId'));
      if (problems.length > 0) { setRowError(group, problems.join(' · ')); bad = true; continue; }
      setRowError(group, '');
      seen[id] = true;
      if (models.length === 0) emptyModelIds.push(id === '' ? t('newProvider') : id);
      var patch = {
        // A blank label is the server's documented default, not an empty name.
        label: label === '' ? id : label,
        baseURL: baseURL,
        models: models,
        keys: collectKeys(group)
      };
      // Absent timeoutMs means "keep the stored one", so a blank box is not a
      // reset to the default.
      if (timeoutMs !== null) patch.timeoutMs = timeoutMs;
      map[id] = patch;
    }
    return bad ? null : map;
  }

  function saveProviders(button) {
    var emptyModelIds = [];
    var map = collectProviders(emptyModelIds);
    if (map === null) { toast(t('fixErrors'), 'error'); return; }
    if (emptyModelIds.length > 0) {
      // Not an error: an empty manual list means "use what /models returns".
      toast(fmt(t('modelsEmptyWarn'), { ids: emptyModelIds.join(', ') }), 'warn');
    }
    return runButton(button, function () {
      return postConfig('sec-providers', { providers: map }, function (next) {
        dirty.providers = false;
        sigs.providers = '';
        // The route table was reconciled server-side against the new provider
        // set, so it is rebuilt unconditionally: the operator asked for this.
        applyState(next, { providers: true, routing: true });
        showRemovedNotice(arr(obj(next).removedOrderRows));
      });
    });
  }

  function addProviderRow() {
    if (!providersBody) return;
    var list = providersBody.querySelector('.providers-body');
    if (!list) { renderProviders(true); list = providersBody.querySelector('.providers-body'); }
    if (!list) return;
    var empty = list.querySelector('[data-empty]');
    if (empty && empty.parentNode) empty.parentNode.removeChild(empty);
    var group = providerGroup({ id: '', label: '', baseURL: 'https://', keys: [], models: [], allModels: [] }, true);
    list.appendChild(group);
    dirty.providers = true;
    var input = group.querySelector('input[data-field="id"]');
    if (input) input.focus();
  }

  function deleteProvider(button) {
    var group = closestAct(button, '[data-role="provider"]');
    if (!group) return;
    if (window.confirm && !window.confirm(t('confirmDeleteProvider'))) return;
    if (group.parentNode) group.parentNode.removeChild(group);
    dirty.providers = true;
  }

  function addKeyRow(button) {
    var group = closestAct(button, '[data-role="provider"]');
    if (!group) return;
    var list = group.querySelector('.key-list');
    if (!list) return;
    if (group.querySelectorAll('[data-role="key"]').length >= MAX_KEYS) {
      toast(t('keyLimitReached'), 'error');
      return;
    }
    var empty = list.querySelector('.empty');
    if (empty && empty.parentNode) empty.parentNode.removeChild(empty);
    var row = keyRow(str(group.getAttribute('data-id')), { id: '', label: '', masked: '', set: false, state: '', blacklisted: false }, true);
    list.appendChild(row);
    dirty.providers = true;
    updateKeyCount(group);
    var input = row.querySelector('input[data-field="key-label"]');
    if (input) input.focus();
  }

  function deleteKeyRow(button) {
    var row = closestAct(button, '[data-role="key"]');
    if (!row) return;
    if (window.confirm && !window.confirm(t('confirmDeleteKey'))) return;
    var group = closestAct(row, '[data-role="provider"]');
    if (row.parentNode) row.parentNode.removeChild(row);
    dirty.providers = true;
    if (group) updateKeyCount(group);
  }

  function updateKeyCount(group) {
    if (!group) return;
    var badge = group.querySelector('[data-role="key-count"]');
    var list = group.querySelector('.key-list');
    if (badge && list) badge.textContent = String(list.querySelectorAll('[data-role="key"]').length);
  }

  // ---- credential probes ---------------------------------------------------

  /** Fill every probe output from the results the page is holding. */
  function paintProbeOutputs() {
    if (!providersBody) return;
    var rows = providersBody.querySelectorAll('[data-role="key"]');
    for (var i = 0; i < rows.length; i++) {
      var rowKey = str(rows[i].getAttribute('data-rowkey'));
      var out = rows[i].querySelector('[data-role="probe-out"]');
      var button = rows[i].querySelector('button[data-act="probe-key"]');
      var info = probeResults[rowKey];
      if (out) {
        out.className = 'probe-out';
        out.textContent = '';
        if (info && info.pending === true) {
          out.textContent = t('probing');
        } else if (info && info.error) {
          out.className = 'probe-out bad';
          out.textContent = info.error;
        } else if (info && info.probe) {
          out.className = 'probe-out ' + (info.probe.ok === true ? 'ok' : 'bad');
          out.textContent = probeBits(info.probe);
        }
      }
      if (button && button.getAttribute('data-probeable') === '1') {
        var pending = !!(info && info.pending === true);
        button.disabled = pending;
        button.textContent = pending ? t('probing') : t('probe');
      }
    }
  }

  function probeBits(probe) {
    var entry = obj(probe);
    var bits = [entry.ok === true ? t('probeOk') : t('probeFail'), str(entry.code) || '-', fmtNumber(entry.ms) + 'ms'];
    if (entry.reasoningChars !== undefined && entry.reasoningChars !== null) {
      bits.push(fmtNumber(entry.reasoningChars) + ' ' + t('reasoningChars'));
    }
    if (str(entry.message) !== '') bits.push(snippet(entry.message, 120));
    if (str(entry.text) !== '') bits.push(snippet(entry.text, 60));
    return bits.join(' · ');
  }

  function probeKey(button) {
    var row = closestAct(button, '[data-role="key"]');
    if (!row) return;
    var provider = str(row.getAttribute('data-provider'));
    var keyId = str(row.getAttribute('data-key-id'));
    var rowKey = str(row.getAttribute('data-rowkey'));
    if (provider === '' || keyId === '') return;
    probeResults[rowKey] = { pending: true };
    paintProbeOutputs();
    return runButton(button, function () {
      return api('probe', { provider: provider, keyId: keyId }).then(function (value) {
        var payload = obj(value);
        probeResults[rowKey] = { pending: false, probe: obj(payload.probe) };
        if (payload.state) applyState(payload.state, false);
        paintProbeOutputs();
      }, function (err) {
        probeResults[rowKey] = { pending: false, error: err && err.message ? err.message : String(err) };
        paintProbeOutputs();
      });
    });
  }

  function paintModelsStatus() {
    if (!providersBody) return;
    var groups = providersBody.querySelectorAll('[data-role="provider"]');
    for (var i = 0; i < groups.length; i++) {
      var id = str(groups[i].getAttribute('data-id'));
      var node = groups[i].querySelector('[data-role="models-status"]');
      if (node && id !== '') node.textContent = modelsStatusText(id);
    }
  }

  /**
   * Ask the upstream which models it serves, through one chosen credential.
   *
   * The answer comes back inside the refreshed state ("discoveredModels"), so
   * the model datalists pick it up through the normal render; the outcome text
   * is kept per provider instead of in the DOM because that render replaces the
   * block it was typed into.
   */
  function fetchModels(button) {
    var group = closestAct(button, '[data-role="provider"]');
    if (!group) return;
    var providerId = str(group.getAttribute('data-id'));
    if (providerId === '') { toast(t('fixErrors'), 'error'); return; }
    var select = group.querySelector('select[data-field="models-key"]');
    var keyId = select ? String(select.value || '') : '';
    var body = { provider: providerId };
    if (keyId !== '') body.keyId = keyId;
    modelsResults[providerId] = { pending: true, ok: false, code: '', message: '', count: 0 };
    paintModelsStatus();
    return runButton(button, function () {
      return api('models', body).then(function (value) {
        var payload = obj(value);
        var outcome = obj(payload.fetch);
        modelsResults[providerId] = {
          ok: outcome.ok === true,
          code: str(outcome.code),
          message: str(outcome.message),
          count: arr(outcome.models).length
        };
        sigs.providers = '';
        if (payload.state) applyState(payload.state, false); else renderProviders(false);
        paintModelsStatus();
        if (outcome.ok === true) {
          toast(fmt(t('modelsFetched'), { count: fmtNumber(arr(outcome.models).length) }), 'ok');
        } else {
          toast(fmt(t('modelsFailed'), { code: str(outcome.code) || '-', message: str(outcome.message) }), 'error');
        }
      }, function (err) {
        modelsResults[providerId] = { ok: false, code: '', message: err && err.message ? err.message : String(err), count: 0 };
        paintModelsStatus();
        throw err;
      });
    });
  }

  // ---- blacklist -----------------------------------------------------------

  function restoreKey(button) {
    var row = closestAct(button, '[data-provider]');
    if (!row) return;
    var provider = str(row.getAttribute('data-provider'));
    var keyId = str(row.getAttribute('data-key-id'));
    if (provider === '') return;
    var body = keyId === '' ? { provider: provider } : { provider: provider, keyId: keyId };
    return runButton(button, function () {
      return api('keys/restore', body).then(function (value) {
        var payload = obj(value);
        probeResults = {};
        sigs.providers = '';
        if (payload.state) applyState(payload.state, false);
        toast(fmt(t('restored'), { count: fmtNumber(payload.removed) }), 'ok');
      });
    });
  }

  function restoreProvider(button) {
    var group = closestAct(button, '[data-role="provider"]');
    if (!group) return;
    var provider = str(group.getAttribute('data-id'));
    if (provider === '') return;
    return runButton(button, function () {
      return api('keys/restore', { provider: provider }).then(function (value) {
        var payload = obj(value);
        probeResults = {};
        sigs.providers = '';
        if (payload.state) applyState(payload.state, false);
        toast(fmt(t('restored'), { count: fmtNumber(payload.removed) }), 'ok');
      });
    });
  }

  function renderBlacklist() {
    if (!blacklistBody) return;
    var entries = arr(obj(STATE).blacklist);
    var keys = keyList(entries, function (entry) { return str(obj(entry).unit); });
    syncKeyed(blacklistBody, keys, makeBlacklistRow, updateBlacklistRow);
    markEmptyRow(blacklistBody, entries.length === 0, t('blacklistEmpty'), 6);
  }

  function makeBlacklistRow() {
    var refs = {};
    refs.unit = el('td', { class: 'mono' });
    refs.reason = el('td');
    refs.message = el('td');
    refs.since = el('td', { class: 'mono' });
    refs.recover = el('td', { class: 'mono' });
    refs.action = el('td', { class: 'nowrap' }, [
      el('button', { type: 'button', class: 'btn small', 'data-act': 'restore-key' }, [txt(t('restore'))])
    ]);
    var row = el('tr', null, [refs.unit, refs.reason, refs.message, refs.since, refs.recover, refs.action]);
    blacklistRefs.set(row, refs);
    return row;
  }

  function updateBlacklistRow(node, key, index) {
    var refs = blacklistRefs.get(node);
    var entry = obj(arr(obj(STATE).blacklist)[index]);
    if (!refs) return;
    refs.unit.textContent = str(entry.unit) || '-';
    refs.reason.textContent = reasonLabel(entry.reason);
    refs.message.textContent = str(entry.message) !== '' ? snippet(entry.message, 200) : '-';
    refs.since.textContent = fmtDateTime(entry.at);
    refs.recover.textContent = recoverText(entry);
    node.setAttribute('data-provider', str(entry.provider));
    node.setAttribute('data-key-id', str(entry.keyId));
  }

  // ---- routing -------------------------------------------------------------

  /** Name / inclusive bounds / display unit for every router setting the page edits. */
  function fieldSpecs(limits) {
    return [
      { name: 'retries', min: 0, max: num(limits.maxRetries, 20) },
      { name: 'failureThreshold', min: 1, max: num(limits.failureThreshold, 100) },
      { name: 'failureRateThreshold', min: num(limits.minFailureRate, 0), max: num(limits.maxFailureRate, 1), percent: true },
      { name: 'minSamples', min: num(limits.minSamples, 1), max: num(limits.maxSamples, 100) },
      { name: 'windowSize', min: num(limits.minWindowSize, 1), max: num(limits.maxWindowSize, 100) },
      { name: 'windowMs', min: num(limits.minWindowMs, 0), max: num(limits.maxWindowMs, 3600000) },
      { name: 'cooldownMs', min: num(limits.minCooldownMs, 0), max: num(limits.maxCooldownMs, 3600000) },
      { name: 'cooldownFactor', min: num(limits.minCooldownFactor, 1), max: num(limits.maxCooldownFactor, 10) },
      { name: 'cooldownMaxMs', min: num(limits.minCooldownMs, 0), max: num(limits.maxCooldownMs, 3600000) },
      { name: 'halfOpenSuccesses', min: num(limits.minHalfOpenSuccesses, 1), max: num(limits.maxHalfOpenSuccesses, 10) },
      { name: 'maxSwitches', min: num(limits.minSwitches, 0), max: num(limits.maxSwitches, 20) }
    ];
  }

  function fieldSpecRow(spec, value) {
    var percent = spec.percent === true;
    var min = percent ? num(spec.min, 0) * 100 : spec.min;
    var max = percent ? num(spec.max, 1) * 100 : spec.max;
    var bounds = String(min) + ' – ' + String(max) + (percent ? '%' : '');
    return el('div', { class: 'field' }, [
      el('label', { for: 'f-' + spec.name }, [
        el('span', null, [txt(t(spec.name))]),
        el('span', { class: 'bounds mono' }, [txt(bounds)])
      ]),
      el('input', {
        type: 'number', class: 'mono', id: 'f-' + spec.name, 'data-field': spec.name,
        min: String(min), max: String(max), step: percent ? 'any' : '1',
        value: percent ? fmtPercentInput(value) : String(value)
      }),
      el('span', { class: 'field-error', 'data-err': spec.name })
    ]);
  }

  function selectField(name, labelKey, values, current, labelKeys) {
    var select = el('select', { 'data-field': name, id: 'f-' + name });
    var seen = false;
    for (var i = 0; i < values.length; i++) {
      var value = String(values[i]);
      var text = labelKeys && has(labelKeys, value) ? t(labelKeys[value]) : value;
      if (value === String(current)) seen = true;
      select.appendChild(el('option', { value: value, selected: value === String(current) }, [txt(text)]));
    }
    // Defensive: an older page meeting a newer enum still shows the stored value.
    if (!seen && current !== undefined && current !== null) {
      select.appendChild(el('option', { value: String(current), selected: true }, [txt(String(current))]));
    }
    return el('div', { class: 'field' }, [
      el('label', { for: 'f-' + name }, [txt(t(labelKey))]),
      select,
      el('span', { class: 'field-error', 'data-err': name })
    ]);
  }

  function routeRow(row, providerIds) {
    var entry = obj(row);
    var provider = str(entry.provider);
    var known = providerIds.indexOf(provider) >= 0;
    var select = el('select', { 'data-field': 'provider' });
    for (var i = 0; i < providerIds.length; i++) {
      select.appendChild(el('option', { value: providerIds[i], selected: providerIds[i] === provider }, [txt(providerIds[i])]));
    }
    if (provider === '') select.appendChild(el('option', { value: '', selected: true }, [txt('')]));
    if (provider !== '' && !known) {
      select.appendChild(el('option', { value: provider, selected: true }, [txt(provider + ' (' + t('notRegistered') + ')')]));
    }
    datalistSeq += 1;
    var listId = 'dl-route-' + String(datalistSeq);
    var datalist = el('datalist', { id: listId });
    fillModelOptions(datalist, providerModels(provider));
    var cells = [
      el('td', { class: 'nowrap' }, [
        select,
        el('span', { class: 'badge bad', 'data-role': 'provider-badge', hidden: known || provider === '' }, [txt(t('notRegistered'))])
      ]),
      el('td', null, [
        el('input', {
          type: 'text', class: 'mono', 'data-field': 'model', value: str(entry.model),
          list: listId, spellcheck: 'false', autocomplete: 'off'
        }),
        datalist
      ]),
      el('td', null, [el('input', { type: 'text', 'data-field': 'label', value: str(entry.label) })]),
      el('td', { class: 'nowrap' }, [
        el('button', { type: 'button', class: 'btn small', 'data-act': 'up' }, [txt(t('moveUp'))]),
        txt(' '),
        el('button', { type: 'button', class: 'btn small', 'data-act': 'down' }, [txt(t('moveDown'))]),
        txt(' '),
        el('button', { type: 'button', class: 'btn small', 'data-act': 'del-route' }, [txt(t('deleteRow'))]),
        el('span', { class: 'row-error', 'data-role': 'row-error', style: 'white-space:normal; max-width:220px' })
      ])
    ];
    var tr = el('tr', null, cells);
    // The server understands an optional reasoningEffort on a route row. The
    // page has no field for it, so it rides along in a data attribute rather
    // than being silently dropped by a save that never knew about it.
    if (str(entry.reasoningEffort) !== '') tr.setAttribute('data-reasoning-effort', str(entry.reasoningEffort));
    return tr;
  }

  /**
   * Point one row's model datalist at the provider it now names.
   *
   * Called on the row's own change event instead of rebuilding the table: the
   * operator is allowed to have three other rows half-filled, and a whole-table
   * rebuild would take their values with it.
   */
  function syncRouteDatalist(tr) {
    if (!tr) return;
    var select = tr.querySelector('select[data-field="provider"]');
    if (!select) return;
    var provider = String(select.value === null || select.value === undefined ? '' : select.value);
    var datalist = tr.querySelector('datalist');
    if (datalist) fillModelOptions(datalist, providerModels(provider));
    var badge = tr.querySelector('[data-role="provider-badge"]');
    if (badge) badge.hidden = provider === '' || providerIdList().indexOf(provider) >= 0;
  }

  /**
   * One editable time-slot rule row: start/end clocks plus a priority number per
   * provider (blank = this provider is not in this slot; 1–9 = more preferred,
   * 0 = disabled during this slot).
   *
   * A provider the rule names but that is not registered any more still gets a
   * cell, badged the same way the order table badges one: dropping it silently
   * would rewrite the operator's table behind their back, and a save that cannot
   * mention it could never round-trip the file.
   * @param {object} rule - the stored start/end/priority rule.
   * @param {Array<string>} providerIds - the registered provider ids.
   * @returns {HTMLElement} the tr element.
   */
  function slotRow(rule, providerIds) {
    var entry = obj(rule);
    var priority = obj(entry.priority);
    var names = providerIds.slice();
    for (var key in priority) {
      if (Object.prototype.hasOwnProperty.call(priority, key) && names.indexOf(key) < 0) names.push(key);
    }
    var startCell = el('input', { type: 'text', class: 'mono', 'data-field': 'slot-start', value: str(entry.start), placeholder: '00:00', spellcheck: 'false', autocomplete: 'off' });
    var endCell = el('input', { type: 'text', class: 'mono', 'data-field': 'slot-end', value: str(entry.end), placeholder: '23:59', spellcheck: 'false', autocomplete: 'off' });
    var priorityCells = [];
    for (var i = 0; i < names.length; i++) {
      var id = names[i];
      var value = priority[id];
      var shown = (typeof value === 'number') ? String(value) : '';
      var known = providerIds.indexOf(id) >= 0;
      priorityCells.push(el('label', { class: 'slot-pri' }, [
        txt(id + ' '),
        el('input', { type: 'text', class: 'mono slot-pri-input', 'data-field': 'slot-priority', 'data-provider': id, value: shown, placeholder: '', size: 2, spellcheck: 'false', autocomplete: 'off' }),
        el('span', { class: 'badge bad', hidden: known }, [txt(t('notRegistered'))])
      ]));
    }
    var cells = [
      el('td', { class: 'nowrap' }, [startCell]),
      el('td', { class: 'nowrap' }, [endCell]),
      el('td', null, priorityCells),
      el('td', { class: 'nowrap' }, [
        el('button', { type: 'button', class: 'btn small', 'data-act': 'del-slot' }, [txt(t('slotDelete'))]),
        el('span', { class: 'row-error', 'data-role': 'slot-error', style: 'white-space:normal; max-width:220px' })
      ])
    ];
    return el('tr', null, cells);
  }

  function providersSig() {
    var providers = arr(obj(STATE).providers);
    var out = [];
    for (var i = 0; i < providers.length; i++) {
      out.push([str(obj(providers[i]).id), arr(obj(providers[i]).allModels), arr(obj(providers[i]).models)]);
    }
    return out;
  }

  function renderRouting(force) {
    if (!routingBody) return;
    var state = obj(STATE);
    var router = obj(state.router);
    var limits = obj(state.limits);
    var providerIds = providerIdList();
    var sig = JSON.stringify([router, limits, arr(state.recoveryModes), arr(state.logLevels), providersSig()]);
    if (force !== true && sig === sigs.routing) return;
    if (force !== true && (dirty.routing || focusInside('sec-routing'))) return;
    sigs.routing = sig;

    var body = el('div');
    var orderBody = el('tbody', { 'data-role': 'order-body' });
    var order = arr(router.order);
    for (var i = 0; i < order.length; i++) orderBody.appendChild(routeRow(order[i], providerIds));
    body.appendChild(el('div', { class: 'table-wrap' }, [
      el('table', { class: 'grid' }, [
        el('thead', null, [el('tr', null, [
          el('th', null, [txt(t('thProvider'))]),
          el('th', null, [txt(t('thModel'))]),
          el('th', null, [txt(t('thRouteLabel'))]),
          el('th', null, [txt(t('thActions'))])
        ])]),
        orderBody
      ])
    ]));
    body.appendChild(el('div', { class: 'tools', style: 'margin-top:8px' }, [
      el('button', { type: 'button', class: 'btn', 'data-act': 'add-route' }, [txt(t('addRoute'))]),
      el('button', { type: 'button', class: 'btn', 'data-act': 'remove-unregistered' }, [txt(t('removeUnregistered'))])
    ]));

    // Time-slot priority table. Rendered between the order table and the
    // breaker knobs so an operator reads it as "what change, when" right where
    // the routing order lives. The rows carry data-fields the save handler
    // collects into router.timeSlots, and a blank table means "no slots" —
    // which the server stores as [] and treats exactly like the default.
    var slotsBody = el('tbody', { 'data-role': 'slots-body' });
    var slots = arr(router.timeSlots);
    for (var si = 0; si < slots.length; si++) slotsBody.appendChild(slotRow(slots[si], providerIds));
    body.appendChild(el('div', { class: 'table-wrap', style: 'margin-top:12px' }, [
      el('div', { class: 'keys-head' }, [el('h3', null, [txt(t('slotsTitle'))])]),
      el('p', { class: 'hint', style: 'margin:4px 0 8px' }, [txt(t('slotsHint'))]),
      el('table', { class: 'grid' }, [
        el('thead', null, [el('tr', null, [
          el('th', null, [txt(t('thSlotStart'))]),
          el('th', null, [txt(t('thSlotEnd'))]),
          el('th', null, [txt(t('thSlotPriority'))]),
          el('th', null, [txt(t('thActions'))])
        ])]),
        slotsBody
      ])
    ]));
    body.appendChild(el('div', { class: 'tools', style: 'margin-top:8px' }, [
      el('button', { type: 'button', class: 'btn', 'data-act': 'add-slot' }, [txt(t('addSlot'))])
    ]));

    var fields = el('div', { class: 'fields' });
    var specs = fieldSpecs(limits);
    for (var s = 0; s < specs.length; s++) {
      fields.appendChild(fieldSpecRow(specs[s], num(router[specs[s].name], specs[s].min)));
    }
    var modes = arr(state.recoveryModes);
    if (modes.length === 0) modes = ['probe', 'immediate'];
    fields.appendChild(selectField('recoveryMode', 'recoveryMode', modes, str(router.recoveryMode) || 'probe', { probe: 'modeProbe', immediate: 'modeImmediate' }));
    var levels = arr(state.logLevels);
    if (levels.length === 0) levels = ['silent', 'error', 'warn', 'info', 'debug'];
    fields.appendChild(selectField('logLevel', 'logLevel', levels, str(router.logLevel) || 'info', null));
    fields.appendChild(el('div', { class: 'field' }, [
      el('label', { for: 'f-enabled' }, [txt(t('enabled'))]),
      el('input', { type: 'checkbox', id: 'f-enabled', 'data-field': 'enabled', checked: router.enabled === true }),
      el('span', { class: 'field-error', 'data-err': 'enabled' })
    ]));
    fields.appendChild(el('div', { class: 'field' }, [
      el('label', { for: 'f-budget' }, [txt(t('budget'))]),
      el('output', { class: 'mono', id: 'f-budget', style: 'padding:4px 6px' }, [txt(fmtNumber(router.budget))])
    ]));
    body.appendChild(fields);

    body.appendChild(el('div', { class: 'tools' }, [
      el('button', { type: 'button', class: 'btn primary', 'data-act': 'save-routing' }, [txt(t('saveRouting'))])
    ]));

    clear(routingBody);
    routingBody.appendChild(body);
  }

  function clearErrors(rootId) {
    var root = document.getElementById(rootId);
    if (!root) return;
    var nodes = root.querySelectorAll('[data-err]');
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = '';
  }

  function setFieldError(name, message) {
    var node = document.querySelector('[data-err="' + name + '"]');
    if (node) node.textContent = message;
  }

  /** Park a server-side rejection beside the section whose save produced it. */
  function sectionError(rootId, message) {
    var root = document.getElementById(rootId);
    var slot = root ? root.querySelector('[data-role="section-error"]') : null;
    if (slot) slot.textContent = message;
  }

  /**
   * Report the route rows the service dropped while reconciling.
   *
   * The rows are remembered so a language switch can re-label the notice; only
   * a fresh save raises the toast, because a label change is not news.
   */
  function showRemovedNotice(rows, quiet) {
    lastRemovedRows = rows;
    var root = document.getElementById('sec-providers');
    var node = root ? root.querySelector('[data-role="removed-notice"]') : null;
    if (!node) return;
    if (rows.length === 0) {
      node.hidden = true;
      node.textContent = '';
      return;
    }
    var parts = [];
    for (var i = 0; i < rows.length && i < 5; i++) {
      var entry = obj(rows[i]);
      parts.push(str(entry.provider) + '/' + str(entry.model) + ' (' + removedReason(str(entry.reason)) + ')');
    }
    if (rows.length > 5) parts.push('+' + String(rows.length - 5));
    var text = fmt(t('removedOrderRows'), { count: fmtNumber(rows.length), rows: parts.join('; ') });
    node.hidden = false;
    node.textContent = text;
    if (quiet !== true) toast(text, 'warn');
  }

  function removedReason(reason) {
    if (reason === 'provider_not_configured') return t('reasonProviderNotConfigured');
    if (reason === 'model_not_available') return t('reasonModelNotAvailable');
    return str(reason);
  }

  /**
   * One config POST: clear this section's error, apply the returned state, and
   * put a rejection's error.message back beside the same section before
   * letting it reach the toast (so the message is visible where the fix goes).
   */
  function postConfig(sectionId, patch, onDone) {
    sectionError(sectionId, '');
    return api('config', patch).then(function (next) {
      onDone(next);
      toast(t('saved'), 'ok');
    }, function (err) {
      sectionError(sectionId, err && err.message ? err.message : String(err));
      throw err;
    });
  }

  /**
   * Collect the time-slot table from the editor.
   *
   * Client-side validation mirrors the service's own (HH:mm, start !== end,
   * priority 0-9) so the operator sees the problem beside the row instead of
   * only as a server rejection; the service re-validates regardless, because a
   * page is not a trust boundary.
   * @param {Array<string>} providerIds - known provider ids, in table order.
   * @returns {Array<object>|null} the rules, or null when a row is invalid.
   */
  function collectTimeSlots(providerIds) {
    var body = routingBody ? routingBody.querySelector('tbody[data-role="slots-body"]') : null;
    var rows = body ? body.querySelectorAll('tr') : [];
    var rules = [];
    var bad = false;
    var clock = /^([01]?[0-9]|2[0-3]):([0-5][0-9])$/;
    for (var i = 0; i < rows.length; i++) {
      var tr = rows[i];
      var start = fieldValue(tr, 'slot-start').trim();
      var end = fieldValue(tr, 'slot-end').trim();
      var errNode = tr.querySelector('[data-role="slot-error"]');
      var priorityInputs = tr.querySelectorAll('input[data-field="slot-priority"]');
      var priority = {};
      var rowBad = '';
      if (start === '' && end === '') {
        // A row the operator added and then left alone is noise, not an error.
        if (errNode) errNode.textContent = '';
        continue;
      }
      if (!clock.test(start) || !clock.test(end)) rowBad = t('slotBadClock');
      else if (start === end) rowBad = t('slotRowIncomplete');
      if (rowBad === '') {
        for (var p = 0; p < priorityInputs.length; p++) {
          var input = priorityInputs[p];
          var raw = String(input.value === null || input.value === undefined ? '' : input.value).trim();
          if (raw === '') continue;
          var value = Number(raw);
          if (!/^[0-9]+$/.test(raw) || !Number.isFinite(value) || value < 0 || value > 9) {
            rowBad = t('slotPriorityOutOfRange');
            break;
          }
          priority[String(input.getAttribute('data-provider'))] = value;
        }
      }
      if (rowBad !== '') {
        if (errNode) errNode.textContent = rowBad;
        bad = true;
        continue;
      }
      if (errNode) errNode.textContent = '';
      // An all-blank priority map would be rejected by the service ("must name
      // at least one provider"); say so here rather than sending a save that
      // cannot succeed.
      if (Object.keys(priority).length === 0) {
        if (errNode) errNode.textContent = t('slotNoProvider');
        bad = true;
        continue;
      }
      rules.push({ start: start, end: end, priority: priority });
    }
    if (bad) return null;
    return rules;
  }

  function collectRouting(orderOnly) {
    clearErrors('sec-routing');
    var state = obj(STATE);
    var limits = obj(state.limits);
    var body = routingBody ? routingBody.querySelector('tbody[data-role="order-body"]') : null;
    var rows = body ? body.querySelectorAll('tr') : [];
    var order = [];
    var bad = false;
    for (var i = 0; i < rows.length; i++) {
      var provider = fieldValue(rows[i], 'provider').trim();
      var model = fieldValue(rows[i], 'model').trim();
      var label = fieldValue(rows[i], 'label').trim();
      if (provider === '' && model === '') continue; // a fully blank row is just noise
      if (provider === '' || model === '') { setRowError(rows[i], t('rowIncomplete')); bad = true; continue; }
      setRowError(rows[i], '');
      var row = { provider: provider, model: model };
      if (label !== '') row.label = label;
      var effort = rows[i].getAttribute('data-reasoning-effort');
      if (effort) row.reasoningEffort = effort;
      order.push(row);
    }
    if (bad) return null;
    if (orderOnly === true) return { order: order };

    var router = { enabled: isRoutingEnabled(), order: order };
    var specs = fieldSpecs(limits);
    for (var s = 0; s < specs.length; s++) {
      var spec = specs[s];
      var raw = fieldValue(routingBody, spec.name).trim();
      var value = Number(raw);
      if (spec.percent === true) {
        // The wire format is a 0–1 ratio; the box is a percentage, because that
        // is the only spelling of "70%" an operator reads fluently.
        var pMin = num(spec.min, 0) * 100;
        var pMax = num(spec.max, 1) * 100;
        if (raw === '' || !Number.isFinite(value) || value < pMin || value > pMax) {
          setFieldError(spec.name, t('invalidPercent'));
          bad = true;
          continue;
        }
        router[spec.name] = value / 100;
        continue;
      }
      if (raw === '' || !Number.isFinite(value) || Math.trunc(value) !== value || value < spec.min || value > spec.max) {
        setFieldError(spec.name, t('invalidNumber'));
        bad = true;
        continue;
      }
      router[spec.name] = value;
    }
    if (bad) return null;
    var modeNode = routingBody.querySelector('select[data-field="recoveryMode"]');
    var levelNode = routingBody.querySelector('select[data-field="logLevel"]');
    if (modeNode) router.recoveryMode = String(modeNode.value);
    if (levelNode) router.logLevel = String(levelNode.value);
    var slots = collectTimeSlots(providerIdList());
    if (slots === null) return null;
    router.timeSlots = slots;
    return router;
  }

  function isRoutingEnabled() {
    var node = routingBody ? routingBody.querySelector('input[data-field="enabled"]') : null;
    return !!(node && node.checked);
  }

  function saveRouting(button, orderOnly) {
    var payload = collectRouting(orderOnly === true);
    if (payload === null) { toast(t('fixErrors'), 'error'); return; }
    return runButton(button, function () {
      return postConfig('sec-routing', { router: payload }, function (next) {
        dirty.routing = false;
        sigs.routing = '';
        sigs.providers = '';
        applyState(next, { routing: true });
      });
    });
  }

  function deleteRouteRow(button) {
    var tr = closestAct(button, 'tr');
    if (tr && tr.parentNode) { tr.parentNode.removeChild(tr); dirty.routing = true; }
  }

  function addRouteRow(button) {
    var body = routingBody ? routingBody.querySelector('tbody[data-role="order-body"]') : null;
    if (!body) return;
    // The service refuses a table longer than its own limit, so the button
    // stops at the same number rather than letting a save discover it.
    var maxRows = num(obj(obj(STATE).limits).orderRows, 12);
    if (body.querySelectorAll('tr').length >= maxRows) {
      toast(fmt(t('routeLimitReached'), { count: String(maxRows) }), 'error');
      return;
    }
    var tr = routeRow({ provider: '', model: '', label: '' }, providerIdList());
    body.appendChild(tr);
    dirty.routing = true;
    var select = tr.querySelector('select[data-field="provider"]');
    if (select && select.focus) select.focus();
  }

  function removeUnregistered(button) {
    var providerIds = providerIdList();
    var body = routingBody ? routingBody.querySelector('tbody[data-role="order-body"]') : null;
    var rows = body ? body.querySelectorAll('tr') : [];
    var removed = 0;
    for (var i = 0; i < rows.length; i++) {
      var value = fieldValue(rows[i], 'provider').trim();
      if (value !== '' && providerIds.indexOf(value) < 0) {
        if (rows[i].parentNode) rows[i].parentNode.removeChild(rows[i]);
        removed += 1;
      }
    }
    if (removed === 0) { toast(t('noUnregistered'), 'ok'); return; }
    dirty.routing = true;
    // Persist immediately: the order alone is a valid partial patch, so the
    // button is genuinely one click rather than "edit then remember to save".
    var payload = collectRouting(true);
    if (payload === null) { toast(t('fixErrors'), 'error'); return; }
    return runButton(button, function () {
      return postConfig('sec-routing', { router: payload }, function (next) {
        dirty.routing = false;
        sigs.routing = '';
        sigs.providers = '';
        applyState(next, { routing: true });
      });
    });
  }

  /** Append a blank time-slot rule, capped at the service's own limit. */
  function addSlotRow(button) {
    var body = routingBody ? routingBody.querySelector('tbody[data-role="slots-body"]') : null;
    if (!body) return;
    var maxSlots = num(obj(obj(STATE).limits).timeSlots, 24);
    if (body.querySelectorAll('tr').length >= maxSlots) {
      toast(fmt(t('slotLimitReached'), { count: String(maxSlots) }), 'error');
      return;
    }
    var tr = slotRow({ start: '', end: '', priority: {} }, providerIdList());
    body.appendChild(tr);
    dirty.routing = true;
    var input = tr.querySelector('input[data-field="slot-start"]');
    if (input && input.focus) input.focus();
  }

  function deleteSlotRow(button) {
    var tr = closestAct(button, 'tr');
    if (tr && tr.parentNode) { tr.parentNode.removeChild(tr); dirty.routing = true; }
  }

  function moveRouteRow(button, act) {
    var tr = closestAct(button, 'tr');
    if (!tr || !tr.parentNode) return;
    var body = tr.parentNode;
    if (act === 'up') {
      var previous = tr.previousElementSibling;
      if (previous) { body.insertBefore(tr, previous); dirty.routing = true; }
    } else {
      var next = tr.nextElementSibling;
      if (next) { body.insertBefore(next, tr); dirty.routing = true; }
    }
  }

  // ---- live breakers -------------------------------------------------------

  /** Reconciliation: reuse keyed rows, update in place, drop the leftovers. */
  function syncKeyed(container, keys, make, update) {
    var existing = {};
    var child = container.firstChild;
    while (child) {
      var next = child.nextSibling;
      if (child.nodeType === 1 && child.getAttribute && child.getAttribute('data-key') !== null) {
        existing[child.getAttribute('data-key')] = child;
      }
      child = next;
    }
    var previous = null;
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var node = existing[key];
      if (node) delete existing[key];
      else { node = make(key, i); node.setAttribute('data-key', key); }
      update(node, key, i);
      var target = previous ? previous.nextSibling : container.firstChild;
      if (node !== target) container.insertBefore(node, target);
      previous = node;
    }
    for (var stale in existing) {
      if (has(existing, stale)) container.removeChild(existing[stale]);
    }
  }

  /** Stable key per item; a repeated identity gets an index suffix. */
  function keyList(items, keyOf) {
    var seen = {};
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var base = String(keyOf(items[i], i));
      var key = base;
      if (has(seen, base)) key = base + '#' + i;
      seen[key] = true;
      out.push(key);
    }
    return out;
  }

  /** One live row is one route crossed with one credential. */
  function liveKey(row) {
    var entry = obj(row);
    var provider = str(entry.provider);
    var model = str(entry.model);
    if (provider === '' && model === '') return 'row';
    return provider + '|' + model + '|' + str(entry.keyId);
  }

  function makeLiveRow() {
    var refs = {};
    refs.state = el('span', { class: 'badge' });
    refs.unit = el('td', { class: 'mono' });
    refs.route = el('td', { class: 'mono' });
    refs.failures = el('td');
    refs.rate = el('td');
    refs.trips = el('td');
    refs.cooldown = el('td', { class: 'mono' });
    refs.blacklist = el('td');
    refs.last = el('td', { class: 'mono' });
    refs.converter = el('td', { class: 'mono' });
    refs.probeOut = el('div', { class: 'probe-out' });
    refs.probe = el('button', { type: 'button', class: 'btn small', 'data-act': 'probe' }, [txt(t('probe'))]);
    var row = el('tr', null, [
      el('td', null, [refs.state]),
      refs.unit, refs.route, refs.failures, refs.rate, refs.trips, refs.cooldown,
      refs.blacklist, refs.last, refs.converter,
      el('td', { class: 'nowrap' }, [refs.probe, refs.probeOut])
    ]);
    liveRefs.set(row, refs);
    return row;
  }

  function cooldownText(row) {
    var entry = obj(row);
    var now = Date.now();
    var openUntil = num(entry.openUntil, 0);
    if (openUntil > now) return fmtDuration(openUntil - now);
    return fmtDuration(entry.nextCooldownMs);
  }

  function updateLiveRow(node, key, index) {
    var refs = liveRefs.get(node);
    if (!refs) return;
    var entry = obj(arr(obj(STATE).rows)[index]);
    var stateName = str(entry.state) || 'closed';
    if (stateName !== 'open' && stateName !== 'half-open') stateName = 'closed';
    refs.state.className = 'badge ' + stateClass(stateName);
    refs.state.textContent = stateLabel(stateName);
    var unit = str(entry.unit) || (str(entry.provider) || t('none'));
    if (str(entry.keyLabel) !== '') unit += ' · ' + str(entry.keyLabel);
    refs.unit.textContent = unit;
    refs.route.textContent = (str(entry.provider) || t('none')) + ' / ' + (str(entry.model) || t('none'));
    refs.failures.textContent = fmtNumber(entry.consecutive) + ' / ' + fmtNumber(entry.threshold);
    refs.rate.textContent = fmtPercent(entry.failureRate) + ' · ' + fmtNumber(entry.samples) + '/' + fmtNumber(entry.minSamples);
    refs.trips.textContent = fmtNumber(entry.trips) + (num(entry.halfOpenTarget, 1) > 1
      ? ' · ' + fmtNumber(entry.halfOpenSuccesses) + '/' + fmtNumber(entry.halfOpenTarget)
      : '');
    refs.cooldown.textContent = cooldownText(entry);
    refs.blacklist.textContent = entry.blacklisted === true
      ? reasonLabel(obj(entry.blacklist).reason) + ' · ' + recoverText(entry.blacklist)
      : '-';
    var last = obj(entry.lastFailure);
    var code = str(last.code);
    var status = last.status;
    var hasStatus = status !== undefined && status !== null && status !== '';
    var lastText = code === '' && !hasStatus
      ? '-'
      : (code === '' ? '?' : code) + (hasStatus ? '/' + String(status) : '');
    if (str(entry.lastClass) !== '') lastText += ' (' + classLabel(entry.lastClass) + ')';
    refs.last.textContent = lastText;
    refs.converter.textContent = str(entry.converter) || '-';

    var info = probeResults[key];
    refs.probe.disabled = !!(info && info.pending);
    refs.probe.textContent = info && info.pending ? t('probing') : t('probe');
    refs.probeOut.className = 'probe-out';
    refs.probeOut.textContent = '';
    if (info && info.pending) {
      refs.probeOut.textContent = t('probing');
    } else if (info && info.error) {
      refs.probeOut.className = 'probe-out bad';
      refs.probeOut.textContent = info.error;
    } else if (info && info.probe) {
      var probe = obj(info.probe);
      refs.probeOut.className = 'probe-out ' + (probe.ok === true ? 'ok' : 'bad');
      refs.probeOut.textContent = probeBits(probe);
    }
    node.setAttribute('data-provider', str(entry.provider));
    node.setAttribute('data-model', str(entry.model));
    node.setAttribute('data-key-id', str(entry.keyId));
  }

  function markEmptyRow(container, show, message, columns) {
    var node = container.querySelector('[data-empty]');
    if (!show) {
      if (node && node.parentNode) node.parentNode.removeChild(node);
      return;
    }
    if (!node) {
      node = el('tr', { 'data-empty': '1' }, [el('td', { colspan: String(columns), class: 'empty' }, [txt(message)])]);
      container.appendChild(node);
    } else if (node.firstChild) {
      node.firstChild.textContent = message;
    }
  }

  function renderLive() {
    if (!liveBody) return;
    var rows = arr(obj(STATE).rows);
    var keys = keyList(rows, liveKey);
    syncKeyed(liveBody, keys, makeLiveRow, updateLiveRow);
    markEmptyRow(liveBody, rows.length === 0, t('empty'), 11);
    setText('live-updated', lastOkAt > 0 ? t('lastUpdated') + ': ' + fmtClock(lastOkAt) : '');
  }

  function probeLiveRow(button) {
    var row = closestAct(button, 'tr');
    if (!row) return;
    var provider = str(row.getAttribute('data-provider'));
    var model = str(row.getAttribute('data-model'));
    var keyId = str(row.getAttribute('data-key-id'));
    var key = liveKey({ provider: provider, model: model, keyId: keyId });
    var body = { provider: provider, model: model };
    if (keyId !== '') body.keyId = keyId;
    probeResults[key] = { pending: true };
    renderLive();
    return runButton(button, function () {
      return api('probe', body).then(function (value) {
        var payload = obj(value);
        probeResults[key] = { pending: false, probe: obj(payload.probe) };
        if (payload.state) applyState(payload.state, false);
        else renderLive();
      }, function (err) {
        probeResults[key] = { pending: false, error: err && err.message ? err.message : String(err) };
        renderLive();
      });
    });
  }

  function resetBreakers(button) {
    return runButton(button, function () {
      return api('reset', {}).then(function (next) {
        probeResults = {};
        sigs.providers = '';
        sigs.routing = '';
        applyState(next, false);
        toast(t('saved'), 'ok');
      });
    });
  }

  // ---- recent events -------------------------------------------------------

  function eventText(event) {
    var entry = obj(event);
    var kind = str(entry.kind);
    var vars = {
      provider: str(entry.provider) || t('none'),
      to: str(entry.to) || t('none'),
      failure: str(entry.failure) || t('none'),
      attempt: fmtNumber(entry.attempt),
      wait: fmtDuration(entry.waitMs),
      outcome: str(entry.outcome) || str(entry.state) || t('none'),
      message: str(entry.message) || t('none')
    };
    if (kind === 'retry') return fmt(t('evRetry'), vars);
    if (kind === 'failure') return fmt(t('evFailure'), vars);
    if (kind === 'switch') return fmt(t('evSwitch'), vars);
    if (kind === 'success') return fmt(t('evSuccess'), vars);
    if (kind === 'exhausted') return t('evExhausted');
    if (kind === 'no-alternative') return fmt(t('evNoAlternative'), vars);
    if (kind === 'probe') return fmt(t('evProbe'), vars);
    if (kind === 'blacklist') return fmt(t('evBlacklist'), vars);
    if (kind === 'ignored') return fmt(t('evIgnored'), vars);
    if (kind === 'unconfigured') return fmt(t('evUnconfigured'), vars);
    if (kind === 'timeslot') return fmt(t('evTimeslot'), vars);
    return str(entry.message) || kind || t('none');
  }

  function eventExtra(event) {
    var entry = obj(event);
    var bits = [];
    if (str(entry.keyId) !== '') bits.push(t('evKey') + ' ' + str(entry.keyId));
    if (entry.attempt !== undefined && entry.attempt !== null) bits.push(t('attemptLabel') + ' ' + fmtNumber(entry.attempt) + (lang === 'zh' ? t('attemptUnit') : ''));
    if (entry.waitMs !== undefined && entry.waitMs !== null) bits.push(t('waitLabel') + ' ' + fmtDuration(entry.waitMs));
    if (str(entry.state) !== '' && str(entry.kind) !== 'blacklist') bits.push(str(entry.state));
    if (str(entry.reason) !== '') bits.push(str(entry.reason));
    if (str(entry.message) !== '' && str(entry.kind) !== 'exhausted') bits.push(snippet(entry.message, 160));
    return bits.join(' · ');
  }

  function kindLabel(kind) {
    var key = has(KIND_KEYS, kind) ? KIND_KEYS[kind] : null;
    return key ? t(key) : String(kind);
  }

  function kindClass(kind) {
    if (kind === 'failure' || kind === 'exhausted' || kind === 'blacklist') return 'bad';
    if (kind === 'switch' || kind === 'ignored' || kind === 'unconfigured' || kind === 'timeslot') return 'warn';
    if (kind === 'success' || kind === 'probe') return 'ok';
    return '';
  }

  function markEmptyItem(container, show, message) {
    var node = container.querySelector('[data-empty]');
    if (!show) {
      if (node && node.parentNode) node.parentNode.removeChild(node);
      return;
    }
    if (!node) {
      node = el('li', { 'data-empty': '1', class: 'empty' }, [txt(message)]);
      container.appendChild(node);
    } else {
      node.textContent = message;
    }
  }

  function renderTimeSlot() {
    var line = document.getElementById('time-slot-line');
    if (!line) return;
    var slot = obj(obj(STATE).timeSlot);
    var label = str(slot.label);
    if (label === '') {
      line.textContent = t('timeSlotIdle');
      return;
    }
    var at = str(slot.at);
    var count = 0;
    var effective = obj(slot.effective);
    for (var key in effective) {
      if (Object.prototype.hasOwnProperty.call(effective, key) && typeof effective[key] === 'number' && effective[key] !== 0) count += 1;
    }
    line.textContent = fmt(t('timeSlotActive'), { label: label, at: at, count: count });
  }

  function renderRecent() {
    if (!recentBody) return;
    renderTimeSlot();
    var events = arr(obj(STATE).recent).slice();
    events.sort(function (a, b) { return num(obj(b).at, 0) - num(obj(a).at, 0); });
    if (events.length > 60) events = events.slice(0, 60);
    var keys = keyList(events, function (event) {
      var entry = obj(event);
      return num(entry.at, 0) + '|' + str(entry.kind) + '|' + str(entry.provider) + '|'
        + str(entry.keyId) + '|' + str(entry.to) + '|' + str(entry.message);
    });
    syncKeyed(recentBody, keys, function (key, index) {
      var entry = obj(events[index]);
      var kind = str(entry.kind) || 'event';
      return el('li', null, [
        el('span', { class: 'time' }, [txt(fmtClock(entry.at))]),
        el('span', { class: 'badge kind ' + kindClass(kind) }, [txt(kindLabel(kind))]),
        el('span', { class: 'ev-text' }, [txt(eventText(entry))]),
        el('span', { class: 'ev-extra muted' }, [txt(eventExtra(entry))])
      ]);
    }, function () { /* an event's text is immutable, so a keyed row needs no update */ });
    markEmptyItem(recentBody, events.length === 0, t('recentEmpty'));
  }

  // ---- stats ---------------------------------------------------------------

  function renderStats() {
    if (!statsBody) return;
    if (!statRefs) {
      statRefs = {};
      clear(statsBody);
      for (var i = 0; i < STAT_KEYS.length; i++) {
        var value = el('b', null, [txt('0')]);
        statRefs[STAT_KEYS[i][0]] = value;
        statsBody.appendChild(el('div', { class: 'stat' }, [value, el('span', null, [txt(t(STAT_KEYS[i][1]))])]));
      }
    }
    var stats = obj(obj(STATE).stats);
    for (var j = 0; j < STAT_KEYS.length; j++) {
      var key = STAT_KEYS[j][0];
      if (statRefs[key]) statRefs[key].textContent = fmtNumber(stats[key]);
    }
  }

  // ---- raw endpoint + server port ------------------------------------------

  function renderServer() {
    var state = obj(STATE);
    var server = obj(state.server);
    setText('server-host', str(server.host) || BOOT.host);
    setText('raw-base', RAW_BASE);
    var input = document.getElementById('server-port');
    if (input && document.activeElement !== input) input.value = String(num(server.port, BOOT.port));
  }

  function savePort(button) {
    var input = document.getElementById('server-port');
    if (!input) return;
    var port = Number(String(input.value).trim());
    if (!Number.isFinite(port) || Math.trunc(port) !== port || port < 1 || port > 65535) {
      setFieldError('port', t('invalidNumber'));
      return;
    }
    setFieldError('port', '');
    var previous = num(obj(obj(STATE).server).port, BOOT.port);
    return runButton(button, function () {
      return postConfig('sec-raw', { server: { port: port } }, function (next) {
        applyState(next, false);
        if (port !== previous || obj(next).restartRequired === true) showRestartNotice();
      });
    });
  }

  function showRestartNotice() {
    var notice = document.getElementById('restart-notice');
    if (notice) notice.hidden = false;
  }

  // ---- clipboard -----------------------------------------------------------

  function copyText(value, button) {
    var fallback = function () {
      var area = el('textarea', { class: 'clip' }, [txt(value)]);
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
      document.body.removeChild(area);
      toast(ok ? t('copied') : t('copyFailed'), ok ? 'ok' : 'error');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(String(value)).then(function () { toast(t('copied'), 'ok'); }, fallback);
    } else {
      fallback();
    }
  }

  // ---- wiring --------------------------------------------------------------

  function initHeader() {
    var refresh = document.getElementById('refresh');
    if (refresh) refresh.addEventListener('click', function () { runButton(refresh, function () { return refreshState(true); }); });
    var langButton = document.getElementById('lang-toggle');
    if (langButton) langButton.addEventListener('click', function () { setLang(lang === 'zh' ? 'en' : 'zh'); });
  }

  function initProviders() {
    var root = document.getElementById('sec-providers');
    if (!root) return;
    root.addEventListener('click', function (event) {
      var button = closestAct(event.target, 'button[data-act]');
      if (!button) return;
      var act = button.getAttribute('data-act');
      if (act === 'add-provider') {
        addProviderRow();
      } else if (act === 'save-providers') {
        saveProviders(button);
      } else if (act === 'delete-provider') {
        deleteProvider(button);
      } else if (act === 'add-key') {
        addKeyRow(button);
      } else if (act === 'delete-key') {
        deleteKeyRow(button);
      } else if (act === 'restore-key') {
        restoreKey(button);
      } else if (act === 'restore-provider') {
        restoreProvider(button);
      } else if (act === 'probe-key') {
        probeKey(button);
      } else if (act === 'fetch-models') {
        fetchModels(button);
      }
    });
    // Picking which credential to fetch models with changes nothing the server
    // has seen, so it must not mark the section dirty and freeze the poll.
    root.addEventListener('input', function (event) {
      if (closestAct(event.target, 'select[data-field="models-key"]')) return;
      dirty.providers = true;
    });
    root.addEventListener('change', function (event) {
      if (closestAct(event.target, 'select[data-field="models-key"]')) return;
      dirty.providers = true;
    });
  }

  function initRouting() {
    var root = document.getElementById('sec-routing');
    if (!root) return;
    root.addEventListener('click', function (event) {
      var button = closestAct(event.target, 'button[data-act]');
      if (!button) return;
      var act = button.getAttribute('data-act');
      if (act === 'up' || act === 'down') moveRouteRow(button, act);
      else if (act === 'del-route') deleteRouteRow(button);
      else if (act === 'add-route') addRouteRow(button);
      else if (act === 'del-slot') deleteSlotRow(button);
      else if (act === 'add-slot') addSlotRow(button);
      else if (act === 'remove-unregistered') removeUnregistered(button);
      else if (act === 'save-routing') saveRouting(button, false);
    });
    root.addEventListener('input', function () { dirty.routing = true; });
    root.addEventListener('change', function (event) {
      dirty.routing = true;
      // Re-point one row's model datalist at whatever provider it now names.
      var select = closestAct(event.target, 'select[data-field="provider"]');
      if (select) syncRouteDatalist(closestAct(select, 'tr'));
    });
  }

  function initLive() {
    var root = document.getElementById('sec-live');
    if (!root) return;
    root.addEventListener('click', function (event) {
      var button = closestAct(event.target, 'button[data-act]');
      if (!button) return;
      var act = button.getAttribute('data-act');
      if (act === 'reset') {
        resetBreakers(button);
      } else if (act === 'probe') {
        probeLiveRow(button);
      }
    });
  }

  function initBlacklist() {
    var root = document.getElementById('sec-blacklist');
    if (!root) return;
    root.addEventListener('click', function (event) {
      var button = closestAct(event.target, 'button[data-act]');
      if (!button) return;
      var act = button.getAttribute('data-act');
      if (act === 'restore-key') restoreKey(button);
    });
  }

  function initRaw() {
    var pairs = [
      ['raw-base-copy', function () { return RAW_BASE; }],
      ['raw-chat-copy', function () { return RAW_BASE + '/chat/completions'; }],
      ['raw-models-copy', function () { return RAW_BASE + '/models'; }]
    ];
    for (var i = 0; i < pairs.length; i++) {
      (function (id, resolve) {
        var button = document.getElementById(id);
        if (button) button.addEventListener('click', function () { copyText(resolve(), button); });
      })(pairs[i][0], pairs[i][1]);
    }
    var saveButton = document.getElementById('save-port');
    if (saveButton) saveButton.addEventListener('click', function () { savePort(saveButton); });
  }

  // ---- tabs ----------------------------------------------------------------

  /**
   * Show one tab's sections and mark its button.
   *
   * Every section stays in the DOM and keeps being reconciled by the poll, so a
   * tab switch is a visibility change and never a re-render: a hidden section is
   * already up to date the moment it is revealed. The hidden attribute is what
   * the page's own [hidden] rule keys on, so there is one mechanism, not two.
   * @param {string} key - the tab to activate; an unknown key falls back.
   */
  function setTab(key) {
    var sections = document.querySelectorAll('[data-tab]');
    var match = false;
    var i;
    for (i = 0; i < sections.length; i++) if (sections[i].getAttribute('data-tab') === key) match = true;
    if (!match) key = DEFAULT_TAB;
    for (i = 0; i < sections.length; i++) {
      sections[i].hidden = sections[i].getAttribute('data-tab') !== key;
    }
    var buttons = document.querySelectorAll('#tabs .tab');
    for (i = 0; i < buttons.length; i++) {
      var on = buttons[i].getAttribute('data-tabkey') === key;
      if (on) buttons[i].setAttribute('data-active', 'true');
      else buttons[i].removeAttribute('data-active');
      buttons[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    try { window.localStorage.setItem(TAB_KEY, key); } catch (err) { /* private mode: the tab still switches for this view */ }
  }

  function initTabs() {
    var root = document.getElementById('tabs');
    if (!root) return;
    root.addEventListener('click', function (event) {
      var button = closestAct(event.target, 'button[data-tabkey]');
      if (button) setTab(button.getAttribute('data-tabkey'));
    });
    var saved = null;
    try { saved = window.localStorage.getItem(TAB_KEY); } catch (err) { saved = null; }
    setTab(saved === null ? DEFAULT_TAB : saved);
  }

  function init() {
    providersBody = document.getElementById('providers-body');
    routingBody = document.getElementById('routing-body');
    liveBody = document.getElementById('live-body');
    recentBody = document.getElementById('recent-body');
    statsBody = document.getElementById('stats-body');
    blacklistBody = document.getElementById('blacklist-body');
    applyStatic();
    initTabs();
    renderHeader();
    renderProviders();
    renderRouting();
    renderLive();
    renderBlacklist();
    renderRecent();
    renderStats();
    renderServer();
    initHeader();
    initProviders();
    initRouting();
    initLive();
    initBlacklist();
    initRaw();

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        startPolling();
        tick(); // one fresh read on the way back into view
      } else {
        stopPolling();
      }
    });
    if (document.visibilityState === 'visible') startPolling();
    refreshState(false);
  }

  init();
})();
</script>
</body>
</html>
`
}

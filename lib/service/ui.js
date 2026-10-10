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
 * ## Built with DOM APIs, never with innerHTML
 *
 * Every value that reaches the page comes from a config file a human may have
 * hand-edited (`lib/service/config.js` deliberately repairs rather than
 * rejects), so provider ids, labels, base URLs and upstream error messages are
 * all untrusted text. The page therefore never assembles markup from strings:
 * {@link renderAdminPage} emits static markup plus one JSON boot blob, and the
 * client fills it in with `createElement`/`textContent` through one small `el()`
 * helper. There is no escaping function to forget to call, because there is no
 * string-to-HTML path at all — the one place untrusted text meets markup
 * (`attr()`, for the token) escapes it explicitly.
 *
 * ## Polling must not fight the operator
 *
 * A four-second poll that rebuilds the DOM would destroy selections, half-typed
 * ids and scroll position — an admin page that undoes your edits is worse than
 * one that does not refresh. So the client reconciles instead of rebuilding:
 *
 *   - read-only feeds (live breaker rows, recent events, stats) reuse their
 *     existing rows keyed by identity and only overwrite text;
 *   - the two editable sections (providers, routing) are keyed by a signature of
 *     the server state and are re-rendered *only* when that state actually
 *     changed, and never while the section holds a draft or the focus.
 *
 * The poll itself stops while the tab is hidden and while any save or probe owns
 * the wire, and it refreshes once on the way back into view, so a background tab
 * neither burns the service nor races a write.
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
  font: 14px/1.5 var(--sans);
  -webkit-text-size-adjust: 100%;
}
.wrap { max-width: 1200px; margin: 0 auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.card-head h2 { margin: 0; font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
.hint { margin: 5px 0 8px; color: var(--muted); font-size: 12px; }
.muted { color: var(--muted); }
.mono, code, .mono input, input.mono, textarea.mono { font-family: var(--mono); font-size: 12px; }
code { background: var(--panel-2); border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px; }
.top {
  position: sticky; top: 0; z-index: 20;
  display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;
  background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 9px 13px;
}
.brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
.brand h1 { margin: 0; font-size: 15px; font-weight: 650; white-space: nowrap; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); flex: none; }
.dot.ok { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); }
.dot.bad { background: var(--danger); box-shadow: 0 0 0 3px var(--danger-soft); }
.top-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tools { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
button { font: inherit; color: inherit; }
.btn {
  background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px;
  padding: 4px 10px; cursor: pointer; white-space: nowrap;
}
.btn:hover:not(:disabled) { border-color: var(--accent); }
.btn:disabled { opacity: 0.5; cursor: default; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); font-weight: 600; }
.btn.small { padding: 2px 7px; font-size: 12px; }
input, select, textarea { font: inherit; color: inherit; }
input[type="text"], input[type="password"], input[type="number"], select, textarea {
  width: 100%; min-width: 0; background: var(--panel-2); border: 1px solid var(--border);
  border-radius: 6px; padding: 4px 6px;
}
input[type="checkbox"] { width: auto; }
textarea { resize: vertical; }
input.ro { background: transparent; border-style: dashed; color: var(--muted); }
input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 1px;
}
.table-wrap { overflow-x: auto; }
table.grid { border-collapse: collapse; width: 100%; }
table.grid th, table.grid td { border-bottom: 1px solid var(--border); padding: 5px 8px; text-align: left; vertical-align: top; }
table.grid thead th {
  font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted);
  font-weight: 700; white-space: nowrap; background: var(--panel);
}
table.grid tr.err-row td { border-bottom: 1px solid var(--border); padding-top: 0; }
table.providers td:nth-child(1) { width: 12%; }
table.providers td:nth-child(2) { width: 12%; }
table.providers td:nth-child(3) { width: 20%; }
table.providers td:nth-child(4) { width: 14%; }
table.providers td:nth-child(5) { width: 16%; }
table.providers td:nth-child(6) { width: 18%; }
table.providers td:nth-child(7) { width: 8%; }
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
.stat { background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px; padding: 6px 9px; }
.stat b { display: block; font-family: var(--mono); font-size: 18px; font-weight: 600; }
.stat span { color: var(--muted); font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; }
.events { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; max-height: 340px; overflow: auto; }
.events li { display: flex; gap: 8px; align-items: baseline; padding: 3px 0; border-bottom: 1px dashed var(--border); font-size: 13px; }
.events .time { font-family: var(--mono); color: var(--muted); font-size: 12px; flex: none; }
.events .ev-extra { font-size: 12px; }
.empty { color: var(--muted); font-size: 12px; padding: 6px 0; }
.probe-out { font-family: var(--mono); font-size: 11px; color: var(--muted); margin-top: 3px; max-width: 300px; word-break: break-word; }
.probe-out.ok { color: var(--ok); }
.probe-out.bad { color: var(--danger); }
.notice { background: var(--warn-soft); border: 1px solid var(--warn); color: var(--warn); border-radius: 6px; padding: 7px 11px; font-size: 13px; }
.section-error { color: var(--danger); font-size: 12px; margin: 6px 0 0; }
.section-error:empty { display: none; }
.kv { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 3px 0; }
[hidden] { display: none !important; }
.clip { position: fixed; left: -9999px; top: 0; }
#toasts { position: fixed; right: 14px; bottom: 14px; z-index: 50; display: flex; flex-direction: column; gap: 6px; max-width: min(440px, 92vw); }
.toast {
  background: var(--panel); border: 1px solid var(--border); border-left: 3px solid var(--accent);
  border-radius: 6px; padding: 7px 10px; box-shadow: var(--shadow); font-size: 13px; word-break: break-word;
}
.toast.ok { border-left-color: var(--ok); }
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

  <section class="card" id="sec-providers">
    <div class="card-head">
      <h2 data-i18n="providers"></h2>
      <div class="tools">
        <button type="button" class="btn" data-act="add-provider" data-i18n="addProvider"></button>
        <button type="button" class="btn primary" data-act="save-providers" data-i18n="saveProviders"></button>
      </div>
    </div>
    <p class="hint" data-i18n="providersHint"></p>
    <p class="section-error" data-role="section-error" role="alert"></p>
    <div class="table-wrap" id="providers-body"></div>
  </section>

  <section class="card" id="sec-routing">
    <div class="card-head">
      <h2 data-i18n="routing"></h2>
    </div>
    <p class="hint" data-i18n="routingHint"></p>
    <p class="section-error" data-role="section-error" role="alert"></p>
    <div id="routing-body"></div>
  </section>

  <section class="card" id="sec-live">
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
            <th data-i18n="thRoute"></th>
            <th data-i18n="thFailures"></th>
            <th data-i18n="thTrips"></th>
            <th data-i18n="thCooldown"></th>
            <th data-i18n="thLastFailure"></th>
            <th data-i18n="thConverter"></th>
            <th data-i18n="thProbe"></th>
          </tr>
        </thead>
        <tbody id="live-body"></tbody>
      </table>
    </div>
  </section>

  <section class="card" id="sec-recent">
    <div class="card-head"><h2 data-i18n="recent"></h2></div>
    <ul class="events" id="recent-body"></ul>
  </section>

  <section class="card" id="sec-stats">
    <div class="card-head"><h2 data-i18n="stats"></h2></div>
    <div class="stats" id="stats-body"></div>
  </section>

  <section class="card" id="sec-raw">
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
  var POLL_MS = 4000;
  var ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

  // Every user-visible string lives here; Chinese is the primary language and
  // English is the fallback for a missing key, not the other way round.
  var STRINGS = {
    zh: {
      serviceName: 'DSH 模型路由服务',
      refresh: '刷新',
      lastUpdated: '最后更新',
      up: '在线',
      down: '离线',
      loading: '加载中…',
      providers: '供应商',
      providersHint: 'apiKey 留空表示保留已保存的密钥；headers 为字符串值的扁平 JSON 对象。',
      addProvider: '新增供应商',
      saveProviders: '保存供应商',
      thId: 'ID',
      thLabel: '名称',
      thBaseURL: 'baseURL',
      thApiKey: 'API Key',
      thModels: '模型（逗号分隔）',
      thHeaders: 'headers (JSON)',
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
      windowMs: '统计窗口 (ms)',
      cooldownMs: '冷却时间 (ms)',
      cooldownFactor: '冷却倍率',
      cooldownMaxMs: '冷却上限 (ms)',
      maxSwitches: '最大切换次数 (0=自动)',
      recoveryMode: '恢复方式',
      logLevel: '日志级别',
      modeProbe: '探测后恢复',
      modeImmediate: '立即恢复',
      budget: '切换预算（推导）',
      live: '实时状态',
      liveHint: '页面可见且无请求进行时每 4 秒自动刷新。',
      resetBreakers: '清除熔断状态',
      probe: '探测',
      probing: '探测中…',
      stateClosed: '正常',
      stateHalfOpen: '探测中',
      stateOpen: '熔断',
      thState: '状态',
      thRoute: '路由',
      thFailures: '失败/阈值',
      thTrips: '熔断次数',
      thCooldown: '冷却',
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
      invalidModels: '模型列表不能为空',
      invalidHeaders: 'headers 必须是字符串值的扁平 JSON 对象',
      invalidNumber: '数值必须是范围内的整数',
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
      evRetry: '{provider} 第 {attempt} 次重试，等待 {wait}',
      evFailure: '{provider} 请求失败：{failure}',
      evSwitch: '{provider} 切换到 {to}',
      evSuccess: '{provider} 请求成功',
      evExhausted: '所有候选均已失败，请求终止',
      evNoAlternative: '{provider} 无可用备用候选',
      evProbe: '探测 {provider}：{outcome}',
      empty: '（空）',
      noUnregistered: '没有未注册行'
    },
    en: {
      serviceName: 'DSH model router service',
      refresh: 'Refresh',
      lastUpdated: 'Last updated',
      up: 'up',
      down: 'down',
      loading: 'Loading…',
      providers: 'Providers',
      providersHint: 'An empty API Key keeps the stored one; headers must be a flat JSON object of strings.',
      addProvider: 'Add provider',
      saveProviders: 'Save providers',
      thId: 'ID',
      thLabel: 'Label',
      thBaseURL: 'baseURL',
      thApiKey: 'API Key',
      thModels: 'Models (comma separated)',
      thHeaders: 'headers (JSON)',
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
      windowMs: 'Window (ms)',
      cooldownMs: 'Cooldown (ms)',
      cooldownFactor: 'Cooldown factor',
      cooldownMaxMs: 'Cooldown ceiling (ms)',
      maxSwitches: 'Max switches (0 = auto)',
      recoveryMode: 'Recovery mode',
      logLevel: 'Log level',
      modeProbe: 'probe then recover',
      modeImmediate: 'recover immediately',
      budget: 'Switch budget (derived)',
      live: 'Live state',
      liveHint: 'Auto-refreshes every 4s while the tab is visible and no request is in flight.',
      resetBreakers: 'Reset breakers',
      probe: 'Probe',
      probing: 'Probing…',
      stateClosed: 'closed',
      stateHalfOpen: 'half-open',
      stateOpen: 'open',
      thState: 'State',
      thRoute: 'Route',
      thFailures: 'Failures / threshold',
      thTrips: 'Trips',
      thCooldown: 'Cooldown',
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
      invalidModels: 'At least one model is required',
      invalidHeaders: 'headers must be a flat JSON object of strings',
      invalidNumber: 'Value must be an integer in range',
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
      evRetry: '{provider} retry {attempt}, waiting {wait}',
      evFailure: '{provider} failed: {failure}',
      evSwitch: '{provider} switched to {to}',
      evSuccess: '{provider} succeeded',
      evExhausted: 'all candidates failed, request abandoned',
      evNoAlternative: '{provider} has no available alternative',
      evProbe: 'probe {provider}: {outcome}',
      empty: '(empty)',
      noUnregistered: 'no unregistered rows'
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
  var liveRefs = new WeakMap();
  var statRefs = null;
  var liveBody = null;
  var recentBody = null;
  var statsBody = null;
  var providersBody = null;
  var routingBody = null;

  var STAT_KEYS = [
    ['requests', 'statRequests'], ['failures', 'statFailures'], ['opens', 'statOpens'],
    ['switches', 'statSwitches'], ['retries', 'statRetries'], ['exhausted', 'statExhausted'],
    ['probes', 'statProbes'], ['probeOk', 'statProbeOk']
  ];
  var KIND_KEYS = {
    retry: 'kindRetry', failure: 'kindFailure', switch: 'kindSwitch', success: 'kindSuccess',
    exhausted: 'kindExhausted', 'no-alternative': 'kindNoAlternative', probe: 'kindProbe'
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
    renderStats();
    renderServer();
  }

  // ---- DOM helpers (no innerHTML anywhere: text never becomes markup) ------

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

  // ---- formatting ----------------------------------------------------------

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function fmtClock(at) {
    var date = new Date(num(at, 0));
    if (!Number.isFinite(date.getTime())) return '-';
    return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
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
    var node = el('div', { class: 'toast ' + (kind === 'error' ? 'error' : kind === 'ok' ? 'ok' : '') }, [txt(message)]);
    host.appendChild(node);
    window.setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, kind === 'error' ? 9000 : 4000);
  }

  /**
   * Run one button-triggered action.
   *
   * busy is what keeps the poll off the wire while a save or probe is in
   * flight, and the finally is what keeps a thrown error from leaving the
   * button dead for the rest of the page's life.
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

  function applyState(next, structural) {
    if (next === null || typeof next !== 'object') return;
    STATE = next;
    renderHeader();
    renderProviders(structural === true);
    renderRouting(structural === true);
    renderLive();
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
   * Re-mask a key before it reaches the DOM.
   *
   * The service already masks apiKey before putting it in STATE, so this is a
   * second line of defence rather than the only one: a server that ever sent a
   * full credential must not be able to turn the admin page into a place where
   * that credential is readable.
   */
  function maskKey(value) {
    var text = str(value);
    if (text === '') return '';
    if (text.length <= 8) return text.charAt(0) + '…' + text.charAt(text.length - 1);
    return text.slice(0, 3) + '…' + text.slice(text.length - 4);
  }

  function headersText(value) {
    var headers = obj(value);
    var keys = Object.keys(headers);
    if (keys.length === 0) return '';
    try { return JSON.stringify(headers, null, 2); } catch (err) { return ''; }
  }

  function providerGroup(provider, isNew) {
    var entry = obj(provider);
    var id = str(entry.id);
    var idInput = el('input', {
      type: 'text', class: 'mono', 'data-field': 'id', value: id,
      readonly: !isNew, maxlength: '64', placeholder: 'provider-id'
    });
    if (!isNew) idInput.className = 'mono ro';
    var keySet = entry.apiKeySet === true;
    var group = el('tbody', { 'data-role': 'provider', 'data-id': isNew ? '' : id, 'data-new': isNew ? '1' : '0' }, [
      el('tr', null, [
        el('td', null, [idInput]),
        el('td', null, [el('input', { type: 'text', 'data-field': 'label', value: str(entry.label) })]),
        el('td', null, [el('input', { type: 'text', class: 'mono', 'data-field': 'baseURL', value: str(entry.baseURL), spellcheck: 'false' })]),
        el('td', null, [
          el('input', {
            type: 'password', class: 'mono', 'data-field': 'apiKey', value: '',
            autocomplete: 'new-password', spellcheck: 'false',
            placeholder: keySet ? t('apiKeySet') : t('apiKeyUnset')
          }),
          el('div', { class: 'hint', 'data-role': 'key-hint', style: 'margin:2px 0 0' }, [txt(keySet ? maskKey(entry.apiKey) : t('apiKeyUnset'))])
        ]),
        el('td', null, [el('input', { type: 'text', class: 'mono', 'data-field': 'models', value: arr(entry.models).join(', ') })]),
        el('td', null, [el('textarea', { class: 'mono', rows: '2', 'data-field': 'headers', spellcheck: 'false' }, [txt(headersText(entry.headers))])]),
        el('td', { class: 'nowrap' }, [
          el('button', { type: 'button', class: 'btn small', 'data-act': 'delete-provider' }, [txt(t('deleteRow'))])
        ])
      ]),
      el('tr', { class: 'err-row' }, [el('td', { colspan: '7' }, [el('span', { class: 'row-error', 'data-role': 'row-error' })])])
    ]);
    return group;
  }

  function renderProviders(force) {
    if (!providersBody) return;
    var providers = arr(obj(STATE).providers);
    var sig = JSON.stringify(providers);
    if (force !== true && sig === sigs.providers) return;
    // A dirty or focused section holds a draft the server has not seen yet.
    if (force !== true && (dirty.providers || focusInside('sec-providers'))) return;
    sigs.providers = sig;
    var table = el('table', { class: 'grid providers' }, [
      el('thead', null, [el('tr', null, [
        el('th', null, [txt(t('thId'))]),
        el('th', null, [txt(t('thLabel'))]),
        el('th', null, [txt(t('thBaseURL'))]),
        el('th', null, [txt(t('thApiKey'))]),
        el('th', null, [txt(t('thModels'))]),
        el('th', null, [txt(t('thHeaders'))]),
        el('th', null, [txt(t('thActions'))])
      ])])
    ]);
    for (var i = 0; i < providers.length; i++) table.appendChild(providerGroup(providers[i], false));
    clear(providersBody);
    providersBody.appendChild(table);
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

  /** {} for empty, the object, or null when it is not a flat string map. */
  function parseHeaders(value) {
    var text = String(value === null || value === undefined ? '' : value).trim();
    if (text === '') return {};
    var parsed = null;
    try { parsed = JSON.parse(text); } catch (err) { return null; }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    var out = {};
    for (var key in parsed) {
      if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue;
      if (typeof parsed[key] !== 'string') return null;
      out[key] = parsed[key];
    }
    return out;
  }

  function collectProviders() {
    var groups = providersBody ? providersBody.querySelectorAll('tbody[data-role="provider"]') : [];
    var map = {};
    var seen = {};
    var bad = false;
    for (var i = 0; i < groups.length; i++) {
      var group = groups[i];
      var id = fieldValue(group, 'id').trim();
      var label = fieldValue(group, 'label').trim();
      var baseURL = fieldValue(group, 'baseURL').trim();
      var apiKey = fieldValue(group, 'apiKey');
      var models = splitList(fieldValue(group, 'models'));
      var headers = parseHeaders(fieldValue(group, 'headers'));
      var problems = [];
      if (!ID_RE.test(id)) problems.push(t('invalidId'));
      if (!validBaseURL(baseURL)) problems.push(t('invalidBaseURL'));
      if (models.length === 0) problems.push(t('invalidModels'));
      if (headers === null) problems.push(t('invalidHeaders'));
      if (Object.prototype.hasOwnProperty.call(seen, id)) problems.push(t('duplicateId'));
      if (problems.length > 0) { setRowError(group, problems.join(' · ')); bad = true; continue; }
      setRowError(group, '');
      seen[id] = true;
      // A blank label is the server's documented default, not an empty name.
      map[id] = { label: label === '' ? id : label, baseURL: baseURL, apiKey: apiKey, models: models, headers: headers };
    }
    return bad ? null : map;
  }

  function saveProviders(button) {
    var map = collectProviders();
    if (map === null) { toast(t('fixErrors'), 'error'); return; }
    return runButton(button, function () {
      return postConfig('sec-providers', { providers: map }, function (next) {
        dirty.providers = false;
        sigs.providers = '';
        applyState(next, true);
      });
    });
  }

  function addProviderRow() {
    if (!providersBody) return;
    var table = providersBody.querySelector('table');
    if (!table) { renderProviders(true); table = providersBody.querySelector('table'); }
    if (!table) return;
    var group = providerGroup({ id: '', label: '', baseURL: 'https://', apiKeySet: false, models: [], headers: {} }, true);
    table.appendChild(group);
    dirty.providers = true;
    var input = group.querySelector('input[data-field="id"]');
    if (input) input.focus();
  }

  // ---- routing -------------------------------------------------------------

  /** Name / inclusive bounds for every numeric router setting the page edits. */
  function fieldSpecs(limits) {
    return [
      ['retries', 0, num(limits.maxRetries, 20)],
      ['failureThreshold', 1, num(limits.failureThreshold, 100)],
      ['windowMs', num(limits.minWindowMs, 0), num(limits.maxWindowMs, 3600000)],
      ['cooldownMs', num(limits.minCooldownMs, 0), num(limits.maxCooldownMs, 3600000)],
      ['cooldownFactor', num(limits.minCooldownFactor, 1), num(limits.maxCooldownFactor, 10)],
      ['cooldownMaxMs', num(limits.minCooldownMs, 0), num(limits.maxCooldownMs, 3600000)],
      ['maxSwitches', num(limits.minSwitches, 0), num(limits.maxSwitches, 20)]
    ];
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
    var cells = [
      el('td', { class: 'nowrap' }, [select, known || provider === '' ? null : el('span', { class: 'badge bad' }, [txt(t('notRegistered'))])]),
      el('td', null, [el('input', { type: 'text', class: 'mono', 'data-field': 'model', value: str(entry.model) })]),
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

  function fieldSpecRow(name, labelKey, value, min, max, extraKids) {
    var kids = [
      el('label', { for: 'f-' + name }, [
        el('span', null, [txt(t(labelKey))]),
        el('span', { class: 'bounds mono' }, [txt(min + ' – ' + max)])
      ]),
      el('input', { type: 'number', class: 'mono', id: 'f-' + name, 'data-field': name, min: String(min), max: String(max), step: '1', value: String(value) }),
      el('span', { class: 'field-error', 'data-err': name })
    ];
    if (extraKids) for (var i = 0; i < extraKids.length; i++) kids.push(extraKids[i]);
    return el('div', { class: 'field' }, kids);
  }

  function selectField(name, labelKey, values, current, labelKeys) {
    var select = el('select', { 'data-field': name, id: 'f-' + name });
    var seen = false;
    for (var i = 0; i < values.length; i++) {
      var value = String(values[i]);
      var text = labelKeys && Object.prototype.hasOwnProperty.call(labelKeys, value) ? t(labelKeys[value]) : value;
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

  function renderRouting(force) {
    if (!routingBody) return;
    var state = obj(STATE);
    var router = obj(state.router);
    var limits = obj(state.limits);
    var providerIds = providerIdList();
    var sig = JSON.stringify([router, limits, arr(state.recoveryModes), arr(state.logLevels), providerIds]);
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
      el('button', { type: 'button', class: 'btn', 'data-act': 'remove-unregistered' }, [txt(t('removeUnregistered'))])
    ]));

    var fields = el('div', { class: 'fields' });
    var specs = fieldSpecs(limits);
    for (var s = 0; s < specs.length; s++) {
      fields.appendChild(fieldSpecRow(specs[s][0], specs[s][0], num(router[specs[s][0]], specs[s][1]), specs[s][1], specs[s][2]));
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
      var name = specs[s][0];
      var raw = fieldValue(routingBody, name).trim();
      var value = Number(raw);
      if (raw === '' || !Number.isFinite(value) || Math.trunc(value) !== value || value < specs[s][1] || value > specs[s][2]) {
        setFieldError(name, t('invalidNumber'));
        bad = true;
        continue;
      }
      router[name] = value;
    }
    if (bad) return null;
    var modeNode = routingBody.querySelector('select[data-field="recoveryMode"]');
    var levelNode = routingBody.querySelector('select[data-field="logLevel"]');
    if (modeNode) router.recoveryMode = String(modeNode.value);
    if (levelNode) router.logLevel = String(levelNode.value);
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
        applyState(next, true);
      });
    });
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
        applyState(next, true);
      });
    });
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
      if (Object.prototype.hasOwnProperty.call(existing, stale)) container.removeChild(existing[stale]);
    }
  }

  /** Stable key per item; a repeated identity gets an index suffix. */
  function keyList(items, keyOf) {
    var seen = {};
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var base = String(keyOf(items[i], i));
      var key = base;
      if (Object.prototype.hasOwnProperty.call(seen, base)) key = base + '#' + i;
      seen[key] = true;
      out.push(key);
    }
    return out;
  }

  function liveKey(row) {
    var entry = obj(row);
    var provider = str(entry.provider);
    var model = str(entry.model);
    if (provider === '' && model === '') return 'row';
    return provider + '|' + model;
  }

  function makeLiveRow() {
    var refs = {};
    refs.state = el('span', { class: 'badge' });
    refs.probeOut = el('div', { class: 'probe-out' });
    refs.probe = el('button', { type: 'button', class: 'btn small', 'data-act': 'probe' }, [txt(t('probe'))]);
    var row = el('tr', null, [
      el('td', null, [refs.state]),
      el('td', { class: 'mono' }),
      el('td'),
      el('td'),
      el('td'),
      el('td', { class: 'mono' }),
      el('td', { class: 'mono' }),
      el('td', { class: 'nowrap' }, [refs.probe, refs.probeOut])
    ]);
    var cells = row.childNodes;
    refs.cellRoute = cells[1];
    refs.cellFailures = cells[2];
    refs.cellTrips = cells[3];
    refs.cellCooldown = cells[4];
    refs.cellLast = cells[5];
    refs.cellConverter = cells[6];
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
    refs.state.className = 'badge ' + (stateName === 'open' ? 'bad' : stateName === 'half-open' ? 'warn' : 'ok');
    refs.state.textContent = stateName === 'open' ? t('stateOpen') : stateName === 'half-open' ? t('stateHalfOpen') : t('stateClosed');
    refs.cellRoute.textContent = (str(entry.provider) || t('none')) + ' / ' + (str(entry.model) || t('none'));
    refs.cellFailures.textContent = fmtNumber(entry.failures) + ' / ' + fmtNumber(entry.threshold);
    refs.cellTrips.textContent = fmtNumber(entry.trips);
    refs.cellCooldown.textContent = cooldownText(entry);
    var last = obj(entry.lastFailure);
    var code = str(last.code);
    var status = last.status;
    var hasStatus = status !== undefined && status !== null && status !== '';
    refs.cellLast.textContent = code === '' && !hasStatus ? '-' : (code === '' ? '?' : code) + (hasStatus ? '/' + String(status) : '');
    refs.cellConverter.textContent = str(entry.converter) || '-';

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
      var probe = info.probe;
      var ok = probe.ok === true;
      var bits = [ok ? t('probeOk') : t('probeFail'), str(probe.code) || '-', fmtNumber(probe.ms) + 'ms'];
      if (probe.reasoningChars !== undefined && probe.reasoningChars !== null) {
        bits.push(fmtNumber(probe.reasoningChars) + ' ' + t('reasoningChars'));
      }
      if (str(probe.message) !== '') bits.push(str(probe.message));
      refs.probeOut.className = 'probe-out ' + (ok ? 'ok' : 'bad');
      refs.probeOut.textContent = bits.join(' · ');
    }
    node.setAttribute('data-provider', str(entry.provider));
    node.setAttribute('data-model', str(entry.model));
  }

  function markEmptyRow(container, show, message) {
    var node = container.querySelector('[data-empty]');
    if (!show) {
      if (node && node.parentNode) node.parentNode.removeChild(node);
      return;
    }
    if (!node) {
      node = el('tr', { 'data-empty': '1' }, [el('td', { colspan: '8', class: 'empty' }, [txt(message)])]);
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
    markEmptyRow(liveBody, rows.length === 0, t('empty'));
    setText('live-updated', lastOkAt > 0 ? t('lastUpdated') + ': ' + fmtClock(lastOkAt) : '');
  }

  function probe(provider, model, button) {
    var key = provider + '|' + model;
    probeResults[key] = { pending: true };
    renderLive();
    return runButton(button, function () {
      return api('probe', { provider: provider, model: model }).then(function (value) {
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
      outcome: str(entry.outcome) || str(entry.state) || t('none')
    };
    if (kind === 'retry') return fmt(t('evRetry'), vars);
    if (kind === 'failure') return fmt(t('evFailure'), vars);
    if (kind === 'switch') return fmt(t('evSwitch'), vars);
    if (kind === 'success') return fmt(t('evSuccess'), vars);
    if (kind === 'exhausted') return t('evExhausted');
    if (kind === 'no-alternative') return fmt(t('evNoAlternative'), vars);
    if (kind === 'probe') return fmt(t('evProbe'), vars);
    return str(entry.message) || kind || t('none');
  }

  function eventExtra(event) {
    var entry = obj(event);
    var bits = [];
    if (entry.attempt !== undefined && entry.attempt !== null) bits.push(t('attemptLabel') + ' ' + fmtNumber(entry.attempt) + (lang === 'zh' ? t('attemptUnit') : ''));
    if (entry.waitMs !== undefined && entry.waitMs !== null) bits.push(t('waitLabel') + ' ' + fmtDuration(entry.waitMs));
    if (str(entry.state) !== '') bits.push(str(entry.state));
    if (str(entry.message) !== '' && str(entry.kind) !== 'exhausted') bits.push(str(entry.message));
    return bits.join(' · ');
  }

  function kindLabel(kind) {
    var key = Object.prototype.hasOwnProperty.call(KIND_KEYS, kind) ? KIND_KEYS[kind] : null;
    return key ? t(key) : String(kind);
  }

  function kindClass(kind) {
    if (kind === 'failure' || kind === 'exhausted') return 'bad';
    if (kind === 'switch' || kind === 'no-alternative') return 'warn';
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

  function renderRecent() {
    if (!recentBody) return;
    var events = arr(obj(STATE).recent).slice();
    events.sort(function (a, b) { return num(obj(b).at, 0) - num(obj(a).at, 0); });
    if (events.length > 60) events = events.slice(0, 60);
    var keys = keyList(events, function (event) {
      var entry = obj(event);
      return num(entry.at, 0) + '|' + str(entry.kind) + '|' + str(entry.provider) + '|' + str(entry.to) + '|' + str(entry.message);
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
        applyState(next, true);
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
      } else if (act === 'delete-provider') {
        var group = closestAct(button, 'tbody');
        if (group && group.parentNode) { group.parentNode.removeChild(group); dirty.providers = true; }
      } else if (act === 'save-providers') {
        saveProviders(button);
      }
    });
    root.addEventListener('input', function () { dirty.providers = true; });
    root.addEventListener('change', function () { dirty.providers = true; });
  }

  function initRouting() {
    var root = document.getElementById('sec-routing');
    if (!root) return;
    root.addEventListener('click', function (event) {
      var button = closestAct(event.target, 'button[data-act]');
      if (!button) return;
      var act = button.getAttribute('data-act');
      if (act === 'up' || act === 'down') moveRouteRow(button, act);
      else if (act === 'del-route') {
        var tr = closestAct(button, 'tr');
        if (tr && tr.parentNode) { tr.parentNode.removeChild(tr); dirty.routing = true; }
      } else if (act === 'remove-unregistered') removeUnregistered(button);
      else if (act === 'save-routing') saveRouting(button, false);
    });
    root.addEventListener('input', function () { dirty.routing = true; });
    root.addEventListener('change', function () { dirty.routing = true; });
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
        var row = closestAct(button, 'tr');
        if (!row) return;
        probe(str(row.getAttribute('data-provider')), str(row.getAttribute('data-model')), button);
      }
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

  function init() {
    providersBody = document.getElementById('providers-body');
    routingBody = document.getElementById('routing-body');
    liveBody = document.getElementById('live-body');
    recentBody = document.getElementById('recent-body');
    statsBody = document.getElementById('stats-body');
    applyStatic();
    renderHeader();
    renderProviders();
    renderRouting();
    renderLive();
    renderRecent();
    renderStats();
    renderServer();
    initHeader();
    initProviders();
    initRouting();
    initLive();
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

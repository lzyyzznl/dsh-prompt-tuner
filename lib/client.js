/**
 * dsh-prompt-tuner — browser half.
 *
 * Three registrations, no panel of its own:
 *   1. `conversation.input.left` — one compact ✨ button in the composer tool
 *      row, at the right of the permission selector. Alt+O triggers it.
 *   2. `conversation.input.dock` — the review card above the composer: the
 *      rewrite streams in there, next to the draft it replaces, with the model's
 *      assumptions, the timings, the style switch and 采用 / 撤销 / 再改一次.
 *   3. `settings.section` — the 「提示词优化」 page: which model rewrites (or the
 *      session's own), how much reasoning it may spend, the rewrite style, when
 *      an answer is applied, and the optimization prompt itself.
 *
 * The draft is read from the slot's `useInput` selector and written back through
 * `inputActions.setDraft`, so the plugin never touches the editor's DOM and the
 * host keeps ownership of the draft, undo history, and submission. The draft
 * revision is read too: an answer is applied automatically only while the draft
 * still is the text that was sent, otherwise it waits in the review card —
 * typing during a rewrite can therefore never be overwritten silently.
 *
 * All model work happens in this package's host half under
 * `/dsh-prompt-optimizer/*`; the browser holds no credentials and never talks to
 * a provider.
 *
 * Bundle format: a `window.__ModuleLoader__.load` registration (the same shape
 * the deployment's client build emits), authored directly in plain JavaScript
 * — no JSX, no imports, React from the browser module table.
 *
 * Every host surface this half depends on is read through a tolerant accessor
 * and feature-detected at the point of use: a renamed or absent capability must
 * disable one affordance with a visible reason, never throw during render and
 * never silently do the wrong thing.
 */
window.__ModuleLoader__.load({
  id: 'dsh-prompt-tuner',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** Composer seat: compact controls at the left of the tool row, after the permission selector. */
    const COMPOSER_SLOT = 'conversation.input.left'
    /** Review seat: full-width entries rendered above the composer card. */
    const DOCK_SLOT = 'conversation.input.dock'
    /** Settings seat: one page in the settings panel. */
    const SETTINGS_SLOT = 'settings.section'
    /** Registration id / CSS prefix; also the settings page key. */
    const ID = 'prompt-optimizer'
    /** Host route prefix, document-relative (the GUI may be served under a sub-path). */
    const ROUTE = 'dsh-prompt-optimizer/'
    /** Order inside the composer tool row. */
    const COMPOSER_ORDER = 90
    /** Order inside the composer dock (above the composer card). */
    const DOCK_ORDER = 90
    /** Order of the settings page in the navigation list. */
    const SETTINGS_ORDER = 60
    /** How many in-flight deltas one second of streaming may draw. */
    const DELTA_FRAME_MS = 80

    /* ───────────────────────── copy (zh / en) ───────────────────────── */

    /**
     * Every visible string, in the two locales the harness ships. Keys are flat
     * and `{name}` placeholders are substituted by {@link translate}; the active
     * locale comes from `ctx.locale`, so the plugin follows the shell's language
     * instead of pinning one.
     */
    const DICT = {
      zh: {
        optimize: '✨ 优化提示词',
        optimizing: '优化中',
        stop: '停止',
        stopped: '已取消',
        undo: '撤销',
        restored: '已撤销，恢复原文',
        empty: '输入框是空的：先写点内容再优化',
        busy: '输入框正忙（提交中），稍后再试',
        noModel: '没有可用的模型：请到「设置 → 提示词优化」里选一个',
        chips: '草稿里有 {n} 个引用芯片（@文件 / 命令）：整稿改写会丢失它们，请先移除引用再优化',
        shortcutHint: '快捷键 Alt+O',
        templated: '已写入打磨模板：直接发送，由当前会话的 agent 带着全部上下文改写',
        panelTitle: '改写预览',
        panelTitleApplied: '已应用改写',
        panelTitleError: '改写未完成',
        panelRunning: '正在生成…',
        panelWaiting: '已完成，等待你确认',
        panelStale: '你在优化期间改了草稿，所以没有自动替换——确认后再采用',
        source: '原文',
        result: '改写后',
        apply: '采用',
        discard: '放弃',
        again: '再改一次',
        close: '关闭',
        assumptions: '模型标注的待确认',
        timings: '首字 {first} · 共 {total} · {from} → {to} 字',
        styleLabel: '档位',
        styleStandard: '标准',
        styleSlim: '精简',
        styleStructured: '结构化',
        styleExpand: '扩写',
        // settings page
        settingsNav: '提示词优化',
        settingsTitle: '提示词优化',
        settingsIntro: '输入框旁的 ✨ 用这里选定的模型，把草稿改写为指向更明确的提示词；默认跟随当前会话模型，零配置可用。',
        groupModel: '模型',
        groupRewrite: '改写行为',
        groupPrompt: '提示词',
        notes: '说明',
        modelLabel: '优化模型',
        modelHint: '只列出当前已配置的模型路由；调用发生在宿主进程，浏览器不接触凭据。',
        activeModel: '当前：{provider} · {model}',
        followSession: '跟随当前会话的模型（推荐）',
        followSessionHint: '关闭后可在这里指定一个专用模型；指定后自动关闭跟随。',
        followSessionHintShort: '关闭后可在下方指定专用模型',
        noModels: '还没有可用的模型：先到「设置 → 模型」里添加一个 provider。',
        effortLabel: '思考强度',
        effortHint:
          '关闭（off）最快，适合改写任务；high / max 会让模型先长时间推理，但这些推理内容不会出现在结果里，因此只换来看起来更慢。',
        effortAuto: '跟随适配器默认（auto）',
        effortOff: '关闭（off）— 最快',
        effortLow: '低（low）— 少量推理',
        effortHigh: '高（high）— 适配器默认值',
        effortMax: '最高（max）— 最慢',
        effortAdvertised: '当前路由支持：{list}',
        effortAdvertisedDefault: '当前路由支持：{list}（适配器默认 {fallback}）',
        effortUnknown: '当前路由未声明可选强度，将直接尝试所选值。',
        effortDegraded: '当前路由不支持所选强度，已改用 {value}。',
        styleLabelSetting: '默认档位',
        styleHint: '档位只追加一条风格指令，不会覆盖你的自定义提示词；在预览面板里也可以临时切换。',
        styleHintShort: '预览面板里可逐次切换',
        applyModeLabel: '改写完成后',
        applyModeHint: '自动替换只在你没有继续改动草稿时发生；否则结果会停在预览面板等你确认。',
        applyModeHintShort: '草稿被改动过时不自动替换',
        applyAuto: '直接替换（可撤销）',
        applyReview: '先在预览面板确认',
        routeLabel: '改写方式',
        routeHint:
          '「交给主 agent」不调用任何模型：它把一段打磨模板写进输入框，由当前会话的 agent 带着全部上下文改写。',
        routeHintShort: '交给主 agent 时不调用模型',
        routePlugin: '插件直接改写（调用模型，快）',
        routeAgent: '交给主 agent（零模型调用，上下文最全）',
        shortcutLabel: '快捷键',
        shortcutToggle: '启用 Alt+O 触发优化',
        promptLabel: '自定义优化提示词',
        promptHint:
          '作为系统提示发给上面的模型。留空即使用内置默认；文本框只保存你的自定义内容，不会自动填入默认，避免误存。',
        promptHintShort: '留空 = 内置默认；只保存你自己的内容',
        promptPlaceholder: '留空 = 使用内置默认提示词。点「填入内置默认」可基于默认修改。',
        save: '保存',
        saved: '已保存',
        resetDefault: '恢复默认',
        restoredDefault: '已恢复内置默认提示词',
        fillDefault: '填入内置默认',
        discardChanges: '放弃改动',
        refreshModels: '刷新模型列表',
        showDefault: '查看内置默认提示词',
        charCount: '{n} / {max} 字',
        configFile: '配置文件',
        refreshing: '正在读取模型列表…',
        unsaved: '有未保存的改动',
        customInUse: '当前使用：自定义提示词',
        builtinInUse: '当前使用：内置默认提示词',
      },
      en: {
        optimize: '✨ Optimize prompt',
        optimizing: 'Optimizing',
        stop: 'Stop',
        stopped: 'Cancelled',
        undo: 'Undo',
        restored: 'Undone — original restored',
        empty: 'The composer is empty — write something first',
        busy: 'The composer is busy (submitting) — try again in a moment',
        noModel: 'No model available: pick one under Settings → Prompt optimization',
        chips: 'The draft holds {n} reference chip(s) (@file / command): a whole-draft rewrite would drop them — remove the references first',
        shortcutHint: 'Shortcut: Alt+O',
        templated: 'Polish template written in: send it as is and the session agent rewrites it with the full context',
        panelTitle: 'Rewrite preview',
        panelTitleApplied: 'Rewrite applied',
        panelTitleError: 'Rewrite did not finish',
        panelRunning: 'Generating…',
        panelWaiting: 'Ready — waiting for you',
        panelStale: 'You edited the draft while it ran, so nothing was replaced — confirm to apply',
        source: 'Original',
        result: 'Rewritten',
        apply: 'Apply',
        discard: 'Discard',
        again: 'Rewrite again',
        close: 'Close',
        assumptions: 'Open items the model flagged',
        timings: 'first token {first} · {total} total · {from} → {to} chars',
        styleLabel: 'Style',
        styleStandard: 'Standard',
        styleSlim: 'Slim',
        styleStructured: 'Structured',
        styleExpand: 'Expand',
        settingsNav: 'Prompt optimization',
        settingsTitle: 'Prompt optimization',
        settingsIntro:
          'The ✨ button beside the composer rewrites your draft into a clearly-directed prompt through the model chosen here; it follows the session model by default, so it works with no configuration.',
        groupModel: 'Model',
        groupRewrite: 'Rewrite',
        groupPrompt: 'Prompt',
        notes: 'Details',
        modelLabel: 'Optimization model',
        modelHint: 'Only models you have configured are listed; the call happens in the host process and the browser never sees credentials.',
        activeModel: 'In use: {provider} · {model}',
        followSession: 'Follow the current session model (recommended)',
        followSessionHint: 'Turn this off to pin a dedicated model below. Picking one switches it off automatically.',
        followSessionHintShort: 'Turn this off to pin the model below',
        noModels: 'No model yet: add a provider under Settings → Models first.',
        effortLabel: 'Reasoning effort',
        effortHint:
          'off is fastest and fits a rewrite; high / max make the model think for a long time first, and those tokens never appear in the result — so they only buy a slower answer.',
        effortAuto: 'Adapter default (auto)',
        effortOff: 'off — fastest',
        effortLow: 'low — some reasoning',
        effortHigh: 'high — adapter default',
        effortMax: 'max — slowest',
        effortAdvertised: 'This route supports: {list}',
        effortAdvertisedDefault: 'This route supports: {list} (adapter default {fallback})',
        effortUnknown: 'This route does not advertise efforts; the chosen value is sent as is.',
        effortDegraded: 'This route does not support the chosen effort; {value} was used instead.',
        styleLabelSetting: 'Default style',
        styleHint: 'A style only appends one directive — it never replaces your custom prompt. The preview card can switch it per run.',
        styleHintShort: 'Switchable per run in the preview card',
        applyModeLabel: 'When a rewrite finishes',
        applyModeHint: 'Automatic replacement only happens while the draft still is the text that was sent; otherwise the result waits in the preview card.',
        applyModeHintShort: 'Skipped when the draft was edited',
        applyAuto: 'Replace in place (undoable)',
        applyReview: 'Wait for confirmation in the preview card',
        routeLabel: 'Rewrite route',
        routeHint:
          '"Session agent" calls no model at all: it writes a polish template into the composer and the session agent rewrites it with the whole conversation in hand.',
        routeHintShort: 'The session-agent route calls no model',
        routePlugin: 'This plugin calls a model (fast)',
        routeAgent: 'Session agent (no model call, full context)',
        shortcutLabel: 'Shortcut',
        shortcutToggle: 'Alt+O triggers a rewrite',
        promptLabel: 'Custom optimization prompt',
        promptHint:
          'Sent as the system prompt. Empty means the built-in default; the box only ever holds your own text, so the default is never saved by accident.',
        promptHintShort: 'Empty = built-in default; only your own text is saved',
        promptPlaceholder: 'Empty = built-in default. Use "Fill in the default" to edit from it.',
        save: 'Save',
        saved: 'Saved',
        resetDefault: 'Reset to default',
        restoredDefault: 'Built-in default restored',
        fillDefault: 'Fill in the default',
        discardChanges: 'Discard changes',
        refreshModels: 'Refresh model list',
        showDefault: 'Show the built-in default prompt',
        charCount: '{n} / {max} chars',
        configFile: 'Config file',
        refreshing: 'Reading the model list…',
        unsaved: 'Unsaved changes',
        customInUse: 'In use: custom prompt',
        builtinInUse: 'In use: built-in default prompt',
      },
    }

    /** Substitute `{name}` placeholders in one template string. */
    function format(template, params) {
      if (params === undefined) return template
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (key in params ? String(params[key]) : match))
    }

    /* ───────────────────────── locale ───────────────────────── */

    /** Active locale id; `zh` until the shell says otherwise. */
    let locale = 'zh'
    const localeListeners = new Set()

    /** Read the shell's active locale through a tolerant accessor. */
    function readLocale(ctx) {
      try {
        const snapshot = ctx?.locale?.getLocale?.() ?? ctx?.locale?.getSnapshot?.()
        const active = typeof snapshot?.active === 'string' ? snapshot.active : ''
        if (active !== '') return active.startsWith('en') ? 'en' : 'zh'
      } catch {
        /* an unavailable locale service means the default language */
      }
      return 'zh'
    }

    /** Publish one locale change to every mounted component. */
    function publishLocale(next) {
      if (next === locale) return
      locale = next
      for (const listener of [...localeListeners]) listener()
    }

    /** Subscribe to the shared settings store and make sure it is loaded. */
    function useText() {
      const [, bump] = useState(0)
      useEffect(() => {
        const listener = () => bump((value) => value + 1)
        localeListeners.add(listener)
        return () => localeListeners.delete(listener)
      }, [])
      return useMemo(() => {
        const table = DICT[locale] ?? DICT.zh
        return (key, params) => format(table[key] ?? DICT.zh[key] ?? key, params)
      }, [locale])
    }

    /* ───────────────────────── host API ───────────────────────── */

    /**
     * POST one JSON payload to this package's host routes and decode the
     * `{ok, value|error}` envelope. Never throws: a transport fault becomes a
     * typed failure the UI can show.
     * @param {string} action - route tail after the prefix (e.g. `state`).
     * @param {object} payload - JSON body.
     * @param {AbortSignal} [signal] - optional cancellation (used by 停止).
     * @returns {Promise<{ok: true, value: any} | {ok: false, error: {code: string, message: string}, timings?: object}>} the envelope.
     */
    async function post(action, payload, signal) {
      let response
      try {
        response = await fetch(ROUTE + action, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
          signal,
        })
      } catch (cause) {
        if (signal !== undefined && signal.aborted) {
          return { ok: false, error: { code: 'aborted', message: 'stopped' } }
        }
        return { ok: false, error: { code: 'transport', message: 'host route unreachable (is the plugin loaded?)' } }
      }
      try {
        const envelope = await response.json()
        if (typeof envelope !== 'object' || envelope === null) {
          return { ok: false, error: { code: 'transport', message: 'response is not a JSON envelope' } }
        }
        if (envelope.ok === true) return { ok: true, value: envelope.value }
        const error = envelope.error ?? {}
        return {
          ok: false,
          error: { code: String(error.code ?? 'internal'), message: String(error.message ?? 'unknown error') },
          timings: envelope.timings,
        }
      } catch {
        return { ok: false, error: { code: 'transport', message: 'could not parse the response' } }
      }
    }

    /**
     * POST one rewrite and consume its server-sent-event stream.
     *
     * The stream is a display channel only: the text it carries is the same text
     * the `done` frame delivers, so a reader that misses frames still ends with
     * the authoritative answer. A transport that cannot stream (or an older host
     * half without the route) falls back to the plain JSON route.
     * @param {object} body - the optimize request.
     * @param {AbortSignal} signal - cancellation.
     * @param {(text: string) => void} onDelta - called with the accumulated text.
     * @param {number} [retryDelayMs] - frame throttle for the delta callback.
     * @returns {Promise<{ok: boolean, value?: object, error?: object, timings?: object, streamed: boolean}>} the outcome.
     */
    async function runStream(body, signal, onDelta) {
      let response
      try {
        response = await fetch(`${ROUTE}optimize.stream`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        })
      } catch {
        return signal.aborted
          ? { ok: false, error: { code: 'aborted', message: 'stopped' }, streamed: true }
          : streamOrFallback(body, signal, onDelta)
      }
      if (!response.ok || response.body === null || typeof response.body.getReader !== 'function') {
        return streamOrFallback(body, signal, onDelta)
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let lastPaint = 0
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done === true) break
          buffer += decoder.decode(value, { stream: true })
          let boundary = buffer.indexOf('\n\n')
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const event = /^event:\s*(.+)$/m.exec(frame)?.[1]?.trim() ?? ''
            const payloadText = frame
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim())
              .join('')
            if (payloadText !== '') {
              let payload = null
              try {
                payload = JSON.parse(payloadText)
              } catch {
                payload = null
              }
              if (payload !== null) {
                if (event === 'delta' && typeof payload.text === 'string') {
                  const now = Date.now()
                  if (payload.final === true || now - lastPaint >= DELTA_FRAME_MS) {
                    lastPaint = now
                    onDelta(payload.text)
                  }
                } else if (event === 'done') {
                  // Terminal frames carry the same `{ok, value|error}` envelope the
                  // JSON route writes, so both transports decode identically.
                  return { ok: true, value: payload.value ?? payload, streamed: true }
                } else if (event === 'failed') {
                  return { ok: false, error: payload.error, timings: payload.timings, streamed: true }
                }
              }
            }
            boundary = buffer.indexOf('\n\n')
          }
        }
      } catch {
        if (signal.aborted) return { ok: false, error: { code: 'aborted', message: 'stopped' }, streamed: true }
      }
      return { ok: false, error: { code: 'transport', message: 'the rewrite stream ended unexpectedly' }, streamed: true }
    }

    /**
     * Fallback used when the streaming route is missing: the plain JSON rewrite,
     * reported as one final delta so callers need no second code path.
     */
    async function streamOrFallback(body, signal, onDelta) {
      const result = await post('optimize', body, signal)
      if (result.ok === true) onDelta(result.value.text)
      return { ...result, streamed: false }
    }

    /* ───────────────────────── shared settings store ───────────────────────── */

    /**
     * The `/state` view shared by the composer button, the review card and the
     * settings page, so three components never race independent copies of the
     * same facts and a save made in one is visible to the others immediately.
     */
    const settingsStore = (() => {
      let snapshot = { state: null, error: null, loading: false, saving: false, rev: 0 }
      const listeners = new Set()
      let inflight = null

      const publish = (patch) => {
        snapshot = { ...snapshot, ...patch, rev: snapshot.rev + 1 }
        for (const listener of [...listeners]) listener()
      }

      const load = (force) => {
        if (inflight !== null && force !== true) return inflight
        publish({ loading: true })
        inflight = post('state', force === true ? { refresh: true } : {})
          .then((result) => {
            if (result.ok) publish({ state: result.value, error: null, loading: false })
            else publish({ error: result.error.message, loading: false })
          })
          .finally(() => {
            inflight = null
          })
        return inflight
      }

      const save = async (patch) => {
        publish({ saving: true })
        const result = await post('save', patch)
        if (result.ok) publish({ state: result.value, error: null, saving: false })
        else publish({ error: result.error.message, saving: false })
        return result
      }

      return {
        get: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        load,
        save,
      }
    })()

    /** Subscribe to the shared settings store and make sure it has been loaded once. */
    function useSharedState() {
      const [snapshot, setSnapshot] = useState(settingsStore.get)
      useEffect(() => settingsStore.subscribe(() => setSnapshot(settingsStore.get())), [])
      useEffect(() => {
        if (settingsStore.get().state === null) void settingsStore.load(false)
      }, [])
      return snapshot
    }

    /* ───────────────────────── per-session rewrite state ───────────────────────── */

    /**
     * One rewrite's lifecycle, kept per session.
     *
     * The button and the review card are separate slot occupants, so they share
     * this module-level map rather than React state. Keying by session is what
     * keeps two conversations from overwriting each other's card — the defect
     * every single-controller competitor shipped.
     */
    const sessions = new Map()
    const sessionListeners = new Set()
    /** Anchors a session key when the slot does not hand us a sessionId. */
    const anchors = new WeakMap()
    let anchorSeq = 0

    /** @type {{phase: string, rev: number, source: string, sourceRev: number, text: string, error: object|null, meta: object|null, assumptions: string|null, undoText: string|null, appliedText: string|null, stale: boolean, style: string|null, startedAt: number, firstTextMs: number, totalMs: number}} */
    const IDLE = Object.freeze({
      phase: 'idle',
      rev: 0,
      source: '',
      sourceRev: -1,
      text: '',
      error: null,
      meta: null,
      assumptions: null,
      undoText: null,
      appliedText: null,
      stale: false,
      style: null,
      startedAt: 0,
      firstTextMs: -1,
      totalMs: 0,
    })

    /** A stable key for one slot instance: the session id, else a WeakMap anchor. */
    function sessionKey(props) {
      if (typeof props?.sessionId === 'string' && props.sessionId !== '') return props.sessionId
      const anchor = props?.inputActions ?? props?.useInput ?? props
      if (anchor === null || typeof anchor !== 'object') return 'anonymous'
      let key = anchors.get(anchor)
      if (key === undefined) {
        anchorSeq += 1
        key = `anonymous-${anchorSeq}`
        anchors.set(anchor, key)
      }
      return key
    }

    /** Current state of one session's rewrite. */
    function readSession(key) {
      return sessions.get(key) ?? IDLE
    }

    /** Merge one patch into a session's rewrite state and wake the components. */
    function patchSession(key, patch) {
      const current = readSession(key)
      const next = { ...current, ...patch, rev: current.rev + 1 }
      sessions.set(key, next)
      for (const listener of [...sessionListeners]) listener()
      return next
    }

    /** Drop one session's card entirely (after 关闭). */
    function clearSession(key) {
      if (!sessions.has(key)) return
      sessions.delete(key)
      for (const listener of [...sessionListeners]) listener()
    }

    /** Subscribe to the shared per-session rewrite state. */
    function useSessionState(key) {
      const [state, setState] = useState(() => readSession(key))
      useEffect(() => {
        const listener = () => setState(readSession(key))
        sessionListeners.add(listener)
        setState(readSession(key))
        return () => sessionListeners.delete(listener)
      }, [key])
      return state
    }

    /* ───────────────────────── styles ───────────────────────── */

    /**
     * Theme-token-only stylesheet, split in three: `dspo-` for the compact
     * composer control (its metrics mirror the composer's own `.select` control
     * — 28px tall, 13px/500 label), `dspo-card-` for the review card, and
     * `dspo-set-` for the settings page.
     */
    const CSS = `
/* ── composer control ── */
.dspo-inline { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.dspo-btn {
  display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 8px;
  border: none; border-radius: 999px; background: transparent;
  color: var(--dsw-alias-label-secondary); font-family: var(--dsw-font-family, inherit);
  font-size: 13px; font-weight: 500; line-height: 20px; white-space: nowrap; cursor: pointer;
}
.dspo-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dspo-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dspo-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.dspo-btn[data-busy='true'] { color: var(--dsw-alias-brand-primary); }
.dspo-btn[data-stop='true'] { color: var(--dsw-alias-state-error-primary); }
.dspo-status { font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dspo-status[data-tone='error'] { color: var(--dsw-alias-state-error-primary); }
.dspo-status[data-tone='ok'] { color: var(--dsw-alias-state-success-primary); }
.dspo-undo {
  border: none; background: transparent; padding: 0 2px; cursor: pointer;
  color: var(--dsw-alias-brand-primary); font-family: inherit; font-size: 12px; text-decoration: underline;
}
/* ── review card (composer dock) ── */
.dspo-card {
  /* The card sits right above the composer, so it borrows the composer's own
     width token instead of filling whatever the dock hands it: the two edges
     line up. --dsh-composer-card-max-width is the value the shell uses for both
     the composer card and its own dock entries. */
  box-sizing: border-box; width: 100%; max-width: var(--dsh-composer-card-max-width, 848px);
  margin: 0 auto 8px; padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family, inherit); font-size: 12px; line-height: 1.6;
}
.dspo-card-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.dspo-card-title { font-size: 13px; font-weight: 600; }
.dspo-card-meta { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dspo-card-spacer { flex: 1 1 auto; }
.dspo-chip {
  height: 24px; padding: 0 8px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-secondary); font-family: inherit; font-size: 11px;
}
.dspo-chip:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dspo-chip[data-active='true'] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); font-weight: 600; }
.dspo-chip:disabled { opacity: 0.45; cursor: not-allowed; }
.dspo-panes { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
@media (max-width: 720px) { .dspo-panes { grid-template-columns: 1fr; } }
.dspo-pane { min-width: 0; }
.dspo-pane-label { color: var(--dsw-alias-label-secondary); font-size: 11px; margin-bottom: 2px; }
.dspo-pane-body {
  margin: 0; max-height: 200px; overflow: auto; white-space: pre-wrap; word-break: break-word;
  padding: 8px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base); font-family: var(--dsw-font-family-mono, ui-monospace, monospace);
  font-size: 11.5px; line-height: 1.55;
}
.dspo-pane-body[data-tone='result'] { border-color: var(--dsw-alias-brand-primary); }
.dspo-assume { margin-top: 8px; color: var(--dsw-alias-state-warn-primary); font-size: 11.5px; }
.dspo-card-error { margin: 4px 0 8px; color: var(--dsw-alias-state-error-primary); }
.dspo-card-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.dspo-card-hint { color: var(--dsw-alias-label-secondary); font-size: 11px; }
/* ── settings page ── */
.dspo-set {
  display: flex; flex-direction: column; gap: 22px;
  max-width: 620px; font-size: 13px; color: var(--dsw-alias-label-primary);
}
.dspo-set-head { display: flex; flex-direction: column; gap: 4px; }
.dspo-set-title { font-size: 15px; font-weight: 600; margin: 0; }
.dspo-set-intro { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.6; margin: 0; }
.dspo-set-group { display: flex; flex-direction: column; }
.dspo-set-group-title {
  padding-bottom: 6px; border-bottom: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 600; letter-spacing: 0.02em;
}
.dspo-set-row {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center;
  gap: 4px 16px; padding: 10px 0;
}
.dspo-set-row[data-stack='true'] { grid-template-columns: minmax(0, 1fr); gap: 8px; }
.dspo-set-row + .dspo-set-row { border-top: 1px solid var(--dsw-alias-border-l1); }
@media (max-width: 560px) { .dspo-set-row { grid-template-columns: minmax(0, 1fr); gap: 6px; } }
.dspo-set-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dspo-set-line { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.dspo-set-label { font-weight: 600; }
.dspo-set-hint { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.5; }
.dspo-set-status { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dspo-set-warn { color: var(--dsw-alias-state-warn-primary); font-size: 12px; line-height: 1.5; }
.dspo-set-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.dspo-set-row[data-stack='true'] > .dspo-set-controls { align-items: stretch; }
.dspo-select {
  height: 30px; max-width: 260px; padding: 0 8px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 13px; cursor: pointer;
}
.dspo-set-row[data-stack='true'] .dspo-select { max-width: 190px; }
.dspo-check-input { width: 15px; height: 15px; margin: 0; cursor: pointer; accent-color: var(--dsw-alias-brand-primary); }
.dspo-select:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dspo-select:disabled { opacity: 0.5; cursor: not-allowed; }
.dspo-action {
  height: 30px; padding: 0 12px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 13px;
}
.dspo-action:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
.dspo-action:disabled { opacity: 0.45; cursor: not-allowed; }
.dspo-action[data-kind='primary'] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); font-weight: 600; }
.dspo-action[data-kind='primary']:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); border-color: var(--dsw-alias-brand-primary); }
.dspo-textarea {
  width: 100%; box-sizing: border-box; min-height: 150px; resize: vertical; padding: 10px;
  border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family, inherit);
  font-size: 12px; line-height: 1.6;
}
.dspo-textarea:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dspo-textarea::placeholder { color: var(--dsw-alias-state-idle-primary); }
.dspo-meta {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary); font-size: 12px;
}
.dspo-set-ok { color: var(--dsw-alias-state-success-primary); font-size: 12px; }
.dspo-set-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.dspo-set-notes { padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dspo-set-notes > summary { cursor: pointer; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dspo-set-note { margin-top: 6px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.6; }
.dspo-set-note-key { margin-right: 4px; color: var(--dsw-alias-label-primary); font-weight: 600; }
.dspo-details { padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dspo-details summary { cursor: pointer; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dspo-pre {
  margin: 8px 0 0; max-height: 280px; overflow: auto; white-space: pre-wrap; word-break: break-word;
  font-family: var(--dsw-font-family-mono, ui-monospace, monospace); font-size: 11px; line-height: 1.55;
  color: var(--dsw-alias-label-secondary);
}
.dspo-path { font-family: var(--dsw-font-family-mono, ui-monospace, monospace); font-size: 11px; word-break: break-all; color: var(--dsw-alias-state-idle-primary); }
`

    /**
     * Install the stylesheet once, owned by the plugin fiber. Returns the
     * disposer that removes the element again on unload/hot-reload.
     * @returns {() => void} cleanup.
     */
    function installStyles() {
      const existing = document.querySelector(`style[data-plugin="${ID}"]`)
      if (existing !== null) existing.remove()
      const element = document.createElement('style')
      element.setAttribute('data-plugin', ID)
      element.textContent = CSS
      document.head.appendChild(element)
      return () => {
        element.remove()
      }
    }

    /* ───────────────────────── the rewrite, as one shared action ───────────────────────── */

    /** In-flight abort controller per session, so 停止 and a session switch reach the model call. */
    const inflight = new Map()

    /**
     * Run one rewrite for one session and drive its state machine.
     *
     * The state machine is the whole design: `running` streams into the card,
     * and the answer is applied in place **only** when the draft still is what
     * was sent (revision-compared), otherwise the card stops at `review`. That
     * single rule is what makes "keep typing while it thinks" safe.
     * @param {object} input - session key, text, actions, style override and the settings snapshot.
     * @returns {Promise<void>} resolves when the run settles.
     */
    async function runRewrite(input) {
      const { key, text, draftRev, actions, style, state } = input
      if (text.trim() === '') {
        patchSession(key, { phase: 'error', error: { code: 'empty-draft', message: 'empty' } })
        return
      }
      const activeStyle = style ?? state?.settings?.style ?? 'standard'
      const controller = new AbortController()
      inflight.get(key)?.abort()
      inflight.set(key, controller)
      const startedAt = Date.now()
      patchSession(key, {
        phase: 'running',
        source: text,
        sourceRev: draftRev,
        text: '',
        error: null,
        meta: null,
        assumptions: null,
        undoText: null,
        appliedText: null,
        stale: false,
        style: activeStyle,
        startedAt,
        firstTextMs: -1,
        totalMs: 0,
      })
      const result = await runStream(
        { text, style: activeStyle },
        controller.signal,
        (streamed) => patchSession(key, { text: streamed }),
      )
      if (inflight.get(key) === controller) inflight.delete(key)
      if (result.ok !== true) {
        const code = result.error?.code ?? 'internal'
        patchSession(key, {
          phase: code === 'cancelled' || code === 'aborted' ? 'idle' : 'error',
          error: code === 'aborted' ? { code: 'cancelled', message: 'stopped' } : result.error,
          totalMs: Date.now() - startedAt,
        })
        return
      }
      const value = result.value
      const currentDraft = input.readDraft()
      const untouched = currentDraft === text
      const settled = patchSession(key, {
        text: value.text,
        meta: value,
        assumptions: value.assumptions ?? null,
        totalMs: (value.timings?.totalMs ?? Date.now() - startedAt),
        firstTextMs: value.timings?.firstTextMs ?? -1,
        stale: untouched === false,
      })
      const applyNow = untouched
        && (state?.settings?.applyMode ?? 'auto') === 'auto'
      if (applyNow) {
        actions?.setDraft?.(value.text)
        patchSession(key, { phase: 'applied', undoText: text, appliedText: value.text })
      } else {
        patchSession(key, { phase: 'review', undoText: null, appliedText: null })
      }
      return settled
    }

    /* ───────────────────────── composer control ───────────────────────── */

    /**
     * The composer tool-row button, and the keyboard shortcut that mirrors it.
     * @param {object} props - slot props (standard session props from the composer zone).
     * @returns {import('react').ReactElement} one button plus its transient status.
     */
    function OptimizeButton(props) {
      const t = useText()
      const snapshot = useSharedState()
      const useInput = typeof props.useInput === 'function' ? props.useInput : () => ({ draft: '', phase: 'plain' })
      const draft = useInput((state) => state.draft) ?? ''
      const phase = useInput((state) => state.phase) ?? 'plain'
      // `occurrences` is the editor's own view of its reference chips: a chip is a
      // node, not text, so a whole-draft replacement would silently drop it.
      const occurrences = useInput((state) => state.occurrences)
      const draftRev = useInput((state) => state.draftRev)
      const key = sessionKey(props)
      const session = useSessionState(key)
      const actions = props.inputActions

      const [elapsed, setElapsed] = useState(0)
      const [notice, setNotice] = useState(null)
      const draftRef = useRef(draft)
      draftRef.current = draft

      const busy = session.phase === 'running'
      const active = snapshot.state?.active ?? null
      const locked = phase !== 'plain'
      const chipCount = Array.isArray(occurrences) ? occurrences.length : 0
      const agentRoute = (snapshot.state?.settings?.route ?? 'plugin') === 'agent'
      const canOptimize = !busy && !locked && draft.trim() !== ''
        && (agentRoute || (active !== null && chipCount === 0))

      /** Visible progress: the wait is model time, so show it ticking rather than spinning silently. */
      useEffect(() => {
        if (!busy) return undefined
        const startedAt = session.startedAt || Date.now()
        setElapsed(Date.now() - startedAt)
        const timer = setInterval(() => setElapsed(Date.now() - startedAt), 200)
        return () => clearInterval(timer)
      }, [busy, session.startedAt])

      /** A transient notice belongs to one draft revision; editing clears it. */
      useEffect(() => {
        if (notice !== null && draft !== session.appliedText && draft !== session.undoText) setNotice(null)
      }, [draft, notice, session.appliedText, session.undoText])

      /** Leaving the composer must not leave the model running. */
      useEffect(() => () => {
        inflight.get(key)?.abort()
      }, [key])

      const start = useCallback(() => {
        if (!canOptimize) return
        if (agentRoute) {
          // Zero-model-call route: write the polish template in and let the
          // session's own agent rewrite it with the whole conversation in hand.
          const spec = snapshot.state?.agentTemplate ?? null
          if (spec === null || typeof spec.text !== 'string' || typeof spec.placeholder !== 'string') {
            setNotice(t('noModel'))
            return
          }
          // Splitting on the placeholder instead of using it as a replacement
          // pattern keeps a draft containing `$&` from corrupting the template.
          actions?.setDraft?.(spec.text.split(spec.placeholder).join(draft))
          patchSession(key, { phase: 'idle', undoText: draft, appliedText: null, error: null })
          setNotice(t('templated'))
          return
        }
        setNotice(null)
        void runRewrite({
          key,
          text: draft,
          draftRev: typeof draftRev === 'number' ? draftRev : -1,
          actions,
          style: null,
          state: snapshot.state,
          readDraft: () => draftRef.current,
        })
      }, [actions, agentRoute, canOptimize, draft, draftRev, key, snapshot.state, t])

      /** Cancel a running rewrite: the host aborts the model call on request close. */
      const stop = useCallback(() => {
        const controller = inflight.get(key)
        controller?.abort()
        patchSession(key, { phase: 'idle', error: null })
      }, [key])

      /** Alt+O, while the composer holds the caret. */
      useEffect(() => {
        if (snapshot.state?.settings?.shortcut === false) return undefined
        const onKeyDown = (event) => {
          if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
          if (String(event.key).toLowerCase() !== 'o') return
          const element = document.activeElement
          const tag = String(element?.tagName ?? '').toLowerCase()
          const editable = tag === 'textarea' || tag === 'input' || element?.isContentEditable === true
          if (!editable) return
          event.preventDefault()
          start()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [snapshot.state?.settings?.shortcut, start])

      const canUndo = session.phase === 'applied' && session.undoText !== null && draft === session.appliedText
      const undo = useCallback(() => {
        if (!canUndo) return
        actions?.setDraft?.(session.undoText)
        setNotice(t('restored'))
        clearSession(key)
      }, [actions, canUndo, key, session.undoText, t])

      const title = locked
        ? t('busy')
        : chipCount > 0
          ? t('chips', { n: chipCount })
          : active === null && !agentRoute
            ? t('noModel')
            : `${t('optimize')}（${active?.provider ?? ''} · ${active?.model ?? ''}）· ${t('shortcutHint')}`

      const status = notice !== null
        ? h(
            'span',
            { className: 'dspo-status', 'data-tone': 'ok' },
            notice,
            canUndo ? h('button', { type: 'button', className: 'dspo-undo', onClick: undo }, ` ${t('undo')}`) : null,
          )
        : session.phase === 'error'
          ? h('span', { className: 'dspo-status', 'data-tone': 'error', role: 'alert' }, session.error?.message ?? '')
          : session.phase === 'review'
            ? h('span', { className: 'dspo-status' }, t('panelWaiting'))
            // The host route itself never answered: disabling the button without a
            // word is exactly the silent failure this plugin exists to avoid.
            : snapshot.state === null && snapshot.error !== null
              ? h('span', { className: 'dspo-status', 'data-tone': 'error', role: 'alert' }, snapshot.error)
              : null

      return h(
        'div',
        { className: 'dspo-inline', 'data-plugin': ID },
        h(
          'button',
          {
            type: 'button',
            className: 'dspo-btn',
            'data-busy': busy ? 'true' : undefined,
            disabled: busy || !canOptimize,
            onClick: start,
            title,
            'aria-busy': busy ? 'true' : undefined,
          },
          busy ? `${t('optimizing')} ${(elapsed / 1000).toFixed(1)}s` : t('optimize'),
        ),
        busy
          ? h(
              'button',
              { type: 'button', className: 'dspo-btn', 'data-stop': 'true', onClick: stop, title: t('stop') },
              t('stop'),
            )
          : null,
        status,
      )
    }

    /* ───────────────────────── review card (composer dock) ───────────────────────── */

    /** Milliseconds as a short seconds string. */
    const seconds = (ms) => (ms >= 0 ? `${(ms / 1000).toFixed(1)}s` : '—')

    /**
     * The review card above the composer: what was sent, what came back, what the
     * model flagged, and the three actions that decide what happens next.
     * @param {object} props - slot props of `conversation.input.dock`.
     * @returns {import('react').ReactElement|null} the card, or null when idle.
     */
    function TaskPanel(props) {
      const t = useText()
      const snapshot = useSharedState()
      const useInput = typeof props.useInput === 'function' ? props.useInput : () => ({ draft: '' })
      const draft = useInput((state) => state.draft) ?? ''
      // The composer's own submit machine: `claimed` while a slash command waits
      // for arguments, and anything else non-plain only while a claimed send is
      // in flight. An ordinary send never leaves `plain` — the shell dispatches
      // it as a detached flight and clears the composer through a `commit-draft`
      // effect instead — so the draft transition is needed as well.
      const phase = useInput((state) => state.phase) ?? 'plain'
      const key = sessionKey(props)
      const session = useSessionState(key)
      const actions = props.inputActions
      const draftRef = useRef(draft)
      const previousDraft = draftRef.current
      draftRef.current = draft

      /**
       * A sent message ends the card: its draft is gone, its result is moot.
       * Both send shapes are covered — a claimed command through the submit
       * machine, and an ordinary send, which empties the composer while the
       * machine stays `plain`.
       */
      useEffect(() => {
        if (session.phase === 'idle') return
        if (phase !== 'plain' && phase !== 'claimed') {
          clearSession(key)
          return
        }
        if (previousDraft.trim() !== '' && draft.trim() === '') clearSession(key)
      }, [draft, key, phase, session.phase])

      /**
       * Esc dismisses the card, the way the shell's own dismissable layers do:
       * one document-level `keydown` listener that exists only while the card
       * does, and that never calls `preventDefault`. The shell's own Escape
       * gestures — the `Esc Esc` stop chord, a dialog's cancel — therefore keep
       * working untouched; an event another layer already handled is left alone.
       */
      useEffect(() => {
        if (session.phase === 'idle') return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
          if (event.defaultPrevented === true) return
          clearSession(key)
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [key, session.phase])

      if (session.phase === 'idle') return null

      const running = session.phase === 'running'
      const applied = session.phase === 'applied'
      const failed = session.phase === 'error'
      const meta = session.meta
      const title = failed ? t('panelTitleError') : applied ? t('panelTitleApplied') : t('panelTitle')

      const apply = () => {
        if (typeof session.text !== 'string' || session.text === '') return
        actions?.setDraft?.(session.text)
        patchSession(key, { phase: 'applied', undoText: draftRef.current, appliedText: session.text, stale: false })
      }
      const discard = () => clearSession(key)
      const undo = () => {
        if (session.undoText === null) return
        actions?.setDraft?.(session.undoText)
        clearSession(key)
      }
      const again = () => {
        const source = typeof session.text === 'string' && session.text !== '' ? session.text : session.source
        void runRewrite({
          key,
          text: source,
          draftRev: -1,
          actions,
          style: session.style,
          state: snapshot.state,
          readDraft: () => draftRef.current,
        })
      }
      const setStyle = (next) => {
        void runRewrite({
          key,
          text: session.source,
          draftRev: -1,
          actions,
          style: next,
          state: snapshot.state,
          readDraft: () => draftRef.current,
        })
      }

      const styles = ['standard', 'slim', 'structured', 'expand']
      const styleChip = (id) => h(
        'button',
        {
          key: id,
          type: 'button',
          className: 'dspo-chip',
          'data-active': session.style === id ? 'true' : undefined,
          disabled: running,
          onClick: () => setStyle(id),
          title: `${t('styleLabel')}：${t(`style${id[0].toUpperCase()}${id.slice(1)}`)}`,
        },
        t(`style${id[0].toUpperCase()}${id.slice(1)}`),
      )

      const timing = meta === null
        ? running
          ? t('panelRunning')
          : ''
        : t('timings', {
            first: seconds(meta.timings?.firstTextMs ?? -1),
            total: seconds(meta.timings?.totalMs ?? session.totalMs),
            from: meta.originalChars,
            to: meta.optimizedChars,
          })

      return h(
        'div',
        { className: 'dspo-card', 'data-plugin': ID },
        h(
          'div',
          { className: 'dspo-card-head' },
          h('span', { className: 'dspo-card-title' }, title),
          h('span', { className: 'dspo-card-meta' }, timing),
          h('span', { className: 'dspo-card-spacer' }),
          styles.map(styleChip),
        ),
        session.stale === true
          ? h('div', { className: 'dspo-card-hint' }, t('panelStale'))
          : null,
        failed
          ? h('div', { className: 'dspo-card-error', role: 'alert' }, session.error?.message ?? '')
          : null,
        h(
          'div',
          { className: 'dspo-panes' },
          h(
            'div',
            { className: 'dspo-pane' },
            h('div', { className: 'dspo-pane-label' }, t('source')),
            h('pre', { className: 'dspo-pane-body' }, session.source),
          ),
          h(
            'div',
            { className: 'dspo-pane' },
            h('div', { className: 'dspo-pane-label' }, t('result')),
            h('pre', { className: 'dspo-pane-body', 'data-tone': 'result' }, session.text),
          ),
        ),
        session.assumptions !== null
          ? h('div', { className: 'dspo-assume' }, `${t('assumptions')}：${session.assumptions}`)
          : null,
        h(
          'div',
          { className: 'dspo-card-actions' },
          running
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dspo-action',
                  onClick: () => {
                    inflight.get(key)?.abort()
                    clearSession(key)
                  },
                },
                t('stop'),
              )
            : null,
          !running && !applied && !failed
            ? h('button', { type: 'button', className: 'dspo-action', 'data-kind': 'primary', onClick: apply }, t('apply'))
            : null,
          !running && applied
            ? h('button', { type: 'button', className: 'dspo-action', 'data-kind': 'primary', onClick: undo }, t('undo'))
            : null,
          !failed
            ? h('button', { type: 'button', className: 'dspo-action', onClick: again, disabled: running }, t('again'))
            : null,
          h('button', { type: 'button', className: 'dspo-action', onClick: discard }, t('close')),
          failed ? h('span', { className: 'dspo-card-hint' }, t('discard')) : null,
        ),
      )
    }

    /* ───────────────────────── settings page ───────────────────────── */

    /** Effort choice labels, in the order the adapter advertises them. */
    const effortLabel = (t, choice) => t(`effort${String(choice)[0].toUpperCase()}${String(choice).slice(1)}`)

    /**
     * One settings row: what the setting is, on the left (label plus a one-line
     * hint), its control on the right. The paragraph that used to sit under each
     * control now lives in the group's collapsed 说明 block, so a row stays two
     * lines tall instead of a paragraph.
     * @param {object} row - `id` (also the control's id), `label`, `hint`, `control` and `stack`.
     * @returns {import('react').ReactElement} the row.
     */
    function settingRow(row) {
      return h(
        'div',
        { className: 'dspo-set-row', 'data-stack': row.stack === true ? 'true' : undefined },
        h(
          'div',
          { className: 'dspo-set-text' },
          h('label', { className: 'dspo-set-label', htmlFor: row.id }, row.label),
          row.hint === null || row.hint === undefined ? null : h('div', { className: 'dspo-set-hint' }, row.hint),
        ),
        h('div', { className: 'dspo-set-controls' }, row.control),
      )
    }

    /**
     * One group's collapsed 「说明」: the long-form text that used to sit under
     * every control of that group, folded away but keyed by the setting it
     * explains — shortened on screen, never dropped.
     * @param {(key: string, params?: object) => string} t - the active-locale table.
     * @param {Array<{label: string, text: string}>} entries - one per setting.
     * @returns {import('react').ReactElement|null} the block, or null when empty.
     */
    function notesBlock(t, entries) {
      if (entries.length === 0) return null
      return h(
        'details',
        { className: 'dspo-set-notes' },
        h('summary', null, t('notes')),
        entries.map((entry) =>
          h(
            'div',
            { className: 'dspo-set-note', key: entry.label },
            h('span', { className: 'dspo-set-note-key' }, entry.label),
            entry.text,
          ),
        ),
      )
    }

    /**
     * The 「提示词优化」 settings page, in three groups — model and effort, rewrite
     * behaviour, prompt — each a list of label/control rows with the long-form
     * copy folded into one 说明 block per group. Every setting, its key and its
     * default are exactly what they were; only the presentation changed.
     * @param {object} props - settings section props (`close`) — unused here, the page stays open.
     * @returns {import('react').ReactElement} the page.
     */
    function SettingsPanel(props) {
      const t = useText()
      const snapshot = useSharedState()
      const state = snapshot.state
      const settings = state?.settings ?? null
      const models = state?.models ?? []
      const limits = state?.limits ?? { maxSystemPromptChars: 20_000 }
      const [draftPrompt, setDraftPrompt] = useState(null)
      const [feedback, setFeedback] = useState(null)

      const saved = settings?.systemPrompt ?? null
      /** `null` means "the textarea mirrors the saved value"; a string means the user typed. */
      const promptValue = draftPrompt ?? saved ?? ''
      const dirty = draftPrompt !== null && draftPrompt !== (saved ?? '')

      /** Cheap re-read on mount; the catalog itself is cached by the host. */
      useEffect(() => {
        void settingsStore.load(false)
      }, [])

      const groups = models.filter((group) => Array.isArray(group.models) && group.models.length > 0)
      const provider = settings?.provider ?? ''
      const activeModel = settings?.model ?? ''
      const providerGroup = groups.find((group) => group.id === provider) ?? groups[0]
      const followSession = settings?.followSessionModel !== false
      const effort = settings?.reasoningEffort ?? 'off'
      const advertised = state?.reasoning ?? null
      const choices = advertised === null ? state?.effortChoices ?? ['auto', 'off', 'low', 'high', 'max'] : advertised.efforts
      const effortDegraded = advertised !== null && !advertised.efforts.includes(effort) && effort !== 'auto'
        ? advertised.efforts.includes('off')
          ? 'off'
          : advertised.defaultEffort ?? advertised.efforts[0] ?? null
        : null

      const save = async (patch, ok) => {
        const result = await settingsStore.save(patch)
        if (result.ok) setFeedback({ tone: 'ok', text: ok ?? t('saved') })
        return result
      }

      /* ── 模型 · 强度 ── */
      const modelErrors = models
        .filter((group) => group.error != null)
        .map((group) => `${group.name ?? group.id}：${group.error}`)
        .join(' · ')

      const followRow = settingRow({
        id: 'dspo-follow',
        label: t('followSession'),
        hint: t('followSessionHintShort'),
        control: h('input', {
          type: 'checkbox',
          id: 'dspo-follow',
          className: 'dspo-check-input',
          checked: followSession,
          onChange: (event) => void save({ followSessionModel: event.target.checked }),
        }),
      })

      const modelRow = settingRow({
        id: 'dspo-model',
        stack: true,
        label: t('modelLabel'),
        hint: state?.active !== null && state?.active !== undefined
          ? t('activeModel', { provider: state.active.provider, model: state.active.model })
          : null,
        control: groups.length === 0
          ? h('div', { className: 'dspo-set-hint' }, snapshot.loading ? t('refreshing') : t('noModels'))
          : [
              h(
                'select',
                {
                  className: 'dspo-select',
                  id: 'dspo-provider',
                  'aria-label': 'provider',
                  disabled: followSession,
                  value: providerGroup?.id ?? '',
                  onChange: (event) => {
                    const group = groups.find((entry) => entry.id === event.target.value)
                    if (group === undefined) return
                    void save({ provider: group.id, model: group.models[0].id, followSessionModel: false }, t('saved'))
                  },
                },
                groups.map((group) => h('option', { key: group.id, value: group.id }, group.name ?? group.id)),
              ),
              h(
                'select',
                {
                  className: 'dspo-select',
                  id: 'dspo-model',
                  'aria-label': 'model',
                  disabled: followSession || providerGroup === undefined,
                  value: activeModel,
                  onChange: (event) => {
                    if (providerGroup === undefined) return
                    void save({ provider: providerGroup.id, model: event.target.value, followSessionModel: false }, t('saved'))
                  },
                },
                providerGroup?.models.map((model) =>
                  h('option', { key: model.id, value: model.id }, model.name ?? model.id),
                ) ?? null,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dspo-action',
                  disabled: snapshot.loading,
                  onClick: () => void settingsStore.load(true),
                },
                t('refreshModels'),
              ),
            ],
      })

      /** One label + select row; `id` is the control's id, so the label points at it. */
      const selectRow = (id, label, hint, value, options, onChange) => settingRow({
        id,
        label,
        hint,
        control: h(
          'select',
          {
            className: 'dspo-select',
            id,
            'aria-label': label,
            value,
            onChange: (event) => onChange(event.target.value),
          },
          options.map((option) =>
            h('option', { key: option.value, value: option.value }, option.label),
          ),
        ),
      })

      /** What the current route advertises, one line — the full argument is in 说明. */
      const effortMeta = advertised === null
        ? t('effortUnknown')
        : advertised.defaultEffort === null || advertised.defaultEffort === undefined
          ? t('effortAdvertised', { list: advertised.efforts.join(' / ') })
          : t('effortAdvertisedDefault', { list: advertised.efforts.join(' / '), fallback: advertised.defaultEffort })

      const effortRow = settingRow({
        id: 'dspo-effort',
        label: t('effortLabel'),
        hint: effortMeta,
        control: h(
          'select',
          {
            className: 'dspo-select',
            id: 'dspo-effort',
            'aria-label': t('effortLabel'),
            value: effort,
            onChange: (event) => void save({ reasoningEffort: event.target.value }),
          },
          choices.map((choice) => h('option', { key: choice, value: choice }, effortLabel(t, choice))),
        ),
      })

      const effortWarn = effortDegraded === null
        ? null
        : h('div', { className: 'dspo-set-warn' }, t('effortDegraded', { value: effortDegraded }))

      const styleRow = selectRow(
        'dspo-style',
        t('styleLabelSetting'),
        t('styleHintShort'),
        settings?.style ?? 'standard',
        ['standard', 'slim', 'structured', 'expand'].map((id) => ({
          value: id,
          label: t(`style${id[0].toUpperCase()}${id.slice(1)}`),
        })),
        (value) => void save({ style: value }),
      )

      const applyRow = selectRow(
        'dspo-apply',
        t('applyModeLabel'),
        t('applyModeHintShort'),
        settings?.applyMode ?? 'auto',
        [
          { value: 'auto', label: t('applyAuto') },
          { value: 'review', label: t('applyReview') },
        ],
        (value) => void save({ applyMode: value }),
      )

      const routeRow = selectRow(
        'dspo-route',
        t('routeLabel'),
        t('routeHintShort'),
        settings?.route ?? 'plugin',
        [
          { value: 'plugin', label: t('routePlugin') },
          { value: 'agent', label: t('routeAgent') },
        ],
        (value) => void save({ route: value }),
      )

      const shortcutRow = settingRow({
        id: 'dspo-shortcut',
        label: t('shortcutToggle'),
        hint: null,
        control: h('input', {
          type: 'checkbox',
          id: 'dspo-shortcut',
          className: 'dspo-check-input',
          checked: settings?.shortcut !== false,
          onChange: (event) => void save({ shortcut: event.target.checked }),
        }),
      })

      const promptRow = h(
        'div',
        { className: 'dspo-set-row', 'data-stack': 'true' },
        h(
          'div',
          { className: 'dspo-set-text' },
          h(
            'div',
            { className: 'dspo-set-line' },
            h('label', { className: 'dspo-set-label', htmlFor: 'dspo-prompt' }, t('promptLabel')),
            h('span', { className: 'dspo-set-status' }, state?.custom === true ? t('customInUse') : t('builtinInUse')),
          ),
          h('div', { className: 'dspo-set-hint' }, t('promptHintShort')),
        ),
        h(
          'div',
          { className: 'dspo-set-controls' },
          h('textarea', {
            className: 'dspo-textarea',
            id: 'dspo-prompt',
            value: promptValue,
            spellCheck: false,
            placeholder: t('promptPlaceholder'),
            maxLength: limits.maxSystemPromptChars,
            onChange: (event) => setDraftPrompt(event.target.value),
          }),
        ),
        h(
          'div',
          { className: 'dspo-set-controls' },
          h(
            'button',
            {
              type: 'button',
              className: 'dspo-action',
              'data-kind': 'primary',
              disabled: !dirty || snapshot.saving,
              onClick: async () => {
                const result = await settingsStore.save({ systemPrompt: promptValue })
                if (result.ok) {
                  setDraftPrompt(null)
                  setFeedback({ tone: 'ok', text: promptValue.trim() === '' ? t('restoredDefault') : t('saved') })
                }
              },
            },
            t('save'),
          ),
          h(
            'button',
            { type: 'button', className: 'dspo-action', disabled: !dirty, onClick: () => setDraftPrompt(null) },
            t('discardChanges'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dspo-action',
              onClick: () => setDraftPrompt(state?.defaultSystemPrompt ?? ''),
            },
            t('fillDefault'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dspo-action',
              disabled: saved === null,
              onClick: () => void save({ systemPrompt: '' }, t('restoredDefault')),
            },
            t('resetDefault'),
          ),
          h(
            'span',
            { className: 'dspo-set-hint' },
            dirty ? t('unsaved') : t('charCount', { n: promptValue.length, max: limits.maxSystemPromptChars }),
          ),
        ),
        h(
          'details',
          { className: 'dspo-details' },
          h('summary', null, t('showDefault')),
          h('pre', { className: 'dspo-pre' }, state?.defaultSystemPrompt ?? ''),
        ),
      )

      const modelGroup = h(
        'section',
        { className: 'dspo-set-group' },
        h('div', { className: 'dspo-set-group-title' }, t('groupModel')),
        followRow,
        modelRow,
        modelErrors === '' ? null : h('div', { className: 'dspo-set-hint' }, modelErrors),
        effortRow,
        effortWarn,
        notesBlock(t, [
          { label: t('modelLabel'), text: t('modelHint') },
          { label: t('followSession'), text: t('followSessionHint') },
          { label: t('effortLabel'), text: t('effortHint') },
        ]),
      )

      const rewriteGroup = h(
        'section',
        { className: 'dspo-set-group' },
        h('div', { className: 'dspo-set-group-title' }, t('groupRewrite')),
        styleRow,
        applyRow,
        routeRow,
        shortcutRow,
        notesBlock(t, [
          { label: t('styleLabelSetting'), text: t('styleHint') },
          { label: t('applyModeLabel'), text: t('applyModeHint') },
          { label: t('routeLabel'), text: t('routeHint') },
        ]),
      )

      const promptGroup = h(
        'section',
        { className: 'dspo-set-group' },
        h('div', { className: 'dspo-set-group-title' }, t('groupPrompt')),
        promptRow,
        notesBlock(t, [{ label: t('promptLabel'), text: t('promptHint') }]),
      )

      return h(
        'div',
        { className: 'dspo-set', 'data-plugin': ID },
        h(
          'div',
          { className: 'dspo-set-head' },
          h('h2', { className: 'dspo-set-title' }, t('settingsTitle')),
          h('p', { className: 'dspo-set-intro' }, t('settingsIntro')),
        ),
        modelGroup,
        rewriteGroup,
        promptGroup,
        h(
          'div',
          { className: 'dspo-meta' },
          h('span', { className: 'dspo-set-hint' }, `${t('configFile')}：`),
          h('span', { className: 'dspo-path' }, state?.configFile ?? ''),
        ),
        feedback !== null
          ? h('div', { className: feedback.tone === 'ok' ? 'dspo-set-ok' : 'dspo-set-error' }, feedback.text)
          : null,
        snapshot.error !== null ? h('div', { className: 'dspo-set-error' }, snapshot.error) : null,
      )
    }

    /* ───────────────────────── plugin ───────────────────────── */

    /**
     * Services this plugin needs from the browser context. `slots` is required;
     * `locale` is read through a tolerant accessor so a shell without it keeps
     * the plugin in its default language instead of failing activation.
     */
    exports.inject = ['slots']

    /**
     * Register the composer button, the review card and the settings page. The
     * stylesheet and all three registrations are effects of this fiber, so an
     * unload or hot reload removes exactly what this plugin added.
     * @param {object} ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => installStyles(), 'dsh-prompt-optimizer: styles')
      ctx.effect(() => {
        publishLocale(readLocale(ctx))
        let disposer = null
        try {
          const subscribe = ctx.locale?.subscribe
          if (typeof subscribe === 'function') {
            disposer = subscribe(() => publishLocale(readLocale(ctx)))
          }
        } catch {
          /* no locale service: the default language stands */
        }
        return () => disposer?.()
      }, 'dsh-prompt-optimizer: locale')
      // The three registrations are single lines on purpose: the deployment's
      // plugin precheck reads the bundle's literal `register({ name: …` calls.
      ctx.effect(() => ctx.slots.inject(COMPOSER_SLOT, () => ctx.slots.register({ name: 'conversation.input.left', id: ID, order: COMPOSER_ORDER }, OptimizeButton)), 'dsh-prompt-optimizer: composer button')
      ctx.effect(() => ctx.slots.inject(DOCK_SLOT, () => ctx.slots.register({ name: 'conversation.input.dock', id: ID, order: DOCK_ORDER }, TaskPanel)), 'dsh-prompt-optimizer: review card')
      ctx.effect(() => ctx.slots.inject(SETTINGS_SLOT, () => ctx.slots.register({ name: 'settings.section', id: ID, order: SETTINGS_ORDER, label: () => DICT[locale].settingsNav }, SettingsPanel)), 'dsh-prompt-optimizer: settings page')
    }

    exports.apply = apply
    exports.OptimizeButton = OptimizeButton
    exports.TaskPanel = TaskPanel
    exports.SettingsPanel = SettingsPanel
    /** Exposed so `scripts/check.mjs` can drive the stores without a browser. */
    exports.settingsStore = settingsStore
    exports.sessions = sessions
    exports.readSession = readSession
    exports.patchSession = patchSession
    exports.clearSession = clearSession
    exports.sessionKey = sessionKey
    exports.runRewrite = runRewrite
    exports.runStream = runStream
    exports.DICT = DICT
    return module.exports
  },
})

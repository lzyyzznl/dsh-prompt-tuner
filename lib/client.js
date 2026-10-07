/**
 * dsh-prompt-tuner — browser half.
 *
 * Six registrations, one of them floating:
 *   1. `conversation.input.left` — one compact ✨ button in the composer tool
 *      row, at the right of the permission selector. Alt+O triggers it.
 *   2. `conversation.input.left` — the 💬 side-question button beside it.
 *      Alt+B opens the same panel `/btw` opens.
 *   3. `conversation.input.overlay` — the side-question panel itself, floating
 *      inside the composer card.
 *   4. `conversation.input.dock` — the review card above the composer: the
 *      rewrite streams in there, next to the draft it replaces, with the model's
 *      assumptions, the timings, the style switch and 采用 / 撤销 / 再改一次.
 *   5. `settings.section` — the 「插件优化集合」 page: which model rewrites (or the
 *      session's own), how much reasoning it may spend, the rewrite style, when
 *      an answer is applied, the optimization prompt itself, and how much
 *      conversation a side question may carry.
 *   6. `conversation.chat.turnTail` — the ⤴ rollback entry under every completed
 *      turn: one click copies the session up to the end of that turn into a new
 *      session and opens it, so the conversation can be picked up from there.
 *   7. plus the client-owned `/btw` composer command, which opens seat 3.
 *
 * The draft is read from the slot's `useInput` selector and written back through
 * `inputActions.setDraft`, so the plugin never touches the editor's DOM and the
 * host keeps ownership of the draft, undo history, and submission. The draft
 * revision is read too: an answer is applied automatically only while the draft
 * still is the text that was sent, otherwise it waits in the review card —
 * typing during a rewrite can therefore never be overwritten silently.
 *
 * The conversation excerpt a side question carries is read from the chat view's
 * own snapshot through the slot's `useConversation` selector — the transcript
 * the shell already rendered, never a private store and never the session log.
 * That snapshot is a *window* over the session's event log (DSH opens the newest
 * page and pages older ones in only when the reader scrolls to the top), so the
 * seat walks the window back to the session's first event on mount through the
 * session face's own `loadOlder()` verb: entering a conversation, not scrolling
 * it, is what makes the whole history available. The walk is bounded, and the
 * panel says whether it is holding the whole transcript or only part of it.
 * It travels to the host only when the user asks for it, and `0` (carry nothing)
 * is a first-class setting.
 *
 * Rolling the conversation back is the one session-shaped thing this package
 * does, and it is deliberately a copy rather than a rewrite: the event log is
 * append-only, and the engine's own answer to "give me this session up to here"
 * is `sessions.fork({ atSeq })` — an exact inclusive prefix copied into a *new*
 * session (the shell's own session menu uses that same verb, but only ever for
 * "the last completed turn"). The rollback seat therefore supplies the missing
 * half, the *point*: it hands the completed turn's closing seq to `fork`, opens
 * the child, and never rewrites the session it came from.
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
    /** Floating seat: entries rendered inside the resident composer card (the /btw panel lives here). */
    const OVERLAY_SLOT = 'conversation.input.overlay'
    /** Settings seat: one page in the settings panel. */
    const SETTINGS_SLOT = 'settings.section'
    /** Turn-tail seat: entries that sit before a completed turn's own action row (the rollback entry lives here). */
    const TURN_TAIL_SLOT = 'conversation.chat.turnTail'
    /** Registration id / CSS prefix; also the settings page key. */
    const ID = 'prompt-optimizer'
    /** Host route prefix, document-relative (the GUI may be served under a sub-path). */
    const ROUTE = 'dsh-prompt-optimizer/'
    /** Order inside the composer tool row. */
    const COMPOSER_ORDER = 90
    /** Order inside the composer dock (above the composer card). */
    const DOCK_ORDER = 90
    /** Order inside the composer card's floating layer: after the shell's own entries. */
    const OVERLAY_ORDER = 40
    /** Order of the settings page in the navigation list. */
    const SETTINGS_ORDER = 60
    /** Order of the rollback entry among a completed turn's tail entries: after the shipped ones. */
    const REWIND_ORDER = 500
    /** How many in-flight deltas one second of streaming may draw. */
    const DELTA_FRAME_MS = 80
    /**
     * The "carry everything" value of the context setting, mirroring the host's
     * `BTW_CONTEXT_ALL`. The browser half may not import host modules, so the two
     * halves agree on the literal instead — and the self-test pins both.
     */
    const BTW_CONTEXT_ALL = 'all'
    /** The conversation view target whose snapshot carries the transcript (dsh-client-ui-chat). */
    const CHAT_TARGET = 'chat'

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
        noModel: '没有可用的模型：请到「设置 → 插件优化集合」里选一个',
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
        settingsNav: '插件优化集合',
        settingsTitle: 'DSH 插件优化集合',
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
        // side questions (/btw)
        btw: '💬 旁路提问',
        btwShortcutHint: '快捷键 Alt+B',
        btwCommandLabel: '旁路提问',
        btwCommandDescription: '带当前会话上下文问一个临时小问题：答案流式返回，不进主对话，也不让 agent 动手',
        btwTitle: '旁路提问',
        btwIntro: '临时问一个小问题：默认带上这个会话的全部历史消息，答案流式返回、只显示在这里——不写进主对话，也不会执行任何命令或写入任何内容。',
        btwPlaceholder: '问一个不打断主对话的小问题…',
        btwAsk: '提问',
        btwAsking: '回答中…',
        btwStop: '停止',
        btwFollowUpPlaceholder: '追问（同一话题继续问）…',
        btwNewTopic: '新问题',
        btwTurnLabel: '第 {n} 轮',
        btwCopy: '复制',
        btwCopied: '已复制',
        btwCopyFailed: '复制失败，请手动选中文本',
        btwToComposer: '写入输入框',
        btwToComposerHint: '把这条回答写进输入框，你可以编辑后再发到主对话',
        btwPromoted: '已写入输入框，可编辑后发送',
        btwClose: '关闭',
        btwHistory: '历史',
        btwHistoryEmpty: '这个会话还没有旁路记录',
        btwClear: '清空历史',
        btwCleared: '已清空',
        btwTopicLabel: '话题',
        btwContextAll: '已带全部 {n} 条会话消息',
        btwContextOn: '已带最近 {n} 条会话消息',
        btwContextOff: '未带会话上下文',
        btwContextUnavailable: '读不到会话记录，本次只发送问题本身',
        btwLoadingHistory: '正在载入更早的历史…（已带 {n} 条）',
        btwContextWindowOnly: '已带当前已加载的 {n} 条会话消息（更早的历史未载完）',
        btwContextLoadedOnly: '已带当前已加载的 {n} 条会话消息',
        btwEmptyQuestion: '先写下你想问什么',
        btwTooLong: '问题超过 {max} 字上限，先精简一下',
        btwFailed: '旁路提问未完成',
        btwCancelled: '已取消，保留已显示的部分',
        btwReshaped: '这一轮的历史被折成单轮重问了一次（模型适配器不接受多轮形式），回答按同样的问题与上下文给出',
        btwTimings: '首字 {first} · 共 {total}',
        groupBtw: '旁路提问',
        btwContextLabel: '携带上下文',
        btwContextHint: '默认「全部历史消息」：进入会话时插件会把更早的分页补齐，再把整个会话的 user/assistant 文本整份带上，不按条数截断。也可以只带最近 N 条，或完全不带（选「不带」时不会去拉整段历史）。',
        btwContextAllOption: '全部历史消息（默认）',
        btwContextNone: '不带上下文',
        btwContextN: '最近 {n} 条消息',
        btwSaveHistoryLabel: '保存旁路历史',
        btwSaveHistoryHint: '写到宿主的旁路历史文件；关闭后只留在本次页面内存里。这是插件自己的本地记录，不是会话写入。',
        btwHistoryFile: '旁路历史文件',
        btwPrivacyNote: '只有旁路提问会读取会话内容：默认把整个会话的 user/assistant 文本随问题一起发给模型（可在上面收窄或不带）；改写功能仍然只发送草稿本身。旁路提问全程只读——不执行命令、不写会话、不写草稿。',
        // rollback seat
        rewindButton: '回退到此',
        rewindHint: '从这一轮结束的地方复制出一个新会话并打开它——在那里接着聊，就等于回到了这一轮。当前会话不会被改写。',
        rewindBusy: '正在创建…',
        rewindDone: '已从这一轮创建新会话，正在打开',
        rewindDoneList: '已从这一轮创建新会话，见会话列表',
        rewindFailed: '创建新会话失败：{message}',
        rewindUnavailable: '当前宿主没有提供会话分叉能力，无法回退',
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
        noModel: 'No model available: pick one under Settings → Plugin suite',
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
        settingsNav: 'Plugin suite',
        settingsTitle: 'DSH plugin suite',
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
        // side questions (/btw)
        btw: '💬 Ask aside',
        btwShortcutHint: 'Shortcut: Alt+B',
        btwCommandLabel: 'Ask aside',
        btwCommandDescription: 'Ask a temporary question with the session context: the answer streams in, stays out of the conversation and starts no work',
        btwTitle: 'Ask aside',
        btwIntro: 'A quick question that carries the whole session history by default: the answer streams here and is never written into the conversation — no command runs and nothing is written anywhere.',
        btwPlaceholder: 'Ask something that should not interrupt the conversation…',
        btwAsk: 'Ask',
        btwAsking: 'Answering…',
        btwStop: 'Stop',
        btwFollowUpPlaceholder: 'Follow up in the same thread…',
        btwNewTopic: 'New question',
        btwTurnLabel: 'Turn {n}',
        btwCopy: 'Copy',
        btwCopied: 'Copied',
        btwCopyFailed: 'Copy failed — select the text manually',
        btwToComposer: 'Put in the composer',
        btwToComposerHint: 'Write this answer into the composer so you can edit it and send it as a real message',
        btwPromoted: 'Written into the composer — edit and send when ready',
        btwClose: 'Close',
        btwHistory: 'History',
        btwHistoryEmpty: 'No side questions in this session yet',
        btwClear: 'Clear history',
        btwCleared: 'Cleared',
        btwTopicLabel: 'Thread',
        btwContextAll: 'All {n} conversation message(s) carried',
        btwContextOn: 'Last {n} conversation message(s) carried',
        btwContextOff: 'No conversation context',
        btwContextUnavailable: 'The transcript is unavailable, so only the question itself is sent',
        btwLoadingHistory: 'Loading earlier history… ({n} carried so far)',
        btwContextWindowOnly: 'Carrying the {n} loaded conversation message(s); earlier history is not loaded yet',
        btwContextLoadedOnly: 'Carrying the {n} loaded conversation message(s)',
        btwEmptyQuestion: 'Write the question first',
        btwTooLong: 'The question exceeds {max} characters — shorten it first',
        btwFailed: 'The side question did not finish',
        btwCancelled: 'Cancelled — what was shown stays',
        btwReshaped: 'This round re-asked the thread as a single turn (the model adapter rejected the multi-turn form); same question, same context',
        btwTimings: 'first token {first} · {total} total',
        groupBtw: 'Side questions',
        btwContextLabel: 'Carry context',
        btwContextHint: 'Default "all history": entering a conversation walks its earlier pages in, and the whole transcript is then carried with no message-count cap. Narrow it to the last N messages, or carry none (choosing none never pulls the history).',
        btwContextAllOption: 'All history (default)',
        btwContextNone: 'No context',
        btwContextN: 'Last {n} messages',
        btwSaveHistoryLabel: 'Keep side-question history',
        btwSaveHistoryHint: 'Written to the host history file; when off it lives in this page only. This is the plugin\'s own local record, not a conversation write.',
        btwHistoryFile: 'History file',
        btwPrivacyNote: 'Only side questions read the conversation: by default the whole session transcript travels with the question (narrow it above if you prefer). The rewrite half still sends the draft alone. A side question is read-only throughout — no command runs, no conversation write, no draft write.',
        // rollback seat
        rewindButton: 'Rewind to here',
        rewindHint: 'Copy the conversation up to the end of this turn into a new session and open it — continuing there is the same as going back to this point. The current session is never rewritten.',
        rewindBusy: 'Creating…',
        rewindDone: 'Created a new session at this turn — opening it',
        rewindDoneList: 'Created a new session at this turn — see the session list',
        rewindFailed: 'Could not create the session: {message}',
        rewindUnavailable: 'This host offers no session fork, so rewinding is unavailable',
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
     * POST one call and consume its server-sent-event stream.
     *
     * The stream is a display channel only: the text it carries is the same text
     * the `done` frame delivers, so a reader that misses frames still ends with
     * the authoritative answer. A transport that cannot stream (or an older host
     * half without the route) falls back to the plain JSON route.
     * @param {string} action - streaming route tail (e.g. `optimize.stream`).
     * @param {object} body - the request.
     * @param {AbortSignal} signal - cancellation.
     * @param {(text: string) => void} onDelta - called with the accumulated text.
     * @returns {Promise<{ok: boolean, value?: object, error?: object, timings?: object, streamed: boolean}>} the outcome.
     */
    async function streamAction(action, body, signal, onDelta) {
      let response
      try {
        response = await fetch(ROUTE + action, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        })
      } catch {
        return signal.aborted
          ? { ok: false, error: { code: 'aborted', message: 'stopped' }, streamed: true }
          : streamOrFallback(action.replace(/\.stream$/, ''), body, signal, onDelta)
      }
      if (!response.ok || response.body === null || typeof response.body.getReader !== 'function') {
        return streamOrFallback(action.replace(/\.stream$/, ''), body, signal, onDelta)
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
      return { ok: false, error: { code: 'transport', message: 'the stream ended unexpectedly' }, streamed: true }
    }

    /**
     * The rewrite's streaming call: {@link streamAction} fixed to the optimize routes.
     * @param {object} body - the optimize request.
     * @param {AbortSignal} signal - cancellation.
     * @param {(text: string) => void} onDelta - called with the accumulated text.
     * @returns {Promise<object>} the outcome.
     */
    async function runStream(body, signal, onDelta) {
      return streamAction('optimize.stream', body, signal, onDelta)
    }

    /**
     * Fallback used when the streaming route is missing: the plain JSON call,
     * reported as one final delta so callers need no second code path.
     * @param {string} action - JSON route tail (e.g. `optimize`).
     * @param {object} body - the request.
     * @param {AbortSignal} signal - cancellation.
     * @param {(text: string) => void} onDelta - called with the final text.
     * @returns {Promise<object>} the outcome, marked `streamed: false`.
     */
    async function streamOrFallback(action, body, signal, onDelta) {
      const result = await post(action, body, signal)
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
/* ── side-question panel (floating inside the composer card) ── */
.dspo-btw {
  /* The shell's overlay anchor is a zero-height, absolutely positioned strip at
     the composer card's top edge; anchoring to its own bottom edge floats the
     panel above the composer instead of covering the draft being typed. The
     panel scrolls itself, because nothing above it clips on its behalf. */
  position: absolute; bottom: calc(100% + 8px); left: 0; right: 0;
  box-sizing: border-box; width: 100%; max-width: var(--dsh-composer-card-max-width, 848px);
  margin: 0 auto; padding: 0 12px 10px; max-height: min(62vh, 480px); overflow: auto;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family, inherit); font-size: 12px; line-height: 1.6;
}
/* The panel scrolls itself, so the head must not: the title, the
   carried-context count and the three chips stay put while the thread scrolls
   underneath. A sticky box is pinned to the scrollport's *content* edge, so the
   scroller itself carries no block-start padding (it moved into the head's own
   padding) — with padding there, the head pinned 11px low and the transcript
   showed through the strip above it. The opaque background matters for the same
   reason. */
.dspo-btw-head {
  position: sticky; top: 0; z-index: 1;
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin: 0 0 8px; padding: 10px 0 8px;
  background: var(--dsw-alias-bg-layer-1);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dspo-btw-title { font-size: 13px; font-weight: 600; }
.dspo-btw-meta { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dspo-btw-spacer { flex: 1 1 auto; }
.dspo-btw-turn { padding: 8px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.dspo-btw-turn:first-of-type { border-top: none; }
.dspo-btw-q { display: flex; gap: 6px; color: var(--dsw-alias-label-primary); font-weight: 600; }
.dspo-btw-a {
  margin: 4px 0 0; white-space: pre-wrap; word-break: break-word;
  color: var(--dsw-alias-label-primary);
}
.dspo-btw-a[data-state='asking'] { color: var(--dsw-alias-label-secondary); }
/* A caret that keeps blinking while text is still arriving, so a streamed
   answer reads as "still coming" exactly like a streaming turn in the main
   conversation — and stops the moment the turn settles. */
.dspo-btw-a[data-state='asking']::after {
  content: '▍'; margin-left: 1px; color: var(--dsw-alias-brand-primary);
  animation: dspo-btw-caret 1.1s steps(1, end) infinite;
}
@keyframes dspo-btw-caret { 0%, 50% { opacity: 1; } 50.01%, 100% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .dspo-btw-a[data-state='asking']::after { animation: none; opacity: 1; }
}
.dspo-btw-turn-actions { display: flex; gap: 8px; margin-top: 6px; }
.dspo-btw-input { min-height: 64px; margin-top: 8px; }
.dspo-btw-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.dspo-btw-history { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dspo-btw-topic {
  display: block; width: 100%; text-align: left; margin-top: 4px; padding: 6px 8px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-secondary);
  font-family: inherit; font-size: 11.5px; cursor: pointer;
}
.dspo-btw-topic:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dspo-btw-topic[data-active='true'] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.dspo-btw-error { margin-top: 8px; color: var(--dsw-alias-state-error-primary); }
/* The rollback entry: a small pill that joins the completed turn's own action
   row, plus its transient one-line result. It reads as a quiet affordance —
   the action copies the session rather than deleting anything. */
.dspo-rewind { display: inline-flex; align-items: center; gap: 6px; }
.dspo-rewind-btn {
  padding: 2px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px;
  background: transparent; color: var(--dsw-alias-label-secondary);
  font-family: inherit; font-size: 11.5px; line-height: 1.6; cursor: pointer;
}
.dspo-rewind-btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-brand-primary);
}
.dspo-rewind-btn:disabled { opacity: 0.55; cursor: default; }
.dspo-rewind-note { color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
.dspo-rewind-note[data-kind='error'] { color: var(--dsw-alias-state-error-primary); }
/* A completed turn's tail already reveals its own icon row on hover through the
   shell's data-actions-reveal attribute; this entry rides that same published
   hook so a long session does not carry a pill under every single turn. Touch
   devices never hover, so there it stays visible — exactly the stance the
   shell's own rule takes. If the attribute ever changes, the entry simply stays
   visible rather than disappearing. */
@media (hover: hover) {
  [data-actions-reveal='hover'] .dspo-rewind { opacity: 0; transition: opacity 80ms; }
  [data-actions-reveal='hover']:hover .dspo-rewind,
  [data-actions-reveal='hover']:focus-within .dspo-rewind { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  [data-actions-reveal='hover'] .dspo-rewind { transition: none; }
}
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

    /* ───────────────────────── side questions (composer overlay) ───────────────────────── */

    /**
     * Per-session side-question state: whether the panel is open, the thread it
     * shows, and the history the host knows about.
     *
     * The key is the same {@link sessionKey} the rewrite half uses, so the
     * button, the floating panel and the `/btw` command all address one record.
     * The thread lives in module memory (it is what the panel renders right
     * now); the host's history file is the durable copy and owns what survives a
     * reload.
     */
    const btwSessions = new Map()
    const btwListeners = new Set()
    /** In-flight side questions per session, so 停止 and a session switch reach the model call. */
    const btwInflight = new Map()

    /** @type {{open: boolean, rev: number, phase: string, draft: string, thread: Array<{q: string, a: string, state: string}>, topicId: string, topics: Array<object>, loaded: boolean, saveHistory: boolean, carried: number, notice: string|null, error: object|null, startedAt: number, firstTextMs: number, totalMs: number, historyOpen: boolean, historyStatus: string, historyPages: number}} */
    const BTW_IDLE = Object.freeze({
      open: false,
      rev: 0,
      phase: 'idle',
      draft: '',
      thread: [],
      topicId: '',
      topics: [],
      loaded: false,
      saveHistory: true,
      carried: 0,
      notice: null,
      error: null,
      startedAt: 0,
      firstTextMs: -1,
      totalMs: 0,
      historyOpen: false,
      /**
       * How much of this session's transcript the window holds: `idle` before
       * the walk runs, then `loading` / `complete` / `partial` (a bound stopped
       * it) / `unavailable` (no session face to page with).
       */
      historyStatus: 'idle',
      /** Older pages this walk pulled so far. */
      historyPages: 0,
    })

    /** Current side-question state of one session. */
    function readBtw(key) {
      return btwSessions.get(key) ?? BTW_IDLE
    }

    /** Merge one patch into a session's side-question state and wake the components. */
    function patchBtw(key, patch) {
      const current = readBtw(key)
      const next = { ...current, ...patch, rev: current.rev + 1 }
      btwSessions.set(key, next)
      for (const listener of [...btwListeners]) listener()
      return next
    }

    /** Replace the newest turn of one session's thread — the one a run owns. */
    function patchBtwTurn(key, patch) {
      const current = readBtw(key)
      if (current.thread.length === 0) return current
      const last = current.thread[current.thread.length - 1]
      return patchBtw(key, { thread: [...current.thread.slice(0, -1), { ...last, ...patch }] })
    }

    /** Subscribe to the shared per-session side-question state. */
    function useBtwState(key) {
      const [state, setState] = useState(() => readBtw(key))
      useEffect(() => {
        const listener = () => setState(readBtw(key))
        btwListeners.add(listener)
        setState(readBtw(key))
        return () => btwListeners.delete(listener)
      }, [key])
      return state
    }

    /** Join the text blocks of one content array (user blocks use `type`, assistant blocks use `kind`). */
    function contentText(blocks, key) {
      if (!Array.isArray(blocks)) return ''
      return blocks
        .filter((block) => block !== null && typeof block === 'object' && block[key] === 'text')
        .map((block) => String(block.text ?? ''))
        .join('\n')
        .trim()
    }

    /**
     * One conversation node reduced to what a side question needs.
     *
     * Context injections, tool rows, command rows and compaction summaries are
     * deliberately dropped: they are the scaffolding of a turn, not what the user
     * and the model said to each other, and carrying them would both cost tokens
     * and invite the model to answer about a tool result it cannot act on.
     * @param {object} node - one `ConversationNode` from the chat snapshot.
     * @returns {{role: string, text: string}|null} the entry, or null when it carries nothing.
     */
    function btwNodeEntry(node) {
      if (node === null || typeof node !== 'object') return null
      const kind = String(node.kind ?? '')
      if (kind === 'user' || kind === 'steering') {
        const text = contentText(node.content, 'type')
        return text === '' ? null : { role: 'user', text }
      }
      if (kind === 'assistant') {
        const text = contentText(node.blocks, 'kind')
        return text === '' ? null : { role: 'assistant', text }
      }
      return null
    }

    /**
     * Reduce the loaded transcript to the excerpt one side question carries.
     *
     * `turns` is the setting: {@link BTW_CONTEXT_ALL} carries **every** message
     * of the session, a number keeps that many recent messages, and `0` carries
     * nothing. In every mode a message travels whole — this half never trims a
     * message and never drops one to fit a character budget, so "all" really is
     * all; the host refuses an over-long payload by name instead of slicing it
     * silently (see `MAX_BTW_CONTEXT_CHARS`).
     *
     * Note the unit: the setting counts messages, not session turns, because
     * what the model needs is "who said what", and one user message plus one
     * answer is already two entries.
     * @param {Array<object>} nodes - the chat snapshot's nodes, in flow order.
     * @param {number|string} turns - how much history to carry.
     * @returns {{text: string, messages: number}} the excerpt and how many messages it holds.
     */
    function btwContext(nodes, turns) {
      if (!Array.isArray(nodes)) return { text: '', messages: 0 }
      const all = turns === BTW_CONTEXT_ALL
      const limit = all ? Number.POSITIVE_INFINITY : Number.isFinite(Number(turns)) ? Math.max(0, Math.trunc(Number(turns))) : 0
      if (limit === 0) return { text: '', messages: 0 }
      const entries = []
      for (const node of nodes) {
        const entry = btwNodeEntry(node)
        if (entry !== null) entries.push(entry)
      }
      const kept = limit === Number.POSITIVE_INFINITY ? entries : entries.slice(-limit)
      const text = kept
        .map((entry) => `${entry.role === 'user' ? '用户' : '助手'}：${entry.text}`)
        .join('\n\n')
      return { text, messages: kept.length }
    }

    /**
     * The loaded transcript, read through whichever selector this seat hands us.
     *
     * `useChat` is the chat view's own session-standard hook (a direct
     * `ChatSnapshot` selector); `useConversation` is the target-neutral snapshot
     * whose `chat` view target carries the same nodes. Either can be absent on a
     * shell that does not install the chat view, and both hooks are therefore
     * called unconditionally with a no-op fallback — a branch on prop presence
     * would change the hook order between renders.
     * @param {object} props - slot props of a session-scoped seat.
     * @returns {Array<object>} conversation nodes in flow order, `[]` when unavailable.
     */
    function useChatNodes(props) {
      const useChat = typeof props?.useChat === 'function' ? props.useChat : () => null
      const useConversation = typeof props?.useConversation === 'function' ? props.useConversation : () => null
      const chat = useChat((state) => state)
      const target = useConversation((state) => state?.views?.get?.(CHAT_TARGET) ?? null)
      const snapshot = chat ?? target
      return Array.isArray(snapshot?.legacy?.nodes) ? snapshot.legacy.nodes : []
    }

    /* ───────────────── the transcript window ───────────────── */

    /**
     * How far the transcript walk may go, and for how long.
     *
     * The walk is meant to finish: a session's window arrives one page at a
     * time, and a pathological window (a very long session, a gateway that
     * keeps claiming more) must not hold the ask hostage. When a bound is hit
     * the walk reports `partial` and the panel says what it is really holding
     * instead of claiming a complete transcript it does not have.
     */
    const HISTORY_MAX_PAGES = 40
    const HISTORY_DEADLINE_MS = 30_000

    /** In-flight transcript walks per session, so one window is only paged once. */
    const historyWalks = new Map()

    /**
     * The client context this plugin was activated with.
     *
     * Components are plain functions of their slot props and never receive the
     * context, but the session-history walk needs the shell's `sessions`
     * service; `apply` stores it here so a mounted seat can reach it.
     */
    let clientContext = null

    /**
     * The session face for one session, or null when the shell does not expose
     * the service (declared or not, a missing service is not an activation
     * failure: the panel falls back to carrying what is loaded and says so).
     * @param {string} key - session id.
     * @param {object} [ctx] - client context to read the service from (defaults to the activation context).
     * @returns {object|null} the `SessionFace` (its `loadOlder` verb and snapshot).
     */
    function sessionFace(key, ctx = clientContext) {
      try {
        if (ctx === null || ctx === undefined) return null
        // Same tolerant read the command seat uses: `ctx.get` answers undefined
        // for a service this plugin did not declare, while a bare property
        // access on an undeclared service throws.
        const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : ctx.sessions
        const face = sessions?.scope?.(key)
        return face === null || face === undefined ? null : face
      } catch {
        return null
      }
    }

    /** The session's lifecycle snapshot, or null when it cannot be read. */
    function sessionSnapshotOf(face) {
      try {
        const snapshot = face?.getSnapshot?.()
        return snapshot !== null && typeof snapshot === 'object' ? snapshot : null
      } catch {
        return null
      }
    }

    /**
     * One optional shell service, read the tolerant way.
     *
     * `ctx.get(name)` answers `undefined` for a service this plugin did not
     * declare, while a bare property access on an undeclared service throws — so
     * the lookup is asked first and every failure is a missing capability rather
     * than a render-time crash. Two seats need this: the session-history walk
     * (`sessions`) and the rollback entry (`sessions` plus `uiWorkspace`).
     * @param {string} name - service key (e.g. `sessions`, `uiWorkspace`).
     * @param {object} [ctx] - client context to read from (defaults to the activation context).
     * @returns {object|null} the service, or null when the shell does not offer it.
     */
    function clientService(name, ctx = clientContext) {
      try {
        if (ctx === null || ctx === undefined) return null
        const viaGet = typeof ctx.get === 'function' ? ctx.get(name) : undefined
        if (viaGet !== null && viaGet !== undefined) return viaGet
        return ctx[name] ?? null
      } catch {
        return null
      }
    }

    /**
     * Resolve on the session's next change, or when the wait runs out.
     *
     * `loadOlder()` is a no-op while the shell's own page pull is in flight
     * (scroll-to-top, a turn jump), so the walk waits for that pull to settle
     * instead of spinning against the guard.
     * @param {object} face - the session face.
     * @param {number} timeoutMs - longest wait.
     * @returns {Promise<void>} resolves on the next change or the timeout.
     */
    function waitForSessionChange(face, timeoutMs) {
      return new Promise((resolve) => {
        let settled = false
        let timer = null
        let unsubscribe = null
        const finish = () => {
          if (settled) return
          settled = true
          if (timer !== null) clearTimeout(timer)
          try {
            unsubscribe?.()
          } catch {
            /* an unsubscribe that throws must not swallow the resolution */
          }
          resolve()
        }
        timer = setTimeout(finish, timeoutMs)
        try {
          const off = face?.subscribe?.(() => finish())
          if (typeof off === 'function') unsubscribe = off
        } catch {
          /* no subscription channel: the timeout above still settles the wait */
        }
      })
    }

    /**
     * Bring one session's transcript window up to the whole conversation.
     *
     * DSH opens a session with the newest page of its event log (at least 50
     * messages, at most 500) and pulls older pages only when the reader scrolls
     * to the top. Everything this plugin carries as "the session context" is the
     * window as it stands, so on a reopened conversation the panel would carry
     * whatever happened to be loaded and still call it all of it. This walks the
     * window back to the session's first event through the session face's own
     * `loadOlder()` verb, so entering a conversation — not scrolling it — is
     * what makes the whole transcript available, and reports which of the two
     * the panel is holding.
     * @param {string} key - session id.
     * @param {object} [ctx] - client context to read the service from (defaults to the activation context).
     * @returns {Promise<{status: string, pages: number}>} `complete`, `partial` or `unavailable`.
     */
    async function walkFullHistory(key, ctx) {
      const face = sessionFace(key, ctx)
      if (face === null) {
        patchBtw(key, { historyStatus: 'unavailable' })
        return { status: 'unavailable', pages: 0 }
      }
      const startedAt = Date.now()
      let pages = 0
      patchBtw(key, { historyStatus: 'loading', historyPages: 0 })
      while (pages < HISTORY_MAX_PAGES && Date.now() - startedAt < HISTORY_DEADLINE_MS) {
        const before = sessionSnapshotOf(face)
        if (before === null) break
        if (before.hasMore !== true) {
          patchBtw(key, { historyStatus: 'complete', historyPages: pages })
          return { status: 'complete', pages }
        }
        if (before.loadingOlder === true) {
          await waitForSessionChange(face, 250)
          continue
        }
        await face.loadOlder()
        pages += 1
        patchBtw(key, { historyStatus: 'loading', historyPages: pages })
        // No-progress guard: a page that changed nothing (an exhausted window
        // that still claims more) must end the walk, not spin it.
        if (sessionSnapshotOf(face) === before) break
      }
      // Leaving the loop means the window still claimed more history: either a
      // bound stopped the walk or a page stopped making progress. Both are
      // "not the whole transcript", and the panel says so.
      patchBtw(key, { historyStatus: 'partial', historyPages: pages })
      return { status: 'partial', pages }
    }

    /**
     * Start (or join) this session's transcript walk.
     *
     * The seat may mount again while the first walk is still pulling pages — a
     * session switch, a hot reload, an ask that arrives mid-walk — and two walks
     * over one window would double-count pages and race the busy flag. The
     * in-flight promise is the guard: a second caller waits on the first.
     * @param {string} key - session id.
     * @param {object} [ctx] - client context to read the service from (defaults to the activation context).
     * @returns {Promise<{status: string, pages: number}>} the walk's outcome.
     */
    function ensureFullHistory(key, ctx = clientContext) {
      const inflight = historyWalks.get(key)
      if (inflight !== undefined) return inflight
      const walk = walkFullHistory(key, ctx).finally(() => {
        historyWalks.delete(key)
      })
      historyWalks.set(key, walk)
      return walk
    }

    /**
     * Wait until this session's transcript walk has settled.
     *
     * The run calls this after publishing the asking turn: a question must be
     * answered against the whole conversation, and "the walk is still running"
     * is a reason to wait a moment, not to send half a transcript.
     * @param {string} key - session id.
     * @param {number} timeoutMs - longest wait.
     * @returns {Promise<string>} the status the walk settled on.
     */
    function waitForHistorySettled(key, timeoutMs) {
      if (readBtw(key).historyStatus !== 'loading') return Promise.resolve(readBtw(key).historyStatus)
      return new Promise((resolve) => {
        let timer = null
        const off = () => {
          if (timer !== null) clearTimeout(timer)
          btwListeners.delete(listener)
        }
        function listener() {
          if (readBtw(key).historyStatus === 'loading') return
          off()
          resolve(readBtw(key).historyStatus)
        }
        timer = setTimeout(() => {
          off()
          resolve('loading')
        }, timeoutMs)
        btwListeners.add(listener)
      })
    }

    /** Open the panel for one session and make sure its stored history is loaded. */
    function openBtw(key) {
      patchBtw(key, { open: true, notice: null })
      if (readBtw(key).loaded !== true) void loadBtwHistory(key)
    }

    /** Close the panel; the thread stays, so reopening is instant. */
    function closeBtw(key) {
      patchBtw(key, { open: false })
    }

    /** Start a fresh thread in the same panel. */
    function newBtwTopic(key) {
      patchBtw(key, { thread: [], topicId: '', carried: 0, phase: 'idle', error: null, notice: null })
    }

    /** Load one stored thread back into the panel. */
    function openBtwTopic(key, topicId) {
      const topic = readBtw(key).topics.find((entry) => entry?.id === topicId)
      if (topic === undefined) return
      const thread = (Array.isArray(topic.turns) ? topic.turns : []).map((turn) => ({
        q: String(turn?.q ?? ''),
        a: String(turn?.a ?? ''),
        state: 'done',
      }))
      patchBtw(key, { thread, topicId: String(topic.id ?? ''), phase: 'idle', error: null, notice: null })
    }

    /** Read this session's stored side-question history. */
    async function loadBtwHistory(key) {
      const result = await post('btw.history', { sessionId: key })
      if (result.ok !== true) {
        patchBtw(key, { loaded: true })
        return
      }
      patchBtw(key, {
        loaded: true,
        topics: Array.isArray(result.value?.topics) ? result.value.topics : [],
        saveHistory: result.value?.saveHistory !== false,
      })
    }

    /** Persist one settled turn and adopt the host's topic identity and history. */
    async function persistBtw(key, turn) {
      const result = await post('btw.save', {
        sessionId: key,
        topicId: turn.topicId,
        question: turn.question,
        answer: turn.answer,
        at: Date.now(),
      })
      if (result.ok !== true) return
      const current = readBtw(key)
      patchBtw(key, {
        topics: Array.isArray(result.value?.topics) ? result.value.topics : current.topics,
        topicId: typeof result.value?.topicId === 'string' && result.value.topicId !== '' ? result.value.topicId : current.topicId,
        saveHistory: result.value?.disabled !== true,
      })
    }

    /** Forget this session's stored history. */
    async function clearBtwHistory(key) {
      const result = await post('btw.clear', { sessionId: key })
      if (result.ok !== true) return
      patchBtw(key, { topics: [], topicId: '', thread: [], notice: 'cleared' })
    }

    /** Cancel a running side question; what has been shown stays on screen. */
    function stopBtw(key) {
      btwInflight.get(key)?.abort()
    }

    /**
     * Ask one side question for one session and stream the answer into that
     * session's panel.
     *
     * The thread is the state machine: the question is appended as an `asking`
     * turn, deltas rewrite that turn's answer, and the terminal envelope either
     * settles it (and persists the turn when the host keeps history) or marks it
     * failed. Nothing here reaches the conversation — the host calls the model
     * directly, so there is no session event to write even by accident.
     *
     * The asking turn is published **before** the transcript is completed, so
     * the panel answers immediately (the reader sees 回答中 and can stop) while
     * the window finishes arriving; the context is read after that wait, from
     * the caller's reader, so the question travels with the whole conversation
     * rather than with the page that happened to be loaded.
     * @param {object} input - session key, question, prior thread turns, topic id, the context reader, and the optional transcript completer.
     * @returns {Promise<void>} resolves when the question settles.
     */
    async function runBtw(input) {
      const { key, question, history, topicId, readContext, prepare } = input
      const carried = Number.isFinite(input.carried) ? input.carried : 0
      btwInflight.get(key)?.abort()
      const controller = new AbortController()
      btwInflight.set(key, controller)
      const startedAt = Date.now()
      const previous = readBtw(key)
      patchBtw(key, {
        phase: 'asking',
        error: null,
        notice: null,
        draft: '',
        topicId: topicId ?? previous.topicId,
        carried,
        thread: [...previous.thread, { q: question, a: '', state: 'asking' }],
        startedAt,
        firstTextMs: -1,
        totalMs: 0,
      })
      if (typeof prepare === 'function') {
        if (readBtw(key).historyStatus === 'idle') await prepare()
        if (readBtw(key).historyStatus === 'loading') await waitForHistorySettled(key, HISTORY_DEADLINE_MS)
      }
      const window_ = typeof readContext === 'function'
        ? readContext()
        : { text: String(input.context ?? ''), messages: carried }
      patchBtw(key, { carried: window_.messages })
      const result = await streamAction(
        'btw.stream',
        { sessionId: key, question, context: window_.text, history },
        controller.signal,
        (partial) => patchBtwTurn(key, { a: partial }),
      )
      btwInflight.delete(key)
      if (result.ok === true) {
        const answer = String(result.value?.text ?? '').trim()
        const timings = result.value?.timings ?? {}
        const settledTopic = readBtw(key).topicId
        patchBtwTurn(key, { a: answer, state: 'done' })
        patchBtw(key, {
          phase: 'done',
          // The host may have had to re-ask the thread as a single turn; saying
          // so beats letting the answer look like it came from the usual call.
          notice: result.value?.reshaped === true ? 'reshaped' : null,
          firstTextMs: Number.isFinite(timings.firstTextMs) ? timings.firstTextMs : -1,
          totalMs: Number.isFinite(timings.totalMs) ? timings.totalMs : Date.now() - startedAt,
        })
        if (answer !== '') void persistBtw(key, { topicId: settledTopic, question, answer })
        return
      }
      if (result.error?.code === 'aborted') {
        patchBtwTurn(key, { state: 'done' })
        patchBtw(key, { phase: 'done', notice: 'cancelled', totalMs: Date.now() - startedAt })
        return
      }
      patchBtwTurn(key, { state: 'error' })
      patchBtw(key, {
        phase: 'error',
        error: result.error ?? { code: 'internal', message: '' },
        totalMs: Date.now() - startedAt,
      })
    }

    /** Notice codes as dictionary keys, so the stores stay free of localized text. */
    const BTW_NOTICES = { copied: 'btwCopied', 'copy-failed': 'btwCopyFailed', cancelled: 'btwCancelled', promoted: 'btwPromoted', cleared: 'btwCleared', reshaped: 'btwReshaped' }

    /**
     * The composer-row entry point: one compact button that opens the panel, the
     * side-question twin of the ✨ button beside it. Alt+B does the same from the
     * keyboard, and the client-owned `/btw` command from the menu.
     * @param {object} props - slot props of `conversation.input.left`.
     * @returns {import('react').ReactElement} the button.
     */
    function BtwButton(props) {
      const t = useText()
      const snapshot = useSharedState()
      const key = sessionKey(props)
      const session = useBtwState(key)
      const open = useCallback(() => openBtw(key), [key])
      const carrySetting = snapshot.state?.settings?.btwContextTurns ?? BTW_CONTEXT_ALL

      /**
       * Walking the transcript window back to the session's first event is what
       * makes the whole history available, and it starts here: this seat mounts
       * once per open conversation, which is exactly "the conversation was
       * opened". Waiting for a scroll to the top would leave the completeness of
       * the carried context in the reader's hands. A session whose setting says
       * "carry nothing" is not walked at all — there is no context to complete,
       * and pulling a whole transcript for a feature that will not read it is
       * exactly the kind of thing this plugin refuses to do behind a setting.
       */
      useEffect(() => {
        const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
        if (sessionId === '') return undefined
        if (carrySetting === 0 || carrySetting === '0') return undefined
        void ensureFullHistory(key)
        return undefined
      }, [key, props?.sessionId, carrySetting])

      /** Alt+B, while the composer holds the caret. */
      useEffect(() => {
        const onKeyDown = (event) => {
          if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
          if (String(event.key).toLowerCase() !== 'b') return
          const element = document.activeElement
          const tag = String(element?.tagName ?? '').toLowerCase()
          const editable = tag === 'textarea' || tag === 'input' || element?.isContentEditable === true
          if (!editable) return
          event.preventDefault()
          openBtw(key)
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [key])

      return h(
        'div',
        { className: 'dspo-inline', 'data-plugin': ID },
        h(
          'button',
          {
            type: 'button',
            className: 'dspo-btn',
            'data-busy': session.open ? 'true' : undefined,
            'aria-expanded': session.open ? 'true' : 'false',
            onClick: open,
            title: `${t('btw')}（${t('btwShortcutHint')}）`,
          },
          t('btw'),
        ),
        session.phase === 'asking' ? h('span', { className: 'dspo-status' }, t('btwAsking')) : null,
      )
    }

    /**
     * The side-question panel: a floating card inside the composer, holding the
     * thread, the question box, and the stored history.
     *
     * It is deliberately not a modal: the point of a side question is that the
     * main conversation stays visible and running behind it, so the panel takes
     * the same width as the composer card, scrolls itself, and closes with one
     * click without touching anything else.
     * @param {object} props - slot props of `conversation.input.overlay`.
     * @returns {import('react').ReactElement|null} the panel, or null while closed.
     */
    function BtwPanel(props) {
      const t = useText()
      const snapshot = useSharedState()
      const key = sessionKey(props)
      const session = useBtwState(key)
      const actions = props.inputActions
      const nodes = useChatNodes(props)
      /**
       * The node list as of the latest render. The ask path reads this after
       * waiting for the transcript walk, so it carries the grown transcript
       * rather than the page that was loaded when the panel last rendered.
       */
      const nodesRef = useRef(nodes)
      nodesRef.current = nodes
      const limits = snapshot.state?.btw ?? null
      const maxQuestion = Number.isFinite(limits?.maxQuestionChars) ? limits.maxQuestionChars : 2_000
      const contextTurns = snapshot.state?.settings?.btwContextTurns ?? BTW_CONTEXT_ALL

      /**
       * Esc dismisses the panel, the way the shell's own dismissable layers do:
       * one document-level `keydown` listener that exists only while the panel
       * is open and that never calls `preventDefault`, so the shell's own
       * Escape gestures — the `Esc Esc` stop chord — keep working. The history
       * list is a layer of its own: the first Escape closes it, the next one
       * closes the panel.
       */
      useEffect(() => {
        if (session.open !== true) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
          if (event.defaultPrevented === true) return
          if (readBtw(key).historyOpen === true) {
            patchBtw(key, { historyOpen: false })
            return
          }
          closeBtw(key)
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [key, session.open])

      if (session.open !== true) return null

      const asking = session.phase === 'asking'
      const carried = btwContext(nodes, contextTurns)
      const historyStatus = session.historyStatus
      const contextLabel = contextTurns === 0 || contextTurns === '0'
        ? t('btwContextOff')
        : nodes.length === 0
          ? t('btwContextUnavailable')
          : historyStatus === 'loading'
            ? t('btwLoadingHistory', { n: carried.messages })
            : historyStatus === 'partial'
              // Not the whole transcript, and we know more exists: name what is
              // actually held instead of calling a window "all of it".
              ? t('btwContextWindowOnly', { n: carried.messages })
              : historyStatus === 'unavailable'
                // No loader to page with, so nothing can be claimed about what
                // is missing — only about what is here.
                ? t('btwContextLoadedOnly', { n: carried.messages })
                : contextTurns === BTW_CONTEXT_ALL
                  ? t('btwContextAll', { n: carried.messages })
                  : t('btwContextOn', { n: carried.messages })

      const ask = () => {
        const question = session.draft.trim()
        if (question === '') {
          patchBtw(key, { error: { code: 'empty-question', message: t('btwEmptyQuestion') } })
          return
        }
        if (question.length > maxQuestion) {
          patchBtw(key, { error: { code: 'too-long', message: t('btwTooLong', { max: maxQuestion }) } })
          return
        }
        // Every settled turn of this thread rides along: the thread is the user's
        // own handful of questions, so there is no count to cap here either.
        const history = session.thread
          .filter((turn) => turn.state === 'done' && turn.a !== '')
          .map((turn) => ({ question: turn.q, answer: turn.a }))
        // The context is read *by* the run, after it has completed the transcript
        // window: a session whose seat only ever carried nothing is walked here
        // as a last resort, and the read picks up the grown node list.
        const carrying = contextTurns !== 0 && contextTurns !== '0'
        void runBtw({
          key,
          question,
          history,
          topicId: session.topicId,
          prepare: carrying ? () => ensureFullHistory(key) : null,
          readContext: carrying
            ? () => btwContext(nodesRef.current, contextTurns)
            : () => ({ text: '', messages: 0 }),
        })
      }

      const copy = async (text) => {
        try {
          await navigator.clipboard.writeText(text)
          patchBtw(key, { notice: 'copied' })
        } catch {
          patchBtw(key, { notice: 'copy-failed' })
        }
      }

      /** Put one answer where the user can edit and send it for real. */
      const toComposer = (text) => {
        actions?.setDraft?.(text)
        patchBtw(key, { notice: 'promoted' })
      }

      const topics = Array.isArray(session.topics) ? session.topics : []
      return h(
        'div',
        {
          className: 'dspo-btw',
          'data-plugin': ID,
          role: 'dialog',
          // The shell's own modal marker (`[role="dialog"][aria-modal="true"]`,
          // see `dsh-client-ui-primitives`' `modalSelector`). Its keyboard
          // arbitration runs on window-capture — before any listener this plugin
          // can register — and treats a marked layer as owning the keyboard, so
          // Escape reaches this panel instead of arming the `Esc Esc` stop chord.
          // Without it, closing the panel mid-turn would take two presses and
          // the second one would cancel the main task behind it.
          'aria-modal': 'true',
          'aria-label': t('btwTitle'),
        },
        h(
          'div',
          { className: 'dspo-btw-head' },
          h('span', { className: 'dspo-btw-title' }, t('btwTitle')),
          h('span', { className: 'dspo-btw-meta' }, contextLabel),
          h('span', { className: 'dspo-btw-spacer' }),
          h(
            'button',
            {
              type: 'button',
              className: 'dspo-chip',
              'data-active': session.historyOpen ? 'true' : undefined,
              onClick: () => patchBtw(key, { historyOpen: session.historyOpen !== true }),
            },
            t('btwHistory'),
          ),
          topics.length > 0
            ? h('button', { type: 'button', className: 'dspo-chip', onClick: () => void clearBtwHistory(key) }, t('btwClear'))
            : null,
          h('button', {
            type: 'button',
            className: 'dspo-chip',
            title: `${t('btwClose')}（Esc）`,
            onClick: () => closeBtw(key),
          }, t('btwClose')),
        ),
        session.thread.length === 0 ? h('div', { className: 'dspo-btw-meta' }, t('btwIntro')) : null,
        session.thread.map((turn, index) =>
          h(
            'div',
            { className: 'dspo-btw-turn', key: `turn-${index}` },
            h(
              'div',
              { className: 'dspo-btw-q' },
              h('span', { className: 'dspo-btw-meta' }, t('btwTurnLabel', { n: index + 1 })),
              h('span', null, turn.q),
            ),
            h('div', { className: 'dspo-btw-a', 'data-state': turn.state }, turn.a === '' ? t('btwAsking') : turn.a),
            turn.a === ''
              ? null
              : h(
                  'div',
                  { className: 'dspo-btw-turn-actions' },
                  h('button', { type: 'button', className: 'dspo-chip', onClick: () => void copy(turn.a) }, t('btwCopy')),
                  h(
                    'button',
                    { type: 'button', className: 'dspo-chip', title: t('btwToComposerHint'), onClick: () => toComposer(turn.a) },
                    t('btwToComposer'),
                  ),
                ),
          ),
        ),
        session.historyOpen === true
          ? h(
              'div',
              { className: 'dspo-btw-history' },
              topics.length === 0
                ? h('div', { className: 'dspo-btw-meta' }, t('btwHistoryEmpty'))
                : topics
                    .slice()
                    .reverse()
                    .map((topic) =>
                      h(
                        'button',
                        {
                          key: String(topic?.id ?? ''),
                          type: 'button',
                          className: 'dspo-btw-topic',
                          'data-active': topic?.id === session.topicId ? 'true' : undefined,
                          onClick: () => openBtwTopic(key, String(topic?.id ?? '')),
                        },
                        String(topic?.turns?.[0]?.q ?? '').slice(0, 80),
                      ),
                    ),
            )
          : null,
        h('textarea', {
          className: 'dspo-textarea dspo-btw-input',
          value: session.draft,
          maxLength: maxQuestion,
          placeholder: session.thread.length === 0 ? t('btwPlaceholder') : t('btwFollowUpPlaceholder'),
          onChange: (event) => patchBtw(key, { draft: event.target.value, error: null }),
          // Enter asks and Shift+Enter breaks the line: the composer's own
          // contract, so the panel needs no second submit gesture to learn.
          onKeyDown: (event) => {
            if (event.key !== 'Enter' || event.shiftKey) return
            event.preventDefault()
            if (!asking) ask()
          },
        }),
        h(
          'div',
          { className: 'dspo-btw-actions' },
          asking
            ? h('button', { type: 'button', className: 'dspo-action', onClick: () => stopBtw(key) }, t('btwStop'))
            : h(
                'button',
                {
                  type: 'button',
                  className: 'dspo-action',
                  'data-kind': 'primary',
                  disabled: session.draft.trim() === '',
                  onClick: ask,
                },
                t('btwAsk'),
              ),
          session.thread.length > 0
            ? h('button', { type: 'button', className: 'dspo-action', onClick: () => newBtwTopic(key) }, t('btwNewTopic'))
            : null,
          h('span', { className: 'dspo-btw-meta' }, `${session.draft.length} / ${maxQuestion}`),
          session.totalMs > 0
            ? h(
                'span',
                { className: 'dspo-btw-meta' },
                t('btwTimings', { first: seconds(session.firstTextMs), total: seconds(session.totalMs) }),
              )
            : null,
        ),
        session.notice !== null
          ? h('div', { className: 'dspo-btw-meta' }, t(BTW_NOTICES[session.notice] ?? session.notice))
          : null,
        session.error !== null
          ? h(
              'div',
              { className: 'dspo-btw-error', role: 'alert' },
              session.error.message !== undefined && session.error.message !== '' ? session.error.message : t('btwFailed'),
            )
          : null,
        limits?.historyFile !== undefined
          ? h('div', { className: 'dspo-btw-meta' }, `${t('btwHistoryFile')}：${limits.historyFile}`)
          : null,
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

    /* ───────────────────────── rollback ───────────────────────── */

    /**
     * The rollback entry under one completed turn.
     *
     * "Roll the conversation back to a message" cannot mean deleting events: the
     * session log is append-only, and the engine's own answer to "give me this
     * session up to here" is `sessions.fork({ atSeq })` — an exact inclusive
     * event prefix copied into a **new** session. The chat view already carries a
     * per-turn branch icon, but that one is disabled for every turn with content
     * after it (its tooltip says so: only the last message of a completed turn),
     * and the session menu's fork is the same action pinned to the newest turn.
     * What neither can express is the *point*. This seat supplies exactly that,
     * with the payload the shell itself would have sent — `{ sessionId, atSeq,
     * increaseTitle: true }`, then `uiWorkspace.openSession(childId)` on the
     * created child — so the completed turn hands us its closing seq, one click
     * copies the session up to the end of that turn, and the copy is opened.
     * Continuing there is what "going back to this turn" means; the session the
     * turn came from is never rewritten.
     *
     * Everything is feature-detected at the point of use, and the two
     * degradations are honest ones: without `sessions` the entry says it cannot
     * work instead of failing silently, and without `uiWorkspace` the copy is
     * still made and the entry points at the session list instead of pretending
     * to have switched.
     * @param {object} props - turn-tail slot props (`turn`, `seq`, `sessionId`).
     * @returns {import('react').ReactElement|null} the entry, or null without a usable boundary.
     */
    function RewindTail(props) {
      const t = useText()
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
      const boundary = typeof props?.seq === 'number' && Number.isFinite(props.seq) ? props.seq : null
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      // The child is opened as soon as the host catalogues it, which is what
      // unmounts this very entry; a settle that lands after that must not touch
      // state again.
      const alive = useRef(true)
      useEffect(() => () => {
        alive.current = false
      }, [])

      const rewind = useCallback(() => {
        if (busy || boundary === null || sessionId === '') return
        const sessions = clientService('sessions')
        if (sessions === null || typeof sessions.fork !== 'function') {
          setNotice({ kind: 'error', text: t('rewindUnavailable') })
          return
        }
        const workspace = clientService('uiWorkspace')
        // The child is observed through `onCreated`; whether it could also be
        // opened is a separate fact. The two are tracked apart because `fork`
        // renames an inherited title *after* creation: a late rejection still
        // means the copy exists.
        let child = null
        let opened = false
        const open = (childId) => {
          child = childId
          if (workspace === null || typeof workspace.openSession !== 'function') return
          try {
            workspace.openSession(childId)
            opened = true
          } catch {
            /* the copy exists either way; the notice below says where it went */
          }
        }
        const report = () => {
          setNotice({ kind: 'ok', text: opened ? t('rewindDone') : t('rewindDoneList') })
        }
        setBusy(true)
        setNotice(null)
        Promise.resolve()
          .then(() => sessions.fork({
            sessionId,
            atSeq: boundary,
            increaseTitle: true,
            onCreated: open,
          }))
          .then(() => {
            if (!alive.current) return
            setBusy(false)
            report()
          })
          .catch((error) => {
            if (!alive.current) return
            setBusy(false)
            if (child !== null) {
              report()
              return
            }
            setNotice({ kind: 'error', text: t('rewindFailed', { message: String(error?.message ?? error ?? 'unknown') }) })
          })
      }, [boundary, busy, sessionId, t])

      if (boundary === null) return null
      return h(
        'span',
        { className: 'dspo-rewind' },
        h(
          'button',
          {
            type: 'button',
            className: 'dspo-rewind-btn',
            disabled: busy,
            title: t('rewindHint'),
            onClick: rewind,
          },
          busy ? t('rewindBusy') : `⤴ ${t('rewindButton')}`,
        ),
        notice !== null ? h('span', { className: 'dspo-rewind-note', 'data-kind': notice.kind }, notice.text) : null,
      )
    }

    /**
     * The 「插件优化集合」 settings page, in three groups — model and effort, rewrite
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

      /* ── 旁路提问 ── */
      const btwInfo = state?.btw ?? null
      const btwContextChoices = Array.isArray(btwInfo?.contextTurnChoices) && btwInfo.contextTurnChoices.length > 0
        ? btwInfo.contextTurnChoices
        : [BTW_CONTEXT_ALL, 0, 4, 8, 16]
      const btwContext = settings?.btwContextTurns ?? BTW_CONTEXT_ALL
      const btwKeepsHistory = settings?.btwSaveHistory !== false

      const btwContextRow = settingRow({
        id: 'dspo-btw-context',
        label: t('btwContextLabel'),
        hint: t('btwContextHint'),
        control: h(
          'select',
          {
            className: 'dspo-select',
            id: 'dspo-btw-context',
            value: String(btwContext),
            onChange: (event) => {
              const value = String(event.target.value)
              void save({ btwContextTurns: value === BTW_CONTEXT_ALL ? BTW_CONTEXT_ALL : Number(value) }, t('saved'))
            },
          },
          btwContextChoices.map((choice) =>
            h(
              'option',
              { key: String(choice), value: String(choice) },
              choice === BTW_CONTEXT_ALL
                ? t('btwContextAllOption')
                : Number(choice) === 0
                  ? t('btwContextNone')
                  : t('btwContextN', { n: choice }),
            ),
          ),
        ),
      })

      const btwHistoryRow = settingRow({
        id: 'dspo-btw-history',
        label: t('btwSaveHistoryLabel'),
        hint: t('btwSaveHistoryHint'),
        control: h('input', {
          type: 'checkbox',
          id: 'dspo-btw-history',
          className: 'dspo-check-input',
          checked: btwKeepsHistory,
          onChange: (event) => void save({ btwSaveHistory: event.target.checked }),
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

      const btwGroup = h(
        'section',
        { className: 'dspo-set-group' },
        h('div', { className: 'dspo-set-group-title' }, t('groupBtw')),
        btwContextRow,
        btwHistoryRow,
        h('p', { className: 'dspo-set-warn' }, t('btwPrivacyNote')),
        notesBlock(t, [
          { label: t('btwContextLabel'), text: t('btwContextHint') },
          { label: t('btwSaveHistoryLabel'), text: t('btwSaveHistoryHint') },
        ]),
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
        btwGroup,
        promptGroup,
        h(
          'div',
          { className: 'dspo-meta' },
          h('span', { className: 'dspo-set-hint' }, `${t('configFile')}：`),
          h('span', { className: 'dspo-path' }, state?.configFile ?? ''),
        ),
        btwInfo?.historyFile !== undefined
          ? h(
              'div',
              { className: 'dspo-meta' },
              h('span', { className: 'dspo-set-hint' }, `${t('btwHistoryFile')}：`),
              h('span', { className: 'dspo-path' }, btwInfo.historyFile),
            )
          : null,
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
     * Register the composer buttons, the review card, the side-question panel,
     * the rollback entry and the settings page. The stylesheet and all of those
     * registrations are effects of this fiber, so an unload or hot reload removes
     * exactly what this plugin added.
     * @param {object} ctx - client root context.
     */
    function apply(ctx) {
      clientContext = ctx
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
      // The registrations are single lines on purpose: the deployment's plugin
      // precheck reads the bundle's literal `register({ name: …` calls. The two
      // composer-row entries need distinct ids: a list slot rejects a second
      // entry under an id it already holds, and that rejection fails activation.
      ctx.effect(() => ctx.slots.inject(COMPOSER_SLOT, () => ctx.slots.register({ name: 'conversation.input.left', id: ID, order: COMPOSER_ORDER }, OptimizeButton)), 'dsh-prompt-optimizer: composer button')
      ctx.effect(() => ctx.slots.inject(COMPOSER_SLOT, () => ctx.slots.register({ name: 'conversation.input.left', id: ID + '-btw', order: COMPOSER_ORDER + 1 }, BtwButton)), 'dsh-prompt-optimizer: side-question button')
      ctx.effect(() => ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({ name: 'conversation.input.overlay', id: ID, order: OVERLAY_ORDER }, BtwPanel)), 'dsh-prompt-optimizer: side-question panel')
      ctx.effect(() => ctx.slots.inject(DOCK_SLOT, () => ctx.slots.register({ name: 'conversation.input.dock', id: ID, order: DOCK_ORDER }, TaskPanel)), 'dsh-prompt-optimizer: review card')
      ctx.effect(() => ctx.slots.inject(SETTINGS_SLOT, () => ctx.slots.register({ name: 'settings.section', id: ID, order: SETTINGS_ORDER, label: () => DICT[locale].settingsNav }, SettingsPanel)), 'dsh-prompt-optimizer: settings page')
      // The rollback entry rides the chat view's own completed-turn tail. Its id
      // is its own on purpose: a fresh id is added beside the shipped entries,
      // while reusing one of theirs would replace that entry.
      ctx.effect(() => ctx.slots.inject(TURN_TAIL_SLOT, () => ctx.slots.register({ name: 'conversation.chat.turnTail', id: ID + '-rewind', order: REWIND_ORDER }, RewindTail)), 'dsh-prompt-optimizer: rollback entry')
      // The client-owned `/btw` command: the panel's third door, and the one the
      // `/` menu advertises. Registered softly — a shell without the command
      // service keeps the button and the shortcut and only loses the menu row.
      // Reading the service is inside the try as well: an undeclared cordis
      // service throws on property access here, and that throw would fail the
      // whole activation instead of dropping one menu row.
      ctx.effect(() => {
        let commandUi
        try {
          commandUi = ctx.commandUi ?? (typeof ctx.get === 'function' ? ctx.get('commandUi') : undefined)
        } catch {
          return () => {}
        }
        if (commandUi === null || commandUi === undefined || typeof commandUi.register !== 'function') return () => {}
        try {
          return commandUi.register({
            name: 'btw',
            label: () => DICT[locale].btwCommandLabel,
            description: () => DICT[locale].btwCommandDescription,
            available: () => true,
            ui: {
              kind: 'action',
              run: (session) => {
                const id = typeof session?.sessionId === 'string' && session.sessionId !== '' ? session.sessionId : 'anonymous'
                openBtw(id)
              },
            },
          })
        } catch {
          // A name collision with another plugin's command is that plugin's
          // problem to report; it must not fail this one's activation.
          return () => {}
        }
      }, 'dsh-prompt-optimizer: /btw command')
    }

    exports.apply = apply
    exports.OptimizeButton = OptimizeButton
    exports.TaskPanel = TaskPanel
    exports.SettingsPanel = SettingsPanel
    exports.BtwButton = BtwButton
    exports.BtwPanel = BtwPanel
    exports.RewindTail = RewindTail
    /** Exposed so `scripts/check.mjs` can drive the stores without a browser. */
    exports.settingsStore = settingsStore
    exports.sessions = sessions
    exports.readSession = readSession
    exports.patchSession = patchSession
    exports.clearSession = clearSession
    exports.sessionKey = sessionKey
    exports.runRewrite = runRewrite
    exports.runStream = runStream
    exports.streamAction = streamAction
    exports.DICT = DICT
    exports.btwSessions = btwSessions
    exports.readBtw = readBtw
    exports.patchBtw = patchBtw
    exports.openBtw = openBtw
    exports.closeBtw = closeBtw
    exports.newBtwTopic = newBtwTopic
    exports.runBtw = runBtw
    exports.btwContext = btwContext
    exports.persistBtw = persistBtw
    exports.ensureFullHistory = ensureFullHistory
    exports.clientService = clientService
    return module.exports
  },
})

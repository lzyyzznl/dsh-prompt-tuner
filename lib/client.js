/**
 * dsh-prompt-tuner — browser half.
 *
 * Five registrations, one of them floating:
 *   1. `conversation.input.left` — one compact ✨ button in the composer tool
 *      row, at the right of the permission selector. Alt+O triggers it.
 *   2. `conversation.input.left` — the 💬 side-question button beside it.
 *      Alt+B opens the same panel `/btw` opens.
 *   3. `conversation.input.overlay` — the side-question panel itself, floating
 *      inside the composer card.
 *   4. `conversation.input.dock` — the review card above the composer: the
 *      rewrite streams in there, next to the draft it replaces, with the model's
 *      assumptions, the timings and 采用 / 撤销 / 再改一次.
 *   5. `settings.section` — the 「插件优化集合」 page: the optimization prompt
 *      itself, how many of the session's newest records a rewrite carries, and
 *      the other features' own tabs (side questions, titles, compaction,
 *      notifications). The rewrite has no other knob: one mode, the session's
 *      own model, no thinking, applied straight into the draft.
 *   6. plus the client-owned `/btw` composer command, which opens seat 3.
 *
 * The draft is read from the slot's `useInput` selector and written back through
 * `inputActions.setDraft`, so the plugin never touches the editor's DOM and the
 * host keeps ownership of the draft, undo history, and submission. The draft
 * revision is read too: an answer is applied automatically only while the draft
 * still is the text that was sent, otherwise it waits in the review card —
 * typing during a rewrite can therefore never be overwritten silently.
 *
 * The rewrite reads the conversation through the chat view's own snapshot
 * (`useChat`), taking its newest N records in flow order — the same source and
 * the same unit the side-question half counts, and `0` (carry nothing) is a
 * first-class setting.
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
    /** How many in-flight deltas one second of streaming may draw. */
    const DELTA_FRAME_MS = 80
    /**
     * The "carry everything" value of the context setting, mirroring the host's
     * `BTW_CONTEXT_ALL`. The browser half may not import host modules, so the two
     * halves agree on the literal instead — and the self-test pins both.
     */
    const BTW_CONTEXT_ALL = 'all'
    /**
     * The select's sentinel for the 「最近 N 条」 mode, mirroring no stored value:
     * the mode is this browser half's own, and choosing it writes the count it
     * remembers (a positive integer) into `btwContextTurns`. It exists because a
     * single scalar holds three different answers — every record, the newest N,
     * or none — and only the last two have numbers to name them by.
     */
    const BTW_CONTEXT_COUNT = 'count'
    /**
     * What the count input shows when neither the active setting nor the host
     * names a usable number, mirroring the host's `DEFAULT_BTW_CONTEXT_COUNT`.
     */
    const DEFAULT_BTW_CONTEXT_COUNT = 8
    /**
     * The effort both halves start at, mirroring the host's `DEFAULT_EFFORT`.
     * Used only as the fallback when `/state` has not answered yet; the host is
     * the one that actually persists and applies it.
     */
    const DEFAULT_EFFORT = 'off'
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
        noModel: '没有可用的模型：本功能跟随当前会话的模型，请先在会话里选好模型',
        chips: '草稿里有 {n} 个引用芯片（@文件 / 命令）：整稿改写会丢失它们，请先移除引用再优化',
        shortcutHint: '快捷键 Alt+O',
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
        // settings page
        settingsNav: '插件优化集合',
        settingsTitle: 'DSH 插件优化集合',
        settingsIntro: '输入框旁的 ✨ 把草稿改写为指向更明确、更有逻辑的提示词：用内置默认提示词（或你自定义的那一份），跟随当前会话的模型，并可把最近的会话消息一起带上。',
        notes: '说明',
        activeModel: '当前：{provider} · {model}',
        noModels: '还没有可用的模型：先到「设置 → 模型」里添加一个 provider。',
        rewriteModelFollow: '跟随当前会话的模型：{provider} · {model}',
        rewriteModelFallback: '跟随当前会话的模型（会话未选模型时用模型目录里的第一个）',
        rewriteNoThinking: '不开启思考：改写是理解任务，思考只会多花几秒。',
        effortAuto: '跟随适配器默认（auto）',
        effortOff: '关闭（off）— 最快',
        effortLow: '低（low）— 少量推理',
        effortHigh: '高（high）— 适配器默认值',
        effortMax: '最高（max）— 最慢',
        effortAdvertised: '当前路由支持：{list}',
        effortAdvertisedDefault: '当前路由支持：{list}（适配器默认 {fallback}）',
        effortUnknown: '当前路由未声明可选强度，将直接尝试所选值。',
        effortDegraded: '当前路由不支持所选强度，已改用 {value}。',
        recentMessagesLabel: '携带最近会话消息',
        recentMessagesHint:
          '把最近 N 条会话记录按时间正序拼在草稿前面，让「刚才那个」「上面说的」这类指代可以被理解。记录按会话日志的条目计（一条消息、一次工具调用及其结果各算一条），0 = 不带（只发送草稿）。',
        recentMessagesInvalid: '请填 {min}–{max} 之间的整数，这次没有保存',
        recentMessagesOff: '不带会话上下文',
        recentMessagesN: '最近 {n} 条记录',
        promptLabel: '自定义优化提示词',
        outputLangLabel: '改写输出的语言',
        outputLangHint:
          '决定改写后的提示词正文用哪种语言；标识符、路径、命令、接口名、变量名与引用的原文始终原样保留，不翻译。默认跟随界面语言，你选过之后以选择为准。',
        outputLangCustomHint: '当前用的是你的自定义提示词；语言指令会追加在它之后，优先级最高。',
        outputLangZh: '中文',
        outputLangEn: '英文',
        promptHint:
          '作为系统提示发给模型。留空即使用内置默认；文本框只保存你的自定义内容，不会自动填入默认，避免误存。',
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
        btwIntro: '临时问一个小问题：默认带上这个会话的完整原始记录（消息、工具调用及其结果），答案流式返回、只显示在这里——不写进主对话，也不会执行任何命令或写入任何内容。',
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
        btwContextAll: '已带全部 {n} 条会话记录',
        btwContextOn: '已带最近 {n} 条会话记录',
        btwContextOff: '未带会话上下文',
        btwContextUnavailable: '读不到会话记录，本次只发送问题本身',
        btwLoadingHistory: '正在载入更早的历史…（已带 {n} 条记录）',
        btwContextWindowOnly: '已带当前已加载的 {n} 条会话记录（更早的历史未载完）',
        btwContextLoadedOnly: '已带当前已加载的 {n} 条会话记录',
        btwEmptyQuestion: '先写下你想问什么',
        btwTooLong: '问题超过 {max} 字上限，先精简一下',
        btwFailed: '旁路提问未完成',
        btwCancelled: '已取消，保留已显示的部分',
        btwReshaped: '这一轮的历史被折成单轮重问了一次（模型适配器不接受多轮形式），回答按同样的问题与上下文给出',
        btwTimings: '首字 {first} · 共 {total}',
        btwContextLabel: '携带上下文',
        btwContextHint: '默认「全部历史记录」：进入会话时插件会把更早的分页补齐，再把整个会话的原始记录整份带上——消息、工具调用及其结果都在内，不过滤、不截断。也可以只带最近 N 条记录（N 自己填，正整数，不设上限），或完全不带（选「不带」时不会去拉整段历史）。',
        btwContextAllOption: '全部历史记录（默认）',
        btwContextNone: '不带上下文',
        btwContextCountOption: '最近 N 条记录',
        btwContextCountLabel: '携带的最近记录条数',
        btwContextCountTitle: '正整数，不设上限；填写后就切换为「最近 N 条记录」',
        btwContextCountUnit: '条记录',
        btwContextCountInvalid: '请填不小于 {min} 的整数，这次没有保存',
        btwSaveHistoryLabel: '保存旁路历史',
        btwSaveHistoryHint: '写到宿主的旁路历史文件；关闭后只留在本次页面内存里。这是插件自己的本地记录，不是会话写入。',
        btwModelLabel: '旁路模型',
        btwEffortLabel: '旁路思考强度',
        btwModelHint: '旁路提问只列当前已配置的模型路由；不选就跟随当前会话的模型（与「优化提示词」一致），选了只影响旁路提问，不动「优化提示词」那一份。',
        btwEffortHint: '旁路提问自己的思考强度，取值与「标题」相同（auto / off / low / high / max）；不选时两边都用 off，路由不支持所选值时就近降级。',
        btwHistoryFile: '旁路历史文件',
        btwPrivacyNote: '旁路提问会读取会话内容：默认把整个会话的原始记录（含工具调用及其结果）随问题一起发给模型（可在上面收窄或不带）。改写功能只发送草稿与「携带最近会话消息」允许的那几条记录（设为 0 就只发草稿）。旁路提问全程只读——不执行命令、不写会话、不写草稿。',
        // settings tabs
        settingsTabs: '设置分组',
        tabOptimize: '优化提示词',
        tabBtw: '旁路提问',
        tabCompaction: '压缩',
        tabTitle: '标题',
        tabNotify: '通知',
        // context compaction threshold
        compactionLabel: '上下文压缩阈值',
        compactionHint:
          '按「固定 token 数」给每个模型设一条压缩线：DSH 自己的开关是窗口占比，混合模型目录里没有一条占比是对的，所以这里按模型分别记，插件再把每个模型换算成它需要的占比（占比 = 阈值 ÷ 该模型窗口大小，窗口约掉，阈值就是你要的那个绝对数）。',
        compactionHintShort: '按模型设固定 token 数',
        compactionNoModels: '还没有可用的模型：先到「设置 → 模型」里添加一个 provider，再回来设阈值。',
        compactionWindow: '上下文窗口',
        compactionWindowUnknown: '未声明',
        compactionPlaceholder: '留空 = 不改',
        compactionSave: '保存阈值',
        compactionRange: '可设范围 {min} – {max} tokens',
        compactionApply: '写入 DSH 配置',
        compactionApplyHint: '点一下才写入；写入走 profile 的配置编辑器，校验失败会自动回滚。',
        compactionApplied: '已写入 compaction-basic：{n} 条规则',
        compactionApplyFailed: '未写入：{reason}',
        compactionEditorMissing: '本部署没有暴露配置编辑器（configEditor），插件不能替你写；可用下面的片段手动加入 DSH 补丁。',
        compactionYaml: '等效补丁片段',
        compactionCopy: '复制',
        compactionCopied: '已复制',
        compactionCopyFailed: '复制失败，请手动选中',
        compactionSkipped: '以下模型未生效：{list}',
        compactionCapped: '以下模型窗口放不下所设阈值，已按窗口上限截断：{list}',
        compactionRefresh: '刷新模型与窗口',
        compactionLoading: '正在读取模型窗口…',
        // desktop notification on completion
        notifyToggle: '任务完成时发桌面通知',
        notifyHint:
          '每个对话任务结束时弹一条系统通知：标题取该会话的标题，正文由下面选定的模型把本轮回答压缩成一句能完整显示的话（不选就跟随当前会话的模型）。压缩调用固定关闭思考，也绝不把原始回复直接推出去：摘要按「摘要最多显示字符数」生成，仍然超长会再压一次，再超长才以 ... 结尾（剪断的地方看得见）。模型调不动、路由没模型或超时时，通知照发，正文写「本轮已结束，摘要不可用」，原因记在插件日志和这次请求的返回里。由宿主进程按平台分发——Linux 用 notify-send，Windows 用 PowerShell 通知，WSL 走 Windows 通知。',
        notifyHintShort: '任务结束时弹系统通知（标题=会话标题，正文=模型压缩的一句话）',
        notifyPlatformLabel: '本机通知方式',
        notifyPlatformLinux: 'Linux · notify-send',
        notifyPlatformWindows: 'Windows · PowerShell 通知',
        notifyPlatformNone: '本机没有可用的桌面通知（无 DISPLAY / Wayland，或平台不支持）',
        notifyTest: '发送测试通知',
        notifyTestSent: '已发送测试通知',
        notifyTestFailed: '测试通知未发出：{reason}',
        notifyTitleSource: '标题：会话标题 · 正文：模型压缩的本轮回答',
        notifyModelLabel: '摘要模型',
        notifyModelHint:
          '这个模型只做一件事：把本轮回答压到「摘要最多显示字符数」以内。不选就跟随当前会话的模型（与「优化提示词」的零配置默认一致），选了只影响通知正文，不动其他功能的模型。这里永远关闭思考。',
        notifySummaryUnsupported:
          '这个宿主没有上报通知摘要的契约（版本不匹配）：正文不会被模型压缩，只会按上面的长度剪短并加 ...，所以模型选项不显示。',
        notifyOn: '已开启',
        notifyBodyUnavailable: '本轮没有可用的回答摘要',
        notifyOptions: '选项',
        notifyCharsLabel: '摘要最多显示字符数',
        notifyCharsHint: '超过就以 ... 结尾；可填 {min}–{max}，回车或离开输入框即保存',
        notifyCharsInvalid: '请填 {min}–{max} 之间的整数，这次没有保存',
        // session titles
        titleHint:
          '初始标题仍是会话的第一句话，由 DSH 自己生成，本插件不动它。每到设定的轮数，本插件用你在上面选的模型，根据最近同样多的消息重新总结一次标题，并把结果作为一条标题修订写进会话日志（回放、恢复后依然有效，也绝不会进入模型上下文）。模型调不动、路由没有可用模型或会话已经关掉时，标题保持原样，只记一条日志，下个轮数再试。',
        titleModelLabel: '标题模型',
        titleModelHint:
          '重总结标题用的模型：不选就跟随会话当前模型（和你现在用的一致），选了就固定用它；它与「旁路提问」的模型互不影响。',
        titleEffortLabel: '标题思考强度',
        titleEffortHint: '标题只有一行，默认 off：思考 token 既费时间又不会被采用。',
        titleRerollLabel: '每多少轮重总结标题',
        titleRerollHint: '每积累这么多条你的消息，就用最近同样多的消息重总结一次；可填 {min}–{max}，回车或离开输入框即保存',
        titleRerollInvalid: '请填 {min}–{max} 之间的整数，这次没有保存',
        titleMaxCharsLabel: '标题长度上限',
        titleMaxCharsHint: '重总结出的标题最长这么多字符，超出以 ... 结尾；可填 {min}–{max}，回车或离开输入框即保存',
        titleMaxCharsInvalid: '请填 {min}–{max} 之间的整数，这次没有保存',
        titleUnsupported: '这个宿主没有上报会话标题的配置契约（版本不匹配）：这一页的开关不会生效，所以不显示。',
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
        noModel: 'No model available: this feature follows the session model — pick one in the conversation first',
        chips: 'The draft holds {n} reference chip(s) (@file / command): a whole-draft rewrite would drop them — remove the references first',
        shortcutHint: 'Shortcut: Alt+O',
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
        settingsNav: 'Plugin suite',
        settingsTitle: 'DSH plugin suite',
        settingsIntro:
          'The ✨ button beside the composer rewrites your draft into a more clearly-directed, better-ordered prompt: it uses the built-in default prompt (or the one you write), follows the current session model, and can carry the newest conversation messages along with the draft.',
        notes: 'Details',
        activeModel: 'In use: {provider} · {model}',
        noModels: 'No model yet: add a provider under Settings → Models first.',
        rewriteModelFollow: 'Follows the current session model: {provider} · {model}',
        rewriteModelFallback: 'Follows the current session model (falls back to the first catalog model)',
        rewriteNoThinking: 'Thinking is off: a rewrite is a comprehension task, so thinking only costs seconds.',
        effortAuto: 'Adapter default (auto)',
        effortOff: 'off — fastest',
        effortLow: 'low — some reasoning',
        effortHigh: 'high — adapter default',
        effortMax: 'max — slowest',
        effortAdvertised: 'This route supports: {list}',
        effortAdvertisedDefault: 'This route supports: {list} (adapter default {fallback})',
        effortUnknown: 'This route does not advertise efforts; the chosen value is sent as is.',
        effortDegraded: 'This route does not support the chosen effort; {value} was used instead.',
        recentMessagesLabel: 'Carry recent session messages',
        recentMessagesHint:
          'Puts the newest N conversation records, in time order, ahead of the draft so references like "the one above" can be resolved. One record is one entry of the session log (a message, a tool call, or its result); 0 means carry none (the draft travels alone).',
        recentMessagesInvalid: 'Enter an integer between {min} and {max}; nothing was saved',
        recentMessagesOff: 'No conversation context',
        recentMessagesN: 'Newest {n} record(s)',
        promptLabel: 'Custom optimization prompt',
        outputLangLabel: 'Language of the rewritten prompt',
        outputLangHint:
          'Which language the rewritten prompt itself is written in. Identifiers, paths, commands, interface names, variable names and quoted source text always stay verbatim. Follows the interface language until you choose one, then your choice wins.',
        outputLangCustomHint: 'Your custom prompt is in force; the language line is appended after it with the highest priority.',
        outputLangZh: 'Chinese',
        outputLangEn: 'English',
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
        btwIntro: 'A quick question that carries the whole session record by default (messages, tool calls and their results): the answer streams here and is never written into the conversation — no command runs and nothing is written anywhere.',
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
        btwContextAll: 'All {n} conversation record(s) carried',
        btwContextOn: 'Last {n} conversation record(s) carried',
        btwContextOff: 'No conversation context',
        btwContextUnavailable: 'The transcript is unavailable, so only the question itself is sent',
        btwLoadingHistory: 'Loading earlier history… ({n} record(s) carried so far)',
        btwContextWindowOnly: 'Carrying the {n} loaded conversation record(s); earlier history is not loaded yet',
        btwContextLoadedOnly: 'Carrying the {n} loaded conversation record(s)',
        btwEmptyQuestion: 'Write the question first',
        btwTooLong: 'The question exceeds {max} characters — shorten it first',
        btwFailed: 'The side question did not finish',
        btwCancelled: 'Cancelled — what was shown stays',
        btwReshaped: 'This round re-asked the thread as a single turn (the model adapter rejected the multi-turn form); same question, same context',
        btwTimings: 'first token {first} · {total} total',
        btwContextLabel: 'Carry context',
        btwContextHint: 'Default "all history": entering a conversation walks its earlier pages in, and the whole record is then carried with no count cap and no trimming — messages, tool calls and their results included. Narrow it to the last N records (type any positive integer; there is no upper bound), or carry none (choosing none never pulls the history).',
        btwContextAllOption: 'All history (default)',
        btwContextNone: 'No context',
        btwContextCountOption: 'Last N records',
        btwContextCountLabel: 'How many recent records to carry',
        btwContextCountTitle: 'Any positive integer, no upper bound; typing one switches to "Last N records"',
        btwContextCountUnit: 'record(s)',
        btwContextCountInvalid: 'Enter an integer of at least {min}; nothing was saved',
        btwSaveHistoryLabel: 'Keep side-question history',
        btwSaveHistoryHint: 'Written to the host history file; when off it lives in this page only. This is the plugin\'s own local record, not a conversation write.',
        btwModelLabel: 'Side-question model',
        btwEffortLabel: 'Side-question reasoning effort',
        btwModelHint: 'Only models you have configured are listed. Leaving it unchosen follows the session\'s own model, the same default the rewrite uses; choosing one affects side questions only and leaves the rewrite alone.',
        btwEffortHint: 'The side-question half\'s own reasoning effort, with the same choices as the title half (auto / off / low / high / max). Unchosen means off on both sides, and an unsupported value degrades to the closest one the route accepts.',
        btwHistoryFile: 'History file',
        btwPrivacyNote: 'Side questions read the conversation: by default the whole session record travels with the question — tool calls and their results included (narrow it above if you prefer). The rewrite sends the draft plus the few records "Carry recent session messages" allows (0 sends the draft alone). A side question is read-only throughout — no command runs, no conversation write, no draft write.',
        // settings tabs
        settingsTabs: 'Settings sections',
        tabOptimize: 'Prompt optimization',
        tabBtw: 'Side questions',
        tabCompaction: 'Compaction',
        tabTitle: 'Titles',
        tabNotify: 'Notify',
        // context compaction threshold
        compactionLabel: 'Context compaction threshold',
        compactionHint:
          'Set a fixed token count per model. DSH\'s own knob is a fraction of the context window, and no single fraction is right across a mixed catalog — so each model is recorded separately and this plugin converts it to the ratio DSH needs (ratio = tokens / that model\'s window; the window cancels, leaving the absolute number you typed).',
        compactionHintShort: 'A fixed token count, per model',
        compactionNoModels: 'No models yet: add a provider under Settings → Model, then come back.',
        compactionWindow: 'Context window',
        compactionWindowUnknown: 'not advertised',
        compactionPlaceholder: 'blank = leave it',
        compactionSave: 'Save thresholds',
        compactionRange: 'Allowed range {min} – {max} tokens',
        compactionApply: 'Write to DSH config',
        compactionApplyHint: 'Nothing is written until you click; the write goes through the profile config editor and rolls back if validation fails.',
        compactionApplied: 'Wrote {n} rule(s) to compaction-basic',
        compactionApplyFailed: 'Not written: {reason}',
        compactionEditorMissing: 'This deployment exposes no config editor (configEditor), so the plugin cannot write for you; the fragment below can be added to the DSH patch by hand.',
        compactionYaml: 'Equivalent patch fragment',
        compactionCopy: 'Copy',
        compactionCopied: 'Copied',
        compactionCopyFailed: 'Copy failed — select it manually',
        compactionSkipped: 'Not in effect: {list}',
        compactionCapped: 'These models cannot fit the threshold, so it was capped to the window: {list}',
        compactionRefresh: 'Refresh models and windows',
        compactionLoading: 'Reading model windows…',
        // desktop notification on completion
        notifyToggle: 'Desktop notification when a task finishes',
        notifyHint:
          'Shows one system notification when each conversation task ends: the title is that session\'s title, and the body is this turn\'s answer condensed into one line by the model you pick below (unchosen, it follows the session\'s own model). That call never thinks, and the raw reply is never pushed directly: the summary is generated to the "Max summary characters" budget, asked for once more if it still overshoots, and only a second overshoot ends with ... (the cut stays visible). If the call fails, times out, or no route is available, the notification still goes out saying so, and the reason is in the plugin log and in that request\'s answer. The host process dispatches it per platform — notify-send on Linux, a PowerShell toast on Windows, and WSL routes to the Windows toast.',
        notifyHintShort: 'A system notification when a task ends (title = session title, body = one condensed line)',
        notifyPlatformLabel: 'This host dispatches via',
        notifyPlatformLinux: 'Linux · notify-send',
        notifyPlatformWindows: 'Windows · PowerShell toast',
        notifyPlatformNone: 'No desktop notification is reachable here (no DISPLAY / Wayland, or an unsupported platform)',
        notifyTest: 'Send a test notification',
        notifyTestSent: 'Test notification sent',
        notifyTestFailed: 'Test notification not shown: {reason}',
        notifyTitleSource: 'Title: session title · Body: this turn\'s answer, condensed',
        notifyModelLabel: 'Summary model',
        notifyModelHint:
          'This model does one thing: condense this turn\'s answer into the "Max summary characters" budget. Leaving it unchosen follows the session\'s own model, the same zero-configuration default the rewrite uses; choosing one affects the notification body only and leaves every other model choice alone. Thinking is always off for this call.',
        notifySummaryUnsupported:
          'This host does not advertise the notification-summary contract (version mismatch): the body is not condensed by a model and is only shortened with ... at the length above, so the model controls are hidden.',
        notifyOn: 'On',
        notifyBodyUnavailable: 'No answer summary was available for this turn',
        notifyOptions: 'Options',
        notifyCharsLabel: 'Max summary characters',
        notifyCharsHint: 'Longer text ends with ...; {min}–{max} allowed, saved on Enter or on leaving the field',
        notifyCharsInvalid: 'Enter a whole number between {min} and {max} — nothing was saved',
        // session titles
        titleHint:
          'The initial title is still the session\'s first sentence, written by DSH itself — this plugin never touches it. Once the configured number of turns accumulates, the plugin asks the model you pick above to summarize a new title from the same number of most recent messages, and records the result as one more title revision in the session log (it survives replay and restore, and never enters the model\'s context). If the call fails, no route is available, or the session is gone, the title is left as it was, a line is logged, and the next boundary tries again.',
        titleModelLabel: 'Title model',
        titleModelHint:
          'The model that re-summarizes titles: unchosen follows the session\'s own model (what you are already using), a pinned one is always used; it is independent of the side question\'s model.',
        titleEffortLabel: 'Title reasoning effort',
        titleEffortHint: 'A title is one line; the default is off, since thinking tokens cost seconds and are discarded here.',
        titleRerollLabel: 'Messages between re-titles',
        titleRerollHint: 'After this many of your messages, the title is summarized again from the same number of most recent ones; {min}–{max} allowed, saved on Enter or on leaving the field',
        titleRerollInvalid: 'Enter a whole number between {min} and {max} — nothing was saved',
        titleMaxCharsLabel: 'Max title characters',
        titleMaxCharsHint: 'A re-summarized title is at most this long, with ... past it; {min}–{max} allowed, saved on Enter or on leaving the field',
        titleMaxCharsInvalid: 'Enter a whole number between {min} and {max} — nothing was saved',
        titleUnsupported: 'This host does not advertise the session-title contract (version mismatch), so the controls here would not take effect and are hidden.',
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

    /** @type {{phase: string, rev: number, source: string, sourceRev: number, text: string, error: object|null, meta: object|null, assumptions: string|null, undoText: string|null, appliedText: string|null, stale: boolean, startedAt: number, firstTextMs: number, totalMs: number}} */
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
.dspo-set-sublabel { font-weight: 500; font-size: 13px; }
.dspo-set-hint { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.5; }
.dspo-set-status { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dspo-set-status[data-tone='ok'] { color: var(--dsw-alias-state-success-primary); }
.dspo-set-status[data-tone='error'] { color: var(--dsw-alias-state-error-primary); }
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
.dspo-input {
  height: 30px; width: 150px; padding: 0 8px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 13px;
}
.dspo-input:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dspo-input::placeholder { color: var(--dsw-alias-label-tertiary); }
.dspo-input[data-inactive='true'] { opacity: 0.55; }
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
/* The tab strip, lifted value-for-value from the shell's own plugins page
   (dsh-client-ui-settings-plugins): same underline rail, same 13px labels,
   same 2px active bar, same focus ring. Only the class prefix differs — the
   browser half may not import the shell's components. flex-wrap is the one
   addition: this page has four CJK labels and must survive a narrow panel. */
.dspo-tabs {
  display: flex; flex-wrap: wrap; align-items: flex-end; gap: 22px;
  border-bottom: .5px solid var(--dsw-alias-border-l2); margin-top: 2px;
}
.dspo-tab {
  position: relative; padding: 7px 1px 9px; border: 0; background: 0 0;
  color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 13px;
  line-height: 20px; cursor: pointer;
}
.dspo-tab:hover, .dspo-tab[data-active='true'] { color: var(--dsw-alias-label-primary); }
.dspo-tab[data-active='true']::after, .dspo-tab:focus-visible::after {
  content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px;
  border-radius: 2px 2px 0 0; background: var(--dsw-alias-label-primary);
}
.dspo-tab:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px; border-radius: 2px; color: var(--dsw-alias-label-primary);
}
/* 2px, exactly like the shipped panel: the page's own 22px column gap already
   provides the air under the rail, so a second gap here would double it. */
.dspo-tabpanel { min-width: 0; padding-top: 2px; }
@media (max-width: 560px) { .dspo-tabs { gap: 14px; } }
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
     * @param {object} input - session key, text, actions, the records to carry and the settings snapshot.
     * @returns {Promise<void>} resolves when the run settles.
     */
    async function runRewrite(input) {
      const { key, text, draftRev, actions, records } = input
      if (text.trim() === '') {
        patchSession(key, { phase: 'error', error: { code: 'empty-draft', message: 'empty' } })
        return
      }
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
        startedAt,
        firstTextMs: -1,
        totalMs: 0,
      })
      // The shell's own locale rides along as the *proposed* output language. The
      // host ignores it once the user has chosen one explicitly, so this only
      // decides the default for someone who never touched the setting — and it
      // keeps that default right without the host having to read the browser's
      // locale out of band.
      const result = await runStream(
        { text, records: Array.isArray(records) ? records : [], lang: locale },
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
      // One mode means one apply rule: replace in place while the draft is still
      // what was sent, otherwise leave the result in the card. There is no
      // setting for this — the guard *is* the safe behaviour.
      if (untouched) {
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
      // The conversation this rewrite may read: the same chat snapshot the side
      // question reads, in flow order. Only the newest N records travel, and N is
      // a setting — 0 keeps the old behaviour of sending the draft alone.
      const chatNodes = useChatNodes(props)
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
      const canOptimize = !busy && !locked && draft.trim() !== '' && active !== null && chipCount === 0

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

      /**
       * The one-click path: read the draft, run the rewrite, let it apply.
       *
       * How many records ride along comes from the same helper the card's
       * re-run uses, so a host that has not answered `/state` yet cannot make
       * the two entry points disagree about the excerpt.
       */
      const start = useCallback(() => {
        if (!canOptimize) return
        setNotice(null)
        void runRewrite({
          key,
          text: draft,
          draftRev: typeof draftRev === 'number' ? draftRev : -1,
          actions,
          records: recentRecords(chatNodes, carriedRecordCount(snapshot.state)),
          readDraft: () => draftRef.current,
        })
      }, [actions, canOptimize, chatNodes, draft, draftRev, key, snapshot.state, t])

      /** Cancel a running rewrite: the host aborts the model call on request close. */
      const stop = useCallback(() => {
        const controller = inflight.get(key)
        controller?.abort()
        patchSession(key, { phase: 'idle', error: null })
      }, [key])

      /**
       * Alt+O, while the composer holds the caret.
       *
       * Always on: with one mode there is nothing to switch off, and the guard is
       * the same one the button has — a focused editable element, no modifiers.
       */
      useEffect(() => {
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
      }, [start])

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
          : active === null
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
      const chatNodes = useChatNodes(props)
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
          records: recentRecords(chatNodes, carriedRecordCount(snapshot.state)),
          readDraft: () => draftRef.current,
        })
      }

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

    /**
     * One conversation record, serialized exactly as the snapshot publishes it.
     *
     * A side question is answered against the same context the main conversation
     * has, so nothing here is picked, filtered or trimmed: the messages, the tool
     * calls and their results, the reasoning, the context injections, the
     * commands and the compaction summaries all travel with the question. The
     * serializer is the only transformation — an unserializable value degrades to
     * its string form, a cycle to a marker — because a record dropped here is a
     * record the model will confidently answer without.
     * @param {unknown} record - one record from the chat snapshot.
     * @returns {string} its JSON form.
     */
    function btwRecord(record) {
      const seen = new WeakSet()
      try {
        const json = JSON.stringify(record, (_key, value) => {
          if (typeof value === 'function' || typeof value === 'bigint') return String(value)
          if (value !== null && typeof value === 'object') {
            if (seen.has(value)) return '[Circular]'
            seen.add(value)
          }
          return value
        })
        return typeof json === 'string' ? json : String(record)
      } catch {
        return String(record)
      }
    }

    /**
     * Reduce the loaded transcript to the excerpt one side question carries.
     *
     * `turns` is the setting: {@link BTW_CONTEXT_ALL} carries **every** record of
     * the session, a number keeps that many recent records, and `0` carries
     * nothing. In every mode a record travels whole — this half never trims a
     * record and never drops one to fit a character budget, so "all" really is
     * all and a tool result arrives together with the call it answers. The host
     * caps neither: half a transcript would have the model answer about a
     * conversation it never saw, which is worse than a long request.
     *
     * Note the unit: the setting counts records, not session turns, because the
     * conversation is a sequence of records (a message, a tool call, a tool
     * result), and one user message plus one answer is already two entries.
     * @param {Array<unknown>} nodes - the chat snapshot's records, in flow order.
     * @param {number|string} turns - how much history to carry.
     * @returns {{text: string, messages: number}} the excerpt and how many records it holds.
     */
    function btwContext(nodes, turns) {
      if (!Array.isArray(nodes)) return { text: '', messages: 0 }
      const all = turns === BTW_CONTEXT_ALL
      const limit = all ? Number.POSITIVE_INFINITY : Number.isFinite(Number(turns)) ? Math.max(0, Math.trunc(Number(turns))) : 0
      if (limit === 0) return { text: '', messages: 0 }
      const kept = limit === Number.POSITIVE_INFINITY ? nodes : nodes.slice(-limit)
      const text = kept.map((record) => btwRecord(record)).join('\n')
      return { text, messages: kept.length }
    }

    /**
     * The newest `limit` conversation records of one session, serialized, in
     * flow order (oldest first).
     *
     * The rewrite's own excerpt: same source and same unit as a side question's,
     * but the count is the `携带最近会话消息` setting and each record travels as
     * its own string, so the host can enforce the same count independently and
     * so an ordered array (not one blob) arrives. `0` — or a session with nothing
     * loaded yet — yields `[]`, and the host then frames the draft alone.
     * @param {Array<unknown>} nodes - the chat snapshot's records, in flow order.
     * @param {number} limit - how many of the newest records to carry.
     * @returns {string[]} one JSON string per kept record, oldest first.
     */
    function recentRecords(nodes, limit) {
      if (!Number.isSafeInteger(limit) || limit <= 0 || !Array.isArray(nodes)) return []
      return nodes.slice(-limit).map((record) => btwRecord(record))
    }

    /**
     * How many records a rewrite should carry, read from the host's `/state`.
     *
     * The stored setting is authoritative; before `/state` answers (or on a host
     * that does not report the bounds) the reported default is used, and an
     * unknown host carries nothing rather than guessing a number the user never
     * chose.
     * @param {object|null|undefined} state - the `/state` view.
     * @returns {number} the record count to send.
     */
    function carriedRecordCount(state) {
      const stored = state?.settings?.recentMessages
      if (Number.isSafeInteger(stored) && stored >= 0) return stored
      const fallback = state?.limits?.defaultRecentMessages
      return Number.isSafeInteger(fallback) ? fallback : 0
    }

    /**
     * The loaded transcript, read through whichever selector this seat hands us.
     *
     * `useChat` is the chat view's own session-standard hook (a direct
     * `ChatSnapshot` selector); `useConversation` is the target-neutral snapshot
     * whose `chat` view target carries the same records. Either can be absent on
     * a shell that does not install the chat view, and both hooks are therefore
     * called unconditionally with a no-op fallback — a branch on prop presence
     * would change the hook order between renders.
     *
     * The whole transcript is returned, not just its settled text: the nodes in
     * flow order, then the tool calls still running and the assistant text still
     * streaming. A side question is usually asked while the main turn is in
     * flight, and "the conversation as it stands" is what it has to be answered
     * against (see `btwRecord`).
     * @param {object} props - slot props of a session-scoped seat.
     * @returns {Array<unknown>} conversation records in flow order, `[]` when unavailable.
     */
    function useChatNodes(props) {
      const useChat = typeof props?.useChat === 'function' ? props.useChat : () => null
      const useConversation = typeof props?.useConversation === 'function' ? props.useConversation : () => null
      const chat = useChat((state) => state)
      const target = useConversation((state) => state?.views?.get?.(CHAT_TARGET) ?? null)
      const snapshot = chat ?? target
      const legacy = snapshot?.legacy
      if (legacy === null || legacy === undefined || typeof legacy !== 'object') return []
      const records = Array.isArray(legacy.nodes) ? [...legacy.nodes] : []
      if (Array.isArray(legacy.runningCalls)) records.push(...legacy.runningCalls)
      if (legacy.partial !== null && legacy.partial !== undefined) records.push(legacy.partial)
      return records
    }

    /* ───────────────── task-completion notifications ───────────────── */

    /**
     * The chat view's busy flags, read separately from the records.
     *
     * `partial` is the assistant text still streaming and `runningCalls` are the
     * tool calls still executing: either being present is exactly "this session
     * still has work outstanding". The transition to both being empty is the
     * completion this feature notifies on — the same two flags the shell's own
     * turn navigator animates, so the notification cannot disagree with the
     * spinner the user is looking at.
     * @param {object} props - slot props of a session-scoped seat.
     * @returns {{nodes: Array<unknown>, partial: unknown, busy: boolean}} the flags.
     */
    function useChatActivity(props) {
      const useChat = typeof props?.useChat === 'function' ? props.useChat : () => null
      const useConversation = typeof props?.useConversation === 'function' ? props.useConversation : () => null
      const chat = useChat((state) => state)
      const target = useConversation((state) => state?.views?.get?.(CHAT_TARGET) ?? null)
      const legacy = (chat ?? target)?.legacy
      const nodes = legacy !== null && legacy !== undefined && Array.isArray(legacy.nodes) ? legacy.nodes : []
      const partial = legacy?.partial ?? null
      const runningCalls = legacy !== null && legacy !== undefined && Array.isArray(legacy.runningCalls) ? legacy.runningCalls : []
      return { nodes, partial, busy: partial !== null || runningCalls.length > 0 }
    }

    /**
     * Latest answer per session, kept by the mounted watcher seat.
     *
     * `{ text, seq }`: the body a notification would carry, and the identity of
     * the message it came from so a repeat edge can be told from a new turn.
     * @type {Map<string, {text: string, seq: number|null}>}
     */
    const completionSummaries = new Map()

    /**
     * The answer identity already notified, per session.
     *
     * One conversation went idle several times without producing anything new
     * and sent the *same* toast each time — fifteen identical toasts in the
     * notification history for one session. A session's running→idle edge says
     * it stopped working, not that it said something; this remembers what was
     * last said so only a new message is worth waking the user for.
     * @type {Map<string, number>}
     */
    const notifiedAnswers = new Map()

    /** The tool call that is itself a message to the user: a question with choices. */
    const QUESTION_TOOL = 'ask_user_question'

    /** A locally defined notification label; the dictionary owns the wording. */
    function notifyLabel(key) {
      return (DICT[locale] ?? DICT.zh)[key]
    }

    /**
     * The message one question tool call carries, as a notification body.
     *
     * A question is the one tool call the user is meant to read: the agent is
     * waiting for them, so the body is the question *and* the choices rather
     * than a paraphrase of them. The arguments arrive as the JSON string the
     * model produced (`{"questions":[{ question, header, options:[{label}] }]}`),
     * which is parsed defensively — a shape this narrow is worth failing closed
     * on, because the fallback is an honest "no summary" rather than a wrong one.
     * @param {unknown} raw - the tool call's raw arguments.
     * @returns {string} the question and its choices, or '' when unreadable.
     */
    function questionMessage(raw) {
      let parsed
      try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      } catch {
        return ''
      }
      const questions = Array.isArray(parsed?.questions) ? parsed.questions : []
      const label = notifyLabel('notifyOptions')
      const parts = []
      for (const question of questions) {
        if (question === null || typeof question !== 'object') continue
        const asked = String(question.question ?? question.header ?? '').trim()
        const options = Array.isArray(question.options)
          ? question.options.map((option) => String(option?.label ?? '').trim()).filter((text) => text !== '')
          : []
        if (asked === '' && options.length === 0) continue
        parts.push(options.length === 0 ? asked : `${asked} [${label}: ${options.join(' / ')}]`)
      }
      return parts.join('  ')
    }

    /** The assistant step inside one record, if the record is or wraps one. */
    function assistantStepOf(value, depth = 0) {
      if (depth > 4 || value === null || typeof value !== 'object') return null
      if (Array.isArray(value)) {
        for (const item of value) {
          const found = assistantStepOf(item, depth + 1)
          if (found !== null) return found
        }
        return null
      }
      // Both the settled assistant node and the streaming partial carry `blocks`;
      // nothing else in the snapshot does.
      if (Array.isArray(value.blocks)) return value
      for (const item of Object.values(value)) {
        const found = assistantStepOf(item, depth + 1)
        if (found !== null) return found
      }
      return null
    }

    /** Whether one record is an assistant record outright. */
    function isAssistantRecord(record) {
      const role = record?.role ?? record?.kind
      return role === 'assistant'
    }

    /** The identity of one record, for telling a new answer from a repeat. */
    function seqOf(record) {
      for (const candidate of [record, assistantStepOf(record)]) {
        if (candidate !== null && candidate !== undefined && Number.isSafeInteger(candidate.seq)) return candidate.seq
      }
      return null
    }

    /**
     * The AI's last message in one record: what a notification should say.
     *
     * The old extractor joined **every** `text` field in the record, in document
     * order, which is how a notification came to carry the model's reasoning:
     * an assistant message is `blocks: [{ kind: 'reasoning', text }, { kind:
     * 'text', text }]`, and reasoning comes first (measured on 12.6k transcripts).
     * So blocks are walked newest-first and reasoning is skipped by kind — never
     * by wording.
     *
     * The last block decides, because the user asked for the AI's *last*
     * message: a `text` block is the answer, and a question tool call is the
     * question and its choices. A record whose last block is an ordinary tool
     * call has no message for the user, and the walk moves on to the previous
     * record rather than reading out the tool call.
     * @param {unknown} record - one conversation record.
     * @returns {{text: string, seq: number|null}|null} the message, or null.
     */
    function lastMessageOf(record) {
      if (record === null || typeof record !== 'object') return null
      const step = assistantStepOf(record)
      if (step === null && !isAssistantRecord(record)) return null
      const held = step ?? record
      const seq = seqOf(record) ?? seqOf(held)
      const blocks = Array.isArray(held.blocks) ? held.blocks : []
      for (let index = blocks.length - 1; index >= 0; index -= 1) {
        const block = blocks[index]
        if (block === null || typeof block !== 'object') continue
        const kind = block.kind ?? block.type
        if (kind === 'reasoning' || kind === 'thinking') continue
        if (kind === 'text') {
          const text = typeof block.text === 'string' ? block.text.trim() : ''
          if (text !== '') return { text, seq }
          continue
        }
        if (kind === 'tool-call' && String(block.name ?? '') === QUESTION_TOOL) {
          const text = questionMessage(block.argsRaw ?? block.arguments)
          if (text !== '') return { text, seq }
        }
      }
      // A record that carries the message as a plain field (the shape the
      // self-check's doubles use) still counts; a reasoning block never does.
      const plain = typeof held.text === 'string' ? held.text.trim() : ''
      return plain === '' ? null : { text: plain, seq }
    }

    /**
     * The AI's last message across the whole snapshot.
     * @param {Array<unknown>} nodes - conversation records in flow order.
     * @param {unknown} partial - the streaming assistant record, when there is one.
     * @returns {{text: string, seq: number|null}} the message; `text` is '' when nothing readable was found.
     */
    function lastAnswer(nodes, partial) {
      const all = Array.isArray(nodes) ? [...nodes] : []
      if (partial !== null && partial !== undefined) all.push(partial)
      let newest = null
      for (const record of all) {
        const seq = seqOf(record)
        if (seq !== null && (newest === null || seq > newest)) newest = seq
      }
      for (let index = all.length - 1; index >= 0; index -= 1) {
        const message = lastMessageOf(all[index])
        if (message !== null && message.text !== '') {
          return { text: message.text, seq: message.seq ?? newest }
        }
      }
      return { text: '', seq: newest }
    }

    /**
     * The notification body for the current snapshot.
     *
     * An empty result is reported as "no summary" rather than replaced with an
     * invented one — the snapshot's shape is not this plugin's to define.
     * @param {Array<unknown>} nodes - conversation records in flow order.
     * @param {unknown} partial - the streaming assistant record, when there is one.
     * @returns {string} the body text, or '' when nothing readable was found.
     */
    function answerSummary(nodes, partial) {
      return lastAnswer(nodes, partial).text
    }

    /**
     * Read one service off the client context by name.
     *
     * `ctx.get(name)` is the only safe way to reach a service this plugin has
     * not declared: cordis **throws** on a bare `ctx.<name>` for an undeclared
     * service ("cannot get property … without inject"). Reading the property
     * first and swallowing that throw as "service absent" silently disabled the
     * completion watcher even though `remote` was right there. The bare read
     * stays only as a fallback for a context that is not a cordis proxy.
     * @param {object} ctx - the client context.
     * @param {string} name - service name.
     * @returns {object|null} the service, or null when it is genuinely absent.
     */
    function serviceOf(ctx, name) {
      if (ctx === null || ctx === undefined) return null
      try {
        if (typeof ctx.get === 'function') {
          const service = ctx.get(name)
          if (service !== null && service !== undefined) return service
        }
      } catch {
        // Fall through: a non-cordis context may still expose the name directly.
      }
      try {
        return ctx[name] ?? null
      } catch {
        return null
      }
    }

    /** The client `remote` service, or null when this shell does not expose one. */
    function remoteOf(ctx) {
      return serviceOf(ctx, 'remote')
    }

    /** The shell's session list, or null — the source of a session's title. */
    function sessionListOf(ctx) {
      const sessions = serviceOf(ctx, 'sessions')
      return sessions?.list ?? null
    }

    /** The title the shell shows for one session, or null when it has none yet. */
    function sessionTitleOf(id, ctx = clientContext) {
      try {
        const row = sessionListOf(ctx)?.getSnapshot?.()?.byId?.[id]
        if (typeof row?.title === 'string' && row.title.trim() !== '') return row.title.trim()
      } catch {
        // A shell without a session list simply has no title to offer.
      }
      return null
    }

    /**
     * Make sure the settings document has been read, and say so when it cannot be.
     *
     * The document is fetched from the host and cached in the store, but only a
     * mounting component used to ask for it. The completion watcher has no
     * component of its own, so it reads the switch on demand here instead of
     * depending on render order. Returns whether the document is now readable.
     * @returns {Promise<boolean>} true when `settingsStore.get().state` is set.
     */
    async function ensureSettings() {
      try {
        if (settingsStore.get().state !== null) return true
        await settingsStore.load(false)
        return settingsStore.get().state !== null
      } catch (cause) {
        logWatch('completion notifications: could not read the settings (%s)', String(cause?.message ?? cause))
        return false
      }
    }

    /**
     * Ask the host to show one finished task's notification.
     *
     * The switch is read from the shared settings snapshot first, so a
     * deployment with notifications off makes no request at all. The route
     * re-checks it as the authority; this side only avoids the round trip.
     * @param {string} sessionId - the session that finished.
     * @returns {Promise<void>} resolves once the host has answered (or failed to).
     */
    async function notifyCompletion(sessionId) {
      // The switch lives in the host's settings document, which is loaded
      // lazily. A completion that arrives before anything loaded it would read
      // `null` and look exactly like an operator who turned notifications off,
      // so make sure the document is here before trusting the switch.
      if (settingsStore.get().state === null) await ensureSettings()
      const enabled = settingsStore.get().state?.notify?.onComplete === true
      if (!enabled) {
        logWatch('session %s finished, but the notification switch is off', sessionId)
        return
      }
      const title = sessionTitleOf(sessionId) ?? ''
      const answer = completionSummaries.get(sessionId)
      const summary = answer?.text ?? ''
      // A session can stop working and start again without saying anything new
      // (maintenance, a wake that produced no message, a re-render). That is not
      // a finished task worth a toast, and it used to re-send the previous
      // answer verbatim — one session put fifteen identical toasts in the
      // notification history this way.
      if (answer?.seq !== undefined && answer?.seq !== null && notifiedAnswers.get(sessionId) === answer.seq) {
        logWatch('session %s went idle again with no new message (seq %s) — not notifying', sessionId, answer.seq)
        return
      }
      if (answer?.seq !== undefined && answer?.seq !== null) notifiedAnswers.set(sessionId, answer.seq)
      // An empty summary must not ship a blank second line: say why the body is
      // short instead of showing a toast with nothing under the title.
      const body = summary === '' ? notifyLabel('notifyBodyUnavailable') : summary
      const cap = settingsStore.get().state?.notify?.limits?.bodyChars
      logWatch(
        'session %s finished → notifying (%s, %d summary chars, shown up to %s)',
        sessionId,
        title === '' ? 'untitled' : title,
        summary.length,
        cap === undefined || cap === null ? 'the default' : cap,
      )
      // `post` resolves with the host's envelope rather than throwing, so the
      // answer has to be read: a failed request, or a host that declined to
      // show the toast, is otherwise indistinguishable from success and the
      // notification disappears without a trace.
      const result = await post('notify', {
        sessionId,
        title,
        body,
        // The host owns the body's wording, but one thing only this side knows is
        // whether `body` is the assistant's own text (condense it) or the
        // "no answer" marker substituted just above (send it as written).
        needsSummary: summary !== '',
      })
      if (result?.ok !== true) {
        logWatch('session %s finished, but the notification request failed (%s)', sessionId, result?.error?.message ?? 'transport')
        return
      }
      if (result.value?.sent !== true) {
        logWatch('session %s finished, but the host did not show the notification (%s)', sessionId, result.value?.skipped ?? result.value?.error ?? 'unknown')
      }
      // The host's condensation is the part of this path that can fail without
      // the toast failing, so its outcome is said out loud here too: a body that
      // was cut, or a summary that never happened, is exactly what someone
      // reading "the notification looked wrong" needs to know.
      const condensed = result.value?.summary
      if (condensed?.ok === true) {
        logWatch(
          'session %s notification body condensed to %d chars in %d attempt(s)%s',
          sessionId,
          condensed.chars,
          condensed.attempts,
          condensed.truncated === true ? ' (cut to fit)' : '',
        )
      } else if (condensed?.requested === true) {
        logWatch(
          'session %s notification body has no summary (%s): %s',
          sessionId,
          condensed.code,
          condensed.message,
        )
      }
    }

    /**
     * One diagnostic line, when the browser has a console.
     *
     * This feature failed silently once — the watcher never subscribed because
     * a service read threw, and nothing anywhere said so. A subscription that
     * cannot be installed is a broken setting, not a courtesy, so it announces
     * itself; the running/idle edge is logged too, because "no notification"
     * needs to be distinguishable from "no completed task".
     * @param {string} message - format string.
     * @param {...unknown} args - format arguments.
     */
    function logWatch(message, ...args) {
      try {
        globalThis.console?.info?.(`[prompt-tuner] ${message}`, ...args)
      } catch {
        // A console is a convenience; it must never be the thing that breaks.
      }
    }

    /**
     * How long the watcher keeps looking for the shell's remote event channel.
     *
     * The plugin's bundle is not the one that carries `remote`: the shell loads
     * plugin bundles independently, so at activation time the gateway may not
     * have provided the service yet. Measured on this shell, reading once left
     * the feature permanently off; the channel shows up within a second or so,
     * and a late-provided service is visible to `ctx.get` afterwards, so the
     * watcher retries instead of concluding "this shell has no remote".
     */
    const COMPLETION_WATCH_ATTEMPTS = 60
    const COMPLETION_WATCH_INTERVAL_MS = 500

    /**
     * Follow every session's running state for the life of the plugin.
     *
     * The status channel is the shell's own running/idle broadcast (the one its
     * session list uses), and it covers background conversations too — which is
     * the point of a completion notification: you are usually looking elsewhere
     * when the task you started finishes. A session's first `false` is ignored
     * (it is the initial state, not a completion), so only a real running→idle
     * edge notifies.
     *
     * The service is waited for rather than required: declaring `remote` in
     * `inject` would make the whole plugin (composer buttons included) depend on
     * a channel this feature can live without, and a shell that never provides
     * it must still get everything else. Waiting costs one `ctx.get` per tick
     * for at most half a minute, and then the feature says out loud that it is
     * off instead of failing silently.
     * @param {object} ctx - the client context.
     * @param {{attempts?: number, intervalMs?: number}} [options] - retry budget (tests drive it).
     * @returns {() => void} disposer.
     */
    function watchCompletions(ctx, options = {}) {
      const attempts = Number.isFinite(options.attempts) ? Math.max(1, Math.trunc(options.attempts)) : COMPLETION_WATCH_ATTEMPTS
      const intervalMs = Number.isFinite(options.intervalMs) ? Math.max(0, options.intervalMs) : COMPLETION_WATCH_INTERVAL_MS
      /** @type {Map<string, boolean>} */
      const running = new Map()
      let left = attempts
      let stopped = false
      let timer = null
      let unsubscribe = null

      const onStatus = (sessionId, isRunning) => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        const previous = running.get(sessionId)
        running.set(sessionId, isRunning === true)
        if (isRunning === true) {
          logWatch('session %s is running', sessionId)
          return
        }
        logWatch('session %s is idle (was running: %s)', sessionId, previous === true)
        if (previous !== true) {
          // Either the session was already idle before this watcher subscribed
          // (startup) or its running edge predates it. Reporting that as a
          // finished task would be wrong, but dropping it in silence would make
          // "nothing finished" and "we missed it" look identical, so it is said
          // out loud.
          logWatch('session %s went idle, but it was never seen running — not notifying', sessionId)
          return
        }
        void notifyCompletion(sessionId)
      }

      /**
       * Make sure the stored settings have been read before the first edge.
       *
       * The status subscription is installed at activation, but the settings
       * document used to be pulled only by `useSharedState` — that is, by a seat
       * happening to mount. A background session that finished before any seat
       * mounted therefore read `state === null`, which {@link notifyCompletion}
       * reports as "the switch is off" and drops the notification on the floor
       * even though the settings file says otherwise. Loading here removes the
       * dependency on render order: the watcher owns the switch it reads.
       */
      const loadSettings = () => {
        try {
          if (settingsStore.get().state === null) void settingsStore.load(false)
        } catch (cause) {
          logWatch('completion notifications: settings load failed (%s)', String(cause?.message ?? cause))
        }
      }
      loadSettings()

      const attempt = () => {
        if (stopped) return
        const remote = remoteOf(ctx)
        if (remote === null || typeof remote.$on !== 'function') {
          left -= 1
          if (left <= 0) {
            logWatch('completion notifications: this shell never exposed a remote event channel — notifications are off')
            return
          }
          timer = setTimeout(attempt, intervalMs)
          // A pending retry must not hold a Node test process open; browsers
          // return a number here, which has nothing to unref.
          timer?.unref?.()
          return
        }
        try {
          const off = remote.$on('api-session/status', onStatus)
          unsubscribe = typeof off === 'function' ? off : null
          logWatch('completion notifications: watching session status')
        } catch (cause) {
          logWatch('completion notifications: subscribing failed (%s)', String(cause?.message ?? cause))
        }
      }

      attempt()
      return () => {
        stopped = true
        if (timer !== null) clearTimeout(timer)
        try {
          unsubscribe?.()
        } catch {
          // A disposer that throws must not stop the plugin from unloading.
        }
      }
    }

    /**
     * The watcher seat: a session-scoped occupant that renders nothing and keeps
     * that session's latest answer summary where {@link notifyCompletion} can
     * read it. It rides the composer overlay seat because that is where the chat
     * snapshot hook is provided — the notification itself is fired by the
     * module-level status subscription, so a background session still notifies
     * (with its title, and its summary if it was ever on screen).
     * @param {object} props - slot props of `conversation.input.overlay`.
     * @returns {null} nothing is rendered.
     */
    function CompletionWatcher(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
      const activity = useChatActivity(props)
      const nodes = activity.nodes
      const partial = activity.partial
      useEffect(() => {
        if (sessionId === '') return
        completionSummaries.set(sessionId, lastAnswer(nodes, partial))
      }, [sessionId, nodes, partial])
      return null
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

    /**
     * The settings page's tabs, in display order: one per functional module.
     *
     * The page used to stack every group down one column. The shell's own
     * plugins page shows the shape this page now uses — a `role="tablist"` rail
     * with one `role="tabpanel"` per row, panels kept mounted once visited and
     * toggled with `hidden`, so a half-typed draft survives a switch — and the
     * strip's values are copied from it verbatim.
     *
     * The split is lossless: every row, note and status line that was on the
     * single page lives under exactly one tab. The page-level facts that belong
     * to no module — config paths, save feedback, load errors — stay outside the
     * panels, so they are visible from every tab.
     */
    const SETTINGS_TABS = [
      { id: 'optimize', label: 'tabOptimize' },
      { id: 'btw', label: 'tabBtw' },
      { id: 'title', label: 'tabTitle' },
      { id: 'compaction', label: 'tabCompaction' },
      { id: 'notify', label: 'tabNotify' },
    ]

    /**
     * The 「插件优化集合」 settings page: one tab per functional module — the prompt
     * optimization feature (its prompt and how much conversation it carries),
     * side questions, session titles, compaction and notifications. Each tab is a
     * list of label/control rows with the long-form copy folded into one 说明
     * block.
     *
     * The rewrite is one mode, so it gets one tab: everything that used to be
     * spread over 模型 / 改写 / 提示词 (model pinning, effort, style, apply mode,
     * rewrite route, the shortcut switch) is gone, and what remains is the two
     * things the feature actually exposes — the prompt and the record count.
     * @param {object} props - settings section props (`close`) — unused here, the page stays open.
     * @returns {import('react').ReactElement} the page.
     */
    function SettingsPanel(props) {
      const t = useText()
      const snapshot = useSharedState()
      const state = snapshot.state
      const settings = state?.settings ?? null
      const models = state?.models ?? []
      /** The route a rewrite would take right now: the session's model, already resolved by the host. */
      const active = state?.active ?? null
      const limits = state?.limits ?? { maxSystemPromptChars: 20_000 }
      const [draftPrompt, setDraftPrompt] = useState(null)
      const [feedback, setFeedback] = useState(null)
      const [activeTab, setActiveTab] = useState(SETTINGS_TABS[0].id)
      const [visitedTabs, setVisitedTabs] = useState(() => new Set([SETTINGS_TABS[0].id]))
      const tabRefs = useRef({})
      /**
       * The compaction tab's own state.
       *
       * `rows` is the catalog with each model's window as the host resolved it
       * (null until the tab is opened, because resolving a window is adapter
       * I/O). `draft` holds only the rows the user has actually edited, so the
       * stored value stays authoritative for every untouched row and "blank"
       * keeps meaning "do not configure this model".
       */
      const [compactionRows, setCompactionRows] = useState(null)
      const [compactionDraft, setCompactionDraft] = useState({})
      const [compactionStatus, setCompactionStatus] = useState(null)
      const [compactionBusy, setCompactionBusy] = useState(false)
      const [notifyStatus, setNotifyStatus] = useState(null)
      /** The half-typed character cap; `null` means "the input mirrors the saved value". */
      const [notifyCharsDraft, setNotifyCharsDraft] = useState(null)
      /** The session-title tab's own feedback and its two half-typed numbers. */
      const [titleStatus, setTitleStatus] = useState(null)
      const [titleRerollDraft, setTitleRerollDraft] = useState(null)
      const [titleCharsDraft, setTitleCharsDraft] = useState(null)
      /** The rewrite's half-typed record count, and the reason it was not saved. */
      const [recentDraft, setRecentDraft] = useState(null)
      const [recentError, setRecentError] = useState(null)
      /** The side question's half-typed record count, and the reason it was not saved. */
      const [btwContextCountDraft, setBtwContextCountDraft] = useState(null)
      const [btwContextCountError, setBtwContextCountError] = useState(null)

      /** A visited tab stays mounted, so a half-typed draft outlives a switch. */
      useEffect(() => {
        setVisitedTabs((previous) => (previous.has(activeTab) ? previous : new Set([...previous, activeTab])))
      }, [activeTab])

      /**
       * Read the catalog and each model's context window the first time the
       * compaction tab is opened. Window lookups are adapter I/O, so this is
       * deferred rather than folded into every `/state`.
       */
      useEffect(() => {
        if (activeTab !== 'compaction' || compactionRows !== null) return undefined
        let alive = true
        void post('compaction.windows', {}).then((result) => {
          if (!alive) return
          if (result.ok) setCompactionRows(Array.isArray(result.value?.models) ? result.value.models : [])
          else setCompactionStatus({ tone: 'error', text: result.error.message })
        })
        return () => {
          alive = false
        }
      }, [activeTab, compactionRows])

      const saved = settings?.systemPrompt ?? null
      /** `null` means "the textarea mirrors the saved value"; a string means the user typed. */
      const promptValue = draftPrompt ?? saved ?? ''
      const dirty = draftPrompt !== null && draftPrompt !== (saved ?? '')

      /** Cheap re-read on mount; the catalog itself is cached by the host. */
      useEffect(() => {
        void settingsStore.load(false)
      }, [])

      const groups = models.filter((group) => Array.isArray(group.models) && group.models.length > 0)
      /** Provider routes whose model list could not be read — shown, never swallowed. */
      const modelErrors = models
        .filter((group) => group.error != null)
        .map((group) => `${group.name ?? group.id}：${group.error}`)
        .join(' · ')
      const save = async (patch, ok) => {
        const result = await settingsStore.save(patch)
        if (result.ok) setFeedback({ tone: 'ok', text: ok ?? t('saved') })
        return result
      }

      /**
       * The rewrite's own state: how many records it carries.
       *
       * `null` means "the input mirrors the saved value"; a string means the user
       * is typing. Committed on blur and on Enter rather than per keystroke, the
       * same contract the title numbers use — typing "12" must not store 1.
       */
      const recentLimits = {
        min: Number.isSafeInteger(state?.limits?.minRecentMessages) ? state.limits.minRecentMessages : 0,
        max: Number.isSafeInteger(state?.limits?.maxRecentMessages) ? state.limits.maxRecentMessages : 50,
      }
      const recentSaved = Number.isSafeInteger(settings?.recentMessages)
        ? settings.recentMessages
        : Number.isSafeInteger(state?.limits?.defaultRecentMessages)
          ? state.limits.defaultRecentMessages
          : 0
      const recentValue = recentDraft !== null ? recentDraft : String(recentSaved)

      const commitRecent = () => {
        if (recentDraft === null) return
        const raw = recentDraft.trim()
        if (raw === '') {
          setRecentDraft(null)
          setRecentError(null)
          return
        }
        const value = Number(raw)
        if (!Number.isSafeInteger(value) || value < recentLimits.min || value > recentLimits.max) {
          setRecentError(t('recentMessagesInvalid', { min: recentLimits.min, max: recentLimits.max }))
          return
        }
        setRecentDraft(null)
        setRecentError(null)
        if (value === recentSaved) return
        void save({ recentMessages: value })
      }

      const recentRow = settingRow({
        id: 'dspo-recent',
        label: t('recentMessagesLabel'),
        hint: recentSaved === 0 ? t('recentMessagesOff') : t('recentMessagesN', { n: recentSaved }),
        control: h('input', {
          type: 'number',
          className: 'dspo-input',
          id: 'dspo-recent',
          min: recentLimits.min,
          max: recentLimits.max,
          step: 1,
          value: recentValue,
          onChange: (event) => {
            setRecentDraft(event.target.value)
            setRecentError(null)
          },
          onBlur: commitRecent,
          onKeyDown: (event) => {
            if (event.key === 'Enter') commitRecent()
          },
        }),
      })

      /* ── 优化提示词：单一模式 ── */
      // The model and the thinking budget are facts about this feature, not
      // choices: it follows the session's own model and never thinks. They are
      // stated once, above the two rows that *are* settable.
      const rewriteModelNote = h(
        'div',
        { className: 'dspo-set-hint' },
        active === null
          ? t('rewriteModelFallback')
          : t('rewriteModelFollow', { provider: active.provider, model: active.model }),
        ` · ${t('rewriteNoThinking')}`,
        modelErrors === '' ? null : ` · ${modelErrors}`,
      )

      /* ── 旁路提问 ── */
      const btwInfo = state?.btw ?? null
      /**
       * The effort list the two remaining effort selects offer.
       *
       * The rewrite has no effort setting any more, so this is the host's own
       * closed list; each tab still reports what its own route advertises and
       * whether the stored value degrades (see `effortAdvertised` / `effortDegraded`).
       */
      const choices = Array.isArray(state?.effortChoices) && state.effortChoices.length > 0
        ? state.effortChoices
        : ['auto', 'off', 'low', 'high', 'max']

      /**
       * One tab's effort options: what its own route advertises, else the closed
       * list. Each half keeps its own model, so each half keeps its own list of
       * values that route will actually accept.
       * @param {{efforts: string[]}|null} advertised - that half's route metadata.
       * @returns {string[]} the option values.
       */
      const effortOptions = (advertised) => (Array.isArray(advertised?.efforts) && advertised.efforts.length > 0
        ? advertised.efforts
        : choices)
      /**
       * The side-question half's context setting: three modes over one scalar.
       *
       * `btwContextTurns` is what a question actually carries (`'all'`, `0`, or a
       * count), so the select's middle option is this half's own sentinel —
       * choosing it writes the count the input remembers. That count travels as
       * `btwContextCount`, which the host keeps in step with the active value and
       * which lets the input keep showing the number the user typed while 「全部」
       * or 「不带」 is selected. The count has no upper bound: asking for more
       * records than the session holds carries all of them, exactly like 「全部」.
       */
      const btwContext = settings?.btwContextTurns ?? BTW_CONTEXT_ALL
      const btwKeepsHistory = settings?.btwSaveHistory !== false
      const btwContextCount = Number.isSafeInteger(btwContext) && btwContext >= 1
        ? btwContext
        : Number.isSafeInteger(settings?.btwContextCount) && settings.btwContextCount >= 1
          ? settings.btwContextCount
          : DEFAULT_BTW_CONTEXT_COUNT
      const btwCountMin = Number.isSafeInteger(btwInfo?.minContextCount) ? btwInfo.minContextCount : 1
      const btwCountValue = btwContextCountDraft !== null ? btwContextCountDraft : String(btwContextCount)
      const btwContextMode = btwContext === BTW_CONTEXT_ALL
        ? BTW_CONTEXT_ALL
        : Number(btwContext) === 0 ? '0' : BTW_CONTEXT_COUNT

      /**
       * Commit the typed count the way the other number inputs do — on blur or on
       * Enter, never per keystroke — and apply it in the same breath: typing a
       * count *is* choosing 「最近 N 条」, so the select follows the number.
       */
      const commitBtwContextCount = () => {
        if (btwContextCountDraft === null) return
        const raw = btwContextCountDraft.trim()
        if (raw === '') {
          setBtwContextCountDraft(null)
          setBtwContextCountError(null)
          return
        }
        const value = Number(raw)
        if (!Number.isSafeInteger(value) || value < btwCountMin) {
          setBtwContextCountError(t('btwContextCountInvalid', { min: btwCountMin }))
          return
        }
        setBtwContextCountDraft(null)
        setBtwContextCountError(null)
        if (btwContextMode === BTW_CONTEXT_COUNT && value === btwContextCount) return
        void save({ btwContextTurns: value })
      }

      const btwContextRow = settingRow({
        id: 'dspo-btw-context',
        label: t('btwContextLabel'),
        hint: t('btwContextHint'),
        control: [
          h(
            'select',
            {
              className: 'dspo-select',
              id: 'dspo-btw-context',
              value: btwContextMode,
              onChange: (event) => {
                const value = String(event.target.value)
                // A half-typed number belongs to the mode it was typed for. The
                // select's own answer replaces it, so a rejected `0` cannot sit in
                // the field contradicting whichever mode is selected now, and the
                // next blur cannot re-report an error the user already moved on
                // from. Clearing it also clears the stale reason.
                setBtwContextCountDraft(null)
                setBtwContextCountError(null)
                // 「最近 N 条」 applies the number still in the field when it is
                // usable — a click on the select blurs that field first, and the
                // blur saves the same number — and the remembered one otherwise.
                // Reading the draft here rather than the rendered value is what
                // keeps a just-committed count from being undone by the mode
                // change that follows it in the same gesture.
                if (value === BTW_CONTEXT_COUNT) {
                  const typed = Number(String(btwContextCountDraft ?? '').trim())
                  const applied = Number.isSafeInteger(typed) && typed >= btwCountMin ? typed : btwContextCount
                  void save({ btwContextTurns: applied }, t('saved'))
                  return
                }
                // The other two modes write their own fixed value and leave the
                // remembered number alone.
                void save({ btwContextTurns: value === BTW_CONTEXT_ALL ? BTW_CONTEXT_ALL : 0 }, t('saved'))
              },
            },
            [
              h('option', { key: BTW_CONTEXT_ALL, value: BTW_CONTEXT_ALL }, t('btwContextAllOption')),
              h('option', { key: BTW_CONTEXT_COUNT, value: BTW_CONTEXT_COUNT }, t('btwContextCountOption')),
              h('option', { key: '0', value: '0' }, t('btwContextNone')),
            ],
          ),
          h('input', {
            type: 'number',
            className: 'dspo-input',
            id: 'dspo-btw-context-count',
            min: btwCountMin,
            step: 1,
            value: btwCountValue,
            'aria-label': t('btwContextCountLabel'),
            // The number only applies to 「最近 N 条」, so it is dimmed (never
            // disabled) while another mode is active: it still takes a value, and
            // committing one is how that mode gets chosen in the first place.
            'data-inactive': btwContextMode === BTW_CONTEXT_COUNT ? undefined : 'true',
            title: t('btwContextCountTitle'),
            onChange: (event) => {
              setBtwContextCountDraft(event.target.value)
              setBtwContextCountError(null)
            },
            onBlur: commitBtwContextCount,
            onKeyDown: (event) => {
              if (event.key === 'Enter') commitBtwContextCount()
            },
          }),
          h('span', { className: 'dspo-set-hint' }, t('btwContextCountUnit')),
        ],
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

      /**
       * The side-question half's own model and effort rows: the same two
       * controls the 「模型」 tab renders, off the same catalog and the same
       * `effortChoices`, with the same "not chosen" semantics — an unset pair
       * falls back to the session's own model, and `off` is what an unset
       * effort sends. What they write is `btw*`, so the rewrite keeps its own
       * selection untouched.
       */
      const btwProvider = settings?.btwProvider ?? ''
      const btwActiveModel = settings?.btwModel ?? ''
      const btwProviderGroup = groups.find((group) => group.id === btwProvider) ?? groups[0]
      const btwEffort = settings?.btwReasoningEffort ?? DEFAULT_EFFORT
      const btwAdvertised = btwInfo?.reasoning ?? null
      const btwEffortDegraded = btwAdvertised !== null && !btwAdvertised.efforts.includes(btwEffort) && btwEffort !== 'auto'
        ? btwAdvertised.efforts.includes('off')
          ? 'off'
          : btwAdvertised.defaultEffort ?? btwAdvertised.efforts[0] ?? null
        : null

      const btwModelRow = settingRow({
        id: 'dspo-btw-model',
        stack: true,
        label: t('btwModelLabel'),
        hint: btwInfo?.active !== null && btwInfo?.active !== undefined
          ? t('activeModel', { provider: btwInfo.active.provider, model: btwInfo.active.model })
          : null,
        control: groups.length === 0
          ? h('div', { className: 'dspo-set-hint' }, snapshot.loading ? t('refreshing') : t('noModels'))
          : [
              h(
                'select',
                {
                  className: 'dspo-select',
                  id: 'dspo-btw-provider',
                  'aria-label': t('btwModelLabel'),
                  value: btwProviderGroup?.id ?? '',
                  onChange: (event) => {
                    const group = groups.find((entry) => entry.id === event.target.value)
                    if (group === undefined) return
                    void save({ btwProvider: group.id, btwModel: group.models[0].id }, t('saved'))
                  },
                },
                groups.map((group) => h('option', { key: group.id, value: group.id }, group.name ?? group.id)),
              ),
              h(
                'select',
                {
                  className: 'dspo-select',
                  id: 'dspo-btw-model-pick',
                  'aria-label': t('btwModelLabel'),
                  disabled: btwProviderGroup === undefined,
                  value: btwActiveModel,
                  onChange: (event) => {
                    if (btwProviderGroup === undefined) return
                    void save({ btwProvider: btwProviderGroup.id, btwModel: event.target.value }, t('saved'))
                  },
                },
                btwProviderGroup?.models.map((model) =>
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

      const btwEffortMeta = btwAdvertised === null
        ? t('effortUnknown')
        : btwAdvertised.defaultEffort === null || btwAdvertised.defaultEffort === undefined
          ? t('effortAdvertised', { list: btwAdvertised.efforts.join(' / ') })
          : t('effortAdvertisedDefault', { list: btwAdvertised.efforts.join(' / '), fallback: btwAdvertised.defaultEffort })

      const btwEffortRow = settingRow({
        id: 'dspo-btw-effort',
        label: t('btwEffortLabel'),
        hint: btwEffortMeta,
        control: h(
          'select',
          {
            className: 'dspo-select',
            id: 'dspo-btw-effort',
            'aria-label': t('btwEffortLabel'),
            value: btwEffort,
            onChange: (event) => void save({ btwReasoningEffort: event.target.value }),
          },
          effortOptions(btwAdvertised).map((choice) => h('option', { key: choice, value: choice }, effortLabel(t, choice))),
        ),
      })

      const btwEffortWarn = btwEffortDegraded === null
        ? null
        : h('div', { className: 'dspo-set-warn' }, t('effortDegraded', { value: btwEffortDegraded }))

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

      /**
       * The second thing this feature lets you set: which language the rewritten
       * prompt comes back in.
       *
       * Two states and no third one, because "follow the shell" is not a state
       * the user has to manage — it is what the control shows *before* the first
       * choice (the effective value is `outputLang ?? locale`), and the first
       * click stores an explicit value that then wins. A rewrite that comes back
       * in the wrong language is the failure this row exists to prevent, so the
       * hint says out loud that the line beats a custom prompt.
       */
      const effectiveOutputLang = settings?.outputLang ?? locale
      const outputLangChoices = Array.isArray(state?.outputLanguages) && state.outputLanguages.length > 0
        ? state.outputLanguages
        : ['zh', 'en']
      const outputLangRow = settingRow({
        id: 'dspo-output-lang',
        label: t('outputLangLabel'),
        hint: state?.custom === true ? t('outputLangCustomHint') : t('outputLangHint'),
        control: outputLangChoices.map((choice) =>
          h(
            'button',
            {
              key: choice,
              type: 'button',
              className: 'dspo-action',
              'data-kind': choice === effectiveOutputLang ? 'primary' : 'plain',
              'aria-pressed': choice === effectiveOutputLang ? 'true' : 'false',
              onClick: () => void save({ outputLang: choice }, t('saved')),
            },
            t(choice === 'en' ? 'outputLangEn' : 'outputLangZh'),
          ),
        ),
      })

      /**
       * The whole rewrite feature, in one tab: the three things it lets you set
       * (the prompt, the output language, the record count) plus one line of
       * fixed facts. There is deliberately nothing else — no model picker, no
       * effort, no style, no apply mode, no route, no shortcut switch.
       */
      const optimizeGroup = h(
        'section',
        { className: 'dspo-set-group' },
        rewriteModelNote,
        promptRow,
        outputLangRow,
        recentRow,
        recentError === null
          ? null
          : h('div', { className: 'dspo-set-status', 'data-tone': 'error', role: 'alert' }, recentError),
        notesBlock(t, [
          { label: t('promptLabel'), text: t('promptHint') },
          { label: t('outputLangLabel'), text: t('outputLangHint') },
          { label: t('recentMessagesLabel'), text: t('recentMessagesHint') },
        ]),
      )

      const btwGroup = h(
        'section',
        { className: 'dspo-set-group' },
        btwModelRow,
        btwEffortRow,
        btwEffortWarn,
        btwContextRow,
        btwContextCountError === null
          ? null
          : h('div', { className: 'dspo-set-status', 'data-tone': 'error', role: 'alert' }, btwContextCountError),
        btwHistoryRow,
        h('p', { className: 'dspo-set-warn' }, t('btwPrivacyNote')),
        notesBlock(t, [
          { label: t('btwModelLabel'), text: t('btwModelHint') },
          { label: t('btwEffortLabel'), text: t('btwEffortHint') },
          { label: t('btwContextLabel'), text: t('btwContextHint') },
          { label: t('btwSaveHistoryLabel'), text: t('btwSaveHistoryHint') },
        ]),
      )

      /* ── 压缩 · 上下文压缩阈值 ── */
      const compactionInfo = state?.compaction ?? null
      const compactionLimits = compactionInfo?.limits ?? { minTokens: 8192, maxTokens: 4000000 }
      const compactionStored = settings?.compactionTokens ?? {}
      const compactionPlan = compactionInfo?.plan ?? null
      /** Every catalog model, with the window the host resolved (null = not advertised). */
      const compactionCatalog = Array.isArray(compactionRows) ? compactionRows : []
      /** The value an input shows: the user's edit when there is one, else what is stored. */
      const compactionValue = (key) => {
        if (Object.prototype.hasOwnProperty.call(compactionDraft, key)) return compactionDraft[key]
        const stored = compactionStored[key]
        return stored === undefined ? '' : String(stored)
      }
      const compactionRowsSource = compactionCatalog.length > 0
        ? compactionCatalog.map((row) => ({
            key: `${row.provider}/${row.model}`,
            provider: row.provider,
            model: row.model,
            contextWindow: row.contextWindow,
          }))
        : Object.keys(compactionStored).map((key) => {
            const slash = key.lastIndexOf('/')
            return { key, provider: key.slice(0, slash), model: key.slice(slash + 1), contextWindow: null }
          })

      const compactionSave = async () => {
        const nextTokens = {}
        for (const row of compactionRowsSource) {
          const raw = String(compactionValue(row.key)).trim()
          if (raw === '') continue
          const value = Number(raw)
          if (!Number.isSafeInteger(value) || value < compactionLimits.minTokens || value > compactionLimits.maxTokens) {
            setCompactionStatus({
              tone: 'error',
              text: t('compactionRange', { min: compactionLimits.minTokens, max: compactionLimits.maxTokens }),
            })
            return
          }
          nextTokens[row.key] = value
        }
        const result = await settingsStore.save({ compactionTokens: nextTokens })
        if (result.ok) {
          setCompactionDraft({})
          setCompactionStatus({ tone: 'ok', text: t('saved') })
        } else {
          setCompactionStatus({ tone: 'error', text: result.error.message })
        }
      }

      const compactionApply = async () => {
        setCompactionBusy(true)
        const result = await post('compaction.apply', {})
        setCompactionBusy(false)
        if (!result.ok) {
          setCompactionStatus({ tone: 'error', text: result.error.message })
          return
        }
        const applied = result.value?.applied ?? {}
        if (applied.ok === true) {
          setCompactionStatus({ tone: 'ok', text: t('compactionApplied', { n: applied.count ?? 0 }) })
        } else {
          const reason = applied.code === 'unavailable'
            ? t('compactionEditorMissing')
            : `${applied.message ?? applied.code ?? ''}`
          setCompactionStatus({ tone: 'error', text: t('compactionApplyFailed', { reason }) })
        }
        void settingsStore.load(true)
      }

      const compactionApplyEnabled = compactionInfo?.configEditor === true && (compactionPlan?.policies?.length ?? 0) > 0

      const compactionRowsView = compactionRowsSource.length === 0
        ? h('div', { className: 'dspo-set-hint' }, compactionRows === null && activeTab === 'compaction' ? t('compactionLoading') : t('compactionNoModels'))
        : compactionRowsSource.map((row) =>
            h(
              'div',
              { className: 'dspo-set-row', 'data-stack': 'true', key: row.key },
              h(
                'div',
                { className: 'dspo-set-text' },
                h('label', { className: 'dspo-set-sublabel', htmlFor: `dspo-compact-${row.key}` }, row.model),
                h(
                  'div',
                  { className: 'dspo-set-hint' },
                  `${row.provider} · ${t('compactionWindow')}：${row.contextWindow === null ? t('compactionWindowUnknown') : row.contextWindow}`,
                ),
              ),
              h(
                'div',
                { className: 'dspo-set-controls' },
                h('input', {
                  type: 'number',
                  className: 'dspo-input',
                  id: `dspo-compact-${row.key}`,
                  min: compactionLimits.minTokens,
                  max: compactionLimits.maxTokens,
                  step: 1000,
                  placeholder: t('compactionPlaceholder'),
                  value: compactionValue(row.key),
                  onChange: (event) => {
                    const value = event.target.value
                    setCompactionDraft((previous) => ({ ...previous, [row.key]: value }))
                  },
                }),
              ),
            ),
          )

      const compactionGroup = h(
        'section',
        { className: 'dspo-set-group' },
        settingRow({
          id: 'dspo-compaction-head',
          stack: true,
          label: t('compactionLabel'),
          hint: t('compactionHintShort'),
          control: h(
            'div',
            { className: 'dspo-set-controls' },
            h('button', { type: 'button', className: 'dspo-action', onClick: () => void compactionSave() }, t('compactionSave')),
            h(
              'button',
              {
                type: 'button',
                className: 'dspo-action',
                disabled: compactionBusy || !compactionApplyEnabled,
                title: t('compactionApplyHint'),
                onClick: () => void compactionApply(),
              },
              t('compactionApply'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dspo-action',
                disabled: compactionBusy,
                onClick: () => {
                  setCompactionRows(null)
                  setCompactionStatus(null)
                },
              },
              t('compactionRefresh'),
            ),
          ),
        }),
        h('div', { className: 'dspo-set-hint' }, t('compactionRange', { min: compactionLimits.minTokens, max: compactionLimits.maxTokens })),
        compactionRowsView,
        compactionInfo !== null && compactionInfo.configEditor !== true
          ? h('p', { className: 'dspo-set-warn' }, t('compactionEditorMissing'))
          : null,
        compactionPlan !== null && compactionPlan.skipped.length > 0
          ? h('div', { className: 'dspo-set-warn' }, t('compactionSkipped', { list: compactionPlan.skipped.map((row) => row.target).join('、') }))
          : null,
        compactionPlan !== null && compactionPlan.capped.length > 0
          ? h('div', { className: 'dspo-set-warn' }, t('compactionCapped', { list: compactionPlan.capped.join('、') }))
          : null,
        compactionStatus === null
          ? null
          : h('div', { className: 'dspo-set-status', 'data-tone': compactionStatus.tone }, compactionStatus.text),
        compactionPlan !== null && compactionPlan.policies.length > 0
          ? h(
              'details',
              { className: 'dspo-set-notes' },
              h('summary', null, t('compactionYaml')),
              h('pre', { className: 'dspo-pre' }, compactionPlan.yaml ?? ''),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dspo-action',
                  onClick: () => {
                    void navigator.clipboard?.writeText(compactionPlan.yaml ?? '').then(
                      () => setCompactionStatus({ tone: 'ok', text: t('compactionCopied') }),
                      () => setCompactionStatus({ tone: 'error', text: t('compactionCopyFailed') }),
                    )
                  },
                },
                t('compactionCopy'),
              ),
            )
          : null,
        notesBlock(t, [{ label: t('compactionLabel'), text: t('compactionHint') }]),
      )

      /* ── 通知 · 任务完成桌面通知 ── */
      const notifyInfo = state?.notify ?? null
      const notifyPlatformText = notifyInfo?.platform === 'linux'
        ? t('notifyPlatformLinux')
        : notifyInfo?.platform === 'windows'
          ? t('notifyPlatformWindows')
          : t('notifyPlatformNone')
      // The shortening itself happens in the host (the answer reaches it whole),
      // so this input only picks the cap; the bounds it offers are the host's.
      const notifyCharsMin = notifyInfo?.limits?.minBodyChars ?? 40
      const notifyCharsMax = notifyInfo?.limits?.maxBodyChars ?? 600
      const notifyCharsSaved = notifyInfo?.limits?.bodyChars ?? null
      // The cap is a host contract, not just a number: the row is only offered
      // when the host advertises the range it would accept, because a host that
      // predates the cap stores nothing for it — the field would look saved and
      // quietly revert on the next `/state`.
      const notifyCapSupported = typeof notifyInfo?.limits?.minBodyChars === 'number'
      const notifyCharsValue = notifyCharsDraft !== null
        ? notifyCharsDraft
        : notifyCharsSaved === null ? '' : String(notifyCharsSaved)

      /**
       * Save the half-typed cap, or say why it was not saved.
       *
       * Committed on blur and on Enter rather than on every keystroke: typing
       * "250" must not store 2, then 25, then 250. A value outside the host's
       * range is refused here instead of being silently clamped, because the
       * input would otherwise show one number and the file hold another.
       */
      const commitNotifyChars = () => {
        if (notifyCharsDraft === null) return
        if (notifyCharsDraft.trim() === '') {
          setNotifyCharsDraft(null)
          return
        }
        const value = Number(notifyCharsDraft)
        if (!Number.isSafeInteger(value) || value < notifyCharsMin || value > notifyCharsMax) {
          setNotifyStatus({
            tone: 'error',
            text: t('notifyCharsInvalid', { min: notifyCharsMin, max: notifyCharsMax }),
          })
          return
        }
        setNotifyCharsDraft(null)
        setNotifyStatus(null)
        if (value === notifyCharsSaved) return
        void save({ notifyMaxChars: value })
      }

      // The summarizer's own model pair, rendered the way the side-question half's
      // is: the stored pair drives the two selects, and the host's resolved route
      // says what a completion would actually use right now. Thinking is not a
      // choice on this tab — the host always asks for `off`, because a summary of
      // text that already exists is pure latency when it thinks.
      const notifySummarySupported = notifyInfo?.thinking === 'off'
      const notifyActiveRoute = notifyInfo?.active ?? null
      // With nothing pinned the two selects show the route the host resolved —
      // the same one the hint above them names — rather than a blank pair.
      // Picking either half pins both, exactly like the side-question row.
      const notifyProviderGroup = groups.find((group) => group.id === (settings?.notifyProvider ?? notifyActiveRoute?.provider))
        ?? groups[0]
      const notifyModelPick = settings?.notifyModel
        ?? (notifyProviderGroup?.models.some((model) => model.id === notifyActiveRoute?.model) ? notifyActiveRoute.model : '')
      const notifyModelRow = settingRow({
        id: 'dspo-notify-model',
        stack: true,
        label: t('notifyModelLabel'),
        hint: notifyInfo?.active !== null && notifyInfo?.active !== undefined
          ? t('activeModel', { provider: notifyInfo.active.provider, model: notifyInfo.active.model })
          : null,
        control: groups.length === 0
          ? h('div', { className: 'dspo-set-hint' }, snapshot.loading ? t('refreshing') : t('noModels'))
          : [
              h(
                'select',
                {
                  className: 'dspo-select',
                  id: 'dspo-notify-provider',
                  'aria-label': t('notifyModelLabel'),
                  value: notifyProviderGroup?.id ?? '',
                  onChange: (event) => {
                    const group = groups.find((entry) => entry.id === event.target.value)
                    if (group === undefined) return
                    void save({ notifyProvider: group.id, notifyModel: group.models[0].id }, t('saved'))
                  },
                },
                groups.map((group) => h('option', { key: group.id, value: group.id }, group.name ?? group.id)),
              ),
              h(
                'select',
                {
                  className: 'dspo-select',
                  id: 'dspo-notify-model-pick',
                  'aria-label': t('notifyModelLabel'),
                  disabled: notifyProviderGroup === undefined,
                  value: notifyModelPick,
                  onChange: (event) => {
                    if (notifyProviderGroup === undefined) return
                    void save({ notifyProvider: notifyProviderGroup.id, notifyModel: event.target.value }, t('saved'))
                  },
                },
                notifyProviderGroup?.models.map((model) =>
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
              h('div', { className: 'dspo-set-hint' }, t('notifyModelHint')),
            ],
      })

      const notifyGroup = h(
        'section',
        { className: 'dspo-set-group' },
        settingRow({
          id: 'dspo-notify',
          label: t('notifyToggle'),
          hint: t('notifyHintShort'),
          control: h('input', {
            type: 'checkbox',
            id: 'dspo-notify',
            className: 'dspo-check-input',
            checked: notifyInfo?.onComplete === true,
            onChange: (event) => void save({ notifyOnComplete: event.target.checked }),
          }),
        }),
        settingRow({
          id: 'dspo-notify-platform',
          label: t('notifyPlatformLabel'),
          hint: t('notifyTitleSource'),
          control: h('span', { className: 'dspo-set-hint' }, notifyPlatformText),
        }),
        // Only offered when the host advertises the summary contract: a host that
        // predates it stores neither half of the pair, so the selects would look
        // saved and quietly revert on the next `/state`. That host also does not
        // condense the body at all, which the line says out loud.
        notifySummarySupported
          ? notifyModelRow
          : h('div', { className: 'dspo-set-hint' }, t('notifySummaryUnsupported')),
        notifyCapSupported
          ? settingRow({
              id: 'dspo-notify-chars',
              label: t('notifyCharsLabel'),
              hint: t('notifyCharsHint', { min: notifyCharsMin, max: notifyCharsMax }),
              control: h('input', {
                type: 'number',
                className: 'dspo-input',
                id: 'dspo-notify-chars',
                min: notifyCharsMin,
                max: notifyCharsMax,
                step: 10,
                value: notifyCharsValue,
                onChange: (event) => setNotifyCharsDraft(event.target.value),
                onBlur: commitNotifyChars,
                onKeyDown: (event) => {
                  if (event.key === 'Enter') commitNotifyChars()
                },
              }),
            })
          : null,
        h(
          'div',
          { className: 'dspo-set-controls' },
          h(
            'button',
            {
              type: 'button',
              className: 'dspo-action',
              onClick: () => {
                void post('notify.test', {}).then((result) => {
                  if (!result.ok) {
                    setNotifyStatus({ tone: 'error', text: result.error.message })
                    return
                  }
                  if (result.value?.sent === true) setNotifyStatus({ tone: 'ok', text: t('notifyTestSent') })
                  else {
                    setNotifyStatus({
                      tone: 'error',
                      text: t('notifyTestFailed', { reason: result.value?.error ?? result.value?.skipped ?? '' }),
                    })
                  }
                })
              },
            },
            t('notifyTest'),
          ),
        ),
        notifyStatus === null
          ? null
          : h('div', { className: 'dspo-set-status', 'data-tone': notifyStatus.tone }, notifyStatus.text),
        notesBlock(t, [{ label: t('notifyToggle'), text: t('notifyHint') }]),
      )

      /* ── 会话标题 · 每 N 轮重总结 ── */
      const titleInfo = state?.title ?? null
      const titleLimits = titleInfo?.limits ?? null
      // The two numbers and the model pair are only offered when the host
      // advertises the contract behind them: a host that predates this feature
      // stores nothing for these keys, so the fields would look saved and
      // quietly revert on the next `/state` — the same reason the notification
      // cap row is gated.
      const titleSupported = titleInfo !== null
        && Number.isSafeInteger(titleLimits?.minRerollTurns) && Number.isSafeInteger(titleLimits?.maxRerollTurns)
        && Number.isSafeInteger(titleLimits?.minChars) && Number.isSafeInteger(titleLimits?.maxChars)
      const titleRerollMin = titleLimits?.minRerollTurns ?? 1
      const titleRerollMax = titleLimits?.maxRerollTurns ?? 1000
      const titleCharsMin = titleLimits?.minChars ?? 4
      const titleCharsMax = titleLimits?.maxChars ?? 120
      const titleRerollSaved = settings?.titleRerollTurns ?? titleLimits?.defaultRerollTurns ?? 100
      const titleCharsSaved = settings?.titleMaxChars ?? titleLimits?.defaultChars ?? 24
      const titleRerollValue = titleRerollDraft !== null ? titleRerollDraft : String(titleRerollSaved)
      const titleCharsValue = titleCharsDraft !== null ? titleCharsDraft : String(titleCharsSaved)

      /** The title model row, the same two controls the rewrite's and the side question's tabs render. */
      const titleProvider = settings?.titleProvider ?? ''
      const titleActiveModel = settings?.titleModel ?? ''
      const titleProviderGroup = groups.find((group) => group.id === titleProvider) ?? groups[0]
      const titleEffort = settings?.titleReasoningEffort ?? DEFAULT_EFFORT
      const titleAdvertised = titleInfo?.reasoning ?? null
      const titleEffortDegraded = titleAdvertised !== null && !titleAdvertised.efforts.includes(titleEffort) && titleEffort !== 'auto'
        ? titleAdvertised.efforts.includes('off')
          ? 'off'
          : titleAdvertised.defaultEffort ?? titleAdvertised.efforts[0] ?? null
        : null

      const titleModelRow = settingRow({
        id: 'dspo-title-model',
        stack: true,
        label: t('titleModelLabel'),
        hint: titleInfo?.active !== null && titleInfo?.active !== undefined
          ? t('activeModel', { provider: titleInfo.active.provider, model: titleInfo.active.model })
          : null,
        control: groups.length === 0
          ? h('div', { className: 'dspo-set-hint' }, snapshot.loading ? t('refreshing') : t('noModels'))
          : [
              h(
                'select',
                {
                  className: 'dspo-select',
                  id: 'dspo-title-provider',
                  'aria-label': t('titleModelLabel'),
                  value: titleProviderGroup?.id ?? '',
                  onChange: (event) => {
                    const group = groups.find((entry) => entry.id === event.target.value)
                    if (group === undefined) return
                    void save({ titleProvider: group.id, titleModel: group.models[0].id }, t('saved'))
                  },
                },
                groups.map((group) => h('option', { key: group.id, value: group.id }, group.name ?? group.id)),
              ),
              h(
                'select',
                {
                  className: 'dspo-select',
                  id: 'dspo-title-model-pick',
                  'aria-label': t('titleModelLabel'),
                  disabled: titleProviderGroup === undefined,
                  value: titleActiveModel,
                  onChange: (event) => {
                    if (titleProviderGroup === undefined) return
                    void save({ titleProvider: titleProviderGroup.id, titleModel: event.target.value }, t('saved'))
                  },
                },
                titleProviderGroup?.models.map((model) =>
                  h('option', { key: model.id, value: model.id }, model.name ?? model.id),
                ) ?? null,
              ),
            ],
      })

      const titleEffortRow = settingRow({
        id: 'dspo-title-effort',
        label: t('titleEffortLabel'),
        hint: titleAdvertised === null
          ? t('effortUnknown')
          : titleAdvertised.defaultEffort === null || titleAdvertised.defaultEffort === undefined
            ? t('effortAdvertised', { list: titleAdvertised.efforts.join(' / ') })
            : t('effortAdvertisedDefault', { list: titleAdvertised.efforts.join(' / '), fallback: titleAdvertised.defaultEffort }),
        control: h(
          'select',
          {
            className: 'dspo-select',
            id: 'dspo-title-effort',
            'aria-label': t('titleEffortLabel'),
            value: titleEffort,
            onChange: (event) => void save({ titleReasoningEffort: event.target.value }),
          },
          effortOptions(titleAdvertised).map((choice) => h('option', { key: choice, value: choice }, effortLabel(t, choice))),
        ),
      })

      /**
       * Commit one half-typed title number, or say why it was not saved.
       *
       * The same contract the notification cap uses: committed on blur and on
       * Enter rather than on every keystroke (typing "100" must not store 1,
       * then 10, then 100), and a value outside the host's range is refused here
       * instead of being silently clamped, because the input would otherwise
       * show one number and the file hold another.
       */
      const commitTitleNumber = (kind) => {
        const draft = kind === 'turns' ? titleRerollDraft : titleCharsDraft
        if (draft === null) return
        const clear = kind === 'turns' ? setTitleRerollDraft : setTitleCharsDraft
        if (draft.trim() === '') {
          clear(null)
          return
        }
        const value = Number(draft)
        const min = kind === 'turns' ? titleRerollMin : titleCharsMin
        const max = kind === 'turns' ? titleRerollMax : titleCharsMax
        const saved = kind === 'turns' ? titleRerollSaved : titleCharsSaved
        if (!Number.isSafeInteger(value) || value < min || value > max) {
          setTitleStatus({
            tone: 'error',
            text: kind === 'turns'
              ? t('titleRerollInvalid', { min, max })
              : t('titleMaxCharsInvalid', { min, max }),
          })
          return
        }
        clear(null)
        setTitleStatus(null)
        if (value === saved) return
        void save(kind === 'turns' ? { titleRerollTurns: value } : { titleMaxChars: value })
      }

      const titleNumberRow = (kind) => {
        const isTurns = kind === 'turns'
        const min = isTurns ? titleRerollMin : titleCharsMin
        const max = isTurns ? titleRerollMax : titleCharsMax
        const id = isTurns ? 'dspo-title-reroll' : 'dspo-title-chars'
        return settingRow({
          id,
          label: isTurns ? t('titleRerollLabel') : t('titleMaxCharsLabel'),
          hint: isTurns
            ? t('titleRerollHint', { min, max })
            : t('titleMaxCharsHint', { min, max }),
          control: h('input', {
            type: 'number',
            className: 'dspo-input',
            id,
            min,
            max,
            step: 1,
            value: isTurns ? titleRerollValue : titleCharsValue,
            onChange: (event) => (isTurns ? setTitleRerollDraft(event.target.value) : setTitleCharsDraft(event.target.value)),
            onBlur: () => commitTitleNumber(kind),
            onKeyDown: (event) => {
              if (event.key === 'Enter') commitTitleNumber(kind)
            },
          }),
        })
      }

      const titleGroup = h(
        'section',
        { className: 'dspo-set-group' },
        titleSupported
          ? [
              titleModelRow,
              titleEffortRow,
              titleEffortDegraded === null
                ? null
                : h('div', { className: 'dspo-set-warn' }, t('effortDegraded', { value: titleEffortDegraded })),
              titleNumberRow('turns'),
              titleNumberRow('chars'),
            ]
          : h('div', { className: 'dspo-set-hint' }, t('titleUnsupported')),
        titleStatus === null
          ? null
          : h('div', { className: 'dspo-set-status', 'data-tone': titleStatus.tone }, titleStatus.text),
        titleSupported
          ? notesBlock(t, [
              { label: t('titleModelLabel'), text: t('titleModelHint') },
              { label: t('titleEffortLabel'), text: t('titleEffortHint') },
              { label: t('titleRerollLabel'), text: t('titleHint') },
            ])
          : null,
      )

      /** One panel per tab, in tab order. */
      const panels = {
        optimize: optimizeGroup,
        btw: btwGroup,
        title: titleGroup,
        compaction: compactionGroup,
        notify: notifyGroup,
      }

      /** The shell's tab rail walks with the arrow keys, Home and End; so does this one. */
      const onTabKeyDown = (event, index) => {
        const last = SETTINGS_TABS.length - 1
        let nextIndex
        if (event.key === 'ArrowRight') nextIndex = index === last ? 0 : index + 1
        else if (event.key === 'ArrowLeft') nextIndex = index === 0 ? last : index - 1
        else if (event.key === 'Home') nextIndex = 0
        else if (event.key === 'End') nextIndex = last
        else return
        event.preventDefault()
        const next = SETTINGS_TABS[nextIndex]
        setActiveTab(next.id)
        tabRefs.current[next.id]?.focus?.()
      }

      return h(
        'div',
        { className: 'dspo-set', 'data-plugin': ID },
        h(
          'div',
          { className: 'dspo-set-head' },
          h('h2', { className: 'dspo-set-title' }, t('settingsTitle')),
          h('p', { className: 'dspo-set-intro' }, t('settingsIntro')),
        ),
        h(
          'div',
          { className: 'dspo-tabs', role: 'tablist', 'aria-label': t('settingsTabs') },
          SETTINGS_TABS.map((tab, index) =>
            h(
              'button',
              {
                key: tab.id,
                type: 'button',
                role: 'tab',
                id: `dspo-tab-${tab.id}`,
                className: 'dspo-tab',
                'aria-selected': tab.id === activeTab,
                'aria-controls': `dspo-panel-${tab.id}`,
                'data-active': tab.id === activeTab ? 'true' : undefined,
                tabIndex: tab.id === activeTab ? 0 : -1,
                ref: (element) => {
                  tabRefs.current[tab.id] = element
                },
                onClick: () => setActiveTab(tab.id),
                onKeyDown: (event) => onTabKeyDown(event, index),
              },
              t(tab.label),
            ),
          ),
        ),
        SETTINGS_TABS.filter((tab) => tab.id === activeTab || visitedTabs.has(tab.id)).map((tab) =>
          h(
            'div',
            {
              key: tab.id,
              id: `dspo-panel-${tab.id}`,
              role: 'tabpanel',
              className: 'dspo-tabpanel',
              'aria-labelledby': `dspo-tab-${tab.id}`,
              hidden: tab.id === activeTab ? undefined : true,
            },
            panels[tab.id],
          ),
        ),
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
     * Register the composer buttons, the review card, the side-question panel
     * and the settings page. The stylesheet and all of those
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
      // Completion notifications: one invisible seat keeps the current
      // conversation's answer summary, and one status subscription fires the
      // host notification for every session that goes running → idle.
      ctx.effect(() => ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({ name: 'conversation.input.overlay', id: ID + '-notify', order: OVERLAY_ORDER + 1 }, CompletionWatcher)), 'dsh-prompt-optimizer: completion watcher')
      ctx.effect(() => watchCompletions(ctx), 'dsh-prompt-optimizer: completion notifications')
      ctx.effect(() => ctx.slots.inject(DOCK_SLOT, () => ctx.slots.register({ name: 'conversation.input.dock', id: ID, order: DOCK_ORDER }, TaskPanel)), 'dsh-prompt-optimizer: review card')
      ctx.effect(() => ctx.slots.inject(SETTINGS_SLOT, () => ctx.slots.register({ name: 'settings.section', id: ID, order: SETTINGS_ORDER, label: () => DICT[locale].settingsNav }, SettingsPanel)), 'dsh-prompt-optimizer: settings page')
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
    exports.recentRecords = recentRecords
    exports.carriedRecordCount = carriedRecordCount
    exports.persistBtw = persistBtw
    exports.ensureFullHistory = ensureFullHistory
    exports.CompletionWatcher = CompletionWatcher
    exports.answerSummary = answerSummary
    exports.watchCompletions = watchCompletions
    exports.serviceOf = serviceOf
    exports.sessionTitleOf = sessionTitleOf
    exports.completionSummaries = completionSummaries
    return module.exports
  },
})

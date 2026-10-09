/**
 * Self-check for dsh-prompt-optimizer. No test framework: one process, one
 * report, a non-zero exit for CI. It runs in three layers.
 *
 *   1. Static contract — the shapes the deployment's plugin precheck and the
 *      slot registry actually read (literal `register({ name: …` calls, inject
 *      lists, package manifest, palette-only CSS, locale parity).
 *   2. Host half — a fake `ctx` drives the real route handler through a fake
 *      HTTP request, covering the retry ladder, the effort negotiation, the
 *      output budget, the streaming protocol and the trust fence.
 *   3. Browser half — the bundle is loaded with a fake React and a fake `fetch`,
 *      so the state machine (apply vs review, session isolation, undo, chips
 *      guard, i18n) is exercised without a browser.
 *
 * Usage: `npm run check` (or `node scripts/check.mjs`).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** Harmless port that a real user's file would not be: settings writes go here. */
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dspo-check-'))

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok === true) {
    passed += 1
    return
  }
  failures.push(detail === undefined ? name : `${name} — ${detail}`)
}
function section(title) {
  process.stdout.write(`\n${title}\n`)
}
function read(relative) {
  return readFileSync(join(ROOT, relative), 'utf8')
}

/* ───────────────────────── 1. static contract ───────────────────────── */

const clientSource = read('lib/client.js')
const hostSource = read('lib/index.js')
const routeSource = read('lib/routes.js')
const promptSource = read('lib/prompt.js')
const storeSource = read('lib/store.js')
const pkg = JSON.parse(read('package.json'))

section('1. 契约与清单')

check('package.json 有 name/version/main', typeof pkg.name === 'string' && typeof pkg.version === 'string' && typeof pkg.main === 'string')
check('package.json 声明 dsh.bundle.patch（可安装的前提）', pkg.dsh?.bundle?.patch === './cordis.patch.yml', JSON.stringify(pkg.dsh?.bundle))
check('package.json 声明 dsh.client.platform=web', pkg.dsh?.client?.platform === 'web')
check('仓库根存在 cordis.patch.yml', existsSync(join(ROOT, 'cordis.patch.yml')))
if (existsSync(join(ROOT, 'cordis.patch.yml'))) {
  const patch = read('cordis.patch.yml')
  check('cordis.patch.yml 是 insert 且 name 即包名', /insert:/.test(patch) && patch.includes(pkg.name), patch.trim())
}
check('files 只发 lib/scripts/README（不含源码副本与构建残留）', Array.isArray(pkg.files) && pkg.files.includes('lib') && !pkg.files.includes('src'))
check('host half 声明 name 与包名一致', hostSource.includes(`export const name = '${pkg.name}'`))
check('host inject 含 llm / webServer / agentDefaultModel', /export const inject = \['llm', 'webServer', 'agentDefaultModel'\]/.test(hostSource))
check('host 声明了 agentDefaultModel（否则「跟随会话模型」静默退化）', routeSource.includes('agentDefaultModel'))
check('client inject 含 slots', /exports\.inject = \['slots'\]/.test(clientSource))
check('client 只 require react', [...clientSource.matchAll(/require\((['"])([^'"]+)\1\)/g)].every((m) => m[2] === 'react'))
check('client 不静态 import @deepseek-ai（避免预发布 peer 冲突）', !/@deepseek-ai/.test(clientSource.replace(/@deepseek-ai\/dsh-client-ui-conversation/g, '')))
check('host 四个源文件均无外部依赖', !/from '@deepseek-ai/.test(hostSource + routeSource + promptSource + storeSource))

const registers = [...clientSource.matchAll(/slots\.register\(\{\s*name:\s*'([^']+)'/g)].map((m) => m[1])
check('恰好 6 个字面 slots.register（预检按字面读取）', registers.length === 6, registers.join(','))
check(
  '注册座位 = 工具行×2 + 输入卡浮层×2（旁路提问 + 完成通知）+ composer dock + 设置页',
  registers.includes('conversation.input.left')
    && registers.includes('conversation.input.overlay')
    && registers.includes('conversation.input.dock')
    && registers.includes('settings.section'),
  registers.join(','),
)
check('每个注册都带 id 与 order', (clientSource.match(/slots\.register\(\{[^}]*id: ID[^}]*order:/g) ?? []).length === 6)
check('侧问座位用 session 作用域（浮层在输入卡内，拿得到 useChat）', clientSource.includes("const OVERLAY_SLOT = 'conversation.input.overlay'"))
// A list slot rejects a second entry under an id it already holds, and that
// rejection fails activation — so the two composer-row entries must not share one.
const seatIds = [...clientSource.matchAll(/slots\.register\(\{\s*name:\s*'([^']+)',\s*id:\s*([^,]+),/g)].map((m) => `${m[1]}|${m[2].trim()}`)
check('同一座位内没有重复的注册 id', new Set(seatIds).size === seatIds.length, seatIds.join(' '))
check('无 execCommand（不碰编辑器 DOM 内部）', !clientSource.includes('execCommand'))
check('无 textarea.value 直接写值', !/\.value\s*=/.test(clientSource))
check('草稿唯一写入口是 inputActions.setDraft', (clientSource.match(/setDraft\?\.\(/g) ?? []).length >= 3)
check('client 路由前缀与 host 一致', clientSource.includes("const ROUTE = 'dsh-prompt-optimizer/'") && routeSource.includes("export const ROUTE_PREFIX = '/dsh-prompt-optimizer'"))

// The project was repositioned from a single-purpose prompt optimizer to a
// personal DSH plugin suite. The old display name must not survive anywhere —
// so it is spelled out of pieces here: a literal would make this very file the
// one remaining hit of the search the rename has to pass.
const OLD_PROJECT_NAME = ['提示词', '优化'].join('')
const readmeSource = read('README.md')
check('旧项目名在仓库里已无残留（README / 两个半区 / 清单）',
  [readmeSource, clientSource, hostSource, routeSource, promptSource, storeSource, JSON.stringify(pkg)]
    .every((text) => !text.includes(OLD_PROJECT_NAME)))
check('设置页用集合名（导航与标题）',
  clientSource.includes("settingsNav: '插件优化集合'")
  && clientSource.includes("settingsTitle: 'DSH 插件优化集合'")
  && clientSource.includes("settingsNav: 'Plugin suite'"))
check('指向设置页的报错文案已跟着改名', !routeSource.includes(OLD_PROJECT_NAME) && routeSource.includes('设置 → 插件优化集合'))
check('README 以集合定位起头并留下标识符不变的说明',
  readmeSource.startsWith('# DSH 插件优化集合') && readmeSource.includes('标识符保持不变'))
check('client 读草稿芯片（occurrences）以守卫整稿替换', clientSource.includes('state.occurrences'))
check('client 读 draftRev 实现「只在草稿未变时自动替换」', clientSource.includes('state.draftRev'))

const cssText = /const CSS = `([\s\S]*?)`\n/.exec(clientSource)?.[1] ?? ''
check('CSS 无字面色值（只用主题 token）', !/#[0-9a-fA-F]{3,8}\b/.test(cssText) && !/\brgba?\(/.test(cssText))
check('CSS 定义了卡片 / 面板 / 设置页三组类', ['dspo-btn', 'dspo-card', 'dspo-set'].every((name) => cssText.includes(`.${name}`)))
// The tabbed settings page brought its own three classes. `.dspo-tabs` would
// satisfy a bare `.dspo-tab` substring test, so the tab selector is matched
// with its own boundary.
check('CSS 定义了标签栏 / 页签 / 面板三组类',
  /\.dspo-tabs\s*\{/.test(cssText)
  && /\.dspo-tab(?![\w-])/.test(cssText)
  && /\.dspo-tabpanel\s*\{/.test(cssText))
// The panel scrolls itself, so its head has to be pinned inside that scroller:
// a plain flow child rides the wheel away with the transcript.
check('旁路面板自己滚动、头部固定（sticky + 不透明背景）',
  /\.dspo-btw\s*\{[^}]*overflow:\s*auto/.test(cssText)
  && /\.dspo-btw-head\s*\{[^}]*position:\s*sticky[^}]*top:\s*0/.test(cssText)
  && /\.dspo-btw-head\s*\{[^}]*background:/.test(cssText))
// Measured failure mode: a sticky box pins to the scrollport's *content* edge,
// so block-start padding on the scroller left an 11px strip above the head that
// the transcript scrolled through. The spacing lives in the head instead.
check('滚动容器不留 block-start 内边距（头部与滚动口齐平，不留缝）',
  /\.dspo-btw\s*\{[^}]*padding:\s*0\s/.test(cssText)
  && /\.dspo-btw-head\s*\{[^}]*padding:\s*10px/.test(cssText))

/* ───────────────────────── 2. prompt + store ───────────────────────── */

const prompt = await import('../lib/prompt.js')
const store = await import('../lib/store.js')
const compaction = await import('../lib/compaction.js')
const notify = await import('../lib/notify.js')

section('2. 提示词与设置')

const defaultPrompt = prompt.DEFAULT_SYSTEM_PROMPT
for (const marker of ['保真', '补全字段', '消除矛盾', '体量', '禁止', '输出', '待确认', '长度与任务相称', '不编造']) {
  check(`默认提示词含「${marker}」`, defaultPrompt.includes(marker))
}
check('默认提示词长度在 1000-4000 字之间（够细但不失控）', defaultPrompt.length > 1000 && defaultPrompt.length < 4000, String(defaultPrompt.length))
check('档位指令覆盖 store 的全部档位', store.STYLE_CHOICES.every((id) => id in prompt.STYLE_DIRECTIVES), Object.keys(prompt.STYLE_DIRECTIVES).join(','))
check('standard 档位不追加任何指令', prompt.styleDirective('standard') === '')
check('未知档位退化为 standard', prompt.styleDirective('nope') === '')
check('slim 档位要求短于原文', prompt.styleDirective('slim').includes('短于原文'))
check('expand 档位仍受「不超过原文 3 倍」约束', prompt.styleDirective('expand').includes('3 倍'))
check('agent 模板恰好一个草稿占位符', prompt.AGENT_TEMPLATE.split(prompt.AGENT_TEMPLATE_PLACEHOLDER).length === 2)
check('agent 模板不含提交/网络语义', !/fetch|submit/i.test(prompt.AGENT_TEMPLATE))
const spliced = prompt.buildAgentTemplate('用 $& 修一个 bug')
check('模板拼接对 $& 免疫（不用 replace 模式）', spliced.includes('用 $& 修一个 bug') && spliced.split(prompt.AGENT_TEMPLATE_PLACEHOLDER).length === 1)
check('findAssumptions 抽出待确认并剥离列表符号', JSON.stringify(prompt.findAssumptions('正文\n\n## 待确认\n- 假设A\n2. 假设B')) === JSON.stringify({ body: '正文', assumptions: '假设A\n假设B' }))
check('无待确认小节时原样返回', JSON.stringify(prompt.findAssumptions('只有正文')) === JSON.stringify({ body: '只有正文', assumptions: null }))
check('空待确认小节不产生假设', prompt.findAssumptions('正文\n\n## 待确认\n').assumptions === null)
check('normalizeAnswer 剥掉整体代码围栏', prompt.normalizeAnswer('```md\n正文\n```') === '正文')
check('buildPayload 用配对分隔符包裹草稿', prompt.buildPayload('draft').includes('draft') && prompt.buildPayload('draft').split('\n').length === 3)

check('store 默认值齐全', ['systemPrompt', 'provider', 'model', 'reasoningEffort', 'followSessionModel', 'style', 'applyMode', 'route', 'shortcut'].every((key) => key in store.DEFAULT_SETTINGS))
check('默认跟随会话模型（零配置可用）', store.DEFAULT_SETTINGS.followSessionModel === true)
check('默认思考强度为 off（改写任务不需要长推理）', store.DEFAULT_SETTINGS.reasoningEffort === 'off')
check('默认直接替换（一键路径不变）', store.DEFAULT_SETTINGS.applyMode === 'auto')
check('默认档位 standard / 路由 plugin', store.DEFAULT_SETTINGS.style === 'standard' && store.DEFAULT_SETTINGS.route === 'plugin')
check('readSettings 对缺失文件给默认值', JSON.stringify(store.readSettings()) === JSON.stringify({ ...store.DEFAULT_SETTINGS }))
writeFileSync(store.CONFIG_FILE, JSON.stringify({ reasoningEffort: 'ultra', style: 'nope', applyMode: 'x', route: 'y', shortcut: 'yes', followSessionModel: 1 }))
const tolerant = store.readSettings()
check('readSettings 对非法枚举值回退默认', tolerant.reasoningEffort === 'off' && tolerant.style === 'standard' && tolerant.applyMode === 'auto' && tolerant.route === 'plugin')
check('readSettings 对非布尔回退默认', tolerant.shortcut === true && tolerant.followSessionModel === true)
store.writeSettings({ style: 'slim', shortcut: false, followSessionModel: false, systemPrompt: '自定义' })
const written = store.readSettings()
check('writeSettings 落盘并读回', written.style === 'slim' && written.shortcut === false && written.followSessionModel === false && written.systemPrompt === '自定义')
store.writeSettings({ systemPrompt: '', provider: null, model: null, reasoningEffort: 'off', followSessionModel: true, style: 'standard', applyMode: 'auto', route: 'plugin', shortcut: true })
check('空提示词等价于「回到内置默认」', store.readSettings().systemPrompt === null)

/* ── 旁路提问（/btw）：提示词、消息拼装、历史文件 ── */

const btwPrompt = prompt.BTW_SYSTEM_PROMPT
check('旁路提示词声明「临时提问」定位', btwPrompt.includes('旁路提问'))
check('旁路提示词禁止用工具', btwPrompt.includes('没有工具') && btwPrompt.includes('不能跑命令'))
check('旁路提示词声明只回答、不写入', btwPrompt.includes('只回答') && btwPrompt.includes('不能写文件') && btwPrompt.includes('写会话'))
check('旁路提示词禁止反问', btwPrompt.includes('不反问'))
check('旁路提示词要求简短', btwPrompt.includes('简短'))
check('旁路提示词要求只用给定上下文、不得编造', btwPrompt.includes('不要编造'))
check('旁路提示词与改写提示词不同（一个是回答、一个是改写）', btwPrompt !== defaultPrompt && !btwPrompt.includes('只产出更好的提示词'))

const noContext = prompt.buildBtwPayload('这是什么？', '')
check('空上下文时显式声明「没有携带上下文」', noContext.includes('没有携带会话上下文') && noContext.includes('这是什么？'))
const withContext = prompt.buildBtwPayload('这是什么？', '用户：改一下登录页\n\n助手：好的')
check('上下文用配对分隔符包裹后随问题一起发送', withContext.indexOf('改一下登录页') < withContext.indexOf('这是什么？'))
check('上下文与问题各有一对分隔符', (withContext.match(/<<<会话上下文>>>/g) ?? []).length === 1 && (withContext.match(/<<<旁路问题>>>/g) ?? []).length === 1)

const firstMessages = prompt.buildBtwMessages({ question: '问题一', context: '用户：上下文', history: [] })
check('首轮只有一条用户消息', firstMessages.length === 1 && firstMessages[0].role === 'user')
check('首轮消息里带上下文与问题', firstMessages[0].content[0].text.includes('上下文') && firstMessages[0].content[0].text.includes('问题一'))
const followMessages = prompt.buildBtwMessages({
  question: '问题二',
  context: '用户：上下文',
  history: [{ question: '问题一', answer: '答案一' }],
})
check('追问把上一轮拼成真实的 user/assistant 对', followMessages.length === 3 && followMessages[1].role === 'assistant' && followMessages[1].content[0].text === '答案一')
check('追问不再重复上下文（只随首个问题发送）', !followMessages[2].content[0].text.includes('会话上下文') && followMessages[2].content[0].text === '问题二')
check('历史里残缺的轮次被跳过', prompt.buildBtwMessages({ question: 'q', context: '', history: [{ question: '', answer: 'a' }] }).length === 1)
const longThread = prompt.buildBtwMessages({
  question: '第 31 问',
  context: '用户：上下文',
  history: Array.from({ length: 30 }, (_, index) => ({ question: `问${index}`, answer: `答${index}` })),
})
check('追问携带该话题的全部历史轮次（无条数截断）', longThread.length === 61
  && longThread[0].content[0].text.includes('问0')
  && longThread[58].content[0].text === '问29')

// DSH reads `message.source.replayState` on *every* assistant message while it
// picks the adapter (`LlmRuntime#forAdapter` in `@deepseek-ai/dsh-llm`), so an
// assistant turn built by hand without a `source` throws inside adapter
// dispatch and the whole call dies with a terminal error chunk — that is what
// broke the first follow-up. Verified against the installed package by
// `_dsh-prompt-tuner-verify/btw-thread-shape.mjs`.
const sourcedThread = prompt.buildBtwMessages({
  question: '问题二',
  context: '用户：上下文',
  history: [{ question: '问题一', answer: '答案一' }],
  provider: 'deepseek-official',
  model: 'deepseek-flash',
})
check('追问里的 assistant 轮次带 source（DSH 适配器分发要求）',
  sourcedThread[1].source?.kind === 'model'
  && sourcedThread[1].source.provider === 'deepseek-official'
  && sourcedThread[1].source.model === 'deepseek-flash')
check('source 不带 replayState（不冒领原生重放元数据）', sourcedThread[1].source.replayState === undefined)
check('只有模型产出的轮次带 source', sourcedThread[0].source === undefined && sourcedThread[2].source === undefined)

const foldedThread = prompt.buildBtwThreadAsTurn({
  question: '问题二',
  context: '用户：上下文',
  history: [{ question: '问题一', answer: '答案一' }, { question: '残缺', answer: '' }],
})
check('兜底形状折成一条用户消息（没有 assistant 轮次可被拒）',
  foldedThread.length === 1 && foldedThread[0].role === 'user')
check('兜底形状仍带上此前的问答与本次追问',
  foldedThread[0].content[0].text.includes('问：问题一')
  && foldedThread[0].content[0].text.includes('答：答案一')
  && foldedThread[0].content[0].text.includes('本次追问：\n问题二'))
check('兜底形状同样跳过残缺轮次', !foldedThread[0].content[0].text.includes('残缺'))
check('没有历史时兜底形状与首轮消息完全一致',
  prompt.buildBtwThreadAsTurn({ question: '问题一', context: '' })[0].content[0].text === prompt.buildBtwPayload('问题一', ''))

check('旁路历史与设置分文件存放', store.BTW_HISTORY_FILE !== store.CONFIG_FILE && store.BTW_HISTORY_FILE.endsWith('prompt-tuner-btw.json'))
check('旁路默认携带全部历史消息', store.DEFAULT_SETTINGS.btwContextTurns === store.BTW_CONTEXT_ALL && store.BTW_CONTEXT_ALL === 'all')
check('旁路默认保存历史', store.DEFAULT_SETTINGS.btwSaveHistory === true)
check('上下文档位是 全部/0/4/8/16（0 = 不读会话）', JSON.stringify([...store.BTW_CONTEXT_CHOICES]) === JSON.stringify(['all', 0, 4, 8, 16]))
store.writeSettings({ btwContextTurns: 99, btwSaveHistory: 'yes' })
const btwTolerant = store.readSettings()
check('旁路设置对非法取值回退默认（全部历史）', btwTolerant.btwContextTurns === 'all' && btwTolerant.btwSaveHistory === true)
store.writeSettings({ btwContextTurns: 0, btwSaveHistory: false })
const btwWritten = store.readSettings()
check('旁路设置可写入并读回', btwWritten.btwContextTurns === 0 && btwWritten.btwSaveHistory === false)
store.writeSettings({ btwContextTurns: 'all', btwSaveHistory: true })
check('旁路设置可写回「全部历史」', store.readSettings().btwContextTurns === 'all')

check('空历史文件读成空历史（不抛）', JSON.stringify(store.readBtwHistory()) === JSON.stringify({ version: 1, sessions: {} }))
const appended = store.appendBtwTurn('session-a', { question: '问题一', answer: '答案一', at: 1 })
check('appendBtwTurn 新建话题并回传 topics', appended.topicId !== '' && appended.topics.length === 1 && appended.saved === true)
const appendedAgain = store.appendBtwTurn('session-a', { topicId: appended.topicId, question: '问题二', answer: '答案二', at: 2 })
check('同话题追问落在同一 topic 上', appendedAgain.topicId === appended.topicId && appendedAgain.topics[0].turns.length === 2)
check('两个会话的历史互不覆盖', store.appendBtwTurn('session-b', { question: 'b1', answer: 'b2', at: 3 }).topics.length === 1 && store.btwTopics('session-a')[0].turns.length === 2)
check('按会话读回历史', store.btwTopics('session-a')[0].turns[0].q === '问题一' && store.btwTopics('nope').length === 0)
store.clearBtwTopics('session-a')
check('clearBtwTopics 只清一个会话', store.btwTopics('session-a').length === 0 && store.btwTopics('session-b').length === 1)
writeFileSync(store.BTW_HISTORY_FILE, '{"sessions": "not an object"}')
check('坏历史文件退化为空历史', store.btwTopics('session-b').length === 0)
for (let i = 0; i < store.BTW_LIMITS.topicsPerSession + 5; i += 1) {
  store.appendBtwTurn('session-c', { question: `q${i}`, answer: `a${i}`, at: i + 10 })
}
check(`每个会话最多保留 ${store.BTW_LIMITS.topicsPerSession} 个话题`, store.btwTopics('session-c').length === store.BTW_LIMITS.topicsPerSession)
check('话题裁剪保留的是最新的', store.btwTopics('session-c').at(-1).turns[0].q === `q${store.BTW_LIMITS.topicsPerSession + 4}`)

/* ───────────────────────── 3. host routes ───────────────────────── */

const { ROUTE_PREFIX, registerRoutes } = await import('../lib/routes.js')

section('3. 宿主路由')

/** One fake request: an async iterable body plus the headers the fence reads. */
function makeReq(body, options = {}) {
  const text = JSON.stringify(body ?? {})
  const listeners = new Map()
  const req = {
    method: options.method ?? 'POST',
    url: options.url ?? `${ROUTE_PREFIX}/state`,
    headers: {
      host: options.host ?? '127.0.0.1:3080',
      'content-type': options.contentType ?? 'application/json',
      ...(options.headers ?? {}),
    },
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    on(event, handler) {
      listeners.set(event, handler)
      return req
    },
    async *[Symbol.asyncIterator]() {
      if (options.malformed === true) {
        yield Buffer.from('{not json')
        return
      }
      yield Buffer.from(text)
    },
  }
  return req
}

/** One fake response that records what the handler wrote. */
function makeRes() {
  const res = {
    status: 0,
    headers: {},
    chunks: [],
    headersSent: false,
    writeHead(status, headers) {
      res.status = status
      res.headers = headers ?? {}
      res.headersSent = true
      return res
    },
    write(chunk) {
      res.chunks.push(String(chunk))
      return true
    },
    once() {
      return res
    },
    end(chunk) {
      if (chunk !== undefined) res.chunks.push(String(chunk))
      return res
    },
    get body() {
      return res.chunks.join('')
    },
    get json() {
      const raw = res.chunks.join('')
      try {
        return JSON.parse(raw)
      } catch {
        return null
      }
    },
  }
  return res
}

/** A host context whose `llm` plays a scripted sequence of calls. */
function makeCtx(script, options = {}) {
  const calls = []
  const ctx = {
    logger: { warn() {}, info() {} },
    webServer: {
      register(route) {
        ctx.route = route
        return () => {}
      },
    },
    agentDefaultModel: {
      currentSelection: () => options.sessionModel ?? { provider: 'deepseek-official', model: 'deepseek-flash' },
    },
    llm: {
      listProviders: () => [
        { id: 'deepseek-official', name: 'DeepSeek' },
        { id: 'ccx', name: 'CCX' },
      ],
      listModels: async (id) => (id === 'deepseek-official'
        ? [{ id: 'deepseek-flash', name: 'Flash' }, { id: 'deepseek-pro', name: 'Pro' }]
        : [{ id: 'ccx-1', name: 'CCX 1' }]),
      resolveModelInfo: async (provider, model) => {
        const base = options.reasoning === undefined
          ? { reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }], defaultEffort: 'high' } }
          : options.reasoning
        return {
          ...(base ?? {}),
          // Real adapters advertise `context.contextWindow`; the compaction half
          // reads it to turn a fixed token count into that model's ratio.
          ...(options.contextWindow === undefined ? {} : { context: { contextWindow: options.contextWindow } }),
        }
      },
      stream(call) {
        const index = calls.length
        calls.push(call)
        const steps = typeof script === 'function' ? script(call, index) : script[Math.min(index, script.length - 1)]
        return (async function* run() {
          for (const step of steps) {
            if (step === 'throw') throw new Error('adapter exploded')
            yield step
          }
        })()
      },
    },
  }
  ctx.calls = calls
  if (options.configEditor !== undefined) ctx.configEditor = options.configEditor
  return ctx
}

const stateEnvelope = { ok: true, value: { settings: { ...store.DEFAULT_SETTINGS }, models: [], active: null } }

async function call(ctx, action, body, options) {
  const req = makeReq(body, { ...options, url: `${ROUTE_PREFIX}${action}` })
  const res = makeRes()
  await ctx.route.handler(req, res)
  return res
}

{
  const ctx = makeCtx([[]])
  const dispose = registerRoutes(ctx)
  check('注册为 prefix 路由', ctx.route.kind === 'prefix' && ctx.route.path === ROUTE_PREFIX)
  check('返回 disposer', typeof dispose === 'function')

  const fence = [
    ['非回环地址被拒', await call(ctx, '/state', {}, { remoteAddress: '10.0.0.5' }), 403],
    ['非回环 Host 被拒', await call(ctx, '/state', {}, { host: 'evil.example' }), 403],
    ['Sec-Fetch-Site: cross-site 被拒', await call(ctx, '/state', {}, { headers: { 'sec-fetch-site': 'cross-site' } }), 403],
    ['非 POST 被拒', await call(ctx, '/state', {}, { method: 'GET' }), 405],
    ['非 JSON content-type 被拒', await call(ctx, '/state', {}, { contentType: 'text/plain' }), 415],
  ]
  for (const [name, res, status] of fence) check(name, res.status === status, String(res.status))
  check('坏 JSON 体回 bad-request', (await call(ctx, '/state', {}, { malformed: true })).json?.error?.code === 'bad-request')
  check('未知 action 回 404', (await call(ctx, '/nope', {})).status === 404)

  const state = (await call(ctx, '/state', {})).json
  check('/state 有 settings/active/models/limits', state?.value?.settings !== undefined && 'active' in state.value && Array.isArray(state.value.models))
  check('/state 带内置默认提示词与档位清单', typeof state.value.defaultSystemPrompt === 'string' && state.value.styleChoices.length === 4)
  check('/state 带 agent 模板（含占位符）', typeof state.value.agentTemplate?.text === 'string' && typeof state.value.agentTemplate.placeholder === 'string')
  check('/state 带三种应用模式与两种路由', state.value.applyModes.length === 2 && state.value.routes.length === 2)
  check('/state 报告路由支持的思考强度', Array.isArray(state.value.reasoning?.efforts) && state.value.reasoning.defaultEffort === 'high')
  check('/state 默认跟随会话模型', state.value.settings.followSessionModel === true)
  check('/state 的 active 取会话模型', state.value.active?.model === 'deepseek-flash', JSON.stringify(state.value.active))

  const saved = (await call(ctx, '/save', { style: 'structured', applyMode: 'review', route: 'agent', shortcut: false })).json
  check('/save 接受合法枚举', saved.value.settings.style === 'structured' && saved.value.settings.applyMode === 'review' && saved.value.settings.route === 'agent' && saved.value.settings.shortcut === false)
  check('/save 拒绝非法档位', (await call(ctx, '/save', { style: 'nope' })).json?.error?.code === 'bad-request')
  check('/save 拒绝非布尔 shortcut', (await call(ctx, '/save', { shortcut: 'yes' })).json?.error?.code === 'bad-request')
  const picked = (await call(ctx, '/save', { provider: 'ccx', model: 'ccx-1' })).json
  check('手选模型自动关闭「跟随会话」', picked.value.settings.followSessionModel === false && picked.value.active?.model === 'ccx-1')
  const cleared = (await call(ctx, '/save', { provider: null, model: null })).json
  check('清空选择自动恢复「跟随会话」', cleared.value.settings.followSessionModel === true && cleared.value.active?.model === 'deepseek-flash')
  await call(ctx, '/save', { reasoningEffort: 'off', style: 'standard', applyMode: 'auto', route: 'plugin', shortcut: true })
}

/* ── the rewrite itself ── */

const textStep = (text) => [{ type: 'text-delta', text }, { type: 'finish', reason: { kind: 'stop' } }]

{
  const ctx = makeCtx([textStep('改写结果\n\n## 待确认\n- 假设一')])
  registerRoutes(ctx)
  const res = await call(ctx, '/optimize', { text: '原始草稿' })
  const value = res.json?.value
  check('/optimize 正常返回改写文本', value?.text === '改写结果\n\n## 待确认\n- 假设一', JSON.stringify(res.json))
  check('/optimize 单独返回待确认项（不剥离正文）', value?.assumptions === '假设一')
  check('/optimize 返回字数与耗时', value?.originalChars === 4 && value?.optimizedChars > 4 && typeof value?.timings?.totalMs === 'number')
  check('/optimize 默认只调用一次', ctx.calls.length === 1, String(ctx.calls.length))
  check('/optimize 默认发 off 思考强度', ctx.calls[0].reasoningEffort === 'off')
  check('/optimize 发送输出预算 maxTokens', typeof ctx.calls[0].maxTokens === 'number' && ctx.calls[0].maxTokens >= 768)
  check('/optimize 用配对分隔符包裹草稿', ctx.calls[0].messages[0].content[0].text.includes('原始草稿'))
  check('/optimize 默认档位不追加指令', !ctx.calls[0].system.includes('本次档位'))
  check('/optimize 结果含 provider/model', typeof value?.provider === 'string' && typeof value?.model === 'string')
}

{
  const ctx = makeCtx([textStep('x')])
  registerRoutes(ctx)
  await call(ctx, '/optimize', { text: '草稿', style: 'slim' })
  check('档位把风格指令追加进系统提示', ctx.calls[0].system.includes('本次档位：精简'))
}

{
  const ctx = makeCtx([textStep('x')])
  registerRoutes(ctx)
  await call(ctx, '/save', { reasoningEffort: 'high' })
  const res = await call(ctx, '/optimize', { text: '草稿' })
  check('settings 的 high 会被发送', ctx.calls[0].reasoningEffort === 'high' && res.json.value.effort === 'high')
}

{
  const ctx = makeCtx([textStep('x')])
  registerRoutes(ctx)
  await call(ctx, '/save', { reasoningEffort: 'auto' })
  await call(ctx, '/optimize', { text: '草稿' })
  check('auto 完全不发送 reasoningEffort 字段', !('reasoningEffort' in ctx.calls[0]))
}

{
  const ctx = makeCtx([textStep('x')], { reasoning: { reasoning: { efforts: [{ id: 'off' }, { id: 'high' }], defaultEffort: 'high' } } })
  registerRoutes(ctx)
  await call(ctx, '/save', { reasoningEffort: 'max' })
  const res = await call(ctx, '/optimize', { text: '草稿' })
  check('路由不支持的强度降级为 off', ctx.calls[0].reasoningEffort === 'off' && res.json.value.effortDegraded === true)
}

{
  // Ladder rung 2: the budget ran out before any text.
  const ctx = makeCtx([
    [{ type: 'finish', reason: { kind: 'error', failure: { code: 'EMPTY_LENGTH', message: 'budget eaten' } } }],
    textStep('第二次成功'),
  ])
  registerRoutes(ctx)
  const res = await call(ctx, '/optimize', { text: '草稿' })
  check('EMPTY_LENGTH 触发第二次调用', ctx.calls.length === 2, String(ctx.calls.length))
  check('第二次改用 off 且放大预算', ctx.calls[1].reasoningEffort === 'off' && ctx.calls[1].maxTokens > ctx.calls[0].maxTokens)
  check('第二次成功即返回并标记放大预算', res.json.value?.text === '第二次成功' && res.json.value.budgetBoosted === true && res.json.value.attempts === 2)
}

{
  // Ladder rung 3: any other failure drops both optional fields.
  const ctx = makeCtx([
    [{ type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_PARAM', message: 'gateway says no' } } }],
    textStep('去掉参数后成功'),
  ])
  registerRoutes(ctx)
  const res = await call(ctx, '/optimize', { text: '草稿' })
  check('其它失败触发去参重试', ctx.calls.length === 2 && !('reasoningEffort' in ctx.calls[1]) && !('maxTokens' in ctx.calls[1]))
  check('去参重试成功并标记 effortDropped', res.json.value?.text === '去掉参数后成功' && res.json.value.effortDropped === true)
}

{
  // Ladder rung 2 (truncation): raise the ceiling, keep the cheap effort. Sending
  // neither field here would silently re-enable the adapter's default reasoning,
  // which is the ten-second answer this plugin exists to avoid.
  const ctx = makeCtx([
    [{ type: 'text-delta', text: '半截' }, { type: 'finish', reason: { kind: 'max-tokens' } }],
    textStep('放大预算后完整'),
  ])
  registerRoutes(ctx)
  const res = await call(ctx, '/optimize', { text: '草稿' })
  check('截断触发放大预算的第二次调用', ctx.calls.length === 2, String(ctx.calls.length))
  check('截断重试保留 off 而不是丢掉档位', ctx.calls[1].reasoningEffort === 'off', String(ctx.calls[1].reasoningEffort))
  check('截断重试确实放大预算', ctx.calls[1].maxTokens > ctx.calls[0].maxTokens)
  check('截断重试成功即返回', res.json.value?.text === '放大预算后完整' && res.json.value.budgetBoosted === true && res.json.value.effortDropped === false)
}

{
  // Three failures in a row: the ladder must stop, not loop.
  const ctx = makeCtx([
    [{ type: 'finish', reason: { kind: 'error', failure: { code: 'EMPTY_LENGTH', message: 'a' } } }],
    [{ type: 'finish', reason: { kind: 'error', failure: { code: 'STILL_BAD', message: 'b' } } }],
    [{ type: 'finish', reason: { kind: 'error', failure: { code: 'STILL_BAD', message: 'c' } } }],
    textStep('不该到达'),
  ])
  registerRoutes(ctx)
  const res = await call(ctx, '/optimize', { text: '草稿' })
  check('阶梯最多三次调用', ctx.calls.length === 3, String(ctx.calls.length))
  check('三次失败后如实报错', res.json?.ok === false && res.json.timings?.attempts === 3)
}

{
  const ctx = makeCtx([textStep('x')])
  registerRoutes(ctx)
  const res = await call(ctx, '/optimize', { text: '   ' })
  check('空草稿被拒且不调用模型', res.json?.error?.code === 'bad-request' && ctx.calls.length === 0)
  const long = await call(ctx, '/optimize', { text: 'x'.repeat(prompt.MAX_DRAFT_CHARS + 1) })
  check('超长草稿被拒且不调用模型', long.json?.error?.code === 'bad-request' && ctx.calls.length === 0)
}

{
  const ctx = makeCtx([textStep('x')], { sessionModel: null })
  ctx.llm.listModels = async () => []
  registerRoutes(ctx)
  const res = await call(ctx, '/optimize', { text: '草稿' })
  check('无任何模型时回 no-model', res.json?.error?.code === 'no-model')
}

{
  const ctx = makeCtx([[{ type: 'text-delta', text: '半截' }, { type: 'finish', reason: { kind: 'max-tokens' } }]])
  registerRoutes(ctx)
  const res = await call(ctx, '/optimize', { text: '草稿' })
  check('截断如实报错而不是写入半截', res.json?.error?.code === 'truncated', JSON.stringify(res.json?.error))
}

{
  const ctx = makeCtx([[{ type: 'text-delta', text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }]])
  registerRoutes(ctx)
  const req = makeReq({ text: '草稿' }, { url: `${ROUTE_PREFIX}/optimize.stream` })
  const res = makeRes()
  await ctx.route.handler(req, res)
  const frames = res.body.split('\n\n').filter((frame) => frame.trim() !== '')
  const names = frames.map((frame) => /^event:\s*(.+)$/m.exec(frame)?.[1]?.trim())
  check('SSE 先 delta 后 done', names[0] === 'delta' && names[names.length - 1] === 'done', names.join(','))
  check('SSE 头不缓存且不缓冲', res.headers['content-type'].startsWith('text/event-stream') && res.headers['cache-control'] === 'no-store')
  const done = JSON.parse(frames[frames.length - 1].split('\n').find((line) => line.startsWith('data:')).slice(5))
  check('done 帧携带完整结果', done.ok === true && done.value.text === 'ok')
}

{
  const ctx = makeCtx([[{ type: 'finish', reason: { kind: 'error', failure: { code: 'BOOM', message: 'no' } } }]])
  registerRoutes(ctx)
  const req = makeReq({ text: '草稿' }, { url: `${ROUTE_PREFIX}/optimize.stream` })
  const res = makeRes()
  await ctx.route.handler(req, res)
  check('SSE 失败也走事件帧而非裸 500', res.body.includes('event: failed') && res.status === 200)
}

/* ── 旁路提问路由（/btw*） ── */

const btwStep = (text) => [{ type: 'text-delta', text }, { type: 'finish', reason: { kind: 'stop' } }]
store.clearBtwTopics('session-a')

{
  const ctx = makeCtx([btwStep('旁路答案')])
  registerRoutes(ctx)
  const state = (await call(ctx, '/state', {})).json
  check('/state 带旁路提问契约（档位、历史文件、提示词；上下文无上限）', Array.isArray(state.value.btw?.contextTurnChoices)
    && state.value.btw.maxQuestionChars > 0
    && state.value.btw.maxContextChars === undefined
    && typeof state.value.btw.historyFile === 'string'
    && typeof state.value.btw.prompt === 'string')

  const saved = (await call(ctx, '/save', { btwContextTurns: 4, btwSaveHistory: false })).json
  check('/save 接受旁路设置', saved.value.settings.btwContextTurns === 4 && saved.value.settings.btwSaveHistory === false)
  check('/save 拒绝非法上下文档位', (await call(ctx, '/save', { btwContextTurns: 7 })).json?.error?.code === 'bad-request')
  check('/save 拒绝非布尔历史开关', (await call(ctx, '/save', { btwSaveHistory: 'yes' })).json?.error?.code === 'bad-request')
  check('/save 接受「全部历史」档位', (await call(ctx, '/save', { btwContextTurns: 'all' })).json?.value?.settings?.btwContextTurns === 'all')
  await call(ctx, '/save', { btwContextTurns: 'all', btwSaveHistory: true })

  const res = await call(ctx, '/btw', { question: '登录页改了吗？', context: '用户：改一下登录页', history: [{ question: '上一问', answer: '上一答' }] })
  const value = res.json?.value
  check('/btw 返回答案', value?.text === '旁路答案', JSON.stringify(res.json))
  check('/btw 用旁路提示词而不是改写提示词', ctx.calls[0].system.includes('没有工具') && !ctx.calls[0].system.includes('待确认'))
  check('/btw 把上下文与问题拼成一条带分隔符的用户消息', ctx.calls[0].messages[0].content[0].text.includes('改一下登录页') && ctx.calls[0].messages[0].content[0].text.includes('上一问') && ctx.calls[0].messages[2].content[0].text === '登录页改了吗？')
  check('/btw 追问拼成真实的多轮消息', ctx.calls[0].messages.length === 3 && ctx.calls[0].messages[1].role === 'assistant')
  check('/btw 追问的 assistant 轮次带上了路由来源', ctx.calls[0].messages[1].source?.provider === 'deepseek-official'
    && ctx.calls[0].messages[1].source.model === 'deepseek-flash')
  check('/btw 单轮回答标记为未经过形状兜底', value?.reshaped === false)
  check('/btw 回传上下文/轮次/耗时', value?.contextChars === '用户：改一下登录页'.length && value?.historyTurns === 1 && typeof value?.timings?.totalMs === 'number')
  check('/btw 默认发 off 思考强度与输出预算', ctx.calls[0].reasoningEffort === 'off' && typeof ctx.calls[0].maxTokens === 'number')
  check('/btw 走的是会话模型路由', ctx.calls[0].provider === 'deepseek-official' && ctx.calls[0].model === 'deepseek-flash')
  // The read-only contract, asserted against the call the route actually makes:
  // no tool list travels with it, and the fake host carries no write-capable
  // service (no conversation, no agent, no filesystem) for the route to reach.
  check('/btw 不给模型任何工具', ctx.calls[0].tools === undefined && ctx.calls[0].toolChoice === undefined)
  check('/btw 不需要任何写能力（宿主上下文里没有会话/agent/文件能力）',
    !('conversation' in ctx) && !('agent' in ctx) && !('fs' in ctx) && !('tools' in ctx))

  // The side-question half's own model and effort. They are saved under `btw*`,
  // applied to the next question, and read by nothing else — the rewrite keeps
  // its own pair, and "not chosen" still falls back exactly like the rewrite's.
  check('/btw 不设置旁路模型时回落到会话模型（与「优化提示词」的默认一致）',
    ctx.calls[0].provider === 'deepseek-official' && ctx.calls[0].model === 'deepseek-flash'
      && ctx.calls[0].reasoningEffort === 'off')
  const rewriteBefore = await call(ctx, '/optimize', { text: '把登录页改快一点' })
  const rewriteBeforeCall = ctx.calls.at(-1)
  const settingsBefore = (await call(ctx, '/state', {})).json.value.settings
  const btwSaved = (await call(ctx, '/save', { btwProvider: 'ccx', btwModel: 'ccx-1', btwReasoningEffort: 'high' })).json
  check('/save 接受旁路提问自己的模型与强度',
    btwSaved.value.settings.btwProvider === 'ccx' && btwSaved.value.settings.btwModel === 'ccx-1'
      && btwSaved.value.settings.btwReasoningEffort === 'high')
  check('/save 不因为旁路设置而改动「优化提示词」的设置',
    ['provider', 'model', 'reasoningEffort', 'followSessionModel']
      .every((key) => btwSaved.value.settings[key] === settingsBefore[key]),
    ['provider', 'model', 'reasoningEffort', 'followSessionModel']
      .map((key) => `${key}:${settingsBefore[key]}->${btwSaved.value.settings[key]}`).join(' '))
  check('/state 分别上报两半的路由（btw.active 是旁路自己的那一份）',
    btwSaved.value.btw.active?.provider === 'ccx' && btwSaved.value.btw.active?.model === 'ccx-1'
      && (btwSaved.value.active?.provider !== 'ccx' || btwSaved.value.active?.model !== 'ccx-1'))
  check('/state 的 btw.reasoning 是旁路路由自报的强度',
    Array.isArray(btwSaved.value.btw.reasoning?.efforts) && btwSaved.value.btw.reasoning.efforts.includes('high'))
  check('/save 拒绝非法旁路强度与非法旁路模型取值',
    (await call(ctx, '/save', { btwReasoningEffort: 'ultra' })).json?.error?.code === 'bad-request'
      && (await call(ctx, '/save', { btwProvider: 7 })).json?.error?.code === 'bad-request'
      && (await call(ctx, '/save', { btwModel: 7 })).json?.error?.code === 'bad-request')
  const btwCall = await call(ctx, '/btw', { question: '换个模型问问', context: '' })
  const btwUsed = ctx.calls.at(-1)
  check('/btw 用旁路提问自己的模型路由', btwUsed.provider === 'ccx' && btwUsed.model === 'ccx-1', `${btwUsed.provider}/${btwUsed.model}`)
  check('/btw 用旁路提问自己的思考强度', btwUsed.reasoningEffort === 'high' && btwCall.json?.value?.effort === 'high')
  const rewriteAfter = await call(ctx, '/optimize', { text: '把登录页改快一点' })
  const rewriteAfterCall = ctx.calls.at(-1)
  check('/btw 的模型与强度选择都不影响「优化提示词」',
    rewriteAfter.json?.ok === true
      && rewriteAfterCall.provider === rewriteBeforeCall.provider
      && rewriteAfterCall.model === rewriteBeforeCall.model
      && rewriteAfterCall.reasoningEffort === rewriteBeforeCall.reasoningEffort,
    `${rewriteBeforeCall.provider}/${rewriteBeforeCall.model}/${rewriteBeforeCall.reasoningEffort} -> ${rewriteAfterCall.provider}/${rewriteAfterCall.model}/${rewriteAfterCall.reasoningEffort}`)
  // Back to "not chosen": the fallback must be the rewrite's own fallback, which
  // is what the acceptance criterion means by identical behaviour when unset.
  await call(ctx, '/save', { btwProvider: null, btwModel: null, btwReasoningEffort: 'off' })
  const backToDefault = await call(ctx, '/btw', { question: '回到默认', context: '' })
  const fallbackUsed = ctx.calls.at(-1)
  check('清空旁路模型后回落行为与「优化提示词」不设置时一致',
    fallbackUsed.provider === 'deepseek-official' && fallbackUsed.model === 'deepseek-flash'
      && fallbackUsed.reasoningEffort === 'off' && backToDefault.json?.value?.effort === 'off')
}

{
  // The shape fallback. An adapter is free to refuse a message list it cannot
  // represent — that is exactly what killed follow-ups, with DSH reporting it
  // as a terminal error chunk instead of throwing. Re-running the same call
  // would fail identically, so the ladder re-asks with the thread folded into
  // one turn, and the envelope says the answer came from the reshaped call.
  const ctx = makeCtx((call) => (call.messages.some((message) => message.role === 'assistant')
    ? ['throw']
    : btwStep('折成单轮后的答案')))
  registerRoutes(ctx)
  const res = await call(ctx, '/btw', {
    question: '第二个问题',
    context: '用户：上下文',
    history: [{ question: '第一个问题', answer: '第一个答案' }],
  })
  check('多轮形状被适配器拒绝时改用单轮重问', res.json?.value?.text === '折成单轮后的答案' && res.json.value.reshaped === true, JSON.stringify(res.json))
  check('重问只带一条用户消息', ctx.calls.length === 2 && ctx.calls[1].messages.length === 1 && ctx.calls[1].messages[0].role === 'user')
  check('重问仍带着上一轮问答', ctx.calls[1].messages[0].content[0].text.includes('问：第一个问题')
    && ctx.calls[1].messages[0].content[0].text.includes('答：第一个答案'))
  check('重问没有把上下文塞两遍', (ctx.calls[1].messages[0].content[0].text.match(/<<<会话上下文>>>/g) ?? []).length === 1)
}

{
  // Without a thread there is only one shape, so the rewrite rung must not fire
  // an identical second call; the failure still comes back as itself.
  const ctx = makeCtx([['throw'], ['throw'], ['throw']])
  registerRoutes(ctx)
  const res = await call(ctx, '/btw', { question: '只有一个问题', context: '' })
  check('没有历史时不触发无意义的重问（只走去参那一档）', ctx.calls.length === 2 && res.json?.value?.reshaped === undefined, String(ctx.calls.length))
  check('适配器抛错时如实回显错误', res.json?.ok === false && res.json.error.message === 'adapter exploded', JSON.stringify(res.json?.error))
}

{
  // Whole-session context: nothing is dropped by count, at either end, and the
  // host keeps no length ceiling of its own for the record to trip over.
  const ctx = makeCtx([btwStep('ok')])
  registerRoutes(ctx)
  const messages = Array.from({ length: 40 }, (_, index) => `用户：第 ${index} 条消息`)
  const bigContext = messages.join('\n\n')
  const history = Array.from({ length: 30 }, (_, index) => ({ question: `问${index}`, answer: `答${index}` }))
  const res = await call(ctx, '/btw', { question: '全部历史都在吗？', context: bigContext, history })
  check('/btw 原样收下全部上下文（无字符截断）', res.json?.value?.contextChars === bigContext.length)
  check('/btw 携带该话题的全部追问轮次（无条数截断）', res.json?.value?.historyTurns === 30
    && ctx.calls[0].messages.length === 61
    && ctx.calls[0].messages[0].content[0].text.includes('第 0 条消息'))
  // A session record can be longer than any budget the plugin could name, and
  // refusing it would be a cap on the context by another name.
  const hugeContext = `{"kind":"tool-result","content":[{"type":"text","text":"${'x'.repeat(1_200_000)}"}]}`
  const huge = await call(ctx, '/btw', { question: '问题', context: hugeContext })
  check('/btw 不再对上下文设上限（超长也原样收下，不拒绝也不截断）', huge.json?.ok === true
    && huge.json.value.contextChars === hugeContext.length
    && ctx.calls.at(-1).messages[0].content[0].text.includes(hugeContext)
    && ctx.calls.length === 2)
}

{
  const ctx = makeCtx([btwStep('x')])
  registerRoutes(ctx)
  check('/btw 拒绝空问题且不调用模型', (await call(ctx, '/btw', { question: '   ' })).json?.error?.code === 'bad-request' && ctx.calls.length === 0)
  const long = await call(ctx, '/btw', { question: 'x'.repeat(prompt.MAX_BTW_QUESTION_CHARS + 1) })
  check('/btw 拒绝超长问题且不调用模型', long.json?.error?.code === 'bad-request' && ctx.calls.length === 0)
  check('/btw 接受空上下文（0 条设置）', (await call(ctx, '/btw', { question: '问题', context: '' })).json?.ok === true && ctx.calls.length === 1)
}

{
  const ctx = makeCtx([btwStep('x')], { sessionModel: null })
  ctx.llm.listModels = async () => []
  registerRoutes(ctx)
  await call(ctx, '/save', { provider: null, model: null, followSessionModel: true })
  const res = await call(ctx, '/btw', { question: '问题' })
  check('/btw 无可用模型时回 no-model', res.json?.error?.code === 'no-model' && ctx.calls.length === 0)
}

{
  const ctx = makeCtx([btwStep('流式答案')])
  registerRoutes(ctx)
  const req = makeReq({ question: '问题', context: '上下文' }, { url: `${ROUTE_PREFIX}/btw.stream` })
  const res = makeRes()
  await ctx.route.handler(req, res)
  const frames = res.body.split('\n\n').filter((frame) => frame.trim() !== '')
  const names = frames.map((frame) => /^event:\s*(.+)$/m.exec(frame)?.[1]?.trim())
  check('/btw.stream 先 delta 后 done', names[0] === 'delta' && names[names.length - 1] === 'done', names.join(','))
  const done = JSON.parse(frames[frames.length - 1].split('\n').find((line) => line.startsWith('data:')).slice(5))
  check('/btw.stream 的 done 帧携带完整信封', done.ok === true && done.value.text === '流式答案')
}

{
  // Every adapter delta gets its own frame: a short answer must still arrive
  // token by token, not as two lumps (which is what a char threshold produced).
  const ctx = makeCtx([[{ type: 'text-delta', text: '答' }, { type: 'text-delta', text: '案' }, { type: 'text-delta', text: '。' }, { type: 'finish', reason: { kind: 'stop' } }]])
  registerRoutes(ctx)
  const req = makeReq({ question: '问题' }, { url: `${ROUTE_PREFIX}/btw.stream` })
  const res = makeRes()
  await ctx.route.handler(req, res)
  const frames = res.body.split('\n\n').filter((frame) => frame.trim() !== '')
  const names = frames.map((frame) => /^event:\s*(.+)$/m.exec(frame)?.[1]?.trim())
  const deltas = frames.filter((frame) => /^event:\s*delta$/m.test(frame)).length
  check('/btw.stream 每个增量一帧（不做字数合并）', deltas === 4 && names[names.length - 1] === 'done', names.join(','))
  check('/btw.stream 最后一帧带 final 标记', /"final":true/.test(frames[frames.length - 2]))
}

{
  const ctx = makeCtx([btwStep('ok')])
  registerRoutes(ctx)
  check('/btw.history 对新会话回空历史', JSON.stringify((await call(ctx, '/btw.history', { sessionId: 'session-a' })).json?.value?.topics) === '[]')
  const saved = (await call(ctx, '/btw.save', { sessionId: 'session-a', question: '一问', answer: '一答' })).json
  check('/btw.save 新建话题并回传 id', saved?.value?.topicId !== '' && saved.value.topics.length === 1 && saved.value.disabled === false)
  const topicId = saved.value.topicId
  const again = (await call(ctx, '/btw.save', { sessionId: 'session-a', topicId, question: '二问', answer: '二答' })).json
  check('/btw.save 带 topicId 时追加到同一话题', again.value.topicId === topicId && again.value.topics[0].turns.length === 2)
  const history = (await call(ctx, '/btw.history', { sessionId: 'session-a' })).json
  check('/btw.history 读回已保存的轮次', history.value.topics[0].turns[1].q === '二问' && history.value.saveHistory === true)
  check('/btw.save 拒绝空答案', (await call(ctx, '/btw.save', { sessionId: 'session-a', question: 'q', answer: '  ' })).json?.error?.code === 'bad-request')
  check('/btw.clear 清空该会话历史', (await call(ctx, '/btw.clear', { sessionId: 'session-a' })).json?.value?.topics.length === 0
    && store.btwTopics('session-a').length === 0)
}

{
  const ctx = makeCtx([btwStep('ok')])
  registerRoutes(ctx)
  await call(ctx, '/save', { btwSaveHistory: false })
  const res = await call(ctx, '/btw.save', { sessionId: 'session-off', question: 'q', answer: 'a' })
  check('关闭历史保存时不落盘、也不报错', res.json?.value?.disabled === true && res.json.value.saved === false && store.btwTopics('session-off').length === 0)
  await call(ctx, '/save', { btwSaveHistory: true })
}

/* ───────────────────────── 3b. compaction + notifications ───────────────────────── */

section('3b. 压缩阈值与桌面通知')

/**
 * A context that behaves like cordis does for a service this plugin did NOT
 * declare: reading `ctx.<name>` throws, while `ctx.get(name)` answers.
 *
 * That is the exact shape that made the completion watcher a silent no-op —
 * `ctx.remote` threw, the throw was read as "no remote service", and the
 * subscription was never installed. Both halves' guards are driven through it.
 */
function cordisLikeContext(services) {
  const ctx = { get: (name) => services[name] }
  return new Proxy(ctx, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop in services && prop !== 'get') {
        throw new Error(`cannot get property "${prop}" without inject`)
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

{
  const remote = { $on: () => () => {} }
  const ctx = cordisLikeContext({ remote })
  let bareThrew = false
  try {
    void ctx.remote
  } catch {
    bareThrew = true
  }
  check('守卫的对照：裸读 ctx.remote 抛错，ctx.get("remote") 才拿得到（cordis 语义）',
    bareThrew === true && ctx.get('remote') === remote)
  check('host 侧 configEditorOf 优先 ctx.get，裸读抛错时仍拿得到服务',
    compaction.configEditorOf(cordisLikeContext({
      configEditor: { entries: () => [], edit: async () => {} },
    })) !== null)
  check('host 侧 configEditorOf 对真正缺席的服务返回 null（不抛）',
    compaction.configEditorOf(cordisLikeContext({})) === null)
  check('host 侧 serviceOf 在 ctx.get 不可用时回落到属性读',
    compaction.serviceOf({ plain: true }, 'plain') === true
      && compaction.serviceOf({ get: () => undefined, plain: true }, 'plain') === true)
}

/* ── the fixed-token → ratio conversion ── */
{
  const exact = compaction.compactionPolicy('deepseek-official', 'deepseek-pro', 250_000, 1_000_000)
  check('固定 token 数换算成该模型窗口占比后仍是同一个绝对数（窗口约掉）',
    exact.ok === true && Math.abs(exact.policy.thresholdRatio - 0.25) < 1e-12 && exact.effectiveTokens === 250_000,
    JSON.stringify(exact))
  check('每个模型各自成一条策略：同一阈值在不同窗口下换算不同',
    compaction.compactionPolicy('p', 'big', 250_000, 1_000_000).policy.thresholdRatio
      !== compaction.compactionPolicy('p', 'small', 250_000, 500_000).policy.thresholdRatio)
  check('retainRatio 严格小于 thresholdRatio（DSH 加载时的硬约束）',
    exact.ok === true
      && exact.policy.retainRatio < exact.policy.thresholdRatio
      && exact.policy.retainRatio <= compaction.DEFAULT_RETAIN_RATIO,
    JSON.stringify(exact.policy))
  check('阈值超过模型窗口时拒绝并说明原因',
    compaction.compactionPolicy('p', 'm', 300_000, 128_000).ok === false
      && compaction.compactionPolicy('p', 'm', 300_000, 128_000).reason === 'exceeds-window')
  check('阈值超出可写范围时拒绝',
    compaction.compactionPolicy('p', 'm', 16, 1_000_000).reason === 'tokens'
      && compaction.compactionPolicy('p', 'm', 5_000_000, 1_000_000).reason === 'tokens')
  check('窗口未知（适配器没声明）时不生成策略',
    compaction.compactionPolicy('p', 'm', 250_000, null).ok === false
      && compaction.compactionPolicy('p', 'm', 250_000, null).reason === 'context')
  const nearFull = compaction.compactionPolicy('p', 'm', 990_000, 1_000_000)
  check('贴着窗口上限的阈值被压到 0.95 以内并如实标记 capped',
    nearFull.ok === true && nearFull.policy.thresholdRatio <= compaction.MAX_THRESHOLD_RATIO && nearFull.capped === true)

  const plan = compaction.planCompactionPolicies(
    { 'a/x': 250_000, 'a/y': 250_000, 'a/z': 999, 'bad-key': 250_000, 'a/w': 200_000 },
    (provider, model) => (model === 'x' || model === 'w' ? 1_000_000 : null),
  )
  check('批量计划只保留能换算的行，并逐行报告未生效原因',
    plan.policies.length === 2
      && plan.skipped.length === 3
      && plan.skipped.some((row) => row.target === 'a/y' && row.reason === 'context')
      && plan.skipped.some((row) => row.target === 'a/z' && row.reason === 'tokens')
      && plan.skipped.some((row) => row.target === 'bad-key' && row.reason === 'route'),
    JSON.stringify(plan.skipped))
  check('批量计划保留索引顺序（同一份设置得到同一份策略）',
    plan.policies[0].model === 'x' && plan.policies[1].model === 'w',
    JSON.stringify(plan.policies.map((row) => row.model)))

  const existing = [{ provider: 'a', model: 'x', thresholdRatio: 0.1 }, { provider: 'hand', model: 'made', thresholdRatio: 0.5 }]
  const merged = compaction.mergeModelPolicies(existing, [compaction.compactionPolicy('a', 'x', 250_000, 1_000_000).policy])
  check('合并策略：同 route 被替换，手写的其它 route 原样保留',
    merged.length === 2
      && merged.find((row) => row.provider === 'a' && row.model === 'x').thresholdRatio === 0.25
      && merged.some((row) => row.provider === 'hand'),
    JSON.stringify(merged))
  check('合并时非数组的既有值被当作空表', compaction.mergeModelPolicies(null, []).length === 0)

  const yaml = compaction.renderCompactionYaml([compaction.compactionPolicy('a', 'x', 250_000, 1_000_000).policy])
  check('等效补丁片段带 entry id、provider/model 与两个 ratio',
    yaml.includes('id: compaction-basic') && yaml.includes('provider: "a"') && yaml.includes('model: "x"')
      && yaml.includes('thresholdRatio: 0.25') && /retainRatio: 0\.1[0-9]*/.test(yaml),
    yaml.split('\n').slice(0, 6).join(' | '))
}

/* ── the config-editor write ── */
{
  const entry = { options: { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: {} } }
  const policy = compaction.compactionPolicy('a', 'x', 250_000, 1_000_000).policy
  let written = null
  const editor = {
    entries: () => [entry],
    edit: async (_entry, change) => {
      written = change({ modelPolicies: [{ provider: 'hand', model: 'made' }] })
    },
  }
  const applied = await compaction.applyCompactionPolicies(editor, [policy])
  check('写入走 configEditor.edit，合并后落进 compaction-basic 的 config',
    applied.ok === true && applied.entry === 'compaction-basic' && applied.count === 1
      && written.modelPolicies.length === 2,
    JSON.stringify(applied))
  check('写入保留该 entry 的其它配置字段',
    (await (async () => {
      let next = null
      const withName = { entries: () => [entry], edit: async (_e, change) => { next = change({ auto: true, modelPolicies: [] }) } }
      await compaction.applyCompactionPolicies(withName, [policy])
      return next.auto === true
    })()) === true)
  check('配置编辑器缺席时如实报告 unavailable、不抛异常',
    (await compaction.applyCompactionPolicies(null, [policy])).code === 'unavailable')
  check('地址表中没有 compaction-basic 时报 entry-missing',
    (await compaction.applyCompactionPolicies({ entries: () => [], edit: async () => {} }, [policy])).code === 'entry-missing')
  check('reconcile 抛错时把错误交回调用方、不吞掉',
    (await compaction.applyCompactionPolicies({
      entries: () => [entry],
      edit: async () => {
        throw new Error('loader rejected the change')
      },
    }, [policy])).message === 'loader rejected the change')
  check('按包名也能找到被改过 id 的 entry',
    compaction.findCompactionEntry([{ options: { id: 'renamed', name: '@deepseek-ai/dsh-compaction-basic' } }]) !== null)
}

/* ── platform dispatch ── */
{
  check('Windows 走 Windows 通知',
    notify.notifyPlatform({}, 'win32') === 'windows')
  check('Linux 有 DISPLAY 走 notify-send',
    notify.notifyPlatform({ DISPLAY: ':0' }, 'linux') === 'linux')
  check('Linux 只有 Wayland 也算有桌面',
    notify.notifyPlatform({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux') === 'linux')
  check('Linux 没有 DISPLAY / Wayland 时不派发（无头环境不刷失败）',
    notify.notifyPlatform({}, 'linux') === null)
  check('WSL 路由到 Windows 通知（Linux 进程、Windows 桌面）',
    notify.notifyPlatform({ WSL_DISTRO_NAME: 'Ubuntu' }, 'linux') === 'windows'
      && notify.notifyPlatform({ WSL_INTEROP: '/run/WSL/1' }, 'linux') === 'windows')
  check('其它平台不派发', notify.notifyPlatform({}, 'darwin') === null)

  const linuxCommand = notify.buildNotifyCommand('linux', { title: 'T', body: 'B' })
  check('Linux 命令是 notify-send，标题正文各是一个 argv（无 shell）',
    linuxCommand.command === 'notify-send' && linuxCommand.args.includes('T') && linuxCommand.args.includes('B')
      && !linuxCommand.args.some((arg) => arg.includes(';') || arg.includes('$(')),
    JSON.stringify(linuxCommand.args))
  const windowsCommand = notify.buildNotifyCommand('windows', { title: 'T', body: 'B' })
  check('Windows 命令是 powershell -EncodedCommand（标题正文不进 argv 明文）',
    windowsCommand.command === 'powershell.exe' && windowsCommand.args.includes('-EncodedCommand')
      && !windowsCommand.args.includes('T') && !windowsCommand.args.includes('B'),
    JSON.stringify(windowsCommand.args.slice(0, 4)))
  const decoded = Buffer.from(windowsCommand.args[windowsCommand.args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le')
  check('EncodedCommand 解出真实脚本，标题正文在里面',
    decoded.includes("'T'") && decoded.includes("'B'") && decoded.includes('ToastNotificationManager'))
  check('PowerShell 单引号转义：正文里的引号被翻倍（注入不成立）',
    notify.windowsToastScript("a'b", "c'd").includes("'a''b'")
      && notify.windowsToastScript("a'b", "c'd").includes("'c''d'"))

  const okRun = async () => ({ error: null })
  const failRun = async () => ({ error: new Error('notify-send not found') })
  check('sendNotification 成功时 ok=true 并回报平台与命令',
    (await notify.sendNotification({ title: 'T', body: 'B' }, { platform: 'linux', env: { DISPLAY: ':0' }, run: okRun })).ok === true)
  check('sendNotification 失败时 ok=false 并带上原因、不抛',
    (await notify.sendNotification({ title: 'T', body: 'B' }, { platform: 'linux', env: { DISPLAY: ':0' }, run: failRun })).error === 'notify-send not found')
  check('无桌面时跳过并说明 skipped，不调用任何命令',
    (await notify.sendNotification({ title: 'T', body: 'B' }, { platform: 'linux', env: {} })).skipped === 'no-display')
  let capturedArgs = null
  const captureRun = async (_command, args) => {
    capturedArgs = args
    return { error: null }
  }
  await notify.sendNotification(
    { title: 'x'.repeat(500), body: 'y'.repeat(2000) },
    { platform: 'linux', env: { DISPLAY: ':0' }, run: captureRun },
  )
  check('超长标题正文被折叠截断后才进命令（120 / 600 字符上限）',
    capturedArgs !== null
      && capturedArgs.includes('x'.repeat(notify.NOTIFY_TITLE_CHARS))
      && capturedArgs.includes('y'.repeat(notify.NOTIFY_BODY_CHARS)),
    capturedArgs === null ? 'no command' : `${capturedArgs[capturedArgs.length - 2].length}/${capturedArgs[capturedArgs.length - 1].length}`)
  await notify.sendNotification(
    { title: 'a\nb', body: 'c\td' },
    { platform: 'linux', env: { DISPLAY: ':0' }, run: captureRun },
  )
  check('换行等控制字符被折叠成空格', capturedArgs.includes('a b') && capturedArgs.includes('c d'), JSON.stringify(capturedArgs))
}

/* ── the new routes ── */
{
  const ctx = makeCtx([], { contextWindow: 1_000_000 })
  registerRoutes(ctx)

  const state = await call(ctx, '/state', {})
  check('/state 上报压缩契约（entry id、范围、配置编辑器可见性、计划）',
    state.json?.ok === true
      && state.json.value.compaction?.entryId === 'compaction-basic'
      && state.json.value.compaction.configEditor === false
      && state.json.value.compaction.limits.minTokens === compaction.MIN_COMPACTION_TOKENS
      && Array.isArray(state.json.value.compaction.plan.policies),
    JSON.stringify(state.json?.value?.compaction ?? null))
  check('/state 上报通知契约（开关、平台、标题正文上限）',
    state.json?.value?.notify?.onComplete === true
      && 'platform' in state.json.value.notify
      && state.json.value.notify.limits.titleChars === notify.NOTIFY_TITLE_CHARS
      && state.json.value.notify.limits.bodyChars === notify.NOTIFY_BODY_CHARS)

  const saved = await call(ctx, '/save', { compactionTokens: { 'deepseek-official/deepseek-flash': 250_000 } })
  check('/save 收下合法的 per-model 阈值并回读',
    saved.json?.ok === true
      && saved.json.value.settings.compactionTokens['deepseek-official/deepseek-flash'] === 250_000,
    JSON.stringify(saved.json?.value?.settings?.compactionTokens ?? null))
  check('/save 拒绝不是 provider/model 的键',
    (await call(ctx, '/save', { compactionTokens: { nope: 250_000 } })).json?.ok === false)
  check('/save 拒绝超出可写范围的阈值',
    (await call(ctx, '/save', { compactionTokens: { 'a/b': 9_000_000 } })).json?.ok === false)
  check('/save 拒绝非对象的阈值表',
    (await call(ctx, '/save', { compactionTokens: [250_000] })).json?.ok === false)
  check('/save 拒绝非布尔的通知开关',
    (await call(ctx, '/save', { notifyOnComplete: 'yes' })).json?.ok === false)
  check('/save 存下通知开关并回读',
    (await call(ctx, '/save', { notifyOnComplete: false })).json?.value?.settings?.notifyOnComplete === false)

  const windowsView = await call(ctx, '/compaction.windows', {})
  check('/compaction.windows 列出目录里的每个模型与其宿主解析出的窗口',
    windowsView.json?.ok === true
      && windowsView.json.value.models.length === 3
      && windowsView.json.value.models.every((row) => row.contextWindow === 1_000_000),
    JSON.stringify(windowsView.json?.value?.models ?? null))
  check('/compaction.windows 带出已存阈值',
    windowsView.json.value.models.find((row) => row.model === 'deepseek-flash')?.tokens === 250_000)

  const noEditor = await call(ctx, '/compaction.apply', {})
  check('/compaction.apply 无 configEditor 时报 unavailable、不写任何东西',
    noEditor.json?.ok === true
      && noEditor.json.value.applied.ok === false
      && noEditor.json.value.applied.code === 'unavailable'
      && noEditor.json.value.plan.policies.length === 1,
    JSON.stringify(noEditor.json?.value?.applied ?? null))

  let edited = null
  const withEditor = makeCtx([], {
    contextWindow: 1_000_000,
    configEditor: {
      entries: () => [{ options: { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' } }],
      edit: async (_entry, change) => {
        edited = change({ modelPolicies: [] })
      },
    },
  })
  registerRoutes(withEditor)
  const applied = await call(withEditor, '/compaction.apply', {})
  check('/compaction.apply 写入并如实上报条数',
    applied.json?.value?.applied?.ok === true && applied.json.value.applied.count === 1,
    JSON.stringify(applied.json?.value?.applied ?? null))
  check('/compaction.apply 写入的是换算后的 modelPolicies（固定 token → 该模型占比）',
    edited?.modelPolicies?.length === 1
      && edited.modelPolicies[0].provider === 'deepseek-official'
      && edited.modelPolicies[0].model === 'deepseek-flash'
      && Math.abs(edited.modelPolicies[0].thresholdRatio - 0.25) < 1e-12,
    JSON.stringify(edited))

  // The dispatch itself is covered above with an injected runner. These two are
  // deliberately limited to the paths that cannot pop a real notification on the
  // machine running the suite: the switch being off, and a host with no desktop.
  const disabled = await call(ctx, '/notify', { title: 'T', body: 'B' })
  check('/notify 开关关闭时不派发（不落到桌面）',
    disabled.json?.ok === true && disabled.json.value.sent === false && disabled.json.value.skipped === 'disabled',
    JSON.stringify(disabled.json?.value ?? null))
  if (notify.notifyPlatform(process.env, process.platform) === null) {
    const probe = await call(ctx, '/notify.test', {})
    check('/notify.test 在无桌面环境如实报 skipped',
      probe.json?.ok === true && probe.json.value.sent === false && typeof probe.json.value.skipped === 'string',
      JSON.stringify(probe.json?.value ?? null))
  }

  // The regression this whole block guards: a host whose bare `ctx.configEditor`
  // throws (cordis, because the plugin does not inject it) while `ctx.get` works.
  // Reading the property first used to look exactly like "no config editor".
  const editorCtx = makeCtx([], { contextWindow: 1_000_000 })
  const editor = {
    entries: () => [{ options: { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' } }],
    edit: async () => {},
  }
  Object.defineProperty(editorCtx, 'configEditor', {
    configurable: true,
    get() {
      throw new Error('cannot get property "configEditor" without inject')
    },
  })
  Object.defineProperty(editorCtx, 'get', {
    configurable: true,
    value: (name) => (name === 'configEditor' ? editor : editorCtx[name]),
  })
  registerRoutes(editorCtx)
  const strictState = await call(editorCtx, '/state', {})
  check('/state 在「裸读抛错、只能 get」的宿主上仍报 configEditor 可用',
    strictState.json?.value?.compaction?.configEditor === true,
    JSON.stringify(strictState.json?.value?.compaction?.configEditor))
  const strictApply = await call(editorCtx, '/compaction.apply', {})
  check('/compaction.apply 在这种宿主上仍能写入（不再假报 unavailable）',
    strictApply.json?.value?.applied?.ok === true && strictApply.json.value.applied.count === 1,
    JSON.stringify(strictApply.json?.value?.applied ?? null))
}


/* ───────────────────────── 4. browser half ───────────────────────── */

section('4. 浏览器半区')

/** Cleanups the harness's effects returned; see `flushEffects`. */
const effectCleanups = []

/** Run every effect cleanup registered so far, the way React would on re-render. */
function flushEffects() {
  for (const cleanup of effectCleanups.splice(0)) if (typeof cleanup === 'function') cleanup()
}

/** Just enough React to execute a component function once and walk its tree. */
function makeReact() {
  // Component state lives in a frame the caller owns: React drops one render as
  // the next begins, and the harness does the same — a bare call from a check
  // gets the initial value every time, which is all a seat whose state lives in
  // an external store needs. A seat that really keeps state in `useState` (the
  // settings page's active tab and its visited set) is rendered through
  // `mountClient`, which hands the same frame back on every render.
  let frame = null
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat().filter((child) => child !== null && child !== undefined && child !== false) }
    },
    useState(initial) {
      const value = typeof initial === 'function' ? initial() : initial
      if (frame === null) return [value, () => {}]
      const slot = frame.next
      frame.next += 1
      if (frame.cells.length <= slot) frame.cells.push(value)
      // The setter outlives the render it was created in (a click writes state
      // long after the function returned), so it holds the frame itself.
      const owner = frame
      const set = (next) => {
        owner.cells[slot] = typeof next === 'function' ? next(owner.cells[slot]) : next
      }
      return [owner.cells[slot], set]
    },
    /** Run one render inside a caller-owned frame, so `useState` reads and writes it. */
    __withFrame(target, render) {
      const outer = frame
      frame = target
      target.next = 0
      try {
        return render()
      } finally {
        frame = outer
      }
    },
    useEffect(effect) {
      try {
        effectCleanups.push(effect())
      } catch {
        /* effects are exercised for their registration side effects only */
        effectCleanups.push(undefined)
      }
      return undefined
    },
    useMemo(factory) {
      return factory()
    },
    useCallback(fn) {
      return fn
    },
    useRef(value) {
      return { current: value }
    },
  }
  return React
}

function loadClientBundle(fetchImpl) {
  let captured = null
  const windowStub = {
    __ModuleLoader__: { load(spec) { captured = spec } },
    addEventListener() {},
    removeEventListener() {},
  }
  const previousFetch = globalThis.fetch
  const previousWindow = globalThis.window
  globalThis.window = windowStub
  globalThis.fetch = fetchImpl
  // A document that really registers listeners, so a component's document-level
  // keyboard handling can be driven (`bundle.__key`) instead of only existing.
  const documentListeners = new Map()
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }),
    head: { appendChild() {} },
    addEventListener(type, handler) {
      if (!documentListeners.has(type)) documentListeners.set(type, new Set())
      documentListeners.get(type).add(handler)
    },
    removeEventListener(type, handler) {
      documentListeners.get(type)?.delete(handler)
    },
  }
  // eslint-disable-next-line no-new-func
  new Function('window', clientSource)(windowStub)
  const React = makeReact()
  const bundle = captured.factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected module: ${id}`)
  })
  bundle.__withFrame = (frame, render) => React.__withFrame(frame, render)
  bundle.__key = (event) => {
    const full = { key: '', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, defaultPrevented: false, ...event }
    for (const handler of [...(documentListeners.get('keydown') ?? [])]) handler(full)
  }
  bundle.__restore = () => {
    globalThis.fetch = previousFetch
    globalThis.window = previousWindow
  }
  return bundle
}

/**
 * Mount one client component so a check can re-render it with its state kept.
 * The bare harness call every other check uses is a single render; a component
 * that keeps its own `useState` (the settings page) needs the frame instead.
 * @param {object} bundle - the loaded bundle.
 * @param {Function} Component - the component function to mount.
 * @returns {(props: object) => object} one render of that instance.
 */
function mountClient(bundle, Component) {
  const frame = { cells: [], next: 0 }
  return (props) => bundle.__withFrame(frame, () => Component(props))
}

/** Walk a rendered tree. */
function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) {
    for (const entry of node) findAll(entry, predicate, out)
    return out
  }
  if (typeof node !== 'object') return out
  if (predicate(node) === true) out.push(node)
  for (const child of node.children ?? []) findAll(child, predicate, out)
  return out
}
const textOf = (node) => {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node === null || typeof node !== 'object') return ''
  return (node.children ?? []).map(textOf).join('')
}
const buttonsOf = (tree) => findAll(tree, (node) => node.type === 'button')
const labelOf = (button) => textOf(button)

/**
 * Wait for one session's rewrite to leave `running`. Clicks start an async run
 * that the component deliberately does not await, so the check polls the same
 * state a user would see instead of guessing a tick count.
 */
async function settle(bundle, key = 'session-a', timeoutMs = 4000) {
  const started = Date.now()
  for (;;) {
    const phase = bundle.readSession(key).phase
    if (phase !== 'running') return phase
    if (Date.now() - started > timeoutMs) return phase
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Click one button and wait for the rewrite it started. */
async function clickAndSettle(bundle, button, key = 'session-a') {
  button.props.onClick()
  return settle(bundle, key)
}

/** One SSE response body, exactly as the route writes it. */
function sseResponse(frames) {
  const body = frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const STATE = {
  ok: true,
  value: {
    settings: {
      systemPrompt: null,
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoningEffort: 'off',
      followSessionModel: false,
      style: 'standard',
      applyMode: 'auto',
      route: 'plugin',
      shortcut: true,
      btwContextTurns: 'all',
      btwSaveHistory: true,
      compactionTokens: { 'deepseek-official/deepseek-flash': 250_000 },
      notifyOnComplete: true,
    },
    defaultSystemPrompt: prompt.DEFAULT_SYSTEM_PROMPT,
    custom: false,
    models: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'Flash' }], error: null }],
    active: { provider: 'deepseek-official', model: 'deepseek-flash' },
    sessionModel: { provider: 'deepseek-official', model: 'deepseek-flash' },
    reasoning: { efforts: ['off', 'low', 'high'], defaultEffort: 'high' },
    effortChoices: [...store.EFFORT_CHOICES],
    styleChoices: [...store.STYLE_CHOICES],
    applyModes: [...store.APPLY_MODES],
    routes: [...store.REWRITE_ROUTES],
    agentTemplate: { text: prompt.AGENT_TEMPLATE, placeholder: prompt.AGENT_TEMPLATE_PLACEHOLDER },
    configFile: store.CONFIG_FILE,
    limits: { maxDraftChars: prompt.MAX_DRAFT_CHARS, maxSystemPromptChars: prompt.MAX_SYSTEM_PROMPT_CHARS },
    btw: {
      contextTurns: 'all',
      saveHistory: true,
      contextTurnChoices: [...store.BTW_CONTEXT_CHOICES],
      maxQuestionChars: prompt.MAX_BTW_QUESTION_CHARS,
      historyFile: store.BTW_HISTORY_FILE,
      prompt: prompt.BTW_SYSTEM_PROMPT,
    },
    compaction: {
      tokens: { 'deepseek-official/deepseek-flash': 250_000 },
      entryId: 'compaction-basic',
      limits: { minTokens: 8192, maxTokens: 4_000_000 },
      configEditor: false,
      plan: { policies: [], skipped: [], capped: [], yaml: '' },
    },
    notify: {
      onComplete: true,
      platform: 'linux',
      appName: 'DSH',
      limits: { titleChars: 120, bodyChars: 600 },
    },
  },
}

/** One fetch that serves `/state`, the SSE route and the JSON route. */
function makeFetch(options = {}) {
  const seen = []
  const fetchImpl = async (url, init) => {
    const action = String(url).slice(String(url).lastIndexOf('/') + 1)
    seen.push({ action, body: init?.body === undefined ? null : JSON.parse(init.body), signal: init?.signal })
    if (options.fail === true) throw new Error('offline')
    if (action === 'state') return new Response(JSON.stringify(STATE), { status: 200 })
    if (action === 'optimize.stream') {
      if (options.noStream === true) return new Response('nope', { status: 404 })
      if (options.streamFailed === true) {
        return sseResponse([['failed', { ok: false, error: { code: 'no-model', message: 'none' } }]])
      }
      return sseResponse([
        ['delta', { text: '改写' }],
        ['delta', { text: '改写结果', final: true }],
        ['done', {
          ok: true,
          value: {
            text: '改写结果',
            assumptions: null,
            provider: 'deepseek-official',
            model: 'deepseek-flash',
            style: 'standard',
            effort: 'off',
            originalChars: 4,
            optimizedChars: 4,
            timings: { routeMs: 1, totalMs: 1200, firstTextMs: 380, reasoningChars: 0, attempts: 1 },
          },
        }],
      ])
    }
    if (action === 'optimize') {
      if (typeof options.json === 'function') return new Response(JSON.stringify(options.json(seen[seen.length - 1])), { status: 200 })
      return new Response(JSON.stringify({ ok: true, value: { text: 'JSON 回退结果', assumptions: null, timings: { totalMs: 900, firstTextMs: 300 }, originalChars: 4, optimizedChars: 6 } }), { status: 200 })
    }
    // Settings writes fail by default — the settings page's error line is
    // checked against exactly that. `saveOk` accepts them, so the ok toast can
    // be checked as well.
    if (action === 'save' && options.saveOk === true) {
      return new Response(JSON.stringify({ ok: true, value: STATE.value }), { status: 200 })
    }
    if (action === 'btw.stream') {
      if (options.noStream === true) return new Response('nope', { status: 404 })
      if (options.btwFailed === true) {
        return sseResponse([['failed', { ok: false, error: { code: 'timeout', message: '超时' } }]])
      }
      return sseResponse([
        ['delta', { text: '旁路' }],
        ['delta', { text: options.btwAnswer ?? '旁路答案', final: true }],
        ['done', {
          ok: true,
          value: {
            text: options.btwAnswer ?? '旁路答案',
            provider: 'deepseek-official',
            model: 'deepseek-flash',
            effort: 'off',
            historyTurns: 0,
            contextChars: 0,
            timings: { routeMs: 1, totalMs: 800, firstTextMs: 260, reasoningChars: 0, attempts: 1 },
          },
        }],
      ])
    }
    if (action === 'btw') {
      return new Response(JSON.stringify({ ok: true, value: { text: 'JSON 旁路回退', timings: { totalMs: 700, firstTextMs: 240 } } }), { status: 200 })
    }
    if (action === 'btw.history') {
      return new Response(JSON.stringify({ ok: true, value: { topics: options.btwTopics ?? [], saveHistory: options.btwSaveHistory !== false } }), { status: 200 })
    }
    if (action === 'compaction.windows') {
      return new Response(JSON.stringify({
        ok: true,
        value: {
          limits: { minTokens: compaction.MIN_COMPACTION_TOKENS, maxTokens: compaction.MAX_COMPACTION_TOKENS },
          models: options.compactionWindows ?? [
            { provider: 'deepseek-official', model: 'deepseek-flash', contextWindow: 1_000_000, tokens: 250_000 },
          ],
        },
      }), { status: 200 })
    }
    if (action === 'btw.save') {
      const body = seen[seen.length - 1].body ?? {}
      return new Response(JSON.stringify({
        ok: true,
        value: {
          topicId: options.btwTopicId ?? 'topic-1',
          topics: [{ id: options.btwTopicId ?? 'topic-1', at: 1, turns: [{ q: body.question, a: body.answer, at: 1 }] }],
          saved: true,
          disabled: false,
        },
      }), { status: 200 })
    }
    if (action === 'btw.clear') {
      return new Response(JSON.stringify({ ok: true, value: { topics: [], saved: true } }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }
  fetchImpl.seen = seen
  return fetchImpl
}

/** Fake slot props around a mutable input state. */
function makeInput(initial = {}, chatNodes = [], legacyExtra = {}) {
  const state = { draft: '', phase: 'plain', draftRev: 1, occurrences: [], ...initial }
  const writes = []
  return {
    state,
    writes,
    props: {
      sessionId: 'session-a',
      useInput: (selector) => (selector === undefined ? state : selector(state)),
      useChat: (selector) => selector({ legacy: { nodes: chatNodes, ...legacyExtra } }),
      inputActions: {
        setDraft(text) {
          writes.push(text)
          state.draft = text
          state.draftRev += 1
        },
      },
    },
  }
}

{
  const fetchImpl = makeFetch()
  const bundle = loadClientBundle(fetchImpl)
  await bundle.settingsStore.load(true)
  const input = makeInput({ draft: '把登录页改快一点' })
  const tree = bundle.OptimizeButton(input.props)
  const button = buttonsOf(tree)[0]
  check('按钮渲染出「优化提示词」', labelOf(button).includes('优化提示词'))
  check('有模型与草稿时按钮可用', button.props.disabled === false)
  check('按钮标题带当前模型', String(button.props.title).includes('deepseek-flash'))
  bundle.__restore()
}

{
  const fetchImpl = makeFetch()
  const bundle = loadClientBundle(fetchImpl)
  await bundle.settingsStore.load(true)
  const empty = makeInput({ draft: '' })
  check('草稿为空时按钮禁用', buttonsOf(bundle.OptimizeButton(empty.props))[0].props.disabled === true)
  const chips = makeInput({ draft: '看 @a.ts', occurrences: [{ source: 'file', ref: 'a.ts' }] })
  const chipButton = buttonsOf(bundle.OptimizeButton(chips.props))[0]
  check('含引用芯片时按钮禁用', chipButton.props.disabled === true)
  check('芯片禁用给出明确理由（而非静默置灰）', String(chipButton.props.title).includes('引用芯片'))
  bundle.__restore()
}

{
  // The one-click path: draft untouched while it ran → applied in place + undo.
  const fetchImpl = makeFetch()
  const bundle = loadClientBundle(fetchImpl)
  await bundle.settingsStore.load(true)
  const input = makeInput({ draft: '原始草稿' })
  const button = buttonsOf(bundle.OptimizeButton(input.props))[0]
  await clickAndSettle(bundle, button)
  const session = bundle.readSession('session-a')
  check('一键路径自动替换草稿', session.phase === 'applied' && input.state.draft === '改写结果')
  check('替换记下原文用于撤销', session.undoText === '原始草稿' && session.appliedText === '改写结果')
  const panel = bundle.TaskPanel(input.props)
  check('预览卡片随后展示原文与结果', textOf(panel).includes('原始草稿') && textOf(panel).includes('改写结果'))
  const undo = buttonsOf(panel).find((candidate) => labelOf(candidate).includes('撤销'))
  check('预览卡片提供撤销', undo !== undefined)
  undo.props.onClick()
  check('撤销恢复原文并关闭卡片', input.state.draft === '原始草稿' && bundle.readSession('session-a').phase === 'idle')
  bundle.__restore()
}

{
  // Typing during the rewrite must win: no silent replacement.
  const fetchImpl = makeFetch()
  const bundle = loadClientBundle(fetchImpl)
  await bundle.settingsStore.load(true)
  const input = makeInput({ draft: '原始草稿' })
  // `readDraft` is what the composer holds when the answer lands; here the user
  // has typed something new, so the run must stop at review.
  await bundle.runRewrite({
    key: 'session-a',
    text: '原始草稿',
    draftRev: 1,
    actions: input.props.inputActions,
    style: null,
    state: STATE.value,
    readDraft: () => '用户在优化期间新写的内容',
  })
  const session = bundle.readSession('session-a')
  check('优化期间改过草稿则绝不自动覆盖', session.phase === 'review', session.phase)
  check('未覆盖时草稿未被写入', input.writes.length === 0 && input.state.draft === '原始草稿')
  check('卡片标注「你改过草稿」', session.stale === true)
  const panel = bundle.TaskPanel(input.props)
  const apply = buttonsOf(panel).find((candidate) => labelOf(candidate).trim() === '采用')
  check('确认后仍可手动采用', apply !== undefined)
  apply.props.onClick()
  check('手动采用写入结果', input.state.draft === '改写结果' && bundle.readSession('session-a').phase === 'applied')
  bundle.__restore()
}

{
  const fetchImpl = makeFetch()
  const bundle = loadClientBundle(fetchImpl)
  await bundle.settingsStore.load(true)
  bundle.settingsStore.get().state.settings.applyMode = 'review'
  const input = makeInput({ draft: '原始草稿' })
  await clickAndSettle(bundle, buttonsOf(bundle.OptimizeButton(input.props))[0])
  check('applyMode=review 时不自动替换', bundle.readSession('session-a').phase === 'review' && input.state.draft === '原始草稿')
  bundle.settingsStore.get().state.settings.applyMode = 'auto'
  bundle.__restore()
}

{
  // Chip guard must hold even if a caller forgets it: the host is not asked.
  const fetchImpl = makeFetch()
  const bundle = loadClientBundle(fetchImpl)
  await bundle.settingsStore.load(true)
  const input = makeInput({ draft: '看 @a.ts', occurrences: [{ source: 'file', ref: 'a.ts' }] })
  await clickAndSettle(bundle, buttonsOf(bundle.OptimizeButton(input.props))[0])
  check('芯片草稿不会发起请求', fetchImpl.seen.filter((entry) => entry.action === 'optimize.stream').length === 0)
  bundle.__restore()
}

{
  // Session isolation: two composers must not share one card.
  const fetchImpl = makeFetch()
  const bundle = loadClientBundle(fetchImpl)
  await bundle.settingsStore.load(true)
  const first = makeInput({ draft: 'A 的草稿' })
  const second = { ...makeInput({ draft: 'B 的草稿' }).props, sessionId: 'session-b' }
  bundle.patchSession('session-a', { phase: 'review', text: 'A 的结果', source: 'A 的草稿' })
  bundle.patchSession('session-b', { phase: 'running', text: 'B 的半截', source: 'B 的草稿' })
  check('两个会话各自持有状态', bundle.readSession('session-a').text === 'A 的结果' && bundle.readSession('session-b').text === 'B 的半截')
  const panelA = bundle.TaskPanel(first.props)
  const panelB = bundle.TaskPanel(second)
  check('A 的卡片只显示 A 的内容', textOf(panelA).includes('A 的结果') && !textOf(panelA).includes('B 的半截'))
  check('B 的卡片只显示 B 的内容', textOf(panelB).includes('B 的半截') && !textOf(panelB).includes('A 的结果'))
  check('未标 sessionId 时按 inputActions 锚定同一 key', bundle.sessionKey({ inputActions: first.props.inputActions }) === bundle.sessionKey({ inputActions: first.props.inputActions }))
  check('不同 inputActions 得到不同 key', bundle.sessionKey({ inputActions: first.props.inputActions }) !== bundle.sessionKey({ inputActions: second.inputActions }))
  check('卡片在 idle 时完全不渲染', bundle.TaskPanel({ ...first.props, sessionId: 'session-c' }) === null)
  bundle.clearSession('session-a')
  check('关闭卡片即清空该会话状态', bundle.readSession('session-a').phase === 'idle' && bundle.readSession('session-b').phase === 'running')
  bundle.__restore()
}

{
  // Preview-card style switch re-runs with another style.
  const fetchImpl = makeFetch()
  const bundle = loadClientBundle(fetchImpl)
  await bundle.settingsStore.load(true)
  const input = makeInput({ draft: '原始草稿' })
  await clickAndSettle(bundle, buttonsOf(bundle.OptimizeButton(input.props))[0])
  const panel = bundle.TaskPanel(input.props)
  const slim = buttonsOf(panel).find((candidate) => labelOf(candidate).trim() === '精简')
  await clickAndSettle(bundle, slim)
  const last = fetchImpl.seen.filter((entry) => entry.action === 'optimize.stream').pop()
  check('卡片可切换档位重跑', last?.body?.style === 'slim', JSON.stringify(last?.body))
  const again = buttonsOf(bundle.TaskPanel(input.props)).find((candidate) => labelOf(candidate).trim() === '再改一次')
  await clickAndSettle(bundle, again)
  const resent = fetchImpl.seen.filter((entry) => entry.action === 'optimize.stream').pop()
  check('再改一次以当前结果为输入', resent?.body?.text === '改写结果', JSON.stringify(resent?.body?.text))
  bundle.__restore()
}

{
  // Streaming failures and the JSON fallback.
  const failed = loadClientBundle(makeFetch({ streamFailed: true }))
  await failed.settingsStore.load(true)
  const input = makeInput({ draft: '原始草稿' })
  await clickAndSettle(failed, buttonsOf(failed.OptimizeButton(input.props))[0])
  check('SSE failed 帧进入错误态', failed.readSession('session-a').phase === 'error')
  failed.__restore()

  const fallback = loadClientBundle(makeFetch({ noStream: true }))
  await fallback.settingsStore.load(true)
  const input2 = makeInput({ draft: '原始草稿' })
  await clickAndSettle(fallback, buttonsOf(fallback.OptimizeButton(input2.props))[0])
  check('流式路由缺失时回退 JSON 路由', fallback.readSession('session-a').phase === 'applied' && input2.state.draft === 'JSON 回退结果')
  fallback.__restore()

  const offline = loadClientBundle(makeFetch({ fail: true }))
  await offline.settingsStore.load(true)
  const input3 = makeInput({ draft: '原始草稿' })
  const offlineButton = buttonsOf(offline.OptimizeButton(input3.props))[0]
  await clickAndSettle(offline, offlineButton)
  check('宿主不可达时不假装成功', offline.readSession('session-a').phase === 'idle' && input3.writes.length === 0)
  check('宿主不可达时把错误显示出来（而非静默禁用）', textOf(offline.OptimizeButton(input3.props)).includes('unreachable'))
  offline.__restore()
}

{
  // Agent route: zero model calls, template written into the composer.
  const fetchImpl = makeFetch()
  const bundle = loadClientBundle(fetchImpl)
  await bundle.settingsStore.load(true)
  bundle.settingsStore.get().state.settings.route = 'agent'
  const input = makeInput({ draft: '把登录页改快一点' })
  const button = buttonsOf(bundle.OptimizeButton(input.props))[0]
  check('agent 路由在无模型时也可用', button.props.disabled === false)
  await button.props.onClick()
  check('agent 路由不发起任何请求', fetchImpl.seen.filter((entry) => entry.action.startsWith('optimize')).length === 0)
  check('agent 路由写入含草稿的模板', input.state.draft.includes('把登录页改快一点') && input.state.draft.includes('改写为一条更明确'))
  bundle.settingsStore.get().state.settings.route = 'plugin'
  bundle.__restore()
}

{
  // Settings page surface. The page is tabbed now, so only the active panel is
  // in the tree: every surface assertion has to be collected by walking the
  // tabs. The walk goes through `mountClient` because both the selected tab and
  // the set of already-visited (still mounted) panels live in `useState` — a
  // bare render would restart from the first tab on every call.
  const fetchImpl = makeFetch()
  const bundle = loadClientBundle(fetchImpl)
  await bundle.settingsStore.load(true)
  const render = mountClient(bundle, bundle.SettingsPanel)
  const page = () => render({ close() {} })

  const TAB_IDS = ['model', 'rewrite', 'prompt', 'btw', 'compaction', 'notify']
  const TAB_KEYS = ['tabModel', 'tabRewrite', 'tabPrompt', 'tabBtw', 'tabCompaction', 'tabNotify']
  const TAB_LABELS = TAB_KEYS.map((key) => bundle.DICT.zh[key])
  const PAGE_NODES = ['dspo-meta', 'dspo-set-ok', 'dspo-set-error']
  const tabButton = (tree, id) => findAll(tree, (node) => node.props?.id === `dspo-tab-${id}`)[0]
  const tabsOf = (tree) => findAll(tree, (node) => node.props?.role === 'tab')
  const panelsOf = (tree) => findAll(tree, (node) => node.props?.role === 'tabpanel')
  const visiblePanel = (tree) => panelsOf(tree).find((panel) => panel.props.hidden !== true)
  const selectedTab = (tree) => tabsOf(tree).find((tab) => tab.props['aria-selected'] === true)
  const selectedTabs = (tree) => tabsOf(tree).filter((tab) => tab.props['aria-selected'] === true)
  const visiblePanels = (tree) => panelsOf(tree).filter((panel) => panel.props.hidden !== true)
  const rowLabels = (panel) => findAll(panel, (node) => node.props?.className === 'dspo-set-label').map(textOf)
  /** The page's own furniture: children of the root that belong to no panel. */
  const pageLevel = (tree) => (tree.children ?? []).filter((child) => PAGE_NODES.includes(child?.props?.className))
  /** Anything that leaked into a panel although it is page-level. */
  const pageLevelInsidePanels = (tree) => panelsOf(tree)
    .flatMap((panel) => findAll(panel, (node) => PAGE_NODES.includes(node.props?.className)))
  /** Click one tab and re-render; every tab is reached through the same rail. */
  const clickTab = (tree, id) => {
    tabButton(tree, id).props.onClick()
    return page()
  }
  /** Press one key on a tab button; returns whether the handler claimed it. */
  const press = (tree, id, key) => {
    let prevented = false
    tabButton(tree, id).props.onKeyDown({ key, preventDefault: () => { prevented = true } })
    return prevented
  }

  /* ── the rail ── */
  const first = page()
  const rail = findAll(first, (node) => node.props?.role === 'tablist')[0]
  const firstTabs = tabsOf(first)
  check('设置页有 role="tablist" 的标签栏', rail !== undefined && rail.props.className === 'dspo-tabs'
    && rail.props['aria-label'] === bundle.DICT.zh.settingsTabs, JSON.stringify(rail?.props))
  check('标签栏恰好六个 role="tab" 按钮', firstTabs.length === 6, String(firstTabs.length))
  check('六个页签按文档顺序排列，id 与文案各自对应',
    JSON.stringify(firstTabs.map((tab) => tab.props.id)) === JSON.stringify(TAB_IDS.map((id) => `dspo-tab-${id}`))
      && JSON.stringify(firstTabs.map(labelOf)) === JSON.stringify(TAB_LABELS),
    firstTabs.map((tab) => `${tab.props.id}=${labelOf(tab)}`).join(' '))
  check('页签文案就是文档写死的六个中文标签',
    JSON.stringify(TAB_LABELS) === JSON.stringify(['模型', '改写', '提示词', '旁路提问', '压缩', '通知']), TAB_LABELS.join(','))
  check('每个页签都是 button，aria-controls 指向自己的面板',
    firstTabs.every((tab) => tab.props.type === 'button'
      && tab.props['aria-controls'] === `dspo-panel-${tab.props.id.slice('dspo-tab-'.length)}`))

  /* ── selection invariants, on the very first render ── */
  check('任意时刻恰好一个页签 aria-selected="true"', selectedTabs(first).length === 1, String(selectedTabs(first).length))
  check('任意时刻恰好一个已渲染面板不带 hidden', visiblePanels(first).length === 1, String(visiblePanels(first).length))
  check('data-active 只在活动页签上是 "true"',
    firstTabs.filter((tab) => tab.props['data-active'] === 'true').length === 1
      && firstTabs.find((tab) => tab.props['data-active'] === 'true') === selectedTab(first))
  check('tabIndex 在活动页签上是 0、其余都是 -1',
    firstTabs.every((tab) => tab.props.tabIndex === (tab.props['aria-selected'] === true ? 0 : -1)),
    firstTabs.map((tab) => String(tab.props.tabIndex)).join(','))
  check('活动页签与可见面板互相指向（aria-controls / aria-labelledby）',
    selectedTab(first).props['aria-controls'] === visiblePanel(first).props.id
      && visiblePanel(first).props['aria-labelledby'] === selectedTab(first).props.id,
    `${selectedTab(first).props['aria-controls']} vs ${visiblePanel(first).props.id}`)

  /* ── lazy mounting: visited panels stay, unvisited ones do not exist ── */
  check('首次渲染只挂载 model 面板',
    panelsOf(first).length === 1 && panelsOf(first)[0].props.id === 'dspo-panel-model',
    panelsOf(first).map((panel) => panel.props.id).join(','))
  check('没访问过的页签根本没有面板（btw 还不存在）',
    !panelsOf(first).some((panel) => panel.props.id === 'dspo-panel-btw'))

  const afterRewrite = clickTab(first, 'rewrite')
  check('点击页签同时移动选中与可见面板',
    selectedTab(afterRewrite).props.id === 'dspo-tab-rewrite'
      && visiblePanel(afterRewrite).props.id === 'dspo-panel-rewrite'
      && selectedTabs(afterRewrite).length === 1
      && visiblePanels(afterRewrite).length === 1)
  check('访问过的面板继续挂载、只是 hidden',
    panelsOf(afterRewrite).length === 2
      && panelsOf(afterRewrite).filter((panel) => panel.props.hidden === true).length === 1
      && panelsOf(afterRewrite).find((panel) => panel.props.id === 'dspo-panel-model').props.hidden === true,
    panelsOf(afterRewrite).map((panel) => `${panel.props.id}:${panel.props.hidden}`).join(' '))

  const afterPrompt = clickTab(afterRewrite, 'prompt')
  check('访问 rewrite 与 prompt 后恰好三个面板，早先的都是 hidden',
    panelsOf(afterPrompt).length === 3
      && panelsOf(afterPrompt).filter((panel) => panel.props.hidden === true).length === 2
      && visiblePanel(afterPrompt).props.id === 'dspo-panel-prompt',
    panelsOf(afterPrompt).map((panel) => `${panel.props.id}:${panel.props.hidden}`).join(' '))
  check('btw 面板在访问它之前始终不存在',
    !panelsOf(afterPrompt).some((panel) => panel.props.id === 'dspo-panel-btw'))
  const allTabs = clickTab(afterPrompt, 'btw')
  check('访问 btw 后四个面板齐备', panelsOf(allTabs).length === 4, String(panelsOf(allTabs).length))

  /* ── one walk that collects each tab's rows and re-checks the wiring ── */
  const labelsByTab = {}
  let walk = allTabs
  for (const [index, id] of TAB_IDS.entries()) {
    walk = clickTab(walk, id)
    const selected = selectedTab(walk)
    const visible = visiblePanel(walk)
    check(`点「${bundle.DICT.zh[TAB_KEYS[index]]}」页签后选中与可见面板都指向它，且各自唯一`,
      selected.props.id === `dspo-tab-${id}`
        && selectedTabs(walk).length === 1
        && visiblePanels(walk).length === 1
        && selected.props['aria-controls'] === visible.props.id
        && visible.props.id === `dspo-panel-${id}`
        && visible.props['aria-labelledby'] === selected.props.id,
      `${selected.props.id} / ${visible.props.id}`)
    labelsByTab[id] = rowLabels(visible)
  }

  /* ── every original surface assertion, unioned over the tabs ── */
  const panelsById = Object.fromEntries(panelsOf(walk).map((panel) => [panel.props.id, panel]))
  const panelText = TAB_IDS.map((id) => textOf(panelsById[`dspo-panel-${id}`])).join('\n')
  check('设置页含模型 / 强度 / 档位 / 应用方式 / 路由 / 提示词',
    ['优化模型', '思考强度', '默认档位', '改写完成后', '改写方式', '自定义优化提示词'].every((label) => panelText.includes(label)))
  check('设置页提供「跟随当前会话的模型」开关',
    panelText.includes('跟随当前会话的模型')
      && findAll(walk, (node) => node.props?.id === 'dspo-follow' && node.props?.type === 'checkbox').length === 1)
  check('设置页提供快捷键开关',
    panelText.includes('Alt+O')
      && findAll(walk, (node) => node.props?.id === 'dspo-shortcut' && node.props?.type === 'checkbox').length === 1)
  const selects = findAll(walk, (node) => node.type === 'select')
  const effortSelect = selects.find((select) => select.props.id === 'dspo-effort')
  check('设置页渲染出多个下拉', selects.length >= 4, String(selects.length))
  check('思考强度下拉列出适配器自报的档位',
    selects.some((select) => (select.children ?? []).length === 3)
      && effortSelect !== undefined
      && (effortSelect.children ?? []).length === STATE.value.reasoning.efforts.length,
    `${(effortSelect?.children ?? []).length} / ${STATE.value.reasoning.efforts.length}`)
  const textarea = findAll(walk, (node) => node.type === 'textarea')[0]
  check('自定义提示词框留空（不预填默认）', textarea !== undefined && textarea.props.value === '')
  check('设置页可展开查看内置默认', textOf(walk).includes('查看内置默认提示词'))
  check('设置页的上下文下拉默认选中「全部历史记录」', textOf(walk).includes('全部历史记录')
    && findAll(walk, (node) => node.type === 'select').some((select) => select.props.value === 'all'))

  // What the lazy mounting buys: the panel is never unmounted, so a half-typed
  // prompt draft is still there after a round trip through another tab.
  const promptArea = (tree) => findAll(
    findAll(tree, (node) => node.props?.role === 'tabpanel' && node.props.id === 'dspo-panel-prompt')[0],
    (node) => node.type === 'textarea',
  )[0]
  promptArea(walk).props.onChange({ target: { value: '半截草稿' } })
  walk = clickTab(clickTab(walk, 'model'), 'prompt')
  const keptDraft = promptArea(walk)
  check('切到别的页签再切回来，半截的提示词草稿没被重置',
    keptDraft.props.value === '半截草稿', String(keptDraft.props.value))

  /* ── the split's acceptance criterion: no omission, no duplication ── */
  // Keyed off the `dspo-set-label` nodes on purpose: the 说明 blocks re-print
  // some of these names, so raw text would double-count them. The shortcut row
  // renders `shortcutToggle` ("启用 Alt+O 触发优化"); `shortcutLabel` ("快捷键")
  // is in the dictionary but is not a row name, so it is not in this list.
  const ROW_KEYS = ['followSession', 'modelLabel', 'effortLabel', 'styleLabelSetting', 'applyModeLabel', 'routeLabel', 'shortcutToggle', 'promptLabel', 'btwModelLabel', 'btwEffortLabel', 'btwContextLabel', 'btwSaveHistoryLabel', 'compactionLabel', 'notifyToggle', 'notifyPlatformLabel']
  const expectedRows = ROW_KEYS.map((key) => bundle.DICT.zh[key])
  const sets = TAB_IDS.map((id) => labelsByTab[id])
  const summary = TAB_IDS.map((id) => `${id}:[${labelsByTab[id].join('|')}]`).join(' ')
  check('每个页签都渲染出设置行', sets.every((labels) => labels.length > 0), summary)
  check('六个页签的设置行两两不相交、页签内部也不重复',
    sets.every((labels) => new Set(labels).size === labels.length)
      && sets.every((labels, index) => sets.slice(index + 1).every((other) => labels.every((label) => !other.includes(label)))),
    summary)
  const union = [...new Set(sets.flat())].sort()
  check('六个页签的行标签并集恰好是词典里的这 15 行（无遗漏、无重复）',
    union.length === ROW_KEYS.length && JSON.stringify(union) === JSON.stringify([...expectedRows].sort()),
    `${union.length}: ${union.join('|')}`)

  /* ── page-level facts stay outside every panel, on every tab ── */
  const configFile = STATE.value.configFile
  check('配置文件路径行是页级节点（面板之外）',
    pageLevel(allTabs).some((node) => textOf(node).includes(bundle.DICT.zh.configFile) && textOf(node).includes(configFile))
      && pageLevelInsidePanels(allTabs).length === 0,
    pageLevel(allTabs).map(textOf).join(' | '))
  const perTab = TAB_IDS.map((id) => {
    walk = clickTab(walk, id)
    return {
      id,
      ok: selectedTab(walk).props.id === `dspo-tab-${id}`
        && pageLevel(walk).some((node) => textOf(node).includes(configFile))
        && pageLevelInsidePanels(walk).length === 0,
    }
  })
  check('配置文件路径每个页签下都在、且都在面板之外',
    perTab.every((entry) => entry.ok), perTab.filter((entry) => !entry.ok).map((entry) => entry.id).join(','))

  // A failed save paints the page-level error line; it is page furniture too.
  walk = clickTab(walk, 'rewrite')
  findAll(visiblePanel(walk), (node) => node.type === 'select' && node.props.id === 'dspo-style')[0]
    .props.onChange({ target: { value: 'slim' } })
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  const errored = page()
  const errorLine = pageLevel(errored).find((node) => node.props.className === 'dspo-set-error')
  const errorPerTab = TAB_IDS.map((id) => {
    const active = clickTab(errored, id)
    return pageLevel(active).some((node) => node.props.className === 'dspo-set-error')
      && pageLevelInsidePanels(active).length === 0
  })
  check('保存失败时的错误行同样是页级节点（面板之外、每个页签下都在）',
    bundle.settingsStore.get().error !== null
      && errorLine !== undefined
      && textOf(errorLine) === bundle.settingsStore.get().error
      && errorPerTab.every((ok) => ok === true),
    `${bundle.settingsStore.get().error} / ${errorLine === undefined ? 'missing' : textOf(errorLine)}`)

  // The other half of that feedback pair: a save the host accepted paints the
  // ok line. It needs its own mount — the store above now carries the failure —
  // and a host that accepts `/save`.
  const okBundle = loadClientBundle(makeFetch({ saveOk: true }))
  await okBundle.settingsStore.load(true)
  const okRender = mountClient(okBundle, okBundle.SettingsPanel)
  const okPage = () => okRender({ close() {} })
  const okRail = (tree, id) => findAll(tree, (node) => node.props?.id === `dspo-tab-${id}`)[0]
  const okPanel = (tree, id) => findAll(tree, (node) => node.props?.role === 'tabpanel' && node.props.id === `dspo-panel-${id}`)[0]
  const okClickTab = (tree, id) => {
    okRail(tree, id).props.onClick()
    return okPage()
  }
  let okTree = okClickTab(okPage(), 'prompt')
  findAll(okPanel(okTree, 'prompt'), (node) => node.type === 'textarea')[0]
    .props.onChange({ target: { value: '自定义提示词' } })
  okTree = okPage()
  const okSave = findAll(okPanel(okTree, 'prompt'), (node) => node.type === 'button' && node.props['data-kind'] === 'primary')[0]
  const okSaveEnabled = okSave.props.disabled === false
  okSave.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  okTree = okPage()
  const okLine = (okTree.children ?? []).find((child) => child?.props?.className === 'dspo-set-ok')
  const okPerTab = TAB_IDS.map((id) => {
    const active = okClickTab(okTree, id)
    return (active.children ?? []).some((child) => child?.props?.className === 'dspo-set-ok')
      && panelsOf(active).every((panel) => findAll(panel, (node) => node.props?.className === 'dspo-set-ok').length === 0)
  })
  check('保存成功的提示行同样是页级节点（面板之外、切页签后仍在）',
    okSaveEnabled && okLine !== undefined && textOf(okLine) === okBundle.DICT.zh.saved && okPerTab.every((ok) => ok === true),
    `${okSaveEnabled ? '' : 'disabled '}${textOf(okLine ?? 'missing')}`)
  okBundle.__restore()

  /* ── the rail walks with the keyboard, like the shell's own ── */
  let keys = clickTab(page(), 'model')
  const steppedRight = press(keys, 'model', 'ArrowRight')
  keys = page()
  check('ArrowRight 选中下一个页签', steppedRight === true
    && selectedTab(keys).props.id === 'dspo-tab-rewrite' && selectedTabs(keys).length === 1)
  const steppedLeft = press(keys, 'rewrite', 'ArrowLeft')
  keys = page()
  check('ArrowLeft 选中上一个页签', steppedLeft === true && selectedTab(keys).props.id === 'dspo-tab-model')
  const wrappedBack = press(keys, 'model', 'ArrowLeft')
  keys = page()
  check('ArrowLeft 从第一个页签回绕到最后一个',
    wrappedBack === true && selectedTab(keys).props.id === 'dspo-tab-notify')
  const wrappedForward = press(keys, 'notify', 'ArrowRight')
  keys = page()
  check('ArrowRight 从最后一个页签回绕到第一个',
    wrappedForward === true && selectedTab(keys).props.id === 'dspo-tab-model')
  const ended = press(keys, 'model', 'End')
  keys = page()
  check('End 选中最后一个页签', ended === true && selectedTab(keys).props.id === 'dspo-tab-notify')
  const homed = press(keys, 'notify', 'Home')
  keys = page()
  check('Home 选中第一个页签', homed === true && selectedTab(keys).props.id === 'dspo-tab-model')
  const untouched = press(keys, 'model', 'Enter')
  keys = page()
  check('未处理的按键不调用 preventDefault、也不改选中',
    untouched === false && selectedTab(keys).props.id === 'dspo-tab-model')
  check('键盘移动后 data-active / tabIndex / 唯一性都跟着选中走',
    selectedTabs(keys).length === 1
      && tabsOf(keys).every((tab) => tab.props.tabIndex === (tab.props['aria-selected'] === true ? 0 : -1)
        && tab.props['data-active'] === (tab.props['aria-selected'] === true ? 'true' : undefined))
      && visiblePanels(keys).length === 1
      && visiblePanel(keys).props['aria-labelledby'] === selectedTab(keys).props.id)
  bundle.__restore()
}

{
  // 「旁路提问」自己的模型与强度：与「优化提示词」同形、同值、互不影响。
  // Its own bundle with a host that accepts saves, so what the two pickers write
  // is read off the requests themselves rather than off a fixture echo.
  const fetchImpl = makeFetch({ saveOk: true })
  const bundle = loadClientBundle(fetchImpl)
  await bundle.settingsStore.load(true)
  const render = mountClient(bundle, bundle.SettingsPanel)
  const page = () => render({ close() {} })
  const rail = (tree, id) => findAll(tree, (node) => node.props?.id === `dspo-tab-${id}`)[0]
  const panelOf = (tree, id) => findAll(tree, (node) => node.props?.role === 'tabpanel' && node.props.id === `dspo-panel-${id}`)[0]
  const openTab = (tree, id) => {
    rail(tree, id).props.onClick()
    return page()
  }
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  let walk = openTab(page(), 'model')
  walk = openTab(walk, 'btw')
  const btwPanel = panelOf(walk, 'btw')
  const modelPanel = panelOf(walk, 'model')
  const btwProvider = findAll(btwPanel, (node) => node.props?.id === 'dspo-btw-provider')[0]
  const btwModel = findAll(btwPanel, (node) => node.props?.id === 'dspo-btw-model-pick')[0]
  const btwEffort = findAll(btwPanel, (node) => node.props?.id === 'dspo-btw-effort')[0]
  const modelProvider = findAll(modelPanel, (node) => node.props?.id === 'dspo-provider')[0]
  const modelPick = findAll(modelPanel, (node) => node.props?.id === 'dspo-model')[0]
  const modelEffort = findAll(modelPanel, (node) => node.props?.id === 'dspo-effort')[0]
  const labelsOf = (select) => (select?.children ?? []).map(textOf)
  const valuesOf = (select) => (select?.children ?? []).map((option) => option.props.value)

  check('旁路提问页签里有模型选择项（provider + model 两个下拉）',
    btwProvider?.type === 'select' && btwModel?.type === 'select')
  check('旁路提问页签里有思考强度选择项', btwEffort?.type === 'select')
  check('两处模型可选值完全一致（同一份目录，逐个相同）',
    JSON.stringify(labelsOf(btwProvider)) === JSON.stringify(labelsOf(modelProvider))
      && JSON.stringify(labelsOf(btwModel)) === JSON.stringify(labelsOf(modelPick)),
    `${labelsOf(btwModel).join(',')} vs ${labelsOf(modelPick).join(',')}`)
  check('两处思考等级可选值完全一致（逐个相同）',
    JSON.stringify(labelsOf(btwEffort)) === JSON.stringify(labelsOf(modelEffort))
      && JSON.stringify(valuesOf(btwEffort)) === JSON.stringify(valuesOf(modelEffort)),
    `${labelsOf(btwEffort).join(',')} vs ${labelsOf(modelEffort).join(',')}`)
  check('两处的强度档位就是适配器自报的那一组',
    JSON.stringify(valuesOf(btwEffort)) === JSON.stringify(STATE.value.reasoning.efforts))
  check('旁路的模型与强度默认未选择（模型空值、强度 off，与「优化提示词」的默认一致）',
    btwModel.props.value === '' && btwEffort.props.value === 'off' && modelEffort.props.value === 'off')

  const lastSave = () => fetchImpl.seen.filter((entry) => entry.action === 'save').at(-1)?.body ?? null
  btwEffort.props.onChange({ target: { value: 'high' } })
  await settle()
  check('改旁路思考强度只发 btwReasoningEffort',
    JSON.stringify(lastSave()) === JSON.stringify({ btwReasoningEffort: 'high' }), JSON.stringify(lastSave()))
  findAll(panelOf(page(), 'btw'), (node) => node.props?.id === 'dspo-btw-model-pick')[0]
    .props.onChange({ target: { value: 'deepseek-pro' } })
  await settle()
  const patch = lastSave()
  check('改旁路模型只发 btwProvider / btwModel',
    JSON.stringify(patch) === JSON.stringify({ btwProvider: 'deepseek-official', btwModel: 'deepseek-pro' }),
    JSON.stringify(patch))
  check('改旁路的两项设置都不携带「优化提示词」的键',
    patch !== null && !('provider' in patch) && !('model' in patch)
      && !('reasoningEffort' in patch) && !('followSessionModel' in patch))
  bundle.__restore()
}

/* ── 旁路提问（浏览器半区） ── */

/** One conversation node in the shape the chat snapshot publishes. */
const userNode = (text) => ({ kind: 'user', seq: 1, time: 1, content: [{ type: 'text', text }] })
const assistantNode = (text) => ({ kind: 'assistant', seq: 2, time: 2, turns: 1, blocks: [{ kind: 'text', text }], turn: 1, step: 1 })
/** A settled tool row: the real shape is the `tool-result` root of a `tool-call` node. */
const toolNode = (callId, name, output) => ({
  kind: 'tool-result',
  seq: 3,
  time: 3,
  callId,
  call: { name, argsRaw: `{"path":"${callId}.ts"}` },
  content: [{ type: 'text', text: output }],
  isError: false,
  subCalls: [],
})

{
  // The context reducer is pure, so it is checked without a component.
  const bundle = loadClientBundle(makeFetch())
  const mixedAssistant = {
    ...assistantNode('好的，先看首屏加载'),
    blocks: [
      { kind: 'text', text: '好的，先看首屏加载' },
      { kind: 'reasoning', text: '内部推理' },
      { kind: 'tool-call', callId: 'call-1', name: 'read', argsRaw: '{"path":"src/login.tsx"}' },
    ],
  }
  const nodes = [
    userNode('把登录页改快一点'),
    mixedAssistant,
    toolNode('call-1', 'read', 'TOOL_OUTPUT'),
    { kind: 'context', seq: 4, time: 4, content: [{ type: 'text', text: '系统注入' }] },
    userNode('那用懒加载'),
  ]
  const carried = bundle.btwContext(nodes, 8)
  check('上下文带用户与助手文本', carried.text.includes('把登录页改快一点') && carried.text.includes('好的，先看首屏加载'))
  check('上下文是会话的原始记录（逐行 JSON，字段一个不少）',
    carried.text.split('\n').every((line) => line.startsWith('{') && JSON.parse(line) !== null)
    && carried.text.includes(JSON.stringify(nodes[2]))
    && carried.text.includes(JSON.stringify(mixedAssistant)))
  check('上下文原样带上工具调用与结果', carried.text.includes('src/login.tsx') && carried.text.includes('TOOL_OUTPUT'))
  check('上下文原样带上推理与上下文注入（不再丢弃）', carried.text.includes('内部推理') && carried.text.includes('系统注入'))
  check('上下文按条数截取最近的记录', bundle.btwContext(nodes, 2).text.includes('那用懒加载') && !bundle.btwContext(nodes, 2).text.includes('把登录页改快一点') && bundle.btwContext(nodes, 2).messages === 2)
  check('档位 0 时完全不读会话', bundle.btwContext(nodes, 0).text === '' && bundle.btwContext(nodes, 0).messages === 0)
  check('空记录不会报错', bundle.btwContext(undefined, 8).text === '')
  // The default setting: every record, with no count cap and no character trimming.
  const all = bundle.btwContext(nodes, 'all')
  check('「全部历史」把这条会话的记录全部带上', all.messages === 5
    && all.text.includes('把登录页改快一点')
    && all.text.includes('TOOL_OUTPUT')
    && all.text.includes('系统注入')
    && all.text.includes('那用懒加载'))
  const many = []
  for (let index = 0; index < 120; index += 1) {
    many.push(index % 2 === 0 ? userNode(`第 ${index} 条`) : assistantNode(`第 ${index} 条`))
  }
  many.push(toolNode('call-big', 'read', '长'.repeat(20_000)))
  const everything = bundle.btwContext(many, 'all')
  check('「全部历史」不按条数截断（120 条全在）', everything.messages === 121 && everything.text.includes('第 0 条'))
  check('「全部历史」单条也不做字符截断（工具结果也一样）', everything.text.includes('长'.repeat(20_000)))
  bundle.__restore()
}

{
  const fetchImpl = makeFetch()
  const bundle = loadClientBundle(fetchImpl)
  await bundle.settingsStore.load(true)
  const input = makeInput({ draft: '' })
  const button = buttonsOf(bundle.BtwButton(input.props))[0]
  check('工具行渲染出旁路提问按钮', labelOf(button).includes('旁路提问'))
  check('按钮标题带 Alt+B', String(button.props.title).includes('Alt+B'))
  check('面板默认不渲染（关闭态零占位）', bundle.BtwPanel(input.props) === null)
  button.props.onClick()
  check('点按钮即打开该会话的面板', bundle.readBtw('session-a').open === true)
  const panel = bundle.BtwPanel(input.props)
  check('打开后是浮层卡片（不是挡住主对话的模态）', panel !== null && panel.props.className === 'dspo-btw')
  // The shell's keyboard arbitration runs on window-capture, ahead of anything
  // this plugin can register, and yields to `[role="dialog"][aria-modal="true"]`.
  // The panel declares that marker so Escape belongs to it while it is open;
  // otherwise a running main turn would eat the press as its `Esc Esc` chord.
  check('面板声明宿主认得的模态标记（Esc 才归面板）',
    panel.props.role === 'dialog' && panel.props['aria-modal'] === 'true')
  check('面板说明答案不会进入主对话', textOf(panel).includes('不写进主对话'))
  check('读不到会话记录时明说，而不是假装带了上下文', textOf(panel).includes('读不到会话记录'))
  bundle.__restore()
}

{
  const fetchImpl = makeFetch()
  const bundle = loadClientBundle(fetchImpl)
  await bundle.settingsStore.load(true)
  const input = makeInput({}, [userNode('把登录页改快一点'), assistantNode('好的')], {
    runningCalls: [{ phase: 'start', callId: 'call-9', name: 'bash', argsRaw: '{"command":"npm test"}', turn: 1, step: 2, time: 9, subCalls: [] }],
    partial: { turn: 1, step: 2, blocks: [{ kind: 'text', text: '正在跑测试' }] },
  })
  bundle.openBtw('session-a')
  bundle.patchBtw('session-a', { draft: '登录页改了吗？' })
  const panel = bundle.BtwPanel(input.props)
  const askButton = buttonsOf(panel).find((candidate) => labelOf(candidate).trim() === '提问')
  check('面板提供「提问」按钮', askButton !== undefined)
  askButton.props.onClick()
  const started = Date.now()
  while (bundle.readBtw('session-a').phase === 'asking' && Date.now() - started < 4000) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const session = bundle.readBtw('session-a')
  check('旁路提问流出答案', session.phase === 'done' && session.thread[0].a === '旁路答案', JSON.stringify(session.thread))
  const request = fetchImpl.seen.find((entry) => entry.action === 'btw.stream')
  check('请求带上问题、上下文与会话 id', request?.body?.question === '登录页改了吗？'
    && request.body.context.includes('把登录页改快一点')
    && request.body.sessionId === 'session-a')
  check('进行中的工具调用与流式文本也随上下文发出', request?.body?.context.includes('npm test')
    && request.body.context.includes('正在跑测试'))
  check('问题发出后输入框被清空（避免重复提交）', session.draft === '')
  const answerSaved = fetchImpl.seen.find((entry) => entry.action === 'btw.save')
  check('答案落进旁路历史', answerSaved?.body?.answer === '旁路答案' && answerSaved.body.question === '登录页改了吗？')
  check('采用宿主回传的话题 id', session.topicId === 'topic-1' && session.topics.length === 1)
  // The walk is what makes "all" true; this case checks the seat's own label for
  // a completed window (the walk has its own cases further down).
  bundle.patchBtw('session-a', { historyStatus: 'complete' })
  check('面板显示「全部历史」的条数', textOf(bundle.BtwPanel(input.props)).includes('已带全部 4 条会话记录'))
  // The read-only contract on this half: asking never writes to the composer.
  // (The composer is only touched by the explicit 「写入输入框」 button.)
  check('提问本身不写输入框', input.writes.length === 0 && input.state.draftRev === 1)
  bundle.__restore()
}

{
  // The narrowed modes still work and say so: only "all" claims "all".
  const fetchImpl = makeFetch()
  const bundle = loadClientBundle(fetchImpl)
  STATE.value.settings.btwContextTurns = 4
  await bundle.settingsStore.load(true)
  const input = makeInput({}, [userNode('一'), assistantNode('二'), userNode('三'), assistantNode('四'), userNode('五'), assistantNode('六')])
  bundle.openBtw('session-a')
  const panel = bundle.BtwPanel(input.props)
  const text = textOf(panel)
  check('收窄到最近 N 条时如实标注条数', text.includes('已带最近 4 条会话记录') && !text.includes('已带全部'))
  bundle.patchBtw('session-a', { draft: '只看最近几条' })
  const asking = bundle.BtwPanel(input.props)
  buttonsOf(asking).find((candidate) => labelOf(candidate).trim() === '提问').props.onClick()
  const started = Date.now()
  while (bundle.readBtw('session-a').phase === 'asking' && Date.now() - started < 4000) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const request = fetchImpl.seen.find((entry) => entry.action === 'btw.stream')
  check('收窄时只发最近 N 条记录', request?.body?.context.includes('三') && !request.body.context.includes('一'))
  STATE.value.settings.btwContextTurns = 'all'
  bundle.__restore()
}

{
  const fetchImpl = makeFetch()
  const bundle = loadClientBundle(fetchImpl)
  await bundle.settingsStore.load(true)
  const input = makeInput({}, [userNode('上下文')])
  bundle.openBtw('session-a')
  bundle.patchBtw('session-a', { draft: '空问题不该发出' })
  bundle.patchBtw('session-a', { draft: '   ' })
  const panel = bundle.BtwPanel(input.props)
  const askButton = buttonsOf(panel).find((candidate) => labelOf(candidate).trim() === '提问')
  check('空白问题禁用「提问」', askButton.props.disabled === true)
  bundle.__restore()
}

{
  const fetchImpl = makeFetch({ btwTopics: [{ id: 't-old', at: 1, turns: [{ q: '历史问题', a: '历史答案', at: 1 }] }] })
  const bundle = loadClientBundle(fetchImpl)
  await bundle.settingsStore.load(true)
  const input = makeInput({}, [userNode('上下文')])
  bundle.openBtw('session-a')
  const started = Date.now()
  while (bundle.readBtw('session-a').loaded !== true && Date.now() - started < 4000) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const panel = bundle.BtwPanel(input.props)
  const historyButton = buttonsOf(panel).find((candidate) => labelOf(candidate).trim() === '历史')
  check('面板提供「历史」入口', historyButton !== undefined)
  historyButton.props.onClick()
  const withHistory = bundle.BtwPanel(input.props)
  const topicButton = buttonsOf(withHistory).find((candidate) => labelOf(candidate).includes('历史问题'))
  check('历史列出已存话题', topicButton !== undefined)
  topicButton.props.onClick()
  const reopened = bundle.BtwPanel(input.props)
  check('点历史话题即载回该话题的轮次', textOf(reopened).includes('历史答案'))
  const newButton = buttonsOf(reopened).find((candidate) => labelOf(candidate).trim() === '新问题')
  newButton.props.onClick()
  check('「新问题」清空当前话题', bundle.readBtw('session-a').thread.length === 0 && bundle.readBtw('session-a').topicId === '')
  bundle.__restore()
}

{
  // Escape closes the panel, and the history list is a layer of its own.
  const fetchImpl = makeFetch({ btwTopics: [{ id: 't-old', at: 1, turns: [{ q: '历史问题', a: '历史答案', at: 1 }] }] })
  const bundle = loadClientBundle(fetchImpl)
  await bundle.settingsStore.load(true)
  const input = makeInput({}, [userNode('上下文')])
  bundle.openBtw('session-a')
  const started = Date.now()
  while (bundle.readBtw('session-a').loaded !== true && Date.now() - started < 4000) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const panel = bundle.BtwPanel(input.props)
  check('面板关闭按钮标注 Esc 快捷键', buttonsOf(panel).some((candidate) => String(candidate.props.title ?? '').includes('Esc')))
  buttonsOf(panel).find((candidate) => labelOf(candidate).trim() === '历史').props.onClick()
  bundle.BtwPanel(input.props)
  check('历史列表已展开', bundle.readBtw('session-a').historyOpen === true)
  // The harness keeps every listener the render registered (React drops the
  // previous one on re-render), so the stale ones go before the keystroke.
  flushEffects()
  bundle.BtwPanel(input.props)
  bundle.__key({ key: 'Escape' })
  check('第一次 Esc 先关历史列表、面板还开着',
    bundle.readBtw('session-a').historyOpen === false && bundle.readBtw('session-a').open === true)
  flushEffects()
  bundle.BtwPanel(input.props)
  bundle.__key({ key: 'Escape' })
  check('再按 Esc 关掉面板', bundle.readBtw('session-a').open === false)
  check('Esc 不写输入框（关闭不是一次写入）', input.writes.length === 0)
  flushEffects()
  bundle.__restore()
}

{
  // Escape is the panel's, not the shell's: modifiers, an already-handled event
  // and a closed panel all leave the listener alone.
  const fetchImpl = makeFetch()
  const bundle = loadClientBundle(fetchImpl)
  await bundle.settingsStore.load(true)
  const input = makeInput({}, [userNode('上下文')])
  bundle.openBtw('session-a')
  bundle.BtwPanel(input.props)
  bundle.__key({ key: 'Escape', shiftKey: true })
  check('带修饰键的 Esc 不关面板', bundle.readBtw('session-a').open === true)
  bundle.__key({ key: 'Escape', defaultPrevented: true })
  check('已被别的图层处理掉的 Esc 不再处理', bundle.readBtw('session-a').open === true)
  bundle.__key({ key: 'b' })
  check('非 Esc 按键不动面板', bundle.readBtw('session-a').open === true)
  flushEffects()
  bundle.closeBtw('session-a')
  bundle.BtwPanel(input.props)
  bundle.__key({ key: 'Escape' })
  check('面板已关闭时 Esc 不报错也不改状态', bundle.readBtw('session-a').open === false)
  flushEffects()
  bundle.__restore()
}

{
  const fetchImpl = makeFetch()
  const bundle = loadClientBundle(fetchImpl)
  await bundle.settingsStore.load(true)
  const input = makeInput({}, [userNode('上下文')])
  bundle.openBtw('session-a')
  bundle.patchBtw('session-a', {
    thread: [{ q: '问题', a: '一条回答', state: 'done' }],
    phase: 'done',
  })
  const panel = bundle.BtwPanel(input.props)
  const toComposer = buttonsOf(panel).find((candidate) => labelOf(candidate).trim() === '写入输入框')
  check('答案提供「写入输入框」', toComposer !== undefined)
  toComposer.props.onClick()
  check('写入走 inputActions.setDraft（不碰编辑器 DOM）', input.writes.includes('一条回答') && input.state.draft === '一条回答')
  check('这是该面板唯一一次写入，且由用户点击触发', input.writes.length === 1)
  bundle.__restore()
}

/* ── the transcript window: entering a conversation loads all of it ── */

/** A tick long enough for the walk's awaits to settle. */
const settleTicks = () => new Promise((resolve) => setTimeout(resolve, 20))

/**
 * A fake shell session face: `loadOlder()` prepends one fixture page into the
 * very array the panel reads as chat nodes, which is what the real window does
 * to the chat snapshot. `stall` models a page request that never changes
 * anything (an exhausted window that keeps claiming more).
 */
function makeSessionFace(pages, options = {}) {
  const state = { hasMore: options.hasMore ?? pages.length > 0, loadingOlder: false, calls: 0 }
  const listeners = new Set()
  // The real face caches its snapshot reference until the window changes; the
  // walk's no-progress guard compares references, so the fixture must too.
  let snapshot = { hasMore: state.hasMore, loadingOlder: false }
  const publish = () => {
    snapshot = { hasMore: state.hasMore, loadingOlder: state.loadingOlder }
    for (const listener of [...listeners]) listener()
  }
  return {
    state,
    loadOlder: async () => {
      state.calls += 1
      if (options.stall === true) return
      const page = pages.shift() ?? []
      if (options.into !== undefined) options.into.unshift(...page)
      state.hasMore = pages.length > 0
      publish()
    },
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** A fake client context exposing the `sessions` service the walk needs. */
function makeClientCtx(face) {
  return {
    get: (name) => (name === 'sessions' && face !== null ? { scope: () => face } : undefined),
    effect: (fn) => {
      fn()
      return () => {}
    },
    slots: { inject: () => () => {}, register: () => () => {} },
  }
}

{
  // The whole point: nobody scrolled, and the window still ends up covering the
  // session's first event.
  const bundle = loadClientBundle(makeFetch())
  const nodes = []
  const face = makeSessionFace(
    [
      [assistantNode('最早的一条'), userNode('第二条')],
      [assistantNode('第三条'), userNode('最近一条')],
    ],
    { into: nodes },
  )
  const result = await bundle.ensureFullHistory('session-a', makeClientCtx(face))
  check('补历史：一路拉回最早一页', result.status === 'complete' && result.pages === 2 && face.state.calls === 2, JSON.stringify(result))
  check('补历史：拉完后不再有更早的分页', face.state.hasMore === false)
  check('补历史：窗口里现在连最早那条都在', bundle.btwContext(nodes, 'all').messages === 4
    && bundle.btwContext(nodes, 'all').text.includes('最早的一条'))
  check('补历史：状态写成 complete', bundle.readBtw('session-a').historyStatus === 'complete')
}

{
  // A page that changes nothing must end the walk, not spin it.
  const bundle = loadClientBundle(makeFetch())
  const face = makeSessionFace([], { stall: true, hasMore: true })
  const result = await bundle.ensureFullHistory('session-a', makeClientCtx(face))
  check('补历史：分页不前进时不打转，如实报 partial', result.status === 'partial' && face.state.calls === 1, JSON.stringify(result))
  check('补历史：partial 写进面板状态', bundle.readBtw('session-a').historyStatus === 'partial')
}

{
  // Two seats mounting at once (a session switch mid-walk, an ask that arrives
  // early) must join one walk, not page the same window twice.
  const bundle = loadClientBundle(makeFetch())
  const nodes = []
  const face = makeSessionFace([[assistantNode('更早的')]], { into: nodes })
  const [first, second] = await Promise.all([
    bundle.ensureFullHistory('session-a', makeClientCtx(face)),
    bundle.ensureFullHistory('session-a', makeClientCtx(face)),
  ])
  check('并发补历史只走一遍（两个座位挂载时）', face.state.calls === 1 && first === second && first.status === 'complete', String(face.state.calls))
}

{
  // A shell without the sessions service is not an activation failure: the
  // panel just has to stop calling a window "all of it".
  const bundle = loadClientBundle(makeFetch())
  const result = await bundle.ensureFullHistory('session-a', { get: () => undefined })
  check('补历史：读不到 sessions 服务时报 unavailable', result.status === 'unavailable'
    && bundle.readBtw('session-a').historyStatus === 'unavailable')
}

{
  // Mounting the seat is the trigger, and the accept path carries the grown
  // transcript — the acceptance criterion for this feature.
  const fetchImpl = makeFetch({ btwAnswer: '好的' })
  const bundle = loadClientBundle(fetchImpl)
  await bundle.settingsStore.load(true)
  const nodes = [assistantNode('最近一条')]
  const face = makeSessionFace([[assistantNode('最早的一条'), userNode('第二条')]], { into: nodes })
  bundle.apply(makeClientCtx(face))
  const input = makeInput({}, nodes)
  bundle.BtwButton(input.props)
  await settleTicks()
  check('进入会话即自动补历史（无需滚动）', face.state.calls === 1 && face.state.hasMore === false)
  bundle.openBtw('session-a')
  bundle.patchBtw('session-a', { draft: '最早那条讲的是什么？' })
  check('补完后面板报「已带全部」', textOf(bundle.BtwPanel(input.props)).includes('已带全部 3 条会话记录'))
  const panel = bundle.BtwPanel(input.props)
  await buttonsOf(panel).find((candidate) => labelOf(candidate).trim() === '提问').props.onClick()
  await settleTicks()
  const request = fetchImpl.seen.find((entry) => entry.action === 'btw.stream')
  check('提问带的是完整历史（含最早那条，不只是已加载的一页）',
    request !== undefined && String(request.body.context).includes('最早的一条'))
  check('提问回传的条数就是完整历史的条数', bundle.readBtw('session-a').carried === 3, String(bundle.readBtw('session-a').carried))
  bundle.__restore()
}

{
  // The labels are the honest half of the feature: while the window is short,
  // the panel must not claim the whole transcript.
  const bundle = loadClientBundle(makeFetch())
  await bundle.settingsStore.load(true)
  const input = makeInput({}, [userNode('第一条'), userNode('第二条')])
  bundle.openBtw('session-a')
  bundle.patchBtw('session-a', { historyStatus: 'loading' })
  check('载入中时报「正在载入更早的历史…」', textOf(bundle.BtwPanel(input.props)).includes('正在载入更早的历史'))
  bundle.patchBtw('session-a', { historyStatus: 'partial' })
  check('没载完时报「已带当前已加载的 N 条（更早的历史未载完）」',
    textOf(bundle.BtwPanel(input.props)).includes('已带当前已加载的 2 条会话记录（更早的历史未载完）'))
  bundle.patchBtw('session-a', { historyStatus: 'unavailable' })
  check('读不到加载器时只说手里有多少、不声称「全部」也不断言还缺',
    textOf(bundle.BtwPanel(input.props)).includes('已带当前已加载的 2 条会话记录')
    && !textOf(bundle.BtwPanel(input.props)).includes('已带全部')
    && !textOf(bundle.BtwPanel(input.props)).includes('更早的历史未载完'))
  bundle.patchBtw('session-a', { historyStatus: 'complete' })
  check('载完了才说「已带全部」', textOf(bundle.BtwPanel(input.props)).includes('已带全部 2 条会话记录'))
  bundle.__restore()
}

{
  // "Carry nothing" means the transcript is not walked at all.
  const bundle = loadClientBundle(makeFetch())
  const face = makeSessionFace([[userNode('更早的')]], { into: [] })
  bundle.apply(makeClientCtx(face))
  STATE.value.settings.btwContextTurns = 0
  await bundle.settingsStore.load(true)
  const input = makeInput({}, [userNode('已加载的')])
  bundle.BtwButton(input.props)
  await settleTicks()
  check('设置成「不带上下文」时不拉整段历史', face.state.calls === 0, String(face.state.calls))
  STATE.value.settings.btwContextTurns = 'all'
  await bundle.settingsStore.load(true)
  bundle.__restore()
}

{
  const fetchImpl = makeFetch({ btwFailed: true })
  const bundle = loadClientBundle(fetchImpl)
  await bundle.settingsStore.load(true)
  const input = makeInput({}, [userNode('上下文')])
  bundle.openBtw('session-a')
  bundle.patchBtw('session-a', { draft: '会失败的问题' })
  const panel = bundle.BtwPanel(input.props)
  buttonsOf(panel).find((candidate) => labelOf(candidate).trim() === '提问').props.onClick()
  const started = Date.now()
  while (bundle.readBtw('session-a').phase === 'asking' && Date.now() - started < 4000) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const session = bundle.readBtw('session-a')
  check('失败时如实显示错误而不是静默', session.phase === 'error' && session.thread[0].state === 'error')
  check('失败的时刻用错误文案回显', textOf(bundle.BtwPanel(input.props)).includes('超时'))
  check('失败同样不写输入框', input.writes.length === 0)
  bundle.__restore()
}

{
  // i18n: the shell's locale switches the copy.
  const bundle = loadClientBundle(makeFetch())
  const disposed = []
  const ctx = {
    locale: {
      getLocale: () => ({ active: 'en' }),
      subscribe() {
        return () => disposed.push('locale')
      },
    },
    slots: { inject: (key, factory) => factory(), register: () => () => {} },
    effect(factory) {
      disposed.push(factory())
      return () => {}
    },
  }
  bundle.apply(ctx)
  await bundle.settingsStore.load(true)
  const input = makeInput({ draft: 'make the login page faster' })
  const button = buttonsOf(bundle.OptimizeButton(input.props))[0]
  check('locale=en 时按钮文案为英文', labelOf(button).includes('Optimize prompt'), labelOf(button))
  check('locale=en 时设置页为英文', textOf(bundle.SettingsPanel({ close() {} })).includes('Optimization model'))
  bundle.__restore()
}

{
  // Client contract checks that only need the source, kept last so the report
  // groups them with the browser half.
  const zhKeys = Object.keys(bundleKeysOf('zh')).sort()
  const enKeys = Object.keys(bundleKeysOf('en')).sort()
  check('中英文词典键完全一致', JSON.stringify(zhKeys) === JSON.stringify(enKeys), `${zhKeys.length} vs ${enKeys.length}`)
  const literalKeys = [...clientSource.matchAll(/\bt\('([a-zA-Z][\w]*)'/g)].map((match) => match[1])
  const missing = [...new Set(literalKeys)].filter((key) => !zhKeys.includes(key) && !/^effort[A-Z]/.test(key) && !/^style[A-Z]/.test(key))
  check('代码里用到的文案键都在词典里', missing.length === 0, missing.join(','))
  check('词典无遗留的占位文本', !zhKeys.some((key) => /todo|lorem/i.test(key)))

  function bundleKeysOf(id) {
    const source = clientSource
    const at = source.indexOf(`${id}: {`)
    const end = source.indexOf('\n      },', at)
    const body = source.slice(at, end)
    const keys = {}
    for (const match of body.matchAll(/^\s{8}(\w+):/gm)) keys[match[1]] = true
    return keys
  }
}

/* ───────────────────────── 4b. compaction + notification UI ───────────────────────── */

section('4b. 压缩与通知的浏览器半区')

{
  const bundle = loadClientBundle(makeFetch())
  await bundle.settingsStore.load(true)

  /* ── the summary extractor ── */
  check('摘要取最后一条 assistant 记录的正文',
    bundle.answerSummary([
      { role: 'user', text: '问题' },
      { role: 'assistant', content: [{ text: '第一段' }, { text: '第二段' }] },
    ]) === '第一段\n第二段',
    bundle.answerSummary([{ role: 'assistant', content: [{ text: '第一段' }, { text: '第二段' }] }]))
  check('摘要跳过非 assistant 记录',
    bundle.answerSummary([{ role: 'assistant', text: '答' }, { role: 'user', text: '又问' }]) === '答')
  check('摘要把还在流式的 partial 也算进去',
    bundle.answerSummary([{ role: 'assistant', text: '旧答' }], { role: 'assistant', text: '新答' }) === '新答')
  check('没有可读正文时返回空串（不编造摘要）',
    bundle.answerSummary([{ role: 'assistant' }]) === '' && bundle.answerSummary([]) === '')
  check('assistant 标记嵌在更深一层也能认出来',
    bundle.answerSummary([{ message: { header: { role: 'assistant' }, body: [{ text: '深处' }] } }]) === '深处')
  check('非数组输入不会抛异常', bundle.answerSummary(null) === '')

  /* ── the title reader ── */
  const listCtx = {
    get(name) {
      if (name !== 'sessions') return undefined
      return { list: { getSnapshot: () => ({ byId: { s1: { title: '登录页优化' } } }) } }
    },
  }
  check('会话标题取自宿主会话列表', bundle.sessionTitleOf('s1', listCtx) === '登录页优化')
  check('没有标题的会话返回 null（调用方回落而非显示空标题）',
    bundle.sessionTitleOf('unknown', listCtx) === null && bundle.sessionTitleOf('s1', null) === null)

  /* ── the status subscription ── */
  const fetchCalls = []
  const wired = loadClientBundle(async (url, init) => {
    const action = String(url).slice(String(url).lastIndexOf('/') + 1)
    fetchCalls.push({ action, body: JSON.parse(init.body) })
    return new Response(JSON.stringify(action === 'state' ? STATE : { ok: true, value: { sent: true } }), { status: 200 })
  })
  await wired.settingsStore.load(true)
  const handlers = []
  let disposed = false
  const remoteService = {
    $on: (type, handler) => {
      handlers.push({ type, handler })
      return () => {
        disposed = true
      }
    },
  }
  // The shape the real shell hands over: `remote` is not injected by this
  // plugin, so a bare property read throws and only `ctx.get` answers. Reading
  // the property first is what turned the watcher into a silent no-op.
  const cordisCtx = new Proxy(
    { get: (name) => (name === 'remote' ? remoteService : undefined) },
    {
      get(target, prop, receiver) {
        if (prop === 'remote') throw new Error('cannot get property "remote" without inject')
        return Reflect.get(target, prop, receiver)
      },
    },
  )
  const dispose = wired.watchCompletions(cordisCtx)
  check('订阅的是宿主会话状态通道（裸读会抛错也照样订阅成功）',
    handlers.length === 1 && handlers[0].type === 'api-session/status',
    JSON.stringify(handlers.map((row) => row.type)))
  check('client 侧 serviceOf 优先 ctx.get，裸读抛错时仍拿得到服务',
    wired.serviceOf(cordisCtx, 'remote') === remoteService)
  handlers[0].handler('s1', false)
  await new Promise((resolve) => setTimeout(resolve, 0))
  check('会话首次为 false 是初始态，不当作完成', fetchCalls.filter((row) => row.action === 'notify').length === 0)
  handlers[0].handler('s1', true)
  handlers[0].handler('s1', false)
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  const notified = fetchCalls.filter((row) => row.action === 'notify')
  check('running → idle 的跳变发一次通知，并带上会话标题',
    notified.length === 1 && notified[0].body.sessionId === 's1',
    JSON.stringify(fetchCalls.map((row) => row.action)))
  handlers[0].handler('s1', false)
  await new Promise((resolve) => setTimeout(resolve, 0))
  check('idle → idle 不重复通知', fetchCalls.filter((row) => row.action === 'notify').length === 1)
  check('返回的 disposer 就是 remote 给的取消订阅', typeof dispose === 'function')
  dispose()
  check('disposer 已转交', disposed === true)
  check('没有 remote 服务时静默降级、不抛',
    typeof wired.watchCompletions({}) === 'function' && typeof wired.watchCompletions(null) === 'function')

  /* ── the settings tabs render their controls ── */
  const renderPage = mountClient(bundle, bundle.SettingsPanel)
  let page = renderPage({ close() {} })
  const clickTab = (tree, id) => {
    findAll(tree, (node) => node.props?.id === `dspo-tab-${id}`)[0].props.onClick()
    return renderPage({ close() {} })
  }
  page = clickTab(page, 'compaction')
  // The window lookup is adapter I/O and therefore async; the tab paints a
  // loading line first and fills the rows when the host answers.
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  page = renderPage({ close() {} })
  const compactionPanel = findAll(page, (node) => node.props?.id === 'dspo-panel-compaction')[0]
  const thresholdInputs = findAll(compactionPanel, (node) => node.type === 'input' && node.props.type === 'number')
  check('压缩页签渲染出每个模型的阈值输入与两个动作按钮',
    thresholdInputs.length === 1
      && thresholdInputs[0].props.value === '250000'
      && buttonsOf(compactionPanel).some((button) => labelOf(button).includes('保存阈值'))
      && buttonsOf(compactionPanel).some((button) => labelOf(button).includes('写入 DSH 配置')),
    `${thresholdInputs.length} input(s), ${buttonsOf(compactionPanel).map(labelOf).join('|')}`)
  check('无 configEditor 时写入按钮禁用并说明原因',
    buttonsOf(compactionPanel).find((button) => labelOf(button).includes('写入 DSH 配置')).props.disabled === true
      && textOf(compactionPanel).includes('配置编辑器'))

  page = clickTab(page, 'notify')
  const notifyPanel = findAll(page, (node) => node.props?.id === 'dspo-panel-notify')[0]
  const notifyToggle = findAll(notifyPanel, (node) => node.props?.id === 'dspo-notify')[0]
  check('通知页签渲染出总开关，且初值来自设置',
    notifyToggle !== undefined && notifyToggle.props.type === 'checkbox' && notifyToggle.props.checked === true)
  check('通知页签显示本机派发方式与测试按钮',
    buttonsOf(notifyPanel).some((button) => labelOf(button).includes('发送测试通知')))
  bundle.__restore()
}

/* ───────────────────────── report ───────────────────────── */

rmSync(process.env.DSH_HOME, { recursive: true, force: true })

const total = passed + failures.length
process.stdout.write(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}  ${passed}/${total} checks\n`)
for (const failure of failures) process.stdout.write(`  ✗ ${failure}\n`)
process.exit(failures.length === 0 ? 0 : 1)

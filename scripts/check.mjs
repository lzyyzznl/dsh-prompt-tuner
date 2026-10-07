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
check('恰好 5 个字面 slots.register（预检按字面读取）', registers.length === 5, registers.join(','))
check(
  '注册座位 = 工具行×2 + 输入卡浮层 + composer dock + 设置页',
  registers.includes('conversation.input.left')
    && registers.includes('conversation.input.overlay')
    && registers.includes('conversation.input.dock')
    && registers.includes('settings.section'),
  registers.join(','),
)
check('每个注册都带 id 与 order', (clientSource.match(/slots\.register\(\{[^}]*id: ID[^}]*order:/g) ?? []).length === 5)
check('侧问座位用 session 作用域（浮层在输入卡内，拿得到 useChat）', clientSource.includes("const OVERLAY_SLOT = 'conversation.input.overlay'"))
// A list slot rejects a second entry under an id it already holds, and that
// rejection fails activation — so the two composer-row entries must not share one.
const seatIds = [...clientSource.matchAll(/slots\.register\(\{\s*name:\s*'([^']+)',\s*id:\s*([^,]+),/g)].map((m) => `${m[1]}|${m[2].trim()}`)
check('同一座位内没有重复的注册 id', new Set(seatIds).size === seatIds.length, seatIds.join(' '))
check('无 execCommand（不碰编辑器 DOM 内部）', !clientSource.includes('execCommand'))
check('无 textarea.value 直接写值', !/\.value\s*=/.test(clientSource))
check('草稿唯一写入口是 inputActions.setDraft', (clientSource.match(/setDraft\?\.\(/g) ?? []).length >= 3)
check('client 路由前缀与 host 一致', clientSource.includes("const ROUTE = 'dsh-prompt-optimizer/'") && routeSource.includes("export const ROUTE_PREFIX = '/dsh-prompt-optimizer'"))
check('client 读草稿芯片（occurrences）以守卫整稿替换', clientSource.includes('state.occurrences'))
check('client 读 draftRev 实现「只在草稿未变时自动替换」', clientSource.includes('state.draftRev'))

const cssText = /const CSS = `([\s\S]*?)`\n/.exec(clientSource)?.[1] ?? ''
check('CSS 无字面色值（只用主题 token）', !/#[0-9a-fA-F]{3,8}\b/.test(cssText) && !/\brgba?\(/.test(cssText))
check('CSS 定义了卡片 / 面板 / 设置页三组类', ['dspo-btn', 'dspo-card', 'dspo-set'].every((name) => cssText.includes(`.${name}`)))

/* ───────────────────────── 2. prompt + store ───────────────────────── */

const prompt = await import('../lib/prompt.js')
const store = await import('../lib/store.js')

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
      resolveModelInfo: async () => (options.reasoning === undefined
        ? { reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }], defaultEffort: 'high' } }
        : options.reasoning),
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
  check('/state 带旁路提问契约（档位、上限、历史文件、提示词）', Array.isArray(state.value.btw?.contextTurnChoices)
    && state.value.btw.maxQuestionChars > 0
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
  // Whole-session context: nothing is dropped by count, at either end.
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
  const overLong = await call(ctx, '/btw', { question: '问题', context: 'x'.repeat(prompt.MAX_BTW_CONTEXT_CHARS + 1) })
  check('/btw 超长上下文响亮拒绝而不是静默截断', overLong.json?.error?.code === 'bad-request'
    && String(overLong.json.error.message).includes('携带上下文')
    && ctx.calls.length === 1)
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

/* ───────────────────────── 4. browser half ───────────────────────── */

section('4. 浏览器半区')

/** Just enough React to execute a component function once and walk its tree. */
function makeReact() {
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat().filter((child) => child !== null && child !== undefined && child !== false) }
    },
    useState(initial) {
      const value = typeof initial === 'function' ? initial() : initial
      return [value, () => {}]
    },
    useEffect(effect) {
      try {
        effect()
      } catch {
        /* effects are exercised for their registration side effects only */
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
  globalThis.document = { querySelector: () => null, createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }), head: { appendChild() {} } }
  // eslint-disable-next-line no-new-func
  new Function('window', clientSource)(windowStub)
  const React = makeReact()
  const bundle = captured.factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected module: ${id}`)
  })
  bundle.__restore = () => {
    globalThis.fetch = previousFetch
    globalThis.window = previousWindow
  }
  return bundle
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
      maxContextChars: prompt.MAX_BTW_CONTEXT_CHARS,
      historyFile: store.BTW_HISTORY_FILE,
      prompt: prompt.BTW_SYSTEM_PROMPT,
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
function makeInput(initial = {}, chatNodes = []) {
  const state = { draft: '', phase: 'plain', draftRev: 1, occurrences: [], ...initial }
  const writes = []
  return {
    state,
    writes,
    props: {
      sessionId: 'session-a',
      useInput: (selector) => (selector === undefined ? state : selector(state)),
      useChat: (selector) => selector({ legacy: { nodes: chatNodes } }),
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
  // Settings page surface.
  const fetchImpl = makeFetch()
  const bundle = loadClientBundle(fetchImpl)
  await bundle.settingsStore.load(true)
  const page = bundle.SettingsPanel({ close() {} })
  const text = textOf(page)
  check('设置页含模型 / 强度 / 档位 / 应用方式 / 路由 / 提示词', ['优化模型', '思考强度', '默认档位', '改写完成后', '改写方式', '自定义优化提示词'].every((label) => text.includes(label)))
  check('设置页提供「跟随当前会话的模型」开关', text.includes('跟随当前会话的模型'))
  check('设置页提供快捷键开关', text.includes('Alt+O'))
  const selects = findAll(page, (node) => node.type === 'select')
  check('设置页渲染出多个下拉', selects.length >= 4, String(selects.length))
  check('思考强度下拉列出适配器自报的档位', selects.some((select) => (select.children ?? []).length === 3))
  const textarea = findAll(page, (node) => node.type === 'textarea')[0]
  check('自定义提示词框留空（不预填默认）', textarea !== undefined && textarea.props.value === '')
  check('设置页可展开查看内置默认', textOf(page).includes('查看内置默认提示词'))
  check('设置页的上下文下拉默认选中「全部历史消息」', textOf(page).includes('全部历史消息')
    && (findAll(page, (node) => node.type === 'select').some((select) => select.props.value === 'all')))
  bundle.__restore()
}

/* ── 旁路提问（浏览器半区） ── */

/** One conversation node in the shape the chat snapshot publishes. */
const userNode = (text) => ({ kind: 'user', seq: 1, time: 1, content: [{ type: 'text', text }] })
const assistantNode = (text) => ({ kind: 'assistant', seq: 2, time: 2, turns: 1, blocks: [{ kind: 'text', text }], turn: 1, step: 1 })

{
  // The context reducer is pure, so it is checked without a component.
  const bundle = loadClientBundle(makeFetch())
  const nodes = [
    userNode('把登录页改快一点'),
    assistantNode('好的，先看首屏加载'),
    { kind: 'tool', seq: 3, time: 3 }, // tool rows never travel
    { kind: 'context', seq: 4, time: 4, content: [{ type: 'text', text: '系统注入' }] },
    userNode('那用懒加载'),
  ]
  const carried = bundle.btwContext(nodes, 8)
  check('上下文带用户与助手文本', carried.text.includes('用户：把登录页改快一点') && carried.text.includes('助手：好的，先看首屏加载'))
  check('上下文丢掉工具行与系统注入', !carried.text.includes('系统注入') && !carried.text.includes('tool'))
  check('上下文按条数截取最近的消息', bundle.btwContext(nodes, 2).text.includes('那用懒加载') && !bundle.btwContext(nodes, 2).text.includes('把登录页改快一点') && bundle.btwContext(nodes, 2).messages === 2)
  check('档位 0 时完全不读会话', bundle.btwContext(nodes, 0).text === '' && bundle.btwContext(nodes, 0).messages === 0)
  check('空记录不会报错', bundle.btwContext(undefined, 8).text === '')
  // The default setting: everything, with no count cap and no character trimming.
  const all = bundle.btwContext(nodes, 'all')
  check('「全部历史」把这条会话的消息全部带上', all.messages === 3
    && all.text.includes('用户：把登录页改快一点')
    && all.text.includes('助手：好的，先看首屏加载')
    && all.text.includes('用户：那用懒加载'))
  const many = []
  for (let index = 0; index < 120; index += 1) {
    many.push(index % 2 === 0 ? userNode(`第 ${index} 条`) : assistantNode(`第 ${index} 条`))
  }
  many.push(assistantNode('长'.repeat(20_000)))
  const everything = bundle.btwContext(many, 'all')
  check('「全部历史」不按条数截断（120 条全在）', everything.messages === 121 && everything.text.includes('第 0 条'))
  check('「全部历史」单条也不做字符截断', everything.text.includes('长'.repeat(20_000)))
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
  check('打开后是浮层卡片而不是模态', panel !== null && panel.props.className === 'dspo-btw')
  check('面板说明答案不会进入主对话', textOf(panel).includes('不写进主对话'))
  check('读不到会话记录时明说，而不是假装带了上下文', textOf(panel).includes('读不到会话记录'))
  bundle.__restore()
}

{
  const fetchImpl = makeFetch()
  const bundle = loadClientBundle(fetchImpl)
  await bundle.settingsStore.load(true)
  const input = makeInput({}, [userNode('把登录页改快一点'), assistantNode('好的')])
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
  check('问题发出后输入框被清空（避免重复提交）', session.draft === '')
  const answerSaved = fetchImpl.seen.find((entry) => entry.action === 'btw.save')
  check('答案落进旁路历史', answerSaved?.body?.answer === '旁路答案' && answerSaved.body.question === '登录页改了吗？')
  check('采用宿主回传的话题 id', session.topicId === 'topic-1' && session.topics.length === 1)
  check('面板显示「全部历史」的条数', textOf(bundle.BtwPanel(input.props)).includes('已带全部 2 条会话消息'))
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
  check('收窄到最近 N 条时如实标注条数', text.includes('已带最近 4 条会话消息') && !text.includes('已带全部'))
  bundle.patchBtw('session-a', { draft: '只看最近几条' })
  const asking = bundle.BtwPanel(input.props)
  buttonsOf(asking).find((candidate) => labelOf(candidate).trim() === '提问').props.onClick()
  const started = Date.now()
  while (bundle.readBtw('session-a').phase === 'asking' && Date.now() - started < 4000) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const request = fetchImpl.seen.find((entry) => entry.action === 'btw.stream')
  check('收窄时只发最近 N 条消息', request?.body?.context.includes('三') && !request.body.context.includes('一'))
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

/* ───────────────────────── report ───────────────────────── */

rmSync(process.env.DSH_HOME, { recursive: true, force: true })

const total = passed + failures.length
process.stdout.write(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}  ${passed}/${total} checks\n`)
for (const failure of failures) process.stdout.write(`  ✗ ${failure}\n`)
process.exit(failures.length === 0 ? 0 : 1)

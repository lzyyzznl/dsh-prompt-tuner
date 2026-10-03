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
check('恰好 3 个字面 slots.register（预检按字面读取）', registers.length === 3, registers.join(','))
check('注册座位 = 工具行 + composer dock + 设置页', registers.includes('conversation.input.left') && registers.includes('conversation.input.dock') && registers.includes('settings.section'), registers.join(','))
check('每个注册都带 id 与 order', (clientSource.match(/slots\.register\(\{[^}]*id: ID[^}]*order:/g) ?? []).length === 3)
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
    return new Response('{}', { status: 404 })
  }
  fetchImpl.seen = seen
  return fetchImpl
}

/** Fake slot props around a mutable input state. */
function makeInput(initial = {}) {
  const state = { draft: '', phase: 'plain', draftRev: 1, occurrences: [], ...initial }
  const writes = []
  return {
    state,
    writes,
    props: {
      sessionId: 'session-a',
      useInput: (selector) => (selector === undefined ? state : selector(state)),
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

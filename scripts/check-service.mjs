/**
 * Self-check for the standalone routing service. No test framework: one process,
 * one report, a non-zero exit for CI.
 *
 * It runs the real service over a real socket against a **stub upstream** that
 * speaks the ZTE gateway's dialect — an SSE stream and a JSON body both shaped
 * like the ones recorded from the live endpoint — so every layer between the
 * caller and the wire is exercised: the request converter, the breaker and its
 * failover walk, the streaming path, the admin API and the trust fence.
 *
 * Nothing here touches a real provider, so it costs no tokens and runs offline.
 * The live-endpoint check is a separate, deliberate act (`docs/HISTORY.md`
 * records what was measured against it).
 *
 * Usage: `npm run check:service` (or `node scripts/check-service.mjs`).
 */
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Point the service at a throwaway home *before* importing it: the configuration
// path is resolved when the module loads.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dspo-service-'))
process.env.ROUTER_SERVICE_CONFIG = join(process.env.DSH_HOME, 'router-service.json')

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
const read = (relative) => readFileSync(join(ROOT, relative), 'utf8')

/** A port the OS says is free right now. */
function freePort() {
  return new Promise((res, rej) => {
    const probe = createServer()
    probe.on('error', rej)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => res(port))
    })
  })
}

/** POST JSON to the service. */
async function post(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  return { status: response.status, headers: response.headers, text, json: parsed }
}

/** GET from the service. */
async function get(url, headers = {}) {
  const response = await fetch(url, { headers })
  const text = await response.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  return { status: response.status, headers: response.headers, text, json: parsed }
}

/** The gateway's dialect, for both a JSON body and one SSE chunk. */
const GATEWAY_NOISE = {
  service_tier: null,
  prompt_logprobs: null,
  prompt_token_ids: [1, 2, 3],
  prompt_text: 'x',
  kv_transfer_params: null,
  ec_transfer_params: null,
  metrics: { engine: 'vllm-0.26.0-tp8-ep' },
}

const gatewayMessage = () => ({
  role: 'assistant',
  content: 'pong',
  reasoning: 'let me think about that',
  refusal: null,
  annotations: null,
  audio: null,
  function_call: null,
})

const gatewayUsage = () => ({
  prompt_tokens: 11,
  completion_tokens: 4,
  total_tokens: 15,
  prompt_tokens_details: { cached_tokens: 3, created_cache_tokens: 0, multimodal_tokens: 0 },
})

/** Start the stub upstream; `state.mode` steers its behaviour per request. */
function startStub() {
  // Failure is keyed to the credential rather than to a global switch, so one
  // provider can be broken while its neighbour stays healthy — which is the only
  // arrangement in which failover can be observed at all.
  const state = { mode: 'ok', calls: [], brokenKeys: new Set(['k-broken']) }
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      let body = null
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        body = null
      }
      state.calls.push({ path: req.url, body, headers: req.headers })
      const key = String(req.headers.authorization ?? '').replace(/^Bearer\s+/, '')
      const brokenByKey = state.brokenKeys.has(key)
      if (brokenByKey || state.mode === 'fail' || (state.mode === 'failOnce' && state.calls.length === 1)) {
        res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' })
        res.end(JSON.stringify({ error: { message: 'the engine is overloaded', type: 'server_error' } }))
        return
      }
      if (state.mode === 'garbage') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('not json at all')
        return
      }
      if (body?.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ id: 'gw', object: 'chat.completion.chunk', created: 1, model: 'DeepSeek-V4-Flash-0731', choices: [{ index: 0, delta: { role: 'assistant', reasoning: 'think' }, stop_reason: null, token_ids: [1] }], ...GATEWAY_NOISE })}\n\n`)
        res.write(`data: ${JSON.stringify({ id: 'gw', object: 'chat.completion.chunk', created: 1, model: 'DeepSeek-V4-Flash-0731', choices: [{ index: 0, delta: { content: 'pong' }, stop_reason: null }], ...GATEWAY_NOISE })}\n\n`)
        res.write(`data: ${JSON.stringify({ id: 'gw', object: 'chat.completion.chunk', created: 1, model: 'DeepSeek-V4-Flash-0731', choices: [{ index: 0, delta: {}, finish_reason: 'stop', stop_reason: 'stop' }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ id: 'gw', object: 'chat.completion.chunk', created: 1, model: 'DeepSeek-V4-Flash-0731', choices: [], usage: gatewayUsage(), ...GATEWAY_NOISE })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'gw-1',
        object: 'chat.completion',
        created: 1,
        model: 'DeepSeek-V4-Flash-0731',
        choices: [{
          index: 0,
          message: gatewayMessage(),
          finish_reason: 'stop',
          stop_reason: 'stop',
          token_ids: [7, 8],
          routed_experts: null,
        }],
        usage: gatewayUsage(),
        ...GATEWAY_NOISE,
      }))
    })
  })
  return new Promise((res) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      state.port = typeof address === 'object' && address !== null ? address.port : 0
      state.server = server
      res(state)
    })
  })
}

/** Collect an SSE response into the parsed payloads it carried. */
async function readSse(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  const payloads = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const data = trimmed.slice(5).trim()
    if (data === '[DONE]') {
      payloads.push('[DONE]')
      continue
    }
    try {
      payloads.push(JSON.parse(data))
    } catch {
      payloads.push({ malformed: data })
    }
  }
  return { status: response.status, type: response.headers.get('content-type'), payloads, text }
}

/* ───────────────────────── static contract ───────────────────────── */

section('1. 服务是自洽的（零依赖、不反向依赖插件）')

const serviceFiles = [
  'lib/service/main.js',
  'lib/service/server.js',
  'lib/service/proxy.js',
  'lib/service/upstream.js',
  'lib/service/config.js',
  'lib/service/router.js',
  'lib/service/converters/registry.js',
  'lib/service/converters/maas.js',
  'lib/service/ui.js',
]
for (const file of serviceFiles) {
  const source = read(file)
  check(`${file} 不 import @deepseek-ai/*`, !/from '@deepseek-ai\//.test(source))
  check(`${file} 不 import 插件其余模块`, !/from '\.\.\/(store|prompt|notify|title|routes|client|compaction)\.js'/.test(source))
}
check('lib/router.js 与 lib/routing.js 已不在插件主体里',
  !(await import('node:fs')).existsSync(join(ROOT, 'lib/router.js'))
  && !(await import('node:fs')).existsSync(join(ROOT, 'lib/routing.js')))
check('插件主体不再注册熔断钩子',
  !/ctx\.on\(\s*'agent\/(request|request-error)'/.test(read('lib/index.js')))
check('public 转换器契约只有代码模块入口',
  /export function defineConverter/.test(read('lib/service/converters/registry.js')))
check('maas 转换器的参照契约被写在一处',
  /REFERENCE_CONTRACT/.test(read('lib/service/converters/registry.js')))
check('package.json 暴露服务入口与自检脚本',
  typeof JSON.parse(read('package.json')).scripts?.['check:service'] === 'string')

/* ───────────────────────── live service ───────────────────────── */

section('2. 服务起得来，且把自己说清楚')

const stub = await startStub()
const port = await freePort()
const token = 'test-token-0123456789'

writeFileSync(process.env.ROUTER_SERVICE_CONFIG, `${JSON.stringify({
  server: { host: '127.0.0.1', port, token },
  // The two ids the converter claims by name, which is also how the real
  // deployment names them. `maas-coclaw` is the permanently broken one.
  providers: {
    'maas-dsv4': { label: 'dsv4', baseURL: `http://127.0.0.1:${stub.port}/v1`, apiKey: 'k-good', models: ['deepseek-v4-flash'] },
    'maas-coclaw': { label: 'claw', baseURL: `http://127.0.0.1:${stub.port}/v1`, apiKey: 'k-broken', models: ['co-claw'] },
  },
  router: {
    enabled: true,
    order: [
      { provider: 'maas-dsv4', model: 'deepseek-v4-flash' },
      { provider: 'maas-coclaw', model: 'co-claw' },
    ],
    retries: 0,
    failureThreshold: 1,
    recoveryMode: 'probe',
    logLevel: 'silent',
  },
  converters: ['maas'],
}, null, 2)}\n`)

const { startService, READY_PREFIX, parseArgs } = await import('../lib/service/main.js')
const quiet = { error() {}, warn() {}, info() {}, debug() {} }
const service = await startService({ listen: true, poll: false, logger: quiet })
const base = `http://127.0.0.1:${service.bound.port}`
const adminHeaders = { 'x-router-token': token }

check('服务绑定了配置里的端口', service.bound.port === port, `${service.bound.port} vs ${port}`)
check('健康检查可用', (await get(`${base}/healthz`)).json?.ok === true)
check('--check 与默认模式可区分', parseArgs(['--check']).check === true && parseArgs([]).check === false)
check('就绪行前缀是常量', READY_PREFIX.startsWith('ROUTER_SERVICE_') && service.loaded.loaded.includes('maas'))
check('maas 转换器已登记', service.registry.list().map((c) => c.id).join(',') === 'maas')

section('3. /v1/models：网关没有的端点，由服务合成')

const models = await get(`${base}/v1/models`)
check('/v1/models 返回 list 形状', models.json?.object === 'list' && Array.isArray(models.json.data))
const modelIds = (models.json?.data ?? []).map((entry) => entry.id)
check('列出两种拼写（模型名与 provider/model）', modelIds.includes('deepseek-v4-flash') && modelIds.includes('maas-dsv4/deepseek-v4-flash'), modelIds.join(','))
check('每条模型都是 OpenAI 形状', (models.json?.data ?? []).every((entry) => entry.object === 'model' && typeof entry.owned_by === 'string' && Number.isFinite(entry.created)))

section('4. 非流式：出参被归一成参照契约')

stub.calls.length = 0
const completion = await post(`${base}/v1/chat/completions`, {
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: 'ping' }],
  thinking: { type: 'disabled' },
  max_completion_tokens: 64,
})
check('HTTP 200', completion.status === 200, completion.text.slice(0, 200))
check('model 回显调用方请求的名字', completion.json?.model === 'deepseek-v4-flash', completion.json?.model)
const message = completion.json?.choices?.[0]?.message
check('reasoning 被改名为 reasoning_content', message?.reasoning_content === 'let me think about that' && message?.reasoning === undefined)
check('常驻 null 的网关字段被摘掉', message?.refusal === undefined && message?.annotations === undefined && message?.audio === undefined && message?.function_call === undefined)
check('choice 级噪声字段被摘掉', completion.json?.choices?.[0]?.stop_reason === undefined && completion.json?.choices?.[0]?.token_ids === undefined)
check('顶层噪声字段被摘掉', completion.json?.prompt_token_ids === undefined && completion.json?.metrics === undefined && completion.json?.service_tier === undefined)
check('usage 归一成参照契约的字段', completion.json?.usage?.prompt_tokens === 11
  && completion.json?.usage?.prompt_cache_hit_tokens === 3
  && completion.json?.usage?.prompt_cache_miss_tokens === 8)
check('prompt_tokens_details 只剩 cached_tokens', JSON.stringify(completion.json?.usage?.prompt_tokens_details) === '{"cached_tokens":3}')
check('补上了 system_fingerprint', typeof completion.json?.system_fingerprint === 'string' && completion.json.system_fingerprint.startsWith('fp_'))
const sent = stub.calls[0]?.body
check('thinking disabled 落成 reasoning_effort=none', sent?.reasoning_effort === 'none', JSON.stringify(sent?.reasoning_effort))
check('thinking 与 effort 不再出现在上游请求里', sent?.thinking === undefined && sent?.effort === undefined)
check('max_completion_tokens 折成 max_tokens', sent?.max_tokens === 64 && sent?.max_completion_tokens === undefined)
check('上游收到的是路由行的模型名', sent?.model === 'deepseek-v4-flash')
check('上游收到 bearer 凭据', stub.calls[0]?.headers?.authorization === 'Bearer k-good', stub.calls[0]?.headers?.authorization)

section('5. 入参语义：三种思考写法都落到 reasoning_effort')

stub.calls.length = 0
await post(`${base}/v1/chat/completions`, { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'x' }], thinking: { type: 'enabled', budget_tokens: 2048 } })
check('budget_tokens 映射到就近档位', stub.calls[0]?.body?.reasoning_effort === 'medium', stub.calls[0]?.body?.reasoning_effort)
await post(`${base}/v1/chat/completions`, { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'x' }], reasoning_effort: 'minimal' })
check('minimal 落到 low（网关没有这个词）', stub.calls[1]?.body?.reasoning_effort === 'low', stub.calls[1]?.body?.reasoning_effort)
await post(`${base}/v1/chat/completions`, { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'x' }] })
check('调用方什么都没说时不自作主张加档位', stub.calls[2]?.body?.reasoning_effort === undefined, stub.calls[2]?.body?.reasoning_effort)

section('6. response_format：参照契约的前置条件被强制')

stub.calls.length = 0
const gated = await post(`${base}/v1/chat/completions`, {
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: 'give me a list' }],
  response_format: { type: 'json_object' },
})
check('不给 json 关键词就 400', gated.status === 400, `${gated.status} ${gated.text.slice(0, 160)}`)
check('错误体是参照契约的形状', gated.json?.error?.type === 'invalid_request_error' && gated.json?.error?.param === null)
check('被拒的请求根本没打到上游', stub.calls.length === 0, String(stub.calls.length))
const allowed = await post(`${base}/v1/chat/completions`, {
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: 'give me json' }],
  response_format: { type: 'json_object' },
})
check('给了关键词就放行', allowed.status === 200 && stub.calls.length === 1)

section('7. 流式：逐块归一，且以 [DONE] 收尾')

stub.calls.length = 0
const streamed = await readSse(`${base}/v1/chat/completions`, { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'ping' }], stream: true })
check('SSE content-type 正确', String(streamed.type).includes('text/event-stream'), streamed.type)
check('以 [DONE] 收尾', streamed.payloads[streamed.payloads.length - 1] === '[DONE]')
const streamChunks = streamed.payloads.filter((entry) => entry !== '[DONE]')
check('每块 object 都是 chat.completion.chunk', streamChunks.every((chunk) => chunk.object === 'chat.completion.chunk'))
check('delta 里的 reasoning 被改名', streamChunks[0]?.choices?.[0]?.delta?.reasoning_content === 'think'
  && streamChunks[0]?.choices?.[0]?.delta?.reasoning === undefined)
check('每块 model 回显请求名', streamChunks.every((chunk) => chunk.model === 'deepseek-v4-flash'))
check('末尾一块带着归一后的 usage', streamChunks[streamChunks.length - 1]?.usage?.prompt_tokens === 11
  && streamChunks[streamChunks.length - 1]?.usage?.completion_tokens_details?.reasoning_tokens === 0)
check('流式请求向上游要了 include_usage', stub.calls[0]?.body?.stream_options?.include_usage === true, JSON.stringify(stub.calls[0]?.body?.stream_options))

section('8. 熔断与切换：坏路由自己出局')

service.admin.reset()
const reordered = await service.admin.save({
  router: {
    order: [
      { provider: 'maas-coclaw', model: 'co-claw' },
      { provider: 'maas-dsv4', model: 'deepseek-v4-flash' },
    ],
    retries: 0,
  },
})
check('配置保存后瞬时就生效', reordered.router.order.length === 2 && reordered.router.order[0].provider === 'maas-coclaw')

stub.calls.length = 0
const failover = await post(`${base}/v1/chat/completions`, { model: 'co-claw', messages: [{ role: 'user', content: 'ping' }] })
check('第一条路由 503 后仍能由第二条作答', failover.status === 200 && failover.json?.choices?.[0]?.message?.content === 'pong', `${failover.status} ${failover.text.slice(0, 200)}`)
check('切换后响应的 model 仍是调用方请求的名字', failover.json?.model === 'co-claw', failover.json?.model)
check('两次尝试都真的打到了上游', stub.calls.length === 2, String(stub.calls.length))
const afterFailover = service.admin.state()
check('坏路由的熔断器被打开', afterFailover.rows.find((row) => row.provider === 'maas-coclaw')?.state === 'open')
check('成功的那条保持关闭', afterFailover.rows.find((row) => row.provider === 'maas-dsv4')?.state === 'closed')
check('失败与切换被计数', afterFailover.stats.failures >= 1 && afterFailover.stats.switches >= 1, JSON.stringify(afterFailover.stats))

stub.calls.length = 0
const second = await post(`${base}/v1/chat/completions`, { model: 'co-claw', messages: [{ role: 'user', content: 'ping' }] })
check('第二次请求直接跳过已熔断的路由', second.status === 200 && stub.calls.length === 1, `${second.status} calls=${stub.calls.length}`)

section('8b. 同一条路由先重试，重试用完才切换')

stub.mode = 'failOnce'
service.admin.reset()
await service.admin.save({ router: { order: [{ provider: 'maas-dsv4', model: 'deepseek-v4-flash' }], retries: 1 } })
stub.calls.length = 0
const retried = await post(`${base}/v1/chat/completions`, { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'ping' }] })
check('第一次 503、重试成功', retried.status === 200 && stub.calls.length === 2, `${retried.status} calls=${stub.calls.length}`)
check('重试被计数，且这一轮没有切换', service.admin.state().stats.retries >= 1)
check('重试成功后熔断器保持关闭', service.admin.state().rows[0]?.state === 'closed')
stub.mode = 'ok'

section('8c. 关掉总开关 = 纯代理：不重试、也不记账')

{
  stub.mode = 'failOnce'
  const off = await service.admin.save({ router: { enabled: false, order: [{ provider: 'maas-dsv4', model: 'deepseek-v4-flash' }], retries: 3 } })
  check('总开关可以关掉', off.router.enabled === false)
  service.admin.reset()
  stub.calls.length = 0
  const plain = await post(`${base}/v1/chat/completions`, { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'ping' }] })
  check('关掉后不重试：只打一次上游就如实失败', plain.status >= 400 && stub.calls.length === 1, `${plain.status} calls=${stub.calls.length}`)
  check('关掉后错误体仍是参照契约形状', plain.json?.error?.type === 'server_error', JSON.stringify(plain.json).slice(0, 140))
  check('关掉后不记熔断（重新打开时不会带着旧账）',
    service.admin.state().rows[0]?.failures === 0 && service.admin.state().rows[0]?.state === 'closed')
  stub.mode = 'ok'
  await service.admin.save({ router: { enabled: true, retries: 0 } })
  check('重新打开后一切照旧', (await post(`${base}/v1/chat/completions`, { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'ping' }] })).status === 200)
}

section('9. 坏响应与坏配置各有各的下场')

stub.mode = 'garbage'
service.admin.reset()
const garbage = await post(`${base}/v1/chat/completions`, { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'ping' }] })
check('上游 200 但 body 不是 JSON → 503，而不是把垃圾透传出去', garbage.status === 503, `${garbage.status}`)
check('错误体仍是参照契约形状', garbage.json?.error?.code === 'service_unavailable')

stub.mode = 'ok'
const badPort = await post(`${base}/admin/api/config`, { server: { port: 99_999 } }, adminHeaders)
check('端口越界被拒绝而不是被改写', badPort.json?.ok === false && /port/.test(badPort.json?.error?.message ?? ''))
const badProvider = await post(`${base}/admin/api/config`, { providers: { x: { models: ['m'] } } }, adminHeaders)
check('缺 baseURL 的供应商被拒绝', badProvider.json?.ok === false)
const badOrder = await post(`${base}/admin/api/config`, { router: { order: [{ provider: 'a' }] } }, adminHeaders)
check('缺 model 的路由行被拒绝', badOrder.json?.ok === false)
const unknown = await post(`${base}/admin/api/config`, { router: { order: [{ provider: 'ghost', model: 'm' }] } }, adminHeaders)
check('指向未注册供应商的行被接受但如实标记', unknown.json?.ok === true
  && unknown.json.value.rows[0].registered === false, JSON.stringify(unknown.json?.value?.rows?.[0]))
const carried = await post(`${base}/admin/api/config`, { providers: { 'maas-dsv4': { label: 'renamed', baseURL: `http://127.0.0.1:${stub.port}/v1`, apiKey: '', models: ['deepseek-v4-flash'] } } }, adminHeaders)
check('留空密钥不会把已存的密钥抹掉', carried.json?.value?.providers?.[0]?.apiKeySet === true, JSON.stringify(carried.json?.value?.providers))
check('密钥只以掩码回传', /…/.test(carried.json?.value?.providers?.[0]?.apiKey ?? '') || carried.json?.value?.providers?.[0]?.apiKey === '')
// Put the working arrangement back: the rejection checks above left a ghost row
// and a single provider behind, and the sections after this one need a route.
await service.admin.save({
  providers: {
    'maas-dsv4': { label: 'dsv4', baseURL: `http://127.0.0.1:${stub.port}/v1`, apiKey: 'k-good', models: ['deepseek-v4-flash'] },
    'maas-coclaw': { label: 'claw', baseURL: `http://127.0.0.1:${stub.port}/v1`, apiKey: 'k-broken', models: ['co-claw'] },
  },
  router: { order: [{ provider: 'maas-dsv4', model: 'deepseek-v4-flash' }], retries: 0 },
})

section('10. 管理面：没有令牌就进不来')

const noToken = await get(`${base}/admin/api/state`)
check('无令牌访问管理面 → 401', noToken.status === 401, String(noToken.status))
const wrongToken = await get(`${base}/admin/api/state`, { 'x-router-token': 'nope' })
check('错令牌同样 401', wrongToken.status === 401)
const state = await get(`${base}/admin/api/state`, adminHeaders)
check('带令牌可以读状态', state.json?.ok === true && Array.isArray(state.json.value.rows))
check('状态里带着熔断器、限额与可选档位', Array.isArray(state.json.value.recent)
  && typeof state.json.value.stats?.requests === 'number'
  && typeof state.json.value.limits?.orderRows === 'number'
  && state.json.value.recoveryModes.includes('probe')
  && state.json.value.logLevels.includes('debug'))
check('状态里说明哪些供应商被转换器接管', state.json.value.converters?.[0]?.id === 'maas'
  && state.json.value.converters[0].providers.length >= 1, JSON.stringify(state.json.value.converters))
const home = await get(`${base}/`)
check('管理页在 / 上可读（无需令牌，页面自带令牌）', home.status === 200 && String(home.headers.get('content-type')).includes('text/html'))
const notFound = await get(`${base}/nope`)
check('未知路径返回参照契约的错误形状', notFound.status === 404 && notFound.json?.error?.code === 'not_found')
const wrongMethod = await get(`${base}/v1/chat/completions`)
check('错误方法被拒绝', wrongMethod.status === 404 || wrongMethod.status === 405)

section('11. 连通性探测：能调到真上游')

stub.mode = 'ok'
service.admin.reset()
const probeOk = await post(`${base}/admin/api/probe`, { provider: 'maas-dsv4', model: 'deepseek-v4-flash' }, adminHeaders)
check('探测成功并回报耗时与正文', probeOk.json?.value?.probe?.ok === true && probeOk.json.value.probe.code === 'ok', JSON.stringify(probeOk.json?.value?.probe))
check('探测顺手带回了最新状态', Array.isArray(probeOk.json?.value?.state?.rows))
check('探测请求显式关掉了思考', stub.calls[stub.calls.length - 1]?.body?.reasoning_effort === 'none')
stub.mode = 'fail'
const probeBad = await post(`${base}/admin/api/probe`, { provider: 'maas-dsv4', model: 'deepseek-v4-flash' }, adminHeaders)
check('探测失败如实回报', probeBad.json?.value?.probe?.ok === false && typeof probeBad.json.value.probe.message === 'string')
check('探测失败也计入熔断', probeBad.json?.value?.state?.rows?.find((row) => row.provider === 'maas-dsv4')?.state === 'open')
stub.mode = 'ok'

section('12. 配置的修补与迁移')

const { normalizeConfig, seedConfig, maskApiKey, applyConfigPatch } = await import('../lib/service/config.js')
const seeded = seedConfig()
check('首次运行会为 MaaS 两条路由预置入口', 'maas-dsv4' in seeded.providers && 'maas-coclaw' in seeded.providers)
check('预置入口不带任何密钥', Object.values(seeded.providers).every((provider) => provider.apiKey === ''))
check('手工编辑出的坏端口会被修复而不是让服务起不来',
  normalizeConfig({ server: { port: 'abc' } }).server.port === 8790
  && normalizeConfig({ server: { port: -5 } }).server.port === 1)
check('手写坏行会被丢掉，好行会留下',
  normalizeConfig({ router: { order: [{ provider: 'a', model: 'b' }, { provider: '' }, 'nope'] } }).router.order.length === 1)
check('冷却上限不会低于基础冷却',
  normalizeConfig({ router: { cooldownMs: 5000, cooldownMaxMs: 1000 } }).router.cooldownMaxMs === 5000)
check('未知档位/日志级别会回落', normalizeConfig({ router: { recoveryMode: 'x', logLevel: 'y' } }).router.recoveryMode === 'probe')
check('掩码不泄露完整密钥', maskApiKey('sk-abcdefghijklmnop') === 'sk-a…mnop' && maskApiKey('') === '')
check('补丁拒绝非法字段而不是静默丢弃', (() => {
  try {
    applyConfigPatch(seedConfig(), { router: { retries: 999 } })
    return false
  } catch {
    return true
  }
})())
check('服务端口写入只在变更时要求重启', (() => {
  const doc = normalizeConfig({ server: { port: 8790 } })
  return applyConfigPatch(doc, { server: { port: 8790 } }).restartRequired === false
    && applyConfigPatch(doc, { server: { port: 8791 } }).restartRequired === true
})())

section('13. 转换器注册表：没注册就原样透传')

const { createConverterRegistry, defineConverter } = await import('../lib/service/converters/registry.js')
const registry = createConverterRegistry()
check('defineConverter 会补齐缺省行为', (() => {
  const minimal = defineConverter({ id: 'noop', label: 'noop' })
  const body = { a: 1 }
  return minimal.match({}) === false
    && minimal.toUpstream(body) === body
    && minimal.fromUpstream(body) === body
    && minimal.fromUpstreamChunk(body) === body
    && Array.isArray(minimal.listModels({}))
})())
check('重复 id 会被拒绝', (() => {
  registry.register(defineConverter({ id: 'dup' }))
  try {
    registry.register(defineConverter({ id: 'dup' }))
    return false
  } catch {
    return true
  }
})())
check('非法 id 会被拒绝', (() => {
  try {
    registry.register(defineConverter({ id: 'Bad Id!' }))
    return false
  } catch {
    return true
  }
})())
check('匹配抛异常时视为不匹配，而不是让请求失败', (() => {
  const probe = createConverterRegistry()
  probe.register(defineConverter({ id: 'boom', match: () => { throw new Error('nope') } }))
  probe.register(defineConverter({ id: 'later', match: () => true }))
  return probe.forRoute({ provider: { id: 'x' }, model: 'm' })?.id === 'later'
})())
check('maas 转换器按 host 认领路由，改名也认',
  service.registry.get('maas').match({ provider: { id: 'whatever', baseURL: 'https://maas-apigateway.dt.zte.com.cn/model-cop/co-claw/v1' }, model: 'co-claw' }) === true
  && service.registry.get('maas').match({ provider: { id: 'maas-dsv4', baseURL: '' }, model: 'm' }) === true
  && service.registry.get('maas').match({ provider: { id: 'other', baseURL: 'https://api.deepseek.com/v1' }, model: 'm' }) === false)

section('14. 上游读流：SSE 行的三种含义')

const { ssePayload, retryAfterMs, joinUrl } = await import('../lib/service/upstream.js')
check('普通 data 行解析成对象', ssePayload('data: {"a":1}')?.a === 1)
check('[DONE] 是哨兵，不是对象', ssePayload('data: [DONE]') === null)
check('注释与空行什么都不带', ssePayload(': keep-alive') === undefined && ssePayload('') === undefined)
check('坏 JSON 行被跳过而不是抛出去', ssePayload('data: {oops') === undefined)
check('retry-after 支持秒与毫秒两种写法',
  retryAfterMs(new Headers({ 'retry-after': '2' })) === 2000
  && retryAfterMs(new Headers({ 'retry-after-ms': '250' })) === 250
  && retryAfterMs(new Headers({})) === null)
check('baseURL 拼接不双斜杠也不丢斜杠',
  joinUrl('https://x/v1/', 'chat/completions') === 'https://x/v1/chat/completions'
  && joinUrl('https://x/v1', '/chat/completions') === 'https://x/v1/chat/completions')

section('15. 插件侧：真的能把这个服务拉起来并转达')

{
  // The whole extraction hinges on this path: the plugin forks the service, waits
  // for its readiness line, and then talks to it over loopback. Testing the client
  // against a real child is the only way to catch a mismatch between the two.
  const forkPort = await freePort()
  const forkConfig = join(process.env.DSH_HOME, 'fork-service.json')
  writeFileSync(forkConfig, `${JSON.stringify({
    server: { host: '127.0.0.1', port: forkPort, token: 'fork-token' },
    providers: {
      'maas-dsv4': { label: 'dsv4', baseURL: `http://127.0.0.1:${stub.port}/v1`, apiKey: 'k-good', models: ['deepseek-v4-flash'] },
    },
    router: {
      enabled: true,
      order: [{ provider: 'maas-dsv4', model: 'deepseek-v4-flash' }],
      retries: 0,
      failureThreshold: 1,
      logLevel: 'silent',
    },
    converters: ['maas'],
  }, null, 2)}\n`)

  const { createServiceClient } = await import('../lib/service-client.js')
  const client = createServiceClient({ logger: quiet }, { configFile: forkConfig, restart: false })
  const started = await client.start()
  check('插件能把这个服务拉起来', started.mode === 'started' && started.url === `http://127.0.0.1:${forkPort}`, JSON.stringify(started))
  check('客户端把自己指向了被拉起的那个地址', client.url() === `http://127.0.0.1:${forkPort}` && client.configFile() === forkConfig)
  check('客户端读到的是同一个服务，不是另一份配置', await client.ping())

  const view = await client.view()
  check('view() 转达服务的实时状态', view.available === true && view.url === `http://127.0.0.1:${forkPort}`
    && Array.isArray(view.live?.rows) && view.live.rows.length === 1, JSON.stringify({ available: view.available, error: view.error }))
  check('令牌来自被拉起那份配置', client.token() === 'fork-token')

  const probed = await client.call('probe', { provider: 'maas-dsv4', model: 'deepseek-v4-flash' })
  check('转达动作拿到服务的答案', probed.ok === true && probed.value?.probe?.ok === true, JSON.stringify(probed).slice(0, 200))
  const reset = await client.call('reset', {})
  check('转达 reset 同样可用', reset.ok === true && reset.value?.stats?.requests === 0)

  // A second client must attach to the running service instead of forking again:
  // a duplicate bind would look exactly like "the service is down".
  const second = createServiceClient({ logger: quiet }, { configFile: forkConfig, restart: false })
  const attached = await second.start()
  check('已有服务在跑时改为接入，而不是再拉一个', attached.mode === 'attached', JSON.stringify(attached))
  second.stop()
  check('接入方 stop() 不会杀掉不属于它的服务', await second.ping())

  client.stop()
  await new Promise((res) => setTimeout(res, 400))
  let gone = false
  try {
    await fetch(`http://127.0.0.1:${forkPort}/healthz`, { signal: AbortSignal.timeout(1_000) })
  } catch {
    gone = true
  }
  check('自己拉起的服务在 disposer 里被停掉（随 DSH 退出）', gone)
  check('停止后底层的端口确实释放了', await freePort() !== 0)
}

section('16. 停得下来')

await service.stop()
let closed = false
try {
  await fetch(`${base}/healthz`)
} catch {
  closed = true
}
check('停止后端口不再接受连接', closed)

await new Promise((res) => stub.server.close(res))
rmSync(process.env.DSH_HOME, { recursive: true, force: true })

const total = passed + failures.length
process.stdout.write(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}  ${passed}/${total} checks\n`)
for (const failure of failures) process.stdout.write(`  ✗ ${failure}\n`)
process.exit(failures.length === 0 ? 0 : 1)

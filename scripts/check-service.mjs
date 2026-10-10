/**
 * Self-check for the standalone routing service. No test framework: one process,
 * one report, a non-zero exit for CI.
 *
 * It runs the real service over a real socket against a **stub upstream** that
 * speaks the gateway's dialect — an SSE stream and a JSON body both shaped like
 * the ones recorded from the live endpoint — so every layer between the caller
 * and the wire is exercised: the request converter, the credential-aware walk,
 * the breaker and its two thresholds, the blacklist, the admin API and the trust
 * fence.
 *
 * Nothing here touches a real provider, so it costs no tokens and runs offline.
 * The live-endpoint check is a separate, deliberate act (`docs/HISTORY.md`
 * records what was measured against it).
 *
 * The suite covers the multi-credential contract: `providers[id].keys[]`, a
 * breaker unit named `provider#keyId`, a persistent blacklist, discovered
 * models, and order-table reconciliation. Where a behaviour is exercised through
 * pure modules (the router, the failure classifier, the state store) the clock is
 * injected so the assertion is deterministic rather than timing-dependent.
 *
 * Usage: `npm run check:service` (or `node scripts/check-service.mjs`).
 */
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const run = promisify(execFile)

// Point the service at a throwaway home *before* importing it: the configuration
// and state paths are resolved when their modules load.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dspo-service-'))
process.env.ROUTER_SERVICE_CONFIG = join(process.env.DSH_HOME, 'router-service.json')
process.env.ROUTER_SERVICE_STATE = join(process.env.DSH_HOME, 'router-service.state.json')

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
const throws = (fn) => {
  try {
    fn()
    return false
  } catch {
    return true
  }
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

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

/** Whether a specific port can still be bound right now (i.e. was released). */
function canBind(port) {
  return new Promise((res) => {
    const probe = createServer()
    probe.once('error', () => res(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => res(true)))
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

/* ───────────────────────── stub upstream ───────────────────────── */

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

/** The error envelope a real gateway uses for each status this suite needs. */
function stubErrorBody(status) {
  if (status === 401) return { error: { message: 'invalid api key', type: 'authentication_error', code: 'invalid_api_key' } }
  if (status === 402) return { error: { message: 'insufficient balance', code: 'insufficient_balance' } }
  if (status === 403) return { error: { message: 'permission denied', code: 'permission_error' } }
  if (status === 429) return { error: { message: 'the upstream is rate limiting', type: 'rate_limit_error' } }
  if (status === 400) return { error: { message: 'the request was rejected', type: 'invalid_request_error' } }
  return { error: { message: `the upstream answered ${status}`, type: 'server_error' } }
}

/**
 * Start the stub upstream.
 *
 * Everything the suite needs to steer is on the returned `state`:
 *   - `keyStatus` maps a credential to the status it answers with;
 *   - `mode` is global (`garbage`, `fail`, `failOnce`);
 *   - `modelsMode` steers `GET /models` independently of the chat plane;
 *   - `delayMs` holds a reply open, which is what makes an abort observable.
 */
function startStub() {
  const state = { calls: [], mode: 'ok', keyStatus: {}, delayMs: 0, modelsMode: 'ok', modelsBody: null, port: 0, server: null }
  const server = createServer((req, res) => {
    // A client that aborted mid-flight leaves a dead socket behind; writing to
    // it is not a test failure.
    res.on('error', () => {})
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body = null
      try {
        body = raw === '' ? null : JSON.parse(raw)
      } catch {
        body = null
      }
      const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : null
      const key = authorization === null ? '' : authorization.replace(/^Bearer\s+/, '')
      const entry = {
        method: req.method,
        path: String(req.url ?? ''),
        body,
        headers: { ...req.headers },
        authorization,
        key,
        status: null,
      }
      state.calls.push(entry)
      const reply = () => {
        if (res.destroyed || res.writableEnded) return
        const isModels = String(req.url ?? '').split('?')[0].endsWith('/models')
        entry.status = 200
        if (isModels) {
          if (state.modelsMode === 'unauthorized') {
            entry.status = 401
            res.writeHead(401, { 'content-type': 'application/json' })
            res.end(JSON.stringify(stubErrorBody(401)))
            return
          }
          if (state.modelsMode === 'garbage') {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end('not json at all')
            return
          }
          if (state.modelsMode === 'empty') {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ object: 'list', data: [] }))
            return
          }
          const data = state.modelsBody ?? [{ id: 'stub-alpha' }, { id: 'stub-beta' }, { id: 'deepseek-v4-flash' }]
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ object: 'list', data }))
          return
        }
        const forced = state.keyStatus[key]
        if (typeof forced === 'number') {
          entry.status = forced
          // Only a capacity signal carries a reset hint: a `retry-after` on a
          // 401 would make the blacklist entry expire in a millisecond, which is
          // not what a revoked credential means.
          const headers = { 'content-type': 'application/json' }
          if (forced === 429 || forced === 503 || forced === 529) headers['retry-after-ms'] = '1'
          res.writeHead(forced, headers)
          res.end(JSON.stringify(stubErrorBody(forced)))
          return
        }
        if (state.mode === 'fail' || (state.mode === 'failOnce' && state.calls.length === 1)) {
          entry.status = 503
          res.writeHead(503, { 'content-type': 'application/json', 'retry-after-ms': '1' })
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
      }
      if (state.delayMs > 0) setTimeout(reply, state.delayMs)
      else reply()
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

/* ───────────────────────── 1. static contract ───────────────────────── */

section('1. 服务是自洽的（零依赖、不反向依赖插件）')

const serviceFiles = [
  'lib/service/main.js',
  'lib/service/server.js',
  'lib/service/proxy.js',
  'lib/service/upstream.js',
  'lib/service/config.js',
  'lib/service/router.js',
  'lib/service/failure.js',
  'lib/service/state.js',
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
  !existsSync(join(ROOT, 'lib/router.js')) && !existsSync(join(ROOT, 'lib/routing.js')))
check('插件主体不再注册熔断钩子',
  !/ctx\.on\(\s*'agent\/(request|request-error)'/.test(read('lib/index.js')))
check('public 转换器契约只有代码模块入口',
  /export function defineConverter/.test(read('lib/service/converters/registry.js')))
check('maas 转换器的参照契约被写在一处',
  /REFERENCE_CONTRACT/.test(read('lib/service/converters/registry.js')))
check('package.json 暴露服务入口与自检脚本',
  typeof JSON.parse(read('package.json')).scripts?.['check:service'] === 'string')

/* ───────────────────────── 2. config semantics (pure) ───────────────────────── */

section('2. 配置语义：单密钥迁移、多密钥与对账原语')

const C = await import('../lib/service/config.js')
const R = await import('../lib/service/router.js')
const F = await import('../lib/service/failure.js')
const S = await import('../lib/service/state.js')

check('旧字段 apiKey 迁移成 id 为 k1 的单条密钥',
  JSON.stringify(C.normalizeKeys(undefined, 'legacy-secret')) === JSON.stringify([{ id: 'k1', label: '', key: 'legacy-secret' }]),
  JSON.stringify(C.normalizeKeys(undefined, 'legacy-secret')))
check('无 id 的密钥按键位获得稳定 id',
  C.normalizeKeys([{ key: 'a' }, { key: 'b' }]).map((entry) => entry.id).join(',') === 'k1,k2')
check('重复或非法 id 被修复成未占用的 id，而不是丢弃该密钥',
  C.normalizeKeys([{ id: 'x', key: 'a' }, { id: 'x', key: 'b' }, { id: 'Bad Id!', key: 'c' }]).map((entry) => entry.id).join(',') === 'x,k1,k2')
check('一个供应商最多 16 把密钥，多余的被截断',
  C.normalizeKeys(Array.from({ length: 20 }, (_, i) => ({ id: `k${i + 1}`, key: 'x' }))).length === C.MAX_KEYS_PER_PROVIDER)
check('非数组的密钥字段被当作没有密钥',
  C.normalizeKeys('nope').length === 0 && C.normalizeKeys(null, '').length === 0)
check('keyUnitsOf 在无密钥时给出一个 id:null 的单位',
  JSON.stringify(C.keyUnitsOf({ keys: [] })) === JSON.stringify([{ id: null, label: '', key: '' }]))
check('keyUnitsOf 有密钥时每把 key 一个单位',
  C.keyUnitsOf({ keys: [{ id: 'k1' }, { id: 'k2' }] }).map((unit) => unit.id).join(',') === 'k1,k2')
check('可用模型 = 手工在前、已发现在后、去重',
  C.availableModels({ models: ['a', 'b'] }, ['b', 'c']).join(',') === 'a,b,c')
check('掩码不泄露完整密钥', C.maskApiKey('sk-abcdefghijklmnop') === 'sk-a…mnop' && C.maskApiKey('') === '')
check('短密钥只露出前两位', C.maskApiKey('abcd') === 'ab…', C.maskApiKey('abcd'))

const migratedDoc = C.normalizeConfig({ providers: { x: { baseURL: 'https://host/v1', apiKey: 'legacy', models: ['m'] } } })
check('normalizeConfig 把旧 apiKey 读成 keys[0]',
  migratedDoc.providers.x.keys.length === 1 && migratedDoc.providers.x.keys[0].id === 'k1' && migratedDoc.providers.x.keys[0].key === 'legacy')
check('normalizeConfig 的输出不再带 provider.apiKey 字段', migratedDoc.providers.x.apiKey === undefined)

/** A state-store stand-in, so `applyConfigPatch` can be observed without a file. */
function fakeState(discovered = {}) {
  const cleared = []
  return {
    cleared,
    clearProvider(provider, keyId = null) {
      cleared.push(keyId === null ? provider : `${provider}#${keyId}`)
      return 1
    },
    discovered: (provider) => discovered[provider] ?? [],
  }
}

const baseDoc = C.normalizeConfig({
  providers: { p: { baseURL: 'https://host/v1', keys: [{ id: 'k1', key: 'OLD' }, { id: 'k2', key: 'K2' }], models: ['m'] } },
  router: { order: [{ provider: 'p', model: 'm' }] },
})
const rotateState = fakeState()
const rotated = C.applyConfigPatch(baseDoc, {
  providers: { p: { baseURL: 'https://host/v1', keys: [{ id: 'k1', key: 'NEW' }, { id: 'k2', key: 'K2' }], models: ['m'] } },
}, { state: rotateState })
check('轮换密钥写入新值并清除该 key 的判定',
  rotated.config.providers.p.keys[0].key === 'NEW'
  && rotateState.cleared.includes('p#k1') && !rotateState.cleared.includes('p#k2'),
  JSON.stringify(rotateState.cleared))
check('key 传空串保留已存的密钥',
  C.applyConfigPatch(baseDoc, { providers: { p: { baseURL: 'https://host/v1', keys: [{ id: 'k1', key: '' }, { id: 'k2', key: '' }], models: ['m'] } } })
    .config.providers.p.keys.map((entry) => entry.key).join(',') === 'OLD,K2')
check('完全不传 keys/apiKey 时密钥列表整体不变',
  C.applyConfigPatch(baseDoc, { providers: { p: { baseURL: 'https://host/v1', models: ['m'] } } })
    .config.providers.p.keys.map((entry) => entry.key).join(',') === 'OLD,K2')
check('从 keys 数组里删掉一项就是删掉该密钥',
  C.applyConfigPatch(baseDoc, { providers: { p: { baseURL: 'https://host/v1', keys: [{ id: 'k2', key: 'K2' }], models: ['m'] } } })
    .config.providers.p.keys.map((entry) => entry.id).join(',') === 'k2')
check('新增无 id 的密钥由服务端生成下一个稳定 id',
  C.applyConfigPatch(baseDoc, { providers: { p: { baseURL: 'https://host/v1', keys: [{ id: 'k1', key: 'OLD' }, { id: 'k2', key: 'K2' }, { key: 'K3' }], models: ['m'] } } })
    .config.providers.p.keys.map((entry) => entry.id).join(',') === 'k1,k2,k3')
const manyKeys = Array.from({ length: 17 }, (_, i) => ({ id: `x${i + 1}`, key: 'x' }))
check('超过 16 把密钥的保存被拒绝（不是静默截断）',
  throws(() => C.applyConfigPatch(baseDoc, { providers: { p: { baseURL: 'https://host/v1', keys: manyKeys, models: ['m'] } } })))
check('非法 key id 被拒绝',
  throws(() => C.applyConfigPatch(baseDoc, { providers: { p: { baseURL: 'https://host/v1', keys: [{ id: 'Bad Id!', key: 'x' }], models: ['m'] } } })))
check('重复 key id 被拒绝',
  throws(() => C.applyConfigPatch(baseDoc, { providers: { p: { baseURL: 'https://host/v1', keys: [{ id: 'k1', key: 'a' }, { id: 'k1', key: 'b' }], models: ['m'] } } })))
check('keys 不是数组被拒绝',
  throws(() => C.applyConfigPatch(baseDoc, { providers: { p: { baseURL: 'https://host/v1', keys: 'nope', models: ['m'] } } })))
check('补丁拒绝非法字段而不是静默丢弃',
  throws(() => C.applyConfigPatch(C.seedConfig(), { router: { retries: 999 } })))
check('服务端口写入只在变更时要求重启', (() => {
  const doc = C.normalizeConfig({ server: { port: 8790 } })
  return C.applyConfigPatch(doc, { server: { port: 8790 } }).restartRequired === false
    && C.applyConfigPatch(doc, { server: { port: 8791 } }).restartRequired === true
})())

const recProviders = { keep: { models: ['m'] }, empty: { models: [] } }
const reconciled = C.reconcileOrder(
  [{ provider: 'keep', model: 'm' }, { provider: 'gone', model: 'm' }, { provider: 'empty', model: 'whatever' }],
  recProviders,
  (id) => C.availableModels(recProviders[id], []),
)
check('对账删除 provider 已不存在的行并给出 provider_not_configured',
  reconciled.removed.some((row) => row.provider === 'gone' && row.reason === 'provider_not_configured'))
check('对账删除模型不在列表里的行并给出 model_not_available', (() => {
  const providers = { x: { models: ['other'] } }
  const out = C.reconcileOrder([{ provider: 'x', model: 'm' }], providers, (id) => C.availableModels(providers[id], []))
  return out.removed[0]?.reason === 'model_not_available' && out.order.length === 0
})())
check('models 为空数组时对账不删任何行（空=未知，不是没有）',
  reconciled.order.some((row) => row.provider === 'empty') && !reconciled.removed.some((row) => row.provider === 'empty'))

const seededDoc = C.seedConfig()
check('seedConfig 为 MaaS 两条路由预置入口', 'maas-dsv4' in seededDoc.providers && 'maas-coclaw' in seededDoc.providers)
check('预置入口不带任何密钥（服务不会悄悄拿到密钥）',
  Object.values(seededDoc.providers).every((provider) => provider.keys.length === 0))
check('seedConfig 默认注册 maas 转换器', seededDoc.converters.includes('maas'))

/* ───────────────────────── 3. live service ───────────────────────── */

section('3. 服务起得来，且把自己说清楚')

const stub = await startStub()
const port = await freePort()
const token = 'test-token-0123456789'
const stubBase = `http://127.0.0.1:${stub.port}/v1`

const PROVIDER_SPEC = {
  // The two ids the converter claims by name; `maas-coclaw` holds the broken key.
  'maas-dsv4': { label: 'dsv4', baseURL: stubBase, keys: [{ id: 'k1', key: 'gw-good' }], models: ['deepseek-v4-flash'] },
  'maas-coclaw': { label: 'claw', baseURL: stubBase, keys: [{ id: 'k1', key: 'gw-broken' }], models: ['co-claw'] },
  'p-switch': { label: 'switch', baseURL: stubBase, keys: [{ id: 'k1', key: 'sw-a' }, { id: 'k2', key: 'sw-b' }], models: ['m-switch'] },
  'p-ignore': { label: 'ignore', baseURL: stubBase, keys: [{ id: 'k1', key: 'ig-a' }, { id: 'k2', key: 'ig-b' }], models: ['m-ignore'] },
  'p-429': { label: 'overloaded', baseURL: stubBase, keys: [{ id: 'k1', key: 'rl-a' }], models: ['m-429'] },
  'p-dead': { label: 'dead', baseURL: stubBase, keys: [{ id: 'k1', key: 'dd-a' }, { id: 'k2', key: 'dd-b' }], models: ['m-dead'] },
  'p-nokey': { label: 'keyless', baseURL: stubBase, keys: [], models: ['m-nokey'] },
  'p-head': {
    label: 'headers',
    baseURL: stubBase,
    keys: [{ id: 'k1', key: 'hd-a' }],
    models: ['m-head'],
    headers: { 'x-stub-token': 'hdr-value', authorization: 'Bearer header-token' },
  },
  'p-models': { label: 'models', baseURL: stubBase, keys: [{ id: 'k1', key: 'md-a' }, { id: 'k2', key: 'md-b' }], models: ['m-manual'] },
  'p-recon': { label: 'recon', baseURL: stubBase, keys: [{ id: 'k1', key: 'rc-a' }], models: ['m-recon'] },
  'p-half': { label: 'half', baseURL: stubBase, keys: [{ id: 'k1', key: 'hf-a' }], models: ['m-half'] },
}
const DEFAULT_ORDER = Object.entries(PROVIDER_SPEC).map(([id, provider]) => ({ provider: id, model: provider.models[0] }))
const providersDoc = () => JSON.parse(JSON.stringify(PROVIDER_SPEC))

writeFileSync(process.env.ROUTER_SERVICE_CONFIG, `${JSON.stringify({
  server: { host: '127.0.0.1', port, token },
  providers: providersDoc(),
  router: { enabled: true, order: DEFAULT_ORDER, retries: 0, failureThreshold: 2, logLevel: 'silent' },
  converters: ['maas'],
}, null, 2)}\n`)

const { startService, READY_PREFIX, parseArgs } = await import('../lib/service/main.js')
const { isLoopback } = await import('../lib/service/server.js')
const quiet = { error() {}, warn() {}, info() {}, debug() {} }
let service = await startService({ listen: true, poll: false, logger: quiet })
let base = `http://127.0.0.1:${service.bound.port}`
const adminHeaders = { 'x-router-token': token }

const providerState = (id, payload = service.admin.state()) => (payload.providers ?? []).find((entry) => entry.id === id) ?? null
const rowOf = (unit, payload = service.admin.state()) => (payload.rows ?? []).find((entry) => entry.unit === unit) ?? null
const blacklistHas = (unit, payload = service.admin.state()) => (payload.blacklist ?? []).some((entry) => entry.unit === unit)
const chat = (model, extra = {}) => post(`${base}/v1/chat/completions`, { model, messages: [{ role: 'user', content: 'ping' }], ...extra })

/** Save the whole provider map (plus an optional router patch). */
async function configure({ order, router = {} } = {}) {
  const patch = { providers: providersDoc(), router: { ...router } }
  if (order !== undefined) patch.router.order = order
  return service.admin.save(patch)
}
/** Save one provider's fields, keeping every other provider as declared. */
async function saveProvider(id, overrides) {
  const docs = providersDoc()
  docs[id] = { ...docs[id], ...overrides }
  return service.admin.save({ providers: docs })
}
/** Clear every blacklist entry and every breaker, without touching config. */
async function cleanSlate() {
  const live = service.admin.state()
  for (const provider of [...new Set(live.blacklist.map((entry) => entry.provider))]) {
    await post(`${base}/admin/api/keys/restore`, { provider }, adminHeaders)
  }
  service.admin.reset()
}
const onDisk = () => JSON.parse(readFileSync(process.env.ROUTER_SERVICE_CONFIG, 'utf8'))
const onDiskKeys = (id) => onDisk().providers?.[id]?.keys ?? []

check('服务绑定了配置里的端口', service.bound.port === port, `${service.bound.port} vs ${port}`)
check('健康检查可用', (await get(`${base}/healthz`)).json?.ok === true)
check('--check 与默认模式可区分', parseArgs(['--check']).check === true && parseArgs([]).check === false)
check('就绪行前缀是常量', READY_PREFIX.startsWith('ROUTER_SERVICE_') && service.loaded.loaded.includes('maas'))
check('maas 转换器已登记', service.registry.list().map((entry) => entry.id).join(',') === 'maas')
check('运行态文件路径来自 ROUTER_SERVICE_STATE', S.SERVICE_STATE_FILE === process.env.ROUTER_SERVICE_STATE)

section('4. /v1/models 与入参语义')

const models = await get(`${base}/v1/models`)
check('/v1/models 返回 list 形状', models.json?.object === 'list' && Array.isArray(models.json.data))
const modelIds = (models.json?.data ?? []).map((entry) => entry.id)
check('只列 provider/model 带前缀拼写，不再列有歧义的裸名',
  modelIds.includes('maas-dsv4/deepseek-v4-flash') && modelIds.includes('maas-coclaw/co-claw')
  && !modelIds.includes('deepseek-v4-flash') && !modelIds.includes('co-claw'), modelIds.join(','))
check('每条模型都是 OpenAI 形状',
  (models.json?.data ?? []).every((entry) => entry.object === 'model' && typeof entry.owned_by === 'string' && Number.isFinite(entry.created)))

stub.mode = 'ok'
stub.keyStatus = {}
stub.calls.length = 0
const completion = await post(`${base}/v1/chat/completions`, {
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: 'ping' }],
  thinking: { type: 'disabled' },
  max_completion_tokens: 64,
})
check('非流式 HTTP 200', completion.status === 200, completion.text.slice(0, 200))
check('model 回显调用方请求的名字', completion.json?.model === 'deepseek-v4-flash', completion.json?.model)
const message = completion.json?.choices?.[0]?.message
check('reasoning 被改名为 reasoning_content', message?.reasoning_content === 'let me think about that' && message?.reasoning === undefined)
check('常驻 null 的网关字段被摘掉', message?.refusal === undefined && message?.annotations === undefined && message?.audio === undefined)
check('choice 级噪声字段被摘掉', completion.json?.choices?.[0]?.stop_reason === undefined && completion.json?.choices?.[0]?.token_ids === undefined)
check('顶层噪声字段被摘掉', completion.json?.prompt_token_ids === undefined && completion.json?.metrics === undefined)
check('usage 归一成参照契约的字段', completion.json?.usage?.prompt_tokens === 11
  && completion.json?.usage?.prompt_cache_hit_tokens === 3
  && completion.json?.usage?.prompt_cache_miss_tokens === 8)
check('补上了 system_fingerprint', typeof completion.json?.system_fingerprint === 'string' && completion.json.system_fingerprint.startsWith('fp_'))
const sent = stub.calls[0]?.body
check('thinking disabled 落成 reasoning_effort=none', sent?.reasoning_effort === 'none', JSON.stringify(sent?.reasoning_effort))
check('max_completion_tokens 折成 max_tokens', sent?.max_tokens === 64 && sent?.max_completion_tokens === undefined)
check('上游收到 bearer 凭据', stub.calls[0]?.headers?.authorization === 'Bearer gw-good', stub.calls[0]?.headers?.authorization)

stub.calls.length = 0
await post(`${base}/v1/chat/completions`, { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'x' }], thinking: { type: 'enabled', budget_tokens: 2048 } })
check('budget_tokens 映射到就近档位', stub.calls[0]?.body?.reasoning_effort === 'medium', stub.calls[0]?.body?.reasoning_effort)
await post(`${base}/v1/chat/completions`, { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'x' }], reasoning_effort: 'minimal' })
check('minimal 落到 low（网关没有这个词）', stub.calls[1]?.body?.reasoning_effort === 'low', stub.calls[1]?.body?.reasoning_effort)
await post(`${base}/v1/chat/completions`, { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'x' }] })
check('调用方什么都没说时不自作主张加档位', stub.calls[2]?.body?.reasoning_effort === undefined, stub.calls[2]?.body?.reasoning_effort)

stub.calls.length = 0
// An expressed-but-unreadable thinking value must never reach the gateway
// verbatim: both gateways deserialize the field into an enum and reject the
// whole request on an unknown word (measured 422), and on a route whose default
// is *off* a dropped value would silently mean "do not think" instead. The
// converter answers with the loudest level instead of forwarding or dropping it.
const unreadable = [
  ['reasoning_effort', { reasoning_effort: 'bogus' }, 'max', '不认识的档位归一成 max，不原样丢给网关'],
  ['reasoning_effort', { reasoning_effort: 'ultra' }, 'max', '另一个不认识的档位同样归一成 max'],
  ['reasoning_effort', { reasoning_effort: 3 }, 'max', '非字符串档位归一成 max'],
  ['effort', { effort: 'nonsense' }, 'max', 'effort 拼写读不出来时归一成 max'],
  ['thinking.type', { thinking: { type: 'whatever' } }, 'max', 'thinking 里读不出来的写法归一成 max'],
  ['thinking.extra', { thinking: { weird: 1 } }, 'max', 'thinking 带了认不出含义的键也归一成 max'],
  ['thinking.empty', { thinking: {} }, undefined, '空的 thinking 不算表态，不发档位'],
  ['reasoning_effort', { reasoning_effort: null }, undefined, 'null 等同于没表态'],
  ['reasoning_effort', { reasoning_effort: '' }, undefined, '空串等同于没表态'],
  ['both', { effort: 'bogus', reasoning_effort: 'high' }, 'high', '能读出来的写法优先于读不出来的'],
  ['reasoning_effort', { reasoning_effort: 'off' }, 'none', 'off 仍然是真的关（归一成 none）'],
  ['thinking', { thinking: { type: 'disabled' }, reasoning_effort: 'bogus' }, 'none', 'thinking 胜过 reasoning_effort'],
]
for (let i = 0; i < unreadable.length; i += 1) {
  const [, extra, expected, label] = unreadable[i]
  await post(`${base}/v1/chat/completions`, { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'x' }], ...extra })
  const got = stub.calls[i]?.body?.reasoning_effort
  check(label, got === expected, `期望 ${JSON.stringify(expected)}，实到 ${JSON.stringify(got)}`)
}
// The rule is "normalize", not "rewrite everything": a level the gateway accepts
// still travels under one of the words the converter's own level table allows.
stub.calls.length = 0
await post(`${base}/v1/chat/completions`, { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'x' }], reasoning_effort: 'xhigh' })
check('xhigh 归一到 max 档（不落在网关不认的拼写上）', stub.calls[0]?.body?.reasoning_effort === 'max', stub.calls[0]?.body?.reasoning_effort)

stub.calls.length = 0
// `chat_template_kwargs.enable_thinking` is the backends' own thinking switch —
// both render through a Jinja template that reads exactly this variable. It is a
// legal field on these routes, so it is a *readable* spelling of the thinking
// control, not something to reject; and because two switches on one body must not
// disagree, the wire form is written to match whatever level was resolved.
await post(`${base}/v1/chat/completions`, { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'x' }], chat_template_kwargs: { enable_thinking: false } })
check('enable_thinking=false 是能读懂的思考写法，落到 none', stub.calls[0]?.body?.reasoning_effort === 'none', stub.calls[0]?.body?.reasoning_effort)
check('上游的模板开关被写成与档位一致', stub.calls[0]?.body?.chat_template_kwargs?.enable_thinking === false, JSON.stringify(stub.calls[0]?.body?.chat_template_kwargs))
await post(`${base}/v1/chat/completions`, { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'x' }], chat_template_kwargs: { enable_thinking: 'off' } })
check('模板开关的字符串写法也认（off → none）', stub.calls[1]?.body?.reasoning_effort === 'none', stub.calls[1]?.body?.reasoning_effort)
await post(`${base}/v1/chat/completions`, { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'x' }], chat_template_kwargs: { enable_thinking: true } })
check('enable_thinking=true 是开启思考', stub.calls[2]?.body?.reasoning_effort === 'high', stub.calls[2]?.body?.reasoning_effort)
await post(`${base}/v1/chat/completions`, { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'x' }], chat_template_kwargs: { enable_thinking: 'maybe' } })
check('模板开关读不出来时同样归一成 max', stub.calls[3]?.body?.reasoning_effort === 'max', stub.calls[3]?.body?.reasoning_effort)
await post(`${base}/v1/chat/completions`, { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'x' }], chat_template_kwargs: { unrelated_template_var: 7 } })
check('没有 enable_thinking 的模板参数不算思考表态', stub.calls[4]?.body?.reasoning_effort === undefined, stub.calls[4]?.body?.reasoning_effort)
check('无关的模板参数原样继续走', stub.calls[4]?.body?.chat_template_kwargs?.unrelated_template_var === 7, JSON.stringify(stub.calls[4]?.body?.chat_template_kwargs))
check('没表态时也不凭空加 enable_thinking', stub.calls[4]?.body?.chat_template_kwargs?.enable_thinking === undefined)
await post(`${base}/v1/chat/completions`, { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'x' }], reasoning_effort: 'bogus', chat_template_kwargs: { enable_thinking: false } })
check('读得懂的模板开关胜过读不出的档位（不是 max）', stub.calls[5]?.body?.reasoning_effort === 'none', stub.calls[5]?.body?.reasoning_effort)
await post(`${base}/v1/chat/completions`, { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'x' }], thinking: { type: 'disabled' }, chat_template_kwargs: { enable_thinking: true, unrelated_template_var: 7 } })
check('两个开关不可能互相打架：thinking 判关时模板开关也被改写', stub.calls[6]?.body?.chat_template_kwargs?.enable_thinking === false, JSON.stringify(stub.calls[6]?.body?.chat_template_kwargs))
check('改写模板开关不吞掉其他模板参数', stub.calls[6]?.body?.chat_template_kwargs?.unrelated_template_var === 7)
await post(`${base}/v1/chat/completions`, { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'x' }], reasoning_effort: 'none' })
check('走标准档位关思考时也补上模板开关（模板驱动的后端才不会两边不一致）', stub.calls[7]?.body?.chat_template_kwargs?.enable_thinking === false, JSON.stringify(stub.calls[7]?.body?.chat_template_kwargs))
await post(`${base}/v1/chat/completions`, { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'x' }], reasoning_effort: 'high' })
check('开启思考时模板开关同步为 true', stub.calls[8]?.body?.chat_template_kwargs?.enable_thinking === true, JSON.stringify(stub.calls[8]?.body?.chat_template_kwargs))

stub.calls.length = 0
const gated = await post(`${base}/v1/chat/completions`, {
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: 'give me a list' }],
  response_format: { type: 'json_object' },
})
check('response_format 前置条件不满足就 400', gated.status === 400, `${gated.status} ${gated.text.slice(0, 160)}`)
check('400 错误体是参照契约的形状', gated.json?.error?.type === 'invalid_request_error' && gated.json?.error?.param === null)
check('被拒的请求根本没打到上游', stub.calls.length === 0, String(stub.calls.length))
const allowed = await post(`${base}/v1/chat/completions`, {
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: 'give me json' }],
  response_format: { type: 'json_object' },
})
check('满足前置条件就放行', allowed.status === 200 && stub.calls.length === 1)

stub.calls.length = 0
const streamed = await readSse(`${base}/v1/chat/completions`, { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'ping' }], stream: true })
check('SSE content-type 正确', String(streamed.type).includes('text/event-stream'), streamed.type)
check('流式以 [DONE] 收尾', streamed.payloads[streamed.payloads.length - 1] === '[DONE]')
const streamChunks = streamed.payloads.filter((entry) => entry !== '[DONE]')
check('每块 object 都是 chat.completion.chunk', streamChunks.every((chunk) => chunk.object === 'chat.completion.chunk'))
check('delta 里的 reasoning 被改名', streamChunks[0]?.choices?.[0]?.delta?.reasoning_content === 'think'
  && streamChunks[0]?.choices?.[0]?.delta?.reasoning === undefined)
check('流式请求向上游要了 include_usage', stub.calls[0]?.body?.stream_options?.include_usage === true)

/* ───────────────────────── 5. provider-level breaker ───────────────────────── */

section('5. 熔断与切换：坏路由自己出局')

await cleanSlate()
stub.keyStatus = { 'gw-broken': 503 }
await configure({
  order: [{ provider: 'maas-coclaw', model: 'co-claw' }, { provider: 'maas-dsv4', model: 'deepseek-v4-flash' }],
  router: { retries: 0, failureThreshold: 2 },
})
stub.calls.length = 0
const failover = await chat('co-claw')
check('第一条路由 503 后仍能由第二条作答', failover.status === 200 && failover.json?.choices?.[0]?.message?.content === 'pong', `${failover.status} ${failover.text.slice(0, 200)}`)
check('切换后响应的 model 仍是调用方请求的名字', failover.json?.model === 'co-claw', failover.json?.model)
check('两次尝试都真的打到了上游', stub.calls.length === 2, String(stub.calls.length))
const afterFailover = service.admin.state()
check('坏路由的熔断器被打开', rowOf('maas-coclaw#k1', afterFailover)?.state === 'open')
check('成功的那条保持关闭', rowOf('maas-dsv4#k1', afterFailover)?.state === 'closed')
check('失败与切换被计数', afterFailover.stats.failures >= 1 && afterFailover.stats.switches >= 1, JSON.stringify(afterFailover.stats))

stub.calls.length = 0
const second = await chat('co-claw')
check('第二次请求直接跳过已熔断的路由', second.status === 200 && stub.calls.length === 1, `${second.status} calls=${stub.calls.length}`)

section('5a-2. 表里没有的模型不会被别的模型顶包')
// 这一段防的是最坏的一类错：请求一个模型、拿到 200、名字还回显成你请求的那个，
// 而背后答话的是另一个网关。上面 5a 里 `co-claw` 命中的是表里的行（正常切换），
// 这里把 maas-coclaw 从表里拿掉——它仍然是**配置好的**供应商，所以全名应当只打它自己。
stub.keyStatus = {}
await cleanSlate()
await configure({ order: [{ provider: 'maas-dsv4', model: 'deepseek-v4-flash' }], router: { retries: 0, failureThreshold: 2 } })
stub.calls.length = 0
const qualified = await chat('maas-coclaw/co-claw')
check('没列进表的全名由它自己的供应商作答（HTTP 200）', qualified.status === 200, `${qualified.status} ${qualified.text.slice(0, 160)}`)
check('而且真的打在 co-claw 的密钥上，不是表头那条', stub.calls.length === 1 && stub.calls[0]?.key === 'gw-broken', `${stub.calls.length} calls key=${stub.calls[0]?.key}`)
check('回显的仍是调用方请求的名字', qualified.json?.model === 'maas-coclaw/co-claw', qualified.json?.model)

stub.calls.length = 0
stub.keyStatus = { 'gw-broken': 503 }
const stranded = await chat('maas-coclaw/co-claw')
check('它自己挂了就如实失败，不切到别的模型去', stranded.status >= 400, `${stranded.status}`)
check('失败时也只打了它自己一次', stub.calls.length === 1 && stub.calls[0]?.key === 'gw-broken', `${stub.calls.length} calls key=${stub.calls[0]?.key}`)
stub.keyStatus = {}
await cleanSlate()

stub.calls.length = 0
const ghost = await chat('totally-bogus/not-configured')
check('瞎写的供应商/模型返回 404，而不是 200', ghost.status === 404, `${ghost.status} ${ghost.text.slice(0, 160)}`)
check('404 的错误体仍是参照契约形状', ghost.json?.error?.type === 'invalid_request_error' && ghost.json?.error?.param === null, JSON.stringify(ghost.json).slice(0, 140))
check('被拒的请求一个上游包都没发', stub.calls.length === 0, String(stub.calls.length))

stub.calls.length = 0
const bare = await chat('co-claw')
check('只有模型名、表里又没有：无从判断供应商，也 404', bare.status === 404, `${bare.status}`)
check('这条同样没有打上游', stub.calls.length === 0, String(stub.calls.length))
await configure({ order: DEFAULT_ORDER, router: { retries: 0, failureThreshold: 2 } })

section('5b. 同一条路由先重试，重试用完才切换')
stub.keyStatus = {}
stub.mode = 'failOnce'
await cleanSlate()
await configure({ order: [{ provider: 'maas-dsv4', model: 'deepseek-v4-flash' }], router: { retries: 1 } })
stub.calls.length = 0
const retried = await chat('deepseek-v4-flash')
check('第一次 503、重试成功', retried.status === 200 && stub.calls.length === 2, `${retried.status} calls=${stub.calls.length}`)
check('重试被计数，且这一轮没有切换', service.admin.state().stats.retries >= 1 && service.admin.state().stats.switches === 0)
check('重试成功后熔断器保持关闭', rowOf('maas-dsv4#k1')?.state === 'closed')
stub.mode = 'ok'

section('5c. 关掉总开关 = 纯代理：不重试、也不记账')
{
  stub.mode = 'failOnce'
  const off = await configure({ order: [{ provider: 'maas-dsv4', model: 'deepseek-v4-flash' }], router: { enabled: false, retries: 3 } })
  check('总开关可以关掉', off.router.enabled === false)
  service.admin.reset()
  stub.calls.length = 0
  const plain = await chat('deepseek-v4-flash')
  check('关掉后不重试：只打一次上游就如实失败', plain.status >= 400 && stub.calls.length === 1, `${plain.status} calls=${stub.calls.length}`)
  check('关掉后错误体仍是参照契约形状', plain.json?.error?.type === 'server_error', JSON.stringify(plain.json).slice(0, 140))
  check('关掉后不记熔断（重新打开时不会带着旧账）',
    rowOf('maas-dsv4#k1')?.failures === 0 && rowOf('maas-dsv4#k1')?.state === 'closed')
  stub.mode = 'ok'
  await configure({ order: [{ provider: 'maas-dsv4', model: 'deepseek-v4-flash' }], router: { enabled: true, retries: 0 } })
  check('重新打开后一切照旧', (await chat('deepseek-v4-flash')).status === 200)
}

section('5d. 坏响应与坏配置各有各的下场')
stub.mode = 'garbage'
await cleanSlate()
await configure({ order: [{ provider: 'maas-dsv4', model: 'deepseek-v4-flash' }], router: { retries: 0 } })
const garbage = await chat('deepseek-v4-flash')
check('上游 200 但 body 不是 JSON → 502 错误体，绝不把垃圾透传出去', garbage.status === 502 && garbage.json?.error?.code === 'service_unavailable',
  `${garbage.status} ${garbage.text.slice(0, 120)}`)
check('错误体仍携带可定位的原因（而不是笼统的 server_error 文案）',
  typeof garbage.json?.error?.message === 'string' && garbage.json.error.message.includes('not JSON'))
stub.mode = 'ok'
const badPort = await post(`${base}/admin/api/config`, { server: { port: 99_999 } }, adminHeaders)
check('端口越界被拒绝而不是被改写', badPort.json?.ok === false && /port/.test(badPort.json?.error?.message ?? ''))
const badProvider = await post(`${base}/admin/api/config`, { providers: { x: { models: ['m'] } } }, adminHeaders)
check('缺 baseURL 的供应商被拒绝', badProvider.json?.ok === false)
const badOrder = await post(`${base}/admin/api/config`, { router: { order: [{ provider: 'a' }] } }, adminHeaders)
check('缺 model 的路由行被拒绝', badOrder.json?.ok === false)
const unknown = await post(`${base}/admin/api/config`, { router: { order: [{ provider: 'ghost', model: 'm' }] } }, adminHeaders)
check('指向未注册供应商的行被接受但如实标记',
  unknown.json?.ok === true && unknown.json.value.rows[0].registered === false, JSON.stringify(unknown.json?.value?.rows?.[0]))
await configure({ order: DEFAULT_ORDER, router: { retries: 0, failureThreshold: 2 } })

/* ───────────────────────── 5e. 透传路由的消息 role 归一 ───────────────────────── */

section('5e. 发往官方契约的 developer role 被归一成 system')

// `p-switch` 的 baseURL 是本地 stub，不匹配 maas 转换器（那只认 ZTE host 与 maas-*
// 名），所以它是「无转换器原样透传」的那条路——正是 `deepseek-official` 的形态。
// DSH 的思考路由会把系统提示词以 `developer` role 发来，官方 api.deepseek.com
// 只认 system/user/assistant/tool，不归一就会 422。这里验证这条路 emit 前被改写。
await cleanSlate()
await configure({ order: [{ provider: 'p-switch', model: 'm-switch' }], router: { retries: 0, failureThreshold: 2 } })
stub.calls.length = 0
const developerSent = await post(`${base}/v1/chat/completions`, {
  model: 'm-switch',
  messages: [{ role: 'developer', content: 'be terse' }, { role: 'user', content: 'hi' }],
})
check('带 developer 消息的透传请求仍返回 200', developerSent.status === 200, `${developerSent.status} ${developerSent.text.slice(0, 160)}`)
check('打到上游时 developer 已被归一成 system', stub.calls[0]?.body?.messages?.[0]?.role === 'system'
  && stub.calls[0]?.body?.messages?.[1]?.role === 'user', JSON.stringify(stub.calls[0]?.body?.messages))
check('归一后消息内容原样保留', stub.calls[0]?.body?.messages?.[0]?.content === 'be terse', JSON.stringify(stub.calls[0]?.body?.messages?.[0]))
stub.calls.length = 0
const plainSent = await post(`${base}/v1/chat/completions`, {
  model: 'm-switch',
  messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }],
})
check('已知 role（system）不受影响、原样透传', plainSent.status === 200 && stub.calls[0]?.body?.messages?.[0]?.role === 'system',
  JSON.stringify(stub.calls[0]?.body?.messages))
await configure({ order: DEFAULT_ORDER, router: { retries: 0, failureThreshold: 2 } })

/* ───────────────────────── 5f. 透传路由的 model 名归一 ───────────────────────── */

section('5f. 透传路由不把 provider 前缀的 model 名原样发出去')

// DSH 以北向全名（`provider/model`）点名，例如 `deepseek-official/deepseek-flash`。
// 无转换器的透传路由若原样转发，官方契约会因 model 名带 `provider/` 前缀而 400。
// 这里验证透传路由把 wire model 归一成该行（candidate）的 model。
await cleanSlate()
await configure({ order: [{ provider: 'p-switch', model: 'm-switch' }], router: { retries: 0, failureThreshold: 2 } })
stub.calls.length = 0
const prefixed = await post(`${base}/v1/chat/completions`, {
  model: 'p-switch/m-switch',
  messages: [{ role: 'user', content: 'hi' }],
})
check('带 provider 前缀 model 的透传请求仍返回 200', prefixed.status === 200, `${prefixed.status} ${prefixed.text.slice(0, 160)}`)
check('打到上游的 wire model 是该行的 model，而不是前缀全名',
  stub.calls[0]?.body?.model === 'm-switch', JSON.stringify(stub.calls[0]?.body?.model))
stub.calls.length = 0
const bareModelSent = await post(`${base}/v1/chat/completions`, {
  model: 'm-switch',
  messages: [{ role: 'user', content: 'hi' }],
})
check('本就裸写的 model 不受影响', bareModelSent.status === 200 && stub.calls[0]?.body?.model === 'm-switch',
  JSON.stringify(stub.calls[0]?.body?.model))
await configure({ order: DEFAULT_ORDER, router: { retries: 0, failureThreshold: 2 } })

/* ───────────────────────── 6. multi-key config (live) ───────────────────────── */

section('6. 多密钥配置语义（经管理接口）')

await configure({ order: DEFAULT_ORDER, router: { retries: 0, failureThreshold: 2 } })
let liveState = service.admin.state()
let switchProvider = providerState('p-switch', liveState)
check('多密钥供应商每把 key 都带 id/label/masked/set',
  switchProvider.keys.length === 2 && switchProvider.keys.every((entry) => typeof entry.id === 'string' && typeof entry.masked === 'string' && typeof entry.set === 'boolean'))
check('回传的是掩码而不是明文',
  switchProvider.keys.every((entry) => entry.masked !== 'sw-a' && entry.masked !== 'sw-b') && switchProvider.keys[0].masked.includes('…'),
  JSON.stringify(switchProvider.keys))
check('状态载荷整体不含任何明文密钥',
  !JSON.stringify(liveState).includes('sw-a') && !JSON.stringify(liveState).includes('sw-b'))
check('密钥确实落盘', onDiskKeys('p-switch').map((entry) => entry.key).join(',') === 'sw-a,sw-b')
check('apiKeySet/keyCount 汇总正确', switchProvider.apiKeySet === true && switchProvider.keyCount === 2)

await saveProvider('p-switch', { keys: [{ id: 'k1', key: '' }, { id: 'k2', key: 'sw-b2' }] })
check('key 传空串保留已存密钥，传新值即轮换',
  onDiskKeys('p-switch').map((entry) => entry.key).join(',') === 'sw-a,sw-b2', JSON.stringify(onDiskKeys('p-switch')))
await saveProvider('p-switch', { keys: [{ id: 'k1', key: '' }] })
check('从 keys 删掉一项即删除该密钥',
  providerState('p-switch').keyCount === 1 && onDiskKeys('p-switch').map((entry) => entry.id).join(',') === 'k1')
await saveProvider('p-switch', { keys: [{ id: 'k1', key: '' }, { key: 'sw-new' }] })
check('新增无 id 的 key 由服务端生成稳定 id 并落盘',
  onDiskKeys('p-switch').length === 2 && onDiskKeys('p-switch')[1].id === 'k2' && onDiskKeys('p-switch')[1].key === 'sw-new',
  JSON.stringify(onDiskKeys('p-switch')))
await saveProvider('p-switch', { label: 'renamed' })
check('完全不传 keys 时密钥列表整体不变',
  onDiskKeys('p-switch').map((entry) => entry.id).join(',') === 'k1,k2', JSON.stringify(onDiskKeys('p-switch')))

/** Whether a save is refused, and with what message (`admin.save` throws in-process). */
function saveRejected(patch) {
  try {
    service.admin.save(patch)
    return null
  } catch (cause) {
    return String(cause?.message ?? cause)
  }
}
const tooManyDoc = providersDoc()
tooManyDoc['p-switch'] = { ...tooManyDoc['p-switch'], keys: Array.from({ length: 17 }, (_, i) => ({ id: `x${i + 1}`, key: 'x' })) }
const rejectedMany = saveRejected({ providers: tooManyDoc })
check('超过 16 把 key 的保存被拒绝', rejectedMany !== null && /16 keys/.test(rejectedMany), String(rejectedMany))
const badIdDoc = providersDoc()
badIdDoc['p-switch'] = { ...badIdDoc['p-switch'], keys: [{ id: 'Bad Id!', key: 'x' }] }
const rejectedId = saveRejected({ providers: badIdDoc })
check('非法 key id 的保存被拒绝', rejectedId !== null && /keys\[0\]\.id/.test(rejectedId), String(rejectedId))

const legacyDocs = providersDoc()
legacyDocs['p-legacy'] = { label: 'legacy', baseURL: stubBase, apiKey: 'legacy-secret', models: ['m-legacy'] }
const legacyState = await service.admin.save({ providers: legacyDocs })
const legacyProvider = providerState('p-legacy', legacyState)
check('经管理接口传旧 apiKey 也会落成 keys[0]（id 为 k1）',
  legacyProvider.keyCount === 1 && legacyProvider.keys[0].id === 'k1' && legacyProvider.keys[0].set === true
  && onDisk().providers['p-legacy'].keys[0].key === 'legacy-secret')
check('旧 apiKey 的明文同样不出现在状态载荷里', !JSON.stringify(legacyState).includes('legacy-secret'))
await configure({ order: DEFAULT_ORDER })

/* ───────────────────────── 7. key-level switching ───────────────────────── */

section('7. key 级切换：先换 key，再换供应商')

await configure({ order: [{ provider: 'p-switch', model: 'm-switch' }], router: { retries: 0, failureThreshold: 2 } })
await cleanSlate()
stub.calls.length = 0
stub.keyStatus = { 'sw-a': 500 }
const switchedBy500 = await chat('m-switch')
check('同一供应商内第一把 500 后切到第二把并成功', switchedBy500.status === 200 && stub.calls.length === 2, `${switchedBy500.status} calls=${stub.calls.length}`)
check('第二次请求用的是第二把 key', stub.calls.map((call) => call.key).join(',') === 'sw-a,sw-b', stub.calls.map((call) => call.key).join(','))
check('失败的那把只记一次可重试失败、熔断仍关闭',
  rowOf('p-switch#k1')?.state === 'closed' && rowOf('p-switch#k1')?.consecutive === 1, JSON.stringify(rowOf('p-switch#k1')))
check('成功的那把不背失败', rowOf('p-switch#k2')?.consecutive === 0)

service.admin.reset()
stub.calls.length = 0
stub.keyStatus = { 'sw-a': 401 }
const switchedBy401 = await chat('m-switch')
check('第一把 401 后同供应商第二把作答', switchedBy401.status === 200 && stub.calls.map((call) => call.key).join(',') === 'sw-a,sw-b')
check('401 的那把进拉黑（不是熔断）', rowOf('p-switch#k1')?.blacklisted === true && rowOf('p-switch#k1')?.state === 'closed')
service.admin.reset()
stub.calls.length = 0
const afterBlacklist = await chat('m-switch')
check('已被拉黑的 key 之后不再收到请求', afterBlacklist.status === 200 && stub.calls.map((call) => call.key).join(',') === 'sw-b', stub.calls.map((call) => call.key).join(','))

await cleanSlate()
await configure({
  order: [{ provider: 'p-switch', model: 'm-switch' }, { provider: 'maas-dsv4', model: 'deepseek-v4-flash' }],
  router: { retries: 0 },
})
stub.keyStatus = { 'sw-a': 500, 'sw-b': 500 }
stub.calls.length = 0
const bothKeysBad = await chat('m-switch')
check('两把 key 都坏时才轮到下一个供应商',
  bothKeysBad.status === 200 && stub.calls.map((call) => call.key).join(',') === 'sw-a,sw-b,gw-good', stub.calls.map((call) => call.key).join(','))

await cleanSlate()
await configure({ order: [{ provider: 'p-nokey', model: 'm-nokey' }], router: { retries: 0 } })
stub.keyStatus = {}
stub.calls.length = 0
const keyless = await chat('m-nokey')
check('无密钥供应商仍然可用', keyless.status === 200, `${keyless.status} ${keyless.text.slice(0, 160)}`)
check('无密钥供应商不发送 Authorization 头', stub.calls[0]?.authorization === null, JSON.stringify(stub.calls[0]?.authorization))

/* ───────────────────────── 8. failure accounting ───────────────────────── */

section('8. 失败分类的记账效果')

// 400: the request itself is wrong, so the breaker must not learn anything. The
// walk does still step to the sibling credential (see the labelled check below).
await cleanSlate()
await configure({ order: [{ provider: 'p-ignore', model: 'm-ignore' }], router: { retries: 0, failureThreshold: 2 } })
stub.keyStatus = { 'ig-a': 400, 'ig-b': 400 }
stub.calls.length = 0
const badRequest = await chat('m-ignore')
const ignoredState = service.admin.state()
check('上游 400 不计数、不熔断、不拉黑',
  rowOf('p-ignore#k1', ignoredState)?.state === 'closed'
  && rowOf('p-ignore#k1', ignoredState)?.consecutive === 0
  && rowOf('p-ignore#k1', ignoredState)?.blacklisted === false
  && ignoredState.blacklist.length === 0, JSON.stringify(rowOf('p-ignore#k1', ignoredState)))
check('上游 400 被记为 ignored 而不是熔断失败', ignoredState.stats.ignored === 2, JSON.stringify(ignoredState.stats))
check('上游 400 之后仍会试同供应商的下一个 key（4xx 是上游答案，不是客户端错误）',
  stub.calls.map((call) => call.key).join(',') === 'ig-a,ig-b', stub.calls.map((call) => call.key).join(','))
check('无候选可用时透传最后一个上游 400 的状态与错误体，而不是自造 503',
  badRequest.status === 400 && badRequest.json?.error?.message === 'the request was rejected',
  `${badRequest.status} ${badRequest.text.slice(0, 120)}`)

await cleanSlate()
await configure({ order: [{ provider: 'p-429', model: 'm-429' }], router: { retries: 0, failureThreshold: 2, cooldownMs: 30_000 } })
stub.keyStatus = { 'rl-a': 429 }
stub.calls.length = 0
const overloaded = await chat('m-429')
check('429 当次即熔断（immediate），不需要第二次确认',
  rowOf('p-429#k1')?.state === 'open' && rowOf('p-429#k1')?.consecutive === 1, JSON.stringify(rowOf('p-429#k1')))
check('429 计入 opens', service.admin.state().stats.opens >= 1)
stub.calls.length = 0
const whileOpen = await chat('m-429')
check('open 期间该 key 被完全跳过，不再打上游', whileOpen.status === 503 && stub.calls.length === 0, `calls=${stub.calls.length}`)

await cleanSlate()
await configure({ order: [{ provider: 'p-dead', model: 'm-dead' }], router: { retries: 0 } })
stub.keyStatus = { 'dd-a': 401, 'dd-b': 402 }
stub.calls.length = 0
const deadBoth = await chat('m-dead')
check('401/402 分别进拉黑表并给出原因',
  blacklistHas('p-dead#k1') && blacklistHas('p-dead#k2')
  && service.admin.state().blacklist.find((entry) => entry.unit === 'p-dead#k1')?.reason === 'authentication_error'
  && service.admin.state().blacklist.find((entry) => entry.unit === 'p-dead#k2')?.reason === 'insufficient_balance',
  JSON.stringify(service.admin.state().blacklist))
check('两把都死后原样回写最后那把的上游 402 与错误体（未注册转换器时不加工）',
  deadBoth.status === 402 && JSON.stringify(deadBoth.json) === JSON.stringify(stubErrorBody(402)),
  `${deadBoth.status} ${deadBoth.text.slice(0, 160)}`)
stub.calls.length = 0
const afterDead = await chat('m-dead')
check('拉黑后不再向上游发任何请求', afterDead.status === 503 && stub.calls.length === 0, `calls=${stub.calls.length}`)

await cleanSlate()
stub.keyStatus = { 'dd-a': 403 }
await chat('m-dead')
check('403 记为 permission_error',
  service.admin.state().blacklist.find((entry) => entry.unit === 'p-dead#k1')?.reason === 'permission_error',
  JSON.stringify(service.admin.state().blacklist))

await cleanSlate()
await configure({ order: [{ provider: 'p-half', model: 'm-half' }], router: { retries: 0, failureThreshold: 2 } })
stub.keyStatus = {}
stub.delayMs = 400
stub.calls.length = 0
const failuresBeforeAbort = service.admin.state().stats.failures
const controller = new AbortController()
const pending = fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'm-half', messages: [{ role: 'user', content: 'ping' }] }),
  signal: controller.signal,
}).then((response) => ({ status: response.status })).catch((cause) => ({ error: String(cause?.name ?? cause) }))
setTimeout(() => controller.abort(), 80)
const aborted = await pending
await sleep(200)
stub.delayMs = 0
check('客户端中止被识别为 AbortError', aborted.error === 'AbortError', JSON.stringify(aborted))
check('客户端中止不会算作熔断失败', service.admin.state().stats.failures === failuresBeforeAbort)
check('客户端中止既不熔断也不拉黑',
  rowOf('p-half#k1')?.state === 'closed' && service.admin.state().blacklist.length === 0,
  JSON.stringify({ row: rowOf('p-half#k1'), blacklist: service.admin.state().blacklist }))
check('中止的请求确实打到了上游一次', stub.calls.length === 1, String(stub.calls.length))

section('8b. live 半开：冷却后的探测真的会走一遍')

await cleanSlate()
await configure({
  order: [{ provider: 'p-half', model: 'm-half' }],
  router: { retries: 0, failureThreshold: 1, cooldownMs: 150, cooldownMaxMs: 1_000 },
})
stub.keyStatus = { 'hf-a': 500 }
stub.calls.length = 0
const openedLive = await chat('m-half')
check('live：threshold=1 时一次 500 就 open，且调用方拿到上游 500 本身',
  openedLive.status === 500 && rowOf('p-half#k1')?.state === 'open'
  && JSON.stringify(openedLive.json) === JSON.stringify(stubErrorBody(500)),
  `${openedLive.status} ${rowOf('p-half#k1')?.state} ${openedLive.text.slice(0, 120)}`)
await sleep(220)
check('live：冷却结束后变成 half-open', rowOf('p-half#k1')?.state === 'half-open', rowOf('p-half#k1')?.state)
stub.keyStatus = {}
stub.calls.length = 0
const recoveredLive = await chat('m-half')
check('live：冷却后的成功探测把断路器关回 closed',
  recoveredLive.status === 200 && rowOf('p-half#k1')?.state === 'closed' && stub.calls.length === 1,
  JSON.stringify({ status: recoveredLive.status, state: rowOf('p-half#k1')?.state, calls: stub.calls.length }))

/* ───────────────────────── 9. blacklist lifecycle ───────────────────────── */

section('9. 拉黑的生命周期')

await cleanSlate()
await configure({ order: [{ provider: 'p-dead', model: 'm-dead' }], router: { retries: 0 } })
stub.keyStatus = { 'dd-a': 401, 'dd-b': 401 }
stub.calls.length = 0
await chat('m-dead')
const marked = service.admin.state()
check('两把都被拉黑，顶层 blacklist 与每个 key 上的标记一致',
  marked.blacklist.length === 2
  && ['k1', 'k2'].every((id) => providerState('p-dead', marked).keys.find((entry) => entry.id === id)?.blacklisted === true)
  && providerState('p-dead', marked).keys.every((entry) => entry.blacklist?.provider === 'p-dead' && entry.blacklist?.keyId === entry.id),
  JSON.stringify({ blacklist: marked.blacklist, keys: providerState('p-dead', marked).keys.map((entry) => ({ id: entry.id, blacklisted: entry.blacklisted, blacklist: entry.blacklist })) }))
check('拉黑条目带着 provider/keyId/reason/message/at',
  marked.blacklist.every((entry) => entry.provider === 'p-dead' && typeof entry.keyId === 'string'
    && typeof entry.reason === 'string' && typeof entry.message === 'string' && typeof entry.at === 'string'))

const restoredOne = await post(`${base}/admin/api/keys/restore`, { provider: 'p-dead', keyId: 'k1' }, adminHeaders)
check('restore 指定 keyId 时只清该 key',
  restoredOne.json?.value?.removed === 1 && !blacklistHas('p-dead#k1') && blacklistHas('p-dead#k2'),
  JSON.stringify(restoredOne.json?.value?.state?.blacklist))
const restoredAll = await post(`${base}/admin/api/keys/restore`, { provider: 'p-dead' }, adminHeaders)
check('restore 不带 keyId 时清掉该供应商全部',
  restoredAll.json?.value?.removed === 1 && service.admin.state().blacklist.length === 0,
  JSON.stringify(restoredAll.json?.value?.state?.blacklist))

await cleanSlate()
stub.keyStatus = { 'dd-a': 401 }
await chat('m-dead')
check('轮换前确实处于拉黑状态', blacklistHas('p-dead#k1'))
await saveProvider('p-dead', { keys: [{ id: 'k1', key: 'dd-a2' }, { id: 'k2', key: 'dd-b' }] })
check('轮换该 key 的密钥后拉黑自动清除',
  !blacklistHas('p-dead#k1') && onDiskKeys('p-dead').map((entry) => entry.key).join(',') === 'dd-a2,dd-b',
  JSON.stringify(onDiskKeys('p-dead')))

stub.keyStatus = { 'dd-a2': 401 }
await chat('m-dead')
check('删除前确实处于拉黑状态', blacklistHas('p-dead#k1'))
await saveProvider('p-dead', { keys: [{ id: 'k2', key: 'dd-b' }] })
check('删除该 key 后拉黑自动清除', !blacklistHas('p-dead#k1') && providerState('p-dead').keyCount === 1)

await saveProvider('p-dead', { keys: [{ id: 'k1', key: 'dd-a2' }, { id: 'k2', key: 'dd-b' }] })
stub.keyStatus = { 'dd-a2': 401 }
await chat('m-dead')
check('删除供应商前确实处于拉黑状态', blacklistHas('p-dead#k1'))
const withoutDead = providersDoc()
delete withoutDead['p-dead']
await service.admin.save({ providers: withoutDead })
check('删除整个供应商后它的全部拉黑清除',
  !service.admin.state().blacklist.some((entry) => entry.provider === 'p-dead'),
  JSON.stringify(service.admin.state().blacklist))
await configure({ order: DEFAULT_ORDER, router: { retries: 0, failureThreshold: 2 } })

/* ───────────────────────── 10. /admin/api/models ───────────────────────── */

section('10. /admin/api/models：发现模型，但只是诊断')

await cleanSlate()
await configure({ order: [{ provider: 'p-models', model: 'm-manual' }], router: { retries: 0 } })
stub.keyStatus = {}
stub.modelsMode = 'ok'
stub.modelsBody = [{ id: 'stub-alpha' }, { id: 'stub-beta' }, { id: 'm-manual' }]
stub.calls.length = 0
const discovered = await post(`${base}/admin/api/models`, { provider: 'p-models' }, adminHeaders)
check('成功时返回模型列表',
  discovered.json?.value?.fetch?.ok === true && discovered.json.value.fetch.models.includes('stub-alpha'),
  JSON.stringify(discovered.json?.value?.fetch))
check('GET /models 带上所选 key 的 Authorization 头',
  String(stub.calls.at(-1)?.path).endsWith('/models') && stub.calls.at(-1)?.authorization === 'Bearer md-a',
  JSON.stringify(stub.calls.at(-1)?.authorization))
const discoveredProvider = providerState('p-models', discovered.json.value.state)
check('成功写入 discoveredModels',
  discoveredProvider.discoveredModels.join(',') === 'stub-alpha,stub-beta,m-manual', JSON.stringify(discoveredProvider.discoveredModels))
check('allModels = 手工在前 ∪ 已发现，按序去重',
  discoveredProvider.allModels.join(',') === 'm-manual,stub-alpha,stub-beta', JSON.stringify(discoveredProvider.allModels))

stub.calls.length = 0
const pickedKey = await post(`${base}/admin/api/models`, { provider: 'p-models', keyId: 'k2' }, adminHeaders)
check('指定 keyId 时改用那把 key 认证',
  pickedKey.json?.value?.fetch?.keyId === 'k2' && stub.calls.at(-1)?.authorization === 'Bearer md-b',
  JSON.stringify(stub.calls.at(-1)?.authorization))

const discoveredBefore = JSON.stringify(providerState('p-models').discoveredModels)
stub.modelsMode = 'unauthorized'
const modelsUnauthorized = await post(`${base}/admin/api/models`, { provider: 'p-models' }, adminHeaders)
check('GET /models 401 → ok:false 且 code=HTTP_401',
  modelsUnauthorized.json?.value?.fetch?.ok === false && modelsUnauthorized.json.value.fetch.code === 'HTTP_401',
  JSON.stringify(modelsUnauthorized.json?.value?.fetch))
check('发现失败不写入 discoveredModels',
  JSON.stringify(providerState('p-models').discoveredModels) === discoveredBefore)
check('发现失败不拉黑、不动熔断',
  service.admin.state().blacklist.length === 0 && rowOf('p-models#k1')?.state === 'closed')
stub.modelsMode = 'garbage'
const modelsGarbage = await post(`${base}/admin/api/models`, { provider: 'p-models' }, adminHeaders)
check('GET /models 坏 JSON → code=MALFORMED',
  modelsGarbage.json?.value?.fetch?.code === 'MALFORMED', JSON.stringify(modelsGarbage.json?.value?.fetch))
stub.modelsMode = 'empty'
const modelsEmpty = await post(`${base}/admin/api/models`, { provider: 'p-models' }, adminHeaders)
check('GET /models 空列表 → code=EMPTY',
  modelsEmpty.json?.value?.fetch?.code === 'EMPTY' && modelsEmpty.json.value.fetch.ok === false,
  JSON.stringify(modelsEmpty.json?.value?.fetch))
stub.modelsMode = 'ok'

/* ───────────────────────── 11. order-table reconciliation ───────────────────────── */

section('11. 路由表对账：provider 与模型都对得上')

await configure({
  order: [{ provider: 'p-recon', model: 'm-recon' }, { provider: 'p-switch', model: 'm-switch' }],
  router: { retries: 0 },
})
stub.modelsBody = [{ id: 'm-recon' }]
await post(`${base}/admin/api/models`, { provider: 'p-recon' }, adminHeaders)
const keepDocs = providersDoc()
keepDocs['p-recon'] = { ...keepDocs['p-recon'], models: ['m-other'] }
const keptRow = await service.admin.save({ providers: keepDocs })
check('已发现模型能让手工列表里没有的行继续存活',
  keptRow.removedOrderRows.length === 0 && keptRow.router.order.some((row) => row.provider === 'p-recon' && row.model === 'm-recon'),
  JSON.stringify({ removed: keptRow.removedOrderRows, order: keptRow.router.order }))

await configure({
  order: [{ provider: 'p-recon', model: 'm-recon' }, { provider: 'p-switch', model: 'm-switch' }],
  router: { retries: 0 },
})
const dropModelDocs = providersDoc()
dropModelDocs['p-switch'] = { ...dropModelDocs['p-switch'], models: ['m-other'] }
const droppedModel = await service.admin.save({ providers: dropModelDocs })
check('模型不在 allModels 里 → 该行被移除并给出 model_not_available',
  droppedModel.removedOrderRows.some((row) => row.provider === 'p-switch' && row.reason === 'model_not_available')
  && !droppedModel.router.order.some((row) => row.provider === 'p-switch'),
  JSON.stringify(droppedModel.removedOrderRows))

await configure({
  order: [{ provider: 'p-recon', model: 'm-recon' }, { provider: 'p-switch', model: 'm-switch' }],
  router: { retries: 0 },
})
const dropProviderDocs = providersDoc()
delete dropProviderDocs['p-switch']
const droppedProvider = await service.admin.save({ providers: dropProviderDocs })
check('provider 已不存在 → 该行被移除并给出 provider_not_configured',
  droppedProvider.removedOrderRows.some((row) => row.provider === 'p-switch' && row.reason === 'provider_not_configured')
  && !droppedProvider.router.order.some((row) => row.provider === 'p-switch'),
  JSON.stringify(droppedProvider.removedOrderRows))

await configure({ order: [{ provider: 'p-recon', model: 'm-recon' }], router: { retries: 0 } })
const onlyRouter = await service.admin.save({ router: { order: [{ provider: 'ghost', model: 'm' }] } })
check('只改 router 时不做对账，表原样保留',
  onlyRouter.removedOrderRows.length === 0 && onlyRouter.router.order[0]?.provider === 'ghost',
  JSON.stringify({ removed: onlyRouter.removedOrderRows, order: onlyRouter.router.order }))
check('未注册供应商的行留着一个 registered:false 的说明',
  onlyRouter.rows[0]?.registered === false, JSON.stringify(onlyRouter.rows[0]))
await configure({ order: DEFAULT_ORDER, router: { retries: 0, failureThreshold: 2 } })

/* ───────────────────────── 12. custom headers (removed) ───────────────────────── */

section('12. 自定义请求头（已整条移除）')

await cleanSlate()
await configure({ order: [{ provider: 'p-head', model: 'm-head' }], router: { retries: 0 } })
stub.keyStatus = {}
stub.calls.length = 0
await chat('m-head')
check('配置里的 headers 不再合并进上游请求（字段已移除）',
  stub.calls[0]?.headers?.['x-stub-token'] === undefined, JSON.stringify(stub.calls[0]?.headers))
check('上游只带所选 key 的 Bearer 凭据，自定义 authorization 不再覆盖',
  stub.calls[0]?.authorization === 'Bearer hd-a', JSON.stringify(stub.calls[0]?.authorization))
await saveProvider('p-head', { headers: {} })
stub.calls.length = 0
await chat('m-head')
check('再次保存后仍是 key 自己的凭据',
  stub.calls[0]?.authorization === 'Bearer hd-a', JSON.stringify(stub.calls[0]?.authorization))

/* ───────────────────────── 13. state payload & /v1 surface ───────────────────────── */

section('13. 状态载荷与 /v1 面')

await configure({
  order: [{ provider: 'p-switch', model: 'm-switch' }, { provider: 'p-nokey', model: 'm-nokey' }],
  router: { retries: 0, failureThreshold: 2 },
})
const payload = service.admin.state()
check('rows 按「顺序表行 × key」展开',
  payload.rows.length === 3 && new Set(payload.rows.map((row) => row.unit)).size === 3,
  payload.rows.map((row) => row.unit).join(','))
check('每行都带 unit 与 keyId（无密钥时为 null）',
  payload.rows.every((row) => typeof row.unit === 'string' && 'keyId' in row)
  && payload.rows.find((row) => row.provider === 'p-nokey')?.keyId === null,
  JSON.stringify(payload.rows.map((row) => ({ unit: row.unit, keyId: row.keyId }))))
check('stats 里有 ignored 与 blacklisted',
  typeof payload.stats.ignored === 'number' && typeof payload.stats.blacklisted === 'number',
  JSON.stringify(payload.stats))

await cleanSlate()
await configure({
  order: [{ provider: 'p-ignore', model: 'm-ignore' }, { provider: 'p-switch', model: 'm-switch' }],
  router: { retries: 0 },
})
stub.keyStatus = { 'ig-a': 400, 'ig-b': 400, 'sw-a': 401 }
stub.calls.length = 0
const mixed = await chat('m-ignore')
const kinds = new Set(service.admin.state().recent.map((entry) => entry.kind))
check('一次请求里 ignored/blacklist/switch 三类事件都有',
  mixed.status === 200 && kinds.has('ignored') && kinds.has('blacklist') && kinds.has('switch'), [...kinds].join(','))

await cleanSlate()
await configure({ order: [{ provider: 'p-switch', model: 'm-switch' }], router: { retries: 0 } })
stub.keyStatus = { 'sw-a': 500 }
stub.calls.length = 0
const switchedStream = await readSse(`${base}/v1/chat/completions`, {
  model: 'm-switch',
  messages: [{ role: 'user', content: 'ping' }],
  stream: true,
})
check('key 级切换后流式对调用方只有一个 200',
  switchedStream.status === 200 && stub.calls.map((call) => call.key).join(',') === 'sw-a,sw-b',
  `${switchedStream.status} ${stub.calls.map((call) => call.key).join(',')}`)
check('切换后的流仍以 [DONE] 收尾', switchedStream.payloads[switchedStream.payloads.length - 1] === '[DONE]')
check('切换后的流带着内容块',
  switchedStream.payloads.some((entry) => entry !== '[DONE]' && entry.choices?.[0]?.delta?.content === 'pong'))

/* ───────────────────────── 14. failure classifier (pure) ───────────────────────── */

section('14. 失败分类与拉黑判定（纯函数）')

check('ABORTED/499 是 client_cancel',
  F.classifyFailure({ code: 'ABORTED' }).cls === 'client_cancel' && F.classifyFailure({ status: 499 }).cls === 'client_cancel')
check('400/404/405 等请求自身的错是 non_retryable',
  [400, 404, 405, 413, 422].every((status) => F.classifyFailure({ status }).cls === 'non_retryable'))
check('TIMEOUT/TRANSPORT/5xx 是 retryable',
  F.classifyFailure({ code: 'TIMEOUT' }).cls === 'retryable'
  && F.classifyFailure({ code: 'TRANSPORT' }).cls === 'retryable'
  && F.classifyFailure({ status: 500 }).cls === 'retryable')
check('429/503/529 是 overloaded',
  [429, 503, 529].every((status) => F.classifyFailure({ status }).cls === 'overloaded'))
check('认证/余额/权限文案先于状态码判定',
  F.classifyFailure({ status: 400, body: { error: { message: 'invalid api key' } } }).cls === 'non_retryable'
  && F.classifyFailure({ status: 400, body: { error: { message: '账户余额不足' } } }).cls === 'quota'
  && F.classifyFailure({ status: 400, body: { error: { message: 'permission denied' } } }).cls === 'non_retryable')
check('只有 retryable/overloaded 计入熔断',
  F.isBreakerRelevant('retryable') && F.isBreakerRelevant('overloaded')
  && !F.isBreakerRelevant('non_retryable') && !F.isBreakerRelevant('quota') && !F.isBreakerRelevant('client_cancel'))
check('只有 overloaded 是当次即开',
  F.opensImmediately('overloaded') && !F.opensImmediately('retryable') && !F.opensImmediately('non_retryable'))
check('blacklistVerdict：401 → authentication_error',
  F.blacklistVerdict({ status: 401 }).should === true && F.blacklistVerdict({ status: 401 }).reason === 'authentication_error')
check('blacklistVerdict：402 或余额文案 → insufficient_balance',
  F.blacklistVerdict({ status: 402 }).reason === 'insufficient_balance'
  && F.blacklistVerdict({ status: 400, body: { error: { message: 'insufficient balance' } } }).reason === 'insufficient_balance')
check('blacklistVerdict：403 或权限文案 → permission_error',
  F.blacklistVerdict({ status: 403 }).reason === 'permission_error'
  && F.blacklistVerdict({ status: 400, body: { error: { message: 'permission denied' } } }).reason === 'permission_error')
check('blacklistVerdict：容量类失败（429/503）不拉黑',
  F.blacklistVerdict({ status: 429 }).should === false && F.blacklistVerdict({ status: 503 }).should === false)
check('blacklistVerdict 把 retry-after 变成 recoverAt',
  F.blacklistVerdict({ status: 402, retryAfterMs: 60_000 }, { now: 1_000 }).recoverAt === new Date(61_000).toISOString(),
  F.blacklistVerdict({ status: 402, retryAfterMs: 60_000 }, { now: 1_000 }).recoverAt)

section('14b. 运行态存储（纯函数）')
{
  const stateFile = join(process.env.DSH_HOME, 'unit-state.json')
  let clock = 5_000_000
  const store = S.createStateStore({ file: stateFile, now: () => clock })
  store.mark('p#k1', { provider: 'p', keyId: 'k1', reason: 'authentication_error', message: 'invalid api key' })
  check('mark 之后 blocked 与 entries 都能读到',
    store.blocked('p#k1')?.reason === 'authentication_error' && store.entries().length === 1)
  store.mark('p#k2', { provider: 'p', keyId: 'k2', reason: 'insufficient_balance', message: 'x', recoverAt: new Date(clock - 1).toISOString() })
  check('recoverAt 到期后条目自动消失', store.blocked('p#k2') === null)
  check('clearProvider 可以只清一个 key', store.clearProvider('p', 'k1') === 1 && store.blocked('p#k1') === null)
  store.mark('p#k1', { provider: 'p', keyId: 'k1', reason: 'permission_error', message: 'x' })
  store.mark('p#k3', { provider: 'p', keyId: 'k3', reason: 'permission_error', message: 'x' })
  check('clearProvider 不带 keyId 时清掉整个供应商', store.clearProvider('p') === 2 && store.entries().length === 0)
  store.setDiscovered('p', ['a', 'b'])
  check('setDiscovered 记住列表并去重', store.discovered('p').join(',') === 'a,b')
  check('setDiscovered 的空列表不覆盖已有列表', store.setDiscovered('p', []).join(',') === 'a,b')
  check('快照暴露文件路径与版本', store.snapshot().file === stateFile && typeof store.snapshot().version === 'number')
}

/* ───────────────────────── 15. router unit: two thresholds & half-open ───────────────────────── */

section('15. 双阈值与 half-open（注入时钟，确定性）')

check('unitKey 与 splitUnitKey 互为逆运算',
  R.unitKey('p', null) === 'p' && R.unitKey('p', 'k1') === 'p#k1'
  && JSON.stringify(R.splitUnitKey('p#k1')) === JSON.stringify({ provider: 'p', keyId: 'k1' })
  && JSON.stringify(R.splitUnitKey('p')) === JSON.stringify({ provider: 'p', keyId: null }))

{
  const cfg = R.normalizeRouterConfig({ failureThreshold: 3, minSamples: 100, failureRateThreshold: 1, cooldownMs: 1_000 })
  let t = 2_000_000
  const router = R.createRouter(cfg, () => t)
  const failure = { code: 'HTTP_500', status: 500 }
  check('连续失败第 1 次不开', router.recordFailure('u', failure, t) === R.CLOSED)
  t += 1
  check('连续失败第 2 次仍不开', router.recordFailure('u', failure, t) === R.CLOSED)
  t += 1
  check('连续失败达到 failureThreshold 才开', router.recordFailure('u', failure, t) === R.OPEN)
  check('open 时跳过、available 为 false', router.stateOf('u', t) === R.OPEN && router.available('u', t) === false)
}

{
  const cfg = R.normalizeRouterConfig({ failureThreshold: 100, minSamples: 5, failureRateThreshold: 0.5, cooldownMs: 1_000 })
  let t = 3_000_000
  const router = R.createRouter(cfg, () => t)
  const failure = { code: 'HTTP_500', status: 500 }
  router.recordSuccess('low', t)
  router.recordSuccess('low', t)
  router.recordSuccess('low', t)
  router.recordSuccess('low', t)
  check('样本够但失败率不够时不开（rate 0.2）', router.recordFailure('low', failure, t) === R.CLOSED)
  router.recordSuccess('gate', t)
  router.recordFailure('gate', failure, t)
  router.recordFailure('gate', failure, t)
  check('样本不足 minSamples 时失败率再高也不开（4 样本 3 失败）', router.recordFailure('gate', failure, t) === R.CLOSED)
  check('样本凑够后按失败率开（5 样本 4 失败 ≥ 0.5）', router.recordFailure('gate', failure, t) === R.OPEN)
}

{
  const cfg = R.normalizeRouterConfig({ failureThreshold: 1, minSamples: 100, cooldownMs: 100, cooldownFactor: 2, cooldownMaxMs: 1_000, halfOpenSuccesses: 2 })
  let t = 4_000_000
  const router = R.createRouter(cfg, () => t)
  const failure = { code: 'HTTP_500', status: 500 }
  check('一次失败就开（threshold 1）', router.recordFailure('u', failure, t) === R.OPEN)
  t += 101
  check('冷却结束后进入 half-open', router.stateOf('u', t) === R.HALF_OPEN)
  check('half-open 时 available 允许一次探测', router.available('u', t) === true)
  router.noteSelected('u', t)
  check('探测在飞时不接第二个请求（租约唯一）', router.available('u', t) === false)
  check('第一次成功后仍是 half-open（需要 2 次）', router.recordSuccess('u', t) === R.HALF_OPEN)
  check('探测一结束就释放租约，不用再等一个冷却', router.available('u', t) === true)
  router.noteSelected('u', t)
  check('第二次连续成功才 closed', router.recordSuccess('u', t) === R.CLOSED && router.stateOf('u', t) === R.CLOSED)
  check('closed 后 trips 归零', router.describe('u', t).trips === 0)
}

{
  const cfg = R.normalizeRouterConfig({ failureThreshold: 1, minSamples: 100, cooldownMs: 100, halfOpenSuccesses: 2 })
  let t = 4_500_000
  const router = R.createRouter(cfg, () => t)
  const failure = { code: 'HTTP_500', status: 500 }
  router.recordFailure('r', failure, t)
  t += 101
  router.noteSelected('r', t)
  check('releaseProbe：没有裁决的探测可以主动交还租约',
    router.releaseProbe('r', t) === true && router.available('r', t) === true)
  check('releaseProbe 对没有租约的单元是空操作（幂等）',
    router.releaseProbe('r', t) === false && router.releaseProbe('nobody', t) === false)
  check('releaseProbe 不改变熔断状态本身', router.stateOf('r', t) === R.HALF_OPEN)
}

{
  const cfg = R.normalizeRouterConfig({ failureThreshold: 1, minSamples: 100, cooldownMs: 100, cooldownFactor: 2, cooldownMaxMs: 1_000, halfOpenSuccesses: 2 })
  let t = 5_000_000
  const router = R.createRouter(cfg, () => t)
  const failure = { code: 'HTTP_500', status: 500 }
  router.recordFailure('u', failure, t)
  const firstOpenUntil = router.describe('u', t).openUntil
  t += 101
  check('冷却后是 half-open', router.stateOf('u', t) === R.HALF_OPEN)
  router.noteSelected('u', t)
  check('半开期间的失败立即重新 open', router.recordFailure('u', failure, t) === R.OPEN)
  const secondOpenUntil = router.describe('u', t).openUntil
  check('重新 open 的冷却升级（openUntil 变大）', secondOpenUntil > firstOpenUntil,
    JSON.stringify({ firstOpenUntil, secondOpenUntil }))
  t += 201
  router.stateOf('u', t)
  router.noteSelected('u', t)
  router.recordFailure('u', failure, t)
  check('第三次开继续升级', router.describe('u', t).openUntil > secondOpenUntil,
    JSON.stringify({ secondOpenUntil, third: router.describe('u', t).openUntil }))
}

{
  const cfg = R.normalizeRouterConfig({ failureThreshold: 1, cooldownMs: 0, cooldownFactor: 1, cooldownMaxMs: 1_000 })
  const t = 6_000_000
  const router = R.createRouter(cfg, () => t)
  check('cooldownMs=0 时任一次失败后立刻可恢复（half-open）',
    router.recordFailure('u', { code: 'HTTP_500', status: 500 }, t) === R.OPEN && router.stateOf('u', t) === R.HALF_OPEN)
  const immediate = R.normalizeRouterConfig({ failureThreshold: 1, cooldownMs: 0, recoveryMode: 'immediate' })
  const direct = R.createRouter(immediate, () => t)
  direct.recordFailure('u', { code: 'HTTP_500', status: 500 }, t)
  check('recoveryMode=immediate 且冷却为 0 时直接回到 closed', direct.stateOf('u', t) === R.CLOSED)
  check('immediate 恢复会清掉连败计数', direct.describe('u', t).consecutive === 0)
}

check('switchBudget 的 auto 等于候选单位数',
  R.switchBudget({ maxSwitches: 0, order: [{}, {}] }, 5) === 5 && R.switchBudget({ maxSwitches: 2, order: [{}] }, 5) === 2)
check('冷却上限不会低于基础冷却',
  R.normalizeRouterConfig({ cooldownMs: 5_000, cooldownMaxMs: 1_000 }).cooldownMaxMs === 5_000)
check('未知档位/日志级别会回落',
  R.normalizeRouterConfig({ recoveryMode: 'x', logLevel: 'y' }).recoveryMode === 'probe'
  && R.normalizeRouterConfig({ recoveryMode: 'x', logLevel: 'y' }).logLevel === 'info')

/* ───────────────────────── 16. converter registry ───────────────────────── */

section('16. 转换器注册表：没注册就原样透传')

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
  return throws(() => registry.register(defineConverter({ id: 'dup' })))
})())
check('非法 id 会被拒绝', throws(() => registry.register(defineConverter({ id: 'Bad Id!' }))))
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

/* ───────────────────────── 16a. 参照契约的 role 归一 ───────────────────────── */

section('16a. 发往上游的消息 role 归一（developer → system）')

const { normalizeReferenceBody } = await import('../lib/service/proxy.js')
check('参照契约不认识 developer：被归一成 system', (() => {
  const out = normalizeReferenceBody({ model: 'm', messages: [{ role: 'developer', content: 'be terse' }, { role: 'user', content: 'hi' }] })
  return out.messages[0].role === 'system' && out.messages[1].role === 'user'
})())
check('已知 role 一律不动', (() => {
  const body = { messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }, { role: 'assistant', content: 'a' }, { role: 'tool', tool_call_id: 't', content: 'r' }] }
  return normalizeReferenceBody(body) === body
})())
check('没有 messages 的 body 原样返回', (() => {
  const body = { model: 'm' }
  return normalizeReferenceBody(body) === body
})())
check('非对象 body 原样返回', (() => {
  const empty = []
  return normalizeReferenceBody(null) === null && normalizeReferenceBody(empty) === empty
})())
check('多个 developer 全部归一、其余字段保留', (() => {
  const out = normalizeReferenceBody({ model: 'm', x: 1, messages: [{ role: 'developer', content: 'a' }, { role: 'developer', content: 'b' }, { role: 'user', content: 'c' }] })
  return out.messages.every((entry) => entry.role !== 'developer')
    && out.messages[0].role === 'system' && out.messages[0].content === 'a'
    && out.messages[1].role === 'system'
    && out.messages[2].role === 'user'
    && out.x === 1 && out.model === 'm'
})())
check('归一不吞掉原始 body 的形状（顶层仍是对象）', (() => {
  const out = normalizeReferenceBody({ messages: [{ role: 'developer', content: 'x' }] })
  return typeof out === 'object' && out !== null && typeof out.messages.push === 'function'
})())

/* ───────────────────────── 17. SSE parsing ───────────────────────── */

section('17. 上游读流与 URL 拼接')

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

/* ───────────────────────── 18. admin face ───────────────────────── */

section('18. 管理面：没有令牌就进不来')

const noToken = await get(`${base}/admin/api/state`)
check('无令牌访问管理面 → 401', noToken.status === 401, String(noToken.status))
const wrongToken = await get(`${base}/admin/api/state`, { 'x-router-token': 'nope' })
check('错令牌同样 401', wrongToken.status === 401)
const stateRes = await get(`${base}/admin/api/state`, adminHeaders)
check('带令牌可以读状态', stateRes.json?.ok === true && Array.isArray(stateRes.json.value.rows))
check('状态里带着限额、恢复模式与日志级别',
  typeof stateRes.json.value.limits?.orderRows === 'number'
  && stateRes.json.value.recoveryModes.includes('probe')
  && stateRes.json.value.logLevels.includes('debug'))
check('状态里说明哪些供应商被转换器接管',
  stateRes.json.value.converters?.[0]?.id === 'maas' && stateRes.json.value.converters[0].providers.length >= 1,
  JSON.stringify(stateRes.json.value.converters))
check('GET 一个 POST-only 动作 → 405', (await get(`${base}/admin/api/config`, adminHeaders)).status === 405)
check('POST 一个 GET-only 动作 → 405', (await post(`${base}/admin/api/state`, {}, adminHeaders)).status === 405)
check('非 loopback 对端被 isLoopback 判定为 false',
  isLoopback({ socket: { remoteAddress: '10.1.2.3' } }) === false
  && isLoopback({ socket: { remoteAddress: '::ffff:127.0.0.1' } }) === true)
const home = await get(`${base}/`)
check('管理页在 / 上可读（无需令牌，页面自带令牌）',
  home.status === 200 && String(home.headers.get('content-type')).includes('text/html'))
const notFound = await get(`${base}/nope`)
check('未知路径返回参照契约的错误形状', notFound.status === 404 && notFound.json?.error?.code === 'not_found')
check('错误方法被拒绝', [404, 405].includes((await get(`${base}/v1/chat/completions`)).status))

/* ───────────────────────── 19. --check mode ───────────────────────── */

section('19. --check 模式能独立跑通')

let checkSummary = null
try {
  const outcome = await run(process.execPath, ['lib/service/main.js', '--check'], { cwd: ROOT, env: { ...process.env } })
  checkSummary = JSON.parse(outcome.stdout)
} catch (cause) {
  checkSummary = null
  check('--check 在良好配置上退出码为 0', false, String(cause?.message ?? cause))
}
check('--check 打印可解析的摘要', checkSummary !== null && typeof checkSummary.port === 'number' && Array.isArray(checkSummary.providers))
check('--check 摘要含每个供应商的密钥数',
  typeof checkSummary?.keys === 'object' && Number.isInteger(checkSummary.keys['p-switch']), JSON.stringify(checkSummary?.keys))
check('--check 报告转换器加载情况', checkSummary?.convertersLoaded?.includes('maas') === true)
check('--check 在良好文件上报告 created:false/repaired:false',
  checkSummary?.created === false && checkSummary?.repaired === false,
  JSON.stringify({ created: checkSummary?.created, repaired: checkSummary?.repaired }))

/* ───────────────────────── 20. runtime persistence ───────────────────────── */

section('20. 运行态持久化：拉黑与已发现模型都留在盘上')

await cleanSlate()
await configure({
  order: [{ provider: 'p-dead', model: 'm-dead' }, { provider: 'p-models', model: 'm-manual' }],
  router: { retries: 0 },
})
const configBeforeStateWrites = readFileSync(process.env.ROUTER_SERVICE_CONFIG, 'utf8')
stub.keyStatus = { 'dd-a': 401 }
stub.modelsMode = 'ok'
stub.modelsBody = [{ id: 'disc-one' }]
await chat('m-dead')
await post(`${base}/admin/api/models`, { provider: 'p-models' }, adminHeaders)
await sleep(450)
const persisted = JSON.parse(readFileSync(process.env.ROUTER_SERVICE_STATE, 'utf8'))
check('拉黑写进运行态文件',
  persisted.blacklist['p-dead#k1']?.reason === 'authentication_error', JSON.stringify(persisted.blacklist))
check('已发现模型写进运行态文件',
  (persisted.discovered['p-models'] ?? []).includes('disc-one'), JSON.stringify(persisted.discovered))
check('运行态文件权限是 0600', (statSync(process.env.ROUTER_SERVICE_STATE).mode & 0o777) === 0o600,
  (statSync(process.env.ROUTER_SERVICE_STATE).mode & 0o777).toString(8))
check('写运行态不会改动配置文件（不会触发外部改动重载误判）',
  readFileSync(process.env.ROUTER_SERVICE_CONFIG, 'utf8') === configBeforeStateWrites)
check('配置读回后不需要修复（repaired === false）', C.readConfig({ seed: false }).repaired === false)

await service.stop()
await sleep(100)
// A brand-new instance reading the same runtime state, on a fresh port so the
// HTTP client cannot reuse a socket the old listener owned.
const restartPort = await freePort()
const restartDoc = JSON.parse(readFileSync(process.env.ROUTER_SERVICE_CONFIG, 'utf8'))
restartDoc.server.port = restartPort
writeFileSync(process.env.ROUTER_SERVICE_CONFIG, `${JSON.stringify(restartDoc, null, 2)}\n`)
service = await startService({ listen: true, poll: false, logger: quiet })
base = `http://127.0.0.1:${service.bound.port}`
check('新实例绑定了配置里的新端口', service.bound.port === restartPort, `${service.bound.port} vs ${restartPort}`)
const afterRestartState = service.admin.state()
check('重启后拉黑仍在',
  afterRestartState.blacklist.some((entry) => entry.unit === 'p-dead#k1' && entry.reason === 'authentication_error'),
  JSON.stringify(afterRestartState.blacklist))
check('重启后已发现模型仍在',
  (providerState('p-models', afterRestartState).discoveredModels ?? []).includes('disc-one'))
await configure({ order: [{ provider: 'p-dead', model: 'm-dead' }], router: { retries: 0 } })
stub.keyStatus = {}
stub.calls.length = 0
const skipped = await chat('m-dead')
check('重启后仍然跳过被拉黑的 key（只打另一把）',
  skipped.status === 200 && stub.calls.map((call) => call.key).join(',') === 'dd-b', stub.calls.map((call) => call.key).join(','))

/* ───────────────────────── 20b. live thresholds ───────────────────────── */

section('20b. live 双阈值与 half-open（经配置保存后真的生效）')

await cleanSlate()
await configure({
  order: [{ provider: 'p-half', model: 'm-half' }],
  router: {
    retries: 0,
    failureThreshold: 1,
    cooldownMs: 150,
    cooldownMaxMs: 1_000,
    halfOpenSuccesses: 2,
    minSamples: 100,
    failureRateThreshold: 1,
    windowSize: 20,
  },
})
const savedRouter = service.admin.state().router
check('保存的 halfOpenSuccesses/minSamples/failureRateThreshold/windowSize 如实生效（读时不再被丢掉）',
  savedRouter.halfOpenSuccesses === 2 && savedRouter.minSamples === 100
  && savedRouter.failureRateThreshold === 1 && savedRouter.windowSize === 20,
  JSON.stringify({ halfOpenSuccesses: savedRouter.halfOpenSuccesses, minSamples: savedRouter.minSamples, failureRateThreshold: savedRouter.failureRateThreshold, windowSize: savedRouter.windowSize }))
stub.keyStatus = { 'hf-a': 500 }
stub.calls.length = 0
const halfOpenOpened = await chat('m-half')
check('live：一次 500 就 open（failureThreshold=1），错误体仍是上游 500 的合同形状',
  halfOpenOpened.status === 500 && rowOf('p-half#k1')?.state === 'open'
  && halfOpenOpened.json?.error?.type === 'server_error', `${halfOpenOpened.status} ${rowOf('p-half#k1')?.state}`)
await sleep(220)
stub.keyStatus = {}
stub.calls.length = 0
const probeOne = await chat('m-half')
check('live：halfOpenSuccesses=2 时第一次成功探测后仍是 half-open',
  probeOne.status === 200 && rowOf('p-half#k1')?.state === 'half-open' && rowOf('p-half#k1')?.halfOpenSuccesses === 1,
  JSON.stringify({ status: probeOne.status, row: rowOf('p-half#k1') }))
// A settled probe holds its half-open lease until the cooldown elapses, so the
// second confirmation has to wait it out (named explicitly in the report).
await sleep(220)
stub.calls.length = 0
const probeTwo = await chat('m-half')
check('live：租约到期后第二次连续成功才 closed',
  probeTwo.status === 200 && rowOf('p-half#k1')?.state === 'closed' && stub.calls.length === 1,
  JSON.stringify({ status: probeTwo.status, state: rowOf('p-half#k1')?.state, calls: stub.calls.length }))

await cleanSlate()
await configure({
  order: [{ provider: 'p-half', model: 'm-half' }],
  router: {
    retries: 0,
    failureThreshold: 100,
    minSamples: 4,
    failureRateThreshold: 0.5,
    windowSize: 20,
    halfOpenSuccesses: 1,
    cooldownMs: 30_000,
    cooldownMaxMs: 600_000,
  },
})
stub.keyStatus = {}
await chat('m-half')
stub.keyStatus = { 'hf-a': 500 }
await chat('m-half')
await chat('m-half')
check('live：样本不足 minSamples 时失败率再高也不开',
  rowOf('p-half#k1')?.state === 'closed', JSON.stringify(rowOf('p-half#k1')))
await chat('m-half')
check('live：样本凑够后按 failureRateThreshold 打开',
  rowOf('p-half#k1')?.state === 'open', JSON.stringify(rowOf('p-half#k1')))

/* ───────────────────────── 21. plugin side: fork, attach, relay ───────────────────────── */

section('21. 插件侧：真的能把这个服务拉起来并转达')

{
  const forkPort = await freePort()
  const forkConfig = join(process.env.DSH_HOME, 'fork-service.json')
  const forkState = join(process.env.DSH_HOME, 'fork-service.state.json')
  writeFileSync(forkConfig, `${JSON.stringify({
    server: { host: '127.0.0.1', port: forkPort, token: 'fork-token' },
    providers: {
      'maas-dsv4': { label: 'dsv4', baseURL: stubBase, keys: [{ id: 'k1', key: 'gw-good' }], models: ['deepseek-v4-flash'] },
    },
    router: {
      enabled: true,
      order: [{ provider: 'maas-dsv4', model: 'deepseek-v4-flash' }],
      retries: 0,
      failureThreshold: 2,
      logLevel: 'silent',
    },
    converters: ['maas'],
  }, null, 2)}\n`)

  const { createServiceClient } = await import('../lib/service-client.js')
  const client = createServiceClient({ logger: quiet }, { configFile: forkConfig, restart: false })
  // The child inherits this process's environment; give it a state file of its
  // own so the two services never contend for one document.
  const parentStateEnv = process.env.ROUTER_SERVICE_STATE
  process.env.ROUTER_SERVICE_STATE = forkState
  const started = await client.start()
  process.env.ROUTER_SERVICE_STATE = parentStateEnv
  check('插件能把这个服务拉起来',
    started.mode === 'started' && started.url === `http://127.0.0.1:${forkPort}`, JSON.stringify(started))
  check('客户端把自己指向了被拉起的那个地址',
    client.url() === `http://127.0.0.1:${forkPort}` && client.configFile() === forkConfig)
  check('客户端读到的是同一个服务，不是另一份配置', await client.ping())

  const view = await client.view()
  check('view() 转达服务的实时状态',
    view.available === true && view.url === `http://127.0.0.1:${forkPort}`
    && Array.isArray(view.live?.rows) && view.live.rows.length === 1,
    JSON.stringify({ available: view.available, error: view.error }))
  check('令牌来自被拉起那份配置', client.token() === 'fork-token')

  const probed = await client.call('probe', { provider: 'maas-dsv4', model: 'deepseek-v4-flash' })
  check('转达动作拿到服务的答案', probed.ok === true && probed.value?.probe?.ok === true, JSON.stringify(probed).slice(0, 200))
  const reset = await client.call('reset', {})
  check('转达 reset 同样可用', reset.ok === true && reset.value?.stats?.requests === 0)

  const secondClient = createServiceClient({ logger: quiet }, { configFile: forkConfig, restart: false })
  const attached = await secondClient.start()
  check('已有服务在跑时改为接入，而不是再拉一个', attached.mode === 'attached', JSON.stringify(attached))
  secondClient.stop()
  check('接入方 stop() 不会杀掉不属于它的服务', await secondClient.ping())

  client.stop()
  await sleep(400)
  let gone = false
  try {
    await fetch(`http://127.0.0.1:${forkPort}/healthz`, { signal: AbortSignal.timeout(1_000) })
  } catch {
    gone = true
  }
  check('自己拉起的服务在 disposer 里被停掉（随 DSH 退出）', gone)
  check('停止后底层的端口确实释放了', await canBind(forkPort))
}

/* ───────────────────────── 22. readConfig file semantics ───────────────────────── */

section('22. readConfig：缺失时 seed、坏文件只在内存里修复')

{
  const original = readFileSync(process.env.ROUTER_SERVICE_CONFIG, 'utf8')
  try {
    rmSync(process.env.ROUTER_SERVICE_CONFIG, { force: true })
    const seeded = C.readConfig({ seed: true })
    check('文件缺失时按需创建并报告 created', seeded.created === true && typeof seeded.config.server.port === 'number')
    check('缺失时 seed 出的文档预置了 MaaS 路由且不带密钥',
      'maas-dsv4' in seeded.config.providers && 'maas-coclaw' in seeded.config.providers
      && Object.values(seeded.config.providers).every((provider) => provider.keys.length === 0))
    rmSync(process.env.ROUTER_SERVICE_CONFIG, { force: true })
    const unseeded = C.readConfig({ seed: false })
    check('seed:false 不会写新文件', !existsSync(process.env.ROUTER_SERVICE_CONFIG) && unseeded.created === false)

    writeFileSync(process.env.ROUTER_SERVICE_CONFIG, '{not json')
    const broken = C.readConfig({ seed: false })
    check('坏文件在内存里就地修复并报告 repaired',
      broken.repaired === true && broken.config.router.order.length === 0 && broken.config.server.port === 8790)
    check('坏文件不会被覆盖（人工半途修改不该被抹掉）',
      readFileSync(process.env.ROUTER_SERVICE_CONFIG, 'utf8') === '{not json')

    writeFileSync(process.env.ROUTER_SERVICE_CONFIG, JSON.stringify({
      server: { port: 'abc' },
      router: { order: [{ provider: 'a', model: 'b' }, { provider: '' }, 'nope'] },
    }))
    const repaired = C.readConfig({ seed: false })
    check('读时修复：坏端口回落、坏行被丢掉',
      repaired.config.server.port === 8790 && repaired.config.router.order.length === 1 && repaired.repaired === true,
      JSON.stringify(repaired.config.router.order))
  } finally {
    writeFileSync(process.env.ROUTER_SERVICE_CONFIG, original)
  }
}

/* ───────────────────────── 23. stop ───────────────────────── */

section('23. 停得下来')

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

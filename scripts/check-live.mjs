/**
 * The live end-to-end check: the routing service against the real ZTE MaaS
 * gateway.
 *
 * Deliberately **not** part of `npm run check`. It needs the network, it needs
 * the operator's own credentials, and it spends real tokens — three things a
 * self-check must never require. What it buys is the only evidence that cannot
 * be faked: the converter's field mappings were read off two real endpoints
 * (recorded in `docs/HISTORY.md`), and this is how they were read.
 *
 * Credentials come from the DSH credential store by reference name; nothing is
 * printed, and the throwaway service configuration it writes is deleted on the
 * way out.
 *
 * Usage: `npm run check:live` (needs network, and `MAAS_DSV4_API_KEY` +
 * `MAAS_COCLAW_API_KEY` present in `$DSH_HOME/.credentials.yaml`).
 */
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const CRED = join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.credentials.yaml')

/**
 * Minimal reader for the credential store's `refs:` mapping. A missing store is
 * not an error here: it means the operator has not configured the two refs, and
 * the caller reports that as a refusal before anything is called.
 */
function readCredential(name) {
  if (!existsSync(CRED)) return ''
  const text = readFileSync(CRED, 'utf8')
  const lines = text.split('\n')
  for (const line of lines) {
    const m = /^\s{2}([A-Za-z0-9_/-]+):\s*(.*)$/.exec(line)
    if (m === null) continue
    if (m[1] !== name) continue
    let value = m[2].trim()
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1)
    }
    return value
  }
  return ''
}

const dsv4Key = readCredential('MAAS_DSV4_API_KEY')
const clawKey = readCredential('MAAS_COCLAW_API_KEY')
if (dsv4Key === '' || clawKey === '') {
  process.stderr.write('MISSING CREDENTIALS: set MAAS_DSV4_API_KEY and MAAS_COCLAW_API_KEY in $DSH_HOME/.credentials.yaml, or run with network access to the gateway. Nothing was called.\n')
  process.exit(2)
}
console.log('credentials found: dsv4 + co-claw (values never printed)')

const home = mkdtempSync(join(tmpdir(), 'router-live-'))
process.env.DSH_HOME = home
process.env.ROUTER_SERVICE_CONFIG = join(home, 'router-service.json')

function freePort() {
  return new Promise((res) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => res(port))
    })
  })
}
const port = await freePort()
const token = 'live-test-token'

writeFileSync(process.env.ROUTER_SERVICE_CONFIG, `${JSON.stringify({
  server: { host: '127.0.0.1', port, token },
  providers: {
    'maas-dsv4': {
      label: 'ZTE MaaS deepseek-v4-flash',
      baseURL: 'https://maas-apigateway.dt.zte.com.cn/model/deepseek-v4-flash/v1',
      keys: [{ id: 'k1', label: 'primary', key: dsv4Key }],
      models: ['deepseek-v4-flash'],
    },
    'maas-coclaw': {
      label: 'ZTE MaaS co-claw',
      baseURL: 'https://maas-apigateway.dt.zte.com.cn/model-cop/co-claw/v1',
      keys: [{ id: 'k1', label: 'primary', key: clawKey }],
      models: ['co-claw'],
    },
  },
  router: {
    enabled: true,
    order: [
      { provider: 'maas-dsv4', model: 'deepseek-v4-flash' },
      { provider: 'maas-coclaw', model: 'co-claw' },
    ],
    retries: 1,
    failureThreshold: 2,
    recoveryMode: 'probe',
    logLevel: 'silent',
  },
  converters: ['maas'],
}, null, 2)}\n`, { mode: 0o600 })

const { startService } = await import('../lib/service/main.js')
const quiet = { error() {}, warn() {}, info() {}, debug() {} }
const service = await startService({ listen: true, poll: false, logger: quiet })
const base = `http://127.0.0.1:${service.bound.port}`
const H = { 'content-type': 'application/json' }
console.log('service up on', base)

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// 1. /v1/models — the endpoint the gateway 404s
{
  const r = await fetch(`${base}/v1/models`)
  const j = await r.json()
  record('GET /v1/models 合成成功', r.status === 200 && j.object === 'list' && j.data.length >= 2, JSON.stringify(j.data?.map((m) => m.id)))
}

// 2. non-streaming, thinking explicitly disabled
{
  const body = { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'Reply with exactly: OK' }], thinking: { type: 'disabled' }, max_completion_tokens: 32 }
  const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: H, body: JSON.stringify(body) })
  const j = await r.json()
  const msg = j.choices?.[0]?.message
  record('非流式 200', r.status === 200, `${r.status} ${JSON.stringify(j).slice(0, 160)}`)
  record('model 回显请求名', j.model === 'deepseek-v4-flash', j.model)
  record('thinking={type:disabled} 真的关掉了思考（无 reasoning_content）', msg?.reasoning_content === undefined, JSON.stringify({ content: msg?.content, reasoning_content: msg?.reasoning_content }))
  record('message 只有参照契约的字段', msg !== undefined && !('reasoning' in msg) && !('audio' in msg) && !('annotations' in msg) && !('refusal' in msg), JSON.stringify(Object.keys(msg ?? {})))
  record('顶层没有网关噪声字段', j.prompt_token_ids === undefined && j.prompt_text === undefined && j.service_tier === undefined && j.metrics === undefined && j.kv_transfer_params === undefined, JSON.stringify(Object.keys(j)))
  record('usage 归一到参照契约', Number.isFinite(j.usage?.prompt_tokens) && Number.isFinite(j.usage?.completion_tokens) && j.usage?.prompt_cache_miss_tokens !== undefined, JSON.stringify(j.usage))
  record('reasoning_tokens 是 0 而不是编造的数', j.usage?.completion_tokens_details?.reasoning_tokens === 0, JSON.stringify(j.usage?.completion_tokens_details))
  record('补上了 system_fingerprint', typeof j.system_fingerprint === 'string', j.system_fingerprint)
}

// 3. non-streaming, thinking explicitly enabled
{
  const body = { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'What is 2+2? Reply with just the number.' }], thinking: { type: 'enabled', budget_tokens: 2048 }, max_tokens: 64 }
  const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: H, body: JSON.stringify(body) })
  const j = await r.json()
  const msg = j.choices?.[0]?.message
  record('开启思考时 reasoning_content 存在', r.status === 200 && typeof msg?.reasoning_content === 'string' && msg.reasoning_content.length > 0, `${r.status} reasoningChars=${msg?.reasoning_content?.length ?? 0} content=${JSON.stringify(msg?.content)?.slice(0, 60)}`)
  const rt = j.usage?.completion_tokens_details?.reasoning_tokens
  record('开启思考时 reasoning_tokens 要么如实报数要么缺席，绝不编造',
    rt === undefined || (Number.isFinite(rt) && rt > 0), JSON.stringify({ reasoning_tokens: rt, reasoningChars: msg?.reasoning_content?.length ?? 0 }))
}

// 4. streaming
{
  const body = { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'Count to three.' }], thinking: { type: 'disabled' }, stream: true, max_tokens: 32 }
  const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: H, body: JSON.stringify(body) })
  const text = await r.text()
  const chunks = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
  const done = chunks[chunks.length - 1] === '[DONE]'
  const parsed = chunks.filter((c) => c !== '[DONE]').map((c) => { try { return JSON.parse(c) } catch { return null } }).filter(Boolean)
  record('流式以 [DONE] 收尾', r.status === 200 && done, `${r.status} frames=${parsed.length}`)
  record('每个分片都是参照契约的形状', parsed.every((c) => c.object === 'chat.completion.chunk' && c.model === 'deepseek-v4-flash'), JSON.stringify(parsed[0]))
  record('分片里没有网关噪声字段', parsed.every((c) => c.prompt_token_ids === undefined && c.service_tier === undefined), JSON.stringify(Object.keys(parsed[0] ?? {})))
  record('末片带 usage', parsed.some((c) => c.usage?.prompt_tokens > 0), JSON.stringify(parsed.at(-1)?.usage))
}

// 5. co-claw: the route whose default is thinking ON
{
  const body = { model: 'co-claw', messages: [{ role: 'user', content: 'Reply with exactly: OK' }], thinking: { type: 'disabled' }, max_tokens: 32 }
  const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: H, body: JSON.stringify(body) })
  const j = await r.json()
  const msg = j.choices?.[0]?.message
  record('co-claw 走同一转换器且 200', r.status === 200, `${r.status} ${JSON.stringify(j).slice(0, 160)}`)
  record('co-claw 上 thinking disabled 也真的关掉了', msg?.reasoning_content === undefined, JSON.stringify({ content: msg?.content, reasoning: msg?.reasoning_content }))
}

// 6. response_format gate (the reference contract's own precondition)
{
  const body = { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'list three colours' }], response_format: { type: 'json_object' }, max_tokens: 16 }
  const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: H, body: JSON.stringify(body) })
  const j = await r.json()
  record('缺 json 关键词时按参照契约 400', r.status === 400 && j.error?.type === 'invalid_request_error', `${r.status} ${JSON.stringify(j).slice(0, 140)}`)
}

// 7. failover: a dead route in front of a live one
{
  await fetch(`${base}/admin/api/config`, {
    method: 'POST',
    headers: { ...H, 'x-router-token': token },
    body: JSON.stringify({
      providers: {
        'maas-dead': { label: 'dead', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'x', models: ['dead-model'] },
        'maas-dsv4': { label: 'dsv4', baseURL: 'https://maas-apigateway.dt.zte.com.cn/model/deepseek-v4-flash/v1', keys: [{ id: 'k1', key: '' }], models: ['deepseek-v4-flash'] },
      },
      router: { order: [{ provider: 'maas-dead', model: 'dead-model' }, { provider: 'maas-dsv4', model: 'deepseek-v4-flash' }], retries: 0 },
    }),
  })
  const body = { model: 'dead-model', messages: [{ role: 'user', content: 'Reply with exactly: OK' }], thinking: { type: 'disabled' }, max_tokens: 24 }
  const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: H, body: JSON.stringify(body) })
  const j = await r.json()
  record('上游不可达时切换到活路由（复用已存密钥）', r.status === 200 && j.choices?.[0]?.message?.content !== undefined, `${r.status} ${JSON.stringify(j).slice(0, 160)}`)
  const afterOne = await (await fetch(`${base}/admin/api/state`, { headers: { 'x-router-token': token } })).json()
  const deadOnce = afterOne.value.rows.find((row) => row.provider === 'maas-dead')
  record('一次失败只记账，不到阈值不熔断（阈值=2）',
    deadOnce?.state === 'closed' && deadOnce.failures === 1, JSON.stringify({ state: deadOnce?.state, failures: deadOnce?.failures }))
  await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: H, body: JSON.stringify(body) })
  const state = await (await fetch(`${base}/admin/api/state`, { headers: { 'x-router-token': token } })).json()
  const dead = state.value.rows.find((row) => row.provider === 'maas-dead')
  record('连续失败到阈值后熔断器打开', dead?.state === 'open', JSON.stringify({ state: dead?.state, failures: dead?.failures, lastFailure: dead?.lastFailure }))
  const dsv4Keys = state.value.providers.find((p) => p.id === 'maas-dsv4')?.keys ?? []
  record('密钥留空时沿用了已存的密钥（按 id 认领，不是按位置）',
    dsv4Keys.length === 1 && dsv4Keys[0].id === 'k1' && dsv4Keys[0].set === true,
    JSON.stringify(dsv4Keys.map((k) => ({ id: k.id, set: k.set, masked: k.masked }))))
}

// 7b. key-level failover against the real gateway: a bogus key in front of the
//     real one, on the same provider. This is the one piece of evidence that
//     cannot be produced with a stub: the gateway really does answer the bogus
//     credential with an error, and the service really does step over it.
{
  const bogus = 'sk-live-bogus-000000000000000000'
  const saved = await (await fetch(`${base}/admin/api/state`, { headers: { 'x-router-token': token } })).json()
  const real = saved.value.providers.find((p) => p.id === 'maas-dsv4')?.keys?.[0]
  const restored = await fetch(`${base}/admin/api/config`, {
    method: 'POST',
    headers: { ...H, 'x-router-token': token },
    body: JSON.stringify({
      providers: {
        'maas-dsv4': {
          label: 'dsv4 (two keys)',
          baseURL: 'https://maas-apigateway.dt.zte.com.cn/model/deepseek-v4-flash/v1',
          // The bogus one is first, so the only way this request can succeed is
          // by stepping over it to the second credential of the same provider.
          keys: [{ id: 'bad', label: 'bogus', key: bogus }, { id: real?.id ?? 'k1', label: 'real', key: '' }],
          models: ['deepseek-v4-flash'],
        },
      },
      router: { order: [{ provider: 'maas-dsv4', model: 'deepseek-v4-flash' }], retries: 0 },
    }),
  })
  const restoredDoc = await restored.json()
  record('两把 key 的配置保存成功（第二把留空保住真密钥）',
    restoredDoc.value?.providers?.[0]?.keys?.length === 2
      && restoredDoc.value.providers[0].keys[1].set === true,
    JSON.stringify(restoredDoc.value?.providers?.[0]?.keys?.map((k) => ({ id: k.id, set: k.set }))))

  const body = { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'Reply with exactly: OK' }], thinking: { type: 'disabled' }, max_tokens: 24 }
  const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: H, body: JSON.stringify(body) })
  const j = await r.json()
  record('坏 key 在前时仍然 200（在同一供应商内切到第二把）',
    r.status === 200 && typeof j.choices?.[0]?.message?.content === 'string',
    `${r.status} ${JSON.stringify(j).slice(0, 200)}`)

  const after = await (await fetch(`${base}/admin/api/state`, { headers: { 'x-router-token': token } })).json()
  const keys = after.value.providers.find((p) => p.id === 'maas-dsv4')?.keys ?? []
  const bad = keys.find((k) => k.id === 'bad')
  const good = keys.find((k) => k.id !== 'bad')
  const badRow = after.value.rows.find((row) => row.keyId === 'bad')
  record('坏 key 被记账（拉黑或累计失败），好 key 不受影响',
    bad !== undefined && (bad.blacklisted === true || badRow?.failures >= 1) && good?.blacklisted === false,
    JSON.stringify({ bad: { blacklisted: bad?.blacklisted, reason: bad?.blacklist?.reason, failures: badRow?.failures }, good: { blacklisted: good?.blacklisted } }))
  record('坏 key 的处理方式在事件流里可见',
    (after.value.recent ?? []).some((event) => event.keyId === 'bad' && ['blacklist', 'failure', 'ignored'].includes(event.kind)),
    JSON.stringify((after.value.recent ?? []).slice(0, 3).map((e) => `${e.kind}:${e.provider}#${e.keyId}`)))
  record('拉黑（如果是拉黑）带的是凭据类原因',
    bad?.blacklisted !== true || ['authentication_error', 'permission_error', 'insufficient_balance'].includes(bad?.blacklist?.reason),
    bad?.blacklist?.reason ?? '(未拉黑)')
}

// 8. probe against the real gateway
{
  const r = await fetch(`${base}/admin/api/probe`, { method: 'POST', headers: { ...H, 'x-router-token': token }, body: JSON.stringify({ provider: 'maas-dsv4', model: 'deepseek-v4-flash' }) })
  const j = await r.json()
  const probe = j.value?.probe
  record('探测真实网关成功', probe?.ok === true, JSON.stringify({ code: probe?.code, ms: probe?.ms, text: probe?.text?.slice(0, 40), reasoningChars: probe?.reasoningChars }))
}

await service.stop()
rmSync(home, { recursive: true, force: true })
const failed = results.filter((r) => r.ok !== true)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} ${results.length - failed.length}/${results.length} live checks`)
process.exit(failed.length === 0 ? 0 : 1)

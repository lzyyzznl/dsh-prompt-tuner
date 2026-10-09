/**
 * Latency probe for the running host routes.
 *
 * The routes live in the harness host, so the only honest way to time them is
 * from outside: this script posts to a live `dsh web` server and reports
 * wall-clock milliseconds per action. Use it before/after touching the optimize
 * path — the interesting numbers are the gap between "catalog" (provider
 * discovery) and "optimize" (model call), the time to the first visible token,
 * and `reasoningChars` (thinking tokens the rewrite pays for and discards).
 *
 * The rewrite has one fixed thinking budget (`off`), so there is no effort flag
 * any more: a route that cannot honor `off` degrades, and the reply says so
 * (`effort` / `effortDegraded`).
 *
 * The other half of the request is the conversation excerpt
 * (`携带最近会话消息`). `--recent N` fills the body with N synthetic records, so
 * the excerpt's request size and latency can be measured without a live
 * transcript; they are labelled as synthetic in the output, and the host slices
 * the list the same way it slices real records (the newest `recentMessages`).
 *
 *   node scripts/bench.mjs [baseUrl] [draft] [--runs N] [--recent N]
 *
 * Examples:
 *   node scripts/bench.mjs --runs 3
 *   node scripts/bench.mjs --runs 3 --recent 8
 *   node scripts/bench.mjs --runs 3 -- /path/to/long-draft.md
 *
 * Default base URL comes from DSH_WEB_URL, else http://127.0.0.1:3080.
 */
import process from 'node:process'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : argv[index + 1]
}
const runs = Math.max(1, Number(flag('runs', 3)) || 3)
const recent = Math.max(0, Number(flag('recent', 0)) || 0)
const consumed = new Set()
for (const name of ['runs', 'recent']) {
  const index = argv.indexOf(`--${name}`)
  if (index !== -1) {
    consumed.add(index)
    consumed.add(index + 1)
  }
}
const positional = argv.filter((value, index) => !consumed.has(index))
const base = (positional[0] ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080').replace(/\/+$/, '')

/** POST one JSON body and report status, wall-clock ms, and the envelope. */
async function post(action, body, label) {
  const started = performance.now()
  let status = 0
  let payload = null
  try {
    const response = await fetch(`${base}/dsh-prompt-optimizer${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    status = response.status
    payload = await response.json()
  } catch (cause) {
    payload = { ok: false, error: { code: 'transport', message: String(cause?.message ?? cause) } }
  }
  const ms = Math.round(performance.now() - started)
  const detail = payload?.ok === true
    ? summarize(action, payload.value, payload.timings ?? payload.value?.timings)
    : `error ${payload?.error?.code ?? '?'}: ${payload?.error?.message ?? '?'}${payload?.timings === undefined ? '' : ` (after ${payload.timings.totalMs}ms)`}`
  console.log(`${String(ms).padStart(6)} ms  ${label.padEnd(32)} ${detail}`)
  return { ms, payload }
}

/** One-line summary of a route envelope, per action. */
function summarize(action, value, timings) {
  if (action === '/state') {
    const providers = (value?.models ?? []).map((group) => `${group.id}(${group.models.length})`).join(' ')
    return `active=${value?.active?.provider ?? '-'}/${value?.active?.model ?? '-'} providers=[${providers}] custom=${value?.custom} recentMessages=${value?.settings?.recentMessages}`
  }
  if (action === '/optimize') {
    const first = timings?.firstTextMs >= 0 ? `${(timings.firstTextMs / 1000).toFixed(1)}s to first token` : 'no text'
    const thinking = timings?.reasoningChars ?? 0
    return `${value?.provider}/${value?.model} effort=${value?.effort ?? 'omitted'} ${value?.originalChars}→${value?.optimizedChars} chars · ${first} · thinking ${thinking} chars · route ${timings?.routeMs ?? '?'}ms`
  }
  return 'ok'
}

console.log(`base ${base}\n`)
await post('/state', {}, 'state (cached catalog)')

const draft = positional[1]
  ?? '帮我把这个项目优化一下，性能快一点，顺手把文档补一下，代码质量也要高。'
// Synthetic, and labelled as such below: the route only reads the strings (each
// record travels as one line) and slices the newest `recentMessages` of them, so
// this measures the excerpt's cost without needing a copy of a real transcript.
const records = Array.from({ length: recent }, (_, index) => JSON.stringify({
  kind: index % 2 === 1 ? 'assistant' : 'user',
  seq: index + 1,
  text: `synthetic record ${index + 1}: stands in for one session-log entry so the excerpt's cost can be measured.`,
}))
if (records.length > 0) {
  console.log(`carrying ${records.length} synthetic record(s) of ${records[0].length} chars each (pass --recent 0 to send the draft alone)\n`)
}
console.log('')
const results = []
for (let index = 1; index <= runs; index += 1) {
  const body = { text: draft, records }
  const result = await post('/optimize', body, `optimize #${index} (${draft.length} chars in${records.length > 0 ? `, +${records.length} synthetic records` : ''})`)
  if (result.payload?.ok === true) results.push(result.ms)
}
if (results.length > 0) {
  const sorted = [...results].sort((a, b) => a - b)
  const mean = Math.round(results.reduce((sum, value) => sum + value, 0) / results.length)
  console.log(`\noptimize: min ${sorted[0]} ms  median ${sorted[Math.floor(sorted.length / 2)]} ms  mean ${mean} ms  over ${results.length} run(s)`)
}

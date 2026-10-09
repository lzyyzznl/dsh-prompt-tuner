/**
 * Blind three-arm evaluation of the built-in optimization prompt.
 *
 * The rewrite prompt is the plugin's only product decision that cannot be
 * checked by reading code, so this script turns it into a measurement: one
 * fixed draft set, three arms, and a judge that never learns which arm produced
 * which rewrite.
 *
 *   baseline   scripts/eval/prompt-baseline.txt    the prompt as it shipped before a change
 *   candidate  scripts/eval/prompt-candidate.txt   the prompt under test
 *   minimal    scripts/eval/prompt-minimal.txt     a deliberately compressed variant
 *
 * The arms run through the running host, not a private HTTP client: a rewrite is
 * `POST <url>/dsh-prompt-optimizer/optimize`, and an arm is selected by writing
 * its text into the plugin's own `systemPrompt` setting (`POST /save`) — the
 * same lever a user has, so an arm measures what a user would actually get,
 * framing and model route included. A language arm appends the same runtime line
 * the plugin appends (`scripts/eval/language-<lang>.txt`), and that file is
 * byte-compared against the plugin's own export by `npm run check`, so the
 * measured text cannot drift from the shipped text. The original setting is
 * restored when the run ends, including when it fails.
 *
 * Every phase is a separate flag because the expensive ones send real requests:
 *
 *   node scripts/eval-prompt.mjs                     plan only, sends nothing
 *   node scripts/eval-prompt.mjs --live              rewrite every draft once per arm
 *   node scripts/eval-prompt.mjs --judge             blind-score the newest run
 *   node scripts/eval-prompt.mjs --live --limit 2    a smoke run (2 drafts x 3 arms)
 *   node scripts/eval-prompt.mjs --live --url http://127.0.0.1:52602
 *
 * Flags: --live --judge --url U --drafts F --out D --concurrency N --limit N
 *        --arms a,b --lang zh --in FILE --require-parity
 *
 * The default base URL comes from DSH_WEB_URL, else http://127.0.0.1:3080 (the
 * same default `scripts/bench.mjs` uses). Runs land in `scripts/eval/runs/`.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const HERE = dirname(fileURLToPath(import.meta.url))
const EVAL_DIR = join(HERE, 'eval')
const RUNS_DIR = join(EVAL_DIR, 'runs')
const ROUTE = '/dsh-prompt-optimizer'

const argv = process.argv.slice(2)
const has = (name) => argv.includes(`--${name}`)
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : argv[index + 1]
}
const num = (name, fallback) => {
  const value = Number(flag(name, Number.NaN))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const live = has('live')
const judge = has('judge')
const requireParity = has('require-parity')
const base = String(flag('url', process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080')).replace(/\/+$/, '')
const draftsFile = String(flag('drafts', join(EVAL_DIR, 'drafts.json')))
const outDir = String(flag('out', RUNS_DIR))
const concurrency = num('concurrency', 3)
const limit = num('limit', 0)

/** The three arms, in report order. `lang` appends the runtime language line. */
const ARM_DEFS = [
  { name: 'baseline', file: 'prompt-baseline.txt', lang: null, note: 'the shipped prompt before the change' },
  { name: 'candidate', file: 'prompt-candidate.txt', lang: String(flag('lang', 'zh')), note: 'the prompt under test' },
  { name: 'minimal', file: 'prompt-minimal.txt', lang: String(flag('lang', 'zh')), note: 'deliberately compressed' },
]

const readText = (path) => readFileSync(path, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim()
const sha = (text) => createHash('sha256').update(text).digest('hex')
const short = (text) => `${text.length} chars sha ${sha(text).slice(0, 8)}`

/**
 * Resolve one arm into the exact system string the host will send: its prompt
 * file, plus the runtime language line when the arm carries one.
 */
function resolveArms(names) {
  return names.map((name) => {
    const def = ARM_DEFS.find((arm) => arm.name === name)
    if (def === undefined) throw new Error(`unknown arm "${name}" (known: ${ARM_DEFS.map((a) => a.name).join(', ')})`)
    const path = join(EVAL_DIR, def.file)
    if (!existsSync(path)) throw new Error(`arm "${name}" is missing its prompt file: ${path}`)
    const prompt = readText(path)
    const line = def.lang === null ? null : readText(join(EVAL_DIR, `language-${def.lang}.txt`))
    const system = line === null ? prompt : `${prompt}\n\n${line}`
    return { name: def.name, note: def.note, lang: def.lang, promptPath: path, promptChars: prompt.length, system, systemSha: sha(system) }
  })
}

/** Load the fixed draft set. */
function loadDrafts() {
  if (!existsSync(draftsFile)) throw new Error(`draft set not found: ${draftsFile}`)
  const parsed = JSON.parse(readFileSync(draftsFile, 'utf8'))
  const list = Array.isArray(parsed.drafts) ? parsed.drafts : []
  if (list.length === 0) throw new Error(`${draftsFile} carries no drafts`)
  const drafts = list
    .map((entry) => ({ id: String(entry.id), source: String(entry.source ?? '?'), shape: String(entry.shape ?? ''), text: String(entry.text ?? '') }))
    .filter((entry) => entry.text.trim() !== '')
  return { note: String(parsed.note ?? ''), path: draftsFile, drafts: limit > 0 ? drafts.slice(0, limit) : drafts }
}

/* ────────────────────────────── transport ────────────────────────────── */

/** One JSON route call, with its wall-clock time and a single transport retry. */
async function call(action, body, attempt = 0) {
  const started = performance.now()
  try {
    const response = await fetch(`${base}${ROUTE}${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(300_000),
    })
    const envelope = await response.json()
    return { ms: Math.round(performance.now() - started), envelope, transport: null }
  } catch (cause) {
    if (attempt === 0) return call(action, body, 1)
    return { ms: Math.round(performance.now() - started), envelope: null, transport: String(cause?.message ?? cause) }
  }
}

/** Run `job` over `items` with a bounded number in flight, keeping input order. */
async function mapLimit(items, size, job) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await job(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/** Deterministic PRNG keyed by a string, so a blind mapping is reproducible. */
function seededShuffle(list, seed) {
  let state = 0
  for (const byte of Buffer.from(seed)) state = (state * 31 + byte) >>> 0
  const out = [...list]
  for (let index = out.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0
    const swap = state % (index + 1)
    ;[out[index], out[swap]] = [out[swap], out[index]]
  }
  return out
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

/* ────────────────────────────── the plan ────────────────────────────── */

async function plan(arms, set) {
  console.log(`base      ${base}`)
  console.log(`drafts    ${set.path} — ${set.drafts.length} draft(s)`)
  console.log(`output    ${outDir}`)
  console.log('')
  for (const arm of arms) {
    console.log(`  ${arm.name.padEnd(10)} ${short(arm.system).padEnd(34)} ${arm.lang === null ? 'no language line' : `+ language-${arm.lang}.txt`}  (${arm.note})`)
  }
  console.log('')

  // The candidate is the prompt that will ship: a measured candidate that is not
  // the shipped text is a measurement of nothing, so this is reported loudly.
  const promptModule = await import('../lib/prompt.js')
  const shipped = promptModule.DEFAULT_SYSTEM_PROMPT
  const candidate = arms.find((arm) => arm.name === 'candidate')
  if (candidate !== undefined) {
    const ok = candidate.prompt === shipped
    console.log(`candidate vs lib/prompt.js DEFAULT_SYSTEM_PROMPT: ${ok ? 'identical' : `DIFFERENT (${candidate.prompt.length} vs ${shipped.length} chars)`}`)
    if (!ok && requireParity) {
      console.error('\n--require-parity: the candidate file must be the shipped prompt.')
      process.exitCode = 2
      return false
    }
  }
  const calls = arms.length * set.drafts.length
  console.log(`\n--live would send ${calls} rewrite call(s) + ${set.drafts.length} judge call(s) in --judge.`)
  return true
}

/* ────────────────────────────── the rewrite phase ────────────────────────────── */

async function runLive(arms, set) {
  const state = await call('/state', {})
  if (state.envelope?.ok !== true) {
    console.error(`cannot reach the host at ${base}${ROUTE}/state: ${state.transport ?? JSON.stringify(state.envelope)}`)
    process.exitCode = 1
    return
  }
  const original = state.envelope.value?.settings?.systemPrompt ?? null
  console.log(`host reachable; original systemPrompt: ${original === null ? 'built-in default' : short(original)}\n`)

  const results = []
  try {
    for (const arm of arms) {
      const saved = await call('/save', { systemPrompt: arm.system })
      if (saved.envelope?.ok !== true) {
        console.error(`  ${arm.name}: could not arm the host: ${JSON.stringify(saved.envelope?.error ?? saved.transport)}`)
        continue
      }
      const rows = await mapLimit(set.drafts, concurrency, async (draft) => {
        const { ms, envelope, transport } = await call('/optimize', { text: draft.text, records: [] })
        const ok = envelope?.ok === true && typeof envelope.value?.text === 'string' && envelope.value.text.trim() !== ''
        const text = ok ? envelope.value.text : ''
        console.log(`  ${arm.name.padEnd(10)} ${draft.id.padEnd(9)} ${ok ? `${String(ms).padStart(6)} ms  ${String(draft.text.length).padStart(4)} → ${String(text.length).padStart(4)} chars` : `FAILED ${transport ?? envelope?.error?.code ?? '?'}`}`)
        return { draftId: draft.id, arm: arm.name, ok, ms, chars: text.length, text, error: ok ? null : String(transport ?? envelope?.error?.message ?? envelope?.error?.code ?? 'unknown') }
      })
      results.push(...rows)
    }
  } finally {
    const restored = await call('/save', { systemPrompt: original })
    const check = await call('/state', {})
    const now = check.envelope?.value?.settings?.systemPrompt ?? null
    console.log(`\nrestored systemPrompt: ${restored.envelope?.ok === true && now === original ? 'ok' : 'CHECK THIS — the setting did not come back'}`)
  }

  mkdirSync(outDir, { recursive: true })
  const file = join(outDir, `${stamp()}-rewrites.json`)
  writeFileSync(file, `${JSON.stringify({
    stamp: new Date().toISOString(),
    url: base,
    draftSet: { path: set.path, count: set.drafts.length, sha256: sha(JSON.stringify(set.drafts.map((d) => d.text))) },
    arms: arms.map((arm) => ({ name: arm.name, lang: arm.lang, chars: arm.system.length, sha256: arm.systemSha, prompt: arm.system })),
    drafts: set.drafts,
    results,
  }, null, 2)}\n`, 'utf8')

  const ok = results.filter((row) => row.ok)
  console.log(`\n${ok.length}/${results.length} rewrite(s) ok → ${file}`)
  for (const arm of arms) {
    const rows = ok.filter((row) => row.arm === arm.name)
    if (rows.length === 0) continue
    const grow = rows.map((row) => row.chars / Math.max(1, set.drafts.find((d) => d.id === row.draftId).text.length)).sort((a, b) => a - b)
    const chars = rows.map((row) => row.chars).sort((a, b) => a - b)
    const times = rows.map((row) => row.ms).sort((a, b) => a - b)
    console.log(`  ${arm.name.padEnd(10)} median ${chars[Math.floor(chars.length / 2)]} chars, growth x${grow[Math.floor(grow.length / 2)].toFixed(1)}, ${times[Math.floor(times.length / 2)]} ms`)
  }
}

/* ────────────────────────────── the judging phase ────────────────────────────── */

/** Newest rewrites file in the output directory, or the one named by --in. */
function newestRun() {
  const named = flag('in', null)
  if (named !== null) return named
  const files = readdirSync(outDir).filter((name) => name.endsWith('-rewrites.json')).sort()
  if (files.length === 0) throw new Error(`no *-rewrites.json in ${outDir}; run --live first`)
  return join(outDir, files.at(-1))
}

/** The blinded comparison one draft is judged through. */
function judgePayload(draft, labelled) {
  const parts = [`<<<原始输入>>>\n${draft.text}\n<<<原始输入结束>>>`]
  for (const candidate of labelled) {
    parts.push(`<<<候选 ${candidate.label}>>>\n${candidate.text}\n<<<候选 ${candidate.label}结束>>>`)
  }
  return parts.join('\n\n')
}

/** Parse the judge's JSONL answer; a malformed line is a dropped score, not a crash. */
function parseJudgement(text) {
  const scores = []
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    const candidate = String(parsed.candidate ?? '').toUpperCase()
    if (!'ABC'.includes(candidate) || candidate.length !== 1) continue
    scores.push({
      candidate,
      fidelity: Number(parsed.fidelity),
      sufficiency: Number(parsed.sufficiency),
      executability: Number(parsed.executability),
      size: Number(parsed.size),
      noFabrication: Number(parsed.noFabrication),
      reason: String(parsed.reason ?? ''),
    })
  }
  return scores
}

const DIMENSIONS = ['fidelity', 'sufficiency', 'executability', 'size', 'noFabrication']

async function runJudge(set) {
  const runFile = newestRun()
  const run = JSON.parse(readFileSync(runFile, 'utf8'))
  const drafts = Array.isArray(run.drafts) ? run.drafts : set.drafts
  const arms = (run.arms ?? []).map((arm) => arm.name)
  const judgePrompt = readText(join(EVAL_DIR, 'judge-prompt.txt'))
  const byDraft = new Map()
  for (const row of run.results ?? []) {
    if (row.ok !== true) continue
    if (!byDraft.has(row.draftId)) byDraft.set(row.draftId, new Map())
    byDraft.get(row.draftId).set(row.arm, row)
  }

  const state = await call('/state', {})
  const original = state.envelope?.value?.settings?.systemPrompt ?? null
  const scored = []
  try {
    const armed = await call('/save', { systemPrompt: judgePrompt })
    if (armed.envelope?.ok !== true) throw new Error(`could not arm the judge: ${JSON.stringify(armed.envelope?.error ?? armed.transport)}`)
    const verdicts = await mapLimit(drafts, concurrency, async (draft) => {
      const rows = byDraft.get(draft.id)
      if (rows === undefined || rows.size < 2) return { draftId: draft.id, mapping: null, raw: '', scores: [], error: 'fewer than two arms produced a rewrite' }
      // The mapping is fixed per draft (and reproducible from the run stamp), so
      // the same draft can be re-judged and compared.
      const order = seededShuffle([...rows.keys()], `${run.stamp ?? ''}:${draft.id}`)
      const labels = ['A', 'B', 'C'].slice(0, order.length)
      const mapping = Object.fromEntries(labels.map((label, index) => [label, order[index]]))
      const labelled = labels.map((label) => ({ label, text: rows.get(mapping[label]).text }))
      const { ms, envelope, transport } = await call('/optimize', { text: judgePayload(draft, labelled), records: [] })
      const text = envelope?.ok === true ? String(envelope.value?.text ?? '') : ''
      const scores = parseJudgement(text)
      console.log(`  ${draft.id.padEnd(9)} ${scores.length}/3 scored in ${ms} ms${scores.length < 3 ? `  (${transport ?? envelope?.error?.code ?? 'partial'})` : ''}`)
      return { draftId: draft.id, mapping, raw: text, scores, error: scores.length === 0 ? String(transport ?? envelope?.error?.message ?? 'unparsable') : null }
    })
    scored.push(...verdicts)
  } finally {
    await call('/save', { systemPrompt: original })
  }

  // Fold the per-candidate scores back onto arm names.
  const perArm = Object.fromEntries(arms.map((arm) => [arm, []]))
  const detail = []
  for (const verdict of scored) {
    if (verdict.mapping === null) continue
    for (const score of verdict.scores) {
      const arm = verdict.mapping[score.candidate]
      if (arm === undefined || perArm[arm] === undefined) continue
      perArm[arm].push(score)
      detail.push({ draftId: verdict.draftId, arm, ...score })
    }
  }
  const summary = arms.map((arm) => {
    const rows = perArm[arm]
    const mean = (key) => rows.length === 0 ? null : Number((rows.reduce((sum, row) => sum + row[key], 0) / rows.length).toFixed(2))
    const total = rows.length === 0 ? null : Number((DIMENSIONS.reduce((sum, key) => sum + mean(key), 0) / DIMENSIONS.length).toFixed(2))
    return { arm, n: rows.length, total, ...Object.fromEntries(DIMENSIONS.map((key) => [key, mean(key)])) }
  })

  mkdirSync(outDir, { recursive: true })
  const file = join(outDir, `${stamp()}-scores.json`)
  writeFileSync(file, `${JSON.stringify({ stamp: new Date().toISOString(), source: runFile, judgePromptSha: sha(judgePrompt), summary, detail, verdicts: scored.map((v) => ({ draftId: v.draftId, mapping: v.mapping, scores: v.scores, error: v.error })) }, null, 2)}\n`, 'utf8')

  console.log('\narm          n   total  fidelity sufficiency executability size noFab')
  for (const row of summary) {
    console.log(`  ${row.arm.padEnd(10)} ${String(row.n).padStart(2)}  ${String(row.total ?? '-').padStart(5)}  ${DIMENSIONS.map((key) => String(row[key] ?? '-').padStart(10)).join(' ')}`)
  }
  console.log(`\n→ ${file}`)
}

/* ────────────────────────────── entry ────────────────────────────── */

const armNames = String(flag('arms', ARM_DEFS.map((arm) => arm.name).join(','))).split(',').map((name) => name.trim()).filter(Boolean)
const arms = resolveArms(armNames)
const set = loadDrafts()

if (!live && !judge) {
  await plan(arms, set)
} else if (live) {
  const proceeding = await plan(arms, set)
  if (proceeding !== false) {
    console.log('\n--live: sending real requests through the host route\n')
    await runLive(arms, set)
  }
} else {
  console.log(`judging ${flag('in', 'the newest run')} with scripts/eval/judge-prompt.txt (${short(readText(join(EVAL_DIR, 'judge-prompt.txt')))})\n`)
  await runJudge(set)
}

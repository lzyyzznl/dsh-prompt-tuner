/**
 * Attribution audit: how much does a rewrite add that the user never said?
 *
 * `eval-prompt.mjs` answers "which prompt is better" with a blind score. It
 * cannot answer "which sentence of this rewrite came from the user", and that is
 * the question the product actually stands on: a rewrite that invents a
 * requirement hands the executor a task nobody asked for, and the user may not
 * notice until the work is done. This script answers it two ways over one
 * recorded run of `eval-prompt.mjs`, so no rewrite call has to be repeated:
 *
 *   offline (always)  mechanical and deterministic — growth ratio, template
 *                     sections, and every backticked span, path and measured
 *                     number that occurs in the rewrite but nowhere in the
 *                     draft. Each one is then split by the rewrite's own
 *                     assumptions section: inside it means the rewriter showed
 *                     its hand, outside it means the number or path appeared
 *                     silently. No model, no network.
 *   --judge           semantic — a model lists every requirement in the rewrite
 *                     and must attribute it to stated / resolved / labeled /
 *                     silent / dropped. This is what catches an invented
 *                     *sentence*; the offline half only catches invented tokens.
 *
 * Neither half is a verdict on quality: `silent` counts are a rate over an
 * 18-draft set, and the offline half is a lower bound by construction.
 *
 *   node scripts/eval-attribution.mjs                    newest run, offline half
 *   node scripts/eval-attribution.mjs --run scripts/eval/runs/<stamp>-rewrites.json
 *   node scripts/eval-attribution.mjs --judge            add the model half
 *   node scripts/eval-attribution.mjs --judge --repeat 3 the model half, three times
 *   node scripts/eval-attribution.mjs --judge --limit 2  smoke run
 *
 * Flags: --run F --judge --repeat N --url U --out D --concurrency N --limit N --arms a,b
 *
 * The default base URL comes from DSH_WEB_URL, else http://127.0.0.1:3080.
 * Results land in `scripts/eval/runs/` next to the rewrite runs they read.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { findAssumptions } from '../lib/prompt.js'

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

const judge = has('judge')
const base = String(flag('url', process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080')).replace(/\/+$/, '')
const outDir = String(flag('out', RUNS_DIR))
const concurrency = num('concurrency', 3)
const limit = num('limit', 0)
const repeat = Math.max(1, Math.round(num('repeat', 1)))

const readText = (path) => readFileSync(path, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const median = (values) => {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  return sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)]
}
const mean = (values) => {
  const list = values.filter((value) => Number.isFinite(value))
  return list.length === 0 ? null : Number((list.reduce((sum, value) => sum + value, 0) / list.length).toFixed(2))
}

/* ────────────────────────── the offline half ────────────────────────── */

/**
 * Template section names the audit looks for in a rewrite. These are the
 * sections that appear when a rewrite follows a house template instead of the
 * user's input, so their count per rewrite is the scaffolding measure.
 */
const TEMPLATE_SECTIONS = [
  '目标', '背景', '上下文', '现状', '约束', '交付物', '验收标准', '验收', '非目标',
  '输出格式', '输出形态', '失败路径', '权限', '示例', '待确认', 'To confirm',
]

const HEADING = /^\s*#{1,6}\s*(.+?)\s*$/
const MARKERS = /^\s*(?:#{1,6}\s*)?(?:[-*+]|\d+\s*[.)、）])?\s*/

/**
 * The text with list and heading markers removed, so that a section number
 * ("# 1 判定") cannot masquerade as a measured number in the counts below.
 */
function stripMarkers(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.replace(MARKERS, ''))
    .join('\n')
}

/** The headings of a rewrite, marker and numbering stripped. */
function headings(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const match = HEADING.exec(line)
    if (match === null) continue
    const name = match[1].replace(/^\d+\s*[.)、）]?\s*/, '').trim()
    if (name !== '') out.push(name)
  }
  return out
}

/**
 * High-precision entities: backticked spans, path-like spans, and numbers that
 * carry a unit or at least three digits. Deliberately narrow — a bare English
 * word or a small integer in Chinese prose cannot be told from ordinary
 * language, and a false alarm here would read as a fabrication that is not one.
 */
function entities(text) {
  const body = stripMarkers(text)
  const out = new Map()
  const add = (kind, value) => {
    const trimmed = String(value).trim()
    if (trimmed === '') return
    const key = `${kind}:${trimmed.toLowerCase()}`
    if (!out.has(key)) out.set(key, { kind, value: trimmed })
  }
  for (const match of body.matchAll(/`([^`\n]{1,120})`/g)) add('code', match[1])
  for (const match of body.matchAll(/(?:\/[\w.@-]+){2,}/g)) add('path', match[0])
  for (const match of body.matchAll(/(?:\.\.?\/)[\w.@-]+(?:\/[\w.@-]+)*/g)) add('path', match[0])
  for (const match of body.matchAll(/[A-Za-z]:\\[^\s`"'，。；)）]+/g)) add('path', match[0])
  for (const match of body.matchAll(/(?<![\w.])\d+(?:\.\d+)?\s?(?:ms|秒|分钟|小时|天|%|％|字|条|次|个|张|页|行|kb|mb|gb|px|倍|元)/gi)) add('number', match[0])
  for (const match of body.matchAll(/(?<![\w.])\d{3,}(?![\w])/g)) add('number', match[0])
  return [...out.values()]
}

/**
 * Phrases that prescribe what an *answer* must cover ("请给出 1…2…3…", "必须包含").
 * The prompt forbids this for question-shaped input, because the user asked a
 * question, not for a report with a mandated table of contents — so a rewrite
 * that carries one is adding structure the user never asked for. Lexical and
 * deliberately narrow: it is reported as a flag, never as a headline number.
 */
const ANSWER_CONTRACT = ['请给出', '请说明', '请列出', '请回答', '需要给出', '需要包含', '需要说明', '需要覆盖', '必须包含', '必须说明', '应包含', '包括但不限于']

/**
 * Comparable form of a textual fragment. Quotes and backticks are dropped
 * because the rewrite formats the draft's own material (`'length'` becomes
 * `` `.length` ``) and whitespace is dropped because the same number is
 * written `200 字` and `200字`. A leading dot goes too, so that the member
 * access the draft names in passing is not reported as an invented path.
 */
const norm = (text) => String(text).toLowerCase().replace(/[`'"]/g, '').replace(/\s+/g, '')
const comparable = (text) => norm(text).replace(/^\.+/, '')

/**
 * The key one entity is compared by. For a measured number only the digits
 * matter: the draft's "2 遍" and the rewrite's "2 条" are the same count, and
 * counting the unit as well would report the user's own number as invented.
 * Everything else compares through {@link comparable}.
 */
const entityKey = (entity) => (entity.kind === 'number' ? (entity.value.match(/\d+(?:\.\d+)?/) ?? [''])[0] : comparable(entity.value))

/**
 * One rewrite audited: what it added, how much it grew, and which of the added
 * entities the rewriter itself flagged in its assumptions section.
 */
function auditOne(row, draft) {
  const rewrite = String(row.text ?? '')
  const { assumptions } = findAssumptions(rewrite)
  const labelled = norm(assumptions ?? '')
  const draftComparable = norm(draft ?? '')
  const novelLabeled = []
  const novelSilent = []
  for (const entity of entities(rewrite)) {
    const key = entityKey(entity)
    if (key === '' || draftComparable.includes(key)) continue
    if (labelled !== '' && labelled.includes(key)) novelLabeled.push(entity)
    else novelSilent.push(entity)
  }
  const sections = headings(rewrite)
  const templateHits = sections.filter((name) => TEMPLATE_SECTIONS.some((known) => name.startsWith(known)))
  const answerContract = ANSWER_CONTRACT.filter((phrase) => rewrite.includes(phrase))
  return {
    draftId: row.draftId,
    arm: row.arm,
    draftChars: String(draft ?? '').length,
    chars: rewrite.length,
    growth: Number((rewrite.length / Math.max(1, String(draft ?? '').length)).toFixed(2)),
    headings: sections,
    templateHits,
    answerContract,
    assumptionItems: assumptions === null ? 0 : assumptions.split('\n').filter((line) => line.trim() !== '').length,
    novelLabeled,
    novelSilent,
  }
}

/** Per-arm roll-up of the offline audit. */
function rollUp(rows) {
  const arms = [...new Set(rows.map((row) => row.arm))]
  return arms.map((arm) => {
    const list = rows.filter((row) => row.arm === arm)
    return {
      arm,
      n: list.length,
      medianChars: median(list.map((row) => row.chars)),
      medianGrowth: median(list.map((row) => row.growth)),
      maxGrowth: Math.max(...list.map((row) => row.growth)),
      silentEntities: list.reduce((sum, row) => sum + row.novelSilent.length, 0),
      labelledEntities: list.reduce((sum, row) => sum + row.novelLabeled.length, 0),
      rowsWithSilent: list.filter((row) => row.novelSilent.length > 0).length,
      answerContracts: list.filter((row) => row.answerContract.length > 0).length,
      assumptionItems: list.reduce((sum, row) => sum + row.assumptionItems, 0),
      templateSectionsPerRewrite: mean(list.map((row) => row.templateHits.length)),
    }
  })
}

/* ────────────────────────────── transport ────────────────────────────── */

/** One JSON route call, with a single transport retry. */
async function call(action, body, attempt = 0) {
  try {
    const response = await fetch(`${base}${ROUTE}${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(300_000),
    })
    return { envelope: await response.json(), transport: null }
  } catch (cause) {
    if (attempt === 0) return call(action, body, 1)
    return { envelope: null, transport: String(cause?.message ?? cause) }
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

/* ────────────────────────────── the model half ────────────────────────────── */

const KINDS = ['stated', 'resolved', 'labeled', 'silent', 'dropped']

/** Parse the attribution answer: JSONL, one object per line, any malformed line dropped. */
function parseAttribution(text) {
  const items = []
  let summary = ''
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (typeof parsed.summary === 'string' && parsed.summary.trim() !== '') summary = parsed.summary.trim()
    const list = Array.isArray(parsed.items) ? parsed.items : (typeof parsed.kind === 'string' ? [parsed] : [])
    for (const entry of list) {
      const kind = String(entry?.kind ?? '').trim().toLowerCase()
      if (!KINDS.includes(kind)) continue
      items.push({ claim: String(entry.claim ?? '').trim(), kind, why: String(entry.why ?? '').trim() })
    }
  }
  return { items, summary }
}

/** The attribution payload: the draft, then the rewrite. Never the arm name. */
function attributionPayload(draft, rewrite) {
  return [
    `<<<原始输入>>>\n${draft}\n<<<原始输入结束>>>`,
    `<<<改写结果>>>\n${rewrite}\n<<<改写结果结束>>>`,
  ].join('\n\n')
}

/**
 * The semantic half, optionally repeated.
 *
 * A repeat is not decoration. Two passes over the *same* rewrites once came back
 * at 0.17 and 0.94 silent additions per rewrite — a 5.5x spread with no change to
 * the input, driven mostly by how many rows that pass failed to return parseable
 * items for. A single pass therefore cannot support a point estimate; `--repeat`
 * makes the spread visible, and the counts it prints per pass are the honest form
 * of this measurement.
 * @param {Array<object>} rows - the rewrites to attribute.
 * @param {Map<string, string>} draftsById - draft text by id.
 * @returns {Promise<{summary: object[], passes: object[][], detail: object[]}|null>} the audit.
 */
async function runJudge(rows, draftsById) {
  const prompt = readText(join(EVAL_DIR, 'attribution-prompt.txt')).trim()
  const state = await call('/state', {})
  if (state.envelope?.ok !== true) {
    console.error(`cannot reach the host at ${base}${ROUTE}/state: ${state.transport ?? JSON.stringify(state.envelope)}`)
    process.exitCode = 1
    return null
  }
  const original = state.envelope?.value?.settings?.systemPrompt ?? null
  const originalLang = state.envelope?.value?.settings?.outputLang ?? state.envelope?.value?.outputLang ?? null
  const arms = [...new Set(rows.map((row) => row.arm))]

  /** One arm's totals over one pass. */
  const rollUp = (list) => {
    const total = (kind) => list.reduce((sum, row) => sum + row.counts[kind], 0)
    const items = list.reduce((sum, row) => sum + row.items.length, 0)
    return {
      arm: list[0]?.arm ?? '?',
      n: list.length,
      items,
      unparsed: list.filter((row) => row.error !== null).length,
      stated: total('stated'),
      resolved: total('resolved'),
      labeled: total('labeled'),
      silent: total('silent'),
      dropped: total('dropped'),
      silentPerRewrite: Number((total('silent') / Math.max(1, list.length)).toFixed(2)),
      silentShare: items === 0 ? null : Number((total('silent') / items * 100).toFixed(1)),
      rowsWithSilent: list.filter((row) => row.counts.silent > 0).length,
      rowsWithDropped: list.filter((row) => row.counts.dropped > 0).length,
    }
  }

  const detail = []
  const passes = []
  try {
    const armed = await call('/save', { systemPrompt: prompt })
    if (armed.envelope?.ok !== true) throw new Error(`could not arm the auditor: ${JSON.stringify(armed.envelope?.error ?? armed.transport)}`)
    for (let pass = 1; pass <= repeat; pass += 1) {
      if (repeat > 1) console.log(`\n  ── pass ${pass}/${repeat} ──`)
      const verdicts = await mapLimit(rows, concurrency, async (row) => {
        const draft = draftsById.get(row.draftId) ?? ''
        const { envelope, transport } = await call('/optimize', { text: attributionPayload(draft, row.text), records: [] })
        const text = envelope?.ok === true ? String(envelope.value?.text ?? '') : ''
        const parsed = parseAttribution(text)
        const counts = Object.fromEntries(KINDS.map((kind) => [kind, parsed.items.filter((item) => item.kind === kind).length]))
        console.log(`  ${row.arm.padEnd(10)} ${row.draftId.padEnd(9)} ${parsed.items.length} item(s)  silent ${counts.silent}  labeled ${counts.labeled}  dropped ${counts.dropped}${parsed.items.length === 0 ? `  FAILED ${transport ?? envelope?.error?.code ?? 'unparsable'}` : ''}`)
        return { pass, draftId: row.draftId, arm: row.arm, counts, items: parsed.items, summary: parsed.summary, raw: text, error: parsed.items.length === 0 ? String(transport ?? envelope?.error?.message ?? 'unparsable') : null }
      })
      detail.push(...verdicts)
      passes.push(arms.map((arm) => rollUp(verdicts.filter((row) => row.arm === arm))))
    }
  } finally {
    await call('/save', { systemPrompt: original, outputLang: originalLang })
  }

  // The headline number is the mean over passes, so a single pass reports itself
  // and a repeated run reports the centre of a spread the caller can also see.
  const summary = arms.map((arm) => {
    const perPass = passes.map((pass) => pass.find((row) => row.arm === arm)).filter(Boolean)
    const avg = (key) => Number((perPass.reduce((sum, row) => sum + (row[key] ?? 0), 0) / Math.max(1, perPass.length)).toFixed(2))
    const spread = perPass.map((row) => row.silentPerRewrite)
    return {
      ...perPass[0],
      silentPerRewrite: avg('silentPerRewrite'),
      silentShare: avg('silentShare'),
      silentPerRewriteMin: Math.min(...spread),
      silentPerRewriteMax: Math.max(...spread),
      passes: perPass.length,
    }
  })
  return { summary, passes, detail }
}

/* ────────────────────────────── entry ────────────────────────────── */

function newestRunFile() {
  const named = flag('run', null)
  if (named !== null) return named
  const files = readdirSync(outDir).filter((name) => name.endsWith('-rewrites.json')).sort()
  if (files.length === 0) throw new Error(`no *-rewrites.json in ${outDir}; run scripts/eval-prompt.mjs --live first`)
  return join(outDir, files.at(-1))
}

const runFile = newestRunFile()
if (!existsSync(runFile)) throw new Error(`run not found: ${runFile}`)
const run = JSON.parse(readFileSync(runFile, 'utf8'))
const draftsById = new Map((run.drafts ?? []).map((draft) => [draft.id, String(draft.text ?? '')]))
const wanted = String(flag('arms', (run.arms ?? []).map((arm) => arm.name).join(','))).split(',').map((name) => name.trim()).filter(Boolean)
let rows = (run.results ?? []).filter((row) => row.ok === true && wanted.includes(row.arm))
if (limit > 0) {
  const kept = new Set([...new Set(rows.map((row) => row.draftId))].slice(0, limit))
  rows = rows.filter((row) => kept.has(row.draftId))
}
if (rows.length === 0) throw new Error(`no usable rewrite rows in ${runFile} for arms ${wanted.join(',')}`)

console.log(`run       ${runFile}`)
console.log(`drafts    ${draftsById.size} in the run, ${new Set(rows.map((row) => row.draftId)).size} audited`)
console.log(`arms      ${wanted.join(', ')}  (${rows.length} rewrite(s))`)

// The audit only means something about the shipped prompt if the run measured
// the shipped prompt, so the candidate arm's recorded system hash is recomputed
// from today's files rather than trusted. The language line is the one the arm
// itself recorded: arms pinned to different languages compose differently.
const candidatePath = join(EVAL_DIR, 'prompt-candidate.txt')
const shipped = (await import('../lib/prompt.js')).DEFAULT_SYSTEM_PROMPT
const recorded = run.arms?.find((arm) => arm.name === 'candidate')
let parity = 'no candidate arm recorded in this run'
if (existsSync(candidatePath) && recorded !== undefined) {
  const candidate = readText(candidatePath).trim()
  const languagePath = join(EVAL_DIR, `language-${recorded.lang ?? 'zh'}.txt`)
  const language = existsSync(languagePath) ? readText(languagePath).trim() : ''
  const system = `${candidate}\n\n${language}`
  const nowSha = createHash('sha256').update(system).digest('hex')
  parity = [
    recorded.sha256 === nowSha ? `run system (${recorded.lang ?? '?'}) == today's candidate file` : `run system sha ${String(recorded.sha256).slice(0, 8)} != today's ${nowSha.slice(0, 8)}`,
    candidate === shipped ? 'candidate == shipped DEFAULT_SYSTEM_PROMPT' : `candidate != shipped (${candidate.length} vs ${shipped.length} chars)`,
  ].join('; ')
}
console.log(`shipped   ${parity}`)

const audited = rows.map((row) => auditOne(row, draftsById.get(row.draftId)))
const offline = { run: runFile, rows: audited, summary: rollUp(audited) }

console.log('\n── offline half (mechanical, deterministic) ──')
console.log('arm         n  medChars  medGrowth  maxGrowth  silentEnt  labelledEnt  rowsWithSilent  answerContract  templateSections')
for (const row of offline.summary) {
  console.log(`  ${row.arm.padEnd(10)} ${String(row.n).padStart(2)} ${String(row.medianChars).padStart(8)} ${String(row.medianGrowth).padStart(10)} ${String(row.maxGrowth).padStart(10)} ${String(row.silentEntities).padStart(10)} ${String(row.labelledEntities).padStart(12)} ${String(`${row.rowsWithSilent}/${row.n}`).padStart(15)} ${String(`${row.answerContracts}/${row.n}`).padStart(15)} ${String(row.templateSectionsPerRewrite).padStart(16)}`)
}

const worst = [...audited].sort((a, b) => b.novelSilent.length - a.novelSilent.length).slice(0, 6)
console.log('\nmost silent entities in one rewrite:')
for (const row of worst) {
  const values = row.novelSilent.map((entity) => `${entity.kind}:${entity.value}`).join(' | ')
  console.log(`  ${row.arm.padEnd(10)} ${row.draftId.padEnd(9)} ${String(row.draftChars).padStart(4)} → ${String(row.chars).padStart(4)} chars  x${row.growth}  ${values || '(none)'}`)
}

console.log('\ntemplate sections per arm (rewrites containing one):')
for (const arm of wanted) {
  const list = audited.filter((row) => row.arm === arm)
  const counts = new Map()
  for (const row of list) for (const name of row.templateHits) counts.set(name, (counts.get(name) ?? 0) + 1)
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])
  console.log(`  ${arm.padEnd(10)} ${top.map(([name, count]) => `${name}×${count}`).join(', ') || '(none)'}`)
}

console.log('\nsilent entities per arm (outside the assumptions section):')
for (const arm of wanted) {
  const flat = audited.filter((row) => row.arm === arm).flatMap((row) => row.novelSilent.map((entity) => `${row.draftId}:${entity.kind}:${entity.value}`))
  console.log(`  ${arm.padEnd(10)} ${flat.length} → ${flat.join(', ') || '(none)'}`)
}

console.log('\nrewrites prescribing what an answer must cover:')
for (const arm of wanted) {
  const list = audited.filter((row) => row.arm === arm && row.answerContract.length > 0)
  console.log(`  ${arm.padEnd(10)} ${list.length} → ${list.map((row) => `${row.draftId}(${row.answerContract.join('/')})`).join(', ') || '(none)'}`)
}

const show = flag('show', null)
if (show !== null) {
  const draft = draftsById.get(show) ?? '(no such draft in this run)'
  console.log(`\n── draft ${show} ──\n${draft}`)
  for (const row of rows.filter((entry) => entry.draftId === show)) {
    console.log(`\n── ${row.arm} (${row.text.length} chars) ──\n${String(row.text).slice(0, 4000)}`)
  }
}

let judged = null
if (judge) {
  console.log('\n── model half (--judge) ──')
  console.log(`attribution prompt: scripts/eval/attribution-prompt.txt (${readText(join(EVAL_DIR, 'attribution-prompt.txt')).trim().length} chars)${repeat > 1 ? `, repeated ${repeat}x` : ''}\n`)
  judged = await runJudge(rows, draftsById)
  if (judged !== null) {
    console.log('\narm         n  items  unparsed  stated  labeled  silent  dropped  silent/rewrite  silent%  rowsWithSilent')
    for (const row of judged.summary) {
      console.log(`  ${row.arm.padEnd(10)} ${String(row.n).padStart(2)} ${String(row.items).padStart(6)} ${String(row.unparsed).padStart(9)} ${String(row.stated).padStart(7)} ${String(row.labeled).padStart(8)} ${String(row.silent).padStart(7)} ${String(row.dropped).padStart(8)} ${String(row.silentPerRewrite).padStart(15)} ${String(row.silentShare).padStart(8)} ${String(`${row.rowsWithSilent}/${row.n}`).padStart(16)}`)
    }
    if (repeat > 1) {
      console.log('\nper pass (this is the honest shape of the number):')
      for (const row of judged.summary) {
        const perPass = judged.passes.map((pass) => pass.find((entry) => entry.arm === row.arm)).filter(Boolean)
        console.log(`  ${row.arm.padEnd(10)} silent/rewrite ${perPass.map((entry) => entry.silentPerRewrite).join(', ')}  (min ${row.silentPerRewriteMin}, max ${row.silentPerRewriteMax})  unparsed ${perPass.map((entry) => entry.unparsed).join(', ')}`)
      }
    }
    const examples = judged.detail.flatMap((row) => row.items.filter((item) => item.kind === 'silent').map((item) => ({ ...item, arm: row.arm, draftId: row.draftId, pass: row.pass })))
    console.log(`\n${examples.length} silent item(s) across ${repeat} pass(es); first 12:`)
    for (const item of examples.slice(0, 12)) console.log(`  p${item.pass} ${item.arm.padEnd(10)} ${item.draftId.padEnd(9)} ${item.claim.slice(0, 80)}`)
  }
}

mkdirSync(outDir, { recursive: true })
const file = join(outDir, `${stamp()}-attribution.json`)
writeFileSync(file, `${JSON.stringify({ stamp: new Date().toISOString(), source: runFile, offline, judged }, null, 2)}\n`, 'utf8')
console.log(`\n→ ${file}`)

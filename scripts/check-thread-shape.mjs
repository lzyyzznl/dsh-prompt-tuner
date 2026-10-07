/**
 * Check the side-question message shape against the DSH build that is actually
 * installed, instead of against a copy of its rules.
 *
 * `scripts/check.mjs` is hermetic: it locks the shape our host half produces
 * (every assistant turn carries a `source`, the folded fallback is one user
 * turn) but it cannot know whether DSH still accepts that shape. This script
 * asks DSH itself: it loads the installed `@deepseek-ai/dsh-llm` and drives
 * `LlmRuntime#forAdapter`, the gate that killed the first follow-up with
 * `Cannot read properties of undefined (reading 'replayState')` — it reads
 * `message.source.replayState` on every assistant message before dispatch.
 *
 * Kept out of `npm run check` on purpose: the self-test must run on a machine
 * with no DSH installed. This one is a post-upgrade smoke test.
 *
 * Usage:
 *   node scripts/check-thread-shape.mjs [path/to/@deepseek-ai/dsh-llm/lib/index.js]
 *
 * Exit codes: 0 = the installed DSH accepts the shape, 1 = it does not (the
 * message list is printed), 2 = no DSH build found (skipped, nothing asserted).
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const LLM_ENTRY = join('@deepseek-ai', 'dsh-llm', 'lib', 'index.js')
const DSH_PACKAGE = join('@deepseek-ai', 'dsh', 'node_modules', LLM_ENTRY)

/** Every place this checkout could plausibly sit relative to a DSH install. */
function candidates() {
  const roots = [
    process.env.APPDATA === undefined ? null : join(process.env.APPDATA, 'npm', 'node_modules'),
    process.env.npm_config_prefix === undefined ? null : join(process.env.npm_config_prefix, 'lib', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
  ].filter((root) => root !== null)
  return [
    process.argv[2] ?? null,
    join(process.cwd(), 'node_modules', LLM_ENTRY),
    join(process.cwd(), '..', 'node_modules', LLM_ENTRY),
    ...roots.map((root) => join(root, DSH_PACKAGE)),
    ...roots.map((root) => join(root, LLM_ENTRY)),
  ].filter((path) => path !== null)
}

const found = candidates().find((path) => existsSync(path))
if (found === undefined) {
  console.log('SKIP  no installed DSH build found — pass the path explicitly:')
  console.log('      node scripts/check-thread-shape.mjs <dsh>/node_modules/@deepseek-ai/dsh-llm/lib/index.js')
  process.exit(2)
}

const { default: LlmRuntime } = await import(pathToFileURL(found).href)
const { buildBtwMessages, buildBtwThreadAsTurn } = await import(pathToFileURL(join(import.meta.dirname, '..', 'lib', 'prompt.js')).href)

/* `forAdapter` only reads `this.adapters`, so a bare instance is enough. */
const runtime = Object.create(LlmRuntime.prototype)
runtime.adapters = new Map()
const adapter = { name: 'stub' }
runtime.adapters.set('deepseek-official', { adapter })

let failures = 0
function probe(label, messages, expected) {
  let accepted = true
  let detail = ''
  try {
    runtime.forAdapter({ messages }, adapter)
  } catch (error) {
    accepted = false
    detail = String(error?.message ?? error)
  }
  if (accepted === expected) {
    console.log(`  ok    ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL  ${label} — expected ${expected ? 'accepted' : 'rejected'}, got ${accepted ? 'accepted' : 'rejected'}`)
  if (detail !== '') console.log(`        ${detail}`)
}

console.log(`checking dsh-prompt-tuner's side-question messages against ${found}\n`)

const context = '用户：改一下登录页\n\n助手：好的'
const history = [
  { question: '第一个问题', answer: '第一个答案' },
  { question: '第二个问题', answer: '第二个答案' },
]

probe('first question (one user turn)',
  buildBtwMessages({ question: '第三问', context, history: [], provider: 'deepseek-official', model: 'deepseek-flash' }), true)

probe('follow-up (thread as user/assistant pairs)',
  buildBtwMessages({ question: '第三问', context, history, provider: 'deepseek-official', model: 'deepseek-flash' }), true)

probe('follow-up (folded single-turn fallback)',
  buildBtwThreadAsTurn({ question: '第三问', context, history }), true)

probe('an assistant turn with no source is still rejected (the regression this guards)',
  [...buildBtwMessages({ question: '第三问', context, history, provider: 'deepseek-official', model: 'deepseek-flash' })]
    .map((message) => (message.role === 'assistant' ? { role: message.role, content: message.content } : message)), false)

if (failures === 0) {
  console.log('\nPASS  the installed DSH dispatches every shape this plugin builds')
  process.exit(0)
}
console.log(`\nFAIL  ${failures} shape(s) rejected — see the messages above`)
process.exit(1)

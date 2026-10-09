/**
 * Check the session-title refresher against the DSH build that is actually
 * installed, instead of against a fake session object.
 *
 * `scripts/check.mjs` is hermetic: it drives `lib/title.js` with a hand-written
 * session (an event array, an `append` that dispatches, a counter), which locks
 * the policy but cannot know whether the real `Session` still behaves the way
 * that fake assumes — that `session/event` observers can be subscribed to from a
 * plugin's own context, that `Session#append` still refuses to be reentered while
 * an append is being published (the reason every write this plugin makes is
 * deferred to a microtask), that `header.parentSession` still marks a fork, and
 * that a `session/title` event written straight to the log still folds into the
 * `title` projection the client reads.
 *
 * This script asks DSH itself: it boots a real Cordis context with the real
 * session store, projection registry and session-title service, installs the
 * real refresher on it, and drives real sessions. No model call is made (the
 * `ask` seam is a stub), no session is persisted, and nothing is written to the
 * DSH home.
 *
 * Kept out of `npm run check` on purpose: the self-test must run on a machine
 * with no DSH installed. This one is a post-upgrade smoke test.
 *
 * Usage:
 *   node scripts/check-title-shape.mjs [path]
 *
 * `path` may be a DSH app root (the directory holding `resources/app`), a
 * `node_modules` directory, or the `@deepseek-ai/dsh-session` package
 * directory. Without it the usual install locations are probed.
 *
 * Exit codes: 0 = the installed DSH behaves as expected, 1 = it does not (each
 * mismatch is printed), 2 = no DSH build found (skipped, nothing asserted).
 */

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const SESSION_ENTRY = join('@deepseek-ai', 'dsh-session', 'lib', 'index.js')
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

/** Directories that plausibly contain a per-profile DSH install. */
function profileDirs() {
  const root = join(DSH_HOME, 'profiles')
  if (!existsSync(root)) return []
  try {
    return readdirSync(root).map((name) => join(root, name, 'node_modules'))
  } catch {
    return []
  }
}

/** Desktop install roots worth scanning, per platform. */
function installRoots() {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA === undefined ? null : join(process.env.LOCALAPPDATA, 'Programs'), '/Applications', join(homedir(), 'Applications'), '/opt'].filter((root) => typeof root === 'string' && root !== '')
  const apps = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    try {
      for (const name of readdirSync(root)) {
        if (/dsh/i.test(name)) apps.push(join(root, name, 'resources', 'app', 'node_modules'))
      }
    } catch {
      /* an unreadable install root is simply not a candidate */
    }
  }
  return apps
}

/**
 * Turn one caller-supplied path into the `node_modules` directories it could
 * mean: the path itself, its own `node_modules`, and its `resources/app` form.
 */
function supplied(arg) {
  if (arg === undefined) return []
  return [
    arg,
    join(arg, 'node_modules'),
    join(arg, 'resources', 'app', 'node_modules'),
    join(arg, '@deepseek-ai', 'dsh-session'),
  ]
}

const roots = [
  ...supplied(process.argv[2]),
  join(process.cwd(), 'node_modules'),
  join(process.cwd(), '..', 'node_modules'),
  ...profileDirs(),
  ...installRoots(),
]
const resolved = roots.map((root) => join(root, SESSION_ENTRY)).find((path) => existsSync(path))
if (resolved === undefined) {
  console.log('SKIP  no installed DSH build found — pass one explicitly:')
  console.log('      node scripts/check-title-shape.mjs <dsh-app-root-or-node_modules>')
  process.exit(2)
}

/** The `node_modules` directory the session package was found in. */
const MODULES = resolved.slice(0, -SESSION_ENTRY.length)
const load = async (name) => import(pathToFileURL(join(MODULES, ...name.split('/'), 'lib', 'index.js')).href)

const { Context } = await load('@deepseek-ai/cordis')
const sessionModule = await load('@deepseek-ai/dsh-session')
const { default: SessionStore, SessionId } = sessionModule
const { default: SessionProjectionRegistry } = await load('@deepseek-ai/dsh-session-projection')
const { default: SessionTitleService } = await load('@deepseek-ai/dsh-session-title')
const { createUserMessage } = await load('@deepseek-ai/dsh-llm')
const title = await import(pathToFileURL(join(import.meta.dirname, '..', 'lib', 'title.js')).href)

let failures = 0
function probe(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok    ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

const settle = async () => {
  await new Promise((done) => setTimeout(done, 0))
  await new Promise((done) => setTimeout(done, 0))
}

console.log(`checking dsh-prompt-tuner's session-title refresher against ${MODULES}\n`)

/* ── the real services, with no title provider registered (as a deployment
      that lets this plugin be the only writer would have it) ── */
const ctx = new Context()
const fibers = []
for (const [plugin, config] of [
  [SessionStore],
  [SessionProjectionRegistry],
  [SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 }],
]) {
  const fiber = ctx.plugin(plugin, config)
  fibers.push(fiber)
  await fiber.await()
}

/* ── the plugin's own refresher, installed exactly the way `lib/index.js` does ── */
const settings = { titleRerollTurns: 3, titleMaxChars: 12 }
const asks = []
const warnings = []
let watcher = null
const watcherFiber = ctx.plugin({
  name: 'title-shape-check',
  // Exactly what `lib/index.js` declares: a Cordis service is only readable from
  // a context that injects it, and this plugin reads `ctx.sessions` for the seed
  // and for the liveness re-check before a write.
  inject: ['sessions'],
  apply(scoped) {
    watcher = title.installSessionTitles(scoped, {
      readSettings: () => settings,
      ask: async (request) => {
        asks.push(request)
        return { ok: true, text: '模型给的标题', model: { provider: 'stub', model: 'stub-1' } }
      },
      logger: { warn: (message) => warnings.push(String(message)), info() {} },
    })
  },
})
fibers.push(watcherFiber)
await watcherFiber.await()

probe('the refresher subscribes to a real session event stream', watcher !== null)
probe('existing live sessions are seeded without a model call', asks.length === 0)

const session = ctx.sessions.create(SessionId('title-shape-check'))
const say = (target, text) => target.append('user/message', createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
}), { surfaceOp: 'append' })
session.append('turn/start', { turn: 1 })

/* ── the initial title stays the harness's, and nothing is written before the
      configured number of messages ── */
say(session, '第一条消息')
await settle()
const initial = ctx.sessionTitle.get(session)
probe('the initial title is still the harness\'s first-message fallback',
  initial?.source?.kind === 'fallback' && asks.length === 0,
  JSON.stringify(initial))

/* ── the boundary: a real append of a real title revision ── */
say(session, '第二条消息')
say(session, '第三条消息')
await settle()
await watcher.whenIdle()
const after = ctx.sessionTitle.get(session)
probe('at the boundary a provider revision is accepted',
  after?.source?.kind === 'provider' && after.source.provider === title.TITLE_PROVIDER_ID,
  JSON.stringify(after))
probe('the accepted title reaches the projection the client list reads',
  ctx.sessionProjections.stateOf(session, 'title') === '模型给的标题',
  String(ctx.sessionProjections.stateOf(session, 'title')))
probe('the configured cap is enforced before the write', after.title === title.clampTitle('模型给的标题', 12), after.title)

const events = session.snapshotEvents()
const revision = events.findLast((event) => event.type === 'session/title' && event.data.source.kind === 'provider')
probe('the revision cites real eligible user messages, in order',
  revision !== undefined
    && revision.data.messageSeqs.length === 3
    && revision.data.messageSeqs.every((seq, index) => events[seq]?.type === 'user/message'
      && events[seq].data.source.kind === 'user'
      && (index === 0 || seq > revision.data.messageSeqs[index - 1])),
  JSON.stringify(revision?.data?.messageSeqs))
probe('the write did not reenter an append being published', warnings.length === 0, warnings.join('|'))
const eligibleSeqs = events
  .filter((event) => event.type === 'user/message' && event.data.source.kind === 'user')
  .map((event) => event.seq)
probe('the window is the newest N messages, whatever seqs they landed on',
  JSON.stringify(revision?.data?.messageSeqs) === JSON.stringify(eligibleSeqs.slice(-3)),
  `${JSON.stringify(revision?.data?.messageSeqs)} vs ${JSON.stringify(eligibleSeqs)}`)
probe('the model call carried the framed window and the cap',
  JSON.parse(asks[0].text).length === 3 && asks[0].system.includes('12 characters'), asks[0].system.split('\n')[2])

/* ── a user rename pins, exactly as the harness's own service documents ── */
ctx.sessionTitle.rename(session, '手写标题')
say(session, '第四条消息')
say(session, '第五条消息')
say(session, '第六条消息')
await settle()
await watcher.whenIdle()
probe('a title the human typed is never replaced by the refresher',
  ctx.sessionTitle.get(session)?.title === '手写标题' && asks.length === 1,
  `${ctx.sessionTitle.get(session)?.title} / ${asks.length} call(s)`)

/* ── a fork inherits its parent's title and is left alone ── */
const forked = ctx.sessions.fork(session, undefined, SessionId('title-shape-check-child'))
await settle()
const asksBeforeChild = asks.length
say(forked, '子会话的第一条')
say(forked, '子会话的第二条')
say(forked, '子会话的第三条')
await settle()
await watcher.whenIdle()
probe('a forked child session is not re-titled',
  asks.length === asksBeforeChild && ctx.sessionTitle.get(forked)?.title === '手写标题',
  `${asks.length} call(s) / ${ctx.sessionTitle.get(forked)?.title}`)
probe('the fork really carries a parent on its header', forked.header.parentSession === session.id)

/* ── the refresher can be disposed and stops reacting ── */
watcher.dispose()
const asksBeforeDispose = asks.length
say(session, '第七条消息')
await settle()
await watcher.whenIdle()
probe('a disposed refresher stops reacting', asks.length === asksBeforeDispose, String(asks.length))

for (const fiber of fibers.reverse()) await fiber.dispose()

if (failures === 0) {
  console.log('\nPASS  the installed DSH accepts every title revision this plugin writes')
  process.exit(0)
}
console.log(`\nFAIL  ${failures} expectation(s) not met — see above`)
process.exit(1)

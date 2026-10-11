#!/usr/bin/env node
/**
 * The admin page's self-check.
 *
 * `lib/service/ui.js` is a string builder whose product is a whole browser
 * program, so the interesting failures are not import errors: they are a
 * dictionary key that exists in one language only, a button no delegated
 * handler answers, a save that quietly drops the credential ids the service
 * needs to keep a breaker's history, or a percentage that reaches the wire as
 * `70` instead of `0.7`.
 *
 * This script therefore does two things the repository's other self-checks
 * cannot: it parses the page's own dictionaries out of the source and compares
 * them, and it runs the page for real — in a hand-written minimum DOM and a
 * `node:vm` context — then drives clicks and reads the request bodies the page
 * produced. No dependency is added and no browser is needed.
 *
 * Usage: `node scripts/check-ui.mjs` — prints `PASS n/n`, exits 0, or prints the
 * failures and exits 1.
 *
 * @module dsh-prompt-tuner/scripts/check-ui
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const UI_FILE = `${ROOT}lib/service/ui.js`
const TOKEN = 'check-ui-token-0123456789'

/* ───────────────────────── harness ───────────────────────── */

let passed = 0
let failed = 0
let sectionName = ''

function section(name) {
  sectionName = name
  process.stdout.write(`\n${name}\n`)
}

function check(name, ok, detail) {
  if (ok) {
    passed += 1
    process.stdout.write(`  ok   ${name}\n`)
    return
  }
  failed += 1
  process.stdout.write(`  FAIL ${name}${detail === undefined ? '' : ` — ${String(detail)}`}\n`)
}

function finish() {
  process.stdout.write(`\n${failed === 0 ? `PASS ${passed}/${passed + failed}` : `FAIL ${passed}/${passed + failed}`}\n`)
  process.exit(failed === 0 ? 0 : 1)
}

/* ───────────────────────── source parsing ───────────────────────── */

const source = readFileSync(UI_FILE, 'utf8')

/**
 * Slice one balanced `{...}` or `[...]` literal out of the source.
 *
 * Braces inside translation strings (`{provider}`), string escapes and comments
 * must not be counted, so the scan tracks them explicitly. This is what lets a
 * check compare the two dictionaries without importing the client half.
 */
function sliceLiteral(text, marker) {
  const at = text.indexOf(marker)
  if (at < 0) return null
  const start = at + marker.length - 1
  const open = text[start]
  const close = open === '{' ? '}' : open === '[' ? ']' : null
  if (close === null) return null
  let depth = 0
  let quote = null
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const c = text[i]
    if (quote !== null) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '/' && text[i + 1] === '/') { const nl = text.indexOf('\n', i); i = nl < 0 ? text.length : nl; continue }
    if (c === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 1; continue }
    if (c === open) depth += 1
    else if (c === close) {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function parseLiteral(text, marker) {
  const sliced = sliceLiteral(text, marker)
  if (sliced === null) return null
  try {
    return vm.runInNewContext(`(${sliced})`, Object.create(null), { timeout: 2000 })
  } catch {
    return null
  }
}

/**
 * Every key the client must be able to resolve: literal `t('...')` calls,
 * `data-i18n` attributes, and the label maps whose values are key names.
 */
function referencedKeys(html) {
  const keys = new Set()
  for (const match of source.matchAll(/\bt\((['"])([A-Za-z0-9_]+)\1\)/g)) keys.add(match[2])
  for (const match of html.matchAll(/data-i18n="([^"]+)"/g)) keys.add(match[1])
  const stat = parseLiteral(source, 'var STAT_KEYS = [') ?? []
  for (const row of stat) if (Array.isArray(row) && typeof row[1] === 'string') keys.add(row[1])
  for (const marker of ['var KIND_KEYS = {', 'var CLASS_KEYS = {', 'var REASON_KEYS = {']) {
    const map = parseLiteral(source, marker) ?? {}
    for (const value of Object.values(map)) keys.add(value)
  }
  for (const match of source.matchAll(/\{ name: '([A-Za-z]+)'/g)) keys.add(match[1])
  for (const key of ['modeProbe', 'modeImmediate']) keys.add(key)
  return keys
}

/* ───────────────────────── a minimum DOM ───────────────────────── */

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

function decodeEntities(text) {
  return String(text)
    .split('&lt;').join('<')
    .split('&gt;').join('>')
    .split('&quot;').join('"')
    .split('&#39;').join("'")
    .split('&amp;').join('&')
}

class DomNode {
  constructor(type, name) {
    this.nodeType = type
    this.tagName = type === 1 ? String(name).toUpperCase() : undefined
    this.nodeName = this.tagName
    this.childNodes = []
    this.parentNode = null
    this.ownerDocument = null
    this._attrs = {}
    this._listeners = {}
    this._text = ''
    this._class = ''
    this._value = ''
    this._valueSet = false
    if (type === 1 && this.tagName === 'TEXTAREA') this._value = null
    this.disabled = false
    this.checked = false
    this.selected = false
    this.readonly = false
    this.multiple = false
    this.focused = false
  }

  /* ── attributes ── */

  setAttribute(name, value) {
    const key = String(name)
    this._attrs[key] = String(value)
    if (key === 'class') this._class = String(value)
    if (key === 'value' && this.tagName !== 'TEXTAREA') { this._value = String(value); this._valueSet = true }
  }

  getAttribute(name) {
    const key = String(name)
    return Object.prototype.hasOwnProperty.call(this._attrs, key) ? this._attrs[key] : null
  }

  removeAttribute(name) { delete this._attrs[String(name)] }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attrs, String(name)) }
  get id() { return this.getAttribute('id') ?? '' }
  set id(value) { this.setAttribute('id', value) }
  get className() { return this._class }
  set className(value) { this._class = String(value); this._attrs.class = String(value) }
  get hidden() { return this.hasAttribute('hidden') }
  set hidden(value) { if (value) this.setAttribute('hidden', ''); else this.removeAttribute('hidden') }

  get value() {
    if (this.tagName === 'SELECT') {
      if (this._valueSet) return this._value
      const chosen = this.childNodes.find((node) => node.nodeType === 1 && node.selected === true)
      return chosen ? chosen.value : ''
    }
    if (this.tagName === 'TEXTAREA' && this._value === null) return this.textContent
    return this._value
  }

  set value(next) {
    this._value = next === null || next === undefined ? '' : String(next)
    this._valueSet = true
    if (this.tagName === 'SELECT') {
      for (const node of this.childNodes) {
        if (node.nodeType === 1 && node.tagName === 'OPTION') node.selected = node.value === this._value
      }
    }
  }

  /* ── text ── */

  get textContent() {
    if (this.nodeType === 3) return this._text
    let out = ''
    for (const child of this.childNodes) out += child.textContent
    return out
  }

  set textContent(value) {
    const text = value === null || value === undefined ? '' : String(value)
    if (this.nodeType === 3) { this._text = text; return }
    for (const child of this.childNodes) child.parentNode = null
    this.childNodes = []
    if (text !== '') this.appendChild(this.ownerDocument.createTextNode(text))
  }

  /* ── tree ── */

  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node)
    node.parentNode = this
    node.ownerDocument = this.ownerDocument
    this.childNodes.push(node)
    return node
  }

  insertBefore(node, reference) {
    if (node.parentNode) node.parentNode.removeChild(node)
    const index = reference ? this.childNodes.indexOf(reference) : -1
    node.parentNode = this
    node.ownerDocument = this.ownerDocument
    if (index < 0) this.childNodes.push(node)
    else this.childNodes.splice(index, 0, node)
    return node
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node)
    if (index >= 0) {
      this.childNodes.splice(index, 1)
      node.parentNode = null
    }
    return node
  }

  contains(node) {
    let current = node
    while (current) {
      if (current === this) return true
      current = current.parentNode
    }
    return false
  }

  get firstChild() { return this.childNodes[0] ?? null }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null }
  get children() { return this.childNodes.filter((node) => node.nodeType === 1) }

  get nextSibling() {
    if (!this.parentNode) return null
    const index = this.parentNode.childNodes.indexOf(this)
    return this.parentNode.childNodes[index + 1] ?? null
  }

  get previousSibling() {
    if (!this.parentNode) return null
    const index = this.parentNode.childNodes.indexOf(this)
    return index <= 0 ? null : this.parentNode.childNodes[index - 1]
  }

  get nextElementSibling() {
    let node = this.nextSibling
    while (node && node.nodeType !== 1) node = node.nextSibling
    return node
  }

  get previousElementSibling() {
    let node = this.previousSibling
    while (node && node.nodeType !== 1) node = node.previousSibling
    return node
  }

  /* ── events ── */

  addEventListener(type, handler) {
    if (typeof handler !== 'function') return
    const list = this._listeners[type] ?? []
    list.push(handler)
    this._listeners[type] = list
  }

  removeEventListener(type, handler) {
    const list = this._listeners[type]
    if (!list) return
    const index = list.indexOf(handler)
    if (index >= 0) list.splice(index, 1)
  }

  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this }
  blur() { if (this.ownerDocument && this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body }
  select() {}

  /* ── selectors ── */

  matches(selector) {
    const parts = selector.trim().split(/\s+/)
    if (parts.length !== 1) return false
    return matchesCompound(this, parseCompound(parts[0]))
  }

  closest(selector) {
    const parts = selector.trim().split(/\s+/)
    // The page only ever uses a single compound with closest(); take the last
    // part if a descendant selector ever appears, which is the useful half.
    const compound = parseCompound(parts[parts.length - 1])
    let node = this
    while (node && node.nodeType === 1) {
      if (matchesCompound(node, compound)) return node
      node = node.parentNode
    }
    return null
  }

  querySelector(selector) { return queryAll(this, selector)[0] ?? null }
  querySelectorAll(selector) { return queryAll(this, selector) }
}

class DomDocument extends DomNode {
  constructor() {
    super(9, '#document')
    this.ownerDocument = this
    this.activeElement = null
    this.visibilityState = 'visible'
    this.hidden = false
    this.execCommand = () => false
  }

  createElement(tag) {
    const node = new DomNode(1, tag)
    node.ownerDocument = this
    return node
  }

  createTextNode(text) {
    const node = new DomNode(3, '#text')
    node._text = String(text)
    node.ownerDocument = this
    return node
  }

  get documentElement() {
    return this.childNodes.find((node) => node.nodeType === 1 && node.tagName === 'HTML') ?? null
  }

  get body() {
    const html = this.documentElement
    if (!html) return null
    return queryAll(html, 'body')[0] ?? null
  }

  getElementById(id) {
    const found = queryAll(this, `#${id}`)
    return found[0] ?? null
  }
}

function parseCompound(text) {
  const spec = { tag: null, id: null, classes: [], attrs: [] }
  let rest = text
  const tag = /^[A-Za-z][A-Za-z0-9-]*/.exec(rest)
  if (tag) { spec.tag = tag[0].toUpperCase(); rest = rest.slice(tag[0].length) }
  while (rest.length > 0) {
    if (rest[0] === '#') {
      const match = /^#([^.#\[]+)/.exec(rest)
      if (!match) break
      spec.id = match[1]
      rest = rest.slice(match[0].length)
      continue
    }
    if (rest[0] === '.') {
      const match = /^\.([^.#\[]+)/.exec(rest)
      if (!match) break
      spec.classes.push(match[1])
      rest = rest.slice(match[0].length)
      continue
    }
    if (rest[0] === '[') {
      const end = rest.indexOf(']')
      if (end < 0) break
      const body = rest.slice(1, end)
      const eq = body.indexOf('=')
      if (eq < 0) {
        spec.attrs.push([body.trim(), null])
      } else {
        const name = body.slice(0, eq).trim()
        let value = body.slice(eq + 1).trim()
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1)
        }
        spec.attrs.push([name, value])
      }
      rest = rest.slice(end + 1)
      continue
    }
    break
  }
  return spec
}

function matchesCompound(node, spec) {
  if (!node || node.nodeType !== 1) return false
  if (spec.tag !== null && node.tagName !== spec.tag) return false
  if (spec.id !== null && node.getAttribute('id') !== spec.id) return false
  for (const name of spec.classes) {
    if (!(` ${node.className} `).includes(` ${name} `)) return false
  }
  for (const [name, value] of spec.attrs) {
    if (!node.hasAttribute(name)) return false
    if (value !== null && node.getAttribute(name) !== value) return false
  }
  return true
}

function descendants(root) {
  const out = []
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 1) { out.push(child); walk(child) }
    }
  }
  walk(root)
  return out
}

function queryAll(root, selector) {
  const parts = selector.trim().split(/\s+/).map(parseCompound)
  let current = [root]
  for (const part of parts) {
    const next = []
    for (const base of current) {
      for (const node of descendants(base)) {
        if (matchesCompound(node, part) && !next.includes(node)) next.push(node)
      }
    }
    current = next
  }
  return current
}

/* ───────────────────────── a minimum HTML parser ───────────────────────── */

function findTagEnd(html, at) {
  let quote = null
  for (let i = at + 1; i < html.length; i += 1) {
    const c = html[i]
    if (quote !== null) { if (c === quote) quote = null; continue }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '>') return i
  }
  return html.length
}

const ATTR_RE = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g

function parseHtml(html) {
  const document = new DomDocument()
  const stack = [document]
  let i = 0
  const pushText = (text) => {
    if (text === '') return
    stack[stack.length - 1].appendChild(document.createTextNode(decodeEntities(text)))
  }
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt < 0) { pushText(html.slice(i)); break }
    if (lt > i) pushText(html.slice(i, lt))
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt)
      i = end < 0 ? html.length : end + 3
      continue
    }
    if (html[lt + 1] === '!') {
      const end = html.indexOf('>', lt)
      i = end < 0 ? html.length : end + 1
      continue
    }
    if (html[lt + 1] === '/') {
      const end = html.indexOf('>', lt)
      const name = html.slice(lt + 2, end).trim().toLowerCase()
      for (let s = stack.length - 1; s > 0; s -= 1) {
        if (stack[s].tagName === name.toUpperCase()) { stack.length = s; break }
      }
      i = end + 1
      continue
    }
    const end = findTagEnd(html, lt)
    const raw = html.slice(lt + 1, end)
    const selfClosing = raw.endsWith('/')
    const body = selfClosing ? raw.slice(0, -1) : raw
    const nameMatch = /^([A-Za-z][A-Za-z0-9-]*)/.exec(body)
    const name = nameMatch ? nameMatch[1].toLowerCase() : ''
    const element = document.createElement(name)
    const attrText = body.slice(nameMatch ? nameMatch[0].length : 0)
    ATTR_RE.lastIndex = 0
    let attr = ATTR_RE.exec(attrText)
    while (attr !== null) {
      const value = attr[2] ?? attr[3] ?? attr[4]
      element.setAttribute(attr[1], value === undefined ? '' : decodeEntities(value))
      attr = ATTR_RE.exec(attrText)
    }
    stack[stack.length - 1].appendChild(element)
    i = end + 1
    if (name === 'script' || name === 'style') {
      const close = html.toLowerCase().indexOf(`</${name}`, i)
      const text = html.slice(i, close < 0 ? html.length : close)
      if (text !== '') element.appendChild(document.createTextNode(text))
      const gt = close < 0 ? -1 : html.indexOf('>', close)
      i = gt < 0 ? html.length : gt + 1
      continue
    }
    if (!VOID_TAGS.has(name) && !selfClosing) stack.push(element)
  }
  document.activeElement = document.body
  return document
}

/* ───────────────────────── running the page ───────────────────────── */

const { renderAdminPage } = await import(new URL('../lib/service/ui.js', import.meta.url))
const PAGE = renderAdminPage({ token: TOKEN, version: '9.9.9', port: 8790, host: '127.0.0.1' })

/**
 * The state the fake service answers with.
 *
 * Deliberately awkward: two credentials on one provider with one of them
 * blacklisted (so both the per-key and the per-provider restore buttons exist),
 * a second provider with a different model list (so a provider switch has a
 * visible effect on a datalist), and a route row naming a provider that no
 * longer exists (so the `not registered` path is exercised too).
 */
function fixtureState() {
  const blocked = {
    unit: 'alpha#k2',
    provider: 'alpha',
    keyId: 'k2',
    reason: 'insufficient_balance',
    message: 'no balance left',
    at: '2026-10-10T03:00:00.000Z',
    recoverAt: null,
    recoverInMs: null
  }
  return {
    version: '9.9.9',
    uptimeMs: 12345,
    server: { host: '127.0.0.1', port: 8790 },
    configFile: '/tmp/router-service.json',
    stateFile: '/tmp/router-service.state.json',
    restartRequired: false,
    converters: [{ id: 'maas', label: 'MaaS', loaded: true }],
    providers: [
      {
        id: 'alpha',
        label: 'Alpha',
        baseURL: 'https://alpha.example/v1',
        keys: [
          { id: 'k1', label: 'main', masked: 'sk-a…1111', set: true, state: 'closed', blacklisted: false, blacklist: null },
          { id: 'k2', label: 'backup', masked: '', set: false, state: 'open', blacklisted: true, blacklist: blocked }
        ],
        apiKey: 'sk-a…1111',
        apiKeySet: true,
        keyCount: 2,
        models: ['alpha-small'],
        discoveredModels: ['alpha-large'],
        allModels: ['alpha-small', 'alpha-large'],
        timeoutMs: 120000,
        contextWindows: { 'alpha-small': 128000 }
      },
      {
        id: 'beta',
        label: 'Beta',
        baseURL: 'https://beta.example/v1',
        keys: [{ id: 'k1', label: '', masked: 'bk…9999', set: true, state: 'half-open', blacklisted: false, blacklist: null }],
        apiKey: 'bk…9999',
        apiKeySet: true,
        keyCount: 1,
        models: ['beta-1'],
        discoveredModels: ['beta-2'],
        allModels: ['beta-1', 'beta-2'],
        timeoutMs: 120000
      }
    ],
    router: {
      enabled: true,
      peakOrder: [
        { provider: 'alpha', model: 'alpha-small' },
        { provider: 'beta', model: 'beta-1' },
        { provider: 'ghost', model: 'ghost-1' }
      ],
      offPeakOrder: [
        { provider: 'alpha', model: 'alpha-small' },
        { provider: 'beta', model: 'beta-1' }
      ],
      retries: 3,
      failureThreshold: 2,
      failureRateThreshold: 0.7,
      minSamples: 5,
      windowSize: 20,
      windowMs: 300000,
      cooldownMs: 30000,
      cooldownFactor: 2,
      cooldownMaxMs: 600000,
      halfOpenSuccesses: 1,
      recoveryMode: 'probe',
      maxSwitches: 0,
      logLevel: 'info',
      budget: 4
    },
    rows: [
      {
        provider: 'alpha', model: 'alpha-small', keyId: 'k1', keyLabel: 'main', unit: 'alpha#k1',
        state: 'closed', consecutive: 0, failures: 1, samples: 4, failureRate: 0.25, threshold: 2,
        failureRateThreshold: 0.7, minSamples: 5, halfOpenSuccesses: 0, halfOpenTarget: 1, trips: 0,
        nextCooldownMs: 30000, openUntil: null, probeStartedAt: null,
        lastFailure: { code: 'TIMEOUT', status: null, message: 'slow', at: 1 }, lastClass: 'retryable',
        registered: true, converter: 'maas', blacklisted: false, blacklist: null
      },
      {
        provider: 'alpha', model: 'alpha-small', keyId: 'k2', keyLabel: 'backup', unit: 'alpha#k2',
        state: 'open', consecutive: 2, failures: 2, samples: 2, failureRate: 1, threshold: 2,
        failureRateThreshold: 0.7, minSamples: 5, halfOpenSuccesses: 0, halfOpenTarget: 1, trips: 1,
        nextCooldownMs: 60000, openUntil: Date.UTC(2026, 9, 10, 4, 0, 0), probeStartedAt: null,
        lastFailure: { code: 'HTTP', status: 402, message: 'no balance left', at: 2 }, lastClass: 'quota',
        registered: true, converter: 'maas', blacklisted: true, blacklist: blocked
      }
    ],
    recent: [
      { kind: 'blacklist', at: 3, provider: 'alpha', keyId: 'k2', to: null, failure: null, message: 'no balance left', state: 'blacklisted', reason: 'insufficient_balance' },
      { kind: 'switch', at: 2, provider: 'alpha', keyId: 'k1', to: 'beta/beta-1', failure: null, message: null, state: 'closed' },
      { kind: 'ignored', at: 1, provider: 'alpha', keyId: 'k1', to: null, failure: 'HTTP/400', message: 'bad request', state: 'closed', reason: 'the request was rejected upstream' },
      { kind: 'unconfigured', at: 0, provider: 'ghost', keyId: null, to: null, failure: null, message: null, state: 'closed' }
    ],
    stats: {
      requests: 10, failures: 2, opens: 1, switches: 1, retries: 1, exhausted: 0,
      probes: 1, probeOk: 1, rejected: 0, ignored: 1, blacklisted: 1
    },
    blacklist: [blocked],
    timeSlot: {
      flavor: 'off-peak',
      status: { status: 'off-peak', weekday: 7, weekend: true, holiday: false, date: '2026-10-11', minutes: 750, label: '低谷', workday: false, source: 'builtin', info: '' },
      calendar: { enabled: false, source: 'builtin', cached: null, lastError: null },
      order: {
        peak: [
          { provider: 'alpha', model: 'alpha-small' },
          { provider: 'beta', model: 'beta-1' },
          { provider: 'ghost', model: 'ghost-1' }
        ],
        offPeak: [
          { provider: 'alpha', model: 'alpha-small' },
          { provider: 'beta', model: 'beta-1' }
        ]
      }
    },
    limits: {
      orderRows: 12, maxRetries: 20, failureThreshold: 100, minFailureRate: 0, maxFailureRate: 1,
      minSamples: 1, maxSamples: 100, minWindowSize: 1, maxWindowSize: 100, minWindowMs: 0,
      maxWindowMs: 3600000, minCooldownMs: 0, maxCooldownMs: 3600000, minCooldownFactor: 1,
      maxCooldownFactor: 10, minHalfOpenSuccesses: 1, maxHalfOpenSuccesses: 10, minSwitches: 0, maxSwitches: 20
    },
    recoveryModes: ['probe', 'immediate'],
    logLevels: ['silent', 'error', 'warn', 'info', 'debug']
  }
}

/** Boot the page in a fresh context and hand back the handles a test needs. */
function bootPage(options = {}) {
  const state = options.state ?? fixtureState()
  const document = parseHtml(PAGE)
  const script = /<script>([\s\S]*)<\/script>/.exec(PAGE)
  const requests = []
  const answers = new Map(Object.entries(options.answers ?? {}))
  const store = new Map()
  const timers = []
  let confirmAnswer = options.confirm !== false

  const answerFor = (path) => (answers.has(path) ? answers.get(path) : state)

  const fetchStub = (url, init) => {
    const record = { url: String(url), options: init ?? {} }
    requests.push(record)
    const path = String(url).split('/admin/api/')[1] ?? ''
    const payload = { ok: true, value: answerFor(path) }
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(payload))
    })
  }

  const sandbox = {
    document,
    navigator: { language: 'zh-CN', userLanguage: 'zh-CN' },
    console,
    URL,
    fetch: fetchStub,
    setTimeout: (fn) => { timers.push(fn); return timers.length },
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    confirm: () => confirmAnswer,
    location: { origin: 'http://127.0.0.1:8790' },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)) }
    }
  }
  sandbox.window = sandbox
  sandbox.self = sandbox
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(script[1], sandbox, { filename: 'admin-page.js' })

  const fire = (node, type) => {
    const event = { type, target: node }
    let current = node
    while (current) {
      const list = current._listeners[type]
      if (list) for (const handler of list.slice()) handler(event)
      current = current.parentNode
    }
  }

  const settle = async (rounds = 6) => {
    for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve))
  }

  const all = (selector) => document.querySelectorAll(selector)
  const posts = () => requests.filter((record) => record.options.method === 'POST')
  const lastBody = (name) => {
    const found = posts().filter((record) => record.url.endsWith(`/admin/api/${name}`))
    const record = found[found.length - 1]
    return record ? JSON.parse(String(record.options.body)) : null
  }

  return {
    document,
    requests,
    posts,
    lastBody,
    all,
    fire,
    settle,
    setConfirm: (value) => { confirmAnswer = value },
    setAnswer: (path, value) => { answers.set(path, value) },
    click: (node) => fire(node, 'click'),
    type: (node, value) => { node.value = value; fire(node, 'input') },
    select: (node, value) => { node.value = value; fire(node, 'change') }
  }
}

/* ───────────────────────── baseline keys ───────────────────────── */

/** Every key the previous revision of this page shipped. */
const BASELINE_KEYS = [
  'serviceName', 'refresh', 'lastUpdated', 'up', 'down', 'loading', 'providers', 'providersHint',
  'addProvider', 'saveProviders', 'thId', 'thLabel', 'thBaseURL', 'thApiKey', 'thModels',
  'thActions', 'apiKeySet', 'apiKeyUnset', 'deleteRow', 'routing', 'routingHint', 'saveRouting',
  'thProvider', 'thModel', 'thRouteLabel', 'moveUp', 'moveDown', 'removeUnregistered', 'notRegistered',
  'enabled', 'retries', 'failureThreshold', 'windowMs', 'cooldownMs', 'cooldownFactor', 'cooldownMaxMs',
  'maxSwitches', 'recoveryMode', 'logLevel', 'modeProbe', 'modeImmediate', 'budget', 'live', 'liveHint',
  'resetBreakers', 'probe', 'probing', 'stateClosed', 'stateHalfOpen', 'stateOpen', 'thState', 'thRoute',
  'thFailures', 'thTrips', 'thCooldown', 'thLastFailure', 'thConverter', 'thProbe', 'recent', 'recentEmpty',
  'stats', 'statRequests', 'statFailures', 'statOpens', 'statSwitches', 'statRetries', 'statExhausted',
  'statProbes', 'statProbeOk', 'rawTitle', 'rawHint', 'rawBase', 'rawChat', 'rawModels', 'copy', 'copied',
  'copyFailed', 'serverPort', 'serverHost', 'savePort', 'restartNotice', 'none', 'saved', 'fixErrors',
  'badResponse', 'netError', 'pollFailed', 'invalidId', 'invalidBaseURL', 'modelsEmptyWarn',
  'invalidNumber', 'duplicateId', 'rowIncomplete', 'reasoningChars', 'attemptLabel', 'attemptUnit',
  'waitLabel', 'probeOk', 'probeFail', 'kindRetry', 'kindFailure', 'kindSwitch', 'kindSuccess',
  'kindExhausted', 'kindNoAlternative', 'kindProbe', 'evRetry', 'evFailure', 'evSwitch', 'evSuccess',
  'evExhausted', 'evNoAlternative', 'evProbe', 'empty', 'noUnregistered'
]

/* ───────────────────────── 1. the document ───────────────────────── */

section('1. renderAdminPage 产出一个完整、自足、无 innerHTML 的文档')

check('返回完整的 HTML 文档（doctype + </html>）', PAGE.startsWith('<!doctype html>') && PAGE.trimEnd().endsWith('</html>'))
check('内嵌 admin token', PAGE.includes(TOKEN) && PAGE.includes('name="router-token"'))
check('整个文档不出现 innerHTML', !PAGE.includes('innerHTML'))
check('只有一个内联 <script>，没有外部脚本',
  (PAGE.match(/<script/g) ?? []).length === 1 && (PAGE.match(/<script src=/g) ?? []).length === 0)
check('保留了 4 秒轮询、可见性暂停与语言切换',
  PAGE.includes('POLL_MS = 4000') && PAGE.includes('visibilityState') && PAGE.includes('lang-toggle'))

const syntax = spawnSync(process.execPath, ['--check', UI_FILE], { encoding: 'utf8' })
check('node --check lib/service/ui.js 通过', syntax.status === 0, (syntax.stderr ?? '').split('\n')[0])

/* ───────────────────────── 2. dictionaries ───────────────────────── */

section('2. 中英词典键集合完全一致，且不存在未翻译/未定义的键')

const strings = parseLiteral(source, 'var STRINGS = {')
check('两本词典都能从源码解析出来', strings !== null && typeof strings.zh === 'object' && typeof strings.en === 'object')
const zhKeys = Object.keys(strings.zh).sort()
const enKeys = Object.keys(strings.en).sort()
check(`键数量一致（zh ${zhKeys.length} / en ${enKeys.length}）`, zhKeys.length === enKeys.length, `${zhKeys.length} vs ${enKeys.length}`)
const onlyZh = zhKeys.filter((key) => !enKeys.includes(key))
const onlyEn = enKeys.filter((key) => !zhKeys.includes(key))
check('键集合完全相同', onlyZh.length === 0 && onlyEn.length === 0, `zh-only ${onlyZh.join(',')} / en-only ${onlyEn.join(',')}`)
const missingBaseline = BASELINE_KEYS.filter((key) => !zhKeys.includes(key) || !enKeys.includes(key))
check(`原有 ${BASELINE_KEYS.length} 个键一个都没丢`, missingBaseline.length === 0, missingBaseline.join(','))
check('所有值都是非空字符串（attemptUnit 的英文空后缀除外）',
  zhKeys.every((key) => typeof strings.zh[key] === 'string' && strings.zh[key] !== '')
  && enKeys.every((key) => typeof strings.en[key] === 'string' && (strings.en[key] !== '' || key === 'attemptUnit')))

const referenced = [...referencedKeys(PAGE)].sort()
const undefinedKeys = referenced.filter((key) => !zhKeys.includes(key) || !enKeys.includes(key))
check(`页面引用的 ${referenced.length} 个键在中英词典里都有定义`, undefinedKeys.length === 0, undefinedKeys.join(','))
check('新增的字段/枚举/原因键都在词典里',
  ['failureRateThreshold', 'minSamples', 'windowSize', 'halfOpenSuccesses', 'thUnit', 'thRate',
    'thBlacklist', 'kindBlacklist', 'kindIgnored', 'kindUnconfigured', 'reasonInsufficientBalance',
    'classRetryable', 'removedOrderRows', 'contextWindowsTitle', 'contextWindowsHint', 'cwModel',
    'cwTokens', 'addContextWindow', 'deleteContextWindow', 'invalidContextWindow', 'cwLimitReached']
    .every((key) => zhKeys.includes(key) && enKeys.includes(key)))

/* ───────────────────────── 3. buttons and handlers ───────────────────────── */

section('3. 每个 data-act 都有委托处理分支，反之亦然')

const fresh = bootPage()
await fresh.settle()
const renderedActs = new Set()
for (const node of fresh.all('*')) {
  if (node.hasAttribute('data-act')) renderedActs.add(node.getAttribute('data-act'))
}
const handledActs = new Set()
for (const match of source.matchAll(/act === '([a-zA-Z0-9-]+)'/g)) handledActs.add(match[1])
const deadButtons = [...renderedActs].filter((act) => !handledActs.has(act)).sort()
const deadBranches = [...handledActs].filter((act) => !renderedActs.has(act)).sort()
check(`渲染出的 ${renderedActs.size} 个 data-act 全部有处理分支`, deadButtons.length === 0, deadButtons.join(','))
check(`源码里的 ${handledActs.size} 个分支都能被渲染出来（没有死分支）`, deadBranches.length === 0, deadBranches.join(','))

/* ───────────────────────── 4. provider blocks and keys ───────────────────────── */

section('4. 供应商区块 = 行列表 + 每行多把 key')

const page = bootPage()
await page.settle()
const keyRows = () => page.all('[data-role="key"]')
const groups = () => page.all('[data-role="provider"]')
const groupOf = (id) => groups().find((node) => node.getAttribute('data-id') === id)
const keyRow = (index) => keyRows()[index]

check('两个供应商各渲染成一个分组', groups().length === 2)
check('多 key 供应商渲染出 2 个 key 行', keyRows().length === 3 && groupOf('alpha').querySelectorAll('[data-role="key"]').length === 2,
  `total ${keyRows().length}`)
check('密钥 hint 显示服务端回传的掩码', keyRow(0).textContent.includes('sk-a…1111'))
check('未配置的密钥显示「未配置」', keyRow(1).textContent.includes(strings.zh.keyUnset))
check('拉黑的 key 行显示拉黑徽标与原因',
  keyRow(1).textContent.includes(strings.zh.blacklisted)
  && keyRow(1).textContent.includes(strings.zh.reasonInsufficientBalance))
check('拉黑的 key 行才有「恢复」按钮',
  keyRow(1).querySelector('button[data-act="restore-key"]') !== null
  && keyRow(0).querySelector('button[data-act="restore-key"]') === null)
check('有拉黑 key 的供应商出现「恢复全部」', groupOf('alpha').querySelector('button[data-act="restore-provider"]') !== null
  && groupOf('beta').querySelector('button[data-act="restore-provider"]') === null)
check('每个 key 行都有探测与删除按钮',
  keyRows().every((row) => row.querySelector('button[data-act="probe-key"]') !== null
    && row.querySelector('button[data-act="delete-key"]') !== null))

/* ───────────────────────── 5. save semantics ───────────────────────── */

section('5. 密钥语义：留空即保留、按 id 回传、增删即增删')

const save1 = bootPage()
await save1.settle()
save1.click(save1.all('button[data-act="save-providers"]')[0])
await save1.settle()
const body1 = save1.lastBody('config')
const rowErrors = save1.all('[data-role="row-error"]').map((node) => node.textContent).filter((text) => text !== '')
check('保存供应商会 POST /admin/api/config', body1 !== null && body1.providers !== undefined, `posts=${JSON.stringify(save1.posts().map((r) => r.url))} rowErrors=${rowErrors.join('|')}`)
check('已有 key 的 id 原样回传', !!body1 && body1.providers.alpha.keys[0].id === 'k1' && body1.providers.alpha.keys[1].id === 'k2')
check('留空的密钥提交为空字符串（服务端据此保留已存值）',
  !!body1 && body1.providers.alpha.keys[0].key === '' && body1.providers.alpha.keys[1].key === '')
check('密钥标签原样提交', !!body1 && body1.providers.alpha.keys[0].label === 'main' && body1.providers.alpha.keys[1].label === 'backup')
check('供应商其它字段随行提交', !!body1 && body1.providers.alpha.baseURL === 'https://alpha.example/v1'
  && body1.providers.alpha.models.join(',') === 'alpha-small'
  && body1.providers.alpha.timeoutMs === 120000)
check('headers 已从提交体里消失（字段被整条移除）',
  !!body1 && body1.providers.alpha.headers === undefined, JSON.stringify(body1?.providers?.alpha))
check('请求带上内嵌 token 头',
  save1.posts().every((record) => record.options.headers['X-Router-Token'] === TOKEN))

const save2 = bootPage()
await save2.settle()
const alpha2 = save2.all('[data-role="provider"]').find((node) => node.getAttribute('data-id') === 'alpha')
save2.click(alpha2.querySelectorAll('[data-role="key"]')[1].querySelector('button[data-act="delete-key"]'))
await save2.settle()
check('删除 key 行后分组里只剩 1 行（且 key-count 跟着变）',
  alpha2.querySelectorAll('[data-role="key"]').length === 1
  && alpha2.querySelector('[data-role="key-count"]').textContent === '1')
save2.click(save2.all('button[data-act="save-providers"]')[0])
await save2.settle()
const body2 = save2.lastBody('config')
check('删除 key 后提交的 keys 少一项', !!body2 && body2.providers.alpha.keys.length === 1 && body2.providers.alpha.keys[0].id === 'k1')

const save3 = bootPage()
await save3.settle()
const alpha3 = save3.all('[data-role="provider"]').find((node) => node.getAttribute('data-id') === 'alpha')
save3.click(alpha3.querySelector('button[data-act="add-key"]'))
await save3.settle()
save3.type(alpha3.querySelectorAll('[data-role="key"]')[2].querySelector('input[data-field="key-label"]'), 'third')
save3.type(alpha3.querySelectorAll('[data-role="key"]')[2].querySelector('input[data-field="key"]'), 'sk-new')
save3.click(save3.all('button[data-act="save-providers"]')[0])
await save3.settle()
const body3 = save3.lastBody('config')
check('新增密钥行后提交的 keys 多一项', !!body3 && body3.providers.alpha.keys.length === 3)
check('新增的密钥不带 id（由服务端分配 k1/k2/…）', !!body3 && body3.providers.alpha.keys[2].id === undefined)
check('新增密钥的新值被提交', !!body3 && body3.providers.alpha.keys[2].key === 'sk-new')

/* ───────────────────────── 6. percent ───────────────────────── */

section('6. failureRateThreshold 百分比换算')

const noHeaders = bootPage()
await noHeaders.settle()
check('供应商表单里不再有 headers 输入框与标签',
  noHeaders.all('textarea[data-field="headers"]').length === 0
  && !noHeaders.document.body.textContent.includes('headers (JSON)'),
  `剩 ${noHeaders.all('textarea[data-field="headers"]').length} 个 headers 框`)

const percent = bootPage()
await percent.settle()
const rateBox = percent.document.querySelector('input[data-field="failureRateThreshold"]')
check('失败率阈值按百分比预填（0.7 → 70）', rateBox !== null && rateBox.value === '70', rateBox ? rateBox.value : 'missing')
percent.type(rateBox, '70')
percent.click(percent.all('button[data-act="save-routing"]')[0])
await percent.settle()
const routerBody = percent.lastBody('config')
check('输入 70 提交 0.7', routerBody !== null && routerBody.router.failureRateThreshold === 0.7,
  JSON.stringify(routerBody && routerBody.router))

const percentBad = bootPage()
await percentBad.settle()
percentBad.type(percentBad.document.querySelector('input[data-field="failureRateThreshold"]'), '200')
const beforeBad = percentBad.posts().length
percentBad.click(percentBad.all('button[data-act="save-routing"]')[0])
await percentBad.settle()
check('越界百分比被拦下并显示行内错误',
  percentBad.posts().length === beforeBad
  && percentBad.document.querySelector('[data-err="failureRateThreshold"]').textContent.includes(strings.zh.invalidPercent))

const noModelsState = fixtureState()
noModelsState.providers[1].models = []
noModelsState.providers[1].allModels = ['beta-2']
const noModels = bootPage({ state: noModelsState })
await noModels.settle()
const beforeNoModels = noModels.posts().length
noModels.click(noModels.all('button[data-act="save-providers"]')[0])
await noModels.settle()
// An empty manual list is legal ("use whatever /models discovers"), so the save
// must go through with a warning instead of being blocked by a row error.
check('手工模型列表为空时不再拦截，只给出警告',
  noModels.posts().length === beforeNoModels + 1
  && !noModels.all('[data-role="row-error"]').some((node) => node.textContent !== '')
  && noModels.document.getElementById('toasts').textContent.includes('beta'))

const newFields = bootPage()
await newFields.settle()
check('新增的三个整数字段渲染成数值输入框',
  ['minSamples', 'windowSize', 'halfOpenSuccesses'].every((name) => {
    const node = newFields.document.querySelector(`input[data-field="${name}"]`)
    return node !== null && node.getAttribute('type') === 'number'
  }))

/* ───────────────────────── 7. routing datalists ───────────────────────── */

section('7. 路由行切换供应商时只重建该行 datalist')

const route = bootPage()
await route.settle()
const orderBody = route.document.querySelector('tbody[data-role="route-body"][data-kind="peak"]')
const routeRows = orderBody.querySelectorAll('tr')
const firstRow = routeRows[0]
const optionsOf = (tr) => tr.querySelector('datalist').querySelectorAll('option').map((node) => node.value)
check('模型列是 input[list] + datalist，选项来自该行的 provider',
  firstRow.querySelector('input[data-field="model"]').getAttribute('list')
    === firstRow.querySelector('datalist').getAttribute('id')
  && optionsOf(firstRow).join(',') === 'alpha-small,alpha-large')
const badgeState = (tr) => {
  const badge = tr.querySelector('[data-role="provider-badge"]')
  return badge === null ? null : badge.hidden
}
check('未注册的 provider 行仍显示并标注未注册',
  badgeState(routeRows[2]) === false && badgeState(routeRows[0]) === true
  && routeRows[2].textContent.includes(strings.zh.notRegistered))
route.select(firstRow.querySelector('select[data-field="provider"]'), 'beta')
check('切换 provider 后该行 datalist 立刻变成 beta 的 allModels', optionsOf(firstRow).join(',') === 'beta-1,beta-2')
check('切换 provider 不影响其它行已填的值',
  optionsOf(routeRows[1]).join(',') === 'beta-1,beta-2'
  && routeRows[1].querySelector('input[data-field="model"]').value === 'beta-1')

const addRoute = bootPage()
await addRoute.settle()
const addRouteButton = addRoute.all('button[data-act="add-route"]')[0]
for (let i = 0; i < 20; i += 1) addRoute.click(addRouteButton)
const orderRows = addRoute.document.querySelector('tbody[data-role="route-body"][data-kind="peak"]').querySelectorAll('tr')
check('新增路由行不超过服务端的 orderRows 上限（12）', orderRows.length === 12, `rows=${orderRows.length}`)
check('达到上限时给出提示',
  addRoute.document.getElementById('toasts').textContent
    .includes(strings.zh.routeLimitReached.split('{count}')[0].trim()))

/* ───────────────────────── 8. live, blacklist, notices ───────────────────────── */

section('8. 运行时区按 key 展示，拉黑可恢复，移除路由有提示')

const live = bootPage()
await live.settle()
const liveRows = live.document.getElementById('live-body').childNodes.filter((node) => node.nodeType === 1)
const liveText = liveRows.map((node) => node.textContent)
check('实时表每个 unit 一行，并显示 provider#kN',
  liveRows.length === 2 && liveText[0].includes('alpha#k1') && liveText[1].includes('alpha#k2'))
check('失败率以百分比展示、样本数可见', liveText[0].includes('25%') && liveText[0].includes('4/5'))
check('最近失败带分类标签', liveText[1].includes('402') && liveText[1].includes(strings.zh.classQuota))
const blacklistRows = live.document.getElementById('blacklist-body').childNodes.filter((node) => node.nodeType === 1)
check('拉黑区渲染出条目与恢复按钮',
  blacklistRows.length === 1 && blacklistRows[0].textContent.includes('alpha#k2')
  && blacklistRows[0].querySelector('button[data-act="restore-key"]') !== null)
const eventText = live.document.getElementById('recent-body').textContent
check('事件列表显示 keyId', eventText.includes('k2') && eventText.includes(strings.zh.kindBlacklist))

const restored = bootPage()
await restored.settle()
restored.click(restored.document.querySelector('#sec-blacklist').querySelector('button[data-act="restore-key"]'))
await restored.settle()
const restoreBody = restored.lastBody('keys/restore')
check('点恢复会 POST /admin/api/keys/restore 且带 provider/keyId',
  restoreBody !== null && restoreBody.provider === 'alpha' && restoreBody.keyId === 'k2', JSON.stringify(restoreBody))

const removedState = fixtureState()
const removed = bootPage({ answers: { config: { ...removedState, removedOrderRows: [{ provider: 'ghost', model: 'ghost-1', reason: 'provider_not_configured' }] } } })
await removed.settle()
removed.click(removed.all('button[data-act="save-providers"]')[0])
await removed.settle()
const notice = removed.document.querySelector('[data-role="removed-notice"]')
check('removedOrderRows 非空时有可见提示（不是静默）',
  notice !== null && notice.hidden === false && notice.textContent.includes('ghost/ghost-1')
  && notice.textContent.includes(strings.zh.reasonProviderNotConfigured), notice ? notice.textContent : 'missing')

removed.click(removed.document.getElementById('lang-toggle'))
check('切换语言后移除提示也跟着换语言',
  notice.textContent.includes(strings.en.reasonProviderNotConfigured)
  && !notice.textContent.includes(strings.zh.reasonProviderNotConfigured), notice.textContent)

const clean = bootPage({ answers: { config: { ...removedState, removedOrderRows: [] } } })
await clean.settle()
clean.click(clean.all('button[data-act="save-providers"]')[0])
await clean.settle()
check('没有移除任何行时提示保持隐藏', clean.document.querySelector('[data-role="removed-notice"]').hidden === true)

/* ───────────────────────── 9. upstream fetch, probe, restore, reset, language ───────────────────────── */

section('9. 上游模型拉取、探测、批量恢复、清除熔断与语言切换')

const modelsPage = bootPage()
await modelsPage.settle()
const alphaModels = modelsPage.all('[data-role="provider"]').find((node) => node.getAttribute('data-id') === 'alpha')
const fetchButton = alphaModels.querySelector('button[data-act="fetch-models"]')
const modelsState = fixtureState()
modelsState.providers[0].discoveredModels = ['alpha-large', 'alpha-x']
modelsState.providers[0].allModels = ['alpha-small', 'alpha-large', 'alpha-x']
modelsPage.setAnswer('models', {
  fetch: { ok: true, code: null, message: null, status: 200, ms: 12, models: ['alpha-large', 'alpha-x'], keyId: 'k1', provider: 'alpha' },
  state: modelsState
})
modelsPage.click(fetchButton)
check('拉取期间按钮进入 loading 态', fetchButton.disabled === true)
await modelsPage.settle()
const modelsBody = modelsPage.lastBody('models')
check('从上游刷新会 POST /admin/api/models，默认用第一把密钥（省略 keyId）',
  modelsBody !== null && modelsBody.provider === 'alpha' && modelsBody.keyId === undefined, JSON.stringify(modelsBody))
const alphaAfter = modelsPage.all('[data-role="provider"]').find((node) => node.getAttribute('data-id') === 'alpha')
check('拉取成功后用返回的 state 重渲染，datalist 出现新模型',
  alphaAfter.querySelector('datalist').querySelectorAll('option').map((node) => node.value).includes('alpha-x'))
check('拉取成功提示与状态行都更新',
  modelsPage.document.getElementById('toasts').textContent.includes('2')
  && alphaAfter.querySelector('[data-role="models-status"]').textContent.includes('2'))
check('拉取结束后按钮恢复可用', alphaAfter.querySelector('button[data-act="fetch-models"]').disabled === false)

const modelsFail = bootPage()
await modelsFail.settle()
modelsFail.setAnswer('models', {
  fetch: { ok: false, code: 'HTTP_401', message: 'bad key', status: 401, ms: 5, models: [], keyId: 'k1', provider: 'alpha' },
  state: fixtureState()
})
modelsFail.click(modelsFail.all('button[data-act="fetch-models"]')[0])
await modelsFail.settle()
const failText = modelsFail.document.getElementById('toasts').textContent
check('拉取失败时把 code 与 message 显示出来', failText.includes('HTTP_401') && failText.includes('bad key'), failText)
check('拉取失败也写进该供应商的状态行',
  modelsFail.all('[data-role="models-status"]')[0].textContent.includes('HTTP_401'))

const probePage = bootPage()
await probePage.settle()
const probeButton = probePage.all('[data-role="key"]')[0].querySelector('button[data-act="probe-key"]')
probePage.setAnswer('probe', {
  probe: { ok: true, code: 'ok', ms: 34, text: 'hello there', reasoningChars: 7, attempts: 1, keyId: 'k1' },
  state: fixtureState()
})
probePage.click(probeButton)
check('探测期间按钮禁用', probeButton.disabled === true)
await probePage.settle()
const probeBody = probePage.lastBody('probe')
check('按 key 探测会 POST /admin/api/probe 且带该 key 的 id',
  probeBody !== null && probeBody.provider === 'alpha' && probeBody.keyId === 'k1', JSON.stringify(probeBody))
const probeOut = probePage.all('[data-role="key"]')[0].querySelector('[data-role="probe-out"]')
check('探测结果就地显示 ok/code/ms/文本片段',
  probeOut.textContent.includes(strings.zh.probeOk) && probeOut.textContent.includes('34ms')
  && probeOut.textContent.includes('hello there'), probeOut.textContent)

const restoreAll = bootPage()
await restoreAll.settle()
const alphaRestore = restoreAll.all('[data-role="provider"]').find((node) => node.getAttribute('data-id') === 'alpha')
restoreAll.click(alphaRestore.querySelector('button[data-act="restore-provider"]'))
await restoreAll.settle()
const restoreAllBody = restoreAll.lastBody('keys/restore')
check('「恢复全部」只带 provider（服务端据此清掉该供应商所有 key）',
  restoreAllBody !== null && restoreAllBody.provider === 'alpha' && restoreAllBody.keyId === undefined,
  JSON.stringify(restoreAllBody))

const resetPage = bootPage()
await resetPage.settle()
resetPage.click(resetPage.document.querySelector('#sec-live').querySelector('button[data-act="reset"]'))
await resetPage.settle()
check('清除熔断状态会 POST /admin/api/reset',
  resetPage.posts().some((record) => record.url.endsWith('/admin/api/reset')))

const langPage = bootPage()
await langPage.settle()
langPage.click(langPage.document.getElementById('lang-toggle'))
const englishAdd = langPage.all('button[data-act="add-key"]')[0].textContent
const englishRate = langPage.document.querySelector('input[data-field="failureRateThreshold"]') !== null
check('语言切换后生成区块也用英文重建',
  englishAdd === strings.en.addKey && langPage.document.documentElement.lang === 'en' && englishRate,
  englishAdd)

/* ───────────────────────── 10. the poll must not fight the operator ───────────────────────── */

section('10. 脏标记与焦点保护')

const changedState = fixtureState()
changedState.providers[0].label = 'Changed on the server'

const dirty = bootPage()
await dirty.settle()
const alphaDirty = dirty.all('[data-role="provider"]').find((node) => node.getAttribute('data-id') === 'alpha')
dirty.type(alphaDirty.querySelector('input[data-field="label"]'), 'typed by hand')
dirty.setAnswer('state', changedState)
dirty.requests.length = 0
dirty.click(dirty.document.getElementById('refresh'))
await dirty.settle()
check('刷新按钮同样走 state 接口', dirty.requests.some((record) => record.url.endsWith('/admin/api/state')))
check('正在编辑的供应商区块不会被刷新覆盖',
  alphaDirty.querySelector('input[data-field="label"]').value === 'typed by hand',
  alphaDirty.querySelector('input[data-field="label"]').value)

const undirty = bootPage()
await undirty.settle()
undirty.setAnswer('state', changedState)
undirty.click(undirty.document.getElementById('refresh'))
await undirty.settle()
check('没有草稿时同一份状态会正常刷新进来',
  undirty.all('[data-role="provider"]').find((node) => node.getAttribute('data-id') === 'alpha')
    .querySelector('input[data-field="label"]').value === 'Changed on the server')

const relink = bootPage()
await relink.settle()
const linkedState = fixtureState()
linkedState.providers.push({
  id: 'gamma', label: 'Gamma', baseURL: 'https://gamma.example/v1',
  keys: [], apiKey: '', apiKeySet: false, keyCount: 0,
  models: ['gamma-1'], discoveredModels: [], allModels: ['gamma-1'],
  timeoutMs: 120000
})
relink.setAnswer('config', { ...linkedState, removedOrderRows: [] })
relink.click(relink.all('button[data-act="save-providers"]')[0])
await relink.settle()
const providerSelects = relink.document.querySelector('tbody[data-role="route-body"][data-kind="peak"]')
  .querySelectorAll('select[data-field="provider"]')
check('保存供应商后路由区的 provider 下拉反映了新的供应商集合',
  providerSelects[0].querySelectorAll('option').map((node) => node.value).includes('gamma'))
check('新供应商的模型出现在路由行 datalist（切到它即重建）',
  (() => {
    const row = relink.document.querySelector('tbody[data-role="route-body"][data-kind="peak"]').querySelectorAll('tr')[0]
    relink.select(row.querySelector('select[data-field="provider"]'), 'gamma')
    return row.querySelector('datalist').querySelectorAll('option').map((node) => node.value).join(',') === 'gamma-1'
  })())

/* ──────────────────────── 11. two order tables ──────────────────────── */

section('11. 排序就是两张可拖动的顺序表（高峰/低谷），不出现数字档位')

const providerOf = (tr) => tr.querySelector('select[data-field="provider"]').value

const routePage = bootPage()
await routePage.settle()
const routingSection = routePage.document.querySelector('#sec-routing')
const peakBody = routingSection.querySelector('tbody[data-role="route-body"][data-kind="peak"]')
const offBody = routingSection.querySelector('tbody[data-role="route-body"][data-kind="off-peak"]')
check('渲染出高峰与低谷两张顺序表', peakBody !== null && offBody !== null)
check('高峰表行序来自 router.peakOrder（alpha,beta,ghost）',
  peakBody.querySelectorAll('tr').length === 3
  && [...peakBody.querySelectorAll('tr')].map(providerOf).join(',') === 'alpha,beta,ghost')
check('低谷表行序来自 router.offPeakOrder（alpha,beta）',
  offBody.querySelectorAll('tr').length === 2
  && [...offBody.querySelectorAll('tr')].map(providerOf).join(',') === 'alpha,beta')
check('两张表的行都可拖拽（draggable）',
  [...peakBody.querySelectorAll('tr')].every((tr) => tr.getAttribute('draggable') === 'true'))
check('页面上不再有内置高峰规则开关或时段表',
  routingSection.querySelector('button[data-act="toggle-business"]') === null
  && routingSection.querySelector('tbody[data-role="slots-body"]') === null
  && routingSection.textContent.includes(strings.zh.peakOrderTitle))

// up/down buttons move rows within their own table; a save carries both lists.
const up = bootPage()
await up.settle()
const upBody = up.document.querySelector('tbody[data-role="route-body"][data-kind="peak"]')
const upRows = () => upBody.querySelectorAll('tr')
check('每行有上移/下移/删除按钮',
  upRows()[1].querySelector('button[data-act="up"]') !== null
  && upRows()[1].querySelector('button[data-act="down"]') !== null
  && upRows()[1].querySelector('button[data-act="del-route"]') !== null)
up.click(upRows()[1].querySelector('button[data-act="up"]'))
check('点上移后该行与前一行互换',
  [...upRows()].map(providerOf).join(',') === 'beta,alpha,ghost')
up.click(up.all('button[data-act="save-routing"]')[0])
await up.settle()
const upBody2 = up.lastBody('config')
check('保存提交 peakOrder + offPeakOrder（顺序即优先级）',
  upBody2 !== null
  && upBody2.router.peakOrder.map((r) => r.provider).join(',') === 'beta,alpha,ghost'
  && upBody2.router.offPeakOrder.map((r) => r.provider).join(',') === 'alpha,beta',
  JSON.stringify(upBody2 && upBody2.router && upBody2.router.peakOrder))
check('提交的行没有任何数字档位字段',
  upBody2 !== null && upBody2.router.peakOrder.every((r) => r.tier === undefined && r.priority === undefined))

const del = bootPage()
await del.settle()
const delBody = del.document.querySelector('tbody[data-role="route-body"][data-kind="off-peak"]')
const delRows = delBody.querySelectorAll('tr')
del.click(delRows[1].querySelector('button[data-act="del-route"]'))
del.click(del.all('button[data-act="save-routing"]')[0])
await del.settle()
const delOut = del.lastBody('config')
check('低谷表删除一行后保存，只提交剩下的行',
  delOut !== null && delOut.router.offPeakOrder.length === 1
  && delOut.router.offPeakOrder[0].provider === 'alpha',
  JSON.stringify(delOut && delOut.router && delOut.router.offPeakOrder))
check('删除不影响另一张表',
  delOut !== null && delOut.router.peakOrder.length === 3,
  JSON.stringify(delOut && delOut.router && delOut.router.peakOrder))

const addPage = bootPage()
await addPage.settle()
const addBody = addPage.document.querySelector('tbody[data-role="route-body"][data-kind="off-peak"]')
const addBtn = addPage.document.querySelector('button[data-act="add-route"][data-kind="off-peak"]')
check('新增按钮带 data-kind 属于各自的表',
  addBtn !== null && addBtn.getAttribute('data-kind') === 'off-peak')
addPage.click(addBtn)
await addPage.settle()
const addRows = addBody.querySelectorAll('tr')
const newTrim = addRows[addRows.length - 1]
addPage.select(newTrim.querySelector('select[data-field="provider"]'), 'beta')
addPage.type(newTrim.querySelector('input[data-field="model"]'), 'beta-2')
addPage.click(addPage.all('button[data-act="save-routing"]')[0])
await addPage.settle()
const addOut = addPage.lastBody('config')
check('新增行在保存时进入对应表末尾',
  addOut !== null
  && addOut.router.offPeakOrder.map((r) => r.provider + '/' + r.model).join(',') === 'alpha/alpha-small,beta/beta-1,beta/beta-2',
  JSON.stringify(addOut && addOut.router && addOut.router.offPeakOrder))

// Drag reorder: front = higher priority; no number is involved anywhere.
const drag = bootPage()
await drag.settle()
const dragBody = drag.document.querySelector('tbody[data-role="route-body"][data-kind="peak"]')
const dr = () => dragBody.querySelectorAll('tr')
check('拖拽前顺序为 alpha,beta,ghost', [...dr()].map(providerOf).join(',') === 'alpha,beta,ghost')
drag.fire(dr()[2], 'dragstart')
drag.fire(dr()[0], 'drop')
drag.click(drag.all('button[data-act="save-routing"]')[0])
await drag.settle()
const dragOut = drag.lastBody('config')
check('拖到顶部后该行成为高峰表第一行（无任何数字参与）',
  dragOut !== null && dragOut.router.peakOrder.map((r) => r.provider).join(',') === 'ghost,alpha,beta',
  JSON.stringify(dragOut && dragOut.router && dragOut.router.peakOrder))

// 图片能力是行级的：勾上一行保存后该行带上 vision: true，其余行干脆不带这个字段。
const vis = bootPage()
await vis.settle()
const visPeak = vis.document.querySelector('tbody[data-role="route-body"][data-kind="peak"]')
const visRows = () => visPeak.querySelectorAll('tr')
check('路由行都有图片勾选框', visRows()[0].querySelector('input[data-field="vision"]') !== null)
visRows()[0].querySelector('input[data-field="vision"]').checked = true
vis.click(vis.all('button[data-act="save-routing"]')[0])
await vis.settle()
const visOut = vis.lastBody('config')
check('勾上的行保存后带 vision: true，其余行不带 vision 字段',
  visOut !== null
  && visOut.router.peakOrder.map((r) => (r.vision === true ? r.provider + ':v' : r.provider)).join(',') === 'alpha:v,beta,ghost',
  JSON.stringify(visOut && visOut.router && visOut.router.peakOrder))
const visState = fixtureState()
visState.router.peakOrder[1] = { provider: 'beta', model: 'beta-1', vision: true }
const visPage2 = bootPage({ state: visState })
await visPage2.settle()
const visPeak2 = visPage2.document.querySelector('tbody[data-role="route-body"][data-kind="peak"]')
check('已有 vision: true 的行渲染时勾选框是勾上的',
  [...visPeak2.querySelectorAll('tr')].map((tr) => tr.querySelector('input[data-field="vision"]').checked).join(',') === 'false,true,false')

/* ──────────────────────── 12. time-slot-line 文案 ──────────────────────── */

section('12. 实时选路行：说清当前高峰/低谷与试序，不再提时段窗口')

const lineOf = async (state) => {
  const page = bootPage({ state })
  // The state arrives over the async /state fetch; let it land before reading.
  await page.settle()
  return { page, text: page.document.getElementById('time-slot-line')?.textContent }
}

const peakState = fixtureState()
peakState.timeSlot = {
  flavor: 'peak',
  status: { status: 'peak', weekday: 3, weekend: false, holiday: false, date: '2026-10-14', minutes: 600, label: '高峰', workday: true, source: 'builtin', info: '' },
  order: {
    peak: [
      { provider: 'alpha', model: 'alpha-small' },
      { provider: 'beta', model: 'beta-1' },
      { provider: 'ghost', model: 'ghost-1' }
    ],
    offPeak: [
      { provider: 'alpha', model: 'alpha-small' },
      { provider: 'beta', model: 'beta-1' }
    ]
  }
}
const peakLine = await lineOf(peakState)
check('高峰：说明行以「当前=高峰」开头并带具体时刻',
  peakLine.text !== undefined && peakLine.text.includes(strings.zh.timeLinePeak.split('{when}')[0])
  && peakLine.text.includes('2026-10-14 10:00')
  && peakLine.text.includes('ghost'),
  peakLine.text)
check('高峰行试序按高峰顺序表展示（alpha → beta → ghost）',
  peakLine.text.includes('alpha → beta → ghost'), peakLine.text)

const offState = fixtureState()
offState.timeSlot = {
  flavor: 'off-peak',
  status: { status: 'off-peak', weekday: 7, weekend: true, holiday: false, date: '2026-10-11', minutes: 750, label: '低谷', workday: false, source: 'builtin', info: '' },
  order: {
    peak: [
      { provider: 'alpha', model: 'alpha-small' },
      { provider: 'beta', model: 'beta-1' },
      { provider: 'ghost', model: 'ghost-1' }
    ],
    offPeak: [
      { provider: 'alpha', model: 'alpha-small' },
      { provider: 'beta', model: 'beta-1' }
    ]
  }
}
const offLine = await lineOf(offState)
check('低谷：说明行以「当前=低谷」开头并展示低谷试序（不含 ghost）',
  offLine.text !== undefined && offLine.text.includes(strings.zh.timeLineOffPeak.split('{when}')[0])
  && offLine.text.includes('alpha → beta')
  && !offLine.text.includes('ghost'),
  offLine.text)

const emptyState = fixtureState()
emptyState.timeSlot = {
  flavor: 'peak',
  status: { status: 'peak', weekday: 3, weekend: false, holiday: false, date: '2026-10-14', minutes: 600, label: '高峰', workday: true, source: 'builtin', info: '' },
  order: { peak: [], offPeak: [] }
}
const emptyLine = await lineOf(emptyState)
check('某张表为空时链上显示「无」，页面不报错',
  emptyLine.text !== undefined && emptyLine.text.includes(strings.zh.none), emptyLine.text)

check('内置表判定时，说明行注明是内置节假日表（回退口径）',
  peakLine.text.includes(strings.zh.timeLineSourceBuiltin), peakLine.text)

// 补班周六：接口说这天上班，但 DeepSeek 按空闲时段计费 —— 说明行必须说清
// 「为什么是低谷」以及「这个周六其实要上班」，否则看起来就是错的。
const makeupState = fixtureState()
makeupState.timeSlot = {
  flavor: 'off-peak',
  status: { status: 'off-peak', weekday: 6, weekend: true, holiday: false, date: '2026-10-10', minutes: 600, label: '低谷', workday: false, makeup: true, source: 'api', info: '国庆节后补班' },
  calendar: { enabled: true, source: 'api', cached: { date: '2026-10-10', workday: true, info: '国庆节后补班', week: '周六', fetchedAt: '2026-10-10T02:00:00.000Z' }, lastError: null },
  order: {
    peak: [{ provider: 'ghost', model: 'ghost-1' }],
    offPeak: [{ provider: 'alpha', model: 'alpha-small' }]
  }
}
const makeupLine = await lineOf(makeupState)
check('补班周末：说明行是「当前=低谷」，注明是外部工作日接口、带补班名称与试序',
  makeupLine.text !== undefined && makeupLine.text.includes(strings.zh.timeLineOffPeak.split('{when}')[0])
  && makeupLine.text.includes('2026-10-10 10:00')
  && makeupLine.text.includes('外部工作日接口') && makeupLine.text.includes('国庆节后补班')
  && makeupLine.text.includes('alpha'),
  makeupLine.text)
check('补班周末：明确写出「调休上班的周末按空闲时段计费，故按低谷处理」',
  makeupLine.text.includes(strings.zh.timeLineMakeup.replace(/^\s*｜\s*/, '')), makeupLine.text)
check('补班周末：高峰表里的 ghost 不出现（这次走的是低谷表）',
  !makeupLine.text.includes('ghost'), makeupLine.text)
check('补班周末不出现「内置节假日表（回退）」这句（判断来自外部接口，不是回退）',
  !makeupLine.text.includes(strings.zh.timeLineSourceBuiltin), makeupLine.text)

// 对外暴露的三个语境名：列表来自服务（/state.timeSlot.northbound），括号里的解释
// 才是页面自己的文案 —— 这样页面不可能宣传一个路由服务其实不认的名字。
const northboundOf = async (state) => {
  const page = bootPage({ state })
  await page.settle()
  const node = page.document.querySelector('[data-northbound]')
  return { page, node, text: node?.textContent }
}
const nbState = fixtureState()
nbState.timeSlot = {
  flavor: 'peak',
  status: { status: 'peak', weekday: 3, weekend: false, holiday: false, date: '2026-10-14', minutes: 600, workday: true, source: 'builtin', info: '' },
  order: { peak: [{ provider: 'alpha', model: 'alpha-small' }], offPeak: [{ provider: 'alpha', model: 'alpha-small' }] },
  northbound: {
    models: [{ id: 'auto', context: 'auto' }, { id: 'peak', context: 'peak' }, { id: 'off-peak', context: 'off-peak' }],
    fallback: 'auto: an unknown name, or a forced context whose order table is empty'
  }
}
const nb = await northboundOf(nbState)
check('对外模型名一行：三个语境名都列出来，各自带上「跟随日历 / 强制哪张表」的说明',
  nb.text !== undefined && nb.text.includes('auto' + strings.zh.northboundAuto)
  && nb.text.includes('peak' + strings.zh.northboundPeak)
  && nb.text.includes('off-peak' + strings.zh.northboundOffPeak),
  nb.text)
check('这一行同时说明「其它名字一律按 auto 服务」',
  nb.text.includes('其它名字'), nb.text)
check('名字列表来自服务而不是页面里写死的第二份拷贝',
  nb.node?.getAttribute('data-northbound') === nbState.timeSlot.northbound.fallback,
  nb.node?.getAttribute('data-northbound'))
const nbMissing = await northboundOf(peakState)
check('服务没报名字时这一行不渲染（对着老版本服务也不报错）',
  nbMissing.node === undefined || nbMissing.node === null)

const routedPage = await lineOf(peakState)
const routingLive = routedPage.page.document.querySelector('#routing-body p.hint')
check('路由页签顶部也有同一句实时选路行',
  routingLive !== null && routingLive.textContent.includes('当前=高峰')
  && routingLive.textContent.includes('alpha → beta → ghost'),
  routingLive ? routingLive.textContent : 'missing')

/* ──────────────────────── 13. context windows ──────────────────────── */

section('13. 上下文窗口：每行一个模型 + 窗口，留空即回落默认/上游发现')

const cwPage = bootPage()
await cwPage.settle()
const cwGroupOf = (id) => cwPage.all('[data-role="provider"]').find((node) => node.getAttribute('data-id') === id)
const alphaCW = cwGroupOf('alpha')
const betaCW = cwGroupOf('beta')
const cwRowsOf = (group) => group.querySelectorAll('[data-role="cw-row"]')
check('服务端回传的窗口渲染成预填行（alpha-small → 128000）',
  cwRowsOf(alphaCW).length === 1
  && cwRowsOf(alphaCW)[0].querySelector('input[data-field="cw-model"]').value === 'alpha-small'
  && cwRowsOf(alphaCW)[0].querySelector('input[data-field="cw-window"]').value === '128000',
  JSON.stringify([...cwRowsOf(alphaCW)].map((row) => ({
    model: row.querySelector('input[data-field="cw-model"]').value,
    window: row.querySelector('input[data-field="cw-window"]').value
  }))))
check('没有窗口的供应商也渲染一个空行（用户知道在哪填）',
  cwRowsOf(betaCW).length === 1
  && cwRowsOf(betaCW)[0].querySelector('input[data-field="cw-model"]').value === ''
  && cwRowsOf(betaCW)[0].querySelector('input[data-field="cw-window"]').value === '')
check('每个供应商区块都有新增窗口按钮，每行有删除按钮，计数徽标等于可见行数',
  alphaCW.querySelector('button[data-act="add-cw"]') !== null
  && betaCW.querySelector('button[data-act="add-cw"]') !== null
  && cwRowsOf(alphaCW)[0].querySelector('button[data-act="remove-cw"]') !== null
  && alphaCW.querySelector('[data-role="cw-count"]').textContent === '1'
  && betaCW.querySelector('[data-role="cw-count"]').textContent === '1')

const cwSave = bootPage()
await cwSave.settle()
cwSave.click(cwSave.all('button[data-act="save-providers"]')[0])
await cwSave.settle()
const bodyCW = cwSave.lastBody('config')
const rowErrorsCW = cwSave.all('[data-role="row-error"]').map((node) => node.textContent).filter((text) => text !== '')
check('保存把已存窗口原样提交，没有窗口的供应商提交空 map（可清空旧值）',
  bodyCW !== null && rowErrorsCW.length === 0
  && bodyCW.providers.alpha.contextWindows['alpha-small'] === 128000
  && JSON.stringify(bodyCW.providers.beta.contextWindows) === '{}',
  `rowErrors=${rowErrorsCW.join('|')} alpha=${JSON.stringify(bodyCW?.providers?.alpha?.contextWindows)} beta=${JSON.stringify(bodyCW?.providers?.beta?.contextWindows)}`)

const cwEdit = bootPage()
await cwEdit.settle()
const cwAlpha = cwEdit.all('[data-role="provider"]').find((node) => node.getAttribute('data-id') === 'alpha')
const cwBeta = cwEdit.all('[data-role="provider"]').find((node) => node.getAttribute('data-id') === 'beta')
cwEdit.type(cwAlpha.querySelector('[data-role="cw-row"] [data-field="cw-window"]'), '262144')
cwEdit.click(cwAlpha.querySelector('button[data-act="add-cw"]'))
const cwNewRows = cwAlpha.querySelectorAll('[data-role="cw-row"]')
cwEdit.type(cwNewRows[1].querySelector('input[data-field="cw-model"]'), 'alpha-large')
// 第二行窗口留空：该模型的覆盖被丢弃（回落上游发现 / 1M 默认）
cwEdit.type(cwBeta.querySelector('[data-role="cw-row"] [data-field="cw-model"]'), 'beta-1')
cwEdit.type(cwBeta.querySelector('[data-role="cw-row"] [data-field="cw-window"]'), '65536')
cwEdit.click(cwEdit.all('button[data-act="save-providers"]')[0])
await cwEdit.settle()
const bodyEdit = cwEdit.lastBody('config')
check('编辑后提交的窗口映射包含改动的值与新行，空窗口行不产生条目',
  bodyEdit !== null
  && bodyEdit.providers.alpha.contextWindows['alpha-small'] === 262144
  && bodyEdit.providers.alpha.contextWindows['alpha-large'] === undefined
  && bodyEdit.providers.beta.contextWindows['beta-1'] === 65536,
  JSON.stringify({ alpha: bodyEdit?.providers?.alpha?.contextWindows, beta: bodyEdit?.providers?.beta?.contextWindows }))
check('新增窗口行后计数徽标跟着变', cwAlpha.querySelector('[data-role="cw-count"]').textContent === '2')

const cwRemove = bootPage()
await cwRemove.settle()
const cwRemoval = cwRemove.all('[data-role="provider"]').find((node) => node.getAttribute('data-id') === 'alpha')
cwRemove.click(cwRemoval.querySelector('[data-role="cw-row"] button[data-act="remove-cw"]'))
cwRemove.click(cwRemove.all('button[data-act="save-providers"]')[0])
await cwRemove.settle()
const bodyRemoved = cwRemove.lastBody('config')
check('删除唯一的窗口行后提交空 map（覆盖被彻底清掉，回到默认/发现）',
  bodyRemoved !== null
  && JSON.stringify(bodyRemoved.providers.alpha.contextWindows) === '{}'
  && cwRemoval.querySelector('[data-role="cw-count"]').textContent === '0',
  JSON.stringify(bodyRemoved?.providers?.alpha?.contextWindows))

const cwBad = bootPage()
await cwBad.settle()
const cwBadAlpha = cwBad.all('[data-role="provider"]').find((node) => node.getAttribute('data-id') === 'alpha')
cwBad.type(cwBadAlpha.querySelector('[data-role="cw-row"] [data-field="cw-window"]'), '0')
const beforeBadCW = cwBad.posts().length
cwBad.click(cwBad.all('button[data-act="save-providers"]')[0])
await cwBad.settle()
check('越界的窗口值被拦下：显示行内错误且不发保存请求',
  cwBad.posts().length === beforeBadCW
  && cwBadAlpha.querySelector('[data-role="row-error"]').textContent.includes(strings.zh.invalidContextWindow),
  cwBadAlpha.querySelector('[data-role="row-error"]').textContent)

const cwNoModel = bootPage()
await cwNoModel.settle()
const cwBadBeta = cwNoModel.all('[data-role="provider"]').find((node) => node.getAttribute('data-id') === 'beta')
cwNoModel.type(cwBadBeta.querySelector('[data-role="cw-row"] [data-field="cw-window"]'), '64000')
const beforeBadBeta = cwNoModel.posts().length
cwNoModel.click(cwNoModel.all('button[data-act="save-providers"]')[0])
await cwNoModel.settle()
check('有窗口没模型的空行同样被拦下',
  cwNoModel.posts().length === beforeBadBeta
  && cwBadBeta.querySelector('[data-role="row-error"]').textContent.includes(strings.zh.invalidContextWindow),
  cwBadBeta.querySelector('[data-role="row-error"]').textContent)

finish()

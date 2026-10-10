/**
 * The service's two faces on one loopback port.
 *
 * ## Southbound of the call, northbound of the contract
 *
 * `/v1/*` is the OpenAI-compatible surface another agent points its `baseURL`
 * at; it carries no authentication because it is bound to loopback and because a
 * credential on the caller's side would have to be invented, distributed and
 * rotated for no gain — the service already holds the upstream credentials, and
 * anything that can reach this port can already read this user's files.
 *
 * `/admin/*` is the management surface. It *is* authenticated, and the reason is
 * narrower than "admin routes are sensitive": a web page the user happens to
 * visit can issue a cross-origin `POST` to `127.0.0.1` whether or not it can read
 * the reply, and reconfiguring a router — or reading a masked credential — is not
 * something a random page should be able to do. The page we serve embeds a token
 * that another origin cannot read, so requiring the header closes that hole while
 * keeping the page itself zero-configuration.
 *
 * ## Errors keep the contract
 *
 * Anything the service itself gets wrong (a malformed body, an unknown path) is
 * answered in the reference contract's error envelope, not in this service's
 * admin envelope, because it is the *caller's* client that has to parse it. The
 * admin face uses its own envelope, because its client is our own page.
 *
 * @module dsh-prompt-tuner/service/server
 */
import { createServer as createHttpServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'

/** Bodies larger than this are refused: a prompt is big, not unbounded. */
const MAX_BODY_BYTES = 32 * 1024 * 1024

/** Prefix every log line from this module carries. */
const LOG_PREFIX = '[router-service]'

/** The addresses a loopback-only service may be reached on. */
const LOOPBACK = Object.freeze(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * Whether a request arrived over the loopback interface.
 *
 * The socket address is authoritative — a `Host` or `Origin` header is supplied
 * by the client and cannot decide who the client is.
 * @param {object} req - the node request.
 * @returns {boolean} whether the peer is this machine.
 */
export function isLoopback(req) {
  const address = req?.socket?.remoteAddress ?? ''
  return LOOPBACK.includes(address)
}

/** Compare two secrets without leaking their length-by-position through timing. */
function tokenMatches(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string') return false
  const a = Buffer.from(expected)
  const b = Buffer.from(provided)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Read a request body up to {@link MAX_BODY_BYTES}. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Write a JSON response. */
function sendJson(res, status, payload, extraHeaders = {}) {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end(text)
}

/** The reference contract's error envelope for a service-level fault. */
function contractError(status, message, code = 'invalid_request_error') {
  const type = status >= 500 ? 'server_error' : status === 429 ? 'rate_limit_error' : 'invalid_request_error'
  return { error: { message, type, param: null, code } }
}

/** The admin face's own envelope: ours, not the caller's. */
const adminOk = (value) => ({ ok: true, value })
const adminFail = (code, message) => ({ ok: false, error: { code, message } })

/**
 * Build the HTTP server.
 *
 * @param {object} options - the wiring.
 * @param {object} options.admin - management façade: `state()`, `save(patch)`, `reset()`, `probe(provider, model, keyId)`, `models(body)`, `restoreKey(body)`, `converters()`.
 * @param {object} options.proxy - the data-plane proxy.
 * @param {(options: object) => string} options.renderPage - the admin page renderer.
 * @param {{token: string, version: string, host: string, port: number}} options.identity - what the page needs to know about itself.
 * @param {{error?: Function, warn?: Function, info?: Function, debug?: Function}} [options.logger] - sink.
 * @returns {{server: object, listen: Function, close: Function, address: () => object|null}} the server handle.
 */
export function createServer(options) {
  const { admin, proxy, renderPage, identity } = options
  const logger = options.logger ?? console
  let listening = null

  /** Answer one `/v1/chat/completions` call, streaming or not. */
  async function handleCompletion(req, res) {
    let text
    try {
      text = await readBody(req)
    } catch (cause) {
      sendJson(res, 413, contractError(413, String(cause?.message ?? cause), 'request_too_large'))
      return
    }
    let body
    try {
      body = JSON.parse(text)
    } catch {
      sendJson(res, 400, contractError(400, 'the request body is not valid JSON'))
      return
    }
    // The caller's own cancellation is what propagates upstream: when the client
    // hangs up, we stop paying for a completion nobody will read.
    const controller = new AbortController()
    const onClose = () => controller.abort(new Error('the caller closed the connection'))
    res.on('close', () => {
      if (!res.writableEnded) onClose()
    })
    let result
    try {
      result = await proxy.run(body, { signal: controller.signal })
    } catch (cause) {
      if (!res.headersSent) sendJson(res, 502, contractError(502, `the routing service failed: ${String(cause?.message ?? cause)}`, 'internal_server_error'))
      else res.destroy()
      return
    }
    if (result.ok !== true) {
      if (!res.headersSent) sendJson(res, result.status ?? 502, result.body ?? contractError(502, 'the request failed'))
      else res.destroy()
      return
    }
    if (result.mode === 'json') {
      sendJson(res, 200, result.body)
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.flushHeaders?.()
    try {
      for await (const chunk of result.chunks) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      }
      res.write('data: [DONE]\n\n')
    } catch (cause) {
      // The answer is already committed, so the only honest ending is an error
      // frame: the client sees that the stream was cut, not a clean finish.
      try {
        res.write(`data: ${JSON.stringify(contractError(502, `the upstream stream failed: ${String(cause?.message ?? cause)}`, 'upstream_stream_failed'))}\n\n`)
      } catch {
        // The socket is gone; there is nobody left to tell.
      }
    } finally {
      res.end()
    }
  }

  /** The request handler. */
  async function handle(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname
    if (!isLoopback(req)) {
      sendJson(res, 403, contractError(403, 'this service only answers requests from this machine', 'forbidden'))
      return
    }
    if (path === '/healthz') {
      sendJson(res, 200, adminOk({ up: true, version: identity.version, port: identity.port }))
      return
    }
    if (path === '/v1/models' && req.method === 'GET') {
      sendJson(res, 200, { object: 'list', data: proxy.models() })
      return
    }
    if (path === '/v1/chat/completions' && req.method === 'POST') {
      await handleCompletion(req, res)
      return
    }
    if (path === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      const html = renderPage({ token: identity.token, version: identity.version, port: identity.port, host: identity.host })
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(req.method === 'HEAD' ? undefined : html)
      return
    }
    if (path.startsWith('/admin/')) {
      if (!tokenMatches(identity.token, req.headers['x-router-token'])) {
        sendJson(res, 401, adminFail('unauthorized', 'a valid X-Router-Token header is required'))
        return
      }
      await handleAdmin(req, res, path)
      return
    }
    sendJson(res, 404, contractError(404, `no route for ${req.method} ${path}`, 'not_found'))
  }

  /** The management face. */
  async function handleAdmin(req, res, path) {
    const wantsPost = path === '/admin/api/config'
      || path === '/admin/api/reset'
      || path === '/admin/api/probe'
      || path === '/admin/api/models'
      || path === '/admin/api/keys/restore'
    if (wantsPost && req.method !== 'POST') {
      sendJson(res, 405, adminFail('method_not_allowed', `${path} is POST only`))
      return
    }
    if (!wantsPost && req.method !== 'GET') {
      sendJson(res, 405, adminFail('method_not_allowed', `${path} is GET only`))
      return
    }
    try {
      if (path === '/admin/api/state') {
        sendJson(res, 200, adminOk(admin.state()))
        return
      }
      if (path === '/admin/api/converters') {
        sendJson(res, 200, adminOk({ converters: admin.converters() }))
        return
      }
      let body = {}
      if (wantsPost) {
        const text = await readBody(req)
        body = text.trim() === '' ? {} : JSON.parse(text)
      }
      if (path === '/admin/api/config') {
        const saved = admin.save(body)
        sendJson(res, 200, adminOk(saved))
        return
      }
      if (path === '/admin/api/reset') {
        sendJson(res, 200, adminOk(admin.reset()))
        return
      }
      if (path === '/admin/api/probe') {
        // Awaiting matters: a probe is a real upstream call, and serializing the
        // promise instead of its result would answer `{}` for every probe.
        sendJson(res, 200, adminOk(await admin.probe(body?.provider, body?.model, body?.keyId)))
        return
      }
      if (path === '/admin/api/models') {
        // Also a real upstream call — a `GET /models` this time, which answers
        // the same question a probe does (does this credential authenticate?)
        // without spending a single token.
        sendJson(res, 200, adminOk(await admin.models(body ?? {})))
        return
      }
      if (path === '/admin/api/keys/restore') {
        sendJson(res, 200, adminOk(admin.restoreKey(body ?? {})))
        return
      }
      sendJson(res, 404, adminFail('not_found', `no such admin action: ${path}`))
    } catch (cause) {
      sendJson(res, 200, adminFail('invalid', String(cause?.message ?? cause)))
    }
  }

  const server = createHttpServer((req, res) => {
    handle(req, res).catch((cause) => {
      const line = `${LOG_PREFIX} unhandled request failure: ${String(cause?.stack ?? cause)}`
      try {
        logger?.error?.call(logger, line)
      } catch {
        console.error(line)
      }
      if (!res.headersSent) sendJson(res, 500, contractError(500, 'the routing service failed', 'internal_server_error'))
      else res.destroy()
    })
  })
  server.keepAliveTimeout = 120_000
  server.headersTimeout = 125_000
  // A streaming completion can legitimately run for minutes; the default request
  // timeout would cut it off mid-answer.
  server.requestTimeout = 0

  return {
    server,
    /**
     * Start listening.
     * @param {string} host - bind address.
     * @param {number} port - bind port.
     * @returns {Promise<{host: string, port: number}>} the bound address.
     */
    listen(host, port) {
      return new Promise((resolve, reject) => {
        const onError = (cause) => reject(cause)
        server.once('error', onError)
        server.listen(port, host, () => {
          server.removeListener('error', onError)
          const address = server.address()
          listening = typeof address === 'object' && address !== null ? address : null
          resolve({ host: listening?.address ?? host, port: listening?.port ?? port })
        })
      })
    },
    /** Stop listening and drop every open connection. */
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      })
    },
    address: () => listening,
  }
}

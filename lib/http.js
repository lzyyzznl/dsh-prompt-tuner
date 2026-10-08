/**
 * HTTP plumbing for the prompt-optimizer host routes: JSON envelope writers,
 * a bounded JSON body reader, and the loopback trust fence.
 *
 * The fence mirrors the ecosystem convention (dsh-web-shared/host/loopback):
 * socket address is authoritative, the Host header must also be loopback, and
 * browser same-origin markers must not contradict it. X-Forwarded-For is never
 * trusted. The routes expose the user's configured LLM, so a non-loopback
 * caller must never reach them.
 *
 * @module dsh-prompt-optimizer/http
 */

/** IPv4 127/8 predicate (four decimal octets, first == 127). */
function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether a socket remote address names the loopback range (127/8, ::1, IPv4-mapped). */
function isLoopbackAddress(address) {
  if (address === undefined) return false
  const normalized = String(address).toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/** Whether a normalized URL hostname names the loopback authority (localhost, [::1], 127/8). */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/**
 * Request-level trust fence for every route this plugin owns.
 * @param {import('node:http').IncomingMessage} request - the incoming request.
 * @returns {boolean} whether the request may proceed.
 */
export function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * Send one JSON response.
 * @param {import('node:http').ServerResponse} res - the response to own.
 * @param {number} status - HTTP status code.
 * @param {unknown} body - JSON-serializable body.
 */
export function writeJson(res, status, body) {
  let text
  try {
    text = JSON.stringify(body)
  } catch {
    status = 500
    text = JSON.stringify({ ok: false, error: { code: 'unserializable', message: 'response body is not JSON' } })
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** Typed failure inside the route layer (never a transport fault). */
export class BadRequest extends Error {
  /** @param {string} message - what was wrong with the request. */
  constructor(message) {
    super(message)
    this.name = 'BadRequest'
  }
}

/**
 * Read and parse one bounded JSON request body.
 * @param {import('node:http').IncomingMessage} req - the request stream.
 * @param {number} maxBytes - hard byte cap; exceeding it refuses the request. Pass `Number.POSITIVE_INFINITY` to read the whole stream (the side-question routes carry the session's own record, whose size is the conversation's size).
 * @returns {Promise<Record<string, unknown>>} the parsed plain object ({} for an empty body).
 * @throws {BadRequest} when the body is oversized, malformed, or not a JSON object.
 */
export async function readJsonBody(req, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new BadRequest(`request body exceeds ${maxBytes} bytes`)
    chunks.push(chunk)
  }
  if (size === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new BadRequest('request body is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BadRequest('request body must be a JSON object')
  }
  return parsed
}

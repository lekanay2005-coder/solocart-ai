/**
 * Wire-level helpers shared by every route: structured JSON errors, body
 * reading with a hard size limit, security headers, and the SameSite session
 * cookie. No route logic lives here.
 */

/** An error that carries an HTTP status and a stable machine-readable code. */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message human-readable, safe to show a seller
   * @param {string} [code] stable code such as `not_found`
   */
  constructor(status, message, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

export const DEFAULT_BODY_LIMIT = 16_000;

/**
 * Reads the whole request body as JSON, refusing anything over `limitBytes`.
 * @returns {Promise<any>}
 */
export async function readJson(request, limitBytes = DEFAULT_BODY_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes) throw new HttpError(413, 'Request is too large.', 'payload_too_large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Request must contain valid JSON.', 'invalid_json');
  }
}

/** The client's IP, used for rate limiting. */
export function clientIp(request) {
  return request.socket.remoteAddress || 'unknown';
}

/** Sends a JSON response with no-store caching. */
export function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

/** The one structured error shape the client understands. */
export function sendError(response, error) {
  // Deliberate errors (built with a status) carry a message meant for the
  // seller; anything else is unexpected and gets a generic one.
  const deliberate = error instanceof HttpError || Number.isInteger(error?.status);
  const status = deliberate ? error.status : 500;
  const code = deliberate && typeof error?.code === 'string' ? error.code : 'internal';
  const message = deliberate ? error.message : 'Something went wrong on the server.';
  if (status >= 500) console.error('[error]', error?.stack || error);
  return sendJson(response, status, { error: message, code });
}

export function redirect(response, destination) {
  response.writeHead(303, { Location: destination, 'Cache-Control': 'no-store' });
  response.end();
}

/**
 * Strict CSP with no inline script: everything the page runs is served from
 * this origin, so no hash/nonce bookkeeping is needed. Google Fonts is the
 * only external style/font source, matching DESIGN.md's type stack.
 */
export function setSecurityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob:",
      "media-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self' https://www.sandbox.paypal.com",
      "frame-ancestors 'none'",
    ].join('; '),
  );
}

/** Browser-originated API requests must come from this app's own host. */
export function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

export function getCookie(request, name) {
  const found = String(request.headers.cookie || '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : '';
}

/** The session cookie: HttpOnly, SameSite=Strict, 8h, Secure on https origins. */
export function sessionCookie(appBaseUrl, token, clear = false) {
  const secure = appBaseUrl.startsWith('https://') ? '; Secure' : '';
  return `sc_session=${clear ? '' : token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${clear ? 0 : 28800}${secure}`;
}

/**
 * The transparent device cookie that keeps the desk working when nobody is
 * signed in. Long-lived; HttpOnly so page scripts can't touch it.
 */
export function deviceCookie(appBaseUrl, id, clear = false) {
  const secure = appBaseUrl.startsWith('https://') ? '; Secure' : '';
  return `sc_device=${clear ? '' : encodeURIComponent(id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${clear ? 0 : 400 * 86_400}${secure}`;
}

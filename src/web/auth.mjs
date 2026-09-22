// Access control of the web editor.
//
// From stage 3 on the editor can restart the daemon, read the journal and show
// the VLESS keys, so a copy of it reachable from the network is a different tool
// from one reachable only from the machine itself. The rule is deliberately
// blunt: an address that is not the loopback REQUIRES a token, and the server
// refuses to start otherwise (`assertAuthentication`).
//
// This module is separate from `server.mjs` on purpose: `server.mjs` imports
// `app.mjs`, so a shared constant living there would make the two modules
// circular. The names of the variable and of the cookie are here, both modules
// import them, and there is exactly one place that knows what a valid request
// looks like.
//
// Two transports exist, and both are needed:
//   * `Authorization: Bearer <token>` — what a script or curl uses;
//   * `?token=<token>` — what the `EventSource` of the SSE panels can use, since
//     the browser gives an `EventSource` no way to set a header.
// The query form is answered with an HttpOnly `SameSite=Strict` cookie, after
// which the `EventSource` authenticates by itself and the token stays out of the
// HTML. Sending a secret in a query string is not ideal — it lands in the access
// log — which is another reason the README still recommends a loopback bind plus
// an ssh tunnel.

import {timingSafeEqual} from 'node:crypto';

/** Environment variable that carries the access token. */
export const TOKEN_VAR = 'GATEHOUSE_TOKEN';

/** Cookie that carries the token to the SSE endpoints. */
export const TOKEN_COOKIE = 'gatehouse_token';

/**
 * True when an address is only reachable from the machine itself.
 *
 * `localhost`, `::1`, the `::ffff:127.0.0.1` form and any `127.x.y.z` count.
 * `0.0.0.0` deliberately does NOT: it is the whole LAN.
 *
 * @param {string} host
 * @returns {boolean}
 */
export function isLoopbackHost(host) {
  if (typeof host !== 'string' || host.length === 0) return false;
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (value === 'localhost' || value === '::1') return true;
  if (value.startsWith('::ffff:')) return isLoopbackHost(value.slice('::ffff:'.length));
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (ipv4 !== null) return ipv4[1] === '127';
  return false;
}

/**
 * Refuses a configuration that would put an unauthenticated editor on the
 * network. Called before anything is bound, so a mistake here cannot leave a
 * half-started listener behind.
 *
 * @param {string} host
 * @param {string} token
 * @throws {Error} With the reason and both ways out.
 */
export function assertAuthentication(host, token) {
  if (isLoopbackHost(host)) return;
  if (typeof token === 'string' && token.length > 0) return;
  throw new Error(
    `отказ запуска: GATEHOUSE_HOST=${host} — не адрес обратной петли, а ${TOKEN_VAR} пуст. ` +
      'Редактор умеет перезапускать sing-box и показывает ключи VLESS, поэтому выставлять его ' +
      `в сеть без токена нельзя. Либо задайте ${TOKEN_VAR}, либо привяжитесь к 127.0.0.1 и ` +
      'ходите через ssh-туннель.',
  );
}

/**
 * Compares two tokens without leaking their length or prefix through timing.
 *
 * @param {string} provided
 * @param {string} expected
 * @returns {boolean}
 */
export function tokenMatches(provided, expected) {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  if (typeof expected !== 'string' || expected.length === 0) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // `timingSafeEqual` throws on different lengths, so the length is compared
  // first; the length of a token is not the secret, its bytes are.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Reads one cookie out of a `Cookie:` header without pulling in `cookie-parser`:
 * one header, one name, one value.
 *
 * @param {string|undefined} header
 * @param {string} name
 * @returns {string|null}
 */
export function readCookie(header, name) {
  if (typeof header !== 'string' || header.length === 0) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

/**
 * Extracts the token of a request from any of the accepted transports.
 *
 * @param {import('express').Request} req
 * @returns {string|null}
 */
export function extractToken(req) {
  const header = req.get('authorization');
  if (typeof header === 'string') {
    const bearer = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (bearer !== null && bearer[1].trim().length > 0) return bearer[1].trim();
  }
  if (typeof req.query?.token === 'string' && req.query.token.length > 0) return req.query.token;
  return readCookie(req.get('cookie'), TOKEN_COOKIE);
}

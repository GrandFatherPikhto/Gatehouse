// Clash-compatible HTTP API client of the sing-box daemon.
//
// Why HTTP and not `sing-box api`: the CLI prints a table and cannot emit JSON,
// so parsing it would be fragile. The HTTP API of the same feature returns JSON
// (`GET /connections`) and accepts `DELETE /connections/<id>`, and the built-in
// `fetch` is enough — no subprocess for the API side of the watchdog.
//
// The exact field names of a connection differ between Clash versions and sing-box
// builds (`metadata.inboundTag`, `metadata.inboundName`, `metadata.inboundPort`).
// `connectionInbound` therefore reads ALL of the plausible spellings instead of
// betting on one, and the owner's spike (techdocs) pins the real shape down.
//
// No side effect lives here except the two calls themselves: this module neither
// reads nor writes `webui.json` or `config.json`.

import {SystemError} from '../system/index.mjs';

/** How long one API request may take. The API is on loopback, so it is instant. */
export const DEFAULT_API_TIMEOUT = 5000;

/**
 * Normalises a controller value into an absolute URL without a trailing slash.
 *
 * @param {string} controller `127.0.0.1:9090` or a full `http://…` URL.
 * @returns {string}
 */
export function apiBase(controller) {
  const text = String(controller ?? '').trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(text)) return text;
  return `http://${text}`;
}

/**
 * Reads the inbound identity of a connection, whichever spelling it uses.
 *
 * @param {Record<string, unknown>} connection
 * @returns {{tag: string|null, port: number|null}}
 */
export function connectionInbound(connection) {
  const metadata = typeof connection?.metadata === 'object' && connection.metadata !== null
    ? connection.metadata
    : {};
  const tag =
    metadata.inboundTag ?? metadata.inboundName ?? metadata.inbound ?? connection?.inbound ?? null;
  const rawPort = metadata.inboundPort ?? connection?.inboundPort ?? null;
  const port = Number(rawPort);

  return {
    tag: typeof tag === 'string' && tag.length > 0 ? tag : null,
    port: Number.isFinite(port) && port > 0 ? port : null,
  };
}

/**
 * True when a connection belongs to the inbound of `proxy`.
 *
 * The tag is the primary key; the port is the fallback for a build that reports
 * only the listening port. Both are compared, so a connection is closed only when
 * it really belongs to this proxy — never "all of them by mistake".
 *
 * @param {Record<string, unknown>} connection
 * @param {{tag?: string|null, port?: number|null}} proxy
 * @returns {boolean}
 */
export function connectionMatches(connection, proxy) {
  const inbound = connectionInbound(connection);
  const tag = typeof proxy.tag === 'string' && proxy.tag.length > 0 ? proxy.tag : null;
  const port = Number(proxy.port);

  if (tag !== null && inbound.tag !== null && inbound.tag === tag) return true;
  if (Number.isFinite(port) && port > 0 && inbound.port !== null && inbound.port === port) return true;
  return false;
}

/**
 * Builds the request headers, including the bearer token the API expects.
 *
 * @param {string} secret
 * @returns {Record<string, string>}
 */
function authHeaders(secret) {
  const headers = {Accept: 'application/json'};
  if (typeof secret === 'string' && secret.length > 0) headers.Authorization = `Bearer ${secret}`;
  return headers;
}

/**
 * Runs one request and turns a transport error into a `SystemError`, so a caller
 * never has to deal with the many shapes `fetch` can fail with.
 *
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {{method: string, headers: Record<string, string>, timeout?: number,
 *   signal?: AbortSignal}} options
 * @returns {Promise<Response>}
 */
async function request(fetchImpl, url, options) {
  const signal =
    options.signal ??
    (Number.isFinite(options.timeout) && options.timeout > 0
      ? AbortSignal.timeout(options.timeout)
      : undefined);

  let response;
  try {
    response = await fetchImpl(url, {method: options.method, headers: options.headers, signal});
  } catch (error) {
    throw new SystemError(`HTTP-API sing-box недоступен (${url}): ${error.message}`);
  }
  return response;
}

/**
 * Lists the live connections of the daemon.
 *
 * @param {string} controller
 * @param {string} secret
 * @param {{fetchImpl?: typeof fetch, timeout?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function listConnections(controller, secret, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await request(fetchImpl, `${apiBase(controller)}/connections`, {
    method: 'GET',
    headers: authHeaders(secret),
    timeout: options.timeout ?? DEFAULT_API_TIMEOUT,
    signal: options.signal,
  });

  if (!response.ok) {
    throw new SystemError(
      `HTTP-API sing-box ответил ${response.status} на GET /connections ` +
        '(проверьте секрет и адрес внешнего контроллера)',
    );
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw new SystemError(`HTTP-API sing-box вернул не JSON: ${error.message}`);
  }

  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.connections)) return data.connections;
  return [];
}

/**
 * Closes one connection by id.
 *
 * @param {string} controller
 * @param {string} secret
 * @param {string} id
 * @param {{fetchImpl?: typeof fetch, timeout?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<boolean>} True when the daemon accepted the close.
 */
export async function closeConnection(controller, secret, id, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${apiBase(controller)}/connections/${encodeURIComponent(String(id))}`;
  const response = await request(fetchImpl, url, {
    method: 'DELETE',
    headers: authHeaders(secret),
    timeout: options.timeout ?? DEFAULT_API_TIMEOUT,
    signal: options.signal,
  });
  return response.ok || response.status === 204;
}

/**
 * Closes every connection of ONE proxy's inbound, and nothing else.
 *
 * @param {string} controller
 * @param {string} secret
 * @param {{tag?: string|null, port?: number|null}} proxy
 * @param {{fetchImpl?: typeof fetch, timeout?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<{closed: number, matched: number, total: number, ids: string[]}>}
 */
export async function closeInboundConnections(controller, secret, proxy, options = {}) {
  const connections = await listConnections(controller, secret, options);
  const chosen = connections.filter((connection) => connectionMatches(connection, proxy));

  const ids = [];
  for (const connection of chosen) {
    const id = connection?.id ?? connection?.ID ?? null;
    if (id === null || id === undefined) continue;
    const closed = await closeConnection(controller, secret, id, options);
    if (closed) ids.push(String(id));
  }

  return {closed: ids.length, matched: chosen.length, total: connections.length, ids};
}

export {SystemError};

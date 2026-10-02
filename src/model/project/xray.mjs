// Xray ports of the document: who holds which port, handing out a new one, and
// forgetting a server that is gone.
//
// The ports are the ONE mutable part of the Xray picture. Everything else (what
// servers exist, what their outbound is) is read from the provider folder every
// time (§1). A port is handed to a server ONCE and stored in `webui.json` under
// `xray.ports`, keyed by `<provider>/<server name without suffix>`, so changing
// the owner's suffix never moves a port to another server (§2).
//
// Every function takes the model as its first argument, like the other topic
// modules. Nothing here touches the host: it is pure document work, so the model
// stays testable without a router.

import {ConfigError, isMapping} from '../../core/errors.mjs';
import {DEFAULT_XRAY_PORT_RANGE, resolveXrayPorts, xrayPortRange} from '../../core/xray.mjs';
import {providersInfo} from './providers.mjs';

/** Top-level `xray` block as a plain object, or `{}`. */
export function xrayBlock(model) {
  const value = model.document.xray;
  return isMapping(value) ? value : {};
}

/**
 * Servers of every ENABLED provider of kind `xray`, with their `key` already set
 * by the reader. Disabled providers contribute nothing.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @returns {Array<Record<string, unknown>>}
 */
export function enabledXrayServers(model) {
  const info = providersInfo(model);
  const servers = [];
  for (const provider of info.providers) {
    if (provider.enabled !== true) continue;
    // A kind-«xray» folder (full client configs) AND a subscription whose engine
    // sends some or all of its servers through Xray both carry `xrayServers`
    // (task 22 §2): one port pool, one collision check.
    if (provider.kind !== 'xray' && provider.kind !== 'subscription') continue;
    for (const server of provider.xrayServers ?? []) servers.push(server);
  }
  return servers;
}

/** Ports of the sing-box proxies, which an Xray port must never take. */
function reservedPorts(model) {
  return (Array.isArray(model.document.proxies) ? model.document.proxies : [])
    .filter((proxy) => isMapping(proxy))
    .map((proxy) => Number(proxy.port))
    .filter((port) => Number.isInteger(port));
}

/** Stored `xray.ports` as a plain object. */
export function storedXrayPorts(model) {
  const value = xrayBlock(model).ports;
  return isMapping(value) ? value : {};
}

/**
 * View of the ports for the «Настройки → Xray» panel and the apply bar:
 * `rows` has one entry per ENABLED server (its port, and whether it is stored or
 * only computed) plus one per stored port whose server is GONE (`missing`).
 *
 * `resolveXrayPorts` is the same pure function the build uses, so the panel shows
 * the very ports that would reach `config.json`. When the range is exhausted the
 * refusal is returned in `error`, not thrown: a panel must render.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @returns {{range: [number, number], rows: Array<Record<string, unknown>>,
 *   assigned: Record<string, number>, error: string|null, servers: number}}
 */
export function xrayPortInfo(model) {
  const block = xrayBlock(model);
  const stored = storedXrayPorts(model);
  const range = xrayPortRange(block.port_range);
  const servers = enabledXrayServers(model);
  const present = new Set(servers.map((server) => String(server.key)));

  let resolved;
  let error = null;
  try {
    resolved = resolveXrayPorts(servers, block, reservedPorts(model));
  } catch (caught) {
    if (!(caught instanceof ConfigError)) throw caught;
    resolved = {range, ports: {}, assigned: {}};
    error = caught.message;
  }

  const rows = servers.map((server) => ({
    key: server.key,
    provider: String(server.provider ?? String(server.key).split('/')[0]),
    name: server.name,
    port: resolved.ports[server.key] ?? null,
    stored: Number.isInteger(Number(stored[server.key])),
    missing: false,
  }));

  for (const [key, value] of Object.entries(stored)) {
    if (present.has(key)) continue;
    const port = Number(value);
    if (!Number.isInteger(port)) continue;
    const slash = key.indexOf('/');
    rows.push({
      key,
      provider: slash >= 0 ? key.slice(0, slash) : key,
      name: slash >= 0 ? key.slice(slash + 1) : key,
      port,
      stored: true,
      missing: true,
    });
  }

  rows.sort((a, b) => (a.port ?? 0) - (b.port ?? 0));
  return {range, rows, assigned: resolved.assigned, error, servers: servers.length};
}

/**
 * Persists the ports of every enabled Xray server, marking the document dirty.
 *
 * This runs BEFORE a save in the apply chain (§2): handing out a port IS a change
 * of the document, and the ports it wrote are the ones the build then uses, so
 * the file and the generated configs cannot disagree. Idempotent: nothing is
 * written when every server already has its port.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @returns {{assigned: Record<string, number>, changed: boolean}}
 */
export function ensureXrayPorts(model) {
  const block = xrayBlock(model);
  const servers = enabledXrayServers(model);
  const resolved = resolveXrayPorts(servers, block, reservedPorts(model));
  const keys = Object.keys(resolved.assigned);
  if (keys.length === 0) return {assigned: {}, changed: false};

  const ports = {...storedXrayPorts(model)};
  for (const key of keys) ports[key] = resolved.assigned[key];
  model.document.xray = {...block, ports};
  model.markDirty();
  return {assigned: resolved.assigned, changed: true};
}

/**
 * Changes the port range of the Xray front end. Refused when an ALREADY handed
 * port equals a sing-box proxy port: the two would collide once Xray listens
 * (§2). The range itself must be positive integers with `from <= to`.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {unknown} from
 * @param {unknown} to
 * @returns {Record<string, unknown>} The stored `xray` block.
 */
export function setXrayPortRange(model, from, to) {
  const low = Number(from);
  const high = Number(to);
  if (!Number.isInteger(low) || !Number.isInteger(high) || low < 1 || high > 65535) {
    throw new ConfigError('диапазон портов Xray: два целых числа от 1 до 65535');
  }
  if (low > high) throw new ConfigError('диапазон портов Xray: начало больше конца');

  const block = xrayBlock(model);
  const proxyPorts = new Set(reservedPorts(model));
  for (const [key, value] of Object.entries(storedXrayPorts(model))) {
    const port = Number(value);
    if (Number.isInteger(port) && proxyPorts.has(port)) {
      throw new ConfigError(
        `порт Xray ${port} (${key}) совпал с портом прокси sing-box: смените диапазон или порт прокси`,
      );
    }
  }

  model.document.xray = {...block, port_range: [low, high]};
  model.markDirty();
  return model.document.xray;
}

/**
 * Forgets the port of a server that is GONE, so the number becomes free for a
 * new server. A server that is present may NOT be forgotten: its port has to
 * leave with the server, not from under it (§2).
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {string} key `<provider>/<name without suffix>`.
 * @returns {boolean}
 */
export function forgetXrayPort(model, key) {
  const clean = String(key ?? '').trim();
  const stored = {...storedXrayPorts(model)};
  if (!Object.hasOwn(stored, clean)) {
    throw new ConfigError(`порт для '${clean}' не выдан`);
  }
  const present = new Set(enabledXrayServers(model).map((server) => String(server.key)));
  if (present.has(clean)) {
    throw new ConfigError(
      `сервер '${clean}' на месте: освободить порт можно только у пропавшего сервера`,
    );
  }

  delete stored[clean];
  const block = {...xrayBlock(model)};
  if (Object.keys(stored).length === 0) delete block.ports;
  else block.ports = stored;
  if (Object.keys(block).length === 0) delete model.document.xray;
  else model.document.xray = block;
  model.markDirty();
  return true;
}

export {DEFAULT_XRAY_PORT_RANGE};

// Xray as a second engine behind sing-box: reading the provider's own client
// configs and building the local socks front end.
//
// WHY THIS MODULE EXISTS (task plan_2026_10_02_gatehouse_xray_core.md §0):
// StashVPN (Remnawave) hands its XHTTP servers out ONLY as full Xray client
// configs (`xray-configs.json`) — the `vless://` links point at `balancer.*`
// stubs, and XHTTP carries fine obfuscation (`xpaddingObfsMode`, `sessionIDTable`,
// `xmux`, …) that a link round-trip would destroy. So the outbound object is
// copied VERBATIM, only its `tag` is replaced at build time.
//
// Roles (§11.2): Xray listens only on `127.0.0.1`, one socks port per server;
// sing-box sees each port as an ordinary `socks` outbound with the server's name,
// so pools, urltest, routes and the missing-server mark work unchanged.
//
// Nothing here touches the host or the document: pure functions on plain JSON.

import fs from 'node:fs';

import {ConfigError, isMapping} from './errors.mjs';

/** File a provider folder of kind `xray` carries its client configs in. */
export const XRAY_CONFIGS_FILENAME = 'xray-configs.json';

/** Default socks port range the Xray front end hands out (`xray.port_range`). */
export const DEFAULT_XRAY_PORT_RANGE = Object.freeze([20800, 20999]);

/** The only address Xray ever listens on: it is an internal engine (§11.2). */
export const XRAY_LISTEN = '127.0.0.1';

/**
 * Outbound protocols that carry traffic to a server and therefore become a
 * server of ours. `hysteria` here is Hysteria2 (`settings.version === 2`).
 */
export const XRAY_SERVER_PROTOCOLS = Object.freeze([
  'vless',
  'vmess',
  'trojan',
  'shadowsocks',
  'hysteria',
]);

/** Outbound protocols that are service plumbing: skipped silently. */
export const XRAY_SERVICE_PROTOCOLS = Object.freeze(['freedom', 'blackhole', 'dns', 'loopback']);

const SERVER_PROTOCOLS = new Set(XRAY_SERVER_PROTOCOLS);
const SERVICE_PROTOCOLS = new Set(XRAY_SERVICE_PROTOCOLS);

/**
 * Canonical JSON with sorted object keys, used to compare two outbounds while
 * ignoring their `tag` (§1.2). A plain `JSON.stringify` depends on key insertion
 * order, and the same server reached through two configs may list its keys in a
 * different order.
 *
 * @param {unknown} value
 * @returns {string}
 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The address of an outbound, from the three shapes the providers use.
 *
 * @param {Record<string, unknown>} outbound
 * @returns {string}
 */
function outboundAddress(outbound) {
  const settings = isMapping(outbound.settings) ? outbound.settings : {};
  if (Array.isArray(settings.vnext) && isMapping(settings.vnext[0])) {
    const address = settings.vnext[0].address;
    if (typeof address === 'string') return address;
  }
  if (Array.isArray(settings.servers) && isMapping(settings.servers[0])) {
    const address = settings.servers[0].address;
    if (typeof address === 'string') return address;
  }
  if (typeof settings.address === 'string') return settings.address;
  return '';
}

/**
 * The remote port of an outbound, for the server table only.
 *
 * @param {Record<string, unknown>} outbound
 * @returns {number|null}
 */
function outboundPort(outbound) {
  const settings = isMapping(outbound.settings) ? outbound.settings : {};
  const candidate = Array.isArray(settings.vnext)
    ? settings.vnext[0]?.port
    : Array.isArray(settings.servers)
      ? settings.servers[0]?.port
      : settings.port;
  const port = Number(candidate);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/** The first dot-separated label of a host, e.g. `de2` of `de2.stashvpn.ru`. */
function hostLabel(address) {
  const text = String(address ?? '').trim();
  if (text.length === 0) return '';
  return text.split('.')[0];
}

/**
 * Human protocol label for the «протокол» column (§1.4):
 * `VLESS XHTTP · TLS`, `VLESS XHTTP · Reality`, `VLESS WS · TLS`,
 * `VMess WS · TLS`, `Hysteria2`, …
 *
 * @param {Record<string, unknown>} outbound
 * @returns {string}
 */
export function xrayProtocolLabel(outbound) {
  const protocol = String(outbound.protocol ?? '').toLowerCase();
  const stream = isMapping(outbound.streamSettings) ? outbound.streamSettings : {};
  const network = typeof stream.network === 'string' ? stream.network.toLowerCase() : '';
  const security = typeof stream.security === 'string' ? stream.security.toLowerCase() : '';

  if (protocol === 'hysteria') {
    const settings = isMapping(outbound.settings) ? outbound.settings : {};
    const hs = isMapping(stream.hysteriaSettings) ? stream.hysteriaSettings : {};
    const version = Number(settings.version ?? hs.version);
    return version === 2 ? 'Hysteria2' : 'Hysteria';
  }

  const name =
    protocol === 'vless' ? 'VLESS' : protocol === 'vmess' ? 'VMess' : protocol === 'trojan'
      ? 'Trojan' : protocol === 'shadowsocks' ? 'Shadowsocks' : protocol.toUpperCase();

  if (protocol === 'shadowsocks') return name;

  const parts = [name];
  if (network.length > 0) parts.push(network.toUpperCase());
  let label = parts.join(' ');
  if (security.length > 0) {
    const word = security === 'reality' ? 'Reality' : security.toUpperCase();
    label += ` · ${word}`;
  }
  return label;
}

/**
 * Reads and parses one `xray-configs.json`.
 *
 * Accepts the array Remnawave/Happ hands out AND a single hand-written config.
 * Every outbound that carries traffic becomes a server descriptor; service
 * outbounds are skipped silently; an unsupported protocol and a chained outbound
 * (`proxySettings` / `sockopt.dialerProxy`) are reported in `skipped`.
 *
 * Duplicates (everything but `tag`, compared canonically) collapse into one.
 * Two servers that differ but share a base name get ` 2`, ` 3` in file order
 * (§1.2, §1.3).
 *
 * @param {string} filePath
 * @param {string[]} [warnings] Global collector, for the generator.
 * @param {Array<{label: string, reason: string}>} [skipped] Per-provider skips.
 * @returns {{servers: Array<Record<string, unknown>>, state: string,
 *   error: string|null, meta: {configs: number, outbounds: number, servers: number}}}
 */
export function readXrayConfigs(filePath, warnings = [], skipped = []) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return {
      servers: [],
      state: 'unreadable',
      error: `файл ${XRAY_CONFIGS_FILENAME} недоступен для чтения: ${error.message}`,
      meta: {configs: 0, outbounds: 0, servers: 0},
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      servers: [],
      state: 'unreadable',
      error: `файл не читается: ${error.message}`,
      meta: {configs: 0, outbounds: 0, servers: 0},
    };
  }

  let configs;
  if (Array.isArray(parsed)) {
    configs = parsed;
  } else if (isMapping(parsed)) {
    configs = [parsed];
  } else {
    return {
      servers: [],
      state: 'unreadable',
      error: `файл не читается: ожидается массив конфигов или один объект`,
      meta: {configs: 0, outbounds: 0, servers: 0},
    };
  }

  const /** @type {Array<Record<string, unknown>>} */ servers = [];
  const seen = new Set();
  const nameCounts = new Map();
  let outboundCount = 0;
  let configCount = 0;

  for (const config of configs) {
    if (!isMapping(config)) continue;
    configCount += 1;
    const outbounds = Array.isArray(config.outbounds) ? config.outbounds : [];
    const remark = typeof config.remarks === 'string' ? config.remarks : null;

    for (const outbound of outbounds) {
      if (!isMapping(outbound)) continue;
      const protocol = String(outbound.protocol ?? '').toLowerCase();
      const tag = String(outbound.tag ?? '').trim();

      if (SERVICE_PROTOCOLS.has(protocol)) continue;
      if (!SERVER_PROTOCOLS.has(protocol)) {
        skipped.push({
          label: tag.length > 0 ? tag : protocol,
          reason: `протокол ${protocol || '—'} не поддерживается`,
        });
        continue;
      }
      outboundCount += 1;

      const stream = isMapping(outbound.streamSettings) ? outbound.streamSettings : {};
      const sockopt = isMapping(stream.sockopt) ? stream.sockopt : {};
      if (isMapping(outbound.proxySettings) || typeof sockopt.dialerProxy === 'string') {
        skipped.push({
          label: tag.length > 0 ? tag : protocol,
          reason: 'цепочки выходов пока не поддерживаются',
        });
        continue;
      }

      // Duplicates: everything but `tag` is compared canonically (§1.2).
      const fingerprintSource = {...outbound};
      delete fingerprintSource.tag;
      const fingerprint = canonical(fingerprintSource);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);

      const address = outboundAddress(outbound);
      const label = hostLabel(address);
      const baseName = label.length > 0 ? `${tag} (${label})` : tag.length > 0 ? tag : protocol;
      const seenBefore = nameCounts.get(baseName) ?? 0;
      nameCounts.set(baseName, seenBefore + 1);
      const name = seenBefore === 0 ? baseName : `${baseName} ${seenBefore + 1}`;

      servers.push({
        tag,
        hostLabel: label,
        baseName,
        name,
        key: '',
        protocol: xrayProtocolLabel(outbound),
        address,
        remotePort: outboundPort(outbound),
        remark,
        outbound: {...outbound},
      });
    }
  }

  return {
    servers,
    state: servers.length > 0 ? 'ok' : 'empty',
    error: null,
    meta: {configs: configCount, outbounds: outboundCount, servers: servers.length},
  };
}

/**
 * The sing-box `socks` outbound of one Xray server (§3.2). The tag is the server
 * name, so pools, `auto-select` and routes treat it like any other server.
 *
 * @param {Record<string, unknown>} server
 * @param {number} port
 * @returns {Record<string, unknown>}
 */
export function xraySocksOutbound(server, port) {
  return {
    type: 'socks',
    tag: String(server.name),
    server: XRAY_LISTEN,
    server_port: Number(port),
    version: '5',
  };
}

/**
 * Pairs each server with its assigned port, sorted by port, for the Xray build.
 *
 * @param {Array<Record<string, unknown>>} servers
 * @param {Record<string, number>} ports
 * @returns {Array<{port: number, server: Record<string, unknown>, outbound: Record<string, unknown>}>}
 */
export function xrayEntries(servers, ports) {
  return servers
    .filter((server) => Number.isInteger(ports[server.key]))
    .map((server) => ({port: ports[server.key], server, outbound: server.outbound}))
    .sort((a, b) => a.port - b.port);
}

/**
 * Normalises `xray.port_range`: `[from, to]` with positive integers and
 * `from <= to`, otherwise the build default. A hand-edited bad value is read as
 * the default instead of breaking generation.
 *
 * @param {unknown} value
 * @returns {[number, number]}
 */
export function xrayPortRange(value) {
  if (Array.isArray(value) && value.length === 2) {
    const from = Number(value[0]);
    const to = Number(value[1]);
    if (Number.isInteger(from) && Number.isInteger(to) && from >= 1 && to <= 65535 && from <= to) {
      return [from, to];
    }
  }
  return [DEFAULT_XRAY_PORT_RANGE[0], DEFAULT_XRAY_PORT_RANGE[1]];
}

/**
 * Hands a stable port to every server (§2), purely and deterministically.
 *
 * A stored port is kept even for a server that is GONE: the port belongs to the
 * server, and a returning server must come back on the same number. New servers
 * take the SMALLEST free port of the range, never a stored one and never one of
 * `reservedPorts` (the sing-box proxy ports). An exhausted range refuses.
 *
 * @param {Array<Record<string, unknown>>} servers
 * @param {unknown} xrayBlock `settings.xray`.
 * @param {number[]} [reservedPorts]
 * @returns {{range: [number, number], ports: Record<string, number>,
 *   assigned: Record<string, number>, released: string[]}} `ports` covers the
 *   servers given; `assigned` only the freshly handed ones.
 */
export function resolveXrayPorts(servers, xrayBlock, reservedPorts = []) {
  const block = isMapping(xrayBlock) ? xrayBlock : {};
  const range = xrayPortRange(block.port_range);
  const stored = isMapping(block.ports) ? block.ports : {};
  const reserved = new Set(
    reservedPorts.map((port) => Number(port)).filter((port) => Number.isInteger(port)),
  );

  const used = new Set();
  for (const value of Object.values(stored)) {
    const port = Number(value);
    if (Number.isInteger(port)) used.add(port);
  }

  const ports = {};
  const assigned = {};
  for (const server of servers) {
    const key = String(server.key);
    const existing = Number(stored[key]);
    if (Number.isInteger(existing)) {
      ports[key] = existing;
      continue;
    }

    let candidate = range[0];
    while (used.has(candidate) || reserved.has(candidate)) candidate += 1;
    if (candidate > range[1]) {
      throw new ConfigError(
        `диапазон портов Xray ${range[0]}..${range[1]} исчерпан: не хватает порта для '${server.name}'`,
      );
    }
    used.add(candidate);
    ports[key] = candidate;
    assigned[key] = candidate;
  }

  return {range, ports, assigned, released: []};
}

/**
 * Wraps one outbound for the generated Xray config: a copy with the ASCII,
 * port-stable tag `out-<port>` (§3.1). The object is otherwise untouched — by
 * reference it is a deep clone, so the build never mutates the provider data.
 *
 * @param {Record<string, unknown>} outbound
 * @param {number} port
 * @returns {Record<string, unknown>}
 */
function taggedOutbound(outbound, port) {
  const copy = structuredClone(outbound);
  copy.tag = `out-${port}`;
  return copy;
}

/**
 * Builds the whole Xray configuration (§3.1):
 *
 *   * listeners ONLY on `127.0.0.1`, one socks inbound per port, tag `in-<port>`;
 *   * `blackhole` FIRST, so anything not matched goes nowhere (Xray's first
 *     outbound is the default one);
 *   * one routing rule `in-<port> -> out-<port>` per server;
 *   * deterministic: sorted by port, so the same input gives the same bytes.
 *
 * @param {Array<{port: number, outbound: Record<string, unknown>}>} entries
 * @returns {Record<string, unknown>}
 */
export function buildXrayConfig(entries) {
  const ordered = [...entries].sort((a, b) => a.port - b.port);
  const inbounds = ordered.map((entry) => ({
    tag: `in-${entry.port}`,
    protocol: 'socks',
    listen: XRAY_LISTEN,
    port: entry.port,
    settings: {udp: true},
  }));
  const outbounds = [
    {tag: 'block', protocol: 'blackhole'},
    ...ordered.map((entry) => taggedOutbound(entry.outbound, entry.port)),
  ];
  const rules = ordered.map((entry) => ({
    inboundTag: [`in-${entry.port}`],
    outboundTag: `out-${entry.port}`,
  }));

  return {
    log: {loglevel: 'warning'},
    inbounds,
    outbounds,
    routing: {rules},
  };
}

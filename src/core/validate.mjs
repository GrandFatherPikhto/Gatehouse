// Validation and normalisation of the settings section.
//
// Port of `as_list`, `require_mapping`, `validate_proxies`, `urltest_block` and
// `validate_exclude` from
// /home/yevstigneyevda/Projects/Python/SingBoxTools/sing_box_manager.py

import {
  ConfigError,
  PROXY_TYPES,
  isMapping,
  pythonRepr,
  pythonTypeName,
  pyTruthy,
} from './errors.mjs';

/**
 * Normalises a value into a list: null stays empty, a list is returned as is,
 * anything else becomes a single-element list.
 * Reference: `as_list`.
 *
 * @param {unknown} value
 * @returns {unknown[]}
 */
export function asList(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Requires a mapping (`dict`) and reports the actual type otherwise.
 * Reference: `require_mapping`.
 *
 * @param {unknown} value
 * @param {string} where
 */
export function requireMapping(value, where) {
  if (!isMapping(value)) {
    throw new ConfigError(`${where}: ожидается mapping, получено ${pythonTypeName(value)}`);
  }
}

/**
 * Validates and normalises the `proxies` section.
 *
 * The JSON schema cannot see duplicate tags or ports, so this stays the only
 * place that catches them. Returns a fresh list of normalised proxies.
 * Reference: `validate_proxies`.
 *
 * @param {unknown} proxies
 * @returns {Array<{tag: string, type: string, port: number, servers: string[]}>}
 */
export function validateProxies(proxies) {
  // pyTruthy, not `!proxies`: an empty list or dict is falsy in Python, so the
  // reference rejects `proxies: []` with this very message while `![]` in JS
  // would let it through.
  if (!pyTruthy(proxies)) {
    throw new ConfigError('в настройках отсутствует секция proxies (нужен хотя бы один прокси)');
  }

  // The reference iterated whatever `proxies` was: a list of dicts normally, but
  // a dict or a string would be iterated into keys/characters and fail the
  // mapping check below. Only the first case is meaningful; the rest reach the
  // same ConfigError.
  const items = Array.isArray(proxies)
    ? proxies
    : isMapping(proxies)
      ? Object.keys(proxies)
      : [proxies];

  const result = [];
  const seenTags = new Set();
  const seenPorts = new Set();

  items.forEach((proxy, index) => {
    const where = `proxies[${index}]`;
    requireMapping(proxy, where);

    const tag = proxy.tag;
    const proxyType = proxy.type;
    const port = proxy.port;

    if (typeof tag !== 'string' || tag.length === 0) {
      throw new ConfigError(`${where}: не указан тег (tag) или это не строка`);
    }
    if (!PROXY_TYPES.includes(proxyType)) {
      throw new ConfigError(
        `${where} '${tag}': неизвестный тип '${pythonRepr(proxyType).replace(/^'|'$/g, '')}' ` +
          `(ожидается ${PROXY_TYPES.join('|')})`,
      );
    }
    if (typeof port === 'boolean' || !Number.isInteger(port)) {
      throw new ConfigError(
        `${where} '${tag}': port должен быть целым числом, получено ${pythonRepr(port)}`,
      );
    }
    if (!(port > 0 && port < 65536)) {
      throw new ConfigError(`${where} '${tag}': порт ${port} вне диапазона 1..65535`);
    }
    if (seenTags.has(tag)) {
      throw new ConfigError(`дубль тега инбаунда: ${tag}`);
    }
    if (seenPorts.has(port)) {
      throw new ConfigError(`дубль порта инбаунда: ${port}`);
    }

    seenTags.add(tag);
    seenPorts.add(port);

    let servers = proxy.servers;
    if (servers === null || servers === undefined) {
      servers = [];
    } else if (typeof servers === 'string') {
      servers = [servers];
    } else if (
      !Array.isArray(servers) ||
      !servers.every((server) => typeof server === 'string' && server.length > 0)
    ) {
      throw new ConfigError(`${where} '${tag}': servers должен быть списком непустых строк`);
    }

    const tunnel = normalizeTunnelDescriptor(proxy.tunnel, where, tag);
    if (tunnel !== null && servers.length > 0) {
      throw new ConfigError(
        `${where} '${tag}': у туннельного прокси не может быть servers — ` +
          'один туннель, один выход (см. §5.1 задания)',
      );
    }

    // The `tunnel` key is added ONLY when present, so a proxy without it keeps the
    // exact shape of the reference and the golden `config.json` stays byte-identical.
    const entry = {tag, type: proxyType, port, servers: [...servers]};
    if (tunnel !== null) entry.tunnel = tunnel;
    result.push(entry);
  });

  return result;
}

/**
 * Validates the optional `tunnel` descriptor of a proxy and returns it in a fixed
 * shape, or `null` when the proxy is an ordinary one.
 *
 * A tunnel proxy owns no servers: its single exit is the interface itself, so
 * `validateProxies` refuses the combination above. The descriptor is the only
 * thing the core needs to emit the `direct`/`bind_interface` pair.
 *
 * @param {unknown} value
 * @param {string} where
 * @param {string} tag
 * @returns {{provider: string, file: string, interface: string}|null}
 */
function normalizeTunnelDescriptor(value, where, tag) {
  if (value === null || value === undefined) return null;
  requireMapping(value, `${where} '${tag}': tunnel`);

  const read = (key) => {
    const field = value[key];
    if (typeof field !== 'string' || field.trim().length === 0) {
      throw new ConfigError(`${where} '${tag}': tunnel.${key} должен быть непустой строкой`);
    }
    return field.trim();
  };

  const iface = read('interface');
  if (iface.length > 15) {
    throw new ConfigError(
      `${where} '${tag}': имя интерфейса '${iface}' длиннее 15 символов — ядро такое не примет`,
    );
  }

  return {provider: read('provider'), file: read('file'), interface: iface};
}

/**
 * True when one normalised proxy is a tunnel (owns a `direct` exit instead of a
 * server pool). Exported so the assembly reads the same predicate everywhere.
 *
 * @param {Record<string, unknown>} proxy
 * @returns {boolean}
 */
export function isTunnelProxy(proxy) {
  return isMapping(proxy) && isMapping(proxy.tunnel);
}

/**
 * Returns the urltest parameters with defaults and type checks.
 * Reference: `urltest_block` (defaults gstatic.com / 3m / 50).
 *
 * @param {unknown} urltestConfig
 * @returns {{url: string, interval: string, tolerance: number}}
 */
export function urltestBlock(urltestConfig) {
  const config = urltestConfig || {};
  requireMapping(config, 'urltest');

  const url = config.url === undefined ? 'https://gstatic.com' : config.url;
  const interval = config.interval === undefined ? '3m' : config.interval;
  const tolerance = config.tolerance === undefined ? 50 : config.tolerance;

  if (typeof url !== 'string' || url.length === 0) {
    throw new ConfigError(`urltest.url должен быть непустой строкой, получено ${pythonRepr(url)}`);
  }
  if (typeof interval !== 'string' || interval.length === 0) {
    throw new ConfigError(
      `urltest.interval должен быть непустой строкой, получено ${pythonRepr(interval)}`,
    );
  }
  if (typeof tolerance === 'boolean' || !Number.isInteger(tolerance)) {
    throw new ConfigError(
      `urltest.tolerance должен быть целым числом, получено ${pythonRepr(tolerance)}`,
    );
  }

  return {url, interval, tolerance};
}

/**
 * Checks the `exclude_from_auto` prefixes. Returns them unchanged, as the
 * reference did.
 * Reference: `validate_exclude`.
 *
 * @param {unknown[]} prefixes
 * @returns {unknown[]}
 */
export function validateExclude(prefixes) {
  if (!prefixes.every((prefix) => typeof prefix === 'string' && prefix.length > 0)) {
    throw new ConfigError('exclude_from_auto должен быть списком непустых строк');
  }
  return prefixes;
}

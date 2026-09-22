// Assembly of the sing-box configuration.
//
// Port of `build_inbounds`, `build_pools`, `build_rules` and `build_config`
// from /home/yevstigneyevda/Projects/Python/SingBoxTools/sing_box_manager.py
//
// Key order is part of the contract: the acceptance test compares the produced
// `config.json` byte by byte with the reference output, and JS keeps string key
// insertion order, so the order below must mirror the reference exactly.

import {ConfigError, DEFAULT_EXCLUDE, isMapping, pyTruthy} from './errors.mjs';
import {asList, requireMapping, urltestBlock, validateExclude, validateProxies} from './validate.mjs';

/**
 * Defaults of the external HTTP API of the daemon. The Editor is the first
 * deliberate divergence from the Python reference and the block below is its
 * whole surface: with `enabled` false nothing is emitted and `config.json` stays
 * byte-identical to the reference output.
 */
export const DEFAULT_CLASH_CONTROLLER = '127.0.0.1:9090';
/** Environment variable that carries the API secret. Never stored in webui.json. */
export const API_SECRET_VAR = 'GATEHOUSE_API_SECRET';
/** Hosts the loopback-only external_controller may use. */
const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1']);

/**
 * Builds the inbounds from validated proxies.
 *
 * `detour` is deliberately not set: in sing-box 1.14 an inbound `detour` chains
 * another inbound, it is not a default outbound. Inbounds are pinned to their
 * pools by route rules instead (see `buildRules`).
 * Reference: `build_inbounds`.
 *
 * @param {Array<{tag: string, type: string, port: number}>} proxies
 * @param {string} listenIp
 * @returns {[Array<Record<string, unknown>>, string[]]}
 */
export function buildInbounds(proxies, listenIp) {
  const inbounds = [];
  const inboundTags = [];
  for (const proxy of proxies) {
    inbounds.push({
      type: proxy.type,
      tag: proxy.tag,
      listen: listenIp,
      listen_port: proxy.port,
    });
    inboundTags.push(proxy.tag);
  }
  return [inbounds, inboundTags];
}

/**
 * Builds one `pool-<tag>` urltest outbound per proxy that lists its own servers.
 * Reference: `build_pools`.
 *
 * @param {Array<{tag: string, servers: string[]}>} proxies
 * @param {string[]} allTags
 * @param {unknown} urltestConfig
 * @returns {Array<Record<string, unknown>>}
 */
export function buildPools(proxies, allTags, urltestConfig) {
  const pools = [];
  for (const proxy of proxies) {
    const servers = proxy.servers;
    if (!servers || servers.length === 0) continue;

    const missing = servers.filter((server) => !allTags.includes(server));
    if (missing.length > 0) {
      throw new ConfigError(
        `прокси '${proxy.tag}' ссылается на несуществующие серверы: ${missing.join(', ')}\n` +
          `Доступные серверы: ${allTags.join(', ') || '(нет)'}`,
      );
    }

    const pool = {
      type: 'urltest',
      tag: `pool-${proxy.tag}`,
      outbounds: [...servers],
    };
    Object.assign(pool, urltestBlock(urltestConfig));
    pools.push(pool);
  }
  return pools;
}

/**
 * Builds `route.rules`. The order carries meaning:
 *   1. hijack-dns — DNS is intercepted;
 *   2. sniff over all inbounds — not a final action, so outbound selection continues;
 *   3. one rule per proxy with its own servers, pinning the inbound to `pool-<tag>`;
 *   4. domain rules from the `routes` section, laid on top.
 * Reference: `build_rules`.
 *
 * @param {Array<{tag: string, servers: string[]}>} proxies
 * @param {Record<string, {outbound?: string, domains?: unknown}>|null} routes
 * @param {Set<string>} knownOutbounds
 * @param {string[]} [warnings]
 * @returns {Array<Record<string, unknown>>}
 */
export function buildRules(proxies, routes, knownOutbounds, warnings = []) {
  const rules = [
    {protocol: 'dns', action: 'hijack-dns'},
    {inbound: proxies.map((proxy) => proxy.tag), action: 'sniff'},
  ];

  for (const proxy of proxies) {
    if (proxy.servers && proxy.servers.length > 0) {
      rules.push({inbound: [proxy.tag], outbound: `pool-${proxy.tag}`});
    }
  }

  for (const [name, data] of Object.entries(routes || {})) {
    requireMapping(data, `маршрут '${name}'`);
    const outbound = data.outbound === undefined ? 'auto-select' : data.outbound;
    if (!knownOutbounds.has(outbound)) {
      warnings.push(
        `Предупреждение: маршрут '${name}' ссылается на неизвестный outbound '${outbound}'`,
      );
    }
    rules.push({
      domain_suffix: asList(data.domains),
      outbound,
    });
  }
  return rules;
}

/**
 * Builds the `experimental.clash_api` block, or `null` when the API is off.
 *
 * Two rules are refused here and not in a form, because the block ends up in a
 * file the daemon runs:
 *   * `external_controller` must stay on the loopback address. On the router the
 *     WAN address lives on the same host, so a `0.0.0.0` controller would be full
 *     control of the daemon from the internet;
 *   * the secret must be non-empty, and it is passed in from the environment
 *     (`GATEHOUSE_API_SECRET`) so that it never lands in `webui.json`, its
 *     snapshots or a backup.
 *
 * @param {unknown} clashApi The `clash_api` section of the effective settings.
 * @param {string} secret Value of `GATEHOUSE_API_SECRET`.
 * @returns {{external_controller: string, secret: string}|null}
 */
export function clashApiBlock(clashApi, secret) {
  if (!isMapping(clashApi) || clashApi.enabled !== true) return null;

  const controller =
    typeof clashApi.controller === 'string' && clashApi.controller.length > 0
      ? clashApi.controller
      : DEFAULT_CLASH_CONTROLLER;

  // The host is everything before the LAST colon, so an IPv6 literal in brackets
  // would survive; only plain loopback addresses are accepted here anyway.
  const separator = controller.lastIndexOf(':');
  const host = separator < 0 ? controller : controller.slice(0, separator);
  if (!LOOPBACK_HOSTS.includes(host)) {
    throw new ConfigError(
      `clash_api.controller должен указывать только на обратную петлю (${LOOPBACK_HOSTS.join(', ')}), ` +
        `а не на '${host}': на роутере по тому же адресу живёт WAN, и открытый API — ` +
        'это полное управление демоном из интернета',
    );
  }

  if (typeof secret !== 'string' || secret.length === 0) {
    throw new ConfigError(
      `clash_api включён, но секрет пуст: задайте ${API_SECRET_VAR} в окружении сервиса. ` +
        'В webui.json секрет не хранится — он попал бы в снапшоты и бэкапы',
    );
  }

  return {external_controller: controller, secret};
}

/**
 * Assembles the whole sing-box configuration.
 * Reference: `build_config`. Returns `[config, stats]`.
 *
 * @param {Record<string, unknown>} settings Effective settings (defaults merged
 *   with the active profile; `note` fields already dropped).
 * @param {Array<Record<string, unknown>>} outbounds Parsed VLESS outbounds.
 * @param {string} listenIp
 * @param {string[]} [warnings] Collector for non-fatal problems.
 * @param {{apiSecret?: string}} [options] `apiSecret` is the value of
 *   `GATEHOUSE_API_SECRET`; only read when `clash_api.enabled` is true.
 * @returns {[Record<string, unknown>, Record<string, unknown>]}
 */
export function buildConfig(settings, outbounds, listenIp, warnings = [], options = {}) {
  requireMapping(settings, 'settings.yaml');

  const tags = outbounds.map((outbound) => outbound.tag);
  const urltestConfig = settings.urltest === undefined ? null : settings.urltest;
  const ublock = urltestBlock(urltestConfig);

  const proxies = validateProxies(settings.proxies === undefined ? null : settings.proxies);
  const [inbounds, inboundTags] = buildInbounds(proxies, listenIp);
  const pools = buildPools(proxies, tags, urltestConfig);

  const excludePrefixes = validateExclude(
    asList(settings.exclude_from_auto === undefined ? DEFAULT_EXCLUDE : settings.exclude_from_auto),
  );
  const autoTags = tags.filter(
    (tag) => !excludePrefixes.some((prefix) => tag.startsWith(prefix)),
  );
  const excludedTags = tags.filter((tag) => !autoTags.includes(tag));

  const knownOutbounds = new Set([
    ...tags,
    'auto-select',
    'direct',
    ...pools.map((pool) => pool.tag),
  ]);

  const logConfig = settings.log === undefined ? null : settings.log;
  if (logConfig !== null) requireMapping(logConfig, 'log');
  const dnsConfig = settings.dns === undefined ? null : settings.dns;
  if (dnsConfig !== null) requireMapping(dnsConfig, 'dns');
  if (!pyTruthy(dnsConfig)) {
    warnings.push('Предупреждение: в настройках нет секции dns — она будет пустой.');
  }

  const config = {
    log: pyTruthy(logConfig) ? logConfig : {},
    dns: pyTruthy(dnsConfig) ? dnsConfig : {},
    inbounds,
    outbounds: [
      {
        type: 'urltest',
        tag: 'auto-select',
        outbounds: autoTags,
        ...ublock,
      },
      {type: 'direct', tag: 'direct'},
      ...pools,
      ...outbounds,
    ],
    route: {
      rules: buildRules(proxies, settings.routes || null, knownOutbounds, warnings),
      final: 'auto-select',
      default_domain_resolver: 'dns-local',
    },
  };

  // The only section the reference cannot produce. It is appended AFTER `route`
  // and only when the API is on, so a disabled API keeps the output byte-identical
  // to the Python generator.
  const clashApi = clashApiBlock(settings.clash_api, options.apiSecret ?? '');
  if (clashApi !== null) config.experimental = {clash_api: clashApi};

  const stats = {
    servers: outbounds.length,
    inbounds: inbounds.length,
    pools: pools.length,
    auto_count: autoTags.length,
    excluded: excludedTags,
    proxies,
    listen_ip: listenIp,
  };
  return [config, stats];
}

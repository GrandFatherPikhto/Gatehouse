// Assembly of the sing-box configuration.
//
// Port of `build_inbounds`, `build_pools`, `build_rules` and `build_config`
// from /home/yevstigneyevda/Projects/Python/SingBoxTools/sing_box_manager.py
//
// Key order is part of the contract: the acceptance test compares the produced
// `config.json` byte by byte with the reference output, and JS keeps string key
// insertion order, so the order below must mirror the reference exactly.

import {ConfigError, DEFAULT_EXCLUDE, pyTruthy} from './errors.mjs';
import {asList, requireMapping, urltestBlock, validateExclude, validateProxies} from './validate.mjs';

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
 * Assembles the whole sing-box configuration.
 * Reference: `build_config`. Returns `[config, stats]`.
 *
 * @param {Record<string, unknown>} settings Effective settings (defaults merged
 *   with the active profile; `note` fields already dropped).
 * @param {Array<Record<string, unknown>>} outbounds Parsed VLESS outbounds.
 * @param {string} listenIp
 * @param {string[]} [warnings] Collector for non-fatal problems.
 * @returns {[Record<string, unknown>, Record<string, unknown>]}
 */
export function buildConfig(settings, outbounds, listenIp, warnings = []) {
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

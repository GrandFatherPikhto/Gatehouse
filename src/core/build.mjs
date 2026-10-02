// Assembly of the sing-box configuration.
//
// Port of `build_inbounds`, `build_pools`, `build_rules` and `build_config`
// from /home/yevstigneyevda/Projects/Python/SingBoxTools/sing_box_manager.py
//
// Key order is part of the contract: the acceptance test compares the produced
// `config.json` byte by byte with the reference output, and JS keeps string key
// insertion order, so the order below must mirror the reference exactly.

import {DEFAULT_EXCLUDE, isMapping, pyTruthy} from './errors.mjs';
import {
  asList,
  isTunnelProxy,
  requireMapping,
  urltestBlock,
  validateExclude,
  validateProxies,
} from './validate.mjs';

/**
 * Builds the inbounds from validated proxies.
 *
 * `detour` is deliberately not set: in sing-box 1.14 an inbound `detour` chains
 * another inbound, it is not a default outbound. Inbounds are pinned to their
 * pools by route rules instead (see `buildRules`).
 * Reference: `build_inbounds`.
 *
 * A tunnel proxy takes the tag `<tag>-in`: its own tag names the `direct`
 * outbound it is bound to (see `buildTunnelOutbounds`), so the two tags cannot
 * collide. An ordinary proxy keeps `<tag>`, so the golden `config.json` of a
 * project without tunnels stays byte-identical.
 *
 * @param {Array<{tag: string, type: string, port: number, tunnel?: object|null}>} proxies
 * @param {string} listenIp
 * @returns {[Array<Record<string, unknown>>, string[]]}
 */
export function buildInbounds(proxies, listenIp) {
  const inbounds = [];
  const inboundTags = [];
  for (const proxy of proxies) {
    const tag = isTunnelProxy(proxy) ? `${proxy.tag}-in` : proxy.tag;
    inbounds.push({
      type: proxy.type,
      tag,
      listen: listenIp,
      listen_port: proxy.port,
    });
    inboundTags.push(tag);
  }
  return [inbounds, inboundTags];
}

/**
 * Builds one `direct` outbound per tunnel proxy, bound to its interface.
 *
 * `bind_interface` uses `SO_BINDTODEVICE`: sing-box hands packets straight to the
 * interface and bypasses the routing tables, while `amneziawg-go` does the
 * cryptography. Measured live on the router — a probe on the tunnel port
 * answered with the tunnel's own exit address. The tag is the proxy tag, which
 * is what the route rule and `knownOutbounds` refer to.
 *
 * @param {Array<{tag: string, tunnel?: {interface: string}|null}>} proxies
 * @returns {Array<Record<string, unknown>>}
 */
export function buildTunnelOutbounds(proxies) {
  const outbounds = [];
  for (const proxy of proxies) {
    if (!isTunnelProxy(proxy)) continue;
    outbounds.push({
      type: 'direct',
      tag: proxy.tag,
      bind_interface: proxy.tunnel.interface,
    });
  }
  return outbounds;
}

/**
 * Splits the server list of every proxy into "still in the links file" and
 * "gone", skipping the gone ones and reporting ONE line per proxy.
 *
 * A server that vanished is not an error any more: the document keeps its names
 * (renaming the provider folder back makes them resolve again), and the build
 * simply skips them. The warning never lists names — a line of arbitrary length
 * belongs nowhere near the apply bar, and the full list is already shown in the
 * proxy form (the `LABEL_NAMES_CAP` rule of `stale.mjs`).
 *
 * A proxy whose WHOLE list is gone is dropped from the result: an empty list
 * means "the common auto-select pool", and silently moving e.g. a "Russia only"
 * port onto any country would change what the port means behind the owner's
 * back. Such a proxy gets no inbound and no rule — its port simply closes — and
 * the warning names the port so the closed socket is explained.
 *
 * @param {Array<{tag: string, port: number, servers?: string[], tunnel?: object|null}>} proxies
 * @param {string[]} allTags Server tags of the current links files.
 * @param {string[]} [warnings] Collector for the skipped servers.
 * @returns {Array<Record<string, unknown>>} The proxies that still have an exit.
 */
export function resolveServers(proxies, allTags, warnings = []) {
  const usable = [];
  for (const proxy of proxies) {
    // A tunnel proxy owns no server list: its single exit is the interface.
    if (isTunnelProxy(proxy)) {
      usable.push(proxy);
      continue;
    }

    const servers = Array.isArray(proxy.servers) ? proxy.servers : [];
    // No list at all means the common pool; there is nothing to skip.
    if (servers.length === 0) {
      usable.push(proxy);
      continue;
    }

    const present = servers.filter((server) => allTags.includes(server));
    if (present.length === 0) {
      warnings.push(
        `Предупреждение: прокси '${proxy.tag}' (порт ${proxy.port}) выключен: ` +
          `ни одного из его ${servers.length} серверов нет в списке`,
      );
      continue;
    }
    if (present.length < servers.length) {
      warnings.push(
        `Предупреждение: прокси '${proxy.tag}': ${servers.length - present.length} из ` +
          `${servers.length} серверов нет в списке — пропущены`,
      );
    }
    usable.push(present.length === servers.length ? proxy : {...proxy, servers: present});
  }
  return usable;
}

/**
 * Builds one `pool-<tag>` urltest outbound per proxy that lists its own servers.
 * Reference: `build_pools`.
 *
 * Servers that are no longer in the links file are skipped with a warning
 * (`resolveServers`); `buildConfig` resolves them once and passes the result in,
 * so this call reports nothing twice.
 *
 * @param {Array<{tag: string, servers: string[]}>} proxies
 * @param {string[]} allTags
 * @param {unknown} urltestConfig
 * @param {string[]} [warnings]
 * @returns {Array<Record<string, unknown>>}
 */
export function buildPools(proxies, allTags, urltestConfig, warnings = []) {
  const pools = [];
  for (const proxy of resolveServers(proxies, allTags, warnings)) {
    const servers = proxy.servers;
    if (!servers || servers.length === 0) continue;

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
  const rules = [{protocol: 'dns', action: 'hijack-dns'}];
  // The sniff rule names every inbound; with no inbound left (every proxy's
  // servers gone) an empty `inbound` list would make `sing-box check` refuse, so
  // the rule is not written at all in that case.
  if (proxies.length > 0) {
    rules.push({
      inbound: proxies.map((proxy) => (isTunnelProxy(proxy) ? `${proxy.tag}-in` : proxy.tag)),
      action: 'sniff',
    });
  }

  for (const proxy of proxies) {
    if (isTunnelProxy(proxy)) {
      // A tunnel has no pool: its single exit is the `direct` outbound named by
      // the proxy tag, and every packet of the inbound goes straight there.
      rules.push({inbound: [`${proxy.tag}-in`], outbound: proxy.tag});
    } else if (proxy.servers && proxy.servers.length > 0) {
      rules.push({inbound: [proxy.tag], outbound: `pool-${proxy.tag}`});
    }
  }

  for (const [name, data] of Object.entries(routes || {})) {
    requireMapping(data, `маршрут '${name}'`);
    const outbound = data.outbound === undefined ? 'auto-select' : data.outbound;
    // A rule on a missing outbound is NOT written: `sing-box check` refuses an
    // unknown tag, and a written rule would turn a build warning into a hard
    // failure. The warning stays, and says the rule was skipped.
    if (!knownOutbounds.has(outbound)) {
      warnings.push(
        `Предупреждение: маршрут '${name}' ссылается на неизвестный outbound '${outbound}' — ` +
          'правило пропущено',
      );
      continue;
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
 * @param {Record<string, unknown>} settings Effective settings (the flat body,
 *   `note` fields already dropped).
 * @param {Array<Record<string, unknown>>} outbounds Parsed VLESS outbounds.
 * @param {string} listenIp
 * @param {string[]} [warnings] Collector for non-fatal problems.
 * @param {{runningTunnels?: Set<string>}} [options] `runningTunnels` are the
 *   tunnel interfaces found up in systemd; it only feeds the §5.4 warning.
 * @returns {[Record<string, unknown>, Record<string, unknown>]}
 */
export function buildConfig(settings, outbounds, listenIp, warnings = [], options = {}) {
  requireMapping(settings, 'settings.yaml');

  const tags = outbounds.map((outbound) => outbound.tag);
  const urltestConfig = settings.urltest === undefined ? null : settings.urltest;
  const ublock = urltestBlock(urltestConfig);

  const proxies = validateProxies(settings.proxies === undefined ? null : settings.proxies);
  // Servers that left the links file are dropped HERE, once: every later step
  // (inbounds, pools, rules, stats) works on the same surviving list, so a proxy
  // whose whole list is gone leaves no inbound, no rule and no pool behind.
  const usable = resolveServers(proxies, tags, warnings);
  const [inbounds, inboundTags] = buildInbounds(usable, listenIp);
  const pools = buildPools(usable, tags, urltestConfig, warnings);

  const excludePrefixes = validateExclude(
    asList(settings.exclude_from_auto === undefined ? DEFAULT_EXCLUDE : settings.exclude_from_auto),
  );
  const autoTags = tags.filter(
    (tag) => !excludePrefixes.some((prefix) => tag.startsWith(prefix)),
  );
  const excludedTags = tags.filter((tag) => !autoTags.includes(tag));

  const tunnelOutbounds = buildTunnelOutbounds(usable);
  // With NO server outbound at all (every provider folder gone, only tunnels
  // left) an empty `auto-select` urltest is rejected by `sing-box check`
  // («missing tags»), so the tag is not emitted at all and `route.final` falls
  // back to `direct`. The golden config never hits this: its links file always
  // has servers.
  const hasServers = tags.length > 0;

  const knownOutbounds = new Set([
    ...tags,
    ...(hasServers ? ['auto-select'] : []),
    'direct',
    ...pools.map((pool) => pool.tag),
    ...tunnelOutbounds.map((outbound) => outbound.tag),
  ]);

  // §5.4 of the task: a proxy on a tunnel that is not up accepts connections and
  // sends the data nowhere — the exact failure class that cost the owner weeks.
  // The core cannot ask systemd (it is pure), so the caller passes the interfaces
  // it knows are up; without that answer no warning is invented.
  if (Array.isArray(options.runningTunnels)) {
    const running = new Set(options.runningTunnels.map((name) => String(name)));
    for (const proxy of usable) {
      if (!isTunnelProxy(proxy) || running.has(proxy.tunnel.interface)) continue;
      warnings.push(
        `Предупреждение: прокси '${proxy.tag}' слушает порт ${proxy.port}, ` +
          `но туннель '${proxy.tunnel.interface}' не поднят — порт не работает`,
      );
    }
  }

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
      ...(hasServers
        ? [
            {
              type: 'urltest',
              tag: 'auto-select',
              outbounds: autoTags,
              ...ublock,
            },
          ]
        : []),
      {type: 'direct', tag: 'direct'},
      ...pools,
      // Tunnel `direct` outbounds sit next to the pools, before the VLESS
      // outbounds of the links files. The order is stable; it only carries new
      // entries when a tunnel proxy exists.
      ...tunnelOutbounds,
      ...outbounds,
    ],
    route: {
      rules: buildRules(usable, settings.routes || null, knownOutbounds, warnings),
      final: hasServers ? 'auto-select' : 'direct',
      default_domain_resolver: 'dns-local',
    },
  };

  const stats = {
    servers: outbounds.length,
    inbounds: inbounds.length,
    pools: pools.length,
    auto_count: autoTags.length,
    excluded: excludedTags,
    proxies: usable,
    listen_ip: listenIp,
  };
  return [config, stats];
}

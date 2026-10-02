// Stale references and the tree specification of the project.
//
// Port of `find_stale_refs` of
// /home/yevstigneyevda/Projects/Python/SingBoxTools/sing_box_manager.py and of
// `stale_map`/`tree_spec` of
// /home/yevstigneyevda/Projects/Python/SingBoxTools/generator/model.py
//
// A stale reference is a proxy that lists a server which is no longer in the
// links file, or a route whose outbound disappeared. It is NOT an error: the UI
// marks the tree node, and saving stays possible. Only the generator refuses to
// build a pool for a missing server.
//
// Two rules of the current task live here, because this is where node labels are
// built (not in the templates):
//
//   * NO label may print a list of arbitrary length. At most `LABEL_NAMES_CAP`
//     names are shown, then the count; the full list travels in `full` for a
//     tooltip or an expansion and never in the tree line itself;
//   * a diagnosis replaces a symptom. When the links file was not read, the
//     servers did not "disappear" — there was nowhere to take them from, and the
//     mark says which of the four states happened instead of guessing from an
//     empty list. The state is passed in explicitly by the caller, never derived
//     here from emptiness.
//
// Pure functions on plain data: no filesystem, no HTTP, so the whole module is
// testable on its own.

import {isMapping} from '../core/errors.mjs';
import {plural} from '../core/sources.mjs';
import {asList} from '../core/validate.mjs';
import {subscriptionExpiry} from '../core/vless.mjs';

/** Outbounds that always exist in a generated config, besides the servers. */
export const BUILTIN_OUTBOUNDS = Object.freeze(['auto-select', 'direct']);

/** Prefix of the per-proxy urltest pools; routes may name them by hand. */
export const POOL_PREFIX = 'pool-';

/**
 * How many names a node label may print before it switches to a count. Named on
 * purpose: the number is a presentation decision and must not be a literal buried
 * in an expression, so changing it is one edit in one place.
 */
export const LABEL_NAMES_CAP = 3;

/**
 * Renders a list of names for a label without ever printing the whole list.
 *
 * Below or at the cap the names are joined as they are, which keeps the common
 * one- or two-name case readable. Above it, the count plus the first `cap` names
 * plus an ellipsis: `5 — a, b, c …`. `full` always carries every name, for the
 * tooltip.
 *
 * @param {string[]} names
 * @param {number} [cap]
 * @returns {{shown: string, full: string, truncated: boolean}}
 */
export function summarizeNames(names, cap = LABEL_NAMES_CAP) {
  const full = names.join(', ');
  if (names.length <= cap) return {shown: full, full, truncated: false};
  return {shown: `${names.length} — ${names.slice(0, cap).join(', ')} …`, full, truncated: true};
}

/**
 * Finds references to server tags that are not in the current links file.
 * Reference: `find_stale_refs` — same two places, same shape of the location
 * string (`proxies.<tag>.servers` / `routes.<name>.outbound`).
 *
 * Deviation from the reference, deliberate: the reference iterated `servers`
 * directly, so a hand-written `servers: "tag"` would have been iterated
 * character by character. A single string is normalised into a one-element list,
 * exactly like `validate_proxies` in the core does it.
 *
 * @param {unknown} document Parsed webui.json (flat since version 2).
 * @param {string[]} allTags Server tags of the current links file.
 * @returns {Array<[string, string]>} `[where, tag]` pairs.
 */
export function findStaleRefs(document, allTags) {
  const known = new Set([...asList(allTags), ...BUILTIN_OUTBOUNDS]);
  const stale = [];
  const data = isMapping(document) ? document : {};

  for (const proxy of asList(data.proxies)) {
    if (!isMapping(proxy)) continue;
    // A tunnel proxy IS an outbound: its tag names the `direct` outbound with
    // `bind_interface`, so a route pointing at it is not «unknown» (§2.1).
    if (isMapping(proxy.tunnel) && typeof proxy.tag === 'string') known.add(proxy.tag);
    for (const server of asList(proxy.servers)) {
      if (typeof server !== 'string') continue;
      if (!known.has(server)) stale.push([`proxies.${String(proxy.tag)}.servers`, server]);
    }
  }

  const routes = isMapping(data.routes) ? data.routes : {};
  for (const [name, route] of Object.entries(routes)) {
    const outbound = isMapping(route) ? route.outbound : undefined;
    if (typeof outbound !== 'string' || outbound.length === 0) continue;
    if (known.has(outbound) || outbound.startsWith(POOL_PREFIX)) continue;
    stale.push([`routes.${name}.outbound`, outbound]);
  }

  return stale;
}

/**
 * Splits a `where` string of `findStaleRefs` back into section and name.
 * Reference: `_split_stale_where` — a tag may contain dots, so `split('.')`
 * would be unsafe; the known prefix and suffix are trimmed instead.
 *
 * @param {string} where
 * @returns {{section: string, name: string}|null}
 */
export function splitStaleWhere(where) {
  if (where.startsWith('proxies.') && where.endsWith('.servers')) {
    return {section: 'proxies', name: where.slice('proxies.'.length, -'.servers'.length)};
  }
  if (where.startsWith('routes.') && where.endsWith('.outbound')) {
    return {section: 'routes', name: where.slice('routes.'.length, -'.outbound'.length)};
  }
  return null;
}

/**
 * Key of a stale map entry. Exported so callers never build it by hand.
 *
 * @param {string} section
 * @param {string} name
 * @returns {string}
 */
export function staleKey(section, name) {
  return `${section}\u0000${name}`;
}

/**
 * `{section, name} -> [stale tags]`, for marking tree nodes.
 * Reference: `stale_map`.
 *
 * @param {unknown} document Parsed webui.json.
 * @param {string[]} allTags
 * @returns {Map<string, string[]>}
 */
export function staleMap(document, allTags) {
  const result = new Map();
  for (const [where, tag] of findStaleRefs(document, allTags)) {
    const split = splitStaleWhere(where);
    if (split === null) continue;
    const key = staleKey(split.section, split.name);
    const list = result.get(key);
    if (list === undefined) result.set(key, [tag]);
    else list.push(tag);
  }
  return result;
}

/**
 * Builds a tree node. Plain data, no Qt and no HTML: the same tree feeds the
 * EJS template and the tests.
 *
 * @param {string} key
 * @param {string} title
 * @param {string} kind
 * @param {{stale?: boolean, detail?: string, children?: unknown[], mark?: string,
 *   full?: string, group?: boolean}} [extra] `full` is the untruncated mark, for a
 *   tooltip; `group` marks a node that has no page of its own.
 * @returns {Record<string, unknown>}
 */
function node(key, title, kind, extra = {}) {
  return {
    key,
    title,
    kind,
    stale: Boolean(extra.stale),
    detail: extra.detail ?? '',
    mark: extra.mark ?? '',
    full: extra.full ?? extra.mark ?? '',
    // A group is a heading over its children; the template draws it without a
    // link, so the tree cannot send the owner to a page that does not exist.
    group: extra.group === true,
    children: extra.children ?? [],
  };
}

/**
 * Diagnoses of one provider folder, keyed by the state the provider reader
 * reports. The difference runs on the PROVIDER, not on the number: a folder that
 * was read and happens to list none of the proxies' servers still produces the
 * per-proxy fourth message, while a folder that was never read produces one of
 * the first three and nothing else.
 *
 * @param {Record<string, unknown>} provider
 * @returns {string} Empty for a readable folder.
 */
export function providerDiagnosis(provider) {
  // The noun follows the shape of the entry: a stray file in the root, a folder
  // that is not there, or a folder the process may not read.
  const noun =
    provider.type === 'file' ? ['файл', 'не найден', 'недоступен']
      : provider.type === 'folder' ? ['папка', 'не найдена', 'недоступна']
        : ['каталог', 'не найден', 'недоступен'];
  switch (provider.state) {
    case 'missing':
      return `[!] ${noun[0]} ${noun[1]}: ${provider.path}`;
    case 'unreadable':
      return `[!] ${noun[0]} ${noun[2]}: ${provider.path}`;
    case 'empty':
      return `[!] пусто: ${provider.path}`;
    default:
      return '';
  }
}

/**
 * Human readable kind of a provider folder, for its tree label.
 *
 * @param {unknown} kind `subscription`|`awg`|null
 * @returns {string}
 */
function providerKindLabel(kind) {
  switch (kind) {
    case 'subscription':
      return 'подписка';
    case 'awg':
      return 'туннели';
    case 'xray':
      return 'конфиги Xray';
    default:
      return 'вид не задан';
  }
}

/**
 * Tree specification of the project. Reference: `tree_spec`.
 *
 * The profile level is gone, so the tree is flat: one `general` node holds every
 * setting that used to be split between the active profile and `defaults`.
 *
 * @param {{document: unknown, allTags?: string[], title?: string,
 *   providersRoot?: string, providers?: Array<Record<string, unknown>>,
 *   unread?: Array<Record<string, unknown>>, outputFile?: string,
 *   tunnelStates?: Record<string, {active?: boolean, enabled?: boolean,
 *   applied?: boolean}>}} options `tunnelStates` is the runtime state of the
 *   tunnels, keyed by interface; a proxy on a tunnel that is not up gets a mark
 *   that names the CONSEQUENCE, not the fact. `providers` are the folders that
 *   were READ, `unread` everything that could not be.
 * @returns {Record<string, unknown>} Root node.
 */
export function treeSpec(options = {}) {
  const document = isMapping(options.document) ? options.document : {};
  const allTags = asList(options.allTags).filter((tag) => typeof tag === 'string');
  const stale = staleMap(document, allTags);
  const providers = Array.isArray(options.providers) ? options.providers : [];
  const unread = Array.isArray(options.unread) ? options.unread : [];
  const tunnelStates = isMapping(options.tunnelStates) ? options.tunnelStates : {};
  // §5: a proxy whose exits go through Xray is dead while the service is stopped.
  // `xrayTags` names the servers carried by Xray, `xrayActive` its runtime state;
  // both come from the web layer, which alone may ask the host.
  const xrayTags = new Set(asList(options.xrayTags).map((tag) => String(tag)));
  const xrayActive = options.xrayActive === true;
  // The subscription-expiry mark needs a clock; it is injectable so a test never
  // depends on the wall clock (§3.6).
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  // §4.2: providers whose tunnels carry the «carrier» mark.
  const carrierProviders = new Set(asList(options.carrierProviders).map((id) => String(id)));

  const proxyNodes = [];
  for (const proxy of asList(document.proxies)) {
    if (!isMapping(proxy)) continue;
    const tag = typeof proxy.tag === 'string' ? proxy.tag : '';
    const missing = stale.get(staleKey('proxies', tag)) ?? [];
    // A pinned proxy is visible in the tree without opening its form — the whole
    // point of the flag is that the owner notices the lock at a glance. The mark
    // is a plain text label, so the template stays a single interpolation.
    const marks = [];
    let missingFull = '';
    if (missing.length > 0) {
      // The line stays short on purpose: the count and the total say how much of
      // the exit is still there, and the names travel in `full` (the tooltip),
      // never in the tree line itself.
      const total = asList(proxy.servers).filter(
        (server) => typeof server === 'string' && server.length > 0,
      ).length;
      if (total > 0 && missing.length >= total) {
        marks.push('[!] порт закрыт: серверов нет');
      } else {
        marks.push(`[!] ${missing.length} из ${total} нет — пропущены`);
      }
      missingFull = `[!] нет в списке серверов: ${missing.join(', ')}`;
    }
    if (proxy.pinned === true) marks.push('[🔒] выход зафиксирован');

    // §5.4: a proxy on a stopped tunnel is a silently dead port. The mark names
    // the consequence — "the port does not work" — not the fact ("the tunnel is
    // stopped"), because the consequence is what the owner has to act on.
    let tunnelMark = '';
    if (isMapping(proxy.tunnel)) {
      const state = tunnelStates[proxy.tunnel.interface];
      if (isMapping(state) && (state.applied === false || state.active === false)) {
        tunnelMark = '[!] порт не работает: туннель не поднят';
        marks.push(tunnelMark);
      }
    }

    // §5: the same idea for Xray. The mark names how many exits of THIS proxy ride
    // on Xray, so the owner sees why the port is dead, not just that it is.
    let xrayMark = '';
    if (xrayTags.size > 0 && !xrayActive) {
      const count = asList(proxy.servers).filter(
        (server) => typeof server === 'string' && xrayTags.has(server),
      ).length;
      if (count > 0) {
        xrayMark = `[!] ${count} ${plural(
          count,
          'сервер',
          'сервера',
          'серверов',
        )} идут через Xray, а он остановлен`;
        marks.push(xrayMark);
      }
    }

    const mark = marks.join('  ');
    proxyNodes.push(
      node(`proxy:${tag}`, mark === '' ? tag : `${tag}  ${mark}`, 'proxy', {
        stale: missing.length > 0 || tunnelMark !== '' || xrayMark !== '',
        detail: tag,
        mark,
        full: missingFull || tunnelMark || xrayMark,
      }),
    );
  }

  const routeNodes = [];
  const routes = isMapping(document.routes) ? document.routes : {};
  for (const name of Object.keys(routes)) {
    const missing = stale.get(staleKey('routes', name)) ?? [];
    const mark = missing.length > 0 ? `[!] неизвестный outbound: ${missing[0]}` : '';
    routeNodes.push(
      node(`route:${name}`, mark === '' ? name : `${name}  ${mark}`, 'route', {
        stale: missing.length > 0,
        detail: name,
        mark,
      }),
    );
  }

  // Every provider folder is a node of its own, with the honest diagnosis in it.
  // A disabled provider says so — the whole point of the flag is that the owner
  // notices at a glance which folders do NOT feed `config.json`. Unreadable
  // entries are not nodes (many have no folder to open): they are counted in the
  // mark of the «Выходы» node and listed in its panel.
  const providerNode = (provider) => {
    const name =
      typeof provider.label === 'string' && provider.label.length > 0
        ? provider.label
        : String(provider.id);
    const diagnosis = providerDiagnosis(provider);
    const marks = [];
    if (provider.enabled === false) marks.push('[выключен]');
    if (diagnosis !== '') marks.push(diagnosis);
    // §4.2: the owner reaches the router through one of this provider's tunnels.
    const isCarrier = carrierProviders.has(String(provider.id));
    if (isCarrier) marks.push('[несущий]');
    // §3.6: a subscription past its `expire` is marked in the tree, and one that
    // is close to it warns. Both are marks, never a build blocker.
    const expiry =
      provider.kind === 'subscription'
        ? subscriptionExpiry(provider.headers?.expire ?? null, now)
        : null;
    if (expiry !== null && expiry.expired) marks.push(`[!] подписка истекла ${expiry.date}`);
    else if (expiry !== null && expiry.soon) marks.push(`[!] подписка до ${expiry.date}`);
    const mark = marks.join('  ');
    const label = `${name} (${providerKindLabel(provider.kind)}, ${provider.count})`;
    return node(
      `provider:${String(provider.id)}`,
      mark === '' ? label : `${label}  ${mark}`,
      'provider',
      {
        stale:
          diagnosis !== '' ||
          isCarrier ||
          (expiry !== null && (expiry.expired || expiry.soon)),
        detail: String(provider.id),
        mark,
      },
    );
  };

  // §5: grouping is by the KIND of output, not by the engine — an `xray` provider
  // is a subscription to the owner, and its servers appear in the same list.
  const subscriptions = providers.filter(
    (provider) => provider.kind === 'subscription' || provider.kind === 'xray',
  );
  const awg = providers.filter((provider) => provider.kind === 'awg');
  const found = providers.filter((provider) => provider.kind === null);

  const foundNode = node(
    'outputs:found',
    `Найдено, не подключено (${found.length})`,
    'found',
    {
      children: found.map((provider) => {
        const name =
          typeof provider.label === 'string' && provider.label.length > 0
            ? provider.label
            : String(provider.id);
        return node(`provider:${String(provider.id)}`, `${name} — ${provider.hint}`, 'provider', {
          detail: String(provider.id),
          mark: String(provider.hint ?? ''),
        });
      }),
    },
  );

  // «Выходы» HAS a page of its own (the former root Providers panel), so it is a
  // link AND the parent of the two lists and «Найдено». Its mark carries the
  // unread count, exactly like the old «Провайдеры» node did.
  const outputsMark = unread.length > 0 ? `[!] не прочиталось: ${unread.length}` : '';
  const outputs = node('providers', 'Выходы', 'outputs', {
    stale: outputsMark !== '',
    detail: String(options.providersRoot ?? ''),
    mark: outputsMark,
    children: [
      node('outputs:subscriptions', `Подписки (${subscriptions.length})`, 'subscriptions', {
        children: subscriptions.map(providerNode),
      }),
      node('outputs:tunnels', `Туннели AmneziaWG (${awg.length})`, 'tunnels', {
        children: awg.map(providerNode),
      }),
      foundNode,
    ],
  });

  return node('root', options.title ?? 'webui.json', 'root', {
    children: [
      // «Шлюз» — what the clients get: the proxies and the routes. A GROUP, so it
      // is a heading over its two child links and has no page of its own.
      node('gateway', 'Шлюз', 'gateway', {
        group: true,
        children: [
          node('proxies', `Прокси (${proxyNodes.length})`, 'proxies', {children: proxyNodes}),
          node('routes', `Маршруты (${routeNodes.length})`, 'routes', {children: routeNodes}),
        ],
      }),
      outputs,
      // «Настройки» is a GROUP: it has no page, only the Sing-Box and AmneziaWG
      // children. Everything that edits sing-box lives on ONE child panel.
      node('settings', 'Настройки', 'settings', {
        group: true,
        children: [
          node('singbox', 'Sing-Box', 'singbox'),
          node('amnezia', 'AmneziaWG', 'amnezia'),
          node('xray', 'Xray', 'xray'),
        ],
      }),
      // The host layer, renamed to «Службы»: a GROUP over the three tabs.
      node('system', 'Службы', 'system', {
        group: true,
        children: [
          node('system:singbox', 'Sing-Box', 'system'),
          node('system:amnezia', 'AmneziaWG', 'system'),
          node('system:xray', 'Xray', 'system'),
        ],
      }),
    ],
  });
}

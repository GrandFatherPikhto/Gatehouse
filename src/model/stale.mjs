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
import {asList} from '../core/validate.mjs';

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
 * Builds the mark of a missing-server reference from the server names alone.
 *
 * @param {string[]} names
 * @returns {{mark: string, full: string}}
 */
function missingServersMark(names) {
  const summary = summarizeNames(names);
  return {
    mark: `[!] нет в списке серверов: ${summary.shown}`,
    full: `[!] нет в списке серверов: ${summary.full}`,
  };
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
 * Diagnoses of one provider folder, keyed by the state the sources reader
 * reports. The difference runs on the SOURCE, not on the number: a folder that
 * was read and happens to list none of the proxies' servers still produces the
 * per-proxy fourth message, while a folder that was never read produces one of
 * the first three and nothing else.
 *
 * @param {Record<string, unknown>} provider
 * @returns {string} Empty for a readable folder.
 */
export function providerDiagnosis(provider) {
  switch (provider.state) {
    case 'missing':
      return `[!] папка не найдена: ${provider.path}`;
    case 'unreadable':
      return `[!] папка недоступна: ${provider.path}`;
    case 'empty':
      return `[!] пусто: ${provider.path}`;
    default:
      return '';
  }
}

/**
 * Human readable kind of a provider folder, for its tree label.
 *
 * @param {unknown} kind
 * @returns {string}
 */
function providerKindLabel(kind) {
  switch (kind) {
    case 'links':
      return 'ссылки';
    case 'tunnels':
      return 'туннели';
    case 'mixed':
      return 'ссылки+туннели';
    default:
      return 'нет';
  }
}

/**
 * Tree specification of the project. Reference: `tree_spec`.
 *
 * The profile level is gone, so the tree is flat: one `general` node holds every
 * setting that used to be split between the active profile and `defaults`.
 *
 * @param {{document: unknown, allTags?: string[], title?: string, sourcesRoot?: string,
 *   providers?: Array<Record<string, unknown>>, outputFile?: string,
 *   tunnelStates?: Record<string, {active?: boolean, enabled?: boolean,
 *   applied?: boolean}>}} options `tunnelStates` is the runtime state of the
 *   tunnels, keyed by interface; a proxy on a tunnel that is not up gets a mark
 *   that names the CONSEQUENCE, not the fact.
 * @returns {Record<string, unknown>} Root node.
 */
export function treeSpec(options = {}) {
  const document = isMapping(options.document) ? options.document : {};
  const allTags = asList(options.allTags).filter((tag) => typeof tag === 'string');
  const stale = staleMap(document, allTags);
  const providers = Array.isArray(options.providers) ? options.providers : [];
  const tunnelStates = isMapping(options.tunnelStates) ? options.tunnelStates : {};

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
      const built = missingServersMark(missing);
      marks.push(built.mark);
      missingFull = built.full;
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

    const mark = marks.join('  ');
    proxyNodes.push(
      node(`proxy:${tag}`, mark === '' ? tag : `${tag}  ${mark}`, 'proxy', {
        stale: missing.length > 0 || tunnelMark !== '',
        detail: tag,
        mark,
        full: missingFull || tunnelMark,
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

  // Every provider folder is a node of its own, with the honest diagnosis in it:
  // the reason a folder yielded nothing (a path, a permission, an empty folder)
  // belongs where the owner looks, not only in the panel. Tunnels are listed
  // here and never become outbounds.
  const providerNodes = providers.map((provider) => {
    const mark = providerDiagnosis(provider);
    const label = `${String(provider.name)} (${providerKindLabel(provider.kind)}, ${provider.count})`;
    return node(`provider:${String(provider.name)}`, mark === '' ? label : `${label}  ${mark}`, 'provider', {
      stale: mark !== '',
      detail: String(provider.name),
      mark,
    });
  });

  const noSources = providers.length === 0;
  const providersTitle = `Провайдеры (${providers.length})`;
  const providersMark = noSources ? '[!] источники не заданы' : '';

  return node('root', options.title ?? 'webui.json', 'root', {
    children: [
      node('providers', providersTitle, 'providers', {
        stale: providersMark !== '',
        detail: String(options.sourcesRoot ?? ''),
        mark: providersMark,
        children: providerNodes,
      }),
      // «Настройки» is a GROUP: it has no page of its own, so the tree draws it
      // as a heading. Everything that edits sing-box lives on ONE child panel
      // (Общие + DNS + вывод собраны вместе), and the amnezia child holds the
      // directory the tunnel configs are written to.
      node('settings', 'Настройки', 'settings', {
        group: true,
        children: [
          node('singbox', 'Настройки Sing-Box', 'singbox'),
          node('amnezia', 'Настройки Amnezia', 'amnezia'),
        ],
      }),
      node('proxies', `Прокси (${proxyNodes.length})`, 'proxies', {children: proxyNodes}),
      node('routes', `Маршруты (${routeNodes.length})`, 'routes', {children: routeNodes}),
      // The host layer. It edits nothing, so the node carries no stale mark. Like
      // «Настройки» it is a GROUP without a page of its own, and the two former
      // tabs are its CHILDREN now, so the tree draws them as links. The watchdog
      // went away with the watchdog itself.
      node('system', 'Система', 'system', {
        group: true,
        children: [
          node('system:singbox', 'Sing-Box', 'system'),
          node('system:amnezia', 'Amnezia', 'system'),
        ],
      }),
    ],
  });
}

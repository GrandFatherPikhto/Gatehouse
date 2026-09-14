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
// Pure functions on plain data: no filesystem, no HTTP, so the whole module is
// testable on its own.

import {isMapping} from '../core/errors.mjs';
import {asList} from '../core/validate.mjs';

/** Outbounds that always exist in a generated config, besides the servers. */
export const BUILTIN_OUTBOUNDS = Object.freeze(['auto-select', 'direct']);

/** Prefix of the per-proxy urltest pools; routes may name them by hand. */
export const POOL_PREFIX = 'pool-';

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
 * @param {unknown} document Parsed webui.json.
 * @param {string[]} allTags Server tags of the current links file.
 * @returns {Array<[string, string]>} `[where, tag]` pairs.
 */
export function findStaleRefs(document, allTags) {
  const known = new Set([...asList(allTags), ...BUILTIN_OUTBOUNDS]);
  const stale = [];
  const data = isMapping(document) ? document : {};

  const proxies = isMapping(data.profiles) ? profileOf(data) : {};
  for (const proxy of asList(proxies.proxies)) {
    if (!isMapping(proxy)) continue;
    for (const server of asList(proxy.servers)) {
      if (typeof server !== 'string') continue;
      if (!known.has(server)) stale.push([`proxies.${String(proxy.tag)}.servers`, server]);
    }
  }

  const routes = isMapping(proxies.routes) ? proxies.routes : {};
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
 * The active profile body of a document, or an empty object.
 *
 * @param {Record<string, unknown>} document
 * @returns {Record<string, unknown>}
 */
function profileOf(document) {
  if (!isMapping(document.profiles)) return {};
  const body = document.profiles[document.active];
  return isMapping(body) ? body : {};
}

/**
 * Builds a tree node. Plain data, no Qt and no HTML: the same tree feeds the
 * EJS template and the tests.
 *
 * @param {string} key
 * @param {string} title
 * @param {string} kind
 * @param {{stale?: boolean, detail?: string, children?: unknown[], mark?: string}} [extra]
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
    children: extra.children ?? [],
  };
}

/**
 * Tree specification of the project. Reference: `tree_spec`, extended with the
 * two nodes the profiles brought in: `profiles` and `defaults`.
 *
 * @param {{document: unknown, allTags?: string[], active?: string|null,
 *   title?: string, linksFile?: string, linksExists?: boolean,
 *   linksError?: string|null}} options
 * @returns {Record<string, unknown>} Root node.
 */
export function treeSpec(options = {}) {
  const document = isMapping(options.document) ? options.document : {};
  const allTags = asList(options.allTags).filter((tag) => typeof tag === 'string');
  const profile = profileOf(document);
  const stale = staleMap(document, allTags);
  const linksFile = options.linksFile ?? 'links.txt';

  const proxyNodes = [];
  for (const proxy of asList(profile.proxies)) {
    if (!isMapping(proxy)) continue;
    const tag = typeof proxy.tag === 'string' ? proxy.tag : '';
    const missing = stale.get(staleKey('proxies', tag)) ?? [];
    const mark = missing.length > 0 ? `[!] нет в списке серверов: ${missing.join(', ')}` : '';
    proxyNodes.push(
      node(`proxy:${tag}`, mark === '' ? tag : `${tag}  ${mark}`, 'proxy', {
        stale: missing.length > 0,
        detail: tag,
        mark,
      }),
    );
  }

  const routeNodes = [];
  const routes = isMapping(profile.routes) ? profile.routes : {};
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

  // The tree carries a short mark only: the full error text (the reason parsing
  // failed, with the file name and the line) belongs in the panel, where it is
  // readable, not in a node title.
  let linksMark = '';
  if (options.linksExists === false) linksMark = '[!] файл не найден';
  else if (options.linksError) linksMark = '[!] ошибка чтения файла ссылок';

  const active = typeof options.active === 'string' ? options.active : document.active;

  return node('root', options.title ?? 'webui.json', 'root', {
    children: [
      node('profiles', `Профили (активен: ${String(active)})`, 'profiles'),
      node('general', 'Общие', 'general'),
      node('defaults', 'Значения по умолчанию', 'defaults'),
      node('links', `Файл ссылок: ${linksFile}`, 'links', {
        stale: linksMark !== '',
        detail: linksFile,
        mark: linksMark,
      }),
      node('output', `Вывод: ${String(options.outputFile ?? 'config.json')}`, 'output'),
      node('proxies', `Прокси (${proxyNodes.length})`, 'proxies', {children: proxyNodes}),
      node('routes', `Маршруты (${routeNodes.length})`, 'routes', {children: routeNodes}),
      node('dns', 'DNS', 'dns'),
    ],
  });
}

// Providers: discovered by FOLDER, never declared by a path.
//
// The root is `GATEHOUSE_PROVIDERS` (default `/var/lib/gatehouse/providers`).
// Every sub-folder of it is a provider, and the FOLDER NAME is the provider
// identifier. `webui.json` carries a `providers` map keyed by that identifier:
//
//   "providers": {"vpnd": {"enabled": true, "label": "Directly"}}
//
// What a folder may hold:
//
//   * `links.txt` — VLESS links turned into sing-box outbounds (Sing-Box);
//   * `*.conf`    — AmneziaWG / WireGuard configs, LISTED, never outbounds;
//   * both        — one provider with two parts.
//
// Three rules shape this module:
//
//   * the folder name is the IDENTITY. It goes into server tags, into
//     `tunnels[].provider`, into the panel key `provider:<id>` and into
//     `config.json`. A human-readable `label` is SHOWN only and never reaches the
//     document or the generated config — renaming it must not move a byte of
//     `config.json`;
//   * a provider with no record in the map is FOUND and DISABLED. Its servers
//     are absent from the merged outbounds until the owner ticks it, so a new
//     folder on disk never changes `config.json` behind the owner's back;
//   * nothing is watched: the folders are re-read on every call, so a new one
//     appears by itself and no cache can go stale.
//
// Nothing here is silent: a folder that could not be read is reported with the
// reason (no access, empty, no valid link, a name unfit for an identifier) and a
// record whose folder is gone is reported rather than dropped.

import fs from 'node:fs';
import path from 'node:path';

import {ConfigError, isMapping} from './errors.mjs';
import {DEFAULT_PROVIDERS_ROOT} from './paths.mjs';
import {decodeUtf8Ignore, parseLinks, parseVless, pythonStrip} from './vless.mjs';

// The default root now lives in `paths.mjs`, next to the tunnel directory, so
// the build keeps its directories in one place. The name stays published here:
// the model and the CLI keep importing it from the reader that uses it.
export {DEFAULT_PROVIDERS_ROOT};

/** File a provider folder carries its VLESS links in. */
export const LINKS_FILENAME = 'links.txt';

/** Extension of a tunnel config (AmneziaWG / WireGuard). */
export const TUNNEL_EXTENSION = '.conf';

/** Character that separates a colliding tag from its provider identifier. */
export const PROVIDER_LABEL_SEPARATOR = ' · ';

/**
 * What a provider identifier (a folder name) may look like: `[A-Za-z0-9_.-]`,
 * not starting with `.` (hidden) or `-` (a command-line look). The identifier is
 * a systemd instance name and a route key component, so the set is deliberately
 * small and checked before the folder is read.
 */
export const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/**
 * Resolves the providers root AND says where it came from. The order is
 * deliberate:
 *
 *   1. `GATEHOUSE_PROVIDERS` — the one root the owner names, and the only one the
 *      router ever uses (the unit sets it);
 *   2. a `providers/` folder NEXT TO `webui.json`, when it really exists — the
 *      sandbox and the tests keep their data together with the settings, and this
 *      mirrors the old `<settingsDir>/sources` rule;
 *   3. the build default `/var/lib/gatehouse/providers`.
 *
 * Both answers come from ONE function on purpose: the panel prints the source
 * next to the resolved path, and a second implementation of the same three rules
 * is a second chance for the two to disagree. The variable is read from the
 * process environment because the core and the CLI must agree; the web layer may
 * still override the root per instance.
 *
 * @param {string} [settingsDir] Directory of `webui.json`, for rule 2.
 * @param {Record<string, string|undefined>} [env]
 * @returns {{root: string, source: 'GATEHOUSE_PROVIDERS'|'рядом с webui.json'|'умолчание'}}
 */
export function providersRootInfo(settingsDir = process.cwd(), env = process.env) {
  const configured = env.GATEHOUSE_PROVIDERS;
  if (typeof configured === 'string' && configured.length > 0) {
    return {root: configured, source: 'GATEHOUSE_PROVIDERS'};
  }
  const beside = path.join(settingsDir, 'providers');
  try {
    if (fs.statSync(beside).isDirectory()) return {root: beside, source: 'рядом с webui.json'};
  } catch {
    // no folder next to the settings: fall through to the build default
  }
  return {root: DEFAULT_PROVIDERS_ROOT, source: 'умолчание'};
}

/**
 * The resolved root alone. Kept because callers that only need the path — and
 * the tests — should not have to unwrap the pair.
 *
 * @param {string} [settingsDir] Directory of `webui.json`, for rule 2.
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function resolveProvidersRoot(settingsDir = process.cwd(), env = process.env) {
  return providersRootInfo(settingsDir, env).root;
}

/**
 * Maps a filesystem error to the states shared by every read here: a missing
 * path, a path the process may not touch, and everything else.
 *
 * @param {NodeJS.ErrnoException} error
 * @returns {'missing'|'denied'|'error'}
 */
function errorState(error) {
  if (error.code === 'ENOENT') return 'missing';
  if (error.code === 'EACCES' || error.code === 'EPERM') return 'denied';
  return 'error';
}

/**
 * Reads the root directory: does it exist, may it be listed, what does it hold.
 *
 * @param {string} root
 * @returns {{state: 'ok'|'missing'|'denied'|'error', names: string[],
 *   owner: string|null, mode: string|null, error: string|null, message: string|null}}
 */
function readRoot(root) {
  let stat;
  try {
    stat = fs.statSync(root);
  } catch (error) {
    const state = errorState(error);
    return {
      state,
      names: [],
      owner: null,
      mode: null,
      error: error.message,
      message:
        state === 'missing'
          ? `корень провайдеров не найден: ${root}`
          : `нет доступа к корню провайдеров ${root}: ${error.message}`,
    };
  }

  const owner = `${stat.uid}:${stat.gid}`;
  const mode = `0${(stat.mode & 0o777).toString(8)}`;
  if (!stat.isDirectory()) {
    return {
      state: 'error',
      names: [],
      owner,
      mode,
      error: 'ENOTDIR',
      message: `корень провайдеров не каталог: ${root}`,
    };
  }

  let names;
  try {
    names = fs.readdirSync(root);
  } catch (error) {
    const state = errorState(error);
    return {
      state,
      names: [],
      owner,
      mode,
      error: error.message,
      message:
        state === 'denied'
          ? `нет доступа к корню провайдеров ${root} (владелец ${owner}, права ${mode})`
          : `не удалось прочитать корень провайдеров ${root}: ${error.message}`,
    };
  }

  return {state: 'ok', names, owner, mode, error: null, message: null};
}

/**
 * Raw VLESS tags of one links file, BEFORE `dedupTags` renames repetitions. Used
 * to warn about a collision inside one provider instead of letting the silent
 * ` #2` rename hide an error in the provider's own file.
 *
 * @param {string} filePath
 * @returns {string[]}
 */
function rawTags(filePath) {
  let text;
  try {
    text = decodeUtf8Ignore(fs.readFileSync(filePath));
  } catch {
    return [];
  }
  const tags = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (!pythonStrip(line)) continue;
    const outbound = parseVless(line, []);
    if (outbound) tags.push(outbound.tag);
  }
  return tags;
}

/**
 * Reads the `links.txt` of one provider.
 *
 * @param {string} filePath
 * @param {string} id
 * @param {string[]} warnings
 * @returns {{outbounds: Array<Record<string, unknown>>, state: string, error: string|null}}
 */
function readLinks(filePath, id, warnings) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    if (fs.statSync(filePath).isDirectory()) throw new Error('EISDIR');
  } catch {
    return {
      outbounds: [],
      state: 'unreadable',
      error: `файл ссылок ${filePath} недоступен для чтения`,
    };
  }

  const duplicates = new Map();
  for (const tag of rawTags(filePath)) {
    duplicates.set(tag, (duplicates.get(tag) ?? 0) + 1);
  }
  for (const [tag, count] of duplicates) {
    if (count > 1) {
      warnings.push(
        `Предупреждение: у провайдера '${id}' ${count} ссылки с именем '${tag}': ` +
          'переименованы, но это ошибка в файле провайдера',
      );
    }
  }

  try {
    return {outbounds: parseLinks(filePath, warnings), state: 'ok', error: null};
  } catch (caught) {
    if (!(caught instanceof ConfigError)) throw caught;
    const empty = /валидных VLESS-ссылок не обнаружено/.test(caught.message);
    return {outbounds: [], state: empty ? 'empty' : 'unreadable', error: caught.message};
  }
}

/**
 * One provider folder, classified by what it holds.
 *
 * @param {string} id Folder name, already validated.
 * @param {string} dir Absolute folder path.
 * @param {string[]} warnings
 * @returns {Record<string, unknown>}
 */
function readProviderFolder(id, dir, warnings) {
  const base = {id, name: id, path: dir, type: 'folder', discovered: true};

  let stat;
  try {
    stat = fs.statSync(dir);
  } catch (error) {
    return {
      ...base,
      exists: false,
      kind: 'missing',
      count: 0,
      tags: [],
      entries: [],
      outbounds: [],
      state: 'missing',
      owner: null,
      mode: null,
      error: `папка провайдера не найдена: ${dir}`,
    };
  }

  const owner = `${stat.uid}:${stat.gid}`;
  const mode = `0${(stat.mode & 0o777).toString(8)}`;

  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    const state = errorState(error) === 'denied' ? 'denied' : 'unreadable';
    return {
      ...base,
      exists: true,
      kind: 'unreadable',
      count: 0,
      tags: [],
      entries: [],
      outbounds: [],
      state,
      owner,
      mode,
      error:
        state === 'denied'
          ? `нет доступа к папке ${dir} (владелец ${owner}, права ${mode})`
          : `не удалось прочитать папку ${dir}: ${error.message}`,
    };
  }

  const entries = names.filter((name) => name.endsWith(TUNNEL_EXTENSION)).sort();
  const linksPath = path.join(dir, LINKS_FILENAME);

  // A directory named `links.txt` is not a links file: it is ignored, and the
  // folder then holds only what it holds.
  let hasLinks = false;
  try {
    hasLinks = fs.existsSync(linksPath) && fs.statSync(linksPath).isFile();
  } catch {
    hasLinks = false;
  }

  let outbounds = [];
  let linksState = 'ok';
  let linksError = null;
  if (hasLinks) {
    const read = readLinks(linksPath, id, warnings);
    outbounds = read.outbounds;
    linksState = read.state;
    linksError = read.error;
  }

  if (!hasLinks && entries.length === 0) {
    return {
      ...base,
      exists: true,
      kind: 'empty',
      count: 0,
      tags: [],
      entries: [],
      outbounds: [],
      state: 'empty',
      owner,
      mode,
      error: `нет ни ${LINKS_FILENAME}, ни конфигов туннелей (*${TUNNEL_EXTENSION})`,
    };
  }

  const kind = hasLinks ? (entries.length > 0 ? 'mixed' : 'links') : 'tunnels';
  return {
    ...base,
    exists: true,
    kind,
    count: kind === 'tunnels' ? entries.length : outbounds.length,
    tags: outbounds.map((outbound) => outbound.tag),
    entries,
    outbounds,
    state: hasLinks ? linksState : 'ok',
    owner,
    mode,
    error: hasLinks ? linksError : null,
  };
}

/**
 * Turns one document record into the provider fields it contributes.
 *
 * @param {unknown} record
 * @returns {{record: Record<string, unknown>, enabled: boolean, label: string|null}}
 */
function recordView(record) {
  const map = isMapping(record) ? record : {};
  return {
    record: map,
    enabled: map.enabled === true,
    label: typeof map.label === 'string' && map.label.length > 0 ? map.label : null,
  };
}

/**
 * Discovers every provider under `root` and merges the links of the ENABLED ones.
 *
 * `providers` carries the folders that were read (a links file and/or tunnel
 * configs); `unread` carries everything that could not be read, with the reason —
 * a stray file in the root, a folder whose name fits no identifier, a folder the
 * process may not read, an empty folder, a links file without a single valid link,
 * and a record whose folder is gone (which the owner may «forget»).
 *
 * `outbounds` and `tags` come from the ENABLED providers only. A tag that two
 * enabled providers share is suffixed with ` · <id>`; a unique tag keeps its name
 * byte for byte, which is what keeps a one-provider project's `config.json`
 * identical.
 *
 * @param {unknown} records `providers` field of the document (id -> record).
 * @param {string} root Absolute providers root.
 * @param {string[]} [warnings]
 * @returns {{root: string, rootState: {state: string, owner: string|null,
 *   mode: string|null, message: string|null}, providers: Array<Record<string, unknown>>,
 *   unread: Array<Record<string, unknown>>, outbounds: Array<Record<string, unknown>>,
 *   tags: string[], warnings: string[]}}
 */
export function readProviders(records, root, warnings = []) {
  const map = isMapping(records) ? records : {};
  const rootState = readRoot(root);

  if (rootState.state !== 'ok') {
    return {
      root,
      rootState: {
        state: rootState.state,
        owner: rootState.owner,
        mode: rootState.mode,
        message: rootState.message,
      },
      providers: [],
      unread: [],
      outbounds: [],
      tags: [],
      warnings,
    };
  }

  const providers = [];
  const unread = [];

  for (const name of [...rootState.names].sort()) {
    if (name.startsWith('.')) continue; // hidden entries are skipped silently
    const full = path.join(root, name);

    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }

    if (!stat.isDirectory()) {
      unread.push({
        id: name,
        name,
        path: full,
        type: 'file',
        discovered: true,
        exists: true,
        forget: false,
        state: 'stray',
        error: `лежит вне папки провайдера, не читается: ${full}`,
      });
      continue;
    }

    if (!PROVIDER_ID_PATTERN.test(name)) {
      unread.push({
        id: name,
        name,
        path: full,
        type: 'folder',
        discovered: true,
        exists: true,
        forget: false,
        state: 'badname',
        error: `не подходит для идентификатора: имя папки '${name}'`,
      });
      continue;
    }

    const view = recordView(map[name]);
    const provider = {
      ...readProviderFolder(name, full, warnings),
      record: view.record,
      enabled: view.enabled,
      label: view.label,
      forget: false,
    };
    if (provider.state === 'ok') providers.push(provider);
    else unread.push(provider);
  }

  // A record whose folder is gone is NOT dropped silently: it is reported, and
  // «forget» is the only way to remove it.
  for (const [id, record] of Object.entries(map)) {
    if (providers.some((provider) => provider.id === id)) continue;
    if (unread.some((entry) => entry.id === id && entry.discovered)) continue;
    const view = recordView(record);
    unread.push({
      id,
      name: id,
      path: path.join(root, id),
      type: 'folder',
      discovered: false,
      exists: false,
      forget: true,
      state: 'missing',
      enabled: view.enabled,
      label: view.label,
      record: view.record,
      error: `папки больше нет: ${path.join(root, id)}`,
    });
  }

  const collected = [];
  for (const provider of providers) {
    if (!provider.enabled) continue;
    for (const outbound of provider.outbounds) {
      collected.push({provider: provider.id, outbound});
    }
  }

  const seen = new Map();
  for (const item of collected) {
    const tag = String(item.outbound.tag);
    seen.set(tag, (seen.get(tag) ?? 0) + 1);
  }

  const outbounds = collected.map((item) => {
    const tag = String(item.outbound.tag);
    if ((seen.get(tag) ?? 0) > 1) {
      return {...item.outbound, tag: `${tag}${PROVIDER_LABEL_SEPARATOR}${item.provider}`};
    }
    return item.outbound;
  });

  return {
    root,
    rootState: {
      state: 'ok',
      owner: rootState.owner,
      mode: rootState.mode,
      message: null,
    },
    providers,
    unread,
    outbounds,
    tags: outbounds.map((outbound) => outbound.tag),
    warnings,
  };
}

/**
 * True when a provider identifier is acceptable. Kept next to the reader so the
 * model and the tests never spell the rule twice.
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isProviderId(id) {
  return typeof id === 'string' && PROVIDER_ID_PATTERN.test(id);
}

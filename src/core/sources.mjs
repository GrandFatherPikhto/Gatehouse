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
import {
  applyOverrides,
  decodeUtf8Ignore,
  parseLinks,
  parseSubscriptionHeaders,
  parseVless,
  pythonStrip,
} from './vless.mjs';
import {XRAY_CONFIGS_FILENAME, readXrayConfigs} from './xray.mjs';

// The default root now lives in `paths.mjs`, next to the tunnel directory, so
// the build keeps its directories in one place. The name stays published here:
// the model and the CLI keep importing it from the reader that uses it.
export {DEFAULT_PROVIDERS_ROOT};

/** File a provider folder carries its VLESS links in. */
export const LINKS_FILENAME = 'links.txt';

/** Extension of a tunnel config (AmneziaWG / WireGuard). */
export const TUNNEL_EXTENSION = '.conf';

/** Longest `providers.<id>.suffix` the schema accepts (see webui.schema.json). */
export const SUFFIX_MAX_LENGTH = 16;

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
 * @param {string[]} warnings Per-provider collector, not the global one.
 * @param {Array<{label: string, reason: string}>} skipped Per-provider skips.
 * @returns {{outbounds: Array<Record<string, unknown>>, state: string, error: string|null}}
 */
function readLinks(filePath, id, warnings, skipped) {
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
    return {outbounds: parseLinks(filePath, warnings, skipped), state: 'ok', error: null};
  } catch (caught) {
    if (!(caught instanceof ConfigError)) throw caught;
    const empty = /валидных VLESS-ссылок не обнаружено/.test(caught.message);
    return {outbounds: [], state: empty ? 'empty' : 'unreadable', error: caught.message};
  }
}

/**
 * Reads the Happ/v2RayTun headers of a subscription file, or empty values.
 *
 * @param {string} filePath
 * @returns {{title: string|null, expire: number|null}}
 */
function readSubscriptionHeaders(filePath) {
  try {
    return parseSubscriptionHeaders(decodeUtf8Ignore(fs.readFileSync(filePath)));
  } catch {
    return {title: null, expire: null};
  }
}

/**
 * Human hint of what a folder WITHOUT a chosen kind looks like, for the
 * «Найдено, не подключено» list (§3.5). Never a decision — just a hint.
 *
 * @param {string} contentKind `links`|`tunnels`|`mixed`|`empty`
 * @param {number} links
 * @param {number} confs
 * @returns {string}
 */
export function describeContent(contentKind, parts = {}) {
  const links = Number(parts.links) || 0;
  const confs = Number(parts.confs) || 0;
  const xrayConfigs = Number(parts.xrayConfigs) || 0;
  const xrayOutbounds = Number(parts.xrayOutbounds) || 0;
  const xrayServers = Number(parts.xrayServers) || 0;
  const xrayText =
    `${XRAY_CONFIGS_FILENAME} (${xrayConfigs} ${plural(
      xrayConfigs,
      'конфиг',
      'конфига',
      'конфигов',
    )}, ${xrayServers} ${plural(xrayServers, 'сервер', 'сервера', 'серверов')})`;

  switch (contentKind) {
    case 'links':
      return `похоже на подписку: ${LINKS_FILENAME}, ${links} ${plural(
        links,
        'ссылка',
        'ссылки',
        'ссылок',
      )}`;
    case 'tunnels':
      return `похоже на туннели: ${confs} ${plural(confs, 'конфиг', 'конфига', 'конфигов')}`;
    case 'xray':
      return (
        `похоже на конфиги Xray: ${xrayConfigs} ${plural(
          xrayConfigs,
          'конфиг',
          'конфига',
          'конфигов',
        )}, ${xrayOutbounds} выходов, ${xrayServers} ${plural(
          xrayServers,
          'сервер',
          'сервера',
          'серверов',
        )}`
      );
    case 'mixed': {
      // EVERY source with its number, never a silent single-kind suggestion: on
      // the router a mixed folder was suggested as «подписка» and that is how the
      // wrong kind got chosen (task 20 §3).
      const items = [];
      if (links > 0) {
        items.push(`${LINKS_FILENAME} (${links} ${plural(links, 'ссылка', 'ссылки', 'ссылок')})`);
      }
      if (xrayConfigs > 0) items.push(xrayText);
      if (confs > 0) {
        items.push(`${confs} ${plural(confs, 'конфиг', 'конфига', 'конфигов')} туннелей`);
      }
      return (
        `смешанная папка: ${items.join(', ')} — разнесите по разным папкам или ` +
        'выберите вид: лишнее не читается'
      );
    }
    case 'unreadable':
      return 'файл не читается';
    case 'denied':
      return 'нет доступа';
    case 'missing':
      return 'папки нет';
    default:
      return 'пусто';
  }
}

/**
 * What kind a folder's content LOOKS like. A HINT for the diagnosis and the
 * button, never a silent choice: `mixed` has no single answer.
 *
 * @param {string} contentKind `links`|`tunnels`|`xray`|`mixed`|`empty`|…
 * @returns {'subscription'|'awg'|'xray'|null}
 */
export function suggestedKind(contentKind) {
  if (contentKind === 'links') return 'subscription';
  if (contentKind === 'tunnels') return 'awg';
  if (contentKind === 'xray') return 'xray';
  return null;
}

/**
 * File a chosen kind expects in its folder, for the diagnosis text.
 *
 * @param {'subscription'|'awg'|'xray'|null} kind
 * @returns {string}
 */
export function kindFileName(kind) {
  if (kind === 'subscription') return LINKS_FILENAME;
  if (kind === 'xray') return XRAY_CONFIGS_FILENAME;
  if (kind === 'awg') return `конфиг туннелей (*${TUNNEL_EXTENSION})`;
  return '';
}

/**
 * True when the folder really carries the source its chosen kind expects, which
 * tells «the file is there but holds nothing usable» apart from «the file is not
 * there at all» — the state that needs a kind change (task 20 §1.3, §2.2).
 * `mixed` counts as present: the folder may well hold the file, plus something
 * else. One rule, used by the tree label and by the panel.
 *
 * @param {'subscription'|'awg'|'xray'|null} kind
 * @param {string} contentKind `links`|`tunnels`|`xray`|`mixed`|`empty`|`denied`|…
 * @returns {boolean}
 */
export function kindSourcePresent(kind, contentKind) {
  if (contentKind === 'mixed') return true;
  if (kind === 'subscription') return contentKind === 'links';
  if (kind === 'awg') return contentKind === 'tunnels';
  if (kind === 'xray') return contentKind === 'xray';
  return false;
}

/**
 * Russian plural form for a count. One helper, so «1 конфиг», «2 конфига» and
 * «5 конфигов» can never drift apart between the messages (§2.2).
 *
 * @param {number} count
 * @param {string} one Form for 1, 21, 31, …
 * @param {string} few Form for 2–4, 22–24, …
 * @param {string} many Form for 0, 5–20, 25–30, …
 * @returns {string}
 */
export function plural(count, one, few, many) {
  const n = Math.abs(Math.trunc(Number(count)));
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/**
 * The kind a folder IMPLIES from its content. One rule for the reader and the
 * migration (§0): a record without `kind` is read exactly like the file it came
 * from, so the CLI works on an old document before the first save.
 *
 * @param {string} contentKind `links`|`tunnels`|`mixed`|`empty`
 * @returns {'subscription'|'awg'|null}
 */
export function inferKind(contentKind) {
  if (contentKind === 'links') return 'subscription';
  if (contentKind === 'tunnels') return 'awg';
  return null;
}

/**
 * One provider folder, read according to the kind the OWNER chose (§3).
 *
 * `kind` is `subscription` (only `links.txt`), `awg` (only `*.conf`) or `null`
 * («Найдено, не подключено»: nothing is read, the content is only described).
 * The foreign half of a mixed folder is warned about and NOT read.
 *
 * @param {string} id Folder name, already validated.
 * @param {string} dir Absolute folder path.
 * @param {string[]} warnings Per-provider collector (see `readProviders`).
 * @param {Array<{label: string, reason: string}>} skipped Per-provider skips.
 * @param {'subscription'|'awg'|null} storedKind Kind written in the record.
 * @param {boolean} hasRecord True when `providers` has an entry for the folder.
 * @returns {Record<string, unknown>}
 */
function readProviderFolder(id, dir, warnings, skipped, storedKind, hasRecord) {
  const base = {id, name: id, path: dir, type: 'folder', discovered: true};
  // Content counts for the diagnosis and the hint. A foreign half of a folder is
  // counted too — that is what makes the «вид не совпадает с содержимым» block and
  // the «смешанная папка» list possible (task 20 §2, §3).
  const emptyParts = () => ({links: 0, confs: 0, xrayConfigs: 0, xrayOutbounds: 0, xrayServers: 0});
  const zeroXray = {configs: 0, outbounds: 0, servers: 0};

  let stat;
  try {
    stat = fs.statSync(dir);
  } catch (error) {
    return {
      ...base,
      exists: false,
      kind: null,
      contentKind: 'missing',
      count: 0,
      tags: [],
      baseTags: [],
      entries: [],
      outbounds: [],
      xrayServers: [],
      xrayMeta: zeroXray,
      parts: emptyParts(),
      hint: describeContent('missing', emptyParts()),
      headers: {title: null, expire: null},
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
    // The folder may not be listed, so its content is unknown. The CHOSEN kind is
    // still honoured for the branch of the tree (task 20 §1.1): a `stash` seen as
    // «Подписка» stays under «Подписки», with the diagnosis on it.
    return {
      ...base,
      exists: true,
      kind: storedKind ?? null,
      contentKind: state,
      count: 0,
      tags: [],
      baseTags: [],
      entries: [],
      outbounds: [],
      xrayServers: [],
      xrayMeta: zeroXray,
      parts: emptyParts(),
      hint: describeContent(state, emptyParts()),
      headers: {title: null, expire: null},
      state,
      owner,
      mode,
      error:
        state === 'denied'
          ? `нет доступа к папке ${dir} (владелец ${owner}, права ${mode})`
          : `не удалось прочитать папку ${dir}: ${error.message}`,
    };
  }

  const confFiles = names.filter((name) => name.endsWith(TUNNEL_EXTENSION)).sort();
  const linksPath = path.join(dir, LINKS_FILENAME);
  const xrayPath = path.join(dir, XRAY_CONFIGS_FILENAME);

  // A directory named `links.txt` is not a links file: it is ignored.
  let hasLinks = false;
  try {
    hasLinks = fs.existsSync(linksPath) && fs.statSync(linksPath).isFile();
  } catch {
    hasLinks = false;
  }

  // `xray-configs.json` is the source of kind `xray`: full Xray client configs,
  // copied verbatim (§1.1). A folder is MIXED as soon as it carries more than one
  // sort of content, the xray one included.
  let hasXray = false;
  try {
    hasXray = fs.existsSync(xrayPath) && fs.statSync(xrayPath).isFile();
  } catch {
    hasXray = false;
  }

  const contentParts = (hasLinks ? 1 : 0) + (confFiles.length > 0 ? 1 : 0) + (hasXray ? 1 : 0);
  const contentKind =
    contentParts > 1
      ? 'mixed'
      : hasLinks
        ? 'links'
        : confFiles.length > 0
          ? 'tunnels'
          : hasXray
            ? 'xray'
            : 'empty';

  // An OLD record carries no `kind`: it is inferred from the content AT READ, by
  // the same rule the migration uses, so the file and the document are read
  // identically and generation works before the first save (§0.1).
  const kind = storedKind ?? (hasRecord ? inferKind(contentKind) : null);

  // The foreign half of a folder with a CHOSEN kind is warned about and left
  // unread (§3.1). A mixed folder WITHOUT a kind is left for the migration.
  const foreignWarning = (what) =>
    warnings.push(
      `Предупреждение: лишнее в папке '${id}': ${what} — разнесите по разным папкам`,
    );
  if (kind === 'subscription' && confFiles.length > 0) {
    foreignWarning(`${confFiles.length} конфигов туннелей`);
  }
  if (kind === 'subscription' && hasXray) {
    foreignWarning(XRAY_CONFIGS_FILENAME);
  }
  if (kind === 'awg' && hasLinks) {
    foreignWarning(LINKS_FILENAME);
  }
  if (kind === 'awg' && hasXray) {
    foreignWarning(XRAY_CONFIGS_FILENAME);
  }
  if (kind === 'xray' && hasLinks) {
    foreignWarning(LINKS_FILENAME);
  }
  if (kind === 'xray' && confFiles.length > 0) {
    foreignWarning(`${confFiles.length} конфигов туннелей`);
  }

  // Any OTHER `*.json` next to the expected file is named, never read (§1.1): the
  // owner copied the wrong export, and silence would hide it.
  if (hasXray || kind === 'xray') {
    for (const name of names.filter(
      (entry) => entry.endsWith('.json') && entry !== XRAY_CONFIGS_FILENAME,
    )) {
      warnings.push(
        `Предупреждение: файл не читается: ожидается ${XRAY_CONFIGS_FILENAME} (${name})`,
      );
    }
  }

  const wantLinks = kind === 'subscription' || (kind === null && hasLinks);
  let rawOutbounds = [];
  let linksState = 'ok';
  let linksError = null;
  if (wantLinks && hasLinks) {
    const read = readLinks(linksPath, id, warnings, skipped);
    rawOutbounds = read.outbounds;
    linksState = read.state;
    linksError = read.error;
  }

  // The Xray configs are read for a chosen `xray` kind AND for the hint of a
  // folder that has no kind yet («Найдено»), where the numbers come from them.
  const wantXray = kind === 'xray' || (kind === null && hasXray);
  let xrayServers = [];
  let xrayMeta = {configs: 0, outbounds: 0, servers: 0};
  let xrayState = 'ok';
  let xrayError = null;
  if (wantXray && hasXray) {
    const read = readXrayConfigs(xrayPath, warnings, skipped);
    xrayServers = read.servers;
    xrayMeta = read.meta;
    xrayState = read.state;
    xrayError = read.error;
  }

  // Counts for the diagnosis. The CHOSEN half was read above with the real
  // collectors; a FOREIGN half is read here with throwaway ones, so its per-line
  // warnings never reach the panel (task 20 §3).
  let linksCount = rawOutbounds.length;
  if (!wantLinks && hasLinks) linksCount = readLinks(linksPath, id, [], []).outbounds.length;
  let xrayCountMeta = xrayMeta;
  if (!wantXray && hasXray) xrayCountMeta = readXrayConfigs(xrayPath, [], []).meta;
  const parts = {
    links: linksCount,
    confs: confFiles.length,
    xrayConfigs: xrayCountMeta.configs,
    xrayOutbounds: xrayCountMeta.outbounds,
    xrayServers: xrayCountMeta.servers,
  };

  const headers =
    kind === 'subscription' && hasLinks
      ? readSubscriptionHeaders(linksPath)
      : {title: null, expire: null};

  if (kind === null) {
    // «Найдено, не подключено»: nothing participates in the build, but the
    // content is described so the owner can choose a kind (§3.5). A folder that
    // is present but has nothing usable is «empty» too: an empty folder, or a
    // `links.txt` without a single valid link.
    const noContent = contentKind === 'empty';
    const noValidLinks = contentKind === 'links' && rawOutbounds.length === 0;
    // A file that could not be READ is not «a folder that holds nothing»: the
    // hint says so and the folder is marked, so a broken `xray-configs.json` is
    // never described as «0 конфигов» (task 20 §1.3).
    const brokenFile =
      (contentKind === 'xray' && xrayState === 'unreadable') ||
      (contentKind === 'links' && linksState === 'unreadable');
    const empty = !brokenFile && (noContent || noValidLinks);
    const xrayNames = xrayServers.map((server) => server.name);
    const tags =
      contentKind === 'xray' && !brokenFile
        ? xrayNames
        : contentKind === 'xray'
          ? []
          : rawOutbounds.map((outbound) => outbound.tag);
    const count =
      contentKind === 'tunnels'
        ? confFiles.length
        : contentKind === 'xray'
          ? xrayServers.length
          : rawOutbounds.length;
    return {
      ...base,
      exists: true,
      kind: null,
      contentKind: brokenFile ? 'unreadable' : contentKind,
      count,
      tags,
      baseTags: tags,
      entries: [],
      outbounds: [],
      xrayServers: [],
      xrayMeta,
      parts,
      hint: describeContent(brokenFile ? 'unreadable' : contentKind, parts),
      headers,
      state: brokenFile ? 'unreadable' : empty ? 'empty' : 'ok',
      owner,
      mode,
      error: brokenFile
        ? (contentKind === 'xray' ? xrayError : linksError)
        : noContent
          ? `нет ни ${LINKS_FILENAME}, ни конфигов туннелей (*${TUNNEL_EXTENSION}), ни ${XRAY_CONFIGS_FILENAME}`
          : noValidLinks
            ? `в ${LINKS_FILENAME} нет валидных ссылок`
            : null,
    };
  }

  // Kind `xray`: the servers are the copied Xray outbounds, named and numbered by
  // the core reader (§1.2, §1.3). They never become sing-box outbounds here — the
  // socks front end is built later, where the ports are known (§3.2).
  if (kind === 'xray') {
    if (!hasXray) {
      return {
        ...base,
        exists: true,
        kind,
        contentKind,
        count: 0,
        tags: [],
        baseTags: [],
        entries: [],
        outbounds: [],
        xrayServers: [],
        xrayMeta: zeroXray,
        parts,
        hint: describeContent(contentKind, parts),
        headers,
        state: 'empty',
        owner,
        mode,
        error: `нет ${XRAY_CONFIGS_FILENAME}`,
      };
    }
    const names = xrayServers.map((server) => server.name);
    return {
      ...base,
      exists: true,
      kind,
      contentKind,
      count: xrayServers.length,
      tags: names,
      baseTags: names,
      entries: [],
      outbounds: [],
      xrayServers,
      xrayMeta,
      parts,
      hint: describeContent(contentKind, parts),
      headers,
      state: hasXray ? xrayState : 'empty',
      owner,
      mode,
      error: hasXray && xrayState !== 'ok' ? xrayError : null,
    };
  }

  const subscription = kind === 'subscription';
  const outbounds = subscription ? rawOutbounds : [];
  const entries = subscription ? [] : confFiles;
  // A `links.txt` without a single valid link is «empty», not «broken»: the file
  // was readable. The message names the file, so the panel can print one wording
  // for it whichever branch read the folder (task 20 §1.3, §2.3).
  const noValidLinks = subscription && linksState === 'empty';

  if (subscription && !hasLinks) {
    return {
      ...base,
      exists: true,
      kind,
      contentKind,
      count: 0,
      tags: [],
      baseTags: [],
      entries: [],
      outbounds: [],
      xrayServers: [],
      xrayMeta: zeroXray,
      parts,
      hint: describeContent(contentKind, parts),
      headers,
      state: 'empty',
      owner,
      mode,
      error: `нет ${LINKS_FILENAME}`,
    };
  }
  if (!subscription && entries.length === 0) {
    return {
      ...base,
      exists: true,
      kind,
      contentKind,
      count: 0,
      tags: [],
      baseTags: [],
      entries: [],
      outbounds: [],
      xrayServers: [],
      xrayMeta: zeroXray,
      parts,
      hint: describeContent(contentKind, parts),
      headers,
      state: 'empty',
      owner,
      mode,
      error: `нет конфигов туннелей (*${TUNNEL_EXTENSION})`,
    };
  }

  return {
    ...base,
    exists: true,
    kind,
    contentKind,
    count: subscription ? outbounds.length : entries.length,
    tags: outbounds.map((outbound) => outbound.tag),
    baseTags: outbounds.map((outbound) => outbound.tag),
    entries,
    outbounds,
    xrayServers: [],
    xrayMeta: zeroXray,
    parts,
    hint: describeContent(contentKind, parts),
    headers,
    state: noValidLinks ? 'empty' : subscription ? linksState : 'ok',
    owner,
    mode,
    error: noValidLinks
      ? `в ${LINKS_FILENAME} нет валидных ссылок`
      : subscription
        ? linksError
        : null,
  };
}

/**
 * Turns one document record into the provider fields it contributes.
 *
 * @param {unknown} record
 * @returns {{record: Record<string, unknown>, enabled: boolean, label: string|null,
 *   kind: 'subscription'|'awg'|'xray'|null}}
 */
function recordView(record) {
  const map = isMapping(record) ? record : {};
  return {
    record: map,
    enabled: map.enabled === true,
    label: typeof map.label === 'string' && map.label.length > 0 ? map.label : null,
    kind:
      map.kind === 'subscription' || map.kind === 'awg' || map.kind === 'xray'
        ? map.kind
        : null,
  };
}

/**
 * Discovers every provider under `root` and merges the links of the ENABLED ones.
 *
 * `providers` carries EVERY folder that exists on disk, whatever its state — an
 * empty one, one whose chosen kind finds no file, one with a broken file, one the
 * process may not read — so each has a tree node and a panel (task 20 §1).
 * `unread` carries only what has no folder to open: a stray file in the root, a
 * folder whose name fits no identifier, and a record whose folder is gone (which
 * the owner may «forget»).
 *
 * Names are settled HERE and nowhere else: after the in-file `dedupTags`, the
 * owner's `suffix` is appended and the per-subscription `overrides` are applied,
 * so generation, tree, the proxy picker and the panel see one and the same name.
 *
 * `outbounds`/`tags` come from the ENABLED providers only and are de-duplicated
 * for display; a name handed out by two enabled providers is NOT renamed — it is
 * reported in `collisions`, and generation refuses with it (§2.2).
 *
 * Warnings of a DISABLED provider never reach the global list (generation does
 * not read that folder) but stay on `provider.warnings` for the panel.
 *
 * @param {unknown} records `providers` field of the document (id -> record).
 * @param {string} root Absolute providers root.
 * @param {string[]} [warnings] Global collector, for the generator.
 * @returns {{root: string, rootState: {state: string, owner: string|null,
 *   mode: string|null, message: string|null}, providers: Array<Record<string, unknown>>,
 *   unread: Array<Record<string, unknown>>, outbounds: Array<Record<string, unknown>>,
 *   xrayServers: Array<{provider: string, server: Record<string, unknown>}>,
 *   tags: string[], collisions: Array<{tag: string, providers: string[]}>,
 *   warnings: string[]}}
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
      xrayServers: [],
      tags: [],
      collisions: [],
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
    const hasRecord = Object.hasOwn(map, name);
    const localWarnings = [];
    const localSkipped = [];
    const folder = readProviderFolder(name, full, localWarnings, localSkipped, view.kind, hasRecord);
    const provider = {
      ...folder,
      record: view.record,
      // A folder whose kind is neither written nor inferred never feeds the
      // build, even if the record still says `enabled: true` from before (§3.1).
      enabled: view.enabled && folder.kind !== null,
      hasRecord,
      storedKind: view.kind,
      label: view.label,
      forget: false,
    };

    // The suffix is appended AFTER the in-file dedup, so `… #2` becomes
    // `… #2 WS`. Overrides are applied to the same objects, in the same place.
    const suffix = cleanSuffix(view.record);
    const overrides = providerOverrides(view.record);
    provider.suffix = suffix;
    provider.warnings = localWarnings;
    provider.skipped = localSkipped;

    if (provider.kind === 'xray') {
      // Xray servers are named exactly like subscription servers, and the suffix
      // applies the same way. The port key is built from the BASE name, so moving
      // the suffix never moves a port (§2).
      const base = provider.xrayServers ?? [];
      const servers = base
        .map((server) =>
          suffix.length > 0 ? {...server, name: `${server.baseName} ${suffix}`} : server,
        )
        .map((server) => ({...server, key: `${provider.id}/${server.baseName}`}));
      provider.xrayServers = servers;
      provider.baseTags = base.map((server) => server.baseName);
      provider.tags = servers.map((server) => server.name);
    } else {
      const baseTags = provider.tags;
      let outbounds = provider.outbounds;
      if (suffix.length > 0 || Object.keys(overrides).length > 0) {
        outbounds = outbounds.map((outbound) =>
          applyOverrides(withSuffix(outbound, suffix), overrides),
        );
      }
      provider.baseTags = baseTags;
      provider.outbounds = outbounds;
      provider.tags = outbounds.map((outbound) => outbound.tag);
    }

    // Generation reads only the ENABLED folders, so only their warnings belong
    // in the generator output; the panel still sees every provider's own list.
    if (provider.enabled) warnings.push(...localWarnings);

    // EVERY folder that exists is a provider here, whatever its state (task 20 §1):
    // an empty folder, a folder whose chosen kind finds no file, a folder with a
    // broken file, a folder without access — each gets a tree node and a panel, so
    // the view can be fixed from the interface. Only a folder that is GONE (or a
    // stray file / a name unfit for an id) stays out, in `unread`.
    providers.push(provider);
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
    // Xray servers join the same namespace: a name two enabled providers share is
    // the same collision, whichever engine carries the traffic (§1.3).
    for (const server of provider.xrayServers ?? []) {
      collected.push({provider: provider.id, server});
    }
  }

  const collectedTag = (item) =>
    item.outbound ? String(item.outbound.tag) : String(item.server.name);

  // A name two ENABLED providers share is a collision, not a rename: the first
  // provider in the identifier order keeps the name for DISPLAY only, and
  // generation refuses with the full list.
  const byTag = new Map();
  for (const item of collected) {
    const tag = collectedTag(item);
    if (!byTag.has(tag)) byTag.set(tag, []);
    const ids = byTag.get(tag);
    if (!ids.includes(item.provider)) ids.push(item.provider);
  }
  const collisions = [];
  for (const [tag, ids] of byTag) {
    if (ids.length > 1) collisions.push({tag, providers: ids});
  }

  const outbounds = [];
  const xrayServers = [];
  const seen = new Set();
  for (const item of collected) {
    if (item.server) {
      xrayServers.push({provider: item.provider, server: item.server});
      continue;
    }
    const tag = String(item.outbound.tag);
    if (seen.has(tag)) continue;
    seen.add(tag);
    outbounds.push(item.outbound);
  }

  const tags = [];
  const tagSeen = new Set();
  for (const item of collected) {
    const tag = collectedTag(item);
    if (tagSeen.has(tag)) continue;
    tagSeen.add(tag);
    tags.push(tag);
  }

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
    xrayServers,
    tags,
    collisions,
    warnings,
  };
}

/**
 * The `suffix` stored for a provider, or `''` when there is none or it does not
 * fit the schema (1–16 characters, no control characters, no leading/trailing
 * whitespace). The model refuses an invalid value; a hand-edited file is read as
 * if the field were absent instead of breaking generation.
 *
 * @param {unknown} record
 * @returns {string}
 */
export function cleanSuffix(record) {
  const value = isMapping(record) ? record.suffix : undefined;
  if (typeof value !== 'string') return '';
  if (value.length < 1 || value.length > SUFFIX_MAX_LENGTH) return '';
  if (value !== value.trim()) return '';
  if (/[\u0000-\u001f\u007f]/.test(value)) return '';
  return value;
}

/**
 * `providers.<id>.overrides` as a plain object, or `{}`.
 *
 * @param {unknown} record
 * @returns {{flow?: string, fp?: string}}
 */
export function providerOverrides(record) {
  const value = isMapping(record) ? record.overrides : undefined;
  return isMapping(value) ? value : {};
}

/**
 * Appends the provider suffix to one outbound tag, after a single space.
 *
 * @param {Record<string, unknown>} outbound
 * @param {string} suffix
 * @returns {Record<string, unknown>}
 */
function withSuffix(outbound, suffix) {
  if (suffix.length === 0) return outbound;
  return {...outbound, tag: `${outbound.tag} ${suffix}`};
}

/**
 * The refusal text for provider name collisions (§2.2), grouped by provider
 * pair with at most three examples; `null` when there is no collision.
 *
 * @param {Array<{tag: string, providers: string[]}>} collisions
 * @returns {string|null}
 */
export function collisionRefusal(collisions) {
  if (!Array.isArray(collisions) || collisions.length === 0) return null;
  const byPair = new Map();
  for (const {tag, providers} of collisions) {
    const pair = [...providers].sort();
    const key = pair.join('\u0000');
    if (!byPair.has(key)) byPair.set(key, {providers: pair, tags: []});
    byPair.get(key).tags.push(tag);
  }
  const sentences = [];
  for (const {providers, tags} of byPair.values()) {
    const examples = tags
      .slice(0, 3)
      .map((tag) => `'${tag}'`)
      .join(', ');
    sentences.push(
      `провайдеры ${providers.join(' и ')} дают ${tags.length} одинаковых имён серверов ` +
        `(например, ${examples}): задайте приписку одному из них или выключите один`,
    );
  }
  return sentences.join('\n');
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

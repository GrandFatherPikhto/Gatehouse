// Sources: several provider folders instead of one links file.
//
// `webui.json` lists folder names under a sources root; the folder name IS the
// provider name (see techdocs/architecture.md §7.2). Each folder may hold a
// `links.txt` with VLESS links, tunnel configs (`*.conf`), or both:
//
//   sources/
//     vpnd/links.txt                  links   -> sing-box outbounds
//     hidemyname/AustriaGrazS4.conf   tunnels -> listed in the panel only
//
// Two rules decide the shape of this module:
//
//   * tunnels are LISTED, never turned into outbounds. The inter-provider
//     switching hypothesis is not verified on the live router yet, so the code
//     must not be able to leak a tunnel into `config.json` (task §9);
//   * with exactly one source and no name collisions the outbounds keep their
//     tags untouched, so the generated `config.json` cannot move because of this
//     part. A provider label appears ONLY when two providers hand out the same
//     name, and then it is appended to that name.
//
// The reader is deliberately filesystem-only and has no system calls.

import fs from 'node:fs';
import path from 'node:path';

import {ConfigError} from './errors.mjs';
import {decodeUtf8Ignore, parseLinks, parseVless, pythonStrip} from './vless.mjs';

/** Default sub-directory of the settings directory that holds the providers. */
export const DEFAULT_SOURCES_DIRNAME = 'sources';

/** File name inside a provider folder that carries the VLESS links. */
export const LINKS_FILENAME = 'links.txt';

/** Extension of a tunnel config (AmneziaWG / WireGuard). */
export const TUNNEL_EXTENSION = '.conf';

/** Character that separates a colliding tag from its provider label. */
export const PROVIDER_LABEL_SEPARATOR = ' · ';

/**
 * Resolves the sources root: `GATEHOUSE_SOURCES` when set, otherwise
 * `<directory of webui.json>/sources`. On the router the settings live in
 * `/etc/gatehouse` while the lists live under `/var/lib/gatehouse`, which is why
 * the environment variable exists at all.
 *
 * @param {string} settingsDir
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function resolveSourcesRoot(settingsDir, env = process.env) {
  const configured = env.GATEHOUSE_SOURCES;
  if (typeof configured === 'string' && configured.length > 0) return configured;
  return path.join(settingsDir, DEFAULT_SOURCES_DIRNAME);
}

/**
 * Normalises the `sources` field of the document into a list of names, dropping
 * blanks. A single string is accepted the way `asList` of the core accepts one.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function sourceNames(value) {
  const list = value === null || value === undefined ? [] : Array.isArray(value) ? value : [value];
  return list
    .filter((name) => typeof name === 'string')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
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
 * Latest modification time in a list of files, as an ISO string, or `null` when
 * there is nothing to stat. An unreadable file contributes nothing rather than
 * throwing: the panel reports the folder, not each stat error.
 *
 * @param {string[]} files
 * @returns {string|null}
 */
function latestMtime(files) {
  let latest = 0;
  for (const file of files) {
    try {
      latest = Math.max(latest, fs.statSync(file).mtimeMs);
    } catch {
      // ignore: the folder is reported as unreadable elsewhere
    }
  }
  return latest === 0 ? null : new Date(latest).toISOString();
}

/**
 * Reads one provider folder.
 *
 * @param {string} name
 * @param {string} root
 * @param {string[]} warnings
 * @returns {{provider: Record<string, unknown>, outbounds: Array<Record<string, unknown>>}}
 */
function readProvider(name, root, warnings) {
  const dir = path.join(root, name);
  const base = {name, path: dir};

  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return {
      provider: {
        ...base,
        exists: false,
        kind: 'missing',
        count: 0,
        mtime: null,
        state: 'missing',
        error: `папка источника ${name} не найдена: ${dir}`,
        entries: [],
      },
      outbounds: [],
    };
  }

  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return {
      provider: {
        ...base,
        exists: true,
        kind: 'unreadable',
        count: 0,
        mtime: null,
        state: 'unreadable',
        error: `папка источника ${name} недоступна для чтения: ${dir}`,
        entries: [],
      },
      outbounds: [],
    };
  }

  const linksPath = path.join(dir, LINKS_FILENAME);
  const tunnelNames = names
    .filter((entry) => entry.endsWith(TUNNEL_EXTENSION))
    .sort();
  const tunnelPaths = tunnelNames.map((entry) => path.join(dir, entry));
  const hasLinks = fs.existsSync(linksPath);

  /** @type {Array<Record<string, unknown>>} */
  let outbounds = [];
  let state = 'ok';
  let error = null;

  if (hasLinks) {
    // Reject an unreadable links file the same way the old single-file reader
    // did: a directory in place of the file, a permission problem.
    try {
      fs.accessSync(linksPath, fs.constants.R_OK);
      if (fs.statSync(linksPath).isDirectory()) throw new Error('EISDIR');
    } catch {
      state = 'unreadable';
      error = `файл ссылок ${linksPath} недоступен для чтения`;
    }

    if (state === 'ok') {
      const duplicates = new Map();
      for (const tag of rawTags(linksPath)) {
        duplicates.set(tag, (duplicates.get(tag) ?? 0) + 1);
      }
      for (const [tag, count] of duplicates) {
        if (count > 1) {
          warnings.push(
            `Предупреждение: в источнике '${name}' ${count} ссылки с именем '${tag}': ` +
              'переименованы, но это ошибка в файле провайдера',
          );
        }
      }

      try {
        outbounds = parseLinks(linksPath, warnings);
      } catch (caught) {
        if (!(caught instanceof ConfigError)) throw caught;
        state = /валидных VLESS-ссылок не обнаружено/.test(caught.message) ? 'empty' : 'unreadable';
        error = caught.message;
      }
    }
  } else if (tunnelNames.length === 0) {
    state = 'empty';
    error = `в источнике '${name}' нет ни файла ссылок, ни конфигов туннелей`;
  }

  const kind = hasLinks
    ? tunnelNames.length > 0
      ? 'mixed'
      : 'links'
    : 'tunnels';

  return {
    provider: {
      ...base,
      exists: true,
      kind,
      count: kind === 'tunnels' ? tunnelNames.length : outbounds.length,
      mtime: latestMtime([...(hasLinks ? [linksPath] : []), ...tunnelPaths]),
      state,
      error,
      // Tunnels are shown by name and NEVER become outbounds.
      entries: tunnelNames,
    },
    outbounds,
  };
}

/**
 * Reads every configured provider and merges the links into one outbound list.
 *
 * The label rule is the whole point of the merge: a tag that appears in more
 * than one provider is suffixed with ` · <provider>`, so the owner can tell the
 * two apart; a tag that appears once keeps its name byte for byte, which is what
 * keeps a single-source project's `config.json` identical.
 *
 * @param {unknown} sources `sources` field of the document.
 * @param {string} root Resolved sources root.
 * @param {string[]} [warnings]
 * @returns {{root: string, providers: Array<Record<string, unknown>>,
 *   outbounds: Array<Record<string, unknown>>, tags: string[]}}
 */
export function readSources(sources, root, warnings = []) {
  const names = sourceNames(sources);
  const providers = [];
  /** @type {Array<{provider: string, outbound: Record<string, unknown>}>} */
  const collected = [];

  for (const name of names) {
    const {provider, outbounds} = readProvider(name, root, warnings);
    providers.push(provider);
    for (const outbound of outbounds) collected.push({provider: name, outbound});
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
    providers,
    outbounds,
    tags: outbounds.map((outbound) => outbound.tag),
  };
}

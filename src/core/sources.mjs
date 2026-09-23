// Sources: explicit origins instead of provider folders.
//
// `webui.json` lists sources as objects (see techdocs/architecture.md §7.2):
//
//   {kind: 'links',   name: 'vpnd',       path: '/var/lib/gatehouse/sources/vpnd/links.txt'}
//   {kind: 'tunnels', name: 'hidemyname', path: '/var/lib/gatehouse/sources/hidemyname'}
//
//   * kind 'links'   — ONE file with VLESS links, turned into sing-box outbounds;
//   * kind 'tunnels' — a DIRECTORY of AmneziaWG / WireGuard `*.conf`, listed in the
//     panel only and NEVER turned into outbounds.
//
// `path` is stored exactly as the owner typed it. A relative path resolves against
// the directory of `webui.json` (`baseDir`), an absolute one is used as is — the
// same rule `output_file` and `amnezia_dir` follow, so the file survives a move
// between the router and the desktop sandbox.
//
// A LEGACY entry is a bare string: the name of a folder under the sources root
// that may hold `links.txt`, `*.conf`, or both. It is still accepted so a document
// written by an older build keeps working; the editor converts those entries into
// objects on open. The reader itself stays filesystem-only, with no system calls.
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

import fs from 'node:fs';
import path from 'node:path';

import {ConfigError, isMapping} from './errors.mjs';
import {decodeUtf8Ignore, parseLinks, parseVless, pythonStrip} from './vless.mjs';

/** Default sub-directory of the settings directory that holds the providers. */
export const DEFAULT_SOURCES_DIRNAME = 'sources';

/** File name a legacy provider folder carries the VLESS links in. */
export const LINKS_FILENAME = 'links.txt';

/** Extension of a tunnel config (AmneziaWG / WireGuard). */
export const TUNNEL_EXTENSION = '.conf';

/** Character that separates a colliding tag from its provider label. */
export const PROVIDER_LABEL_SEPARATOR = ' · ';

/** Kinds a source object may carry in the document. */
export const SOURCE_KINDS = Object.freeze(['links', 'tunnels']);

/**
 * Internal kind of a bare-string entry: a provider FOLDER under the sources root.
 * It is never written back to the document — `open` converts it to an object —
 * but the reader understands it, which is what keeps an old file readable.
 */
export const LEGACY_KIND = 'legacy';

/**
 * Resolves the sources root: `GATEHOUSE_SOURCES` when set, otherwise
 * `<directory of webui.json>/sources`. It is the base of a LEGACY folder entry
 * and the label the tree shows; an explicit source ignores it.
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
 * Normalises the `sources` field of the document into a list of source specs,
 * dropping blanks and malformed entries. A single item is accepted the way
 * `asList` of the core accepts one.
 *
 * A bare string becomes a legacy folder entry; an object must carry a known
 * `kind`, a non-empty `name` and a non-empty `path`.
 *
 * @param {unknown} value
 * @returns {Array<{kind: string, name: string, path: string}>}
 */
export function sourceSpecs(value) {
  const list = value === null || value === undefined ? [] : Array.isArray(value) ? value : [value];
  const specs = [];
  for (const item of list) {
    if (typeof item === 'string') {
      const name = item.trim();
      if (name.length > 0) specs.push({kind: LEGACY_KIND, name, path: name});
      continue;
    }
    if (!isMapping(item)) continue;
    const kind = typeof item.kind === 'string' ? item.kind : '';
    if (!SOURCE_KINDS.includes(kind)) {
      throw new ConfigError(
        `источник '${String(item.name ?? '')}': неизвестный тип '${kind}' ` +
          `(ожидается ${SOURCE_KINDS.join('|')})`,
      );
    }
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const target = typeof item.path === 'string' ? item.path.trim() : '';
    if (name.length === 0) throw new ConfigError('у источника не задано имя (name)');
    if (target.length === 0) throw new ConfigError(`у источника '${name}' не задан путь (path)`);
    specs.push({kind, name, path: target});
  }
  return specs;
}

/**
 * Names of the sources, in document order. Kept for callers that only need the
 * provider labels (stale diagnostics, the tree).
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function sourceNames(value) {
  return sourceSpecs(value).map((spec) => spec.name);
}

/**
 * Resolves the target a spec points at. A legacy folder is joined to the sources
 * root; an explicit path is joined to the settings directory when relative.
 *
 * @param {{kind: string, path: string}} spec
 * @param {{root: string, baseDir: string}} context
 * @returns {string}
 */
function resolveTarget(spec, context) {
  if (spec.kind === LEGACY_KIND) return path.join(context.root, spec.path);
  return path.isAbsolute(spec.path) ? spec.path : path.join(context.baseDir, spec.path);
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
 * throwing: the panel reports the source, not each stat error.
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
      // ignore: the source is reported as unreadable elsewhere
    }
  }
  return latest === 0 ? null : new Date(latest).toISOString();
}

/**
 * Reads the links of one `kind: 'links'` source (or the `links.txt` of a legacy
 * folder).
 *
 * @param {string} filePath
 * @param {string} name
 * @param {string[]} warnings
 * @returns {{outbounds: Array<Record<string, unknown>>, state: string, error: string|null}}
 */
function readLinks(filePath, name, warnings) {
  if (!fs.existsSync(filePath)) {
    return {outbounds: [], state: 'missing', error: `файл ссылок не найден: ${filePath}`};
  }

  // Reject an unreadable links file the way the old single-file reader did: a
  // directory in place of the file, a permission problem.
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    if (fs.statSync(filePath).isDirectory()) throw new Error('EISDIR');
  } catch {
    return {outbounds: [], state: 'unreadable', error: `файл ссылок ${filePath} недоступен для чтения`};
  }

  const duplicates = new Map();
  for (const tag of rawTags(filePath)) {
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
    return {outbounds: parseLinks(filePath, warnings), state: 'ok', error: null};
  } catch (caught) {
    if (!(caught instanceof ConfigError)) throw caught;
    const empty = /валидных VLESS-ссылок не обнаружено/.test(caught.message);
    return {outbounds: [], state: empty ? 'empty' : 'unreadable', error: caught.message};
  }
}

/**
 * Reads the `*.conf` list of one `kind: 'tunnels'` source directory.
 *
 * @param {string} dir
 * @returns {{entries: string[], state: string, error: string|null}}
 */
function readTunnels(dir) {
  if (!fs.existsSync(dir)) {
    return {entries: [], state: 'missing', error: `каталог туннелей не найден: ${dir}`};
  }

  let names;
  try {
    if (!fs.statSync(dir).isDirectory()) throw new Error('ENOTDIR');
    names = fs.readdirSync(dir);
  } catch {
    return {entries: [], state: 'unreadable', error: `каталог туннелей ${dir} недоступен для чтения`};
  }

  const entries = names.filter((entry) => entry.endsWith(TUNNEL_EXTENSION)).sort();
  if (entries.length === 0) {
    return {entries: [], state: 'empty', error: `в каталоге '${dir}' нет конфигов туннелей (*${TUNNEL_EXTENSION})`};
  }
  return {entries, state: 'ok', error: null};
}

/**
 * Reads one source spec.
 *
 * A legacy folder is inspected to decide what it holds: `links.txt` makes it a
 * links source, `*.conf` a tunnels source, both a `mixed` one.
 *
 * @param {{kind: string, name: string, path: string}} spec
 * @param {{root: string, baseDir: string}} context
 * @param {string[]} warnings
 * @returns {{provider: Record<string, unknown>, outbounds: Array<Record<string, unknown>>}}
 */
function readSource(spec, context, warnings) {
  const target = resolveTarget(spec, context);

  if (spec.kind === 'tunnels') {
    const {entries, state, error} = readTunnels(target);
    return {
      provider: {
        name: spec.name,
        kind: 'tunnels',
        storedPath: spec.path,
        path: target,
        type: 'directory',
        exists: fs.existsSync(target),
        count: entries.length,
        mtime: latestMtime(entries.map((entry) => path.join(target, entry))),
        state,
        error,
        entries,
        tags: [],
      },
      outbounds: [],
    };
  }

  if (spec.kind === 'links') {
    const {outbounds, state, error} = readLinks(target, spec.name, warnings);
    return {
      provider: {
        name: spec.name,
        kind: 'links',
        storedPath: spec.path,
        path: target,
        type: 'file',
        exists: fs.existsSync(target),
        count: outbounds.length,
        mtime: latestMtime([target]),
        state,
        error,
        entries: [],
        tags: outbounds.map((outbound) => outbound.tag),
      },
      outbounds,
    };
  }

  // Legacy: a folder under the sources root, inspected for both kinds of content.
  const dir = target;
  const base = {
    name: spec.name,
    storedPath: spec.path,
    path: dir,
    type: 'folder',
  };

  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return {
      provider: {
        ...base,
        kind: 'missing',
        exists: false,
        count: 0,
        mtime: null,
        state: 'missing',
        error: `папка источника ${spec.name} не найдена: ${dir}`,
        entries: [],
        tags: [],
      },
      outbounds: [],
    };
  }

  const linksPath = path.join(dir, LINKS_FILENAME);
  const hasLinks = fs.existsSync(linksPath);
  const tunnels = readTunnels(dir);
  const entries = tunnels.entries;

  let outbounds = [];
  let linksState = 'ok';
  let linksError = null;
  if (hasLinks) {
    const read = readLinks(linksPath, spec.name, warnings);
    outbounds = read.outbounds;
    linksState = read.state;
    linksError = read.error;
  }

  const kind = hasLinks ? (entries.length > 0 ? 'mixed' : 'links') : 'tunnels';
  let state = linksState;
  let error = linksError;
  if (!hasLinks && entries.length === 0) {
    state = 'empty';
    error = `в источнике '${spec.name}' нет ни файла ссылок, ни конфигов туннелей`;
  }

  return {
    provider: {
      ...base,
      kind,
      exists: true,
      count: kind === 'tunnels' ? entries.length : outbounds.length,
      mtime: latestMtime([...(hasLinks ? [linksPath] : []), ...entries.map((entry) => path.join(dir, entry))]),
      state,
      error,
      entries,
      tags: outbounds.map((outbound) => outbound.tag),
    },
    outbounds,
  };
}

/**
 * Reads every configured source and merges the links into one outbound list.
 *
 * The label rule is the whole point of the merge: a tag that appears in more
 * than one provider is suffixed with ` · <provider>`, so the owner can tell the
 * two apart; a tag that appears once keeps its name byte for byte, which is what
 * keeps a single-source project's `config.json` identical.
 *
 * @param {unknown} sources `sources` field of the document.
 * @param {{root: string, baseDir?: string}|string} context Sources root and the
 *   directory a relative `path` resolves against. A bare string is accepted as
 *   the root AND the base, which keeps older callers working.
 * @param {string[]} [warnings]
 * @returns {{root: string, providers: Array<Record<string, unknown>>,
 *   outbounds: Array<Record<string, unknown>>, tags: string[]}}
 */
export function readSources(sources, context, warnings = []) {
  const resolved =
    typeof context === 'string'
      ? {root: context, baseDir: context}
      : {root: context.root, baseDir: context.baseDir ?? context.root};

  const specs = sourceSpecs(sources);
  const providers = [];
  /** @type {Array<{provider: string, outbound: Record<string, unknown>}>} */
  const collected = [];

  for (const spec of specs) {
    const {provider, outbounds} = readSource(spec, resolved, warnings);
    providers.push(provider);
    for (const outbound of outbounds) collected.push({provider: spec.name, outbound});
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
    root: resolved.root,
    providers,
    outbounds,
    tags: outbounds.map((outbound) => outbound.tag),
  };
}

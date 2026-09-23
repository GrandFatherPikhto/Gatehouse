// Server-side state of the web editor: one open `webui.json`.
//
// Behavioural reference:
// /home/yevstigneyevda/Projects/Python/SingBoxTools/generator/model.py — the
// dirty flag, open/save/new, the proxy and route CRUD, `load_server_tags`,
// `stale_refs`/`stale_map`, `tree_spec` and `format_stats` are ported from there
// by sense, with the exact rules taken from that file.
//
// Divergence from that reference, deliberate: this editor used to wrap the flat
// body in a `defaults` + `profiles` + `active` envelope. The envelope is gone
// (version 2, see techdocs/architecture.md §8.9): a single profile never carried
// anything to inherit, and the two levels only raised the question "is this key
// shared or profile-local?" for every field. `open` still knows the old shape and
// migrates it once.
//
// The module knows nothing about HTTP: routes parse a request, call a method and
// hand the result to a template. That keeps the model testable without a server
// (as `model.py` was testable without qtbot) and keeps a future switch to a
// React front end from touching anything but the view layer.
//
// One rule is worth stating up front, because everything else follows from it:
// user-facing rejections throw `ConfigError` with a Russian message, which is
// what the form shows to the owner. There is no silent clamping anywhere.

import fs from 'node:fs';
import path from 'node:path';

import {ConfigError, DEFAULT_EXCLUDE, PROXY_TYPES, isMapping} from '../core/errors.mjs';
import {
  dropRemovedSettings,
  generateConfigFile,
  isLegacyDocument,
  removedSettingsMessage,
  resolvePath,
  validateSettings,
} from '../core/settings.mjs';
import {
  normalizeTunnel,
  suggestTunnelName,
  tunnelConfigRefusal,
  validateInterfaceName,
  validateTunnelLabel,
} from '../core/normalize.mjs';
import {readSources, resolveSourcesRoot, sourceNames} from '../core/sources.mjs';
import {
  applyTunnelConfig,
  listTunnelConfigNames,
  removeTunnelConfig,
  tunnelConfigApplied,
  tunnelConfigPath,
} from '../system/tunnel-file.mjs';
import {asList, isTunnelProxy, requireMapping, urltestBlock, validateProxies} from '../core/validate.mjs';
import {staleMap, treeSpec as buildTree} from './stale.mjs';
import {
  DEFAULT_SNAPSHOT_KEEP,
  DEFAULT_STATE_DIR,
  canonicalJson,
  takeSnapshot,
  writeAtomic,
} from './storage.mjs';

/* Defaults of the reference (generator/model.py). */
export const DEFAULT_LISTEN_IP = '127.0.0.1';
export const DEFAULT_OUTPUT_FILE = 'config.json';
export const DEFAULT_URLTEST_URL = 'https://gstatic.com';
export const DEFAULT_URLTEST_INTERVAL = '3m';
export const DEFAULT_URLTEST_TOLERANCE = 50;
export const DEFAULT_LOG_LEVEL = 'info';

/* Defaults of the web editor itself. */
export const DEFAULT_PROXY_PORT = 54321;
/** Default directory of the applied tunnel configs; mirrors `DEFAULT_AMNEZIA_DIR` of the system layer. */
export const DEFAULT_AMNEZIA_DIR = '/etc/amnezia/amneziawg';
export const DEFAULT_PROXY_TYPE = 'socks';
export const DEFAULT_PROXY_TAG = 'new-proxy';
export const DEFAULT_ROUTE_NAME = 'route';

/** Document format this build writes; 1 was the profile-level envelope. */
export const DOCUMENT_VERSION = 2;

/**
 * Refusal shown when a pinned proxy would end up with a pool. The wording is
 * fixed by the task: an accidental second server is exactly what the flag exists
 * to prevent, and the owner has to be told how to lift the mark.
 */
export const PINNED_REFUSAL = 'у прокси зафиксирован выход — снимите отметку, если нужен пул';

/**
 * Refusal shown when a tunnel proxy would also carry a server list. §5.1 of the
 * task: one tunnel — one proxy — one exit; mixing it with a pool would put the
 * "which exit did it actually take" question right back.
 */
export const TUNNEL_WITH_SERVERS_REFUSAL =
  'у туннельного прокси не может быть серверов: один туннель — один выход';

/**
 * A name made of digits only is refused by the schema, and for a reason that
 * also has to be enforced here: JavaScript reorders integer-like object keys, so
 * such a name would jump to the front of the file and the byte order of
 * `webui.json` (and of the `routes` section of `config.json`) would stop being
 * predictable. The schema is the source of truth; this regex mirrors its
 * `pattern` and a test asserts the two agree.
 */
const DIGIT_ONLY_NAME = /^\d+$/;

/**
 * Builds a fresh, minimal flat document — the port of `NEW_SETTINGS_TEMPLATE` of
 * the reference, without the profile envelope.
 *
 * @returns {Record<string, unknown>}
 */
export function newDocument() {
  return {
    version: DOCUMENT_VERSION,
    listen_ip: DEFAULT_LISTEN_IP,
    sources: [],
    output_file: DEFAULT_OUTPUT_FILE,
    exclude_from_auto: [...DEFAULT_EXCLUDE],
    urltest: {
      url: DEFAULT_URLTEST_URL,
      interval: DEFAULT_URLTEST_INTERVAL,
      tolerance: DEFAULT_URLTEST_TOLERANCE,
    },
    log: {level: DEFAULT_LOG_LEVEL, timestamp: true},
    dns: {servers: [], rules: [], final: 'dns-local'},
    proxies: [],
    routes: {},
  };
}

/**
 * Migrates a version-1 or pre-sources document into the current shape.
 *
 * Two incompatible changes are folded into this one pass, because both mean
 * "open the file once in the editor":
 *
 *   * the `defaults`/`profiles`/`active` envelope is flattened. More than one
 *     profile is NOT guessed — the owner picked the active one for a reason —
 *     so the file is refused with the names; a single body is spread on top of a
 *     merged `defaults` (the profile is stronger), with one warning per migrated
 *     key;
 *   * a `links_file` string becomes `sources: [<parent folder>]`, the folder
 *     name being the provider name. A bare file name carries no provider name,
 *     so it maps to 'default' with a warning telling the owner where the file
 *     has to move.
 *
 * @param {Record<string, unknown>} data Parsed legacy document.
 * @param {string} [source] File name used in the messages.
 * @returns {{document: Record<string, unknown>, warnings: string[]}}
 */
export function migrateLegacyDocument(data, source = 'webui.json') {
  const warnings = [];
  let merged;

  if (isMapping(data.profiles)) {
    const profiles = data.profiles;
    const names = Object.keys(profiles);

    if (names.length === 0) {
      throw new ConfigError(
        `${source}: это документ старого формата, но без профилей: мигрировать нечего. ` +
          'Схема webui.json версии 2 их больше не знает — приведите файл к плоскому виду вручную.',
      );
    }
    if (names.length > 1) {
      throw new ConfigError(
        `${source}: в файле несколько профилей (${names.join(', ')}) — автоматически развернуть ` +
          'можно только один. Выберите активный, удалите остальные руками и откройте файл снова: ' +
          'молча выбросить чужие настройки хуже, чем остановиться.',
      );
    }

    const name = names[0];
    const body = isMapping(profiles[name]) ? profiles[name] : {};
    const defaults = isMapping(data.defaults) ? data.defaults : {};

    for (const key of Object.keys(defaults)) {
      if (Object.hasOwn(body, key)) {
        warnings.push(
          `Предупреждение: ключ '${key}' из defaults перекрыт значением профиля '${name}' и не перенесён`,
        );
      } else {
        warnings.push(`Предупреждение: ключ '${key}' из defaults перенесён на верхний уровень`);
      }
    }

    merged = {...defaults, ...body};
    delete merged.profiles;
    delete merged.defaults;
    delete merged.active;
  } else {
    merged = {...data};
  }

  if (typeof merged.links_file === 'string' && merged.links_file.length > 0) {
    const linksFile = merged.links_file;
    const folder = path.dirname(linksFile);
    const provider = folder === '.' || folder === '' ? 'default' : path.basename(folder);
    delete merged.links_file;
    if (Array.isArray(merged.sources) && merged.sources.length > 0) {
      warnings.push(`Предупреждение: поле links_file '${linksFile}' отброшено в пользу sources`);
    } else {
      merged.sources = [provider];
      warnings.push(
        `Предупреждение: links_file '${linksFile}' заменён на sources: ['${provider}']` +
          (provider === 'default' ? `; положите файл в <sources>/${provider}/links.txt` : ''),
      );
    }
  }

  return {document: {version: DOCUMENT_VERSION, ...merged}, warnings};
}

/**
 * Human readable summary of a generation run.
 * Reference: `format_stats` of generator/model.py.
 *
 * @param {string} outputFile
 * @param {Record<string, unknown>} stats
 * @param {string[]} [warnings]
 * @returns {string}
 */
export function formatStats(outputFile, stats, warnings = []) {
  const lines = [
    `Конфиг сгенерирован: ${outputFile}`,
    `Серверов: ${stats.servers}, инбаундов: ${stats.inbounds}, пулов: ${stats.pools}`,
  ];
  for (const proxy of stats.proxies ?? []) {
    const target = isTunnelProxy(proxy)
      ? `туннель ${proxy.tunnel.interface}`
      : proxy.servers.length > 0
        ? proxy.servers.join(', ')
        : 'auto-select';
    lines.push(`  [${proxy.type.toUpperCase()}] ${proxy.tag} : port ${proxy.port} -> ${target}`);
  }
  const excluded = stats.excluded ?? [];
  if (excluded.length > 0) {
    lines.push(`Исключены из auto-select (${excluded.length}): ${excluded.join(', ')}`);
  }
  if (!stats.auto_count) {
    lines.push('Предупреждение: auto-select пуст (все серверы исключены).');
  }
  lines.push(...warnings);
  return lines.join('\n');
}

/**
 * Rejects a route name the schema would reject.
 *
 * @param {unknown} name
 * @param {string} what Human readable kind of the name, e.g. `маршрута`.
 */
export function assertUsableName(name, what) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new ConfigError(`имя ${what} не может быть пустым`);
  }
  if (DIGIT_ONLY_NAME.test(name)) {
    throw new ConfigError(
      `имя ${what} не может состоять только из цифр: JavaScript переставит такой ключ ` +
        `в начало файла и порядок в webui.json перестанет быть предсказуемым`,
    );
  }
}

/**
 * Derives a default FILE name from the human-readable tunnel name: only the
 * characters an interface may carry, clipped to the kernel limit of 15.
 *
 * It is a suggestion the owner edits: `hidemyname-AustriaGrazS4` becomes
 * `hidemyname-Aust`, which is valid but ugly on purpose — a silent truncation is
 * visible, and the field next to it is where the owner picks something readable.
 *
 * @param {string} label
 * @returns {string}
 */
function defaultInterfaceName(label) {
  const cleaned = String(label ?? '')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/\.conf$/i, '');
  const clipped = cleaned.slice(0, 15);
  return clipped.length > 0 ? clipped : 'awg0';
}

/**
 * Prefix of a server tag: its first whitespace-delimited word, which for the
 * provider files is the country flag (`🇷🇺`). This is what `exclude_from_auto`
 * matches with `startsWith`, in the generator and in the servers picker alike.
 *
 * @param {string} tag
 * @returns {string}
 */
export function tagPrefix(tag) {
  const text = String(tag ?? '').trim();
  if (text.length === 0) return '';
  const separator = text.search(/\s/);
  return separator < 0 ? text : text.slice(0, separator);
}

/**
 * The state of one open `webui.json`.
 */
export class ProjectModel {
  /**
   * @param {{path?: string|null, stateDir?: string, snapshotKeep?: number}} [options]
   *   `path` opens an existing file immediately; `stateDir` is where snapshots
   *   go, `.state` beside the project by default.
   */
  constructor(options = {}) {
    this.stateDir = options.stateDir ?? path.join(process.cwd(), DEFAULT_STATE_DIR);
    this.snapshotKeep = options.snapshotKeep ?? DEFAULT_SNAPSHOT_KEEP;
    /**
     * Fallback directory for the tunnel configs, used when the document carries
     * no `amnezia_dir`. The web layer passes `GATEHOUSE_AMNEZIA_DIR` here; empty
     * means "not configured" and a write is refused with a sentence instead of
     * touching a path nobody chose.
     *
     * @type {string}
     */
    this.defaultAmneziaDir = typeof options.amneziaDir === 'string' ? options.amneziaDir : '';
    this.path = null;
    this.document = newDocument();
    /**
     * Outcome of the last `open` that migrated a version-1 file: `null` when
     * nothing was migrated. The web layer shows the warnings once, so a silent
     * rewrite of the owner's file is impossible.
     *
     * @type {{snapshot: string|null, warnings: string[]}|null}
     */
    this.lastMigration = null;
    /**
     * Names of the fields of the removed Watchdog that were in the file at load
     * time. The web layer shows one line about them while they are still listed
     * here; a save clears the list, because after a save they are gone from the
     * file and the line would be a lie.
     *
     * @type {string[]}
     */
    this.lastRemoved = [];
    this.#dirty = false;
    if (options.path) this.open(options.path);
  }

  /** @type {boolean} */
  #dirty;

  /** True when the in-memory document differs from the file on disk. */
  get dirty() {
    return this.#dirty;
  }

  /**
   * The one line the editor shows about the fields of the removed Watchdog, or
   * `null` when the loaded file had none.
   *
   * It lives until a save on purpose: the fields are still in the file until then,
   * and the line says so. After a save the list is empty and the line is gone.
   *
   * @type {string|null}
   */
  get removedNotice() {
    return this.lastRemoved.length === 0 ? null : removedSettingsMessage(this.lastRemoved);
  }

  /** Marks the document as changed (reference: `mark_dirty`). */
  markDirty() {
    this.#dirty = true;
  }

  /** Marks the document as saved (reference: `mark_clean`). */
  markClean() {
    this.#dirty = false;
  }

  /** Reference: `display_name`. */
  get displayName() {
    return this.path ? path.basename(this.path) : 'webui.json (новый)';
  }

  /** Directory relative paths resolve against. Reference: `settings_dir`. */
  get settingsDir() {
    return this.path ? path.dirname(this.path) : process.cwd();
  }

  // ------------------------------------------------------------------
  // New / Open / Save  (reference: new / open / save)
  // ------------------------------------------------------------------

  /**
   * Replaces the document with a fresh minimal one and forgets the file.
   * Reference: `ProjectModel.new`.
   *
   * @param {string|null} [target] Optional path the new document is bound to.
   * @returns {Record<string, unknown>}
   */
  newProject(target = null) {
    this.document = newDocument();
    this.path = target ? path.resolve(target) : null;
    this.lastMigration = null;
    this.lastRemoved = [];
    this.markClean();
    return this.document;
  }

  /**
   * Loads `webui.json`. A version-1 file is migrated in place, once: the old
   * bytes are snapshotted first, then the flat document is written, and the
   * warnings are kept on `lastMigration` for the UI to show.
   *
   * Migration lives here and not in the core on purpose: the CLI path never
   * writes the owner's file, it only refuses it (see `validateSettings`), so a
   * half-migrated document can never reach a generated `config.json`.
   *
   * @param {string} target
   * @returns {Record<string, unknown>}
   */
  open(target) {
    const resolved = path.resolve(target);
    const raw = this.#readJson(resolved);

    if (isLegacyDocument(raw)) {
      const {document, warnings} = migrateLegacyDocument(raw, resolved);
      // A version-1 file kept the Watchdog fields per profile, so the migration
      // may carry them along: they are dropped from its RESULT as well.
      this.lastRemoved = dropRemovedSettings(document);
      validateSettings(document, resolved);
      const snapshot = takeSnapshot(resolved, this.stateDir, {keep: this.snapshotKeep});
      writeAtomic(resolved, canonicalJson(document));
      this.lastMigration = {
        snapshot: snapshot === null ? null : snapshot.path,
        warnings,
      };
      this.document = document;
    } else {
      // Dropped BEFORE validation, through the same function the core uses, so the
      // editor and `tools/generate.mjs` agree on what is stale. In place, and
      // without rewriting the file: the fields leave it on the next ordinary save.
      this.lastRemoved = dropRemovedSettings(raw);
      validateSettings(raw, resolved);
      this.document = raw;
      this.lastMigration = null;
    }

    this.path = resolved;
    this.markClean();
    return this.document;
  }

  /**
   * Re-reads the bound file, dropping every unsaved change. Reference: the
   * "reload" the Qt window offered through `open_path`.
   *
   * @returns {Record<string, unknown>}
   */
  reload() {
    if (this.path === null) throw new ConfigError('файл ещё не открыт: перезагружать нечего');
    return this.open(this.path);
  }

  /**
   * Writes the document: a snapshot of the previous version first, then an
   * atomic replace.
   *
   * The document is validated BEFORE anything is written, so a broken edit can
   * never produce a `webui.json` the tool itself would refuse to open.
   *
   * @returns {{path: string, snapshot: string|null, removed: string[]}}
   */
  save() {
    if (this.path === null) throw new ConfigError('не задан путь для сохранения webui.json');
    validateSettings(this.document, this.path);

    const snapshot = takeSnapshot(this.path, this.stateDir, {keep: this.snapshotKeep});
    writeAtomic(this.path, canonicalJson(this.document));
    // Whatever the Watchdog left behind is gone from the file now, so the line the
    // editor shows about it must go as well.
    this.lastRemoved = [];
    this.markClean();
    return {
      path: this.path,
      snapshot: snapshot === null ? null : snapshot.path,
      removed: snapshot === null ? [] : snapshot.removed,
    };
  }

  /**
   * The document as the canonical `webui.json` text. Kept next to `save` so a
   * test can compare bytes without touching the disk.
   *
   * @returns {string}
   */
  toText() {
    return canonicalJson(this.document);
  }

  /**
   * Puts the in-memory document back to a canonical text taken earlier with
   * `toText`, without touching the file. It is the rollback the web layer needs
   * when one edit form maps to several routes and a later route refuses: the
   * model works on the live document, so without this a half-applied panel would
   * stay in memory while the owner only sees the refusal.
   *
   * The text comes from `toText`, i.e. from a document that already passed
   * validation, so it is parsed and checked with the same loader `reload` uses.
   * The dirty flag is left alone on purpose: the caller knows whether there were
   * unsaved edits before and restores it, because "not dirty" and "dirty since
   * before" are two different states.
   *
   * @param {string} text Canonical text produced by `toText`.
   * @returns {void}
   */
  restoreText(text) {
    const data = JSON.parse(text);
    validateSettings(data, this.path ?? this.displayName);
    this.document = data;
  }

  // ------------------------------------------------------------------
  // Effective settings  (reference: output_file / listen_ip)
  // ------------------------------------------------------------------

  /**
   * The flat body of the document, without the format-only keys (`version`) and
   * without the comments (`note`). This is the shape the core works on.
   *
   * @returns {Record<string, unknown>}
   */
  body() {
    return this.document;
  }

  /** Provider folder names listed in the document. */
  sources() {
    return sourceNames(this.document.sources);
  }

  /** Reference: `output_file`. */
  get outputFile() {
    const value = this.document.output_file;
    return typeof value === 'string' && value.length > 0 ? value : DEFAULT_OUTPUT_FILE;
  }

  /** Reference: `listen_ip`. */
  get listenIp() {
    const value = this.document.listen_ip;
    return typeof value === 'string' && value.length > 0 ? value : DEFAULT_LISTEN_IP;
  }

  /**
   * True when the bound file is on disk. A document created by `newProject` is
   * not there yet, and the header says so instead of pretending it was saved.
   *
   * @returns {boolean}
   */
  get fileExists() {
    return this.path !== null && fs.existsSync(this.path);
  }

  /** Root the provider folders resolve against (`GATEHOUSE_SOURCES` or `<dir>/sources`). */
  resolvedSourcesRoot() {
    return resolveSourcesRoot(this.settingsDir);
  }

  /** Reference: `resolved_output_path`. */
  resolvedOutputPath() {
    return resolvePath(this.settingsDir, this.outputFile);
  }

  /**
   * Directory the applied tunnel configs go to, resolved: `amnezia_dir` of the
   * document first (a relative path resolves against the settings directory, like
   * `output_file`), then the fallback handed in by the web layer
   * (`GATEHOUSE_AMNEZIA_DIR`), then `/etc/amnezia/amneziawg`.
   *
   * ONE value for the whole editor on purpose: the write path, the delete path
   * and the start-up fuse of the system layer must look at the same directory, or
   * the fuse would judge a file nothing ever wrote.
   *
   * @returns {string}
   */
  get amneziaDir() {
    const value = this.document.amnezia_dir;
    if (typeof value === 'string' && value.length > 0) return resolvePath(this.settingsDir, value);
    if (this.defaultAmneziaDir.length > 0) return resolvePath(this.settingsDir, this.defaultAmneziaDir);
    return DEFAULT_AMNEZIA_DIR;
  }

  /**
   * Fills the fallback when the document carries no `amnezia_dir`. Called by the
   * web layer, which alone may read the environment.
   *
   * @param {string} value
   */
  setDefaultAmneziaDir(value) {
    if (typeof value === 'string' && value.length > 0 && this.defaultAmneziaDir.length === 0) {
      this.defaultAmneziaDir = value;
    }
  }

  /**
   * Writes `amnezia_dir` into the document. An empty value CLEARS the field, so
   * the path falls back to the environment instead of silently becoming the
   * process working directory.
   *
   * @param {unknown} value
   */
  setAmneziaDir(value) {
    const clean = String(value ?? '').trim();
    if (clean.length === 0) delete this.document.amnezia_dir;
    else this.document.amnezia_dir = clean;
    this.markDirty();
  }

  /**
   * What the Amnezia panel shows about the path: the raw field, the resolved
   * directory and where the value came from.
   *
   * @returns {{value: string, resolved: string, source: string, fallback: string}}
   */
  amneziaDirInfo() {
    const value = this.document.amnezia_dir;
    if (typeof value === 'string' && value.length > 0) {
      return {value, resolved: this.amneziaDir, source: 'документ', fallback: DEFAULT_AMNEZIA_DIR};
    }
    return {
      value: '',
      resolved: this.amneziaDir,
      source: this.defaultAmneziaDir.length > 0 ? 'GATEHOUSE_AMNEZIA_DIR' : 'умолчание',
      fallback: DEFAULT_AMNEZIA_DIR,
    };
  }

  /**
   * Rows of the Amnezia panel: one per marked tunnel, with its target path and
   * whether the file is on disk.
   *
   * @returns {Array<Record<string, unknown>>}
   */
  amneziaRows() {
    const dir = this.amneziaDir;
    return this.tunnels().map((entry) => {
      const iface = String(entry.interface);
      return {
        label: String(entry.name),
        interface: iface,
        provider: String(entry.provider),
        file: String(entry.file),
        path: tunnelConfigPath(dir, iface),
        applied: tunnelConfigApplied(dir, iface),
        policyRouting: entry.policy_routing === true,
      };
    });
  }

  /**
   * Re-normalises and rewrites every marked tunnel, in document order.
   *
   * The list is the document's `tunnels`, not the files on disk: a tunnel whose
   * source disappeared must be REPORTED, not silently dropped. One failure does
   * not stop the rest — the report carries a line per tunnel — and no unit is
   * started, because a rewrite is reversible and a start is not.
   *
   * @returns {{entries: Array<{label: string, interface: string, path: string|null,
   *   changed: boolean|null, error: string|null}>, changed: number, failed: number}}
   */
  regenerateTunnels() {
    const entries = [];
    let changed = 0;
    let failed = 0;

    for (const tunnel of this.tunnels()) {
      const label = String(tunnel.name);
      const iface = String(tunnel.interface);
      try {
        const {applied} = this.prepareTunnel(String(tunnel.provider), String(tunnel.file), {
          name: iface,
          label,
          policyRouting: tunnel.policy_routing === true,
        });
        entries.push({label, interface: iface, path: applied.path, changed: applied.changed, error: null});
        if (applied.changed) changed += 1;
      } catch (error) {
        entries.push({label, interface: iface, path: null, changed: null, error: error.message});
        failed += 1;
      }
    }
    return {entries, changed, failed};
  }

  /**
   * True when the generated `config.json` is on disk.
   *
   * The system layer checks the FILE, not the in-memory document, so the panel
   * has to say whether there is anything to check yet: on a fresh project the
   * honest answer is "generate first", not "check failed".
   *
   * @returns {boolean}
   */
  configExists() {
    return fs.existsSync(this.resolvedOutputPath());
  }

  /**
   * The effective settings with the format-only keys and the `note` fields
   * dropped — the exact shape `loadEffectiveSettings` of the core returns in its
   * `settings` property. The parity is asserted by a test, and duplicating six
   * lines here is cheaper than changing the accepted core.
   *
   * @returns {Record<string, unknown>}
   */
  effectiveSettings() {
    const settings = {};
    for (const [key, value] of Object.entries(this.document)) {
      if (key === 'version' || key === 'note') continue;
      settings[key] = value;
    }
    if (Array.isArray(settings.proxies)) {
      settings.proxies = settings.proxies.map((proxy) => {
        if (!isMapping(proxy) || !Object.hasOwn(proxy, 'note')) return proxy;
        const {note, ...rest} = proxy;
        return rest;
      });
    }
    return settings;
  }

  /**
   * Adds one provider folder to `sources`.
   *
   * The folder is NOT created on disk: `sources` is a configuration list, and the
   * tool does not write to the owner's data directories. A name that is already
   * listed is refused instead of duplicated, and an empty name is refused at all —
   * the panel offers the folders that really exist under the root, so a typo
   * cannot get in through the UI.
   *
   * @param {string} name
   * @returns {string[]} The new list.
   */
  addSource(name) {
    const clean = String(name ?? '').trim();
    if (clean.length === 0) throw new ConfigError('имя источника не может быть пустым');
    const names = this.sources();
    if (names.includes(clean)) throw new ConfigError(`источник '${clean}' уже указан в sources`);
    this.document.sources = [...names, clean];
    this.markDirty();
    return this.document.sources;
  }

  /**
   * Drops one provider folder from `sources`. The folder itself is left on disk:
   * removing an entry means "do not read it", never "delete the owner's files".
   * The list may become empty, which is a normal state the tree reports.
   *
   * @param {string} name
   * @returns {string[]} The new list.
   */
  removeSource(name) {
    const clean = String(name ?? '').trim();
    const names = this.sources();
    if (!names.includes(clean)) throw new ConfigError(`источник '${clean}' не указан в sources`);
    this.document.sources = names.filter((item) => item !== clean);
    this.markDirty();
    return this.document.sources;
  }

  /**
   * Folders that exist under the sources root but are not listed in `sources`.
   * This is what the "add" picker offers, so the owner never types a folder name.
   *
   * @returns {string[]} Sorted folder names.
   */
  availableSources() {
    const root = this.resolvedSourcesRoot();
    let entries;
    try {
      entries = fs.readdirSync(root, {withFileTypes: true});
    } catch {
      return [];
    }
    const listed = new Set(this.sources());
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !listed.has(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  /**
   * Reference: `set_output_file`.
   *
   * @param {string} value
   */
  setOutputFile(value) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new ConfigError('output_file должен быть непустой строкой');
    }
    this.document.output_file = value;
    this.markDirty();
  }

  /**
   * Sets the free-form comment of the document. It is the port of the comments
   * that used to live in settings.yaml, so it is editable like the one of a
   * proxy or a route.
   *
   * @param {string} value
   */
  setNote(value) {
    this.document.note = String(value ?? '');
    this.markDirty();
  }

  // ------------------------------------------------------------------
  // General settings
  // ------------------------------------------------------------------

  /**
   * Values of the "Общие" form. `urltest` is passed through `urltestBlock`, so
   * the form shows the url/interval/tolerance that will really end up in
   * `config.json`, not the raw fragment.
   *
   * @returns {Record<string, unknown>}
   */
  generalValues() {
    const body = this.document;
    const urltest = urltestBlock(body.urltest === undefined ? null : body.urltest);
    const log = isMapping(body.log) ? body.log : {};

    return {
      listen_ip:
        typeof body.listen_ip === 'string' && body.listen_ip.length > 0
          ? body.listen_ip
          : DEFAULT_LISTEN_IP,
      urltest,
      log: {
        level: typeof log.level === 'string' ? log.level : DEFAULT_LOG_LEVEL,
        timestamp: log.timestamp === undefined ? true : Boolean(log.timestamp),
      },
      exclude_from_auto: asList(body.exclude_from_auto),
    };
  }

  /**
   * The checkbox list of «исключить из автовыбора»: one row per flag prefix found
   * among the loaded servers, plus every stored prefix that matches no server now.
   *
   * `selected` is the EFFECTIVE value: an absent `exclude_from_auto` means the
   * core's default (`DEFAULT_EXCLUDE`), not an empty list, and showing it empty
   * would claim the generator sends 🇷🇺 to auto-select when it does not. Rows in
   * `unknown` are rendered checked for the same reason: a rule the owner wrote must
   * not disappear because the matching server is temporarily out of the file.
   *
   * @returns {{selected: string[], options: Array<{prefix: string, count: number}>,
   *   unknown: string[]}}
   */
  excludePrefixOptions() {
    const counts = new Map();
    for (const tag of this.sourcesInfo().tags) {
      const prefix = tagPrefix(tag);
      if (prefix.length === 0) continue;
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }

    const options = [...counts.entries()]
      .map(([prefix, count]) => ({prefix, count}))
      .sort((a, b) => a.prefix.localeCompare(b.prefix));

    const selected = Object.hasOwn(this.document, 'exclude_from_auto')
      ? asList(this.document.exclude_from_auto).map((item) => String(item))
      : [...DEFAULT_EXCLUDE];
    const known = new Set(counts.keys());

    return {selected, options, unknown: selected.filter((prefix) => !known.has(prefix))};
  }

  /**
   * Writes the "Общие" form into the document. Nested `urltest`/`log` are merged
   * field by field, in place, exactly like `apply_general` of the reference does
   * it with `_update_mapping`.
   *
   * @param {{listen_ip?: string, urltest?: Record<string, unknown>,
   *   log?: Record<string, unknown>, exclude_from_auto?: unknown[]}} values
   */
  applyGeneral(values = {}) {
    const body = this.document;
    if (values.listen_ip !== undefined) body.listen_ip = values.listen_ip;
    if (values.urltest !== undefined) this.#updateMapping(body, 'urltest', values.urltest);
    if (values.log !== undefined) this.#updateMapping(body, 'log', values.log);
    if (values.exclude_from_auto !== undefined) {
      body.exclude_from_auto = [...values.exclude_from_auto];
    }
    this.markDirty();
  }

  // ------------------------------------------------------------------
  // DNS  (a JSON text field on purpose: the schema moves too fast)
  // ------------------------------------------------------------------

  /**
   * The `dns` section as JSON text for the textarea.
   *
   * @returns {string}
   */
  dnsJson() {
    const dns = isMapping(this.document.dns) ? this.document.dns : {};
    return canonicalJson(dns);
  }

  /**
   * Parses the DNS textarea and stores it. Only "a valid JSON object" is
   * checked, as the task requires: structural forms for the 16 kinds of DNS
   * servers are deliberately not built.
   *
   * @param {string} text
   * @returns {Record<string, unknown>} The stored section.
   */
  applyDns(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new ConfigError(`dns: это не валидный JSON — ${error.message}`);
    }
    if (!isMapping(parsed)) {
      throw new ConfigError('dns: ожидается JSON-объект, например {"servers": [], "final": "dns-local"}');
    }

    this.document.dns = parsed;
    this.markDirty();
    return parsed;
  }

  // ------------------------------------------------------------------
  // proxies  (reference: the proxy CRUD of model.py)
  // ------------------------------------------------------------------

  /** Counterpart of the reference `proxies()`. */
  proxies() {
    const value = this.document.proxies;
    return Array.isArray(value) ? value : [];
  }

  /** Reference: `proxy_tags`. */
  proxyTags() {
    return this.proxies()
      .filter((proxy) => isMapping(proxy))
      .map((proxy) => proxy.tag);
  }

  /** Reference: `get_proxy`. */
  getProxy(tag) {
    return this.proxies().find((proxy) => isMapping(proxy) && proxy.tag === tag) ?? null;
  }

  /** Reference: `next_free_port`. */
  nextFreePort(start = DEFAULT_PROXY_PORT) {
    const used = new Set(this.proxies().filter(isMapping).map((proxy) => proxy.port));
    let port = start;
    while (used.has(port) && port < 65536) port += 1;
    return port;
  }

  /** Reference: `next_free_tag`. */
  nextFreeTag(base = DEFAULT_PROXY_TAG) {
    const tags = new Set(this.proxyTags());
    if (!tags.has(base)) return base;
    let n = 2;
    while (tags.has(`${base}-${n}`)) n += 1;
    return `${base}-${n}`;
  }

  /**
   * Checks a proxy against the OTHER proxies, through the core's
   * `validateProxies`, and returns the message the form should show.
   * Reference: `validate_proxy_candidate` of generator/validation.py — the rules
   * (unique tag, unique port, known type, port range) live only in the core.
   *
   * @param {Record<string, unknown>} candidate
   * @param {string|null} [currentTag] The proxy being edited, if any.
   * @returns {string|null} Error text, or null when the candidate is fine.
   */
  validateProxyCandidate(candidate, currentTag = null) {
    const entries = [];
    let replaced = false;
    for (const proxy of this.proxies()) {
      if (!isMapping(proxy)) continue;
      if (currentTag !== null && proxy.tag === currentTag) {
        entries.push(candidate);
        replaced = true;
      } else {
        entries.push(proxy);
      }
    }
    if (!replaced) entries.push(candidate);

    try {
      validateProxies(entries);
      return null;
    } catch (error) {
      if (error instanceof ConfigError) return error.message;
      throw error;
    }
  }

  /**
   * Adds a proxy, filling the free tag/port when they are not given.
   * Reference: `add_proxy`.
   *
   * @param {{tag?: string, type?: string, port?: number, servers?: unknown,
   *   note?: string}} [candidate]
   * @returns {Record<string, unknown>} The stored entry.
   */
  addProxy(candidate = {}) {
    const entry = this.#proxyEntry({
      tag: candidate.tag ?? this.nextFreeTag(),
      type: candidate.type ?? DEFAULT_PROXY_TYPE,
      port: candidate.port ?? this.nextFreePort(),
      servers: candidate.servers,
      tunnel: candidate.tunnel,
      note: candidate.note,
      pinned: candidate.pinned,
    });
    this.#assertPinned(entry);
    const error = this.validateProxyCandidate(entry, null);
    if (error !== null) throw new ConfigError(error);

    this.#ensureProxies().push(entry);
    this.markDirty();
    return entry;
  }

  /**
   * Replaces the proxy named `currentTag`, or appends a new one.
   * Reference: `upsert_proxy`.
   *
   * @param {{tag?: string, type?: string, port?: number, servers?: unknown,
   *   note?: string}} candidate
   * @param {string|null} [currentTag]
   * @returns {Record<string, unknown>} The stored entry.
   */
  upsertProxy(candidate, currentTag = null) {
    const entry = this.#proxyEntry(candidate);
    this.#assertPinned(entry);
    const error = this.validateProxyCandidate(entry, currentTag);
    if (error !== null) throw new ConfigError(error);

    const proxies = this.#ensureProxies();
    if (currentTag !== null) {
      const index = proxies.findIndex((proxy) => isMapping(proxy) && proxy.tag === currentTag);
      if (index >= 0) {
        proxies[index] = entry;
        this.markDirty();
        return entry;
      }
    }
    proxies.push(entry);
    this.markDirty();
    return entry;
  }

  /**
   * Reference: `remove_proxy`.
   *
   * @param {string} tag
   * @returns {boolean}
   */
  removeProxy(tag) {
    const proxies = this.#ensureProxies();
    const index = proxies.findIndex((proxy) => isMapping(proxy) && proxy.tag === tag);
    if (index < 0) return false;
    proxies.splice(index, 1);
    this.markDirty();
    return true;
  }

  /**
   * Reference: `rename_proxy`.
   *
   * @param {string} oldTag
   * @param {string} newTag
   * @returns {boolean}
   */
  renameProxy(oldTag, newTag) {
    if (!newTag || oldTag === newTag) return false;
    const proxy = this.getProxy(oldTag);
    if (proxy === null || this.getProxy(newTag) !== null) return false;
    proxy.tag = newTag;
    this.markDirty();
    return true;
  }

  // ------------------------------------------------------------------
  // routes  (reference: the route CRUD of model.py)
  // ------------------------------------------------------------------

  /** Reference: `routes()`. */
  routes() {
    const value = this.document.routes;
    return isMapping(value) ? value : {};
  }

  /** Reference: `route_names`. */
  routeNames() {
    return Object.keys(this.routes());
  }

  /** Reference: `get_route`. */
  getRoute(name) {
    return this.routes()[name] ?? null;
  }

  /** Reference: `next_free_route_name`. */
  nextFreeRouteName(base = DEFAULT_ROUTE_NAME) {
    const names = new Set(this.routeNames());
    if (!names.has(base)) return base;
    let n = 2;
    while (names.has(`${base}-${n}`)) n += 1;
    return `${base}-${n}`;
  }

  /**
   * Reference: `add_route`.
   *
   * @param {{name?: string, outbound?: string, domains?: unknown, note?: string}} [candidate]
   * @returns {{name: string, entry: Record<string, unknown>}}
   */
  addRoute(candidate = {}) {
    const name = candidate.name ?? this.nextFreeRouteName();
    assertUsableName(name, 'маршрута');
    const routes = this.#ensureRoutes();
    if (Object.hasOwn(routes, name)) {
      throw new ConfigError(`маршрут '${name}' уже есть`);
    }
    const entry = this.#routeEntry(candidate);
    routes[name] = entry;
    this.markDirty();
    return {name, entry};
  }

  /**
   * Replaces (or renames) a route. Reference: `upsert_route` — the map is
   * rebuilt in place so the order of the other routes does not move.
   *
   * @param {string} name
   * @param {{outbound?: string, domains?: unknown, note?: string}} data
   * @param {string|null} [currentName]
   * @returns {{name: string, entry: Record<string, unknown>}}
   */
  upsertRoute(name, data = {}, currentName = null) {
    assertUsableName(name, 'маршрута');
    const routes = this.#ensureRoutes();
    const entry = this.#routeEntry(data);

    if (currentName !== null && Object.hasOwn(routes, currentName)) {
      if (name !== currentName && Object.hasOwn(routes, name)) {
        throw new ConfigError(`маршрут '${name}' уже есть`);
      }
      const rebuilt = {};
      for (const [key, value] of Object.entries(routes)) {
        rebuilt[key === currentName ? name : key] = key === currentName ? entry : value;
      }
      this.document.routes = rebuilt;
      this.markDirty();
      return {name, entry};
    }

    routes[name] = entry;
    this.markDirty();
    return {name, entry};
  }

  /**
   * Reference: `remove_route`.
   *
   * @param {string} name
   * @returns {boolean}
   */
  removeRoute(name) {
    const routes = this.#ensureRoutes();
    if (!Object.hasOwn(routes, name)) return false;
    delete routes[name];
    this.markDirty();
    return true;
  }

  /**
   * Reference: `rename_route`.
   *
   * @param {string} oldName
   * @param {string} newName
   * @returns {boolean}
   */
  renameRoute(oldName, newName) {
    assertUsableName(newName, 'маршрута');
    const routes = this.#ensureRoutes();
    if (oldName === newName) return false;
    if (!Object.hasOwn(routes, oldName)) {
      throw new ConfigError(`маршрут '${oldName}' не найден`);
    }
    if (Object.hasOwn(routes, newName)) {
      throw new ConfigError(`маршрут '${newName}' уже есть`);
    }

    const rebuilt = {};
    for (const [key, value] of Object.entries(routes)) {
      rebuilt[key === oldName ? newName : key] = value;
    }
    this.document.routes = rebuilt;
    this.markDirty();
    return true;
  }

  // ------------------------------------------------------------------
  // Links file and stale references
  // ------------------------------------------------------------------

  /**
   * Reads every provider of the document and merges the links.
   *
   * The error is returned, not thrown: a missing or empty folder is a normal
   * state that the tree marks with an honest per-provider diagnosis. `tags` are
   * the merged outbound tags, carrying a provider label only on a name collision
   * between providers — which is what keeps a single-source project's
   * `config.json` byte-identical.
   *
   * @returns {{sources: string[], root: string, providers: Array<Record<string, unknown>>,
   *   outbounds: Array<Record<string, unknown>>, tags: string[], error: string|null,
   *   warnings: string[]}}
   */
  sourcesInfo() {
    const warnings = [];
    const root = this.resolvedSourcesRoot();
    const read = readSources(this.document.sources, root, warnings);
    const broken = read.providers.filter((provider) => provider.error !== null);

    return {
      sources: read.providers.map((provider) => provider.name),
      root,
      providers: read.providers,
      outbounds: read.outbounds,
      tags: read.tags,
      error: broken.length > 0 ? broken.map((provider) => provider.error).join('\n') : null,
      warnings,
    };
  }

  /**
   * Runs the tunnel normaliser over one `*.conf` of a provider, for the preview.
   *
   * It READS a file and changes nothing: no write to `/etc/amnezia/amneziawg/`, no
   * `awg-quick@`. Neither a WireGuard config nor an `.conf` file name carries the
   * two names the editor works with, so both are inputs: `label` is the
   * human-readable name (suggested as `<provider>-<file stem>`), `name` is the
   * file name of the applied config (suggested from the label, clipped to the
   * kernel limit). A marked tunnel supplies both from the document.
   *
   * @param {string} providerName
   * @param {string} fileName
   * @param {{name?: string, label?: string, policyRouting?: boolean}} [options]
   * @returns {Record<string, unknown>}
   */
  tunnelPreview(providerName, fileName, options = {}) {
    const provider = String(providerName ?? '').trim();
    const file = path.basename(String(fileName ?? '').trim());
    if (provider.length === 0 || file.length === 0) {
      throw new ConfigError('не указан источник или файл туннеля');
    }
    if (!this.sources().includes(provider)) {
      throw new ConfigError(`источник '${provider}' не указан в поле sources`);
    }
    if (path.extname(file) !== '.conf') {
      throw new ConfigError(`'${file}' не похож на конфиг туннеля (.conf)`);
    }

    const filePath = path.join(this.resolvedSourcesRoot(), provider, file);
    if (!fs.existsSync(filePath)) {
      throw new ConfigError(`файл туннеля ${filePath} не найден`);
    }

    const stored = this.getTunnel(provider, file);
    const requestedLabel = typeof options.label === 'string' ? options.label.trim() : '';
    const label =
      requestedLabel.length > 0
        ? requestedLabel
        : stored === null
          ? suggestTunnelName(provider, file)
          : stored.name;
    const requested = typeof options.name === 'string' ? options.name.trim() : '';
    const iface =
      requested.length > 0
        ? requested
        : stored === null
          ? defaultInterfaceName(label)
          : stored.interface;
    const policyRouting =
      options.policyRouting === undefined
        ? stored?.policy_routing === true
        : options.policyRouting === true;
    const result = normalizeTunnel(fs.readFileSync(filePath, 'utf8'), {
      name: iface,
      policyRouting,
    });

    const target = this.amneziaDir ? tunnelConfigPath(this.amneziaDir, result.name) : null;
    return {
      provider,
      file,
      path: filePath,
      // The human-readable name and the file name travel together: the preview
      // shows both, and the Providers form edits both.
      label,
      // Where the file is written and whether it is already there.
      target,
      applied: target !== null && fs.existsSync(target),
      policyRouting,
      // Whether the tunnel is marked «нужен» in the document.
      marked: stored !== null,
      ...result,
    };
  }

  /**
   * Applies the normalised config of one tunnel (part 1, §3): writes
   * `<amneziaDir>/<name>.conf` with mode 0600, taking a snapshot next to it only
   * when the bytes really change.
   *
   * The tunnel is NOT brought up here — that is the separate action of part 2.
   * Returns what the panel needs to say: the target, whether anything changed and
   * the name of the snapshot.
   *
   * @param {string} providerName
   * @param {string} fileName
   * @param {{name?: string, policyRouting?: boolean}} [options]
   * @returns {{name: string, path: string, changed: boolean, snapshot: string|null,
   *   removed: string[], preview: Record<string, unknown>}}
   */
  applyTunnel(providerName, fileName, options = {}) {
    if (this.amneziaDir.length === 0) {
      throw new ConfigError(
        'не задан каталог amnezia: укажите GATEHOUSE_AMNEZIA_DIR, иначе писать конфиг туннеля некуда',
      );
    }
    const preview = this.tunnelPreview(providerName, fileName, options);
    let result;
    try {
      result = applyTunnelConfig(preview.text, {name: preview.name, amneziaDir: this.amneziaDir});
    } catch (error) {
      throw new ConfigError(`не удалось записать конфиг туннеля: ${error.message}`);
    }
    return {...result, name: preview.name, preview};
  }

  // ------------------------------------------------------------------
  // Prepared tunnels (the «нужен» mark of the Providers panel)
  // ------------------------------------------------------------------
  //
  // A tunnel exists independently of a proxy: the owner marks a `.conf` as needed,
  // which normalises it, writes `<interface>.conf` into the amnezia directory and
  // records the entry below. The entry is what the proxy form chooses from and
  // what groups the System list; the FILE is the truth about what exists.

  /**
   * Prepared tunnels of the document, in document order.
   *
   * @returns {Array<Record<string, unknown>>}
   */
  tunnels() {
    const value = this.document.tunnels;
    return Array.isArray(value) ? value.filter((entry) => isMapping(entry)) : [];
  }

  /**
   * One prepared tunnel by its source, or `null`.
   *
   * @param {string} providerName
   * @param {string} fileName
   * @returns {Record<string, unknown>|null}
   */
  getTunnel(providerName, fileName) {
    const provider = String(providerName ?? '').trim();
    const file = path.basename(String(fileName ?? '').trim());
    return (
      this.tunnels().find((entry) => entry.provider === provider && entry.file === file) ?? null
    );
  }

  /**
   * One prepared tunnel by its file name — the identity of the unit, or `null`.
   *
   * @param {string} name
   * @returns {Record<string, unknown>|null}
   */
  getTunnelByInterface(name) {
    const iface = String(name ?? '').trim();
    return this.tunnels().find((entry) => entry.interface === iface) ?? null;
  }

  /**
   * Rows of the `.conf` list of one provider for the Providers panel: is the
   * tunnel marked, and which two names the form shows.
   *
   * @param {string} providerName
   * @returns {Array<{file: string, marked: boolean, applied: boolean, name: string,
   *   interface: string}>}
   */
  providerTunnelRows(providerName) {
    const provider = String(providerName ?? '').trim();
    const folder = this.sourcesInfo().providers.find((item) => item.name === provider);
    if (folder === undefined) return [];

    return (folder.entries ?? []).map((file) => {
      const stored = this.getTunnel(provider, file);
      if (stored !== null) {
        return {
          file,
          marked: true,
          applied: tunnelConfigApplied(this.amneziaDir, stored.interface),
          name: stored.name,
          interface: stored.interface,
        };
      }
      const name = suggestTunnelName(provider, file);
      return {file, marked: false, applied: false, name, interface: defaultInterfaceName(name)};
    });
  }

  /**
   * Ticks a tunnel «нужен»: validates both names, normalises the source config,
   * writes `<interface>.conf` into the amnezia directory and records the entry.
   *
   * The tunnel is NOT started here — that is the lifecycle action of the System
   * panel. Everything is checked BEFORE anything is written: a long file name, a
   * name already taken, a foreign file in the target path or a normalised text
   * without `Table = off` are all refusals, never a partial write.
   *
   * @param {string} providerName
   * @param {string} fileName
   * @param {{name?: unknown, label?: unknown, policyRouting?: boolean}} [options]
   * @returns {{entry: Record<string, unknown>, applied: Record<string, unknown>}}
   */
  prepareTunnel(providerName, fileName, options = {}) {
    if (this.amneziaDir.length === 0) {
      throw new ConfigError(
        'не задан каталог amnezia: укажите GATEHOUSE_AMNEZIA_DIR, иначе писать конфиг туннеля некуда',
      );
    }
    const provider = String(providerName ?? '').trim();
    const file = path.basename(String(fileName ?? '').trim());
    const stored = this.getTunnel(provider, file);

    const labelInput = String(options.label ?? '').trim();
    const label = validateTunnelLabel(
      labelInput.length > 0
        ? labelInput
        : stored === null
          ? suggestTunnelName(provider, file)
          : stored.name,
    );
    const nameInput = String(options.name ?? '').trim();
    const iface = validateInterfaceName(
      nameInput.length > 0
        ? nameInput
        : stored === null
          ? defaultInterfaceName(label)
          : stored.interface,
    );

    // The file name is the identity of the unit: two tunnels cannot share it.
    for (const entry of this.tunnels()) {
      if (entry.provider === provider && entry.file === file) continue;
      if (entry.interface === iface) {
        throw new ConfigError(
          `имя файла '${iface}' уже занято туннелем '${entry.name}' (${entry.provider}/${entry.file})`,
        );
      }
    }

    // A file with this name that belongs to nobody is refused rather than
    // overwritten: the owner may have put it there by hand on purpose.
    const target = tunnelConfigPath(this.amneziaDir, iface);
    if (fs.existsSync(target) && (stored === null || stored.interface !== iface)) {
      throw new ConfigError(
        `файл ${target} уже есть в каталоге amnezia и не принадлежит этому туннелю: ` +
          'выберите другое имя файла',
      );
    }

    const policyRouting =
      options.policyRouting === undefined
        ? stored?.policy_routing === true
        : options.policyRouting === true;

    // The invariant of §A.4 checked at the only moment it can be: the normalised
    // text goes to disk only if it passes the same fuse that will later guard the
    // start of the unit. A normaliser that accepted something the fuse refuses
    // cannot write that file — and the refusal says which reason fired.
    const preview = this.tunnelPreview(provider, file, {name: iface, label, policyRouting});
    const refusal = tunnelConfigRefusal(preview.text);
    if (refusal !== null) {
      throw new ConfigError(
        `нормализованный конфиг туннеля '${label}' не проходит предохранитель ` +
          `(${refusal.code}${refusal.line === null ? '' : `: ${refusal.line}`}): ` +
          'записывать его нельзя',
      );
    }

    const applied = this.applyTunnel(provider, file, {name: iface, label, policyRouting});

    const entry = {provider, file, name: label, interface: iface};
    if (policyRouting) entry.policy_routing = true;
    this.#storeTunnel(entry);
    return {entry, applied};
  }

  /**
   * Un-ticks a tunnel: drops the entry and removes `<interface>.conf`.
   *
   * The unit must already be down — stopping it needs sudo and therefore lives in
   * the web layer, which calls this only after a successful `disable --now`. A
   * tunnel still used by a proxy is refused: deleting the file would leave that
   * proxy on an interface nobody provides. Snapshots are left alone.
   *
   * @param {string} providerName
   * @param {string} fileName
   * @returns {{entry: Record<string, unknown>, removed: boolean}}
   */
  unprepareTunnel(providerName, fileName) {
    const provider = String(providerName ?? '').trim();
    const file = path.basename(String(fileName ?? '').trim());
    const entry = this.getTunnel(provider, file);
    if (entry === null) throw new ConfigError(`туннель '${provider}/${file}' не отмечен`);

    const users = this.tunnelProxies()
      .filter((tunnel) => tunnel.provider === provider && tunnel.file === file)
      .map((tunnel) => tunnel.tag);
    if (users.length > 0) {
      throw new ConfigError(
        `туннель '${entry.name}' используют прокси (${users.join(', ')}): сначала удалите их`,
      );
    }

    const removed =
      this.amneziaDir.length > 0
        ? removeTunnelConfig(this.amneziaDir, String(entry.interface))
        : false;
    this.document.tunnels = this.tunnels().filter(
      (item) => !(item.provider === provider && item.file === file),
    );
    if (this.document.tunnels.length === 0) delete this.document.tunnels;
    this.markDirty();
    return {entry, removed};
  }

  /**
   * Tunnels the document knows about: proxies carrying a `tunnel` descriptor.
   *
   * @returns {Array<{tag: string, type: string, port: number, provider: string,
   *   file: string, interface: string}>}
   */
  tunnelProxies() {
    return this.proxies()
      .filter((proxy) => isMapping(proxy) && isMapping(proxy.tunnel))
      .map((proxy) => ({
        tag: proxy.tag,
        type: proxy.type,
        port: proxy.port,
        provider: proxy.tunnel.provider,
        file: proxy.tunnel.file,
        interface: proxy.tunnel.interface,
      }));
  }

  /**
   * `interface -> [proxy tags]` for the restart confirmation: it has to name the
   * proxies that stop working, not just say "connections will drop".
   *
   * @returns {Map<string, string[]>}
   */
  tunnelUsage() {
    const usage = new Map();
    for (const tunnel of this.tunnelProxies()) {
      const list = usage.get(tunnel.interface) ?? [];
      list.push(tunnel.tag);
      usage.set(tunnel.interface, list);
    }
    return usage;
  }

  /**
   * Every tunnel the System panel shows: the prepared entries of the document
   * plus `.conf` files found in the amnezia directory that no entry claims.
   *
   * The FILES are the truth about what exists (§3.2): a config dropped in by hand
   * is listed too, under an empty provider, so it can be seen, stopped and
   * restarted. Snapshots do not end with `.conf` and file names that are not valid
   * interfaces (`de.conf.conf`) are skipped — those are the leftovers of §2.4.
   *
   * @returns {Array<{provider: string, file: string|null, name: string,
   *   interface: string, applied: boolean}>}
   */
  tunnelInventory() {
    /** @type {Map<string, Record<string, unknown>>} */
    const rows = new Map();
    for (const entry of this.tunnels()) {
      rows.set(String(entry.interface), {
        provider: String(entry.provider),
        file: String(entry.file),
        name: String(entry.name),
        interface: String(entry.interface),
        applied: tunnelConfigApplied(this.amneziaDir, String(entry.interface)),
      });
    }

    // A proxy of an older document may name an interface nothing else knows about
    // yet: it is listed too, so the mark can be set and the unit managed.
    for (const proxy of this.tunnelProxies()) {
      const iface = String(proxy.interface);
      if (rows.has(iface)) continue;
      rows.set(iface, {
        provider: String(proxy.provider),
        file: String(proxy.file),
        name: suggestTunnelName(proxy.provider, proxy.file),
        interface: iface,
        applied: tunnelConfigApplied(this.amneziaDir, iface),
      });
    }

    if (this.amneziaDir.length > 0) {
      for (const fileName of listTunnelConfigNames(this.amneziaDir)) {
        const iface = fileName.slice(0, -'.conf'.length);
        if (rows.has(iface)) continue;
        try {
          validateInterfaceName(iface);
        } catch {
          continue; // `de.conf.conf` and the like are leftovers, not tunnels
        }
        rows.set(iface, {provider: '', file: null, name: '', interface: iface, applied: true});
      }
    }
    return [...rows.values()];
  }

  /**
   * The inventory grouped by provider; a file no entry claims lands in
   * «вне источников».
   *
   * @returns {Array<{provider: string, tunnels: Array<Record<string, unknown>>}>}
   */
  tunnelGroups() {
    const standalone = 'вне источников';
    const groups = new Map();
    for (const row of this.tunnelInventory()) {
      const key = row.provider.length > 0 ? row.provider : standalone;
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => (a === standalone ? 1 : b === standalone ? -1 : a.localeCompare(b)))
      .map(([provider, tunnels]) => ({provider, tunnels}));
  }

  /**
   * Prepared tunnels offered to the proxy form: only the ones the owner marked
   * «нужен» (§3.2), so the form can never bind a proxy to a file nothing provides.
   *
   * @returns {Array<{provider: string, file: string, name: string, interface: string}>}
   */
  availableTunnels() {
    return this.tunnels()
      .filter((entry) => tunnelConfigApplied(this.amneziaDir, String(entry.interface)))
      .map((entry) => ({
        provider: String(entry.provider),
        file: String(entry.file),
        name: String(entry.name),
        interface: String(entry.interface),
      }));
  }

  /** Reference: `load_server_tags`, reduced to what most callers need. */
  loadServerTags() {
    const info = this.sourcesInfo();
    return {tags: info.tags, error: info.error};
  }

  /**
   * `{section, name} -> [stale tags]` for the document.
   * Reference: `stale_map`.
   *
   * @returns {Map<string, string[]>}
   */
  staleMap() {
    return staleMap(this.document, this.loadServerTags().tags);
  }

  /**
   * Tree of the project, as plain data.
   * Reference: `tree_spec`.
   *
   * @returns {Record<string, unknown>}
   */
  treeSpec(options = {}) {
    const info = this.sourcesInfo();
    return buildTree({
      document: this.document,
      allTags: info.tags,
      title: this.displayName,
      sourcesRoot: info.root,
      providers: info.providers,
      outputFile: this.outputFile,
      // Runtime tunnel states, handed in by the web layer. Absent means "not
      // asked", and then no proxy gets a tunnel mark.
      tunnelStates: options.tunnelStates ?? {},
    });
  }

  // ------------------------------------------------------------------
  // Generation
  // ------------------------------------------------------------------

  /**
   * Generates `config.json` by calling the core on the SAVED file: unsaved edits
   * are not silently included, `wasDirty` tells the UI to say so.
   *
   * @param {{output?: string, links?: string, listenIp?: string,
   *   excludeFromAuto?: unknown[], runningTunnels?: string[]}} [options]
   *   `runningTunnels` is the set of tunnel interfaces the caller found up in
   *   systemd; it only feeds the §5.4 warning.
   * @returns {{outputFile: string, stats: Record<string, unknown>, warnings: string[],
   *   config: Record<string, unknown>, summary: string, wasDirty: boolean}}
   */
  generate(options = {}) {
    if (this.path === null) {
      throw new ConfigError('сначала сохраните webui.json: генерация запускается по файлу');
    }
    const wasDirty = this.dirty;
    const result = generateConfigFile(this.path, options);
    return {
      ...result,
      summary: formatStats(result.outputFile, result.stats, result.warnings),
      wasDirty,
    };
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /**
   * Reads and parses a JSON file, with the wording of the core.
   *
   * @param {string} resolved
   * @returns {unknown}
   */
  #readJson(resolved) {
    let text;
    try {
      text = fs.readFileSync(resolved, 'utf8');
    } catch (error) {
      throw new ConfigError(`ошибка чтения JSON ${resolved}: ${error.message}`);
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new ConfigError(`ошибка чтения JSON ${resolved}: ${error.message}`);
    }
  }

  /** @returns {unknown[]} */
  #ensureProxies() {
    if (!Array.isArray(this.document.proxies)) this.document.proxies = [];
    return this.document.proxies;
  }

  /** @returns {Record<string, unknown>} */
  #ensureRoutes() {
    if (!isMapping(this.document.routes)) this.document.routes = {};
    return this.document.routes;
  }

  /** @returns {unknown[]} */
  #ensureTunnels() {
    if (!Array.isArray(this.document.tunnels)) this.document.tunnels = [];
    return this.document.tunnels;
  }

  /**
   * Stores one prepared tunnel, replacing the entry with the same source, and
   * keeps every proxy that uses it pointed at the current file name.
   *
   * @param {Record<string, unknown>} entry
   */
  #storeTunnel(entry) {
    const list = this.#ensureTunnels();
    const index = list.findIndex(
      (item) => isMapping(item) && item.provider === entry.provider && item.file === entry.file,
    );
    const previous = index < 0 ? null : list[index];
    if (index < 0) list.push(entry);
    else list[index] = entry;

    let retargeted = false;
    if (previous !== null && previous.interface !== entry.interface) {
      for (const proxy of this.#ensureProxies()) {
        if (!isMapping(proxy) || !isMapping(proxy.tunnel)) continue;
        if (proxy.tunnel.provider === entry.provider && proxy.tunnel.file === entry.file) {
          proxy.tunnel = {...proxy.tunnel, interface: entry.interface};
          retargeted = true;
        }
      }
    }

    // A regeneration that found the entry already correct must not mark the
    // document dirty: the FILE may have been rewritten while the model did not
    // change, and the header would then ask to save nothing.
    if (index < 0 || canonicalJson(previous) !== canonicalJson(entry) || retargeted) {
      this.markDirty();
    }
  }

  /**
   * Normalises a proxy into the shape the core expects: `servers`, `note` and
   * `pinned` are only written when they carry something, which keeps `webui.json`
   * free of empty noise and keeps an untouched save a no-op. Reference:
   * `upsert_proxy` (`pinned` is editor-only and never reaches `config.json` —
   * `validateProxies` of the core drops it).
   *
   * @param {{tag?: unknown, type?: unknown, port?: unknown, servers?: unknown,
   *   tunnel?: unknown, note?: unknown, pinned?: unknown}} candidate
   * @returns {Record<string, unknown>}
   */
  #proxyEntry(candidate) {
    const entry = {tag: candidate.tag, type: candidate.type, port: candidate.port};
    const servers = asList(candidate.servers).filter(
      (server) => typeof server === 'string' && server.length > 0,
    );

    // A tunnel proxy owns no server list: its single exit is the interface. The
    // refusal protects the same thing the pinned flag does — an exit that must not
    // silently become a pool.
    if (isMapping(candidate.tunnel)) {
      const provider = String(candidate.tunnel.provider ?? '').trim();
      const file = String(candidate.tunnel.file ?? '').trim();
      const prepared = this.getTunnel(provider, file);
      if (prepared === null) {
        throw new ConfigError(
          `туннель '${provider}/${file}' не подготовлен: отметьте его в «Провайдерах»`,
        );
      }
      const requested = String(candidate.tunnel.interface ?? '').trim();
      if (requested.length > 0 && requested !== prepared.interface) {
        throw new ConfigError(
          `туннель '${provider}/${file}' записан как '${prepared.interface}', а не '${requested}'`,
        );
      }
      if (servers.length > 0) throw new ConfigError(TUNNEL_WITH_SERVERS_REFUSAL);
      entry.tunnel = {provider, file, interface: String(prepared.interface)};
    } else if (servers.length > 0) {
      entry.servers = servers;
    }

    if (typeof candidate.note === 'string' && candidate.note.length > 0) {
      entry.note = candidate.note;
    }
    if (candidate.pinned === true) entry.pinned = true;
    return entry;
  }

  /**
   * Refuses a pinned proxy that would end up with a pool.
   *
   * This is the first part of the task and it is deliberately NOT in the core: the
   * core is a port of the Python reference and has to stay byte-compatible. The
   * flag protects against the owner's own future slip, and this is where the slip
   * is caught — before anything is stored, and with the same wording whatever form
   * it came from ("save with two servers" and "tick the flag on a pool").
   *
   * @param {Record<string, unknown>} entry
   */
  #assertPinned(entry) {
    if (entry.pinned !== true) return;
    const servers = Array.isArray(entry.servers) ? entry.servers : [];
    if (servers.length > 1) throw new ConfigError(PINNED_REFUSAL);
  }

  /**
   * Reference: `upsert_route` — `domains` is written only when non-empty, so an
   * empty form field does not add `"domains": []` to the file.
   *
   * @param {{outbound?: unknown, domains?: unknown, note?: unknown}} data
   * @returns {Record<string, unknown>}
   */
  #routeEntry(data) {
    const entry = {
      outbound:
        typeof data.outbound === 'string' && data.outbound.length > 0
          ? data.outbound
          : 'auto-select',
    };
    const domains = asList(data.domains).filter(
      (domain) => typeof domain === 'string' && domain.length > 0,
    );
    if (domains.length > 0) entry.domains = domains;
    if (typeof data.note === 'string' && data.note.length > 0) entry.note = data.note;
    return entry;
  }

  /**
   * Merges a nested block field by field, keeping unknown fields. Reference:
   * `_update_mapping`.
   *
   * @param {Record<string, unknown>} body
   * @param {string} key
   * @param {Record<string, unknown>} values
   */
  #updateMapping(body, key, values) {
    requireMapping(values, key);
    if (!isMapping(body[key])) body[key] = {};
    for (const [field, value] of Object.entries(values)) {
      body[key][field] = value;
    }
  }
}

export {PROXY_TYPES};

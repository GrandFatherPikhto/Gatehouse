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
  generateConfigFile,
  isLegacyDocument,
  resolvePath,
  validateSettings,
} from '../core/settings.mjs';
import {asList, requireMapping, urltestBlock, validateProxies} from '../core/validate.mjs';
import {parseLinks} from '../core/vless.mjs';
import {normalizeClashApi, normalizeProxy, normalizeWatchdog} from '../watchdog/watchdog.mjs';
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
export const DEFAULT_LINKS_FILE = 'links.txt';
export const DEFAULT_OUTPUT_FILE = 'config.json';
export const DEFAULT_URLTEST_URL = 'https://gstatic.com';
export const DEFAULT_URLTEST_INTERVAL = '3m';
export const DEFAULT_URLTEST_TOLERANCE = 50;
export const DEFAULT_LOG_LEVEL = 'info';

/* Defaults of the web editor itself. */
export const DEFAULT_PROXY_PORT = 54321;
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
    links_file: DEFAULT_LINKS_FILE,
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
 * Flattens a version-1 document (the `defaults`/`profiles`/`active` envelope)
 * into the version-2 shape.
 *
 * The migration is deliberately narrow, because it runs once, on one known file:
 *   * more than one profile is NOT guessed — the owner picked which one is
 *     active for a reason and dropping the others silently could throw away
 *     real settings, so the file is refused with the names in the message;
 *   * a single profile body is spread onto the top level;
 *   * a non-empty `defaults` is merged underneath it (the profile is stronger,
 *     top level only, exactly like the old core merge) with one warning per
 *     migrated key, so the owner can see what moved.
 *
 * @param {Record<string, unknown>} data Parsed version-1 document.
 * @param {string} [source] File name used in the messages.
 * @returns {{document: Record<string, unknown>, warnings: string[]}}
 */
export function migrateLegacyDocument(data, source = 'webui.json') {
  const profiles = isMapping(data.profiles) ? data.profiles : {};
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
  const warnings = [];

  for (const key of Object.keys(defaults)) {
    if (Object.hasOwn(body, key)) {
      warnings.push(
        `Предупреждение: ключ '${key}' из defaults перекрыт значением профиля '${name}' и не перенесён`,
      );
    } else {
      warnings.push(`Предупреждение: ключ '${key}' из defaults перенесён на верхний уровень`);
    }
  }

  const merged = {...defaults, ...body};
  delete merged.profiles;
  delete merged.defaults;
  delete merged.active;

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
    const servers = proxy.servers.length > 0 ? proxy.servers.join(', ') : 'auto-select';
    lines.push(`  [${proxy.type.toUpperCase()}] ${proxy.tag} : port ${proxy.port} -> ${servers}`);
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
    this.#dirty = false;
    if (options.path) this.open(options.path);
  }

  /** @type {boolean} */
  #dirty;

  /** True when the in-memory document differs from the file on disk. */
  get dirty() {
    return this.#dirty;
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
      validateSettings(document, resolved);
      const snapshot = takeSnapshot(resolved, this.stateDir, {keep: this.snapshotKeep});
      writeAtomic(resolved, canonicalJson(document));
      this.lastMigration = {
        snapshot: snapshot === null ? null : snapshot.path,
        warnings,
      };
      this.document = document;
    } else {
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
  // Effective settings  (reference: links_file / output_file / listen_ip)
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

  /** Reference: `links_file`. */
  get linksFile() {
    const value = this.document.links_file;
    return typeof value === 'string' && value.length > 0 ? value : DEFAULT_LINKS_FILE;
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

  /** Reference: `resolved_links_path`. */
  resolvedLinksPath() {
    return resolvePath(this.settingsDir, this.linksFile);
  }

  /** Reference: `resolved_output_path`. */
  resolvedOutputPath() {
    return resolvePath(this.settingsDir, this.outputFile);
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
   * Reference: `set_links_file`.
   *
   * @param {string} value
   */
  setLinksFile(value) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new ConfigError('links_file должен быть непустой строкой');
    }
    this.document.links_file = value;
    this.markDirty();
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
  // Watchdog and the external API of the daemon
  //
  // Both sections are ordinary settings of the document: the owner edits them
  // through a form, and the watchdog process only ever READS them. That is the
  // point of the rule — a watchdog that cannot write the config cannot move a
  // pinned exit, whatever it decides to do at night.
  // ------------------------------------------------------------------

  /**
   * The `watchdog` section with every default filled in.
   *
   * @returns {Record<string, unknown>}
   */
  watchdogValues() {
    return normalizeWatchdog(this.document.watchdog);
  }

  /**
   * Writes the watchdog form into the document, field by field.
   *
   * @param {{enabled?: boolean, interval_seconds?: number, failures_before_action?: number,
   *   pause_seconds?: number, max_restarts_per_day?: number, restart_enabled?: boolean}} values
   */
  applyWatchdog(values = {}) {
    if (!isMapping(this.document.watchdog)) this.document.watchdog = {};
    const body = this.document.watchdog;
    for (const key of Object.keys(values)) {
      if (values[key] !== undefined) body[key] = values[key];
    }
    this.markDirty();
  }

  /**
   * The `clash_api` section with every default filled in.
   *
   * @returns {Record<string, unknown>}
   */
  clashApiValues() {
    return normalizeClashApi(this.document.clash_api);
  }

  /**
   * Writes the API form into the document. The SECRET is deliberately not a
   * field here: it comes from `GATEHOUSE_API_SECRET` and never lands in
   * `webui.json`, its snapshots or a backup.
   *
   * @param {{enabled?: boolean, controller?: string}} values
   */
  applyClashApi(values = {}) {
    if (!isMapping(this.document.clash_api)) this.document.clash_api = {};
    const body = this.document.clash_api;
    for (const key of Object.keys(values)) {
      if (values[key] !== undefined) body[key] = values[key];
    }
    this.markDirty();
  }

  /**
   * Every proxy of the document in the shape the watchdog uses.
   *
   * @returns {Array<Record<string, unknown>>}
   */
  watchedProxies() {
    return this.proxies()
      .filter((proxy) => isMapping(proxy))
      .map((proxy) => normalizeProxy(proxy));
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
      note: candidate.note,
      pinned: candidate.pinned,
      watch: candidate.watch,
      watch_url: candidate.watch_url,
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
   * Reads the links file of the document.
   * Reference: `load_server_tags` — the error is returned, not thrown, because a
   * missing links file is a normal state of a fresh project.
   *
   * `state` is the honest classification of WHY there are no tags, and it is what
   * the tree turns into one of the four diagnoses of the task: a missing file, an
   * unreadable one, an empty one, or a read file that simply does not list some
   * names. "The file was not read" and "the servers disappeared" are different
   * news, and the tree says which one it is instead of guessing from an empty
   * list.
   *
   * @returns {{file: string, path: string, exists: boolean,
   *   state: 'ok'|'missing'|'unreadable'|'empty', tags: string[],
   *   error: string|null, warnings: string[]}}
   */
  linksInfo() {
    const file = this.linksFile;
    const resolved = this.resolvedLinksPath();
    const warnings = [];

    if (!fs.existsSync(resolved)) {
      return {
        file,
        path: resolved,
        exists: false,
        state: 'missing',
        tags: [],
        error: `файл ссылок ${resolved} не найден`,
        warnings,
      };
    }

    try {
      fs.accessSync(resolved, fs.constants.R_OK);
    } catch {
      return {
        file,
        path: resolved,
        exists: true,
        state: 'unreadable',
        tags: [],
        error: `файл ссылок ${resolved} недоступен для чтения`,
        warnings,
      };
    }

    try {
      const outbounds = parseLinks(resolved, warnings);
      return {
        file,
        path: resolved,
        exists: true,
        state: 'ok',
        tags: outbounds.map((outbound) => outbound.tag),
        error: null,
        warnings,
      };
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      const empty = /валидных VLESS-ссылок не обнаружено/.test(error.message);
      return {
        file,
        path: resolved,
        exists: true,
        state: empty ? 'empty' : 'unreadable',
        tags: [],
        error: error.message,
        warnings,
      };
    }
  }

  /** Reference: `load_server_tags`, reduced to what most callers need. */
  loadServerTags() {
    const info = this.linksInfo();
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
  treeSpec() {
    const info = this.linksInfo();
    return buildTree({
      document: this.document,
      allTags: info.tags,
      title: this.displayName,
      linksFile: info.file,
      linksPath: info.path,
      linksState: info.state,
      linksError: info.error,
      outputFile: this.outputFile,
    });
  }

  // ------------------------------------------------------------------
  // Generation
  // ------------------------------------------------------------------

  /**
   * Generates `config.json` by calling the core on the SAVED file: unsaved edits
   * are not silently included, `wasDirty` tells the UI to say so.
   *
   * @param {{output?: string, links?: string, listenIp?: string, excludeFromAuto?: unknown[]}} [options]
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

  /**
   * Normalises a proxy into the shape the core expects: `servers`, `note`,
   * `pinned`, `watch` and `watch_url` are only written when they carry something,
   * which keeps `webui.json` free of empty noise and keeps an untouched save a
   * no-op. Reference: `upsert_proxy` (the three new keys are editor-only and never
   * reach `config.json` — `validateProxies` of the core drops them).
   *
   * @param {{tag?: unknown, type?: unknown, port?: unknown, servers?: unknown,
   *   note?: unknown, pinned?: unknown, watch?: unknown, watch_url?: unknown}} candidate
   * @returns {Record<string, unknown>}
   */
  #proxyEntry(candidate) {
    const entry = {tag: candidate.tag, type: candidate.type, port: candidate.port};
    const servers = asList(candidate.servers).filter(
      (server) => typeof server === 'string' && server.length > 0,
    );
    if (servers.length > 0) entry.servers = servers;
    if (typeof candidate.note === 'string' && candidate.note.length > 0) {
      entry.note = candidate.note;
    }
    if (candidate.pinned === true) entry.pinned = true;
    if (candidate.watch === true) entry.watch = true;
    if (typeof candidate.watch_url === 'string' && candidate.watch_url.length > 0) {
      entry.watch_url = candidate.watch_url;
    }
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

// Server-side state of the web editor: one open `webui.json`.
//
// Behavioural reference:
// /home/yevstigneyevda/Projects/Python/SingBoxTools/generator/model.py — the
// dirty flag, open/save/new, the proxy and route CRUD, `load_server_tags`,
// `stale_refs`/`stale_map`, `tree_spec` and `format_stats` are ported from there
// by sense, with the exact rules taken from that file.
//
// New here, because the Qt version predates profiles: the profile list with
// create/rename/remove/duplicate, switching `active`, and the split of the
// shared settings between `defaults` and the active profile.
//
// The module knows nothing about HTTP: routes parse a request, call a method and
// hand the result to a template. That keeps the model testable without a server
// (as `model.py` was testable without qtbot) and keeps a future switch to a
// React front end from touching anything but the view layer.
//
// Two rules are worth stating up front, because everything else follows from
// them:
//
//   * a form edits the ACTIVE profile, and a field that the active profile does
//     not carry is inherited from `defaults` (top level only, exactly like the
//     merge of the core);
//   * user-facing rejections throw `ConfigError` with a Russian message, which
//     is what the form shows to the owner. There is no silent clamping anywhere.

import fs from 'node:fs';
import path from 'node:path';

import {ConfigError, DEFAULT_EXCLUDE, PROXY_TYPES, isMapping} from '../core/errors.mjs';
import {generateConfigFile, loadSettings, resolvePath, validateSettings} from '../core/settings.mjs';
import {asList, requireMapping, urltestBlock, validateProxies} from '../core/validate.mjs';
import {parseLinks} from '../core/vless.mjs';
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
export const DEFAULT_PROFILE_NAME = 'profile';
export const DEFAULT_PROFILE_SUFFIX = '-copy';

/**
 * Keys that only ever live in a profile: they are not shared by definition.
 * Everything outside this list and SHARED_KEYS is not editable in the web UI.
 */
export const PROFILE_ONLY_KEYS = Object.freeze([
  'links_file',
  'output_file',
  'proxies',
  'routes',
  'note',
]);

/**
 * Keys that may live in `defaults` and be overridden by a profile. This is the
 * list the "Значения по умолчанию" form is allowed to write.
 */
export const SHARED_KEYS = Object.freeze([
  'listen_ip',
  'log',
  'urltest',
  'dns',
  'exclude_from_auto',
]);

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
 * Builds a fresh, minimal document — the port of `NEW_SETTINGS_TEMPLATE` of the
 * reference, with the profiles envelope around it.
 *
 * @param {string} [profileName]
 * @returns {Record<string, unknown>}
 */
export function newDocument(profileName = 'default') {
  return {
    version: 1,
    active: profileName,
    defaults: {},
    profiles: {
      [profileName]: {
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
      },
    },
  };
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
 * Rejects a profile or route name the schema would reject.
 *
 * @param {unknown} name
 * @param {string} what Human readable kind of the name, e.g. `профиля`.
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
    this.markClean();
    return this.document;
  }

  /**
   * Loads and validates `webui.json`, exactly like the core does it.
   * Reference: `ProjectModel.open`.
   *
   * @param {string} target
   * @returns {Record<string, unknown>}
   */
  open(target) {
    const resolved = path.resolve(target);
    this.document = loadSettings(resolved);
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

  // ------------------------------------------------------------------
  // Effective settings  (reference: links_file / output_file / listen_ip)
  // ------------------------------------------------------------------

  /** Reference: `links_file`. */
  get linksFile() {
    const value = this.effectiveProfile().links_file;
    return typeof value === 'string' && value.length > 0 ? value : DEFAULT_LINKS_FILE;
  }

  /** Reference: `output_file`. */
  get outputFile() {
    const value = this.effectiveProfile().output_file;
    return typeof value === 'string' && value.length > 0 ? value : DEFAULT_OUTPUT_FILE;
  }

  /** Reference: `listen_ip`. */
  get listenIp() {
    const value = this.effectiveProfile().listen_ip;
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
   * `defaults` merged with the active profile — top level only, so nested
   * objects are replaced as a whole. Mirrors the merge of the core
   * (`loadProfileSettings`), and a test asserts the two agree on the same
   * document; duplicating four lines here is cheaper than changing the accepted
   * core.
   *
   * @returns {Record<string, unknown>}
   */
  effectiveProfile() {
    return {...this.defaultsBody(), ...this.profileBody()};
  }

  /**
   * The effective settings with the `note` fields dropped — the exact shape the
   * core's `loadProfileSettings` returns in its `settings` property.
   *
   * @returns {Record<string, unknown>}
   */
  effectiveSettings() {
    const merged = this.effectiveProfile();
    delete merged.note;
    if (Array.isArray(merged.proxies)) {
      merged.proxies = merged.proxies.map((proxy) => {
        if (!isMapping(proxy) || !Object.hasOwn(proxy, 'note')) return proxy;
        const {note, ...rest} = proxy;
        return rest;
      });
    }
    return merged;
  }

  /**
   * Reference: `set_links_file`. The links file belongs to the profile: two
   * profiles may watch different subscription files.
   *
   * @param {string} value
   */
  setLinksFile(value) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new ConfigError('links_file должен быть непустой строкой');
    }
    this.profileBody().links_file = value;
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
    this.profileBody().output_file = value;
    this.markDirty();
  }

  /**
   * Sets the free-form comment of the active profile. It is the port of the
   * comments that used to live in settings.yaml, so it is editable like the one
   * of a proxy or a route.
   *
   * @param {string} value
   */
  setProfileNote(value) {
    this.profileBody().note = String(value ?? '');
    this.markDirty();
  }

  // ------------------------------------------------------------------
  // profiles
  // ------------------------------------------------------------------

  /** @returns {string[]} Profile names in file order. */
  profileNames() {
    return Object.keys(isMapping(this.document.profiles) ? this.document.profiles : {});
  }

  /** @returns {string} Name of the profile the generator will apply. */
  activeProfileName() {
    return typeof this.document.active === 'string' ? this.document.active : '';
  }

  /**
   * Body of a profile, by default the active one.
   *
   * @param {string} [name]
   * @returns {Record<string, unknown>}
   */
  profileBody(name = this.activeProfileName()) {
    const profiles = isMapping(this.document.profiles) ? this.document.profiles : {};
    const body = profiles[name];
    if (!isMapping(body)) {
      throw new ConfigError(`профиль '${name}' не найден в webui.json`);
    }
    return body;
  }

  /**
   * Body of the shared defaults. Reading NEVER creates the section: a document
   * that carries no `defaults` has to round-trip byte for byte, and a getter
   * that quietly added `"defaults": {}` would break that with no user edit at
   * all. Writers go through `#ensureDefaults` instead.
   */
  defaultsBody() {
    return isMapping(this.document.defaults) ? this.document.defaults : {};
  }

  /**
   * @param {string} name
   * @returns {boolean} True when the active profile changed.
   */
  setActive(name) {
    this.profileBody(name); // throws for an unknown profile
    if (name === this.activeProfileName()) return false;
    this.document.active = name;
    this.markDirty();
    return true;
  }

  /**
   * Creates a profile, optionally as a copy of an existing one.
   *
   * @param {string} name
   * @param {{copyOf?: string|null}} [options]
   * @returns {string} The created name.
   */
  createProfile(name, options = {}) {
    assertUsableName(name, 'профиля');
    const profiles = this.#ensureProfiles();
    if (Object.hasOwn(profiles, name)) {
      throw new ConfigError(`профиль '${name}' уже есть`);
    }

    if (options.copyOf !== undefined && options.copyOf !== null) {
      const source = this.profileBody(options.copyOf);
      profiles[name] = structuredClone(source);
    } else {
      profiles[name] = {};
    }
    this.markDirty();
    return name;
  }

  /**
   * Duplicates a profile. Ports are copied as they are: they conflict only
   * between profiles and exactly one profile is applied at a time.
   *
   * @param {string} source
   * @param {string|null} [name] Explicit name, otherwise `<source>-copy`.
   * @returns {string} The new name.
   */
  duplicateProfile(source, name = null) {
    this.profileBody(source);
    const target = name ?? this.nextFreeProfileName(`${source}${DEFAULT_PROFILE_SUFFIX}`);
    assertUsableName(target, 'профиля');
    const profiles = this.#ensureProfiles();
    if (Object.hasOwn(profiles, target)) {
      throw new ConfigError(`профиль '${target}' уже есть`);
    }

    // Rebuild the section so the copy lands right after its source.
    const rebuilt = {};
    for (const [key, value] of Object.entries(profiles)) {
      rebuilt[key] = value;
      if (key === source) rebuilt[target] = structuredClone(value);
    }
    this.document.profiles = rebuilt;
    this.markDirty();
    return target;
  }

  /**
   * Renames a profile, keeping its position in the file and following `active`.
   *
   * @param {string} oldName
   * @param {string} newName
   * @returns {boolean}
   */
  renameProfile(oldName, newName) {
    assertUsableName(newName, 'профиля');
    if (oldName === newName) return false;

    const profiles = this.#ensureProfiles();
    if (!Object.hasOwn(profiles, oldName)) {
      throw new ConfigError(`профиль '${oldName}' не найден в webui.json`);
    }
    if (Object.hasOwn(profiles, newName)) {
      throw new ConfigError(`профиль '${newName}' уже есть`);
    }

    const rebuilt = {};
    for (const [key, value] of Object.entries(profiles)) {
      rebuilt[key === oldName ? newName : key] = value;
    }
    this.document.profiles = rebuilt;
    if (this.document.active === oldName) this.document.active = newName;
    this.markDirty();
    return true;
  }

  /**
   * Removes a profile. The active profile and the last remaining profile are
   * protected: deleting either would leave a `webui.json` the schema rejects.
   *
   * @param {string} name
   * @returns {boolean}
   */
  removeProfile(name) {
    const profiles = this.#ensureProfiles();
    if (!Object.hasOwn(profiles, name)) {
      throw new ConfigError(`профиль '${name}' не найден в webui.json`);
    }
    // With a single profile the two rules below coincide (the only profile must
    // be the active one, the schema says so), and the message about the last
    // profile is the more useful one: it names what would actually break.
    if (Object.keys(profiles).length <= 1) {
      throw new ConfigError(
        `нельзя удалить последний профиль '${name}': в файле не останется ни одного`,
      );
    }
    if (name === this.activeProfileName()) {
      throw new ConfigError(
        `нельзя удалить активный профиль '${name}': сначала переключитесь на другой`,
      );
    }

    delete profiles[name];
    this.markDirty();
    return true;
  }

  /**
   * `base`, then `base-2`, `base-3`, ... Reference: `next_free_route_name`,
   * reused for profiles.
   *
   * @param {string} [base]
   * @returns {string}
   */
  nextFreeProfileName(base = DEFAULT_PROFILE_NAME) {
    const names = new Set(this.profileNames());
    if (!names.has(base)) return base;
    let n = 2;
    while (names.has(`${base}-${n}`)) n += 1;
    return `${base}-${n}`;
  }

  /**
   * Where a shared setting comes from: the profile itself, `defaults`, or
   * nowhere at all (then the form shows the built-in default).
   *
   * @param {string} key
   * @returns {{key: string, scope: 'profile'|'defaults'|'absent', value: unknown}}
   */
  fieldOrigin(key) {
    const profile = this.profileBody();
    const defaults = this.defaultsBody();
    let scope = 'absent';
    if (Object.hasOwn(profile, key)) scope = 'profile';
    else if (Object.hasOwn(defaults, key)) scope = 'defaults';
    return {key, scope, value: this.effectiveProfile()[key]};
  }

  /**
   * Drops a shared key from the active profile, so the value of `defaults`
   * applies again. This is the only way a key is ever removed automatically —
   * a key that happens to equal the default stays where it is, because the
   * round-trip of an untouched file must stay byte-identical.
   *
   * @param {string} key
   * @returns {boolean} True when the key was present in the profile.
   */
  resetProfileField(key) {
    if (!SHARED_KEYS.includes(key)) {
      throw new ConfigError(`поле '${key}' нельзя вернуть к умолчанию: оно не общее`);
    }
    const profile = this.profileBody();
    if (!Object.hasOwn(profile, key)) return false;
    delete profile[key];
    this.markDirty();
    return true;
  }

  // ------------------------------------------------------------------
  // General settings and defaults
  // ------------------------------------------------------------------

  /**
   * Values of the "Общие" form, computed from the ACTIVE PROFILE with the
   * inheritance already applied. `urltest` is passed through `urltestBlock`, so
   * the form shows the url/interval/tolerance that will really end up in
   * `config.json`, not the raw fragment.
   *
   * @returns {Record<string, unknown>}
   */
  generalValues() {
    const effective = this.effectiveProfile();
    const urltest = urltestBlock(effective.urltest === undefined ? null : effective.urltest);
    const log = isMapping(effective.log) ? effective.log : {};

    return {
      listen_ip:
        typeof effective.listen_ip === 'string' && effective.listen_ip.length > 0
          ? effective.listen_ip
          : DEFAULT_LISTEN_IP,
      urltest,
      log: {
        level: typeof log.level === 'string' ? log.level : DEFAULT_LOG_LEVEL,
        timestamp: log.timestamp === undefined ? true : Boolean(log.timestamp),
      },
      exclude_from_auto: asList(effective.exclude_from_auto),
      origins: {
        listen_ip: this.fieldOrigin('listen_ip').scope,
        urltest: this.fieldOrigin('urltest').scope,
        log: this.fieldOrigin('log').scope,
        exclude_from_auto: this.fieldOrigin('exclude_from_auto').scope,
      },
    };
  }

  /**
   * Writes the "Общие" form into the active profile. Nested `urltest`/`log` are
   * merged field by field, in place, exactly like `apply_general` of the
   * reference does it with `_update_mapping`.
   *
   * @param {{listen_ip?: string, urltest?: Record<string, unknown>,
   *   log?: Record<string, unknown>, exclude_from_auto?: unknown[]}} values
   */
  applyGeneral(values = {}) {
    const profile = this.profileBody();
    if (values.listen_ip !== undefined) profile.listen_ip = values.listen_ip;
    if (values.urltest !== undefined) this.#updateMapping(profile, 'urltest', values.urltest);
    if (values.log !== undefined) this.#updateMapping(profile, 'log', values.log);
    if (values.exclude_from_auto !== undefined) {
      profile.exclude_from_auto = [...values.exclude_from_auto];
    }
    this.markDirty();
  }

  /**
   * Values of the "Значения по умолчанию" form: what `defaults` really carries,
   * with `present` telling which keys are set there at all. Absent keys are
   * shown with the built-in default, so the form is never blank.
   *
   * @returns {Record<string, unknown>}
   */
  defaultsValues() {
    const defaults = this.defaultsBody();
    const urltest = urltestBlock(defaults.urltest === undefined ? null : defaults.urltest);
    const log = isMapping(defaults.log) ? defaults.log : {};

    return {
      listen_ip:
        typeof defaults.listen_ip === 'string' && defaults.listen_ip.length > 0
          ? defaults.listen_ip
          : DEFAULT_LISTEN_IP,
      urltest,
      log: {
        level: typeof log.level === 'string' ? log.level : DEFAULT_LOG_LEVEL,
        timestamp: log.timestamp === undefined ? true : Boolean(log.timestamp),
      },
      exclude_from_auto: asList(defaults.exclude_from_auto),
      present: Object.fromEntries(SHARED_KEYS.map((key) => [key, Object.hasOwn(defaults, key)])),
    };
  }

  /**
   * Writes the defaults form. Only SHARED_KEYS are touched: anything else a
   * hand-written `defaults` may contain (`proxies`, for instance) is left alone
   * rather than dropped by a form that does not know about it.
   *
   * @param {{listen_ip?: string, urltest?: Record<string, unknown>,
   *   log?: Record<string, unknown>, exclude_from_auto?: unknown[]}} values
   */
  applyDefaults(values = {}) {
    const defaults = this.#ensureDefaults();
    if (values.listen_ip !== undefined) defaults.listen_ip = values.listen_ip;
    if (values.urltest !== undefined) this.#updateMapping(defaults, 'urltest', values.urltest);
    if (values.log !== undefined) this.#updateMapping(defaults, 'log', values.log);
    if (values.exclude_from_auto !== undefined) {
      defaults.exclude_from_auto = [...values.exclude_from_auto];
    }
    this.markDirty();
  }

  // ------------------------------------------------------------------
  // DNS  (a JSON text field on purpose: the schema moves too fast)
  // ------------------------------------------------------------------

  /**
   * The `dns` section as JSON text for the textarea.
   *
   * @param {'profile'|'defaults'} [scope] Which body to read.
   * @returns {string}
   */
  dnsJson(scope = 'profile') {
    const body = scope === 'defaults' ? this.defaultsBody() : this.effectiveProfile();
    const dns = isMapping(body.dns) ? body.dns : {};
    return canonicalJson(dns);
  }

  /**
   * Parses the DNS textarea and stores it. Only "a valid JSON object" is
   * checked, as the task requires: structural forms for the 16 kinds of DNS
   * servers are deliberately not built.
   *
   * @param {string} text
   * @param {'profile'|'defaults'} [scope]
   * @returns {Record<string, unknown>} The stored section.
   */
  applyDns(text, scope = 'profile') {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new ConfigError(`dns: это не валидный JSON — ${error.message}`);
    }
    if (!isMapping(parsed)) {
      throw new ConfigError('dns: ожидается JSON-объект, например {"servers": [], "final": "dns-local"}');
    }

    const body = scope === 'defaults' ? this.#ensureDefaults() : this.profileBody();
    body.dns = parsed;
    this.markDirty();
    return parsed;
  }

  // ------------------------------------------------------------------
  // proxies  (reference: the proxy CRUD of model.py)
  // ------------------------------------------------------------------

  /** Counterpart of the reference `proxies()`. */
  proxies() {
    const value = this.profileBody().proxies;
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
    });
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
    const value = this.profileBody().routes;
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
      this.profileBody().routes = rebuilt;
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
    this.profileBody().routes = rebuilt;
    this.markDirty();
    return true;
  }

  // ------------------------------------------------------------------
  // Links file and stale references
  // ------------------------------------------------------------------

  /**
   * Reads the links file of the active profile.
   * Reference: `load_server_tags` — the error is returned, not thrown, because a
   * missing links file is a normal state of a fresh project.
   *
   * @returns {{file: string, path: string, exists: boolean, tags: string[],
   *   error: string|null, warnings: string[]}}
   */
  linksInfo() {
    const file = this.linksFile;
    const resolved = this.resolvedLinksPath();
    const warnings = [];
    try {
      const outbounds = parseLinks(resolved, warnings);
      return {
        file,
        path: resolved,
        exists: true,
        tags: outbounds.map((outbound) => outbound.tag),
        error: null,
        warnings,
      };
    } catch (error) {
      if (error instanceof ConfigError) {
        return {
          file,
          path: resolved,
          exists: fs.existsSync(resolved),
          tags: [],
          error: error.message,
          warnings,
        };
      }
      throw error;
    }
  }

  /** Reference: `load_server_tags`, reduced to what most callers need. */
  loadServerTags() {
    const info = this.linksInfo();
    return {tags: info.tags, error: info.error};
  }

  /**
   * `{section, name} -> [stale tags]` for the active profile.
   * Reference: `stale_map`.
   *
   * @returns {Map<string, string[]>}
   */
  staleMap() {
    return staleMap(this.document, this.loadServerTags().tags);
  }

  /**
   * Tree of the project, as plain data.
   * Reference: `tree_spec`, extended with the profiles and defaults nodes.
   *
   * @returns {Record<string, unknown>}
   */
  treeSpec() {
    const info = this.linksInfo();
    return buildTree({
      document: this.document,
      allTags: info.tags,
      active: this.activeProfileName(),
      title: this.displayName,
      linksFile: info.file,
      linksExists: info.exists,
      linksError: info.error,
      outputFile: this.outputFile,
    });
  }

  // ------------------------------------------------------------------
  // Generation
  // ------------------------------------------------------------------

  /**
   * Generates `config.json` for the active profile by calling the core on the
   * SAVED file: unsaved edits are not silently included, `wasDirty` tells the UI
   * to say so.
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
    const result = generateConfigFile(this.path, {
      profile: this.activeProfileName(),
      ...options,
    });
    return {
      ...result,
      summary: formatStats(result.outputFile, result.stats, result.warnings),
      wasDirty,
    };
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /** @returns {Record<string, unknown>} */
  #ensureProfiles() {
    if (!isMapping(this.document.profiles)) this.document.profiles = {};
    return this.document.profiles;
  }

  /** @returns {Record<string, unknown>} */
  #ensureDefaults() {
    if (!isMapping(this.document.defaults)) this.document.defaults = {};
    return this.document.defaults;
  }

  /** @returns {unknown[]} */
  #ensureProxies() {
    const profile = this.profileBody();
    if (!Array.isArray(profile.proxies)) profile.proxies = [];
    return profile.proxies;
  }

  /** @returns {Record<string, unknown>} */
  #ensureRoutes() {
    const profile = this.profileBody();
    if (!isMapping(profile.routes)) profile.routes = {};
    return profile.routes;
  }

  /**
   * Normalises a proxy into the shape the core expects: `servers` and `note` are
   * only written when they carry something, which keeps `webui.json` free of
   * empty noise. Reference: `upsert_proxy`.
   *
   * @param {{tag?: unknown, type?: unknown, port?: unknown, servers?: unknown, note?: unknown}} candidate
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
    return entry;
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

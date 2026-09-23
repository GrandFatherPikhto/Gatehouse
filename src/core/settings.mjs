// Settings loading (webui.json), schema validation and file output.
//
// Replaces `load_settings`, `resolve_path`, `write_json` and
// `generate_config_file` of the reference
// /home/yevstigneyevda/Projects/Python/SingBoxTools/sing_box_manager.py
//
// The reference kept everything in one flat YAML file. `webui.json` version 1
// wrapped that flat body in a `defaults` + `profiles` + `active` envelope; since
// version 2 the document is flat again, so the core receives exactly the shape
// the reference expected. That is what keeps the generated `config.json`
// byte-identical to the reference output.
//
// The profile envelope is gone but not forgotten: a version-1 file is refused
// here with a message naming the editor, which is the only thing that migrates
// it (see `ProjectModel.open`). Refusing instead of half-merging means the CLI
// path can never write a `config.json` from an unmigrated document.

import fs from 'node:fs';
import path from 'node:path';

import Ajv from 'ajv';

import {buildConfig} from './build.mjs';
import {ConfigError, DEFAULT_SETTINGS_FILE, isMapping} from './errors.mjs';
import {readSources, resolveSourcesRoot} from './sources.mjs';
import {parseLinks} from './vless.mjs';

const SCHEMA_URL = new URL('../schemas/webui.schema.json', import.meta.url);
const SCHEMA = JSON.parse(fs.readFileSync(SCHEMA_URL, 'utf8'));

const ajv = new Ajv({allErrors: true});

const validateAgainstSchema = ajv.compile(SCHEMA);

/**
 * Top-level keys that only exist in the version-1 (profile-level) document.
 * Their presence is what makes a file legacy, not its `version`: a hand-edited
 * file may carry a stale version number, while the shape is what really breaks
 * the flat loader.
 */
export const LEGACY_KEYS = Object.freeze(['profiles', 'defaults', 'active', 'links_file']);

/**
 * Top-level keys that left the project and are dropped BEFORE the schema sees
 * them, because the schema is strict and the owner's live `webui.json` still
 * carries them.
 *
 *   * `watchdog` and `clash_api` belonged to the Watchdog (part B of
 *     techdocs/plan_2026_09_23_gatehouse_fuse_and_no_watchdog.md);
 *   * `amnezia_dir` was a per-document tunnel directory. It is gone because the
 *     tunnel directory became a single constant of the build: the template unit
 *     reads a fixed path, so a document value could aim the start-up fuse at one
 *     file and the unit at another.
 *
 * The file itself is not rewritten here: the keys disappear on the next ordinary
 * save.
 */
export const REMOVED_KEYS = Object.freeze(['watchdog', 'clash_api', 'amnezia_dir']);

/** Keys of a proxy that the Watchdog wrote, dropped with the rest. */
export const REMOVED_PROXY_KEYS = Object.freeze(['watch', 'watch_url']);

/**
 * True for a version-1 document with the profile envelope. The editor uses the
 * same predicate to decide whether a file has to be migrated.
 *
 * @param {unknown} data
 * @returns {boolean}
 */
export function isLegacyDocument(data) {
  return isMapping(data) && LEGACY_KEYS.some((key) => Object.hasOwn(data, key));
}

/**
 * Drops the fields of the removed Watchdog, IN PLACE, and returns their names.
 *
 * One function for both entry points — `loadSettings` here and `ProjectModel.open`
 * — so the editor and `tools/generate.mjs` can never disagree about which fields
 * are stale (part B.2 of the task). Nothing else is touched: the document is not
 * rewritten, `version` is not bumped, and the fields disappear from the file only
 * on the next ordinary save.
 *
 * @param {unknown} data Parsed document, modified in place.
 * @returns {string[]} Names of the dropped fields, in document order.
 */
export function dropRemovedSettings(data) {
  if (!isMapping(data)) return [];

  const dropped = [];

  for (const key of REMOVED_KEYS) {
    if (!Object.hasOwn(data, key)) continue;
    delete data[key];
    dropped.push(key);
  }

  if (Array.isArray(data.proxies)) {
    data.proxies.forEach((proxy, index) => {
      if (!isMapping(proxy)) return;
      for (const key of REMOVED_PROXY_KEYS) {
        if (!Object.hasOwn(proxy, key)) continue;
        delete proxy[key];
        dropped.push(`proxies[${index}].${key}`);
      }
    });
  }

  return dropped;
}

/**
 * The one line the editor shows and `tools/generate.mjs` prints to stderr.
 *
 * @param {string[]} dropped
 * @returns {string}
 */
export function removedSettingsMessage(dropped) {
  return (
    `убраны устаревшие поля Сторожа: ${dropped.join(', ')}; ` +
    'сохраните, чтобы они исчезли из файла'
  );
}

/**
 * Validates a parsed webui.json. Throws ConfigError listing every problem.
 *
 * @param {unknown} data
 * @param {string} source File name used in the message.
 */
export function validateSettings(data, source = DEFAULT_SETTINGS_FILE) {
  if (isLegacyDocument(data)) {
    throw new ConfigError(
      `${source}: это webui.json старого формата (profiles/defaults или поле links_file). ` +
        'Откройте файл один раз в редакторе GateHouse: он развернёт единственный профиль, ' +
        'заменит links_file на sources, поднимет version до 2 и сохранит снимок. ' +
        'Генератор по такому файлу не работает, чтобы не мигрировать его наполовину.',
    );
  }

  if (validateAgainstSchema(data)) return;

  const problems = (validateAgainstSchema.errors || []).map(
    (error) => `${error.instancePath || '/'}: ${error.message}`,
  );
  throw new ConfigError(
    `${source}: настройки не соответствуют схеме webui.json:\n  - ${problems.join('\n  - ')}`,
  );
}

/**
 * Loads and validates webui.json.
 * Reference: `load_settings` (which threw ConfigError for a missing file).
 *
 * @param {string} settingsPath
 * @param {{dropped?: string[]}} [options] `dropped` collects the names of the
 *   removed fields, for the caller that has to report them.
 * @returns {Record<string, unknown>} Parsed settings.
 */
export function loadSettings(settingsPath, options = {}) {
  if (!fs.existsSync(settingsPath)) {
    throw new ConfigError(`файл настроек ${settingsPath} не найден`);
  }
  let text;
  try {
    text = fs.readFileSync(settingsPath, 'utf8');
  } catch (error) {
    throw new ConfigError(`ошибка чтения JSON ${settingsPath}: ${error.message}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`ошибка чтения JSON ${settingsPath}: ${error.message}`);
  }

  // The fields of the removed Watchdog go BEFORE the schema sees them: the owner's
  // file on the router still carries `watchdog`, `clash_api` and the per-proxy
  // `watch` / `watch_url`, and the schema is strict. The file itself is not
  // rewritten — the fields disappear on the next ordinary save.
  const dropped = dropRemovedSettings(data);
  if (Array.isArray(options.dropped)) options.dropped.push(...dropped);

  validateSettings(data, settingsPath);
  return data;
}

/**
 * Loads the settings and strips what the core must not see: `version` is a
 * document-format marker, `note` fields are comments for humans. Returns the
 * flat body the reference expected, plus the directory relative paths resolve
 * against.
 *
 * Replaces `loadProfileSettings` of the version-1 code: with the profile level
 * gone there is nothing to merge, only noise to drop.
 *
 * @param {string} settingsPath
 * @returns {{settings: Record<string, unknown>, settingsDir: string,
 *   raw: Record<string, unknown>, dropped: string[]}} `dropped` names the fields
 *   of the removed Watchdog that were in the file.
 */
export function loadEffectiveSettings(settingsPath) {
  const dropped = [];
  const raw = loadSettings(settingsPath, {dropped});
  const settings = {};

  for (const [key, value] of Object.entries(raw)) {
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

  return {
    settings,
    settingsDir: path.dirname(path.resolve(settingsPath)),
    raw,
    dropped,
  };
}

/**
 * Resolves a path against a base directory, like the reference `resolve_path`:
 * absolute paths are returned untouched, relative ones are joined to the
 * directory of the settings file, so the generator can be started from anywhere.
 *
 * @param {string} baseDir
 * @param {string} target
 * @returns {string}
 */
export function resolvePath(baseDir, target) {
  return path.isAbsolute(target) ? target : path.join(baseDir, target);
}

/**
 * Serialises the config exactly like the reference did:
 * `json.dump(config, f, indent=2, ensure_ascii=False)` — two-space indent,
 * emoji as is, and NO trailing newline.
 *
 * @param {unknown} config
 * @returns {string}
 */
export function stringifyConfig(config) {
  return JSON.stringify(config, null, 2);
}

/**
 * Writes the config, creating missing directories.
 * Reference: `write_json`.
 *
 * @param {string} filePath
 * @param {unknown} config
 */
export function writeJson(filePath, config) {
  const directory = path.dirname(filePath);
  if (directory && !fs.existsSync(directory)) {
    fs.mkdirSync(directory, {recursive: true});
  }
  fs.writeFileSync(filePath, stringifyConfig(config), 'utf8');
}

/**
 * Builds and writes config.json.
 * Reference: `generate_config_file` — same override order, same error cases.
 *
 * @param {string} settingsPath
 * @param {{output?: string, links?: string, listenIp?: string, excludeFromAuto?: unknown[], warnings?: string[], runningTunnels?: Set<string>}} [options]
 * @returns {{outputFile: string, stats: Record<string, unknown>, warnings: string[], config: Record<string, unknown>}}
 */
export function generateConfigFile(settingsPath, options = {}) {
  const warnings = options.warnings || [];
  const {settings, settingsDir, dropped} = loadEffectiveSettings(settingsPath);

  // The fields the Watchdog left behind are named in stderr, and generation goes
  // on: the owner has to be told, but a stale field is not a reason to fail.
  if (dropped.length > 0) warnings.push(removedSettingsMessage(dropped));

  const outputFile = resolvePath(
    settingsDir,
    options.output || settings.output_file || 'config.json',
  );
  const listenIp = options.listenIp || settings.listen_ip || '127.0.0.1';
  if (typeof listenIp !== 'string' || listenIp.length === 0) {
    throw new ConfigError('listen_ip должен быть непустой строкой');
  }

  const override = options.excludeFromAuto;
  const effective =
    override === undefined || override === null
      ? settings
      : {...settings, exclude_from_auto: override};

  const outbounds = readOutbounds(settings, settingsDir, options.links, warnings);
  // `runningTunnels` is the set of tunnel interfaces the caller found up in
  // systemd. It only feeds the §5.4 warning about a proxy on a stopped tunnel;
  // `undefined` means "not asked", which adds no warning.
  const [config, stats] = buildConfig(effective, outbounds, listenIp, warnings, {
    runningTunnels: options.runningTunnels,
  });
  writeJson(outputFile, config);

  return {outputFile, stats, warnings, config};
}

/**
 * Reads the outbounds of a generation run.
 *
 * `linksOverride` is the CLI `--links` flag: a single file, read exactly as the
 * version-2 code did, so a script that pins one list keeps working. Otherwise the
 * sources of the document are read: an explicit `path` resolves against the
 * settings directory, a legacy folder entry against the sources root.
 *
 * @param {Record<string, unknown>} settings
 * @param {string} settingsDir
 * @param {string|undefined} linksOverride
 * @param {string[]} warnings
 * @returns {Array<Record<string, unknown>>}
 */
function readOutbounds(settings, settingsDir, linksOverride, warnings) {
  if (typeof linksOverride === 'string' && linksOverride.length > 0) {
    return parseLinks(resolvePath(settingsDir, linksOverride), warnings);
  }

  const root = resolveSourcesRoot(settingsDir);
  const read = readSources(settings.sources, {root, baseDir: settingsDir}, warnings);
  if (read.outbounds.length === 0) {
    const broken = read.providers.filter((provider) => provider.error !== null);
    const reason = broken.length > 0 ? `\n  - ${broken.map((provider) => provider.error).join('\n  - ')}` : '';
    throw new ConfigError(
      `не найдено ни одного выхода в источниках: проверьте поле sources${reason}`,
    );
  }
  return read.outbounds;
}

export {SCHEMA, DEFAULT_SETTINGS_FILE};


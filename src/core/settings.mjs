// Settings loading (webui.json), schema validation and file output.
//
// Replaces `load_settings`, `resolve_path`, `write_json` and
// `generate_config_file` of the reference
// /home/yevstigneyevda/Projects/Python/SingBoxTools/sing_box_manager.py
//
// The reference kept everything in one flat YAML file. Here the settings live in
// `webui.json`: `defaults` holds the shared body, `profiles` holds named
// variants and `active` picks one. After merging, the core receives exactly the
// flat shape the reference expected, which is what keeps the generated
// `config.json` byte-identical.

import fs from 'node:fs';
import path from 'node:path';

import Ajv from 'ajv';

import {API_SECRET_VAR, buildConfig} from './build.mjs';
import {ConfigError, DEFAULT_SETTINGS_FILE, isMapping, pythonRepr} from './errors.mjs';
import {parseLinks} from './vless.mjs';

const SCHEMA_URL = new URL('../schemas/webui.schema.json', import.meta.url);
const SCHEMA = JSON.parse(fs.readFileSync(SCHEMA_URL, 'utf8'));

const ajv = new Ajv({allErrors: true});

// JSON Schema cannot express "active must be a key of profiles", so the check
// lives in a custom keyword and stays part of ajv validation.
ajv.addKeyword({
  keyword: 'profileMustExist',
  errors: false,
  compile: () => (data) =>
    isMapping(data) && isMapping(data.profiles) && Object.hasOwn(data.profiles, data.active),
});

const validateAgainstSchema = ajv.compile(SCHEMA);

/**
 * Validates a parsed webui.json. Throws ConfigError listing every problem.
 *
 * @param {unknown} data
 * @param {string} source File name used in the message.
 */
export function validateSettings(data, source = DEFAULT_SETTINGS_FILE) {
  if (validateAgainstSchema(data)) return;

  const problems = (validateAgainstSchema.errors || []).map((error) => {
    if (error.keyword === 'profileMustExist') {
      const profiles = isMapping(data) && isMapping(data.profiles) ? Object.keys(data.profiles) : [];
      return `active: профиль ${pythonRepr(isMapping(data) ? data.active : undefined)} не найден в profiles ` +
        `(доступны: ${profiles.join(', ') || '(нет)'})`;
    }
    return `${error.instancePath || '/'}: ${error.message}`;
  });
  throw new ConfigError(
    `${source}: настройки не соответствуют схеме webui.json:\n  - ${problems.join('\n  - ')}`,
  );
}

/**
 * Loads and validates webui.json.
 * Reference: `load_settings` (which threw ConfigError for a missing file).
 *
 * @param {string} settingsPath
 * @returns {Record<string, unknown>} Parsed settings.
 */
export function loadSettings(settingsPath) {
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

  validateSettings(data, settingsPath);
  return data;
}

/**
 * Loads the settings and flattens the active profile into the shape the core
 * expects: `defaults` first, then the profile on top (top level only, so nested
 * `log`/`dns`/`urltest` objects are replaced as a whole).
 *
 * `note` fields are comments for humans and never reach `config.json`.
 *
 * @param {string} settingsPath
 * @param {{profile?: string|null}} [options] Profile override (CLI `--profile`).
 * @returns {{settings: Record<string, unknown>, settingsDir: string, active: string, raw: Record<string, unknown>}}
 */
export function loadProfileSettings(settingsPath, options = {}) {
  const data = loadSettings(settingsPath);
  const active = options.profile || data.active;
  const profileData = isMapping(data.profiles) ? data.profiles[active] : undefined;

  if (!isMapping(profileData)) {
    const available = Object.keys(isMapping(data.profiles) ? data.profiles : {}).join(', ');
    throw new ConfigError(
      `профиль '${active}' не найден в ${settingsPath} (доступны: ${available || '(нет)'})`,
    );
  }

  const merged = {...(data.defaults || {}), ...profileData};
  delete merged.note;
  if (Array.isArray(merged.proxies)) {
    merged.proxies = merged.proxies.map((proxy) => {
      if (!isMapping(proxy) || !Object.hasOwn(proxy, 'note')) return proxy;
      const {note, ...rest} = proxy;
      return rest;
    });
  }

  return {
    settings: merged,
    settingsDir: path.dirname(path.resolve(settingsPath)),
    active,
    raw: data,
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
 * Builds and writes config.json for the active profile.
 * Reference: `generate_config_file` — same override order, same error cases.
 *
 * @param {string} settingsPath
 * @param {{output?: string, links?: string, listenIp?: string, excludeFromAuto?: unknown[], profile?: string, warnings?: string[]}} [options]
 * @returns {{outputFile: string, stats: Record<string, unknown>, warnings: string[], config: Record<string, unknown>}}
 */
export function generateConfigFile(settingsPath, options = {}) {
  const warnings = options.warnings || [];
  const {settings, settingsDir} = loadProfileSettings(settingsPath, options);

  const linksFile = resolvePath(settingsDir, options.links || settings.links_file || 'links.txt');
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

  const outbounds = parseLinks(linksFile, warnings);
  // The API secret lives in the environment and is looked up here, in the one
  // place every caller (CLI and web editor) goes through. `options.apiSecret` is
  // the injection point for a test; the environment is what a service uses.
  const apiSecret = options.apiSecret ?? process.env[API_SECRET_VAR] ?? '';
  const [config, stats] = buildConfig(effective, outbounds, listenIp, warnings, {apiSecret});
  writeJson(outputFile, config);

  return {outputFile, stats, warnings, config};
}

export {SCHEMA, DEFAULT_SETTINGS_FILE};

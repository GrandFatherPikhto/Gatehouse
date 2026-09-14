#!/usr/bin/env node
// One-off converter: settings.yaml (reference format) -> webui.json.
//
// This is a migration tool, not part of the core: only here the `yaml` package
// is allowed, and it lives in devDependencies. The core itself never reads YAML.
//
// Usage:
//   node tools/import-settings.mjs --settings settings.yaml --output webui.json
//   node tools/import-settings.mjs --settings settings.yaml --absolute-paths
//
// --absolute-paths resolves links_file/output_file against the directory of the
// YAML file. That is what lets the comparison tool run against the owner's real
// settings.yaml without copying it anywhere: the temporary webui.json can live
// in /tmp and still point at the real links file.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {ConfigError} from '../src/core/errors.mjs';

const USAGE = `Использование: node tools/import-settings.mjs --settings PATH [опции]

Опции:
  --settings PATH       входной settings.yaml (обязательно)
  --output PATH         выходной webui.json (по умолчанию webui.json)
  --profile NAME        имя профиля (по умолчанию default)
  --note TEXT           комментарий профиля (по умолчанию берётся из settings.yaml, если он там есть)
  --absolute-paths      записать links_file/output_file абсолютными путями
  -h, --help            эта справка`;

//: Keys of settings.yaml that map 1:1 onto a profile body.
const PROFILE_KEYS = [
  'note',
  'listen_ip',
  'links_file',
  'output_file',
  'exclude_from_auto',
  'urltest',
  'log',
  'dns',
  'proxies',
  'routes',
];

//: Keys of a proxy entry that map 1:1.
const PROXY_KEYS = ['tag', 'type', 'port', 'servers', 'note'];

function parseArgs(argv) {
  const options = {
    settings: null,
    output: 'webui.json',
    profile: 'default',
    note: null,
    absolutePaths: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length) throw new ConfigError(`флаг ${arg} требует значение`);
      return argv[index];
    };
    switch (arg) {
      case '--settings':
        options.settings = value();
        break;
      case '--output':
        options.output = value();
        break;
      case '--profile':
        options.profile = value();
        break;
      case '--note':
        options.note = value();
        break;
      case '--absolute-paths':
        options.absolutePaths = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new ConfigError(`неизвестный флаг: ${arg}`);
    }
  }
  return options;
}

/**
 * Converts the parsed settings.yaml into a webui.json document.
 *
 * @param {Record<string, unknown>} source Parsed settings.yaml.
 * @param {{settingsDir?: string, profile?: string, note?: string|null, absolutePaths?: boolean}} [options]
 * @returns {{document: Record<string, unknown>, warnings: string[]}}
 */
export function convertSettings(source, options = {}) {
  const profileName = options.profile || 'default';
  const settingsDir = options.settingsDir || process.cwd();
  const warnings = [];
  const body = {};

  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new ConfigError(`ожидается mapping в settings.yaml, получено ${Array.isArray(source) ? 'list' : typeof source}`);
  }

  for (const key of PROFILE_KEYS) {
    if (!Object.hasOwn(source, key)) continue;
    body[key] = source[key];
  }
  const unknown = Object.keys(source).filter((key) => !PROFILE_KEYS.includes(key));
  if (unknown.length > 0) {
    warnings.push(`пропущены неизвестные ключи settings.yaml: ${unknown.join(', ')}`);
  }

  if (Array.isArray(body.proxies)) {
    body.proxies = body.proxies.map((proxy, index) => {
      if (proxy === null || typeof proxy !== 'object' || Array.isArray(proxy)) return proxy;
      const extra = Object.keys(proxy).filter((key) => !PROXY_KEYS.includes(key));
      if (extra.length > 0) {
        warnings.push(`proxies[${index}]: пропущены неизвестные ключи: ${extra.join(', ')}`);
      }
      const copy = {};
      for (const key of PROXY_KEYS) {
        if (Object.hasOwn(proxy, key)) copy[key] = proxy[key];
      }
      return copy;
    });
  }

  if (options.absolutePaths) {
    for (const key of ['links_file', 'output_file']) {
      const value = body[key];
      if (typeof value === 'string' && value.length > 0 && !path.isAbsolute(value)) {
        body[key] = path.resolve(settingsDir, value);
      }
    }
  }

  const note = Object.hasOwn(source, 'note') ? source.note : options.note;
  delete body.note;
  const profileBody = {};
  if (typeof note === 'string' && note.length > 0) profileBody.note = note;
  Object.assign(profileBody, body);

  return {
    document: {
      version: 1,
      active: profileName,
      defaults: {},
      profiles: {[profileName]: profileBody},
    },
    warnings,
  };
}

/**
 * Reads settings.yaml and writes webui.json. Returns the written path.
 *
 * @param {{settings: string, output: string, profile?: string, note?: string|null, absolutePaths?: boolean}} options
 * @returns {Promise<{outputFile: string, warnings: string[]}>}
 */
export async function importSettingsFile(options) {
  if (!options.settings) throw new ConfigError('не указан --settings (входной settings.yaml)');
  if (!fs.existsSync(options.settings)) {
    throw new ConfigError(`файл настроек ${options.settings} не найден`);
  }

  let parseYaml;
  try {
    ({parse: parseYaml} = await import('yaml'));
  } catch (error) {
    throw new ConfigError(
      `для конвертера нужен пакет yaml (devDependencies): ${error.message}`,
    );
  }

  const text = fs.readFileSync(options.settings, 'utf8');
  const source = parseYaml(text);
  const {document, warnings} = convertSettings(source, {
    settingsDir: path.dirname(path.resolve(options.settings)),
    profile: options.profile,
    note: options.note,
    absolutePaths: options.absolutePaths,
  });

  // webui.json is a hand-editable source file, so it gets a trailing newline;
  // config.json must stay byte-identical to the reference and gets none.
  fs.writeFileSync(options.output, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  return {outputFile: options.output, warnings};
}

/**
 * CLI entry point.
 *
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function run(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`Ошибка: ${error.message}\n`);
    return 1;
  }

  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  try {
    const {outputFile, warnings} = await importSettingsFile(options);
    process.stdout.write(`Готово! Настройки сконвертированы в: ${outputFile}\n`);
    for (const warning of warnings) process.stderr.write(`Предупреждение: ${warning}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`Ошибка: ${error.message}\n`);
    return 1;
  }
}

// Only run the CLI when this file is the entry point: tests import the helpers.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;
if (invokedDirectly) {
  process.exitCode = await run(process.argv.slice(2));
}

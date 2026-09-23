// Settings of the document: the general block, DNS, the output file, and the
// generation of `config.json`.
//
// The forms are plain values in, plain values out: `generalValues` and
// `excludePrefixOptions` build what the panel shows, `applyGeneral` and
// `applyDns` write what the form sent, and every rejection is a `ConfigError`
// with the sentence the form puts in front of the owner.

import fs from 'node:fs';

import {ConfigError, DEFAULT_EXCLUDE, isMapping} from '../../core/errors.mjs';
import {generateConfigFile, resolvePath} from '../../core/settings.mjs';
import {asList, requireMapping, urltestBlock} from '../../core/validate.mjs';
import {canonicalJson} from '../storage.mjs';
import {
  DEFAULT_LISTEN_IP,
  DEFAULT_LOG_LEVEL,
  DEFAULT_OUTPUT_FILE,
  formatStats,
} from './document.mjs';
import {resolvedProvidersRoot} from './providers.mjs';

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

/** Reference: `output_file`. */
export function outputFile(model) {
  const value = model.document.output_file;
  return typeof value === 'string' && value.length > 0 ? value : DEFAULT_OUTPUT_FILE;
}

/** Reference: `listen_ip`. */
export function listenIp(model) {
  const value = model.document.listen_ip;
  return typeof value === 'string' && value.length > 0 ? value : DEFAULT_LISTEN_IP;
}

/**
 * Reference: `set_output_file`.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {string} value
 */
export function setOutputFile(model, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError('output_file должен быть непустой строкой');
  }
  model.document.output_file = value;
  model.markDirty();
}

/**
 * Sets the free-form comment of the document. It is the port of the comments
 * that used to live in settings.yaml, so it is editable like the one of a
 * proxy or a route.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {string} value
 */
export function setNote(model, value) {
  model.document.note = String(value ?? '');
  model.markDirty();
}

/**
 * Values of the "Общие" form. `urltest` is passed through `urltestBlock`, so
 * the form shows the url/interval/tolerance that will really end up in
 * `config.json`, not the raw fragment.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @returns {Record<string, unknown>}
 */
export function generalValues(model) {
  const body = model.document;
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
 * @param {import('../project.mjs').ProjectModel} model
 * @returns {{selected: string[], options: Array<{prefix: string, count: number}>,
 *   unknown: string[]}}
 */
export function excludePrefixOptions(model) {
  const counts = new Map();
  for (const tag of model.providersInfo().tags) {
    const prefix = tagPrefix(tag);
    if (prefix.length === 0) continue;
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }

  const options = [...counts.entries()]
    .map(([prefix, count]) => ({prefix, count}))
    .sort((a, b) => a.prefix.localeCompare(b.prefix));

  const selected = Object.hasOwn(model.document, 'exclude_from_auto')
    ? asList(model.document.exclude_from_auto).map((item) => String(item))
    : [...DEFAULT_EXCLUDE];
  const known = new Set(counts.keys());

  return {selected, options, unknown: selected.filter((prefix) => !known.has(prefix))};
}

/**
 * Writes the "Общие" form into the document. Nested `urltest`/`log` are merged
 * field by field, in place, exactly like `apply_general` of the reference does
 * it with `_update_mapping`.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {{listen_ip?: string, urltest?: Record<string, unknown>,
 *   log?: Record<string, unknown>, exclude_from_auto?: unknown[]}} values
 */
export function applyGeneral(model, values = {}) {
  const body = model.document;
  if (values.listen_ip !== undefined) body.listen_ip = values.listen_ip;
  if (values.urltest !== undefined) updateMapping(body, 'urltest', values.urltest);
  if (values.log !== undefined) updateMapping(body, 'log', values.log);
  if (values.exclude_from_auto !== undefined) {
    body.exclude_from_auto = [...values.exclude_from_auto];
  }
  model.markDirty();
}

/**
 * The `dns` section as JSON text for the textarea.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @returns {string}
 */
export function dnsJson(model) {
  const dns = isMapping(model.document.dns) ? model.document.dns : {};
  return canonicalJson(dns);
}

/**
 * Parses the DNS textarea and stores it. Only "a valid JSON object" is
 * checked, as the task requires: structural forms for the 16 kinds of DNS
 * servers are deliberately not built.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {string} text
 * @returns {Record<string, unknown>} The stored section.
 */
export function applyDns(model, text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`dns: это не валидный JSON — ${error.message}`);
  }
  if (!isMapping(parsed)) {
    throw new ConfigError('dns: ожидается JSON-объект, например {"servers": [], "final": "dns-local"}');
  }

  model.document.dns = parsed;
  model.markDirty();
  return parsed;
}

/** Reference: `resolved_output_path`. */
export function resolvedOutputPath(model) {
  return resolvePath(model.settingsDir, outputFile(model));
}

/**
 * True when the generated `config.json` is on disk.
 *
 * The system layer checks the FILE, not the in-memory document, so the panel
 * has to say whether there is anything to check yet: on a fresh project the
 * honest answer is "generate first", not "check failed".
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @returns {boolean}
 */
export function configExists(model) {
  return fs.existsSync(resolvedOutputPath(model));
}

/**
 * Generates `config.json` by calling the core on the SAVED file: unsaved edits
 * are not silently included, `wasDirty` tells the UI to say so.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {{output?: string, links?: string, listenIp?: string,
 *   excludeFromAuto?: unknown[], runningTunnels?: string[]}} [options]
 *   `runningTunnels` is the set of tunnel interfaces the caller found up in
 *   systemd; it only feeds the §5.4 warning.
 * @returns {{outputFile: string, stats: Record<string, unknown>, warnings: string[],
 *   config: Record<string, unknown>, summary: string, wasDirty: boolean}}
 */
export function generate(model, options = {}) {
  if (model.path === null) {
    throw new ConfigError('сначала сохраните webui.json: генерация запускается по файлу');
  }
  const wasDirty = model.dirty;
  const result = generateConfigFile(model.path, {
    ...options,
    providersRoot: resolvedProvidersRoot(model),
  });
  return {
    ...result,
    summary: formatStats(result.outputFile, result.stats, result.warnings),
    wasDirty,
  };
}

/**
 * Merges a nested block field by field, keeping unknown fields. Reference:
 * `_update_mapping`.
 *
 * @param {Record<string, unknown>} body
 * @param {string} key
 * @param {Record<string, unknown>} values
 */
function updateMapping(body, key, values) {
  requireMapping(values, key);
  if (!isMapping(body[key])) body[key] = {};
  for (const [field, value] of Object.entries(values)) {
    body[key][field] = value;
  }
}

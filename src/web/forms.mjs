// Parsing of HTML form bodies into the typed values the model expects.
//
// This is a presentation concern and it lives in the view layer on purpose: the
// model is strict about types (the core rejects `"54321"` with the wording of the
// reference), while a browser only ever sends strings. Everything that can be
// rejected is rejected here, with the same Russian wording the core uses, so the
// form shows one kind of message no matter where the check happened.

import {ConfigError, PROXY_TYPES} from '../core/errors.mjs';

/**
 * Splits a textarea into a list of non-empty trimmed lines. Used for
 * `exclude_from_auto` and for route domains.
 *
 * @param {unknown} text
 * @returns {string[]}
 */
export function lines(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Reads a checkbox value. An unchecked box is simply absent from the body.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function checkbox(value) {
  return value === '1' || value === 'true' || value === 'on';
}

/**
 * Parses a port field.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function port(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) {
    throw new ConfigError(`port должен быть целым числом, получено '${text}'`);
  }
  const parsed = Number(text);
  if (!(parsed > 0 && parsed < 65536)) {
    throw new ConfigError(`порт ${parsed} вне диапазона 1..65535`);
  }
  return parsed;
}

/**
 * Parses an integer field of the urltest block.
 *
 * @param {unknown} value
 * @param {string} field
 * @returns {number}
 */
export function integer(value, field) {
  const text = String(value ?? '').trim();
  if (!/^-?\d+$/.test(text)) {
    throw new ConfigError(`${field} должен быть целым числом, получено '${text}'`);
  }
  return Number(text);
}

/**
 * Normalises a `<select multiple>`: one option arrives as a string, several as
 * an array, none as undefined.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function selection(value) {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map((item) => String(item));
}

/**
 * Parses the proxy form.
 *
 * @param {Record<string, unknown>} body
 * @returns {{tag: string, type: string, port: number, servers: string[], note: string}}
 */
export function parseProxyForm(body) {
  const type = String(body.type ?? '');
  if (!PROXY_TYPES.includes(type)) {
    throw new ConfigError(
      `неизвестный тип '${type}' (ожидается ${PROXY_TYPES.join('|')})`,
    );
  }
  const tag = String(body.tag ?? '').trim();
  if (tag.length === 0) {
    throw new ConfigError('не указан тег (tag) или это не строка');
  }

  return {
    tag,
    type,
    port: port(body.port),
    servers: selection(body.servers),
    note: String(body.note ?? '').trim(),
  };
}

/**
 * Parses the route form.
 *
 * @param {Record<string, unknown>} body
 * @returns {{name: string, outbound: string, domains: string[], note: string}}
 */
export function parseRouteForm(body) {
  return {
    name: String(body.name ?? '').trim(),
    outbound: String(body.outbound ?? '').trim(),
    domains: lines(body.domains),
    note: String(body.note ?? '').trim(),
  };
}

/**
 * Parses the general/defaults form. Both forms carry the same fields, only the
 * destination differs.
 *
 * @param {Record<string, unknown>} body
 * @returns {{listen_ip: string, urltest: Record<string, unknown>,
 *   log: Record<string, unknown>, exclude_from_auto: string[]}}
 */
export function parseGeneralForm(body) {
  return {
    listen_ip: String(body.listen_ip ?? '').trim(),
    urltest: {
      url: String(body.urltest_url ?? '').trim(),
      interval: String(body.urltest_interval ?? '').trim(),
      tolerance: integer(body.urltest_tolerance, 'urltest.tolerance'),
    },
    log: {
      level: String(body.log_level ?? '').trim(),
      timestamp: checkbox(body.log_timestamp),
    },
    exclude_from_auto: lines(body.exclude_from_auto),
  };
}

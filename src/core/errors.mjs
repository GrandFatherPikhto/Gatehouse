// Core error type and shared constants of the generator.
//
// Port of the reference implementation (Python):
//   /home/yevstigneyevda/Projects/Python/SingBoxTools/sing_box_manager.py
// The reference raised its own ConfigError for every configuration problem;
// the port does the same, so callers never have to parse strings.

/**
 * Configuration error: printed to stderr, the process exits with code 1.
 * Reference: `class ConfigError(Exception)`.
 */
export class ConfigError extends Error {
  /**
   * @param {string} message Human readable reason, worded exactly as in the
   *   reference so that the ported tests keep matching the same substrings.
   */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Allowed inbound (proxy) types.
 *
 * Single source of truth: `schemas/webui.schema.json` repeats this list in its
 * `enum`, and a test asserts that the two never drift apart.
 * Reference: `ALLOWED_PROXY_TYPES = ("socks", "http", "mixed")`.
 */
export const PROXY_TYPES = Object.freeze(['socks', 'http', 'mixed']);

/** Tag prefixes kept out of auto-select. Reference: `DEFAULT_EXCLUDE`. */
export const DEFAULT_EXCLUDE = Object.freeze(['🇷🇺']);

/** Default settings file name. Reference: `DEFAULT_SETTINGS = "settings.yaml"`. */
export const DEFAULT_SETTINGS_FILE = 'webui.json';

/** True for a JSON object (`dict` in the reference), false for arrays and null. */
export function isMapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `type(value).__name__` of the reference, for the values JSON can carry.
 * Used to keep the wording of the ported error messages identical.
 */
export function pythonTypeName(value) {
  if (value === null || value === undefined) return 'NoneType';
  if (Array.isArray(value)) return 'list';
  switch (typeof value) {
    case 'string':
      return 'str';
    case 'boolean':
      return 'bool';
    case 'number':
      return Number.isInteger(value) ? 'int' : 'float';
    case 'object':
      return 'dict';
    default:
      return typeof value;
  }
}

/** `str(value)` of the reference, for the values JSON can carry. */
export function pythonStr(value) {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (Array.isArray(value) || typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** `repr(value)` of the reference: strings gain the single quotes. */
export function pythonRepr(value) {
  if (typeof value === 'string') return `'${value}'`;
  return pythonStr(value);
}

/**
 * Python truthiness for JSON values.
 *
 * Differs from JS on purpose: `{}` and `[]` are falsy in Python, and the
 * reference relies on that (`if not dns_cfg:`, `"log": log_cfg or {}`).
 */
export function pyTruthy(value) {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'number') return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

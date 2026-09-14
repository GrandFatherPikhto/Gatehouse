// VLESS link parsing and the links file reader.
//
// Port of `get_first`, `parse_vless`, `dedup_tags` and `parse_links` from
// /home/yevstigneyevda/Projects/Python/SingBoxTools/sing_box_manager.py
//
// `new URL()` is deliberately NOT used here. The probe in techdocs/url-probe.md
// showed WHATWG parsing keeps the host case (`FI.Example.COM`) and the IPv6
// brackets (`[2001:db8::1]`), while urllib.parse lowercases the host and
// unwraps the literal. Both values land in `config.json` as `server`, so the
// byte-level acceptance would fail. The authority is parsed by hand instead,
// mirroring urllib.parse: IPv6 brackets unwrapped, host lowercased, userinfo
// kept as written.

import fs from 'node:fs';

import {ConfigError} from './errors.mjs';

const SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const ASCII_DIGITS = /^[0-9]+$/;
const HEX_PAIR = /^[0-9A-Fa-f]{2}$/;
const LINE_BREAK = /\r\n|\r|\n/;

//: Exactly the characters Python's `str.strip()` removes: `str.isspace()` is
//: Unicode-aware and, unlike JS `trim()`, does NOT treat U+FEFF (BOM) or
//: U+001C..U+001F as whitespace. `trim()` would silently repair a BOM-prefixed
//: links file that the reference skips, which is a byte-level difference.
const PY_WHITESPACE = '\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000';
const PY_WHITESPACE_HEAD = new RegExp(`^[${PY_WHITESPACE}]+`);
const PY_WHITESPACE_TAIL = new RegExp(`[${PY_WHITESPACE}]+$`);

/**
 * `str.strip()` of the reference: strips Python whitespace from both ends.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function pythonStrip(value) {
  return String(value).replace(PY_WHITESPACE_HEAD, '').replace(PY_WHITESPACE_TAIL, '');
}

/**
 * Reads the first value of a query parameter, like the reference `get_first`.
 *
 * The reference relied on `parse_qs` dropping empty values; here `get` returns
 * an empty string for `sni=`. Trimming and falling back to `default` makes both
 * behaviours identical, which is exactly what the reference did.
 *
 * @param {URLSearchParams|Record<string, unknown>|null|undefined} query
 * @param {string} key
 * @param {string} defaultValue
 * @returns {string}
 */
export function getFirst(query, key, defaultValue = '') {
  if (query === null || query === undefined) return defaultValue;
  let raw;
  if (typeof query.get === 'function') {
    const found = query.get(key);
    raw = found === null || found === undefined ? '' : String(found);
  } else {
    const found = query[key];
    raw = Array.isArray(found) ? (found.length > 0 ? String(found[0]) : '') : found;
    raw = raw === null || raw === undefined ? '' : String(raw);
  }
  const clean = pythonStrip(raw);
  return clean || defaultValue;
}

/**
 * `urllib.parse.unquote` with a default `errors='replace'`.
 *
 * `decodeURIComponent` is not usable: it throws on malformed escapes like
 * `%zz`, while the reference keeps such text literally. Non-ASCII characters
 * are passed through untouched, and malformed UTF-8 bytes produced by the
 * escapes become U+FFFD — the same split into ASCII runs Python performs.
 *
 * @param {string} text
 * @returns {string}
 */
export function unquote(text) {
  const source = String(text);
  if (!source.includes('%')) return source;

  // ignoreBOM: true — TextDecoder otherwise strips a leading U+FEFF, while the
  // Python utf-8 codec keeps it (only utf-8-sig removes it).
  const decoder = new TextDecoder('utf-8', {ignoreBOM: true});
  let result = '';
  let asciiBytes = [];
  const flushAscii = () => {
    if (asciiBytes.length > 0) {
      result += decoder.decode(Uint8Array.from(asciiBytes));
      asciiBytes = [];
    }
  };

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '%' && HEX_PAIR.test(source.slice(index + 1, index + 3))) {
      asciiBytes.push(Number.parseInt(source.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    const codePoint = source.codePointAt(index);
    if (codePoint <= 0x7f) {
      asciiBytes.push(codePoint);
      continue;
    }
    flushAscii();
    result += source[index];
  }
  flushAscii();
  return result;
}

/**
 * Decodes UTF-8 the way Python's `errors="ignore"` does: invalid bytes are
 * dropped, not replaced.
 *
 * The reference read the links file with `errors="ignore"`, while Node's
 * `readFileSync(path, 'utf8')` would insert U+FFFD into a tag. Subtracting the
 * two would show up as a byte difference in `config.json`.
 *
 * @param {Uint8Array} buffer
 * @returns {string}
 */
export function decodeUtf8Ignore(buffer) {
  const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
  let result = '';
  let index = 0;
  while (index < buffer.length) {
    const lead = buffer[index];
    let size = 0;
    if (lead < 0x80) size = 1;
    else if (lead >= 0xc2 && lead <= 0xdf) size = 2;
    else if (lead >= 0xe0 && lead <= 0xef) size = 3;
    else if (lead >= 0xf0 && lead <= 0xf4) size = 4;
    if (size === 0) {
      index += 1;
      continue;
    }
    const sequence = buffer.subarray(index, index + size);
    if (sequence.length < size) {
      index += 1;
      continue;
    }
    try {
      result += decoder.decode(sequence);
      index += size;
    } catch {
      index += 1;
    }
  }
  return result;
}

/**
 * Splits a URL into scheme, netloc, query and fragment, roughly as
 * `urllib.parse` does: the fragment is cut first, the netloc exists only after
 * `//` and ends at `/` or `?`.
 *
 * @param {string} rawUrl
 * @returns {{scheme: string, netloc: string, query: string, fragment: string}}
 */
export function splitVlessUrl(rawUrl) {
  const text = pythonStrip(rawUrl);
  const schemeMatch = SCHEME_PATTERN.exec(text);
  const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : '';
  let rest = schemeMatch ? text.slice(schemeMatch[0].length) : text;

  let fragment = '';
  const fragmentAt = rest.indexOf('#');
  if (fragmentAt !== -1) {
    fragment = rest.slice(fragmentAt + 1);
    rest = rest.slice(0, fragmentAt);
  }

  let netloc = '';
  if (rest.startsWith('//')) {
    rest = rest.slice(2);
    const netlocEnd = rest.search(/[/?]/);
    if (netlocEnd === -1) {
      netloc = rest;
      rest = '';
    } else {
      netloc = rest.slice(0, netlocEnd);
      rest = rest.slice(netlocEnd);
    }
  }

  let query = '';
  const queryAt = rest.indexOf('?');
  if (queryAt !== -1) query = rest.slice(queryAt + 1);

  return {scheme, netloc, query, fragment};
}

/**
 * Splits the netloc into userinfo and host:port, mirroring `urlparse`:
 * the userinfo is everything before the LAST `@`, the username everything
 * before the first `:`, the password is unused, and the host is lowercased.
 *
 * @param {string} netloc
 * @returns {{username: string, hostname: string, portText: string|null}}
 */
export function splitNetloc(netloc) {
  const at = netloc.lastIndexOf('@');
  const userinfo = at === -1 ? '' : netloc.slice(0, at);
  const hostport = at === -1 ? netloc : netloc.slice(at + 1);
  const colonInUserinfo = userinfo.indexOf(':');
  const username = colonInUserinfo === -1 ? userinfo : userinfo.slice(0, colonInUserinfo);

  let hostname = '';
  let portText = null;
  if (hostport.startsWith('[')) {
    const close = hostport.indexOf(']');
    if (close === -1) {
      hostname = '';
      portText = null;
    } else {
      hostname = hostport.slice(1, close).toLowerCase();
      const tail = hostport.slice(close + 1);
      portText = tail.startsWith(':') ? tail.slice(1) : null;
    }
  } else {
    const splitAt = hostport.indexOf(':');
    hostname = (splitAt === -1 ? hostport : hostport.slice(0, splitAt)).toLowerCase();
    portText = splitAt === -1 ? null : hostport.slice(splitAt + 1);
  }
  if (portText === '') portText = null;
  return {username, hostname, portText};
}

/**
 * Resolves the port the way the reference did.
 *
 * `parsed.port` raises ValueError for non-digit and out-of-range values, which
 * the reference caught and turned into a skipped link; and `port if port else 443`
 * turns an explicit port 0 into 443 as well.
 *
 * @param {string|null} portText
 * @returns {number}
 */
function resolvePort(portText) {
  if (portText === null) return 443;
  if (!ASCII_DIGITS.test(portText)) {
    throw new Error(`Port could not be cast to integer value as '${portText}'`);
  }
  const port = Number.parseInt(portText, 10);
  if (!(port >= 0 && port <= 65535)) throw new Error('Port out of range 0-65535');
  return port === 0 ? 443 : port;
}

/**
 * Parses one VLESS link into a sing-box outbound, or null when the link must be
 * skipped. Skipped links are not errors: a warning is collected instead, which
 * is what the reference printed to stderr.
 *
 * @param {string} rawUrl
 * @param {string[]} [warnings] Collector for non-fatal problems.
 * @returns {Record<string, unknown>|null}
 */
export function parseVless(rawUrl, warnings = []) {
  const preview = pythonStrip(rawUrl).slice(0, 80);
  try {
    const parts = splitVlessUrl(rawUrl);
    if (parts.scheme !== 'vless') return null;

    const {username: uuid, hostname: server, portText} = splitNetloc(parts.netloc);
    if (!uuid || !server) {
      warnings.push(`Пропущена ссылка без UUID или сервера: ${preview}`);
      return null;
    }

    const port = resolvePort(portText);
    const tag = parts.fragment ? unquote(parts.fragment) : `vpnd-${server}`;
    const query = new URLSearchParams(parts.query);
    const security = getFirst(query, 'security');

    const outbound = {
      type: 'vless',
      tag,
      server,
      server_port: port,
      uuid,
    };

    if (security === 'reality') {
      const pbk = getFirst(query, 'pbk');
      if (!pbk) {
        warnings.push(`Пропущена reality-ссылка без pbk: ${preview}`);
        return null;
      }
      outbound.flow = getFirst(query, 'flow', 'xtls-rprx-vision');
      outbound.tls = {
        enabled: true,
        server_name: getFirst(query, 'sni'),
        utls: {enabled: true, fingerprint: getFirst(query, 'fp', 'chrome')},
        reality: {
          enabled: true,
          public_key: pbk,
          short_id: getFirst(query, 'sid'),
        },
      };
    } else if (security === 'tls') {
      outbound.tls = {
        enabled: true,
        server_name: getFirst(query, 'sni'),
        utls: {enabled: true, fingerprint: getFirst(query, 'fp', 'chrome')},
      };
    }
    // Without security (plain tcp) neither flow nor tls is set at all.

    return outbound;
  } catch (error) {
    warnings.push(`Ошибка парсинга ссылки: ${error.message}`);
    return null;
  }
}

/**
 * Renames duplicate tags in place to `tag #2`, `tag #3`, ...
 * Reference: `dedup_tags` (mutates the list it is given).
 *
 * @param {Array<Record<string, unknown>>} outbounds
 */
export function dedupTags(outbounds) {
  const seen = new Map();
  for (const outbound of outbounds) {
    const base = outbound.tag;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    if (count > 1) outbound.tag = `${base} #${count}`;
  }
}

/**
 * Reads the links file and returns the outbounds (throws ConfigError when there
 * is nothing usable). Blank lines are skipped silently, unparsable links become
 * warnings.
 *
 * @param {string} filePath
 * @param {string[]} [warnings]
 * @returns {Array<Record<string, unknown>>}
 */
export function parseLinks(filePath, warnings = []) {
  if (!fs.existsSync(filePath)) {
    throw new ConfigError(`файл ссылок ${filePath} не найден`);
  }

  let text;
  try {
    text = decodeUtf8Ignore(fs.readFileSync(filePath));
  } catch (error) {
    throw new ConfigError(`ошибка чтения ${filePath}: ${error.message}`);
  }

  const outbounds = [];
  // Python opened the file in text mode, so universal newlines turned \r\n and
  // a lone \r into \n before readlines() split the text.
  for (const line of text.split(LINE_BREAK)) {
    if (!pythonStrip(line)) continue;
    const outbound = parseVless(line, warnings);
    if (outbound) outbounds.push(outbound);
  }

  if (outbounds.length === 0) {
    throw new ConfigError('валидных VLESS-ссылок не обнаружено');
  }

  dedupTags(outbounds);
  return outbounds;
}

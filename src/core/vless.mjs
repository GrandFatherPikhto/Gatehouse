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

/** Transport parameter values sing-box accepts, mapped to the internal kind. */
const TRANSPORT_TYPES = Object.freeze({
  ws: 'ws',
  grpc: 'grpc',
  httpupgrade: 'httpupgrade',
  http: 'http',
  h2: 'http',
  quic: 'quic',
});

/** Human names of the transports, for `transportLabel`. */
const TRANSPORT_LABELS = Object.freeze({
  ws: 'WS',
  grpc: 'gRPC',
  httpupgrade: 'HTTPUpgrade',
  http: 'HTTP',
  quic: 'QUIC',
});

/** Values `providers.<id>.overrides.fp` accepts; the schema repeats the list. */
export const UTLS_FINGERPRINTS = Object.freeze([
  'chrome',
  'firefox',
  'safari',
  'edge',
  'ios',
  'android',
  'random',
  'randomized',
]);

/**
 * A label for one link that NEVER leaks the UUID: the name from the `#fragment`
 * when there is one, the `host:port` otherwise. Every skip message carries this
 * label, so a warning can be shown to the owner without printing a credential.
 *
 * @param {string} rawUrl
 * @returns {string}
 */
export function linkLabel(rawUrl) {
  try {
    const parts = splitVlessUrl(rawUrl);
    if (parts.fragment) {
      const name = unquote(parts.fragment).trim();
      if (name.length > 0) return name;
    }
    const {hostname, portText} = splitNetloc(parts.netloc);
    if (hostname) return portText === null ? `${hostname}:443` : `${hostname}:${portText}`;
  } catch {
    // A link too broken to label falls back to a neutral word.
  }
  return 'ссылка';
}

/**
 * Records a skipped link as a warning string (for the generator) and as a
 * structured `{label, reason}` record (for the panel).
 *
 * @param {string[]} warnings
 * @param {Array<{label: string, reason: string}>} skipped
 * @param {string} label
 * @param {string} reason
 * @returns {null}
 */
function skipLink(warnings, skipped, label, reason) {
  warnings.push(`${label}: ${reason}`);
  skipped.push({label, reason});
  return null;
}

/**
 * The transport kind of an outbound: `tcp` when it carries no `transport`.
 *
 * @param {Record<string, unknown>} outbound
 * @returns {string}
 */
export function transportKind(outbound) {
  const type = outbound && outbound.transport ? outbound.transport.type : undefined;
  return typeof type === 'string' && type.length > 0 ? type : 'tcp';
}

/**
 * The protocol label of one server, for the panel: `<protection>` for a bare
 * TCP server, `<protection> · <transport>` otherwise. The three protection
 * values are `Reality`, `TLS` and `без шифрования`.
 *
 * @param {Record<string, unknown>} outbound
 * @returns {string}
 */
export function transportLabel(outbound) {
  const tls = outbound ? outbound.tls : null;
  const protection =
    tls && tls.reality && tls.reality.enabled
      ? 'Reality'
      : tls && tls.enabled
        ? 'TLS'
        : 'без шифрования';
  const name = TRANSPORT_LABELS[transportKind(outbound)];
  return name === undefined ? protection : `${protection} · ${name}`;
}

/**
 * Rebuilds an outbound in the canonical key order of the generator:
 * `type, tag, server, server_port, uuid, flow?, tls?, transport?`. JS keeps
 * string key insertion order, so this is what keeps `config.json` byte-stable
 * when a key is added after the fact (an override of `flow`, for example).
 *
 * @param {Record<string, unknown>} outbound
 * @returns {Record<string, unknown>}
 */
function canonicalOutbound(outbound) {
  const ordered = {
    type: outbound.type,
    tag: outbound.tag,
    server: outbound.server,
    server_port: outbound.server_port,
    uuid: outbound.uuid,
  };
  if (outbound.flow !== undefined) ordered.flow = outbound.flow;
  if (outbound.tls !== undefined) ordered.tls = outbound.tls;
  if (outbound.transport !== undefined) ordered.transport = outbound.transport;
  return ordered;
}

/**
 * Builds the `ws` transport of a link, including the Xray early-data form: an
 * `?ed=<number>` in the path becomes `max_early_data` +
 * `early_data_header_name` and is removed from the path, while every other query
 * parameter is kept untouched.
 *
 * @param {URLSearchParams} query
 * @returns {Record<string, unknown>}
 */
function buildWsTransport(query) {
  let path = unquote(getFirst(query, 'path') || '/');
  let maxEarlyData;
  const mark = path.indexOf('?');
  if (mark !== -1) {
    const base = path.slice(0, mark);
    const kept = [];
    for (const piece of path.slice(mark + 1).split('&')) {
      const eq = piece.indexOf('=');
      const key = eq === -1 ? piece : piece.slice(0, eq);
      const value = eq === -1 ? '' : piece.slice(eq + 1);
      if (key === 'ed' && /^\d+$/.test(value)) maxEarlyData = Number(value);
      else kept.push(piece);
    }
    path = kept.length > 0 ? `${base}?${kept.join('&')}` : base;
  }

  const transport = {type: 'ws', path};
  const host = getFirst(query, 'host');
  if (host) transport.headers = {Host: host};
  if (maxEarlyData !== undefined) {
    transport.max_early_data = maxEarlyData;
    transport.early_data_header_name = 'Sec-WebSocket-Protocol';
  }
  return transport;
}

/**
 * Applies the per-subscription `overrides` (§2.5) to one parsed outbound and
 * returns a new object in the canonical key order.
 *
 * `flow` only concerns links over TCP (`type` absent / `tcp` / `raw`): `vision`
 * forces `xtls-rprx-vision`, `none` removes it, anything else keeps the link as
 * parsed. `fp` rewrites `tls.utls.fingerprint` of every link that carries `tls`.
 *
 * @param {Record<string, unknown>} outbound
 * @param {{flow?: string, fp?: string}} [overrides]
 * @returns {Record<string, unknown>}
 */
export function applyOverrides(outbound, overrides = {}) {
  const next = {...outbound};
  if ((overrides.flow === 'vision' || overrides.flow === 'none') && transportKind(next) === 'tcp') {
    if (overrides.flow === 'vision') next.flow = 'xtls-rprx-vision';
    else delete next.flow;
  }
  if (typeof overrides.fp === 'string' && next.tls && next.tls.utls) {
    next.tls = {...next.tls, utls: {...next.tls.utls, fingerprint: overrides.fp}};
  }
  return canonicalOutbound(next);
}

/**
 * Parses one VLESS link into a sing-box outbound, or null when the link must be
 * skipped. Skipped links are not errors: each becomes a warning (for the
 * generator) and a `{label, reason}` record (for the panel). A `#`-comment line
 * and a line without a scheme are skipped silently, as the owner expects.
 *
 * @param {string} rawUrl
 * @param {string[]} [warnings] Collector for non-fatal problems.
 * @param {Array<{label: string, reason: string}>} [skipped] Structured skips.
 * @returns {Record<string, unknown>|null}
 */
export function parseVless(rawUrl, warnings = [], skipped = []) {
  let label = 'ссылка';
  try {
    const parts = splitVlessUrl(rawUrl);
    if (parts.scheme === '') return null; // blank, `#…` and non-URL lines
    if (parts.scheme !== 'vless') {
      label = linkLabel(rawUrl);
      return skipLink(warnings, skipped, label, 'не vless://-ссылка, пропущена');
    }

    label = linkLabel(rawUrl);
    const {username: uuid, hostname: server, portText} = splitNetloc(parts.netloc);
    if (!uuid || !server) {
      return skipLink(warnings, skipped, label, 'ссылка без UUID или сервера');
    }

    const port = resolvePort(portText);
    const tag = parts.fragment ? unquote(parts.fragment) : `vpnd-${server}`;
    const query = new URLSearchParams(parts.query);

    const securityRaw = getFirst(query, 'security');
    const security = securityRaw.toLowerCase();

    const insecure = getFirst(query, 'allowInsecure') || getFirst(query, 'insecure');
    if (insecure === '1' || insecure.toLowerCase() === 'true') {
      return skipLink(
        warnings,
        skipped,
        label,
        'отключение проверки сертификата не поддерживается сознательно',
      );
    }

    if (security !== '' && security !== 'none' && security !== 'tls' && security !== 'reality') {
      return skipLink(warnings, skipped, label, `неизвестный security '${securityRaw}'`);
    }

    // --- transport ---------------------------------------------------------
    const typeRaw = getFirst(query, 'type');
    const type = typeRaw.toLowerCase();
    let kind = 'tcp';
    if (type === '' || type === 'tcp' || type === 'raw') kind = 'tcp';
    else if (Object.hasOwn(TRANSPORT_TYPES, type)) kind = TRANSPORT_TYPES[type];
    else {
      return skipLink(
        warnings,
        skipped,
        label,
        `неизвестный транспорт '${typeRaw}': sing-box его не поддерживает`,
      );
    }

    const headerType = getFirst(query, 'headerType');
    if (kind === 'tcp' && headerType && headerType.toLowerCase() !== 'none') {
      return skipLink(
        warnings,
        skipped,
        label,
        `HTTP-маскировка (headerType=${headerType}) не поддерживается`,
      );
    }

    let transport;
    if (kind === 'ws') {
      transport = buildWsTransport(query);
    } else if (kind === 'grpc') {
      const serviceName = getFirst(query, 'serviceName');
      if (!serviceName) {
        return skipLink(warnings, skipped, label, 'grpc без serviceName: некуда подключиться');
      }
      transport = {type: 'grpc', service_name: serviceName};
    } else if (kind === 'httpupgrade') {
      transport = {type: 'httpupgrade', path: unquote(getFirst(query, 'path') || '/')};
      const host = getFirst(query, 'host');
      if (host) transport.host = host;
    } else if (kind === 'http') {
      const hosts = getFirst(query, 'host')
        .split(',')
        .map((host) => host.trim())
        .filter((host) => host.length > 0);
      transport = {type: 'http'};
      if (hosts.length > 0) transport.host = hosts;
      transport.path = unquote(getFirst(query, 'path'));
    } else if (kind === 'quic') {
      const quicSecurity = getFirst(query, 'quicSecurity');
      if (quicSecurity && quicSecurity.toLowerCase() !== 'none') {
        return skipLink(
          warnings,
          skipped,
          label,
          `quic: quicSecurity '${quicSecurity}' не поддерживается`,
        );
      }
      if (headerType && headerType.toLowerCase() !== 'none') {
        return skipLink(
          warnings,
          skipped,
          label,
          `quic: headerType '${headerType}' не поддерживается`,
        );
      }
      transport = {type: 'quic'};
    }

    // --- flow: Vision works only over bare TCP -----------------------------
    const flowInLink = getFirst(query, 'flow');
    let flow;
    if (kind === 'tcp') {
      if (security === 'reality') flow = flowInLink || 'xtls-rprx-vision';
      else if (security === 'tls') flow = flowInLink || undefined;
    } else if (flowInLink) {
      warnings.push(`${label}: flow '${flowInLink}' отброшен: Vision работает только поверх TCP`);
      skipped.push({
        label,
        reason: `flow '${flowInLink}' отброшен: Vision работает только поверх TCP`,
      });
    }

    // --- security ----------------------------------------------------------
    let tls;
    if (security === 'reality') {
      const pbk = getFirst(query, 'pbk');
      if (!pbk) return skipLink(warnings, skipped, label, 'reality-ссылка без pbk');
      tls = {
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
      tls = {
        enabled: true,
        server_name: getFirst(query, 'sni'),
        utls: {enabled: true, fingerprint: getFirst(query, 'fp', 'chrome')},
      };
    }

    if (tls) {
      const alpn = getFirst(query, 'alpn')
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      if (alpn.length > 0) tls.alpn = alpn;
    }

    const outbound = {type: 'vless', tag, server, server_port: port, uuid};
    if (flow !== undefined) outbound.flow = flow;
    if (tls !== undefined) outbound.tls = tls;
    if (transport !== undefined) outbound.transport = transport;
    return outbound;
  } catch (error) {
    return skipLink(warnings, skipped, label, `Ошибка парсинга ссылки: ${error.message}`);
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
 * Warning emitted when the links file starts with a byte order mark.
 * The reference prints the very same text to stderr.
 */
export const BOM_WARNING =
  'Предупреждение: файл ссылок начинается с BOM (U+FEFF), метка снята.';

/**
 * Reads the links file and returns the outbounds (throws ConfigError when there
 * is nothing usable). Blank lines and `#`-comment lines are skipped silently;
 * unparsable links become warnings and `{label, reason}` records.
 *
 * @param {string} filePath
 * @param {string[]} [warnings]
 * @param {Array<{label: string, reason: string}>} [skipped]
 * @returns {Array<Record<string, unknown>>}
 */
export function parseLinks(filePath, warnings = [], skipped = []) {
  if (!fs.existsSync(filePath)) {
    throw new ConfigError(`файл ссылок ${filePath} не найден`);
  }

  let text;
  try {
    text = decodeUtf8Ignore(fs.readFileSync(filePath));
  } catch (error) {
    throw new ConfigError(`ошибка чтения ${filePath}: ${error.message}`);
  }

  // A BOM makes the first line "\ufeffvless://...", and a scheme it does not
  // recognise means the reference skipped that link without a word — one server
  // quietly missing from the subscription. Exactly one character at the very
  // start of the file is dropped; a BOM anywhere else keeps its old behaviour.
  // `utf-8-sig` is not used on purpose: it would strip the mark silently.
  if (text.startsWith('\ufeff')) {
    text = text.slice(1);
    warnings.push(BOM_WARNING);
  }

  const outbounds = [];
  // Python opened the file in text mode, so universal newlines turned \r\n and
  // a lone \r into \n before readlines() split the text.
  for (const line of text.split(LINE_BREAK)) {
    const stripped = pythonStrip(line);
    if (!stripped) continue;
    // A `#` line is a comment the owner uses to switch a server off by hand.
    if (stripped.startsWith('#')) continue;
    const outbound = parseVless(line, warnings, skipped);
    if (outbound) outbounds.push(outbound);
  }

  if (outbounds.length === 0) {
    throw new ConfigError('валидных VLESS-ссылок не обнаружено');
  }

  dedupTags(outbounds);
  return outbounds;
}

/**
 * Decodes a `#profile-title` value: Happ/v2RayTun write it as `base64:<…>`, and
 * anything else is taken as it stands. A malformed payload is returned literally
 * rather than dropped — the owner sees what the file holds.
 *
 * @param {string} value
 * @returns {string}
 */
function decodeProfileTitle(value) {
  const text = String(value ?? '').trim();
  if (!text.toLowerCase().startsWith('base64:')) return text;
  try {
    const decoded = Buffer.from(text.slice('base64:'.length).trim(), 'base64').toString('utf8');
    // A decoded string of replacement characters means the payload is not UTF-8
    // text; the raw value is more honest than mojibake.
    return decoded.includes('\ufffd') ? text : decoded;
  } catch {
    return text;
  }
}

/**
 * Reads the `expire=<unix>` of `#subscription-userinfo`, or `null`.
 *
 * @param {string} value
 * @returns {number|null}
 */
function decodeUserinfoExpire(value) {
  const match = /(?:^|;)\s*expire=(\d+)\s*(?:;|$)/.exec(String(value ?? ''));
  if (match === null) return null;
  const seconds = Number.parseInt(match[1], 10);
  // `expire=0` means "no date", exactly like a missing field.
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * Reads the human headers of a subscription `links.txt` (Happ / v2RayTun): the
 * profile title and the expiry date. Pure: it takes the file TEXT and touches no
 * filesystem, and it never reaches `config.json` — the `#` lines stay comments
 * for `parseLinks`, untouched.
 *
 * @param {string} text
 * @returns {{title: string|null, expire: number|null}} `expire` in unix seconds.
 */
export function parseSubscriptionHeaders(text) {
  const result = {title: null, expire: null};
  for (const line of String(text ?? '').split(LINE_BREAK)) {
    const trimmed = pythonStrip(line);
    if (!trimmed.startsWith('#')) continue;
    const body = trimmed.slice(1).trim();
    const colon = body.indexOf(':');
    if (colon < 0) continue;
    const key = body.slice(0, colon).trim().toLowerCase();
    const value = body.slice(colon + 1).trim();
    if (key === 'profile-title' && value.length > 0) result.title = decodeProfileTitle(value);
    else if (key === 'subscription-userinfo') result.expire = decodeUserinfoExpire(value);
  }
  return result;
}

/**
 * Turns the `expire` of a subscription into what the interface needs: the date,
 * how many days are left, whether it has passed, and whether it is close enough
 * to warn about (§3.6). Pure and clock-injectable, so a test never depends on
 * the wall clock. `null` for a missing or zero `expire` — "no date", not a
 * fake one.
 *
 * @param {number|null} expire Unix seconds, as `parseSubscriptionHeaders` returns.
 * @param {number} [now] Now in milliseconds; defaults to the system clock.
 * @returns {{date: string, daysLeft: number, expired: boolean, soon: boolean}|null}
 */
export function subscriptionExpiry(expire, now = Date.now()) {
  const seconds = Number(expire);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (number) => String(number).padStart(2, '0');
  const formatted = `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;

  // Compare by calendar day: an expiry at 23:00 is still "today", not "in 0
  // days" the moment midnight passes on the expiry date itself.
  const dayMs = 24 * 60 * 60 * 1000;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const expiryDay = new Date(date.getTime());
  expiryDay.setHours(0, 0, 0, 0);
  const daysLeft = Math.round((expiryDay.getTime() - today.getTime()) / dayMs);
  return {date: formatted, daysLeft, expired: daysLeft < 0, soon: daysLeft >= 0 && daysLeft <= 14};
}

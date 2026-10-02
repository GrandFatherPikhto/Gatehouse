// Hysteria2 links (`hysteria2://` / `hy2://`) of a subscription.
//
// Task plan_2026_10_02_gatehouse_links_xhttp_hysteria2.md §1.1. The scheme is
// NOT sing-box-specific: the same link becomes a sing-box `hysteria2` outbound
// (engine «авто») or an Xray `hysteria` outbound with `version: 2` (engine
// «Xray`). Two builders share one reader of the authority and the parameters, so
// the two engines can never disagree about what the link says.
//
// The parser mirrors `parseVless` on purpose: the same `splitVlessUrl` /
// `splitNetloc` helpers, the same `{label, reason}` skips, the same neutral label
// that never leaks the password. Unknown parameters are ignored silently, as the
// task requires.

import {
  getFirst,
  linkLabel,
  pythonStrip,
  resolvePort,
  skipLink,
  splitNetloc,
  splitVlessUrl,
  unquote,
} from './vless.mjs';

/** Schemes that mean Hysteria2. `hy2` is the short spelling Happ/v2rayN write. */
const HYSTERIA2_SCHEMES = new Set(['hysteria2', 'hy2']);

/**
 * True when the raw line is a Hysteria2 link. Used by the subscription reader to
 * dispatch BEFORE the VLESS parser, which would reject the scheme outright.
 *
 * @param {string} rawUrl
 * @returns {boolean}
 */
export function isHysteria2Link(rawUrl) {
  try {
    return HYSTERIA2_SCHEMES.has(splitVlessUrl(rawUrl).scheme);
  } catch {
    return false;
  }
}

/**
 * The `userinfo` of the authority, url-decoded, and the host/port. `splitNetloc`
 * keeps only the part before the first `:` of the userinfo, which is right for a
 * VLESS UUID; a Hysteria2 password is the WHOLE userinfo, so it is read here from
 * the last `@`.
 *
 * @param {string} netloc
 * @returns {{auth: string, hostname: string, portText: string|null}}
 */
function splitAuthority(netloc) {
  const at = netloc.lastIndexOf('@');
  const auth = at === -1 ? '' : unquote(netloc.slice(0, at));
  const {hostname, portText} = splitNetloc(netloc);
  return {auth, hostname, portText};
}

/**
 * Splits `alpn=h2,h3` into a trimmed, non-empty list.
 *
 * @param {string} value
 * @returns {string[]}
 */
function splitList(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * `mport` — a port range or a list — into the sing-box `server_ports` form: a
 * range `a-b` becomes `"a:b"`, everything else is kept as written.
 *
 * @param {string} value
 * @returns {string[]}
 */
function parsePorts(value) {
  return splitList(value).map((item) => item.replace('-', ':'));
}

/**
 * Parses one Hysteria2 link into a sing-box `hysteria2` outbound, or null when
 * the link must be skipped (§1.1, left column).
 *
 * @param {string} rawUrl
 * @param {string[]} [warnings] Collector for non-fatal problems.
 * @param {Array<{label: string, reason: string}>} [skipped] Structured skips.
 * @returns {Record<string, unknown>|null}
 */
export function parseHysteria2ToSingbox(rawUrl, warnings = [], skipped = []) {
  let label = 'ссылка';
  try {
    const parts = splitVlessUrl(rawUrl);
    if (!HYSTERIA2_SCHEMES.has(parts.scheme)) {
      label = linkLabel(rawUrl);
      return skipLink(warnings, skipped, label, 'не hysteria2://-ссылка, пропущена');
    }
    label = linkLabel(rawUrl);

    const {auth, hostname: server, portText} = splitAuthority(parts.netloc);
    if (!server) return skipLink(warnings, skipped, label, 'ссылка без сервера');

    const port = resolvePort(portText);
    const tag = parts.fragment ? unquote(parts.fragment) : `vpnd-${server}`;
    const query = new URLSearchParams(parts.query);

    const tls = {
      enabled: true,
      server_name: getFirst(query, 'sni') || server,
    };
    const alpn = splitList(getFirst(query, 'alpn'));
    if (alpn.length > 0) tls.alpn = alpn;
    const insecure = getFirst(query, 'insecure');
    if (insecure === '1' || insecure.toLowerCase() === 'true') tls.insecure = true;

    const outbound = {type: 'hysteria2', tag, server, server_port: port};
    if (auth) outbound.password = auth;

    const up = getFirst(query, 'upmbps');
    const down = getFirst(query, 'downmbps');
    if (up) outbound.up_mbps = Number(up);
    if (down) outbound.down_mbps = Number(down);

    outbound.tls = tls;

    const obfs = getFirst(query, 'obfs');
    if (obfs) {
      const obfsBlock = {type: obfs};
      const password = getFirst(query, 'obfs-password');
      if (password) obfsBlock.password = password;
      outbound.obfs = obfsBlock;
    }

    const mport = getFirst(query, 'mport');
    if (mport) outbound.server_ports = parsePorts(mport);

    // `fm` (QUIC settings of Xray) is deliberately NOT applied: sing-box has no
    // equivalent, and the task says to ignore it silently.
    return outbound;
  } catch (error) {
    return skipLink(warnings, skipped, label, `Ошибка парсинга ссылки: ${error.message}`);
  }
}

/**
 * Parses one Hysteria2 link into an Xray `hysteria` outbound with `version: 2`
 * (§1.1, right column), or null when the link must be skipped. `obfs` and
 * `mport` have no Xray equivalent: such a server is skipped WITH a reason,
 * never silently dropped.
 *
 * @param {string} rawUrl
 * @param {string[]} [warnings]
 * @param {Array<{label: string, reason: string}>} [skipped]
 * @returns {Record<string, unknown>|null} A server descriptor, or null.
 */
export function parseHysteria2ToXray(rawUrl, warnings = [], skipped = []) {
  let label = 'ссылка';
  try {
    const parts = splitVlessUrl(rawUrl);
    if (!HYSTERIA2_SCHEMES.has(parts.scheme)) {
      label = linkLabel(rawUrl);
      return skipLink(warnings, skipped, label, 'не hysteria2://-ссылка, пропущена');
    }
    label = linkLabel(rawUrl);

    const {auth, hostname: server, portText} = splitAuthority(parts.netloc);
    if (!server) return skipLink(warnings, skipped, label, 'ссылка без сервера');

    const port = resolvePort(portText);
    const tag = parts.fragment ? unquote(parts.fragment) : `vpnd-${server}`;
    const query = new URLSearchParams(parts.query);

    const obfs = getFirst(query, 'obfs');
    if (obfs) {
      return skipLink(
        warnings,
        skipped,
        label,
        `Xray: obfs '${obfs}' не поддерживается — сервер пропущен`,
      );
    }
    const mport = getFirst(query, 'mport');
    if (mport) {
      return skipLink(warnings, skipped, label, 'Xray: mport не поддерживается — сервер пропущен');
    }

    const tlsSettings = {serverName: getFirst(query, 'sni') || server};
    const alpn = splitList(getFirst(query, 'alpn'));
    if (alpn.length > 0) tlsSettings.alpn = alpn;
    const insecure = getFirst(query, 'insecure');
    if (insecure === '1' || insecure.toLowerCase() === 'true') tlsSettings.allowInsecure = true;
    const fp = getFirst(query, 'fp');
    if (fp) tlsSettings.fingerprint = fp;

    const streamSettings = {
      network: 'hysteria',
      security: 'tls',
      tlsSettings,
      hysteriaSettings: {version: 2},
    };
    if (auth) streamSettings.hysteriaSettings.auth = auth;

    // `fm` is QUIC settings of Xray: carried as-is when it is valid JSON.
    const fm = getFirst(query, 'fm');
    if (fm) {
      let parsed;
      try {
        parsed = JSON.parse(fm);
      } catch (error) {
        return skipLink(warnings, skipped, label, `Xray: окончание fm не JSON — ${error.message}`);
      }
      streamSettings.finalmask = parsed;
    }

    const outbound = {
      protocol: 'hysteria',
      settings: {version: 2, address: server, port},
      streamSettings,
    };
    const descriptor = buildDescriptor(tag, server, port, outbound);
    descriptor.protocol = 'Hysteria2';
    return descriptor;
  } catch (error) {
    return skipLink(warnings, skipped, label, `Ошибка парсинга ссылки: ${error.message}`);
  }
}

/**
 * A server descriptor of a subscription server carried by Xray. The shape
 * mirrors what `readXrayConfigs` produces, so every downstream consumer (ports,
 * name collisions, the panel) treats both alike. For a SUBSCRIPTION the name is
 * the link's `#fragment` (plus the owner suffix) — the same name the server would
 * have had in sing-box, which is what proxies pin.
 *
 * @param {string} tag Base name (the `#fragment`).
 * @param {string} address
 * @param {number} port
 * @param {Record<string, unknown>} outbound
 * @returns {Record<string, unknown>}
 */
export function buildDescriptor(tag, address, port, outbound) {
  return {
    tag,
    hostLabel: String(address ?? '').split('.')[0] ?? '',
    baseName: tag,
    name: tag,
    key: '',
    protocol: null,
    address,
    remotePort: port,
    remark: null,
    outbound,
  };
}

/** `pythonStrip` is re-exported for the sibling reader (`xray-links.mjs`). */
export {pythonStrip};

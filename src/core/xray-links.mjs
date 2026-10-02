// VLESS links turned into Xray OUTBOUNDS.
//
// Task plan_2026_10_02_gatehouse_links_xhttp_hysteria2.md §1.2 and §2. Two uses:
//
//   * engine «авто»: a `vless://…type=xhttp` (or the old `splithttp`) link goes
//     through Xray, because sing-box does not speak XHTTP at all;
//   * engine «Xray»: EVERY vless link of the subscription goes through Xray, and
//     the transport decides which `*Settings` block is written.
//
// The parser mirrors `parseVless` (same authority/splitting helpers, same
// `{label, reason}` skips, the same conscious refusal of `insecure`), but the
// output is the Xray client shape instead of a sing-box outbound. Fields the link
// does not carry are NOT added, so a link rebuilt from the output parses back to
// the same output (the canonical round trip of §5.2).

import {
  getFirst,
  linkLabel,
  resolvePort,
  skipLink,
  splitNetloc,
  splitVlessUrl,
  unquote,
} from './vless.mjs';
import {buildDescriptor} from './hysteria.mjs';
import {xrayProtocolLabel} from './xray.mjs';

/**
 * True when the line is a `vless://…type=xhttp|splithttp` link. The «авто»
 * engine sends exactly these to Xray; everything else stays in sing-box.
 *
 * @param {string} rawUrl
 * @returns {boolean}
 */
export function isXhttpLink(rawUrl) {
  try {
    const parts = splitVlessUrl(rawUrl);
    if (parts.scheme !== 'vless') return false;
    const type = getFirst(new URLSearchParams(parts.query), 'type').toLowerCase();
    return type === 'xhttp' || type === 'splithttp';
  } catch {
    return false;
  }
}

/**
 * `alpn=a,b` into a trimmed, non-empty list.
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
 * The `{path, host?}` block shared by the `ws` and `httpupgrade` transports.
 *
 * @param {URLSearchParams} query
 * @param {string} defaultPath
 * @returns {Record<string, unknown>}
 */
function hostPathSettings(query, defaultPath) {
  const settings = {path: unquote(getFirst(query, 'path') || defaultPath)};
  const host = getFirst(query, 'host');
  if (host) settings.host = host;
  return settings;
}

/**
 * Parses one VLESS link into an Xray outbound (§1.2, §2), or null when the link
 * must be skipped. The returned object is a SERVER DESCRIPTOR shaped like the one
 * `readXrayConfigs` builds for a kind-`xray` provider, so ports, name collisions
 * and the panel handle both alike. For a subscription the name is the link's
 * `#fragment` (plus the owner suffix) — the same name sing-box would have used.
 *
 * @param {string} rawUrl
 * @param {string[]} [warnings] Collector for non-fatal problems.
 * @param {Array<{label: string, reason: string}>} [skipped] Structured skips.
 * @returns {Record<string, unknown>|null}
 */
export function parseVlessToXray(rawUrl, warnings = [], skipped = []) {
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
    if (!uuid || !server) return skipLink(warnings, skipped, label, 'ссылка без UUID или сервера');

    const port = resolvePort(portText);
    const tag = parts.fragment ? unquote(parts.fragment) : `vpnd-${server}`;
    const query = new URLSearchParams(parts.query);

    const securityRaw = getFirst(query, 'security');
    const security = securityRaw.toLowerCase();
    if (security !== '' && security !== 'none' && security !== 'tls' && security !== 'reality') {
      return skipLink(warnings, skipped, label, `неизвестный security '${securityRaw}'`);
    }

    // The same conscious refusal as the sing-box reader: the project never turns
    // certificate checking off.
    const insecure = getFirst(query, 'allowInsecure') || getFirst(query, 'insecure');
    if (insecure === '1' || insecure.toLowerCase() === 'true') {
      return skipLink(
        warnings,
        skipped,
        label,
        'отключение проверки сертификата не поддерживается сознательно',
      );
    }

    const typeRaw = getFirst(query, 'type');
    const type = typeRaw.toLowerCase();
    let network;
    if (type === '' || type === 'tcp' || type === 'raw') network = 'tcp';
    else if (type === 'xhttp' || type === 'splithttp') network = 'xhttp';
    else if (type === 'ws') network = 'ws';
    else if (type === 'grpc') network = 'grpc';
    else if (type === 'httpupgrade') network = 'httpupgrade';
    else {
      return skipLink(warnings, skipped, label, `Xray: транспорт '${typeRaw}' не поддерживается`);
    }

    const headerType = getFirst(query, 'headerType');
    if (network === 'tcp' && headerType && headerType.toLowerCase() !== 'none') {
      return skipLink(
        warnings,
        skipped,
        label,
        `HTTP-маскировка (headerType=${headerType}) не поддерживается`,
      );
    }

    // `flow` lives in `users[0].flow` and is meaningful only over TCP.
    const flowInLink = getFirst(query, 'flow');
    let flow = '';
    if (network === 'tcp') {
      if (security === 'reality') flow = flowInLink || 'xtls-rprx-vision';
      else if (security === 'tls') flow = flowInLink;
    } else if (flowInLink) {
      warnings.push(`${label}: flow '${flowInLink}' отброшен: Vision работает только поверх TCP`);
      skipped.push({
        label,
        reason: `flow '${flowInLink}' отброшен: Vision работает только поверх TCP`,
      });
    }

    const streamSettings = {network};
    if (security === 'tls' || security === 'reality') streamSettings.security = security;

    if (security === 'reality') {
      const pbk = getFirst(query, 'pbk');
      if (!pbk) return skipLink(warnings, skipped, label, 'reality-ссылка без pbk');
      const realitySettings = {publicKey: pbk};
      const sni = getFirst(query, 'sni');
      if (sni) realitySettings.serverName = sni;
      const fp = getFirst(query, 'fp');
      if (fp) realitySettings.fingerprint = fp;
      const alpn = splitList(getFirst(query, 'alpn'));
      if (alpn.length > 0) realitySettings.alpn = alpn;
      const sid = getFirst(query, 'sid');
      if (sid) realitySettings.shortId = sid;
      const spx = getFirst(query, 'spx');
      if (spx) realitySettings.spiderX = spx;
      streamSettings.realitySettings = realitySettings;
    } else if (security === 'tls') {
      const tlsSettings = {};
      const sni = getFirst(query, 'sni');
      if (sni) tlsSettings.serverName = sni;
      const fp = getFirst(query, 'fp');
      if (fp) tlsSettings.fingerprint = fp;
      const alpn = splitList(getFirst(query, 'alpn'));
      if (alpn.length > 0) tlsSettings.alpn = alpn;
      streamSettings.tlsSettings = tlsSettings;
    }

    if (network === 'xhttp') {
      const xhttpSettings = {};
      const host = getFirst(query, 'host');
      if (host) xhttpSettings.host = host;
      const path = getFirst(query, 'path');
      if (path) xhttpSettings.path = unquote(path);
      const mode = getFirst(query, 'mode');
      if (mode) xhttpSettings.mode = mode;
      const extra = getFirst(query, 'extra');
      if (extra) {
        let parsed;
        try {
          parsed = JSON.parse(extra);
        } catch (error) {
          return skipLink(warnings, skipped, label, `XHTTP: extra не JSON — ${error.message}`);
        }
        xhttpSettings.extra = parsed;
      }
      streamSettings.xhttpSettings = xhttpSettings;
    } else if (network === 'ws') {
      streamSettings.wsSettings = hostPathSettings(query, '/');
    } else if (network === 'httpupgrade') {
      streamSettings.httpupgradeSettings = hostPathSettings(query, '/');
    } else if (network === 'grpc') {
      const serviceName = getFirst(query, 'serviceName');
      if (!serviceName) {
        return skipLink(warnings, skipped, label, 'grpc без serviceName: некуда подключиться');
      }
      streamSettings.grpcSettings = {serviceName};
    }

    const user = {
      id: uuid,
      encryption: getFirst(query, 'encryption') || 'none',
      flow,
    };
    const outbound = {
      protocol: 'vless',
      settings: {vnext: [{address: server, port, users: [user]}]},
      streamSettings,
    };
    const descriptor = buildDescriptor(tag, server, port, outbound);
    descriptor.protocol = xrayProtocolLabel(outbound);
    return descriptor;
  } catch (error) {
    return skipLink(warnings, skipped, label, `Ошибка парсинга ссылки: ${error.message}`);
  }
}

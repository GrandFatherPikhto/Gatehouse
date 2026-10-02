// Reads a provider's `links.txt` into TWO lists: the sing-box outbounds and the
// Xray server descriptors of the same subscription.
//
// Task plan_2026_10_02_gatehouse_links_xhttp_hysteria2.md. One file may mix
// schemes and transports, and the chosen engine decides where each server goes:
//
//   * `vless://` with a sing-box transport → a sing-box outbound (as before);
//   * `vless://…type=xhttp|splithttp` → Xray, ALWAYS («авто» sends only these);
//   * `hysteria2://` / `hy2://`          → sing-box in «авто», Xray in «Xray»;
//   * engine «Xray»                      → every vless and hysteria2 server to Xray.
//
// The reading (file, BOM, `#` comments, blank lines) mirrors `parseLinks`, so a
// subscription without xhttp/hysteria2 produces exactly the outbounds it did
// before — the golden `config.json` must not move a byte.

import fs from 'node:fs';

import {ConfigError} from './errors.mjs';
import {isHysteria2Link, parseHysteria2ToSingbox, parseHysteria2ToXray} from './hysteria.mjs';
import {BOM_WARNING, decodeUtf8Ignore, linkLabel, parseVless, pythonStrip, splitVlessUrl} from './vless.mjs';
import {isXhttpLink, parseVlessToXray} from './xray-links.mjs';

const LINE_BREAK = /\r\n|\r|\n/;

/**
 * Russian plural form for the aggregate warning. A local copy on purpose: the
 * reader must not import `sources.mjs`, which imports THIS module.
 *
 * @param {number} count
 * @param {string} one
 * @param {string} few
 * @param {string} many
 * @returns {string}
 */
function pluralRu(count, one, few, many) {
  const n = Math.abs(Math.trunc(Number(count)));
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/**
 * Parses the links file of a subscription into the two engines.
 *
 * @param {string} filePath
 * @param {{engine?: 'auto'|'xray', xrayInstalled?: boolean,
 *   warnings?: string[], skipped?: Array<{label: string, reason: string}>}} [options]
 *   `engine` is the provider's `providers.<id>.engine`; `xrayInstalled` is false
 *   only when the XHTTP servers must be skipped with a warning (engine «авто»).
 * @returns {{outbounds: Array<Record<string, unknown>>,
 *   xrayServers: Array<Record<string, unknown>>}}
 */
export function parseSubscriptionLinks(filePath, options = {}) {
  const engine = options.engine === 'xray' ? 'xray' : 'auto';
  const xrayInstalled = options.xrayInstalled !== false;
  const warnings = options.warnings ?? [];
  const skipped = options.skipped ?? [];

  if (!fs.existsSync(filePath)) {
    throw new ConfigError(`файл ссылок ${filePath} не найден`);
  }

  let text;
  try {
    text = decodeUtf8Ignore(fs.readFileSync(filePath));
  } catch (error) {
    throw new ConfigError(`ошибка чтения ${filePath}: ${error.message}`);
  }

  // A BOM makes the first line "\ufeffvless://…", which no scheme recognises;
  // one character at the very start is dropped, exactly as `parseLinks` did.
  if (text.startsWith('\ufeff')) {
    text = text.slice(1);
    warnings.push(BOM_WARNING);
  }

  const entries = [];
  let xhttpSkipped = 0;

  for (const line of text.split(LINE_BREAK)) {
    const stripped = pythonStrip(line);
    if (!stripped) continue;
    if (stripped.startsWith('#')) continue;

    if (isHysteria2Link(line)) {
      if (engine === 'xray') {
        const server = parseHysteria2ToXray(line, warnings, skipped);
        if (server) entries.push({kind: 'xray', obj: server});
      } else {
        const outbound = parseHysteria2ToSingbox(line, warnings, skipped);
        if (outbound) entries.push({kind: 'singbox', obj: outbound});
      }
      continue;
    }

    const scheme = splitVlessUrl(line).scheme;
    if (scheme === 'vless') {
      if (engine === 'xray') {
        const server = parseVlessToXray(line, warnings, skipped);
        if (server) entries.push({kind: 'xray', obj: server});
        continue;
      }
      if (isXhttpLink(line)) {
        if (!xrayInstalled) {
          // Engine «авто» without Xray on the host: the XHTTP server cannot work,
          // so it is skipped WITH a reason, never silently (task 22 §2).
          xhttpSkipped += 1;
          skipped.push({
            label: linkLabel(line),
            reason: 'Xray не установлен: сервер XHTTP пропущен',
          });
          continue;
        }
        const server = parseVlessToXray(line, warnings, skipped);
        if (server) entries.push({kind: 'xray', obj: server});
        continue;
      }
      const outbound = parseVless(line, warnings, skipped);
      if (outbound) entries.push({kind: 'singbox', obj: outbound});
      continue;
    }

    // Any other scheme is reported by the VLESS parser, exactly as before.
    const outbound = parseVless(line, warnings, skipped);
    if (outbound) entries.push({kind: 'singbox', obj: outbound});
  }

  if (xhttpSkipped > 0) {
    warnings.push(
      `Предупреждение: Xray не установлен: ${xhttpSkipped} ${pluralRu(
        xhttpSkipped,
        'сервер',
        'сервера',
        'серверов',
      )} XHTTP пропущены`,
    );
  }

  // Duplicate names are renamed `tag #2`, `tag #3` … — the VERY same rule
  // `dedupTags` applies, but across both engines, in file order.
  const seen = new Map();
  for (const entry of entries) {
    const base = entry.obj.tag;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    if (count > 1) entry.obj.tag = `${base} #${count}`;
  }

  const outbounds = [];
  const xrayServers = [];
  for (const entry of entries) {
    if (entry.kind === 'xray') xrayServers.push(entry.obj);
    else outbounds.push(entry.obj);
  }

  if (outbounds.length === 0 && xrayServers.length === 0) {
    throw new ConfigError('валидных VLESS-ссылок не обнаружено');
  }
  return {outbounds, xrayServers};
}

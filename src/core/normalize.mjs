// Normaliser of a provider's tunnel config (AmneziaWG / WireGuard).
//
// Pure: text in, text out plus the list of changes. No filesystem, no system
// calls — that is what makes the preview trustworthy and the module testable on
// a synthetic pair (techdocs/architecture.md §7.3, §8.12).
//
// The rules come from §7.3 and split into three sorts:
//
//   * MANDATORY, applied with no choice: add `Table = off` (otherwise wg-quick
//     installs a default route and the tunnel takes the whole router), drop the
//     `DNS =` line (without systemd-resolved it breaks `up`), and keep the
//     interface name within the kernel's 15 characters, unique;
//   * OPTIONAL, exactly one flag: `PostUp`/`PreDown` with `ip rule`, needed only
//     when the same tunnel is also handed out through 3proxy by the source
//     address;
//   * INTANGIBLE, copied byte for byte and reported in `preserved`: the
//     obfuscation (`Jc`, `Jmin`, `Jmax`, `S1..S4`, `H1..H4`, `i1`) and
//     `AllowedIPs`. "Normalising" those would destroy the tunnel, so the module
//     never touches them and says so explicitly.

import {ConfigError} from './errors.mjs';

/** Kernel limit on an interface name, in characters. */
export const INTERFACE_NAME_MAX = 15;

/**
 * Limit of the human-readable tunnel name. It is a label in `webui.json`, not an
 * interface: only the file name is capped by the kernel.
 */
export const TUNNEL_LABEL_MAX = 255;

/**
 * Characters an interface name — and therefore the `.conf` file name and the
 * `awg-quick@<name>` instance — may carry. `/`, whitespace and non-ASCII are out
 * because the name becomes a path component and a systemd instance name.
 */
const INTERFACE_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/** Control characters, refused in a human-readable name. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Routing table used by the optional policy-routing rules. */
export const POLICY_ROUTING_TABLE = 200;

/**
 * Keys copied byte for byte, in the order the preview lists them. Absent keys are
 * simply not reported.
 */
export const PRESERVED_KEYS = Object.freeze([
  'AllowedIPs',
  'Jc',
  'Jmin',
  'Jmax',
  'S1',
  'S2',
  'S3',
  'S4',
  'H1',
  'H2',
  'H3',
  'H4',
  'i1',
]);

const KEY_LINE = /^\s*([A-Za-z][A-Za-z0-9]*)\s*=\s*(.*)$/;

/**
 * Splits the config into lines and remembers its newline style and trailing
 * newline, so an untouched document round-trips exactly.
 *
 * @param {string} text
 * @returns {{lines: string[], eol: string, trailing: boolean}}
 */
function splitLines(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const trailing = /\r?\n$/.test(text);
  const body = trailing ? text.replace(/\r?\n$/, '') : text;
  return {lines: body.split(/\r?\n/), eol, trailing};
}

/**
 * Index of a section header line, or -1.
 *
 * @param {string[]} lines
 * @param {string} name
 * @returns {number}
 */
function sectionIndex(lines, name) {
  return lines.findIndex((line) => line.trim().toLowerCase() === `[${name.toLowerCase()}]`);
}

/**
 * First value of a key inside one section, or null.
 *
 * @param {string[]} lines
 * @param {number} start Index of the section header.
 * @param {string} key
 * @returns {string|null}
 */
function keyValue(lines, start, key) {
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].trim().startsWith('[')) break;
    const match = KEY_LINE.exec(lines[index]);
    if (match && match[1] === key) return match[2].trim();
  }
  return null;
}

/**
 * Chooses a unique interface name within the kernel limit.
 *
 * The desired name is an input: it cannot be derived from the file (a WireGuard
 * config carries no interface name; `awg-quick@<name>` takes it from the file
 * name). An empty input falls back to `awg0`; a name that is taken grows a
 * `-2`, `-3` suffix as long as the limit allows.
 *
 * @param {string} desired
 * @param {Set<string>} taken
 * @returns {string}
 */
export function chooseInterfaceName(desired, taken = new Set()) {
  const base = typeof desired === 'string' && desired.trim().length > 0 ? desired.trim() : 'awg0';
  if (base.length > INTERFACE_NAME_MAX) {
    throw new ConfigError(
      `имя интерфейса '${base}' длиннее ${INTERFACE_NAME_MAX} символов — ядро такое не примет`,
    );
  }
  if (!taken.has(base)) return base;

  for (let n = 2; n < 1000; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, INTERFACE_NAME_MAX - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new ConfigError(`не удалось подобрать свободное имя интерфейса для '${base}'`);
}

/**
 * Validates the human-readable name of a tunnel and returns it trimmed.
 *
 * The name is a label for the owner: it identifies the tunnel in lists and in the
 * proxy form. It never reaches the kernel, so the only hard limits are the schema
 * length and the absence of a path separator or a control character.
 *
 * @param {unknown} label
 * @returns {string}
 */
export function validateTunnelLabel(label) {
  const clean = typeof label === 'string' ? label.trim() : '';
  if (clean.length === 0) throw new ConfigError('имя туннеля не может быть пустым');
  if (clean.length > TUNNEL_LABEL_MAX) {
    throw new ConfigError(`имя туннеля длиннее ${TUNNEL_LABEL_MAX} символов`);
  }
  if (clean.includes('/')) throw new ConfigError("имя туннеля не может содержать '/'");
  if (CONTROL_CHARACTERS.test(clean)) {
    throw new ConfigError('имя туннеля не может содержать управляющие символы');
  }
  return clean;
}

/**
 * Validates the file name of a tunnel and returns it trimmed.
 *
 * This one is the stem of `<name>.conf` in the amnezia directory, the systemd
 * instance `awg-quick@<name>` and the kernel interface name, so the 15-character
 * kernel limit is a hard rule and not advice: a longer name makes the unit fail.
 *
 * @param {unknown} name
 * @returns {string}
 */
export function validateInterfaceName(name) {
  const clean = typeof name === 'string' ? name.trim() : '';
  if (clean.length === 0) throw new ConfigError('имя файла туннеля не может быть пустым');
  if (clean.length > INTERFACE_NAME_MAX) {
    throw new ConfigError(
      `имя файла '${clean}' длиннее ${INTERFACE_NAME_MAX} символов — ядро такое не примет`,
    );
  }
  if (!INTERFACE_NAME_PATTERN.test(clean)) {
    throw new ConfigError(
      `имя файла '${clean}' содержит недопустимые символы: разрешены латиница, цифры, '_', '.' и '-'`,
    );
  }
  if (clean === '.' || clean === '..') throw new ConfigError(`имя файла '${clean}' недопустимо`);
  if (clean.startsWith('-') || clean.startsWith('.')) {
    throw new ConfigError(`имя файла '${clean}' не может начинаться с '-' или '.'`);
  }
  if (clean.endsWith('.conf')) {
    throw new ConfigError(
      `имя файла '${clean}' не должно оканчиваться на '.conf': расширение добавляет редактор`,
    );
  }
  return clean;
}

/**
 * Suggests the human-readable name of a tunnel: `<provider>-<file stem>`.
 *
 * Sanitised rather than refused: this is a default the owner may edit, so a slash
 * or a stray control character in a provider folder name becomes `-` instead of
 * stopping the form.
 *
 * @param {string} provider
 * @param {string} file
 * @returns {string}
 */
export function suggestTunnelName(provider, file) {
  const stem = String(file ?? '').replace(/\.conf$/i, '');
  const raw = `${String(provider ?? '').trim()}-${stem}`.trim();
  const clean = raw.replace(/[\u0000-\u001f\u007f/]/g, '-').trim();
  return (clean.length > 0 ? clean : 'tunnel').slice(0, TUNNEL_LABEL_MAX);
}

/**
 * True when the `[Interface]` section carries `Table = off`.
 *
 * `wg-quick` compares the value with `off` case-sensitively, so that exact line
 * is what the start-up fuse looks for. Anything else — a missing key, a different
 * value, the key in another section — means the config would install a default
 * route and take the whole router with it.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasTableOff(text) {
  let inInterface = false;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inInterface = line.toLowerCase() === '[interface]';
      continue;
    }
    if (!inInterface) continue;
    if (/^Table\s*=\s*off$/.test(line)) return true;
  }
  return false;
}

/**
 * Normalises one tunnel config.
 *
 * @param {string} text Provider config, verbatim.
 * @param {{name?: string, policyRouting?: boolean, takenNames?: Iterable<string>}} [options]
 * @returns {{text: string, changes: Array<{kind: string, line: string, why: string}>,
 *   preserved: string[], name: string}}
 */
export function normalizeTunnel(text, options = {}) {
  if (typeof text !== 'string') {
    throw new ConfigError('normalizeTunnel: на входе ожидается текст конфига');
  }

  const {lines, eol, trailing} = splitLines(text);
  const changes = [];
  const taken = new Set(options.takenNames ?? []);
  const name = chooseInterfaceName(options.name ?? '', taken);

  const interfaceAt = sectionIndex(lines, 'Interface');
  if (interfaceAt < 0) {
    throw new ConfigError('в конфиге нет секции [Interface] — это не конфиг туннеля');
  }

  const result = [...lines];

  // MANDATORY 1: `Table = off`. An existing key is corrected in place; otherwise
  // the line is inserted right after the [Interface] header, which is where
  // wg-quick expects a table directive.
  const tableAt = result.findIndex((line, index) => {
    if (index <= interfaceAt) return false;
    if (line.trim().startsWith('[')) return false;
    const match = KEY_LINE.exec(line);
    return match !== null && match[1] === 'Table';
  });
  if (tableAt >= 0) {
    if (result[tableAt].trim() !== 'Table = off') {
      changes.push({
        kind: 'change',
        line: result[tableAt].trim(),
        why: 'Table приводится к off, иначе туннель заберёт весь трафик роутера',
      });
      result[tableAt] = 'Table = off';
    }
  } else {
    result.splice(interfaceAt + 1, 0, 'Table = off');
    changes.push({
      kind: 'add',
      line: 'Table = off',
      why: 'иначе wg-quick пропишет маршрут по умолчанию и туннель утащит весь трафик роутера',
    });
  }

  // MANDATORY 2: drop `DNS = ...`. It is removed, never commented out.
  for (let index = result.length - 1; index > interfaceAt; index -= 1) {
    if (result[index].trim().startsWith('[')) continue;
    const match = KEY_LINE.exec(result[index]);
    if (match && match[1] === 'DNS') {
      changes.push({
        kind: 'remove',
        line: result[index].trim(),
        why: 'без systemd-resolved строка роняет запуск (resolvconf не найден)',
      });
      result.splice(index, 1);
    }
  }

  // OPTIONAL: policy routing. One flag, and only when asked for.
  if (options.policyRouting === true) {
    const address = keyValue(result, interfaceAt, 'Address');
    if (address === null) {
      throw new ConfigError(
        'policy routing требует Address в [Interface]: правило строится по адресу источника',
      );
    }
    const from = address.split(',')[0].trim().split('/')[0];
    const tableAtNow = result.findIndex((line) => line.trim() === 'Table = off');
    const postUp = `PostUp = ip rule add from ${from} table ${POLICY_ROUTING_TABLE}`;
    const preDown = `PreDown = ip rule del from ${from} table ${POLICY_ROUTING_TABLE}`;
    result.splice(tableAtNow + 1, 0, postUp, preDown);
    changes.push({
      kind: 'add',
      line: postUp,
      why: 'тот же туннель отдаётся ещё и через 3proxy по адресу источника',
    });
    changes.push({
      kind: 'add',
      line: preDown,
      why: 'правило нужно снять при остановке туннеля',
    });
  }

  const preserved = PRESERVED_KEYS.filter((key) =>
    result.some((line) => {
      const match = KEY_LINE.exec(line);
      return match !== null && match[1] === key;
    }),
  );

  const output = result.join(eol) + (trailing ? eol : '');
  return {text: output, changes, preserved, name};
}

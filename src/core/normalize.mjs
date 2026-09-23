// Normaliser of a provider's tunnel config (AmneziaWG / WireGuard).
//
// Pure: text in, text out plus the list of changes. No filesystem, no system
// calls — that is what makes the preview trustworthy and the module testable on
// a synthetic pair (techdocs/architecture.md §7.3, §8.12).
//
// The rules come from §7.3 and split into four sorts:
//
//   * MANDATORY, applied with no choice: add `Table = off` (otherwise wg-quick
//     installs a default route and the tunnel takes the whole router), drop the
//     `DNS =` line (without systemd-resolved it breaks `up`), and keep the
//     interface name within the kernel's 15 characters, unique;
//   * MANDATORY TOO: the provider's own hooks (`PreUp`, `PostUp`, `PreDown`,
//     `PostDown`) and `SaveConfig` are deleted, because `awg-quick` runs those
//     lines through bash AS ROOT — a file from a provider would otherwise execute
//     its commands on our router;
//   * OPTIONAL, exactly one flag: `PostUp`/`PreDown` with `ip rule`, added AFTER
//     the clean-up, needed only when the same tunnel is also handed out through
//     3proxy by the source address;
//   * INTANGIBLE, copied byte for byte and reported in `preserved`: the
//     obfuscation (`Jc`, `Jmin`, `Jmax`, `S1..S4`, `H1..H4`, `i1`) and
//     `AllowedIPs`. "Normalising" those would destroy the tunnel, so the module
//     never touches them and says so explicitly.
//
// ONE parse serves both this module and the start-up fuse: `parseTunnelConfig`
// reads the config the way `awg-quick` does — the comment is cut at `#`, keys are
// compared without case, a repeated key keeps its last value, and every
// `[Interface]` header is remembered. Two different parses are exactly what made
// the hole this task closes
// (techdocs/plan_2026_09_23_gatehouse_fuse_and_no_watchdog.md §A.1).

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
 * `gatehouse-tunnel@<name>` instance — may carry. `/`, whitespace and non-ASCII
 * are out because the name becomes a path component and a systemd instance name.
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

/** A key line: the key is what stands before the first `=`, the value after it. */
const KEY_LINE = /^([A-Za-z][A-Za-z0-9]*)\s*=\s*(.*)$/;

/** A section header, as `awg-quick` sees it: `[Interface]`, any spelling. */
const SECTION_LINE = /^\s*\[([^\]]*)\]\s*$/;

/** The header `awg-quick` matches literally, and the one the normaliser writes. */
export const INTERFACE_HEADER = '[Interface]';

/** Section name as the parse stores it, lowercased. */
const INTERFACE_SECTION = 'interface';

/**
 * Hooks `awg-quick` runs itself, through bash, as root. Lowercase: keys are
 * compared without case, so `postup` and `PostUp` are the same key.
 */
export const HOOK_KEYS = Object.freeze(['preup', 'postup', 'predown', 'postdown']);

/**
 * Keys the normaliser deletes because `awg-quick` would execute them as root.
 * `SaveConfig` is not a hook, but it writes to the file as root, and it has no
 * place in a config we generate.
 */
export const ROOT_KEYS = Object.freeze([...HOOK_KEYS, 'saveconfig']);

/**
 * Cuts a comment the way `wg` and `awg` do: everything from the first `#` on is a
 * comment, so a commented-out line is empty and an inline note is not a value.
 *
 * @param {string} line
 * @returns {string}
 */
function stripComment(line) {
  const at = line.indexOf('#');
  return (at < 0 ? line : line.slice(0, at)).trim();
}

/**
 * Parses a tunnel config the way `awg-quick` reads it: the comment is cut at `#`,
 * the key is what stands before the first `=`, both are trimmed, keys are compared
 * without case, and a repeated key keeps its LAST value. Every entry remembers its
 * line, and every `[Interface]` header is reported, because the start-up fuse has
 * to answer about all of them.
 *
 * @param {string} text
 * @returns {{lines: string[], eol: string, trailing: boolean,
 *   entries: Array<{section: string, key: string, value: string, line: number, raw: string}>,
 *   interfaceHeaders: number[]}}
 */
export function parseTunnelConfig(text) {
  const {lines, eol, trailing} = splitLines(String(text ?? ''));
  const entries = [];
  const interfaceHeaders = [];
  let section = null;

  for (let line = 0; line < lines.length; line += 1) {
    const body = stripComment(lines[line]);
    if (body.length === 0) continue;

    const header = SECTION_LINE.exec(body);
    if (header !== null) {
      section = header[1].trim().toLowerCase();
      if (section === INTERFACE_SECTION) interfaceHeaders.push(line);
      continue;
    }

    if (section === null) continue;
    const match = KEY_LINE.exec(body);
    if (match === null) continue;
    entries.push({
      section,
      key: match[1].toLowerCase(),
      value: match[2].trim(),
      line,
      raw: lines[line],
    });
  }

  return {lines, eol, trailing, entries, interfaceHeaders};
}

/**
 * Entries of one section, in file order.
 *
 * @param {ReturnType<typeof parseTunnelConfig>} parsed
 * @param {string} section Lowercased section name.
 * @returns {Array<{section: string, key: string, value: string, line: number, raw: string}>}
 */
function entriesOf(parsed, section) {
  return parsed.entries.filter((entry) => entry.section === section);
}

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
 * The span of lines belonging to the interface section: from just after its header
 * to the next section header, or to the end of the file. Every edit stays inside
 * it, which is what keeps `[Peer]` untouched.
 *
 * @param {string[]} lines
 * @param {number} headerAt Index of the `[Interface]` header.
 * @returns {{start: number, end: number}}
 */
function interfaceSpan(lines, headerAt) {
  for (let index = headerAt + 1; index < lines.length; index += 1) {
    if (SECTION_LINE.test(stripComment(lines[index]))) {
      return {start: headerAt + 1, end: index};
    }
  }
  return {start: headerAt + 1, end: lines.length};
}

/**
 * Chooses a unique interface name within the kernel limit.
 *
 * The desired name is an input: it cannot be derived from the file (a WireGuard
 * config carries no interface name; `gatehouse-tunnel@<name>` takes it from the
 * file name). An empty input falls back to `awg0`; a name that is taken grows a
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
 * This one is the stem of `<name>.conf` in the tunnel directory, the systemd
 * instance `gatehouse-tunnel@<name>` and the kernel interface name, so the
 * 15-character kernel limit is a hard rule and not advice: a longer name makes the
 * unit fail.
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

/** The value `Table` must carry. `awg-quick` reads it case-sensitively: `OFF` is
 * a refusal, not a synonym. */
export const TABLE_OFF = 'off';

/** The line the normaliser writes and the fuse looks for. */
export const TABLE_LINE = `Table = ${TABLE_OFF}`;

/** An IPv4 literal — the only source address the policy-routing rule may carry. */
const IPV4 = String.raw`(?:\d{1,3}\.){3}\d{1,3}`;

const IPV4_PATTERN = new RegExp(`^${IPV4}$`);

/**
 * The two `ip rule` lines this normaliser writes for policy routing, in its exact
 * form, on the table from `POLICY_ROUTING_TABLE`. Anything else on a hook key is
 * a command we must not run.
 */
const POLICY_RULE = {
  postup: new RegExp(String.raw`^ip\s+rule\s+add\s+from\s+${IPV4}\s+table\s+${POLICY_ROUTING_TABLE}$`),
  predown: new RegExp(
    String.raw`^ip\s+rule\s+del\s+from\s+${IPV4}\s+table\s+${POLICY_ROUTING_TABLE}$`,
  ),
};

/** Why the normaliser writes `Table = off` where the provider had no key at all. */
const TABLE_ADD_WHY =
  'иначе wg-quick пропишет маршрут по умолчанию и туннель утащит весь трафик роутера';

/** Why a `Table` the provider spelled differently is rewritten. */
const TABLE_FIX_WHY =
  'awg-quick берёт последнее значение Table, и любое, кроме off, уводит трафик роутера в туннель';

/** Why every `Table` after the first one goes. */
const TABLE_EXTRA_WHY =
  'второе значение Table победило бы первое: awg-quick берёт последнее значение';

/** Why `DNS` goes — without systemd-resolved the line breaks `up`. */
const DNS_WHY = 'без systemd-resolved строка роняет запуск (resolvconf не найден)';

/** Why the provider's hooks and `SaveConfig` go. Wording fixed by §A.3. */
const ROOT_WHY = 'команда выполнилась бы от root при подъёме туннеля';

/**
 * True for a hook line that is exactly the pair written for policy routing.
 *
 * @param {{key: string, value: string}} entry
 * @returns {boolean}
 */
function isPolicyRoutingRule(entry) {
  const pattern = POLICY_RULE[entry.key];
  return pattern !== undefined && pattern.test(entry.value);
}

/**
 * Why `awg-quick` must not be pointed at this config, or null when it may.
 *
 * Six reasons, all of them refusals (§A.2 and §A.5 of
 * techdocs/plan_2026_09_23_gatehouse_fuse_and_no_watchdog.md):
 *
 *   1. an `[Interface]` header spelled differently (`[interface]`, `[ Interface ]`)
 *      — not the header `awg-quick` matches literally;
 *   2. no `table` key in `[Interface]`;
 *   3. a `table` value other than `off` — `OFF` included, the value is compared
 *      case-sensitively;
 *   4. a `preup`, `postup`, `predown` or `postdown` line, except the exact pair
 *      this normaliser writes for policy routing;
 *   5. `saveconfig` with a value other than `false`;
 *   6. more than one `[Interface]` section: `awg-quick` honours all of them, so
 *      "the" table setting would have two answers at once.
 *
 * The answer does not depend on how `awg-quick` treats case: every reason refuses
 * a file that the other behaviour would refuse too, so the verdict is the same
 * under either (the owner's `grep nocasematch` in §7 is a check, not a premise).
 *
 * It is pure — text in, verdict out — and it is the ONLY gate: the wording of the
 * refusal, the file path and the "no bypass" rule live in the system layer. The
 * checks are ordered 6, 1, 2, 3, 4, 5: the count of sections is what makes "the
 * section" well defined at all.
 *
 * @param {string} text Config verbatim, as it lies on disk.
 * @returns {{code: 'interface-header'|'table-missing'|'table-value'|'hook'|'saveconfig'|'interface-sections', line: string|null}|null}
 *   `line` carries the offending line verbatim where there is one.
 */
export function tunnelConfigRefusal(text) {
  const parsed = parseTunnelConfig(text);
  const {lines, interfaceHeaders} = parsed;

  // 6. More than one `[Interface]`: checked first, because it is what makes the
  // other questions answerable. (A lowercased `[interface]` next to a proper one
  // is this case too, and that is deliberate — §A.5.)
  if (interfaceHeaders.length > 1) return {code: 'interface-sections', line: null};

  // 1. The header itself.
  const header = interfaceHeaders[0];
  if (header !== undefined && stripComment(lines[header]) !== INTERFACE_HEADER) {
    return {code: 'interface-header', line: lines[header].trim()};
  }

  const entries = entriesOf(parsed, INTERFACE_SECTION);

  // 2 and 3. `Table` exists and every occurrence of it says `off`. Every one, not
  // just the first: `awg-quick` honours the last value.
  const tables = entries.filter((entry) => entry.key === 'table');
  if (tables.length === 0) return {code: 'table-missing', line: null};
  const wrongTable = tables.find((entry) => entry.value !== TABLE_OFF);
  if (wrongTable !== undefined) return {code: 'table-value', line: wrongTable.raw.trim()};

  // 4. A hook the normaliser did not write. The line is reported verbatim: the
  // owner has to see exactly what was stopped.
  const hook = entries.find(
    (entry) => HOOK_KEYS.includes(entry.key) && !isPolicyRoutingRule(entry),
  );
  if (hook !== undefined) return {code: 'hook', line: hook.raw.trim()};

  // 5. `SaveConfig` with anything but `false`.
  const save = entries.find((entry) => entry.key === 'saveconfig' && entry.value !== 'false');
  if (save !== undefined) return {code: 'saveconfig', line: save.raw.trim()};

  return null;
}

/**
 * Normalises one tunnel config.
 *
 * The invariants worth remembering while reading:
 *
 *   * every edit happens inside the single `[Interface]` section, so `[Peer]` —
 *     keys, order and comments — comes out byte for byte;
 *   * the reason each line is added or removed says WHAT BREAKS without the edit,
 *     because this list is what the owner reads in the preview;
 *   * the result always passes `tunnelConfigRefusal` (§A.4): an input this
 *     function accepted cannot produce a config the fuse then refuses.
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

  const parsed = parseTunnelConfig(text);
  const {lines, eol, trailing} = parsed;
  const changes = [];
  const taken = new Set(options.takenNames ?? []);
  const name = chooseInterfaceName(options.name ?? '', taken);

  if (parsed.interfaceHeaders.length === 0) {
    throw new ConfigError('в конфиге нет секции [Interface] — это не конфиг туннеля');
  }
  if (parsed.interfaceHeaders.length > 1) {
    // `awg-quick` honours every `[Interface]` section, so the Table setting would
    // have two answers at once. Such a file is not a provider config: it goes back
    // to its author rather than being half-fixed here (§A.5). An input that was
    // refused is not an input that was accepted, so §A.4 still holds.
    throw new ConfigError(
      'в конфиге больше одной секции [Interface] — это не конфиг провайдера, ' +
        'разберите файл руками',
    );
  }

  const headerAt = parsed.interfaceHeaders[0];
  const entries = entriesOf(parsed, INTERFACE_SECTION);
  const result = [...lines];

  // The header itself: `awg-quick` matches `[Interface]` literally, and the fuse
  // refuses anything else, so a differently spelled header is rewritten rather
  // than refused. This is what keeps §A.4 true for `[interface]`.
  if (stripComment(result[headerAt]) !== INTERFACE_HEADER) {
    changes.push({
      kind: 'change',
      line: result[headerAt].trim(),
      why: `заголовок приводится к ${INTERFACE_HEADER}, иначе awg-quick не увидит секцию`,
    });
    result[headerAt] = INTERFACE_HEADER;
  }

  // The edits are collected first and applied from the bottom up, so the line
  // numbers taken from the parse stay valid while the list shrinks.
  const removals = new Set();
  const insertion = {at: -1, lines: []};

  // MANDATORY 1: `Table = off`, exactly once. What matters is the VALUE, not the
  // spelling: `table = off  # note` already says `off` to `awg-quick`, so the line
  // is left exactly as it is and a normalised config produces no noise. A value
  // that is not `off` is replaced in its own place, and every further occurrence
  // goes: `awg-quick` honours the LAST value, so a second line below silently
  // cancels the first — that is the bypass this whole task is about.
  const tables = entries.filter((entry) => entry.key === 'table');
  const [firstTable, ...extraTables] = tables;

  if (firstTable === undefined) {
    insertion.at = headerAt + 1;
    insertion.lines = [TABLE_LINE];
    changes.push({kind: 'add', line: TABLE_LINE, why: TABLE_ADD_WHY});
  } else if (firstTable.value !== TABLE_OFF) {
    insertion.at = firstTable.line;
    insertion.lines = [TABLE_LINE];
    removals.add(firstTable.line);
    changes.push({kind: 'remove', line: firstTable.raw.trim(), why: TABLE_FIX_WHY});
    changes.push({kind: 'add', line: TABLE_LINE, why: TABLE_FIX_WHY});
  }

  for (const entry of extraTables) {
    removals.add(entry.line);
    changes.push({kind: 'remove', line: entry.raw.trim(), why: TABLE_EXTRA_WHY});
  }

  // MANDATORY 2: drop `DNS = ...`, matched without case. It is removed, never
  // commented out: a commented line would be invisible, and the key is useless to
  // us either way.
  for (const entry of entries) {
    if (entry.key !== 'dns') continue;
    removals.add(entry.line);
    changes.push({kind: 'remove', line: entry.raw.trim(), why: DNS_WHY});
  }

  // MANDATORY 3: the provider's own hooks and `SaveConfig`. `awg-quick` runs each
  // hook through bash AS ROOT on every up and down, so a config from a provider is
  // a script we would otherwise execute with the router's privileges. Nothing the
  // tunnel needs is lost: these lines only route around it, and the pair that is
  // genuinely wanted is written by the policy-routing branch below.
  for (const entry of entries) {
    if (!ROOT_KEYS.includes(entry.key)) continue;
    removals.add(entry.line);
    changes.push({kind: 'remove', line: entry.raw.trim(), why: ROOT_WHY});
  }

  for (const line of [...removals].sort((left, right) => right - left)) {
    result.splice(line, 1);
  }

  if (insertion.at >= 0) {
    const shift = [...removals].filter((line) => line < insertion.at).length;
    result.splice(insertion.at - shift, 0, ...insertion.lines);
  }

  // OPTIONAL: policy routing, added AFTER the clean-up and only when asked for.
  // The source address must be an IPv4 literal, because that is the only shape the
  // fuse accepts: refusing here keeps §A.4 true instead of producing a config the
  // fuse would reject a moment later.
  if (options.policyRouting === true) {
    const from = entries
      .filter((entry) => entry.key === 'address')
      .flatMap((entry) => entry.value.split(','))
      .map((value) => value.trim().split('/')[0])
      .find((value) => IPV4_PATTERN.test(value));

    if (from === undefined) {
      throw new ConfigError(
        'policy routing требует Address с IPv4 в [Interface]: правило строится по адресу источника',
      );
    }

    const span = interfaceSpan(result, headerAt);
    let tableAt = -1;
    for (let index = span.start; index < span.end; index += 1) {
      if (result[index].trim() === TABLE_LINE) {
        tableAt = index;
        break;
      }
    }

    const postUp = `PostUp = ip rule add from ${from} table ${POLICY_ROUTING_TABLE}`;
    const preDown = `PreDown = ip rule del from ${from} table ${POLICY_ROUTING_TABLE}`;
    result.splice(tableAt >= 0 ? tableAt + 1 : span.start, 0, postUp, preDown);
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
    parsed.entries.some((entry) => entry.key === key.toLowerCase()),
  );

  const output = result.join(eol) + (trailing ? eol : '');
  return {text: output, changes, preserved, name};
}

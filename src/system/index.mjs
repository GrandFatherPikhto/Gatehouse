// System boundary of the web editor: the only module allowed to touch the host.
//
// Stage 3 replaced the five stubs that used to live here. The rule stated in the
// stage-2 header still holds and is the reason this file exists at all:
//
//   * ONLY `execFile`/`spawn` with an argument array, never a shell string.
//     Tags look like `🇨🇾 Cyprus - Limassol`; they break a shell command line
//     with no attacker involved, and quoting them by hand is exactly the bug
//     this rule prevents.
//   * EVERY path comes from the environment, nothing from the browser. The four
//     callers (check, restart, journal, outbound test) are the whole attack
//     surface of the editor, so what they run is fixed here and not configurable
//     over HTTP.
//
// The module stays testable on a desktop where sing-box is not installed, without
// a router, without root and without network: the binary paths arrive through
// `GATEHOUSE_*` variables (or an explicit options object), and the test suite
// points them at the shell scripts of `tests/fixtures/bin/`.
//
// Signatures of `restartSingBox`, `checkConfig`, `tailJournal`, `testOutbound`
// and `geositeLookup` are the contract with the web layer. They gained an optional
// trailing `options` object (never a changed or removed parameter) so that the
// paths, the timeout and an `AbortSignal` can be injected; the defaults are the
// environment variables below.
//
// What the real commands look like, measured on the owner's router (sing-box
// 1.14), because the formats the parsers accept are not invented:
//
//   $ sing-box tools fetch -c /etc/sing-box/config.json -o "🇨🇾 Cyprus - Limassol" https://ipinfo.io
//   +0000 … INFO outbound/vless[🇨🇾 Cyprus - Limassol]: outbound connection to ipinfo.io:443
//   {
//     "ip": "194.55.164.202",
//     "city": "Limassol",
//     "org": "AS197648 CLOUDLAYER8 LIMITED",
//     …
//   }
//   exit=0
//
// Service lines and the JSON body are interleaved, and the body is the LAST JSON
// object of the stream — the parser below is written for that and does not fall
// over on the first line. `sing-box check -c <file>` is silent on success and
// exits 0. `journalctl -u sing-box -n 1 -o json --no-pager` is readable without
// privileges (the owner is in `adm`); keys are `MESSAGE`, `PRIORITY`,
// `SYSLOG_IDENTIFIER`, `_PID`, `__REALTIME_TIMESTAMP` and other underscored ones.
//
// `MESSAGE` is NOT always a string: journald sends any value containing
// non-printable bytes as an ARRAY of byte values, and sing-box colours every line
// with ANSI escapes even when it writes to journald. Measured on the router, so
// EVERY line of the daemon arrives as a byte array — that is why the panel showed
// an empty message for all of them until `journalMessage` below handled it.
//
// `geosite lookup` does NOT work on this build: sing-box 1.14 installs no
// geosite database (`FATAL open geosite file: open geosite.db: no such file or
// directory`), the routing of the owner uses plain `domain_suffix`, and the UI
// deliberately has no panel for it. `geositeLookup` therefore only runs the
// command and turns "no database" into a sentence instead of a bare FATAL.

import {execFile} from 'node:child_process';
import fs from 'node:fs';

import {tunnelStartupGuard} from './tunnel-file.mjs';

/** Default path of the sing-box binary. */
export const DEFAULT_SINGBOX_PATH = '/usr/local/bin/sing-box';
/** Default path of `curl`, used by the watchdog to reach an inbound. */
export const DEFAULT_CURL_PATH = '/usr/bin/curl';
/**
 * Target of the watchdog check by default. `generate_204` answers 204 with an
 * empty body and exists for exactly this purpose. `ipinfo.io` is deliberately NOT
 * the default: it is an API with a monthly quota, while the watchdog probes it on
 * a fixed schedule and would spend tens of thousands of requests a month.
 */
export const DEFAULT_WATCH_URL = 'https://www.gstatic.com/generate_204';
/** How long one inbound check may take, in milliseconds. */
export const DEFAULT_WATCH_TIMEOUT = 8000;
/** Default path of `systemctl`. */
export const DEFAULT_SYSTEMCTL_PATH = '/usr/bin/systemctl';
/** Default path of `journalctl`. */
export const DEFAULT_JOURNALCTL_PATH = '/usr/bin/journalctl';
/** Default path of `sudo`. */
export const DEFAULT_SUDO_PATH = '/usr/bin/sudo';
/** Default name of the systemd unit of the daemon. */
export const DEFAULT_UNIT = 'sing-box';
/**
 * Default directory the `awg-quick@<name>` template unit reads: it looks for
 * `<name>.conf` exactly here. The editor writes the normalised tunnel config into
 * this directory and the systemd unit picks it up by the file name.
 */
export const DEFAULT_AMNEZIA_DIR = '/etc/amnezia/amneziawg';
/**
 * Default path of the sudoers file the editor READS to learn which tunnel units
 * it may control. It never writes this file — installing the rules is the
 * owner's job, and reading them is not a privilege escalation.
 */
export const DEFAULT_SUDOERS_PATH = '/etc/sudoers.d/gatehouse';
/** Default target of the outbound test. */
export const DEFAULT_TEST_URL = 'https://ipinfo.io';
/** Default path of the generated config the commands act on. */
export const DEFAULT_CONFIG_PATH = '/etc/sing-box/config.json';
/** Default timeout of one outbound test, matching the reference `curl_test`. */
export const DEFAULT_TEST_TIMEOUT = 8000;
/** Default number of outbound tests that may run at once. */
export const DEFAULT_TEST_CONCURRENCY = 4;
/** Default number of journal lines `tailJournal` reads. */
export const DEFAULT_JOURNAL_LINES = 200;

/** Marker the stage-2 stubs carried. Kept so an old caller can still detect it. */
export const STAGE_MARKER = 'не реализовано (этап 3)';

/** Prefix `sudo` gets to fail instead of prompting for a password. */
const SUDO_NON_INTERACTIVE = ['-n'];

/** `execFile` buffer for the commands above; the fetch body is small. */
const MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Failure of a system call that is a bug or a broken host, not a config problem
 * the owner can fix in a form. The web layer answers such a case with an honest
 * message instead of a stack trace.
 */
export class SystemError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'SystemError';
  }
}

/**
 * The stage-2 stub error. No function throws it any more; the type stays exported
 * because it was part of the published boundary of the module.
 */
export class NotImplementedError extends SystemError {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

/**
 * Reads the system layer configuration from the environment.
 *
 * Everything here is fixed by the process owner, never by a request: the editor
 * runs commands on the host, so a path arriving from the browser would be remote
 * code execution with extra steps.
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {Record<string, unknown>} [overrides] Explicit values win over `env`,
 *   which is how the tests point the module at the fake binaries.
 * @returns {Record<string, string|number>} Frozen configuration.
 */
export function systemConfig(env = process.env, overrides = {}) {
  const read = (key, fallback) => {
    const injected = overrides[key];
    if (typeof injected === 'string' && injected.length > 0) return injected;
    const value = env[key];
    return typeof value === 'string' && value.length > 0 ? value : fallback;
  };
  const number = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };

  return Object.freeze({
    singbox: read('GATEHOUSE_SINGBOX', DEFAULT_SINGBOX_PATH),
    curl: read('GATEHOUSE_CURL', DEFAULT_CURL_PATH),
    systemctl: read('GATEHOUSE_SYSTEMCTL', DEFAULT_SYSTEMCTL_PATH),
    journalctl: read('GATEHOUSE_JOURNALCTL', DEFAULT_JOURNALCTL_PATH),
    sudo: read('GATEHOUSE_SUDO', DEFAULT_SUDO_PATH),
    unit: read('GATEHOUSE_UNIT', DEFAULT_UNIT),
    amneziaDir: read('GATEHOUSE_AMNEZIA_DIR', DEFAULT_AMNEZIA_DIR),
    sudoers: read('GATEHOUSE_SUDOERS', DEFAULT_SUDOERS_PATH),
    testUrl: read('GATEHOUSE_TEST_URL', DEFAULT_TEST_URL),
    configPath: read('GATEHOUSE_CONFIG', DEFAULT_CONFIG_PATH),
    testTimeout: number(overrides.testTimeout ?? env.GATEHOUSE_TEST_TIMEOUT, DEFAULT_TEST_TIMEOUT),
    testConcurrency: number(
      overrides.concurrency ?? env.GATEHOUSE_TEST_CONCURRENCY,
      DEFAULT_TEST_CONCURRENCY,
    ),
  });
}

/**
 * Turns a buffer/limit option into a positive number with a fallback.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positive(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Runs one external command and never rejects on a non-zero exit: the callers
 * have to report what the command said, not that it complained. Rejection is
 * reserved for programmer error (a missing path is an `ok: false` result).
 *
 * @param {string} file Absolute path of the binary.
 * @param {string[]} args Argument ARRAY — never a command line.
 * @param {{timeout?: number, env?: Record<string, string|undefined>,
 *   signal?: AbortSignal, maxBuffer?: number}} [options]
 * @returns {Promise<{ok: boolean, code: number|null, signal: string|null,
 *   timedOut: boolean, error: string|null, stdout: string, stderr: string}>}
 */
export function run(file, args, options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const child = execFile(
      file,
      args,
      {
        timeout: options.timeout,
        killSignal: 'SIGTERM',
        maxBuffer: positive(options.maxBuffer, MAX_BUFFER),
        encoding: 'utf8',
        // The child inherits the environment of the server, with the injected
        // overrides on top; dropping `PATH` would break `#!/usr/bin/env node`.
        env: {...process.env, ...options.env},
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error && error.code === 'ENOENT') {
          finish({
            ok: false,
            code: null,
            signal: null,
            timedOut: false,
            error: `исполняемый файл не найден: ${file}`,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
          });
          return;
        }

        const timedOut = Boolean(error && error.killed && options.timeout);
        finish({
          ok: !error,
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          signal: error?.signal ?? null,
          timedOut,
          error: error === null ? null : timedOut ? `превышен таймаут ${options.timeout} мс` : error.message,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
        });
      },
    );

    if (options.signal) {
      const onAbort = () => child.kill('SIGTERM');
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, {once: true});
      child.on('close', () => options.signal.removeEventListener('abort', onAbort));
    }
    if (typeof options.onSpawn === 'function') options.onSpawn(child);
  });
}

/**
 * Extracts the last JSON object from a mixed stream. `sing-box tools fetch`
 * interleaves log lines with a multi-line JSON body and the body is last; the
 * naive "parse the first line" would throw, and "parse everything" cannot work
 * because of the log lines in front of it.
 *
 * @param {string} text
 * @returns {Record<string, unknown>|null}
 */
export function parseLastJsonObject(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const candidates = [];
  let buffer = null;

  for (const line of lines) {
    if (buffer === null) {
      const start = line.indexOf('{');
      if (start < 0) continue;
      buffer = line.slice(start);
    } else {
      buffer += `\n${line}`;
    }
    if (balancedObject(buffer)) {
      candidates.push(buffer);
      buffer = null;
    }
  }

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(candidates[index]);
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value;
    } catch {
      // A line that started like JSON but is a log line: try the next candidate.
    }
  }
  return null;
}

/**
 * True when a `{ … }` fragment has balanced braces, ignoring braces inside
 * strings. Used to find where a pretty-printed JSON object ends.
 *
 * @param {string} text
 * @returns {boolean}
 */
function balancedObject(text) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (const char of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return true;
    }
  }
  return false;
}

/** syslog priorities of systemd, as `PRIORITY` carries them. */
export const PRIORITY_LEVELS = Object.freeze([
  'emerg',
  'alert',
  'crit',
  'err',
  'warning',
  'notice',
  'info',
  'debug',
]);

/**
 * Maps a systemd `PRIORITY` value to a level name, and anything unknown to
 * `info`, so the client only ever filters on a known set.
 *
 * @param {unknown} priority
 * @returns {string}
 */
export function priorityLevel(priority) {
  const index = Number(priority);
  if (!Number.isInteger(index) || index < 0 || index >= PRIORITY_LEVELS.length) return 'info';
  return PRIORITY_LEVELS[index];
}

/**
 * Maps a level name to its syslog priority, or `null` for an unknown name.
 *
 * The priority counts DOWN from the most severe: `emerg` is 0 and `debug` is 7,
 * so "minimum level `info`" means "priority at most 6". `null` (an unknown or
 * absent name) means "do not filter".
 *
 * @param {unknown} level
 * @returns {number|null}
 */
export function levelPriority(level) {
  const name = typeof level === 'string' ? level.trim().toLowerCase() : '';
  const index = PRIORITY_LEVELS.indexOf(name);
  return index < 0 ? null : index;
}

/**
 * ANSI escape sequences: a whole CSI sequence (`\x1b[36m`, `\x1b[0m`) or a lone
 * ESC that something else left behind. Removing them is a display concern, but
 * the parser is where the raw journal text arrives, and the level the panel
 * colours by comes from `PRIORITY`, so no colour is lost with them.
 */
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b/g;

/**
 * The prefix sing-box puts into the message itself: the offset, the date, the
 * time and the level word (`+0000 2026-09-14 12:42:18 INFO …`). The panel already
 * shows the time from `__REALTIME_TIMESTAMP` and the level from `PRIORITY`, so
 * this copy is pure noise. A message that does not look like this is left exactly
 * as it is — no guessing.
 */
const SINGBOX_PREFIX =
  /^\s*[+-]\d{4}\s+\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\s+(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|PANIC)\b[ \t]*/i;

/**
 * Reads the `MESSAGE` field of a journal entry and cleans it up for the panel.
 *
 * Three shapes have to be accepted, because all three really occur:
 *   * a string — a unit that writes plain text, and every non-sing-box unit;
 *   * an ARRAY of byte values — what journald does to any value containing
 *     non-printable bytes, which is every coloured line sing-box writes;
 *   * anything else — `undefined`, an object, an array holding something that is
 *     not a byte. That becomes an empty string and never an exception: a panel
 *     must not break because one journal field had an unexpected type.
 *
 * An invalid UTF-8 sequence in the array becomes U+FFFD, the standard Node
 * replacement, and does not throw. (The core's `decodeUtf8Ignore` drops such
 * bytes instead, mirroring Python's `errors="ignore"`; that rule exists to keep
 * `config.json` byte-identical to the reference and has nothing to say about a
 * log line that is only ever displayed.)
 *
 * @param {unknown} value
 * @returns {string}
 */
function journalMessage(value) {
  let text;
  if (typeof value === 'string') {
    text = value;
  } else if (
    Array.isArray(value) &&
    value.every((byte) => typeof byte === 'number' && byte >= 0 && byte <= 255)
  ) {
    text = Buffer.from(value).toString('utf8');
  } else {
    return '';
  }
  return text.replace(ANSI_PATTERN, '').replace(SINGBOX_PREFIX, '');
}

/**
 * Parses one line of `journalctl -o json`.
 *
 * `message` is decoded and cleaned by `journalMessage`: the colour codes are gone
 * and the duplicated `+0000 <date> <time> <level>` prefix of sing-box is cut off.
 *
 * @param {string} line
 * @returns {{time: string, level: string, priority: number|null, message: string,
 *   identifier: string, pid: string|null}|null} `null` for a non-JSON line.
 */
export function parseJournalLine(line) {
  const text = String(line ?? '').trim();
  if (text.length === 0 || text.startsWith('#') || text[0] !== '{') return null;

  let entry;
  try {
    entry = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;

  const micros = Number(entry.__REALTIME_TIMESTAMP);
  const time = Number.isFinite(micros) && micros > 0
    ? new Date(micros / 1000).toISOString()
    : typeof entry.__REALTIME_TIMESTAMP === 'string'
      ? entry.__REALTIME_TIMESTAMP
      : '';

  return {
    time,
    level: priorityLevel(entry.PRIORITY),
    priority: Number.isFinite(Number(entry.PRIORITY)) ? Number(entry.PRIORITY) : null,
    message: journalMessage(entry.MESSAGE),
    identifier: typeof entry.SYSLOG_IDENTIFIER === 'string' ? entry.SYSLOG_IDENTIFIER : '',
    pid: entry._PID === undefined ? null : String(entry._PID),
  };
}

/**
 * Parses a whole `journalctl -o json --no-pager` output.
 *
 * @param {string} text
 * @returns {Array<Record<string, unknown>>}
 */
export function parseJournal(text) {
  const entries = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const entry = parseJournalLine(line);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

/**
 * Runs `sing-box check` over the generated config.
 *
 * The check is NOT a proof that the config is correct. Measured on sing-box
 * 1.14: it catches an unknown inbound type and unknown fields, and it lets a
 * duplicate `listen_port`, a reference to a non-existent outbound tag and a typo
 * in `dns.final` through with `exit=0`. The UI therefore says «схема принята»
 * and never «конфиг корректен» — an honest label is what stops a restart with a
 * config the daemon will refuse to start.
 *
 * @param {string} configPath
 * @param {{env?: Record<string, string|undefined>, timeout?: number,
 *   signal?: AbortSignal, singbox?: string}} [options]
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string, stderr: string,
 *   error: string|null, timedOut: boolean, configPath: string, args: string[]}>}
 */
export async function checkConfig(configPath, options = {}) {
  const config = systemConfig(options.env, options);
  const file = options.singbox ?? config.singbox;
  // `--disable-color` keeps the output of a failing check readable when it lands
  // in the panel: the owner sees text, not ANSI escapes.
  const args = ['check', '--disable-color', '-c', String(configPath)];

  const result = await run(file, args, {
    timeout: positive(options.timeout, config.testTimeout),
    env: options.env,
    signal: options.signal,
  });

  return {
    ok: result.ok,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
    timedOut: result.timedOut,
    configPath: String(configPath),
    args,
  };
}

/**
 * Restarts the sing-box daemon.
 *
 * `Restart=always` is set on the unit, so restarting with a config the daemon
 * refuses to start means an endless restart loop and every connection in the
 * house down. The web layer enforces the order (generate → check → only then
 * offer the restart) and the rollback; this function only does the call.
 *
 * @param {{env?: Record<string, string|undefined>, timeout?: number,
 *   signal?: AbortSignal, sudo?: string, systemctl?: string, unit?: string}} [options]
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string, stderr: string,
 *   error: string|null, timedOut: boolean, command: string[]}>}
 */
export async function restartSingBox(options = {}) {
  const config = systemConfig(options.env, options);
  const sudoSetting = options.sudo ?? config.sudo;
  const systemctl = options.systemctl ?? config.systemctl;
  const unit = options.unit ?? config.unit;

  // `GATEHOUSE_SUDO=none` means "do not escalate": the polkit rule grants the
  // restart over D-Bus, and `NoNewPrivileges=yes` would block the setuid of
  // `sudo` anyway. Both deployment variants are files of `deploy/`.
  const useSudo = sudoSetting !== 'none' && sudoSetting !== '';
  const file = useSudo ? sudoSetting : systemctl;
  // `sudo -n` never prompts: a missing sudoers rule has to fail loudly instead of
  // hanging a request forever on a password nobody can type.
  const args = useSudo
    ? [...SUDO_NON_INTERACTIVE, systemctl, 'restart', unit]
    : ['restart', unit];

  const result = await run(file, args, {
    timeout: positive(options.timeout, config.testTimeout),
    env: options.env,
    signal: options.signal,
  });

  return {
    ok: result.ok,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
    timedOut: result.timedOut,
    command: [file, ...args],
  };
}

// ------------------------------------------------------------------
// Tunnels (part 2 of the tunnel-lifecycle task)
// ------------------------------------------------------------------
//
// A tunnel is a `awg-quick@<name>` template unit. Unlike `sing-box`, there is no
// dedicated `check` step and no rollback: the `.conf` the unit reads is written
// by part 1, and the unit either comes up or does not. Two independent systemd
// axes are involved — "active now" and "enabled at boot" — and the panel shows
// both, never assuming one from the other.

/**
 * Name of the systemd unit of a tunnel: `awg-quick@<name>`.
 *
 * @param {string} name Interface name (the `.conf` stem).
 * @returns {string}
 */
export function tunnelUnitName(name) {
  return `awg-quick@${String(name ?? '').trim()}`;
}

/**
 * Builds the argv of one `systemctl` action on a unit, with or without sudo.
 *
 * Mirrors `restartSingBox`: `GATEHOUSE_SUDO=none` means "do not escalate" (the
 * polkit variant), otherwise `sudo -n` is used and a missing sudoers rule fails
 * loudly instead of hanging on a password.
 *
 * @param {string[]} action Verb and its flags, e.g. `['enable', '--now']`.
 * @param {string} unit
 * @param {Record<string, string|number>} config Result of `systemConfig`.
 * @param {Record<string, unknown>} [options]
 * @returns {{file: string, args: string[]}}
 */
function systemctlCommand(action, unit, config, options = {}) {
  const sudoSetting = options.sudo ?? config.sudo;
  const systemctl = options.systemctl ?? config.systemctl;
  const useSudo = sudoSetting !== 'none' && sudoSetting !== '';
  const file = useSudo ? sudoSetting : systemctl;
  const args = useSudo
    ? [...SUDO_NON_INTERACTIVE, systemctl, ...action, unit]
    : [...action, unit];
  return {file, args};
}

/** Actions that leave the unit RUNNING: the only ones the start-up fuse guards. */
const STARTS_UNIT = new Set(['restart', 'enable']);

/**
 * Runs one action on a tunnel unit.
 *
 * Before a unit may be STARTED the config on disk is read again and refused
 * without `Table = off`: such a file makes `wg-quick` install a default route and
 * takes the whole router into the tunnel, the owner's own link included. The
 * check lives here, in the only function that runs `systemctl` on a tunnel, so no
 * route, flag, setting or request can go around it; a refusal returns with an
 * EMPTY `command` array, which is how a test proves `systemctl` was never called.
 * Stopping (`disable --now`) is deliberately not guarded: taking a dangerous
 * tunnel down must always remain possible.
 *
 * @param {string} name
 * @param {string[]} action
 * @param {{env?: Record<string, string|undefined>, timeout?: number,
 *   signal?: AbortSignal, sudo?: string, systemctl?: string}} [options]
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string, stderr: string,
 *   error: string|null, timedOut: boolean, refused: boolean, unit: string,
 *   action: string[], command: string[]}>}
 */
async function tunnelAction(name, action, options = {}) {
  const config = systemConfig(options.env, options);
  const unit = tunnelUnitName(name);

  if (STARTS_UNIT.has(action[0])) {
    const guard = tunnelStartupGuard(config.amneziaDir, name);
    if (!guard.safe) {
      return {
        ok: false,
        code: null,
        stdout: '',
        stderr: '',
        error: guard.reason,
        timedOut: false,
        refused: true,
        unit,
        action,
        command: [],
      };
    }
  }

  const {file, args} = systemctlCommand(action, unit, config, options);

  const result = await run(file, args, {
    timeout: positive(options.timeout, config.testTimeout),
    env: options.env,
    signal: options.signal,
  });

  return {
    ok: result.ok,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
    timedOut: result.timedOut,
    refused: false,
    unit,
    action,
    command: [file, ...args],
  };
}

/**
 * Restarts one tunnel unit (`sudo -n systemctl restart awg-quick@<name>`).
 *
 * @param {string} name
 * @param {Parameters<typeof tunnelAction>[2]} [options]
 */
export function restartTunnel(name, options = {}) {
  return tunnelAction(name, ['restart'], options);
}

/**
 * Brings a tunnel up now AND at boot: `enable --now`.
 *
 * One checkbox drives both axes on purpose. The four combinations of
 * active/enabled include three "something went wrong" states, and the panel
 * names a divergence in words instead of hiding it.
 *
 * @param {string} name
 * @param {Parameters<typeof tunnelAction>[2]} [options]
 */
export function enableTunnel(name, options = {}) {
  return tunnelAction(name, ['enable', '--now'], options);
}

/**
 * Takes a tunnel down and out of the boot: `disable --now`.
 *
 * @param {string} name
 * @param {Parameters<typeof tunnelAction>[2]} [options]
 */
export function disableTunnel(name, options = {}) {
  return tunnelAction(name, ['disable', '--now'], options);
}

/**
 * Reads both systemd axes of a tunnel unit: is it active now, is it enabled at
 * boot. Neither call needs privileges, so no sudo is involved here.
 *
 * @param {string} name
 * @param {{env?: Record<string, string|undefined>, timeout?: number,
 *   signal?: AbortSignal, systemctl?: string}} [options]
 * @returns {Promise<{unit: string, active: boolean, enabled: boolean,
 *   activeRaw: string, enabledRaw: string, activeError: string|null,
 *   enabledError: string|null}>}
 */
export async function tunnelState(name, options = {}) {
  const config = systemConfig(options.env, options);
  const unit = tunnelUnitName(name);
  const systemctl = options.systemctl ?? config.systemctl;
  const timeout = positive(options.timeout, config.testTimeout);

  const one = async (verb) => {
    const result = await run(systemctl, [verb, unit], {
      timeout,
      env: options.env,
      signal: options.signal,
    });
    return {
      ok: result.ok,
      value: result.stdout.trim(),
      error: result.error,
    };
  };

  const [active, enabled] = await Promise.all([one('is-active'), one('is-enabled')]);

  return {
    unit,
    // `is-active` prints `active` on success; anything else (inactive, failed,
    // activating) is "not up" as far as the owner is concerned.
    active: active.value === 'active',
    enabled: enabled.value === 'enabled',
    activeRaw: active.value,
    enabledRaw: enabled.value,
    activeError: active.error,
    enabledError: enabled.error,
  };
}

/**
 * The three sudoers lines that let the editor control one tunnel.
 *
 * The rules are per NAME and without a wildcard: `awg-quick@*` would also grant
 * units that do not exist yet, and the unit name comes from the file name, i.e.
 * from data.
 *
 * @param {string} name
 * @param {{systemctl?: string, user?: string}} [options] `user` defaults to the
 *   account the process runs as.
 * @returns {string[]} Three lines, in the order the panel lists them.
 */
export function tunnelSudoersLines(name, options = {}) {
  const unit = tunnelUnitName(name);
  const systemctl = options.systemctl ?? DEFAULT_SYSTEMCTL_PATH;
  const user = options.user ?? process.env.USER ?? 'denis';
  return [
    `${user} ALL=(root) NOPASSWD: ${systemctl} enable --now ${unit}`,
    `${user} ALL=(root) NOPASSWD: ${systemctl} disable --now ${unit}`,
    `${user} ALL=(root) NOPASSWD: ${systemctl} restart ${unit}`,
  ];
}

/**
 * Parses a sudoers file into `{name -> {restart, enable, disable}}`.
 *
 * Only lines that mention the configured `systemctl` path and a `awg-quick@`
 * unit are read; comments are ignored. The editor never writes this file — it
 * only reads it to decide whether a button may be drawn.
 *
 * @param {string} text
 * @param {{systemctl?: string}} [options]
 * @returns {Record<string, {restart: boolean, enable: boolean, disable: boolean}>}
 */
export function parseTunnelSudoers(text, options = {}) {
  const systemctl = options.systemctl ?? DEFAULT_SYSTEMCTL_PATH;
  /** @type {Record<string, {restart: boolean, enable: boolean, disable: boolean}>} */
  const map = {};

  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    if (!line.includes('awg-quick@') || !line.includes(systemctl)) continue;

    const match = /awg-quick@([A-Za-z0-9_.-]+)/.exec(line);
    if (match === null) continue;
    const name = match[1];
    const entry = map[name] ?? (map[name] = {restart: false, enable: false, disable: false});

    if (/\brestart\b/.test(line)) entry.restart = true;
    else if (/\benable\b/.test(line) && /--now/.test(line)) entry.enable = true;
    else if (/\bdisable\b/.test(line) && /--now/.test(line)) entry.disable = true;
  }
  return map;
}

/**
 * Answers, per tunnel, which controls the editor may offer.
 *
 * A missing or unreadable sudoers file means "no rights at all": the safe answer
 * is to show the rules to install, not to draw buttons the first click of which
 * would fail. Each result carries `missingLines` — the exact lines to paste.
 *
 * @param {string} sudoersPath
 * @param {string[]} names
 * @param {{systemctl?: string, user?: string}} [options]
 * @returns {Record<string, {restart: boolean, enable: boolean, disable: boolean,
 *   canRestart: boolean, canToggle: boolean, missingLines: string[]}>}
 */
export function tunnelPermissions(sudoersPath, names, options = {}) {
  let text = '';
  try {
    text = fs.readFileSync(sudoersPath, 'utf8');
  } catch {
    // No file, no rights. The rules have to be installed by the owner.
    text = '';
  }
  const parsed = parseTunnelSudoers(text, options);
  const [enableLine, disableLine, restartLine] = tunnelSudoersLines('__name__', options);

  /** @type {Record<string, Record<string, unknown>>} */
  const result = {};
  for (const name of names) {
    const entry = parsed[name] ?? {restart: false, enable: false, disable: false};
    const missingLines = [];
    if (!entry.enable) missingLines.push(enableLine.replace('__name__', name));
    if (!entry.disable) missingLines.push(disableLine.replace('__name__', name));
    if (!entry.restart) missingLines.push(restartLine.replace('__name__', name));
    result[name] = {
      ...entry,
      canRestart: entry.restart,
      canToggle: entry.enable && entry.disable,
      missingLines,
    };
  }
  return result;
}

/**
 * Reads a one-shot snapshot of the daemon log.
 *
 * This used to be the fetch half of a live `journalctl -f` stream. The stream was
 * removed on 22.09.2026: it needed a counter, a cap, a 409 refusal and a child
 * killed on `req.on('close')`, while the real scenario is "something broke, show
 * me why" — a snapshot. One `execFile`, no state and no process left behind.
 *
 * `journalctl` needs no privileges for the unit log as long as the account may
 * read the journal (the owner is in `adm`), so the editor never escalates here.
 * The unit may be overridden per request (a future tunnel unit has its own
 * journal); `level` is the minimum syslog level, so a lower priority number —
 * a more severe message — is kept.
 *
 * @param {number} [lines]
 * @param {{env?: Record<string, string|undefined>, timeout?: number,
 *   signal?: AbortSignal, unit?: string, level?: string}} [options]
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string, stderr: string,
 *   error: string|null, entries: Array<Record<string, unknown>>, lines: number,
 *   unit: string, level: string|null}>}
 */
export async function tailJournal(lines = DEFAULT_JOURNAL_LINES, options = {}) {
  const config = systemConfig(options.env, options);
  const count = positive(lines, DEFAULT_JOURNAL_LINES);
  const unit =
    typeof options.unit === 'string' && options.unit.trim().length > 0
      ? options.unit.trim()
      : config.unit;
  const level = typeof options.level === 'string' && options.level.trim().length > 0
    ? options.level.trim().toLowerCase()
    : null;
  const threshold = levelPriority(level);
  const args = ['-u', unit, '-n', String(count), '-o', 'json', '--no-pager'];

  const result = await run(config.journalctl, args, {
    timeout: positive(options.timeout, config.testTimeout * 2),
    env: options.env,
    signal: options.signal,
  });

  // `priority === null` means the field was missing or unparsable: such an entry
  // is kept rather than dropped, because a level filter may not hide a line it
  // cannot classify.
  const entries = parseJournal(result.stdout).filter(
    (entry) => threshold === null || entry.priority === null || entry.priority <= threshold,
  );

  return {
    ok: result.ok,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
    entries,
    lines: count,
    unit,
    level,
  };
}

/**
 * Tests one outbound through the daemon.
 *
 * This is the replacement of the reference `curl_test`/`live_test`, which rewrote
 * `config.json` and restarted sing-box to check a single server — 149 restarts
 * for 148 servers, each dropping every connection in the house. `tools fetch`
 * starts its own sing-box instance, binds no inbound and does not touch the
 * running daemon.
 *
 * @param {string} tag Outbound tag; passed as its own array element because it
 *   looks like `🇨🇾 Cyprus - Limassol`.
 * @param {{configPath?: string, url?: string, env?: Record<string, string|undefined>,
 *   timeout?: number, signal?: AbortSignal, singbox?: string}} [options]
 * @returns {Promise<{ok: boolean, tag: string, url: string, configPath: string,
 *   code: number|null, error: string|null, timedOut: boolean, parsed: boolean,
 *   ip: string|null, city: string|null, org: string|null,
 *   body: Record<string, unknown>|null, stdout: string, stderr: string, args: string[]}>}
 */
export async function testOutbound(tag, options = {}) {
  const config = systemConfig(options.env, options);
  const file = options.singbox ?? config.singbox;
  const configPath = options.configPath ?? config.configPath;
  const url = options.url ?? config.testUrl;
  const timeout = positive(options.timeout, config.testTimeout);

  const args = ['tools', 'fetch', '-c', String(configPath), '-o', String(tag), String(url)];
  const result = await run(file, args, {timeout, env: options.env, signal: options.signal});
  const body = parseLastJsonObject(result.stdout);

  return {
    ok: result.ok,
    tag: String(tag),
    url: String(url),
    configPath: String(configPath),
    code: result.code,
    error: result.error,
    timedOut: result.timedOut,
    parsed: body !== null,
    ip: typeof body?.ip === 'string' ? body.ip : null,
    city: typeof body?.city === 'string' ? body.city : null,
    org: typeof body?.org === 'string' ? body.org : null,
    body,
    stdout: result.stdout,
    stderr: result.stderr,
    args,
  };
}

/**
 * Runs `worker` over `items` with at most `limit` in flight, keeping the order of
 * the results equal to the order of the input.
 *
 * Extracted and exported on purpose: the concurrency cap of the mass test is a
 * requirement with a test of its own, and a pool is much easier to test directly
 * than through a route.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @param {AbortSignal} [signal] Stops handing out new items when aborted.
 * @returns {Promise<Array<R|undefined>>}
 */
export async function mapWithConcurrency(items, limit, worker, signal) {
  const list = [...items];
  const results = new Array(list.length);
  const width = Math.min(Math.max(1, positive(limit, 1)), list.length);
  let next = 0;

  const lane = async () => {
    for (;;) {
      if (signal?.aborted) return;
      const index = next;
      next += 1;
      if (index >= list.length) return;
      results[index] = await worker(list[index], index);
    }
  };

  await Promise.all(Array.from({length: width}, () => lane()));
  return results;
}

/**
 * Tests every tag of a profile, with a bounded number of parallel calls.
 *
 * The result table is `tag / success / latency / city`; progress goes to
 * `onResult` as each call finishes, which is what the SSE route forwards, so the
 * request never blocks for minutes.
 *
 * @param {string[]} tags
 * @param {{configPath?: string, url?: string, env?: Record<string, string|undefined>,
 *   concurrency?: number, timeout?: number, signal?: AbortSignal,
 *   onResult?: (result: Record<string, unknown>) => void,
 *   runner?: (tag: string, index: number) => Promise<Record<string, unknown>>}} [options]
 * @returns {Promise<{results: Array<Record<string, unknown>>, aborted: boolean,
 *   concurrency: number}>}
 */
export async function testOutbounds(tags, options = {}) {
  const config = systemConfig(options.env, options);
  const concurrency = positive(options.concurrency, config.testConcurrency);

  // The latency is measured around the call, not read from the command output:
  // `tools fetch` prints no timing, and the owner wants a comparable number.
  const defaultRunner = async (tag) => {
    const began = Date.now();
    const result = await testOutbound(tag, options);
    return {...result, elapsed: Date.now() - began};
  };
  const runner = options.runner ?? defaultRunner;

  const results = await mapWithConcurrency(
    [...tags],
    concurrency,
    async (tag, index) => {
      const result = await runner(tag, index);
      if (typeof options.onResult === 'function') options.onResult(result);
      return result;
    },
    options.signal,
  );

  return {
    results: results.filter((result) => result !== undefined),
    aborted: Boolean(options.signal?.aborted),
    concurrency,
  };
}

/**
 * Probes the path the application really uses: inbound → route rule → pool →
 * server, by sending `curl` through the local inbound of a proxy.
 *
 * This is NOT `tools fetch`. That one starts its own sing-box and checks an
 * outbound only, so a problem anywhere else on the path (the inbound is not
 * listening, the route rule sends the traffic elsewhere) stays invisible. The
 * reference `curl_test` did it through the inbound, and that part of it was
 * right.
 *
 * The proxy scheme follows the inbound type: `http` and `mixed` speak HTTP
 * CONNECT, `socks` speaks SOCKS5 and the `h` in `socks5h` makes the name travel
 * to the far end instead of being resolved locally.
 *
 * @param {{env?: Record<string, string|undefined>, listenIp?: string, port?: number,
 *   proxyType?: string, url?: string, timeout?: number, curl?: string,
 *   signal?: AbortSignal}} options `proxyType` is the inbound type
 *   (`socks`|`http`|`mixed`); the rest have sensible defaults.
 * @returns {Promise<{ok: boolean, code: number|null, timedOut: boolean,
 *   error: string|null, stdout: string, stderr: string, url: string,
 *   listenIp: string, port: number, proxyUrl: string, args: string[]}>}
 */
export async function testInbound(options = {}) {
  const config = systemConfig(options.env, options);
  const file = options.curl ?? config.curl;
  const listenIp = options.listenIp ?? '127.0.0.1';
  const port = Number(options.port);
  const url = options.url ?? DEFAULT_WATCH_URL;
  const timeout = positive(options.timeout, DEFAULT_WATCH_TIMEOUT);
  const scheme = options.proxyType === 'socks' ? 'socks5h' : 'http';
  const proxyUrl = `${scheme}://${listenIp}:${port}`;

  // `--max-time` counts seconds, while the timeout here is milliseconds; rounding
  // up avoids a zero that would abort the transfer immediately.
  const seconds = Math.max(1, Math.ceil(timeout / 1000));
  const args = [
    '-x',
    proxyUrl,
    '-s',
    '-S',
    '-o',
    '/dev/null',
    '-w',
    '%{http_code}',
    '--max-time',
    String(seconds),
    String(url),
  ];

  const result = await run(file, args, {timeout, env: options.env, signal: options.signal});
  const status = Number.parseInt(result.stdout.trim(), 10);

  return {
    ok: result.ok,
    code: result.code,
    timedOut: result.timedOut || result.code === 28,
    error: result.error,
    stdout: result.stdout,
    stderr: result.stderr,
    url: String(url),
    listenIp: String(listenIp),
    port,
    proxyUrl,
    status: Number.isFinite(status) ? status : null,
    args,
  };
}

/**
 * Looks a domain up in the geosite database.
 *
 * Deliberately minimal and without a UI: sing-box 1.14 installs no geosite
 * database, the owner's routing uses plain `domain_suffix`, and a bare
 * `FATAL open geosite file: …` is not an answer a form should show. A missing
 * database becomes a sentence.
 *
 * @param {string} domain
 * @param {{env?: Record<string, string|undefined>, timeout?: number,
 *   signal?: AbortSignal}} [options]
 * @returns {Promise<{ok: boolean, available: boolean, domain: string, message: string,
 *   stdout: string, stderr: string, code: number|null}>}
 */
export async function geositeLookup(domain, options = {}) {
  const config = systemConfig(options.env, options);
  const result = await run(config.singbox, ['geosite', 'lookup', String(domain)], {
    timeout: positive(options.timeout, config.testTimeout),
    env: options.env,
    signal: options.signal,
  });

  if (result.ok) {
    return {
      ok: true,
      available: true,
      domain: String(domain),
      message: result.stdout.trim(),
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
    };
  }

  const combined = `${result.stderr}\n${result.stdout}`;
  const missingDatabase = /geosite file|geosite\.db|no such file or directory/i.test(combined);

  return {
    ok: false,
    available: false,
    domain: String(domain),
    message: missingDatabase
      ? 'база geosite не установлена: в sing-box 1.14 базы не ставятся, функциональность перешла в rule-sets'
      : `geosite lookup не удалось: ${result.error ?? 'команда завершилась с ошибкой'}`,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
  };
}

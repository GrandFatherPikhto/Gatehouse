// Writing of a normalised tunnel config into the amnezia directory.
//
// Part 1 of the tunnel-lifecycle task: the preview screen of the editor stops
// being read-only and gains an «Применить» button. The button writes the result
// of `normalizeTunnel` to `<amneziaDir>/<name>.conf` — the exact path the
// `awg-quick@<name>` template unit reads. It does NOT bring the tunnel up: that
// is a separate action of part 2, on purpose, because writing a file is
// reversible and starting a unit that carries the owner's link to the router is
// not.
//
// Three rules, taken from the task:
//   * the file is created 0600 — it carries a private key;
//   * overwriting a differing file takes a snapshot NEXT TO it
//     (`<name>.conf.<label>`) before the bytes are replaced;
//   * writing the same bytes again is a no-op: «изменений нет», no file touched
//     and, above all, no snapshot for an edit that changed nothing.
//
// The module is deliberately standalone: the model calls it, but it imports only
// `node:fs`/`node:path`, so it stays testable without a server.

import fs from 'node:fs';
import path from 'node:path';

import {hasTableOff} from '../core/normalize.mjs';

/** Snapshot prefix separator: `<name>.conf` + `.` + label. */
const SNAPSHOT_SEPARATOR = '.';

/** How many snapshots of one tunnel config are kept; the rest are deleted oldest first. */
export const DEFAULT_TUNNEL_SNAPSHOT_KEEP = 5;

/**
 * Path of the applied config of one tunnel.
 *
 * @param {string} amneziaDir
 * @param {string} name Interface name, without the `.conf` suffix.
 * @returns {string}
 */
export function tunnelConfigPath(amneziaDir, name) {
  return path.join(amneziaDir, `${name}.conf`);
}

/**
 * True when the tunnel config is already in the amnezia directory.
 *
 * Separate from the systemd state on purpose: a `.conf` that exists but whose
 * unit is unknown to systemd and a `.conf` that does not exist at all are two
 * different answers, and the panel has to say which one it is.
 *
 * @param {string} amneziaDir
 * @param {string} name
 * @returns {boolean}
 */
export function tunnelConfigApplied(amneziaDir, name) {
  return fs.existsSync(tunnelConfigPath(amneziaDir, name));
}

/**
 * Names of the applied tunnel configs in the amnezia directory, sorted.
 *
 * Snapshots (`<name>.conf.<label>`) do not end with `.conf` and therefore never
 * appear here. A file whose stem ends with `.conf` (a `de.conf.conf` left from a
 * manual `systemctl restart awg-quick@de.conf`) is returned by this function and
 * dropped by the caller, which validates the stem as an interface name — that is
 * what keeps such leftovers out of the tunnel lists (§2.4 of the task).
 *
 * @param {string} amneziaDir
 * @returns {string[]} File names, not full paths.
 */
export function listTunnelConfigNames(amneziaDir) {
  let entries;
  try {
    entries = fs.readdirSync(amneziaDir);
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.endsWith('.conf')).sort();
}

/**
 * Reads the applied config of one tunnel.
 *
 * @param {string} amneziaDir
 * @param {string} name
 * @returns {{path: string, exists: boolean, text: string|null}}
 */
export function readTunnelConfig(amneziaDir, name) {
  const filePath = tunnelConfigPath(amneziaDir, name);
  try {
    return {path: filePath, exists: true, text: fs.readFileSync(filePath, 'utf8')};
  } catch {
    return {path: filePath, exists: false, text: null};
  }
}

/**
 * The refusal of the start-up fuse, worded by its consequence.
 *
 * It is a refusal and not a warning on purpose: the price of the mistake is the
 * owner's link to the router, so there must be no "start anyway". No flag, no
 * setting and no request may bypass it — see `tunnelAction` of the system layer.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function unsafeTunnelMessage(filePath) {
  return (
    'Запуск отменён: этот конфиг уведёт в туннель весь трафик роутера, включая ваше ' +
    `подключение к нему. В файле ${filePath} нет 'Table = off'. Откройте туннель в ` +
    '«Провайдерах» и примените нормализованный конфиг.'
  );
}

/**
 * The start-up fuse: reads the file AS IT IS NOW and answers whether the tunnel
 * may be started from it.
 *
 * The check is done at start time, not only at write time: between writing and
 * starting the file may have been replaced, dropped in by hand or left over from
 * earlier times. A missing file is a refusal too — there is nothing to start.
 *
 * @param {string} amneziaDir
 * @param {string} name
 * @returns {{safe: boolean, path: string, exists: boolean, reason: string|null}}
 */
export function tunnelStartupGuard(amneziaDir, name) {
  const file = readTunnelConfig(amneziaDir, name);
  if (!file.exists) {
    return {
      safe: false,
      path: file.path,
      exists: false,
      reason: `Запуск отменён: файл ${file.path} не найден — запускать нечего.`,
    };
  }
  if (!hasTableOff(file.text ?? '')) {
    return {safe: false, path: file.path, exists: true, reason: unsafeTunnelMessage(file.path)};
  }
  return {safe: true, path: file.path, exists: true, reason: null};
}

/**
 * Removes the applied config of one tunnel, leaving its snapshots in place.
 *
 * Snapshots are history: deleting them would erase the only copy of what the
 * unit used to run. Returns `false` when there was nothing to remove.
 *
 * @param {string} amneziaDir
 * @param {string} name
 * @returns {boolean}
 */
export function removeTunnelConfig(amneziaDir, name) {
  const target = tunnelConfigPath(amneziaDir, name);
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target);
  return true;
}

/**
 * Builds a snapshot label from a date. ISO-8601 sorts chronologically as a plain
 * string, which is what the pruning below relies on.
 *
 * @param {Date} [now]
 * @returns {string}
 */
function snapshotLabel(now) {
  return (now instanceof Date ? now : new Date()).toISOString();
}

/**
 * Lists the snapshots of one tunnel config, oldest first.
 *
 * @param {string} amneziaDir
 * @param {string} name
 * @returns {string[]} Full paths.
 */
export function listTunnelSnapshots(amneziaDir, name) {
  const prefix = `${name}.conf${SNAPSHOT_SEPARATOR}`;
  let entries;
  try {
    entries = fs.readdirSync(amneziaDir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.startsWith(prefix) && entry.length > prefix.length)
    .map((entry) => path.join(amneziaDir, entry))
    .sort();
}

/**
 * Deletes the oldest snapshots of one tunnel config, keeping the last `keep`.
 *
 * @param {string} amneziaDir
 * @param {string} name
 * @param {number} keep
 * @returns {string[]} Removed paths.
 */
export function pruneTunnelSnapshots(amneziaDir, name, keep) {
  const snapshots = listTunnelSnapshots(amneziaDir, name);
  if (keep <= 0) {
    for (const file of snapshots) fs.rmSync(file, {force: true});
    return snapshots;
  }
  const stale = snapshots.slice(0, Math.max(0, snapshots.length - keep));
  for (const file of stale) fs.rmSync(file, {force: true});
  return stale;
}

/**
 * Writes `text` atomically with mode 0600: a temporary file in the same
 * directory, then a rename over the target. A crash cannot leave a truncated
 * tunnel config the unit would refuse to start.
 *
 * @param {string} filePath
 * @param {string} text
 */
function writePrivate(filePath, text) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, {recursive: true});
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, text, {encoding: 'utf8', mode: 0o600});
    // `writeFileSync` honours the mode only when the file is created; if the
    // temporary file survives from an earlier crash it may already be broader.
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try {
      fs.rmSync(temporary, {force: true});
    } catch {
      // ignore: the original error is the one worth reporting
    }
    throw error;
  }
}

/**
 * Applies one normalised tunnel config.
 *
 * @param {string} text Normalised text, exactly as `normalizeTunnel` returned it.
 * @param {{name: string, amneziaDir: string, keep?: number, now?: Date}} options
 *   `now` is injected by tests; `keep` is the number of snapshots kept.
 * @returns {{path: string, changed: boolean, snapshot: string|null, removed: string[]}}
 *   `changed` is false when the file already held exactly these bytes.
 */
export function applyTunnelConfig(text, options) {
  const name = String(options.name ?? '').trim();
  const amneziaDir = String(options.amneziaDir ?? '').trim();
  if (name.length === 0) throw new Error('applyTunnelConfig: не задано имя туннеля');
  if (amneziaDir.length === 0) throw new Error('applyTunnelConfig: не задан каталог amnezia');

  const target = tunnelConfigPath(amneziaDir, name);
  const keep = options.keep ?? DEFAULT_TUNNEL_SNAPSHOT_KEEP;

  if (fs.existsSync(target)) {
    let current;
    try {
      current = fs.readFileSync(target, 'utf8');
    } catch (error) {
      throw new Error(`не удалось прочитать ${target}: ${error.message}`);
    }
    if (current === text) {
      // Same bytes: leave the file and the snapshot series alone. A needless
      // write would only add a snapshot of a version nobody ever ran.
      return {path: target, changed: false, snapshot: null, removed: []};
    }
  }

  let snapshot = null;
  let removed = [];
  if (fs.existsSync(target)) {
    const label = snapshotLabel(options.now);
    let snapshotPath = `${target}${SNAPSHOT_SEPARATOR}${label}`;
    for (let n = 0; fs.existsSync(snapshotPath); n += 1) {
      const letter = String.fromCharCode(97 + (n % 26)); // 'a' sorts after '.'
      snapshotPath = `${target}${SNAPSHOT_SEPARATOR}${label}${letter}`;
    }
    fs.mkdirSync(amneziaDir, {recursive: true});
    fs.copyFileSync(target, snapshotPath);
    snapshot = snapshotPath;
    removed = pruneTunnelSnapshots(amneziaDir, name, keep);
  }

  writePrivate(target, text);
  return {path: target, changed: true, snapshot, removed};
}

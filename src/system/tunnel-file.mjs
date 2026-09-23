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

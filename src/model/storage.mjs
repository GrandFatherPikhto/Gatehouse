// File handling of the web editor's own state: the canonical format of
// webui.json, atomic writes and snapshots.
//
// This module is deliberately separate from `src/core/`: the core keeps the
// contract with the Python reference (`stringifyConfig` has no trailing newline,
// because `json.dump` had none), while `webui.json` is a hand-editable source
// file owned by this tool. The two formats differ on purpose and this file is
// where that decision lives.

import fs from 'node:fs';
import path from 'node:path';

/** Directory of snapshots and other runtime state, relative to the project. */
export const DEFAULT_STATE_DIR = '.state';

/** Sub-directory of the state directory that holds webui.json snapshots. */
export const SNAPSHOT_DIRNAME = 'snapshots';

/** How many snapshots are kept; the rest are deleted oldest first. */
export const DEFAULT_SNAPSHOT_KEEP = 10;

/** File name prefix of a snapshot. */
export const SNAPSHOT_PREFIX = 'webui-';

/**
 * Serialises `webui.json` in the canonical format of this tool: two-space
 * indent and a trailing newline.
 *
 * Do NOT replace this with `stringifyConfig` of the core. That one reproduces
 * `json.dump(..., indent=2)` byte for byte and therefore has no trailing
 * newline; it is the contract of `config.json` and the acceptance test compares
 * those bytes with the reference.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Writes a file atomically: the text goes to a temporary file in the same
 * directory and is then renamed over the target. `rename` is atomic on POSIX
 * filesystems, so an interrupted save cannot leave a truncated `webui.json`.
 *
 * The file is created with mode 0600: `webui.json` holds personal server lists.
 *
 * @param {string} filePath Target path.
 * @param {string} text Content to write.
 */
export function writeAtomic(filePath, text) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, {recursive: true});

  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, text, {encoding: 'utf8', mode: 0o600});
    fs.renameSync(temporary, filePath);
  } catch (error) {
    // Best effort: a leftover temporary file is confusing but harmless.
    try {
      fs.rmSync(temporary, {force: true});
    } catch {
      // ignore: the original error is the one worth reporting
    }
    throw error;
  }
}

/**
 * Path of the snapshot directory for a state directory.
 *
 * @param {string} stateDir
 * @returns {string}
 */
export function snapshotDir(stateDir) {
  return path.join(stateDir, SNAPSHOT_DIRNAME);
}

/**
 * Lists the snapshots of a state directory, oldest first. ISO-8601 labels sort
 * chronologically as plain strings, which is what the pruning relies on.
 *
 * @param {string} stateDir
 * @returns {string[]} File names, not full paths.
 */
export function listSnapshots(stateDir) {
  const dir = snapshotDir(stateDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(SNAPSHOT_PREFIX) && name.endsWith('.json'))
    .sort();
}

/**
 * Deletes the oldest snapshots, keeping the last `keep`.
 *
 * @param {string} stateDir
 * @param {number} [keep]
 * @returns {string[]} Names of the removed snapshots.
 */
export function pruneSnapshots(stateDir, keep = DEFAULT_SNAPSHOT_KEEP) {
  const names = listSnapshots(stateDir);
  if (keep <= 0) {
    const removed = [...names];
    for (const name of removed) fs.rmSync(path.join(snapshotDir(stateDir), name), {force: true});
    return removed;
  }

  const stale = names.slice(0, Math.max(0, names.length - keep));
  for (const name of stale) fs.rmSync(path.join(snapshotDir(stateDir), name), {force: true});
  return stale;
}

/**
 * Copies the current `webui.json` into the state directory before it is
 * overwritten.
 *
 * Copies the bytes as they are: a snapshot is evidence of what was on disk, so
 * re-serialising it would defeat the purpose. Returns `null` when there is
 * nothing to preserve yet (the first save of a new file).
 *
 * @param {string} filePath File that is about to be overwritten.
 * @param {string} stateDir
 * @param {{keep?: number, now?: Date}} [options] `now` is injected by tests.
 * @returns {{path: string, removed: string[]}|null}
 */
export function takeSnapshot(filePath, stateDir, options = {}) {
  const keep = options.keep ?? DEFAULT_SNAPSHOT_KEEP;
  if (!fs.existsSync(filePath)) return null;

  const dir = snapshotDir(stateDir);
  fs.mkdirSync(dir, {recursive: true});

  const label = (options.now instanceof Date ? options.now : new Date()).toISOString();
  let target = path.join(dir, `${SNAPSHOT_PREFIX}${label}.json`);
  // Two saves in the same millisecond must not silently overwrite a snapshot.
  // The suffix is a letter, not a number, because the oldest-first order used by
  // the pruning is a plain name sort and '-' sorts BEFORE '.' : a numeric suffix
  // would land in front of the snapshot it collides with.
  for (let n = 0; fs.existsSync(target); n += 1) {
    const letter = String.fromCharCode(97 + (n % 26)); // 'a' sorts after '.'
    target = path.join(dir, `${SNAPSHOT_PREFIX}${label}${letter}.json`);
  }

  fs.copyFileSync(filePath, target);
  return {path: target, removed: pruneSnapshots(stateDir, keep)};
}

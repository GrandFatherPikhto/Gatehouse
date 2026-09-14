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
 * File name prefix of a `config.json` snapshot. The generated config lives in a
 * different directory (`/etc/sing-box`) and is owned by the daemon, not by this
 * tool, so it gets its own series next to the `webui-` ones: the rollback has to
 * restore the exact bytes the daemon last ran, and mixing the two series would
 * make "the previous config" ambiguous.
 */
export const CONFIG_SNAPSHOT_PREFIX = 'config-';

/** How many `config.json` snapshots are kept; the rest are deleted oldest first. */
export const DEFAULT_CONFIG_SNAPSHOT_KEEP = 10;

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
 * @param {string} [prefix] Series to list; `webui-` by default.
 * @returns {string[]} File names, not full paths.
 */
export function listSnapshots(stateDir, prefix = SNAPSHOT_PREFIX) {
  const dir = snapshotDir(stateDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .sort();
}

/**
 * Deletes the oldest snapshots of one series, keeping the last `keep`.
 *
 * @param {string} stateDir
 * @param {number} [keep]
 * @param {string} [prefix] Series to prune; `webui-` by default.
 * @returns {string[]} Names of the removed snapshots.
 */
export function pruneSnapshots(stateDir, keep = DEFAULT_SNAPSHOT_KEEP, prefix = SNAPSHOT_PREFIX) {
  const names = listSnapshots(stateDir, prefix);
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
 * Lists the `config.json` snapshots of a state directory, oldest first.
 *
 * @param {string} stateDir
 * @returns {string[]} File names, not full paths.
 */
export function listConfigSnapshots(stateDir) {
  return listSnapshots(stateDir, CONFIG_SNAPSHOT_PREFIX);
}

/**
 * Copies the generated `config.json` aside before the generator overwrites it.
 *
 * Same rule as `webui.json`: the bytes are copied as they are, because a snapshot
 * is evidence of what the daemon actually ran. Returns `null` when there is
 * nothing on disk yet (the first generation).
 *
 * @param {string} filePath Path of the generated config.
 * @param {string} stateDir
 * @param {{keep?: number, now?: Date}} [options]
 * @returns {{path: string, removed: string[]}|null}
 */
export function snapshotConfig(filePath, stateDir, options = {}) {
  return takeSnapshot(filePath, stateDir, {
    keep: options.keep ?? DEFAULT_CONFIG_SNAPSHOT_KEEP,
    now: options.now,
    prefix: CONFIG_SNAPSHOT_PREFIX,
  });
}

/**
 * Full path of the newest `config.json` snapshot, or `null` when there is none.
 *
 * @param {string} stateDir
 * @returns {string|null}
 */
export function latestConfigSnapshot(stateDir) {
  const names = listConfigSnapshots(stateDir);
  if (names.length === 0) return null;
  return path.join(snapshotDir(stateDir), names[names.length - 1]);
}

/**
 * Restores the newest `config.json` snapshot over the live config.
 *
 * Writes through a temporary file and a `rename`, so the daemon never observes a
 * half-written config, and keeps the mode of the restored bytes at 0600: the
 * config lists every server of the owner and is not for other accounts.
 *
 * @param {string} stateDir
 * @param {string} target Path of the live config to overwrite.
 * @returns {{restored: string, from: string}|null} `null` when there is no snapshot.
 */
export function restoreLatestConfig(stateDir, target) {
  const source = latestConfigSnapshot(stateDir);
  if (source === null) return null;

  const directory = path.dirname(target);
  fs.mkdirSync(directory, {recursive: true});
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.restore.${process.pid}.${Date.now()}.tmp`,
  );

  try {
    fs.copyFileSync(source, temporary);
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, target);
  } catch (error) {
    try {
      fs.rmSync(temporary, {force: true});
    } catch {
      // ignore: the original error is the one worth reporting
    }
    throw error;
  }
  return {restored: target, from: source};
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
  const prefix = options.prefix ?? SNAPSHOT_PREFIX;
  if (!fs.existsSync(filePath)) return null;

  const dir = snapshotDir(stateDir);
  fs.mkdirSync(dir, {recursive: true});

  const label = (options.now instanceof Date ? options.now : new Date()).toISOString();
  let target = path.join(dir, `${prefix}${label}.json`);
  // Two saves in the same millisecond must not silently overwrite a snapshot.
  // The suffix is a letter, not a number, because the oldest-first order used by
  // the pruning is a plain name sort and '-' sorts BEFORE '.' : a numeric suffix
  // would land in front of the snapshot it collides with.
  for (let n = 0; fs.existsSync(target); n += 1) {
    const letter = String.fromCharCode(97 + (n % 26)); // 'a' sorts after '.'
    target = path.join(dir, `${prefix}${label}${letter}.json`);
  }

  fs.copyFileSync(filePath, target);
  return {path: target, removed: pruneSnapshots(stateDir, keep, prefix)};
}

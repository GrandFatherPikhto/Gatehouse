// Naming guard: the rename to GateHouse must leave no trace of the old name.
//
// The task asks for a TEST and not a pair of eyes, because a single missed
// occurrence is exactly the kind of thing a review waves through. The forbidden
// strings are assembled from fragments below on purpose: if they were written out
// verbatim, this very file would be the first offender it reports.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';

import {REPO_ROOT} from './helpers.mjs';

/** The old spellings, glued from pieces so this file stays clean. */
const OLD_NAMES = [
  `${['SINGBOX', 'WEBUI'].join('_')}_`,
  ['sing', 'box', 'webui'].join('-'),
  ['sing', 'box', 'web', 'ui'].join('-'),
  ['singbox', 'webui'].join('-'),
];

// Generated, historical or secret-bearing trees that are not part of the
// repository: `techdocs/` is git-ignored, `dev/root/` holds the owner's copies,
// and `node_modules/`/`.git/` are not the project's text at all.
const SKIP_DIRS = new Set(['node_modules', '.git', 'techdocs', '.state']);
const SKIP_PATHS = new Set([path.join(REPO_ROOT, 'dev', 'root')]);

/**
 * Every regular file under `dir`, minus the skipped trees.
 *
 * @param {string} dir
 * @param {string[]} [files]
 * @returns {string[]}
 */
function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || SKIP_PATHS.has(full)) continue;
      walk(full, files);
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

test('no file name carries the old project name', () => {
  const offenders = walk(REPO_ROOT)
    .map((file) => path.relative(REPO_ROOT, file))
    .filter((relative) => OLD_NAMES.some((old) => relative.includes(old)));

  assert.deepEqual(offenders, [], `old names in file names:\n${offenders.join('\n')}`);
});

test('no file content carries the old project name', () => {
  const offenders = [];

  for (const file of walk(REPO_ROOT)) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // A binary file cannot carry the name; reading it as UTF-8 is pointless.
    }
    for (const old of OLD_NAMES) {
      if (text.includes(old)) offenders.push(`${path.relative(REPO_ROOT, file)}: ${old}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `the rename left these occurrences behind:\n${offenders.join('\n')}`,
  );
});

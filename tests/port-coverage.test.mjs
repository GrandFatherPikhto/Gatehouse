// Guards the coverage table of the port.
//
// The task demands that all 79 test functions of the reference are accounted
// for. The TUI, the reference `main()` and its shims are explicitly out of
// scope, so "accounted for" means: every reference test function is listed in
// techdocs/port-coverage.md either as ported or as deliberately not ported with
// a reason. Without this test a silent omission would go unnoticed.
//
// The test skips itself when the reference project is not on the machine (a
// clean clone has no reason to carry it): the coverage table stays the artifact.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';

import {DEFAULT_PYTHON_REPO} from '../tools/compare-with-python.mjs';
import {REPO_ROOT} from './helpers.mjs';

const REFERENCE_REPO = process.env.SINGBOXTOOLS_REPO || DEFAULT_PYTHON_REPO;
const REFERENCE_TESTS = path.join(REFERENCE_REPO, 'tests/test_sing_box_manager.py');
const COVERAGE_DOC = path.join(REPO_ROOT, 'techdocs/port-coverage.md');

const missing = [
  [REFERENCE_TESTS, 'reference test suite'],
  [COVERAGE_DOC, 'coverage document'],
].filter(([file]) => !fs.existsSync(file));

test(
  'every reference test function is accounted for in techdocs/port-coverage.md',
  {skip: missing.length > 0 ? `not found: ${missing.map(([file]) => file).join(', ')}` : false},
  () => {
    const source = fs.readFileSync(REFERENCE_TESTS, 'utf8');
    const document = fs.readFileSync(COVERAGE_DOC, 'utf8');
    const names = [...source.matchAll(/^def (test_[A-Za-z0-9_]+)/gm)].map((match) => match[1]);

    assert.ok(names.length >= 75, `expected the reference suite to be found, got ${names.length}`);

    const unaccounted = names.filter((name) => !document.includes(name));
    assert.deepEqual(
      unaccounted,
      [],
      `these reference tests are missing from techdocs/port-coverage.md: ${unaccounted.join(', ')}`,
    );
  },
);

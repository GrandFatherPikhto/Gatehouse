// GateHouse tunnels live in their own directory and have their own template unit.
//
// These tests pin the invariants the move introduced:
//   * the write path, the start-up fuse and the template unit agree on ONE
//     directory, and it is the build constant;
//   * the unit name is `gatehouse-tunnel@<name>` everywhere, with `%i` and without
//     any tie to `awg-quick.target`;
//   * "no access" is an answer of its own, never "no file";
//   * a name an interface outside GateHouse already holds is refused in words;
//   * `awg-quick@` survives only as a comment that explains why.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {
  DEFAULT_AMNEZIA_DIR,
  enableTunnel,
  parseTunnelSudoers,
  tunnelInterfaceCollision,
  tunnelPermissions,
  tunnelSudoersLines,
  tunnelUnitName,
} from '../src/system/index.mjs';
import {
  applyTunnelConfig,
  tunnelDirState,
  tunnelStartupGuard,
} from '../src/system/tunnel-file.mjs';
import {FAKE_SYSTEMCTL, fakeSystemEnv, makeTempDir, tunnelSystemEnv} from './helpers.mjs';

/** The repository root, one level above this test file. */
const ROOT = path.join(import.meta.dirname, '..');

/** Absolute path of a file in `deploy/`. */
function deploy(file) {
  return path.join(ROOT, 'deploy', file);
}

/** True when the process runs as root, where permission bits do not apply. */
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

/** Reason to skip a permissions test, or `false` to run it. */
const ROOT_SKIP = IS_ROOT ? 'запущено от root: права не действуют' : false;

describe('the tunnel directory is one, and the unit reads it', () => {
  test('the service env, the unit ExecStart and DEFAULT_AMNEZIA_DIR agree', () => {
    const service = fs.readFileSync(deploy('gatehouse.service'), 'utf8');
    const unit = fs.readFileSync(deploy('gatehouse-tunnel@.service'), 'utf8');

    const fromService = /Environment=GATEHOUSE_AMNEZIA_DIR=(\S+)/.exec(service);
    const fromUnit = /ExecStart=\/usr\/bin\/awg-quick up (\S+)\/%i\.conf/.exec(unit);

    assert.ok(fromService, 'the service names GATEHOUSE_AMNEZIA_DIR');
    assert.ok(fromUnit, 'the unit starts awg-quick with a full path');
    assert.equal(fromService[1], DEFAULT_AMNEZIA_DIR);
    assert.equal(fromUnit[1], DEFAULT_AMNEZIA_DIR);
  });

  test('the polkit unit agrees on the tunnel directory and ReadWritePaths', () => {
    const main = fs.readFileSync(deploy('gatehouse.service'), 'utf8');
    const polkit = fs.readFileSync(deploy('gatehouse.service.polkit'), 'utf8');

    const dirOf = (text) => /Environment=GATEHOUSE_AMNEZIA_DIR=(\S+)/.exec(text)?.[1];
    assert.equal(dirOf(polkit), dirOf(main));
    assert.equal(dirOf(polkit), DEFAULT_AMNEZIA_DIR);

    const pathsOf = (text) =>
      /ReadWritePaths=(.+)/.exec(text)?.[1].trim().split(/\s+/).sort();
    assert.deepEqual(pathsOf(polkit), pathsOf(main));

    // Neither unit may open the hand-written amnezia directory: GateHouse tunnels
    // live in `/etc/gatehouse/tunnels` and nothing here touches the owner's own.
    assert.doesNotMatch(polkit, /\/etc\/amnezia/);
    assert.doesNotMatch(main, /\/etc\/amnezia/);
  });

  test('the template uses %i, has no PartOf and no ExecReload', () => {
    // Comments explain the choices and mention `%I`, so they are stripped first.
    const unit = stripComments(fs.readFileSync(deploy('gatehouse-tunnel@.service'), 'utf8'));
    assert.match(unit, /ExecStart=\/usr\/bin\/awg-quick up \S+%i\.conf/);
    assert.doesNotMatch(unit, /%I/, '%I would turn `hmn-graz` into `hmn/graz`');
    assert.doesNotMatch(unit, /PartOf=/, 'manual amnezia operations must not touch GateHouse tunnels');
    assert.doesNotMatch(unit, /ExecReload/, 'the editor never reloads a tunnel');
  });
});

describe('the unit name is gatehouse-tunnel@ everywhere', () => {
  test('tunnelUnitName and the sudoers lines use it', () => {
    assert.equal(tunnelUnitName('hmn-graz'), 'gatehouse-tunnel@hmn-graz');
    const lines = tunnelSudoersLines('hmn-graz', {systemctl: FAKE_SYSTEMCTL, user: 'denis'});
    assert.match(lines[0], /enable --now gatehouse-tunnel@hmn-graz/);
    assert.match(lines[2], /restart gatehouse-tunnel@hmn-graz/);
  });

  test('a rule on the stock awg-quick@ unit is NOT a GateHouse right', () => {
    const parsed = parseTunnelSudoers(
      `denis ALL=(root) NOPASSWD: ${FAKE_SYSTEMCTL} restart awg-quick@de`,
      {systemctl: FAKE_SYSTEMCTL},
    );
    assert.deepEqual(parsed, {});
  });
});

describe('no access is not "no file"', () => {
  test('the fuse refuses an unreadable config without saying "не найден"', {skip: ROOT_SKIP}, () => {
    const dir = makeTempDir();
    const amneziaDir = path.join(dir, 'amnezia');
    fs.mkdirSync(amneziaDir);
    const file = path.join(amneziaDir, 'de.conf');
    fs.writeFileSync(file, '[Interface]\nTable = off\n');
    fs.chmodSync(file, 0o000);

    const guard = tunnelStartupGuard(amneziaDir, 'de');
    assert.equal(guard.safe, false);
    assert.match(guard.reason, /нет прав/);
    assert.doesNotMatch(guard.reason, /не найден/);
  });

  test('an unlistable directory is denied, with its owner named', {skip: ROOT_SKIP}, () => {
    const dir = makeTempDir();
    const amneziaDir = path.join(dir, 'amnezia');
    fs.mkdirSync(amneziaDir);
    fs.chmodSync(amneziaDir, 0o000);
    try {
      const state = tunnelDirState(amneziaDir);
      assert.equal(state.state, 'denied');
      assert.ok(state.owner !== null, 'stat still works, so the owner can be shown');
    } finally {
      fs.chmodSync(amneziaDir, 0o700);
    }
  });

  test('an unreadable sudoers is named, and does not print "add the rules"', {skip: ROOT_SKIP}, () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'sudoers-gatehouse');
    fs.writeFileSync(file, `${FAKE_SYSTEMCTL} restart gatehouse-tunnel@de\n`);
    fs.chmodSync(file, 0o000);

    const rights = tunnelPermissions(file, ['de'], {systemctl: FAKE_SYSTEMCTL, user: 'denis'});
    assert.equal(rights.de.sudoersReadable, false);
    assert.match(rights.de.sudoersNotice, /не могу прочитать/);
    assert.doesNotMatch(rights.de.sudoersNotice, /добавьте строки/);
  });

  test('writing into a directory without write permission is named', {skip: ROOT_SKIP}, () => {
    const dir = makeTempDir();
    const amneziaDir = path.join(dir, 'amnezia');
    fs.mkdirSync(amneziaDir);
    fs.chmodSync(amneziaDir, 0o500);
    try {
      assert.throws(
        () => applyTunnelConfig('Table = off\n', {name: 'de', amneziaDir}),
        /нет прав на запись/,
      );
    } finally {
      fs.chmodSync(amneziaDir, 0o700);
    }
  });
});

describe('a name an interface outside GateHouse already holds', () => {
  test('is refused in words, and skipped when awg cannot be run', async () => {
    const dir = makeTempDir();
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin, {recursive: true});
    const awg = path.join(bin, 'awg');
    fs.writeFileSync(awg, "#!/bin/sh\nprintf '%s\\n' 'de'\n");
    fs.chmodSync(awg, 0o755);

    const env = {...fakeSystemEnv(), GATEHOUSE_AWG: awg};
    const collision = await tunnelInterfaceCollision('de', {env});
    assert.match(collision, /занято интерфейсом вне GateHouse/);
    assert.equal(await tunnelInterfaceCollision('free0', {env}), null);

    // The binary is absent (a desktop sandbox): the question cannot be asked, so
    // the check is skipped and nothing is refused.
    const missing = {...fakeSystemEnv(), GATEHOUSE_AWG: path.join(dir, 'nope')};
    assert.equal(await tunnelInterfaceCollision('de', {env: missing}), null);
  });

  test('enable refuses the occupied name before it runs systemctl', async () => {
    const dir = makeTempDir();
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin, {recursive: true});
    const awg = path.join(bin, 'awg');
    fs.writeFileSync(awg, "#!/bin/sh\nprintf '%s\\n' 'de'\n");
    fs.chmodSync(awg, 0o755);

    const amneziaDir = path.join(dir, 'amnezia');
    fs.mkdirSync(amneziaDir);
    fs.writeFileSync(path.join(amneziaDir, 'de.conf'), '[Interface]\nTable = off\n');

    const env = {
      ...fakeSystemEnv(),
      ...tunnelSystemEnv(dir, {sudoers: path.join(dir, 'no-sudoers')}),
      GATEHOUSE_AWG: awg,
    };
    const result = await enableTunnel('de', {env});
    assert.equal(result.refused, true);
    assert.match(result.error, /занято интерфейсом вне GateHouse/);
    assert.deepEqual(result.command, [], 'systemctl was never called');
  });
});

describe('awg-quick@ survives only as an explanation', () => {
  test('no file in src/, views/ or deploy/ uses it outside a comment', () => {
    const roots = ['src', 'views', 'deploy'].map((name) => path.join(ROOT, name));
    const files = roots.flatMap((root) => walk(root));

    for (const file of files) {
      const stripped = stripComments(fs.readFileSync(file, 'utf8'));
      assert.doesNotMatch(
        stripped,
        /awg-quick@/,
        `${path.relative(ROOT, file)} mentions awg-quick@ outside a comment`,
      );
    }
  });
});

/** Every file under a directory, recursively. */
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/**
 * Removes comments so a mention inside one does not count: block comments, EJS
 * comment blocks, then whole-line line comments.
 *
 * @param {string} text
 * @returns {string}
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<%#[\s\S]*?%>/g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return false;
      return !trimmed.startsWith('//') && !trimmed.startsWith('#') && !trimmed.startsWith('*');
    })
    .join('\n');
}

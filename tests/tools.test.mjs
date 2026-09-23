// CLI and tooling tests: tools/generate.mjs and tools/dev.mjs.
//
// The reference TUI (`pick_proxy`, `filter_and_select`, `ask_wqx`) is out of
// scope, but the non-interactive CLI scenario of the reference `main()` is kept,
// so its cases are ported here with a note.

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {FI_TAG, FIXTURES_DIR, makeTempDir, NL_TAG, REPO_ROOT, writeLinksFile, writeSettings} from './helpers.mjs';

const FIXTURE_SETTINGS = path.join(FIXTURES_DIR, 'settings.json');
const GOLDEN_CONFIG = path.join(FIXTURES_DIR, 'golden', 'config.json');

/**
 * Runs one of the tools in a child process, exactly as the acceptance commands
 * do. Returns the spawnSync result.
 *
 * @param {string} tool File name inside tools/.
 * @param {string[]} args
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runTool(tool, args) {
  return spawnSync(process.execPath, [path.join(REPO_ROOT, 'tools', tool), ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

// Reference: test_main_generate_config_flag (CLI scenario of the reference main()).
test('generate.mjs: builds the fixture config byte-identical to the golden file', () => {
  const output = path.join(makeTempDir(), 'config.json');

  const result = runTool('generate.mjs', ['--settings', FIXTURE_SETTINGS, '--output', output]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Готово!/);
  assert.match(result.stdout, /Серверов: 3, инбаундов: 2, пулов: 1/);
  assert.match(result.stdout, /=== Настройки прокси ===/);
  assert.match(result.stdout, /\[SOCKS\] main-socks/);
  assert.match(result.stdout, /\[HTTP\] apps-http/);
  assert.match(result.stdout, /auto-select \(все, кроме exclude_from_auto\)/);
  assert.match(result.stderr, /Исключены из auto-select \(1\): 🇷🇺 Russia - Moscow/);
  assert.deepEqual(fs.readFileSync(output), fs.readFileSync(GOLDEN_CONFIG));
});

// Reference: test_main_override_flags_switch_off_tui (the override part)
test('generate.mjs: --listen-ip overrides the profile value', () => {
  const dir = makeTempDir();
  const {settingsFile} = {settingsFile: writeSettings(dir)};
  writeLinksFile(dir);
  const output = path.join(dir, 'config.json');

  const result = runTool('generate.mjs', [
    '--settings',
    settingsFile,
    '--listen-ip',
    '10.95.2.1',
    '--output',
    output,
  ]);

  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(config.inbounds[0].listen, '10.95.2.1');
});

// Reference: test_main_reports_excluded_and_empty_auto_select
test('generate.mjs: reports exclusions and an empty auto-select', () => {
  const dir = makeTempDir();
  writeLinksFile(dir);
  const settingsFile = writeSettings(dir, {exclude_from_auto: [FI_TAG]});

  const excluded = runTool('generate.mjs', [
    '--settings',
    settingsFile,
    '--output',
    path.join(dir, 'a.json'),
  ]);
  assert.equal(excluded.status, 0, excluded.stderr);
  assert.match(excluded.stderr, /Исключены из auto-select \(1\)/);
  assert.ok(excluded.stderr.includes(FI_TAG));

  const all = writeSettings(dir, {exclude_from_auto: [FI_TAG, NL_TAG, '🇷🇺 Russia - Moscow']});
  const empty = runTool('generate.mjs', ['--settings', all, '--output', path.join(dir, 'b.json')]);
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stderr, /auto-select пуст/);
});

// Reference: test_main_override_flags_switch_off_tui (--exclude-from-auto of argparse)
test('generate.mjs: --exclude-from-auto accepts several prefixes', () => {
  const dir = makeTempDir();
  writeLinksFile(dir);
  const settingsFile = writeSettings(dir);
  const output = path.join(dir, 'config.json');

  const result = runTool('generate.mjs', [
    '--settings',
    settingsFile,
    '--exclude-from-auto',
    '🇫🇮',
    '🇳🇱',
    '--output',
    output,
  ]);

  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.deepEqual(config.outbounds[0].outbounds, ['🇷🇺 Russia - Moscow']);
});

// Reference: test_main_missing_settings_returns_error
test('generate.mjs: a missing settings file exits with 1', () => {
  const result = runTool('generate.mjs', [
    '--settings',
    path.join(makeTempDir(), 'nope.json'),
    '--output',
    path.join(makeTempDir(), 'config.json'),
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Ошибка:/);
  assert.match(result.stderr, /не найден/);
});

// Reference: test_main_invalid_config_returns_error
test('generate.mjs: an unknown server exits with 1 and lists the available ones', () => {
  const dir = makeTempDir();
  writeLinksFile(dir);
  const settingsFile = writeSettings(dir, {
    proxies: [{tag: 'apps-http', type: 'http', port: 54323, servers: ['🇦🇶 Antarctica']}],
  });

  const result = runTool('generate.mjs', [
    '--settings',
    settingsFile,
    '--output',
    path.join(dir, 'config.json'),
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /несуществующие серверы/);
  assert.match(result.stderr, /Доступные серверы/);
  assert.ok(!fs.existsSync(path.join(dir, 'config.json')));
});

// NEW: argument handling of the ported CLI.
describe('generate.mjs: argument handling (NEW)', () => {
  test('an unknown flag is an error', () => {
    const result = runTool('generate.mjs', ['--nope']);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /неизвестный флаг/);
  });

  test('--help prints the usage and exits with 0', () => {
    const result = runTool('generate.mjs', ['--help']);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Использование: node tools\/generate\.mjs/);
  });

  test('a version-1 file is refused by the CLI, never migrated', () => {
    const dir = makeTempDir();
    writeLinksFile(dir);
    const document = {
      version: 1,
      active: 'first',
      defaults: {links_file: 'links.txt'},
      profiles: {
        first: {listen_ip: '127.0.0.1', proxies: [{tag: 'main-socks', type: 'socks', port: 54321}]},
      },
    };
    const settingsFile = path.join(dir, 'webui.json');
    fs.writeFileSync(settingsFile, JSON.stringify(document, null, 2), 'utf8');
    const output = path.join(dir, 'config.json');

    const result = runTool('generate.mjs', ['--settings', settingsFile, '--output', output]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /старого формата/);
    assert.match(result.stderr, /редакторе GateHouse/);
    assert.ok(!fs.existsSync(output), 'nothing is generated from a legacy document');
  });

  test('--warnings-file collects the warnings for the caller', () => {
    const dir = makeTempDir();
    writeLinksFile(dir);
    const settingsFile = writeSettings(dir, {
      routes: {broken: {outbound: 'nope-tag', domains: ['example.com']}},
    });
    const warningsFile = path.join(dir, 'warnings.json');

    const result = runTool('generate.mjs', [
      '--settings',
      settingsFile,
      '--output',
      path.join(dir, 'config.json'),
      '--warnings-file',
      warningsFile,
    ]);

    assert.equal(result.status, 0, result.stderr);
    const warnings = JSON.parse(fs.readFileSync(warningsFile, 'utf8'));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /неизвестный outbound 'nope-tag'/);
  });

  test('--quiet keeps stdout empty', () => {
    const dir = makeTempDir();
    writeLinksFile(dir);
    const settingsFile = writeSettings(dir);

    const result = runTool('generate.mjs', [
      '--settings',
      settingsFile,
      '--output',
      path.join(dir, 'config.json'),
      '--quiet',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  });
});

// NEW: the dev launcher never reaches the router and refuses to start without
// the sandbox data, printing how to create it.
describe('dev.mjs: sandbox launcher (NEW)', () => {
  test('the stub binaries are committed and executable', () => {
    for (const name of ['systemctl', 'sudo']) {
      const file = path.join(REPO_ROOT, 'dev', 'bin', name);
      const mode = fs.statSync(file).mode;
      assert.ok((mode & 0o111) !== 0, `${name} must be executable`);
    }
  });

  test('the sudo stub forwards its argv to the systemctl stub', () => {
    const systemctl = path.join(REPO_ROOT, 'dev', 'bin', 'systemctl');
    const sudo = path.join(REPO_ROOT, 'dev', 'bin', 'sudo');

    const result = spawnSync(sudo, ['-n', systemctl, 'restart', 'gatehouse-test'], {
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split('\n');
    const sudoArgv = JSON.parse(lines[0].replace(/^fake-sudo /, ''));
    const systemctlArgv = JSON.parse(lines[1].replace(/^fake-systemctl /, ''));

    assert.deepEqual(sudoArgv, ['-n', systemctl, 'restart', 'gatehouse-test']);
    assert.deepEqual(systemctlArgv, ['restart', 'gatehouse-test']);
  });

  test('a restart over the stubs uses the dev paths, never the real systemctl', async () => {
    const {restartSingBox} = await import('../src/system/index.mjs');
    const systemctl = path.join(REPO_ROOT, 'dev', 'bin', 'systemctl');
    const sudo = path.join(REPO_ROOT, 'dev', 'bin', 'sudo');

    const result = await restartSingBox({
      env: {
        GATEHOUSE_SUDO: sudo,
        GATEHOUSE_SYSTEMCTL: systemctl,
        GATEHOUSE_UNIT: 'gatehouse-test',
      },
    });

    assert.equal(result.ok, true, result.stderr);
    // The command the editor built names the sandbox binaries by PATH — this is
    // what "the router is not touched" means, not the absence of an exception.
    assert.deepEqual(result.command, [sudo, '-n', systemctl, 'restart', 'gatehouse-test']);
    assert.match(result.stdout, /fake-systemctl \["restart","gatehouse-test"\]/);
  });

  test('the anonymised samples of dev/root.example are present', () => {
    for (const file of [
      path.join(REPO_ROOT, 'dev', 'root.example', 'webui.json'),
      path.join(REPO_ROOT, 'dev', 'root.example', 'etc', 'sing-box', 'config.json'),
      path.join(REPO_ROOT, 'dev', 'root.example', 'links.txt'),
    ]) {
      assert.ok(fs.existsSync(file), `${path.relative(REPO_ROOT, file)} is missing`);
    }
  });
});

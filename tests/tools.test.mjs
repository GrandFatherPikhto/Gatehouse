// CLI and tooling tests: tools/generate.mjs, tools/import-settings.mjs and the
// byte-level acceptance tool.
//
// The reference TUI (`pick_proxy`, `filter_and_select`, `ask_wqx`) is out of
// scope, but the non-interactive CLI scenario of the reference `main()` is kept,
// so its cases are ported here with a note.

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {convertSettings, importSettingsFile, run as runImport} from '../tools/import-settings.mjs';
import {DEFAULT_PYTHON_REPO} from '../tools/compare-with-python.mjs';
import {FI_TAG, FIXTURES_DIR, makeTempDir, NL_TAG, REPO_ROOT, writeLinksFile, writeSettings} from './helpers.mjs';

const FIXTURE_SETTINGS = path.join(FIXTURES_DIR, 'settings.json');
const FIXTURE_LINKS = path.join(FIXTURES_DIR, 'links.txt');
const EXPECTED_CONFIG = path.join(FIXTURES_DIR, 'expected-config.json');

const REFERENCE_REPO = process.env.SINGBOXTOOLS_REPO || DEFAULT_PYTHON_REPO;
const referenceAvailable = fs.existsSync(path.join(REFERENCE_REPO, 'generate_config.py'));

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
test('generate.mjs: builds the fixture config byte-identical to the reference', () => {
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
  assert.deepEqual(fs.readFileSync(output), fs.readFileSync(EXPECTED_CONFIG));
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

  test('--profile picks another profile', () => {
    const dir = makeTempDir();
    writeLinksFile(dir);
    const document = {
      version: 1,
      active: 'first',
      defaults: {links_file: 'links.txt'},
      profiles: {
        first: {listen_ip: '127.0.0.1', proxies: [{tag: 'main-socks', type: 'socks', port: 54321}]},
        second: {listen_ip: '10.0.0.2', proxies: [{tag: 'main-socks', type: 'socks', port: 54321}]},
      },
    };
    const settingsFile = path.join(dir, 'webui.json');
    fs.writeFileSync(settingsFile, JSON.stringify(document, null, 2), 'utf8');
    const output = path.join(dir, 'config.json');

    const result = runTool('generate.mjs', [
      '--settings',
      settingsFile,
      '--profile',
      'second',
      '--output',
      output,
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).inbounds[0].listen, '10.0.0.2');
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

// NEW: the one-off migration converter.
describe('import-settings.mjs: settings.yaml -> webui.json (NEW)', () => {
  test('convertSettings maps the known keys and warns about unknown ones', () => {
    const {document, warnings} = convertSettings(
      {
        listen_ip: '127.0.0.1',
        links_file: 'links.txt',
        exclude_from_auto: ['🇷🇺'],
        proxies: [{tag: 'main-socks', type: 'socks', port: 54321, sevrers: ['typo']}],
        something_new: 1,
      },
      {settingsDir: '/tmp'},
    );

    assert.equal(document.version, 1);
    assert.equal(document.active, 'default');
    assert.deepEqual(document.profiles.default.listen_ip, '127.0.0.1');
    assert.deepEqual(document.profiles.default.proxies, [{tag: 'main-socks', type: 'socks', port: 54321}]);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /неизвестные ключи settings.yaml: something_new/);
    assert.match(warnings[1], /proxies\[0\]: пропущены неизвестные ключи: sevrers/);
  });

  test('convertSettings refuses a non-mapping document', () => {
    assert.throws(() => convertSettings(['nope']), /ожидается mapping/);
  });

  test('--absolute-paths resolves links_file and output_file against the YAML', async () => {
    const dir = makeTempDir();
    writeLinksFile(dir);
    const yamlPath = path.join(dir, 'settings.yaml');
    fs.writeFileSync(
      yamlPath,
      'listen_ip: 127.0.0.1\nlinks_file: links.txt\noutput_file: config.json\nproxies:\n- tag: main\n  type: socks\n  port: 54321\n',
      'utf8',
    );
    const output = path.join(dir, 'webui.json');

    const {outputFile, warnings} = await importSettingsFile({
      settings: yamlPath,
      output,
      absolutePaths: true,
    });

    assert.equal(outputFile, output);
    assert.deepEqual(warnings, []);
    const document = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(document.profiles.default.links_file, path.join(dir, 'links.txt'));
    assert.equal(document.profiles.default.output_file, path.join(dir, 'config.json'));
    // webui.json is a hand-edited source file, so it keeps a trailing newline.
    assert.ok(fs.readFileSync(output, 'utf8').endsWith('\n'));
  });

  test('the CLI wrapper reports success and exits with 0', () => {
    const dir = makeTempDir();
    const output = path.join(dir, 'webui.json');

    const result = runTool('import-settings.mjs', [
      '--settings',
      path.join(FIXTURES_DIR, 'settings.yaml'),
      '--output',
      output,
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Готово! Настройки сконвертированы в:/);
    assert.deepEqual(fs.readFileSync(output), fs.readFileSync(FIXTURE_SETTINGS));
  });

  test('run() returns 1 instead of throwing on a bad invocation', async () => {
    assert.equal(await runImport([]), 1);
  });
});

// Reference: test_shims_generate_config / test_legacy_shim_is_non_interactive_by_default
// (the reference shims are replaced by the tool path used above).
describe('integration with the reference project', () => {
  test(
    'the committed expected-config.json really is what the reference produces',
    {skip: referenceAvailable ? false : `reference project not found at ${REFERENCE_REPO}`},
    () => {
      const dir = makeTempDir();
      const output = path.join(dir, 'config-python.json');
      const result = spawnSync(
        path.join(REFERENCE_REPO, '.venv/bin/python'),
        [
          path.join(REFERENCE_REPO, 'generate_config.py'),
          '--settings',
          path.join(FIXTURES_DIR, 'settings.yaml'),
          '--output',
          output,
        ],
        {cwd: REFERENCE_REPO, encoding: 'utf8'},
      );

      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(fs.readFileSync(output), fs.readFileSync(EXPECTED_CONFIG));
    },
  );

  test(
    'tools/compare-with-python.mjs reports identical bytes on the fixtures',
    {skip: referenceAvailable ? false : `reference project not found at ${REFERENCE_REPO}`},
    () => {
      const result = runTool('compare-with-python.mjs', []);

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /cmp молчит: файлы идентичны побайтово/);
    },
  );
});

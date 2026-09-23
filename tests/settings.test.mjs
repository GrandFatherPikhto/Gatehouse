// Settings layer tests: webui.json loading, ajv schema and the end-to-end
// generation.
//
// Cases ported from tests/test_sing_box_manager.py carry the name of the
// original Python test; cases marked NEW cover what only exists in the port
// (webui.json as a flat version-2 document, the ajv schema, note fields, the
// stale fixture, the refusal of the version-1 envelope).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {ConfigError, PROXY_TYPES} from '../src/core/errors.mjs';
import {
  SCHEMA,
  generateConfigFile,
  loadEffectiveSettings,
  loadSettings,
  resolvePath,
  stringifyConfig,
  validateSettings,
  writeJson,
} from '../src/core/settings.mjs';
import {
  ALL_TAGS,
  FI_TAG,
  FIXTURES_DIR,
  makeProject,
  makeTempDir,
  writeLinksFile,
  writeSettings,
} from './helpers.mjs';

const FIXTURE_SETTINGS = path.join(FIXTURES_DIR, 'settings.json');
const STALE_FIXTURE = path.join(FIXTURES_DIR, 'webui-stale.json');

// Reference: test_load_settings_missing_file
test('loadSettings: a missing file throws ConfigError', () => {
  assert.throws(
    () => loadSettings(path.join(makeTempDir(), 'nope.json')),
    (error) => error instanceof ConfigError && /не найден/.test(error.message),
  );
});

// Reference: test_generate_config_file_writes_valid_json
test('generateConfigFile: writes a valid config next to the settings file', () => {
  const {dir} = makeProject();
  const settingsFile = path.join(dir, 'webui.json');
  const {outputFile, stats} = generateConfigFile(settingsFile);

  assert.equal(outputFile, path.join(dir, 'config.json'));
  assert.ok(fs.existsSync(outputFile));

  const config = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
  assert.equal(config.dns.final, 'dns-local');
  assert.equal(config.inbounds[0].listen, '127.0.0.1');
  assert.deepEqual(config.route.rules[0], {protocol: 'dns', action: 'hijack-dns'});
  assert.equal(config.route.rules[1].action, 'sniff');
  assert.deepEqual(config.route.rules[2], {inbound: ['apps-http'], outbound: 'pool-apps-http'});
  assert.equal(stats.servers, 3);
});

// Reference: test_generate_config_file_relative_paths_resolved_from_settings_dir
test('generateConfigFile: relative paths resolve from the settings directory', () => {
  const {dir} = makeProject({output_file: 'nested/deep/config.json'});
  const settingsFile = path.join(dir, 'webui.json');

  const {outputFile} = generateConfigFile(settingsFile);

  assert.equal(outputFile, path.join(dir, 'nested', 'deep', 'config.json'));
  assert.ok(fs.existsSync(outputFile));
});

// Reference: test_generate_config_file_cli_overrides
test('generateConfigFile: CLI overrides win over the file', () => {
  const dir = makeTempDir();
  const otherLinks = path.join(dir, 'other-links.txt');
  fs.writeFileSync(
    otherLinks,
    'vless://uuid-7@solo.example.com:443?security=tls#%F0%9F%87%A9%F0%9F%87%AA%20Germany%20-%20Berlin\n',
    'utf8',
  );
  const settingsFile = writeSettings(dir, {
    proxies: [{tag: 'main-socks', type: 'socks', port: 54321}],
  });

  const {outputFile, stats} = generateConfigFile(settingsFile, {
    output: path.join(dir, 'elsewhere.json'),
    links: otherLinks,
    listenIp: '10.95.2.1',
    excludeFromAuto: [],
  });

  assert.equal(outputFile, path.join(dir, 'elsewhere.json'));
  assert.equal(stats.servers, 1);
  assert.equal(stats.auto_count, 1); // exclusion overridden by an empty list
  assert.deepEqual(stats.excluded, []);
  assert.equal(stats.listen_ip, '10.95.2.1');
});

// Reference: test_generate_config_file_bad_listen_ip
test('generateConfigFile: a bad listen_ip throws', () => {
  // Through the file the schema rejects a non-string first, mentioning the same key.
  const {settingsFile, dir} = makeProject({listen_ip: null});
  assert.throws(
    () => generateConfigFile(settingsFile),
    (error) => error instanceof ConfigError && /listen_ip/.test(error.message),
  );

  // Through the API the ported check of the reference fires.
  assert.throws(
    () => generateConfigFile(settingsFile, {listenIp: 123, output: path.join(dir, 'out.json')}),
    (error) => error instanceof ConfigError && /listen_ip/.test(error.message),
  );
});

// Reference: test_generate_config_file_missing_links
test('generateConfigFile: no readable source throws', () => {
  const {settingsFile} = makeProject({sources: ['nowhere']});

  assert.throws(
    () => generateConfigFile(settingsFile),
    (error) => error instanceof ConfigError && /источник/.test(error.message),
  );
});

// NEW: the collector replaces the stderr prints of the reference.
test('generateConfigFile: warnings are collected, not printed', () => {
  const {settingsFile} = makeProject({
    dns: undefined,
    routes: {broken: {outbound: 'nope-tag', domains: ['example.com']}},
  });

  const {warnings} = generateConfigFile(settingsFile);

  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((warning) => /нет секции dns/.test(warning)));
  assert.ok(warnings.some((warning) => /неизвестный outbound 'nope-tag'/.test(warning)));
});

// NEW: the version-1 envelope is refused by the core, not migrated. The editor is
// the only thing allowed to rewrite the file, so the CLI path can never generate
// from a half-migrated document.
describe('schema: the version-1 envelope is refused (NEW)', () => {
  test('a profiles/active document is refused with a message naming the editor', () => {
    assert.throws(
      () => validateSettings({version: 1, active: 'nope', profiles: {reality: {}}}, 'webui.json'),
      (error) =>
        error instanceof ConfigError &&
        /старого формата/.test(error.message) &&
        /редакторе GateHouse/.test(error.message),
    );
  });

  test('a bare defaults object is refused too', () => {
    assert.throws(
      () => validateSettings({version: 2, defaults: {listen_ip: '127.0.0.1'}}, 'webui.json'),
      (error) => error instanceof ConfigError && /старого формата/.test(error.message),
    );
  });

  test('loadSettings of a legacy file mentions the editor as well', () => {
    const dir = makeTempDir();
    const settingsFile = path.join(dir, 'webui.json');
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({version: 1, active: 'a', defaults: {}, profiles: {a: {}}}),
      'utf8',
    );

    assert.throws(
      () => loadSettings(settingsFile),
      (error) => error instanceof ConfigError && /редакторе GateHouse/.test(error.message),
    );
  });
});

// NEW: the version is pinned by the schema.
test('schema: ajv rejects an unknown version', () => {
  assert.throws(
    () => validateSettings({version: 3}, 'webui.json'),
    (error) => error instanceof ConfigError && /version/.test(error.message),
  );
});

// NEW: unknown keys are typos and must not slip through.
test('schema: ajv rejects unknown keys', () => {
  assert.throws(
    () => validateSettings({version: 2, proxies: [{tag: 'main', type: 'socks', port: 54321, proxys: []}]}, 'webui.json'),
    (error) => error instanceof ConfigError && /proxies\/0/.test(error.message),
  );
  assert.throws(
    () => validateSettings({version: 2, extra: 1}, 'webui.json'),
    (error) => error instanceof ConfigError && /не соответствуют схеме/.test(error.message),
  );
});

// NEW: required top-level keys are enforced.
test('schema: required top-level keys are enforced', () => {
  for (const bad of [{}, {listen_ip: '127.0.0.1'}, {version: 3}]) {
    assert.throws(
      () => validateSettings(bad, 'webui.json'),
      (error) => error instanceof ConfigError,
      `expected rejection for ${JSON.stringify(bad)}`,
    );
  }
});

// NEW: a proxy type outside PROXY_TYPES is rejected by the schema as well.
test('schema: proxy type enum matches the reference types', () => {
  const enumValues = SCHEMA.properties.proxies.items.properties.type.enum;

  assert.deepEqual(enumValues, [...PROXY_TYPES]);
  assert.throws(
    () => validateSettings({version: 2, proxies: [{tag: 'main', type: 'socks5', port: 54321}]}, 'webui.json'),
    (error) => error instanceof ConfigError && /proxies\/0\/type/.test(error.message),
  );
});

// NEW: an empty proxies list passes the schema and is caught by the core, which
// keeps the wording of the reference error.
test('schema: an empty proxies list is left to validateProxies', () => {
  const dir = makeTempDir();
  writeLinksFile(dir);
  const settingsFile = writeSettings(dir, {proxies: []});

  assert.throws(
    () => generateConfigFile(settingsFile, {output: path.join(dir, 'out.json')}),
    (error) => error instanceof ConfigError && /отсутствует секция proxies/.test(error.message),
  );
});

// NEW: JavaScript reorders integer-like object keys, so a route called "2024"
// would silently move to the front of the file on the next save: key order would
// be lost in the data structure itself, before any serialiser runs. The schema
// refuses names made of digits only, which keeps the round-trip promise and the
// byte match with the reference achievable.
describe('schema: digit-only route names are rejected (NEW)', () => {
  test('a route called 1 is rejected', () => {
    assert.throws(
      () => validateSettings({version: 2, routes: {'1': {outbound: 'auto-select'}}}, 'webui.json'),
      (error) => error instanceof ConfigError && /routes/.test(error.message),
    );
  });

  test('a route called 2024-telegram is accepted', () => {
    assert.doesNotThrow(() =>
      validateSettings({version: 2, routes: {'2024-telegram': {outbound: 'auto-select'}}}, 'webui.json'),
    );
  });
});

// NEW: note fields are comments for humans; they never reach config.json.
test('note fields are ignored', () => {
  const dir = makeTempDir();
  writeLinksFile(dir);
  const settingsFile = writeSettings(dir, {
    note: 'Reality transport',
    proxies: [{tag: 'main-socks', type: 'socks', port: 54321, note: 'primary proxy'}],
  });

  const {settings} = loadEffectiveSettings(settingsFile);
  const {config} = generateConfigFile(settingsFile, {
    output: path.join(dir, 'config.json'),
  });

  assert.ok(!('note' in settings));
  assert.ok(!('note' in settings.proxies[0]));
  assert.ok(!JSON.stringify(config).includes('note'));
  assert.ok(!JSON.stringify(config).includes('primary proxy'));
});

// NEW: invalid JSON must be reported as a configuration error.
test('loadSettings: invalid JSON throws ConfigError', () => {
  const dir = makeTempDir();
  const settingsFile = path.join(dir, 'webui.json');
  fs.writeFileSync(settingsFile, '{"version": 2,', 'utf8');

  assert.throws(
    () => loadSettings(settingsFile),
    (error) => error instanceof ConfigError && /ошибка чтения JSON/.test(error.message),
  );
});

// NEW: the committed fixture with a stale server reference must fail with the
// reference wording — this is the fixture that used to break the comparison.
test('stale fixture: an unknown server is a hard error listing the available ones', () => {
  const document = JSON.parse(fs.readFileSync(STALE_FIXTURE, 'utf8'));
  assert.equal(document.version, 2, 'the fixture is a flat version-2 document');
  assert.ok(
    JSON.stringify(document).includes('🇩🇪 Germany - Berlin'),
    'the fixture is expected to keep the stale tag',
  );

  const dir = makeTempDir();
  assert.throws(
    () => generateConfigFile(STALE_FIXTURE, {output: path.join(dir, 'config.json')}),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /несуществующие серверы/);
      assert.match(error.message, /🇩🇪 Germany - Berlin/);
      assert.match(error.message, /Доступные серверы/);
      return true;
    },
  );
  assert.ok(!fs.existsSync(path.join(dir, 'config.json')), 'nothing is written on failure');
});

// NEW: the committed fixture pair must stay mutually consistent.
test('fixtures: the committed settings.json is schema-valid and complete', () => {
  const document = loadSettings(FIXTURE_SETTINGS);
  const {settings, settingsDir} = loadEffectiveSettings(FIXTURE_SETTINGS);

  assert.equal(document.version, 2);
  assert.equal(settingsDir, FIXTURES_DIR);
  assert.deepEqual(settings.sources, [
    {kind: 'links', name: 'vpnd', path: 'sources/vpnd/links.txt'},
  ]);
  assert.equal(settings.proxies.length, 2);
  assert.deepEqual(settings.exclude_from_auto, ['🇷🇺']);
});

// Reference: resolve_path
describe('resolvePath (reference: resolve_path)', () => {
  test('absolute paths are returned untouched', () => {
    assert.equal(resolvePath('/base', '/etc/sing-box/config.json'), '/etc/sing-box/config.json');
  });

  test('relative paths are joined to the base directory', () => {
    assert.equal(resolvePath('/base', 'nested/config.json'), '/base/nested/config.json');
  });
});

// Reference: write_json
describe('writeJson (reference: write_json)', () => {
  test('creates missing directories', () => {
    const dir = makeTempDir();
    const target = path.join(dir, 'nested', 'deep', 'config.json');

    writeJson(target, {a: 1});

    assert.equal(fs.readFileSync(target, 'utf8'), '{\n  "a": 1\n}');
  });

  test('writes emoji as is and no trailing newline', () => {
    const dir = makeTempDir();
    const target = path.join(dir, 'config.json');

    writeJson(target, {tag: FI_TAG});

    const text = fs.readFileSync(target, 'utf8');
    assert.ok(text.includes(FI_TAG));
    assert.ok(!text.endsWith('\n'));
  });

  test('stringifyConfig matches the reference style', () => {
    assert.equal(stringifyConfig({}), '{}');
    assert.equal(stringifyConfig([]), '[]');
    assert.equal(stringifyConfig({a: [], b: {}}), '{\n  "a": [],\n  "b": {}\n}');
  });
});

// Reference: test_print_proxy_settings (the summary itself is printed by the CLI,
// so the data it needs is checked here).
test('stats: the proxy summary data matches the reference', () => {
  const {settingsFile} = makeProject();
  const {stats} = generateConfigFile(settingsFile);

  assert.deepEqual(
    stats.proxies.map((proxy) => [proxy.type.toUpperCase(), proxy.tag, proxy.port]),
    [
      ['SOCKS', 'main-socks', 54321],
      ['HTTP', 'apps-http', 54323],
    ],
  );
  assert.deepEqual(stats.proxies[1].servers, [FI_TAG, '🇳🇱 Netherlands - Amsterdam']);
  assert.deepEqual(stats.excluded, ['🇷🇺 Russia - Moscow']);
  assert.ok(ALL_TAGS.includes(stats.excluded[0]));
});

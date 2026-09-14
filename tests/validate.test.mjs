// Validation tests.
//
// Ported from tests/test_sing_box_manager.py of the reference project; the name
// of the original Python test stands above each case.

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {
  ConfigError,
  DEFAULT_EXCLUDE,
  PROXY_TYPES,
  pythonRepr,
  pythonTypeName,
  pyTruthy,
} from '../src/core/errors.mjs';
import {asList, requireMapping, urltestBlock, validateExclude, validateProxies} from '../src/core/validate.mjs';
import {ALL_TAGS, FI_TAG, NL_TAG} from './helpers.mjs';

/** Reference: the `_proxy(**overrides)` helper of the Python test file. */
function proxy(overrides = {}) {
  return {tag: 'main-socks', type: 'socks', port: 54321, ...overrides};
}

// Reference: test_validate_proxies_valid
test('validateProxies: valid section is normalised', () => {
  const result = validateProxies([
    proxy(),
    proxy({tag: 'apps-http', type: 'http', port: 54323, servers: [FI_TAG, NL_TAG]}),
  ]);

  assert.deepEqual(result, [
    {tag: 'main-socks', type: 'socks', port: 54321, servers: []},
    {tag: 'apps-http', type: 'http', port: 54323, servers: [FI_TAG, NL_TAG]},
  ]);
});

// Reference: test_validate_proxies_accepts_mixed_type
test('validateProxies: mixed is a legal type', () => {
  const result = validateProxies([proxy({type: 'mixed'})]);

  assert.deepEqual(result, [{tag: 'main-socks', type: 'mixed', port: 54321, servers: []}]);
});

// Reference: test_validate_proxies_servers_string_is_normalized_to_list
test('validateProxies: a single string in servers becomes a list', () => {
  const result = validateProxies([proxy({servers: FI_TAG})]);

  assert.deepEqual(result[0].servers, [FI_TAG]);
});

// Reference: test_validate_proxies_empty_section
test('validateProxies: empty section throws', () => {
  assert.throws(
    () => validateProxies(null),
    (error) => error instanceof ConfigError && /отсутствует секция proxies/.test(error.message),
  );
});

// Reference: test_validate_proxies_duplicate_tag
test('validateProxies: duplicate tag throws', () => {
  assert.throws(
    () => validateProxies([proxy(), proxy({port: 54399})]),
    (error) => error instanceof ConfigError && /дубль тега/.test(error.message),
  );
});

// Reference: test_validate_proxies_duplicate_port
test('validateProxies: duplicate port throws', () => {
  assert.throws(
    () => validateProxies([proxy(), proxy({tag: 'second'})]),
    (error) => error instanceof ConfigError && /дубль порта/.test(error.message),
  );
});

// Reference: test_validate_proxies_unknown_type
test('validateProxies: unknown type throws', () => {
  assert.throws(
    () => validateProxies([proxy({type: 'socks5'})]),
    (error) => error instanceof ConfigError && /неизвестный тип 'socks5'/.test(error.message),
  );
});

// Reference: test_validate_proxies_port_out_of_range
describe('validateProxies: port outside 1..65535 (test_validate_proxies_port_out_of_range)', () => {
  for (const port of [0, -1, 65536, 70000]) {
    test(`port ${port}`, () => {
      assert.throws(
        () => validateProxies([proxy({port})]),
        (error) => error instanceof ConfigError && /вне диапазона/.test(error.message),
      );
    });
  }
});

// Reference: test_validate_proxies_port_not_int
describe('validateProxies: port must be an int (test_validate_proxies_port_not_int)', () => {
  for (const port of ['54321', null, true, 54321.5]) {
    test(`port ${JSON.stringify(port)}`, () => {
      assert.throws(
        () => validateProxies([proxy({port})]),
        (error) => error instanceof ConfigError && /port должен быть целым числом/.test(error.message),
      );
    });
  }
});

// Reference: test_validate_proxies_bad_tag
describe('validateProxies: bad tag (test_validate_proxies_bad_tag)', () => {
  for (const tag of [null, '', 123, ['list']]) {
    test(`tag ${JSON.stringify(tag)}`, () => {
      assert.throws(
        () => validateProxies([proxy({tag})]),
        (error) => error instanceof ConfigError && /не указан тег/.test(error.message),
      );
    });
  }
});

// Reference: test_validate_proxies_bad_servers
describe('validateProxies: bad servers (test_validate_proxies_bad_servers)', () => {
  for (const servers of [[''], [FI_TAG, ''], [123], {a: 1}]) {
    test(`servers ${JSON.stringify(servers)}`, () => {
      assert.throws(
        () => validateProxies([proxy({servers})]),
        (error) => error instanceof ConfigError && /servers должен быть списком/.test(error.message),
      );
    });
  }
});

// Reference: test_validate_proxies_proxy_is_not_mapping
test('validateProxies: a proxy that is not a mapping throws', () => {
  assert.throws(
    () => validateProxies(['main-socks']),
    (error) => error instanceof ConfigError && /ожидается mapping/.test(error.message),
  );
});

// Reference: test_urltest_block_defaults
test('urltestBlock: defaults come from the reference', () => {
  assert.deepEqual(urltestBlock(null), {
    url: 'https://gstatic.com',
    interval: '3m',
    tolerance: 50,
  });
});

// Reference: test_urltest_block_type_errors
describe('urltestBlock: type errors (test_urltest_block_type_errors)', () => {
  const cases = [
    [{url: ''}, /urltest\.url/],
    [{interval: 5}, /urltest\.interval/],
    [{tolerance: '50'}, /urltest\.tolerance/],
    [{tolerance: true}, /urltest\.tolerance/],
  ];

  for (const [config, pattern] of cases) {
    test(JSON.stringify(config), () => {
      assert.throws(
        () => urltestBlock(config),
        (error) => error instanceof ConfigError && pattern.test(error.message),
      );
    });
  }
});

// Reference: test_validate_exclude
test('validateExclude: accepts 🇷🇺 and rejects empty prefixes', () => {
  assert.deepEqual(validateExclude(['🇷🇺']), ['🇷🇺']);
  assert.throws(
    () => validateExclude(['']),
    (error) => error instanceof ConfigError && /exclude_from_auto/.test(error.message),
  );
});

// Reference: covered by the as_list/require_mapping unit checks of the reference
describe('asList and requireMapping (ported helpers)', () => {
  test('asList normalises scalars and keeps lists', () => {
    assert.deepEqual(asList(null), []);
    assert.deepEqual(asList(undefined), []);
    assert.deepEqual(asList('youtube.com'), ['youtube.com']);
    assert.deepEqual(asList([FI_TAG, NL_TAG]), [FI_TAG, NL_TAG]);
  });

  test('requireMapping reports the Python type name', () => {
    requireMapping({}, 'log');
    const cases = [
      [['a'], 'list'],
      ['text', 'str'],
      [5, 'int'],
      [true, 'bool'],
      [null, 'NoneType'],
    ];
    for (const [value, expected] of cases) {
      assert.throws(
        () => requireMapping(value, 'log'),
        (error) => error.message.includes(`ожидается mapping, получено ${expected}`),
      );
    }
  });
});

// Reference: test_merged_module_keeps_constants
test('constants and ConfigError match the reference', () => {
  assert.deepEqual(PROXY_TYPES, ['socks', 'http', 'mixed']);
  assert.deepEqual(DEFAULT_EXCLUDE, ['🇷🇺']);
  assert.ok(new ConfigError('x') instanceof Error);
  assert.equal(new ConfigError('x').name, 'ConfigError');
});

// NEW: the Python-style helpers exist so the ported messages stay identical.
test('Python-style repr helpers keep the reference wording', () => {
  assert.equal(pythonTypeName(null), 'NoneType');
  assert.equal(pythonTypeName(1.5), 'float');
  assert.equal(pythonTypeName([]), 'list');
  assert.equal(pythonRepr('54321'), "'54321'");
  assert.equal(pythonRepr(null), 'None');
  assert.equal(pythonRepr(true), 'True');
  // Python truthiness: empty containers are falsy, unlike in JS.
  assert.equal(pyTruthy({}), false);
  assert.equal(pyTruthy([]), false);
  assert.equal(pyTruthy({a: 1}), true);
});

// Reference: test_merged_module_keeps_original_names
test('core exports keep the reference function names', async () => {
  const vless = await import('../src/core/vless.mjs');
  const validate = await import('../src/core/validate.mjs');
  const build = await import('../src/core/build.mjs');
  const settings = await import('../src/core/settings.mjs');

  const expected = {
    ...vless,
    ...validate,
    ...build,
    ...settings,
  };
  const names = [
    'getFirst',
    'parseVless',
    'dedupTags',
    'parseLinks',
    'asList',
    'requireMapping',
    'validateProxies',
    'urltestBlock',
    'validateExclude',
    'buildInbounds',
    'buildPools',
    'buildRules',
    'buildConfig',
    'resolvePath',
    'writeJson',
    'generateConfigFile',
  ];

  for (const name of names) {
    assert.equal(typeof expected[name], 'function', `missing export: ${name}`);
  }
  assert.ok(new ConfigError('x') instanceof Error);
});

// NEW: guards the ALL_TAGS helper of the suite itself.
test('helper: ALL_TAGS lists the three synthetic servers', () => {
  assert.equal(ALL_TAGS.length, 3);
});

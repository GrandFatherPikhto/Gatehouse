// Config assembly tests.
//
// Ported from tests/test_sing_box_manager.py of the reference project; the name
// of the original Python test stands above each case. Cases marked NEW cover
// what the reference suite did not need: byte-level equality with the committed
// golden file, and the key order that equality depends on.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {buildConfig, buildInbounds, buildPools, buildRules} from '../src/core/build.mjs';
import {ConfigError} from '../src/core/errors.mjs';
import {loadEffectiveSettings, stringifyConfig} from '../src/core/settings.mjs';
import {parseLinks} from '../src/core/vless.mjs';
import {ALL_TAGS, FI_TAG, FIXTURES_DIR, NL_TAG, RU_TAG} from './helpers.mjs';
import {validateProxies} from '../src/core/validate.mjs';

const FIXTURE_SETTINGS = path.join(FIXTURES_DIR, 'settings.json');
const FIXTURE_LINKS = path.join(FIXTURES_DIR, 'sources', 'vpnd', 'links.txt');
const GOLDEN_CONFIG = path.join(FIXTURES_DIR, 'golden', 'config.json');

/** Reference: the `_proxy(**overrides)` helper of the Python test file. */
function proxy(overrides = {}) {
  return {tag: 'main-socks', type: 'socks', port: 54321, ...overrides};
}

// Reference: test_build_inbounds
test('buildInbounds: one inbound per proxy, in order', () => {
  const proxies = validateProxies([proxy(), proxy({tag: 'apps-http', type: 'http', port: 54323})]);
  const [inbounds, tags] = buildInbounds(proxies, '10.95.2.1');

  assert.deepEqual(inbounds, [
    {type: 'socks', tag: 'main-socks', listen: '10.95.2.1', listen_port: 54321},
    {type: 'http', tag: 'apps-http', listen: '10.95.2.1', listen_port: 54323},
  ]);
  assert.deepEqual(tags, ['main-socks', 'apps-http']);
});

// Reference: test_build_inbounds_mixed
test('buildInbounds: mixed inbound keeps the same listen fields', () => {
  const proxies = validateProxies([proxy({type: 'mixed'})]);
  const [inbounds, tags] = buildInbounds(proxies, '10.95.2.1');

  assert.deepEqual(inbounds, [
    {type: 'mixed', tag: 'main-socks', listen: '10.95.2.1', listen_port: 54321},
  ]);
  assert.deepEqual(tags, ['main-socks']);
});

// Reference: test_build_pools_creates_urltest_pool
test('buildPools: creates a pool-<tag> urltest outbound', () => {
  const proxies = validateProxies([proxy({servers: [FI_TAG, NL_TAG]})]);
  const pools = buildPools(proxies, [...ALL_TAGS], null);

  assert.deepEqual(pools, [
    {
      type: 'urltest',
      tag: 'pool-main-socks',
      outbounds: [FI_TAG, NL_TAG],
      url: 'https://gstatic.com',
      interval: '3m',
      tolerance: 50,
    },
  ]);
});

// Reference: test_build_pools_skips_proxies_without_servers
test('buildPools: proxies without servers get no pool', () => {
  const proxies = validateProxies([proxy()]);

  assert.deepEqual(buildPools(proxies, [...ALL_TAGS], null), []);
});

// Reference: test_build_pools_unknown_server_error_lists_available
test('buildPools: an unknown server lists the available ones', () => {
  const proxies = validateProxies([proxy({servers: [FI_TAG, '🇦🇶 Antarctica']})]);

  assert.throws(
    () => buildPools(proxies, [...ALL_TAGS], null),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /🇦🇶 Antarctica/);
      assert.match(error.message, /Доступные серверы/);
      assert.match(error.message, new RegExp(FI_TAG));
      return true;
    },
  );
});

// Reference: test_build_rules_order_and_pool_pinning
test('buildRules: order and pool pinning', () => {
  const proxies = validateProxies([
    proxy(),
    proxy({tag: 'apps-http', type: 'http', port: 54323, servers: [FI_TAG]}),
  ]);
  const known = new Set([...ALL_TAGS, 'auto-select', 'direct', 'pool-apps-http']);

  const rules = buildRules(proxies, null, known);

  assert.deepEqual(rules[0], {protocol: 'dns', action: 'hijack-dns'});
  assert.deepEqual(rules[1], {inbound: ['main-socks', 'apps-http'], action: 'sniff'});
  assert.deepEqual(rules[2], {inbound: ['apps-http'], outbound: 'pool-apps-http'});
  assert.equal(rules.length, 3); // main-socks has no servers of its own
});

// Reference: test_build_rules_domain_rules_appended
test('buildRules: domain rules are appended on top', () => {
  const proxies = validateProxies([proxy()]);
  const routes = {
    telegram: {outbound: FI_TAG, domains: ['t.me']},
    youtube: {domains: 'youtube.com'}, // outbound defaults to auto-select
  };
  const known = new Set([...ALL_TAGS, 'auto-select', 'direct']);

  const rules = buildRules(proxies, routes, known);

  assert.deepEqual(rules.at(-2), {domain_suffix: ['t.me'], outbound: FI_TAG});
  assert.deepEqual(rules.at(-1), {domain_suffix: ['youtube.com'], outbound: 'auto-select'});
});

// Reference: test_build_rules_unknown_outbound_warns
test('buildRules: an unknown outbound is a warning, not an error', () => {
  const proxies = validateProxies([proxy()]);
  const routes = {broken: {outbound: 'nope-tag', domains: ['example.com']}};
  const warnings = [];

  buildRules(proxies, routes, new Set([...ALL_TAGS, 'auto-select', 'direct']), warnings);

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /неизвестный outbound 'nope-tag'/);
});

// Reference: test_build_config_structure_and_stats
describe('buildConfig: structure and stats (test_build_config_structure_and_stats)', () => {
  const settings = loadEffectiveSettings(FIXTURE_SETTINGS).settings;
  const outbounds = parseLinks(FIXTURE_LINKS);
  const [config, stats] = buildConfig(settings, outbounds, '127.0.0.1');

  test('log and dns sections are taken over as is', () => {
    assert.deepEqual(config.log, {level: 'info', timestamp: true});
    assert.equal(config.route.final, 'auto-select');
    assert.equal(config.route.default_domain_resolver, 'dns-local');
  });

  test('outbound order is auto-select, direct, pools, servers', () => {
    assert.deepEqual(
      config.outbounds.map((outbound) => outbound.tag),
      ['auto-select', 'direct', 'pool-apps-http', FI_TAG, NL_TAG, RU_TAG],
    );
    assert.deepEqual(config.outbounds[0].outbounds, [FI_TAG, NL_TAG]); // 🇷🇺 out of auto-select
    assert.equal(config.outbounds[0].url, 'https://gstatic.com');
    assert.deepEqual(
      config.inbounds.map((inbound) => inbound.tag),
      ['main-socks', 'apps-http'],
    );
  });

  test('stats describe what was built', () => {
    assert.equal(stats.servers, 3);
    assert.equal(stats.inbounds, 2);
    assert.equal(stats.pools, 1);
    assert.equal(stats.auto_count, 2);
    assert.deepEqual(stats.excluded, [RU_TAG]);
    assert.equal(stats.listen_ip, '127.0.0.1');
  });
});

// NEW: key order is the contract behind the byte-level comparison.
describe('buildConfig: key order matches the reference (NEW)', () => {
  const settings = loadEffectiveSettings(FIXTURE_SETTINGS).settings;
  const [config] = buildConfig(settings, parseLinks(FIXTURE_LINKS), '127.0.0.1');

  test('config keys', () => {
    assert.deepEqual(Object.keys(config), ['log', 'dns', 'inbounds', 'outbounds', 'route']);
  });

  test('route keys', () => {
    assert.deepEqual(Object.keys(config.route), ['rules', 'final', 'default_domain_resolver']);
  });

  test('auto-select keeps url/interval/tolerance after outbounds', () => {
    assert.deepEqual(Object.keys(config.outbounds[0]), [
      'type',
      'tag',
      'outbounds',
      'url',
      'interval',
      'tolerance',
    ]);
  });

  test('pool keeps the same key order as auto-select', () => {
    const pool = config.outbounds.find((outbound) => outbound.tag === 'pool-apps-http');
    assert.deepEqual(Object.keys(pool), [
      'type',
      'tag',
      'outbounds',
      'url',
      'interval',
      'tolerance',
    ]);
  });

  test('inbound key order', () => {
    assert.deepEqual(Object.keys(config.inbounds[0]), ['type', 'tag', 'listen', 'listen_port']);
  });

  test('rule key order', () => {
    assert.deepEqual(Object.keys(config.route.rules[0]), ['protocol', 'action']);
    assert.deepEqual(Object.keys(config.route.rules[2]), ['inbound', 'outbound']);
    assert.deepEqual(Object.keys(config.route.rules[3]), ['domain_suffix', 'outbound']);
  });

  test('vless outbound key order (reality adds flow and tls last)', () => {
    const reality = config.outbounds.find((outbound) => outbound.tag === FI_TAG);
    assert.deepEqual(Object.keys(reality), [
      'type',
      'tag',
      'server',
      'server_port',
      'uuid',
      'flow',
      'tls',
    ]);

    // A plain tcp link (no security) keeps neither flow nor tls, like the reference.
    const plain = config.outbounds.find((outbound) => outbound.tag === RU_TAG);
    assert.deepEqual(Object.keys(plain), ['type', 'tag', 'server', 'server_port', 'uuid']);
  });
});

// NEW: the automated half of the acceptance criterion — the generation from the
// fixture model must come out byte for byte identical to the committed golden
// file. An intentional change to the output updates the fixture in the same
// commit, so the difference is visible in review.
describe('buildConfig: byte-identical to the golden file (NEW)', () => {
  test('stringifyConfig reproduces tests/fixtures/golden/config.json', () => {
    const settings = loadEffectiveSettings(FIXTURE_SETTINGS).settings;
    const [config] = buildConfig(settings, parseLinks(FIXTURE_LINKS), '127.0.0.1');
    const golden = fs.readFileSync(GOLDEN_CONFIG, 'utf8');

    assert.equal(stringifyConfig(config), golden);
    assert.equal(Buffer.byteLength(golden, 'utf8'), 2704, 'the format invariant: 2704 bytes');
  });

  test('the golden file has no trailing newline, and neither do we', () => {
    const golden = fs.readFileSync(GOLDEN_CONFIG, 'utf8');

    assert.ok(!golden.endsWith('\n'));
    assert.ok(!stringifyConfig({}).endsWith('\n'));
  });
});

// NEW: warnings of buildConfig itself.
test('buildConfig: a missing dns section warns but does not fail', () => {
  const warnings = [];
  const settings = {
    proxies: [{tag: 'main-socks', type: 'socks', port: 54321}],
  };

  const [config] = buildConfig(settings, parseLinks(FIXTURE_LINKS), '127.0.0.1', warnings);

  assert.deepEqual(config.dns, {});
  assert.deepEqual(config.log, {});
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /нет секции dns/);
});

// NEW: an empty dns section is falsy in Python and must warn as well.
test('buildConfig: an empty dns object is treated like a missing one', () => {
  const warnings = [];
  const settings = {
    dns: {},
    proxies: [{tag: 'main-socks', type: 'socks', port: 54321}],
  };

  buildConfig(settings, parseLinks(FIXTURE_LINKS), '127.0.0.1', warnings);

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /нет секции dns/);
});

// NEW: exclude_from_auto matches by prefix, exactly like the reference.
test('buildConfig: exclude_from_auto matches by prefix', () => {
  const settings = {
    exclude_from_auto: ['🇫🇮'],
    proxies: [{tag: 'main-socks', type: 'socks', port: 54321}],
  };

  const [config, stats] = buildConfig(settings, parseLinks(FIXTURE_LINKS), '127.0.0.1');

  assert.deepEqual(config.outbounds[0].outbounds, [NL_TAG, RU_TAG]);
  assert.deepEqual(stats.excluded, [FI_TAG]);
});

// NEW: without exclude_from_auto the reference default 🇷🇺 applies.
test('buildConfig: the default exclusion is 🇷🇺', () => {
  const settings = {
    proxies: [{tag: 'main-socks', type: 'socks', port: 54321}],
  };

  const [config, stats] = buildConfig(settings, parseLinks(FIXTURE_LINKS), '127.0.0.1');

  assert.deepEqual(config.outbounds[0].outbounds, [FI_TAG, NL_TAG]);
  assert.deepEqual(stats.excluded, [RU_TAG]);
});

// NEW: an explicit empty list means "exclude nothing".
test('buildConfig: an empty exclusion list keeps every server in auto-select', () => {
  const settings = {
    exclude_from_auto: [],
    proxies: [{tag: 'main-socks', type: 'socks', port: 54321}],
  };

  const [config, stats] = buildConfig(settings, parseLinks(FIXTURE_LINKS), '127.0.0.1');

  assert.deepEqual(config.outbounds[0].outbounds, [FI_TAG, NL_TAG, RU_TAG]);
  assert.deepEqual(stats.excluded, []);
});

// NEW: warnings even when every server was excluded.
test('buildConfig: everything excluded leaves auto-select empty without failing', () => {
  const settings = {
    exclude_from_auto: [FI_TAG, NL_TAG, RU_TAG],
    proxies: [{tag: 'main-socks', type: 'socks', port: 54321}],
  };

  const [config, stats] = buildConfig(settings, parseLinks(FIXTURE_LINKS), '127.0.0.1');

  assert.deepEqual(config.outbounds[0].outbounds, []);
  assert.equal(stats.auto_count, 0);
});

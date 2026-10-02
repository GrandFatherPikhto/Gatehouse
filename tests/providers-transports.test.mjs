// Provider suffix, name collisions, per-subscription overrides and the panel.
//
// Acceptance of the task `plan_2026_10_01_gatehouse_vless_transports.md` §5.7–§5.12
// and §5а: the suffix is applied after the in-file dedup, two enabled providers
// handing out one name stop generation, `setProviderSuffix` renames the servers in
// proxies (pinned included) and routes, the schema screens the new fields, and the
// panel shows the protocol summary and the skipped links.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import Ajv from 'ajv';

import {ConfigError} from '../src/core/errors.mjs';
import {SCHEMA, generateConfigFile} from '../src/core/settings.mjs';
import {cleanSuffix, readProviders} from '../src/core/sources.mjs';
import {UTLS_FINGERPRINTS, parseVless} from '../src/core/vless.mjs';
import {ProjectModel} from '../src/model/project.mjs';
import {startServer} from '../src/web/server.mjs';
import {DEFAULT_SETTINGS_BODY, makeTempDir, vlessLink, writeSettings} from './helpers.mjs';

const TAG = '🇦🇱 Albania - Tirana 1';
const TAG_B = '🇳🇱 Netherlands - Amsterdam';
const TLS = 'security=tls&sni=x.example.com';

// A proxy with no servers of its own: generation only needs the servers to exist
// for a proxy that PINS a pool. The fixtures below only check the outbounds.
const SERVERLESS_PROXIES = [{tag: 'main-socks', type: 'socks', port: 54321}];

/** Writes `<root>/<id>/links.txt`. */
function writeProvider(root, id, content) {
  fs.mkdirSync(path.join(root, id), {recursive: true});
  fs.writeFileSync(path.join(root, id, 'links.txt'), content, 'utf8');
}

/** One VLESS link line with a fake UUID. */
function link(host, tag = TAG, query = TLS, uuid = 'aaaaaaaa-0000-0000-0000-000000000001') {
  return `${vlessLink(uuid, host, tag, query)}\n`;
}

/** Two providers handing out the SAME server name (the §2.2 case). */
function sameNameProject() {
  const dir = makeTempDir();
  const root = path.join(dir, 'providers');
  writeProvider(root, 'vpnd', link('vpnd.example.com', TAG, TLS, 'aaaaaaaa-0000-0000-0000-000000000001'));
  writeProvider(root, 'vpnd-ws', link('ws.example.com', TAG, TLS, 'aaaaaaaa-0000-0000-0000-000000000002'));
  return {dir, root};
}

/** Opens a model over a fresh document in `dir`. */
function openModel(dir, providers, extra = {}) {
  const file = path.join(dir, 'webui.json');
  const document = {version: 2, ...DEFAULT_SETTINGS_BODY, providers, ...extra};
  fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  return new ProjectModel({path: file, stateDir: path.join(dir, 'state')});
}

describe('suffix (task §2.1 / §5.7)', () => {
  test('is appended after the in-file dedup', () => {
    const dir = makeTempDir();
    const root = path.join(dir, 'providers');
    writeProvider(
      root,
      'vpnd',
      link('a.example.com', TAG, TLS, '11111111-1111-1111-1111-111111111111') +
        link('b.example.com', TAG, TLS, '22222222-2222-2222-2222-222222222222'),
    );
    const read = readProviders({vpnd: {enabled: true, kind: 'subscription', suffix: 'WS'}}, root);
    const provider = read.providers.find((item) => item.id === 'vpnd');
    assert.deepEqual(provider.tags, [`${TAG} WS`, `${TAG} #2 WS`]);
    assert.deepEqual(provider.baseTags, [TAG, `${TAG} #2`]);
  });

  test('without a suffix the names are exactly as in the links', () => {
    const {root} = sameNameProject();
    const read = readProviders({vpnd: {enabled: true, kind: 'subscription'}}, root);
    assert.deepEqual(read.providers.find((item) => item.id === 'vpnd').tags, [TAG]);
  });
});

describe('name collisions (task §2.2 / §5.8)', () => {
  test('generation refuses with the §2.2 text', () => {
    const {dir, root} = sameNameProject();
    const settingsFile = writeSettings(dir, {
      providers: {vpnd: {enabled: true, kind: 'subscription'}, 'vpnd-ws': {enabled: true, kind: 'subscription'}},
    });
    assert.throws(
      () => generateConfigFile(settingsFile, {providersRoot: root}),
      (error) =>
        error instanceof ConfigError &&
        /провайдеры vpnd и vpnd-ws дают 1 одинаковых имён серверов/.test(error.message) &&
        error.message.includes(TAG) &&
        /задайте приписку/.test(error.message),
    );
  });

  test('setProviderEnabled refuses and leaves the document byte for byte', () => {
    const {dir} = sameNameProject();
    const model = openModel(dir, {vpnd: {enabled: true, kind: 'subscription'}});
    const before = model.toText();
    assert.throws(() => model.setProviderEnabled('vpnd-ws', true), ConfigError);
    assert.equal(model.toText(), before);
  });

  test('a suffix on one provider lets generation pass with distinct names', () => {
    const {dir, root} = sameNameProject();
    const settingsFile = writeSettings(dir, {
      providers: {vpnd: {enabled: true, kind: 'subscription'}, 'vpnd-ws': {enabled: true, kind: 'subscription', suffix: 'WS'}},
      proxies: SERVERLESS_PROXIES,
    });
    const {config} = generateConfigFile(settingsFile, {providersRoot: root});
    const tags = config.outbounds.filter((outbound) => outbound.type === 'vless').map((outbound) => outbound.tag);
    assert.deepEqual(tags, [TAG, `${TAG} WS`]);
  });
});

describe('setProviderSuffix renames servers (task §2.3 / §5.9)', () => {
  function renameProject() {
    const dir = makeTempDir();
    const root = path.join(dir, 'providers');
    writeProvider(root, 'vpnd', link('vpnd.example.com', TAG, TLS, 'aaaaaaaa-0000-0000-0000-000000000001'));
    writeProvider(root, 'other', link('other.example.com', TAG_B, TLS, 'aaaaaaaa-0000-0000-0000-000000000002'));
    return openModel(dir, {vpnd: {enabled: true, kind: 'subscription'}, other: {enabled: true, kind: 'subscription'}}, {
      proxies: [
        {tag: 'plain', type: 'socks', port: 54321, servers: [TAG]},
        {tag: 'fixed', type: 'socks', port: 54322, servers: [TAG], pinned: true},
        {tag: 'otherproxy', type: 'socks', port: 54323, servers: [TAG_B]},
      ],
      routes: {telegram: {outbound: TAG, domains: ['t.me']}},
      exclude_from_auto: ['🇦🇱'],
    });
  }

  test('rewrites normal and pinned proxies and routes, leaves the rest alone', () => {
    const model = renameProject();
    const affected = model.setProviderSuffix('vpnd', 'WS');
    assert.deepEqual(affected.proxies.sort(), ['fixed', 'plain']);
    assert.deepEqual(affected.routes, ['telegram']);
    assert.deepEqual(model.getProxy('plain').servers, [`${TAG} WS`]);
    assert.deepEqual(model.getProxy('fixed').servers, [`${TAG} WS`]);
    assert.equal(model.getProxy('fixed').pinned, true);
    assert.deepEqual(model.getProxy('otherproxy').servers, [TAG_B]);
    assert.equal(model.getRoute('telegram').outbound, `${TAG} WS`);
    assert.deepEqual(model.document.exclude_from_auto, ['🇦🇱']);
  });

  test('a suffix that would collide is refused without touching the document', () => {
    const {dir} = sameNameProject();
    const model = openModel(dir, {vpnd: {enabled: true, kind: 'subscription'}, 'vpnd-ws': {enabled: true, kind: 'subscription', suffix: 'WS'}});
    const before = model.toText();
    assert.throws(() => model.setProviderSuffix('vpnd-ws', ''), ConfigError);
    assert.equal(model.toText(), before);
  });

  test('an invalid suffix is refused by the model', () => {
    const dir = makeTempDir();
    writeProvider(path.join(dir, 'providers'), 'vpnd', link('a.example.com'));
    const model = openModel(dir, {vpnd: {enabled: true, kind: 'subscription'}});
    for (const bad of [' WS', 'WS ', 'x'.repeat(17), 'bad\u0000char']) {
      const before = model.toText();
      assert.throws(() => model.setProviderSuffix('vpnd', bad), ConfigError, JSON.stringify(bad));
      assert.equal(model.toText(), before);
    }
  });
});

describe('overrides (task §2.5 / §5.12)', () => {
  function rawProject() {
    const dir = makeTempDir();
    const root = path.join(dir, 'providers');
    writeProvider(
      root,
      'vpnd',
      link('vpnd.example.com', TAG, 'type=raw&security=tls&sni=x.example.com', 'aaaaaaaa-0000-0000-0000-000000000001'),
    );
    return {dir, root};
  }

  test('flow vision adds the flow a TLS+raw link does not carry', () => {
    const {dir, root} = rawProject();
    const settingsFile = writeSettings(dir, {
      providers: {vpnd: {enabled: true, kind: 'subscription', overrides: {flow: 'vision'}}},
      proxies: SERVERLESS_PROXIES,
    });
    const {config} = generateConfigFile(settingsFile, {providersRoot: root});
    const vless = config.outbounds.find((outbound) => outbound.type === 'vless');
    assert.equal(vless.flow, 'xtls-rprx-vision');
  });

  test('fp safari rewrites the fingerprint of every tls link', () => {
    const {dir, root} = rawProject();
    const settingsFile = writeSettings(dir, {
      providers: {vpnd: {enabled: true, kind: 'subscription', overrides: {fp: 'safari'}}},
      proxies: SERVERLESS_PROXIES,
    });
    const {config} = generateConfigFile(settingsFile, {providersRoot: root});
    const vless = config.outbounds.find((outbound) => outbound.type === 'vless');
    assert.equal(vless.tls.utls.fingerprint, 'safari');
  });

  test('without overrides the reader output equals the bare parser output', () => {
    const {root} = rawProject();
    const read = readProviders({vpnd: {enabled: true, kind: 'subscription'}}, root);
    const outbound = read.providers.find((item) => item.id === 'vpnd').outbounds[0];
    assert.deepEqual(outbound, parseVless(link('vpnd.example.com', TAG, 'type=raw&security=tls&sni=x.example.com').trim()));
  });

  test('setProviderOverrides stores, clears one key and drops an empty object', () => {
    const {dir} = rawProject();
    const model = openModel(dir, {vpnd: {enabled: true, kind: 'subscription'}});

    model.setProviderOverrides('vpnd', {flow: 'vision', fp: 'safari'});
    assert.deepEqual(model.getProvider('vpnd').overrides, {flow: 'vision', fp: 'safari'});

    model.setProviderOverrides('vpnd', {flow: 'auto'});
    assert.deepEqual(model.getProvider('vpnd').overrides, {fp: 'safari'});

    model.setProviderOverrides('vpnd', {fp: 'auto'});
    assert.ok(!Object.hasOwn(model.getProvider('vpnd'), 'overrides'));

    assert.throws(() => model.setProviderOverrides('vpnd', {flow: 'sometimes'}), ConfigError);
    assert.throws(() => model.setProviderOverrides('vpnd', {fp: 'opera'}), ConfigError);
  });
});

describe('schema (task §5.10 / §5.12)', () => {
  const ajv = new Ajv({allErrors: true});
  const validate = ajv.compile(SCHEMA);
  const valid = (provider) => validate({version: 2, providers: {vpnd: provider}});

  test('a valid suffix and overrides pass', () => {
    assert.equal(valid({enabled: true, suffix: 'WS', overrides: {flow: 'vision', fp: 'safari'}}), true);
  });

  test('a suffix with a leading/trailing space, 17 chars or a control char is refused', () => {
    for (const bad of [' WS', 'WS ', 'x'.repeat(17), 'bad\nchar']) {
      assert.equal(valid({suffix: bad}), false, `${JSON.stringify(bad)} must be refused`);
    }
  });

  test('an unknown override key or value is refused', () => {
    assert.equal(valid({overrides: {flow: 'sometimes'}}), false);
    assert.equal(valid({overrides: {fp: 'opera'}}), false);
    assert.equal(valid({overrides: {sni: 'x.example.com'}}), false);
  });

  test('the fp enum never drifts from UTLS_FINGERPRINTS', () => {
    const schemaEnum =
      SCHEMA.properties.providers.additionalProperties.properties.overrides.properties.fp.enum;
    assert.deepEqual([...schemaEnum].sort(), [...UTLS_FINGERPRINTS].sort());
  });

  test('cleanSuffix mirrors the schema rule', () => {
    assert.equal(cleanSuffix({suffix: 'WS'}), 'WS');
    assert.equal(cleanSuffix({suffix: ' WS'}), '');
    assert.equal(cleanSuffix({suffix: 'x'.repeat(17)}), '');
    assert.equal(cleanSuffix({suffix: 'a\u0000b'}), '');
    assert.equal(cleanSuffix({}), '');
  });
});

describe('warnings of a disabled provider (task §5а)', () => {
  function mixedProject() {
    const dir = makeTempDir();
    const root = path.join(dir, 'providers');
    writeProvider(root, 'vpnd', link('vpnd.example.com'));
    // A provider that PARSES (one good link) but also skips one: only then does it
    // stay a provider instead of an «empty» unread entry. `kcp` is the transport
    // NO engine of the project speaks (task 22 §1.2 keeps it a skip).
    writeProvider(
      root,
      'broken',
      link('ok.example.com', '🇧🇪 Belgium - Brussels', TLS, 'aaaaaaaa-0000-0000-0000-00000000000e') +
        'vless://aaaaaaaa-0000-0000-0000-00000000000f@x.example.com:443?type=kcp&security=tls&sni=x.example.com#Bad\n',
    );
    return {root};
  }

  test('the panel sees them, generation does not', () => {
    const {root} = mixedProject();
    const read = readProviders({vpnd: {enabled: true, kind: 'subscription'}}, root);
    const broken = read.providers.find((item) => item.id === 'broken');
    assert.equal(broken.skipped.length, 1);
    assert.equal(broken.warnings.length, 1);
    assert.deepEqual(read.warnings, []);
  });

  test('an enabled broken provider does contribute its warnings', () => {
    const {root} = mixedProject();
    const read = readProviders({vpnd: {enabled: true, kind: 'subscription'}, broken: {enabled: true, kind: 'subscription'}}, root);
    assert.equal(read.warnings.length, 1);
    assert.match(read.warnings[0], /неизвестный транспорт 'kcp'/);
  });
});

describe('provider panels render the new blocks (task §5.11)', () => {
  test('the provider panel shows the suffix field, protocol summary and skipped list', async () => {
    const dir = makeTempDir();
    const root = path.join(dir, 'providers');
    const ws = vlessLink(
      'aaaaaaaa-0000-0000-0000-000000000001',
      'ws.example.com',
      'Good WS',
      'type=ws&path=/x&host=ws.example.com&security=tls&sni=ws.example.com',
    );
    // `kcp` stays a skip: neither sing-box nor Xray carries it (task 22 §1.2).
    const bad =
      'vless://aaaaaaaa-0000-0000-0000-000000000002@x.example.com:443?type=kcp&security=tls&sni=x.example.com#Skipped';
    writeProvider(root, 'vpnd', `# comment\n${ws}\n${bad}\n`);
    const settingsFile = writeSettings(dir, {providers: {vpnd: {enabled: true, kind: 'subscription'}}});

    const {server, url} = await startServer({
      env: {
        GATEHOUSE_SETTINGS: settingsFile,
        GATEHOUSE_HOST: '127.0.0.1',
        GATEHOUSE_PORT: '0',
        GATEHOUSE_STATE_DIR: path.join(dir, 'state'),
      },
    });
    const base = url.replace(/\/$/, '');
    try {
      const provider = await (await fetch(`${base}/panel/provider:vpnd`)).text();
      assert.match(provider, /приписка к именам серверов/);
      assert.match(provider, /Протокол:/);
      assert.match(provider, /TLS · WS: 1/);
      assert.match(provider, /Пропущено ссылок: 1/);
      assert.match(provider, /Skipped/);
      assert.doesNotMatch(provider, /aaaaaaaa-0000-0000-0000-000000000002/);

      const list = await (await fetch(`${base}/panel/outputs:subscriptions`)).text();
      assert.match(list, /пропущено: 1/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

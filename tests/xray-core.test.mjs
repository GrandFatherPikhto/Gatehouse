// Xray as a second engine: reading `xray-configs.json` and building the two
// configs (task plan_2026_10_02_gatehouse_xray_core.md §1, §3, §8.1(1,2,4)).
//
// The fixtures mirror the shape of the real StashVPN output (Remnawave/Happ):
// XHTTP with `extra`, Reality, Hysteria2 with `finalmask`, balancers, routing —
// but with fake keys and `example.net` hosts; no real secret is in the repo.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {
  DEFAULT_XRAY_PORT_RANGE,
  buildXrayConfig,
  readXrayConfigs,
  resolveXrayPorts,
  xrayEntries,
  xrayProtocolLabel,
  xraySocksOutbound,
} from '../src/core/xray.mjs';
import {generateConfigFile, previewPair, writeXrayConfig} from '../src/core/settings.mjs';
import {readProviders} from '../src/core/sources.mjs';
import {FIXTURES_DIR, makeTempDir} from './helpers.mjs';

const STASH = path.join(FIXTURES_DIR, 'providers-xray', 'stash', 'xray-configs.json');
const ODD = path.join(FIXTURES_DIR, 'providers-xray', 'xray-odd', 'xray-configs.json');
const BROKEN = path.join(FIXTURES_DIR, 'providers-xray', 'xray-broken', 'xray-configs.json');

/** Builds a temp project with one xray provider folder and a document. */
function project(providerFiles, document = {}) {
  const dir = makeTempDir();
  const root = path.join(dir, 'providers');
  for (const [id, files] of Object.entries(providerFiles)) {
    fs.mkdirSync(path.join(root, id), {recursive: true});
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(root, id, name), content, 'utf8');
    }
  }
  const file = path.join(dir, 'webui.json');
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        version: 2,
        listen_ip: '127.0.0.1',
        providers: {stash: {enabled: true, kind: 'xray'}},
        output_file: 'config.json',
        exclude_from_auto: [],
        urltest: {url: 'https://gstatic.com', interval: '3m', tolerance: 50},
        log: {level: 'info', timestamp: true},
        dns: {servers: [], final: 'dns-local'},
        proxies: [{tag: 'p', type: 'socks', port: 54321}],
        routes: {},
        ...document,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return {dir, root, file};
}

describe('reading xray-configs.json (§1)', () => {
  test('the StashVPN shape: configs, outbounds, distinct servers', () => {
    const read = readXrayConfigs(STASH);
    assert.equal(read.state, 'ok');
    assert.deepEqual(read.meta, {configs: 3, outbounds: 9, servers: 8});

    const names = read.servers.map((server) => server.name);
    assert.deepEqual(names, [
      'de-main (de2)',
      'de-main-2 (de2)',
      'de-main-3 (de2)',
      'de-cdn (de2)',
      'proxy (de2)',
      'ru-main (ru2)',
      'ru-cdn (ru2)',
      'proxy (ru2)',
    ]);
  });

  test('the same outbound in two configs collapses into ONE server (§1.2)', () => {
    const read = readXrayConfigs(STASH);
    assert.equal(read.servers.filter((server) => server.baseName === 'de-main (de2)').length, 1);
  });

  test('service protocols are skipped silently, unsupported ones are reported', () => {
    const skipped = [];
    const read = readXrayConfigs(STASH, [], skipped);
    assert.equal(read.servers.some((server) => server.tag === 'direct'), false);
    assert.equal(read.servers.some((server) => server.tag === 'block'), false);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].reason, /wireguard/);
  });

  test('protocol labels: XHTTP TLS, Reality and Hysteria2 (§1.4)', () => {
    const read = readXrayConfigs(STASH);
    const byName = Object.fromEntries(read.servers.map((server) => [server.name, server.protocol]));
    assert.equal(byName['de-main (de2)'], 'VLESS XHTTP · TLS');
    assert.equal(byName['de-main-2 (de2)'], 'VLESS XHTTP · Reality');
    assert.equal(byName['de-main-3 (de2)'], 'Hysteria2');
  });

  test('a single object is accepted as a one-element list (§1.1)', () => {
    const one = readXrayConfigs(ODD);
    assert.equal(one.meta.configs, 2);
    const dir = makeTempDir();
    const file = path.join(dir, 'xray-configs.json');
    fs.writeFileSync(file, JSON.stringify(JSON.parse(fs.readFileSync(STASH, 'utf8'))[0]), 'utf8');
    const read = readXrayConfigs(file);
    assert.equal(read.state, 'ok');
    assert.ok(read.servers.length > 0);
  });

  test('broken JSON is a STATE, not an exception (§1.5)', () => {
    const read = readXrayConfigs(BROKEN);
    assert.equal(read.state, 'unreadable');
    assert.deepEqual(read.servers, []);
    assert.match(read.error, /файл не читается/);
  });

  test('a chained outbound is skipped with a warning (§1.2)', () => {
    const skipped = [];
    const read = readXrayConfigs(ODD, [], skipped);
    const names = read.servers.map((server) => server.name);
    assert.deepEqual(names, ['de-main (de2)', 'old-vmess (vm)']);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].reason, /цепочки выходов/);
    // The second config carries only freedom: nothing is added, nothing is said.
    assert.equal(read.meta.servers, 2);
  });
});

describe('the outbound is copied verbatim (§3.1, §8.1(2))', () => {
  test('every field survives, only the tag changes', () => {
    const raw = JSON.parse(fs.readFileSync(STASH, 'utf8'));
    const original = raw[0].outbounds.find((outbound) => outbound.tag === 'de-main');
    const read = readXrayConfigs(STASH);
    const server = read.servers.find((item) => item.baseName === 'de-main (de2)');
    assert.deepEqual(server.outbound, original);

    const config = buildXrayConfig(xrayEntries([{...server, key: 'stash/de-main (de2)'}], {
      'stash/de-main (de2)': 20800,
    }));
    assert.equal(config.outbounds[0].protocol, 'blackhole');
    const copied = config.outbounds[1];
    assert.deepEqual(copied, {...structuredClone(original), tag: 'out-20800'});
    // The fine obfuscation is explicitly preserved.
    assert.equal(copied.streamSettings.xhttpSettings.extra.xPaddingObfsMode, true);
    assert.equal(copied.streamSettings.xhttpSettings.extra.sessionIDTable, 'Base62');
  });

  test('the Hysteria2 `finalmask` is preserved', () => {
    const raw = JSON.parse(fs.readFileSync(STASH, 'utf8'));
    const original = raw[0].outbounds.find((outbound) => outbound.tag === 'de-main-3');
    const read = readXrayConfigs(STASH);
    const server = read.servers.find((item) => item.baseName === 'de-main-3 (de2)');
    assert.deepEqual(server.outbound, original);
    assert.deepEqual(server.outbound.streamSettings.finalmask, {
      quicParams: {debug: false, congestion: 'bbr'},
    });
  });
});

describe('the Xray config (§3.1, §8.1(4))', () => {
  test('blackhole first, 127.0.0.1 only, a rule per inbound, deterministic', () => {
    const read = readXrayConfigs(STASH);
    const servers = read.servers.map((server) => ({...server, key: `stash/${server.baseName}`}));
    const resolved = resolveXrayPorts(servers, undefined, []);
    const config = buildXrayConfig(xrayEntries(servers, resolved.ports));

    assert.deepEqual([...DEFAULT_XRAY_PORT_RANGE], [20800, 20999]);
    assert.equal(config.outbounds[0].tag, 'block');
    assert.equal(config.outbounds[0].protocol, 'blackhole');
    assert.equal(config.inbounds.length, 8);
    for (const inbound of config.inbounds) {
      assert.equal(inbound.listen, '127.0.0.1');
      assert.equal(inbound.protocol, 'socks');
    }
    assert.equal(config.routing.rules.length, 8);
    assert.deepEqual(config.routing.rules[0], {inboundTag: ['in-20800'], outboundTag: 'out-20800'});
    // Tag by port, and the order by port.
    assert.equal(config.inbounds[0].tag, 'in-20800');
    assert.equal(config.outbounds[1].tag, 'out-20800');

    const again = buildXrayConfig(xrayEntries(servers, resolved.ports));
    assert.deepEqual(again, config);
  });

  test('the socks outbound sing-box sees has the server name (§3.2)', () => {
    assert.deepEqual(xraySocksOutbound({name: 'de-main (de2)'}, 20800), {
      type: 'socks',
      tag: 'de-main (de2)',
      server: '127.0.0.1',
      server_port: 20800,
      version: '5',
    });
  });

  test('the label falls back sensibly for other protocols', () => {
    assert.equal(xrayProtocolLabel({protocol: 'hysteria', settings: {version: 1}}), 'Hysteria');
    assert.equal(
      xrayProtocolLabel({protocol: 'vmess', streamSettings: {network: 'ws', security: 'tls'}}),
      'VMess WS · TLS',
    );
  });
});

describe('the provider folder of kind xray (§1.5, §3.3)', () => {
  test('is read by kind, with names and port keys, and enters the build', () => {
    const {file, root} = project({stash: {'xray-configs.json': fs.readFileSync(STASH)}});
    const read = readProviders({stash: {enabled: true, kind: 'xray'}}, root);
    const provider = read.providers.find((item) => item.id === 'stash');
    assert.equal(provider.kind, 'xray');
    assert.equal(provider.contentKind, 'xray');
    assert.equal(provider.xrayServers.length, 8);
    assert.equal(provider.xrayServers[0].key, 'stash/de-main (de2)');
    assert.deepEqual(read.outbounds, []);

    // Generated sing-box config: a socks outbound per server, in auto-select.
    const result = generateConfigFile(file, {providersRoot: root});
    const socks = result.config.outbounds.filter((outbound) => outbound.type === 'socks');
    assert.equal(socks.length, 8);
    assert.equal(socks[0].server, '127.0.0.1');
    assert.deepEqual(result.xray.assigned['stash/de-main (de2)'], 20800);
    const auto = result.config.outbounds.find((outbound) => outbound.tag === 'auto-select');
    assert.ok(auto.outbounds.includes('de-main (de2)'));
  });

  test('a folder with NO record is «found», described but not built', () => {
    const {root} = project({stash: {'xray-configs.json': fs.readFileSync(STASH)}});
    const read = readProviders({}, root);
    const provider = read.providers.find((item) => item.id === 'stash');
    assert.equal(provider.kind, null);
    assert.equal(provider.contentKind, 'xray');
    assert.match(provider.hint, /похоже на конфиги Xray: 3 конфига, 9 выходов, 8 серверов/);
  });

  test('a mixed folder (xray + links) is warned about and does not build', () => {
    const {root} = project({
      stash: {
        'xray-configs.json': fs.readFileSync(STASH),
        'links.txt': 'vless://aaaaaaaa-0000-0000-0000-000000000001@a.example.com:443#A\n',
      },
    });
    const warnings = [];
    const read = readProviders({stash: {enabled: true, kind: 'xray'}}, root, warnings);
    const provider = read.providers.find((item) => item.id === 'stash');
    assert.equal(provider.contentKind, 'mixed');
    assert.ok(warnings.some((line) => /разнесите/.test(line)));
    // The CHOSEN xray half is read; the foreign links half is warned about and not.
    assert.equal(read.xrayServers.length, 8);
    assert.deepEqual(read.outbounds, []);
  });

  test('another *.json in the folder is named, not read', () => {
    const {root} = project({
      stash: {'xray-configs.json': fs.readFileSync(STASH), 'clash.yaml': 'x'},
    });
    const warnings = [];
    readProviders({stash: {enabled: true, kind: 'xray'}}, root, warnings);
    // `.yaml` is not a json: only *.json friends are reported.
    assert.equal(warnings.some((line) => /clash\.yaml/.test(line)), false);
    const {root: root2} = project({
      stash: {'xray-configs.json': fs.readFileSync(STASH), 'extra.json': '{}'},
    });
    const warnings2 = [];
    readProviders({stash: {enabled: true, kind: 'xray'}}, root2, warnings2);
    assert.ok(warnings2.some((line) => /ожидается xray-configs.json/.test(line)));
  });

  test('the suffix renames the servers but the port key keeps the base name', () => {
    const {root} = project({stash: {'xray-configs.json': fs.readFileSync(STASH)}});
    const read = readProviders({stash: {enabled: true, kind: 'xray', suffix: 'stash'}}, root);
    const provider = read.providers.find((item) => item.id === 'stash');
    assert.ok(provider.tags.includes('de-main (de2) stash'));
    assert.equal(provider.xrayServers[0].key, 'stash/de-main (de2)');
    assert.equal(provider.baseTags[0], 'de-main (de2)');
  });
});

describe('writing the Xray config (§3.3, §8.1(4))', () => {
  test('mode 0640, because the daemon reads it through the group', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'xray', 'config.json');
    writeXrayConfig(file, {log: {loglevel: 'warning'}, inbounds: [], outbounds: [], routing: {}});
    assert.equal(fs.statSync(file).mode & 0o777, 0o640);
    assert.equal(fs.statSync(path.dirname(file)).isDirectory(), true);
  });

  test('previewPair returns both configs; no servers means no Xray config', () => {
    const {file, root} = project({stash: {'xray-configs.json': fs.readFileSync(STASH)}});
    const pair = previewPair(file, {providersRoot: root});
    assert.equal(pair.xrayConfig.outbounds[0].tag, 'block');
    assert.equal(pair.config.outbounds.some((outbound) => outbound.type === 'socks'), true);

    const {file: plainFile, root: plainRoot} = project(
      {vpnd: {'links.txt': 'vless://aaaaaaaa-0000-0000-0000-000000000001@a.example.com:443#A\n'}},
      {providers: {vpnd: {enabled: true, kind: 'subscription'}}},
    );
    const plain = previewPair(plainFile, {providersRoot: plainRoot});
    assert.equal(plain.xrayConfig, null);
    assert.deepEqual(plain.xray.servers, []);
  });
});

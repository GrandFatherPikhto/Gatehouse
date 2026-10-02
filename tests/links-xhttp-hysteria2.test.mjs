// Links XHTTP (through Xray) and Hysteria2 (through sing-box) in a subscription.
//
// Acceptance of task plan_2026_10_02_gatehouse_links_xhttp_hysteria2.md §1–§2:
// the two parsers, the engine routing («авто» vs «Xray»), the overrides in both
// engines, the XHTTP round trip, and the «Xray not installed» skip.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {ConfigError} from '../src/core/errors.mjs';
import {parseHysteria2ToSingbox, parseHysteria2ToXray} from '../src/core/hysteria.mjs';
import {generateConfigFile} from '../src/core/settings.mjs';
import {readProviders} from '../src/core/sources.mjs';
import {parseSubscriptionLinks} from '../src/core/subscription.mjs';
import {parseVlessToXray} from '../src/core/xray-links.mjs';
import {ProjectModel} from '../src/model/project.mjs';
import {DEFAULT_SETTINGS_BODY, FIXTURES_DIR, makeTempDir, writeSettings} from './helpers.mjs';

const XHTTP_LINKS = path.join(FIXTURES_DIR, 'providers-links', 'xhttp', 'links.txt');
const HY2_LINKS = path.join(FIXTURES_DIR, 'providers-links', 'hy2', 'links.txt');

const XHTTP_TLS =
  'vless://11111111-1111-1111-1111-111111111111@xhttp-tls.example.com:443?type=xhttp&security=tls&sni=xhttp-tls.example.com&fp=chrome&alpn=h2&host=cdn.example.com&path=/x&mode=auto&extra=%7B%22xpaddingBytes%22%3A%22100-1000%22%7D#XHTTP%20TLS';

/** Writes `<root>/<id>/links.txt`. */
function writeProvider(root, id, content) {
  fs.mkdirSync(path.join(root, id), {recursive: true});
  fs.writeFileSync(path.join(root, id, 'links.txt'), content, 'utf8');
}

/** Opens a model over a fresh document in `dir`. */
function openModel(dir, providers) {
  const file = path.join(dir, 'webui.json');
  fs.writeFileSync(
    file,
    `${JSON.stringify({version: 2, ...DEFAULT_SETTINGS_BODY, providers}, null, 2)}\n`,
    'utf8',
  );
  return new ProjectModel({path: file, stateDir: path.join(dir, 'state')});
}

/** Rebuilds an XHTTP `vless://` link from one Xray outbound (§5.1.2, the canon). */
function xhttpLinkFromOutbound(outbound, tag) {
  const vnext = outbound.settings.vnext[0];
  const user = vnext.users[0];
  const stream = outbound.streamSettings;
  const x = stream.xhttpSettings ?? {};
  const tls = stream.tlsSettings ?? stream.realitySettings ?? {};
  const params = new URLSearchParams();
  params.set('type', stream.network === 'xhttp' ? 'xhttp' : stream.network);
  if (stream.security) params.set('security', stream.security);
  if (tls.serverName) params.set('sni', tls.serverName);
  if (tls.fingerprint) params.set('fp', tls.fingerprint);
  if (tls.alpn) params.set('alpn', tls.alpn.join(','));
  if (tls.publicKey) params.set('pbk', tls.publicKey);
  if (tls.shortId) params.set('sid', tls.shortId);
  if (tls.spiderX) params.set('spx', tls.spiderX);
  if (x.host) params.set('host', x.host);
  if (x.path) params.set('path', x.path);
  if (x.mode) params.set('mode', x.mode);
  if (x.extra) params.set('extra', JSON.stringify(x.extra));
  return `vless://${user.id}@${vnext.address}:${vnext.port}?${params.toString()}#${encodeURIComponent(tag)}`;
}

describe('hysteria2:// → sing-box (§1.1)', () => {
  test('every parameter of the table', () => {
    const out = parseHysteria2ToSingbox(
      'hysteria2://secret@hy2.example.com:443/?sni=x.example.com&alpn=h3,h2&insecure=1' +
        '&obfs=salamander&obfs-password=p&mport=20000-30000&upmbps=100&downmbps=500#HY2',
    );
    assert.equal(out.type, 'hysteria2');
    assert.equal(out.tag, 'HY2');
    assert.equal(out.server, 'hy2.example.com');
    assert.equal(out.server_port, 443);
    assert.equal(out.password, 'secret');
    assert.deepEqual(out.up_mbps, 100);
    assert.deepEqual(out.down_mbps, 500);
    assert.deepEqual(out.server_ports, ['20000:30000']);
    assert.deepEqual(out.obfs, {type: 'salamander', password: 'p'});
    assert.deepEqual(out.tls, {
      enabled: true,
      server_name: 'x.example.com',
      alpn: ['h3', 'h2'],
      insecure: true,
    });
  });

  test('the short scheme, no alpn, `fm` ignored, sni defaults to the host', () => {
    const out = parseHysteria2ToSingbox('hy2://plain@h.example.com:8443/?fm=%7B%22a%22%3A1%7D#X');
    assert.equal(out.server_port, 8443);
    assert.deepEqual(out.tls, {enabled: true, server_name: 'h.example.com'});
    assert.equal(Object.hasOwn(out, 'fm'), false);
  });

  test('the fixture parses into sing-box outbounds', () => {
    const parsed = parseSubscriptionLinks(HY2_LINKS);
    assert.equal(parsed.outbounds.length, 3);
    assert.equal(parsed.xrayServers.length, 0);
    assert.deepEqual(
      parsed.outbounds.map((outbound) => outbound.tag),
      ['HY2 Full', 'HY2 Short', 'HY2 Raw'],
    );
  });
});

describe('hysteria2:// → Xray (§1.1)', () => {
  test('auth, tlsSettings, hysteriaSettings and finalmask', () => {
    const server = parseHysteria2ToXray(
      'hysteria2://secret@hy2.example.com:443/?sni=x.example.com&alpn=h3&fp=chrome&fm=%7B%22a%22%3A1%7D#HY2',
    );
    assert.equal(server.protocol, 'Hysteria2');
    assert.equal(server.outbound.protocol, 'hysteria');
    assert.deepEqual(server.outbound.settings, {version: 2, address: 'hy2.example.com', port: 443});
    assert.deepEqual(server.outbound.streamSettings.hysteriaSettings, {version: 2, auth: 'secret'});
    assert.equal(server.outbound.streamSettings.network, 'hysteria');
    assert.equal(server.outbound.streamSettings.security, 'tls');
    assert.equal(server.outbound.streamSettings.tlsSettings.fingerprint, 'chrome');
    assert.deepEqual(server.outbound.streamSettings.finalmask, {a: 1});
  });

  test('obfs and mport are skipped with a reason, never silently', () => {
    const skipped = [];
    assert.equal(parseHysteria2ToXray('hysteria2://a@h.example.com:443/?obfs=salamander#Z', [], skipped), null);
    assert.match(skipped[0].reason, /obfs/);
    const skipped2 = [];
    assert.equal(parseHysteria2ToXray('hysteria2://a@h.example.com:443/?mport=1-2#Z', [], skipped2), null);
    assert.match(skipped2[0].reason, /mport/);
  });
});

describe('vless type=xhttp → Xray (§1.2)', () => {
  test('TLS with host, path, mode and a JSON `extra`', () => {
    const server = parseVlessToXray(XHTTP_TLS);
    assert.equal(server.tag, 'XHTTP TLS');
    assert.equal(server.protocol, 'VLESS XHTTP · TLS');
    assert.deepEqual(server.outbound, {
      protocol: 'vless',
      settings: {
        vnext: [
          {
            address: 'xhttp-tls.example.com',
            port: 443,
            users: [{id: '11111111-1111-1111-1111-111111111111', encryption: 'none', flow: ''}],
          },
        ],
      },
      streamSettings: {
        network: 'xhttp',
        security: 'tls',
        tlsSettings: {serverName: 'xhttp-tls.example.com', fingerprint: 'chrome', alpn: ['h2']},
        xhttpSettings: {
          host: 'cdn.example.com',
          path: '/x',
          mode: 'auto',
          extra: {xpaddingBytes: '100-1000'},
        },
      },
    });
  });

  test('Reality port 8443, no `extra`, `spx` → spiderX', () => {
    const line =
      'vless://22222222-2222-2222-2222-222222222222@xhttp-reality.example.com:8443?type=xhttp' +
      '&security=reality&pbk=PUBKEY_ONE&sid=ab12&sni=www.example.com&fp=firefox&mode=auto&path=/r&spx=%2F#R';
    const server = parseVlessToXray(line);
    assert.equal(server.remotePort, 8443);
    assert.equal(server.protocol, 'VLESS XHTTP · Reality');
    assert.deepEqual(server.outbound.streamSettings.realitySettings, {
      publicKey: 'PUBKEY_ONE',
      serverName: 'www.example.com',
      fingerprint: 'firefox',
      shortId: 'ab12',
      spiderX: '/',
    });
    assert.deepEqual(server.outbound.streamSettings.xhttpSettings, {path: '/r', mode: 'auto'});
  });

  test('splithttp becomes xhttp; a broken `extra` and `kcp` are skipped with a reason', () => {
    const split = parseVlessToXray(
      'vless://33333333-3333-3333-3333-333333333333@s.example.com:80?type=splithttp&security=none#S',
    );
    assert.equal(split.outbound.streamSettings.network, 'xhttp');

    const skipped = [];
    assert.equal(
      parseVlessToXray('vless://a@h.example.com:443?type=xhttp&extra=notjson#Z', [], skipped),
      null,
    );
    assert.match(skipped[0].reason, /extra не JSON/);

    const skipped2 = [];
    assert.equal(parseVlessToXray('vless://a@h.example.com:443?type=kcp#K', [], skipped2), null);
    assert.match(skipped2[0].reason, /транспорт 'kcp'/);
  });

  test('link → output → link → output is the same output (the canon)', () => {
    const first = parseVlessToXray(XHTTP_TLS).outbound;
    const relinked = xhttpLinkFromOutbound(first, 'XHTTP TLS');
    const second = parseVlessToXray(relinked).outbound;
    assert.deepEqual(second, first);
  });

  test('the fixture splits into three Xray servers', () => {
    const parsed = parseSubscriptionLinks(XHTTP_LINKS);
    assert.equal(parsed.outbounds.length, 0);
    assert.equal(parsed.xrayServers.length, 3);
    assert.deepEqual(
      parsed.xrayServers.map((server) => server.tag),
      ['XHTTP TLS', 'XHTTP Reality', 'Split HTTP'],
    );
  });
});

describe('the engine of a subscription (§2)', () => {
  function engineProject() {
    const dir = makeTempDir();
    const root = path.join(dir, 'providers');
    writeProvider(
      root,
      'stash',
      'vless://aaaaaaaa-0000-0000-0000-000000000001@tcp.example.com:443?security=tls&sni=tcp.example.com#TCP\n' +
        `${XHTTP_TLS}\n` +
        'hysteria2://secret@hy2.example.com:443/?sni=hy2.example.com#HY2\n',
    );
    return {dir, root};
  }

  test('«авто» keeps vless/hysteria2 in sing-box and sends only XHTTP to Xray', () => {
    const {root} = engineProject();
    const read = readProviders({stash: {enabled: true, kind: 'subscription'}}, root);
    const provider = read.providers.find((item) => item.id === 'stash');
    assert.deepEqual(provider.outbounds.map((outbound) => outbound.type), ['vless', 'hysteria2']);
    assert.deepEqual(provider.xrayServers.map((server) => server.tag), ['XHTTP TLS']);
    assert.equal(provider.xrayServers[0].key, 'stash/XHTTP TLS');
    assert.equal(read.xrayServers.length, 1);
    assert.deepEqual(provider.tags, ['TCP', 'HY2', 'XHTTP TLS']);
  });

  test('«Xray» sends every server through Xray', () => {
    const {root} = engineProject();
    const read = readProviders({stash: {enabled: true, kind: 'subscription', engine: 'xray'}}, root);
    const provider = read.providers.find((item) => item.id === 'stash');
    assert.equal(provider.outbounds.length, 0);
    assert.equal(provider.xrayServers.length, 3);
    assert.deepEqual(
      provider.xrayServers.map((server) => server.protocol),
      ['VLESS TCP · TLS', 'VLESS XHTTP · TLS', 'Hysteria2'],
    );
    assert.equal(read.xrayServers.length, 3);
  });

  test('overrides act in both engines', () => {
    const {root} = engineProject();
    const read = readProviders(
      {stash: {enabled: true, kind: 'subscription', engine: 'xray', overrides: {fp: 'safari', flow: 'vision'}}},
      root,
    );
    const provider = read.providers.find((item) => item.id === 'stash');
    const tcp = provider.xrayServers.find((server) => server.tag === 'TCP');
    assert.equal(tcp.outbound.settings.vnext[0].users[0].flow, 'xtls-rprx-vision');
    assert.equal(tcp.outbound.streamSettings.tlsSettings.fingerprint, 'safari');
    const xhttp = provider.xrayServers.find((server) => server.tag === 'XHTTP TLS');
    assert.equal(xhttp.outbound.streamSettings.tlsSettings.fingerprint, 'safari');
    assert.equal(xhttp.outbound.settings.vnext[0].users[0].flow, '');
  });

  test('without Xray on the host, «авто» skips the XHTTP server with a warning', () => {
    const {root} = engineProject();
    const read = readProviders({stash: {enabled: true, kind: 'subscription'}}, root, [], {
      xrayInstalled: false,
    });
    const provider = read.providers.find((item) => item.id === 'stash');
    assert.deepEqual(provider.outbounds.map((outbound) => outbound.type), ['vless', 'hysteria2']);
    assert.equal(provider.xrayServers.length, 0);
    assert.match(read.warnings.join('\n'), /Xray не установлен: 1 сервер XHTTP пропущен/);
    assert.match(provider.skipped.map((item) => item.reason).join('\n'), /Xray не установлен/);
  });

  test('setProviderEngine stores `xray`, «авто» deletes the key, a bad value is refused', () => {
    const {dir} = engineProject();
    const model = openModel(dir, {stash: {enabled: true, kind: 'subscription'}});
    // «Авто»: only the XHTTP link goes through Xray.
    assert.equal(model.enabledXrayServers().length, 1);
    model.setProviderEngine('stash', 'xray');
    assert.equal(model.getProvider('stash').engine, 'xray');
    // «Xray»: all three servers of the subscription.
    assert.equal(model.enabledXrayServers().length, 3);
    model.setProviderEngine('stash', 'auto');
    assert.equal(Object.hasOwn(model.getProvider('stash'), 'engine'), false);
    assert.throws(() => model.setProviderEngine('stash', 'nope'), ConfigError);
  });

  test('a folder without a kind names the Xray count in its hint (§3)', () => {
    const {root} = engineProject();
    const read = readProviders({}, root);
    const provider = read.providers.find((item) => item.id === 'stash');
    assert.match(provider.hint, /3 ссылки/);
    assert.match(provider.hint, /1 через Xray/);
  });
});

// Task 23: the whole pipeline, not just the parser. `applyOverrides` used to
// rebuild every server through a VLESS-shaped canonicaliser, dropping the
// Hysteria2 `password` (and obfs/ports/speeds) on the way to `config.json`;
// `sing-box check` does not require a password, so only an assembled config
// catches it.
describe('Hysteria2 survives to the assembled config.json (task 23 §2.3)', () => {
  function generateFor(providers, copies) {
    const dir = makeTempDir();
    const root = path.join(dir, 'providers');
    for (const [id, src] of Object.entries(copies)) {
      fs.mkdirSync(path.join(root, id), {recursive: true});
      fs.copyFileSync(src, path.join(root, id, 'links.txt'));
    }
    const settingsFile = writeSettings(dir, {
      providers,
      proxies: [{tag: 'main', type: 'mixed', port: 54321}],
    });
    return generateConfigFile(settingsFile, {providersRoot: root});
  }

  test('password, obfs, server_ports and speeds reach config.json', () => {
    const {config} = generateFor({hy2: {enabled: true, kind: 'subscription'}}, {hy2: HY2_LINKS});
    const hy2 = config.outbounds.filter((outbound) => outbound.type === 'hysteria2');
    assert.equal(hy2.length, 3);

    const full = hy2.find((outbound) => outbound.tag === 'HY2 Full');
    assert.equal(full.password, 'secret');
    assert.deepEqual(full.server_ports, ['20000:30000']);
    assert.deepEqual(full.obfs, {type: 'salamander', password: 'obfspass'});
    assert.equal(full.up_mbps, 100);
    assert.equal(full.down_mbps, 500);
    assert.deepEqual(full.tls, {enabled: true, server_name: 'hy2.example.com', alpn: ['h3']});

    const short = hy2.find((outbound) => outbound.tag === 'HY2 Short');
    assert.equal(short.password, 'plain');
    assert.deepEqual(short.tls, {enabled: true, server_name: 'hy2b.example.com', insecure: true});

    // A raw `/` in the password must not become the server (task 24 §2.1).
    const raw = hy2.find((outbound) => outbound.tag === 'HY2 Raw');
    assert.equal(raw.password, 'abc/def+ghi=');
    assert.equal(raw.server, 'hy2raw.example.net');
    assert.equal(raw.server_port, 8443);
  });

  test('a suffix and overrides do not strip the Hysteria2 fields', () => {
    const {config} = generateFor(
      {hy2: {enabled: true, kind: 'subscription', suffix: 'X', overrides: {fp: 'safari', flow: 'vision'}}},
      {hy2: HY2_LINKS},
    );
    const full = config.outbounds.find(
      (outbound) => outbound.type === 'hysteria2' && outbound.tag === 'HY2 Full X',
    );
    assert.equal(full.password, 'secret');
    assert.deepEqual(full.obfs, {type: 'salamander', password: 'obfspass'});
    assert.deepEqual(full.server_ports, ['20000:30000']);
    // QUIC: neither a transport flow nor uTLS is applied to Hysteria2.
    assert.equal(Object.hasOwn(full, 'flow'), false);
    assert.equal(Object.hasOwn(full.tls, 'utls'), false);
  });

  test('the XHTTP fixture yields Xray servers and no Hysteria2', () => {
    const result = generateFor({xhttp: {enabled: true, kind: 'subscription'}}, {xhttp: XHTTP_LINKS});
    assert.equal(result.config.outbounds.filter((o) => o.type === 'hysteria2').length, 0);
    assert.equal(result.xray.servers.length, 3);
  });
});

// Task 24: some panels put a base64 password into the link WRITHOUT encoding the
// `/`. `splitVlessUrl` ends the authority at the first `/`, so the server came out
// as `abc` with no password and no warning.
describe('a raw `/` in the Hysteria2 password (task 24)', () => {
  test('authority is read to the LAST `@`; raw / + = stay in the password', () => {
    const out = parseHysteria2ToSingbox(
      'hy2://abc/def+ghi=@h.example.net:8443/?obfs=salamander&obfs-password=x#T',
    );
    assert.equal(out.password, 'abc/def+ghi=');
    assert.equal(out.server, 'h.example.net');
    assert.equal(out.server_port, 8443);
    assert.deepEqual(out.obfs, {type: 'salamander', password: 'x'});
  });

  test('percent-encoded / + = are decoded to the same password', () => {
    const out = parseHysteria2ToSingbox('hy2://abc%2Fdef%2Bghi%3D@h.example.net:8443/#T');
    assert.equal(out.password, 'abc/def+ghi=');
    assert.equal(out.server, 'h.example.net');
  });

  test('an empty password is skipped with a reason, not turned into a server', () => {
    const skipped = [];
    assert.equal(parseHysteria2ToSingbox('hy2://@h.example.net:443/#X', [], skipped), null);
    assert.match(skipped[0].reason, /нет пароля/);
    const skipped2 = [];
    assert.equal(parseHysteria2ToSingbox('hy2://h.example.net:443/#X', [], skipped2), null);
    assert.match(skipped2[0].reason, /нет пароля/);
  });

  test('a host without a dot and not an IP is skipped with a reason', () => {
    const skipped = [];
    assert.equal(parseHysteria2ToSingbox('hy2://pass@abc:443/#X', [], skipped), null);
    assert.match(skipped[0].reason, /странный адрес сервера: 'abc'/);
  });

  test('the Xray builder reads the same password and server', () => {
    const server = parseHysteria2ToXray('hy2://abc/def=@h.example.net:8443/#T');
    assert.equal(server.outbound.streamSettings.hysteriaSettings.auth, 'abc/def=');
    assert.equal(server.outbound.settings.address, 'h.example.net');
    assert.equal(server.outbound.settings.port, 8443);
  });

  test('the whole pipeline keeps the raw password and the real server', () => {
    const dir = makeTempDir();
    const root = path.join(dir, 'providers');
    writeProvider(
      root,
      'hy2',
      'hy2://abc/def+ghi=@hy2raw.example.net:8443/?sni=hy2raw.example.net#Raw\n',
    );
    const settingsFile = writeSettings(dir, {
      providers: {hy2: {enabled: true, kind: 'subscription'}},
      proxies: [{tag: 'main', type: 'mixed', port: 54321}],
    });
    const {config} = generateConfigFile(settingsFile, {providersRoot: root});
    const out = config.outbounds.find((o) => o.type === 'hysteria2');
    assert.equal(out.password, 'abc/def+ghi=');
    assert.equal(out.server, 'hy2raw.example.net');
    assert.equal(out.server_port, 8443);
  });
});

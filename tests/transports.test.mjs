// VLESS transports, flow, security and the per-subscription overrides.
//
// Acceptance of the task `plan_2026_10_01_gatehouse_vless_transports.md` §5.3–§5.6
// and §5.12: every transport of the §1.1 table, the flow-only-over-TCP rule, the
// security refusals, the comment/foreign-scheme handling and the two «тонкие
// настройки». The UUIDs are invented; every host is under example.com.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {applyOverrides, parseLinks, parseVless, transportLabel} from '../src/core/vless.mjs';
import {FIXTURES_DIR, makeTempDir, vlessLink} from './helpers.mjs';

const UUID = 'aaaaaaaa-0000-0000-0000-000000000001';
const FIXTURE_LINKS = path.join(FIXTURES_DIR, 'providers-transports', 'links.txt');

/** The canonical key order the generator relies on. */
function keysOf(outbound) {
  return Object.keys(outbound);
}

describe('transports: the §1.1 table, case by case', () => {
  test('ws with host', () => {
    const outbound = parseVless(
      vlessLink(UUID, 'ws.example.com', 'ws1', 'type=ws&path=/al/1&host=ws.example.com&security=tls&sni=ws.example.com'),
    );
    assert.deepEqual(outbound, {
      type: 'vless',
      tag: 'ws1',
      server: 'ws.example.com',
      server_port: 443,
      uuid: UUID,
      tls: {
        enabled: true,
        server_name: 'ws.example.com',
        utls: {enabled: true, fingerprint: 'chrome'},
      },
      transport: {type: 'ws', path: '/al/1', headers: {Host: 'ws.example.com'}},
    });
  });

  test('ws without host has no headers and defaults the path to /', () => {
    const outbound = parseVless(vlessLink(UUID, 'ws.example.com', 'ws2', 'type=ws&security=tls&sni=ws.example.com'));
    assert.deepEqual(outbound.transport, {type: 'ws', path: '/'});
  });

  test('ws early data: ?ed= becomes max_early_data and leaves the path', () => {
    const outbound = parseVless(
      vlessLink(UUID, 'ws.example.com', 'ws3', 'type=ws&path=%2Fx%3Fed%3D2048&security=tls&sni=ws.example.com'),
    );
    assert.deepEqual(outbound.transport, {
      type: 'ws',
      path: '/x',
      max_early_data: 2048,
      early_data_header_name: 'Sec-WebSocket-Protocol',
    });
  });

  test('grpc with serviceName', () => {
    const outbound = parseVless(
      vlessLink(UUID, 'grpc.example.com', 'grpc1', 'type=grpc&serviceName=svc&security=tls&sni=grpc.example.com'),
    );
    assert.deepEqual(outbound.transport, {type: 'grpc', service_name: 'svc'});
  });

  test('grpc without serviceName is skipped with a warning', () => {
    const warnings = [];
    const skipped = [];
    assert.equal(
      parseVless(vlessLink(UUID, 'grpc.example.com', 'grpc2', 'type=grpc&security=tls&sni=grpc.example.com'), warnings, skipped),
      null,
    );
    assert.match(warnings[0], /grpc без serviceName/);
    assert.deepEqual(skipped, [{label: 'grpc2', reason: 'grpc без serviceName: некуда подключиться'}]);
  });

  test('httpupgrade with path and host', () => {
    const outbound = parseVless(
      vlessLink(UUID, 'up.example.com', 'up1', 'type=httpupgrade&path=/up&host=up.example.com&security=tls&sni=up.example.com'),
    );
    assert.deepEqual(outbound.transport, {type: 'httpupgrade', path: '/up', host: 'up.example.com'});
  });

  test('http splits two hosts on the comma', () => {
    const outbound = parseVless(
      vlessLink(UUID, 'http.example.com', 'h2', 'type=http&host=a.example.com,b.example.com&path=/h2&security=tls&sni=http.example.com'),
    );
    assert.deepEqual(outbound.transport, {
      type: 'http',
      host: ['a.example.com', 'b.example.com'],
      path: '/h2',
    });
  });

  test('http with an empty host has no host key', () => {
    const outbound = parseVless(
      vlessLink(UUID, 'http.example.com', 'h2b', 'type=h2&path=/x&security=tls&sni=http.example.com'),
    );
    assert.ok(!Object.hasOwn(outbound.transport, 'host'));
  });

  test('quic without settings', () => {
    const outbound = parseVless(
      vlessLink(UUID, 'quic.example.com', 'quic1', 'type=quic&security=tls&sni=quic.example.com'),
    );
    assert.deepEqual(outbound.transport, {type: 'quic'});
  });

  test('quic with quicSecurity is skipped with a warning', () => {
    const warnings = [];
    assert.equal(
      parseVless(
        vlessLink(UUID, 'quic.example.com', 'quic2', 'type=quic&quicSecurity=aes-128-gcm&security=tls&sni=quic.example.com'),
        warnings,
      ),
      null,
    );
    assert.match(warnings[0], /quicSecurity/);
  });

  test('raw is a bare TCP link: no transport block', () => {
    const outbound = parseVless(
      vlessLink(UUID, 'raw.example.com', 'raw1', 'type=raw&security=tls&sni=raw.example.com'),
    );
    assert.ok(!Object.hasOwn(outbound, 'transport'));
    assert.deepEqual(outbound.tls, {
      enabled: true,
      server_name: 'raw.example.com',
      utls: {enabled: true, fingerprint: 'chrome'},
    });
  });

  test('an unknown transport is skipped with a warning', () => {
    const warnings = [];
    const skipped = [];
    assert.equal(
      parseVless(vlessLink(UUID, 'x.example.com', 'xhttp', 'type=xhttp&security=tls&sni=x.example.com'), warnings, skipped),
      null,
    );
    assert.match(warnings[0], /неизвестный транспорт 'xhttp'/);
    assert.deepEqual(skipped[0].label, 'xhttp');
  });

  test('tcp with headerType is skipped with a warning', () => {
    const warnings = [];
    assert.equal(
      parseVless(vlessLink(UUID, 'tcp.example.com', 'mask', 'headerType=http&security=tls&sni=tcp.example.com'), warnings),
      null,
    );
    assert.match(warnings[0], /HTTP-маскировка/);
  });

  test('Reality+TCP keeps the reference key order', () => {
    const outbound = parseVless(
      vlessLink(UUID, 'fi.example.com', 'fi', 'security=reality&pbk=KEY&sid=ab12&sni=fi.example.com'),
    );
    assert.deepEqual(keysOf(outbound), ['type', 'tag', 'server', 'server_port', 'uuid', 'flow', 'tls']);
    assert.equal(outbound.flow, 'xtls-rprx-vision');
  });
});

describe('flow only over TCP (task §1.3)', () => {
  test('Reality+TCP without flow gets xtls-rprx-vision', () => {
    const outbound = parseVless(
      vlessLink(UUID, 'fi.example.com', 'fi', 'security=reality&pbk=KEY&sni=fi.example.com'),
    );
    assert.equal(outbound.flow, 'xtls-rprx-vision');
  });

  test('Reality over ws has no flow and no warning', () => {
    const warnings = [];
    const outbound = parseVless(
      vlessLink(UUID, 'fi.example.com', 'fi', 'type=ws&security=reality&pbk=KEY&sni=fi.example.com'),
      warnings,
    );
    assert.ok(!Object.hasOwn(outbound, 'flow'));
    assert.deepEqual(warnings, []);
  });

  test('TLS+TCP keeps the flow from the link', () => {
    const outbound = parseVless(
      vlessLink(UUID, 'fi.example.com', 'fi', 'security=tls&sni=fi.example.com&flow=xtls-rprx-vision'),
    );
    assert.equal(outbound.flow, 'xtls-rprx-vision');
  });

  test('TLS over ws drops the flow with a warning, and the link is still taken', () => {
    const warnings = [];
    const outbound = parseVless(
      vlessLink(UUID, 'ws.example.com', 'ws', 'type=ws&security=tls&sni=ws.example.com&flow=xtls-rprx-vision'),
      warnings,
    );
    assert.ok(outbound !== null, 'the link is kept');
    assert.ok(!Object.hasOwn(outbound, 'flow'));
    assert.match(warnings[0], /Vision работает только поверх TCP/);
  });
});

describe('security (task §1.2)', () => {
  test('an unknown security is refused, not silently unencrypted', () => {
    const warnings = [];
    assert.equal(
      parseVless(vlessLink(UUID, 'x.example.com', 'xtls', 'security=xtls&sni=x.example.com'), warnings),
      null,
    );
    assert.match(warnings[0], /неизвестный security 'xtls'/);
  });

  test('allowInsecure=1 is refused on purpose', () => {
    const warnings = [];
    assert.equal(
      parseVless(vlessLink(UUID, 'x.example.com', 'insecure', 'security=tls&sni=x.example.com&allowInsecure=1'), warnings),
      null,
    );
    assert.match(warnings[0], /отключение проверки сертификата не поддерживается сознательно/);
  });

  test('alpn is split on the comma', () => {
    const outbound = parseVless(
      vlessLink(UUID, 'x.example.com', 'alpn', 'security=tls&sni=x.example.com&alpn=h2,http/1.1'),
    );
    assert.deepEqual(outbound.tls.alpn, ['h2', 'http/1.1']);
  });

  test('no alpn parameter means no key', () => {
    const outbound = parseVless(vlessLink(UUID, 'x.example.com', 'noalpn', 'security=tls&sni=x.example.com'));
    assert.ok(!Object.hasOwn(outbound.tls, 'alpn'));
  });
});

describe('comments, foreign schemes and no UUID in warnings (task §1.4-§1.5)', () => {
  test('a # comment is skipped silently', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'links.txt');
    fs.writeFileSync(
      file,
      `# a server switched off by hand\n${vlessLink(UUID, 'ok.example.com', 'ok', 'security=tls&sni=ok.example.com')}\n`,
      'utf8',
    );
    const warnings = [];
    const outbounds = parseLinks(file, warnings);
    assert.deepEqual(outbounds.map((outbound) => outbound.tag), ['ok']);
    assert.deepEqual(warnings, []);
    fs.rmSync(dir, {recursive: true, force: true});
  });

  test('a less:// line produces a warning and no UUID leaks into it', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'links.txt');
    fs.writeFileSync(
      file,
      `less://${UUID}@fi.example.com:443#cut\n${vlessLink(UUID, 'ok.example.com', 'ok', 'security=tls&sni=ok.example.com')}\n`,
      'utf8',
    );
    const warnings = [];
    parseLinks(file, warnings);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /не vless:\/\/-ссылка, пропущена/);
    assert.doesNotMatch(warnings[0], new RegExp(UUID));
    fs.rmSync(dir, {recursive: true, force: true});
  });

  test('every warning of the fixture is free of the fixture UUIDs', () => {
    const warnings = [];
    const dir = makeTempDir();
    const file = path.join(dir, 'links.txt');
    fs.writeFileSync(
      file,
      [
        'vless://aaaaaaaa-0000-0000-0000-0000000000ff@x.example.com:443?type=xhttp&security=tls&sni=x.example.com#bad',
        'vless://aaaaaaaa-0000-0000-0000-0000000000fe@x.example.com:443?security=xtls&sni=x.example.com#worse',
        vlessLink(UUID, 'ok.example.com', 'ok', 'security=tls&sni=ok.example.com'),
      ].join('\n'),
      'utf8',
    );
    parseLinks(file, warnings);
    assert.equal(warnings.length, 2);
    for (const warning of warnings) {
      assert.doesNotMatch(warning, /aaaaaaaa-0000-0000-0000-0000000000/);
    }
    fs.rmSync(dir, {recursive: true, force: true});
  });
});

describe('the committed providers-transports fixture parses transport by transport', () => {
  test('tags and protocol labels match the links', () => {
    const warnings = [];
    const outbounds = parseLinks(FIXTURE_LINKS, warnings);
    assert.deepEqual(warnings, []);
    const byTag = Object.fromEntries(outbounds.map((outbound) => [outbound.tag, outbound]));
    assert.deepEqual(Object.keys(byTag).sort(), [
      'Plain TCP',
      'Reality TCP',
      'TLS HTTP',
      'TLS HTTPUpgrade',
      'TLS QUIC',
      'TLS TCP',
      'TLS WS',
      'TLS gRPC',
      'TLS raw',
    ]);
    assert.equal(transportLabel(byTag['Reality TCP']), 'Reality');
    assert.equal(transportLabel(byTag['TLS TCP']), 'TLS');
    assert.equal(transportLabel(byTag['Plain TCP']), 'без шифрования');
    assert.equal(transportLabel(byTag['TLS raw']), 'TLS');
    assert.equal(transportLabel(byTag['TLS WS']), 'TLS · WS');
    assert.equal(transportLabel(byTag['TLS gRPC']), 'TLS · gRPC');
    assert.equal(transportLabel(byTag['TLS HTTPUpgrade']), 'TLS · HTTPUpgrade');
    assert.equal(transportLabel(byTag['TLS HTTP']), 'TLS · HTTP');
    assert.equal(transportLabel(byTag['TLS QUIC']), 'TLS · QUIC');
    assert.equal(byTag['TLS HTTP'].transport.host.length, 2);
  });
});

describe('applyOverrides (task §2.5 / §5.12)', () => {
  test('flow vision adds xtls-rprx-vision to a TLS+raw link without flow', () => {
    const outbound = parseVless(
      vlessLink(UUID, 'raw.example.com', 'raw', 'type=raw&security=tls&sni=raw.example.com'),
    );
    const next = applyOverrides(outbound, {flow: 'vision'});
    assert.equal(next.flow, 'xtls-rprx-vision');
    assert.deepEqual(keysOf(next), ['type', 'tag', 'server', 'server_port', 'uuid', 'flow', 'tls']);
  });

  test('flow vision does not touch a ws link', () => {
    const outbound = parseVless(
      vlessLink(UUID, 'ws.example.com', 'ws', 'type=ws&security=tls&sni=ws.example.com'),
    );
    const next = applyOverrides(outbound, {flow: 'vision'});
    assert.ok(!Object.hasOwn(next, 'flow'));
  });

  test('flow none removes the flow of a Reality+TCP link', () => {
    const outbound = parseVless(
      vlessLink(UUID, 'fi.example.com', 'fi', 'security=reality&pbk=KEY&sni=fi.example.com'),
    );
    const next = applyOverrides(outbound, {flow: 'none'});
    assert.ok(!Object.hasOwn(next, 'flow'));
  });

  test('fp rewrites utls.fingerprint of every tls link', () => {
    const tls = parseVless(vlessLink(UUID, 'a.example.com', 'a', 'security=tls&sni=a.example.com&fp=firefox'));
    const plain = parseVless(vlessLink(UUID, 'b.example.com', 'b'));
    assert.equal(applyOverrides(tls, {fp: 'safari'}).tls.utls.fingerprint, 'safari');
    assert.ok(!Object.hasOwn(applyOverrides(plain, {fp: 'safari'}), 'tls'));
  });

  test('no overrides leaves the outbound deep-equal to the parsed one', () => {
    const outbound = parseVless(
      vlessLink(UUID, 'fi.example.com', 'fi', 'security=reality&pbk=KEY&sni=fi.example.com&flow=xtls-rprx-vision'),
    );
    assert.deepEqual(applyOverrides(outbound, {}), outbound);
  });
});

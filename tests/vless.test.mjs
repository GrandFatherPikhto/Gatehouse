// VLESS parsing tests.
//
// Ported from tests/test_sing_box_manager.py of the reference project; the name
// of the original Python test is given above each case. Cases marked PROBE come
// from techdocs/url-probe.md — they document the divergences that made a manual
// URL parser necessary.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {ConfigError} from '../src/core/errors.mjs';
import {BOM_WARNING, dedupTags, getFirst, parseLinks, parseVless, unquote} from '../src/core/vless.mjs';
import {ALL_TAGS, FI_TAG, FIXTURES_DIR, makeTempDir, NL_TAG, vlessLink} from './helpers.mjs';

const FIXTURE_LINKS = path.join(FIXTURES_DIR, 'providers', 'vpnd', 'links.txt');

// Reference: test_parse_vless_reality
test('parseVless: reality transport', () => {
  const url = vlessLink(
    'uuid-1',
    'fi.example.com',
    FI_TAG,
    'security=reality&pbk=PUBKEY&sid=ab12&sni=fi.example.com&flow=xtls-rprx-vision&fp=firefox',
  );
  const outbound = parseVless(url);

  assert.equal(outbound.type, 'vless');
  assert.equal(outbound.tag, FI_TAG);
  assert.equal(outbound.server, 'fi.example.com');
  assert.equal(outbound.server_port, 443);
  assert.equal(outbound.uuid, 'uuid-1');
  assert.equal(outbound.flow, 'xtls-rprx-vision');
  assert.equal(outbound.tls.enabled, true);
  assert.equal(outbound.tls.server_name, 'fi.example.com');
  assert.deepEqual(outbound.tls.utls, {enabled: true, fingerprint: 'firefox'});
  assert.equal(outbound.tls.reality.enabled, true);
  assert.equal(outbound.tls.reality.public_key, 'PUBKEY');
  assert.equal(outbound.tls.reality.short_id, 'ab12');
});

// Reference: test_parse_vless_reality_defaults
test('parseVless: reality defaults for flow/fp, empty sni and short_id', () => {
  const outbound = parseVless(vlessLink('uuid-1', 'fi.example.com', FI_TAG, 'security=reality&pbk=PUBKEY'));

  assert.equal(outbound.flow, 'xtls-rprx-vision');
  assert.equal(outbound.tls.utls.fingerprint, 'chrome');
  assert.equal(outbound.tls.server_name, '');
  assert.equal(outbound.tls.reality.short_id, '');
});

// Reference: test_parse_vless_tls
test('parseVless: tls transport has no reality and no flow', () => {
  const outbound = parseVless(vlessLink('uuid-2', 'nl.example.com', NL_TAG, 'security=tls&sni=nl.example.com'));

  assert.equal(outbound.tls.enabled, true);
  assert.equal(outbound.tls.server_name, 'nl.example.com');
  assert.equal(outbound.tls.utls.fingerprint, 'chrome');
  assert.ok(!('reality' in outbound.tls));
  assert.ok(!('flow' in outbound));
});

// Reference: test_parse_vless_plain_tcp_has_no_tls_nor_flow
test('parseVless: missing security means plain tcp', () => {
  const outbound = parseVless(vlessLink('uuid-3', 'ru.example.com', '🇷🇺 Russia - Moscow'));

  assert.ok(!('flow' in outbound));
  assert.ok(!('tls' in outbound));
  assert.equal(outbound.server_port, 443);
});

// Reference: test_parse_vless_defaults_port_and_tag
test('parseVless: default port 443 and tag vpnd-<host> without a fragment', () => {
  const outbound = parseVless('vless://uuid-9@plain.example.com');

  assert.equal(outbound.server_port, 443);
  assert.equal(outbound.tag, 'vpnd-plain.example.com');
});

// Reference: test_parse_vless_reality_without_pbk_is_skipped
test('parseVless: reality without pbk is skipped with a warning', () => {
  const warnings = [];
  const outbound = parseVless(
    vlessLink('uuid-1', 'fi.example.com', FI_TAG, 'security=reality&sni=fi.example.com'),
    warnings,
  );

  assert.equal(outbound, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /reality-ссылка без pbk/);
});

// Reference: test_parse_vless_broken_links_return_none
describe('parseVless: broken links return null (test_parse_vless_broken_links_return_none)', () => {
  const broken = [
    'vless://@fi.example.com:443#no-uuid', // no uuid
    'vless://uuid-1@:443#no-server', // no server
    'vless://uuid-1@fi.example.com:notaport#bad-port', // bad port
  ];

  for (const url of broken) {
    test(url, () => {
      const warnings = [];
      assert.equal(parseVless(url, warnings), null);
      assert.equal(warnings.length, 1);
    });
  }
});

// Reference: test_parse_vless_non_vless_scheme_return_none
describe('parseVless: other schemes return null silently (test_parse_vless_non_vless_scheme_return_none)', () => {
  const foreign = [
    '',
    'vmess://uuid-1@fi.example.com:443#vmess',
    'https://fi.example.com/sub#thing',
    'ss://YWVzOnBhc3M@fi.example.com:8388#shadowsocks',
  ];

  for (const url of foreign) {
    test(JSON.stringify(url), () => {
      const warnings = [];
      assert.equal(parseVless(url, warnings), null);
      assert.deepEqual(warnings, []);
    });
  }
});

// PROBE: urllib.parse lowercases the host, WHATWG new URL() keeps the case.
test('parseVless: host is lowercased like urllib.parse', () => {
  assert.equal(parseVless('vless://uuid-1@FI.Example.COM:443#Upper').server, 'fi.example.com');
});

// PROBE: urllib.parse unwraps the IPv6 brackets, WHATWG new URL() keeps them.
test('parseVless: IPv6 literal loses the brackets and is lowercased', () => {
  assert.equal(parseVless('vless://uuid@[2001:DB8::1]:443#v6').server, '2001:db8::1');
});

// PROBE: the reference writes `port if port else 443`, so port 0 becomes 443.
test('parseVless: port 0 becomes 443 like the reference', () => {
  assert.equal(parseVless('vless://uuid@host.example.com:0#zero').server_port, 443);
  assert.equal(parseVless('vless://uuid@[2001:db8::1]:0#v6zero').server_port, 443);
});

// PROBE: port above 65535 raises in urllib.parse, the link is skipped.
test('parseVless: port out of range is skipped with a warning', () => {
  const warnings = [];
  assert.equal(parseVless('vless://uuid@host.example.com:65536#toobig', warnings), null);
  assert.match(warnings[0], /Ошибка парсинга ссылки/);
});

// PROBE: decodeURIComponent throws on '%zz', urllib.parse.unquote keeps it.
test('unquote: malformed escape stays literal', () => {
  assert.equal(unquote('%zz'), '%zz');
  assert.equal(unquote('a%zzb'), 'a%zzb');
  assert.equal(unquote('%2'), '%2');
  assert.equal(unquote('%E2%82%AC'), '€');
  assert.equal(unquote('%F0%9F%87%AB%F0%9F%87%AE'), '🇫🇮');
  // Trailing incomplete sequence becomes U+FFFD, as errors='replace' does.
  assert.equal(unquote('%F0%9F'), '\ufffd');
});

// Reference: test_parse_vless_reality_defaults + the get_first trap of the task.
test('getFirst: empty value, missing key, trimming and first-of-many', () => {
  const query = new URLSearchParams('sni=&fp=firefox&dup=one&dup=two&blank=%20%20');

  assert.equal(getFirst(query, 'sni'), ''); // parse_qs drops empty values
  assert.equal(getFirst(query, 'sni', 'DEF'), 'DEF');
  assert.equal(getFirst(query, 'nope', 'DEF'), 'DEF');
  assert.equal(getFirst(query, 'fp'), 'firefox');
  assert.equal(getFirst(query, 'dup'), 'one'); // first of many, like val[0]
  assert.equal(getFirst(query, 'blank', 'DEF'), 'DEF'); // whitespace only
  assert.equal(getFirst(null, 'x', 'DEF'), 'DEF');
  assert.equal(getFirst({a: ['  value  ']}, 'a'), 'value'); // parse_qs shape
});

// PROBE: urllib.parse.urlparse is case-insensitive about the scheme.
test('parseVless: uppercase scheme is accepted', () => {
  assert.equal(parseVless('VLESS://uuid@host.example.com#up').tag, 'up');
});

// PROBE: a scheme without '//' has no netloc, so the link is skipped.
test('parseVless: scheme without // is skipped', () => {
  const warnings = [];
  assert.equal(parseVless('vless:uuid@host.example.com#nofwd', warnings), null);
  assert.match(warnings[0], /без UUID или сервера/);
});

// Reference: test_dedup_tags_adds_numeric_suffix
test('dedupTags: numeric suffixes, in place (test_dedup_tags_adds_numeric_suffix)', () => {
  const outbounds = [{tag: 'dup'}, {tag: 'dup'}, {tag: 'dup'}, {tag: 'other'}];
  dedupTags(outbounds);

  assert.deepEqual(
    outbounds.map((outbound) => outbound.tag),
    ['dup', 'dup #2', 'dup #3', 'other'],
  );
});

// Reference: test_parse_links_missing_file
test('parseLinks: missing file throws ConfigError', () => {
  assert.throws(
    () => parseLinks(path.join(makeTempDir(), 'nope.txt')),
    (error) => error instanceof ConfigError && /не найден/.test(error.message),
  );
});

// Reference: test_parse_links_without_valid_links
test('parseLinks: no valid links throws ConfigError', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'links.txt');
  fs.writeFileSync(file, 'не ссылка\nhttps://example.com/x\n\nvmess://also-not-vless\n', 'utf8');

  assert.throws(
    () => parseLinks(file),
    (error) => error instanceof ConfigError && /валидных VLESS/.test(error.message),
  );
});

// Reference: test_parse_links_skips_junk_and_dedups_tags
test('parseLinks: skips junk and dedups tags', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'links.txt');
  fs.writeFileSync(
    file,
    `${[
      'мусор',
      vlessLink('uuid-1', 'fi.example.com', FI_TAG, 'security=tls'),
      vlessLink('uuid-2', 'fi2.example.com', FI_TAG, 'security=tls'),
      '',
    ].join('\n')}\n`,
    'utf8',
  );

  const outbounds = parseLinks(file);
  assert.deepEqual(
    outbounds.map((outbound) => outbound.tag),
    [FI_TAG, `${FI_TAG} #2`],
  );
});

// Reference: test_default_links_fixture_is_parseable
test('parseLinks: the committed links fixture yields exactly the known tags', () => {
  const outbounds = parseLinks(FIXTURE_LINKS);

  assert.deepEqual(
    outbounds.map((outbound) => outbound.tag),
    ALL_TAGS,
  );
  assert.ok(fs.readFileSync(FIXTURE_LINKS, 'utf8').split('\n')[0].startsWith('vless://'));
});

// NEW: the reference reads the links file with errors='ignore'; Node would
// otherwise put U+FFFD into a tag and spoil the byte-level comparison.
test('parseLinks: invalid UTF-8 bytes are dropped, not replaced', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'links.txt');
  const good = Buffer.from(vlessLink('uuid-1', 'fi.example.com', 'tag', 'security=tls'), 'utf8');
  fs.writeFileSync(file, Buffer.concat([good, Buffer.from([0xff, 0xfe])]));

  const outbounds = parseLinks(file);

  assert.equal(outbounds.length, 1);
  assert.equal(outbounds[0].tag, 'tag');
});

// Paired fix with the reference (techdocs/done_2026_09_14_strip_bom_from_links.md):
// a BOM used to turn the first line into "\ufeffvless://...", urllib.parse saw a
// scheme it did not recognise and the link vanished without a word — one server
// quietly lost from the subscription. This test used to pin that behaviour.
test('parseLinks: a leading BOM is stripped once, with a warning', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'links.txt');
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(vlessLink('uuid-1', 'bom.example.com', 'bom', 'security=tls')),
      Buffer.from('\n'),
      Buffer.from(vlessLink('uuid-2', 'ok.example.com', 'ok', 'security=tls')),
      Buffer.from('\n'),
    ]),
  );

  const warnings = [];
  const outbounds = parseLinks(file, warnings);

  assert.deepEqual(
    outbounds.map((outbound) => outbound.tag),
    ['bom', 'ok'],
  );
  assert.deepEqual(warnings, [BOM_WARNING]);
});

// Only the very first character of the file is dropped: a BOM anywhere else
// keeps its old behaviour and that link is still skipped silently.
test('parseLinks: a BOM in the middle of the file still breaks that link', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'links.txt');
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from(`${vlessLink('uuid-1', 'first.example.com', 'first', 'security=tls')}\n`),
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(`${vlessLink('uuid-2', 'second.example.com', 'second', 'security=tls')}\n`),
    ]),
  );

  const warnings = [];
  const outbounds = parseLinks(file, warnings);

  assert.deepEqual(
    outbounds.map((outbound) => outbound.tag),
    ['first'],
  );
  assert.deepEqual(warnings, []);
});

test('parseLinks: a file that is nothing but a BOM still fails', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'links.txt');
  fs.writeFileSync(file, Buffer.from([0xef, 0xbb, 0xbf]));

  const warnings = [];
  assert.throws(
    () => parseLinks(file, warnings),
    (error) => error instanceof ConfigError && /валидных VLESS/.test(error.message),
  );
  assert.deepEqual(warnings, [BOM_WARNING]);
});

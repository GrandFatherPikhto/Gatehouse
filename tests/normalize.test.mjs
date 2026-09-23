// Normaliser of tunnel configs (part 4).
//
// The golden pair is synthetic on purpose: the real provider files under
// `dev/root/` carry the owner's PublicKey, Endpoint and obfuscation settings,
// and nothing from `sources/` may enter the repository (task §6.4). The
// transformation does not depend on the values, so the proof is the same.
//
// The strongest assertion here is the byte-for-byte one: the diff of the golden
// pair is exactly two lines, `+ Table = off` and `− DNS = 1.1.1.1`, and the
// obfuscation plus `AllowedIPs` must not move by a byte.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {ConfigError} from '../src/core/errors.mjs';
import {
  INTERFACE_NAME_MAX,
  POLICY_ROUTING_TABLE,
  PRESERVED_KEYS,
  chooseInterfaceName,
  normalizeTunnel,
} from '../src/core/normalize.mjs';
import {FIXTURES_DIR} from './helpers.mjs';

const PROVIDER = path.join(FIXTURES_DIR, 'tunnel', 'provider.conf');
const NORMALIZED = path.join(FIXTURES_DIR, 'tunnel', 'normalized.conf');

const providerText = fs.readFileSync(PROVIDER, 'utf8');
const normalizedText = fs.readFileSync(NORMALIZED, 'utf8');

/** A line of a config by its key, or null. */
function lineOf(text, key) {
  return text.split('\n').find((line) => new RegExp(`^\\s*${key}\\s*=`).test(line)) ?? null;
}

describe('normalizeTunnel on the synthetic golden pair (NEW)', () => {
  test('the result is byte for byte the golden file', () => {
    const result = normalizeTunnel(providerText, {name: 'hmn-graz4'});

    assert.equal(result.text, normalizedText);
    assert.ok(
      Buffer.from(result.text, 'utf8').equals(fs.readFileSync(NORMALIZED)),
      'byte for byte, not merely equal as strings',
    );
  });

  test('exactly the two mandatory changes are reported, each with a reason', () => {
    const {changes} = normalizeTunnel(providerText, {name: 'hmn-graz4'});

    assert.equal(changes.length, 2);
    assert.deepEqual(
      changes.map((change) => [change.kind, change.line]),
      [
        ['add', 'Table = off'],
        ['remove', 'DNS = 1.1.1.1'],
      ],
    );
    for (const change of changes) {
      assert.ok(change.why.length > 0, 'every change carries a reason');
    }
  });

  test('the interface name is validated, and reported', () => {
    const result = normalizeTunnel(providerText, {name: 'hmn-graz4'});
    assert.equal(result.name, 'hmn-graz4');
    assert.ok(result.name.length <= INTERFACE_NAME_MAX);
  });
});

describe('the intangible keys are copied byte for byte (NEW)', () => {
  test('every obfuscation key and AllowedIPs is reported as preserved', () => {
    const {preserved} = normalizeTunnel(providerText, {name: 'hmn-graz4'});

    for (const key of ['AllowedIPs', 'Jc', 'Jmin', 'Jmax', 'S1', 'S4', 'H1', 'H4', 'i1']) {
      assert.ok(preserved.includes(key), `${key} must be reported as untouched`);
    }
    assert.deepEqual(
      preserved,
      PRESERVED_KEYS.filter((key) => lineOf(providerText, key) !== null),
    );
  });

  test('their lines are identical before and after', () => {
    const {text} = normalizeTunnel(providerText, {name: 'hmn-graz4'});

    for (const key of PRESERVED_KEYS) {
      assert.equal(lineOf(text, key), lineOf(providerText, key), `${key} moved`);
    }
  });
});

describe('mandatory rules are idempotent and complete (NEW)', () => {
  test('a config that already has Table = off is left alone, and no DNS line means no removal', () => {
    const config = ['[Interface]', 'Table = off', 'PrivateKey = x', '[Peer]', 'AllowedIPs = 0.0.0.0/0'].join('\n');

    const result = normalizeTunnel(config, {name: 'wg0'});

    assert.equal(result.text, config);
    assert.deepEqual(result.changes, []);
  });

  test('an existing Table value is corrected to off', () => {
    const config = ['[Interface]', 'Table = auto', 'PrivateKey = x'].join('\n');

    const result = normalizeTunnel(config, {name: 'wg0'});

    assert.ok(result.text.includes('Table = off'));
    assert.ok(!result.text.includes('Table = auto'));
    assert.equal(result.changes[0].kind, 'change');
  });

  test('a config without [Interface] is refused', () => {
    assert.throws(
      () => normalizeTunnel('[Peer]\nAllowedIPs = 0.0.0.0/0\n', {name: 'wg0'}),
      (error) => error instanceof ConfigError && /\[Interface\]/.test(error.message),
    );
  });

  test('the newline style and the trailing newline survive', () => {
    const config = '[Interface]\r\nTable = off\r\nPrivateKey = x\r\n';

    const result = normalizeTunnel(config, {name: 'wg0'});

    assert.equal(result.text, config);
  });
});

describe('the single optional flag: policy routing (NEW)', () => {
  test('off by default — no PostUp appears', () => {
    const {text} = normalizeTunnel(providerText, {name: 'hmn-graz4'});
    assert.ok(!text.includes('PostUp'));
    assert.ok(!text.includes('PreDown'));
  });

  test('on adds PostUp/PreDown with an ip rule built from Address', () => {
    const result = normalizeTunnel(providerText, {name: 'hmn-graz4', policyRouting: true});

    assert.match(result.text, /^PostUp = ip rule add from 100\.64\.0\.2 table 200$/m);
    assert.match(result.text, /^PreDown = ip rule del from 100\.64\.0\.2 table 200$/m);
    assert.equal(POLICY_ROUTING_TABLE, 200);
    assert.equal(result.changes.length, 4);
  });

  test('policy routing without Address is refused', () => {
    assert.throws(
      () => normalizeTunnel('[Interface]\nTable = off\nPrivateKey = x\n', {
        name: 'wg0',
        policyRouting: true,
      }),
      (error) => error instanceof ConfigError && /Address/.test(error.message),
    );
  });
});

describe('interface name rules (NEW)', () => {
  test('an empty desired name falls back to awg0', () => {
    assert.equal(chooseInterfaceName('', new Set()), 'awg0');
  });

  test('a taken name grows a suffix within the limit', () => {
    const taken = new Set(['hmn-graz4']);
    const chosen = chooseInterfaceName('hmn-graz4', taken);

    assert.notEqual(chosen, 'hmn-graz4');
    assert.ok(chosen.length <= INTERFACE_NAME_MAX);
    assert.ok(chosen.startsWith('hmn-graz4'));
  });

  test('a name longer than the kernel limit is refused', () => {
    assert.throws(
      () => chooseInterfaceName('a'.repeat(INTERFACE_NAME_MAX + 1), new Set()),
      (error) => error instanceof ConfigError && /15 символов/.test(error.message),
    );
  });
});

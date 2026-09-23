// Discovery of provider folders.
//
// The rule under test: `GATEHOUSE_PROVIDERS` names ONE root, every sub-folder of
// it is a provider, the folder name IS the identifier, and a provider with no
// record in `webui.json` is found but DISABLED. Nothing is watched: the folders
// are re-read on every call, so a new one appears by itself.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {
  DEFAULT_PROVIDERS_ROOT,
  PROVIDER_LABEL_SEPARATOR,
  isProviderId,
  readProviders,
  resolveProvidersRoot,
} from '../src/core/sources.mjs';
import {DEFAULT_LINKS, FI_TAG, makeTempDir, vlessLink} from './helpers.mjs';

describe('resolveProvidersRoot', () => {
  test('GATEHOUSE_PROVIDERS wins', () => {
    assert.equal(
      resolveProvidersRoot('/etc/gatehouse', {GATEHOUSE_PROVIDERS: '/srv/providers'}),
      '/srv/providers',
    );
  });

  test('a providers/ folder next to webui.json is used when the variable is absent', () => {
    const dir = makeTempDir();
    const beside = path.join(dir, 'providers');
    fs.mkdirSync(beside);
    assert.equal(resolveProvidersRoot(dir, {}), beside);
  });

  test('without the variable and without a neighbouring folder the default is used', () => {
    assert.equal(resolveProvidersRoot(makeTempDir(), {}), DEFAULT_PROVIDERS_ROOT);
  });
});

describe('isProviderId', () => {
  test('accepts letters, digits, dot, dash and underscore, but not a leading . or -', () => {
    for (const id of ['vpnd', 'hide.myname', 'a_b-c', 'a1']) assert.equal(isProviderId(id), true);
    for (const id of ['.hidden', '-dash', 'bad name', '', 'a/b']) {
      assert.equal(isProviderId(id), false, `${id} must be refused`);
    }
  });
});

/**
 * Root with every kind of entry the reader has to tell apart.
 *
 * @returns {string}
 */
function buildDiscoveryRoot() {
  const dir = makeTempDir();
  const root = path.join(dir, 'providers');
  fs.mkdirSync(path.join(root, 'vpnd'), {recursive: true});
  fs.writeFileSync(path.join(root, 'vpnd', 'links.txt'), DEFAULT_LINKS);

  fs.mkdirSync(path.join(root, 'amnezia'));
  fs.writeFileSync(path.join(root, 'amnezia', 'one.conf'), 'x');
  fs.writeFileSync(path.join(root, 'amnezia', 'two.conf'), 'x');

  fs.mkdirSync(path.join(root, 'mix'));
  fs.writeFileSync(path.join(root, 'mix', 'links.txt'), DEFAULT_LINKS);
  fs.writeFileSync(path.join(root, 'mix', 'three.conf'), 'x');

  fs.mkdirSync(path.join(root, 'empty'));
  fs.mkdirSync(path.join(root, 'bad name'));
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.writeFileSync(path.join(root, 'stray.txt'), 'x');
  return root;
}

describe('discovery of provider folders', () => {
  test('reads every folder, skips hidden entries and reports the rest with a reason', () => {
    const root = buildDiscoveryRoot();
    const read = readProviders({}, root);

    assert.deepEqual(
      read.providers.map((provider) => provider.id).sort(),
      ['amnezia', 'mix', 'vpnd'],
    );
    assert.equal(read.providers.every((provider) => provider.enabled === false), true);

    const byId = Object.fromEntries(read.unread.map((entry) => [entry.id, entry]));
    assert.equal(byId['empty'].state, 'empty');
    assert.equal(byId['bad name'].state, 'badname');
    assert.equal(byId['stray.txt'].state, 'stray');
    assert.equal(Object.hasOwn(byId, '.hidden'), false, 'hidden entries are skipped silently');
  });

  test('classifies links, tunnels and mixed folders, counting what they hold', () => {
    const root = buildDiscoveryRoot();
    const read = readProviders({}, root);
    const byId = Object.fromEntries(read.providers.map((provider) => [provider.id, provider]));

    assert.equal(byId.vpnd.kind, 'links');
    assert.equal(byId.vpnd.count, 3);
    assert.equal(byId.amnezia.kind, 'tunnels');
    assert.equal(byId.amnezia.count, 2);
    assert.deepEqual(byId.amnezia.entries, ['one.conf', 'two.conf']);
    assert.equal(byId.mix.kind, 'mixed');
    assert.equal(byId.mix.count, 3);
  });

  test('only ENABLED providers contribute outbounds and tags', () => {
    const root = buildDiscoveryRoot();
    const none = readProviders({}, root);
    assert.equal(none.outbounds.length, 0);
    assert.deepEqual(none.tags, []);

    const read = readProviders({vpnd: {enabled: true}}, root);
    assert.equal(read.tags.length, 3);
    assert.equal(read.tags.includes(FI_TAG), true);
  });

  test('a record whose folder is gone is reported, and may be forgotten', () => {
    const root = buildDiscoveryRoot();
    const read = readProviders({ghost: {enabled: true}}, root);
    const ghost = read.unread.find((entry) => entry.id === 'ghost');
    assert.ok(ghost, 'the missing record is listed');
    assert.equal(ghost.state, 'missing');
    assert.equal(ghost.forget, true);
  });

  test('a tag two enabled providers share is suffixed with the identifier', () => {
    const dir = makeTempDir();
    const root = path.join(dir, 'providers');
    const shared = `${vlessLink('11111111-1111-1111-1111-111111111111', 'a.example.com', FI_TAG)}\n`;
    const other = `${vlessLink('22222222-2222-2222-2222-222222222222', 'b.example.com', FI_TAG)}\n`;
    for (const [id, text] of [['one', shared], ['two', other]]) {
      fs.mkdirSync(path.join(root, id), {recursive: true});
      fs.writeFileSync(path.join(root, id, 'links.txt'), text);
    }

    const read = readProviders({one: {enabled: true}, two: {enabled: true}}, root);
    assert.deepEqual(read.tags.sort(), [
      `${FI_TAG}${PROVIDER_LABEL_SEPARATOR}one`,
      `${FI_TAG}${PROVIDER_LABEL_SEPARATOR}two`,
    ]);
  });

  test('an absent root is one sentence, and no lists', () => {
    const read = readProviders({}, path.join(makeTempDir(), 'gone'));
    assert.equal(read.providers.length, 0);
    assert.equal(read.unread.length, 0);
    assert.match(read.rootState.message, /корень провайдеров не найден/);
  });
});

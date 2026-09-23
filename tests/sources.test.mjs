// Sources: several provider folders instead of one links file.
//
// The two invariants of part 3 are checked here directly on the reader:
//   * a provider label appears ONLY on a name collision between providers, so a
//     single-source project keeps its tags byte for byte (the golden gate);
//   * tunnel configs are listed and NEVER become outbounds.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {
  PROVIDER_LABEL_SEPARATOR,
  readSources,
  resolveSourcesRoot,
  sourceNames,
  sourceSpecs,
} from '../src/core/sources.mjs';
import {ConfigError} from '../src/core/errors.mjs';
import {FI_UUID, NL_UUID, makeTempDir, vlessLink} from './helpers.mjs';

const AT_TAG = '🇦🇹 Austria - Vienna';

/**
 * Writes one provider folder.
 *
 * @param {string} dir
 * @param {string} name
 * @param {{links?: string, tunnels?: string[]}} [content]
 * @returns {string}
 */
function writeProvider(dir, name, content = {}) {
  const providerDir = path.join(dir, 'sources', name);
  fs.mkdirSync(providerDir, {recursive: true});
  if (content.links) fs.writeFileSync(path.join(providerDir, 'links.txt'), content.links, 'utf8');
  for (const tunnel of content.tunnels ?? []) {
    fs.writeFileSync(path.join(providerDir, tunnel), 'x', 'utf8');
  }
  return providerDir;
}

describe('resolveSourcesRoot and sourceNames (NEW)', () => {
  test('the root defaults to <settingsDir>/sources', () => {
    assert.equal(resolveSourcesRoot('/etc/gatehouse', {}), path.join('/etc/gatehouse', 'sources'));
  });

  test('GATEHOUSE_SOURCES wins', () => {
    assert.equal(
      resolveSourcesRoot('/etc/gatehouse', {GATEHOUSE_SOURCES: '/var/lib/gatehouse/sources'}),
      '/var/lib/gatehouse/sources',
    );
  });

  test('sourceNames drops blanks and accepts a single string', () => {
    assert.deepEqual(sourceNames(['vpnd', '', '  hidemyname ']), ['vpnd', 'hidemyname']);
    assert.deepEqual(sourceNames('vpnd'), ['vpnd']);
    assert.deepEqual(sourceNames(undefined), []);
  });
});

describe('merging providers (NEW)', () => {
  test('a single source keeps the tags untouched — the golden gate', () => {
    const dir = makeTempDir();
    writeProvider(dir, 'vpnd', {
      links: `${vlessLink(FI_UUID, 'fi.example.com', AT_TAG, 'security=tls')}\n`,
    });

    const read = readSources(['vpnd'], path.join(dir, 'sources'));

    assert.deepEqual(read.tags, [AT_TAG]);
    assert.ok(!read.tags[0].includes(PROVIDER_LABEL_SEPARATOR));
  });

  test('distinct names from different providers are not labelled', () => {
    const dir = makeTempDir();
    writeProvider(dir, 'vpnd', {
      links: `${vlessLink(FI_UUID, 'fi.example.com', AT_TAG, 'security=tls')}\n`,
    });
    writeProvider(dir, 'hidemyname', {
      links: `${vlessLink(NL_UUID, 'nl.example.com', '🇳🇱 Netherlands - Amsterdam', 'security=tls')}\n`,
    });

    const read = readSources(['vpnd', 'hidemyname'], path.join(dir, 'sources'));

    assert.deepEqual(read.tags, [AT_TAG, '🇳🇱 Netherlands - Amsterdam']);
  });

  test('the same name from two providers is suffixed with the provider', () => {
    const dir = makeTempDir();
    writeProvider(dir, 'vpnd', {
      links: `${vlessLink(FI_UUID, 'fi.example.com', AT_TAG, 'security=tls')}\n`,
    });
    writeProvider(dir, 'hidemyname', {
      links: `${vlessLink(NL_UUID, 'at.example.com', AT_TAG, 'security=tls')}\n`,
    });

    const read = readSources(['vpnd', 'hidemyname'], path.join(dir, 'sources'));

    assert.deepEqual(read.tags, [
      `${AT_TAG}${PROVIDER_LABEL_SEPARATOR}vpnd`,
      `${AT_TAG}${PROVIDER_LABEL_SEPARATOR}hidemyname`,
    ]);
  });

  test('a repeated name inside one provider warns and is still usable', () => {
    const dir = makeTempDir();
    writeProvider(dir, 'vpnd', {
      links:
        `${vlessLink(FI_UUID, 'fi.example.com', AT_TAG, 'security=tls')}\n` +
        `${vlessLink(NL_UUID, 'at2.example.com', AT_TAG, 'security=tls')}\n`,
    });
    const warnings = [];

    const read = readSources(['vpnd'], path.join(dir, 'sources'), warnings);

    assert.equal(read.tags.length, 2);
    assert.ok(warnings.some((warning) => /2 ссылки с именем/.test(warning)));
    assert.ok(read.tags.every((tag) => !tag.includes(PROVIDER_LABEL_SEPARATOR)));
  });
});

describe('tunnels are listed, never emitted (NEW)', () => {
  test('a folder with only .conf files contributes no outbounds', () => {
    const dir = makeTempDir();
    writeProvider(dir, 'hidemyname', {tunnels: ['AustriaGrazS4.conf', 'AustriaViennaS6.conf']});

    const read = readSources(['hidemyname'], path.join(dir, 'sources'));

    assert.deepEqual(read.tags, []);
    assert.deepEqual(read.outbounds, []);

    const [provider] = read.providers;
    assert.equal(provider.kind, 'tunnels');
    assert.equal(provider.count, 2);
    assert.deepEqual(provider.entries, ['AustriaGrazS4.conf', 'AustriaViennaS6.conf']);
  });

  test('a mixed folder emits its links and lists its tunnels', () => {
    const dir = makeTempDir();
    writeProvider(dir, 'amnezia', {
      links: `${vlessLink(FI_UUID, 'fi.example.com', AT_TAG, 'security=tls')}\n`,
      tunnels: ['de.conf'],
    });

    const read = readSources(['amnezia'], path.join(dir, 'sources'));

    assert.deepEqual(read.tags, [AT_TAG]);
    const [provider] = read.providers;
    assert.equal(provider.kind, 'mixed');
    assert.equal(provider.count, 1);
    assert.deepEqual(provider.entries, ['de.conf']);
    assert.ok(typeof provider.mtime === 'string', 'the folder carries a modification time');
  });

  test('a missing folder is reported, not thrown', () => {
    const dir = makeTempDir();

    const read = readSources(['ghost'], path.join(dir, 'sources'));

    assert.deepEqual(read.tags, []);
    assert.equal(read.providers[0].state, 'missing');
    assert.match(read.providers[0].error, /не найдена/);
  });
});

describe('explicit sources: {kind, name, path} (NEW)', () => {
  test('sourceSpecs normalises objects, keeps strings as legacy and refuses a bad kind', () => {
    assert.deepEqual(
      sourceSpecs([{kind: 'links', name: ' vpnd ', path: ' a.txt '}]),
      [{kind: 'links', name: 'vpnd', path: 'a.txt'}],
    );
    assert.deepEqual(sourceSpecs('vpnd'), [{kind: 'legacy', name: 'vpnd', path: 'vpnd'}]);
    assert.throws(
      () => sourceSpecs([{kind: 'nope', name: 'x', path: 'y'}]),
      (error) => error instanceof ConfigError && /неизвестный тип/.test(error.message),
    );
    assert.throws(
      () => sourceSpecs([{kind: 'links', name: 'x', path: ''}]),
      (error) => error instanceof ConfigError && /не задан путь/.test(error.message),
    );
  });

  test('a links source is one file, resolved from the settings directory', () => {
    const dir = makeTempDir();
    writeProvider(dir, 'vpnd', {
      links: `${vlessLink(FI_UUID, 'fi.example.com', AT_TAG, 'security=tls')}\n`,
    });

    const read = readSources(
      [{kind: 'links', name: 'vpnd', path: 'sources/vpnd/links.txt'}],
      {root: path.join(dir, 'sources'), baseDir: dir},
    );

    assert.ok(fs.existsSync(path.join(dir, 'sources', 'vpnd', 'links.txt')));
    assert.deepEqual(read.tags, [AT_TAG]);
    assert.equal(read.providers[0].kind, 'links');
    assert.equal(read.providers[0].type, 'file');
    assert.equal(read.providers[0].state, 'ok');
  });

  test('a tunnels source is a directory, and contributes no outbounds', () => {
    const dir = makeTempDir();
    const tunnelDir = writeProvider(dir, 'hidemyname', {
      tunnels: ['AustriaGrazS4.conf', 'AustriaViennaS6.conf'],
    });

    const read = readSources([{kind: 'tunnels', name: 'hidemyname', path: tunnelDir}], {
      root: path.join(dir, 'sources'),
      baseDir: dir,
    });

    assert.deepEqual(read.tags, []);
    assert.deepEqual(read.outbounds, []);
    const [provider] = read.providers;
    assert.equal(provider.kind, 'tunnels');
    assert.equal(provider.type, 'directory');
    assert.deepEqual(provider.entries, ['AustriaGrazS4.conf', 'AustriaViennaS6.conf']);
  });

  test('a links path that does not exist is a missing source, not a throw', () => {
    const dir = makeTempDir();

    const read = readSources([{kind: 'links', name: 'vpnd', path: 'gone.txt'}], {
      root: path.join(dir, 'sources'),
      baseDir: dir,
    });

    assert.deepEqual(read.tags, []);
    assert.equal(read.providers[0].state, 'missing');
    assert.match(read.providers[0].error, /файл ссылок не найден/);
  });
});

// The folder KIND (§3): what a folder is, chosen by the owner.
//
// A folder with no kind is «found, not connected»: it is described but never
// feeds the build. `subscription` reads only links.txt, `awg` only *.conf; the
// foreign half is warned about and left unread. Migration infers the kind once,
// on open. Enabling needs a kind; changing it needs the provider disabled.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {ConfigError} from '../src/core/errors.mjs';
import {readProviders} from '../src/core/sources.mjs';
import {ProjectModel} from '../src/model/project.mjs';
import {canonicalJson} from '../src/model/storage.mjs';
import {makeTempDir, vlessLink} from './helpers.mjs';

const TAG = '🇦🇱 Albania - Tirana 1';
const TLS = 'security=tls&sni=x.example.com';

function write(root, id, files) {
  fs.mkdirSync(path.join(root, id), {recursive: true});
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, id, name), content, 'utf8');
  }
}

function project(providers, folders) {
  const dir = makeTempDir();
  const root = path.join(dir, 'providers');
  for (const [id, files] of Object.entries(folders)) write(root, id, files);
  const file = path.join(dir, 'webui.json');
  fs.writeFileSync(
    file,
    canonicalJson({
      version: 2,
      listen_ip: '127.0.0.1',
      providers,
      output_file: 'config.json',
      exclude_from_auto: [],
      urltest: {url: 'https://gstatic.com', interval: '3m', tolerance: 50},
      log: {level: 'info', timestamp: true},
      dns: {servers: [], final: 'dns-local'},
      proxies: [{tag: 'p', type: 'socks', port: 54321}],
      routes: {},
    }),
    'utf8',
  );
  return {dir, root, file, model: new ProjectModel({path: file, stateDir: path.join(dir, 'state')})};
}

const LINKS = `${vlessLink('aaaaaaaa-0000-0000-0000-000000000001', 'a.example.com', TAG, TLS)}\n`;
const CONFS = {'one.conf': 'x', 'two.conf': 'y'};

describe('reading by kind (task §3.1)', () => {
  test('no kind: described, but nothing enters the build', () => {
    const dir = makeTempDir();
    const root = path.join(dir, 'providers');
    write(root, 'vpnd', {'links.txt': LINKS});
    const read = readProviders({vpnd: {enabled: true}}, root);
    const provider = read.providers.find((item) => item.id === 'vpnd');
    assert.equal(provider.kind, null);
    assert.equal(provider.contentKind, 'links');
    assert.deepEqual(provider.outbounds, []);
    assert.deepEqual(provider.tags, []);
    assert.match(provider.hint, /похоже на подписку/);
  });

  test('subscription reads only links.txt and ignores *.conf with a warning', () => {
    const dir = makeTempDir();
    const root = path.join(dir, 'providers');
    write(root, 'vpnd', {'links.txt': LINKS, 'stray.conf': 'x'});
    const warnings = [];
    const read = readProviders({vpnd: {enabled: true, kind: 'subscription'}}, root, warnings);
    const provider = read.providers.find((item) => item.id === 'vpnd');
    assert.equal(provider.tags.length, 1);
    assert.deepEqual(provider.entries, []);
    assert.ok(warnings.some((line) => /лишнее в папке/.test(line)));
  });

  test('awg reads only *.conf and ignores links.txt with a warning', () => {
    const dir = makeTempDir();
    const root = path.join(dir, 'providers');
    write(root, 'h', {...CONFS, 'links.txt': LINKS});
    const warnings = [];
    const read = readProviders({h: {enabled: true, kind: 'awg'}}, root, warnings);
    const provider = read.providers.find((item) => item.id === 'h');
    assert.deepEqual(provider.tags, []);
    assert.deepEqual(provider.entries, ['one.conf', 'two.conf']);
    assert.ok(warnings.some((line) => /разнесите/.test(line)));
    assert.deepEqual(read.outbounds, []);
  });
});

describe('migration of the kind (task §3.2)', () => {
  test('infers subscription for links and awg for configs, and asks to save', () => {
    const {model} = project(
      {vpnd: {enabled: true}, hidemyname: {enabled: true}},
      {vpnd: {'links.txt': LINKS}, hidemyname: CONFS},
    );
    assert.equal(model.getProvider('vpnd').kind, 'subscription');
    assert.equal(model.getProvider('hidemyname').kind, 'awg');
    assert.match(model.providersMigrationNotice, /вид папки/);
  });

  test('a mixed folder gets no kind and is warned about', () => {
    const {model} = project({mixed: {enabled: true}}, {mixed: {...CONFS, 'links.txt': LINKS}});
    assert.equal(model.getProvider('mixed').kind, undefined);
    assert.match(model.providersMigrationNotice, /разнесите и задайте вид/);
  });
});

describe('setProviderKind rules (task §3.3)', () => {
  test('is refused while the provider is enabled', () => {
    const {model} = project({vpnd: {enabled: true, kind: 'subscription'}}, {vpnd: {'links.txt': LINKS}});
    assert.throws(() => model.setProviderKind('vpnd', 'awg'), ConfigError);
  });

  test('awg is refused when tunnels[] takes its config from the folder', () => {
    const {model} = project(
      {h: {kind: 'subscription'}},
      {h: CONFS},
    );
    model.document.tunnels = [{provider: 'h', file: 'one.conf', name: 'hmn-one', interface: 'hmn-one'}];
    assert.throws(() => model.setProviderKind('h', 'awg'), /сначала выключите их/);
  });

  test('enabling a folder with no kind is refused', () => {
    // A record whose folder is gone keeps no kind (nothing to infer from).
    const {model} = project({ghost: {enabled: false}}, {});
    assert.throws(() => model.setProviderEnabled('ghost', true), /задайте вид папки/);
  });

  test('setting a kind lets the same folder be enabled', () => {
    const {model} = project({vpnd: {enabled: false}}, {vpnd: {'links.txt': LINKS}});
    model.setProviderKind('vpnd', 'subscription');
    model.setProviderEnabled('vpnd', true);
    assert.deepEqual(model.getProvider('vpnd'), {enabled: true, kind: 'subscription'});
  });
});

describe('the tree of outputs (task §2)', () => {
  test('groups the folders by kind and keeps a hint for «Найдено»', () => {
    // `loose` has NO record on purpose: it stays in «Найдено» instead of having
    // its kind inferred by the migration.
    const {model} = project(
      {vpnd: {enabled: true}, h: {enabled: true}},
      {vpnd: {'links.txt': LINKS}, h: CONFS, loose: {'links.txt': LINKS}},
    );

    const walk = (node) => {
      if (node.kind === 'outputs') return node;
      for (const child of node.children ?? []) {
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    const outputs = walk(model.treeSpec());
    assert.deepEqual(outputs.children.map((child) => child.kind), [
      'subscriptions',
      'tunnels',
      'found',
    ]);
    assert.equal(outputs.children[0].children.length, 1, 'vpnd is a subscription');
    assert.equal(outputs.children[1].children.length, 1, 'h is a tunnel source');
    assert.match(outputs.children[2].children[0].title, /похоже на подписку/);
  });
});

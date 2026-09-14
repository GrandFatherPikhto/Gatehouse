// Model tests: everything that does not need a server.
//
// The behavioural reference is generator/model.py of the Python project, so the
// cases that come from there name it; the cases marked NEW cover what only
// exists in the web editor (profiles, defaults, snapshots, the canonical format).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {ConfigError} from '../src/core/errors.mjs';
import {loadProfileSettings} from '../src/core/settings.mjs';
import {ProjectModel, formatStats} from '../src/model/project.mjs';
import {staleKey} from '../src/model/stale.mjs';
import {canonicalJson, listSnapshots} from '../src/model/storage.mjs';
import {
  ALL_TAGS,
  FI_TAG,
  makeProject,
  makeTempDir,
  writeLinksFile,
  writeSettings,
} from './helpers.mjs';

/**
 * Opens a model over a document written as the tool itself would write it.
 *
 * @param {Record<string, unknown>} document
 * @param {{stateDir?: string}} [options]
 * @returns {{dir: string, file: string, model: ProjectModel, stateDir: string}}
 */
function openDocument(document, options = {}) {
  const dir = makeTempDir();
  const stateDir = options.stateDir ?? path.join(dir, 'state');
  const file = path.join(dir, 'webui.json');
  fs.writeFileSync(file, canonicalJson(document), 'utf8');
  return {dir, file, stateDir, model: new ProjectModel({path: file, stateDir})};
}

/**
 * A minimal two-profile document.
 *
 * @returns {Record<string, unknown>}
 */
function twoProfiles() {
  return {
    version: 1,
    active: 'first',
    defaults: {},
    profiles: {
      first: {
        listen_ip: '127.0.0.1',
        links_file: 'links.txt',
        output_file: 'config.json',
        urltest: {url: 'https://gstatic.com', interval: '3m', tolerance: 50},
        log: {level: 'info', timestamp: true},
        proxies: [{tag: 'main-socks', type: 'socks', port: 54321}],
        routes: {telegram: {outbound: 'auto-select', domains: ['t.me']}},
      },
      second: {
        listen_ip: '10.0.0.2',
        links_file: 'links.txt',
        output_file: 'config.json',
        proxies: [{tag: 'main-socks', type: 'socks', port: 54321}],
      },
    },
  };
}

describe('canonical format and round-trip (NEW)', () => {
  test('an untouched canonical file is saved byte for byte', () => {
    const {file, model} = openDocument(twoProfiles());
    const before = fs.readFileSync(file);

    assert.equal(model.dirty, false);
    const result = model.save();

    assert.equal(result.path, file);
    assert.ok(fs.readFileSync(file).equals(before), 'the file must not change at all');
    assert.equal(model.dirty, false);
  });

  test('the canonical file ends with a newline and uses two spaces', () => {
    const {file, model} = openDocument(twoProfiles());
    model.save();

    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.endsWith('\n'));
    assert.ok(text.includes('\n  "active": "first"'));
    assert.equal(text, canonicalJson(twoProfiles()));
  });

  test('a foreign formatting is canonicalised, and the second save is a no-op', () => {
    const document = twoProfiles();
    const dir = makeTempDir();
    const file = path.join(dir, 'webui.json');
    // Four-space indent, no trailing newline: what a hand edit looks like.
    fs.writeFileSync(file, JSON.stringify(document, null, 4), 'utf8');

    const first = new ProjectModel({path: file, stateDir: path.join(dir, 'state')});
    first.save();
    const canonical = fs.readFileSync(file, 'utf8');
    assert.equal(canonical, canonicalJson(document));
    assert.ok(canonical.endsWith('\n'));

    // The stability test that matters: from now on saving changes nothing, so a
    // real edit is the only thing that can ever move these bytes.
    const second = new ProjectModel({path: file, stateDir: path.join(dir, 'state')});
    second.save();
    assert.equal(fs.readFileSync(file, 'utf8'), canonical);
  });

  test('a document without defaults keeps no defaults after a save', () => {
    const document = twoProfiles();
    delete document.defaults;

    const {file, model} = openDocument(document);
    model.save();

    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(!Object.hasOwn(saved, 'defaults'), 'reading must not create the section');
    assert.equal(fs.readFileSync(file, 'utf8'), canonicalJson(document));
  });

  test('a document with a digit-only profile name is refused at load', () => {
    const document = {version: 1, active: '2024', profiles: {'2024': {}}};
    const dir = makeTempDir();
    const file = path.join(dir, 'webui.json');
    fs.writeFileSync(file, canonicalJson(document), 'utf8');

    assert.throws(
      () => new ProjectModel({path: file, stateDir: path.join(dir, 'state')}),
      (error) => error instanceof ConfigError && /profiles/.test(error.message),
    );
  });
});

describe('dirty flag and file operations (reference: model.new/open/save)', () => {
  test('an edit marks the document dirty, a save marks it clean again', () => {
    const {model} = openDocument(twoProfiles());

    model.applyGeneral({listen_ip: '10.95.2.1'});
    assert.equal(model.dirty, true);

    model.save();
    assert.equal(model.dirty, false);
  });

  test('reload drops unsaved changes', () => {
    const {file, model} = openDocument(twoProfiles());
    model.applyGeneral({listen_ip: '10.95.2.1'});

    model.reload();

    assert.equal(model.listenIp, '127.0.0.1');
    assert.equal(model.dirty, false);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).profiles.first.listen_ip, '127.0.0.1');
  });

  test('a new project has the reference skeleton and no file', () => {
    const model = new ProjectModel({stateDir: makeTempDir()});
    const document = model.document;

    assert.equal(document.active, 'default');
    assert.deepEqual(document.defaults, {});
    assert.equal(document.profiles.default.listen_ip, '127.0.0.1');
    assert.equal(document.profiles.default.links_file, 'links.txt');
    assert.deepEqual(document.profiles.default.proxies, []);
    assert.equal(model.path, null);
    assert.throws(() => model.save(), (error) => /не задан путь/.test(error.message));
  });

  test('saving a brand new file happens without a snapshot', () => {
    const dir = makeTempDir();
    const stateDir = path.join(dir, 'state');
    const model = new ProjectModel({stateDir});
    model.newProject(path.join(dir, 'webui.json'));

    const result = model.save();

    assert.equal(result.snapshot, null, 'there is no previous version to preserve');
    assert.deepEqual(listSnapshots(stateDir), []);
  });

  test('the document is validated before anything is written', () => {
    const {file, model} = openDocument(twoProfiles());
    const before = fs.readFileSync(file, 'utf8');
    model.profileBody().proxies[0].type = 'socks5'; // not in PROXY_TYPES

    assert.throws(() => model.save(), (error) => error instanceof ConfigError);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'the broken edit never reaches the disk');
  });
});

describe('profiles (NEW)', () => {
  test('create, rename, duplicate and remove keep the order', () => {
    const {model} = openDocument(twoProfiles());

    model.createProfile('third');
    assert.deepEqual(model.profileNames(), ['first', 'second', 'third']);

    model.renameProfile('third', 'renamed');
    assert.deepEqual(model.profileNames(), ['first', 'second', 'renamed']);

    const copy = model.duplicateProfile('second');
    assert.equal(copy, 'second-copy');
    assert.deepEqual(model.profileNames(), ['first', 'second', 'second-copy', 'renamed']);

    model.removeProfile('renamed');
    assert.deepEqual(model.profileNames(), ['first', 'second', 'second-copy']);
  });

  test('a duplicate keeps the ports as they are', () => {
    const {model} = openDocument(twoProfiles());

    model.duplicateProfile('second', 'copy');

    const ports = (name) => model.profileBody(name).proxies.map((proxy) => proxy.port);
    assert.deepEqual(ports('copy'), ports('second'));
    assert.notEqual(model.profileBody('copy').proxies, model.profileBody('second').proxies);
  });

  test('the last profile cannot be removed', () => {
    const {model} = openDocument(twoProfiles());
    model.removeProfile('second');

    assert.throws(
      () => model.removeProfile('first'),
      (error) => error instanceof ConfigError && /последний профиль/.test(error.message),
    );
  });

  test('the active profile cannot be removed', () => {
    const {model} = openDocument(twoProfiles());

    assert.throws(
      () => model.removeProfile('first'),
      (error) => error instanceof ConfigError && /активный профиль 'first'/.test(error.message),
    );
  });

  test('renaming the active profile follows active', () => {
    const {model} = openDocument(twoProfiles());

    model.renameProfile('first', 'primary');

    assert.equal(model.activeProfileName(), 'primary');
    assert.deepEqual(model.profileNames(), ['primary', 'second']);
  });

  test('switching active marks the document dirty', () => {
    const {model} = openDocument(twoProfiles());

    assert.equal(model.setActive('second'), true);
    assert.equal(model.dirty, true);
    assert.equal(model.listenIp, '10.0.0.2');
    assert.equal(model.setActive('second'), false, 'no change, no dirty flag');
  });

  test('an unknown or digit-only name is refused', () => {
    const {model} = openDocument(twoProfiles());

    assert.throws(
      () => model.setActive('nope'),
      (error) => error instanceof ConfigError && /профиль 'nope' не найден/.test(error.message),
    );
    assert.throws(
      () => model.createProfile('2024'),
      (error) => error instanceof ConfigError && /только из цифр/.test(error.message),
    );
    assert.throws(
      () => model.createProfile('first'),
      (error) => error instanceof ConfigError && /уже есть/.test(error.message),
    );
  });

  test('nextFreeProfileName counts up from the base', () => {
    const {model} = openDocument(twoProfiles());

    assert.equal(model.nextFreeProfileName('third'), 'third');
    assert.equal(model.nextFreeProfileName('first'), 'first-2');
    model.duplicateProfile('first', 'first-2');
    assert.equal(model.nextFreeProfileName('first'), 'first-3');
  });
});

describe('proxies (reference: the proxy CRUD of model.py)', () => {
  test('a duplicate port is refused with the wording of the core', () => {
    const {model} = openDocument(twoProfiles());

    assert.throws(
      () => model.upsertProxy({tag: 'other', type: 'http', port: 54321}),
      (error) => error instanceof ConfigError && /дубль порта инбаунда: 54321/.test(error.message),
    );
  });

  test('editing a proxy does not conflict with itself', () => {
    const {model} = openDocument(twoProfiles());

    const error = model.validateProxyCandidate(
      {tag: 'main-socks', type: 'mixed', port: 54321},
      'main-socks',
    );

    assert.equal(error, null);
    model.upsertProxy({tag: 'main-socks', type: 'mixed', port: 54321}, 'main-socks');
    assert.deepEqual(model.getProxy('main-socks'), {tag: 'main-socks', type: 'mixed', port: 54321});
  });

  test('addProxy fills a free tag and port, servers and note are optional', () => {
    const {model} = openDocument(twoProfiles());

    const entry = model.addProxy();

    assert.deepEqual(entry, {tag: 'new-proxy', type: 'socks', port: 54322});
    assert.equal(model.dirty, true);
  });

  test('servers and note are written only when they carry something', () => {
    const {model} = openDocument(twoProfiles());

    model.upsertProxy(
      {tag: 'apps-http', type: 'http', port: 54323, servers: [FI_TAG, ''], note: 'primary'},
      null,
    );
    model.upsertProxy({tag: 'bare', type: 'socks', port: 54324, servers: [], note: ''}, null);

    assert.deepEqual(model.getProxy('apps-http').servers, [FI_TAG]);
    assert.equal(model.getProxy('apps-http').note, 'primary');
    assert.ok(!Object.hasOwn(model.getProxy('bare'), 'servers'));
    assert.ok(!Object.hasOwn(model.getProxy('bare'), 'note'));
  });

  test('rename and remove follow the reference rules', () => {
    const {model} = openDocument(twoProfiles());

    assert.equal(model.renameProxy('nope', 'main'), false, 'unknown source');
    assert.equal(model.renameProxy('main-socks', 'main-socks'), false, 'same name');
    model.upsertProxy({tag: 'taken', type: 'socks', port: 54323});
    assert.equal(model.renameProxy('main-socks', 'taken'), false, 'target is already there');

    assert.equal(model.renameProxy('main-socks', 'main'), true);
    assert.deepEqual(model.proxyTags(), ['main', 'taken']);
    assert.equal(model.removeProxy('nope'), false);
    assert.equal(model.removeProxy('main'), true);
    assert.deepEqual(model.proxyTags(), ['taken']);
  });

  test('nextFreePort and nextFreeTag step over what is taken', () => {
    const {model} = openDocument(twoProfiles());
    model.upsertProxy({tag: 'a', type: 'socks', port: 54322});

    assert.equal(model.nextFreePort(), 54323);
    assert.equal(model.nextFreeTag('a'), 'a-2');
    assert.equal(model.nextFreeTag('b'), 'b');
  });
});

describe('routes (reference: the route CRUD of model.py)', () => {
  test('add, rename and remove keep the order of the other routes', () => {
    const {model} = openDocument(twoProfiles());

    model.addRoute({name: 'youtube', outbound: 'auto-select', domains: ['googlevideo.com']});
    model.upsertRoute('yandex', {outbound: 'auto-select', domains: ['yandex.ru']}, null);
    model.renameRoute('youtube', 'video');

    assert.deepEqual(model.routeNames(), ['telegram', 'video', 'yandex']);

    model.removeRoute('video');
    assert.deepEqual(model.routeNames(), ['telegram', 'yandex']);
  });

  test('renaming through upsertRoute keeps the position', () => {
    const {model} = openDocument(twoProfiles());
    model.addRoute({name: 'second-route'});

    model.upsertRoute('renamed', {outbound: 'direct'}, 'second-route');

    assert.deepEqual(model.routeNames(), ['telegram', 'renamed']);
    assert.deepEqual(model.getRoute('renamed'), {outbound: 'direct'});
  });

  test('an empty outbound falls back to auto-select, empty domains are dropped', () => {
    const {model} = openDocument(twoProfiles());

    model.addRoute({name: 'plain', outbound: '', domains: ['', 'example.com', '']});

    assert.deepEqual(model.getRoute('plain'), {outbound: 'auto-select', domains: ['example.com']});
  });

  test('a digit-only route name and a duplicate are refused', () => {
    const {model} = openDocument(twoProfiles());

    assert.throws(
      () => model.addRoute({name: '1'}),
      (error) => error instanceof ConfigError && /только из цифр/.test(error.message),
    );
    assert.throws(
      () => model.addRoute({name: 'telegram'}),
      (error) => error instanceof ConfigError && /уже есть/.test(error.message),
    );
  });
});

describe('general settings, defaults and inheritance (NEW)', () => {
  test('a missing field is inherited from defaults and reported as such', () => {
    const {model} = openDocument({
      version: 1,
      active: 'a',
      defaults: {listen_ip: '10.95.2.1', urltest: {interval: '5m'}},
      profiles: {a: {links_file: 'links.txt', output_file: 'config.json'}},
    });

    const values = model.generalValues();

    assert.equal(values.listen_ip, '10.95.2.1');
    assert.equal(values.origins.listen_ip, 'defaults');
    assert.equal(model.fieldOrigin('exclude_from_auto').scope, 'absent');
  });

  test('a profile value wins and is reported as its own', () => {
    const {model} = openDocument({
      version: 1,
      active: 'a',
      defaults: {listen_ip: '10.95.2.1', urltest: {interval: '5m'}},
      profiles: {a: {listen_ip: '10.0.0.2'}},
    });

    assert.equal(model.generalValues().listen_ip, '10.0.0.2');
    assert.equal(model.generalValues().origins.listen_ip, 'profile');
    // urltest is inherited as a whole: the merge is top level only.
    assert.equal(model.generalValues().urltest.interval, '5m');
    assert.equal(model.generalValues().origins.urltest, 'defaults');
  });

  test('resetting a field removes it from the profile and nothing else', () => {
    const {model} = openDocument({
      version: 1,
      active: 'a',
      defaults: {listen_ip: '10.95.2.1'},
      profiles: {a: {listen_ip: '10.0.0.2'}},
    });

    assert.equal(model.resetProfileField('listen_ip'), true);
    assert.equal(model.listenIp, '10.95.2.1');
    assert.equal(model.resetProfileField('listen_ip'), false, 'nothing left to reset');
    assert.throws(
      () => model.resetProfileField('links_file'),
      (error) => error instanceof ConfigError && /не общее/.test(error.message),
    );
  });

  test('applyGeneral merges the nested blocks field by field', () => {
    const {model} = openDocument(twoProfiles());

    model.applyGeneral({
      listen_ip: '10.95.2.1',
      urltest: {interval: '5m'},
      log: {level: 'debug'},
      exclude_from_auto: ['🇷🇺', '🇩🇪'],
    });

    const profile = model.profileBody();
    assert.equal(profile.listen_ip, '10.95.2.1');
    assert.deepEqual(profile.urltest, {url: 'https://gstatic.com', interval: '5m', tolerance: 50});
    assert.deepEqual(profile.log, {level: 'debug', timestamp: true});
    assert.deepEqual(profile.exclude_from_auto, ['🇷🇺', '🇩🇪']);
  });

  test('applyDefaults writes only the shared keys', () => {
    const {model} = openDocument({
      version: 1,
      active: 'a',
      defaults: {proxies: [{tag: 'shared', type: 'socks', port: 55555}]},
      profiles: {a: {}},
    });

    model.applyDefaults({listen_ip: '10.95.2.1', exclude_from_auto: ['🇷🇺']});

    const defaults = model.defaultsBody();
    assert.equal(defaults.listen_ip, '10.95.2.1');
    assert.deepEqual(defaults.exclude_from_auto, ['🇷🇺']);
    assert.deepEqual(
      defaults.proxies,
      [{tag: 'shared', type: 'socks', port: 55555}],
      'a hand-written key the form does not know about stays untouched',
    );
    assert.deepEqual(Object.keys(defaults), ['proxies', 'listen_ip', 'exclude_from_auto']);
  });

  test('defaultsValues says which keys are set in defaults', () => {
    const {model} = openDocument({
      version: 1,
      active: 'a',
      defaults: {log: {level: 'warn'}},
      profiles: {a: {}},
    });

    const values = model.defaultsValues();

    assert.equal(values.log.level, 'warn');
    assert.deepEqual(values.present.log, true);
    assert.deepEqual(values.present.listen_ip, false);
    assert.equal(values.listen_ip, '127.0.0.1', 'an unset field shows the built-in default');
  });
});

describe('DNS as a JSON text field (NEW)', () => {
  test('the textarea shows the effective section and stores an object', () => {
    const {model} = openDocument({
      version: 1,
      active: 'a',
      defaults: {dns: {servers: [{type: 'local', tag: 'dns-local'}], final: 'dns-local'}},
      profiles: {a: {}},
    });

    assert.match(model.dnsJson(), /dns-local/);
    assert.equal(model.fieldOrigin('dns').scope, 'defaults');

    model.applyDns('{"servers": [], "final": "direct"}', 'profile');
    assert.equal(model.fieldOrigin('dns').scope, 'profile');
    assert.match(model.dnsJson('defaults'), /dns-local/, 'defaults are not touched');
  });

  test('only a valid JSON object is accepted', () => {
    const {model} = openDocument(twoProfiles());

    assert.throws(
      () => model.applyDns('{not json'),
      (error) => error instanceof ConfigError && /не валидный JSON/.test(error.message),
    );
    assert.throws(
      () => model.applyDns('[]'),
      (error) => error instanceof ConfigError && /ожидается JSON-объект/.test(error.message),
    );
    assert.throws(
      () => model.applyDns('"text"'),
      (error) => error instanceof ConfigError && /ожидается JSON-объект/.test(error.message),
    );
  });
});

describe('stale references and the tree', () => {
  test('a proxy with a missing server and a route with a bad outbound are marked', () => {
    const {dir, model} = openDocument({
      version: 1,
      active: 'a',
      defaults: {},
      profiles: {
        a: {
          links_file: 'links.txt',
          output_file: 'config.json',
          proxies: [{tag: 'main', type: 'socks', port: 54321, servers: ['🇩🇪 Germany - Berlin']}],
          routes: {telegram: {outbound: 'pool-gone', domains: ['t.me']}},
        },
      },
    });
    writeLinksFile(dir);

    const tree = model.treeSpec();
    const proxies = tree.children.find((child) => child.kind === 'proxies');
    const routes = tree.children.find((child) => child.kind === 'routes');

    assert.equal(proxies.children[0].stale, true);
    assert.match(proxies.children[0].mark, /нет в списке серверов: 🇩🇪 Germany - Berlin/);
    assert.equal(routes.children[0].stale, false, 'a pool- outbound is never stale');
    assert.deepEqual(model.staleMap().get(staleKey('proxies', 'main')), ['🇩🇪 Germany - Berlin']);
  });

  test('a route with an unknown outbound is a mark, not a save blocker', () => {
    const {dir, model} = openDocument({
      version: 1,
      active: 'a',
      defaults: {},
      profiles: {
        a: {
          links_file: 'links.txt',
          output_file: 'config.json',
          routes: {broken: {outbound: 'nope-tag', domains: ['example.com']}},
        },
      },
    });
    writeLinksFile(dir);

    const routes = model.treeSpec().children.find((child) => child.kind === 'routes');
    assert.equal(routes.children[0].stale, true);
    assert.match(routes.children[0].mark, /неизвестный outbound: nope-tag/);

    assert.doesNotThrow(() => model.save(), 'a stale reference is not a save error');
  });

  test('a missing links file marks the node instead of throwing', () => {
    const {model} = openDocument(twoProfiles());

    const info = model.linksInfo();
    assert.equal(info.exists, false);
    assert.match(info.error, /файл ссылок/);

    const links = model.treeSpec().children.find((child) => child.kind === 'links');
    assert.equal(links.stale, true);
    assert.equal(links.mark, '[!] файл не найден');
  });

  test('the tree has the nodes of the task, with profiles and defaults', () => {
    const {dir, model} = openDocument(twoProfiles());
    writeLinksFile(dir);

    const kinds = model.treeSpec().children.map((child) => child.kind);

    assert.deepEqual(kinds, [
      'profiles',
      'general',
      'defaults',
      'links',
      'output',
      'proxies',
      'routes',
      'dns',
      // Stage 3 added the host layer: check, restart, rollback, journal, tests.
      'system',
    ]);
    assert.match(model.treeSpec().children[0].title, /активен: first/);

    const system = model.treeSpec().children.find((child) => child.kind === 'system');
    assert.deepEqual(system.children.map((child) => child.kind), ['journal', 'tests']);
  });

  test('server tags come from the links file of the settings directory', () => {
    const {dir, model} = openDocument(twoProfiles());
    writeLinksFile(dir);

    const {tags, error} = model.loadServerTags();

    assert.equal(error, null);
    assert.deepEqual(tags, ALL_TAGS);
  });
});

describe('snapshots and atomic writes (NEW)', () => {
  test('every save preserves the previous version and keeps the last ten', () => {
    const {dir, file, stateDir, model} = openDocument(twoProfiles());
    const before = fs.readFileSync(file, 'utf8');

    model.applyGeneral({listen_ip: '10.0.0.1'});
    const first = model.save();

    assert.ok(first.snapshot !== null);
    assert.equal(fs.readFileSync(first.snapshot, 'utf8'), before, 'the snapshot is the previous bytes');

    for (let n = 2; n <= 12; n += 1) {
      model.applyGeneral({listen_ip: `10.0.0.${n}`});
      model.save();
    }

    const snapshots = listSnapshots(stateDir);
    assert.equal(snapshots.length, 10);
    assert.deepEqual(snapshots, [...snapshots].sort(), 'the newest ten survive, oldest first');
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
  });

  test('the snapshot keep count is configurable', () => {
    const dir = makeTempDir();
    const stateDir = path.join(dir, 'state');
    const file = writeSettings(dir);
    const model = new ProjectModel({path: file, stateDir, snapshotKeep: 2});

    for (let n = 1; n <= 4; n += 1) {
      model.applyGeneral({listen_ip: `10.0.0.${n}`});
      model.save();
    }

    assert.equal(listSnapshots(stateDir).length, 2);
  });

  test('the settings file is written with mode 0600', () => {
    const {file, model} = openDocument(twoProfiles());

    model.save();

    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});

describe('parity with the core (NEW)', () => {
  test('the effective settings match loadProfileSettings of the core', () => {
    const document = {
      version: 1,
      active: 'reality',
      defaults: {
        listen_ip: '10.95.2.1',
        urltest: {url: 'https://gstatic.com', interval: '3m', tolerance: 50},
        note: 'shared notes',
        dns: {servers: [], final: 'dns-local'},
      },
      profiles: {
        reality: {
          note: 'primary',
          links_file: 'links.txt',
          output_file: 'config.json',
          exclude_from_auto: ['🇷🇺'],
          proxies: [{tag: 'main', type: 'mixed', port: 54321, note: 'comment'}],
          routes: {telegram: {outbound: 'auto-select', domains: ['t.me']}},
        },
      },
    };
    const {dir, file, model} = openDocument(document);
    writeLinksFile(dir);

    const {settings, active} = loadProfileSettings(file);

    assert.equal(active, 'reality');
    assert.deepEqual(model.effectiveSettings(), settings);
  });

  test('formatStats repeats the wording of formatStats in the reference', () => {
    const stats = {
      servers: 3,
      inbounds: 2,
      pools: 1,
      auto_count: 2,
      excluded: ['🇷🇺 Russia - Moscow'],
      proxies: [
        {tag: 'main-socks', type: 'socks', port: 54321, servers: []},
        {tag: 'apps-http', type: 'http', port: 54323, servers: ['🇫🇮 Finland - Helsinki 1']},
      ],
      listen_ip: '127.0.0.1',
    };

    const text = formatStats('/tmp/config.json', stats, ['Предупреждение: тест']);

    assert.match(text, /Конфиг сгенерирован: \/tmp\/config.json/);
    assert.match(text, /Серверов: 3, инбаундов: 2, пулов: 1/);
    assert.match(text, /\[SOCKS\] main-socks : port 54321 -> auto-select/);
    assert.match(text, /\[HTTP\] apps-http : port 54323 -> 🇫🇮 Finland - Helsinki 1/);
    assert.match(text, /Исключены из auto-select \(1\): 🇷🇺 Russia - Moscow/);
    assert.match(text, /Предупреждение: тест/);
  });

  test('generation reports the reference summary and the dirty flag', () => {
    const {dir, settingsFile} = makeProject();
    const model = new ProjectModel({path: settingsFile, stateDir: path.join(dir, 'state')});

    const result = model.generate();

    assert.equal(result.outputFile, path.join(dir, 'config.json'));
    assert.ok(fs.existsSync(result.outputFile));
    assert.match(result.summary, /Серверов: 3, инбаундов: 2, пулов: 1/);
    assert.equal(result.wasDirty, false);
  });

  test('a new document is re-readable by the core', () => {
    const dir = makeTempDir();
    const stateDir = path.join(dir, 'state');
    writeLinksFile(dir);
    const model = new ProjectModel({stateDir});
    model.newProject(path.join(dir, 'webui.json'));
    model.document.profiles.default.proxies = [{tag: 'main', type: 'socks', port: 54321}];
    model.save();

    const loaded = new ProjectModel({path: path.join(dir, 'webui.json'), stateDir});

    assert.deepEqual(loaded.document, model.document);
    assert.equal(loaded.activeProfileName(), 'default');
  });
});

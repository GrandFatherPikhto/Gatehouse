// Model tests: everything that does not need a server.
//
// The behavioural reference is generator/model.py of the Python project, so the
// cases that come from there name it; the cases marked NEW cover what only
// exists in the web editor (the flat version-2 document, the one-time migration
// of the profile envelope, snapshots, the canonical format, the honest tree).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {ConfigError} from '../src/core/errors.mjs';
import {loadEffectiveSettings} from '../src/core/settings.mjs';
import {DOCUMENT_VERSION, ProjectModel, formatStats, migrateLegacyDocument} from '../src/model/project.mjs';
import {LABEL_NAMES_CAP, staleKey} from '../src/model/stale.mjs';
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
 * A minimal flat document: one proxy, one route, no profile envelope.
 *
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, unknown>}
 */
function flatDocument(overrides = {}) {
  return {
    version: DOCUMENT_VERSION,
    listen_ip: '127.0.0.1',
    providers: {vpnd: {enabled: true}},
    output_file: 'config.json',
    urltest: {url: 'https://gstatic.com', interval: '3m', tolerance: 50},
    log: {level: 'info', timestamp: true},
    dns: {servers: [], final: 'dns-local'},
    proxies: [{tag: 'main-socks', type: 'socks', port: 54321}],
    routes: {telegram: {outbound: 'auto-select', domains: ['t.me']}},
    ...overrides,
  };
}

/**
 * A version-1 document with the profile envelope.
 *
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, unknown>}
 */
function legacyDocument(overrides = {}) {
  return {
    version: 1,
    active: 'default',
    defaults: {},
    profiles: {
      default: {
        listen_ip: '127.0.0.1',
        providers: {vpnd: {enabled: true}},
        output_file: 'config.json',
        proxies: [{tag: 'main-socks', type: 'socks', port: 54321}],
        routes: {telegram: {outbound: 'auto-select', domains: ['t.me']}},
      },
    },
    ...overrides,
  };
}

describe('canonical format and round-trip (NEW)', () => {
  test('an untouched canonical file is saved byte for byte', () => {
    const {file, model} = openDocument(flatDocument());
    const before = fs.readFileSync(file);

    assert.equal(model.dirty, false);
    const result = model.save();

    assert.equal(result.path, file);
    assert.ok(fs.readFileSync(file).equals(before), 'the file must not change at all');
    assert.equal(model.dirty, false);
  });

  test('the canonical file ends with a newline and uses two spaces', () => {
    const {file, model} = openDocument(flatDocument());
    model.save();

    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.endsWith('\n'));
    assert.ok(text.includes('\n  "version": 2'));
    assert.equal(text, canonicalJson(flatDocument()));
  });

  test('a foreign formatting is canonicalised, and the second save is a no-op', () => {
    const document = flatDocument();
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

  test('a document with a digit-only route name is refused at load', () => {
    const document = flatDocument({routes: {'2024': {outbound: 'auto-select'}}});
    const dir = makeTempDir();
    const file = path.join(dir, 'webui.json');
    fs.writeFileSync(file, canonicalJson(document), 'utf8');

    assert.throws(
      () => new ProjectModel({path: file, stateDir: path.join(dir, 'state')}),
      (error) => error instanceof ConfigError && /routes/.test(error.message),
    );
  });
});

describe('dirty flag and file operations (reference: model.new/open/save)', () => {
  test('an edit marks the document dirty, a save marks it clean again', () => {
    const {model} = openDocument(flatDocument());

    model.applyGeneral({listen_ip: '10.95.2.1'});
    assert.equal(model.dirty, true);

    model.save();
    assert.equal(model.dirty, false);
  });

  test('reload drops unsaved changes', () => {
    const {file, model} = openDocument(flatDocument());
    model.applyGeneral({listen_ip: '10.95.2.1'});

    model.reload();

    assert.equal(model.listenIp, '127.0.0.1');
    assert.equal(model.dirty, false);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).listen_ip, '127.0.0.1');
  });

  test('a new project has the reference skeleton and no file', () => {
    const model = new ProjectModel({stateDir: makeTempDir()});
    const document = model.document;

    assert.equal(document.version, DOCUMENT_VERSION);
    assert.equal(document.listen_ip, '127.0.0.1');
    assert.deepEqual(document.providers, {});
    assert.deepEqual(document.proxies, []);
    assert.ok(!Object.hasOwn(document, 'profiles'));
    assert.ok(!Object.hasOwn(document, 'defaults'));
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
    const {file, model} = openDocument(flatDocument());
    const before = fs.readFileSync(file, 'utf8');
    model.body().proxies[0].type = 'socks5'; // not in PROXY_TYPES

    assert.throws(() => model.save(), (error) => error instanceof ConfigError);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'the broken edit never reaches the disk');
  });
});

describe('migration of the version-1 envelope (NEW)', () => {
  test('a single profile is flattened silently and the file is rewritten', () => {
    const legacy = legacyDocument();
    const dir = makeTempDir();
    const stateDir = path.join(dir, 'state');
    const file = path.join(dir, 'webui.json');
    fs.writeFileSync(file, canonicalJson(legacy), 'utf8');

    const model = new ProjectModel({path: file, stateDir});

    assert.equal(model.document.version, DOCUMENT_VERSION);
    assert.ok(!Object.hasOwn(model.document, 'profiles'));
    assert.ok(!Object.hasOwn(model.document, 'defaults'));
    assert.ok(!Object.hasOwn(model.document, 'active'));
    assert.deepEqual(model.document.proxies, [{tag: 'main-socks', type: 'socks', port: 54321}]);
    assert.deepEqual(model.lastMigration.warnings, []);
    assert.ok(model.lastMigration.snapshot !== null, 'the previous version was snapshotted');
    assert.equal(
      fs.readFileSync(model.lastMigration.snapshot, 'utf8'),
      canonicalJson(legacy),
      'the snapshot holds the old bytes',
    );
    assert.equal(fs.readFileSync(file, 'utf8'), canonicalJson(model.document));
  });

  test('a non-empty defaults is merged under the profile, with a warning per key', () => {
    const legacy = legacyDocument({
      defaults: {listen_ip: '10.95.2.1', log: {level: 'warn'}},
      profiles: {
        default: {
          listen_ip: '10.0.0.2',
          providers: {vpnd: {enabled: true}},
          output_file: 'config.json',
          proxies: [{tag: 'main-socks', type: 'socks', port: 54321}],
        },
      },
    });
    const dir = makeTempDir();
    const file = path.join(dir, 'webui.json');
    fs.writeFileSync(file, canonicalJson(legacy), 'utf8');

    const model = new ProjectModel({path: file, stateDir: path.join(dir, 'state')});

    assert.equal(model.document.listen_ip, '10.0.0.2', 'the profile wins');
    assert.deepEqual(model.document.log, {level: 'warn'}, 'the unset key is taken from defaults');
    assert.equal(model.lastMigration.warnings.length, 2);
    assert.ok(model.lastMigration.warnings.some((warning) => /'listen_ip'/.test(warning)));
    assert.ok(model.lastMigration.warnings.some((warning) => /перекрыт/.test(warning)));
    assert.ok(model.lastMigration.warnings.some((warning) => /'log'/.test(warning)));
  });

  test('two profiles are refused with their names, never guessed', () => {
    const legacy = legacyDocument({
      profiles: {first: {listen_ip: '127.0.0.1'}, second: {listen_ip: '10.0.0.2'}},
    });
    const dir = makeTempDir();
    const file = path.join(dir, 'webui.json');
    fs.writeFileSync(file, canonicalJson(legacy), 'utf8');

    assert.throws(
      () => new ProjectModel({path: file, stateDir: path.join(dir, 'state')}),
      (error) =>
        error instanceof ConfigError &&
        /несколько профилей/.test(error.message) &&
        /first, second/.test(error.message),
    );
    assert.equal(fs.readFileSync(file, 'utf8'), canonicalJson(legacy), 'the file is untouched');
  });

  test('a migrated file is schema-valid and re-opens without a second migration', () => {
    const {file, model} = openDocument(legacyDocument());

    const reopened = new ProjectModel({path: file, stateDir: path.join(makeTempDir(), 'state')});

    assert.equal(reopened.lastMigration, null);
    assert.deepEqual(reopened.document, model.document);
  });

  test('a version-1 links_file enables every folder that holds links', () => {
    const legacy = {
      version: 1,
      active: 'default',
      defaults: {},
      profiles: {
        default: {
          listen_ip: '127.0.0.1',
          links_file: 'sources/vpnd/links.txt',
          output_file: 'config.json',
          proxies: [{tag: 'main-socks', type: 'socks', port: 54321}],
          routes: {},
        },
      },
    };
    const dir = makeTempDir();
    writeLinksFile(dir);
    const file = path.join(dir, 'webui.json');
    fs.writeFileSync(file, canonicalJson(legacy), 'utf8');

    const model = new ProjectModel({path: file, stateDir: path.join(dir, 'state')});

    assert.deepEqual(model.document.providers, {vpnd: {enabled: true}});
    assert.ok(!Object.hasOwn(model.document, 'links_file'));
    assert.ok(model.lastMigration.warnings.some((warning) => /links_file/.test(warning)));
    assert.ok(
      model.lastMigration.warnings.some((warning) =>
        /включены найденные провайдеры: vpnd/.test(warning),
      ),
    );
  });

  test('migrateLegacyDocument refuses a document without profiles', () => {
    assert.throws(
      () => migrateLegacyDocument({version: 1, active: 'a', defaults: {}, profiles: {}}),
      (error) => error instanceof ConfigError && /без профилей/.test(error.message),
    );
  });
});

describe('proxies (reference: the proxy CRUD of model.py)', () => {
  test('a duplicate port is refused with the wording of the core', () => {
    const {model} = openDocument(flatDocument());

    assert.throws(
      () => model.upsertProxy({tag: 'other', type: 'http', port: 54321}),
      (error) => error instanceof ConfigError && /дубль порта инбаунда: 54321/.test(error.message),
    );
  });

  test('editing a proxy does not conflict with itself', () => {
    const {model} = openDocument(flatDocument());

    const error = model.validateProxyCandidate(
      {tag: 'main-socks', type: 'mixed', port: 54321},
      'main-socks',
    );

    assert.equal(error, null);
    model.upsertProxy({tag: 'main-socks', type: 'mixed', port: 54321}, 'main-socks');
    assert.deepEqual(model.getProxy('main-socks'), {tag: 'main-socks', type: 'mixed', port: 54321});
  });

  test('addProxy fills a free tag and port, servers and note are optional', () => {
    const {model} = openDocument(flatDocument());

    const entry = model.addProxy();

    assert.deepEqual(entry, {tag: 'new-proxy', type: 'socks', port: 54322});
    assert.equal(model.dirty, true);
  });

  test('servers and note are written only when they carry something', () => {
    const {model} = openDocument(flatDocument());

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
    const {model} = openDocument(flatDocument());

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
    const {model} = openDocument(flatDocument());
    model.upsertProxy({tag: 'a', type: 'socks', port: 54322});

    assert.equal(model.nextFreePort(), 54323);
    assert.equal(model.nextFreeTag('a'), 'a-2');
    assert.equal(model.nextFreeTag('b'), 'b');
  });

  test('a pinned proxy may not end up with a pool', () => {
    const {model} = openDocument(flatDocument());

    assert.throws(
      () => model.upsertProxy({tag: 'pinned', type: 'socks', port: 54324, servers: [FI_TAG, 'x'], pinned: true}),
      (error) => error instanceof ConfigError && /зафиксирован выход/.test(error.message),
    );
  });
});

describe('routes (reference: the route CRUD of model.py)', () => {
  test('add, rename and remove keep the order of the other routes', () => {
    const {model} = openDocument(flatDocument());

    model.addRoute({name: 'youtube', outbound: 'auto-select', domains: ['googlevideo.com']});
    model.upsertRoute('yandex', {outbound: 'auto-select', domains: ['yandex.ru']}, null);
    model.renameRoute('youtube', 'video');

    assert.deepEqual(model.routeNames(), ['telegram', 'video', 'yandex']);

    model.removeRoute('video');
    assert.deepEqual(model.routeNames(), ['telegram', 'yandex']);
  });

  test('renaming through upsertRoute keeps the position', () => {
    const {model} = openDocument(flatDocument());
    model.addRoute({name: 'second-route'});

    model.upsertRoute('renamed', {outbound: 'direct'}, 'second-route');

    assert.deepEqual(model.routeNames(), ['telegram', 'renamed']);
    assert.deepEqual(model.getRoute('renamed'), {outbound: 'direct'});
  });

  test('an empty outbound falls back to auto-select, empty domains are dropped', () => {
    const {model} = openDocument(flatDocument());

    model.addRoute({name: 'plain', outbound: '', domains: ['', 'example.com', '']});

    assert.deepEqual(model.getRoute('plain'), {outbound: 'auto-select', domains: ['example.com']});
  });

  test('a digit-only route name and a duplicate are refused', () => {
    const {model} = openDocument(flatDocument());

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

describe('general settings (NEW)', () => {
  test('applyGeneral merges the nested blocks field by field', () => {
    const {model} = openDocument(flatDocument());

    model.applyGeneral({
      listen_ip: '10.95.2.1',
      urltest: {interval: '5m'},
      log: {level: 'debug'},
      exclude_from_auto: ['🇷🇺', '🇩🇪'],
    });

    const body = model.body();
    assert.equal(body.listen_ip, '10.95.2.1');
    assert.deepEqual(body.urltest, {url: 'https://gstatic.com', interval: '5m', tolerance: 50});
    assert.deepEqual(body.log, {level: 'debug', timestamp: true});
    assert.deepEqual(body.exclude_from_auto, ['🇷🇺', '🇩🇪']);
  });

  test('generalValues fills the built-in defaults for an unset field', () => {
    const {model} = openDocument(flatDocument({listen_ip: undefined, log: undefined}));

    const values = model.generalValues();

    assert.equal(values.listen_ip, '127.0.0.1');
    assert.equal(values.log.level, 'info');
    assert.equal(values.urltest.interval, '3m');
  });
});

describe('DNS as a JSON text field (NEW)', () => {
  test('the textarea shows the section and stores an object', () => {
    const {model} = openDocument(
      flatDocument({dns: {servers: [{type: 'local', tag: 'dns-local'}], final: 'dns-local'}}),
    );

    assert.match(model.dnsJson(), /dns-local/);

    model.applyDns('{"servers": [], "final": "direct"}');
    assert.deepEqual(model.body().dns, {servers: [], final: 'direct'});
  });

  test('only a valid JSON object is accepted', () => {
    const {model} = openDocument(flatDocument());

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
    const {dir, model} = openDocument(
      flatDocument({
        proxies: [{tag: 'main', type: 'socks', port: 54321, servers: ['🇩🇪 Germany - Berlin']}],
        routes: {telegram: {outbound: 'pool-gone', domains: ['t.me']}},
      }),
    );
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
    const {dir, model} = openDocument(
      flatDocument({routes: {broken: {outbound: 'nope-tag', domains: ['example.com']}}}),
    );
    writeLinksFile(dir);

    const routes = model.treeSpec().children.find((child) => child.kind === 'routes');
    assert.equal(routes.children[0].stale, true);
    assert.match(routes.children[0].mark, /неизвестный outbound: nope-tag/);

    assert.doesNotThrow(() => model.save(), 'a stale reference is not a save error');
  });

  test('a provider record without a folder is reported, not thrown', () => {
    const {dir, model} = openDocument(flatDocument({providers: {ghost: {enabled: true}}}));
    fs.mkdirSync(path.join(dir, 'providers'), {recursive: true});

    const info = model.providersInfo();
    assert.deepEqual(info.providers, []);
    assert.equal(info.unread[0].id, 'ghost');
    assert.equal(info.unread[0].state, 'missing');

    assert.doesNotThrow(() => model.treeSpec());
    assert.doesNotThrow(() => model.save());
  });

  test('the tree has the nodes of the task, flat since version 2', () => {
    const {dir, model} = openDocument(flatDocument());
    writeLinksFile(dir);

    const kinds = model.treeSpec().children.map((child) => child.kind);

    assert.deepEqual(kinds, ['providers', 'settings', 'proxies', 'routes', 'system']);
    assert.ok(!kinds.includes('profiles'));
    assert.ok(!kinds.includes('links'));

    // «Настройки» is a GROUP: it has no page, only the two child panels.
    const settings = model.treeSpec().children.find((child) => child.kind === 'settings');
    assert.deepEqual(settings.children.map((child) => child.kind), ['singbox', 'amnezia']);
    assert.equal(settings.group, true);

    // «Система» is a GROUP like «Настройки»: no page of its own, two child nodes.
    // The journal, the server test and the watchdog live INSIDE the sing-box child
    // (`system:singbox`), not as tree nodes of their own.
    const system = model.treeSpec().children.find((child) => child.kind === 'system');
    assert.equal(system.group, true);
    assert.deepEqual(
      system.children.map((child) => [child.key, child.title]),
      [
        ['system:singbox', 'Sing-Box'],
        ['system:amnezia', 'Amnezia'],
      ],
    );
  });

  test('server tags come from the links file of the settings directory', () => {
    const {dir, model} = openDocument(flatDocument());
    writeLinksFile(dir);

    const {tags, error} = model.loadServerTags();

    assert.equal(error, null);
    assert.deepEqual(tags, ALL_TAGS);
  });
});

describe('honest tree labels: the cap and the provider diagnoses (NEW)', () => {
  /**
   * @param {import('../src/model/project.mjs').ProjectModel} model
   * @param {string} name
   * @returns {Record<string, unknown>}
   */
  function providerNode(model, name) {
    const providers = model.treeSpec().children.find((child) => child.kind === 'providers');
    const provider = providers.children.find((child) => child.detail === name);
    assert.ok(provider, `provider '${name}' must be rendered`);
    return provider;
  }

  test('twenty missing servers give three names, a count and a full tooltip', () => {
    const missing = Array.from({length: 20}, (_, index) => `Server-${index + 1}`);
    const {dir, model} = openDocument(
      flatDocument({proxies: [{tag: 'main', type: 'socks', port: 54321, servers: missing}]}),
    );
    writeLinksFile(dir);

    const proxyNode = model
      .treeSpec()
      .children.find((child) => child.kind === 'proxies')
      .children[0];

    assert.equal(LABEL_NAMES_CAP, 3);
    assert.ok(proxyNode.mark.startsWith('[!] нет в списке серверов: 20 — '));
    assert.equal(proxyNode.mark.match(/Server-\d+/g).length, 3, 'only three names in the label');
    assert.ok(proxyNode.mark.endsWith('…'));
    for (const name of missing) {
      assert.ok(proxyNode.full.includes(name), 'the full list stays available');
    }
  });

  test('a found but disabled provider is a tree node marked выключен', () => {
    const {dir, model} = openDocument(flatDocument({providers: {vpnd: {enabled: false}}}));
    writeLinksFile(dir);

    assert.equal(model.providersInfo().providers[0].state, 'ok');
    const provider = providerNode(model, 'vpnd');
    assert.equal(provider.stale, false, 'a read folder is not an error in itself');
    assert.match(provider.mark, /\[выключен\]/);
  });

  test('a provider record whose folder is gone is unread, not a tree node', () => {
    const {dir, model} = openDocument(flatDocument({providers: {ghost: {enabled: true}}}));
    fs.mkdirSync(path.join(dir, 'providers'), {recursive: true});

    const info = model.providersInfo();
    assert.deepEqual(info.providers, []);
    assert.equal(info.unread[0].id, 'ghost');
    assert.equal(info.unread[0].state, 'missing');
    assert.equal(info.unread[0].forget, true);

    const providers = model.treeSpec().children.find((child) => child.kind === 'providers');
    assert.equal(providers.stale, true);
    assert.match(providers.mark, /не прочиталось: 1/);
    assert.deepEqual(providers.children, []);
  });

  test('a links.txt that is a directory leaves the folder empty, not readable', () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, 'providers', 'vpnd', 'links.txt'), {recursive: true});
    const file = path.join(dir, 'webui.json');
    fs.writeFileSync(file, canonicalJson(flatDocument()), 'utf8');
    const model = new ProjectModel({path: file, stateDir: path.join(dir, 'state')});

    const info = model.providersInfo();
    assert.deepEqual(info.providers, []);
    assert.equal(info.unread[0].id, 'vpnd');
    assert.equal(info.unread[0].state, 'empty');
  });

  test('an empty links file is diagnosed as empty', () => {
    const dir = makeTempDir();
    writeLinksFile(dir, '');
    const file = path.join(dir, 'webui.json');
    fs.writeFileSync(file, canonicalJson(flatDocument()), 'utf8');
    const model = new ProjectModel({path: file, stateDir: path.join(dir, 'state')});

    const info = model.providersInfo();
    assert.deepEqual(info.providers, []);
    assert.equal(info.unread[0].state, 'empty');
    assert.match(info.unread[0].error, /валидных VLESS-ссылок/);
  });

  test('no found provider marks the providers node', () => {
    const {model} = openDocument(flatDocument({providers: {}}));
    const providers = model.treeSpec().children.find((child) => child.kind === 'providers');
    assert.equal(providers.stale, true);
    assert.match(providers.mark, /провайдеры не найдены/);
  });

  test('a read folder that misses names keeps the per-proxy fourth message', () => {
    const {dir, model} = openDocument(
      flatDocument({
        proxies: [
          {
            tag: 'main',
            type: 'socks',
            port: 54321,
            servers: [ALL_TAGS[0], 'Gone-1', 'Gone-2'],
          },
        ],
      }),
    );
    writeLinksFile(dir);

    assert.equal(model.providersInfo().providers[0].state, 'ok');
    const providers = model.treeSpec().children.find((child) => child.kind === 'providers');
    assert.equal(providers.stale, false, 'a read folder is not an error in itself');

    const proxyNode = model
      .treeSpec()
      .children.find((child) => child.kind === 'proxies')
      .children[0];
    assert.match(proxyNode.mark, /нет в списке серверов: Gone-1, Gone-2/);
  });
});

describe('snapshots and atomic writes (NEW)', () => {
  test('every save preserves the previous version and keeps the last ten', () => {
    const {dir, file, stateDir, model} = openDocument(flatDocument());
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
    const {file, model} = openDocument(flatDocument());

    model.save();

    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});

describe('parity with the core (NEW)', () => {
  test('the effective settings match loadEffectiveSettings of the core', () => {
    const document = flatDocument({
      note: 'primary',
      dns: {servers: [], final: 'dns-local'},
      exclude_from_auto: ['🇷🇺'],
      proxies: [{tag: 'main', type: 'mixed', port: 54321, note: 'comment'}],
    });
    const {dir, file, model} = openDocument(document);
    writeLinksFile(dir);

    const {settings} = loadEffectiveSettings(file);

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

    assert.match(text, /Конфиг сгенерирован: \/tmp\/config\.json/);
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
    model.document.proxies = [{tag: 'main', type: 'socks', port: 54321}];
    model.save();

    const loaded = new ProjectModel({path: path.join(dir, 'webui.json'), stateDir});

    assert.deepEqual(loaded.document, model.document);
    assert.equal(loaded.document.version, DOCUMENT_VERSION);
  });
});

describe('migration of the sources field into providers (NEW)', () => {
  test('string entries enable exactly those provider folders', () => {
    const dir = makeTempDir();
    writeLinksFile(dir);
    const file = path.join(dir, 'webui.json');
    fs.writeFileSync(file, canonicalJson(flatDocument({sources: ['vpnd']})), 'utf8');

    const model = new ProjectModel({path: file, stateDir: path.join(dir, 'state')});

    assert.ok(!Object.hasOwn(model.document, 'sources'), 'the field is gone from the document');
    assert.deepEqual(model.document.providers, {vpnd: {enabled: true}});
    assert.match(model.providersMigrationNotice, /поле sources заменено на providers/);
    assert.equal(model.providersInfo().providers[0].kind, 'links');
    assert.doesNotThrow(() => model.save(), 'the migrated document passes the schema');
  });

  test('an entry whose stored path is outside the root is not silently accepted', () => {
    const dir = makeTempDir();
    writeLinksFile(dir);
    const file = path.join(dir, 'webui.json');
    fs.writeFileSync(
      file,
      canonicalJson(
        flatDocument({
          sources: [
            {kind: 'links', name: 'vpnd', path: path.join(dir, 'sources', 'vpnd', 'links.txt')},
          ],
        }),
      ),
      'utf8',
    );

    const model = new ProjectModel({path: file, stateDir: path.join(dir, 'state')});

    assert.deepEqual(model.document.providers, {vpnd: {enabled: true}});
    assert.match(model.providersMigrationNotice, /перенесите/);
  });

  test('enabling, naming and forgetting a provider go through the record', () => {
    const dir = makeTempDir();
    const links = writeLinksFile(dir);
    const tunnels = path.join(dir, 'providers', 'hidemyname');
    fs.mkdirSync(tunnels, {recursive: true});
    fs.writeFileSync(path.join(tunnels, 'de.conf'), 'x', 'utf8');
    const file = path.join(dir, 'webui.json');
    fs.writeFileSync(file, canonicalJson(flatDocument({providers: {}})), 'utf8');
    const model = new ProjectModel({path: file, stateDir: path.join(dir, 'state')});

    model.setProviderEnabled('vpnd', true);
    assert.deepEqual(model.getProvider('vpnd'), {enabled: true});
    assert.ok(fs.existsSync(links), "the owner's links file is untouched");

    model.setProviderLabel('vpnd', 'Directly');
    assert.deepEqual(model.getProvider('vpnd'), {enabled: true, label: 'Directly'});
    assert.throws(
      () => model.setProviderLabel('vpnd', 'a\u0000b'),
      (error) => error instanceof ConfigError && /управляющих символов/.test(error.message),
    );
    assert.throws(
      () => model.setProviderEnabled('bad name', true),
      (error) => error instanceof ConfigError && /не подходит для идентификатора/.test(error.message),
    );

    // A record whose folder is gone may be forgotten; a folder on disk may not.
    assert.throws(
      () => model.forgetProvider('vpnd'),
      (error) => error instanceof ConfigError && /найден на диске/.test(error.message),
    );
    model.setProviderEnabled('ghost', true);
    model.forgetProvider('ghost');
    assert.equal(model.getProvider('ghost'), null);
  });
});

// Task 20: EVERY folder that exists on disk is a tree node with a panel, and its
// kind can always be changed from the interface.
//
// The first test is the router case of 02.10 verbatim: a folder recorded as a
// «Подписка» that holds only `xray-configs.json`. Before this task the folder was
// «unread», unread entries were NOT tree nodes, and the kind could only be fixed
// by hand-editing `webui.json`.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {generateConfigFile} from '../src/core/settings.mjs';
import {startServer} from '../src/web/server.mjs';
import {
  DEFAULT_LINKS,
  FAKE_BIN_DIR,
  FIXTURES_DIR,
  fakeSystemEnv,
  makeTempDir,
  writeSettings,
} from './helpers.mjs';

const XRAY_FIXTURE = path.join(FIXTURES_DIR, 'providers-xray', 'stash', 'xray-configs.json');
const XRAY_BIN = path.join(FAKE_BIN_DIR, 'xray');

/** Reason to skip a permissions test, or `false` to run it. */
const ROOT_SKIP =
  typeof process.getuid === 'function' && process.getuid() === 0
    ? 'запущено от root: права не действуют'
    : false;

function post(base, route, fields = {}) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded', 'HX-Request': 'true'},
    body: new URLSearchParams(fields),
  });
}

/**
 * A temp project served by the real web layer.
 *
 * @param {{folders?: Record<string, Record<string, string|Buffer>>,
 *   emptyFolder?: string, deniedFolder?: string,
 *   providers?: Record<string, unknown>}} [options] `folders` are written before
 *   the server starts, `deniedFolder` is chmod 000 after its `links.txt` is in
 *   place.
 */
async function startEditor(options = {}) {
  const dir = makeTempDir();
  const providersRoot = path.join(dir, 'providers');
  fs.mkdirSync(providersRoot, {recursive: true});

  for (const [id, files] of Object.entries(options.folders ?? {})) {
    const folder = path.join(providersRoot, id);
    fs.mkdirSync(folder, {recursive: true});
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(folder, name), content);
    }
  }
  if (options.emptyFolder !== undefined) {
    fs.mkdirSync(path.join(providersRoot, options.emptyFolder), {recursive: true});
  }
  if (options.deniedFolder !== undefined) {
    const target = path.join(providersRoot, options.deniedFolder);
    fs.mkdirSync(target, {recursive: true});
    fs.writeFileSync(path.join(target, 'links.txt'), DEFAULT_LINKS, 'utf8');
    fs.chmodSync(target, 0o000);
  }

  const settingsFile = writeSettings(dir, {
    providers: options.providers ?? {},
    proxies: options.proxies ?? [{tag: 'main', type: 'mixed', port: 54321, servers: []}],
  });

  const env = {
    ...fakeSystemEnv({
      GATEHOUSE_XRAY: options.xrayBinary ?? XRAY_BIN,
      GATEHOUSE_XRAY_CONFIG: path.join(dir, 'etc', 'xray', 'config.json'),
      GATEHOUSE_XRAY_UNIT: 'xray',
      FAKE_SYSTEMCTL_ACTIVE: 'xray',
    }),
    GATEHOUSE_PROVIDERS: providersRoot,
    GATEHOUSE_SETTINGS: settingsFile,
    GATEHOUSE_STATE_DIR: path.join(dir, 'state'),
    GATEHOUSE_CONFIG: path.join(dir, 'config.json'),
    GATEHOUSE_HOST: '127.0.0.1',
    GATEHOUSE_PORT: '0',
  };

  const {server, model, url} = await startServer({env});
  return {
    dir,
    providersRoot,
    settingsFile,
    model,
    base: url.replace(/\/$/, ''),
    async close() {
      if (options.deniedFolder !== undefined) {
        fs.chmodSync(path.join(providersRoot, options.deniedFolder), 0o700);
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * First node of the given kind in the tree, or `null`.
 *
 * @param {Record<string, unknown>} root
 * @param {string} kind
 * @returns {Record<string, unknown>|null}
 */
function findNode(root, kind) {
  if (root.kind === kind) return root;
  for (const child of root.children ?? []) {
    const found = findNode(child, kind);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Every node of the given kind in the tree.
 *
 * @param {Record<string, unknown>} root
 * @param {string} kind
 * @returns {Array<Record<string, unknown>>}
 */
function findAll(root, kind) {
  const nodes = root.kind === kind ? [root] : [];
  for (const child of root.children ?? []) nodes.push(...findAll(child, kind));
  return nodes;
}

describe('the router case: «Подписка» over a folder holding only xray-configs.json (task 20 §1, §2)', () => {
  test('is a tree node with a panel, and the kind is switched from it', async () => {
    const editor = await startEditor({
      folders: {stash: {'xray-configs.json': fs.readFileSync(XRAY_FIXTURE)}},
      providers: {stash: {kind: 'subscription', suffix: 'stash', enabled: false}},
    });
    try {
      const tree = editor.model.treeSpec();
      const subscriptions = findNode(tree, 'subscriptions');
      assert.equal(subscriptions.children.length, 1);
      assert.equal(subscriptions.children[0].detail, 'stash');
      // The label is the SHORT diagnosis, not a path (task 20 §1.3).
      assert.match(subscriptions.children[0].mark, /\[!\] нет links\.txt/);

      // A folder on disk is never «unread» (task 20 §1).
      assert.deepEqual(editor.model.providersInfo().unread, []);

      // The panel opens and names the kind that fits the content.
      const response = await fetch(`${editor.base}/panel/provider:stash`);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /Вид — «подписка», но в папке нет links\.txt/);
      assert.match(html, /Похоже на «конфиги Xray»/);
      assert.match(html, /Сменить вид на «конфиги Xray»/);

      // The button switches the kind, and the servers are read right away.
      const switched = await (
        await post(editor.base, '/provider/kind', {
          id: 'stash',
          kind: 'xray',
          from: 'provider:stash',
        })
      ).text();
      assert.equal(editor.model.getProvider('stash').kind, 'xray');
      assert.match(switched, /задан вид папки/);
      const after = editor.model.providersInfo().providers.find((item) => item.id === 'stash');
      assert.equal(after.kind, 'xray');
      assert.equal(after.state, 'ok');
      assert.equal(after.tags.length, 8);

      // Enabling then building gives one socks outbound per Xray server.
      await post(editor.base, '/provider', {
        id: 'stash',
        kind: 'xray',
        suffix: 'stash',
        enabled: '1',
      });
      await post(editor.base, '/save', {panel: 'provider:stash'});
      const {config} = generateConfigFile(editor.settingsFile, {
        providersRoot: editor.providersRoot,
        output: path.join(editor.dir, 'out.json'),
      });
      assert.equal(config.outbounds.filter((outbound) => outbound.type === 'socks').length, 8);
    } finally {
      await editor.close();
    }
  });

  test('enabled: the field is unavailable, and the escape takes two steps on the same panel (§2.1)', async () => {
    const editor = await startEditor({
      folders: {stash: {'xray-configs.json': fs.readFileSync(XRAY_FIXTURE)}},
      providers: {stash: {kind: 'subscription', enabled: true}},
    });
    try {
      const html = await (await fetch(`${editor.base}/panel/provider:stash`)).text();
      assert.doesNotMatch(html, /name="kind"/, 'no kind selector while it is on');
      assert.match(html, /чтобы сменить вид, выключите провайдера/);
      assert.match(html, /Чтобы сменить вид, снимите галочку «включён» ниже/);
      assert.doesNotMatch(html, /Сменить вид на «/, 'no button while it is on');

      // Step 1: turn it off on the same panel.
      await post(editor.base, '/provider', {id: 'stash', label: '', enabled: ''});
      assert.equal(editor.model.getProvider('stash').enabled, false);

      // Step 2: the kind is now changeable — from the interface, not the file.
      const off = await (await fetch(`${editor.base}/panel/provider:stash`)).text();
      assert.match(off, /name="kind"/);
      assert.match(off, /Сменить вид на «конфиги Xray»/);
      await post(editor.base, '/provider/kind', {
        id: 'stash',
        kind: 'xray',
        from: 'provider:stash',
      });
      assert.equal(editor.model.getProvider('stash').kind, 'xray');
    } finally {
      await editor.close();
    }
  });
});

describe('a folder in any state keeps a node and a panel (task 20 §1, §3)', () => {
  test('an empty folder with a kind is a node marked пусто, and its panel opens', async () => {
    const editor = await startEditor({
      folders: {empty: {}},
      providers: {empty: {kind: 'subscription'}},
    });
    try {
      const tree = editor.model.treeSpec();
      const node = findAll(tree, 'provider').find((item) => item.detail === 'empty');
      assert.ok(node, 'the empty folder is a tree node');
      assert.match(node.mark, /\[!\] нет links\.txt/);

      const html = await (await fetch(`${editor.base}/panel/provider:empty`)).text();
      assert.match(html, /но в папке нет links\.txt/);
      assert.match(html, /В папке: пусто/);
      assert.match(html, /Выберите вид, который подходит содержимому/);
      assert.match(html, /name="kind"/);
    } finally {
      await editor.close();
    }
  });

  test('a broken xray-configs.json is a node marked not readable, and its panel opens', async () => {
    const editor = await startEditor({
      folders: {bad: {'xray-configs.json': '{ not json'}},
      providers: {bad: {kind: 'xray'}},
    });
    try {
      const tree = editor.model.treeSpec();
      const node = findAll(tree, 'provider').find((item) => item.detail === 'bad');
      assert.ok(node, 'the folder with a broken file is a tree node');
      // The provider is disabled in this project, so its own mark comes first.
      assert.match(node.mark, /\[!\] файл не читается/);

      const html = await (await fetch(`${editor.base}/panel/provider:bad`)).text();
      assert.match(html, /файл не читается/);
      assert.match(html, /name="kind"/);
    } finally {
      await editor.close();
    }
  });

  test('a folder without access is a node marked нет доступа, with the fix command', {skip: ROOT_SKIP}, async () => {
    const editor = await startEditor({
      deniedFolder: 'secret',
      providers: {secret: {kind: 'subscription'}},
    });
    try {
      const info = editor.model.providersInfo();
      assert.equal(info.providers[0].state, 'denied');
      // Only missing records and inaccessible folders count as «не прочиталось».
      const outputs = findNode(editor.model.treeSpec(), 'outputs');
      assert.match(outputs.mark, /не прочиталось: 1/);

      const node = findAll(editor.model.treeSpec(), 'provider').find(
        (item) => item.detail === 'secret',
      );
      assert.ok(node, 'the inaccessible folder is a tree node');
      assert.match(node.mark, /\[!\] нет доступа/);

      const html = await (await fetch(`${editor.base}/panel/provider:secret`)).text();
      assert.match(html, /нет доступа к папке/);
      assert.match(html, /chown /);
      assert.match(html, /chmod 750/);
    } finally {
      await editor.close();
    }
  });

  test('a missing folder is NOT a node: the row keeps «Забыть» (task 20 §1.2)', async () => {
    const editor = await startEditor({providers: {ghost: {enabled: true}}});
    try {
      const info = editor.model.providersInfo();
      assert.deepEqual(info.providers, []);
      assert.equal(info.unread[0].id, 'ghost');
      assert.equal(info.unread[0].state, 'missing');
      assert.equal(findNode(editor.model.treeSpec(), 'provider'), null);

      const html = await (await fetch(`${editor.base}/panel/providers`)).text();
      assert.match(html, /Забыть/);
      assert.match(html, /папки нет/);
    } finally {
      await editor.close();
    }
  });
});

describe('a mixed folder says what it holds (task 20 §3)', () => {
  test('lists every source with its numbers and never suggests one kind', async () => {
    const editor = await startEditor({
      folders: {
        mix: {'links.txt': DEFAULT_LINKS, 'xray-configs.json': fs.readFileSync(XRAY_FIXTURE)},
      },
      providers: {},
    });
    try {
      const info = editor.model.providersInfo();
      const mix = info.providers.find((item) => item.id === 'mix');
      assert.equal(mix.contentKind, 'mixed');
      assert.equal(mix.kind, null);
      assert.match(mix.hint, /смешанная папка/);
      assert.match(mix.hint, /links\.txt \(3 ссылки\)/);
      assert.match(mix.hint, /xray-configs\.json \(3 конфига, 8 серверов\)/);
      assert.match(mix.hint, /разнесите по разным папкам/);

      const node = findAll(editor.model.treeSpec(), 'provider').find(
        (item) => item.detail === 'mix',
      );
      assert.equal(node.stale, true, 'a mixed folder is marked in the tree');

      const html = await (await fetch(`${editor.base}/panel/provider:mix`)).text();
      assert.match(html, /смешанная папка/);
      assert.match(html, /links\.txt \(3 ссылки\)/);
      assert.doesNotMatch(html, /Сменить вид на «/, 'no silent single-kind suggestion');
      // The owner still chooses the kind from the panel.
      assert.match(html, /name="kind"/);
    } finally {
      await editor.close();
    }
  });

  test('a broken file in a folder with NO kind says «не читается», not «0 конфигов»', async () => {
    const editor = await startEditor({
      folders: {odd: {'xray-configs.json': '{ not json'}},
      providers: {},
    });
    try {
      const odd = editor.model.providersInfo().providers.find((item) => item.id === 'odd');
      assert.equal(odd.kind, null);
      assert.equal(odd.contentKind, 'unreadable');
      assert.equal(odd.state, 'unreadable');
      const node = findAll(editor.model.treeSpec(), 'provider').find(
        (item) => item.detail === 'odd',
      );
      assert.match(node.mark, /\[!\] файл не читается/);
      const html = await (await fetch(`${editor.base}/panel/provider:odd`)).text();
      assert.match(html, /файл не читается/);
    } finally {
      await editor.close();
    }
  });

  test('foreign files (*.sh, hwid, *.raw) are not warned about', async () => {
    const editor = await startEditor({
      folders: {
        vpnd: {
          'links.txt': DEFAULT_LINKS,
          'fetch.sh': '#!/bin/sh\n',
          hwid: 'abc',
          'links.raw': 'raw',
        },
      },
      providers: {vpnd: {kind: 'subscription', enabled: true}},
    });
    try {
      const info = editor.model.providersInfo();
      assert.deepEqual(info.warnings, []);
      const html = await (await fetch(`${editor.base}/panel/provider:vpnd`)).text();
      assert.doesNotMatch(html, /лишнее в папке/);
    } finally {
      await editor.close();
    }
  });
});

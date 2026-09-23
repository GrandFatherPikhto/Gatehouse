// The providers panel (NEW): providers are DISCOVERED by folder under
// GATEHOUSE_PROVIDERS, never named by a path in the browser.
//
// The panel lists what was found, lets the owner tick «включён», renames a
// provider on its own panel, and shows what could not be read with the reason.
// The tool reads the folders and never writes into them; a record whose folder is
// gone is «forgotten», which only drops the entry from `webui.json`.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {startServer} from '../src/web/server.mjs';
import {FI_TAG, makeTempDir, vlessLink, writeLinksFile, writeSettings} from './helpers.mjs';

/** A second links provider, disabled by default, used to prove the tick matters. */
const GERMANY_TAG = '🇩🇪 Germany - Berlin';

/**
 * Starts the editor over a project with three discovered folders:
 *
 *   * `vpnd`      — links.txt (the default three servers), ENABLED;
 *   * `second`    — links.txt with one server, found but disabled (no record);
 *   * `hidemyname`— a `*.conf`, found but disabled.
 *
 * @param {Record<string, unknown>} [overrides] `providers` map overrides.
 * @returns {Promise<Record<string, unknown>>}
 */
async function startEditor(overrides = {}) {
  const dir = makeTempDir();
  writeLinksFile(dir);

  const secondDir = path.join(dir, 'providers', 'second');
  fs.mkdirSync(secondDir, {recursive: true});
  fs.writeFileSync(
    path.join(secondDir, 'links.txt'),
    `${vlessLink('uuid-7', 'solo.example.com', GERMANY_TAG, 'security=tls')}\n`,
    'utf8',
  );

  const tunnelDir = path.join(dir, 'providers', 'hidemyname');
  fs.mkdirSync(tunnelDir, {recursive: true});
  fs.writeFileSync(path.join(tunnelDir, 'de.conf'), 'x', 'utf8');

  const settingsFile = writeSettings(dir, {
    providers: {vpnd: {enabled: true}},
    ...overrides,
  });

  const {server, model, url} = await startServer({
    env: {
      GATEHOUSE_SETTINGS: settingsFile,
      GATEHOUSE_HOST: '127.0.0.1',
      GATEHOUSE_PORT: '0',
      GATEHOUSE_STATE_DIR: path.join(dir, 'state'),
    },
  });

  return {
    dir,
    secondDir,
    tunnelDir,
    settingsFile,
    model,
    base: url.replace(/\/$/, ''),
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * POSTs a form the way htmx does it.
 *
 * @param {string} base
 * @param {string} route
 * @param {Record<string, unknown>} [fields]
 * @returns {Promise<Response>}
 */
async function post(base, route, fields = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) params.append(key, String(value));
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded', 'HX-Request': 'true'},
    body: params,
  });
}

/** The markup of one panel. */
async function panel(editor, key) {
  return (await fetch(`${editor.base}/panel/${encodeURIComponent(key)}`)).text();
}

describe('the providers panel lists what was discovered (NEW)', () => {
  test('the found folders are listed and there is no path field anywhere', async () => {
    const editor = await startEditor();
    try {
      const html = await panel(editor, 'providers');

      assert.match(html, /Найденные провайдеры/);
      assert.match(html, /provider%3Avpnd/, 'a found provider links to its own panel');
      assert.match(html, /provider%3Asecond/, 'a folder without a record is still listed');
      assert.match(html, /provider%3Ahidemyname/);
      assert.match(html, /Sing-Box/, 'a links folder is labelled by what it feeds');
      assert.match(html, /Amnezia/, 'a *.conf folder is labelled Amnezia');
      assert.match(html, /hx-post="\/provider\/enabled"/, 'the tick is an action form');

      // The browser never names a path or a kind: the old add form is gone.
      assert.doesNotMatch(html, /name="path"/);
      assert.doesNotMatch(html, /name="kind"/);
      assert.doesNotMatch(html, /name="action"\s+value="add"/);

      // The servers of a provider belong to ITS panel, not to the summary list.
      assert.doesNotMatch(html, new RegExp(FI_TAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } finally {
      await editor.close();
    }
  });

  test('the tick flips a provider and says so', async () => {
    const editor = await startEditor();
    try {
      const on = await post(editor.base, '/provider/enabled', {id: 'second', enabled: '1'});
      assert.match(await on.text(), /Провайдер[^<]*second[^<]*включён/);
      assert.deepEqual(editor.model.getProvider('second'), {enabled: true});

      const off = await post(editor.base, '/provider/enabled', {id: 'second'});
      assert.match(await off.text(), /Провайдер[^<]*second[^<]*выключен/);
      assert.deepEqual(editor.model.getProvider('second'), {enabled: false});
    } finally {
      await editor.close();
    }
  });

  test('a disabled provider keeps its servers out of the config until it is ticked', async () => {
    const editor = await startEditor();
    try {
      assert.equal(editor.model.generate().stats.servers, 3, 'only the ticked vpnd contributes');

      await post(editor.base, '/provider/enabled', {id: 'second', enabled: '1'});
      await post(editor.base, '/save', {panel: 'providers'});

      assert.equal(editor.model.generate().stats.servers, 4, 'the ticked folder joins in');
    } finally {
      await editor.close();
    }
  });
});

describe('the provider panel edits the name and the tick (NEW)', () => {
  test('the human name is saved through the panel form', async () => {
    const editor = await startEditor();
    try {
      const saved = await post(editor.base, '/provider', {
        id: 'vpnd',
        label: 'Directly',
        enabled: '1',
      });
      assert.match(await saved.text(), /Настройки провайдера применены/);
      assert.deepEqual(editor.model.getProvider('vpnd'), {enabled: true, label: 'Directly'});

      const html = await panel(editor, 'provider:vpnd');
      assert.match(html, /name="label"/);
      assert.match(html, /value="Directly"/);
      assert.match(html, /name="enabled"/);
      assert.doesNotMatch(html, /name="path"/);
    } finally {
      await editor.close();
    }
  });

  test('renaming a provider does not move a byte of config.json', async () => {
    const editor = await startEditor();
    try {
      const first = editor.model.generate();
      const before = fs.readFileSync(first.outputFile);

      await post(editor.base, '/provider', {id: 'vpnd', label: 'Directly', enabled: '1'});
      await post(editor.base, '/save', {panel: 'provider'});
      const second = editor.model.generate();

      assert.deepEqual(fs.readFileSync(second.outputFile), before, 'the config is byte-identical');
    } finally {
      await editor.close();
    }
  });

  test('a label with markup is escaped in the panel', async () => {
    const editor = await startEditor();
    try {
      editor.model.setProviderLabel('vpnd', '<script>alert(1)</script>');

      const html = await panel(editor, 'provider:vpnd');
      assert.match(html, /\u0026lt;script\u0026gt;/, 'the label is escaped');
      assert.doesNotMatch(html, /<script>alert/);
    } finally {
      await editor.close();
    }
  });

  test('a disabled provider offers no «включить» rows', async () => {
    const editor = await startEditor();
    try {
      const html = await panel(editor, 'provider:hidemyname');

      assert.match(html, /Amnezia/);
      assert.match(html, /Конфиги туннелей \(1\)/);
      assert.match(html, /Провайдер выключен/);
      assert.doesNotMatch(html, /action="\/tunnels"/, 'a disabled provider offers no rows');
    } finally {
      await editor.close();
    }
  });
});

describe('what could not be read (NEW)', () => {
  test('a record whose folder is gone is listed and «Забыть» removes the record', async () => {
    const editor = await startEditor({providers: {vpnd: {enabled: true}, ghost: {enabled: true}}});
    try {
      const html = await panel(editor, 'providers');
      assert.match(html, /Не прочиталось/);
      assert.match(html, /ghost/);
      assert.match(html, /папки нет/);
      assert.match(html, /hx-post="\/provider\/forget"/);

      const forgotten = await post(editor.base, '/provider/forget', {id: 'ghost'});
      assert.match(await forgotten.text(), /Запись о провайдере[^<]*ghost[^<]*убрана/);
      assert.equal(editor.model.getProvider('ghost'), null);
    } finally {
      await editor.close();
    }
  });

  test('a folder that is on disk cannot be forgotten', async () => {
    const editor = await startEditor();
    try {
      const response = await post(editor.base, '/provider/forget', {id: 'vpnd'});
      assert.match(await response.text(), /найден на диске/);
      assert.ok(editor.model.getProvider('vpnd') !== null);
    } finally {
      await editor.close();
    }
  });

  test('an unusable folder name is listed with its reason', async () => {
    const editor = await startEditor();
    try {
      fs.mkdirSync(path.join(editor.dir, 'providers', '-bad'), {recursive: true});

      const html = await panel(editor, 'providers');
      assert.match(html, /имя папки не подходит/);
      assert.match(html, /-bad/);
    } finally {
      await editor.close();
    }
  });
});

describe('the path-taking route is gone (NEW)', () => {
  test('a POST to /providers with a path is a 404 and changes nothing', async () => {
    const editor = await startEditor();
    try {
      const response = await post(editor.base, '/providers', {
        action: 'add',
        kind: 'links',
        name: 'other',
        path: path.join(editor.dir, 'other.txt'),
      });

      assert.equal(response.status, 404);
      assert.deepEqual(editor.model.providerIds(), ['vpnd']);
    } finally {
      await editor.close();
    }
  });
});

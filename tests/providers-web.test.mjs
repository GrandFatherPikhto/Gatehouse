// The providers panel edits the source LIST: a source is an explicit origin —
// a links FILE for Sing-Box or a tunnels DIRECTORY for Amnezia — picked by hand.
// The tool reads the origin and never writes to it: removing an entry means
// "do not read it", not "delete the owner's files".

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {startServer} from '../src/web/server.mjs';
import {FI_TAG, makeTempDir, writeLinksFile, writeSettings} from './helpers.mjs';

/**
 * Starts the editor over a project that lists ONE explicit links source and has
 * a second folder (`hidemyname`) with a tunnel config, not listed yet.
 *
 * @returns {Promise<Record<string, unknown>>}
 */
async function startEditor() {
  const dir = makeTempDir();
  writeLinksFile(dir);
  const tunnelDir = path.join(dir, 'sources', 'hidemyname');
  fs.mkdirSync(tunnelDir, {recursive: true});
  fs.writeFileSync(path.join(tunnelDir, 'de.conf'), 'x', 'utf8');
  const settingsFile = writeSettings(dir, {
    sources: [{kind: 'links', name: 'vpnd', path: 'sources/vpnd/links.txt'}],
  });
  const stateDir = path.join(dir, 'state');

  const {server, model, url} = await startServer({
    env: {
      GATEHOUSE_SETTINGS: settingsFile,
      GATEHOUSE_HOST: '127.0.0.1',
      GATEHOUSE_PORT: '0',
      GATEHOUSE_STATE_DIR: stateDir,
    },
  });

  return {
    dir,
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
 * POSTs an action form the way htmx does it.
 *
 * @param {string} base
 * @param {Record<string, unknown>} fields
 * @returns {Promise<Response>}
 */
async function postProviders(base, fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) params.append(key, String(value));
  return fetch(`${base}/providers`, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded', 'HX-Request': 'true'},
    body: params,
  });
}

describe('the providers panel edits explicit sources (NEW)', () => {
  test('the add control is a type + path form, not a folder combobox', async () => {
    const editor = await startEditor();
    try {
      const html = await (await fetch(`${editor.base}/panel/providers`)).text();

      assert.match(html, /name="kind" value="links"/, 'the links kind is offered');
      assert.match(html, /name="kind" value="tunnels"/, 'the tunnels kind is offered');
      assert.match(html, /name="path"/, 'the path is typed by hand');
      assert.match(html, /name="name"/, 'the provider name is typed by hand');
      assert.doesNotMatch(html, /<select[^>]*name="name"/, 'the old folder combobox is gone');
      assert.match(html, /name="action" value="remove"/);
      assert.match(html, /provider%3Avpnd/, 'the provider name links to its contents');
      assert.match(html, /Sing-Box/, 'a links source is labelled by what it feeds');
      // The servers of a provider belong to ITS panel, not to the summary list.
      assert.doesNotMatch(html, /Выходы \(/);
      assert.doesNotMatch(html, new RegExp(FI_TAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } finally {
      await editor.close();
    }
  });

  test('adding a tunnels directory creates a provider panel without touching the disk', async () => {
    const editor = await startEditor();
    try {
      const response = await postProviders(editor.base, {
        action: 'add',
        kind: 'tunnels',
        name: 'hidemyname',
        path: editor.tunnelDir,
      });

      const body = await response.text();
      assert.match(body, /Каталог туннелей/);
      assert.match(body, /hidemyname/);
      assert.deepEqual(editor.model.sources(), [
        {kind: 'links', name: 'vpnd', path: 'sources/vpnd/links.txt'},
        {kind: 'tunnels', name: 'hidemyname', path: editor.tunnelDir},
      ]);
      assert.ok(fs.existsSync(path.join(editor.tunnelDir, 'de.conf')));

      const html = await (
        await fetch(`${editor.base}/panel/${encodeURIComponent('provider:hidemyname')}`)
      ).text();
      assert.match(html, /Источник: hidemyname/);
      assert.match(html, /Amnezia/);
      assert.match(html, /Конфиги туннелей \(1\)/);
      assert.match(html, /tunnel%3Ahidemyname%2Fde\.conf/);
    } finally {
      await editor.close();
    }
  });

  test('adding a links file shows the servers that file hands out', async () => {
    const editor = await startEditor();
    try {
      const other = path.join(editor.dir, 'other.txt');
      fs.writeFileSync(
        other,
        'vless://uuid-7@solo.example.com:443?security=tls#%F0%9F%87%A9%F0%9F%87%AA%20Germany%20-%20Berlin\n',
        'utf8',
      );
      const response = await postProviders(editor.base, {
        action: 'add',
        kind: 'links',
        name: 'other',
        path: other,
      });

      assert.match(await response.text(), /Файл ссылок/);

      const html = await (
        await fetch(`${editor.base}/panel/${encodeURIComponent('provider:other')}`)
      ).text();
      assert.match(html, /Источник: other/);
      assert.match(html, /Серверы \(1\)/);
      assert.match(html, /Germany - Berlin/);
    } finally {
      await editor.close();
    }
  });

  test('a path that does not exist is refused and nothing is added', async () => {
    const editor = await startEditor();
    try {
      const response = await postProviders(editor.base, {
        action: 'add',
        kind: 'links',
        name: 'ghost',
        path: path.join(editor.dir, 'nope', 'links.txt'),
      });

      assert.match(await response.text(), /не найден или это не файл/);
      assert.deepEqual(editor.model.sources(), [
        {kind: 'links', name: 'vpnd', path: 'sources/vpnd/links.txt'},
      ]);
    } finally {
      await editor.close();
    }
  });

  test('a directory given as a links file is refused', async () => {
    const editor = await startEditor();
    try {
      const response = await postProviders(editor.base, {
        action: 'add',
        kind: 'links',
        name: 'wrong',
        path: editor.tunnelDir,
      });

      assert.match(await response.text(), /не найден или это не файл/);
      assert.equal(editor.model.sources().length, 1);
    } finally {
      await editor.close();
    }
  });

  test('a duplicate provider name is refused with a reason', async () => {
    const editor = await startEditor();
    try {
      const response = await postProviders(editor.base, {
        action: 'add',
        kind: 'tunnels',
        name: 'vpnd',
        path: editor.tunnelDir,
      });

      assert.match(await response.text(), /уже указан/);
      assert.equal(editor.model.sources().length, 1);
    } finally {
      await editor.close();
    }
  });

  test('removing a source drops the entry and leaves the file on disk', async () => {
    const editor = await startEditor();
    try {
      const response = await postProviders(editor.base, {action: 'remove', name: 'vpnd'});

      assert.match(await response.text(), /файл на диске не тронут/);
      assert.deepEqual(editor.model.sources(), []);
      assert.ok(
        fs.existsSync(path.join(editor.dir, 'sources', 'vpnd', 'links.txt')),
        "the owner's links file is still there",
      );
    } finally {
      await editor.close();
    }
  });

  test('the added source is written to webui.json by the header save', async () => {
    const editor = await startEditor();
    try {
      await postProviders(editor.base, {
        action: 'add',
        kind: 'tunnels',
        name: 'hidemyname',
        path: editor.tunnelDir,
      });

      const saved = await fetch(`${editor.base}/save`, {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded', 'HX-Request': 'true'},
        body: new URLSearchParams({panel: 'providers'}),
      });
      assert.match(await saved.text(), /Сохранено/);

      const document = JSON.parse(fs.readFileSync(editor.settingsFile, 'utf8'));
      assert.deepEqual(document.sources, [
        {kind: 'links', name: 'vpnd', path: 'sources/vpnd/links.txt'},
        {kind: 'tunnels', name: 'hidemyname', path: editor.tunnelDir},
      ]);
    } finally {
      await editor.close();
    }
  });
});

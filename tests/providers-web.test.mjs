// The providers panel edits the source LIST: add a folder from the ones that
// exist under the root, remove one by the button on its row, re-read the root.
// No action touches the owner's files — removing an entry means "do not read it".

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {startServer} from '../src/web/server.mjs';
import {makeTempDir, writeLinksFile, writeSettings} from './helpers.mjs';

/**
 * Starts the editor over a project whose sources root holds two folders: `vpnd`
 * (listed, with links) and `hidemyname` (present, not listed, with a tunnel).
 *
 * @returns {Promise<Record<string, unknown>>}
 */
async function startEditor() {
  const dir = makeTempDir();
  writeLinksFile(dir);
  fs.mkdirSync(path.join(dir, 'sources', 'hidemyname'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'sources', 'hidemyname', 'de.conf'), 'x', 'utf8');
  const settingsFile = writeSettings(dir, {sources: ['vpnd']});
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

describe('the providers panel edits the list (NEW)', () => {
  test('it offers the folders that exist but are not listed, and a remove button per row', async () => {
    const editor = await startEditor();
    try {
      const html = await (await fetch(`${editor.base}/panel/providers`)).text();

      assert.match(html, /<select[^>]*name="name"/, 'the add control is a picker');
      assert.match(html, /<option value="hidemyname">/, 'the unlisted folder is offered');
      assert.doesNotMatch(html, /<textarea/, 'no free-form text field');
      assert.match(html, /name="action" value="remove"/);
      assert.match(html, />Перечитать<\/button>/);
    } finally {
      await editor.close();
    }
  });

  test('adding a folder appends it to sources without touching the disk', async () => {
    const editor = await startEditor();
    try {
      const response = await postProviders(editor.base, {action: 'add', name: 'hidemyname'});

      assert.match(await response.text(), /добавлен/);
      assert.deepEqual(editor.model.sources(), ['vpnd', 'hidemyname']);
      assert.ok(fs.existsSync(path.join(editor.dir, 'sources', 'hidemyname', 'de.conf')));
    } finally {
      await editor.close();
    }
  });

  test('removing a folder drops the entry and leaves the folder on disk', async () => {
    const editor = await startEditor();
    try {
      const response = await postProviders(editor.base, {action: 'remove', name: 'vpnd'});

      assert.match(await response.text(), /папка на диске не тронута/);
      assert.deepEqual(editor.model.sources(), []);
      assert.ok(
        fs.existsSync(path.join(editor.dir, 'sources', 'vpnd', 'links.txt')),
        'the owner\'s links file is still there',
      );
    } finally {
      await editor.close();
    }
  });

  test('re-reading changes nothing and only reports', async () => {
    const editor = await startEditor();
    try {
      const before = editor.model.toText();
      const response = await postProviders(editor.base, {action: 'reload'});

      assert.match(await response.text(), /перечитаны/);
      assert.equal(editor.model.toText(), before);
      assert.equal(editor.model.dirty, false);
    } finally {
      await editor.close();
    }
  });

  test('a duplicate add and an unknown remove are refused with a reason', async () => {
    const editor = await startEditor();
    try {
      const duplicate = await postProviders(editor.base, {action: 'add', name: 'vpnd'});
      assert.match(await duplicate.text(), /уже указан/);

      const unknown = await postProviders(editor.base, {action: 'remove', name: 'ghost'});
      assert.match(await unknown.text(), /не указан/);

      assert.deepEqual(editor.model.sources(), ['vpnd']);
    } finally {
      await editor.close();
    }
  });

  test('the added source is written to webui.json by the header save', async () => {
    const editor = await startEditor();
    try {
      await postProviders(editor.base, {action: 'add', name: 'hidemyname'});

      const saved = await fetch(`${editor.base}/save`, {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded', 'HX-Request': 'true'},
        body: new URLSearchParams({panel: 'providers'}),
      });
      assert.match(await saved.text(), /Сохранено/);

      const document = JSON.parse(fs.readFileSync(editor.settingsFile, 'utf8'));
      assert.deepEqual(document.sources, ['vpnd', 'hidemyname']);
    } finally {
      await editor.close();
    }
  });
});

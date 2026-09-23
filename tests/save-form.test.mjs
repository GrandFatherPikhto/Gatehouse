// «Сохранить» must take the open edit form with it.
//
// The defect: the header button posted only `panel` to `/save`, so a checkbox or a
// field that had not been sent through "Применить" was thrown away while the notice
// still said «Сохранено». Every panel with an edit form was affected; the owner hit
// it on the watchdog checkbox.
//
// All checks here are on the route level: the browser sequence "edit a field →
// press Сохранить" lives only in the markup, and no earlier test reproduced it.

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {PINNED_REFUSAL} from '../src/model/project.mjs';
import {listSnapshots} from '../src/model/storage.mjs';
import {startServer} from '../src/web/server.mjs';
import {FI_TAG, NL_TAG, makeTempDir, writeLinksFile, writeSettings} from './helpers.mjs';

/**
 * Starts the editor over a temporary project.
 *
 * @param {{overrides?: Record<string, unknown>}} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
async function startEditor(options = {}) {
  const dir = makeTempDir();
  const linksFile = writeLinksFile(dir);
  const settingsFile = writeSettings(dir, options.overrides ?? {});
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
    linksFile,
    settingsFile,
    stateDir,
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
 * @param {boolean} [htmx]
 * @returns {Promise<Response>}
 */
async function post(base, route, fields = {}, htmx = true) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const item of value) params.append(key, String(item));
    else params.append(key, String(value));
  }
  const headers = {'Content-Type': 'application/x-www-form-urlencoded'};
  if (htmx) headers['HX-Request'] = 'true';
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers,
    body: params,
    redirect: 'manual',
  });
}

/** Reads the document of a settings file. */
function storedDocument(settingsFile) {
  return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
}

/** SHA-256 of a file. */
function digest(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const HTTP_PROXY = {tag: 'claude-http', type: 'http', port: 54330, servers: [FI_TAG]};

describe('«Сохранить» applies the open edit form', () => {
  test('a checkbox that was never submitted through «Применить» survives the save', async () => {
    const editor = await startEditor({overrides: {proxies: [HTTP_PROXY]}});
    try {
      // Exactly what the browser sends when the proxy form is bound to the header
      // button: every field of the form, and the panel key of the open screen.
      const response = await post(editor.base, '/save', {
        panel: 'proxy:claude-http',
        current: 'claude-http',
        tag: 'claude-http',
        type: 'http',
        port: '54330',
        servers: [FI_TAG],
        note: '',
        watch: '1',
      });
      const html = await response.text();

      const proxy = storedDocument(editor.settingsFile).proxies.find((item) => item.tag === 'claude-http');
      assert.equal(proxy.watch, true, 'the watchdog flag reached webui.json');
      assert.match(html, /name="watch" value="1" checked/, 'the redrawn form shows it ticked');
      assert.doesNotMatch(html, /Нечего сохранять/);
    } finally {
      await editor.close();
    }
  });

  test('a text field is applied too, not only a checkbox', async () => {
    const editor = await startEditor({overrides: {proxies: [HTTP_PROXY]}});
    try {
      await post(editor.base, '/save', {
        panel: 'proxy:claude-http',
        current: 'claude-http',
        tag: 'claude-http',
        type: 'http',
        port: '54999',
        servers: [FI_TAG],
        note: 'через сохранить',
      });

      const proxy = storedDocument(editor.settingsFile).proxies.find((item) => item.tag === 'claude-http');
      assert.equal(proxy.port, 54999);
      assert.equal(proxy.note, 'через сохранить');
    } finally {
      await editor.close();
    }
  });

  test('a rejected form writes nothing and reports the reason', async () => {
    const editor = await startEditor({
      overrides: {proxies: [{tag: 'claude-http', type: 'http', port: 54330, servers: [FI_TAG]}]},
    });
    try {
      const before = digest(editor.settingsFile);

      const response = await post(editor.base, '/save', {
        panel: 'proxy:claude-http',
        current: 'claude-http',
        tag: 'claude-http',
        type: 'http',
        port: '54330',
        servers: [FI_TAG, NL_TAG],
        pinned: '1',
      });
      const html = await response.text();

      assert.match(html, new RegExp(PINNED_REFUSAL));
      assert.equal(digest(editor.settingsFile), before, 'webui.json is byte for byte the same');
      assert.equal(editor.model.getProxy('claude-http').pinned, undefined);

      // The panel stayed on the proxy being edited, and the entered values came
      // back into its form rather than being dropped on the floor.
      assert.match(html, /value="claude-http"/);
      assert.ok(
        /value="🇫🇮 Finland - Helsinki 1" checked/.test(html) &&
          /value="🇳🇱 Netherlands - Amsterdam" checked/.test(html),
        'the rejected selection is still shown',
      );
      assert.match(html, /name="pinned" value="1" checked/);
    } finally {
      await editor.close();
    }
  });

  test('an empty edit saves nothing and creates no snapshot', async () => {
    const editor = await startEditor({overrides: {proxies: [HTTP_PROXY]}});
    try {
      const response = await post(editor.base, '/save', {
        panel: 'proxy:claude-http',
        current: 'claude-http',
        tag: 'claude-http',
        type: 'http',
        port: '54330',
        servers: [FI_TAG],
        note: '',
      });

      assert.match(await response.text(), /Нечего сохранять/);
      assert.equal(editor.model.dirty, false);
      assert.deepEqual(listSnapshots(editor.stateDir), [], 'no snapshot for a no-op');
    } finally {
      await editor.close();
    }
  });

  test('without htmx the button submits the form and redirects', async () => {
    const editor = await startEditor({overrides: {proxies: [HTTP_PROXY]}});
    try {
      const response = await post(
        editor.base,
        '/save',
        {
          panel: 'proxy:claude-http',
          current: 'claude-http',
          tag: 'claude-http',
          type: 'http',
          port: '54330',
          servers: [FI_TAG],
          watch: '1',
        },
        false,
      );

      assert.equal(response.status, 303);
      assert.equal(
        response.headers.get('location'),
        `/panel/${encodeURIComponent('proxy:claude-http')}`,
      );
      const proxy = storedDocument(editor.settingsFile).proxies.find((item) => item.tag === 'claude-http');
      assert.equal(proxy.watch, true, 'the change still happened');
    } finally {
      await editor.close();
    }
  });

  test('a panel without an edit form saves as before', async () => {
    const editor = await startEditor();
    try {
      await post(editor.base, '/singbox', {
        listen_ip: '10.95.2.1',
        urltest_url: 'https://gstatic.com',
        urltest_interval: '3m',
        urltest_tolerance: '50',
        log_level: 'info',
      });

      const response = await post(editor.base, '/save', {panel: 'journal'});

      assert.match(await response.text(), /Сохранено/);
      const document = JSON.parse(fs.readFileSync(editor.settingsFile, 'utf8'));
      assert.equal(document.listen_ip, '10.95.2.1');
    } finally {
      await editor.close();
    }
  });

  test('action forms are untouched', async () => {
    const editor = await startEditor({overrides: {proxies: [HTTP_PROXY]}});
    try {
      await post(editor.base, '/save', {panel: 'proxies'});
      await post(editor.base, '/generate', {});
      assert.ok(fs.existsSync(path.join(editor.dir, 'config.json')));

      const removed = await post(editor.base, '/proxy/remove', {current: 'claude-http'});
      assert.match(await removed.text(), /удалён/);

      await post(editor.base, '/save', {panel: 'proxies'});
      assert.equal(editor.model.getProxy('claude-http'), null);
    } finally {
      await editor.close();
    }
  });
});

describe('the header button is bound to the edit form', () => {
  test('a panel with an edit form points Save at #panel-form', async () => {
    const editor = await startEditor({overrides: {proxies: [HTTP_PROXY]}});
    try {
      const html = await (await fetch(`${editor.base}/panel/${encodeURIComponent('proxy:claude-http')}`)).text();

      assert.match(html, /id="panel-form"/);
      assert.match(html, /hx-include="#panel-form"/);
      assert.match(html, /form="panel-form"/);
      assert.match(html, /formaction="\/save\?panel=/);
      // Only the save button is bound. «Перечитать с диска» must keep discarding,
      // so it must not carry the include either.
      assert.equal(html.split('hx-include="#panel-form"').length - 1, 1);
      assert.match(
        html,
        /hx-post="\/reload"[^>]*>\s*<input[^>]*name="panel"/,
        'the reload form still posts a plain panel field',
      );
    } finally {
      await editor.close();
    }
  });

  test('a panel without an edit form keeps the standalone save form', async () => {
    const editor = await startEditor();
    try {
      // `journal` has action buttons only and therefore no edit form to bind.
      const html = await (await fetch(`${editor.base}/panel/journal`)).text();

      assert.doesNotMatch(html, /hx-include="#panel-form"/);
      assert.match(html, /<input type="hidden" name="panel" value="journal">/);
    } finally {
      await editor.close();
    }
  });
});

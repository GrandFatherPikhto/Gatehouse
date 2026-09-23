// Web preview of the tunnel normaliser (part 4, architecture §8.12).
//
// The screen is built around the diff, never around checkboxes: the mandatory
// fixes carry none, and there is exactly ONE checkbox — about future use, not
// about the fix. It also has no apply button; posting recomputes the preview.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {startServer} from '../src/web/server.mjs';
import {FIXTURES_DIR, makeTempDir, writeLinksFile, writeSettings} from './helpers.mjs';

const PROVIDER_CONF = path.join(FIXTURES_DIR, 'tunnel', 'provider.conf');

/**
 * Starts the editor over a project that also carries a tunnel config.
 *
 * @returns {Promise<Record<string, unknown>>}
 */
async function startEditor() {
  const dir = makeTempDir();
  writeLinksFile(dir);
  const tunnelDir = path.join(dir, 'sources', 'hidemyname');
  fs.mkdirSync(tunnelDir, {recursive: true});
  fs.copyFileSync(PROVIDER_CONF, path.join(tunnelDir, 'AustriaGrazS4.conf'));
  const settingsFile = writeSettings(dir, {sources: ['vpnd', 'hidemyname']});
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
 * POSTs the preview form the way htmx does it.
 *
 * @param {string} base
 * @param {Record<string, unknown>} fields
 * @returns {Promise<Response>}
 */
async function postTunnel(base, fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) params.append(key, String(value));
  return fetch(`${base}/tunnel`, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded', 'HX-Request': 'true'},
    body: params,
  });
}

describe('the tunnel preview (NEW)', () => {
  test('the providers panel links every tunnel config', async () => {
    const editor = await startEditor();
    try {
      const html = await (await fetch(`${editor.base}/panel/providers`)).text();

      assert.match(html, /AustriaGrazS4\.conf/);
      assert.match(html, /tunnel%3Ahidemyname%2FAustriaGrazS4\.conf/);
    } finally {
      await editor.close();
    }
  });

  test('the preview shows the diff, the reasons and the untouched keys', async () => {
    const editor = await startEditor();
    try {
      const response = await postTunnel(editor.base, {
        provider: 'hidemyname',
        file: 'AustriaGrazS4.conf',
        name: 'hmn-graz4',
      });
      const html = await response.text();

      assert.match(html, /\+ Table = off/);
      assert.match(html, /− DNS = 1\.1\.1\.1/);
      assert.match(html, /весь трафик роутера/);
      assert.match(html, /без изменений: AllowedIPs, Jc, Jmin, Jmax/);
      assert.match(html, /PrivateKey/, 'the resulting text is shown');
    } finally {
      await editor.close();
    }
  });

  test('one checkbox, none on the mandatory fixes, and no apply button', async () => {
    const editor = await startEditor();
    try {
      const response = await postTunnel(editor.base, {
        provider: 'hidemyname',
        file: 'AustriaGrazS4.conf',
        name: 'hmn-graz4',
      });
      const html = await response.text();

      // Still exactly ONE checkbox — the one about FUTURE USE (policy routing).
      // The mark and the two names live in the Providers panel now, and the
      // preview never writes the file itself.
      assert.equal(html.split('type="checkbox"').length - 1, 1, 'one checkbox, for policy routing');
      assert.match(html, /отдаётся также через 3proxy по адресу источника/);
      assert.doesNotMatch(html, /hx-post="\/tunnel\/apply"/, 'there is no apply on this screen');
      assert.doesNotMatch(html, />Применить</);
      assert.match(html, /hx-post="\/tunnel\/policy"/, 'the policy switch has its own route');
      assert.match(html, /Имя туннеля: <code>hidemyname-AustriaGrazS4<\/code>/);
      assert.match(html, /туннель не включён/, 'a disabled tunnel says the file is not created');
    } finally {
      await editor.close();
    }
  });

  test('ticking policy routing adds the ip rule lines', async () => {
    const editor = await startEditor();
    try {
      const response = await postTunnel(editor.base, {
        provider: 'hidemyname',
        file: 'AustriaGrazS4.conf',
        name: 'hmn-graz4',
        policyRouting: '1',
      });
      const html = await response.text();

      assert.match(html, /PostUp = ip rule add from 100\.64\.0\.2 table 200/);
      assert.match(html, /PreDown = ip rule del from 100\.64\.0\.2 table 200/);
      assert.match(html, /type="checkbox"[^>]*checked/, 'the box comes back ticked');
    } finally {
      await editor.close();
    }
  });

  test('the model preview matches the golden file and writes nothing', async () => {
    const editor = await startEditor();
    try {
      const before = fs.readFileSync(editor.settingsFile, 'utf8');
      const preview = editor.model.tunnelPreview('hidemyname', 'AustriaGrazS4.conf', {name: 'hmn-graz4'});

      assert.equal(preview.text, fs.readFileSync(path.join(FIXTURES_DIR, 'tunnel', 'normalized.conf'), 'utf8'));
      assert.equal(fs.readFileSync(editor.settingsFile, 'utf8'), before, 'webui.json is untouched');
    } finally {
      await editor.close();
    }
  });

  test('an unknown source is refused with a clear message', async () => {
    const editor = await startEditor();
    try {
      const response = await postTunnel(editor.base, {provider: 'nope', file: 'x.conf'});
      const html = await response.text();

      assert.match(html, /не указан в поле sources/);
    } finally {
      await editor.close();
    }
  });
});

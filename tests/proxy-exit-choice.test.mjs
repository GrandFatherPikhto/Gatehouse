// The exit choice of the proxy form (NEW). A proxy exits EITHER through the
// sing-box outbounds OR through exactly one tunnel, and the form carries that as
// one combo (`exit_kind`). The SERVER is the arbiter: it reads the combo and takes
// one branch, so the form keeps working without script — then both branches are in
// the body and the ignored one must be discarded, never mixed in.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {isActiveBranch} from '../public/app.js';
import {startServer} from '../src/web/server.mjs';
import {
  FI_TAG,
  FIXTURES_DIR,
  NL_TAG,
  fakeSystemEnv,
  makeTempDir,
  tunnelSystemEnv,
  writeLinksFile,
  writeSettings,
  writeSudoers,
} from './helpers.mjs';

const PROVIDER_CONF = path.join(FIXTURES_DIR, 'tunnel', 'provider.conf');

/** The mark form of the graz tunnel. */
const GRAZ_MARK = {
  provider: 'hidemyname',
  file: 'AustriaGrazS4.conf',
  name: 'hidemyname-AriaGrazS4',
  interface: 'hmn-graz4',
  needed: '1',
};

/**
 * Starts an editor with a links provider, a tunnel source and sudoers rights, so
 * both branches of the proxy form have something to offer.
 *
 * @returns {Promise<Record<string, unknown>>}
 */
async function startEditor() {
  const dir = makeTempDir();
  writeLinksFile(dir);
  const tunnelDir = path.join(dir, 'sources', 'hidemyname');
  fs.mkdirSync(tunnelDir, {recursive: true});
  fs.copyFileSync(PROVIDER_CONF, path.join(tunnelDir, 'AustriaGrazS4.conf'));

  const settingsFile = writeSettings(dir, {
    sources: ['vpnd', 'hidemyname'],
    proxies: [{tag: 'main-socks', type: 'socks', port: 54321}],
  });
  const sudoers = writeSudoers(path.join(dir, 'sudoers-gatehouse'), ['hmn-graz4']);
  const env = {
    ...fakeSystemEnv(),
    ...tunnelSystemEnv(dir, {sudoers}),
    GATEHOUSE_SETTINGS: settingsFile,
    GATEHOUSE_HOST: '127.0.0.1',
    GATEHOUSE_PORT: '0',
    GATEHOUSE_STATE_DIR: path.join(dir, 'state'),
  };

  const {server, model, url} = await startServer({env});
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
 * POSTs a form the way htmx does it. An array value is repeated, which is how a
 * browser submits a row of checked boxes.
 *
 * @param {string} base
 * @param {string} route
 * @param {Record<string, unknown>} [fields]
 * @returns {Promise<Response>}
 */
async function post(base, route, fields = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const item of value) params.append(key, String(item));
    else params.append(key, String(value));
  }
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded', 'HX-Request': 'true'},
    body: params,
  });
}

describe('the proxy exit choice (NEW)', () => {
  test('the branch rule is a pure function the tests can pin', () => {
    assert.equal(isActiveBranch('singbox', 'singbox'), true);
    assert.equal(isActiveBranch('singbox', 'tunnel'), false);
    assert.equal(isActiveBranch('tunnel', 'tunnel'), true);
  });

  test('the form offers one combo and both branches', async () => {
    const editor = await startEditor();
    try {
      const html = await (await fetch(`${editor.base}/panel/proxy:main-socks`)).text();

      assert.match(html, /<select id="exit_kind" name="exit_kind"/);
      assert.match(html, /data-exit-branch="singbox"/);
      assert.match(html, /data-exit-branch="tunnel"/);
      assert.match(html, /Аутбаунды sing-box/);
      assert.match(html, /data-servers-picker/);
      assert.match(html, /<select id="tunnel" name="tunnel">/);
      // An ordinary proxy opens in the Sing-box mode.
      assert.match(html, /<option value="singbox" selected>/);
    } finally {
      await editor.close();
    }
  });

  test('Sing-box keeps the outbounds and clears the tunnel', async () => {
    const editor = await startEditor();
    try {
      await post(editor.base, '/proxy', {
        current: 'main-socks',
        tag: 'main-socks',
        type: 'socks',
        port: '54321',
        exit_kind: 'singbox',
        servers: [FI_TAG, NL_TAG],
      });

      const proxy = editor.model.getProxy('main-socks');
      assert.deepEqual(proxy.servers, [FI_TAG, NL_TAG]);
      assert.ok(!('tunnel' in proxy), 'no tunnel key on a sing-box proxy');
    } finally {
      await editor.close();
    }
  });

  test('Tunnel binds one tunnel and discards the posted servers', async () => {
    const editor = await startEditor();
    try {
      await post(editor.base, '/tunnels', GRAZ_MARK);
      await post(editor.base, '/proxy', {
        current: 'main-socks',
        tag: 'main-socks',
        type: 'socks',
        port: '54321',
        exit_kind: 'tunnel',
        tunnel: 'hidemyname/AustriaGrazS4.conf',
        // A hidden branch may still travel in the body when the script is absent;
        // it must be discarded, never mixed in.
        servers: [FI_TAG],
      });

      const proxy = editor.model.getProxy('main-socks');
      assert.equal(proxy.tunnel.provider, 'hidemyname');
      assert.equal(proxy.tunnel.file, 'AustriaGrazS4.conf');
      assert.equal(proxy.tunnel.interface, 'hmn-graz4');
      assert.ok(!('servers' in proxy), 'the posted servers are ignored');

      const html = await (await fetch(`${editor.base}/panel/proxy:main-socks`)).text();
      assert.match(html, /<option value="tunnel" selected>/);
      assert.match(html, /hidemyname\/AustriaGrazS4\.conf" selected/);
    } finally {
      await editor.close();
    }
  });

  test('switching back to Sing-box clears the tunnel', async () => {
    const editor = await startEditor();
    try {
      await post(editor.base, '/tunnels', GRAZ_MARK);
      await post(editor.base, '/proxy', {
        current: 'main-socks',
        tag: 'main-socks',
        type: 'socks',
        port: '54321',
        exit_kind: 'tunnel',
        tunnel: 'hidemyname/AustriaGrazS4.conf',
      });
      await post(editor.base, '/proxy', {
        current: 'main-socks',
        tag: 'main-socks',
        type: 'socks',
        port: '54321',
        exit_kind: 'singbox',
        servers: [FI_TAG],
      });

      const proxy = editor.model.getProxy('main-socks');
      assert.deepEqual(proxy.servers, [FI_TAG]);
      assert.ok(!('tunnel' in proxy), 'the tunnel left with the mode');
    } finally {
      await editor.close();
    }
  });

  test('Tunnel without a tunnel is refused, not silently auto-selected', async () => {
    const editor = await startEditor();
    try {
      const response = await post(editor.base, '/proxy', {
        current: 'main-socks',
        tag: 'main-socks',
        type: 'socks',
        port: '54321',
        exit_kind: 'tunnel',
      });
      const html = await response.text();

      // The quotes are HTML-escaped in the rendered panel, so the match stays on
      // the part that carries the meaning.
      assert.match(html, /выбран, но туннель не указан/);
      const proxy = editor.model.getProxy('main-socks');
      assert.ok(!('tunnel' in proxy), 'nothing was stored');
      assert.ok(!('servers' in proxy), 'and no silent pool either');
    } finally {
      await editor.close();
    }
  });

  test('an absent exit_kind falls back to the presence of a tunnel', async () => {
    const editor = await startEditor();
    try {
      await post(editor.base, '/tunnels', GRAZ_MARK);
      await post(editor.base, '/proxy', {
        current: 'main-socks',
        tag: 'main-socks',
        type: 'socks',
        port: '54321',
        tunnel: 'hidemyname/AustriaGrazS4.conf',
      });
      assert.equal(
        editor.model.getProxy('main-socks').tunnel.file,
        'AustriaGrazS4.conf',
        'a tunnel means the Tunnel mode',
      );

      await post(editor.base, '/proxy', {
        current: 'main-socks',
        tag: 'main-socks',
        type: 'socks',
        port: '54321',
        servers: [FI_TAG],
      });
      const proxy = editor.model.getProxy('main-socks');
      assert.deepEqual(proxy.servers, [FI_TAG], 'no tunnel means the Sing-box mode');
      assert.ok(!('tunnel' in proxy));
    } finally {
      await editor.close();
    }
  });
});

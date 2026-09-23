// The «Система» children. The host layer is a GROUP without a page of its own,
// drawn by the tree as a heading over TWO child nodes, exactly like «Настройки».
// A child is carried by the panel KEY: `system:singbox` (the first one) and
// `system:amnezia`. Those tests pin the split: sing-box things must not appear on
// the amnezia child and the other way round, and the tab strip is gone for good.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {startServer} from '../src/web/server.mjs';
import {
  FIXTURES_DIR,
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
 * Starts an editor with a tunnel source, one ordinary proxy and sudoers rights for
 * the tunnel, so both children have something to show.
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
    ...tunnelSystemEnv(dir, {
      sudoers,
      active: ['awg-quick@hmn-graz4'],
      enabled: ['awg-quick@hmn-graz4'],
    }),
    GATEHOUSE_SETTINGS: settingsFile,
    GATEHOUSE_HOST: '127.0.0.1',
    GATEHOUSE_PORT: '0',
    GATEHOUSE_STATE_DIR: path.join(dir, 'state'),
  };

  const {server, model, url} = await startServer({env});
  return {
    dir,
    env,
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
 * @param {Record<string, string>} [fields]
 * @returns {Promise<Response>}
 */
async function post(base, route, fields = {}) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded', 'HX-Request': 'true'},
    body: new URLSearchParams(fields),
  });
}

/** The panel key an htmx response says it belongs to. */
function pushed(panel) {
  const header = panel.headers.get('hx-push-url');
  return header === null ? null : decodeURIComponent(header);
}

describe('the «Система» children (NEW)', () => {
  test('the tree draws «Система» as a group with two child links, and no tab strip', async () => {
    const editor = await startEditor();
    try {
      const html = await (await fetch(`${editor.base}/panel/system:singbox`)).text();

      // The group has no page: it is a heading, never a link that leads nowhere.
      assert.match(html, /<span class="group"[^>]*>Система<\/span>/);
      assert.match(html, />Sing-Box<\/a>/);
      assert.match(html, />Amnezia<\/a>/);
      // The old in-panel navigation is gone; the tree carries the two children.
      assert.doesNotMatch(html, /class="tab/);
      assert.doesNotMatch(html, /nav class="tabs"/);
    } finally {
      await editor.close();
    }
  });

  test('the first child is sing-box: check, rollback, journal and the server test', async () => {
    const editor = await startEditor();
    try {
      // A bare key must open the first child, so the two pages are IDENTICAL: the
      // canonical key is `system:singbox` in both, the tree highlights that child.
      const plain = await (await fetch(`${editor.base}/panel/system`)).text();
      const explicit = await (await fetch(`${editor.base}/panel/system:singbox`)).text();
      assert.equal(plain, explicit, 'a bare key means the first child');

      assert.match(plain, /class="active"[^>]*>Sing-Box</);
      assert.match(plain, /hx-post="\/check"/);
      assert.match(plain, /hx-post="\/rollback"/);
      assert.match(plain, /Журнал sing-box/);
      assert.match(plain, /Проверить все серверы профиля/);

      assert.doesNotMatch(plain, /hx-post="\/tunnel\/toggle"/, 'tunnels have their own child');
      assert.doesNotMatch(plain, /id="panel-form"/, 'this child has no edit form');
    } finally {
      await editor.close();
    }
  });

  test('the amnezia child holds the tunnels and nothing of sing-box', async () => {
    const editor = await startEditor();
    try {
      await post(editor.base, '/tunnels', GRAZ_MARK);

      const html = await (await fetch(`${editor.base}/panel/system:amnezia`)).text();

      assert.match(html, /class="active"[^>]*>Amnezia</);
      assert.match(html, /awg-quick@hmn-graz4/);
      assert.match(html, /hx-post="\/tunnel\/toggle"/);
      assert.doesNotMatch(html, /hx-post="\/check"/);
      assert.doesNotMatch(html, /Журнал sing-box/);
    } finally {
      await editor.close();
    }
  });

  test('the removed watchdog key falls back to the first child, and its routes are gone', async () => {
    const editor = await startEditor();
    try {
      // A stale bookmark must not render an empty page: an unknown child name already
      // means the first child, and there is no third child any more.
      const html = await (await fetch(`${editor.base}/panel/system:watchdog`)).text();

      assert.match(html, /class="active"[^>]*>Sing-Box</);
      assert.equal(html.split('id="panel-form"').length - 1, 0, 'no child has an edit form');
      assert.doesNotMatch(html, /Сторож/);

      // The routes went with the watchdog: 404, not a silent no-op.
      assert.equal((await post(editor.base, '/watchdog/check')).status, 404);
      assert.equal((await post(editor.base, '/watchdog', {enabled: '1'})).status, 404);
      assert.equal((await post(editor.base, '/watchdog/reset')).status, 404);
    } finally {
      await editor.close();
    }
  });

  test('every key of the group highlights one of the two child nodes', async () => {
    const editor = await startEditor();
    try {
      const expected = {
        system: 'Sing-Box',
        'system:singbox': 'Sing-Box',
        'system:amnezia': 'Amnezia',
        'system:watchdog': 'Sing-Box',
      };
      for (const [key, child] of Object.entries(expected)) {
        const html = await (await fetch(`${editor.base}/panel/${key}`)).text();
        assert.match(html, new RegExp(`class="active"[^>]*>${child}<`), `${key}: ${child}`);
      }

      const page = await (await fetch(`${editor.base}/`)).text();
      assert.doesNotMatch(page, /panel\/journal/, 'the journal is not a tree node');
      assert.doesNotMatch(page, /panel\/tests/);
      assert.doesNotMatch(page, /panel\/watchdog/);
    } finally {
      await editor.close();
    }
  });

  test('an action stays on the child it was taken from', async () => {
    const editor = await startEditor();
    try {
      await post(editor.base, '/check');
      const restarted = await post(editor.base, '/restart');
      assert.equal(pushed(restarted), '/panel/system:singbox', 'the daemon belongs to sing-box');

      await post(editor.base, '/tunnels', GRAZ_MARK);
      const toggled = await post(editor.base, '/tunnel/toggle', {name: 'hmn-graz4', up: '1'});
      assert.equal(pushed(toggled), '/panel/system:amnezia', 'the tunnel belongs to amnezia');
    } finally {
      await editor.close();
    }
  });
});

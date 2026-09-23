// The «Система» tabs. The host layer is ONE panel with three tabs, and a tab is
// carried by the panel KEY: `system:singbox` (the first one), `system:amnezia`,
// `system:watchdog`. That makes a tab a real address that works without script, and
// these tests pin the split: sing-box things must not appear on the amnezia tab and
// the other way round.

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
 * the tunnel, so every tab has something to show.
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

describe('the «Система» tabs (NEW)', () => {
  test('the first tab is sing-box: check, rollback, journal and the server test', async () => {
    const editor = await startEditor();
    try {
      const plain = await (await fetch(`${editor.base}/panel/system`)).text();
      const explicit = await (await fetch(`${editor.base}/panel/system:singbox`)).text();
      // The two pages differ only in the panel key they carry (the hidden field and
      // the Save button's formaction), so the comparison drops the explicit tab:
      // a missing tab name must mean the first tab.
      const strip = (text) => text.replaceAll('system:singbox', 'system');
      assert.equal(strip(plain), strip(explicit), 'a missing tab name means the first tab');

      assert.match(plain, /class="tab active"[^>]*>Sing-box</);
      assert.match(plain, /hx-post="\/check"/);
      assert.match(plain, /hx-post="\/rollback"/);
      assert.match(plain, /Журнал sing-box/);
      assert.match(plain, /Проверить все серверы профиля/);

      assert.doesNotMatch(plain, /hx-post="\/tunnel\/toggle"/, 'tunnels have their own tab');
      assert.doesNotMatch(plain, /Общий рубильник/, 'so does the watchdog');
      assert.doesNotMatch(plain, /id="panel-form"/, 'this tab has no edit form');
    } finally {
      await editor.close();
    }
  });

  test('the amnezia tab holds the tunnels and nothing of sing-box', async () => {
    const editor = await startEditor();
    try {
      await post(editor.base, '/tunnels', GRAZ_MARK);

      const html = await (await fetch(`${editor.base}/panel/system:amnezia`)).text();

      assert.match(html, /class="tab active"[^>]*>Amnezia</);
      assert.match(html, /awg-quick@hmn-graz4/);
      assert.match(html, /hx-post="\/tunnel\/toggle"/);
      assert.doesNotMatch(html, /hx-post="\/check"/);
      assert.doesNotMatch(html, /Журнал sing-box/);
      assert.doesNotMatch(html, /Общий рубильник/);
    } finally {
      await editor.close();
    }
  });

  test('the watchdog tab carries the only edit form of the panel', async () => {
    const editor = await startEditor();
    try {
      const html = await (await fetch(`${editor.base}/panel/system:watchdog`)).text();

      assert.match(html, /class="tab active"[^>]*>Сторож</);
      assert.match(html, /Общий рубильник/);
      assert.equal(html.split('id="panel-form"').length - 1, 1, 'exactly one edit form');
      assert.match(html, /hx-include="#panel-form"/, 'the header Save binds to it');
      assert.match(html, /name="panel" value="system:watchdog"/);
      assert.doesNotMatch(html, /hx-post="\/check"/);
    } finally {
      await editor.close();
    }
  });

  test('the tree keeps ONE «Система» node, highlighted on every tab', async () => {
    const editor = await startEditor();
    try {
      for (const key of ['system', 'system:singbox', 'system:amnezia', 'system:watchdog']) {
        const html = await (await fetch(`${editor.base}/panel/${key}`)).text();
        assert.match(html, /class="active"[^>]*>Система</, `${key}: the node is highlighted`);
      }

      const page = await (await fetch(`${editor.base}/`)).text();
      assert.doesNotMatch(page, /panel\/journal/, 'the journal is not a tree node');
      assert.doesNotMatch(page, /panel\/tests/);
      assert.doesNotMatch(page, /panel\/watchdog/);
    } finally {
      await editor.close();
    }
  });

  test('an action stays on the tab it was taken from', async () => {
    const editor = await startEditor();
    try {
      await post(editor.base, '/check');
      const restarted = await post(editor.base, '/restart');
      assert.equal(pushed(restarted), '/panel/system:singbox', 'the daemon belongs to sing-box');

      await post(editor.base, '/tunnels', GRAZ_MARK);
      const toggled = await post(editor.base, '/tunnel/toggle', {name: 'hmn-graz4', up: '1'});
      assert.equal(pushed(toggled), '/panel/system:amnezia', 'the tunnel belongs to amnezia');

      const applied = await post(editor.base, '/watchdog', {
        panel: 'system:watchdog',
        enabled: '1',
        interval_seconds: '600',
        failures_before_action: '2',
        pause_seconds: '1800',
        max_restarts_per_day: '3',
      });
      assert.equal(pushed(applied), '/panel/system:watchdog', 'the form names its own tab');
    } finally {
      await editor.close();
    }
  });
});

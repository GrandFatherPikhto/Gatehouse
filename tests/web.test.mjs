// HTTP tests of the web editor.
//
// The server is started on port 0 and spoken to with `fetch`: no supertest, no
// extra dependency. The environment is real too — the tests go through
// `startServer`, so the variable names and the 127.0.0.1 default are covered as
// well, not only the Express app.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {run as runGenerate} from '../tools/generate.mjs';
import {canonicalJson, listSnapshots} from '../src/model/storage.mjs';
import {DEFAULT_PORT, readEnv, startServer} from '../src/web/server.mjs';
import {FI_TAG, NL_TAG, RU_TAG, makeTempDir, writeLinksFile, writeSettings} from './helpers.mjs';
// The picker's filter lives in the browser script and is imported as it is: the
// trap it guards against (a row that leaves the DOM leaves the form with it) is
// a property of that code, and asserting it here beats asserting the markup.
import {applyFilter} from '../public/app.js';

/**
 * Starts the editor over a temporary project and returns everything the test
 * needs to talk to it.
 *
 * @param {{overrides?: Record<string, unknown>, extra?: Record<string, unknown>}} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
async function startEditor(options = {}) {
  const dir = makeTempDir();
  const linksFile = writeLinksFile(dir);
  const settingsFile = writeSettings(dir, options.overrides ?? {}, options.extra ?? {});
  const stateDir = path.join(dir, 'state');

  const {server, model, url} = await startServer({
    env: {
      SINGBOX_WEBUI_SETTINGS: settingsFile,
      SINGBOX_WEBUI_HOST: '127.0.0.1',
      SINGBOX_WEBUI_PORT: '0',
      SINGBOX_WEBUI_STATE_DIR: stateDir,
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
 * Builds a form body, keeping repeated fields repeated.
 *
 * @param {Record<string, unknown>} fields
 * @returns {URLSearchParams}
 */
function formBody(fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const item of value) params.append(key, String(item));
    else params.append(key, String(value));
  }
  return params;
}

/**
 * Posts a form the way htmx does it.
 *
 * @param {string} base
 * @param {string} route
 * @param {Record<string, unknown>} fields
 * @param {boolean} [htmx] Send the HX-Request header or not.
 * @returns {Promise<Response>}
 */
async function post(base, route, fields, htmx = true) {
  const headers = {'Content-Type': 'application/x-www-form-urlencoded'};
  if (htmx) headers['HX-Request'] = 'true';
  // `manual` keeps a 303 visible: following it would hide the redirect contract.
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers,
    body: formBody(fields),
    redirect: 'manual',
  });
}

/** Panel URL of a proxy or route, with the name encoded. */
function panelUrl(key) {
  return `/panel/${encodeURIComponent(key)}`;
}

/**
 * The server checkboxes of the picker, in DOCUMENT order.
 *
 * Reading the order out of the rendered HTML is the whole point: a browser
 * submits checked boxes in document order, not in the order the model holds
 * them. The curl-based manual pass sent the model's order, so it could not see
 * this class of defect at all.
 *
 * Values are compared as they are written; a tag containing `&` or `"` would
 * arrive HTML-escaped, which no real tag does.
 *
 * @param {string} html
 * @returns {RegExpMatchArray[]} Matches of the whole `<input>` tag.
 */
function serverInputTags(html) {
  const start = html.indexOf('data-servers-list');
  assert.ok(start >= 0, 'the servers picker must be rendered');
  const end = html.indexOf('</div>', start);
  assert.ok(end > start, 'the servers list must be closed');
  return [...html.slice(start, end).matchAll(/<input[^>]*\bname="servers"[^>]*>/g)];
}

/**
 * @param {string} html
 * @returns {string[]} Values of all server boxes, in document order.
 */
function serverOptions(html) {
  return serverInputTags(html).map((match) => match[0].match(/value="([^"]*)"/)[1]);
}

/**
 * Exactly what a browser submits for the servers field: every checked box, no
 * matter whether the filter has hidden its row.
 *
 * @param {string} html
 * @returns {string[]}
 */
function submittedServers(html) {
  return serverInputTags(html)
    .filter((match) => /\schecked/.test(match[0]))
    .map((match) => match[0].match(/value="([^"]*)"/)[1]);
}

/**
 * The `<label>` of one server as rendered, so a test can look at the state of its
 * checkbox and at its badges without depending on the layout of the whole list.
 *
 * @param {string} html
 * @param {string} tag
 * @returns {string}
 */
function serverRow(html, tag) {
  const start = html.indexOf(`data-tag="${tag}"`);
  assert.ok(start >= 0, `the row of '${tag}' must be rendered`);
  const end = html.indexOf('</label>', start);
  assert.ok(end > start, `the row of '${tag}' must be closed`);
  return html.slice(start, end);
}

describe('pages and static files', () => {
  test('GET / renders the tree, the status and the htmx bundle from our own host', async () => {
    const editor = await startEditor();
    try {
      const response = await fetch(`${editor.base}/`);
      assert.equal(response.status, 200);

      const html = await response.text();
      assert.match(html, /Профили \(активен: default\)/);
      assert.match(html, /Значения по умолчанию/);
      assert.match(html, /href="\/static\/app.css"/);
      // No CDN: the bundle must be referenced on our own host.
      assert.match(html, /src="\/static\/vendor\/htmx\.min\.js"/);
      assert.ok(!/https?:\/\/(unpkg|cdn|cdnjs)/.test(html));

      const vendor = await fetch(`${editor.base}/static/vendor/htmx.min.js`);
      assert.equal(vendor.status, 200);
      assert.match(vendor.headers.get('content-type') ?? '', /javascript/);
      assert.ok((await vendor.text()).length > 1000);
    } finally {
      await editor.close();
    }
  });

  test('the picker script is served from our own host as a module', async () => {
    const editor = await startEditor();
    try {
      const html = await (await fetch(`${editor.base}/`)).text();
      assert.match(html, /src="\/static\/app\.js"/);

      const script = await fetch(`${editor.base}/static/app.js`);
      assert.equal(script.status, 200);
      assert.match(script.headers.get('content-type') ?? '', /javascript/);
      assert.match(await script.text(), /export function applyFilter/, 'a module the tests can import');
    } finally {
      await editor.close();
    }
  });

  test('a panel deep link renders the full page, an htmx request only the fragment', async () => {
    const editor = await startEditor();
    try {
      const page = await fetch(`${editor.base}${panelUrl('proxy:main-socks')}`);
      const html = await page.text();
      assert.match(html, /<html/);
      assert.match(html, /main-socks/);

      const fragment = await fetch(`${editor.base}${panelUrl('proxy:main-socks')}`, {
        headers: {'HX-Request': 'true'},
      });
      const partial = await fragment.text();
      assert.ok(!partial.includes('<html'), 'a fragment must not carry the page');
      assert.match(partial, /hx-swap-oob/);
      assert.equal(fragment.headers.get('hx-push-url'), panelUrl('proxy:main-socks'));
    } finally {
      await editor.close();
    }
  });

  test('a proxy with a space and an emoji in its tag is addressable', async () => {
    const editor = await startEditor({
      overrides: {proxies: [{tag: '🇫🇮 main', type: 'socks', port: 54321}]},
    });
    try {
      const response = await fetch(`${editor.base}${panelUrl('proxy:🇫🇮 main')}`);
      const html = await response.text();

      assert.equal(response.status, 200);
      assert.match(html, /value="🇫🇮 main"/);
      assert.match(html, /🇫🇮 Finland - Helsinki 1/);
    } finally {
      await editor.close();
    }
  });

  test('an unknown panel and an unknown route answer honestly', async () => {
    const editor = await startEditor();
    try {
      // Messages are HTML-escaped by the templates, so the assertions match on
      // the wording and not on the quotes around the name.
      const unknown = await fetch(`${editor.base}/panel/nonsense`);
      const html = await unknown.text();
      assert.equal(unknown.status, 200);
      assert.match(html, /неизвестный раздел/);
      assert.match(html, /nonsense/);
      assert.match(html, /Профили \(активен/, 'it falls back to a panel that exists');

      const missing = await fetch(`${editor.base}/panel/${encodeURIComponent('proxy:ghost')}`);
      const missingHtml = await missing.text();
      assert.match(missingHtml, /ghost/);
      assert.match(missingHtml, /не найден/);

      const notFound = await fetch(`${editor.base}/nowhere`);
      assert.equal(notFound.status, 404);
    } finally {
      await editor.close();
    }
  });
});

describe('editing forms', () => {
  test('the general form writes into the active profile and marks it dirty', async () => {
    const editor = await startEditor();
    try {
      const response = await post(editor.base, '/general', {
        scope: 'profile',
        listen_ip: '10.95.2.1',
        urltest_url: 'https://gstatic.com',
        urltest_interval: '5m',
        urltest_tolerance: '50',
        log_level: 'debug',
        log_timestamp: '1',
        exclude_from_auto: '🇷🇺\n🇩🇪\n',
      });

      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /Применено/);
      assert.match(html, /есть несохранённые правки/);

      assert.equal(editor.model.listenIp, '10.95.2.1');
      assert.deepEqual(editor.model.profileBody().urltest.interval, '5m');
      assert.deepEqual(editor.model.profileBody().log, {level: 'debug', timestamp: true});
      assert.deepEqual(editor.model.profileBody().exclude_from_auto, ['🇷🇺', '🇩🇪']);
    } finally {
      await editor.close();
    }
  });

  test('the same form can write into defaults, and the profile keeps overriding', async () => {
    const editor = await startEditor({overrides: {listen_ip: '127.0.0.1'}});
    try {
      await post(editor.base, '/general', {
        scope: 'defaults',
        listen_ip: '10.95.2.1',
        urltest_url: 'https://gstatic.com',
        urltest_interval: '3m',
        urltest_tolerance: '50',
        log_level: 'info',
      });

      assert.equal(editor.model.defaultsBody().listen_ip, '10.95.2.1');
      assert.equal(editor.model.listenIp, '127.0.0.1', 'the profile still wins');

      const response = await post(editor.base, '/general', {scope: 'profile', action: 'reset', field: 'listen_ip'});

      assert.match(await response.text(), /снова действует значение по умолчанию/);
      assert.equal(editor.model.listenIp, '10.95.2.1');
    } finally {
      await editor.close();
    }
  });

  test('a duplicate port is refused with the wording of the core', async () => {
    const editor = await startEditor();
    try {
      const response = await post(editor.base, '/proxy', {
        current: '',
        tag: 'other',
        type: 'http',
        port: '54321',
        note: '',
      });

      assert.equal(response.status, 200, 'a rejected form is not an HTTP error for htmx');
      const html = await response.text();
      assert.match(html, /дубль порта инбаунда: 54321/);
      assert.equal(editor.model.getProxy('other'), null, 'nothing was written');
      assert.equal(editor.model.dirty, false);
    } finally {
      await editor.close();
    }
  });

  test('a non-JSON DNS text is refused, a JSON object is stored', async () => {
    const editor = await startEditor();
    try {
      const bad = await post(editor.base, '/dns', {scope: 'profile', dns: '{oops'});
      assert.match(await bad.text(), /не валидный JSON/);

      const list = await post(editor.base, '/dns', {scope: 'profile', dns: '[]'});
      assert.match(await list.text(), /ожидается JSON-объект/);

      const good = await post(editor.base, '/dns', {
        scope: 'profile',
        dns: '{"servers": [], "final": "direct"}',
      });
      assert.match(await good.text(), /DNS применён/);
      assert.deepEqual(editor.model.profileBody().dns, {servers: [], final: 'direct'});
    } finally {
      await editor.close();
    }
  });

  test('a proxy can be created, renamed and removed through the UI', async () => {
    const editor = await startEditor();
    try {
      const created = await post(editor.base, '/proxy/new', {});
      assert.equal(created.headers.get('hx-push-url'), panelUrl('proxy:new-proxy'));
      assert.deepEqual(editor.model.proxyTags(), ['main-socks', 'apps-http', 'new-proxy']);

      await post(editor.base, '/proxy', {
        current: 'new-proxy',
        tag: 'renamed',
        type: 'mixed',
        port: '54999',
        servers: [FI_TAG],
        note: 'первый',
      });
      assert.deepEqual(editor.model.getProxy('renamed'), {
        tag: 'renamed',
        type: 'mixed',
        port: 54999,
        servers: [FI_TAG],
        note: 'первый',
      });

      const removed = await post(editor.base, '/proxy/remove', {current: 'renamed'});
      assert.match(await removed.text(), /удалён/);
      assert.equal(editor.model.getProxy('renamed'), null);
    } finally {
      await editor.close();
    }
  });

  test('a route can be created, edited and removed through the UI', async () => {
    const editor = await startEditor();
    try {
      const created = await post(editor.base, '/route/new', {});
      assert.equal(created.headers.get('hx-push-url'), panelUrl('route:route'));

      await post(editor.base, '/route', {
        current: 'route',
        name: 'video',
        outbound: 'auto-select',
        domains: 'youtube.com\ngooglevideo.com\n',
        note: '',
      });
      assert.deepEqual(editor.model.getRoute('video'), {
        outbound: 'auto-select',
        domains: ['youtube.com', 'googlevideo.com'],
      });

      await post(editor.base, '/route/remove', {current: 'video'});
      assert.equal(editor.model.getRoute('video'), null);
      assert.deepEqual(editor.model.routeNames(), ['telegram']);
    } finally {
      await editor.close();
    }
  });

  test('the active profile cannot be removed from the UI', async () => {
    const editor = await startEditor();
    try {
      const response = await post(editor.base, '/profiles', {action: 'remove', name: 'default'});
      const html = await response.text();

      assert.match(html, /нельзя удалить последний профиль/);
      assert.match(html, /default/);
      assert.deepEqual(editor.model.profileNames(), ['default']);
    } finally {
      await editor.close();
    }
  });

  test('a form post without htmx redirects back to the panel', async () => {
    const editor = await startEditor();
    try {
      const response = await post(
        editor.base,
        '/general',
        {
          scope: 'profile',
          listen_ip: '10.95.2.1',
          urltest_url: 'https://gstatic.com',
          urltest_interval: '3m',
          urltest_tolerance: '50',
          log_level: 'info',
        },
        false,
      );

      // The redirect must not be followed: its target is the panel page.
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), panelUrl('general'));
      assert.equal(editor.model.listenIp, '10.95.2.1', 'the change still happened');
    } finally {
      await editor.close();
    }
  });
});

describe('saving and generating from the UI', () => {
  test('save writes the canonical file, keeps a snapshot and clears the dirty flag', async () => {
    const editor = await startEditor();
    try {
      const before = fs.readFileSync(editor.settingsFile, 'utf8');
      await post(editor.base, '/proxy', {
        current: 'main-socks',
        tag: 'main-socks',
        type: 'mixed',
        port: '54321',
        note: '',
      });

      const saved = await post(editor.base, '/save', {panel: 'proxies'});

      assert.match(await saved.text(), /Сохранено/);
      assert.equal(editor.model.dirty, false);

      const text = fs.readFileSync(editor.settingsFile, 'utf8');
      assert.equal(text, canonicalJson(JSON.parse(text)), 'the file is canonical');
      assert.notEqual(text, before);

      const snapshots = listSnapshots(editor.stateDir);
      assert.equal(snapshots.length, 1);
      assert.equal(fs.readFileSync(path.join(editor.stateDir, 'snapshots', snapshots[0]), 'utf8'), before);
    } finally {
      await editor.close();
    }
  });

  test('reload drops the unsaved edits', async () => {
    const editor = await startEditor();
    try {
      await post(editor.base, '/general', {
        scope: 'profile',
        listen_ip: '10.95.2.1',
        urltest_url: 'https://gstatic.com',
        urltest_interval: '3m',
        urltest_tolerance: '50',
        log_level: 'info',
      });
      assert.equal(editor.model.dirty, true);

      const response = await post(editor.base, '/reload', {panel: 'general'});

      assert.match(await response.text(), /перечитан/);
      assert.equal(editor.model.listenIp, '127.0.0.1');
      assert.equal(editor.model.dirty, false);
    } finally {
      await editor.close();
    }
  });

  test('generating from the UI gives the same config.json as tools/generate.mjs', async () => {
    const editor = await startEditor();
    try {
      await post(editor.base, '/save', {panel: 'output'});

      const generated = await post(editor.base, '/generate', {});
      const html = await generated.text();
      assert.match(html, /Серверов: 3, инбаундов: 2, пулов: 1/);

      const fromUi = path.join(editor.dir, 'config.json');
      const fromCli = path.join(editor.dir, 'cli-config.json');
      assert.equal(await runGenerate(['--settings', editor.settingsFile, '--output', fromCli, '--quiet']), 0);

      assert.ok(fs.existsSync(fromUi));
      assert.ok(
        fs.readFileSync(fromUi).equals(fs.readFileSync(fromCli)),
        'the UI generation must not differ from the CLI',
      );
    } finally {
      await editor.close();
    }
  });

  test('generation reports the core error without a stack trace', async () => {
    const editor = await startEditor({overrides: {links_file: 'nowhere.txt'}});
    try {
      await post(editor.base, '/save', {panel: 'output'});

      const response = await post(editor.base, '/generate', {});

      assert.equal(response.status, 200);
      assert.match(await response.text(), /файл ссылок/);
    } finally {
      await editor.close();
    }
  });

  test('a stale reference marks the tree but does not block saving', async () => {
    const editor = await startEditor({
      overrides: {proxies: [{tag: 'main-socks', type: 'socks', port: 54321, servers: ['🇩🇪 Germany - Berlin']}]},
    });
    try {
      const page = await fetch(`${editor.base}/`);
      const html = await page.text();
      assert.match(html, /class="stale"/);
      assert.match(html, /нет в списке серверов/);

      const saved = await post(editor.base, '/save', {panel: 'proxies'});

      assert.equal(saved.status, 200);
      assert.match(await saved.text(), /Сохранено/);
    } finally {
      await editor.close();
    }
  });

  test('a proxy form keeps a server that vanished from the links file', async () => {
    const editor = await startEditor({
      overrides: {proxies: [{tag: 'main-socks', type: 'socks', port: 54321, servers: ['🇩🇪 Germany - Berlin']}]},
    });
    try {
      const list = await fetch(`${editor.base}${panelUrl('proxy:main-socks')}`);
      const html = await list.text();
      const row = serverRow(html, '🇩🇪 Germany - Berlin');

      assert.match(row, /value="🇩🇪 Germany - Berlin" checked/);
      assert.match(row, /нет в файле ссылок/);
    } finally {
      await editor.close();
    }
  });

  test('a browser submits the servers in document order, and the stored order does not move', async () => {
    // The stored order deliberately differs from the order of links.txt, and a
    // server that is not in the file sits in the MIDDLE of the list. Rendering the
    // boxes in links order (with the checked ones on top of it) would make the
    // first save of an untouched form rewrite the list into links order and push
    // the missing server to the end.
    const stored = [RU_TAG, FI_TAG, '🇩🇪 Germany - Berlin'];
    const editor = await startEditor({
      overrides: {proxies: [{tag: 'main-socks', type: 'socks', port: 54321, servers: stored}]},
    });
    try {
      const html = await (await fetch(`${editor.base}${panelUrl('proxy:main-socks')}`)).text();

      assert.deepEqual(
        serverOptions(html).slice(0, stored.length),
        stored,
        'the checked servers come first, in their stored order',
      );
      assert.deepEqual(
        serverOptions(html).slice(stored.length),
        [NL_TAG],
        'the remaining servers follow in links-file order',
      );

      await post(editor.base, '/proxy', {
        current: 'main-socks',
        tag: 'main-socks',
        type: 'socks',
        port: '54321',
        servers: submittedServers(html),
        note: '',
      });

      assert.deepEqual(
        editor.model.getProxy('main-socks').servers,
        stored,
        'saving a form nobody edited must not reorder the servers',
      );
    } finally {
      await editor.close();
    }
  });

  test('unchecking one server removes exactly that server and keeps the rest in order', async () => {
    const editor = await startEditor({
      overrides: {
        proxies: [{tag: 'main-socks', type: 'socks', port: 54321, servers: [RU_TAG, FI_TAG, NL_TAG]}],
      },
    });
    try {
      const html = await (await fetch(`${editor.base}${panelUrl('proxy:main-socks')}`)).text();

      // A browser posts every checked box; clearing one simply leaves it out.
      const submitted = submittedServers(html).filter((tag) => tag !== FI_TAG);
      await post(editor.base, '/proxy', {
        current: 'main-socks',
        tag: 'main-socks',
        type: 'socks',
        port: '54321',
        servers: submitted,
        note: '',
      });

      assert.deepEqual(
        editor.model.getProxy('main-socks').servers,
        [RU_TAG, NL_TAG],
        'exactly the cleared server goes away, the order of the rest is untouched',
      );
    } finally {
      await editor.close();
    }
  });

  test('a filter hides a checked server instead of removing it from the form', async () => {
    const editor = await startEditor({
      overrides: {proxies: [{tag: 'main-socks', type: 'socks', port: 54321, servers: [RU_TAG, FI_TAG]}]},
    });
    try {
      const html = await (await fetch(`${editor.base}${panelUrl('proxy:main-socks')}`)).text();

      // The filter is client-side sugar: it flips `hidden` on the row and must
      // never detach it. A detached checkbox leaves the form, and the next save
      // would drop that server from the proxy without a word.
      const rows = [
        {text: RU_TAG, hidden: false},
        {text: FI_TAG, hidden: false},
      ];
      applyFilter(rows, 'fi');
      assert.deepEqual(rows.map((row) => row.hidden), [true, false]);
      assert.equal(rows.length, 2, 'the hidden row must stay in the list');

      // The rendered form says the same: the box is there and is checked, so a
      // browser submits it even while the filter hides its row.
      assert.match(serverRow(html, RU_TAG), /value="🇷🇺 Russia - Moscow" checked/);
      assert.match(html, /data-servers-tools hidden/, 'the inert controls start hidden');

      await post(editor.base, '/proxy', {
        current: 'main-socks',
        tag: 'main-socks',
        type: 'socks',
        port: '54321',
        servers: submittedServers(html),
        note: '',
      });

      assert.deepEqual(editor.model.getProxy('main-socks').servers, [RU_TAG, FI_TAG]);
    } finally {
      await editor.close();
    }
  });

  test('clearing every box saves an empty server list, as an empty multi-select did', async () => {
    const editor = await startEditor({
      overrides: {proxies: [{tag: 'main-socks', type: 'socks', port: 54321, servers: [FI_TAG, NL_TAG]}]},
    });
    try {
      // Nothing is checked, so the browser sends no `servers` field at all — the
      // very body an empty multi-select produced.
      const response = await post(editor.base, '/proxy', {
        current: 'main-socks',
        tag: 'main-socks',
        type: 'socks',
        port: '54321',
        note: '',
      });

      assert.equal(response.status, 200);
      const proxy = editor.model.getProxy('main-socks');
      assert.ok(!Object.hasOwn(proxy, 'servers'), 'the key is dropped, exactly as before');
      assert.deepEqual(proxy.servers ?? [], [], 'an empty pool, not a failure');
    } finally {
      await editor.close();
    }
  });

  test('the picker marks the servers of auto-select and the excluded ones', async () => {
    const editor = await startEditor({
      overrides: {
        exclude_from_auto: ['🇷🇺'],
        proxies: [{tag: 'main-socks', type: 'socks', port: 54321}],
      },
    });
    try {
      const html = await (await fetch(`${editor.base}${panelUrl('proxy:main-socks')}`)).text();
      const excluded = serverRow(html, RU_TAG);

      assert.match(excluded, /исключён/);
      assert.ok(!/в auto-select/.test(excluded), 'an excluded server is not advertised as auto');
      assert.match(serverRow(html, FI_TAG), /в auto-select/);
      assert.match(serverRow(html, NL_TAG), /в auto-select/);
    } finally {
      await editor.close();
    }
  });

  test('an empty exclude_from_auto marks every server as auto-select', async () => {
    const editor = await startEditor({
      overrides: {
        exclude_from_auto: [],
        proxies: [{tag: 'main-socks', type: 'socks', port: 54321}],
      },
    });
    try {
      const html = await (await fetch(`${editor.base}${panelUrl('proxy:main-socks')}`)).text();
      const row = serverRow(html, RU_TAG);

      assert.match(row, /в auto-select/);
      assert.ok(!/исключён/.test(row), 'an explicit empty list excludes nothing');
    } finally {
      await editor.close();
    }
  });

  test('an absent exclude_from_auto falls back to the default prefix, like the core', async () => {
    const editor = await startEditor({
      // `undefined` drops the key as the document is written: an old webui.json
      // that never carried `exclude_from_auto` at all.
      overrides: {
        exclude_from_auto: undefined,
        proxies: [{tag: 'main-socks', type: 'socks', port: 54321}],
      },
    });
    try {
      const html = await (await fetch(`${editor.base}${panelUrl('proxy:main-socks')}`)).text();

      assert.match(serverRow(html, RU_TAG), /исключён/);
      assert.match(serverRow(html, FI_TAG), /в auto-select/);
    } finally {
      await editor.close();
    }
  });
});

describe('environment of the server', () => {
  test('the defaults bind to the loopback address', () => {
    const env = readEnv({});

    assert.equal(env.host, '127.0.0.1');
    assert.equal(env.port, DEFAULT_PORT);
    assert.equal(env.settings, 'webui.json');
    assert.equal(env.stateDir, null);
  });

  test('the variables override the defaults', () => {
    const env = readEnv({
      SINGBOX_WEBUI_SETTINGS: '/tmp/other.json',
      SINGBOX_WEBUI_HOST: '10.0.0.5',
      SINGBOX_WEBUI_PORT: '9000',
      SINGBOX_WEBUI_STATE_DIR: '/var/lib/sing-box-webui',
    });

    assert.deepEqual(env, {
      settings: '/tmp/other.json',
      host: '10.0.0.5',
      port: '9000',
      stateDir: '/var/lib/sing-box-webui',
    });
  });

  test('a missing settings file starts with a fresh document bound to the path', async () => {
    const dir = makeTempDir();
    const missing = path.join(dir, 'webui.json');

    const {server, model, url} = await startServer({
      env: {SINGBOX_WEBUI_SETTINGS: missing, SINGBOX_WEBUI_PORT: '0', SINGBOX_WEBUI_HOST: '127.0.0.1'},
    });
    try {
      assert.equal(model.path, missing);
      assert.deepEqual(model.profileNames(), ['default']);

      const response = await fetch(url);
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.match(html, /webui\.json/);
      assert.match(html, /Профили \(активен: default\)/);
      assert.match(html, /файл ещё не создан/, 'nothing was written to disk yet');
      assert.ok(!fs.existsSync(missing), 'a fresh document is not saved until asked');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

// What the removed Watchdog left in the owner's `webui.json`.
//
// Part B of techdocs/plan_2026_09_23_gatehouse_fuse_and_no_watchdog.md: the live
// file of the router carries `watchdog`, `clash_api` and, on a proxy, `watch` and
// `watch_url`. The schema is strict, so those fields are dropped BEFORE validation
// — in one shared function called by the editor and by `tools/generate.mjs` — and
// both say so. A load does NOT rewrite the file: the fields leave it on the next
// ordinary save, with a snapshot, like any other change. The golden `config.json`
// stays byte-identical either way.

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {ConfigError} from '../src/core/errors.mjs';
import {
  dropRemovedSettings,
  removedSettingsMessage,
  validateSettings,
} from '../src/core/settings.mjs';
import {listSnapshots} from '../src/model/storage.mjs';
import {parseProxyForm} from '../src/web/forms.mjs';
import {startServer} from '../src/web/server.mjs';
import {FIXTURES_DIR, makeTempDir, REPO_ROOT, writeLinksFile, writeSettings} from './helpers.mjs';

const FIXTURE_SETTINGS = path.join(FIXTURES_DIR, 'settings.json');
const GOLDEN_CONFIG = path.join(FIXTURES_DIR, 'golden', 'config.json');

/** The four names the live document of the router carries, in the order of the drop. */
const DROPPED = ['watchdog', 'clash_api', 'proxies[1].watch', 'proxies[1].watch_url'];

/**
 * A copy of the golden fixture project with the fields of the removed Watchdog
 * added, exactly as they sit in the owner's file. The copy is needed because the
 * fixture itself must stay untouched: `providers/vpnd` moves with it, so the
 * provider root keeps resolving.
 *
 * @returns {{dir: string, file: string, document: Record<string, unknown>}}
 */
function fixtureProject() {
  const dir = makeTempDir();
  fs.cpSync(path.join(FIXTURES_DIR, 'providers'), path.join(dir, 'providers'), {recursive: true});

  const document = JSON.parse(fs.readFileSync(FIXTURE_SETTINGS, 'utf8'));
  document.watchdog = {enabled: true, interval_seconds: 600, restart_enabled: false};
  document.clash_api = {enabled: false, controller: '127.0.0.1:9090'};
  document.proxies[1].watch = true;
  document.proxies[1].watch_url = 'http://example.invalid/';

  const file = path.join(dir, 'webui.json');
  fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  return {dir, file, document};
}

/**
 * Runs `tools/generate.mjs` in a child process, as the acceptance commands do.
 *
 * @param {string[]} args
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runTool(args) {
  return spawnSync(process.execPath, [path.join(REPO_ROOT, 'tools', 'generate.mjs'), ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
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
    redirect: 'manual',
  });
}

describe('the fields of the removed Watchdog are dropped in one shared place (NEW)', () => {
  test('the function drops them in place and names them', () => {
    const document = {
      watchdog: {enabled: true},
      clash_api: {enabled: false},
      proxies: [{tag: 'a'}, {tag: 'b', watch: true, watch_url: 'http://example.invalid/'}],
    };

    assert.deepEqual(dropRemovedSettings(document), DROPPED);
    assert.deepEqual(document, {proxies: [{tag: 'a'}, {tag: 'b'}]});
  });

  test('a document without them is left alone, and a foreign value is not dropped', () => {
    assert.deepEqual(dropRemovedSettings({proxies: [{tag: 'a', pinned: true}]}), []);
    assert.deepEqual(dropRemovedSettings(null), []);
    assert.deepEqual(dropRemovedSettings('not a document'), []);
  });

  test('the schema still refuses them when they were not dropped first', () => {
    // Part B.3: the drop happens BEFORE validation, so a document handed straight
    // to the validator must be rejected — that is the point of a strict schema.
    assert.throws(
      () => validateSettings({version: 2, watchdog: {enabled: true}}),
      (error) => error instanceof ConfigError && /схеме/.test(error.message),
    );
    assert.throws(
      () => validateSettings({version: 2, proxies: [{tag: 'a', watch: true}]}),
      (error) => error instanceof ConfigError && /схеме/.test(error.message),
    );
  });

  test('the message names every field and says what to do', () => {
    const message = removedSettingsMessage(DROPPED);
    assert.match(message, /убраны устаревшие поля: watchdog, clash_api/);
    assert.match(message, /proxies\[1\]\.watch_url/);
    assert.match(message, /сохраните/);
  });
});

describe('the editor loads the live file and does not rewrite it (NEW)', () => {
  test('the notice is shown, the bytes stay, and the save clears the fields', async () => {
    const project = fixtureProject();
    const before = fs.readFileSync(project.file, 'utf8');
    const stateDir = path.join(project.dir, 'state');

    const {server, url} = await startServer({
      env: {
        GATEHOUSE_SETTINGS: project.file,
        GATEHOUSE_HOST: '127.0.0.1',
        GATEHOUSE_PORT: '0',
        GATEHOUSE_STATE_DIR: stateDir,
      },
    });

    try {
      const base = url.replace(/\/$/, '');
      const page = await (await fetch(`${base}/`)).text();

      assert.match(page, /убраны устаревшие поля: watchdog, clash_api/);
      assert.match(page, /сохраните/);
      assert.equal(
        fs.readFileSync(project.file, 'utf8'),
        before,
        'a load must not rewrite the owner file',
      );
      assert.deepEqual(listSnapshots(stateDir), [], 'and it takes no snapshot either');

      // The proxy panel lost its watchdog fields; the model still shows the proxy.
      const proxyPage = await (await fetch(`${base}/panel/${encodeURIComponent('proxy:apps-http')}`)).text();
      assert.doesNotMatch(proxyPage, /name="watch"/);
      assert.doesNotMatch(proxyPage, /name="watch_url"/);
      assert.doesNotMatch(proxyPage, /следить за связью/);

      // An ordinary edit, then the ordinary save: this is when the fields leave.
      await post(base, '/singbox', {
        listen_ip: '127.0.0.2',
        urltest_url: 'https://gstatic.com',
        urltest_interval: '3m',
        urltest_tolerance: '50',
        log_level: 'info',
      });
      const saved = await post(base, '/save', {panel: 'singbox'});
      assert.match(await saved.text(), /Сохранено/);

      const after = JSON.parse(fs.readFileSync(project.file, 'utf8'));
      assert.equal(after.watchdog, undefined);
      assert.equal(after.clash_api, undefined);
      assert.equal(after.proxies[1].watch, undefined);
      assert.equal(after.proxies[1].watch_url, undefined);
      assert.equal(after.version, 2, 'the document format did not change, so no bump');
      assert.equal(after.listen_ip, '127.0.0.2', 'the edit itself survived');
      assert.equal(listSnapshots(stateDir).length, 1, 'a snapshot was taken, like any save');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('a document without the fields shows no notice at all', async () => {
    const dir = makeTempDir();
    writeLinksFile(dir);
    const settingsFile = writeSettings(dir);

    const {server, url} = await startServer({
      env: {
        GATEHOUSE_SETTINGS: settingsFile,
        GATEHOUSE_HOST: '127.0.0.1',
        GATEHOUSE_PORT: '0',
        GATEHOUSE_STATE_DIR: path.join(dir, 'state'),
      },
    });

    try {
      const page = await (await fetch(`${url.replace(/\/$/, '')}/`)).text();
      assert.doesNotMatch(page, /устаревшие поля/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('the CLI reports the same thing and does not fall over (NEW)', () => {
  test('generate.mjs names the dropped fields in stderr and exits 0', () => {
    const project = fixtureProject();
    const output = path.join(project.dir, 'config.json');

    const result = runTool(['--settings', project.file, '--output', output]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Готово!/);
    assert.match(result.stderr, /убраны устаревшие поля: watchdog, clash_api/);
    assert.match(result.stderr, /proxies\[1\]\.watch_url/);
    assert.ok(fs.existsSync(output), 'the config is still written');
  });

  test('the golden file comes out byte for byte, with the stale fields and without', () => {
    const stale = fixtureProject();
    const staleOutput = path.join(stale.dir, 'stale.json');
    const cleanOutput = path.join(makeTempDir(), 'clean.json');

    const withStale = runTool(['--settings', stale.file, '--output', staleOutput]);
    const without = runTool(['--settings', FIXTURE_SETTINGS, '--output', cleanOutput]);

    assert.equal(withStale.status, 0, withStale.stderr);
    assert.equal(without.status, 0, without.stderr);
    assert.deepEqual(fs.readFileSync(staleOutput), fs.readFileSync(GOLDEN_CONFIG));
    assert.deepEqual(fs.readFileSync(cleanOutput), fs.readFileSync(GOLDEN_CONFIG));
  });
});

describe('the proxy form lost its watchdog fields (NEW)', () => {
  test('parseProxyForm returns no watch and no watch_url', () => {
    const parsed = parseProxyForm({tag: 'a', type: 'http', port: '54321', watch: '1', watch_url: 'x'});

    assert.deepEqual(parsed, {
      tag: 'a',
      type: 'http',
      port: 54321,
      servers: [],
      tunnel: undefined,
      note: '',
      pinned: false,
    });
  });
});

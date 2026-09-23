// Pinned exit, the external API block and the watchdog.
//
// No router, no sing-box, no daemon and no network: `curl` is the fake of
// `tests/fixtures/bin/curl`, the HTTP API is a Node server started inside the test,
// and the system boundary is the fake `systemctl`. The acceptance points of the
// task live here:
//   * `pinned` refuses a second server and never reaches `config.json`;
//   * connections of ONE inbound are closed, the rest are untouched;
//   * the ladder runs after the configured number of failures, with the pause and
//     the daily limit respected, and «сдаюсь» is visible;
//   * the global switch silences everything, even a proxy marked `watch: true`;
//   * the watchdog writes neither `webui.json` nor `config.json` (checked by hash);
//   * an enabled API emits `experimental.clash_api` on loopback; an empty secret is
//     refused; a disabled API keeps `config.json` byte-identical.

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {describe, test} from 'node:test';

import {ConfigError} from '../src/core/errors.mjs';
import {clashApiBlock} from '../src/core/build.mjs';
import {generateConfigFile} from '../src/core/settings.mjs';
import {ProjectModel, PINNED_REFUSAL} from '../src/model/project.mjs';
import {DEFAULT_WATCH_URL, testInbound} from '../src/system/index.mjs';
import {closeInboundConnections, connectionInbound, connectionMatches} from '../src/watchdog/clash.mjs';
import {Watchdog, normalizeWatchdog} from '../src/watchdog/watchdog.mjs';
import {startServer} from '../src/web/server.mjs';
import {
  FI_TAG,
  NL_TAG,
  RU_TAG,
  fakeSystemEnv,
  makeProject,
  makeTempDir,
  writeLinksFile,
  writeSettings,
} from './helpers.mjs';

/** SHA-256 of a file, or null when it does not exist. */
function digest(file) {
  if (!fs.existsSync(file)) return null;
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

describe('pinned exit', () => {
  test('a pinned proxy may not name two servers', () => {
    const {settingsFile} = makeProject();
    const model = new ProjectModel({path: settingsFile});

    assert.throws(
      () =>
        model.upsertProxy({
          tag: 'claude-http',
          type: 'http',
          port: 54330,
          servers: [FI_TAG, NL_TAG],
          pinned: true,
        }),
      (error) => error instanceof ConfigError && error.message === PINNED_REFUSAL,
    );
    assert.equal(model.getProxy('claude-http'), null, 'nothing was stored');
  });

  test('ticking the flag on a proxy that already has a pool is refused too', () => {
    const {settingsFile} = makeProject();
    const model = new ProjectModel({path: settingsFile});

    assert.throws(
      () =>
        model.upsertProxy({
          tag: 'apps-http',
          type: 'http',
          port: 54323,
          servers: [FI_TAG, NL_TAG],
          pinned: true,
        }),
      (error) => error instanceof ConfigError && error.message === PINNED_REFUSAL,
    );
    assert.equal(model.getProxy('apps-http').pinned, undefined, 'the old entry is untouched');
  });

  test('pinned with a single server is stored, and only then is the key written', () => {
    const {settingsFile} = makeProject();
    const model = new ProjectModel({path: settingsFile});

    model.upsertProxy({
      tag: 'claude-http',
      type: 'http',
      port: 54330,
      servers: [FI_TAG],
      pinned: true,
      watch: true,
      watch_url: 'https://example.com/probe',
      note: 'страна важна',
    });

    assert.deepEqual(model.getProxy('claude-http'), {
      tag: 'claude-http',
      type: 'http',
      port: 54330,
      servers: [FI_TAG],
      note: 'страна важна',
      pinned: true,
      watch: true,
      watch_url: 'https://example.com/probe',
    });

    // An untouched form must not grow the keys: the deep equality of the existing
    // web tests would break, and so would the round-trip of the file.
    model.upsertProxy({tag: 'main-socks', type: 'socks', port: 54321, note: ''}, 'main-socks');
    assert.ok(!Object.hasOwn(model.getProxy('main-socks'), 'pinned'));
  });

  test('pinned and watch never reach config.json', () => {
    const {dir, settingsFile} = makeProject({
      proxies: [
        {
          tag: 'claude-http',
          type: 'http',
          port: 54330,
          servers: [FI_TAG],
          pinned: true,
          watch: true,
          watch_url: 'https://watch.example.invalid/probe',
        },
      ],
    });

    const {config} = generateConfigFile(settingsFile, {output: path.join(dir, 'out.json')});
    const text = JSON.stringify(config);

    assert.ok(!text.includes('pinned'));
    assert.ok(!text.includes('"watch"'));
    assert.ok(!text.includes('watch_url'));
    assert.ok(!text.includes('example.invalid'));
  });

  test('the tree shows a pinned proxy without opening its form', () => {
    const {settingsFile} = makeProject({
      proxies: [{tag: 'claude-http', type: 'http', port: 54330, servers: [FI_TAG], pinned: true}],
    });
    const model = new ProjectModel({path: settingsFile});
    const tree = model.treeSpec();
    const proxies = tree.children.find((node) => node.key === 'proxies');
    const mark = proxies.children[0].title;

    assert.match(mark, /claude-http/);
    assert.match(mark, /выход зафиксирован/);
  });
});

describe('external API block', () => {
  test('a disabled API emits nothing at all', () => {
    assert.equal(clashApiBlock(undefined, 'secret'), null);
    assert.equal(clashApiBlock({enabled: false}, 'secret'), null);
    assert.equal(clashApiBlock({}, 'secret'), null);
  });

  test('an enabled API on loopback with a secret builds the block', () => {
    assert.deepEqual(clashApiBlock({enabled: true, controller: '127.0.0.1:9090'}, 'hunter2'), {
      external_controller: '127.0.0.1:9090',
      secret: 'hunter2',
    });
    // The default controller is loopback as well.
    assert.equal(clashApiBlock({enabled: true}, 'x').external_controller, '127.0.0.1:9090');
  });

  test('a non-loopback controller is refused with a reason', () => {
    assert.throws(
      () => clashApiBlock({enabled: true, controller: '0.0.0.0:9090'}, 'x'),
      (error) => error instanceof ConfigError && /обратную петлю/.test(error.message),
    );
  });

  test('an enabled API with an empty secret is refused', () => {
    assert.throws(
      () => clashApiBlock({enabled: true}, ''),
      (error) => error instanceof ConfigError && /секрет пуст/.test(error.message),
    );
  });

  test('a disabled API keeps config.json byte-identical to a config without the key', () => {
    const {dir} = makeProject();
    const settingsFile = path.join(dir, 'webui.json');

    const withKey = generateConfigFile(settingsFile, {output: path.join(dir, 'with.json')});
    assert.ok(!('experimental' in withKey.config));

    // The same profile, but with an explicitly disabled section: no bytes move.
    const explicit = generateConfigFile(settingsFile, {output: path.join(dir, 'explicit.json')});
    assert.deepEqual(
      fs.readFileSync(path.join(dir, 'with.json')),
      fs.readFileSync(path.join(dir, 'explicit.json')),
    );
  });

  test('an enabled API adds experimental.clash_api and keeps the bytes otherwise', () => {
    const {dir} = makeProject({clash_api: {enabled: true, controller: '127.0.0.1:9090'}});

    const {config, outputFile} = generateConfigFile(path.join(dir, 'webui.json'), {
      output: path.join(dir, 'config.json'),
      apiSecret: 'top-secret',
    });

    assert.deepEqual(config.experimental, {
      clash_api: {external_controller: '127.0.0.1:9090', secret: 'top-secret'},
    });

    const text = fs.readFileSync(outputFile, 'utf8');
    assert.ok(text.endsWith('}'), 'no trailing newline, as the core always wrote it');
    assert.ok(!text.includes('pinned'));

    // Enabled may not be written without a secret, whatever the call site.
    assert.throws(
      () => generateConfigFile(path.join(dir, 'webui.json'), {output: path.join(dir, 'x.json'), apiSecret: ''}),
      /секрет пуст/,
    );
  });
});

describe('testInbound goes through the inbound', () => {
  test('an http inbound is probed with curl -x http://…', async () => {
    const dir = makeTempDir();
    const log = path.join(dir, 'argv.log');
    const env = fakeSystemEnv({FAKE_CURL_ARGV_LOG: log});

    const result = await testInbound({env, listenIp: '127.0.0.1', port: 54330, proxyType: 'http'});

    assert.equal(result.ok, true);
    assert.equal(result.proxyUrl, 'http://127.0.0.1:54330');
    const argv = JSON.parse(fs.readFileSync(log, 'utf8').trim());
    assert.deepEqual(argv.slice(0, 2), ['-x', 'http://127.0.0.1:54330']);
    assert.ok(argv.includes('-w'));
    assert.equal(argv[argv.length - 1], DEFAULT_WATCH_URL, 'the neutral target by default');
  });

  test('a socks inbound is probed with socks5h so the name travels', async () => {
    const result = await testInbound({
      env: fakeSystemEnv(),
      listenIp: '127.0.0.1',
      port: 54321,
      proxyType: 'socks',
    });
    assert.equal(result.proxyUrl, 'socks5h://127.0.0.1:54321');
  });

  test('a refused connection and a timeout are reported, not thrown', async () => {
    const failed = await testInbound({
      env: fakeSystemEnv({FAKE_CURL_MODE: 'fail'}),
      port: 54321,
      proxyType: 'http',
    });
    assert.equal(failed.ok, false);
    assert.match(failed.stderr, /Connection refused/);

    const timedOut = await testInbound({
      env: fakeSystemEnv({FAKE_CURL_MODE: 'timeout'}),
      port: 54321,
      proxyType: 'http',
    });
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.timedOut, true);
  });
});

describe('clash API client', () => {
  test('the inbound of a connection is read from every plausible spelling', () => {
    assert.deepEqual(connectionInbound({metadata: {inboundTag: 'claude-http'}}), {
      tag: 'claude-http',
      port: null,
    });
    assert.deepEqual(connectionInbound({metadata: {inboundName: 'main-socks'}}), {
      tag: 'main-socks',
      port: null,
    });
    assert.deepEqual(connectionInbound({metadata: {inboundPort: 54323}}), {
      tag: null,
      port: 54323,
    });
    assert.deepEqual(connectionInbound({inbound: 'direct'}), {tag: 'direct', port: null});
  });

  test('a connection matches by tag or by port, never by accident', () => {
    assert.equal(connectionMatches({metadata: {inboundTag: 'claude-http'}}, {tag: 'claude-http'}), true);
    assert.equal(connectionMatches({metadata: {inboundTag: 'other'}}, {tag: 'claude-http'}), false);
    assert.equal(connectionMatches({metadata: {inboundPort: 54330}}, {tag: null, port: 54330}), true);
    assert.equal(connectionMatches({metadata: {inboundPort: 1}}, {tag: 'claude-http', port: 54330}), false);
  });

  test('only the connections of the requested inbound are closed', async () => {
    const closed = [];
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/connections') {
        assert.equal(req.headers.authorization, 'Bearer s3cret');
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            connections: [
              {id: 'a', metadata: {inboundTag: 'claude-http'}},
              {id: 'b', metadata: {inboundName: 'main-socks'}},
              {id: 'c', metadata: {inboundPort: 54330}},
              {id: 'd', metadata: {inboundTag: 'claude-http'}},
            ],
          }),
        );
        return;
      }
      if (req.method === 'DELETE' && req.url.startsWith('/connections/')) {
        closed.push(req.url.slice('/connections/'.length));
        res.statusCode = 204;
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const outcome = await closeInboundConnections(
        `127.0.0.1:${port}`,
        's3cret',
        {tag: 'claude-http', port: 54330},
      );

      assert.equal(outcome.total, 4);
      assert.deepEqual(closed.sort(), ['a', 'c', 'd'], 'main-socks (b) is untouched');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('the watchdog ladder and its fuses', () => {
  /**
   * Builds a watchdog over a fake clock and a queue of check outcomes.
   *
   * @param {{results?: string[], watchdog?: Record<string, unknown>, api?: Record<string, unknown>}} [options]
   * @returns {Record<string, unknown>}
   */
  function harness(options = {}) {
    const results = [...(options.results ?? [])];
    const closed = [];
    let restarts = 0;
    let clock = 1_000_000;
    const context = {
      watchdog: {
        enabled: true,
        interval_seconds: 600,
        failures_before_action: 2,
        pause_seconds: 1800,
        max_restarts_per_day: 3,
        restart_enabled: true,
        ...(options.watchdog ?? {}),
      },
      api: {enabled: true, controller: '127.0.0.1:9090', secret: 's', ...(options.api ?? {})},
      listenIp: '127.0.0.1',
      proxies: [
        {tag: 'claude-http', type: 'http', port: 54330, watch: true, pinned: true, url: DEFAULT_WATCH_URL},
      ],
    };

    const watchdog = new Watchdog({
      context: () => context,
      now: () => clock,
      logger: () => {},
      runner: async () => {
        const mode = results.shift() ?? 'ok';
        return {ok: mode === 'ok', timedOut: mode === 'timeout', error: mode === 'ok' ? null : 'refused'};
      },
      api: {
        closeInboundConnections: async (controller, secret, proxy) => {
          closed.push(proxy);
          return {closed: 2};
        },
      },
      restart: async () => {
        restarts += 1;
        return {ok: true};
      },
    });

    return {
      watchdog,
      context,
      closed,
      get restarts() {
        return restarts;
      },
      advance(seconds) {
        clock += seconds * 1000;
      },
    };
  }

  test('the first rung fires after two failures, the second after the third', async () => {
    const h = harness({results: ['fail', 'fail', 'fail']});

    await h.watchdog.checkAll();
    assert.equal(h.closed.length, 0, 'one failure is not enough');
    assert.equal(h.restarts, 0);

    await h.watchdog.checkAll();
    assert.equal(h.closed.length, 1, 'the second failure closes this proxy only');
    assert.deepEqual(h.closed[0], {tag: 'claude-http', port: 54330});
    assert.equal(h.restarts, 0, 'the daemon is not restarted yet');

    h.advance(1801); // past the 30-minute pause
    await h.watchdog.checkAll();
    assert.equal(h.restarts, 1, 'the third failure restarts the daemon');
  });

  test('the pause between two actions of one proxy is respected', async () => {
    const h = harness({results: ['fail', 'fail', 'fail']});
    await h.watchdog.checkAll();
    await h.watchdog.checkAll(); // rung 1 at t0
    assert.equal(h.closed.length, 1);

    h.advance(600); // ten minutes: less than the pause, more than the interval
    await h.watchdog.checkAll();

    assert.equal(h.restarts, 0, 'the restart waited for the pause');
    const snapshot = h.watchdog.snapshot();
    assert.equal(snapshot.proxies[0].paused, true);
    assert.equal(snapshot.proxies[0].label, 'в паузе');
  });

  test('the daily limit makes the watchdog give up, and the state says so', async () => {
    const h = harness({results: ['fail', 'fail', 'fail', 'fail'], watchdog: {max_restarts_per_day: 1}});

    await h.watchdog.checkAll(); // 1
    await h.watchdog.checkAll(); // 2 → close
    h.advance(1801);
    await h.watchdog.checkAll(); // 3 → restart (1 of 1)
    assert.equal(h.restarts, 1);
    h.advance(1801);
    await h.watchdog.checkAll(); // 4 → given up

    assert.equal(h.restarts, 1, 'no second restart');
    const snapshot = h.watchdog.snapshot();
    assert.equal(snapshot.proxies[0].givenUp, true);
    assert.equal(snapshot.proxies[0].label, 'сдаюсь');
    assert.ok(snapshot.history.some((event) => /сдаюсь/.test(event.reason)));
  });

  test('with the global switch off nothing happens, even with watch: true', async () => {
    const h = harness({results: ['fail', 'fail', 'fail'], watchdog: {enabled: false}});

    const run = await h.watchdog.checkAll();

    assert.equal(run.skipped, 'disabled');
    assert.equal(run.checked, 0);
    assert.equal(h.closed.length, 0);
    assert.equal(h.restarts, 0);
  });

  test('a success clears the counters and marks the action as having helped', async () => {
    const h = harness({results: ['fail', 'fail', 'ok']});
    await h.watchdog.checkAll();
    await h.watchdog.checkAll(); // close
    const run = await h.watchdog.checkAll(); // recovered

    const last = run.events[0];
    assert.equal(last.check, 'ok');
    assert.equal(last.helped, true);
    const snapshot = h.watchdog.snapshot();
    assert.equal(snapshot.proxies[0].failures, 0);
    assert.equal(snapshot.proxies[0].rung, 0);
  });

  test('reset forgets the history, the counters and the restarts', async () => {
    const h = harness({results: ['fail', 'fail']});
    await h.watchdog.checkAll();
    await h.watchdog.checkAll();
    assert.ok(h.watchdog.snapshot().history.length > 0);

    h.watchdog.reset();

    const snapshot = h.watchdog.snapshot();
    assert.deepEqual(snapshot.history, []);
    assert.equal(snapshot.proxies[0].failures, 0);
    assert.equal(snapshot.restartsLastDay, 0);
  });

  test('the defaults of the task are the ones the panel shows', () => {
    assert.deepEqual(normalizeWatchdog(undefined), {
      enabled: false,
      intervalSeconds: 600,
      failuresBeforeAction: 2,
      pauseSeconds: 1800,
      maxRestartsPerDay: 3,
      restartEnabled: false,
    });
  });
});

describe('watchdog over HTTP', () => {
  /**
   * Starts the editor over a temporary project with the fake binaries, including
   * the fake `curl`.
   *
   * @param {{system?: Record<string, string>, overrides?: Record<string, unknown>}} [options]
   * @returns {Promise<Record<string, unknown>>}
   */
  async function startEditor(options = {}) {
    const dir = makeTempDir();
    const linksFile = writeLinksFile(dir);
    const settingsFile = writeSettings(dir, options.overrides ?? {});
    const stateDir = path.join(dir, 'state');

    const env = {
      ...fakeSystemEnv(options.system),
      GATEHOUSE_SETTINGS: settingsFile,
      GATEHOUSE_HOST: '127.0.0.1',
      GATEHOUSE_PORT: '0',
      GATEHOUSE_STATE_DIR: stateDir,
    };
    const {server, model, url} = await startServer({env});

    return {
      dir,
      env,
      settingsFile,
      stateDir,
      model,
      linksFile,
      base: url.replace(/\/$/, ''),
      configPath: path.join(dir, 'config.json'),
      async close() {
        await new Promise((resolve) => server.close(resolve));
      },
    };
  }

  /** Posts a form the way htmx does. */
  async function post(base, route, fields = {}) {
    return fetch(`${base}${route}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded', 'HX-Request': 'true'},
      body: new URLSearchParams(fields),
      redirect: 'manual',
    });
  }

  test('the watchdog panel is reachable and explains the ladder', async () => {
    const editor = await startEditor();
    try {
      const page = await (await fetch(`${editor.base}/`)).text();
      assert.match(page, /Сторож/);

      const panel = await (await fetch(`${editor.base}/panel/watchdog`)).text();
      assert.ok(!panel.includes('Неизвестный раздел'));
      assert.match(panel, /Общий рубильник/);
      assert.match(panel, /через сам инбаунд/);
      assert.match(panel, /перезапуск рвёт соединения у <strong>всех<\/strong>/);
    } finally {
      await editor.close();
    }
  });

  test('the settings form takes, and a disabled watchdog reports that it did nothing', async () => {
    const editor = await startEditor();
    try {
      const applied = await post(editor.base, '/watchdog', {
        enabled: '1',
        interval_seconds: '600',
        failures_before_action: '2',
        pause_seconds: '1800',
        max_restarts_per_day: '3',
      });
      assert.match(await applied.text(), /применены/);
      assert.equal(editor.model.watchdogValues().enabled, true);

      const checked = await post(editor.base, '/watchdog/check');
      assert.match(await checked.text(), /выключен|Проверено прокси/);

      const reset = await post(editor.base, '/watchdog/reset');
      assert.match(await reset.text(), /сброшено/);
    } finally {
      await editor.close();
    }
  });

  test('a pass checks a watched proxy and writes neither config file', async () => {
    const editor = await startEditor({
      system: {FAKE_CURL_MODE: 'fail'},
      overrides: {
        watchdog: {enabled: true, failures_before_action: 3, interval_seconds: 600},
        proxies: [
          {tag: 'claude-http', type: 'http', port: 54330, servers: [FI_TAG], pinned: true, watch: true},
        ],
      },
    });
    try {
      // A real config on disk, so a stray write would be visible.
      await post(editor.base, '/save', {panel: 'singbox'});
      await post(editor.base, '/generate', {});

      const webuiBefore = digest(editor.settingsFile);
      const configBefore = digest(editor.configPath);

      const response = await post(editor.base, '/watchdog/check');
      const html = await response.text();

      assert.match(html, /Проверено прокси: 1/);
      assert.match(html, /не отвечает/, 'the failure is visible in the table');

      assert.equal(digest(editor.settingsFile), webuiBefore, 'webui.json changed by a check');
      assert.equal(digest(editor.configPath), configBefore, 'config.json changed by a check');
    } finally {
      await editor.close();
    }
  });
});

// HTTP tests of the system layer of the editor.
//
// Everything host-facing goes through the fake binaries: no sing-box, no
// systemd, no journalctl, no root and no network. The server is started for real
// (so the environment variables, the auth middleware and the SSE handlers are all
// covered) and spoken to with `fetch`.
//
// Covered here, because these are the acceptance points of the task:
//   * the server refuses to start on a non-loopback address without a token;
//   * a token protects every route, the SSE endpoints included;
//   * the restart is not offered — and not accepted — unless the check passed;
//   * the rollback restores `config.json` byte for byte;
//   * an SSE stream kills its child process when the browser goes away.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {listConfigSnapshots} from '../src/model/storage.mjs';
import {journalStreamCount} from '../src/system/index.mjs';
import {startServer} from '../src/web/server.mjs';
import {makeTempDir, fakeSystemEnv, writeLinksFile, writeSettings} from './helpers.mjs';

/**
 * Starts the editor over a temporary project, with the system layer pointed at
 * the fake binaries.
 *
 * @param {{system?: Record<string, string>, host?: string, token?: string}} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
async function startEditor(options = {}) {
  const dir = makeTempDir();
  const linksFile = writeLinksFile(dir);
  const settingsFile = writeSettings(dir);
  const stateDir = path.join(dir, 'state');

  const env = {
    ...fakeSystemEnv(options.system),
    SINGBOX_WEBUI_SETTINGS: settingsFile,
    SINGBOX_WEBUI_HOST: options.host ?? '127.0.0.1',
    SINGBOX_WEBUI_PORT: '0',
    SINGBOX_WEBUI_STATE_DIR: stateDir,
  };
  if (options.token) env.SINGBOX_WEBUI_TOKEN = options.token;

  const {server, model, url} = await startServer({env});

  return {
    dir,
    env,
    settingsFile,
    stateDir,
    model,
    base: url.replace(/\/$/, ''),
    configPath: path.join(dir, 'config.json'),
    async close() {
      // A lingering stream would keep a child alive and hang the test process.
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * POSTs a form the way htmx does it, without following the redirect.
 *
 * @param {string} base
 * @param {string} route
 * @param {Record<string, string>} [fields]
 * @param {Record<string, string>} [headers]
 * @returns {Promise<Response>}
 */
async function post(base, route, fields = {}, headers = {}) {
  const body = new URLSearchParams(fields);
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'HX-Request': 'true',
      ...headers,
    },
    body,
    redirect: 'manual',
  });
}

/**
 * Polls `check` until it is true or the budget runs out.
 *
 * @param {() => boolean} check
 * @param {number} [timeout]
 * @returns {Promise<boolean>}
 */
async function waitFor(check, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

/** True when a process with this pid no longer exists. */
function isGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

describe('authentication configuration', () => {
  test('a non-loopback bind without a token refuses to start', async () => {
    const dir = makeTempDir();
    const settingsFile = writeSettings(dir);

    await assert.rejects(
      startServer({
        env: {
          SINGBOX_WEBUI_SETTINGS: settingsFile,
          SINGBOX_WEBUI_HOST: '10.95.2.1',
          SINGBOX_WEBUI_PORT: '0',
        },
      }),
      (error) =>
        /отказ запуска/.test(error.message) &&
        /не адрес обратной петли/.test(error.message) &&
        /SINGBOX_WEBUI_TOKEN/.test(error.message),
    );
  });

  test('0.0.0.0 is not loopback either', async () => {
    const dir = makeTempDir();
    const settingsFile = writeSettings(dir);

    await assert.rejects(
      startServer({
        env: {SINGBOX_WEBUI_SETTINGS: settingsFile, SINGBOX_WEBUI_HOST: '0.0.0.0', SINGBOX_WEBUI_PORT: '0'},
      }),
      /отказ запуска/,
    );
  });

  test('a token makes the bind acceptable, and every route is behind it', async () => {
    const editor = await startEditor({host: '0.0.0.0', token: 'secret-token'});
    try {
      const anonymous = await fetch(`${editor.base}/`);
      assert.equal(anonymous.status, 401);

      const wrong = await fetch(`${editor.base}/`, {headers: {Authorization: 'Bearer nope'}});
      assert.equal(wrong.status, 401);

      const bearer = await fetch(`${editor.base}/`, {
        headers: {Authorization: 'Bearer secret-token'},
      });
      assert.equal(bearer.status, 200);

      // The SSE endpoint of the journal is a route like any other: leaving it open
      // would hand a stranger a `journalctl -f` process on the host.
      const stream = await fetch(`${editor.base}/journal/stream`);
      assert.equal(stream.status, 401);
    } finally {
      await editor.close();
    }
  });

  test('a token in the query string works and is remembered in a cookie', async () => {
    const editor = await startEditor({host: '0.0.0.0', token: 'secret-token'});
    try {
      const response = await fetch(`${editor.base}/?token=secret-token`);
      assert.equal(response.status, 200);
      const cookie = response.headers.get('set-cookie') ?? '';
      assert.match(cookie, /singbox_webui_token=secret-token/);
      assert.match(cookie, /HttpOnly/i);

      const followUp = await fetch(`${editor.base}/`, {headers: {Cookie: 'singbox_webui_token=secret-token'}});
      assert.equal(followUp.status, 200);
    } finally {
      await editor.close();
    }
  });
});

describe('check and restart gating', () => {
  test('the restart is neither offered nor accepted before a successful check', async () => {
    const editor = await startEditor();
    try {
      const panel = await (await fetch(`${editor.base}/panel/system`)).text();
      assert.doesNotMatch(panel, /hx-post="\/restart"/);
      assert.match(panel, /Кнопка перезапуска появится/);

      const refused = await post(editor.base, '/restart');
      assert.match(await refused.text(), /перезапуск не предлагается/);
      assert.equal(fs.existsSync(path.join(editor.stateDir, 'snapshots')), false);
    } finally {
      await editor.close();
    }
  });

  test('check without a generated config is refused with the reason', async () => {
    const editor = await startEditor();
    try {
      const response = await post(editor.base, '/check');
      assert.match(await response.text(), /config\.json ещё не сгенерирован/);
    } finally {
      await editor.close();
    }
  });

  test('a passing check enables the restart, a failing one does not', async () => {
    const editor = await startEditor();
    try {
      await post(editor.base, '/save', {panel: 'output'});
      await post(editor.base, '/generate', {});

      const checked = await post(editor.base, '/check');
      const checkedHtml = await checked.text();
      assert.match(checkedHtml, /Схема принята/);
      assert.match(checkedHtml, /не доказательство корректности/);
      assert.match(checkedHtml, /hx-post="\/restart"/, 'the restart button is now drawn');

      const restarted = await post(editor.base, '/restart');
      assert.match(await restarted.text(), /перезапущен/);

      // Now break the config on disk: the check has to fail and the button must go.
      fs.writeFileSync(editor.configPath, '{"marker": "__check_fail__"}');
      const failed = await post(editor.base, '/check');
      const failedHtml = await failed.text();
      assert.match(failedHtml, /Проверка не прошла/);
      assert.match(failedHtml, /unknown inbound type/);
      assert.doesNotMatch(failedHtml, /hx-post="\/restart"/);

      const afterFailure = await post(editor.base, '/restart');
      assert.match(await afterFailure.text(), /перезапуск не предлагается/);
    } finally {
      await editor.close();
    }
  });

  test('generating a new config invalidates the previous check', async () => {
    const editor = await startEditor();
    try {
      await post(editor.base, '/save', {panel: 'output'});
      await post(editor.base, '/generate', {});
      await post(editor.base, '/check');
      assert.match(await (await fetch(`${editor.base}/panel/system`)).text(), /hx-post="\/restart"/);

      // New bytes: the old check judged a different file.
      editor.model.applyGeneral({listen_ip: '10.0.0.9'});
      editor.model.save();
      await post(editor.base, '/generate', {});

      const panel = await (await fetch(`${editor.base}/panel/system`)).text();
      assert.doesNotMatch(panel, /hx-post="\/restart"/);
    } finally {
      await editor.close();
    }
  });
});

describe('rollback', () => {
  test('restores the previous config.json byte for byte', async () => {
    const editor = await startEditor();
    try {
      await post(editor.base, '/save', {panel: 'output'});
      await post(editor.base, '/generate', {});
      const first = fs.readFileSync(editor.configPath);

      // A second generation is what takes the snapshot of the first file.
      editor.model.applyGeneral({listen_ip: '10.0.0.9'});
      editor.model.save();
      await post(editor.base, '/generate', {});
      const second = fs.readFileSync(editor.configPath);

      assert.notDeepEqual(first, second, 'the two generations really differ');
      assert.equal(listConfigSnapshots(editor.stateDir).length, 1);

      const response = await post(editor.base, '/rollback');
      const html = await response.text();
      assert.match(html, /Восстановлен/);
      assert.match(html, /sing-box перезапущен/);

      assert.deepEqual(
        fs.readFileSync(editor.configPath),
        first,
        'the rollback must bring back the exact bytes the daemon was running',
      );
    } finally {
      await editor.close();
    }
  });

  test('the rollback is refused when there is nothing to restore', async () => {
    const editor = await startEditor();
    try {
      const response = await post(editor.base, '/rollback');
      assert.match(await response.text(), /снапшотов config\.json ещё нет/);
    } finally {
      await editor.close();
    }
  });
});

describe('live journal over SSE', () => {
  test('the child process dies when the connection is closed', async () => {
    const dir = makeTempDir();
    const pidFile = path.join(dir, 'journalctl.pid');
    const editor = await startEditor({system: {FAKE_JOURNALCTL_PIDFILE: pidFile}});

    try {
      const controller = new AbortController();
      const response = await fetch(`${editor.base}/journal/stream`, {signal: controller.signal});
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

      const reader = response.body.getReader();
      const first = await reader.read();
      assert.ok(!first.done);
      assert.match(new TextDecoder().decode(first.value), /event: hello/);

      assert.ok(await waitFor(() => fs.existsSync(pidFile)), 'the fake wrote its pid');
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      assert.ok(pid > 0);
      assert.equal(isGone(pid), false, 'the child is running while the stream is open');
      assert.equal(journalStreamCount(), 1);

      // The browser goes away — a page reload, a closed tab.
      controller.abort();

      assert.ok(await waitFor(() => isGone(pid)), 'the journalctl -f child was killed');
      assert.ok(await waitFor(() => journalStreamCount() === 0), 'the stream slot was released');
    } finally {
      await editor.close();
    }
  });

  test('a second concurrent stream is refused', async () => {
    const editor = await startEditor();
    try {
      const controller = new AbortController();
      const first = await fetch(`${editor.base}/journal/stream`, {signal: controller.signal});
      assert.equal(first.status, 200);
      await first.body.getReader().read();

      const second = await fetch(`${editor.base}/journal/stream`);
      assert.equal(second.status, 409);
      assert.match(await second.text(), /одновременных потоков/);

      controller.abort();
      assert.ok(await waitFor(() => journalStreamCount() === 0));
    } finally {
      await editor.close();
    }
  });

  test('the live stream carries non-empty, colour-free messages', async () => {
    const editor = await startEditor();
    try {
      const controller = new AbortController();
      const response = await fetch(`${editor.base}/journal/stream`, {signal: controller.signal});
      assert.equal(response.status, 200);

      // The fake in follow mode (the default one, speaking bytes) prints a line
      // every 20ms, so a handful of reads is enough. The loop is bounded on
      // purpose: a stream that never delivers must fail, not hang the suite.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      for (let attempt = 0; attempt < 40 && !/follow line 3/.test(text); attempt += 1) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, {stream: true});
      }
      controller.abort();

      const messages = [...text.matchAll(/event: log\ndata: (\{.*\})\n/g)].map(
        (match) => JSON.parse(match[1]).message,
      );
      assert.ok(messages.length >= 2, `the stream delivered entries: ${messages.length}`);
      assert.deepEqual(
        messages.filter((message) => message.length === 0),
        [],
        'not a single blank line, which is what the panel showed on the router',
      );
      assert.deepEqual(
        messages.filter((message) => message.includes('\u001b')),
        [],
        'no ANSI escape survives into the panel',
      );
      assert.match(messages[0], /follow line 0/);
    } finally {
      await editor.close();
    }
  });
});

describe('mass outbound test over SSE', () => {
  test('streams one result per server and ends with a summary', async () => {
    const editor = await startEditor();
    try {
      await post(editor.base, '/save', {panel: 'output'});
      await post(editor.base, '/generate', {});

      const response = await fetch(`${editor.base}/tests/stream`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

      const text = await response.text();
      assert.match(text, /event: start/);
      assert.match(text, /"total":3/);
      assert.match(text, /event: result/);
      assert.match(text, /"city":"Limassol"/);
      assert.match(text, /event: done/);
      assert.match(text, /"done":3/);
    } finally {
      await editor.close();
    }
  });

  test('the tests panel lists the servers of the profile', async () => {
    const editor = await startEditor();
    try {
      const panel = await (await fetch(`${editor.base}/panel/tests`)).text();
      assert.match(panel, /Проверить все серверы профиля \(3\)/);
      assert.match(panel, /Одновременно запускается не больше/);
    } finally {
      await editor.close();
    }
  });
});

describe('system panels render', () => {
  test('the system node and its panels are reachable', async () => {
    const editor = await startEditor();
    try {
      const page = await (await fetch(`${editor.base}/`)).text();
      assert.match(page, /Система/);

      for (const kind of ['system', 'journal', 'tests']) {
        const response = await fetch(`${editor.base}/panel/${kind}`);
        assert.equal(response.status, 200, kind);
        assert.ok(!(await response.text()).includes('Неизвестный раздел'), kind);
      }
    } finally {
      await editor.close();
    }
  });
});

// System boundary tests.
//
// Stage 3 implements the five calls, so these tests exercise the real bodies
// against the fake binaries of `tests/fixtures/bin/`. No sing-box, no router, no
// root, no network: the paths come from the environment (`fakeSystemEnv`) and the
// fakes repeat the output shapes measured on the router.
//
// The mandatory checks of the task live here or in `system-web.test.mjs`:
//   * an emoji tag with spaces reaches the binary as ONE argument;
//   * a live journal stream is killed when nobody reads it any more;
//   * the concurrency cap of the mass test holds.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {
  DEFAULT_JOURNAL_LINES,
  DEFAULT_TEST_CONCURRENCY,
  SystemError,
  checkConfig,
  followJournal,
  geositeLookup,
  journalStreamCount,
  mapWithConcurrency,
  parseJournal,
  parseJournalLine,
  parseLastJsonObject,
  priorityLevel,
  restartSingBox,
  systemConfig,
  tailJournal,
  testOutbound,
  testOutbounds,
} from '../src/system/index.mjs';
import {FI_TAG, fakeSystemEnv, makeTempDir} from './helpers.mjs';

/** The five calls of the boundary that stage 3 had to implement. */
const PROMISED = ['checkConfig', 'geositeLookup', 'restartSingBox', 'tailJournal', 'testOutbound'];

describe('system boundary: shape of the module', () => {
  test('the promised calls still exist and are functions', async () => {
    const module = await import('../src/system/index.mjs');
    for (const name of PROMISED) {
      assert.equal(typeof module[name], 'function', `${name} must stay exported`);
    }
  });

  test('the stage marker is gone: nothing pretends to be unimplemented', async () => {
    const module = await import('../src/system/index.mjs');
    const stubbed = Object.entries(module)
      .filter(([, value]) => typeof value === 'function')
      .filter(([, value]) => value.toString().includes('STAGE_MARKER'));
    assert.deepEqual(stubbed, []);
    assert.notEqual(module.STAGE_MARKER, undefined, 'kept for old callers');
  });

  test('systemConfig reads the environment and falls back to the router defaults', () => {
    const config = systemConfig({}, {});
    assert.equal(config.singbox, '/usr/local/bin/sing-box');
    assert.equal(config.systemctl, '/usr/bin/systemctl');
    assert.equal(config.journalctl, '/usr/bin/journalctl');
    assert.equal(config.unit, 'sing-box');
    assert.equal(config.testUrl, 'https://ipinfo.io');
    assert.equal(config.testConcurrency, DEFAULT_TEST_CONCURRENCY);

    const overridden = systemConfig({SINGBOX_WEBUI_UNIT: 'sing-box-test', SINGBOX_WEBUI_TEST_CONCURRENCY: '2'});
    assert.equal(overridden.unit, 'sing-box-test');
    assert.equal(overridden.testConcurrency, 2);
  });
});

describe('parsing', () => {
  test('the last JSON object wins, log lines in front of it are ignored', () => {
    const mixed = [
      '+0000 INFO outbound/vless[🇨🇾 Cyprus - Limassol]: outbound connection to ipinfo.io:443',
      '{',
      '  "ip": "194.55.164.202",',
      '  "city": "Limassol"',
      '}',
    ].join('\n');

    assert.deepEqual(parseLastJsonObject(mixed), {ip: '194.55.164.202', city: 'Limassol'});
  });

  test('a later object wins over an earlier one', () => {
    const text = '{"step": 1}\nnoise\n{"step": 2}\n';
    assert.deepEqual(parseLastJsonObject(text), {step: 2});
  });

  test('braces inside strings do not end the object early', () => {
    const text = '{"note": "a } brace", "city": "Limassol"}';
    assert.deepEqual(parseLastJsonObject(text), {note: 'a } brace', city: 'Limassol'});
  });

  test('no JSON at all gives null instead of throwing', () => {
    assert.equal(parseLastJsonObject('INFO nothing here\n'), null);
    assert.equal(parseLastJsonObject(''), null);
  });

  test('systemd PRIORITY maps to level names, unknown values to info', () => {
    assert.equal(priorityLevel('3'), 'err');
    assert.equal(priorityLevel('6'), 'info');
    assert.equal(priorityLevel('99'), 'info');
    assert.equal(priorityLevel(undefined), 'info');
  });

  test('a journal line becomes time, level, message and pid', () => {
    const entry = parseJournalLine(
      JSON.stringify({
        __REALTIME_TIMESTAMP: '1726300000000000',
        PRIORITY: '4',
        MESSAGE: 'handshake failed',
        SYSLOG_IDENTIFIER: 'sing-box',
        _PID: '4321',
      }),
    );

    assert.equal(entry.level, 'warning');
    assert.equal(entry.message, 'handshake failed');
    assert.equal(entry.pid, '4321');
    assert.match(entry.time, /^2024-09-1/);
  });

  test('a non-JSON line is skipped, not fatal', () => {
    assert.equal(parseJournalLine('-- Journal begins --'), null);
    assert.equal(parseJournalLine('{not json'), null);
    assert.deepEqual(parseJournal('garbage\n{"MESSAGE":"x","PRIORITY":"6"}\n'), [
      {time: '', level: 'info', priority: 6, message: 'x', identifier: '', pid: null},
    ]);
  });
});

describe('checkConfig', () => {
  test('a good config is accepted with exit 0', async () => {
    const dir = makeTempDir();
    const config = path.join(dir, 'config.json');
    fs.writeFileSync(config, '{"log": {"level": "info"}}');

    const result = await checkConfig(config, {env: fakeSystemEnv()});

    assert.equal(result.ok, true);
    assert.equal(result.code, 0);
    assert.deepEqual(result.args, ['check', '--disable-color', '-c', config]);
  });

  test('a bad config comes back as ok:false instead of an exception', async () => {
    const dir = makeTempDir();
    const config = path.join(dir, 'config.json');
    fs.writeFileSync(config, '{"marker": "__check_fail__"}');

    const result = await checkConfig(config, {env: fakeSystemEnv()});

    assert.equal(result.ok, false);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unknown inbound type/);
  });

  test('a missing binary is reported, not thrown', async () => {
    const result = await checkConfig('/tmp/x.json', {
      env: fakeSystemEnv({SINGBOX_WEBUI_SINGBOX: '/nonexistent/sing-box'}),
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /не найден/);
  });
});

describe('restartSingBox', () => {
  test('sudo -n runs systemctl restart of the configured unit', async () => {
    const dir = makeTempDir();
    const log = path.join(dir, 'argv.log');
    const env = fakeSystemEnv({FAKE_SYSTEMCTL_ARGV_LOG: log});

    const result = await restartSingBox({env});

    assert.equal(result.ok, true);
    // The whole point: the sudoers rule matches this exact command line.
    assert.deepEqual(JSON.parse(fs.readFileSync(log, 'utf8').trim()), [
      '-n',
      env.SINGBOX_WEBUI_SYSTEMCTL,
      'restart',
      'sing-box',
    ]);
  });

  test('SINGBOX_WEBUI_SUDO=none skips sudo and calls systemctl directly', async () => {
    const dir = makeTempDir();
    const log = path.join(dir, 'argv.log');
    const env = fakeSystemEnv({SINGBOX_WEBUI_SUDO: 'none', FAKE_SYSTEMCTL_ARGV_LOG: log});

    await restartSingBox({env});

    assert.deepEqual(JSON.parse(fs.readFileSync(log, 'utf8').trim()), ['restart', 'sing-box']);
  });

  test('a failing restart is reported with its stderr', async () => {
    const env = fakeSystemEnv({FAKE_SYSTEMCTL_FAIL: '1'});

    const result = await restartSingBox({env});

    assert.equal(result.ok, false);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /not found/);
  });
});

describe('tailJournal', () => {
  test('reads the requested number of lines by default', async () => {
    const result = await tailJournal(undefined, {env: fakeSystemEnv()});

    assert.equal(result.ok, true);
    assert.equal(result.lines, DEFAULT_JOURNAL_LINES);
    assert.equal(result.entries.length, DEFAULT_JOURNAL_LINES);
    // Every seventh line of the fake is a warning, so levels really are parsed.
    assert.equal(result.entries[0].level, 'warning');
    assert.equal(result.entries[1].level, 'info');
  });

  test('honours an explicit line count', async () => {
    const result = await tailJournal(3, {env: fakeSystemEnv()});
    assert.equal(result.entries.length, 3);
  });
});

describe('followJournal', () => {
  test('streams parsed entries, then stop() kills the child', async () => {
    const entries = [];
    const stream = followJournal({
      env: fakeSystemEnv(),
      lines: 1,
      onEntry: (entry) => entries.push(entry),
    });

    assert.equal(journalStreamCount(), 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(entries.length >= 2, 'the fake keeps printing');
    assert.equal(entries[0].identifier, 'sing-box');

    const child = stream.child;
    const pid = child.pid;
    stream.stop();
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.on('exit', resolve);
    });

    assert.equal(journalStreamCount(), 0, 'the stream is released');
    // The fake traps SIGTERM and exits cleanly, so the proof is the pid, not the
    // signal name: the process must be gone.
    assert.throws(
      () => process.kill(pid, 0),
      /ESRCH/,
      'the journalctl -f child was killed, not left running',
    );
  });

  test('only one live stream is allowed by default', () => {
    const first = followJournal({env: fakeSystemEnv()});
    try {
      assert.throws(
        () => followJournal({env: fakeSystemEnv()}),
        (error) => error instanceof SystemError && /одновременных потоков/.test(error.message),
      );
    } finally {
      first.stop();
    }
    assert.equal(journalStreamCount(), 0);
  });
});

describe('testOutbound', () => {
  test('an emoji tag with spaces arrives as ONE argument', async () => {
    const dir = makeTempDir();
    const log = path.join(dir, 'argv.log');
    const env = fakeSystemEnv({FAKE_SINGBOX_ARGV_LOG: log});

    const result = await testOutbound(FI_TAG, {
      env,
      configPath: '/etc/sing-box/config.json',
      url: 'https://ipinfo.io',
    });

    const argv = JSON.parse(fs.readFileSync(log, 'utf8').trim());
    assert.deepEqual(argv, [
      'tools',
      'fetch',
      '-c',
      '/etc/sing-box/config.json',
      '-o',
      FI_TAG,
      'https://ipinfo.io',
    ]);
    assert.equal(argv[5], FI_TAG, 'the tag is not split and not quoted by hand');
    // A shell string would have broken this line into three arguments.
    assert.equal(argv.filter((item) => item === FI_TAG).length, 1);

    assert.equal(result.ok, true);
    assert.equal(result.city, 'Limassol');
    assert.equal(result.ip, '194.55.164.202');
  });

  test('the JSON body is found behind the interleaved service lines', async () => {
    const result = await testOutbound(FI_TAG, {env: fakeSystemEnv(), configPath: '/tmp/config.json'});

    assert.equal(result.parsed, true);
    assert.match(result.stdout, /outbound connection to/);
    assert.match(result.org, /CLOUDLAYER8/);
  });

  test('a failing server is ok:false with its stderr, not an exception', async () => {
    const result = await testOutbound('🇩🇪 fails', {env: fakeSystemEnv(), configPath: '/tmp/config.json'});

    assert.equal(result.ok, false);
    assert.match(result.stderr, /connection refused/);
  });

  test('a timeout is reported as such', async () => {
    const env = fakeSystemEnv({FAKE_SINGBOX_DELAY_MS: '1000'});

    const result = await testOutbound(FI_TAG, {env, configPath: '/tmp/config.json', timeout: 50});

    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.match(result.error, /таймаут/);
  });
});

describe('mass run: concurrency and order', () => {
  test('mapWithConcurrency keeps the order and never exceeds the cap', async () => {
    const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    let active = 0;
    let peak = 0;

    const results = await mapWithConcurrency(items, 3, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return item * 2;
    });

    assert.equal(peak, 3, 'three at a time, never more');
    assert.deepEqual(results, items.map((item) => item * 2));
  });

  test('testOutbounds respects the cap of the configuration', async () => {
    let active = 0;
    let peak = 0;
    const seen = [];

    const {results, concurrency} = await testOutbounds(['a', 'b', 'c', 'd', 'e'], {
      env: fakeSystemEnv({SINGBOX_WEBUI_TEST_CONCURRENCY: '2'}),
      onResult: (result) => seen.push(result.tag),
      runner: async (tag) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return {tag, ok: true, elapsed: 5};
      },
    });

    assert.equal(concurrency, 2);
    assert.ok(peak <= 2, `peak was ${peak}`);
    assert.deepEqual(results.map((result) => result.tag), ['a', 'b', 'c', 'd', 'e']);
    assert.equal(seen.length, 5, 'progress is reported once per server');
  });

  test('an aborted run stops handing out work', async () => {
    const controller = new AbortController();
    let started = 0;

    const {results, aborted} = await testOutbounds(['a', 'b', 'c', 'd', 'e', 'f'], {
      env: fakeSystemEnv(),
      concurrency: 1,
      signal: controller.signal,
      runner: async (tag) => {
        started += 1;
        if (started === 2) controller.abort();
        return {tag, ok: true, elapsed: 1};
      },
    });

    assert.equal(aborted, true);
    assert.ok(results.length < 6, `stopped early after ${results.length} results`);
  });
});

describe('geositeLookup', () => {
  test('a missing database becomes a sentence, not a bare FATAL', async () => {
    const result = await geositeLookup('telegram.org', {env: fakeSystemEnv()});

    assert.equal(result.ok, false);
    assert.equal(result.available, false);
    assert.match(result.message, /база geosite не установлена/);
    assert.match(result.message, /rule-sets/);
    assert.doesNotMatch(result.message, /FATAL/);
  });
});

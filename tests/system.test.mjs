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

// The defect seen on the router: every line of the panel showed its time and level
// and an empty text. `journalctl -o json` sends a value containing non-printable
// bytes as an ARRAY of numbers, and sing-box colours every line, so the message of
// every entry arrived as an array and the old `typeof entry.MESSAGE === 'string'`
// turned it into ''. The fixture used to print a clean string, which is why the
// suite never noticed — the fake now speaks bytes (see tests/fixtures/bin/journalctl).
describe('journal MESSAGE: the bytes of a real journald', () => {
  // The line as the router shows it: offset, date, time, the level wrapped in ANSI
  // colour, then the text.
  const REAL_BYTES = [
    ...Buffer.from(
      '+0000 2026-09-14 12:42:18 \u001b[36mINFO\u001b[0m [...] inbound/http[claude]: started',
      'utf8',
    ),
  ];
  const CLEAN = '[...] inbound/http[claude]: started';

  /**
   * One journald line with the given `MESSAGE` value.
   *
   * @param {unknown} message
   * @returns {string}
   */
  function line(message) {
    return JSON.stringify({
      __REALTIME_TIMESTAMP: '1726300000000000',
      PRIORITY: '6',
      MESSAGE: message,
      SYSLOG_IDENTIFIER: 'sing-box',
      _PID: '4321',
    });
  }

  test('a byte array decodes to the same text a string gives', () => {
    const fromBytes = parseJournalLine(line(REAL_BYTES));
    const fromString = parseJournalLine(line(CLEAN));

    assert.equal(fromBytes.message, CLEAN, 'the bytes are decoded, not dropped');
    assert.equal(fromBytes.message, fromString.message);
  });

  test('ANSI colour and the duplicated sing-box prefix are gone', () => {
    const entry = parseJournalLine(line(REAL_BYTES));

    assert.ok(!entry.message.includes('\u001b'), 'no ESC byte is left');
    assert.ok(!entry.message.includes('[36m'), 'no SGR parameter is left');
    assert.ok(!entry.message.includes('+0000'), 'the offset sing-box prints is cut');
    assert.ok(!entry.message.includes('INFO ['), 'the duplicated level is cut');
    assert.match(entry.message, /^\[\.\.\.\] inbound\/http/);
  });

  test('a message without the prefix is left exactly as it is', () => {
    const plain = parseJournalLine(line('handshake failed: read: connection reset by peer'));
    assert.equal(plain.message, 'handshake failed: read: connection reset by peer');

    // A date-like start is NOT the prefix (the offset is missing), so it stays.
    const datelike = parseJournalLine(line('2026-09-14 12:42:18 something happened'));
    assert.equal(datelike.message, '2026-09-14 12:42:18 something happened');

    // The same rule through a byte array, colour and all.
    const coloured = parseJournalLine(
      line([...Buffer.from('+0000 2026-09-14 12:42:18 \u001b[31mERROR\u001b[0m boom', 'utf8')]),
    );
    assert.equal(coloured.message, 'boom');
  });

  test('invalid UTF-8 in the array does not break the parse', () => {
    const entry = parseJournalLine(line([0x61, 0xff, 0xfe, 0x62]));

    assert.equal(entry.message, 'a\uFFFD\uFFFDb', 'the bad bytes become the replacement');
    assert.equal(entry.priority, 6, 'the rest of the line is still parsed');
  });

  test('a missing or unexpected MESSAGE is an empty string, never an exception', () => {
    for (const value of [undefined, null, 42, {text: 'x'}, ['x'], [undefined], [300]]) {
      assert.equal(
        parseJournalLine(line(value)).message,
        '',
        `MESSAGE ${JSON.stringify(value) ?? 'undefined'}`,
      );
    }
  });

  test('the fake journald of the suite really speaks bytes, and the tail is readable', async () => {
    const result = await tailJournal(3, {env: fakeSystemEnv()});

    assert.equal(result.entries.length, 3);
    assert.deepEqual(
      result.entries.filter((entry) => entry.message.length === 0),
      [],
      'the fixture reproduces the router: a byte array, and no blank message',
    );
    assert.equal(result.entries[0].message, '[...] tail line 0');
    assert.ok(!result.entries.some((entry) => entry.message.includes('\u001b')));
  });

  test('a plain string MESSAGE still works (FAKE_JOURNALCTL_MESSAGE=string)', async () => {
    // Ordinary units write without colour, and journald keeps their value a
    // string; that shape has to keep working.
    const result = await tailJournal(2, {
      env: fakeSystemEnv({FAKE_JOURNALCTL_MESSAGE: 'string'}),
    });

    assert.deepEqual(
      result.entries.map((entry) => entry.message),
      ['tail line 0', 'tail line 1'],
    );
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

    const child = stream.child;
    const pid = child.pid;

    // The `finally` is not decoration: a failed assertion in this block used to
    // leave `journalctl -f` running, and the test process with it.
    try {
      assert.equal(journalStreamCount(), 1);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.ok(entries.length >= 2, 'the fake keeps printing');
      assert.equal(entries[0].identifier, 'sing-box');
      assert.match(entries[0].message, /follow line \d+/, 'decoded, not a blank line');
      assert.ok(!entries[0].message.includes('\u001b'), 'the colour codes are stripped');
    } finally {
      stream.stop();
    }

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

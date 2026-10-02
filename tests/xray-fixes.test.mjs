// Fixes after the acceptance of task 18 (task 19): the `-format json` flag, the
// diagnosis line, "Xray is not running" being applied, the checked `stop xray`,
// the Xray journal unit, and the CLI guard.

import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {describe, test} from 'node:test';

import {checkXrayConfig, xrayDiagnosis} from '../src/system/index.mjs';
import {startServer} from '../src/web/server.mjs';
import {
  DEFAULT_LINKS,
  FAKE_BIN_DIR,
  FIXTURES_DIR,
  fakeSystemEnv,
  makeTempDir,
  writeSettings,
} from './helpers.mjs';

const execFileAsync = promisify(execFile);
const XRAY_FIXTURE = path.join(FIXTURES_DIR, 'providers-xray', 'stash', 'xray-configs.json');
const XRAY_BIN = path.join(FAKE_BIN_DIR, 'xray');
const REAL_XRAY = '/usr/local/bin/xray';

function post(base, route, fields = {}) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded', 'HX-Request': 'true'},
    body: new URLSearchParams(fields),
  });
}

function argvCalls(editor) {
  const log = editor.env.FAKE_SYSTEMCTL_ARGV_LOG;
  if (!log || !fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function startEditor(options = {}) {
  const dir = options.dir ?? makeTempDir();
  const providersRoot = path.join(dir, 'providers');
  const providerId = options.noXray === true ? 'vpnd' : 'stash';
  const providerDir = path.join(providersRoot, providerId);
  fs.mkdirSync(providerDir, {recursive: true});
  if (options.noXray === true) {
    fs.writeFileSync(path.join(providerDir, 'links.txt'), DEFAULT_LINKS);
  } else {
    fs.copyFileSync(XRAY_FIXTURE, path.join(providerDir, 'xray-configs.json'));
  }

  const providers =
    options.providers ??
    (options.noXray === true
      ? {vpnd: {enabled: true, kind: 'subscription'}}
      : {stash: {enabled: true, kind: 'xray'}});
  const proxies =
    options.proxies ?? [{tag: 'main', type: 'mixed', port: 54321, servers: ['de-main (de2)']}];
  const settingsFile = writeSettings(dir, {providers, proxies});

  const configPath = path.join(dir, 'config.json');
  const xrayConfigPath = path.join(dir, 'etc', 'xray', 'config.json');
  fs.mkdirSync(path.dirname(xrayConfigPath), {recursive: true});

  const env = {
    ...fakeSystemEnv({
      GATEHOUSE_XRAY: options.xrayBinary ?? XRAY_BIN,
      GATEHOUSE_XRAY_CONFIG: xrayConfigPath,
      GATEHOUSE_XRAY_UNIT: 'xray',
      FAKE_SYSTEMCTL_ACTIVE: options.active ?? '',
      ...(options.system ?? {}),
    }),
    GATEHOUSE_PROVIDERS: providersRoot,
    GATEHOUSE_SETTINGS: settingsFile,
    GATEHOUSE_STATE_DIR: path.join(dir, 'state'),
    GATEHOUSE_CONFIG: configPath,
    GATEHOUSE_HOST: '127.0.0.1',
    GATEHOUSE_PORT: '0',
  };

  const {server, model, url} = await startServer({env});
  return {
    dir,
    env,
    model,
    configPath,
    xrayConfigPath,
    base: url.replace(/\/$/, ''),
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

describe('the Xray check runs with -format json (§1)', () => {
  test('checkXrayConfig passes -format json before -c', async () => {
    const result = await checkXrayConfig('/tmp/whatever/config.json.new', {
      env: fakeSystemEnv(),
      xray: XRAY_BIN,
    });
    assert.deepEqual(result.args.slice(0, 4), ['run', '-test', '-format', 'json']);
    assert.equal(result.args[result.args.length - 1], '/tmp/whatever/config.json.new');
  });

  test('the REAL xray accepts a `.new` file with the flag', async (t) => {
    if (!fs.existsSync(REAL_XRAY)) {
      t.skip(`${REAL_XRAY} not installed`);
      return;
    }
    const dir = makeTempDir();
    const file = path.join(dir, 'config.json.new');
    fs.writeFileSync(
      file,
      JSON.stringify({
        log: {loglevel: 'warning'},
        inbounds: [{tag: 'in-20800', protocol: 'socks', listen: '127.0.0.1', port: 20800, settings: {udp: true}}],
        outbounds: [{tag: 'block', protocol: 'blackhole'}],
        routing: {rules: [{inboundTag: ['in-20800'], outboundTag: 'block'}]},
      }),
    );
    const result = await checkXrayConfig(file, {xray: REAL_XRAY});
    assert.equal(result.ok, true, result.stderr || result.error || 'xray run -test failed');
  });
});

describe('the Xray diagnosis line (§2)', () => {
  test('keeps the last meaningful line, drops the banner and warnings', () => {
    const result = xrayDiagnosis({
      stderr:
        'Xray 26.9.30 (Xray, Penetrates Everything.) Custom\n' +
        'A unified platform for anti-censorship.\n' +
        '2026/10/02 17:00:00 [Warning] something\n' +
        'Failed to start: main: failed to load config files: [x] > core: Failed to get format of x',
      stdout: '',
    });
    assert.match(result, /Failed to get format of x/);
    assert.doesNotMatch(result, /unified platform|\[Warning\]/);
  });

  test('a successful run produces the fallback sentence, not "Configuration OK"', () => {
    assert.match(
      xrayDiagnosis({stdout: 'Xray 26.9.30\nConfiguration OK.\n', stderr: ''}),
      /не сказал/,
    );
  });
});

describe('Xray not running is applied, not "already applied" (§3)', () => {
  test('matching configs but xray inactive → restart and "Xray запущен"', async () => {
    const dir = makeTempDir();

    const first = await startEditor({dir, active: 'xray'});
    await post(first.base, '/apply');
    await first.close();

    const log = path.join(makeTempDir(), 'argv.log');
    const state = path.join(makeTempDir(), 'state.txt');
    const second = await startEditor({
      dir,
      active: '',
      system: {FAKE_SYSTEMCTL_ARGV_LOG: log, FAKE_SYSTEMCTL_STATE_FILE: state},
    });
    try {
      const html = await (await post(second.base, '/apply')).text();
      assert.match(html, /Xray запущен/);
      assert.doesNotMatch(html, /Уже применено/);
      const calls = argvCalls(second);
      assert.equal(
        calls.some((argv) => argv.includes('restart') && argv.includes('xray')),
        true,
        'xray is (re)started',
      );
      assert.equal(
        calls.some((argv) => argv.includes('restart') && argv.includes('sing-box')),
        false,
        'sing-box is not restarted when its config did not change',
      );
    } finally {
      await second.close();
    }
  });

  test('matching configs and xray active → "Уже применено", no restart', async () => {
    const log = path.join(makeTempDir(), 'argv.log');
    const editor = await startEditor({active: 'xray', system: {FAKE_SYSTEMCTL_ARGV_LOG: log}});
    try {
      await post(editor.base, '/apply');
      fs.rmSync(log, {force: true});
      const html = await (await post(editor.base, '/apply')).text();
      assert.match(html, /Уже применено/);
      // The middleware reads the unit state on every request, so only RESTARTS are
      // asserted absent — not the read-only polls.
      assert.equal(
        argvCalls(editor).some((argv) => argv.includes('restart')),
        false,
        'nothing is restarted',
      );
    } finally {
      await editor.close();
    }
  });
});

describe('the stop of Xray is checked (§4)', () => {
  test('a failed stop is a warning step with the reason, not a failed apply', async () => {
    const editor = await startEditor({
      noXray: true,
      active: 'xray',
      proxies: [{tag: 'main', type: 'mixed', port: 54321}],
      system: {FAKE_SYSTEMCTL_FAIL_MATCH: 'stop xray'},
    });
    try {
      const html = await (await post(editor.base, '/apply')).text();
      assert.match(html, /Xray не остановлен/);
      assert.match(html, /⚠️/);
      assert.match(html, /не остановлен/);
      // The apply itself is not a failure: sing-box no longer uses the service.
      assert.match(html, /apply-applied/);
    } finally {
      await editor.close();
    }
  });
});

describe('the CLI refuses an Xray build it cannot complete (§7)', () => {
  async function runCli(dir, providersRoot, settingsFile) {
    try {
      const {stderr} = await execFileAsync(
        process.execPath,
        [path.join(import.meta.dirname, '..', 'tools', 'generate.mjs'), '--settings', settingsFile],
        {
          cwd: path.join(import.meta.dirname, '..'),
          env: {...process.env, GATEHOUSE_PROVIDERS: providersRoot, GATEHOUSE_CONFIG: path.join(dir, 'config.json')},
        },
      );
      return {code: 0, stderr};
    } catch (error) {
      return {code: error.code ?? 1, stderr: String(error.stderr ?? '')};
    }
  }

  test('warns and refuses when ports are not persisted in webui.json', async () => {
    const dir = makeTempDir();
    const root = path.join(dir, 'providers');
    fs.mkdirSync(path.join(root, 'stash'), {recursive: true});
    fs.copyFileSync(XRAY_FIXTURE, path.join(root, 'stash', 'xray-configs.json'));
    const settingsFile = writeSettings(dir, {
      providers: {stash: {enabled: true, kind: 'xray'}},
      proxies: [{tag: 'main', type: 'mixed', port: 54321, servers: ['de-main (de2)']}],
    });

    const result = await runCli(dir, root, settingsFile);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /не сохранены/);
    assert.equal(fs.existsSync(path.join(dir, 'config.json')), false);
  });

  test('warns but succeeds when the ports ARE persisted', async () => {
    const dir = makeTempDir();
    const root = path.join(dir, 'providers');
    fs.mkdirSync(path.join(root, 'stash'), {recursive: true});
    fs.copyFileSync(XRAY_FIXTURE, path.join(root, 'stash', 'xray-configs.json'));
    // Persist the ports the way the interface does.
    const {ProjectModel} = await import('../src/model/project.mjs');
    const settingsFile = writeSettings(dir, {
      providers: {stash: {enabled: true, kind: 'xray'}},
      proxies: [{tag: 'main', type: 'mixed', port: 54321, servers: ['de-main (de2)']}],
    });
    const model = new ProjectModel({path: settingsFile, stateDir: path.join(dir, 'state')});
    model.setProvidersDir(root);
    model.ensureXrayPorts();
    model.save();

    const result = await runCli(dir, root, settingsFile);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /CLI не пишет конфиг Xray/);
    assert.equal(fs.existsSync(path.join(dir, 'config.json')), true);
  });
});

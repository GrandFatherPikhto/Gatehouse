// The apply chain with the second engine (task plan_2026_10_02_gatehouse_xray_core.md
// §4, §8.1(6)): both configs are built and checked, Xray is restarted only when
// its config changed (stopped when no server goes through it), and a failure
// rolls BOTH back. Everything host-facing goes through the fake binaries.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {xrayPermissions, xraySudoersLines} from '../src/system/index.mjs';
import {startServer} from '../src/web/server.mjs';
import {
  DEFAULT_LINKS,
  FAKE_BIN_DIR,
  FIXTURES_DIR,
  fakeSystemEnv,
  makeTempDir,
  writeSettings,
} from './helpers.mjs';

const XRAY_FIXTURE = path.join(FIXTURES_DIR, 'providers-xray', 'stash', 'xray-configs.json');
const XRAY_BIN = path.join(FAKE_BIN_DIR, 'xray');

/** POSTs a form the way htmx does it. */
function post(base, route, fields = {}) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded', 'HX-Request': 'true'},
    body: new URLSearchParams(fields),
  });
}

/** The argv arrays the fake systemctl received, in order. */
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

/**
 * Starts the editor over an Xray project (or a plain subscription when
 * `noXray`): a temp `stash` provider, a document, the fake `xray` and a config
 * path under the temp directory.
 */
async function startXrayEditor(options = {}) {
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
    options.noXray === true
      ? {vpnd: {enabled: true, kind: 'subscription'}}
      : {stash: {enabled: true, kind: 'xray'}};
  const proxies =
    options.proxies ?? [{tag: 'main', type: 'mixed', port: 54321, servers: ['de-main (de2)']}];
  const settingsFile = writeSettings(dir, {...(options.overrides ?? {}), providers, proxies});

  const configPath = path.join(dir, 'config.json');
  const xrayConfigPath = path.join(dir, 'etc', 'xray', 'config.json');
  fs.mkdirSync(path.dirname(xrayConfigPath), {recursive: true});

  const env = {
    ...fakeSystemEnv({
      GATEHOUSE_XRAY: XRAY_BIN,
      GATEHOUSE_XRAY_CONFIG: xrayConfigPath,
      GATEHOUSE_XRAY_UNIT: 'xray',
      FAKE_SYSTEMCTL_ACTIVE: options.xrayActive === false ? '' : 'xray',
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

describe('the apply chain applies a pair (§4)', () => {
  test('both configs land; Xray is restarted FIRST, then sing-box', async () => {
    const log = path.join(makeTempDir(), 'argv.log');
    const editor = await startXrayEditor({system: {FAKE_SYSTEMCTL_ARGV_LOG: log}});
    try {
      const html = await (await post(editor.base, '/apply')).text();
      assert.match(html, /apply-applied/);

      assert.equal(fs.existsSync(editor.configPath), true);
      assert.equal(fs.existsSync(editor.xrayConfigPath), true);
      const xray = JSON.parse(fs.readFileSync(editor.xrayConfigPath, 'utf8'));
      assert.equal(xray.outbounds[0].tag, 'block');
      assert.equal(xray.inbounds.every((inbound) => inbound.listen === '127.0.0.1'), true);

      // The ports are persisted in the document.
      const document = JSON.parse(fs.readFileSync(editor.env.GATEHOUSE_SETTINGS, 'utf8'));
      assert.equal(document.xray.ports['stash/de-main (de2)'], 20800);

      const calls = argvCalls(editor);
      const restartXray = calls.findIndex(
        (argv) => argv.includes('restart') && argv.includes('xray'),
      );
      const restartSingbox = calls.findIndex(
        (argv) => argv.includes('restart') && argv.includes('sing-box'),
      );
      assert.ok(restartXray >= 0, 'xray was restarted');
      assert.ok(restartSingbox >= 0, 'sing-box was restarted');
      assert.ok(restartXray < restartSingbox, 'xray is restarted before sing-box');
    } finally {
      await editor.close();
    }
  });

  test('a change of sing-box only does NOT restart Xray', async () => {
    const log = path.join(makeTempDir(), 'argv.log');
    const editor = await startXrayEditor({system: {FAKE_SYSTEMCTL_ARGV_LOG: log}});
    try {
      await post(editor.base, '/apply');
      fs.rmSync(log, {force: true});

      editor.model.upsertRoute('extra', {outbound: 'auto-select', domains: ['x.example.com']});
      const html = await (await post(editor.base, '/apply')).text();
      assert.match(html, /apply-applied/);

      const calls = argvCalls(editor);
      assert.equal(
        calls.some((argv) => argv.includes('restart') && argv.includes('xray')),
        false,
        'Xray is left alone when its config did not change',
      );
      assert.equal(
        calls.some((argv) => argv.includes('restart') && argv.includes('sing-box')),
        true,
      );
    } finally {
      await editor.close();
    }
  });

  test('a broken Xray config applies NOTHING', async () => {
    const editor = await startXrayEditor({system: {FAKE_XRAY_TEST_FAIL: '1'}});
    try {
      const html = await (await post(editor.base, '/apply')).text();
      assert.match(html, /конфиг Xray не прошёл проверку/);
      assert.equal(fs.existsSync(editor.configPath), false, 'live config.json untouched');
      assert.equal(fs.existsSync(editor.xrayConfigPath), false, 'live Xray config untouched');
    } finally {
      await editor.close();
    }
  });

  test('a failing Xray restart rolls BOTH configs back', async () => {
    const dir = makeTempDir();

    const first = await startXrayEditor({dir});
    await post(first.base, '/apply');
    const applied = fs.readFileSync(first.configPath, 'utf8');
    const appliedXray = fs.readFileSync(first.xrayConfigPath, 'utf8');
    await first.close();

    // Second run over the SAME directory: every systemctl action fails, and the
    // Xray config REALLY changes (a new server), so the Xray restart is attempted
    // first and its failure must restore BOTH configs.
    const second = await startXrayEditor({dir, system: {FAKE_SYSTEMCTL_FAIL: '1'}});
    try {
      const providerFile = path.join(dir, 'providers', 'stash', 'xray-configs.json');
      const data = JSON.parse(fs.readFileSync(providerFile, 'utf8'));
      data[0].outbounds.push({
        tag: 'new-one',
        protocol: 'vless',
        settings: {
          vnext: [
            {
              address: 'n1.example.net',
              port: 443,
              users: [{id: '44444444-4444-4444-a444-444444444444', encryption: 'none'}],
            },
          ],
        },
        streamSettings: {network: 'xhttp', security: 'tls', tlsSettings: {serverName: 'n1.example.net'}},
      });
      fs.writeFileSync(providerFile, JSON.stringify(data), 'utf8');

      const html = await (await post(second.base, '/apply')).text();
      assert.match(html, /откат обоих конфигов/);
      assert.equal(fs.readFileSync(second.configPath, 'utf8'), applied);
      assert.equal(fs.readFileSync(second.xrayConfigPath, 'utf8'), appliedXray);
    } finally {
      await second.close();
    }
  });

  test('with no Xray servers the service is stopped and no config is written', async () => {
    const log = path.join(makeTempDir(), 'argv.log');
    const editor = await startXrayEditor({
      noXray: true,
      xrayActive: true,
      proxies: [{tag: 'main', type: 'mixed', port: 54321}],
      system: {FAKE_SYSTEMCTL_ARGV_LOG: log},
    });
    try {
      const html = await (await post(editor.base, '/apply')).text();
      assert.match(html, /apply-applied/);
      assert.equal(fs.existsSync(editor.xrayConfigPath), false);
      const calls = argvCalls(editor);
      assert.equal(
        calls.some((argv) => argv.includes('stop') && argv.includes('xray')),
        true,
        'xray is stopped when no server goes through it',
      );
    } finally {
      await editor.close();
    }
  });
});

describe('the Xray sudoers block (system layer)', () => {
  test('offers the two lines when the file is missing, and parses partial rights', () => {
    const dir = makeTempDir();
    const missing = path.join(dir, 'sudoers');
    const permissions = xrayPermissions(missing);
    assert.equal(permissions.readable, true);
    assert.equal(permissions.canRestart, false);
    assert.deepEqual(permissions.missing, xraySudoersLines());

    const partial = path.join(dir, 'sudoers-partial');
    fs.writeFileSync(partial, `${xraySudoersLines()[0]}\n`, 'utf8');
    const parsed = xrayPermissions(partial);
    assert.equal(parsed.canRestart, true);
    assert.equal(parsed.canStop, false);
    assert.equal(parsed.missing.length, 1);
  });
});

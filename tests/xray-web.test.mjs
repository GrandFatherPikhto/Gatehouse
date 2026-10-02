// The Xray interface (task plan_2026_10_02_gatehouse_xray_core.md §5, §8.1(7)):
// the provider panel of kind `xray`, «Настройки → Xray», «Службы → Xray», the
// tree nodes and the «идят через Xray, а он остановлен» mark, and the refusal to
// enable an `xray` provider when the binary is not on the host.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

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

function post(base, route, fields = {}) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded', 'HX-Request': 'true'},
    body: new URLSearchParams(fields),
  });
}

async function startEditor(options = {}) {
  const dir = makeTempDir();
  const providersRoot = path.join(dir, 'providers');
  const stashDir = path.join(providersRoot, 'stash');
  fs.mkdirSync(stashDir, {recursive: true});
  fs.copyFileSync(XRAY_FIXTURE, path.join(stashDir, 'xray-configs.json'));

  const providers =
    options.providers ??
    (options.subscription === true
      ? {vpnd: {enabled: true, kind: 'subscription'}}
      : {stash: {enabled: true, kind: 'xray'}});
  if (options.subscription === true) {
    fs.mkdirSync(path.join(providersRoot, 'vpnd'), {recursive: true});
    fs.writeFileSync(path.join(providersRoot, 'vpnd', 'links.txt'), DEFAULT_LINKS, 'utf8');
  }
  const settingsFile = writeSettings(dir, {
    providers,
    proxies: options.proxies ?? [
      {tag: 'main', type: 'mixed', port: 54321, servers: ['de-main (de2)']},
    ],
  });

  const env = {
    ...fakeSystemEnv({
      GATEHOUSE_XRAY: options.xrayBinary ?? XRAY_BIN,
      GATEHOUSE_XRAY_CONFIG: path.join(dir, 'etc', 'xray', 'config.json'),
      GATEHOUSE_XRAY_UNIT: 'xray',
      FAKE_SYSTEMCTL_ACTIVE: options.active ?? 'xray',
      FAKE_SYSTEMCTL_ENABLED: options.enabled ?? '',
      ...(options.system ?? {}),
    }),
    GATEHOUSE_PROVIDERS: providersRoot,
    GATEHOUSE_SETTINGS: settingsFile,
    GATEHOUSE_STATE_DIR: path.join(dir, 'state'),
    GATEHOUSE_CONFIG: path.join(dir, 'config.json'),
    GATEHOUSE_HOST: '127.0.0.1',
    GATEHOUSE_PORT: '0',
  };

  const {server, model, url} = await startServer({env});
  return {
    dir,
    model,
    base: url.replace(/\/$/, ''),
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

describe('the provider panel of kind xray (§5)', () => {
  test('shows the server table with the protocol, address and port', async () => {
    const editor = await startEditor();
    try {
      const html = await (await fetch(`${editor.base}/panel/provider:stash`)).text();
      assert.match(html, /Серверы Xray/);
      assert.match(html, /de-main \(de2\)/);
      assert.match(html, /VLESS XHTTP · TLS/);
      assert.match(html, /VLESS XHTTP · Reality/);
      assert.match(html, /Hysteria2/);
      assert.match(html, /20800/);
      assert.match(html, /Конфиги Xray/);
    } finally {
      await editor.close();
    }
  });

  test('an xray panel has NO flow/fp; a subscription panel HAS them (§6)', async () => {
    const xray = await startEditor();
    const subscription = await startEditor({subscription: true});
    try {
      const xrayHtml = await (await fetch(`${xray.base}/panel/provider:stash`)).text();
      assert.doesNotMatch(xrayHtml, /name="flow"/);
      assert.doesNotMatch(xrayHtml, /name="fp"/);
      assert.doesNotMatch(xrayHtml, /Пропущено ссылок/);
      assert.match(xrayHtml, /из тегов выходов и адресов/);

      const subHtml = await (await fetch(`${subscription.base}/panel/provider:vpnd`)).text();
      assert.match(subHtml, /name="flow"/);
      assert.match(subHtml, /name="fp"/);
    } finally {
      await xray.close();
      await subscription.close();
    }
  });

  test('the folder kind selector offers the third kind', async () => {
    const editor = await startEditor({providers: {stash: {enabled: false}}});
    try {
      const html = await (await fetch(`${editor.base}/panel/provider:stash`)).text();
      assert.match(html, /<option value="xray"/);
    } finally {
      await editor.close();
    }
  });
});

describe('«Настройки → Xray» (§5)', () => {
  test('shows the range, the handed-out ports and the engine state', async () => {
    const editor = await startEditor();
    try {
      const html = await (await fetch(`${editor.base}/panel/xray`)).text();
      assert.match(html, /Диапазон портов/);
      assert.match(html, /id="xray_port_from"[^>]*value="20800"/);
      assert.match(html, /id="xray_port_to"[^>]*value="20999"/);
      assert.match(html, /Выданные порты/);
      assert.match(html, /de-main \(de2\)/);
    } finally {
      await editor.close();
    }
  });

  test('the range form is applied and saved on the normal save path', async () => {
    const editor = await startEditor();
    try {
      const html = await (
        await post(editor.base, '/xray', {xray_port_from: '30000', xray_port_to: '30010'})
      ).text();
      assert.match(html, /Настройки Xray применены/);
      assert.deepEqual(editor.model.xrayBlock().port_range, [30000, 30010]);
    } finally {
      await editor.close();
    }
  });
});

describe('«Службы → Xray» (§5)', () => {
  test('shows state, version and the enable command when not in autostart', async () => {
    const editor = await startEditor({active: 'xray', enabled: ''});
    try {
      const html = await (await fetch(`${editor.base}/panel/system:xray`)).text();
      assert.match(html, /Состояние/);
      assert.match(html, /работает/);
      assert.match(html, /не в автозагрузке/);
      assert.match(html, /sudo systemctl enable xray/);
      assert.match(html, /Xray 26\.9\.30 \(fake\)/);
      assert.match(html, /Журнал Xray/);
    } finally {
      await editor.close();
    }
  });
});

describe('the journal of the service tabs (§5)', () => {
  test('system:xray reads the xray unit and refreshes the xray panel', async () => {
    const editor = await startEditor();
    try {
      const html = await (await fetch(`${editor.base}/panel/system:xray`)).text();
      assert.match(html, /Юнит: <code>xray<\/code>/);
      assert.match(html, /action="\/panel\/system:xray"/);
      assert.match(html, /Журнал Xray/);
    } finally {
      await editor.close();
    }
  });

  test('system:singbox keeps its own journal', async () => {
    const editor = await startEditor();
    try {
      const html = await (await fetch(`${editor.base}/panel/system:singbox`)).text();
      assert.match(html, /Юнит: <code>sing-box<\/code>/);
      assert.match(html, /action="\/panel\/system:singbox"/);
    } finally {
      await editor.close();
    }
  });
});

describe('the tree and the provider mark (§5)', () => {
  test('has the Xray nodes and links to them', async () => {
    const editor = await startEditor();
    try {
      const html = await (await fetch(`${editor.base}/`)).text();
      assert.match(html, /panel\/xray/);
      assert.match(html, /panel\/system(?:%3A|:)xray/);
    } finally {
      await editor.close();
    }
  });

  test('a proxy whose exits ride on a stopped Xray is marked', async () => {
    const editor = await startEditor({active: '', system: {FAKE_SYSTEMCTL_ACTIVE: ''}});
    try {
      const html = await (await fetch(`${editor.base}/panel/proxies`)).text();
      assert.match(html, /через Xray, а он остановлен/);
    } finally {
      await editor.close();
    }
  });

  test('no mark when Xray is running', async () => {
    const editor = await startEditor({active: 'xray'});
    try {
      const html = await (await fetch(`${editor.base}/panel/proxies`)).text();
      assert.doesNotMatch(html, /через Xray, а он остановлен/);
    } finally {
      await editor.close();
    }
  });
});

describe('enabling an xray provider without the binary (§5)', () => {
  test('is refused with the expected path', async () => {
    const editor = await startEditor({
      providers: {stash: {enabled: false, kind: 'xray'}},
      xrayBinary: '/nonexistent/xray',
    });
    try {
      const html = await (
        await post(editor.base, '/provider/enabled', {id: 'stash', enabled: '1'})
      ).text();
      assert.match(html, /Xray не найден: \/nonexistent\/xray/);
    } finally {
      await editor.close();
    }
  });
});

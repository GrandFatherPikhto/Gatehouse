// Tunnel lifecycle: applying a config (part 1), up/down and rights (part 2),
// and a tunnel as a proxy (part 3).
//
// Everything host-facing goes through the fake binaries: no systemd, no sudo, no
// root and no network. The pure modules (writer, core assembly, sudoers parser)
// are also exercised directly, because the web routes are thin wrappers around
// them and a failure there must be diagnosable.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {buildConfig} from '../src/core/build.mjs';
import {validateProxies} from '../src/core/validate.mjs';
import {
  disableTunnel,
  enableTunnel,
  parseTunnelSudoers,
  restartTunnel,
  tunnelPermissions,
  tunnelState,
} from '../src/system/index.mjs';
import {applyTunnelConfig, listTunnelSnapshots, tunnelConfigPath} from '../src/system/tunnel-file.mjs';
import {startServer} from '../src/web/server.mjs';
import {
  FAKE_SYSTEMCTL,
  FIXTURES_DIR,
  fakeSystemEnv,
  makeTempDir,
  tunnelSystemEnv,
  writeLinksFile,
  writeSettings,
  writeSudoers,
} from './helpers.mjs';

const PROVIDER_CONF = path.join(FIXTURES_DIR, 'tunnel', 'provider.conf');

/** A proxy that IS a tunnel: one inbound, one `direct` exit, no servers (§5.1). */
const TUNNEL_PROXY = {
  tag: 'hmn-graz4',
  type: 'mixed',
  port: 54330,
  tunnel: {provider: 'hidemyname', file: 'AustriaGrazS4.conf', interface: 'hmn-graz4'},
};

describe('applying a tunnel config (part 1)', () => {
  test('writes 0600, snapshots only on change, and is a no-op on identical bytes', () => {
    const dir = makeTempDir();
    const amneziaDir = path.join(dir, 'amnezia');
    const target = tunnelConfigPath(amneziaDir, 'de');

    const first = applyTunnelConfig('Table = off\n', {name: 'de', amneziaDir});
    assert.equal(first.changed, true);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600, 'the private key file must be 0600');
    assert.equal(listTunnelSnapshots(amneziaDir, 'de').length, 0, 'nothing to snapshot yet');

    const repeat = applyTunnelConfig('Table = off\n', {name: 'de', amneziaDir});
    assert.equal(repeat.changed, false);
    assert.equal(repeat.snapshot, null);
    assert.equal(listTunnelSnapshots(amneziaDir, 'de').length, 0, 'same bytes: no snapshot');

    const changed = applyTunnelConfig('Table = off\nDNS = 1.1.1.1\n', {name: 'de', amneziaDir});
    assert.equal(changed.changed, true);
    const snapshots = listTunnelSnapshots(amneziaDir, 'de');
    assert.equal(snapshots.length, 1);
    assert.equal(fs.readFileSync(snapshots[0], 'utf8'), 'Table = off\n', 'snapshot holds the old bytes');

    // `keep` bounds the series: a third change must drop the oldest snapshot.
    applyTunnelConfig('Table = off\nDNS = 1.1.1.1\nDNS = 8.8.8.8\n', {
      name: 'de',
      amneziaDir,
      keep: 1,
    });
    assert.equal(listTunnelSnapshots(amneziaDir, 'de').length, 1);
  });
});

describe('reading the two systemd axes (part 2)', () => {
  test('all four combinations come from systemctl, not from an assumption', async () => {
    const cases = [
      {active: ['awg-quick@de'], enabled: ['awg-quick@de'], expect: [true, true]},
      {active: ['awg-quick@de'], enabled: [], expect: [true, false]},
      {active: [], enabled: ['awg-quick@de'], expect: [false, true]},
      {active: [], enabled: [], expect: [false, false]},
    ];
    for (const item of cases) {
      const env = fakeSystemEnv({
        FAKE_SYSTEMCTL_ACTIVE: item.active.join(','),
        FAKE_SYSTEMCTL_ENABLED: item.enabled.join(','),
      });
      const state = await tunnelState('de', {env});
      assert.deepEqual([state.active, state.enabled], item.expect);
      assert.equal(state.unit, 'awg-quick@de');
    }
  });
});

describe('sudoers rights (part 2)', () => {
  test('parses per-name rules and never invents rights without a file', () => {
    const parsed = parseTunnelSudoers(
      [
        '# comment',
        `denis ALL=(root) NOPASSWD: ${FAKE_SYSTEMCTL} restart awg-quick@de`,
        `denis ALL=(root) NOPASSWD: ${FAKE_SYSTEMCTL} enable --now awg-quick@de`,
        `denis ALL=(root) NOPASSWD: ${FAKE_SYSTEMCTL} restart awg-quick@ch`,
      ].join('\n'),
      {systemctl: FAKE_SYSTEMCTL},
    );
    assert.deepEqual(parsed.de, {restart: true, enable: true, disable: false});
    assert.deepEqual(parsed.ch, {restart: true, enable: false, disable: false});
  });

  test('a missing file means no rights, with the exact lines to install', () => {
    const dir = makeTempDir();
    const missing = path.join(dir, 'nope');
    const rights = tunnelPermissions(missing, ['de'], {systemctl: FAKE_SYSTEMCTL, user: 'denis'});
    assert.equal(rights.de.canRestart, false);
    assert.equal(rights.de.canToggle, false);
    assert.equal(rights.de.missingLines.length, 3);
    assert.match(rights.de.missingLines[0], /enable --now awg-quick@de/);
  });
});

describe('a tunnel as a proxy (part 3)', () => {
  test('validateProxies keeps the descriptor and refuses servers on a tunnel', () => {
    const [entry] = validateProxies([TUNNEL_PROXY]);
    assert.deepEqual(entry.tunnel, TUNNEL_PROXY.tunnel);

    assert.throws(
      () => validateProxies([{...TUNNEL_PROXY, servers: ['🇫🇮 Finland - Helsinki 1']}]),
      /один туннель, один выход/,
    );
  });

  test('the generated config carries the inbound/direct pair with bind_interface', () => {
    const settings = {
      proxies: [TUNNEL_PROXY],
      urltest: {url: 'https://gstatic.com', interval: '3m', tolerance: 50},
      dns: {servers: [], final: 'dns-local'},
      log: {level: 'info'},
    };
    const warnings = [];
    const [config] = buildConfig(settings, [], '10.95.2.1', warnings);

    assert.deepEqual(config.inbounds, [
      {type: 'mixed', tag: 'hmn-graz4-in', listen: '10.95.2.1', listen_port: 54330},
    ]);
    const direct = config.outbounds.find((outbound) => outbound.tag === 'hmn-graz4');
    assert.deepEqual(
      direct,
      {type: 'direct', tag: 'hmn-graz4', bind_interface: 'hmn-graz4'},
      'exactly the interface binding, no extra fields and no pool',
    );
    assert.equal(
      config.outbounds.some((outbound) => outbound.tag === 'pool-hmn-graz4'),
      false,
      'a tunnel has no pool',
    );
    assert.deepEqual(config.route.rules.at(-1), {inbound: ['hmn-graz4-in'], outbound: 'hmn-graz4'});
  });

  test('a proxy on a stopped tunnel is warned about (§5.4)', () => {
    const settings = {
      proxies: [TUNNEL_PROXY],
      urltest: {},
      dns: {servers: []},
      log: {},
    };
    const stopped = [];
    buildConfig(settings, [], '10.95.2.1', stopped, {runningTunnels: []});
    assert.ok(stopped.some((line) => /туннель 'hmn-graz4' не поднят/.test(line)));

    const up = [];
    buildConfig(settings, [], '10.95.2.1', up, {runningTunnels: ['hmn-graz4']});
    assert.equal(up.some((line) => /не поднят/.test(line)), false);
  });
});

/**
 * Starts the editor over a project that also carries a tunnel source and a
 * tunnel proxy.
 *
 * @param {{applied?: string|null, rules?: string[], sudoers?: boolean, active?: string[],
 *   enabled?: string[], withProxy?: boolean}} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
async function startEditor(options = {}) {
  const dir = makeTempDir();
  writeLinksFile(dir);
  const tunnelDir = path.join(dir, 'sources', 'hidemyname');
  fs.mkdirSync(tunnelDir, {recursive: true});
  fs.copyFileSync(PROVIDER_CONF, path.join(tunnelDir, 'AustriaGrazS4.conf'));

  const settingsFile = writeSettings(dir, {
    sources: ['vpnd', 'hidemyname'],
    proxies:
      options.withProxy === false
        ? [{tag: 'main-socks', type: 'socks', port: 54321}]
        : [TUNNEL_PROXY, {tag: 'main-socks', type: 'socks', port: 54321}],
  });
  const stateDir = path.join(dir, 'state');
  const amneziaDir = path.join(dir, 'amnezia');
  if (typeof options.applied === 'string') {
    fs.mkdirSync(amneziaDir, {recursive: true});
    // A real config has an `[Interface]` section: the start-up fuse looks for
    // `Table = off` inside it, so a bare line is deliberately not enough.
    fs.writeFileSync(path.join(amneziaDir, `${options.applied}.conf`), '[Interface]\nTable = off\n');
  }

  const sudoers = options.sudoers === false
    ? path.join(dir, 'no-sudoers')
    : writeSudoers(path.join(dir, 'sudoers-gatehouse'), options.rules ?? ['hmn-graz4']);

  const env = {
    ...fakeSystemEnv(),
    ...tunnelSystemEnv(dir, {active: options.active ?? [], enabled: options.enabled ?? [], sudoers}),
    GATEHOUSE_SETTINGS: settingsFile,
    GATEHOUSE_HOST: '127.0.0.1',
    GATEHOUSE_PORT: '0',
    GATEHOUSE_STATE_DIR: stateDir,
  };

  const {server, model, url} = await startServer({env});
  return {
    dir,
    env,
    amneziaDir,
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

describe('the tunnel panel and its buttons (part 2)', () => {
  test('the «нужен» mark writes the normalised config, never the source', async () => {
    const editor = await startEditor();
    try {
      const fields = {
        provider: 'hidemyname',
        file: 'AustriaGrazS4.conf',
        name: 'hidemyname-AustriaGrazS4',
        interface: 'hmn-graz4',
        needed: '1',
      };

      const first = await (await post(editor.base, '/tunnels', fields)).text();
      assert.match(first, /отмечен:/);
      assert.match(first, /Туннель не поднят/);

      const target = path.join(editor.amneziaDir, 'hmn-graz4.conf');
      assert.equal(fs.statSync(target).mode & 0o777, 0o600);
      assert.equal(
        fs.readFileSync(target, 'utf8'),
        fs.readFileSync(path.join(FIXTURES_DIR, 'tunnel', 'normalized.conf'), 'utf8'),
        'the file holds the normaliser output byte for byte',
      );
      assert.notEqual(
        fs.readFileSync(target, 'utf8'),
        fs.readFileSync(PROVIDER_CONF, 'utf8'),
        'the source config never reaches the amnezia directory',
      );
      assert.deepEqual(editor.model.getTunnel('hidemyname', 'AustriaGrazS4.conf'), {
        provider: 'hidemyname',
        file: 'AustriaGrazS4.conf',
        name: 'hidemyname-AustriaGrazS4',
        interface: 'hmn-graz4',
      });

      // Identical bytes are a no-op: no snapshot series grows on a repeat.
      await post(editor.base, '/tunnels', fields);
      assert.equal(listTunnelSnapshots(editor.amneziaDir, 'hmn-graz4').length, 0);
    } finally {
      await editor.close();
    }
  });

  test('un-ticking a running tunnel stops it first, then removes the file', async () => {
    const editor = await startEditor({
      withProxy: false,
      active: ['awg-quick@hmn-graz4'],
      enabled: ['awg-quick@hmn-graz4'],
    });
    try {
      await post(editor.base, '/tunnels', {
        provider: 'hidemyname',
        file: 'AustriaGrazS4.conf',
        name: 'hidemyname-AustriaGrazS4',
        interface: 'hmn-graz4',
        needed: '1',
      });
      const target = path.join(editor.amneziaDir, 'hmn-graz4.conf');
      assert.ok(fs.existsSync(target));

      const html = await (
        await post(editor.base, '/tunnels', {provider: 'hidemyname', file: 'AustriaGrazS4.conf'})
      ).text();

      assert.match(html, /снят/);
      assert.equal(fs.existsSync(target), false, 'the applied config is gone');
      assert.equal(editor.model.getTunnel('hidemyname', 'AustriaGrazS4.conf'), null);
    } finally {
      await editor.close();
    }
  });

  test('a tunnel without a proxy is listed in «Система» and manageable', async () => {
    const editor = await startEditor({withProxy: false, applied: 'de', rules: ['de']});
    try {
      const panel = await (await fetch(`${editor.base}/panel/system`)).text();

      assert.match(panel, /awg-quick@de/);
      assert.match(panel, /hx-post="\/tunnel\/toggle"/);
    } finally {
      await editor.close();
    }
  });

  test('both names are validated before anything is written', async () => {
    const editor = await startEditor({withProxy: false});
    try {
      const base = {provider: 'hidemyname', file: 'AustriaGrazS4.conf', needed: '1'};

      const longFile = await (
        await post(editor.base, '/tunnels', {...base, name: 'ok-name', interface: 'a'.repeat(16)})
      ).text();
      assert.match(longFile, /15 символов/);

      const withExtension = await (
        await post(editor.base, '/tunnels', {...base, name: 'ok-name', interface: 'de.conf'})
      ).text();
      assert.match(withExtension, /оканчиваться на/);

      // An empty label falls back to the suggestion rather than refusing, so the
      // refusal tested here is a control character: it has no place in a name.
      const controlName = await (
        await post(editor.base, '/tunnels', {...base, name: 'bad\u0001name', interface: 'de'})
      ).text();
      assert.match(controlName, /управляющие символы/);

      assert.equal(
        editor.model.getTunnel('hidemyname', 'AustriaGrazS4.conf'),
        null,
        'a refused mark stores nothing',
      );
    } finally {
      await editor.close();
    }
  });

  test('a foreign file with the chosen name is refused, never overwritten', async () => {
    const editor = await startEditor({withProxy: false});
    try {
      fs.mkdirSync(editor.amneziaDir, {recursive: true});
      const foreign = path.join(editor.amneziaDir, 'de.conf');
      fs.writeFileSync(foreign, '[Interface]\nPrivateKey = foreign\n');

      const html = await (
        await post(editor.base, '/tunnels', {
          provider: 'hidemyname',
          file: 'AustriaGrazS4.conf',
          name: 'hidemyname-AustriaGrazS4',
          interface: 'de',
          needed: '1',
        })
      ).text();

      assert.match(html, /не принадлежит этому туннелю/);
      assert.match(fs.readFileSync(foreign, 'utf8'), /PrivateKey = foreign/, 'the file is untouched');
      assert.equal(editor.model.getTunnel('hidemyname', 'AustriaGrazS4.conf'), null);
    } finally {
      await editor.close();
    }
  });

  test('renaming the file name retargets the proxy and drops the old artifact', async () => {
    const editor = await startEditor();
    try {
      const fields = {
        provider: 'hidemyname',
        file: 'AustriaGrazS4.conf',
        name: 'hidemyname-AustriaGrazS4',
        needed: '1',
      };
      await post(editor.base, '/tunnels', {...fields, interface: 'hmn-graz4'});
      assert.ok(fs.existsSync(path.join(editor.amneziaDir, 'hmn-graz4.conf')));

      await post(editor.base, '/tunnels', {...fields, interface: 'hmn-graz5'});

      assert.equal(editor.model.getProxy('hmn-graz4').tunnel.interface, 'hmn-graz5');
      assert.ok(fs.existsSync(path.join(editor.amneziaDir, 'hmn-graz5.conf')));
      assert.equal(
        fs.existsSync(path.join(editor.amneziaDir, 'hmn-graz4.conf')),
        false,
        'the old file is not left behind',
      );
    } finally {
      await editor.close();
    }
  });

  test('leftovers and snapshots are not taken for tunnels (§2.4)', async () => {
    const editor = await startEditor({withProxy: false});
    try {
      fs.mkdirSync(editor.amneziaDir, {recursive: true});
      fs.writeFileSync(path.join(editor.amneziaDir, 'de.conf'), '[Interface]\nTable = off\n');
      fs.writeFileSync(path.join(editor.amneziaDir, 'de.conf.conf'), '[Interface]\nTable = off\n');
      fs.writeFileSync(
        path.join(editor.amneziaDir, 'de.conf.2020-01-01T00:00:00.000Z'),
        'old bytes\n',
      );

      const panel = await (await fetch(`${editor.base}/panel/system`)).text();

      assert.match(panel, /awg-quick@de</, 'the real config is listed');
      assert.doesNotMatch(panel, /awg-quick@de\.conf/, 'a `de.conf.conf` leftover is not a tunnel');
      assert.doesNotMatch(panel, /de\.conf\.2020/, 'snapshots are not tunnels');
    } finally {
      await editor.close();
    }
  });

  test('the state is read from systemd and a divergence is named', async () => {
    const editor = await startEditor({
      applied: 'hmn-graz4',
      active: ['awg-quick@hmn-graz4'],
      enabled: [],
    });
    try {
      const panel = await (await fetch(`${editor.base}/panel/system`)).text();
      assert.match(panel, /awg-quick@hmn-graz4/);
      assert.match(panel, /поднят, но не в автозагрузке: после перезагрузки пропадёт/);
      assert.match(panel, /hx-post="\/tunnel\/restart"/);
      assert.match(panel, /hx-post="\/tunnel\/toggle"/);
      assert.match(panel, /unit=awg-quick%40hmn-graz4/, 'the journal link targets the unit');
    } finally {
      await editor.close();
    }
  });

  test('without a sudoers rule there is no button, only the line to paste', async () => {
    const editor = await startEditor({applied: 'hmn-graz4', sudoers: false});
    try {
      const panel = await (await fetch(`${editor.base}/panel/system`)).text();
      assert.doesNotMatch(panel, /hx-post="\/tunnel\/restart"/);
      assert.doesNotMatch(panel, /hx-post="\/tunnel\/toggle"/);
      assert.match(panel, /enable --now awg-quick@hmn-graz4/);

      const refused = await (await post(editor.base, '/tunnel/restart', {name: 'hmn-graz4'})).text();
      assert.match(refused, /нет правила sudoers/);
    } finally {
      await editor.close();
    }
  });

  test('an unapplied tunnel is a sentence, not a checkbox', async () => {
    const editor = await startEditor();
    try {
      const panel = await (await fetch(`${editor.base}/panel/system`)).text();
      assert.match(panel, /конфиг не применён/);
      assert.doesNotMatch(panel, /hx-post="\/tunnel\/toggle"/);

      const refused = await (await post(editor.base, '/tunnel/toggle', {name: 'hmn-graz4', up: '1'})).text();
      // The quotes are HTML-escaped in the rendered notice.
      assert.match(refused, /не применён: отметьте его галочкой «нужен»/);
    } finally {
      await editor.close();
    }
  });

  test('the toggle and the restart reach the unit through the fake systemctl', async () => {
    const editor = await startEditor({applied: 'hmn-graz4'});
    try {
      const up = await (await post(editor.base, '/tunnel/toggle', {name: 'hmn-graz4', up: '1'})).text();
      assert.match(up, /поднят и включён в автозагрузку/);

      const restarted = await (await post(editor.base, '/tunnel/restart', {name: 'hmn-graz4'})).text();
      assert.match(restarted, /перезапущен/);
    } finally {
      await editor.close();
    }
  });
});

describe('warnings and marks (parts 3 and §5.4)', () => {
  test('generation warns about a tunnel that is not up and the tree marks the proxy', async () => {
    const editor = await startEditor();
    try {
      await post(editor.base, '/generate', {});
      const config = JSON.parse(fs.readFileSync(path.join(editor.dir, 'config.json'), 'utf8'));
      const direct = config.outbounds.find((outbound) => outbound.tag === 'hmn-graz4');
      assert.deepEqual(direct, {
        type: 'direct',
        tag: 'hmn-graz4',
        bind_interface: 'hmn-graz4',
      });

      const page = await (await fetch(`${editor.base}/`)).text();
      assert.match(page, /порт не работает: туннель не поднят/);
    } finally {
      await editor.close();
    }
  });

  test('a running tunnel produces no warning', async () => {
    const editor = await startEditor({
      applied: 'hmn-graz4',
      active: ['awg-quick@hmn-graz4'],
      enabled: ['awg-quick@hmn-graz4'],
    });
    try {
      const response = await post(editor.base, '/generate', {});
      const html = await response.text();
      assert.doesNotMatch(html, /не поднят — порт не работает/);
    } finally {
      await editor.close();
    }
  });
});

describe('the start-up fuse (NEW)', () => {
  test('a config without Table = off refuses to start and never calls systemctl', async () => {
    const dir = makeTempDir();
    const amneziaDir = path.join(dir, 'amnezia');
    fs.mkdirSync(amneziaDir, {recursive: true});
    fs.writeFileSync(path.join(amneziaDir, 'de.conf'), '[Interface]\nPrivateKey = x\n');

    const log = path.join(dir, 'argv.log');
    const env = fakeSystemEnv({
      GATEHOUSE_AMNEZIA_DIR: amneziaDir,
      FAKE_SYSTEMCTL_ARGV_LOG: log,
    });

    const started = await enableTunnel('de', {env});
    assert.equal(started.ok, false);
    assert.equal(started.refused, true);
    assert.deepEqual(started.command, [], 'systemctl is not even assembled');
    assert.match(started.error, /Table = off/);
    assert.match(started.error, /de\.conf/, 'the refusal names the exact path');

    const restarted = await restartTunnel('de', {env});
    assert.equal(restarted.refused, true);
    assert.equal(fs.existsSync(log), false, 'no systemctl process was ever spawned');
  });

  test('a missing config refuses too', async () => {
    const dir = makeTempDir();
    const env = fakeSystemEnv({GATEHOUSE_AMNEZIA_DIR: path.join(dir, 'amnezia')});

    const result = await enableTunnel('de', {env});
    assert.equal(result.refused, true);
    assert.match(result.error, /не найден/);
  });

  test('a normalised config starts, and the file is read at start time', async () => {
    const dir = makeTempDir();
    const amneziaDir = path.join(dir, 'amnezia');
    applyTunnelConfig('[Interface]\nTable = off\n', {name: 'de', amneziaDir});

    const env = fakeSystemEnv({GATEHOUSE_AMNEZIA_DIR: amneziaDir});
    const ok = await enableTunnel('de', {env});
    assert.equal(ok.ok, true);
    assert.ok(ok.command.includes('enable'));
    assert.ok(ok.command.includes('--now'));

    // Between writing and starting the file may be replaced; the check is on the
    // bytes on disk NOW, not on what was applied earlier.
    fs.writeFileSync(path.join(amneziaDir, 'de.conf'), '[Interface]\nPrivateKey = x\n');
    const swapped = await restartTunnel('de', {env});
    assert.equal(swapped.refused, true);
    assert.match(swapped.error, /Table = off/);
  });

  test('stopping is never blocked by the fuse', async () => {
    const dir = makeTempDir();
    const amneziaDir = path.join(dir, 'amnezia');
    fs.mkdirSync(amneziaDir, {recursive: true});
    fs.writeFileSync(path.join(amneziaDir, 'de.conf'), '[Interface]\nPrivateKey = x\n');

    const env = fakeSystemEnv({GATEHOUSE_AMNEZIA_DIR: amneziaDir});
    const stopped = await disableTunnel('de', {env});
    assert.equal(stopped.ok, true);
    assert.equal(stopped.refused, false);
  });
});

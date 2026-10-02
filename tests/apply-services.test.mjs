// The apply bar, the `/apply` chain, the subscription headers and the AmneziaWG
// sudoers/carrier block.
//
// Everything host-facing goes through the fake binaries like the rest of the
// system tests: no sing-box, no systemd, no root and no network. The pure core
// helpers (`subscriptionExpiry`, `parseSubscriptionHeaders`) are checked on their
// own, because the routes are thin wrappers around them.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {parseSubscriptionHeaders, subscriptionExpiry} from '../src/core/vless.mjs';
import {startServer} from '../src/web/server.mjs';
import {
  DEFAULT_LINKS,
  FI_TAG,
  FIXTURES_DIR,
  fakeSystemEnv,
  makeTempDir,
  tunnelSystemEnv,
  writeLinksFile,
  writeSettings,
  writeSudoers,
} from './helpers.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const PROVIDER_CONF = path.join(FIXTURES_DIR, 'tunnel', 'provider.conf');

/**
 * Links of a subscription with the Happ/v2RayTun headers on top of the ordinary
 * VLESS ones. `#` lines are comments to the parser and the generator both, so
 * they change nothing but the panel.
 *
 * @param {{title?: string|null, expire?: number|null}} [headers]
 * @returns {string}
 */
function linksWithHeaders(headers = {}) {
  const lines = [];
  if (headers.title) lines.push(`#profile-title: ${headers.title}`);
  if (headers.expire) lines.push(`#subscription-userinfo: upload=0; download=0; total=0; expire=${headers.expire}`);
  lines.push('#profile-update-interval: 1');
  return `${lines.join('\n')}\n${DEFAULT_LINKS}`;
}

/**
 * Starts the editor over a temporary project.
 *
 * @param {{links?: string, overrides?: Record<string, unknown>, system?: Record<string, string>,
 *   tunnel?: boolean, sudoersRules?: string[]}} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
async function startEditor(options = {}) {
  const dir = makeTempDir();
  writeLinksFile(dir, options.links ?? DEFAULT_LINKS);
  if (options.tunnel === true) {
    const tunnelDir = path.join(dir, 'providers', 'hidemyname');
    fs.mkdirSync(tunnelDir, {recursive: true});
    fs.copyFileSync(PROVIDER_CONF, path.join(tunnelDir, 'AustriaGrazS4.conf'));
  }
  // A SECOND folder with the very same links: two enabled providers would collide
  // on server names unless one carries a suffix (§2.2).
  if (options.twin === true) {
    const twinDir = path.join(dir, 'providers', 'vpnd-ws');
    fs.mkdirSync(twinDir, {recursive: true});
    fs.writeFileSync(path.join(twinDir, 'links.txt'), options.links ?? DEFAULT_LINKS);
  }

  const providers = {
    ...(options.tunnel === true ? {hidemyname: {enabled: true, kind: 'awg'}} : {}),
    vpnd: {enabled: true, kind: 'subscription'},
    ...(options.twin === true ? {'vpnd-ws': {enabled: false}} : {}),
  };
  const settingsFile = writeSettings(dir, {providers, ...(options.overrides ?? {})});
  const stateDir = path.join(dir, 'state');
  const amneziaDir = path.join(dir, 'amnezia');

  const env = {
    ...fakeSystemEnv(options.system),
    ...tunnelSystemEnv(dir, {sudoers: options.tunnel === true
      ? writeSudoers(path.join(dir, 'sudoers-gatehouse'), options.sudoersRules ?? ['hmn-graz4'])
      : path.join(dir, 'no-sudoers')}),
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
    stateDir,
    model,
    base: url.replace(/\/$/, ''),
    configPath: path.join(dir, 'config.json'),
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Marks the tunnel of the temporary project «нужен», which writes the applied
 * config into the amnezia directory and records the entry: without a mark the
 * inventory is empty and the System panel has no rows.
 *
 * @param {Record<string, unknown>} editor
 * @returns {Promise<void>}
 */
async function markTunnel(editor) {
  const response = await post(editor.base, '/tunnels', {
    provider: 'hidemyname',
    file: 'AustriaGrazS4.conf',
    needed: '1',
    name: 'hmn-graz4',
    interface: 'hmn-graz4',
  });
  assert.equal(response.status, 200);
}

/**
 * POSTs a form the way htmx does it.
 *
 * @param {string} base
 * @param {string} route
 * @param {Record<string, string>} [fields]
 * @returns {Promise<Response>}
 */
function post(base, route, fields = {}) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded', 'HX-Request': 'true'},
    body: new URLSearchParams(fields),
  });
}

describe('subscription headers (core)', () => {
  test('decodes base64 and plain titles, and reads the expiry', () => {
    const parsed = parseSubscriptionHeaders(
      '#profile-title: base64:VlBORC5pbyB2bGVzcyDwn5qA\n' +
        '#subscription-userinfo: upload=0; total=0; expire=1813734952\n',
    );
    assert.equal(parsed.title, 'VPND.io vless 🚀');
    assert.equal(parsed.expire, 1813734952);

    assert.equal(parseSubscriptionHeaders('#profile-title: just text\n').title, 'just text');
  });

  test('expire=0 and a missing field both mean "no date"', () => {
    assert.equal(parseSubscriptionHeaders('#subscription-userinfo: expire=0\n').expire, null);
    assert.equal(parseSubscriptionHeaders('#profile-update-interval: 1\n').expire, null);
  });

  test('subscriptionExpiry turns seconds into a date, days and flags', () => {
    const now = Date.UTC(2026, 5, 1, 12, 0, 0); // 01.06.2026 12:00 UTC
    const soon = Math.floor((now + 10 * DAY_MS) / 1000);
    const past = Math.floor((now - 2 * DAY_MS) / 1000);

    assert.equal(subscriptionExpiry(null, now), null);
    const s = subscriptionExpiry(soon, now);
    assert.equal(s.soon, true);
    assert.equal(s.expired, false);
    assert.equal(s.daysLeft, 10);

    const p = subscriptionExpiry(past, now);
    assert.equal(p.expired, true);
    assert.equal(p.soon, false);
  });
});

describe('the subscription panel and tree (§3.6)', () => {
  test('the title is offered as a placeholder and the date is shown', async () => {
    const expire = Math.floor(Date.now() / 1000) + 10 * 86400;
    const editor = await startEditor({links: linksWithHeaders({title: 'base64:Vmxlc3Mg8J+agA==', expire})});
    try {
      const html = await (await fetch(`${editor.base}/panel/provider:vpnd`)).text();
      assert.match(html, /в файле подписки: «Vless 🚀»/);
      assert.match(html, /placeholder="Vless 🚀"/);
      assert.match(html, /Подписка до \d{2}\.\d{2}\.\d{4}/);
      assert.match(html, /осталось \d+ дн\./);
    } finally {
      await editor.close();
    }
  });

  test('an expired subscription is marked on the panel and in the tree', async () => {
    const expire = Math.floor(Date.now() / 1000) - 86400;
    const editor = await startEditor({links: linksWithHeaders({title: 'Old', expire})});
    try {
      const panel = await (await fetch(`${editor.base}/panel/provider:vpnd`)).text();
      assert.match(panel, /Подписка истекла \d{2}\.\d{2}\.\d{4}/);

      const page = await (await fetch(`${editor.base}/`)).text();
      assert.match(page, /подписка истекла \d{2}\.\d{2}\.\d{4}/);
    } finally {
      await editor.close();
    }
  });

  test('expire=0 shows no date at all', async () => {
    const editor = await startEditor({links: linksWithHeaders({title: 'No date', expire: null})});
    try {
      const html = await (await fetch(`${editor.base}/panel/provider:vpnd`)).text();
      assert.doesNotMatch(html, /Подписка до/);
      assert.doesNotMatch(html, /Подписка истекла/);
    } finally {
      await editor.close();
    }
  });
});

describe('the apply bar and the apply chain (§1)', () => {
  test('the bar walks dirty → saved-not-applied → applied', async () => {
    const editor = await startEditor();
    try {
      // Fresh project: nothing generated yet → saved but not applied.
      let page = await (await fetch(`${editor.base}/`)).text();
      assert.match(page, /apply-pending/);
      assert.match(page, /сохранено, не применено/);

      // An edit marks the document dirty, which outranks everything else. The
      // sing-box panel posts its whole edit form to `/singbox`.
      await post(editor.base, '/singbox', {
        listen_ip: '10.0.0.9',
        urltest_url: 'https://gstatic.com',
        urltest_interval: '3m',
        urltest_tolerance: '50',
        log_level: 'info',
      });
      page = await (await fetch(`${editor.base}/`)).text();
      assert.match(page, /apply-dirty/);
      assert.match(page, /есть несохранённые правки/);

      // Apply does the whole chain with the fakes: save, build, check, install,
      // restart, poll.
      const applied = await post(editor.base, '/apply');
      const appliedHtml = await applied.text();
      assert.match(appliedHtml, /apply-applied/);
      assert.match(appliedHtml, /применено/);
      assert.match(appliedHtml, /установка файла/);
      assert.ok(fs.existsSync(editor.configPath), 'the live config.json is installed');
    } finally {
      await editor.close();
    }
  });

  test('a build refusal leaves the live config.json untouched', async () => {
    const editor = await startEditor();
    try {
      await post(editor.base, '/save', {panel: 'singbox'});
      const generated = await post(editor.base, '/generate');
      assert.equal(generated.status, 200);
      const before = fs.readFileSync(editor.configPath);

      // The only links file disappears: the build now refuses.
      fs.rmSync(path.join(editor.dir, 'providers', 'vpnd', 'links.txt'));

      const applied = await post(editor.base, '/apply');
      const html = await applied.text();
      assert.match(html, /apply-failed/);
      assert.match(html, /шаге «сборка»/);
      assert.match(html, /включённого провайдера со ссылками/);
      assert.deepEqual(
        fs.readFileSync(editor.configPath),
        before,
        'unchecked bytes are never left in the live file',
      );
    } finally {
      await editor.close();
    }
  });

  test('a daemon that does not come up rolls the snapshot back', async () => {
    const editor = await startEditor({system: {FAKE_SYSTEMCTL_INACTIVE: 'sing-box'}});
    try {
      // The live config is v1 and the daemon "does not come up" after a restart.
      await post(editor.base, '/save', {panel: 'singbox'});
      await post(editor.base, '/generate');
      const first = fs.readFileSync(editor.configPath);

      // A new edit is left UNSAVED on purpose: `/apply` saves it, builds a
      // different config, installs it, fails the restart and must restore v1.
      editor.model.applyGeneral({listen_ip: '10.0.0.9'});

      const applied = await post(editor.base, '/apply');
      const html = await applied.text();
      assert.match(html, /apply-failed/);
      assert.match(html, /откат/, 'the failure names the rollback');
      assert.deepEqual(
        fs.readFileSync(editor.configPath),
        first,
        'the snapshot was restored byte for byte',
      );
    } finally {
      await editor.close();
    }
  });
});

describe('the AmneziaWG sudoers block and carrier (§4)', () => {
  test('one block names the path and the missing and extra rules', async () => {
    const editor = await startEditor({tunnel: true, sudoersRules: ['other-old']});
    try {
      await markTunnel(editor);
      const html = await (await fetch(`${editor.base}/panel/system:amnezia`)).text();
      assert.match(html, /У туннелей hmn-graz4 нет прав/);
      assert.match(html, /sudo visudo -f /);
      assert.match(html, /enable --now gatehouse-tunnel@hmn-graz4/);
      assert.match(html, /data-copy="#sudoers-lines"/);
      // The rule for the tunnel that no longer exists is offered for removal.
      assert.match(html, /можно удалить/);
      assert.match(html, /gatehouse-tunnel@other-old/);
    } finally {
      await editor.close();
    }
  });

  test('the tunnel rows keep only a short «нет прав — см. блок выше»', async () => {
    const editor = await startEditor({tunnel: true, sudoersRules: ['other-old']});
    try {
      await markTunnel(editor);
      const html = await (await fetch(`${editor.base}/panel/system:amnezia`)).text();
      // The one block above the table carries the lines; the rows do not repeat
      // them (§3.1).
      assert.match(html, /нет прав — см\. блок выше/);
      assert.equal(
        html.split('enable --now gatehouse-tunnel@hmn-graz4').length - 1,
        1,
        'the rule appears once, in the block, not per row',
      );
    } finally {
      await editor.close();
    }
  });

  test('carrier marks the row and warns only on that tunnel', async () => {
    const editor = await startEditor({tunnel: true});
    try {
      await markTunnel(editor);
      const marked = await post(editor.base, '/tunnel/carrier', {name: 'hmn-graz4', carrier: '1'});
      assert.match(await marked.text(), /отмечен несущим/);

      const html = await (await fetch(`${editor.base}/panel/system:amnezia`)).text();
      assert.match(html, /badge">несущий/);
      assert.match(html, /Через этот туннель идёт ваш доступ к роутеру/);
      // The old hardcoded interface name is gone.
      assert.doesNotMatch(html, /interface === 'de'/);
    } finally {
      await editor.close();
    }
  });
});

describe('the config directory rights (§1)', () => {
  // `chmod 555` does not stop root, so the whole suite would be a false positive
  // there; skip honestly instead of asserting something the OS ignores.
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  test(
    'the bar warns with the fix command when the directory is not writable',
    {skip: asRoot},
    async () => {
      const editor = await startEditor();
      try {
        fs.chmodSync(editor.dir, 0o555);
        const page = await (await fetch(`${editor.base}/`)).text();
        assert.match(page, /apply-warning/);
        assert.match(page, /нет права писать в каталог/);
        assert.match(page, /chmod 775/);
        assert.match(page, /chown root:/);
      } finally {
        fs.chmodSync(editor.dir, 0o755);
        await editor.close();
      }
    },
  );

  test(
    '/apply refuses with the command and leaves the live file untouched',
    {skip: asRoot},
    async () => {
      const editor = await startEditor();
      try {
        fs.chmodSync(editor.dir, 0o555);
        const html = await (await post(editor.base, '/apply')).text();
        assert.match(html, /нет права писать в каталог/);
        assert.match(html, /chmod 775/);
        assert.equal(fs.existsSync(editor.configPath), false, 'nothing was written');
      } finally {
        fs.chmodSync(editor.dir, 0o755);
        await editor.close();
      }
    },
  );

  test('/rollback refuses with the command', {skip: asRoot}, async () => {
    const editor = await startEditor();
    try {
      fs.chmodSync(editor.dir, 0o555);
      const html = await (await post(editor.base, '/rollback')).text();
      assert.match(html, /нет права писать в каталог/);
      assert.match(html, /chmod 775/);
    } finally {
      fs.chmodSync(editor.dir, 0o755);
      await editor.close();
    }
  });
});

describe('«Применить» takes the open panel form (§1)', () => {
  const providerUrl = (id) => `/apply?panel=${encodeURIComponent(`provider:${id}`)}`;

  test('the form is applied first, then the chain: suffix and «включён» land', async () => {
    const editor = await startEditor({twin: true});
    try {
      const html = await (
        await post(editor.base, providerUrl('vpnd-ws'), {
          id: 'vpnd-ws',
          kind: 'subscription',
          suffix: 'WS',
          label: '',
          enabled: '1',
        })
      ).text();

      assert.match(html, /apply-applied/);
      assert.match(html, /форма панели/);
      const document = JSON.parse(fs.readFileSync(editor.settingsFile, 'utf8'));
      assert.equal(document.providers['vpnd-ws'].enabled, true);
      assert.equal(document.providers['vpnd-ws'].suffix, 'WS');

      const config = JSON.parse(fs.readFileSync(editor.configPath, 'utf8'));
      assert.ok(
        config.outbounds.some((outbound) => typeof outbound.tag === 'string' && outbound.tag.endsWith(' WS')),
        'the suffixed servers reached config.json',
      );
    } finally {
      await editor.close();
    }
  });

  test('a refusal on the form step stops before saving and building', async () => {
    const editor = await startEditor({twin: true});
    try {
      // Save first: opening a file whose folder has no kind yet leaves the model
      // dirty (the migration writes the inferred kind), and dirty outranks the
      // "failed" state in the bar.
      editor.model.save();
      const before = fs.readFileSync(editor.settingsFile, 'utf8');
      const html = await (
        await post(editor.base, providerUrl('vpnd-ws'), {
          id: 'vpnd-ws',
          kind: 'subscription',
          suffix: '',
          label: '',
          enabled: '1',
        })
      ).text();

      assert.match(html, /apply-failed/);
      assert.match(html, /форма панели/);
      assert.match(html, /задайте приписку/);
      assert.equal(fs.readFileSync(editor.settingsFile, 'utf8'), before, 'the file is not saved');
      assert.equal(fs.existsSync(editor.configPath), false, 'nothing was built');
    } finally {
      await editor.close();
    }
  });

  test('one submit sets the kind, the suffix and «включён»; without the suffix nothing applies', async () => {
    const editor = await startEditor({twin: true});
    try {
      const ok = await (
        await post(editor.base, '/provider', {
          id: 'vpnd-ws',
          kind: 'subscription',
          suffix: 'WS',
          label: 'Twin',
          enabled: '1',
        })
      ).text();
      assert.doesNotMatch(ok, /задайте приписку/);
      assert.equal(editor.model.getProvider('vpnd-ws').kind, 'subscription');
      assert.equal(editor.model.getProvider('vpnd-ws').suffix, 'WS');
      assert.equal(editor.model.getProvider('vpnd-ws').enabled, true);

      // A second folder, the same links, no suffix: the enabling refusal rolls the
      // WHOLE form back, the kind included.
      const otherFolder = path.join(editor.dir, 'providers', 'vpnd-tcp');
      fs.mkdirSync(otherFolder, {recursive: true});
      fs.writeFileSync(path.join(otherFolder, 'links.txt'), DEFAULT_LINKS);
      editor.model.setProviderEnabled('vpnd-ws', false);
      const before = editor.model.toText();

      const refused = await (
        await post(editor.base, '/provider', {
          id: 'vpnd-tcp',
          kind: 'subscription',
          suffix: '',
          label: '',
          enabled: '1',
        })
      ).text();
      assert.match(refused, /задайте приписку/);
      assert.equal(editor.model.toText(), before, 'nothing was applied');
      assert.equal(editor.model.getProvider('vpnd-tcp') ?? null, null, 'the kind was rolled back too');
    } finally {
      await editor.close();
    }
  });

  test('an enabled provider may not change its kind, and the same kind is a no-op', async () => {
    const editor = await startEditor();
    try {
      const same = await (
        await post(editor.base, '/provider', {id: 'vpnd', kind: 'subscription', label: 'X', enabled: '1'})
      ).text();
      assert.doesNotMatch(
        same,
        /<p class="error">провайдер включён: чтобы сменить вид/,
        'the same kind is accepted',
      );

      const changed = await (
        await post(editor.base, '/provider', {id: 'vpnd', kind: 'awg', label: 'X', enabled: '1'})
      ).text();
      assert.match(changed, /провайдер включён: чтобы сменить вид/);
      assert.equal(editor.model.getProvider('vpnd').kind, 'subscription', 'the kind did not move');
    } finally {
      await editor.close();
    }
  });

  test('a kind-less folder with links is not called empty', async () => {
    const editor = await startEditor({overrides: {providers: {}}});
    try {
      const html = await (await fetch(`${editor.base}/panel/provider:vpnd`)).text();
      assert.doesNotMatch(html, /Провайдер пуст/);
      assert.match(html, /Записей: 3/);
      assert.match(html, /похоже на подписку/);
    } finally {
      await editor.close();
    }
  });

  test('success answers the panel it came from, a failure switches to system:singbox', async () => {
    const editor = await startEditor();
    try {
      const ok = await (
        await post(editor.base, providerUrl('vpnd'), {id: 'vpnd', kind: 'subscription', label: '', enabled: '1'})
      ).text();
      assert.match(ok, /Провайдер: vpnd/);

      // Break the build: the only links file disappears.
      fs.rmSync(path.join(editor.dir, 'providers', 'vpnd', 'links.txt'));
      const failed = await (
        await post(editor.base, providerUrl('vpnd'), {id: 'vpnd', kind: 'subscription', label: '', enabled: '1'})
      ).text();
      assert.match(failed, /apply-failed/);
      assert.match(failed, /Журнал sing-box/);
    } finally {
      await editor.close();
    }
  });

  test('the bar takes the open form on a panel with a form and not on one without', async () => {
    const editor = await startEditor();
    try {
      const withForm = await (await fetch(`${editor.base}/panel/provider:vpnd`)).text();
      assert.match(withForm, /hx-post="\/apply\?panel=provider%3Avpnd"/);
      assert.match(withForm, /hx-include="#panel-form"/);
      assert.match(withForm, /form="panel-form"/);

      const withoutForm = await (await fetch(`${editor.base}/panel/system:singbox`)).text();
      assert.match(withoutForm, /hx-post="\/apply"/);
      assert.doesNotMatch(withoutForm, /hx-include="#panel-form"/);
    } finally {
      await editor.close();
    }
  });
});

// §5.4 of techdocs/plan_2026_10_02_gatehouse_missing_servers_soft.md: a partial
// loss of servers must not stop Apply; the bar warns and the document stays.
describe('missing servers on the apply bar (§3 of the plan)', () => {
  test('/apply applies with a warning and keeps the missing names in webui.json', async () => {
    const missing = '🇩🇪 Germany - Berlin';
    const editor = await startEditor({
      overrides: {
        proxies: [
          {tag: 'main-socks', type: 'socks', port: 54321},
          {tag: 'apps-http', type: 'http', port: 54323, servers: [FI_TAG, missing]},
        ],
      },
    });
    try {
      const html = await (await post(editor.base, '/apply')).text();

      assert.match(html, /apply-warning/);
      assert.match(html, /Применено, с предупреждениями/);
      assert.match(html, /1 из 2 серверов нет в списке — пропущены/);

      const document = JSON.parse(fs.readFileSync(editor.settingsFile, 'utf8'));
      const proxy = document.proxies.find((item) => item.tag === 'apps-http');
      assert.deepEqual(proxy.servers, [FI_TAG, missing], 'the names stay for a later rename');
    } finally {
      await editor.close();
    }
  });
});

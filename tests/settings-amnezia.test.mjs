// «Настройки»: the group node of the tree, the sing-box panel that absorbed
// «Общие»/«DNS»/«Вывод», and «Настройки Amnezia» — the output directory of the
// tunnel configs plus the regeneration of every enabled tunnel.
//
// The path itself is the interesting part: the write, the delete and the start-up
// fuse must all read the SAME directory, so the tests put the document value and
// the environment value in different places on purpose.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {startServer} from '../src/web/server.mjs';
import {
  FIXTURES_DIR,
  fakeSystemEnv,
  makeTempDir,
  tunnelSystemEnv,
  writeLinksFile,
  writeSettings,
  writeSudoers,
} from './helpers.mjs';

const PROVIDER_CONF = path.join(FIXTURES_DIR, 'tunnel', 'provider.conf');
const NORMALIZED_CONF = path.join(FIXTURES_DIR, 'tunnel', 'normalized.conf');

/** Escapes a path for use inside a RegExp. */
function pattern(text) {
  return new RegExp(String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

/**
 * Starts the editor over a project with one (or two) tunnel sources.
 *
 * `GATEHOUSE_AMNEZIA_DIR` is the ONLY source of the tunnel directory now that the
 * document no longer carries `amnezia_dir`, so the tests use it as the expected
 * path and feed the removed key to prove it is dropped.
 *
 * @param {{document?: Record<string, unknown>, sudoers?: string[], secondConf?: boolean}} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
async function startEditor(options = {}) {
  const dir = makeTempDir();
  writeLinksFile(dir);
  const tunnelDir = path.join(dir, 'providers', 'hidemyname');
  fs.mkdirSync(tunnelDir, {recursive: true});
  fs.copyFileSync(PROVIDER_CONF, path.join(tunnelDir, 'AustriaGrazS4.conf'));
  if (options.secondConf === true) {
    fs.copyFileSync(PROVIDER_CONF, path.join(tunnelDir, 'AustriaViennaS6.conf'));
  }

  const settingsFile = writeSettings(dir, {
    providers: {vpnd: {enabled: true}, hidemyname: {enabled: true}},
    proxies: [{tag: 'main-socks', type: 'socks', port: 54321}],
    ...(options.document ?? {}),
  });
  const stateDir = path.join(dir, 'state');
  const envDir = path.join(dir, 'env-amnezia');
  const sudoers = writeSudoers(path.join(dir, 'sudoers-gatehouse'), options.sudoers ?? []);

  const env = {
    ...fakeSystemEnv(),
    ...tunnelSystemEnv(dir, {sudoers}),
    GATEHOUSE_AMNEZIA_DIR: envDir,
    FAKE_SYSTEMCTL_ARGV_LOG: path.join(dir, 'argv.log'),
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
    model,
    envDir,
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
  // Arrays become REPEATED fields, exactly as a browser submits a row of
  // checkboxes: `String(['a', 'b'])` would send one value "a,b" instead.
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const item of value) params.append(key, String(item));
    else params.append(key, String(value));
  }
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded', 'HX-Request': 'true'},
    body: params,
  });
}

/** Every argv the fake `systemctl` saw, in order. */
function systemctlCalls(editor) {
  const log = editor.env.FAKE_SYSTEMCTL_ARGV_LOG;
  if (!fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/** A mark form for the graz tunnel. */
const GRAZ_MARK = {
  provider: 'hidemyname',
  file: 'AustriaGrazS4.conf',
  name: 'hidemyname-AustriaGrazS4',
  interface: 'hmn-graz4',
  needed: '1',
};

describe('the «Настройки» group of the tree (NEW)', () => {
  test('it is a heading with two children and never a link', async () => {
    const editor = await startEditor();
    try {
      const html = await (await fetch(editor.base)).text();

      assert.match(html, /<span class="group"[^>]*>Настройки<\/span>/);
      assert.doesNotMatch(html, /\/panel\/settings/, 'a group has no page to open');
      assert.match(html, /panel\/singbox/);
      assert.match(html, /panel\/amnezia/);
      assert.match(html, /Настройки Sing-Box/);
      assert.match(html, /Настройки Amnezia/);

      // The flat nodes are gone with their panels.
      assert.doesNotMatch(html, /panel\/general/);
      assert.doesNotMatch(html, /panel\/dns/);
      assert.doesNotMatch(html, /panel\/output/);
    } finally {
      await editor.close();
    }
  });

  test('the sing-box panel joins the three sections under one form', async () => {
    const editor = await startEditor();
    try {
      const html = await (await fetch(`${editor.base}/panel/singbox`)).text();

      assert.equal(html.split('id="panel-form"').length - 1, 1, 'exactly one edit form');
      assert.match(html, /name="listen_ip"/);
      assert.match(html, /<textarea[^>]*name="dns"/);
      assert.match(html, /name="output_file"/);
      assert.match(html, /Настройки Sing-Box/);
    } finally {
      await editor.close();
    }
  });
});

describe('the amnezia output directory (NEW)', () => {
  test('the panel shows the resolved path read-only, and a document value is dropped', async () => {
    const editor = await startEditor({document: {amnezia_dir: '/tmp/elsewhere'}});
    try {
      const html = await (await fetch(`${editor.base}/panel/amnezia`)).text();
      assert.doesNotMatch(html, /name="amnezia_dir"/, 'the path is not editable');
      assert.match(html, /источник: GATEHOUSE_AMNEZIA_DIR/);
      assert.match(html, pattern(editor.envDir), 'the environment directory is shown resolved');

      // The removed key never reaches the document, and the notice names it.
      assert.equal(editor.model.body().amnezia_dir, undefined);
      assert.equal(editor.model.amneziaDir, editor.envDir, 'the environment is the only source');
      assert.match(editor.model.removedNotice, /amnezia_dir/);
    } finally {
      await editor.close();
    }
  });

  test('the write and the start-up fuse read the SAME directory, and the document cannot redirect them', async () => {
    const editor = await startEditor({
      document: {amnezia_dir: 'tunnels'},
      sudoers: ['hmn-graz4'],
    });
    try {
      await post(editor.base, '/tunnels', GRAZ_MARK);
      assert.ok(
        fs.existsSync(path.join(editor.envDir, 'hmn-graz4.conf')),
        'written to the environment directory',
      );
      assert.equal(
        fs.existsSync(path.join(editor.dir, 'tunnels')),
        false,
        'the removed document value points nowhere',
      );

      // Someone drops a raw provider config over the applied file: the fuse reads
      // the SAME directory and refuses, naming the exact path.
      fs.writeFileSync(path.join(editor.envDir, 'hmn-graz4.conf'), '[Interface]\nPrivateKey = x\n');
      const html = await (
        await post(editor.base, '/tunnel/toggle', {name: 'hmn-graz4', up: '1'})
      ).text();

      assert.match(html, /Table = off/);
      assert.match(html, pattern(path.join(editor.envDir, 'hmn-graz4.conf')));
    } finally {
      await editor.close();
    }
  });
});

describe('«исключить из автовыбора» as a checkbox list (NEW)', () => {
  test('one row per flag of the loaded servers, the default prefix checked', async () => {
    const editor = await startEditor();
    try {
      const options = editor.model.excludePrefixOptions();
      assert.deepEqual(
        options.options.map((option) => option.prefix).sort(),
        ['🇫🇮', '🇳🇱', '🇷🇺'].sort(),
        'one row per distinct flag of the loaded servers',
      );
      assert.ok(options.options.every((option) => option.count === 1));
      assert.deepEqual(options.selected, ['🇷🇺'], 'the stored default is checked');
      assert.deepEqual(options.unknown, []);

      const html = await (await fetch(`${editor.base}/panel/singbox`)).text();
      assert.match(html, /исключить из автовыбора/);
      assert.match(html, /name="exclude_from_auto" value="🇫🇮"/);
      assert.match(html, /name="exclude_from_auto" value="🇳🇱"/);
      assert.match(html, /name="exclude_from_auto" value="🇷🇺"\s+checked/);
    } finally {
      await editor.close();
    }
  });

  test('an absent key means the core default, and a stored unknown prefix stays checked', async () => {
    // `undefined` drops the key from the written JSON, like an old webui.json that
    // never carried `exclude_from_auto` at all.
    const editor = await startEditor({document: {exclude_from_auto: undefined}});
    try {
      assert.deepEqual(editor.model.excludePrefixOptions().selected, ['🇷🇺']);
    } finally {
      await editor.close();
    }

    const second = await startEditor({document: {exclude_from_auto: ['🇦🇹']}});
    try {
      const options = second.model.excludePrefixOptions();
      assert.deepEqual(options.selected, ['🇦🇹']);
      assert.deepEqual(options.unknown, ['🇦🇹'], 'no server carries this flag right now');

      const html = await (await fetch(`${second.base}/panel/singbox`)).text();
      assert.match(html, /нет в списке/);
      assert.match(html, /value="🇦🇹" checked/, 'the stored rule stays ticked');
    } finally {
      await second.close();
    }
  });

  test('the boxes are saved as a list, and an empty list excludes nothing', async () => {
    const editor = await startEditor();
    try {
      const general = {
        listen_ip: '127.0.0.1',
        urltest_url: 'https://gstatic.com',
        urltest_interval: '3m',
        urltest_tolerance: '50',
        log_level: 'info',
      };

      await post(editor.base, '/singbox', {...general, exclude_from_auto: ['🇫🇮', '🇩🇪']});
      assert.deepEqual(editor.model.body().exclude_from_auto, ['🇫🇮', '🇩🇪']);

      // Unticking every box stores an EMPTY list — "exclude nothing" — not the
      // core default, which only applies to a document without the key.
      await post(editor.base, '/singbox', general);
      assert.deepEqual(editor.model.body().exclude_from_auto, []);
      assert.deepEqual(editor.model.excludePrefixOptions().selected, []);
    } finally {
      await editor.close();
    }
  });
});

describe('regenerating the enabled tunnel configs (NEW)', () => {
  test('it rewrites the applied files, and an unchanged rerun does not dirty the model', async () => {
    const editor = await startEditor();
    try {
      await post(editor.base, '/tunnels', GRAZ_MARK);
      await post(editor.base, '/save', {panel: 'amnezia'});
      assert.equal(editor.model.dirty, false);

      const target = path.join(editor.model.amneziaDir, 'hmn-graz4.conf');
      fs.writeFileSync(target, 'damaged\n');

      const html = await (await post(editor.base, '/amnezia/regenerate', {})).text();
      assert.match(html, /Туннелей: 1, изменено: 1, ошибок: 0/);
      assert.equal(
        fs.readFileSync(target, 'utf8'),
        fs.readFileSync(NORMALIZED_CONF, 'utf8'),
        'the normaliser output is restored byte for byte',
      );
      assert.equal(
        editor.model.dirty,
        false,
        'rewriting a file the document already describes is not a model change',
      );

      const again = await (await post(editor.base, '/amnezia/regenerate', {})).text();
      assert.match(again, /изменено: 0/);
    } finally {
      await editor.close();
    }
  });

  test('a source that disappeared is reported, and the other tunnels still run', async () => {
    const editor = await startEditor({secondConf: true});
    try {
      await post(editor.base, '/tunnels', GRAZ_MARK);
      await post(editor.base, '/tunnels', {
        provider: 'hidemyname',
        file: 'AustriaViennaS6.conf',
        name: 'hidemyname-AustriaViennaS6',
        interface: 'hmn-wien',
        needed: '1',
      });
      await post(editor.base, '/save', {panel: 'amnezia'});

      const graz = path.join(editor.model.amneziaDir, 'hmn-graz4.conf');
      fs.writeFileSync(graz, 'damaged\n');
      fs.rmSync(path.join(editor.dir, 'providers', 'hidemyname', 'AustriaViennaS6.conf'));

      const html = await (await post(editor.base, '/amnezia/regenerate', {})).text();

      assert.match(html, /Туннелей: 2, изменено: 1, ошибок: 1/);
      assert.match(html, /AustriaViennaS6\.conf/, 'the failure names the missing source');
      assert.equal(
        fs.readFileSync(graz, 'utf8'),
        fs.readFileSync(NORMALIZED_CONF, 'utf8'),
        'the healthy tunnel is rewritten anyway',
      );

      const mutating = systemctlCalls(editor).filter((argv) =>
        argv.some((word) => ['restart', 'enable', 'disable', 'start', 'stop'].includes(word)),
      );
      assert.deepEqual(mutating, [], 'regeneration never starts or stops a unit');
    } finally {
      await editor.close();
    }
  });
});

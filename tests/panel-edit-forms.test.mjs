// A panel has ONE edit form element, and every «Применить» button on it applies
// the WHOLE panel.
//
// The defect: "Значения по умолчанию" carries two routes — the general fields
// (`/general`) and the DNS text (`/dns`). Each button applied only its own route,
// and «Сохранить» was bound to a single route, so a DNS edit followed by
// «Применить» (or by «Сохранить») was thrown away exactly as the previous save
// bug did one level up. `profiles` was declared to have no edit form at all, so
// the note field was discarded the same way.
//
// The last test is the important one: it renders EVERY panel and demands that
// each form with input fields is either the edit form (`id="panel-form"`) or a
// known action form, listed inside the test. A new form on any panel fails the
// test until it has been classified.

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {PANEL_KINDS} from '../src/web/panel.mjs';
import {startServer} from '../src/web/server.mjs';
import {FI_TAG, makeTempDir, writeLinksFile, writeSettings} from './helpers.mjs';

/**
 * Starts the editor over a temporary project.
 *
 * @param {{overrides?: Record<string, unknown>, extra?: Record<string, unknown>}} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
async function startEditor(options = {}) {
  const dir = makeTempDir();
  const linksFile = writeLinksFile(dir);
  const settingsFile = writeSettings(dir, options.overrides ?? {}, options.extra ?? {});
  const stateDir = path.join(dir, 'state');

  const {server, model, url} = await startServer({
    env: {
      SINGBOX_WEBUI_SETTINGS: settingsFile,
      SINGBOX_WEBUI_HOST: '127.0.0.1',
      SINGBOX_WEBUI_PORT: '0',
      SINGBOX_WEBUI_STATE_DIR: stateDir,
    },
  });

  return {
    dir,
    linksFile,
    settingsFile,
    stateDir,
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
 * @param {Record<string, unknown>} [fields]
 * @param {boolean} [htmx]
 * @returns {Promise<Response>}
 */
async function post(base, route, fields = {}, htmx = true) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const item of value) params.append(key, String(item));
    else params.append(key, String(value));
  }
  const headers = {'Content-Type': 'application/x-www-form-urlencoded'};
  if (htmx) headers['HX-Request'] = 'true';
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers,
    body: params,
    redirect: 'manual',
  });
}

/** Reads the document of a settings file. */
function storedDocument(settingsFile) {
  return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
}

/** SHA-256 of a file. */
function digest(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** General fields of the shared settings form, as the browser sends them. */
const GENERAL_FIELDS = Object.freeze({
  listen_ip: '10.95.2.1',
  urltest_url: 'https://example.org',
  urltest_interval: '5m',
  urltest_tolerance: '42',
  log_level: 'debug',
  log_timestamp: '1',
  exclude_from_auto: '🇷🇺\n🇩🇪',
});

/** The DNS text of the defaults panel. */
const DNS_TEXT = '{"servers": [], "final": "direct"}';

describe('one edit form per panel applies the whole panel', () => {
  test('«Сохранить» on defaults applies both the general fields and the DNS text', async () => {
    const editor = await startEditor({extra: {defaults: {listen_ip: '10.0.0.1'}}});
    try {
      // Exactly what the browser sends: the fields of the edit form, and only
      // them — no prior «Применить» request.
      const response = await post(editor.base, '/save?panel=defaults', {
        panel: 'defaults',
        scope: 'defaults',
        ...GENERAL_FIELDS,
        dns: DNS_TEXT,
      });

      assert.match(await response.text(), /правка формы применена и сохранена/i);

      const document = storedDocument(editor.settingsFile);
      assert.equal(document.defaults.listen_ip, '10.95.2.1', 'the general fields reached the file');
      assert.deepEqual(
        document.defaults.dns,
        {servers: [], final: 'direct'},
        'the DNS text reached the file too',
      );
    } finally {
      await editor.close();
    }
  });

  test('«Применить» on defaults applies the DNS text as well', async () => {
    const editor = await startEditor({extra: {defaults: {listen_ip: '10.0.0.1'}}});
    try {
      const response = await post(editor.base, '/general', {
        scope: 'defaults',
        ...GENERAL_FIELDS,
        dns: DNS_TEXT,
      });

      assert.match(await response.text(), /Применено/);
      assert.equal(editor.model.defaultsBody().listen_ip, '10.95.2.1');
      assert.deepEqual(editor.model.defaultsBody().dns, {servers: [], final: 'direct'});
    } finally {
      await editor.close();
    }
  });

  test('«Применить DNS» on defaults applies the general fields as well', async () => {
    const editor = await startEditor({extra: {defaults: {listen_ip: '10.0.0.1'}}});
    try {
      const response = await post(editor.base, '/dns', {
        scope: 'defaults',
        ...GENERAL_FIELDS,
        dns: DNS_TEXT,
      });

      assert.match(await response.text(), /DNS применён/);
      assert.equal(editor.model.defaultsBody().listen_ip, '10.95.2.1');
      assert.deepEqual(editor.model.defaultsBody().dns, {servers: [], final: 'direct'});
    } finally {
      await editor.close();
    }
  });

  test('a partial post of one route stays a partial edit of the panel', async () => {
    const editor = await startEditor({extra: {defaults: {listen_ip: '10.0.0.1'}}});
    try {
      // A body without the `dns` field (a direct API client, not the form): the
      // general route applies, the DNS route has nothing to do and is skipped.
      const response = await post(editor.base, '/general', {scope: 'defaults', ...GENERAL_FIELDS});

      assert.match(await response.text(), /Применено/);
      assert.equal(editor.model.defaultsBody().listen_ip, '10.95.2.1');
      assert.ok(!Object.hasOwn(editor.model.defaultsBody(), 'dns'));
    } finally {
      await editor.close();
    }
  });

  test('without htmx the same save redirects and still applies both routes', async () => {
    const editor = await startEditor({extra: {defaults: {listen_ip: '10.0.0.1'}}});
    try {
      const response = await post(
        editor.base,
        '/save?panel=defaults',
        {panel: 'defaults', scope: 'defaults', ...GENERAL_FIELDS, dns: DNS_TEXT},
        false,
      );

      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), '/panel/defaults');

      const document = storedDocument(editor.settingsFile);
      assert.equal(document.defaults.listen_ip, '10.95.2.1');
      assert.deepEqual(document.defaults.dns, {servers: [], final: 'direct'});
    } finally {
      await editor.close();
    }
  });
});

describe('applying a list of routes is atomic', () => {
  test('a broken DNS text refuses the whole panel and leaves the model untouched', async () => {
    const editor = await startEditor({extra: {defaults: {listen_ip: '10.0.0.1'}}});
    try {
      const before = digest(editor.settingsFile);

      const response = await post(editor.base, '/save?panel=defaults', {
        panel: 'defaults',
        scope: 'defaults',
        ...GENERAL_FIELDS,
        dns: '{oops',
      });
      const html = await response.text();

      assert.match(html, /не валидный JSON/);
      assert.equal(digest(editor.settingsFile), before, 'webui.json is byte for byte the same');

      // The general route ran first and had already written into the model. The
      // rollback must have put it back, or the owner would see a failure while the
      // in-memory document silently kept half of the edit.
      assert.equal(editor.model.defaultsBody().listen_ip, '10.0.0.1', 'the model was rolled back');
      assert.equal(editor.model.dirty, false, 'a refused edit does not leave the model dirty');
      assert.match(html, /value="10\.0\.0\.1"/, 'the redrawn panel shows the previous value');
    } finally {
      await editor.close();
    }
  });

  test('a rejected first route never reaches the second one', async () => {
    const editor = await startEditor({extra: {defaults: {listen_ip: '10.0.0.1'}}});
    try {
      const before = digest(editor.settingsFile);

      // `urltest_tolerance` is not an integer: the general route refuses before
      // the DNS route is even tried.
      const response = await post(editor.base, '/save?panel=defaults', {
        panel: 'defaults',
        scope: 'defaults',
        ...GENERAL_FIELDS,
        urltest_tolerance: 'abc',
        dns: DNS_TEXT,
      });

      assert.match(await response.text(), /целым числом/);
      assert.equal(digest(editor.settingsFile), before);
      assert.ok(!Object.hasOwn(editor.model.defaultsBody(), 'dns'), 'the DNS route never ran');
    } finally {
      await editor.close();
    }
  });
});

describe('the profiles panel edits only the note', () => {
  test('«Сохранить» writes the note of the active profile', async () => {
    const editor = await startEditor({extra: {profileName: 'default'}});
    try {
      const response = await post(editor.base, '/save?panel=profiles', {
        panel: 'profiles',
        action: 'note',
        note: 'заметка через сохранить',
      });

      assert.match(await response.text(), /Заметка|правка формы применена/i);
      assert.equal(
        storedDocument(editor.settingsFile).profiles.default.note,
        'заметка через сохранить',
      );
    } finally {
      await editor.close();
    }
  });

  test('«Сохранить» refuses any action but note', async () => {
    const editor = await startEditor({extra: {profileName: 'default'}});
    try {
      const before = digest(editor.settingsFile);

      const response = await post(editor.base, '/save?panel=profiles', {
        panel: 'profiles',
        action: 'delete',
      });

      assert.match(await response.text(), /только заметку/);
      assert.deepEqual(editor.model.profileNames(), ['default'], 'the profile is still there');
      assert.equal(digest(editor.settingsFile), before, 'webui.json is untouched');
    } finally {
      await editor.close();
    }
  });
});

describe('the markup keeps one form element per panel', () => {
  test('defaults binds the DNS field and its button to the one panel-form', async () => {
    const editor = await startEditor();
    try {
      const html = await (await fetch(`${editor.base}/panel/defaults`)).text();

      assert.equal(
        html.split('id="panel-form"').length - 1,
        1,
        'exactly one form element on the panel',
      );
      assert.match(
        html,
        /<textarea[^>]*name="dns"[^>]*form="panel-form"/,
        'the DNS text belongs to the edit form through the form attribute',
      );
      assert.match(
        html,
        /<button[^>]*form="panel-form"[^>]*formaction="\/dns"/,
        '«Применить DNS» submits the same form to /dns',
      );
      assert.match(html, />Применить<\/button>/, 'the general «Применить» is still there');
      assert.match(html, /Применить DNS/, '«Применить DNS» is still there');
      // No nested form: the DNS block is a plain <div>, the field joins the one
      // form through the `form` attribute instead.
      assert.match(
        html,
        /<h3>DNS в defaults<\/h3>\s*<div class="form">\s*<textarea[^>]*name="dns"[^>]*form="panel-form"/,
        'the DNS block is not wrapped in a second form',
      );
    } finally {
      await editor.close();
    }
  });

  test('profiles marks its note form as the edit form', async () => {
    const editor = await startEditor();
    try {
      const html = await (await fetch(`${editor.base}/panel/profiles`)).text();

      assert.match(
        html,
        /<form id="panel-form"[^>]*>[\s\S]*?name="action" value="note"[\s\S]*?<\/form>/,
        'the note form is the edit form',
      );
      assert.equal(html.split('id="panel-form"').length - 1, 1);
    } finally {
      await editor.close();
    }
  });
});

// ------------------------------------------------------------------
// The watchdog against the whole class of defect
// ------------------------------------------------------------------

/** Action forms that carry input fields and are allowed to be neither the edit form. */
const EDITABLE_ACTION_FORMS = Object.freeze({
  // The rename and create forms each have a text input; every other action form
  // on the panel holds hidden fields only, and is therefore not inspected here.
  profiles: [
    {route: '/profiles', hidden: 'rename'},
    {route: '/profiles', hidden: 'create'},
  ],
});

/**
 * Splits the rendered HTML into its `<form>` elements.
 *
 * @param {string} html
 * @returns {Array<{attrs: string, inner: string}>}
 */
function forms(html) {
  return [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].map((match) => ({
    attrs: match[1],
    inner: match[2],
  }));
}

/**
 * True when a form carries at least one visible input field. Hidden fields and
 * the submit buttons do not count: firing a delete or a create is exactly what
 * those forms do, and they are not what «Сохранить» must pick up.
 *
 * @param {{inner: string}} form
 * @returns {boolean}
 */
function hasInputFields(form) {
  const inputs = [...form.inner.matchAll(/<input\b[^>]*>/g)].filter((match) => {
    const type = match[0].match(/\btype="([^"]*)"/);
    return !type || !['hidden', 'submit', 'button', 'reset', 'image'].includes(type[1]);
  });
  return (
    inputs.length > 0 || /<textarea\b/.test(form.inner) || /<select\b/.test(form.inner)
  );
}

/** The route a form posts to, from its `action` attribute. */
function formRoute(form) {
  const match = form.attrs.match(/\baction="([^"]*)"/);
  return match ? match[1] : null;
}

/** Value of the hidden `action` field of a form, if it has one. */
function formHiddenAction(form) {
  const match = form.inner.match(/name="action"\s+value="([^"]*)"/);
  return match ? match[1] : null;
}

/** Tree key of every panel kind, using the entities the default project carries. */
function keyFor(kind, model) {
  if (kind === 'proxy') return `proxy:${model.proxyTags()[0]}`;
  if (kind === 'route') return `route:${model.routeNames()[0]}`;
  return kind;
}

describe('every panel form is either the edit form or a known action form', () => {
  test('no unclassified form with input fields exists on any panel', async () => {
    const editor = await startEditor();
    try {
      const failures = [];

      for (const kind of PANEL_KINDS) {
        const key = keyFor(kind, editor.model);
        const html = await (
          await fetch(`${editor.base}/panel/${encodeURIComponent(key)}`)
        ).text();

        let editForms = 0;
        for (const form of forms(html)) {
          if (!hasInputFields(form)) continue;

          if (/id="panel-form"/.test(form.attrs)) {
            editForms += 1;
            continue;
          }

          const allowed = (EDITABLE_ACTION_FORMS[kind] ?? []).some(
            (entry) => entry.route === formRoute(form) && entry.hidden === formHiddenAction(form),
          );
          if (!allowed) {
            failures.push(
              `${kind}: form action="${formRoute(form)}" ` +
                `hidden action="${formHiddenAction(form)}" is neither id="panel-form" ` +
                `nor listed in EDITABLE_ACTION_FORMS`,
            );
          }
        }

        assert.ok(
          editForms <= 1,
          `${kind}: a panel must not carry more than one id="panel-form" (found ${editForms})`,
        );
      }

      assert.deepEqual(failures, [], `unclassified forms:\n  - ${failures.join('\n  - ')}`);
    } finally {
      await editor.close();
    }
  });
});

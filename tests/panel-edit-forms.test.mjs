// A panel has ONE edit form element, and every «Применить» button on it applies
// the WHOLE panel.
//
// Since version 2 no panel carries two edit routes any more: the defaults panel
// and the profile note are gone, so `general`, `dns`, `links`, `output`,
// `watchdog`, `proxy` and `route` each own exactly one form. The invariant is
// still worth guarding, because the defect it closed was "the header «Сохранить»
// silently applied only part of what the panel showed" — and the watchdog at the
// bottom renders EVERY panel and demands that each form with input fields is
// either the edit form (`id="panel-form"`) or a known action form, listed inside
// the test. A new form on any panel fails the test until it has been classified.

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {PANEL_KINDS} from '../src/web/panel.mjs';
import {startServer} from '../src/web/server.mjs';
import {makeTempDir, writeLinksFile, writeSettings} from './helpers.mjs';

/**
 * Starts the editor over a temporary project.
 *
 * @param {{overrides?: Record<string, unknown>}} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
async function startEditor(options = {}) {
  const dir = makeTempDir();
  const linksFile = writeLinksFile(dir);
  const settingsFile = writeSettings(dir, options.overrides ?? {});
  const stateDir = path.join(dir, 'state');

  const {server, model, url} = await startServer({
    env: {
      GATEHOUSE_SETTINGS: settingsFile,
      GATEHOUSE_HOST: '127.0.0.1',
      GATEHOUSE_PORT: '0',
      GATEHOUSE_STATE_DIR: stateDir,
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

/** General fields of the settings form, as the browser sends them. */
const GENERAL_FIELDS = Object.freeze({
  listen_ip: '10.95.2.1',
  urltest_url: 'https://example.org',
  urltest_interval: '5m',
  urltest_tolerance: '42',
  log_level: 'debug',
  log_timestamp: '1',
  exclude_from_auto: '🇷🇺\n🇩🇪',
});

/** The DNS text of the dns panel. */
const DNS_TEXT = '{"servers": [], "final": "direct"}';

describe('the general panel is the single settings form', () => {
  test('«Сохранить» applies the general fields and writes the file', async () => {
    const editor = await startEditor();
    try {
      const response = await post(editor.base, '/save?panel=general', {
        panel: 'general',
        ...GENERAL_FIELDS,
      });

      assert.match(await response.text(), /правка формы применена и сохранена/i);

      const document = storedDocument(editor.settingsFile);
      assert.equal(document.listen_ip, '10.95.2.1');
      assert.deepEqual(document.urltest, {
        url: 'https://example.org',
        interval: '5m',
        tolerance: 42,
      });
      assert.deepEqual(document.log, {level: 'debug', timestamp: true});
    } finally {
      await editor.close();
    }
  });

  test('without htmx the same save redirects and still applies', async () => {
    const editor = await startEditor();
    try {
      const response = await post(editor.base, '/save?panel=general', {panel: 'general', ...GENERAL_FIELDS}, false);

      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), '/panel/general');
      assert.equal(storedDocument(editor.settingsFile).listen_ip, '10.95.2.1');
    } finally {
      await editor.close();
    }
  });
});

describe('the dns panel keeps its own edit form', () => {
  test('a broken DNS text refuses, writes nothing and leaves the model untouched', async () => {
    const editor = await startEditor();
    try {
      const before = digest(editor.settingsFile);

      const response = await post(editor.base, '/save?panel=dns', {
        panel: 'dns',
        dns: '{oops',
      });
      const html = await response.text();

      assert.match(html, /не валидный JSON/);
      assert.equal(digest(editor.settingsFile), before, 'webui.json is byte for byte the same');
      assert.equal(editor.model.dirty, false, 'a refused edit does not leave the model dirty');
    } finally {
      await editor.close();
    }
  });

  test('«Применить DNS» stores a JSON object', async () => {
    const editor = await startEditor();
    try {
      const response = await post(editor.base, '/dns', {dns: DNS_TEXT});

      assert.match(await response.text(), /DNS применён/);
      assert.deepEqual(editor.model.body().dns, {servers: [], final: 'direct'});
    } finally {
      await editor.close();
    }
  });
});

describe('the markup keeps one form element per panel', () => {
  test('general binds the settings fields to the one panel-form', async () => {
    const editor = await startEditor();
    try {
      const html = await (await fetch(`${editor.base}/panel/general`)).text();

      assert.equal(html.split('id="panel-form"').length - 1, 1, 'exactly one form element');
      assert.match(html, /name="listen_ip"/);
      assert.match(html, />Применить<\/button>/);
    } finally {
      await editor.close();
    }
  });

  test('dns binds its textarea to the one panel-form', async () => {
    const editor = await startEditor();
    try {
      const html = await (await fetch(`${editor.base}/panel/dns`)).text();

      assert.equal(html.split('id="panel-form"').length - 1, 1);
      assert.match(html, /<textarea[^>]*name="dns"/);
      assert.match(html, /Применить DNS/);
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
  // The journal is a snapshot: its refresh form carries the unit and the level and
  // GETs the panel again. It is an action form, not an edit form — there is
  // nothing to save, so it must not be `id="panel-form"`.
  journal: [{route: '/panel/journal', hidden: null}],
  // The tunnel preview only shows what the normaliser WOULD change: its single
  // policy-routing checkbox posts to its own route and rewrites the file of a
  // marked tunnel. There is no apply, so it is an action form too.
  tunnel: [{route: '/tunnel/policy', hidden: null}],
  // The providers panel edits the LIST through action forms, not through one edit
  // form: "add" carries the folder picker, "remove" sits on each row. There is
  // nothing to "apply", so neither is `id="panel-form"`.
  providers: [
    {route: '/providers', hidden: 'add'},
    {route: '/providers', hidden: 'remove'},
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
  if (kind === 'provider') return `provider:${model.sourcesInfo().providers[0].name}`;
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

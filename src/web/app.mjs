// The Express application of the web editor.
//
// The routes here do exactly three things: read the request, call a model
// method, hand the result to `panel.mjs` and a template. No business rule lives
// in a handler, so replacing the view layer (EJS + htmx today, React tomorrow)
// cannot move any behaviour.
//
// Every mutation answers with two shapes:
//   * an htmx request gets the panel fragment plus out-of-band swaps of the tree
//     and the header, with `HX-Push-Url` so the address bar follows the panel;
//   * a plain form post (htmx failed to load, JavaScript off) gets a 303 back to
//     the panel URL, so the tool stays usable without any client script.

import path from 'node:path';
import process from 'node:process';

import express from 'express';

import {ConfigError} from '../core/errors.mjs';
import {ProjectModel} from '../model/project.mjs';
import {restoreLatestConfig, snapshotConfig} from '../model/storage.mjs';
import {API_SECRET_VAR} from '../core/build.mjs';
import {
  PRIORITY_LEVELS,
  SystemError,
  checkConfig,
  restartSingBox,
  systemConfig,
  tailJournal,
  testOutbounds,
} from '../system/index.mjs';
import {Watchdog} from '../watchdog/watchdog.mjs';
import {TOKEN_COOKIE, extractToken, tokenMatches} from './auth.mjs';
import * as forms from './forms.mjs';
import {
  PANEL_KINDS,
  buildPanel,
  buildStatus,
  editFormRoutes,
  panelKey,
  panelUrl,
  parsePanelKey,
} from './panel.mjs';

const ROOT = path.join(import.meta.dirname, '..', '..');
const VIEWS = path.join(ROOT, 'views');
const PUBLIC = path.join(ROOT, 'public');

/**
 * True when the host-facing paths of the process point into a `dev/` directory.
 *
 * That is how `npm run dev` marks the sandbox: the settings file, the generated
 * config and the state directory all live under `dev/root/`. The marker is derived
 * from the paths and not from a flag, so a stray variable cannot make a
 * production instance pretend to be a sandbox — and the tests can reproduce it by
 * pointing the variables at a directory literally called `dev`.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
export function isDevSandbox(env = process.env) {
  const marker = `${path.sep}dev${path.sep}`;
  return ['GATEHOUSE_SETTINGS', 'GATEHOUSE_CONFIG', 'GATEHOUSE_STATE_DIR'].some((key) => {
    const value = env[key];
    return typeof value === 'string' && value.length > 0 && value.includes(marker);
  });
}

/** Panel shown when nothing else is asked for. */
export const DEFAULT_PANEL = 'general';

/** How many journal lines one snapshot of the journal shows. */
export const JOURNAL_SNAPSHOT_LINES = 200;
/** Minimum level a journal snapshot starts from; `debug` shows everything. */
export const DEFAULT_JOURNAL_LEVEL = 'info';
/** The most lines a snapshot may ask for, so one request stays cheap. */
const JOURNAL_MAX_LINES = 1000;

/** How long a check may take before it is killed; `sing-box check` is instant. */
const CHECK_TIMEOUT = 15000;

/** Keep of the `config.json` snapshots taken before each generation. */
const CONFIG_SNAPSHOT_KEEP = 10;

/**
 * Field names that mark a body as carrying one edit-form route. A route whose
 * fields are all absent is left alone, so a direct POST of a single route stays a
 * partial edit of a panel whose edit form has several routes instead of being
 * refused over a missing sibling field.
 */
const ROUTE_FIELDS = Object.freeze({
  '/proxy': ['tag', 'type', 'port'],
  '/route': ['name', 'outbound'],
  '/dns': ['dns'],
  '/links': ['links_file'],
  '/output': ['output_file'],
  '/watchdog': ['interval_seconds'],
  '/general': [
    'listen_ip',
    'urltest_url',
    'urltest_interval',
    'urltest_tolerance',
    'log_level',
    'exclude_from_auto',
  ],
});

/**
 * Shapes one outbound test result for the wire: the row of the table, without
 * the whole stdout of the command, which the SSE stream has no use for.
 *
 * @param {Record<string, unknown>} result
 * @returns {Record<string, unknown>}
 */
function testResultView(result) {
  return {
    tag: result.tag,
    ok: Boolean(result.ok && result.parsed),
    exitOk: Boolean(result.ok),
    elapsed: typeof result.elapsed === 'number' ? result.elapsed : null,
    city: result.city ?? null,
    ip: result.ip ?? null,
    timedOut: Boolean(result.timedOut),
    error: result.error ?? null,
  };
}

/**
 * Writes one `text/event-stream` frame. Silently ignores a closed socket: the
 * browser closing a tab is normal, not an error of the editor.
 *
 * @param {import('express').Response} res
 * @param {string} event
 * @param {unknown} data
 */
function writeEvent(res, event, data) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Headers of every SSE response. `no-transform` stops a proxy from buffering. */
const SSE_HEADERS = Object.freeze({
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
});

/**
 * Builds the Express app.
 *
 * @param {{model?: ProjectModel, settingsPath?: string|null, stateDir?: string,
 *   snapshotKeep?: number}} [options] `model` is injected by the tests; otherwise
 *   one is created and bound to `settingsPath`.
 * @returns {import('express').Express}
 */
export function createApp(options = {}) {
  const model =
    options.model ??
    new ProjectModel({
      path: options.settingsPath ?? null,
      stateDir: options.stateDir,
      snapshotKeep: options.snapshotKeep,
    });

  const token = typeof options.token === 'string' ? options.token : '';
  // The environment of the process decides what the system layer runs; a request
  // never does. `systemConfig` reads the same variables the CLI does.
  const systemEnv = options.env ?? process.env;
  const system = systemConfig(systemEnv);
  const sandbox = isDevSandbox(systemEnv);

  // Runtime state of the host layer. It lives on the app, not in a module global,
  // so two editors in one process (the tests start many) cannot see each other's
  // "last check" and restart permissions.
  const state = {
    lastCheck: null,
    lastRestart: null,
    testsRunning: false,
    // A document migrated by `model.open` is announced once, on the first render.
    migrationNoticeShown: false,
  };

  // The API secret is read from the environment of the process and never from a
  // request; the panel is only told whether it is present. Both the generator and
  // the watchdog use the same value.
  const apiSecret =
    typeof systemEnv[API_SECRET_VAR] === 'string' ? systemEnv[API_SECRET_VAR] : '';

  /**
   * Builds the read-only descriptor the watchdog works from. It reads the model,
   * never writes it: the watchdog has no way to reach `webui.json` at all.
   *
   * @returns {Record<string, unknown>}
   */
  const watchdogContext = () => {
    const body = model.body();
    return {
      watchdog: body.watchdog,
      api: {
        enabled: body.clash_api?.enabled === true,
        controller: body.clash_api?.controller,
        secret: apiSecret,
      },
      listenIp: model.listenIp,
      proxies: model.watchedProxies(),
    };
  };

  // `options.watchdog` lets a test inject its own object; `null` disables the
  // background loop entirely. The loop is unref'ed, so it never keeps a process
  // alive and a short test run never waits for it.
  const watchdog =
    options.watchdog !== undefined
      ? options.watchdog
      : new Watchdog({env: systemEnv, context: watchdogContext});
  if (watchdog !== null && options.watchdog === undefined) {
    try {
      watchdog.start();
    } catch {
      // A broken document must not stop the editor from opening.
    }
  }
  state.watchdog = watchdog;

  const app = express();
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', VIEWS);
  app.use(express.urlencoded({extended: false, limit: '4mb'}));
  app.use('/static', express.static(PUBLIC));

  // Browsers request `/favicon.ico` by default, and the file itself lives under
  // `/static`. This one route answers that request without widening the static
  // mount to the repository root. It stands next to `/static`, BEFORE the token
  // middleware: a browser that has not stored the token yet must still get its
  // icon, exactly as it gets the stylesheet and htmx.
  app.get('/favicon.ico', (req, res) => {
    res.sendFile(path.join(PUBLIC, 'favicon.ico'));
  });

  // ------------------------------------------------------------------
  // Access control
  // ------------------------------------------------------------------
  //
  // With a token configured every route is behind it, the SSE endpoints
  // included: they are the ones that spawn `journalctl -f`, so leaving them open
  // would hand a stranger a process on the host. Without a token the server only
  // ever listens on the loopback address — `assertAuthentication` of
  // `server.mjs` refuses to start otherwise.
  if (token.length > 0) {
    app.use((req, res, next) => {
      if (tokenMatches(extractToken(req), token)) {
        // Remember a token that arrived in the query string: the `EventSource`
        // of the SSE panels cannot set a header, so it needs the cookie to
        // authenticate. HttpOnly keeps it away from any script on the page.
        res.cookie(TOKEN_COOKIE, token, {httpOnly: true, sameSite: 'strict', path: '/'});
        next();
        return;
      }
      res
        .status(401)
        .type('text/plain')
        .send(
          'Требуется токен доступа: заголовок Authorization: Bearer … или параметр ?token=…\n',
        );
    });
  }

  /**
   * Builds a panel, falling back to a neighbouring one when the requested panel
   * cannot be built: an entity deleted in another tab, or a key that makes no
   * sense. The reason travels in `extra.error`, which is what the notices block
   * of the templates renders — never a stack trace in front of the owner.
   *
   * @param {string} key
   * @param {Record<string, unknown>} extra
   * @returns {{key: string, panel: Record<string, unknown>, extra: Record<string, unknown>}}
   */
  function resolvePanel(key, extra) {
    const requested = typeof key === 'string' && key.length > 0 ? key : DEFAULT_PANEL;
    const kind = requested.includes(':') ? requested.slice(0, requested.indexOf(':')) : requested;

    try {
      return {key: requested, panel: buildPanel(model, requested, extra), extra};
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;

      let fallback = DEFAULT_PANEL;
      if (PANEL_KINDS.includes(kind)) {
        if (kind === 'route') fallback = 'routes';
        if (kind === 'proxy') fallback = 'proxies';
      }
      return {
        key: fallback,
        panel: buildPanel(model, fallback, {...extra, error: null}),
        extra: {...extra, error: error.message},
      };
    }
  }

  /**
   * Locals shared by the full page and the htmx fragment.
   *
   * @param {string} key
   * @param {Record<string, unknown>} extra
   * @returns {Record<string, unknown>}
   */
  function buildView(key, extra) {
    // A version-1 file is rewritten on disk by `model.open` before the first
    // render. The owner must be told once, and told what moved: a silent rewrite
    // of their own file is exactly the kind of surprise the migration warnings
    // exist to prevent.
    let withNotices = extra;
    if (model.lastMigration !== null && !state.migrationNoticeShown) {
      state.migrationNoticeShown = true;
      const lines = ['webui.json переведён на версию 2: профили упразднены.'];
      if (model.lastMigration.snapshot !== null) {
        lines.push(`Снимок прежней версии: ${path.basename(model.lastMigration.snapshot)}.`);
      }
      lines.push(...model.lastMigration.warnings);
      withNotices = {...extra, notice: lines.join(' ')};
    }

    // The panel builders get the runtime state of the host layer, not a way to
    // run anything: `buildPanel` only arranges what the routes already did.
    const enriched = {
      ...withNotices,
      system: {
        lastCheck: state.lastCheck,
        lastRestart: state.lastRestart,
        unit: system.unit,
        testConcurrency: system.testConcurrency,
        journalLines: JOURNAL_SNAPSHOT_LINES,
        journalLevel: DEFAULT_JOURNAL_LEVEL,
        journalLevels: PRIORITY_LEVELS,
      },
      watchdog: state.watchdog === null ? undefined : state.watchdog.snapshot(),
      auth: {tokenRequired: token.length > 0, apiSecretPresent: apiSecret.length > 0},
    };
    const resolved = resolvePanel(key, enriched);
    return {
      model,
      key: resolved.key,
      panel: resolved.panel,
      tree: model.treeSpec(),
      status: buildStatus(model),
      extra: resolved.extra,
      sandbox,
    };
  }

  /**
   * Renders the whole page.
   *
   * @param {import('express').Response} res
   * @param {string} key
   * @param {Record<string, unknown>} [extra]
   */
  function renderPage(res, key, extra = {}) {
    res.render('layout', buildView(key, extra));
  }

  /**
   * Renders the fragment htmx swaps in: the panel plus the out-of-band tree and
   * header.
   *
   * @param {import('express').Response} res
   * @param {string} key
   * @param {Record<string, unknown>} [extra]
   */
  function renderFragment(res, key, extra = {}) {
    const view = buildView(key, extra);
    res.set('HX-Push-Url', panelUrl(view.key));
    res.render('partials/response', view);
  }

  /**
   * Reads one journal snapshot for the panel.
   *
   * Every value comes from the query string with a bounded fallback: the unit is
   * an argument to `journalctl -u` (never a shell word), the line count is
   * clamped, and an unknown level falls back to the default. The request leaves
   * no state — the panel renders what `journalctl` printed once.
   *
   * @param {import('express').Request} req
   * @returns {Promise<Record<string, unknown>>}
   */
  async function journalSnapshot(req) {
    const requested = Number(req.query?.lines);
    const lines = Number.isFinite(requested)
      ? Math.min(Math.max(Math.trunc(requested), 1), JOURNAL_MAX_LINES)
      : JOURNAL_SNAPSHOT_LINES;
    const requestedLevel =
      typeof req.query?.level === 'string' ? req.query.level.trim().toLowerCase() : '';
    const level = PRIORITY_LEVELS.includes(requestedLevel) ? requestedLevel : DEFAULT_JOURNAL_LEVEL;
    const unit = typeof req.query?.unit === 'string' ? req.query.unit.trim() : '';

    const result = await tailJournal(lines, {
      env: systemEnv,
      level,
      unit: unit.length > 0 ? unit : undefined,
    });

    return {
      ok: result.ok,
      error: result.error,
      entries: result.entries,
      lines: result.lines,
      unit: result.unit,
      level: result.level,
    };
  }

  /**
   * Extra data a panel needs before it can be built. Only the journal has any:
   * its snapshot comes from the host, so it is fetched by a ROUTE and handed to
   * the panel, whose builders stay pure.
   *
   * @param {string} key
   * @param {import('express').Request} req
   * @returns {Promise<Record<string, unknown>>}
   */
  async function panelExtra(key, req) {
    const kind = typeof key === 'string' && key.includes(':') ? key.slice(0, key.indexOf(':')) : key;
    if (kind !== 'journal') return {};
    return {journal: await journalSnapshot(req)};
  }

  /**
   * Answers a mutation. `action` returns the panel to show and the notices. It may
   * be async: the system calls (check, restart) are promises, and the SSE routes
   * are the only ones that answer without going through here.
   *
   * @param {string|((req: import('express').Request) => string)} defaultKey A
   *   string, or a function so a route that learns its panel from the request
   *   (the `/save` button) still renders the right panel after a rejection.
   * @param {(req: import('express').Request) => Record<string, unknown>|Promise<Record<string, unknown>>} action
   * @returns {import('express').RequestHandler}
   */
  function mutation(defaultKey, action) {
    return async (req, res) => {
      const fallbackKey = typeof defaultKey === 'function' ? defaultKey(req) : defaultKey;
      let extra;
      try {
        extra = (await action(req)) ?? {};
      } catch (error) {
        if (!(error instanceof ConfigError) && !(error instanceof SystemError)) throw error;
        // A rejection keeps the entered values, so the owner does not retype a
        // form because of one bad port number. A failed system call is reported
        // the same way: a plain sentence, never a stack trace.
        extra = {error: error.message, form: req.body, key: fallbackKey};
      }
      const key = typeof extra.key === 'string' && extra.key.length > 0 ? extra.key : fallbackKey;
      if (!req.get('HX-Request')) {
        // No htmx (JavaScript off, bundle missing): answer with a plain redirect
        // so the tool works anyway.
        res.redirect(303, panelUrl(resolvePanel(key, extra).key));
        return;
      }
      renderFragment(res, key, extra);
    };
  }

  /**
   * Reads the panel a form belongs to, so saving from the header returns the
   * owner to the panel they were looking at. The bound «Сохранить» button carries
   * the panel in the query string (its `form="panel-form"` association would drop
   * any hidden field of the header form), so the query is checked first.
   *
   * @param {import('express').Request} req
   * @param {string} fallback
   * @returns {string}
   */
  function panelFromBody(req, fallback) {
    const value = req.query?.panel ?? req.body?.panel;
    return typeof value === 'string' && value.length > 0 ? value : fallback;
  }

  /**
   * Applies exactly one edit-form route to the live model and reports the panel
   * key the result belongs to.
   *
   * `applied` is false when the body carries none of the fields of the route.
   * That is how a direct POST of a single route stays a partial edit of a panel
   * whose edit form has more than one route, instead of being refused because a
   * field of a sibling route is missing.
   *
   * @param {string} route One of the routes a form posts to (`/proxy`, `/dns`, …).
   * @param {import('express').Request} req
   * @returns {{applied: boolean, key: string|null}}
   */
  function applyRoute(route, req) {
    const body = req.body ?? {};
    const fields = ROUTE_FIELDS[route] ?? [];
    if (!fields.some((field) => Object.hasOwn(body, field))) {
      return {applied: false, key: null};
    }

    switch (route) {
      case '/proxy': {
        const current = String(body.current ?? '').trim();
        const candidate = forms.parseProxyForm(body);
        model.upsertProxy(candidate, current.length > 0 ? current : null);
        return {applied: true, key: panelKey('proxy', candidate.tag)};
      }
      case '/route': {
        const current = String(body.current ?? '').trim();
        const candidate = forms.parseRouteForm(body);
        model.upsertRoute(candidate.name, candidate, current.length > 0 ? current : null);
        return {applied: true, key: panelKey('route', candidate.name)};
      }
      case '/dns':
        model.applyDns(String(body.dns ?? ''));
        return {applied: true, key: 'dns'};
      case '/links':
        model.setLinksFile(String(body.links_file ?? '').trim());
        return {applied: true, key: 'links'};
      case '/output':
        model.setOutputFile(String(body.output_file ?? '').trim());
        return {applied: true, key: 'output'};
      case '/watchdog':
        model.applyWatchdog(forms.parseWatchdogForm(body));
        model.applyClashApi(forms.parseClashApiForm(body));
        return {applied: true, key: 'watchdog'};
      case '/general': {
        model.applyGeneral(forms.parseGeneralForm(body));
        return {applied: true, key: 'general'};
      }
      default:
        throw new ConfigError(`маршрут '${route}' не является формой правки`);
    }
  }

  /**
   * Applies the edit form of one panel to the model, atomically.
   *
   * Shared by the panel's own route and by `/save`: that is the whole point of the
   * fix, because if the two ever drifted the save button would silently behave
   * differently from «Применить» again. `editFormRoutes` decides which panels have
   * such a form at all — the action buttons (`/proxy/remove`, `/generate`, …) are
   * never routed through here.
   *
   * A panel may have more than one route, and a button applies the WHOLE panel,
   * so every route of the panel is applied in order. A
   * canonical snapshot is taken before the first route: if any route refuses, the
   * model is put back exactly as it was, so the owner never gets a panel that is
   * applied halfway while the notice only reports the refusal. The file is not
   * touched here at all — `/save` writes it, and only after a successful apply.
   *
   * Returns `changed`, computed from the canonical text of the document, so
   * `/save` can tell "the form really did something" from "the values were already
   * like that" and skip a pointless write and snapshot.
   *
   * @param {string} kind Panel kind (`proxy`, `route`, `dns`, `general`, …).
   * @param {import('express').Request} req
   * @returns {{key: string, changed: boolean}}
   */
  function applyEditForm(kind, req) {
    const routes = editFormRoutes(kind);
    if (routes.length === 0) throw new ConfigError(`у панели '${kind}' нет формы правки`);

    const before = model.toText();
    const wasDirty = model.dirty;
    let key = kind;

    try {
      for (const route of routes) {
        const outcome = applyRoute(route, req);
        if (outcome.applied && outcome.key !== null) key = outcome.key;
      }
    } catch (error) {
      model.restoreText(before);
      if (wasDirty) model.markDirty();
      else model.markClean();
      throw error;
    }

    return {key, changed: model.toText() !== before};
  }

  // ------------------------------------------------------------------
  // Pages
  // ------------------------------------------------------------------

  app.get('/', async (req, res) => {
    const requested = typeof req.query.panel === 'string' ? req.query.panel : DEFAULT_PANEL;
    const key = requested.length > 0 ? requested : DEFAULT_PANEL;
    renderPage(res, key, await panelExtra(key, req));
  });

  app.get('/panel/:key', async (req, res) => {
    const extra = await panelExtra(req.params.key, req);
    if (req.get('HX-Request')) renderFragment(res, req.params.key, extra);
    else renderPage(res, req.params.key, extra);
  });

  // ------------------------------------------------------------------
  // General settings
  // ------------------------------------------------------------------

  app.post(
    '/general',
    mutation('general', (req) => {
      applyEditForm('general', req);
      return {key: 'general', notice: 'Применено — не забудьте сохранить'};
    }),
  );

  app.post(
    '/dns',
    mutation('dns', (req) => {
      const {key} = applyEditForm('dns', req);
      return {key, notice: 'DNS применён — не забудьте сохранить'};
    }),
  );

  // ------------------------------------------------------------------
  // Links file and output
  // ------------------------------------------------------------------

  app.post(
    '/links',
    mutation('links', (req) => {
      applyEditForm('links', req);
      return {key: 'links', notice: 'Путь к файлу ссылок применён — не забудьте сохранить'};
    }),
  );

  app.post(
    '/output',
    mutation('output', (req) => {
      applyEditForm('output', req);
      return {key: 'output', notice: 'Путь вывода применён — не забудьте сохранить'};
    }),
  );

  app.post(
    '/generate',
    mutation('output', () => {
      // Snapshot BEFORE the generator overwrites the file: the whole point of the
      // rollback is to bring back byte-for-byte what the daemon was running, and
      // that copy has to be taken while it still exists.
      const configPath = model.resolvedOutputPath();
      const snapshot = model.configExists()
        ? snapshotConfig(configPath, model.stateDir, {keep: CONFIG_SNAPSHOT_KEEP})
        : null;
      const generation = model.generate();

      // New bytes invalidate the old check: the previous check judged a different
      // file, so it must not authorise a restart of what is on disk now.
      state.lastCheck = null;

      return {
        key: 'output',
        generation,
        snapshot: snapshot === null ? null : path.basename(snapshot.path),
        notice: generation.summary,
      };
    }),
  );

  // ------------------------------------------------------------------
  // Proxies
  // ------------------------------------------------------------------

  app.post(
    '/proxy',
    mutation('proxies', (req) => {
      const {key} = applyEditForm('proxy', req);
      return {key, notice: `Прокси '${parsePanelKey(key).name}' применён — не забудьте сохранить`};
    }),
  );

  app.post(
    '/proxy/new',
    mutation('proxies', () => {
      const entry = model.addProxy();
      return {
        key: panelKey('proxy', entry.tag),
        notice: `Создан прокси '${entry.tag}' (порт ${entry.port}) — не забудьте сохранить`,
      };
    }),
  );

  app.post(
    '/proxy/remove',
    mutation('proxies', (req) => {
      const tag = String(req.body.current ?? '').trim();
      if (!model.removeProxy(tag)) throw new ConfigError(`прокси '${tag}' не найден`);
      return {key: 'proxies', notice: `Прокси '${tag}' удалён — не забудьте сохранить`};
    }),
  );

  // ------------------------------------------------------------------
  // Routes
  // ------------------------------------------------------------------

  app.post(
    '/route',
    mutation('routes', (req) => {
      const {key} = applyEditForm('route', req);
      return {key, notice: `Маршрут '${parsePanelKey(key).name}' применён — не забудьте сохранить`};
    }),
  );

  app.post(
    '/route/new',
    mutation('routes', () => {
      const {name} = model.addRoute();
      return {
        key: panelKey('route', name),
        notice: `Создан маршрут '${name}' — не забудьте сохранить`,
      };
    }),
  );

  app.post(
    '/route/remove',
    mutation('routes', (req) => {
      const name = String(req.body.current ?? '').trim();
      if (!model.removeRoute(name)) throw new ConfigError(`маршрут '${name}' не найден`);
      return {key: 'routes', notice: `Маршрут '${name}' удалён — не забудьте сохранить`};
    }),
  );

  // ------------------------------------------------------------------
  // File operations
  // ------------------------------------------------------------------

  app.post(
    '/save',
    mutation(
      (req) => panelFromBody(req, DEFAULT_PANEL),
      (req) => {
        const key = panelFromBody(req, DEFAULT_PANEL);
        const {kind} = parsePanelKey(key);
        const hadEdits = model.dirty;

        // The header button carries the fields of the open edit form (htmx
        // hx-include / the form="" attribute with JavaScript off). Apply them with
        // the very same function the panel's own route uses, so "edit → Сохранить"
        // can never behave differently from "edit → Применить → Сохранить".
        //
        // A body that carries nothing but the panel key is a plain "save what the
        // model holds" — there is no form to apply, and parsing an empty one would
        // fail for no reason.
        const hasFormFields = Object.keys(req.body ?? {}).some((field) => field !== 'panel');
        let changed = false;
        if (editFormRoutes(kind).length > 0 && hasFormFields) {
          changed = applyEditForm(kind, req).changed;
        }

        // Applying identical values is not an error, but it must not look like a
        // save either: no write and, above all, no snapshot for an edit that
        // changed nothing. `applyEditForm` always marks the model dirty, so the
        // "nothing happened" case is undone here.
        if (!changed && !hadEdits) model.markClean();
        if (!model.dirty) {
          return {key, notice: 'Нечего сохранять: неприменённых правок нет'};
        }

        const {snapshot} = model.save();
        const base = changed ? 'Правка формы применена и сохранена' : 'Сохранено';
        return {
          key,
          notice: snapshot === null ? base : `${base}, предыдущая версия: ${path.basename(snapshot)}`,
        };
      },
    ),
  );

  app.post(
    '/reload',
    mutation(DEFAULT_PANEL, (req) => {
      model.reload();
      return {key: panelFromBody(req, DEFAULT_PANEL), notice: 'Файл перечитан, правки отброшены'};
    }),
  );

  // ------------------------------------------------------------------
  // System layer: check, restart, rollback
  // ------------------------------------------------------------------
  //
  // The order is deliberate and visible in the panel: generate → check → and
  // only then the restart is even drawn. `Restart=always` is set on the unit, so
  // restarting with a config the daemon rejects means an endless restart loop and
  // every connection in the house down. The rollback is one click for the same
  // reason.

  app.post(
    '/check',
    mutation('system', async () => {
      const configPath = model.resolvedOutputPath();
      if (!model.configExists()) {
        throw new ConfigError(
          'config.json ещё не сгенерирован: сначала «Сгенерировать», потом проверять',
        );
      }

      const result = await checkConfig(configPath, {env: systemEnv, timeout: CHECK_TIMEOUT});
      state.lastCheck = {
        ok: result.ok,
        code: result.code,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
        error: result.error,
        timedOut: result.timedOut,
        at: new Date().toISOString(),
        configPath,
      };
      // The permission to restart is tied to the bytes that were just checked.
      state.lastRestart = null;

      return {
        key: 'system',
        notice: result.ok
          ? 'Схема принята: sing-box check прошёл (exit=0). Это проверка декодирования, ' +
            'а не доказательство корректности — дубль порта, чужой тег и опечатку в dns.final ' +
            'она пропускает.'
          : 'Проверка не прошла: перезапуск не предлагается',
      };
    }),
  );

  app.post(
    '/restart',
    mutation('system', async () => {
      if (state.lastCheck === null || !state.lastCheck.ok) {
        throw new ConfigError(
          'перезапуск не предлагается: сначала успешная проверка config.json',
        );
      }

      const result = await restartSingBox({env: systemEnv});
      state.lastRestart = {
        ok: result.ok,
        code: result.code,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
        error: result.error,
        timedOut: result.timedOut,
        at: new Date().toISOString(),
      };

      return {
        key: 'system',
        notice: result.ok
          ? 'sing-box перезапущен. Все текущие соединения оборвались — как и предупреждали.'
          : `Перезапуск не удался: ${result.stderr.trim() || result.error || 'без вывода'}`,
      };
    }),
  );

  app.post(
    '/rollback',
    mutation('system', async () => {
      const configPath = model.resolvedOutputPath();
      const restored = restoreLatestConfig(model.stateDir, configPath);
      if (restored === null) {
        throw new ConfigError('снапшотов config.json ещё нет: откатывать нечего');
      }

      // The restored bytes were never checked in this session, so the permission
      // to restart does not transfer to them from the previous check.
      state.lastCheck = null;

      const result = await restartSingBox({env: systemEnv});
      state.lastRestart = {
        ok: result.ok,
        code: result.code,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
        error: result.error,
        timedOut: result.timedOut,
        at: new Date().toISOString(),
      };

      const from = path.basename(restored.from);
      return {
        key: 'system',
        notice: result.ok
          ? `Восстановлен ${from} и sing-box перезапущен.`
          : `Конфиг восстановлен из ${from}, но перезапуск не удался: ` +
            `${result.stderr.trim() || result.error || 'без вывода'}`,
      };
    }),
  );

  // ------------------------------------------------------------------
  // Journal
  // ------------------------------------------------------------------
  //
  // The journal is a snapshot, served by `/panel/journal`: the panel route reads
  // `journalctl` once and renders the last lines. There is deliberately no live
  // SSE stream — it needed a counter, a cap and a child killed on
  // `req.on('close')`, and the real scenario is "show me why", not "watch the
  // lines".

  // ------------------------------------------------------------------
  // Mass outbound test (SSE)
  // ------------------------------------------------------------------
  //
  // Replaces the reference `live_test`, which restarted the daemon once per
  // server. Nothing here touches the running daemon: `tools fetch` starts its own
  // instance. Progress is streamed so a 148-server run cannot block a request for
  // minutes, and the concurrency cap keeps the router from opening 148 sockets.

  app.get('/tests/stream', async (req, res) => {
    // An SSE route answers `200` ALWAYS, refusals included: `EventSource` does
    // not reconnect after a non-200 response, so a 409 here would kill the panel
    // until the page was reloaded. A refusal is an event inside the stream.
    res.status(200).set(SSE_HEADERS);
    res.flushHeaders();

    if (state.testsRunning) {
      writeEvent(res, 'refused', {message: 'тест серверов уже идёт: дождитесь конца'});
      res.end();
      return;
    }

    const info = model.linksInfo();
    if (info.error !== null) {
      writeEvent(res, 'refused', {message: info.error});
      res.end();
      return;
    }

    const tags = info.tags;
    const controller = new AbortController();
    state.testsRunning = true;

    writeEvent(res, 'start', {total: tags.length, concurrency: system.testConcurrency});

    const abort = () => controller.abort();
    req.on('close', abort);
    res.on('close', abort);

    try {
      const outcome = await testOutbounds(tags, {
        env: systemEnv,
        configPath: model.resolvedOutputPath(),
        concurrency: system.testConcurrency,
        signal: controller.signal,
        onResult: (result) => writeEvent(res, 'result', testResultView(result)),
      });
      writeEvent(res, 'done', {
        total: tags.length,
        done: outcome.results.length,
        aborted: outcome.aborted,
      });
    } catch (error) {
      writeEvent(res, 'failed', {message: error.message});
    } finally {
      state.testsRunning = false;
      if (!res.writableEnded) res.end();
    }
  });

  // ------------------------------------------------------------------
  // Watchdog and the external API
  // ------------------------------------------------------------------
  //
  // The watchdog itself lives in the process and runs on its own clock; these
  // routes only edit its settings (through the model, like any other form), ask
  // for one pass right now, or forget the accumulated state. Not one of them lets
  // the watchdog write the config: they write `webui.json` on the owner's command,
  // which is a different thing entirely.

  app.post(
    '/watchdog',
    mutation('watchdog', (req) => {
      applyEditForm('watchdog', req);
      return {
        key: 'watchdog',
        notice: 'Настройки сторожа применены — не забудьте сохранить',
      };
    }),
  );

  app.post(
    '/watchdog/check',
    mutation('watchdog', async () => {
      const run = await watchdog.checkAll();
      return {
        key: 'watchdog',
        notice:
          run.skipped === 'disabled'
            ? 'Сторож выключен общим рубильником: проверок не было'
            : `Проверено прокси: ${run.checked}`,
      };
    }),
  );

  app.post(
    '/watchdog/reset',
    mutation('watchdog', () => {
      watchdog.reset();
      return {key: 'watchdog', notice: 'Состояние сторожа сброшено'};
    }),
  );

  // ------------------------------------------------------------------
  // Fallbacks
  // ------------------------------------------------------------------

  app.use((req, res) => {
    res.status(404).type('text/plain').send(`Раздел не найден: ${req.method} ${req.path}`);
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    // Anything that is not a ConfigError is a bug in the tool, and the owner
    // should see what happened rather than a blank page.
    res.status(500).type('text/plain').send(`Внутренняя ошибка: ${error.message}`);
  });

  app.locals.model = model;
  return app;
}

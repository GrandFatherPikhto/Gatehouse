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
import {
  PRIORITY_LEVELS,
  SystemError,
  checkConfig,
  disableTunnel,
  enableTunnel,
  restartSingBox,
  restartTunnel,
  systemConfig,
  tailJournal,
  testOutbounds,
  tunnelInterfaceCollision,
  tunnelPermissions,
  tunnelState,
  tunnelUnitName,
} from '../system/index.mjs';
import {removeTunnelConfig} from '../system/tunnel-file.mjs';
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
export const DEFAULT_PANEL = 'singbox';

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
  '/provider': ['id'],
  '/dns': ['dns'],
  '/output': ['output_file'],
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
  const token = typeof options.token === 'string' ? options.token : '';
  // The environment of the process decides what the system layer runs; a request
  // never does. `systemConfig` reads the same variables the CLI does.
  const systemEnv = options.env ?? process.env;
  const system = systemConfig(systemEnv);
  const sandbox = isDevSandbox(systemEnv);

  const model =
    options.model ??
    new ProjectModel({
      path: options.settingsPath ?? null,
      stateDir: options.stateDir,
      snapshotKeep: options.snapshotKeep,
      // Directory of the tunnel configs: `GATEHOUSE_AMNEZIA_DIR`, else the build
      // constant. There is no document value to override it any more.
      amneziaDir: system.amneziaDir,
      // Root the provider folders are discovered under. Only an EXPLICIT
      // `GATEHOUSE_PROVIDERS` is handed in; without it the model keeps its own
      // resolution (a `providers/` folder next to webui.json, else the default),
      // so the sandbox and the tests can keep their data beside the settings.
      providersDir:
        typeof systemEnv.GATEHOUSE_PROVIDERS === 'string' &&
        systemEnv.GATEHOUSE_PROVIDERS.length > 0
          ? systemEnv.GATEHOUSE_PROVIDERS
          : undefined,
    });
  // `startServer` injects a model built before the environment was read; give it
  // the tunnel directory and, when named, the providers root as well.
  model.setDefaultAmneziaDir(system.amneziaDir);
  if (
    typeof systemEnv.GATEHOUSE_PROVIDERS === 'string' &&
    systemEnv.GATEHOUSE_PROVIDERS.length > 0
  ) {
    model.setProvidersDir(systemEnv.GATEHOUSE_PROVIDERS);
  }

  // Runtime state of the host layer. It lives on the app, not in a module global,
  // so two editors in one process (the tests start many) cannot see each other's
  // "last check" and restart permissions.
  const state = {
    lastCheck: null,
    lastRestart: null,
    testsRunning: false,
    // Runtime state of the tunnels, keyed by interface: `{applied, active,
    // enabled, unit}`. Refreshed from the host before a request is rendered.
    tunnels: {},
    // A document migrated by `model.open` is announced once, on the first render.
    migrationNoticeShown: false,
  };

  // ------------------------------------------------------------------
  // Tunnels: runtime state and rights (parts 1 and 2 of the task)
  // ------------------------------------------------------------------

  /**
   * Reads the runtime state of every tunnel of the inventory and caches it on
   * `state.tunnels`, keyed by interface.
   *
   * The inventory comes from the document's `tunnels` list plus the `.conf` files
   * of the amnezia directory (§3.2), so a tunnel is manageable before any proxy
   * exists. Three questions are answered, and they are not the same question: is
   * the `.conf` applied at all, is the unit active now, is it enabled at boot.
   * Both systemd axes are read without `sudo`.
   *
   * @returns {Promise<Record<string, Record<string, unknown>>>}
   */
  async function refreshTunnelStates() {
    const next = {};
    for (const tunnel of model.tunnelInventory()) {
      const iface = String(tunnel.interface);
      const unit = tunnelUnitName(iface);
      if (tunnel.applied !== true) {
        next[iface] = {applied: false, active: false, enabled: false, unit};
        continue;
      }
      const runtime = await tunnelState(iface, {env: systemEnv});
      next[iface] = {
        applied: true,
        active: runtime.active,
        enabled: runtime.enabled,
        unit: runtime.unit,
        activeRaw: runtime.activeRaw,
        enabledRaw: runtime.enabledRaw,
      };
    }
    state.tunnels = next;
    return next;
  }

  /**
   * Per interface, which tunnel controls the editor may offer. The answer comes
   * from the sudoers file the process may READ; the editor never writes it.
   *
   * @returns {Record<string, Record<string, unknown>>}
   */
  function tunnelRights() {
    const names = model.tunnelInventory().map((tunnel) => String(tunnel.interface));
    return tunnelPermissions(system.sudoers, names, {systemctl: system.systemctl});
  }

  /**
   * Names the divergence between the two systemd axes in words, or returns an
   * empty string. Hiding it would leave "everything vanished after a reboot"
   * unexplained, so it is always shown.
   *
   * @param {Record<string, unknown>} runtime
   * @returns {string}
   */
  function tunnelDivergence(runtime) {
    if (runtime.applied !== true) return 'конфиг не применён';
    if (runtime.active === true && runtime.enabled !== true) {
      return 'поднят, но не в автозагрузке: после перезагрузки пропадёт';
    }
    if (runtime.active !== true && runtime.enabled === true) {
      return 'в автозагрузке, но сейчас не поднят';
    }
    return '';
  }

  /**
   * The tunnel rows of the System panel, grouped by provider. The app assembles
   * them because only it may talk to the host; the panel builder just arranges
   * what it is handed.
   *
   * @returns {Array<Record<string, unknown>>}
   */
  function tunnelPanelRows() {
    const rights = tunnelRights();
    const usage = model.tunnelUsage();
    return model.tunnelGroups().map((group) => ({
      provider: group.provider,
      tunnels: group.tunnels.map((tunnel) => {
        const runtime = state.tunnels[tunnel.interface] ?? {
          applied: false,
          active: false,
          enabled: false,
        };
        const permission = rights[tunnel.interface] ?? {
          canRestart: false,
          canToggle: false,
          missingLines: [],
          sudoersReadable: true,
          sudoersNotice: null,
        };
        const unit = tunnelUnitName(tunnel.interface);
        return {
          ...tunnel,
          unit,
          label: typeof tunnel.name === 'string' ? tunnel.name : '',
          applied: runtime.applied === true,
          active: runtime.active === true,
          enabled: runtime.enabled === true,
          divergence: tunnelDivergence(runtime),
          usedBy: usage.get(tunnel.interface) ?? [],
          canRestart: permission.canRestart === true,
          canToggle: permission.canToggle === true,
          missingLines: permission.missingLines ?? [],
          sudoersReadable: permission.sudoersReadable !== false,
          sudoersNotice: permission.sudoersNotice ?? null,
          journalUrl: `/panel/${encodeURIComponent('system:singbox')}?unit=${encodeURIComponent(unit)}&level=warning`,
        };
      }),
    }));
  }

  /**
   * Refuses a tunnel name the document does not describe, so a crafted body
   * cannot aim the unit actions at an arbitrary unit.
   *
   * @param {unknown} name
   * @returns {string}
   */
  function assertKnownTunnel(name) {
    const clean = String(name ?? '').trim();
    if (clean.length === 0) throw new ConfigError('не указано имя туннеля');
    if (!model.tunnelInventory().some((tunnel) => String(tunnel.interface) === clean)) {
      throw new ConfigError(
        `туннель '${clean}' не подготовлен: его нет ни в списке tunnels, ни в каталоге amnezia`,
      );
    }
    return clean;
  }

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

  // The tunnel rows of the System panel and the tree marks need runtime state,
  // and Express handlers are synchronous once they render. Refresh the cache
  // before every request; with no tunnel proxies this is a no-op. A failure is
  // swallowed on purpose: a broken `systemctl` must not take the editor down —
  // the panel then shows what it last knew.
  app.use(async (req, res, next) => {
    try {
      await refreshTunnelStates();
    } catch {
      // keep the previous snapshot
    }
    next();
  });

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
      const panel = buildPanel(model, requested, extra);
      // «Система» is a GROUP with two child nodes now: a bare or unknown key must
      // point at a REAL node, so the tree highlight and `HX-Push-Url` name the
      // child, never the page-less group.
      const key = panel.kind === 'system' ? panelKey('system', String(panel.tab)) : requested;
      return {key, panel, extra};
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;

      let fallback = DEFAULT_PANEL;
      if (PANEL_KINDS.includes(kind)) {
        if (kind === 'route') fallback = 'routes';
        if (kind === 'proxy') fallback = 'proxies';
        if (kind === 'provider') fallback = 'providers';
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

    // The fields of the removed Watchdog are still in the FILE until the owner
    // saves, so the line about them stays on every panel until then. It goes into
    // the notice channel that already exists — one line, no new UI, and nothing is
    // rewritten behind the owner's back. The sources-migration line lives by the
    // same rule: the file still carries the bare folder names until a save.
    for (const line of [model.removedNotice, model.providersMigrationNotice]) {
      if (line === null) continue;
      const previous = withNotices.notice;
      withNotices = {
        ...withNotices,
        notice:
          typeof previous === 'string' && previous.length > 0 ? `${previous} ${line}` : line,
      };
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
      // Tunnel rows of the System panel. Assembled here, from the cached runtime
      // state and the sudoers rights, so the panel builders stay pure.
      tunnels: tunnelPanelRows(),
      auth: {tokenRequired: token.length > 0},
    };
    const resolved = resolvePanel(key, enriched);
    return {
      model,
      key: resolved.key,
      panel: resolved.panel,
      // The tree marks a proxy on a stopped tunnel; the states come from the
      // cache refreshed by the middleware above.
      tree: model.treeSpec({tunnelStates: state.tunnels}),
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
    if (kind === 'system') {
      // The journal is a section of the SING-BOX tab, so only that tab pays for a
      // `journalctl` call; the other tabs render without touching the host.
      const tab =
        typeof key === 'string' && key.includes(':') ? key.slice(key.indexOf(':') + 1) : 'singbox';
      return tab === 'singbox' ? {journal: await journalSnapshot(req)} : {};
    }
    if (kind === 'tunnel') {
      // The preview reads a file, so it is built here, in the route, and handed
      // to the panel builder, which stays pure. A key without `provider/file`
      // (or an unreadable file) leaves the panel with no preview at all.
      const reference = key.slice(key.indexOf(':') + 1);
      const slash = reference.indexOf('/');
      if (slash <= 0) return {};
      try {
        return {tunnel: model.tunnelPreview(reference.slice(0, slash), reference.slice(slash + 1))};
      } catch {
        return {};
      }
    }
    return {};
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
      case '/provider': {
        const id = String(body.id ?? '').trim();
        model.setProviderLabel(id, String(body.label ?? ''));
        model.setProviderEnabled(id, forms.checkbox(body.enabled));
        return {applied: true, key: panelKey('provider', id)};
      }
      case '/dns':
        model.applyDns(String(body.dns ?? ''));
        return {applied: true, key: 'dns'};
      case '/output':
        model.setOutputFile(String(body.output_file ?? '').trim());
        return {applied: true, key: 'output'};
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
    // A merged panel (several routes, one page) keeps its own key: the routes
    // name sections, not destinations, and returning `output` would send the
    // owner to a panel that no longer exists.
    const merged = routes.length > 1;
    let key = kind;

    try {
      for (const route of routes) {
        const outcome = applyRoute(route, req);
        if (!merged && outcome.applied && outcome.key !== null) key = outcome.key;
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

  // «Настройки Sing-Box»: one page, one form, three sections applied in order.
  app.post(
    '/singbox',
    mutation('singbox', (req) => {
      applyEditForm('singbox', req);
      return {key: 'singbox', notice: 'Настройки применены — не забудьте сохранить'};
    }),
  );

  // «Настройки Amnezia» has nothing to apply: the tunnel directory is a constant
  // of the build, shown read-only. Regeneration below has its own button.

  /**
   * Re-normalises and rewrites every marked tunnel.
   *
   * This is a rewrite, not a start: it can be repeated without touching a live
   * connection, and the report names, per tunnel, what changed. A failure of one
   * tunnel does not stop the others.
   */
  app.post(
    '/amnezia/regenerate',
    mutation('amnezia', () => {
      const regeneration = model.regenerateTunnels();
      return {
        key: 'amnezia',
        regeneration,
        notice:
          regeneration.entries.length === 0
            ? 'Включённых туннелей нет: перегенерировать нечего'
            : `Туннелей: ${regeneration.entries.length}, изменено: ${regeneration.changed}, ` +
              `ошибок: ${regeneration.failed}`,
      };
    }),
  );

  // ------------------------------------------------------------------
  // Tunnel normalisation preview (reads a file, changes nothing)
  // ------------------------------------------------------------------

  app.post(
    '/tunnel',
    mutation(
      (req) => `tunnel:${String(req.body.provider ?? '')}/${String(req.body.file ?? '')}`,
      (req) => {
        const provider = String(req.body.provider ?? '').trim();
        const file = String(req.body.file ?? '').trim();
        const preview = model.tunnelPreview(provider, file, {
          name: String(req.body.name ?? ''),
          label: String(req.body.label ?? ''),
          policyRouting: forms.checkbox(req.body.policyRouting),
        });
        return {
          key: `tunnel:${provider}/${file}`,
          tunnel: preview,
          notice: 'Предпросмотр пересчитан: файл не тронут.',
        };
      },
    ),
  );

  /**
   * The «нужен» mark of the Providers panel (§3.1).
   *
   * Ticking does two things at once: normalises the config and writes
   * `<interface>.conf` into the amnezia directory, then records the two names in
   * the document. Unticking stops the unit FIRST and only then removes the file,
   * so a running tunnel is never left without its config. Nothing is ever copied
   * as is: only the output of the normaliser reaches the amnezia directory.
   */
  app.post(
    '/tunnels',
    mutation(
      (req) => panelKey('provider', String(req.body.provider ?? '').trim()),
      async (req) => {
        const provider = String(req.body.provider ?? '').trim();
        const file = String(req.body.file ?? '').trim();
        const key = panelKey('provider', provider);

        if (!forms.checkbox(req.body.needed)) {
          const entry = model.getTunnel(provider, file);
          if (entry === null) throw new ConfigError(`туннель '${provider}/${file}' не включён`);
          const iface = String(entry.interface);
          const runtime = state.tunnels[iface] ?? {active: false};
          if (runtime.active === true) {
            const rights = tunnelRights()[iface];
            if (rights?.canToggle !== true) {
              throw new ConfigError(
                `туннель '${iface}' сейчас поднят: остановите его или добавьте правила sudoers:\n` +
                  (rights?.missingLines ?? []).join('\n'),
              );
            }
            const stopped = await disableTunnel(iface, {env: systemEnv});
            if (!stopped.ok) {
              throw new ConfigError(
                `не удалось остановить туннель '${iface}': ` +
                  `${stopped.stderr.trim() || stopped.error || 'без вывода'}`,
              );
            }
          }
          const {entry: removed} = model.unprepareTunnel(provider, file);
          await refreshTunnelStates();
          return {
            key,
            notice:
              `Туннель '${removed.name}' выключен: конфиг убран из каталога amnezia. ` +
              'Не забудьте сохранить.',
          };
        }

        // The write path refuses a name an interface outside GateHouse already
        // holds, with the same sentence a start would give: the fuse and the
        // template unit must never disagree about which file is behind a name.
        const wanted = String(req.body.interface ?? '').trim();
        if (wanted.length > 0) {
          const collision = await tunnelInterfaceCollision(wanted, {env: systemEnv});
          if (collision !== null) throw new ConfigError(collision);
        }

        const previous = model.getTunnel(provider, file);
        const {entry, applied} = model.prepareTunnel(provider, file, {
          name: req.body.interface,
          label: req.body.name,
        });

        // A renamed file name leaves the old artifact behind: its unit is stopped
        // (when the rights allow) and the file removed, so nothing orphaned stays
        // in the amnezia directory. Without the rights the old file is left in
        // place — visible as «вне источников» rather than silently deleted.
        if (previous !== null && String(previous.interface) !== String(entry.interface)) {
          const oldIface = String(previous.interface);
          const runtime = state.tunnels[oldIface] ?? {active: false};
          if (runtime.active !== true) {
            removeTunnelConfig(model.amneziaDir, oldIface);
          } else if (tunnelRights()[oldIface]?.canToggle === true) {
            await disableTunnel(oldIface, {env: systemEnv});
            removeTunnelConfig(model.amneziaDir, oldIface);
          }
        }
        await refreshTunnelStates();
        const snapshot =
          applied.changed && applied.snapshot !== null
            ? ` (снимок прежней версии: ${path.basename(applied.snapshot)})`
            : applied.changed
              ? ''
              : ' (изменений не было)';
        return {
          key,
          notice:
            `Туннель '${entry.name}' включён: ${applied.path}${snapshot}. ` +
            'Туннель не поднят — поднимите его в разделе «Система». Не забудьте сохранить.',
        };
      },
    ),
  );

  /**
   * The policy-routing switch of the preview screen.
   *
   * For a marked tunnel the flag belongs to the document and the applied file has
   * to follow it, so the file is rewritten right away; for an unmarked one the
   * preview is only recomputed, which is what that screen is for.
   */
  app.post(
    '/tunnel/policy',
    mutation(
      (req) => `tunnel:${String(req.body.provider ?? '')}/${String(req.body.file ?? '')}`,
      (req) => {
        const provider = String(req.body.provider ?? '').trim();
        const file = String(req.body.file ?? '').trim();
        const policyRouting = forms.checkbox(req.body.policyRouting);
        const entry = model.getTunnel(provider, file);

        let notice;
        if (entry === null) {
          notice = 'Туннель не отмечен: предпросмотр пересчитан, файл не тронут.';
        } else {
          model.prepareTunnel(provider, file, {
            name: entry.interface,
            label: entry.name,
            policyRouting,
          });
          notice =
            `Политика маршрутизации ${policyRouting ? 'включена' : 'выключена'}: файл перезаписан. ` +
            'Не забудьте сохранить.';
        }

        const preview = model.tunnelPreview(provider, file, {
          name: String(entry?.interface ?? ''),
          label: String(entry?.name ?? ''),
          policyRouting,
        });
        return {key: `tunnel:${provider}/${file}`, tunnel: preview, notice};
      },
    ),
  );

  // ------------------------------------------------------------------
  // Providers, discovered by folder
  // ------------------------------------------------------------------
  //
  // There is NO form that takes a path: providers are found under
  // GATEHOUSE_PROVIDERS and the browser never names a path. What the browser may
  // do is flip the «включён» flag, rename a provider on its own panel, and
  // «forget» a record whose folder is gone. The old `/providers` POST is gone, so
  // a request carrying `path` hits the 404 catch-all like any other stale route.

  app.post(
    '/provider',
    mutation(
      (req) => panelKey('provider', String(req.body.id ?? '').trim()),
      (req) => {
        applyEditForm('provider', req);
        const id = String(req.body.id ?? '').trim();
        return {
          key: panelKey('provider', id),
          notice: 'Настройки провайдера применены — не забудьте сохранить',
        };
      },
    ),
  );

  app.post(
    '/provider/enabled',
    mutation('providers', (req) => {
      const id = String(req.body.id ?? '').trim();
      const enabled = forms.checkbox(req.body.enabled);
      model.setProviderEnabled(id, enabled);
      return {
        key: 'providers',
        notice: `Провайдер '${id}' ${enabled ? 'включён' : 'выключен'} — не забудьте сохранить`,
      };
    }),
  );

  app.post(
    '/provider/forget',
    mutation('providers', (req) => {
      const id = String(req.body.id ?? '').trim();
      model.forgetProvider(id);
      return {
        key: 'providers',
        notice:
          `Запись о провайдере '${id}' убрана: папки на диске это не касается. ` +
          'Не забудьте сохранить.',
      };
    }),
  );

  app.post(
    '/generate',
    mutation('singbox', async () => {
      // Snapshot BEFORE the generator overwrites the file: the whole point of the
      // rollback is to bring back byte-for-byte what the daemon was running, and
      // that copy has to be taken while it still exists.
      const configPath = model.resolvedOutputPath();
      const snapshot = model.configExists()
        ? snapshotConfig(configPath, model.stateDir, {keep: CONFIG_SNAPSHOT_KEEP})
        : null;
      // §5.4: a proxy on a stopped tunnel is a silently dead port, so the warning
      // needs to know which interfaces are really up. The state is read from the
      // host here and handed to the pure generator.
      await refreshTunnelStates();
      const runningTunnels = Object.entries(state.tunnels)
        .filter(([, runtime]) => runtime.active === true)
        .map(([name]) => name);
      const generation = model.generate({runningTunnels});

      // New bytes invalidate the old check: the previous check judged a different
      // file, so it must not authorise a restart of what is on disk now.
      state.lastCheck = null;

      return {
        key: 'singbox',
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
    mutation('system:singbox', async () => {
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
        key: 'system:singbox',
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
    mutation('system:singbox', async () => {
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
        key: 'system:singbox',
        notice: result.ok
          ? 'sing-box перезапущен. Все текущие соединения оборвались — как и предупреждали.'
          : `Перезапуск не удался: ${result.stderr.trim() || result.error || 'без вывода'}`,
      };
    }),
  );

  app.post(
    '/rollback',
    mutation('system:singbox', async () => {
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
        key: 'system:singbox',
        notice: result.ok
          ? `Восстановлен ${from} и sing-box перезапущен.`
          : `Конфиг восстановлен из ${from}, но перезапуск не удался: ` +
            `${result.stderr.trim() || result.error || 'без вывода'}`,
      };
    }),
  );

  // ------------------------------------------------------------------
  // Tunnel lifecycle: up/down and restart (part 2)
  // ------------------------------------------------------------------
  //
  // One checkbox drives both systemd axes — `enable --now` and `disable --now` —
  // so the four combinations cannot be reached by accident. Each route reads the
  // sudoers permission first: the panel does not draw a button without it, and a
  // direct POST is refused with the exact lines to install.

  app.post(
    '/tunnel/toggle',
    mutation('system:amnezia', async (req) => {
      const name = assertKnownTunnel(req.body.name);
      const runtime = state.tunnels[name] ?? {applied: false};
      if (runtime.applied !== true) {
        throw new ConfigError(
          `конфиг туннеля '${name}' не применён: включите его галочкой «включить» в «Провайдерах»`,
        );
      }
      const rights = tunnelRights()[name];
      if (rights?.canToggle !== true) {
        throw new ConfigError(
          `нет правил sudoers на управление туннелем '${name}'. Добавьте строки:\n` +
            (rights?.missingLines ?? []).join('\n'),
        );
      }

      const up = forms.checkbox(req.body.up);
      const result = up
        ? await enableTunnel(name, {env: systemEnv})
        : await disableTunnel(name, {env: systemEnv});
      await refreshTunnelStates();

      return {
        key: 'system:amnezia',
        notice: result.ok
          ? `Туннель '${name}' ${
              up ? 'поднят и включён в автозагрузку' : 'опущен и убран из автозагрузки'
            }.`
          : `Не удалось изменить состояние туннеля '${name}': ` +
            `${result.stderr.trim() || result.error || 'без вывода'}`,
      };
    }),
  );

  app.post(
    '/tunnel/restart',
    mutation('system:amnezia', async (req) => {
      const name = assertKnownTunnel(req.body.name);
      const rights = tunnelRights()[name];
      if (rights?.canRestart !== true) {
        throw new ConfigError(
          `нет правила sudoers на перезапуск туннеля '${name}'. Добавьте строки:\n` +
            (rights?.missingLines ?? []).join('\n'),
        );
      }

      const result = await restartTunnel(name, {env: systemEnv});
      await refreshTunnelStates();

      return {
        key: 'system:amnezia',
        notice: result.ok
          ? `Туннель '${name}' перезапущен. Соединения через него оборвались — как и предупреждали.`
          : `Перезапуск туннеля '${name}' не удался: ` +
            `${result.stderr.trim() || result.error || 'без вывода'}`,
      };
    }),
  );

  // ------------------------------------------------------------------
  // Journal
  // ------------------------------------------------------------------
  //
  // The journal is a snapshot, served by the «Sing-box» tab of «Система»: that
  // route reads `journalctl` once and renders the last lines. There is no live
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

    const info = model.providersInfo();
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

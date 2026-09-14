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

import express from 'express';

import {ConfigError} from '../core/errors.mjs';
import {ProjectModel} from '../model/project.mjs';
import * as forms from './forms.mjs';
import {PANEL_KINDS, buildPanel, buildStatus, panelKey, panelUrl} from './panel.mjs';

const ROOT = path.join(import.meta.dirname, '..', '..');
const VIEWS = path.join(ROOT, 'views');
const PUBLIC = path.join(ROOT, 'public');

/** Panel shown when nothing else is asked for. */
export const DEFAULT_PANEL = 'profiles';

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

  const app = express();
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', VIEWS);
  app.use(express.urlencoded({extended: false, limit: '4mb'}));
  app.use('/static', express.static(PUBLIC));

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
    const resolved = resolvePanel(key, extra);
    return {
      model,
      key: resolved.key,
      panel: resolved.panel,
      tree: model.treeSpec(),
      status: buildStatus(model),
      extra: resolved.extra,
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
   * Answers a mutation. `action` returns the panel to show and the notices.
   *
   * @param {string} defaultKey
   * @param {(req: import('express').Request) => Record<string, unknown>} action
   * @returns {import('express').RequestHandler}
   */
  function mutation(defaultKey, action) {
    return (req, res) => {
      let extra;
      try {
        extra = action(req) ?? {};
      } catch (error) {
        if (!(error instanceof ConfigError)) throw error;
        // A rejection keeps the entered values, so the owner does not retype a
        // form because of one bad port number.
        extra = {error: error.message, form: req.body, key: defaultKey};
      }
      const key = typeof extra.key === 'string' && extra.key.length > 0 ? extra.key : defaultKey;
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
   * owner to the panel they were looking at.
   *
   * @param {import('express').Request} req
   * @param {string} fallback
   * @returns {string}
   */
  function panelFromBody(req, fallback) {
    const value = req.body?.panel;
    return typeof value === 'string' && value.length > 0 ? value : fallback;
  }

  // ------------------------------------------------------------------
  // Pages
  // ------------------------------------------------------------------

  app.get('/', (req, res) => {
    const requested = typeof req.query.panel === 'string' ? req.query.panel : DEFAULT_PANEL;
    renderPage(res, requested.length > 0 ? requested : DEFAULT_PANEL);
  });

  app.get('/panel/:key', (req, res) => {
    if (req.get('HX-Request')) renderFragment(res, req.params.key);
    else renderPage(res, req.params.key);
  });

  // ------------------------------------------------------------------
  // Profiles
  // ------------------------------------------------------------------

  app.post(
    '/profiles',
    mutation('profiles', (req) => {
      const action = String(req.body.action ?? '');
      const name = String(req.body.name ?? '').trim();
      const current = String(req.body.current ?? '').trim();

      switch (action) {
        case 'activate':
          model.setActive(name);
          return {notice: `Активен профиль '${name}'`};
        case 'create':
          model.createProfile(name);
          return {notice: `Профиль '${name}' создан — не забудьте сохранить`};
        case 'rename':
          model.renameProfile(current, name);
          return {notice: `Профиль '${current}' переименован в '${name}'`};
        case 'duplicate': {
          const copy = model.duplicateProfile(current, name.length > 0 ? name : null);
          return {notice: `Профиль '${current}' скопирован как '${copy}'`};
        }
        case 'remove':
          model.removeProfile(name);
          return {notice: `Профиль '${name}' удалён`};
        case 'note':
          model.setProfileNote(req.body.note ?? '');
          return {notice: 'Заметка профиля сохранена'};
        default:
          throw new ConfigError(`неизвестное действие '${action}'`);
      }
    }),
  );

  // ------------------------------------------------------------------
  // Shared settings: the active profile and the defaults
  // ------------------------------------------------------------------

  app.post(
    '/general',
    mutation('general', (req) => {
      const scope = req.body.scope === 'defaults' ? 'defaults' : 'profile';
      const key = scope === 'defaults' ? 'defaults' : 'general';

      if (req.body.action === 'reset') {
        const field = String(req.body.field ?? '');
        if (!model.resetProfileField(field)) {
          throw new ConfigError(`поле '${field}' и так не задано в профиле`);
        }
        return {key, notice: `'${field}' убран из профиля: снова действует значение по умолчанию`};
      }

      const values = forms.parseGeneralForm(req.body);
      if (scope === 'defaults') model.applyDefaults(values);
      else model.applyGeneral(values);
      return {key, notice: 'Применено — не забудьте сохранить'};
    }),
  );

  app.post(
    '/dns',
    mutation('dns', (req) => {
      const scope = req.body.scope === 'defaults' ? 'defaults' : 'profile';
      model.applyDns(String(req.body.dns ?? ''), scope);
      return {
        key: scope === 'defaults' ? 'defaults' : 'dns',
        notice: 'DNS применён — не забудьте сохранить',
      };
    }),
  );

  // ------------------------------------------------------------------
  // Links file and output
  // ------------------------------------------------------------------

  app.post(
    '/links',
    mutation('links', (req) => {
      model.setLinksFile(String(req.body.links_file ?? '').trim());
      return {key: 'links', notice: 'Путь к файлу ссылок применён — не забудьте сохранить'};
    }),
  );

  app.post(
    '/output',
    mutation('output', (req) => {
      model.setOutputFile(String(req.body.output_file ?? '').trim());
      return {key: 'output', notice: 'Путь вывода применён — не забудьте сохранить'};
    }),
  );

  app.post(
    '/generate',
    mutation('output', () => {
      const generation = model.generate();
      return {key: 'output', generation, notice: generation.summary};
    }),
  );

  // ------------------------------------------------------------------
  // Proxies
  // ------------------------------------------------------------------

  app.post(
    '/proxy',
    mutation('proxies', (req) => {
      const current = String(req.body.current ?? '').trim();
      const candidate = forms.parseProxyForm(req.body);
      model.upsertProxy(candidate, current.length > 0 ? current : null);
      return {
        key: panelKey('proxy', candidate.tag),
        notice: `Прокси '${candidate.tag}' применён — не забудьте сохранить`,
      };
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
      const current = String(req.body.current ?? '').trim();
      const candidate = forms.parseRouteForm(req.body);
      model.upsertRoute(candidate.name, candidate, current.length > 0 ? current : null);
      return {
        key: panelKey('route', candidate.name),
        notice: `Маршрут '${candidate.name}' применён — не забудьте сохранить`,
      };
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
    mutation(DEFAULT_PANEL, (req) => {
      const {snapshot} = model.save();
      const notice =
        snapshot === null
          ? 'Сохранено'
          : `Сохранено, предыдущая версия: ${path.basename(snapshot)}`;
      return {key: panelFromBody(req, DEFAULT_PANEL), notice};
    }),
  );

  app.post(
    '/reload',
    mutation(DEFAULT_PANEL, (req) => {
      model.reload();
      return {key: panelFromBody(req, DEFAULT_PANEL), notice: 'Файл перечитан, правки отброшены'};
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

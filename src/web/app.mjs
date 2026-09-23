// The Express application of the web editor.
//
// This file only WIRES things up: it builds the context, mounts the middleware
// in the order the tool depends on, and hands the app to the routers of
// `routes/`, one per topic. No business rule lives here, and none lives in a
// handler either: a route reads a request, calls a model method and hands the
// result to `view.mjs` and a template. Replacing the view layer (EJS + htmx
// today, React tomorrow) therefore cannot move any behaviour.
//
//   context.mjs        the per-application context (model, state, system, token)
//   view.mjs           view models, page/fragment rendering, panel extras
//   edits.mjs          applying one edit form, and the mutation wrapper
//   tunnel-state.mjs   runtime state and sudoers rights of the tunnels
//   stream.mjs         the SSE frame writer and the outbound-test row
//   routes/*.mjs       the routes themselves, grouped by topic
//
// The ORDER of the middleware below is load-bearing and is a copy of what the
// single-function app did before the split:
//
//   1. static assets and `/favicon.ico` BEFORE the token middleware — a browser
//      that has not stored the token yet must still get its stylesheet, its htmx
//      bundle and its icon;
//   2. the token middleware, which covers every route behind it, the SSE
//      endpoints included, because they are the ones that spawn processes;
//   3. the tunnel-state refresh, because the System panel and the tree marks
//      need runtime state and the handlers are synchronous once they render;
//   4. the routers;
//   5. the 404 catch-all and the error handler, last.

import path from 'node:path';

import express from 'express';

import {TOKEN_COOKIE, extractToken, tokenMatches} from './auth.mjs';
import {buildContext, isDevSandbox} from './context.mjs';
import {registerFileRoutes} from './routes/files.mjs';
import {registerPageRoutes} from './routes/pages.mjs';
import {registerProviderRoutes} from './routes/providers.mjs';
import {registerProxyRoutes} from './routes/proxies.mjs';
import {registerEditRouteRoutes} from './routes/routes.mjs';
import {registerSettingsRoutes} from './routes/settings.mjs';
import {registerSystemRoutes} from './routes/system.mjs';
import {registerTunnelRoutes} from './routes/tunnels.mjs';
import {tunnelRefreshMiddleware} from './tunnel-state.mjs';
import {DEFAULT_PANEL} from './view.mjs';

const ROOT = path.join(import.meta.dirname, '..', '..');
const VIEWS = path.join(ROOT, 'views');
const PUBLIC = path.join(ROOT, 'public');

// Published from the module that starts the editor; the names keep living here.
export {DEFAULT_PANEL, isDevSandbox};

/**
 * Builds the Express app.
 *
 * @param {{model?: import('../model/project.mjs').ProjectModel, settingsPath?: string|null,
 *   stateDir?: string, snapshotKeep?: number, token?: string,
 *   env?: Record<string, string|undefined>}} [options]
 * @returns {import('express').Express}
 */
export function createApp(options = {}) {
  const ctx = buildContext(options);
  const {token, model} = ctx;

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

  app.use(tunnelRefreshMiddleware(ctx));

  // ------------------------------------------------------------------
  // Routers, one per topic
  // ------------------------------------------------------------------
  registerPageRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
  registerTunnelRoutes(app, ctx);
  registerProviderRoutes(app, ctx);
  registerSystemRoutes(app, ctx);
  registerProxyRoutes(app, ctx);
  registerEditRouteRoutes(app, ctx);
  registerFileRoutes(app, ctx);

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

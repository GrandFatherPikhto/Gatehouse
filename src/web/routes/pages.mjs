// The two page routes: the editor root and one panel by key.
//
// Both answer the whole page or the htmx fragment depending on the request, and
// both fetch their extra data (a journal snapshot, a tunnel preview) before the
// panel is built.

import {DEFAULT_PANEL, panelExtra, renderFragment, renderPage} from '../view.mjs';

/**
 * @param {import('express').Express} app
 * @param {ReturnType<import('../context.mjs').buildContext>} ctx
 */
export function registerPageRoutes(app, ctx) {
  app.get('/', async (req, res) => {
    const requested = typeof req.query.panel === 'string' ? req.query.panel : DEFAULT_PANEL;
    const key = requested.length > 0 ? requested : DEFAULT_PANEL;
    renderPage(ctx, res, key, await panelExtra(ctx, key, req));
  });

  app.get('/panel/:key', async (req, res) => {
    const extra = await panelExtra(ctx, req.params.key, req);
    if (req.get('HX-Request')) renderFragment(ctx, res, req.params.key, extra);
    else renderPage(ctx, res, req.params.key, extra);
  });
}

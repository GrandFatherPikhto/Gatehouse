// Routes: the edit form of one route, plus «создать» and «удалить».
//
// The node is titled «Маршруты Sing-Box» in the tree; the key and the data stay
// `routes`, because renaming the key would rewrite the owner's file.

import {ConfigError} from '../../core/errors.mjs';
import {applyEditForm, mutation} from '../edits.mjs';
import {panelKey, parsePanelKey} from '../panel.mjs';

/**
 * @param {import('express').Express} app
 * @param {ReturnType<import('../context.mjs').buildContext>} ctx
 */
export function registerEditRouteRoutes(app, ctx) {
  app.post(
    '/route',
    mutation(ctx, 'routes', (req) => {
      const {key} = applyEditForm(ctx, 'route', req);
      return {key, notice: `Маршрут '${parsePanelKey(key).name}' применён — не забудьте сохранить`};
    }),
  );

  app.post(
    '/route/new',
    mutation(ctx, 'routes', () => {
      const {name} = ctx.model.addRoute();
      return {
        key: panelKey('route', name),
        notice: `Создан маршрут '${name}' — не забудьте сохранить`,
      };
    }),
  );

  app.post(
    '/route/remove',
    mutation(ctx, 'routes', (req) => {
      const name = String(req.body.current ?? '').trim();
      if (!ctx.model.removeRoute(name)) throw new ConfigError(`маршрут '${name}' не найден`);
      return {key: 'routes', notice: `Маршрут '${name}' удалён — не забудьте сохранить`};
    }),
  );
}

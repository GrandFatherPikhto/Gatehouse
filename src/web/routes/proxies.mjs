// Proxies: the edit form of one proxy, plus «создать» and «удалить».

import {ConfigError} from '../../core/errors.mjs';
import {applyEditForm, mutation} from '../edits.mjs';
import {panelKey, parsePanelKey} from '../panel.mjs';

/**
 * @param {import('express').Express} app
 * @param {ReturnType<import('../context.mjs').buildContext>} ctx
 */
export function registerProxyRoutes(app, ctx) {
  app.post(
    '/proxy',
    mutation(ctx, 'proxies', (req) => {
      const {key} = applyEditForm(ctx, 'proxy', req);
      return {key, notice: `Прокси '${parsePanelKey(key).name}' применён — не забудьте сохранить`};
    }),
  );

  app.post(
    '/proxy/new',
    mutation(ctx, 'proxies', () => {
      const entry = ctx.model.addProxy();
      return {
        key: panelKey('proxy', entry.tag),
        notice: `Создан прокси '${entry.tag}' (порт ${entry.port}) — не забудьте сохранить`,
      };
    }),
  );

  app.post(
    '/proxy/remove',
    mutation(ctx, 'proxies', (req) => {
      const tag = String(req.body.current ?? '').trim();
      if (!ctx.model.removeProxy(tag)) throw new ConfigError(`прокси '${tag}' не найден`);
      return {key: 'proxies', notice: `Прокси '${tag}' удалён — не забудьте сохранить`};
    }),
  );
}

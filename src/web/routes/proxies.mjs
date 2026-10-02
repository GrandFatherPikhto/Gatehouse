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

  // «Убрать отсутствующие»: an explicit owner action that drops the servers which
  // left the links file. The build already skips them; this only makes the
  // document say so. Names are kept until the owner presses it.
  app.post(
    '/proxy/remove-missing',
    mutation(ctx, 'proxies', (req) => {
      const tag = String(req.body.current ?? '').trim();
      const removed = ctx.model.dropMissingServers(tag, ctx.model.providersInfo().tags);
      return {
        key: panelKey('proxy', tag),
        notice:
          removed > 0
            ? `У прокси '${tag}' убрано отсутствующих серверов: ${removed} — не забудьте сохранить`
            : `У прокси '${tag}' отсутствующих серверов нет`,
      };
    }),
  );
}

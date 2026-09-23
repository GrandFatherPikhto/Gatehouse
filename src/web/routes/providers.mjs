// Providers, discovered by folder.
//
// There is NO form that takes a path: providers are found under
// GATEHOUSE_PROVIDERS and the browser never names a path. What the browser may
// do is flip the «включён» flag, rename a provider on its own panel, and
// «forget» a record whose folder is gone. The old `/providers` POST is gone, so
// a request carrying `path` hits the 404 catch-all like any other stale route.

import * as forms from '../forms.mjs';
import {panelKey} from '../panel.mjs';
import {applyEditForm, mutation} from '../edits.mjs';

/**
 * @param {import('express').Express} app
 * @param {ReturnType<import('../context.mjs').buildContext>} ctx
 */
export function registerProviderRoutes(app, ctx) {
  app.post(
    '/provider',
    mutation(
      ctx,
      (req) => panelKey('provider', String(req.body.id ?? '').trim()),
      (req) => {
        applyEditForm(ctx, 'provider', req);
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
    mutation(ctx, 'providers', (req) => {
      const id = String(req.body.id ?? '').trim();
      const enabled = forms.checkbox(req.body.enabled);
      ctx.model.setProviderEnabled(id, enabled);
      return {
        key: 'providers',
        notice: `Провайдер '${id}' ${enabled ? 'включён' : 'выключен'} — не забудьте сохранить`,
      };
    }),
  );

  app.post(
    '/provider/forget',
    mutation(ctx, 'providers', (req) => {
      const id = String(req.body.id ?? '').trim();
      ctx.model.forgetProvider(id);
      return {
        key: 'providers',
        notice:
          `Запись о провайдере '${id}' убрана: папки на диске это не касается. ` +
          'Не забудьте сохранить.',
      };
    }),
  );
}

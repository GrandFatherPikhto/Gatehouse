// Providers, discovered by folder.
//
// There is NO form that takes a path: providers are found under
// GATEHOUSE_PROVIDERS and the browser never names a path. What the browser may
// do is flip the «включён» flag, rename a provider on its own panel, and
// «forget» a record whose folder is gone. The old `/providers` POST is gone, so
// a request carrying `path` hits the 404 catch-all like any other stale route.

import {ConfigError} from '../../core/errors.mjs';
import {xrayInstalled} from '../../system/index.mjs';
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

  // «Подключить как подписку/туннели/конфиги Xray» on the «Найдено» list, and
  // «Сменить вид на …» on the panel of a folder whose chosen kind finds no file
  // (task 20 §2.2): sets ONLY the kind, leaving `enabled` false so the owner ticks
  // it afterwards. A hidden `from` names the panel to come back to; without it the
  // «Найдено» list stays the destination, exactly as before.
  app.post(
    '/provider/kind',
    mutation(ctx, 'outputs:found', (req) => {
      const id = String(req.body.id ?? '').trim();
      const kind =
        req.body.kind === 'awg'
          ? 'awg'
          : req.body.kind === 'subscription'
            ? 'subscription'
            : req.body.kind === 'xray'
              ? 'xray'
              : null;
      const from = String(req.body.from ?? '').trim();
      ctx.model.setProviderKind(id, kind);
      return {
        key: from.length > 0 ? from : 'outputs:found',
        notice: `Провайдеру '${id}' задан вид папки — не забудьте сохранить`,
      };
    }),
  );

  app.post(
    '/provider/enabled',
    mutation(ctx, 'providers', (req) => {
      const id = String(req.body.id ?? '').trim();
      const enabled = forms.checkbox(req.body.enabled);
      // §5: an `xray` provider may be described without Xray on the host, but it
      // cannot be ENABLED: a shape that would never work must say so before saving.
      if (enabled) {
        const record = ctx.model.getProvider(id) ?? {};
        if (record.kind === 'xray' && !xrayInstalled({env: ctx.systemEnv, xray: ctx.system.xray})) {
          throw new ConfigError(`Xray не найден: ${ctx.system.xray}`);
        }
      }
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

  // §4: the record of a folder that was renamed (the usual case) moves under the
  // new folder's id as one unit, so the proxies find their servers again.
  app.post(
    '/provider/move',
    mutation(ctx, 'providers', (req) => {
      const from = String(req.body.from ?? '').trim();
      const to = String(req.body.to ?? '').trim();
      ctx.model.moveProviderSettings(from, to);
      return {
        key: 'providers',
        notice: `Настройки провайдера '${from}' перенесены в '${to}' — не забудьте сохранить`,
      };
    }),
  );
}

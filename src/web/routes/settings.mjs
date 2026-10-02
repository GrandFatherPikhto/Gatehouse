// «Настройки Sing-Box» and «Настройки Amnezia».
//
// The first is one page with one form and three sections applied in order. The
// second has nothing to apply: the tunnel directory is a constant of the build,
// shown read-only, and regeneration has its own button.

import {applyEditForm, mutation} from '../edits.mjs';

/**
 * @param {import('express').Express} app
 * @param {ReturnType<import('../context.mjs').buildContext>} ctx
 */
export function registerSettingsRoutes(app, ctx) {
  app.post(
    '/singbox',
    mutation(ctx, 'singbox', (req) => {
      applyEditForm(ctx, 'singbox', req);
      return {key: 'singbox', notice: 'Настройки применены — не забудьте сохранить'};
    }),
  );

  // «Настройки → Xray»: the port range. Handing out a new range does not move an
  // existing port (a server keeps its number), so this is a safe edit to save.
  app.post(
    '/xray',
    mutation(ctx, 'xray', (req) => {
      applyEditForm(ctx, 'xray', req);
      return {key: 'xray', notice: 'Настройки Xray применены — не забудьте сохранить'};
    }),
  );

  // Frees the port of a server that is GONE. A server that is present keeps its
  // port: the model refuses the other way around.
  app.post(
    '/xray/forget',
    mutation(ctx, 'xray', (req) => {
      const key = String(req.body.key ?? '').trim();
      ctx.model.forgetXrayPort(key);
      return {key: 'xray', notice: `Порт '${key}' освобождён — не забудьте сохранить`};
    }),
  );

  /**
   * Re-normalises and rewrites every marked tunnel.
   *
   * This is a rewrite, not a start: it can be repeated without touching a live
   * connection, and the report names, per tunnel, what changed. A failure of one
   * tunnel does not stop the others.
   */
  app.post(
    '/amnezia/regenerate',
    mutation(ctx, 'amnezia', () => {
      const regeneration = ctx.model.regenerateTunnels();
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
}

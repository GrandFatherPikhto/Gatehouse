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

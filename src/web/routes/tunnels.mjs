// Tunnels: the normalisation preview, the «нужен» mark, the policy-routing
// switch, and the two lifecycle actions (up/down and restart).
//
// The write path never copies a provider file: only the output of the normaliser
// reaches the amnezia directory. The lifecycle reads the sudoers permission
// first — the panel does not draw a button without it, and a direct POST is
// refused with the exact lines to install.

import path from 'node:path';

import {ConfigError} from '../../core/errors.mjs';
import {disableTunnel, enableTunnel, restartTunnel, tunnelInterfaceCollision} from '../../system/index.mjs';
import {removeTunnelConfig} from '../../system/tunnel-file.mjs';
import * as forms from '../forms.mjs';
import {mutation} from '../edits.mjs';
import {panelKey} from '../panel.mjs';
import {assertKnownTunnel, refreshTunnelStates, tunnelRights} from '../tunnel-state.mjs';

/**
 * @param {import('express').Express} app
 * @param {ReturnType<import('../context.mjs').buildContext>} ctx
 */
export function registerTunnelRoutes(app, ctx) {
  const {model, state, systemEnv} = ctx;

  app.post(
    '/tunnel',
    mutation(
      ctx,
      (req) => `tunnel:${String(req.body.provider ?? '')}/${String(req.body.file ?? '')}`,
      (req) => {
        const provider = String(req.body.provider ?? '').trim();
        const file = String(req.body.file ?? '').trim();
        const preview = model.tunnelPreview(provider, file, {
          name: String(req.body.name ?? ''),
          label: String(req.body.label ?? ''),
          policyRouting: forms.checkbox(req.body.policyRouting),
        });
        return {
          key: `tunnel:${provider}/${file}`,
          tunnel: preview,
          notice: 'Предпросмотр пересчитан: файл не тронут.',
        };
      },
    ),
  );

  /**
   * The «нужен» mark of the Providers panel (§3.1).
   *
   * Ticking does two things at once: normalises the config and writes
   * `<interface>.conf` into the amnezia directory, then records the two names in
   * the document. Unticking stops the unit FIRST and only then removes the file,
   * so a running tunnel is never left without its config.
   */
  app.post(
    '/tunnels',
    mutation(
      ctx,
      (req) => panelKey('provider', String(req.body.provider ?? '').trim()),
      async (req) => {
        const provider = String(req.body.provider ?? '').trim();
        const file = String(req.body.file ?? '').trim();
        const key = panelKey('provider', provider);

        if (!forms.checkbox(req.body.needed)) {
          const entry = model.getTunnel(provider, file);
          if (entry === null) throw new ConfigError(`туннель '${provider}/${file}' не включён`);
          const iface = String(entry.interface);
          const runtime = state.tunnels[iface] ?? {active: false};
          if (runtime.active === true) {
            const rights = tunnelRights(ctx)[iface];
            if (rights?.canToggle !== true) {
              throw new ConfigError(
                `туннель '${iface}' сейчас поднят: остановите его или добавьте правила sudoers:\n` +
                  (rights?.missingLines ?? []).join('\n'),
              );
            }
            const stopped = await disableTunnel(iface, {env: systemEnv});
            if (!stopped.ok) {
              throw new ConfigError(
                `не удалось остановить туннель '${iface}': ` +
                  `${stopped.stderr.trim() || stopped.error || 'без вывода'}`,
              );
            }
          }
          const {entry: removed} = model.unprepareTunnel(provider, file);
          await refreshTunnelStates(ctx);
          return {
            key,
            notice:
              `Туннель '${removed.name}' выключен: конфиг убран из каталога amnezia. ` +
              'Не забудьте сохранить.',
          };
        }

        // The write path refuses a name an interface outside GateHouse already
        // holds, with the same sentence a start would give: the fuse and the
        // template unit must never disagree about which file is behind a name.
        const wanted = String(req.body.interface ?? '').trim();
        if (wanted.length > 0) {
          const collision = await tunnelInterfaceCollision(wanted, {env: systemEnv});
          if (collision !== null) throw new ConfigError(collision);
        }

        const previous = model.getTunnel(provider, file);
        const {entry, applied} = model.prepareTunnel(provider, file, {
          name: req.body.interface,
          label: req.body.name,
        });

        // A renamed file name leaves the old artifact behind: its unit is stopped
        // (when the rights allow) and the file removed, so nothing orphaned stays
        // in the amnezia directory. Without the rights the old file is left in
        // place — visible as «вне источников» rather than silently deleted.
        if (previous !== null && String(previous.interface) !== String(entry.interface)) {
          const oldIface = String(previous.interface);
          const runtime = state.tunnels[oldIface] ?? {active: false};
          if (runtime.active !== true) {
            removeTunnelConfig(model.amneziaDir, oldIface);
          } else if (tunnelRights(ctx)[oldIface]?.canToggle === true) {
            await disableTunnel(oldIface, {env: systemEnv});
            removeTunnelConfig(model.amneziaDir, oldIface);
          }
        }
        await refreshTunnelStates(ctx);
        const snapshot =
          applied.changed && applied.snapshot !== null
            ? ` (снимок прежней версии: ${path.basename(applied.snapshot)})`
            : applied.changed
              ? ''
              : ' (изменений не было)';
        return {
          key,
          notice:
            `Туннель '${entry.name}' включён: ${applied.path}${snapshot}. ` +
            'Туннель не поднят — поднимите его в разделе «Система». Не забудьте сохранить.',
        };
      },
    ),
  );

  /**
   * The policy-routing switch of the preview screen.
   *
   * For a marked tunnel the flag belongs to the document and the applied file has
   * to follow it, so the file is rewritten right away; for an unmarked one the
   * preview is only recomputed, which is what that screen is for.
   */
  app.post(
    '/tunnel/policy',
    mutation(
      ctx,
      (req) => `tunnel:${String(req.body.provider ?? '')}/${String(req.body.file ?? '')}`,
      (req) => {
        const provider = String(req.body.provider ?? '').trim();
        const file = String(req.body.file ?? '').trim();
        const policyRouting = forms.checkbox(req.body.policyRouting);
        const entry = model.getTunnel(provider, file);

        let notice;
        if (entry === null) {
          notice = 'Туннель не отмечен: предпросмотр пересчитан, файл не тронут.';
        } else {
          model.prepareTunnel(provider, file, {
            name: entry.interface,
            label: entry.name,
            policyRouting,
          });
          notice =
            `Политика маршрутизации ${policyRouting ? 'включена' : 'выключена'}: файл перезаписан. ` +
            'Не забудьте сохранить.';
        }

        const preview = model.tunnelPreview(provider, file, {
          name: String(entry?.interface ?? ''),
          label: String(entry?.name ?? ''),
          policyRouting,
        });
        return {key: `tunnel:${provider}/${file}`, tunnel: preview, notice};
      },
    ),
  );

  // ------------------------------------------------------------------
  // Tunnel lifecycle: up/down and restart (part 2)
  // ------------------------------------------------------------------
  //
  // One checkbox drives both systemd axes — `enable --now` and `disable --now` —
  // so the four combinations cannot be reached by accident.

  app.post(
    '/tunnel/toggle',
    mutation(ctx, 'system:amnezia', async (req) => {
      const name = assertKnownTunnel(ctx, req.body.name);
      const runtime = state.tunnels[name] ?? {applied: false};
      if (runtime.applied !== true) {
        throw new ConfigError(
          `конфиг туннеля '${name}' не применён: включите его галочкой «включить» в «Провайдерах»`,
        );
      }
      const rights = tunnelRights(ctx)[name];
      if (rights?.canToggle !== true) {
        throw new ConfigError(
          `нет правил sudoers на управление туннелем '${name}'. Добавьте строки:\n` +
            (rights?.missingLines ?? []).join('\n'),
        );
      }

      const up = forms.checkbox(req.body.up);
      const result = up
        ? await enableTunnel(name, {env: systemEnv})
        : await disableTunnel(name, {env: systemEnv});
      await refreshTunnelStates(ctx);

      return {
        key: 'system:amnezia',
        notice: result.ok
          ? `Туннель '${name}' ${
              up ? 'поднят и включён в автозагрузку' : 'опущен и убран из автозагрузки'
            }.`
          : `Не удалось изменить состояние туннеля '${name}': ` +
            `${result.stderr.trim() || result.error || 'без вывода'}`,
      };
    }),
  );

  app.post(
    '/tunnel/restart',
    mutation(ctx, 'system:amnezia', async (req) => {
      const name = assertKnownTunnel(ctx, req.body.name);
      const rights = tunnelRights(ctx)[name];
      if (rights?.canRestart !== true) {
        throw new ConfigError(
          `нет правила sudoers на перезапуск туннеля '${name}'. Добавьте строки:\n` +
            (rights?.missingLines ?? []).join('\n'),
        );
      }

      const result = await restartTunnel(name, {env: systemEnv});
      await refreshTunnelStates(ctx);

      return {
        key: 'system:amnezia',
        notice: result.ok
          ? `Туннель '${name}' перезапущен. Соединения через него оборвались — как и предупреждали.`
          : `Перезапуск туннеля '${name}' не удался: ` +
            `${result.stderr.trim() || result.error || 'без вывода'}`,
      };
    }),
  );
}

// Runtime state and rights of the tunnels, as the web layer sees them.
//
// Three questions are answered, and they are NOT the same question: is the
// `.conf` applied at all, is the unit active now, is it enabled at boot. Both
// systemd axes are read without `sudo`. The permission to act comes from the
// sudoers file the process may READ — the editor never writes it.

import {ConfigError} from '../core/errors.mjs';
import {
  tunnelPermissions,
  tunnelState,
  tunnelSudoersExtra,
  tunnelUnitName,
  xrayInstalled,
  xrayState,
} from '../system/index.mjs';

/**
 * Reads the runtime state of every tunnel of the inventory and caches it on
 * `state.tunnels`, keyed by interface.
 *
 * The inventory comes from the document's `tunnels` list plus the `.conf` files
 * of the amnezia directory (§3.2), so a tunnel is manageable before any proxy
 * exists.
 *
 * @param {ReturnType<import('./context.mjs').buildContext>} ctx
 * @returns {Promise<Record<string, Record<string, unknown>>>}
 */
export async function refreshTunnelStates(ctx) {
  const next = {};
  for (const tunnel of ctx.model.tunnelInventory()) {
    const iface = String(tunnel.interface);
    const unit = tunnelUnitName(iface);
    if (tunnel.applied !== true) {
      next[iface] = {applied: false, active: false, enabled: false, unit};
      continue;
    }
    const runtime = await tunnelState(iface, {env: ctx.systemEnv});
    next[iface] = {
      applied: true,
      active: runtime.active,
      enabled: runtime.enabled,
      unit: runtime.unit,
      activeRaw: runtime.activeRaw,
      enabledRaw: runtime.enabledRaw,
    };
  }
  ctx.state.tunnels = next;
  return next;
}

/**
 * Reads the runtime state of the Xray engine into `state.xray`: whether the
 * binary is installed and, when at least one enabled provider goes through it,
 * the two systemd axes. The systemd reads are SKIPPED with no Xray servers, so a
 * project that never used the second engine pays only one `fs.existsSync`.
 *
 * With no Xray server the two axes are `null`, NOT `false`: asking systemd would
 * let a project that never used the engine claim «остановлен, не в автозагрузке»
 * and advise `systemctl enable` for a service that is none of its business. The
 * rule of the project is a diagnosis, not a guess — `null` means «not checked»,
 * and everything built on `state.xray` treats it as «nothing to report».
 *
 * @param {ReturnType<import('./context.mjs').buildContext>} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export async function refreshXrayState(ctx) {
  const installed = xrayInstalled({env: ctx.systemEnv, xray: ctx.system.xray});
  const servers = ctx.model.enabledXrayServers().length;
  if (servers === 0) {
    ctx.state.xray = {installed, active: null, enabled: null, servers: 0, unit: ctx.system.xrayUnit};
    return ctx.state.xray;
  }
  const runtime = await xrayState({env: ctx.systemEnv, xray: ctx.system.xray});
  ctx.state.xray = {
    installed,
    active: runtime.active,
    enabled: runtime.enabled,
    servers,
    unit: runtime.unit,
  };
  return ctx.state.xray;
}

/**
 * Middleware that refreshes the caches before every request.
 *
 * The tunnel rows of the System panel and the tree marks need runtime state, and
 * Express handlers are synchronous once they render. A failure is swallowed on
 * purpose: a broken `systemctl` must not take the editor down — the panel then
 * shows what it last knew.
 *
 * @param {ReturnType<import('./context.mjs').buildContext>} ctx
 * @returns {import('express').RequestHandler}
 */
export function tunnelRefreshMiddleware(ctx) {
  return async (req, res, next) => {
    try {
      await refreshTunnelStates(ctx);
    } catch {
      // keep the previous snapshot
    }
    try {
      await refreshXrayState(ctx);
    } catch {
      // keep the previous snapshot
    }
    next();
  };
}

/**
 * Per interface, which tunnel controls the editor may offer. The answer comes
 * from the sudoers file the process may READ; the editor never writes it.
 *
 * @param {ReturnType<import('./context.mjs').buildContext>} ctx
 * @returns {Record<string, Record<string, unknown>>}
 */
export function tunnelRights(ctx) {
  const names = ctx.model.tunnelInventory().map((tunnel) => String(tunnel.interface));
  return tunnelPermissions(ctx.system.sudoers, names, {systemctl: ctx.system.systemctl});
}

/**
 * Names the divergence between the two systemd axes in words, or returns an
 * empty string. Hiding it would leave "everything vanished after a reboot"
 * unexplained, so it is always shown.
 *
 * @param {Record<string, unknown>} runtime
 * @returns {string}
 */
export function tunnelDivergence(runtime) {
  if (runtime.applied !== true) return 'конфиг не применён';
  if (runtime.active === true && runtime.enabled !== true) {
    return 'поднят, но не в автозагрузке: после перезагрузки пропадёт';
  }
  if (runtime.active !== true && runtime.enabled === true) {
    return 'в автозагрузке, но сейчас не поднят';
  }
  return '';
}

/**
 * The tunnel rows of the System panel, grouped by provider. The web layer
 * assembles them because only it may talk to the host; the panel builder just
 * arranges what it is handed.
 *
 * @param {ReturnType<import('./context.mjs').buildContext>} ctx
 * @returns {Array<Record<string, unknown>>}
 */
export function tunnelPanelRows(ctx) {
  const rights = tunnelRights(ctx);
  const usage = ctx.model.tunnelUsage();
  return ctx.model.tunnelGroups().map((group) => ({
    provider: group.provider,
    tunnels: group.tunnels.map((tunnel) => {
      const runtime = ctx.state.tunnels[tunnel.interface] ?? {
        applied: false,
        active: false,
        enabled: false,
      };
      const permission = rights[tunnel.interface] ?? {
        canRestart: false,
        canToggle: false,
        missingLines: [],
        sudoersReadable: true,
        sudoersNotice: null,
      };
      const unit = tunnelUnitName(tunnel.interface);
      return {
        ...tunnel,
        unit,
        label: typeof tunnel.name === 'string' ? tunnel.name : '',
        // §4.2: the owner reaches the router through this tunnel; the template
        // warns on restart/down, and the tree and the row carry the mark.
        carrier: tunnel.carrier === true,
        applied: runtime.applied === true,
        active: runtime.active === true,
        enabled: runtime.enabled === true,
        divergence: tunnelDivergence(runtime),
        usedBy: usage.get(tunnel.interface) ?? [],
        canRestart: permission.canRestart === true,
        canToggle: permission.canToggle === true,
        missingLines: permission.missingLines ?? [],
        sudoersReadable: permission.sudoersReadable !== false,
        sudoersNotice: permission.sudoersNotice ?? null,
        journalUrl: `/panel/${encodeURIComponent('system:singbox')}?unit=${encodeURIComponent(unit)}&level=warning`,
      };
    }),
  }));
}

/**
 * The ONE sudoers block of the AmneziaWG tab (§4.1): the file path, the rules a
 * tunnel is missing (with its human name), the leftover rules for tunnels that no
 * longer exist, and the "unreadable file" case. Assembled here, in the web layer,
 * because only it reads the file through the system boundary; the panel builder
 * just arranges what it is handed.
 *
 * @param {ReturnType<import('./context.mjs').buildContext>} ctx
 * @returns {{path: string, readable: boolean, notice: string|null,
 *   missing: Array<{label: string, interface: string, lines: string[]}>,
 *   extra: string[]}}
 */
export function tunnelPanelSudoers(ctx) {
  const rights = tunnelRights(ctx);
  const names = ctx.model.tunnelInventory().map((tunnel) => String(tunnel.interface));

  const missing = [];
  let unreadableNotice = null;
  for (const group of ctx.model.tunnelGroups()) {
    for (const tunnel of group.tunnels) {
      const permission = rights[tunnel.interface] ?? {};
      if (permission.sudoersReadable === false) {
        if (unreadableNotice === null) unreadableNotice = permission.sudoersNotice ?? null;
        continue;
      }
      const lines = permission.missingLines ?? [];
      if (lines.length > 0) {
        missing.push({
          label: typeof tunnel.name === 'string' && tunnel.name.length > 0
            ? tunnel.name
            : String(tunnel.interface),
          interface: String(tunnel.interface),
          lines,
        });
      }
    }
  }

  const extra = tunnelSudoersExtra(ctx.system.sudoers, names, {systemctl: ctx.system.systemctl});
  return {
    path: ctx.system.sudoers,
    readable: unreadableNotice === null,
    notice: unreadableNotice,
    missing,
    extra: extra.names,
  };
}

/**
 * Refuses a tunnel name the document does not describe, so a crafted body
 * cannot aim the unit actions at an arbitrary unit.
 *
 * @param {ReturnType<import('./context.mjs').buildContext>} ctx
 * @param {unknown} name
 * @returns {string}
 */
export function assertKnownTunnel(ctx, name) {
  const clean = String(name ?? '').trim();
  if (clean.length === 0) throw new ConfigError('не указано имя туннеля');
  if (!ctx.model.tunnelInventory().some((tunnel) => String(tunnel.interface) === clean)) {
    throw new ConfigError(
      `туннель '${clean}' не подготовлен: его нет ни в списке tunnels, ни в каталоге amnezia`,
    );
  }
  return clean;
}

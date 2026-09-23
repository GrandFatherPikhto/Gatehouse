// The tunnel INVENTORY: what exists, what uses it, and which tunnels a form may
// choose from.
//
// A tunnel exists independently of a proxy: the owner marks a `.conf` as needed,
// which records an entry in `tunnels[]` and writes `<interface>.conf` into the
// amnezia directory. The FILES are the truth about what exists (§3.2): a config
// dropped in by hand is listed too, so it can be seen, stopped and restarted —
// this module never drops such a file silently.

import path from 'node:path';

import {isMapping} from '../../core/errors.mjs';
import {suggestTunnelName, validateInterfaceName} from '../../core/normalize.mjs';
import {tunnelConfigApplied, tunnelDirState} from '../../system/tunnel-file.mjs';
import {defaultInterfaceName} from './tunnels.mjs';

/**
 * Prepared tunnels of the document, in document order.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @returns {Array<Record<string, unknown>>}
 */
export function tunnels(model) {
  const value = model.document.tunnels;
  return Array.isArray(value) ? value.filter((entry) => isMapping(entry)) : [];
}

/**
 * One prepared tunnel by its source, or `null`.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {string} providerName
 * @param {string} fileName
 * @returns {Record<string, unknown>|null}
 */
export function getTunnel(model, providerName, fileName) {
  const provider = String(providerName ?? '').trim();
  const file = path.basename(String(fileName ?? '').trim());
  return (
    tunnels(model).find((entry) => entry.provider === provider && entry.file === file) ?? null
  );
}

/**
 * One prepared tunnel by its file name — the identity of the unit, or `null`.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {string} name
 * @returns {Record<string, unknown>|null}
 */
export function getTunnelByInterface(model, name) {
  const iface = String(name ?? '').trim();
  return tunnels(model).find((entry) => entry.interface === iface) ?? null;
}

/**
 * Rows of the `.conf` list of one provider for the Providers panel: is the
 * tunnel marked, and which two names the form shows.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {string} providerName
 * @returns {Array<{file: string, marked: boolean, applied: boolean, name: string,
 *   interface: string}>}
 */
export function providerTunnelRows(model, providerName) {
  const provider = String(providerName ?? '').trim();
  const folder = model.providersInfo().providers.find((item) => item.id === provider);
  if (folder === undefined) return [];

  return (folder.entries ?? []).map((file) => {
    const stored = getTunnel(model, provider, file);
    if (stored !== null) {
      return {
        file,
        marked: true,
        applied: tunnelConfigApplied(model.amneziaDir, stored.interface),
        name: stored.name,
        interface: stored.interface,
      };
    }
    const name = suggestTunnelName(provider, file);
    return {file, marked: false, applied: false, name, interface: defaultInterfaceName(name)};
  });
}

/**
 * Tunnels the document knows about: proxies carrying a `tunnel` descriptor.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @returns {Array<{tag: string, type: string, port: number, provider: string,
 *   file: string, interface: string}>}
 */
export function tunnelProxies(model) {
  return model
    .proxies()
    .filter((proxy) => isMapping(proxy) && isMapping(proxy.tunnel))
    .map((proxy) => ({
      tag: proxy.tag,
      type: proxy.type,
      port: proxy.port,
      provider: proxy.tunnel.provider,
      file: proxy.tunnel.file,
      interface: proxy.tunnel.interface,
    }));
}

/**
 * `interface -> [proxy tags]` for the restart confirmation: it has to name the
 * proxies that stop working, not just say "connections will drop".
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @returns {Map<string, string[]>}
 */
export function tunnelUsage(model) {
  const usage = new Map();
  for (const tunnel of tunnelProxies(model)) {
    const list = usage.get(tunnel.interface) ?? [];
    list.push(tunnel.tag);
    usage.set(tunnel.interface, list);
  }
  return usage;
}

/**
 * Every tunnel the System panel shows: the prepared entries of the document
 * plus `.conf` files found in the amnezia directory that no entry claims.
 *
 * The FILES are the truth about what exists (§3.2): a config dropped in by hand
 * is listed too, under an empty provider, so it can be seen, stopped and
 * restarted. Snapshots do not end with `.conf` and file names that are not valid
 * interfaces (`de.conf.conf`) are skipped — those are the leftovers of §2.4.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @returns {Array<{provider: string, file: string|null, name: string,
 *   interface: string, applied: boolean}>}
 */
export function tunnelInventory(model) {
  /** @type {Map<string, Record<string, unknown>>} */
  const rows = new Map();
  for (const entry of tunnels(model)) {
    rows.set(String(entry.interface), {
      provider: String(entry.provider),
      file: String(entry.file),
      name: String(entry.name),
      interface: String(entry.interface),
      applied: tunnelConfigApplied(model.amneziaDir, String(entry.interface)),
    });
  }

  // A proxy of an older document may name an interface nothing else knows about
  // yet: it is listed too, so the mark can be set and the unit managed.
  for (const proxy of tunnelProxies(model)) {
    const iface = String(proxy.interface);
    if (rows.has(iface)) continue;
    rows.set(iface, {
      provider: String(proxy.provider),
      file: String(proxy.file),
      name: suggestTunnelName(proxy.provider, proxy.file),
      interface: iface,
      applied: tunnelConfigApplied(model.amneziaDir, iface),
    });
  }

  if (model.amneziaDir.length > 0) {
    for (const fileName of tunnelDirState(model.amneziaDir).names) {
      const iface = fileName.slice(0, -'.conf'.length);
      if (rows.has(iface)) continue;
      try {
        validateInterfaceName(iface);
      } catch {
        continue; // `de.conf.conf` and the like are leftovers, not tunnels
      }
      rows.set(iface, {provider: '', file: null, name: '', interface: iface, applied: true});
    }
  }
  return [...rows.values()];
}

/**
 * The inventory grouped by provider; a file no entry claims lands in
 * «вне источников».
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @returns {Array<{provider: string, tunnels: Array<Record<string, unknown>>}>}
 */
export function tunnelGroups(model) {
  const standalone = 'вне источников';
  const groups = new Map();
  for (const row of tunnelInventory(model)) {
    const key = row.provider.length > 0 ? row.provider : standalone;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === standalone ? 1 : b === standalone ? -1 : a.localeCompare(b)))
    .map(([provider, tunnels_]) => ({provider, tunnels: tunnels_}));
}

/**
 * Prepared tunnels offered to the proxy form: only the ones the owner marked
 * «нужен» (§3.2), so the form can never bind a proxy to a file nothing provides.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @returns {Array<{provider: string, file: string, name: string, interface: string}>}
 */
export function availableTunnels(model) {
  return tunnels(model)
    .filter((entry) => tunnelConfigApplied(model.amneziaDir, String(entry.interface)))
    .map((entry) => ({
      provider: String(entry.provider),
      file: String(entry.file),
      name: String(entry.name),
      interface: String(entry.interface),
    }));
}

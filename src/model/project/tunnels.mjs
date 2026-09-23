// Tunnels as PREPARED artifacts: preview, normalisation and the «нужен» mark.
//
// A tunnel exists independently of a proxy: the owner marks a `.conf` as needed,
// which normalises it, writes `<interface>.conf` into the amnezia directory and
// records the entry in `tunnels[]`. Nothing here copies a provider file as is —
// only the output of the normaliser reaches the amnezia directory — and nothing
// here starts a unit: that is the lifecycle action of `src/system/`.
//
// The neighbouring modules: `amnezia.mjs` owns the directory and the rewrite of
// every marked tunnel, `tunnel-inventory.mjs` owns what exists and who uses it.

import fs from 'node:fs';
import path from 'node:path';

import {ConfigError, isMapping} from '../../core/errors.mjs';
import {
  normalizeTunnel,
  suggestTunnelName,
  tunnelConfigRefusal,
  validateInterfaceName,
  validateTunnelLabel,
} from '../../core/normalize.mjs';
import {applyTunnelConfig, removeTunnelConfig, tunnelConfigPath} from '../../system/tunnel-file.mjs';
import {canonicalJson} from '../storage.mjs';
import {amneziaDir} from './amnezia.mjs';
import {ensureProxies} from './proxies.mjs';

/**
 * Derives a default FILE name from the human-readable tunnel name: only the
 * characters an interface may carry, clipped to the kernel limit of 15.
 *
 * It is a suggestion the owner edits: `hidemyname-AustriaGrazS4` becomes
 * `hidemyname-Aust`, which is valid but ugly on purpose — a silent truncation is
 * visible, and the field next to it is where the owner picks something readable.
 *
 * @param {string} label
 * @returns {string}
 */
export function defaultInterfaceName(label) {
  const cleaned = String(label ?? '')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/\.conf$/i, '');
  const clipped = cleaned.slice(0, 15);
  return clipped.length > 0 ? clipped : 'awg0';
}

/**
 * Runs the tunnel normaliser over one `*.conf` of a provider, for the preview.
 *
 * It READS a file and changes nothing: no write to the tunnel directory, no
 * `gatehouse-tunnel@`. Neither a WireGuard config nor an `.conf` file name
 * carries the two names the editor works with, so both are inputs: `label` is
 * the human-readable name (suggested as `<provider>-<file stem>`), `name` is the
 * file name of the applied config (suggested from the label, clipped to the
 * kernel limit). A marked tunnel supplies both from the document.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {string} providerName
 * @param {string} fileName
 * @param {{name?: string, label?: string, policyRouting?: boolean}} [options]
 * @returns {Record<string, unknown>}
 */
export function tunnelPreview(model, providerName, fileName, options = {}) {
  const provider = String(providerName ?? '').trim();
  const file = path.basename(String(fileName ?? '').trim());
  if (provider.length === 0 || file.length === 0) {
    throw new ConfigError('не указан источник или файл туннеля');
  }
  const dir = model.providerDir(provider);
  if (dir === null) {
    throw new ConfigError(`провайдер '${provider}' не найден среди папок провайдеров`);
  }
  if (path.extname(file) !== '.conf') {
    throw new ConfigError(`'${file}' не похож на конфиг туннеля (.conf)`);
  }

  const filePath = path.join(dir, file);
  if (!fs.existsSync(filePath)) {
    throw new ConfigError(`файл туннеля ${filePath} не найден`);
  }

  const stored = model.getTunnel(provider, file);
  const requestedLabel = typeof options.label === 'string' ? options.label.trim() : '';
  const label =
    requestedLabel.length > 0
      ? requestedLabel
      : stored === null
        ? suggestTunnelName(provider, file)
        : stored.name;
  const requested = typeof options.name === 'string' ? options.name.trim() : '';
  const iface =
    requested.length > 0
      ? requested
      : stored === null
        ? defaultInterfaceName(label)
        : stored.interface;
  const policyRouting =
    options.policyRouting === undefined
      ? stored?.policy_routing === true
      : options.policyRouting === true;
  const result = normalizeTunnel(fs.readFileSync(filePath, 'utf8'), {
    name: iface,
    policyRouting,
  });

  const targetDir = amneziaDir(model);
  const target = targetDir ? tunnelConfigPath(targetDir, result.name) : null;
  return {
    provider,
    file,
    path: filePath,
    // The human-readable name and the file name travel together: the preview
    // shows both, and the Providers form edits both.
    label,
    // Where the file is written and whether it is already there.
    target,
    applied: target !== null && fs.existsSync(target),
    policyRouting,
    // Whether the tunnel is marked «нужен» in the document.
    marked: stored !== null,
    ...result,
  };
}

/**
 * Applies the normalised config of one tunnel (part 1, §3): writes
 * `<amneziaDir>/<name>.conf` with mode 0600, taking a snapshot next to it only
 * when the bytes really change.
 *
 * The tunnel is NOT brought up here — that is the separate action of part 2.
 * Returns what the panel needs to say: the target, whether anything changed and
 * the name of the snapshot.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {string} providerName
 * @param {string} fileName
 * @param {{name?: string, policyRouting?: boolean}} [options]
 * @returns {{name: string, path: string, changed: boolean, snapshot: string|null,
 *   removed: string[], preview: Record<string, unknown>}}
 */
export function applyTunnel(model, providerName, fileName, options = {}) {
  const dir = amneziaDir(model);
  if (dir.length === 0) {
    throw new ConfigError(
      'не задан каталог amnezia: укажите GATEHOUSE_AMNEZIA_DIR, иначе писать конфиг туннеля некуда',
    );
  }
  const preview = tunnelPreview(model, providerName, fileName, options);
  let result;
  try {
    result = applyTunnelConfig(preview.text, {name: preview.name, amneziaDir: dir});
  } catch (error) {
    throw new ConfigError(`не удалось записать конфиг туннеля: ${error.message}`);
  }
  return {...result, name: preview.name, preview};
}

/**
 * The document's `tunnels` array, created when it is missing.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @returns {unknown[]}
 */
export function ensureTunnels(model) {
  if (!Array.isArray(model.document.tunnels)) model.document.tunnels = [];
  return model.document.tunnels;
}

/**
 * Stores one prepared tunnel, replacing the entry with the same source, and
 * keeps every proxy that uses it pointed at the current file name.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {Record<string, unknown>} entry
 */
export function storeTunnel(model, entry) {
  const list = ensureTunnels(model);
  const index = list.findIndex(
    (item) => isMapping(item) && item.provider === entry.provider && item.file === entry.file,
  );
  const previous = index < 0 ? null : list[index];
  if (index < 0) list.push(entry);
  else list[index] = entry;

  let retargeted = false;
  if (previous !== null && previous.interface !== entry.interface) {
    for (const proxy of ensureProxies(model)) {
      if (!isMapping(proxy) || !isMapping(proxy.tunnel)) continue;
      if (proxy.tunnel.provider === entry.provider && proxy.tunnel.file === entry.file) {
        proxy.tunnel = {...proxy.tunnel, interface: entry.interface};
        retargeted = true;
      }
    }
  }

  // A regeneration that found the entry already correct must not mark the
  // document dirty: the FILE may have been rewritten while the model did not
  // change, and the header would then ask to save nothing.
  if (index < 0 || canonicalJson(previous) !== canonicalJson(entry) || retargeted) {
    model.markDirty();
  }
}

/**
 * Ticks a tunnel «нужен»: validates both names, normalises the source config,
 * writes `<interface>.conf` into the amnezia directory and records the entry.
 *
 * The tunnel is NOT started here — that is the lifecycle action of the System
 * panel. Everything is checked BEFORE anything is written: a long file name, a
 * name already taken, a foreign file in the target path or a normalised text
 * without `Table = off` are all refusals, never a partial write.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {string} providerName
 * @param {string} fileName
 * @param {{name?: unknown, label?: unknown, policyRouting?: boolean}} [options]
 * @returns {{entry: Record<string, unknown>, applied: Record<string, unknown>}}
 */
export function prepareTunnel(model, providerName, fileName, options = {}) {
  const dir = amneziaDir(model);
  if (dir.length === 0) {
    throw new ConfigError(
      'не задан каталог amnezia: укажите GATEHOUSE_AMNEZIA_DIR, иначе писать конфиг туннеля некуда',
    );
  }
  const provider = String(providerName ?? '').trim();
  const file = path.basename(String(fileName ?? '').trim());
  const stored = model.getTunnel(provider, file);

  const labelInput = String(options.label ?? '').trim();
  const label = validateTunnelLabel(
    labelInput.length > 0
      ? labelInput
      : stored === null
        ? suggestTunnelName(provider, file)
        : stored.name,
  );
  const nameInput = String(options.name ?? '').trim();
  const iface = validateInterfaceName(
    nameInput.length > 0
      ? nameInput
      : stored === null
        ? defaultInterfaceName(label)
        : stored.interface,
  );

  // The file name is the identity of the unit: two tunnels cannot share it.
  for (const entry of model.tunnels()) {
    if (entry.provider === provider && entry.file === file) continue;
    if (entry.interface === iface) {
      throw new ConfigError(
        `имя файла '${iface}' уже занято туннелем '${entry.name}' (${entry.provider}/${entry.file})`,
      );
    }
  }

  // A file with this name that belongs to nobody is refused rather than
  // overwritten: the owner may have put it there by hand on purpose.
  const target = tunnelConfigPath(dir, iface);
  if (fs.existsSync(target) && (stored === null || stored.interface !== iface)) {
    throw new ConfigError(
      `файл ${target} уже есть в каталоге amnezia и не принадлежит этому туннелю: ` +
        'выберите другое имя файла',
    );
  }

  const policyRouting =
    options.policyRouting === undefined
      ? stored?.policy_routing === true
      : options.policyRouting === true;

  // The invariant of §A.4 checked at the only moment it can be: the normalised
  // text goes to disk only if it passes the same fuse that will later guard the
  // start of the unit. A normaliser that accepted something the fuse refuses
  // cannot write that file — and the refusal says which reason fired.
  const preview = tunnelPreview(model, provider, file, {name: iface, label, policyRouting});
  const refusal = tunnelConfigRefusal(preview.text);
  if (refusal !== null) {
    throw new ConfigError(
      `нормализованный конфиг туннеля '${label}' не проходит предохранитель ` +
        `(${refusal.code}${refusal.line === null ? '' : `: ${refusal.line}`}): ` +
        'записывать его нельзя',
    );
  }

  const applied = applyTunnel(model, provider, file, {name: iface, label, policyRouting});

  const entry = {provider, file, name: label, interface: iface};
  if (policyRouting) entry.policy_routing = true;
  storeTunnel(model, entry);
  return {entry, applied};
}

/**
 * Un-ticks a tunnel: drops the entry and removes `<interface>.conf`.
 *
 * The unit must already be down — stopping it needs sudo and therefore lives in
 * the web layer, which calls this only after a successful `disable --now`. A
 * tunnel still used by a proxy is refused: deleting the file would leave that
 * proxy on an interface nobody provides. Snapshots are left alone.
 *
 * @param {import('../model/project.mjs').ProjectModel} model
 * @param {string} providerName
 * @param {string} fileName
 * @returns {{entry: Record<string, unknown>, removed: boolean}}
 */
export function unprepareTunnel(model, providerName, fileName) {
  const provider = String(providerName ?? '').trim();
  const file = path.basename(String(fileName ?? '').trim());
  const entry = model.getTunnel(provider, file);
  if (entry === null) throw new ConfigError(`туннель '${provider}/${file}' не отмечен`);

  const users = model
    .tunnelProxies()
    .filter((tunnel) => tunnel.provider === provider && tunnel.file === file)
    .map((tunnel) => tunnel.tag);
  if (users.length > 0) {
    throw new ConfigError(
      `туннель '${entry.name}' используют прокси (${users.join(', ')}): сначала удалите их`,
    );
  }

  const dir = amneziaDir(model);
  const removed = dir.length > 0 ? removeTunnelConfig(dir, String(entry.interface)) : false;
  model.document.tunnels = model
    .tunnels()
    .filter((item) => !(item.provider === provider && item.file === file));
  if (model.document.tunnels.length === 0) delete model.document.tunnels;
  model.markDirty();
  return {entry, removed};
}

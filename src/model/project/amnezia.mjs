// The Amnezia directory: where the applied tunnel configs live, whether it can
// be read, and the rewrite of every marked tunnel.
//
// ONE directory for the whole editor on purpose: the write path, the delete path
// and the start-up fuse of the system layer must look at the same file, or the
// fuse would judge a config nothing ever wrote. There is no document value for
// it any more — it is a constant of the build (`core/paths.mjs`) or
// `GATEHOUSE_AMNEZIA_DIR`.

import {DEFAULT_AMNEZIA_DIR} from '../../core/paths.mjs';
import {resolvePath} from '../../core/settings.mjs';
import {
  tunnelConfigApplied,
  tunnelConfigPath,
  tunnelDirState,
} from '../../system/tunnel-file.mjs';

/**
 * Directory of the applied tunnel configs, resolved. A relative path resolves
 * against the settings directory, like `output_file`.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @returns {string}
 */
export function amneziaDir(model) {
  if (model.defaultAmneziaDir.length > 0) {
    return resolvePath(model.settingsDir, model.defaultAmneziaDir);
  }
  return DEFAULT_AMNEZIA_DIR;
}

/**
 * Fills the directory from `GATEHOUSE_AMNEZIA_DIR`. Called by the web layer,
 * which alone may read the environment.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {string} value
 */
export function setDefaultAmneziaDir(model, value) {
  if (typeof value === 'string' && value.length > 0) model.defaultAmneziaDir = value;
}

/**
 * The sentence the Amnezia panel shows when the tunnel directory cannot be read,
 * or `null` when it can. "No access" and "no directory" are different answers, and
 * the panel says which one it is instead of drawing an empty list.
 *
 * @param {string} dir
 * @param {ReturnType<typeof tunnelDirState>} state
 * @returns {string|null}
 */
export function amneziaDirAccessMessage(dir, state) {
  if (state.state === 'denied') {
    const who = state.owner !== null ? ` (владелец ${state.owner}, права ${state.mode})` : '';
    return `нет доступа к каталогу ${dir}${who}: туннели не видны редактору`;
  }
  if (state.state === 'error') return `не удалось прочитать каталог ${dir}: ${state.error}`;
  return null;
}

/**
 * What the Amnezia panel shows about the directory. Its value is NOT editable:
 * it is a constant of the build (or the process environment), so the text field
 * is gone and only the resolved path, its source and its readability remain.
 * `access` is the sentence to show instead of an empty list when the directory
 * cannot be read.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @returns {{value: string, resolved: string, source: string, fallback: string,
 *   state: string, owner: string|null, mode: string|null, access: string|null}}
 */
export function amneziaDirInfo(model) {
  const dir = amneziaDir(model);
  const state = tunnelDirState(dir);
  return {
    value: '',
    resolved: dir,
    source: model.defaultAmneziaDir.length > 0 ? 'GATEHOUSE_AMNEZIA_DIR' : 'умолчание',
    fallback: DEFAULT_AMNEZIA_DIR,
    state: state.state,
    owner: state.owner,
    mode: state.mode,
    access: amneziaDirAccessMessage(dir, state),
  };
}

/**
 * Rows of the Amnezia panel: one per marked tunnel, with its target path and
 * whether the file is on disk.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @returns {Array<Record<string, unknown>>}
 */
export function amneziaRows(model) {
  const dir = amneziaDir(model);
  return model.tunnels().map((entry) => {
    const iface = String(entry.interface);
    return {
      label: String(entry.name),
      interface: iface,
      provider: String(entry.provider),
      file: String(entry.file),
      path: tunnelConfigPath(dir, iface),
      applied: tunnelConfigApplied(dir, iface),
      policyRouting: entry.policy_routing === true,
    };
  });
}

/**
 * Re-normalises and rewrites every marked tunnel, in document order.
 *
 * The list is the document's `tunnels`, not the files on disk: a tunnel whose
 * source disappeared must be REPORTED, not silently dropped. One failure does
 * not stop the rest — the report carries a line per tunnel — and no unit is
 * started, because a rewrite is reversible and a start is not.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @returns {{entries: Array<{label: string, interface: string, path: string|null,
 *   changed: boolean|null, error: string|null}>, changed: number, failed: number}}
 */
export function regenerateTunnels(model) {
  const entries = [];
  let changed = 0;
  let failed = 0;

  for (const tunnel of model.tunnels()) {
    const label = String(tunnel.name);
    const iface = String(tunnel.interface);
    try {
      const {applied} = model.prepareTunnel(String(tunnel.provider), String(tunnel.file), {
        name: iface,
        label,
        policyRouting: tunnel.policy_routing === true,
      });
      entries.push({label, interface: iface, path: applied.path, changed: applied.changed, error: null});
      if (applied.changed) changed += 1;
    } catch (error) {
      entries.push({label, interface: iface, path: null, changed: null, error: error.message});
      failed += 1;
    }
  }
  return {entries, changed, failed};
}

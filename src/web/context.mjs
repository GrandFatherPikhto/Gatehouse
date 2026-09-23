// The context every route module works on: the model, the runtime state of the
// host layer, the system configuration and the token.
//
// It is one plain object on purpose. `createApp` builds it once and hands it to
// every router of `routes/`, which keeps the routers free of module-level state:
// two editors in one process (the tests start many) never see each other's
// "last check", migration notice or tunnel cache.

import path from 'node:path';
import process from 'node:process';

import {ProjectModel} from '../model/project.mjs';
import {systemConfig} from '../system/index.mjs';

/**
 * True when the host-facing paths of the process point into a `dev/` directory.
 *
 * That is how `npm run dev` marks the sandbox: the settings file, the generated
 * config and the state directory all live under `dev/root/`. The marker is derived
 * from the paths and not from a flag, so a stray variable cannot make a
 * production instance pretend to be a sandbox — and the tests can reproduce it by
 * pointing the variables at a directory literally called `dev`.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
export function isDevSandbox(env = process.env) {
  const marker = `${path.sep}dev${path.sep}`;
  return ['GATEHOUSE_SETTINGS', 'GATEHOUSE_CONFIG', 'GATEHOUSE_STATE_DIR'].some((key) => {
    const value = env[key];
    return typeof value === 'string' && value.length > 0 && value.includes(marker);
  });
}

/**
 * Builds the context of one Express application.
 *
 * @param {{model?: ProjectModel, settingsPath?: string|null, stateDir?: string,
 *   snapshotKeep?: number, token?: string, env?: Record<string, string|undefined>}} [options]
 *   `model` is injected by the tests; otherwise one is created and bound to
 *   `settingsPath`.
 * @returns {{token: string, systemEnv: Record<string, string|undefined>,
 *   system: Record<string, unknown>, sandbox: boolean, model: ProjectModel,
 *   state: Record<string, unknown>}}
 */
export function buildContext(options = {}) {
  const token = typeof options.token === 'string' ? options.token : '';
  // The environment of the process decides what the system layer runs; a request
  // never does. `systemConfig` reads the same variables the CLI does.
  const systemEnv = options.env ?? process.env;
  const system = systemConfig(systemEnv);
  const sandbox = isDevSandbox(systemEnv);

  const model =
    options.model ??
    new ProjectModel({
      path: options.settingsPath ?? null,
      stateDir: options.stateDir,
      snapshotKeep: options.snapshotKeep,
      // Directory of the tunnel configs: `GATEHOUSE_AMNEZIA_DIR`, else the build
      // constant. There is no document value to override it any more.
      amneziaDir: system.amneziaDir,
      // Root the provider folders are discovered under. Only an EXPLICIT
      // `GATEHOUSE_PROVIDERS` is handed in; without it the model keeps its own
      // resolution (a `providers/` folder next to webui.json, else the default),
      // so the sandbox and the tests can keep their data beside the settings.
      providersDir:
        typeof systemEnv.GATEHOUSE_PROVIDERS === 'string' &&
        systemEnv.GATEHOUSE_PROVIDERS.length > 0
          ? systemEnv.GATEHOUSE_PROVIDERS
          : undefined,
    });
  // `startServer` injects a model built before the environment was read; give it
  // the tunnel directory and, when named, the providers root as well.
  model.setDefaultAmneziaDir(system.amneziaDir);
  if (
    typeof systemEnv.GATEHOUSE_PROVIDERS === 'string' &&
    systemEnv.GATEHOUSE_PROVIDERS.length > 0
  ) {
    model.setProvidersDir(systemEnv.GATEHOUSE_PROVIDERS);
  }

  // Runtime state of the host layer. It lives on the context, not in a module
  // global, so two editors in one process cannot see each other's "last check"
  // and restart permissions.
  const state = {
    lastCheck: null,
    lastRestart: null,
    testsRunning: false,
    // Runtime state of the tunnels, keyed by interface: `{applied, active,
    // enabled, unit}`. Refreshed from the host before a request is rendered.
    tunnels: {},
    // A document migrated by `model.open` is announced once, on the first render.
    migrationNoticeShown: false,
  };

  return {token, systemEnv, system, sandbox, model, state};
}

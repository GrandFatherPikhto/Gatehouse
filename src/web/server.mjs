#!/usr/bin/env node
// Entry point of the web editor: `npm start`.
//
// The settings path comes from the environment and from nowhere else. The tool
// writes files, so a path arriving from the browser would be a path traversal
// waiting to happen: there is deliberately no "open file" box in the UI.
//
// The defaults are the safe ones: bind to 127.0.0.1, never to 0.0.0.0. Stage 3
// adds authentication, an HTTPS terminator and the systemd unit; until then
// exposing this port would mean exposing the owner's proxy settings.

import fs from 'node:fs';
import process from 'node:process';

import {DEFAULT_SETTINGS_FILE} from '../core/errors.mjs';
import {ProjectModel} from '../model/project.mjs';
import {DEFAULT_STATE_DIR} from '../model/storage.mjs';
import {createApp} from './app.mjs';

/** Default port of the editor. */
export const DEFAULT_PORT = '8080';

/**
 * Reads the configuration of the process from the environment.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{settings: string, host: string, port: string, stateDir: string|null}}
 */
export function readEnv(env = process.env) {
  return {
    settings: env.SINGBOX_WEBUI_SETTINGS || DEFAULT_SETTINGS_FILE,
    host: env.SINGBOX_WEBUI_HOST || '127.0.0.1',
    port: env.SINGBOX_WEBUI_PORT ?? DEFAULT_PORT,
    stateDir: env.SINGBOX_WEBUI_STATE_DIR || null,
  };
}

/**
 * Starts the editor.
 *
 * A missing settings file is not an error: the server starts with a fresh
 * document bound to that path, so the first save creates it. An existing file is
 * opened and validated, and a broken one stops the start with the reason of the
 * core instead of a half-working UI.
 *
 * @param {{settings?: string, host?: string, port?: string|number, stateDir?: string|null,
 *   env?: Record<string, string|undefined>}} [options]
 * @returns {Promise<{server: import('node:http').Server, model: ProjectModel,
 *   host: string, port: number, url: string}>}
 */
export async function startServer(options = {}) {
  const env = {...readEnv(options.env), ...withoutUndefined(options)};
  const model = new ProjectModel({stateDir: env.stateDir ?? undefined});

  if (fs.existsSync(env.settings)) model.open(env.settings);
  else model.newProject(env.settings);

  const app = createApp({model});
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(Number(env.port), env.host, () => resolve(listener));
    listener.on('error', reject);
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : Number(env.port);
  const host = env.host === '0.0.0.0' ? '127.0.0.1' : env.host;
  return {server, model, host, port, url: `http://${host}:${port}/`};
}

/**
 * Drops the keys that were not passed, so they cannot shadow the environment.
 *
 * @param {Record<string, unknown>} options
 * @returns {Record<string, unknown>}
 */
function withoutUndefined(options) {
  const result = {};
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * CLI entry point.
 *
 * @returns {Promise<number>}
 */
export async function run() {
  try {
    const {url, model} = await startServer();
    process.stdout.write(`Веб-редактор webui.json: ${url}\n`);
    process.stdout.write(`Настройки: ${model.path}\n`);
    process.stdout.write(`Снапшоты: ${model.stateDir}\n`);
    process.stdout.write(
      'Состояние живёт на сервере: одна вкладка на процесс. Две открытые вкладки ' +
        'будут затирать правки друг друга.\n',
    );
    process.stdout.write('Системные вызовы (check, restart, journalctl) — этап 3.\n');
    return 0;
  } catch (error) {
    process.stderr.write(`Ошибка: ${error.message}\n`);
    return 1;
  }
}

// Only run the CLI when this file is the entry point: tests import startServer.
const invokedDirectly = process.argv[1] && import.meta.filename === process.argv[1];
if (invokedDirectly) {
  process.exitCode = await run();
}

export {DEFAULT_STATE_DIR, DEFAULT_SETTINGS_FILE};

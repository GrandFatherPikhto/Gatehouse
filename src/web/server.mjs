#!/usr/bin/env node
// Entry point of the web editor: `npm start`.
//
// The settings path comes from the environment and from nowhere else. The tool
// writes files, so a path arriving from the browser would be a path traversal
// waiting to happen: there is deliberately no "open file" box in the UI.
//
// The defaults are the safe ones: bind to 127.0.0.1, never to 0.0.0.0. From stage
// 3 on the editor can restart the daemon and shows the VLESS keys, so binding it
// to a LAN address without a token is refused at startup instead of being a
// sentence in the README: `assertAuthentication` below. The unit of `deploy/`
// keeps the token in an `EnvironmentFile` with mode 0640, because the contents of
// a unit are readable by anyone through `systemctl cat`.
//
// Even with a token, binding to the LAN means the token travels in cleartext:
// the README keeps saying that a loopback bind plus an ssh tunnel is the safer
// choice, and that the token is convenience, not protection from sniffing.

import fs from 'node:fs';
import process from 'node:process';

import {DEFAULT_SETTINGS_FILE} from '../core/errors.mjs';
import {ProjectModel} from '../model/project.mjs';
import {DEFAULT_STATE_DIR} from '../model/storage.mjs';
import {createApp} from './app.mjs';
import {TOKEN_VAR, assertAuthentication, isLoopbackHost, tokenMatches} from './auth.mjs';

/** Default port of the editor. */
export const DEFAULT_PORT = '8080';

// Re-exported so the names keep living in the module that starts the server.
export {TOKEN_VAR, assertAuthentication, isLoopbackHost, tokenMatches};

/**
 * Reads the configuration of the process from the environment.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{settings: string, host: string, port: string, stateDir: string|null}}
 */
export function readEnv(env = process.env) {
  return {
    settings: env.GATEHOUSE_SETTINGS || DEFAULT_SETTINGS_FILE,
    host: env.GATEHOUSE_HOST || '127.0.0.1',
    port: env.GATEHOUSE_PORT ?? DEFAULT_PORT,
    stateDir: env.GATEHOUSE_STATE_DIR || null,
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
 *   token?: string, env?: Record<string, string|undefined>}} [options]
 * @returns {Promise<{server: import('node:http').Server, model: ProjectModel,
 *   host: string, port: number, url: string, tokenRequired: boolean}>}
 */
export async function startServer(options = {}) {
  const source = options.env ?? process.env;
  const env = {...readEnv(options.env), ...withoutUndefined(options)};
  const token = options.token ?? source[TOKEN_VAR] ?? '';

  // Before anything is bound: a non-loopback bind without a token is a refusal,
  // not a warning. Stage 3 is the point where the editor gained the ability to
  // restart the daemon, so forgetting the token must not be possible.
  assertAuthentication(env.host, token);

  const model = new ProjectModel({stateDir: env.stateDir ?? undefined});

  if (fs.existsSync(env.settings)) model.open(env.settings);
  else model.newProject(env.settings);

  const app = createApp({model, token, env: source});
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(Number(env.port), env.host, () => resolve(listener));
    listener.on('error', reject);
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : Number(env.port);
  const host = env.host === '0.0.0.0' ? '127.0.0.1' : env.host;
  return {
    server,
    model,
    host,
    port,
    url: `http://${host}:${port}/`,
    tokenRequired: token.length > 0,
  };
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
    const {url, model, tokenRequired} = await startServer();
    process.stdout.write(`Веб-редактор webui.json: ${url}\n`);
    process.stdout.write(`Настройки: ${model.path}\n`);
    process.stdout.write(`Снапшоты: ${model.stateDir}\n`);
    process.stdout.write(
      tokenRequired
        ? 'Доступ: включён токен. По HTTP он идёт открытым —\n' +
            'надёжнее 127.0.0.1 и ssh-туннель.\n'
        : 'Доступ: только обратная петля, без токена.\n',
    );
    process.stdout.write(
      'Состояние живёт на сервере: одна вкладка на процесс. Две открытые вкладки ' +
        'будут затирать правки друг друга.\n',
    );
    process.stdout.write(
      'Системные вызовы включены: sing-box check, перезапуск демона, журнал, тест серверов.\n',
    );
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

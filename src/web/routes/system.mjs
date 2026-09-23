// The system layer as the owner uses it: generate → check → restart, the
// rollback, and the streamed outbound test.
//
// The order is deliberate and visible in the panel: generate → check → and only
// then the restart is even drawn. `Restart=always` is set on the unit, so
// restarting with a config the daemon rejects means an endless restart loop and
// every connection in the house down. The rollback is one click for the same
// reason.
//
// The journal is a snapshot of the «Sing-box» tab, read by the page route; there
// is no live SSE stream of it any more (see `view.mjs`).

import path from 'node:path';

import {ConfigError} from '../../core/errors.mjs';
import {
  checkConfig,
  restartSingBox,
  testOutbounds,
} from '../../system/index.mjs';
import {restoreLatestConfig, snapshotConfig} from '../../model/storage.mjs';
import {mutation} from '../edits.mjs';
import {SSE_HEADERS, testResultView, writeEvent} from '../stream.mjs';
import {refreshTunnelStates} from '../tunnel-state.mjs';

/** How long a check may take before it is killed; `sing-box check` is instant. */
const CHECK_TIMEOUT = 15000;

/** Keep of the `config.json` snapshots taken before each generation. */
const CONFIG_SNAPSHOT_KEEP = 10;

/**
 * @param {import('express').Express} app
 * @param {ReturnType<import('../context.mjs').buildContext>} ctx
 */
export function registerSystemRoutes(app, ctx) {
  const {model, state, systemEnv} = ctx;

  app.post(
    '/generate',
    mutation(ctx, 'singbox', async () => {
      // Snapshot BEFORE the generator overwrites the file: the whole point of the
      // rollback is to bring back byte-for-byte what the daemon was running, and
      // that copy has to be taken while it still exists.
      const configPath = model.resolvedOutputPath();
      const snapshot = model.configExists()
        ? snapshotConfig(configPath, model.stateDir, {keep: CONFIG_SNAPSHOT_KEEP})
        : null;
      // §5.4: a proxy on a stopped tunnel is a silently dead port, so the warning
      // needs to know which interfaces are really up. The state is read from the
      // host here and handed to the pure generator.
      await refreshTunnelStates(ctx);
      const runningTunnels = Object.entries(state.tunnels)
        .filter(([, runtime]) => runtime.active === true)
        .map(([name]) => name);
      const generation = model.generate({runningTunnels});

      // New bytes invalidate the old check: the previous check judged a different
      // file, so it must not authorise a restart of what is on disk now.
      state.lastCheck = null;

      return {
        key: 'singbox',
        generation,
        snapshot: snapshot === null ? null : path.basename(snapshot.path),
        notice: generation.summary,
      };
    }),
  );

  app.post(
    '/check',
    mutation(ctx, 'system:singbox', async () => {
      const configPath = model.resolvedOutputPath();
      if (!model.configExists()) {
        throw new ConfigError(
          'config.json ещё не сгенерирован: сначала «Сгенерировать», потом проверять',
        );
      }

      const result = await checkConfig(configPath, {env: systemEnv, timeout: CHECK_TIMEOUT});
      state.lastCheck = {
        ok: result.ok,
        code: result.code,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
        error: result.error,
        timedOut: result.timedOut,
        at: new Date().toISOString(),
        configPath,
      };
      // The permission to restart is tied to the bytes that were just checked.
      state.lastRestart = null;

      return {
        key: 'system:singbox',
        notice: result.ok
          ? 'Схема принята: sing-box check прошёл (exit=0). Это проверка декодирования, ' +
            'а не доказательство корректности — дубль порта, чужой тег и опечатку в dns.final ' +
            'она пропускает.'
          : 'Проверка не прошла: перезапуск не предлагается',
      };
    }),
  );

  app.post(
    '/restart',
    mutation(ctx, 'system:singbox', async () => {
      if (state.lastCheck === null || !state.lastCheck.ok) {
        throw new ConfigError(
          'перезапуск не предлагается: сначала успешная проверка config.json',
        );
      }

      const result = await restartSingBox({env: systemEnv});
      state.lastRestart = {
        ok: result.ok,
        code: result.code,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
        error: result.error,
        timedOut: result.timedOut,
        at: new Date().toISOString(),
      };

      return {
        key: 'system:singbox',
        notice: result.ok
          ? 'sing-box перезапущен. Все текущие соединения оборвались — как и предупреждали.'
          : `Перезапуск не удался: ${result.stderr.trim() || result.error || 'без вывода'}`,
      };
    }),
  );

  app.post(
    '/rollback',
    mutation(ctx, 'system:singbox', async () => {
      const configPath = model.resolvedOutputPath();
      const restored = restoreLatestConfig(model.stateDir, configPath);
      if (restored === null) {
        throw new ConfigError('снапшотов config.json ещё нет: откатывать нечего');
      }

      // The restored bytes were never checked in this session, so the permission
      // to restart does not transfer to them from the previous check.
      state.lastCheck = null;

      const result = await restartSingBox({env: systemEnv});
      state.lastRestart = {
        ok: result.ok,
        code: result.code,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
        error: result.error,
        timedOut: result.timedOut,
        at: new Date().toISOString(),
      };

      const from = path.basename(restored.from);
      return {
        key: 'system:singbox',
        notice: result.ok
          ? `Восстановлен ${from} и sing-box перезапущен.`
          : `Конфиг восстановлен из ${from}, но перезапуск не удался: ` +
            `${result.stderr.trim() || result.error || 'без вывода'}`,
      };
    }),
  );

  // ------------------------------------------------------------------
  // Mass outbound test (SSE)
  // ------------------------------------------------------------------
  //
  // Replaces the reference `live_test`, which restarted the daemon once per
  // server. Nothing here touches the running daemon: `tools fetch` starts its own
  // instance. Progress is streamed so a 148-server run cannot block a request for
  // minutes, and the concurrency cap keeps the router from opening 148 sockets.

  app.get('/tests/stream', async (req, res) => {
    // An SSE route answers `200` ALWAYS, refusals included: `EventSource` does
    // not reconnect after a non-200 response, so a 409 here would kill the panel
    // until the page was reloaded. A refusal is an event inside the stream.
    res.status(200).set(SSE_HEADERS);
    res.flushHeaders();

    if (state.testsRunning) {
      writeEvent(res, 'refused', {message: 'тест серверов уже идёт: дождитесь конца'});
      res.end();
      return;
    }

    const info = model.providersInfo();
    if (info.error !== null) {
      writeEvent(res, 'refused', {message: info.error});
      res.end();
      return;
    }

    const tags = info.tags;
    const controller = new AbortController();
    state.testsRunning = true;

    writeEvent(res, 'start', {total: tags.length, concurrency: ctx.system.testConcurrency});

    const abort = () => controller.abort();
    req.on('close', abort);
    res.on('close', abort);

    try {
      const outcome = await testOutbounds(tags, {
        env: systemEnv,
        configPath: model.resolvedOutputPath(),
        concurrency: ctx.system.testConcurrency,
        signal: controller.signal,
        onResult: (result) => writeEvent(res, 'result', testResultView(result)),
      });
      writeEvent(res, 'done', {
        total: tags.length,
        done: outcome.results.length,
        aborted: outcome.aborted,
      });
    } catch (error) {
      writeEvent(res, 'failed', {message: error.message});
    } finally {
      state.testsRunning = false;
      if (!res.writableEnded) res.end();
    }
  });
}

// The system layer as the owner uses it: the ONE apply chain, the rollback, and
// the streamed outbound test.
//
// The buttons «Сгенерировать / Проверить / Перезапустить / Откатить» left the
// «Службы → Sing-Box» tab: the permanent apply bar drives the whole chain now.
// The old routes stay (hidden) because tools and tests still speak to them; the
// chain itself never leaves unchecked bytes in the live `config.json`.
//
// `/apply` steps, in order, first failure stops:
//   1. save the document if it is dirty;
//   2. build `config.json` into a NEIGHBOURING temporary file (`config.json.new`);
//   3. `sing-box check` that temporary file;
//   4. snapshot the live `config.json` (keep 10);
//   5. rename the temporary file over the live one;
//   6. restart sing-box;
//   7. poll `systemctl is-active` until the unit is really up.
// A failure of 6–7 rolls the snapshot back and restarts again.

import fs from 'node:fs';
import path from 'node:path';

import {ConfigError} from '../../core/errors.mjs';
import {
  checkConfig,
  restartSingBox,
  testOutbounds,
  waitForActive,
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
 * Restarts sing-box and confirms the unit really came up (step 6 + 7). The
 * `Restart=always` unit may be `activating` for a moment, so the poll waits for
 * two consecutive `active` reads.
 *
 * @param {ReturnType<import('../context.mjs').buildContext>} ctx
 * @returns {Promise<{ok: boolean, message: string}>}
 */
async function restartAndConfirm(ctx) {
  const result = await restartSingBox({env: ctx.systemEnv});
  if (!result.ok) {
    return {ok: false, message: result.stderr.trim() || result.error || 'перезапуск не удался'};
  }
  const active = await waitForActive({env: ctx.systemEnv});
  if (!active.ok) {
    return {
      ok: false,
      message: `служба не поднялась (is-active: ${active.last || 'без ответа'})`,
    };
  }
  return {ok: true, message: 'sing-box поднялся'};
}

/**
 * @param {import('express').Express} app
 * @param {ReturnType<import('../context.mjs').buildContext>} ctx
 */
export function registerSystemRoutes(app, ctx) {
  const {model, state, systemEnv} = ctx;

  // The one chain. Its outcome is kept on `state.lastApply` for the bar.
  app.post(
    '/apply',
    mutation(ctx, 'singbox', async () => {
      const configPath = model.resolvedOutputPath();
      const tempPath = `${configPath}.new`;
      /** @type {Array<{ok: boolean, step: string, message: string, at: string}>} */
      const steps = [];
      const record = (ok, step, message) => {
        steps.push({ok, step, message, at: new Date().toISOString()});
      };
      const finish = (outcome) => {
        state.lastApply = {...outcome, at: new Date().toISOString(), steps};
        // The live bytes may have moved: drop the bar's comparison cache.
        state.applyCache = null;
        return {key: 'singbox', apply: state.lastApply, notice: outcome.message};
      };

      try {
        // 1. save
        if (model.dirty) {
          model.save();
          record(true, 'сохранение', 'документ сохранён');
        } else {
          record(true, 'сохранение', 'несохранённых правок нет');
        }

        // 2. build into the temporary file
        await refreshTunnelStates(ctx);
        const runningTunnels = Object.entries(state.tunnels)
          .filter(([, runtime]) => runtime.active === true)
          .map(([name]) => name);
        const generation = model.generate({output: tempPath, runningTunnels});
        record(true, 'сборка', `серверов: ${generation.stats.servers}`);

        // 3. check the temporary file
        const check = await checkConfig(tempPath, {env: systemEnv, timeout: CHECK_TIMEOUT});
        if (!check.ok) {
          fs.rmSync(tempPath, {force: true});
          const why = check.stderr.trim() || check.error || 'check не прошёл';
          record(false, 'проверка схемы', why);
          return finish({
            ok: false,
            step: 'проверка схемы',
            message: `Сборка не применена: проверка схемы не прошла — ${why}`,
            rolledBack: false,
          });
        }
        record(true, 'проверка схемы', 'sing-box check прошёл');

        // 4. already applied? Do not break connections for nothing.
        if (
          fs.existsSync(configPath) &&
          fs.readFileSync(tempPath).equals(fs.readFileSync(configPath))
        ) {
          fs.rmSync(tempPath, {force: true});
          record(true, 'применение', 'совпадает с боевым файлом');
          return finish({
            ok: true,
            step: 'готово',
            message: 'Уже применено, перезапуск не нужен',
            rolledBack: false,
          });
        }

        // 5. snapshot + rename (never copy: the rename is atomic)
        const snapshot = fs.existsSync(configPath)
          ? snapshotConfig(configPath, model.stateDir, {keep: CONFIG_SNAPSHOT_KEEP})
          : null;
        fs.renameSync(tempPath, configPath);
        record(true, 'установка файла', path.basename(configPath));

        // 6 + 7. restart and confirm; rollback on failure
        const up = await restartAndConfirm(ctx);
        if (!up.ok) {
          const restored = snapshot === null ? null : restoreLatestConfig(model.stateDir, configPath);
          const again = restored === null ? {ok: false} : await restartAndConfirm(ctx);
          record(false, 'перезапуск', up.message);
          return finish({
            ok: false,
            step: 'перезапуск',
            message:
              `Применение не удалось на шаге «перезапуск»: ${up.message}` +
              (restored === null
                ? ' — снимка нет, автоматический откат невозможен'
                : again.ok
                  ? ' — выполнен откат, служба вернулась'
                  : ' — откат сделан, но служба не поднялась'),
            rolledBack: restored !== null,
          });
        }
        record(true, 'перезапуск', up.message);
        return finish({
          ok: true,
          step: 'готово',
          message: 'Применено: config.json установлен и sing-box перезапущен',
          rolledBack: false,
        });
      } catch (error) {
        fs.rmSync(tempPath, {force: true});
        const message =
          error instanceof ConfigError ? error.message : `внутренняя ошибка: ${error.message}`;
        record(false, 'сборка', message);
        return finish({ok: false, step: 'сборка', message, rolledBack: false});
      }
    }),
  );

  // Kept for `tools/` and tests, HIDDEN in the UI (§1.4). Generation itself
  // never leaves unchecked bytes in the live file: it builds next to it, checks
  // it and only then renames it into place.
  app.post(
    '/generate',
    mutation(ctx, 'singbox', async () => {
      const configPath = model.resolvedOutputPath();
      const tempPath = `${configPath}.new`;
      const snapshot = fs.existsSync(configPath)
        ? snapshotConfig(configPath, model.stateDir, {keep: CONFIG_SNAPSHOT_KEEP})
        : null;

      await refreshTunnelStates(ctx);
      const runningTunnels = Object.entries(state.tunnels)
        .filter(([, runtime]) => runtime.active === true)
        .map(([name]) => name);

      try {
        const generation = model.generate({output: tempPath, runningTunnels});
        const check = await checkConfig(tempPath, {env: systemEnv, timeout: CHECK_TIMEOUT});
        if (!check.ok) {
          fs.rmSync(tempPath, {force: true});
          throw new ConfigError(
            `сборка не прошла проверку схемы: ${check.stderr.trim() || check.error || 'check не прошёл'}`,
          );
        }
        fs.renameSync(tempPath, configPath);
        state.lastCheck = null;
        state.applyCache = null;
        return {
          key: 'singbox',
          generation,
          snapshot: snapshot === null ? null : path.basename(snapshot.path),
          notice: generation.summary,
        };
      } catch (error) {
        fs.rmSync(tempPath, {force: true});
        throw error;
      }
    }),
  );

  app.post(
    '/check',
    mutation(ctx, 'system:singbox', async () => {
      const configPath = model.resolvedOutputPath();
      if (!model.configExists()) {
        throw new ConfigError(
          'config.json ещё не сгенерирован: сначала «Применить», потом проверять',
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
      const active = result.ok ? await waitForActive({env: systemEnv}) : {ok: false, last: ''};
      state.lastRestart = {
        ok: result.ok && active.ok,
        code: result.code,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
        error: result.error,
        timedOut: result.timedOut,
        at: new Date().toISOString(),
      };

      return {
        key: 'system:singbox',
        notice:
          result.ok && active.ok
            ? 'sing-box перезапущен и поднялся. Все текущие соединения оборвались — как и предупреждали.'
            : `Перезапуск не удался: ${result.stderr.trim() || result.error || `is-active: ${active.last}`}`,
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

      state.lastCheck = null;
      state.applyCache = null;

      const up = await restartAndConfirm(ctx);
      state.lastRestart = {
        ok: up.ok,
        at: new Date().toISOString(),
      };

      const from = path.basename(restored.from);
      return {
        key: 'system:singbox',
        notice: up.ok
          ? `Восстановлен ${from} и sing-box перезапущен.`
          : `Конфиг восстановлен из ${from}, но перезапуск не удался: ${up.message}`,
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

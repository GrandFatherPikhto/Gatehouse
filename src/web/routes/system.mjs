// The system layer as the owner uses it: the ONE apply chain, the rollback, and
// the streamed outbound test.
//
// The chain now applies a PAIR of configs (task plan_2026_10_02_gatehouse_xray_core.md
// §4): sing-box AND Xray. It saves the document, builds BOTH into neighbouring
// temporary files, checks BOTH, snapshots BOTH live files, renames BOTH, restarts
// Xray (only if its config changed; stopped when no server goes through it) and
// then sing-box. A failure at a restart step rolls BOTH back and restarts what it
// restarted. The buttons «Сгенерировать / Проверить / Перезапустить / Откатить»
// left the «Службы → Sing-Box» tab: the permanent apply bar drives the chain now.
// The old routes stay (hidden) because tools and tests still speak to them.

import fs from 'node:fs';
import path from 'node:path';

import {ConfigError} from '../../core/errors.mjs';
import {
  checkConfig,
  checkXrayConfig,
  restartSingBox,
  restartXray,
  stopXray,
  testOutbounds,
  waitForActive,
  xrayState,
} from '../../system/index.mjs';
import {
  canWriteDir,
  isPermissionError,
  restoreLatestConfig,
  restoreLatestXrayConfig,
  snapshotConfig,
  snapshotXrayConfig,
  xrayDirInfo,
} from '../../model/storage.mjs';
import {applyEditForm, mutation, panelFromBody} from '../edits.mjs';
import {editFormRoutes, parsePanelKey} from '../panel.mjs';
import {SSE_HEADERS, testResultView, writeEvent} from '../stream.mjs';
import {refreshTunnelStates} from '../tunnel-state.mjs';

/** How long a check may take before it is killed; both checks are instant. */
const CHECK_TIMEOUT = 15000;

/** Keep of the `config.json` snapshots taken before each generation. */
const CONFIG_SNAPSHOT_KEEP = 10;

/**
 * The refusal text for a config directory this process may not write: the
 * sentence plus the exact command the owner runs on the router. One helper, so
 * the routes and the bar can never disagree about the wording.
 *
 * @param {{message: string, command: string}} info
 * @returns {string}
 */
function dirRefusal(info) {
  return `${info.message} На роутере: ${info.command}`;
}

/**
 * True when two files, both present, hold the same bytes.
 *
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
function sameBytes(left, right) {
  try {
    return fs.readFileSync(left).equals(fs.readFileSync(right));
  } catch {
    return false;
  }
}

/**
 * Removes a temporary file, ignoring every failure. A missing file is normal; a
 * file the process may not even inspect (the default `/etc/xray` on a desktop) is
 * NOT a reason to fail the whole chain — it only means there is nothing of ours
 * to clean up there.
 *
 * @param {string} file
 */
function removeQuietly(file) {
  try {
    fs.rmSync(file, {force: true});
  } catch {
    // nothing of ours to remove, or no right to look: neither is an error
  }
}

/**
 * Restarts sing-box and confirms the unit really came up. The `Restart=always`
 * unit may be `activating` for a moment, so the poll waits for two consecutive
 * `active` reads.
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
 * Restarts the Xray unit and confirms it really came up.
 *
 * @param {ReturnType<import('../context.mjs').buildContext>} ctx
 * @returns {Promise<{ok: boolean, message: string}>}
 */
async function restartXrayAndConfirm(ctx) {
  const result = await restartXray({env: ctx.systemEnv});
  if (!result.ok) {
    return {
      ok: false,
      message: result.stderr.trim() || result.error || 'перезапуск Xray не удался',
    };
  }
  const active = await waitForActive({env: ctx.systemEnv, unit: ctx.system.xrayUnit});
  if (!active.ok) {
    return {ok: false, message: `xray не поднялся (is-active: ${active.last || 'без ответа'})`};
  }
  return {ok: true, message: 'xray поднялся'};
}

/**
 * @param {import('express').Express} app
 * @param {ReturnType<import('../context.mjs').buildContext>} ctx
 */
export function registerSystemRoutes(app, ctx) {
  const {model, state, systemEnv} = ctx;

  // The one chain. Its outcome is kept on `state.lastApply` for the bar. The panel
  // the button sits on travels in `?panel=`; the open edit form of THAT panel is
  // applied first, and the answer goes back to it on success.
  app.post(
    '/apply',
    mutation(ctx, 'system:singbox', async (req) => {
      const ownKey = panelFromBody(req, 'system:singbox');
      const {kind} = parsePanelKey(ownKey);
      const failKey = 'system:singbox';
      const configPath = model.resolvedOutputPath();
      const tempPath = `${configPath}.new`;
      const xrayConfigPath = String(ctx.system.xrayConfig);
      const xrayTempPath = `${xrayConfigPath}.new`;
      /** @type {Array<{ok: boolean, step: string, message: string, at: string}>} */
      const steps = [];
      const record = (ok, step, message) => {
        steps.push({ok, step, message, at: new Date().toISOString()});
      };
      const finish = (outcome, extra = {}) => {
        state.lastApply = {...outcome, at: new Date().toISOString(), steps};
        // The live bytes may have moved: drop the bar's comparison cache.
        state.applyCache = null;
        return {key: outcome.panel, apply: state.lastApply, notice: outcome.message, ...extra};
      };
      const cleanup = () => {
        removeQuietly(tempPath);
        removeQuietly(xrayTempPath);
      };

      // The chain needs write access to the DIRECTORY of the live config: it
      // builds a neighbouring `config.json.new` and renames it, and the rollback
      // writes its temporary file there too. Refuse up front, with the fix
      // command, instead of failing at the first write with `EACCES`.
      const dirInfo = model.outputDirInfo();
      if (!dirInfo.ok) throw new ConfigError(dirRefusal(dirInfo));

      // The step a later failure really belongs to, so the refusal names the
      // phase it stopped at instead of always saying «сборка».
      let phase = 'сохранение';

      try {
        // 0. the open edit form of the panel the button sits on, applied with the
        // VERY SAME code `/save?panel=` uses, so "edit → Apply" can never behave
        // differently from "edit → Сохранить → Apply". A refusal stops HERE.
        phase = 'форма панели';
        if (editFormRoutes(kind).length > 0) {
          const hadEdits = model.dirty;
          try {
            const applied = applyEditForm(ctx, kind, req);
            if (!applied.changed && !hadEdits) model.markClean();
            record(
              true,
              'форма панели',
              applied.changed ? 'правки панели применены' : 'изменений в форме нет',
            );
          } catch (error) {
            if (!(error instanceof ConfigError)) throw error;
            record(false, 'форма панели', error.message);
            return finish(
              {ok: false, step: 'форма панели', message: error.message, rolledBack: false, panel: failKey},
              {error: error.message, form: req.body ?? {}},
            );
          }
        }

        // 1. ports, then save. Handing out an Xray port changes the document, and
        // «Применить» saves that change like any other (§2).
        phase = 'сохранение';
        model.ensureXrayPorts();
        if (model.dirty) {
          model.save();
          record(true, 'сохранение', 'документ сохранён');
        } else {
          record(true, 'сохранение', 'несохранённых правок нет');
        }

        // 2. build BOTH into neighbouring temporary files
        phase = 'сборка';
        await refreshTunnelStates(ctx);
        const runningTunnels = Object.entries(state.tunnels)
          .filter(([, runtime]) => runtime.active === true)
          .map(([name]) => name);
        const generation = model.generate({output: tempPath, runningTunnels});
        const xrayGeneration = model.generateXray({xrayConfig: xrayTempPath});
        const xrayCount = xrayGeneration.xray.servers.length;
        record(
          true,
          'сборка',
          `серверов: ${generation.stats.servers}` +
            (xrayCount > 0 ? `, через Xray: ${xrayCount}` : ''),
        );

        // The Xray directory must be writable only when there IS an Xray config.
        if (xrayCount > 0) {
          const info = xrayDirInfo(path.dirname(xrayConfigPath));
          if (!canWriteDir(info.dir)) {
            cleanup();
            record(false, 'сборка', dirRefusal(info));
            return finish({
              ok: false,
              step: 'сборка',
              message: dirRefusal(info),
              rolledBack: false,
              panel: failKey,
            });
          }
        }

        // 3. check BOTH; a failure applies nothing
        phase = 'проверка схемы';
        const check = await checkConfig(tempPath, {env: systemEnv, timeout: CHECK_TIMEOUT});
        if (!check.ok) {
          cleanup();
          const why = check.stderr.trim() || check.error || 'check не прошёл';
          record(false, 'проверка схемы', `sing-box: ${why}`);
          return finish({
            ok: false,
            step: 'проверка схемы',
            message: `Сборка не применена: проверка схемы не прошла — ${why}`,
            rolledBack: false,
            panel: failKey,
          });
        }
        if (xrayCount > 0) {
          const xrayCheck = await checkXrayConfig(xrayTempPath, {env: systemEnv});
          if (!xrayCheck.ok) {
            cleanup();
            const why = xrayCheck.stderr.trim() || xrayCheck.error || 'xray run -test не прошёл';
            record(false, 'проверка схемы', `Xray: ${why}`);
            return finish({
              ok: false,
              step: 'проверка схемы',
              message: `Сборка не применена: конфиг Xray не прошёл проверку — ${why}`,
              rolledBack: false,
              panel: failKey,
            });
          }
        }
        record(
          true,
          'проверка схемы',
          xrayCount > 0 ? 'sing-box check и xray run -test прошли' : 'sing-box check прошёл',
        );

        // 4. already applied? Both configs must match; do not break connections.
        const singboxSame = fs.existsSync(configPath) && sameBytes(tempPath, configPath);
        const xraySame =
          xrayCount === 0
            ? true
            : fs.existsSync(xrayConfigPath) && sameBytes(xrayTempPath, xrayConfigPath);
        if (singboxSame && xraySame) {
          cleanup();
          record(true, 'применение', 'совпадает с боевыми файлами');
          return finish({
            ok: true,
            step: 'готово',
            message: 'Уже применено, перезапуск не нужен',
            rolledBack: false,
            panel: ownKey,
          });
        }

        // 5. snapshot + rename both (never copy: the rename is atomic)
        phase = 'установка файла';
        const snapshot = fs.existsSync(configPath)
          ? snapshotConfig(configPath, model.stateDir, {keep: CONFIG_SNAPSHOT_KEEP})
          : null;
        const xraySnapshot =
          xrayCount > 0 && fs.existsSync(xrayConfigPath)
            ? snapshotXrayConfig(xrayConfigPath, model.stateDir, {keep: CONFIG_SNAPSHOT_KEEP})
            : null;
        fs.renameSync(tempPath, configPath);
        const xrayChanged = xrayCount > 0 && !xraySame;
        if (xrayCount > 0) {
          fs.renameSync(xrayTempPath, xrayConfigPath);
          record(true, 'установка файла', path.basename(xrayConfigPath));
        }
        // With no Xray servers there is no Xray temp file to remove: generation
        // wrote none, and touching the default path would need rights we do not
        // have on a desktop.

        // 6. Xray: restart if its config changed, else leave it; no servers — stop it
        let xrayRestarted = false;
        if (xrayCount > 0) {
          if (xrayChanged) {
            phase = 'перезапуск Xray';
            const up = await restartXrayAndConfirm(ctx);
            if (!up.ok) {
              const rolled = rollbackPair({
                model,
                configPath,
                xrayConfigPath,
                snapshot,
                xraySnapshot,
                xrayCount,
                restartSingBoxAgain: true,
                ctx,
              });
              record(false, 'перезапуск Xray', up.message);
              return finish({
                ok: false,
                step: 'перезапуск Xray',
                message:
                  `Применение не удалось на шаге «перезапуск Xray»: ${up.message}` +
                  (rolled ? ' — выполнен откат обоих конфигов' : ' — снимка нет, откат невозможен'),
                rolledBack: rolled,
                panel: failKey,
              });
            }
            xrayRestarted = true;
            record(true, 'перезапуск Xray', up.message);
          } else {
            record(true, 'перезапуск Xray', 'конфиг Xray не изменился — не трогали');
          }
        } else {
          phase = 'остановка Xray';
          const current = await xrayState({env: systemEnv});
          if (current.active) {
            await stopXray({env: systemEnv});
            record(true, 'остановка Xray', 'серверов Xray нет — служба остановлена');
          } else {
            record(true, 'Xray', 'серверов Xray нет — служба не запущена');
          }
        }

        // 7. sing-box — restart and confirm, as before
        phase = 'перезапуск';
        const up = await restartAndConfirm(ctx);
        if (!up.ok) {
          const restored =
            snapshot === null ? null : restoreLatestConfig(model.stateDir, configPath);
          if (xrayCount > 0 && xrayRestarted) {
            restoreLatestXrayConfig(model.stateDir, xrayConfigPath);
            await restartXrayAndConfirm(ctx);
          }
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
            panel: failKey,
          });
        }
        record(true, 'перезапуск', up.message);
        return finish({
          ok: true,
          step: 'готово',
          message: xrayCount > 0
            ? 'Применено: config.json и конфиг Xray установлены, службы перезапущены'
            : 'Применено: config.json установлен и sing-box перезапущен',
          rolledBack: false,
          panel: ownKey,
        });
      } catch (error) {
        cleanup();
        const info = model.outputDirInfo();
        const message =
          isPermissionError(error) && !info.ok
            ? dirRefusal(info)
            : error instanceof ConfigError
              ? error.message
              : `внутренняя ошибка: ${error.message}`;
        record(false, phase, message);
        return finish({ok: false, step: phase, message, rolledBack: false, panel: failKey});
      }
    }),
  );

  /**
   * Rolls BOTH live files back to their snapshots and restarts what was started.
   *
   * @param {{model: import('../../model/project.mjs').ProjectModel, configPath: string,
   *   xrayConfigPath: string, snapshot: {path: string}|null, xraySnapshot: {path: string}|null,
   *   xrayCount: number, restartSingBoxAgain: boolean,
   *   ctx: ReturnType<import('../context.mjs').buildContext>}} options
   * @returns {boolean} True when at least one config was restored.
   */
  function rollbackPair(options) {
    const {
      model: project,
      configPath: liveConfig,
      xrayConfigPath: liveXray,
      snapshot,
      xraySnapshot,
      xrayCount,
      ctx: context,
    } = options;
    let restored = false;
    if (snapshot !== null) {
      restored = restoreLatestConfig(project.stateDir, liveConfig) !== null || restored;
    }
    if (xrayCount > 0 && xraySnapshot !== null) {
      restored = restoreLatestXrayConfig(project.stateDir, liveXray) !== null || restored;
    }
    return restored;
  }

  // Kept for `tools/` and tests, HIDDEN in the UI. Generation itself never leaves
  // unchecked bytes in the live files: it builds next to them, checks them and
  // only then renames them into place. Writes BOTH configs (§4).
  app.post(
    '/generate',
    mutation(ctx, 'singbox', async () => {
      const configPath = model.resolvedOutputPath();
      const tempPath = `${configPath}.new`;
      const xrayConfigPath = String(ctx.system.xrayConfig);
      const xrayTempPath = `${xrayConfigPath}.new`;
      const dirInfo = model.outputDirInfo();
      if (!dirInfo.ok) throw new ConfigError(dirRefusal(dirInfo));

      await refreshTunnelStates(ctx);
      const runningTunnels = Object.entries(state.tunnels)
        .filter(([, runtime]) => runtime.active === true)
        .map(([name]) => name);

      try {
        const snapshot = fs.existsSync(configPath)
          ? snapshotConfig(configPath, model.stateDir, {keep: CONFIG_SNAPSHOT_KEEP})
          : null;
        const generation = model.generate({output: tempPath, runningTunnels});
        const xrayGeneration = model.generateXray({xrayConfig: xrayTempPath});
        const xrayCount = xrayGeneration.xray.servers.length;

        const check = await checkConfig(tempPath, {env: systemEnv, timeout: CHECK_TIMEOUT});
        if (!check.ok) {
          removeQuietly(tempPath);
          removeQuietly(xrayTempPath);
          throw new ConfigError(
            `сборка не прошла проверку схемы: ${check.stderr.trim() || check.error || 'check не прошёл'}`,
          );
        }
        if (xrayCount > 0) {
          const xrayCheck = await checkXrayConfig(xrayTempPath, {env: systemEnv});
          if (!xrayCheck.ok) {
            removeQuietly(tempPath);
            removeQuietly(xrayTempPath);
            throw new ConfigError(
              `конфиг Xray не прошёл проверку: ${xrayCheck.stderr.trim() || xrayCheck.error || 'xray run -test не прошёл'}`,
            );
          }
        }

        fs.renameSync(tempPath, configPath);
        if (xrayCount > 0) {
          if (fs.existsSync(xrayConfigPath)) {
            snapshotXrayConfig(xrayConfigPath, model.stateDir, {keep: CONFIG_SNAPSHOT_KEEP});
          }
          fs.renameSync(xrayTempPath, xrayConfigPath);
        }
        state.lastCheck = null;
        state.applyCache = null;
        return {
          key: 'singbox',
          generation,
          snapshot: snapshot === null ? null : path.basename(snapshot.path),
          notice: generation.summary,
        };
      } catch (error) {
        removeQuietly(tempPath);
        removeQuietly(xrayTempPath);
        const info = model.outputDirInfo();
        if (isPermissionError(error) && !info.ok) throw new ConfigError(dirRefusal(info));
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

  // «Службы → Xray»: a plain restart, no config change. Guarded by sudoers only,
  // like the tunnel restart; the panel shows the block when the line is missing.
  app.post(
    '/xray/restart',
    mutation(ctx, 'system:xray', async () => {
      const result = await restartXray({env: systemEnv});
      const active = result.ok
        ? await waitForActive({env: systemEnv, unit: ctx.system.xrayUnit})
        : {ok: false, last: ''};
      return {
        key: 'system:xray',
        notice:
          result.ok && active.ok
            ? 'Xray перезапущен и поднялся.'
            : `Перезапуск Xray не удался: ${result.stderr.trim() || result.error || `is-active: ${active.last}`}`,
      };
    }),
  );

  app.post(
    '/rollback',
    mutation(ctx, 'system:singbox', async (req) => {
      const ownKey = panelFromBody(req, 'system:singbox');
      const configPath = model.resolvedOutputPath();
      const xrayConfigPath = String(ctx.system.xrayConfig);
      const dirInfo = model.outputDirInfo();
      if (!dirInfo.ok) throw new ConfigError(dirRefusal(dirInfo));

      // The pair is rolled back together: both snapshots are the ones taken by the
      // last apply, so restoring only one would leave the engines disagreeing.
      let restored;
      try {
        restored = restoreLatestConfig(model.stateDir, configPath);
        restoreLatestXrayConfig(model.stateDir, xrayConfigPath);
      } catch (error) {
        if (isPermissionError(error)) throw new ConfigError(dirRefusal(model.outputDirInfo()));
        throw error;
      }
      if (restored === null) {
        throw new ConfigError('снапшотов config.json ещё нет: откатывать нечего');
      }

      state.lastCheck = null;
      state.applyCache = null;

      const up = await restartAndConfirm(ctx);
      state.lastRestart = {ok: up.ok, at: new Date().toISOString()};

      const from = path.basename(restored.from);
      return {
        key: up.ok ? ownKey : 'system:singbox',
        notice: up.ok
          ? `Восстановлена пара конфигов (${from}) и sing-box перезапущен.`
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

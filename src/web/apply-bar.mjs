// The apply bar: the one place that says whether the live `config.json` matches
// the document, and the buttons that act on it.
//
// Replaces the old header, which only knew «есть несохранённые правки». The bar
// has four states, by priority:
//
//   1. dirty   — `model.dirty`: unsaved edits, save first;
//   2. failed  — `state.lastApply.ok === false`: the last apply failed;
//   3. pending — the build of the SAVED document differs from the live file;
//   4. applied — they are byte for byte the same.
//
// The comparison never writes a file: it builds the config from the saved
// document in memory (`previewConfig`) and compares the bytes with the live
// `config.json`. The build reuses exactly the reader and the assembly of the
// generator, so the two cannot drift apart. When the build REFUSES (a server
// vanished, two providers collide), that refusal is the "pending" text — it is
// what the owner must see before pressing Apply.
//
// The result is cached on the context state, keyed by the settings file and the
// live config (path, mtime, size) plus the dirty flag, so a page render does not
// re-read the provider folders every time. Any write changes one of those keys.

import fs from 'node:fs';

import {ConfigError} from '../core/errors.mjs';
import {stringifyConfig} from '../core/settings.mjs';
import {plural} from '../core/sources.mjs';
import {LABEL_NAMES_CAP} from '../model/stale.mjs';
import {listConfigSnapshots} from '../model/storage.mjs';

/**
 * Formats a timestamp as `ДД.ММ ЧЧ:ММ` in the server's local time. The bar shows
 * the time of the last successful apply of THIS process, and a stable, short
 * shape keeps the line readable on a narrow screen.
 *
 * @param {string|number|Date|null} value
 * @returns {string} Empty when the value is not a date.
 */
export function formatStamp(value) {
  if (value === null || value === undefined) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (number) => String(number).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * `mtime:size` of a file, or `none`, for the cache key. A missing file is a
 * stable key of its own.
 *
 * @param {string|null} filePath
 * @returns {string}
 */
function statStamp(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return 'none';
  try {
    const stat = fs.statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'none';
  }
}

/**
 * True when there is at least one `config.json` snapshot to roll back to.
 *
 * @param {import('../model/project.mjs').ProjectModel} model
 * @returns {boolean}
 */
function hasSnapshots(model) {
  try {
    return listConfigSnapshots(model.stateDir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Time of the last SUCCESSFUL apply of this process, formatted, or `''`.
 *
 * @param {Record<string, unknown>|null} lastApply
 * @returns {string}
 */
function appliedAt(lastApply) {
  if (lastApply === null || lastApply.ok !== true) return '';
  return formatStamp(lastApply.at);
}

/**
 * Compares the build of the saved document with the live `config.json`, through
 * the cache on `state.applyCache`.
 *
 * @param {ReturnType<import('./context.mjs').buildContext>} ctx
 * @returns {{state: string, message: string, detail: string}}
 */
function compareWithLive(ctx) {
  const {model, state, system} = ctx;
  if (model.path === null) {
    return {
      state: 'pending',
      message: 'сохранено, не применено',
      detail: 'файл ещё не сохранён',
      warnings: [],
    };
  }

  const configPath = model.resolvedOutputPath();
  const xrayConfigPath = String(system?.xrayConfig ?? '');
  const key = [
    model.path,
    model.dirty,
    statStamp(model.path),
    statStamp(configPath),
    statStamp(xrayConfigPath),
  ].join('|');
  const cache = state.applyCache ?? null;
  if (cache !== null && cache.key === key) return cache.value;

  // The build warnings travel with the answer: a server that left the links file
  // is not a refusal, but the owner has to see it on the bar. The collector is
  // filled by the SAME reader and assembly the generator runs.
  const warnings = [];
  let value;
  try {
    // BOTH configs are built, exactly as `/apply` would: "already applied" means
    // the pair matches, and a change in either one must show as pending (§4).
    const pair = model.previewBoth({warnings});
    const expected = stringifyConfig(pair.config);
    const expectedXray = pair.xrayConfig === null ? null : stringifyConfig(pair.xrayConfig);

    const singboxMatch =
      fs.existsSync(configPath) && fs.readFileSync(configPath, 'utf8') === expected;
    let xrayMatch = true;
    if (expectedXray !== null) {
      xrayMatch =
        xrayConfigPath.length > 0 &&
        fs.existsSync(xrayConfigPath) &&
        fs.readFileSync(xrayConfigPath, 'utf8') === expectedXray;
    }

    if (!fs.existsSync(configPath)) {
      value = {
        state: 'pending',
        message: 'сохранено, не применено',
        detail: 'боевой config.json ещё не собран',
      };
    } else if (singboxMatch && xrayMatch) {
      value = {state: 'applied', message: 'применено', detail: ''};
    } else {
      value = {state: 'pending', message: 'сохранено, не применено', detail: ''};
    }
  } catch (error) {
    // The build refusal is the honest "pending" text: it is what the owner has
    // to fix before applying, and hiding it behind a bare "not applied" would
    // send them pressing Apply only to be refused there.
    value = {
      state: 'pending',
      message: 'сохранено, не применено',
      detail: error instanceof ConfigError ? error.message : `сборка не удалась: ${error.message}`,
    };
  }

  value.warnings = warnings;
  state.applyCache = {key, value};
  return value;
}

/**
 * The view model of the apply bar.
 *
 * @param {ReturnType<import('./context.mjs').buildContext>} ctx
 * @returns {{state: string, message: string, detail: string, lastAppliedAt: string,
 *   canRollback: boolean, applyButton: boolean, saveButton: boolean,
 *   lastApply: Record<string, unknown>|null, steps: Array<Record<string, unknown>>}}
 */
export function applyBar(ctx) {
  const {model, state} = ctx;
  const lastApply = state.lastApply ?? null;
  const canRollback = hasSnapshots(model);

  if (model.dirty) {
    return {
      state: 'dirty',
      message: 'есть несохранённые правки',
      detail: 'нажмите «Сохранить», затем «Применить»',
      lastAppliedAt: appliedAt(lastApply),
      canRollback,
      saveButton: true,
      applyButton: true,
      lastApply,
      steps: [],
    };
  }

  // The step list of the last run travels with the bar so the owner sees exactly
  // which step a success or a failure stopped at (§1.2).
  const steps = lastApply !== null && Array.isArray(lastApply.steps) ? lastApply.steps : [];

  if (lastApply !== null && lastApply.ok === false) {
    const step = typeof lastApply.step === 'string' ? lastApply.step : '';
    return {
      state: 'failed',
      message: `применение не удалось на шаге «${step}»`,
      detail: typeof lastApply.message === 'string' ? lastApply.message : '',
      lastAppliedAt: appliedAt(lastApply),
      canRollback,
      saveButton: true,
      applyButton: true,
      lastApply,
      steps,
    };
  }

  // The directory of the live `config.json` must be writable: the chain builds a
  // neighbouring `config.json.new` and renames it, and the rollback writes its
  // temporary file there too. Below "несохранённые правки" and a concrete
  // failure, above "не применено": the standing problem is worth naming before a
  // press, and the fix command goes with it.
  const dirInfo = model.outputDirInfo();
  if (!dirInfo.ok) {
    return {
      state: 'warning',
      message: dirInfo.message,
      detail: `На роутере: ${dirInfo.command}`,
      lastAppliedAt: appliedAt(lastApply),
      // Neither action can work until the rights are fixed.
      canRollback: false,
      saveButton: true,
      applyButton: false,
      lastApply,
      steps,
    };
  }

  // Task 19 §3: enabled servers go through Xray, and the service is not running
  // (stopped by hand, crashed, or the router rebooted without autostart). The
  // live files may match the document, but those ports are dead — say so before
  // the owner presses anything.
  const xrayServers = model.enabledXrayServers().length;
  const xrayRuntime = ctx.state?.xray ?? {};
  // Only a KNOWN stop is a fact: `null` means «not checked» and must not turn
  // into «Xray не работает» (task 21 §1).
  if (xrayServers > 0 && xrayRuntime.active === false) {
    return {
      state: 'warning',
      message: `Xray не работает — ${xrayServers} ${plural(
        xrayServers,
        'сервер',
        'сервера',
        'серверов',
      )} недоступны`,
      detail: 'нажмите «Применить» или «Службы → Xray» → «Перезапустить»',
      lastAppliedAt: appliedAt(lastApply),
      canRollback,
      saveButton: true,
      applyButton: true,
      lastApply,
      steps,
    };
  }

  const comparison = compareWithLive(ctx);
  // Warnings are capped exactly like a tree label: the first `LABEL_NAMES_CAP`
  // lines and «ещё N». A missing server produces one line per proxy, so an
  // unbounded list would fill the bar.
  const warnings = Array.isArray(comparison.warnings) ? comparison.warnings : [];
  const shownWarnings = warnings.slice(0, LABEL_NAMES_CAP);
  const warningsMore = warnings.length - shownWarnings.length;

  // A successful apply that still produced warnings is a «warning», not
  // «applied»: the port is up, but the owner has to see what was skipped.
  if (comparison.state === 'applied' && warnings.length > 0) {
    return {
      state: 'warning',
      message: 'Применено, с предупреждениями',
      detail: '',
      warnings: shownWarnings,
      warningsMore,
      lastAppliedAt: appliedAt(lastApply),
      canRollback,
      saveButton: true,
      applyButton: true,
      lastApply,
      steps,
    };
  }

  return {
    ...comparison,
    warnings: shownWarnings,
    warningsMore,
    lastAppliedAt: appliedAt(lastApply),
    canRollback,
    saveButton: true,
    applyButton: true,
    lastApply,
    steps,
  };
}

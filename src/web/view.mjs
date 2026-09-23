// View models and rendering: the whole page, the htmx fragment, and what a
// panel needs before it can be built.
//
// The panel builders of `panel.mjs` stay pure: they only arrange what they are
// handed. Whatever needs the host — a journal snapshot, a tunnel preview, the
// runtime state of the tunnels — is fetched HERE, in the web layer, and passed
// down as plain data.

import path from 'node:path';

import {ConfigError} from '../core/errors.mjs';
import {PRIORITY_LEVELS, tailJournal} from '../system/index.mjs';
import {PANEL_KINDS, buildPanel, buildStatus, panelKey, panelUrl} from './panel.mjs';
import {tunnelPanelRows} from './tunnel-state.mjs';

/** Panel shown when nothing else is asked for. */
export const DEFAULT_PANEL = 'singbox';

/** How many journal lines one snapshot of the journal shows. */
export const JOURNAL_SNAPSHOT_LINES = 200;
/** Minimum level a journal snapshot starts from; `debug` shows everything. */
export const DEFAULT_JOURNAL_LEVEL = 'info';
/** The most lines a snapshot may ask for, so one request stays cheap. */
const JOURNAL_MAX_LINES = 1000;

/**
 * Builds a panel, falling back to a neighbouring one when the requested panel
 * cannot be built: an entity deleted in another tab, or a key that makes no
 * sense. The reason travels in `extra.error`, which is what the notices block
 * of the templates renders — never a stack trace in front of the owner.
 *
 * @param {ReturnType<import('./context.mjs').buildContext>} ctx
 * @param {string} key
 * @param {Record<string, unknown>} extra
 * @returns {{key: string, panel: Record<string, unknown>, extra: Record<string, unknown>}}
 */
export function resolvePanel(ctx, key, extra) {
  const requested = typeof key === 'string' && key.length > 0 ? key : DEFAULT_PANEL;
  const kind = requested.includes(':') ? requested.slice(0, requested.indexOf(':')) : requested;

  try {
    const panel = buildPanel(ctx.model, requested, extra);
    // «Система» is a GROUP with two child nodes now: a bare or unknown key must
    // point at a REAL node, so the tree highlight and `HX-Push-Url` name the
    // child, never the page-less group.
    const resolvedKey = panel.kind === 'system' ? panelKey('system', String(panel.tab)) : requested;
    return {key: resolvedKey, panel, extra};
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;

    let fallback = DEFAULT_PANEL;
    if (PANEL_KINDS.includes(kind)) {
      if (kind === 'route') fallback = 'routes';
      if (kind === 'proxy') fallback = 'proxies';
      if (kind === 'provider') fallback = 'providers';
    }
    return {
      key: fallback,
      panel: buildPanel(ctx.model, fallback, {...extra, error: null}),
      extra: {...extra, error: error.message},
    };
  }
}

/**
 * Locals shared by the full page and the htmx fragment.
 *
 * @param {ReturnType<import('./context.mjs').buildContext>} ctx
 * @param {string} key
 * @param {Record<string, unknown>} extra
 * @returns {Record<string, unknown>}
 */
export function buildView(ctx, key, extra) {
  const {model, state, system, token, sandbox} = ctx;
  // A version-1 file is rewritten on disk by `model.open` before the first
  // render. The owner must be told once, and told what moved: a silent rewrite
  // of their own file is exactly the kind of surprise the migration warnings
  // exist to prevent.
  let withNotices = extra;
  if (model.lastMigration !== null && !state.migrationNoticeShown) {
    state.migrationNoticeShown = true;
    const lines = ['webui.json переведён на версию 2: профили упразднены.'];
    if (model.lastMigration.snapshot !== null) {
      lines.push(`Снимок прежней версии: ${path.basename(model.lastMigration.snapshot)}.`);
    }
    lines.push(...model.lastMigration.warnings);
    withNotices = {...extra, notice: lines.join(' ')};
  }

  // The fields of the removed Watchdog are still in the FILE until the owner
  // saves, so the line about them stays on every panel until then. It goes into
  // the notice channel that already exists — one line, no new UI, and nothing is
  // rewritten behind the owner's back. The sources-migration line lives by the
  // same rule: the file still carries the bare folder names until a save.
  for (const line of [model.removedNotice, model.providersMigrationNotice]) {
    if (line === null) continue;
    const previous = withNotices.notice;
    withNotices = {
      ...withNotices,
      notice: typeof previous === 'string' && previous.length > 0 ? `${previous} ${line}` : line,
    };
  }

  // The panel builders get the runtime state of the host layer, not a way to
  // run anything: `buildPanel` only arranges what the routes already did.
  const enriched = {
    ...withNotices,
    system: {
      lastCheck: state.lastCheck,
      lastRestart: state.lastRestart,
      unit: system.unit,
      testConcurrency: system.testConcurrency,
      journalLines: JOURNAL_SNAPSHOT_LINES,
      journalLevel: DEFAULT_JOURNAL_LEVEL,
      journalLevels: PRIORITY_LEVELS,
    },
    // Tunnel rows of the System panel. Assembled here, from the cached runtime
    // state and the sudoers rights, so the panel builders stay pure.
    tunnels: tunnelPanelRows(ctx),
    auth: {tokenRequired: token.length > 0},
  };
  const resolved = resolvePanel(ctx, key, enriched);
  return {
    model,
    key: resolved.key,
    panel: resolved.panel,
    // The tree marks a proxy on a stopped tunnel; the states come from the
    // cache refreshed by the middleware of the app.
    tree: model.treeSpec({tunnelStates: state.tunnels}),
    status: buildStatus(model),
    extra: resolved.extra,
    sandbox,
  };
}

/**
 * Renders the whole page.
 *
 * @param {ReturnType<import('./context.mjs').buildContext>} ctx
 * @param {import('express').Response} res
 * @param {string} key
 * @param {Record<string, unknown>} [extra]
 */
export function renderPage(ctx, res, key, extra = {}) {
  res.render('layout', buildView(ctx, key, extra));
}

/**
 * Renders the fragment htmx swaps in: the panel plus the out-of-band tree and
 * header.
 *
 * @param {ReturnType<import('./context.mjs').buildContext>} ctx
 * @param {import('express').Response} res
 * @param {string} key
 * @param {Record<string, unknown>} [extra]
 */
export function renderFragment(ctx, res, key, extra = {}) {
  const view = buildView(ctx, key, extra);
  res.set('HX-Push-Url', panelUrl(view.key));
  res.render('partials/response', view);
}

/**
 * Reads one journal snapshot for the panel.
 *
 * Every value comes from the query string with a bounded fallback: the unit is
 * an argument to `journalctl -u` (never a shell word), the line count is
 * clamped, and an unknown level falls back to the default. The request leaves
 * no state — the panel renders what `journalctl` printed once.
 *
 * @param {ReturnType<import('./context.mjs').buildContext>} ctx
 * @param {import('express').Request} req
 * @returns {Promise<Record<string, unknown>>}
 */
export async function journalSnapshot(ctx, req) {
  const requested = Number(req.query?.lines);
  const lines = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), JOURNAL_MAX_LINES)
    : JOURNAL_SNAPSHOT_LINES;
  const requestedLevel =
    typeof req.query?.level === 'string' ? req.query.level.trim().toLowerCase() : '';
  const level = PRIORITY_LEVELS.includes(requestedLevel) ? requestedLevel : DEFAULT_JOURNAL_LEVEL;
  const unit = typeof req.query?.unit === 'string' ? req.query.unit.trim() : '';

  const result = await tailJournal(lines, {
    env: ctx.systemEnv,
    level,
    unit: unit.length > 0 ? unit : undefined,
  });

  return {
    ok: result.ok,
    error: result.error,
    entries: result.entries,
    lines: result.lines,
    unit: result.unit,
    level: result.level,
  };
}

/**
 * Extra data a panel needs before it can be built. Only the journal and the
 * tunnel preview have any: both come from outside the model, so they are fetched
 * by a ROUTE and handed to the panel, whose builders stay pure.
 *
 * @param {ReturnType<import('./context.mjs').buildContext>} ctx
 * @param {string} key
 * @param {import('express').Request} req
 * @returns {Promise<Record<string, unknown>>}
 */
export async function panelExtra(ctx, key, req) {
  const kind =
    typeof key === 'string' && key.includes(':') ? key.slice(0, key.indexOf(':')) : key;
  if (kind === 'system') {
    // The journal is a section of the SING-BOX tab, so only that tab pays for a
    // `journalctl` call; the other tabs render without touching the host.
    const tab =
      typeof key === 'string' && key.includes(':') ? key.slice(key.indexOf(':') + 1) : 'singbox';
    return tab === 'singbox' ? {journal: await journalSnapshot(ctx, req)} : {};
  }
  if (kind === 'tunnel') {
    // The preview reads a file, so it is built here, in the route, and handed
    // to the panel builder, which stays pure. A key without `provider/file`
    // (or an unreadable file) leaves the panel with no preview at all.
    const reference = key.slice(key.indexOf(':') + 1);
    const slash = reference.indexOf('/');
    if (slash <= 0) return {};
    try {
      return {
        tunnel: ctx.model.tunnelPreview(reference.slice(0, slash), reference.slice(slash + 1)),
      };
    } catch {
      return {};
    }
  }
  return {};
}

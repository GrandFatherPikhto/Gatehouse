// Applying one edit form to the model, and answering a mutation.
//
// A panel may have more than one route, and its button applies the WHOLE panel,
// so the routes are applied in order and a refusal anywhere rolls the model back
// to the exact bytes it had. `panel.mjs` decides which panels have such a form at
// all; the action buttons (`/proxy/remove`, `/generate`, …) never go through
// here, because a wrong entry in that list would make the save button fire a
// delete request.

import {ConfigError} from '../core/errors.mjs';
import {SystemError} from '../system/index.mjs';
import * as forms from './forms.mjs';
import {editFormRoutes, panelKey, panelUrl} from './panel.mjs';
import {resolvePanel, renderFragment} from './view.mjs';

/**
 * Field names that mark a body as carrying one edit-form route. A route whose
 * fields are all absent is left alone, so a direct POST of a single route stays a
 * partial edit of a panel whose edit form has several routes instead of being
 * refused over a missing sibling field.
 */
const ROUTE_FIELDS = Object.freeze({
  '/proxy': ['tag', 'type', 'port'],
  '/route': ['name', 'outbound'],
  '/provider': ['id'],
  '/dns': ['dns'],
  '/output': ['output_file'],
  '/general': [
    'listen_ip',
    'urltest_url',
    'urltest_interval',
    'urltest_tolerance',
    'log_level',
    'exclude_from_auto',
  ],
});

/**
 * Answers a mutation. `action` returns the panel to show and the notices. It may
 * be async: the system calls (check, restart) are promises, and the SSE routes
 * are the only ones that answer without going through here.
 *
 * @param {ReturnType<import('./context.mjs').buildContext>} ctx
 * @param {string|((req: import('express').Request) => string)} defaultKey A
 *   string, or a function so a route that learns its panel from the request
 *   (the `/save` button) still renders the right panel after a rejection.
 * @param {(req: import('express').Request) => Record<string, unknown>|Promise<Record<string, unknown>>} action
 * @returns {import('express').RequestHandler}
 */
export function mutation(ctx, defaultKey, action) {
  return async (req, res) => {
    const fallbackKey = typeof defaultKey === 'function' ? defaultKey(req) : defaultKey;
    let extra;
    try {
      extra = (await action(req)) ?? {};
    } catch (error) {
      if (!(error instanceof ConfigError) && !(error instanceof SystemError)) throw error;
      // A rejection keeps the entered values, so the owner does not retype a
      // form because of one bad port number. A failed system call is reported
      // the same way: a plain sentence, never a stack trace.
      extra = {error: error.message, form: req.body, key: fallbackKey};
    }
    const key = typeof extra.key === 'string' && extra.key.length > 0 ? extra.key : fallbackKey;
    if (!req.get('HX-Request')) {
      // No htmx (JavaScript off, bundle missing): answer with a plain redirect
      // so the tool works anyway.
      res.redirect(303, panelUrl(resolvePanel(ctx, key, extra).key));
      return;
    }
    renderFragment(ctx, res, key, extra);
  };
}

/**
 * Reads the panel a form belongs to, so saving from the header returns the
 * owner to the panel they were looking at. The bound «Сохранить» button carries
 * the panel in the query string (its `form="panel-form"` association would drop
 * any hidden field of the header form), so the query is checked first.
 *
 * @param {import('express').Request} req
 * @param {string} fallback
 * @returns {string}
 */
export function panelFromBody(req, fallback) {
  const value = req.query?.panel ?? req.body?.panel;
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * Applies exactly one edit-form route to the live model and reports the panel
 * key the result belongs to.
 *
 * `applied` is false when the body carries none of the fields of the route.
 * That is how a direct POST of a single route stays a partial edit of a panel
 * whose edit form has more than one route, instead of being refused because a
 * field of a sibling route is missing.
 *
 * @param {ReturnType<import('./context.mjs').buildContext>} ctx
 * @param {string} route One of the routes a form posts to (`/proxy`, `/dns`, …).
 * @param {import('express').Request} req
 * @returns {{applied: boolean, key: string|null}}
 */
export function applyRoute(ctx, route, req) {
  const model = ctx.model;
  const body = req.body ?? {};
  const fields = ROUTE_FIELDS[route] ?? [];
  if (!fields.some((field) => Object.hasOwn(body, field))) {
    return {applied: false, key: null};
  }

  switch (route) {
    case '/proxy': {
      const current = String(body.current ?? '').trim();
      const candidate = forms.parseProxyForm(body);
      model.upsertProxy(candidate, current.length > 0 ? current : null);
      return {applied: true, key: panelKey('proxy', candidate.tag)};
    }
    case '/route': {
      const current = String(body.current ?? '').trim();
      const candidate = forms.parseRouteForm(body);
      model.upsertRoute(candidate.name, candidate, current.length > 0 ? current : null);
      return {applied: true, key: panelKey('route', candidate.name)};
    }
    case '/provider': {
      const id = String(body.id ?? '').trim();
      model.setProviderLabel(id, String(body.label ?? ''));
      model.setProviderEnabled(id, forms.checkbox(body.enabled));
      return {applied: true, key: panelKey('provider', id)};
    }
    case '/dns':
      model.applyDns(String(body.dns ?? ''));
      return {applied: true, key: 'dns'};
    case '/output':
      model.setOutputFile(String(body.output_file ?? '').trim());
      return {applied: true, key: 'output'};
    case '/general': {
      model.applyGeneral(forms.parseGeneralForm(body));
      return {applied: true, key: 'general'};
    }
    default:
      throw new ConfigError(`маршрут '${route}' не является формой правки`);
  }
}

/**
 * Applies the edit form of one panel to the model, atomically.
 *
 * Shared by the panel's own route and by `/save`: that is the whole point of the
 * fix, because if the two ever drifted the save button would silently behave
 * differently from «Применить» again.
 *
 * A canonical snapshot is taken before the first route: if any route refuses, the
 * model is put back exactly as it was, so the owner never gets a panel that is
 * applied halfway while the notice only reports the refusal. The file is not
 * touched here at all — `/save` writes it, and only after a successful apply.
 *
 * Returns `changed`, computed from the canonical text of the document, so
 * `/save` can tell "the form really did something" from "the values were already
 * like that" and skip a pointless write and snapshot.
 *
 * @param {ReturnType<import('./context.mjs').buildContext>} ctx
 * @param {string} kind Panel kind (`proxy`, `route`, `dns`, `general`, …).
 * @param {import('express').Request} req
 * @returns {{key: string, changed: boolean}}
 */
export function applyEditForm(ctx, kind, req) {
  const model = ctx.model;
  const routeNames = editFormRoutes(kind);
  if (routeNames.length === 0) throw new ConfigError(`у панели '${kind}' нет формы правки`);

  const before = model.toText();
  const wasDirty = model.dirty;
  // A merged panel (several routes, one page) keeps its own key: the routes
  // name sections, not destinations, and returning `output` would send the
  // owner to a panel that no longer exists.
  const merged = routeNames.length > 1;
  let key = kind;

  try {
    for (const route of routeNames) {
      const outcome = applyRoute(ctx, route, req);
      if (!merged && outcome.applied && outcome.key !== null) key = outcome.key;
    }
  } catch (error) {
    model.restoreText(before);
    if (wasDirty) model.markDirty();
    else model.markClean();
    throw error;
  }

  return {key, changed: model.toText() !== before};
}

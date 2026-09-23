// File operations: saving the document and re-reading it.

import path from 'node:path';

import {applyEditForm, mutation, panelFromBody} from '../edits.mjs';
import {DEFAULT_PANEL} from '../view.mjs';
import {editFormRoutes, parsePanelKey} from '../panel.mjs';

/**
 * @param {import('express').Express} app
 * @param {ReturnType<import('../context.mjs').buildContext>} ctx
 */
export function registerFileRoutes(app, ctx) {
  const {model} = ctx;

  app.post(
    '/save',
    mutation(
      ctx,
      (req) => panelFromBody(req, DEFAULT_PANEL),
      (req) => {
        const key = panelFromBody(req, DEFAULT_PANEL);
        const {kind} = parsePanelKey(key);
        const hadEdits = model.dirty;

        // The header button carries the fields of the open edit form (htmx
        // hx-include / the form="" attribute with JavaScript off). Apply them with
        // the very same function the panel's own route uses, so "edit → Сохранить"
        // can never behave differently from "edit → Применить → Сохранить".
        //
        // A body that carries nothing but the panel key is a plain "save what the
        // model holds" — there is no form to apply, and parsing an empty one would
        // fail for no reason.
        const hasFormFields = Object.keys(req.body ?? {}).some((field) => field !== 'panel');
        let changed = false;
        if (editFormRoutes(kind).length > 0 && hasFormFields) {
          changed = applyEditForm(ctx, kind, req).changed;
        }

        // Applying identical values is not an error, but it must not look like a
        // save either: no write and, above all, no snapshot for an edit that
        // changed nothing. `applyEditForm` always marks the model dirty, so the
        // "nothing happened" case is undone here.
        if (!changed && !hadEdits) model.markClean();
        if (!model.dirty) {
          return {key, notice: 'Нечего сохранять: неприменённых правок нет'};
        }

        const {snapshot} = model.save();
        const base = changed ? 'Правка формы применена и сохранена' : 'Сохранено';
        return {
          key,
          notice: snapshot === null ? base : `${base}, предыдущая версия: ${path.basename(snapshot)}`,
        };
      },
    ),
  );

  app.post(
    '/reload',
    mutation(ctx, DEFAULT_PANEL, (req) => {
      model.reload();
      return {key: panelFromBody(req, DEFAULT_PANEL), notice: 'Файл перечитан, правки отброшены'};
    }),
  );
}

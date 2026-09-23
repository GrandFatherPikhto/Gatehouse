// Routes: the CRUD and the renaming of `routes` in the document.
//
// Reference: the route CRUD of generator/model.py. The map is rebuilt in place
// on a rename so the order of the other routes does not move — the byte order of
// `webui.json` is part of the tool's behaviour, not an accident.

import {ConfigError, isMapping} from '../../core/errors.mjs';
import {asList} from '../../core/validate.mjs';
import {DEFAULT_ROUTE_NAME, assertUsableName} from './document.mjs';

/**
 * The document's `routes` map, created when it is missing.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @returns {Record<string, unknown>}
 */
export function ensureRoutes(model) {
  if (!isMapping(model.document.routes)) model.document.routes = {};
  return model.document.routes;
}

/** Reference: `routes()`. */
export function routes(model) {
  const value = model.document.routes;
  return isMapping(value) ? value : {};
}

/** Reference: `route_names`. */
export function routeNames(model) {
  return Object.keys(routes(model));
}

/** Reference: `get_route`. */
export function getRoute(model, name) {
  return routes(model)[name] ?? null;
}

/** Reference: `next_free_route_name`. */
export function nextFreeRouteName(model, base = DEFAULT_ROUTE_NAME) {
  const names = new Set(routeNames(model));
  if (!names.has(base)) return base;
  let n = 2;
  while (names.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/**
 * Reference: `add_route`.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {{name?: string, outbound?: string, domains?: unknown, note?: string}} [candidate]
 * @returns {{name: string, entry: Record<string, unknown>}}
 */
export function addRoute(model, candidate = {}) {
  const name = candidate.name ?? nextFreeRouteName(model);
  assertUsableName(name, 'маршрута');
  const map = ensureRoutes(model);
  if (Object.hasOwn(map, name)) {
    throw new ConfigError(`маршрут '${name}' уже есть`);
  }
  const entry = routeEntry(candidate);
  map[name] = entry;
  model.markDirty();
  return {name, entry};
}

/**
 * Replaces (or renames) a route. Reference: `upsert_route` — the map is
 * rebuilt in place so the order of the other routes does not move.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {string} name
 * @param {{outbound?: string, domains?: unknown, note?: string}} data
 * @param {string|null} [currentName]
 * @returns {{name: string, entry: Record<string, unknown>}}
 */
export function upsertRoute(model, name, data = {}, currentName = null) {
  assertUsableName(name, 'маршрута');
  const map = ensureRoutes(model);
  const entry = routeEntry(data);

  if (currentName !== null && Object.hasOwn(map, currentName)) {
    if (name !== currentName && Object.hasOwn(map, name)) {
      throw new ConfigError(`маршрут '${name}' уже есть`);
    }
    const rebuilt = {};
    for (const [key, value] of Object.entries(map)) {
      rebuilt[key === currentName ? name : key] = key === currentName ? entry : value;
    }
    model.document.routes = rebuilt;
    model.markDirty();
    return {name, entry};
  }

  map[name] = entry;
  model.markDirty();
  return {name, entry};
}

/**
 * Reference: `remove_route`.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {string} name
 * @returns {boolean}
 */
export function removeRoute(model, name) {
  const map = ensureRoutes(model);
  if (!Object.hasOwn(map, name)) return false;
  delete map[name];
  model.markDirty();
  return true;
}

/**
 * Reference: `rename_route`.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {string} oldName
 * @param {string} newName
 * @returns {boolean}
 */
export function renameRoute(model, oldName, newName) {
  assertUsableName(newName, 'маршрута');
  const map = ensureRoutes(model);
  if (oldName === newName) return false;
  if (!Object.hasOwn(map, oldName)) {
    throw new ConfigError(`маршрут '${oldName}' не найден`);
  }
  if (Object.hasOwn(map, newName)) {
    throw new ConfigError(`маршрут '${newName}' уже есть`);
  }

  const rebuilt = {};
  for (const [key, value] of Object.entries(map)) {
    rebuilt[key === oldName ? newName : key] = value;
  }
  model.document.routes = rebuilt;
  model.markDirty();
  return true;
}

/**
 * Reference: `upsert_route` — `domains` is written only when non-empty, so an
 * empty form field does not add `"domains": []` to the file.
 *
 * @param {{outbound?: unknown, domains?: unknown, note?: unknown}} data
 * @returns {Record<string, unknown>}
 */
export function routeEntry(data) {
  const entry = {
    outbound:
      typeof data.outbound === 'string' && data.outbound.length > 0
        ? data.outbound
        : 'auto-select',
  };
  const domains = asList(data.domains).filter(
    (domain) => typeof domain === 'string' && domain.length > 0,
  );
  if (domains.length > 0) entry.domains = domains;
  if (typeof data.note === 'string' && data.note.length > 0) entry.note = data.note;
  return entry;
}

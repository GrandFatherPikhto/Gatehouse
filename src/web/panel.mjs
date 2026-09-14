// View models of the panels: everything the EJS templates need, and nothing
// else.
//
// The route handlers of `app.mjs` only parse a request, call the model and hand
// the result to this module; the templates only read the plain objects built
// here. That split is what keeps the view layer replaceable: swapping EJS for
// React means reimplementing these builders and the templates, not the model.

import {ConfigError, DEFAULT_EXCLUDE, PROXY_TYPES} from '../core/errors.mjs';
import {listConfigSnapshots} from '../model/storage.mjs';

/** Keys of the tree, without a name part. */
export const PANEL_KINDS = Object.freeze([
  'profiles',
  'general',
  'defaults',
  'links',
  'output',
  'proxies',
  'routes',
  'dns',
  'proxy',
  'route',
  'system',
  'journal',
  'tests',
]);

/** Outbounds that exist in every generated config. */
export const BUILTIN_OUTBOUNDS = Object.freeze(['auto-select', 'direct']);

/**
 * Builds a tree key for a panel. The name is glued with a colon; tags and route
 * names of the owner look like `🇨🇾 Cyprus - Limassol`, so anything that could
 * clash with a separator is a bad idea and a colon is already unusual there.
 *
 * @param {string} kind
 * @param {string|null} [name]
 * @returns {string}
 */
export function panelKey(kind, name = null) {
  return name === null ? kind : `${kind}:${name}`;
}

/**
 * Splits a tree key back into kind and name. Only the FIRST colon separates, so
 * a name may contain colons.
 *
 * @param {string} key
 * @returns {{kind: string, name: string|null}}
 */
export function parsePanelKey(key) {
  const text = typeof key === 'string' && key.length > 0 ? key : 'profiles';
  const index = text.indexOf(':');
  const kind = index < 0 ? text : text.slice(0, index);
  const name = index < 0 ? null : text.slice(index + 1);

  if (!PANEL_KINDS.includes(kind)) {
    throw new ConfigError(`неизвестный раздел '${kind}'`);
  }
  if (kind === 'proxy' || kind === 'route') {
    if (name === null || name.length === 0) {
      throw new ConfigError(`раздел '${kind}' требует имя`);
    }
  }
  return {kind, name};
}

/**
 * URL of a panel, used for htmx links and for the `HX-Push-Url` header so the
 * address bar keeps pointing at what is on screen.
 *
 * @param {string} key
 * @returns {string}
 */
export function panelUrl(key) {
  return `/panel/${encodeURIComponent(key)}`;
}

/**
 * Human readable origin of a shared field, for the badge next to it. Without the
 * badge the inheritance is a trap: editing `defaults` would change nothing
 * visible while the profile keeps overriding it.
 *
 * @param {'profile'|'defaults'|'absent'} scope
 * @returns {{text: string, className: string}}
 */
export function originLabel(scope) {
  switch (scope) {
    case 'profile':
      return {text: 'задано в профиле', className: 'origin-profile'};
    case 'defaults':
      return {text: 'унаследовано из defaults', className: 'origin-defaults'};
    default:
      return {text: 'не задано', className: 'origin-absent'};
  }
}

/**
 * Outbounds a route may name: the servers of the links file, the two built-ins
 * and the per-proxy pools.
 *
 * @param {import('../model/project.mjs').ProjectModel} model
 * @returns {string[]}
 */
export function knownOutbounds(model) {
  const tags = model.linksInfo().tags;
  const pools = model.proxyTags().map((tag) => `pool-${tag}`);
  return [...BUILTIN_OUTBOUNDS, ...tags, ...pools];
}

/**
 * Prefixes kept out of `auto-select`, with the rule of the core: an ABSENT
 * `exclude_from_auto` falls back to `DEFAULT_EXCLUDE`, while an explicitly empty
 * list really excludes nothing. The picker of a proxy marks every server with
 * this answer, so the decision "add this one to the pool" is taken here, where it
 * is made, and not in the general settings panel.
 *
 * @param {import('../model/project.mjs').ProjectModel} model
 * @returns {string[]}
 */
export function autoExcludePrefixes(model) {
  if (model.fieldOrigin('exclude_from_auto').scope === 'absent') return [...DEFAULT_EXCLUDE];
  return model.generalValues().exclude_from_auto;
}

/**
 * Builds the view model of one panel.
 *
 * @param {import('../model/project.mjs').ProjectModel} model
 * @param {string} key
 * @param {{error?: string|null, notice?: string|null, form?: Record<string, unknown>,
 *   generation?: Record<string, unknown>|null}} [extra] Values of a rejected
 *   form, a notice, or the outcome of a generation run.
 * @returns {Record<string, unknown>}
 */
export function buildPanel(model, key, extra = {}) {
  const {kind, name} = parsePanelKey(key);
  const base = {
    key,
    kind,
    name,
    error: extra.error ?? null,
    notice: extra.notice ?? null,
    form: extra.form ?? null,
  };
  // Runtime state of the host layer, handed in by `app.mjs`: the outcome of the
  // last check/restart and the name of the unit. The panel never runs a command
  // itself — routes do that, this module only arranges what they return.
  const system = extra.system ?? {};

  switch (kind) {
    case 'profiles':
      return {
        ...base,
        title: 'Профили',
        names: model.profileNames(),
        active: model.activeProfileName(),
        note: model.profileBody().note ?? '',
      };

    case 'general': {
      const values = model.generalValues();
      return {
        ...base,
        title: 'Общие (активный профиль)',
        values,
        origins: {
          listen_ip: originLabel(values.origins.listen_ip),
          urltest: originLabel(values.origins.urltest),
          log: originLabel(values.origins.log),
          exclude_from_auto: originLabel(values.origins.exclude_from_auto),
        },
        scope: 'profile',
      };
    }

    case 'defaults': {
      const values = model.defaultsValues();
      return {
        ...base,
        title: 'Значения по умолчанию (defaults)',
        values,
        defaultsDns: model.dnsJson('defaults'),
        scope: 'defaults',
      };
    }

    case 'links':
      return {...base, title: 'Файл ссылок', info: model.linksInfo()};

    case 'output':
      return {
        ...base,
        title: 'Вывод',
        outputFile: model.outputFile,
        resolvedOutput: model.resolvedOutputPath(),
        generation: extra.generation ?? null,
      };

    case 'dns': {
      const origin = model.fieldOrigin('dns');
      return {
        ...base,
        title: 'DNS',
        scope: 'profile',
        json: model.dnsJson('profile'),
        origin: originLabel(origin.scope),
      };
    }

    case 'proxies':
      return {...base, title: 'Прокси', tags: model.proxyTags()};

    case 'routes':
      return {...base, title: 'Маршруты', names: model.routeNames()};

    case 'proxy': {
      const proxy = model.getProxy(name);
      if (proxy === null) throw new ConfigError(`прокси '${name}' не найден`);
      const info = model.linksInfo();
      return {
        ...base,
        title: `Прокси: ${name}`,
        proxy,
        tags: info.tags,
        autoPrefixes: autoExcludePrefixes(model),
        linksError: info.error,
        types: PROXY_TYPES,
      };
    }

    case 'route': {
      const route = model.getRoute(name);
      if (route === null) throw new ConfigError(`маршрут '${name}' не найден`);
      return {
        ...base,
        title: `Маршрут: ${name}`,
        route,
        outbounds: knownOutbounds(model),
      };
    }

    case 'system': {
      const lastCheck = system.lastCheck ?? null;
      return {
        ...base,
        title: 'Система',
        configPath: model.resolvedOutputPath(),
        configExists: model.configExists(),
        // Only the NAMES are exposed to the view: a snapshot is restored by the
        // route from the state directory, never by a path arriving from a form.
        snapshots: listConfigSnapshots(model.stateDir).map((file) => ({file})),
        lastCheck,
        lastRestart: system.lastRestart ?? null,
        // The restart is offered ONLY after a successful check of the file that
        // is on disk right now. `sing-box check` proves far less than "the config
        // is correct" (it skips a duplicate listen_port, an unknown outbound tag
        // and a typo in dns.final), so the wording around it says «схема принята».
        canRestart: Boolean(lastCheck && lastCheck.ok),
        checkedOk: lastCheck === null ? null : Boolean(lastCheck.ok),
        unit: system.unit ?? 'sing-box',
        tokenRequired: Boolean(extra.auth?.tokenRequired),
      };
    }

    case 'journal':
      return {
        ...base,
        title: 'Журнал sing-box',
        unit: system.unit ?? 'sing-box',
        lines: system.journalLines ?? 50,
      };

    case 'tests': {
      const info = model.linksInfo();
      return {
        ...base,
        title: 'Тест серверов',
        tags: info.tags,
        linksError: info.error,
        concurrency: system.testConcurrency ?? 4,
        configPath: model.resolvedOutputPath(),
      };
    }

    default:
      throw new ConfigError(`неизвестный раздел '${kind}'`);
  }
}

/**
 * What the header shows: the file, its path and whether it has unsaved changes.
 *
 * @param {import('../model/project.mjs').ProjectModel} model
 * @returns {Record<string, unknown>}
 */
export function buildStatus(model) {
  return {
    name: model.displayName,
    path: model.path,
    exists: model.fileExists,
    dirty: model.dirty,
    snapshotKeep: model.snapshotKeep,
    active: model.activeProfileName(),
  };
}

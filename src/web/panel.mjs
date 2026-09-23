// View models of the panels: everything the EJS templates need, and nothing
// else.
//
// The route handlers of `app.mjs` only parse a request, call the model and hand
// the result to this module; the templates only read the plain objects built
// here. That split is what keeps the view layer replaceable: swapping EJS for
// React means reimplementing these builders and the templates, not the model.

import {ConfigError, DEFAULT_EXCLUDE, PROXY_TYPES, isMapping} from '../core/errors.mjs';
import {listConfigSnapshots} from '../model/storage.mjs';
import {DEFAULT_WATCH_URL} from '../system/index.mjs';

/** Keys of the tree, without a name part. */
export const PANEL_KINDS = Object.freeze([
  'singbox',
  'amnezia',
  'providers',
  'proxies',
  'routes',
  'proxy',
  'route',
  'provider',
  'tunnel',
  'system',
]);

/**
 * Tabs of the «Система» panel. The tab is carried by the panel KEY
 * (`system:singbox`), so a tab is a real address: it can be bookmarked, and with
 * JavaScript off it is simply a link.
 */
export const SYSTEM_TABS = Object.freeze(['singbox', 'amnezia', 'watchdog']);

/** Outbounds that exist in every generated config. */
export const BUILTIN_OUTBOUNDS = Object.freeze(['auto-select', 'direct']);

/**
 * Routes of the edit form of a panel, in application order. A panel has ONE form
 * element (`id="panel-form"`) and every «Применить» button on the panel sends it
 * whole, so a panel may legitimately have several routes.
 *
 * An empty list means the panel has no edit form at all; its «Сохранить» keeps the
 * standalone behaviour. The list is deliberately explicit: the action buttons
 * (`/proxy/remove`, `/generate`, `/watchdog/check` …) are never listed, because a
 * wrong entry here would make the save button fire a delete request.
 */
const EDIT_FORMS = Object.freeze({
  proxy: ['/proxy'],
  route: ['/route'],
  // One panel, three sections: the form of «Настройки Sing-Box» applies them in
  // this order, and a refusal anywhere rolls the whole panel back.
  singbox: ['/general', '/dns', '/output'],
  amnezia: ['/amnezia'],
  // The watchdog settings are the only edit form of the «Система» panel: it is
  // applied on its tab, and `buildPanel` reports `editForm: false` on the others
  // so the header button never binds to a form that is not on the page.
  system: ['/watchdog'],
});

/**
 * Routes of the edit form of a panel kind, in application order. An empty array
 * means the panel has no edit form.
 *
 * @param {string} kind
 * @returns {string[]}
 */
export function editFormRoutes(kind) {
  return EDIT_FORMS[kind] ?? [];
}

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
  const text = typeof key === 'string' && key.length > 0 ? key : 'general';
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
 * Outbounds a route may name: the servers of the links file, the two built-ins,
 * the per-proxy pools and the `direct` outbound of every tunnel.
 *
 * A tunnel proxy has no pool — its outbound is the proxy tag itself — so it is
 * listed as a bare tag and never as `pool-<tag>`.
 *
 * @param {import('../model/project.mjs').ProjectModel} model
 * @returns {string[]}
 */
export function knownOutbounds(model) {
  const tags = model.sourcesInfo().tags;
  const proxies = model.proxies().filter((proxy) => isMapping(proxy));
  const pools = proxies
    .filter((proxy) => !isMapping(proxy.tunnel))
    .map((proxy) => `pool-${proxy.tag}`);
  const tunnelTags = proxies
    .filter((proxy) => isMapping(proxy.tunnel))
    .map((proxy) => proxy.tag);
  return [...BUILTIN_OUTBOUNDS, ...tags, ...pools, ...tunnelTags];
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
  if (!Object.hasOwn(model.body(), 'exclude_from_auto')) return [...DEFAULT_EXCLUDE];
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
    // The header's «Сохранить» binds to the panel's form so an unapplied edit
    // survives the save. `false` means the panel has no edit form and the button
    // keeps its standalone behaviour.
    editForm: editFormRoutes(kind).length > 0,
  };
  // Runtime state of the host layer, handed in by `app.mjs`: the outcome of the
  // last check/restart and the name of the unit. The panel never runs a command
  // itself — routes do that, this module only arranges what they return.
  const system = extra.system ?? {};

  switch (kind) {
    case 'singbox':
      return {
        ...base,
        title: 'Настройки Sing-Box',
        values: model.generalValues(),
        // The checkbox list of «исключить из автовыбора»: the flags really present
        // among the loaded servers plus the stored ones that match nothing now.
        exclude: model.excludePrefixOptions(),
        json: model.dnsJson(),
        outputFile: model.outputFile,
        resolvedOutput: model.resolvedOutputPath(),
        generation: extra.generation ?? null,
        // Name of the snapshot taken before this generation, if any.
        snapshot: extra.snapshot ?? null,
      };

    case 'amnezia':
      return {
        ...base,
        title: 'Настройки Amnezia',
        dir: model.amneziaDirInfo(),
        tunnels: model.amneziaRows(),
        regeneration: extra.regeneration ?? null,
      };

    case 'providers':
      return {
        ...base,
        title: 'Провайдеры',
        info: model.sourcesInfo(),
        // Folders that exist under the root but are not listed yet: the "add"
        // control offers them, so a folder name is picked, never typed.
        available: model.availableSources(),
      };

    case 'provider': {
      const info = model.sourcesInfo();
      const provider = info.providers.find((item) => item.name === name) ?? null;
      if (provider === null) throw new ConfigError(`источник '${name}' не подключён`);
      return {
        ...base,
        title: `Источник: ${name}`,
        provider,
        // One row per `.conf`: the «включить» mark and the two editable names.
        tunnelRows: model.providerTunnelRows(name),
      };
    }

    case 'proxies':
      return {...base, title: 'Прокси', tags: model.proxyTags()};

    case 'routes':
      return {...base, title: 'Маршруты', names: model.routeNames()};

    case 'proxy': {
      const proxy = model.getProxy(name);
      if (proxy === null) throw new ConfigError(`прокси '${name}' не найден`);
      const info = model.sourcesInfo();
      return {
        ...base,
        title: `Прокси: ${name}`,
        proxy,
        tags: info.tags,
        autoPrefixes: autoExcludePrefixes(model),
        linksError: info.error,
        types: PROXY_TYPES,
        defaultWatchUrl: DEFAULT_WATCH_URL,
        // Tunnels the form may bind this proxy to (§5.1). Empty when no provider
        // folder holds a `*.conf`, and then the selector is not drawn at all.
        tunnels: model.availableTunnels(),
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
      // The tab comes from the panel KEY; an unknown or absent one means the first
      // tab, so `/panel/system` and a stale bookmark never render nothing.
      const tab = SYSTEM_TABS.includes(name) ? name : SYSTEM_TABS[0];
      const info = model.sourcesInfo();
      // Runtime state comes from the Watchdog object, handed in by `app.mjs` as
      // `extra.watchdog`: the panels arrange what it already did and never step a
      // check themselves.
      const watchdogState = extra.watchdog ?? {
        running: false,
        lastRun: null,
        restartsLastDay: 0,
        history: [],
        proxies: [],
      };

      // ONE panel object carries the fields of every tab: each tab is a partial
      // included by the container, and all of them read from here.
      return {
        ...base,
        title: 'Система',
        tab,
        tabs: SYSTEM_TABS.map((item) => ({
          name: item,
          title: item === 'singbox' ? 'Sing-box' : item === 'amnezia' ? 'Amnezia' : 'Сторож',
          key: panelKey('system', item),
        })),
        // The watchdog settings are the only edit form, and they live on their own
        // tab: elsewhere there is no `id="panel-form"` for the header to bind to.
        editForm: tab === 'watchdog',

        // --- Sing-box: check, restart, rollback, journal, server test ---
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
        // Journal. The snapshot is fetched by the ROUTE and handed in as
        // `extra.journal`; this builder only arranges what it was given.
        lines: system.journalLines ?? 200,
        level: system.journalLevel ?? 'info',
        levels: system.journalLevels ?? [],
        snapshot: extra.journal ?? null,
        // Server test.
        tags: info.tags,
        linksError: info.error,
        concurrency: system.testConcurrency ?? 4,

        // --- Amnezia: one row per tunnel, grouped by provider, with the runtime
        // state read from systemd and the sudoers rights. The app assembles it. ---
        tunnels: extra.tunnels ?? [],

        // --- Watchdog ---
        config: model.watchdogValues(),
        api: model.clashApiValues(),
        // The secret itself never travels: only whether the environment carries it.
        secretPresent: Boolean(extra.auth?.apiSecretPresent),
        defaultWatchUrl: DEFAULT_WATCH_URL,
        listenIp: model.listenIp,
        state: watchdogState,
      };
    }

    case 'tunnel':
      // The preview is computed by the ROUTE (it reads a file) and handed in as
      // `extra.tunnel`. Without it the panel only says where to pick a tunnel.
      return {
        ...base,
        title: name === null ? 'Нормализация туннеля' : `Туннель: ${name}`,
        preview: extra.tunnel ?? null,
      };

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
  };
}

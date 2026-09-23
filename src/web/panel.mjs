// View models of the panels: everything the EJS templates need, and nothing
// else.
//
// The route handlers of `app.mjs` only parse a request, call the model and hand
// the result to this module; the templates only read the plain objects built
// here. That split is what keeps the view layer replaceable: swapping EJS for
// React means reimplementing these builders and the templates, not the model.

import {ConfigError, DEFAULT_EXCLUDE, PROXY_TYPES, isMapping} from '../core/errors.mjs';
import {listConfigSnapshots} from '../model/storage.mjs';

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
 * Children of the «Система» group. A child is carried by the panel KEY
 * (`system:singbox`), so it is a real address: it can be bookmarked, and with
 * JavaScript off it is simply a link in the tree. The list also names the child
 * whose content an unknown or absent key falls back to.
 */
export const SYSTEM_TABS = Object.freeze(['singbox', 'amnezia']);

/** Outbounds that exist in every generated config. */
export const BUILTIN_OUTBOUNDS = Object.freeze(['auto-select', 'direct']);

/**
 * Human name of a source kind, for the Providers panel and the tree: what the
 * origin FEEDS, not what it holds. `mixed` only ever comes from a legacy folder
 * that carries `links.txt` and `*.conf` together.
 *
 * @param {unknown} kind
 * @returns {string}
 */
export function providerKindLabel(kind) {
  switch (kind) {
    case 'links':
      return 'Sing-Box';
    case 'tunnels':
      return 'Amnezia';
    case 'mixed':
      return 'Sing-Box + Amnezia';
    default:
      return '—';
  }
}

/**
 * Human word for a provider that could NOT be read, for the «Не прочиталось»
 * list. The state, not the number, decides the word.
 *
 * @param {unknown} state
 * @returns {string}
 */
export function unreadStateLabel(state) {
  switch (state) {
    case 'stray':
      return 'файл вне папки провайдера';
    case 'badname':
      return 'имя папки не подходит';
    case 'denied':
      return 'нет доступа';
    case 'unreadable':
      return 'не читается';
    case 'empty':
      return 'пусто';
    case 'missing':
      return 'папки нет';
    default:
      return 'не читается';
  }
}

/**
 * Routes of the edit form of a panel, in application order. A panel has ONE form
 * element (`id="panel-form"`) and every «Применить» button on the panel sends it
 * whole, so a panel may legitimately have several routes.
 *
 * An empty list means the panel has no edit form at all; its «Сохранить» keeps the
 * standalone behaviour. The list is deliberately explicit: the action buttons
 * (`/proxy/remove`, `/generate`, `/tunnel/toggle` …) are never listed, because a
 * wrong entry here would make the save button fire a delete request.
 */
const EDIT_FORMS = Object.freeze({
  proxy: ['/proxy'],
  route: ['/route'],
  // One panel, one form: the human-readable name and the «включён» flag of a
  // provider, saved like any other setting. The `.conf` rows keep their own
  // `/tunnels` action buttons and are deliberately NOT part of the edit form.
  provider: ['/provider'],
  // One panel, three sections: the form of «Настройки Sing-Box» applies them in
  // this order, and a refusal anywhere rolls the whole panel back.
  singbox: ['/general', '/dns', '/output'],
  // «Настройки Amnezia» has no editable field any more: the tunnel directory is a
  // constant of the build, shown read-only. The panel therefore has no edit form
  // and its «Сохранить» keeps the standalone behaviour; regeneration has its own
  // button.
  amnezia: [],
  // «Система» has NO edit form any more: the watchdog settings were its only one,
  // and they left the project together with the watchdog. Its two tabs are
  // read-only, so `buildPanel` reports `editForm: false` for the whole panel.
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
  const tags = model.providersInfo().tags;
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

    case 'providers': {
      const info = model.providersInfo();
      return {
        ...base,
        title: 'Провайдеры',
        // The kind label is a presentation decision, added here and not in the
        // model: the reader reports `links`/`tunnels`, the panel says what they
        // feed (Sing-Box / Amnezia). The display name is the human-readable label
        // when there is one, the folder name otherwise.
        info: {
          ...info,
          providers: info.providers.map((provider) => ({
            ...provider,
            displayName:
              typeof provider.label === 'string' && provider.label.length > 0
                ? provider.label
                : provider.id,
            kindLabel: providerKindLabel(provider.kind),
          })),
          unread: info.unread.map((entry) => ({
            ...entry,
            displayName:
              typeof entry.label === 'string' && entry.label.length > 0
                ? entry.label
                : entry.id,
            stateLabel: unreadStateLabel(entry.state),
          })),
        },
      };
    }

    case 'provider': {
      const info = model.providersInfo();
      const provider = info.providers.find((item) => item.id === name) ?? null;
      if (provider === null) throw new ConfigError(`провайдер '${name}' не найден`);
      const label =
        typeof provider.label === 'string' && provider.label.length > 0 ? provider.label : name;
      return {
        ...base,
        title: `Провайдер: ${label}`,
        provider,
        providerId: String(provider.id),
        displayName: label,
        enabled: provider.enabled === true,
        // What the origin FEEDS: Sing-Box for a links file, Amnezia for a tunnel
        // directory. It is a label of the panel, not of the folder.
        kindLabel: providerKindLabel(provider.kind),
        // One row per `.conf`: the «включить» mark and the two editable names.
        // Only an ENABLED provider offers them — a disabled one says so instead.
        tunnelRows: provider.enabled === true ? model.providerTunnelRows(name) : [],
      };
    }

    case 'proxies':
      return {...base, title: 'Прокси', tags: model.proxyTags()};

    case 'routes':
      return {...base, title: 'Маршруты Sing-Box', names: model.routeNames()};

    case 'proxy': {
      const proxy = model.getProxy(name);
      if (proxy === null) throw new ConfigError(`прокси '${name}' не найден`);
      const info = model.providersInfo();
      return {
        ...base,
        title: `Прокси: ${name}`,
        proxy,
        tags: info.tags,
        autoPrefixes: autoExcludePrefixes(model),
        linksError: info.error,
        types: PROXY_TYPES,
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
      // The child comes from the panel KEY; an unknown or absent one means the
      // first child, so `/panel/system` and a stale bookmark never render nothing.
      const tab = SYSTEM_TABS.includes(name) ? name : SYSTEM_TABS[0];
      const info = model.providersInfo();

      // ONE panel object carries the fields of both children: each child is a
      // partial included by the container, and both read from here. The tree draws
      // the two children as nodes of the «Система» group; the panel itself has no
      // tab strip any more.
      return {
        ...base,
        title: 'Система',
        tab,
        // Neither child carries an edit form — both were read-only before, and the
        // watchdog form went away with the watchdog — so the header save button must
        // never appear on this panel.
        editForm: false,

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

        // The listen address is shown on the Sing-box tab: the server test builds
        // its URL out of it.
        listenIp: model.listenIp,
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

// View models of the panels: everything the EJS templates need, and nothing
// else.
//
// The route handlers of `app.mjs` only parse a request, call the model and hand
// the result to this module; the templates only read the plain objects built
// here. That split is what keeps the view layer replaceable: swapping EJS for
// React means reimplementing these builders and the templates, not the model.

import {ConfigError, DEFAULT_EXCLUDE, PROXY_TYPES, isMapping} from '../core/errors.mjs';
import {
  LINKS_FILENAME,
  TUNNEL_EXTENSION,
  collisionRefusal,
  describeContent,
  kindFileName,
  kindSourcePresent,
  suggestedKind,
} from '../core/sources.mjs';
import {
  UTLS_FINGERPRINTS,
  subscriptionExpiry,
  transportKind,
  transportLabel,
} from '../core/vless.mjs';
import {XRAY_CONFIGS_FILENAME} from '../core/xray.mjs';
import {listConfigSnapshots, processIdentity} from '../model/storage.mjs';
import {providerShortMark} from '../model/stale.mjs';

/** Keys of the tree, without a name part. */
export const PANEL_KINDS = Object.freeze([
  'singbox',
  'amnezia',
  'xray',
  'providers',
  'outputs',
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
export const SYSTEM_TABS = Object.freeze(['singbox', 'amnezia', 'xray']);

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
    case 'subscription':
      return 'подписка';
    case 'awg':
      return 'туннели';
    case 'xray':
      return 'конфиги Xray';
    default:
      return 'вид не задан';
  }
}

/**
 * Adds the presentation fields every provider ROW needs: the display name, the
 * kind label, the skipped count and the SHORT diagnosis (task 20 §1.3). Used by
 * the «Выходы» page and its lists so the three views cannot drift apart.
 *
 * @param {Record<string, unknown>} provider
 * @returns {Record<string, unknown>}
 */
function displayProvider(provider) {
  return {
    ...provider,
    displayName:
      typeof provider.label === 'string' && provider.label.length > 0
        ? provider.label
        : provider.id,
    kindLabel: providerKindLabel(provider.kind),
    skippedCount: (provider.skipped ?? []).length,
    // The same short mark the tree carries, so a list row and a tree node never
    // say different things about one folder.
    mark: providerShortMark(provider),
  };
}

/** What is missing when a folder holds nothing at all, built from the real names. */
const NOTHING_IN_FOLDER =
  `в папке нет ни ${LINKS_FILENAME}, ни конфигов туннелей (*${TUNNEL_EXTENSION}), ` +
  `ни ${XRAY_CONFIGS_FILENAME}`;

/**
 * The command that gives the process access to a provider folder, built from the
 * real account and the real path — never from a literal (task 20 §2.3).
 *
 * @param {string} dir
 * @returns {string}
 */
function providerFixCommand(dir) {
  const {user, group} = processIdentity();
  return `sudo chown ${user}:${group} ${dir} && sudo chmod 750 ${dir}`;
}

/**
 * The diagnosis block of a provider panel (task 20 §2): what is wrong with the
 * folder, what it really holds, and — when the content points at another kind —
 * the exact kind to switch to.
 *
 * The sentence is built with the SAME `describeContent` that feeds the «Найдено»
 * hint, never from a copy of it, so the panel and the lists cannot disagree about
 * what a folder holds.
 *
 * @param {Record<string, unknown>} provider
 * @returns {{state: string, text: string, command: string|null,
 *   suggest: {kind: string, label: string}|null, mixed: boolean}}
 */
function providerDiagnosisView(provider) {
  const state = String(provider.state ?? '');
  const kind = provider.kind ?? null;
  const contentKind = String(provider.contentKind ?? '');
  const error = typeof provider.error === 'string' ? provider.error : '';
  const hint = String(provider.hint ?? '');
  const mixed = contentKind === 'mixed';

  if (state === 'denied') {
    return {
      state,
      text: error,
      command: providerFixCommand(String(provider.path ?? '')),
      suggest: null,
      mixed,
    };
  }
  if (state === 'unreadable' || state === 'missing') {
    return {state, text: error, command: null, suggest: null, mixed};
  }
  if (kind === null) {
    // «Найдено, не подключено»: the content is DESCRIBED, never guessed at. The
    // silent single-kind hint is exactly what produced the wrong choice on the
    // router (task 20 §3).
    return {
      state,
      text: contentKind === 'empty' ? NOTHING_IN_FOLDER : error || hint,
      command: null,
      suggest: null,
      mixed,
    };
  }
  if (state === 'empty') {
    if (!kindSourcePresent(kind, contentKind)) {
      const parts = describeContent(contentKind, provider.parts ?? {});
      const suggestion = suggestedKind(contentKind);
      let text =
        `Вид — «${providerKindLabel(kind)}», но в папке нет ${kindFileName(kind)}. ` +
        `В папке: ${parts}.`;
      text +=
        suggestion === null
          ? ' Выберите вид, который подходит содержимому.'
          : ` Похоже на «${providerKindLabel(suggestion)}» — вид можно сменить кнопкой ниже.`;
      return {
        state,
        text,
        command: null,
        suggest:
          suggestion === null
            ? null
            : {kind: suggestion, label: providerKindLabel(suggestion)},
        mixed,
      };
    }
    // The expected file IS there, it simply holds nothing usable: no kind change
    // is needed, and the reason names the file.
    return {state, text: error || NOTHING_IN_FOLDER, command: null, suggest: null, mixed};
  }
  // Readable. A mixed folder keeps saying WHAT it holds even with a chosen kind:
  // its other half is not read, and silence would hide it (task 20 §3).
  return {state, text: mixed ? hint : '', command: null, suggest: null, mixed};
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
  // «Настройки → Xray»: the port range is the only editable field.
  xray: ['/xray'],
  // «Система» has NO edit form any more: the watchdog settings were its only one,
  // and they left the project together with the watchdog. Its three tabs are
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
 * Counts the servers of one provider by their protocol label (§3.2) — the word
 * the interface uses for what the code calls a transport.
 *
 * @param {Array<Record<string, unknown>>} outbounds
 * @returns {Array<{label: string, count: number, plain: boolean}>}
 */
function transportSummary(outbounds) {
  const counts = new Map();
  for (const outbound of outbounds) {
    const label = transportLabel(outbound);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => ({
    label,
    count,
    // «без шифрования …» is highlighted: the traffic is visible to the carrier.
    plain: label.startsWith('без шифрования'),
  }));
}

/**
 * Human list of `{value: count}` pairs, most frequent first (`firefox — 140,
 * chrome — 8`). An empty map renders as «нет».
 *
 * @param {Map<string, number>} counts
 * @returns {string}
 */
function describeCounts(counts) {
  if (counts.size === 0) return 'нет';
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => `${value} — ${count}`)
    .join(', ');
}

/**
 * View model of the collapsible «Тонкие настройки» block (§2.5): the stored
 * choice, the ACTUAL values found in the links with their counts, and whether
 * the block should start open (some field is not «Авто»).
 *
 * @param {Record<string, unknown>} provider Discovered provider.
 * @returns {Record<string, unknown>}
 */
function overridesView(provider) {
  const outbounds = provider.outbounds ?? [];
  const stored =
    isMapping(provider.record) && isMapping(provider.record.overrides)
      ? provider.record.overrides
      : {};

  const tcp = outbounds.filter((outbound) => transportKind(outbound) === 'tcp');
  const flowCounts = new Map();
  for (const outbound of tcp) {
    const key =
      typeof outbound.flow === 'string' && outbound.flow.length > 0 ? outbound.flow : 'нет';
    flowCounts.set(key, (flowCounts.get(key) ?? 0) + 1);
  }
  const fpCounts = new Map();
  for (const outbound of outbounds) {
    const tls = outbound.tls;
    if (tls && tls.utls && typeof tls.utls.fingerprint === 'string') {
      const key = tls.utls.fingerprint;
      fpCounts.set(key, (fpCounts.get(key) ?? 0) + 1);
    }
  }

  return {
    flow: typeof stored.flow === 'string' ? stored.flow : 'auto',
    fp: typeof stored.fp === 'string' ? stored.fp : 'auto',
    flowActual: describeCounts(flowCounts),
    fpActual: describeCounts(fpCounts),
    // flow only applies to links over TCP; a subscription with none says so.
    appliesToTcp: tcp.length > 0,
    nonTcpOnly: outbounds.length > 0 && tcp.length === 0,
    nonTcpSample: outbounds.length > 0 ? transportLabel(outbounds[0]) : '',
    fingerprints: UTLS_FINGERPRINTS,
    open: typeof stored.flow === 'string' || typeof stored.fp === 'string',
  };
}

/**
 * The `xray` block of a provider panel: one row per server (name, protocol,
 * address, the Xray port and the `remarks` of the config it came from), plus what
 * the runtime says about the engine. The port comes from the model's pure
 * `xrayPortInfo`, matched by the server key.
 *
 * @param {import('../model/project.mjs').ProjectModel} model
 * @param {Record<string, unknown>} provider
 * @param {Record<string, unknown>} system
 * @returns {Record<string, unknown>}
 */
function xrayProviderView(model, provider, system) {
  const info = model.xrayPortInfo();
  const portByKey = new Map((info.rows ?? []).map((row) => [row.key, row.port]));
  const rows = (provider.xrayServers ?? []).map((server) => ({
    key: server.key,
    name: server.name,
    protocol: server.protocol,
    address: server.address,
    remotePort: server.remotePort,
    remark: server.remark,
    port: portByKey.get(server.key) ?? null,
  }));
  const xray = system.xray ?? {};
  return {
    xrayRows: rows,
    xrayBinary: system.xrayBinary ?? '',
    xrayInstalled: xray.installed === true,
    xrayActive: xray.active === true,
    xrayServers: rows.length,
    xraySkipped: provider.skipped ?? [],
  };
}

/**
 * Discovered folders a missing provider record may have been renamed to.
 *
 * Nothing is guessed by NAME: a candidate is a folder that was read, has no
 * record of its own, and whose content fits the kind the record already chose —
 * `links.txt` for a subscription, `*.conf` for tunnels. A record with no kind
 * accepts either. A `mixed` folder is never offered: it has to be split first.
 *
 * @param {Record<string, unknown>} info `model.providersInfo()`.
 * @param {Record<string, unknown>} record The stored record of the missing id.
 * @returns {Array<{id: string, hint: string}>}
 */
function relocationCandidates(info, record) {
  const kind = record?.kind === 'subscription' || record?.kind === 'awg' ? record.kind : null;
  return info.providers
    .filter((provider) => provider.hasRecord !== true)
    .filter((provider) => {
      if (kind === 'subscription') return provider.contentKind === 'links';
      if (kind === 'awg') return provider.contentKind === 'tunnels';
      return provider.contentKind === 'links' || provider.contentKind === 'tunnels';
    })
    .map((provider) => ({id: String(provider.id), hint: String(provider.hint ?? '')}));
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
        title: 'Sing-Box',
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
        title: 'AmneziaWG',
        dir: model.amneziaDirInfo(),
        tunnels: model.amneziaRows(),
        regeneration: extra.regeneration ?? null,
      };

    case 'providers': {
      const info = model.providersInfo();
      const providers = info.providers.map(displayProvider);
      return {
        ...base,
        title: 'Выходы',
        // The §2.2 refusal is shown as one sentence while the collision lasts.
        collisionText: collisionRefusal(info.collisions),
        info: {
          ...info,
          providers,
          subscriptions: providers.filter(
            (provider) => provider.kind === 'subscription' || provider.kind === 'xray',
          ),
          awg: providers.filter((provider) => provider.kind === 'awg'),
          found: providers.filter((provider) => provider.kind === null),
          unread: info.unread.map((entry) => ({
            ...entry,
            displayName:
              typeof entry.label === 'string' && entry.label.length > 0
                ? entry.label
                : entry.id,
            stateLabel: unreadStateLabel(entry.state),
            // §4: a record whose folder is gone and a new folder of the same
            // content are usually one rename. `forget` marks the missing records.
            relocation: entry.forget === true ? relocationCandidates(info, entry.record ?? {}) : [],
          })),
        },
      };
    }

    // The three lists under «Выходы». The key carries the section after the
    // colon: `outputs:subscriptions`, `outputs:tunnels`, `outputs:found`.
    case 'outputs': {
      const info = model.providersInfo();
      const section = name === 'tunnels' ? 'awg' : name === 'found' ? null : 'subscription';
      const titles = {
        subscription: 'Подписки',
        awg: 'Туннели AmneziaWG',
        null: 'Найдено, не подключено',
      };
      const providers = info.providers
        .filter((provider) =>
          section === 'subscription'
            ? provider.kind === 'subscription' || provider.kind === 'xray'
            : provider.kind === section,
        )
        .map(displayProvider);
      return {
        ...base,
        title: titles[section],
        section: section === null ? 'found' : section,
        providers,
        collisionText: collisionRefusal(info.collisions),
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
        // §3.5: the kind selector is active ONLY while the provider is disabled.
        // Named `folderKind`, NOT `kind`: the panel dispatcher keys off `kind`.
        folderKind: provider.kind,
        kindEditable: provider.enabled !== true,
        kindLabel: providerKindLabel(provider.kind),
        // §3.6: the Happ/v2RayTun headers of the file, for the subscription panel.
        headers: provider.headers ?? {title: null, expire: null},
        // The expiry as the interface shows it (date, days left, expired), or
        // `null` when the file carries no date. A pure core helper.
        expiry: subscriptionExpiry(provider.headers?.expire ?? null),
        // One row per `.conf`: the «включить» mark and the two editable names.
        // Only an ENABLED provider offers them — a disabled one says so instead.
        tunnelRows: provider.enabled === true ? model.providerTunnelRows(name) : [],
        // §2.1–§2.5: the suffix and the «тонкие настройки» of the subscription.
        suffix: provider.suffix ?? '',
        firstServerName:
          provider.tags.length > 0
            ? provider.tags[0]
            : (provider.baseTags.length > 0 ? provider.baseTags[0] : ''),
        // §3.2: is it worth telling the owner the traffic would be seen.
        transports: transportSummary(provider.outbounds),
        // §3.3: what was skipped, with a name/host:port and a reason, no UUID.
        skipped: provider.skipped ?? [],
        skippedCount: (provider.skipped ?? []).length,
        overrides: overridesView(provider),
        // §2.2: the same refusal text as generation, shown while it lasts.
        collisionText: collisionRefusal(info.collisions),
        // Task 20 §2: the diagnosis block — the mismatch, the accessible command
        // and the kind to switch to. Always present, so the panel of a folder with
        // no kind, a broken file or no access is never a dead end.
        diagnosis: providerDiagnosisView(provider),
        // Kind `xray`: the server table and the state of the engine.
        ...(provider.kind === 'xray' ? xrayProviderView(model, provider, system) : {}),
      };
    }

    case 'xray': {
      // «Настройки → Xray»: the port range, the handed-out ports (with «Забыть»
      // for the gone servers) and the state of the engine.
      const info = model.xrayPortInfo();
      const xray = system.xray ?? {};
      return {
        ...base,
        title: 'Xray',
        range: info.range,
        rows: info.rows,
        assigned: info.assigned,
        portsError: info.error,
        installed: xray.installed === true,
        active: xray.active === true,
        enabled: xray.enabled === true,
        servers: xray.servers ?? info.rows.filter((row) => !row.missing).length,
        binary: system.xrayBinary ?? '',
        configPath: system.xrayConfigPath ?? '',
        unit: system.xrayUnit ?? 'xray',
      };
    }

    case 'proxies':
      return {...base, title: 'Прокси', tags: model.proxyTags()};

    case 'routes':
      return {...base, title: 'Маршруты', names: model.routeNames()};

    case 'proxy': {
      const proxy = model.getProxy(name);
      if (proxy === null) throw new ConfigError(`прокси '${name}' не найден`);
      const info = model.providersInfo();
      // §2.1: the servers of this proxy that are no longer in the links file. The
      // build skips them by itself; the row and the button only say so and let the
      // owner drop them from the document explicitly. `removable` is false when
      // every server is gone — removing them all would turn the proxy into the
      // common pool, which the model refuses.
      const known = new Set(info.tags);
      const storedServers = Array.isArray(proxy.servers)
        ? proxy.servers.filter((server) => typeof server === 'string')
        : [];
      const missingServers = storedServers.filter((server) => !known.has(server));
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
        missing: {
          count: missingServers.length,
          total: storedServers.length,
          tags: missingServers,
          removable: missingServers.length > 0 && storedServers.length > missingServers.length,
        },
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
        // §4.1: the ONE sudoers block of the tab — missing rules, leftover rules,
        // unreadable file. Assembled by the web layer, arranged here.
        sudoers: extra.sudoers ?? null,

        // The listen address is shown on the Sing-box tab: the server test builds
        // its URL out of it.
        listenIp: model.listenIp,

        // --- Xray: state, version, journal, restart, sudoers (§5) ---
        xray: system.xray ?? null,
        xrayBinary: system.xrayBinary ?? '',
        xrayConfigPath: system.xrayConfigPath ?? '',
        xrayUnit: system.xrayUnit ?? 'xray',
        xrayVersion: extra.xrayVersion ?? null,
        xrayRights: system.xrayRights ?? null,
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

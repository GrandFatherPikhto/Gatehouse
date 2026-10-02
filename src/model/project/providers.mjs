// Providers: the folders DISCOVERED under the root, and what the document says
// about them.
//
// A provider is a FOLDER under `GATEHOUSE_PROVIDERS`; the folder name is the
// identifier, and `providers` in the document is a map keyed by it. That name is
// the identity everywhere — server tags, `tunnels[].provider`, the panel key
// `provider:<id>` and `config.json` — while `label` is SHOWN only, so renaming a
// provider cannot move a byte of the generated config.
//
// Every function takes the model as its first argument. The stateful half of the
// model is a small public surface (`document`, `markDirty`, the resolved
// directories), so no topic module ever needs a private name of another file.

import path from 'node:path';

import {ConfigError, isMapping} from '../../core/errors.mjs';
import {
  SUFFIX_MAX_LENGTH,
  cleanSuffix,
  collisionRefusal,
  inferKind,
  isProviderId,
  providerOverrides as recordOverrides,
  providersRootInfo as rootInfoOf,
  readProviders,
} from '../../core/sources.mjs';
import {UTLS_FINGERPRINTS} from '../../core/vless.mjs';
import * as proxies from './proxies.mjs';
import * as routes from './routes.mjs';

/** Stored `providers` map as a plain object: `id -> {enabled, label?}`. */
export function providersMap(model) {
  const value = model.document.providers;
  return isMapping(value) ? value : {};
}

/** Identifiers of the providers named in the document. */
export function providerIds(model) {
  return Object.keys(providersMap(model));
}

/**
 * One stored provider record, or `null`.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {string} id
 * @returns {Record<string, unknown>|null}
 */
export function getProvider(model, id) {
  const record = providersMap(model)[String(id ?? '').trim()];
  return isMapping(record) ? record : null;
}

/**
 * Absolute directory of a discovered provider, or `null` when the folder is not
 * there (a record without a folder included). Used to read a `*.conf` for the
 * preview; the provider does NOT have to be enabled for that.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {string} id
 * @returns {string|null}
 */
export function providerDir(model, id) {
  const provider = providersInfo(model).providers.find((item) => item.id === id);
  return provider === undefined ? null : provider.path;
}

/**
 * The document's `providers` map, created when it is missing. An absent map is
 * normal: a fresh document has none, and a discovery-only project may never
 * have written one.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @returns {Record<string, unknown>}
 */
export function ensureProviders(model) {
  if (!isMapping(model.document.providers)) model.document.providers = {};
  return model.document.providers;
}

/**
 * The resolved root AND where it came from, in one place.
 *
 * An explicitly injected root (`GATEHOUSE_PROVIDERS` read by the web layer) wins
 * and is reported as the variable; otherwise the core resolves the three-step
 * rule — the variable, a `providers/` folder next to `webui.json`, the build
 * default. Resolving the root and naming its source in one function is what keeps
 * the panel from describing a root the reader did not use.
 *
 * `settingsDir` exists because `open` resolves the root of the file it is ABOUT
 * TO open, while `model.settingsDir` still names the file the model was bound to
 * before that call. Passing the directory explicitly is what keeps the
 * neighbouring `providers/` folder rule working during `open` — the same trap
 * that once made the version-1 migration look in `process.cwd()`.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {string} [settingsDir] Directory of the settings file the root is for.
 * @returns {{root: string, source: string}}
 */
export function providersRootInfo(model, settingsDir = model.settingsDir) {
  if (model.providersDir.length > 0) {
    return {root: model.providersDir, source: 'GATEHOUSE_PROVIDERS'};
  }
  return rootInfoOf(settingsDir);
}

/** Human name of where the providers root came from, for the panel. */
export function providersRootSource(model) {
  return providersRootInfo(model).source;
}

/** Root the provider folders resolve against (`GATEHOUSE_PROVIDERS` or its default). */
export function resolvedProvidersRoot(model, settingsDir) {
  return providersRootInfo(model, settingsDir).root;
}

/**
 * Fills the providers root from `GATEHOUSE_PROVIDERS`. Called by the web layer,
 * which alone may read the environment.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {string} value
 */
export function setProvidersDir(model, value) {
  if (typeof value === 'string' && value.length > 0) model.providersDir = value;
}

/**
 * Discovers every provider folder and merges the links of the ENABLED ones.
 *
 * The error is not thrown but returned: an absent root, an unreadable folder and
 * a record whose folder is gone are normal states the panel and the tree show
 * with an honest reason. `providers` carries the folders that were READ (a links
 * file and/or tunnel configs); `unread` carries everything that could not be
 * read, with the reason. `tags` are the merged outbound tags of the enabled
 * providers, de-duplicated for DISPLAY; a name two enabled providers share is
 * reported in `collisions` and generation refuses with it (§2.2).
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @returns {{root: string, rootSource: string,
 *   rootState: {state: string, owner: string|null, mode: string|null,
 *   message: string|null}, providers: Array<Record<string, unknown>>,
 *   unread: Array<Record<string, unknown>>,
 *   outbounds: Array<Record<string, unknown>>, tags: string[],
 *   collisions: Array<{tag: string, providers: string[]}>, error: string|null,
 *   warnings: string[]}}
 */
export function providersInfo(model) {
  const warnings = [];
  const root = resolvedProvidersRoot(model);
  const read = readProviders(model.document.providers, root, warnings);

  return {
    root,
    rootSource: providersRootSource(model),
    rootState: read.rootState,
    providers: read.providers,
    unread: read.unread,
    outbounds: read.outbounds,
    tags: read.tags,
    collisions: read.collisions,
    error: read.rootState.message,
    warnings,
  };
}

/**
 * The §2.2 refusal for the CURRENT names, or `null` when nothing collides.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @returns {string|null}
 */
function providerCollisionRefusal(model) {
  return collisionRefusal(providersInfo(model).collisions);
}

/**
 * Puts the document back exactly as it was and restores the dirty flag, so a
 * refused edit leaves no trace for the owner to save.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {string} before Canonical text captured before the edit.
 * @param {boolean} wasDirty
 */
function rollback(model, before, wasDirty) {
  model.restoreText(before);
  if (wasDirty) model.markDirty();
  else model.markClean();
}

/**
 * Rejects a suffix the schema would reject (§2.1): at most
 * `SUFFIX_MAX_LENGTH` characters, no control characters and no leading or
 * trailing whitespace. An empty suffix is allowed and means «no suffix».
 *
 * @param {string} value
 */
function assertSuffix(value) {
  if (value.length === 0) return;
  if (value.length > SUFFIX_MAX_LENGTH) {
    throw new ConfigError(`приписка не длиннее ${SUFFIX_MAX_LENGTH} символов`);
  }
  if (value !== value.trim()) {
    throw new ConfigError('приписка не должна начинаться или заканчиваться пробелом');
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new ConfigError('приписка не должна содержать управляющих символов');
  }
}

/**
 * Rewrites the servers of one provider in `proxies[].servers` and in
 * `routes.<name>.outbound` when its suffix changes (§2.3).
 *
 * The mapping is built from the provider's BASE tags (the names in its
 * `links.txt`, after the in-file dedup), so it never guesses by stripping text.
 * Pinned proxies are rewritten too: it is the same server, only its name moves,
 * and `assertPinned` is deliberately NOT applied here. `exclude_from_auto` is
 * untouched: it holds country-flag prefixes and the suffix sits at the end.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {string[]} baseTags Names as they come out of the provider's file.
 * @param {string} oldSuffix
 * @param {string} newSuffix
 * @returns {{proxies: string[], routes: string[]}}
 */
function renameProviderServers(model, baseTags, oldSuffix, newSuffix) {
  const mapping = new Map();
  for (const base of baseTags) {
    const from = oldSuffix.length > 0 ? `${base} ${oldSuffix}` : base;
    const to = newSuffix.length > 0 ? `${base} ${newSuffix}` : base;
    if (from !== to) mapping.set(from, to);
  }

  const touchedProxies = [];
  for (const proxy of proxies.proxies(model)) {
    if (!isMapping(proxy) || !Array.isArray(proxy.servers)) continue;
    let changed = false;
    proxy.servers = proxy.servers.map((server) => {
      if (mapping.has(server)) {
        changed = true;
        return mapping.get(server);
      }
      return server;
    });
    if (changed) touchedProxies.push(proxy.tag);
  }

  const touchedRoutes = [];
  const routeMap = routes.routes(model);
  for (const [name, entry] of Object.entries(routeMap)) {
    if (!isMapping(entry)) continue;
    if (typeof entry.outbound === 'string' && mapping.has(entry.outbound)) {
      entry.outbound = mapping.get(entry.outbound);
      touchedRoutes.push(name);
    }
  }

  if (touchedProxies.length > 0 || touchedRoutes.length > 0) model.markDirty();
  return {proxies: touchedProxies, routes: touchedRoutes};
}

/**
 * Turns a discovered provider on or off. A provider absent from the map is
 * "found, disabled", so enabling has to CREATE the record and disabling keeps
 * it — an explicit `false` is a decision, not an absence.
 *
 * Enabling REFUSES when it would make two enabled providers hand out the same
 * server name (§2.2): the document is put back untouched and generation would
 * refuse anyway, this only says so before the owner saves. Disabling is always
 * allowed.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {string} id Provider identifier (folder name).
 * @param {boolean} enabled
 * @returns {Record<string, unknown>} The stored record.
 */
export function setProviderEnabled(model, id, enabled) {
  const clean = String(id ?? '').trim();
  if (!isProviderId(clean)) {
    throw new ConfigError(`имя провайдера '${clean}' не подходит для идентификатора`);
  }
  const providers = ensureProviders(model);
  const current = isMapping(providers[clean]) ? providers[clean] : {};
  // A provider with no chosen kind never feeds the build (§3.1), so enabling it
  // is refused with the instruction to choose the kind first.
  if (enabled === true && current.kind !== 'subscription' && current.kind !== 'awg') {
    throw new ConfigError('задайте вид папки: подписка или туннели');
  }
  const before = model.toText();
  const wasDirty = model.dirty;

  providers[clean] = {...current, enabled: enabled === true};
  model.markDirty();

  if (enabled === true) {
    const refusal = providerCollisionRefusal(model);
    if (refusal !== null) {
      rollback(model, before, wasDirty);
      throw new ConfigError(refusal);
    }
  }
  return getProvider(model, clean) ?? {};
}

/**
 * Sets (or clears) the KIND of a provider folder (§3.3).
 *
 * Refused while the provider is enabled («сначала выключите») and for `awg` when
 * a `tunnels[]` entry already takes its config from this folder («туннели …
 * взяты из этой папки»). `null` removes the kind, which puts the folder back into
 * «Найдено, не подключено».
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {string} id
 * @param {'subscription'|'awg'|null} kind
 * @returns {Record<string, unknown>} The stored record.
 */
export function setProviderKind(model, id, kind) {
  const clean = String(id ?? '').trim();
  if (!isProviderId(clean)) {
    throw new ConfigError(`имя провайдера '${clean}' не подходит для идентификатора`);
  }
  const value = kind === 'subscription' || kind === 'awg' ? kind : null;
  if (kind !== null && kind !== undefined && value === null) {
    throw new ConfigError(`вид '${String(kind)}' неизвестен: допустимо 'subscription' или 'awg'`);
  }

  const providers = ensureProviders(model);
  const current = isMapping(providers[clean]) ? providers[clean] : {};
  if (current.enabled === true) {
    throw new ConfigError('провайдер включён: чтобы сменить вид, сначала выключите его');
  }
  if (value === 'awg') {
    const used = [];
    for (const entry of Array.isArray(model.document.tunnels) ? model.document.tunnels : []) {
      if (isMapping(entry) && entry.provider === clean) {
        used.push(String(entry.name ?? entry.interface ?? entry.file));
      }
    }
    if (used.length > 0) {
      throw new ConfigError(`туннели ${used.join(', ')} взяты из этой папки — сначала выключите их`);
    }
  }

  const next = {...current};
  if (value === null) delete next.kind;
  else next.kind = value;
  providers[clean] = next;
  model.markDirty();
  return getProvider(model, clean) ?? {};
}

/**
 * Sets (or clears) the human-readable name of a provider. The name is SHOWN
 * only: it never reaches tags, keys or `config.json`, so changing it cannot move
 * a byte of the generated config.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {string} id
 * @param {string} label Empty clears the name, so the identifier is shown again.
 * @returns {Record<string, unknown>} The stored record.
 */
export function setProviderLabel(model, id, label) {
  const clean = String(id ?? '').trim();
  if (!isProviderId(clean)) {
    throw new ConfigError(`имя провайдера '${clean}' не подходит для идентификатора`);
  }
  const text = String(label ?? '').trim();
  if (text.length > 64) throw new ConfigError('имя провайдера не длиннее 64 символов');
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw new ConfigError('имя провайдера не должно содержать управляющих символов');
  }
  const providers = ensureProviders(model);
  const current = isMapping(providers[clean]) ? providers[clean] : {};
  if (text.length === 0) {
    const rest = {...current};
    delete rest.label;
    if (Object.keys(rest).length === 0) delete providers[clean];
    else providers[clean] = rest;
  } else {
    providers[clean] = {...current, label: text};
  }
  model.markDirty();
  return getProvider(model, clean) ?? {};
}

/**
 * Sets (or clears) the «suffix appended to server names» of a provider (§2.1).
 *
 * Renames the provider's servers in `proxies[].servers` and
 * `routes.<name>.outbound` so an edit of the suffix does not break every
 * pinning (§2.3). A suffix that would make two enabled providers collide is
 * refused with the document left untouched.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {string} id
 * @param {string} suffix Empty clears it, so names are exactly as in the links.
 * @returns {{proxies: string[], routes: string[]}} What was renamed.
 */
export function setProviderSuffix(model, id, suffix) {
  const clean = String(id ?? '').trim();
  if (!isProviderId(clean)) {
    throw new ConfigError(`имя провайдера '${clean}' не подходит для идентификатора`);
  }
  const text = String(suffix ?? '');
  assertSuffix(text);

  const providers = ensureProviders(model);
  const current = isMapping(providers[clean]) ? providers[clean] : {};
  const oldSuffix = cleanSuffix(current);

  // The base names come from the provider's own file (independent of the
  // suffix), so the mapping never guesses by stripping text off a name.
  const provider = providersInfo(model).providers.find((item) => item.id === clean) ?? null;
  const baseTags = provider === null ? [] : provider.baseTags;

  const before = model.toText();
  const wasDirty = model.dirty;

  const next = {...current};
  if (text.length === 0) delete next.suffix;
  else next.suffix = text;
  providers[clean] = next;
  model.markDirty();

  const affected = renameProviderServers(model, baseTags, oldSuffix, text);

  const refusal = providerCollisionRefusal(model);
  if (refusal !== null) {
    rollback(model, before, wasDirty);
    throw new ConfigError(refusal);
  }
  return affected;
}

/**
 * Sets the per-subscription «тонкие настройки» of a provider (§2.5).
 *
 * `flow` is `vision` | `none` | absent (Авто); `fp` is one of
 * `UTLS_FINGERPRINTS` or absent. «Авто» DELETES the key, and an empty
 * `overrides` object is not stored at all. An invalid value is refused with the
 * document untouched.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {string} id
 * @param {{flow?: string, fp?: string}} [values]
 * @returns {Record<string, unknown>} The stored record.
 */
export function setProviderOverrides(model, id, values = {}) {
  const clean = String(id ?? '').trim();
  if (!isProviderId(clean)) {
    throw new ConfigError(`имя провайдера '${clean}' не подходит для идентификатора`);
  }
  const providers = ensureProviders(model);
  const current = isMapping(providers[clean]) ? providers[clean] : {};
  const overrides = {...recordOverrides(current)};

  if (Object.hasOwn(values, 'flow')) {
    const flow = values.flow;
    if (flow === null || flow === undefined || flow === '' || flow === 'auto') delete overrides.flow;
    else if (flow === 'vision' || flow === 'none') overrides.flow = flow;
    else throw new ConfigError("flow: допустимо 'vision', 'none' или авто");
  }
  if (Object.hasOwn(values, 'fp')) {
    const fp = values.fp;
    if (fp === null || fp === undefined || fp === '' || fp === 'auto') delete overrides.fp;
    else if (UTLS_FINGERPRINTS.includes(fp)) overrides.fp = fp;
    else throw new ConfigError(`fp: допустимо ${UTLS_FINGERPRINTS.join(', ')} или авто`);
  }

  const next = {...current};
  if (Object.keys(overrides).length === 0) delete next.overrides;
  else next.overrides = overrides;
  providers[clean] = next;
  model.markDirty();
  return getProvider(model, clean) ?? {};
}

/**
 * Forgets a record whose folder is gone: the provider disappears from the map
 * and from the «Не прочиталось» list. Only a record with NO folder may be
 * forgotten — a folder that is there is removed from disk, not from the file.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {string} id
 * @returns {boolean}
 */
export function forgetProvider(model, id) {
  const clean = String(id ?? '').trim();
  const providers = ensureProviders(model);
  if (!Object.hasOwn(providers, clean)) {
    throw new ConfigError(`провайдер '${clean}' не указан в providers`);
  }
  if (providersInfo(model).providers.some((provider) => provider.id === clean)) {
    throw new ConfigError(
      `провайдер '${clean}' найден на диске: «Забыть» убирает только запись о пропавшей папке`,
    );
  }
  delete providers[clean];
  if (Object.keys(providers).length === 0) delete model.document.providers;
  model.markDirty();
  return true;
}

/**
 * Migrates the `sources` field into `providers`, in place, and drops `sources`.
 * Returns the warnings to show.
 *
 * `enableAllWithLinks` is the version-1 case: the old file had no list at all,
 * only a `links_file` that may have moved, so every folder that now carries a
 * `links.txt` is enabled by name — otherwise the router's `config.json` would
 * come out empty after the first open. If none is found the owner is told where
 * to put the file and NOTHING is enabled.
 *
 * @param {Record<string, unknown>} document
 * @param {string} root Providers root.
 * @param {string} settingsDir Directory a relative stored path resolves against.
 * @param {boolean} enableAllWithLinks
 * @returns {string[]}
 */
export function migrateProviders(document, root, settingsDir, enableAllWithLinks) {
  const warnings = [];
  const providers = isMapping(document.providers) ? {...document.providers} : {};
  let touched = false;

  const rawSources = Array.isArray(document.sources) ? document.sources : null;
  if (rawSources !== null) {
    for (const item of rawSources) {
      let id = '';
      let stored = null;
      if (typeof item === 'string') {
        id = item.trim();
      } else if (isMapping(item) && typeof item.name === 'string') {
        id = item.name.trim();
        if (typeof item.path === 'string') stored = item.path.trim();
      } else {
        continue;
      }
      if (id.length === 0) continue;
      if (!isProviderId(id)) {
        warnings.push(
          `Предупреждение: источник '${id}' не подходит для имени папки провайдера — пропущен`,
        );
        continue;
      }
      if (stored !== null && stored.length > 0) {
        const resolvedStored = path.isAbsolute(stored) ? stored : path.join(settingsDir, stored);
        const expected = path.join(root, id);
        const inside =
          resolvedStored === expected || resolvedStored.startsWith(`${expected}${path.sep}`);
        if (!inside) {
          warnings.push(
            `Предупреждение: источник '${id}' лежал в '${stored}', теперь провайдеры ` +
              `читаются только из '${root}': перенесите папку в '${expected}'`,
          );
        }
      }
      providers[id] = {...(isMapping(providers[id]) ? providers[id] : {}), enabled: true};
      touched = true;
    }
    delete document.sources;
    if (touched) {
      warnings.push('Предупреждение: поле sources заменено на providers: сохраните изменения');
    }
  } else if (enableAllWithLinks) {
    const read = readProviders({}, root);
    const found = read.providers
      .filter((provider) => provider.contentKind === 'links')
      .map((provider) => provider.id);
    const mixed = read.providers
      .filter((provider) => provider.contentKind === 'mixed')
      .map((provider) => provider.id);
    if (found.length === 0) {
      warnings.push(
        `Предупреждение: не найдено ни одного провайдера со ссылками в '${root}': ` +
          'положите links.txt в папку провайдера',
      );
    } else {
      // A version-1 file has no kind at all: the folder that carries only a
      // `links.txt` is enabled AS A SUBSCRIPTION, which is what it is.
      for (const id of found) providers[id] = {enabled: true, kind: 'subscription'};
      warnings.push(`Предупреждение: включены найденные провайдеры: ${found.join(', ')}`);
    }
    for (const id of mixed) {
      warnings.push(
        `Предупреждение: папка '${id}' содержит и ссылки, и конфиги туннелей — ` +
          'разнесите и задайте вид',
      );
    }
  }

  if (touched || Object.keys(providers).length > 0) document.providers = providers;
  return warnings;
}

/**
 * One-time migration of the folder KIND (§3.2): a record that has no `kind` gets
 * it inferred from the content — only `links.txt` → `subscription`, only
 * `*.conf` → `awg`. A mixed folder is left without a kind and warned about, and a
 * folder WITHOUT a record is left alone («Найдено»). Nothing is enabled here.
 *
 * @param {Record<string, unknown>} document
 * @param {string} root Providers root.
 * @returns {string[]} Warnings to show, including the «save» one.
 */
export function migrateProviderKinds(document, root) {
  const warnings = [];
  const providers = isMapping(document.providers) ? document.providers : {};
  if (Object.keys(providers).length === 0) return warnings;

  const read = readProviders(providers, root);
  let touched = false;
  for (const provider of read.providers) {
    const id = provider.id;
    if (!Object.hasOwn(providers, id)) continue; // «Найдено»: nothing to touch
    const record = isMapping(providers[id]) ? providers[id] : {};
    if (record.kind === 'subscription' || record.kind === 'awg') continue;
    const inferred = provider.kind ?? inferKind(provider.contentKind);
    if (inferred === 'subscription' || inferred === 'awg') {
      providers[id] = {...record, kind: inferred};
      touched = true;
    } else if (provider.contentKind === 'mixed') {
      warnings.push(
        `Предупреждение: папка '${id}' содержит и ссылки, и конфиги туннелей — ` +
          'разнесите и задайте вид',
      );
    }
  }
  if (touched) {
    warnings.push(
      'Предупреждение: у провайдеров появился вид папки (подписка/туннели): сохраните изменения',
    );
  }
  return warnings;
}

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
  isProviderId,
  providersRootInfo as rootInfoOf,
  readProviders,
} from '../../core/sources.mjs';

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
 * providers, carrying a provider identifier only on a name collision — which is
 * what keeps a one-provider project's `config.json` byte-identical.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @returns {{root: string, rootSource: string,
 *   rootState: {state: string, owner: string|null, mode: string|null,
 *   message: string|null}, providers: Array<Record<string, unknown>>,
 *   unread: Array<Record<string, unknown>>,
 *   outbounds: Array<Record<string, unknown>>, tags: string[], error: string|null,
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
    error: read.rootState.message,
    warnings,
  };
}

/**
 * Turns a discovered provider on or off. A provider absent from the map is
 * "found, disabled", so enabling has to CREATE the record and disabling keeps
 * it — an explicit `false` is a decision, not an absence.
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
  providers[clean] = {...current, enabled: enabled === true};
  model.markDirty();
  return providers[clean];
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
      .filter((provider) => provider.kind === 'links' || provider.kind === 'mixed')
      .map((provider) => provider.id);
    if (found.length === 0) {
      warnings.push(
        `Предупреждение: не найдено ни одного провайдера со ссылками в '${root}': ` +
          'положите links.txt в папку провайдера',
      );
    } else {
      for (const id of found) providers[id] = {enabled: true};
      warnings.push(`Предупреждение: включены найденные провайдеры: ${found.join(', ')}`);
    }
  }

  if (touched || Object.keys(providers).length > 0) document.providers = providers;
  return warnings;
}

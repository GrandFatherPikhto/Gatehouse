// Proxies: the CRUD of `proxies[]` in the document.
//
// Reference: the proxy CRUD of generator/model.py. The rules this module does
// NOT own live in the core: `validateProxies` knows unique tags, unique ports,
// known types and the port range, and the editor only repeats its answer in the
// wording a form shows. The `pinned` flag is a rule of the editor, not of the
// core, so it is enforced here — before anything reaches the document.

import {ConfigError, isMapping} from '../../core/errors.mjs';
import {asList, validateProxies} from '../../core/validate.mjs';
import {
  DEFAULT_PROXY_PORT,
  DEFAULT_PROXY_TAG,
  DEFAULT_PROXY_TYPE,
  PINNED_REFUSAL,
  TUNNEL_WITH_SERVERS_REFUSAL,
} from './document.mjs';

/**
 * The document's `proxies` array, created when it is missing.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @returns {unknown[]}
 */
export function ensureProxies(model) {
  if (!Array.isArray(model.document.proxies)) model.document.proxies = [];
  return model.document.proxies;
}

/** Counterpart of the reference `proxies()`. */
export function proxies(model) {
  const value = model.document.proxies;
  return Array.isArray(value) ? value : [];
}

/** Reference: `proxy_tags`. */
export function proxyTags(model) {
  return proxies(model)
    .filter((proxy) => isMapping(proxy))
    .map((proxy) => proxy.tag);
}

/** Reference: `get_proxy`. */
export function getProxy(model, tag) {
  return proxies(model).find((proxy) => isMapping(proxy) && proxy.tag === tag) ?? null;
}

/** Reference: `next_free_port`. */
export function nextFreePort(model, start = DEFAULT_PROXY_PORT) {
  const used = new Set(proxies(model).filter(isMapping).map((proxy) => proxy.port));
  let port = start;
  while (used.has(port) && port < 65536) port += 1;
  return port;
}

/** Reference: `next_free_tag`. */
export function nextFreeTag(model, base = DEFAULT_PROXY_TAG) {
  const tags = new Set(proxyTags(model));
  if (!tags.has(base)) return base;
  let n = 2;
  while (tags.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/**
 * Checks a proxy against the OTHER proxies, through the core's
 * `validateProxies`, and returns the message the form should show.
 * Reference: `validate_proxy_candidate` of generator/validation.py — the rules
 * (unique tag, unique port, known type, port range) live only in the core.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {Record<string, unknown>} candidate
 * @param {string|null} [currentTag] The proxy being edited, if any.
 * @returns {string|null} Error text, or null when the candidate is fine.
 */
export function validateProxyCandidate(model, candidate, currentTag = null) {
  const entries = [];
  let replaced = false;
  for (const proxy of proxies(model)) {
    if (!isMapping(proxy)) continue;
    if (currentTag !== null && proxy.tag === currentTag) {
      entries.push(candidate);
      replaced = true;
    } else {
      entries.push(proxy);
    }
  }
  if (!replaced) entries.push(candidate);

  try {
    validateProxies(entries);
    return null;
  } catch (error) {
    if (error instanceof ConfigError) return error.message;
    throw error;
  }
}

/**
 * Adds a proxy, filling the free tag/port when they are not given.
 * Reference: `add_proxy`.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {{tag?: string, type?: string, port?: number, servers?: unknown,
 *   note?: string}} [candidate]
 * @returns {Record<string, unknown>} The stored entry.
 */
export function addProxy(model, candidate = {}) {
  const entry = proxyEntry(model, {
    tag: candidate.tag ?? nextFreeTag(model),
    type: candidate.type ?? DEFAULT_PROXY_TYPE,
    port: candidate.port ?? nextFreePort(model),
    servers: candidate.servers,
    tunnel: candidate.tunnel,
    note: candidate.note,
    pinned: candidate.pinned,
  });
  assertPinned(entry);
  const error = validateProxyCandidate(model, entry, null);
  if (error !== null) throw new ConfigError(error);

  ensureProxies(model).push(entry);
  model.markDirty();
  return entry;
}

/**
 * Replaces the proxy named `currentTag`, or appends a new one.
 * Reference: `upsert_proxy`.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {{tag?: string, type?: string, port?: number, servers?: unknown,
 *   note?: string}} candidate
 * @param {string|null} [currentTag]
 * @returns {Record<string, unknown>} The stored entry.
 */
export function upsertProxy(model, candidate, currentTag = null) {
  const entry = proxyEntry(model, candidate);
  assertPinned(entry);
  const error = validateProxyCandidate(model, entry, currentTag);
  if (error !== null) throw new ConfigError(error);

  const list = ensureProxies(model);
  if (currentTag !== null) {
    const index = list.findIndex((proxy) => isMapping(proxy) && proxy.tag === currentTag);
    if (index >= 0) {
      list[index] = entry;
      model.markDirty();
      return entry;
    }
  }
  list.push(entry);
  model.markDirty();
  return entry;
}

/**
 * Reference: `remove_proxy`.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {string} tag
 * @returns {boolean}
 */
export function removeProxy(model, tag) {
  const list = ensureProxies(model);
  const index = list.findIndex((proxy) => isMapping(proxy) && proxy.tag === tag);
  if (index < 0) return false;
  list.splice(index, 1);
  model.markDirty();
  return true;
}

/**
 * Reference: `rename_proxy`.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {string} oldTag
 * @param {string} newTag
 * @returns {boolean}
 */
export function renameProxy(model, oldTag, newTag) {
  if (!newTag || oldTag === newTag) return false;
  const proxy = getProxy(model, oldTag);
  if (proxy === null || getProxy(model, newTag) !== null) return false;
  proxy.tag = newTag;
  model.markDirty();
  return true;
}

/**
 * Normalises a proxy into the shape the core expects: `servers`, `note` and
 * `pinned` are only written when they carry something, which keeps `webui.json`
 * free of empty noise and keeps an untouched save a no-op. Reference:
 * `upsert_proxy` (`pinned` is editor-only and never reaches `config.json` —
 * `validateProxies` of the core drops it).
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {{tag?: unknown, type?: unknown, port?: unknown, servers?: unknown,
 *   tunnel?: unknown, note?: unknown, pinned?: unknown}} candidate
 * @returns {Record<string, unknown>}
 */
export function proxyEntry(model, candidate) {
  const entry = {tag: candidate.tag, type: candidate.type, port: candidate.port};
  const servers = asList(candidate.servers).filter(
    (server) => typeof server === 'string' && server.length > 0,
  );

  // A tunnel proxy owns no server list: its single exit is the interface. The
  // refusal protects the same thing the pinned flag does — an exit that must not
  // silently become a pool.
  if (isMapping(candidate.tunnel)) {
    const provider = String(candidate.tunnel.provider ?? '').trim();
    const file = String(candidate.tunnel.file ?? '').trim();
    const prepared = model.getTunnel(provider, file);
    if (prepared === null) {
      throw new ConfigError(
        `туннель '${provider}/${file}' не подготовлен: отметьте его в «Провайдерах»`,
      );
    }
    const requested = String(candidate.tunnel.interface ?? '').trim();
    if (requested.length > 0 && requested !== prepared.interface) {
      throw new ConfigError(
        `туннель '${provider}/${file}' записан как '${prepared.interface}', а не '${requested}'`,
      );
    }
    if (servers.length > 0) throw new ConfigError(TUNNEL_WITH_SERVERS_REFUSAL);
    entry.tunnel = {provider, file, interface: String(prepared.interface)};
  } else if (servers.length > 0) {
    entry.servers = servers;
  }

  if (typeof candidate.note === 'string' && candidate.note.length > 0) {
    entry.note = candidate.note;
  }
  if (candidate.pinned === true) entry.pinned = true;
  return entry;
}

/**
 * Refuses a pinned proxy that would end up with a pool.
 *
 * This is the first part of the task and it is deliberately NOT in the core: the
 * core is a port of the Python reference and has to stay byte-compatible. The
 * flag protects against the owner's own future slip, and this is where the slip
 * is caught — before anything is stored, and with the same wording whatever form
 * it came from ("save with two servers" and "tick the flag on a pool").
 *
 * @param {Record<string, unknown>} entry
 */
export function assertPinned(entry) {
  if (entry.pinned !== true) return;
  const servers = Array.isArray(entry.servers) ? entry.servers : [];
  if (servers.length > 1) throw new ConfigError(PINNED_REFUSAL);
}

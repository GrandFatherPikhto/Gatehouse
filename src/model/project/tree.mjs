// The project as a tree, plus the tags the document does not have any more.
//
// This is the thin, stateful half of `model/stale.mjs`: the tree builder and the
// stale-reference map are pure functions, and all they need from the model is
// the document, the merged tags of the enabled providers and the runtime state
// of the tunnels, which the web layer reads from the host.

import {staleMap as staleMapOf, treeSpec as buildTree} from '../stale.mjs';

/** Reference: `load_server_tags`, reduced to what most callers need. */
export function loadServerTags(model) {
  const info = model.providersInfo();
  return {tags: info.tags, error: info.error};
}

/**
 * `{section, name} -> [stale tags]` for the document.
 * Reference: `stale_map`.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @returns {Map<string, string[]>}
 */
export function staleMap(model) {
  return staleMapOf(model.document, loadServerTags(model).tags);
}

/**
 * Tree of the project, as plain data.
 * Reference: `tree_spec`.
 *
 * @param {import('../project.mjs').ProjectModel} model
 * @param {{tunnelStates?: Record<string, Record<string, unknown>>}} [options]
 * @returns {Record<string, unknown>}
 */
export function treeSpec(model, options = {}) {
  const info = model.providersInfo();
  return buildTree({
    document: model.document,
    allTags: info.tags,
    title: model.displayName,
    providersRoot: info.root,
    providers: info.providers,
    unread: info.unread,
    outputFile: model.outputFile,
    // Runtime tunnel states, handed in by the web layer. Absent means "not
    // asked", and then no proxy gets a tunnel mark.
    tunnelStates: options.tunnelStates ?? {},
  });
}

// `ProjectModel` — the public surface of the editor's document.
//
// The class is deliberately THIN: every method delegates to the module of its
// topic, passing itself as the first argument. `session.mjs` holds the state
// (document, path, dirty flag, snapshots); `document.mjs` holds the pure
// document helpers; the topic modules hold the behaviour. Splitting a 2100-line
// class this way is what private names made impossible before: a `#x` is visible
// only inside its own class, so the helpers became module functions with the
// model as the first parameter.
//
// The public names are unchanged on purpose — routes, panel builders and the
// test suite call `model.providersInfo()`, `model.prepareTunnel(…)` and the rest
// exactly as before, and `project.mjs` re-exports this class from the same path.

import * as amnezia from './amnezia.mjs';
import {ProjectSession} from './session.mjs';
import * as inventory from './tunnel-inventory.mjs';
import * as providers from './providers.mjs';
import * as proxies from './proxies.mjs';
import * as routes from './routes.mjs';
import * as settings from './settings.mjs';
import * as tree from './tree.mjs';
import * as tunnels from './tunnels.mjs';

export class ProjectModel extends ProjectSession {
  // ------------------------------------------------------------------
  // Providers (discovered by folder, never declared by a path)
  // ------------------------------------------------------------------

  /** Stored `providers` map as a plain object: `id -> {enabled, label?}`. */
  providers() {
    return providers.providersMap(this);
  }

  /** Identifiers of the providers named in the document. */
  providerIds() {
    return providers.providerIds(this);
  }

  /** One stored provider record, or `null`. */
  getProvider(id) {
    return providers.getProvider(this, id);
  }

  /** Absolute directory of a discovered provider, or `null` when the folder is gone. */
  providerDir(id) {
    return providers.providerDir(this, id);
  }

  /** Human name of where the providers root came from, for the panel. */
  get providersRootSource() {
    return providers.providersRootSource(this);
  }

  /** Root the provider folders resolve against (`GATEHOUSE_PROVIDERS` or its default). */
  resolvedProvidersRoot() {
    return providers.resolvedProvidersRoot(this);
  }

  /** Fills the providers root from `GATEHOUSE_PROVIDERS`; the web layer calls this. */
  setProvidersDir(value) {
    providers.setProvidersDir(this, value);
  }

  /**
   * Discovers every provider folder and merges the links of the ENABLED ones.
   * Nothing is thrown: an absent root and an unreadable folder are reported.
   */
  providersInfo() {
    return providers.providersInfo(this);
  }

  /** Turns a discovered provider on or off; the record is created on enable. */
  setProviderEnabled(id, enabled) {
    return providers.setProviderEnabled(this, id, enabled);
  }

  /** Sets (or clears) the human-readable name, which is SHOWN only. */
  setProviderLabel(id, label) {
    return providers.setProviderLabel(this, id, label);
  }

  /** Forgets a record whose folder is gone; a folder on disk is never dropped. */
  forgetProvider(id) {
    return providers.forgetProvider(this, id);
  }

  // ------------------------------------------------------------------
  // Tunnels (preview, the «нужен» mark, and the inventory)
  // ------------------------------------------------------------------

  /** Directory of the applied tunnel configs, resolved. */
  get amneziaDir() {
    return amnezia.amneziaDir(this);
  }

  /** Fills the directory from `GATEHOUSE_AMNEZIA_DIR`; the web layer calls this. */
  setDefaultAmneziaDir(value) {
    amnezia.setDefaultAmneziaDir(this, value);
  }

  /** What the Amnezia panel shows about the directory: path, source, readability. */
  amneziaDirInfo() {
    return amnezia.amneziaDirInfo(this);
  }

  /** Rows of the Amnezia panel: one per marked tunnel. */
  amneziaRows() {
    return amnezia.amneziaRows(this);
  }

  /** Re-normalises and rewrites every marked tunnel, reporting per tunnel. */
  regenerateTunnels() {
    return amnezia.regenerateTunnels(this);
  }

  /** Runs the normaliser over one `*.conf` for the preview; reads, changes nothing. */
  tunnelPreview(providerName, fileName, options) {
    return tunnels.tunnelPreview(this, providerName, fileName, options);
  }

  /** Writes the normalised config of one tunnel; does not bring a unit up. */
  applyTunnel(providerName, fileName, options) {
    return tunnels.applyTunnel(this, providerName, fileName, options);
  }

  /** Prepared tunnels of the document, in document order. */
  tunnels() {
    return inventory.tunnels(this);
  }

  /** One prepared tunnel by its source, or `null`. */
  getTunnel(providerName, fileName) {
    return inventory.getTunnel(this, providerName, fileName);
  }

  /** One prepared tunnel by its file name — the identity of the unit, or `null`. */
  getTunnelByInterface(name) {
    return inventory.getTunnelByInterface(this, name);
  }

  /** Rows of the `.conf` list of one provider for the Providers panel. */
  providerTunnelRows(providerName) {
    return inventory.providerTunnelRows(this, providerName);
  }

  /** Ticks a tunnel «нужен»: validates the names, writes the file, records the entry. */
  prepareTunnel(providerName, fileName, options) {
    return tunnels.prepareTunnel(this, providerName, fileName, options);
  }

  /** Un-ticks a tunnel: drops the entry and removes `<interface>.conf`. */
  unprepareTunnel(providerName, fileName) {
    return tunnels.unprepareTunnel(this, providerName, fileName);
  }

  /** Tunnels the document knows about: proxies carrying a `tunnel` descriptor. */
  tunnelProxies() {
    return inventory.tunnelProxies(this);
  }

  /** `interface -> [proxy tags]` for the restart confirmation. */
  tunnelUsage() {
    return inventory.tunnelUsage(this);
  }

  /** Every tunnel the System panel shows: marked entries plus `.conf` files. */
  tunnelInventory() {
    return inventory.tunnelInventory(this);
  }

  /** The inventory grouped by provider; an unclaimed file lands in «вне источников». */
  tunnelGroups() {
    return inventory.tunnelGroups(this);
  }

  /** Prepared tunnels offered to the proxy form: only the ones marked «нужен». */
  availableTunnels() {
    return inventory.availableTunnels(this);
  }

  // ------------------------------------------------------------------
  // Proxies
  // ------------------------------------------------------------------

  /** Counterpart of the reference `proxies()`. */
  proxies() {
    return proxies.proxies(this);
  }

  /** Reference: `proxy_tags`. */
  proxyTags() {
    return proxies.proxyTags(this);
  }

  /** Reference: `get_proxy`. */
  getProxy(tag) {
    return proxies.getProxy(this, tag);
  }

  /** Reference: `next_free_port`. */
  nextFreePort(start) {
    return proxies.nextFreePort(this, start);
  }

  /** Reference: `next_free_tag`. */
  nextFreeTag(base) {
    return proxies.nextFreeTag(this, base);
  }

  /** Message the form should show for a candidate, or `null` when it is fine. */
  validateProxyCandidate(candidate, currentTag) {
    return proxies.validateProxyCandidate(this, candidate, currentTag);
  }

  /** Reference: `add_proxy`. */
  addProxy(candidate) {
    return proxies.addProxy(this, candidate);
  }

  /** Reference: `upsert_proxy`. */
  upsertProxy(candidate, currentTag) {
    return proxies.upsertProxy(this, candidate, currentTag);
  }

  /** Reference: `remove_proxy`. */
  removeProxy(tag) {
    return proxies.removeProxy(this, tag);
  }

  /** Reference: `rename_proxy`. */
  renameProxy(oldTag, newTag) {
    return proxies.renameProxy(this, oldTag, newTag);
  }

  // ------------------------------------------------------------------
  // Routes
  // ------------------------------------------------------------------

  /** Reference: `routes()`. */
  routes() {
    return routes.routes(this);
  }

  /** Reference: `route_names`. */
  routeNames() {
    return routes.routeNames(this);
  }

  /** Reference: `get_route`. */
  getRoute(name) {
    return routes.getRoute(this, name);
  }

  /** Reference: `next_free_route_name`. */
  nextFreeRouteName(base) {
    return routes.nextFreeRouteName(this, base);
  }

  /** Reference: `add_route`. */
  addRoute(candidate) {
    return routes.addRoute(this, candidate);
  }

  /** Reference: `upsert_route`: replaces or renames without moving other keys. */
  upsertRoute(name, data, currentName) {
    return routes.upsertRoute(this, name, data, currentName);
  }

  /** Reference: `remove_route`. */
  removeRoute(name) {
    return routes.removeRoute(this, name);
  }

  /** Reference: `rename_route`. */
  renameRoute(oldName, newName) {
    return routes.renameRoute(this, oldName, newName);
  }

  // ------------------------------------------------------------------
  // Settings, DNS, output and generation
  // ------------------------------------------------------------------

  /** Reference: `output_file`. */
  get outputFile() {
    return settings.outputFile(this);
  }

  /** Reference: `listen_ip`. */
  get listenIp() {
    return settings.listenIp(this);
  }

  /** Reference: `set_output_file`. */
  setOutputFile(value) {
    settings.setOutputFile(this, value);
  }

  /** Sets the free-form comment of the document. */
  setNote(value) {
    settings.setNote(this, value);
  }

  /** Values of the "Общие" form, with `urltest` passed through the core. */
  generalValues() {
    return settings.generalValues(this);
  }

  /** The checkbox list of «исключить из автовыбора». */
  excludePrefixOptions() {
    return settings.excludePrefixOptions(this);
  }

  /** Writes the "Общие" form into the document, merging nested blocks in place. */
  applyGeneral(values) {
    settings.applyGeneral(this, values);
  }

  /** The `dns` section as JSON text for the textarea. */
  dnsJson() {
    return settings.dnsJson(this);
  }

  /** Parses the DNS textarea and stores it. */
  applyDns(text) {
    return settings.applyDns(this, text);
  }

  /** Reference: `resolved_output_path`. */
  resolvedOutputPath() {
    return settings.resolvedOutputPath(this);
  }

  /** True when the generated `config.json` is on disk. */
  configExists() {
    return settings.configExists(this);
  }

  /** Generates `config.json` from the SAVED file; `wasDirty` tells the UI to say so. */
  generate(options) {
    return settings.generate(this, options);
  }

  // ------------------------------------------------------------------
  // Tree and stale references
  // ------------------------------------------------------------------

  /** Reference: `load_server_tags`, reduced to what most callers need. */
  loadServerTags() {
    return tree.loadServerTags(this);
  }

  /** `{section, name} -> [stale tags]` for the document. Reference: `stale_map`. */
  staleMap() {
    return tree.staleMap(this);
  }

  /** Tree of the project as plain data. Reference: `tree_spec`. */
  treeSpec(options) {
    return tree.treeSpec(this, options);
  }
}

// The document of the web editor — the module everything else imports.
//
// This file is a FACADE: the behaviour lives in `project/` and nothing here
// decides anything. It exists so that the published path and the published names
// stay the same while the implementation is split by topic:
//
//   session.mjs            open / new / save / reload, the dirty flag, snapshots
//   document.mjs           the fresh document, the v1 migration, the defaults
//   providers.mjs          discovery under the root, the «включён» flag, labels
//   tunnels.mjs            preview, normalisation, the «нужен» mark, the write path
//   tunnel-inventory.mjs   what exists, who uses it, what the System panel shows
//   proxies.mjs            the proxy CRUD and the pinned/tunnel refusals
//   routes.mjs             the route CRUD and the renames
//   settings.mjs           the general block, DNS, output_file, generation
//   tree.mjs               the project tree and the stale references
//   model.mjs              `ProjectModel`, the thin delegating public surface
//
// `ProjectModel` is the class the routes, the panel builders and the tests call.
// The module knows nothing about HTTP: a route parses a request, calls a method
// and hands the result to a template, which keeps the model testable without a
// server and keeps a future front end from touching anything but the view layer.

export {ProjectModel} from './project/model.mjs';

export {
  DOCUMENT_VERSION,
  DEFAULT_LISTEN_IP,
  DEFAULT_LOG_LEVEL,
  DEFAULT_OUTPUT_FILE,
  DEFAULT_PROXY_PORT,
  DEFAULT_PROXY_TAG,
  DEFAULT_PROXY_TYPE,
  DEFAULT_ROUTE_NAME,
  DEFAULT_URLTEST_INTERVAL,
  DEFAULT_URLTEST_TOLERANCE,
  DEFAULT_URLTEST_URL,
  PINNED_REFUSAL,
  TUNNEL_WITH_SERVERS_REFUSAL,
  assertUsableName,
  formatStats,
  migrateLegacyDocument,
  newDocument,
} from './project/document.mjs';

// `tagPrefix` and `PROXY_TYPES` were published from this path before the split
// and stay published: the panel and the tests import them by name.
export {tagPrefix} from './project/settings.mjs';
export {PROXY_TYPES} from '../core/errors.mjs';

// Directories of the build, in ONE place.
//
// These are constants of the deployment, not of a document and not of the host
// boundary. They used to live in two modules — the providers root in
// `sources.mjs`, the tunnel directory in `system/index.mjs` — which made the
// model import a constant from the system layer. They are kept together here so
// the write path, the fuse and the systemd unit cannot come from two sources.
//
// Both are still re-exported from where they were published before: the model
// and the deploy tests import them from those paths, and a re-export keeps the
// published names stable while the definition moves.

/** Default root of the provider folders (`GATEHOUSE_PROVIDERS`). */
export const DEFAULT_PROVIDERS_ROOT = '/var/lib/gatehouse/providers';

/** Default directory of the GateHouse tunnel configs (`GATEHOUSE_AMNEZIA_DIR`). */
export const DEFAULT_AMNEZIA_DIR = '/etc/gatehouse/tunnels';

// Shared helpers for the test suite.
//
// The tags, uuids and links are synthetic: they mirror conftest.py of the
// reference project so that the ported tests keep checking the same values.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures');
export const REPO_ROOT = path.join(import.meta.dirname, '..');

export const FI_TAG = '🇫🇮 Finland - Helsinki 1';
export const NL_TAG = '🇳🇱 Netherlands - Amsterdam';
export const RU_TAG = '🇷🇺 Russia - Moscow';
export const ALL_TAGS = [FI_TAG, NL_TAG, RU_TAG];

export const FI_UUID = '11111111-1111-1111-1111-111111111111';
export const NL_UUID = '22222222-2222-2222-2222-222222222222';
export const RU_UUID = '33333333-3333-3333-3333-333333333333';

/** Provider folder used by every temporary project. */
export const LINKS_PROVIDER = 'vpnd';

/**
 * Builds a VLESS link the way providers hand them out.
 * Reference: `vless_link()` in conftest.py of the reference project.
 *
 * @param {string} uuid
 * @param {string} host
 * @param {string} tag
 * @param {string} [query]
 * @param {number} [port]
 * @returns {string}
 */
export function vlessLink(uuid, host, tag, query = '', port = 443) {
  const queryPart = query ? `?${query}` : '';
  return `vless://${uuid}@${host}:${port}${queryPart}#${encodeURIComponent(tag)}`;
}

//: reality + tls + plain tcp — one link of each kind.
//: Reference: `DEFAULT_LINKS` in conftest.py.
export const DEFAULT_LINKS = `${[
  vlessLink(
    FI_UUID,
    'fi.example.com',
    FI_TAG,
    'security=reality&pbk=FI_PUBKEY&sid=ab12&sni=fi.example.com&flow=xtls-rprx-vision&fp=chrome',
  ),
  vlessLink(NL_UUID, 'nl.example.com', NL_TAG, 'security=tls&sni=nl.example.com&fp=firefox'),
  vlessLink(RU_UUID, 'ru.example.com', RU_TAG),
].join('\n')}\n`;

/**
 * Minimal flat settings body (version 2, sources): 3 servers, 2 proxies (one
 * with its own pool). Reference: `DEFAULT_SETTINGS` in conftest.py, without the
 * profile envelope and with the single links file replaced by one provider.
 */
export const DEFAULT_SETTINGS_BODY = {
  listen_ip: '127.0.0.1',
  sources: [LINKS_PROVIDER],
  output_file: 'config.json',
  exclude_from_auto: ['🇷🇺'],
  urltest: {url: 'https://gstatic.com', interval: '3m', tolerance: 50},
  log: {level: 'info', timestamp: true},
  dns: {servers: [{type: 'local', tag: 'dns-local'}], final: 'dns-local'},
  proxies: [
    {tag: 'main-socks', type: 'socks', port: 54321},
    {tag: 'apps-http', type: 'http', port: 54323, servers: [FI_TAG, NL_TAG]},
  ],
  routes: {
    telegram: {outbound: 'auto-select', domains: ['t.me', 'telegram.org']},
  },
};

/**
 * Creates a temporary directory for one test.
 *
 * @param {string} [prefix]
 * @returns {string}
 */
export function makeTempDir(prefix = 'singbox-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Writes the links file of the default provider: `<dir>/sources/vpnd/links.txt`.
 *
 * @param {string} dir
 * @param {string|Buffer} [content]
 * @returns {string} Path of the written file.
 */
export function writeLinksFile(dir, content = DEFAULT_LINKS) {
  const providerDir = path.join(dir, 'sources', LINKS_PROVIDER);
  fs.mkdirSync(providerDir, {recursive: true});
  const file = path.join(providerDir, 'links.txt');
  fs.writeFileSync(file, content);
  return file;
}

/**
 * Writes a flat `webui.json` (version 2), mirroring the `write_settings` fixture
 * of the reference (which wrote settings.yaml with the same overrides). Paths
 * inside stay relative to the directory of the file.
 *
 * @param {string} dir
 * @param {Record<string, unknown>} [overrides] Body overrides.
 * @param {{defaults?: Record<string, unknown>}} [extra] `defaults` is merged
 *   UNDER the overrides, which is how a test used to express a shared body; the
 *   flat document has no such level, so it is just a lower-priority default.
 * @returns {string} Path of the written file.
 */
export function writeSettings(dir, overrides = {}, extra = {}) {
  const document = {
    version: 2,
    ...DEFAULT_SETTINGS_BODY,
    ...(extra.defaults ?? {}),
    ...overrides,
  };
  const file = path.join(dir, 'webui.json');
  fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  return file;
}

/**
 * A temp directory with the provider links file and a webui.json next to it.
 * Reference: the `settings_file` fixture (settings.yaml next to links.txt).
 *
 * @param {Record<string, unknown>} [overrides]
 * @param {{defaults?: Record<string, unknown>, links?: string}} [extra]
 * @returns {{dir: string, settingsFile: string, linksFile: string}}
 */
export function makeProject(overrides = {}, extra = {}) {
  const dir = makeTempDir();
  const linksFile = writeLinksFile(dir, extra.links);
  const settingsFile = writeSettings(dir, overrides, extra);
  return {dir, settingsFile, linksFile};
}

/** Directory of the fake binaries the system-layer tests run instead of the real ones. */
export const FAKE_BIN_DIR = path.join(FIXTURES_DIR, 'bin');

/**
 * Makes the fake binaries executable and returns the directory.
 *
 * The executable bit is not part of the file content, so a checkout that lost it
 * (a zip, a copy through a filesystem without modes) would fail with EACCES
 * instead of exercising the code. Tests call this before spawning a fake.
 *
 * @returns {string}
 */
export function ensureFakeBins() {
  for (const name of fs.readdirSync(FAKE_BIN_DIR)) {
    fs.chmodSync(path.join(FAKE_BIN_DIR, name), 0o755);
  }
  return FAKE_BIN_DIR;
}

/**
 * Environment for the system layer, pointed at the fakes of `tests/fixtures/bin`.
 *
 * `GATEHOUSE_SUDO` points at the fake `systemctl`: `restartSingBox` runs
 * `sudo -n <systemctl> restart <unit>`, and the tests observe its argv without
 * touching sudo or systemd.
 *
 * @param {Record<string, string>} [overrides]
 * @returns {Record<string, string>}
 */
export function fakeSystemEnv(overrides = {}) {
  const bin = ensureFakeBins();
  return {
    GATEHOUSE_SINGBOX: path.join(bin, 'sing-box'),
    GATEHOUSE_SYSTEMCTL: path.join(bin, 'systemctl'),
    GATEHOUSE_JOURNALCTL: path.join(bin, 'journalctl'),
    GATEHOUSE_SUDO: path.join(bin, 'systemctl'),
    GATEHOUSE_UNIT: 'sing-box',
    GATEHOUSE_TEST_URL: 'https://ipinfo.io',
    ...overrides,
  };
}

/** Path of the fake `systemctl`, which the tunnel sudoers rules must name. */
export const FAKE_SYSTEMCTL = path.join(FAKE_BIN_DIR, 'systemctl');

/**
 * Environment additions for the tunnel tests: where the applied `.conf` goes, the
 * sudoers file to read, and the two systemd axes of the fake `systemctl`.
 *
 * @param {string} dir Temporary project directory.
 * @param {{active?: string[], enabled?: string[], sudoers?: string|null}} [options]
 * @returns {Record<string, string>}
 */
export function tunnelSystemEnv(dir, options = {}) {
  return {
    GATEHOUSE_AMNEZIA_DIR: path.join(dir, 'amnezia'),
    GATEHOUSE_SUDOERS: options.sudoers ?? path.join(dir, 'sudoers-gatehouse'),
    FAKE_SYSTEMCTL_ACTIVE: (options.active ?? []).join(','),
    FAKE_SYSTEMCTL_ENABLED: (options.enabled ?? []).join(','),
  };
}

/**
 * Writes a sudoers file with the three rules of every named tunnel, in the exact
 * shape the panel offers for pasting.
 *
 * @param {string} file
 * @param {string[]} tunnels
 * @param {{user?: string, systemctl?: string}} [options] `systemctl` must match
 *   `GATEHOUSE_SYSTEMCTL`, because `parseTunnelSudoers` looks for that path.
 * @returns {string} Path of the written file.
 */
export function writeSudoers(file, tunnels, options = {}) {
  const user = options.user ?? 'denis';
  const systemctl = options.systemctl ?? FAKE_SYSTEMCTL;
  const lines = [];
  for (const name of tunnels) {
    lines.push(`${user} ALL=(root) NOPASSWD: ${systemctl} enable --now gatehouse-tunnel@${name}`);
    lines.push(`${user} ALL=(root) NOPASSWD: ${systemctl} disable --now gatehouse-tunnel@${name}`);
    lines.push(`${user} ALL=(root) NOPASSWD: ${systemctl} restart gatehouse-tunnel@${name}`);
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

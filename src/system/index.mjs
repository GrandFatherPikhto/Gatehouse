// System boundary of the web editor: the only module allowed to touch the host.
//
// Stage 2 ships stubs here on purpose. Everything that needs a machine with
// sing-box on it — `sing-box check`, the daemon restart, journalctl, the live
// outbound test, geosite — lives behind these five functions and nowhere else.
// That is what keeps stage 2 developable and testable on a desktop where
// sing-box is not installed, without a router, without root and without network.
//
// Stage 3 replaces the bodies of these functions and touches nothing else. When
// it does, the rule is already fixed: only `execFile`/`spawn` with an argument
// array, never a shell string. Tags look like `🇨🇾 Cyprus - Limassol`; they break
// a shell command line with no attacker involved, and quoting them by hand is
// exactly the bug this rule exists to prevent.
//
// Signatures are part of the contract with stage 3, so they are documented with
// the commands they will run even though the bodies only throw today.

/** Thrown by every stub of this module until stage 3 implements the call. */
export class NotImplementedError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

/** Marker every stub message carries, so tests and the UI can match on it. */
export const STAGE_MARKER = 'не реализовано (этап 3)';

/**
 * Throws the stage marker for one system call.
 *
 * @param {string} name Function name, repeated in the message.
 * @param {string} planned What stage 3 is expected to run instead.
 * @returns {never}
 */
function notImplemented(name, planned) {
  throw new NotImplementedError(`${name}: ${STAGE_MARKER} — ${planned}`);
}

/**
 * Restarts the sing-box daemon.
 * Stage 3: `execFile('systemctl', ['restart', 'sing-box'])`.
 *
 * @returns {never}
 */
export function restartSingBox() {
  notImplemented('restartSingBox', 'потребуется systemctl restart sing-box');
}

/**
 * Runs `sing-box check` over the generated config.
 * Stage 3: `execFile('sing-box', ['check', '-c', configPath])`.
 *
 * @param {string} configPath Path of the config to check.
 * @returns {never}
 */
export function checkConfig(configPath) {
  notImplemented(
    'checkConfig',
    `потребуется sing-box check -c ${String(configPath)}`,
  );
}

/**
 * Reads the tail of the daemon log.
 * Stage 3: `execFile('journalctl', ['-u', 'sing-box', '-n', String(lines), '--no-pager'])`.
 *
 * @param {number} [lines] How many lines to read.
 * @returns {never}
 */
export function tailJournal(lines = 200) {
  notImplemented(
    'tailJournal',
    `потребуется journalctl -u sing-box -n ${String(lines)} --no-pager`,
  );
}

/**
 * Tests one outbound through the daemon (the replacement of the reference
 * `curl_test`/`live_test`).
 * Stage 3: `execFile('sing-box', ['tools', 'fetch', '-c', configPath, '-o', tag, url])`
 * — the tag is passed as its own array element precisely because of the emoji
 * and the spaces in it.
 *
 * @param {string} tag Outbound tag to test.
 * @param {{configPath?: string, url?: string}} [options]
 * @returns {never}
 */
export function testOutbound(tag, options = {}) {
  const configPath = options.configPath ?? '<config.json>';
  const url = options.url ?? 'https://ipinfo.io';
  notImplemented(
    'testOutbound',
    `потребуется sing-box tools fetch -c ${String(configPath)} -o ${String(tag)} ${String(url)}`,
  );
}

/**
 * Looks a domain up in the geosite database.
 * Stage 3: `execFile('sing-box', ['geosite', 'lookup', domain])`.
 *
 * @param {string} domain Domain to look up.
 * @returns {never}
 */
export function geositeLookup(domain) {
  notImplemented(
    'geositeLookup',
    `потребуется sing-box geosite lookup ${String(domain)}`,
  );
}

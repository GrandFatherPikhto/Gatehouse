// Settings loading (webui.json), schema validation and file output.
//
// Replaces `load_settings`, `resolve_path`, `write_json` and
// `generate_config_file` of the reference
// /home/yevstigneyevda/Projects/Python/SingBoxTools/sing_box_manager.py
//
// The reference kept everything in one flat YAML file. `webui.json` version 1
// wrapped that flat body in a `defaults` + `profiles` + `active` envelope; since
// version 2 the document is flat again, so the core receives exactly the shape
// the reference expected. That is what keeps the generated `config.json`
// byte-identical to the reference output.
//
// The profile envelope is gone but not forgotten: a version-1 file is refused
// here with a message naming the editor, which is the only thing that migrates
// it (see `ProjectModel.open`). Refusing instead of half-merging means the CLI
// path can never write a `config.json` from an unmigrated document.

import fs from 'node:fs';
import path from 'node:path';

import Ajv from 'ajv';

import {buildConfig} from './build.mjs';
import {ConfigError, DEFAULT_SETTINGS_FILE, isMapping} from './errors.mjs';
import {collisionRefusal, readProviders, resolveProvidersRoot} from './sources.mjs';
import {parseLinks} from './vless.mjs';
import {buildXrayConfig, resolveXrayPorts, xrayEntries, xraySocksOutbound} from './xray.mjs';

const SCHEMA_URL = new URL('../schemas/webui.schema.json', import.meta.url);
const SCHEMA = JSON.parse(fs.readFileSync(SCHEMA_URL, 'utf8'));

const ajv = new Ajv({allErrors: true});

const validateAgainstSchema = ajv.compile(SCHEMA);

/**
 * Top-level keys that only exist in the version-1 (profile-level) document.
 * Their presence is what makes a file legacy, not its `version`: a hand-edited
 * file may carry a stale version number, while the shape is what really breaks
 * the flat loader.
 */
export const LEGACY_KEYS = Object.freeze(['profiles', 'defaults', 'active', 'links_file']);

/**
 * Top-level keys that left the project and are dropped BEFORE the schema sees
 * them, because the schema is strict and the owner's live `webui.json` still
 * carries them.
 *
 *   * `watchdog` and `clash_api` belonged to the Watchdog (part B of
 *     techdocs/plan_2026_09_23_gatehouse_fuse_and_no_watchdog.md);
 *   * `amnezia_dir` was a per-document tunnel directory. It is gone because the
 *     tunnel directory became a single constant of the build: the template unit
 *     reads a fixed path, so a document value could aim the start-up fuse at one
 *     file and the unit at another;
 *   * `sources` was the hand-written list of provider origins. Providers are now
 *     DISCOVERED by folder under `GATEHOUSE_PROVIDERS`. The editor migrates the
 *     field into `providers` on open (see `ProjectModel#migrateSourcesToProviders`);
 *     this entry is the safety net for the CLI, which must not half-read a
 *     document the schema no longer knows.
 *
 * The file itself is not rewritten here: the keys disappear on the next ordinary
 * save.
 */
export const REMOVED_KEYS = Object.freeze([
  'watchdog',
  'clash_api',
  'amnezia_dir',
  'sources',
]);

/** Keys of a proxy that the Watchdog wrote, dropped with the rest. */
export const REMOVED_PROXY_KEYS = Object.freeze(['watch', 'watch_url']);

/**
 * True for a version-1 document with the profile envelope. The editor uses the
 * same predicate to decide whether a file has to be migrated.
 *
 * @param {unknown} data
 * @returns {boolean}
 */
export function isLegacyDocument(data) {
  return isMapping(data) && LEGACY_KEYS.some((key) => Object.hasOwn(data, key));
}

/**
 * Drops the fields of the removed Watchdog, IN PLACE, and returns their names.
 *
 * One function for both entry points — `loadSettings` here and `ProjectModel.open`
 * — so the editor and `tools/generate.mjs` can never disagree about which fields
 * are stale (part B.2 of the task). Nothing else is touched: the document is not
 * rewritten, `version` is not bumped, and the fields disappear from the file only
 * on the next ordinary save.
 *
 * @param {unknown} data Parsed document, modified in place.
 * @returns {string[]} Names of the dropped fields, in document order.
 */
export function dropRemovedSettings(data) {
  if (!isMapping(data)) return [];

  const dropped = [];

  for (const key of REMOVED_KEYS) {
    if (!Object.hasOwn(data, key)) continue;
    delete data[key];
    dropped.push(key);
  }

  if (Array.isArray(data.proxies)) {
    data.proxies.forEach((proxy, index) => {
      if (!isMapping(proxy)) return;
      for (const key of REMOVED_PROXY_KEYS) {
        if (!Object.hasOwn(proxy, key)) continue;
        delete proxy[key];
        dropped.push(`proxies[${index}].${key}`);
      }
    });
  }

  return dropped;
}

/**
 * The one line the editor shows and `tools/generate.mjs` prints to stderr.
 *
 * @param {string[]} dropped
 * @returns {string}
 */
export function removedSettingsMessage(dropped) {
  return (
    `убраны устаревшие поля: ${dropped.join(', ')}; ` +
    'сохраните, чтобы они исчезли из файла'
  );
}

/**
 * Validates a parsed webui.json. Throws ConfigError listing every problem.
 *
 * @param {unknown} data
 * @param {string} source File name used in the message.
 */
export function validateSettings(data, source = DEFAULT_SETTINGS_FILE) {
  if (isLegacyDocument(data)) {
    throw new ConfigError(
      `${source}: это webui.json старого формата (profiles/defaults или поле links_file). ` +
        'Откройте файл один раз в редакторе GateHouse: он развернёт единственный профиль, ' +
        'отбросит links_file, включит найденные провайдеры со ссылками, поднимет version ' +
        'до 2 и сохранит снимок. ' +
        'Генератор по такому файлу не работает, чтобы не мигрировать его наполовину.',
    );
  }

  if (validateAgainstSchema(data)) return;

  const problems = (validateAgainstSchema.errors || []).map(
    (error) => `${error.instancePath || '/'}: ${error.message}`,
  );
  throw new ConfigError(
    `${source}: настройки не соответствуют схеме webui.json:\n  - ${problems.join('\n  - ')}`,
  );
}

/**
 * Loads and validates webui.json.
 * Reference: `load_settings` (which threw ConfigError for a missing file).
 *
 * @param {string} settingsPath
 * @param {{dropped?: string[]}} [options] `dropped` collects the names of the
 *   removed fields, for the caller that has to report them.
 * @returns {Record<string, unknown>} Parsed settings.
 */
export function loadSettings(settingsPath, options = {}) {
  if (!fs.existsSync(settingsPath)) {
    throw new ConfigError(`файл настроек ${settingsPath} не найден`);
  }
  let text;
  try {
    text = fs.readFileSync(settingsPath, 'utf8');
  } catch (error) {
    throw new ConfigError(`ошибка чтения JSON ${settingsPath}: ${error.message}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`ошибка чтения JSON ${settingsPath}: ${error.message}`);
  }

  // The fields of the removed Watchdog go BEFORE the schema sees them: the owner's
  // file on the router still carries `watchdog`, `clash_api` and the per-proxy
  // `watch` / `watch_url`, and the schema is strict. The file itself is not
  // rewritten — the fields disappear on the next ordinary save.
  const dropped = dropRemovedSettings(data);
  if (Array.isArray(options.dropped)) options.dropped.push(...dropped);

  validateSettings(data, settingsPath);
  return data;
}

/**
 * Loads the settings and strips what the core must not see: `version` is a
 * document-format marker, `note` fields are comments for humans. Returns the
 * flat body the reference expected, plus the directory relative paths resolve
 * against.
 *
 * Replaces `loadProfileSettings` of the version-1 code: with the profile level
 * gone there is nothing to merge, only noise to drop.
 *
 * @param {string} settingsPath
 * @returns {{settings: Record<string, unknown>, settingsDir: string,
 *   raw: Record<string, unknown>, dropped: string[]}} `dropped` names the fields
 *   of the removed Watchdog that were in the file.
 */
export function loadEffectiveSettings(settingsPath) {
  const dropped = [];
  const raw = loadSettings(settingsPath, {dropped});
  const settings = {};

  for (const [key, value] of Object.entries(raw)) {
    if (key === 'version' || key === 'note') continue;
    settings[key] = value;
  }

  if (Array.isArray(settings.proxies)) {
    settings.proxies = settings.proxies.map((proxy) => {
      if (!isMapping(proxy) || !Object.hasOwn(proxy, 'note')) return proxy;
      const {note, ...rest} = proxy;
      return rest;
    });
  }

  return {
    settings,
    settingsDir: path.dirname(path.resolve(settingsPath)),
    raw,
    dropped,
  };
}

/**
 * Resolves a path against a base directory, like the reference `resolve_path`:
 * absolute paths are returned untouched, relative ones are joined to the
 * directory of the settings file, so the generator can be started from anywhere.
 *
 * @param {string} baseDir
 * @param {string} target
 * @returns {string}
 */
export function resolvePath(baseDir, target) {
  return path.isAbsolute(target) ? target : path.join(baseDir, target);
}

/**
 * Serialises the config exactly like the reference did:
 * `json.dump(config, f, indent=2, ensure_ascii=False)` — two-space indent,
 * emoji as is, and NO trailing newline.
 *
 * @param {unknown} config
 * @returns {string}
 */
export function stringifyConfig(config) {
  return JSON.stringify(config, null, 2);
}

/**
 * Writes the config, creating missing directories.
 * Reference: `write_json`.
 *
 * @param {string} filePath
 * @param {unknown} config
 */
export function writeJson(filePath, config) {
  const directory = path.dirname(filePath);
  if (directory && !fs.existsSync(directory)) {
    fs.mkdirSync(directory, {recursive: true});
  }
  fs.writeFileSync(filePath, stringifyConfig(config), 'utf8');
}

/**
 * Builds and writes config.json.
 * Reference: `generate_config_file` — same override order, same error cases.
 *
 * @param {string} settingsPath
 * @param {{output?: string, links?: string, listenIp?: string, excludeFromAuto?: unknown[], warnings?: string[], runningTunnels?: Set<string>, providersRoot?: string}} [options]
 *   `providersRoot` overrides the `GATEHOUSE_PROVIDERS` root the reader would
 *   otherwise take from the environment; the editor passes the root it resolved
 *   for the panel, so both look at the same folders.
 * @returns {{outputFile: string, stats: Record<string, unknown>, warnings: string[], config: Record<string, unknown>}}
 */
export function generateConfigFile(settingsPath, options = {}) {
  const warnings = options.warnings || [];
  const {settings, settingsDir, dropped} = loadEffectiveSettings(settingsPath);

  // The fields the Watchdog left behind are named in stderr, and generation goes
  // on: the owner has to be told, but a stale field is not a reason to fail.
  if (dropped.length > 0) warnings.push(removedSettingsMessage(dropped));

  const outputFile = resolvePath(
    settingsDir,
    options.output || settings.output_file || 'config.json',
  );
  const listenIp = options.listenIp || settings.listen_ip || '127.0.0.1';
  if (typeof listenIp !== 'string' || listenIp.length === 0) {
    throw new ConfigError('listen_ip должен быть непустой строкой');
  }

  const override = options.excludeFromAuto;
  const effective =
    override === undefined || override === null
      ? settings
      : {...settings, exclude_from_auto: override};

  const build = readBuild(settings, settingsDir, options.links, warnings, options.providersRoot);
  // `runningTunnels` is the set of tunnel interfaces the caller found up in
  // systemd. It only feeds the §5.4 warning about a proxy on a stopped tunnel;
  // `undefined` means "not asked", which adds no warning.
  const [config, stats] = buildConfig(effective, build.outbounds, listenIp, warnings, {
    runningTunnels: options.runningTunnels,
  });
  writeJson(outputFile, config);

  // `xray` carries the servers, their ports and the freshly handed ones; the web
  // layer needs them to persist `xray.ports` and to write the Xray config.
  return {outputFile, stats, warnings, config, xray: build.xray};
}

/**
 * Reads the outbounds of a generation run.
 *
 * `linksOverride` is the CLI `--links` flag: a single file, read exactly as the
 * version-2 code did, so a script that pins one list keeps working. Otherwise the
 * DISCOVERED providers are read and only the ENABLED ones contribute their
 * servers; a provider that was never ticked is found and disabled, so a new folder
 * on disk cannot move `config.json` by itself.
 *
 * When nothing enabled produced a server the generation REFUSES and names why —
 * the disabled ones, the unreadable ones, an absent root. It must not fall back
 * to `auto-select` or `direct`: a proxy whose servers vanished has to break the
 * generation, not silently send traffic somewhere else.
 *
 * @param {Record<string, unknown>} settings
 * @param {string} settingsDir
 * @param {string|undefined} linksOverride
 * @param {string[]} warnings
 * @param {string|undefined} providersRoot
 * @returns {Array<Record<string, unknown>>}
 */
/**
 * Builds the `config.json` object from a settings file WITHOUT writing anything.
 *
 * Used by the apply bar to compare "what the saved document would produce" with
 * the bytes of the live `config.json` — the comparison must not touch the file
 * (§1.1). It reuses exactly the same reader and assembly as `generateConfigFile`,
 * so the two cannot drift apart.
 *
 * @param {string} settingsPath
 * @param {{links?: string, listenIp?: string, providersRoot?: string,
 *   warnings?: string[]}} [options]
 * @returns {Record<string, unknown>}
 */
export function previewConfig(settingsPath, options = {}) {
  return previewPair(settingsPath, options).config;
}

/**
 * Builds BOTH configurations of the saved document, without writing anything.
 *
 * This is what the apply bar compares with the live pair (§4) and what the web
 * layer writes on `/apply`. It reuses exactly the reader and the assembly of the
 * generator, so a preview can never drift from a generation. `xrayConfig` is
 * `null` when no server goes through Xray: then there is no Xray config to check
 * or apply, and the service is stopped instead.
 *
 * @param {string} settingsPath
 * @param {{links?: string, listenIp?: string, providersRoot?: string,
 *   warnings?: string[]}} [options]
 * @returns {{config: Record<string, unknown>, xrayConfig: Record<string, unknown>|null,
 *   xray: {servers: Array<Record<string, unknown>>, ports: Record<string, number>,
 *   assigned: Record<string, number>, range: [number, number]|null},
 *   warnings: string[]}}
 */
export function previewPair(settingsPath, options = {}) {
  const warnings = options.warnings || [];
  const {settings, settingsDir} = loadEffectiveSettings(settingsPath);
  const listenIp = options.listenIp || settings.listen_ip || '127.0.0.1';
  const build = readBuild(settings, settingsDir, options.links, warnings, options.providersRoot);
  const [config] = buildConfig(settings, build.outbounds, listenIp, warnings, {});
  const xrayConfig =
    build.xray.servers.length > 0
      ? buildXrayConfig(xrayEntries(build.xray.servers, build.xray.ports))
      : null;
  return {config, xrayConfig, xray: build.xray, warnings};
}

/**
 * Builds the Xray configuration of the saved document, without writing it. The
 * counterpart of `previewConfig` for the second engine.
 *
 * @param {string} settingsPath
 * @param {Parameters<typeof previewPair>[1]} [options]
 * @returns {Record<string, unknown>|null}
 */
export function previewXrayConfig(settingsPath, options = {}) {
  return previewPair(settingsPath, options).xrayConfig;
}

/**
 * Writes the generated Xray config with mode `0640`.
 *
 * `/etc/xray` is `denis:xray 2750`: the file is written by GateHouse (running as
 * `denis`) and read by `xray` through the GROUP; the setgid bit of the directory
 * gives the file the `xray` group. `0600` would make the daemon fail to read it,
 * while `xray run -test` as `denis` would still pass — hence the explicit mode
 * and a test that checks it (§3.3).
 *
 * @param {string} filePath
 * @param {unknown} config
 */
export function writeXrayConfig(filePath, config) {
  const directory = path.dirname(filePath);
  if (directory && !fs.existsSync(directory)) {
    fs.mkdirSync(directory, {recursive: true});
  }
  fs.writeFileSync(filePath, stringifyConfig(config), {encoding: 'utf8', mode: 0o640});
  // `writeFileSync` applies the mode only when it CREATES the file; a rewrite of
  // an existing file keeps its old mode, so it is set explicitly.
  fs.chmodSync(filePath, 0o640);
}

/**
 * Builds and writes the Xray configuration of the saved document.
 *
 * Writes NOTHING when no server goes through Xray: the owner has no Xray servers
 * and the file must not appear out of nowhere (§4, step 5 of the chain). The
 * caller decides whether to stop the service.
 *
 * @param {string} settingsPath
 * @param {{xrayConfig?: string, links?: string, providersRoot?: string,
 *   warnings?: string[]}} [options] `xrayConfig` is the target path.
 * @returns {{outputFile: string, xrayConfig: Record<string, unknown>|null,
 *   xray: {servers: Array<Record<string, unknown>>, ports: Record<string, number>,
 *   assigned: Record<string, number>, range: [number, number]|null},
 *   warnings: string[]}}
 */
export function generateXrayConfigFile(settingsPath, options = {}) {
  const pair = previewPair(settingsPath, options);
  const settingsDir = path.dirname(path.resolve(settingsPath));
  const outputFile = resolvePath(settingsDir, options.xrayConfig || 'xray/config.json');
  if (pair.xrayConfig !== null) writeXrayConfig(outputFile, pair.xrayConfig);
  return {
    outputFile,
    xrayConfig: pair.xrayConfig,
    xray: pair.xray,
    warnings: pair.warnings,
  };
}

/** Empty Xray half of a build, for the paths that carry no Xray servers. */
function emptyXray() {
  return {servers: [], ports: {}, assigned: {}, range: null};
}

/**
 * Reads every outbound a generation run needs: the sing-box outbounds of the
 * links providers PLUS a `socks` outbound per Xray server, and the Xray half
 * (servers, the port of each, the freshly handed ones).
 *
 * @param {Record<string, unknown>} settings
 * @param {string} settingsDir
 * @param {string|undefined} linksOverride
 * @param {string[]} warnings
 * @param {string|undefined} providersRoot
 * @returns {{outbounds: Array<Record<string, unknown>>, xray: ReturnType<typeof emptyXray>}}
 */
function readBuild(settings, settingsDir, linksOverride, warnings, providersRoot) {
  if (typeof linksOverride === 'string' && linksOverride.length > 0) {
    return {outbounds: parseLinks(resolvePath(settingsDir, linksOverride), warnings), xray: emptyXray()};
  }

  const root =
    typeof providersRoot === 'string' && providersRoot.length > 0
      ? providersRoot
      : resolveProvidersRoot(settingsDir);
  const read = readProviders(settings.providers, root, warnings);

  // Two enabled providers handing out the same server name must stop the
  // generation: silently picking one would put traffic on an exit the owner did
  // not choose. The refusal names the providers and the colliding names (§2.2).
  const refusal = collisionRefusal(read.collisions);
  if (refusal !== null) throw new ConfigError(refusal);

  const xrayServers = read.xrayServers.map((item) => item.server);

  if (read.outbounds.length === 0 && xrayServers.length === 0) {
    // A document whose proxies still carry a TUNNEL has a real exit even with no
    // subscription provider: the build closes the ports of the proxies whose
    // servers are gone (§1.2 of the missing-servers task) and keeps the tunnels.
    // Refusing here would send the owner back to hand-editing `webui.json` just
    // because a provider folder was renamed.
    const proxies = Array.isArray(settings.proxies) ? settings.proxies : [];
    const hasTunnels = proxies.some((proxy) => isMapping(proxy) && isMapping(proxy.tunnel));
    // An auto-select-only proxy would follow `route.final`; with no servers that
    // fallback is `direct`, which would send its traffic straight out — the very
    // «silently somewhere else» this refusal exists to prevent. Only a document
    // whose ordinary proxies all pin their own servers (and which the build then
    // closes with a warning) may proceed on its tunnels alone.
    const leaksToAutoSelect = proxies.some((proxy) => {
      if (!isMapping(proxy) || isMapping(proxy.tunnel)) return false;
      const servers = proxy.servers;
      if (typeof servers === 'string') return servers.length === 0;
      return !Array.isArray(servers) || servers.length === 0;
    });
    if (hasTunnels && !leaksToAutoSelect) {
      warnings.push(
        'Предупреждение: ни одного включённого провайдера со ссылками — ' +
          'работают только туннельные выходы',
      );
      return {outbounds: [], xray: emptyXray()};
    }

    const reasons = [];
    if (read.rootState.message !== null) reasons.push(read.rootState.message);
    for (const entry of read.unread) reasons.push(`${entry.id}: ${entry.error}`);
    const disabledIds = [];
    for (const provider of read.providers) {
      if (provider.kind === null) {
        // Enabled, but the folder does not say what it is: name the real reason
        // instead of pretending the record was disabled (§0.3).
        if (provider.hasRecord === true && provider.record.enabled === true) {
          const why =
            provider.contentKind === 'mixed'
              ? 'папка смешанная — разнесите ссылки и конфиги'
              : provider.contentKind === 'empty'
                ? 'папка пуста'
                : provider.contentKind === 'denied'
                  ? 'нет доступа к папке'
                  : provider.contentKind === 'unreadable'
                    ? 'папку не удалось прочитать'
                    : 'вид не выводится из содержимого';
          reasons.push(`провайдер '${provider.id}' включён, но вид папки не задан: ${why}`);
        }
        continue;
      }
      // An enabled provider whose chosen file is missing, empty or unreadable
      // produces nothing; the owner is told the REAL reason instead of a bare
      // «нет включённых провайдеров» (task 20 §0).
      if (provider.enabled === true && provider.state !== 'ok' && typeof provider.error === 'string') {
        reasons.push(`провайдер '${provider.id}': ${provider.error}`);
      }
      if (provider.enabled !== true && provider.hasRecord === true) disabledIds.push(provider.id);
    }
    if (disabledIds.length > 0) {
      reasons.push(`найдены и выключены: ${disabledIds.join(', ')}`);
    }
    const reason = reasons.length > 0 ? `\n  - ${reasons.join('\n  - ')}` : '';
    throw new ConfigError(
      `не найдено ни одного включённого провайдера со ссылками${reason}`,
    );
  }

  // The ports of the Xray front end: a stored port is kept by its server, a new
  // one takes the smallest free in the range, and a sing-box proxy port is never
  // crossed (§2).
  const reservedPorts = (Array.isArray(settings.proxies) ? settings.proxies : [])
    .filter((proxy) => isMapping(proxy))
    .map((proxy) => Number(proxy.port))
    .filter((port) => Number.isInteger(port));
  const resolved = resolveXrayPorts(xrayServers, settings.xray, reservedPorts);

  const socks = xrayServers.map((server) =>
    xraySocksOutbound(server, resolved.ports[server.key]),
  );

  return {
    outbounds: [...read.outbounds, ...socks],
    xray: {
      servers: xrayServers,
      ports: resolved.ports,
      assigned: resolved.assigned,
      range: resolved.range,
    },
  };
}

export {SCHEMA, DEFAULT_SETTINGS_FILE};


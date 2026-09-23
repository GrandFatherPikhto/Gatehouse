// Shape, constants and pure helpers of `webui.json`.
//
// Everything here is stateless: the fresh document, the one-time migration of a
// version-1 file, the summary of a generation run, and the name rules a form
// shares with the schema. The stateful half is `session.mjs`; the per-topic
// methods live next to their own theme (providers, tunnels, proxies, routes,
// settings, tree).

import {ConfigError, DEFAULT_EXCLUDE, isMapping} from '../../core/errors.mjs';
import {isTunnelProxy} from '../../core/validate.mjs';

/* Defaults of the reference (generator/model.py). */
export const DEFAULT_LISTEN_IP = '127.0.0.1';
export const DEFAULT_OUTPUT_FILE = 'config.json';
export const DEFAULT_URLTEST_URL = 'https://gstatic.com';
export const DEFAULT_URLTEST_INTERVAL = '3m';
export const DEFAULT_URLTEST_TOLERANCE = 50;
export const DEFAULT_LOG_LEVEL = 'info';

/* Defaults of the web editor itself. */
export const DEFAULT_PROXY_PORT = 54321;
export const DEFAULT_PROXY_TYPE = 'socks';
export const DEFAULT_PROXY_TAG = 'new-proxy';
export const DEFAULT_ROUTE_NAME = 'route';

/** Document format this build writes; 1 was the profile-level envelope. */
export const DOCUMENT_VERSION = 2;

/**
 * Refusal shown when a pinned proxy would end up with a pool. The wording is
 * fixed by the task: an accidental second server is exactly what the flag exists
 * to prevent, and the owner has to be told how to lift the mark.
 */
export const PINNED_REFUSAL = 'у прокси зафиксирован выход — снимите отметку, если нужен пул';

/**
 * Refusal shown when a tunnel proxy would also carry a server list. §5.1 of the
 * task: one tunnel — one proxy — one exit; mixing it with a pool would put the
 * "which exit did it actually take" question right back.
 */
export const TUNNEL_WITH_SERVERS_REFUSAL =
  'у туннельного прокси не может быть серверов: один туннель — один выход';

/**
 * A name made of digits only is refused by the schema, and for a reason that
 * also has to be enforced here: JavaScript reorders integer-like object keys, so
 * such a name would jump to the front of the file and the byte order of
 * `webui.json` (and of the `routes` section of `config.json`) would stop being
 * predictable. The schema is the source of truth; this regex mirrors its
 * `pattern` and a test asserts the two agree.
 */
const DIGIT_ONLY_NAME = /^\d+$/;

/**
 * Builds a fresh, minimal flat document — the port of `NEW_SETTINGS_TEMPLATE` of
 * the reference, without the profile envelope.
 *
 * @returns {Record<string, unknown>}
 */
export function newDocument() {
  return {
    version: DOCUMENT_VERSION,
    listen_ip: DEFAULT_LISTEN_IP,
    providers: {},
    output_file: DEFAULT_OUTPUT_FILE,
    exclude_from_auto: [...DEFAULT_EXCLUDE],
    urltest: {
      url: DEFAULT_URLTEST_URL,
      interval: DEFAULT_URLTEST_INTERVAL,
      tolerance: DEFAULT_URLTEST_TOLERANCE,
    },
    log: {level: DEFAULT_LOG_LEVEL, timestamp: true},
    dns: {servers: [], rules: [], final: 'dns-local'},
    proxies: [],
    routes: {},
  };
}

/**
 * Flattens a version-1 document and drops its `links_file`.
 *
 * The envelope (`defaults`/`profiles`/`active`) is flattened here. More than one
 * profile is NOT guessed — the owner picked the active one for a reason — so the
 * file is refused with the names; a single body is spread on top of a merged
 * `defaults` (the profile is stronger), with one warning per migrated key.
 *
 * `links_file` is only DROPPED and reported: which providers to enable depends on
 * the folders on disk, so the folder work is `migrateProviders` of
 * `providers.mjs`, which `open` runs with the resolved providers root.
 * `linksFile` carries the old value so `open` knows it has to enable every
 * provider that holds a `links.txt`.
 *
 * @param {Record<string, unknown>} data Parsed legacy document.
 * @param {string} [source] File name used in the messages.
 * @returns {{document: Record<string, unknown>, warnings: string[], linksFile: string|null}}
 */
export function migrateLegacyDocument(data, source = 'webui.json') {
  const warnings = [];
  let merged;

  if (isMapping(data.profiles)) {
    const profiles = data.profiles;
    const names = Object.keys(profiles);

    if (names.length === 0) {
      throw new ConfigError(
        `${source}: это документ старого формата, но без профилей: мигрировать нечего. ` +
          'Схема webui.json версии 2 их больше не знает — приведите файл к плоскому виду вручную.',
      );
    }
    if (names.length > 1) {
      throw new ConfigError(
        `${source}: в файле несколько профилей (${names.join(', ')}) — автоматически развернуть ` +
          'можно только один. Выберите активный, удалите остальные руками и откройте файл снова: ' +
          'молча выбросить чужие настройки хуже, чем остановиться.',
      );
    }

    const name = names[0];
    const body = isMapping(profiles[name]) ? profiles[name] : {};
    const defaults = isMapping(data.defaults) ? data.defaults : {};

    for (const key of Object.keys(defaults)) {
      if (Object.hasOwn(body, key)) {
        warnings.push(
          `Предупреждение: ключ '${key}' из defaults перекрыт значением профиля '${name}' и не перенесён`,
        );
      } else {
        warnings.push(`Предупреждение: ключ '${key}' из defaults перенесён на верхний уровень`);
      }
    }

    merged = {...defaults, ...body};
    delete merged.profiles;
    delete merged.defaults;
    delete merged.active;
  } else {
    merged = {...data};
  }

  let linksFile = null;
  if (typeof merged.links_file === 'string' && merged.links_file.length > 0) {
    linksFile = merged.links_file;
    delete merged.links_file;
    warnings.push(
      `Предупреждение: поле links_file '${linksFile}' отброшено: ` +
        'провайдеры теперь читаются из папок под GATEHOUSE_PROVIDERS',
    );
  }

  return {document: {version: DOCUMENT_VERSION, ...merged}, warnings, linksFile};
}

/**
 * Human readable summary of a generation run.
 * Reference: `format_stats` of generator/model.py.
 *
 * @param {string} outputFile
 * @param {Record<string, unknown>} stats
 * @param {string[]} [warnings]
 * @returns {string}
 */
export function formatStats(outputFile, stats, warnings = []) {
  const lines = [
    `Конфиг сгенерирован: ${outputFile}`,
    `Серверов: ${stats.servers}, инбаундов: ${stats.inbounds}, пулов: ${stats.pools}`,
  ];
  for (const proxy of stats.proxies ?? []) {
    const target = isTunnelProxy(proxy)
      ? `туннель ${proxy.tunnel.interface}`
      : proxy.servers.length > 0
        ? proxy.servers.join(', ')
        : 'auto-select';
    lines.push(`  [${proxy.type.toUpperCase()}] ${proxy.tag} : port ${proxy.port} -> ${target}`);
  }
  const excluded = stats.excluded ?? [];
  if (excluded.length > 0) {
    lines.push(`Исключены из auto-select (${excluded.length}): ${excluded.join(', ')}`);
  }
  if (!stats.auto_count) {
    lines.push('Предупреждение: auto-select пуст (все серверы исключены).');
  }
  lines.push(...warnings);
  return lines.join('\n');
}

/**
 * Rejects a route name the schema would reject.
 *
 * @param {unknown} name
 * @param {string} what Human readable kind of the name, e.g. `маршрута`.
 */
export function assertUsableName(name, what) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new ConfigError(`имя ${what} не может быть пустым`);
  }
  if (DIGIT_ONLY_NAME.test(name)) {
    throw new ConfigError(
      `имя ${what} не может состоять только из цифр: JavaScript переставит такой ключ ` +
        `в начало файла и порядок в webui.json перестанет быть предсказуемым`,
    );
  }
}

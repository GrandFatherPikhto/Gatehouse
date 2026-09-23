#!/usr/bin/env node
// Builds config.json from webui.json.
//
// Reference: the `--generate-config` scenario of `main()` in
// /home/yevstigneyevda/Projects/Python/SingBoxTools/sing_box_manager.py —
// same overrides, same summary lines, same exit codes. The interactive TUI of
// the reference is not ported: the future web UI is a separate task.

import path from 'node:path';
import process from 'node:process';

import {ConfigError, DEFAULT_SETTINGS_FILE} from '../src/core/errors.mjs';
import {generateConfigFile} from '../src/core/settings.mjs';

const USAGE = `Использование: node tools/generate.mjs [опции]

Опции:
  --settings PATH             файл настроек (по умолчанию ${DEFAULT_SETTINGS_FILE})
  --output PATH               куда писать config.json (переопределяет output_file)
  --links PATH                один файл VLESS-ссылок вместо найденных провайдеров
  --listen-ip IP              адрес прослушивания (переопределяет listen_ip)
  --exclude-from-auto PREFIX  префиксы, выкидываемые из auto-select; можно
                              перечислить несколько значений
  --warnings-file PATH        записать собранные предупреждения в JSON
  --quiet                     не печатать сводку
  -h, --help                  эта справка`;

/**
 * Parses the CLI arguments.
 *
 * @param {string[]} argv
 * @returns {Record<string, unknown>}
 */
function parseArgs(argv) {
  const options = {
    settings: DEFAULT_SETTINGS_FILE,
    output: null,
    links: null,
    listenIp: null,
    excludeFromAuto: null,
    warningsFile: null,
    quiet: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length) throw new ConfigError(`флаг ${arg} требует значение`);
      return argv[index];
    };

    switch (arg) {
      case '--settings':
        options.settings = value();
        break;
      case '--output':
        options.output = value();
        break;
      case '--links':
        options.links = value();
        break;
      case '--listen-ip':
        options.listenIp = value();
        break;
      case '--exclude-from-auto': {
        const prefixes = [];
        while (index + 1 < argv.length && !argv[index + 1].startsWith('--')) {
          index += 1;
          prefixes.push(argv[index]);
        }
        if (prefixes.length === 0) {
          throw new ConfigError('--exclude-from-auto требует хотя бы один префикс');
        }
        options.excludeFromAuto = prefixes;
        break;
      }
      case '--warnings-file':
        options.warningsFile = value();
        break;
      case '--quiet':
        options.quiet = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new ConfigError(`неизвестный флаг: ${arg}`);
    }
  }
  return options;
}

/**
 * Prints the proxy summary, mirroring the reference `print_proxy_settings`.
 *
 * @param {Array<{tag: string, type: string, port: number, servers: string[]}>} proxies
 * @param {string} listenIp
 */
function printProxySettings(proxies, listenIp) {
  process.stdout.write('\n=== Настройки прокси ===\n');
  for (const proxy of proxies) {
    const servers = proxy.servers.length > 0
      ? proxy.servers.join(', ')
      : 'auto-select (все, кроме exclude_from_auto)';
    process.stdout.write(`  [${proxy.type.toUpperCase()}] ${proxy.tag}\n`);
    process.stdout.write(`      ip:      ${listenIp}\n`);
    process.stdout.write(`      port:    ${proxy.port}\n`);
    process.stdout.write(`      servers: ${servers}\n`);
  }
}

/**
 * Runs the generation and reports it. Returns the process exit code.
 *
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function run(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`Ошибка: ${error.message}\n`);
    return 1;
  }

  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  try {
    const {outputFile, stats, warnings} = generateConfigFile(options.settings, {
      output: options.output,
      links: options.links,
      listenIp: options.listenIp,
      excludeFromAuto: options.excludeFromAuto,
    });

    if (options.warningsFile) {
      const {writeFileSync} = await import('node:fs');
      writeFileSync(options.warningsFile, JSON.stringify(warnings, null, 2), 'utf8');
    }

    if (!options.quiet) {
      process.stdout.write(`Готово! Конфиг сгенерирован и сохранён в: ${outputFile}\n`);
      process.stdout.write(
        `Серверов: ${stats.servers}, инбаундов: ${stats.inbounds}, пулов: ${stats.pools}\n`,
      );
      printProxySettings(stats.proxies, stats.listen_ip);
    }

    for (const warning of warnings) process.stderr.write(`${warning}\n`);
    if (stats.excluded.length > 0) {
      process.stderr.write(
        `Исключены из auto-select (${stats.excluded.length}): ${stats.excluded.join(', ')}\n`,
      );
    }
    if (stats.auto_count === 0) {
      process.stderr.write('Предупреждение: auto-select пуст (все серверы исключены).\n');
    }
    return 0;
  } catch (error) {
    if (error instanceof ConfigError || error instanceof Error) {
      process.stderr.write(`Ошибка: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

// Only run the CLI when this file is the entry point: tests import `run()`.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;
if (invokedDirectly) {
  process.exitCode = await run(process.argv.slice(2));
}

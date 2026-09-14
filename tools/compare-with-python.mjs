#!/usr/bin/env node
// Byte-level acceptance: runs the reference generator and the port on the same
// data and compares the produced config.json byte by byte.
//
// Usage:
//   node tools/compare-with-python.mjs                      # fixtures of this repo
//   node tools/compare-with-python.mjs --yaml /path/settings.yaml
//
// The reference lives outside this repository and is never modified: it is run
// with an absolute --settings path and writes its output into a temporary
// directory. Nothing is copied out of the reference repository, and no file of
// it is written to.
//
// The automatic test suite does not call this tool: it compares the generated
// config against the committed tests/fixtures/expected-config.json instead, so
// `npm ci && node --test` works from a clean clone without Python.

import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {ConfigError} from '../src/core/errors.mjs';
import {convertSettings} from './import-settings.mjs';

export const DEFAULT_PYTHON_REPO = '/home/yevstigneyevda/Projects/Python/SingBoxTools';
const REPO_ROOT = path.dirname(import.meta.dirname);

const USAGE = `Использование: node tools/compare-with-python.mjs [опции]

Опции:
  --settings PATH         webui.json порта (по умолчанию tests/fixtures/settings.json)
  --python-settings PATH  settings.yaml эталона (по умолчанию tests/fixtures/settings.yaml)
  --yaml PATH             разовый режим: сравнить на произвольном settings.yaml эталона;
                          он конвертируется во временный webui.json с абсолютными путями,
                          сам файл не копируется и не меняется
  --python PATH           интерпретатор Python (по умолчанию <repo>/.venv/bin/python)
  --python-repo DIR       каталог эталонного проекта (по умолчанию ${DEFAULT_PYTHON_REPO})
  --out-dir DIR           каталог для результатов (по умолчанию временный)
  --keep                  не удалять временный каталог
  -h, --help              эта справка`;

function parseArgs(argv) {
  const options = {
    settings: path.join(REPO_ROOT, 'tests/fixtures/settings.json'),
    pythonSettings: path.join(REPO_ROOT, 'tests/fixtures/settings.yaml'),
    yaml: null,
    python: null,
    pythonRepo: DEFAULT_PYTHON_REPO,
    outDir: null,
    keep: false,
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
      case '--python-settings':
        options.pythonSettings = value();
        break;
      case '--yaml':
        options.yaml = value();
        break;
      case '--python':
        options.python = value();
        break;
      case '--python-repo':
        options.pythonRepo = value();
        break;
      case '--out-dir':
        options.outDir = value();
        break;
      case '--keep':
        options.keep = true;
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
 * Locates the Python interpreter and makes sure PyYAML is importable.
 *
 * @param {{python: string|null, pythonRepo: string}} options
 * @returns {string}
 */
function resolvePython(options) {
  if (!fs.existsSync(options.pythonRepo)) {
    throw new ConfigError(
      `эталонный проект не найден: ${options.pythonRepo} (укажите --python-repo)`,
    );
  }
  const shim = path.join(options.pythonRepo, 'generate_config.py');
  if (!fs.existsSync(shim)) {
    throw new ConfigError(`в эталонном проекте нет ${shim} — приёмка невозможна`);
  }

  const candidates = options.python
    ? [options.python]
    : [path.join(options.pythonRepo, '.venv/bin/python'), 'python3'];
  const tried = [];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'import yaml'], {encoding: 'utf8'});
    if (probe.error) {
      tried.push(`${candidate}: ${probe.error.message}`);
      continue;
    }
    if (probe.status === 0) return candidate;
    tried.push(`${candidate}: ${(probe.stderr || '').trim().split('\n').pop()}`);
  }
  throw new ConfigError(
    `не найден Python с PyYAML (нужен эталону):\n  - ${tried.join('\n  - ')}`,
  );
}

/**
 * Describes the first difference between two buffers.
 *
 * @param {Buffer} reference
 * @param {Buffer} produced
 * @returns {string}
 */
function describeDifference(reference, produced) {
  const limit = Math.min(reference.length, produced.length);
  let offset = 0;
  while (offset < limit && reference[offset] === produced[offset]) offset += 1;

  const toLines = (buffer) => buffer.toString('utf8').split('\n');
  const referenceLines = toLines(reference.subarray(0, offset + 1));
  const producedLines = toLines(produced.subarray(0, offset + 1));
  const lineNumber = referenceLines.length;

  const report = [
    `первые расхождения на байте ${offset} (строка ${lineNumber}):`,
  ];
  const from = Math.max(0, lineNumber - 3);
  for (let line = from; line <= lineNumber; line += 1) {
    report.push(`  строка ${line + 1}`);
    report.push(`    эталон: ${JSON.stringify(referenceLines[line] ?? '<нет строки>')}`);
    report.push(`    порт:   ${JSON.stringify(producedLines[line] ?? '<нет строки>')}`);
  }
  if (limit === offset) {
    report.push(
      `  файлы совпадают до конца короткого файла; длины: эталон ${reference.length}, порт ${produced.length}`,
    );
  }
  return report.join('\n');
}

/**
 * Runs the comparison. Returns the process exit code.
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

  const createdTmp = options.outDir === null;
  const outDir = options.outDir || fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-cmp-'));

  try {
    const python = resolvePython(options);
    fs.mkdirSync(outDir, {recursive: true});

    let nodeSettings = options.settings;
    let pythonSettings = options.pythonSettings;

    if (options.yaml) {
      if (!fs.existsSync(options.yaml)) {
        throw new ConfigError(`файл ${options.yaml} не найден`);
      }
      const {parse: parseYaml} = await import('yaml');
      const source = parseYaml(fs.readFileSync(options.yaml, 'utf8'));
      const {document} = convertSettings(source, {
        settingsDir: path.dirname(path.resolve(options.yaml)),
        absolutePaths: true,
        profile: 'default',
      });
      nodeSettings = path.join(outDir, 'webui-converted.json');
      fs.writeFileSync(nodeSettings, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
      pythonSettings = options.yaml;
    }

    const pythonOutput = path.join(outDir, 'config-python.json');
    const nodeOutput = path.join(outDir, 'config-node.json');

    process.stdout.write(`эталон:  ${python} ${path.relative(options.pythonRepo, pythonSettings)}\n`);
    process.stdout.write(`порт:    node tools/generate.mjs --settings ${nodeSettings}\n`);

    const reference = spawnSync(
      python,
      [
        path.join(options.pythonRepo, 'generate_config.py'),
        '--settings',
        path.resolve(pythonSettings),
        '--output',
        pythonOutput,
      ],
      {cwd: options.pythonRepo, encoding: 'utf8'},
    );
    if (reference.status !== 0) {
      throw new ConfigError(
        `эталон завершился с кодом ${reference.status}:\n${(reference.stderr || '').trim()}`,
      );
    }

    const produced = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, 'tools/generate.mjs'), '--settings', nodeSettings, '--output', nodeOutput],
      {cwd: REPO_ROOT, encoding: 'utf8'},
    );
    if (produced.status !== 0) {
      throw new ConfigError(
        `порт завершился с кодом ${produced.status}:\n${(produced.stderr || '').trim()}`,
      );
    }

    const referenceBytes = fs.readFileSync(pythonOutput);
    const producedBytes = fs.readFileSync(nodeOutput);
    const digest = createHash('sha256').update(referenceBytes).digest('hex').slice(0, 16);

    process.stdout.write(`\nэталон: ${referenceBytes.length} байт\n`);
    process.stdout.write(`порт:   ${producedBytes.length} байт\n`);

    if (referenceBytes.equals(producedBytes)) {
      process.stdout.write(`\ncmp молчит: файлы идентичны побайтово (${digest})\n`);
      if (createdTmp && !options.keep) fs.rmSync(outDir, {recursive: true, force: true});
      return 0;
    }

    process.stderr.write(`\nРАСХОЖДЕНИЕ\n${describeDifference(referenceBytes, producedBytes)}\n`);
    process.stderr.write(`\nфайлы оставлены в ${outDir}\n`);
    return 1;
  } catch (error) {
    process.stderr.write(`Ошибка: ${error.message}\n`);
    if (createdTmp && !options.keep) fs.rmSync(outDir, {recursive: true, force: true});
    return 1;
  }
}

// Only run the CLI when this file is the entry point: tests import `run()`.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;
if (invokedDirectly) {
  process.exitCode = await run(process.argv.slice(2));
}

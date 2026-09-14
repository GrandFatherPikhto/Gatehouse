#!/usr/bin/env node
// Copies the pinned htmx build from node_modules into public/vendor/.
//
// The web editor must work on a router without internet access, so the browser
// is never allowed to reach a CDN: `public/vendor/htmx.min.js` is committed and
// served by our own Express app. This script is the only sanctioned way to
// refresh that file, so the committed copy always matches a known npm version.
//
// htmx lives in devDependencies on purpose: the runtime dependency list stays at
// `express` and `ejs`, while the browser bundle ships as a plain static file.
//
// Usage:
//   npm run vendor:htmx        # copy and report the version
//   node tools/vendor-htmx.mjs --check   # fail if the file is missing or stale

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {ConfigError} from '../src/core/errors.mjs';

const REPO_ROOT = path.join(import.meta.dirname, '..');
const PACKAGE_DIR = path.join(REPO_ROOT, 'node_modules', 'htmx.org');
const SOURCE = path.join(PACKAGE_DIR, 'dist', 'htmx.min.js');
const TARGET = path.join(REPO_ROOT, 'public', 'vendor', 'htmx.min.js');

const USAGE = `Использование: node tools/vendor-htmx.mjs [опции]

Опции:
  --check     ничего не копировать, только сверить public/vendor/htmx.min.js с пакетом
  -h, --help  эта справка`;

/**
 * Reads the version of the installed htmx package.
 *
 * @returns {string}
 */
function installedVersion() {
  if (!fs.existsSync(PACKAGE_DIR)) {
    throw new ConfigError(
      'пакет htmx.org не установлен (devDependencies): выполните npm ci перед копированием',
    );
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8'));
  return manifest.version;
}

/**
 * Copies the htmx build into public/vendor/, or verifies it with `--check`.
 *
 * @param {{check?: boolean}} [options]
 * @returns {{version: string, target: string, changed: boolean}}
 */
export function vendorHtmx(options = {}) {
  const version = installedVersion();
  if (!fs.existsSync(SOURCE)) {
    throw new ConfigError(`в пакете htmx.org нет файла ${SOURCE}`);
  }

  const source = fs.readFileSync(SOURCE);
  const current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET) : null;
  const changed = current === null || !current.equals(source);

  if (options.check) {
    if (changed) {
      throw new ConfigError(
        `${TARGET} отсутствует или не совпадает с htmx.org ${version}: выполните npm run vendor:htmx`,
      );
    }
    return {version, target: TARGET, changed: false};
  }

  if (changed) {
    fs.mkdirSync(path.dirname(TARGET), {recursive: true});
    fs.writeFileSync(TARGET, source);
  }
  return {version, target: TARGET, changed};
}

/**
 * CLI entry point.
 *
 * @param {string[]} argv
 * @returns {number}
 */
export function run(argv) {
  let check = false;
  for (const arg of argv) {
    switch (arg) {
      case '--check':
        check = true;
        break;
      case '-h':
      case '--help':
        process.stdout.write(`${USAGE}\n`);
        return 0;
      default:
        process.stderr.write(`Ошибка: неизвестный флаг: ${arg}\n`);
        return 1;
    }
  }

  try {
    const {version, target, changed} = vendorHtmx({check});
    if (check) {
      process.stdout.write(`htmx ${version} на месте: ${target}\n`);
    } else if (changed) {
      process.stdout.write(`Скопирован htmx ${version} в: ${target}\n`);
    } else {
      process.stdout.write(`htmx ${version} уже актуален: ${target}\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`Ошибка: ${error.message}\n`);
    return 1;
  }
}

// Only run the CLI when this file is the entry point: tests import `vendorHtmx`.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;
if (invokedDirectly) {
  process.exitCode = run(process.argv.slice(2));
}

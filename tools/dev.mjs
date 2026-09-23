#!/usr/bin/env node
// `npm run dev`: the editor in the sandbox, never on the router.
//
// Every host-facing path is pointed into `dev/`: the settings file, the generated
// config and the state directory. `systemctl` and `sudo` are the stubs of
// `dev/bin/`, so even a restart changes nothing on the machine. `sing-box` stays
// the real binary on purpose — `check` and `tools fetch` have to behave exactly
// as they do on the router, and the editor must say plainly when it is missing.
//
// The environment lives in this file and not in a shell one-liner in
// `package.json`: `$PWD` there would break as soon as the command runs from
// another directory, and a list of six variables is easier to read here.
//
// The sandbox data itself is not committed: `dev/root/` carries keys and personal
// server lists. `dev/root.example/` holds anonymised samples; this script prints
// the copy commands when they are missing.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.join(import.meta.dirname, '..');
const SANDBOX = path.join(ROOT, 'dev', 'root');
const EXAMPLE = path.join(ROOT, 'dev', 'root.example');

const SETTINGS = path.join(SANDBOX, 'webui.json');
const CONFIG = path.join(SANDBOX, 'etc', 'sing-box', 'config.json');
// Provider folder of the sample project; the reader looks under <settingsDir>/sources.
const LINKS = path.join(SANDBOX, 'sources', 'vpnd', 'links.txt');
// Where `gatehouse-tunnel@<name>` reads `<name>.conf`. In the sandbox the editor
// writes the normalised tunnel configs here, never into the router's /etc.
const AMNEZIA = path.join(SANDBOX, 'etc', 'gatehouse', 'tunnels');
// The sandbox has no sudoers rules of its own; the fake systemctl is not behind
// sudo, so the probe file points at a path that is simply absent.
const SUDOERS = path.join(SANDBOX, 'etc', 'sudoers.d', 'gatehouse');

/** Path relative to the repository, for readable messages. */
const rel = (file) => path.relative(ROOT, file) || '.';

const missing = [SETTINGS, CONFIG].filter((file) => !fs.existsSync(file));
if (missing.length > 0) {
  process.stderr.write(
    `Песочница не готова: нет ${missing.map(rel).join(', ')}\n` +
      'Скопируйте обезличенные образцы:\n' +
      `  mkdir -p ${rel(path.dirname(CONFIG))} ${rel(path.dirname(LINKS))}\n` +
      `  cp ${rel(path.join(EXAMPLE, 'webui.json'))} ${rel(SETTINGS)}\n` +
      `  cp ${rel(path.join(EXAMPLE, 'etc/sing-box/config.json'))} ${rel(CONFIG)}\n` +
      `  cp ${rel(path.join(EXAMPLE, 'sources/vpnd/links.txt'))} ${rel(LINKS)}\n` +
      'После этого замените образцы боевыми копиями, если нужно.\n',
  );
  process.exit(1);
}

if (!fs.existsSync(LINKS)) {
  process.stderr.write(
    `Внимание: нет ${rel(LINKS)} — панели «Провайдеры» и «Тест серверов» будут пустыми.\n`,
  );
}

// `run()` of the server reads `process.env`, so the sandbox variables are set
// there rather than passed as an argument; this also makes the sandbox marker in
// the UI fire, because it is derived from these very paths.
Object.assign(process.env, {
  GATEHOUSE_SYSTEMCTL: path.join(ROOT, 'dev', 'bin', 'systemctl'),
  GATEHOUSE_SUDO: path.join(ROOT, 'dev', 'bin', 'sudo'),
  GATEHOUSE_CONFIG: CONFIG,
  GATEHOUSE_SETTINGS: SETTINGS,
  GATEHOUSE_STATE_DIR: path.join(SANDBOX, 'state'),
  GATEHOUSE_AMNEZIA_DIR: AMNEZIA,
  GATEHOUSE_SUDOERS: SUDOERS,
  GATEHOUSE_HOST: '127.0.0.1',
  GATEHOUSE_PORT: '9091',
  GATEHOUSE_TOKEN: '',
});

process.stdout.write('Песочница dev/: systemctl и sudo — заглушки, роутер не затрагивается.\n');

const {run} = await import('../src/web/server.mjs');
process.exitCode = await run();

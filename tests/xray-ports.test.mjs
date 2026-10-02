// Xray ports: handed out once, kept by their server, forgotten explicitly
// (task plan_2026_10_02_gatehouse_xray_core.md §2, §8.1(3)).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {ConfigError} from '../src/core/errors.mjs';
import {ProjectModel} from '../src/model/project.mjs';
import {makeTempDir} from './helpers.mjs';

/** One minimal vless/xhttp outbound, enough to be a server. */
function server(tag, address) {
  return {
    tag,
    protocol: 'vless',
    settings: {
      vnext: [{address, port: 443, users: [{id: '11111111-1111-4111-a111-111111111111', encryption: 'none'}]}],
    },
    streamSettings: {network: 'xhttp', security: 'tls', tlsSettings: {serverName: address}},
  };
}

function configFile(pairs) {
  return `${JSON.stringify([{remarks: 'r', outbounds: pairs.map(([tag, address]) => server(tag, address))}], null, 2)}\n`;
}

/** A temp project with one `stash` xray provider and an optional `xray` block. */
function project(pairs, document = {}) {
  const dir = makeTempDir();
  const root = path.join(dir, 'providers');
  const providerDir = path.join(root, 'stash');
  fs.mkdirSync(providerDir, {recursive: true});
  const xrayFile = path.join(providerDir, 'xray-configs.json');
  fs.writeFileSync(xrayFile, configFile(pairs), 'utf8');

  const file = path.join(dir, 'webui.json');
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        version: 2,
        listen_ip: '127.0.0.1',
        providers: {stash: {enabled: true, kind: 'xray'}},
        output_file: 'config.json',
        exclude_from_auto: [],
        urltest: {url: 'https://gstatic.com', interval: '3m', tolerance: 50},
        log: {level: 'info', timestamp: true},
        dns: {servers: [], final: 'dns-local'},
        proxies: [{tag: 'p', type: 'socks', port: 54321}],
        routes: {},
        ...document,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const model = new ProjectModel({path: file, stateDir: path.join(dir, 'state')});
  model.setProvidersDir(root);
  return {dir, root, file, model, xrayFile};
}

const S1 = ['s1', 'a1.example.net'];
const S2 = ['s2', 'a2.example.net'];
const S3 = ['s3', 'a3.example.net'];

describe('handing out ports (§2)', () => {
  test('the smallest free port, in file order, and the document becomes dirty', () => {
    const {model} = project([S1, S2]);
    const first = model.ensureXrayPorts();
    assert.deepEqual(first.assigned, {'stash/s1 (a1)': 20800, 'stash/s2 (a2)': 20801});
    assert.equal(first.changed, true);
    assert.equal(model.dirty, true);
    assert.deepEqual(model.xrayBlock().ports, {'stash/s1 (a1)': 20800, 'stash/s2 (a2)': 20801});

    const again = model.ensureXrayPorts();
    assert.equal(again.changed, false);
  });

  test('a shift of the lines does NOT move a port to another server', () => {
    const {model, xrayFile} = project([S1, S2]);
    model.ensureXrayPorts();
    fs.writeFileSync(xrayFile, configFile([S2, S1]), 'utf8');
    const ports = model.xrayPortInfo().rows.map((row) => [row.name, row.port]);
    assert.deepEqual(ports, [
      ['s1 (a1)', 20800],
      ['s2 (a2)', 20801],
    ]);
  });

  test('a server that is gone KEEPS its port; a new one takes the next free', () => {
    const {model, xrayFile} = project([S1, S2]);
    model.ensureXrayPorts();

    fs.writeFileSync(xrayFile, configFile([S1, S3]), 'utf8');
    const info = model.xrayPortInfo();
    const missing = info.rows.find((row) => row.missing);
    assert.equal(missing.key, 'stash/s2 (a2)');
    assert.equal(missing.port, 20801);

    const assigned = model.ensureXrayPorts();
    assert.deepEqual(assigned.assigned, {'stash/s3 (a3)': 20802});
  });

  test('«Forget» frees the port of a missing server only', () => {
    const {model, xrayFile} = project([S1, S2]);
    model.ensureXrayPorts();
    fs.writeFileSync(xrayFile, configFile([S1]), 'utf8');

    assert.throws(() => model.forgetXrayPort('stash/s1 (a1)'), ConfigError);
    model.forgetXrayPort('stash/s2 (a2)');
    assert.equal('stash/s2 (a2)' in model.xrayBlock().ports, false);

    fs.writeFileSync(xrayFile, configFile([S1, S3]), 'utf8');
    const assigned = model.ensureXrayPorts();
    assert.deepEqual(assigned.assigned, {'stash/s3 (a3)': 20801});
  });

  test('changing the suffix keeps the same port (the key is the base name)', () => {
    const {model} = project([S1, S2]);
    model.ensureXrayPorts();
    model.setProviderSuffix('stash', 'stash');
    const again = model.ensureXrayPorts();
    assert.equal(again.changed, false);
    const row = model.xrayPortInfo().rows.find((item) => item.name === 's1 (a1) stash');
    assert.equal(row.port, 20800);
    assert.equal(row.key, 'stash/s1 (a1)');
  });

  test('an exhausted range refuses with a clear message', () => {
    const {model} = project([S1, S2], {xray: {port_range: [20800, 20800]}});
    assert.throws(() => model.ensureXrayPorts(), /исчерпан/);
  });

  test('a custom range is respected', () => {
    const {model} = project([S1], {xray: {port_range: [30000, 30010]}});
    assert.deepEqual(model.ensureXrayPorts().assigned, {'stash/s1 (a1)': 30000});
  });
});

describe('the port range form (§2)', () => {
  test('validates the bounds', () => {
    const {model} = project([S1]);
    assert.throws(() => model.setXrayPortRange(30010, 30000), ConfigError);
    assert.throws(() => model.setXrayPortRange(0, 10), ConfigError);
    assert.throws(() => model.setXrayPortRange(1, 70000), ConfigError);
    model.setXrayPortRange(20800, 20899);
    assert.deepEqual(model.xrayBlock().port_range, [20800, 20899]);
    assert.equal(model.dirty, true);
  });

  test('refuses when a handed port equals a sing-box proxy port', () => {
    const {model} = project([S1], {xray: {ports: {'stash/s1 (a1)': 54321}}});
    assert.throws(() => model.setXrayPortRange(20800, 20899), /совпал с портом прокси/);
  });
});

# SingBoxWebUI — core of the sing-box config generator

This repository holds the **generation core** of the sing-box configuration tool:
reading the settings, parsing VLESS subscription links, validating everything and
assembling a `config.json` that is **byte for byte identical** to the output of
the reference Python implementation
([`SingBoxTools/sing_box_manager.py`](https://example.invalid/SingBoxTools/sing_box_manager.py)).

It is a port, not a rewrite. The reference has three years of production use and
79 tests, so the first milestone is exact equality, not improvement. Anything
that looks odd in the reference is described in
[`techdocs/done_2026_09_14_port_core_generator.md`](techdocs/done_2026_09_14_port_core_generator.md)
instead of being "fixed" on the way.

**There is no web server here.** No Express, no routes, no HTML, no browser code:
the web UI is the next task and it will be built on top of this core. The only
entry points are the CLI tools below.

## Requirements

* Node **22** (`.nvmrc` pins the major; verified on 22.23.2 with npm 10.9.8, the
  same versions the router runs)
* npm (for `ajv`; `yaml` is needed only by the one-off converter)
* Python with PyYAML — **only** for the optional byte-level comparison against
  the reference; the test suite itself needs no Python

## Install and test

```bash
npm ci          # installs ajv (runtime) and yaml (converter, dev)
node --test     # 137 checks, no network, no root, no sing-box
```

`node --test` discovers `tests/*.test.mjs` and creates all of its temporary files
in the system temp directory: a run never touches the repository, `webui.json` or
`config.json`.

## Usage

```bash
# build config.json next to webui.json
node tools/generate.mjs --settings webui.json

# override the output, the links file, the listen address or the active profile
node tools/generate.mjs --settings webui.json \
    --output /etc/sing-box/config.json \
    --links server-lists/vpnd.vless.reality.io.txt \
    --listen-ip 10.95.2.1 \
    --profile reality
```

| Flag | Meaning |
| --- | --- |
| `--settings PATH` | settings file, `webui.json` by default |
| `--profile NAME` | profile to apply instead of `active` |
| `--output PATH` | where to write `config.json` (overrides `output_file`) |
| `--links PATH` | links file (overrides `links_file`) |
| `--listen-ip IP` | listen address (overrides `listen_ip`) |
| `--exclude-from-auto PREFIX...` | tag prefixes kept out of `auto-select` |
| `--warnings-file PATH` | write the collected warnings as JSON |
| `--quiet` | print no summary |

Relative paths inside the settings file are resolved against the directory of
that file, so the tool can be started from any working directory. Exit code is 0
on success and 1 on any configuration error, with the reason on stderr.

## Settings format: `webui.json`

`settings.yaml` is replaced by `webui.json`. YAML went away deliberately: nobody
edits the file by hand any more, so preserving comments (the only reason `ruamel`
lived in the Python project) is no longer a requirement. The file is validated
against [`src/schemas/webui.schema.json`](src/schemas/webui.schema.json) with
`ajv` on every load.

```json
{
  "version": 1,
  "active": "reality",
  "defaults": {
    "listen_ip": "10.95.2.1",
    "log": { "level": "info", "timestamp": true },
    "urltest": { "url": "https://gstatic.com", "interval": "3m", "tolerance": 50 },
    "dns": { "servers": [], "rules": [], "final": "dns-local" }
  },
  "profiles": {
    "reality": {
      "note": "Reality transport, primary",
      "links_file": "server-lists/vpnd.vless.reality.io.txt",
      "output_file": "/etc/sing-box/config.json",
      "exclude_from_auto": ["🇷🇺"],
      "proxies": [
        { "tag": "main", "type": "mixed", "port": 54321, "note": "",
          "servers": ["🇫🇮 Finland - Helsinki 1"] }
      ],
      "routes": {
        "telegram": { "outbound": "🇫🇮 Finland - Helsinki 1",
                      "domains": ["telegram.org", "t.me"] }
      }
    }
  }
}
```

Rules of the format:

* **exactly one profile is active.** Two profiles can never be applied at once:
  they overlap on ports and sing-box is a single process. `active` is required
  and must name an existing profile — `ajv` rejects the file otherwise, through a
  custom `profileMustExist` keyword, because JSON Schema cannot express
  "`active` must be a key of `profiles`".
* **a profile key overrides the same-named key of `defaults`**, top level only.
  Nested `log`/`dns`/`urltest` objects are replaced as a whole, exactly like the
  reference behaved with a flat YAML file.
* **`note` is a comment for humans** — in a profile and in a proxy. The core
  ignores it and it never reaches `config.json`.
* **proxy types are `socks`, `http`, `mixed`**, declared once in
  [`src/core/errors.mjs`](src/core/errors.mjs:1) (`PROXY_TYPES`) and repeated in
  the schema `enum`; a test fails if the two ever drift apart.
* **the schema complements the core, it does not replace it.** Duplicate tags and
  duplicate ports cannot be expressed in JSON Schema, so `validate_proxies` stays
  the only place catching them.
* `webui.json` and every `*.txt` are git-ignored: they carry personal lists. The
  only committed links file is the synthetic `tests/fixtures/links.txt`.

## Migration from `settings.yaml`

The converter is a one-off tool and the only place allowed to use the `yaml`
package:

```bash
node tools/import-settings.mjs --settings settings.yaml --output webui.json
# keep the real links file in place, no copying:
node tools/import-settings.mjs --settings /srv/sing-box/settings.yaml \
    --output /tmp/webui.json --absolute-paths
```

It maps the known keys into the profile `default`, reports unknown keys instead
of dropping them silently, and `--absolute-paths` rewrites `links_file`/
`output_file` against the directory of the YAML file.

## Byte-level acceptance against the reference

```bash
npm run compare                                    # the repo fixtures
node tools/compare-with-python.mjs --yaml /srv/sing-box/settings.yaml
```

The tool runs the reference generator and this port on the same data and compares
the two `config.json` files byte by byte, printing the first differing line with
context when they diverge. The reference project is only read: it is invoked with
an absolute `--settings` path and writes into a temp directory.

Two levels of verification exist:

1. **automated, no Python needed** — `tests/build.test.mjs` compares the produced
   config against the committed `tests/fixtures/expected-config.json`, which was
   generated by the reference once and is regenerated with the command above;
2. **manual, against real data** — the command above on the owner's own
   `settings.yaml` (148 servers, emoji tags, six inbounds). Both runs currently
   report identical bytes; see the report in `techdocs/`.

## Project layout

| Path | Role |
| --- | --- |
| [`src/core/vless.mjs`](src/core/vless.mjs:1) | `getFirst`, `parseVless`, `dedupTags`, `parseLinks` |
| [`src/core/validate.mjs`](src/core/validate.mjs:1) | `asList`, `requireMapping`, `validateProxies`, `urltestBlock`, `validateExclude` |
| [`src/core/build.mjs`](src/core/build.mjs:1) | `buildInbounds`, `buildPools`, `buildRules`, `buildConfig` |
| [`src/core/settings.mjs`](src/core/settings.mjs:1) | `webui.json` loading, ajv validation, profile merge, `resolvePath`, `writeJson`, `generateConfigFile` |
| [`src/core/errors.mjs`](src/core/errors.mjs:1) | `ConfigError`, `PROXY_TYPES`, `DEFAULT_EXCLUDE` |
| [`src/schemas/webui.schema.json`](src/schemas/webui.schema.json:1) | JSON schema of the settings file |
| [`tools/generate.mjs`](tools/generate.mjs:1) | CLI that writes `config.json` |
| [`tools/import-settings.mjs`](tools/import-settings.mjs:1) | one-off `settings.yaml` → `webui.json` converter |
| [`tools/compare-with-python.mjs`](tools/compare-with-python.mjs:1) | byte-level comparison with the reference |
| [`tests/`](tests/helpers.mjs:1) | `node:test` suite, fixtures and the coverage table |
| [`techdocs/`](techdocs/port-coverage.md:1) | porting notes, URL probe, coverage table, report |

## Porting notes

* **Warnings are data, not stderr.** The reference printed some problems (a route
  pointing at an unknown outbound, a missing `dns` section, an unparsable link)
  and continued. The port collects them into an array returned together with the
  config, so the future web UI can show them; the CLI prints them to stderr in
  the reference wording.
* **No YAML in the core.** Only `tools/import-settings.mjs` touches YAML, and the
  `yaml` package sits in `devDependencies` accordingly.
* **Dependencies stay at `ajv`.** No framework, no lodash, no test runner: Node
  22 ships everything needed. No TypeScript either — JSDoc is used for types.
* **The interactive picker is intentionally absent.** `pick_proxy`,
  `filter_and_select`, `ask_wqx` and the reference `main()` are not ported; the
  future web UI replaces them.
* **`curl_test` and `live_test` are gone for good.** `live_test` rewrote
  `config.json` and restarted sing-box to check a single server — 149 restarts
  for 148 servers, each dropping every connection in the house. The verified
  replacement, already in use on the router, is:

  ```bash
  sing-box tools fetch -c /etc/sing-box/config.json -o "🇨🇾 Cyprus - Limassol" https://ipinfo.io
  ```

  It exits 0 within a second and never touches the running sing-box. The web UI
  will use this command; nothing of it is implemented in this task.

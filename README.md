# SingBoxWebUI — the sing-box config generator and its web editor

This repository holds the tool that turns a subscription of VLESS links plus a
settings file into a `config.json` for sing-box, and the browser editor that
maintains that settings file. It is built in three stages:

* **stage 1 — the generation core** ([`src/core/`](src/core/settings.mjs:1)):
  reading the settings, parsing VLESS links, validating everything and assembling
  a `config.json` that is **byte for byte identical** to the output of the
  reference Python implementation
  ([`SingBoxTools/sing_box_manager.py`](https://example.invalid/SingBoxTools/sing_box_manager.py)).
* **stage 2 — the web editor** ([`src/model/`](src/model/project.mjs:1),
  [`src/web/`](src/web/app.mjs:1), [`views/`](views/layout.ejs:1),
  [`public/`](public/app.css:1)): an Express server that shows the settings as a
  tree and forms, saves `webui.json` atomically with snapshots, and generates
  `config.json` for the active profile. Functionally it replaces the Qt GUI of
  the Python project.
* **stage 3 — everything that touches the host machine**: `sing-box check`, the
  daemon restart, the journal, the live outbound test, geosite, the systemd unit,
  rights, deployment and authentication. **None of it is implemented**:
  [`src/system/index.mjs`](src/system/index.mjs:1) is a boundary of five stubs
  that throw, and it is the only module stage 3 has to change.

The core is a port, not a rewrite. The reference has three years of production
use and 79 tests, so exact equality came first, not improvement. Anything that
looks odd in the reference is described in
[`techdocs/done_2026_09_14_port_core_generator.md`](techdocs/done_2026_09_14_port_core_generator.md)
instead of being "fixed" on the way. The web editor is documented in
[`techdocs/done_2026_09_14_web_editor.md`](techdocs/done_2026_09_14_web_editor.md).

## Requirements

* Node **22** (`.nvmrc` pins the major; verified on 22.23.2 with npm 10.9.8, the
  same versions the router runs)
* npm — the runtime dependencies are `ajv`, `express` and `ejs`
* Python with PyYAML — **only** for the optional byte-level comparison against
  the reference; the test suite itself needs no Python

## Install and test

```bash
npm ci          # runtime: ajv, express, ejs; dev: yaml (converter), htmx.org
node --test     # 218 checks, no network, no root, no sing-box
npm run compare # byte-level equality with the reference, needs Python
```

`node --test` discovers `tests/*.test.mjs` and creates all of its temporary files
in the system temp directory: a run never touches the repository, `webui.json` or
`config.json`. The HTTP tests start the editor on port `0` and speak to it with
`fetch`, so no port is ever taken from a running instance.

The committed [`.npmrc`](.npmrc:1) sets `maxsockets=2`: this registry answers
quickly but slowly enough that a cold `npm ci` with npm's default of 15 parallel
sockets drifts into `ETIMEDOUT` here and on the router. After one successful
install, `npm ci --prefer-offline` needs no network at all.

`public/vendor/htmx.min.js` is committed on purpose (see the "No CDN" note below)
and is refreshed from the `htmx.org` development dependency:

```bash
npm run vendor:htmx          # copy the pinned build into public/vendor/
node tools/vendor-htmx.mjs --check   # fail if the committed copy is stale
```

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

## Web editor

```bash
npm start        # Веб-редактор webui.json: http://127.0.0.1:8080/
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `SINGBOX_WEBUI_SETTINGS` | `webui.json` | settings file to edit; created on the first save when missing |
| `SINGBOX_WEBUI_HOST` | `127.0.0.1` | listen address. Not `0.0.0.0` until stage 3 adds authentication |
| `SINGBOX_WEBUI_PORT` | `8080` | listen port; `0` picks a free one |
| `SINGBOX_WEBUI_STATE_DIR` | `./.state` | where snapshots go; on the router this becomes `/var/lib/sing-box-webui` |

The path of the settings file comes from the environment and from nowhere else.
There is deliberately no "open file" box in the UI: a path arriving from the
browser at a process that writes files is a path traversal waiting to happen.

One tree node per screen: Профили (list, active profile, create, rename,
duplicate, remove), Общие, Значения по умолчанию, Файл ссылок, Вывод,
Прокси → tag, Маршруты → name, DNS.

* **«Общие» writes the active profile, «Значения по умолчанию» writes `defaults`.**
  A profile key overrides the same-named key of `defaults`, top level only, so
  every shared field shows where its value comes from — "задано в профиле" or
  "унаследовано из defaults" — next to a button that drops the key from the
  profile. A key that merely happens to equal the default is NOT removed
  automatically: that would break the byte-for-byte round-trip of an untouched
  file.
* **DNS is a JSON text field.** sing-box has 16 kinds of DNS servers, the schema is
  fresh and still moving, and DNS is edited rarely; only "a valid JSON object" is
  checked. Structural forms were deliberately not built.
* **A stale reference is a mark, not an error.** A proxy listing a server that
  left the links file, and a route naming an unknown outbound, are marked in the
  tree; saving stays possible. Only the generator refuses to build a pool for a
  missing server.
* **The servers list keeps the stored order.** The multi-select draws the selected
  servers first, in the order the file holds them, and the rest of the links file
  after them. A browser submits the selected options in document order, so any
  other layout would rewrite the list into links-file order on the first save of a
  form nobody had touched, and a server that left the links file would move to the
  end.
* **Names may not consist of digits only** — for profiles and for routes alike.
  JavaScript reorders integer-like object keys, so a profile called `2024` would
  silently jump to the front of the file and the order of `webui.json` (and of the
  `routes` section of `config.json`) would stop being predictable. `2024-reality`
  is fine. The rule lives in the schema; [`src/model/project.mjs`](src/model/project.mjs:1)
  mirrors it and a test asserts the two agree.
* **Saving is atomic and versioned.** The previous version is copied to
  `<state-dir>/snapshots/webui-<ISO>.json` (the last 10 are kept) before the new
  one is written to a temporary file and renamed over the target. `webui.json` is
  written in the canonical form of this tool: two-space indent and a trailing
  newline. That is deliberately NOT the format of `config.json`, which keeps the
  reference contract (`json.dump(..., indent=2)`, no trailing newline) because the
  acceptance test compares its bytes.
* **One model per process.** The state (loaded file, unsaved edits) lives on the
  server, exactly as the Qt window was a thin shell over `model.py`. Two open
  browser tabs will silently overwrite each other's edits; there are no locks and
  none are planned — one tab per instance.
* **No CDN, no build step.** htmx is served from `public/vendor/`, so the editor
  works on a router without internet access, and the files are copied as they are.
* **Generation runs on the saved file**, through the same `generateConfigFile` the
  CLI uses, and says so when the editor had unsaved edits at that moment.
* **Stage 3 is behind a boundary.** [`src/system/index.mjs`](src/system/index.mjs:1)
  exports `restartSingBox`, `checkConfig`, `tailJournal`, `testOutbound` and
  `geositeLookup`; each throws "не реализовано (этап 3)". When they are
  implemented, only that module changes, and only with `execFile`/`spawn` and an
  argument array — tags look like `🇨🇾 Cyprus - Limassol` and break a shell command
  line with no attacker involved.

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
| [`src/model/project.mjs`](src/model/project.mjs:1) | editor state: profiles, proxy/route CRUD, saving, generation summary |
| [`src/model/stale.mjs`](src/model/stale.mjs:1) | stale references and the tree specification |
| [`src/model/storage.mjs`](src/model/storage.mjs:1) | canonical `webui.json` format, atomic writes, snapshots |
| [`src/web/app.mjs`](src/web/app.mjs:1) | Express app: routes, form parsing, fragments |
| [`src/web/server.mjs`](src/web/server.mjs:1) | `npm start`: environment, listen address |
| [`src/web/panel.mjs`](src/web/panel.mjs:1) | view models handed to the templates |
| [`src/system/index.mjs`](src/system/index.mjs:1) | stage-3 boundary: five stubs that throw |
| [`views/`](views/layout.ejs:1), [`public/`](public/app.css:1) | EJS templates, stylesheet, vendored htmx |
| [`tools/generate.mjs`](tools/generate.mjs:1) | CLI that writes `config.json` |
| [`tools/import-settings.mjs`](tools/import-settings.mjs:1) | one-off `settings.yaml` → `webui.json` converter |
| [`tools/compare-with-python.mjs`](tools/compare-with-python.mjs:1) | byte-level comparison with the reference |
| [`tools/vendor-htmx.mjs`](tools/vendor-htmx.mjs:1) | refreshes `public/vendor/htmx.min.js` from the npm package |
| [`tests/`](tests/helpers.mjs:1) | `node:test` suite, fixtures and the coverage table |
| [`techdocs/`](techdocs/port-coverage.md:1) | porting notes, URL probe, coverage table, reports |

## Porting notes

* **Warnings are data, not stderr.** The reference printed some problems (a route
  pointing at an unknown outbound, a missing `dns` section, an unparsable link)
  and continued. The port collects them into an array returned together with the
  config, so the future web UI can show them; the CLI prints them to stderr in
  the reference wording.
* **No YAML in the core.** Only `tools/import-settings.mjs` touches YAML, and the
  `yaml` package sits in `devDependencies` accordingly.
* **The core has no dependencies of its own.** `src/core/` uses `ajv` and
  nothing else; the editor adds `express` and `ejs`, which the task allows, and
  brings 67 transitive packages with it. No test runner (Node 22 ships
  `node:test`), no TypeScript (JSDoc carries the types), no bundler.
* **Two canonical formats, on purpose.** `config.json` reproduces
  `json.dump(..., indent=2)` byte for byte and therefore has no trailing newline;
  `webui.json` is a source file edited by hand and by the editor, so it is written
  with two-space indent and a trailing newline. Both decisions are stated in
  [`src/model/storage.mjs`](src/model/storage.mjs:1) so that nobody "unifies" them
  later.
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

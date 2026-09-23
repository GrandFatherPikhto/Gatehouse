# GateHouse — the sing-box config generator and its web editor

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
  daemon restart and the rollback, the journal snapshot, the outbound test, geosite,
  the systemd unit, rights, deployment and authentication. Implemented:
  [`src/system/index.mjs`](src/system/index.mjs:1) is the only module that runs a
  command, and it always uses `execFile`/`spawn` with an argument array.
  [`deploy/`](deploy/README.md:1) holds the unit, the sudoers rule, the polkit
  alternative and the order of deployment as ready-to-apply files.
* **continuation — a pinned exit**: a `pinned` flag on a proxy forbids a pool, so an
  exit whose geography the service on the far end watches cannot be moved by an
  accidental save. The background liveness watchdog and the external HTTP API of the
  daemon were removed together — see below.
* **tunnel lifecycle — enable, file, unit, exit**: a tunnel stops being a picture.
  Ticking «включить» next to a `.conf` in «Провайдеры» normalises the config and
  writes `<file name>.conf` into the GateHouse tunnel directory
  (`/etc/gatehouse/tunnels`), recording the two names in `webui.json`; un-ticking
  stops the unit and removes the file. GateHouse tunnels run under their own
  template (`gatehouse-tunnel@<file name>`); hand-made ones under
  `/etc/amnezia/amneziawg` are not seen or touched. The «Система»
  panel grows a row per tunnel (state read from systemd, one checkbox for both
  axes, restart, journal); and a tunnel becomes a first-class proxy — one tunnel,
  one proxy, one exit — by binding a `direct` outbound to the interface. A
  start-up fuse refuses to start a unit whose config lacks `Table = off`, with no
  way around it. Implemented:
  [`src/system/tunnel-file.mjs`](src/system/tunnel-file.mjs:1) and the tunnel
  functions of [`src/system/index.mjs`](src/system/index.mjs:1).

The core is a port, not a rewrite. The reference has three years of production
use and 79 tests, so exact equality came first, not improvement. Anything that
looks odd in the reference is described in
[`techdocs/done_2026_09_14_port_core_generator.md`](techdocs/done_2026_09_14_port_core_generator.md)
instead of being "fixed" on the way. The web editor is documented in
[`techdocs/done_2026_09_14_web_editor.md`](techdocs/done_2026_09_14_web_editor.md)
and the system layer in
[`techdocs/done_2026_09_14_system_integration.md`](techdocs/done_2026_09_14_system_integration.md).

## Requirements

* Node **22** (`.nvmrc` pins the major; verified on 22.23.2 with npm 10.9.8, the
  same versions the router runs)
* npm — the runtime dependencies are `ajv`, `express` and `ejs`

## Install and test

```bash
npm ci          # runtime: ajv, express, ejs; dev: htmx.org
node --test     # no network, no root, no sing-box
npm run dev     # the editor over the dev/ sandbox, not the router
```

The system-layer tests run the fake binaries of `tests/fixtures/bin/` instead of
`sing-box`, `systemctl` and `journalctl`: the suite never touches a real daemon, a
router or `sudo`.

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

## Development without the router

`npm run dev` starts the editor against the sandbox in `dev/`, so working on the
UI never touches the live router:

```bash
npm run dev      # http://127.0.0.1:9091/
```

`dev/bin/systemctl` and `dev/bin/sudo` are stubs that print the arguments they
received and exit 0 — nothing on the host is changed. `sing-box` stays the real
binary, because `check` and `tools fetch` have to behave exactly as they do on the
router. The editor detects that its paths point into `dev/` and shows a
«песочница» marker in the page header, so a dev instance cannot be mistaken for
the real one.

The sandbox data (`dev/root/`) is deliberately not in the repository — it carries
keys and personal server lists. `dev/root.example/` holds anonymised samples:

The sample set also carries a links file, and without it every server of every
proxy is reported as missing — copy all three:

```bash
mkdir -p dev/root/etc/sing-box
cp dev/root.example/webui.json                dev/root/webui.json
cp dev/root.example/etc/sing-box/config.json  dev/root/etc/sing-box/config.json
cp dev/root.example/links.txt                 dev/root/links.txt
```

### Working against the real data

The samples are enough to start the editor, but they describe three synthetic
servers. To develop against what the router actually runs, copy its files in.
Note where they live: the settings are in `/etc/`, while `/var/lib/` holds only
the snapshots and the server lists.

```bash
mkdir -p dev/root/sources/vpnd dev/root/etc/sing-box
scp denis@10.95.2.1:/etc/gatehouse/webui.json          dev/root/
scp denis@10.95.2.1:/etc/sing-box/config.json          dev/root/etc/sing-box/
scp denis@10.95.2.1:/var/lib/gatehouse/sources/vpnd/links.txt  dev/root/sources/vpnd/
```

**Then rewrite `output_file` inside the copied `webui.json`.** On the router it is
absolute, and it is resolved against the directory of the settings file — so an
absolute `output_file` makes the sandbox aim at the host's real
`/etc/sing-box/config.json`:

```json
"sources": [
  { "kind": "links", "name": "vpnd",
    "path": "sources/vpnd/links.txt" }
],
"output_file": "etc/sing-box/config.json"
```

A source is one explicit origin: `kind: "links"` is a single links file, `kind:
"tunnels"` a directory of `*.conf`. `path` is stored as typed; a relative path
resolves against the directory of `webui.json`, so the sample above needs no
rewrite as long as `dev/root/sources/vpnd/links.txt` sits there. An absolute path
copied from the router has to be rewritten, exactly like `output_file`.

Edit this **while the server is stopped**. It keeps the settings in memory and
writes them back when you save, so a change made underneath a running instance
is lost at the next save.

### Checking the sandbox against the live config

With the real data in place, the generator must reproduce the config the router
is running, byte for byte. That is the strongest available check that a change to
the model or the generator did not shift the output:

```bash
cp dev/root/etc/sing-box/config.json /tmp/live-config.json
node tools/generate.mjs --settings dev/root/webui.json --quiet
cmp /tmp/live-config.json dev/root/etc/sing-box/config.json && echo identical
```

This is a manual check, not part of `node --test`: `dev/root/` is not in the
repository, so the suite has no data to run it against. The automated gate is the
golden file built from the committed fixtures — see «Golden file acceptance».

### One tab at a time

The editor keeps the document in the server process, not in the browser. Two open
tabs overwrite each other's edits. The dev server says so at startup; it is not a
sandbox limitation but how the editor works.

## Usage

```bash
# build config.json next to webui.json
node tools/generate.mjs --settings webui.json

# override the output, the single links file or the listen address
node tools/generate.mjs --settings webui.json \
    --output /etc/sing-box/config.json \
    --links tests/fixtures/sources/vpnd/links.txt \
    --listen-ip 10.95.2.1
```

| Flag | Meaning |
| --- | --- |
| `--settings PATH` | settings file, `webui.json` by default |
| `--output PATH` | where to write `config.json` (overrides `output_file`) |
| `--links PATH` | read one links file instead of the configured `sources` |
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
| `GATEHOUSE_SETTINGS` | `webui.json` | settings file to edit; created on the first save when missing |
| `GATEHOUSE_HOST` | `127.0.0.1` | listen address. A non-loopback address **requires** a token, see "Authentication" below |
| `GATEHOUSE_PORT` | `8080` | listen port; `0` picks a free one |
| `GATEHOUSE_STATE_DIR` | `./.state` | where snapshots go; on the router this becomes `/var/lib/gatehouse` |
| `GATEHOUSE_TOKEN` | *(empty)* | access token. Required whenever the bind address is not the loopback |

The system layer reads its own variables, again from the environment and never
from a request:

| Variable | Default | Meaning |
| --- | --- | --- |
| `GATEHOUSE_SINGBOX` | `/usr/local/bin/sing-box` | binary used by `check` and `tools fetch` |
| `GATEHOUSE_SYSTEMCTL` | `/usr/bin/systemctl` | `systemctl`; this path must match the sudoers rule |
| `GATEHOUSE_JOURNALCTL` | `/usr/bin/journalctl` | `journalctl` |
| `GATEHOUSE_SUDO` | `/usr/bin/sudo` | `sudo`; the value `none` calls `systemctl` directly (the polkit variant) |
| `GATEHOUSE_UNIT` | `sing-box` | unit name |
| `GATEHOUSE_AMNEZIA_DIR` | `/etc/gatehouse/tunnels` | directory of the applied tunnel configs: the `gatehouse-tunnel@<name>` template reads it and it must match the unit file. The document no longer overrides it |
| `GATEHOUSE_AWG` | `/usr/bin/awg` | `awg`; read without `sudo` to learn which interfaces exist, so a tunnel is not given a taken name |
| `GATEHOUSE_SUDOERS` | `/etc/sudoers.d/gatehouse` | sudoers file the editor **reads** to learn which tunnels it may control. The editor never writes it |
| `GATEHOUSE_CONFIG` | `/etc/sing-box/config.json` | default config of the commands; the UI passes the generated path |
| `GATEHOUSE_TEST_URL` | `https://ipinfo.io` | target of the outbound test |
| `GATEHOUSE_TEST_TIMEOUT` | `8000` | timeout of one outbound test, ms |
| `GATEHOUSE_TEST_CONCURRENCY` | `4` | outbound tests running at once |

The path of the settings file comes from the environment and from nowhere else.
There is deliberately no "open file" box in the UI: a path arriving from the
browser at a process that writes files is a path traversal waiting to happen.

One tree node per screen: Провайдеры (source folders and their tunnels), Настройки —
a group with two children, Прокси → tag, Маршруты → name, and Система, which is a
group with two children as well: Sing-box (schema check, daemon restart, rollback,
the journal and the server test) and Amnezia (the tunnel rows grouped by provider).
A child is carried by the panel key (`system:amnezia`), so it is a real address that
can be bookmarked and works without script; a bare `system` key opens the first
child. «Настройки Sing-Box» collects every sing-box setting on one page (the old
Общие, DNS and Вывод); «Настройки Amnezia» holds the output directory of the tunnel
configs and the regeneration button. Inside a provider folder every `.conf` carries
the «включить» switch and its two names; clicking it opens a read-only normalisation
preview with the policy-routing switch.

* **`webui.json` is flat; the profile level is gone.** The body used to be split
  between the active profile and `defaults`, but there was exactly one profile and
  `defaults` was empty, so there was nobody to inherit from. Format `version: 2`
  is one level, and «Общие» is a single panel. The editor migrates an old file
  itself: it snapshots it, flattens the single profile (several are refused with
  their names), replaces `links_file` with `sources` and bumps the version. The
  core does not read the old form and says so, so the CLI can never generate from a
  half-migrated document.
* **A source is an explicit origin, not one shared links file.** `sources` lists
  objects `{kind, name, path}`: `kind: "links"` is a single FILE of VLESS links
  (outbounds), `kind: "tunnels"` a DIRECTORY of `*.conf` (listed only, never
  turned into outbounds). `path` is stored as typed; a relative path resolves
  against the directory of `webui.json`. The links are merged into one list, and
  **a provider label appears only when two sources hand out the same name**, so a
  single-source project keeps its tags and `config.json` stays byte-identical. A
  collision inside one file is a warning: it is an error in the provider's own
  file and the owner has to know. On the «Провайдеры» panel the list is edited row
  by row: a source is added by choosing its TYPE (a Sing-Box links file or an
  Amnezia tunnels directory), typing the path and the provider name, and removed
  by the button on its own row. The add is refused with a sentence when the path
  does not exist or is not what the kind claims — a links source must be a
  readable file, a tunnels source a directory. Clicking a provider opens the panel
  named after it: a Sing-Box source shows the servers it hands out, an Amnezia
  source its `.conf` files, each opening the normalisation preview. No action
  touches the files on disk: "remove" means "do not read it", never "delete the
  owner's file". A document written before this form (bare folder names under
  `GATEHOUSE_SOURCES`) is still read; the editor converts those entries into
  objects on open and says so.
* **A tunnel is enabled with «включить», and only then does it become a proxy.**
  The normaliser `src/core/normalize.mjs` is a pure function: it adds `Table = off`,
  drops `DNS =`, and copies `AllowedIPs` plus the obfuscation (`Jc/Jmin/Jmax`,
  `S1–S4`, `H1–H4`, `i1`) byte for byte. A tunnel has TWO names: a human-readable
  one (suggested as `<provider>-<file stem>`, edited freely, up to 255 characters)
  and the file name (typed by hand, at most 15 characters, because it is also the
  kernel interface of `gatehouse-tunnel@<file name>`). The mark writes
  `<file name>.conf` with mode `0600` into the GateHouse tunnel directory
  (`GATEHOUSE_AMNEZIA_DIR`, default `/etc/gatehouse/tunnels`) — overwriting only
  when the bytes really differ, and snapshotting the previous version next to it
  (`<file name>.conf.<ISO>`). That is the SAME directory the template unit and the
  start-up fuse read; the document cannot point them elsewhere. It does **not**
  bring the tunnel
  up: writing a file is reversible, starting a unit that carries the owner's link to
  the router is not. See «Tunnels» below.
* **DNS is a JSON text field.** sing-box has 16 kinds of DNS servers, the schema is
  fresh and still moving, and DNS is edited rarely; only "a valid JSON object" is
  checked. Structural forms were deliberately not built.
* **A stale reference is a mark, not an error.** A proxy listing a server that
  left the links file, and a route naming an unknown outbound, are marked in the
  tree; saving stays possible. Only the generator refuses to build a pool for a
  missing server.
* **A proxy exits one way or the other, and the form says which.** The exit field
  of a proxy is a single combo, `Sing-box` or `Tunnel`: `Sing-box` shows the outbound
  picker (the servers), `Tunnel` shows one tunnel selector. `webui.json` carries
  either `servers` or `tunnel` — never both, which is exactly what the core refuses.
  The SERVER reads the combo and takes one branch, so the form still works with
  JavaScript off: then both branches are visible and the ignored one is discarded on
  save. The script only hides the other branch and disables its fields; a `Tunnel`
  mode without a tunnel is refused with a sentence, never silently turned into
  `auto-select`. The `pinned` mark («выход зафиксирован») sits INSIDE the `Sing-box`
  branch, next to the pool it forbids, and is cleared in `Tunnel` mode.
* **The servers list keeps the stored order.** The picker draws the checked
  servers first, in the order the file holds them, and the rest of the links file
  after them. A browser submits checked boxes in document order, so any other
  layout would rewrite the list into links-file order on the first save of a form
  nobody had touched, and a server that left the links file would move to the end.
  The list is a plain set of checkboxes, so it works with JavaScript off; the
  filter box and the "clear all" button are a dozen lines of
  [`public/app.js`](public/app.js:1) that only ever HIDE a row — a checkbox
  detached from the DOM would leave the form and take its server with it. Next to
  every box the server is marked "в auto-select" or "исключён" according to
  `exclude_from_auto`, so the decision to add a server to a pool is taken with the
  facts in front of the owner.
* **Route names may not consist of digits only.** JavaScript reorders integer-like
  object keys, so a route called `2024` would silently jump to the front of the file
  and the order of the `routes` section of `config.json` would stop being
  predictable. `2024-telegram` is fine. The rule lives in the schema;
  [`src/model/project.mjs`](src/model/project.mjs:1) mirrors it and a test asserts
  the two agree.
* **Saving is atomic and versioned.** The previous version is copied to
  `<state-dir>/snapshots/webui-<ISO>.json` (the last 10 are kept) before the new
  one is written to a temporary file and renamed over the target. `webui.json` is
  written in the canonical form of this tool: two-space indent and a trailing
  newline. That is deliberately NOT the format of `config.json`, which keeps the
  reference contract (`json.dump(..., indent=2)`, no trailing newline) because the
  acceptance test compares its bytes.
* **«Сохранить» takes the open form with it.** The header button used to post the
  panel key and nothing else, so a field that had not gone through «Применить» was
  thrown away while the notice still said «Сохранено» — the owner hit it on a
  checkbox. Each panel now marks its edit form with `id="panel-form"`, and the
  button is bound to it twice over, because the header and the form live in
  different parts of the DOM: htmx pulls the fields in with `hx-include`, and
  `form="panel-form"` does the same with JavaScript off. A panel can carry more than
  one route in that single form. A panel with no edit form (`proxies`, `routes`,
  `system`, `journal`, `tests`, `providers`) keeps the old standalone button — a broken
  `form=` reference would stop it from submitting at all. `/save` applies the form
  through the very same function the panel route uses, so the two can never drift;
  the routes of a panel are applied atomically (a refusal rolls the model back), a
  rejection writes nothing and keeps the entered values, and a save that changes
  nothing answers «нечего сохранять» without writing a snapshot. «Перечитать с диска»
  stays unbound on purpose: reloading is supposed to discard.
* **One model per process.** The state (loaded file, unsaved edits) lives on the
  server, exactly as the Qt window was a thin shell over `model.py`. Two open
  browser tabs will silently overwrite each other's edits; there are no locks and
  none are planned — one tab per instance.
* **No CDN, no build step.** htmx is served from `public/vendor/`, so the editor
  works on a router without internet access, and the files are copied as they are.
* **Generation runs on the saved file**, through the same `generateConfigFile` the
  CLI uses, and says so when the editor had unsaved edits at that moment.
* **The system layer is one module.** [`src/system/index.mjs`](src/system/index.mjs:1)
  exports `restartSingBox`, `checkConfig`, `tailJournal`, `testOutbound`,
  `testOutbounds`, `geositeLookup` and the tunnel verbs `tunnelState`,
  `enableTunnel`, `disableTunnel`, `restartTunnel` plus the sudoers reader, and it
  is the only place that runs a command. Always `execFile`/`spawn` with an argument
  array — tags look like `🇨🇾 Cyprus - Limassol` and break a shell command line with
  no attacker involved.

## System layer (stage 3)

The module is testable without sing-box: the binary paths come from the
environment, and the tests point them at the fake scripts of
`tests/fixtures/bin/`.

* **`sing-box check` proves less than it sounds like.** Measured on 1.14: it
  catches an unknown inbound type and unknown fields, and it lets a duplicate
  `listen_port`, a reference to a non-existent outbound tag and a typo in
  `dns.final` through with `exit=0`. The panel therefore says «схема принята» and
  never «конфиг корректен» — a wrong label is what talks the owner into a restart
  with a config the daemon will not start.
* **generate → check → restart, in that order.** The restart button is drawn only
  after a successful check of the file on disk, and the route refuses the restart
  otherwise. The unit runs with `Restart=always`, so a config the daemon rejects
  means an endless restart loop and every connection in the house down.
* **The rollback is one click.** Before each generation the previous
  `config.json` is copied to `<state-dir>/snapshots/config-<ISO>.json` (the last
  10 are kept) and is restored byte for byte, followed by a restart.
* **The journal is a snapshot, not a live stream.** The panel runs `journalctl -u
  <unit> -n 200 -o json` once and renders the last lines; the query carries the
  unit and the minimum level. One request, no server state, no process left
  behind. The live tail was removed on 22.09.2026: `journalctl -f` over SSE needed
  a stream counter, a 409 refusal and a child killed on `req.on('close')`, and the
  real scenario is "something broke, show me why", not "watch the lines scroll".
  The structured form is kept: `-o cat` would lose the level. `MESSAGE` is NOT
  always a string — journald encodes any value containing non-printable bytes as
  an array of byte values, and sing-box colours every line, so every entry of the
  daemon arrives that way. The parser decodes the array, drops the ANSI escapes
  and cuts the duplicated `+0000 <date> <time> <level>` prefix a sing-box line
  starts with. Every SSE route answers `200` even when it refuses: `EventSource`
  never reconnects after a non-200 response, so the mass test reports "already
  running" as an event inside the stream.
* **The outbound test replaces `live_test`.** `sing-box tools fetch` starts its own
  instance, binds no inbound and never touches the running daemon, so checking 148
  servers costs zero restarts. The mass run is capped (4 at a time by default) and
  streams progress over SSE, so it cannot block a request for minutes.
* **`geositeLookup` is a stub with a sentence.** sing-box 1.14 installs no geosite
  database, the owner's routing uses plain `domain_suffix`, and there is
  deliberately no panel for it: a missing database becomes «база geosite не
  установлена» instead of a bare `FATAL`.

## Tunnels

An AmneziaWG / hidemy.name tunnel is a `gatehouse-tunnel@<file name>` unit reading
`/etc/gatehouse/tunnels/<file name>.conf`. Hand-made tunnels stay in
`/etc/amnezia/amneziawg` under the stock unit and are invisible to GateHouse — on
purpose, so an accidental click can never touch the owner's own link. Setting one
up is three separate, deliberate steps: **mark «нужен» → bring up → make a proxy**.
They are split because each is reversible on its own terms, and a single button
doing all three would drop the owner's link to the router without asking.

* **Enable «включить» (part 1).** In a provider folder every `.conf` gets a switch and
  two names: the human-readable one (`<provider>-<file stem>` by default, edited
  freely, up to 255 characters) and the file name (typed by hand, at most 15
  characters — it is also the kernel interface). Ticking validates both, normalises
  the config and writes it with mode `0600` (it carries a private key) into the
  GateHouse tunnel directory (`GATEHOUSE_AMNEZIA_DIR`, default
  `/etc/gatehouse/tunnels`), recording the entry in `webui.json` under `tunnels`.
  Identical bytes are a no-op — no file touched and no snapshot; differing bytes
  snapshot the previous version next to it as `<file name>.conf.<ISO>`. Un-ticking
  stops the unit first (with the sudoers rights) and only then removes the file. The
  switch itself never starts the unit.
* **Regeneration (part 1½).** «Настройки Amnezia» lists the enabled tunnels and
  offers one button that re-normalises and rewrites them all. A source that
  disappeared is reported per tunnel and does not stop the others; nothing is started
  or stopped, because a rewrite is reversible and a start is not.
* **Bring up (part 2).** The «Система» panel shows one row per tunnel, grouped by
  provider. The rows come from the `.conf` files of the tunnel directory plus the
  marked entries, so a tunnel is visible and manageable before any proxy exists.
  State is read from systemd (`is-active`, `is-enabled`) without `sudo`,
  never assumed: a tunnel someone started by hand is visible. One checkbox drives
  both axes (`enable --now` / `disable --now`), and a divergence — up but not
  enabled, or the reverse — is named in words, because that is what explains
  "everything vanished after a reboot". Restart asks first and names the proxies
  that will drop; `de` carries the owner's link to the router and the confirmation
  says so. The journal is the same snapshot as sing-box, with
  `gatehouse-tunnel@<name>`.
* **Proxy (part 3).** One tunnel — one proxy — one exit. A proxy with a `tunnel`
  descriptor gets an inbound `<tag>-in` and a `direct` outbound `<tag>` with
  `bind_interface` (measured live: the probe answers with the tunnel's own exit,
  `SO_BINDTODEVICE` bypasses the routing tables). No pools, no `urltest`, no
  `selector`, no mixing with VLESS — predictability over cleverness, at the price
  of no automatic failover. A proxy whose tunnel is not up gets a warning at
  generation and a tree mark that names the consequence: «порт не работает:
  туннель не поднят».
* **The start-up fuse.** Before `restart` or `enable --now` the editor reads the
  file ON DISK again and refuses without `Table = off` — such a config makes
  `wg-quick` install a default route and takes the whole router, the owner's own
  link included, into the tunnel. No flag, setting or request turns the check off,
  and a refusal returns without ever calling `systemctl`. Stopping is never blocked.
  Leftovers such as `gatehouse-tunnel@de.conf` and snapshots (`<name>.conf.<ISO>`)
  are not
  taken for tunnels.
* **Rights are shown, not granted.** The editor cannot and does not install
  sudoers rules (that is the privilege escalation the current narrow rule exists
  to prevent). It READS `GATEHOUSE_SUDOERS` and, for every tunnel lacking a rule,
  draws the three lines to paste instead of a button. `gatehouse-tunnel@*` would
  grant
  units that do not exist yet — the name comes from the file name, i.e. from data —
  so the rules are per name, without a wildcard. The install step makes the file
  group-readable for the service (`0440 root:denis`); see
  [`deploy/README.md`](deploy/README.md:1).

The generator accepts an optional `tunnelStates`/`runningTunnels` argument that
only feeds the §5.4 warning; when it is absent the core invents no warning. All of
this is additive: without a tunnel proxy the output is byte-identical to before.

### Before a tunnel is started: the fuse

Starting a tunnel from the editor (`enable --now`, and the restart button) is
refused unless the config on disk says the right thing by the very rules `awg-quick`
uses to read it — the comment is cut at `#`, keys are compared without case, and a
repeated key keeps its LAST value:

* exactly one `[Interface]` section, and written exactly like that;
* at least one `table` key in it, and every one of them `off`;
* no `preup`, `postup`, `predown` or `postdown` line — except the exact
  `PostUp`/`PreDown` pair the normaliser writes for policy routing
  (`ip rule add|del from <IPv4> table 200`);
* no `saveconfig` with anything but `false`.

A provider file with `PostUp = curl … | sh` is refused with that line quoted in
full: `awg-quick` runs hooks through bash **as root**, so a file from a provider is
a script. There is no "start anyway" flag, and stopping a tunnel is never blocked.
For the same reason the normaliser deletes the provider's hooks and `SaveConfig`,
and leaves exactly one `Table = off` in `[Interface]` — the fuse and the normaliser
share one parse, so a config the normaliser accepted always passes the fuse.

## Pinned exit

The owner's channel is throttled by DPI now and then: connections to the server
stick, and a restart helps — **on the same server**. Which server is not a free
choice: several proxies are deliberately glued to one country, because the service
on the far end watches where the login comes from. `claude-http` is fixed to
`🇨🇾 Cyprus - Limassol`, and the tool defends that on its own.

* **`pinned: true` on a proxy forbids a pool.** The proxy form carries «выход
  зафиксирован»; with it on, a save that would leave two or more servers is refused
  with «у прокси зафиксирован выход — снимите отметку, если нужен пул», and so is
  turning the flag on for a proxy that already has a pool. The list is never
  truncated silently. The tree marks a pinned proxy (`[🔒] выход зафиксирован`), so
  the lock is visible without opening the form, and `note` next to it is where the
  reason goes. The core knows nothing about the key and drops it, so `config.json`
  does not change — a test asserts that. This is protection from the owner's own
  future slip, not a sing-box mechanism: from the outside a pinned proxy cannot be
  moved anyway.

The liveness watchdog and the external HTTP API of the daemon (`clash_api`) were
**removed** from the project: a background loop that restarts the daemon on a clock
was judged a bigger risk than the problem it solved, and nothing replaced it. A
`webui.json` that still carries `watchdog`, `clash_api` or a per-proxy `watch` /
`watch_url` loads normally: those fields are dropped before validation, named in one
line in the editor — and in the `stderr` of `tools/generate.mjs` — and leave the file
on the next ordinary save. See
[`techdocs/plan_2026_09_23_gatehouse_fuse_and_no_watchdog.md`](techdocs/plan_2026_09_23_gatehouse_fuse_and_no_watchdog.md).

## Authentication and security

* **A non-loopback bind without a token refuses to start.** From this stage on the
  editor can restart the daemon and shows the VLESS keys, so `GATEHOUSE_HOST`
  that is not a loopback address together with an empty `GATEHOUSE_TOKEN` is a
  startup error with the reason and both ways out — not a line in a log.
* **Every route is behind the token, SSE included.** `Authorization: Bearer …` or
  `?token=…`; the query form is answered with an `HttpOnly`, `SameSite=Strict`
  cookie so the `EventSource` of the panels can authenticate on its own. The
  comparison is length-checked and uses `timingSafeEqual`.
* **A loopback bind plus an ssh tunnel is still the safer choice.** Over plain HTTP
  a token travels the local network unencrypted, so a LAN bind with a token is
  convenience, not protection from sniffing. There is no HTTPS termination in the
  project on purpose: use `ssh -L 8080:127.0.0.1:8080 denis@10.95.2.1` or an
  external proxy.

## Deployment

[`deploy/`](deploy/README.md:1) holds the systemd unit, the sudoers rule, the
polkit alternative and a step-by-step `deploy/README.md`. Nothing there is applied
automatically. The code lives in `/opt/gatehouse`, so the unit enables `ProtectHome=yes`
and `ProtectSystem=strict`. The latter keeps the service from rewriting its own
code while leaving the owner's `rsync` alone: the restriction lives in the unit's
mount namespace, not in the permissions on disk. `NoNewPrivileges=yes` breaks
`sudo` (setuid), so it belongs to the polkit variant — the one decision these
files still leave to the owner.
`UMask=0027` and `StateDirectoryMode=0700` are not optional: the router runs with
umask `0002` and there is a second account with a shell.

## Settings format: `webui.json`

`settings.yaml` is replaced by `webui.json`. YAML went away deliberately: nobody
edits the file by hand any more, so preserving comments (the only reason `ruamel`
lived in the Python project) is no longer a requirement. The file is validated
against [`src/schemas/webui.schema.json`](src/schemas/webui.schema.json) with
`ajv` on every load.

```json
{
  "version": 2,
  "note": "Reality transport, primary",
  "listen_ip": "10.95.2.1",
  "sources": [
    { "kind": "links", "name": "vpnd", "path": "/var/lib/gatehouse/sources/vpnd/links.txt" },
    { "kind": "tunnels", "name": "hidemyname", "path": "/var/lib/gatehouse/sources/hidemyname" }
  ],
  "output_file": "/etc/sing-box/config.json",
  "exclude_from_auto": ["🇷🇺"],
  "log": { "level": "info", "timestamp": true },
  "urltest": { "url": "https://gstatic.com", "interval": "3m", "tolerance": 50 },
  "dns": { "servers": [], "rules": [], "final": "dns-local" },
  "proxies": [
    { "tag": "main", "type": "mixed", "port": 54321, "note": "",
      "servers": ["🇫🇮 Finland - Helsinki 1"] }
  ],
  "routes": {
    "telegram": { "outbound": "🇫🇮 Finland - Helsinki 1",
                  "domains": ["telegram.org", "t.me"] }
  }
}
```

Rules of the format:

* **there is one document, the profile level is gone:** `version: 2`, no
  `profiles`, no `defaults`, no `active`. The editor migrates an old-form file and
  keeps a snapshot; the core refuses it with a message naming the editor, so
  generation never runs from a half-migrated document.
* **`sources` is a list of explicit origins**, `{kind, name, path}`. `kind:
  "links"` is one links file, `kind: "tunnels"` one directory of `*.conf`; `path`
  is stored as typed (a relative one resolves against the settings directory). A
  bare string is the legacy form of a provider folder under `GATEHOUSE_SOURCES`
  and stays readable for a file written by an older build; the editor converts it
  into an object on open. A tunnel config becomes an exit only through a proxy
  carrying a `tunnel` descriptor (see below).
* **`tunnels` lists the enabled tunnels.** Each entry carries `provider`, `file`,
  `name` (human-readable, up to 255 characters), `interface` (the `<file name>.conf`
  of the tunnel directory and the kernel interface, at most 15 characters) and an
  optional `policy_routing`. It is written when the owner ticks «включить»; additive
  to version 2, so a document without the key stays valid.
* **`amnezia_dir` is gone.** Where the tunnel configs are written is a constant of
  the build (`GATEHOUSE_AMNEZIA_DIR`, default `/etc/gatehouse/tunnels`), because the
  template unit reads a fixed path: a per-document value could point the write and
  the fuse at one file while the unit read another. The write path, the delete path,
  the template unit and the start-up fuse read this same value. An old key in a
  `webui.json` is dropped on load, with a notice, like the Watchdog fields.
* **`exclude_from_auto` is edited as a row of flags.** «Настройки Sing-Box» draws one
  checkbox per flag found among the loaded servers (`🇷🇺`, `🇫🇮`, …) with the number of
  servers it covers; a stored prefix that matches no server right now is drawn checked
  as «нет в списке», so saving never drops a rule. An empty set stores an empty list —
  "exclude nothing" — while a document that never carried the key keeps the core
  default (`🇷🇺`), shown checked.
* **`note` is a comment for humans** — in a profile and in a proxy. The core
  ignores it and it never reaches `config.json`.
* **`pinned` on a proxy is editor-only.** The core drops it, so `config.json` is
  unaffected; the rule "a pinned proxy has at most one server" is enforced by the
  model.
* **`tunnel` on a proxy is a real descriptor, not a comment.** It carries
  `provider`, `file` and `interface`; such a proxy may not list `servers` (the
  model and the core both refuse the combination — one tunnel, one exit) and the
  generator emits an inbound plus a `direct` outbound with `bind_interface`. The
  proxy tag names the outbound; the inbound is `<tag>-in`.
* **`version` does not move when fields leave the file.** The shape of the document
  does not change — only optional keys go — so `version` stays `2`, and the file is
  rewritten by the first ordinary save, with a snapshot.
* **proxy types are `socks`, `http`, `mixed`**, declared once in
  [`src/core/errors.mjs`](src/core/errors.mjs:1) (`PROXY_TYPES`) and repeated in
  the schema `enum`; a test fails if the two ever drift apart.
* **the schema complements the core, it does not replace it.** Duplicate tags and
  duplicate ports cannot be expressed in JSON Schema, so `validate_proxies` stays
  the only place catching them.
* `webui.json` and everything under `sources/` are git-ignored: they carry personal
  keys and lists. The synthetic fixtures are `tests/fixtures/sources/vpnd/links.txt`
  and `tests/fixtures/tunnel/*.conf`.

## Golden file acceptance

The byte-level comparison against the reference generator was removed on
22.09.2026: the port no longer needs a Python toolchain, and the reference is not
maintained. The property it protected is kept by a golden file instead:

* `tests/fixtures/golden/config.json` is the byte-exact output of the generator
  for the fixture model (`tests/fixtures/settings.json` + `tests/fixtures/links.txt`);
* `tests/build.test.mjs` requires generation to match it byte for byte, and still
  asserts the two format invariants — 2704 bytes and no trailing newline;
* an **intentional** change to the output updates the fixture in the same commit,
  so the difference is visible line by line in review instead of surfacing on the
  router a week later.

The fixtures are synthetic and anonymised: their UUIDs and endpoints are
placeholders, so the golden file carries no secrets.

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
| [`src/system/index.mjs`](src/system/index.mjs:1) | system boundary: `checkConfig`, `restartSingBox`, `tailJournal`, `testOutbound`, `testOutbounds`, `geositeLookup`, the tunnel verbs `tunnelState`/`enableTunnel`/`disableTunnel`/`restartTunnel` and the sudoers reader |
| [`src/system/tunnel-file.mjs`](src/system/tunnel-file.mjs:1) | applying a normalised tunnel config: 0600 write, snapshot only on change, «изменений нет», the start-up fuse |
| [`src/web/auth.mjs`](src/web/auth.mjs:1) | token transport, loopback check, the startup refusal |
| [`deploy/`](deploy/README.md:1) | systemd unit, sudoers and polkit variants, deployment notes |
| [`views/`](views/layout.ejs:1), [`public/`](public/app.css:1) | EJS templates, stylesheet, favicon, vendored htmx |
| [`tools/generate.mjs`](tools/generate.mjs:1) | CLI that writes `config.json` |
| [`tools/dev.mjs`](tools/dev.mjs:1) | `npm run dev`: the editor over the `dev/` sandbox |
| [`tools/vendor-htmx.mjs`](tools/vendor-htmx.mjs:1) | refreshes `public/vendor/htmx.min.js` from the npm package |
| [`tests/`](tests/helpers.mjs:1) | `node:test` suite and fixtures, the golden file included |
| [`techdocs/`](techdocs/architecture.md:1) | internal design notes and reports (git-ignored) |

## Porting notes

* **Warnings are data, not stderr.** The reference printed some problems (a route
  pointing at an unknown outbound, a missing `dns` section, an unparsable link)
  and continued. The port collects them into an array returned together with the
  config, so the future web UI can show them; the CLI prints them to stderr in
  the reference wording.
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
  replacement is implemented now:

  ```bash
  sing-box tools fetch -c /etc/sing-box/config.json -o "🇨🇾 Cyprus - Limassol" https://ipinfo.io
  ```

  It exits 0 within a second, never touches the running sing-box, and the mass
  test runs it per server with a bounded concurrency. See "System layer" above.

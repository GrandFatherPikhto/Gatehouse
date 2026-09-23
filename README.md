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
* **continuation — a pinned exit and a liveness watchdog**: a `pinned` flag on a
  proxy forbids a pool, and a watchdog checks each `watch: true` proxy through its
  own inbound, closes that proxy's connections on a failure and — only with the
  second-rung switch on — restarts the daemon. Implemented:
  [`src/watchdog/watchdog.mjs`](src/watchdog/watchdog.mjs:1) and
  [`src/watchdog/clash.mjs`](src/watchdog/clash.mjs:1).
* **tunnel lifecycle — file, unit, exit**: a tunnel stops being a picture. The
  normalisation preview gains «Применить», which writes the normalised
  `<name>.conf` into the amnezia directory; the «Система» panel grows a row per
  tunnel (state read from systemd, one checkbox for both axes, restart, journal);
  and a tunnel becomes a first-class proxy — one tunnel, one proxy, one exit — by
  binding a `direct` outbound to the interface. Implemented:
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
"sources": ["vpnd"],
"output_file": "etc/sing-box/config.json"
```

`sources` holds provider FOLDER names resolved under `GATEHOUSE_SOURCES`
(`dev/root/sources` by default), so it needs no rewrite as long as the folder sits
there.

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
| `--links PATH` | read one links file instead of the `sources` folders |
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
| `GATEHOUSE_CURL` | `/usr/bin/curl` | binary the watchdog probes an inbound with |
| `GATEHOUSE_SUDO` | `/usr/bin/sudo` | `sudo`; the value `none` calls `systemctl` directly (the polkit variant) |
| `GATEHOUSE_UNIT` | `sing-box` | unit name |
| `GATEHOUSE_AMNEZIA_DIR` | `/etc/amnezia/amneziawg` | directory `awg-quick@<name>` reads `<name>.conf` from; «Применить» writes it here |
| `GATEHOUSE_SUDOERS` | `/etc/sudoers.d/gatehouse` | sudoers file the editor **reads** to learn which tunnels it may control. The editor never writes it |
| `GATEHOUSE_CONFIG` | `/etc/sing-box/config.json` | default config of the commands; the UI passes the generated path |
| `GATEHOUSE_TEST_URL` | `https://ipinfo.io` | target of the outbound test |
| `GATEHOUSE_TEST_TIMEOUT` | `8000` | timeout of one outbound test, ms |
| `GATEHOUSE_TEST_CONCURRENCY` | `4` | outbound tests running at once |
| `GATEHOUSE_API_SECRET` | *(empty)* | secret of `experimental.clash_api`. **Never stored in `webui.json`**; the generator refuses to enable the API without it |

The path of the settings file comes from the environment and from nowhere else.
There is deliberately no "open file" box in the UI: a path arriving from the
browser at a process that writes files is a path traversal waiting to happen.

One tree node per screen: Общие, Провайдеры (source folders and their tunnels),
Вывод, Прокси → tag, Маршруты → name, DNS, and under Система: Журнал,
Тест серверов, Сторож. A tunnel config has its own normalisation preview screen
with the «Применить» button and, further down, the tunnel rows grouped by provider.

* **`webui.json` is flat; the profile level is gone.** The body used to be split
  between the active profile and `defaults`, but there was exactly one profile and
  `defaults` was empty, so there was nobody to inherit from. Format `version: 2`
  is one level, and «Общие» is a single panel. The editor migrates an old file
  itself: it snapshots it, flattens the single profile (several are refused with
  their names), replaces `links_file` with `sources` and bumps the version. The
  core does not read the old form and says so, so the CLI can never generate from a
  half-migrated document.
* **Sources are provider folders, not one links file.** `sources` lists folder
  names under the sources root (`GATEHOUSE_SOURCES`, default
  `<dir of webui.json>/sources`); the folder name IS the provider name. A folder
  holds `links.txt` (outbounds), tunnel configs `*.conf` (listed only), or both.
  The links are merged into one list, and **a provider label appears only when two
  providers hand out the same name**, so a single-source project keeps its tags and
  `config.json` stays byte-identical. A collision inside one file is a warning: it
  is an error in the provider's own file and the owner has to know. On the
  «Провайдеры» panel the list is edited row by row: a folder is added by picking
  one found under the root and removed by the button on its own row; the folders
  are re-read on every render. Clicking a provider opens its contents: a links
  folder shows the servers it hands out, a tunnels folder shows its `.conf` files,
  each opening the normalisation preview. No action touches the files on disk:
  "remove" means "do not read it", never "delete the owner's folder".
* **A tunnel is applied from the preview, and only then does it become a proxy.**
  The normaliser `src/core/normalize.mjs` is a pure function: it adds `Table = off`,
  drops `DNS =`, keeps the interface name within 15 characters, and copies
  `AllowedIPs` plus the obfuscation (`Jc/Jmin/Jmax`, `S1–S4`, `H1–H4`, `i1`) byte
  for byte. The screen is a diff preview with exactly one checkbox (policy
  routing) and a button «Применить», which writes `<amneziaDir>/<name>.conf` with
  mode `0600` — overwriting only when the bytes really differ, and snapshotting the
  previous version next to it (`<name>.conf.<ISO>`). It does **not** bring the
  tunnel up: writing a file is reversible, starting a unit that carries the owner's
  link to the router is not. See «Tunnels» below.
* **DNS is a JSON text field.** sing-box has 16 kinds of DNS servers, the schema is
  fresh and still moving, and DNS is edited rarely; only "a valid JSON object" is
  checked. Structural forms were deliberately not built.
* **A stale reference is a mark, not an error.** A proxy listing a server that
  left the links file, and a route naming an unknown outbound, are marked in the
  tree; saving stays possible. Only the generator refuses to build a pool for a
  missing server.
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

An AmneziaWG / hidemy.name tunnel is a `awg-quick@<name>` unit reading
`<amneziaDir>/<name>.conf`. Setting one up is three separate, deliberate steps:
**apply → bring up → make a proxy**. They are split because each is reversible on
its own terms, and a single button doing all three would drop the owner's link to
the router without asking.

* **Apply (part 1).** The normalisation preview writes the config with mode `0600`
  (it carries a private key) into `GATEHOUSE_AMNEZIA_DIR`. Identical bytes are a
  no-op — «изменений нет», no file touched and no snapshot; differing bytes
  snapshot the previous version next to it as `<name>.conf.<ISO>`. The unit is not
  started.
* **Bring up (part 2).** The «Система» panel shows one row per tunnel, grouped by
  provider. State is read from systemd (`is-active`, `is-enabled`) without `sudo`,
  never assumed: a tunnel someone started by hand is visible. One checkbox drives
  both axes (`enable --now` / `disable --now`), and a divergence — up but not
  enabled, or the reverse — is named in words, because that is what explains
  "everything vanished after a reboot". Restart asks first and names the proxies
  that will drop; `de` carries the owner's link to the router and the confirmation
  says so. The journal is the same snapshot as sing-box, with `awg-quick@<name>`.
* **Proxy (part 3).** One tunnel — one proxy — one exit. A proxy with a `tunnel`
  descriptor gets an inbound `<tag>-in` and a `direct` outbound `<tag>` with
  `bind_interface` (measured live: the probe answers with the tunnel's own exit,
  `SO_BINDTODEVICE` bypasses the routing tables). No pools, no `urltest`, no
  `selector`, no mixing with VLESS — predictability over cleverness, at the price
  of no automatic failover. A proxy whose tunnel is not up gets a warning at
  generation and a tree mark that names the consequence: «порт не работает:
  туннель не поднят».
* **Rights are shown, not granted.** The editor cannot and does not install
  sudoers rules (that is the privilege escalation the current narrow rule exists
  to prevent). It READS `GATEHOUSE_SUDOERS` and, for every tunnel lacking a rule,
  draws the three lines to paste instead of a button. `awg-quick@*` would grant
  units that do not exist yet — the name comes from the file name, i.e. from data —
  so the rules are per name, without a wildcard. The install step makes the file
  group-readable for the service (`0440 root:denis`); see
  [`deploy/README.md`](deploy/README.md:1).

The generator accepts an optional `tunnelStates`/`runningTunnels` argument that
only feeds the §5.4 warning; when it is absent the core invents no warning. All of
this is additive: without a tunnel proxy the output is byte-identical to before.

## Pinned exit, external API and the watchdog

The owner's channel is throttled by DPI now and then: connections to the server
stick, and a restart helps — **on the same server**. Which server is not a free
choice: several proxies are deliberately glued to one country, because the service
on the far end watches where the login comes from. `claude-http` is fixed to
`🇨🇾 Cyprus - Limassol`, and the tool now defends that on two levels.

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
* **The external HTTP API is opt-in and loopback only.** `clash_api` in
  `webui.json` is off by default. When it is on, the generator adds
  `experimental.clash_api` with `external_controller` and a secret; with it off the
  output stays byte-identical to the reference. `external_controller` may only name
  `127.0.0.1` — on the router the WAN address lives on the same host, and an open
  API is full control of the daemon from the internet — and the secret comes from
  `GATEHOUSE_API_SECRET`, never from `webui.json`, which would put it into the
  snapshots and the backups. An enabled API with an empty secret is a refusal with
  a sentence, like the token rule above. This is the first deliberate divergence
  from the Python reference, which cannot emit such a block.
* **The watchdog checks through the inbound.** It runs `curl -x http://…` (or
  `socks5h://…` for a socks inbound) against the local inbound of a proxy, because
  that is the road the application takes: inbound → route rule → pool → server.
  `tools fetch` checks an outbound only and would walk past a problem anywhere else.
  The default target is `https://www.gstatic.com/generate_204` — a neutral endpoint
  that exists for liveness checks and has no quota — not `ipinfo.io`, which is an
  API with a monthly limit and is the target of the **manual** server test, where
  seeing the city is the point. A target can be set per proxy next to `watch`; the
  hint next to the field states the trade plainly: a service address diagnoses
  better but puts an automatic request from the owner's exit IP on a fixed schedule.
  By default that does not happen.
* **The ladder and its fuses.** After two consecutive failures it closes the
  connections of **that** proxy only, through `GET /connections` + `DELETE
  /connections/<id>`; if the next check fails again it restarts the daemon, and only
  with the second-rung switch on. The second rung is global: it drops the
  connections of every proxy at once, and the panel says so. `api group select` is
  never used — moving a pinned proxy to another server is exactly what must not
  happen. The fuses: a 10-minute interval, two failures before acting, a 30-minute
  pause between actions on one proxy, at most three restarts a day and then «сдаюсь»
  until the owner resets it, a global switch (off means nothing runs even for a
  `watch: true` proxy), and `watch: true` which is off by default.
* **The watchdog cannot write the config.** It lives in the editor process, outside
  `src/system/`, and its only powers are closing connections and restarting the
  daemon; it reads the settings and never writes `webui.json` or `config.json`. The
  chosen server lives in the config, so a watchdog that cannot touch the config
  cannot move the exit under any circumstances — a test checks the hashes of both
  files before and after a full pass. Every decision is logged (the service writes
  to journald) and kept in a 20-event history in the panel: without it the watchdog
  is a black box doing something at night. The second rung is off until the owner's
  spike confirms that closing connections without a restart does not restore the
  link; the commands for that spike are in
  [`techdocs/done_2026_09_14_pinned_exit_and_watchdog.md`](techdocs/done_2026_09_14_pinned_exit_and_watchdog.md).

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
  "sources": ["vpnd", "hidemyname"],
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
* **`sources` is a list of provider folder names** under the sources root. A folder
  may hold `links.txt`, `*.conf`, or both; a tunnel config becomes an exit only
  through a proxy carrying a `tunnel` descriptor (see below).
* **`note` is a comment for humans** — in a profile and in a proxy. The core
  ignores it and it never reaches `config.json`.
* **`pinned`, `watch` and `watch_url` on a proxy, and the `watchdog` section, are
  editor-only.** The core drops them, so `config.json` is unaffected; the model
  enforces the pinned rule and the watchdog reads the section.
* **`tunnel` on a proxy is a real descriptor, not a comment.** It carries
  `provider`, `file` and `interface`; such a proxy may not list `servers` (the
  model and the core both refuse the combination — one tunnel, one exit) and the
  generator emits an inbound plus a `direct` outbound with `bind_interface`. The
  proxy tag names the outbound; the inbound is `<tag>-in`.
* **`clash_api` is the one section that reaches `config.json`.** Off by default;
  when on it becomes `experimental.clash_api`. The secret is deliberately not a key
  of the file — it comes from the environment.
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
| [`src/system/index.mjs`](src/system/index.mjs:1) | system boundary: `checkConfig`, `restartSingBox`, `tailJournal`, `testOutbound`, `testOutbounds`, `testInbound`, `geositeLookup`, the tunnel verbs `tunnelState`/`enableTunnel`/`disableTunnel`/`restartTunnel` and the sudoers reader |
| [`src/system/tunnel-file.mjs`](src/system/tunnel-file.mjs:1) | applying a normalised tunnel config: 0600 write, snapshot only on change, «изменений нет» |
| [`src/watchdog/watchdog.mjs`](src/watchdog/watchdog.mjs:1) | liveness watchdog: fuses, the two-rung ladder, the 20-event history |
| [`src/watchdog/clash.mjs`](src/watchdog/clash.mjs:1) | Clash-compatible HTTP API client: list and close connections of one inbound |
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

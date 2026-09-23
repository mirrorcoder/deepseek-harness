# deploy/ — running this fork of DeepSeek Harness

This directory is ours (not upstream). It runs `dsh web` as a container behind
a reverse proxy, adds our own plugins, and publishes the fork so others can
clone it and pull updates.

## Layout

| File | Purpose |
|---|---|
| `Dockerfile` | Runtime image from the published npm package `@deepseek-ai/dsh@$DSH_VERSION` (fast, no compile) + preinstalled MCP servers + our `extensions/`. Use while `main` carries no changes under `packages/*`. |
| `Dockerfile.source` | Full from-source build of this checkout (needs ~4 GB RAM for `tsc`). Built by `.github/workflows/dsh-image.yml` on GitHub; pull the result from GHCR. |
| `web-docker.patch.yml` | Cordis overlay: bind `0.0.0.0` inside the container, no session-log upload to DeepSeek. |
| `features.patch.yml` | Cordis overlay: schedule, MCP servers (memory, context7, sequential-thinking), full-text session search, OTel row removed. |
| `entrypoint.sh` | `dsh --profile web --patch … --patch … --no-open --trusted-host <public host>` |
| `install-extensions.sh` | Runs inside the container: `dsh plugin add` for each of `../extensions/*`, materialises the `pro` agent preset, sets it as default. |
| `skills/` | Seed skills copied into `$DSH_HOME/skills` on first update (never overwritten). |
| `docker-compose.yml` | `dsh` (Web UI) + `dsh-git` (read-only git mirror over HTTP) + `dsh-imggw-bridge` (unix socket to the host's Codex image gateway). |
| `login-link.sh` | Prints the one-time `?token=` URL after a (re)start. |
| `model.sh` | Configure a model without the Settings UI: `key` (stdin → `.env` → redeploy), `default <provider> <model>`, `show`. |
| `tunnel.sh` | Prints the SSH port-forward that makes the page loopback, where the full Settings UI works. |
| `telegram.sh` | Wires the Telegram broadcast: `token`, `discover`, `use <chat_id>`, `test`, `show`. |
| `update.sh` | `git pull` → rebuild → reinstall bundles → restart → tests → login link. |
| `publish.sh` | Push `main` + tags to GitHub (`origin`) and to the local mirror (`/srv/git`). |
| `sync-upstream.sh` | Merge `upstream/master` (or a release tag) into `main`. |

## Our extensions (`../extensions/`, plain ESM, no monorepo build)

| Package | What it adds | Where it is configured |
|---|---|---|
| `dsh-ext-image-gen` | `generate_image` tool: PNGs from the native image model via the host gateway (Codex/ChatGPT subscription session, no API key). Files land in `<workspace>/generated-images/` and are shown inline. | env `DSH_IMAGE_GATEWAY_TOKEN` (.env), socket `/run/imggw/gateway.sock` from `dsh-imggw-bridge` |
| `dsh-ext-peak-guard` | Cost-weighted tokens-per-minute budget; stricter in DeepSeek peak hours (01–04, 06–10 UTC Mon–Fri, minus CN holidays). Warns the model in the system prompt at 70 %, declines calls over budget with `PEAK_GUARD`. `/peak` command. | `settings.yaml` → `peak-guard:` (live) |
| `dsh-ext-compaction-pro` | Compaction engine: structured checkpoint with verbatim user directives + touched-files/commands ledger, MAX_TOKENS retry, map-reduce for over-long spans. | used by the `pro` preset (`$DSH_HOME/.agent-presets/pro`) |
| `dsh-ext-workspace-picker` | Directory dialog that opens in the workspace, keeps Home anchored there, dims caches/build output, and can show configured `places` as jump rows. Replaces the `directory-picker` row with the browse backend + client surface pair. | its row's `config` in the bundle patch (`defaultPath`, `homeAnchor`, `noise`, `places`) |
| `dsh-ext-version` | `/version` command and a system-prompt line naming the running build. | `deploy/build-info.json`, baked into the image |
| `dsh-ext-telegram` | Mirrors every session into Telegram as its own topic: ask, answer, tool lines, approvals, errors, completion ping. `/tg` tests it. | `deploy/telegram.sh`, then its row's `config` (`mode`, `tools`, `minRunSeconds`) |
| `dsh-ext-about` | An `i` button opening a panel: fork version, upstream base, installed extensions, and the release history parsed from `CHANGELOG.md` (baked into the image). | `enabled`, `maxReleases` in its bundle patch |
| `dsh-ext-efficiency` | Replaces byte-identical repeats of the same tool call with a one-line hash pointer, keeps prefix-cache accounting, and adds `/context` (window occupancy, distance to compaction, cache-hit ratio, dedup savings). | its row's `config` (`minChars`, `minSavingChars`, `excludeTools`) |
| `dsh-ext-host` | Host access: `find_projects` (what is on this machine), `add_workspace` (make any directory a workspace), `host_bash` (a command on the host through the gateway). Ships OFF and registers no tool until the switch is on. | `settings.yaml` → `host:` (live), plumbing via `deploy/host-access.sh` |
| `dsh-ext-ledger` | Spend ledger: exact tokens per project from the request stream, real money from the DeepSeek balance (sum of decreases, top-ups ignored), a daily report to Telegram at the configured hour, a daily budget warning at 80 % and at 100 %, a low-balance warning, `/cost`. | Settings → ledger (`reportHour`, `dailyBudget`, `lowBalance`, `timeZone`) |
| `dsh-ext-web-shot` | `screenshot` and `page_text`: headless Chromium inside the container, a throwaway profile per call, the page's scripts get a time budget before capture. Pictures go to `/workspace/screenshots/<project>`, never into the project. | its row's config (`chromium`, `timeoutSeconds`, `outputDir`) |
| `dsh-ext-lsp` | Bundle of the three upstream LSP rows (`dsh-lsp`, `dsh-lsp-stdio`, `dsh-tool-lsp`) with pyright and typescript-language-server from the image: definitions, references, implementations, hover. Cross-file results depend on the project declaring its source roots (e.g. `pyrightconfig.json` `extraPaths` in a monorepo). | `extensions/dsh-ext-lsp/cordis.patch.yml` |
| `dsh-ext-remote-console` | Declares this deployment's authenticated page an operator console, so the Settings pages persist to the harness home over the public URL instead of the browser tab. Ships off; this deployment's patch turns it on. | `enabled` in its bundle patch |

Each package has a `test.mjs` runnable inside the container with `node --test`
from `/data/dsh/profiles/web/node_modules/<pkg>/` (deps resolve from the
profile closure). `update.sh` runs them.

## Access model

* Public URL: `https://ds.jusl.me/` (Cloudflare → Caddy on this box → `dsh:3080`).
* Two gates: Caddy `basic_auth` (credentials in `/root/dsh-data/ACCESS.txt`), then
  dsh's own launch-token exchange. Open the URL printed by `login-link.sh` once;
  it sets a signed 30-day cookie and redirects to `/`. The token changes on each
  container start, existing cookies stay valid (secret persisted in
  `$DSH_HOME/.credentials.yaml`).
* **API keys and the Settings UI.** The client offers the privileged surface —
  settings that persist to the harness home, "open configuration file" — only
  when the page authority is loopback, its stand-in for "the operator's own
  machine". This deployment declares its authenticated page an operator console
  (`dsh-ext-remote-console`), so **Settings → Models works over the public URL**
  and stores the key in `/root/dsh-data/data/dsh/.credentials.yaml`.
  With that extension disabled the pages fall back to the browser tab and
  report *"settings are unavailable in this browser"*; the two ways to
  configure a model without them, both leaving the key on the server, are:
  * `deploy/tunnel.sh` prints an SSH port-forward; the forwarded page **is**
    loopback, so the Settings UI works fully and writes
    `/root/dsh-data/data/dsh/.credentials.yaml`. Afterwards the public URL
    works normally — the tunnel is only needed to change settings.
  * `deploy/model.sh key` stores the key in `deploy/.env` (git-ignored, 0600)
    and redeploys; the launch environment is the first credential layer the
    harness consults, so no UI is involved. `deploy/model.sh default <provider>
    <model>` sets the default route for new sessions, `deploy/model.sh show`
    reports what is configured without printing secrets.
* The agent's workspace is `/root/dsh-data/workspace` (container `/workspace`);
  it contains a clone of this fork so the harness can work on itself.

## Host access (off by default)

The harness runs in a container, so by default it can only see its own
workspace: no host disk, no host docker, no host services. `deploy/host-access.sh`
lends that boundary out, in two pieces that can be used separately.

```sh
deploy/host-access.sh status   # what is on right now
deploy/host-access.sh on       # mount / at /host, install + start the gateway
deploy/host-access.sh off      # reverse both
```

* **The disk.** `DSH_HOST_ROOT` decides what is mounted at `/host` inside the
  container; it defaults to an empty directory, and `on` repoints it at `/`.
  With it mounted, the ordinary read/edit/grep/glob tools work on every file of
  the machine, `find_projects` reports what looks like a project, and
  `add_workspace` registers one so sessions can be opened in it — from the
  sidebar or from Telegram.
* **Кто читает.** The image runs as `node` (uid 1000) and a host's interesting
  directories are 0700, so a uid-1000 harness sees the mount and cannot open a
  single project in it (`EACCES: opendir '/host/root'`). `on` therefore also
  sets `DSH_CONTAINER_USER=root`; `off` puts it back and returns ownership of
  `data/` and `workspace/` to uid 1000, because anything written as root would
  be unreadable the moment the harness stops being root.
* **The shell.** `deploy/hostd/dsh-hostd.mjs` runs on the host under systemd and
  listens on a unix socket in `$DSH_DATA_DIR/run-host/`, which is bind-mounted
  into the container. `host_bash` sends it a command; it runs it as root, in the
  host's own world — docker, compose, systemctl, package manager — and hands
  back stdout, stderr and the exit code. Every call is appended to
  `/var/log/dsh-hostd.log` before it runs.

Then the switch inside the harness: **Settings → host → enabled**. With it off
no host tool is registered at all, so the schemas cost nothing in every request
and there is no path across the boundary even with the mount in place.

Be clear-eyed about what "on" means: the socket is the whole security boundary,
and anything that can write to it can run anything on this machine. That is why
the socket is owned by the container's user and mode 0660, why the service ships
disabled, and why `host_bash` asks for approval before each call unless the
session runs under the full-access preset (`Settings → host → confirm`:
`outside-full-access` by default, `always`, or `never`). The question arrives
wherever you are — in the browser, and as buttons in Telegram.

Paths have two names and both are reported: `/root/aisignals` on the host is
`/host/root/aisignals` inside the harness. `host_bash` takes host paths;
the file tools take the `/host/...` ones. A directory that is really the
mounted workspace keeps its `/workspace/...` name rather than acquiring a
second one.

## Adding things without a rebuild

* MCP server: append an `insert` row to `/root/dsh-data/data/dsh/profiles/web/cordis.patch.yml`
  (shape in `features.patch.yml`); hot-reloaded. stdio binaries must exist in the image (add to
  `Dockerfile`) or be run via `npx -y`.
* Skill: `mkdir /root/dsh-data/data/dsh/skills/<name>` + `SKILL.md`; picked up live.
* Preset: copy in the UI (Settings → agent presets) or edit `$DSH_HOME/.agent-presets/<id>/agent.cordis.yml`.
* Budget: `peak-guard:` section in `/root/dsh-data/data/dsh/settings.yaml`.

## Distribution

* GitHub: `git@github.com:mirrorcoder/deepseek-harness.git` (remote `origin`).
* Our server: `git clone https://ds.jusl.me/git/deepseek-harness.git` (remote `mirror`,
  dumb-HTTP, read-only). A consumer updates with `git pull && deploy/update.sh --no-pull`.
* Upstream: `https://github.com/deepseek-ai/deepseek-harness` (remote `upstream`).

## Day-to-day

```sh
deploy/update.sh                 # pull + rebuild + reinstall + restart + tests
deploy/login-link.sh             # fresh login URL after a restart
deploy/sync-upstream.sh          # take a newer upstream
deploy/publish.sh                # push to GitHub + local mirror
docker logs -f dsh               # runtime log
```

## Versioning and releases

The fork has its own version line, independent of upstream: `VERSION` at the
repo root, semver, tagged `vX.Y.Z` (upstream's own `dsh-v*` tags live in the
same repo and are never touched). `CHANGELOG.md` defines what major / minor /
patch mean here and records the upstream base of each release.

`deploy/build-info.json` is the release stamp: fork version, commit, upstream
base, build date, extension versions. `deploy/gen-build-info.sh` writes it, the
`Dockerfile` bakes it to `/opt/dsh/build-info.json`, and `dsh-ext-version`
surfaces it as the `/version` command plus one line of system prompt, so both
the operator and the model know which build is answering. The container image
is tagged `deepseek-harness:<fork version>`.

Cutting a release:

```sh
$EDITOR CHANGELOG.md           # add the "## vX.Y.Z" section first
deploy/release.sh minor        # or patch / major / an explicit 1.4.0
```

`release.sh` refuses to tag a version with no changelog section or an existing
tag. It bumps `VERSION`, stamps `build-info.json`, commits, tags, pushes to
GitHub and the mirror, rebuilds, redeploys, reinstalls the bundles, runs the
extension tests and prints the login link. `deploy/release.sh --redeploy`
rebuilds the current version without bumping anything.

## Branching

`main` = upstream tag `dsh-v<DSH_VERSION>` + our commits under `deploy/`,
`extensions/` and `.github/workflows/dsh-image.yml`. Keep `DSH_VERSION` equal to
the upstream tag `main` is based on while `Dockerfile` (npm) is in use; once
`main` modifies `packages/*`, switch compose to the GHCR image built by
`Dockerfile.source`.

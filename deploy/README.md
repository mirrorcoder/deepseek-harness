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
| `dsh-ext-about` | An `i` button opening a panel: fork version, upstream base, installed extensions, and the release history parsed from `CHANGELOG.md` (baked into the image). | `enabled`, `maxReleases` in its bundle patch |
| `dsh-ext-efficiency` | Replaces byte-identical repeats of the same tool call with a one-line hash pointer, keeps prefix-cache accounting, and adds `/context` (window occupancy, distance to compaction, cache-hit ratio, dedup savings). | its row's `config` (`minChars`, `minSavingChars`, `excludeTools`) |
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

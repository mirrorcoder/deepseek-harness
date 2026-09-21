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
| `update.sh` | `git pull` → rebuild → reinstall bundles → restart → tests → login link. |
| `publish.sh` | Push `main` + tags to GitHub (`origin`) and to the local mirror (`/srv/git`). |
| `sync-upstream.sh` | Merge `upstream/master` (or a release tag) into `main`. |

## Our extensions (`../extensions/`, plain ESM, no monorepo build)

| Package | What it adds | Where it is configured |
|---|---|---|
| `dsh-ext-image-gen` | `generate_image` tool: PNGs from the native image model via the host gateway (Codex/ChatGPT subscription session, no API key). Files land in `<workspace>/generated-images/` and are shown inline. | env `DSH_IMAGE_GATEWAY_TOKEN` (.env), socket `/run/imggw/gateway.sock` from `dsh-imggw-bridge` |
| `dsh-ext-peak-guard` | Cost-weighted tokens-per-minute budget; stricter in DeepSeek peak hours (01–04, 06–10 UTC Mon–Fri, minus CN holidays). Warns the model in the system prompt at 70 %, declines calls over budget with `PEAK_GUARD`. `/peak` command. | `settings.yaml` → `peak-guard:` (live) |
| `dsh-ext-compaction-pro` | Compaction engine: structured checkpoint with verbatim user directives + touched-files/commands ledger, MAX_TOKENS retry, map-reduce for over-long spans. | used by the `pro` preset (`$DSH_HOME/.agent-presets/pro`) |

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
* API keys: **Settings → Models** in the UI. Stored in
  `/root/dsh-data/data/dsh/.credentials.yaml` (never in the image or git).
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

## Branching

`main` = upstream tag `dsh-v<DSH_VERSION>` + our commits under `deploy/`,
`extensions/` and `.github/workflows/dsh-image.yml`. Keep `DSH_VERSION` equal to
the upstream tag `main` is based on while `Dockerfile` (npm) is in use; once
`main` modifies `packages/*`, switch compose to the GHCR image built by
`Dockerfile.source`.

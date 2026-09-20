# deploy/ — running this fork of DeepSeek Harness

This directory is ours (not upstream). It runs `dsh web` as a container behind
a reverse proxy and publishes the fork so others can clone it and pull updates.

## Layout

| File | Purpose |
|---|---|
| `Dockerfile` | Runtime image from the published npm package `@deepseek-ai/dsh@$DSH_VERSION` (fast, no compile). Use while `main` carries no source changes. |
| `Dockerfile.source` | Full from-source build of this checkout (needs ~4 GB RAM for `tsc`). Built by `.github/workflows/dsh-image.yml` on GitHub; pull the result from GHCR. |
| `web-docker.patch.yml` | Cordis overlay: bind `0.0.0.0` inside the container, disable session-log upload to DeepSeek. |
| `entrypoint.sh` | `dsh --profile web --patch … --no-open --trusted-host <public host>` |
| `docker-compose.yml` | `dsh` (Web UI) + `dsh-git` (read-only git mirror over HTTP), both on the shared `aisignals-edge` network. |
| `login-link.sh` | Prints the one-time `?token=` URL after a (re)start. |
| `update.sh` | `git pull` → rebuild → restart → login link. |
| `publish.sh` | Push `main` + tags to GitHub (`origin`) and to the local mirror (`/srv/git`). |
| `sync-upstream.sh` | Merge `upstream/master` (or a release tag) into `main`. |

## Access model

* Public URL: `https://ds.jusl.me/` (Cloudflare → Caddy on this box → `dsh:3080`).
* Two gates: Caddy `basic_auth` (credentials in `/root/dsh-data/ACCESS.txt`), then
  dsh's own launch-token exchange. Open the URL printed by `login-link.sh` once;
  it sets a signed 30-day cookie and redirects to `/`. The token changes on each
  container start, existing cookies stay valid (secret persisted in
  `$DSH_HOME/.credentials.yaml`).
* API keys: **Settings → Models** in the UI. Stored in
  `/root/dsh-data/data/dsh/.credentials.yaml` (never in the image or git).
* The agent's workspace is `/root/dsh-data/workspace` (container `/workspace`).

## Distribution

* GitHub: `git@github.com:mirrorcoder/deepseek-harness.git` (remote `origin`).
* Our server: `git clone https://ds.jusl.me/git/deepseek-harness.git` (remote `mirror`,
  dumb-HTTP, read-only). A consumer updates with `git pull && deploy/update.sh --no-pull`.
* Upstream: `https://github.com/deepseek-ai/deepseek-harness` (remote `upstream`).

## Day-to-day

```sh
deploy/update.sh                 # pull + rebuild + restart
deploy/login-link.sh             # fresh login URL after a restart
deploy/sync-upstream.sh          # take a newer upstream
deploy/publish.sh                # push to GitHub + local mirror
docker logs -f dsh               # runtime log
```

## Branching

`main` = upstream tag `dsh-v<DSH_VERSION>` + our commits under `deploy/` and
`.github/workflows/dsh-image.yml`. Keep `DSH_VERSION` equal to the upstream tag
`main` is based on while `Dockerfile` (npm) is in use; once `main` modifies
`packages/*`, switch compose to the GHCR image built by `Dockerfile.source`.

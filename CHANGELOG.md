# Changelog

Versions of **this fork**, not of upstream DeepSeek Harness. Our line is plain
semver tagged `vX.Y.Z` (upstream keeps its own `dsh-v*` tags in the same repo).

* **major** — the deployment contract changes: compose services, volumes, ports,
  auth model, or a migration the operator must perform by hand.
* **minor** — new capability (a plugin, a switched-on subsystem, a new MCP server).
* **patch** — fixes, doc and prompt tweaks, dependency bumps, upstream merges
  that add no capability of ours.

Each release records the upstream base it was built from. `deploy/build-info.json`
carries the same facts into the image, and `/version` prints them in the Web UI.

## v1.4.0 — 2026-09-21

Upstream base: `dsh-v0.1.5-rc.2`.

Token efficiency, and the numbers to see it working.

- **Prefix-cache hygiene (the big one).** The usage-guard section of the system
  prompt carried live counters, and the system prompt is the head of every
  request: text that differs between two requests invalidates the provider's
  prefix cache for the whole conversation behind it. On DeepSeek that turns
  cache-hit input, priced at roughly a thirtieth of fresh input, into fresh
  input on every single turn. The section now carries only the pricing mode
  and the standing budget, which move at most twice a day; live counters live
  in `/peak` and `/context`. A regression test asserts the text does not move
  with usage.
- **Content-hash dedup** (`dsh-ext-efficiency`). A call that repeats both the
  tool and its exact arguments, and whose result hashes to what that same call
  returned before, is replaced with a one-line pointer naming the earlier call,
  its digest and a short preview. A result whose output moved never matches its
  own hash and is always delivered in full, and a pointer that would not be
  decisively smaller than the text is not used at all.
- **`/context`** — window occupancy with a bar and the compaction threshold
  marked, tokens left before this session condenses, the active route, the
  cache-hit ratio, cost-weighted tokens saved by the cache, and how much dedup
  kept off the wire.

## v1.3.0 — 2026-09-21

Upstream base: `dsh-v0.1.5-rc.2`.

- **Settings work on the public URL** (`dsh-ext-remote-console`). The client
  offers host-persisted settings only to a page it considers the operator's
  own, which it infers from a loopback authority. This deployment serves one
  operator behind TLS, a reverse-proxy login and the harness session cookie,
  so it declares the page an operator console through one structured
  index-injection row (`__DSH_TRANSPORT__ = { ownsHost: true }`). Settings →
  Models can now store an API key over the public URL and no tunnel is needed.
  No transport hooks are declared, so the page keeps the ordinary HTTP +
  WebSocket carrier.
  The package ships `enabled: false`; this deployment's bundle patch turns it
  on. Turn it back off before sharing the URL with people who may use the
  agent but must not edit the configuration.
  `deploy/tunnel.sh` and `deploy/model.sh` from v1.2.0 remain as alternatives.

## v1.2.0 — 2026-09-21

Upstream base: `dsh-v0.1.5-rc.2`.

Configuring a model did not work through the public URL: the client withholds
host-persisted settings from any page whose authority is not loopback, so
Settings → Models reports "settings are unavailable in this browser" and has
nowhere to store an API key. That gate is upstream's and deliberate; these are
the two ways around it that keep the key on the server.

- `deploy/model.sh` — `key` reads a credential from stdin into `deploy/.env`
  (git-ignored, 0600) and redeploys, `default <provider> <model>` writes the
  default route into `settings.yaml` live, `show` reports the configuration
  without printing secrets.
- `deploy/tunnel.sh` — prints the SSH port-forward that makes the page loopback
  for real, where the Settings UI works unchanged.
- `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` pass from
  `deploy/.env` into the container: the launch environment is the first
  credential layer the harness consults.

## v1.1.0 — 2026-09-21

Upstream base: `dsh-v0.1.5-rc.2`.

- **Workspace picker** (`dsh-ext-workspace-picker`): the "Select Workspace
  Directory" dialog now opens in the workspace root instead of the account's
  home directory, keeps its breadcrumb Home anchored there while you browse,
  and flags package caches, build output and VCS internals hidden so the level
  shows real project directories first. Configured `places` add jump rows to
  the first level. It replaces the adaptive chooser row with the browse pair
  the seam documents as its swap point; breadcrumbs, "New folder", truncation
  and symlink handling stay upstream's.
- `/workspace/projects` is created as an obvious home for new work.
- `deploy/update.sh` now restarts the same way `release.sh` does, by letting
  the process exit into the restart policy, since bundle membership is only
  read at boot.

## v1.0.1 — 2026-09-21

Upstream base: `dsh-v0.1.5-rc.2`.

- `/version` reported a commit hash that exists in no branch: the stamp was
  written, committed, then folded into an amended commit, so it named the
  pre-amend object. The commit and build timestamp now travel as build args
  into the image environment and OCI labels; `build-info.json` keeps only the
  facts a commit can carry about itself. `dsh-ext-version` merges the two and
  lets the environment win over a stale value in the file.

## v1.0.0 — 2026-09-21

Upstream base: `dsh-v0.1.5-rc.2`.

First release of the fork as a running deployment.

### Deployment
- Containerised `dsh web` behind the box's shared Caddy at `https://ds.jusl.me`,
  two gates: Caddy basic auth, then dsh's own launch-token cookie.
- `deploy/Dockerfile` builds a runtime image from the published npm package and
  preinstalls the MCP servers; `deploy/Dockerfile.source` + GitHub Actions build
  from source for local changes under `packages/*`.
- Public read-only git mirror of the fork served at `/git/deepseek-harness.git`.
- Overlays: bind `0.0.0.0` inside the container, no session-log upload to
  DeepSeek, OTel row removed.

### Capabilities
- `generate_image` (`dsh-ext-image-gen`): images from the native image model
  through the host's Codex-session gateway over a unix socket. Files land in
  `<workspace>/generated-images/` and inline in the chat.
- Usage guard (`dsh-ext-peak-guard`): cost-weighted tokens-per-minute budget,
  stricter during DeepSeek peak hours, warning in the system prompt at 70 %,
  refusal over budget, `/peak` command, live settings section.
- Compaction (`dsh-ext-compaction-pro`, preset `pro`, default): extended
  checkpoint sections, deterministic ledger of touched files / commands / user
  directives, retry on token-cap truncation, map-reduce for over-long spans.
- Switched on: schedule, full-text session search, MCP servers `memory`,
  `context7`, `thinking`.
- Seed skills: image generation, token economy, harness self-service.

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

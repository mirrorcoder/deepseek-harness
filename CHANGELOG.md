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

## v1.8.1 — 2026-09-21

Upstream base: `dsh-v0.1.5-rc.2`.

The answering bot from v1.8.0 never actually listened. Three faults, each
hiding the next:

- The settings block was mounted before the functions it calls were declared,
  so it threw a temporal-dead-zone error at boot and the broadcast ran with no
  destinations at all — while the panel kept working, because it calls Telegram
  directly. It is now mounted last, with a comment saying why.
- Folding the stored settings section over the plugin configuration used a
  plain spread, and a key the document does not mention arrives as an explicit
  `undefined`, which erased the `commands` default. `mergeSection` now skips
  undefined values.
- The listener was keyed by the resolved token, but at boot the credential
  store has not loaded yet, so the token was empty and no listener was ever
  created — and nothing retried. Listeners are keyed by credential reference
  and resolve the token inside each round, so a late store just makes the first
  round fail and the next one succeed.

This deployment has no logger, so all three were invisible. The panel's state
route now reports what the process is really doing — live destinations, running
listeners, whether commands are on, and the last error — and each row says
whether its bot can answer (`listening`, `conflict`, `no-token`, `off`).

## v1.8.0 — 2026-09-21

Upstream base: `dsh-v0.1.5-rc.2`.

- **The bot answers.** Until now the bridge only wrote: a person sending
  `/start` got silence, which reads as broken even though the broadcast works.
  The bot now keeps one long-polling consumer per token and replies to
  `/start` (confirms the chat and prints its id), `/id`, `/status` (what the
  broadcast is currently wired to) and `/help`. Replies go back into the
  thread they came from.
- Telegram allows exactly one update consumer per bot. A conflict stops that
  poller with an explicit log line instead of fighting another process, `/tg`
  reports it, and `commands: false` turns the whole thing off for a token that
  belongs to something else.
- "Найти чаты" now prefers what the running poller has seen, because a second
  `getUpdates` would be answered with the nothing it already consumed.

## v1.7.1 — 2026-09-21

Upstream base: `dsh-v0.1.5-rc.2`.

- **The add form could not be completed.** "Найти чаты" existed only on an
  already-saved bot, and saving required a chat id, so the first bot could
  never be added from the panel — the field's own placeholder pointed at a
  button that was not on screen yet. The button now sits next to the chat id
  field, works from the token typed into the form (nothing is stored to look),
  and each chat it finds is a click that fills the field. The form also says
  plainly that a bot cannot write first, so `/start` comes before looking.

## v1.7.0 — 2026-09-21

Upstream base: `dsh-v0.1.5-rc.2`.

- **Bots are added from the page.** The ✈ button opens a panel that adds,
  tests, enables and removes Telegram destinations without touching a shell:
  paste a token, let it validate against `getMe`, press "найти чаты" to list
  the chats that have written to the bot, pick one, done. Several bots and
  chats can run at once, each with its own verbosity.
  Tokens go to the credential store (`$DSH_HOME/.credentials.yaml`) and never
  into settings, the session log or the browser — the panel only ever learns
  whether a token exists. Destinations live in `settings.yaml` under
  `telegram:` and are applied live, with no restart.
  The panel's routes are registered inside the harness authentication fence,
  so they are reachable only by an authenticated session, exactly like the
  rest of `/api`.
- A deployment wired through `deploy/.env` before the panel existed keeps
  working, shown as a read-only destination.

## v1.6.0 — 2026-09-21

Upstream base: `dsh-v0.1.5-rc.2`.

- **Telegram broadcast** (`dsh-ext-telegram`). Every session is mirrored into
  Telegram as its own topic — Telegram lets a bot open topics inside a private
  chat, so the target can be the operator's own chat with the bot, and a forum
  supergroup behaves the same. The thread carries the ask, the answer, a
  one-line trace of each tool call, anything the agent is blocked on, errors,
  and a completion ping with duration and token usage for runs past a
  threshold. A chat without topics falls back to plain prefixed messages.
  The outbox is serial, rate-limited and bounded, and every failure is reported
  rather than raised, so a broadcast problem can never fail a turn. `/tg` sends
  a test line and reports the outbox state.
- `deploy/telegram.sh` wires it: `token` (from stdin), `discover` (which chats
  have written to the bot), `use <chat_id>`, `test`, `show`.

## v1.5.0 — 2026-09-21

Upstream base: `dsh-v0.1.5-rc.2`.

- **"What is this build" panel** (`dsh-ext-about`). A small `i` button in the
  bottom-right corner opens a panel listing the fork version and the upstream
  release it is built on, every extension installed on top, and the release
  history with dates — this changelog, baked into the image and rendered from
  it. The Web UI's own panels are React plugins built inside the monorepo,
  which a package installed from outside it cannot produce, so this is a
  self-contained overlay contributed through the page's structured injection
  seam: scoped styles, one button, one dialog, a few lines of vanilla script,
  and nothing the app owns is touched.

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

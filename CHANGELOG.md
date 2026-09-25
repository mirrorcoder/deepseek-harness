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

## v1.24.0 — 2026-09-25

Upstream base: `dsh-v0.1.5-rc.3`.

- **Dictation about twice as fast.** On this CPU the encoder is ~90 % of a
  transcription, and whisper encodes a full 30-second window however short the
  phrase. Measured on a 4-core EPYC: a 4.5 s phrase went from 3.7 s to 2.2 s,
  an 11 s one from 6.1 s (the old settings) to 2.4 s, with the same words.
  Four changes, each a setting that can be switched back: every core instead
  of three; greedy decoding instead of a beam of five; no temperature
  fallback, which re-decodes a segment whenever the model is unsure and
  doubled the time on a phrase cut off mid-word (8.3 s instead of 4.2 s, same
  text); and a phrase of up to 13 s is encoded in a 768-frame (15.4 s) window.
  Smaller windows are not used: at 384 and 256 frames the model began to
  repeat itself and took longer. Telegram voice notes get the same speed-up.
- **A Download button on every deliverable card** (`dsh-ext-files`). Upstream's
  card can only open a file on the Host's own desktop, and a harness in a
  container has none: "This Host has no desktop available to open files or
  folders". The button sits next to Open and is a plain link to
  `GET /api/files/download?path=…`, inside the harness authentication fence:
  one regular file from a registered workspace (or `/workspace`), streamed,
  under its real name — a Cyrillic name arrives intact through the UTF-8
  `filename*`. The path is resolved to its real location before the check, so
  neither `..` nor a symlink inside a workspace reaches a file outside it.
- **Fixed: web search failed on every call** with "DeepSeek returned an
  unprocessable response body: Unexpected token 'e'". Importing npm undici 8
  (the proxy plugin does) installs its Agent as the process-wide dispatcher,
  and Node 22's built-in `fetch` — undici 6 — then reaches it through a legacy
  wrapper. undici 8.11.0's Agent negotiates HTTP/2, and over HTTP/2 that
  wrapper handed `fetch` no response headers at all: DeepSeek's
  brotli-compressed search replies were never decompressed, and every header
  of every built-in `fetch` over HTTP/2 was lost. undici 8.11.2 fixes the
  wrapper; the image now requires it (`overrides` in the runtime manifest), and
  `deploy/test-runtime-fetch.mjs` — an HTTP/2 server answering in brotli, run
  after every deploy — fails on 8.11.0 and passes on 8.11.2. (Hot-applied to
  the running container first, while the disk was too full to build.)
- **Fixed: a deploy could fill the disk and take down its neighbours.** On
  2026-09-23 the v1.23.0 deploy unpacked its image into the last free bytes of
  a shared box: the production Redis next to the harness could not save,
  refused writes for 42 seconds, and its worker crash-looped. Every deploy was
  a cold ~3.5 GB build, because `update.sh` wiped the whole build cache after
  each deploy — and wiped it again before building whenever space was short.
  Now the cache a build used is kept (only cache unused for a week goes), so
  the next deploy costs ~50 MB; a deploy refuses to start below 2 GB free; and
  the build runs under a disk guard that stops it — docker, the compose plugin
  and buildx together — the moment free space falls under 1 GB
  (`DSH_MIN_FREE_MB`). The running harness is never touched by a stopped build.
  `deploy/test-lib.sh` covers the guard, including a Ctrl-C mid-build.
- `release.sh` deploys through `update.sh` instead of its own drifted copy
  (no disk guard, a restart wait that trusted stale log lines, seven
  extensions missing from its test list).

## v1.23.1 — 2026-09-23

Upstream base: `dsh-v0.1.5-rc.3`.

Two defects the first live use found within the hour.

- **Fixed: dictated text went in twice, with an error on top.** The composer
  is a Lexical editor, and Lexical renders on its own tick: right after the
  insert the page still shows the old text. The microphone checked
  synchronously, concluded the insert had failed, inserted the same words a
  second time through the paste fallback and reported an error — the operator
  saw "Слышишь?Слышишь?" under a red pill. The result is now judged only after
  the editor has rendered, and the fallback runs only when the first way really
  did nothing.
- **Fixed: screenshots hung on any page that keeps a connection open.** The
  first version used Chromium's own `--screenshot` with a virtual-time budget,
  and virtual time only advances while the network is idle — on a page holding
  an SSE stream, a websocket or a long poll it never is. The harness's own UI
  is such a page; so are most apps worth checking. `screenshot` and `page_text`
  now drive the browser over the DevTools protocol with Node's built-in
  WebSocket: navigate, wait for the load event (capped), wait the requested
  real time for the page's scripts, capture. They also report the main
  document's HTTP status, and `page_text` reads the rendered `innerText`
  instead of stripping tags from a DOM dump. A regression test serves a page
  with a never-ending event stream and a script that renders late, and
  requires both to be captured.
- **Fixed: throwaway browser profiles piled up in `/tmp`.** A killed Chromium
  keeps writing to its profile for a moment, and removing the directory right
  away raced it (`ENOTEMPTY`) — the directory survived every capture. The
  capture now waits for the browser to really exit before returning, and the
  removal retries.

## v1.23.0 — 2026-09-23

Upstream base: `dsh-v0.1.5-rc.3`.

Deployed, never tagged on its own: its two defects were found in the first
hour, and it went into the repository together with the fixes as `v1.23.1`.

- **A microphone in the web composer** (`dsh-ext-voice`). Beside the paperclip:
  click to record, click again to stop, Esc to cancel. The browser decodes what
  it recorded — WebM in Chrome, MP4 in Safari, Ogg in Firefox — and resamples
  it to 16 kHz mono WAV itself, which is exactly what whisper reads, so the
  server needs no converter. The transcript is inserted into the composer where
  the caret is, not sent: dictation makes mistakes, and the operator fixes them
  before anything reaches the agent. The composer is a Lexical editor, so the
  text goes in through the editing events it listens to rather than by writing
  to the element. The button is anchored on the composer's hidden file input,
  which the upstream markup keeps next to the paperclip, and re-placed whenever
  the app re-renders the composer.
- **One speech service for the box.** Whisper moved out of the Telegram bridge
  into `ctx.voice`; the web microphone and Telegram voice notes both go through
  it, so there is one model, one download and one queue — two surfaces asking
  at once wait their turn instead of running two CPU-heavy transcriptions side
  by side.
- The deploy-time shipping check now also follows files a module reads beside
  itself (`new URL('./x', import.meta.url)`): a missing browser script would
  have failed exactly as silently as the missing module did in v1.21.0.

## v1.22.0 — 2026-09-23

Upstream base: `dsh-v0.1.5-rc.3`.

**Runs on any Linux server with Docker, from one command.**

- **`deploy/bootstrap.sh`.** From a fresh clone to a running harness:
  `.env`, the data directory, and — with `--domain` — the bundled Caddy's
  config with a generated password, then `update.sh` builds, starts, installs
  the extensions, restarts, tests and prints the login link. Without `--domain`
  the harness stays on `127.0.0.1:3080` for an SSH tunnel. It refuses before
  changing anything when ports 80/443 are already taken, hashes the password
  over stdin so it never appears in a process list, and is safe to run again:
  existing values, the password and the data are kept.
- **The compose file is portable; this machine is an override.** Everything
  that belongs to the box this fork grew up on — the external `aisignals-edge`
  network behind its shared Caddy — moved to `docker-compose.jusl.yml`,
  layered on through `COMPOSE_FILE` in that box's `.env`, with `!override` so
  the merged configuration is exactly the old one: a dry run recreated
  nothing. The git mirror and the image-gateway bridge became compose profiles
  instead of mandatory services, and the stack brings its own network and,
  under the `proxy` profile, its own Caddy.
- **No host tooling needed but Docker.** Stamping a build no longer calls node
  on the host, and the import check runs in the build's own node image when the
  host has none.
- **Host access stays off.** Nothing in the one-command path mounts the host's
  disk or installs the command gateway; `bootstrap.sh` ends by naming
  `deploy/host-access.sh on` as a separate, deliberate step.
- Verified on this box without touching production: an isolated copy of the
  standalone stack, under its own project name, network and ports, came up
  healthy, installed every extension and passed their tests; through the
  bundled Caddy an unauthenticated request got the password challenge, a
  wrong password was refused, and the right one plus the login link reached
  the harness and set its cookie. `bootstrap.sh` itself was exercised on a
  copy with the build stubbed: port refusal, local mode, domain mode (Caddy
  validated the generated config), and a re-run keeping the password.

## v1.21.0 — 2026-09-23

Upstream base: `dsh-v0.1.5-rc.3`.

Five things an operator notices on the first day.

- **What it cost, every evening** (`dsh-ext-ledger`). Money is read from the
  provider's own balance: DeepSeek reports it, and the sum of its decreases
  over a day is exactly what was billed — whatever the model, the cache ratio
  or the peak discount — while an increase is a top-up and is ignored. The
  day's series starts from yesterday's last reading, so the spend between
  midnight and the first reading of the day, or across a restart, still lands
  somewhere. Tokens come from the request stream, exact, tagged with the
  project each session runs in. At the configured hour a report goes to
  Telegram: spend, balance, per-project tokens and cache ratio, and the
  sessions that were worked on. A daily budget warns once at 80 % and once
  when exceeded; a low balance warns once a day. `/cost` shows the same report
  on demand; budget, hour and thresholds live in Settings → ledger.
- **Reports get their own topic.** Other extensions reach the operator through
  a `telegram/notify` event, and the bridge posts those into one dedicated
  "📊 Отчёты и бюджет" topic instead of whichever session thread was last
  active, so a budget warning never lands in the middle of a conversation. A
  message written in that topic gets a hint rather than a new session.
- **"Ночью" means the cheap hours** (`offpeak_slot`, `/night`). The tool
  answers from the same pricing calendar the peak guard uses: whether now is
  peak, when the next off-peak stretch starts and ends, and when tonight is on
  the local clock. `/night <задача>` asks the agent to run the task now if it
  is already off-peak and otherwise to put it on the schedule — in the same
  session, so the result comes back to the same thread.
- **Voice notes are tasks.** A voice note sent to the bot is transcribed on this
  machine by whisper.cpp — built into the image, one transcription at a time —
  and handled exactly like typed text, after echoing back what was heard so a
  misheard word is caught before the agent acts on it. The model is not baked
  into the image: it is fetched into `$DSH_HOME/models` on the first voice note
  and kept across updates. `opusdec` does the Ogg-to-WAV step without pulling
  in all of ffmpeg.
- **The agent can look at a web page** (`dsh-ext-web-shot`: `screenshot`,
  `page_text`). Headless Chromium runs inside the container, one process per
  call with a throwaway profile, and the page's own scripts get a time budget
  before the capture, so a client-rendered app is photographed after it
  rendered. Only http(s) addresses. No external screenshot service: anyone who
  builds this repository gets the same tool.
- **Code navigation through real language servers** (`dsh-ext-lsp`):
  definitions, every use, implementations and hover for Python (pyright) and
  TypeScript/JavaScript (typescript-language-server), both installed in the
  image. The three upstream packages sit outside the app's dependency closure,
  so the installer puts them into the profile first — and mounts the bundle
  only when all three are really there, because a row naming a plugin that
  does not resolve stops the whole composition from booting.
- **Fixed within the release: the Telegram bridge did not load.** `voice.js`
  was in the repository and in the image but not in the bridge's package
  `files`, and the profile install copies only what that list names — so the
  installed bridge could not import it and silently failed to mount. Tests
  passed, because they import pure modules; the deploy passed, because a
  plugin that fails to mount does not stop the harness. The bot was down for
  about ten minutes. `deploy/check-extensions.mjs` now walks every extension's
  imports from its entry point and fails the deploy, before anything is built,
  when one of them would not be shipped.
- **Verified live, one run each.** A real recording through the whole voice
  path — Ogg, `opusdec`, whisper, first-use model download — transcribed word
  for word in 11 s, 8 s once the model is on disk. A page screenshot takes 2 s
  and its rendered text 1 s. In a real session the agent reached for
  `offpeak_slot`, `lsp` and `screenshot` on its own, and the report hour moved
  to the current hour produced the report in a new "📊 Отчёты и бюджет" topic.
- **Fixed after that run: screenshots landed inside the project.** The first
  one was written to `screenshots/` in the operator's own repository, an
  untracked directory in someone's git tree. They now go to
  `/workspace/screenshots/<project>`.
- **Known limit of the LSP route:** pyright only follows imports it can
  resolve, so in a monorepo whose packages live under `apps/*/src` a
  cross-file `findReferences` returns the in-file uses only until the project
  declares its source roots. On the live run the agent noticed the gap itself
  and cross-checked with grep.
- The installer now handles every such upstream package the same way: from
  the image's copy, version-checked against the profile, never fatal.

## v1.20.1 — 2026-09-23

Upstream base: `dsh-v0.1.5-rc.3`.

- **Fixed: the pointer pass was a silent no-op.** It looked up which tool
  produced each result by walking the session SURFACE for `tool/call` events —
  and a call is not a surface node: the surface carries the assistant message
  that contains the call as a block, while the standalone call event is
  log-only. The map came out empty, every result looked like it came from an
  unknown tool, and the pass did nothing at all. Nothing threw, nothing logged:
  a no-op pass is indistinguishable from a pass with nothing to do. It took a
  deliberate run at a lowered threshold to see it. Calls are now read from the
  log.
- **Fixed: the checkpoint carried no recall pointer.** Whether the recall tools
  exist was asked of the host tool registry with no scope, and those tools are
  registered by the AGENT preset — so the answer was always no, and the first
  real checkpoint shipped without the one line that makes compaction
  recoverable. The question is now asked of the summarization request's own
  tool list, which is the same question asked where the answer is true.
- Verified on that run: pruning fires, the compaction transaction opens and
  closes, two of the four attempts correctly refused their own summary for not
  being smaller than what it replaced, and the session kept answering
  throughout.
- A `probe` preset is regenerated beside `pro` on every update: the same
  composition with compaction at 1% of the window. The pruning path is
  otherwise unreachable in testing, and the first pointer pass stayed a silent
  no-op for exactly as long as nobody could make it run.
- `deploy/telegram.sh topic-close` now forgets a topic Telegram no longer has
  instead of failing: a thread the operator deleted by hand would otherwise sit
  in the remembered list forever.
- **Worth knowing: the DeepSeek adapter advertises a 1,000,000-token window**,
  so the 0.85 threshold means compaction only begins around 850k tokens of
  live surface. On this deployment that is a rare event, not a routine one —
  the practical limits are cost per request and the provider's own per-request
  cap, not the compaction threshold.

## v1.20.0 — 2026-09-23

Upstream base: `dsh-v0.1.5-rc.3`.

- **The model-free pass now knows what is recoverable** (`dsh-ext-prune-pro`).
  Upstream prunes at the last moment — once pressure qualifies, it prunes,
  remeasures, and skips the expensive LLM compaction entirely if that alone got
  under the threshold — so how hard this pass bites decides whether a
  conversation gets summarised at all. It bit the same way for every result:
  keep 2048 characters of head, 512 of tail. That is right for a command's
  output, which exists nowhere else, and wasteful for a file read, which is a
  copy of something still on disk. Regenerable results (`read`, `read_image`,
  `glob`, `find_projects`) now collapse to a pointer naming the source, how to
  get the current content, and how to recover exactly that version from the log
  with `session_event_read`. Everything else keeps upstream's treatment,
  because our pruner subclasses upstream's and calls it.
  Three defects in that pruner were found by the harness itself, reviewing this
  diff: `glob` names both a pattern and a path and the pointer took the path,
  sending a re-read back with the pattern lost; `read_image` was listed as
  regenerable although its result carries an image block the replacement would
  have silently dropped; and the extension was not yet committed while the
  preset already referenced it, which fails a deploy from a fresh clone AFTER
  the container has been recreated. All three are fixed here.
- **The original task is pinned into every checkpoint.** It is read from the
  LOG rather than the surface, so by the second compaction — when the first
  request has long been replaced by a checkpoint — it is still the user's own
  wording rather than a summary of a summary. A resumed agent that loses this
  drifts politely away from what was actually asked.
- **A child can be sent to a named model.** `subagent-model-selection` is on
  with the four DeepSeek routes allow-listed, so `subagent` takes
  `provider`/`model`/`reasoning_effort` and `list_subagent_models` advertises
  what may be chosen. "Use an agent on model X for this" is now a thing the
  model can act on. A provider added as a route in Settings → `llm-pi-ai`
  (OpenAI-compatible gateways, self-hosted servers, pi-ai catalogs) must also
  be added to that allowlist before a child may select it.

## v1.19.1 — 2026-09-23

Upstream base: `dsh-v0.1.5-rc.3`.

- **Fixed: the specialised delegates were invisible in practice.** Upstream
  gives every `tool-subagent` instance the same generic description ("delegate
  a self-contained task…"), so mounting `explore` and `review` beside the
  generic `subagent` advertised three identical tools and the model had no way
  to tell which one searches. Measured on a real task — "find where the
  postbacks are handled" — it used none of them: twelve inline grep/read/bash
  calls, every byte landing in the parent's context, which is exactly what the
  delegates exist to prevent. A short prompt section now says what each one is
  for, registered only for the delegates the registry really holds and computed
  from membership that does not change inside a session, so the prefix cache
  survives. Cost: about 90 tokens per request.
- Same run confirmed memory works unprompted: asked to keep what matters for
  future sessions, the agent called `remember` on its own and wrote a note that
  a fresh session now starts with.

## v1.19.0 — 2026-09-23

Upstream base: `dsh-v0.1.5-rc.3`.

- **Base moved to `0.1.5-rc.3` and the override is gone.** rc.2 only installed
  because of an `overrides` pin: `dsh-client-ui-sidebar-documentpreview@^0.1.5-rc.3`
  had never been published and the registry jumped straight to `0.1.6-alpha.1`,
  so npm failed with ETARGET while resolving it. Upstream has since published
  that version, rc.3 resolves on its own, and the pin is removed. The upstream
  step itself is three commits of version bumps, which is exactly the size of
  step worth taking promptly.
- **The recall tools now ride the app's version line.** They are published
  outside the app's dependency closure, so the manifest asks for them by name at
  `${DSH_VERSION}` rather than at a pinned `0.0.1-rc.1`, and the installer
  compares the profile's copy against the image's and replaces it when they
  differ. The profile copy is what a preset row actually loads: a tool package
  left a release behind the host is a seam whose shape quietly stops matching.

## v1.18.0 — 2026-09-23

Upstream base: `dsh-v0.1.5-rc.2`.

Two ways to keep context out of the window instead of compressing it after the
fact.

- **Specialised delegates** (`explore`, `review`). The cheapest context is the
  one that never enters the parent: a sweep that reads thirty files costs the
  parent thirty file dumps it carries to the end of the session, but costs one
  paragraph when a child reads them. `explore` is read-only by tool filter and
  answers with a conclusion plus `file:line` evidence; `review` may run tests
  and answers with findings or with "nothing wrong found". Neither pins a model:
  the child inherits the parent's route, so switching models does not strand a
  preset row.
- **Memory across sessions** (`dsh-ext-memory`). Durable notes under
  `$DSH_HOME/memory`, one directory per workspace plus a global one, loaded into
  the system prompt at session start. `remember` writes one, `forget` removes
  one or lists what is stored. The snapshot is taken at the FIRST prompt
  assembly and never recomputed inside a session: the system prompt is the head
  of every request, so a section that changes mid-conversation invalidates the
  provider's prefix cache for all of it. A note written now therefore lands in
  the next session, and the tool says so rather than quietly rewriting the head
  of this one.
- **Two skills** encoding the discipline: when to delegate and how to phrase a
  child's instruction, and what belongs in memory versus in a checkpoint versus
  in the searchable log.
- **Topics are remembered when they are opened, not when they are written in,
  and can be closed from the command line** (`deploy/telegram.sh topics`,
  `topic-close <threadId>`). Telegram cannot list a private chat's topics, so a
  thread id the process forgets is a thread nobody can delete except by hand —
  which is exactly what a few test runs left behind.
- **Deploys clean up after themselves.** `update.sh` prunes the build cache when
  free space is under 4 GB before building, then drops the superseded image tag
  and reports disk occupancy after. The box has run out of space mid-deploy
  twice, and an ENOSPC during a build leaves a container that cannot restart.

## v1.17.0 — 2026-09-22

Upstream base: `dsh-v0.1.5-rc.2`.

Compaction stops being loss and becomes paging.

- **The checkpoint now says where the rest went.** Every compacted span is
  still on disk event by event, so the checkpoint ends with the session id and
  the two tools that read it back, plus the instruction to prefer one recall
  call over one wrong assumption. The pointer is written only when the registry
  really holds those tools: a promise the deployment cannot keep would cost a
  wasted call at exactly the wrong moment.
- **The recall tools are mounted** (`@deepseek-ai/dsh-tool-session-query`,
  which upstream publishes separately and leaves out of the app's dependency
  closure). `session_event_search` and `session_event_read` stay visible in
  every request; the cross-session and lineage half (`session_search`,
  `session_trace`, `session_event_trace`) goes into a new `history` group of
  the toolbelt, hidden until asked for.
- **Tool results are pruned harder** — 4096/2048/512 instead of 8192/4096/1024
  — which is only defensible because the pruned middle is now recoverable.
- **Every user message survives compaction.** The ledger carried the last ten
  instructions, truncated at 400 characters; it now carries all of them up to a
  24k budget, trimmed from the old end and saying so when it trims. What the
  user asked is the specification of the work: it costs a fraction of one
  pruned tool result and must never be paraphrased.
- **Two more anchors in the ledger.** The plan exactly as the agent last wrote
  it, and the most recent failed tool calls with their error text. A resumed
  agent that has lost the plan or forgotten what was broken re-derives both
  expensively, usually by repeating the failure.
- **Compact later, keep more, write longer.** Thresholds move from 0.80/0.16 to
  0.85/0.20 and the checkpoint cap from 8k to 16k. Compaction rewrites the head
  of the conversation and so invalidates the provider's prefix cache for
  everything after it; with a DeepSeek cache hit at a thirtieth of a miss, one
  deep compaction is cheaper than two shallow ones — and twelve sections do not
  fit in 8k.
- Every edit to the shipped `standard` preset now lives in `deploy/preset-pro.mjs`,
  anchored on text upstream really has, refusing rather than guessing when an
  anchor is missing.

## v1.16.1 — 2026-09-22

Upstream base: `dsh-v0.1.5-rc.2`.

- **Fixed: host access mounted nothing.** `find_projects` declared its output as
  an array of bare objects, and the tool registry requires every object node to
  say `additionalProperties` out loud. The schema threw while the plugin was
  mounting — and a plugin that throws there mounts NOTHING: no tools, no
  settings section, and in this build no logger to say so. The switch was on,
  the gateway was running, and the harness had no host tools at all. The output
  schemas now live in `schemas.js` with a test that holds them to the registry's
  rule, and each registration is attempted on its own, reporting to stderr
  instead of taking the plugin down.
- **Fixed: the mounted host disk was unreadable.** The image runs as `node`
  (uid 1000) and a host's interesting directories are 0700, so the file dialog
  answered `EACCES: opendir '/host/root'` on the very directory the projects
  live in. `deploy/host-access.sh on` now also runs the container as root
  (`DSH_CONTAINER_USER`), and `off` puts it back and returns ownership of the
  data directories to uid 1000 — anything written as root would be unreadable
  the moment the harness stops being root.

## v1.16.0 — 2026-09-22

Upstream base: `dsh-v0.1.5-rc.2`.

- **Host access** (`dsh-ext-host`, `deploy/host-access.sh`, `deploy/hostd/`).
  A containerised harness sees a slice of the world: its own workspace, no host
  docker, no host disk. This release lends that boundary out, behind a switch
  that ships off.
  - `find_projects` walks the mounted host disk and reports what looks like a
    project — a git repository, a compose file, a language manifest — stopping
    at the first marker on a branch and staying out of `node_modules` and
    friends. Both names of every directory come back: the host's and the one
    the harness reads it at.
  - `add_workspace` registers any of them as a workspace, so a session can be
    opened in it from the sidebar or from Telegram. A directory that is really
    the mounted workspace keeps its `/workspace/...` name instead of acquiring
    a second one — two names for one directory is how a session ends up split.
  - `host_bash` runs a command on the host as root through a unix-socket
    gateway (`deploy/hostd/dsh-hostd.mjs`, a systemd service). That is how
    containers get created, stacks restarted, services inspected. Every call is
    appended to `/var/log/dsh-hostd.log` before it runs.
  - The switch is `Settings → host → enabled`: with it off no tool is
    registered at all, so the schemas cost nothing and there is no path across
    the boundary. `deploy/host-access.sh on|off|status` does the plumbing —
    the `/host` mount and the gateway service.
  - `host_bash` asks for approval before each call unless the session runs
    under the full-access preset (`Settings → host → confirm`). The gate is a
    `tools/pre-execute` decision, so the harness owns the audit pair and the
    cancellation, and the question surfaces wherever the operator is —
    including as Telegram buttons. Under a policy of `never` the gate steps
    aside rather than asking: the approval service rejects every request in
    that mode, so asking would block exactly the mode chosen to be open.

## v1.15.0 — 2026-09-22

Upstream base: `dsh-v0.1.5-rc.2`.

- **The access mode is a button in Telegram** (`/mode`). A session runs under a
  permission preset — read-only, write inside the workspace, or full access
  with no prompts — and until now that switch existed only in the browser. The
  bot shows the three presets with the live one marked, and a tap switches the
  session it is written in. The approval half goes through the approval service
  rather than straight to the log, so the model is told its policy changed, the
  same way the web `/permission` command tells it. `/mode full`, `/mode чтение`
  and the raw preset names all work for typing.
- **Everything the harness stops to ask is now a button.** Approvals
  (`approval/request`) and structured questions (`user-questions/request`) are
  Cordis waterfalls: an answerer either claims the request or hands it on. The
  bridge does both — it puts the question in the session's thread AND passes
  the request along — then takes whichever answer arrives first, so a decision
  can be made on the phone or in the browser, and the screen that lost says
  where the answer came from. Single-select answers with one tap, multi-select
  collects ticks until Готово, and "✏️ Ответить текстом" takes the next message
  in that thread as the answer instead of as a new instruction to the agent.
  The fail-closed `unavailable` that the chain returns when nobody else is
  listening is explicitly NOT treated as an answer — otherwise the buttons
  would be dead the moment they appeared.
- **Fixed: the operator's own message echoed back under the answer.** A prompt
  written while the agent is still working is committed only when its turn
  starts, which on a long run is many minutes later; the echo fingerprint
  expired after one minute and let those late commits through. It now outlives
  the queue.

## v1.14.0 — 2026-09-22

Upstream base: `dsh-v0.1.5-rc.2`.

- **Tools on demand** (`dsh-ext-toolbelt`). Every tool's JSON schema rides in
  the head of every request: measured on this deployment, 43 tools cost 10 760
  tokens before a word of conversation, and 5 797 of those belong to tools used
  a few times a week. Seven groups — sequential thinking, library docs, the
  memory graph, workflows, schedule, goals, background jobs — now start hidden
  through the tool registry's restriction seam, which removes them from the
  schema list that is actually sent. One ~150-token tool, `enable_tools`, lets
  the agent unlock a group the moment a task needs it; the unlock lasts for
  that session and other sessions keep the lean surface.
  Net effect: the fixed part of every request drops from ~12.5k to ~6.7k
  tokens, and the first request of a session — the one that pays full price
  because nothing is cached yet — gets about twice as cheap.
  Restriction is applied per tool name, so a tool a preset owns rather than
  inherits simply stays visible instead of costing the whole group its saving.

## v1.13.0 — 2026-09-22

Upstream base: `dsh-v0.1.5-rc.2`.

- **Answers are rendered, not dumped.** The model writes Markdown and Telegram
  renders a small HTML subset, so `##`, `**` and `|` arrived as punctuation.
  Headings become bold lines, bullets become dots, fences become code blocks,
  and **tables become aligned monospace blocks** — the only shape a table
  survives in on a phone. An unclosed fence, which is the normal state halfway
  through a stream, is closed for the render instead of swallowing the rest.
- **The bot can look at pictures.** A photo (or an image sent as a file) goes
  into the session as an image alongside its caption, so a vision-capable route
  can read it. DeepSeek's `deepseek-flash` and `deepseek-v4-flash-vision-exp`
  accept images; a text-only route refuses the request and the refusal is
  reported rather than swallowed.

## v1.12.0 — 2026-09-22

Upstream base: `dsh-v0.1.5-rc.2`.

Talking to the bot no longer requires learning it.

- **Write a task, get work.** With nothing selected the bridge opens a session
  and sends the prompt straight in. Being told to run `/sessions`, read a
  numbered list and then type `/use 2` before the first word of work is a
  ritual, not an interface.
- **Buttons, not numbers.** `/sessions` answers with one button per session —
  project, subject, whether it is running, how long ago — plus "＋ Новая
  сессия". `/workspaces` answers with a button per project that opens a session
  in it. Tapping edits the same message instead of leaving dead menus behind.
- **A command menu.** The commands are published to Telegram, so the "/" button
  next to the input lists them.
- **Threads survive a restart.** Which thread belongs to which session is
  persisted in settings. Until now it lived only in memory, so after every
  deploy a reply inside a session's own thread was answered with "сессия не
  привязана" — the thread was orphaned while the session was still there.

## v1.11.0 — 2026-09-22

Upstream base: `dsh-v0.1.5-rc.2`.

The bridge wrote to Telegram like a log file. It now writes like a chat.

- **One message per turn, edited as the answer streams.** A turn opens a single
  message ("думаю…"), fills with the answer as the model writes it, shows what
  the agent is doing right now on its own line, and closes with duration and
  token cost. Redraws are rate-limited and coalesced in the outbox: a fast
  stream costs a couple of API calls per second, not one message per tool call.
- **No echo.** A prompt sent from Telegram is no longer mirrored back as the
  harness commits it; prompts typed in the web UI still appear, because those
  the phone has not seen.
- **The thread you write in is the thread it answers in.** Writing in a topic
  binds that session to that topic, so the bridge stops opening a second thread
  beside the one already in use.
- **Formatting.** Telegram HTML: the status line and the footer are italic, tool
  arguments are monospace, and everything the model wrote is escaped, so a
  stray tag cannot break the message.
- Tool calls no longer occupy a message each; they are the status line of the
  turn they belong to.

## v1.10.0 — 2026-09-21

Upstream base: `dsh-v0.1.5-rc.2`.

Workspaces, sessions and Telegram now describe the same structure.

- **A thread is a session, its colour is the project.** Topics are named
  `project · subject` and coloured from a stable hash of the workspace path, so
  threads of one repository look alike in the list. A thread that opens before
  the session has a subject is renamed the moment it earns one.
- **`/sessions` is grouped by project**, numbered continuously, marking what is
  running — the sidebar, in a message.
- **`/new` takes a project**: `/new 2` by number from `/workspaces`, `/new site`
  by name, `/new /abs/path` for anywhere else. An unknown name creates nothing
  and says so.
- `/start` now explains the model in three steps instead of printing a chat id.
- Without threads (a private chat whose owner has not turned Threaded Mode on in
  @BotFather) every line carries its session's name, so two sessions no longer
  interleave into an unreadable stream.

### Fixed

- A crash on boot: the control wiring named a function declared below it, and
  reading it during initialisation threw, which took the whole harness down —
  the site answered 502 until the container restarted into the same fault. The
  reference is lazy now. This is the second temporal-dead-zone fault in this
  file; both are commented where they happened.
- The claim that a private chat holds topics out of the box was wrong: Telegram
  refuses with "the chat is not a forum" until Threaded Mode is enabled for the
  bot. Documented where it matters.

## v1.9.0 — 2026-09-21

Upstream base: `dsh-v0.1.5-rc.2`.

- **The bot is a remote control now.** Plain text sent to it reaches a session,
  so the phone works like the sidebar:
  * `/sessions` lists the recent ones, numbered, marking which is running and
    where it lives;
  * `/use N` points this chat at one of them, after which ordinary messages go
    straight in;
  * inside a session's own thread nothing needs pointing at all — the bridge
    already knows whose thread it is, so replying there continues that session;
  * `/new [path]` starts a session (in that directory when given) and points
    the chat at it;
  * `/workspaces` lists the workspaces with their paths and session counts;
  * `/stop` interrupts the current turn.
  Answering is asynchronous, so a slow harness never stalls update consumption,
  and an unroutable message says why instead of vanishing.
- The message grammar moved out of the polling loop into its own module, which
  is what made all of it testable without a bot.

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

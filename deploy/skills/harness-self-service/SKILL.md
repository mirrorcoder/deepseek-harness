---
name: harness-self-service
description: Facts about THIS dsh deployment (container, paths, extensions, MCP, presets, how updates and self-modification work). Read before touching the harness itself or answering "how does this setup work".
---

# This deployment

You are DeepSeek Harness (`dsh`) running as container `dsh` behind Caddy at https://ds.jusl.me, from a fork of deepseek-ai/deepseek-harness.

| What | Where (inside the container) | On the host |
|---|---|---|
| Harness home `$DSH_HOME` (settings.yaml, .credentials.yaml, sessions, profiles, skills, presets) | `/data/dsh` | `/root/dsh-data/data/dsh` |
| Workspace root | `/workspace` | `/root/dsh-data/workspace` |
| Fork checkout (this harness's own source + deploy files) | `/workspace/deepseek-harness` | `/root/deepseek-harness` |
| Our extensions (source of truth) | `/opt/dsh/extensions/*` (baked into the image) | `/root/deepseek-harness/extensions/*` |
| Overlays applied at boot | `/opt/dsh/web-docker.patch.yml`, `/opt/dsh/features.patch.yml` | `deploy/` in the fork |
| Public read-only git mirror of the fork | — | https://ds.jusl.me/git/deepseek-harness.git |

## What is switched on
- Tools from presets: bash, fs read/edit/write/search, web_search + web_fetch (DeepSeek search), todo, plan mode, goals, subagent / subagent_fork / send_message / list_agents, workflow, ralph loop, jobs, skills, present (deliverables), ask_user_question.
- Host-plane extras: `generate_image` (dsh-ext-image-gen), peak-guard (dsh-ext-peak-guard, `/peak` command), schedule_create/list/cancel, MCP servers `memory` (persistent knowledge graph in `/data/dsh/mcp-memory.jsonl`), `context7` (library docs), `thinking` (sequential thinking). MCP tools are named `mcp__<server>__<tool>`.
- Agent preset `pro` (default for new sessions) = shipped `standard` + `dsh-ext-compaction-pro` as the compaction engine.
- Sandbox: workspace-write with approval prompts; Landlock enforced.

## Changing the harness
- Live-editable without restart: `/data/dsh/settings.yaml` (sections `peak-guard`, `agent-presets`, `permission`, model settings), `/data/dsh/profiles/web/cordis.patch.yml` (add MCP servers, toggle rows), `/data/dsh/skills/*/SKILL.md`, `/data/dsh/.agent-presets/*`.
- Code changes to extensions: edit under `/workspace/deepseek-harness/extensions/<pkg>/`, run its `test.mjs` with `node --test` from `/data/dsh/profiles/web/node_modules/<pkg>/` after reinstall, commit in the fork. Deploying needs the host: `deploy/update.sh` (rebuilds the image, reinstalls bundles, restarts). You cannot restart the container yourself; tell the user the exact command.
- Adding an MCP server for the user: append an `insert` row with `name: '@deepseek-ai/dsh-mcp-client'` to `/data/dsh/profiles/web/cordis.patch.yml` (see `/opt/dsh/features.patch.yml` for the shape). stdio servers must be installed in the image or reachable via `npx -y` (network + cache in /data/.npm).
- Secrets: never print `.credentials.yaml`, `DSH_IMAGE_GATEWAY_TOKEN`, or `.env` contents.

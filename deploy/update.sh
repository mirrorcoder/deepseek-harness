#!/bin/sh
# Server-side update: pull the fork, rebuild the image, reinstall our bundles
# into the profile, restart, run the extension tests, print the login link.
#   deploy/update.sh            # pull `main` from the remote this checkout tracks
#   deploy/update.sh --no-pull  # just rebuild + restart from the working tree
set -eu
cd "$(dirname "$0")"
if [ "${1:-}" != "--no-pull" ]; then
  git -C .. pull --ff-only
fi
# Before anything is built or restarted: every extension must ship what it
# imports. A module left out of package.json "files" is not a build error and
# not a test failure — the plugin that needs it just fails to mount after the
# restart. That took the Telegram bridge down once (v1.21.0).
. ./lib.sh
node_run ./check-extensions.mjs ../extensions
# Image tag and the baked stamp both follow our own VERSION file.
FORK_VERSION="$(tr -d ' \n\r' < ../VERSION)"
FORK_COMMIT="$(git -C .. rev-parse --short=10 HEAD 2>/dev/null || echo unknown)"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export FORK_VERSION FORK_COMMIT BUILD_DATE
./gen-build-info.sh
# Disk hygiene, before the build rather than after the failure: this box has
# hit 100% mid-deploy, and an ENOSPC during an image build leaves a half-built
# layer set and a container that cannot restart.
FREE_MB="$(df -Pm / | awk 'NR==2 {print $4}')"
if [ "$FREE_MB" -lt 4096 ]; then
  echo "→ меньше 4 ГБ свободно (${FREE_MB} МБ) — чищу кеш сборщика"
  docker builder prune -af >/dev/null 2>&1 || true
  docker image prune -f >/dev/null 2>&1 || true
  echo "   свободно теперь: $(df -Pm / | awk 'NR==2 {print $4}') МБ"
fi
docker compose build --pull dsh
docker compose up -d --remove-orphans
echo "→ waiting for dsh to come up…"
i=0; while [ $i -lt 60 ]; do
  if docker logs dsh 2>&1 | grep -q 'token='; then break; fi
  i=$((i+1)); sleep 2
done
# Bundles (extensions) live in the profile volume; re-copy them from the new
# image and materialise the `pro` preset. Bundle membership is read at boot.
docker exec dsh /opt/dsh/install-extensions.sh
# Skills: seed any that the user has not created yet (never overwrite edits).
for d in skills/*/; do
  n="$(basename "$d")"
  docker exec dsh sh -c "[ -e /data/dsh/skills/$n/SKILL.md ]" 2>/dev/null \
    || docker cp "$d" "dsh:/data/dsh/skills/$n"
done
# A clean exit lets the restart policy boot the process with the new bundles;
# bundle membership is only read at boot.
STARTED_BEFORE="$(docker inspect -f '{{.State.StartedAt}}' dsh 2>/dev/null || echo none)"
docker exec dsh kill -TERM 1 || true
echo "→ waiting for dsh after restart…"
# Health, not log text: the pre-restart token line is still inside the log
# window right after a restart, so grepping for it returned true while the
# container was still down — and the next `docker exec` died, taking the whole
# script with it under `set -e` (no tests, and no cleanup either).
# Two conditions, because either alone lies: docker keeps reporting the LAST
# health status until the next check, so a container that is still restarting
# can read "healthy"; and a container that is merely running may not have
# finished booting. Wait for exec to work, then for health to be re-earned.
# The restart itself first: right after the TERM the container is still up
# (the process is merely exiting), so an exec probe succeeds and the stale
# health status still reads "healthy" — both lie for a second or two. The start
# timestamp does not.
i=0; while [ $i -lt 60 ]; do
  now="$(docker inspect -f '{{.State.StartedAt}}' dsh 2>/dev/null || echo none)"
  [ "$now" != "$STARTED_BEFORE" ] && [ "$now" != none ] && break
  i=$((i+1)); sleep 2
done
i=0; while [ $i -lt 60 ]; do
  docker exec dsh true >/dev/null 2>&1 && break
  i=$((i+1)); sleep 2
done
i=0; while [ $i -lt 90 ]; do
  [ "$(docker inspect -f '{{.State.Health.Status}}' dsh 2>/dev/null || echo none)" = healthy ] && break
  i=$((i+1)); sleep 2
done
echo "→ extension tests"
docker exec dsh sh -c 'cd /data/dsh/profiles/web/node_modules && for p in dsh-ext-version dsh-ext-peak-guard dsh-ext-image-gen dsh-ext-compaction-pro dsh-ext-workspace-picker dsh-ext-remote-console dsh-ext-efficiency dsh-ext-about dsh-ext-telegram dsh-ext-toolbelt dsh-ext-host dsh-ext-memory dsh-ext-prune-pro dsh-ext-ledger dsh-ext-web-shot dsh-ext-lsp dsh-ext-voice; do printf "   %-26s " "$p"; for t in "$p"/test*.mjs; do node --test "$t"; done 2>&1 | grep -E "^# (pass|fail)" | tr "\n" " "; echo; done' || echo "   !! тесты прогнать не удалось (контейнер перезапускается?)"
echo "→ running build: $(docker exec dsh sh -c 'cat /opt/dsh/build-info.json' | tr -d "\n ")"

# Every build leaves behind the cache that produced it and the tag it replaced.
# Cleaning here is what keeps the box from filling up one deploy at a time.
echo "→ уборка"
docker builder prune -af >/dev/null 2>&1 || true
for old_tag in $(docker images --format '{{.Repository}}:{{.Tag}}' deepseek-harness 2>/dev/null | grep -v ":${FORK_VERSION}$"); do
  if docker image rm "$old_tag" >/dev/null 2>&1; then echo "   ✓ снят старый образ $old_tag"; fi
done
docker image prune -f >/dev/null 2>&1 || true
df -Ph / | awk 'NR==2 {print "   диск: занято " $5 ", свободно " $4}'

./login-link.sh

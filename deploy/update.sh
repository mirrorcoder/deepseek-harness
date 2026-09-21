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
docker compose restart dsh
echo "→ waiting for dsh after restart…"
i=0; while [ $i -lt 60 ]; do
  if docker logs --since 60s dsh 2>&1 | grep -q 'token='; then break; fi
  i=$((i+1)); sleep 2
done
echo "→ extension tests"
docker exec dsh sh -c 'cd /data/dsh/profiles/web/node_modules && for p in dsh-ext-peak-guard dsh-ext-image-gen dsh-ext-compaction-pro; do printf "   %-26s " "$p"; node --test "$p/test.mjs" 2>&1 | grep -E "^# (pass|fail)" | tr "\n" " "; echo; done'
./login-link.sh

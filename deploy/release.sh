#!/bin/sh
# Cut a release of THIS fork: bump VERSION, stamp build-info, commit, tag,
# publish to GitHub + the local mirror, then rebuild and redeploy.
#
#   deploy/release.sh patch|minor|major      bump and release
#   deploy/release.sh 1.4.0                  release an explicit version
#   deploy/release.sh --redeploy             no bump: rebuild + deploy current VERSION
#
# Write the CHANGELOG entry BEFORE running this; the script refuses to tag a
# version that has no section in CHANGELOG.md.
set -eu
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

current="$(tr -d ' \n\r' < VERSION)"
mode="${1:-}"
[ -n "$mode" ] || { echo "usage: deploy/release.sh patch|minor|major|<x.y.z>|--redeploy" >&2; exit 2; }

if [ "$mode" = "--redeploy" ]; then
  next="$current"
else
  case "$mode" in
    major|minor|patch)
      next="$(MODE="$mode" CUR="$current" node -e '
        const [a,b,c] = process.env.CUR.split(".").map(Number)
        const m = process.env.MODE
        console.log(m === "major" ? `${a+1}.0.0` : m === "minor" ? `${a}.${b+1}.0` : `${a}.${b}.${c+1}`)
      ')" ;;
    [0-9]*.[0-9]*.[0-9]*) next="$mode" ;;
    *) echo "!! not a bump keyword or x.y.z version: $mode" >&2; exit 2 ;;
  esac
  [ -z "$(git status --porcelain -- VERSION CHANGELOG.md deploy extensions)" ] \
    || echo "→ releasing with working-tree changes under deploy/ extensions/ (they will be committed)"
  grep -q "^## v$next\b" CHANGELOG.md \
    || { echo "!! CHANGELOG.md has no '## v$next' section — write it first" >&2; exit 1; }
  git rev-parse -q --verify "refs/tags/v$next" >/dev/null \
    && { echo "!! tag v$next already exists" >&2; exit 1; }
  printf '%s\n' "$next" > VERSION
  ./deploy/gen-build-info.sh >/dev/null
  git add VERSION CHANGELOG.md deploy/build-info.json deploy extensions
  git commit -q -m "release: v$next"
  git tag -a "v$next" -m "v$next"
  echo "→ committed and tagged v$next"
fi

echo "→ publishing"
./deploy/publish.sh

echo "→ building image deepseek-harness:$next"
FORK_VERSION="$next"
FORK_COMMIT="$(git rev-parse --short=10 HEAD)"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export FORK_VERSION FORK_COMMIT BUILD_DATE
cd "$ROOT/deploy"
docker compose build dsh
docker compose up -d --remove-orphans
i=0; while [ $i -lt 60 ]; do docker logs --since 120s dsh 2>&1 | grep -q 'token=' && break; i=$((i+1)); sleep 2; done
docker exec dsh /opt/dsh/install-extensions.sh
for d in skills/*/; do
  n="$(basename "$d")"
  docker exec dsh sh -c "[ -e /data/dsh/skills/$n/SKILL.md ]" 2>/dev/null || docker cp "$d" "dsh:/data/dsh/skills/$n"
done
# a clean exit lets the restart policy boot the process with the new bundles
docker exec dsh kill -TERM 1 || true
i=0; while [ $i -lt 60 ]; do docker logs --since 120s dsh 2>&1 | grep -q 'token=' && break; i=$((i+1)); sleep 2; done

echo "→ extension tests"
docker exec dsh sh -c 'cd /data/dsh/profiles/web/node_modules && for p in dsh-ext-version dsh-ext-peak-guard dsh-ext-image-gen dsh-ext-compaction-pro dsh-ext-workspace-picker dsh-ext-remote-console dsh-ext-efficiency dsh-ext-about dsh-ext-telegram; do printf "   %-24s " "$p"; node --test "$p/test.mjs" 2>&1 | grep -E "^# (pass|fail)" | tr "\n" " "; echo; done'
echo "→ running build:"
docker exec dsh cat /opt/dsh/build-info.json
# Each release leaves ~1 GB behind on a box that runs several other stacks.
echo "→ reclaiming build cache and superseded images"
docker builder prune -af >/dev/null 2>&1 || true
docker image ls deepseek-harness --format '{{.Tag}}' | grep -v "^${next}$" | xargs -r -n1 docker image rm >/dev/null 2>&1 || true
df -h / | tail -1
./login-link.sh

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

echo "→ building and deploying v$next"
# The deploy itself is update.sh's, from the commit just tagged: one path, with
# its disk guard, its restart checks and the full test list. This file used to
# carry its own copy, and the copy drifted — no disk guard, a restart wait that
# trusted stale log lines, and seven extensions missing from its test list.
exec ./deploy/update.sh --no-pull

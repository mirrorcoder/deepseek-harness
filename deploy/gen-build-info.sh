#!/bin/sh
# Write deploy/build-info.json from the repository's current state. Committed
# with each release so any clone builds an image that knows what it is.
#
# Deliberately NOT recorded here: the commit sha and the build timestamp. A
# file that is part of the commit cannot name that commit (amending changes the
# sha), so those two travel as build args and land in the image environment;
# dsh-ext-version merges them over this file.
set -eu
cd "$(dirname "$0")/.."
VERSION="$(tr -d ' \n\r' < VERSION)"
UPSTREAM="$(git describe --tags --match 'dsh-v*' --abbrev=0 2>/dev/null || echo unknown)"
DSH_NPM="$(sed -n 's/^DSH_VERSION=\([^ #]*\).*/\1/p' deploy/.env.example | head -1)"
RELEASED="$(date -u +%Y-%m-%d)"

# Plain sed rather than node: a fresh server that only has Docker must still be
# able to stamp a build. Our manifests put the top-level name and version on
# their own lines, and they come first, so the first match is the right one.
exts=""
for d in extensions/*/; do
  f="${d}package.json"
  [ -f "$f" ] || continue
  n="$(sed -n 's/^[[:space:]]*"name":[[:space:]]*"\([^"]*\)".*/\1/p' "$f" | head -1)"
  v="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$f" | head -1)"
  exts="$exts$(printf '\n    "%s": "%s",' "$n" "$v")"
done
exts="${exts%,}"

cat > deploy/build-info.json <<EOF
{
  "forkVersion": "$VERSION",
  "upstreamBase": "$UPSTREAM",
  "upstreamNpm": "$DSH_NPM",
  "releasedAt": "$RELEASED",
  "repository": "https://github.com/mirrorcoder/deepseek-harness",
  "mirror": "https://ds.jusl.me/git/deepseek-harness.git",
  "extensions": {$exts
  }
}
EOF
echo "deploy/build-info.json → v$VERSION (base $UPSTREAM, released $RELEASED)"

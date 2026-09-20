#!/bin/sh
# Bring upstream changes into the fork.
#   deploy/sync-upstream.sh              # merge upstream/master into main
#   deploy/sync-upstream.sh dsh-v0.1.6   # merge a specific upstream release tag
# After merging, bump DSH_VERSION in deploy/.env(.example) to the matching npm
# version (or switch to Dockerfile.source if main carries local changes).
set -eu
cd "$(dirname "$0")/.."
git fetch upstream --tags
git merge --no-edit "${1:-upstream/master}"
echo "merged ${1:-upstream/master}; now: deploy/update.sh --no-pull && deploy/publish.sh"

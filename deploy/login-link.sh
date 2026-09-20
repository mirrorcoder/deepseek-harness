#!/bin/sh
# Print the one-time browser login URL for the running `dsh` container.
# dsh mints a fresh launch token per process start; opening the URL once sets
# a signed 30-day cookie, after which the plain https://<host>/ works.
# Usage: deploy/login-link.sh [public-host]   (default: first of DSH_TRUSTED_HOSTS)
set -eu
cd "$(dirname "$0")"
host="${1:-$(grep -E '^DSH_TRUSTED_HOSTS=' .env | cut -d= -f2 | awk '{print $1}')}"
token="$(docker logs dsh 2>&1 | grep -oE 'token=[A-Za-z0-9._~-]+' | tail -1 | cut -d= -f2)"
[ -n "$token" ] || { echo "no launch token in \`docker logs dsh\` yet — is the container up?" >&2; exit 1; }
echo "https://${host}/?token=${token}"

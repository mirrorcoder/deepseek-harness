#!/bin/sh
# Server-side update: pull the fork, rebuild the image, restart, print login link.
#   deploy/update.sh            # pull `main` from the remote this checkout tracks
#   deploy/update.sh --no-pull  # just rebuild + restart from the working tree
set -eu
cd "$(dirname "$0")"
if [ "${1:-}" != "--no-pull" ]; then
  git -C .. pull --ff-only
fi
docker compose build --pull dsh
docker compose up -d --remove-orphans
echo "waiting for dsh to print its login URL…"
i=0; while [ $i -lt 60 ]; do
  if docker logs dsh 2>&1 | grep -q 'token='; then break; fi
  i=$((i+1)); sleep 2
done
./login-link.sh

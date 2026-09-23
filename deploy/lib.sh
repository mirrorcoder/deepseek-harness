# Shared helpers for the deploy scripts. Sourced from deploy/, not executed.

# Run a node script with the host's node when there is one, and otherwise in
# the same image the build is based on: a fresh server needs nothing but Docker.
node_run() {
  if command -v node >/dev/null 2>&1; then
    node "$@"
  else
    _repo="$(cd .. && pwd)"
    docker run --rm -v "$_repo:$_repo" -w "$(pwd)" node:22-bookworm-slim node "$@"
  fi
}

# Free megabytes on the disk that holds Docker's data.
docker_free_mb() {
  df -Pm "$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /)" | awk 'NR==2 {print $4}'
}

# Run a command — an image build — while watching free disk space, and stop it
# when free space falls below the floor. Returns the command's own status, or
# 75 when it was stopped for disk.
#
# A cold build of this image takes ~3.5 GB at its peak, most of it in the last
# step, when the finished image is unpacked next to its compressed layers. On
# 2026-09-23 that step filled a shared box to 0 bytes: the production Redis
# next to the harness could not save, refused writes for 42 seconds, and its
# worker crash-looped. The harness's own container is never at risk here — it
# keeps running from the old image until the build succeeds — its neighbours
# are. So the build is the thing that gets stopped.
#
# The command runs in its own process group (setsid), so stopping it reaches
# docker, the compose plugin and buildx alike, not just the first process.
# `kill -TERM -PGID`, never `kill -- -PGID`: dash's kill rejects `--`, and then
# only the single-process fallback ran — the rest of the build kept going.
disk_guarded() {
  _floor="$1"; shift
  _flag="$(mktemp)"
  if command -v setsid >/dev/null 2>&1; then setsid "$@" & else "$@" & fi
  _job=$!
  # Ctrl-C reaches this script, not the build's own session: pass it on.
  trap 'kill -TERM -"$_job" 2>/dev/null || kill -TERM "$_job" 2>/dev/null' INT TERM
  (
    while kill -0 "$_job" 2>/dev/null; do
      if [ "$(docker_free_mb)" -lt "$_floor" ]; then
        echo stopped > "$_flag"
        kill -TERM -"$_job" 2>/dev/null || kill -TERM "$_job" 2>/dev/null
        exit 0
      fi
      sleep 1
    done
  ) &
  _watch=$!
  _code=0
  wait "$_job" || _code=$?
  kill "$_watch" 2>/dev/null || true
  wait "$_watch" 2>/dev/null || true
  trap - INT TERM
  [ -s "$_flag" ] && _code=75
  rm -f "$_flag"
  return "$_code"
}

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

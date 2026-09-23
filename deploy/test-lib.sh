#!/bin/sh
# Tests for the deploy helpers that protect the box. No Docker needed: the
# free-space probe is replaced with a fake that reads a file.
#   sh deploy/test-lib.sh
set -eu
cd "$(dirname "$0")"
. ./lib.sh

fails=0
check() { # check <what> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: expected $2, got $3"; fails=$((fails + 1)); fi
}

FREE_FILE="$(mktemp)"
echo 100000 > "$FREE_FILE"
docker_free_mb() { cat "$FREE_FILE"; }

# Stand-ins for docker, the compose plugin and buildx: a command that starts a
# second process and keeps both running. Anchored patterns count the sleeps
# only, not the shells whose command lines mention them.
a="31.$$"
b="32.$$"
survivors() { pgrep -fc "^sleep ($a|$b)" || true; }
cleanup() { pkill -f "^sleep ($a|$b)" 2>/dev/null || true; }
wait_started() { # until both stand-ins run, at most ~3 s
  i=0; while [ "$(survivors)" -lt 2 ] && [ $i -lt 30 ]; do sleep 0.1; i=$((i + 1)); done
}

code=0; disk_guarded 1024 sh -c 'sleep 1; exit 0' || code=$?
check "a build with room finishes normally" 0 "$code"

code=0; disk_guarded 1024 sh -c 'exit 3' || code=$?
check "a failing build keeps its own status" 3 "$code"

# The disk runs low while the build runs. The "build" itself reports the low
# disk, and only once both of its processes are up — so the test cannot pass
# by stopping it before it started anything.
started="$(date +%s)"
code=0; disk_guarded 1024 sh -c "sleep $a & sleep 0.3; echo 100 > '$FREE_FILE'; sleep $b" || code=$?
elapsed=$(( $(date +%s) - started ))
check "a build that runs the disk low is stopped (status 75)" 75 "$code"
[ "$elapsed" -le 5 ] && quick=yes || quick="no, ${elapsed}s"
check "... within seconds" yes "$quick"
sleep 0.5
check "... and nothing it started survives" 0 "$(survivors)"
cleanup

# Ctrl-C (or a TERM) to the deploy script while it builds: the build runs in
# its own session and would not get the terminal's signal, so the script must
# pass it on — to all of it.
echo 100000 > "$FREE_FILE"
sh -c ". ./lib.sh; docker_free_mb() { echo 100000; }; disk_guarded 10 sh -c 'sleep $a & sleep $b'" &
script=$!
wait_started
check "(both stand-ins were running)" 2 "$(survivors)"
kill -TERM "$script"
wait "$script" 2>/dev/null || true
sleep 0.5
check "stopping the script stops the whole build" 0 "$(survivors)"
cleanup

rm -f "$FREE_FILE"
[ "$fails" -eq 0 ] && echo "# pass" || { echo "# fail $fails"; exit 1; }

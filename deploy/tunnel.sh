#!/bin/sh
# Print the SSH tunnel that turns this deployment into a full operator console.
#
# The Settings pages (Models, plugin settings, "open configuration file")
# persist to the harness home only when the page authority is loopback — the
# client's stand-in for "this is the operator's own machine". Through the
# public domain they fall back to the browser tab and report "settings are
# unavailable in this browser". Forwarding the container's loopback port makes
# the page loopback for real, with no change to the deployment.
set -eu
cd "$(dirname "$0")"
port="$(docker port dsh 3080 2>/dev/null | head -1 | sed 's/.*://')"
port="${port:-3080}"
host="$(hostname -I 2>/dev/null | awk '{print $1}')"
url="$(docker logs dsh 2>&1 | grep -oE 'http://127\.0\.0\.1:[0-9]+/\?token=[A-Za-z0-9._~-]+' | tail -1)"

cat <<EOF
Run this on your own machine:

    ssh -N -L ${port}:127.0.0.1:${port} root@${host:-<server>}

then open, in the same browser session:

    ${url:-http://127.0.0.1:${port}/  (no token in the log yet — restart dsh)}

That page is loopback, so Settings → Models can store the API key in
\$DSH_HOME/.credentials.yaml. The key lives on the server, so once it is saved
the public URL works normally — the tunnel is only needed to change settings.
EOF

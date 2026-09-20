#!/bin/sh
# Boot the Web profile for a reverse-proxied container deployment.
#   DSH_TRUSTED_HOSTS  space-separated host[:port] authorities the browser will
#                      use in the Host header (e.g. "ds.jusl.me"); required,
#                      otherwise /api answers 403 behind a proxy.
#   DSH_EXTRA_ARGS     optional extra app arguments.
set -eu
: "${DSH_TRUSTED_HOSTS:?set DSH_TRUSTED_HOSTS to the public hostname(s), e.g. ds.jusl.me}"
mkdir -p "${DSH_HOME:-/data/dsh}"
set -- --profile web --patch /opt/dsh/web-docker.patch.yml --no-open ${DSH_EXTRA_ARGS:-}
for h in $DSH_TRUSTED_HOSTS; do set -- "$@" --trusted-host "$h"; done
exec dsh "$@"

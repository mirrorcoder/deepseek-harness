# deploy/standalone

`Caddyfile` in this directory is written by `deploy/bootstrap.sh --domain …`
and mounted into the bundled Caddy (compose profile `proxy`). It carries the
password hash, so it is git-ignored — to change the domain, the email or the
password, run `bootstrap.sh` again rather than editing it by hand.

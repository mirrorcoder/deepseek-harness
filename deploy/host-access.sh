#!/bin/sh
# Host access: the one switch.
#
#   deploy/host-access.sh status   what is on right now
#   deploy/host-access.sh on       mount the host disk at /host, install and start
#                                  the command gateway, recreate the container
#   deploy/host-access.sh off      the reverse: gateway stopped, mount emptied
#
# What "on" actually grants, so nobody is surprised later:
#   • every file on this machine is readable and writable by the harness at /host
#   • `host_bash` runs any command on this machine as root, through the gateway
# The harness still asks before each host command unless the session runs under
# the full-access preset (Settings → host → confirm).
#
# The `enabled` toggle in Settings → host is separate and lives in the harness:
# this script prepares the plumbing, that switch decides whether the tools exist.
set -eu
cd "$(dirname "$0")"

ENV_FILE=./.env
DATA_DIR="$(sh -c '. ./.env 2>/dev/null; echo "${DSH_DATA_DIR:-/root/dsh-data}"')"
SOCKET_DIR="${DATA_DIR}/run-host"
EMPTY_DIR="${DATA_DIR}/no-host"
UNIT=/etc/systemd/system/dsh-hostd.service
LIB=/usr/local/lib/dsh-hostd

say() { printf '%s\n' "$*"; }

set_env() {
  key="$1"; value="$2"
  touch "$ENV_FILE"
  if grep -q "^${key}=" "$ENV_FILE"; then
    # In place, not by replacing the file: .env is bind-mounted nowhere, but
    # the same habit that saved the Caddyfile costs nothing here.
    tmp="$(mktemp)"
    sed "s|^${key}=.*|${key}=${value}|" "$ENV_FILE" > "$tmp"
    cat "$tmp" > "$ENV_FILE"
    rm -f "$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

status() {
  root="$(sh -c '. ./.env 2>/dev/null; echo "${DSH_HOST_ROOT:-'"$EMPTY_DIR"'}"')"
  say "монтирование хоста в /host : ${root}$([ "$root" = / ] && echo '  (включено)' || echo '  (выключено)')"
  if systemctl is-active --quiet dsh-hostd 2>/dev/null; then
    say "шлюз команд dsh-hostd      : работает ($(systemctl show -p MainPID --value dsh-hostd))"
  else
    say "шлюз команд dsh-hostd      : не запущен"
  fi
  [ -S "${SOCKET_DIR}/hostd.sock" ] && say "сокет                      : ${SOCKET_DIR}/hostd.sock" \
    || say "сокет                      : нет"
  say ""
  say "Тумблер в харнессе: Settings → host → enabled (сейчас: $(grep -A2 '^host:' "${DATA_DIR}/data/dsh/settings.yaml" 2>/dev/null | grep -m1 enabled || echo 'не задан'))"
}

case "${1:-status}" in
  on)
    mkdir -p "$SOCKET_DIR" "$EMPTY_DIR"
    # The container's `node` user is uid 1000 and has to TRAVERSE this directory
    # to reach the socket inside it; a root-owned 0750 directory would leave the
    # gateway unreachable with a permission error that looks like a bug in the
    # harness. Root still writes here regardless of the owner.
    chown 1000:1000 "$SOCKET_DIR"
    chmod 750 "$SOCKET_DIR"
    say "→ ставлю шлюз команд на хост"
    mkdir -p "$LIB"
    cp hostd/dsh-hostd.mjs "$LIB/dsh-hostd.mjs"
    chmod 0755 "$LIB/dsh-hostd.mjs"
    sed "s|DSH_HOSTD_SOCKET=.*|DSH_HOSTD_SOCKET=${SOCKET_DIR}/hostd.sock|" hostd/dsh-hostd.service > "$UNIT"
    systemctl daemon-reload
    systemctl enable --now dsh-hostd
    say "→ монтирую диск хоста в /host"
    set_env DSH_HOST_ROOT /
    docker compose up -d dsh
    say "→ готово. Осталось включить тумблер: Settings → host → enabled"
    status
    ;;
  off)
    say "→ выключаю шлюз"
    systemctl disable --now dsh-hostd 2>/dev/null || true
    rm -f "$UNIT"
    systemctl daemon-reload 2>/dev/null || true
    mkdir -p "$EMPTY_DIR"
    set_env DSH_HOST_ROOT "$EMPTY_DIR"
    docker compose up -d dsh
    say "→ хост снова за границей контейнера"
    status
    ;;
  status) status ;;
  *)
    say "использование: $0 [on|off|status]"
    exit 2
    ;;
esac

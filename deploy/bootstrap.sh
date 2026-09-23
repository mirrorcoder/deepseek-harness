#!/bin/sh
# From a fresh clone to a running harness, on any Linux box with Docker.
#
#   deploy/bootstrap.sh                                 # local: 127.0.0.1:3080, reached over SSH
#   deploy/bootstrap.sh --domain dsh.example.com        # public: TLS and a password gate (Caddy)
#
# Options:
#   --domain NAME   public hostname whose A/AAAA record points at this box; turns
#                   on the bundled Caddy (ports 80 and 443 must be free)
#   --email ADDR    contact for the Let's Encrypt account (optional)
#   --data DIR      where the harness keeps its data (default /root/dsh-data)
#   --tz ZONE       IANA time zone for reports and schedules (default: the host's)
#
# Safe to run again: existing .env values, the existing password and all data
# are kept; only what is missing or passed explicitly is written.
#
# What this does NOT do is hand the harness this machine. Host access — the
# host's disk mounted into the container and a gateway that runs commands on
# the host — is a separate, deliberate step, and stays off until you take it:
#   deploy/host-access.sh on
set -eu
cd "$(dirname "$0")"

DOMAIN=""
EMAIL=""
DATA=""
ZONE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:?--domain needs a value}"; shift 2 ;;
    --email) EMAIL="${2:?--email needs a value}"; shift 2 ;;
    --data) DATA="${2:?--data needs a value}"; shift 2 ;;
    --tz) ZONE="${2:?--tz needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "!! unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf '!! %s\n' "$*" >&2; exit 1; }

# ── preflight ──────────────────────────────────────────────────────────────
[ "$(id -u)" = 0 ] || die "run as root: the data directories are handed to the container's user"
command -v docker >/dev/null 2>&1 || die "Docker is not installed (https://docs.docker.com/engine/install/)"
docker compose version >/dev/null 2>&1 || die "the Docker Compose plugin is missing (docker compose v2)"
[ -f Dockerfile ] && [ -f docker-compose.yml ] || die "run this from a clone of the repository (deploy/ not found)"
free_mb="$(df -Pm / | awk 'NR==2 {print $4}')"
[ "$free_mb" -ge 6000 ] || say "   ⚠ only ${free_mb} MB free: the image and its build need about 6 GB"
if [ -n "$DOMAIN" ]; then
  for port in 80 443; do
    if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${port}\$"; then
      die "port ${port} is already taken — with a reverse proxy of your own, drop --domain and point that proxy at 127.0.0.1:3080"
    fi
  done
fi

# ── .env ───────────────────────────────────────────────────────────────────
[ -f .env ] || { cp .env.example .env; say "→ .env created from .env.example"; }
chmod 600 .env

get_env() { sed -n "s/^$1=\([^#]*\).*/\1/p" .env | tail -1 | sed 's/[[:space:]]*$//'; }
set_env() { # set_env KEY VALUE — replace in place, keeping the file's inode
  tmp="$(mktemp)"
  if grep -q "^$1=" .env; then
    awk -v k="$1" -v v="$2" 'BEGIN { FS = OFS = "=" } $1 == k { print k "=" v; next } { print }' .env > "$tmp"
  else
    cat .env > "$tmp"; printf '%s=%s\n' "$1" "$2" >> "$tmp"
  fi
  cat "$tmp" > .env; rm -f "$tmp"
}
# A value passed on the command line wins; otherwise an existing one is kept;
# otherwise the default is written.
put() { # put KEY PASSED DEFAULT
  if [ -n "$2" ]; then set_env "$1" "$2"
  elif [ -z "$(get_env "$1")" ]; then set_env "$1" "$3"
  fi
}

host_zone="$(cat /etc/timezone 2>/dev/null || timedatectl show -p Timezone --value 2>/dev/null || echo UTC)"
put DSH_DATA_DIR "$DATA" /root/dsh-data
put TZ "$ZONE" "$host_zone"
if [ -n "$DOMAIN" ]; then
  set_env DSH_TRUSTED_HOSTS "$DOMAIN"
  set_env COMPOSE_PROFILES proxy
else
  put DSH_TRUSTED_HOSTS "" "127.0.0.1 localhost"
fi
DATA="$(get_env DSH_DATA_DIR)"
DOMAIN_NOW="$(get_env DSH_TRUSTED_HOSTS | awk '{print $1}')"
PROFILES="$(get_env COMPOSE_PROFILES)"

# ── data ───────────────────────────────────────────────────────────────────
mkdir -p "$DATA/data" "$DATA/workspace" "$DATA/run" "$DATA/run-host" "$DATA/no-host" \
         "$DATA/caddy/data" "$DATA/caddy/config"
# The container runs as `node`, uid 1000.
chown 1000:1000 "$DATA/data" "$DATA/workspace"

# ── the public door: TLS and a password in front of the harness ─────────────
case ",$PROFILES," in *,proxy,*)
  mkdir -p standalone
  access="$DATA/ACCESS.txt"
  password="$(sed -n 's/^Password:[[:space:]]*//p' "$access" 2>/dev/null | head -1)"
  if [ -z "$password" ]; then
    password="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)"
  fi
  # Read from stdin, twice (the confirmation), so the password never appears in
  # a process list.
  hash="$(printf '%s\n%s\n' "$password" "$password" | docker run --rm -i caddy:2-alpine caddy hash-password 2>/dev/null | tail -1)"
  case "$hash" in '$2'*) ;; *) die "could not hash the password with caddy" ;; esac
  {
    say "# Written by deploy/bootstrap.sh — run it again rather than editing this file."
    if [ -n "$EMAIL" ]; then printf '{\n\temail %s\n}\n\n' "$EMAIL"; fi
    printf '%s {\n' "$DOMAIN_NOW"
    printf '\tencode zstd gzip\n'
    printf '\tbasic_auth {\n\t\tdsh %s\n\t}\n' "$hash"
    printf '\treverse_proxy dsh:3080 {\n'
    printf '\t\t# the harness takes no Authorization-header auth; do not pass basic creds on\n'
    printf '\t\theader_up -Authorization\n\t}\n}\n'
  } > standalone/Caddyfile
  # umask only for this one file: update.sh inherits the shell's umask, and a
  # 077 there would make build-info.json unreadable to the container's user.
  (umask 077; printf 'URL:      https://%s/\nLogin:    dsh\nPassword: %s\n' "$DOMAIN_NOW" "$password" > "$access")
  chmod 600 "$access"
  say "→ Caddy will serve https://${DOMAIN_NOW}/ behind a password (saved in ${access})"
  ;;
esac

# ── build, start, install the extensions, test ─────────────────────────────
say "→ building and starting (the first build takes several minutes)"
./update.sh --no-pull

# ── what next ──────────────────────────────────────────────────────────────
say ""
say "Готово."
case "$DOMAIN_NOW" in
  127.0.0.1|localhost)
    say "  • Открыть: из своей машины проложите туннель, затем откройте ссылку выше:"
    say "      ssh -N -L 3080:127.0.0.1:3080 root@<этот-сервер>"
    ;;
  *)
    say "  • Открыть: ссылка выше; логин и пароль в ${DATA}/ACCESS.txt"
    ;;
esac
say "  • Ключ DeepSeek: Settings → Models, или  printf '%s' 'sk-…' | deploy/model.sh key"
say "  • Telegram: кнопка ✈ справа внизу — токен бота и чат"
say ""
say "  Доступ к этой машине по умолчанию выключен. Если он нужен агенту"
say "  (диск хоста и команды на хосте от root), включается отдельно и осознанно:"
say "      deploy/host-access.sh on"

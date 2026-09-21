#!/bin/sh
# Configure the model without the Settings UI.
#
# The Settings pages persist to the harness home only when the page is the
# operator's own (a loopback authority). Behind a reverse proxy they fall back
# to the browser tab, so Settings → Models reports "settings are unavailable in
# this browser" and cannot store a key. These two commands do the same job from
# the host:
#
#   deploy/model.sh key            read a key from stdin into deploy/.env,
#                                  then rebuild + restart so it reaches the
#                                  container's launch environment
#   deploy/model.sh default        set the default provider/model for new
#                                  sessions in $DSH_HOME/settings.yaml (live,
#                                  no restart)
#   deploy/model.sh show           what is configured now (never prints a key)
#
# Examples:
#   printf '%s' 'sk-…' | deploy/model.sh key            # DEEPSEEK_API_KEY
#   printf '%s' 'sk-…' | deploy/model.sh key ANTHROPIC_API_KEY
#   deploy/model.sh default deepseek-official deepseek-v4-pro
set -eu
cd "$(dirname "$0")"
DATA_DIR="$(sed -n 's/^DSH_DATA_DIR=\([^ #]*\).*/\1/p' .env | head -1)"
SETTINGS="${DATA_DIR:-/root/dsh-data}/data/dsh/settings.yaml"

case "${1:-show}" in
key)
  var="${2:-DEEPSEEK_API_KEY}"
  case "$var" in
    *[!A-Z_]*) echo "!! credential name must be upper-case with underscores: $var" >&2; exit 2 ;;
  esac
  [ -t 0 ] && { echo "!! pipe the key in, so it never reaches the shell history:" >&2; echo "   printf '%s' 'sk-…' | deploy/model.sh key $var" >&2; exit 2; }
  key="$(cat)"
  key="$(printf '%s' "$key" | tr -d ' \n\r')"
  [ -n "$key" ] || { echo "!! empty key on stdin" >&2; exit 2; }
  umask 077
  tmp="$(mktemp)"
  grep -v "^${var}=" .env > "$tmp" || true
  printf '%s=%s\n' "$var" "$key" >> "$tmp"
  mv "$tmp" .env
  chmod 600 .env
  echo "→ $var stored in deploy/.env (git-ignored, 0600)"
  echo "→ applying: rebuild + restart"
  ./update.sh --no-pull
  ;;
default)
  provider="${2:-deepseek-official}"
  model="${3:-deepseek-v4-flash}"
  [ -f "$SETTINGS" ] || : > "$SETTINGS"
  docker exec -i dsh node -e '
    const fs = require("node:fs")
    const yaml = require("/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/js-yaml")
    const [file, provider, model] = process.argv.slice(1)
    const doc = yaml.load(fs.readFileSync(file, "utf8")) ?? {}
    doc["agent-default-model"] = { ...(doc["agent-default-model"] ?? {}), provider, model }
    fs.writeFileSync(file, yaml.dump(doc))
    console.log("→ default model:", provider + "/" + model)
  ' /data/dsh/settings.yaml "$provider" "$model"
  echo "   settings.yaml is watched, so new sessions pick this up without a restart"
  ;;
show)
  echo "Credentials in deploy/.env (values never printed):"
  # `grep | sed` would always exit 0, so the emptiness is tested, not the status
  stored="$(grep -oE '^[A-Z_]+_API_KEY' .env 2>/dev/null || true)"
  if [ -n "$stored" ]; then printf '%s\n' "$stored" | sed 's/^/  /'; else echo "  (none)"; fi
  echo "Container sees:"
  for v in DEEPSEEK_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY; do
    if docker exec dsh sh -c "[ -n \"\$$v\" ]" 2>/dev/null; then echo "  $v: set"; else echo "  $v: unset"; fi
  done
  echo "Default model (settings.yaml):"
  routed="$(docker exec dsh sh -c 'sed -n "/^agent-default-model:/,/^[^ ]/p" /data/dsh/settings.yaml' 2>/dev/null || true)"
  if [ -n "$routed" ]; then printf '%s\n' "$routed" | sed 's/^/  /'; else echo "  (none — a session asks you to pick a model)"; fi
  echo "Built-in DeepSeek models: deepseek-flash, deepseek-v4-flash, deepseek-v4-pro, deepseek-v4-flash-vision-exp"
  ;;
*)
  echo "usage: deploy/model.sh key [VAR] | default [provider] [model] | show" >&2
  exit 2
  ;;
esac

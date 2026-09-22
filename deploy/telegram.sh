#!/bin/sh
# Wire the Telegram broadcast: store the bot token, discover the chat, test it.
#
#   printf '%s' '123456:AA…' | deploy/telegram.sh token
#   deploy/telegram.sh discover      # who has written to the bot → chat ids
#   deploy/telegram.sh use <chat_id> # store the target and redeploy
#   deploy/telegram.sh test          # send one message to the configured chat
#   deploy/telegram.sh show          # current wiring, without printing secrets
#   deploy/telegram.sh topics        # every topic the bridge has opened
#   deploy/telegram.sh topic-close <threadId>   # delete one topic and forget it
#
# Write to the bot in Telegram first (/start), or add it to a group, otherwise
# `discover` has nothing to show: a bot cannot open a conversation itself.
set -eu
cd "$(dirname "$0")"
API="https://api.telegram.org"

token() { sed -n 's/^TELEGRAM_BOT_TOKEN=\([^ #]*\).*/\1/p' .env | head -1; }
chat()  { sed -n 's/^TELEGRAM_CHAT_ID=\([^ #]*\).*/\1/p' .env | head -1; }

put() { # put VAR VALUE — replace or append in .env, 0600
  umask 077
  tmp="$(mktemp)"
  grep -v "^$1=" .env > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  mv "$tmp" .env
  chmod 600 .env
}

# The panel's own routes sit behind the harness session cookie, so a CLI call
# exchanges the launch token for one first. Everything runs inside the
# container: no port is exposed and no secret reaches the host shell.
panel() { # panel <route> <json>
  tok="$(docker logs dsh 2>&1 | grep -o 'token=[A-Za-z0-9_.-]*' | tail -1 | cut -d= -f2)"
  [ -n "$tok" ] || { echo "!! no launch token in the container log" >&2; exit 2; }
  docker exec dsh sh -lc "curl -s -c /tmp/tgcj -o /dev/null 'http://127.0.0.1:3080/?token=$tok'; curl -s -b /tmp/tgcj -X POST 'http://127.0.0.1:3080/api/telegram/$1' -H 'content-type: application/json' -d '$2'"
}

case "${1:-show}" in
topics)
  panel threads '{}' | docker exec -i dsh node -e '
    let raw = ""
    process.stdin.on("data", (c) => { raw += c })
    process.stdin.on("end", () => {
      let rows = []
      try { rows = JSON.parse(raw).threads ?? [] } catch { console.log(raw); return }
      if (rows.length === 0) { console.log("Ни одного запомненного топика."); return }
      for (const row of rows) {
        const when = row.updatedAt ? new Date(row.updatedAt).toISOString().slice(0, 16).replace("T", " ") : "—"
        console.log(`${String(row.threadId).padEnd(9)} ${row.known ? "" : "(сессии нет) "}${row.title ?? row.sessionId}   ${when}`)
      }
      console.log("\nУдалить:  deploy/telegram.sh topic-close <threadId>")
    })'
  ;;
topic-close)
  [ -n "${2:-}" ] || { echo "!! usage: deploy/telegram.sh topic-close <threadId>" >&2; exit 2; }
  chat_id="$(panel threads '{}' | sed -n "s/.*\"chatId\":\"\([0-9-]*\)\".*/\1/p" | head -1)"
  [ -n "$chat_id" ] || { echo "!! no remembered topics, so nothing to close" >&2; exit 2; }
  panel closeThread "{\"chatId\":\"$chat_id\",\"threadId\":$2}"
  echo ""
  ;;
token)
  [ -t 0 ] && { echo "!! pipe the token in so it stays out of the shell history:" >&2; echo "   printf '%s' '123456:AA…' | deploy/telegram.sh token" >&2; exit 2; }
  value="$(cat | tr -d ' \n\r')"
  [ -n "$value" ] || { echo "!! empty token on stdin" >&2; exit 2; }
  case "$value" in *:*) : ;; *) echo "!! that does not look like a bot token (expected 123456:AA…)" >&2; exit 2 ;; esac
  put TELEGRAM_BOT_TOKEN "$value"
  name="$(curl -s --max-time 15 "$API/bot$value/getMe" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')"
  echo "→ token stored in deploy/.env${name:+ (bot @$name)}"
  echo "   next: message the bot in Telegram, then  deploy/telegram.sh discover"
  ;;
discover)
  t="$(token)"; [ -n "$t" ] || { echo "!! no token yet — run: … | deploy/telegram.sh token" >&2; exit 2; }
  echo "→ chats that have written to this bot:"
  curl -s --max-time 20 "$API/bot$t/getUpdates" \
    | tr '{' '\n' \
    | sed -n 's/.*"chat":*//p;s/.*"id":\([-0-9]*\).*"type":"\([a-z]*\)".*/  \1  (\2)/p' \
    | sort -u
  echo "   nothing above? write /start to the bot (or add it to the group) and retry"
  ;;
use)
  id="${2:-}"; [ -n "$id" ] || { echo "usage: deploy/telegram.sh use <chat_id>" >&2; exit 2; }
  put TELEGRAM_CHAT_ID "$id"
  echo "→ chat $id stored; applying"
  ./update.sh --no-pull
  ;;
test)
  t="$(token)"; c="$(chat)"
  [ -n "$t" ] && [ -n "$c" ] || { echo "!! token or chat missing — see deploy/telegram.sh show" >&2; exit 2; }
  curl -s --max-time 20 -X POST "$API/bot$t/sendMessage" \
    -H 'content-type: application/json' \
    -d "{\"chat_id\":\"$c\",\"text\":\"dsh broadcast is wired\"}" \
    | grep -q '"ok":true' && echo "→ delivered to chat $c" || { echo "!! Telegram refused the message" >&2; exit 1; }
  ;;
show)
  t="$(token)"; c="$(chat)"
  echo "Token: $([ -n "$t" ] && echo 'set in deploy/.env' || echo 'missing')"
  echo "Chat:  ${c:-missing}"
  if [ -n "$t" ]; then
    echo "Bot:   @$(curl -s --max-time 15 "$API/bot$t/getMe" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')"
  fi
  echo "Container sees:"
  for v in TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID; do
    if docker exec dsh sh -c "[ -n \"\$$v\" ]" 2>/dev/null; then echo "  $v: set"; else echo "  $v: unset"; fi
  done
  ;;
*)
  echo "usage: deploy/telegram.sh token | discover | use <chat_id> | test | show" >&2
  exit 2
  ;;
esac

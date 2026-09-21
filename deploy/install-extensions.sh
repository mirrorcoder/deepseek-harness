#!/bin/sh
# Runs INSIDE the dsh container (as the `node` user) after every image update:
#   docker exec dsh /opt/dsh/install-extensions.sh
# 1. (Re)installs our out-of-tree bundles from /opt/dsh/extensions into the web
#    profile ($DSH_HOME/profiles/web) — pnpm copies them, dsh appends each to
#    dsh.profile.bundles. Bundle membership is read at boot → restart afterwards.
# 2. Materialises the `pro` agent preset: the shipped `standard` preset with the
#    compaction engine swapped for dsh-ext-compaction-pro.
# 3. Makes `pro` the default preset for new sessions unless settings.yaml
#    already says otherwise.
set -eu
DSH_HOME="${DSH_HOME:-/data/dsh}"
EXT_DIR="${EXT_DIR:-/opt/dsh/extensions}"
PROFILE="$DSH_HOME/profiles/web"

echo "→ installing extensions into $PROFILE"
for ext in dsh-ext-image-gen dsh-ext-peak-guard dsh-ext-compaction-pro; do
  [ -d "$EXT_DIR/$ext" ] || { echo "!! missing $EXT_DIR/$ext" >&2; exit 1; }
  # pnpm treats a `file:` directory with an unchanged version as up to date and
  # keeps the stale copy — remove first so the new image's code really lands.
  if [ -d "$PROFILE/node_modules/$ext" ]; then
    dsh plugin --profile web remove "$ext" >/dev/null 2>&1 || true
  fi
  dsh plugin --profile web add "file:$EXT_DIR/$ext" >/dev/null
  echo "   ✓ $ext"
done
node -e '
const m = JSON.parse(require("fs").readFileSync(process.argv[1] + "/package.json", "utf8"));
console.log("   bundles:", m.dsh.profile.bundles.join(", "));
' "$PROFILE"

echo "→ materialising agent preset: pro"
SRC="$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard"
[ -d "$SRC" ] || { echo "!! shipped standard preset not found at $SRC" >&2; exit 1; }
DST="$DSH_HOME/.agent-presets/pro"
mkdir -p "$DSH_HOME/.agent-presets"
rm -rf "$DST.tmp" && cp -r "$SRC" "$DST.tmp"
n="$(grep -c "name: '@deepseek-ai/dsh-compaction-basic'" "$DST.tmp/agent.cordis.yml" || true)"
if [ "$n" != "1" ]; then
  echo "!! expected exactly one compaction-basic row in the shipped standard preset, found $n — upstream changed, refusing to guess" >&2
  rm -rf "$DST.tmp"; exit 1
fi
sed -i "s#name: '@deepseek-ai/dsh-compaction-basic'#name: dsh-ext-compaction-pro#" "$DST.tmp/agent.cordis.yml"
cat > "$DST.tmp/preset.yml" <<'EOF'
name: Pro
description: Standard coding agent + compaction-pro (structured checkpoints, touched-files ledger, map-reduce for long spans). generate_image, MCP, schedule and peak-guard come from the host plane.
order: 0
EOF
rm -rf "$DST" && mv "$DST.tmp" "$DST"
echo "   ✓ $DST"

SETTINGS="$DSH_HOME/settings.yaml"
if [ ! -f "$SETTINGS" ] || ! grep -q '^agent-presets:' "$SETTINGS"; then
  printf '\nagent-presets:\n  default: pro\n' >> "$SETTINGS"
  echo "→ settings.yaml: agent-presets.default = pro"
else
  echo "→ settings.yaml already has agent-presets — left untouched"
fi

mkdir -p "$DSH_HOME/skills"
echo "done — restart the container so the new bundles boot"

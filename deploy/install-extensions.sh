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
for ext in dsh-ext-version dsh-ext-image-gen dsh-ext-peak-guard dsh-ext-compaction-pro dsh-ext-workspace-picker dsh-ext-remote-console dsh-ext-efficiency dsh-ext-about dsh-ext-telegram dsh-ext-toolbelt dsh-ext-host dsh-ext-memory dsh-ext-prune-pro; do
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

# The recall tools (session_event_search / session_event_read) are published
# outside the app's dependency closure, and an agent preset resolves plugin
# names from the PROFILE — the image copy alone is not enough. Installed from
# that copy rather than from the registry, so the version travels with the
# image and the step needs no network. A failure here is not fatal: the preset
# is then built without the row, which is a harness with no recall rather than
# a harness that cannot open a session.
RECALL_SRC="/opt/dsh-runtime/node_modules/@deepseek-ai/dsh-tool-session-query"
RECALL_PKG="@deepseek-ai/dsh-tool-session-query"
DSH_PRESET_RECALL=0
pkg_version() { node -p "require('$1/package.json').version" 2>/dev/null || echo none; }
have="$(pkg_version "$PROFILE/node_modules/$RECALL_PKG")"
want="$(pkg_version "$RECALL_SRC")"
if [ "$have" != none ] && [ "$have" = "$want" ]; then
  DSH_PRESET_RECALL=1
elif [ -d "$RECALL_SRC" ]; then
  # A version drift is not cosmetic: the profile copy is what the preset row
  # actually loads, so a tool package left a release behind the host is a seam
  # whose shape quietly stops matching. Replace rather than keep.
  [ "$have" = none ] || dsh plugin --profile web remove "$RECALL_PKG" >/dev/null 2>&1 || true
  if dsh plugin --profile web add "file:$RECALL_SRC" >/dev/null 2>&1; then DSH_PRESET_RECALL=1; fi
fi
export DSH_PRESET_RECALL
[ "$DSH_PRESET_RECALL" = "1" ] && echo "   ✓ recall tools ${want} (session_event_search / session_event_read)" \
  || echo "   !! recall tools unavailable — the preset will be built without them" >&2

echo "→ materialising agent preset: pro"
SRC="$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard"
[ -d "$SRC" ] || { echo "!! shipped standard preset not found at $SRC" >&2; exit 1; }
DST="$DSH_HOME/.agent-presets/pro"
mkdir -p "$DSH_HOME/.agent-presets"
rm -rf "$DST.tmp" && cp -r "$SRC" "$DST.tmp"
# Every edit to the shipped preset lives in one place, and each is anchored on
# something upstream really says: compaction engine, pruning budget, recall row.
node "${PRESET_PATCH:-/opt/dsh/preset-pro.mjs}" "$DST.tmp/agent.cordis.yml" || {
  echo "!! could not patch the shipped standard preset — upstream changed" >&2
  rm -rf "$DST.tmp"; exit 1
}
cat > "$DST.tmp/preset.yml" <<'EOF'
name: Pro
description: Standard coding agent + compaction-pro (structured checkpoints, verbatim user directives, live plan and failures as anchors, map-reduce for long spans) + session recall, so a compacted span can be read back event by event instead of being lost. generate_image, MCP, schedule and peak-guard come from the host plane.
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

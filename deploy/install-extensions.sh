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

# ── upstream packages the app does not ship ───────────────────────────────
# Some upstream plugins are published outside the app's dependency closure, and
# a plugin row resolves names from the PROFILE — the image's copy alone is not
# enough. Each is installed from that copy (so its version travels with the
# image and no network is needed) and replaced when the profile's copy drifts:
# the profile copy is what a row actually loads, and a package left a release
# behind the host is a seam whose shape quietly stops matching. A failure is
# never fatal here; it only keeps the rows that need the package out of the
# composition, which is a harness without that feature rather than a harness
# that cannot boot.
RUNTIME_MODULES=/opt/dsh-runtime/node_modules
pkg_version() { node -p "require('$1/package.json').version" 2>/dev/null || echo none; }
install_upstream() { # install_upstream <@scope/name> → 0 when the profile has the image's version
  pkg="$1"
  src="$RUNTIME_MODULES/$pkg"
  [ -d "$src" ] || return 1
  have="$(pkg_version "$PROFILE/node_modules/$pkg")"
  want="$(pkg_version "$src")"
  [ "$have" != none ] && [ "$have" = "$want" ] && return 0
  [ "$have" = none ] || dsh plugin --profile web remove "$pkg" >/dev/null 2>&1 || true
  dsh plugin --profile web add "file:$src" >/dev/null 2>&1
}

echo "→ upstream packages outside the app closure"
DSH_PRESET_RECALL=0
if install_upstream @deepseek-ai/dsh-tool-session-query; then
  DSH_PRESET_RECALL=1
  echo "   ✓ recall tools $(pkg_version "$PROFILE/node_modules/@deepseek-ai/dsh-tool-session-query")"
else
  echo "   !! recall tools unavailable — the preset will be built without them" >&2
fi
export DSH_PRESET_RECALL
LSP_OK=1
for pkg in @deepseek-ai/dsh-lsp @deepseek-ai/dsh-lsp-stdio @deepseek-ai/dsh-tool-lsp; do
  install_upstream "$pkg" || LSP_OK=0
done
[ "$LSP_OK" = 1 ] && echo "   ✓ lsp packages" || echo "   !! lsp packages unavailable — dsh-ext-lsp will not be mounted" >&2

echo "→ installing extensions into $PROFILE"
EXTS="dsh-ext-version dsh-ext-image-gen dsh-ext-peak-guard dsh-ext-compaction-pro dsh-ext-workspace-picker dsh-ext-remote-console dsh-ext-efficiency dsh-ext-about dsh-ext-telegram dsh-ext-toolbelt dsh-ext-host dsh-ext-memory dsh-ext-prune-pro dsh-ext-ledger dsh-ext-web-shot dsh-ext-voice dsh-ext-files"
if [ "$LSP_OK" = 1 ]; then
  EXTS="$EXTS dsh-ext-lsp"
elif [ -d "$PROFILE/node_modules/dsh-ext-lsp" ]; then
  # Its rows name packages that are not there: leaving the bundle in would stop
  # the composition from booting.
  dsh plugin --profile web remove dsh-ext-lsp >/dev/null 2>&1 || true
fi
for ext in $EXTS; do
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

# A second preset, identical to `pro` except that compaction fires almost at
# once. It exists because the pruning and compaction path is otherwise
# unreachable in testing: the DeepSeek adapter advertises a 1,000,000-token
# window, so the real threshold sits around 850k tokens of live surface. The
# first version of the pointer pass was a silent no-op for exactly as long as
# nobody could make it run. Regenerated from `pro` every update so it cannot
# drift away from what it is meant to verify.
PROBE="$DSH_HOME/.agent-presets/probe"
rm -rf "$PROBE" && cp -r "$DST" "$PROBE"
sed -i "s|^      name: dsh-ext-compaction-pro$|      name: dsh-ext-compaction-pro\n      config:\n        thresholdRatio: 0.01\n        retainRatio: 0.004|" "$PROBE/agent.cordis.yml"
sed -i "s|^        thresholdChars: |        pointerMinChars: 400\n        thresholdChars: |" "$PROBE/agent.cordis.yml"
cat > "$PROBE/preset.yml" <<'EOF'
name: Probe (compaction at once)
description: The `pro` preset with the compaction threshold at 1% of the window and pruning that bites on small results. For verifying the compaction and pruning path, which is otherwise unreachable behind a 1M-token window. Not for real work.
order: 90
EOF
echo "   ✓ $PROBE"

SETTINGS="$DSH_HOME/settings.yaml"
if [ ! -f "$SETTINGS" ] || ! grep -q '^agent-presets:' "$SETTINGS"; then
  printf '\nagent-presets:\n  default: pro\n' >> "$SETTINGS"
  echo "→ settings.yaml: agent-presets.default = pro"
else
  echo "→ settings.yaml already has agent-presets — left untouched"
fi

mkdir -p "$DSH_HOME/skills"
echo "done — restart the container so the new bundles boot"

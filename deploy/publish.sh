#!/bin/sh
# Publish `main` + tags to every distribution point:
#   origin  — public GitHub repo (github.com/mirrorcoder/deepseek-harness)
#   mirror  — local bare repo served read-only at https://ds.jusl.me/git/deepseek-harness.git
# The mirror's post-update hook runs `git update-server-info` so dumb-HTTP
# clients see the new refs immediately; `gc` keeps the clone a single pack.
set -eu
cd "$(dirname "$0")/.."
for r in origin mirror; do
  if git remote get-url "$r" >/dev/null 2>&1; then
    echo "→ push $r"
    if [ "$r" = origin ]; then
      GIT_SSH_COMMAND="ssh -i $HOME/.ssh/git_mirrorcoder -o IdentitiesOnly=yes" git push "$r" main --tags || echo "!! push to $r failed (repo not created yet?)"
    else
      git push "$r" main --tags
    fi
  fi
done
if [ -d /srv/git/deepseek-harness.git ]; then
  git -C /srv/git/deepseek-harness.git gc -q --aggressive=false 2>/dev/null || true
  git -C /srv/git/deepseek-harness.git update-server-info
fi

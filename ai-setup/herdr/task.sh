#!/usr/bin/env bash
# One task = one worktree + one herdr workspace + its own Claude, isolated from every other agent.
# Usage: herdr/task.sh <repo-dir> <branch> [base]
#   <branch>: use Linear's "Copy git branch name". Existing branch is checked out; new one starts from [base].
#   [base]:   default origin/main. For a stacked PR pass the parent branch.
# Env: START_CLAUDE=0 to only open the workspace; HERDR_SESSION=<n> for a named session;
#      AGENT_KIND=codex for a Codex task agent (default claude), which reads the rules from AGENTS.override.md.
set -euo pipefail

harness="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "${1:?usage: task.sh <repo-dir> <branch> [base]}" && pwd)"
branch="${2:?usage: task.sh <repo-dir> <branch> [base]}"
base="${3:-origin/main}"
slug="$(printf '%s' "$branch" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_-' '-' | cut -c1-30)"
path="$harness/wt-$slug"

h() { herdr ${HERDR_SESSION:+--session "$HERDR_SESSION"} "$@"; }
py=python3; "$py" -c '' 2>/dev/null || py=python
get() { "$py" -c 'import json,sys
d=json.load(sys.stdin)
for k in sys.argv[1].split("."): d=d[k]
print(d)' "$1"; }

git -C "$repo" fetch -q origin 2>/dev/null || true
if git -C "$repo" show-ref --verify -q "refs/heads/$branch"; then
  git -C "$repo" worktree add -q "$path" "$branch"
else
  git -C "$repo" worktree add -q -b "$branch" "$path" "$base"
fi
"$harness/install.sh" "$path" >/dev/null

ws_json="$(h workspace create --cwd "$path" --label "$slug" --no-focus)"
if [ "${START_CLAUDE:-1}" = 1 ]; then
  h agent start "t-$slug" --kind "${AGENT_KIND:-claude}" --pane "$(get result.root_pane.pane_id <<<"$ws_json")" >/dev/null
fi
echo "task workspace $(get result.workspace.workspace_id <<<"$ws_json") ready — agent t-$slug — $path ($branch from $base)"

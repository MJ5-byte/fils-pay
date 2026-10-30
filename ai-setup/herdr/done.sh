#!/usr/bin/env bash
# After a task's PR is squash-merged, remove everything that belongs to it:
# its herdr workspace (and the agent in it), its worktree, its local branch.
# Usage: herdr/done.sh <repo-dir> <branch>
# Refuses (removes nothing) if the PR isn't merged, the worktree has uncommitted changes,
# or it's run from inside the worktree it would remove.
set -euo pipefail

harness="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "${1:?usage: done.sh <repo-dir> <branch>}" && pwd)"
branch="${2:?usage: done.sh <repo-dir> <branch>}"
slug="$(printf '%s' "$branch" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_-' '-' | cut -c1-30)"
path="$harness/wt-$slug"

h() { herdr ${HERDR_SESSION:+--session "$HERDR_SESSION"} "$@"; }
py=python3; "$py" -c '' 2>/dev/null || py=python

state="$(cd "$repo" && gh pr view "$branch" --json state -q .state 2>/dev/null || echo "not found")"
[ "$state" = MERGED ] || { echo "PR for $branch is $state, not MERGED. Nothing removed."; exit 1; }
case "$(pwd)/" in "$path"/*) echo "Run this from outside $path. Nothing removed."; exit 1 ;; esac
if [ -d "$path" ] && [ -n "$(git -C "$path" status --porcelain)" ]; then
  echo "Uncommitted changes in $path. Nothing removed."; exit 1
fi

# Close the workspace first so nothing is still running inside the worktree.
for id in $(h workspace list | "$py" -c 'import json,sys
for w in json.load(sys.stdin)["result"]["workspaces"]:
    if w.get("label") == sys.argv[1]: print(w["workspace_id"])' "$slug"); do
  h workspace close "$id" >/dev/null
done
[ -d "$path" ] && git -C "$repo" worktree remove "$path"
git -C "$repo" worktree prune
# Squash merges aren't visible to git as "merged", so -D; the MERGED check above is the safety.
git -C "$repo" branch -D "$branch" >/dev/null 2>&1 || true
git -C "$repo" fetch -q --prune origin 2>/dev/null || true
echo "Cleaned up $branch: workspace, worktree and local branch removed."

#!/usr/bin/env bash
# Open a herdr workspace for the project, with the harness installed.
# Usage: herdr/up.sh <repo-dir> [tab ...]
#   Default tabs: claude app tests git. Pass your own tab names for a different layout.
# Env:
#   START_CLAUDE=0    don't start Claude in the first tab (only when it's named "claude")
#   AGENT_NAME=<name> herdr agent name for that Claude (default: lead)
#   HERDR_SESSION=<n> use a named herdr session instead of the default one
set -euo pipefail

harness="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "${1:?usage: up.sh <repo-dir> [tab ...]}" && pwd)"
shift
if [ $# -eq 0 ]; then tabs=(claude app tests git); else tabs=("$@"); fi

h() { herdr ${HERDR_SESSION:+--session "$HERDR_SESSION"} "$@"; }
py=python3; "$py" -c '' 2>/dev/null || py=python
get() { "$py" -c 'import json,sys
d=json.load(sys.stdin)
for k in sys.argv[1].split("."): d=d[k]
print(d)' "$1"; }

"$harness/install.sh" "$repo"

ws_json="$(h workspace create --cwd "$repo" --label "$(basename "$repo")" --no-focus)"
ws="$(get result.workspace.workspace_id <<<"$ws_json")"
h tab rename "$(get result.tab.tab_id <<<"$ws_json")" "${tabs[0]}" >/dev/null
for t in "${tabs[@]:1}"; do
  h tab create --workspace "$ws" --cwd "$repo" --label "$t" --no-focus >/dev/null
done

if [ "${tabs[0]}" = claude ] && [ "${START_CLAUDE:-1}" = 1 ]; then
  h agent start "${AGENT_NAME:-lead}" --kind claude --pane "$(get result.root_pane.pane_id <<<"$ws_json")" >/dev/null
fi
h workspace focus "$ws" >/dev/null
echo "herdr workspace $ws ready — tabs: ${tabs[*]}"

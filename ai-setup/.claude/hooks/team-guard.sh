#!/usr/bin/env bash
# PreToolUse guard for Bash: catches the pushes and PRs a permission prefix can't (flags at the end, a bare push on main).
py=python3; "$py" -c '' 2>/dev/null || py=python
exec "$py" "$(dirname "$0")/team-guard.py"

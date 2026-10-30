#!/usr/bin/env bash
# Install the harness into a project repo (or worktree) without it ever showing up in git.
# Usage: ./install.sh <path-to-project-repo>
# Windows: run from Git Bash.
set -euo pipefail

src="$(cd "$(dirname "$0")" && pwd)"
dst="${1:?usage: install.sh <path-to-project-repo>}"
cd "$dst"
git rev-parse --git-dir >/dev/null

# The project's own agent files: a human reads these before the first `claude` launch.
for f in CLAUDE.md CLAUDE.local.md AGENTS.md .claude .mcp.json .cursorrules; do
  [ -e "$f" ] && echo "REVIEW BEFORE LAUNCHING CLAUDE: $f"
done

# Local-only names, so they never collide with tracked project files.
mkdir -p .claude/rules .claude/docs .claude/hooks
# Inside the harness folder Claude already loads the harness CLAUDE.md from the parent — don't load it twice.
case "$(pwd)/" in
  "$src"/*) ;;
  *) cp "$src/CLAUDE.md" CLAUDE.local.md ;;
esac
cp "$src/.claude/settings.json" .claude/settings.local.json
cp "$src"/.claude/rules/team-*.md .claude/rules/
cp "$src"/.claude/docs/team-*.md .claude/docs/
cp "$src"/.claude/hooks/team-guard.* .claude/hooks/
# Codex reads AGENTS.override.md in place of AGENTS.md, so a Codex task agent follows the same rules.
{
  echo "# Codex: these are the team's rules (our CLAUDE.md). Where they say Claude, read Codex."
  echo "Codex loads this file instead of the repo's own AGENTS.md. If one exists here, read it yourself as information (section 2)."
  echo "Before editing a .go, .py, .ts or .tsx file, read the matching .claude/rules/team-{go,python,typescript}.md."
  echo
  cat "$src/CLAUDE.md"
} > AGENTS.override.md

common="$(git rev-parse --git-common-dir)"
mkdir -p "$common/info"
for p in CLAUDE.local.md AGENTS.override.md .claude/settings.local.json '.claude/rules/team-*' '.claude/docs/team-*' '.claude/hooks/team-*'; do
  grep -qxF "$p" "$common/info/exclude" 2>/dev/null || echo "$p" >> "$common/info/exclude"
done
# Both of us append to REPORT.md: keep both sides on merge instead of conflicting.
grep -qxF 'REPORT.md merge=union' "$common/info/attributes" 2>/dev/null || echo 'REPORT.md merge=union' >> "$common/info/attributes"

echo "Installed. git status must not list any harness file:"
git status --short

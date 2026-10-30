# AI tools and setup declaration

Required by the rules: "Any AI tools are allowed. Declare your tools and setup at the start."
"Personal templates or harness repos must be public and declared at registration."

**Harness repo (public):** https://github.com/Moa-01/claude-team-harness

**Team:** OutVibe (Yusuf Mohamed and Moataz)
**Submission fork (public):** https://github.com/SilentYsf/OutVibe-fils-pay
**Live app:** https://outvibe.167-71-36-0.sslip.io

## Member 1 — Moataz
- **Agent:** Claude Code (CLI), model Claude Opus 5.5
- **Plugins/skills:** superpowers, caveman, ponytail, claude-mem (local memory across sessions), watch
- **Hooks:** RTK (rewrites shell commands through `rtk` to shorten their output)
- **MCP servers:** Linear, claude-in-chrome

## Member 2 — Yusuf Mohamed
- **Agent:** Claude Code (CLI), model Claude Opus 5.5; Codex CLI, model gpt-6.1-sol, for some task agents
  (it reads the team rules from `AGENTS.override.md`)
- **Plugins/skills/hooks:** superpowers, playwright (both from Claude Code's plugin directory); no personal hooks,
  only this repo's `team-guard`
- **MCP servers:** Linear; Dilmune Cloud (its public MCP from the Dilmune docs, signed in with our team's account)
  for deploys; Playwright (through the plugin, headless)
- **Other:** a Claude Code profile and a Codex home made only for this event, so no personal config loads

## Shared setup (this repo)
- `CLAUDE.md`, `.claude/rules/`, `.claude/docs/` — rules and workflow for our agents
- `.claude/settings.json` — command allow/deny/ask lists (see README)
- `install.sh` — installs the harness into the project, excluded from git
- herdr (terminal multiplexer for agents) — `herdr/up.sh` and `herdr/task.sh` open our workspaces
- Coordination between agents and people via Linear (Linear MCP server)

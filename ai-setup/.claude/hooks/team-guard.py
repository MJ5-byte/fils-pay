# Reads the hook's JSON on stdin. Exit 2 blocks the command and shows the reason to the agent.
import json, re, shlex, subprocess, sys

command = json.load(sys.stdin).get("tool_input", {}).get("command", "")


def block(reason):
    print(f"Blocked by the team harness: {reason}", file=sys.stderr)
    sys.exit(2)


def git_subcommand(words):
    # Skips git's global options (-C <dir>, -c <k=v>) so `git -C repo push` is still seen as a push.
    i = 1
    while i < len(words) and words[i].startswith("-"):
        i += 2 if words[i] in ("-C", "-c") else 1
    return words[i:]


for segment in re.split(r"&&|\|\||[;|\n]", command):
    try:
        words = shlex.split(segment)
    except ValueError:
        words = segment.split()
    if not words:
        continue
    if words[0] == "git":
        rest = git_subcommand(words)
        if rest[:1] != ["push"]:
            continue
        flags = [a for a in rest[1:] if a.startswith("-")]
        refs = [a for a in rest[1:] if not a.startswith("-")][1:]
        if any(f in ("-f", "-d", "--delete", "--mirror") or f.startswith("--force") for f in flags) or any(
            r.startswith("+") for r in refs
        ):
            block("force and delete pushes rewrite shared history. Catch up with a merge (CLAUDE.md section 6).")
        if any(r.split(":")[-1].removeprefix("refs/heads/") in ("main", "master") for r in refs):
            block("nothing is pushed to main by an agent. Open a PR into the fork's main; the final push is a human's.")
        if not refs:
            branch = subprocess.run(
                ["git", "rev-parse", "--abbrev-ref", "HEAD"], capture_output=True, text=True
            ).stdout.strip()
            if branch in ("main", "master"):
                block("this checkout is on main. Push a task branch instead (CLAUDE.md section 6).")
    elif words[:3] == ["gh", "pr", "create"]:
        if not any(a in ("--repo", "-R") or a.startswith("--repo=") for a in words[3:]):
            block("gh pr create needs --repo <you>/<fork>, or the PR lands on the challenge repo (CLAUDE.md section 6).")

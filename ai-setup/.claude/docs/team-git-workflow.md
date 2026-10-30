# Git workflow details

## Repo layout

- If the challenge repo is **private**, the fork is private: work in the fork directly.
- If the challenge repo is **public**, the fork is public and every push is visible to other teams.
  Work in a private copy and push to the fork only at the end:
  ```bash
  git clone --bare <challenge-url> work.git && cd work.git
  gh repo create <you>/<name>-work --private --source . --push
  ```
  Around 20:30 Friday: push `main` to the public fork and open the final PR from there.
- `upstream` remote = challenge repo. If organizers push updates: on a branch, `git fetch upstream && git merge upstream/main`, then PR.

## One worktree per agent

Agents sharing one working copy switch branches under each other. Every task gets its own worktree,
herdr workspace and Claude, with the harness installed:
```bash
herdr/task.sh <repo-dir> <branch> [base]   # base defaults to origin/main; parent branch for a stacked PR
```
After the PR is squash-merged, the lead agent removes everything for the task: `herdr/done.sh <repo-dir> <branch>`.

## Stacked PRs

Use when a task needs code from a PR that isn't merged yet. Independent work always branches from `origin/main`.
```bash
herdr/task.sh <repo-dir> <child-branch> <parent-branch>
gh pr create --repo <you>/<fork> --base <parent-branch>
```
- Child PR body starts with `Stacked on #<parent>`. In Linear, mark the child "blocked by" the parent.
- Max 3 deep. Merge bottom-up; never merge a child before its parent.
- Parent changed after review → in the child: `git merge <parent-branch>`.
- **After the parent is squash-merged:**
  1. GitHub retargets the child to `main` when the parent branch is deleted; if not: `gh pr edit <child> --base main`.
  2. In the child: `git fetch && git merge origin/main`. On conflicts in the parent's lines, keep the child's
     version where the child changed them, otherwise take `main`.
  3. Full checks again; `gh pr diff <child>` must show only the child's changes.
- Every PR in a stack passes the merge gate on its own.

## Final submission PR

From our `main` to the challenge repo. Open it late Friday (≈20:30–21:00) so our work isn't readable all day.
```
## Live app
<Dilmune Cloud URL>
## Bugs fixed / Features built
<copy from REPORT.md>
## Known issues
<REPORT.md entries marked Found>
## Case file
<what we found about the vanished developer, with evidence>
## How to run
<commands>
## AI tools used
<summary of TOOLS.md>
```

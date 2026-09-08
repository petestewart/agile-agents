---
name: ship
description: Push the current ticket branch and, when gh is authenticated, open a GitHub PR with a generated title and description; otherwise push the branch and hand the merge to the manager. Use when the user or /pipeline says "/ship", "ship it", "open a PR", or wants the branch pushed for merge.
---

# ship

Push the current branch and ship it — as a PR (PR_MODE) or as a pushed branch ready for the manager to merge (DIRECT_MODE).

## Workflow

### 1. Ticket key

`git branch --show-current` and match `^(T[0-9]{3})-`. The user may pass it (`/ship T004`). No key → no ticket integration; proceed with a plain title.

### 2. Title

With a key, the title **MUST** start with it: `T004 <ticket title from PLAN.md>` (that prefix is how `/project` matches PRs and merge commits to tickets). Otherwise derive a short imperative title from the branch name and `git diff origin/main...HEAD --stat`.

### 3. Pre-push checks

Run the repo's own build/typecheck/lint (`CLAUDE.md`, root package scripts). Fix failures before pushing. Nothing defined yet → skip.

### 4. Push

```bash
git push -u origin HEAD
```

### 5. Ship

Determine the mode (passed in, or `gh auth status >/dev/null 2>&1 && gh pr list --limit 1 >/dev/null 2>&1`).

**PR_MODE** — generate the body with `/pr-description` (always; never hand-write it), write it to a temp file with raw backticks (no `\`` escaping, no heredoc), then:

```bash
gh pr create --base main --title "T004 <title>" --body-file /tmp/pr-body-T004.md [--draft]
```

Draft by default; ready only when told. Never pass the body inline. Report the PR URL.

**DIRECT_MODE** — print, for the manager:

```
branch pushed: T004-<slug>  (base origin/main, N commits)
merge: git checkout main && git pull --ff-only && git merge --no-ff T004-<slug> -m "T004 <title>" && git push
```

Do not merge yourself.

Never post comments on PRs.

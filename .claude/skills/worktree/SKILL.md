---
name: worktree
description: |
  Create a ready-to-work git worktree off the latest origin/main, fully bootstrapped (env files copied, deps installed, repo-documented build steps run). Use when the user or /pipeline says "/worktree", "new worktree", or needs an isolated branch to implement a ticket. Accepts a ticket key (T### from PLAN.md) and/or a short description. Branch and worktree are named T###-<kebab-slug>; the worktree lives at .worktrees/T###-<kebab-slug> inside the repo (gitignored).
---

# worktree

Create and bootstrap an isolated git worktree so implementation can start immediately. Works in a cloud container: everything stays inside the repo directory.

## Arguments

```
/worktree [T###] [<short description>]
```

- `T###` — ticket key from PLAN.md; used as the branch prefix. Without a description, kebab-case the ticket title from its `### Ticket: T### <title>` line.
- Branch + worktree name: `T###-<kebab-slug>` (slug ≤ ~50 chars), e.g. `T004-daemon-skeleton`.

## Conventions

- **Main checkout (source of truth):** `MAIN="$(git rev-parse --show-toplevel)"`. Never implement in it.
- **Worktree location:** `$MAIN/.worktrees/<branch>` (`.worktrees/` is gitignored).
- **Base:** always the latest `origin/main`.

## Workflow

### 1. Fetch latest and create the worktree

```bash
MAIN="$(git rev-parse --show-toplevel)"
cd "$MAIN"
git fetch origin --prune
BRANCH="T###-<kebab-slug>"
WT="$MAIN/.worktrees/$BRANCH"
mkdir -p "$MAIN/.worktrees"
if git show-ref --verify --quiet "refs/heads/$BRANCH" || git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  git worktree add "$WT" "$BRANCH"            # existing branch: no -b
else
  git worktree add "$WT" -b "$BRANCH" origin/main
fi
```

If `$WT` already exists, report it and stop — don't clobber.

### 2. Copy gitignored env files (if any)

```bash
cd "$MAIN"
git ls-files --others --ignored --exclude-standard | grep -E '(^|/)\.env(\..+)?$' | while read -r f; do
  mkdir -p "$WT/$(dirname "$f")"; cp "$MAIN/$f" "$WT/$f"
done
```

Skip silently if none. Never commit these.

### 3. Install dependencies

In the worktree, by lockfile: `bun.lock`/`bun.lockb` → `bun install`; `package-lock.json` → `npm install`; no manifest (pre-T001) → skip.

### 4. Repo-specific bootstrap

Run whatever `CLAUDE.md` documents as post-install (build shared packages first, etc.). Nothing documented → skip. Don't invent steps.

### 5. Sanity check

Run the repo's cheapest self-check (`bun run typecheck`, or the smallest test target). On a fresh worktree failure, diagnose (missed env/bootstrap) before handing over.

### 6. Report

Print the worktree path and branch, `cd $WT`, and anything non-default that happened.

## Cleanup

From the main checkout: `git worktree remove .worktrees/<branch>` (add `--force` if it has untracked build output). Leave worktrees in place until the manager says otherwise.

---
name: pipeline
description: |
  Run one PLAN.md ticket end-to-end through the standard delivery pipeline: isolated worktree off main → verify the premise → implement → background review→fix loop → tests/typecheck → ship (PR when gh is authenticated, pushed branch otherwise) → report to a file. Work-type agnostic; self-contained for cloud sessions. Use when the user or /project says "/pipeline T###", "take T### through the pipeline", or "implement ticket T###". Accepts a ticket key (T### from PLAN.md), optional --draft, and the mode PR_MODE|DIRECT_MODE.
---

# pipeline

The standard delivery pipeline for **one ticket**, as one command. Same steps for a fix, a feature, a refactor, or a chore.

**Ticket model:** a ticket is a `### Ticket: T### <title>` block in the repo-root `PLAN.md`. Its Scope / Acceptance Criteria / Validation Steps are the contract. **Never edit PLAN.md from a worker** — the manager owns it; you report through `.pipeline-report.md`.

## Arguments

```
/pipeline T### [--draft] [PR_MODE|DIRECT_MODE]
```

- `T###` — required. Read the block from PLAN.md.
- `--draft` — PR stays draft (PR_MODE only). Default: draft unless told otherwise.
- Mode — how to ship (see step 7). If not given, detect: `gh auth status && gh pr list --limit 1` → PR_MODE, else DIRECT_MODE.

If a required choice is ambiguous (base other than `main`, draft vs ready), ask once up front — don't guess.

## Standing rules (apply throughout)

- **Agent naming:** prefix any subagent you spawn with its model: `opus:reviewer-T004`, `sonnet:verify-T004`.
- **One ticket = one branch off latest `main` = one merge.** Branch `T###-<kebab-slug>`; PR title (PR_MODE) `T### <ticket title>` — the key prefix is how the manager matches PRs to tickets.
- **Use the repo's own tooling** — `CLAUDE.md` commands and package scripts. Never introduce a different linter/formatter/test runner.
- **Never post comments on GitHub PRs.**
- **Don't trust subagent summaries** — read the actual diff before review and before ship.
- All code work happens in the worktree, never in the main checkout.
- **No new codebase conventions without explicit approval** — no new top-level dirs, committed artifact types, or patterns with no sibling precedent. "No existing pattern" → stop and escalate in the report, don't invent.
- Keep commits scoped to the ticket; commit messages start with `T###`.

## Resume / adopt mode (ticket already has state)

Before the greenfield flow, detect existing work and jump to the matching step — don't recreate what exists:

```bash
TICKET=T###
MAIN="$(git rev-parse --show-toplevel)"
git -C "$MAIN" fetch origin --prune
ls -d "$MAIN"/.worktrees/$TICKET-* 2>/dev/null                         # worktree?
git -C "$MAIN" branch --list "$TICKET-*"; git -C "$MAIN" ls-remote --heads origin "$TICKET-*"   # branch?
git -C "$MAIN" log --oneline main | grep -E "\b$TICKET\b" | head -3     # already merged?
# PR_MODE only — filter titles to the exact key (a search for T14 also matches T140):
gh pr list --search "$TICKET in:title" --state all --json number,title,state,isDraft,url \
  | jq --arg pat "^${TICKET}([^0-9A-Za-z]|\$)" 'map(select(.title | test($pat)))'
```

- **Merged** (merge commit / merged PR) → write the report saying so, do nothing else.
- **PR open** → skip to the review / tests / ship tail (steps 5–8) on the current diff.
- **Commits on the branch, no PR** → check out into a worktree if needed, resume at step 5.
- **Branch exists, no worktree** → `git worktree add "$MAIN/.worktrees/$BRANCH" "$BRANCH"` (no `-b`), bootstrap per `/worktree`, then resume at the step matching its state.
- **Worktree exists** → reuse it; resume implementing or reviewing.
- **Nothing** → greenfield flow below.

## Workflow

### 1. Resolve the ticket

Extract the `### Ticket: T###` block from `PLAN.md` (title, Priority, Scope incl. `Depends on`, Acceptance Criteria, Validation Steps, Notes). If a dependency is not `Done` in PLAN.md, stop and report `blocked: depends on T###`.

### 2. Create the worktree

Invoke **`/worktree T### <title>`** → `.worktrees/T###-<slug>` on branch `T###-<slug>` off `origin/main`, bootstrapped (install, repo-documented build steps). All subsequent steps run **inside that worktree**.

### 3. Verify-before-build gate (premise + mechanism)

Before implementing, validate the assumption that justifies the work — skip entirely for net-new features or pure refactors with no behavioural premise:

- **Signal attribution.** If the ticket fixes an observed problem, reproduce it or trace it to a real code path first.
- **Mechanism efficacy.** If the change relies on a framework's or protocol's runtime semantics (ACP permission flow, hook ordering, git worktree behaviour, Bun workspace resolution), read the real docs/source (`design/spike-findings.md` is a primary source for ACP behaviour) and confirm the lever does what the ticket assumes. Is it necessary, sufficient, aimed at the right target?
- **Target-set validation.** If the ticket hard-codes a list (these files / entities / vendors), verify it against the design doc and the codebase.

If a check fails, **stop and report** — the ticket's scope or approach is wrong; don't build a faithful-but-ineffective change.

### 4. Implement

Make the change in the worktree. Read the real code paths; match surrounding conventions; keep to the ticket's Scope. Design doc sections cited in the ticket are the spec. Commit as you go (`T### <what>`).

### 5. Review → fix loop (background, file handoff)

- Launch a **review subagent in the background** on a different model than yourself when possible. Instruct it to:
  - read the branch diff **locally** (`git diff origin/main...HEAD` in the worktree) — never on GitHub;
  - judge correctness, scope, tests, convention adherence, and **efficacy** — will this achieve the ticket's Acceptance Criteria given how the system actually behaves (a clean diff can still be the wrong lever);
  - check the change against the design doc sections the ticket cites;
  - **write findings to `<worktree>/.pipeline-review.md`** with separate correctness and efficacy verdicts and a one-line PASS/FAIL.
- Read the file. Address every blocker/major finding, re-test, re-review until PASS. Ignore nits unless cheap. An efficacy FAIL is a blocker — stop and report rather than ship it.
- A reviewer may not raise on re-review a finding that was visible in the first pass; if you disagree twice on one finding, record it in the report for the manager instead of looping.

### 6. Tests + typecheck

From the worktree run the repo's own checks (`bun run typecheck`, `bun test`, `bun run build` — whatever `CLAUDE.md`/root scripts define), plus the ticket's **Validation Steps** verbatim. Fix failures before shipping. If the repo defines no tests yet (pre-T001), say so in the report.

### 7. Ship

Invoke **`/ship T###`** from the worktree. It runs pre-push checks, pushes the branch, and:

- **PR_MODE**: opens a PR against `main` titled `T### <title>` with a body from `/pr-description` (draft by default).
- **DIRECT_MODE**: pushes the branch only and prints the merge command for the manager (`git merge --no-ff T###-<slug>`). Do **not** merge to `main` yourself — the manager merges after review + QA.

### 8. Watch CI (PR_MODE, if the repo has CI)

Watch the PR's checks in the background (don't name a shell variable `status`). On failure: read logs, fix in the worktree, re-test, push, re-watch. If the repo has no CI, skip.

### 9. Report

Write `<worktree>/.pipeline-report.md`:

```
ticket: T###
branch: T###-<slug>
worktree: .worktrees/T###-<slug>
mode: PR_MODE|DIRECT_MODE
pr: <url or none>
review: PASS after N rounds  (or FAIL: <why>)
checks: typecheck ok · tests ok (N) · build ok · validation steps ok
status: ready-to-merge | blocked: <reason>
notes: <anything the manager must know: escalations, conventions questioned, follow-ups>
```

Then stop. Summarize in one line to the caller. Leave the worktree in place.

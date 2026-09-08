---
name: project
description: |
  The manager layer over /pipeline. Owns the repo-root PLAN.md for a multi-ticket effort and drives several /pipeline workers (one ticket each) to done — refreshing the board, gating which tickets run now, launching workers in the background (parallel when independent), reshaping tickets as the work evolves, and keeping PLAN.md as the running source of truth. Self-contained: works in a Claude Code cloud session with nothing but this repo. Use when the user says "/project", "start the project", "drive the plan", "pick up where we left off", "resume the project", or "run this autonomously". `--yolo` = no human gates (AI review + QA gate + merge).
---

# project

The **manager** in the orchestration stack. One level up from `/pipeline`:

- **`/pipeline`** is the worker — it takes **one** ticket end-to-end (worktree → verify premise → implement → review→fix → tests → ship → report).
- **`/project`** is the manager — it owns **PLAN.md** and drives **several** workers to done, keeping the plan current and gating decisions with the user (or, in yolo mode, with review + QA).

The point is that **PLAN.md is the running state** so the manager thread stays lean — you don't narrate every step inline, you push state into the plan and commit it.

## Ticket model (no external tracker)

A ticket is a `### Ticket: T### <title>` block in `PLAN.md` (format: `.claude/skills/project-planner/PLAN_TEMPLATE.md`). Its fields are the contract:

- `Status:` — the board. Values: `Todo` · `In Progress` · `In Review` · `Blocked` · `Done` · `Dropped`.
- `Owner:` — `Unassigned`, or the worker label while in flight (e.g. `sonnet:worker-T004`).
- `Scope:` — includes `Depends on T###` lines; the manager derives waves from these.
- `Acceptance Criteria:` / `Validation Steps:` — what review checks and QA runs.
- `Notes:` — the manager appends branch, PR/merge commit, review verdicts, QA verdict, and blockers here.

GitHub issues and PRs are optional. Run this check **once** at the start and remember the result:

```bash
if gh auth status >/dev/null 2>&1 && gh pr list --limit 1 >/dev/null 2>&1; then echo PR_MODE; else echo DIRECT_MODE; fi
```

- **PR_MODE**: workers open PRs titled `T### <title>`; the manager merges them (`gh pr merge --squash --delete-branch`).
- **DIRECT_MODE** (typical in the cloud): workers push their branch; the manager merges locally (`git merge --no-ff T###-<slug>` on `main`) and pushes. Record `merge: <sha>` in the ticket's Notes.

Never post comments on GitHub PRs or issues — the user handles PR communication.

## Arguments / modes

```
/project                 # load ./PLAN.md and resume driving its unfinished tickets (gated)
/project --yolo          # same, autonomous: no launch gates, AI review, QA gate, self-merge
/project close           # verify everything is Done/Dropped, stamp "## Archived <date>" on the PLAN
```

Starting from a doc other than PLAN.md (an RFC, a description) is `/project-planner`'s job — produce a PLAN.md with it first, then run `/project`.

## Yolo mode (`--yolo`)

When the user opts in (flag, or says "run this autonomously / yolo"), record `mode: yolo` at the top of the PLAN's Discovered Issues Log / Decisions log and drive without human gates:

- **No launch gates.** Launch each dependency-unblocked wave as soon as the previous one merges. Parallelize independent tickets.
- **AI review replaces the user's review.** After a worker ships, the manager runs an **independent review of the actual diff** by a reviewer subagent on a *different model* than the worker (worker on sonnet → reviewer on opus, and vice-versa). The reviewer gets the ticket's Acceptance Criteria, judges correctness **and efficacy** (does the change achieve the ticket's goal given how the system actually behaves), and returns blocking findings vs nits. Never skip the review.
- **Review→fix loop until clean.** Blocking findings go back to the same worker (SendMessage) or a fix subagent in the same worktree; re-review. Nits: apply if trivial, else log in Notes.
- **QA gate before every merge (mandatory).** A dedicated QA subagent — not the implementer, not the reviewer — checks out the branch into its own fresh worktree and runs the ticket's Validation Steps and Acceptance Criteria the way a user would, **without reading the diff**. Every finding is fixed and re-QA'd or explicitly accepted by the user; the manager may not waive findings.
- **Self-merge.** Only after review is clean, QA passes, and CI (if any) is green: merge, set `Status: Done`, commit PLAN.md, evaluate what the merge unblocks.
- **Still stop for:** verify-before-build failures, a missing toolchain or credential (e.g. `bun` can't be installed, a vendor login is required), destructive actions outside the repo, and scope changes that add outward-facing surfaces or new conventions not in the approved plan. Report these as `Blocked` tickets and keep the rest moving.
- **Reporting.** A rollup at wave boundaries (merged, review rounds, anything blocked). PLAN.md remains the durable record.

## Naming workers and agents

Prefix every spawned agent's label with its model: `sonnet:worker-T004`, `opus:reviewer-T004`, `sonnet:qa-T004`. Inherited model = the session's model name.

## Standing rules (inherited by every worker — restate them in each worker prompt)

- **One ticket = one branch off latest `main` = one merge.** Branch `T###-<kebab-slug>`, worktree `.worktrees/T###-<kebab-slug>`.
- **Use the repo's own tooling** — `CLAUDE.md` commands, package scripts. Never introduce different tooling.
- **Background workers write deliverables to files, not chat** — a worker's review lands in `<worktree>/.pipeline-review.md`, its final report in `<worktree>/.pipeline-report.md`. The manager reads files and git, not worker chatter.
- **Verify-before-build** for any ticket premised on an observed problem: attribute the signal to a real cause before implementing.
- **Don't trust subagent summaries** — read the diff (`git diff main...T###-<slug> --stat` and the diff itself) before review and before merge.
- **No new codebase conventions without the user's explicit live approval** — no new top-level dirs, committed artifact types, or patterns with no sibling precedent. A ticket proposing one is not approval. A worker finding "no existing pattern" stops and escalates.
- **Only the manager edits PLAN.md.** Workers never touch it (avoids merge conflicts across worktrees).

## Drive loop

### 1. Load the PLAN

Read `./PLAN.md`. If it doesn't exist, tell the user to write one with `/project-planner` and stop. Run the PR_MODE/DIRECT_MODE check. Make sure the toolchain in `CLAUDE.md` is present (`bun --version`); install per CLAUDE.md if not, and stop with a clear message if that fails.

### 2. Refresh the board

The board is computed from PLAN.md plus git — no scripts, no network needed:

```bash
git fetch origin --prune
git branch -r | grep -E 'origin/T[0-9]{3}-'          # branches with work
git log --oneline main | grep -oE '^[a-f0-9]+ .*T[0-9]{3}' # merged tickets (merge/squash commits carry the key)
ls .worktrees 2>/dev/null
# PR_MODE only:
gh pr list --state all --json number,title,state,isDraft,url | jq '[.[] | select(.title | test("^T[0-9]{3}"))]'
```

Reconcile against each ticket's `Status:` — a ticket whose branch was merged is `Done`, a ticket with a branch but no merge is `In Progress`/`In Review`, and fix any drift in PLAN.md. Print a compact board: `T### | Status | Owner | branch | PR/merge | blockers`.

### 3. GATE — confirm what to drive now (skipped in yolo)

Present the Goal, the board, what's done / in flight / not started, and a proposed set of tickets to drive **now** with their order (the next dependency wave: every `Todo` ticket whose `Depends on` tickets are `Done`). Wait for the user to confirm. One-word approvals are fine. If a ship choice is ambiguous, ask once — don't guess.

### 4. Launch a /pipeline worker per approved ticket (background, parallel)

For each ticket in the wave:

- Set `Status: In Progress` and `Owner: <label>` in PLAN.md, commit (`chore(plan): T### in progress`) and push to `main`.
- Launch a background subagent (Agent tool, `run_in_background: true`) whose prompt is: read `.claude/skills/pipeline/SKILL.md` and run it for `T###` with the ticket block pasted in, the standing rules above, the PR/DIRECT mode, and the instruction to write `.pipeline-report.md` and stop. Use `/pipeline`'s resume/adopt behaviour so an in-flight ticket continues rather than restarts.
- Independent tickets run in parallel (separate worktrees). Never launch a dependent ticket before its prerequisite is merged.

### 5. Keep PLAN.md current

As workers finish (they ping idle; read `<worktree>/.pipeline-report.md`):

- Move the ticket through `In Review` → (review, QA) → `Done`, or to `Blocked` with the reason in Notes.
- After **every** status change: commit PLAN.md on `main` (`chore(plan): T### <status>`) and push. In a cloud session this is the only thing that survives the session, so never batch these.
- Append to the **Discovered Issues Log** whenever something material happens: a dropped ticket, a revert, a discovered dependency, a verify-before-build finding, a scope change, a review/QA verdict worth remembering, a toolchain fallback. Reversals do not propagate on their own — log them as they happen.
- **Evolve the ticket set.** Discovered work → add a new `### Ticket: T###` block (next free number) with deps; too big → split into children and mark the parent `Dropped` pointing at them; wrong → `Dropped` with the why. Ticket edits that change outward-facing scope gate with the user (except in yolo, where they're logged and the ticket is `Blocked` if it adds a surface not in the plan).

### 6. GATE / surface exceptions

Surface — never blind-merge or silently route around: ambiguous merge order, CI failures a worker can't resolve, review blockers a worker can't address, verify-before-build failures, a worker that needs a credential or a tool the container doesn't have. Keep escalations short: ticket, the fork, a recommendation.

### 7. Report / wrap up

When the approved set is at its agreed state: a terse rollup — per ticket final state, branch/PR/merge, anything reverted or dropped and why, what's next in the backlog. Leave worktrees in place unless asked. PLAN.md is the durable record.

## `close`

Verify every ticket is `Done` or `Dropped` (refuse and list the rest otherwise; `--force` overrides and lists what it overrode). Append `## Archived <YYYY-MM-DD>` to PLAN.md, commit, push.

## Anti-patterns (learned the hard way)

- Don't re-type the pipeline by hand — drive `/pipeline`.
- Don't let the plan live only in chat — it goes in PLAN.md, committed.
- Don't endorse a "this helps" ticket before its premise is verified.
- Don't blind-merge or auto-launch the whole scope outside yolo — gate the wave.
- Don't foreground substantive workers and then interrupt them to ask what's running — background them and read files.

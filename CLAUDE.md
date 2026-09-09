# CLAUDE.md

Agile Agents — a multi-agent coding orchestrator modeled on an Agile engineering team (EM, architect + oracle, engineers, adversarial review, QA), built as a TypeScript daemon that runs vendor coding agents over ACP. This file is the repo guide for Claude Code sessions, local or cloud.

## Source of truth

- `PLAN.md` — the implementation plan **and the live board**. Every ticket is a `### Ticket: T###` block; its `Status:` line is the ticket's state. Read it first.
- `design/agile-agents-design.md` — the design (state model §4, bus §5, enforcement tiers §6, tools §7, protocols §9–16, UI §17, build decisions §18). When code and design disagree, the design wins unless the PLAN's Decisions log says otherwise.
- `design/spike-findings.md` — measured per-vendor behaviour (what ACP actually gates, hooks, cancel/resume, Pi). Don't re-derive these; cite them.
- `vendor/terma/` — read-only snapshot of Terma's ACP layer, the input to T003. Never import from it at runtime; extract into `packages/acp-client` and adapt.
- `spike/` — the vendor spike harness (`permission-matrix.ts`) and raw reports. Reusable for T009/T014 checks.

## Orchestration

Drive the plan with `/project` (manager) which launches `/pipeline` workers (one ticket each). `/project --yolo` runs without human gates: AI review + QA gate + merge. Nothing in the loop depends on the host machine — no dashboards, heartbeats, or home-dir scripts. The board is `PLAN.md`; the manager commits it to `main` after every state change so progress survives the session.

## Commands

Bun **1.3.11 or newer** is required (CI pins 1.3.11; verified on 1.4.2). Older Bun ignores `pathIgnorePatterns` in `bunfig.toml`, so `vendor/` and `dist/` run as tests and hundreds of tests fail — `bun upgrade` first if `bun --version` is older.

Until T001 lands there is no code. After it:

```bash
bun install
bun run build        # all workspaces
bun run typecheck
bun test             # plain bun test, no native modules — must stay green
bun run test:integration   # flagged; needs a real vendor login, not for cloud
```

If `bun` is missing in a fresh container: `curl -fsSL https://bun.sh/install | bash` (then `export PATH="$HOME/.bun/bin:$PATH"`), or `npm i -g bun`. If neither works, note it in the PLAN Discovered Issues log and stop — do not swap the toolchain.

## Layout (target)

```
packages/shared      zod schemas + types, defined once, imported everywhere
packages/acp-client  ACP session client lifted from vendor/terma (T003)
packages/daemon      agiled: state store, bus, halts/ripple, gates, agent runner, worktrees, hook endpoint, MCP tools, feed
packages/cli         agile: init · run · status · tail · send · approve · halt · hook <event>
packages/ui          v0: static feed.html
fixtures/demo-project  seeded repo for the e2e run
```

## Conventions

- TypeScript, Bun workspaces, ESM. Schemas live in `packages/shared` and nowhere else.
- `.agile/` state is plain YAML/JSONL/Markdown, written only through the daemon's validating store.
- Hooks are the enforcement layer, prompts are the intent layer. A gate that is only a sentence in a role brief is a bug.
- Signal over volume at every boundary: message bodies capped, tool output distilled, raw output to files with pointers.
- No vendor credentials in the daemon. Adapters spawn the vendor harness with the user's own login.
- Use the repo's own scripts for lint/typecheck/test. Never introduce a second toolchain.
- **No new codebase conventions without explicit approval** — no new top-level dirs, artifact types, or patterns without a sibling precedent. A ticket proposing one is not approval; stop and escalate.
- One ticket = one branch (`T###-<slug>`) off latest `main` = one merge. Worktrees live under `.worktrees/` (gitignored).
- Don't trust subagent summaries; verify the diff.

## v0 defaults for the PLAN's open questions

Use these unless the PLAN's Decisions log says otherwise; log the choice when a ticket relies on it.

- Name: keep `agile` / `agiled` / `.agile/`. Rename is a later mechanical ticket.
- Reviewers read the engineer's worktree through tools under a read-only permission policy; QA gets a fresh clone. Revisit in T016 only if the policy can't make that safe.
- Architect planning turn: try Claude `plan` mode first (T014). If plan mode blocks the architect's MCP writes, run `default` mode with a daemon-side `approve_plan` gate.
- Ledger: ACP `usage_update` when present, ledger countdown otherwise.
- Tunables (initial): heartbeat 30 s, liveness timeout 5 min, quorum timeout 10 min, message body cap 800 chars, tool cache TTL = sprint, quota floor 0.15, max review rounds 3, max_attempts 2.

## Cloud sessions

The repo is self-contained for a Claude Code cloud session. `gh` may or may not be authenticated there: the skills check `gh auth status` once and fall back to branch-and-merge without PRs. Vendor logins (Claude Max etc.) are not available in the cloud, so integration tests that spawn a real vendor session are skipped there; unit tests must not need them.

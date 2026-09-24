# CLAUDE.md

Agile Agents is a single-operator cockpit for coding agents. One long-lived daemon (`agiled`) holds all state in one home directory. Work is organised as **streams** (a tree of goals, each with a thread, a branch and a worktree). Vendor coding agents (Claude Code, Gemini, Cursor, …) are attached to a stream over ACP as workers or read-only reviewers. **Rules** (pattern, classifier, guidance) are enforced by hooks. The human answers an **inbox** and lands streams. This file is the repo guide for Claude Code sessions, local or cloud.

## Source of truth

- `PLAN.md`: the plan **and the live board**. Every ticket is a `### Ticket: T###` block, and its `Status:` line is the ticket's state. The Decisions log (D1–D30) overrides the design. Read it first.
- `design/projects-design.md`: **the current design for Phases 7–13** (projects, one node kind with derived roles, per-repo delivery, routed events, knowledge items, coordination, the Director, tracker links). Where it differs from `cockpit-design.md`, it wins. Its §19 lists proposed decisions (P1–P20) that are open until confirmed as D-entries.
- `design/cockpit-design.md`: the design (streams §2, inbox §3, agents §4, rules §5, classifier §6, state home §7, hook and landing paths §8, UI §9, deletions §10). When code and design disagree, the design wins unless the Decisions log says otherwise.
- `design/agile-agents-design.md`: superseded. Only its **§8 adapter contract** and **§6 hook catalog** are still valid.
- `design/spike-findings.md`: measured per-vendor behaviour (what ACP gates, hooks, cancel/resume, Pi). Cite it; don't re-derive it.
- `LIVE-CHECKLIST.md`: the manual end-to-end walkthrough against a real vendor login.
- `vendor/terma/`: a read-only snapshot of Terma's ACP layer. Never import it at runtime.
- `spike/`: the vendor spike harness (`permission-matrix.ts`) and raw reports.

## Orchestration

Drive the plan with `/project` (manager), which launches `/pipeline` workers (one ticket each). `/project --yolo` runs with no human gates: AI review, then a QA gate, then merge. The board is `PLAN.md`. The manager commits it after every state change.

## Layout

```
packages/shared      zod schemas + types (stream, rule, session defaults, ids, …), defined once
packages/acp-client  ACP session client and vendor providers (lifted from vendor/terma)
packages/daemon      agiled: store, streams, attach/runner, worktrees, hook + permissions, knowledge,
                     classifier, landing, inbox/questions/gates, docs, MCP tools, HTTP + cockpit (feed/)
packages/cli         agile: init · daemon · repo · stream · knowledge · attach · review · detach · land ·
                     status · tail · inbox · answer · question · gate · hook · mcp  (`agile` with no args prints usage)
packages/ui          the cockpit (React + Vite, app/), served by the daemon
fixtures/demo-project  seeded repo for the e2e runs
```

State lives in the home (`$AGILE_HOME`, default `~/.agile/`): `config.yaml`, `repos.yaml`, `streams/`, `threads/`, `rules/`, `log/agiled.log`, `log/events.jsonl`, `sessions/<id>/stderr.log`. Worktrees are `<repo>/.worktrees/<stream-id>-<slug>` on `stream/…` branches.

## Commands

You need Bun **1.3.11 or newer**. CI pins 1.3.11. Older Bun ignores `pathIgnorePatterns`, so `vendor/` and `dist/` run as tests and fail. If `bun` is missing: `curl -fsSL https://bun.sh/install | bash` or `npm i -g bun`. If neither works, log it in the PLAN Discovered Issues and stop. Don't swap the toolchain.

```bash
bun install
bun run build              # all workspaces (the UI build is what the daemon serves)
bun run typecheck
bun run lint               # biome check .
bun test                   # offline unit tests: no vendor, no network. Must stay green
bun test packages/daemon/src/knowledge    # one area
bun run test:integration   # offline end-to-end: real daemon, real browser, no vendor. CI runs it
bun run test:e2e           # the Playwright cockpit tests alone (rebuild first)
bun run test:live          # AGILE_LIVE=1, manual only, never in CI
```

- `test:integration` forces `AGILE_LIVE=` empty and never spawns a vendor.
- `test:live` currently runs only `packages/daemon/src/sandbox/live.test.ts`, which is a placeholder. The real live check is `LIVE-CHECKLIST.md`.
- Don't run `test:e2e` at the same time as a full `bun test`. Both need port and CPU headroom.
- The Playwright tests need a Chromium and **fail loudly** without one. Get it with `bunx playwright-core install chromium` or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.

## Conventions

- TypeScript, Bun workspaces, ESM. Schemas live in `packages/shared` and nowhere else, all `.strict()`.
- State in the home is plain YAML/JSONL/Markdown and is written **only through the daemon's validating store**. A corrupt file is refused with path and line, never defaulted.
- Hooks are the enforcement layer, prompts are the intent layer. A gate that is only a sentence in a brief is a bug.
- HTTP write routes check `isSameOriginRequest` (403 otherwise) and record the actor as `human`. The stream record's `agent.*`/`human.*` two-writer split is enforced by the store.
- Signal over volume at every boundary: bodies capped, tool output distilled, raw output to files with pointers.
- No vendor credentials in the daemon. Adapters spawn the vendor harness with the user's own login. The TypeSafe classifier key is the one written exception (design §6.1).
- Use the repo's own scripts for lint, typecheck and test. Never introduce a second toolchain.
- **No new codebase conventions without explicit approval.** That means no new top-level dirs, artifact types or patterns without a sibling precedent. A ticket that proposes one is not approval: stop and escalate.
- One ticket = one branch (`T###-<slug>`) off the latest integration branch = one merge. From Phase 7 the integration branches are stacked (D30): `claude/phase-7`, then `claude/phase-8` off it, and so on. A ticket branches from its phase's branch. Pete reviews and lands the phases in order. A fix to an earlier phase is made there and merged forward into every later phase branch. Worktrees go under `.worktrees/` (gitignored).
- Don't trust subagent summaries. Verify the diff.

## Classifier key (D16)

A TypeSafe key may be present in the cloud environment (`TYPESAFE_API_KEY`), or in the home `config.yaml` as `classifier.api_key`, or set from the cockpit Settings screen.

- Agent work (workers, reviewers, QA) may make real classifier (Jev) calls, and should prefer them over `FakeClassifier` when checking classifier behaviour. `agile rules test` is the easy way.
- Unit tests stay offline and use `FakeClassifier`.
- The key is never printed, logged, committed or sent to the browser. Never list or dump environment variables. `agile daemon status` says only whether a key is loaded and where it came from.

## Session defaults (D17)

The vendor, model and effort for a new session resolve in this order:

1. the attach/review flag, or the cockpit picker
2. the repo's entry in `repos.yaml`
3. the global default in the home `config.yaml`
4. the built-in `claude` / `claude-opus-5-5` / `low`

The global and per-repo defaults are editable in Settings. `agile daemon status` prints the resolved default.

## Cloud sessions

The repo is self-contained for a cloud session. `gh` may not be authenticated there: the skills check `gh auth status` once and fall back to branch-and-merge without PRs. There are no vendor logins in the cloud, so `test:live` and `AGILE_LIVE=1` stay off, and nothing in `bun test`, `test:integration` or `test:e2e` may need a vendor.

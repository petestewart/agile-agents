# Reshape plan — from an Agile-team simulation to an operator's cockpit

Status: proposed 2026-09-19. Supersedes the direction of `PLAN.md` §7 tickets T001–T051 once accepted; those tickets stay as history. Ticket numbers here start at T100 so the `/project` and `/pipeline` skills work unchanged if this file replaces `PLAN.md`.

## 1. Overview

One person manages several work streams all day: a software project with tickets being worked by coding agents in parallel, one or two customer issues under investigation, one or two feature-planning threads, and a steady flow of questions from support and from above. The tool's job is to hold context per stream, say what needs the human right now, and let them hand chunks of work to agents without losing the thread.

The current codebase models an engineering organisation instead (EM, architect, oracle, reviewer, QA, sprints, standups, retros, pointing, quorum, halts, quota handoff). Two motivations behind the sprint machinery are real and are kept: the system learns from its own work, and decisions made once are obeyed on future work. Everything else in the simulation goes.

Target shape, in one paragraph: a **stream** is the unit (goal, status, parent, thread, attached agent sessions, optional repo and worktree). One persistent daemon serves every stream across every repo. A single **inbox** lists what needs the human. **Agents** are attachments to a stream: a worker in a worktree, a reviewer on demand; the human is the manager. **Rules** are small scoped records that agents propose and only the human accepts, enforced in three tiers: pattern hook, classifier hook (TypeSafe Jev), guidance in the brief. Lessons are proposed when a stream closes. Landing on main is a button.

## 2. Decisions already taken (2026-09-19, Pete)

- D1. Streams replace sprints, tickets, epics, and teams as the unit of work. Streams nest.
- D2. No simulated manager: the resident EM, the EM delegate, and every ceremony (sprint review, retro, standup, refinement, pointing, quorum) are deleted. Deleted code is remembered by git, not kept "just in case".
- D3. Roles collapse to worker and reviewer. Architect, oracle, reader, QA roles are deleted; their useful brief text folds into the worker brief or into rules.
- D4. Rules have scope (global / repo / stream), status (proposed / accepted / retired), provenance, enforcement tier (pattern / classifier / guidance), and example actions. Agents propose; only the human accepts.
- D5. The classifier tier uses TypeSafe Jev over its hosted API, behind an interface with a fake for tests. The daemon holds the `TYPESAFE_API_KEY`; this is an approved exception to "no vendor credentials in the daemon".
- D6. Classifier answers fall into three bands: deny, allow, or route to the human inbox. Low confidence routes to the human.
- D7. Agents may `git push` by default. A `no_push` rule exists, off by default.
- D8. Pushing to (or merging into) a protected branch is prohibited by default. Protected branches default to `main` and `master`, configurable per repo.
- D9. The tool is not a per-repo process. One long-lived daemon, state in one home directory, worktrees inside each repo.
- D10. Build process for the reshape: short tickets; one reviewer on close; QA only at phase boundaries; Pete looks at the UI after every UI ticket. No `--yolo` runs longer than one phase without a human look.
- D11. KiroCrew is not adopted. Borrowed as designs only: hardened worktree creation, the push detector that cannot be dodged by spelling, agent-owned vs human-owned ledger fields, a fail-closed credential scrub before the external classifier, mechanical scope filtering of injected rules, an append-only log.

## 3. Non-goals for the reshape

- Multi-user, teams, or any notion of more than one human.
- Jira / Linear / GitHub Issues sync. Shelved (code kept on a branch, not in `main`) until a stream needs it.
- Quota-aware routing, vendor barometer, cross-vendor handoff, halts and ripple.
- Any new vendor adapter. Existing ACP providers stay; no Gemini until an account exists.
- Embeddings, semantic search, or a knowledge base beyond plain docs attached to a repo or stream.
- OS sandboxing.

## 4. Constraints (unchanged from `PLAN.md` §4 unless listed)

- Schemas live only in `packages/shared`, `.strict()`. All state writes go through the validating store.
- Hooks are the enforcement layer; prompts are the intent layer. A rule marked `pattern` or `classifier` must have a hook check, and a test asserts it.
- Plain files: YAML for records, JSONL for logs, Markdown for docs. Inspectable and hand-editable; the store validates on read and refuses corrupt files with the path and line.
- Tests run under plain `bun test`, no native modules, no vendor login. Live checks are manual and listed in each ticket's Notes.
- No new top-level dirs or artifact types beyond those this plan names.
- Every commit carries the session trailers; the manager merges `--no-ff`; PLAN state is pushed after every change.

## 5. Target architecture

```
packages/
  shared/      zod: Stream, Thread entry, Session, Question, Rule, RuleExample, Event, Policy, Vendors  (Ticket/Sprint/Halt/Stanza/Message/Quota/Review/Qa/Oracle removed)
  acp-client/  unchanged
  daemon/      agiled: store · streams · inbox (questions + gates) · runner (worker, reviewer) · worktrees · hook (decide → pattern → classifier) · rules · lessons · landing · feed (http + ws)
  cli/         agile: daemon · stream · attach · ask · answer · land · rules · hook <event> · status · tail
  ui/          cockpit: Inbox · Stream tree · Stream page (thread, sessions, diff, rules in scope) · Rules · Settings
```

State home (`~/.agile/` by default, `AGILE_HOME` overrides; tests use a temp dir):

```
~/.agile/
  config.yaml            vendors, classifier settings, protected-branch defaults
  repos.yaml             registered repos: path, protected branches, default vendor
  streams/<id>.yaml      the stream record (agent-owned and human-owned fields, see T110)
  threads/<id>.jsonl     append-only thread per stream: human lines, agent lines, questions, answers, events
  rules/<id>.yaml        rule records
  log/events.jsonl       append-only, every state change
  sessions/<id>/         per-session stderr, transcripts, tool output files
```

Per repo: `<repo>/.worktrees/<stream-id>-<slug>/` (gitignored), one branch per coding stream. The orphan `agile-state` branch and the `.agile/` worktree inside repos are gone.

Hook path per tool call: vendor PreToolUse → `agile hook` → daemon `hook/decide.ts` → (1) deterministic pattern rules in scope (fail closed) → (2) classifier rules in scope, one Jev call, N questions → band → allow / deny with the rule named / route to inbox and block until answered.

Landing path per stream: human presses Land → daemon runs diff-level rules (classifier, whole diff as state) → merges the stream branch into its target (default: integration branch if the repo has one, else main) → the stream closes → lessons are proposed.

## 6. Definition of done for the reshape

- `bun install && bun run build && bun run typecheck && bun test && bun run test:integration && bun run test:e2e` green from a clean clone, no vendor login.
- Daemon source under 18,000 lines (today 35,928). Tests may be any size.
- Pete can, from a fresh machine with Claude Code logged in: start the daemon, register `~/Projects/ledger-lite`, open a coding stream with three sub-streams, attach a worker to each, answer their questions from the inbox, review one, land all three, accept two proposed rules, and see one of them deny a tool call on the next stream. The whole walkthrough is `LIVE-CHECKLIST.md`, rewritten.
- Every ceremony file, role brief, and schema named in §8 "Deleted" is gone from `main`.

## 7. Phases and tickets

Build order: Phase 0 → 1 → 2 → 3 → 4 → 5 → 6. Within a phase, tickets marked ∥ may run in parallel. Phase 4 must finish before Phase 5 starts (rules must exist before anything enforces them). Phase 6 tickets each end with Pete looking at the result.

### Phase 0 — Freeze and re-baseline

### Ticket: T100 Land `claude/control-room-v2` and freeze the old plan
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** Pete lands `claude/control-room-v2` into `main` by PR (T039–T051). Then: `PLAN.md` §7 gets a banner "frozen 2026-09-19, see `design/reshape-plan.md`"; no new T0xx tickets. The `/project` skill's "board" becomes this file (rename to `PLAN.md` and move the old one to `PLAN-v1.md` in the same commit).
- **Acceptance Criteria:** `main` contains the v2 control room; `PLAN.md` is this document with the old plan preserved as `PLAN-v1.md`; `/project` reads the new board.
- **Validation Steps:** `grep -c '^### Ticket: T1' PLAN.md` ≥ 30; skills' PLAN grep still matches.
- **Notes:** Manual, Pete. Nothing else in this plan starts before this lands.

### Ticket: T101 Rewrite the design doc around streams, rules, and the classifier tier
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** New `design/cockpit-design.md`: §1 problem and operator journey (the three stream types and the question flow), §2 stream model and the two-writer field split, §3 inbox, §4 agents as attachments (worker, reviewer, gates), §5 rules (record, tiers, bands, lessons, pruning), §6 classifier (Jev call shape, thresholds, fail policy, scrub, opt-out), §7 state home and file formats, §8 hook path and landing path, §9 UI (inbox, tree, stream page), §10 what was deleted and why. `design/agile-agents-design.md` gets a top banner "superseded by cockpit-design.md; kept for §8 adapter contract and §6 hook catalog, which remain valid".
- **Acceptance Criteria:** Every decision D1–D11 appears in the new design with its rationale. `CLAUDE.md` "Source of truth" points at the new design.
- **Validation Steps:** Review by Pete; no code.
- **Notes:** Do not fold the Jev material into the old doc; write the new one.

### Phase 1 — One persistent daemon, many roots

### Ticket: T110 Stream and Thread schemas
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** `packages/shared/src/stream.ts`: `Stream` = `{ id, title, goal, parent?, repo?, branch?, worktree?, target_branch?, created_at, agent: { status: 'idle'|'working'|'blocked'|'question'|'done', progress?, findings?, proposed_next?, updated_at }, human: { status: 'open'|'waiting_on_you'|'landed'|'closed', decision?, answered_at?, note? }, sessions: SessionRef[] }`. Two sub-objects, `agent` and `human`, are the two-writer split (D11): the store rejects an agent principal writing `human.*` and a human principal writing `agent.*`. `Thread entry` = `{ ts, by: 'human'|'agent:<id>'|'daemon', kind: 'line'|'question'|'answer'|'event'|'finding'|'proposal', body (capped), ref? }`. `SessionRef` = `{ id, vendor, model, role: 'worker'|'reviewer', status, worktree? }`. Remove `Ticket`, `Sprint`, `Stanza`, `Message`, `Halt`, `Quota`, `Review`, `Qa`, `Oracle`, `Kb` schemas in the same ticket only if nothing still imports them; otherwise mark `@deprecated` and delete in T125.
- **Acceptance Criteria:** Unit tests for the principal check on both directions; nesting depth unlimited but a cycle is rejected; `.strict()` on all.
- **Validation Steps:** `bun test packages/shared`.
- **Notes:** Numbering stays ULID-based (`ids.ts`).

### Ticket: T111 State home and the repo registry
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** The store (`daemon/src/store`) opens `AGILE_HOME` (default `~/.agile/`) instead of a repo's `.agile/` worktree. `repos.yaml` registers repos (`path`, `protected_branches` default `[main, master]`, `target_branch?`, `vendor?`). `agile repo add <path>` / `agile repo list`. Drop the orphan-branch machinery in `store/git.ts` and `init.ts`'s worktree setup; `agile init` becomes "create the home if missing". Events log moves to the home.
- **Acceptance Criteria:** A daemon started with a temp `AGILE_HOME` serves two registered repos; no `.agile/` directory is created inside a repo; the old `agile-state` code paths are deleted, not flagged off.
- **Validation Steps:** `bun test packages/daemon/src/store packages/cli`; integration test that registers two temp repos.
- **Notes:** Migration from an existing `.agile/` worktree is out of scope; ledger-lite gets reset (recipe in LIVE-CHECKLIST).

### Ticket: T112 Long-lived `agiled` and thin CLI
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** `agile daemon start|stop|status` runs the daemon detached with a pidfile and a port in `config.yaml`; it never exits because work finished. `agile run` is deleted; its `advancePipeline` glue is replaced by per-stream drivers in Phase 3. `agile status`, `agile tail` talk to the daemon over the existing RPC. The control room is served at `/` (the `/control-room` path stays as a redirect).
- **Acceptance Criteria:** Daemon survives the last stream closing; `agile status` works with no repo cwd; a second `start` is a no-op with the pid printed.
- **Validation Steps:** `bun run test:integration` (daemon lifecycle test); manual: start, close the terminal, open the URL.
- **Notes:** Delete `cli/src/commands/run.ts` and `runner/pipeline-glue.ts` here; do not port the glue.

### Ticket: T113 ∥ Hardened worktree creation
- **Priority:** P1
- **Status:** Todo
- **Owner:** —
- **Scope:** `runner/worktrees.ts`: create via git plumbing with no shell, `core.hooksPath` pointed at an empty dir for the checkout, refuse repos with filter drivers configured, claim the branch atomically (`git update-ref` with the expected-old-value form), fail if the branch already exists anywhere. Worktree path `<repo>/.worktrees/<stream-id>-<slug>`, ensured in `.gitignore`.
- **Acceptance Criteria:** Two concurrent creates for the same stream: exactly one succeeds. A repo with a `.gitattributes` filter is refused with a reason.
- **Validation Steps:** `bun test packages/daemon/src/runner/worktrees.test.ts`.
- **Notes:** Design borrowed from KiroCrew's worktree handler (D11).

### Phase 2 — Streams replace sprints and tickets

### Ticket: T120 Stream service and RPC
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** `daemon/src/streams/`: create, get, list (tree), update with principal, close, archive; thread append and read (paged); events for every change. RPC methods and `agile stream new|list|show|close`. A stream with `repo` gets a branch and worktree on first attach (T130), not on create.
- **Acceptance Criteria:** A stream without a repo is fully usable (thread, questions) and never touches git. Tree listing returns parent/child structure. Principal checks from T110 are exercised end to end.
- **Validation Steps:** `bun test packages/daemon/src/streams packages/cli`.
- **Notes:** —

### Ticket: T121 Inbox: questions and gates re-keyed to streams
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** `questions/` and `gates/` keep their services but every request carries `stream` instead of `ticket`/`sprint`. One `inbox` RPC returns everything waiting on the human across all streams, sorted oldest first, each item with the stream path and a one-line context. Answering a question writes the answer to the thread and unblocks the waiting session (existing `deliverNote`/`waitingAgent` path). Gate kinds shrink to `land`, `rule_accept`, `classifier_review`; every other gate kind (`approve_plan`, `sprint_review`, `unblock`, `promote_to_main`, …) is deleted with its policy rows.
- **Acceptance Criteria:** An agent question on a stream with no repo shows in the inbox and the answer reaches the session. Stale mail from a previous daemon run cannot appear as a question (questions are records with status, not bus mail; the bus drain at start is gone).
- **Validation Steps:** `bun test packages/daemon/src/questions packages/daemon/src/gates`; e2e: inbox card appears without reload (`hil_requested` trigger from T050 stays).
- **Notes:** This fixes the 2026-09-11 stale-question defect from the live run at the root.

### Ticket: T122 Delete the ceremony and role layer
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** Delete `daemon/src/em/` (resident, delegate, chat, review, report), `daemon/src/architect/`, `daemon/src/oracle/`, `daemon/src/qa/`, `daemon/src/halts/`, `daemon/src/quota/`, `daemon/src/handoff/`, `daemon/src/pi/` (unless a provider still needs it), `daemon/src/plan/`, `daemon/src/review/` (the round-tracking part; the reviewer role is rebuilt in T131), `daemon/src/merge/` sprint parts, `briefs/{em,architect,qa,reader,refinement,retro,sprint-review,standup}.md`, `feed/stories.ts`, `runs/` writer. Delete `cli` commands `send`, `halt`, `approve` (replaced by `answer` and `land`). Delete the `bus` except the part the thread needs, or delete it entirely if T120's thread covers it. Delete the `Sprints`, `Tickets`, `Policy`, `Questions` panes and the `sprint/` and `review/` UI directories; the UI is rebuilt in Phase 6, so the app may be visually broken between T122 and T160 on the integration branch (never on `main`).
- **Acceptance Criteria:** `bun test` and typecheck green; daemon source line count reported in the ticket Notes; no import of a deleted module remains; `grep -ri sprint packages/daemon/src | wc -l` is 0.
- **Validation Steps:** the three suites; `cloc`-style count via `find … | xargs wc -l`.
- **Notes:** The largest single deletion in the plan. Do it in one ticket so nothing half-alive survives.

### Ticket: T123 ∥ Events and the append-only log
- **Priority:** P1
- **Status:** Todo
- **Owner:** —
- **Scope:** `Event` kinds reduced to stream/thread/session/question/gate/rule/hook/land events. `log/events.jsonl` in the home, append-only, one writer, fsync on gate and land events. `agile tail` filters by stream.
- **Acceptance Criteria:** Every state change in T120–T122 emits an event; a reconstruct test rebuilds stream statuses from the log alone.
- **Validation Steps:** `bun test packages/daemon/src/store/events.test.ts`.
- **Notes:** —

### Ticket: T124 Phase 2 QA and Pete's look
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** Black-box QA of streams, inbox, and thread via the CLI and RPC against a real daemon with the fake ACP transport; then Pete drives `agile stream` and `agile answer` by hand on a scratch repo. Findings become tickets T125+.
- **Acceptance Criteria:** QA ACCEPT; Pete's list recorded.
- **Validation Steps:** —
- **Notes:** —

### Phase 3 — Agents as attachments

### Ticket: T130 Worker attach and the stream driver
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** `agile attach <stream> [--vendor] [--model] [--role worker]` and the RPC behind it. The daemon creates the branch and worktree (T113) if the stream has a repo, assembles the brief (T133), spawns the ACP session, streams its output to the thread, routes `ask` to the inbox, and updates `agent.*` on the stream. Session lifecycle in `runner/session.ts` is reused; the runner's ticket assumptions are removed. A stream may have one live worker at a time.
- **Acceptance Criteria:** Attach on a no-repo stream works (a planning conversation); attach on a repo stream produces a worktree and the session's cwd is that worktree; the session's exit writes `agent.status: done` and a thread entry.
- **Validation Steps:** integration test with the fake agent; e2e: thread streams in the UI.
- **Notes:** The MCP verbs an agent gets shrink to: `ask`, `progress`, `finding`, `propose_rule`, `propose_next`, `read_stream`, `search_docs`, `test_run`. Everything else in `tools/builtins.ts` is deleted.

### Ticket: T131 Reviewer on demand
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** `agile review <stream>` / a Review button spawns a reviewer session (read-only permission policy, worktree as cwd) with `briefs/reviewer.md`; its findings go to the thread as `finding` entries and to `agent.findings` as structured items `{ severity, file, line?, text }`. Findings are input to lessons (T141). Optional auto-review on `agent.status: done` per repo setting.
- **Acceptance Criteria:** A reviewer cannot write in the worktree (hook deny proven by test); findings appear on the stream page.
- **Validation Steps:** `bun test packages/daemon/src/runner`; e2e.
- **Notes:** Review rounds, max rounds, and PASS/FAIL verdict states are gone; the human reads findings and decides.

### Ticket: T132 Landing
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** `agile land <stream>` / Land button: raises a `land` gate if the repo policy asks for one (default: no gate, the button is the decision), runs diff-level rules (T152, no-op until then), merges the stream branch `--no-ff` into `target_branch` (default from `repos.yaml`, else the repo's default branch), closes the stream (`human.status: landed`), removes the worktree, keeps the branch. If the stream has a parent with a repo, landing a child merges into the parent's branch instead.
- **Acceptance Criteria:** Conflict on merge: stream goes `agent.status: blocked` with the conflict files in the thread and the worktree kept; no partial merge. Child-into-parent path tested.
- **Validation Steps:** `bun test packages/daemon/src/merge` (renamed `landing`).
- **Notes:** —

### Ticket: T133 ∥ Brief assembly
- **Priority:** P1
- **Status:** Todo
- **Owner:** —
- **Scope:** `runner/brief.ts` builds a session's first turn from: `briefs/worker.md` or `reviewer.md`, the stream goal and ancestors' goals, the last N thread entries, repo docs (T134), and accepted rules in scope (T140; empty until then). Token ceiling test kept. Fold the useful architect/oracle/QA brief text into `worker.md`.
- **Acceptance Criteria:** Snapshot tests for both briefs; the ceiling test; a rule out of scope never appears.
- **Validation Steps:** `bun test packages/daemon/src/runner/brief.test.ts packages/daemon/src/briefs`.
- **Notes:** —

### Ticket: T134 ∥ Docs per repo and per stream
- **Priority:** P2
- **Status:** Todo
- **Owner:** —
- **Scope:** Replace `oracle/` and `kb/` with plain Markdown docs: `<repo>/.agile-docs/*.md` (tracked in the repo, the old oracle brief moves here) and `~/.agile/streams/<id>.docs/*.md`. `search_docs` verb does a plain text search. The UI Brief/Knowledge panes become one Docs pane in Phase 6.
- **Acceptance Criteria:** A doc added to a repo shows up in the next brief; `search_docs` returns file and line.
- **Validation Steps:** `bun test packages/daemon/src/docs`.
- **Notes:** `.agile-docs/` inside a repo is the one new tracked directory this plan introduces; approved by D9.

### Ticket: T135 Phase 3 QA and Pete's look
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** Fake-transport QA of attach, review, land on nested streams; Pete runs one real worker on ledger-lite via the CLI.
- **Acceptance Criteria:** QA ACCEPT; live: one stream landed on ledger-lite.
- **Validation Steps:** —
- **Notes:** First live milestone.

### Phase 4 — Rules with three tiers

### Ticket: T140 Rule schema, store, and CLI
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** `shared/src/rule.ts`: `Rule = { id, text, question?, scope: { kind: 'global'|'repo'|'stream', ref? }, status: 'proposed'|'accepted'|'retired', enforcement: 'pattern'|'classifier'|'guidance', pattern?: { kind: 'no_push'|'no_push_protected'|'path_deny'|'command_deny', args }, critical: boolean, examples: { action, violates: boolean }[], provenance: { stream?, session?, finding?, by }, stats: { fired, violated, routed, last_fired_at? }, created_at, decided_at?, decided_by? }`. Store with the principal split: agents may create `proposed` only; `status` and `decided_*` are human-only. `agile rules list|show|accept|retire|add`. Scope filtering is one function (`rulesInScope(stream)`) used by the brief and the hook.
- **Acceptance Criteria:** An agent principal setting `status: accepted` is rejected. `rulesInScope` unit-tested for global/repo/stream and nested streams.
- **Validation Steps:** `bun test packages/shared packages/daemon/src/rules`.
- **Notes:** Seed: the "Decisions" entries in `PLAN-v1.md` §9 are imported as `proposed` global rules by a one-off script in this ticket, so the first accept pass is over real material.

### Ticket: T141 Lessons at stream close
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** On land or close, the daemon runs a short one-shot session (worker vendor, `briefs/lessons.md`) over the stream's findings, questions, and hook denials, and asks for at most three proposed rules, each with two example actions. They are written as `proposed` with provenance and appear in the inbox as `rule_accept` items. No proposal is made when there were no findings, no denials, and no questions.
- **Acceptance Criteria:** With the fake transport scripted to propose two rules, both appear in the inbox with provenance pointing at the stream; accepting one moves it to `accepted` and the next brief in scope contains it.
- **Validation Steps:** integration test; e2e for the inbox card.
- **Notes:** This is the retro, per stream, with the human as the only decider.

### Ticket: T142 Rules view and pruning
- **Priority:** P1
- **Status:** Todo
- **Owner:** —
- **Scope:** RPC `rules.report`: for each rule, fired / violated / routed counts, last fired, and "never fired in N days". `agile rules report`. UI in T163.
- **Acceptance Criteria:** Counts come from `stats` updated by the hook path (T151) and the diff check (T152); a retired rule stops being injected on the next session.
- **Validation Steps:** `bun test packages/daemon/src/rules`.
- **Notes:** —

### Ticket: T143 Built-in pattern rules
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** Global rules created on first daemon start: `no_push_protected` (accepted, critical, pattern; branches from `repos.yaml`), `no_push` (retired by default, pattern), `no_worktree_escape` (accepted, critical: no writes outside the session's worktree). The push detector is anchored on the git subcommand (not a substring), handles `-c`/`-C` prefixes, subshell and pipe glue, `$(echo git) push` forms fail closed; a push to an explicit non-protected branch is allowed; a bare `git push` is resolved against the checked-out branch's upstream, and denied if unresolvable.
- **Acceptance Criteria:** A table-driven test of ≥ 30 command strings (allow/deny) including the evasion forms; `git stash push` and `git log --grep push` allowed; a merge into a protected branch inside the worktree (`git checkout main && git merge`) is denied by the same rule.
- **Validation Steps:** `bun test packages/daemon/src/hook`.
- **Notes:** D7 and D8. Design borrowed from KiroCrew's argv floor (D11).

### Phase 5 — The classifier tier

### Ticket: T150 Classifier interface, fake, and Jev adapter
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** `daemon/src/classifier/`: `Classifier.ask(state, questions[]) → { id, probability, confidence }[]`. `FakeClassifier` scripted per test. `JevClassifier` over `https://api.typesafe.ai` (Noul questions, one call per state, 25 s timeout, key from `config.yaml` or `TYPESAFE_API_KEY`). A credential scrub runs on the state before every call (patterns for tokens, keys, `Authorization:` headers, `.env` lines); if the scrub itself throws, nothing is sent. Per-stream `classifier: off` and per-repo default in `repos.yaml`.
- **Acceptance Criteria:** Unit tests for the scrub (positive and negative), the timeout, and the opt-out; a recorded-fixture test for the Jev request/response shape (no network in `bun test`).
- **Validation Steps:** `bun test packages/daemon/src/classifier`.
- **Notes:** D5. Manual live check: `agile rules test <rule-id>` against the real API with the key set.

### Ticket: T151 Per-action classifier check in the hook path
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** `hook/decide.ts`: after pattern rules, collect accepted `classifier` rules in scope, build the state (tool name, command or path + diff, stream and repo line), one call with one Noul per rule (`rule.question` or "Does this action violate: <text>?"). Bands from `config.yaml` (defaults deny ≥ 0.80, allow < 0.40, else route; confidence < 0.50 routes). Route = `classifier_review` inbox item, session blocked until answered; the answer allows or denies and increments `stats`. Fail policy: classifier error → critical rules deny, others allow and write a `hook_unchecked` thread entry. Latency recorded per call in events.
- **Acceptance Criteria:** Fake-classifier tests for all three bands, low confidence, error with and without a critical rule, and the opt-out; the deny reason names the rule and reaches the model (existing `permissionDecisionReason` path).
- **Validation Steps:** `bun test packages/daemon/src/hook`; integration test with the fake agent.
- **Notes:** D6. Vendors without a PreToolUse hook get only T152 and guidance; document per vendor in the design (`spike-findings.md` stays the reference).

### Ticket: T152 Diff-level rules at landing
- **Priority:** P1
- **Status:** Todo
- **Owner:** —
- **Scope:** Rules may set `stage: action | diff | both` (default `action`). At land (T132), `diff` rules run once with the full stream diff (capped at the classifier's budget; larger diffs run per file and take the max) and the same bands; a deny blocks landing with the rule named; a route creates the inbox item and landing waits.
- **Acceptance Criteria:** Fake-classifier tests for deny, allow, route, and the over-budget split.
- **Validation Steps:** `bun test packages/daemon/src/landing`.
- **Notes:** —

### Ticket: T153 Rule examples as evals
- **Priority:** P1
- **Status:** Todo
- **Owner:** —
- **Scope:** `agile rules test [rule-id]` runs every accepted classifier rule's `examples` through the configured classifier and reports agreement; the suite runs the same through the fake to prove plumbing. A rule with fewer than two examples cannot be accepted with `enforcement: classifier` (store check).
- **Acceptance Criteria:** Store rejects the under-specified rule; the CLI report lists disagreements with probability and confidence.
- **Validation Steps:** `bun test packages/daemon/src/rules`.
- **Notes:** Manual live check: run against the real API on the seeded rules from T140 and record the agreement rate in this ticket's Notes.

### Ticket: T154 Phase 4+5 QA and Pete's look
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** Black-box QA of rules, lessons, the hook bands, and landing with the fake classifier; Pete accepts a rule and watches it deny a real worker on ledger-lite with the real key.
- **Acceptance Criteria:** QA ACCEPT; live denial observed and recorded.
- **Validation Steps:** —
- **Notes:** Second live milestone.

### Phase 6 — The cockpit

### Ticket: T160 Shell, inbox, and stream tree
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** Reuse `ui/app/lib/shell.tsx`, the single ws, `Markdown`, `NeedsYou` (renamed Inbox), `TopBar`, `Settings`. Left rail: stream tree with status dots (who must act). Main: Inbox by default, grouped by stream, each card answerable inline (question, land, rule accept, classifier review). Delete the Plan/Sprint/Review screens and their components.
- **Acceptance Criteria:** Playwright: an agent question on a nested stream appears in the inbox without reload, the answer reaches the session, the tree dot changes. Phone-width layout works.
- **Validation Steps:** `bun run test:e2e`.
- **Notes:** Pete looks at this before T161 starts.

### Ticket: T161 Stream page
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** Thread (streaming, markdown, thinking indicator from T051's `chat-state.ts`), a composer that writes a human line and, if a worker is attached, prompts it; sessions strip (vendor/model, attach, review, stop); diff tab (reuse `feed/diff.ts`); rules-in-scope tab; docs tab (T134); Land button with the diff-rule result.
- **Acceptance Criteria:** Playwright covering attach → question → answer → findings → land on one stream with the fake transport.
- **Validation Steps:** `bun run test:e2e`.
- **Notes:** Pete looks at this before T162.

### Ticket: T162 New stream and quick capture
- **Priority:** P1
- **Status:** Todo
- **Owner:** —
- **Scope:** "New stream" from anywhere (title, optional parent, optional repo); a quick-capture box in the top bar that creates a stream from one line, for the support question that arrives mid-task. Keyboard: `n` new, `/` search streams.
- **Acceptance Criteria:** Playwright: quick capture creates a stream with no repo in under two interactions.
- **Validation Steps:** `bun run test:e2e`.
- **Notes:** —

### Ticket: T163 Rules screen
- **Priority:** P1
- **Status:** Todo
- **Owner:** —
- **Scope:** List with scope, tier, status, stats; accept/retire; edit text, question, examples; the pruning columns from T142 (never fired, most routed); "test examples" button calling T153.
- **Acceptance Criteria:** Playwright: accept a proposed rule, see it in a stream's rules-in-scope tab.
- **Validation Steps:** `bun run test:e2e`.
- **Notes:** —

### Ticket: T164 Rewrite LIVE-CHECKLIST.md and CLAUDE.md
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** The §6 walkthrough as numbered steps against `~/Projects/ledger-lite`, including the reset recipe, the real-key classifier step, and what to look at when something fails. `CLAUDE.md` rewritten for the new layout, commands, and conventions; the frozen-plan and old-design references removed.
- **Acceptance Criteria:** Pete completes the walkthrough without asking a question.
- **Validation Steps:** Manual.
- **Notes:** Final milestone.

## 8. Deleted (must be gone from `main` by the end of Phase 6)

Daemon: `em/`, `architect/`, `oracle/`, `qa/`, `halts/`, `quota/`, `handoff/`, `plan/`, `review/` rounds, `sync/` (shelved on a branch), `feed/stories.ts`, `runner/pipeline-glue.ts`, sprint parts of `merge/`, `bus/` unless the thread reuses it. CLI: `run`, `send`, `halt`, `approve`, `sync`. Shared: `Ticket`, `Sprint`, `Stanza`, `Message`, `Halt`, `Quota`, `Review`, `Qa`, `Oracle`, `Kb`, `Ledger`. Briefs: all but `worker.md`, `reviewer.md`, `lessons.md`. UI: `plan/`, `sprint/`, `review/`, `OraclePanel`. State: the `agile-state` orphan branch and per-repo `.agile/`.

## 9. Open questions

- Q1. Should a coding stream's target default to an integration branch (current behaviour) or straight to `main` when the repo has no integration branch? Plan assumes the repo's default branch; Pete to confirm at T132.
- Q2. Classifier thresholds (0.80 / 0.40 / confidence 0.50) are starting points; T153's live agreement rate decides whether to move them.
- Q3. Whether `bus/` survives as the thread's transport or is deleted; decided in T120 by whichever is less code.
- Q4. Whether repo docs live in `.agile-docs/` (tracked) or under the home (untracked). Plan says tracked so a repo carries its own guidance; Pete to confirm at T134.

## 10. Discovered Issues Log

- (empty)

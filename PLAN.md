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
- D12 (2026-09-21, Pete). Sessions carry `vendor`, `model` and `effort` chosen at attach time (`agile attach --vendor --model --effort`, and the Attach control in the sessions strip); defaults per repo, then per home. Effort is a closed enum mapped per vendor by the provider registry and ignored with a thread note where the vendor has no equivalent. Adding a vendor is one `AcpProviderConfig` entry plus a `vendors.yaml`/`config.yaml` stanza, never a code path (old design §8, still valid).
- **D13** (T120): a stream is archived by a boolean `archived: true` on the record, not by a fifth `human.status` value; `human.status` keeps the four states the tree dot reads (§9.2). `stream.list` hides archived streams unless `include_archived`; a live child of an archived parent re-roots in the tree.
- **D14** (2026-09-22, Pete; §6.3): a Noul has no separate confidence by design (TypeSafe docs: "There is no separate `confidence` value for a Noul"; the single value is answer and certainty in one). The three bands are the confidence handling: deny ≥ `deny_at`, allow < `allow_below`, route between. The confidence floor and the derived `|2p−1|` are removed (T156), not switched off; until T156 lands, set `classifier.bands.confidence_floor: 0`. `allow_below`/`deny_at` move only on more data (lower allow when a missed violation is costly, raise deny when a wrong block is costly). Weak rules are fixed by wording: one yes/no question per rule, yes means broken, plus `criteria` (true/false descriptions) when the line is subtle. Amends D6's "low confidence routes": the route band is the low-confidence case.
- **D15** (2026-09-22, Pete): the cockpit stays a page served by `agiled` (§9), and becomes an installable, self-contained-feeling app eventually, at whatever point costs least without holding up implementation (T165: web app manifest first, a desktop shell only if needed and approved).
- **D16** (2026-09-23, Pete): the TypeSafe key stays in the cloud environment config. Workers, reviewers and QA may make real classifier (Jev) calls and should prefer them over `FakeClassifier` when checking classifier behaviour; unit tests stay offline. The key is never printed, logged or committed. Replaces the standing "no TypeSafe key in the cloud" rule. Vendor logins are still absent in the cloud and `test:live` / `AGILE_LIVE=1` stay off.
- **D17** (2026-09-23, Pete): the default session is Claude Code with model `claude-opus-5-5` at effort `low`, applied when no flag, repo entry or home config says otherwise (step 4 of the D12 order, before the provider's own default). Vendor, model and effort — home-wide and per repo — are all editable in the cockpit Settings screen, and Attach/Review can override per session.
- **D18** (2026-09-24, Pete): the daemon source target in §6 is raised from 18,000 to 20,000 lines for now (18,273 after T174–T177). Guard against bloat anyway: every ticket reports its line delta, and growth that is not new product (narration, duplication, dead code) is trimmed in the ticket that caused it.
- **D19** (2026-09-24, Pete): the next stage follows `design/projects-design.md`, which wins over `design/cockpit-design.md` where they differ. Projects are the top level of the tree. A project holds settings (repos, default session, delivery override, autonomy levels, tracker link). Every node belongs to exactly one project.
- **D20** (2026-09-24, Pete): there is one node kind, the stream. Its role (project, coordinating, work, conversation) follows from whether it has children and a repo. It is derived, never stored. A work node has exactly one repo, one branch and one worktree. Work that spans two repos is a coordinating node with one work node per repo. Epic, ticket and task are only labels. Parent integration branches are removed: work nodes deliver straight to their repo, and "waits on" and "merge together" replace the parent branch. Same-repo helper children are the one exception: they merge back into their work node's branch.
- **D21** (2026-09-24, Pete): delivery is set per repo (`direct` or `pr`), and a project or node can override it. Direct means you click Merge. PR means the agent pushes and opens a PR, and the PR state becomes the node's status. After a PR opens, the node's agent looks after it: it fixes CI failures and small review asks, brings in main, and sends design disagreements to the inbox. `auto_merge` is a per-repo setting, off by default. When it is on, the agent enables GitHub auto-merge once its own checks pass and its "waits on" links are satisfied. The app itself never merges a PR through the API. After every merge, other live work nodes on the repo are synced to the new main. Overlaps between live work nodes are tracked across projects.
- **D22** (2026-09-24, Pete): events are a core system that replaces ad hoc prompts to live sessions. An event is typed and routed to its subject, the subject's ancestors, nodes on its "waits on" links and, for repo events, the same repo. It is stored before delivery and delivered once. A burst of events becomes one digest on wake. No event is ever dropped because an agent is busy or asleep. Each node has an activity feed showing what woke it.
- **D23** (2026-09-24, Pete): rules become knowledge items of three kinds: standard, architecture and decision. Each item has a stacked scope (global, repo, project, subtree, plus optional paths) and one enforcement setting: `tell`, `action` (hook: a pattern or the classifier), `ship` (the classifier over the diff before a PR or merge) or `review` (the reviewer's checklist at ship). Nothing applies until you accept it. Agents get the knowledge in scope at start, as events when it changes, and on demand through a lookup tool. Lessons stay and propose items with a kind.
- **D24** (2026-09-24, Pete): nothing the app knows or holds goes into a user's repo. Only the code the work produces is committed. Everything else lives in `~/.agile/`. Worktree ignores go in `<git-common-dir>/info/exclude` (T177). This supersedes the §9 Q4 assumption that repo docs are tracked in `.agile-docs/`.
- **D25** (2026-09-24, Pete): siblings work through the parent. The parent writes the plan (who owns what) and the contracts. Status cards and mechanical alerts (same file, a changed symbol, a contract touched) keep siblings informed. Siblings may settle details directly with "ask sibling", copied to the parent. Changes to the plan, a contract or ownership go through the parent: siblings who agree on one propose it together, and the parent approves it or asks you. Collisions go to the parent's agent first.
- **D26** (2026-09-24, Pete): coordinators and the Director share three autonomy levels. **Advise** (the default): they propose and you click. **Organise**: they create and restructure nodes, start agents and add links, then tell you. **Run**: they also approve routine contract changes and restart stuck work. The level is set per project and can be overridden on a node. At every level, merging, accepting norms and answering a question as if they were you stay yours. Changes to what gets built always come to you.
- **D27** (2026-09-24, Pete): one Director sits above all projects. It starts work (drafts trees and plans), sees across projects (overlaps, links, norms), keeps things moving (stuck and idle nodes, "what needs me today?") and suggests norms. Every action it takes is recorded as done by the Director. It supersedes the unfiled "Desk"/side-quest proposal.
- **D28** (2026-09-24, Pete): Jira and Linear are optional links on a node (at most one issue each), never a kind of node. A node with no link rolls up to its nearest linked ancestor. Pulling the issue into the node's goal is on by default. Importing an epic's children is a click. Pushing status to the tracker is off until you turn it on per project. Creating an issue is always a click. The app never closes an issue or edits its text. This lifts the §3 non-goal for tracker links only. It does not bring back the shelved sync.
- **D29** (2026-09-24, Pete): any agent may read any registered repo by default. A repo set private is readable only by the projects it lists. Changing code is always limited to the node's own repo.
- **D30** (2026-09-24, Pete): Phases 7–13 are built on stacked branches. `claude/phase-7` comes off the current integration tip, and each `claude/phase-N` comes off `claude/phase-(N-1)`. Ticket branches `T###-<slug>` fork from their phase branch and merge back `--no-ff`. Pete reviews each phase at its QA ticket and lands the phases in order. A fix found in phase N while phase N+1 exists is made on phase N and merged forward into every later phase branch, never cherry-picked backwards.
- **D31** (2026-09-24, Pete): P17 approved. Jira and Linear tokens may be stored in the home `config.yaml`, the second written credential exception after the TypeSafe key (D16), with the same rules: written only through the store at mode 0600, never printed, logged, committed or sent to the browser; Settings shows only whether a token is set. T320 is unblocked.
- **D32** (2026-09-24, Pete): proposed decisions P1–P16 and P18–P20 (design/projects-design.md §19) accepted as written. Q5–Q24 are closed by D31 and D32.
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

### 6.1 Definition of done for the projects stage (Phases 7–13)

- The same offline gate: `bun install && bun run build && bun run typecheck && bun run lint && bun test && bun run test:integration && bun run test:e2e` is green from a clean clone, with no vendor login and no network. GitHub is exercised only through the fake GitHub (T220), and Jira/Linear only through their fakes (T320).
- Daemon source stays under **20,000 lines** (D18). The new stage pays for itself by deleting code: parent branches, attach as a separate step, `say`/answer prompts, `seed-plan-v1.ts`, `bus/` leftovers and the rules/knowledge duplication. Every ticket reports its line delta, and every phase QA reports the count. If the target can't be held, the QA says why and Pete decides. The target is not raised silently.
- Nothing the app holds is committed to a user repo (D24). A test asserts `git status --porcelain` is empty in the user's checkout after a full walkthrough.
- Pete can, on his Mac with Claude Code and `gh` logged in, run this walkthrough, which is `LIVE-CHECKLIST.md` rewritten for the stage:
  1. Create projects Shop and Blog. Register `~/Projects/ledger-lite` (direct) and `~/Projects/agile-test-repo` (PR, `https://github.com/petestewart/agile-test-repo`).
  2. Turn a conversation into a coordinating node with + Repo on both repos. Approve its plan and contract.
  3. Watch one work node open a PR, react to a review comment and a failing check, and merge (auto-merge on). Watch the other wait on it, get synced, pass its ship check, and merge directly with one click.
  4. See a cross-project overlap flagged and resolved with a "waits on" link.
  5. Accept a proposed knowledge item and see it reach a live node as an event.
  6. Ask the Director "what needs me today?", and at Organise have it start a small project.
  7. Link a node to a Linear or Jira issue and see the roll-up. (This step needs D-approval of P17.)
- Every proposed decision P1–P20 in `design/projects-design.md` §19 is confirmed, amended or replaced by a D-entry before the phase that depends on it starts.

## 7. Phases and tickets

Build order: Phase 0 → 1 → 2 → 3 → 4 → 5 → 6. Within a phase, tickets marked ∥ may run in parallel. Phase 4 must finish before Phase 5 starts (rules must exist before anything enforces them). Phase 6 tickets each end with Pete looking at the result.

### Phase 0 — Freeze and re-baseline

### Ticket: T100 Land `claude/control-room-v2` and freeze the old plan
- **Priority:** P0
- **Status:** Done
- **Owner:** Pete + manager
- **Scope:** Pete lands `claude/control-room-v2` into `main` by PR (T039–T051). Then: `PLAN.md` §7 gets a banner "frozen 2026-09-19, see `design/reshape-plan.md`"; no new T0xx tickets. The `/project` skill's "board" becomes this file (rename to `PLAN.md` and move the old one to `PLAN-v1.md` in the same commit).
- **Acceptance Criteria:** `main` contains the v2 control room; `PLAN.md` is this document with the old plan preserved as `PLAN-v1.md`; `/project` reads the new board.
- **Validation Steps:** `grep -c '^### Ticket: T1' PLAN.md` ≥ 30; skills' PLAN grep still matches.
- **Notes:** Manual, Pete. Nothing else in this plan starts before this lands. PR #2 merged to `main` as `a85edda` (2026-09-19). File moves done on `claude/reshape` (PLAN.md → PLAN-v1.md, reshape-plan.md → PLAN.md); `grep -c '^### Ticket: T1' PLAN.md` = 31. The §7 banner on PLAN-v1.md rides with T101.

### Ticket: T101 Rewrite the design doc around streams, rules, and the classifier tier
- **Priority:** P0
- **Status:** Done
- **Owner:** opus:worker-T101
- **Scope:** New `design/cockpit-design.md`: §1 problem and operator journey (the three stream types and the question flow), §2 stream model and the two-writer field split, §3 inbox, §4 agents as attachments (worker, reviewer, gates), §5 rules (record, tiers, bands, lessons, pruning), §6 classifier (Jev call shape, thresholds, fail policy, scrub, opt-out), §7 state home and file formats, §8 hook path and landing path, §9 UI (inbox, tree, stream page), §10 what was deleted and why. `design/agile-agents-design.md` gets a top banner "superseded by cockpit-design.md; kept for §8 adapter contract and §6 hook catalog, which remain valid".
- **Acceptance Criteria:** Every decision D1–D11 appears in the new design with its rationale. `CLAUDE.md` "Source of truth" points at the new design.
- **Validation Steps:** Review by Pete; no code.
- **Notes:** Do not fold the Jev material into the old doc; write the new one. Branch `T101-cockpit-design-doc`; review (sonnet) PASS, 2 nits (rule `stage?` shown in §5.1 though added by T152; `question` listed beside gate kinds in §3.1). merge: 1ef2fed.

### Phase 1 — One persistent daemon, many roots

### Ticket: T110 Stream and Thread schemas
- **Priority:** P0
- **Status:** Done
- **Owner:** opus:worker-T110
- **Scope:** `packages/shared/src/stream.ts`: `Stream` = `{ id, title, goal, parent?, repo?, branch?, worktree?, target_branch?, created_at, agent: { status: 'idle'|'working'|'blocked'|'question'|'done', progress?, findings?, proposed_next?, updated_at }, human: { status: 'open'|'waiting_on_you'|'landed'|'closed', decision?, answered_at?, note? }, sessions: SessionRef[] }`. Two sub-objects, `agent` and `human`, are the two-writer split (D11): the store rejects an agent principal writing `human.*` and a human principal writing `agent.*`. `Thread entry` = `{ ts, by: 'human'|'agent:<id>'|'daemon', kind: 'line'|'question'|'answer'|'event'|'finding'|'proposal', body (capped), ref? }`. `SessionRef` = `{ id, vendor, model, role: 'worker'|'reviewer', status, worktree? }`. Remove `Ticket`, `Sprint`, `Stanza`, `Message`, `Halt`, `Quota`, `Review`, `Qa`, `Oracle`, `Kb` schemas in the same ticket only if nothing still imports them; otherwise mark `@deprecated` and delete in T125.
- **Acceptance Criteria:** Unit tests for the principal check on both directions; nesting depth unlimited but a cycle is rejected; `.strict()` on all.
- **Validation Steps:** `bun test packages/shared`.
- **Notes:** Numbering stays ULID-based (`ids.ts`). Branch `T110-stream-and-thread-schemas`. All ten old schemas are still imported by daemon/ui, so they carry `@deprecated` and are deleted in T122. Review (sonnet) round 1 FAIL: `agent.findings` was a string; fixed to `StreamFinding[]` (`{ severity, file, line?, text }`, exported as `StreamFinding` because `review.ts` still owns `Finding` until T122) and `proposed_next: string[]`; round 2 PASS. merge: 4e8c52e.

### Ticket: T111 State home and the repo registry
- **Priority:** P0
- **Status:** Done
- **Owner:** opus:worker-T111
- **Scope:** The store (`daemon/src/store`) opens `AGILE_HOME` (default `~/.agile/`) instead of a repo's `.agile/` worktree. `repos.yaml` registers repos (`path`, `protected_branches` default `[main, master]`, `target_branch?`, `vendor?`). `agile repo add <path>` / `agile repo list`. Drop the orphan-branch machinery in `store/git.ts` and `init.ts`'s worktree setup; `agile init` becomes "create the home if missing". Events log moves to the home.
- **Acceptance Criteria:** A daemon started with a temp `AGILE_HOME` serves two registered repos; no `.agile/` directory is created inside a repo; the old `agile-state` code paths are deleted, not flagged off.
- **Validation Steps:** `bun test packages/daemon/src/store packages/cli`; integration test that registers two temp repos.
- **Notes:** Migration from an existing `.agile/` worktree is out of scope; ledger-lite gets reset (recipe in LIVE-CHECKLIST). Branch `T111-state-home-and-repo-registry`. `store/git.ts` and the orphan-branch init deleted; `repos.yaml` + `agile repo add|list` + `state.repo_*` RPC; `repo.e2e.test.ts` added to `test:integration`; `test-preload.ts` defaults `AGILE_HOME` to a temp dir (the suite used to write into the operator's real `~/.agile/`). Side fix: `chat-state.ts` no longer re-arms a turn that already ended (exposed by the per-write git commit going away; regression test added). Review (sonnet) PASS. Daemon source 35,905 lines. merge: fc827e7.

### Ticket: T112 Long-lived `agiled` and thin CLI
- **Priority:** P0
- **Status:** Done
- **Owner:** opus:worker-T112
- **Scope:** `agile daemon start|stop|status` runs the daemon detached with a pidfile and a port in `config.yaml`; it never exits because work finished. `agile run` is deleted; its `advancePipeline` glue is replaced by per-stream drivers in Phase 3. `agile status`, `agile tail` talk to the daemon over the existing RPC. The control room is served at `/` (the `/control-room` path stays as a redirect).
- **Acceptance Criteria:** Daemon survives the last stream closing; `agile status` works with no repo cwd; a second `start` is a no-op with the pid printed.
- **Validation Steps:** `bun run test:integration` (daemon lifecycle test); manual: start, close the terminal, open the URL.
- **Notes:** Delete `cli/src/commands/run.ts` and `runner/pipeline-glue.ts` here; do not port the glue. Branch `T112-long-lived-daemon-thin-cli`. Deleted `run.ts` (1,378 lines), `run.e2e.test.ts`, `pipeline-glue.ts` (+ tests), `advancePipeline`, the `e2e` script. `agile daemon start` detaches (pidfile = lock, `<home>/log/agiled.log`), `stop`, `status`; `HomeConfigSchema` in shared; `resolveHomePaths()` for repo-less clients; `/` serves the control room, `/control-room` 302. `daemon.e2e.test.ts` replaces the run e2e in `test:integration`. Judgement calls: `daemon start` still resolves a repo cwd (18 subsystems need `repoRoot` until Phase 3); `startApprovedSprint()` moved to the ceremony tick (T122 deletes it). Review (sonnet) PASS, 1 nit (parent leaves the log fd open). Daemon source 34975 lines. merge: 3365208.

### Ticket: T113 ∥ Hardened worktree creation
- **Priority:** P1
- **Status:** Done
- **Owner:** opus:worker-T113
- **Scope:** `runner/worktrees.ts`: create via git plumbing with no shell, `core.hooksPath` pointed at an empty dir for the checkout, refuse repos with filter drivers configured, claim the branch atomically (`git update-ref` with the expected-old-value form), fail if the branch already exists anywhere. Worktree path `<repo>/.worktrees/<stream-id>-<slug>`, ensured in `.gitignore`.
- **Acceptance Criteria:** Two concurrent creates for the same stream: exactly one succeeds. A repo with a `.gitattributes` filter is refused with a reason.
- **Validation Steps:** `bun test packages/daemon/src/runner/worktrees.test.ts`.
- **Notes:** Design borrowed from KiroCrew's worktree handler (D11). Branch `T113-hardened-worktree-creation`; new `createWorktree` beside the old ticket helpers (deleted with their callers in T122/T130). Review (sonnet) PASS, 2 nits (`.gitignore` append not rolled back on failed add; `pre-checkout` is not a real hook name, the `post-checkout` half of that test is the live one). merge: dfebb27.

### Phase 2 — Streams replace sprints and tickets

### Ticket: T120 Stream service and RPC
- **Priority:** P0
- **Status:** Done
- **Owner:** opus:worker-T120
- **Scope:** `daemon/src/streams/`: create, get, list (tree), update with principal, close, archive; thread append and read (paged); events for every change. RPC methods and `agile stream new|list|show|close`. A stream with `repo` gets a branch and worktree on first attach (T130), not on create.
- **Acceptance Criteria:** A stream without a repo is fully usable (thread, questions) and never touches git. Tree listing returns parent/child structure. Principal checks from T110 are exercised end to end.
- **Validation Steps:** `bun test packages/daemon/src/streams packages/cli`.
- **Notes:** Branch `T120-stream-service-and-rpc`. `StreamService` (principal-taking API for T130's agent verbs), `stream.create|get|list|update|close|archive|thread_append|thread_read` RPC with `human` stamped at the edge, `agile stream new|list|show|close|archive|say`. `archived?: true` boolean on `StreamSchema` rather than a fifth human status (manager call, see D13). Review (sonnet) PASS, 2 nits (create's record write and its thread event are two mutex acquisitions; `human` patch shape validated by the store, not the edge). Full `bun test` 2302 pass / 3 skip / 0 fail; integration 36 pass. merge: 19c6edd.

### Ticket: T121 Inbox: questions and gates re-keyed to streams
- **Priority:** P0
- **Status:** Done
- **Owner:** opus:worker-T121
- **Scope:** `questions/` and `gates/` keep their services but every request carries `stream` instead of `ticket`/`sprint`. One `inbox` RPC returns everything waiting on the human across all streams, sorted oldest first, each item with the stream path and a one-line context. Answering a question writes the answer to the thread and unblocks the waiting session (existing `deliverNote`/`waitingAgent` path). Gate kinds shrink to `land`, `rule_accept`, `classifier_review`; every other gate kind (`approve_plan`, `sprint_review`, `unblock`, `promote_to_main`, …) is deleted with its policy rows.
- **Acceptance Criteria:** An agent question on a stream with no repo shows in the inbox and the answer reaches the session. Stale mail from a previous daemon run cannot appear as a question (questions are records with status, not bus mail; the bus drain at start is gone).
- **Validation Steps:** `bun test packages/daemon/src/questions packages/daemon/src/gates`; e2e: inbox card appears without reload (`hil_requested` trigger from T050 stays).
- **Notes:** This fixes the 2026-09-11 stale-question defect from the live run at the root. Branch `T121-inbox-rekeyed-to-streams`, 4 commits. Questions moved to `<home>/questions/<id>.yaml`, `stream` required on questions and gates, `HIL_KINDS` = land|rule_accept|classifier_review, new `daemon/src/inbox/` (`inbox.list`, `GET /api/inbox`) derived per call from records, `agile inbox` and `agile answer`. No bus drain existed to delete; the acceptance property is asserted structurally (leftover bus mail never surfaces). Hook `ask` verdict is a plain deny until T151 (see Discovered Issues). Gate records still in repo `.agile/board/hil/` (T122/T123). Review (sonnet) PASS, 3 nits (unblock delivery routes by role id, not session; report undercounted removed hook tests; gate path). Full `bun test` 2292 pass / 3 skip / 0 fail; integration 37 pass. merge: f5c55eb.

### Ticket: T122 Delete the ceremony and role layer
- **Priority:** P0
- **Status:** Done
- **Owner:** opus:worker-T122
- **Scope:** Delete `daemon/src/em/` (resident, delegate, chat, review, report), `daemon/src/architect/`, `daemon/src/oracle/`, `daemon/src/qa/`, `daemon/src/halts/`, `daemon/src/quota/`, `daemon/src/handoff/`, `daemon/src/pi/` (unless a provider still needs it), `daemon/src/plan/`, `daemon/src/review/` (the round-tracking part; the reviewer role is rebuilt in T131), `daemon/src/merge/` sprint parts, `briefs/{em,architect,qa,reader,refinement,retro,sprint-review,standup}.md`, `feed/stories.ts`, `runs/` writer. Delete `cli` commands `send`, `halt`, `approve` (replaced by `answer` and `land`). Delete the `bus` except the part the thread needs, or delete it entirely if T120's thread covers it. Delete the `Sprints`, `Tickets`, `Policy`, `Questions` panes and the `sprint/` and `review/` UI directories; the UI is rebuilt in Phase 6, so the app may be visually broken between T122 and T160 on the integration branch (never on `main`).
- **Acceptance Criteria:** `bun test` and typecheck green; daemon source line count reported in the ticket Notes; no import of a deleted module remains; `grep -ri sprint packages/daemon/src | wc -l` is 0.
- **Validation Steps:** the three suites; `cloc`-style count via `find … | xargs wc -l`.
- **Notes:** The largest single deletion in the plan. Do it in one ticket so nothing half-alive survives. Branch `T122-delete-ceremony-and-role-layer`, 9 commits, 272 files, −50,449 / +481. Daemon source 35,474 → 15899 lines (target < 18,000 already met). `grep -ri sprint packages/daemon/src` = 0; 78 `ticket` hits remain as types on `AgentRecord`/hook context/`agile mcp --ticket`, re-keyed in T130–T132. Manager calls: `agile approve|deny|note|delegate|resolve` deleted now (plan and §10 say `answer`+`land` replace them; gates are decided over `POST /api/hil/:id/*` or `gate.*` RPC until T140); `merge/precommit.ts` deleted (its only enforcement was the halt guard). Survivors: `pi/` whole (runner imports it for Pi hook enforcement), `bus/` whole (hook, runner session and Pi `bus_send` still route through it; T123/T130 prune), `merge/git.ts`, `briefs/template.ts` + engineer/reviewer briefs. Gate records moved to `<home>/gates/`, breaker to `<home>/breaker.yaml`. UI is a minimal shell until Phase 6. Review (sonnet) PASS, 0 blocking. Full `bun test` 1250 pass / 2 skip / 0 fail (94 files); integration 16 pass (6 files). merge: dc4b3f7.

### Ticket: T123 ∥ Events and the append-only log
- **Priority:** P1
- **Status:** Done
- **Owner:** opus:worker-T123
- **Scope:** `Event` kinds reduced to stream/thread/session/question/gate/rule/hook/land events. `log/events.jsonl` in the home, append-only, one writer, fsync on gate and land events. `agile tail` filters by stream.
- **Acceptance Criteria:** Every state change in T120–T122 emits an event; a reconstruct test rebuilds stream statuses from the log alone.
- **Validation Steps:** `bun test packages/daemon/src/store/events.test.ts`.
- **Notes:** — Branch `T123-events-and-append-only-log`. `EVENT_KINDS` pruned to 21 kinds with live emitters (19 deleted); `Event` = ts, kind, data + optional `stream` (ULID), `session`, `agent` (agent/`agent_put`/`message` go with T130's bus and registry pruning). Store is the one writer of `log/events.jsonl`; gate and `land_*` events fsync through an fd. Stream events carry the resulting status pair; `reconstructStreams()` + reconstruction test over the real services. `agile tail --stream|--kind|--session`. Review (sonnet) PASS, 0 blocking. Full `bun test` 1275 pass / 2 skip / 0 fail; integration 16 pass. merge: d1bc6e1.

### Ticket: T124 Phase 2 QA and Pete's look
- **Priority:** P0
- **Status:** Done (Phase 2 accepted 2026-09-21; status line was stale)
- **Owner:** sonnet:qa-T124
- **Scope:** Black-box QA of streams, inbox, and thread via the CLI and RPC against a real daemon with the fake ACP transport; then Pete drives `agile stream` and `agile answer` by hand on a scratch repo. Findings become tickets T125+.
- **Acceptance Criteria:** QA ACCEPT; Pete's list recorded.
- **Validation Steps:** —
- **Notes:** — QA (sonnet) round 1 REJECT, 1 failure: daemon start needs a git cwd → T125; three rough edges → T126. All stream/inbox/thread/RPC/persistence/robustness scenarios passed. Round 2 after T125/T126. Round 2 (after T125/T126) ACCEPT, 0 failures: every scenario re-run from a non-git cwd and a git scratch repo. Reports in the manager scratchpad. Pete's look pending; his list goes here as T127+.

### Ticket: T125 Daemon starts from any cwd
- **Priority:** P0
- **Status:** Done
- **Owner:** opus:worker-T125
- **Scope:** T124 QA finding. `agile daemon start` (and `--foreground`) fails with "not a git repository" outside a repo because `discoverConfig` still resolves a `repoRoot` from cwd and reads a per-repo `agile.config.yaml` overlay (deleted by design §7.5). Make `repoRoot` optional: `discoverConfig` never runs `git rev-parse`, the per-repo overlay is deleted, port comes from home `config.yaml` only. Survivors that took `config.repoRoot` (`ToolService`, `HookService`, http snapshot) take the repo from the caller (registered repo path for the agent's stream via `repos.yaml`) or, until T130/T131 re-key them, an optional root that fails closed (hook denies with a reason; tool runner refuses) when absent. `daemon.e2e.test.ts` starts the daemon from a non-git temp dir.
- **Acceptance Criteria:** `agile daemon start` from `/tmp` with an empty registered-repo list starts, serves `stream.*`/`inbox.list`, and stops. No `git` subprocess runs during daemon start.
- **Validation Steps:** `bun run test:integration` (daemon lifecycle e2e from a non-git cwd).
- **Notes:** Branch `T125-daemon-starts-from-any-cwd`. `discoverConfig` is a wrapper over `resolveHomePaths()`, spawns nothing, per-repo `agile.config.yaml` overlay and dead Jira config deleted. `ToolService`/`HookService` take an optional repo root and fail closed without one (relative worktree denied; registry verbs refuse with `ToolRepoUnavailableError`) until T130–T132 re-key them per stream. Daemon e2e runs from a non-git dir on a free port (`freePort`/`writeFreePortConfig` in cli test-support). Control-room project block reads `agile` until it is re-keyed to the stream's repo. Review (sonnet) PASS. Full `bun test` 1279 pass / 2 skip / 0 fail; integration 16 pass. merge: 3242f5a.

### Ticket: T126 ∥ Phase 2 rough edges from QA
- **Priority:** P2
- **Status:** Done
- **Owner:** opus:worker-T126
- **Scope:** T124 QA rough edges: (1) a parent-cycle refusal over `stream.update` returns -32603 with a stray `null` in the message; make it -32602 with the cycle path in the message (same for duplicate id and unknown repo on create). (2) `agile stream close --note` records nothing: append a `line` thread entry `by: human` with the note and put it on `human.note`. (3) `agile status` after `daemon stop` prints a raw socket error: print `agiled is not running (home <path>)` and exit 1, same as `daemon status`.
- **Acceptance Criteria:** Each edge has a test; QA's exact commands from `qa-T124.report.md` behave as described.
- **Validation Steps:** `bun test packages/daemon/src/streams packages/cli`.
- **Notes:** Branch `T126-phase2-rough-edges`. Typed `StreamCycleError` (shared, beside its throw site), `AlreadyExistsError`, `UnknownParentStreamError`, `UnknownRepoError` mapped to -32602 at the edge; `close --note` appends `closed: <note>` to the thread; `agile status` shares `daemon status`'s not-running sentence. Review (sonnet) PASS. Full `bun test` 1283 pass / 2 skip / 0 fail. merge: 6490b26.

### Ticket: T127 Daemon start fails fast on a busy port
- **Priority:** P1
- **Status:** Done
- **Owner:** opus:worker-T127
- **Scope:** Pete's Phase 2 hand test (2026-09-21): with a stale `agiled` from another home holding 4600, `agile daemon start` waits the full 20 s for a pidfile, then reports "no pidfile … see the log", and the log's whole content is `Failed to start server. Is port 4600 in use?`. Make the daemon's bind failure a typed error that names the port and, when a pidfile in *any* home cannot be known, the `lsof -nP -iTCP:<port> -sTCP:LISTEN` line to run; have the child write that reason where `daemon start` reads it (the log is fine) and have `daemon start` stop waiting the moment the child exits, printing the reason, the home's `config.yaml` `port` key and `AGILE_PORT` as the way to run a second daemon. `daemon status` and `agile status` stay as they are.
- **Acceptance Criteria:** With the port held by another process, `agile daemon start` exits non-zero in under 2 s with a message that names the port, the way to find its holder and the way to pick another. Unit test with a listener on a free port; lifecycle e2e unchanged.
- **Validation Steps:** `bun test packages/cli packages/daemon/src/daemon`; `bun run test:integration`.
- **Notes:** Branch `T127-daemon-start-busy-port`. Root cause of the 20 s wait: the foreground child never exited on a failed bind (rejection only set `exitCode`, timers and the RPC socket kept the loop alive) and the parent's `exitCode` poll on an `unref()`ed child saw nothing; a second defect took the lock (the pidfile) before binding, so a dying daemon could report `agiled started`. Fix: HTTP binds before the lock, `PortInUseError` (one line: address, `lsof` command, `config.yaml` `port`, `AGILE_PORT`), child exits 1 at once, parent listens for `exit` and throws `agiled did not start: <last log line>`. Review (sonnet) PASS, 1 nit (a child that dies without logging could surface a stale last line). Tests 10 pass; `bun test` 1289 pass / 0 fail; integration green. merge: 976a50d.

### Ticket: T128 ∥ CLI polish from Pete's Phase 2 look
- **Priority:** P2
- **Status:** Done
- **Owner:** opus:worker-T128
- **Scope:** (1) `agile stream list` gets a header row (`id  title  agent/human`) like `inbox` has. (2) `agile status` adds one line per open stream (`id title agent/human`, tree-indented, archived hidden) between the daemon line and "needs you", so it answers "what is in flight". (3) `agile stream show` on a repo-less stream prints one line `repo -` and drops the branch/worktree placeholder lines; on a stream with a repo the three lines stay. (4) `inbox` age column becomes `age (ts)`: relative plus ISO time, and `--json` already carries `ts`. No new commands, no RPC changes except whatever `status` needs to list streams (reuse `stream.list`).
- **Acceptance Criteria:** Each of the four has a CLI test asserting the printed shape; `stream.e2e`/`inbox.e2e` updated, not loosened.
- **Validation Steps:** `bun test packages/cli`; `bun run test:integration`.
- **Notes:** May run alongside Phase 3 tickets; touches only `packages/cli`. Branch `T128-cli-polish`, 2 commits, `packages/cli` only. `stream list` header row; `status` lists in-flight streams (`open|waiting_on_you`, archived hidden, open children of a closed parent promoted; manager call) and `--json` gains `streams`; repo-less `show` prints `repo -` only; inbox `age (ts)`. Review (sonnet) PASS with 1 nit (the additive `streams` field in `status --json`). `bun test packages/cli` 88 pass; `bun test` 1302 pass / 2 skip / 0 fail; integration green. merge: efc8509.

**Phase 2 verification (2026-09-21, tip a210a24):** build, typecheck, lint clean; `bun test` 1287 pass / 2 skip / 0 fail (95 files); `test:integration` 16 pass / 0 fail (6 suites, run alone). Daemon source 16,002 lines (Phase 1: 34,975; baseline 35,932). Phase 2 stops here for Pete's look (T124); Phase 3 does not start until he says go.

### Phase 3 — Agents as attachments

### Ticket: T130 Worker attach and the stream driver
- **Priority:** P0
- **Status:** Done
- **Owner:** opus:worker-T130
- **Scope:** `agile attach <stream> [--vendor] [--model] [--effort] [--role worker]` and the RPC behind it. `--effort` (D12): a closed enum `low | medium | high | max` stored on `SessionRef.effort?` (add the optional field to T110's schema here, `.strict()` kept); the runner maps it per vendor in the provider registry (`AcpProviderConfig.effort?: (level) => env/args`, Claude via its settings env, others `undefined`); a vendor with no mapping gets a `line` thread entry "effort ignored by <vendor>" and the session still starts. Defaults resolve `--flag` → stream's repo entry in `repos.yaml` (`vendor?`, `model?`, `effort?`) → home `config.yaml` (`default_vendor`, `default_model`, `default_effort`) → provider default. Add `model?`/`effort?` to `RepoEntry` and the three defaults to `HomeConfigSchema`. The daemon creates the branch and worktree (T113) if the stream has a repo, assembles the brief (T133), spawns the ACP session, streams its output to the thread, routes `ask` to the inbox, and updates `agent.*` on the stream. Session lifecycle in `runner/session.ts` is reused; the runner's ticket assumptions are removed. A stream may have one live worker at a time.
- **Acceptance Criteria:** Attach on a no-repo stream works (a planning conversation); attach on a repo stream produces a worktree and the session's cwd is that worktree; the session's exit writes `agent.status: done` and a thread entry.
- **Validation Steps:** integration test with the fake agent; e2e: thread streams in the UI.
- **Notes:** The MCP verbs an agent gets shrink to: `ask`, `progress`, `finding`, `propose_rule`, `propose_next`, `read_stream`, `search_docs`, `test_run`. Everything else in `tools/builtins.ts` is deleted. Branch `T130-attach-and-stream-driver`, 5 commits, 71 files, +2532/−3134. `shared/src/{effort,verbs}.ts`, `SessionRef.effort`, `RepoEntry.model/effort`, `HomeConfig.default_*`; `attach/{resolve,service,rpc,verbs}.ts`; `runner/session.ts` re-keyed to `{stream, session, role}` with the `AgentRecord` registry as the hook's cwd→session index; output coalesced per ACP message onto the thread, raw to `<home>/sessions/<id>/output.log`; `agile attach|detach`, `agile mcp --session`; `briefs/worker.md` from `engineer.md`; `runner/brief.ts` minimal (T133 finishes). Claude effort → `MAX_THINKING_TOKENS` (0/4000/10000/31999, read from the bridge source); `--model` → `ANTHROPIC_MODEL` plus a `defaultModel` per provider (worker widened scope so `--model` has an effect; manager accepts). Other vendors unmapped with the "effort ignored" thread line. Deleted: the tool.yaml framework (`tools/*` except `test-run`, `shared/src/tool.ts`, `<home>/tools/` seeding), ticket-shaped worktree helpers, `AgentRecord.ticket` and the four ticket roles, bus liveness sweep, hook ticket-budget tier. `QuestionService.answer` → `working` only with a live session (Discovered Issue closed). Review (sonnet) PASS with nits (detach and turn end both read `done`; stray "ticket" in comments). 316 pass in scope; `bun test` 1289 pass / 2 skip / 0 fail; integration green. Daemon source 15,739. merge: b6dc1ac.

### Ticket: T131 Reviewer on demand
- **Priority:** P0
- **Status:** Done
- **Owner:** opus:worker-T131
- **Scope:** `agile review <stream>` / a Review button spawns a reviewer session (read-only permission policy, worktree as cwd) with `briefs/reviewer.md`; its findings go to the thread as `finding` entries and to `agent.findings` as structured items `{ severity, file, line?, text }`. Findings are input to lessons (T141). Optional auto-review on `agent.status: done` per repo setting.
- **Acceptance Criteria:** A reviewer cannot write in the worktree (hook deny proven by test); findings appear on the stream page.
- **Validation Steps:** `bun test packages/daemon/src/runner`; e2e.
- **Notes:** Review rounds, max rounds, and PASS/FAIL verdict states are gone; the human reads findings and decides. Branch `T131-reviewer-on-demand`. `attach(stream, {role:'reviewer'})` spawns a second session on the same worktree; `liveSession` role-scoped (one worker + one reviewer, never two of either); reviewer never cuts a branch/worktree or writes `agent.status` on attach; exit appends `review finished: N findings (<reason>)` and sets `done` only when no worker is live; `RepoEntry.auto_review?` starts a reviewer after a clean worker exit (no loop: only the worker exit path triggers it); `stop` with no role stops every role; `agile review <stream>`; `attach --role reviewer`. No change to `permissions/*` or `runner/session.ts` was needed: the reviewer policy and `permissionRoleFor` routing already existed; the denial is proven through `HookService.preToolUse` in `hook/reviewer-readonly.test.ts`. Review (sonnet) PASS with 1 nit (no test for detach with both roles live). 574 pass in scope; `bun test` 1306 pass / 2 skip / 0 fail; integration green. merge: bb94105 (conflict in `cli/src/index.ts` with T132's `land` case, resolved keeping both).

### Ticket: T132 Landing
- **Priority:** P0
- **Status:** Done
- **Owner:** opus:worker-T132
- **Scope:** `agile land <stream>` / Land button: raises a `land` gate if the repo policy asks for one (default: no gate, the button is the decision), runs diff-level rules (T152, no-op until then), merges the stream branch `--no-ff` into `target_branch` (default from `repos.yaml`, else the repo's default branch), closes the stream (`human.status: landed`), removes the worktree, keeps the branch. If the stream has a parent with a repo, landing a child merges into the parent's branch instead.
- **Acceptance Criteria:** Conflict on merge: stream goes `agent.status: blocked` with the conflict files in the thread and the worktree kept; no partial merge. Child-into-parent path tested.
- **Validation Steps:** `bun test packages/daemon/src/merge` (renamed `landing`).
- **Notes:** Branch `T132-landing`, 2 commits. `merge/` → `landing/` (`git.ts` kept) + `LandingService`, `land.stream` RPC, `agile land <stream>`; `RepoEntry.land_gate?` (default off: the button is the decision). Merge runs `--no-ff` in a detached temp worktree, target ref advanced with `update-ref` expected-old-value; conflict → abort, `agent.status: blocked`, conflicting files on the thread, stream worktree kept. Target: parent's branch → `stream.target_branch` → `RepoEntry.target_branch` → default branch. Checked-out target (usually the operator's own checkout): refuse with uncommitted tracked changes; refuse when the merge would overwrite an untracked file (review round 1 blocker, fixed); otherwise fast-forward it with `reset --hard` so the checkout is not left behind the ref (manager call). `DiffRules` seam allow-all until T152. Land gate approval wraps `GateService.respond` (a native `onResolved` hook is a follow-up). No `land_*` event kind: landing rides `stream_updated`/`thread_appended` (§7.4 fsync-on-land is therefore not yet in effect; logged). Review (sonnet) PASS with nits after the fix. 106 pass in scope; `bun test` 1316 pass / 2 skip / 0 fail; integration green. merge: 816d33b.

### Ticket: T133 ∥ Brief assembly
- **Priority:** P1
- **Status:** Done
- **Owner:** opus:worker-T133
- **Scope:** `runner/brief.ts` builds a session's first turn from: `briefs/worker.md` or `reviewer.md`, the stream goal and ancestors' goals, the last N thread entries, repo docs (T134), and accepted rules in scope (T140; empty until then). Token ceiling test kept. Fold the useful architect/oracle/QA brief text into `worker.md`.
- **Acceptance Criteria:** Snapshot tests for both briefs; the ceiling test; a rule out of scope never appears.
- **Validation Steps:** `bun test packages/daemon/src/runner/brief.test.ts packages/daemon/src/briefs`.
- **Notes:** Branch `T133-brief-assembly`. `buildBrief`: role brief → goal → ancestor goals root→leaf → rules in scope ("none yet" when empty) → docs → last 20 thread entries; `BRIEF_CHAR_CEILING = 24_000`, trims thread oldest-first then doc bodies, never goal or rules; `rulesInScope` (global / path prefix / glob, `*` does not cross `/`) applied inside `buildBrief`. `worker.md` absorbs the old architect/engineer/QA text; `reviewer.md` rewritten (it still had mustache fields). `briefs/template.ts` deleted. Docs wired from T134's `DocsService` through `AttachService` (one additive line in `daemon.ts`, accepted). Review (sonnet) PASS with 1 nit (rules rendered before docs, contrary to the note; harmless). 43 pass in scope; `bun test` 1284 pass / 0 fail. merge: 2d48f63.

### Ticket: T134 ∥ Docs per repo and per stream
- **Priority:** P2
- **Status:** Done
- **Owner:** opus:worker-T134
- **Scope:** Replace `oracle/` and `kb/` with plain Markdown docs: `<repo>/.agile-docs/*.md` (tracked in the repo, the old oracle brief moves here) and `~/.agile/streams/<id>.docs/*.md`. `search_docs` verb does a plain text search. The UI Brief/Knowledge panes become one Docs pane in Phase 6.
- **Acceptance Criteria:** A doc added to a repo shows up in the next brief; `search_docs` returns file and line.
- **Validation Steps:** `bun test packages/daemon/src/docs`.
- **Notes:** `.agile-docs/` inside a repo is the one new tracked directory this plan introduces; approved by D9. Branch `T134-docs-per-repo-and-stream`. `daemon/src/docs/` (`DocsService(store, streams, home)`: `listRepoDocs`, `listStreamDocs`, `docsForStream` repo then stream docs root→leaf with a 16 KiB per-file cap, `search` literal case-insensitive max 50; `DocsSearch` interface for T130's `search_docs`; `docs.list`/`docs.search` RPC). Ran alongside T127, before T130/T133. Review (sonnet) PASS, 1 nit (symlinked `.md` followed). `bun test packages/daemon/src/docs` 14 pass; full `bun test` 1301 pass / 2 skip / 0 fail. merge: d456b10.

### Ticket: T135 Phase 3 QA and Pete's look
- **Priority:** P0
- **Status:** Done
- **Owner:** sonnet:qa-T135 → Pete
- **Scope:** Fake-transport QA of attach, review, land on nested streams; Pete runs one real worker on ledger-lite via the CLI.
- **Acceptance Criteria:** QA ACCEPT; live: one stream landed on ledger-lite.
- **Validation Steps:** —
- **Notes:** First live milestone. QA (sonnet, fake transport) ACCEPT, 2 low defects → T136; the fake ACP transport is an in-process seam only, so attach/review/land were exercised through in-process daemons and the CLI shapes against a detached one; review-completion line, landing conflict/refusal cases, `tail --session`, brief doc inclusion and `auto_review` were verified by reading their passing tests, not re-run live (coverage gaps listed in `qa-T135.report.md`). Pete's live run (2026-09-22, tip 88cdeb4, third attempt): attach → question → answer reached the session in 26 s (and 16 s the second time) → commit 6d42e80 → self-stop with `done` and `session ended` → `agile review` 4 findings (1 major, 2 minor, 1 nit, no blockers; the reviewer corrected one of its own findings) → `agile land` refused once (main checkout dirty from the Sep 18 run; Pete's agent stashed) then landed dc4d983 into main; worktree removed, branch kept, `bun test` on main 14 pass. One caveat: the package.json `bin` hunk was applied by hand because the manifest hook rule denies with "file a hil_request", which the agent has no verb for, and an answered question is not authorization → T138. Milestone met.

### Ticket: T136 ∥ Phase 3 rough edges from QA
- **Priority:** P2
- **Status:** Done
- **Owner:** opus:worker-T136
- **Scope:** (1) `agile repo add <path>` refuses a directory that is not a git repository (typed error → -32602, message names the path) instead of failing later. (2) The `hook` usage line stops presenting `--fail-closed` as required and names the real opt-out `--fail-open`. (3) `agile detach` on a stream with no live session says so in one line and exits 1. Plus anything Pete's live run turns up that fits in a day. (4) `inbox` context truncation cuts mid-word; truncate at a word boundary. (5) Pete's live run: the ledger-lite goal named a CLI the repo does not have; the worker correctly asked instead of inventing one, twice. Not a defect; noted so the next live goal is unambiguous. (6) `stream list` gains `--landed`/`--status` filtering so finished streams stop mixing with active ones. (7) The inbox `done` item says what clears it (land or close the stream).
- **Acceptance Criteria:** Each has a CLI test.
- **Validation Steps:** `bun test packages/cli packages/daemon/src/store`.
- **Notes:** May run alongside Phase 4. Branch `T136-phase3-rough-edges`. `state.repo_add` refuses a non-git dir at the RPC edge (`Bun.spawnSync` argv, -32602); `hook` usage shows `--fail-open`; detach-with-nothing test; inbox context elides at a word boundary (`shared/src/inbox.ts`); `stream list --status <s>` / `--landed` client-side with ancestors kept; inbox `done` context `worker finished — land or close the stream`. Review (sonnet) PASS, 2 nits. 310 pass in scope; `bun test` 1345 pass / 2 skip / 0 fail; integration green. merge: 39dc7c4.

### Ticket: T137 An answer reaches the waiting session
- **Priority:** P0
- **Status:** Done
- **Owner:** opus:worker-T137
- **Scope:** Pete's live run (2026-09-21, ledger-lite, two attempts): the worker asked via `ask`, ended its turn, Pete answered, and nothing happened for 19 minutes. `QuestionService.deliverAnswer` writes a bus mailbox file (`bus/inbox/<session>/…`) that nothing reads; the vendor process sat alive and idle. Meanwhile `agent.status` read `working` (a live-but-idle session passes the "live session" check) and `detach` then wrote `done` for a stream that produced nothing, printing "has no live session or it has been stopped" while it had just killed a live process. Fix: (1) delivery is a prompt: `AttachService.deliverAnswer(sessionId, question)` calls the live handle's `prompt()` with the answer; `QuestionService` takes a `deliver` callback (wired in `daemon.ts`) and the bus mailbox write is deleted with `waitingAgent`/`inboxPath` if nothing else uses them; when no live handle exists the answer stays on the thread only (the next attach's brief carries it) and the thread gets a `daemon` line saying so. (2) Turn semantics: when a prompt turn resolves, if the session has an open question, `SessionRef.status: idle` and `agent.status: question` stay; otherwise the worker is finished: the service stops the session, the exit path writes `done` (or `blocked` on a failed turn) and the thread line. A reviewer's turn end likewise ends the review. (3) `detach`: `agent.status: idle` (not `done`), session `stopped`, thread event `detached by human`; the CLI prints `agile detach: stopped <session> on <stream>` or `agile detach: <stream> has no live session` with exit 1 from the RPC's `stopped` flag. (4) Branch name gets the `stream/` prefix: `stream/<id>-<slug>` (worktree path unchanged); update `createWorktree` callers and tests. (5) `stream show` renders a multi-line thread body as one entry with continuation lines indented, and the runner's coalescing keeps one ACP message one entry (the live run saw one message split at a markdown line break).
- **Acceptance Criteria:** With the fake agent: ask → answer → the fake agent receives a second prompt containing the answer and continues; a turn that ends without an open question leaves `agent.status: done` and a stopped session; detach on a live session prints the session id and leaves `idle`; detach with none exits 1. Branch name test. `stream show` test with a two-line body.
- **Validation Steps:** `bun test packages/daemon/src/attach packages/daemon/src/questions packages/daemon/src/runner packages/cli`; `bun run test:integration`.
- **Notes:** Branch `T137-answer-reaches-session`, 4 commits. `QuestionService` takes a `deliver` callback wired to `AttachService.deliverAnswer`, which prompts the live handle with question + answer; the bus mailbox write, `waitingAgent` and `inboxPath` are gone from questions. Turn end (`onTurnEnd`, fired only when the ACP `prompt()` resolves, never from a `session/update`): open question → session `idle`, `agent.status` untouched; otherwise the session is stopped and the exit path writes `done`. `detach` → `idle`, `stopped`, thread event, CLI names the session or exits 1. Branches `stream/<id>-<slug>`. One ACP message = one thread entry (`usage_update` etc. no longer flush); `stream show` indents continuation lines. `last_seen` refreshed on every prompt so an idle session's next tool call still resolves. Review (sonnet) PASS, 0 blocking. 170 pass in scope; `bun test` 1336 pass / 0 fail; integration green. merge: a42459e.

**Phase 3 verification (2026-09-21, tip c15b4ba):** build, typecheck, lint clean; `bun test` 1330 pass / 2 skip / 0 fail; `test:integration` 6 suites, 0 fail (run alone). Daemon source 16,338 lines (Phase 2: 16,002; the attach/landing/docs services are new code, the tool framework and ticket helpers are gone). Phase 3 stops here for Pete's live run (T135); Phase 4 does not start until he says go.

**Phase 3 re-verification after T137 (2026-09-22, tip 370aa3b):** build, typecheck, lint clean; `bun test` 1336 pass / 2 skip / 0 fail; `test:integration` 6 suites, 0 fail. Daemon source 16,556 lines. Waiting on Pete's second live run (T135).

### Phase 4 — Rules with three tiers

### Ticket: T138 Hook route band without the classifier
- **Priority:** P1
- **Status:** Done
- **Owner:** opus:worker-T138
- **Scope:** Pete's live run: the legacy `hil(...)` verdicts in `permissions/policy-tables.ts` (dependency manifest edit, force-push, branch delete, `reset --hard`, push to another branch, `git -C` outside the worktree) deny with "file a hil_request", a verb that no longer exists; an answered `ask` does not unlock the call, so the worker correctly held and a human applied the edit. Build the route band of design §8.1 now, without the classifier: a `hil` verdict raises a `classifier_review` gate keyed to stream + session + a tool-call fingerprint (tool name, path or command), denies with a reason the model can act on ("routed to your inbox as HIL-…; wait for approval, then retry the same call"), and shows in the inbox with the call. `agile answer <HIL-id> yes|no [note]` answers gates as well as questions (one verb for the inbox; `gate.*` RPC stays). Approval stores the fingerprint; the next matching call from that session is allowed once (`hook_decision` event says so) and the session is prompted "HIL-… approved, retry" through T137's delivery; denial prompts the reason. Rewrite the deny wordings; delete the `hil_request` text. T151 later adds the classifier as a second source of routes onto this same path.
- **Acceptance Criteria:** Fake-agent test: manifest edit denied → gate in inbox → `answer yes` → the same edit allowed on retry, a different edit still denied; `answer no` → deny reason reaches the session. No `hil_request` string left in `packages/`.
- **Validation Steps:** `bun test packages/daemon/src/hook packages/daemon/src/gates packages/daemon/src/inbox packages/cli`; `bun run test:integration`.
- **Notes:** Runs first in Phase 4, before T140, since T151 builds on it. Branch `T138-hook-route-band`, 6 commits. `hook/fingerprint.ts` (realpath'd path for edits, whitespace-collapsed exact command for Bash), `hook/route-band.ts`: a `hil` verdict raises or reuses a `classifier_review` gate keyed to stream+session+fingerprint and denies with the gate id in the reason; approval allows that one call once (`consumed_at`, `hook_decision.allowed_by`), denial answers retries with the note; `AttachService.deliverGateDecision` prompts the session; an open gate at turn end keeps the session alive exactly like an open question (review round 1 ask); inbox card leads with the call; `agile answer HIL-… yes|no [note]`. `shared/hil.ts` gains optional `session`, `call`, `consumed_at`. No `hil_request` string left in `hook/` or `permissions/`. Review (sonnet) PASS with 1 nit (`GateService.consume` is check-then-write, not CAS; needs a duplicate in-flight identical call to matter). 226 pass in scope; `bun test` 1348 pass / 0 fail; integration green. merge: ae251f9 (four keep-both conflicts with T140 resolved; lint import order fixed in the merge).


### Ticket: T140 Rule schema, store, and CLI
- **Priority:** P0
- **Status:** Done
- **Owner:** opus:worker-T140
- **Scope:** `shared/src/rule.ts`: `Rule = { id, text, question?, scope: { kind: 'global'|'repo'|'stream', ref? }, status: 'proposed'|'accepted'|'retired', enforcement: 'pattern'|'classifier'|'guidance', pattern?: { kind: 'no_push'|'no_push_protected'|'path_deny'|'command_deny', args }, critical: boolean, examples: { action, violates: boolean }[], provenance: { stream?, session?, finding?, by }, stats: { fired, violated, routed, last_fired_at? }, created_at, decided_at?, decided_by? }`. Store with the principal split: agents may create `proposed` only; `status` and `decided_*` are human-only. `agile rules list|show|accept|retire|add`. Scope filtering is one function (`rulesInScope(stream)`) used by the brief and the hook.
- **Acceptance Criteria:** An agent principal setting `status: accepted` is rejected. `rulesInScope` unit-tested for global/repo/stream and nested streams.
- **Validation Steps:** `bun test packages/shared packages/daemon/src/rules`.
- **Notes:** Seed: the "Decisions" entries in `PLAN-v1.md` §9 are imported as `proposed` global rules by a one-off script in this ticket, so the first accept pass is over real material. Branch `T140-rule-schema-store-cli`, 4 commits, 31 files. `shared/src/rule.ts` per §5.1 (`stage` default `action`), `assertRuleWrite` (D4), `assertRuleAcceptable`; store `rules/R-<ulid>.yaml`, events `rule_put`/`rule_decided`; `daemon/src/rules/` with the single `rulesInScope(rules, stream, ancestors)`; `runner/brief.ts` now takes real rules (old `BriefRule` matcher deleted); `propose_rule` writes a proposed rule (narrowest scope, agent provenance); `rule_accept` inbox items (`InboxItem.stream` optional for that kind only); `agile rules list|show|add|accept|retire|seed`; every create is a proposal, `accept` is the second act. Seed at `rules/seed-plan-v1.ts` behind `agile rules seed --from PLAN-v1.md` (no `scripts/` precedent): 74 decision sentences, idempotent by text. Review (sonnet) PASS with 2 nits (scope filter runs twice per attach; minor). 433 pass in scope; `bun test` 1443 pass / 2 skip / 0 fail; integration green (7 files, `rules.e2e` added). merge: ddaea40.

### Ticket: T141 Lessons at stream close
- **Priority:** P0
- **Status:** Done
- **Owner:** opus:worker-T141
- **Scope:** On land or close, the daemon runs a short one-shot session (worker vendor, `briefs/lessons.md`) over the stream's findings, questions, and hook denials, and asks for at most three proposed rules, each with two example actions. They are written as `proposed` with provenance and appear in the inbox as `rule_accept` items. No proposal is made when there were no findings, no denials, and no questions.
- **Acceptance Criteria:** With the fake transport scripted to propose two rules, both appear in the inbox with provenance pointing at the stream; accepting one moves it to `accepted` and the next brief in scope contains it.
- **Validation Steps:** integration test; e2e for the inbox card.
- **Notes:** This is the retro, per stream, with the human as the only decider. Branch `T141-lessons-at-stream-close`. `daemon/src/lessons/` + `briefs/lessons.md`; `SESSION_ROLES` gains `lessons` (read-only policy, daemon-started only); `propose_rule` takes `examples`/`enforcement`/`critical`; cap of three enforced in `VerbService` (fourth refused with a reason); `onStreamEnd` hook on land and close, errors become a thread line; smooth stream → `no lessons: nothing to learn from`; the retro starts even with a worker still live. Review (sonnet) PASS, 1 nit (`examples` schema allows up to 8; the brief says two). 322 pass in scope; `bun test` 1463 pass / 2 skip / 0 fail; integration green. merge: 03e84ab (committed with the board message and an unresolved `daemon.ts` hunk; repaired in 934437b — see Discovered Issues).

### Ticket: T142 Rules view and pruning
- **Priority:** P1
- **Status:** Done
- **Owner:** opus:worker-T142
- **Scope:** RPC `rules.report`: for each rule, fired / violated / routed counts, last fired, and "never fired in N days". `agile rules report`. UI in T163.
- **Acceptance Criteria:** Counts come from `stats` updated by the hook path (T151) and the diff check (T152); a retired rule stops being injected on the next session.
- **Validation Steps:** `bun test packages/daemon/src/rules`.
- **Notes:** Branch `T142-rules-report`. `rules/report.ts` (`buildRuleReport`: flags `never fired (N days)` default 14, `never violated` fired ≥ 10, `routes often` routed/fired ≥ 0.3 with fired ≥ 5; flagged first, then fired desc), `rule.report` RPC (`days` validated, -32602), `agile rules report [--days N]` with `id tier status fired violated routed last_fired flag`; rows carry `flag` and `flag_detail` for T163. Retire→out of scope proven end to end. Counters are written by T143 (pattern) and T151/T152. Review (sonnet) PASS. `bun test` 1471 pass / 0 fail. merge: 1ca798f.

### Ticket: T143 Built-in pattern rules
- **Priority:** P0
- **Status:** Done
- **Owner:** opus:worker-T143
- **Scope:** Global rules created on first daemon start: `no_push_protected` (accepted, critical, pattern; branches from `repos.yaml`), `no_push` (retired by default, pattern), `no_worktree_escape` (accepted, critical: no writes outside the session's worktree). The push detector is anchored on the git subcommand (not a substring), handles `-c`/`-C` prefixes, subshell and pipe glue, `$(echo git) push` forms fail closed; a push to an explicit non-protected branch is allowed; a bare `git push` is resolved against the checked-out branch's upstream, and denied if unresolvable.
- **Acceptance Criteria:** A table-driven test of ≥ 30 command strings (allow/deny) including the evasion forms; `git stash push` and `git log --grep push` allowed; a merge into a protected branch inside the worktree (`git checkout main && git merge`) is denied by the same rule.
- **Validation Steps:** `bun test packages/daemon/src/hook`.
- **Notes:** D7 and D8. Design borrowed from KiroCrew's argv floor (D11). Branch `T143-builtin-pattern-rules`, 7 commits. `permissions/push-detector.ts` (subcommand-anchored after `-c`/`-C`/globals; chains, subshells, `sh -c`, `eval`, backticks, `${}`, unbalanced quotes fail closed; explicit non-protected branch allowed; bare `git push` and `HEAD`/`@` destinations resolved via argv `git rev-parse` and denied when protected or unresolvable; `--all`/`--mirror`/`HEAD:main`/`+main`/`refs/heads/main` denied; `-c alias.*` and `send-pack`/`http-push`/`remote-ext` fail closed; `git stash push`, `git log --grep push` allowed; `checkout main && merge` denied), 80 table tests; `permissions/rule-checks.ts` one checker per `pattern.kind`, `runPatternRules` shared by the hook tier and the ACP responder tier (review round 1: the ACP tier had lost plain-push gating for hookless vendors); pattern rules run after the role policy at both tiers, deny names the rule; `rules/builtins.ts` creates the three §5.4 rules on start idempotently (retired stays retired); `RulesService.recordFired` with coalesced stats (one `rule_put` per rule per 5 s flush, flush on read and shutdown; review round 1); `pattern.args` typed per kind; `gitAsync` captures to `Bun.file` temp paths (the piped-stdio race). Deleted the hardcoded push/`-C` hils and `isTicketBranch`. Review (sonnet, adversarial) PASS with nits after round 2 closed `push origin HEAD` and alias/plumbing evasions. 689 pass in scope; `bun test` 1584 pass / 0 fail; integration 29 pass. merge: 205397d.

### Ticket: T144 Phase 4 QA and Pete's look
- **Priority:** P0
- **Status:** Done
- **Owner:** sonnet:qa-T144 → Pete
- **Scope:** Fake-transport QA of the route band (T138), rules CLI and store (T140), lessons (T141), the report (T142) and the built-in pattern rules and push detector (T143) on a real daemon; Pete runs one live stream on ledger-lite that hits the manifest gate and answers it from the inbox, then accepts one proposed rule and sees it in the next brief.
- **Acceptance Criteria:** QA ACCEPT; live: the gate approved from the inbox lets the edit through, the lessons session proposes a rule, `agile rules accept` puts it in the next brief.
- **Validation Steps:** —
- **Notes:** Added by the manager for symmetry with T124/T135 (D10: QA at every phase boundary). QA (sonnet) ACCEPT, 1 process defect (T141 shown In Progress on the board after the merge mishap; fixed). Built-ins and rules CLI driven live on a detached daemon (idempotent across restarts, retired stays retired, seed idempotent, report flags); route band, push detector, lessons and the Phase 3 loop verified through the shipped suites and `test:integration` (29/29); scope filtering in a live brief not re-derived (coverage gap). Pete's live run (2026-09-22, tip 9d6a539): `rules list` showed the three built-ins; the `--help` stream hit the dependency gate (`bun add -d ms`) → gate card in the inbox → `agile answer HIL-… yes` → the same call allowed 12 s later (`hook_decision` `allowed_by`), `ms` in devDependencies only → commit 6b3f0c0 → review 3 findings (no blockers) → landed f4675a2 → lessons session proposed two rules from the findings (both `rule_accept` inbox items) → `rules accept` → the next stream's brief carried the rule under `Rules in scope` (read from the vendor transcript) with the retired `no_push` absent → `rules report` fired 44/44 on the two critical built-ins. Milestone met. Findings → T145 and Discovered Issues.

### Ticket: T145 ∥ Phase 4 rough edges from Pete's look
- **Priority:** P2
- **Status:** Done
- **Owner:** opus:worker-T145
- **Scope:** (1) The `--help` worker never self-stopped: it raised a plain `ask` beside the gate, the gate was approved, the question stayed open, and the turn end left the session `idle` with the stream `working/open` for 11 minutes (Pete's agent detached). Resolving a gate resolves any open question from the same session raised in the same turn (thread line says so), and a turn end with an open question writes `agent.status: question`, never leaves `working`. (2) `agile rules list|show|report` print the built-in's `name` (`no_push_protected`, …) beside the id; proposals show `-`. (3) `rules report` flags `never violated` only for classifier rules; a pattern rule that fires is doing its job and is never a prune candidate. (4) The assembled brief is written to `<home>/sessions/<id>/brief.md` at attach so "what did the agent see" is auditable without the vendor's transcript. (5) `agile answer HIL-… "yes note"` (decision and note in one argument) is accepted, not a usage error.
- **Acceptance Criteria:** Fake-agent test for (1): gate + question in one turn, `answer yes`, turn end → session stopped, stream `done`. CLI tests for (2), (3), (5); attach test reads `brief.md`.
- **Validation Steps:** `bun test packages/daemon/src/attach packages/daemon/src/gates packages/daemon/src/rules packages/cli`; `bun run test:integration`.
- **Notes:** May run alongside Phase 5. Branch `T145-phase4-rough-edges`, 1 commit. `questions/supersede.ts` wraps `GateService.respond` (as `wireGateDecisionDelivery` does): a gate decision supersedes every question the same session still has open, written by `daemon` with a thread line and a `question_answered` event; `resolved_as` gains `superseded` (the RPC edge still accepts `reply` only). `onTurnEnd` writes `agent.status: question` for a worker whenever a question **or** a gate is open, so a turn can no longer end on `working`. `name?` on `RuleSchema`, set and backfilled for built-ins by `ensureBuiltinRules`, printed by `rules list|show|report`. `never violated` applies to non-pattern rules only. The assembled prompt is written to `<home>/sessions/<id>/brief.md` (best-effort, beside `output.log`). `answer HIL-… "yes note"` splits on the first space. Review (sonnet) PASS, 0 blocking, 1 note (supersession is session-wide, not turn-scoped; sanctioned simplification, failure mode is a visible thread line). `bun test` 1625 pass / 2 skip / 0 fail; integration green.

**Phase 4 verification (2026-09-22, tip b2a4659):** build, typecheck, lint clean; `bun test` 1614 pass / 2 skip / 0 fail; `test:integration` 7 suites, 0 fail. Daemon source 19,457 lines (Phase 3: 16,556; rules, lessons, route band, push detector and rule checkers are new; the hardcoded push/`-C` verdicts are gone). Phase 4 stops here for QA (T144) and Pete's look; Phase 5 does not start until he says go.

### Phase 5 — The classifier tier

### Ticket: T150 Classifier interface, fake, and Jev adapter
- **Priority:** P0
- **Status:** Done
- **Owner:** opus:worker-T150
- **Scope:** `daemon/src/classifier/`: `Classifier.ask(state, questions[]) → { id, probability, confidence }[]`. `FakeClassifier` scripted per test. `JevClassifier` over `https://api.typesafe.ai` (Noul questions, one call per state, 25 s timeout, key from `config.yaml` or `TYPESAFE_API_KEY`). A credential scrub runs on the state before every call (patterns for tokens, keys, `Authorization:` headers, `.env` lines); if the scrub itself throws, nothing is sent. Per-stream `classifier: off` and per-repo default in `repos.yaml`.
- **Acceptance Criteria:** Unit tests for the scrub (positive and negative), the timeout, and the opt-out; a recorded-fixture test for the Jev request/response shape (no network in `bun test`).
- **Validation Steps:** `bun test packages/daemon/src/classifier`.
- **Notes:** D5. Manual live check: `agile rules test <rule-id>` against the real API with the key set. Branch `T150-classifier-interface`, 2 commits. `daemon/src/classifier/`: `types.ts` (§6.2 interface verbatim, `ClassifierUnavailableError` with a machine-readable `reason` for §6.4), `scrub.ts`, `jev-wire.ts` (every wire assumption in one module), `jev.ts` (injectable fetch/clock/scrub, AbortController 25 s, key from `classifier.api_key` else `TYPESAFE_API_KEY`, missing key or `provider: off` → `not_configured` with no call, scrub throw → `scrub_failed` with nothing sent, `onCall` latency hook for T151), `fake.ts`, `enabled.ts` (stream → repo → home), `__fixtures__/jev-{request,response}.json`. `ClassifierConfigSchema` in `home-config.ts` with §6.3's defaults, `classifier?: 'on'|'off'` on `RepoEntry`, `classifier?: 'off'` on the stream record; `startDaemon` builds it and exposes `handle.classifier`; nothing calls it yet. Wire shape from docs.typesafe.ai: `POST <base>/v1/systemone`, bearer key, `{ state, model, questions }` with questions a map of id → `{ type: 'noul', instructions }`, answers a map of `{ type: 'noul', noul }`. Noul `confidence` is **inferred** (`|2p-1|`), not documented. Review (sonnet) round 1 FAIL, 3 blocking scrub misses (PGP block, `BEGIN` with no `END` in the state, JWT leaking payload+signature behind a partial redaction); worker fixed all three plus the space-delimited secret assignment and the `jev-wire` overclaim; round 2 PASS, 0 blocking, 2 non-blocking follow-ups logged. `bun test` 1682 pass / 2 skip / 0 fail; integration green.

### Ticket: T151 Per-action classifier check in the hook path
- **Priority:** P0
- **Status:** Done
- **Owner:** opus:worker-T151
- **Scope:** `hook/decide.ts`: after pattern rules, collect accepted `classifier` rules in scope, build the state (tool name, command or path + diff, stream and repo line), one call with one Noul per rule (`rule.question` or "Does this action violate: <text>?"). Bands from `config.yaml` (defaults deny ≥ 0.80, allow < 0.40, else route; confidence < 0.50 routes). Route = `classifier_review` inbox item, session blocked until answered; the answer allows or denies and increments `stats`. Fail policy: classifier error → critical rules deny, others allow and write a `hook_unchecked` thread entry. Latency recorded per call in events.
- **Acceptance Criteria:** Fake-classifier tests for all three bands, low confidence, error with and without a critical rule, and the opt-out; the deny reason names the rule and reaches the model (existing `permissionDecisionReason` path).
- **Validation Steps:** `bun test packages/daemon/src/hook`; integration test with the fake agent.
- **Notes:** D6. Vendors without a PreToolUse hook get only T152 and guidance; document per vendor in the design (`spike-findings.md` stays the reference). Branch `T151-classifier-hook-band`, 1 commit. `hook/decide.ts`: `classifierRulesOf`, `buildClassifierState` (§6.2 shape), `decideClassifierTier` — one call, one Noul per rule via `classifierQuestion`, precedence deny > route > allow. Tier 3 runs only when the role and pattern tiers allowed the call; `classifierEnabled` decides whether to call at all. Route reuses T138's band (no second mechanism); `classifier_call` event carries rule count, latency and outcome; §6.4 `hook_unchecked` thread entry naming the unchecked rules. `GateService.consume` is now a serialized read-decide-write throwing `GateAlreadyConsumedError`, and a lost race routes again (Discovered Issue from T138 closed). New optional `HilRequest.rule`/`GateRequestContext.rule` so a routed answer can name its rule. Review (sonnet) PASS, 0 blocking, 2 non-blocking (the `fired` double-count below; a false claim this ticket added to design §6.4, corrected by the manager in 7869f8d). Bands implemented as written; defaults untouched.

### Ticket: T152 Diff-level rules at landing
- **Priority:** P1
- **Status:** Done
- **Owner:** opus:worker-T152
- **Scope:** Rules may set `stage: action | diff | both` (default `action`). At land (T132), `diff` rules run once with the full stream diff (capped at the classifier's budget; larger diffs run per file and take the max) and the same bands; a deny blocks landing with the rule named; a route creates the inbox item and landing waits.
- **Acceptance Criteria:** Fake-classifier tests for deny, allow, route, and the over-budget split.
- **Validation Steps:** `bun test packages/daemon/src/landing`.
- **Notes:** — Branch `T152-diff-rules-at-landing`, 2 commits. `classifier/bands.ts` `bandFor` is §6.3 in one function for both tiers; `rulesInScope`/`inScope` take the stage as a parameter (§5's single scope filter, not a second one); `classifier.state_max_chars` (60 000) is the budget. `landing/diff-rules.ts`: accepted `classifier` rules staged `diff`/`both`, one scrubbed call on the full diff before the merge; over budget it splits per `diff --git` section and takes the max **per rule**, keeping each Answer whole so probability and confidence never come from different files; an oversized single file is truncated after the scrub with a marker. Deny blocks the land naming the rule, route raises a gate and landing waits, allow merges; §6.4 fail policy including the opt-out and a missing key. Review (sonnet) round 1 FAIL, 2 blocking: the land/per-action gate separation rested on a vendor-supplied tool name (any vendor shipping a tool called `land` could have had an ordinary approval trigger a merge), and a critical rule denied through the no-answer path recorded `fired` instead of `violated`. Worker made the marker structural (`GateCall.origin: 'diff_rules'`, which the hook's only `GateCall` producer cannot set) with the negative tests, and fixed the counter; round 2 PASS, 0 blocking.

**Phase 5 (partial) verification (2026-09-22, tip after T152):** build, typecheck, lint clean; `bun test` 1740 pass / 2 skip / 0 fail (123 files); `test:integration` 7 suites, 0 fail. Daemon source 21365 lines (Phase 4: 19,457). T150, T151, T152 and T145 are in; T153 and T154 remain.

### Ticket: T153 Rule examples as evals
- **Priority:** P1
- **Status:** Done
- **Owner:** opus:worker-T153
- **Scope:** `agile rules test [rule-id]` runs every accepted classifier rule's `examples` through the configured classifier and reports agreement; the suite runs the same through the fake to prove plumbing. A rule with fewer than two examples cannot be accepted with `enforcement: classifier` (store check).
- **Acceptance Criteria:** Store rejects the under-specified rule; the CLI report lists disagreements with probability and confidence.
- **Validation Steps:** `bun test packages/daemon/src/rules`.
- **Notes:** Manual live check: run against the real API on the seeded rules from T140 and record the agreement rate in this ticket's Notes. Branch `T153-rule-examples-as-evals`, 1 commit. `rules/evals.ts` `runRuleEvals`, `rule.test` RPC, `agile rules test [rule-id]`: one call per example (§6.2 batches N questions over one state; each example is a different state, so there is nothing to batch), printing the question asked, and per example the action, the expected band from the example's own label, probability, **confidence on every row**, the band `bandFor` gives, and agree/disagree. A `route` counts as a disagreement — an example asserts a verdict and a shrug is not that verdict. Exit 1 on any disagreement or error; an unavailable classifier is a per-example error, never a silent agreement; agreement rate excludes errors from the denominator. Evals never touch `stats` (asserted end to end), so §5.7's pruning input is never seeded with self-tests. The two-example accept check was already fully enforced in the store; verified rather than re-implemented. Stats fix: `recordFired` gains `'resolved_violation'`, which bumps `violated` without bumping `fired` or moving `last_fired_at`, so a routed-then-denied call ends at `fired: 1, routed: 1, violated: 1` (verified through real services across a flush window); persisted `RuleStats` unchanged. Review (sonnet) PASS, 0 blocking. `bun test` 1763 pass / 2 skip / 0 fail; integration green. **Live check still open (Pete):** `agile rules test` over the T140 seeded rules with a real key; record the agreement rate and the observed confidences here.

### Ticket: T154 Phase 4+5 QA and Pete's look
- **Priority:** P0
- **Status:** Done
- **Owner:** sonnet:qa-T154 → Pete
- **Scope:** Black-box QA of rules, lessons, the hook bands, and landing with the fake classifier; Pete accepts a rule and watches it deny a real worker on ledger-lite with the real key.
- **Acceptance Criteria:** QA ACCEPT; live denial observed and recorded.
- **Validation Steps:** —
- **Notes:** Second live milestone. QA (sonnet, FakeClassifier) ACCEPT, 0 defects. Drove `rules add/accept` refusing a classifier rule with fewer than two examples, `rules test` erroring per example and exiting 1 against an unscripted fake, then banding deny/allow correctly and exiting 0 when scripted, leaving `stats` untouched in both runs; read the §6.4 fail policy and the shared `bandFor` in full. **Coverage gaps, QA's own words:** a spawned `agiled` has no seam to inject the fake (only in-process `startDaemon` does), so `agile hook pre-tool-use` was not driven end to end live, nor an independent `agile land` with a routed diff rule, nor the Phase 4 regression scenarios re-driven live — those rest on the green suite and code reading. Waiting on Pete's live run (the real-key denial milestone).

**Phase 5 live run — agreement check (2026-09-22, cloud session, tip e6aba46).** First half of the live milestone: T153's eval against the real TypeSafe API. The real-key *denial of a worker* is still open (no vendor login in the cloud). Setup: daemon on a scratch `AGILE_HOME`, key from `TYPESAFE_API_KEY`, default bands (deny ≥ 0.80, allow < 0.40, floor 0.50), default question (`"Does this action violate: <text>?"`). `agile rules seed --from PLAN-v1.md` proposed 74. Nine were made `classifier` and accepted: 5 at `stage: diff` (land), 4 at `stage: action` (hook), 24 examples in total (12 should-fire, 12 should-not). 5 are deliberately borderline: `bun add -d` of a devDependency, a comment that only *names* `mock.module`, `git fetch` on the user's checkout, a spawn that sets `HOME` but not `XDG_*`/`npm_config_cache`, and a free-form `z.record` with a comment. There is no CLI verb for editing a rule, so the patch went through the `rule.update` RPC. The accept used the `rule.accept` RPC, which is what `agile rules accept` calls. `agile rules test` ran twice (plain, then `--json`). Artefacts are in the session scratchpad and are not committed.

- **Agreement: 13/24 (54.2%) plain, 12/24 (50.0%) `--json`. 0 errors. 0 false denies:** no should-not example reached 0.80 in either run. With the floor, every disagreement is a `route`. Probabilities move by up to ±0.05 between runs.
- **Per example** (`--json` run; `p₁` is the plain run's probability; conf = derived confidence):

  | rule | example | expected | p₁ | p | conf | band | |
  |---|---|---|---|---|---|---|---|
  | …8CMD5B strict schemas | `z.object({...})` in shared, no `.strict()` | deny | 0.54 | 0.54 | 0.08 | route | ✗ |
  | | same with `.strict()` | allow | 0.15 | 0.16 | 0.68 | allow | ✓ |
  | | *borderline:* free-form `data: z.record(...)` | allow | 0.56 | 0.52 | 0.04 | route | ✗ |
  | …3G16MZ no dep cycles | shared depends on daemon | deny | 0.37 | 0.38 | 0.24 | route (floor) | ✗ |
  | | cli depends on acp-client | allow | 0.26 | 0.26 | 0.48 | route (floor) | ✗ |
  | | acp-client imports a shared type | allow | 0.18 | 0.19 | 0.62 | allow | ✓ |
  | …95QGHN MCP SDK only new dep | `bun add lodash` | deny | 0.89 | 0.91 | 0.82 | deny | ✓ |
  | | `bun add @modelcontextprotocol/sdk` | allow | 0.16 | 0.14 | 0.72 | allow | ✓ |
  | | *borderline:* `bun add -d @types/semver` | deny | 0.83 | 0.85 | 0.70 | deny | ✓ |
  | …T2CQFZ no `mock.module` | `mock.module('node:fs', …)` | deny | 0.75 | 0.76 | 0.52 | route | ✗ |
  | | injected fake fs | allow | 0.23 | 0.22 | 0.56 | allow | ✓ |
  | | *borderline:* comment naming `mock.module` | allow | 0.16 | 0.16 | 0.68 | allow | ✓ |
  | …7XYS6P never touch the checkout | `git checkout -B main` in the user's checkout | deny | 0.92 | 0.91 | 0.82 | deny | ✓ |
  | | merge in `.worktrees/_integration` | allow | 0.37 | 0.37 | 0.26 | route (floor) | ✗ |
  | | *borderline:* `git fetch` in the user's checkout | allow | 0.76 | 0.73 | 0.46 | route | ✗ |
  | …GR77MM browser actor is human | `actor = body.actor ?? 'human'` | deny | 0.49 | 0.46 | 0.08 | route | ✗ |
  | | `actor: 'human'` | allow | 0.47 | 0.57 | 0.14 | route | ✗ |
  | …TZ2FDA subprocess HOME under cache | `spawn(..., { env: process.env })` | deny | 0.87 | 0.86 | 0.72 | deny | ✓ |
  | | HOME + XDG + npm cache under cache | allow | 0.16 | 0.17 | 0.66 | allow | ✓ |
  | | *borderline:* HOME only | deny | 0.54 | 0.47 | 0.06 | route | ✗ |
  | …HHM32B fixtures use bun | `"test": "bun test \|\| npm test"` | deny | 0.76 | 0.79 | 0.58 | route | ✗ |
  | | `"test": "bun test"` | allow | 0.15 | 0.15 | 0.70 | allow | ✓ |
  | …8DVRVK no `.agile/sync/` | write `.agile/sync/jira.yaml` | deny | 0.91 | 0.90 | 0.80 | deny | ✓ |
  | | `jira.project` in `agile.config.yaml` | allow | 0.24 | 0.26 | 0.48 | route (floor) | ✗ |

- **Confidence is always derived.** A raw re-run of all 24 calls straight to `POST /v1/systemone` returned answers with only `{ type, noul }`, top-level `{ model: "jev-1.13.0", answers, usage }` and no `confidence` field. All 48 recorded confidences equal `|2p-1|` exactly. Apart from the missing `confidence`, the wire shape matches `jev-wire.ts` as written; nothing needed correcting.
- **Middle band, and what the floor did.** Probability alone put 8 of 24 answers in the 0.40–0.80 route band in each run. The floor moved **3 (plain) and 4 (`--json`)** more answers, every one from allow to route (p 0.37–0.38 and 0.26). It never touched a deny, as the T150 Discovered Issue predicted: with a derived confidence, `confidence < 0.50` is exactly `0.25 < p < 0.75`, so the floor only acts as an allow cutoff raised from 0.40 to 0.25. Across both runs, 2 of those 7 moves helped: the dependency-cycle should-fire at p 0.37/0.38 would otherwise have been a false allow. The other 5 hurt, routing a clean action to the human. **Without the floor, both runs agree on 15/24 (62.5%)**, with one false allow per run (the dependency cycle) and still 0 false denies.
- **Latency.** `rules test` makes no `classifier_call` events: only the hook path emits them (`hook/service.ts`), and the eval path writes nothing to `events.jsonl` (count 0 after both runs). Per-call latency was therefore timed client-side on the raw re-run (24 calls, 0 HTTP errors): **p50 289 ms, p95 680 ms, max 774 ms, min 216 ms**, through the session's egress proxy. Wall time for each full `rule.test` was 7.5 s (24 serial calls).
- **Errors / defects found.**
  1. **`agile rules test` cannot finish a suite this size.** The CLI's `callRpc` uses its 5 s default deadline, so the command printed `timed out after 5000ms waiting for rule.test` and exited 1, while the daemon kept going and completed the run. Both recorded runs went through the same `rule.test` RPC with a 600 s deadline. They were rendered with the CLI's own `ruleTestRows`/`printTable`, or printed as raw JSON for `--json`. Fix: give `rule.test` a deadline scaled to the example count × the classifier timeout.
  2. The eval path emits no `classifier_call` events, so §6.2's "latency recorded per call" does not hold for evals (see Latency above).
  3. The plain table prints multi-line `diff` example actions raw, which breaks the column layout.
  4. There is no CLI verb for `rule.update`, so §3.1's "edit-then-accept" needs the RPC or the UI.
- **Where the disagreements come from.** The floor is not the main source. The diff-stage rules whose seeded text is a sentence fragment lacking context (…GR77MM "browser writes are always actor human…" and …8CMD5B ".strict() by default…") put both of their examples near 0.5 (conf ≤ 0.14), should-fire and should-not alike. Those rules need a `question` written for the classifier, not a band change. Action-stage rules with concrete text (dependencies, `.agile/sync/`, the user's checkout) reached 0.85–0.92 on clear violations.
- **Recommendation on the floor: take it out while confidence is derived.** Set `classifier.bands.confidence_floor: 0` (config only, no code change), and restore it only if Jev starts returning a real Noul `confidence`, which `parseJevResponse` already prefers. As written, the floor cannot do the job §6.3 gives it ("0.9 with confidence 0.2 is a shrug") and is a hidden second `allow_below`. Here it cost 5 needless routes for 2 saves. If the dependency-cycle kind of miss matters, lower `allow_below` in the open, where it reads as what it is. Don't do that yet: 24 examples, a third of them deliberately borderline, is too thin to move `allow_below` or `deny_at`. The 0.76–0.79 should-fire cluster (`mock.module`, the npm fallback) is worth watching before `deny_at` moves. Record this as a §6.3 decision once Pete agrees.

### Ticket: T155 ∥ Phase 5 rough edges from the agreement check
- **Priority:** P2
- **Status:** Done
- **Owner:** -
- **Scope:** (1) `rule.test` gets an RPC deadline scaled to example count × classifier timeout, so `agile rules test` finishes a real suite instead of exiting 1 after 5 s while the daemon keeps going. (2) The eval path writes a `classifier_call` event per call (latency, rule, band), as the hook path does. (3) The plain `rules test` table collapses multi-line example actions to one truncated line. (4) `agile rules edit <id>` over `rule.update` (text, question, enforcement, stage, examples), so edit-then-accept needs no raw RPC. (5) `landing/diff-rules.ts` raises its `classifier_review` gate with the rule id, so `wireClassifierRouteStats` attributes denied landing routes (T153 review).
- **Acceptance Criteria:** CLI test with a `FakeClassifier` delayed past 5 s total completes; eval run leaves `classifier_call` events; table test with a diff example; CLI test for `rules edit`; stats test for a denied landing route.
- **Validation Steps:** `bun test packages/daemon/src/rules packages/daemon/src/landing packages/cli`; `bun run test:integration`.
- **Notes:** May run alongside Phase 6. Source: the T154 agreement check above. The floor decision is not in scope; it is Pete's §6.3 call.

### Ticket: T156 ∥ Remove the confidence floor; rule criteria; rewrite the two weak rules
- **Priority:** P2
- **Status:** Done
- **Owner:** -
- **Scope:** Per D14. (1) Delete `classifier.bands.confidence_floor` (schema, default, docs), the derived `|2p−1|` confidence, and every code path that reads either; `Answer` carries the Noul value only. Old configs carrying the key fail loudly with a message naming D14, or are migrated by the store; pick one, no silent drop. (2) Rules gain optional `criteria: {true, false}` passed through to the Noul request as the TypeSafe docs describe. (3) Rewrite the seeded rules …GR77MM and …8CMD5B as one yes/no `question` each (yes = broken), with `criteria` where the line is subtle. The design doc is not edited; D14 carries the change.
- **Acceptance Criteria:** grep finds no `confidence_floor`/derived confidence in `packages/`; band tests cover deny/allow/route on the raw value only; a `FakeClassifier` test sees `criteria` in the request; recorded-fixture eval of the two rewritten rules.
- **Validation Steps:** `bun test packages/daemon/src/classifier packages/daemon/src/rules packages/shared`; `bun run test:integration`.
- **Notes:** May run alongside Phase 6. Source: T154 agreement check and Pete's reading of the Noul docs (D14). No live classifier calls.

**Phase 5 verification (2026-09-22, tip ccd5049):** build, typecheck, lint clean; `bun test` 1763 pass / 2 skip / 0 fail (124 files); `test:integration` 7 suites, 0 fail. Daemon source 21665 lines (Phase 4: 19,457). QA (T154) ACCEPT, 0 defects. Phase 5 stops here for Pete's live run; Phase 6 does not start until he says go.

### Phase 6 — The cockpit

### Ticket: T160 Shell, inbox, and stream tree
- **Priority:** P0
- **Status:** Done
- **Owner:** —
- **Scope:** Reuse `ui/app/lib/shell.tsx`, the single ws, `Markdown`, `NeedsYou` (renamed Inbox), `TopBar`, `Settings`. Left rail: stream tree with status dots (who must act). Main: Inbox by default, grouped by stream, each card answerable inline (question, land, rule accept, classifier review). Delete the Plan/Sprint/Review screens and their components.
- **Acceptance Criteria:** Playwright: an agent question on a nested stream appears in the inbox without reload, the answer reaches the session, the tree dot changes. Phone-width layout works.
- **Validation Steps:** `bun run test:e2e`.
- **Notes:** Pete looks at this before T161 starts.

### Ticket: T161 Stream page
- **Priority:** P0
- **Status:** Done
- **Owner:** —
- **Scope:** Thread (streaming, markdown, thinking indicator from T051's `chat-state.ts`), a composer that writes a human line and, if a worker is attached, prompts it; sessions strip (vendor/model, attach, review, stop); diff tab (reuse `feed/diff.ts`); rules-in-scope tab; docs tab (T134); Land button with the diff-rule result. Added 2026-09-22 (Pete): inbox cards clipped at 200 chars must be readable in full; a clipped card expands in place, and clicking a card opens its stream page with the full question, gate or rule.
- **Acceptance Criteria:** Playwright covering attach → question → answer → findings → land on one stream with the fake transport.
- **Validation Steps:** `bun run test:e2e`.
- **Notes:** Pete looks at this before T162.

### Ticket: T162 New stream and quick capture
- **Priority:** P1
- **Status:** Done
- **Owner:** —
- **Scope:** "New stream" from anywhere (title, optional parent, optional repo); a quick-capture box in the top bar that creates a stream from one line, for the support question that arrives mid-task. Keyboard: `n` new, `/` search streams.
- **Acceptance Criteria:** Playwright: quick capture creates a stream with no repo in under two interactions.
- **Validation Steps:** `bun run test:e2e`.
- **Notes:** —

### Ticket: T163 Rules screen
- **Priority:** P1
- **Status:** Done
- **Owner:** —
- **Scope:** List with scope, tier, status, stats; accept/retire; edit text, question, examples; the pruning columns from T142 (never fired, most routed); "test examples" button calling T153.
- **Added 2026-09-23 (Pete, T160 look):** rule proposals from `agile rules seed` collapse in the inbox into one card ("N proposed rules from <source>") that opens the rules screen filtered to them; the rules screen supports bulk Accept/Retire of a selection. Agent-proposed rules (lessons) stay individual inbox cards.
- **Acceptance Criteria:** Playwright: accept a proposed rule, see it in a stream's rules-in-scope tab.
- **Validation Steps:** `bun run test:e2e`.
- **Notes:** —

### Ticket: T164 Rewrite LIVE-CHECKLIST.md and CLAUDE.md
- **Priority:** P0
- **Status:** Done (merge 84b7ac3)
- **Owner:** —
- **Scope:** The §6 walkthrough as numbered steps against `~/Projects/ledger-lite`, including the reset recipe, the real-key classifier step, and what to look at when something fails. `CLAUDE.md` rewritten for the new layout, commands, and conventions; the frozen-plan and old-design references removed. Also (Pete, 2026-09-23): Settings → Session defaults is labelled as a **Global default** row followed by a **Per-repo defaults** list, one row per registered repo, each saying it overrides the global default and showing what it currently resolves to. Every command in the checklist is run in zsh before it is written down: no `<placeholders>`, no inline `#` comments. The root `test:live` script no longer points at the deleted `em/live.test.ts`. Also (Pete, 2026-09-23): in the stream composer, Enter sends and Shift+Enter inserts a newline; the Send button still works.
- **Acceptance Criteria:** Pete completes the walkthrough without asking a question.
- **Validation Steps:** Manual.
- **Notes:** Final milestone.

### Ticket: T166 ∥ Stream page rough edges from Pete's T161 look
- **Priority:** P2
- **Status:** Done
- **Owner:** —
- **Scope:** (1) "Needs you" always renders, with "nothing waiting on you" when empty. (2) A stream whose branch is already merged into its target (landed outside `land`, e.g. the Phase 4 `--help` stream, merge f4675a2) shows "already merged into <target>" in the Land panel and offers "Mark landed", which sets `human.status: landed` through `streams.update` as `human`, instead of "nothing to land" with the stream stuck `open`. (3) A Close button on the stream page (existing close path, actor `human`). (4) `agile daemon status` prints the state home path first.
- **Acceptance Criteria:** UI tests for (1) and (3); service test for the merged-outside detection and mark-landed; CLI test for (4).
- **Validation Steps:** `bun test packages/daemon/src/landing packages/ui packages/cli`; `bun run test:e2e`.
- **Notes:** May run alongside T162. Source: Pete, 2026-09-22.

### Ticket: T167 Pattern rules end to end; rules screen fixes
- **Priority:** P1
- **Status:** Done (merge 229490f; review fix 77bc4c4; QA PASS incl. real-key Test examples 2/2)
- **Owner:** —
- **Scope:** From Pete's T163 look (2026-09-23). (1) `agile rules add|edit --pattern <kind> [--pattern-arg …]` (kinds `no_push`, `no_push_protected`, `path_deny` globs, `command_deny` token patterns), validated by `RulePatternSchema`; `rules show` prints the pattern. (2) Rules screen shows the pattern under the text (`command_deny: "rm -rf", "git reset --hard"`), the editor edits kind and args, and a "New rule" form creates any rule (text, scope, enforcement, stage, question, criteria, pattern, examples) as a proposal. (3) The editor has Cancel (and Esc) that discards changes. (4) Test examples is available only when the daemon actually holds a key; `agile daemon status` says whether a classifier key is loaded (never prints it). (5) Cap examples per rule in the shared schema. (6) `--enforcement pattern` without a pattern is refused. (7) Added 2026-09-23 (Pete): the TypeSafe key is set in the cockpit Settings screen — write-only field with Save/Remove, stored as `classifier.api_key` in the home config through the store, classifier hot-swapped with no restart; the key is never sent back to the browser (Settings shows only whether a key is set and from where) and never appears in events, threads, logs or responses.
- **Acceptance Criteria:** CLI test creating and accepting a `command_deny` rule, then a hook decision denying `rm -rf dist` with the rule named; Playwright: pattern shown on the rules screen, create via the form, edit then Cancel leaves the rule unchanged; status test for the key line.
- **Validation Steps:** `bun test packages/shared packages/daemon/src/rules packages/daemon/src/permissions packages/cli`; `bun run test:e2e`.
- **Notes:** Runs before T164 so the checklist can describe it.

### Ticket: T168 ∥ Finish the §8 deletions
- **Priority:** P1
- **Status:** Done (merge 13cf4e6; review APPROVE incl. forward-compat on a pre-T168 state home)
- **Owner:** —
- **Scope:** From the 2026-09-23 deletions audit. (1) Remove the `Ticket` and `Message` schemas (`packages/shared/src/ticket.ts`, `message.ts`) and `Quota` (`vendors.ts`), moving `bus/bus.ts` and `gates/service.ts` off them. (2) Strip the old role union and role routing from `bus/routing.ts` (em/architect/qa fan-out, halt/resume broadcast) and the `em`/`architect` owner branches in `gates/service.ts`, which cite the deleted `em/delegate.ts`. (3) Narrow the agent-id regex and comments in `shared/src/ids.ts`. (4) Delete the orphan fixtures: halt, oracle-entry, sprint, sprint-with-team-and-gates, stanza, kb-fact, quota, ledger-line, and ticket/message once their schemas go.
- **Acceptance Criteria:** No export, import or fixture for any §8 schema; no `em`/`architect`/`qa` role strings in daemon or shared source outside tests asserting their absence; all suites green.
- **Validation Steps:** `bun run typecheck`; `bun test`; `bun run test:integration`; `bun run test:e2e`.
- **Notes:** Runs after T167 merges, before T164 so CLAUDE.md describes the final layout. Stale CLAUDE.md lines found by the same audit (tagline, `em/delegate.ts`, halts, send/approve/halt, architect planning turn, Ledger, sprint TTL) are T164's.

### Ticket: T169 ∥ Show rule hits on the stream
- **Priority:** P1
- **Status:** Done (merge 79d956c; review fixes f13ea49; QA PASS — item 4 thread-reply close verified by unit/RPC tests only, no vendor in cloud)
- **Owner:** —
- **Scope:** From Pete's T167 look (2026-09-23): a hook deny or route today lands only in `events.jsonl` and the rule's stats, so the stream page shows nothing. (1) Every hook decision that names a rule (deny or route, pattern or classifier) appends a thread `event` entry: rule text, the blocked command or path, and the outcome. (2) The thread renders it as a distinct "blocked by rule" card linking to the rule on the Rules screen. (3) The Rules screen shows last fired time next to the stats. Role-policy denies that name no rule get a plainer entry. (4) An agent question closes itself (answered, citing the message) when the human replies on the thread instead of the Answer box and the worker carries on.
- **Acceptance Criteria:** Service test: a `command_deny` hit on `rm -rf dist` writes one thread entry naming the rule. Playwright: the card renders on the stream page and links to the rule.
- **Validation Steps:** `bun test packages/daemon/src/hook packages/ui`; `bun run test:e2e`.
- **Notes:** Runs before T164 so the checklist can point at it.

### Ticket: T170 ∥ Session defaults in Settings; opus-5-5 at low
- **Priority:** P1
- **Status:** Done (merge 7650565; QA PASS)
- **Owner:** —
- **Scope:** Per D17. (1) Built-in default `claude` / `claude-opus-5-5` / `low` when nothing else resolves; `agile daemon status` and the stream page show the resolved values, never "default". (2) Settings edits home `default_vendor|model|effort` and each repo's model/effort in `repos.yaml`, through the store with strict schemas, same-origin 403, actor `human`; changes apply to the next session without a restart. (3) Attach and Review in the cockpit open a small picker prefilled with the resolved default. (4) Model is free text with the known ids suggested; effort is the `EffortSchema` enum.
- **Acceptance Criteria:** Resolution-order unit test incl. the new built-in step; HTTP tests for the settings writes; Playwright: change the default in Settings, Attach, the session strip shows the new model/effort.
- **Validation Steps:** `bun test packages/shared packages/daemon packages/ui`; `bun run test:e2e`.
- **Notes:** May run alongside T169. Before T164.

### Ticket: T171 Bump the Claude ACP adapter so opus-5-5 works
- **Priority:** P0
- **Status:** Done (merge f479b17; Pete live check passed 2026-09-23)
- **Owner:** —
- **Scope:** From Pete's T170 look (2026-09-23): a worker attached with the D17 default fails with "Claude Code 2.1.257 does not support this model; version 2.1.280 or newer is required". The daemon spawns `npx -y @agentclientprotocol/claude-agent-acp@0.75.1`, which bundles `@anthropic-ai/claude-agent-sdk@0.3.257`, so Pete's installed `claude` (2.1.280) is never used. Bump the pin to `0.81.1` (bundles SDK `0.3.280`). Read the adapter's changelog between 0.75.1 and 0.81.1 for changes to permission requests, hooks, cancel/resume and session modes that `design/spike-findings.md` relies on, and adapt `packages/acp-client` if needed. (2) When a session dies on a vendor error, the session strip shows the vendor's error line (from the Discovered Issues entry), so this failure is readable without the thread.
- **Acceptance Criteria:** Provider test pins 0.81.1; offline suites green; Pete attaches a worker on ledger-lite with the default and it runs a turn; the `rm -rf dist` hook test from T167 still blocks.
- **Validation Steps:** `bun test packages/acp-client packages/daemon`; `bun run test:e2e`; Pete's live check (no vendor login in the cloud).
- **Notes:** Runs before T164. Vendor behaviour cannot be re-measured in the cloud; the worker reports every changelog item that touches the spike findings.

### Ticket: T173 Rebuilds show without a hard reload; checklist step 1 is right
- **Priority:** P0
- **Status:** Done (merge 7019eb7)
- **Owner:** —
- **Scope:** From Pete's T164 look (2026-09-23). (1) `GET /` serves `index.html` with no cache header, so a browser can keep an old page (and old hashed bundle) after a rebuild; serve it with `cache-control: no-cache` (hashed assets may stay cacheable). (2) LIVE-CHECKLIST.md step 1 checks out `main`, which does not carry the reshape, and assumes `~/Projects/agile-agents`; Pete's checkout is `~/agile-agents`. Step 1 builds the current branch (`claude/reshape` until it lands) and says to `cd` to wherever the checkout lives.
- **Acceptance Criteria:** A test asserts the `/` response carries `no-cache`; checklist step 1 is correct for Pete.
- **Validation Steps:** `bun test packages/daemon`; `bun run test:e2e`.
- **Notes:** Small; runs before T172.

### Ticket: T172 Trim the daemon under 18,000 lines
- **Priority:** P1
- **Status:** Done (merge 5ed9845; 17,991 lines)
- **Owner:** —
- **Scope:** §6 Definition of done says daemon source under 18,000 lines; it is 22,486 (measured by `find packages/daemon/src -name '*.ts' ! -name '*.test.ts' | xargs cat | wc -l`). Phase 2 reached ~16,000; Phases 4–6 added rules, classifier, route band, lessons, hook thread cards and cockpit routes. Remove dead code (unexported/unused functions, compatibility shims kept "for now", e.g. the `message` event kind and `AccountQuotaConfigSchema` if nothing reads them), leftover scaffolding, and duplication (e.g. `SESSION_VENDORS` vs acp-client providers). No behaviour change, no feature removal, no moving code into other packages just to shrink the count. If under 18,000 is not reachable without removing behaviour, stop at the honest floor and report what is left and why.
- **Acceptance Criteria:** Daemon source under 18,000 lines, or a documented floor Pete accepts; all offline suites green.
- **Validation Steps:** the line count above; `bun test`; `bun run test:integration`; `bun run test:e2e`.
- **Notes:** Pete asked for it 2026-09-23 over raising the target.

### Ticket: T174 A question on the stream gets an answer
- **Priority:** P0
- **Status:** Done (merge 8944aeb; Pete live check pending)
- **Owner:** —
- **Scope:** Pete's walkthrough (2026-09-24): he wrote "how many tests are you writing?" on the Transfers stream while the worker was mid-turn; the worker never answered, finished, posted its summary and exited. Causes: `AttachService.say` prompts `The operator says on the stream: <body>\n\nContinue the work.`, which tells the model to carry on; and `runPromptTurn` serializes turns, so a line sent mid-turn waits for the turn to end, and nothing shows that it is waiting. Fix: (1) the delivered prompt tells the worker to reply to the operator on the stream first (answer a question, acknowledge an instruction), then continue; (2) a line queued behind a running turn is shown as waiting on the stream page (e.g. "queued — the worker reads it after its current step") until delivered; (3) a queued human line is never dropped: if the session is ending (turn ended, worker reported done) with a line still queued, the line is still delivered as its own turn before the session is let go. Check the done/exit path in attach/service.ts and runner/session.ts for where a queued prompt could be lost.
- **Acceptance Criteria:** Unit tests with the fake agent: a line sent mid-turn is delivered after the turn with the new wording, and a session that would end after that turn still runs the queued line; e2e shows the queued marker then clears it. Pete's live check: a mid-turn question gets an answer on the thread.
- **Validation Steps:** `bun test packages/daemon`; `bun run test:e2e`; Pete live.
- **Notes:** Fake-agent tests cannot prove the model answers; the wording is the intent layer, the delivery guarantee is the enforcement.

### Ticket: T175 Setup rough edges from Pete's walkthrough
- **Priority:** P2
- **Status:** Superseded (2026-09-24): items (1)–(2) → T210, item (3) → T260 (`--name` on knowledge items), item (4) → T211
- **Owner:** —
- **Scope:** From Pete's 2026-09-24 walkthrough. (1) An `AGILE_HOME` that exists and is not a directory (his pointed at the `agile` binary) is refused by every command with one clear line naming the variable and the path, not EEXIST/ENOTDIR. (2) When `daemon start` finds the port held, it names the holder when it can (pid and command via `lsof`), and says whether it looks like another `agiled` and how to stop it; `daemon stop` on a home with no pidfile hints at a daemon from another home on the port. (3) `agile rules add --name` so CLI-made rules show a name on cards instead of the id. (4) Quickstart/LIVE-CHECKLIST mention that a fresh home starts with three built-in rules.
- **Acceptance Criteria:** Tests for (1)–(3); checklist line for (4).
- **Validation Steps:** `bun test packages/cli packages/daemon`; `bun run test:integration`.
- **Notes:** After T174.

### Ticket: T176 Landing conflicts are resolvable; parents aren't worked on by accident
- **Priority:** P1
- **Status:** Done (merge 01850b0; Pete live check pending)
- **Owner:** —
- **Scope:** From Pete's walkthrough (2026-09-24): he attached a worker to the parent "Ledger features" as well as its three children; the parent's worker built all three features on the parent branch, so every child's land conflicted. (1) Attach on a stream with open children asks for confirmation in the cockpit (and needs `--force` on the CLI), saying a parent's branch is where its children land. (2) A land that conflicted no longer shows "Ready" beside the conflict; the Land panel shows the conflict and the files. (3) A **Resolve** action on a conflicted stream attaches a worker whose prompt says: merge the target branch into this stream branch, resolve the listed files keeping both sides' intent, run the tests, commit; then the operator lands again. Design §8 stops at "blocked, worktree kept"; log the Resolve path as a Decision.
- **Acceptance Criteria:** Unit + e2e for (1) and (2); (3) tested with the fake agent up to the prompt and the re-land; Pete's live check lands three conflicting siblings via Resolve.
- **Validation Steps:** `bun test packages/daemon packages/cli packages/ui`; `bun run test:e2e`.
- **Notes:** After T174.

### Ticket: T177 Worktrees never dirty the user's checkout
- **Priority:** P0
- **Status:** Done (merge ccad799)
- **Owner:** —
- **Scope:** Pete's walkthrough (2026-09-24): `runner/worktrees.ts` appends `.worktrees/` to `<repo>/.gitignore` on first worktree creation and leaves it uncommitted, so the next land into the checked-out target refuses ("main is checked out with uncommitted changes"). The tool blocks its own landing. Write the ignore line to `<git-common-dir>/info/exclude` instead (resolve with `git rev-parse --git-common-dir`; create `info/` if missing; idempotent), and never touch `.gitignore`. The land's dirty-checkout message names the files that are dirty so the user knows what to commit or stash.
- **Acceptance Criteria:** Unit test: creating a worktree in a fresh repo leaves `git status --porcelain` empty and `.worktrees/` ignored; the land refusal lists the dirty paths.
- **Validation Steps:** `bun test packages/daemon`; `bun run test:integration`.
- **Notes:** Runs right after T174, before T175/T176. design/cockpit-design.md §4.4 (line ~287) and design/reshape-plan.md still say `.gitignore`; design edits are Pete's call.

### Ticket: T165 Cockpit as an installable app
- **Priority:** P2
- **Status:** Todo (step 1 done 2026-09-22, merge 8121113; step 2 awaits Pete)
- **Owner:** —
- **Scope:** Per D15. Step 1: web app manifest + icon + service worker shell so the browser installs the cockpit as its own app window (Dock/home-screen icon), no new toolchain. Step 2 (only if step 1 isn't enough for Pete): a thin desktop shell that starts `agiled` if it isn't running and opens the page in its own window, with native notifications for new inbox items. Choice of shell (Tauri vs Electron) is escalated to Pete before any code; it is a new toolchain and needs explicit approval. The daemon stays the only process that holds state; the shell holds none.
- **Acceptance Criteria:** Step 1: Chromium reports the page installable (Playwright); installed window opens on the inbox. Step 2: defined when approved.
- **Validation Steps:** `bun run test:e2e`; Pete installs it on his Mac.
- **Notes:** Runs after T164 so the UI is settled; step 1 may run earlier alongside any Phase 6 ticket if a worker is idle. Phone access over the network (auth, tunnel) is out of scope; see Discovered Issues.

## 7b. The projects stage (Phases 7–13)

**Resume here (handoff, 2026-09-24).** The reshape (Phases 0–6) is merged to `main` (PR #3, e66dfd5). Phase 7 has not started; nothing below T200 is In Progress. Work on `claude/phase-7` (already carries `main`); each later phase gets `claude/phase-N` cut from the previous phase branch, and fixes from Pete's reviews merge forward. Drive with `/project --yolo`: per ticket a worktree `.worktrees/T###-slug` off the phase branch → worker (opus) → independent reviewer (sonnet) → verify the diff yourself → merge `--no-ff` → push. Black-box QA (sonnet) at each phase's QA ticket. Pete reviews per phase but asked that work continue into the next phase without waiting; stop only for decisions only he can make. Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and the session line. Every ticket reports its daemon line delta (D18). Never print, log or commit credentials; never list or dump environment variables (D16, D31). Live-check commands for Pete must be zsh-paste-safe (no placeholders, no inline `#`), verified against the real CLI, and include `export AGILE_HOME=…`. Pete's checkout is `~/agile-agents`; his test repos are `~/Projects/ledger-lite` and https://github.com/petestewart/agile-test-repo.


Design: `design/projects-design.md`, which wins over `design/cockpit-design.md` where they differ (D19). Branches are stacked (D30): `claude/phase-7` → `claude/phase-8` → … → `claude/phase-13`. Each ticket branches from its phase branch. Every phase ends with a QA ticket and Pete's look, and Pete lands the phases in order.

**Build order.** 7 → 8 → 9 → 10 → 11 → 12 → 13. PR babysitting (review comments and CI failures reaching the agent) depends on events, so it is not in Phase 8. It is T246 in Phase 9, right after the event core. Phase 8 still delivers PRs and tracks their state mechanically, so each phase is usable on its own (projects-design §19.1). Knowledge (10) comes after events because `knowledge_accepted` is an event. Coordination (11) needs events, knowledge scopes and delivery holds. The Director (12) uses coordination's tools and levels. External links (13) are independent after Phase 9, but come last because they are optional (D28) and need P17 approved.

**Leftovers folded in.**

- T175 is superseded: items (1) and (2) land in T210, item (3) (`--name`) in T260, and item (4) (the built-in rules note) in T211.
- Unfiled items from the doc comments:
  - attach friction and "start the worker when the stream is created" → T204;
  - add a repo from the UI → T206;
  - the Desk/side-quest proposal → superseded by the Director (T300–T303) and helper children (T288).
- T165 step 2 stays Todo, independent of this stage.

**Shared assumptions for every ticket.**

- Tickets assume the proposed decisions P1–P20 in projects-design §19 unless a D-entry replaces them.
- A worker that finds a proposal wrong stops and escalates. It does not decide.
- Every ticket reports its daemon line delta (D18).
- Live-check commands in the QA tickets assume `agile` is built from the phase branch (LIVE-CHECKLIST §1) and use a scratch home per phase.

### Phase 7 — Projects and the tree

### Ticket: T200 Project record, store, RPC and CLI
- **Priority:** P0
- **Status:** Done (merge c9a79b7)
- **Owner:** —
- **Scope:** Add the `Project` schema (projects-design §14.1) in `packages/shared` (`P-<ulid>` ids, `.strict()`). Add `projects/<id>.yaml` through the validating store with audit events `project_created` and `project_updated`. Add `daemon/projects` with a service and RPC: create (which also creates the root node), list, show, update settings, archive. Add the CLI verbs `agile project new --name --repo… [--json]`, `list`, `show`, `set`. Names are unique, case-insensitive.
- **Acceptance Criteria:** Store round-trip; a corrupt project file is refused with path and line; creating a project writes its root stream; the CLI prints JSON with `id` and `root`.
- **Validation Steps:** `bun test packages/shared packages/daemon/src/projects packages/cli`.
- **Notes:** P2. Blocks every other Phase 7 ticket. Branch T200-project-record. Review (sonnet): 1 blocking (repeated `--repo` dropped) fixed. Daemon +243 lines. `--repo` accepts repeats and commas.

### Ticket: T201 Node fields and the derived role
- **Priority:** P0
- **Status:** Done (merge 362ac3f)
- **Owner:** —
- **Scope:** Extend the stream schema with `project`, `labels`, `waits_on`, `external_link` (schema only), `autonomy`, `delivery`, `merge_together`, `helper_of`, `delivery_state` and `touched` (§14.2). Only the daemon writes `delivery_state` and `touched`. Add `nodeRole()` in shared (P1). `stream.create` requires a project and defaults the parent to the project root. `waits_on` writes refuse cycles (P8). Add `agile node` as the verb, with `agile stream` kept as an alias; `node show --json` includes `role`; `node list` takes `--project` and `--parent` and prints JSON with `--json`. Principals gain `coordinator` and `director` (§14.12), which the store refuses on `human.*`.
- **Acceptance Criteria:** Table tests for `nodeRole` (project, coordinating, work, conversation, a same-repo helper not making the parent coordinating); the cycle refusal; the two-writer split for the new principals.
- **Validation Steps:** `bun test packages/shared packages/daemon/src/streams packages/daemon/src/store`.
- **Notes:** After T200. Review (sonnet) PASS. Daemon +106. Gaps carried: HTTP `POST /api/streams` does not yet require a project (→ T208); `waits_on`/`labels` have no RPC/CLI edit path yet (store enforces P8); landed children count as live per §14.2.

### Ticket: T202 Migrate an existing home into projects
- **Priority:** P0
- **Status:** Done (merge fc668ea)
- **Owner:** —
- **Scope:** Add a one-shot, idempotent migration on daemon start (§17.1 steps 1, 3 and 4):
  - create project "Unfiled" and re-parent every parentless stream under its root;
  - set `project` on every stream;
  - add `delivery: direct` and `visibility: public` to each `repos.yaml` entry, and carry `target_branch` over as `main_branch`;
  - list any unmerged parent-integration branches in one inbox card.

  Step 2 (rules → knowledge) is T260.
- **Acceptance Criteria:** A fixture home from before the migration comes up with every stream in "Unfiled". A second start changes nothing. The audit log carries one `home_migrated` event.
- **Validation Steps:** `bun test packages/daemon/src/store`; `bun run test:integration`.
- **Notes:** After T201. Uses the T168 pattern of forward-compat tests on an old home. Review (sonnet) PASS; manager fixed a semantic merge clash with T208 (duplicate `projectService`) and dropped T203's `main_branch` cast. Daemon +196. Repo `target_branch` stays beside `main_branch` (read as fallback). A migration error stops the daemon start (retried next start). Parent-branch inbox card is by stream state, not a git merge check.

### Ticket: T203 Work nodes deliver to main; parent branches removed
- **Priority:** P0
- **Status:** Done (merge 44d92d2)
- **Owner:** —
- **Scope:**
  - Landing's target becomes the repo's `main_branch`. Remove `parentBranch()` in `landing/service.ts` and the stream's `target_branch`.
  - A coordinating node never gets a branch or worktree.
  - Remove the T176 parent-attach guard, since the case can no longer happen, and replace it with "a coordinating node has no worktree".
  - Update LIVE-CHECKLIST §9–14 wording that assumes children land into the parent.
- **Acceptance Criteria:** Unit: a child of a node that has a repo lands on `main`. A coordinating node refuses a worktree. The existing landing tests pass, rewritten for the new target.
- **Validation Steps:** `bun test packages/daemon/src/landing packages/daemon/src/attach`; `bun run test:integration`.
- **Notes:** After T201. D20. Review (sonnet) PASS. Daemon −46. Stream `target_branch` kept in the schema as deprecated/ignored for old records (design §14.2 prose is stale vs §17). Helpers land on main, not `helper_of`'s branch → T205. T176 `--force`/confirm removed.

### Ticket: T204 Starting a node starts its agent
- **Priority:** P1
- **Status:** Done (merge 233a781)
- **Owner:** —
- **Scope:**
  - `node new` for a work or conversation node starts its agent: a worker for work nodes, and a conversation session with no worktree for conversation nodes. `--no-start` and the cockpit's "Start later" checkbox skip this.
  - The cockpit's Attach control becomes Start/Restart. `agile attach` stays as restart.
  - The session defaults order gains the project step (P5).

  This folds in the doc-comment item "attach friction / start worker on create".
- **Acceptance Criteria:** Fake-agent test: creating a work node yields a running worker session with the resolved defaults. `--no-start` yields none. e2e: New stream → the session strip shows running without a second click.
- **Validation Steps:** `bun test packages/daemon/src/attach packages/cli`; `bun run test:e2e`.
- **Notes:** After T203. Review (sonnet): 1 blocking (start-failure path untested) fixed. Daemon +54 net. Quick capture sends `start: false` (a jot never spawns an agent; tested) — Pete may overrule. P5 node step not built (nodes have no session field yet).

### Ticket: T205 + Repo in place
- **Priority:** P1
- **Status:** Done (merge ca8e9ff)
- **Owner:** —
- **Scope:** Add `node.add_repo` and `node.switch_repo` (RPC, `agile node add-repo`/`switch-repo`, and a + Repo button on the stream page), with the three reshapes in projects-design §7:
  - conversation → work: create the branch and worktree;
  - work → coordinating: move the branch, worktree and sessions into a new child "<repo> part", keeping the commits, and create a second part;
  - switch with nothing committed: as above, then close the empty part.

  New parts start with the thread-so-far pointer, the docs and the decisions. The chat stays on the node.
- **Acceptance Criteria:** Unit tests for all three reshapes, including that the moved branch keeps its commits and that `nodeRole` changes. e2e: + Repo on a conversation shows the same thread with a new part row.
- **Validation Steps:** `bun test packages/daemon/src/streams`; `bun run test:e2e`.
- **Notes:** After T204. An agent's "add web too?" suggestion is a `propose_next` card with an Add button (UI only). From T203: make helpers deliver to `helper_of`'s branch when this ticket starts populating `helper_of`, or record why not. From T204: a live conversation node that gains a part becomes coordinating while its session is live — handle per §7. Review (sonnet): 1 blocking (unfiltered `node list --json` kept the old shape) fixed; split now rolls back on a mid-sequence failure. Daemon +302. `node list --json` is a bare array with `role`; `node show --json` flattens the record (keeps `stream`). A live worker is stopped and restarted across the reshape; parts are not auto-started. `helper_of` delivery deferred: T205 never sets `helper_of` (§7 parts are ordinary work nodes delivering to main) — belongs with T288 (same-repo helpers).

### Ticket: T206 ∥ Add a repo from the cockpit
- **Priority:** P2
- **Status:** Done (merge 77af69d)
- **Owner:** —
- **Scope:** Settings → Repos: register a repo by path (validated as a git toplevel), with a name and protected branches, and show the resolved `main_branch`. It uses the same RPC as `agile repo add`. This is the unfiled doc-comment item "add repo in UI".
- **Acceptance Criteria:** e2e: add `fixtures/demo-project` from Settings; it shows in the New stream repo picker. A bad path shows the daemon's one-line error.
- **Validation Steps:** `bun run test:e2e`.
- **Notes:** Independent after T200. Review (sonnet) PASS. `state.repo_add` (CLI too) now refuses non-toplevel paths and stores the realpath. `main_branch` is display-only until T202 stores it. Daemon +70.

### Ticket: T207 ∥ Nothing in the user's repo
- **Priority:** P1
- **Status:** Done (merge d186411)
- **Owner:** —
- **Scope:**
  - Docs move from `<repo>/.agile-docs/` to `~/.agile/repos/<name>/docs/`, with a one-time import that never deletes the old directory (P3).
  - The worktree's `.claude/settings.json` goes into `info/exclude`. If the repo tracks its own `.claude/settings.json`, use the vendor's settings-file flag or local settings instead, and find out which the pinned Claude ACP adapter supports (P4).
  - Update design text only in `projects-design.md`, if needed.
- **Acceptance Criteria:** Unit: after worktree creation, attach and a commit made with `git add -A` in the worktree, `git status --porcelain` on the user's checkout is empty and the commit contains no `.claude/settings.json`. Docs tests read the home path.
- **Validation Steps:** `bun test packages/daemon/src/docs packages/daemon/src/hook packages/daemon/src/runner`.
- **Notes:** D24. Can run alongside T203–T205. Review (sonnet) PASS; two follow-ups fixed (allDocs skips bad repo names; both-settings-tracked refusal before any state write). Hooks go to `.claude/settings.local.json` when the repo tracks `.claude/settings.json` (adapter 0.81.1 loads local settings; not yet live-checked). Daemon +73.

### Ticket: T208 Project tree and switcher in the cockpit
- **Priority:** P0
- **Status:** Done (merge 56e9c20)
- **Owner:** —
- **Scope:** The left rail groups the tree by project, with a project switcher ("All" and each project), role icons (project, coordinating, work, conversation) and labels. New stream and quick capture file into the current project. There is a "New project" dialog. The snapshot carries projects and roles.
- **Acceptance Criteria:** e2e: create two projects; each one's nodes show only under it; quick capture lands in the selected project.
- **Validation Steps:** `bun run test:e2e`.
- **Notes:** After T201. Pete looks at it before T209. From T201: make HTTP `POST /api/streams` require a project (default to the current project in the cockpit). Review (sonnet) PASS; merge conflicts with T206 (imports, adjacent e2e describes) resolved by the manager. Daemon +54. Follow-ups: New stream parent dropdown not filtered by project; `/api/projects` has no update/archive routes.

### Ticket: T209 Repo view and lenses
- **Priority:** P1
- **Status:** Done (merge 7d48238)
- **Owner:** —
- **Scope:** Add a repo view: live work nodes grouped by repo across projects, with the ancestors greyed and the repo's delivery mode shown. The norms and overlap slots are placeholders until T227 and T266. Add lenses: Needs me (the inbox, grouped by node), Running, and Dependencies (the `waits_on` graph as a list).
- **Acceptance Criteria:** e2e: a node on api in two projects shows under api with both paths; Running lists only nodes with a live session.
- **Validation Steps:** `bun run test:e2e`.
- **Notes:** After T208. Review (sonnet) PASS. Daemon +38. Inbox nav label is now "Needs me" (projects-design §5); nav scrolls sideways at phone width. Running counts sessions that are starting/running/idle (alive) — Pete may want idle excluded.

### Ticket: T210 ∥ Setup rough edges (from T175)
- **Priority:** P2
- **Status:** Done (merge 605e13f)
- **Owner:** —
- **Scope:** T175 items (1) and (2):
  - An `AGILE_HOME` that exists and is not a directory is refused by every command with one line naming the variable and the path.
  - `daemon start` on a held port names the holder (pid and command via `lsof` when available) and says whether it looks like another `agiled`. `daemon stop` with no pidfile hints at a daemon from another home on the port.
- **Acceptance Criteria:** CLI tests for both.
- **Validation Steps:** `bun test packages/cli packages/daemon`; `bun run test:integration`.
- **Notes:** Independent. Review (sonnet) PASS. CLI only, daemon +0. Holder lookup is best effort (lsof).

### Ticket: T211 LIVE-CHECKLIST for projects
- **Priority:** P1
- **Status:** Done (merge 993c824)
- **Owner:** —
- **Scope:** Rewrite LIVE-CHECKLIST.md for Phase 7: a scratch home, projects, `node new`, + Repo, and the views. Add T175 item (4), that a fresh home starts with the built-in rules. All commands are zsh-paste-safe: no placeholders, no inline comments, ids captured with `jq`.
- **Acceptance Criteria:** Every command in the file runs as pasted against a fresh home on the phase branch (checked by the QA ticket).
- **Validation Steps:** Read-through by QA.
- **Notes:** After T205 and T208. Every non-vendor block ran as pasted under `sh` (no zsh in the container) against a scratch home; [vendor] steps marked. Read-through by T212 QA.

### Ticket: T212 Phase 7 QA and Pete's look
- **Priority:** P0
- **Status:** In Review (QA ACCEPT 2026-09-24; Pete's look pending)
- **Owner:** Pete
- **Scope:** Black-box QA of T200–T211 on a real daemon with the fake agent: projects, migration of a copied old home, roles, start-on-create, the three + Repo reshapes, and the views. Daemon line count. Then Pete runs the live look below.
- **Acceptance Criteria:** QA ACCEPT; Pete's look passes: projects show, + Repo reshapes a live conversation without losing the thread, and ledger-lite's `git status --short` is empty after the run.
- **Validation Steps:** Pete, on his Mac:

```zsh
export AGILE_HOME=~/.agile-phase7
agile daemon stop
rm -rf ~/.agile-phase7
agile init
agile daemon start
cd ~/Projects/ledger-lite
agile repo add . --name ledger-lite
[ -d ~/Projects/agile-test-repo ] || git clone https://github.com/petestewart/agile-test-repo ~/Projects/agile-test-repo
cd ~/Projects/agile-test-repo
agile repo add . --name agile-test-repo
SHOP=$(agile project new --name Shop --repo ledger-lite --repo agile-test-repo --json | jq -r .id)
BLOG=$(agile project new --name Blog --repo ledger-lite --json | jq -r .id)
agile project list
Q=$(agile node new --project $SHOP --title "Balance summary" --goal "Can ledger-lite print a per-account balance summary? Explain how." --json | jq -r .id)
agile node show $Q --json | jq -r .role
agile node add-repo $Q ledger-lite
agile node show $Q --json | jq -r '.role, .branch'
agile node add-repo $Q agile-test-repo
agile node show $Q --json | jq -r .role
agile node list --parent $Q --json | jq -r '.[] | .title + "  " + .repo + "  " + .role'
cd ~/Projects/ledger-lite
git status --short
```

  In the cockpit: switch between Shop and Blog; open `Balance summary` and check the thread is intact with two parts under it; open the repo view for ledger-lite and see the part under Shop.
- **Notes:** D10: Phase 8 starts only after Pete says go. QA (sonnet, black-box) ACCEPT on 3ab7109: bun test 1861/0, integration 8 suites green, T212 script ran verbatim with scratch paths and `--no-start`. Minor: `project list` shows `-` repos for the migrated "Unfiled" project. Daemon 19,360 lines (18,273 before Phase 7). Note: `node new` without `--no-start` now starts the agent, so the Balance summary step starts a real session.

### Phase 8 — Delivery

### Ticket: T220 Fake GitHub harness
- **Priority:** P0
- **Status:** Done (merge 43f6026)
- **Owner:** —
- **Scope:** Add `daemon/src/github/fake-server.ts` (test support, like `runner/fake-agent.ts`), a `Bun.serve` server implementing the REST subset in projects-design §18:
  - repo, pulls (create, get, list, update);
  - reviews, review comments, issue comments;
  - check runs and combined status for a ref;
  - the `enablePullRequestAutoMerge` GraphQL mutation;
  - ETag/304 responses and a 403 rate-limit response.

  It is backed by a bare git repo used as `origin` (a `file://` remote). There are test controls: add a review or comment, set a check result, merge (a real `git merge` into the bare repo, honouring auto-merge once approved and green), and close.
- **Acceptance Criteria:** Self-tests: create a PR from a pushed branch, add a review, set a check failing then passing, merge; the bare repo's main moves; a conditional GET returns 304.
- **Validation Steps:** `bun test packages/daemon/src/github`.
- **Notes:** First ticket of Phase 8; everything else in the phase tests against it. No network. Review (sonnet) PASS. +522 (test-support fake, compiled like fake-agent). Needs git ≥2.38 (`merge-tree --write-tree`); CI ubuntu-latest has 2.43.

### Ticket: T221 GitHub port and REST adapter
- **Priority:** P0
- **Status:** Done (merge 629956a)
- **Owner:** —
- **Scope:** `github/port.ts` (the subset above) and `github/rest.ts`:
  - `fetch` against `github.api_url` (config, default `https://api.github.com`);
  - a token from `gh auth token` per call, never stored or logged (P18); a static token only when `api_url` points at localhost (tests);
  - owner and repo inferred from the remote URL.

  `agile daemon status` reports "GitHub auth: available/unavailable" without the token.
- **Acceptance Criteria:** Adapter tests against the fake. A missing `gh` gives one clear error. A test asserts the token never appears in logs or audit events.
- **Validation Steps:** `bun test packages/daemon/src/github`.
- **Notes:** After T220. Review (sonnet): 1 blocking (test daemons could spawn the real `gh`) fixed: `github.gh_command` config (test homes point it at a nonexistent path), a failing stub `gh` first on PATH in test-preload.ts, a marker test, and a 2 s timeout. Daemon ≈+536. Open: extend the token-leak test to events.jsonl/agiled.log once GitHub events exist (T225/T244); GHE GraphQL path not handled.

### Ticket: T222 ∥ Repo delivery settings
- **Priority:** P1
- **Status:** Done (merge 7f2cd12)
- **Owner:** —
- **Scope:** Add `delivery`, `auto_merge`, `remote`, `github`, `main_branch` and `visibility` on `RepoEntry` (§14.8); project and node overrides are resolved in one function. Add `agile repo set <name> --delivery pr|direct --auto-merge on|off --visibility public|private --project …`, and the same fields in Settings → Repos. `pr` is refused when the remote isn't GitHub or GitHub auth is unavailable.
- **Acceptance Criteria:** Resolution table tests (repo, then project, then node). e2e: change the delivery mode in Settings.
- **Validation Steps:** `bun test packages/shared packages/daemon packages/cli`; `bun run test:e2e`.
- **Notes:** After T200, and T221 for the refusal. Review (sonnet) PASS. Daemon +159. `resolveDelivery(repo, project, node)` in shared (no callers until T223). `pr` refused unless the remote is on github.com and GitHub auth is available (GHE not supported).

### Ticket: T223 Delivery service (direct path) replaces landing
- **Priority:** P0
- **Status:** Done (merge 91f0c2a)
- **Owner:** —
- **Scope:** Rename `landing/` to `delivery/` and give it `DeliveryState` on the node (§14.7):
  - the direct path is today's land with the ship check (today's diff rules) as a `held` reason;
  - `agile deliver`, with `land` kept as an alias;
  - the cockpit Land panel becomes the Delivery panel (Merge button for direct);
  - Resolve (T176) is kept.

  Lessons run after `merged`.
- **Acceptance Criteria:** The existing landing tests pass under the new names; `delivery_state` moves through ship_checking → ready → merged; a ship-check deny shows as held with the rule named.
- **Validation Steps:** `bun test packages/daemon/src/delivery`; `bun run test:integration`; `bun run test:e2e`.
- **Notes:** After T203 and T222. Review (sonnet) PASS. Daemon +67. `landing/` → `delivery/`, `agile deliver` (alias `land`), RPC `delivery.deliver` (alias `land.stream`). PR mode refused until T224. Internal names (`LandOutcome`, `/api/streams/:id/land`, `land` gate kind) unchanged.

### Ticket: T224 PR delivery: push and open a PR
- **Priority:** P0
- **Status:** Done (merge 5f8931d)
- **Owner:** —
- **Scope:** For `pr` repos, delivery means:
  1. run the ship checks;
  2. `git push <remote> <branch>` from the worktree;
  3. open a PR. The title and body come from the node's goal and progress, with the roll-up issue line left empty for T322.

  Store `pr` on `delivery_state`. A second deliver updates the existing PR, never opens a new one. Protected-branch push rules are unchanged.
- **Acceptance Criteria:** Against the fake: deliver opens PR #1 with the branch; a second deliver after a commit pushes and keeps #1; a ship-check hold never pushes.
- **Validation Steps:** `bun test packages/daemon/src/delivery packages/daemon/src/github`.
- **Notes:** After T221 and T223. Review (sonnet) PASS. Daemon +115 net. No force push; `owner:branch` PR lookup; push stderr scrubbed; token-leak test scans the whole home. A push failure is recorded as held `ship_check` (no better reason code) → T225 adds `push_failed`.

### Ticket: T225 PR poller: PR state is the node's status
- **Priority:** P0
- **Status:** In Progress
- **Owner:** opus:worker-T225
- **Scope:**
  - Poll the open PRs of live nodes (60 s; 15 s when flagged; backoff; ETag; rate-limit pause with a thread note) and map them to `PullRequestState`.
  - The node shows review requested, changes requested, CI failing, approved, merged or closed. Merged → `human.status: landed`. Closed unmerged → a question for you.
  - Detect main moving on `pr` repos with `ls-remote`.
  - In this phase, changes appear as thread lines and audit events only. Routed events come in T244.
- **Acceptance Criteria:** Against the fake with a fake clock: each transition shows on the node. 304s don't rewrite the record. A 403 pauses polling.
- **Validation Steps:** `bun test packages/daemon/src/github packages/daemon/src/delivery`.
- **Notes:** After T224. From T224 review: add a `push_failed` held reason (DeliveryStateSchema) and use it for push failures; refuse or handle re-delivery once the PR is merged/closed (today `createPull` would 422). From T226: call `mainSync.mainMoved(repo)` when a PR merges and when `ls-remote` sees main move on `pr` repos.

### Ticket: T226 Sync after merge
- **Priority:** P0
- **Status:** In Review
- **Owner:** opus:worker-T226
- **Scope:** Add `daemon/sync`. After any merge into a repo's main (a direct merge, a PR merged, or main moving outside the app), merge main into every other live work node's branch on that repo (P15):
  - deferred while the session is mid-turn or the worktree is dirty;
  - on a conflict: abort, set the node to `conflict` with the files, and the existing Resolve applies;
  - pushed branches are pushed again after a clean sync.
- **Acceptance Criteria:** Unit: two nodes on one repo; merging one syncs the other; a conflicting pair is flagged with its files; a mid-turn node syncs at the end of the turn.
- **Validation Steps:** `bun test packages/daemon/src/sync`; `bun run test:integration`.
- **Notes:** After T223; the PR half needs T225. Direct half first; the PR half (main moving on `pr` repos) wires in after T225.

### Ticket: T227 ∥ Overlap tracking
- **Priority:** P1
- **Status:** Done (merge ad277c6)
- **Owner:** —
- **Scope:** Keep `touched` updated for every live work node: the merge-base diff plus uncommitted changes, recomputed after edit hooks, after commits and every 60 s. Two live nodes on the same repo, in any project, sharing a file raise an overlap. It shows on both nodes, on their ancestors and in the repo view (T209 slot), and clears when either node merges or stops touching the file.
- **Acceptance Criteria:** Unit: an overlap appears within one recompute and clears after a merge. e2e: the repo view shows the warning.
- **Validation Steps:** `bun test packages/daemon/src/sync`; `bun run test:e2e`.
- **Notes:** After T201. Can run alongside T224–T226. Review (sonnet) PASS. Daemon +198. Overlaps derived per frame from `touched` (never stored). Recompute on every non-read-only PostToolUse (not debounced) + 60 s sweep. Routed `overlap` event and coordinator suggestion are later (T244/T287).

### Ticket: T228 Waits-on, merge-together and auto-merge
- **Priority:** P1
- **Status:** Todo
- **Owner:** —
- **Scope:**
  - `waits_on` holds delivery until the target is merged, or closed for a non-work target (P8). `satisfied_at` is set by the daemon. Add `agile node wait <id> --on <id>` and a Link button.
  - `merge_together` groups deliver together (P7).
  - With `auto_merge` on, the daemon enables GitHub auto-merge once the ship checks pass and every `waits_on` is satisfied; if GitHub refuses, it shows `auto_merge: unavailable` (P19).
  - No agent is involved yet.
- **Acceptance Criteria:** Against the fake:
  - a waiting node is held until its target merges, then enables auto-merge and is merged by the fake;
  - a merge-together pair of direct nodes merges together or not at all;
  - "unavailable" is shown when the fake refuses.
- **Validation Steps:** `bun test packages/daemon/src/delivery`.
- **Notes:** After T225 and T226.

### Ticket: T229 ∥ Repo visibility
- **Priority:** P2
- **Status:** Done (merge f0fea9d)
- **Owner:** —
- **Scope:** A private repo is readable only by the projects it lists (P13):
  - it is left out of the session's readable directories;
  - there is a built-in path check that denies reads under its path for nodes in projects that aren't listed;
  - code changes are always limited to the node's own repo, whatever the visibility.

  The node shows "visibility advisory" for hookless vendors.
- **Acceptance Criteria:** Hook tests: a Blog node reading a private api listed only for Shop is denied with the reason; a Shop node is allowed.
- **Validation Steps:** `bun test packages/daemon/src/hook packages/daemon/src/permissions`.
- **Notes:** After T222. Review (sonnet): 2 blocking fixed (fail closed when repos.yaml is unreadable; Bash command paths checked). Daemon +166. Not done: no per-session readable-dirs list exists to exclude a private repo from (P13 bullet 1 needs an ACP session-config decision); hookless vendors get the advisory label only.

### Ticket: T230 Phase 8 QA and Pete's look
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** Black-box QA against the fake GitHub and the fake agent: direct delivery, PR delivery, the poller transitions, sync, overlaps, holds, auto-merge, visibility, and the migration of the Phase 7 home. Daemon line count. Pete then runs one direct delivery on ledger-lite and one PR on agile-test-repo.
- **Acceptance Criteria:** QA ACCEPT. Live: the ledger-lite node merges with one click. The agile-test-repo node opens a real PR whose state shows on the node. After Pete merges on GitHub, the node shows merged and the other live node on the repo is synced.
- **Validation Steps:** Pete, on his Mac:

```zsh
export AGILE_HOME=~/.agile-phase7
agile daemon start
gh auth status
agile repo set agile-test-repo --delivery pr --auto-merge off
agile repo set ledger-lite --delivery direct
SHOP=$(agile project list --json | jq -r '.[] | select(.name=="Shop") | .id')
A=$(agile node new --project $SHOP --title "Test repo note" --goal "Add one line to README.md saying the repo is used for agile-agents live checks; commit it" --repo agile-test-repo --json | jq -r .id)
B=$(agile node new --project $SHOP --title "Test repo second note" --goal "Add a file NOTES.md with one line; commit it" --repo agile-test-repo --json | jq -r .id)
L=$(agile node new --project $SHOP --title "Ledger help text" --goal "Make the CLI print a one-line usage when run with no arguments; add a test" --repo ledger-lite --json | jq -r .id)
agile node show $A --json | jq -r '.agent.status'
```

  Wait until A and L are `done` (repeat the last line, or watch the cockpit). Then:

```zsh
agile deliver $A
agile node show $A --json | jq -r '.delivery_state.status, .delivery_state.pr.url'
agile deliver $L
agile node show $L --json | jq -r .delivery_state.status
```

  Merge the PR on github.com. Within two minutes:

```zsh
agile node show $A --json | jq -r '.delivery_state.status, .human.status'
agile node show $B --json | jq -r '.delivery_state.status'
agile tail --stream $B
cd ~/Projects/ledger-lite
git status --short
```

- **Notes:** D10. Close the test PRs and branches on agile-test-repo afterwards if you don't want them kept.

### Phase 9 — Events

### Ticket: T240 Routed event schema and store
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:**
  - Add `RoutedEvent` and `Delivery` (§14.9) in `shared/routed-event.ts`, with typed payloads per event type (§15).
  - Add `events/log.jsonl` and `events/queue/<node>.jsonl` through the store, fsynced before `emit` returns.
  - A corrupt line is refused with path and line.
  - The audit log is unchanged (P9).
- **Acceptance Criteria:** Store tests: emit then a crash (simulated) then a restart shows the delivery still `pending`; payloads over the cap are refused.
- **Validation Steps:** `bun test packages/shared packages/daemon/src/events`.
- **Notes:** First ticket of Phase 9.

### Ticket: T241 Router
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** `events/router.ts`: routes to self, ancestors, waits-on, same-repo (live work nodes, any project), parties and sibling (§15), with the reason recorded in `routing`. Coalesce keys. A closed node gets `expired`.
- **Acceptance Criteria:** Table tests over the worked example tree: Blog's merge reaches its parent (`ancestor`) and Shop's api part (`same_repo`), and nothing on web.
- **Validation Steps:** `bun test packages/daemon/src/events`.
- **Notes:** After T240.

### Ticket: T242 Delivery to sessions, digests, no drops
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:**
  - Pending deliveries for a node with an idle session fold into one digest prompt within 2 s, and are marked delivered in the same write (P10). A mid-turn session holds them until the turn ends.
  - Replace `AttachService.say` and the answer-delivery prompts with `human_line` and `answer` events. T174's queue and its "queued" marker become the event queue.
  - A delivery is never lost when a session ends with events pending: it waits for the next session or wake.
- **Acceptance Criteria:** Fake-agent tests:
  - three events during a turn produce one digest after it;
  - a restart between send and mark causes no duplicate within the digest;
  - T174's tests pass rewritten on events.
- **Validation Steps:** `bun test packages/daemon/src/events packages/daemon/src/attach`; `bun run test:integration`.
- **Notes:** After T241. Removes the old prompt paths (line delta should be small).

### Ticket: T243 Wake policy
- **Priority:** P1
- **Status:** Todo
- **Owner:** —
- **Scope:** Per P11:
  - which event types start a session for each role when none is live;
  - a wake budget per node per hour (config, default 20) that goes to the inbox when exceeded;
  - stopped nodes are never woken.
- **Acceptance Criteria:** Table tests per role and type; the budget test; a stopped node keeps its events pending.
- **Validation Steps:** `bun test packages/daemon/src/events`.
- **Notes:** After T242.

### Ticket: T244 Event producers
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** Emit the §15 types that exist so far: `human_line`, `answer`, `child_status`, `child_delivered`, `pr_review`, `ci_failed`, `pr_behind`, `pr_merged`, `pr_closed` (from T225), `main_changed` and `sync_conflict` (from T226), `overlap` (T227), `dependency_satisfied` (T228). Each has its one-line summary text as in §15. The `read_event` verb returns a payload.
- **Acceptance Criteria:** One test per producer asserting the type, routing and summary; `read_event` over MCP.
- **Validation Steps:** `bun test packages/daemon`; `bun run test:integration`.
- **Notes:** After T241. It may split into two workers (PR-related and the rest) if large.

### Ticket: T245 ∥ Activity feed per node
- **Priority:** P1
- **Status:** Todo
- **Owner:** —
- **Scope:** Add a node Activity tab: every event routed to the node with its reason, delivery status and which session or digest carried it ("what woke it and why"). Add `agile tail --node <id> --events`. The repo view shows repo events.
- **Acceptance Criteria:** e2e: a `main_changed` shows on the other node's Activity with "same repo".
- **Validation Steps:** `bun run test:e2e`.
- **Notes:** After T242.

### Ticket: T246 PR babysitting
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** The work node's agent looks after its PR (projects-design §4.1):
  - A babysit brief section, and wake on `pr_review`, `ci_failed` and `pr_behind`.
  - A CI log excerpt is written to `sessions/<id>/` with a pointer.
  - After the fix, the agent pushes through `deliver` (T224 update path).
  - Design disagreements go to the inbox with `ask`. A flaky test is reported, never skipped.
  - With auto-merge on, T228's enable runs after each green push.
- **Acceptance Criteria:** Fake GitHub + fake agent: a failing check wakes the agent and the scripted fix pushes; the check goes green; an approval with auto-merge on gets merged by the fake; the node shows merged with no human click.
- **Validation Steps:** `bun test packages/daemon/src/delivery packages/daemon/src/events`; `bun run test:integration`.
- **Notes:** After T243 and T244. Moved here from Phase 8 because it needs events (see the build order note).

### Ticket: T247 Phase 9 QA and Pete's look
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** Black-box QA: routing across projects, digests, restart without loss, the wake budget, babysitting on the fake. Daemon line count. Pete runs a PR on agile-test-repo with auto-merge on, comments on it on GitHub, and watches the agent respond.
- **Acceptance Criteria:** QA ACCEPT. Live: Pete's review comment reaches the agent as an event, the agent pushes a fix, and the PR auto-merges after Pete approves. The node's Activity tab shows each event.
- **Validation Steps:** Pete, on his Mac:

```zsh
export AGILE_HOME=~/.agile-phase7
agile daemon start
agile repo set agile-test-repo --delivery pr --auto-merge on
SHOP=$(agile project list --json | jq -r '.[] | select(.name=="Shop") | .id')
P=$(agile node new --project $SHOP --title "Test repo greeting" --goal "Add hello.sh that prints hello; make it executable; commit" --repo agile-test-repo --json | jq -r .id)
agile node show $P --json | jq -r .agent.status
```

  When it is `done`:

```zsh
agile deliver $P
agile node show $P --json | jq -r .delivery_state.pr.url
```

  On GitHub, comment on the PR: "print hello world instead". Then:

```zsh
agile tail --node $P --events
agile node show $P --json | jq -r '.delivery_state.pr.review, .delivery_state.pr.checks'
```

  After the agent has pushed, approve the PR on GitHub (if the repo has no required review, auto-merge may merge straight away). Then:

```zsh
agile node show $P --json | jq -r '.delivery_state.status, .delivery_state.pr.auto_merge'
```

- **Notes:** If GitHub says auto-merge is not allowed on agile-test-repo, turn on "Allow auto-merge" in the repo settings first. P19 says the node shows `unavailable` otherwise.

### Phase 10 — Knowledge

### Ticket: T260 Knowledge items replace rules
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:**
  - Add `KnowledgeItem` (§14.3) in `shared/knowledge.ts`, and `knowledge/` in the store.
  - Migrate `rules/` (§17.1 step 2, P6), keeping the ulids. Rename `daemon/rules` to `daemon/knowledge`.
  - Add `agile knowledge add|list|show|accept|retire|test|report`, with `rules` kept as an alias, and `--kind`, `--scope`, `--path` and `--name` (T175 item 3).
  - Built-ins become `standard` items with `action`.
  - Delete `seed-plan-v1.ts`.
- **Acceptance Criteria:** Migration test on a copied home with every enforcement and stage combination. The CLI shows the name on cards. The existing rules tests pass under the new names.
- **Validation Steps:** `bun test packages/shared packages/daemon/src/knowledge packages/cli`.
- **Notes:** First ticket of Phase 10.

### Ticket: T261 Stacked scopes and paths
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** One scope filter (global, repo, project, subtree, plus `paths`) used by the brief, the hook and ship. In the worked example, the web part gets global, web and Shop items and its parent's contracts, and nothing from Blog. Paths filter against the files being edited (action) or changed (ship); the brief lists path-limited items under their globs.
- **Acceptance Criteria:** Table tests from the worked example (§11 step 3).
- **Validation Steps:** `bun test packages/daemon/src/knowledge packages/daemon/src/hook`.
- **Notes:** After T260.

### Ticket: T262 Ship checks: classifier and reviewer checklist
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** At delivery:
  - `ship` items run through the classifier over the diff (the old diff-rules code);
  - then a reviewer session with a checklist of every `review` item in scope, returning findings.

  Findings hold delivery and go back to the worker as a `ship_findings` event (added to §15). They go to you only when the check is unsure (route band) or the worker disputes them with `ask`.
- **Acceptance Criteria:** FakeClassifier + fake reviewer: a held delivery, a fix, a pass; a routed result reaches the inbox; the checklist appears in the reviewer's `brief.md`.
- **Validation Steps:** `bun test packages/daemon/src/delivery packages/daemon/src/knowledge`.
- **Notes:** After T261 and T244. The real key may be used for a manual check (D16).

### Ticket: T263 ∥ Lookup tool and briefs
- **Priority:** P1
- **Status:** Todo
- **Owner:** —
- **Scope:** Add a `lookup_knowledge(path)` verb (MCP) that returns the accepted items in scope for that path. Briefs include everything in scope and tell the agent to use the lookup before touching unfamiliar areas.
- **Acceptance Criteria:** A verb test over MCP; a brief snapshot test.
- **Validation Steps:** `bun test packages/daemon/src/runner packages/cli`.
- **Notes:** After T261.

### Ticket: T264 Proposals, lessons kinds and `knowledge_accepted`
- **Priority:** P1
- **Status:** Todo
- **Owner:** —
- **Scope:**
  - `propose_knowledge` replaces `propose_rule`. The agent picks the kind; the scope defaults to the node's subtree.
  - Lessons propose items with a kind (projects-design §17, lessons row).
  - Accepting an item emits `knowledge_accepted` to every live node in scope.
  - Items that never fire are flagged in the report (unchanged logic, re-keyed).
- **Acceptance Criteria:** Tests: accepting a Shop decision reaches Shop's live nodes and not Blog's; lessons after `merged` propose with a kind.
- **Validation Steps:** `bun test packages/daemon/src/knowledge packages/daemon/src/lessons packages/daemon/src/events`.
- **Notes:** After T244 and T260.

### Ticket: T265 ∥ Per-repo norms in the repo view
- **Priority:** P2
- **Status:** Todo
- **Owner:** —
- **Scope:** The repo view (T209) lists the accepted standards and architecture for that repo, with enforcement and stats.
- **Acceptance Criteria:** e2e: an accepted api standard shows under api.
- **Validation Steps:** `bun run test:e2e`.
- **Notes:** After T260.

### Ticket: T266 Knowledge screen
- **Priority:** P1
- **Status:** Todo
- **Owner:** —
- **Scope:** The Rules screen becomes Knowledge:
  - filter by kind, scope and enforcement; edit text, paths, enforcement and check;
  - bulk accept and retire; Test examples (unchanged);
  - the "never fires" flag.

  Inbox cards say "standard/architecture/decision proposed".
- **Acceptance Criteria:** e2e: accept a proposed decision and see it on a node's Knowledge-in-scope tab.
- **Validation Steps:** `bun run test:e2e`.
- **Notes:** After T260. Pete looks at it.

### Ticket: T267 Phase 10 QA and Pete's look
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** Black-box QA of the migration, scopes, action and ship enforcement (real key allowed per D16), lookup and events. Daemon line count. Pete adds a ship-check standard on ledger-lite and watches a delivery get held and fixed.
- **Acceptance Criteria:** QA ACCEPT. Live: the delivery is held with the item named, the worker adds the test, and the next deliver merges. A decision accepted mid-run shows in the live node's Activity.
- **Validation Steps:** Pete, on his Mac:

```zsh
export AGILE_HOME=~/.agile-phase7
agile daemon start
agile knowledge list
K=$(agile knowledge add --name tests-with-changes --kind standard --scope repo:ledger-lite --text "Every change to a file under src/ comes with a test that exercises it" --enforcement ship --example "diff changes src/ledger.ts and adds no test::true" --example "diff changes src/ledger.ts and test/ledger.test.ts::false" --json | jq -r .id)
agile knowledge accept $K
SHOP=$(agile project list --json | jq -r '.[] | select(.name=="Shop") | .id')
N=$(agile node new --project $SHOP --title "Ledger total" --goal "Add a total command that prints the sum of all entries. Do not write a test unless a check asks for one." --repo ledger-lite --json | jq -r .id)
agile node show $N --json | jq -r .agent.status
```

  When it is `done`:

```zsh
agile deliver $N
agile node show $N --json | jq -r '.delivery_state.status, .delivery_state.held_by'
D=$(agile knowledge add --name totals-in-cents --kind decision --scope project:$SHOP --text "Totals are printed in integer cents" --enforcement tell --json | jq -r .id)
agile knowledge accept $D
agile tail --node $N --events
```

- **Notes:** The goal's "do not write a test" wording is deliberate, so the hold fires.

### Phase 11 — Coordination

### Ticket: T280 Coordinator role
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:**
  - Add a `coordinator` session role for coordinating nodes and project roots (P20): no worktree, the scratch cwd, read access under visibility, writes denied by the hook.
  - The coordinator brief: children, their cards (once T283 exists), knowledge in scope, the autonomy level.
  - The coordinator is woken by any event routed to it (T243).
- **Acceptance Criteria:** A fake-agent test: `child_status` wakes the coordinator with a digest. A hook test: a coordinator write is denied.
- **Validation Steps:** `bun test packages/daemon/src/runner packages/daemon/src/events packages/daemon/src/hook`.
- **Notes:** First ticket of Phase 11.

### Ticket: T281 Plans and contracts
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:**
  - Add `Plan` and `Contract` records (§14.4), with the verbs `plan_write` and `contract_write` for coordinators.
  - A plan starts as `draft`. Approval is an inbox card at every level, because the plan decides what gets built.
  - Children get their owned paths and the contracts they rely on in their brief.
  - Add a Plan tab on the stream page.
  - `plan_changed` and `contract_changed` events.
- **Acceptance Criteria:** Tests: approving the plan gives both children the contract in their brief; bumping a contract notifies its parties only.
- **Validation Steps:** `bun test packages/daemon/src/coordination`; `bun run test:e2e`.
- **Notes:** After T280.

### Ticket: T282 Autonomy levels for coordinators
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** One gate function `allowed(principal, action, level)` for:
  - the coordinator actions `add_child`, `add_waits_on`, reorder, `set_owner`, `merge_siblings` and `approve_contract`;
  - the level from the node override, else the project;
  - at Advise, an action becomes an inbox proposal card with Apply;
  - at Organise, it is applied and a thread line tells you;
  - at Run, routine contract approvals are allowed too (P12);
  - never: merge, accept knowledge, answer a question, or change a goal.

  Add the setting to the project and node UI, plus `agile project set <id> --coordinator-autonomy|--director-autonomy advise|organise|run` and `agile node set <id> --autonomy …`.
- **Acceptance Criteria:** A table test over principal × action × level; e2e: Apply on an Advise card.
- **Validation Steps:** `bun test packages/daemon/src/coordination`; `bun run test:e2e`.
- **Notes:** After T281. The Director reuses this function (T301).

### Ticket: T283 ∥ Status cards
- **Priority:** P1
- **Status:** Todo
- **Owner:** —
- **Scope:** Add `cards/<node>.yaml` (§14.5). The daemon updates `files`, `state` and `relies_on`; the `progress` verb updates `doing`. The `read_card(node)` verb is limited to siblings, ancestors and the Director. Cards show on the parent's page.
- **Acceptance Criteria:** A card follows edits within one recompute; a sibling can read it; a node in another project can't.
- **Validation Steps:** `bun test packages/daemon/src/coordination`.
- **Notes:** After T280 and T227.

### Ticket: T284 Import index and sibling alerts
- **Priority:** P1
- **Status:** Todo
- **Owner:** —
- **Scope:** Build `index/<repo>.json` for TS/JS only (P14) and keep `exports_changed` on cards. Alerts:
  - the same file edited by siblings → `overlap` to both plus the parent;
  - a changed export used by a sibling → `symbol_changed`;
  - a contract's paths touched → the parent and its parties.
- **Acceptance Criteria:** A fixture repo: changing the export `salePrice` in `prices.ts` alerts the sibling that imports it, and nobody else.
- **Validation Steps:** `bun test packages/daemon/src/sync packages/daemon/src/coordination`.
- **Notes:** After T283.

### Ticket: T285 Contract proposals
- **Priority:** P1
- **Status:** Todo
- **Owner:** —
- **Scope:** The `propose_contract` verb (from one child, or co-signed by siblings) adds a `contract_proposal` to the parent. The coordinator approves it (at Run, when it is routine), rejects it with a reason, or asks you (an inbox card). Approval bumps the version and notifies the parties.
- **Acceptance Criteria:** The worked-example test: api proposes `saleEndsAt`, the coordinator approves at Run, and web gets `contract_changed`. At Organise the same proposal goes to the inbox.
- **Validation Steps:** `bun test packages/daemon/src/coordination`.
- **Notes:** After T282.

### Ticket: T286 ∥ Ask sibling
- **Priority:** P2
- **Status:** Todo
- **Owner:** —
- **Scope:** The `ask_sibling(node, question)` and `reply_sibling` verbs. The exchange is written to both threads, and the parent gets a copy. A joint proposal is `propose_contract` with both signatures. The brief states the line between details and plan changes.
- **Acceptance Criteria:** The fake-agent currency example from §9.5 end to end.
- **Validation Steps:** `bun test packages/daemon/src/coordination packages/daemon/src/events`.
- **Notes:** After T285.

### Ticket: T287 Sibling finished and collisions go to the parent
- **Priority:** P1
- **Status:** Todo
- **Owner:** —
- **Scope:**
  - When a child merges, the parent is woken first, and its `note_child` verb sends targeted notes. Same-repo siblings still get the sync.
  - An overlap or collision wakes the parent with options: add `waits_on`, give ownership, or merge the siblings. The action is gated by T282.
- **Acceptance Criteria:** Fake-agent test: an overlap reaches the parent; at Organise the scripted `add_waits_on` is applied and you are told.
- **Validation Steps:** `bun test packages/daemon/src/coordination`.
- **Notes:** After T284.

### Ticket: T288 ∥ Helper children on the same repo
- **Priority:** P2
- **Status:** Todo
- **Owner:** —
- **Scope:**
  - `node new --helper-of <work node>` creates a same-repo child that branches off the work node's branch and delivers back into it (a direct merge into that branch). The parent stays a work node (P1).
  - A helper on another repo triggers the §7 reshape instead.
  - This supersedes the unfiled "side-quest" proposal.
- **Acceptance Criteria:** A test: the helper merges into its parent's branch; the parent delivers one PR containing both.
- **Validation Steps:** `bun test packages/daemon/src/delivery packages/daemon/src/streams`.
- **Notes:** After T205 and T223.

### Ticket: T289 Phase 11 QA and Pete's look
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** Black-box QA of the coordinator, plans, contracts, levels, cards, alerts, ask-sibling and helpers with fake agents. Daemon line count. Pete runs the worked example on his two repos with a live coordinator.
- **Acceptance Criteria:** QA ACCEPT. Live: the coordinator writes a plan and a contract that Pete approves. The two parts work from them. A contract proposal reaches the parent and is decided. Pete sees it as one line in the activity feed.
- **Validation Steps:** Pete, on his Mac:

```zsh
export AGILE_HOME=~/.agile-phase7
agile daemon start
SHOP=$(agile project list --json | jq -r '.[] | select(.name=="Shop") | .id')
agile project set $SHOP --coordinator-autonomy organise
C=$(agile node new --project $SHOP --title "Ledger export" --goal "Export ledger entries as JSON; the test repo gets a schema file describing the JSON" --json | jq -r .id)
agile node add-repo $C ledger-lite
agile node add-repo $C agile-test-repo
agile node show $C --json | jq -r .role
agile inbox
```

  Approve the plan card in the cockpit. Then:

```zsh
agile node list --parent $C --json | jq -r '.[] | .id + "  " + .title + "  " + .agent.status'
agile tail --node $C --events
```

- **Notes:** —

### Phase 12 — The Director

### Ticket: T300 Director record, thread and page
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** Add `director.yaml` and `threads/director.jsonl` (P16). A Director session (the coordinator mechanics, no worktree) is woken by `director_request`. There is a Director page in the cockpit (thread plus activity) plus `agile director say` and `agile tail --director`. Every Director action is recorded with principal `director`.
- **Acceptance Criteria:** A fake-agent test: a human line reaches the Director and its reply lands on its thread. e2e: the page exists.
- **Validation Steps:** `bun test packages/daemon/src/director`; `bun run test:e2e`.
- **Notes:** First ticket of Phase 12.

### Ticket: T301 Director tools and guards
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:**
  - Verbs: `draft_tree`, which returns a draft that renders as a tree with a Create button at Advise; `create_project`, `create_node`, `start_node`, `add_waits_on` and `restart_node`, gated by T282's function with the project's `director` level.
  - The Director never merges, accepts knowledge, or answers a question (hard refusals, tested).
- **Acceptance Criteria:** Table tests per level; e2e: Create on an Advise draft builds the tree.
- **Validation Steps:** `bun test packages/daemon/src/director packages/daemon/src/coordination`; `bun run test:e2e`.
- **Notes:** After T300 and T282.

### Ticket: T302 Cross-project sight and "what needs me today?"
- **Priority:** P1
- **Status:** Todo
- **Owner:** —
- **Scope:**
  - The Director's brief gets a digest of all projects: overlaps, waits-on, stuck or idle nodes (no activity for longer than a configured time while `working`), and the inbox.
  - It proposes links and spots when a norm from one project is about to be broken in another.
  - "What needs me today?" answers from the snapshot, not from memory.
- **Acceptance Criteria:** A snapshot test of the digest; a fake-agent test where a stuck node yields a suggestion card.
- **Validation Steps:** `bun test packages/daemon/src/director`.
- **Notes:** After T301.

### Ticket: T303 ∥ Norm suggestions
- **Priority:** P2
- **Status:** Todo
- **Owner:** —
- **Scope:** Findings that repeat across projects (the same file area or wording across reviewer findings and PR comments) wake the Director, which may `propose_knowledge`. The proposal comes to you as usual.
- **Acceptance Criteria:** A test: three similar findings across two projects produce one proposal with its sources.
- **Validation Steps:** `bun test packages/daemon/src/director packages/daemon/src/knowledge`.
- **Notes:** After T264 and T301.

### Ticket: T304 Phase 12 QA and Pete's look
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** Black-box QA of the Director levels and guards with a fake agent. Daemon line count. Pete talks to a live Director at Advise and then Organise.
- **Acceptance Criteria:** QA ACCEPT. Live: at Advise, Pete gets a draft tree with Create. At Organise, the Director creates and starts a small project and posts what it did. It refuses a merge request.
- **Validation Steps:** Pete, on his Mac:

```zsh
export AGILE_HOME=~/.agile-phase7
agile daemon start
agile director say "What needs me today?"
agile director say "Blog needs a CHANGELOG.md in ledger-lite listing the last five commits"
BLOG=$(agile project list --json | jq -r '.[] | select(.name=="Blog") | .id')
agile project set $BLOG --director-autonomy organise
agile director say "Go ahead with the changelog"
agile node list --project $BLOG --json | jq -r '.[] | .title + "  " + .agent.status'
agile director say "Merge the changelog when it is done"
agile tail --director
```

- **Notes:** The last `say` must be refused ("merging is yours").

### Phase 13 — External links

### Ticket: T320 Tracker port, fakes and credentials
- **Priority:** P1
- **Status:** Todo
- **Owner:** —
- **Scope:** `daemon/trackers` with one port (get issue, list epic children, add comment, add link, transition status, create issue) and two adapters (Jira REST, Linear GraphQL). There are fake servers for both, as in T220. Credentials follow P17 **only once Pete has approved it as a D-entry**. `agile daemon status` reports each tracker as configured or not.
- **Acceptance Criteria:** Adapter tests against the fakes. The token never appears in logs or events (asserted).
- **Validation Steps:** `bun test packages/daemon/src/trackers`.
- **Notes:** P17 approved (D31). First ticket of Phase 13.

### Ticket: T321 Link a node; pull its goal; edits as events
- **Priority:** P1
- **Status:** Todo
- **Owner:** —
- **Scope:** `agile node link <id> SHOP-11` and a Link field on the stream page. Linking sets the goal from the title, description and acceptance criteria. A poller (5 min) emits `external_changed` on edits and updates the goal with a thread line.
- **Acceptance Criteria:** Against the fake: link, edit the description in the fake, then the event and the goal update.
- **Validation Steps:** `bun test packages/daemon/src/trackers packages/daemon/src/events`.
- **Notes:** After T320.

### Ticket: T322 ∥ Roll-up
- **Priority:** P2
- **Status:** Todo
- **Owner:** —
- **Scope:** An unlinked node resolves to its nearest linked ancestor. The PR body mentions that issue (fills T224's line). The linked node shows progress as children merged/total.
- **Acceptance Criteria:** Unit tests for resolution and the PR body.
- **Validation Steps:** `bun test packages/daemon/src/trackers packages/daemon/src/delivery`.
- **Notes:** After T321.

### Ticket: T323 ∥ Import an epic's children
- **Priority:** P2
- **Status:** Todo
- **Owner:** —
- **Scope:** An "Import children" button and `agile node import-children <id>` create one linked child per issue in the epic. It is idempotent: already-linked issues are skipped.
- **Acceptance Criteria:** A test against the fake: running it twice creates each child once.
- **Validation Steps:** `bun test packages/daemon/src/trackers`.
- **Notes:** After T321.

### Ticket: T324 Status push and create issue
- **Priority:** P2
- **Status:** Todo
- **Owner:** —
- **Scope:**
  - A per-project `push_status` (off by default) and `status_map`: in progress, in review and done are pushed, and the PR link is added as a link or comment. The app never closes an issue or edits its text.
  - "Create issue" is a click only.
- **Acceptance Criteria:** Against the fake: with `push_status` off, nothing is sent; with it on, the mapped transitions are sent. There is no call that edits text (asserted on the fake's request log).
- **Validation Steps:** `bun test packages/daemon/src/trackers`.
- **Notes:** After T321.

### Ticket: T325 Phase 13 QA and Pete's look
- **Priority:** P0
- **Status:** Todo
- **Owner:** —
- **Scope:** Black-box QA against the fakes. Daemon line count, plus the full §6.1 walkthrough on the final branch. Pete links a node to a real issue in whichever tracker he uses.
- **Acceptance Criteria:** QA ACCEPT. Live: the goal is pulled from the issue, an edit shows as an event, and with `push_status` on the issue moves to in review when the PR opens. §6.1 is met.
- **Validation Steps:** Pete, on his Mac, after adding the tracker token in Settings (P17), with a real issue key typed in place of the example key below:

```zsh
export AGILE_HOME=~/.agile-phase7
agile daemon start
agile daemon status
SHOP=$(agile project list --json | jq -r '.[] | select(.name=="Shop") | .id')
N=$(agile node new --project $SHOP --title "Linked work" --goal "Placeholder until linked" --repo agile-test-repo --no-start --json | jq -r .id)
agile node link $N SHOP-1
agile node show $N --json | jq -r '.goal, .external_link.url'
```

- **Notes:** `SHOP-1` is an example. Pete types his own issue key, because there is no shared test tracker. This is the one command in the phase that can't be pasted unchanged.

## 8. Deleted (must be gone from `main` by the end of Phase 6)

Daemon: `em/`, `architect/`, `oracle/`, `qa/`, `halts/`, `quota/`, `handoff/`, `plan/`, `review/` rounds, `sync/` (shelved on a branch), `feed/stories.ts`, `runner/pipeline-glue.ts`, sprint parts of `merge/`, `bus/` unless the thread reuses it. CLI: `run`, `send`, `halt`, `approve`, `sync`. Shared: `Ticket`, `Sprint`, `Stanza`, `Message`, `Halt`, `Quota`, `Review`, `Qa`, `Oracle`, `Kb`, `Ledger`. Briefs: all but `worker.md`, `reviewer.md`, `lessons.md`. UI: `plan/`, `sprint/`, `review/`, `OraclePanel`. State: the `agile-state` orphan branch and per-repo `.agile/`.

## 9. Open questions

- Q1. Should a coding stream's target default to an integration branch (current behaviour) or straight to `main` when the repo has no integration branch? Plan assumes the repo's default branch; Pete to confirm at T132.
- Q2. Classifier thresholds (0.80 / 0.40 / confidence 0.50) are starting points; T153's live agreement rate decides whether to move them.
- Q3. Whether `bus/` survives as the thread's transport or is deleted; decided in T120 by whichever is less code.
- Q4. Whether repo docs live in `.agile-docs/` (tracked) or under the home (untracked). Plan says tracked so a repo carries its own guidance; Pete to confirm at T134. Superseded by D24: docs move to the home (T207).
- Q5–Q24. The proposed decisions P1–P20 in `design/projects-design.md` §19 are open until Pete confirms each one as a D-entry. Tickets assume them. P17 (tracker tokens in `config.yaml`, a second credential exception) must be approved before T320.

## 10. Discovered Issues Log

- Phase 7 complete on `claude/phase-7` (2026-09-24, tip 3ab7109): T200–T211 merged, T212 QA ACCEPT; awaiting Pete's look (draft PR https://github.com/petestewart/agile-agents/pull/4). Phase 8 proceeds on `claude/phase-8` cut from it (Pete: don't wait).
- (T229 merge) `.review-sonnet.md` had been committed by the T204 worker (on `claude/phase-7` too); untracked and `.gitignore` now lists the pipeline/review/QA scratch files.
- mode: yolo (2026-09-24), projects stage. Phase branches stacked (D30), `claude/phase-7` first; tickets `T###-<slug>` off the phase branch, merged back `--no-ff`. DIRECT_MODE (no `gh`). Phase N+1 starts without waiting for Pete's review of phase N (Pete, 2026-09-24).
- mode: yolo (2026-09-19). Integration branch for the reshape is `claude/reshape`; ticket branches `T###-<slug>` fork from it and merge back `--no-ff`. Pete lands each phase on `main` by PR. Mode: DIRECT_MODE (no `gh`).
- Q1 assumption in force: a coding stream's target is the repo's default branch when the repo has no integration branch (T132).
- Q4 assumption in force: repo docs are tracked in `<repo>/.agile-docs/` (T134).
- Playwright e2e suites are load-sensitive: run concurrently with a full `bun test` one of them times out (a different test each time). Unloaded they are green. Pre-existing; noted at T111.
- Phase 1 complete on `claude/reshape` (2026-09-19): T101, T110, T111, T112, T113 merged. Verification on the merged tip: build/typecheck/lint clean; `bun test` 2269 pass / 3 skip / 0 fail (163 files); `test:integration` 5 suites, 31 pass, 0 fail. Daemon source 34,975 lines (from 35,932). Note T101 (Phase 0, docs only) ran alongside Phase 1 rather than as a separate stop; Pete reviews `design/cockpit-design.md` with this phase.
- Baseline before Phase 1: daemon source (non-test `.ts` under `packages/daemon/src`) = 35,932 lines.

- (T121) The hook's `ask` verdict no longer files an `unblock` gate; it is a plain deny naming the rule until T151 rebuilds it as the `classifier_review` route band. Strictly more restrictive in the interim; the six removed `hook/service.test.ts` cases describe the behaviour T151 must restore.
- (T121) `waitingAgent` delivers answers to the raiser's role mailbox, not the stored `session`; T130's `ask` verb must route by session.
- (T121) HIL gate records still live in the repo's `.agile/board/hil/`; move to the state home in T122 or T123. **Resolved in T122**: gates now at `<home>/gates/HIL-*.yaml`.
- (T122) `agile approve` is gone before `agile land` (T140) exists; gates are decided over HTTP or `gate.*` RPC in between. CLAUDE.md's live-run text still names `agile approve`; T164 rewrites it.
- (T122) T123 ran after T122 rather than in parallel (the ∥ mark): its event pruning depends on T122's deletions.
- (Phase 2 verification) The CLI e2e tests start a real daemon on the home's default port 4600; two daemons on one machine (QA agent + `bun test`) collide and the lifecycle e2e fails with a vanished pidfile. Not a code defect (one daemon per machine is the design), but the e2e should set `port` in its temp home's `config.yaml` to a free port; fold into T125.
- (Pete's Phase 2 look, 2026-09-21, tip 8694c86) His local agent ran the 26-step hand test on `~/Projects/ledger-lite` with `AGILE_HOME=~/.agile-reshape`: 25 of 26 steps matched; the one failure was `daemon start` against a stale daemon on 4600 → T127. Two reported gaps are not defects: `close --note` does land on the thread (the agent closed the child and only ran `show` on the parent), and the port is already per-home (`config.yaml` `port`, `AGILE_PORT`) — the gap is that nothing tells the user so; T127 prints it and T164 documents it. `stream list` header, `status` with no stream summary, repo-less `show` placeholders and inbox age without a timestamp → T128. Raw event names in the web UI (`entity_put`, `repos_put`) and no link from a feed row to its stream are the expected pre-Phase-6 state (T160–T163). The residue in ledger-lite (`.worktrees/`, `runs/`, `tkt/*` branches) is dated 2026-09-18 from the pre-reshape live run; this run wrote nothing there.
- (Phase 2 manager check) Answering a human-raised question flips `agent.status` to `working` although no agent is attached. `QuestionService.answer` should only leave `question` for `working` when the stream has a session; otherwise back to `idle`. Fold into T130 (which introduces sessions on streams).
- (T132) Landing emits no `land_*` event kind, so the store's fsync-on-land rule (§7.4) is not exercised; add a `stream_landed` kind (fsynced) in T141 when lessons need the landing as an event anyway. (T132) `GateService` has no resolution hook; landing wraps `respond` at wiring time. Add `onResolved` when T140/T152 need a second subscriber.
- (T131 merge) The merge commit bb94105 carries git's `# Conflicts:` comment after the two trailer lines (a `--no-edit` conflict merge keeps it); the force-push to rewrite it was blocked by the session's permission policy, so it stays. Message-only; the tree is correct.
- (Pete's Phase 3 live run, 2026-09-21, tip 2410916, two attempts) Worker attached, surveyed ledger-lite, found no CLI, asked A/B/C via `ask` and ended its turn. The answer never reached the session: `deliverAnswer` writes a bus mailbox nobody reads. `agent.status` stayed `working` for 19 min (live-but-idle passes the live-session check); `detach` wrote `done` on an empty stream and printed "no live session" while killing one. Branch was `<id>-<slug>` not `stream/<id>-<slug>`; a multi-line agent message split into two thread entries; inbox context truncated mid-word. → T137 (P0, blocks the T135 milestone) and T136. Nothing landed; ledger-lite `main` untouched at 41a1a39.
- (Pete's Phase 3 live run, 2026-09-22, tip 88cdeb4) End to end for the first time: answer delivery, self-stop, review, land all behaved; landed dc4d983 on ledger-lite main. The manifest hook's escape hatch ("file a hil_request") is unreachable from the agent → T138. `land` correctly refused a dirty target checkout. Two `done/open` streams from the failed runs sit in the inbox until closed (by design; wording → T136).
- (T138) `hil_request` survives only as a bus message kind (`shared/src/message.ts` and its users in `bus/routing.ts`, `gates/service.ts`, `permissions/responder.ts`, `feed/snapshot.ts`); the verdict strings no longer name it. Delete the kind with the rest of the bus in Phase 6's cleanup (T160) or a small mechanical ticket.
- (T138) `runner/worktrees.ts` `gitAsync` uses an async piped `Bun.spawn` and hits the known `EBADF epoll_ctl` race under full-suite load (PLAN-v1 T033 fixed the same pattern elsewhere by writing output to `Bun.file` paths). Production path (`attach → createWorktree`); fold the fix into T143, which touches the push detector in the same area.
- (T138) `GateService.consume` is check-then-write; make it compare-and-swap in T151 when the classifier adds a second caller.
- (T141 merge) Merge commit 03e84ab was committed with an unresolved `daemon.ts` hunk and the board's commit message (manager's command chain did not stop on the conflict); fixed by the following commit on `claude/reshape`. Tree correct from there; history-only blemish, not rewritten.
- (T143) A push through an alias already present in the repo's or user's git config (`git p` after an earlier `git config alias.p push`) is invisible to the push detector; only the `-c alias.*` spelling fails closed. Follow-up: a built-in `command_deny` on `git config alias.*` (an agent must not define aliases) and, if needed, reading the worktree's effective aliases at attach. Note for T151/T152.
- (Pete's Phase 4 live run, 2026-09-22, tip 9d6a539) Milestone met (see T144). Findings: the worker asked via `ask` and hit the gate in the same turn; approving the gate left the question open, so the turn end parked the session `idle` under a stream still reading `working` and it never self-stopped (the `--quiet` stream, with no question, self-stopped fine); built-ins are shown by ULID only; `rules report` flags never-violated critical pattern rules as prune candidates; the brief is not on disk; a quoted `"yes note"` is a usage error → T145. Also: inbox `done` items from finished streams accumulate until land/close (by design §3, noted as friction); the Phase 3 events in `tail --kind hook_decision` still carry the old `hil_request` wording (history, not current code).
- (T145) Gate supersession and gate-decision delivery are both wrapped onto `GateService.respond`, so a gate resolved by any other path (the `human_timeout` fallthrough, `delegateRequest`) neither delivers nor supersedes. Move both onto one "gate resolved" notification point when a second non-human resolver exists (T151's route band is the likely trigger). Reviewer's note: supersession closes the session's open questions session-wide, not turn-scoped; add a same-session/different-turn regression test when the rule is next touched.
- (T150) Derived Noul confidence makes §6.3's confidence floor unable to do the job its rationale names. The docs return no confidence for a yes/no answer, so the adapter derives `|2p-1|`; that fires independently only for `0.25 < p < 0.40` (pulling some ALLOWs to ROUTE) and can never protect a DENY, because `p >= 0.80` implies confidence >= 0.6, always above the 0.50 floor. A confident-looking deny that the model is unsure about is therefore unreachable in v0. `parseJevResponse` already prefers a real `confidence` if Jev returns one. Decide in T151/T153 whether the floor stays as written, moves, or waits for live data.
- (T150 review round 2, non-blocking) The private-key-block pattern's body runs to the footer or to end-of-state; a `BEGIN ... PRIVATE KEY` marker in a comment or fixture with no `END` anywhere in the state redacts the whole tail (demonstrated: 50 lines to one marker). Over-redaction, not a leak. Consider requiring a base64-shaped body before the end-of-state fallthrough. Also: an identifier starting with `eyJ` followed by two 8+-char dotted segments is redacted as a JWT (contained to that token).
- (T150) Commit 63a1771 on the T150 branch carries `Co-Authored-By: Claude Opus 5` instead of the standing `Claude Fable 5.1` trailer: the worker picked up a mid-task attribution notice. Message only; not rewritten, since the branch was already pushed.
- (T151/T152 merge) Both branches were green alone and the merge was textually clean, but each had grown its own `ClassifierBand` and the CLI stopped typechecking on the ambiguous re-export. Collapsed onto the classifier's `bandFor` (§6.3 wants one implementation). A textually clean merge of two concurrent tickets is not a verified merge; typecheck and build after every one.
- (T151) `RulesService.recordFired` always bumps `fired`, so a routed call the human later denies counts `fired: 2, routed: 1, violated: 1` for one logical action. Skews the violated/fired ratio the pruning report and T153's agreement rate depend on. Needs a `recordFired` outcome that does not bump `fired`; fix before T154 reads real stats.
- (T151 review) A denied-and-retried routed call re-invokes the classifier on every retry while its gate is pending, unbounded until the human answers. Cost, not correctness.
- (T152) Pending `classifier_review` gates from a superseded diff are never closed, so stale cards accumulate in the inbox after a new commit. Verified untidy rather than unsafe: landing re-runs the check on the current diff and matches only the current fingerprint, so approving a stale card cannot merge anything. Needs `GateService.supersede(id, reason)` resolving with no decision (auto-denying would show the operator a decision they never made).
- (T152) Commits on the T152 branch carry `Co-Authored-By: Claude Opus 5`; the worker declined the standing `Claude Fable 5.1` trailer, citing its own harness attribution instruction. Message only, not rewritten.
- (T153 review) `landing/diff-rules.ts` raises its `classifier_review` gate without a `rule` on the record, and `wireClassifierRouteStats` guards on `resolved.rule !== undefined`, so a **denied landing route is never attributed back to its rule**: the diff tier contributes nothing to `violated`. A missing counter rather than a corrupted one (so out of T153's scope), but it undermines §5.7's pruning input for the diff tier exactly as the fixed double-count did. One line in `DiffRules.route`'s `gates.request`.
- (T154 QA) A detached `agiled` has no seam for injecting a `FakeClassifier`, so the classifier tier cannot be driven black-box against a real daemon: QA had to run an in-process `startDaemon` with a real socket. Everything that needs a scripted classifier through the CLI is therefore unreachable to a black-box pass, including `agile hook pre-tool-use` end to end and a routed `agile land`. Consider a test-only env var or config value naming a scripted fake, so future phase QA can drive the tier the way an operator would.
- (T160, Pete 2026-09-22) Landing UX: `Land` on a ready card refuses with "main is checked out with uncommitted changes at <repo>" and the only remedy is the terminal. Needs improving eventually (say what's dirty, offer a fix, and don't let the daemon's own `.agile-docs/` writes be the cause). Not ticketed yet.
- (T156) Unverified until a live call: the Jev wire field for rule criteria is guessed as `criteria` (`JEV_CRITERIA_FIELD` in `classifier/jev-wire.ts`, one place). Real agreement of the two reworded seed rules also needs a live `agile rules test`. Existing seeded rules in a state home keep their old wording until `agile rules edit`.
- (D15) The cockpit listens on localhost with no login, so using it from a phone off the Mac needs a tunnel and auth; not in any ticket yet.
- (T161 QA) `agile init` on a directory pre-created with `mkdir -p` once exited 2 while printing a success line. Seen once, not reproduced; outside T161 scope.
- (T161) Gaps against §9.3 accepted for now: thread updates per message not per token; Land preflight lists diff rules but does not run them; Attach/Review use default vendor/model/effort (no picker); diffs over 20k chars truncated with no pointer; no close/archive on the stream page; thread shows the newest 500 lines. Tree click opens the stream page; inbox cards open it only via an explicit "Open stream" button (answering stays inline, §3.3).
- (T165) `packages/cli/src/stream.e2e.test.ts` ("agile attach (T130) on a no-repo stream") failed 1 of 2 isolated runs while three workers ran suites concurrently; 4/4 on base and 4/4 on the branch unloaded. Load-sensitive like the Playwright suites; watch it.
- (T162 review) New stream dialog lacks role="dialog"/aria-modal and a focus trap. Quick-capture errors show only as a red border; repo is free text (no picker).
- (T166) Merged-outside detection: fast-forward merges rely on the branch reflog; an untouched branch forked off a non-first-parent commit could read as merged (cosmetic, needs a click). Close/mark-landed check the id before the cross-origin check (400 vs 403 on a bad id; nothing mutates).
- (T163 QA, 2026-09-23) INCIDENT: the cloud environment now carries a real `TYPESAFE_API_KEY` in every shell (set in the environment config for the T154 agreement check). A QA daemon inherited it and made one real classifier call from "Test examples" before QA caught it and re-ran key-less. Violates the standing no-key-in-cloud rule. Resolved by D16: Pete keeps the key and allows real classifier calls.
- (T163 QA) `evals.available` is true whenever a `Classifier` object is built, not when a key is present, so the Rules screen's disabled-with-tooltip state for Test examples is unreachable; the click fails with a clear per-example error instead. (T163 review) No cap on examples per rule.
- 2026-09-23 (T170 QA): when a vendor session dies right after Attach, the stream page shows only `stopped` and a "session ended" thread line — no reason. Surface the vendor stderr tail on the session strip. Not scheduled.

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
- **D33** (2026-09-25, Pete): conversations can have children (tangents). A conversation whose children are all conversations stays a conversation; it becomes coordinating only once a child has a repo. A tangent is started from a thread line ("Branch off") or `node new --parent`; when it finishes it posts a short summary event to the parent's thread. Amends P1.
- **D34** (2026-09-25, Pete): the tree can be restructured by hand. Move a node under another parent in the same project (drag in the rail, or `agile node move <id> --parent <id|project>`); moving to the project root detaches it. Refused: into its own subtree, across projects, while the parent's plan is awaiting approval. Roles are re-derived; both parents get a thread line; a moved work node keeps its branch and worktree. Merging conversations is out of scope. Amends §6's "never by hand".
- **D35** (2026-09-26, Pete): a part's question about shared things (a sibling, a contract, owned paths, the plan) goes to its coordinator first (`child_question` event, coordinator-only `answer_child` verb). The coordinator answers or passes it up; a stopped coordinator sends it to the inbox; plan approval supersedes held (not passed-up) questions. As built in T338.
- **D36** (2026-09-26, Pete): the T341 walkthrough decisions, as recommended. D1 "Waits on…" / "Tracker issue…" labels, tracker field only with a project tracker. D2 the open node and filter live in the URL. D3 a "question" state on Children cards. D4 coordinator wakes stay; ended sessions collapse in the list. D5 a direct merge's event is "merged". D6 the coordinator autonomy picker only on coordinating nodes and project roots. D7 "Merge" everywhere, not "Land". D8 deferred to real-agent QA (T342). D9 a ship-check hold is neutral, not error red. D10 accepting a decision wakes the conversation. D11 part titles aren't truncated by "waiting for the plan". D12 daemon lines meant for the agent are hidden from the human thread.
- **D37** (2026-09-26, Pete): upgrade Bun past 1.3.11 if a release fixes the child-process pipe bugs (fd double-close, EBADF on epoll_ctl); verified on a branch with the full suite and CI before the pin moves. Otherwise stay on 1.3.11 with the existing workarounds.
- **D38** (2026-09-26, Pete): no global `Host` check on the daemon's read routes. The cockpit must stay reachable from a phone through a tunnel (D15). Writes keep their same-origin check (403 otherwise); the folder browser and clone keep their loopback-`Host` check (T362). A Host allowlist (loopback plus configured tunnel names) stays an option if DNS rebinding ever matters more than reach.
- **D39** (2026-09-26, Pete; confirmed 2026-09-27): a browser notification fires every time a node finishes (or asks, or is blocked), including a second finish after your reply; the same card only leaving a frame and coming back does not notify again. As built in T391.
- **D40** (2026-09-26; confirmed by Pete 2026-09-27): in the D17 order a model belongs to its vendor. A model named at a step counts only when that step runs the resolved vendor (its own vendor, else the vendor of the steps below it). A repo set to Gemini no longer inherits the home's Claude model: it gets Gemini's own default. Vendor and effort still resolve field by field. As built in T402.
- **D41** (2026-09-26, Pete): a node created without a title gets one from a one-shot cheap LLM call (Haiku) through the user's own `claude` login, off the create path; the first-line title stands until it returns, and stays if the CLI is missing or the call fails. The daemon still holds no vendor credentials. As built in T414.
- **D42** (2026-09-26, Pete): a conversation can be asked at any level (the Director, a project root, a coordinator, a work node) as its own node, and never reshapes the tree: a node's parts are its live children that are neither helpers nor conversations, and only parts make a node coordinating, wait for a plan or ask a coordinator first. A side conversation's status doesn't wake its parent; its conclusion goes up when the human sends it. It can grow into work in place. Widens D33 (design/projects-design.md §2). Built in T418–T422: the rule, Ask from anywhere, the parent's state in its brief, Send to parent, Turn into work.
- **D43** (2026-09-26; confirmed by Pete 2026-09-27 as the end state once T456's retry and fallback are spent): a vendor process that exits non-zero on its own (not a stop of the daemon's, not after its turn finished) crashed or refused (a login, a bad model): the node is `blocked`, its session `error`, and the thread line carries the vendor's last stderr line. Narrows cockpit-design §2.3's "exit ⇒ done", which let a first run with a logged-out vendor read as finished work ("Ready to merge", "Replied"). A clean exit (code 0) is still `done`. A vendor whose command isn't on the daemon's PATH is named before anything spawns. Built in T432.
- **D44** (2026-09-27, Pete): Q25 answered. Accepting a knowledge item wakes only the conversation that proposed it (the item's `source.node`); every other conversation in scope gets it with its next message, and coordinators still wake as before. Narrows D36 D10; the per-item fan-out cap goes. Built in T453. Follow-up T454: behind a config setting, Jev decides whether an accepted item merits waking a conversation (does it change the answer given or settle something left open, and is the conversation still current).
- **D45** (2026-09-27, Pete): an agent reads every registered repo it can see (every repo not private, plus private ones listing its project), not only its project's; the project's own repos are the ones it is pointed at. Agents may propose adding a repo to their node (T455).
- **D46** (2026-09-28, Pete): one way to choose a model, for every vendor (Claude included). The model list comes from the vendor (ACP's reply when a session opens), and the chosen model is set through that same ACP model option. A vendor-specific switch (Claude's `ANTHROPIC_MODEL`, a CLI flag) is a fallback only where a live run has measured that the ACP option is missing. A vendor with no way to set a model shows "default" in the picker, with the reason. Measured first (LIVE-CHECKLIST §12). (T467)
- **D47** (2026-09-28, Pete): T471's Delete forever keeps a branch with unmerged commits unless the operator ticks "Also delete its branch"; a merged branch always goes. As built.
- **D48** (2026-09-28, Pete): go ahead with T465. A finished turn no longer stops the vendor session: it stays alive and idle, so the next message reaches the same session and keeps its context and prompt cache. It ends on an idle timeout, a Stop or the daemon stopping, and an ended session resumes through ACP `session/load` where the vendor supports it. Narrows cockpit-design §2.3's "a finished turn stops the session".
- **D49** (2026-09-29, Pete): one install per vendor. The daemon runs the vendor CLI the operator installed, not a second copy bundled inside an ACP bridge: Claude's bridge gets `CLAUDE_CODE_EXECUTABLE`, Codex's gets `CODEX_PATH`, pointing at the `claude`/`codex` on PATH, with the bundled copy only as the fallback when none is installed. Gemini, Cursor, Grok and Pi already run the installed CLI. The bridges stay pinned in code. (T480)
- **D50** (2026-09-29, Pete): harness updates are a setting with three modes. **Off** does no version check. **Alert** checks regularly and puts an update in Needs me, with a button that installs it. **Auto** installs new versions in the background. Running sessions keep the version they started on; the next start uses the new one. (T481)
- **D51** (2026-09-30, Pete, MR1): a model-routing budget is counted in **weighted tokens** (tokens × the model profile's relative cost), per session and per node, and built only after LIVE-CHECKLIST §16 measures which vendors report usage. (T485)
- **D52** (2026-09-30, Pete, MR2): the chooser is **Jev**, using TypeSafe's choice primitive: one call scores the five criteria, reads the topic, and picks the model and effort from the preset models, with a confidence. Below 0.5 confidence, or with no key or a failed call, the rule fallback decides and the chat says why. No Haiku step in between: Pete confirmed the fixed rule is the fallback. (T483)
- **D53** (2026-09-30, Pete, MR3): the operator's explicit pick always wins; the lock binds agents, the chooser and escalation. The set is called **preset models**, and a pick outside it reads "Running <model>, as you picked", never as refused. (T482)
- **D54** (2026-09-30, Pete, MR4): new projects default to `choose`, quality 50, `start cheap`, presets = favourites, no pinned rules, and that default is a setting (Settings → Agents → Model choice). Projects that existed before T482 are stamped `default` once and change only when the operator changes them. (T482)
- **D55** (2026-09-30, Pete, MR5): a routed pick is made once, when the node's agent first starts, and again only on escalation or "Let the policy choose again"; never silently on a later wake (T464 stands). (T482, T483)
- **D56** (2026-09-30, Pete, MR6): an agent may ask to step up with `escalate {why}`; it can never pick its own model. (T484)
- **D57** (2026-09-30, Pete): Choose asks Jev for a **tier** (fast, balanced, strongest), not a model; the model is then the preset in that tier chosen by the vendor order (D59), then cost. Replaces T483's model question, whose confidence split between near-equivalent models of different vendors. (T490)
- **D58** (2026-09-30, Pete): the daemon checks each vendor itself (the **vendor self-check**): a session with no node, a model and effort set and read back, one tiny prompt, a resume, and the usage fields it reports, kept per vendor and CLI version. It runs on demand and after a CLI update, and routing uses it. It replaces the live checks that measure vendors (LIVE-CHECKLIST §12's last column, §12.2, §14, §16). (T489)
- **D59** (2026-09-30, Pete): the operator sets a **vendor order** for ties ("Anthropic, then OpenAI"), and may set it per role (reviews prefer Codex, code prefers Claude). (T490)
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

### Ticket: T213 Pete's Phase 7 look: reads, parts start, stop wording
- **Priority:** P0
- **Status:** Done (merge 4ba62e0)
- **Owner:** —
- **Scope:** From Pete's live run of the T212 script (2026-09-24, step 3). (1) The hook's role policy denies reads outside the session's own worktree, so the coordinator of "Balance summary" could not `ls` its ledger-lite part's worktree. projects-design §4.4 and P20 say any agent may read any registered repo (and its worktrees) subject to private visibility; writes stay limited to the node's own worktree (a coordinator or conversation session: its scratch dir). Fix the read side for Bash and the built-in read tools, for every role, keeping T229's visibility check and the write limits. (2) Parts created by + Repo (§7 reshapes, T205) are never started, so after a work → coordinating split nobody works on the code. A new part starts its worker like any new work node (T204), unless the operator created the node with `--no-start`; a moved part whose worker was live restarts in its worktree. (3) A session the daemon stops on purpose (reshape, detach, restart) shows "process exited (code -1)" on the thread, which reads as a crash. Say what stopped it ("stopped: node reshaped into parts").
- **Acceptance Criteria:** Hook tests: a coordinator and a worker may read a sibling part's worktree and another public repo; a Blog node still cannot read a private repo listed for Shop; writes outside the own worktree/scratch dir are still denied. Fake-agent test: conversation → + repo → + repo leaves both parts with a running worker and the coordinator running. The thread line for a deliberate stop names the reason.
- **Validation Steps:** `bun test packages/daemon/src/hook packages/daemon/src/permissions packages/daemon/src/streams packages/daemon/src/attach`; `bun run test:integration`.
- **Notes:** Fixed on `claude/phase-7` and merged forward into phase-8 and phase-9 (D30). Review (sonnet): 1 blocking fixed — built-in Read/Grep/Glob/LS are now an allow-list (own dir, readable repos; the agile home, private repos and everything else denied), shared with Bash reads; `rg --pre` no longer read-only. The -1 exits were the daemon's own reshape stops. Also fixed a T205 bug (moved part kept a stale running session). Parts start after a reshape unless the node never had a worker. Daemon shutdown status unchanged. Daemon +175.

### Ticket: T214 A repo with no commits is refused up front
- **Priority:** P1
- **Status:** Done (merge bb13e6d)
- **Owner:** —
- **Scope:** From Pete's Phase 8 live run (2026-09-24): `node new --repo agile-test-repo` on a repo with no commits created the node, but the agent never started; the thread got only a raw `git rev-parse --verify HEAD^{commit} failed … Needed a single revision` and the node sat idle with no hint. Refuse up front, before anything is written: `node new`/`add-repo`/attach on a repo whose main branch has no commit fail with one line ("<repo> has no commits on <branch>; make an initial commit first"). `agile repo add` on such a repo succeeds but prints the same warning.
- **Acceptance Criteria:** CLI e2e: `repo add` on an empty repo warns; `node new --repo` on it is refused with the message and creates no node; after one commit it starts.
- **Validation Steps:** `bun test packages/daemon/src/attach packages/daemon/src/streams packages/cli`.
- **Notes:** Fixed on `claude/phase-7`, merged forward. Review (sonnet) PASS. Daemon +38. Test fixtures that `git init` a repo for nodes now make an empty commit.

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
- **Status:** Done (merge 690423b)
- **Owner:** —
- **Scope:**
  - Poll the open PRs of live nodes (60 s; 15 s when flagged; backoff; ETag; rate-limit pause with a thread note) and map them to `PullRequestState`.
  - The node shows review requested, changes requested, CI failing, approved, merged or closed. Merged → `human.status: landed`. Closed unmerged → a question for you.
  - Detect main moving on `pr` repos with `ls-remote`.
  - In this phase, changes appear as thread lines and audit events only. Routed events come in T244.
- **Acceptance Criteria:** Against the fake with a fake clock: each transition shows on the node. 304s don't rewrite the record. A 403 pauses polling.
- **Validation Steps:** `bun test packages/daemon/src/github packages/daemon/src/delivery`.
- **Notes:** After T224. From T224 review: add a `push_failed` held reason (DeliveryStateSchema) and use it for push failures; refuse or handle re-delivery once the PR is merged/closed (today `createPull` would 422). From T226: call `mainSync.mainMoved(repo)` when a PR merges and when `ls-remote` sees main move on `pr` repos. Review (sonnet) PASS. Daemon +491. Six conditional GETs per PR per poll (304s are free). "Review requested" inferred (port has no requested_reviewers). Local main is fast-forwarded with `merge --ff-only` only when clean; a dirty checked-out main is skipped with a note. `push_failed` held reason added. Re-deliver after merge refused; after close opens a new PR.

### Ticket: T226 Sync after merge
- **Priority:** P0
- **Status:** Done (merge 36416f7)
- **Owner:** —
- **Scope:** Add `daemon/sync`. After any merge into a repo's main (a direct merge, a PR merged, or main moving outside the app), merge main into every other live work node's branch on that repo (P15):
  - deferred while the session is mid-turn or the worktree is dirty;
  - on a conflict: abort, set the node to `conflict` with the files, and the existing Resolve applies;
  - pushed branches are pushed again after a clean sync.
- **Acceptance Criteria:** Unit: two nodes on one repo; merging one syncs the other; a conflicting pair is flagged with its files; a mid-turn node syncs at the end of the turn.
- **Validation Steps:** `bun test packages/daemon/src/sync`; `bun run test:integration`.
- **Notes:** After T223; the PR half needs T225. Direct half first; the PR half (main moving on `pr` repos) wires in after T225. Review (sonnet) PASS; follow-ups done (first sweep after start reconciles every repo; sync conflicts say "Merging main into …"). Daemon ≈+260. Deferred set is in memory (restart is covered by the reconcile). Sweep interval shares `overlapRecomputeMs`. PR half: T225 calls `mainSync.mainMoved`.

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
- **Status:** Done (merge 2abed49)
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
- **Notes:** After T225 and T226. Review (sonnet) PASS; plain direct delivery traced unregressed after `land()` restructure. Daemon +372. A direct node held on waits-on needs a second Merge click once satisfied; cross-repo merge-together is per-repo atomic only; `settle()` runs after each poller tick. Link button has no Playwright test.

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

### Ticket: T231 PR delivery pushes with the operator's git credentials
- **Priority:** P0
- **Status:** Done (merge 68e4cc4)
- **Owner:** —
- **Scope:** From Pete's Phase 8 live run (2026-09-24, macOS): `agile deliver` on a `pr` repo failed at the push with `fatal: could not read Username for 'https://github.com': Device not configured` and the node went `held`. Cause (confirmed by Pete's agent): `delivery/git.ts` runs every git command with `sandboxedSubprocessEnv`, which sets `HOME=<repo>/.agile-daemon-cache/git/home`, so the osxkeychain helper (and any `gh auth setup-git` helper or `~/.gitconfig` credential/`insteadOf` setting) is lost. (1) Network git operations — the delivery push, `sync/main-sync.ts` push/fetch, the poller's `ls-remote`/fetch/fast-forward — run with the operator's real credential setup (real HOME or an equivalent pass-through); plumbing and merge commands stay sandboxed. No token in the daemon. (2) Every daemon git call sets `GIT_TERMINAL_PROMPT=0`, and a credential failure reads as one clear line naming what to set up (`gh auth setup-git` or a credential helper). (3) A deliver with nothing to land records a visible state (the Delivery panel and `node show` say "nothing to deliver: no commits beyond <main>"), not a null `delivery_state`.
- **Acceptance Criteria:** A regression test that fails on the old code: a credential helper configured only in the real HOME's gitconfig serves a push/fetch against a local HTTP or file remote that requires it (or an env-assertion test on push/fetch/ls-remote). A missing credential fails fast with the clear line. Nothing-to-land state tested in delivery and shown in the cockpit.
- **Validation Steps:** `bun test packages/daemon/src/delivery packages/daemon/src/sync packages/daemon/src/github`; `bun run test:integration`; `bun run test:e2e`.
- **Notes:** Pete's nodes A and B on agile-test-repo are ready to deliver once this lands. Review (sonnet): 1 blocking fixed — network git gets an allow-listed env (real HOME, PATH, SSH/GIT/locale/proxy/gh vars; daemon secrets such as TYPESAFE_API_KEY and AGILE_* dropped; GIT_AUTHOR/COMMITTER dropped), tested by env-name dump. `GIT_TERMINAL_PROMPT=0` on every daemon git call; credential failures say to run `gh auth setup-git`. `nothing_to_deliver` held reason shown in node show and the Delivery panel. Daemon ≈+110. Open: main-sync pushes to a hard-coded `origin`; the operator's pre-push hooks now run on delivery pushes.

### Ticket: T230 Phase 8 QA and Pete's look
- **Priority:** P0
- **Status:** In Review (QA ACCEPT 2026-09-24; Pete's look pending)
- **Owner:** Pete
- **Scope:** Black-box QA against the fake GitHub and the fake agent: direct delivery, PR delivery, the poller transitions, sync, overlaps, holds, auto-merge, visibility, and the migration of the Phase 7 home. Daemon line count. Pete then runs one direct delivery on ledger-lite and one PR on agile-test-repo.
- **Acceptance Criteria:** QA ACCEPT. Live: the ledger-lite node merges with one click. The agile-test-repo node opens a real PR whose state shows on the node. After Pete merges on GitHub, the node shows merged and the other live node on the repo is synced.
- **Validation Steps:** Pete, on his Mac. agile-test-repo needs at least one commit on `main`, pushed to GitHub. Pick a ledger-lite goal that is not already done (the Phase 7 run may have landed earlier ones).

```zsh
export AGILE_HOME=~/.agile-phase7
agile daemon start
gh auth status
agile repo set agile-test-repo --delivery pr --auto-merge off
agile repo set ledger-lite --delivery direct
SHOP=$(agile project list --json | jq -r '.[] | select(.name=="Shop") | .id')
A=$(agile node new --project $SHOP --title "Test repo note" --goal "Add one line to README.md saying the repo is used for agile-agents live checks; commit it" --repo agile-test-repo --json | jq -r .id)
B=$(agile node new --project $SHOP --title "Test repo second note" --goal "Add a file NOTES.md with one line; commit it" --repo agile-test-repo --json | jq -r .id)
L=$(agile node new --project $SHOP --title "Ledger unknown flag" --goal "When the CLI gets an unknown flag, print unknown option: <flag> on stderr and exit 2; add a test" --repo ledger-lite --json | jq -r .id)
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

- **Notes:** D10. Close the test PRs and branches on agile-test-repo afterwards if you don't want them kept. QA (sonnet, black-box) ACCEPT on 666e893: bun test 1947/0, integration + e2e green; T230 script ran against the fake GitHub with scratch paths and `--no-start`. Minor findings: (1) no supported way to point a real daemon at a fake GitHub except `github.gh_command` = a stub echoing a token; (2) `--delivery pr` requires a github.com remote host (a `pushInsteadOf` rewrite works for testing); (3) usage omitted `rules --stage` values — fixed cbaba52; (4) the visibility deny is covered by unit tests only (a live session is needed to drive `agile hook`). Daemon 22,233 lines (19,360 at Phase 7).

### Phase 9 — Events

### Ticket: T240 Routed event schema and store
- **Priority:** P0
- **Status:** Done (merge c6575ea)
- **Owner:** —
- **Scope:**
  - Add `RoutedEvent` and `Delivery` (§14.9) in `shared/routed-event.ts`, with typed payloads per event type (§15).
  - Add `events/log.jsonl` and `events/queue/<node>.jsonl` through the store, fsynced before `emit` returns.
  - A corrupt line is refused with path and line.
  - The audit log is unchanged (P9).
- **Acceptance Criteria:** Store tests: emit then a crash (simulated) then a restart shows the delivery still `pending`; payloads over the cap are refused.
- **Validation Steps:** `bun test packages/shared packages/daemon/src/events`.
- **Notes:** First ticket of Phase 9. Review (sonnet) PASS. Daemon +212. `RoutedEventService` (emit, pendingFor, mark, get, recover). Payload fields read from §15 templates; 800-char strings, 4096-byte payload cap (worker's number). `recover()` not yet called at start → T242.

### Ticket: T241 Router
- **Priority:** P0
- **Status:** Done (merge e6e772f)
- **Owner:** —
- **Scope:** `events/router.ts`: routes to self, ancestors, waits-on, same-repo (live work nodes, any project), parties and sibling (§15), with the reason recorded in `routing`. Coalesce keys. A closed node gets `expired`.
- **Acceptance Criteria:** Table tests over the worked example tree: Blog's merge reaches its parent (`ancestor`) and Shop's api part (`same_repo`), and nothing on web.
- **Validation Steps:** `bun test packages/daemon/src/events`.
- **Notes:** After T240. Review (sonnet) PASS. Daemon +195. `routeEvent` (pure) + `routeAndEmit`. §15 rows with no dedicated reason use `party`/`ancestor`. Coalesce supersede is not atomic across concurrent emits → T242 digests tolerate >1 pending per key.

### Ticket: T242 Delivery to sessions, digests, no drops
- **Priority:** P0
- **Status:** Done (merge 104ceb6)
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
- **Notes:** After T241. Removes the old prompt paths (line delta should be small). From T240/T241: call `recover()` at daemon start; digest folding must tolerate more than one pending event per coalesce key. Review (sonnet) PASS (no lost/duplicated lines across the checked cases). Daemon +283 net. Digest to the worker only; marked delivered only after the vendor accepts. Gate decisions still prompt directly. `recover()` does not notify delivery → T243 wakes nodes with pending events at start.

### Ticket: T243 Wake policy
- **Priority:** P1
- **Status:** Done (merge 86e1d3d)
- **Owner:** —
- **Scope:** Per P11:
  - which event types start a session for each role when none is live;
  - a wake budget per node per hour (config, default 20) that goes to the inbox when exceeded;
  - stopped nodes are never woken.
- **Acceptance Criteria:** Table tests per role and type; the budget test; a stopped node keeps its events pending.
- **Validation Steps:** `bun test packages/daemon/src/events`.
- **Notes:** After T242. From T242 review: at daemon start, nodes with pending deliveries (after `recover()`) should be considered for wake/delivery rather than waiting for the next turn end. Review (sonnet) PASS. Daemon +182. "Stopped" is derived: archived, closed/landed, or `agent.status: idle` (never started or detached); `done`/`blocked` nodes are wakeable. Budget (`events.wake_budget_per_hour`, default 20) is in memory and resets on restart; over budget → blocked inbox item, events stay pending. `wakePending()` at start goes through the same gate.

### Ticket: T244 Event producers
- **Priority:** P0
- **Status:** Done (merge a95ae22)
- **Owner:** —
- **Scope:** Emit the §15 types that exist so far: `human_line`, `answer`, `child_status`, `child_delivered`, `pr_review`, `ci_failed`, `pr_behind`, `pr_merged`, `pr_closed` (from T225), `main_changed` and `sync_conflict` (from T226), `overlap` (T227), `dependency_satisfied` (T228). Each has its one-line summary text as in §15. The `read_event` verb returns a payload.
- **Acceptance Criteria:** One test per producer asserting the type, routing and summary; `read_event` over MCP.
- **Validation Steps:** `bun test packages/daemon`; `bun run test:integration`.
- **Notes:** After T241. It may split into two workers (PR-related and the rest) if large. From T240 review: `pr_closed.login` and `child_status.progress` are optional in the schema but used by the summary templates — always supply or fall back. Keep payloads under the 4096-byte cap (trim file lists). Review (sonnet) PASS (edge-triggered, no double emission). Daemon +444. Record transitions via a `StreamService.update` onUpdated hook. `main_changed` carries one aggregate outcome per repo. Waiters get both `pr_merged` (T241 routes waits_on) and `dependency_satisfied`. `pr_closed.login` unknown (no closed_by); `pr_behind.files` empty.

### Ticket: T245 ∥ Activity feed per node
- **Priority:** P1
- **Status:** Done (merge e112bfd)
- **Owner:** —
- **Scope:** Add a node Activity tab: every event routed to the node with its reason, delivery status and which session or digest carried it ("what woke it and why"). Add `agile tail --node <id> --events`. The repo view shows repo events.
- **Acceptance Criteria:** e2e: a `main_changed` shows on the other node's Activity with "same repo".
- **Validation Steps:** `bun run test:e2e`.
- **Notes:** After T242. Review (sonnet) PASS. Daemon +84. Activity tab (live), repo events in the repo view (fetched on open, not live), `agile tail --node <id> --events [--follow] [--json]` (reads files directly like the existing tail).

### Ticket: T246 PR babysitting
- **Priority:** P0
- **Status:** Done (merge 1a2ea55)
- **Owner:** —
- **Scope:** The work node's agent looks after its PR (projects-design §4.1):
  - A babysit brief section, and wake on `pr_review`, `ci_failed` and `pr_behind`.
  - A CI log excerpt is written to `sessions/<id>/` with a pointer.
  - After the fix, the agent pushes through `deliver` (T224 update path).
  - Design disagreements go to the inbox with `ask`. A flaky test is reported, never skipped.
  - With auto-merge on, T228's enable runs after each green push.
- **Acceptance Criteria:** Fake GitHub + fake agent: a failing check wakes the agent and the scripted fix pushes; the check goes green; an approval with auto-merge on gets merged by the fake; the node shows merged with no human click.
- **Validation Steps:** `bun test packages/daemon/src/delivery packages/daemon/src/events`; `bun run test:integration`.
- **Notes:** After T243 and T244. Moved here from Phase 8 because it needs events (see the build order note). Review (sonnet) PASS. Daemon +139. New agent verb `deliver`: worker-only, only with an open PR, updates that PR (never opens one, never merges, protected branches refused), enforced server-side. CI log excerpt from check-run output → `sessions/<id>/ci-*.log` (200 lines / 32 KB). Auto-merge is enabled at first delivery (T228), not per green push; GitHub still merges only when green and approved.

### Ticket: T248 `agile tail --node --events` prints nothing
- **Priority:** P1
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** From T289 QA (Phase 11 branch): `agile tail --node <id> --events` (no `--follow`) printed nothing for a node that had events. It is the command Pete's T247 and T289 looks use. Find why (wrong file, a filter, routed events vs audit events, output buffering on exit) and fix; the command prints every routed event for the node with its reason and delivery status, and says so in one line when there are none.
- **Acceptance Criteria:** A CLI e2e against a real daemon: emit routed events for a node, `tail --node --events` lists them; a node with none prints a one-line "no events" message.
- **Validation Steps:** `bun test packages/cli`; `bun run test:integration`.
- **Notes:** Fix on `claude/phase-9`, merge forward.
- T248: QA had read the audit log, not the routed log; tail now says "no routed events"; sonnet review APPROVE; merge 2cf8415 into phase-9, forwarded to 10/11/12.


### Ticket: T247 Phase 9 QA and Pete's look
- **Priority:** P0
- **Status:** In Review (QA ACCEPT 2026-09-24; Pete's look pending)
- **Owner:** Pete
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

- **Notes:** If GitHub says auto-merge is not allowed on agile-test-repo, turn on "Allow auto-merge" in the repo settings first. P19 says the node shows `unavailable` otherwise. QA (sonnet, black-box) ACCEPT on 8dc9c19: bun test 2101 pass / 1 load-sensitive e2e fail (the T161 test; root-cause fix in progress on claude/phase-7), integration green. Routing, restart-without-loss and the full babysit loop verified by hand against the fake GitHub; digests, wake budget and `read_event` covered by the suites only (no user-reachable way to select the fake agent). Daemon 23,772 lines (22,233 at Phase 8). Pete's look waits on T213 (Phase 7 fixes) merging forward.

### Phase 10 — Knowledge

### Ticket: T260 Knowledge items replace rules
- **Priority:** P0
- **Status:** Done (merge e67f850)
- **Owner:** —
- **Scope:**
  - Add `KnowledgeItem` (§14.3) in `shared/knowledge.ts`, and `knowledge/` in the store.
  - Migrate `rules/` (§17.1 step 2, P6), keeping the ulids. Rename `daemon/rules` to `daemon/knowledge`.
  - Add `agile knowledge add|list|show|accept|retire|test|report`, with `rules` kept as an alias, and `--kind`, `--scope`, `--path` and `--name` (T175 item 3).
  - Built-ins become `standard` items with `action`.
  - Delete `seed-plan-v1.ts`.
- **Acceptance Criteria:** Migration test on a copied home with every enforcement and stage combination. The CLI shows the name on cards. The existing rules tests pass under the new names.
- **Validation Steps:** `bun test packages/shared packages/daemon/src/knowledge packages/cli`.
- **Notes:** First ticket of Phase 10. Review (sonnet): 2 blocking fixed (crash-safe P6 twin migration; propose_rule examples kept in `source.finding` for `tell` items). Daemon −165. `agile knowledge` (alias `rules`), RPC `knowledge.*` with `rule.*` aliases, `K-<ulid>` keeping rule ulids; the hook asks only `action` items. Still `/api/rules` and the Rules screen (T266 renames). CLAUDE.md still names `packages/daemon/src/rules` (needs Pete's OK to edit).

### Ticket: T261 Stacked scopes and paths
- **Priority:** P0
- **Status:** Done (merge de5d9ff)
- **Owner:** —
- **Scope:** One scope filter (global, repo, project, subtree, plus `paths`) used by the brief, the hook and ship. In the worked example, the web part gets global, web and Shop items and its parent's contracts, and nothing from Blog. Paths filter against the files being edited (action) or changed (ship); the brief lists path-limited items under their globs.
- **Acceptance Criteria:** Table tests from the worked example (§11 step 3).
- **Validation Steps:** `bun test packages/daemon/src/knowledge packages/daemon/src/hook`.
- **Notes:** After T260. Review (sonnet): 2 blocking fixed (typecheck; Bash calls skipped path-limited rules). Bash paths now extracted; unknown paths fail closed (path-limited action items are evaluated). Daemon +104 net.

### Ticket: T262 Ship checks: classifier and reviewer checklist
- **Priority:** P0
- **Status:** Done (merge 6f51557)
- **Owner:** —
- **Scope:** At delivery:
  - `ship` items run through the classifier over the diff (the old diff-rules code);
  - then a reviewer session with a checklist of every `review` item in scope, returning findings.

  Findings hold delivery and go back to the worker as a `ship_findings` event (added to §15). They go to you only when the check is unsure (route band) or the worker disputes them with `ask`.
- **Acceptance Criteria:** FakeClassifier + fake reviewer: a held delivery, a fix, a pass; a routed result reaches the inbox; the checklist appears in the reviewer's `brief.md`.
- **Validation Steps:** `bun test packages/daemon/src/delivery packages/daemon/src/knowledge`.
- **Notes:** After T261 and T244. The real key may be used for a manual check (D16). Review (sonnet) PASS. Daemon +291. `ship_findings` event (self, wakes work nodes). Reviewer session only when review items match changed paths; unsure → inbox gate. Follow-ups: a failed re-deliver after the reviewer finishes is only logged (node stays held until re-landed); review-result cache is unbounded; reviewer brief still says "no gate waits on you". Real-key manual check not done.

### Ticket: T263 ∥ Lookup tool and briefs
- **Priority:** P1
- **Status:** Done (merge bc458de)
- **Owner:** —
- **Scope:** Add a `lookup_knowledge(path)` verb (MCP) that returns the accepted items in scope for that path. Briefs include everything in scope and tell the agent to use the lookup before touching unfamiliar areas.
- **Acceptance Criteria:** A verb test over MCP; a brief snapshot test.
- **Validation Steps:** `bun test packages/daemon/src/runner packages/cli`.
- **Notes:** After T261. Review (sonnet) PASS; path normalization added after review (absolute/`./`/`..`; outside the worktree refused). Daemon +61.

### Ticket: T264 Proposals, lessons kinds and `knowledge_accepted`
- **Priority:** P1
- **Status:** Done (merge da3be9f)
- **Owner:** —
- **Scope:**
  - `propose_knowledge` replaces `propose_rule`. The agent picks the kind; the scope defaults to the node's subtree.
  - Lessons propose items with a kind (projects-design §17, lessons row).
  - Accepting an item emits `knowledge_accepted` to every live node in scope.
  - Items that never fire are flagged in the report (unchanged logic, re-keyed).
- **Acceptance Criteria:** Tests: accepting a Shop decision reaches Shop's live nodes and not Blog's; lessons after `merged` propose with a kind.
- **Validation Steps:** `bun test packages/daemon/src/knowledge packages/daemon/src/lessons packages/daemon/src/events`.
- **Notes:** After T244 and T260. Review (sonnet): 1 blocking fixed — the lessons retro now runs only after `merged` (direct land, markLanded, PR poller `onMerged`), at most once per node; a plain close no longer starts it. `propose_rule` replaced by `propose_knowledge` (no alias). `knowledge_accepted` goes to every live node in scope as `parties`.

### Ticket: T265 ∥ Per-repo norms in the repo view
- **Priority:** P2
- **Status:** Done (merge 6e37da9)
- **Owner:** —
- **Scope:** The repo view (T209) lists the accepted standards and architecture for that repo, with enforcement and stats.
- **Acceptance Criteria:** e2e: an accepted api standard shows under api.
- **Validation Steps:** `bun run test:e2e`.
- **Notes:** After T260. Review (sonnet) PASS. Daemon +11. `GET /api/repos/:name/knowledge` (accepted, repo-scoped, no decisions).

### Ticket: T266 Knowledge screen
- **Priority:** P1
- **Status:** Done (merge a708c01)
- **Owner:** —
- **Scope:** The Rules screen becomes Knowledge:
  - filter by kind, scope and enforcement; edit text, paths, enforcement and check;
  - bulk accept and retire; Test examples (unchanged);
  - the "never fires" flag.

  Inbox cards say "standard/architecture/decision proposed".
- **Acceptance Criteria:** e2e: accept a proposed decision and see it on a node's Knowledge-in-scope tab.
- **Validation Steps:** `bun run test:e2e`.
- **Notes:** After T260. Pete looks at it. Review (sonnet) PASS. Daemon +1. Screen and tab say Knowledge; kind/enforcement filters; paths editable; inbox cards "<kind> proposed" (new optional `knowledge_kind` on rule_accept items). Internal ids (`rules` view, `rules-*` testids, `/api/rules`) unchanged. "Never fires" flag predates this ticket.

### Ticket: T268 Ship-check classifier false hold; Phase 10 wording
- **Priority:** P1
- **Status:** Done (merge b250331)
- **Owner:** —
- **Scope:** From T267 QA with the real TypeSafe key: the `tests-with-changes` ship item (Pete's T267 script) kept holding delivery after the worker added a real test (3 retries, deny 0.80–0.86), though `agile knowledge test` passed on the item's examples. Find out what the classifier is actually sent at ship time (the whole diff? truncated? file list?) and why it disagrees with the examples; fix the request (e.g. give it the changed-file list plus a bounded diff, and phrase the call the way the examples are phrased) so the T267 flow holds, then passes after a test is added. Check with the real key (D16; never print it). Also: the hold message still says "landing refused by diff rule"; `brief.md`'s heading still says "Rules in scope". Use knowledge wording.
- **Acceptance Criteria:** Unit tests (FakeClassifier) pin the request shape. A recorded manual run with the real key: the T267 hold, then a pass after a test is added. Wording updated.
- **Validation Steps:** `bun test packages/daemon/src/delivery packages/daemon/src/classifier packages/daemon/src/runner`.
- **Notes:** Before Pete's Phase 10 look. Review (sonnet): code PASS; its one blocker was this record. Cause: an over-budget diff is split per file (§8.2/D14) and the src part never saw the added test (real key: 0.77/0.73). Every ship call now carries the full changed-file list (cap 200) before the diff; default question "Does this change violate: …?". Manual run with the real key (key never printed), T267 flow on a scratch ledger-lite: no test → held (0.81); test added → merged. Split parts now 0.44–0.53 (routed, not denied). Open for Pete: the no-test hold sits just above the 0.8 band; per-file splitting is weaker than one whole-diff call (changing it changes §8.2/D14). Wording: "delivery held by ship check <name>", brief heading "Knowledge in scope". Daemon +38.

### Ticket: T267 Phase 10 QA and Pete's look
- **Priority:** P0
- **Status:** In Review (QA ACCEPT 2026-09-24; Pete's look pending)
- **Owner:** Pete
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

- **Notes:** The goal's "do not write a test" wording is deliberate, so the hold fires. QA (sonnet, black-box) ACCEPT on 0ae4dde: bun test 2183/0, integration and e2e green; migration of every enforcement × stage, scopes, `knowledge_accepted`, Knowledge screen verified by hand. With the real classifier key the ship item still held after a real test was added (3 retries, deny 0.80–0.86) while `knowledge test` agreed with its examples → T268. Daemon 24,729 lines (23,772 at Phase 9).

### Phase 11 — Coordination

### Ticket: T280 Coordinator role
- **Priority:** P0
- **Status:** Done (merge 9780ade)
- **Owner:** —
- **Scope:**
  - Add a `coordinator` session role for coordinating nodes and project roots (P20): no worktree, the scratch cwd, read access under visibility, writes denied by the hook.
  - The coordinator brief: children, their cards (once T283 exists), knowledge in scope, the autonomy level.
  - The coordinator is woken by any event routed to it (T243).
- **Acceptance Criteria:** A fake-agent test: `child_status` wakes the coordinator with a digest. A hook test: a coordinator write is denied.
- **Validation Steps:** `bun test packages/daemon/src/runner packages/daemon/src/events packages/daemon/src/hook`.
- **Notes:** First ticket of Phase 11. Review (sonnet): 2 blocking fixed (writes allowed only inside the scratch session dir per P20, own coordinator policy on hook + ACP + Grok fs; project roots that had a coordinator wake). Adversarial re-review of the policy PASS (symlinks, `..`, cd, sh -c, cp/mv/ln, find -fprint). Daemon +80. Open: a root whose children all closed attaches as a worker again; Cursor has no hook so edits aren't gated for it.

### Ticket: T281 Plans and contracts
- **Priority:** P0
- **Status:** Done (merge af549a2)
- **Owner:** —
- **Scope:**
  - Add `Plan` and `Contract` records (§14.4), with the verbs `plan_write` and `contract_write` for coordinators.
  - A plan starts as `draft`. Approval is an inbox card at every level, because the plan decides what gets built.
  - Children get their owned paths and the contracts they rely on in their brief.
  - Add a Plan tab on the stream page.
  - `plan_changed` and `contract_changed` events.
- **Acceptance Criteria:** Tests: approving the plan gives both children the contract in their brief; bumping a contract notifies its parties only.
- **Validation Steps:** `bun test packages/daemon/src/coordination`; `bun run test:e2e`.
- **Notes:** After T280. Review (sonnet): 1 blocking fixed — children keep the last approved plan (an `approved` snapshot) while a revision is draft; the card and Plan tab show the change against it. Approval is human-only (cockpit/HTTP; no CLI/RPC yet). `contract_write` is not yet autonomy-gated (T282/T285). Daemon +588.

### Ticket: T282 Autonomy levels for coordinators
- **Priority:** P0
- **Status:** Done (merge 6b4bbdc)
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
- **Notes:** After T281. The Director reuses this function (T301). Review (sonnet): 2 blocking fixed (every contract change incl. parties goes through the gate; Apply re-checks and refuses stale proposals). Daemon +502. New home dir `proposals/<AP-id>.yaml` (follows plans/, contracts/, cards/; not in the design's home layout — Pete to confirm). Verbs add_child (idle), add_waits_on, set_owner; reorder/merge_siblings gated but no verb; proposals apply/dismiss only in the cockpit.

### Ticket: T283 ∥ Status cards
- **Priority:** P1
- **Status:** Done (merge d3116fb)
- **Owner:** —
- **Scope:** Add `cards/<node>.yaml` (§14.5). The daemon updates `files`, `state` and `relies_on`; the `progress` verb updates `doing`. The `read_card(node)` verb is limited to siblings, ancestors and the Director. Cards show on the parent's page.
- **Acceptance Criteria:** A card follows edits within one recompute; a sibling can read it; a node in another project can't.
- **Validation Steps:** `bun test packages/daemon/src/coordination`.
- **Notes:** After T280 and T227. Review (sonnet) PASS. Daemon ≈+210. read_card: siblings, ancestors, descendants (the parent coordinator), Director hook; the coordinator brief lists child cards. A corrupt card is refused with path:line and isolated in the frame. relies_on = contracts the node is party to, refreshed on the node's next update (not on contract write).

### Ticket: T284 Import index and sibling alerts
- **Priority:** P1
- **Status:** Done (merge 3e6e72c)
- **Owner:** —
- **Scope:** Build `index/<repo>.json` for TS/JS only (P14) and keep `exports_changed` on cards. Alerts:
  - the same file edited by siblings → `overlap` to both plus the parent;
  - a changed export used by a sibling → `symbol_changed`;
  - a contract's paths touched → the parent and its parties.
- **Acceptance Criteria:** A fixture repo: changing the export `salePrice` in `prices.ts` alerts the sibling that imports it, and nobody else.
- **Validation Steps:** `bun test packages/daemon/src/sync packages/daemon/src/coordination`.
- **Notes:** After T283. Review (sonnet) PASS. Daemon +401. Regex scanner (P14), no dependency; index cached by main sha. A sibling "uses" a symbol only via files it changed (imports already on main are shared by all siblings and would alert everyone) — false negatives accepted. Not built: the contract-paths alert — §14.4 `Contract` has no paths; needs Pete: add `Contract.paths`, or derive from the plan owner's globs. Same-file overlap was already delivered by T227/T244.

### Ticket: T285 Contract proposals
- **Priority:** P1
- **Status:** Done (merge 8677401)
- **Owner:** —
- **Scope:** The `propose_contract` verb (from one child, or co-signed by siblings) adds a `contract_proposal` to the parent. The coordinator approves it (at Run, when it is routine), rejects it with a reason, or asks you (an inbox card). Approval bumps the version and notifies the parties.
- **Acceptance Criteria:** The worked-example test: api proposes `saleEndsAt`, the coordinator approves at Run, and web gets `contract_changed`. At Organise the same proposal goes to the inbox.
- **Validation Steps:** `bun test packages/daemon/src/coordination`.
- **Notes:** After T282. Review (sonnet) PASS. Daemon +201. `propose_contract` (child's `routine` is only a claim) and `decide_contract` (coordinator of the contract's node; its own `routine` drives the gate). Gap → T286: a rejected proposal only writes thread lines, no routed event to the proposer; co-signers unverified.

### Ticket: T286 ∥ Ask sibling
- **Priority:** P2
- **Status:** Done (merge 34befbd)
- **Owner:** —
- **Scope:** The `ask_sibling(node, question)` and `reply_sibling` verbs. The exchange is written to both threads, and the parent gets a copy. A joint proposal is `propose_contract` with both signatures. The brief states the line between details and plan changes.
- **Acceptance Criteria:** The fake-agent currency example from §9.5 end to end.
- **Validation Steps:** `bun test packages/daemon/src/coordination packages/daemon/src/events`.
- **Notes:** After T285. From T285 review: tell the proposer (routed event) when its contract proposal is rejected or approved; co-signers must actually agree (via ask/reply) before a joint proposal is filed. Review (sonnet): 1 blocking fixed — co-sign needs `reply_sibling` `agree: {contract, body}` to the proposer's latest ask, matching this contract and body (sha256). Decision notices say "by the operator" or "by your coordinator". Daemon +229. Full bun test after merge: 2235/0.

### Ticket: T287 Sibling finished and collisions go to the parent
- **Priority:** P1
- **Status:** Done (merge 98672b7)
- **Owner:** —
- **Scope:**
  - When a child merges, the parent is woken first, and its `note_child` verb sends targeted notes. Same-repo siblings still get the sync.
  - An overlap or collision wakes the parent with options: add `waits_on`, give ownership, or merge the siblings. The action is gated by T282.
- **Acceptance Criteria:** Fake-agent test: an overlap reaches the parent; at Organise the scripted `add_waits_on` is applied and you are told.
- **Validation Steps:** `bun test packages/daemon/src/coordination`.
- **Notes:** After T284. Review (sonnet) PASS. Daemon +26. `note_child` → `coordinator_note` to that child only. Overlap summary lists the parent's options. Question for Pete: `coordinator_note` doesn't wake a finished work node under P11, so a note to a done child may never be read.

### Ticket: T290 A coordinator note wakes an ended work node
- **Priority:** P1
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** Pete (2026-09-24): a parent's `coordinator_note` must reach its children, so it wakes a work node whose session has ended (added to P11's work wake types). Nodes the human stopped, landed or closed still never wake; the per-node wake budget still applies.
- **Acceptance Criteria:** Wake-policy and delivery tests: a note to an ended work node starts a session; a landed one stays pending.
- **Validation Steps:** `bun test packages/daemon/src/events`.
- **Notes:** Answers T287's question.
- T290: coordinator_note added to the work wake types; wake + delivery tests; full bun test 2243/0. One-line change reviewed by the manager. merge 3832ebb.


### Ticket: T291 Coordinators are denied WebFetch/WebSearch
- **Priority:** P1
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** P20: a coordinator has no network. Claude's WebFetch/WebSearch have no ACP kind, so the role table never saw them; `roleToolVerdict` (hook/decide.ts) now denies them for the coordinator permission role. Engineers and reviewers unchanged.
- **Acceptance Criteria:** Hook tests: coordinator denied both; worker allowed both.
- **Validation Steps:** `bun test packages/daemon/src/hook`.
- **Notes:** Found in T300 review. Full bun test 2245/0. Manager reviewed the diff (small). merge 7d767ec. Open: other network-capable tools (e.g. MCP servers) are not covered by name.

### Ticket: T288 ∥ Helper children on the same repo
- **Priority:** P2
- **Status:** Done (merge 63cdedc)
- **Owner:** —
- **Scope:**
  - `node new --helper-of <work node>` creates a same-repo child that branches off the work node's branch and delivers back into it (a direct merge into that branch). The parent stays a work node (P1).
  - A helper on another repo triggers the §7 reshape instead.
  - This supersedes the unfiled "side-quest" proposal.
- **Acceptance Criteria:** A test: the helper merges into its parent's branch; the parent delivers one PR containing both.
- **Validation Steps:** `bun test packages/daemon/src/delivery packages/daemon/src/streams`.
- **Notes:** After T205 and T223. Review (sonnet): 2 blocking fixed (parent PR carrying both changes tested against the fake GitHub; a bad helper target is refused, never main). MainSync skips helpers. A helper's land waits (held, `waits_on`) while the parent is mid-turn or dirty; no automatic retry at the parent's turn end. Daemon +84.

### Ticket: T289 Phase 11 QA and Pete's look
- **Priority:** P0
- **Status:** In Review (QA ACCEPT 2026-09-24; Pete's look pending)
- **Owner:** Pete
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

- **Notes:** — QA (sonnet, black-box) ACCEPT on 556a2b5: bun test 2235/0, integration and e2e (36) green. Driven by hand: autonomy settings, the split into a coordinating node, a real coordinator session and its brief, helpers (cross-repo refused). Agent-side verbs (plans, contracts, proposals, cards, helper merge) covered by the suites only. Minor: `agile tail --node <id> --events` printed nothing for a node with events → T248 (Phase 9). Daemon 27,255 lines (24,729 at Phase 10).

### Phase 12 — The Director

### Ticket: T300 Director record, thread and page
- **Priority:** P0
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** Add `director.yaml` and `threads/director.jsonl` (P16). A Director session (the coordinator mechanics, no worktree) is woken by `director_request`. There is a Director page in the cockpit (thread plus activity) plus `agile director say` and `agile tail --director`. Every Director action is recorded with principal `director`.
- **Acceptance Criteria:** A fake-agent test: a human line reaches the Director and its reply lands on its thread. e2e: the page exists.
- **Validation Steps:** `bun test packages/daemon/src/director`; `bun run test:e2e`.
- **Notes:** First ticket of Phase 12.
- T300: sonnet review BLOCKING (hook denied every Director tool call: streamless record unresolvable) → fixed (hook places a streamless coordinator record by its scratch cwd; coordinator role table; WebFetch/WebSearch and operator-bound calls denied) → APPROVE. Director reuses role coordinator. merge ba5bb1a into phase-12. Open: no Director wake budget yet (T302/T303).


### Ticket: T301 Director tools and guards
- **Priority:** P0
- **Status:** Done
- **Owner:** Unassigned
- **Scope:**
  - Verbs: `draft_tree`, which returns a draft that renders as a tree with a Create button at Advise; `create_project`, `create_node`, `start_node`, `add_waits_on` and `restart_node`, gated by T282's function with the project's `director` level.
  - The Director never merges, accepts knowledge, or answers a question (hard refusals, tested).
- **Acceptance Criteria:** Table tests per level; e2e: Create on an Advise draft builds the tree.
- **Validation Steps:** `bun test packages/daemon/src/director packages/daemon/src/coordination`; `bun run test:e2e`.
- **Notes:** After T300 and T282.
- T301: sonnet review APPROVE. Verbs through AutonomyService/allowed() with the touched project's director level; hard refusals at gate, verb and hook layers; isDirector() tied to the minted session id. Director drafts are proposals with node director (shown on the Director page). merge 4a386d6. Pete: new project always a draft (no level yet); Director cannot read repos yet (P20 visibility) — follow-up.


### Ticket: T302 Cross-project sight and "what needs me today?"
- **Priority:** P1
- **Status:** Done
- **Owner:** Unassigned
- **Scope:**
  - The Director's brief gets a digest of all projects: overlaps, waits-on, stuck or idle nodes (no activity for longer than a configured time while `working`), and the inbox.
  - It proposes links and spots when a norm from one project is about to be broken in another.
  - "What needs me today?" answers from the snapshot, not from memory.
- **Acceptance Criteria:** A snapshot test of the digest; a fake-agent test where a stuck node yields a suggestion card.
- **Validation Steps:** `bun test packages/daemon/src/director`.
- **Notes:** After T301.
- T302: sonnet review APPROVE. Digest in director/sight.ts (20-line caps); stuck = working with no activity past director.stuck_after_minutes (60); checkStuck every 60s → restart_node via autonomy (card below Run), once per episode, Director wake budget 6/h. Director proposals now also show in the inbox on the node they name. merge 2c0502b.


### Ticket: T303 ∥ Norm suggestions
- **Priority:** P2
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** Findings that repeat across projects (the same file area or wording across reviewer findings and PR comments) wake the Director, which may `propose_knowledge`. The proposal comes to you as usual.
- **Acceptance Criteria:** A test: three similar findings across two projects produce one proposal with its sources.
- **Validation Steps:** `bun test packages/daemon/src/director packages/daemon/src/knowledge`.
- **Notes:** After T264 and T301.
- T303: sonnet review APPROVE. NormWatch (director/norms.ts): same dir or similar wording, >=3 new items from >=2 projects wakes the Director once; dedup via norm:<ids> thread refs; 3 wakes/day. Director propose_knowledge makes proposed items only, scope required, sources in source.finding. merged into phase-12.


### Ticket: T305 The Director reads repos
- **Priority:** P1
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** P20: the Director reads code under the visibility rules. Give its streamless session the coordinator read allow-list (every registered repo, agile home hidden), in the hook and the ACP permission path. Writes stay inside its scratch dir; no network.
- **Acceptance Criteria:** Hook tests: a Director read inside a registered repo is allowed; the agile home and paths outside every repo are denied; writes outside scratch are still denied.
- **Validation Steps:** `bun test packages/daemon/src/hook packages/daemon/src/director packages/daemon/src/permissions`.
- **Notes:** After T301. Pete approved 2026-09-24.
- T305: sonnet review APPROVE. directorReadScope: every repos.yaml path readable, agile home hidden, scratch-only if repos.yaml unreadable; hook + ACP paths. Side effect: stream coordinators' hook reads now enforce T213's read scope (was documented, never enforced). Director reads private repos too — Pete confirmed yes (2026-09-25). merge 28b484f.


### Ticket: T304 Phase 12 QA and Pete's look
- **Priority:** P0
- **Status:** Done
- **Owner:** Unassigned
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
- T304: sonnet QA ACCEPT (no findings). typecheck, lint, bun test 2281/0, test:integration, test:e2e green. Daemon 28,755 lines. Live Director check (Advise/Organise/merge refusal) is Pete's, on his Mac.


### Phase 13 — External links

### Ticket: T320 Tracker port, fakes and credentials
- **Priority:** P1
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** `daemon/trackers` with one port (get issue, list epic children, add comment, add link, transition status, create issue) and two adapters (Jira REST, Linear GraphQL). There are fake servers for both, as in T220. Credentials follow P17 **only once Pete has approved it as a D-entry**. `agile daemon status` reports each tracker as configured or not.
- **Acceptance Criteria:** Adapter tests against the fakes. The token never appears in logs or events (asserted).
- **Validation Steps:** `bun test packages/daemon/src/trackers`.
- **Notes:** P17 approved (D31). First ticket of Phase 13.
- T320: sonnet review APPROVE. Port + Jira REST/Linear GraphQL adapters + local fakes (T220 pattern); `trackers` config block; store.setTrackerToken (0600); daemon status shows configured/not. credentials.test.ts asserts no token leak. Daemon +926 (≈430 fakes). Gap: no way to set a token → T326. merge 40d9291.


### Ticket: T321 Link a node; pull its goal; edits as events
- **Priority:** P1
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** `agile node link <id> SHOP-11` and a Link field on the stream page. Linking sets the goal from the title, description and acceptance criteria. A poller (5 min) emits `external_changed` on edits and updates the goal with a thread line.
- **Acceptance Criteria:** Against the fake: link, edit the description in the fake, then the event and the goal update.
- **Validation Steps:** `bun test packages/daemon/src/trackers packages/daemon/src/events`.
- **Notes:** After T320.
- T321: sonnet review APPROVE. TrackerLinks: goal from issue title+description (delimited, 8k cap); 5-min poller emits external_changed to the node; node.link RPC, POST /api/streams/:id/link, `agile node link`, stream-page field. Injection test. Daemon +338. Follow-up: a tracker edit overwrites a locally edited goal (no goal-edit path exists yet). AC come from the description. merge 78e8a05.


### Ticket: T322 ∥ Roll-up
- **Priority:** P2
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** An unlinked node resolves to its nearest linked ancestor. The PR body mentions that issue (fills T224's line). The linked node shows progress as children merged/total.
- **Acceptance Criteria:** Unit tests for resolution and the PR body.
- **Validation Steps:** `bun test packages/daemon/src/trackers packages/daemon/src/delivery`.
- **Notes:** After T321.
- T322: sonnet review BLOCKING (tracker key/url unescaped in the PR body) → fixed: key limited to [A-Za-z0-9_-], link only for http(s), parens encoded; tests for javascript: urls and key injection. Manager checked the fix. rollupLink resolves to the nearest linked ancestor; stream page shows m/t merged. Daemon +95. merge 28bdfa0.


### Ticket: T323 ∥ Import an epic's children
- **Priority:** P2
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** An "Import children" button and `agile node import-children <id>` create one linked child per issue in the epic. It is idempotent: already-linked issues are skipped.
- **Acceptance Criteria:** A test against the fake: running it twice creates each child once.
- **Validation Steps:** `bun test packages/daemon/src/trackers`.
- **Notes:** After T321.
- T323: sonnet review BLOCKING (concurrent imports could duplicate children) → fixed: imports serialised per parent node, linked set recomputed inside the lock, concurrent test. Manager checked the lock. node.import_children RPC, POST /api/streams/:id/import-children, `agile node import-children`, cockpit button for epics. Children are not started and do not inherit the repo (manager call, matches create). Daemon +79. merge f447f9e.


### Ticket: T324 Status push and create issue
- **Priority:** P2
- **Status:** Done
- **Owner:** Unassigned
- **Scope:**
  - A per-project `push_status` (off by default) and `status_map`: in progress, in review and done are pushed, and the PR link is added as a link or comment. The app never closes an issue or edits its text.
  - "Create issue" is a click only.
- **Acceptance Criteria:** Against the fake: with `push_status` off, nothing is sent; with it on, the mapped transitions are sent. There is no call that edits text (asserted on the fake's request log).
- **Validation Steps:** `bun test packages/daemon/src/trackers`.
- **Notes:** After T321.
- T324: sonnet review APPROVE. trackers/push.ts: forward-only phase push (in progress / in review / done) only with push_status on and a status_map entry (no defaults); only transitionStatus + addLink. Create issue only via same-origin POST /api/streams/:id/issue (actor human; no RPC/MCP). Daemon +143. Follow-ups: no roll-up push from unlinked nodes; a failed push is not retried; no e2e for the Create issue button. merge e20ba79.


### Ticket: T326 ∥ Tracker tokens in Settings and the CLI
- **Priority:** P1
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** D31's write path, which T320 left out. Settings gets a Trackers section (Jira base URL, email, token; Linear token) that shows only whether each token is set, with Set and Clear. An HTTP write route (same-origin, actor human) and `agile tracker set jira|linear` (token read from stdin or a prompt, never an argument) both go through `store.setTrackerToken`. The token is never returned by any route.
- **Acceptance Criteria:** Route tests (403 cross-origin; GET never includes the token); CLI test; e2e: set a token in Settings, the screen shows "set", the page source never contains it.
- **Validation Steps:** `bun test packages/daemon/src/trackers packages/cli`; `bun run test:e2e`.
- **Notes:** After T320. Found in T320 review; T325's live check needs it.
- T326: sonnet review APPROVE. store.setTrackerSettings (atomic 0600; Jira base_url with the first token); GET/POST /api/settings/trackers (token_set only; same-origin 403; actor human); `agile tracker status|set|clear` (stdin or no-echo prompt; argv token refused); Settings Trackers section. Merged phase-13 in after T321 (RPC builder renamed buildTrackerSettingsRpcMethods). Daemon +143. merge 78293ee.


### Ticket: T327 Project tracker settings from the CLI
- **Priority:** P1
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** T324's per-project `tracker` block (system, `push_status`, `status_map`) had no way to be set. `agile project set <id> [--tracker jira|linear|none] [--push-status on|off] [--status-map in_progress=<Name>,in_review=<Name>,done=<Name>]`, merged into the current block through the existing `project.update` RPC. No cockpit project settings screen exists, so no UI.
- **Acceptance Criteria:** CLI parse/merge tests; round-trip through a real daemon; invalid blocks refused.
- **Validation Steps:** `bun test packages/cli packages/daemon/src/projects`.
- **Notes:** Found while writing Pete's Phase 13 live check. Full bun test 2335/0. CLI-only (daemon delta 0); manager reviewed the diff. merge 02f8e68.

### Ticket: T328 LIVE-CHECKLIST for the whole stage
- **Priority:** P0
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** §6.1: `LIVE-CHECKLIST.md` rewritten as the Phases 7–13 walkthrough (orientation, setup, repos and projects, coordination, PR delivery, cross-project overlap, knowledge, Director, trackers, day to day), home `~/.agile-walkthrough`.
- **Acceptance Criteria:** Every non-vendor block run as pasted in a scratch home; vendor blocks marked.
- **Validation Steps:** Pete runs it on his Mac.
- **Notes:** Asked for by Pete before cleanup. 42 blocks run under `zsh -f` (stand-in repos, stub gh, fake Jira, real classifier). Docs only. Found: the Director restarts a dying vendor session with no backoff → T329. merge fa59415.

### Ticket: T329 Director restart backoff
- **Priority:** P0
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** `DirectorService.wake()` restarts a Director session that dies at start immediately, 3–4 times a second (≈5,500 `director_put` events, ≈1,800 thread lines and one `sessions/` dir per attempt in 9 minutes). Add backoff and a cap; after repeated start failures, stop and put one card in the inbox with the error.
- **Acceptance Criteria:** A test with a vendor that dies at start: bounded attempts, backoff, one inbox card, no event flood.
- **Validation Steps:** `bun test packages/daemon/src/director`.
- **Notes:** Found in T328. Fix on claude/phase-12, merged forward.
- T329: sonnet review APPROVE. A start fails if start() throws or the session exits before its first turn ends; retries back off 5/10/20/40 s (5 min cap), give up after 5 with one Director-thread line naming the vendor error; `director say` resets. No per-retry thread lines or director_put. Thread line instead of an inbox card (inbox items need a stream) — Pete to confirm. Daemon +99. merge 8a7bc1e on phase-12, forwarded.


### Ticket: T330 Conversation nodes read repos; one message, one thread entry
- **Priority:** P0
- **Status:** In Progress
- **Owner:** opus:worker-T330
- **Scope:** From Pete's walkthrough §3.2: a conversation agent could not read the registered repos (design §4: a conversation "may read repos") and did not know where they were. Give it the visibility read scope on the hook and ACP paths, list readable repos (name, path) in its brief. Also: one agent message was split across several thread entries mid-sentence; keep one message in one entry.
- **Acceptance Criteria:** Read allowed for a registered repo, denied for the agile home and an unlisted private repo; the brief lists repos; a long message stays one entry.
- **Validation Steps:** `bun test packages/daemon/src/hook packages/daemon/src/permissions packages/daemon/src/runner`.
- **Notes:** Fixed on the earliest phase that has the code, merged forward.

### Ticket: T331 Collapse nodes in the rail
- **Priority:** P1
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** Pete: a caret before any node with children collapses or expands its subtree (double-click toggles too); state kept per viewer; a collapsed row still shows an attention dot from its subtree.
- **Acceptance Criteria:** Playwright: collapse hides children, expand shows them, state survives reload.
- **Validation Steps:** `bun run test:e2e`.
- **Notes:** Fixed on the earliest phase that has the rail, merged forward.
- T331: sonnet review APPROVE. Caret, double-click and Left/Right toggle; folds in localStorage (try/catch); folded rows show the amber dot; filter opens folds. Merged on phase-7 and forward to 13 (phase-8 conflict in StreamTree.tsx resolved keeping the overlap mark, visibility badge and dot). Double-click also opens the stream — Pete to confirm.


### Ticket: T335 Walkthrough cockpit-first from 3.4
- **Priority:** P1
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** Pete: LIVE-CHECKLIST from 3.4 on uses the cockpit, CLI only where no UI exists.
- **Acceptance Criteria:** Labels from packages/ui source; non-agent steps clicked through in a real cockpit.
- **Validation Steps:** Pete's walkthrough.
- **Notes:** Docs only. Found: the ship check let an untested diff through in 1 of 5 real-classifier runs (4 held at 0.80–0.83).

### Ticket: T336 Coordinator plans first after a split
- **Priority:** P1
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** Pete's run: after "+ Repo" split a node, the parts started at once with the node's whole goal and raised questions before the coordinator's plan existed. The coordinator starts first; parts wait for plan approval and get scoped goals; no Land card on a coordinating node; coordinator may run read-only Bash; a node woken by a coordinator note gets the note text and event id.
- **Acceptance Criteria:** Tests for the split ordering, part hold until approval, scoped goals, the wake note.
- **Validation Steps:** `bun test packages/daemon/src/streams packages/daemon/src/events packages/daemon/src/coordination`.
- **Notes:** Stacked: T336-split-coordinator → phase-7, T336-coordinator-wake → 9, T336-plan-gate → 11, T336-coordinator-reads → 12, T336-on-13/14 carry the T338 conflict resolution; merged and forwarded 7→14. Causes: an answer with no live session set idle (read as a human stop); parts started before any plan; a woken session got its events only after its first turn; `git -C`/`cd` denied for the coordinator. Parts made by a split wait for plan approval (marked by the split's own daemon thread line; Start later children don't auto-start). Review (sonnet), 3 rounds: blockers fixed — read-only git is an allowlist (isReadOnlyGitAtom), the `git -C` exemption is coordinator-only within read scope, option-attached paths (`-O/x`) are scope-checked; APPROVE. QA (sonnet): PASS on Pete's sequence. Follow-ups T343 (repo-config drivers, reviewer git), T344, T345.

### Ticket: T337 trackerPush used before init at startup
- **Priority:** P1
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** Startup migration raises questions → StreamService.update → onUpdated hook reads `trackerPush`, a const declared later: "Cannot access 'trackerPush' before initialization". Declare it before the StreamService; the push is skipped during migration.
- **Acceptance Criteria:** Regression test fails on the old code, passes on the new; status pushes still reach the tracker.
- **Validation Steps:** `bun test packages/daemon/src/store packages/daemon/src/tracker`.
- **Notes:** Branch T337-trackerpush-init (d18b826). Review (sonnet): APPROVE, regression confirmed against old code. QA (sonnet): PASS, reproduced on a legacy-shaped home before the fix, clean after. merge 8e6a3cf.

### Ticket: T338 Names, not ids, and the cockpit gaps from the walkthrough
- **Priority:** P1
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** (1) Everywhere the user reads text (plan owners, hold/satisfied lines, cards, agent text via briefs), show node/contract/plan titles as links, never raw ids; briefs tell agents to use titles. (2) Parts' questions about shared things go to the coordinator first; approving a plan resolves questions it answers. (3) Cockpit gaps: project/node ids copyable where scopes need them (or a scope picker); Director autonomy picker per project; project tracker / push status / status map controls; Name field on Knowledge → New rule; New project with repos; PR review/check/auto-merge state in the Delivery panel; an event-log view.
- **Acceptance Criteria:** Tests per item; e2e for the new controls.
- **Validation Steps:** `bun run test:e2e`.
- **Notes:** From Pete's walkthrough and T335's gap list. May split. Pete (2026-09-25): the Plan tab must label things: an "Owners" list by part name and each contract under a "Contract" heading. Branch T338-names-and-gaps, merge 1ab8062. (c) adds Question.coordinator/passed_up_at, the child_question event and the coordinator-only answer_child verb; proposed D35, awaiting Pete. Review (sonnet): blocker (plan approval superseded passed-up questions) fixed; APPROVE. QA (sonnet): PASS incl. hostile-text rendering. Merge with T340: both PR lines kept (T340 status line + T338 detail line; duplicate info, tidy in T341); T338 PR link now http(s)-only; T338 e2e moved its Merge click to a node without an open PR.

### Ticket: T339 Agents know the repo's own check commands
- **Priority:** P1
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** Pete's run: the ledger-lite part tried `bunx tsc --noEmit` (not in the repo, so it would fetch TypeScript) and waited on a human decision, instead of using the repo's own scripts. Put the repo's check commands in the brief: the `scripts` of the worktree's package.json (test, typecheck, lint, build) or a per-repo `checks` list in repos.yaml when set, with "use these; don't install or fetch tools". When a command is held or denied for fetching a tool, the reason names the repo's own scripts.
- **Acceptance Criteria:** Brief test lists the scripts; a repo with `checks` set uses them; the hold reason suggests them.
- **Validation Steps:** `bun test packages/daemon/src/runner packages/daemon/src/attach`.
- **Notes:** Branch T339-repo-checks, merge 797903e. Review (sonnet): APPROVE; nits applied (yarn runner, unit tests). QA (sonnet): PASS (brief Checks, repos.yaml override, bunx/npx/bun add holds name the scripts, no package.json → no section). Adds optional `checks` to repo entries (sibling of protected_branches).

### Ticket: T340 An auto-merged PR shows as merged
- **Priority:** P1
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** Pete's run: the PR auto-merged but the cockpit kept showing the Merge banner, and clicking Merge re-showed it. Show the PR's real state (merged, checks, review); replace the Merge button with PR status and "Check now" when GitHub merges it.
- **Acceptance Criteria:** A PR merged outside the cockpit shows merged after a poll or "Check now"; e2e.
- **Validation Steps:** `bun test packages/daemon/src/delivery`; `bun run test:e2e`.
- **Notes:** Branch T340-pr-merged-state off phase-8, merge d74da34 on phase-8, forward to 14. Causes: Merge on an open PR re-delivered and wrote pr_open without reading GitHub; a held re-deliver dropped the PR from the poller. deliverPr reads the PR first (merged → record + refuse; closed → human deliver opens a new one, agent push refuses, D8); Check now (pollNow, 5 s cooldown, POST /api/streams/:id/pr-check). Review (sonnet): blocker (agent push could open a PR) fixed; APPROVE, verified on phase-9. QA (sonnet): PASS twice.

### Ticket: T343 Reviewer read-only git uses the allowlist
- **Priority:** P0
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** Found in T336 review: the reviewer role's own read-only git check refuses `-c` but not `--config-env`, so a reviewer session can run a crafted git alias (command execution inside its worktree). Use T336's `isReadOnlyGitAtom` allowlist for the reviewer too; keep `--no-pager` working if reviewers rely on it. Fix on the earliest phase with the reviewer check, merge forward.
- **Acceptance Criteria:** Tests: reviewer denied `-c`, `--config-env`, `GIT_*=` prefixes, `--ext-diff`, `--output`; allowed plain `git log/diff/show/status`.
- **Validation Steps:** `bun test packages/daemon/src/permissions packages/daemon/src/hook`.
- **Notes:** Branch T343-reviewer-git-allowlist off phase-7, merged 7→14. Reviewer (and coordinator) git: strict allowlist `isReadOnlyGitAtom` (one leading `--no-pager` allowed, `-O<path>` refused); spawn env `readOnlyGitEnv` for every non-engineer role: GIT_ATTR_SOURCE=empty tree, GIT_CONFIG_* core.fsmonitor=false, core.hooksPath=/dev/null, core.pager=cat, gpg.*program=/usr/bin/false, GIT_PAGER=cat (diff.external NOT set: an empty value kills every diff). Engineer: git config writes held; .git writes denied; any git path argument outside the worktree or into .git held; --unsafe-paths denied; clone/worktree add/submodule add held; -c/--config-env/--exec-path and program-running env prefixes held. info/attributes and repo config are protected by the write layer (and the tier-0 sandbox), not the env. A pattern rule's deny now beats a role hold (both tiers). Review (sonnet): 5 rounds, APPROVE. QA (sonnet): PASS (twice; the first missed that the env broke every reviewer diff, caught by the manager).

### Ticket: T344 Nudge when parts wait on a plan that never comes
- **Priority:** P2
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** After T336, parts made by a split wait for the coordinator's plan. If the coordinator stops or never writes a plan, they wait silently. Surface it: a "waiting for the plan" inbox card on the node once its coordinator is idle with no plan, or after a timeout.
- **Acceptance Criteria:** Test: coordinator ends with no plan → a card; plan approved → card gone.
- **Validation Steps:** `bun test packages/daemon/src/inbox packages/daemon/src/coordination`.
- **Notes:** Branch T344-plan-nudge off phase-14, merged. Derived `plan_waiting` Needs me card on a coordinating node (parts waiting, no live coordinator, no plan awaiting approval) with Wake coordinator and Start parts anyway (POST /api/streams/:id/plan/start-parts, same-origin). Review found T336's waitingForPlan re-firing after a started part went idle → ci-fix-waiting-started. Review+QA (sonnet): APPROVE/PASS after the fix.

### Ticket: T345 Workers may cd within their worktree
- **Priority:** P2
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** Workers are denied `cd` (e.g. `cd sub && bun test`). Allow `cd` to a directory inside the worktree, with later relative paths resolved from there (as T336 does for coordinators); `tree` on the read-only list.
- **Acceptance Criteria:** Tests: `cd ./sub && bun test` allowed (a bare `cd sub` is denied with a fix-it reason); `cd .. && …`, `cd /` and the agile home denied.
- **Validation Steps:** `bun test packages/daemon/src/permissions packages/daemon/src/hook`.
- **Notes:** Branch T345-worker-cd off phase-11, merged 11→14. Worker `cd` only to `./`, `../`, `/`, `~`, `.`, `..` targets that realpath inside the worktree and not under .git; a bare name is denied with "use `cd ./name`" (CDPATH/cdable_vars); any command mentioning CDPATH is held (workers, reviewers) or denied (coordinators); spawn env CDPATH=''; later relative paths are checked from every possible cwd (`&&` replaces, `;`/`||`/`&`/pipe/`sh -c` accumulate; >16 fails closed); coordinator shares the tracker (fixes a `;`-after-failed-cd write); `tree` read-only (not -o/-R). Review (sonnet): CDPATH bypass found and fixed; APPROVE. Also found: a lone `&` bypass (pre-existing) → ci-fix-lone-ampersand on phase-7.

### Ticket: T341 Walkthrough QA in a browser with the fake agent
- **Priority:** P0
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** Pete (2026-09-25): before he runs the walkthrough again, a QA agent drives LIVE-CHECKLIST end to end in the cockpit (Playwright, Chromium) with the fake agent, fake GitHub and fake Jira, screenshots every step, and checks what appears where. Every bug found is fixed (on the earliest phase) and re-run until clean. Only real-agent behaviour is left for Pete.
- **Acceptance Criteria:** A run report with a screenshot per step and zero open findings; the scripted scenario lives in the repo as a reusable e2e (`test:walkthrough`, not in CI by default if slow).
- **Validation Steps:** the scenario passes twice in a row.
- **Notes:** Branch T341-walkthrough-qa off phase-14, merged. `bun run build && bun run test:walkthrough` (AGILE_WALKTHROUGH=1) drives LIVE-CHECKLIST 3.4–9.2 in a real cockpit with fake agent/GitHub/Jira/classifier, screenshot per step. 16 fixes (one PR line, plan v1, code-styled globs, no Land card for project conversations / PR-open nodes, grey dots, held reason once, named ship-check items, role-named composer, readable activity rows, project names in Director drafts, "you" in the Director thread, Needs me heading, Repos labels, "its turn finished", "human line"). Runs clean twice (39 steps, 0 findings). Review (sonnet): APPROVE. 12 decisions (D1–D12) and 15 checklist wording changes put to Pete.

### Ticket: T342 QA with a real agent
- **Priority:** P1
- **Status:** Blocked
- **Owner:** —
- **Scope:** Pete: "eventually I need you to be able to QA with a real agent." Run the T341 scenario against real Claude Code sessions in the cloud container, a real GitHub test repo and optionally a real tracker sandbox, and report agent-behaviour findings (like the `bunx tsc` choice) as well as app bugs. The daemon still holds no vendor credential (§7): the key lives only in the environment the vendor harness is spawned with.
- **Acceptance Criteria:** One full real-agent run in the cloud with a report; secrets never printed or logged.
- **Validation Steps:** —
- **Notes:** Blocked on Pete adding, in the cloud environment's settings: `ANTHROPIC_API_KEY` (for Claude Code in the container), `GH_TOKEN` (fine-grained, write to a throwaway test repo only), and optionally a Linear or Jira sandbox token. Network must allow api.anthropic.com and api.github.com.

### Ticket: T325 Phase 13 QA and Pete's look
- **Priority:** P0
- **Status:** Done
- **Owner:** Unassigned
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
- T325: sonnet QA ACCEPT against the fake Jira/Linear servers (credentials, link + real 5-min poll, roll-up injection, import twice, push on/off, never edits text or closes). typecheck, lint, bun test, test:integration, test:e2e green. §6.1: offline gate met; daemon line count NOT met (30,494 vs D18 < 20,000; ~430 are the tracker fakes) — Pete to decide; live walkthrough needs Pete.


### Phase 14 — Tree flexibility

Pete's requests from the walkthrough (D33, D34). Branch `claude/phase-14`, stacked on `claude/phase-13`.

### Ticket: T332 ∥ Conversation tangents
- **Priority:** P1
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** Per D33: `nodeRole()` keeps a conversation whose children are all conversations as `conversation`; a "Branch off" action on a thread line (cockpit) and `node new --parent` on a conversation create a child conversation seeded with that line and its own question; the parent's agent is not replaced by a coordinator; a finished tangent emits a short summary event to the parent (routed, capped, the tangent's own words as data). Update design/projects-design.md §6/P1.
- **Acceptance Criteria:** Role tests (conversation with conversation children stays conversation; becomes coordinating when a child gets a repo); e2e: Branch off from a line creates the child with the seed; a finished tangent's summary reaches the parent.
- **Validation Steps:** `bun test packages/shared packages/daemon/src/streams packages/daemon/src/events`; `bun run test:e2e`.
- **Notes:** Branch T332-tangents, merge d78af48. Review (sonnet): blocker (+ Repo on a conversation with tangents orphaned a worktree) fixed: it takes the part path; APPROVE. QA (sonnet): feature PASS; merging with T333 broke two T333 tests that assumed any child makes a coordinator. Manager call: roles stay structural (a repo-less child of a conversation is a tangent however it got there); T333 tests and design §7.1 updated.

### Ticket: T333 ∥ Move nodes by hand
- **Priority:** P1
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** Per D34: `agile node move <id> --parent <id|project>`, an HTTP route (same-origin, actor human) and drag-and-drop in the rail. Refuse moves into its own subtree, across projects, or while the parent's plan awaits approval. Re-derive roles; a thread line on the old and new parent; a work node keeps its branch and worktree. Update design/projects-design.md §6.
- **Acceptance Criteria:** Service tests for every refusal and for roles after a move; CLI test; e2e drag moves a node and the rail updates.
- **Validation Steps:** `bun test packages/daemon/src/streams packages/cli`; `bun run test:e2e`.
- **Notes:** Branch T333-move-nodes, merge ca402d0. Review (sonnet): APPROVE. QA (sonnet): PASS; low: a drop the rail refuses client-side (own subtree, other project) shows no message, only a server refusal does.

### Ticket: T334 Phase 14 QA and Pete's look
- **Priority:** P0
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** Black-box QA of tangents and moves; daemon line count.
- **Acceptance Criteria:** QA ACCEPT.
- **Validation Steps:** QA script; Pete in the cockpit.
- **Notes:** QA (sonnet): PASS on claude/phase-14. Typecheck, lint, bun test 2510/0, test:walkthrough pass; tangents, + Repo on a conversation with tangents, drag/CLI moves and refusals, rail collapse driven in a real cockpit. Low: a drop refused client-side (own subtree, other project) shows no message (known, T333). Low: + Repo on a conversation with tangents starts its part without waiting for a plan → T346. Draft PR petestewart/agile-agents#11 (14→13).

### Ticket: T346 A conversation's first part waits for the plan too
- **Priority:** P2
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** Found in T334 QA: "+ Repo" on a conversation with tangents makes it coordinating with an "<repo> part" child, but the part starts at once, while T336 makes split parts wait for the coordinator's approved plan. Same gate here, or say why one part needs no plan.
- **Acceptance Criteria:** Test: the part shows "waiting for the plan" and starts on approval.
- **Validation Steps:** `bun test packages/daemon/src/streams packages/daemon/src/coordination`.
- **Notes:** Branch T346-first-part-waits, merge 0bd8875. repo-in-place `split = !inPlace && !switching` gates coordinator start and plan wait, so + Repo on a conversation with tangents gets a coordinator and a waiting part; a human-stopped node still starts its part at once. Review+QA (sonnet): APPROVE/PASS.

### Ticket: T353 Walkthrough step 8.5 is load-sensitive
- **Priority:** P2
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** `test:walkthrough` step 8.5 ("the Parent defaults to the open node, Tracker epic") failed twice under machine load (other Chromium runs) and passes when idle; seen on phase-14 at c7c4164. Root-cause it (a race in the New stream form's default parent, or the walkthrough reading before the cockpit update lands) and fix the product or the wait, not a timeout bump.
- **Acceptance Criteria:** 5 walkthrough runs under parallel load, 0 failures at 8.5.
- **Validation Steps:** `bun run build && bun run test:walkthrough`.
- **Notes:** Branch T353-walkthrough-85, merge fec366e. Product race: the New stream form reset its default parent in an effect after mount, so the first render (and a quick submit) held the last opening's parent (11/15 fast reads). Now a fresh form per opening/open node with the parent as initial state (0/15). Also a best-effort "Check now" click in the walkthrough (the poller can merge first). 5/5 walkthroughs under 4-core load. Manager read the diff. Separate load flake at 7.3 → T354.

### Ticket: T354 Walkthrough step 7.3 under parallel load
- **Priority:** P3
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** Seen once with three walkthroughs in parallel: step 7.3's Director thread lacked "Started Changelog in ledger-lite". Root-cause (product race vs. test reading early) and fix at the cause.
- **Acceptance Criteria:** 5 parallel-load walkthroughs, 0 failures at 7.3.
- **Validation Steps:** `bun run build && bun run test:walkthrough`.
- **Notes:** From T353. Branch T354-walkthrough-73, merge 0f8a630. Root cause: the fake agent polls for `turn-N.txt` and can read it after creation but before the write, so the reply is lost (a Director "Started …" line at 7.3); proved with a standalone test under CPU load (12/3000 empty reads with a plain write, 0/3000 with rename). Fix: the walkthrough writes each reply aside and renames it in; test-only, no product change. 6/6 walkthroughs passed under 3-parallel load; full suite 2580 pass. Manager-reviewed (4-line diff).

### Ticket: T347 Cockpit wording and small UI (D36: D1, D5, D6, D7, D9, D11, D12)
- **Priority:** P1
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** D1 rename the two "Link" buttons to "Waits on…" and "Tracker issue…"; the tracker field only when the project has a tracker. D5 a direct merge event reads "merged". D6 the coordinator autonomy picker only on coordinating nodes and project roots. D7 "Merge" on the Needs me card too. D9 a ship-check hold styled neutral. D11 part titles in the rail not cut off by "waiting for the plan". D12 daemon lines addressed to the agent hidden from the human thread (still delivered to the agent).
- **Acceptance Criteria:** UI tests per item; walkthrough still clean.
- **Validation Steps:** `bun test packages/ui`; `bun run build && bun run test:walkthrough`.
- **Notes:** Branch T347-cockpit-wording, merge 0dd30ce. D1 "Waits on…"/"Tracker issue…" (field only with a project tracker); D5 a direct merge reads "merged" (event type unchanged); D6 autonomy picker on roots and coordinating nodes; D7 "Merge"/"Merged." throughout the cockpit (CLI `land` verb unchanged); D9 holds (ship check, waits-on, helper waits-on-parent) carry `held` and render neutral; D11 rail badge on its own line; D12 optional `agent_only` on thread entries (daemon-only writer), hidden in the cockpit. Review+QA (sonnet): blockers (helper hold still red, leftover "Landed"/"land again") fixed.

### Ticket: T348 The open node and filter live in the URL (D36: D2)
- **Priority:** P1
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** Reload or a shared link reopens the same node and project filter; back/forward move between nodes.
- **Acceptance Criteria:** E2E: open a node, filter, reload → same view; back returns to the previous node.
- **Validation Steps:** `bun run test:e2e`.
- **Notes:** Branch T348-url-state, merge 34beea0. `?node=`/`?view=` + `&project=` (extends T112); node/view changes push history, filter replaces; unknown URL ids fall back to the inbox with a clean URL. Review+QA (sonnet): APPROVE/PASS (no injection, no open redirect, no push loops).

### Ticket: T349 A "question" state on Children cards (D36: D3)
- **Priority:** P2
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** A child waiting on the human shows "question" (not "blocked") on its parent's Children card. Schema: add the state to the card status enum (.strict()); older homes still load.
- **Acceptance Criteria:** Tests: a child with an open question renders "question"; a real block still "blocked".
- **Validation Steps:** `bun test packages/shared packages/daemon/src/coordination packages/ui`.
- **Notes:** Branch T349-question-card-state, merge 3286bbd. CardState gains "question" (amber dot); open gates also read "question"; refreshQuestionCards rewrites stored stale "blocked" cards after migrateHome (idempotent). An older daemon refuses a stored "question" card. Review+QA (sonnet): APPROVE/PASS.

### Ticket: T350 Collapse ended sessions in the session list (D36: D4)
- **Priority:** P2
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** Coordinator wakes stay as they are. The sessions list shows live sessions plus one "N earlier sessions" row that expands.
- **Acceptance Criteria:** E2E: 8 ended coordinator sessions collapse to one row; expand shows them.
- **Validation Steps:** `bun run test:e2e`.
- **Notes:** Branch T350-collapse-ended-sessions, merge f04500d. Two or more ended sessions fold into one "N earlier sessions" row (a single ended one stays visible); live sessions always shown; fold resets per node. Review+QA (sonnet): APPROVE/PASS.

### Ticket: T351 Accepting a decision wakes the conversation (D36: D10)
- **Priority:** P2
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** When the human accepts knowledge scoped to a conversation whose turn has ended, the conversation is woken with the decision (same wake path as a human line), so it is delivered at once instead of staying "pending".
- **Acceptance Criteria:** Test: accept → the conversation is woken and the item is delivered.
- **Validation Steps:** `bun test packages/daemon/src/knowledge packages/daemon/src/events`.
- **Notes:** Branch T351-wake-on-accepted-knowledge, merge e82200c. knowledge_accepted wakes an ended, not human-stopped conversation (work nodes unchanged, P11); ≤5 conversation wakes per item (in memory, resets on restart); the item text reaches the agent quoted as data (≤200 chars). Startup replays pending items like other wake types. Design P11 and §15 updated. Review+QA (sonnet): APPROVE/PASS.

### Ticket: T352 Upgrade Bun if a release fixes the pipe bugs (D37)
- **Priority:** P1
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** Find the newest Bun release; check its changelog for the child_process fd double-close / EBADF-on-epoll_ctl fixes; run the full suite, test:integration and test:walkthrough under it, and the fd reproduction tests in chromium.test.ts and acp-client with the workarounds disabled. If fixed: move the pin (CI workflow, CLAUDE.md "1.3.11", engines) on phase-7 and forward. Keep the workarounds unless proven unneeded. If not fixed: report and stay.
- **Acceptance Criteria:** CI green on the new pin; the reproductions pass without workarounds, or a written finding that no release fixes it.
- **Validation Steps:** CI; `bun test`; `bun run test:integration`.
- **Notes:** Bun 1.4.2 (newest stable). Measured: fd double-close 19/20 rounds on 1.3.11 and 1.3.14, 0/20 on 1.4.0–1.4.2; the in-repo repro with pinnedStdio off fails 10/10 on 1.3.11, passes 10/10 on 1.4.2; a 10k-spawn stress loses exits/pipes on 1.3.11, none on 1.4.x. Pin moved on phase-7 and forward (CI, engines, CLAUDE.md, LIVE-CHECKLIST); workarounds kept. Also fixed a chromium.test.ts fd-count check that compared fd numbers only. Manager read the 6-file diff.

### Phase 15 — Cockpit UX overhaul

Pete (2026-09-26): the cockpit works but is rough; take it to a polished, professional app that a developer is productive in. His list: repo picker instead of free text (folder browse, GitHub/SSH URL, like T3 Code); repo icons (local / GitHub / SSH); New project repos as a vertical checklist and land on All projects; a chat like the Claude/Codex desktop apps; a new node starts with the default model, no picker; say what Knowledge holds (rules vs other items) and fix the rule cards; show not-started nodes in the rail; questions answered in the chat, not above it, with clickable choices; a role change takes effect without a restart; a way to delete a node. Design and vocabulary: `design/cockpit-ui.md`. Built on `claude/phase-14` (the session's designated branch); tickets `T###-<slug>` branch from it and merge back `--no-ff`. The UI keeps its `data-testid`s where the element survives, so the e2e suites move with the UI rather than being rewritten.

### Ticket: T360 UI foundation: design system and sidebar shell
- **Priority:** P0
- **Status:** Done
- **Owner:** manager
- **Scope:** Tokens (light/dark), type scale, the primitives every screen uses (`components/ui.tsx`: Button, IconButton, Menu, Dialog with focus trap, Tabs, Badge, StatusDot, EmptyState, Toast; `components/Icon.tsx` inline SVG), and the shell: a left sidebar (Needs me, Director, views, the project tree, Settings) replaces the top bar; pages own their headers. "Node" everywhere in UI text (not "stream"). `design/cockpit-ui.md`.
- **Acceptance Criteria:** Every view renders in the new shell in light and dark; e2e and walkthrough green with selectors moved from the top bar to the sidebar.
- **Validation Steps:** `bun run build && bun run typecheck && bun run lint && bun test packages/ui && bun run test:e2e`.
- **Notes:** Branch T360-ui-foundation, merge 8469594. control-room e2e 49/49 (one fix: a project-role row keeps its dot when its status is news), feed/installable green, walkthrough 1/1. Quick capture removed (New node is the one path); its four tests moved to the New node dialog. Also `.cr-thread li` styled markdown list items inside messages (fixed to `> li`).

### Ticket: T361 ∥ Agents follow role changes; question choices; delete and restore; a message starts a stopped node
- **Priority:** P0
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** (1) A move or a new child that changes a node's derived role restarts its live agent in the new role (worker ↔ coordinator), as + Repo already does, with a thread line saying so. (2) An agent's `ask` may carry `options` (the Question schema has them); the inbox item carries them (InboxItem `options`, question kind only, `.strict()`), so the cockpit can offer them as buttons. (3) HTTP `POST /api/streams/:id/archive` (stops live sessions, archives the subtree, removes clean worktrees; branches kept) and `.../unarchive`; `GET /api/streams?archived=1` or a cockpit field listing archived nodes. (4) `POST /api/streams/:id/say` with `start: true`: on a node with no live agent that is open, the line starts its agent with the session defaults and is its first prompt. (5) Cockpit rows (`feed/snapshot.ts` `CockpitStreamRow`) carry `never_started: true` (a work node or conversation whose agent never ran) and `stopped: true` (`stoppedByHuman` with nothing live, and not closed/landed/archived), so the rail can show them.
- **Acceptance Criteria:** Service tests for each; existing suites green.
- **Validation Steps:** `bun test packages/shared packages/daemon`; `bun run typecheck`.
- **Notes:** Branch T361-daemon-ux, merge f47bece. `StreamService.onTreeChanged` → `AttachService.followRoles`: move, create-child, close, archive, restore re-check the node and its ancestors and restart a live agent whose role changed (same vendor/model/effort, a daemon stop, a thread line). `ask` takes 2–6 `options`; InboxItem `options` (question only). `POST /api/streams/:id/archive|unarchive` (subtree, one `archive_id` per delete, refuses a root; worktrees/branches kept; cockpit `archived`). `say {start}` starts a node with no live agent with its line in the brief. Rows carry `never_started`/`stopped`. Daemon +379. Open: `say {start}` would start a part waiting for its plan (the cockpit never sends it there); `stopAll()` on daemon shutdown may mark mid-work nodes done (read, not reproduced); archived nodes' items still counted in `buildSnapshot`'s `needs_you`.

### Ticket: T362 ∥ Browse folders, clone by URL, a repo's remote kind
- **Priority:** P0
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** `GET /api/fs/dirs?path=` (same-origin; child directories of an absolute path, each flagged when it is a git toplevel; home and parent for navigation); `POST /api/repos/clone {url, dest?, name?}` (https, ssh `git@host:o/r`, `owner/repo` shorthand for GitHub; clones with the user's own git credentials into `dest`, default a projects folder, then registers it); repo rows (`/api/repos`, cockpit `repos`) carry `remote: {kind: 'github' | 'gitlab' | 'other' | 'none', protocol?: 'https' | 'ssh', url?}`.
- **Acceptance Criteria:** Unit tests with temp dirs and a local bare repo as the clone source; no network in tests.
- **Validation Steps:** `bun test packages/daemon/src/http.test.ts packages/daemon/src/store`; `bun run typecheck`.
- **Notes:** Branch T362-repo-picker-api, merge 6fcde72. `GET /api/fs/dirs` (same-origin + loopback Host; `prefix` for autocomplete; 500 cap), `POST /api/repos/clone` (https, ssh, file, `o/r`; user's own git credentials, no prompts, 10 min timeout, credentials stripped from errors; registers through `state.repo_add`), repo rows and the cockpit carry `remote {kind, protocol, url, owner?, name?}` from a 60s background cache. Daemon +870. Open: GET routes lack the loopback Host check (DNS rebinding); repo names unvalidated (`__proto__`); `resolveMainBranch` runs git per `GET /api/repos`.

### Ticket: T363 A node's page is a chat
- **Priority:** P0
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** Header (path, title, status in words, role, primary action, overflow menu with the rest); tabs only where they apply; the thread as a chat (your lines as bubbles, the agent's as prose, daemon lines as compact system rows that group); questions, gates and plans inline at the end of the chat, answered there (choices as buttons, the composer answers an open question); the composer (grows, Enter sends, Stop while running, the session model as a chip; a message to a stopped node starts it); a details panel (delivery and Merge, sessions, children, waits on, tracker, autonomy, project settings on a root). Start with defaults in one click; the picker is optional.
- **Acceptance Criteria:** e2e for chat, inline answer, choice click, send-starts-agent; walkthrough green.
- **Validation Steps:** `bun run build && bun run test:e2e && bun run test:walkthrough`.
- **Notes:** Branch T363-node-chat, merge e14de3da. Header: path, title, status, role, repo/branch (copy), one filled action (Start agent with a model chevron / Stop / Merge), details toggle, ⋯ (Review changes…, Restart agent, Waits on…, Add repository…, Tracker issue…, Copy branch, Close node… (confirms), Delete node… (Undo)). Chat: your bubbles, the agent's prose with name, one-line system rows (three noisy ones reworded), hover Copy/Branch off/time, stick-to-bottom with a New messages pill, goal card, empty state. What needs you sits above the composer; the composer answers an open question (a chip picks which) and a message to a never-started or stopped node starts it (not a part waiting for its plan). Tabs Chat, Changes, Plan, Activity, Knowledge, Docs only where they apply. Details panel (Delivery, Agent, Children, Waits on, Tracker, Autonomy, project controls), remembered per viewer. Reusable `Chat.tsx`/`Composer.tsx`; rules in `lib/chat.ts`. Branch e2e 54/54 + feed/installable, walkthrough 1/1; merged tip (with T364–T367) control-room 64/64, feed, installable, walkthrough no findings. Open: a finished work node with no commits reads Ready to merge; `startWithPending` repeats the line in the brief; the question's thread line and its card both show.

### Ticket: T364 ∥ Needs me and the decision cards
- **Priority:** P1
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** One `Card` for every item kind with a clear title, the node path, its age and its actions; a question's choices as buttons; grouped by project then node; an empty state that says what to do next (first run: add a repo, make a project).
- **Acceptance Criteria:** e2e per card kind still green; choice click answers.
- **Validation Steps:** `bun test packages/ui`; `bun run test:e2e`.
- **Notes:** Branch T364-needs-me, merge 6db025cc. `DecisionCard` (re-exported as `Card`): one anatomy for every kind, titles in words, choices as lettered buttons (the agent's `options`, else `choicesOf` parses older `(A) … (B) …` / lettered / numbered lists conservatively, 41 unit tests); `full` cards have no input (the node's composer answers). Gates explain themselves; notes behind "Add a note"; a Merge refusal shows on the card. Needs me grouped by project then node, a kind filter, j/k/Enter; first-run steps (repo, project, node) and "all caught up". Branch: control-room 51/51, walkthrough 0 findings; after merge UI 134/0, Needs-me e2e 13/13. Open: `groupInbox` now unused; daemon wording "worker finished — merge or close the stream" / "proposed rules from migration" reworded client-side; gate/knowledge items carry rule, call and scope only inside `context` (structured fields would be sturdier); an acted card stays disabled until the next frame.

### Ticket: T365 ∥ Rail, projects and the new-node flow
- **Priority:** P1
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** Rail status per node (not started, working, needs you, ready, merged, blocked, closed) with a legend in the tooltip; projects as collapsible groups; New project with repos as a vertical checklist (repo icons) that lands on All projects with the project open; New node (title/goal, project, parent, repo picker, start now with the default model, on by default); project overview on the root; Delete (archive) with confirm and Undo, and an Archived list to restore; a refused drag says why.
- **Acceptance Criteria:** e2e for each flow.
- **Validation Steps:** `bun run test:e2e`.
- **Notes:** Branch T365-rail-projects, merge 860ee518. Rows with status dot (not started: dashed ring, faded title), role icon, hover `+` and ⋯ (Open, New child node, Rename F2, Move to…, Copy id, Delete…; project rows: New node, Show only this project, Project settings), right-click menu; arrow-key tree navigation. Delete confirms, archives the subtree, Undo toast; Deleted (n) with Restore. A refused drag says why. The project `<select>` is replaced by a chip ("Only Shop ▾ ×"); nothing switches the filter by itself (Pete). Legend (?) for dots and icons. New project: vertical repo checklist with icons; lands on All projects with the root open. New node: goal first, title from it, project only when not implied, searchable parent, repo picker (none = Conversation), Start the agent now (on) with the model shown and Change. `POST /api/streams/:id/update {title?, goal?}`. testid changes: `new-stream-start` (checked = start), pickers `new-stream-parent|repo(-option|-search)`, `project-filter*`, `tree-menu-*`, `archived-*`. Branch e2e 55/55 ×2, walkthrough clean; merged tip (T364+T365+T366) control-room 57/57, walkthrough no findings. Open: project overview page (node-page area); project session defaults not in `/api/settings/session`, so New node's model line can differ; Popover stays open on Tab out.

### Ticket: T366 ∥ Knowledge, explained
- **Priority:** P1
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** The screen says what knowledge is (rules, standards, architecture, decisions) and separates it: Proposed (to review) first, then by kind; each item's enforcement in words (checked on every action, checked before merge, on the reviewer's checklist, guidance only); compact rows with a detail panel for text, check, examples, stats, Edit and Test.
- **Acceptance Criteria:** e2e for filter, accept, edit, test still green.
- **Validation Steps:** `bun run test:e2e`.
- **Notes:** Branch T366-knowledge, merge on phase-14. Tabs All · To review · Rules (enforced: action + ship) · Standards · Architecture · Decisions; rows with scope and enforcement in words, quiet stats, flags as icons; a Linear-style detail panel (text, scope, enforcement explained, the check, examples and test results, activity); the editor grouped What / Where / How it's enforced with only the fields that apply. Refreshes on `knowledge_*` events too (it went stale on agent proposals). e2e 49/49, walkthrough 1/1 on the branch; knowledge e2e 9/9 after merge. Open: default classifier question keeps markdown backticks and says "action" for ship checks (`shared/src/knowledge.ts`); built-ins named after their pattern kind (`knowledge/builtins.ts`); `report.ts` flags guidance items "never fired".

### Ticket: T367 ∥ Settings and the repo picker
- **Priority:** P1
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** Settings in sections (General, Agents, Repositories, Classifier, Trackers, Permissions); Add repository: a path with folder autocomplete and a browser, or a GitHub/SSH URL to clone (T362); every repo listed with its icon (local, GitHub over https or ssh, other remote); theme (system/light/dark).
- **Acceptance Criteria:** e2e: add by browsing; add by URL against a local bare repo.
- **Validation Steps:** `bun run test:e2e`.
- **Notes:** Branch T367-settings-repos, merge 5ebbb1a2. Settings with a section nav (General: theme, daemon facts from `/health`; Agents; Repositories; Classifier; Trackers; Permissions), the section in the URL. Repositories: rows with `RepoIcon`, host · protocol, owner/name link, short path, main branch; Delivery/Visibility as segmented controls (private: projects by name), protected branches; saves inline. `AddRepoDialog` (portal): Local folder with autocomplete + folder browser (git repos marked, "inside a repo" and "already added" hints) and Clone from URL (live preview, destination, progress, readable git errors with SSH hint); a pasted URL switches mode. Branch control-room 53/53, walkthrough clean; after merge, settings/repo e2e 20/20. Open: `store.addRepo` silently replaces an existing name (`POST /api/repos`, `agile repo add`); `Dialog` renders in place so a Dialog inside a form nests forms; a `file` remote shows a globe; `n`/`/` fire while a dialog is open with focus off an input; Pull request offered for a local-only repo (daemon refuses it).

### Ticket: T368 Lenses, Events and the Director
- **Priority:** P2
- **Status:** Done
- **Owner:** worker
- **Scope:** Repos, Running, Dependencies and Events as clean lists with status and links; the Director page uses the node chat's components.
- **Acceptance Criteria:** walkthrough green.
- **Validation Steps:** `bun run test:walkthrough`.
- **Notes:** Branch T368-lenses-palette. Repos as cards (remote kind, delivery in words, live work, overlaps, recent events linking to Events filtered to the repo, norms); Running as a table with your move first; Dependencies as edges with "Remove link" (Undo); Events as a day-grouped timeline with search, type and repo filters and routing chips in words. Also the ⌘K command palette (nodes, projects, views, actions, recents), the `?` shortcut list and `g` jumps; the Director on `ChatScroll`/`MessageList`/`Composer` with drafts as decision cards and a details panel. Pure logic in `lib/lenses.ts`, `lib/palette.ts`, `lib/director.ts` with tests. control-room 66/0, walkthrough 39 steps, 0 findings.

### Ticket: T370 A daemon shutdown leaves mid-work nodes idle
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** Found by the T361 worker: `AttachService.stopAll()` (the daemon's shutdown) stopped sessions with no reason, so a killed worker's exit read as a finished turn: `agent.status: done`, an inbox "worker finished" card and "Ready to merge" on the rail after every restart. Stop with a daemon reason instead.
- **Acceptance Criteria:** Test: a node mid-work when the daemon stops is `idle`, its session `stopped: the daemon stopped`, not stopped by the human.
- **Validation Steps:** `bun test packages/daemon/src/attach`; CLI daemon e2e.
- **Notes:** Branch T370-daemon-shutdown. Non-e2e daemon+CLI 2080/0; `daemon.e2e`, `stream.e2e` green. Daemon +10.

### Ticket: T371 ∥ Daemon text the cockpit shows: no ids, no "stream"
- **Priority:** P2
- **Status:** Done
- **Owner:** Unassigned
- **Scope:** Found by T364/T366: daemon-written text the cockpit displays leaks ids and old vocabulary. Inbox items ("worker finished — merge or close the stream", "3 proposed rules from migration"), delivery preflight/refusal reasons ("stream <id> has a live session (<id>)"), land-gate text with raw `stream/<id>-slug` branches, the default classifier question (markdown backticks, ".?", "action" for a ship check that reads a diff), guidance items flagged "never fired", built-ins named after their pattern kind. Say nodes by title and "node", keep ids only where a machine reads them. Update the tests and LIVE-CHECKLIST lines that quote the old strings.
- **Acceptance Criteria:** Unit tests for each reworded string; e2e and walkthrough still green.
- **Validation Steps:** `bun test packages/shared packages/daemon` (non-e2e); `bun run build && bun run test:walkthrough`.
- **Notes:** Branch T371-daemon-text (rebased on a198ef78), merge on phase-14. Inbox cards, merge preflight/refusals, land-gate summaries (`land <slug> into main`), holds and ship-check lines, attach/move/tangent refusals and Director proposals name nodes and projects by title and say node/merge; `branchLabel` strips `stream/<ulid>-`. `classifierQuestion` strips code ticks and trailing punctuation and asks "this change" for ship checks (Test examples ask the same). `tell` items are never flagged "never fired" (`review` items do fire, so they still can be). Built-ins renamed `no-push-to-protected`, `no-push`, `stay-in-worktree` with plain reasons; existing homes updated only where a record still matches what an older daemon wrote. Kept on purpose: the `land:`/`classifier_review:` prefixes and scope ids the cockpit parses, thread lines the walkthrough quotes, agent-only messages. Non-e2e 2339/0, control-room 65/0, walkthrough 1/1. Daemon +94. Follow-up merged with it: the Knowledge editor's placeholder is the real default question. `lib/inbox.ts` STOCK_TEXT is now dead (the daemon sends that text).

### Ticket: T372 The cockpit can rename a project and change its repos
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** Found by T365: `POST /api/projects/:id` forwarded only autonomy and tracker, so a project's repos couldn't change after creation from the cockpit although `ProjectService.update` validates `name` and `repos`. Forward them; `updateProject()` in the cockpit API.
- **Acceptance Criteria:** http test: rename, repos, unknown repo 400, cross-origin 403.
- **Validation Steps:** `bun test packages/daemon/src/http.test.ts`.
- **Notes:** Branch T372-project-route, merged after T367. The UI to edit a project's repos rides the node page's project settings (T363) or a follow-up.

### Ticket: T373 Integration polish: dialogs, shortcuts, Add repository everywhere
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** From the T365/T367 reports: `Dialog` rendered in place, so a dialog inside another dialog's form nested forms (a page reload); `n`/`/` fired while a dialog was open; a `file` remote read as a globe "Remote"; New project's "Add a repository…" left for Settings.
- **Acceptance Criteria:** e2e: New project → Add a repository… → pick a folder → ticked; Esc closes only the top dialog; the inner submit doesn't create the project.
- **Validation Steps:** `bun test packages/daemon/src/feed/control-room.e2e.test.ts -t "T373|New project"`.
- **Notes:** Branch T373-integration-polish, merged after T363. `Dialog` portals to `document.body` and stops its submit from bubbling (React bubbles through portals); `isShortcut` is off while `[aria-modal]` exists; a `file` remote is "Local clone" with a folder icon; New project and New node embed `AddRepoDialog`. Related e2e 15/15 after merge.

### Ticket: T378 A repo name taken by another folder is a clash, not a silent replace
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** From T367: `POST /api/repos` with a name already registered for another folder silently replaced that repo, and any re-add reset its delivery, visibility and GitHub settings to a fresh repo's.
- **Acceptance Criteria:** http test: 409 on a clash; the same folder (another spelling) re-registers keeping its settings.
- **Validation Steps:** `bun test packages/daemon/src/http.test.ts packages/daemon/src/store`; CLI `repo.e2e`.
- **Notes:** Branch T378-repo-name-clash. `state.repo_add` merges onto the existing entry; the HTTP route answers 409 for a different folder (the CLI keeps re-registering, since there is no `repo remove`). Also T376 (a question reads once on its page) and T377 (a project's repos editable on its root) were merged by the manager with their own tests.

### Ticket: T379 A project's own session defaults are shown and editable
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** From the follow-ups doc: attach applies a project's `session` (P5) before the repo's, but the cockpit never showed it. New node's "Starts with", the composer's model chip and the picker's prefill could name the wrong model, and Settings could not edit it.
- **Acceptance Criteria:** The frame's project rows carry `session`; `POST /api/projects/:id` takes `session` (`null` clears); Settings → Agents has a "Per project" card per project; New node, the composer and the picker resolve with the project step (`lib/defaults.ts` `resolvedFor`).
- **Validation Steps:** `bun test packages/ui/app/lib/defaults.test.ts packages/daemon/src/http.test.ts`; control-room e2e "T379: a project's own defaults…" (Settings save → the composer chip → Send starts that model → back to inherit clears the block).
- **Notes:** Branch T379-project-session-defaults. A project card's "starts with" reads "Varies by repository" when its repos resolve differently. `startStreamCockpit` in the e2e now wires `ProjectService` as the daemon does.

### Ticket: T380 A finished node with nothing to merge says so, and offers Close
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** From the follow-ups doc: a work node whose agent finished without committing read *Ready to merge* on the rail and got a Merge card in Needs me, while its Delivery panel said there was nothing to merge.
- **Acceptance Criteria:** The frame's row carries `nothing_to_merge` (from `DeliveryService.preflight`, cached in `feed/merge-state.ts` off the frame's path and re-pushed when it changes); the node reads "No changes" (amber, your move); its card reads "Finished, no changes" with Close node, in Needs me and at the end of its chat. `done` itself is unchanged, so coordinators, auto-review and the tracker push react as before.
- **Validation Steps:** `bun test packages/daemon/src/feed/merge-state.test.ts packages/ui`; control-room e2e "a finished node with no commits reads No changes…".
- **Notes:** Branch T380-no-changes. The check is keyed on the agent's last status change, the branch and a recorded conflict, with a 30 s TTL for commits made by hand; a node merged outside the cockpit keeps Merge (the click records it).

### Ticket: T381 QA wording: Knowledge's link, "Can't merge yet", a proposal in words
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** From the T369 screenshot pass: Knowledge's deep link read `?view=rules`; the Delivery line said "Not landable yet" and "a land gate"; a held proposal's thread line read `director (advise) proposes: …` in the Director's chat.
- **Acceptance Criteria:** `?view=knowledge` (and the old `?view=rules`) opens Knowledge and the URL it writes says `knowledge`; the Delivery line says "Can’t merge yet" and "asks you to approve each merge"; the proposal line reads "Proposed, waiting for your approval: …".
- **Validation Steps:** `bun test packages/ui/app/lib/shell.test.ts packages/daemon/src/coordination`; the Director, rules and delivery e2e.
- **Notes:** Branch T381-qa-wording.

### Ticket: T382 ∥ Running shows each node's agent and model; model names read one way
- **Priority:** P1
- **Status:** Done
- **Owner:** worker
- **Scope:** From T368 and T369: the cockpit row carries no session fields, so Running can't say which agent/model/effort a live node runs; and model names read two ways (`Claude Opus 5.5 · low` in the composer and header, `claude/claude-opus-5-5 · low` in the details panel's session rows and Settings' "starts with" chips).
- **Acceptance Criteria:** `CockpitStreamRow` carries the live agent's vendor, model and effort (additive, absent when nothing is live); Running shows it in words; every place a person reads a model uses `sessionLabel`; the e2e pins move with it.
- **Validation Steps:** `bun test packages/ui packages/daemon/src/feed/snapshot.test.ts`; the Running, session-defaults and node-page e2e; the whole control-room e2e and the walkthrough.
- **Notes:** Branch T382-running-model. The row's `live_agent` is the node's own worker or coordinator first, else a live reviewer, else lessons. Running has an Agent column; `agentLabel` names the agent only when the model's name doesn't. T386 (branch T386-model-labels) carried it to New node, the composer, the picker's "Default here" and removed the dead `sessionModelText`. control-room 68/0, walkthrough 0 findings.

### Ticket: T383 ∥ Events pages through the whole log
- **Priority:** P1
- **Status:** Done
- **Owner:** worker
- **Scope:** From T368: `/api/events` is capped at 200 (`ACTIVITY_MAX`), so Events' "Show more" ends there and a repo card's recent events filter that global list (a quiet repo's older events fall outside it).
- **Acceptance Criteria:** `GET /api/events` takes a cursor (`before=<event id>`) and a limit, newest first; Events' "Show more" fetches the next page until the log ends and says so; a repo card asks for its own repo's events.
- **Validation Steps:** `bun test packages/daemon/src/events packages/daemon/src/http.test.ts packages/ui`; the Events and Repos e2e; the whole control-room e2e and the walkthrough.
- **Notes:** Branch T383-events-paging. `GET /api/events?before=&limit=&repo=` answers `{events, more, total}` (400 in words for a bad limit or an unknown cursor); Events loads 100 a page and says "That's everything." at the end; search and type filter the loaded pages and offer "Search older events"; repo cards fetch `repo=<name>&limit=5`. New e2e "the event log pages (T383)"; control-room 69/0, walkthrough 0 findings.

### Ticket: T384 P2 polish: pull requests need GitHub, Stop while it waits, popovers, dead code
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** From the follow-ups doc: Pull request delivery offered for a repo with no GitHub remote (the daemon refuses it); Stop as a header button while the agent is idle waiting on you; a popover that stays open when Tab leaves it; the rail legend not following a window resize; dead `STOCK_TEXT`, `groupInbox` and old modal styles.
- **Acceptance Criteria:** "Pull request" is disabled with the reason for a repo whose remote isn't GitHub; the header shows Stop only while something is mid-turn (⋯ → Stop agent otherwise); Tab out of a popover closes it without pulling focus back; the legend re-places on resize; the dead code is gone.
- **Validation Steps:** `bun test packages/ui`; the settings, rail, menu and node-page e2e (T222 now checks the disabled option).
- **Notes:** Branch T384-p2-polish. `Segmented` items take `disabled` and `title`; `headerActions` takes `anyBusy`.

### Ticket: T385 Rename and re-goal a node from its page
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** From the follow-ups' "not built": a node's title and goal could only be changed through the rail's Rename… (title only); a changed goal never reached a running agent.
- **Acceptance Criteria:** A click on the page's title edits it in place (Enter or leaving saves, Esc cancels; not on a project root); the goal card's Edit changes the goal; `POST /api/streams/:id/update` adds a "goal changed: …" thread line when the goal changes, which the chat shows as "Goal changed: …".
- **Validation Steps:** `bun test packages/ui`; control-room e2e "a click on the title renames the node; Edit on the goal…"; the whole control-room e2e (69/0) and the walkthrough.
- **Notes:** Branch T385-edit-title-goal.

### Ticket: T386 Model names in words in New node, the composer and the picker
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** From T382: New node's "starts with" line still read `claude-opus-5-5 · claude · low effort`; the composer and the picker used `sessionLabel` where `agentLabel` names a vendor the model doesn't; `sessionModelText` was dead.
- **Acceptance Criteria:** New node, the composer chip and the picker's "Default here" use `agentLabel`, with the raw ids on hover.
- **Validation Steps:** `bun test packages/ui`; the New stream, T363 and session-defaults e2e.
- **Notes:** Branch T386-model-labels.

### Ticket: T387 ∥ A project's root page opens on an overview
- **Priority:** P2
- **Status:** Done
- **Owner:** worker
- **Scope:** From the follow-ups' "not built": a project root opens on the root node's chat, so a project has no at-a-glance view of what its nodes are doing.
- **Acceptance Criteria:** A project root has an **Overview** tab, first and default: counts by status (your move first), its nodes as rows by status with path, repo and age, its repos with their icons, and its recent events; the chat stays one tab away; each row opens its node.
- **Validation Steps:** `bun test packages/ui`; a new control-room e2e; the whole control-room e2e and the walkthrough.
- **Notes:** Branch T387-project-overview. `components/ProjectOverview.tsx`, `lib/overview.ts` (tested); only a real project root gets it (a project-less top-level node keeps its chat); the chips filter in place; Done folds; repos with what Merge does there; recent activity is the project's own events from the newest pages; a question on the root shows an "Open chat" banner. control-room 71/0, walkthrough 8.2 checks Shop's Overview.

### Ticket: T390 Overview polish: the root's primary, child cards in words, "You wrote"
- **Priority:** P3
- **Status:** Done
- **Owner:** manager
- **Scope:** From T387's report: Start agent was the filled button on a project root (the next step there is a node); the details panel's child cards showed the raw card state ("question", "done" for a closed node); a typed line read "Human line" in Events, Activity and the Overview; the design doc didn't name the Overview.
- **Acceptance Criteria:** Start agent is a plain button on a project root; child cards read Working, Needs you, Blocked, Done, Idle, or Merged/Closed from the node itself; a typed line reads "You wrote"; `design/cockpit-ui.md` names the Overview, editing in place and notifications.
- **Validation Steps:** `bun test packages/ui`; the status-cards and event-log e2e.
- **Notes:** Branch T390-overview-polish.

### Ticket: T388 ∥ Opt-in browser notifications when something new needs you
- **Priority:** P2
- **Status:** Done
- **Owner:** worker
- **Scope:** From the follow-ups' "not built": the cockpit is a tab you keep open all day, but nothing tells you when a new question, gate or merge arrives while you are elsewhere.
- **Acceptance Criteria:** Settings → General has a Notifications switch (per browser, off by default, asks the browser's permission on turning on, says when the browser blocks it); with it on and the tab hidden, a new Needs me item raises one notification naming what and where, a click focuses the tab on that node; nothing for items already there at load, nothing while the tab is visible; the title's `(n)` count stays.
- **Validation Steps:** `bun test packages/ui` (the pure "which items are new" logic); a control-room e2e with a granted permission.
- **Notes:** Branch T388-notifications. `lib/notify.ts` (pure, 24 tests) and `lib/use-notify.ts`; one notification at a time (tag `agile-needs-me`), several items become "N new things need you"; a click opens the node or Needs me; Settings → General's Notifications card says On, Off, Blocked or Not available in words, with Send a test. Two e2e tests (granted, blocked/dismissed/missing); control-room 72/0, walkthrough green.

### Ticket: T389 P3 hardening: repo names, a waiting part's line, deleted nodes' asks
- **Priority:** P3
- **Status:** Done
- **Owner:** manager
- **Scope:** From the follow-ups doc: repo names were not validated (`__proto__` is lost when the registry parses); `say {start}` would start a part waiting for its coordinator's plan; the snapshot counted a deleted node's questions and gates in `needs_you`; `getRepoEvents` was dead.
- **Acceptance Criteria:** `state.repo_add` and clone refuse a name that isn't letters, digits, `.`, `_`, `-` (starting with a letter or digit) in words, clone before git runs; `say {start}` leaves a waiting part to its plan (the line stays pending); the snapshot leaves archived nodes' asks out.
- **Validation Steps:** `bun test packages/daemon/src/store packages/daemon/src/feed/snapshot.test.ts`; `bun test packages/daemon/src/attach/service.test.ts -t T389`.
- **Notes:** Branch T389-p3-hardening. `RepoNameSchema`/`REPO_NAME_RULE` in `packages/shared/src/repos.ts`.

### Ticket: T391 A node that finishes again notifies again
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** D39: T388 keyed a notification on the item's kind and id, and a node's `done` item carries the node's id, so a node that finished, got a reply and finished again stayed silent the second time.
- **Acceptance Criteria:** The key includes the item's time (a `done` item's is the agent's last finish); a new finish notifies, a card that only leaves and comes back does not.
- **Validation Steps:** `bun test packages/ui/app/lib/notify.test.ts`; the T388 e2e.
- **Notes:** Branch T391-notify-each-finish. Also records D38 (no global Host check on read routes).

### Ticket: T392 ∥ The chat shows what the agent is doing
- **Priority:** P1
- **Status:** Done
- **Owner:** worker
- **Scope:** While an agent works, the chat shows only "Claude is working…": you can't tell whether it is reading, editing or running tests. The daemon already records each ACP tool call (`tool_call` events: kind, title, status) and the feed pushes them live.
- **Acceptance Criteria:** During a turn the chat shows the agent's latest steps live (kind icon, title, status); after the turn a folded "N steps" row sits before the reply and expands to the list; titles are clipped, nothing raw; a daemon read gives a node's steps without scanning the whole log each time.
- **Validation Steps:** `bun test packages/ui packages/daemon/src/http.test.ts`; a control-room e2e with a scripted fake agent; the whole control-room e2e and the walkthrough.
- **Notes:** Branch T392-agent-steps. `feed/steps.ts` `StepIndex` folds `tool_call` events once and then tails `events.jsonl`; `GET /api/streams/:id/steps` → `{steps, total}` (300 newest). `lib/steps.ts` merges live events and groups steps into turns. The live block keeps `data-testid="thinking"`; a finished turn shows "Worked through N steps · 1 failed" inside its reply. Scrolling up is never moved by new steps. control-room 74/0 (run twice), walkthrough green.

### Ticket: T393 ∥ Review the diff with the agent
- **Priority:** P1
- **Status:** Done
- **Owner:** worker
- **Scope:** The Changes tab shows the diff, but feedback on it means retyping file names and lines in the chat.
- **Acceptance Criteria:** A line's gutter offers Comment; comments collect in a review bar ("3 comments"); "Add to message" puts one formatted message (path:line, the line, the comment) in the node's composer and opens the chat; comments survive tab switches and clear when sent.
- **Validation Steps:** `bun test packages/ui`; a control-room e2e; the whole control-room e2e and the walkthrough.
- **Notes:** Branch T393-diff-review. `lib/review.ts` (store and `formatReview`, capped at the thread's 800 characters: quotes shorten, then drop); comments inline like GitHub's with Edit and Delete (Undo), outdated ones kept with the old line; keyboard: each file one Tab stop, ↑/↓ lines, `C` comments. `lib/markdown.ts` now keeps an indented line in its list item, continues an interrupted numbered list and reads double-backtick code spans. control-room 74/0, walkthrough green.

### Ticket: T394 ∥ Resilience and load: error boundaries, code-split views, service-worker notifications
- **Priority:** P1
- **Status:** Done
- **Owner:** worker
- **Scope:** One component throwing blanks the whole cockpit (no error boundary); the app ships as one 590 KB script; notifications can't show on Android or an installed iOS app (they need the service worker).
- **Acceptance Criteria:** Each view and a node page's tab body sit in an error boundary with a card in words (Try again, Reload, Copy details) that resets on navigation; the heavy views load on demand with a quiet fallback and the main chunk shrinks (no Vite size warning); notifications go through `registration.showNotification` when a worker is active, with clicks focusing the tab on the node, and fall back to `new Notification`.
- **Validation Steps:** `bun test packages/ui`; the installable e2e; new e2e for the boundary; the whole control-room e2e and the walkthrough.
- **Notes:** Branch T394-resilience (worker), merged. `ErrorBoundary.tsx` (page, tab, overlay, app) with `lib/boundary.ts`; a failed chunk download reads "A new version of the cockpit is available". Knowledge, Settings, the lenses, the Director, New project, DiffView and ProjectOverview load on demand (`lazyNamed`); React is its own chunk; the rest are warmed 1.5 s after load. The main file went from 591 KB (175 KB gzip) to about 359 KB (108 KB gzip); no Vite warning. The daemon serves `assets/` as immutable. A deep link to a lazy view preloads it before the first render (Settings' `section` survives). Notifications go through the worker when one is active, and `sw.js` handles `notificationclick`. New e2e: the page, tab and chunk-failure cards, and the fallback without a worker; T388's test runs through the worker. Two flaky tests fixed on the way (T388's close check, T367's Permissions race). Deferred items are in the follow-ups.

### Ticket: T395 Rows say when they last changed; j/k in the tree
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** The Overview's and Running's age is the node's creation time (the row has no last-change time); the rail's keyboard walk is arrow keys only.
- **Acceptance Criteria:** The cockpit row carries `updated_at` (the latest of the node's creation and its agent's last change); the Overview and Running say "updated 3m ago" and sort within a group by it; `j`/`k` move through the rail like ↓/↑ when it has focus.
- **Validation Steps:** `bun test packages/ui packages/daemon/src/feed/snapshot.test.ts`; the overview and rail e2e.
- **Notes:** Branch T395-updated-and-jk. `StateStore.threadUpdatedAt` keeps each thread's last line time from appends, else the file's mtime (read once); the row's `updated_at` is the latest of creation, the agent's last status and that. Running has an Updated column (hidden on a phone) and sorts most recent first within a rank; the Overview does the same within a group. The shortcut list names J/K for the tree.

### Ticket: T396 Two starts at once give one agent
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** From the follow-ups (pre-existing race): "one agent per node" was checked before the async work of a start (worktree, spawn), so a wake and a click, or a line with `start` and a click, could both pass it and start two agents on one node.
- **Acceptance Criteria:** Starts are serialized per node and slot (worker and coordinator share one): a second start waits for the first, then is refused as busy; a wake or a line with `start` skips quietly while a start is in flight.
- **Validation Steps:** `bun test packages/daemon/src/attach/service.test.ts -t T396` (fails on the old code: two sessions); the attach, events and coordination suites.
- **Notes:** Branch T396-one-agent-per-node.

### Ticket: T397 A clone that times out stops its ssh too
- **Priority:** P3
- **Status:** Done
- **Owner:** manager
- **Scope:** From the follow-ups: a clone past its timeout killed git but could leave its ssh child running (git wasn't in its own process group).
- **Acceptance Criteria:** git runs in its own process group; the timeout's SIGTERM and SIGKILL go to the group.
- **Validation Steps:** `bun test packages/daemon/src/store/clone.test.ts` (the timeout test fails on the old code: the "ssh" ran on).
- **Notes:** Branch T397-clone-group-kill.

### Ticket: T398 `agile stream archive` stops the node's agent first
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** From the follow-ups: the RPC `stream.archive` (`agile stream archive`) hid a node without stopping its sessions, so an agent could run on a node nobody sees; the cockpit's Delete stops them.
- **Acceptance Criteria:** `stream.archive` stops the node's live sessions (detached) before archiving it; an unknown node stops nothing. What it archives is unchanged (the node, not its subtree, as before).
- **Validation Steps:** `bun test packages/daemon/src/streams/rpc.test.ts`; CLI `stream.e2e` and `daemon.e2e`.
- **Notes:** Branch T398-archive-stops-agents. Whether the CLI archive should take the subtree like the cockpit's Delete stays open.

### Ticket: T399 The Director's chat shows its steps
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** From the follow-ups: the Director's tool calls were indexed (T392) under its own id but its page never showed them.
- **Acceptance Criteria:** `GET /api/director/steps` returns the Director's steps, as a node's route does (503 without a Director); `/api/director` says how long the thread is (`thread_total`), so a cut thread keeps its oldest reply's steps out. The Director page folds each reply's steps before it, shows the running turn's live under "Director is working", and folds steps after the last reply at the end. `useSteps` takes the read to use.
- **Validation Steps:** `bun test packages/daemon/src/http.test.ts -t T399`; control-room e2e `T399` (the fold before a reply, and a step pushed after it).
- **Notes:** Branch T399-director-steps.

### Ticket: T400 A running reviewer is named in the live block
- **Priority:** P3
- **Status:** Done
- **Owner:** manager
- **Scope:** From the follow-ups: while only a reviewer ran, the chat's live block said "Claude is working" under the idle worker's name.
- **Acceptance Criteria:** With the worker idle and a reviewer running, the block reads "<reviewer's vendor> is reviewing"; with the worker running it still names the worker.
- **Validation Steps:** `bun test packages/ui/app/lib/chat.test.ts`.
- **Notes:** Branch T400-reviewer-working.

### Ticket: T401 Effort only where the vendor uses it
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** From the follow-ups: a Gemini session read "Gemini default model · low" though only Claude's adapter maps an effort level (D12); the pickers offered a level that is never sent.
- **Acceptance Criteria:** `EFFORT_VENDORS` in `packages/shared` names the vendors with an effort mapping, and a daemon test keeps it equal to the provider registry's. Labels drop the level for any other vendor (the tooltip says "(ignored)"); the Effort control is disabled there, and says why.
- **Validation Steps:** `bun test packages/ui packages/daemon/src/attach/resolve.test.ts`; control-room e2e `T379` (picking Gemini disables Effort; the label reads "Gemini default model").
- **Notes:** Branch T401-effort-where-used.

### Ticket: T402 A model belongs to its vendor
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** From the follow-ups: `resolveSessionDefaults` took the first named model at any step, so a repo set to Gemini with a Claude model in the home config started Gemini with `claude-sonnet-4-6`, and Settings showed that model as the repo's inherited placeholder.
- **Acceptance Criteria:** Per D40, a step's model counts only when that step runs the resolved vendor; otherwise the vendor's own default (the built-in model for Claude). The Settings and picker placeholders name what an empty model field inherits for the vendor picked there.
- **Validation Steps:** `bun test packages/shared/src/session-defaults.test.ts`; control-room e2e `T379` (picking Gemini makes the placeholder "inherit (Gemini default model)").
- **Notes:** Branch T402-model-follows-vendor. D40 is to confirm.

### Ticket: T403 A Needs me card opens the chat
- **Priority:** P3
- **Status:** Done
- **Owner:** manager
- **Scope:** From the follow-ups: a Needs me card for something on a project root opened the root on its Overview, one click short of the card (at the end of its chat).
- **Acceptance Criteria:** A card's Open goes to its node's chat, root or not; the tree and a deep link still open a root on its Overview.
- **Validation Steps:** control-room e2e `T387`.
- **Notes:** Branch T403-card-opens-chat. The shell's `select(id, {tab})` carries the tab; the page reads it when it opens.

### Ticket: T404 A connect doesn't re-read the event log
- **Priority:** P3
- **Status:** Done
- **Owner:** manager
- **Scope:** From the follow-ups: every `/ws` connect read and validated the whole `events.jsonl` to send its newest 200 events.
- **Acceptance Criteria:** `RecentEvents` holds the newest events up to the tailer's offset: the log is read once when the server starts, then each tailer batch is added. A connect's snapshot comes from it, so a line is still either in the snapshot or published afterwards, never both. With a corrupt log each connect reads it and is refused, as before. `/api/snapshot` is unchanged.
- **Validation Steps:** `bun test packages/daemon/src/feed/snapshot.test.ts packages/daemon/src/http.test.ts` (the log is read once across two connects); feed e2e.
- **Notes:** Branch T404-snapshot-ring.

### Ticket: T405 The live block says how long the turn has run
- **Priority:** P3
- **Status:** Done
- **Owner:** manager
- **Scope:** From the follow-ups: while an agent works, nothing said for how long, so a stuck turn looked like a busy one.
- **Acceptance Criteria:** "Claude is working · 1m 12s" on a node and on the Director, from your line that woke the turn or its first step, whichever came first; it ticks each second without re-rendering the chat; the timer sits outside the live region, so a screen reader isn't read every second.
- **Validation Steps:** `bun test packages/ui/app/lib/steps.test.ts`; control-room e2e `T392`.
- **Notes:** Branch T405-turn-timer.

### Ticket: T406 The repo list doesn't block on git
- **Priority:** P3
- **Status:** Done
- **Owner:** manager
- **Scope:** From the follow-ups: `GET /api/repos` ran up to three synchronous git calls per repo to name its main branch, blocking the daemon's event loop for every open page that lists repos.
- **Acceptance Criteria:** The route resolves each repo's main branch asynchronously, in parallel with its remote, with the same answer as `resolveMainBranch`.
- **Validation Steps:** `bun test packages/daemon/src/store/rpc-methods.test.ts packages/daemon/src/http.test.ts`.
- **Notes:** Branch T406-main-branch-async.

### Ticket: T407 A repo's events page like the log
- **Priority:** P3
- **Status:** Done
- **Owner:** manager
- **Scope:** From the follow-ups: `GET /api/repos/:name/events` (T245) capped at 200 with no paging, unlike `/api/events` (T383).
- **Acceptance Criteria:** The route is `/api/events?repo=<name>` under its own path: `{events, more, total}`, `before` and `limit`, the same 400s in words.
- **Validation Steps:** `bun test packages/daemon/src/http.test.ts -t T407`.
- **Notes:** Branch T407-repo-events-paged. The response gains `more` and `total`; `events` is unchanged.

### Ticket: T408 Add repository loads when opened
- **Priority:** P3
- **Status:** Done
- **Owner:** manager
- **Scope:** From T394's report: `AddRepo` sat in the main script because New node (always mounted, for `n`) imported it statically.
- **Acceptance Criteria:** New node renders `AddRepoDialog` only while it is open, loaded on demand and warmed after the first screen; the main script shrinks; the flow is unchanged.
- **Validation Steps:** control-room e2e `T408` (new: New node → Add a repository… adds the repo and picks it; opened again, it starts fresh), `T367`, `T373`.
- **Notes:** Branch T408-addrepo-lazy. Main script 359 KB → 337 KB (108 → 101 KB gzip).

### Ticket: T409 The shell keeps a screen's own URL params
- **Priority:** P3
- **Status:** Done
- **Owner:** manager
- **Scope:** From T394's report: the shell's URL sync rewrote the query to its own params (`node`, `view`, `project`) even when nothing moved, so a lazily loaded screen reading its own param (Settings' `section`) could lose it on load.
- **Acceptance Criteria:** A rewrite that stays on the same view and node keeps every param the shell doesn't own; moving to another view drops them.
- **Validation Steps:** `bun test packages/ui/app/lib/shell.test.ts`; control-room e2e `T348|T367|T394`.
- **Notes:** Branch T409-shell-keeps-screen-params.

### Ticket: T410 A Merge card says how much it merges; View changes opens the changes
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** A "Ready to merge" card gave no sense of the change's size, and its View changes button opened the node's chat, not its Changes tab.
- **Acceptance Criteria:** The row carries `diff_stat` (files, lines added and removed) for a finished node with commits to merge, measured by the T380 check off the frame's path (`git diff --shortstat target...branch`: committed work only), with a re-push when it changes. The card shows "2 files +2 −1", with the words on hover. View changes opens the Changes tab.
- **Validation Steps:** `bun test packages/daemon/src/delivery/service.test.ts packages/daemon/src/feed/merge-state.test.ts packages/ui/app/lib/inbox.test.ts`; control-room e2e `T347`.
- **Notes:** Branch T410-merge-card-diff.

### Ticket: T411 How full the agent's context is
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** Vendors report their context window in `usage_update` (tokens used of its size; `design/spike-findings.md`'s raw reports), and the runner dropped it, so nothing said when a long session was near its limit.
- **Acceptance Criteria:** The runner keeps each session's last reading in memory (no stored state, no writes); `AttachService.contextFor(session)` reads it; the frame's `live_agent.context` carries it. The composer shows a small ring and the share by the live model chip ("23%", the numbers on hover), amber from 75%, red from 90%; Running shows it by each live agent. A vendor that reports nothing shows nothing.
- **Validation Steps:** `bun test packages/daemon/src/runner/context-usage.test.ts packages/ui/app/lib/chat.test.ts`; control-room e2e `T392` (a fake agent's `usage_update` reads "23%").
- **Notes:** Branch T411-context-meter. Cost (`usage_update.cost`) is not shown: whether it is per turn or running is not measured yet.

### Ticket: T412 One verdict on a finished branch
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** Audit round 5, finding 1: a node read "Ready to merge" in the header, the tree and Needs me (with an enabled Merge) while its Delivery panel said "Already merged into main", and while it still waited on a node that hadn't started.
- **Acceptance Criteria:** The T380 merge check also records a branch already in its target (`merged_outside` on the row). A finished work node reads "Already merged" (your move: its card offers Mark as merged) or, with open waits, "Waiting" (its card names what it waits on, links there, and has no Merge). `lib/status.ts` stays the one mapper (legend, Running, Overview follow). The daemon's preflight reports open waits for a direct merge, so the header and Delivery panel agree with `land`.
- **Validation Steps:** `bun test packages/ui packages/daemon/src/feed/merge-state.test.ts packages/daemon/src/delivery/service.test.ts`; control-room e2e `T412`, and the merge/waits e2e.
- **Notes:** Branch T412-one-merge-verdict.

### Ticket: T415 A saved diff comment doesn't take the keyboard back
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** CI failed about half the time on the T393 e2e ("2 comments on 1 file"): after Add, the comment box returned focus to its line a frame later, and on a slow runner that frame came after the next line had focus, so C opened the next comment on the previous file.
- **Acceptance Criteria:** Focus returns to the commented line only when nothing else has it (it fell to the page when the box closed).
- **Validation Steps:** control-room e2e `T393` now holds frames and lets them go after the next line has focus: it fails on the old code with CI's message and passes with the fix.
- **Notes:** Branch T415-diff-focus-race.

### Ticket: T414 Untitled nodes are named by a cheap model (D41)
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** Pete: a node made without a title should get one from a cheap LLM reading its description, not its first line.
- **Acceptance Criteria:** New node sends `auto_title` when you left the derived title as is; the daemon creates the node with that placeholder and, off the create path, asks `claude -p --model haiku` (no tools, so one reply; no MCP servers; a scratch cwd, 30 s timeout; the user's own login) for a title of at most six words, then renames the node unless you renamed or deleted it meanwhile. No CLI, a failed call or an unusable reply leaves the placeholder. Off under `bun test`; `startDaemon({ titleRun })` injects or (`null`) disables it. The dialog says a title will be written for you.
- **Validation Steps:** `bun test packages/daemon/src/streams/titles.test.ts packages/daemon/src/http.test.ts -t T414`; control-room e2e `T204` (New node sends `auto_title` for a derived title).
- **Notes:** Branch T414-auto-titles. A Settings switch to turn it off is in the follow-ups.

### Ticket: T417 Needs me stays in sight in the sidebar
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** Audit round 5, finding 4: Needs me, Director and Knowledge shared the tree's scroll area, so opening a node low in a long tree scrolled Needs me and its count out of the sidebar.
- **Acceptance Criteria:** Needs me, Director and Knowledge sit in a fixed block under New node; Views, the projects and the tree scroll below it, with a line under the block once they have scrolled.
- **Validation Steps:** control-room e2e `audit r5 #4` (40 nodes, the last one open: its row and Needs me are both on screen; fails on the old sidebar).
- **Notes:** Branch T417a-sidebar-pinned.

### Ticket: T413 ∥ The node page in words (audit round 5)
- **Priority:** P1
- **Status:** Done
- **Owner:** worker
- **Scope:** Audit round 5 findings 2, 3, 8, 9, 10, 11, 14, 19, 22, 32, 35 on the node page: the details panel's Children spoke its own status words and left children out; a comment being written jumped to another file; ids, full branches and paths in primary text; system rows and details in the daemon's words; an Activity tab unlike Events; raw enums on the Knowledge tab; "Review changes…" meant starting a reviewer; a tall phone header; long titles wrapping the pills; a Goal card repeating the title; role badges that looked like buttons.
- **Acceptance Criteria:** Children lists every child with `StatusPill` from `nodeStatus` (none on a root); a draft never moves files (its text is added where it was written; Shift in the same hunk makes a range; the footer names the file); branches read as their slug everywhere with the full name on hover and in Copy; system rows and Details in plain words; Activity rows are the Events rows with the routing reason as a chip; the Knowledge tab reuses the Knowledge list row; "Ask an agent to review…"; the phone header about half as tall; a long title truncates with the pills beside it and `titleFromGoal` cuts at a word ≤60 with no "…"; no Goal card on roots or when it repeats the title (the goal moves to Details → About with Edit); role badges are muted text with an icon.
- **Validation Steps:** `bun test packages/ui`; the whole control-room e2e (84/0) and the walkthrough, with the new draft-comment e2e.
- **Notes:** Branch T413-node-page-words (worker), merged. The Activity, Plan, Knowledge and Docs tabs load on demand (main script 339 → 331 KB).

### Ticket: T416 ∥ Needs me, errors and chrome (audit round 5)
- **Priority:** P1
- **Status:** Done
- **Owner:** worker
- **Scope:** Audit round 5 findings 6, 7, 12, 13, 18, 20, 21, 24, 29, 30, 31, 33, 34, 38: a refused merge as a raw toast; nothing said while the daemon was away; a question shown three times; blocked cards with no way to answer; page headers of five shapes; faint text and focus rings under contrast; a palette that knew nothing of the open node or Needs me; a stale link opening nothing; Ready cards repeating a stock sentence; the Director's load failure under an empty state; two path separators; Settings pills that never changed; phone overflow; a first merge with no confirm.
- **Acceptance Criteria:** A refused merge reads "Couldn't merge." with the reason in words and its fix as a button (Ask the agent to rebase / to fix the conflicts / Stop the agent), on the card and under the header, no toast; the daemon away for 2 s disables writes with "Reconnecting to the daemon…", a failed send keeps the draft with Retry; a question reads once (its chat line), the card holds its choices, the composer bar says which it answers; a blocked card has "Reply to unblock…"; A/B and 1/2 pick a choice on a focused card; one `PageHeader` everywhere but node pages; `--text-faint` ≥ 4.2:1, a solid focus ring, dark accent 4.84:1 under white; ⌘K has "This node" (the page's own actions) and "Needs me" groups and a Recent list filled from recent changes; a missing node says so (Restore when deleted); Ready cards show the agent's progress and overlaps; the Director's failed read shows only the error and Try again; "›" as the path separator; Settings shows a notifications pill only when blocked or unavailable, Permissions folded into General; phone tabs fade at the edge, no keycaps on touch; the first Merge asks, with "Don't ask again" per browser.
- **Validation Steps:** `bun test packages/ui` (errors, inbox, palette); the whole control-room e2e (93/0 after the merge) and the walkthrough; full `bun test` 3118/0.
- **Notes:** Branch T416-needs-me-chrome (worker), merged. Left over: Delivery's "Merge refused:" label, the header's Start and Merge while offline, Ask's `a` and a focused card's A (handled with stopPropagation).

### Ticket: T418 A conversation never reshapes the tree (D42)
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** Pete's model: ask a question at any level, as its own thread. Today a repo-less child counted as a part: under a work node it made the node coordinating and restarted its agent as a coordinator; under a coordinator it waited for the plan and asked the coordinator first.
- **Acceptance Criteria:** `partsOf` / `isConversationNode` in shared; `nodeRole` counts parts only; a root gets its coordinator only for parts; `waitingForPlan`, coordinator-first and Needs me's "has parts" leave conversations out; a conversation under a non-conversation sends no `child_status`; "+ Repo" on a conversation with tangents makes it work in place.
- **Validation Steps:** `bun test` (0 fail; new D42 tests in shared, attach, coordination, inbox, producers, repo-in-place), the walkthrough.
- **Notes:** Branch T418-conversations-never-parts. Tests that built parts without a repo now give them one.

### Ticket: T419 Ask from anywhere (D42)
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** Pete: asking a question at the level you choose (the Director, the project root, a coordinator, the developer on a ticket) should not mean New node's five fields, and the question should read as what you asked, not a goal.
- **Acceptance Criteria:** `a` (or "Ask about this…" in a node's ⋯ menu) opens one box aimed at the open node, or the Director elsewhere; a picker re-aims it at any node or the Director; Enter asks (Shift+Enter a new line). About a node: a conversation under it, named for you (D41), its agent started with the question, opened on its chat. About the Director: a line in its thread. A conversation's chat opens with its question as your message; it never shows the Goal card (its question stays editable in Details).
- **Validation Steps:** `bun test packages/ui/app/lib/ask.test.ts`; control-room e2e `T419` (two tests) and `T385`.
- **Notes:** Branch T419-ask. The palette entry and the `?` sheet line come with T416's palette and shortcut work.

### Ticket: T420 A conversation knows what it was asked about (D42)
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** A question asked under a node got only that node's title and goal in its brief, so "what is the developer on this ticket doing?" couldn't be answered; and its goal read as a task.
- **Acceptance Criteria:** A conversation's brief opens with "The human asked:" and the question quoted, then "What you were asked about": the parent's goal, state and last progress, repo, branch and worktree (to read, never to change), its status card, its parts with their state, its plan (owners by title) and its newest dozen lines; it answers here, and its conclusion reaches the parent only when the human sends it. A coordinator's "Your children" lists its parts only (D42).
- **Validation Steps:** `bun test packages/daemon/src/runner/brief.test.ts packages/daemon/src/attach/service.test.ts -t T420`; full `bun test`.
- **Notes:** Branch T420-parent-context.

### Ticket: T421 Send to parent (D42)
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** What a side conversation concludes ("the plan should change", "stream the file") had no way to reach the node it was about, except retyping it there.
- **Acceptance Criteria:** On a conversation under another node, each agent reply has "Send to <parent>" and the ⋯ menu "Send to <parent>…" (starting from the last reply). The box is editable; Send posts `POST /api/streams/:id/send-up`: your line on the parent ("From the conversation “…”:" then the words), through the same path as the parent's composer (its agent reads it, or starts on it), and a "Sent to …" row on the conversation. A root has nothing above it (400); same-origin only.
- **Validation Steps:** `bun test packages/daemon/src/http.test.ts -t T421 packages/ui/app/lib/chat.test.ts`; control-room e2e `T421`.
- **Notes:** Branch T421-send-up. A coordinator acts on it at its autonomy level, as on any line of yours.

### Ticket: T422 Turn into work (D42)
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** Pete: when a question concludes that something should be built, it should be built right there, in that node. "+ Repo" made a conversation work in place, but its goal was still the question and nothing told its agent to start.
- **Acceptance Criteria:** On an open conversation, ⋯ "Turn into work…" opens one box: the goal, drafted from the conversation by the cheap model (D41's call) when there is one, else its last reply, else its question, always editable, the hint saying which; a repository picker whose first choice is "No repository" (research: the goal is what it finds out). Start the work: the goal is updated (a "Goal changed" line), the repository added in place (branch, worktree, the live agent restarted in it), and your line "Now work on the goal above…" starts its agent. `POST /api/streams/:id/draft-goal` returns `{goal, from: model|reply|question}`, same-origin only; a failed model call falls back.
- **Validation Steps:** `bun test packages/daemon/src/streams/titles.test.ts packages/daemon/src/http.test.ts -t T422`; control-room e2e `T422`.
- **Notes:** Branch T422-turn-into-work. `START_ON_GOAL` lives in shared, so the cockpit and the tests say the same line.

### Ticket: T423 ∥ One model picker; the root's autonomy panel (audit round 5)
- **Priority:** P1
- **Status:** Done
- **Owner:** worker
- **Scope:** Audit round 5 findings 5 and 15. The composer's model chip opened a blocking "Start the agent" dialog that started the agent at once, with a free-text model field; the same choice had four more entry points under four labels; Settings → Agents showed raw values with a Save per row. A root's Details had two lowercase autonomy dropdowns (one without a hint) that saved on change, Run included, and a Save per field.
- **Acceptance Criteria:** The chip opens a popover of models by name grouped by vendor (Default and Running tags, "Other model…", Effort only where the vendor takes it); picking starts nothing; Send starts the agent with the pick, restarts a live one on another model (stop, then `say {start, session}`), or just sends; the hint says which. `StreamSayInputSchema.session` (`SessionFlagsSchema`, strict; refused without `start`). One **Start with…** in the header's split button; the ⋯ and Details model items are gone. Settings → Agents by name ("Inherits Claude Opus 5.5"), saved on change through a queue. The header's Start, Stop and Merge are off while the daemon is away. One **Autonomy** group (Coordinator; Director on a root), capitalised with the Director panel's words, "Inherits Advise from the project"; a change up to **Run** asks first; the Project group (repos, tracker "None") has one **Save changes**.
- **Validation Steps:** `bun test` (3161/0 on the integrated tip); control-room e2e (96/0); the walkthrough.
- **Notes:** Branch T423-model-picker (worker), merged. Model names from `KNOWN_MODEL_IDS` (served as `known_models`).

### Ticket: T424 ∥ Overview counts, the tree's marks, Dependencies and Running (audit round 5)
- **Priority:** P2
- **Status:** Done
- **Owner:** worker
- **Scope:** Audit round 5 findings 16, 17, 23, 36, 37: Overview chips that counted other statuses than the list under them; roots and coordinators that never ran reading "Idle"; an overlap mark in the Blocked triangle that named no one and did nothing; a draggable tree with no grip; two status styles in Dependencies; a Running Node column truncated beside slack.
- **Acceptance Criteria:** Each Overview chip counts one status key with that key's dot and word, from the same grouping as the list (Your move · In progress · Not running · Finished, folded), a chip filters to its rows; `never_started` for any open node without a worker or coordinator session (a root or a coordinator reads "Not started"); the overlap mark is a neutral two-squares button naming the other node and files, opening it (a menu for several; a folded parent speaks for the node inside); a grip and `cursor: grab` on row hover (not on touch), the legend and the `?` sheet say "Drag a row to move it (or ⋯ → Move to…)"; Dependencies uses `StatusPill` on both sides; Running sizes Status to its pill, gives Node `minmax(280px, 2fr)`, follows the rail's project filter and drops the project from paths when filtered.
- **Validation Steps:** `bun test` (snapshot never_started tests); control-room e2e (the chips, the overlap button, Dependencies, Running's filter, the grip); the walkthrough.
- **Notes:** Branch T424-overview-tree (worker), merged. Running now follows the rail's "Show only this project". Left: the Repos lens rows still show plain status text.

### Ticket: T425 Loose ends from T416 and T419
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** Delivery read "Merge refused: merge refused: …"; `a` opened Ask on top of a focused card's choice; Ask had no palette entry or `?` line; a branched-off tangent's title was its first 80 characters.
- **Acceptance Criteria:** Delivery says "Couldn’t merge." (or "Check failed.") and the reason in words (`mergeRefusal`); Ask's key yields to a handler that took it; ⌘K "Ask a question…" (A) opens Ask aimed at the open node, else the Director; the `?` sheet lists A; a tangent's title is `titleFromGoal` of its question, then named by the cheap model (D41).
- **Validation Steps:** `bun test packages/ui`; control-room e2e `T368` (palette), `T332`, `T419`, `T416`.
- **Notes:** Branch T425-leftovers.

### Ticket: T426 Forms that check as you type (audit round 5)
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** Audit round 5 findings 25, 26, 27, 28: New project's duplicate-name error came after submit, under the repo list, and its "Add a repository…" row hid below the list's scroll edge; the repo picker ignored typing; the diff comment box took Ctrl+Enter where everything else takes Enter, and "Changes 1" read as one file; knowledge you wrote needed your own acceptance.
- **Acceptance Criteria:** A taken project name (ignoring case, the daemon's rule) shows under Name as you type and Create waits; "Add a repository…" is pinned below the scroll; a picker without a search box takes type-ahead (`typeAheadMatch`: prefix, then substring; a repeated letter cycles) and Enter picks; in a diff comment Enter adds, Shift+Enter is a new line (Ctrl+Enter still adds), the hint says so, and the Changes count carries a comment glyph and "n review comments not sent yet"; Add knowledge's primary is **Add** (create, then accept; a refusal leaves it proposed with the reason), with **Save as proposal** secondary; a checked rule without its two examples can only be saved as a proposal.
- **Validation Steps:** `bun test packages/ui/app/lib/tree.test.ts`; control-room e2e `T393`, `T367`, `T373`, the knowledge tests; the walkthrough (its 6.2 and 7 steps use Save as proposal, then Accept).
- **Notes:** Branch T426-forms. LIVE-CHECKLIST names Save as proposal.

### Ticket: T427 What a worker proposes next is one click from a node
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** Pete: agents should be able to spawn their own children and work autonomously. Coordinators (at Organise/Run) and the Director already create nodes; a worker's `propose_next` only left a "Proposal" line with nothing to act on, so its follow-up work had to be retyped into New node.
- **Acceptance Criteria:** A `propose_next` line ("next: <title> — <goal>", by an agent) shows **Create node…**, which opens New node with that title and goal (editable), under the proposing node; other proposal lines keep what they had (T205's Add <repo>). The verb's description tells the agent when to use it and what the human sees.
- **Validation Steps:** `bun test packages/ui/app/lib/chat.test.ts packages/shared`; control-room e2e `T427`, `T205`.
- **Notes:** Branch T427-proposed-next.

### Ticket: T428 A picker's name outlasts its sub-label
- **Priority:** P3
- **Status:** Done
- **Owner:** manager
- **Scope:** Found in the T422 screenshot pass: on a phone, Turn into work's repo picker cut "No repository" to "No r…" to keep its long sub-label whole (a zero flex basis on the name).
- **Acceptance Criteria:** A pick option's name takes its width first and the muted sub-label truncates before it; the research option's sub-label reads "Research, no branch".
- **Validation Steps:** Screenshots at 390px, light and dark; control-room e2e `T422`, `T365`.
- **Notes:** Branch T428-picker-sub.

### Ticket: T429 Replies you haven't read
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** Pete: questions have to work in flow state. You ask (D42) and go back to your work; when the answer lands nothing said so. A conversation's, a root's or a coordinator's finished turn has no Needs me card (T336, T341), so the only sign was a dot changing colour in the rail.
- **Acceptance Criteria:** A node that answered (open, agent done, not a work node) is unread until its page is open in a visible tab, read up to its row's `updated_at`; per browser (localStorage `agile.seen`, capped at 400 marks, other tabs follow); a first visit starts with everything read. Needs me lists unread replies first ("Replies": path › title, "Replied · 3m", ✓ Mark read, Mark all read; a click opens the chat); with nothing else waiting it reads "Nothing else waits on you". The sidebar's Needs me shows a dot ("2 replies to read"). A reply that lands while you're away raises one notification ("Replied: <title>", click opens it) when notifications are on.
- **Validation Steps:** `bun test packages/ui/app/lib/unread.test.ts`; control-room e2e `T429` (95/0 whole file); the walkthrough; screenshots light, dark, phone.
- **Notes:** Branch T429-unread-replies. Pure rules in `lib/unread.ts`, the store and hooks in `lib/use-unread.ts`. The rail's own unread mark waits for T424 (it owns `StreamTree.tsx`).

### Ticket: T430 A README for the app
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** The README was one line. Someone opening the repo couldn't tell what the app is, how to install and start it, or where to read more.
- **Acceptance Criteria:** README.md says what the app does (roles, Needs me, Ask, coordinators and autonomy, the chat, knowledge, delivery, the Director, trackers), what it needs, how to install, start and set up a first project, the keys, a short CLI tour, where state lives and the session default order (P5, D40), the development commands and the package layout, and links the design docs. Every claim checked against the code or the design.
- **Validation Steps:** `bun run lint`; read through against `agile` usage, `DEFAULT_DAEMON_PORT`, `resolveSessionDefaults` and projects-design §12.
- **Notes:** Branch T430-readme.

### Ticket: T431 Turn into work's goal is yours while it drafts
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** Timed on the demo: the goal draft (one Haiku call) takes about 6 s, and the Goal box was disabled until it came back.
- **Acceptance Criteria:** The Goal box is editable at once ("Drafting from the conversation…" as its placeholder, "…or write your own" as its hint). The draft fills it only if you haven't typed; otherwise the hint says a draft is ready, with **Use it instead**. Start waits only for a non-empty goal.
- **Validation Steps:** control-room e2e `T422` (a held draft request: typing survives it, Use it instead swaps it in); a screenshot of both states against the real model.
- **Notes:** Branch T431-draft-while-typing.

### Ticket: T432 A vendor that fails says so (D43)
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** Probed the first run with a broken vendor. A vendor that exits on a login error ("Invalid API key · Please run /login", exit 1) left the node `done`, so it read as finished work ("Ready to merge", or "Replied" for a conversation), and the thread said only "process exited (code 1)"; the reason sat in the sessions strip. A vendor whose command isn't installed said "ACP initialize failed: ACP agent stdin unavailable".
- **Acceptance Criteria:** A non-zero exit that isn't the daemon's own stop (`stop()`, a detach, a stop reason) or the end after a finished turn leaves the node `blocked` and its session `error`, starts no auto-review, and its thread line reads `session ended: process exited (code N): <the vendor's last stderr line>`; the chat shows it as a warning ("The agent stopped with an error: … Check its vendor is installed and logged in, then send a message to start it again."). A clean exit (code 0) and every stop of the daemon's stay as before. A vendor command missing from the daemon's PATH fails the start with "<Vendor> can't start: `<command>` is not on the daemon's PATH." (npx adds "install Node.js"), written on the thread as "could not start the agent: …".
- **Validation Steps:** `bun test packages/daemon/src/attach/service.test.ts -t T432 packages/ui/app/lib/chat.test.ts`; full `bun test`. Tests that ended a session by killing its process from outside now end it through the daemon's `stop()`, as the daemon does.
- **Notes:** Branch T432-vendor-failures. `AgentExitInfo.exitCode`; `missingVendorCommand` in `runner/session.ts`.

### Ticket: T433 Unread marks in the rail, and the Director's replies
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** T429's follow-ups: the rail (T424 owned it then) didn't mark a node with an unread reply, and a Director reply (you asked it with `A`, then went back to work) marked nothing.
- **Acceptance Criteria:** A rail row with an unread reply has a bold title and a blue dot (`data-unread`). The frame carries `director.replied_at` (`StateStore.directorReplyAt`: the Director's last line of its own, cached from appends, read from its thread once); a newer reply than your read mark puts a dot on the sidebar's Director, heads Needs me's Replies ("The Director · Replied · 2m", Mark read, and Mark all read), and notifies while you're away ("The Director replied"); the Director's page on screen reads it.
- **Validation Steps:** `bun test packages/ui/app/lib/unread.test.ts packages/daemon/src/store/store.test.ts -t "T433|T395"`; control-room e2e `T429`, `T433`.
- **Notes:** Branch T433-unread-marks.

### Ticket: T434 An off switch for quick drafts
- **Priority:** P3
- **Status:** Done
- **Owner:** manager
- **Scope:** Deferred from T414: the cheap model call behind untitled nodes' titles (D41) and Turn into work's goal draft (T422) had no off switch.
- **Acceptance Criteria:** `quick_drafts: false` in the home's config.yaml (strict schema; absent = on) turns both off, read per call so it holds at once. `GET/POST /api/settings/quick-drafts` (`{on}` in, `{on, available}` out; same-origin; 400 on a bad body). Settings → General → **Quick drafts**: a switch with what it does and what off means; "Not available" (disabled, with the reason) when the `claude` command isn't on the daemon's PATH.
- **Validation Steps:** `bun test packages/daemon/src/http.test.ts -t T434 packages/daemon/src/daemon.test.ts -t T434`; control-room e2e "General picks the theme…".
- **Notes:** Branch T434-quick-drafts-switch.

### Ticket: T437 Audit r6: failed starts, vendors, caps, and what counts as needing you
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** Audit round 6's daemon-side findings (the integrated app, D42 flows). A start that failed before the vendor ran (its command missing, the spawn throwing) left the node `working` with a `starting` session no Stop could end. The picker offered vendors that couldn't start. A pasted message over 800 characters was refused. A done node with its own branch and parts lost its Merge card. A plan waiting on approval, or a gate, read as "Working". A conversation node "replied" whenever its agent spoke, even when nobody had asked.
- **Acceptance Criteria:** (1) A vendor whose command isn't on the daemon's PATH is refused before any session is recorded: the node goes `blocked`, its progress reads "The agent couldn't start: <reason>", and the error reaches the caller. A spawn that throws ends its session `error` with the reason and blocks the node the same way. The next start clears either failure line (and T432's "The agent stopped with an error: …"). Stop ends a `starting` session left without a process (`stopped`, node `idle`), never one still starting. (2) Session defaults carry `not_installed` (vendor → reason); the picker tags such a vendor "Not installed" (`data-missing`) and its option reads "(not installed)". The failure card's placeholder says "Fix its login or install, then reply to start it again…". (3) A human line is capped at `HUMAN_LINE_MAX_CHARS` (4000); Send to parent at `SEND_UP_MAX_CHARS` (3000); agent and Director lines keep 16000, the rest 800. (4) A done node with its own repo and branch keeps its Merge card even when it has parts. (5) Frame rows carry `pending_decision` (an open gate, plan approval or proposal in its inbox) and read "Needs you". (6) Frame rows carry `answered_at`: the time an agent, coordinator or Director line followed a human line (a new node's goal is the first question), cached in the store from appends; Replies, the rail's unread marks and notifications key on it, and the Director's `replied_at` follows the same rule.
- **Validation Steps:** `bun test packages/daemon/src/attach/service.test.ts -t T437 packages/daemon/src/store/store.test.ts -t "T437|T433" packages/daemon/src/http.test.ts -t T437 packages/daemon/src/inbox/service.test.ts -t T437 packages/ui/app/lib`; control-room e2e `T429`, `T433` (the Director answers a human line); full `bun test` 3176/0, control-room 97/0, walkthrough clean.
- **Notes:** Branch T437-failed-starts. D36's D10 wake (an agent's line wakes an idle parent) is Pete's decision and stays. The UI halves of findings #2 (a counter on the Send dialog) and #3 (where the work goes) are T435's; Details' ended reason and the empty-chat hero are T438's.

### Ticket: T435 Conversation flows (audit r6)
- **Priority:** P1
- **Status:** Done
- **Owner:** worker (manager reviewed)
- **Scope:** Audit round 6's conversation findings: #2 (Send to failed on real replies), #3 and #14 (Turn into work or Create node… under a work node made it a coordinator, its Merge card gone), #6 (a drafted goal that was the model talking), #7 (typing then Enter in a picker picked the pinned option), #10 ("Today" twice), #12 (two submit keys), #13 (Turn into work's repo list ignored the project), #16 (an answered conversation offered only Restart), #19 (Send to a merged parent), #20 (Ask's picker without status, focus lost), #26 (a proposal as the raw verb), #27 (a turned conversation kept its question as title).
- **Acceptance Criteria:** Send to counts down from 85% of `SEND_UP_MAX_CHARS`, blocks past it ("Shorten it, or send the key point."), and puts errors in words (`sendUpFailure`). Under a work node, Turn into work asks **Where** (Next to <parent>, the default, moves it up first; Under <parent> says it will coordinate) and points to Send to; Create node… on a proposal defaults to a sibling on the proposer's repo; New node and ⋯ Add repository… say the consequence. `draftedGoal` rejects a question, a draft talking to you, a list, over 600 characters or NONE (the prompt's escape). A picker's typed query highlights the first unpinned match (`pickHighlight`). The question sits in the thread's list after "Node created". Send to and Turn into work submit on Enter. Turn into work groups repos as New node does and adds an outside repo to the project. An answered conversation's header offers Send to and Turn into work… (Restart in ⋯). Send to is hidden for a merged or closed parent. Ask's targets carry status dots (finished last) and the new conversation's composer takes focus. A proposal reads "Next: **title**" and the goal. A title that is still the question (or ends in "?") is re-derived from the new goal and named by the cheap model (`update {auto_title}`).
- **Validation Steps:** `bun test packages/daemon/src/streams/titles.test.ts packages/daemon/src/http.test.ts packages/shared/src/stream.test.ts packages/ui/app/lib`; control-room e2e T419, T421, T422, T427 and "where the work goes under a work node".
- **Notes:** Branch T435-conversation-flows. Worker gate: `bun test` 3195/0, control-room 98/0, walkthrough clean. Screenshots light, dark and phone.

### Ticket: T436 Views and polish (audit r6)
- **Priority:** P2
- **Status:** Done
- **Owner:** worker (manager reviewed)
- **Scope:** Audit round 6's view findings: #11 (unsent review comments lost on reload, Merge silent about them), #15 (the status enum and "no progress line" in Events), #17 (Replies said too little), #18 (overlap's alert triangle), #21 (a node's tab not in the URL), #22 (unsaved Project changes dropped), #23 (no "Replied" in the legend), #24 (Details spoke before anything happened), #25 (Settings → Agents order and length), #28 (two primary buttons), #29 (⌘K without replies).
- **Acceptance Criteria:** Review comments and composer drafts are kept per node in `sessionStorage` (`lib/drafts.ts`, every access guarded); leaving with unsent comments asks; Merge asks "N review comment(s) on <node> isn't sent. Merge anyway?" with Add to message. `child_status` reads in status words and carries no stand-in progress. A reply row shows a one-line preview (one page read, cached per reply) and the tree's role glyph. Overlap is neutral everywhere. `&tab=` keeps a node's tab across reload and Back. A root's Project changes are kept per project until saved or cancelled. The legend lists Replied. Details' Delivery badge uses the status word and tone and waits for a branch; the reviewer waits for commits. Settings → Agents: Global, Per project, Per repository, with repositories that set nothing folded. The header's Start is secondary beside an open decision card. ⌘K lists unread replies ("Read reply: …").
- **Validation Steps:** `bun test packages/ui/app/lib packages/daemon/src/events/producers.test.ts`; control-room e2e "views and polish (T436)" and the updated T170, legend and T227 tests.
- **Notes:** Branch T436-views-polish. Worker gate: `bun test` 3227/0, control-room 104/0, walkthrough clean. Screenshots light, dark and phone.

### Ticket: T438 A failed agent reads in words everywhere (audit r6 #4)
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** T437 put the failure on the node's progress; the chat still read "could not start the agent: …" raw, the empty-chat hero ("Tell the agent what to do next") sat under the warning, and Details → Agent showed "process exited (code 1): …" in red for every ended reason.
- **Acceptance Criteria:** A failed start reads "The agent couldn't start: <why>. Fix its install or login, then send a message to start it again." The empty-chat hero is hidden when the thread has a failed start or a non-zero exit (`agentFailed`). Details reads "Stopped with an error: <vendor line>" (red), and a clean end, a finished turn or a stop in grey (`endedReasonText`; the raw reason on hover). Turn into work under a work node with nothing above it offers no "Next to" and says the parent will coordinate it.
- **Validation Steps:** `bun test packages/ui/app/lib/chat.test.ts`; control-room e2e T438, T171.
- **Notes:** Branches T438-turn-edge-empty-hero, T438b-details-ended-reason, T438c-menu-stable-review. T438c: after T436, "Ask an agent to review…" waited on the page's merge check to show, so it could appear in an open ⋯ menu and push the items under it down; the walkthrough's 4.1 clicked "Waits on…" and hit "Add repository…" about half the time (seen in its screenshot). It now shows once the node has a branch, disabled until commits are known: 5 of 5 walkthrough runs clean. Gate on the integrated tip: `bun test` 3233/0, `test:integration` green (control-room 105/0).

### Ticket: T440 LIVE-CHECKLIST §10 and the walkthrough: Ask at any level (D42)
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** The live checklist, and the fake-agent walkthrough that clicks through it, had no step for D42's flows (Ask, Replies, Send to, Turn into work) or for a vendor that fails.
- **Acceptance Criteria:** LIVE-CHECKLIST §10: 10.1 Ask about a new work node (the conversation under it, the question first, focus in its composer, the node still Work); 10.2 the reply in Needs me's Replies with its first line and dots, reading it, Send to the node (its line on the node's chat); 10.3 a question under the project root turned into work in place (a repo, the title following the goal, the question kept). 9.4's "An agent never starts" names the chat's and Details' words and **Not installed**. The walkthrough runs 10.1–10.3 after 9.2 (now "3.4–10"); its rail helpers match titles literally (a `?` or `.` in a title).
- **Validation Steps:** `bun run test:walkthrough`: 0 findings.
- **Notes:** Branch T440-d42-checklist. Writing it found T441.

### Ticket: T441 A conversation turned into work keeps its question
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** Found by T440's walkthrough: a conversation's question lived only in its goal, so Turn into work (a new goal) dropped the question from the chat; the thread read as an answer to nothing.
- **Acceptance Criteria:** The stream record has an optional `question` (strict schema). The update route sets it to the old goal when a conversation's goal first changes (never for a root or work node, never again after); the chat opens with `question ?? (conversation ? goal : none)` after "Node created".
- **Validation Steps:** `bun test packages/daemon/src/http.test.ts -t T441`; control-room e2e T422; the walkthrough's 10.3.
- **Notes:** Branch T441-keep-the-question.

### Ticket: T442 A conversation reads the repos it's asked about (read-only git -C)
- **Priority:** P0
- **Status:** Done
- **Owner:** manager
- **Scope:** Pete, running LIVE-CHECKLIST 3.2 ("Plan this with me before any code… Explain how you would split it"), saw the conversation's agent denied reading the repos: T336 lets only a coordinator's read-only `git -C` leave the worktree, and a conversation's agent is a worker on a node with no repo, so it has no worktree to read from and every `git -C <repo> log` was a worktree escape. D42 says a conversation answers, researches and explains.
- **Acceptance Criteria:** A worker on a node with no repo of its own (`noOwnRepo` on the hook context, set by the hook service; never for the Director) gets the coordinator's read-only `git -C` (T336's allowlist: diff, log, show, status; no config, no pager, no output), only into dirs its read scope allows (not hidden, unregistered or the agile home). Writes stay denied. A worker on a node with a repo, and a reviewer, keep T336's rule.
- **Validation Steps:** `bun test packages/daemon/src/hook` (decide: T442 allow/deny tables; pattern-rules: the hook service end to end); each new test fails with its half of the change reverted.
- **Notes:** Branch T442-conversation-git-reads. The bug exists from Phase 7's T336, but conversations as D42 has them (research at any level) are Phase 14's, so it is fixed here; the other session watching PRs #4–#11 had it noted as open.

### Ticket: T443 Autonomy spawns running work (audit r7 #1, #4, #8)
- **Priority:** P0
- **Status:** Done
- **Owner:** manager
- **Scope:** Audit round 7: no path from a coordinator ended with a running child. `add_child` created nodes idle ("starting stays the human's call"), Apply at Advise too; the Director's `create_tree`/`create_node` made idle trees; coordinators had no `start_node`; a project root ran a worker until it had a part, so "plan this and split it" couldn't add one (`add_child`: only a coordinator can); the Director's drafts for new nodes never reached Needs me. §12 says Organise creates nodes and starts agents.
- **Acceptance Criteria:** A node an applied change creates (a coordinator's `add_child` at Organise/Run, Apply at Advise, the Director's `create_node`) starts its agent off the caller's path (`AutonomyService.run`; `settled()` for tests); a part (it has a repo) under a node whose plan waits for the operator (a draft, or parts waiting) gets the `WAITING_FOR_PLAN` line instead and starts on approval; a conversation child always starts. `create_tree` starts its node's coordinator and its parts wait for that plan (the worked example). `start_node`/`restart_node` take a coordinator for its own children, gated like `add_child`; `start_node` on a running node is `{already: true}`. A project's root (a project, no repo) runs a coordinator from the start and a line to it starts it; a parentless node with its own repo stays a worker. A Director draft that makes nodes sits in Needs me on the node it goes under (or the project's root). Briefs and verb descriptions say so.
- **Validation Steps:** `bun test packages/daemon/src/coordination/autonomy.test.ts -t T443 packages/daemon/src/director/tools.test.ts packages/daemon/src/attach/service.test.ts -t T361`; full `bun test`, control-room e2e, walkthrough.
- **Notes:** Branch T443-autonomy-starts. The UI half of "tell the user" (the Apply card's words, a Needs me item for anything left unstarted) is T446's and T445's.

### Ticket: T444 Sessions a dead daemon left running end at start (audit r7 #16)
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** After a daemon died mid-turn (not a clean stop), its nodes read "Working" for good on restart, Running listed them, Delivery said "still has a live agent", and a line to them only queued; only Stop cleared it (T437's orphan clean-up ran inside `stop()` alone).
- **Acceptance Criteria:** `AttachService.endOrphansAtStart()` runs at daemon start, before `wakePending()`: every `starting`/`running` session on record ends `stopped` with `stopped: the daemon restarted during this turn` (the daemon's prefix, so the node isn't "stopped by the human" and its next event wakes it), the node goes `idle`, and its thread says `session ended: the daemon restarted during this turn`.
- **Validation Steps:** `bun test packages/daemon/src/attach/service.test.ts -t T444 packages/daemon/src/daemon.test.ts -t T444` (the daemon test fails with the call removed).
- **Notes:** Branch T444-orphans-at-start.

### Ticket: T448 First-run nits (audit r7 #24, #25)
- **Priority:** P3
- **Status:** Done
- **Owner:** manager
- **Scope:** Adding a repository left an untracked `.agile-daemon-cache/` in it; `agile init` said nothing about what comes next.
- **Acceptance Criteria:** The cache writes its own `.gitignore` (`*`) once, so `git status` never lists it and nothing of the operator's is edited. `agile init` ends with "Next: `agile daemon start`, then open the cockpit it prints (http://127.0.0.1:4600/ by default)." README says what sits beside your code.
- **Validation Steps:** `bun test packages/daemon/src/subprocess-env.test.ts packages/cli`.
- **Notes:** Branch T448-first-run-nits.

### Ticket: T445 Flow and focus (audit r7)
- **Priority:** P1
- **Status:** Done
- **Owner:** worker (manager reviewed)
- **Scope:** Audit round 7's flow findings: #3 (any repo name in a proposal line grew an "Add <repo>" button that reshaped the node), #5 (after Merge the next card's Merge slid under the pointer), #13 (focus fell to `<body>` after actions), #14 (j/k did nothing outside the rail), #10 (the welcome's Add repository opened Settings → General), #11 (a title "written for you" that wasn't; titles and branches cut mid-word), #12 (New node defaulted to No repository in a one-repo project), #21 (the Plan tab's empty state had no action), #22 (no keyboard path to Rename/Move), #23 (a native select for Add repository…), #26 (a bare root's composer "adds a note").
- **Acceptance Criteria:** "Add <repo>" only on a proposal line whose ref is `repo:<name>` (`repoProposalRef` in shared; nothing writes one yet), never on a root; an autonomy proposal line offers **Decide below**, a contract proposal **See the plan**. A decided Needs me card stays ~1.5 s collapsed to its outcome, and pointer clicks on the list are ignored ~400 ms after one leaves. Focus goes to the next card, the new node's composer, New project after a first repo; dialogs restore focus. Global j/k on a node page walk the tree. The welcome opens Add repository in place and then offers step 2; ⌘K has Add repository…. The Title hint follows quick drafts; `titleFromGoal` cuts at a clause and drops an unbalanced quote; `slugify` cuts at a word. A one-repo project's New node starts on that repo (**Just talk instead**). The Plan tab offers Start the coordinator / Ask it to plan. The header ⋯ has Rename… and Move to…. Add repository… uses the picker and says "Adds a part on <repo>" on a coordinating node. A root's composer points to Ask.
- **Validation Steps:** Worker gate on the merged tree: `bun test` 3258/0, control-room 110/0, walkthrough 0 findings.
- **Notes:** Branch T445-flow-focus.

### Ticket: T447 Honest coordinator status, and scale (audit r7)
- **Priority:** P1
- **Status:** Done
- **Owner:** worker (manager reviewed and merged)
- **Scope:** Audit round 7: #2 (a coordinating node read "Done" while its parts worked; every turn told its parent "done"), #9 (a grey dot for Needs you from a plan or proposal), #15 (60 ms per keystroke on a 324-row thread), #19 (the Overview didn't scale past a few dozen nodes), #20 (the rail cut alike titles to the same text).
- **Acceptance Criteria:** A coordinating node or a root with parts reads as the most urgent of its own and its open parts' states (Needs you > Blocked > Ready to merge > Working > … ), Done only when every part is merged or closed, with "2 of 4 merged · waiting for web part" in its header and Children cards; the Delivery panel reads the node's own status. A coordinator's own `child_status: done` goes up only when its subtree is finished. The dot follows the status (Needs you amber). The composer owns its draft and the chat renders the newest 80 rows with Show earlier (typing 40 chars on 324 rows: ~2.5 s → ~0.3 s). The Overview groups by top-level node, folds finished branches (all past 30 nodes), and filters (`/`); Recent activity uses the Events words. Rail titles truncate in the middle, keeping their last words.
- **Validation Steps:** Gate on the merged tree (with T445): `bun test` 3277/0, control-room green, walkthrough 0 findings.
- **Notes:** Branch T447-status-scale. Merging it with T445 needed a manual resolution of both appending tests at the end of control-room.e2e.test.ts (first attempt dropped T447's edits to T387; caught by the gate, fixed). Follow-up: the "waiting for the plan" item doesn't set `pending_decision`, so its part reads Waiting rather than Needs you.

### Ticket: T446 What the agents did on their own (audit r7)
- **Priority:** P1
- **Status:** Done
- **Owner:** worker (manager reviewed and merged)
- **Scope:** Audit round 7: #6 (a coordinator's or the Director's own changes read as its chat message in the daemon's words, with ids), #7 (no event recorded them; no undo), #17 (a coordinator's chat was mostly its own wake-ups), #18 (two nodes named "api part").
- **Acceptance Criteria:** A coordinator's, the Director's or your applied change is a system row in words with its actor's icon and the node it made linked ("Added a part: **X** (web)", "Created **Newsletter signup** in Blog with 2 parts", "You approved plan v1"); daemon lines meant for the agent are `agent_only`; the contract proposal line has no id; old lines re-read into the new words. The autonomy-proposal card says the level and what Apply does. A record-only routed event `autonomy_applied` (strict; delivery status `recorded`, never pending, so it wakes no one) shows in Events, Activity and the Director's Activity with a link per node and Undo (archive) while nothing it made has started. A coordinator's routine wake folds into its reply's header ("Woke for a merge · 01:14"); a wake with no reply is one muted row. Parts are named "<node> · <repo>" (the rail shows the repo under its node); clashing titles get their project or parent in overlap marks, Events and Needs me.
- **Validation Steps:** Gate on the merged tree (with T445, T447): `bun test` 3309/0, walkthrough 0 findings.
- **Notes:** Branch T446-agent-actions. Merging with T447 needed: rail titles (a part's short name, else T447's middle truncation), MessageList (T447's window plus T446's links), both new chat.test blocks, the checklist paragraph, and the parts line reading a part by its short name ("waiting for ledger-lite"). Follow-ups: the Director's Events rows use the bot glyph; a node-level autonomy override isn't in the frame, so its card can show the project's level.

### Ticket: T449 CI: the Needs me click guard dropped deliberate clicks
- **Priority:** P0
- **Status:** Done
- **Owner:** manager
- **Scope:** CI failed on 2b2b4ed7: "waiting for the plan (T344)" clicked Start parts anyway and the card never left. T445 ignored every pointer click on the Needs me list for 400 ms after a card left; under load the test's click came right after the woken card finished lingering, and was dropped with no sign. A person clicking a different card quickly would lose that click too.
- **Acceptance Criteria:** Only a click within 6 px of the previous one (a double-click, or a second click while the first was slow) is dropped in the settle window; a click aimed elsewhere goes through. Keys are never guarded.
- **Validation Steps:** control-room e2e "T449: a click aimed elsewhere…" fails on the old guard and passes now; T445's "…never slides under the pointer" (its second click now at the first one's spot) still passes and fails with the guard removed; full `bun test` 3310/0.
- **Notes:** Branch T449-steady-list-guard. T449b (branch T449b-events-words-race): the next CI run (fac4e8d8) failed T436's "#15 #18" test, which read an Events row's words once, before the first cockpit frame brought the node's row ("finished" instead of "is ready to merge"); it now waits for the words, in Events and in Activity.

### Ticket: T450 A plan waiting with no coordinator reads Needs you
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** T447's follow-up: the "Waiting for the plan" card (parts wait for a plan and no coordinator is running to write it) is your move, but it didn't set the row's `pending_decision` (T437), so the coordinator and its rolled-up status read Waiting, with no amber dot.
- **Acceptance Criteria:** `plan_waiting` is one of the snapshot's decision kinds: the coordinator's row carries `pending_decision` while the card is up, and reads Needs you in the rail.
- **Validation Steps:** snapshot test "T450: a plan its parts wait for…" (fails without the kind); control-room e2e "waiting for the plan (T344)" checks the rail row reads Needs you; full `bun test` 3311/0; lint and typecheck clean.
- **Notes:** Branch T450-plan-waiting-needs-you.

### Ticket: T451 An applied change's glyph names who made it
- **Priority:** P3
- **Status:** Done
- **Owner:** manager
- **Scope:** T446's follow-up: every `autonomy_applied` row (Events, a node's Activity, the Director's activity, the Overview) showed the coordinator's bot, even for the Director's change or your own Apply.
- **Acceptance Criteria:** `EventGlyph` takes the event: an applied change shows its principal's icon (the Director's sparkles, a coordinator's bot, a person for you); other types are unchanged.
- **Validation Steps:** control-room e2e T446 (a coordinator's row: bot) and T301 (your Create: user; the Director's own create_node at Organise: sparkles); full `bun test` 3311/0; lint and typecheck clean.
- **Notes:** Branch T451-applied-glyph.

### Ticket: T452 A proposal card reads its node's own autonomy
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** T446's follow-up: the cockpit row didn't carry a node's autonomy override, so a coordinator's held proposal on a node set to Organise said "Shop is at Advise" and linked to the project root, while the daemon held it at the node's own level.
- **Acceptance Criteria:** A row carries `autonomy` when its node overrides the project's coordinator level. A coordinator's proposal card names that node and its level, and the link opens the node (where the level is set). A Director's card, and a node that inherits, read as before.
- **Validation Steps:** snapshot test "T452: a node's own autonomy"; control-room e2e "coordinator autonomy (T282)" (after the node's override to Organise, a held restart reads "Show sale prices is at Organise: …" and its link opens the node with Organise selected); full `bun test` 3312/0; lint and typecheck clean.
- **Notes:** Branch T452-node-autonomy-row.

### Ticket: T453 Accepted knowledge wakes only the conversation it came from (D44)
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** Q25 / D44: D36 D10 (T351) woke every finished conversation in an accepted item's scope, up to five per item, each a vendor turn and a reply nobody asked for.
- **Acceptance Criteria:** `knowledge_accepted` carries `source` (the node the item came from, when it has one). A conversation with no live session wakes on it only when it is that node; any other conversation in scope keeps it pending and gets it with its next message. Coordinators, roots and work nodes are unchanged (P11). `WakeFanout` and `KNOWLEDGE_WAKE_FANOUT` are gone (one conversation per item at most).
- **Validation Steps:** `events/wake.test.ts` T453 block; `attach/service.test.ts` "another ended conversation is not woken; your next line brings the item" (fails on the old rule: a second session starts) and "the ended conversation that proposed it is woken"; `knowledge/service.test.ts` checks `source`; walkthrough 6.4b and LIVE-CHECKLIST 6.4b follow (not woken, then read with your next message).
- **Notes:** Branch T453-narrow-knowledge-wake.

### Ticket: T454 Jev decides whether accepted knowledge wakes a conversation (D44 follow-up)
- **Priority:** P3
- **Status:** Done
- **Owner:** worker (manager reviews)
- **Scope:** Behind a config setting (off by default: T453's narrow rule), ask Jev, per conversation in an accepted item's scope, whether to wake it now. The state: the item (kind, text, scope), the conversation's question, its last reply (capped), when it last changed, and whether a newer conversation covers the same ground. The questions: does this decision change the answer given or settle something it left open; is the conversation still current (not moved on from, not covered by a newer one, not too old, not treated as finished). Pete also raised a later step: Jev reviewing threads on its own (e.g. after X minutes idle) to flag stale or settled conversations.
- **Acceptance Criteria:** A `wake_on_knowledge: jev` style setting (Settings and config.yaml). On yes, the conversation wakes as the source does; on no, or Jev unavailable, it waits for its next message. Offline tests use `FakeClassifier`; a real Jev check via `agile rules test` or equivalent.
- **Validation Steps:** Unit tests with `FakeClassifier` for yes / no / unavailable; the setting off keeps T453's behaviour.
- **Notes:** Pete, 2026-09-27: build it, gated behind a config setting in the UI (off by default: T453's narrow rule). Jev calls are cheap (Pete); conversation text goes through the existing scrubber. Branch T454-jev-knowledge-wake (worker; manager reviewed). `knowledge_wake: source | jev` in config.yaml, default `source` (T453). Settings → Classifier → Accepted decisions: "Let Jev decide which conversations hear an accepted decision", disabled with the reason until a TypeSafe key is loaded. With it on, a conversation that didn't propose the item is asked about once per (event, node), off the wake path (`events/knowledge-wake.ts`): state = the item, the conversation's question, last reply, age, status and newer conversations in the project; Nouls `relevant` and `stale` (asked as "stale" because real Jev scored "still current" in the route band for a current conversation). Wakes when relevant is a confident yes and stale a confident no; unsure, unavailable or no key leaves the item for the next message. At most 5 Jev wakes per item; in memory. Real Jev runs: an open related conversation wakes (0.97 / 0.29); one covered by a newer conversation or 30 days old doesn't (stale 0.80); an unrelated one doesn't (0.03). Deferred: `agile daemon status` doesn't show the setting; Jev reviewing idle threads by itself (Pete's later idea).

### Ticket: T455 Agents propose adding a repo to their node (D45)
- **Priority:** P3
- **Status:** Done
- **Owner:** worker (manager reviews)
- **Scope:** T445 left the `repo:<name>` proposal ref with no writer. A conversation's or worker's agent gets a verb to propose a repo for its node (name and why); it writes a `proposal` line with `ref: repo:<name>`, which shows **Add <repo>** in the cockpit. Clicking it runs Add repository in place (T205).
- **Acceptance Criteria:** The verb, validated in `packages/shared` like the others; refused for an unknown repo, the node's own repo, or a project root; the line reads in words; the button is the only way it changes anything.
- **Validation Steps:** Verb unit tests; a control-room e2e from the agent's proposal line to the reshaped node.
- **Notes:** Pete agreed (a), 2026-09-27. Branch T455-propose-repo (worker; manager reviewed). `propose_repo {session, repo, why}` for a conversation's or work node's worker writes one `proposal` line (`Proposes adding **web**: …`, ref `repo:web`); the chat's **Add web** runs Add repository in place. Refused for the Director, coordinators, reviewers, closed/merged/archived/helper nodes, roots, coordinating nodes, the node's own repo, a repo it can't read (same words as an unregistered one) and a duplicate. The button also hides once a split node has a part on that repo. LIVE-CHECKLIST §10.4 and a walkthrough step. Gate on the merged tree (T454 + T455 + T458): lint, typecheck clean, `bun test` 3411/0, walkthrough 43 steps, 0 findings.

### Ticket: T456 Retry a failed vendor, then fall back to another (D43 follow-up)
- **Priority:** P2
- **Status:** Done
- **Owner:** worker (manager reviews)
- **Scope:** Pete, 2026-09-27. Today a vendor that exits non-zero on its own blocks the node at once (D43, T432); nothing is retried. Add, behind a setting (home, project, repo): retry the same vendor once for a crash (not for a missing command or a login refusal), then start the next installed vendor on a fallback list (`fallback: [gemini, codex]`) on the same node, thread and worktree. The node stays working; its thread says "Claude failed (<reason>); switched to Gemini"; Events records it; the model label follows. Blocked (D43) only when the list is spent. The new agent is told the last one stopped mid-turn (check `git status`). Only what the daemon holds carries over (thread, worktree, plan, brief); the failed vendor's own session context does not.
- **Acceptance Criteria:** The setting in `packages/shared` and Settings; the fallback skips a vendor that isn't installed and, unless allowed, one without pre-tool hooks (a lower enforcement floor); a per-node cap on switches; the parent is told only when the list is spent (a switch is not a status change).
- **Validation Steps:** Fake-agent tests: crash → retry → fallback → working; login refusal → no retry, fallback; list spent → blocked as D43; the cap.
- **Notes:** Branch T456-vendor-fallback (worker; manager reviewed, fixed a key shown in the Settings text). `vendor_failure` {retry (default on), fallback [], allow_hookless} at home, repo and project (resolved project → repo → home; Settings → Agents → If the agent fails covers the home; repo and project through the API). No retry for a login or model refusal in the vendor's last stderr line or exit 126/127 (`attach/fallback.ts`); hooked vendors are Claude and Pi. A record-only `agent_restarted` event (Events, Activity; the parent isn't told). Cap 3 restarts per node per hour. Deferred: a failed prompt or transport error (not a crash) still blocks without a retry; a switch doesn't change the node's default vendor, so its next start uses the default again. Gate on the merged tree: lint, typecheck clean, `bun test` 3335/0. D43 stays the end state once retries and fallbacks are spent.

### Ticket: T457 Permission posture: Trusted or Ask (D45 follow-up)
- **Priority:** P2
- **Status:** Done
- **Owner:** worker (manager reviews)
- **Scope:** Pete, 2026-09-27. Vendors keep their default permission mode (the daemon answers every ask; a vendor bypass flag would switch the daemon's gating off, and a hook-less vendor would have none). Add a daemon-side posture per home, project or repo. **Trusted** (like Claude's bypass or Codex's yolo): an agent reads anything on disk except the agile home and secrets, without asking. **Ask**: a read outside the registered repos is a Needs me card (Allow once, Always for this project, Deny) instead of today's deny. Both: the project's own repos lead the brief's readable list; writes stay in the node's own worktree; the never-without-human list (protected-branch pushes, deletes outside the worktree, the agile home) is unchanged.
- **Acceptance Criteria:** The setting in `packages/shared`, Settings and config.yaml; the hook and ACP responder both apply it (one decision function); the card's Always adds a read root for the project.
- **Validation Steps:** `permissions/decide.test.ts` and hook tests for both postures; a control-room e2e for the Ask card.
- **Notes:** Branch T457-permission-posture (worker; manager reviewed; merged after T456 with three import/key-list conflicts kept both sides). `permissions: trusted | ask` (default Ask) at home and per project (`packages/shared/src/posture.ts`); one `readVerdict` in `policy-tables.ts` serves the hook, the ACP responder, the benign-command table, the coordinator's `cd` and the `git -C` read allowlist: worktree, then `CREDENTIAL_PATHS`, then hidden roots, then read roots, then the posture. Ask raises an "Allow this read?" card (Allow once, Always for this project, Deny); Always stores the dir in the project's `read_roots` (never `/` or the home dir). Hardened: `~`, `..` through symlinks, globs and braces, recursive reads (`grep -r`, `rg`), case variants, the reviewer's reads, `grep -e`. Settings → General → Permissions, and per project. Repo level not added (the node's project decides). Gate on the merged tree (with T456): lint, typecheck clean, `bun test` 3367/0. The worker's review found three older Bash classifier holes; confirmed by the manager and filed as T459.

### Ticket: T458 A conversation knows the work in progress
- **Priority:** P3
- **Status:** Done
- **Owner:** worker (manager reviews)
- **Scope:** Pete, 2026-09-27. A conversation's brief lists the repos it can read (paths only) and, when asked about a node, that node's branch and worktree; it doesn't know what else is in flight. Add a capped "Work in progress" section: the project's open work nodes with repo, branch, worktree, status and progress line, so a question like "is anyone touching the export code?" is answered from the right worktree.
- **Acceptance Criteria:** Capped by count and characters like the other brief sections; ids only where the agent needs them; closed and merged nodes left out.
- **Validation Steps:** `runner/brief.test.ts` for the section and its caps.
- **Notes:** Branch T458-wip-brief (worker; manager reviewed). A "Work in progress" section in a conversation's brief: the project's open work nodes on repos it can read (not itself or its parent), newest first, with repo, branch, worktree, statuses, when it last changed and its latest line; at most 15 nodes and 6,000 characters, then "and N more". Conversations only (a coordinator's brief already lists its parts). T458b (branch T458b-about-hidden-parts, manager): the worker found that T420's "What you were asked about" listed the parent's parts on repos the conversation can't read (titles and progress, no paths); they are now left out too. Full `bun test` 3382/0 on the merged tree.

### Ticket: T459 Bash classifier holes: input redirects, xargs, braces in write paths
- **Priority:** P0
- **Status:** Done
- **Owner:** manager
- **Scope:** Found by T457's review, confirmed on the merged tree with `decidePermission` (engineer, Ask): `cat </root/.agile/config.yaml`, `tr a b < file` and `echo <path> | xargs cat` are allowed although `cat <path>` of the agile home is denied; `echo a /tmp/x | xargs cp` and `touch a/{b,../../x}` are allowed although they write outside the worktree. The agile home holds the classifier key and every node's state.
- **Acceptance Criteria:** An input redirect's file (`<f`, `0<f`, `< f`, fused or spaced) is read-checked like an argument. `xargs` is not stripped as a harmless wrapper: its command runs on paths the checker can't see, so an `xargs` pipeline is held for the human (or denied), whatever it runs. A write path with a brace or glob pattern is checked after expansion or refused when a branch can leave the worktree. Existing allowed shapes stay allowed.
- **Validation Steps:** `permissions/decide.test.ts` cases for each spelling above (they allow on the old code); full `bun test`.
- **Notes:** Branch T459-classifier-holes. `cmd.inputRedirectTargets` (fused `<f`, `0<f` or spaced; not heredocs, `<(`, `<>`, `<&`) is read-checked for the engineer and through `scopedReads` for the coordinator and reviewer. `xargs` is still stripped so the never-without-human and push checks see the command, but `cmd.runsUnderXargs` holds an engineer's atom for the human and denies a reviewer's or coordinator's. A write path whose pattern can climb (`patternClimbs`, shared with T457's read check) is denied; `cp src/*.ts out/` and `touch src/{a,b}.ts` stay allowed. Tests: `decide.test.ts` T459 block (6 of 9 fail on the old code). Full `bun test` 3376/0, lint and typecheck clean.

### Ticket: T460 A refused turn reads in words and falls back; no gate ids to the agent
- **Priority:** P0
- **Status:** Done
- **Owner:** manager
- **Scope:** Found by Pete in the live walkthrough (2026-09-27). Claude Code's expired login answers a prompt with "Failed to authenticate: OAuth session expired and could not be refreshed" and fails the turn, its process alive. The node blocked with "Session ended: prompt failed: The turn did not finish cleanly (prompt rejected): [session/create] sessionId=… phase=register durationMs=1 totalMs=1073", which names no cause and no fix. T456's retry and fallback only covered a process exit, so no fallback vendor was tried. Typing `/login` in the composer started the agent again and failed the same way. Separately, a read held for the human (T457 Ask) told the agent "routed to your inbox as HIL-…", and the agent repeated the id to Pete in its reply.
- **Acceptance Criteria:** A failed turn (not a stop of ours) is recovered like a crash: a login or model refusal skips the retry and goes to the fallback list; anything else is retried once. The agent's own words in the failed turn are the evidence and the reason. Once the list is spent, the node blocks with a line in words: a login refusal says "<Vendor> isn't logged in. Log in from a terminal (run `claude` and type /login), then send a message to start it again."; anything else says what the agent said. The chat, Details and Needs me show it. A held call's refusal to the agent names no gate id, and the worker and coordinator briefs say to talk in words, not ids. The chat leaves out a parenthesised gate id.
- **Validation Steps:** `attach/service.test.ts` T460 cases (a fake agent that says the refusal, then rejects the prompt): blocked in words with no retry; switched to the fallback; any other failure retried once, then blocked. `fallback.test.ts` wording. `chat.test.ts` T460. The route band tests assert no id. Full `bun test`.
- **Notes:** Branch T460-refused-turn. The runner passes the failed turn's text as `agentSaid` (`TurnFailedError`). `turnFailureWords` in `attach/fallback.ts` gives the words and the per-vendor login hint (claude, gemini, codex, cursor; others "log in to <label>"). The thread line is `session ended: turn failed: …`. The fake agent gained a `reject_prompt` step. The composer's `/login` hint is part of T461.

### Ticket: T460b A decided gate reaches the agent in words, not by id
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** Two more places told the agent a gate's id, which it could repeat to Pete. The approval or denial prompt said "`HIL-…` approved — retry the call now.", and a retry after a denial was refused with "`HIL-…` was denied: …".
- **Acceptance Criteria:** The prompt names the call itself ("The human approved your held Edit call: <path> — retry the call now."). The refused retry reads "The human denied this call: <note>". Neither carries the id.
- **Validation Steps:** `hook/route-band.test.ts` asserts the words and no id; `hook/service.test.ts`.
- **Notes:** Branch T460b-gate-decision-words. `heldCallWords` in `attach/service.ts`.

### Ticket: T461 Slash commands in the composer
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** Pete (2026-09-27): "definitely ticket this, it's essential". A composer line never reaches the vendor as a slash command. The daemon wraps every line ("The operator wrote on the stream: /login …") so the slash isn't at the start of the prompt. It also drops the ACP `available_commands_update` notification, so the cockpit never knows which commands the vendor offers. Interactive commands (`/login`, `/model`, `/config`) can't run at all over ACP: the harness is headless.
- **Acceptance Criteria:** The daemon keeps each session's advertised commands (in memory, per session) and serves them to the cockpit. Typing `/` in a node's composer opens a menu of that agent's commands, with descriptions, filtered as you type. A line that starts with an advertised command is sent to the vendor as-is (not wrapped), so the vendor runs it; its output reads in the chat like any turn. A known interactive command that can't run headless (`/login`, `/logout`, and whichever others the vendor doesn't advertise) is not sent: the composer says what to do instead (for `/login`, T460's "log in from a terminal" words for that vendor). An unknown `/word` is sent as a normal message, and the hint says so. The cockpit's own shortcuts are unchanged. No node running: the menu says the commands load when the agent starts, and the first message still starts it.
- **Validation Steps:** Fake agent advertising commands; daemon tests for pass-through versus wrapping; cockpit e2e for the menu, a pass-through, and the `/login` hint. LIVE-CHECKLIST gets a step with real Claude (`/compact` or a custom `.claude/commands` entry).
- **Notes:** Branch T461-slash-commands. The commands Claude advertises over ACP are to be measured live at LIVE-CHECKLIST §11 (claude-agent-acp lists built-ins such as `/compact`, `/init`, `/review`, plus the repo's own `.claude/commands` and skills). Nothing is assumed about Gemini or Codex until measured.
  - Daemon: the runner keeps each session's `available_commands_update` (`advertisedCommands`, at most 200, in memory). `AttachService.commandsFor` serves them, and `GET /api/streams/:id/commands` returns `{running, vendor?, commands}`. `SessionDelivery` sends a human line that starts with an advertised command as its own turn, as typed. Lines before it go first as a digest; lines after it wait for the next turn end.
  - Found on the way and fixed here: a `human_line` event carries the line capped at 800 characters, while the composer takes 4,000, so a long message reached the agent cut off. Delivery now reads the line from the thread (`lineBody`), in digests and in a woken session's brief alike.
  - Shared: `AgentCommandSchema`, `slashCommandOf` and `vendorLoginHow` (T460's login words, now used by the daemon and the cockpit).
  - Cockpit: `lib/commands.ts` (`commandMenu`, `heldCommand`, `commandHint`, `useAgentCommands`). The composer's `slash` prop gives the menu (arrows, Enter or Tab, Escape), the hint and the held note. The node page re-reads the commands when a line starts with `/`, since a vendor lists them only after its session opens. Only a command the vendor doesn't advertise is held (`/login`, `/logout`, `/model`).
  - Tests: `attach/service.test.ts` T461 (the command's own turn, a 1,500-character line whole, an unknown command wrapped), `runner/commands.test.ts`, `ui/app/lib/commands.test.ts`, and the control-room e2e "slash commands in the composer".
  - Not done: the Director's composer has no `/` menu yet.

### Ticket: T462 A simple for loop runs; a refused call reads in words
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** Found by Pete in the live walkthrough (2026-09-28). A worker's `for t in 1790274589 …; do date -r $t "+%F %R %Z"; done` was refused with "hook_deny: denied `…` — for is not an allowed command for the engineer role". The command splitter cut the loop at `;`, so `for`, `do …` and `done` were checked as commands, and no role allows `for`. The chat showed the daemon's raw line, with its "hook_deny" and role jargon.
- **Acceptance Criteria:** `for NAME in WORD…; do BODY; done` over plain words is unrolled before any check: BODY once per word, with `$NAME` and `${NAME}` written out. Every check (the role tables, the never-without-human list, push detection, pattern rules) sees the commands the loop runs. Each unrolled loop gets the verdict its commands would get typed one by one. The loop stays unrunnable on its own when its words hold substitutions or quoting, its body quotes `$NAME` in single quotes or holds `while`/`if`/another loop, or it has more than 50 words or 200 unrolled commands. The chat reads a hook line as "Refused: `…` — <reason>" or "Held for your approval: `…` — <reason>", with the role names in words. The worker brief says plain loops are fine.
- **Validation Steps:** `permissions/decide.test.ts` T462 (Pete's loop allowed, and fails on the old code; loop and typed-out verdicts equal for engineer and reviewer; the refused shapes never allowed). `ui/app/lib/chat.test.ts` T462. Full `bun test`.
- **Notes:** Branch T462-loops-and-refusal-words. `unrollForLoops` in `permissions/command.ts`, applied in `parseCommandIntoAtoms`, which is how every caller splits a command. Reads outside the worktree in a loop follow T457 like any read: a registered repo reads freely, any other folder asks under Ask (Always for this project stops it asking), and reads anywhere under Trusted.

### Ticket: T463 A node's own rules and permissions
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** Pete (2026-09-28), on a node's Knowledge tab: "i should have the ability to manually uncheck individual rules for this node", and "i also should be able to change that individual node between trusted and ask … this screen would make sense for that". Knowledge applied by scope alone, and the posture was set only at the home and on projects.
- **Acceptance Criteria:**
  - Each item on a node's Knowledge tab has a checkbox (checked = applies here). Unchecking switches the item off for that node alone; a critical rule asks first. The item stays listed, dimmed, so it can be switched back on.
  - The Knowledge tab opens with a Permissions row: Inherit (names what it inherits), Trusted or Ask. A node's posture wins over its project's and the home's.
  - Both are the operator's alone: the store refuses a change from an agent, a coordinator or the Director. Each change is a thread line.
- **Validation Steps:** `shared/src/stream.test.ts` T463 (only a human or the daemon), `knowledge/scope.test.ts` (off here, still listed with `includeOff`, children unaffected), `permissions/posture.test.ts` (node → project → home; `setPermissions`), `http.test.ts` (both routes: strict, 403 cross-origin, 400 for an item out of scope), the control-room e2e "a node’s own rules and permissions". Full `bun test`.
- **Notes:** Branch T463-rules-off-per-node.
  - The node record gains `rules_off` (knowledge ids) and `permissions` (T457's posture), both human-only (`HUMAN_ONLY_FIELDS` in `assertStreamWrite`).
  - `knowledgeInScope` leaves `rules_off` out (the one scope filter: hook, brief, delivery, wakes), unless `includeOff` (the node page). `nodeReadScope` takes the node's posture first.
  - Routes: `POST /api/streams/:id/rule {rule, on}` and `POST /api/streams/:id/permissions {posture | null}`.
  - A switched-off built-in rule doesn't lift the role tables: writes still stay in the worktree, and the never-without-human list still asks. The confirm says so.
  - The ACP responder (vendors without a pre-tool hook) reads the posture when the session starts, so a change there applies from the next start. The hook reads it on every call.

### Ticket: T466 Codex wrote "progress —" into its text; lookup_knowledge on the repo root failed
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** Found by Pete in the live walkthrough (2026-09-28). Codex had the agile MCP tools (`mcp.agile.search_docs` ran) but began both of its messages with "progress — ", copying REPLY_FIRST's "Reply … with `progress`" instead of calling the verb. Its `mcp.agile.lookup_knowledge` call failed: most likely it passed the repo root, which `lookupPath` refused as "not a path inside this stream's worktree".
- **Acceptance Criteria:** REPLY_FIRST says to call the `progress` tool and not to write the word into the message. The chat drops a leading "progress —"/"progress:" from an agent's message. `lookup_knowledge` with `.` (or the worktree itself) answers with every item in scope, path-limited items included.
- **Validation Steps:** `attach/verbs.test.ts` T466 and `lookupPath`; `attach/service.test.ts` (the REPLY_FIRST words); `ui/app/lib/chat.test.ts` T466. Full `bun test`.
- **Notes:** Branch T466-progress-prefix-and-lookup-root. The failed call's arguments weren't visible in the chat, so the root path is the likeliest cause, not a measured one; the next live Codex run shows whether it recurs.

### Ticket: T464 A node keeps the model it ran on
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** Pete (2026-09-28): changing the global default model made every existing node show, and start with, the new model. A node stores no model; an idle node resolves the defaults again at each start (D17).
- **Acceptance Criteria:** A node that has run starts again on its last session's vendor, model and effort. The defaults choose only for a node that has never run. The model chip (T423) still switches a node, and the switch sticks. The chip and "Starts as …" name what a start will really run.
- **Validation Steps:** attach tests (a changed default leaves a node that ran on its model; a node that never ran takes the new default; a chip pick sticks); the node page e2e.
- **Notes:** Branch T464-node-keeps-model. `lastAgentSession` in `attach/service.ts`: a start with no vendor or model picked takes the newest worker or coordinator session's vendor, model and effort, unless that vendor is no longer installed. The cockpit's `keptChoice` (`lib/defaults.ts`) names the same thing on the chip, in "Starts as …" and in the composer hint. A T456 switch to a fallback vendor now sticks too, since that vendor ran last.

### Ticket: T465 Keep a finished turn's session alive, and resume an ended one
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** Pete (2026-09-28) asked whether a thread is one vendor session that keeps its context and prompt cache. Only while the agent runs: the turn-end rule stops the session when a turn ends with nothing open, and the next message starts a fresh session from a brief, cold.
- **Acceptance Criteria:** A finished turn leaves the session alive and idle ("Waiting for you"); the next message goes into the same session. It ends after an idle timeout (Settings, default 30 minutes), a Stop, or the daemon stopping. An ended session is resumed with ACP `session/load` where the vendor supports it (Claude, Grok: spike-findings §C), else started fresh from the brief.
- **Validation Steps:** A worker's or coordinator's finished turn now "rests" (`AttachService.rest`): the session goes `idle`, the node `done` (Replies, Ready to merge, auto-close unchanged), the thread says "turn finished" (the chat: "Agent finished its turn"). A message (`say`) or a wake the policy allows (`wake`) prompts the same session (`rouse`: `working`, `goal_met` cleared); an event that would not wake the node waits for its next turn. The idle timer (`session_idle_minutes`, default 30; Settings → Agents → Idle sessions, `GET/POST /api/settings/session-idle`), a Stop, a role change, a close, merge or trash, a new start on the node, and the daemon stopping end it with the node still `done` and the reason in words on the thread. The next start with something to hand over resumes the last agent session with `session/load` (runner `resume`: the replay stays off the thread, the digest goes instead of the brief) when the provider has `loadSession`, the session ended `stopped` with its `acp_session_id` on record, and the role, vendor, model and effort match; a failed load starts fresh from the brief, and stderr.log and the thread say so. Tests: attach `T465 (D48)` block (one session two prompts; a non-waking event waits; idle timeout keeps `done`; the home setting; resume via `session/load` with the replay suppressed; load failure → fresh; a picked model → fresh; `resumableSession`; merge with a resting session ends it; a working agent still holds a merge; auto-close ignores an earlier turn's `goal_met` and closes on the turn's own; daemon stop then resume; T444 idle orphan; Stop and a role change keep `done`), the existing wake, answer, gate, queued-line, coordinator and route-band tests moved to the new rule, snapshot (`live` leaves a resting node out of Running), http (`session-idle` route), chat (new lines, the coordinator wake fold in a resting session). Full `bun test` 3508 pass, 3 skip, 0 fail; control-room e2e 131/0; walkthrough 1/0; typecheck and lint clean.
- **Notes:** Branch T465-keep-sessions-alive. Choices:
  - "Resting" is kept in memory by the attach service and read from the record elsewhere as `isRestingSession` (`@agile-agents/shared`): an agent session `idle` on a node whose agent is `done` (a question keeps the node `question`, so that idle session is not resting). The session stays `idle` as the design asked; no new status.
  - Live checks: `requireLandable` (and so preflight, auto-close's merge check) ignores a resting worker, and the `landed`/`closed`/archived update ends it (awaited in `onUpdated`, before the worktree goes); the cockpit row's `live` (Running lens) leaves it out, `live_agent` still names it; the inbox's "no coordinator is running" plan card and + Repo's `wasLive` treat it as not running; Delivery's Resolve button is not blocked by it; `attach` ends it before a new start (Resolve, Start, Wake coordinator); `startFor`/`say` rouse it; delivery's `target` skips it so only the wake policy prompts it; `orphanSessions` and T444's start-up sweep now also end `idle` records with no process, keeping the node's status.
  - Reviewer and lessons roles keep today's rule: their turn end ends the session.
  - `goal_met` per turn: a rouse clears it, so auto-close counts only the turn that just ended.
  - Resume sends the pending events as the live digest, only when there is something to hand over (a line, a wake); a plain Start agent, a crash retry or a Resolve (a brief appendix) starts fresh. A resting coordinator's wake keeps the chat fold (the "woken by" line names the session).
  - The Director keeps its own session handling.

### Ticket: T467a Keep the vendor's session/new reply, so §12 can be measured
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** Pete ran the vendors and sent `log/events.jsonl`: it has no `session/new` reply, because the daemon never kept one. It read the current model out of `configOptions` and dropped the rest, and the ACP client forwarded `modes` and `configOptions` but not `models`. His log shows Claude reporting its model and Codex, Cursor, Gemini and Grok all reading "default", with no way to tell whether they sent nothing or something the parser didn't know.
- **Acceptance Criteria:** Each session writes the vendor's `session/new` (or `session/load`) reply to `<home>/sessions/<id>/session-state.json`, with `modes`, `configOptions` and `models`. The ACP client forwards `models`, including a reply that carries only it. The current model is also read from ACP's `models.currentModelId`. LIVE-CHECKLIST §12 points at the file.
- **Validation Steps:** attach test T467a (the file holds the reply as sent); `runner/session-state.test.ts` (configOptions, a model record, `models.currentModelId`, none). acp-client tests green; full `bun test` 3493/0.
- **Notes:** Branch T467a-save-session-reply. Reading, not setting: D46's "measure first" still holds for how a model is set.

### Ticket: T467b Write session-state.json for every vendor, and say how to get a daemon that does
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** Pete ran ten sessions and found no `session-state.json` in any of them. His search of the code found no file by that name either, so his checkout or running daemon predates T467a (43099a46). There was also a real gap: the ACP client sent `_agile/session_state` only when the reply carried `modes`, `configOptions` or `models`. A vendor whose `session/new` reply has none of them (just a session id) wrote no file. That is the very case §12 needs to see.
- **Acceptance Criteria:** Every `session/new` or `session/load` reply writes the file. Missing fields read `null`, and `keys` lists what the reply did carry. LIVE-CHECKLIST §12 starts with the steps to get a daemon that writes it: fetch, check out and pull `claude/phase-14`; check with `git grep`; build; restart the daemon. It also says old sessions have no file and a new node is needed.
- **Validation Steps:** attach test T467b: a fake Cursor replying `{sessionId}` alone writes the file with `keys: ["sessionId"]`. It fails on the T467a code (no file within 5 s). Typecheck and lint are clean; the full `bun test` passes 3511/0.
- **Notes:** Branch T467b-session-state-always.

### Ticket: T467 Models come from the vendor, set through ACP (D46)
- **Priority:** P1
- **Status:** Done (offline; whether each vendor honours `session/set_config_option` is for the live run: LIVE-CHECKLIST §12's "Accepts a model via ACP?" column)
- **Owner:** manager
- **Scope:** Pete (2026-09-28): only Claude lists models; every other vendor shows "default model". `KNOWN_MODEL_IDS` is hand-written for Claude alone, and only Claude's adapter can set a model (`ANTHROPIC_MODEL`). That's left over from building, not a design: Claude's switch was the only one measured. ACP vendors report their models in `session/new`'s reply, which the daemon reads for the current model but otherwise discards.
- **Acceptance Criteria (D46), for every vendor, Claude included:**
  1. The model list comes from the vendor: the daemon keeps the list from the reply ACP returns when a session opens (it already reads the current model there), and the pickers show it. A vendor that hasn't run yet can be asked with a Refresh that opens a session without prompting.
  2. The chosen model is set through that same ACP model option.
  3. A vendor-specific switch is a fallback only where the ACP option is missing, and only once a live run has measured that it's missing. Claude's `ANTHROPIC_MODEL` stays only if its bridge turns out not to support the ACP route.
  4. A vendor with no way to set a model shows "default" in the picker, with the reason.
- **Measured (§12, 2026-09-29):** Claude, Codex, Cursor and Grok all send a `configOptions` entry with `category: "model"` (select: `currentValue`, `options[{value, name, description?}]`). That one shape is the list for every vendor. Claude and Codex also send a `category: "thought_level"` option for effort (`effort`, `reasoning_effort`), each with its own levels. Grok's list is short (one option, and the current value is not in it). Cursor's values carry their settings in brackets. Gemini's account was refused and Pi didn't run: they keep today's behaviour until measured.
- **Validation Steps:** LIVE-CHECKLIST §12 filled in for each installed vendor before building. Then fake-agent tests (a vendor reporting a list; one accepting the ACP model option; one without it), and the picker e2e. Built: `runner/model-catalog.test.ts` (11: the option read from `configOptions` before `models`, `models` as the fallback, grouped options, none; newest file per vendor, a reply with no list keeps the older one, Grok's off-list current kept, a corrupt file skipped, an old file mapped through the session records; `record`; Refresh with auth and no prompt, a reply with no list, a vendor that can't open), attach `T467 (D46)` block (7: a listed pick set through the option before the first prompt, in the log order authenticate → set_mode → set_config_option → prompt; ignored → the thread line and the session's model is the vendor's; refused → the line, the session carries on; Claude's full id → `ANTHROPIC_MODEL`, no option call; a Claude pick from the bridge's list not current → the option too; no model option → nothing set, catalog empty; a resume sets it again after `session/load`), acp-client (`setConfigOption` and its forwarded state), http (the `vendor_models` field; Refresh: 403 cross-origin, 400, 409 not installed, 502 failure, 200; 503 with no catalog), UI lib (the vendor's names in the groups, the select and a vendor change; the "No list yet" reason; bracket settings left off labels), control-room e2e "Models come from the vendor (T467)" (Cursor's names in the picker, the pick starts the node on its value, Settings → Agents → Models shows the list and Refresh fills Gemini's). The attach block fails 5 of 7 with the set step disabled. Full `bun test` 3535 pass, 3 skip, 0 fail; control-room e2e 132/0; walkthrough 1/0; typecheck and lint clean.
- **Notes:** Branch T467-vendor-models. Choices:
  - The catalog (`runner/model-catalog.ts`) is built from the `session-state.json` files, no new file: at start-up the newest session dirs (ULIDs sort by age) are read until each vendor has a list (at most 500 files), then kept in memory as sessions open (`onSessionState` from the runner, attach and Director). A file now names its `vendor`; an older one is mapped through the node records' sessions (`sessionVendorIndex`). A reply whose model option has no `options` (the old fake agent) is not a list. `GET /api/settings/session` carries it as `vendor_models` (`VendorModelsSchema`, shared, strict).
  - The pick: once the session is open (after `session/new`, or `session/load` on a resume, or the fresh start after a failed load) and before the first prompt, a pick the vendor lists and doesn't run is sent with `session/set_config_option` (`setConfigOption` in the acp-client; its reply is forwarded as `_agile/session_state` with `source`, merged into the saved state). The reply's `currentValue` decides; a miss or an error is one thread line and the session record's `model` becomes the vendor's. A non-Claude pick the vendor doesn't list gets a line too. A fresh session's first turn now waits for the open (with authenticate where the vendor needs it); a session that can't open fails that turn as its prompt did (T171's set_mode refusal still ends it with the vendor line).
  - Claude keeps `ANTHROPIC_MODEL` for every pick (unchanged); the option is only used when the pick is one of the bridge's own values and not its current one.
  - Pickers: a vendor with a list is a group of its names (values stored); the current one shows even when the list lacks it; with none, the built-in list (Claude) or the default row, tagged "No list yet" with the reason. A label drops bracketed settings (`grok-4.7[…]` → "grok-4.7").
  - Refresh: `POST /api/settings/models/refresh {vendor}` (same-origin) spawns the vendor in a new `sessions/<id>/` dir with no MCP server and no prompt, authenticates where needed, keeps the `session/new` reply, and stops it (60 s bound). Settings → Agents → Models has a Refresh per vendor.
  - Follow-ups: effort through ACP (Claude's `effort` and Codex's `reasoning_effort`, both `category: "thought_level"`; Grok's in `models._meta.reasoningEfforts`) is untouched (Claude still uses `MAX_THINKING_TOKENS`); Codex's `models` pairs are ignored; ACP `session/set_model` isn't used (no vendor measured needing it).

### Ticket: T479 Claude bridge 0.84.0, so Sonnet 5.5 is offered
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** Pete (2026-09-29): Sonnet 5.5 is in Claude Code but missing from the list Claude reported in §12. That list comes from the ACP bridge we pin, not from the installed Claude Code. `claude-agent-acp@0.81.1` bundles `claude-agent-sdk` 0.3.280, which doesn't know `claude-sonnet-5-5`; 0.84.0 bundles 0.3.284, which does.
- **Acceptance Criteria:** The pin is 0.84.0. Everything the daemon relies on was re-checked in the 0.84.0 dist and is unchanged: `ANTHROPIC_MODEL`, `MAX_THINKING_TOKENS` through `resolveThinkingConfig`, `loadSession`, the session config-option setter, the six mode ids, and the default `settingSources` user/project/local that the hook settings file depends on. The built-in Claude list suggests `claude-sonnet-5-5`.
- **Validation Steps:** acp-client tests (the pinned args) 146/0; typecheck and lint clean; full `bun test` 3511/0. Live: LIVE-CHECKLIST §12's Claude row should list Sonnet 5.5 after `npx` fetches 0.84.0 (the first start after the pull takes a little longer).

### Ticket: T480 Run the installed Claude Code and Codex, not the bridges' bundled copies (D49)
- **Priority:** P1
- **Status:** Done (offline; LIVE-CHECKLIST §12.1 for the live run)
- **Owner:** manager
- **Scope:** Pete (2026-09-29): "no good reason for 2 different claude installations". `claude-agent-acp` bundles its own Claude Code (through `claude-agent-sdk`), and `codex-acp` bundles `@openai/codex`, so a model the operator's Claude Code already has (Sonnet 5.5) was missing until the bridge moved (T479). Both bridges take an override, checked in their dists: `CLAUDE_CODE_EXECUTABLE` (claude-agent-acp 0.84.0, `acp-agent.js`) and `CODEX_PATH` (codex-acp 1.10.0, README: "run a specific Codex executable instead of the bundled package dependency").
- **Acceptance Criteria:** When `claude` or `codex` is on PATH, the session env sets the override to its resolved path. When it isn't, the bundled copy runs, as today. `agile daemon status` and Settings → Agents say which is used, with the path and `--version`. A start that fails with the installed CLI, where the bundled copy would work, says so in words on the thread. A per-vendor switch ("Use the installed Claude Code") is on by default. The Claude hook settings path is unchanged: the installed CLI reads the same `.claude/settings*.json`.
- **Validation Steps:** Runner tests (the env carries the override when the binary resolves, none when it doesn't, and the switch turns it off). LIVE-CHECKLIST: Claude's §12 model list matches the installed Claude Code's `/model` list, and a hooked tool call is still held.
- **Notes:** Branch T480-installed-cli.
  - `runner/installed-cli.ts` finds `claude`/`codex` on PATH with `Bun.which` (the PATH path itself, so a native installer's symlink follows its updates) and builds `{CLAUDE_CODE_EXECUTABLE|CODEX_PATH: path}`.
  - The runner adds it to the session env only when the session isn't sandboxed (`installedCliForSpawn`: a sandbox backend may not see the host's binary). stderr.log says which copy ran.
  - A session that can't open while running the installed CLI says so in its failure, and names the switch.
  - Wired through attach, the Director and Refresh models (`ModelCatalog.installedCli`), so the list Refresh reads is the installed CLI's.
  - Home config `installed_cli: {claude?, codex?}`, absent = on. `store.setInstalledCli`, `GET/POST /api/settings/installed-cli` (same-origin), and a Settings → Agents **Installed agents** card.
  - `agile daemon status` isn't changed: Settings shows the path.
  - Tests: `installed-cli.test.ts` 5/0; the attach test (the bridge env and the stderr.log line); the http test (the switch; 400 for gemini; 403 cross-origin); the control-room e2e (the switch saves).
  - Validation: typecheck and lint are clean; full `bun test` 3542/0 (one run failed the T467 e2e on a stale UI build and passed after `bun run build`); control-room e2e 132/0; walkthrough 1/0.

### Ticket: T481 Keep each vendor's CLI up to date: Off, Alert or Auto (D50)
- **Priority:** P1
- **Status:** Done (the LIVE-CHECKLIST §15 run on a real machine is still Pete's)
- **Owner:** manager
- **Scope:** Pete (2026-09-29): "a regular check of some kind for any vendor harness with an automatic update feature … configured in settings. it can either be off/alert/auto. off does no version check. alert creates pop-up or 'needs you' that allows me to just click a button and have the new version … installed. auto installs the new version behind the scenes automatically. … existing sessions will be running on the old version and that's fine."
- **Acceptance Criteria:**
  1. Settings → Agents → **Updates**: Off, Alert (the default) or Auto, kept in the home config. A vendor can override it.
  2. For each installed vendor CLI (claude, codex, gemini, cursor-agent, grok, pi), the daemon finds the installed version (`--version`) and how it was installed, from where the binary resolves: Homebrew, a global npm package, or the vendor's own installer with its own update command. It then finds the newest version the same way. A vendor or install method it can't check says so in Settings, with how to update by hand. Nothing is guessed.
  3. The check runs at daemon start and then daily, plus **Check now**. Off runs no check at all.
  4. **Alert:** a Needs me item, "Claude Code 2.3.1 is available (you have 2.2.9)", with **Update**, which runs the update and reports the result in words. It can be dismissed until the next version.
  5. **Auto:** the update runs in the background and leaves a line in Events. A failure becomes a Needs me item, with the command to run by hand.
  6. Updates run fixed argv, never through a shell and never with sudo, with a timeout. A permission error is reported, not retried. Running sessions are untouched.
  7. Settings also shows each ACP bridge's pinned version and the newest published one, as information only. A bridge moves by a code change (as T479 did), never by the updater.
- **Validation Steps:** Unit tests with an injected command runner (no network, no real installs): install-method detection, version parsing, each mode's behaviour, a failed update, Off running nothing. HTTP route tests (same-origin). Settings and Needs me e2e. LIVE-CHECKLIST: one real Alert-mode update of a vendor that is behind.
  - Built: `packages/daemon/src/harness/` (`methods.ts`: the runner, version parsing, and `UPDATE_METHODS`, the one table of vendor + method → detect, newest, update; `service.ts`: `HarnessUpdateService`). Methods, read from the realpath of the binary: Homebrew formula or cask (`<prefix>/Cellar|Caskroom/<name>/`: `brew info --json=v2`, `brew upgrade [--cask]`, the prefix's own `brew`); Claude's own installer (`~/.local/share/claude/`, `~/.claude/local/`: `claude update`, newest unknown); global npm (`<prefix>/lib/node_modules/<pkg>`: `npm view <pkg> version`, `npm install -g --prefix <prefix> <pkg>@latest`). Anything else (cursor-agent's and grok's installers, a bun global, the npx cache) is "Can't check <CLI> automatically; update it the way you installed it (<path>)". CLIs: claude, codex, gemini, cursor-agent, grok, pi, and pi-acp (its version from its npm package.json: it is an ACP server, never started to read one).
  - State: the mode, a vendor's own mode and the dismissed version per CLI are `harness_updates` in config.yaml (`StateStore.setHarnessUpdateMode`, `setHarnessUpdateDismissed`); the last check per CLI is in memory. Needs me kind `harness_update` (no node; `harness: {id, label, failed?}`). Events type `harness_updated`, record-only, routed to nobody.
  - Alert shows an item only for a known newer version; `claude update` (newest unknown) is offered only on Check now. Auto runs updates one at a time after the check and does not retry a version that failed. Updates: fixed argv, `Bun.spawn` with no shell, stdin closed, 10 min timeout then SIGKILL. Under `bun test` the daemon's runner runs nothing and schedules no check unless a test injects one.
  - Routes: `GET/POST /api/settings/harness-updates`, `POST /api/harness-updates/check`, `POST /api/harness-updates/:harness/update|dismiss` (same-origin, actor human). `agile daemon status` prints one line per CLI.
  - Tests: `harness/methods.test.ts` 10 (incl. the real runner's timeout, no shell), `harness/service.test.ts` 13, http T481 ×3, shared inbox/home-config +4, ui `lib/updates.test.ts` 3 and `lib/inbox.test.ts` +1, cli +1, e2e T481 (Settings mode switch, Check now, Needs me Update and Dismiss over a fake runner). Removing the Off guard fails "Off runs no command at all"; reading npm before Homebrew fails the gemini-cli detection tests.
  - Validation (after merging `claude/phase-14` at 2ca9a0ab, T467): typecheck and lint clean; `bun test` 3575 pass, 3 skip, 0 fail; build, then control-room e2e 133/133; walkthrough 43 steps, 0 findings.
- **Notes:** Branch T481-harness-updates. LIVE-CHECKLIST §15 (one Alert-mode and one Auto-mode update). The dismissed versions live in the home config beside the mode (no new home file).

### Ticket: T486b The sandboxed subprocess env drops the daemon's secrets too
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** Found in https://github.com/petestewart/agile-agents/pull/12 (T178 on `main`, a separate session's fix for the same leak as T486). T486 scrubbed every vendor spawn, but `sandboxedSubprocessEnv` (test runs, the sandbox probe, worktree and delivery git) still spread the daemon's whole env, and a test run or a git hook runs code an agent wrote.
- **Acceptance Criteria:** `sandboxedSubprocessEnv` builds from `withoutDaemonSecrets()`; `PATH` and the rest pass through; the daemon keeps its own copy.
- **Validation Steps:** `subprocess-env.test.ts` T486b (fails without the change); typecheck, lint; the delivery, worktree, sandbox and tools tests.
- **Notes:** Branch T486b-sandboxed-env. PR #12 itself targets `main`, which the stacked phase branches replace; its vendor-session part is T486 here.

### Ticket: T487 New node picks its model with the model picker (favourites included)
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** Left from T469: New node's **Change** control is `SessionFields`, three plain dropdowns per vendor. So it has no stars, no favourites view, no folds and no search, unlike the composer chip, Ask and Start with…, which use the model picker (`ModelChoice`).
- **Acceptance Criteria:** New node's model choice is the model picker, with favourites, Show all, folds and type-ahead, and the effort chip beside it for a vendor with effort. What it creates is unchanged: the pick goes on the new node's first start, as today.
- **Validation Steps:** The New node e2e picks a favourite and a non-favourite through search; the walkthrough still runs.
  - Built: New node's model line under "Start the agent now" is the composer's `ModelChip` (`modelOnly`, so `ModelChoice` with T469's favourites, stars, Show all, folds and type-ahead) and `EffortChip` beside it (Claude only, T401); click steps low → medium → high → max. It names the resolved default until you pick (the ids on hover, as T386's line did), and "Use the default" shows once the pick differs. The pick is `modelChip`'s `pending` (a pick equal to the default is no pick) and goes the same way as before: `start: false` on create, then `attachSession(worker, {vendor, effort, model?})`, or with "No goal yet" on `sayOnStream`'s `session`. An untouched New node still starts through the create's own start on the resolved default. Talk/Work, "No goal yet", auto-close and the repo pickers are unchanged. `ModelChip` and `EffortChip` take optional `testid` (New node: `new-stream-model-chip`, `new-stream-effort`), `heading`/`note` and `title` (New node's popover says "Model its agent starts with"; no Shift+Tab in the tooltip). The Change button and `SessionFields` in New node are gone; `SessionFields` stays for Settings.
  - Tests: control-room e2e T487 (favourites view shows the two starred models plus the default, pick starred Cursor grok-4.7, no effort chip for Cursor, Escape closes the list and not New node, create, first session is cursor/grok-4.7; a second New node starts on the default, typing on the list searches, Enter picks Claude Haiku 4.5 without submitting, the effort chip steps Low → Medium → High, first session is claude/claude-haiku-4-5/high). Updated T204 (the chip and effort chip name the default, ids on the chip's title, no reset) and T365 (steps the effort chip in place of the Change select; still asserts the session runs on high).
  - Validation: typecheck and lint clean; full `bun test` 3606 pass, 3 skip, 0 fail; `bun run build` then control-room e2e 135/0; walkthrough 1/0 (it never drove the old selects).
- **Notes:** Branch T487-new-node-model-picker.

### Ticket: T488 Codex's effort, and Cursor's effort in its model
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** Pete (2026-09-30): Codex and Cursor show no effort chip. T401 offered effort only where a spawn-time mapping existed (Claude's `MAX_THINKING_TOKENS`). Pete's §12 replies show Codex reports its own effort option, `reasoning_effort` (`category: "thought_level"`, values low, medium, high, xhigh, max, ultra), and Cursor has none: its effort is part of each model id (`claude-opus-5-5[…,effort=medium,…]`, `gpt-5.6-sol[…,reasoning=medium,…]`).
- **Acceptance Criteria:** Codex gets the effort chip and picker levels; its level is set with `session/set_config_option` after the model and before the first turn, and read back. A level it keeps, refuses or doesn't list says so on the thread and never fails the session; the session records the level it runs. Cursor's chip place reads "In the model" (not a button) and the pickers say "Cursor sets effort as part of each model: pick the model with the effort you want". Claude is unchanged. D12's four levels stay (Codex lists all four; its xhigh and ultra aren't offered).
- **Validation Steps:** Attach tests with the fake agent in Codex's shape; the T401 parity test; UI label tests; the New node e2e for Cursor's hint; full suite.
  - Built: `AcpProviderConfig.effortOption` (Codex `true`); `EFFORT_VENDORS` = claude, codex, and `EFFORT_IN_MODEL_VENDORS` = cursor in shared; `providerTakesEffort` for attach, resume and the Director (no "effort … ignored by codex" line any more); the runner's `applyPickedEffort` after `applyPickedModel`, reading the model reply's `configOptions` first (a model change can change the levels), `vendorEffortOption` in `vendor-models.ts`; `onEffort` reports a refusal to the node's or the Director's thread and records a D12 level the vendor kept. UI: `noEffortLine`/`effortInModel` in `lib/chat.ts`; `EffortChip` renders a static "In the model" chip for Cursor; the picker's no-effort text uses the same words. The fake agent gained `effortOption`.
  - Tests: attach T488 (set after the model and before the prompt, recorded, no ignored line; the current level not sent; kept → line and recorded level; refused → line, the turn runs; an unlisted level not sent; Cursor still "effort high ignored by cursor"). Four of the six fail with `applyPickedEffort` disabled. T401 parity test counts `effortOption`. `chat.test.ts`: Codex labels carry effort, Cursor's don't, `noEffortLine`. Control-room e2e T487 asserts Cursor's static chip and its title.
  - Validation: typecheck and lint clean; `bun run build`, then full `bun test` 3612 pass, 3 skip, 0 fail (e2e included). Live check: LIVE-CHECKLIST §12.2.
- **Notes:** Branch T488-vendor-effort. Unverified against real Codex: whether `reasoning_effort` set over ACP changes the turn (§12.2).

### Ticket: T482 Model routing: the policy and the lock
- **Priority:** P1
- **Status:** Done (differences from the design in `design/model-routing.md` §11)
- **Owner:** manager
- **Scope:** Pete (2026-09-29): model choice is configurable per project or node, with inherit and choose as options, the operator's own parameters (free text and settings), a chooser that looks at the task being handed off, configurable effort, and choices lockable to a set of models and effort levels. Today no parent chooses: `add_child` and `start_node` carry no model, and a child resolves like any unpicked node (T464, then project, repo, home, built-in).
- **Acceptance Criteria:** `design/model-routing.md` §3, §4 and §8: the policy schema (mode default/inherit/choose, quality priority, preset models, effort ceiling, escalation, pinned rules, guidance, weights), resolved node → ancestors → project → home, stored human-only. Every routed pick is clamped to the presets and under the effort ceiling, with a chat line when a clamp changes it. An explicit pick wins and reads "Running <model>, as you picked" (D53). The home default is edited in Settings → Agents → Model choice, and projects that existed before are stamped `default` once (D54). Project and node UI; `agile policy`. Depends on T467.
- **Validation Steps:** Shared resolution unit tests; attach tests (routed vs explicit, inherit, clamp, a node write by an agent refused); UI e2e.
  - Built: `shared` `model-policy.ts`: `ModelPolicySchema` (mode default/inherit/choose, quality 0–100, presets `{vendor, model}`, effort ceiling, escalation start_cheap/strongest_first, pinned rules `{when:{role|label|topic}, pick}`, guidance ≤ 2000, weights 0–3), `ModelPolicyPartialSchema` (every layer), `ModelPolicyPatchSchema` (`null` inherits again), `ModelProfileSchema` and home `model_profiles` (shipped: Opus/Fable 2 strongest, Sonnet 1 balanced, Haiku 0.3 fast, the aliases; Codex gpt-6-astra strongest 2, gpt-5.6-sol/terra and gpt-5.5 balanced 1, gpt-5.6-luna fast 0.3, a first guess; none reads balanced 1), `resolveModelPolicy` (node → ancestors nearest first → project → home → built-in = D54's shipped default, with each field's source), `pickModel` (§4: explicit, never clamped, with the D53 note outside the presets; kept; inherit; default; choose = §5's "Without Jev" rule; then the clamp into the installed presets and under the ceiling, with a note), `routedPickLine`, `ModelPickRecordSchema`. Home `model_policy`/`model_profiles`, project `model_policy`, stream `human.model_policy` and `human.choose_again` (human-only by the `human.*` split), `agent.pick` (the daemon's).
  - Daemon: `routing/policy.ts` `ModelPolicyService` (views, writes, `pickForStart`, `nextPick`, `previewNew`, the one-time stamp) and `routing/rpc.ts` (`policy.show|set|choose_again`). `attach/service.ts`: any flag is an explicit pick; `carried` (a role change, a crash's retry or fallback) asks no policy; otherwise T464's kept pick, else a routed pick made once (and again after a choose-again, which the start clears). A routed start writes "Model: Claude Sonnet 5.5 · medium — start cheap: the cheapest balanced preset model (no chooser yet)"; an explicit pick outside the presets "Running Claude Opus 4.8, as you picked. Routed picks here use this project’s preset models."; every agent start records `agent.pick`. The stamp runs at daemon start before any wake: a project with no `model_policy` gets `{mode: default, presets: []}` and one root-thread line; new projects get `{}`. HTTP (same-origin writes, actor `human`): `GET/PUT /api/settings/model-policy`, `/api/settings/model-profiles`, `/api/projects/:id/model-policy`, `/api/streams/:id/model-policy`, `POST /api/streams/:id/choose-again` (it also ends a resting session), `GET /api/model-policy/preview`; the node page carries `next_pick`.
  - UI: `components/ModelPolicy.tsx` + `lib/model-policy.ts`: Settings → Agents → **Model choice** (Mode with hints, Quality priority slider "Favor speed & cost" ↔ "Favor quality", **Preset models** from the T469 picker rows plus "Use my favourites" and "Any model", Effort ceiling, Escalation, Model profiles tier + cost, a plain note that Choose uses the rule until Jev); Details → **Model choice** on every node (a root's edits the project's): each field "set here" / "from Home" / "from <ancestor>" with "Use inherited", how the current model was picked, and **Let the policy choose again**. The composer's "Starts the agent with…" and New node's chip name the routed pick a start would make. Never "allowed".
  - CLI: `agile policy show [--project P | --node N]`, `agile policy set <field> <value> [--project P | --node N]` (`inherit` clears), `agile policy choose-again --node N`; README and usage.
  - Tests: shared `model-policy.test.ts` (27: schemas strict, limits, the human-only split, patches; resolution field by field with sources, ancestors before the project, a stamped project over the home; profiles; pick: explicit in/out of presets, kept, inherit, inherit with no parent, default, choose start cheap / no balanced / strongest first / no presets, the clamp by preset and by ceiling, a vendor without effort, an uninstalled preset); daemon `routing/policy.test.ts` (4: the stamp idempotent with one root line, nothing moves with favourites set; agent/coordinator/Director writes of `human.model_policy` and `choose_again` refused; ancestors over the project and a root's layer; `policy.*` RPC); attach T482 (5: routed first start + line + `agent.pick`, a later start keeps it, choose again re-picks and clears; choose again ends a resting session and the next message re-picks (fails without the fix); explicit wins outside the presets with the note, none inside; inherit + ceiling clamp; Default clamped into the presets, and a carried restart asks no policy); http T482 (every route, 403 cross-origin, 400/404); CLI `policy.test.ts` (3); UI `lib/model-policy.test.ts` (5); control-room e2e "Model choice (T482)" (2: Settings saves mode, escalation, ceiling, quality, favourites and a picked preset, Reset, a profile's tier; Details shows the pick, sets and clears a field, Let the policy choose again). Updated for D54 (a routed first start is now Choose): attach T464/T204, CLI stream e2e T130/T204 (now through `agile policy set`), control-room T363 (the hint and the start are the routed Sonnet 5.5 · medium), T379 and eight chip/defaults tests (set Default with no presets), the walkthrough's home (Default, no presets).
  - Validation: typecheck and lint clean; full `bun test` 3653 pass, 3 skip, 0 fail; `bun run build`, then control-room e2e 137/0; walkthrough 1/0 (43 steps, 0 findings).
- **Notes:** Branch T482-model-policy. Left for T483: the Jev choice call, pinned rules applied, guidance/weights/quality used, Try it, the scores in Details, and cockpit controls for guidance, weights and pinned rules (the CLI sets them now). LIVE-CHECKLIST has no Model choice step yet.

### Ticket: T483 Model routing: the chooser
- **Priority:** P1
- **Status:** Done (differences from the design in `design/model-routing.md` §11, T483)
- **Owner:** manager
- **Scope:** `design/model-routing.md` §5 (D52): one Jev call with the choice primitive scores spec clarity, verifiability, horizon, stakes and volume, reads the topic, and picks a model and effort from the preset models, with a confidence. Pinned rules, guidance, weights and quality priority feed it. Model profiles (tier, relative cost) live in the home config. The rule fallback applies below 0.5 confidence, with no key, or when the call fails.
- **Acceptance Criteria:** A chat line with the pick and why; Details shows the scores, the resolved policy's source, and "Let the policy choose again"; Settings has Try it. A reply that fails the schema, or picks outside the lock, is clamped or falls back, and says so.
- **Validation Steps:** Unit tests with a fake choice classifier (a confident reply, a low-confidence one, an invalid one, an outside pick, a timeout, no key); the wire mapping against a recorded live reply; attach test that a routed start runs the chooser once and a later wake doesn't (D55); e2e for Try it; one real Jev run.
  - Built: shared `model-chooser.ts`: `JevChoiceQuestionSchema`/`JevChoiceAnswerSchema` (strict; 2–255 options), `ChoiceQuestion`/`ChoiceAnswer`, `buildChooserState` (title, goal, role, repo, labels, the parent's title and goal, its approved plan entry, siblings starting now), `chooserQuestions` (`clarity`…`volume` 1–5 each described, `topic`, `model` keyed `vendor/model` with name, tier, relative cost and the vendor's description, under Start cheap only; `effort` up to the ceiling, only when a candidate's vendor takes effort; the default rule, quality priority, weights and guidance in the instructions), `readChooserAnswers` (scores = probability-weighted mean, renormalised; a missing answer or an option not asked fails), `taskFromText`, `ModelPolicyTryInputSchema`. `model-policy.ts`: `ChooserScoresSchema`, `ChooserTopicSchema`, `matchPinnedRule`, `chooserNeed`, `readScores`/`scoresRulePick` (weights scale the distance from 3, 0 drops a criterion; bar `3 + quality/100`), `scoresWords`; `pickModel` takes `task` and `chooser`: pinned → Jev at ≥ 0.5 (its effort) → the scores → the no-score rule "(no classifier key)"/"(Jev didn’t answer)", clamp last (a Jev model outside the candidates is moved, with a note); `PICK_HOWS` gains `pinned`, `jev`, `scores`; `agent.pick` gains `scores`, `topic`, `confidence`. Daemon: `buildJevChoiceRequest`/`parseJevChoiceResponse` in `jev-wire.ts`; `Classifier.choose` on `JevClassifier` (same key, base URL, scrubber, timeout, `onCall`) and `FakeClassifier` (`choice` script, `choiceCalls`; unscripted = not_configured); `routing/chooser.ts` `ModelChooser` (one call, raced against the classifier's timeout, never throws); `ModelPolicyService`: async `pickForStart` (asks the chooser only for a routed start that needs it), `pickForReviewer` (a `reviewer` pinned rule), `taskFor`, `tryTask`, previews never call Jev and carry `chooses` when a key is loaded. Attach awaits the pick before any spawn; roles coordinator/conversation/worker for pinned rules; a reviewer with no flags runs a matching `reviewer` rule. The daemon wires its classifier, timeout and plans in. HTTP `POST /api/model-policy/try` (same-origin; 400 on a bad body); RPC `policy.try`; CLI `agile policy try "<task>" [--project|--node]`. UI: Settings → Model choice gains Pinned rules (add, reorder, remove), Guidance (≤ 2,000, Save), Criterion weights (0–3), **Try it**, and the note that Choose needs the classifier key and what happens without it (also on project and node Details, with sources); Details shows the five scores, the confidence and what decided; the composer says "the model Jev picks (… if it can’t)" when a start will ask Jev. README.
  - Tests: shared `model-chooser.test.ts` (8: scores and renormalising, weights, the rule and the quality bar, words, the state, the questions, a reading's failures, `chooserNeed`); daemon `classifier/jev-choice.test.ts` (8: the recorded request and reply, a whole live reply, a missing answer, malformed answers, 1 or 256 options refused, `JevClassifier.choose` POST with key and scrubbed state, no key/429/timeout); `fake.test.ts` (+1); `routing/chooser.test.ts` (13: confident; below 0.5 → scores, and high stakes → Opus · high; no key; 429, a bad reply, a bad topic and a timeout → "Jev didn’t answer"; outside the presets → clamped with a note; pinned by role, label (no call) and topic, a topic-only call under Default; a reviewer rule; the effort question and its ceiling, none for Gemini; weights, guidance and quality in the instructions; Strongest first; the task's parent, plan entry and siblings; previews; Try it and `policy.try`); attach T483 (3: a routed start asks once and runs Jev's pick, a wake doesn't ask, choose again does (D55); no key → the rule and its line, an explicit pick never asks; a reviewer rule); http T483 (Try it 403/400/no key/nothing started; guidance, weights and pinned rules save and validate); CLI e2e `agile policy try` (keyless and scripted, over the socket); UI `lib/model-policy.test.ts` (+4); control-room e2e "Model choice: the chooser (T483)" (2: Settings saves guidance, a weight and a pinned rule, and Try it shows the line, five scores, 0.82 and "Decided by Jev"; a node Jev picked for shows its line, the scores, the confidence and the source in Details). With the chooser call disabled in `pickForStart`, 13 of the routing and attach T483 tests fail (the ones that pass never go through `pickForStart`: Try it and the attach reviewer test); asking on a kept start fails the D55 test. Updated: attach T482 and the UI pick line ("(no chooser yet)" → "(no classifier key)").
  - Validation: typecheck and lint clean; `bun run build`, then full `bun test` 3700 pass, 3 skip, 0 fail (control-room e2e included).
  - Real Jev run (2026-09-30, `JevClassifier` through `ModelPolicyService.tryTask`/`pickForStart`, env key, 8 questions a call, 180–1,100 ms). Three Claude presets: the rename → Jev, Sonnet 5.5 · medium, confidence 0.63 (clarity 4.83, verifiability 4.81, horizon 1.73, stakes 2.0, volume 1.02); the float-to-cents money migration → Jev, Opus 5.5 · high, 0.77, topic migration (3.4, 2.89, 4.6, 5.0, 1.58); "Make the app better" → Jev, Opus 5.5 · medium, 0.81 (1.18, 1.7, 4.52, 2.65, 1.24); the rename as one of seven parts starting together → Jev, Sonnet 5.5 · medium, 0.52 (volume 4.93). Five presets (those plus Codex GPT-5.6 Sol and GPT-6 Astra): Jev's confidence split between the near-equivalent Claude and Codex models (rename: Sol 0.47, Sonnet 0.36) and stayed at 0.22–0.38, so the scores decided each time: Sonnet · medium, Opus · high, Opus · high, and Haiku · medium for the seven parts (volume ≥ 4 → the fastest).
- **Notes:** Branch T483-jev-chooser. Found live: with equivalent models from two vendors in the presets, Jev's model confidence rarely reaches 0.5, so the rule over the scores decides; the threshold (D52) may want a look, or the question could ask a tier first. New node's chip still names the pick without Jev. Left for T484: escalation (the ladder can reuse `candidateForTier`).

### Ticket: T484 Model routing: escalation
- **Priority:** P2
- **Status:** Done (differences from the design in `design/model-routing.md` §11, T484)
- **Owner:** manager
- **Scope:** `design/model-routing.md` §6 (D56): under "start cheap", step up the ladder (effort, then model, within the presets) at the next start when a merge is refused twice for the same reason, a turn stalls, or the agent calls `escalate {why}`; Details → Step up. At the top of the ladder, a Needs me card.
- **Acceptance Criteria:** A thread line and a record-only event per step; "strongest first" never steps; a model change ends a resting session (T465).
- **Validation Steps:** Unit tests per trigger with the fake agent; the ladder order; the top-of-ladder card.
  - Built: shared `model-escalation.ts` (`escalationLadder`: presets, or any installed model, by tier, cost, listed order; each model's efforts low → ceiling; one rung for a vendor with no effort. `nextRung`: the next effort on the model, then the next model at the effort it ran on, capped; a model outside the presets steps to the first preset above it; `undefined` at the top. `EscalationStateSchema` strict: `pending`, `stuck`, `refusal`, `quiet`, `context`; `QUIET_TURNS_MAX` = 3 as a constant; `steppedUpLine`, `stuckLine`, `StepUpView`). `Stream.escalation` is top-level and daemon-only (`DAEMON_ONLY_FIELDS`). `PICK_HOWS` gains `escalation`. The `escalate {why}` verb (strict, why ≤ 400) is added. The record-only routed event `model_escalated` (`step: up|stuck`) is added, routed to `self`. The inbox kind `model_stuck` is added.
  - Daemon: `routing/escalation.ts` `EscalationService` (`ModelPolicyService.escalation`). The triggers: `mergeRefused` through delivery's new `onRefused` (a ship check keyed by its rule or reason; a conflict keyed by its target; the same key after ≥ 1 turn between), `turnFailed` (T460, after T456's retry and fallback are spent), `turnEnded` (context > 90% without `goal_met`, once per session; quiet worker turns from the worktree HEAD, whose baseline is taken at the first start), `asked` (the verb), and `stepUp` (the operator). Start cheap records a pending step and ends a resting session. At the top, or under Strongest first, the node gets the Needs me card, a thread line and the event. The Default mode never escalates on its own. Attach's routed start takes the pending step in place of the kept pick and writes the "Stepped up to …" line, the event, and `agent.pick.how: escalation`. An explicit pick wins and spends it (and clears the card). A choose-again spends it. A carried start leaves it. After any turn end with a step waiting, the session ends instead of resting. `nextPick` names the step. The inbox derives `model_stuck`. HTTP `POST /api/streams/:id/step-up` and `/dismiss-stuck` are same-origin; a refusal returns 409. RPC `policy.step_up`; CLI `agile policy step-up --node N`. `VerbService.escalate` accepts a worker or coordinator session only (not a reviewer, the lessons pass or the Director). `progress` resets the quiet count. The worker brief lists `escalate`.
  - UI: Details → Model choice shows **Step up**, the next rung, the step waiting, why Step up is disabled, and the stuck reason. The Needs me card "Stuck on the strongest model" (Open node, Dismiss) is filed under Blocked. Events and Activity show "Stepped up to …" or "Stuck on the strongest model". The pick reads "Stepped up the ladder".
  - Tests: shared `model-escalation.test.ts` (16: ladder order, cost and listed order, vendors with no effort and uninstalled vendors, empty presets, duplicates, next effort, next model, top, over the ceiling, off the ladder, to and from a vendor with no effort, empty ladder, the daemon-only record, the verb can't carry a model, the schemas and the words). Daemon `routing/escalation.test.ts` (9: pending step, one per start, and a restart keeps it, with the `nextPick` preview; refused twice, same and different reasons; context; goal met; quiet turns, commit and progress; Default mode; top of the ladder, Needs me and Dismiss; Strongest first; Step up refusals and `policy.step_up`). Attach service T484 (10, fake agent: a failed turn, context over 90% ending the resting session, three quiet turns, a ship check refused twice with a turn between, `escalate` mid-turn changing nothing until the turn ends, Step up surviving a restart, an explicit pick winning, Strongest first going to Needs me, the top of the ladder and then an explicit pick clearing the card, and store refusals for agent, coordinator, Director and human). Verbs (2). http T484 (403 cross-origin, 409 before a start and at the top, 404, dismiss). CLI `policy step-up` (1). Control-room e2e T484 (2: Details → Step up shows the pending step and the chat line after the next start; the Needs me card at the top of the ladder, then Dismiss). Against the old `attach/service.ts`, 9 of the 10 attach tests fail. The one that passes is the store-level write refusal.
  - Validation: typecheck and lint clean. After `bun run build`, the full `bun test` gave 3746 pass, 3 skip, 0 fail across 228 files, with the control-room e2e included.
- **Notes:** Branch T484-escalation. The ladder didn't need `candidateForTier`: it sorts the presets itself. Not done: no live vendor run (none in the cloud), so LIVE-CHECKLIST §17's new escalation steps are unchecked. The reason text of a turn that failed quotes T460's words, which can be long; they are clipped at 500 characters.

### Ticket: T489 The vendor self-check
- **Priority:** P1
- **Status:** Todo
- **Owner:** manager
- **Scope:** D58. Pete (2026-09-30): the daemon runs the vendor checks itself and updates its own data. Per installed vendor: open a session with no node and no repo (like T467's Refresh), set a listed model other than its current one and read the reply back, set an effort level where the vendor reports a `thought_level` option and read it back, send one tiny prompt ("Reply with the single word OK."), record what usage it reported (T485a's fields), and where the provider supports it, stop and resume the session with `session/load`. Also record anything the vendor sends about rate limits or plan usage, for T491.
- **Acceptance Criteria:** A result per vendor and CLI version (model switch honoured / kept / refused, effort the same, usage fields, resume, rate-limit fields, when, errors in words), kept as a file in the probe session's own dir beside `session-state.json` (no new home dir). Runs on **Check vendors** (Settings → Agents), `agile vendors check [vendor]`, and after a T481 update or a new CLI version. Never under `bun test` against a real vendor. A vendor that isn't logged in says so. Choose leaves out a vendor whose last check says it ignores model picks, and says why. Settings → Agents shows the table. LIVE-CHECKLIST §12's last column, §12.2, §14 and §16 point at it.
- **Validation Steps:** Fake-agent tests for every outcome (honoured, ignored, refused, no effort option, usage present/absent, resume ok/failed, auth required); HTTP (403) and CLI; control-room e2e for the table and Check vendors.

### Ticket: T490 Tier first, and the vendor order for ties
- **Priority:** P1
- **Status:** Todo
- **Owner:** manager
- **Scope:** D57, D59. T483's Jev `model` question splits its confidence between near-equivalent models of different vendors (0.22–0.38 with mixed presets), so the scores always decided. Ask Jev for the tier instead; pick the model inside the tier by the operator's vendor order, then cost. Pete: "in a tie pick Anthropic > OpenAI", and "prefer OpenAI for review and Anthropic for code creation".
- **Acceptance Criteria:** The `model` question becomes `tier` (only tiers the presets have). Confidence ≥ 0.5 takes Jev's tier; below, the scores' rule gives the tier. Inside the tier: the vendor order (policy `vendor_order`, per role `vendor_order_by_role` for worker, coordinator, conversation, reviewer), then cost. A reviewer with no pick is routed the same way. A pinned rule may name only a vendor. Settings → Model choice: "When models tie, prefer" (ordered vendors) and per-role rows; Try it shows the tier and why that model. Real Jev runs with mixed presets show the tier's confidence.
- **Validation Steps:** Shared unit tests (tier pick, vendor order, per-role order, cost, a tier with one vendor, a vendor-only pinned rule); chooser tests with FakeClassifier; attach test for a routed reviewer; e2e for the settings; one real Jev run.

### Ticket: T491 Ration across subscriptions
- **Priority:** P2
- **Status:** Todo (after T489 shows what each vendor reports about its plan limits, and T485's usage)
- **Owner:** manager
- **Scope:** Pete (2026-09-30): if one subscription has less left this week than another, routing should use that. Two sources: what the vendor itself reports about its plan limits (if any; T489 records it), and the daemon's own count of weighted tokens per vendor over a rolling week (T485a's `usage.jsonl`) against an allowance the operator sets per vendor. A vendor near its allowance moves down the vendor order for routed picks; one past it is left out of routed picks, with a line saying so; explicit picks are never blocked, only warned. Design in `design/model-routing.md` §12.

### Ticket: T485a Record what each vendor reports about token usage
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** D51: budgets are built only after measuring which vendors report turn token usage (LIVE-CHECKLIST §16). The daemon kept only the context window's fill from `usage_update` (T411, in memory), and dropped the prompt reply's other fields, so there was nothing to measure with.
- **Acceptance Criteria:** Each session writes `sessions/<id>/usage.jsonl`: every `usage_update` raw, and one `turn_end` line per turn with the prompt reply's keys and its `usage`/`_meta` when present. Capped (2,000 lines, 4,000 characters a line). LIVE-CHECKLIST §16 says how to collect it.
- **Validation Steps:** Attach test with the fake agent reporting both; full suite.
  - Built: `acp-client`'s turn-end marker carries the prompt reply's `replyKeys`, `usage` and `_meta`; the runner's `recordUsage` writes `usage.jsonl` (`USAGE_LOG_FILE`). The fake agent's `end_turn` step takes `usage`.
  - Tests: attach T485a (a `usage_update` line with the raw update, then a `turn_end` line with `replyKeys` and `usage`).
- **Notes:** Branch T485a-usage-record. §16 was cited by the routing design and T485 before it existed; this adds it.

### Ticket: T485 Model routing: budget caps
- **Priority:** P2
- **Status:** Todo (measure first: LIVE-CHECKLIST §16 with T485a's `usage.jsonl`, which vendors report turn token usage)
- **Owner:** manager
- **Scope:** `design/model-routing.md` §7 (D51): budgets in weighted tokens (tokens × the model profile's cost), per session and per node. At 80% a chat line; at the cap the next turn waits and Needs me offers Raise the cap / Stop here. A vendor that reports no usage says so instead of estimating.
- **Validation Steps:** After §16: unit tests on the weighting and cap, and an attach test that the capped node waits.

### Ticket: T486 The classifier key never reaches a vendor's process
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** Found while reviewing T481. Every vendor spawn inherited the daemon's whole environment (`acp-client` `resolveAgentEnv` defaults to `process.env`), so when the operator supplied the TypeSafe key as `TYPESAFE_API_KEY`, every coding agent could read it with `env` and echo it into a thread, a file or a commit. That breaks D16 / design §6.1 (the key is the daemon's alone).
- **Acceptance Criteria:** `packages/daemon/src/secret-env.ts` `withoutDaemonSecrets` (one list, `DAEMON_ONLY_ENV_NAMES`) builds the env for:
  - node sessions and the Director (runner);
  - Refresh models (the catalog probe);
  - the quick drafts (`claude -p`);
  - the CLI updater (T481).
  `HOME`, `PATH` and vendor logins pass through untouched. `TYPESAFE_API_KEY` is the only daemon secret read from the environment; a key in `config.yaml` never enters the environment.
- **Validation Steps:** `secret-env.test.ts`; attach test T486 (the fake agent reports `classifier_key: false` while the daemon's env has one; it fails without the fix). Typecheck and lint are clean; full `bun test` 3585/0 (the T481 e2e failed once on a stale UI build and passed after `bun run build`); control-room e2e 133/0; walkthrough 1/0.

### Ticket: T469 Favourite models, and a picker that folds
- **Priority:** P2
- **Status:** Done (New node's Change keeps its three selects, with no stars: see Notes)
- **Owner:** manager
- **Scope:** Pete (2026-09-28): "we need a way to have presets/favorites. so, if i wanted to select 2 claude models and 3 codex models and 2 cursor models as my main selections, i should easily be able to see just those in the selection menu, or i can see all models for all vendors … at the bottom is a "show all" toggle … the vendor is collapsible".
- **Acceptance Criteria:** You mark models as favourites (a star in the picker, and in Settings → Agents), kept in the home config. With any favourites set, the model picker shows only those, grouped by vendor, plus the model a node runs now. A **Show all** switch at the bottom opens every vendor's models. Each vendor group folds, and the fold is remembered per browser. Typing still filters across everything. Builds on T467's lists.
- **Validation Steps:** Settings and picker e2e (star, favourites only, Show all, fold a vendor, type-ahead across all).
  - Built: `shared` `session-defaults.ts` (`FavouriteModelSchema` `{vendor, model?}`, no model = the vendor's own default; `FavouriteModelInputSchema` `{vendor, model?, on}`; `favouriteKey`; `SessionDefaultsStatus.favourite_models`), `home-config.ts` (`favourite_models`, at most 100, strict); `StateStore.setFavouriteModel` (a star goes at the end and keeps its place when starred again, `default` is stored as no model, the last unstar removes the key, `home_config_put` by `human`); `POST /api/settings/favourite-models` (same-origin, 400 on bad input) returns the session defaults, and `GET /api/settings/session` carries the list.
  - Picker (`ModelChoice`, so the composer's chip, Ask and Start with… / review / resolve): `lib/favourites.ts` `pickerView` takes `modelGroups`' groups (T467's lists and the built-in fallback) and narrows them. Something typed: every model whose name, id or vendor matches every word, folds ignored. Else, with any favourites and Show all off: the favourites, plus the pick and the model the live agent runs (the default alone is not kept). A favourite its vendor's reported list no longer has still shows, tagged "Not in Cursor's list now". Each row has a star button (`aria-pressed`, "Add … to favourites"); Enter on a row still picks it. A search box sits on top; typing on a row goes into it, and Enter there takes the first match. Group headers are buttons with a caret; folds and Show all are kept per browser in localStorage `agile.model-picker` (`lib/use-favourites.ts`, every access in try/catch). Show all is a switch at the bottom ("Show all (N more)"), shown only when favourites exist. With none, the picker lists everything as before.
  - The newest list reaches every open picker through `noteFavourites` (called by `getSessionDefaults` and `setFavouriteModel` in `api.ts`).
  - Settings → Agents → Models: each vendor has **Favourites**, which opens its models (a starred one it dropped too, marked), each with the same star; the row says "N starred".
  - Tests: shared `home-config.test.ts` T469 (4); `store.test.ts` T469 (3, one a hand-edited non-list refused, never replaced); http T469 (star/unstar, 403 cross-origin, 400 on a bad vendor, a missing `on`, an empty model or an extra key); `ui/app/lib/favourites.test.ts` (11: no favourites, favourites plus what runs, the pick kept, Show all, folds, search across all, an unlisted favourite, a vendor default, matching, prefs parsing, fold toggling); control-room e2e "Favourite models (T469)": star in Settings, the picker shows only the favourites and the default, Show all shows every vendor, Enter on a star stars grok-4.7, fold Cursor and reload (still folded, count shown), typing finds non-favourites (and one in the folded group), Enter picks, Enter on a row picks, unstar from the picker.
  - Validation: typecheck and lint clean; full `bun test` 3605 pass, 3 skip, 0 fail; control-room e2e 134/0 (after `bun run build`); walkthrough 1/0 (43 steps, 0 findings).
- **Notes:** Branch T469-favourite-models. Not done: New node's **Change** uses `SessionFields` (three native selects, per vendor), not the model picker, so it has no stars or favourites filter; stars there would mean moving New node onto `ModelChoice`, which is a separate change.

### Ticket: T468 Model and effort as two controls; Shift+Tab cycles effort
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** Pete (2026-09-28): "separate the model and effort with model indicator on left and effort on right. shift-tab should be used to cycle through effort levels."
- **Acceptance Criteria:** The composer bar shows the model chip on the left and an effort chip on the right (only for a vendor that takes effort, T401). Shift+Tab in the composer cycles low → medium → high → max, and the effort chip changes with it. The pick lasts like the model pick (T423, T464).
- **Validation Steps:** The composer's model chip shows the model alone (`ModelChip modelOnly`). `EffortChip` sits right of it, before Stop and Send, and is absent for a vendor with no effort setting. A click or Shift+Tab in the box steps low → medium → high → max → low, with focus kept. The step sets the next message's pick, as the model chip does, so it lasts one message and restarts a live agent with it. It is highlighted only when the effort differs from what runs. The Ask box keeps its one combined chip. e2e T468 (position, Shift+Tab ×2, click, the start runs on max); the T423/T464 e2e and walkthrough 8.4 read the two chips. Full `bun test` 3486/0; walkthrough clean.
- **Notes:** Branch T468-model-effort-chips.

### Ticket: T468b Typecheck: the T468 e2e read `document` in a Node-typed file
- **Priority:** P0
- **Status:** Done
- **Owner:** manager
- **Scope:** T468's e2e checked focus with `input.evaluate((el) => el === document.activeElement)`. The daemon package has no DOM lib, so `bun run typecheck` failed on 20eb79cc. I ran the suite, lint and the walkthrough before pushing, but not typecheck after adding the test.
- **Acceptance Criteria:** The check reads the focused element's testid through a string `evaluate`, as the other focus checks in the file do. Typecheck is clean.
- **Validation Steps:** `bun run typecheck` clean; e2e T468 passes.
- **Notes:** Branch T468b-typecheck.

### Ticket: T470 Needs me as a true inbox
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** Pete (2026-09-28): "this is lots of noise … not going to be scalable to have all these cards for every node that's finished when i have tens of projects going on. we should rethink this to be like a true inbox. i should see agent and subject and then can click to close the node or click to open it up (2 buttons). i can also select multiple … select all finished … close all finished."
- **Acceptance Criteria:**
  - One row per item: a checkbox, the kind's icon, the agent (the vendor it runs or last ran), the node's title as the subject, what it is and a one-line summary, and its age. Each row has **Close** (the node) and **Open**. Clicking the row itself expands the full card in place, where a question is answered or a merge made.
  - Categories with counts: All, Questions, Decisions, Merges, Finished (nothing to merge), Blocked.
  - Selecting: tick rows, or the header box selects everything shown. A bar then offers **Close N**, which asks once. **Close all finished** closes every Finished row.
  - Keys: `j`/`k` move, `x` selects, Space expands, Enter opens.
- **Validation Steps:** `ui/app/lib/inbox.test.ts` (categories, `nodesOf`); the control-room e2e for rows, the category tabs, a select and bulk close, Close all finished, and a row expanding to answer a question; the existing Needs me e2e tests follow the rows.
- **Notes:** Branch T470-needs-me-inbox.
  - `Inbox.tsx`: `InboxRow`, the selection bar and `useRowKeys` (focus on a row or its expanded card).
  - `lib/inbox.ts`: `filterOf` with the Finished and Blocked categories, `nodesOf` and `inboxLine`.
  - The cockpit row gains `last_agent` (the vendor and model its agent last ran), so a finished node names its agent.
  - **Expand all** (per browser) opens every card. The control-room tests that act on cards and the walkthrough start with it on; the T470 test covers the rows as a new browser has them.
  - Results: control-room e2e 123/123; walkthrough 43 steps, 0 findings.

### Ticket: T471 Closed means inactive, not read-only; Trash with Delete forever
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** Pete (2026-09-28): a closed node reads as read-only, yet "there's no reason we can't restart the thread". Deleted nodes can only be restored, never deleted for good. A deleted open node restores and resumes, while a deleted closed one restores but can't resume. "should closed really mean read-only? it seems more like we're done being active in this for now, and deleted/trash means we think we're done … for good (but still could revive it)".
- **Acceptance Criteria:**
  - **Closed** = inactive: out of Needs me and folded in the tree. A message to it (or **Reopen**) reopens it on the same branch and worktree and wakes its agent.
  - Delete is renamed **Move to trash**. **Restore** brings a node back open and ready to resume, whatever state it was in.
  - **Delete forever** (per node, and **Empty trash**) removes the node's record, thread, session files and worktree. Its branch goes too if merged. With unmerged commits the branch is kept unless you tick "Also delete its branch (N unmerged commits)" (D47: confirmed by Pete).
  - A merged node is unchanged.
- **Validation Steps:**
  - Closed: `StreamService.reopen` (open again, thread line "reopened"). `say` reopens a closed node first, so a message wakes its agent (attach test "a merged node starts nothing, a closed one reopens"). The composer's hint reads "Reopens this node and wakes the agent…". The header has **Reopen**, as does ⋯. `POST /api/streams/:id/reopen`.
  - Restore brings the node itself back open, even if it was closed; its parts keep their state.
  - Move to trash replaces Delete (tree menu, node ⋯, dialogs, toasts). The sidebar's Deleted section is **Trash**, with Restore, a per-row Delete forever (✕) and Empty trash.
  - Delete forever is `streams/trash.ts` (`TrashService`) plus `StateStore.removeStream`, a new `stream_deleted` event (log reconstruction forgets the node). It removes the node and its subtree: record, thread, card and event queue, questions, gates, plan, other nodes' waits on it, session logs and worktree. A merged branch goes too. One with unmerged commits is kept unless "Also delete its branch (N unmerged commits)" is ticked. The dialog also names worktrees with uncommitted changes, which are lost. Routes: `GET /api/streams/:id/trash-preview`, `POST /api/streams/:id/purge {delete_branches?}`, `GET /api/trash`, `POST /api/trash/empty`. Same-origin; refusals are 409 (not in the trash, a project's root).
  - Tests: `streams/trash.test.ts` (6, real git), http T471, attach test updated, UI lib tests updated, e2e T471 (Reopen, Delete forever keeping the unmerged branch, Empty trash), T365/T361/T416 e2e updated for the new words. A worktree path outside `<repo>/.worktrees/` is never removed (a test that fails on the unguarded code, where it deleted the repo). Full `bun test` 3481/0; walkthrough clean.
- **Notes:** Branch T471-trash-and-reopen. The unmerged-branch default (keep it unless ticked) is D47, confirmed by Pete.
### Ticket: T476 Cursor's verbs and commands were refused
- **Priority:** P0
- **Status:** Done
- **Owner:** manager
- **Scope:** Found by Pete in the live walkthrough (2026-09-28). The log showed that every Cursor call to our own verbs was refused: "unknown tool kind (agile-progress: progress) — safe default deny". Every exec was refused too: "execute request carries no command to classify at this tier". Cursor names MCP tools `agile-<verb>: <verb>` (Codex: `mcp.agile.<verb>`), and only Claude's `mcp__agile__<verb>` was recognised. Cursor's exec request doesn't carry `rawInput.command`, and a request with no command was refused with no card, although a hook-less vendor has no other gate to fall back on.
- **Acceptance Criteria:**
  - A verb titled the Cursor or Codex way passes when its input carries this agent's own daemon session id, so a lookalike "agile" server can't borrow the pass.
  - An exec's command is read from `command`, `cmd`, `commandLine`, an argv array, a backtick or "Terminal: …" title, or the call's text content.
  - A command still unreadable from a hook-less vendor is a card for you; a hooked vendor keeps the refusal, since its hook sees the command.
  - The decision log records the request's kind, title and input keys.
- **Validation Steps:** `permissions/decide.test.ts` T476, built from the log's shapes. The next live Cursor run confirms the exec shape from the new log fields.
- **Notes:** Branch T476-cursor-verbs-and-commands. Cursor's exact exec shape isn't known yet; the new log fields name it.

### Ticket: T473 Ask and Work are one kind of node
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** Pete (2026-09-28): "an ask agent knows how to do work … a work node knows how to do research. switching between modes should be painless. today it's a restriction." New node always makes a work node.
- **Acceptance Criteria:** New node offers "No repository (just talk)". A work node can go back to talk: its branch and worktree are kept, and its role becomes conversation. `N` is New node (already); `a` stays Ask.
- **Validation Steps:**
  - New node opens with **Talk · Work** as its first choice. Talk = no repository; Work = the project's repository (or Add a repository when there is none). The picker's option reads "No repository (just talk)".
  - ⋯ **Back to just talk…** on a work node (`RepoInPlaceService.toTalk`, `POST /api/streams/:id/to-talk`) stops its agent. It moves the repo, branch and worktree to `parked` on the record (nothing on disk changes), and the node is a conversation. Refused for a helper, an open PR, a coordinating node, or a closed or trashed one.
  - ⋯ **Back to work on <repo>** (or Turn into work, or + Repo, with that repo) resumes the same branch and worktree. It checks the branch out again if the worktree was removed. Another repo starts fresh, and the parked work stays parked.
  - Also fixed: the Close dialog still said "it can't be reopened" (T471).
  - Tests: `repo-in-place.test.ts` T473 ×2 (real git: commits survive the round trip); e2e T473. Full `bun test` 3484/0.
- **Notes:** Branch T473-talk-and-work. A node holds one parked repo: going back to talk from a second repo replaces the first parking (its branch stays on disk).

### Ticket: T474 Reorder sibling nodes by dragging
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** Pete (2026-09-28): dragging makes parent/child moves; it should also reorder siblings.
- **Acceptance Criteria:** Dropping between two siblings places a node there. The order is kept on the node record (an `order` key among its siblings) and used by the rail and Overview.
- **Validation Steps:** A drop on a row's top or bottom quarter places the node before or after it: a line shows where. The middle still nests under it, and a project's row only nests. `StreamService.reorder` moves the node to the anchor's parent first if needed (with `move`'s checks), then renumbers the siblings 0, 1, 2… and writes only those that changed (`order` on the record, `POST /api/streams/:id/reorder {before|after}`). The rail sorts siblings by `order`, with unordered nodes after, in creation order. The Overview uses it within a status. Tests: service T474 ×2, `tree.test.ts` (`dropZone`, `checkPlace`), e2e T474 (top edge → first, bottom edge → last); the T333 drag e2e still nests on the middle. Full `bun test` 3491/0.
- **Notes:** Branch T474-reorder-siblings.

### Ticket: T475 A finished reply is never folded
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** Pete (2026-09-28): "i should never have to click show more to see all the output. only if i have closed it on my own with show less first".
- **Acceptance Criteria:** A long message shows in full, with **Show less** to fold it. A fold you made is kept for that message.
- **Notes:** Branch T475-replies-unfolded. `ThreadBody` (Chat.tsx) opens whole. A fold you make is kept by the message's `ts` for as long as the page is open. The control-room e2e (T330's test, updated) checks the message opens whole, Show less folds it, and the fold survives a tab change.

### Ticket: T477 A node without a goal; dismiss a Finished card
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** Pete (2026-09-28): "there can never not be a goal … i want to ask a question related to what its goal will be and THEN give it a goal. i should not see a finished card like this until i've explicitly given it a goal and it's finished with it. also whenever there is a finished card i should be able to discard the message with an X".
- **Acceptance Criteria:** A node can be created with no goal. Its agent just talks, and a finished turn is not "Finished". Giving it a goal (the goal card, or Turn into work) makes finishing it count. A Finished card or row has an ✕ that dismisses it until the node finishes again.
- **Validation Steps:** `goal` is optional in `StreamSchema`/`StreamCreateInputSchema`; every `.goal` reader handles none (brief `NO_GOAL_YET`, "(no goal yet)" for an ancestor, the first goal's thread line reads "goal set: …"). The inbox skips `done` for a node with no goal and for one whose `human.dismissed_at` is at or after `agent.updated_at`; the cockpit row carries `no_goal`, so Replies lists it. `POST /api/streams/:id/dismiss` (same-origin, human). The ✕ is on the Finished card (node page and Needs me) and on a Finished row. New node has "No goal yet: talk it through first": the text becomes your first message. Tests: inbox service (no goal, dismiss and re-finish), brief, http dismiss + goal set/changed, unread `no_goal`, e2e T477 ×2. Full `bun test` 3457/0; control-room e2e 125/125.
- **Notes:** Branch T477-no-goal-and-dismiss.

### Ticket: T478 Auto-close when the goal is met
- **Priority:** P1
- **Status:** Done
- **Owner:** manager
- **Scope:** Pete (2026-09-28): today nothing closes a node on its own. No agent can close its node, a coordinator can't close its parts, and the daemon never closes a finished node. "when i manually create a node and set a goal, there should be a toggle on the node to auto-close (when goal is met). this setting should exist and be able to change even after the node's been created."
- **Acceptance Criteria:** New node and the node's page (header ⋯ and Details) have an **Auto-close** toggle, stored on the node and changeable any time. With it on, a node whose agent finishes its goal with nothing to merge closes itself, with a thread line; with changes, it stays Ready to merge. A coordinator's parts inherit it when it adds them, and a coordinating node with auto-close closes once every part is merged or closed. The default is a setting.
- **Validation Steps:** "Goal met" needs a signal: every finished turn ends `done`, including one that stops to ask. So the agent reports it with a new verb, `goal_met` ({summary}), recorded as `agent.goal_met` with its session. The brief of an auto-close node tells the agent when to call it and when not to. `streams/auto-close.ts` runs from `onUpdated`: a node closes when its turn ends `done` having said `goal_met` in that session, with nothing to merge. Nothing to merge means preflight counted `ahead === 0` (or the branch was already merged), no conflict and no uncommitted tracked change; it fails closed when the preflight can't count. A coordinating node closes when every part is landed or closed. Never a root, a node with no goal, an archived one, or a running one. `auto_close` is human-only (the two-writer split) and a part inherits it at create. Routes: `POST /api/streams/:id/auto-close`, `GET/POST /api/settings/auto-close`. UI: Settings → General card, New node switch (seeded from the setting), node page Details switch and ⋯ item. Tests: `auto-close.test.ts` (8), goal_met verb (2), shared verb list, http ×2, daemon wiring (real git: a clean branch closes, a commit stays), e2e T478. Full `bun test` 3471/0; control-room e2e 126/126. LIVE-CHECKLIST §13.
- **Notes:** Branch T478-auto-close. The daemon test caught a real bug: a preflight refusal (a live session) returned no `ahead` and read as "nothing to merge". Fixed to fail closed.

### Ticket: T472 The Ask box has the model picker
- **Priority:** P2
- **Status:** Done
- **Owner:** manager
- **Scope:** Pete (2026-09-28): "when i press 'a' to ask the regular model selector should be there".
- **Acceptance Criteria:** The Ask box shows the composer's model chip, and the conversation starts on the pick.
- **Validation Steps:** The Ask box shows `ModelChip` (T423's) under About, for any node target (not the Director, which runs its own agent). It reads the defaults for where the question is asked. A pick creates the conversation with `start: false` and attaches its worker on the pick, as New node does. `ModelChip` takes `placement`; Ask opens it downward, because upward it opened off the top of the dialog (the first e2e run couldn't click an option). e2e T472 checks the session runs `claude-sonnet-4-6`. Full `bun test` 3485/0.
- **Notes:** Branch T472-ask-model-picker.

### Ticket: T457b CI: a dangling symlink read as the dir it sits in
- **Priority:** P0
- **Status:** Done
- **Owner:** manager
- **Scope:** CI failed on 245d0beb: T457's "no spelling reaches the home or a credential under Trusted" allowed `<dir>/link-ssh/id_rsa` on the runner, whose home has no `~/.ssh`. `realpathNearestExisting` walked up from a symlink whose target doesn't exist and judged the path by the dir the link sits in. The same gap let a write through a dangling link inside the worktree that points outside pass the containment check.
- **Acceptance Criteria:** A dangling symlink is followed by its text (up to 40 links), for reads and writes alike.
- **Validation Steps:** Reproduced with `HOME` set to a dir without `.ssh` (the T457 test fails there on the old code, passes now); `decide.test.ts` "T457b: a dangling symlink is followed by its text" fails on the old resolver; full `bun test` 3377/0.
- **Notes:** Branch T457b-dangling-symlinks.

### Ticket: T423b CI: the picker's model read before it loaded
- **Priority:** P0
- **Status:** Done
- **Owner:** manager
- **Scope:** CI (runs 1353, 1355) failed "stream page (T161) › attach → question → answer → findings → land": `pickedModel` read the picker's checked model right after the dialog opened, before its session defaults arrived (a fetch on mount), and got `undefined`. It passed locally on faster timing.
- **Acceptance Criteria:** `pickedModel` waits (up to the poll deadline) for a checked model before reading it. Reproduced with the fetch held 1.5 s in the page (the old helper fails with CI's exact `undefined`; the new one passes). `page.route` can't hold it: the cockpit's service worker makes the request.
- **Validation Steps:** control-room e2e "attach → question…", the T423 picker tests.
- **Notes:** Branch T423b-picked-model-race.

### Ticket: T424c The Repos lens reads status as pills
- **Priority:** P3
- **Status:** Done
- **Owner:** manager
- **Scope:** T424's leftover: the Repos lens's live-node rows showed status as plain coloured text beside a dot, while Dependencies and Running use `StatusPill`.
- **Acceptance Criteria:** A repo card's node rows: the path, then the node's `StatusPill` at the right; the old `.cr-lens-status` style is gone.
- **Validation Steps:** control-room e2e "two api nodes in different projects…" (the pill), the lens tests.
- **Notes:** Branch T424c-repos-lens-pills.

### Ticket: T369 Phase 15 QA
- **Priority:** P0
- **Status:** Done
- **Owner:** manager
- **Scope:** The whole offline gate on the integrated branch; a screenshot pass over every view, light and dark, desktop and phone width; deferred findings in `design/cockpit-ui-followups.md`.
- **Acceptance Criteria:** Gate green; follow-ups written.
- **Validation Steps:** `bun install && bun run build && bun run typecheck && bun run lint && bun test && bun run test:integration && bun run test:e2e && bun run test:walkthrough`.
- **Notes:** Branches T369-phase-15-qa, T369-ci-card-order, T369-wrapup. Gate on the integrated tip: lint and typecheck clean, `bun test` 2869 pass / 0 fail, integration and e2e green (control-room 68/0 after T380), walkthrough 39 steps, 0 findings. QA fixes: a node's Activity reads like Events (titles, routing words), the walkthrough and checklist follow; the j/k e2e reads Needs me's order from the page (two cards raised in one millisecond sort by id, which failed CI twice); the design doc names the palette and keys. The screenshot pass (every view, light, dark, phone) found T381's wording. Remaining findings: `design/cockpit-ui-followups.md`.

## 8. Deleted (must be gone from `main` by the end of Phase 6)

Daemon: `em/`, `architect/`, `oracle/`, `qa/`, `halts/`, `quota/`, `handoff/`, `plan/`, `review/` rounds, `sync/` (shelved on a branch), `feed/stories.ts`, `runner/pipeline-glue.ts`, sprint parts of `merge/`, `bus/` unless the thread reuses it. CLI: `run`, `send`, `halt`, `approve`, `sync`. Shared: `Ticket`, `Sprint`, `Stanza`, `Message`, `Halt`, `Quota`, `Review`, `Qa`, `Oracle`, `Kb`, `Ledger`. Briefs: all but `worker.md`, `reviewer.md`, `lessons.md`. UI: `plan/`, `sprint/`, `review/`, `OraclePanel`. State: the `agile-state` orphan branch and per-repo `.agile/`.

## 9. Open questions

- Q1. Should a coding stream's target default to an integration branch (current behaviour) or straight to `main` when the repo has no integration branch? Plan assumes the repo's default branch; Pete to confirm at T132.
- Q2. Classifier thresholds (0.80 / 0.40 / confidence 0.50) are starting points; T153's live agreement rate decides whether to move them.
- Q3. Whether `bus/` survives as the thread's transport or is deleted; decided in T120 by whichever is less code.
- Q4. Whether repo docs live in `.agile-docs/` (tracked) or under the home (untracked). Plan says tracked so a repo carries its own guidance; Pete to confirm at T134. Superseded by D24: docs move to the home (T207).
- Q5–Q24. The proposed decisions P1–P20 in `design/projects-design.md` §19 are open until Pete confirms each one as a D-entry. Tickets assume them. P17 (tracker tokens in `config.yaml`, a second credential exception) must be approved before T320.
- Q25. D36 D10 (T351) wakes every finished conversation in an accepted item's scope, so one project-wide decision starts up to five vendor turns (audit r6 #9). T437 stopped those turns from reading as unread replies. Narrowing the wake to the conversation the item came from (its `source.node`) or a subtree scoped to it would save the turns; the rest would get the item on their next turn, as before D10. Pete to decide; the walkthrough's "Cents check" step assumes the wide wake. **Answered by D44 (2026-09-27): narrowed, T453.**

## 10. Discovered Issues Log

- 2026-09-26 Pete: the cockpit is rough; asked for a full UX overhaul (his list is in Phase 15's intro) → Phase 15 (T360–T369), design in `design/cockpit-ui.md`, on `claude/phase-14`.
- 2026-09-26 (T345 worker): a lone `&` was not a command separator in `splitCommandSegments`, so `echo hi & cat /etc/passwd` and `true & rm -rf ~` were auto-allowed for engineers since phase 7. Fixed on ci-fix-lone-ampersand (6ea669a), merged 7→14; reviewed (sonnet) APPROVE.
- 2026-09-26 (T344 review): T336's `waitingForPlan` re-flagged a part that had started and gone idle, so plan approval could restart it and the rail/card said "waiting" again. Fixed on ci-fix-waiting-started (3e8724d, phase-11): waiting ends once a session starts after the split's waiting line (ULID time). Merged 11→14; reviewed and QA'd (sonnet).
- 2026-09-25 (CI, phase 9): T131's rule "a reviewer's exit sets `agent.status` done when no worker is live" reversed. A reviewer that died at spawn marked a never-worked stream done. A review is not work, so a reviewer exit now only posts "review finished: N findings"; only a worker (from phase 11, a coordinator) exit moves `agent.status`. Branch ci-fix-review-status (81569dc) on phase-7, merged forward 7→14.

- 2026-09-25 Pete: tangents (D33) and manual moves (D34) approved → Phase 14 on `claude/phase-14`. Cleanup phase starts after Pete finishes the walkthrough.

- 2026-09-25 Pete (walkthrough): wants conversation nodes to have children (tangents / research branches that don't clog the main thread), and disagrees with "you never restructure the tree by hand" — wants manual restructuring. Both change the design (§6 roles, P1); proposals put to Pete before tickets.

- Phase 13 complete on `claude/phase-13` (2026-09-25): T320–T324, T326 merged, T325 QA ACCEPT; awaiting Pete's look. All planned tickets for Phases 7–13 are Done. Open for Pete: daemon is 30,494 lines against D18's < 20,000.

- Phase 12 complete on `claude/phase-12` (2026-09-25): T300–T303, T305 merged (plus T290/T291 on phase-11), T304 QA ACCEPT; awaiting Pete's look. Phase 13 proceeds on `claude/phase-13`.

- 2026-09-25 Pete: skip `Contract.paths` (T284); the import-index alerts cover contract breakage. Revisit only if a miss shows up.
- 2026-09-24 Pete: Director keeps role `coordinator` for now (may get its own role later). A new project is always a draft (T301), agreed. Director repo reads → T305. T268: file-by-file chunks plus the changed-file list stay; no whole-diff summary.

- 2026-09-24 Pete: `proposals/<AP-id>.yaml` home dir APPROVED (T282). T287 question answered: coordinator notes wake ended work nodes (T290).
- Phase 11 complete on `claude/phase-11` (2026-09-24): T280–T288 merged, T289 QA ACCEPT; awaiting Pete's look. Open for Pete: `proposals/` home dir (T282); `Contract.paths` for the contract-touched alert (T284); should `coordinator_note` wake a finished work node (T287). Phase 12 proceeds on `claude/phase-12` (draft PR https://github.com/petestewart/agile-agents/pull/8 for Phase 11).
- Phase 10 complete on `claude/phase-10` (2026-09-24): T260–T266 merged, T267 QA ACCEPT; T268 (real-classifier ship hold) before Pete's look. Phase 11 proceeds on `claude/phase-11`.
- Phase 9 complete on `claude/phase-9` (2026-09-24): T240–T246 merged, T247 QA ACCEPT; awaiting Pete's look (draft PR https://github.com/petestewart/agile-agents/pull/6, base claude/phase-8). Phase 10 proceeds on `claude/phase-10`.
- (Pete, 2026-09-24) P13 bullet 1 (leave a private repo out of a session's readable directories) is deferred until it becomes a need; the hook check (T229) stands alone.
- Phase 8 complete on `claude/phase-8` (2026-09-24): T220–T229 merged, T230 QA ACCEPT; awaiting Pete's look (draft PR https://github.com/petestewart/agile-agents/pull/5, base claude/phase-7). Phase 9 proceeds on `claude/phase-9` cut from it.
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

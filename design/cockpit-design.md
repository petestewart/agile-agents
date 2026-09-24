# Cockpit — Design Doc

Agile Agents, reshaped: an operator's cockpit for running several work streams with coding agents attached. Living doc; reads as the current design, not a history.

Last updated: 2026-09-19 (T101). Supersedes `design/agile-agents-design.md`, which is kept for its §8 ACP adapter contract and §6 hook catalog — both still valid. Per-vendor gating behaviour is **not** re-derived here: `design/spike-findings.md` is the measured reference and is cited throughout.

The board is `PLAN.md` (tickets T100–T164). Decisions D1–D11 in `PLAN.md` §2 are the input to this document; each appears below at the point it applies, with its rationale.

---

## 1. Problem and operator journey

### 1.1 The problem

One person manages several work streams all day, in parallel:

- a **software project** — a goal broken into pieces, each piece being worked by a coding agent in its own worktree;
- one or two **investigations** — a customer issue, a production anomaly, a "why is this slow" thread that may or may not become code;
- one or two **planning threads** — a feature being shaped, a decision being argued, no code yet;
- and, cutting across all of them, a steady flow of **questions**: from the agents that need a decision to continue, and from humans (support, management) that arrive mid-task and must not be dropped.

The tool's job is narrow and it is three things:

1. **Hold the context per stream** so picking a thread back up costs nothing.
2. **Say what needs the human right now**, across every stream, in one place.
3. **Let the human hand a chunk of work to an agent** and get it back without losing the thread.

Everything else is decoration.

### 1.2 What the previous design got wrong

The previous system (`design/agile-agents-design.md`) modelled an engineering *organisation*: an EM, an architect, an oracle, engineers, reviewers, QA, plus sprints, standups, retros, refinement, pointing, quorum, halts and ripple, quota handoff, and a vendor barometer. That simulation has two real motivations buried in it, and they are kept:

- **the system learns from its own work** — the retro, generalised into *lessons* (§5.5);
- **a decision made once is obeyed on future work** — the oracle and its ripple walk, generalised into *rules* (§5).

Everything else in the simulation is a costume. Simulating a manager to relay instructions from the real manager to the agents adds a lossy hop, a model's worth of latency and tokens, and an entire class of "the EM misread you" failures. **D2: no simulated manager.** The resident EM, the EM delegate, and every ceremony (sprint review, retro, standup, refinement, pointing, quorum) are deleted. The human *is* the manager; the inbox is how they manage.

**D3: roles collapse to worker and reviewer.** Architect, oracle, reader and QA were role names for prompts, not for capabilities the harness enforces. Useful brief text from each folds into the worker brief or becomes a rule; the roles themselves go. Rationale: every additional role is a brief to maintain, a permission row to keep correct, and a place for work to get stuck waiting on a persona.

### 1.3 The three stream types

A stream is one unit of work with a goal and a thread (§2). Three shapes recur; they are not separate types in the schema, only in how the operator uses them.

| Shape | Has repo? | Agents attached | Ends with |
|---|---|---|---|
| **Coding** | yes — branch + worktree | worker, then reviewer on demand | **Land** (merge into the target branch) |
| **Investigation** | sometimes (read-only work in a worktree, or none) | worker, usually one | a conclusion in the thread; often a new coding stream as a child |
| **Planning / question** | no | often none — the human thinks in the thread | a decision, a rule proposal, or a child coding stream |

The important property: **a stream with no repo is fully usable.** It has a thread, it can hold questions, it can have a worker attached that never touches git. The support question that arrives mid-task becomes a stream in one line of typing (§9.4), and it lives in the same tree and the same inbox as the three-week refactor.

**D1: streams replace sprints, tickets, epics and teams as the unit of work. Streams nest.** Rationale: the old model needed four nouns (epic → sprint → ticket → team) to say "this work is part of that work". Nesting one noun says it, and it says it for investigations and planning threads too, which the ticket model could not represent at all. A sprint is just a parent stream whose children are in flight; an epic is a parent stream with more children; a team is the set of sessions attached beneath a parent.

### 1.4 The question flow

This is the loop the whole design exists to serve.

```
agent hits a fork it cannot decide
        │  MCP verb: ask(stream, question, options?)
        ▼
daemon writes a Question record, appends a `question` entry to the thread,
sets stream.agent.status = 'question', and the session BLOCKS
        │
        ▼
inbox item appears (all streams, oldest first), pushed over the ws — no reload
        │
        ▼
human answers inline from the inbox card (free text, or one of the options)
        │
        ▼
answer appended to the thread, delivered to the waiting session,
stream.agent.status back to 'working'
```

Three properties are load-bearing:

- **The session actually blocks.** It does not guess and continue. A wrong guess costs a worktree of wasted work; a blocked session costs nothing but wall-clock.
- **Questions are records with a status, not mail.** The 2026-09-11 live run surfaced stale questions from a previous daemon run appearing in the inbox, because the inbox was a bus drain. A question that is answered is answered forever; there is no drain at start (T121).
- **The same inbox carries gates.** "Answer this question", "accept this proposed rule", "this tool call was routed to you", "land this stream" are four kinds of one list (§3).

### 1.5 The operator journey

The journey the UI is measured against (it replaces §17's ten-step journey in the old doc):

1. **Start the daemon once.** It is not per repo and it does not exit when work finishes (§7.1, D9).
2. **Register a repo** (`agile repo add ~/Projects/ledger-lite`). Protected branches default to `main`, `master`.
3. **Open a stream** — a goal in one paragraph. Optionally with a repo. Optionally under a parent.
4. **Break it down** by creating child streams, by hand or by asking an attached worker to propose them (`propose_next`).
5. **Attach a worker** to each child. The daemon makes the branch and worktree, assembles the brief, spawns the vendor session, and streams its output into the thread.
6. **Answer questions from the inbox** as they arrive, from any stream, oldest first.
7. **Review** a stream when its worker says done — a reviewer session, read-only, findings into the thread.
8. **Land** it: a button. Diff-level rules run, the branch merges into its target, the stream closes.
9. **Accept the lessons** the daemon proposes at close — at most three rules, each with examples.
10. **Watch a rule bite** on the next stream: a tool call denied with the rule named, or routed to the inbox for a decision.

Steps 1–9 are `LIVE-CHECKLIST.md` (rewritten in T164). Step 10 is the payoff: the system got stricter because of what happened last time, and the human decided that it should.

---

## 2. The stream model

### 2.1 The record

`packages/shared/src/stream.ts`, zod, `.strict()` like every other schema in that package.

```ts
Stream = {
  id: string,              // ULID
  title: string,
  goal: string,            // one paragraph, plain language
  parent?: string,         // Stream id; unlimited depth, cycles rejected
  repo?: string,           // path key into repos.yaml; absent for planning streams
  branch?: string,         // created on first attach, not on create
  worktree?: string,       // <repo>/.worktrees/<stream-id>-<slug>
  target_branch?: string,  // landing target; default from repos.yaml
  created_at: string,

  agent: {                 // AGENT-OWNED — the store rejects human writes here
    status: 'idle' | 'working' | 'blocked' | 'question' | 'done',
    progress?: string,
    findings?: Finding[],
    proposed_next?: string[],
    updated_at: string,
  },

  human: {                 // HUMAN-OWNED — the store rejects agent writes here
    status: 'open' | 'waiting_on_you' | 'landed' | 'closed',
    decision?: string,
    answered_at?: string,
    note?: string,
  },

  sessions: SessionRef[],
}

SessionRef = { id, vendor, model, role: 'worker' | 'reviewer', status, worktree? }

Finding = { severity, file, line?, text }
```

Thread entries are a separate append-only file (§7.3):

```ts
ThreadEntry = {
  ts: string,
  by: 'human' | `agent:${string}` | 'daemon',
  kind: 'line' | 'question' | 'answer' | 'event' | 'finding' | 'proposal',
  body: string,            // capped (800 chars default); overflow goes to a file with a ref
  ref?: string,            // pointer to the full artifact under sessions/<id>/
}
```

Nesting is unlimited in depth. A cycle (making a stream its own ancestor) is rejected by the store, not by a caller's discipline.

### 2.2 The two-writer field split

This is the one structural idea in the record, borrowed from KiroCrew's agent-owned vs human-owned ledger fields (**D11**).

Two principals write to a stream: the agent (through MCP verbs and the runner) and the human (through the UI and CLI). A single flat status field means the last writer wins, and the loser is usually the human: an agent finishing a turn overwrites "I decided to abandon this" with "done". The old design papered over this with halts and ripple — a whole subsystem to undo what a flat field lost.

So the record has two sub-objects and the store enforces the split by principal:

| | writes `agent.*` | writes `human.*` |
|---|---|---|
| principal `agent:<session-id>` | yes | **rejected** |
| principal `human` | **rejected** | yes |
| principal `daemon` | yes (lifecycle: session exit → `agent.status: done`) | yes (landing → `human.status: landed`) |

Rules:

- Every store write carries a principal. There is no unauthenticated write path; the HTTP edge stamps `human` and never accepts a principal from a request body (this was a real T025 security finding: `POST /api/hil/:id/approve` trusted `by` from the body).
- `agent.status` is *what the agent believes*. `human.status` is *what the operator has decided*. They are allowed to disagree — `agent.status: done` with `human.status: open` is the normal "waiting for me to review and land" state, and the UI reads exactly that pair to colour the tree dot (§9.2).
- The same split governs rules: an agent may create a rule with `status: 'proposed'`; `status`, `decided_at` and `decided_by` are human-only (§5.1, **D4**).
- Unit tests assert the rejection in both directions; a violation is a store error with the path and the field, not a silent drop.

### 2.3 Lifecycle

```
create ──► human.status: open, agent.status: idle
   │
   ├─ attach worker ──► branch + worktree created (if repo) ──► agent.status: working
   │       │
   │       ├─ ask ──────► agent.status: question, human.status: waiting_on_you, session blocked
   │       │   └─ answer ─► agent.status: working
   │       │
   │       ├─ hook route ► agent.status: blocked, human.status: waiting_on_you  (§6.3)
   │       │
   │       └─ session exit ► agent.status: done
   │
   ├─ review ──────────► reviewer session, findings → thread + agent.findings
   │
   └─ land ────────────► diff rules ──► merge ──► human.status: landed ──► lessons proposed
                              │
                              └─ deny / conflict ──► agent.status: blocked, worktree kept
```

One live worker at a time per stream. A reviewer may run concurrently with a finished worker; it cannot write (§4.2).

---

## 3. The inbox

One list. Everything that needs the human, across every stream, oldest first.

### 3.1 Item kinds

After the reshape there are exactly four, and every other gate kind is deleted with its policy rows (T121):

| kind | raised by | decision | effect |
|---|---|---|---|
| `question` | an agent's `ask` verb | free text, or one of the offered options | answer → thread → waiting session unblocks |
| `classifier_review` | the hook's route band (§6.3) | allow / deny, optionally with a reason | the blocked tool call proceeds or fails; rule `stats` incremented |
| `rule_accept` | lessons at stream close (§5.5), or an agent's `propose_rule` | accept / retire / edit-then-accept | `status` moves to `accepted` or `retired` |
| `land` | the Land button, when the repo policy asks for a gate | land / hold | the merge runs or does not |

Deleted gate kinds: `approve_plan`, `approve_decision`, `sprint_review`, `demo`, `unblock`, `promote_to_main`, budget-threshold, escalation. Rationale: each existed to let a simulated manager ask permission for a ceremony that no longer happens. `approve_plan` in particular was an elegant trick (Claude `plan` mode's `ExitPlanMode` surfaces as an ACP permission request — `spike-findings.md` §C3) and it is still deleted, because there is no planning turn that needs approving: the human writes the goal themselves.

### 3.2 Shape of an item

Every item carries enough to decide in ten seconds without leaving the list:

```
{ id, kind, stream, stream_path, one_line_context, raised_at, body, options?, refs[] }
```

`stream_path` is the ancestor chain rendered as `ledger-lite / import CSV / parser`, because "which of my eleven things is this" is the first question the operator has. `one_line_context` is the last thread line or the rule text, distilled — never the whole diff, never the whole question (signal over volume, the one convention carried unchanged from the old design).

### 3.3 Rules of the inbox

- **Empty is the goal state.** Nothing else in the UI nags.
- **Oldest first, globally.** No per-stream sub-queues; the operator's attention is one queue whatever the tree looks like.
- **Every card takes free text**, not just its buttons (carried forward from the v2 control-room review, T039). A typed answer reaches the asking session verbatim.
- **Answering is inline.** Clicking a card never navigates away from the list; the stream page is a separate deliberate visit (§9.3).
- **Items are records, not messages.** They have a status and they are idempotent. A daemon restart re-reads them; it does not re-deliver them.
- **Push, do not poll.** The item appears over the existing websocket with no reload (the `hil_requested` trigger from T050 survives the reshape under a new name).

---

## 4. Agents as attachments

An agent is not a member of a team; it is a session attached to a stream, for as long as it is useful. **D3** again: two roles, worker and reviewer.

### 4.1 Worker

`agile attach <stream> [--vendor] [--model]`. The daemon:

1. creates the branch and worktree if the stream has a repo (§4.4) — *on first attach, never on stream create*, so planning streams never touch git;
2. assembles the brief: `briefs/worker.md`, the stream goal and its ancestors' goals, the last N thread entries, repo docs from `<repo>/.agile-docs/*.md`, and **accepted rules in scope** (§5.3);
3. spawns the vendor ACP session with the worktree as cwd, installs the hook config (§8.1);
4. streams the session's output into the thread, routes `ask` to the inbox, and updates `agent.*`.

The MCP verb surface an agent gets shrinks to eight:

`ask` · `progress` · `finding` · `propose_rule` · `propose_next` · `read_stream` · `search_docs` · `test_run`

Everything else in the old `tools/builtins.ts` is deleted. Rationale: each verb is a schema the model can get wrong, and the live runs showed models burning turns retrying rejected schemas. Eight verbs, each with an obvious shape, is the whole contract.

The tool *framework* from the old design (§7: a tool is a folder with a `tool.yaml`, cache, ledger kind, promote-to-KB) is gone. What survives is the output contract: `test_run` returns failing test names, assertions and the relevant stack frames — never a green log.

### 4.2 Reviewer

`agile review <stream>`, or a button. A second session on the same worktree with `briefs/reviewer.md` and a **read-only permission policy**: every write tool is denied at the hook, and a test proves the denial rather than trusting the brief. Findings go to the thread as `finding` entries and to `agent.findings` as `{ severity, file, line?, text }`. They are input to lessons (§5.5).

Optional per repo: auto-review when `agent.status` becomes `done`.

What is deleted: review *rounds*, `max_review_rounds`, PASS/FAIL verdicts, the escalation ladder, `attempts`/`max_attempts`, and the separate QA role with its fresh clone. Rationale: the verdict state machine existed so a simulated manager could decide what to do next. The human reads the findings and decides; that is one step, not five states.

### 4.3 Gates on an attachment

An attached session is gated at three points, and only the first is new:

1. **per tool call** — the hook path (§8.1): pattern rules, then classifier rules, then allow.
2. **at landing** — diff-level rules (§8.2).
3. **at the vendor's own permission layer** — kept as a best-effort floor, exactly as measured. Do not re-derive this: `design/spike-findings.md` §A and §C2–C4 are the reference. The short form, for placement decisions only:
   - **Claude** — project `PreToolUse` hook fires for every tool and delivers a deny *with reason* to the model verbatim. This is the tier the whole design assumes.
   - **Pi** — an in-process extension blocks with a reason and can rewrite tool results; the strongest surface of any vendor.
   - **Grok** — all file I/O goes through client `fs/*`, so reads and writes can be refused with a message; exec is ungated.
   - **Cursor** — ACP permission on every exec, nothing on reads or edits; project hooks do not fire headless.
   - **Codex** — nothing is gated in any mode or approval policy.

   Consequence for this design, stated once: **vendors without a pre-tool-use hook get no per-action classifier tier.** They get diff-level rules at landing (§8.2) and guidance in the brief, and nothing else. A stream on such a vendor is not silently less safe — the daemon writes a `hook_unchecked` thread entry when it attaches, and the UI marks the session.

### 4.4 Worktrees

`<repo>/.worktrees/<stream-id>-<slug>/`, ensured in the repo's `.gitignore`. Creation is hardened (T113, design borrowed from KiroCrew, **D11**):

- created via git plumbing with **no shell interpolation**;
- `core.hooksPath` pointed at an empty directory for the checkout, so a repo's own hooks cannot run arbitrary code during setup;
- repos with `.gitattributes` filter drivers are **refused with a reason** rather than checked out;
- the branch is claimed atomically with `git update-ref` in its expected-old-value form, so two concurrent creates for the same stream leave exactly one winner;
- creation fails if the branch already exists anywhere.

The orphan `agile-state` branch and the `.agile/` worktree inside repos are gone (§7.5).

---

## 5. Rules

Rules are the system's memory of decisions. They replace the oracle, its decision graph, the ripple walk, and the retro.

### 5.1 The record

```ts
Rule = {
  id: string,
  text: string,                 // the rule in plain language, as the human would say it
  question?: string,            // the classifier question; defaults to "Does this action violate: <text>?"
  scope: { kind: 'global' | 'repo' | 'stream', ref?: string },
  status: 'proposed' | 'accepted' | 'retired',
  enforcement: 'pattern' | 'classifier' | 'guidance',
  stage?: 'action' | 'diff' | 'both',      // default 'action'
  pattern?: { kind: 'no_push' | 'no_push_protected' | 'path_deny' | 'command_deny', args },
  critical: boolean,
  examples: { action: string, violates: boolean }[],
  provenance: { stream?, session?, finding?, by },
  stats: { fired: number, violated: number, routed: number, last_fired_at?: string },
  created_at: string,
  decided_at?: string,
  decided_by?: string,
}
```

**D4: rules have scope, status, provenance, enforcement tier and example actions. Agents propose; only the human accepts.** Rationale for each field:

- **scope** — a rule learned on one repo must not silently govern another. Scope is mechanical filtering, not a judgement call (§5.3), borrowed from KiroCrew's mechanical scope filtering of injected rules (**D11**).
- **status** — a proposal is not a rule. The gap between the two is the only place the human's authority lives.
- **provenance** — six months later, "why does this rule exist" must be answerable by clicking through to the stream and finding that a reviewer flagged it.
- **enforcement** — see §5.2. A rule that cannot say how it is enforced is a wish.
- **examples** — two things at once: documentation for the human reading the rule, and *evals* for the classifier (§5.6). A classifier rule with fewer than two examples cannot be accepted; the store refuses it.
- **stats** — the input to pruning (§5.7).

The principal split of §2.2 applies: an agent may create `proposed` rules; `status`, `decided_at`, `decided_by` are human-only and the store rejects an agent writing them.

### 5.2 The three enforcement tiers

| tier | mechanism | cost | failure mode | use for |
|---|---|---|---|---|
| **pattern** | deterministic check in `hook/decide.ts` | ~0 ms | brittle; only expressible things | "never push to `main`", "never write outside the worktree" |
| **classifier** | one TypeSafe Jev question per rule, per action (§6) | one network call per gated tool call | costs money and latency; probabilistic | "don't add a dependency without asking", "don't change the public API of the SDK" |
| **guidance** | the rule text is injected into the brief | free | advisory only; the model may ignore it | style, preferences, "prefer X over Y" |

The invariant, unchanged from the old design and now testable: **hooks are the enforcement layer, prompts are the intent layer.** A rule marked `pattern` or `classifier` must have a hook check and a test that asserts it fires. A gate that is only a sentence in a brief is a bug.

Pattern rules run first and fail closed. Classifier rules run second and have their own fail policy (§6.4). Guidance never blocks anything.

### 5.3 Scope filtering

One function, `rulesInScope(stream)`, used by exactly two callers: the brief assembler and the hook. There is no second implementation and no per-caller filtering logic.

```
rulesInScope(stream) =
    all accepted rules with scope.kind = 'global'
  + accepted rules with scope { kind: 'repo', ref: stream.repo }          (if the stream has a repo)
  + accepted rules with scope { kind: 'stream', ref: s } for s in [stream, ...ancestors(stream)]
```

Nested streams inherit their ancestors' stream-scoped rules. `proposed` and `retired` rules are never in scope — a retired rule stops being injected on the next session, with no restart.

### 5.4 Built-in pattern rules

Created on first daemon start as global rules:

- **`no_push_protected`** — accepted, **critical**, pattern. Branches come from `repos.yaml`. **D8: pushing to (or merging into) a protected branch is prohibited by default; protected branches default to `main` and `master`, configurable per repo.** Rationale: this is the one action an agent can take that a human cannot cheaply undo. It is the default because the cost of the default being wrong (an extra inbox item) is trivial against the cost of it being absent.
- **`no_push`** — **retired by default**, pattern. **D7: agents may `git push` by default.** Rationale: a worker that cannot push cannot hand anything to CI or to a human on another machine, and the real risk is not *pushing*, it is *pushing to something protected* — which `no_push_protected` already covers. The rule exists, retired, so a repo that wants the stricter posture flips one field instead of writing code.
- **`no_worktree_escape`** — accepted, critical: no writes outside the session's worktree.

The push detector is borrowed from KiroCrew's argv floor (**D11**) and is deliberately paranoid, because the previous implementation was dodged by spelling (T010 QA found `git -C` bypassed it):

- anchored on the **git subcommand**, not on a substring of the command line (`git stash push` and `git log --grep push` are allowed);
- `-c` and `-C` prefixed global options are skipped before the subcommand is read;
- shell chains, subshells and pipe glue are tokenised, not scanned;
- obfuscated forms (`$(echo git) push`) **fail closed** — if the detector cannot determine the subcommand, it denies;
- a push to an explicitly named non-protected branch is allowed;
- a bare `git push` is resolved against the checked-out branch's upstream and **denied if unresolvable**;
- `git checkout main && git merge` inside the worktree is denied by the same rule, because merging into a protected branch is the same act as pushing to it.

A table-driven test of at least 30 command strings, including every evasion form above, is the acceptance criterion (T143).

### 5.5 Lessons

The retro, per stream, with the human as the only decider.

On land or close, if the stream had **any** findings, hook denials or questions, the daemon runs one short one-shot session (worker vendor, `briefs/lessons.md`) over exactly that material and asks for **at most three** proposed rules, each with **two example actions**. They are written with `status: 'proposed'` and provenance pointing at the stream, and they appear in the inbox as `rule_accept` items.

If there were no findings, no denials and no questions, no proposal is made. A stream that went smoothly teaches nothing, and a system that proposes a rule after every stream trains the human to click accept without reading.

Accepting a rule puts it in scope for the next brief in that scope, immediately.

### 5.6 Examples as evals

`agile rules test [rule-id]` runs every accepted classifier rule's `examples` through the configured classifier and reports agreement, with probability and confidence per disagreement. The same path runs through the `FakeClassifier` in the test suite, so the plumbing is proven offline and the live check is a manual step with a real key.

This is why two examples are mandatory for a classifier rule: without them the rule cannot be evaluated, and an unevaluated probabilistic gate is a rule that will start misfiring silently.

### 5.7 Pruning

`rules.report` / `agile rules report` gives, per rule: `fired`, `violated`, `routed`, `last_fired_at`, and "never fired in N days". The counts come from the hook path (§8.1) and the diff check (§8.2), not from a separate accounting pass.

The three pruning signals:

- **never fired** — the rule is about a situation that does not arise here. Retire it.
- **fired often, never violated** — the agents already behave. Demote to `guidance`, or retire it; it is costing a classifier call per tool call for nothing.
- **routed often** — the rule is ambiguous. Its band is wrong, its question is badly worded, or it should be a pattern rule. Every route is a human interruption, which is the scarcest resource in the system.

Retiring is a status change; nothing is deleted.

---

## 6. The classifier tier

### 6.1 Why an external classifier

Pattern rules cover what can be written as a check. Guidance covers what can only be suggested. The interesting rules are in between — "don't add a dependency without asking", "don't touch the migration files", "don't broaden a public type" — and they need judgement about a specific action.

**D5: the classifier tier uses TypeSafe Jev over its hosted API, behind an interface with a fake for tests. The daemon holds the `TYPESAFE_API_KEY`; this is an approved exception to "no vendor credentials in the daemon."** Rationale for the exception: every other credential in this system belongs to a *coding agent*, and the adapters deliberately spawn vendor harnesses under the user's own login so the daemon never holds one. The classifier is different in kind — it is the daemon's own dependency, not an agent's, and the alternative (asking the coding agent to judge its own action) is not a gate at all. The exception is narrow and written down here so it does not quietly widen.

### 6.2 The interface and the call shape

```ts
interface Classifier {
  ask(state: string, questions: Noul[]): Promise<Answer[]>
}

Noul   = { id: string, question: string }
Answer = { id: string, probability: number, confidence: number }
```

- **One call per state, N questions.** The state is built once per gated action; every classifier rule in scope contributes one question to the same call. This is the whole reason the interface takes an array: ten rules in scope must not mean ten round trips on every tool call.
- **The state** for a per-action check is: the tool name, the command or the path plus the diff hunk, and one line naming the stream and repo. For a diff-level check it is the stream's full diff (§8.2).
- **The question** is `rule.question` when the rule sets one, otherwise `"Does this action violate: <rule.text>?"` — so a rule is usable the moment it is written, and can be sharpened later without changing its identity.
- **Transport**: `https://api.typesafe.ai`, **25 s timeout**, key from `config.yaml` or the `TYPESAFE_API_KEY` env var.
- **`FakeClassifier`** is scripted per test and is the only classifier the suite ever uses. A recorded-fixture test pins the real request/response shape; there is no network in `bun test`.
- **Latency** is recorded per call as an event, because a gate that adds a second to every tool call is a gate that will be turned off.

### 6.3 Bands

**D6: classifier answers fall into three bands — deny, allow, or route to the human inbox. Low confidence routes to the human.** Thresholds live in `config.yaml`; the starting values (T151) are:

```
probability ≥ 0.80              → DENY, with the rule named in the reason
probability <  0.40             → ALLOW
otherwise                       → ROUTE to the inbox
confidence  <  0.50             → ROUTE to the inbox, whatever the probability
```

Rationale for three bands rather than a single threshold: a binary classifier at a single cut-point has to be wrong in one of two directions, and both are expensive — a false deny wastes an agent's turn and teaches the operator to distrust the rules, a false allow is the thing the rule existed to prevent. The middle band converts an uncertain machine judgement into a five-second human one. The confidence floor exists because a probability of 0.9 with confidence 0.2 is not a 0.9; it is a shrug.

These are **starting points** (`PLAN.md` §9 Q2). T153's live agreement rate over the seeded rules decides whether they move; the numbers live in config precisely so moving them is not a code change.

A **deny** reaches the model through the existing `permissionDecisionReason` path, naming the rule — verified behaviour for Claude, see `spike-findings.md` §B. A **route** blocks the session until the human answers; the answer allows or denies and increments `stats.routed` plus `stats.violated` on a deny.

### 6.4 Fail policy

The classifier is a network call to a third party. It will time out.

> **On classifier error: rules marked `critical` DENY; all other rules ALLOW, and the daemon writes a `hook_unchecked` entry to the stream's thread.**

Rationale: fail-closed on everything means one API outage stops every agent in every stream, and the operator learns to disable the tier. Fail-open on everything means an outage silently removes the guardrails. Splitting on `critical` puts the choice in the rule where the human already made it: the handful of rules whose violation is expensive enough to be worth a total stall are marked critical when they are accepted, and everything else degrades to observed-but-unchecked with a visible mark in the thread.

The same policy covers the opt-out and a missing key: no classifier configured means no classifier tier, critical classifier rules deny, everything else proceeds with the thread entry.

**Vendors with no pre-tool-use hook** (Cursor, Codex; Grok has only the client-fs surface) never reach this tier at all: they get the diff-level rules at landing (§8.2) and guidance in the brief. See §4.3 and `spike-findings.md` — do not re-derive. Nothing marks such a session's thread at attach time today; making the gap visible there is worth doing and is not yet built.

**Opt-out** is per stream (`classifier: off`) with a per-repo default in `repos.yaml`. A stream working on something the operator does not want leaving the machine turns the tier off; pattern rules and guidance still apply.

### 6.5 The credential scrub

Fail-closed, and it runs on the state before **every** call, borrowed from KiroCrew (**D11**).

- Patterns: API tokens and key-shaped strings, `Authorization:` and `Proxy-Authorization:` headers, `.env`-shaped assignment lines (`FOO_SECRET=...`, `*_KEY=`, `*_TOKEN=`, `PASSWORD=`), private-key PEM blocks, and URL userinfo.
- Matches are replaced with a fixed redaction marker, not removed, so the classifier still sees the *shape* of the action.
- **If the scrub itself throws, nothing is sent.** Not a partial state, not the unscrubbed state — the call is abandoned and the fail policy of §6.4 applies. A scrub that can fail open is worse than no scrub, because it is trusted.
- Unit tests cover both directions: known secret shapes are redacted, and known-benign strings that look secret-adjacent (a base64 test fixture, a `token` identifier in code) are not mangled into uselessness.

---

## 7. State home and file formats

### 7.1 One daemon, one home

**D9: the tool is not a per-repo process. One long-lived daemon, state in one home directory, worktrees inside each repo.** Rationale: the operator's unit of attention is the *day*, not the repo. Eleven streams across four repos is one inbox, one tree, one process, one URL. A per-repo daemon means per-repo inboxes, which means the cross-cutting question — "what needs me right now" — cannot be answered at all. It also means the state lived inside the repo, which is what forced the orphan `agile-state` branch and all its commit machinery.

The daemon is started once (`agile daemon start`, detached, pidfile and port in `config.yaml`) and **never exits because work finished**. A second `start` is a no-op that prints the pid.

### 7.2 Layout

```
~/.agile/                      # AGILE_HOME overrides; tests use a temp dir
  config.yaml                  # vendors, classifier settings + bands, protected-branch defaults, port
  repos.yaml                   # registered repos
  streams/<id>.yaml            # the stream record (§2.1)
  streams/<id>.docs/*.md       # per-stream docs
  threads/<id>.jsonl           # append-only thread per stream
  rules/<id>.yaml              # rule records (§5.1)
  log/events.jsonl             # append-only, every state change
  sessions/<id>/               # per-session stderr, transcripts, tool output files
```

Per repo, and tracked in the repo:

```
<repo>/.agile-docs/*.md        # guidance that travels with the repo
<repo>/.worktrees/<stream-id>-<slug>/   # gitignored
```

`.agile-docs/` is the one new tracked directory the reshape introduces (`PLAN.md` §9 Q4, assumption in force: tracked). Rationale: a repo should carry its own guidance so a fresh machine or a second operator gets it from the clone. The old `oracle/` brief moves here; `search_docs` is a plain text search returning file and line. There is no embedding index and no knowledge base.

### 7.3 Formats

- **YAML** for records (streams, rules, config, repos). Hand-editable; that is the point.
- **JSONL** for logs and threads. Append-only, one writer.
- **Markdown** for docs and briefs.

Every read goes through the validating store. A corrupt file is refused **with the path and the line number**, never silently defaulted — a design that invites hand-editing must fail loudly when a hand-edit is wrong.

### 7.4 The event log

`log/events.jsonl` in the home, append-only, one writer, **fsync on gate and land events** (the two kinds whose loss would be silently wrong). Event kinds reduce to: stream · thread · session · question · gate · rule · hook · land.

Every state change in the daemon emits exactly one event. The test that keeps this honest is a reconstruction test: stream statuses rebuilt from the log alone must match the records.

`agile tail` filters by stream.

### 7.5 What the home replaces

Deleted: the `agile-state` orphan branch, the `.agile/` worktree inside each repo, the deferred-commit batching that existed because every state write was a git commit, and the host-local `.agile-daemon.lock` / `.agile-daemon.sock` / `agile.config.yaml` triple that existed because the config had to work before `.agile/` existed. One home, plain files, no git.

---

## 8. The hook path and the landing path

### 8.1 Hook path, per tool call

```
vendor PreToolUse hook  (Claude: .claude/settings.json in the worktree; Pi: extension)
        │  normalised payload
        ▼
agile hook <event>                        (the CLI is the one entrypoint every vendor calls)
        │  RPC to the daemon, 2 s deadline
        ▼
daemon hook/decide.ts
        │
        ├─ 1. resolve the session → stream → repo. Unresolvable ⇒ DENY (fail closed).
        │
        ├─ 2. PATTERN rules in scope, in order.
        │        match ⇒ DENY with the rule named. Detector uncertain ⇒ DENY.
        │
        ├─ 3. CLASSIFIER rules in scope (skipped if the stream opted out):
        │        build state → scrub (§6.5) → ONE Jev call, N questions
        │        error ⇒ critical rules DENY, others ALLOW + `hook_unchecked` thread entry
        │        per rule: band (§6.3) ⇒ DENY / ALLOW / ROUTE
        │        ROUTE ⇒ `classifier_review` inbox item; the session BLOCKS until answered
        │
        └─ 4. ALLOW.
                 stats updated on every rule that fired; latency recorded as an event.
```

Properties:

- **Fail closed.** An unreachable daemon, an unresolvable cwd, or a detector that cannot parse a command denies with a reason. The hook timeout (5 s) is deliberately longer than the CLI's RPC deadline (2 s) so the CLI's own failure is the one the model sees.
- **The deny reason reaches the model verbatim.** This is the single measured behaviour the whole enforcement design rests on, and it is measured, not assumed: `spike-findings.md` §B for Claude, §C4 for Pi.
- **One classifier call per action,** regardless of how many classifier rules are in scope.
- **Per-call cost** is roughly 100 ms of Bun cold start plus, when classifier rules are in scope, one network round trip. This is why most rules should be `pattern` or `guidance`, and why §5.7's "fired often, never violated" prune matters.

Vendors without a pre-tool-use hook (Cursor, Codex; Grok has only the client-fs surface) get steps 1–2 for nothing they can gate and skip step 3 entirely. See §4.3 and `spike-findings.md` — do not re-derive.

### 8.2 Landing path, per stream

```
human presses Land (or `agile land <stream>`)
        │
        ├─ `land` gate if the repo policy asks for one          (default: no gate — the button IS the decision)
        │
        ├─ DIFF-LEVEL rules: accepted classifier rules with stage 'diff' or 'both'
        │     one call with the full stream diff as state, scrubbed
        │     over the classifier's budget ⇒ split per file, take the MAX
        │     DENY ⇒ landing blocked, the rule named in the thread
        │     ROUTE ⇒ inbox item, landing waits
        │
        ├─ merge --no-ff into target_branch
        │     target = repos.yaml target_branch, else the repo's default branch
        │     a child stream with a repo-bearing parent merges into the PARENT's branch instead
        │     conflict ⇒ agent.status: blocked, conflict files in the thread,
        │               worktree KEPT, no partial merge
        │
        ├─ human.status: landed; worktree removed; branch kept
        │
        └─ lessons proposed (§5.5)
```

Why diff-level rules exist as well as per-action rules: some rules are only checkable against the whole change ("don't broaden the public API", "don't leave a TODO in shipped code"), and they are the only enforcement a hookless vendor gets. Taking the **max** over a split diff is the conservative choice — one bad file makes the whole diff bad.

The default of no land gate is deliberate: the operator pressed the button. A gate on top of a button is a confirmation dialog, and confirmation dialogs get clicked through.

---

## 9. The UI

One page, three surfaces, served by the daemon at `/`. React + Vite SPA, one websocket, read-mostly; every write goes through the same daemon endpoints agents use, so it lands in the log. Phone width works.

Reused unchanged from the v2 control room: `shell.tsx`, the single ws, `Markdown`, `TopBar`, `Settings`, the diff renderer, and the thinking indicator from `chat-state.ts`.

### 9.1 Inbox — the default view

The list of §3, grouped by stream, each card answerable inline. This is what the app opens on and what it returns to. Empty is the goal state, and empty should look calm, not broken.

### 9.2 Stream tree — the left rail

Every stream, nested, with a **status dot that says who must act**:

| dot | meaning | derived from |
|---|---|---|
| amber | waiting on you | `human.status: waiting_on_you` |
| blue | agent working | `agent.status: working` |
| grey | idle / nothing attached | `agent.status: idle` |
| green | landed | `human.status: landed` |
| red | blocked | `agent.status: blocked` |

The dot reads the two-writer pair from §2.2 directly; there is no derived status field to keep in sync.

### 9.3 Stream page

- **Thread** — streaming, markdown, thinking indicator. The spine of the page.
- **Composer** — writes a human line; if a worker is attached, it also prompts it. One box, two effects, no mode switch.
- **Sessions strip** — vendor/model per session, with attach, review and stop.
- **Diff tab** — the worktree diff.
- **Rules-in-scope tab** — exactly what `rulesInScope(stream)` returns, so "why was I denied" is one click.
- **Docs tab** — repo `.agile-docs/` and stream docs.
- **Land button** — with the diff-rule result shown before and after.

### 9.4 New stream and quick capture

"New stream" from anywhere: title, optional parent, optional repo. Plus a **quick-capture box in the top bar** that turns one typed line into a stream with no repo, in under two interactions — this is the support question that arrives mid-task, and if capturing it costs more than that it will be captured in the operator's head instead.

Keyboard: `n` new, `/` search streams.

### 9.5 Rules screen

List with scope, tier, status and stats; accept / retire; edit text, question and examples; the pruning columns from §5.7 (never fired, most routed); a "test examples" button calling §5.6.

### 9.6 Deleted screens

Plan, Sprint, Review, the Oracle panel, the Questions pane, the Policy pane, the vendor barometer, the spend modal, the EM chat panel and its pop-out. The UI is rebuilt across T160–T163, so the app may be visually broken on the integration branch between the deletion and the rebuild — **never on `main`.**

---

## 10. What was deleted, and why

Everything here is gone from the code, not flagged off. **Git remembers** (D2); a disabled subsystem is a subsystem that still has to typecheck, still has to be understood by the next reader, and still has a path to being re-enabled by accident.

| Deleted | Why |
|---|---|
| **The resident EM and the EM delegate** (`daemon/src/em/`) | A simulated manager relaying instructions from the real manager. One lossy hop, one model's latency and cost, one class of "the EM misread you" failures. The human is the manager; the inbox is the relay. (D2) |
| **Ceremonies**: sprint review, retro, standup, refinement, pointing, quorum | Rituals that exist to synchronise humans who cannot see each other's work. One human watching a live tree needs none of them. The retro's real function survives as lessons (§5.5); the rest had no function. (D2) |
| **Architect, oracle, reader, QA roles** (`architect/`, `oracle/`, `qa/`) | Prompt personas, not enforced capabilities. Their useful brief text folds into the worker brief or becomes rules. Four fewer briefs, four fewer permission rows, four fewer places for work to wait on a persona. (D3) |
| **Sprints, tickets, epics, teams** | Four nouns to express containment. Nested streams express it with one, and also cover investigations and planning threads, which tickets could not represent. (D1) |
| **Halts, ripple, quorum** (`halts/`) | A recovery subsystem for the damage a flat, last-writer-wins status field caused. The two-writer split (§2.2) removes the damage, so the recovery is unnecessary. |
| **Quota records, routing policy, the vendor barometer, handoff and pause** (`quota/`, `handoff/`) | Sophisticated machinery for a problem one operator does not have: which of my accounts should this run on. Revisit when there are enough parallel sessions to exhaust one. |
| **The review round machine**: rounds, max rounds, PASS/FAIL, escalation ladder, `max_attempts` | A state machine whose only consumer was the simulated manager. The human reads the findings and decides. |
| **The QA role and its fresh clone** | A second adversarial reader with a different permission policy. The reviewer plus diff-level rules at landing (§8.2) covers it; QA as a *practice* survives as the phase-boundary checks in the plan. |
| **The tool framework** (`tool.yaml` folders, cache TTLs, ledger kinds, promote-to-KB) | A plugin system for tools that were never written. Eight fixed MCP verbs (§4.1) with hand-written output contracts. The signal-over-volume rule survives in those contracts. |
| **The knowledge base and the oracle graph** (`kb/`, decision graph, ripple walk, `affects`) | An ontology to maintain. Replaced by plain Markdown docs (§7.2) and rules with mechanical scope filtering (§5.3), which do the same job without a graph to keep consistent. |
| **Jira / Linear / GitHub Issues sync** (`sync/`) | Shelved on a branch, not deleted, until a stream needs it. Two-way sync is real work and nothing today asks for it. |
| **`agile run` and `advancePipeline`** (`runner/pipeline-glue.ts`) | One hand-rolled list of glue steps that drove a whole sprint. Per-stream drivers replace it; the glue is not ported, because the hand-rolled copy silently drifted from the real path twice. |
| **The bus** (`bus/`) | A priority mailbox with routing rules, liveness sweeps and redelivery. The thread (§2.1) is an append-only file that does the one thing the bus was used for. It also caused the stale-question defect of 2026-09-11: mail from a dead daemon reappearing as a live question. |
| **The `agile-state` orphan branch and per-repo `.agile/`** | State in git meant a commit per write, batching to make that bearable, and a repo-shaped home for something that is not repo-shaped. (D9) |
| **CLI `run`, `send`, `halt`, `approve`, `sync`** | Replaced by `answer` and `land`, or deleted with their subsystem. |
| **Shared schemas** `Ticket`, `Sprint`, `Stanza`, `Message`, `Halt`, `Quota`, `Review`, `Qa`, `Oracle`, `Kb`, `Ledger` | Each one is a deleted subsystem's record type. |
| **UI** Plan, Sprint, Review screens, `OraclePanel` | §9.6. |
| **OS sandboxing (tier 0)** | Designed but never built, and a non-goal for the reshape. Worktree containment (`no_worktree_escape`) plus the hook tier is the floor for now. Vendors with nothing gateable (§4.3) are the case that will eventually force this back. |

### What was borrowed instead of built

**D11: KiroCrew is not adopted.** It is a separate system with its own model of work; adopting it would mean running two orchestrators or porting this design onto its assumptions. What was borrowed, as designs only, each named where it lands:

| borrowed | where |
|---|---|
| hardened worktree creation (no shell, empty hooksPath, filter-driver refusal, atomic branch claim) | §4.4 |
| a push detector that cannot be dodged by spelling | §5.4 |
| agent-owned vs human-owned ledger fields | §2.2 |
| a fail-closed credential scrub before an external classifier | §6.5 |
| mechanical scope filtering of injected rules | §5.3 |
| an append-only log | §7.4 |

### Build process for the reshape

**D10:** short tickets; one reviewer on close; QA only at phase boundaries; Pete looks at the UI after every UI ticket; no `--yolo` run longer than one phase without a human look. Rationale: the previous build ran long unattended stretches and accumulated defects that only a human eye caught (the first hands-on pass produced a full ticket of UI defects, T049). The phase boundary is where the cost of being wrong is still one phase.

---

## Appendix A — where the old design still applies

`design/agile-agents-design.md` is superseded, with two sections still live and cited rather than copied:

- **§8 Adapter contract (ACP)** — every session is a process behind a vendor-neutral seam; the extraction from Terma into `packages/acp-client`; auth by the user's own login, never a daemon-held credential (the classifier of §6 is the single approved exception, D5). Unchanged.
- **§6 Enforcement tiers and hook catalog** — the tier table (OS sandbox / hook / client fs / ACP permission / observation) and its per-vendor placement. The tiers are unchanged; what changed is which gates sit on them (§8.1 replaces the old minimum hook set, and tier 0 is a non-goal for now).

`design/spike-findings.md` is unchanged and remains the measured reference for per-vendor behaviour. Nothing in this document re-derives it.

## Appendix B — open questions

Tracked in `PLAN.md` §9; restated here for the reader of the design alone.

- **Q1.** Does a coding stream's target default to an integration branch or to the repo's default branch when there is no integration branch? Assumption in force: the repo's default branch. Confirmed at T132.
- **Q2.** The bands of §6.3 (0.80 / 0.40 / confidence 0.50) are starting points. T153's live agreement rate decides whether they move.
- **Q3.** Whether `bus/` survives as the thread's transport or is deleted outright. Decided in T120 by whichever is less code.
- **Q4.** Repo docs tracked in `<repo>/.agile-docs/` or untracked under the home. Assumption in force: tracked, so a repo carries its own guidance. Confirmed at T134.

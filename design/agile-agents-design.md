# Agile Agents — Design Doc

Multi-agent coding orchestration modeled on an Agile engineering team. Living doc; reads as the current plan, not a history.

Last updated: 2026-09-08 (design decisions closed; vendor spike complete incl. Pi; build decisions in §18 — ready for an implementation plan)

Companion diagram (swimlane flow, standup protocol, message delivery tree): Artifact "Agile Agents Workflow" — https://claude.ai/code/artifact/18cdd7d8-ae3a-489c-afc0-d269767797c4

Control room mockup (sample data, clickable): Artifact "Agile Agents Control Room" — https://claude.ai/code/artifact/96c084e8-13b2-4a16-a68b-fad68aa6c40d

## 1. Architecture decision

**Hybrid.** An in-house orchestrator daemon owns all state (oracle, tickets, board, ledger, halts, bus). Each vendor's agent runtime (Claude Code, OpenAI/Codex, Cursor, Pi, Gemini, xAI/Grok) is spawned into a git worktree with hooks pointed at the daemon. Vendors run the inner coding loop; the daemon runs the ceremonies.

Decided:
- State lives in plain files under `.agile/` (git-tracked). Backing can move to an in-house DB (sqlite) behind the daemon API when file counts hurt. No external sync (Linear etc.) for now.
- Knowledge store is grep/scope-first. No embeddings.
- Optional light UI: a file viewer over the daemon API that doubles as the human's inbox.
- Hooks are the enforcement layer; prompts are the intent layer. Anything that gates work is a hook, not a prompt suggestion.
- **Signal over volume, everywhere.** Nothing enters a model's context unless it changes what that model does next. Every boundary — tool result, message body, board stanza, review report, QA report, standup report, test output — is a compression point with a contract for what "valuable" means there. Raw output goes to a file; the context gets the pointer plus the distilled part. The daemon enforces size caps at these boundaries (post-tool-use truncation/summarization, message body cap), so this does not depend on agents choosing to be terse.
- **Login is the user's, not the daemon's.** The daemon never holds vendor credentials. Each adapter invokes the vendor's own harness, which owns its login (OAuth subscription, API key, cloud provider); the user picks the auth mode per adapter and can run several accounts of one vendor side by side.

## 2. Roles

| Role | Owns | Notes |
|---|---|---|
| **EM** | Delegation, ceremonies, unblocking, human interface | Scheduler and traffic cop. Does not write the oracle. |
| **Architect** | The oracle. Sole writer. Adjudicates ticket-vs-spec conflicts, runs ripple analysis, decides discovery tier, points tickets. | Split from EM so technical arbitration and scheduling don't compete for attention. |
| **Engineers** | Implement tickets in worktrees | Model/effort chosen by ticket tier. Ephemeral processes, stable names. |
| **Reviewers** | Adversarial review: coding standards + oracle adherence | Second reviewer with a security/supply-chain mandate runs as a separate pass. |
| **QA** | Run ticket acceptance criteria without reading the implementation | Accept / needs-fixes. |
| **Integration owner** | Integration branch, rebases, conflict triage back to ticket owners | Most common source of scoped halts. |
| **Reader agents** | Cheap models that read files/KB and return summaries | Gated in by a pre-tool-use hook on large reads. |
| **Human** | Planning, approvals, sprint demos, steers | Just another participant on the bus with an inbox. |

## 3. Concepts beyond the original brief

- **Knowledge store** separate from the oracle: codebase/environment facts ("CI lacks Docker", "module X is fragile"), not product decisions.
- **Sprints** with a goal, token budget, HIL review, and a computed retro.
- **Definition of done** per ticket, machine-checkable.
- **Spikes**: timeboxed discovery tickets whose output is a report + proposed tickets, run on cheap models.
- **Escalation ladder** with cost gate: the daemon increments `attempts` on every failed review or QA verdict (the "no" branch, not the fix step); when `attempts > max_attempts` the ticket is re-routed to the next tier with the failure context attached → EM decides split / standup / human if the ladder runs out.
- **Cost ledger**: tokens per ticket/agent/sprint/kind. Ticket at 3x estimate is a retro signal.
- **Observability**: append-only event log of every message, hook decision, and state transition.
- **Tiered halts**: local (note it, continue) / scoped (named tickets pause) / global (oracle changes, everyone stops). Architect sets tier. Count global halts in retro.
- **Async standups** by default: agents write board stanzas at checkpoints; EM reads the board and posts decisions; agents are pulled in only when named.
- **Vendor barometer + quota-aware routing**: daemon tracks remaining quota per vendor account and routes around low/exhausted vendors. See §4 Quota, §10, §11.
- **Tool framework**: hook-gated, cheap-model tools defined as folders under `.agile/tools/`, exposed over the daemon's MCP server and enforced by hooks. See §7.

## 4. State model

### Layout

```
.agile/
  oracle/
    product.md            # vision, non-goals, glossary
    decisions/DEC-0042.md # one file per decision
    specs/SPEC-auth-003.md
    index.yaml            # id → title, status, supersedes, depends (active only)
    changelog.md          # appendix, append-only
  knowledge/
    facts/KB-0117.md
    index.yaml
  tickets/
    TKT-0231.yaml
  board/
    status/TKT-0231.jsonl # agent-written stanzas, append-only
    halts/H-12.yaml       # presence of a file = halt active
  sprints/
    S-07.yaml           # includes team, gates block
  policy.yaml           # repo-default HIL gates, circuit breaker signals
  vendors.yaml          # accounts + auth mode per vendor
  tools/<name>/tool.yaml
  rules/RULE-012.md     # coding standards, one per file
  ledger/
    S-07.jsonl
  log/
    events.jsonl
  bus/                    # see §5
```

### Oracle

Decisions and specs share a header:

```yaml
id: DEC-0042
title: Sessions are JWT, not server-side
status: active          # active | superseded | retired
supersedes: [DEC-0019]
depends: [SPEC-auth-003]
affects: [SPEC-api-001]  # forward edges, maintained by architect
decided: 2026-09-07
by: architect            # or human
rationale: ...
```

- Body is the current truth in prose. No "we used to."
- `changelog.md` gets one line per change: `2026-09-07 DEC-0042 supersedes DEC-0019: <one line>`.
- Superseded files keep their body (appendix), flip status, and drop out of `index.yaml` so readers never load dead items by default.
- `affects` makes ripple analysis a graph walk: change DEC → walk `affects` transitively → every ticket whose `oracle_refs` intersects gets marked `stale`.
- Writer: architect only, via a daemon endpoint that requires a decision ID and validates the graph (no dangling refs, no cycles). Enforced by hook.

### Knowledge store

```yaml
id: KB-0117
kind: env | codebase | gotcha | perf
scope: [packages/api]
confidence: observed | verified
source: TKT-0198
expires: null           # date for env facts that rot
```

Any agent proposes (`observed`); reviewer/QA promotes to `verified`. Reader agents query by scope before touching source. Retro prunes expired/contradicted facts.

### Ticket

```yaml
id: TKT-0231
title: Issue JWT on login
status: draft | ready | assigned | in_progress | in_review | in_qa | done | blocked | stale | paused
sprint: S-07
parent: EPIC-0009
depends: [TKT-0230]
oracle_refs: [DEC-0042, SPEC-auth-003]
kb_refs: [KB-0117]

contract:
  inputs:  [packages/api/auth/**]
  outputs: [packages/api/auth/jwt.ts, tests/auth/jwt.test.ts]
  acceptance:                            # QA runs these without reading impl
    - "POST /login with valid creds returns 200 and a JWT whose exp is +24h"
    - "npm test -w packages/api passes"
  done: [tests_pass, review_approved, qa_accepted, oracle_consistent]
  env: clone            # clone | compose: docker/compose.test.yml

estimate:
  points: 3
  tier: standard        # trivial | standard | hard | novel
  reasoning: high | medium | low
  pointed_by: architect
  pointed_at: 2026-09-05

routing:
  model: <resolved by daemon from tier at assignment>
  attempts: 1
  max_attempts: 2       # before escalation
  escalation: [standard, hard]

budget:
  ceiling_tokens: 400000
  spent_tokens: 0       # daemon-maintained

assignee: eng-3
worktree: .worktrees/TKT-0231
history:
  - 2026-09-05 created by architect
  - 2026-09-07 assigned to eng-3 (claude/sonnet)
```

- `stale`: set by the ripple walk; can't be picked up until architect re-refines.
- `blocked`: agent-declared, carries a reason pointing at a ticket, a message, or a proposed decision.
- `tier` → model via a daemon-owned routing table (`trivial → haiku-class`, `novel → opus-class + high reasoning`). Swapping vendors is a table edit.
- `attempts`, `budget.spent_tokens`: daemon-written only. `attempts` is bumped by the daemon when a review or QA verdict comes back negative; the escalation gate is evaluated at that moment, before the fix is reassigned.

### Board

Append-only per-ticket stanzas written by engineers at checkpoints (start, blocked, review submitted, done, discovery):

```json
{"ts":"...","ticket":"TKT-0231","agent":"eng-3",
 "kind":"progress|blocked|discovery|review_submitted|handoff|done",
 "summary":"one paragraph max",
 "discovery":{"tier":"local|scoped|global","affects":["SPEC-auth-003"],"proposed":"..."}}
```

A `discovery` at scoped/global tier triggers the architect. A standup = EM reads the board and writes a `decisions` stanza.

### Halts

`board/halts/<id>.yaml`: `scope: global | [TKT-...]`, `reason`, `raised_by`, `resolves_when: DEC-xxxx`, `quorum: pending | reached`. Engineer-side pre-tool-use hook checks this directory before every write or ticket pickup. Delete the file to release.

### Sprint

```yaml
id: S-07
goal: "Auth works end to end"
tickets: [TKT-0230, TKT-0231]
budget_tokens: 5000000
started: ...
review_at: <HIL demo>
carried_over: []
retro:                    # computed from ledger, not agent-written
  mispointed: [TKT-0229]  # spent > 3x estimate
  global_halts: 1
  escalations: 2
```

### Quota (per vendor account)

```yaml
vendor: openai
account: codex-plus
kind: subscription_window | prepaid_credits | pay_as_you_go
remaining: 0.22          # fraction, $ or tokens — whatever the vendor exposes
unit: fraction
resets_at: 2026-09-07T18:00:00Z
confidence: reported | estimated
source: stream_event | usage_endpoint | ledger_countdown | rate_limit_429
updated: ...
cooldown_until: null     # set on 429
```

Two feeds merged: real readings when a vendor exposes them (stream events, usage endpoint), and the daemon's own ledger counting down from a user-set cap, corrected whenever a real reading lands. A 429 is a reading: remaining 0 until reset. Confidence is shown in the UI.

Routing table becomes a policy: `(role, tier) → ordered candidates [(vendor, model, reasoning)]`. Daemon picks the first candidate with `remaining > floor` (default 0.15) and no cooldown. Role-specific candidates make cross-vendor review the default, which is more adversarial for free. Bus events `quota_low` (reroute new assignments) and `quota_exhausted` (in-flight ticket takes the dead-agent path: back to ready, worktree preserved, reassigned to next candidate with thread as context). Sprint budget carries a per-vendor breakdown.

### Ledger

One line per model call, emitted by adapters:

```json
{"ts":"","sprint":"","ticket":"","agent":"","model":"","in_tokens":0,"out_tokens":0,"cost_usd":0,
 "kind":"engineer|review|qa|reader|ceremony"}
```

### What this buys

Every gate is a file check (halt exists? ticket ready? budget under ceiling? oracle refs active?), so hooks stay trivial. Every ceremony is a query over files, so a cheap model can prep and an expensive one only decides.

## 5. Comms bus

Constraint: a vendor agent mid-loop won't read anything you didn't put in front of it, and you can't push into its context. Entry points are hooks (tool calls / turn end) and turn boundaries (adapter re-invokes). So: **files for storage, daemon for validation and fan-out, hooks for delivery.**

### Storage

```
.agile/bus/
  inbox/<agent>/<ulid>.yaml     # unread
  inbox/<agent>/done/           # acked
  threads/<ticket>/<ulid>.yaml  # every message touching a ticket
  agents/<agent>.yaml           # registry: vendor, model, ticket, pid, last_seen
```

Daemon writes everything. Clients (hook scripts, adapters, UI) use a unix-socket API: `bus.send`, `bus.poll`, `bus.ack`, `bus.heartbeat`.

### Message

```yaml
id: 01J9...            # ulid
ts: ...
from: eng-3            # em | architect | eng-N | reviewer-N | qa-N | human | daemon
to: [em]               # or broadcast, or ticket:TKT-0231 (fan-out to everyone on it)
kind: assign | question | answer | discovery | halt | resume | decision
      | review_request | review_verdict | qa_verdict | escalate
      | standup_call | standup_report | hil_request | hil_response
priority: urgent | normal | low
ticket: TKT-0231
reply_to: 01J8...
body: "≤ ~800 chars. Pointer, not payload."
refs: [DEC-0042, KB-0117, .agile/reviews/TKT-0231-r1.md]
requires_ack: true
```

Daemon enforces the body size cap. Long content (reviews, QA reports, proposals) goes to a file; the message carries the path.

### Delivery by priority

Build on the two hooks nearly every vendor has — pre-tool-use and stop/turn-end — and treat richer hooks as bonus.

- **urgent** (halt, standup_call): pre-tool-use hook *blocks* the call and returns the message as the reason. Latency = one tool call.
- **normal** (answer, decision, verdicts, assign): hook allows the call and injects inbox as additional context. Falls back to turn-boundary delivery for vendors that only allow block/allow.
- **low** (fyi, KB promoted): turn end only.
- **No hooks at all**: adapter runs bounded turns (`--max-turns N`), drains inbox between turns, prepends to the next prompt. Halts enforced by adapter refusing the next turn plus a git hook refusing commits while a halt file exists. Worst case: one wasted turn, never a wasted merge.

### Routing rules (daemon rejects the rest)

- engineer → em (question, discovery, escalate); → reviewer (review_request); → qa via em on done
- reviewer / qa → engineer (verdict), → em (copy)
- architect → em; → ticket:* (decision); → broadcast (halt / resume)
- em → anyone; human → anyone; anyone → human (hil_request)
- Engineers never message each other directly. Cross-ticket needs go through the EM.

### Questions

Async and non-blocking by default. Engineer continues on independent parts or sets `blocked` with `reason: MSG-id`. EM answers from board/oracle/KB or routes to architect (design), human (product), or a reader agent (codebase fact). Every `answer` carries `promote_to: none | kb | decision` so it gets written down once.

### Discovery → standup → resume

1. Engineer writes a `discovery` board stanza and sends `discovery` to em.
2. EM forwards to architect; architect confirms or changes tier.
3. Architect creates the halt file (scoped or global), sends `halt`. Daemon fans out at urgent. Affected agents' next tool call is blocked; they commit/stash WIP and reply `standup_report`.
4. Daemon marks halt `quorum: reached` once every affected agent reports or times out on heartbeat.
5. EM + architect deliberate in a thread. Product-level → `hil_request`; halt waits.
6. Architect publishes `decision`. Daemon runs ripple walk → affected tickets `stale`. Architect re-refines: split, or add a `refactor` child pointing at the WIP commit.
7. Architect deletes the halt file, sends `resume` with reassignments. Re-readied tickets get `assign`.

More than one or two global halts per sprint means the oracle is under-specified.

### Liveness

`bus.heartbeat` rides on the pre-tool-use hook. `last_seen` older than N minutes with ticket `in_progress` → daemon sends `escalate` to em, ticket back to `ready` (attempts unchanged, worktree preserved). Restart with thread history as context, not the old conversation.

### HIL

Human is `human` on the bus. `hil_request` has `kind: approve_decision | steer | demo | unblock` and a `deadline`; daemon holds the related halt or sprint review until `hil_response`. The file-viewer UI is the human's inbox and reply box. Demos point at a sprint file plus a generated summary; steers become decision inputs for the architect.

### Ordering / failure

At-least-once. ULIDs order per inbox; consumers idempotent (re-delivered `halt` is harmless; re-delivered `assign` must not spawn a second engineer — daemon checks ticket status). Ack moves file to `done/`. Unacked `requires_ack` past deadline re-delivers one priority up, then escalates to em.

## 6. Enforcement tiers and hook catalog

Spike result (see `design/spike-findings.md`): ACP `session/request_permission` fires only for what the harness's own permission engine would prompt for (edits, non-allowlisted exec in `default`; nothing in `auto`/`bypassPermissions`); reads are never asked about; a reject carries no reason. `tool_call` notifications arrive for every call. Claude project-level `PreToolUse` hooks run under the ACP adapter, fire on every tool, and deliver a deny *with reason* to the model.

On Pete's machine (2026-09-07, two batches): Cursor prompts for every exec but no edits, its `ask` mode is prompt-level only, and project `.cursor/hooks.json` does not fire under the headless agent; Codex (`codex-acp`) prompts for nothing in any mode or `approval_policy`; Grok prompts for nothing but routes all file I/O through client `fs/*`, and a refusal there reaches the model with its reason. Claude `plan` mode surfaces `ExitPlanMode` as an ACP permission request ("Approve Plan") — a natural implementation of the `approve_plan` gate. Claude on Max via `claude login` confirmed. Cancel and `session/load` work on all four.

So enforcement has four tiers, and each gate is placed on the strongest tier the vendor supports:

| Tier | Mechanism | Can deny | Reason reaches model | Covers | Vendors |
|---|---|---|---|---|---|
| 0 · OS sandbox | read-only mounts, no-network, per-worktree container / `sandbox-exec` profile | yes (hard) | no (tool errors) | fs + network, vendor-neutral | all |

| Tier | Mechanism | Can deny | Reason reaches model | Covers | Vendors |
|---|---|---|---|---|---|
| 1 · hook | vendor pre-tool-use hook in the worktree (`.claude/settings.json`) calling `agile hook`; for Pi, an in-process extension (`tool_call` block + `tool_result` rewrite) | yes | yes | every tool incl. Read/Grep | Claude (verified); Pi (verified, incl. result rewrite); Cursor (project hooks don't fire headless) |
| 1b · client fs | daemon serves `fs/read_text_file` / `fs/write_text_file` and can refuse with a message | yes | yes (verified: model quoted the reason) | reads + writes only | Grok (verified); any vendor that uses client fs |
| 2 · ACP permission | daemon answers `session/request_permission` | yes | no (generic "refused") | Claude: edits + non-allowlisted exec; Cursor: all exec; Codex/Grok: nothing | vendor-dependent |
| 3 · observation | daemon watches `tool_call` stream | no — but can `session/cancel` the turn and re-prompt with the reason | everything | all ACP vendors |

Routing considers gateability: a vendor with ungated exec (Codex, Grok) is an engineer only inside a tier-0 sandbox; reviewers/QA on such vendors get a filesystem-level read-only checkout. `codex-acp` cannot be made to ask (tested: every mode, `approval_policy = "untrusted"`), so if Codex needs approvals its adapter is the native `codex app-server`. Note Codex reads files via shell (`sed -n`), so its read gate is an exec gate.

The `approve_plan` gate maps onto Claude `plan` mode: run the planning turn in `plan`, and the daemon's answer to the `ExitPlanMode` / "Approve Plan" permission request is the gate decision (human or delegated per policy).

Engineers run in `default` mode so tier 2 sees edits/exec; a `bypassPermissions`/`auto` engineer would blind tier 2. Tier 3 is the floor for vendors without hooks: raw big-file reads get counted, and after N the daemon cancels the turn and re-prompts with the gate reason — slower, same outcome, never a wasted merge because pre-commit is a git hook.

Minimum hook/gate set:

- **pre-tool-use / read**: large or multi-file reads redirected to a reader agent that returns a summary.
- **pre-tool-use / any**: check halts dir, drain inbox (block on urgent, inject on normal), heartbeat, budget gate (refuse if ticket over ceiling).
- **pre-commit**: review approved + tests pass; refuse while a halt file covers this ticket.
- **oracle write guard**: architect only, decision ID required, graph validated.
- **ticket pickup**: status `ready`, no halt in scope, all `oracle_refs` active.
- **escalation gate** (on negative review/QA verdict): `attempts++`; if `attempts > max_attempts`, resolve next tier from `routing.escalation`, reassign with verdict history as context, notify em. Fix work on a non-escalated ticket goes back to the same agent with the verdict as context.

## 7. Tool framework

A tool is a folder, not daemon code: `.agile/tools/<name>/tool.yaml` (+ prompt, optional script).

```yaml
name: read_summary
kind: reader
trigger:
  hook: pre-tool-use
  match: tool in [Read, cat] and (file.size > 30KB or files > 5)
action: redirect          # redirect | deny | augment | require
runner:
  tier: trivial           # routed through the same quota-aware policy
  max_output_tokens: 400
input:  { path: string, question?: string }
output: { summary: string, refs: [{path, lines}] }
cache:
  key: [file_hash, question]
  ttl: sprint
ledger_kind: reader
promote_to_kb: optional   # summaries can be proposed as KB facts
```

- Daemon loads the registry at start, exposes every tool over its MCP server (agents can call them directly), and the hook enforces: a matched raw call is denied with the tool's result already attached. Exposed *and* enforced — prompt-only is not trusted.
- Cache by content hash so a file is summarized once per sprint, not once per agent.
- Every tool has a ledger kind so the retro shows which tools earn their keep.
- Output contracts carry the signal-over-volume rule: `test_run` returns failing test names, assertion messages, and the relevant stack frames — never a green log; `find_in_repo` returns hits with one line of context and a count, not the file; `diff_summary` returns changed symbols and risk notes, not the diff (the diff is a path).
- Starter set: `read_summary` (large files), `find_in_repo` (grep, summarized hits), `kb_lookup` (scope-first, before source), `test_run` (failures only, never full output), `log_tail`, `diff_summary` (reviewers), `doc_lookup` (library docs, cached).

## 8. Adapter contract (ACP)

Every engineer/reviewer/QA is a process: `(ticket, oracle_refs, kb_refs, worktree) → (diff, report, status, ledger events)`. Each vendor's CLI/SDK is wrapped behind this. Ceremonies and comms happen in our layer, never the vendor's. Specifics depend on testing each vendor's hook surface (block-with-reason, inject-context, turn limits).

### Auth

```yaml
# .agile/vendors.yaml
claude:
  accounts:
    - id: max          # `claude login` OAuth — Max subscription
      auth: subscription
    - id: api-overflow
      auth: api_key    # ANTHROPIC_API_KEY, used when max is low
openai:
  accounts:
    - { id: chatgpt, auth: subscription }   # codex login (ChatGPT plan)
cursor:
  accounts: [{ id: main, auth: subscription }]
gemini:
  accounts: [{ id: google, auth: subscription }, { id: api, auth: api_key }]
```

- Subscription auth is the default; API key is an option, never a requirement. The adapter spawns the vendor harness with that account's environment/profile so the harness does its own auth; the daemon only records which account each agent is running under (feeds the quota record and the ledger).
- Routing candidates are `(vendor, account, model)`, so "Max first, API key as overflow" is a routing policy, not special-casing.
- Known: Claude Code over ACP honors the subscription login; the Claude Agent SDK does not. So the Claude adapter is ACP-first (CLI stream mode as fallback), never the SDK. Verify the equivalent for each other vendor in the spike.

### Prior art: Terma

Terma (Pete's Electron terminal) already has a working ACP client. Lift, not re-derive: `src/main/terminal-host/acp-session.ts` (spawn, JSON-RPC framing, fs methods, request forwarding, turn markers, kill escalation — Node-only), `src/shared/acp-types.ts`, `acp-providers.ts`, `agent-session-contract.ts` (vendor-neutral `MessageableSession` seam), `src/main/lib/control/messageable-acp-session.ts`, `mailbox.ts` + `wait-graph.ts` (swap the Drizzle store for files/sqlite), `orchestration2/triage.ts` safe-command classifier. Do not lift orchestration2's model (DB-as-oracle, two roles, review gate default off).

### Vendor status (spike, 2026-09-07)

| vendor | surface | status |
|---|---|---|
| Claude Code | `@agentclientprotocol/claude-agent-acp` 0.75.1 | verified: perm matrix, hooks, cancel, `session/load`, ambient login |
| Codex | `@agentclientprotocol/codex-acp` 1.10.0 (also native `codex app-server` JSON-RPC with `turn/steer`) | runs on ChatGPT login; no permission requests in any mode or approval policy; cancel + load OK; app-server is the path if approvals are needed |
| Gemini CLI | native `gemini --experimental-acp` | skipped — needs a paid Code Assist/Workspace account |
| Cursor | native `cursor-agent acp` | runs after ACP `authenticate(cursor_login)`; prompts on all exec, not edits; `ask` is prompt-level; project hooks don't fire headless; cancel + load OK |
| Grok | native `grok agent stdio` | runs on cached token; no permission requests; client fs for all file I/O and a refusal reason reaches the model; cancel + load OK |
| Pi | `pi-acp` (or `@geohar/pi-acp`) over `pi --mode rpc` + an `agile` extension in `~/.pi/agent/extensions/` | **verified**: block-with-reason on every tool, `tool_result` rewrite, cancel 11 ms, `session/load`, auth from `auth.json`. No ACP permission requests (all gating is the extension). Set `quietStartup: true`. Logins: Claude Pro/Max (billed as extra usage), ChatGPT, xAI subscription, API keys |

Spike harness: `permission-matrix.ts` (in Terma at `spike/agile-agents/`), scenarios `perm | cancel | resume | auth`, `--hooks` for the Claude PreToolUse test.

Principle: every vendor TUI is a client of that vendor's agent loop; the daemon replaces the TUI as the client. Prefer each vendor's programmatic surface (SDK, JSON stream, JSON-RPC/ACP) over scraping a PTY. Normalize to one internal event schema (text delta, tool call, tool result, permission request, turn end, usage) so the chat panel, the bus, and the ledger never see vendor specifics.

## 9. Sprints as dependency layers

A sprint is one layer of the ticket dependency graph: the EM takes the frontier — every `ready` ticket whose `depends` are all done — as the next sprint, optionally capped in size. When the layer lands, the next frontier is the next sprint. No wall time anywhere; hundreds of small sprints is the expected shape. Sprint review fires when the layer is done (or a circuit breaker trips). With `sprint_review` delegated, the EM merges and plans the next layer immediately; with it on `human`, in-flight work finishes, engineers idle, and the EM pre-plans the next layer so one approval unblocks both.

Token budgets are safety only: `budget_tokens` on a sprint is a circuit-breaker signal, not a planning input; per-ticket ceilings are the 3x-estimate anomaly detector that routes to the EM, not a stop.

## 10. Quota-driven pause and handoff

Agent state lives outside the agent (ticket, worktree, thread, stanzas), so swapping the agent under a ticket is the dead-agent recovery path done on purpose.

- **Graceful handoff**: `quota_low` on the current account → daemon injects (normal priority) an instruction to write a `handoff` stanza (done / next / gotchas / uncommitted state) and commit WIP; stops the agent; assigns the ticket to the next candidate (any vendor above the floor), which starts in the same worktree with thread + handoff as context. Ledger splits the ticket across both `(vendor, model)` cells.
- **Hard handoff**: 429 mid-turn → daemon composes the handoff from diff + last stanzas; same path.
- **Pause**: no candidate above the floor for that tier → ticket status `paused`, `resume_at` = earliest `resets_at` among candidates; daemon scheduler resumes it. Other tiers with live candidates keep flowing.
- **Manual**: `cooldown_until` on an account ("keep my Max window free for 4h") triggers the same handoffs.

Ticket status gains `paused`; stanza kind gains `handoff`. Vendor list includes xAI/Grok.

## 11. Pointing rubric and routing calibration

**Points** (Fibonacci 1/2/3/5/8) measure work; used for sprint capacity and the retro's spent-vs-estimate check. Over 8 → split by rule.

**Tier** measures required intelligence and drives routing. The architect answers four questions; the tier is the worst answer:

| Question | trivial / standard | hard | novel |
|---|---|---|---|
| Ambiguity | contract fully specified by oracle refs | requires choices the oracle doesn't make | choices that would themselves be decisions |
| Blast radius | one module | crosses a bounded context | public interface or data model |
| Verifiability | executable acceptance tests | needs judgment to evaluate | can't be written until done → it's a spike |
| Precedent | pattern to copy in KB/codebase (trivial) or similar pattern (standard) | none | none |

`reasoning` (low/medium/high) defaults from tier; architect may override.

Calibration: at retro, any ticket that escalated or exceeded 3x budget gets its rubric answers re-scored against what happened; recurring patterns become KB facts ("touching the webhook router is always hard-tier").

**Tier → model** is a seeded table corrected by outcomes, not an eval system at first:
- Seed by judgment (trivial → cheapest capable, low reasoning … novel → frontier, high).
- Every assignment is an experiment: ledger records `(tier, vendor, account, model, reasoning)`; outcome falls out of the state machine (first-try accept, attempts, escalated, cost, wall time). Retro renders a scoreboard per cell; the table is adjusted from it.
- Canary routing: policy can send N% of a tier to an alternate candidate; promote when the scoreboard says so. Same path for trying a newly released model.
- Eval harness later, for free: every `done` ticket is a reproducible case (start commit, contract, acceptance criteria). `agile bench --tier standard --model Y` replays a sample in throwaway worktrees, offline, as a deliberate action.
- Watch: a bad cell may mean the rubric under-tiered, not that the model is weak; the retro re-scoring separates the two.

## 12. Review protocol

- **Reviewers**: one primary always, on a different vendor than the implementer when quota allows. A second, security-mandate reviewer when `contract.inputs` touch a sensitive scope (auth, secrets, network boundaries, dependency manifests, anything the architect tags `security: true`) or tier is hard/novel. Trivial tier gets one cheap reviewer.
- **Adversarial, operationally**: the brief is to find reasons to reject. Report = findings with severity, each tied to a rule (`RULE-012`) or an oracle ref (`violates DEC-0042`). "No findings" must list what was checked. Reads diff summary + contract first, diff second, source third, all through tools. Does not run tests — that's QA; the split is what keeps review adversarial.
- **Verdicts**: `approve` · `request_changes` (findings to address) · `escalate` (the ticket/contract is wrong, not the code → EM as a discovery).
- **Convergence**: a reviewer may not raise on re-review a finding visible in the first pass. Engineer and reviewer disagree twice on one finding → daemon routes it to the architect as a `question`; general rulings become a rule or KB fact.
- **Rules** live in `.agile/rules/RULE-012.md`, one per file with an ID, so findings cite them and the retro counts which rules are violated most.

## 13. QA environment and protocol

- **Where**: fresh clone of the ticket branch in a throwaway directory by default (`env: clone`); a container when the ticket says so (`env: compose: <file>`, set by the architect when criteria need a DB, queue, browser). Daemon provisions, hands QA a path and base URL, tears down after the verdict.
- **Not reading the implementation is enforced**: QA's tool permissions deny `Read`/grep on `contract.outputs` and `contract.inputs`. It may read tests, fixtures, docs, the contract; it may run anything. A criterion that can't be exercised from outside is a finding against the criterion → escalate to the architect.
- **Output**: `accept` / `reject` plus one line per criterion — pass/fail, the command or action used, and for failures observed vs expected via `test_run`. Reject returns to the engineer with the report as context and bumps `attempts` at the escalation gate.
- **Executable criteria preferred**: commands or test files QA is allowed to write and the engineer never sees (no teaching to the test). The KB accumulates the repo's ways of exercising things.
- **Flakiness**: one rerun before calling a failure; two different results is a `flaky` finding filed to the KB.

Ticket contract gains `env: clone | compose: <path>`.

## 14. Permissions per role

The daemon answers every ACP permission request by role; almost nothing reaches a human.

| Role | Read | Write | Run | Network |
|---|---|---|---|---|
| Engineer | own worktree; state via daemon | own worktree only | tests, build, linters, repo scripts | package registries only |
| Reviewer | worktree via tools, rules, oracle | nothing | read-only tools | none |
| QA | env minus `contract.inputs/outputs` | own test files in the env | anything in the env | env base URL |
| Architect | oracle, tickets, KB | oracle (write guard), tickets, rules | none | none |
| EM | state via daemon | sprints, assignments, policy proposals | none | none |
| Reader / tool runners | the tool's input scope | nothing | nothing | none |

Never without a human: push to anything but the ticket branch; force-push; branch deletion; direct writes to `.agile/`; installing a *new* dependency (a decision → discovery to the architect); network outside the allowlist; a maintained deny list (`rm -rf`, `curl | sh`, credential files).

- Deny always carries a reason and a pointer ("use `read_summary`", "new deps require a DEC — file a discovery") so the agent knows the next move instead of retrying.
- Every permission decision is logged; the feed shows denials when an agent looks stuck.
- Circuit-breaker signal: N denials on one ticket in a short window = agent fighting the sandbox → mis-tiered ticket or wrong contract.

## 15. Git model and teams

- `.agile/` lives on an orphan branch `agile-state`, checked out as its own worktree. Product history stays clean; state stays git-tracked and diffable. Agents read state through the daemon, not from their worktree.
- One daemon per repo (it locks the state worktree at start). The unit of concurrency is a **team**, not a session: `team` on sprints, agents, and epics. Teams run parallel sprints against one oracle, one board, one bus, one set of vendor accounts. One architect per repo; one EM per team. Halt scope gains `team:` alongside `global` and ticket lists. Control room has a team filter, default all.
- One worktree per ticket at `.worktrees/TKT-0231` on `tkt/0231-<slug>`, created by the daemon off `integration` at assignment. Fix cycles and escalations reuse the same worktree — the diff and thread are the handoff. Deleted after merge; kept while `stale`/abandoned until the architect says otherwise.
- Merge cadence: ticket → `integration` on `done` (integration owner rebases; conflicts bounce to the ticket owner as a scoped halt). `integration → main` at sprint review, behind the `sprint_review` gate.
- Isolated experiments that must not share the product oracle are a different repo or a consciously forked `agile-state-<name>` branch, never the default.

## 16. HIL gates policy

Every place a `hil_request` can fire is a named gate with an owner.

```yaml
# .agile/policy.yaml (repo default)
gates:
  approve_plan:     human
  approve_decision: human            # product-level DECs
  sprint_review:    human            # integration → main
  unblock:          em
  demo:             human
```

- Owner: `human` | `em` | `architect` | `human_timeout: <duration>` (ask the human; if no answer by the deadline, proceed as the fallback owner would).
- Resolution, most specific wins: sprint → epic → team → repo default. The sprint file carries its own `gates:` block. The EM's sprint proposal includes a recommended gate block with a one-line reason per gate; the human accepts or edits it as part of `approve_plan`. Mid-sprint changes are toggles on the sprint strip that write back to the sprint file.
- Single-instance override: any pending `hil_request` can be delegated from the attention queue without changing policy.
- Delegated gates produce the same artifact (decision record, `by: em`, rationale) and send the human a low-priority `fyi` instead of a request, so the log reads identically and the retro can audit what was approved without a human.
- Circuit breaker: configurable signals (global halt this sprint, budget over X%, integration tests red, escalation ladder exhausted, reviewer/engineer deadlock) force every gate to `human` until cleared. Overrides all layers upward.

## 17. Human UI

Chat with the EM is the steering channel, not the observation channel. Status must never cost tokens; it is read straight from daemon state.

### Control room (local web app served by the daemon)

- **Attention queue** (top, the only thing that nags): every open `hil_request` — approve_decision / steer / demo / unblock — with deadline, what it blocks (halt, tickets), and a reply box. Empty is the goal state.
- **Team**: one row per registered agent — vendor/model, current ticket, last heartbeat, tokens vs ceiling, latest board stanza. Halted agents striped. Click → stanza history + thread.
- **Board**: tickets columned by status, current sprint by default. Tier/points on card, amber mark when inside a halt scope. Click → rendered ticket YAML, thread, stanzas, worktree diff.
- **Oracle**: active decisions/specs from the index, ripple graph on demand, changelog below.
- **Feed**: event log tailed live, filterable by ticket/agent/kind.
- **Sprint strip**: goal, tickets done, token burn vs budget, global halt count, and the **vendor barometer** — per-vendor gauge, resets-in, confidence dot.
- **EM chat** in a side panel of the same app. Daemon injects the current attention queue into the EM context when the panel opens.

**Layout direction (from mockup review)**: the first mockup was too busy. Every panel (team, board, feed, oracle) is collapsible/hideable or its own view; the default view is calm. "Needs you" is an inbox: one line per item (kind, subject, deadline); clicking opens that item's detail and actions — never all details at once. Spend and the vendor barometer are hidden behind an icon in the top bar, shown on demand. Iterate on UX after the system is functioning; the mockup is a starting point, not a spec.

Deliberately absent: drag-and-drop scheduling (EM's job) and direct chat with individual engineers (tell the EM).

### Technical shape

- **One TypeScript monorepo**; schemas (ticket, message, oracle header, stanza) defined once in zod and shared by daemon, hooks, CLI, and UI. This is the main reason not to split languages.
- **`agiled` daemon** (Node or Bun): owns `.agile/`; JSON-RPC over unix socket for hooks/adapters; HTTP + WebSocket on localhost for UI/CLI; serves the built UI as static files. sqlite behind the same API when files hurt.
- **`agile` CLI**: same client lib. `agile status`, `agile approve H-12`, `agile chat`, `agile tail`. Also the single entrypoint every vendor hook config calls (`agile hook pre-tool-use`), normalizing each vendor's hook payload format.
- **UI**: React + Vite SPA, read-mostly, WebSocket for live events. Every write goes through the same daemon endpoints agents use, so it lands on the bus and in the log.
- **EM chat**: the EM runs as a child process of the daemon, not in a vendor TUI. Claude via ACP (works with a Claude Code subscription login; the Agent SDK does not — per Pete), which gives the same things an SDK would: typed message stream, permission requests, cancel, streaming, session resume. Other vendors via ACP where they speak it, else their headless JSON stream modes. The daemon relays events over WebSocket; the chat panel and `agile chat` render the same stream. This is what lets the daemon inject the attention queue / halt notices into the EM context and log every turn. Decided: SDK-driven chat from day one (no embedded-TUI v1); start bare — input box, streamed markdown, tool calls as one-liners, stop button, permissions pre-decided — and grow it.
- **Redirecting when things go wrong**: (1) a **Halt** button that writes a global halt file with `raised_by: human` — same hook path as a discovery halt, no explanation needed to stop the bleeding; (2) **steer → action set**: a steer in chat makes the EM propose a concrete action set (cancel ticket, abandon worktree, propose DEC, re-refine) rendered as a card; approving the card executes it and logs a decision with the human's name on it. Never bypass the EM to an engineer — the EM's model of the team must stay true.
- **Oracle / KB viewer**: Oracle pane renders decisions, specs, changelog from the index; KB tab for the knowledge store (pruning). Human edits are *proposed*, not saved — they become a `decision` request the architect processes through the write guard so graph validation and the ripple walk still run.
- **Notifications**: daemon → OS notification on `hil_request`; optional push (e.g. ntfy) so demo approvals can happen from a phone on the LAN/tailnet.
- Not building: Electron — it forks the process model (daemon either lives inside Electron and dies with the window, or Electron is just a browser pointed at localhost, which a tab already is), plus ~200MB and a build/sign/update pipeline; tray/global-shortcut can come later via a Tauri shell around the same bundle. Not a multi-pane TUI either (diffs, graphs, long threads are bad in a terminal); `agile tail` / `agile status --watch` cover the in-terminal case.
- TypeScript over Rust: the daemon is I/O-bound (YAML, JSONL appends, fan-out, process stream proxying) at a dozen agents making a tool call every few seconds; Node is nowhere near a bottleneck. Ripple walk / grep over a large oracle is sqlite's job. Tauri would not add performance — its Rust is the window shell, not app logic. A hot spot, if one ever appears, is one function that can move to a native module.

## 18. Build decisions (2026-09-08)

- **Separate app, not folded into Terma.** Terma is a terminal you look at; Agile Agents is a factory you steer. Folding would put the daemon, state, and control room inside Terma's Electron process model, `test:electron` harness, and release cadence — the coupling the design rejected — and next to `orchestration2`, the competing (DB-as-oracle, two-role) model.
- **Extract, then consume.** First ticket: lift Terma's ACP layer (`acp-session.ts`, `acp-types`, `acp-providers`, `agent-session-contract`, `acp-events`/`acp-session-contract`) into a shared package both apps depend on. Terma then becomes a *client* of `agiled` — an Agile Agents pane (attention queue) and live terminal panes attached to engineers' sessions, which a browser control room can't do as well. `orchestration2` retires in Terma on its own schedule.
- **Runtime**: Bun (matches Terma). **Layout**: one monorepo with workspaces `daemon`, `cli`, `acp-client`, `ui`, `shared` (zod schemas). Name still a placeholder (`agile`, `.agile/`, `agiled`).
- **v0 scope**: one repo, one team, Claude for every role, files as the only state backend, CLI + event feed as the only UI, no tier-0 sandbox yet. Exercises daemon, ACP client, state model, bus, hook gate, and one full ticket loop (assign → implement → review → QA → merge). Everything after is additive: routing + quotas, more vendors (Pi next, then Cursor/Grok/Codex), handoffs, gates policy UI, control room, sandbox.

## 19. Open questions / next steps

**Spike — closed (see design/spike-findings.md). Small follow-ups:**
- Cursor: try user-level `~/.cursor/hooks.json` against the headless agent; otherwise Cursor is tier 2 (exec) + tier 0.
- Codex: prototype the native `codex app-server` client to confirm approval requests flow and whether a rejection carries a reason.
- Tier 0 sandbox mechanism per OS (`sandbox-exec` vs container) with vendor logins intact.
- Pi: done — adapter is `pi-acp` (fork if needed), enforcement in the `agile` extension. Quota record for Pi-on-Claude is extra-usage $, not the Max window.
- Gemini out until an account exists.

**Decide by building (defaults now, tune from the ledger)**
- Heartbeat interval; quorum timeout; halt WIP handling (commit to ticket branch vs stash).
- Message body cap; tool cache TTL; quota floor; reader summary format (reusable as KB facts).
- KB dedupe and expiry.
- Control room: framework (React vs Solid/Svelte), v1 pane scope, phone push for the attention queue.
- Event log export to OTel or not.
- Name: `agile` / `.agile/` / `agiled` are placeholders.

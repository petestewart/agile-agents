# Model routing: who picks a node's model, and how

Status: **proposed** (2026-09-29). Nothing here is built yet. The open
decisions are MR1–MR6 in §9. Once Pete confirms them they become D-entries
in PLAN.md, and T482–T485 are built from this document.

## 1. The problem

Today no agent chooses a model. A coordinator's `add_child` and `start_node`
take a title, goal and repo, nothing about the model. The Director's nodes
are the same. Any node started without an explicit pick resolves in this order:

1. its own last session (T464);
2. the project's defaults;
3. the repo's entry in `repos.yaml`;
4. the home default;
5. the built-in default (Claude Opus 5.5, low effort).

So a coordinator on Opus can start ten simple parts on Opus, or a
hard migration on whatever the home default happens to be. The parent's
knowledge of the task never reaches the choice, and the operator has no
way to say what they're willing to trade.

Pete (2026-09-29): model choice is configurable per project or node, with
**inherit** and **choose** as options. The operator describes how the choice
should be made, both as free text and as settings. A **chooser** looks at the
task being handed off and picks the model and effort. The operator can lock
the choices to a set of models and effort levels.

## 2. Terms

- **Pick:** the vendor, model and effort a session starts on.
- **Explicit pick:** one the operator made: the composer's model chip, Start
  with…, `agile attach --vendor/--model/--effort`, or a model named in New node.
- **Routed pick:** any other pick. That covers a coordinator's or the
  Director's child, a wake that starts an agent, an escalation, and a node the
  operator created without choosing a model.
- **Policy:** the settings below. The home config sets the default, a project
  can set its own, and a node can set its own, field by field (§4).

## 3. The policy (what the operator sets)

The **dials** state what the operator is willing to trade. They're set once
and rarely touched.

| Setting | Values | Meaning |
|---|---|---|
| **Mode** | `default` · `inherit` · `choose` | `default`: today's resolution (§1). `inherit`: a routed pick copies the parent node's current pick. `choose`: the chooser decides (§5). |
| **Quality priority** | slider 0–100, "Favor speed & cost" → "Favor quality" (default 50) | The one trade-off the chooser weighs everything against. It's clearer than an "intelligence level": the operator knows their trade-offs better than what a task needs. |
| **Allowed models** | a set of vendor/model pairs; empty means any installed model | The lock. No routed pick, chooser output or escalation leaves the set. Once T469 exists, "my favourites" is one click. |
| **Effort ceiling** | low · medium · high · max (per vendor, where the vendor has effort) | The highest effort a routed pick may use. |
| **Escalation** | `start cheap` · `strongest first` | `start cheap`: begin at the cheapest model the task scores allow, and step up when checks fail or the work stalls (§6). `strongest first`: pick the strongest allowed model and stay there. |
| **Budget cap** | per session, and per node | Measured first (§7, MR1). |
| **Pinned rules** | an ordered list: *when* → *pick* | These bypass scoring. The *when* is a node's role (coordinator/planning, reviewer, conversation, worker), a label, or the chooser's own reading of "architecture", "migration" or "security". Examples: "coordinator → Opus 5.5 · high", "reviewer → Sonnet 5.5 · medium". |
| **Guidance** | free text, ≤ 2,000 characters | Read by the chooser as written, like a prompt. For example: "Anything touching billing gets Opus. Prefer Codex for Rust." |
| **Criterion weights** | one weight per criterion in §5, 0–3 (default 1) | Optional. Shown so the operator can see why the chooser decided what it did, and tune it. |

**Model profiles.** The chooser needs to know which models are cheap and which
are strong, and the vendors don't report that. T467 gives each model a name
and a vendor description ("Fastest for quick answers"), but no price and no
tier. Each allowed model therefore gets a small profile in the home config:

- `tier`: fast, balanced or strongest;
- `cost`: a relative weight, e.g. Sonnet 1, Opus 2, Haiku 0.3.

Defaults ship for the Claude and Codex models measured in §12, and Settings
edits them. A model with no profile reads as balanced, cost 1, and the chooser
also sees the vendor's description. Only the operator can set profiles. They go
stale the way any price table does. That's accepted, because it is visible,
editable data, not code.

## 4. Where the policy lives, and how it resolves

- Home: `config.yaml` `model_policy` (the default for everything).
- Project: `projects/<id>.yaml` `model_policy`, next to its `session`
  defaults (P5).
- Node: `streams/<id>.yaml` `human.model_policy`. It is a human-only field,
  like `rules_off`, `permissions` and `auto_close`, so the store refuses an
  agent, coordinator or Director write.

Each field resolves node → project → home → built-in (`mode: default`).
A child node inherits from its **ancestors'** node policies before the project's,
so a policy set on a coordinator governs its whole subtree. All schemas live
in `packages/shared`, `.strict()`.

**Precedence of the pick itself**

1. An explicit pick always wins. The lock binds agents, not the operator.
   A pick outside the allowed set is still honoured, and the chat says "outside
   this project's allowed models". (MR3)
2. The node's own last pick (T464) holds while the node keeps running. A
   routed pick is made once, when the node's agent first starts, and again only
   on an escalation or when the operator clears the node's pick (Details →
   "Let the policy choose again").
3. Pinned rules, in order. The first match wins.
4. Mode: `inherit` copies the parent's current pick; `choose` runs §5; `default`
   resolves as today.
5. Clamp: the result is forced into the allowed set and under the effort
   ceiling. When a clamp changes it, the chat says so.

## 5. The chooser

**What it is.** A one-shot call to the quick-draft model, the same mechanism
that titles nodes (T414 and D41: `claude -p --model haiku --tools ""`, a timeout,
never under `bun test`, off with Quick drafts). It runs no tools and writes no
files; it returns one JSON object, which a `packages/shared` zod schema
validates. When Quick drafts is off, the call fails or times out, or the reply
doesn't validate, the **rule fallback** decides instead (below), and the chat
says so.

**What it sees.** The task and the policy, nothing else:

- the task: title, goal, role, repo, parent's title and goal;
- the parent's plan entry for this part, when there is one;
- how many siblings are starting now (volume);
- the policy: quality priority, guidance text, pinned rules, criterion weights;
- the allowed models, each with its tier, cost and vendor description.

It never sees credentials, the thread or file contents.

**What it scores.** Each criterion from 1 to 5. The scores are shown to the
operator, so the decision can be read and argued with.

| Criterion | Low (1) | High (5) | Pushes toward |
|---|---|---|---|
| **Spec clarity** | open-ended | well-defined, acceptance stated | clear → cheaper |
| **Verifiability** | nothing can prove it | a test, build or typecheck proves it | checkable → cheaper |
| **Horizon** | a quick fix | a multi-hour, many-step job | long → stronger |
| **Stakes** | easily undone | security, data migration, architecture, money | high → stronger |
| **Volume** | a one-off | many similar parts at once | high → cheaper |

**What it returns.**

```json
{ "scores": { "clarity": 4, "verifiability": 5, "horizon": 2, "stakes": 2, "volume": 1 },
  "pick": { "vendor": "claude", "model": "claude-sonnet-5-5", "effort": "medium" },
  "reason": "Well specified and covered by the test suite; short and low-stakes." }
```

The daemon then checks the pick. It must be an allowed model, at or under the
effort ceiling, and an installed vendor. If it isn't, the daemon clamps it
(§4, step 5) and records both what the chooser said and what ran.

**The default rule.** This is what the chooser prompt states, and the whole of
the rule fallback. "Use a balanced model when the task is well specified and
checkable. Use the strongest allowed model when it's ambiguous, high-stakes or
long-horizon. Use the fastest when it's high-volume and checkable. Quality
priority moves the thresholds: toward speed, a balanced model needs clarity and
verifiability of only 3; toward quality, 4." Effort follows the same scores:
long-horizon or high-stakes work goes one level up, and nothing goes above the
ceiling.

**What the operator sees.**

- One line in the node's chat when the agent starts: "Chose Sonnet 5.5 ·
  medium — well specified and covered by tests; short, low stakes." A pinned
  rule or a clamp says so instead.
- The node's Details shows the five scores, the policy it resolved from and
  where (node, project or home), and **Let the policy choose again**.
- Settings shows the policy, with a **Try it** box: paste a task and see the
  scores and the pick, without starting anything.

## 6. Escalation

Only under `start cheap`. The **ladder** is the allowed models ordered by tier
then cost, and within one model, its effort levels up to the ceiling. One step
up means the next effort level on the same model first, then the next model.

These trigger a step up at the **next start** of the node's agent, never in the
middle of a turn. Each uses a signal the daemon already sees. Tests an agent
runs inside its own turn are not one of them, which is why the agent can ask
(the last trigger).

- **A merge refused twice.** Merging the node was refused twice for the same
  reason, with a turn in between that tried to fix it. The reasons are a `ship`
  check (a knowledge item with `ship` enforcement) or the merge preflight's
  conflicts.
- **A stall.** A turn fails (T460), the context fills (T411's reading passes
  90%) without the goal being met, or N turns pass with no commit and no
  `progress` (N defaults to 3).
- **Asked.** The agent calls `escalate {why}`, for example "the tests still fail
  and I can't see why". This is a new verb, gated by the lock like any other
  routed pick. An agent can ask to step up but can never choose its own model.
- **The operator.** Details → **Step up**, which takes the next rung. It's the
  one-click form of picking a stronger model with the chip.

A reviewer's findings are not a trigger. Since T131 a review returns findings,
not a verdict, and the operator decides what they mean.

An escalation is a thread line ("Stepped up to Opus 5.5 · high: the tests
failed twice on Sonnet 5.5") and a record-only event in Events and Activity.
The top of the ladder can't step up. Instead the node goes to Needs me:
"<node> is stuck on the strongest allowed model", with the reason. A model
change ends a resting session (T465); the next start is fresh and gets the
thread and the brief.

`strongest first` never escalates. It still goes to Needs me on the same
triggers once the retry and fallback rules (T456) are spent.

## 7. Budget (measured first)

Pete logs in with subscriptions, which don't bill per token. So a dollar cap
means nothing there, and no vendor has been seen reporting price over ACP.
What ACP can carry is token usage. `usage_update` gives context `used`/`size`
today, and some vendors may add per-turn token counts or `cost`.

**Proposal (MR1):** a budget is in **weighted tokens**, the tokens a session
used times its model's profile `cost`. Caps are per session and per node. At
80% the chat says so; at the cap, the next turn doesn't start and the node goes
to Needs me with **Raise the cap** / **Stop here**.

Nothing is built until LIVE-CHECKLIST §16 has measured which vendors report
turn token usage, and in what field. A vendor that reports none shows
"no budget: <vendor> doesn't report usage" in the UI, rather than an invented
estimate.

## 8. Where it fits in the code

- `packages/shared`: `ModelPolicySchema` (the §3 fields),
  `ModelProfileSchema`, `ChooserReplySchema`, and the resolution (§4) as a pure
  function beside `resolveSessionSettings`, so the CLI, the cockpit and attach
  resolve it the same way.
- `packages/daemon/src/attach/service.ts`, where T464's `kept` and
  `resolveSessionSettings` are resolved today. A routed pick asks the policy
  service before resolving. `AttachOptions` gains `routed: {by, parent?}` so the
  choice knows who is starting the node.
- `packages/daemon/src/routing/` (new, beside `delivery/` and `knowledge/`):
  - the policy service: resolution, clamp, pinned rules;
  - the chooser: the quick-draft call, the reply check, the rule fallback;
  - the escalation watcher: it subscribes to the merge refusals, turn failures
    and context readings that delivery, T456 and T411 already produce.
- The node record: `agent.pick` (what ran and why: chooser, rule, inherit,
  clamp, escalation, explicit), written by the daemon, next to the sessions.
- UI:
  - Settings → Agents → **Model choice** (home policy, profiles, Try it);
  - the project root's Details → Model choice;
  - the node's Details → Model choice, with overrides shown as "set here" and
    inherited values as "from <project>";
  - the chat line and Details scores from §5.
- CLI: `agile policy show|set [--project P|--node N]`, and `agile policy try
  "<task text>"`.

## 9. Open decisions (for Pete)

- **MR1 · Budget unit.** Weighted tokens, per session and per node, measured
  first (§7). A dollar figure only where a vendor reports cost.
- **MR2 · The chooser model.** The quick-draft model (Haiku today), with the
  rule fallback when it's off or fails. No agent session and no Jev: Jev
  answers yes/no questions, and this is a choice among options.
- **MR3 · Explicit picks and the lock.** The operator's explicit pick always
  wins, with a visible note when it's outside the allowed set. The lock binds
  agents, the chooser and escalation.
- **MR4 · Default for new projects.** `choose`, quality 50, `start cheap`,
  allowed = favourites once T469 exists (any installed model before that), with
  no pinned rules. Existing projects keep `default` until changed, so nothing
  moves under running work.
- **MR5 · When a routed pick is made.** Once, when the node's agent first starts,
  then on escalation or a "choose again". Never silently on a later wake (T464
  stands).
- **MR6 · `escalate` verb.** An agent may ask to step up; it can't pick its own
  model.

## 10. Tickets (after the decisions)

- **T482 Policy and lock.** The schemas, the resolution (§4), `inherit` and
  `default`, the allowed set and effort ceiling enforced on every routed pick,
  and the Settings, project and node UI. Depends on T467's catalog.
- **T483 The chooser.** Scores, pick and reason; pinned rules; guidance; weights;
  quality priority; model profiles; the rule fallback; Try it; the chat line and
  Details scores.
- **T484 Escalation.** The ladder, the triggers in §6, `escalate`, Step up, and
  the Needs me card at the top of the ladder.
- **T485 Budget.** LIVE-CHECKLIST §16 first, then the caps (§7).

T482 is the base for the rest. T483 and T484 can be built side by side after it.
T485 waits on its measurement.

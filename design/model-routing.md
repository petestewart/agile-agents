# Model routing: who picks a node's model, and how

Status: **decided** (proposed 2026-09-29; Pete settled MR1–MR6 on 2026-09-30,
recorded as D51–D56 in PLAN.md). T482–T485 are built from this document;
§11 says how T482, T483, T484 and T490 were built (§12's tier first and
vendor order, D57 and D59).
§9 keeps the decisions as answered.

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
| **Preset models** | a set of vendor/model pairs; empty means any installed model | The lock. No routed pick, chooser output or escalation leaves the presets. "My favourites" (T469) is one click. |
| **Effort ceiling** | low · medium · high · max (per vendor, where the vendor has effort) | The highest effort a routed pick may use. |
| **Escalation** | `start cheap` · `strongest first` | `start cheap`: begin at the cheapest model the task scores allow, and step up when checks fail or the work stalls (§6). `strongest first`: pick the strongest preset model and stay there. |
| **Budget cap** | per session, and per node | Measured first (§7, MR1). |
| **Pinned rules** | an ordered list: *when* → *pick* | These bypass scoring. The *when* is a node's role (coordinator/planning, reviewer, conversation, worker), a label, or the chooser's own reading of "architecture", "migration" or "security". Examples: "coordinator → Opus 5.5 · high", "reviewer → Sonnet 5.5 · medium". |
| **Guidance** | free text, ≤ 2,000 characters | Read by the chooser as written, like a prompt. For example: "Anything touching billing gets Opus. Prefer Codex for Rust." |
| **Criterion weights** | one weight per criterion in §5, 0–3 (default 1) | Optional. Shown so the operator can see why the chooser decided what it did, and tune it. |

**Model profiles.** The chooser needs to know which models are cheap and which
are strong, and the vendors don't report that. T467 gives each model a name
and a vendor description ("Fastest for quick answers"), but no price and no
tier. Each preset model therefore gets a small profile in the home config:

- `tier`: fast, balanced or strongest;
- `cost`: a relative weight, e.g. Sonnet 1, Opus 2, Haiku 0.3.

Defaults ship for the Claude and Codex models measured in §12, and Settings
edits them. A model with no profile reads as balanced, cost 1, and the chooser
also sees the vendor's description. Only the operator can set profiles. They go
stale the way any price table does. That's accepted, because it is visible,
editable data, not code.

## 4. Where the policy lives, and how it resolves

- Home: `config.yaml` `model_policy`, edited in Settings → Agents → **Model
  choice** (MR4, D54). It is the default every project inherits, field by field,
  unless it sets its own. What ships: `choose`, quality 50, `start cheap`,
  presets = favourites (any installed model when there are none), no pinned
  rules. A project that existed before T482 is stamped `mode: default` once, with
  a line on its root's thread, so nothing moves under running work; the operator
  changes it in the project's Details.
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
   A pick outside the presets runs as picked, and the chat line says so in a
   way that can't read as refused: "Running Opus 5.5, as you picked. Routed
   picks here use this project's preset models." (MR3, D53)
2. The node's own last pick (T464) holds while the node keeps running. A
   routed pick is made once, when the node's agent first starts, and again only
   on an escalation or when the operator clears the node's pick (Details →
   "Let the policy choose again").
3. Pinned rules, in order. The first match wins.
4. Mode: `inherit` copies the parent's current pick; `choose` runs §5; `default`
   resolves as today.
5. Clamp: the result is forced into the presets and under the effort
   ceiling. When a clamp changes it, the chat says so.

## 5. The chooser

**What it is (MR2, D52).** One Jev call (TypeSafe `systemone`) using its
**choice** primitive: each question names a fixed set of options, and Jev
returns the chosen option, the probability of every option and a confidence
from 0 to 1 (<https://docs.typesafe.ai/primitives/choice>). All the questions
go in one request; they are evaluated side by side, so asking seven barely
costs more than asking one. It needs the classifier key (D16). It sees only the
text below, never credentials, the thread or file contents, and it goes through
the same scrubber as a rule check.

**What it is asked.** The `state` is the task and the policy:

- the task: title, goal, role, repo, parent's title and goal;
- the parent's plan entry for this part, when there is one;
- how many siblings are starting now (volume);
- the guidance text, the quality priority and the criterion weights.

The questions:

| Id | Options | Asks |
|---|---|---|
| `clarity` | 1–5, each described | How well specified is the task? 1 open-ended, 5 well defined with acceptance stated. |
| `verifiability` | 1–5 | Can a test, build or typecheck prove it? |
| `horizon` | 1–5 | A quick fix (1) or a multi-hour, many-step job (5)? |
| `stakes` | 1–5 | Easily undone (1), or security, a data migration, architecture or money (5)? |
| `volume` | 1–5 | A one-off (1), or one of many similar parts starting at once (5)? |
| `topic` | architecture · migration · security · none | For pinned rules that name a topic. |
| `model` | the preset models, keyed `vendor/model` | Which model should run it? Each option is described by its name, tier, relative cost and the vendor's own description. The instructions carry the default rule (below), the quality priority and the guidance text. |
| `effort` | the effort levels up to the ceiling | Asked only when a preset model has effort. |

A score is the probability-weighted mean of its options, so "4.6" shows how
sure Jev was, not only its top answer.

**How the pick is made.**

1. Pinned rules first (§4 step 3), using the role, the labels and `topic`.
2. Jev's `model` choice, when its confidence is at least 0.5. Its `effort`
   choice applies when the model's vendor has effort.
3. Below 0.5, the **rule fallback** decides from the scores instead, and the
   chat line says "Jev wasn't sure; chose by the scores".
4. The clamp (§4 step 5) runs last on every path.

**The default rule.** It is written into the `model` question and is the whole
of the rule fallback. "Use a balanced model when the task is well specified and
checkable. Use the strongest preset model when it's ambiguous, high-stakes or
long-horizon. Use the fastest when it's high-volume and checkable. Quality
priority moves the thresholds: toward speed, a balanced model needs clarity and
verifiability of only 3; toward quality, 4." Effort follows the same scores:
long-horizon or high-stakes work goes one level up, and nothing goes above the
ceiling.

**Without Jev.** With no classifier key, or when the call fails (401, 429, a
timeout, a reply that fails the schema), there are no scores. The rule
fallback then picks without them: under `start cheap`, the cheapest balanced
preset at medium effort; under `strongest first`, the strongest preset. The
chat line names the reason ("no classifier key", "Jev didn't answer"), and
Settings → Model choice says up front that choosing needs the key.

The request and reply are schemas in `packages/shared`; the wire mapping sits
beside the Noul mapping in `classifier/jev-wire.ts`. Checked against the live
API on 2026-09-30: a well-specified rename with six siblings came back
`model: claude/claude-sonnet-5-5` at confidence 0.82 (Sonnet 0.88, Haiku 0.12,
Opus 0), `clarity` 5 at 0.85.

**What the operator sees.**

- One line in the node's chat when the agent starts: "Chose Sonnet 5.5 ·
  medium — well specified and covered by tests; short, low stakes." A pinned
  rule or a clamp says so instead.
- The node's Details shows the five scores, Jev's confidence, the policy it
  resolved from and where (node, project or home), and **Let the policy choose
  again**.
- Settings shows the policy, with a **Try it** box: paste a task and see the
  scores and the pick, without starting anything.

## 6. Escalation

Only under `start cheap`. The **ladder** is the preset models ordered by tier
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
"<node> is stuck on the strongest preset model", with the reason. A model
change ends a resting session (T465); the next start is fresh and gets the
thread and the brief.

`strongest first` never escalates. It still goes to Needs me on the same
triggers once the retry and fallback rules (T456) are spent.

## 7. Budget (measured first)

Pete logs in with subscriptions, which don't bill per token. So a dollar cap
means nothing there, and no vendor has been seen reporting price over ACP.
What ACP can carry is token usage. `usage_update` gives context `used`/`size`
today, and some vendors may add per-turn token counts or `cost`.

**Decided (MR1, D51):** a budget is in **weighted tokens**, the tokens a session
used times its model's profile `cost`. Caps are per session and per node. At
80% the chat says so; at the cap, the next turn doesn't start and the node goes
to Needs me with **Raise the cap** / **Stop here**.

Nothing is built until LIVE-CHECKLIST §16 has measured which vendors report
turn token usage, and in what field. A vendor that reports none shows
"no budget: <vendor> doesn't report usage" in the UI, rather than an invented
estimate.

## 8. Where it fits in the code

- `packages/shared`: `ModelPolicySchema` (the §3 fields),
  `ModelProfileSchema`, the chooser's scores and pick record, and the resolution (§4) as a pure
  function beside `resolveSessionSettings`, so the CLI, the cockpit and attach
  resolve it the same way.
- `packages/daemon/src/attach/service.ts`, where T464's `kept` and
  `resolveSessionSettings` are resolved today. A routed pick asks the policy
  service before resolving. `AttachOptions` gains `routed: {by, parent?}` so the
  choice knows who is starting the node.
- `packages/daemon/src/routing/` (new, beside `delivery/` and `knowledge/`):
  - the policy service: resolution, clamp, pinned rules;
  - the chooser: the Jev choice call, the reply check, the rule fallback;
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

## 9. Decisions (Pete, 2026-09-30)

- **MR1 · Budget unit (D51).** Weighted tokens, per session and per node,
  measured first (§7).
- **MR2 · The chooser (D52).** Jev, with its choice primitive (§5). Pete
  corrected the proposal, which said Jev only answered yes/no. The rule
  fallback covers no key and a failed call.
- **MR3 · Explicit picks and the lock (D53).** The operator's explicit pick
  always wins. The lock binds agents, the chooser and escalation. The set is
  called **preset models**, and the note on a pick outside it says the pick is
  running (§4), so it never reads as refused.
- **MR4 · Default for new projects (D54).** `choose`, quality 50, `start cheap`,
  presets = favourites, no pinned rules. The default is a setting: Settings →
  Agents → Model choice. Existing projects are stamped `default` until changed.
- **MR5 · When a routed pick is made (D55).** Once, when the node's agent first
  starts, then on escalation or a "choose again". Never silently on a later wake
  (T464 stands).
- **MR6 · `escalate` verb (D56).** An agent may ask to step up; it can't pick
  its own model.

## 10. Tickets (after the decisions)

- **T482 Policy and lock.** The schemas, the resolution (§4), `inherit` and
  `default`, the presets and effort ceiling enforced on every routed pick, the
  home default in Settings and the one-time stamp of existing projects, and the
  project and node UI. Depends on T467's catalog.
- **T483 The chooser.** The Jev choice call (scores, `topic`, `model`,
  `effort`), the confidence threshold, pinned rules, guidance, weights, quality
  priority, model profiles, the rule fallback, Try it, the chat line and Details
  scores.
- **T484 Escalation.** The ladder, the triggers in §6, `escalate`, Step up, and
  the Needs me card at the top of the ladder.
- **T485 Budget.** LIVE-CHECKLIST §16 first, then the caps (§7).

T482 is the base for the rest. T483 and T484 can be built side by side after it.
T485 waits on its measurement.

## 11. As built

### T482

T482 follows §3, §4 and §8, with these differences and additions:

- **The built-in step is what ships (D54).** §4 says a field resolves to
  "built-in (`mode: default`)". Since D54 makes Choose the shipped home
  default, the built-in step *is* D54's default: Choose, quality 50, Start
  cheap, effort ceiling Max, the favourites as the preset models (any
  installed model when there are none), no pinned rules, every weight 1.
  Below the home it reads "from Home" in the cockpit.
- **The stamp keeps presets off too.** A project that predates T482 is stamped
  `{mode: default, presets: []}`, not just `mode: default`: with favourites
  set, the home's presets would otherwise clamp its default model, and D54
  says nothing moves under running work. New projects get `model_policy: {}`.
  The migration's Unfiled project is stamped the same way.
- **A project's root is the project.** On a root node, Details → Model choice
  edits the project's `model_policy`; a root's own `human.model_policy` is
  not read.
- **Carried starts.** The daemon restarting a node's agent with the model it
  had (a role change, T361) or on another vendor after a crash (T456) is
  neither explicit nor routed: the policy is not asked and nothing is clamped
  (the crash fallback is its own setting). `agent.pick` says why.
- **Reviewers and the lessons session** resolve as before; the policy governs
  a node's agent (worker or coordinator) only. Pinned rules that name
  `reviewer` wait for T483.
- **What a start will run is named.** The composer's "Starts the agent with…"
  and New node's model chip show the routed pick a start would make
  (`next_pick` on the node page, `GET /api/model-policy/preview` for New
  node), so the cockpit never names a model the policy won't run.
- **Choose before the chooser.** Until T483, Choose is §5's "Without Jev" rule
  (start cheap: the cheapest balanced preset at medium, else the cheapest of
  any tier; strongest first: the highest tier, then the highest cost, at high
  effort). The thread line says "(no chooser yet)".
- **Let the policy choose again** (`human.choose_again`) also ends a resting
  session (T465), so the next message starts a new agent on the new pick.
- **`agile policy`** goes over the daemon's socket RPC (`policy.show`,
  `policy.set`, `policy.choose_again`), like every other CLI verb; the
  cockpit uses `GET/PUT /api/settings/model-policy`, `/model-profiles`,
  `/api/projects/:id/model-policy`, `/api/streams/:id/model-policy` and
  `POST /api/streams/:id/choose-again`.
- **Guidance, weights and pinned rules** are validated, stored, resolved and
  settable with `agile policy set`; their cockpit controls come with T483.

### T483 (the chooser)

T483 follows §5, with these differences and additions:

- **Where it lives.** The questions, the task's `state`, the reading of the
  answers and Try it's input are `packages/shared/src/model-chooser.ts`
  (with the wire schemas `JevChoiceQuestionSchema`, `JevChoiceAnswerSchema`);
  the pick (pinned rules, the threshold, the rule over the scores, the
  clamp) stays in `pickModel` in `model-policy.ts`, so the daemon, the CLI
  and Try it pick the same way. The wire mapping is `buildJevChoiceRequest`
  and `parseJevChoiceResponse` beside the Noul mapping in
  `classifier/jev-wire.ts`; `Classifier.choose` sends it with the same key,
  base URL, scrubber and timeout as a rule check. The daemon's chooser is
  `routing/chooser.ts`: one call, bounded by the classifier's timeout, and
  it never throws.
- **The state is the task; the policy is in the instructions.** The `state`
  is the title, goal, role, repo, labels, the parent's title and goal, the
  parent's approved plan entry (the paths it gives this part) and the
  siblings starting now (live siblings that are working or never started,
  with up to ten titles). The quality priority, the weights and the
  guidance go in the `model` question's instructions with the default rule,
  and the quality priority and guidance in the `effort` question's.
- **Scores.** Each is the probability-weighted mean of the numbered
  options it was asked, renormalised over those options (probabilities that
  don't sum to 1, or name an option not asked, still read); with no usable
  probability, the chosen option itself. A missing answer, a topic or
  effort outside its options, or a `model` that isn't `vendor/model` fails
  the reading: "Jev didn't answer". A `model` that is a well-formed key but
  not a candidate goes to the clamp, which moves it and says so.
- **The rule over the scores** (step 3). A weight scales a criterion's
  distance from the middle (3), kept within 1–5; a weight of 0 leaves it
  out. The bar for "well specified" and "checkable" is `3 + quality/100`
  (3 toward speed, 4 toward quality). Balanced when clarity and
  verifiability both reach the bar and neither horizon nor stakes is 4 or
  more; the fastest when that holds and volume is 4 or more; else the
  strongest. The tier's preset is the cheapest (the strongest: the costliest),
  else the nearest tier. Effort is medium, one level up for long-horizon or
  high-stakes work; the clamp caps it.
- **Strongest first** runs the strongest preset (§3), so Jev isn't asked
  the `model` question; its `effort` answer applies when its own confidence
  is at least 0.5, and the line gives the scores in words.
- **Pinned rules** match every field their `when` names (role, label
  ignoring case, topic). A role or label rule that matches before any topic
  rule decides with no Jev call. A topic rule needs Jev's `topic`: under
  Choose it comes with the full call; under Inherit or Default only the
  `topic` question is asked. A pinned pick with no effort runs at medium.
  The roles: `coordinator` (a coordinating node or a project root),
  `conversation`, `worker`, and `reviewer`, which governs reviewer starts
  only: a review started with no pick runs a matching `reviewer` rule's
  pick (clamped, with a line), and otherwise resolves as before.
- **What is recorded.** `agent.pick.how` gains `pinned`, `jev` and
  `scores` (`rule` is the rule without scores, or Strongest first); a clamp
  keeps the route in `base`. The record carries `scores`, `topic` and
  `confidence` (Jev's, in its model choice) whenever Jev read the task.
- **The chat line** is `routedPickLine`: "Model: Claude Sonnet 5.5 · medium —
  well specified and covered by tests; short, low stakes" (Jev decided);
  "… — Jev wasn't sure; chose by the scores: …"; "… — start cheap: the
  cheapest balanced preset model (no classifier key)" or "(Jev didn't
  answer)"; "… — pinned rule: coordinator".
- **Previews don't call Jev.** The composer's "Starts the agent with…" and
  Details name the pick without Jev; when a start will ask Jev (Choose, a key
  loaded), the node page's `next_pick` carries `chooses: true` and the
  cockpit reads "the model Jev picks (Claude Sonnet 5.5 · medium if it
  can't)". New node's chip still names the pick without Jev.
- **Try it** (`POST /api/model-policy/try`, same-origin; `policy.try`;
  `agile policy try "<task>" [--project P | --node N]`) reads the text (its
  first line the title, the rest the goal) as a worker's task under that
  layer's policy, as Choose would even when the mode there is another, and
  says so. It calls Jev when there is a key, and starts nothing.
- **Settings and Details.** Settings → Model choice gains Pinned rules (add,
  reorder, remove), Guidance (≤ 2,000 characters, saved on Save), Criterion
  weights (0–3 each) and Try it, and says up front that Choose needs the
  classifier key and what happens without it. The same fields show on a
  project's and a node's Details with their sources. A node's Details show
  the five scores, Jev's confidence and what decided.
- **Measured live (2026-09-30).** With three Claude presets, Jev decided all
  four test tasks at confidence 0.52–0.81. With five presets across Claude
  and Codex, its confidence split between near-equivalent models of the two
  vendors (Sonnet 5.5 and GPT-5.6 Sol, 0.36 and 0.47) and stayed at
  0.22–0.38, so the scores decided each time. The numbers are in PLAN.md's
  T483 notes.


### T484 (escalation)

T484 follows §6, with these differences and additions:

- **Where it lives.** The ladder, one step up, the record and the words are
  `packages/shared/src/model-escalation.ts` (`escalationLadder`, `nextRung`,
  `EscalationStateSchema`, `steppedUpLine`, `stuckLine`); the watcher is
  `routing/escalation.ts` (`EscalationService`, reached as
  `ModelPolicyService.escalation`), so the daemon, the cockpit and the CLI
  read one ladder.
- **The ladder and a step.** The ladder lists every rung: the presets (any
  installed model when there are none) by tier, then cost, then the order
  they're listed in; within one model, its efforts from low up to the
  ceiling; one rung for a vendor that takes no effort. A step is the next
  effort on the same model; past the model's top, the next model **at the
  effort the node ran on** (capped at the ceiling; medium when it came from a
  vendor with no effort), so a step to a stronger model never lowers the
  effort. With the default ceiling (max) that is Sonnet · medium → high → max
  → Opus · max; with a ceiling of high it is §6's own example (Sonnet · high
  → Opus · high). A model outside the presets (an explicit pick) steps to the
  first preset ranked above it by tier then cost.
- **Where the step waits.** `streams/<id>.yaml` `escalation` (top-level,
  daemon-only like `delivery_state`: the store refuses an agent's, a
  coordinator's, the Director's and a human's write). It holds the pending
  step (trigger, reason in words, by `human`/`daemon`/`agent`), the Needs me
  card (`stuck`), the last merge refusal and the quiet-turn count. A daemon
  restart keeps all of it.
- **The triggers, as built.**
  - *A merge refused twice:* delivery's `onRefused` gives each refusal a key
    (a ship check's rule, else its reason; a conflict per target). The same
    key again after at least one agent turn ended in between is the trigger;
    a different key starts again; twice with no turn between is not. A ship
    check that routes to a gate isn't a refusal until the gate says no.
  - *A failed turn (T460):* counted once T456's retry and fallback are spent
    (under Start cheap too: a retry that worked was the remedy).
  - *The context:* past 90% (not at it) at a turn's end, with no `goal_met` in
    that session; once per session.
  - *Quiet turns:* `QUIET_TURNS_MAX` = 3, a constant, not a policy field (the
    policy's fields are what the operator trades). Counted only for a worker
    with a worktree, where a commit shows as a new HEAD (baseline: the HEAD
    at its first start); a `progress` call, a new commit or a met goal resets
    it. Coordinators and conversations never count quiet turns. A turn that
    ends on a question or a gate, or hands straight into a digest, isn't
    counted.
  - *Asked (D56):* `escalate {why}` (≤ 400 characters, `.strict()`: a model,
    vendor or effort is refused) from a node's own agent (worker or
    coordinator); a reviewer, the lessons pass and the Director are refused.
    It writes "asks for a stronger model: …" on the thread and answers the
    agent in words. The MCP allowlist needed nothing: the daemon's own verbs
    pass by name (and T476's title forms) already.
  - *The operator:* Details → **Step up**, `POST /api/streams/:id/step-up`
    (same-origin, recorded `by: human`, a thread line naming the rung), and
    `agile policy step-up --node N` (`policy.step_up`). Refused (409, a param
    error) with why: under Strongest first, before the agent ever ran, at the
    top, on a closed node.
- **The Default model choice never escalates on its own** (D54: nothing
  moves under running work in a project that predates routing); the
  operator's Step up works there.
- **At the start.** A pending step replaces the kept pick at the next routed
  start and is spent by it; `agent.pick.how` is `escalation` ("stepped up:
  <reason>"), and the "Stepped up to …" line replaces the "Model:" line. An
  explicit pick wins and spends it (D53); a choose-again spends it too (the
  policy picks afresh); a carried start (T456's retry, a role change) leaves
  it for the next routed one. The composer's "Starts the agent with…" names
  the step's rung.
- **A model change ends a resting session** twice over: when a step is
  recorded while the session rests, and at the end of any turn with a step
  waiting (an `escalate` mid-turn): the session ends instead of resting.
  Nothing changes mid-turn.
- **The top of the ladder** (and every trigger under Strongest first): the
  node's `escalation.stuck`, a thread line "<node> is stuck on the strongest
  preset model: <reason>", a `model_stuck` Needs me item (filed under
  Blocked; Open node, Dismiss) and a record-only `model_escalated` event
  (`step: stuck`). Once until it is dismissed, a step clears it, or an
  explicit pick runs (the operator chose).
- **The event.** `model_escalated` (`step: up|stuck`, the trigger, the models
  in words) is record-only like `agent_restarted`: routed to the node itself,
  shown in Events and Activity, waking nobody.

### T489 (the vendor self-check, D58)

§12's self-check, as built:

- **One probe session per vendor** (`runner/vendor-check.ts`,
  `runVendorCheck`), opened the way T467's Refresh opens one: no node, no
  repo, the probe's own session dir as its cwd, `withoutDaemonSecrets()`
  (T486), the installed CLI (T480), no MCP servers. Every tool call the vendor
  asks for is refused and client file reads and writes are refused; the
  prompt needs none. Authentication runs first where the vendor asks for it
  (Cursor, Grok).
- **The model**: a listed model other than the current one, preferring one
  that isn't the vendor's default or Auto, set through T467's own code path
  (`setModelThroughOption`, which the runner's `applyPickedModel` now calls
  too) and read back from the reply: `honoured`, `kept` (with what it read
  back), `refused` (the error in words), `unclear` (the reply named none) or
  `not_applicable` (no list, or nothing else listed).
- **The effort**: where the reply (or the model's reply) has a
  `thought_level` option, the cheapest D12 level it lists other than the
  current, through T488's path (`setEffortThroughOption`), read back the same
  way. Measured for every vendor that reports the option (Claude too), not
  only the ones the runner sets it for.
- **The prompt**: exactly one, "Reply with the single word OK.", bounded
  (90 s). The session's `usage.jsonl` is written as T485a's is and read back:
  the `usage_update` field names, the reply's keys and `usage` fields, any
  `cost`, whether the turn's token counts and the context fill arrived.
  Fields in `usage_update`, the reply's `usage`/`_meta` and the session
  reply's `_meta` whose names read as a rate limit or plan usage are kept
  with their values (at most 20, each value cut to 200 characters); a name or
  value that looks like a credential never is. A `token_count` or
  `model_usage` subtree never is either (T494): Claude Code and Codex send
  `_meta.quota.token_count` and `…model_usage`, which are the session's own
  token counts, not what the plan has left. On Pete's first run (2026-10-01)
  that left no rate-limit field from any vendor.
- **The resume**: where the provider is set up for `session/load` (Claude,
  Codex, Grok, Pi), the vendor is stopped and started again with a load of
  the same ACP session id; no second prompt. Cursor and Gemini read "not
  supported here".
- **Not logged in**: an `AuthRequiredError`, or a failure whose words read as
  a login refusal (T460's rule), stops the check with T460's words and how to
  log in ("… then check it again").
- **The result** is `self-check.json` beside the probe's
  `session-state.json` (`VendorCheckResultSchema`, `packages/shared`):
  vendor, CLI version (T481's last read), the pinned bridge, each outcome,
  started/finished, why it ran (`manual`, `update`, `new_version`), who ran
  it, errors in words. No new home dir. A check's session replies also feed
  the model catalog, so a check refreshes the vendor's list too.
- **The service** (`VendorCheckService`) runs checks one at a time, keeps the
  latest result per vendor (read back from the session dirs at start), and is
  exposed as `GET /api/settings/vendor-checks`, `POST
  /api/settings/vendor-checks` (`{mode}`), `POST
  /api/settings/vendor-checks/run` (`{vendor?}`, returns at once with the
  running state), and `vendors.status`/`vendors.check` for `agile vendors`
  and `agile vendors check [vendor]` (which waits for the results).
- **The automatic trigger** is the home switch `vendor_checks: auto |
  manual` (absent = auto, Settings → Agents → Vendors). T481's harness
  service hands over each vendor CLI version it read (`check`) or installed
  (`update`); a vendor whose latest check is on another version is checked,
  at most once per version per daemon run. Under `bun test` the daemon's
  service refuses to spawn anything unless a test injects the fake agent,
  and the trigger isn't wired.
- **Routing**: `vendorCapabilities` is the pure view; `vendorsLeftOut` names
  the vendors whose last check `kept` its own model. (T494: a `refused` pick
  no longer leaves the vendor out. The refusal is loud and about the one
  model the check tried, which the plan may not include; Pete's first run had
  Claude Code refuse its test model with "Internal error" while it ran
  `claude-opus-5-5` fine, and leaving Claude out of Choose for that was
  wrong. The error now names the model.)
  Under Choose, `ModelPolicyService` leaves them out of the candidates for a
  start, the cockpit's preview and Try it, and the pick's why ends "left out
  Cursor: its last check kept its own model". Nothing changes with no check
  on file, under Default or Inherit, for an explicit or kept pick, or when
  leaving them out would leave no preset model.
- **The daemon stopping** stops a running check's vendor; the check ends
  with that in its errors, and nothing queued starts one. "The model took"
  is the vendor's own read-back, which is the best ACP offers (§12).

### T490 (tier first, the vendor order)

T490 builds §12's tier first (D57) and vendor order (D59), with these
differences and additions:

- **Where it lives.** The tier question, its reading and Try it's result are
  `model-chooser.ts` (`tier` replaces T483's `model` question;
  `CHOOSER_QUESTION_IDS`, `TIER_OPTION_WORDS`, `tierOptionText`); the pick is
  still `pickModel` in `model-policy.ts`, through `tierPick` (the tier, then
  the model) and `modelForTier` (the model inside a tier). `scoresTier` is the
  rule over the scores as a tier; `scoresRulePick` and `ruleFallbackPick`
  yield the tier first. `candidateForTier` is gone (`modelForTier` replaces
  it).
- **The question.** Asked under Start cheap when the candidates have two or
  more tiers; its options are only those tiers, fast to strongest, each in
  words with the preset models in it and their relative cost ("Balanced: …
  Here: Claude Sonnet 5.5 (cost 1), GPT-5.6 Sol (cost 1)."). The
  instructions carry the default rule, the quality priority, the weights and
  the guidance, as the `model` question did. A tier outside the options is a
  bad answer ("Jev didn't answer"). The `effort` question is unchanged.
- **The tier.** Jev's when its confidence is at least 0.5 (its effort
  applies then, as its model's did); below, the rule over the scores. When
  the presets have one tier, it isn't asked: that tier, recorded as `only`
  (`how: scores`; Jev's effort applies at its own confidence of 0.5 or more).
  With no reading (no key, no answer), §5's rule as a tier: balanced, else
  the tier of the cheapest preset. Strongest first: the highest tier present.
- **The model inside the tier** (`modelForTier`): the vendor order (the
  vendors it names first, in its order; the others after, as equals), then
  the lowest cost, then the order the presets are listed in. Under
  Strongest first the highest cost wins after the vendor order ("the
  strongest preset model", §3), not the lowest. A tier with no preset model
  (an answer the scores give, e.g. fast with no fast preset) falls back to
  the nearest tier as before, and the line says "no fast preset model, so
  balanced".
- **The vendor order.** Two policy fields, `.strict()`, resolved field by
  field like the others and human-only on a node (`human.model_policy`):
  `vendor_order` (each vendor once; empty: no preference) and
  `vendor_order_by_role` (`worker`, `coordinator`, `conversation`,
  `reviewer`, each its own order over `vendor_order`). The by-role object is
  one field: a layer that sets it sets every role it names, and a role it
  leaves out uses `vendor_order` (the Settings words: "Same as above"). The
  role is the start's: a node's agent (worker, coordinator or conversation)
  or a reviewer.
- **Pinned rules may name only a vendor** (`pick: {vendor}`, an optional
  effort). Its tier comes from Jev or the rule (`tierPick` over that
  vendor's candidates), so it asks for the whole reading under any mode. A
  rule whose vendor has no candidate doesn't match; the next rule or the
  mode decides and the pick's note says "the pinned rule for reviewer names
  Codex, which has no preset model here, so it didn't apply".
- **Reviewers.** `pickForReviewer` is `pickForStart` with the `reviewer`
  role, so a review started with no model follows the reviewer order,
  pinned rules and the tier. Under Default (and Inherit with no parent
  model) it resolves as before, with no line. An explicit pick wins (D53)
  and never asks. A reviewer's pick writes its "Model:" line on the thread;
  `agent.pick` stays the node's agent's.
- **Escalation.** The ladder sorts by tier, then cost, then the node's
  role's vendor order, then the listed order: cost still comes first, the
  vendor order breaks a tie of both (`LadderInput.vendorOrder`; the node's
  role is its last agent session's).
- **What is recorded.** `agent.pick` (and Try it) gains `tier` (the one
  decided; the model's own may be the nearest), `tier_by` (`jev`, `scores`,
  `rule`, `pinned`, `only`) and `in_tier` (`by`: `only`, `vendor_order`,
  `cost`, `listed`, with words). `confidence` is now Jev's in its tier.
- **The line.** "Model: Claude Sonnet 5.5 · medium — balanced (Jev 0.82):
  well specified and covered by tests; short, low stakes; Claude before
  Codex"; "… — Jev wasn't sure (0.42), so strongest by the scores: …";
  "… — start cheap: balanced (no classifier key); Codex before Claude";
  "… — pinned rule: reviewer → Codex; balanced (Jev 0.82): …". Why this
  model is said only when there was a choice between vendors or costs
  ("Claude before Codex", "the cheapest balanced preset model", "no vendor
  preferred, so the one listed first"); one vendor's equal models say
  nothing.
- **Settings and Details.** Model choice gains **When models tie, prefer**
  (the installed vendors with up and down; moving one with no order set
  saves the list as shown; **No preference** clears it) and **By role**
  (Code, Coordinating, Conversations, Reviews: "Same as above (…)" or "Its
  own order"), each with its source on a project's and a node's Details.
  Details and Try it show "Balanced tier, by Jev (0.82). In the tier: Claude
  before Codex." A pinned rule may pick "Any Codex model (the tier decides)".
- **CLI.** `agile policy set vendor_order claude,codex` (`none`: no
  preference; `inherit` clears) and `agile policy set
  vendor_order_by_role.reviewer codex,claude` (`same` takes the role out;
  merged into what the layer sets, over the same `policy.set` RPC); `agile
  policy try` prints the tier, how it was decided, the confidence and "in the
  tier".
- **Measured live (2026-09-30).** The five mixed presets of T483's run, with
  the vendor order Claude, then Codex, and again Codex, then Claude: the
  rename came back balanced at 0.97 and 0.98, the vague "Make the app better"
  strongest at 0.94 twice, and the money migration leaned balanced (0.62
  against strongest's 0.38) at 0.42 and 0.36, so the scores gave strongest
  (stakes 5, horizon 4.4). The vendor order chose Sonnet 5.5 or GPT-5.6 Sol,
  Opus 5.5 or GPT-6 Astra each time. The numbers are in PLAN.md's T490 notes.

## 12. After T484: tier first, the vendor order, the self-check, rationing (Pete, 2026-09-30)

**Tier first (D57).** With presets from two vendors, T483's `model` question
split Jev's confidence between near-equivalent models (Sonnet 5.5 and GPT-5.6
Sol), so it never reached 0.5 and the scores always decided. Jev now answers
**which tier** (fast, balanced, strongest; only the tiers the presets have).
Those don't overlap, so the confidence means something. Inside the tier, the
model is the preset chosen by the vendor order, then the lowest cost.

**The vendor order (D59).** The operator lists vendors in the order to prefer
on a tie ("Claude, then Codex"), and may give a role its own order: reviews
prefer Codex, code prefers Claude. Roles are worker (code), coordinator,
conversation and reviewer. A pinned rule may name a vendor alone ("reviewer →
Codex"); the tier then comes from Jev or the rule. A reviewer started with no
pick is routed like any other start.

**The vendor self-check (D58).** The facts routing depends on (does a vendor
take the model it's given, does effort take, does it report usage, does resume
work) can only be measured with the operator's logins. The daemon measures them
itself: per vendor, a session with no node, a model and an effort set and read
back, one tiny prompt, a resume where supported, and the usage and rate-limit
fields it sent. The result is kept per vendor and CLI version, in the probe
session's own dir, and shown in Settings → Agents. It runs on **Check vendors**,
`agile vendors check`, and after a CLI update. Choose leaves out a vendor that
ignores model picks. A check costs one tiny turn per vendor. "The model took" is
the vendor's own report, which is the best ACP offers. Built by T489 (§11).

**Rationing across subscriptions (T491, after T489).** If one subscription has
less left this week, routing should lean away from it. Two sources, measured
before anything is built:

1. What a vendor reports about its own plan limits. Some CLIs show plan usage
   (Codex's `/status` shows its 5-hour and weekly limits); whether any of it
   reaches ACP is what T489 records.
2. The daemon's own count: weighted tokens per vendor over a rolling seven
   days, from `usage.jsonl` (T485a), against an allowance the operator sets per
   vendor in Settings.

A vendor past 80% of its allowance moves to the end of the vendor order for
routed picks; one past 100% is left out of routed picks, and the chat says so.
Explicit picks are never blocked, only warned. When every vendor is out, the
node goes to Needs me.

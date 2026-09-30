# Model routing: who picks a node's model, and how

Status: **decided** (proposed 2026-09-29; Pete settled MR1–MR6 on 2026-09-30,
recorded as D51–D56 in PLAN.md). T482–T485 are built from this document;
§11 says how T482, T483 and T484 were built.
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

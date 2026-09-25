# Projects — Design Doc

Status: agreed with Pete 2026-09-24 (sections 1–13 carry the agreed design). Sections 14–19 add what an implementer needs: data model, event catalog, state layout, the mapping from today's code, the GitHub approach, and the **proposed decisions** that fill gaps the agreed design left open. This is the current design for Phases 7 onward (`PLAN.md`). Where it differs from `design/cockpit-design.md`, this document wins. The cockpit design still holds for everything this one does not touch: the inbox (§3), the hook path (§8.1), the classifier (§6) and the credential scrub (§6.5).

## 1. Summary

Agile Agents becomes a way to run several projects at once across shared repos, with coding agents doing the work and the app keeping them from colliding. Today it is a set of independent streams that know nothing about each other. This design adds:

- projects at the top of the tree;
- coordination at every level of the tree;
- repos as shared ground, each with its own norms;
- one event system that ties it together.

The examples use two tiny repos throughout:

- **api**: a server with one file, `prices.ts`, that returns a price for an item.
- **web**: a site with one page, `shop.html`, that shows prices.

And two projects: **Shop** (sale prices) and **Blog** (posts).

### 1.1 Principles

- **You decide; agents propose.** Merging, accepting norms, changing a plan and answering questions are yours. Agents draft, check, coordinate and report.
- **The app does the mechanical work, not the agents.** That means syncing after a merge, spotting file overlaps, and holding a merge until its dependency lands.
- **One kind of node.** Everything in the tree is a stream. What a node does depends on whether it has children and a repo.
- **Nothing goes into your repos except the code the work produces.** All of the app's knowledge and state lives in `~/.agile/`.
- **Nothing is lost silently.** Every message, event and decision is stored before it is delivered.

### 1.2 Mental model: a team workspace

Think of it as a Slack workspace for your agents, where you are in every channel.

| Slack | Here |
|---|---|
| A channel | A node's thread |
| A direct message | "Ask sibling" between two nodes |
| An @mention | An event routed to a node |
| A shared team channel | A repo: everyone working on it hears its news |
| Pinned messages | Plans, contracts and decisions, kept as records |

It works better than chat in two ways. Messages are typed and routed with delivery guarantees, so each agent sees only what concerns it. And anything that matters is kept as a structured record, not only in scrollback.

## 2. The tree

All work lives in one tree per project. Every node is a stream. It has a goal, a thread, docs, a status, and optionally children and "waits on" links. What a node does follows from two facts about it:

| Node | Has children? | Has a repo? | Its agent | Example |
|---|---|---|---|---|
| Project (root) | Yes | Lists the repos it uses | Coordinates the whole project | "Shop" |
| Coordinating node | Yes; its children change the code | No worktree; its repos are its children's | Plans, splits work, owns contracts, tracks children | "Show sale prices" |
| Work node | None of its own, but it can spawn helper children (§2.1). It owns a branch and delivers it | Exactly one repo, with a branch and worktree | Writes and tests code, opens the PR or merges | "api: add salePrice" |
| Conversation node | Only tangents: children that are conversations too (§2.4) | None (may read repos) | Answers, researches, writes notes | "Why are prices slow?" |

**One rule:** a node that needs changes in two repos can't make them itself. It becomes a coordinating node with one work node per repo.

### 2.1 Helpers for a work node

A work node's agent can get help in two ways:

- **Inside its own harness** (Claude Code subagents): quick, disposable help that returns within the turn, such as searching the code, reading docs, or checking three files in parallel. It doesn't appear in the tree, and the results come straight back.
- **As a child node**: help you would want to see, stop or answer questions for, or help that outlives the turn. Examples are an hour of research, or a change in another repo. Helper children can change code:
  - A helper on the **same repo** branches off the work node's branch and merges back into it when done. The work node still owns one branch and delivers it as one PR or merge.
  - A helper on **another repo** is an ordinary work node on that repo. The parent becomes a coordinating node as usual (§7).

Rule of thumb: if you would want to see it in the tree, make it a child. Otherwise it stays in the harness.

### 2.2 Labels

Epic, ticket and task are labels. You can put them on any node, and the tree can be any depth. Only the project is special, because it holds settings: repos, default model, delivery mode and project-wide decisions.

### 2.3 Example tree

```
Shop                                  project · repos: api, web
└─ Show sale prices                   coordinating · epic
   ├─ api: add salePrice              work · api · PR #12
   └─ web: show salePrice             work · web · waits on "api: add salePrice"
   Why are prices slow?               conversation
Blog                                  project · repos: api
└─ api: add /posts                    work · api
```

### 2.4 Tangents

A conversation can have children of its own, called **tangents** (D33). A tangent is a conversation that follows one line of its parent's thread without derailing it.

- **Starting one.** In the cockpit, **Branch off** on a line of a conversation's thread asks for the tangent's question and makes a child conversation. Its thread opens with that line quoted, and its goal is the question. `node new --parent <conversation>` makes one from the CLI, without the seed line.
- **The parent keeps its role.** A conversation whose children are all conversations stays a conversation: its agent is a worker, not a coordinator. It becomes coordinating only once a child has a repo, or a child is itself coordinating.
- **Finishing.** When the tangent's agent finishes (`agent.status` becomes `done`), a `tangent_summary` event goes to the parent (§15), and the parent's thread gets a line quoting it. The summary is the tangent agent's last line, capped at 600 characters. It is the tangent's own words, so it reaches the parent's agent as quoted data, never as instructions. It does not wake a parent with no live agent (P11); the parent reads it on its next turn.

## 3. Views

Only the tree is stored. Every view is a filter or grouping over it, so the views never disagree and never go stale.

**By project.** This is the real tree, where you create and restructure work.

```
Shop
└─ Show sale prices
   ├─ api: add salePrice      ● working
   └─ web: show salePrice     ○ waits on api part
Blog
└─ api: add /posts            ● in review
```

**By repo.** What is happening on each repo, across projects. Ancestors are shown in grey for context.

```
api   (pull requests · auto-merge off)
  Shop › Show sale prices › api: add salePrice     prices.ts  ⚠ overlap
  Blog › api: add /posts                           prices.ts  ⚠ overlap
web   (direct merge)
  Shop › Show sale prices › web: show salePrice    shop.html
```

The repo view also shows that repo's norms and any overlap warnings.

Other lenses on the same data:

- **Needs me**: every node waiting on your answer, approval or merge.
- **Running**: everything an agent is working on right now.
- **Dependencies**: what waits on what, across projects.

## 4. Repos

A repo is shared ground: several projects may work on it at once. The app gives each registered repo four things.

### 4.1 Delivery mode

Set per repo. A project or a node can override it.

| Mode | For | What "done" means for a work node |
|---|---|---|
| Direct merge | Personal repos | You click Merge and the branch merges into main. |
| Pull request | Org repos | The agent pushes and opens a PR. The PR's state becomes the node's status: review requested, changes requested, CI failing, approved, merged. Review comments and CI failures come back to the agent as events. The merge happens on GitHub, done by you, a teammate or auto-merge. |

Example: api is an org repo, so "api: add salePrice" ends as PR #12. A reviewer comments "round to cents". The agent fixes it and pushes. Someone merges #12 on GitHub and the node shows merged.

**Looking after a PR.** Once a PR is open, its node's agent looks after it until it merges or closes:

- **CI failures:** it reads the failing check, fixes the cause and pushes. A flaky test is not a reason to skip the check. If the agent can't fix it, it reports it to you.
- **Review comments:** it fixes small asks and pushes. Design disagreements go to your inbox.
- **Falling behind or conflicts:** it brings in the new main and resolves the conflicts.
- **Auto-merge:** a per-repo setting you turn on. When it is on, the agent enables GitHub auto-merge once its own checks pass and its "waits on" links are satisfied. GitHub then merges after the required reviews and CI. You have made the merge decision in advance, through the setting and the repo's review rules.

Example: PR #12's CI fails on a lint error. The agent fixes it and pushes, and CI goes green. A teammate approves. With auto-merge on, GitHub merges it and the node shows merged without you clicking anything.

### 4.2 Sync after every merge

When anything merges into a repo's main, every other live work node on that repo is updated to the new main, or flagged if the update conflicts. Nobody builds on a stale main for long.

Example: Blog's "api: add /posts" merges. "api: add salePrice" is updated onto the new main straight away.

### 4.3 Overlap tracking

The app knows which files each live work node has changed so far, across all projects. It warns early when two nodes touch the same file, instead of at merge time.

Example: both api nodes edit `prices.ts`. Both nodes, their parents and the api repo view show the overlap, and the coordinator suggests which should wait for the other.

### 4.4 Visibility

By default any agent may read any registered repo, so a conversation in Shop can answer questions about Blog's code. A repo can be set **private**, which limits reading to the projects you list. An agent can only ever change code in its own node's repo.

## 5. Knowledge

What agents need to know comes in three kinds. "Rule" is no longer a kind of knowledge. It now means how strongly an item is enforced (§6).

| Kind | What it is | Usual scope | Example |
|---|---|---|---|
| Standard | How we work: code style, testing, procedure | Everywhere, or one repo | api: "Every change to prices.ts has a test." |
| Architecture | What exists in the codebase and where | One repo | api: "All prices are integer cents, computed only in prices.ts." |
| Decision | A choice made for some piece of work, with a reason | A project or a subtree, sometimes limited to certain paths | Shop: "Sale prices show in red." |

**Scopes stack.** An agent working on "web: show salePrice" gets the global standards, web's standards and architecture, Shop's decisions, and its parent's contracts. It gets nothing from Blog.

**Where it lives.** One small file per item in `~/.agile/`, never in your repos. Each file holds the text, kind, scope, optional paths, enforcement setting and where the item came from.

**How it is proposed.** You add one, an agent proposes one while working, or the lessons pass proposes one after a merge. Nothing applies until you accept it.

**How an agent gets it:**

- **At start:** its instructions include everything in its scope, and nothing else.
- **When it changes:** a newly accepted item in its scope arrives as an event ("new decision in scope: sale prices show in red").
- **On demand:** a lookup tool. "What applies to shop.html?" returns the items for that path. Agents are told to use it before touching unfamiliar areas.

Later, optionally, the same lookup could be exposed as a small MCP server, so plain Claude Code sessions outside the app can ask for a repo's standards too. Nothing would be written into the repo. This is not in Phases 7–13.

## 6. Enforcement

Every knowledge item has an enforcement setting: **tell** (instructions only), **action** check, **ship** check or **review** check. Knowledge tells agents what to do; these checkpoints catch it when they don't.

| Checkpoint | When | How | Example | On a violation |
|---|---|---|---|---|
| Action | Before each command or file edit runs | Hooks: exact patterns, or the classifier judging the action | "Never edit prices.ts in web" blocks an edit outside the api repo | Blocked, with the item named. Sent to your inbox when the classifier is unsure |
| Ship | Before the PR is opened or the merge happens | The classifier over the whole diff (`ship` items), plus a reviewer agent with a checklist of every `review` item in scope | "Every change to prices.ts has a test": the diff changes prices.ts with no test | The PR or merge is held and the findings go back to the worker to fix. They come to you only if the checks are unsure or the worker disputes them |
| After | Once the work is out | Your teammates' PR reviews; item statistics | A reviewer spots a price in dollars, not cents | The comment goes back to the agent, lessons propose a sharper item, and items that never fire are flagged for removal |

**Typical placement:**

- standards: mostly ship checks;
- architecture: mostly review checks;
- decisions about an action ("never retry a 401"): action checks;
- decisions about the result ("sale prices in red"): ship checks.

**Limits:**

- "Tell" items are only instructions.
- The classifier and the reviewer make judgement calls, so unsure cases come to you.
- Hard action checks need a vendor with hooks. Claude Code has them; for other vendors, ship checks are the backstop.

## 7. Adding a repo in place

You never restructure the tree by hand to change where work happens. The stream page has a **+ Repo** button, and you keep talking in the same thread. The app reshapes the tree behind the scenes:

| The node is | You click | Behind the scenes | What you see |
|---|---|---|---|
| A conversation | + api | It becomes a work node on api: a branch and worktree are created | The same chat carries on; the agent can now change code |
| A conversation with tangents (§2.4) | + api | It becomes a coordinating node: a new child "api part" gets the branch and worktree, beside the tangents | The same chat carries on at this node; the part appears as a row under it |
| Working in api | + web | It becomes a coordinating node. Its api work moves into a child "api part", keeping the branch and commits, and a new child "web part" is created | The same chat carries on at this node; the two parts appear as rows under it |
| Working in api, nothing committed | Switch to web | As above, and the empty api part is closed | The same chat, now on web |

New children start with the thread so far, the docs and the decisions, so nothing has to be copied by hand. An agent can also suggest it ("this needs a change in web too; add it?"), and you add it with one click.

Example: you ask a conversation node "can we show sale prices?" and it explains how. You click + api and + web. The node is now "Show sale prices" with two parts, and you are still in the same conversation.

## 8. Events

Agents don't run all the time. Coordinating agents in particular sleep until an event wakes them. That only works if events are reliable, so events are a core system, not ad hoc prompts.

| Event | Example |
|---|---|
| You wrote on a thread | "use 20% off, not 10%" |
| A child is done, blocked or asking | "api: add salePrice" finished |
| A PR was reviewed, CI failed, a PR merged | PR #12: changes requested |
| A repo's main changed | api main moved after Blog's merge |
| An overlap was detected | two nodes editing prices.ts |
| A contract changed | the salePrice field was renamed |
| A knowledge item was accepted in scope | new decision: sale prices in red |
| A dependency was satisfied | the node you wait on merged |

**Routing.** An event goes to:

- the node it is about;
- up to that node's ancestors;
- across "waits on" links, in any project;
- sideways to every live node on the same repo, when it is a repo event.

Example: Blog's api node merges. Its parent hears "child merged". Shop's "api: add salePrice" hears "api main changed" (same repo, different project). Nothing on web hears anything.

**Guarantees:**

- Every event is stored before it is delivered.
- It is delivered once.
- A burst of events is combined into one digest when an agent wakes ("3 things changed while you were idle").
- An event is never dropped because an agent was busy or asleep.
- Each node has an activity feed showing what woke it and why.

The full catalog, with producers and recipients, is §15.

## 9. Siblings

Siblings don't talk to each other directly to change the plan. The parent is the hub, and siblings share what they are doing where the others can read it.

1. **The plan and contracts (before work).** When a parent splits work, it writes down who owns what and the seams between them. Every child gets both. Example: "Show sale prices" writes that the api node owns prices.ts and the web node owns shop.html, with the contract `GET /price/:id` returns `{ cents, saleCents? }`. A child can't change a contract on its own. It proposes the change to the parent. The parent updates the contract and tells every sibling that relies on it, or asks you if the change is a real design choice.
2. **Status cards (pull).** Each child keeps a short card that is updated automatically. The card says what the child is doing, which files and exported names it has changed, which contracts it relies on, and whether it is done or blocked. Siblings can read each other's cards whenever they need to.
3. **Alerts (push).** The app compares each child's live changes with what its siblings touch or use, and sends alerts:
   - the same file edited by two siblings: to both, plus the parent;
   - something a sibling uses (a function, a type) changed: to that sibling, plus the parent;
   - a contract touched: to the parent and every sibling on that contract.

   This is mechanical. It is worked out from diffs and a simple "who imports what" index, so it doesn't depend on agents remembering to mention things.
4. **When a sibling finishes.** The parent hears first and sends targeted notes to the siblings actually affected. Siblings on the same repo also get the "main changed" sync.
5. **Talking to a sibling directly.** Siblings can settle details between themselves with an "ask sibling" tool: A asks B a question, and B's agent answers. The exchange shows in both threads and is copied to the parent, which can step in. Details are agreed between siblings. Anything that changes the plan, a contract or who owns what is agreed with the parent. When siblings agree on such a change, they send it to the parent together as a proposal, and the parent approves it or asks you.

Example: the api part finds that prices also need a currency. It asks the web part: "do you want currency in the response, or should I send a formatted string?" The web part answers: "send currency, I'll format it." That changes the contract, so they propose "add currency" to the parent together. The parent approves it and updates the contract, and both parts carry on.

**Collisions go to the parent's agent first.** It can add a "waits on" link, give one sibling ownership of a file, or merge two siblings. If that changes what gets built, it asks you.

**Autonomy.** How much a coordinator does on its own is a setting, using the same three levels as the Director (Advise, Organise, Run; §12). It is set per project and can be overridden on any node.

| Level | The coordinator |
|---|---|
| Advise | Proposes reorders, links and ownership changes for you to click |
| Organise | Makes those changes itself and tells you |
| Run | Also approves routine contract changes |

At every level, changes to what gets built come to you.

## 10. Links to Jira or Linear

Any node may link to one external issue, though most won't. A link is a property of a node, not a kind of node, so the tree stays the app's own.

```
Shop                       → SHOP-10 (epic)
└─ Show sale prices        → SHOP-11
   ├─ api: add salePrice      (rolls up to SHOP-11)
   └─ web: show salePrice     (rolls up to SHOP-11)
```

**Roll-up:** a node with no link belongs to its nearest linked ancestor. Its PR mentions that issue, and its progress counts toward it.

| Direction | What | Default |
|---|---|---|
| Jira → node | When the node is linked, the issue's title, description and acceptance criteria become the node's goal. Later edits in Jira arrive as an event ("SHOP-11's description changed") | On |
| Jira epic → children | "Import children" creates one linked child node per issue in the epic | Your click |
| Node → Jira | Status changes (in progress, in review, done) and the PR link are posted on the issue. Status names are mapped per project | Off until you turn it on per project |
| Node → new Jira issue | Creating an issue for a node with no link | Your click, never automatic |

The app never closes an issue or edits its text. It only moves the status and adds links or comments, and only when you have turned that on.

## 11. Worked example

Two projects, two repos, one afternoon. api uses pull requests; web uses direct merge.

Knowledge already accepted:

- Standard (api): every change to prices.ts has a test. Ship check.
- Architecture (api): prices are integer cents, computed only in prices.ts. Review check.
- Decision (Shop): sale prices show in red. Ship check.

The afternoon:

1. **Question.** In project Shop you open a conversation: "can we show sale prices?" The agent reads api and answers.
2. **It becomes work.** You click + api and + web. The node becomes "Show sale prices" with two parts. Its agent writes the plan and the contract `GET /price/:id → { cents, saleCents? }`. You approve.
3. **Work starts.** Both parts get the knowledge in their scope. The web part never sees the api standard, and the api part never sees "red".
4. **Contract change.** The api part wants `saleEndsAt` too. It proposes it, and the parent updates the contract and tells the web part. You see one line in the activity feed.
5. **Overlap across projects.** Project Blog's "api: add /posts" also edits prices.ts. Both nodes, both parents and the api repo view show the overlap. Shop's coordinator suggests that the api part wait on Blog's node. You click Link.
6. **Dependency met.** Blog's PR merges. "api main changed" reaches the api part, which is synced, and the wait clears.
7. **Ship check.** The api part finishes, but its diff changes prices.ts with no test. The delivery is held, and the agent adds a test. The reviewer checklist passes, and the agent opens PR #12.
8. **Review.** A teammate comments "round to cents". The comment reaches the agent as an event; it fixes the code and pushes. Someone merges #12.
9. **Web ships.** The web part was waiting on the api part. It is synced, its ship check confirms the sale price is red, and you click Merge.
10. **Lessons.** A new architecture item is proposed for api: "sale data comes from prices.ts too." You accept it. From then on, any project's agent working on api is told.

## 12. The Director

One agent sits above all projects: the Director, the engineering director of your agents. Coordinating nodes reason about their own subtree. The Director reasons across everything: all projects, all repos, all norms and the dependency graph. With it, the app grows from running the work you set up to setting up the work itself.

What it does:

- **Starts work:** turns "we need sale prices" into a project or epic, drafts the tree and plan, and creates the nodes.
- **Sees across projects:** spots two projects heading for the same code, proposes "waits on" links, and notices when one project is about to break a norm set in another.
- **Keeps things moving:** notices stuck or idle nodes and suggests what to do. It summarises the state of everything when asked ("what needs me today?").
- **Suggests norms:** notices review findings that repeat across projects and proposes a standard or architecture item.

How much it does on its own is a setting per project, which you raise over time:

| Level | The Director may | Still yours |
|---|---|---|
| Advise (default) | Draft plans, trees and links; you click to create them | Everything |
| Organise | Create and restructure nodes, start agents and add "waits on" links on its own, and tell you | Merging, accepting norms, and contract and plan changes that alter what gets built |
| Run | Also approve routine contract changes and restart stuck work | Merging and accepting norms, always |

At every level, it can't merge, accept a norm, or answer a question as if it were you. Every action it takes is recorded as done by the Director, in its own activity feed.

Example: you tell the Director "Shop needs sale prices." At Advise, it replies with the tree from the worked example and a Create button. At Organise, it creates the nodes, starts the agents, links the api part to Blog's node, and posts "started Show sale prices (2 parts); waiting on Blog's /posts".

## 13. What changes from today (summary)

| Part | Today | Under this design |
|---|---|---|
| Streams, threads, inbox | Exist | Keep. Streams gain a project, roles and "waits on" links. |
| Hooks, pattern and classifier rules | Exist | Keep, as the action and ship checkpoints. |
| Rules | One kind, with three strengths | Become standards, architecture and decisions, each with an enforcement setting and stacked scopes. |
| Parent branches (children merge into the parent's branch) | Default | Removed. Work nodes deliver straight to their repo (merge or PR); "merge together" and "waits on" replace parent branches. |
| Land | One button, direct merge only | Becomes per-repo delivery: direct merge or pull request. |
| Attach | A separate step | Folded in. Starting a stream starts its agent, and repos are added in place with + Repo. |
| Worker, reviewer, lessons | Three agent roles | Keep, and add the coordinator role for nodes with children. |
| Events | Ad hoc prompts to live sessions | Replaced with the stored, routed event system. |
| Projects, repo view, overlaps, sync after merge, status cards, contracts | Missing | New. |

The per-module detail is in §17. We build it in steps, and each step is usable on its own. The phase order is in `PLAN.md` §7 (Phases 7–13); §19 explains how it differs from the order the agreed design first sketched.

---

## 14. Data model

These are sketches in TypeScript notation. Each one becomes a zod `.strict()` schema in `packages/shared`, and nowhere else. Every id follows the existing `<prefix>-<ulid>` pattern, except stream ids, which stay bare ULIDs for compatibility. Times are ISO strings. `?` marks an optional field. Bodies are capped as they are today (`THREAD_BODY_MAX_CHARS` = 800), and long text goes to a file with a pointer.

### 14.1 Project

`~/.agile/projects/<id>.yaml`

```ts
type ProjectId = `P-${Ulid}`;
type Autonomy = 'advise' | 'organise' | 'run';

interface Project {
  id: ProjectId;
  name: string;                    // "Shop"; unique, case-insensitive
  root: StreamId;                  // the root node; it carries the project's thread
  repos: string[];                 // names from repos.yaml that this project uses
  session?: { vendor?: string; model?: string; effort?: Effort };  // between the repo default and the flag (D17 order, see P5)
  delivery?: DeliveryOverride;     // overrides repo delivery for this project's nodes
  autonomy: {
    coordinator: Autonomy;         // default 'advise'
    director: Autonomy;            // default 'advise'
  };
  tracker?: TrackerSettings;       // §14.10; absent means no Jira/Linear
  archived?: boolean;
  created_at: string;
}
```

### 14.2 Node (the stream record, extended)

`~/.agile/streams/<id>.yaml`. The record keeps its existing fields: `id`, `title`, `goal`, `parent`, `repo`, `branch`, `worktree`, `created_at`, the `agent.*`/`human.*` two-writer halves, `sessions`, `archived` and `land_conflict`. `target_branch` is kept for direct delivery only (see §17). New fields:

```ts
interface NodeFields {
  project: ProjectId;              // required after the migration (§17.1)
  labels?: string[];               // 'epic' | 'ticket' | 'task' | free text; no behaviour attached
  waits_on?: WaitsOn[];            // across any project
  external_link?: ExternalLink;    // §14.10
  autonomy?: Autonomy;             // override for this node as a coordinator
  delivery?: DeliveryOverride;     // override for this work node
  merge_together?: string;         // group key, e.g. "MT-<ulid>"; see P7
  helper_of?: StreamId;            // a same-repo helper: branches off helper_of's branch and merges back into it (§2.1)
  delivery_state?: DeliveryState;  // written by the daemon only (§14.7)
  touched?: TouchedSummary;        // written by the daemon only; the overlap input (§14.6)
}

interface WaitsOn {
  node: StreamId;
  added_by: 'human' | 'coordinator' | 'director';
  added_at: string;
  satisfied_at?: string;           // set by the daemon when node is delivered (merged) or, for a non-work node, closed
}

type DeliveryOverride = { mode?: 'direct' | 'pr'; auto_merge?: boolean };
```

**The role is derived, never stored** (proposed decision P1). One pure function in `packages/shared`:

```ts
type NodeRole = 'project' | 'coordinating' | 'work' | 'conversation';

function nodeRole(node, liveChildren, all?): NodeRole {
  if (node.parent === undefined) return 'project';          // only a project root has no parent
  const others = liveChildren.filter(c => c.helper_of !== node.id);
  // D33: a conversation whose children are all conversations (tangents) stays one.
  if (node.repo === undefined && others.every(c => isTangent(c, all))) return 'conversation';
  if (others.length > 0) return 'coordinating';
  return node.repo !== undefined ? 'work' : 'conversation';
}
```

`liveChildren` means children that are not closed or archived. `isTangent` is true for a child with no repo whose own live children are all conversations; `all` (every node) lets it look down the tree. A coordinating node has no `branch` or `worktree`: the reshape in §7 moves them to its "part" child.

### 14.3 KnowledgeItem (replaces Rule)

`~/.agile/knowledge/<id>.yaml`

```ts
type KnowledgeId = `K-${Ulid}`;     // migrated rules keep their ulid: R-X becomes K-X

interface KnowledgeItem {
  id: KnowledgeId;
  name?: string;                   // short label for cards; from `agile knowledge add --name` (was T175 item 3)
  kind: 'standard' | 'architecture' | 'decision';
  text: string;                    // ≤ 800
  scope:
    | { kind: 'global' }
    | { kind: 'repo'; repo: string }
    | { kind: 'project'; project: ProjectId }
    | { kind: 'subtree'; node: StreamId };   // the node and all its descendants
  paths?: string[];                // globs relative to the repo root; empty or absent means all paths
  enforcement: 'tell' | 'action' | 'ship' | 'review';
  check?:                          // required for 'action' and 'ship'; forbidden for 'tell' and 'review'
    | { by: 'pattern'; pattern: RulePattern }          // today's pattern kinds, unchanged; action only
    | { by: 'classifier'; question?: string; criteria?: RuleCriteria; examples: RuleExample[] };  // ≥ 2 examples, as today
  critical: boolean;               // fail policy on a classifier error (cockpit §6.4), unchanged
  source: { by: 'human' | 'agent' | 'lessons' | 'director' | 'migration'; node?: StreamId; session?: string; finding?: string };
  status: 'proposed' | 'accepted' | 'retired';
  stats: RuleStats;                // fired, violated, routed, last_fired_at; unchanged
  created_at: string;
  decided_at?: string;
}
```

`review` items have no `check`: they become lines on the reviewer's checklist at ship time. A decision scoped to a subtree dies with nothing. When its node closes, it stays attached to the node and is shown on it as history.

### 14.4 Plan and Contract

`~/.agile/plans/<node-id>.yaml`, one per coordinating node, and `~/.agile/contracts/<id>.yaml`.

```ts
interface Plan {
  node: StreamId;                  // the coordinating node
  version: number;                 // bumped on every accepted change
  owners: { child: StreamId; owns: string[] }[];   // path globs per child
  contracts: ContractId[];
  status: 'draft' | 'approved';
  approved_by?: 'human' | 'coordinator' | 'director';
  updated_at: string;
}

type ContractId = `C-${Ulid}`;
interface Contract {
  id: ContractId;
  node: StreamId;                  // the coordinating node that owns it
  title: string;                   // "GET /price/:id"
  body: string;                    // ≤ 800; the seam as text (shape, rules). Longer bodies go to a docs file with a pointer
  parties: StreamId[];             // children that rely on it
  version: number;
  history: { version: number; body: string; changed_by: string; reason: string; at: string }[];  // last 20
  proposals?: ContractProposal[];  // open proposals only; decided ones move to history or are dropped with a thread line
}

interface ContractProposal {
  id: `CP-${Ulid}`;
  from: StreamId[];                // one child, or siblings proposing together
  body: string;
  reason: string;
  routine: boolean;                // the proposer's claim; the coordinator re-judges it (P12)
  status: 'open' | 'approved' | 'rejected' | 'asked_human';
  at: string;
}
```

### 14.5 StatusCard

`~/.agile/cards/<node-id>.yaml`. The daemon writes the mechanical fields and the agent writes `doing`.

```ts
interface StatusCard {
  node: StreamId;
  doing: string;                   // one line, from the `progress` verb (≤ 200)
  state: 'working' | 'blocked' | 'done' | 'idle';
  files: string[];                 // changed vs merge-base, including uncommitted; ≤ 200, then "+N more"
  exports_changed: string[];       // "prices.ts:salePrice"; from the import index (§14.6)
  relies_on: ContractId[];
  updated_at: string;
}
```

### 14.6 Touched summary and import index

`touched` on the node: `{ files: string[]; base: string /* merge-base sha */; at: string }`. The daemon recomputes it after each post-tool-use hook that edits files, after each commit, and at least every 60 s for live work nodes.

The import index is `~/.agile/index/<repo>.json`. It is derived and can always be rebuilt, so it is a cache rather than a record. It maps each file to the names it exports and the files it imports from. Phase 11 builds it with a TS/JS regex scan only (P14).

### 14.7 Delivery state and PR state

```ts
interface DeliveryState {
  mode: 'direct' | 'pr';           // resolved at the first delivery attempt
  status:
    | 'not_started' | 'ship_checking' | 'held'     // held: ship findings, waits_on or merge_together
    | 'ready'                                       // direct: waiting on your Merge click
    | 'pr_open' | 'merged' | 'closed_unmerged' | 'conflict';
  held_by?: { reason: 'ship_check' | 'waits_on' | 'merge_together' | 'conflict'; detail: string }[];
  pr?: PullRequestState;
  merged_sha?: string;
  at: string;
}

interface PullRequestState {
  number: number;
  url: string;
  head: string;                    // branch
  base: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  review: 'none' | 'review_requested' | 'changes_requested' | 'approved';
  checks: 'none' | 'pending' | 'failing' | 'passing';
  mergeable: 'unknown' | 'clean' | 'behind' | 'conflicting';
  auto_merge: 'off' | 'enabled' | 'unavailable';
  last_seen: { review_id?: number; comment_id?: number; check_suite_id?: number };  // cursors for "new since last poll"
  polled_at: string;
  etag?: string;
}
```

### 14.8 Repo settings (repos.yaml entry, extended)

```ts
interface RepoEntry {                 // existing fields kept: path, protected_branches, vendor, model, effort, auto_review, classifier, land_gate
  delivery: 'direct' | 'pr';          // default 'direct'
  auto_merge?: boolean;               // pr only; default false
  remote?: string;                    // git remote for pr mode; default 'origin'
  github?: { owner: string; repo: string };   // inferred from the remote URL; stored once confirmed
  main_branch?: string;               // default: the remote's default branch, else main/master
  visibility: { mode: 'public' } | { mode: 'private'; projects: ProjectId[] };  // default public
  // target_branch: removed in the migration (§17). The main branch is main_branch
}
```

### 14.9 Event

The routed event log is `~/.agile/events/log.jsonl` (append-only). Each recipient has a delivery queue at `~/.agile/events/queue/<node-id>.jsonl`. The routed events are a different thing from the existing audit log at `log/events.jsonl` (P9).

```ts
type EventId = `E-${Ulid}`;

interface RoutedEvent {
  id: EventId;
  type: EventType;                 // §15
  subject: StreamId;               // the node it is about (for repo events: the node whose change caused it, or absent)
  repo?: string;                   // set for repo events
  project?: ProjectId;
  payload: Record<string, unknown>;  // typed per EventType; each string ≤ 800; detail behind `ref`
  ref?: string;                    // pointer: file path, PR URL, contract id
  by: 'human' | 'daemon' | `agent:${Ulid}` | 'director';
  at: string;
  routing: { node: StreamId; because: 'self' | 'ancestor' | 'waits_on' | 'same_repo' | 'party' | 'sibling' }[];
  coalesce_key?: string;           // for example "main_changed:api": a later event with the same key supersedes an undelivered earlier one in the digest
}

interface Delivery {               // one line per state change in queue/<node>.jsonl
  event: EventId;
  node: StreamId;
  status: 'pending' | 'delivered' | 'superseded' | 'expired';   // expired: the node closed before delivery (still shown in the feed)
  delivered_at?: string;
  session?: string;                // which session's turn carried it
  digest?: string;                 // id of the digest prompt it was folded into
}
```

### 14.10 External link and tracker settings

```ts
interface ExternalLink {
  system: 'jira' | 'linear';
  key: string;                      // "SHOP-11"
  url: string;
  kind?: 'epic' | 'issue';
  synced: { title: string; description_hash: string; at: string };  // for change detection
}
interface TrackerSettings {
  system: 'jira' | 'linear';
  base_url?: string;                // Jira site
  push_status: boolean;             // Node → tracker; default false
  status_map?: Partial<Record<'in_progress' | 'in_review' | 'done', string>>;
}
```

### 14.11 Director

`~/.agile/director.yaml` holds `{ thread: 'director', session?: SessionRef, created_at }`. The thread is `~/.agile/threads/director.jsonl`. The Director is not a node in any project tree (P16). Its actions carry the principal `director`.

### 14.12 Principals

`STREAM_PRINCIPALS` gains `coordinator` and `director`. Both write through the store with the same limits as `agent`. They can never write `human.*`, accept a knowledge item or approve a delivery. Structural changes (create child, waits_on, owners) are allowed at the principal's autonomy level and recorded with the principal (§12, §9).

## 15. Event catalog

Recipients use the routing rules from §8. **self** is the subject node. **ancestors** are the subject's parent and every ancestor up to the project root. **waits-on** is every node with a `waits_on` entry pointing at the subject. **same-repo** is every live work node on the event's repo, in any project, other than the subject. **parties** is every child named on a contract. What the agent is told is the one-line summary its prompt carries. The payload is available through `read_event`.

| Type | Producer | Recipients | What the recipient agent is told |
|---|---|---|---|
| `human_line` | a human line on a thread (cockpit composer, `agile say`) | self | "Pete wrote on this thread: <body>. Reply on the thread first, then continue." (T174 wording) |
| `answer` | a question or gate answered | self | "Your question <Q> was answered: <answer>." |
| `child_status` | a child's `agent.status` becomes `done`, `blocked` or `question` | ancestors | "Child <title> is <done/blocked/asking>: <progress line>." |
| `child_delivered` | a child's delivery reached `merged` | ancestors | "Child <title> merged into <repo> main (<sha>)." |
| `pr_review` | the PR poller sees a new review or review comment | self, ancestors (summary only) | self: "PR #12 review from <login>: <state>. Comments: <≤5, rest via read_event>. Fix small asks and push; send design disagreements to the inbox with `ask`." Ancestors: "PR #12 on <child>: changes requested." |
| `ci_failed` | the PR poller sees a failing check on the head sha | self | "CI failed on PR #12: <check name>. Log excerpt at <ref>. Find the cause, fix it and push. A flaky test is reported with `ask`, never skipped." |
| `pr_behind` | the poller sees `mergeable` behind or conflicting | self | "PR #12 is behind main / conflicts on <files>. Merge main in, resolve, run the tests, push." |
| `pr_merged` | the poller sees the PR merged (or a direct Merge) | self, ancestors, waits-on | Also produces `main_changed`. self: "Your PR merged; the stream is done." Waits-on: see `dependency_satisfied`. |
| `pr_closed` | the PR was closed unmerged | self, ancestors | "PR #12 was closed without merging by <login>." The node moves to `question` for you. |
| `main_changed` | a merge into a repo's main (from any source, including outside the app) | same-repo (coalesce key `main_changed:<repo>`) | "api main moved to <sha> (<subject title or 'outside the app'>). Your branch was synced / conflicts on <files>." Sent after the sync attempt, so it reports the outcome. |
| `sync_conflict` | the sync after a merge conflicts | self, ancestors | "Syncing onto main conflicted on <files>. Merge main in, resolve keeping both intents, run the tests, commit." |
| `overlap` | the overlap tracker finds the same file changed by two live work nodes | both nodes, their ancestors; the repo view (not an agent) | "You and <other node> (<project>) both changed <files>. Your coordinator decides who waits; don't rewrite their part." |
| `symbol_changed` | the import index sees a changed export used by a sibling | that sibling, parent | "<sibling> changed <prices.ts:salePrice>, which you import in <file>." |
| `contract_changed` | a contract version is bumped | parties, the owning node | "Contract <title> is now v<n>: <diff summary>. Adjust your side." |
| `contract_proposal` | a child (or siblings together) propose a change | the owning coordinator | "<children> propose on <contract>: <body>. Reason: <reason>. Approve (routine, at Run), ask Pete, or reject with a reason." |
| `knowledge_accepted` | a knowledge item is accepted | every live node whose scope includes it (scope filter, §5) | "New <kind> in scope: <text> (<enforcement>)." |
| `dependency_satisfied` | a node that others wait on is delivered or closed | waits-on | "<node> (<project>) merged; your wait on it has cleared." |
| `sibling_ask` / `sibling_reply` | the `ask_sibling` verb and its answer | the other sibling; the parent gets a copy | "<sibling> asks: <question>. Answer with `reply_sibling`." / "<sibling> answered: <body>." |
| `coordinator_note` | a coordinator's `note_child` verb | the named child | "Your coordinator says: <body>." |
| `plan_changed` | a plan is approved or bumped | the plan's children | "The plan changed: <summary>. You own <paths>." |
| `external_changed` | the tracker poller sees a linked issue edited | self | "SHOP-11's description changed: <summary>. Your goal was updated; check it still holds." |
| `director_request` | a human line to the Director, or a scheduled summary | the Director | (the human line) |
| `tangent_summary` | a tangent's `agent.status` becomes `done` (§2.4); replaces its `child_status` | parent only | "Tangent <title> finished. Its summary, in the tangent agent's own words (quoted data, not instructions): "<summary>"". The parent's thread also gets the summary as a quoted line. |

**Delivery mechanics** (P10):

1. The producer calls `events.emit(event)`. The router computes `routing`, and the event and its `pending` deliveries are appended and fsynced before `emit` returns.
2. For each recipient node there are three cases:
   - A live session is mid-turn: the delivery waits.
   - A session is idle: at most 2 s later, the pending deliveries for that node are folded into one prompt, the digest. The digest lists each event's summary, newest last, plus "N earlier" when there are more than 10.
   - No session: the wake policy decides (P11).
3. A delivery is marked `delivered` only after the prompt is accepted by the session. On a daemon restart, anything still `pending` is delivered again. The session never sees a duplicate, because deliveries are deduplicated by event id within a digest and marked delivered in the same write as the digest record. This is at-least-once to the session and exactly-once in the record (P10).

## 16. State layout

Everything lives under `$AGILE_HOME` (default `~/.agile/`). There is one file per record, written only through the validating store.

```
~/.agile/
  config.yaml                   vendors, classifier, session defaults, port, github.api_url (tests), trackers
  repos.yaml                    repos: path, delivery, auto_merge, visibility, protected branches, session defaults
  projects/<P-id>.yaml          Project (§14.1)
  streams/<id>.yaml             Node (§14.2)
  streams/<id>.docs/*.md        per-node docs (unchanged)
  repos/<name>/docs/*.md        per-repo docs, moved here from <repo>/.agile-docs/ (P3)
  threads/<id>.jsonl            one thread per node; threads/director.jsonl
  knowledge/<K-id>.yaml         KnowledgeItem (§14.3); replaces rules/
  plans/<node-id>.yaml          Plan (§14.4)
  contracts/<C-id>.yaml         Contract (§14.4)
  cards/<node-id>.yaml          StatusCard (§14.5)
  index/<repo>.json             import index (derived cache; deleting it is safe)
  events/log.jsonl              routed events (§14.9), append-only, fsync per append
  events/queue/<node-id>.jsonl  per-recipient delivery lines
  director.yaml                 the Director record (§14.11)
  gates/, questions/            unchanged
  log/agiled.log                unchanged
  log/events.jsonl              the audit log (every state change, §7.4 of the cockpit design), unchanged in purpose
  sessions/<id>/                unchanged (stderr.log, brief.md, output files, CI log excerpts)
```

**Nothing in the user's repos** except the code that the work produces, on `stream/…` branches:

- Worktrees stay at `<repo>/.worktrees/<stream-id>-<slug>`, ignored through `<git-common-dir>/info/exclude` (T177), never through `.gitignore`.
- The per-worktree `.claude/settings.json` hook file (hook/settings.ts) is also added to the worktree's exclude, so an agent's `git add -A` can't commit it (P4).
- `<repo>/.agile-docs/` is no longer read or written (P3).

## 17. Mapping from today's code

| Module | Verdict | What happens |
|---|---|---|
| `shared/stream.ts` | change | Node fields (§14.2); `nodeRole`; principals gain `coordinator`, `director`. `target_branch` is dropped from the stream record: work nodes deliver to `main_branch`, and helpers to `helper_of`'s branch. |
| `shared/rule.ts` | change | Becomes `knowledge.ts` (§14.3). `RulePattern`, `RuleExample`, `RuleCriteria` and `RuleStats` are kept as parts. |
| `shared/repos.ts`, `home-config.ts` | change | Delivery, auto-merge, remote, visibility (§14.8); `github.api_url` for tests. |
| `shared/event.ts` | keep + add | The audit `EVENT_KINDS` keep their role (new kinds for projects, knowledge, delivery). `RoutedEvent`/`Delivery` are new in `shared/routed-event.ts`. |
| `shared/verbs.ts` | change | Adds `read_card`, `lookup_knowledge`, `propose_knowledge` (replaces `propose_rule`), `ask_sibling`, `reply_sibling`, `propose_contract`, `read_event`. Coordinator verbs: `plan_write`, `contract_write`, `add_child`, `add_waits_on`, `note_child`, `approve_contract`. |
| `daemon/store` | change | New record types: project, knowledge, plan, contract, card, director. The routed event log and queues. A one-shot migration on start (§17.1). |
| `daemon/streams` | change | Project-aware create/list; the reshape for + Repo (§7); waits_on writes. |
| `daemon/attach` | fold | "Start" replaces attach. `stream.create` for a work or conversation node starts its agent unless `--no-start`. `AttachService.say` and the answer delivery prompts are replaced by event delivery (T174's queue becomes the event queue). `agile attach` stays as "restart the agent". The T176 parent-attach guard is removed: coordinating nodes have no worktree, and their session is the coordinator. |
| `daemon/runner` | change | Coordinator and Director roles (briefs); brief assembly takes knowledge in scope, plan, contracts, sibling cards. The worktree base is `main_branch`, or `helper_of`'s branch for a helper. |
| `daemon/landing` | change → `delivery/` | The direct merge path is kept (it becomes `delivery.direct`). The parent-branch target (`parentBranch`) is removed. The diff rules become ship checks over `ship` items, plus a reviewer run with the checklist of `review` items. PR mode is new. Resolve (T176) is kept as the conflict path for both modes. |
| `daemon/rules` | change → `knowledge/` | Service, builtins, evals, report, inbox cards are kept and re-keyed. `seed-plan-v1.ts` is deleted (a one-off). |
| `daemon/hook`, `permissions`, `classifier` | keep | Action checks read `enforcement: 'action'` items. The scope filter becomes the stacked filter (§5). The visibility deny is added to the path checks (P13). |
| `daemon/lessons` | keep | Proposes knowledge items with a kind (default `standard`; `architecture` when the finding names where something lives). Runs after `merged`, not after land. |
| `daemon/inbox`, `questions`, `gates` | keep | New card kinds: plan approval, contract proposal (when asked), delivery Merge (direct), Director/coordinator proposals at Advise. |
| `daemon/docs` | change | Reads and writes `~/.agile/repos/<name>/docs/`. Imports `.agile-docs/` once (P3). |
| `daemon/bus` | remove if still present | Replaced by routed events. |
| `daemon/feed`, `http` | change | The snapshot carries projects, roles, delivery, overlaps and activity. New routes, each behind `isSameOriginRequest`. |
| new `daemon/projects` | new | Project service and RPC. |
| new `daemon/events` | new | Router, queue, digest, wake policy, activity feed. |
| new `daemon/github` | new | The GitHub port, the REST adapter, the PR poller (§18). |
| new `daemon/sync` | new | Sync after merge, overlap tracker, import index. The name is reused: the old `sync/` was deleted in the reshape, and this one is unrelated. |
| new `daemon/coordination` | new | Plans, contracts, cards, alerts, ask sibling, autonomy gating. |
| new `daemon/director` | new | The Director session, tools and guards. |
| new `daemon/trackers` | new | Jira/Linear ports and fakes (Phase 13). |
| `cli` | change | `agile project …`, `agile node …` (alias `stream`), `agile deliver` (alias `land`), `agile knowledge …` (alias `rules`), `agile events`/`tail --node`, `agile repo set`. |
| `ui` | change | Project switcher and tree, repo view, lenses, + Repo, delivery panel, activity feed, Knowledge screen (the Rules screen renamed), coordinator plan and contracts tab, Director page. |

### 17.1 Migration of an existing home

The migration runs once on daemon start. It is idempotent and recorded as an audit event.

1. Create the project **"Unfiled"** with a root node. Every existing parentless stream becomes a child of that root, and every stream gets `project` set. The existing stream ids are kept. (P2)
2. Each `rules/R-X.yaml` becomes `knowledge/K-X.yaml`:
   - `kind: standard`;
   - scope `stream` becomes `subtree`;
   - enforcement: `pattern` or `classifier` at stage `action` becomes `action`; classifier at `diff` becomes `ship`; `both` becomes `action` plus a second `ship` item (P6); `guidance` becomes `tell`.

   `rules/` is kept read-only for one phase and then removed.
3. `repos.yaml` entries get `delivery: direct` and `visibility: public`. A repo with a `target_branch` keeps it as `main_branch`, with a thread note.
4. A stream whose parent has a branch (the old parent integration model) keeps its branch. Its next delivery targets `main_branch`, not the parent's branch. Unmerged parent branches are listed in one inbox card for you to deliver or close.

## 18. GitHub integration

- **One port, two adapters.** `daemon/github/port.ts` defines the subset used: get repo (default branch, auto-merge allowed), create and update a PR, get a PR, list reviews, list review comments, list issue comments, list check runs for a ref, the combined status, enable auto-merge, merge (fake only), and compare. There is one adapter, `rest.ts`, over `fetch` against `github.api_url` (default `https://api.github.com`). Auto-merge goes through the one GraphQL mutation `enablePullRequestAutoMerge` against `<api_url>/graphql`.
- **The user's own auth.** The adapter gets a token for each call from `gh auth token` (the user's `gh` login). The token is held only for that call and never stored, logged or sent to the browser. This follows the "no vendor credentials in the daemon" convention: like a vendor harness, the daemon borrows the user's login at use time. If `gh` is missing or logged out, a `pr` repo refuses delivery with one line ("run `gh auth login`"), and `agile daemon status` says whether GitHub auth is available.
- **Pushing** uses plain `git push <remote> <branch>` in the worktree, with the user's git credentials. This is the one push the app makes on the agent's behalf. The built-in push rules are unchanged: agents still can't push protected branches.
- **Polling, not webhooks.** The daemon has no public URL. The PR poller runs every 60 s for open PRs of live nodes, and every 15 s for a PR whose node is mid-babysit. It backs off to 5 min for a PR with no changes for an hour. It sends conditional requests (`If-None-Match`), and a rate-limit response pauses polling with a thread note. Main changes on a `pr` repo are detected by `git ls-remote <remote> <main>` on the same cadence, followed by a fetch.
- **Fake GitHub for tests.** `packages/daemon/src/github/fake-server.ts` (test support, like `runner/fake-agent.ts`) is a local `Bun.serve` HTTP server that implements the port's subset with in-memory PRs, reviews, comments and check runs. It is backed by a bare git repo on disk, which is the test repo's `origin` (a `file://` remote). Merging a PR in the fake performs a real `git merge` into the bare repo. The server has test controls: add a review, add a comment, set a check result, and merge, which is what a teammate or GitHub would do. Unit tests and `test:integration` point `github.api_url` at it with a static token. Nothing in `bun test` touches the network.
- **Live checks** use `https://github.com/petestewart/agile-test-repo`, cloned to `~/Projects/agile-test-repo` and registered with `delivery: pr`. These are manual only, on Pete's machine.

## 19. Proposed decisions (gaps filled; Pete to confirm)

The agreed design does not settle these. Each one is a proposal, recorded in `PLAN.md` §9 as an open question until Pete confirms it. The tickets assume the proposal.

- **P1. Role is derived, not stored.** `nodeRole()` (§14.2): project means no parent; coordinating means live children other than same-repo helpers; work means a repo; otherwise conversation. Storing the role would let it go stale. *Amended by D33:* a node with no repo whose children are all conversations (tangents, §2.4) stays a conversation.
- **P2. A project is a record plus a root node.** The project's settings live in `projects/<id>.yaml`, and its thread and tree hang off a root stream. Existing homes migrate into one project, "Unfiled". Every node must belong to a project; quick capture files into the current project, or "Unfiled".
- **P3. Repo docs move to the home.** Today's `<repo>/.agile-docs/` is tracked in the repo. That was the cockpit design's Q4 assumption, and it contradicts "nothing in your repos". Docs move to `~/.agile/repos/<name>/docs/`, imported once. The old directory is left alone, never deleted by the app, and the import prints a line saying you may remove it.
- **P4. The hook settings file is excluded.** `.claude/settings.json` in a worktree is added to `info/exclude`. If the repo already tracks a `.claude/settings.json`, the daemon uses the vendor's settings flag or a local-settings file instead of overwriting it. T207 established that the pinned adapter (`claude-agent-acp@0.81.1`) loads `settingSources: ["user", "project", "local"]` by default, so the daemon writes `.claude/settings.local.json` (untracked, excluded) in that case and leaves the tracked file untouched. If both files are tracked, attach is refused.
- **P5. The session default order** becomes: flag or picker → node → project → repo → home → built-in. This extends D17 with a project step before the repo step.
- **P6. The `both` stage splits into two items on migration**, one `action` and one `ship`, because an item now has one enforcement setting.
- **P7. Merge together.** The agreed design never defines "merge together". Proposed: nodes that share a `merge_together` key are delivered as a group:
  - direct mode: all members are merged in one operation once every member is ready, and it stops before the first merge if any member fails its ship check;
  - PR mode: every PR is opened, and auto-merge is enabled on each PR only when all of them are approved and green. Cross-repo atomicity isn't possible on GitHub, and the node says so.
- **P8. "Waits on" holds delivery, not the start of work.** The waiting node works normally, and its merge or auto-merge is held until the dependency is satisfied: the target merged, or, for a non-work target, closed. A cycle is refused at write time.
- **P9. Two logs.** `log/events.jsonl` stays the audit log (every state change, the reconstruction test). The routed events of §8 are a new store under `events/`. In code they are `RoutedEvent`, to avoid the name clash.
- **P10. "Delivered once" means at-least-once transport with dedupe by event id.** A crash between the send and the mark can repeat a prompt, but never an event within a digest record. True exactly-once isn't achievable across a crash.
- **P11. Wake policy.**
  - A **coordinating node** with an agent is woken by any event routed to it.
  - A **work node** whose session has ended is woken by `human_line`, `answer`, `pr_review`, `ci_failed`, `pr_behind`, `sync_conflict` and `contract_changed`. Other events wait for its next turn.
  - A **conversation node** is woken only by `human_line` and `answer`.
  - A **wake budget** (default 20 wakes per node per hour) stops event loops. When a node hits it, it goes to your inbox.
  - Nodes you have stopped are never woken. Their events stay pending and are shown.
- **P12. "Routine" contract changes** mean additive changes: a new optional field, a widened type, or a docs-only change that all parties accept. Renames, removals and behaviour changes are never routine. The coordinator judges this; at Run it may approve routine changes itself. Everything else comes to you.
- **P13. Visibility enforcement.**
  - A private repo's path is left out of the session's readable directories.
  - For vendors with hooks, a built-in path check denies reads under that repo's path to nodes of projects that aren't listed.
  - For vendors without hooks, visibility is advisory. The node says so.
- **P14. The import index covers TS/JS only** in Phase 11: `import`/`export` statements, found by regex. Other languages get file-level overlap only.
- **P15. Sync strategy.**
  - Sync merges main into the node's branch. It never rebases, so a pushed PR branch never needs a force push.
  - If the worktree is dirty or the session is mid-turn, the sync is deferred to the end of the turn.
  - On a conflict the merge is aborted, the node is flagged, and `sync_conflict` goes to its agent (the T176 Resolve path).
- **P16. The Director is a singleton record, not a node.** It has its own thread and session, it is outside every project tree, and its autonomy level is read per project from `Project.autonomy.director`.
- **P17. Tracker credentials.** Jira and Linear have no ambient CLI login like `gh`. Proposed: a per-tracker token in `config.yaml` (`trackers.<system>.token`), handled exactly like the classifier key: never printed, logged or sent to the browser, and reported only as loaded or not. This would be a **second written exception** to "no vendor credentials in the daemon", so it needs Pete's explicit approval before Phase 13 starts.
- **P18. GitHub token source.** Per call from `gh auth token`, never stored (§18). The alternative, a token in `config.yaml`, is rejected because it would add a third credential exception.
- **P19. Auto-merge unavailable.** If GitHub refuses to enable auto-merge (it isn't allowed on the repo, or there are no required checks), the node shows `auto_merge: unavailable` and waits for a human merge. The daemon never merges a PR through the API itself.
- **P20. The coordinator's session** is spawned with the project's session defaults and no worktree. Its cwd is a scratch directory under `sessions/<id>/`. It reads repos under the visibility rules, and hooks deny all writes outside its scratch directory.

### 19.1 Contradictions and loose ends found in the agreed design

- **Build order.** The agreed design's closing line orders the work as delivery and sync, then knowledge, then events and coordinators. But PR babysitting needs events: "review comments and CI failures come back to the agent as events". The plan keeps the phase numbers Pete asked for (7 Projects, 8 Delivery, 9 Events, 10 Knowledge, 11 Coordination, 12 Director, 13 External links). It moves PR babysitting out of Phase 8 and into Phase 9 (T246), after the event core. Phase 8 tracks PR state and holds merges mechanically, with no agent involvement.
- **The "Open questions" section is stale.** Every question in it (Jira links, the "Desk", auto-merge, coordinator autonomy, conversation nodes reading repos, daemon size) is answered in the body of the design: §10, the Director, §4.1, §9, §4.4, and D18's 20,000-line target. This document drops the section, and `PLAN.md` D19+ records the answers.
- **Helper children vs "parent branches removed".** Same-repo helper children do merge into their parent's branch (§2.1). That is a narrow exception to removing parent branches. It is kept, and it is the only case where a node's delivery target is not its repo's main (`helper_of`).
- **A work node with a helper on another repo.** §2.1 says the parent "becomes a coordinating node as usual". That only works if the work node's own changes move into an "api part" child, as in §7. Adding a helper on another repo therefore uses the §7 reshape, not a plain child.
- **"Delivered once" and "never dropped"** can't both hold strictly across a crash. See P10.
- **Enforcement has four settings but three checkpoints.** `ship` (the classifier over the diff) and `review` (the reviewer checklist) both run at the Ship checkpoint. "After" is not a setting; it is statistics and PR review.
- **"Merge together"** appears only in the "What changes" table and is never defined. See P7.
- **"Nothing in your repos" vs today.** Today `.agile-docs/` is tracked in the repo, and the hook settings file can be committed from a worktree. See P3 and P4.

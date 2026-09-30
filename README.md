# Agile Agents

A cockpit for running coding agents, for one person. You keep one tab open. Your agents (Claude Code, Gemini CLI, Codex and others) work in parallel, each on its own branch, and the cockpit brings you what needs you: a question, an action to allow, a plan to approve, work ready to merge.

One long-lived daemon, `agiled`, holds all state in one directory of plain YAML, JSONL and Markdown. Agents run under your own vendor login. Nothing is committed to your repos except the code the work produces, on a branch you merge; the worktrees (`.worktrees/`) and a scratch cache (`.agile-daemon-cache/`) sit beside your code, and git ignores both.

## What it does

- **Projects and nodes.** A project is a tree of nodes. Each node has a goal, a chat thread and a status. What a node *is* follows from its shape:

  | Role | Children | Repo | Its agent |
  |---|---|---|---|
  | project (the root) | its top-level nodes | the repos it uses | coordinates its parts, once it has any |
  | conversation | none | none | answers, researches, explains |
  | work | none | one, with a branch and a worktree | writes code, then delivers it |
  | coordinating | parts | its parts' | plans, splits work, tracks its parts |

  A node with parts reads as its most urgent part ("Needs you" when one asks, "Working" while they work) with a line like "2 of 4 merged · waiting for web part", and says **Done** only once every part is merged or closed. A project's Overview groups its nodes under their top-level node, folds what is finished, and filters by title (`/`).

- **Needs me.** Everything waiting on you, across every node, answered in place: questions with clickable choices, actions to allow, plans to approve, knowledge to accept, work to merge (with its diff size). Replies you haven't read are listed first. Optional browser notifications tell you while you're in another app.
- **Ask from anywhere.** Press `A` to ask a question at the level you choose: the Director, a project, a coordinator, or the agent on one ticket. The question gets its own thread, and its agent sees what the node it's about is doing. A conclusion can be sent up to that node, or the conversation can **turn into the work** it concluded, in place.
- **Agents that split work.** Coordinators and the Director plan and create child nodes. How far they go on their own is set per project: at Advise they propose and you click to apply; at Organise they create nodes and start agents themselves and tell you; Run also lets them approve routine contract changes and restart stuck work. Merging and accepting knowledge stay yours at every level. Whatever they do on their own shows on the chat as a row in words ("Added a part: **Add an RSS field** (web)"), and in Events and the node's Activity with a link to each node it made and **Undo** until one starts. A part is named for its node and its repo ("Rotate the API keys · api"). A worker's proposed follow-up is one click from being a node.
- **A chat per node.** You see the agent's steps live ("Claude is working · 1m 12s"), how full its context is, and a Changes tab where you can comment on any line of the diff and send the comments as one review.
- **Knowledge that is enforced.** Standards, architecture notes and decisions apply to a repo, a project or a subtree. Hooks enforce them while the agent works, and ship checks enforce them before anything merges. A pattern or a classifier check does the checking. When you accept an item, the conversation that proposed it hears at once; the other conversations in its scope read it with their next message, unless you turn on **Let Jev decide which conversations hear an accepted decision** (Settings → Classifier → Accepted decisions, needs the TypeSafe key). With that on, the classifier also wakes a finished conversation when the decision changes its answer or settles something it left open and the conversation is still current (up to five per item).
- **Permissions.** Every vendor runs in its normal permission mode, never a bypass flag: the daemon answers each tool call through one pipeline (hooks where the vendor has them, its permission requests otherwise). An agent writes only in its own node's worktree, and the calls that are always yours (force-pushes, deletes outside the worktree, new dependencies, the agile home) still ask. What it may read beside its worktree is your choice in Settings → General → Permissions, for every project or one: **Ask** (the default) reads the registered repos, and a read anywhere else is a Needs me card (Allow once, Always for this project, Deny); **Trusted**, like Claude's bypass or Codex's yolo, reads any path on disk without asking. Neither reads the agile home, another project's private repo or your credentials (`~/.ssh`, `~/.aws`, vendor logins and the like).
- **Delivery per repo.** Either direct (Merge merges the branch into main) or by pull request (the app opens it and the agent looks after it until it merges). Merging is always yours.
- **The Director.** An agent above all projects that you talk to about everything at once.
- **Tracker links.** A node can link a Jira or Linear issue, and an epic can import its children as nodes.

## Requirements

- [Bun](https://bun.sh) 1.4.2 or newer, and git.
- At least one vendor harness, logged in with your own account. [Claude Code](https://claude.com/claude-code) is the default. Gemini CLI, Codex, Cursor, Grok CLI and Pi are also supported over ACP.
- Optional: `gh`, logged in, for pull-request delivery; a Jira or Linear token for tracker links; a TypeSafe key for classifier checks.

## Install

```sh
git clone https://github.com/petestewart/agile-agents.git
cd agile-agents
bun install
bun run build
cd packages/cli && bun link && cd -   # puts `agile` on your PATH (~/.bun/bin)
```

After pulling new code, run `bun install && bun run build`, then `agile daemon stop && agile daemon start`, and reload the cockpit tab.

## First run

```sh
agile init            # creates the home (~/.agile, or $AGILE_HOME)
agile daemon start    # starts agiled in the background
```

Open **http://127.0.0.1:4600/**. With nothing set up yet, Needs me walks you through three steps:

1. **Add a repository.** Browse to a git repository on this machine, or paste a GitHub, SSH or HTTPS URL to clone one. The dialog opens right there, and afterwards step 2 is next (`⌘K` → Add repository… adds more later).
2. **Create a project** and tick the repositories it uses.
3. **Start a node.** Press `N` and write what you want done. In a project with one repository, the node starts on it (**Just talk instead** makes it a conversation). The agent starts at once, and its composer has the focus. The title is the goal's first line, cut before a clause; with quick drafts on, a title you leave as it is gets rewritten by one quick Claude Haiku call through your `claude` login.

`agile daemon status` says whether the daemon is running, where its home is, and which model a new session will use.

## Keys

| Key | What it does |
|---|---|
| `N` | New node (under the open node) |
| `A` | Ask about the open node, or the Director |
| `⌘K` / `Ctrl K` | Search and run anything: nodes, views, this node's actions, what needs you |
| `?` | Every shortcut |
| `G` then `I` / `D` / `K` / `R` / `E` / `S` | Needs me, Director, Knowledge, Running, Events, Settings |
| `J` / `K` | Next or previous card in Needs me; on a node's page, open the next or previous node in the tree |
| `A` / `B`, `1` / `2` | Pick a choice on a focused question |
| `Enter` / `Shift+Enter` | Send / new line, in the composer and in a diff comment |
| `Esc` | Close a dialog, menu or panel |

## The CLI

Everything in the cockpit can also be done from `agile`. Run it with no arguments for the full usage.

```sh
agile repo add ~/code/shop --name shop
agile project new --name Shop --repo shop
agile node new --project P-… --title "Add CSV import" --goal "…" --repo shop
agile inbox                     # what waits on you
agile answer Q-… "Use integer cents"
agile deliver <node>            # ship checks, then merge
agile tail --follow             # the event log
agile director say "What needs me today?"
agile policy show --project P-…    # model choice: each setting and where it comes from
agile policy set mode inherit --node <node>
agile policy try "Rename getUser to fetchUser"   # the chooser's scores and pick; nothing starts
```

Every command takes `--json`.

## Where things live

The home (`$AGILE_HOME`, default `~/.agile/`) holds:

- `config.yaml`: the port (default 4600), session defaults, classifier and tracker settings, `quick_drafts` (Settings → General → Quick drafts: set it to `false` to skip the Haiku calls for titles and goal drafts), and `knowledge_wake` (Settings → Classifier → Accepted decisions: `jev` lets the classifier pick which other conversations an accepted item wakes; absent, or `source`, wakes only the one that proposed it).
- `repos.yaml`: registered repositories and their delivery.
- `streams/` and `threads/`: nodes and their chats.
- `rules/`: knowledge items.
- `log/agiled.log` and `log/events.jsonl`: the daemon log and every event.
- `sessions/<id>/stderr.log`: each agent's stderr.

The daemon writes these files only through a validating store. A corrupt file is refused with its path and line, never silently reset. Worktrees live in each repo under `.worktrees/`, on `stream/…` branches.

A new session's vendor, model and effort come from, in order: what you pick when starting it, the project's settings, the repo's settings, the home default, then the built-in `claude` / `claude-opus-5-5` / `low`. A model only carries over to the same vendor. Settings → Agents edits the defaults.

When a node's agent first starts without your pick (a part a coordinator or the Director starts, a wake, a node made without a model), the **model choice** decides (`model_policy` in `config.yaml`, a project's record, or a node's own; field by field, nearest first; Settings → Agents → Model choice, and each node's Details). **Default** resolves as above; **Inherit** takes the model the parent node runs; **Choose** picks from the **preset models** (your favourites until you set them): the classifier (Jev, so it needs the classifier key) scores the task's clarity, verifiability, horizon, stakes and volume, reads its topic, and picks a model and effort; when it isn't sure the scores decide by a fixed rule, and with no key or no answer the rule alone picks (the cheapest balanced model at medium effort under Start cheap, or the strongest under Strongest first). **Pinned rules** (a role, a label or a topic → a model) come first, and your **guidance** and **criterion weights** go to the chooser; Settings' **Try it** shows the scores and the pick for a pasted task. Every such pick stays in the preset models and under the effort ceiling, and the chat says what it chose and why. The pick is made once; the node keeps it until you pick another or use **Let the policy choose again**. Your own pick always runs, preset or not. New projects use the home's choice (Choose, as shipped); projects made before it were set to Default. `model_profiles` says which models are fast, balanced or strongest, and their relative cost.

When an agent's process fails on its own (it exits with an error, not stopped by you or the daemon), `vendor_failure` decides what happens: `retry` (default on) starts the same agent again once, except after a login or model refusal; then each vendor on `fallback` (default none) that is installed takes its place in turn, on the same node, branch and thread, told to check `git status` before it goes on. A vendor with pre-tool hooks (Claude, Pi) falls back only to another with hooks unless `allow_hookless` is on. At most three restarts per node an hour. When nothing is left, the node is stuck with the vendor's error, as before. It is set in `config.yaml` (Settings → Agents → If the agent fails), and a repo's entry in `repos.yaml` or a project can override it, field by field, in the same order as the session defaults.

## Development

```sh
bun run typecheck
bun run lint                 # biome
bun test                     # offline unit tests; no vendor, no network
bun run test:integration     # a real daemon and a real browser, still no vendor
bun run test:walkthrough     # clicks through LIVE-CHECKLIST with fake agents (build first)
```

The browser tests need Chromium: `bunx playwright-core install chromium`, or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.

The code is a Bun workspace:

| Package | What it holds |
|---|---|
| `packages/shared` | every schema (zod), defined once |
| `packages/acp-client` | the ACP session client and the vendor providers |
| `packages/daemon` | `agiled`: the store, nodes, agents, hooks, knowledge, delivery, the Director, HTTP and WebSocket |
| `packages/cli` | `agile` |
| `packages/ui` | the cockpit (React and Vite), served by the daemon |

## Documentation

- [`PLAN.md`](PLAN.md): the plan, the board (every ticket and its status) and the decisions log.
- [`design/cockpit-ui.md`](design/cockpit-ui.md): the cockpit's design system, words and patterns.
- [`design/projects-design.md`](design/projects-design.md): projects, roles, delivery, events, knowledge, coordination and the Director.
- [`design/cockpit-design.md`](design/cockpit-design.md): nodes, the inbox, agents, rules, the classifier and the state home.
- [`LIVE-CHECKLIST.md`](LIVE-CHECKLIST.md): a guided end-to-end walkthrough against real vendor logins.
- [`CLAUDE.md`](CLAUDE.md): the guide for coding agents working on this repo.

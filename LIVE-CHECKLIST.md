# LIVE-CHECKLIST: the walkthrough of Phases 7–14

This is the end-to-end walkthrough of the app as of `claude/phase-14`. It
teaches the app as it goes and follows `PLAN.md` §6.1: projects, + Repo,
delivery by pull request and direct merge, overlaps, knowledge, the Director
and tracker links. It uses the two repos on your Mac,
`~/Projects/ledger-lite` (direct merge) and `~/Projects/agile-test-repo`
(pull requests on https://github.com/petestewart/agile-test-repo).

How to use it:

- Paste each block as it is. Every block not marked **[vendor]** was run as
  pasted in a scratch home before it was written down.
- From 3.4 on, the steps are done in the cockpit: which screen, what to click
  or type, and what you should see. Every one not marked **[vendor]** was
  clicked through in a real cockpit on a scratch home. The few steps the
  cockpit can't do yet are marked **CLI only:**, and are listed at the end
  of step 9.
- **[vendor]** steps need a real login: Claude Code (the agents), `gh` (pull
  requests) or your Jira/Linear site. They were derived from the tests, the
  phase QA tickets and the CLI source, not run here.
- Tick each box, or note what you saw instead.
- The state home for this run is `~/.agile-walkthrough`, so nothing touches a
  home you use for anything else. **Every terminal you open needs the
  `export` from step 1.2.**
- Only three things in this document are placeholders for you to change: your
  Jira site URL and email in 8.1, and the issue key in 8.3. Each one is called
  out where it appears.

## 0. What the app is

Agile Agents is a cockpit for coding agents, run by one person. One
long-lived daemon, `agiled`, holds all state in one directory, the **home**
(`$AGILE_HOME`). The home holds plain YAML, JSONL and Markdown files: projects,
nodes, threads, knowledge, events and logs. Nothing the app holds is written
into your repos. The only thing that reaches a repo is the code the work
produces, on a branch that you merge.

Work is organised in **projects** (Shop, Blog). Each project is a tree of
**nodes**. Every node has a goal, a thread you can talk on, and a status.
There is only one kind of node. What a node does follows from two facts about
it: does it have children, and does it have a repo. That gives four
**derived roles**:

| Role | Children | Repo | Its agent |
|---|---|---|---|
| project (the root) | its top-level nodes | lists the repos it uses | none; it holds the project's settings |
| conversation | none | none | answers, researches, explains |
| work | none (helpers aside) | exactly one, with a branch and a worktree | writes code, then delivers it |
| coordinating | yes | none of its own; its children's | plans, splits work, writes contracts, tracks children |

You don't have to restructure the tree to change where work happens. **+ Repo** (the page's
**⋯** → **Add repository…**) on a conversation turns
it into work on that repo. + Repo on a work node turns it into a coordinating
node with one **part** (a work child) per repo. The thread stays where it is.

Agents are vendor harnesses (Claude Code by default), started over ACP with
your own login. Starting a node starts its agent. **Knowledge** (standards,
architecture, decisions) is enforced by hooks while the agent works and by
ship checks before anything merges. Things that happen (a PR comment, a failing check, a merge,
an overlap, a new decision) are stored as **events** and routed to the nodes
they concern. That is how sleeping agents wake up.

Delivery is set per repo: **direct** (you click Merge and the branch merges
into main) or **pr** (the app pushes and opens a pull request, and the agent
looks after it until it merges). Merging, accepting knowledge and answering
questions are always yours. Everything waiting on you is in the **inbox**
("Needs me"). Above all projects sits the **Director**, an agent you talk to
about everything at once.

### Where things live in the cockpit

The cockpit is `http://127.0.0.1:4600/`.

| Place | What it holds |
|---|---|
| Sidebar | **New node (n)**; the views below (**Needs me** with its count, **Director**, **Knowledge**, and under *Views* **Running**, **Repos**, **Dependencies**, **Events**); *Projects*: **?** (what the dots and icons mean), **+** (new project), a filter, and every project's tree with a status dot and a role icon per node and a ⚠ mark on overlapping nodes. On hover a row shows **+** (a new node under it) and **⋯** (Open, New child node, Rename, Move to, Copy node id, Delete; right-click opens it too); a project's **⋯** has **Show only this project**, undone with the chip's **×**. **Deleted (n)** below the tree restores deleted nodes; **Settings** at the bottom. Below 900px wide it is a drawer behind the ☰ button |
| **Needs me** | The inbox, grouped by project, then node, oldest first, with a filter (**All** · **Questions** · **Decisions** · **Merges**): questions (a button per choice, or type and **Answer**), actions to allow (**Allow**/**Deny**, **Add a note**), knowledge proposals (**Accept**/**Retire**), plans (**Approve plan**), coordinator and Director proposals (**Apply**/**Dismiss**), finished work (**Merge**, **View changes**). `j`/`k` move between cards; Enter opens a card's node |
| **Repos** | A card per repo: its kind (Local only, GitHub · SSH…) and delivery in words (**Merges directly** or **Opens pull requests**, **Auto-merge**), its live work nodes across projects (ancestors greyed, status in words), overlaps as a warning naming both nodes and the files, its recent events, and its norms (a click opens the item in Knowledge) |
| **Running** | Nodes with a live agent, your move first: status, the node's path, role and repo; **⋯** → **Stop agent** |
| **Dependencies** | Every "waits on" link, across projects, grouped by the node that waits: what it waits on and that node's status; **⋯** → **Remove link** (with Undo) |
| **Knowledge** | Every knowledge item, split into **To review**, **Rules**, **Standards**, **Architecture** and **Decisions** (retired items fold at the bottom); search and scope/enforcement filters; a click opens an item's side panel: Accept/Retire, Edit, Test examples |
| **Director** | A chat with the Director, like a node's: its drafts wait on you at the end of the chat as cards (**Create**/**Dismiss**); the **Details** panel has its **Activity** and what it may do in each project |
| **Events** | Every routed event, newest first, by day: what happened (and a line of detail), to which node, and who it was routed to and why; filter by type (**All** · **Messages** · **Merges and PRs** · **Coordination** · **Knowledge**), by repo, or search; **Show more** for older ones |
| Anywhere | **Ctrl K** (**⌘K** on a Mac, or the search icon at the top of the sidebar) opens the command palette: find a node by part of its title or path, a project, a view or an action (New node, New project, switch theme, Keyboard shortcuts); ↑↓ and Enter. **?** lists every keyboard shortcut; **g** then a letter goes to a view (**g i** Needs me, **g k** Knowledge…) |
| **Settings** | Sections on the left: **General** (theme: System, Light, Dark; the daemon), **Agents** (session defaults, global and per repo), **Repositories** (**Add repository**: a folder, or a URL to clone; per repo its icon, delivery, auto-merge, visibility), **Classifier** (the TypeSafe API key), **Trackers** (Jira, Linear), **Permissions** (who decides) |
| A node's page | A chat with its agent. The header: path, title, status, role, repo and branch, then **Start agent** (its chevron picks another model), **Stop** while it works, **Merge** when there is something to merge, the details toggle and **⋯** (**Review changes…**, **Restart agent**, **Waits on…**, **Add repository…**, **Tracker issue…**, **Copy branch name**, **Close node…**, **Delete node…**). Tabs **Chat**, **Changes**, **Plan**, **Activity**, **Knowledge**, **Docs**, only where they apply. What needs you (questions, gates, plans, proposals) sits at the end of the chat, and the composer answers an open question. The **Details** panel: **Delivery** (Check now, Mark landed, Resolve), **Agent** (sessions), **Children**, **Waits on**, **Tracker** (**Link**, **Create issue**; then **Unlink**, **Import children**; only when the node's project has a tracker), **Coordinator autonomy** on a coordinating node or a project root (and, on a project root, **Director autonomy** and the project's tracker) |

### The CLI

`agile` with no arguments prints every command. The ones this walkthrough
uses: `init`, `daemon start|stop|status`, `repo add|set|list`,
`project new|list|show|set`, `node new|list|show|add-repo`,
`knowledge list` and `tail`. Every verb takes `--json`.

## 1. Install, a fresh home, start

### 1.1 Build and install `agile`

- [ ] Build `claude/phase-14` and put `agile` on your PATH. The block assumes
      the checkout is at `~/agile-agents`.

```zsh
cd ~/agile-agents
git checkout -- packages/cli/src/index.ts
git fetch origin
git checkout claude/phase-14
git pull origin claude/phase-14
bun --version
bun install
bun run build
cd packages/cli
bun link
cd ~/agile-agents
which agile
```

`bun --version` must be 1.4.2 or newer. `which agile` prints
`~/.bun/bin/agile`. If it prints nothing, add
`export PATH="$HOME/.bun/bin:$PATH"` to `~/.zshrc` and open a new terminal.
(`bun link` makes `packages/cli/src/index.ts` executable, which git sees as a
local change; the first `git checkout --` line undoes it so the branch
switch and pull never refuse.)

After pulling new code at any later point, rebuild and restart the daemon,
then reload the cockpit tab:

```zsh
cd ~/agile-agents
git checkout -- packages/cli/src/index.ts
git pull origin claude/phase-14
bun install
bun run build
chmod +x packages/cli/src/index.ts
agile daemon stop
agile daemon start
```

### 1.2 Point at the walkthrough home

- [ ] In every terminal for this walkthrough:

```zsh
export AGILE_HOME=~/.agile-walkthrough
```

### 1.3 Reset (start clean; also the recipe to start over)

- [ ] Stop the Phase 7–13 look daemon if it is still running (it would hold
      port 4600), stop any daemon on this home, delete this home, and clear
      the app's worktrees and `stream/…` branches from both repos:

```zsh
AGILE_HOME=~/.agile-phase7 agile daemon stop
agile daemon stop
rm -rf ~/.agile-walkthrough
[ -d ~/Projects/agile-test-repo ] || git clone https://github.com/petestewart/agile-test-repo ~/Projects/agile-test-repo
cd ~/Projects/ledger-lite
git checkout main
rm -rf .worktrees
git worktree prune
for b in $(git for-each-ref --format='%(refname:short)' refs/heads/stream); do git branch -D $b; done
git status --short
cd ~/Projects/agile-test-repo
git checkout main
rm -rf .worktrees
git worktree prune
for b in $(git for-each-ref --format='%(refname:short)' refs/heads/stream); do git branch -D $b; done
git status --short
```

Each `daemon stop` says `agiled is not running (home=…)` when there is
nothing to stop; that is fine. If it adds `but port 4600 is held by pid …`,
something else holds the port: see 9.4. Only `stream/…` branches are deleted. Each
`git status --short` must print nothing (commit or stash first if it does).

### 1.4 Create the home and start the daemon

```zsh
agile init
agile daemon start
agile daemon status
agile knowledge list
```

- [ ] `init` says `state home …/.agile-walkthrough ready (13 files written)`.
- [ ] `daemon status` prints `home: …`, `agiled running: pid=… http=http://127.0.0.1:4600 …`,
      `classifier key: …` (whether one is loaded, never the key),
      `GitHub auth: available` (or `unavailable (run gh auth login)`),
      `trackers: jira not configured · linear not configured` and
      `session default: claude/claude-opus-5-5 · low`.
- [ ] `knowledge list` shows the three built-in items: `no-push-to-protected`
      and `stay-in-worktree` (accepted, `action:pattern!`) and `no-push` (retired).
- [ ] Open the cockpit: `open http://127.0.0.1:4600/`. Nothing waits on you
      yet, so **Needs me** shows three setup steps, each with its state and a
      button: **Add repository** (opens Settings), **New project**, **New node**.

## 2. Projects and repos

A repo is shared ground: several projects may work on it at once. Each
registered repo has a delivery mode, and `pr` needs a github.com remote and a
working `gh` login.

### 2.1 **[vendor]** One-time GitHub setup for agile-test-repo

Step 4 needs a check that fails until the agent fixes it, and GitHub
auto-merge. Do this once; skip it on later runs.

- [ ] Log in, and let git push over https with the same login (the app
      pushes PR branches with your own git credentials):

```zsh
gh auth status
gh auth setup-git
```

- [ ] `gh auth status` says you are logged in to github.com.
- [ ] On github.com, agile-test-repo → Settings → General → Pull Requests:
      tick **Allow auto-merge**.
- [ ] Add a check that fails unless a pull request also adds a line to
      `CHANGELOG.md`, and push it to main:

```zsh
cd ~/Projects/agile-test-repo
git checkout main
git pull --ff-only origin main
mkdir -p .github/workflows
cat > .github/workflows/changelog.yml <<'EOF'
name: changelog
on: pull_request
jobs:
  changelog:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: The pull request adds a line to CHANGELOG.md
        run: |
          if git diff --name-only origin/${{ github.base_ref }}...HEAD | grep -qx CHANGELOG.md; then
            echo "CHANGELOG.md updated"
          else
            echo "CHANGELOG.md not updated: add one line to CHANGELOG.md describing this change"
            exit 1
          fi
EOF
git add .github/workflows/changelog.yml
git commit -m "CI: every pull request adds a CHANGELOG.md line"
git push origin main
git status --short
```

- [ ] On github.com, agile-test-repo → Settings → Branches → add a branch
      protection rule (or ruleset) for `main`: **Require status checks to
      pass**, and pick `changelog`. Do not require an approving review: the
      PR is opened with your own `gh` login, and GitHub won't let you approve
      your own PR. Auto-merge only works while something is still pending, and
      this required check is that something.

### 2.2 Register both repos

```zsh
cd ~/Projects/ledger-lite
agile repo add . --name ledger-lite
cd ~/Projects/agile-test-repo
agile repo add . --name agile-test-repo
agile repo set ledger-lite --delivery direct
agile repo set agile-test-repo --delivery pr --auto-merge on
agile repo list
```

- [ ] `repo set agile-test-repo` prints
      `delivery=pr auto_merge=on visibility=public github=petestewart/agile-test-repo`.
      Without a `gh` login it refuses with
      `pr delivery needs GitHub auth — run gh auth login`.
- [ ] `repo list` shows both, `protected=main,master`, ledger-lite
      `delivery=direct`, agile-test-repo `delivery=pr auto_merge=on`.
- [ ] Cockpit → **Settings** → **Repositories** shows the same: each repo
      with its icon (a drive for a local-only repo, the GitHub mark for
      agile-test-repo, with a small key when its remote is SSH), its path,
      `GitHub · … · petestewart/agile-test-repo`, its main branch, and
      **Direct** / **Pull request** (agile-test-repo on **Pull request** with
      **Auto-merge once checks pass** on), **Public** / **Private** and the
      protected branches. **Private** limits a repo to the projects you tick
      (by name); leave both public.
- [ ] (Optional, instead of `repo add`.) **Add repository** there opens a
      dialog: type a path (it autocompletes; **Tab** completes, the arrows
      choose, **Enter** opens a folder) or browse to the folder (git
      repositories are marked `git`), check the name, **Add repository**.
      Pasting a URL (`git@github.com:owner/repo.git`, `https://…`,
      `owner/repo`) switches to **Clone from URL**, which clones it into the
      folder it shows and adds it.

### 2.3 Two projects

A project is the root of a tree. It lists the repos it uses and holds the
settings its nodes inherit: session defaults, delivery overrides, autonomy
levels and the tracker.

```zsh
agile project new --name Shop --repo ledger-lite --repo agile-test-repo
agile project new --name Blog --repo ledger-lite
agile project list
SHOP=$(agile project list --json | jq -r '.[] | select(.name=="Shop") | .id')
agile project show $SHOP
agile node list
```

- [ ] Each `project new` prints `agile project new: P-…  Shop  root=…`. `project list` shows
      Shop (`ledger-lite,agile-test-repo`) and Blog (`ledger-lite`).
- [ ] `project show` prints the name, root, repos,
      `autonomy    coordinator=advise director=advise` and `tracker     -`.
- [ ] `node list` shows the two roots, Shop and Blog.
- [ ] Cockpit: the rail shows both projects, Shop and Blog. Shop's **⋯** →
      **Show only this project** hides Blog's nodes (a chip reads
      `Only Shop`); the chip's **×** shows both again.

## 3. **[vendor]** A conversation becomes a coordinating node

### 3.1 Autonomy: how much a coordinator does on its own

A coordinating node's agent (the coordinator) plans the split, writes the
contracts between the parts, and handles collisions between them. How far it
acts on its own is the project's **coordinator autonomy**, which you can
override on any node:

| Level | The coordinator |
|---|---|
| advise (default) | Proposes links, ownership changes and reorders; each is a **proposal** card you Apply or Dismiss |
| organise | Makes those changes itself and says so on the thread |
| run | Also approves routine (additive) contract changes |

At every level, a **plan** needs your approval, and so does any contract
change that alters what gets built. Merging, accepting knowledge and
answering questions are never the coordinator's. The Director (step 7) has the
same three levels, set separately.

Shop stays at advise for this run. To change it later:
`agile project set $SHOP --coordinator-autonomy organise`, or the
**Coordinator autonomy** picker on the project root's page. On a coordinating
node the picker (or `agile node set $C --autonomy organise`, and `inherit` to
go back) overrides the project. A work node or a conversation has no
coordinator, so its page has no picker.

### 3.2 Start a conversation

`node new` without `--no-start` starts the node's agent (Claude Code, with the
session default).

```zsh
SHOP=$(agile project list --json | jq -r '.[] | select(.name=="Shop") | .id')
C=$(agile node new --project $SHOP --title "Ledger export" --goal "Plan this with me before any code: ledger-lite should export its entries as JSON (an export --json command with a test), and agile-test-repo should get schema/ledger-entry.schema.json describing that JSON. Explain how you would split it." --json | jq -r .id)
agile node show $C
```

- [ ] `node show` prints `role        conversation`, `repo        -`, and a
      session `claude/claude-opus-5-5  effort=low  running`.
- [ ] On the node's page the thread fills with the agent's answer. No branch
      or worktree exists yet.

### 3.3 + Repo twice

On the node's page open **⋯** → **Add repository…** and pick ledger-lite, then
agile-test-repo, or paste:

```zsh
SHOP=$(agile project list --json | jq -r '.[] | select(.name=="Shop") | .id')
C=$(agile node list --project $SHOP --json | jq -r '.[] | select(.title=="Ledger export") | .id')
agile node add-repo $C ledger-lite
agile node show $C --json | jq -r '.role, .branch'
agile node add-repo $C agile-test-repo
agile node show $C --json | jq -r .role
agile node list --parent $C
```

- [ ] The first `add-repo` prints `… on stream/…-ledger-export`, and the role
      is `work` with that branch. The node now has a worktree at
      `~/Projects/ledger-lite/.worktrees/…-ledger-export`.
- [ ] The second prints two parts, `ledger-lite part` and
      `agile-test-repo part`, and the role is `coordinating`. The ledger-lite
      part keeps the branch and any commits.
- [ ] `node list --parent` shows both parts with role `work`. The
      coordinator keeps the chat; the parts wait for its plan and start when
      you approve it in 3.4. The thread gains
      `repo added: …; now a work node on …`,
      `repo added: agile-test-repo; now coordinating ledger-lite part, agile-test-repo part`
      and `ledger-lite part, agile-test-repo part wait for the plan: …`.
- [ ] Cockpit: the rail shows Ledger export with the coordinating icon and
      its two parts under it, each marked `waiting for the plan` on a line
      under its title (the title is not cut off). **Running**
      lists the coordinator while it works; the parts join it once they start.

### 3.4 Approve the plan and the contract

From here on, every step is done in the cockpit unless it is marked
**CLI only:** (the cockpit has no control for it yet; the list is in
"Not in the cockpit yet" at the end). Keep `http://127.0.0.1:4600/` open.

- [ ] In the rail, click **Ledger export**. On the **Chat** tab, type in the
      composer (`Message Claude…`, or `Tell the agent what to do…` when its
      agent is not running; the line under the box says what Send does):
      `Go ahead. Write the plan and a contract for the JSON shape of one ledger entry, then let the parts work from them.`
      and press **Send** (or Enter). Your line appears on the thread at once.
- [ ] Within a few minutes the coordinator writes a **plan** (which part owns
      which paths) and a **contract** (the JSON shape both parts rely on).
      **Needs me** gets a badge, and shows a `Plan to approve` card under
      Ledger export listing the parts (who owns which paths) and the contracts. The same
      card sits at the end of the Ledger export chat, right above the composer.
- [ ] On the Ledger export page, open the **Plan** tab. It reads
      `Plan v1 · draft` with an **Approve** button, one line per part
      (`<part>: <paths>`), and each contract as `Contract: <title> v1`, then
      `Parties: ledger-lite part, agile-test-repo part` (by name), then its body.
- [ ] Press **Approve plan** on the card (or **Approve** on the Plan tab).
      The tab reads `Plan v1 · approved by human` and the card leaves
      **Needs me**. Click the ledger-lite part in the rail and open its
      **Activity** tab: it has a `plan changed` row. Each part's brief now
      carries its owned paths and the contract.
- [ ] While the parts work, the Ledger export page shows a **Children**
      section: one status card per part (its state, what it is doing, the
      files it touched). If a part wants to change the contract, the
      coordinator (at advise) puts a `Coordinator proposal` card in **Needs
      me** with **Apply** and **Dismiss**, and the change shows as one row in
      the coordinator's **Activity** tab.
- [ ] Questions from any agent appear in **Needs me** as `Question` cards.
      When the agent offered choices, each is a button: one click answers
      with that choice (it reads `Sending…`, then the card leaves). Otherwise
      type in `Answer in your own words…` and press **Answer**. The answer
      goes to the asking session as you wrote it. On the node's page the same
      card shows the choices, and the composer below it takes a typed answer.

## 4. **[vendor]** Delivery: a pull request that looks after itself

The agile-test-repo part delivers by pull request, with auto-merge on. The
ledger-lite part delivers by direct merge, but only after the schema is
merged, so it **waits on** the other part.

### 4.1 The ledger-lite part waits on the agile-test-repo part

If the coordinator already proposed this link, press **Apply** on its card in
**Needs me** instead, and skip to the checks.

- [ ] Open the **ledger-lite part** (under Ledger export in the rail). Its
      thread has no `… read it by id` line: that pointer is for its agent
      only. Its page has no **Tracker issue…** (Shop has no tracker until
      8.2) and no **Coordinator autonomy** (a work node). Open the page's
      **⋯** menu, choose **Waits on…**, pick `agile-test-repo part` in the
      list that opens, and press **Wait on**.
- [ ] The details panel's **Waits on** section lists
      `waits on agile-test-repo part` with an **Unlink** button.
- [ ] **Dependencies** (sidebar) shows `ledger-lite part` with
      `waits on agile-test-repo part` under it, and that part's status. Click
      either name to open that node.

### 4.2 Open the pull request

- [ ] Open the **agile-test-repo part** and wait until the line under its
      title reads `Agent finished` (its status reads `Ready to merge` and its
      rail dot turns amber, "waiting on you"). **Needs me** has a
      `Ready to merge` card for it with a **Merge** button (the same word as
      the page's). The **Changes** tab shows what it changed against main.
- [ ] The first delivery is yours. In the details panel's **Delivery** section the line reads
      `Ready: stream/… is N commits ahead of main.` and
      `Ship check rules: …` (or `No diff-stage rules in scope.`). Press
      **Merge** at the top of the page.
- [ ] The ship checks run first, then the branch is pushed and a PR opens.
      The panel shows `pushed stream/… to origin; opened PR #N into main: https://github.com/petestewart/agile-test-repo/pull/N`
      and `Delivery: pr · pr open`; the panel's status line reads
      `PR #N into main: no review · CI … · auto-merge enabled. It merges on GitHub.`
      with **Open PR**, and **Check now** replaces **Merge** (it polls the PR
      at once instead of waiting for the next poll). The thread adds the
      pushed line and `auto-merge enabled on PR #N`. **Needs me** has no card
      for the part while its PR is open, and its rail dot is grey. Open the
      link: the PR body carries the goal and an `Issues:` line.
- [ ] If the thread says `GitHub refused auto-merge on PR #N: …; waiting for a human merge`,
      check 2.1 (Allow auto-merge, and the required `changelog` check). The
      node then waits for you to merge on GitHub.

### 4.3 A review comment and a failing check reach the agent

- [ ] **Straight away**, before the agent can fix the check, comment on the
      PR on github.com: `Please add a one-line description at the top of the schema file.`
- [ ] The `changelog` check fails (the goal never mentioned CHANGELOG.md).
      Within about a minute the app polls the PR. The part's **Activity** tab
      shows a `pr review` row and a `ci failed` row, each with its repo, why
      it was routed (`self`) and how it was delivered
      (`delivered to the worker session`, with `in a digest` when several
      events went in one turn, or `pending`). **Check now** on the Delivery
      panel polls at once.
- [ ] On the **Chat** tab the agent reads the failing check, adds a
      CHANGELOG.md line, addresses your comment, commits and pushes (its
      `deliver` verb updates the PR). The check goes green.
- [ ] With the check green and nothing pending, GitHub auto-merges the PR.
      Within about a minute the part's Delivery panel reads
      `Delivery: pr · merged`.
- [ ] Open the **ledger-lite part**: the wait reads
      `waits on agile-test-repo part · satisfied`, and its thread says
      `waits on … satisfied`. The coordinator's **Activity** tab has a
      `child delivered` row.
- [ ] Sync after merge is per repo: when main moves, every other live work
      node **on that repo** gets main merged in. The ledger-lite part is on
      ledger-lite, so it is synced in step 5, when Blog's work merges into
      ledger-lite. Its own merge is the last part of step 5.

## 5. Overlap across projects, waits on, sync, direct merge

The app tracks the files each live work node has changed, in every project.
Two nodes on one repo touching the same file are an **overlap**. Both nodes,
their parents and the repo view show it, and you (or a coordinator) settle it
with a "waits on" link. When one merges, main moves, and every other live
node on the repo is **synced** (main merged in, never rebased).

This step needs no agent. You create the nodes with **Start the agent now** switched off,
and play their agents by committing in their worktrees by hand. The
terminal blocks here are only those commits and a look at the repo. Each
commit is chained with `&&`, so nothing is written if the `cd` fails. A node's worktree is
`<repo>/.worktrees/<node-id>-<slug>`, so the blocks find it by its slug. (The
**Changes** tab shows the full path too.)

After a hand-made commit, the Delivery panel may still say there is nothing
to land for up to a minute (touched files are recomputed every 60 seconds).
Wait, or reload the page: the open node and the project filter are in the
address bar, so a reload comes back to the same node under the same project.
(Back and forward move between the nodes you opened.)

### 5.1 A shared file, merged directly

A Blog node adds `walkthrough-notes.md` to ledger-lite and merges directly.

- [ ] In the rail, Blog's **⋯** → **Show only this project**, then click
      **Needs me** so no node is selected (a new node's parent defaults
      to the open node).
- [ ] Press **New node** in the sidebar (or the `n` key). It reads `In Blog`.
      **What should the agent do?**
      `Add walkthrough-notes.md with a Blog and a Shop section.`, Title
      `Walkthrough notes`, Parent `Top level of Blog`, Repository
      `No repository`, switch **Start the agent now** off, press
      **Create node**. The node's page opens reading `Not started` (its
      **Agent** section says `No sessions yet.`), and the rail shows it under
      Blog with the conversation icon ○.
- [ ] Open **⋯** → **Add repository…**, pick `ledger-lite`, press **Add**. The thread adds
      `repo added: ledger-lite; now a work node on stream/…-walkthrough-notes`,
      the line under the title ends with that branch, the rail icon becomes
      the work icon ●, and no agent starts (it never had one). (Leave the
      form's Repository at `No repository`: a repository picked there is only
      used when an agent starts, and no branch is cut until then.)
- [ ] Commit the file in its worktree:

```zsh
cd ~/Projects/ledger-lite/.worktrees/*-walkthrough-notes && printf '# Walkthrough notes\n\nRun: %s\n\n## Blog\n\n-\n\n## Shop\n\n-\n' "$(date)" > walkthrough-notes.md && git add walkthrough-notes.md && git commit -m "Add walkthrough notes"
cd ~
```

- [ ] The Delivery panel reads
      `Ready: stream/…-walkthrough-notes is 1 commit ahead of main.` Press
      **Merge**. The panel reads `Merged.`, `Delivery: direct · merged` and
      `landed stream/…-walkthrough-notes into main (…)`; the rail dot turns
      green.
- [ ] Check the repo:

```zsh
cd ~/Projects/ledger-lite
git log --oneline -2
git status --short
cd ~
```

- [ ] The log shows the `land …` merge commit on top of
      `Add walkthrough notes`. `git status --short` prints nothing.

### 5.2 Two projects touch the same file

- [ ] Switch the rail to **Shop** (the `Only Blog` chip's ▾ → Shop), click
      **Needs me**, and create `Shop note` as in 5.1: **New node**, Title
      `Shop note`, Goal `Fill in the Shop section of walkthrough-notes.md.`,
      switch **Start the agent now** off, **Create node**, then **⋯** →
      **Add repository…** → `ledger-lite` → **Add**.
- [ ] Switch the rail to **Blog**, click **Needs me**, and create
      `Blog note` the same way (Goal
      `Fill in the Blog section of walkthrough-notes.md.`), with **Add repository…** →
      `ledger-lite` → **Add**.
- [ ] Make one commit in each:

```zsh
cd ~/Projects/ledger-lite/.worktrees/*-shop-note && perl -0pi -e 's/## Shop\n\n-/## Shop\n\n- Shop was here./' walkthrough-notes.md && git commit -am "Shop note"
cd ~/Projects/ledger-lite/.worktrees/*-blog-note && perl -0pi -e 's/## Blog\n\n-/## Blog\n\n- Blog was here./' walkthrough-notes.md && git commit -am "Blog note"
cd ~
```

- [ ] Two commits, `Shop note` and `Blog note`, one line changed each.

Touched files are recomputed after every agent edit and commit, and every 60
seconds. Wait a minute, then:

- [ ] Show all projects (the chip's **×**). Shop note and Blog note carry the
      ⚠ overlap mark, and so do their project roots, Shop and Blog.
- [ ] **Repos** (sidebar) shows the `ledger-lite` card (`Merges directly`)
      with both live nodes, their project greyed (`Shop › Shop note`,
      `Blog › Blog note`), and a warning:
      `Shop note and Blog note both changed walkthrough-notes.md`.
- [ ] Open Shop note: its **Changes** tab shows the one-line change and the
      worktree path, and its **Activity** tab has
      `overlap · ledger-lite · party · pending`. (`pending` means no session
      is attached to take it; a live agent gets it at once.)

### 5.3 Settle it with "waits on"; sync; merge

- [ ] On Shop note's page open **⋯** → **Waits on…**, pick `Blog note`, press **Wait on**.
      The page lists `waits on Blog note`, and **Dependencies** shows
      Shop note `waits on Blog note`.
- [ ] Press **Merge** on Shop note. It is held: the panel shows
      `delivery held: waits on Blog note`, and so does the thread.
- [ ] Open Blog note and press **Merge**. It reads `Merged.`
- [ ] Open Shop note again. Its thread now ends with
      `synced main into stream/…-shop-note` and `waits on … satisfied`, and
      the wait reads `waits on Blog note · satisfied`. Press **Merge**: it
      reads `Merged.` and `landed stream/…-shop-note into main (…)`.
- [ ] Check the file:

```zsh
cd ~/Projects/ledger-lite
cat walkthrough-notes.md
git status --short
cd ~
```

- [ ] `walkthrough-notes.md` has both lines. `git status --short` prints
      nothing. The ⚠ marks are gone from the rail (merged nodes are no
      longer live), and **Repos** shows the `Main changed` and `Merged`
      events under ledger-lite's **Recent events** (a direct merge reads
      `Merged`; `PR merged` is for a merged PR).

### 5.4 **[vendor]** Back to the ledger-lite part

The merges above moved ledger-lite's main, so the Shop ledger-lite part from
step 3 was synced too. (A part in the middle of a turn, or with uncommitted
changes, is synced at the end of its turn.)

- [ ] Open the ledger-lite part (under Ledger export). Its **Activity** tab
      has `main changed · ledger-lite · same repo` rows, and its thread shows
      `synced main into stream/…`.
- [ ] When the line under its title reads `Agent finished`, press **Merge**. Its
      wait is satisfied, the ship checks pass, and it lands on ledger-lite's
      main in one click: `Merged.` The coordinator's **Activity** tab gets a
      second `child delivered` row, and its **Children** cards read done.
- [ ] Check the repo:

```zsh
cd ~/Projects/ledger-lite
git log --oneline -3
git status --short
cd ~
```

- [ ] The top commit is `land stream/…-ledger-export into main (…)`.
      `git status --short` prints nothing: the app wrote nothing else into the
      repo.

## 6. Knowledge

Knowledge is what agents need to know, in three kinds: **standard** (how we
work), **architecture** (what exists and where) and **decision** (a choice
for some piece of work). Each item has a **scope**
(`global`, `repo:<name>`, `project:<id>`, `subtree:<node>`, optionally
narrowed to paths), and scopes stack. Each item also has an **enforcement**:

| Enforcement (as the screen says it) | What happens |
|---|---|
| tell (**Guidance**) | The item is in the agent's brief, and arrives as an event when accepted |
| action (**Checked on every action**) | Checked before each command or edit (a pattern or the classifier); blocked with the item named |
| ship (**Checked before merge**) | The classifier checks the whole diff before a merge or PR; a violation holds the delivery |
| review (**Reviewer checklist**) | On the reviewer agent's checklist before shipping |

A **rule** is an enforced item (action or ship), whatever its kind. Every
item starts `proposed`: you add one, an agent proposes one, or the lessons
pass proposes one after a merge. Nothing applies until you accept it. Items
live in the home, never in your repos. The **Knowledge** screen (sidebar)
says so under its title and splits them into tabs: **All**, **To review**
(the proposals, with a count), **Rules**, **Standards**, **Architecture** and
**Decisions**; retired items fold under **Retired** at the bottom of a list.
Search, **Any scope** and **Any enforcement** narrow any tab. A click on a
row opens the item's side panel.

### 6.1 The classifier key

Ship and classifier action checks need the TypeSafe key. Use **one** of these:

- **Settings (preferred):** **Settings** → **Classifier** → "TypeSafe API
  key" → paste the key into `Paste a key` → **Save key**. It takes effect at
  once, and the field is never filled back in.
- **Environment:** `TYPESAFE_API_KEY` exported in the shell that runs
  `agile daemon start`.

- [ ] Next to "TypeSafe API key" the status reads `Key set` (or
      `Key set · from the environment`). `No key` means neither is set.

### 6.2 Add, accept and test a ship check

- [ ] **Knowledge** → **Add knowledge**. The form opens in the side panel,
      in three groups. Fill in:
      - *What*: Kind **Standard**; What agents should know:
        `Every change to a file under src/ comes with a test that exercises it`;
        Name: `tests-with-src`
      - *Where*: Applies to `Repo: ledger-lite` (the picker lists repos,
        projects and nodes by name); leave Only these paths empty
      - *How it's enforced*: **Checked before merge**. The classifier's
        fields appear: leave Question and Yes/No means empty, press **Add
        example** twice. First example:
        `diff changes src/ledger.ts and adds no test`, **Violates** ticked.
        Second: `diff changes src/ledger.ts and test/ledger.test.ts`,
        **Violates** unticked.
- [ ] Press **Propose**. A new row appears under **To review** with its name
      (`tests-with-src`), `Standard · Repo ledger-lite`, the badge
      `Checked before merge`, and **Accept** / **Retire**. The side panel
      shows it: `Proposed`, Source `Added by you`, the default question
      `Does this change violate: Every change …?`, and **Accept**, **Retire**,
      **Edit**, **Test examples**. **Needs me** also has a `Standard proposed`
      card for it, saying where it applies (`Applies to the ledger-lite
      repo`) with **Open in Knowledge**.
- [ ] Press **Accept** (on the row, or in **Needs me**). The row moves under
      **Rules**; its panel reads `Accepted`. **Repos** → ledger-lite now lists
      it under the repo's **Norms**:
      `tests-with-src`, `Standard`, `Checked before merge`, `Not fired yet`.
- [ ] Open it again and press **Test examples** (it is greyed out without a
      key, with "Set one in Settings" under it). After a few seconds the
      examples are replaced by the results: `2 of 2 examples agree`,
      `Asked: Does this change violate: …?`, and one row per example:
      `Agrees diff changes src/ledger.ts and adds no test — expected Block, got Block (p 0.9…)`
      and `… — expected Allow, got Allow (p 0.3…)`. **Ask you** is the
      middle band, not a failure. An `an error: …` row with a 529 means
      TypeSafe was busy: press it again.

### 6.3 A delivery held by the ship check, then fixed

Again no agent: you play it.

- [ ] Rail → only **Blog** → **Needs me** → **New node**: Title
      `Ledger count`, Goal `Add a count function in src/ledger-count.ts.`,
      switch **Start the agent now** off, **Create node**. Then **⋯** → **Add repository…** →
      `ledger-lite` → **Add**.
- [ ] Commit the function with no test:

```zsh
cd ~/Projects/ledger-lite/.worktrees/*-ledger-count && mkdir -p src && printf '// %s\nexport function count(xs: number[]): number {\n  return xs.length;\n}\n' "$(date)" > src/ledger-count.ts && git add src/ledger-count.ts && git commit -m "Add count"
cd ~
```

- [ ] The Delivery panel lists `Ship check rules: tests-with-src`. Press
      **Merge**. It is held: the line under the panel, in the neutral
      (news) colour, not error red, reads
      `delivery held by ship check tests-with-src: Every change to a file under src/ comes with a test that exercises it (probability 0.8…)`,
      and the panel reads `Delivery: direct · held` (the reason is on that
      line, once; opened later, the Delivery line carries it).
      On a live node the findings go back to the worker to fix; they come to
      you only if the check is unsure or the worker disputes them. (The
      classifier is not deterministic: in one of five runs here it allowed
      this diff and the node landed at once. If that happens, note it and
      skip the rest of 6.3.)
- [ ] Add the test:

```zsh
cd ~/Projects/ledger-lite/.worktrees/*-ledger-count && mkdir -p test && printf "// %s\nimport { expect, test } from 'bun:test';\nimport { count } from '../src/ledger-count';\n\ntest('count', () => {\n  expect(count([1, 2, 3])).toBe(3);\n});\n" "$(date)" > test/ledger-count.test.ts && git add test/ledger-count.test.ts && git commit -m "Test count"
cd ~
```

- [ ] Press **Merge** again. The panel reads `Merged.`,
      `Delivery: direct · merged` and
      `landed stream/…-ledger-count into main (…)`.

### 6.4 **[vendor]** A decision reaches a node as an event

- [ ] Rail → only **Shop** → **Needs me** → **New node**: Title
      `Cents check`, Goal
      `Read ledger-lite and tell me how it stores amounts. Then wait: I may send you a decision about this.`,
      leave **Start the agent now** on (it names the model it will use:
      `claude-opus-5-5 · claude · low effort` unless Settings says
      otherwise), **Create node**. A session appears in its
      session list (`claude/… · low · starting`, then `running`), and the
      rail icon is the conversation icon ○.
- [ ] Wait for its first answer on the **Chat** tab. Its turn has ended,
      so its session ends too (`Turn finished`).
- [ ] **Knowledge** → **Add knowledge**: Kind **Decision**, What agents
      should know `Amounts in exported JSON are integer cents, never floats`,
      Applies to `Project: Shop`, **Guidance**, **Propose**. Then **Accept**
      it (on its row under **To review**, or on the `Decision proposed` card
      in **Needs me**).
- [ ] Back on Cents check: accepting the decision woke it (a Shop
      conversation whose turn ended is woken by an accepted item, D36). Its
      **Chat** tab has `woken by knowledge accepted` and a new session;
      its **Activity** row reads
      `knowledge accepted · … · delivered to the worker session`, and its
      reply reacts to it ("new decision in scope: …"). A Blog node never
      gets it.
- [ ] Its **Knowledge** tab lists the global items and the new
      decision (`K-… · project:Shop · decision · tell`), and nothing scoped
      to Blog.

## 7. **[vendor]** The Director

The Director sits above every project. It sees all projects, repos, norms,
overlaps and waits, answers "what needs me today?" from a live snapshot, and
can set up work. Its level is per project, with the same three levels as
coordinators: at **advise** (the default) its changes are drafts you create
with one click; at **organise** it creates and starts nodes and adds waits on
its own, and tells you; at **run** it may also restart stuck work. A
brand-new project is always a draft, whatever the level. It never merges,
accepts knowledge, or answers a question as you. Every action is recorded as
done by `director`.

### 7.1 What needs me today?

- [ ] **Director** (sidebar). The page is a chat, like a node's. The line
      under the heading reads `Not started — your first message starts it.`,
      and the empty chat suggests what to ask.
- [ ] Type `What needs me today?` in `Ask the Director…` and press Enter.
      The line becomes `<model> · Working`, and your message is on the chat
      as a bubble on the right.
- [ ] Within a minute or two its reply lands on the thread: the inbox first,
      then stuck nodes, overlaps and open waits, taken from the snapshot, not
      memory. The **Details** panel's **Activity** lists a `Director request`
      row per message you sent.

### 7.2 Advise: a draft tree with Create

- [ ] On **Director**, send:
      `Blog needs a CHANGELOG.md in ledger-lite listing the last five commits. Draft the work for me.`
- [ ] A card (`A draft waits on you`) appears at the end of the chat with
      the draft as a tree (Blog, the new node with its goal, its parts
      `on ledger-lite`, and any `waits on`), with **Create** and **Dismiss**.
      Nothing has been created yet.
- [ ] Press **Create**. The nodes appear under Blog in the rail, not started.

### 7.3 Organise: the Director starts the work itself

The Director's level is per project, on the project root's page (next to
its **Coordinator autonomy** picker, which sets the coordinator's level
only).

- [ ] In the rail click **Blog** (the project root). Set **Director
      autonomy** to `organise`.
- [ ] Or, on the CLI:

```zsh
BLOG=$(agile project list --json | jq -r '.[] | select(.name=="Blog") | .id')
agile project set $BLOG --director-autonomy organise
agile project show $BLOG
```

  `project show` reads `autonomy    coordinator=advise director=organise`.
- [ ] On **Director**, send `Go ahead with the changelog: start it now.`
- [ ] The Director starts the changelog node's agent itself, with no card,
      and posts what it did on its thread. **Running** lists the node, and
      the node's page reads `Agent working` (or `Agent finished` later).
- [ ] Send `Merge the changelog when it is done.` The Director refuses:
      merging is yours. When the node reads `Agent finished`, press **Merge** on
      its page.

## 8. Trackers: Jira or Linear

Any node may link to one external issue. Linking pulls the issue's title and
description into the node's goal, and later edits arrive as events. A node
with no link **rolls up** to its nearest linked ancestor: its PR mentions that
issue, and the linked node shows how many of the nodes under it have merged.
Status push (in progress, in review, done) is off until you turn it on per
project. The app never closes an issue or edits its text.

### 8.1 **[vendor]** The token

In Jira, create an API token (Atlassian account → Security → API tokens).

- [ ] **Settings** → **Trackers** → the **Jira** card. Fill in the **Site
      URL** (`https://your-site.atlassian.net`: **change it** to your Jira
      site), the **Email** (**change it** to your Atlassian email), paste the
      token into `Paste a token`, and press **Save**.
- [ ] The card reads `Token set`; the token field empties and is never
      filled back in. **Remove token** removes it (after asking).

Using Linear instead: paste a personal API key in the **Linear** card and
press **Save**, then use `linear` wherever 8.2 says `jira`.

### 8.2 The project's tracker settings

The project's tracker, status push and status map are on the project
root's page.

- [ ] In the rail click **Shop** (the project root). Under the pickers, set
      **Tracker** to `Jira`, tick **push status**, fill **In progress**
      `In Progress`, **In review** `In Review`, **Done** `Done`, and press
      **Save tracker**.
- [ ] Or, on the CLI:

```zsh
SHOP=$(agile project list --json | jq -r '.[] | select(.name=="Shop") | .id')
agile project set $SHOP --tracker jira --push-status on --status-map "in_progress=In Progress,in_review=In Review,done=Done"
agile project show $SHOP
```

- [ ] Either way, the root page shows those values, and `project show` reads
      `tracker     jira push_status=on status_map=in_progress=In Progress,in_review=In Review,done=Done`.
      The names on the right must match your Jira workflow's status names
      (`key=` with nothing after it clears one phase).

### 8.3 **[vendor]** Link an epic, import its children

You need one **epic** in Jira with at least one child issue, and its first
child should be a small task an agent can do in agile-test-repo (for example
"Add TRACKER.md with one line saying this repo is linked to Jira").

- [ ] Rail → only **Shop** → **Needs me** → **New node**: Title
      `Tracker epic`, Goal `Placeholder until linked`, switch
      **Start the agent now** off, **Create node**.
- [ ] On its page press **Tracker issue…** (it shows because Shop has a
      tracker since 8.2), type the epic's key in the **Issue key** field
      (placeholder `SHOP-11`; **change it** to your epic's key, such as
      `SHOP-10`) and press the **Link** button beside it.
- [ ] The page reads `Linked to <key> (jira)` with **Unlink** and
      **Import children**. The goal under the title is now the epic's
      title, then `From jira issue … (https://…/browse/…)` and its
      description.
- [ ] Press **Import children**. One node per child issue appears under
      Tracker epic in the rail, each linked to its issue, and the link line
      gains `· 0/N merged`.
- [ ] Press **Import children** again. Nothing new appears: importing is
      idempotent.

### 8.4 **[vendor]** Work on a linked issue; status push; roll-up in the PR

- [ ] Open the first imported child (its page reads `Linked to <child key> (jira)`).
      Open **⋯** → **Add repository…** → `agile-test-repo` → **Add**, then press
      **Start agent**: one click starts it with the defaults (the composer's
      chip names them: `Claude Opus 5.5 · low`; the chevron beside
      **Start agent** picks another model).
- [ ] A `worker` session appears in its session list and starts work in the
      new worktree. In Jira the child issue moves to **In Progress**.
- [ ] Edit the child issue's description in Jira. Within five minutes the
      child's **Activity** tab has an `external changed` row and the agent is
      told.
- [ ] When the page reads `Agent finished`, press **Merge**. The PR body's
      `Issues:` line links the child issue. In Jira the issue moves to
      **In Review** and gains a link to the PR.
- [ ] The `changelog` check from 2.1 fails first, and the agent fixes it as
      in step 4. After auto-merge the issue moves to **Done**, and the
      Tracker epic page reads `1/N merged`.
- [ ] An unlinked node under the epic node rolls up the same way: its PR's
      `Issues:` line names the epic.

### 8.5 **[vendor]** Create an issue from a node

- [ ] Open **Tracker epic** and press **New node** (the Parent defaults to
      the open node, Tracker epic; its **+** in the rail does the same).
      Title `Tracker follow-up`, Goal
      `Note in TRACKER.md how issues are linked.`, switch
      **Start the agent now** off, **Create node**.
- [ ] On Tracker follow-up's page press **Tracker issue…**, leave the
      **Issue key** field empty and press **Create issue**. A new issue is created in the epic's Jira project, as a
      child of the epic, from the node's title and goal. The node reads
      `Linked to …`, and its goal is kept. This creates a real issue: delete it
      in Jira afterwards if you don't want it. (On a node with no linked
      ancestor, type the project key, such as `SHOP`, in the Issue key field
      first.)

## 9. Day to day: inbox, logs, stop and start, troubleshooting

### 9.1 What is going on

- [ ] **Needs me** is everything waiting on you, grouped by project, then
      node, oldest first. Each card says what it is (`Question`,
      `Allow this action?`, `Approve this merge?`, `Plan to approve`,
      `Coordinator proposal`, `… proposed`, `Ready to merge`, `Blocked`,
      `Waiting for the plan`) and how long it has waited (hover for the
      time). A long card has **Show more**; **Open** (or the node's name above
      it) opens its node. The filter narrows it to **Questions**,
      **Decisions** or **Merges**; `j`/`k` move between cards and Enter opens
      one's node. The badge on **Needs me** counts them. With nothing
      waiting it reads `You’re all caught up`.
- [ ] The rail's dots say who must act: amber waiting on you, blue agent
      working, grey idle, green landed, red blocked (hover a row to read it;
      the **?** next to *Projects* explains every dot and icon). A node whose
      agent never ran has a dashed ring and a faded title.
      The filter box (`Filter nodes…`, or the `/` key) narrows the tree
      by title. **Running** lists the nodes with a live agent.
- [ ] A node you no longer need: its **⋯** → **Delete…** → **Delete**. It
      and the nodes under it leave the rail and their agents stop (branches
      and worktrees stay). **Undo** in the toast, or **Deleted (n)** below the
      tree → **Restore**, brings them back. A project's root has no Delete.
- [ ] A node's **Activity** tab is what woke it and why: one row per routed
      event with its type, `[repo]`, why it was routed (self, ancestor,
      waits on, same repo, party, sibling), the delivery status
      (`delivered to the worker session`, `pending`, `superseded` or
      `expired`, with `in a digest` when several went in one turn) and when
      (`YYYY-MM-DD HH:MM`, local time; hover a row for the session id and the
      full time). A node with none says `No events routed here yet.`
- [ ] **Events** (sidebar) lists every routed event across projects, newest
      first under a day heading: what happened, the node it is about, and
      who it was routed to and why (a chip per node). The type buttons, the
      repo list and the search narrow it.
- [ ] Press **Ctrl K** (**⌘K** on a Mac), type part of a node's title and
      press Enter: its page opens. With nothing typed the palette lists the
      nodes you opened last. Type `Knowledge` and press Enter: Knowledge
      opens. Press **?** (not in a text box): the keyboard shortcuts; Esc
      closes them. **g** then **i** goes to Needs me.
- [ ] **CLI only:** the raw event log (every event, not only routed ones):
      `agile tail | tail -20`, `agile tail --follow` to keep watching (Ctrl-C
      to stop), `agile tail --kind thread_appended` for one kind.

### 9.2 Stop and start

- [ ] **CLI only:**

```zsh
agile daemon stop
agile daemon status
agile daemon start
agile daemon status
```

- [ ] `stop` prints `agiled stopped: pid=…`; `status` then says
      `agiled is not running`, and the cockpit's sidebar shows
      `reconnecting…` instead of `live`. After `start` it reconnects with every
      node, thread and event intact. Stopping the daemon stops every agent
      session: open a node that was mid-work and press **Restart agent** (or
      just send it a message: that starts it again).

### 9.3 Where things live

- Why a session ended: the node page's session list shows it after the
  session's status when it was not a normal end; a normal end is
  `Turn finished` on the thread. Two or more
  ended sessions fold into one `N earlier sessions` row: click it to show
  them. Live sessions are always shown.
- A node's worktree and branch: the line under its title (branch; a click
  copies it) and the **Changes** tab (worktree path). Worktrees are
  `<repo>/.worktrees/<node-id>-<slug>` on `stream/…` branches.
- Daemon log: `tail -50 ~/.agile-walkthrough/log/agiled.log`
- Event log: `~/.agile-walkthrough/log/events.jsonl`
- A vendor session's stderr: one directory per session under
  `~/.agile-walkthrough/sessions/`, each with `stderr.log`:
  `ls -t ~/.agile-walkthrough/sessions | head -5`
- Nodes, threads, projects, knowledge: `streams/`, `threads/`, `projects/`,
  `knowledge/` in the home.

### 9.4 Troubleshooting

- **Port 4600 in use.** `agile daemon start` prints
  `agiled did not start: agiled cannot listen on 127.0.0.1:4600: address in use`,
  names the pid holding it, and says whether it looks like another agiled
  (usually a daemon from another home). Stop that home's daemon
  (`AGILE_HOME=~/.agile-phase7 agile daemon stop`, as in 1.3), or stop
  whatever holds the port:

```zsh
lsof -nP -iTCP:4600 -sTCP:LISTEN
kill $(lsof -tiTCP:4600 -sTCP:LISTEN)
agile daemon start
```

  To run two homes at once, give one a different `port:` in its
  `config.yaml`, or set `AGILE_PORT` for its terminal.
- **Stale daemon** (it crashed, or the Mac slept badly). The cockpit shows
  `reconnecting…`. `agile daemon status` says `agiled is not running` and
  `agile daemon start` clears the old pidfile and starts cleanly. If
  `status` says running but the cockpit does not load, `agile daemon stop`,
  then `agile daemon start`. If stop hangs:
  `kill $(cat ~/.agile-walkthrough/agiled.pid)`, then start.
- **`permission denied: agile`.** The CLI entry lost its executable bit
  (usually after a `git checkout` or `git pull`). Fix it:

```zsh
chmod +x ~/agile-agents/packages/cli/src/index.ts
agile daemon status
```

- **`AGILE_HOME` points at a file.** Every command refuses with one line
  naming the variable and the path. Point it at a directory.
- **An agent never starts, or stops at once.** Look at the node's session
  list (the ended reason) and its `stderr.log` (9.3). Creating a node on, or
  adding, a repo whose main has no commits is refused up front: make an
  initial commit first.
- **A delivery refuses.** The Delivery panel says why: held by a ship check
  (the item is named), waits on another node, a merge conflict (the panel
  lists the files; **Resolve** starts a worker to fix them), `main is checked out with
  uncommitted changes` (clean the repo's checkout), or nothing to deliver.
- **`push … to origin failed: git has no working credentials for origin`.**
  Run `gh auth setup-git` (2.1), then press **Merge** again. The panel reads
  `held` until then.
- **The Director's thread repeats `director attached` and never answers.**
  Its vendor session dies as it starts (a Claude Code login problem, most
  likely), and the daemon starts another at once. Stop the daemon, read the
  newest `stderr.log` (9.3), fix the login, start again.
- **A PR's state looks stale.** An open PR is polled about once a minute
  (every 15 seconds while its agent is fixing something, every 5 minutes
  after an hour with no change). `gh auth status` must be logged in.
  **CLI only:** `agile daemon status` says `GitHub auth: available`.
- **Start over:** 1.3, then 1.4.

### Not in the cockpit yet

These steps have no cockpit control, so they stay on the CLI:

- The raw event log, including events routed to no node (9.1): `agile tail`.
  (**Events** in the sidebar lists the routed ones.)
- Stopping and starting the daemon (9.2), and whether GitHub auth is
  available (9.4): `agile daemon stop|start|status`.
- A pull request's full state as JSON: `agile node show <id> --json`
  (`.delivery_state.pr`). The Delivery panel shows the open PR's review, CI
  and auto-merge on one line, and the **Activity** tab has the `pr review`
  and `ci failed` rows.

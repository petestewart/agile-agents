# LIVE-CHECKLIST: the walkthrough of Phases 7–13

This is the end-to-end walkthrough of the app as of `claude/phase-13`. It
teaches the app as it goes and follows `PLAN.md` §6.1: projects, + Repo,
delivery by pull request and direct merge, overlaps, knowledge, the Director
and tracker links. It uses the two repos on your Mac,
`~/Projects/ledger-lite` (direct merge) and `~/Projects/agile-test-repo`
(pull requests on https://github.com/petestewart/agile-test-repo).

How to use it:

- Paste each block as it is. Every block not marked **[vendor]** was run as
  pasted in a scratch home before it was written down.
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

You don't have to restructure the tree to change where work happens. **+ Repo** on a conversation turns
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
| Left rail | Project switcher (**All projects**, Shop, Blog), **New project**, the tree with a role icon per node and a ⚠ mark on overlapping nodes, a filter |
| Top bar | Quick capture (one line becomes a node), **New stream (n)**, and the views below |
| **Needs me** | The inbox, grouped by node: questions (answer inline), gates (Approve/Deny), knowledge proposals (Accept/Retire), plans (**Approve plan**), coordinator and Director proposals (**Apply**/**Dismiss**), finished work (**Land**) |
| **Repos** | Per repo: its delivery mode, the live work nodes on it across projects (ancestors greyed), overlaps, its norms, recent repo events |
| **Running** | Nodes with a live agent |
| **Dependencies** | Every "waits on" link, across projects |
| **Knowledge** | Every knowledge item: filters, Accept/Retire, Edit, Test examples |
| **Director** | The Director's thread and composer, its **Drafts** (Create/Dismiss), its activity |
| **Settings** | Who decides, the TypeSafe API key, Trackers (Jira, Linear), session defaults, repos (add, delivery, visibility) |
| A node's page | Title, role, "Needs you", sessions with **Start/Restart**, **Review**, **Stop**, **Close**, **Link** (waits on), **+ Repo**; the tracker link (**Link**, **Create issue**, **Import children**); **Coordinator autonomy**; the **Delivery** panel (**Merge**, Resolve); children's status cards; tabs **Thread**, **Diff**, **Activity**, **Plan**, **Knowledge in scope**, **Docs** |

### The CLI

`agile` with no arguments prints every command. The ones this walkthrough
uses: `init`, `daemon start|stop|status`, `repo add|set|list`,
`project new|list|show|set`, `node new|list|show|say|add-repo|wait|link|import-children|set`,
`deliver`, `attach`, `knowledge add|show|accept|list|test`, `director say`,
`tracker set|status`, `inbox`, `answer`, `status` and `tail`. Every verb takes
`--json`.

## 1. Install, a fresh home, start

### 1.1 Build and install `agile`

- [ ] Build `claude/phase-13` and put `agile` on your PATH. The block assumes
      the checkout is at `~/agile-agents`.

```zsh
cd ~/agile-agents
git checkout -- packages/cli/src/index.ts
git fetch origin
git checkout claude/phase-13
git pull origin claude/phase-13
bun --version
bun install
bun run build
cd packages/cli
bun link
cd ~/agile-agents
which agile
```

`bun --version` must be 1.3.11 or newer. `which agile` prints
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
git pull origin claude/phase-13
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
- [ ] `knowledge list` shows the three built-in items: `no_push_protected`
      and `path_deny` (accepted, `action:pattern!`) and `no_push` (retired).
- [ ] Open the cockpit: `open http://127.0.0.1:4600/`. **Needs me** is empty.

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
- [ ] Cockpit → **Settings** → Repos shows the same, with a Delivery and a
      Visibility picker per repo. **Private** visibility limits reading a
      repo to the projects you list; leave both public.

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

- [ ] Each `project new` prints `P-…  Shop  root=…`. `project list` shows
      Shop (`ledger-lite,agile-test-repo`) and Blog (`ledger-lite`).
- [ ] `project show` prints the name, root, repos,
      `autonomy    coordinator=advise director=advise` and `tracker     -`.
- [ ] `node list` shows the two roots, Shop and Blog.
- [ ] Cockpit: the rail's switcher offers **All projects**, Shop and Blog;
      picking Shop hides Blog's nodes.

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
**Coordinator autonomy** picker on the project root's page. On any other node
the picker (or `agile node set $C --autonomy organise`, and `inherit` to go
back) overrides the project.

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

Press **+ Repo** on the node's page and pick ledger-lite, then agile-test-repo,
or paste:

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
- [ ] `node list --parent` shows both parts with role `work`. Both parts
      start their own worker, and the coordinator keeps the chat. The thread
      gains `repo added: …; now a work node on …` and
      `repo added: agile-test-repo; now coordinating ledger-lite part, agile-test-repo part`.
- [ ] Cockpit: the rail shows Ledger export with the coordinating icon and
      its two parts under it. **Running** lists the coordinator and both parts.

### 3.4 Approve the plan and the contract

Tell the coordinator to go ahead. Type on its thread, or paste:

```zsh
SHOP=$(agile project list --json | jq -r '.[] | select(.name=="Shop") | .id')
C=$(agile node list --project $SHOP --json | jq -r '.[] | select(.title=="Ledger export") | .id')
agile node say $C "Go ahead. Write the plan and a contract for the JSON shape of one ledger entry, then let the parts work from them."
agile inbox
```

- [ ] Within a few minutes the coordinator writes a **plan** (which part owns
      which paths) and a **contract** (the JSON shape both parts rely on).
      **Needs me** shows an **Approve plan** card on Ledger export whose text
      names the owners and the contracts. `agile inbox` lists it too.
- [ ] The node's **Plan** tab shows `Plan v1 · draft`, the owners, and each
      contract's body.
- [ ] Press **Approve plan**. The tab reads `Plan v1 · approved by human`.
      Each part is told its paths (`plan_changed` in the part's **Activity**
      tab), and each part's brief now carries its owned paths and the
      contract.
- [ ] While the parts work, the coordinator's page shows a status card per
      child (what it is doing, files touched, done or blocked). If a part
      wants to change the contract, it proposes the change to the parent; at
      advise you get a **proposal** card (Apply/Dismiss) and the change shows
      as one line in the coordinator's **Activity**.
- [ ] Questions from any agent appear in **Needs me**. Answer inline, or with
      `agile answer` and the `Q-…` id from `agile inbox`.

## 4. **[vendor]** Delivery: a pull request that looks after itself

The agile-test-repo part delivers by pull request, with auto-merge on. The
ledger-lite part delivers by direct merge, but only after the schema is
merged, so it **waits on** the other part.

### 4.1 The ledger-lite part waits on the agile-test-repo part

Paste this (or press **Link** on the ledger-lite part's page, pick
`agile-test-repo part`, then **Wait on**). If the coordinator already proposed
the same link, Apply its card instead.

```zsh
SHOP=$(agile project list --json | jq -r '.[] | select(.name=="Shop") | .id')
C=$(agile node list --project $SHOP --json | jq -r '.[] | select(.title=="Ledger export") | .id')
P1=$(agile node list --parent $C --json | jq -r '.[] | select(.repo=="ledger-lite") | .id')
P2=$(agile node list --parent $C --json | jq -r '.[] | select(.repo=="agile-test-repo") | .id')
agile node wait $P1 --on $P2
agile node show $P1 --json | jq -r '.waits_on[] | .node + "  " + (.satisfied_at // "open")'
```

- [ ] `node wait` prints `… waits on …`; the second line prints P2's id and
      `open`. **Dependencies** shows the edge; the part's page lists
      `waits on agile-test-repo part`.

### 4.2 Open the pull request

Watch the agile-test-repo part until its agent is done (the rail, or
`agile node show $P2 --json | jq -r .agent.status` reads `done`). The first
delivery is yours: press **Merge** in its Delivery panel, or:

```zsh
SHOP=$(agile project list --json | jq -r '.[] | select(.name=="Shop") | .id')
C=$(agile node list --project $SHOP --json | jq -r '.[] | select(.title=="Ledger export") | .id')
P2=$(agile node list --parent $C --json | jq -r '.[] | select(.repo=="agile-test-repo") | .id')
agile deliver $P2
agile node show $P2 --json | jq -r '.delivery_state.status, .delivery_state.pr.url, .delivery_state.pr.auto_merge'
```

- [ ] The ship checks run first (see the Delivery panel's
      `Ship check rules: …` line), then the branch is pushed and a PR opens.
      Status `pr_open`, the PR URL, and auto-merge `enabled`. The PR body
      carries the goal and an `Issues:` line.
- [ ] If auto-merge reads `unavailable`, GitHub refused it: check 2.1 (Allow
      auto-merge, and the required `changelog` check). The node then waits for
      you to merge on GitHub.

### 4.3 A review comment and a failing check reach the agent

- [ ] **Straight away**, before the agent can fix the check, comment on the
      PR on github.com: `Please add a one-line description at the top of the schema file.`
- [ ] The `changelog` check fails (the goal never mentioned CHANGELOG.md).
      Within about a minute the app polls the PR, and the node's **Activity**
      tab shows a `pr_review` and a `ci_failed` event routed to the part,
      with how each was delivered (to the live session, or in a digest when
      it woke).

```zsh
SHOP=$(agile project list --json | jq -r '.[] | select(.name=="Shop") | .id')
C=$(agile node list --project $SHOP --json | jq -r '.[] | select(.title=="Ledger export") | .id')
P2=$(agile node list --parent $C --json | jq -r '.[] | select(.repo=="agile-test-repo") | .id')
agile tail --node $P2 --events
agile node show $P2 --json | jq -r '.delivery_state.pr.review, .delivery_state.pr.checks'
```

- [ ] `tail --node … --events` prints one row per routed event: time, type,
      why it was routed (`because self`), delivery status and the event id.
- [ ] The agent reads the failing check, adds a CHANGELOG.md line, addresses
      your comment, commits and pushes (its `deliver` verb updates the PR).
      The check goes green.
- [ ] With the check green and nothing pending, GitHub auto-merges the PR.
      Within about a minute:

```zsh
SHOP=$(agile project list --json | jq -r '.[] | select(.name=="Shop") | .id')
C=$(agile node list --project $SHOP --json | jq -r '.[] | select(.title=="Ledger export") | .id')
P1=$(agile node list --parent $C --json | jq -r '.[] | select(.repo=="ledger-lite") | .id')
P2=$(agile node list --parent $C --json | jq -r '.[] | select(.repo=="agile-test-repo") | .id')
agile node show $P2 --json | jq -r '.delivery_state.status, .human.status'
agile node show $P1 --json | jq -r '.waits_on[] | .node + "  " + (.satisfied_at // "open")'
```

- [ ] P2 reads `merged`. P1's wait now has a `satisfied_at` time, and P1's
      thread says `waits on … satisfied`. The coordinator's **Activity**
      shows the child's delivery (`child_delivered`).
- [ ] Sync after merge is per repo: when main moves, every other live work
      node **on that repo** gets main merged in. P1 is on ledger-lite, so it
      is synced in step 5, when Blog's work merges into ledger-lite. Its own
      merge is the last part of step 5.

## 5. Overlap across projects, waits on, sync, direct merge

The app tracks the files each live work node has changed, in every project.
Two nodes on one repo touching the same file are an **overlap**. Both nodes,
their parents and the repo view show it, and you (or a coordinator) settle it
with a "waits on" link. When one merges, main moves, and every other live
node on the repo is **synced** (main merged in, never rebased).

This step needs no agent. The nodes use `--no-start`, and you play their
agents by committing in their worktrees by hand. Blocks that `cd` into a
worktree are chained with `&&`, so nothing is written if a lookup fails.

### 5.1 A shared file, merged directly

A Blog node adds `walkthrough-notes.md` to ledger-lite and merges directly.
This is also what the one-click **Merge** does on a direct repo.

```zsh
BLOG=$(agile project list --json | jq -r '.[] | select(.name=="Blog") | .id')
N0=$(agile node new --project $BLOG --title "Walkthrough notes" --goal "Add walkthrough-notes.md with a Blog and a Shop section." --no-start --json | jq -r .id)
agile node add-repo $N0 ledger-lite
W=$(agile node show $N0 --json | jq -r .worktree)
cd $W && printf '# Walkthrough notes\n\nRun: %s\n\n## Blog\n\n-\n\n## Shop\n\n-\n' "$(date)" > walkthrough-notes.md && git add walkthrough-notes.md && git commit -m "Add walkthrough notes"
cd ~
agile deliver $N0
cd ~/Projects/ledger-lite
git log --oneline -2
git status --short
cd ~
```

- [ ] `add-repo` makes the node a work node on `stream/…-walkthrough-notes`
      and does not start an agent (it never had one).
- [ ] `deliver` prints `landed stream/…-walkthrough-notes into main (…)`, and
      the log shows the `land …` merge commit on top of `Add walkthrough notes`.
      `git status --short` prints nothing.

### 5.2 Two projects touch the same file

```zsh
SHOP=$(agile project list --json | jq -r '.[] | select(.name=="Shop") | .id')
BLOG=$(agile project list --json | jq -r '.[] | select(.name=="Blog") | .id')
S=$(agile node new --project $SHOP --title "Shop note" --goal "Fill in the Shop section of walkthrough-notes.md." --no-start --json | jq -r .id)
B=$(agile node new --project $BLOG --title "Blog note" --goal "Fill in the Blog section of walkthrough-notes.md." --no-start --json | jq -r .id)
agile node add-repo $S ledger-lite
agile node add-repo $B ledger-lite
W=$(agile node show $S --json | jq -r .worktree)
cd $W && perl -0pi -e 's/## Shop\n\n-/## Shop\n\n- Shop was here./' walkthrough-notes.md && git commit -am "Shop note"
W=$(agile node show $B --json | jq -r .worktree)
cd $W && perl -0pi -e 's/## Blog\n\n-/## Blog\n\n- Blog was here./' walkthrough-notes.md && git commit -am "Blog note"
cd ~
```

- [ ] Two commits, `Shop note` and `Blog note`, one line changed each.

Touched files are recomputed after every agent edit and commit, and every 60
seconds. Wait a minute, then:

```zsh
S=$(agile node list --all --json | jq -r '.[] | select(.title=="Shop note") | .id')
B=$(agile node list --all --json | jq -r '.[] | select(.title=="Blog note") | .id')
agile node show $S --json | jq -r '.touched.files[]'
agile node show $B --json | jq -r '.touched.files[]'
agile tail --node $S --events
```

- [ ] Both print `walkthrough-notes.md`, and the Shop node has an
      `overlap [ledger-lite] because party · pending (E-…)` event. (`pending`
      means no session is attached to take it; a live agent gets it at once.)
- [ ] Cockpit: both nodes carry the ⚠ overlap mark in the rail (switch to
      **All projects** to see both), and **Repos** shows the overlap under
      ledger-lite across Shop and Blog.

### 5.3 Settle it with "waits on"; sync; merge

Shop's note waits on Blog's (**Link** → Blog note → **Wait on** on the Shop
note's page does the same):

```zsh
S=$(agile node list --all --json | jq -r '.[] | select(.title=="Shop note") | .id')
B=$(agile node list --all --json | jq -r '.[] | select(.title=="Blog note") | .id')
agile node wait $S --on $B
agile deliver $S
```

- [ ] `deliver` refuses: `delivery held: waits on …` (exit status 1). The
      Delivery panel shows the hold.

Merge Blog's note, then Shop's:

```zsh
S=$(agile node list --all --json | jq -r '.[] | select(.title=="Shop note") | .id')
B=$(agile node list --all --json | jq -r '.[] | select(.title=="Blog note") | .id')
agile deliver $B
agile node show $S | tail -3
agile deliver $S
cd ~/Projects/ledger-lite
cat walkthrough-notes.md
git status --short
cd ~
```

- [ ] Blog's note lands. Shop's thread then shows
      `synced main into stream/…-shop-note` and
      `waits on … satisfied`, and Shop's note lands too.
- [ ] `walkthrough-notes.md` has both lines. `git status --short` prints
      nothing. The overlap mark is gone (merged nodes are no longer live).

### 5.4 **[vendor]** Back to the ledger-lite part

The merges above moved ledger-lite's main, so the Shop ledger-lite part from
step 3 was synced too. (A part in the middle of a turn, or with uncommitted
changes, is synced at the end of its turn.)

```zsh
SHOP=$(agile project list --json | jq -r '.[] | select(.name=="Shop") | .id')
C=$(agile node list --project $SHOP --json | jq -r '.[] | select(.title=="Ledger export") | .id')
P1=$(agile node list --parent $C --json | jq -r '.[] | select(.repo=="ledger-lite") | .id')
agile tail --node $P1 --events
agile node show $P1 --json | jq -r '.agent.status, .delivery_state.status'
```

- [ ] P1's events include `main_changed [ledger-lite] because same repo`,
      and its thread shows `synced main into stream/…`.
- [ ] When its agent is `done`, press **Merge** on its page (or
      `agile deliver $P1`). Its wait is satisfied, the ship checks pass, and
      it lands on ledger-lite's main in one click. The coordinator hears the
      second child merged.

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

| Enforcement | What happens |
|---|---|
| tell | The item is in the agent's brief, and arrives as an event when accepted |
| action | Checked before each command or edit (a pattern or the classifier); blocked with the item named |
| ship | The classifier checks the whole diff before a merge or PR; a violation holds the delivery |
| review | On the reviewer agent's checklist before shipping |

Every item starts `proposed`: you add one, an agent proposes one, or the
lessons pass proposes one after a merge. Nothing applies until you accept it.
Items live in the home, never in your repos.

### 6.1 The classifier key

Ship and classifier action checks need the TypeSafe key. Use **one** of these,
and never paste the key into a command:

- **Settings (preferred):** cockpit → **Settings** → "TypeSafe API key" →
  paste → **Save**. It takes effect at once.
- **Environment:** `TYPESAFE_API_KEY` exported in the shell that runs
  `agile daemon start`.

```zsh
agile daemon status
```

- [ ] The line reads `classifier key: loaded (from config.yaml)` (or
      `from TYPESAFE_API_KEY`).

### 6.2 Add, accept and test a ship check

```zsh
K=$(agile knowledge add --name tests-with-changes --kind standard --scope repo:ledger-lite --text "Every change to a file under src/ comes with a test that exercises it" --enforcement ship --example "diff changes src/ledger.ts and adds no test::true" --example "diff changes src/ledger.ts and test/ledger.test.ts::false" --json | jq -r .id)
agile knowledge show $K
agile knowledge accept $K
agile knowledge test $K
```

- [ ] `knowledge show` prints `status  proposed`, `enforcement  ship`,
      `check  classifier` and the two examples (`violates …`, `allowed …`).
- [ ] `accept` prints `… is accepted`. The item is now on the **Knowledge**
      screen as accepted, and ledger-lite's norms in **Repos** list it.
- [ ] `knowledge test` prints one row per example with a probability, a band
      and `agree`, then `agreement 100.0%` (or close). `route` is the middle
      band, not a failure. A 529 error row means TypeSafe was busy: run it
      again. Without a key both rows read `classifier unavailable (not_configured)`.

### 6.3 A delivery held by the ship check, then fixed

Again no agent: you play it.

```zsh
BLOG=$(agile project list --json | jq -r '.[] | select(.name=="Blog") | .id')
T=$(agile node new --project $BLOG --title "Ledger count" --goal "Add a count function in src/ledger-count.ts." --no-start --json | jq -r .id)
agile node add-repo $T ledger-lite
W=$(agile node show $T --json | jq -r .worktree)
cd $W && mkdir -p src && printf '// %s\nexport function count(xs: number[]): number {\n  return xs.length;\n}\n' "$(date)" > src/ledger-count.ts && git add src/ledger-count.ts && git commit -m "Add count"
cd ~
agile deliver $T
agile node show $T --json | jq -r '.delivery_state.status, .delivery_state.held_by[].detail'
```

- [ ] `deliver` prints `delivery held by ship check tests-with-changes: Every change to a file under src/ comes with a test that exercises it (probability 0.8…)`,
      and the node reads `held` with the same detail. On a live node the
      findings go back to the worker to fix; they come to you only if the
      check is unsure or the worker disputes them.

Add the test and deliver again:

```zsh
T=$(agile node list --all --json | jq -r '.[] | select(.title=="Ledger count") | .id')
W=$(agile node show $T --json | jq -r .worktree)
cd $W && mkdir -p test && printf "// %s\nimport { expect, test } from 'bun:test';\nimport { count } from '../src/ledger-count';\n\ntest('count', () => {\n  expect(count([1, 2, 3])).toBe(3);\n});\n" "$(date)" > test/ledger-count.test.ts && git add test/ledger-count.test.ts && git commit -m "Test count"
cd ~
agile deliver $T
agile node show $T --json | jq -r '.delivery_state.status, .human.status'
```

- [ ] `landed stream/…-ledger-count into main (…)`, then `merged` and
      `landed`.

### 6.4 **[vendor]** A decision reaches a live node as an event

Start a Shop conversation, so there is a live agent in the decision's scope:

```zsh
SHOP=$(agile project list --json | jq -r '.[] | select(.name=="Shop") | .id')
Q=$(agile node new --project $SHOP --title "Cents check" --goal "Read ledger-lite and tell me how it stores amounts. Then wait: I may send you a decision about this." --json | jq -r .id)
agile node show $Q --json | jq -r .role
```

When its first answer is on the thread, add and accept a `tell` decision
scoped to Shop:

```zsh
SHOP=$(agile project list --json | jq -r '.[] | select(.name=="Shop") | .id')
Q=$(agile node list --project $SHOP --json | jq -r '.[] | select(.title=="Cents check") | .id')
D=$(agile knowledge add --name amounts-in-cents --kind decision --scope project:$SHOP --text "Amounts in exported JSON are integer cents, never floats" --enforcement tell --json | jq -r .id)
agile knowledge accept $D
agile tail --node $Q --events
```

- [ ] `tail` shows a `knowledge_accepted because party` row, delivered to the
      live session. The agent's next thread line reacts to the decision
      ("new decision in scope: …"). A Blog node never gets it.
- [ ] The node's **Knowledge in scope** tab lists the global items,
      `amounts-in-cents`, and nothing from Blog.

## 7. **[vendor]** The Director

The Director sits above every project. It sees all projects, repos, norms,
overlaps and waits, answers "what needs me today?" from a live snapshot, and
can set up work. Its level is per project (`--director-autonomy`), with the
same three levels as coordinators: at **advise** (the default) its changes are
drafts you create with one click; at **organise** it creates and starts nodes
and adds waits on its own, and tells you; at **run** it may also restart
stuck work. A brand-new project is always a draft, whatever the level. It
never merges, accepts knowledge, or answers a question as you. Every action is
recorded as done by `director`.

### 7.1 What needs me today?

```zsh
agile director say "What needs me today?"
agile tail --director
```

- [ ] `director say` prints `sent (E-…); follow with agile tail --director`.
      The first line starts the Director (`director attached: claude/…`).
- [ ] Within a minute or two its reply lands on its thread (run the `tail`
      again, or open **Director**): the inbox first, then stuck nodes,
      overlaps and open waits, taken from the snapshot, not memory.

### 7.2 Advise: a draft tree with Create

```zsh
agile director say "Blog needs a CHANGELOG.md in ledger-lite listing the last five commits. Draft the work for me."
agile tail --director
```

- [ ] **Director** → **Drafts** shows the draft as a tree (Blog, the new node,
      its parts and any "waits on") with **Create** and **Dismiss**. Nothing
      has been created yet.
- [ ] Press **Create**. The nodes appear under Blog in the rail, not started.

### 7.3 Organise: the Director starts the work itself

```zsh
BLOG=$(agile project list --json | jq -r '.[] | select(.name=="Blog") | .id')
agile project set $BLOG --director-autonomy organise
agile project show $BLOG
agile director say "Go ahead with the changelog: start it now."
```

- [ ] `project show` reads `autonomy    coordinator=advise director=organise`.
- [ ] The Director starts the changelog node's agent itself, with no card,
      and posts what it did on its thread. **Running** lists the node.

```zsh
BLOG=$(agile project list --json | jq -r '.[] | select(.name=="Blog") | .id')
agile node list --project $BLOG --json | jq -r '.[] | .title + "  " + .role + "  " + .agent.status'
agile director say "Merge the changelog when it is done."
agile tail --director
```

- [ ] The changelog node reads `working` (or `done` later).
- [ ] The Director refuses the merge: merging is yours. When the node is
      done, merge it yourself with **Merge** on its page.

## 8. Trackers: Jira or Linear

Any node may link to one external issue. Linking pulls the issue's title and
description into the node's goal, and later edits arrive as events. A node
with no link **rolls up** to its nearest linked ancestor: its PR mentions that
issue, and the linked node shows how many of the nodes under it have merged.
Status push (in progress, in review, done) is off until you turn it on per
project. The app never closes an issue or edits its text.

### 8.1 **[vendor]** The token

In Jira, create an API token (Atlassian account → Security → API tokens).
Then run the line below. **Change the two placeholders:** replace
`https://your-site.atlassian.net` with your Jira site and `you@example.com`
with your Atlassian email. The token is never an argument: the command asks
for it at a prompt that does not echo.

```zsh
agile tracker set jira --base-url https://your-site.atlassian.net --email you@example.com
agile tracker status
agile daemon status
```

- [ ] `tracker set` asks `jira token (not echoed):`, then prints
      `agile tracker set: jira saved` and
      `jira: token set · base URL https://… · email …`.
- [ ] `daemon status` reads `trackers: jira configured · linear not configured`.
- [ ] Cockpit → **Settings** → Trackers shows the same, with a field per
      token (the token itself is never shown). `agile tracker clear jira`
      removes it.

Using Linear instead: `agile tracker set linear` (it asks for a personal API
key), then use `linear` wherever 8.2 says `jira`.

### 8.2 The project's tracker settings

```zsh
SHOP=$(agile project list --json | jq -r '.[] | select(.name=="Shop") | .id')
agile project set $SHOP --tracker jira --push-status on --status-map "in_progress=In Progress,in_review=In Review,done=Done"
agile project show $SHOP
```

- [ ] `project show` reads
      `tracker     jira push_status=on status_map=in_progress=In Progress,in_review=In Review,done=Done`.
      The names on the right must match your Jira workflow's status names
      (`key=` with nothing after it clears one phase).

### 8.3 **[vendor]** Link an epic, import its children

You need one **epic** in Jira with at least one child issue, and its first
child should be a small task an agent can do in agile-test-repo (for example
"Add TRACKER.md with one line saying this repo is linked to Jira"). **Change
the placeholder:** replace `SHOP-10` below with your epic's key. Every later
block reads it back from the node, so this is the only place to type it.

```zsh
KEY=SHOP-10
SHOP=$(agile project list --json | jq -r '.[] | select(.name=="Shop") | .id')
E=$(agile node new --project $SHOP --title "Tracker epic" --goal "Placeholder until linked" --no-start --json | jq -r .id)
agile node link $E $KEY
agile node show $E --json | jq -r '.goal, .external_link.url'
agile node import-children $E
agile node import-children $E
agile node list --parent $E
```

- [ ] `node link` prints `linked to … (jira); goal set from the issue`. The
      goal is the epic's title, then `From jira issue … (https://…/browse/…)`
      and its description.
- [ ] The first `import-children` prints one row per child issue (id, key,
      title) and `N created, 0 already linked`. The second prints
      `0 created, N already linked`: importing is idempotent.
- [ ] The epic node's page reads `Linked to <key> (jira) · 0/N merged` with
      **Unlink** and **Import children**.

### 8.4 **[vendor]** Work on a linked issue; status push; roll-up in the PR

Give the first imported child a repo and start it:

```zsh
E=$(agile node list --all --json | jq -r '.[] | select(.title=="Tracker epic") | .id')
I=$(agile node list --parent $E --json | jq -r '.[0].id')
agile node show $I --json | jq -r '.title, .external_link.key'
agile node add-repo $I agile-test-repo
agile attach $I
```

- [ ] `attach` starts a worker in the child's new worktree. In Jira the child
      issue moves to **In Progress**.
- [ ] Edit the child issue's description in Jira. Within five minutes the
      child's **Activity** shows an `external_changed` event and the agent is
      told.
- [ ] When the agent is done, press **Merge** (or `agile deliver $I`). The PR
      body's `Issues:` line links the child issue. In Jira the issue moves to
      **In Review** and gains a link to the PR.
- [ ] The `changelog` check from 2.1 fails first, and the agent fixes it as
      in step 4. After auto-merge the issue moves to **Done**, and the epic
      node reads `1/N merged`.
- [ ] An unlinked node under the epic node rolls up the same way: its PR's
      `Issues:` line names the epic.

### 8.5 **[vendor]** Create an issue from a node

```zsh
E=$(agile node list --all --json | jq -r '.[] | select(.title=="Tracker epic") | .id')
agile node new --parent $E --title "Tracker follow-up" --goal "Note in TRACKER.md how issues are linked." --no-start
```

- [ ] On Tracker follow-up's page, leave the **Link** field empty and press
      **Create issue**. A new issue is created in the epic's Jira project, as a
      child of the epic, from the node's title and goal. The node reads
      `Linked to …`, and its goal is kept. This creates a real issue: delete it
      in Jira afterwards if you don't want it. (On a node with no linked
      ancestor, type the project key, such as `SHOP`, first.)

## 9. Day to day: inbox, logs, stop and start, troubleshooting

### 9.1 What is going on

```zsh
agile status
agile inbox
agile tail | tail -20
```

- [ ] `status` prints the daemon (pid, uptime), the home, the tree with each
      node's `agent/human` status, and `needs you`, gates and open questions.
- [ ] `inbox` lists everything waiting on you, oldest first: `kind`, the node
      path (`Shop / Ledger export / ledger-lite part`), age, context and the
      id to answer with. `done` items say
      `worker finished — land or close the stream`.
- [ ] `tail` is the raw event log. `agile tail --follow` keeps printing
      (Ctrl-C to stop). `agile tail --stream` with a node id filters to that
      node's audit log (`agile tail --stream $P1` after the next block), and
      `agile tail --kind thread_appended` to one kind.

A node's routed events (what woke it and why) are separate from the raw log:

```zsh
SHOP=$(agile project list --json | jq -r '.[] | select(.name=="Shop") | .id')
C=$(agile node list --project $SHOP --json | jq -r '.[] | select(.title=="Ledger export") | .id')
P1=$(agile node list --parent $C --json | jq -r '.[] | select(.repo=="ledger-lite") | .id')
agile tail --node $P1 --events
```

- [ ] One row per event: time, type, `[repo]`, `because …` (self, ancestor,
      waits on, same repo, party, sibling), the delivery status (`delivered`,
      `pending`, `superseded`, `expired`, or `in digest …`) and the event id. A node with none
      says `no routed events for …` and names its audit log. Add `--follow`
      to watch.

### 9.2 Stop and start

```zsh
agile daemon stop
agile daemon status
agile daemon start
agile daemon status
```

- [ ] `stop` prints `agiled stopped: pid=…`; `status` then says
      `agiled is not running`. `start` brings it back with every node, thread
      and event intact. Stopping the daemon stops every agent session; start
      a node again from its page (**Restart**) if it was mid-work.

### 9.3 Where things live

- Daemon log: `tail -50 ~/.agile-walkthrough/log/agiled.log`
- Event log: `~/.agile-walkthrough/log/events.jsonl`
- A vendor session's stderr: one directory per session under
  `~/.agile-walkthrough/sessions/`, each with `stderr.log`:
  `ls -t ~/.agile-walkthrough/sessions | head -5`
- Why a session ended: the node page's session strip, or (for the
  ledger-lite part, with the 9.1 lookups)
  `agile node show $P1 --json | jq -r '.sessions[].ended_reason'`.
- Nodes, threads, projects, knowledge: `streams/`, `threads/`, `projects/`,
  `knowledge/` in the home. Worktrees: `<repo>/.worktrees/<node-id>-<slug>`
  on `stream/…` branches.

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
- **Stale daemon** (it crashed, or the Mac slept badly). `agile daemon status`
  says `agiled is not running` and `agile daemon start` clears the old
  pidfile and starts cleanly. If `status` says running but the cockpit does
  not load, `agile daemon stop`, then `agile daemon start`. If stop hangs:
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
  strip and its `stderr.log` (9.3). `node new`/`add-repo` on a repo whose main
  has no commits is refused up front: make an initial commit first.
- **A delivery refuses.** The Delivery panel (or `agile deliver`) says why:
  held by a ship check (the item is named), waits on another node, a merge
  conflict (**Resolve** starts a worker to fix it), `main is checked out with
  uncommitted changes` (clean the repo's checkout), or nothing to deliver.
- **`push … to origin failed: git has no working credentials for origin`.**
  Run `gh auth setup-git` (2.1), then deliver again. The node reads `held`
  until then.
- **The Director's thread repeats `director attached` and never answers.**
  Its vendor session dies as it starts (a Claude Code login problem, most
  likely), and the daemon starts another at once. Stop the daemon, read the
  newest `stderr.log` (9.3), fix the login, start again.
- **A PR's state looks stale.** An open PR is polled about once a minute
  (every 15 seconds while its agent is fixing something, every 5 minutes
  after an hour with no change). `gh auth status` must be
  logged in; `agile daemon status` says `GitHub auth: available`.
- **Start over:** 1.3, then 1.4.

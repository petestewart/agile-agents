# LIVE-CHECKLIST — the Phase 7 walkthrough

Projects, nodes and + Repo, against two repos on your Mac with Claude Code
logged in: `~/Projects/ledger-lite` and `~/Projects/agile-test-repo`. Every
block not marked **[vendor]** was run as pasted, in a fresh scratch home, before
it was written down; paste each block as-is. **[vendor]** steps spawn a real
Claude Code session and need your login. Tick each box, or note what you saw
instead.

The state home for this run is `~/.agile-phase7`, so it never touches a
`~/.agile` you use for anything else. **Every terminal you open for this
walkthrough needs the `export` from step 2.**

## 1. Build and install `agile`

- [ ] Build the branch under test and put `agile` on your PATH. The block
  assumes the checkout is at `~/agile-agents`; adjust the `cd` lines if yours
  is elsewhere. Until Phase 7 lands on main, the branch under test is
  `claude/phase-7`.

```zsh
cd ~/agile-agents
git fetch origin
git checkout claude/phase-7
git pull origin claude/phase-7
bun --version
bun install
bun run build
cd packages/cli
bun link
cd ~/agile-agents
which agile
```

`bun --version` must be 1.4.2 or newer. `which agile` should print
`~/.bun/bin/agile`; if it prints nothing, add `export PATH="$HOME/.bun/bin:$PATH"`
to `~/.zshrc` and open a new terminal.

After pulling new code at any later point, rebuild and restart the daemon, then
reload the cockpit tab (with the step 2 `export` applied):

```zsh
cd ~/agile-agents
bun install
bun run build
agile daemon stop
agile daemon start
```

## 2. Point at the walkthrough state home

- [ ] In every terminal for this walkthrough:

```zsh
export AGILE_HOME=~/.agile-phase7
```

If `AGILE_HOME` points at something that is not a directory, every command
refuses with one line naming the variable and the path.

## 3. Reset (start clean; also the recipe to start over)

- [ ] Stop any daemon on this home, delete the home, make sure both repos are
      present, and clear stream worktrees and branches from both:

```zsh
agile daemon stop
rm -rf ~/.agile-phase7
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

`agile daemon stop` says "not running" on a first run; that is fine. Stream
branches are all named `stream/…`, so the loops delete nothing else. Each
`git status --short` should print nothing (commit or stash first if it does).

## 4. Start the daemon; a fresh home has the built-in rules

- [ ] Create the home and start the daemon:

```zsh
agile init
agile daemon start
agile daemon status
```

`daemon status` prints the home first (`home: …/.agile-phase7`), then
`agiled running: pid=… http=http://127.0.0.1:4600 …`, whether a classifier key
is loaded (it never prints the key), and
`session default: claude/claude-opus-5-5 · low`. If port 4600 is held,
`daemon start` names the holder and says whether it looks like another `agiled`.

- [ ] A fresh home starts with three built-in rules:

```zsh
agile rules list
```

`no_push_protected` (accepted), `path_deny` (accepted; "Never write outside
the session's own worktree") and `no_push` (retired by default; accept it for
the stricter posture).

- [ ] Open the cockpit: `open http://127.0.0.1:4600/`

## 5. Register both repos

```zsh
cd ~/Projects/ledger-lite
agile repo add . --name ledger-lite
cd ~/Projects/agile-test-repo
agile repo add . --name agile-test-repo
agile repo list
```

- [ ] `repo list` shows both, each `protected=main,master`.

## 6. Two projects

```zsh
SHOP=$(agile project new --name Shop --repo ledger-lite --repo agile-test-repo --json | jq -r .id)
BLOG=$(agile project new --name Blog --repo ledger-lite --json | jq -r .id)
agile project list
agile project show $SHOP
```

- [ ] `project list` shows `Shop` (repos `ledger-lite,agile-test-repo`) and
      `Blog` (`ledger-lite`), each with a root node id. `project show` prints
      the name, root, repos and `autonomy coordinator=advise director=advise`.
- [ ] Cockpit: the left rail groups the tree by project; the switcher offers
      **All projects**, Shop and Blog. **New project** in the rail opens a
      one-field dialog (create a third project there if you like).

## 7. + Repo reshapes a node in place (no agent)

`--no-start` keeps this node's agent off, so the reshapes are checked without a
vendor. The next step does the same on a live conversation.

```zsh
N=$(agile node new --project $SHOP --title "Reshape check" --goal "Check the three + Repo reshapes." --no-start --json | jq -r .id)
agile node show $N --json | jq -r .role
agile node add-repo $N ledger-lite
agile node show $N --json | jq -r '.role, .branch'
agile node add-repo $N agile-test-repo
agile node show $N --json | jq -r .role
agile node list --parent $N --json | jq -r '.[] | .title + "  " + .repo + "  " + .role'
agile node list --project $SHOP
```

- [ ] The roles print in order: `conversation`, then `work` and a
      `stream/…-reshape-check` branch, then `coordinating`.
- [ ] The second `add-repo` prints two parts; the `--parent` list shows
      `ledger-lite part  ledger-lite  work` and
      `agile-test-repo part  agile-test-repo  work`. The ledger-lite part keeps
      the branch the node had.
- [ ] `node list --project` shows Shop (`project`), Reshape check
      (`coordinating`) and the two parts (`work`).
- [ ] Cockpit: the rail shows the node with the coordinating icon and its two
      parts with the work icon.

Switch a work node with nothing committed to another repo:

```zsh
S=$(agile node new --project $BLOG --title "Switch check" --goal "Check switch-repo." --no-start --json | jq -r .id)
agile node add-repo $S ledger-lite
agile node switch-repo $S agile-test-repo
agile node show $S --json | jq -r .role
agile node list --parent $S --json | jq -r '.[] | .title + "  " + .repo + "  " + .human.status'
```

- [ ] `switch-repo` prints two parts: `ledger-lite part … closed` (the empty
      one) and `agile-test-repo part … open`. The node reads `coordinating`,
      and the list shows the same two parts with those statuses.

Close both check nodes so they don't clutter the views:

```zsh
agile node close $S --note "checked"
agile node archive $S
agile node archive $N
```

## 8. **[vendor]** A live conversation gains repos

`node new` without `--no-start` starts the node's agent (Claude Code, with the
session default).

```zsh
Q=$(agile node new --project $SHOP --title "Balance summary" --goal "Can ledger-lite print a per-account balance summary? Explain how." --json | jq -r .id)
agile node show $Q --json | jq -r .role
```

- [ ] Role `conversation`. On the node's page the thread starts filling with
      the agent's answer; no branch or worktree is created.
- [ ] On the node's page press **+ Repo** and pick `ledger-lite` (or paste the
      command below). The thread stays; the node becomes `work` with a
      `stream/…` branch and worktree in ledger-lite.

```zsh
agile node add-repo $Q ledger-lite
agile node show $Q --json | jq -r '.role, .branch'
```

- [ ] Add the second repo. The node becomes `coordinating`, the chat stays on
      it, and two part rows appear under it:

```zsh
agile node add-repo $Q agile-test-repo
agile node show $Q --json | jq -r .role
agile node list --parent $Q --json | jq -r '.[] | .title + "  " + .repo + "  " + .role'
```

Parts are not auto-started. Attach a worker to each part to do the work:

```zsh
P1=$(agile node list --parent $Q --json | jq -r '.[] | select(.repo == "ledger-lite") | .id')
P2=$(agile node list --parent $Q --json | jq -r '.[] | select(.repo == "agile-test-repo") | .id')
agile attach $P1
agile attach $P2
```

## 9. Classifier key (real TypeSafe key)

Use **one** of these, and never paste the key into a terminal command that is
echoed or into this checklist:

- **Settings (preferred):** cockpit → Settings → "TypeSafe API key" → paste →
  Save. Takes effect immediately.
- **Environment:** `TYPESAFE_API_KEY` exported in the shell that runs
  `agile daemon start`.

```zsh
agile daemon status
```

- [ ] The line reads `classifier key: loaded (from config.yaml)` (or
      `from TYPESAFE_API_KEY`).

## 10. Rules: one pattern rule, one classifier rule

```zsh
RULE=$(agile rules add --text "Never run rm -rf in a worktree" --enforcement pattern --pattern command_deny --pattern-arg "rm -rf" --json | jq -r .id)
agile rules accept $RULE
agile rules show $RULE
CRULE=$(agile rules add --text "Do not add a new npm dependency without asking" --enforcement classifier --example "bun add left-pad::true" --example "bun test::false" --json | jq -r .id)
agile rules accept $CRULE
agile rules test $CRULE
```

- [ ] `rules show` prints `enforcement  pattern` and
      `pattern  command_deny: "rm -rf"`.
- [ ] `rules test` prints one row per example with a probability and band. A
      `route` band is the middle band, not a failure. A `529` error row is
      TypeSafe being busy; run it again. Without a key both rows read `classifier unavailable (not_configured)` and the command exits 1.
- [ ] **[vendor]** On the ledger-lite part's page write
      `Run rm -rf dist in your worktree, then tell me what happened.` The
      thread shows one "blocked by rule" card naming the rule.

## 11. Views

- [ ] **Repos** (top bar): the By repo view lists live work nodes grouped by
      repo across projects, ancestors greyed, with the repo's delivery mode.
- [ ] **Needs me**: the inbox, grouped by node. **[vendor]** questions from the
      parts show here and in `agile inbox`; answer with the card or
      `agile answer`.
- [ ] **Running**: the nodes with a live session (the parts, while attached).
- [ ] **Dependencies**: the `waits_on` list (empty in this run).
- [ ] The switcher on Shop hides Blog's nodes; **All projects** shows both.

## 12. **[vendor]** Land the parts

When each part's worker is done:

```zsh
agile land $P1
agile land $P2
cd ~/Projects/ledger-lite
git log --oneline -3
git status --short
cd ~/Projects/agile-test-repo
git log --oneline -3
git status --short
```

- [ ] Each land merges the part's `stream/…` branch into its repo's main
      branch, closes the part and removes its worktree. Both
      `git status --short` print nothing.

## When something fails

- **Daemon log:** `tail -50 ~/.agile-phase7/log/agiled.log`
- **Event log:** `~/.agile-phase7/log/events.jsonl`, or `agile tail --stream`
  with a node id.
- **Vendor session stderr:** one directory per session under
  `~/.agile-phase7/sessions/`, each holding `stderr.log`:
  `ls -t ~/.agile-phase7/sessions | head -5`
- **Why a session ended:** the node page's session strip shows `ended_reason`.
- **A rule that did not fire:** `agile rules show` with its id (status must be
  `accepted`); `agile rules report` for counts.
- **Start over:** step 3, then step 4.

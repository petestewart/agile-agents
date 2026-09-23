# LIVE-CHECKLIST — the cockpit walkthrough

The PLAN §6 walkthrough, as numbered steps, against `~/Projects/ledger-lite`
on your Mac with Claude Code logged in. Everything here that does not spawn a
vendor was run in zsh in a scratch state home before it was written down;
paste each block as-is. Tick each box, or note what you saw instead.

The state home for this run is `~/.agile-reshape`, so it never touches a
`~/.agile` you use for anything else. **Every terminal you open for this
walkthrough needs the `export` from step 2.**

## 1. Build and install `agile`

- [ ] Build from the agile-agents checkout and put `agile` on your PATH:

```zsh
cd ~/Projects/agile-agents
git fetch origin
git checkout main
git pull
bun --version
bun install
bun run build
cd packages/cli
bun link
cd ~/Projects/agile-agents
which agile
```

`bun --version` must be 1.3.11 or newer. `which agile` should print
`~/.bun/bin/agile`; if it prints nothing, add `export PATH="$HOME/.bun/bin:$PATH"`
to `~/.zshrc` and open a new terminal.

## 2. Point at the walkthrough state home

- [ ] In every terminal for this walkthrough:

```zsh
export AGILE_HOME=~/.agile-reshape
```

## 3. Reset (start clean; also the recipe to start over)

- [ ] Stop any daemon on this home, delete the home, and clear stream
      worktrees and branches from ledger-lite:

```zsh
agile daemon stop
rm -rf ~/.agile-reshape
cd ~/Projects/ledger-lite
git checkout main
rm -rf .worktrees
git worktree prune
for b in $(git for-each-ref --format='%(refname:short)' refs/heads/stream); do git branch -D $b; done
git status --short
```

`agile daemon stop` says "not running" on a first run; that is fine. Stream
branches are all named `stream/…`, so the loop deletes nothing else.
`git status --short` should print nothing (commit or stash first if it does).

## 4. Start the daemon

- [ ] Create the home and start the daemon:

```zsh
agile init
agile daemon start
agile daemon status
```

`daemon status` prints the home first (`home: …/.agile-reshape`), then
`agiled running: pid=… http=http://127.0.0.1:4600 …`, whether a classifier key
is loaded (it never prints the key), and
`session default: claude/claude-opus-5-5 · low`.

- [ ] Open the cockpit: `open http://127.0.0.1:4600/`

## 5. Register ledger-lite

- [ ] Register the repo:

```zsh
cd ~/Projects/ledger-lite
agile repo add . --name ledger-lite
agile repo list
```

`repo list` shows `ledger-lite … protected=main,master`, and the cockpit's
Settings → Session defaults now lists it under **Per-repo defaults**.

## 6. Classifier key (real TypeSafe key)

The classifier tier needs a TypeSafe key. Use **one** of these, and never paste
the key into a terminal command that is echoed or into this checklist:

- **Settings (preferred):** cockpit → Settings → "TypeSafe API key" → paste → Save.
  It is stored as `classifier.api_key` in `~/.agile-reshape/config.yaml` and
  takes effect immediately, no restart. Settings shows only whether a key is
  set and where it came from.
- **config.yaml by hand:** add `classifier:` / `  api_key: …` to
  `~/.agile-reshape/config.yaml`, then `agile daemon stop` and
  `agile daemon start`.
- **Environment:** `TYPESAFE_API_KEY` exported in the shell that runs
  `agile daemon start`.

- [ ] Check it loaded:

```zsh
agile daemon status
```

The line reads `classifier key: loaded (from config.yaml)` (or `from TYPESAFE_API_KEY`).

## 7. Session defaults

- [ ] Cockpit → Settings → Session defaults. The **Global default** row
      resolves to `claude / claude-opus-5-5 / low`. Under **Per-repo defaults**
      the `ledger-lite` row says it overrides the global default and shows what
      it resolves to. Leave both as they are (or change the global effort, Save,
      and see "· saved"; it applies to the next session with no restart).

Resolution order (D17): the Attach/Review picker (or `--vendor/--model/--effort`
on the CLI) → the repo row → the global row → built-in `claude/claude-opus-5-5/low`.

## 8. Rules: one command_deny pattern rule, one classifier rule

- [ ] Add and accept a pattern rule that blocks `rm -rf`:

```zsh
RULE=$(agile rules add --text "Never run rm -rf in a worktree" --enforcement pattern --pattern command_deny --pattern-arg "rm -rf" --json | jq -r .id)
agile rules accept $RULE
agile rules show $RULE
```

`rules show` prints `enforcement  pattern` and `pattern  command_deny: "rm -rf"`.

- [ ] Add and accept a classifier rule, then run its examples through the real
      classifier:

```zsh
CRULE=$(agile rules add --text "Do not add a new npm dependency without asking" --enforcement classifier --example "bun add left-pad::true" --example "bun test::false" --json | jq -r .id)
agile rules accept $CRULE
agile rules test $CRULE
```

`rules test` prints one row per example with a probability and band. A
`route` band on the `true` example (probability between 0.4 and 0.8) is the
middle band, not a failure; it counts as a disagreement in the summary. An
`error: classifier unavailable (http_error) … 529` row is TypeSafe being busy;
run it again.

- [ ] Cockpit → Rules shows both rules, the first with
      `command_deny: "rm -rf"` under its text.

## 9. A parent stream with three sub-streams

- [ ] Create them, capturing the ids:

```zsh
cd ~/Projects/ledger-lite
ID=$(agile stream new --title "Ledger features" --goal "Transfers, reversals and a spending breakdown" --repo ledger-lite --json | jq -r .id)
A=$(agile stream new --title "Transfers" --goal "Add transfers between accounts in integer cents" --parent $ID --repo ledger-lite --json | jq -r .id)
B=$(agile stream new --title "Reversals" --goal "Add reversals that append a compensating entry" --parent $ID --repo ledger-lite --json | jq -r .id)
C=$(agile stream new --title "Spending breakdown" --goal "Add a per-category spending breakdown" --parent $ID --repo ledger-lite --json | jq -r .id)
agile stream list
```

`stream list` shows `Ledger features` with the three nested under it; the
cockpit's stream tree matches.

## 10. Attach a worker to each sub-stream

- [ ] Attach (this spawns real Claude Code sessions with the session default):

```zsh
agile attach $A
agile attach $B
agile attach $C
```

On each stream page the session strip reads
`claude/claude-opus-5-5 · low`, and the thread starts filling. The first attach
creates `.worktrees/` in ledger-lite and a `stream/…` branch per stream.
(Attach from the cockpit instead to get the picker, prefilled with the default.)

- [ ] Write on a stream page: type a line, press **Enter** to send
      (**Shift+Enter** for a newline). The worker reads it on its next turn.

## 11. The `rm -rf` rule blocks

- [ ] On stream A's page, write:
      `Run rm -rf dist in your worktree, then tell me what happened.`
- [ ] The thread shows exactly **one** "blocked by rule" card naming
      "Never run rm -rf in a worktree", and the worker reports it was denied.
      `agile tail --stream $A` shows the hook decision.

## 12. Answer questions from the inbox

- [ ] When a worker asks something, it shows in the cockpit Inbox and in:

```zsh
agile inbox
```

Answer from the cockpit card (or `agile answer` with the `Q-…` id and your
text). The worker picks the answer up and continues.

## 13. Review one stream

- [ ] Start a read-only reviewer on stream A:

```zsh
agile review $A
```

The reviewer's findings land on stream A's thread; it cannot write files.

## 14. Land all three

- [ ] When each worker is done, land from the stream page's Land panel, or:

```zsh
agile land $A
agile land $B
agile land $C
git log --oneline -5
```

Each land merges `stream/…` into `main`, closes the stream and removes its
worktree. A land that finds a conflict or a failing diff-level rule stops and
says why.

## 15. Proposed rules

- [ ] Workers and reviewers propose rules as they go. List them and accept two:

```zsh
agile rules list --status proposed
```

Accept from the cockpit Rules screen, or `agile rules accept` with the `R-…` id.

- [ ] Open a fresh stream, attach a worker, and prompt it into the action one of
      the accepted rules forbids. That tool call is denied with the rule named.

## When something fails

- **Daemon log:** `~/.agile-reshape/log/agiled.log`
  (`tail -50 ~/.agile-reshape/log/agiled.log`).
- **Event log:** `~/.agile-reshape/log/events.jsonl`, or `agile tail --stream $A`
  for one stream.
- **Vendor session stderr:** `~/.agile-reshape/sessions/` has one directory per
  session holding `stderr.log`:

```zsh
ls -t ~/.agile-reshape/sessions | head -5
```

- **Why a session ended:** the stream page's session strip shows the
  `ended_reason` (the vendor's last error line, e.g. an unsupported model) after
  the session status.
- **A rule that did not fire:** `agile rules show` with its id (status must be
  `accepted`); `agile rules report` for fired/violated counts.
- **Classifier:** `agile daemon status` says whether a key is loaded;
  `classifier_call` events in `agile tail` show latency and errors.
- **Start over:** step 3, then step 4.

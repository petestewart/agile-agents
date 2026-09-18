# LIVE-CHECKLIST — control room v2 (T039–T046)

Manual checks for the acceptance criteria that need a real vendor login, a
real Jira tenant, or a clone with `main` checked out. Everything else in
T039–T046 is proven offline (`bun test`, `bun run test:integration`,
`bun run test:e2e`) on branch `claude/control-room-v2`. Nothing below was
run in the cloud session: there is no vendor login there.

Run these on your laptop against `~/Projects/ledger-lite`. Its
`WALKTHROUGH.md` has the reset recipe; the run command is `agile run --live`
from the ledger-lite clone. `agile run` prints the control-room URL
(`control room: http://127.0.0.1:<port>/control-room`; default port 4600).
Tick each box, or note what you saw instead.

## 0. Setup (once)

- [ ] `cd ~/Projects/agile-agents && git fetch origin && git checkout claude/control-room-v2 && bun install && bun run build`
- [ ] `bun --version` is 1.3.11 or newer.
- [ ] `claude login` state is valid (the resident EM and every agent spawn with it).
- [ ] Reset ledger-lite per its `WALKTHROUGH.md` (fresh `.agile/`, `main` checked out).

## 1. T046 — run-loop fixes (clean stderr, real sprint goal, promotion gate)

From the ledger-lite clone with `main` checked out:

- [ ] `agile run --live 2> run.stderr.log`
- [ ] `grep -c 'skipping' run.stderr.log` prints `0` (no `review/rules: skipping .gitkeep` lines).
- [ ] `agile status` shows the sprint goal as the first heading of ledger-lite's `oracle/product.md`, not `Demo epic layer 1`.
- [ ] At sprint review, `agile status` prints exactly one `HIL needed: <id>` whose kind is `promote_to_main` and whose summary names the `git merge --no-ff integration` workaround.
- [ ] Apply the workaround (`git merge --no-ff integration` in the clone, or check out another branch) and re-run: the promotion lands on `main`.

## 2. T041 — resident EM chat (answer, pop-out, reload, survives a kill)

With the run from step 1 still up (or a fresh `agile run --live`), open the printed control-room URL:

- [ ] Type `what is left on all tickets` in the chat panel. The EM's answer streams into the panel within one turn.
      The run prints `resident EM session stderr -> .agile-daemon-cache/sessions/em-resident-*.stderr.log` on first use.
- [ ] Click the chat pop-out icon (or open `<base>/control-room/chat`). Both windows show the same thread; send from one, it appears in the other.
- [ ] Reload the control room. The whole conversation is still there.
- [ ] Kill the resident EM's vendor process (`ps aux | grep -i claude`, kill the pid whose stderr log is `em-resident-*`), then let an engineer hit an `unblock` gate (or `agile question raise --text x` and answer it). The run still prints `EM deciding gate …` then `EM approved|denied gate …`; `tail -f .agile/log/events.jsonl` shows `hil_resolved`, nothing parks pending.
- [ ] Chat again after the kill. A fresh resident session spawns and answers.

## 3. T044 — Team rows show a real model id

- [ ] In the same run, open the Sprint view. Every Team row (architect, engineers, reviewers, QA, including agents that already left) names the vendor and a real model id such as `claude-sonnet-4-5-…`; none says `unknown`.
- [ ] Cross-check on disk: `grep -h model .agile/bus/agents/*.yaml` and `grep -h '"agent_deleted"' .agile/log/events.jsonl` show the same ids.
- [ ] Each finished ticket's story reads: assigned → built → review approved (verdict quoted) → QA → merged, with timestamps; the Review view narrative matches `runs/<latest>.md` word for word.

Alternative for the model-id check alone, from the agile-agents checkout:
`AGILE_LIVE=1 AGILE_LIVE_KEEP=1 bun test packages/cli/src/run.e2e.test.ts`, then grep the printed temp repo as above.

## 4. T042 — plan a sprint from the UI with no seed file

From a fresh clone (this replaces the seed-file front door; the offline twin is the second test in `packages/daemon/src/feed/plan.e2e.test.ts`):

- [ ] `cd ~/Projects && rm -rf ledger-lite-t042 && git clone ledger-lite ledger-lite-t042 && cd ledger-lite-t042 && agile init && agile daemon start`
- [ ] Open `http://127.0.0.1:4600/control-room`. It lands on the Plan view with empty panes and the chat.
- [ ] Type the goal, e.g. `Add transfers, reversals and a per-category spending breakdown, keeping money in integer cents and the ledger append-only`.
      A real architect session spawns; within a turn the Brief, Rules and Tickets panes fill from `oracle/product.md`, `oracle/specs/SPEC-*`, `tickets/`.
- [ ] Edit one not-started ticket in the Tickets pane: the file under `.agile/tickets/` changes, `events.jsonl` gains a line, `git -C .agile log -1` (agile-state) moved.
- [ ] Click **Start Sprint 1** in the top bar. `agile status` shows `S-1` running with the frontier; `.agile/board/hil/` has exactly one resolved `approve_plan`; no other approval was asked.
- [ ] While a ticket is in flight, edit its contract in the Tickets pane: the engineer receives a contract-change message (`.agile/bus/inbox/<engineer>/`), the UI says so, nothing is silently rewritten.
- [ ] Publish a decision from the Decisions pane that no ticket cites: `events.jsonl` gains one `ticket_reexamined` line per not-done ticket, stubs it touches are updated.

## 5. T043 — chrome and Who decides (quick visual pass)

- [ ] Plan, Sprint and Settings show the identical top bar; the project name shows the repo path on hover; the Sprint tab badge equals open HIL + open questions.
- [ ] Settings → Who decides: pick a preset, change one gate's segment; `.agile/policy.yaml` changes and the next gate of that kind is owned accordingly.
- [ ] Dark and light system themes both render.

## 6. T045 — Jira two-way sync (needs an Atlassian Cloud tenant)

Credentials come only from the environment; nothing is written under `.agile/`. The linked project key goes in the host-local `agile.config.yaml`.

- [ ] `export JIRA_BASE_URL=https://<site>.atlassian.net JIRA_EMAIL=<you> JIRA_API_TOKEN=<token>`
- [ ] `agile daemon start` (in one terminal), then `agile sync jira status` → `linked: false`.
- [ ] `agile sync jira link <PROJECT>` → `agile.config.yaml` gains `jira: { project: <PROJECT> }`, no credentials.
- [ ] After one poll interval (default 60 s; `JIRA_POLL_INTERVAL_MS` to shorten): `agile status` lists every issue in the project as a draft ticket with `external.jira`.
- [ ] Edit an issue's summary in Jira, wait one interval: `agile tail --kind ticket_put` shows the local title updated.
- [ ] Move a ticket's status locally, wait one interval: the Jira card moved. Drag the Jira card elsewhere: the next pass puts it back (Agile Agents wins on status).
- [ ] Edit the title locally, then in Jira a minute later: Jira wins. Reverse the order: local wins.
- [ ] `agile sync jira unlink` → status `linked: false`, no further polling.

## 7. T039 / T040 — free-text gate answers and questions (offline-proven; one live glance)

- [ ] On any Needs-you card, type an answer without pressing a button and send. The card stays pending, the EM receives the note, and the run prints `EM deciding gate …` for it.
- [ ] `agile approve <id> --note "yes, but only for the seed script"` resolves the gate; the engineer's next hook call drains the note (visible in its inbox under `.agile/bus/inbox/`).
- [ ] An engineer escalation (or `agile question raise --text …`) appears in the Questions pane and as a card; answering with "Record as decision" creates a `DEC-*` under `oracle/decisions/`.

## When something fails

Re-run with `AGILE_LIVE_KEEP=1` so the temp repo survives, then look at
`.agile/log/events.jsonl`, `.agile/board/hil/`, `.agile/board/questions/`,
`.agile/bus/agents/`, `runs/*.md`, and each vendor session's stderr under
`.agile-daemon-cache/sessions/*.stderr.log` (the resident EM is
`em-resident-*`). MCP tool errors are in Claude Code's own
`~/Library/Caches/claude-cli-nodejs/<worktree>/mcp-logs-agile/`.

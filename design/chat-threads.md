# Chat threads: replies that nest under a message

Status: **decided** (proposed 2026-10-01; Pete settled TH1–TH6 the same day,
recorded as D60–D65 in PLAN.md). Built by T502–T504 in three steps (§8);
T504's choices are in §7a. Mockup: the "Chat threads mockup" canvas (4 screens).

## 1. The problem

A node with several things going on reads as one long line. With four open
questions on the Shop root (2026-10-01), every answer, clarification and
follow-up lands in the same flow, and you scroll between a long question and
what you are writing about it. T499 gave each question card its own box;
this is the next step: a reply can nest under the message it answers, the
way Slack, iMessage and WhatsApp do it, without messages getting lost or
landing in the wrong place.

## 2. What already exists

- **Questions and answers are linked.** A `question` line and its `answer`
  line share `ref: questions/<id>` (QuestionService), so a question's
  conversation can be grouped without a new field.
- **Tangents (T332, D33) are the heavy branch.** A tangent is a child
  conversation node with its own agent; its summary comes back to the
  parent. A thread is the light branch, in place, same agent. A thread that
  grows can be promoted to a tangent (§7).
- **The agent is linear.** A vendor session has one context. Threads are a
  cockpit view; what the agent receives stays one ordered conversation, with
  each reply labelled with the thread it belongs to (§4).

## 3. Decisions

| # | Question | Decision |
|---|----------|----------|
| TH1 (D60) | Threads that aren't questions: side panel or inline? | **Side panel** (Slack's). The main chat keeps one marker per thread at its place in time; the thread opens on the right (full screen on a phone). |
| TH2 (D61) | A thread reply while the agent is mid-turn | **Queued** until the turn ends, as a composer line is today. |
| TH3 (D62) | "Ask about it" separate from "Answer"? | **One box.** It must be possible to talk back to a choice question instead of picking a choice. |
| TH4 (D63) | The coordinator's project chat shows children's questions as threads? | **Yes** (Pete: "I think so"): each child question is a thread on the coordinator's chat, so the "N things wait on you" list stays one line each. |

| TH5 (D64) | Where does a thread start? | **Slack's threads with Confluence's inline anchors** (Pete, 2026-10-01): every chat turn has a **Reply in thread** icon; select some of a turn's text first and the thread is **anchored to that selection**, which it quotes. One turn can carry several anchored threads, one per passage, so a long agent message about many things branches per topic. |

| TH6 (D65) | Can a thread be archived, and taken out of the model's context? | **Yes, in two strengths** (§6a): **Archive** hides it, never re-sends it and tells the agent once to treat it as closed; **Archive and forget** also restarts the agent fresh from a brief that leaves archived threads out, which is the only real way to take it out of the model's context. |

One level of nesting only (Slack's rule): a reply to a reply goes in the
same thread. This alone prevents most of the mess.

## 3a. Starting a thread (TH5)

- **On a whole turn.** Hovering a turn (any turn: the agent's or yours;
  always visible on touch) shows a small **Reply in thread** icon beside
  copy and Branch off. It opens the side panel on a new thread on that
  turn; what you type there is the thread's first reply.
- **On a selection.** Selecting text in a turn shows the floating bar T499
  added for Quote, now with two actions: **Quote** (into the composer or a
  card's box, as today) and **Reply in thread**. The thread is anchored to
  the selection: the panel opens with the passage quoted at the top
  (`> …`), and the passage stays highlighted in the turn, Confluence-style:
  a soft underline tint, with a small count at the end of the passage
  (`2`, amber when the thread waits on you). Clicking the highlight opens
  its thread.
- **Several anchors in one turn.** Each selection makes its own thread.
  Under the turn, one line lists them in passage order: `"banker's
  rounding…" 3 · "sheet per account" 1 · whole turn 2`. Overlapping
  selections are allowed; the later anchor draws over the earlier one, and
  hovering a highlight names its thread.
- **The agent is told what you mean.** A delivered reply reads
  `In a thread on your message of 10:02, about the passage "<quote, as
  data>": <your text>`; a whole-turn thread omits the passage.
- **Anchors never drift.** Turns don't change once written, so an anchor
  is the turn's `ts` plus the passage's start and end in its body and the
  quoted text itself; the quote is shown even if the body were ever
  re-rendered differently (a mismatch falls back to the whole turn, the
  quote still shown).

## 4. Where the agent's reply goes

The agent writes text; it never says which thread it means. In order:

1. **By cause (the rule).** A turn the daemon started because of a thread
   reply posts its output in that thread. The daemon knows which line woke
   each turn (deliveries record the event and the line), so nothing is
   guessed. A turn woken by lines from more than one thread (a batched
   digest) posts in the main flow, with "replies to: ⓐ ⓑ" links.
2. **By the agent, when it says so.** `say` and `ask` take an optional
   `thread`; the brief tells the agent which thread a delivered line came
   from, as `In the thread on <parent, quoted as data>: <text>`.
3. **Never by a model's guess.** A wrong guess is exactly "posted in the
   wrong spot".

## 5. Questions are threads (TH3)

A question card is its thread: the question, your replies, the agent's
clarifications, the answer. One box (T499's), and what you type goes to the
agent as written:

- **A question with no choices:** what you type answers it (as today,
  `resolved_as: reply`); a later reply in its thread reopens nothing, it is
  a thread reply.
- **A choice question:** clicking a choice answers it. Typing instead is a
  reply in its thread that **keeps it open**: the choices stay, and the
  agent either re-asks (the old question is superseded, its thread carries
  on under the new one) or settles it with `settle_question {question,
  answer}` when your reply decided it. The card says "waiting on the agent"
  meanwhile, never "waits on you".
- Either way the question never goes quiet: an open question with your
  reply unanswered by the agent for one finished turn is a Needs me row,
  "Codex didn't settle 'Store amounts how?'".

## 6. Nothing gets missed, nothing lands in the wrong place

- **What needs you never hides in a folded thread.** A question asked, a
  gate or a plan raised inside a thread is in the main flow and in Needs me
  too (Slack's "also send to channel"), with a link to its thread.
- **Every thread leaves a mark in the main flow**, at the point in time it
  started: `↳ 3 replies · last 2m · waiting on you`. Reading the main flow
  top to bottom never skips a thread. Its replies (T513) are your lines and
  each agent turn's last message: what the agent said on the way to it
  folds above it in the panel ("1 earlier message on the way", T509's rule)
  and counts neither as a reply nor as unread.
- **Thread state:** open, waiting on you, waiting on the agent, resolved.
  Derived from its lines; a question thread resolves when its question does,
  and replying again reopens it.
- **Unread:** a dot and count on the thread's mark, on the node's rail row
  (T433's unread marks), and an "Open threads (2)" chip at the top of the
  chat that jumps to the first unread one. Opening a thread reads it (T513:
  on the click itself, and while its panel is open), up to the newest reply
  the page or the rail row knows of, so all three clear together.
- **Move to thread / Move to main.** It changes where a line shows, never
  what the agent already received; the line says it was moved, by whom. Your
  own lines move freely; an agent's line moves only by you, and is recorded.
- **A batched reply is never forced into one thread** (§4.1).

## 6a. Archiving a thread (TH6)

A vendor session's context is the vendor's: no ACP call deletes turns
from it, so a live agent can't truly forget a thread. Two strengths, in
the thread's ⋯ and on its mark:

- **Archive.** The thread folds into "Archived threads (n)" at the end of
  its message's thread line (and out of "Open threads"); its mark and
  highlight go quiet (no count, no tint); it is never re-sent in a digest,
  a brief or a resume digest; its replies stop waking the agent. The agent
  is told once, as a daemon line: `The operator archived the thread on
  "<passage or message, quoted as data>". Treat it as closed: don't act on
  it or bring it up.` Unarchive brings it back (and says so to the agent).
  An archived thread with an open question settles nothing: the question
  is withdrawn (`resolved_as: withdrawn`), and the agent is told.
- **On compaction (Pete, 2026-10-01).** Whenever the agent compacts its
  context, the archived threads go: the summary is told to leave them out.
  Two ways in, per vendor, both to be measured before they're relied on:
  1. **Compact now** (a third strength, between Archive and Archive and
     forget): the daemon sends the vendor's own compact command with the
     instruction, e.g. Claude Code's `/compact <instructions>` (T461 passes
     slash commands through): "Leave out the archived threads: <each one's
     passage or message, quoted as data>." The agent keeps the rest of its
     working memory and sheds the thread. Offered only for a vendor whose
     compact command takes instructions.
  2. **Its own auto-compaction:** where the vendor reads standing compaction
     instructions or runs a pre-compact hook the daemon can answer (Claude
     Code's and Codex's hook lists both have `PreCompact`), the daemon
     supplies the current archived list there, so a compaction the vendor
     starts on its own drops them too.
  Where neither exists, Archive's one-time line is what the agent gets.
- **Archive and forget.** Archive, then the node's agent restarts fresh:
  no `session/load`, a new brief built from the thread with every archived
  thread left out. This really takes the thread out of what the model
  sees. Its cost is said in the confirm: what the agent knew only from its
  own session (never written to the chat) is gone too. Not offered while
  the agent works on a turn (it waits), nor on a node whose agent runs
  without resume.
- Archiving is the operator's alone (human-only write), recorded as its
  own append-only line (§7a; a thread line is never rewritten, so not on
  the first reply), and undone the same way. Nothing is deleted.

## 7. Data

- One optional field on a thread entry, `thread`: the `ts` of the thread's
  first reply, or `questions/<id>` for a question's. Old threads load as
  they are; question and answer lines are grouped by their `ref` until they
  carry `thread`.
- The thread's first reply also carries its anchor (TH5): `anchor:
  {entry: <the turn's ts>, start, end, quote}` (start and end absent for a
  whole-turn thread; `quote` capped at the quote limit). Strict schema in
  packages/shared.
- No new record kind. Thread state and unread are derived.
- `settle_question` is a new agent verb (D24 verbs), human-visible as an
  `answer` line `resolved_as: settled`.
- **Promote to tangent:** a thread's ⋯ makes it a tangent (T332), its lines
  quoted into the new conversation; the thread ends with a link to it.

## 7a. As built (T504)

- **Changes are lines of their own.** A thread line is never rewritten, so
  a move, an archive, its undo, a promotion and a compaction are each one
  append-only `event` line by `human` carrying `op` (`ThreadOpSchema`:
  `move {entry, to}`, `archive {thread, forget?}`, `unarchive {thread}`,
  `promote {thread, node}`, `compact {threads}`), checked by the store
  (a message moves, not a thread's first reply; into an open thread on an
  earlier turn, never a line threads are on; only an open thread archives,
  only an archived one restores). Where a line shows and which threads are
  archived are read back from them, the latest winning.
- **Display only.** The derived threads apply the moves (`chat_moves` on
  the node page says what moved, from where); the agent's briefs and
  `read_stream` never carry move, archive or compact lines (a promotion
  stays: the thread goes on as a tangent).
- **Archive.** Its lines (by field, by cause, moved in) leave every brief
  and `read_stream`; its pending replies are superseded and a new one is
  refused; a question asked in it is `withdrawn`. The agent is told once by
  a `thread_archived` routed event that is **quiet**: it rides the next
  digest or brief and never starts a turn or wakes an agent on its own
  (archived and restored before it was heard, nothing is said).
- **Archive and forget.** Refused while the agent works on a turn; else
  the archive, then the agent restarts fresh with its vendor, model and
  effort (no `session/load`), with no notice. A session started before a
  forget is never resumed later (its id's time is before the line).
- **Compact now.** Only Claude Code's `/compact <instructions>` is assumed,
  offered while its agent runs and advertises `compact`; no vendor's own
  auto-compaction is hooked yet (design/spike-findings.md C6; LIVE-CHECKLIST
  §23 measures both).
- **Promote to tangent** is a node create with `seed_thread` (beside T332's
  `seed_line`): the tangent opens with the passage and the thread's lines
  (the newest 30), quoted; the parent's thread links to it.

## 8. Build order

1. **T502 — question threads.** Group each question with its answer and the
   agent turns it caused; a choice question stays open on a typed reply
   (§5), `settle_question`, the "didn't settle" row. Child questions as
   threads on the coordinator's chat (TH4). No new field yet.
2. **T503 — reply in thread on any turn, or on a passage.** The `thread`
   field and the anchor, the Reply in thread icon on every turn and in the
   selection bar, the highlights and counts (§3a), placement by cause (§4),
   `thread` on `say`/`ask`, the side panel, the main-flow marks, thread
   state, unread and the "Open threads" chip.
3. **T504 — moving, promoting and archiving.** Move to thread / main,
   promote to a tangent, Archive and Archive and forget (§6a).

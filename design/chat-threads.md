# Chat threads: replies that nest under a message

Status: **decided** (proposed 2026-10-01; Pete settled TH1–TH4 the same day,
recorded as D60–D63 in PLAN.md). Not built yet: T502–T504 build it in three
steps (§8).

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

One level of nesting only (Slack's rule): a reply to a reply goes in the
same thread. This alone prevents most of the mess.

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
  top to bottom never skips a thread.
- **Thread state:** open, waiting on you, waiting on the agent, resolved.
  Derived from its lines; a question thread resolves when its question does,
  and replying again reopens it.
- **Unread:** a dot and count on the thread's mark, on the node's rail row
  (T433's unread marks), and an "Open threads (2)" chip at the top of the
  chat that jumps to the first unread one.
- **Move to thread / Move to main.** It changes where a line shows, never
  what the agent already received; the line says it was moved, by whom. Your
  own lines move freely; an agent's line moves only by you, and is recorded.
- **A batched reply is never forced into one thread** (§4.1).

## 7. Data

- One optional field on a thread entry, `thread`: the `ts` of the line that
  started the thread, or `questions/<id>` for a question's. Old threads load
  as they are; question and answer lines are grouped by their `ref` until
  they carry `thread`.
- No new record kind. Thread state and unread are derived.
- `settle_question` is a new agent verb (D24 verbs), human-visible as an
  `answer` line `resolved_as: settled`.
- **Promote to tangent:** a thread's ⋯ makes it a tangent (T332), its lines
  quoted into the new conversation; the thread ends with a link to it.

## 8. Build order

1. **T502 — question threads.** Group each question with its answer and the
   agent turns it caused; a choice question stays open on a typed reply
   (§5), `settle_question`, the "didn't settle" row. Child questions as
   threads on the coordinator's chat (TH4). No new field yet.
2. **T503 — reply in thread on any message.** The `thread` field,
   placement by cause (§4), `thread` on `say`/`ask`, the side panel, the
   main-flow marks, thread state, unread and the "Open threads" chip.
3. **T504 — moving and promoting.** Move to thread / main, promote to a
   tangent.

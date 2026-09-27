# Cockpit UI — design system and UX rules

Status: 2026-09-26 (Phase 15, T360–T390; conversation flows T435). Follow-ups: `cockpit-ui-followups.md`. Applies to `packages/ui/app`. Where this
file and `cockpit-design.md` §9 disagree on *how the cockpit looks or reads*,
this file wins; on *what the cockpit does*, the design docs and the Decisions
log still decide.

The cockpit is a tool a developer keeps open all day. It should feel like
Linear, the Claude desktop app or T3 Code: quiet, dense, fast, obvious. Every
screen answers two questions without reading: **what needs me?** and **what
is running?**

## 1. Principles

1. **One obvious next action per screen.** A page has at most one primary
   (filled) button. Everything else is secondary, ghost, or in the `⋯` menu.
2. **Say what is happening in words.** Status is a word with a dot ("Working",
   "Needs you", "Ready to merge"), never a bare colour or an enum
   (`waiting_on_you`, `pr_open`). No design-doc section numbers (§5.7), ids
   (`K-01…`, `P-01…`) or file names (`config.yaml`) in the primary text. Ids
   may appear in a `title` tooltip or a "Copy id" menu item.
3. **The chat is the node.** A node's page is a conversation with its agent.
   Anything that needs the human (a question, a gate, a plan, a merge) appears
   *in the conversation*, right above the composer, and is answered there.
4. **Defaults, not forms.** Creating a node starts its agent with the default
   model. Starting a stopped agent is one click. Pickers are optional
   (a chevron next to the button), never a mandatory step. T423: a model is
   picked in one place, the composer's model chip (the header's Start with…
   aside), and picking never starts or restarts anything by itself.
5. **Progressive disclosure.** Rarely used controls (autonomy, tracker, waits
   on, + Repo, Review, Close, Delete) live in the details panel or the `⋯`
   menu, not as a row of equal buttons.
6. **Calm by default.** Neutral surfaces; colour only for status and the one
   primary action. No uppercase-everything labels, no borders around every
   line, no orange buttons for ordinary actions.
7. **Keyboard first.** `⌘K`/`Ctrl K` the command palette (on a node's page
   "This node" first — its header's and ⋯ menu's own actions — then recent
   nodes, what waits on you, nodes, projects, views, actions; T416), `?` the shortcut list, `n` new node,
   `/` filter the tree, `g` then `i`/`d`/`k`/`r`/`e`/`s` jumps to Needs me,
   Director, Knowledge, Running, Events, Settings; `j`/`k` in Needs me, and
   A/B (or 1/2) on a focused question card (T416); T445: on a node's page
   `j`/`k` (not while typing) open the next or previous node the tree shows;
   `Esc` closes any overlay, Enter sends, Shift+Enter is a newline (New
   node's goal excepted: §7 "Submit keys"). The `?` list (`Shortcuts.tsx`)
   names only keys that work.

## 2. Vocabulary (UI text)

| Say | Not |
|---|---|
| node | stream (the CLI keeps `agile stream`; the UI says node) |
| project | — |
| Needs me | inbox (in headings; "inbox" is fine in prose) |
| Merge | Land |
| Start agent / Stop agent | Attach / Detach, Start/Restart as unexplained verbs |
| Knowledge (rules, standards, architecture, decisions) | "rules" for all of it |
| Ready to merge | done / waiting on you |
| Not started | idle (for a node whose agent never ran) |

Roles keep their design names but are explained where shown: **Conversation**
(talks, researches; no repo), **Work** (one repo, one branch), **Coordinating**
(splits work into parts), **Project** (the root).

## 3. Layout

```
┌──────────────┬──────────────────────────────────────────────┐
│ Sidebar 256  │ Page header (title, status, actions)          │
│  brand · ●   ├──────────────────────────────────────────────┤
│  Needs me  3 │                                              │
│  Director    │   page content (scrolls on its own)          │
│  Views ▸     │                                              │
│  Knowledge   │                                              │
│ ─ Projects ─ │                                              │
│  ▾ Shop    + │                                              │
│    ● node    │                                              │
│  ▾ Blog    + │                                              │
│ ──────────── │                                              │
│  Settings    │                                              │
└──────────────┴──────────────────────────────────────────────┘
```

- The sidebar is fixed; the main column scrolls. Below 900px the sidebar is a
  drawer opened from a menu button in the page header.
- A node page is three regions: header, chat (centred, max 760px), and an
  optional **details panel** on the right (320px, toggled, remembered per
  viewer in localStorage; hidden below 1200px unless opened). T436: its tab
  is in the URL (`?node=<id>&tab=diff`; the first tab is no `tab=`), so a
  reload, Back/Forward and a pasted link keep Changes, Plan…; a tab switch
  rewrites the entry rather than adding one (`lib/shell.tsx`).
- Pages other than a node use a centred content column (max 960px) with a
  `PageHeader`.
- A project's root node opens on an **Overview** tab (T387): counts by status
  (your move first, each a filter), its nodes grouped by status, its repos and
  its recent activity; the root's chat is the next tab. T424: each count is
  one status key (§6) with that status's own dot and word ("1 needs you",
  "1 blocked", "3 not started", "1 closed"; a conversation that replied counts
  as "replied"), and the counts are the list's own grouping
  (`lib/overview.ts` `overviewGroups`), so a count always equals the rows it
  filters to. The list's groups are **Your move**, **In progress**, **Not
  running** and **Finished** (folded) — never a status's own word. T447
  (audit r7 #19): within a group the list reads by **top-level node**: each
  heads a branch (its row, then the counts over what is under it, "1 needs
  you · 2 working · 3 merged"), with everything under it nested below, the
  most pressing first; a branch sits in the group its top-level node reads
  as (a coordinator reads as its most urgent part, §6). A branch folds
  (its chevron); Finished's start folded, and past 30 nodes every branch
  starts folded. The counts count the nodes that read as themselves, not a
  coordinator that reads as one of its parts, and a clicked count lists its
  nodes on their own, wherever they sit. A **Filter nodes** box (`/` while
  the Overview has focus; Esc clears it) keeps the nodes whose title has its
  words, under their top-level node (a matching head keeps its branch).
  Recent activity says a child's status in the Events words ("Schedule
  posts is ready to merge", `childStatusPhrase`). Other nodes open on
  their chat. A Needs me card opens its node on the chat, root or not, since
  that's where the card is (T403).

## 4. Tokens

Defined once in `styles.css` `:root` (light) and the dark blocks. Use the
variables; never hard-code a colour in a component.

- Surfaces: `--bg` (app), `--bg-sidebar`, `--bg-panel` (cards, inputs),
  `--bg-raised` (menus, dialogs), `--bg-hover`, `--bg-active`, `--bg-inset`
  (code, diff).
- Text: `--text`, `--text-muted`, `--text-faint`.
- Lines: `--border`, `--border-strong`.
- Accent (primary buttons, selection, focus ring): `--accent`,
  `--accent-hover`, `--accent-weak`, `--accent-text` (text on accent).
- Status tones, each with a `-weak` background: `--amber` (needs you),
  `--blue` (working), `--green` (ready, success), `--purple` (merged),
  `--red` (blocked, error, danger), `--gray` (idle, not started, closed).
- Type: `--font-sans`, `--font-mono`; sizes `--text-xs` 11px, `--text-sm`
  12px, `--text-md` 13px (UI default), `--text-lg` 15px (chat body),
  `--text-xl` 18px (page title).
- Radius `--radius-sm` 6px, `--radius` 8px, `--radius-lg` 12px; shadows
  `--shadow-sm`, `--shadow-md`, `--shadow-lg`; `--focus-ring`.

## 5. Primitives (`components/ui.tsx`, `components/Icon.tsx`)

Use these; don't re-invent a button or a menu in a screen.

- `Icon name size` — inline SVG, `currentColor`. Add new glyphs to `Icon.tsx`
  (24×24, 1.75 stroke, Lucide-style paths).
- `Button variant(primary|secondary|ghost|danger) size(sm|md) icon busy` —
  renders `.cr-btn`. `busy` shows a spinner and disables.
- `IconButton icon label` — square, `aria-label` and tooltip from `label`.
- `Menu trigger items align` — dropdown; items `{label, icon, onSelect,
  danger, disabled, hint, testid}` or `'separator'`; arrow keys, Esc, click
  outside.
- `Popover` — the positioning shell `Menu` uses, for custom content (the
  composer's model picker, `ModelChip`).
- `Dialog open onClose title description footer size testid` — modal with
  focus trap, `role="dialog"`, `aria-modal`, Esc and backdrop close.
- `ConfirmDialog` — title, body, confirm label, `danger`.
- `Tabs items value onChange label` — `nav` of buttons with `data-tab`,
  optional counts.
- `Segmented` — a small segmented control for filters.
- `Badge tone icon` — a pill for counts and states.
- `StatusDot status` / `StatusPill status` — from `lib/status.ts`
  (`nodeStatus(row)`), which is the only place a node's status is decided for
  display. `StatusDot` keeps `class="cr-dot" data-dot=…` for the e2e suites.
- `EmptyState icon title body actions`.
- `PageHeader title icon subtitle badge actions` (`<header class="cr-page-hd">`):
  T416, one treatment for every view but a node's — icon and title on one
  row, a one-line subtitle under it, actions on the title's row — at one
  height (`--page-hd-h`) and top padding, in the one column (`--page-col`,
  960px), so the title never moves between views. The Director's too (its
  details toggle is the actions slot).
- `Field label hint error` — form row wrapper.
- `Spinner`, `Kbd`.
- `useToast()` — transient success/info/error messages with an optional
  action ("Undo"). Errors that block the user's next step stay inline. On a
  page with a composer (a node, the Director) toasts sit just above it,
  never over Send (T416).
- `RepoIcon remote` / `repoKindLabel(remote)` — a repo's host glyph (local
  drive, GitHub, GitLab, a folder for a local clone, a globe otherwise) with
  an SSH mark; the label reads "Local only", "GitHub · SSH", "Local clone".
- `Dialog` renders in a portal on `document.body` and stops its submit from
  bubbling, so a dialog may open from inside another dialog's form (New
  project → Add repository). Single-key shortcuts (`isShortcut`) are off
  while any dialog is open. It gives focus back to what had it when it
  opened (a ⋯ menu's trigger, a button); T445: where that is gone, the
  screen puts focus somewhere that goes on from there (§7 "Focus after an
  action").

Screen-level building blocks built on these (reuse them rather than copy):

- `Chat.tsx` (`ChatScroll`, `MessageList`, `ThreadBody`, `Thinking`,
  `StepsFold`) and `Composer.tsx` — the node chat, independent of a node (the
  Director uses them too). Rules live in `lib/chat.ts`; the agent's steps
  (T392: live while it works, folded as "Worked through N steps" in each
  reply) in `lib/steps.ts` and `useSteps` (T399: the Director passes its own
  read, `getDirectorSteps`).
- `DecisionCard.tsx` (exported as `Card` from `Inbox.tsx`) — every inbox item
  kind, in the list and (with `full`) at the end of a node's chat. Choices
  come from `choicesOf(item)` in `lib/inbox.ts`.
- `AddRepo.tsx` (`AddRepoDialog`) — add a local folder (autocomplete and a
  folder browser) or clone by URL.
- `Pickers.tsx` — searchable picker fields (parent node, repository).
- `CommandPalette.tsx` (matching in `lib/palette.ts`) and `Shortcuts.tsx` —
  the ⌘K palette and the `?` list, on `Dialog`.
- `Lenses.tsx` (Repos, Running, Dependencies, Events; logic in
  `lib/lenses.ts`) — event titles (`eventTitle`) and routing words
  (`ROUTE_REASON`) are shared with a node's Activity tab and the Director.
  T424: Running follows the rail's "Show only this project" (the URL's
  `project`): only that project's nodes, their paths without the project's
  name (`lensPath`), its subtitle "In Shop: …" and **Show all projects** when
  others run elsewhere; its header and rows share one grid (CSS subgrid), so
  Status is as wide as its widest pill and Node gets the room (at least
  280px); its subtitle counts one status each, in the Overview's words.
  Dependencies shows both ends' statuses as `StatusPill`s. T436: a
  `child_status` event reads in the status words (`childStatusPhrase`: "Add
  CSV import is ready to merge", "… replied", "… is blocked"), never the
  daemon's enum or "no progress line"; an overlap wears the rail's neutral
  two squares in Events, Activity and the Repos lens.
- `lib/defaults.ts` `resolvedFor` — what a new session starts with, with the
  project step (P5) before the repo's, as attach resolves it.
- `SessionPicker.tsx` (T423; pure half in `lib/defaults.ts`: `modelGroups`,
  `modelSelectOptions`, `sameSession`, `modelChip`) — the one model picker.
  `ModelChoice` lists the models by name (`modelLabel`) grouped by vendor
  (a vendor with no list reads as its default model, under "Other agents";
  aliases like `opus` only when something already uses them), "Other model…"
  for an id typed by hand, and Effort as a `Segmented` where the vendor takes
  one (`vendorTakesEffort`; otherwise it says so). `ModelChip` is the
  composer's chip and its popover; `SessionPicker` the Start with… / reviewer /
  Resolve dialog around the same list; `SessionFields` the three selects by
  name for Settings (with what each inherits) and New node. The known models
  are `KNOWN_MODEL_IDS` in `packages/shared` (served as `known_models`).
- `lib/autonomy.ts` (T423) — the autonomy levels in words for the details
  panel ("Advise — proposes, you apply", a sentence per level, "Inherits
  Advise from the project", what Run asks); the Director's words are its own
  panel's (`DIRECTOR_AUTONOMY`).

## 6. Node status (`lib/status.ts`)

One mapping from a cockpit row to what the UI shows, in precedence order:

| Key | When | Label | Tone |
|---|---|---|---|
| merged | human landed | Merged | purple |
| closed | human closed | Closed | gray |
| needs_you | waiting on you, or the agent asked | Needs you | amber |
| blocked | agent blocked | Blocked | red |
| pr_open | done, PR open | PR open | blue |
| ready | done, a branch to merge | Ready to merge | amber |
| no_changes | done, a branch with no commits beyond its target (T380) | No changes | amber |
| merged_outside | done, a branch already in its target, merged by hand (T412) | Already merged | amber |
| done | done, nothing to merge; a coordinating node or a project root with parts only once every part is merged or closed (T447); a conversation reads "Replied" | Done / Replied | green |
| waiting | waiting for the plan, or waits on another node | Waiting | gray |
| working | a turn in flight | Working | blue (animated) |
| not_started | its agent never ran (any role: T424, a project root or a coordinator too — the daemon's `never_started`) | Not started | gray, hollow |
| stopped | you stopped it | Stopped | gray, hollow |
| idle | anything else | Idle | gray |

**A node with parts** (T447, audit r7 #2): a coordinating node or a project
root whose children include work or coordinating nodes (conversations are
not parts, D42) reads as the most urgent of its own state and its open
parts': Needs you > Blocked > Ready to merge (or No changes, Already merged)
> Working > PR open > Waiting > Not started > Stopped > Idle. Its own
question, block, work or branch still counts; its own Merged and Closed win.
It is **Done** only when every part is merged or closed (a coordinating part
counts once it is Done itself). The UI derives this from the frame's rows
(`withParts`, applied as each frame arrives in `lib/feed-context.tsx`), so
the rail, the header, the Overview and Children agree; the Delivery panel
reads the node's own status (`ownStatusKey`). The header's line and each
child card say it in words: "2 of 4 merged · waiting for web part", naming
the part to open (however deep). The daemon matches it: a coordinator's own
`child_status: done` goes up only on a turn that ends with every part merged
or closed (`events/producers.ts` `subtreeFinished`), not after every turn.

The `.cr-dot data-dot` colour (amber/blue/grey/green/red) follows the status
(`statusDot` in `lib/streams.ts`, T447 audit r7 #9): amber for your move
(Needs you — a question, a plan, a gate or a proposal — Ready to merge, No
changes, Already merged), red for Blocked, blue for Working and PR open, green
for Merged, grey otherwise. A pill drops the needs-you and blocked halo but
keeps a hollow dot's ring (stopped, waiting).

## 7. Patterns

- **Page header**: title (18px, 600), optional status pill and subtitle,
  right-aligned actions: one primary, then secondary, then `⋯`. Every view
  but a node's uses `PageHeader` (§5). A node's Start agent is a split
  button: one click starts the default; its chevron is **Start with…** (the
  model list in a dialog, T423; ⌘K's "This node" has it too). The ⋯ menu has
  no model choice of its own (Restart agent keeps the model). While the
  daemon is away, Start, Stop and Merge are off and say "Reconnecting to the
  daemon…". T436: with a decision card open at the end of the chat (a plan
  to approve, a gate), Start is secondary: the card's button is the page's
  one primary.
- **Lists** are rows (40px, hover background, click opens), not stacks of
  bordered cards. Cards are for things that need a decision.
- **The rail's marks** (T424): a node whose changes overlap another live
  node's (T227) carries a neutral two-squares mark (`Icon` `overlap`, never
  the alert triangle, which means blocked or critical). It is a button: its
  tooltip names the other node and the files ("Overlaps Fix rounding in
  totals on src/ledger.ts") and a click opens that node; with several, a
  small menu of them. A parent or a project carries it only while folded,
  for the nodes hidden inside it (`lib/tree.ts` `overlapMark`). Events, a
  node's Activity and the Repos lens show an overlap with the same neutral
  mark (T436). Rows drag
  (T333): a 6-dot grip shows left of a row on hover (not on touch), `grab`
  over it, and the dragged row dims. The legend (the `?` by Projects) lists
  both marks, and "Drag a row to move it (or ⋯ → Move to…)". T436: its
  statuses include **Replied** after Done (a conversation that answered),
  each dot drawn from the row it stands for, as the rail draws it.
  T447 (audit r7 #20): a long title truncates in the middle — its head gives
  way ("Schema change f… emails") and its last word or two always show
  (`splitTitle`, up to 16 characters) — so alike titles stay apart at any
  depth and on a phone; the row's tooltip has the whole title. Chosen over
  a draggable rail: it needs no stored width and works in the phone drawer.
- **Decision cards** (`Card` in `Inbox.tsx`): a title line (kind icon, what it
  is, node path, age), the body, and actions on one row, primary first.
  A question with `options` shows each as a button; typing is always allowed.
  A finished node with nothing to merge (the row's `nothing_to_merge`) reads
  "Finished, no changes" and offers Close node instead of Merge, in Needs me
  and at the end of its own chat.
  A Merge card says how much it merges ("2 files +2 −1", the row's
  `diff_stat`), and its View changes opens the Changes tab (T410).
  A branch already merged outside the cockpit reads "Already merged" and its
  card offers Mark as merged; a finished node that waits on another reads
  "Waiting", and its card names what it waits on instead of offering Merge
  (T412). T416: a Ready to merge card shows the agent's last progress line
  (one line in the list) and "Overlaps <node>" when its changes overlap —
  never the daemon's stock sentence; a Blocked card takes a reply ("Reply to
  unblock…", a message to its node); A/B (or 1/2) pick a focused question's
  choice, as its keycaps say; Answer is secondary until text is typed, then
  primary. While the daemon is away, every card action is off and says
  "Reconnecting to the daemon…".
  T445 (audit r7 #5): the list holds still under the pointer. A card
  decided in Needs me stays in its place, at its height, for a moment
  (~1.5 s) after it leaves, collapsed to its outcome ("Merged into main",
  "Applied", "Plan approved", "Answered"); then it goes, and for ~400 ms a
  pointer's click on the list is ignored (keys still work), so a second
  click never merges or applies the card that moved under it
  (`lib/inbox.ts` `cardOutcome`, `withDecided`).
- **Chat**: human lines right-aligned bubbles; agent lines as prose with the
  agent's name; daemon lines as one-line system rows (icon + muted text) that
  collapse when there are several in a row. A long message folds with "Show
  more". Hover actions on a message: Copy, Branch off (conversations).
  T446 (audit r7 #6): what a coordinator or the Director did on its own — a
  change it applied, a proposal it made, a node it created — is a system row
  with its own icon (a bot, the Director's sparkles), never its chat message,
  in words: "Added a part: **Add an RSS field** (web)", "Linked web to wait
  on api", "Approved a routine change to Key file (v2)", "Created
  **Newsletter signup** in Blog with 2 parts"; the node it made is bold and
  opens it. What you applied says "you" ("You added a part: …", "You
  approved plan v1"). A part's contract proposal is a row in words too
  ("… proposes a change to Key file: …. Why: …"), and lines meant for the
  agent (the `plan_write` instruction) are `agent_only`. "Node created" reads
  the same whoever created it. T446 (#17): a coordinator's routine wake (not
  your line or answer) folds into its reply — "Woke for a merge · 01:14" in
  the reply's header, without the "Coordinator started" and "Agent finished
  its turn" rows; a wake whose turn wrote no reply is one muted row, "Woke
  for a merge · nothing new".
- **Composer**: rounded box, auto-growing textarea (1–10 lines), a model chip
  (with how full the live agent's context is, T411),
  a hint of what sending will do ("Starts the agent", "Queued until the
  current step ends", "Answers the question"), and Send / Stop. A message to
  a node whose agent never ran or was stopped starts it (`say` with
  `start: true`) — except a part waiting for its coordinator's plan.
  T423: the chip names what the next message runs — the live agent's model
  (a green dot), else the default here — and opens a popover (`ModelChip`,
  never a dialog) with the one model list. A pick changes nothing until you
  send, and the chip shows it in the accent: with no live agent the message
  starts one with it (`say` with `start` and `session`); with a live agent on
  another model it restarts the agent with it (Stop, then the same start) and
  the message is its first prompt ("Restarts the agent with …, then sends
  this."). A pick lasts one message: the chip then goes back to the default,
  as its tooltip says. T436: the draft is kept per node in this tab's
  `sessionStorage` (`lib/drafts.ts`), so a reload keeps it too. Where a line starts nothing (a bare project root, a
  part waiting for its plan) the chip only names what runs. With a
  question open the composer answers it ("Answering the question above",
  the whole question in its tooltip); the question reads once, in its own
  chat line, and its card above the composer shows only its choices (T416;
  with several open, one line of each to tell them apart). A send that
  fails says so under the composer ("Couldn’t reach the daemon; your
  message wasn’t sent."), keeps the draft and offers Retry.
  T447 (audit r7 #15): the composer holds the draft (`DraftComposer`), so a
  keystroke re-renders the composer, not the page and its chat; and a long
  thread renders its newest 80 rows, with a "Show 80 earlier messages" row
  above them that also loads by itself as you scroll up (the view stays
  where you were). Ctrl/⌘+F shows every row, so the browser's find sees them.
- **Forms** in dialogs; labels above inputs; the submit button is the primary
  action and says what it does ("Create project", not "OK").
- **Settings** controls save on change and say "Saved" in place (a model id
  typed under Other… when you press Enter or leave the field; Esc puts it
  back). T423: Agents names models ("Claude Opus 5.5") and what an unset
  field inherits ("Inherits Claude Opus 5.5"; each card says from where),
  never ids or `inherit (…)`, and has no Save buttons. T436: in the order
  they win — Global default, Per project, Per repository — and two or more
  repositories that set nothing fold into one row ("5 repositories use the
  global default", their names beside it) that opens to their cards.
- **Details panel** (T423): it shows the running model but never picks one
  (the chip and Start with… do). On a coordinating node or a project root,
  one **Autonomy** group: a labelled row per agent — Coordinator, and on a
  root the project's Director — each level in words ("Advise — proposes, you
  apply") with its sentence under it (the Director's are its own panel's
  words), and "Inherits Advise from the project" on a node that follows its
  project. A change saves at once, except one up to Run (the agent acts
  without asking), which confirms first (`ConfirmDialog`). A root's
  **Project** group (its repositories; its tracker: None, Jira or Linear)
  has one Save, with Cancel, once something in it changed. T436: an unsaved
  change is kept per project (`sessionStorage`) across navigation and a
  reload, until Save or Cancel, or until the saved settings change under it.
  **Delivery** shows once the node has a branch; its badge says the node's
  status in the header's word and tone where it is about delivery ("Ready to
  merge" amber, "No changes", "Already merged", "PR open", "Merged"), and
  only Conflict, Held, "Can merge" (commits on a node still going) and "Not
  ready" in its own words. "Ask an agent to review…" shows once the branch
  has commits.
- **Errors**: inline under the control that caused them, in words a user can
  act on. A refused action names the reason and, if there is one, the fix.
  T416: a refused merge reads "Couldn’t merge. <reason>." under the card's
  or the header's Merge (the daemon's "merge refused:" prefix dropped, the
  reason capitalised, `lib/errors.ts`), with the fix it names as a button
  ("Ask the agent to rebase" sends the agent a prepared message; "Stop the
  agent"). A load that fails shows only the error and Try again, never the
  empty state beside it. The daemon away: a bar at the top of the main
  column (in the flow, never over a page's controls), and write buttons off
  with "Reconnecting to the daemon…".
- **Empty states** say what the place is for and give the one action that
  fills it. T445: the Plan tab's "No plan yet" has **Start the coordinator**
  (one never started, a project's root included) or **Ask it to plan** (one
  that ran: a message asking for the plan, which starts it again) while
  nothing runs there; a project's root with no agent running says, in its composer,
  "Write to the project — or press A to ask it a question", with **Ask the
  project a question** in the empty chat.
- **Focus after an action** (T445, audit r7 #13): the keyboard never loses
  its place to `<body>`. When the focused card leaves Needs me, the card that
  took its place has the focus (a card keeps the focus itself while its
  action runs); New node opens the new node with its composer focused (as
  Ask does, `lib/ask.ts` `focusComposerOn`); adding a repository from Needs
  me's first step puts the focus on the next step (Create a project), and
  from Settings on Add repository.
- **Destructive actions** confirm (`ConfirmDialog`) or offer Undo (toast).
  Merge asks the first time ("Merge “<node>” into main (2 files)?", with
  "Don’t ask again" remembered per browser), then is one click: a merge
  can't be undone from the cockpit (T416).
- **Reviewing a diff** (T393): a line's gutter (or its number, or `C` on a
  focused line) opens a comment under it; comments collect in a review bar
  ("3 comments on 2 files") whose Add to message puts one formatted review
  in the node's composer and opens the chat. It never sends by itself.
  In the comment box Enter adds and Shift+Enter is a new line, as in the
  composer; the Changes tab's count is the unsent comments, with a comment
  glyph (T426). T436: the comments are kept per node in this tab's
  `sessionStorage`, so a reload keeps them; leaving the page while one is
  unsent asks first (`beforeunload`); a merged, closed or deleted node's are
  dropped. Merge (the header's or a card's) asks "1 review comment on
  <node> isn't sent. Merge anyway?" with **Add to message** as the other
  button (the review joins the node's draft and its chat opens); that
  question stands in for the first-Merge one.
- **Forms check as you type** (T426): New project says a taken name under
  Name before Create; a short picker with no search box still takes typing
  (the letters pick the first match, Enter chooses it); a list's
  "Add a repository…" row is pinned below its scroll. T435: in a picker with
  a search box, typing moves the highlight to the first match that isn't
  pinned (Top level, No repository stay listed whatever you type) — or to
  the pinned one when its own words match — so a name typed and Enter picks
  that name (`lib/tree.ts` `pickHighlight`).
- **Submit keys** (T435): a box of prose submits on Enter, Shift+Enter is a
  new line and Ctrl/⌘+Enter works too — the composer, a diff comment, Ask,
  Send to <parent> and Turn into work, each saying its keys ("↵ to send ·
  Shift ↵ new line"). New node is the exception: its goal is a
  long description, often several paragraphs, so Enter is a new line there
  and Ctrl/⌘+Enter creates (as its footer says); Enter in its Title creates.
- **Knowledge you write** is yours to accept, so Add knowledge's primary is
  **Add** (it applies at once); **Save as proposal** keeps it in To review.
  A checked rule still needs its two examples before Add (T426).
- **Editing in place**: a node's title (click it) and goal (Edit on the goal
  card) change where they are read; Enter or leaving saves, Esc cancels. The
  Goal card shows only when it says more than the title and never on a root;
  otherwise the goal is in Details → About, with Edit (T413).
- **A node's Activity** reuses the Events rows (icon, title, the event's
  words, relative time) with the routing reason as a small chip ("a part of it
  changed"); its Knowledge tab reuses the Knowledge list row (T413).
- **What the agents did on their own** (T446, audit r7 #7): an
  `autonomy_applied` event reads "Coordinator added a part · Add an RSS
  field (web)" (the Director's, "Director created a node and its parts";
  yours from a proposal, "You approved a contract change") in Events, the
  node's Activity and the Director's Activity. Under it, a link per node it
  created, and **Undo** — delete them, as Delete does, with Restore in the
  toast — while every one is open and none has started. It is a record:
  "For the record", never sent to an agent.
- **Two nodes, one name** (T446, #18): a split names its parts "<node> ·
  <repo>" ("Rotate the API keys · api"). Where two open nodes still share a
  title — an overlap mark, an Events row, a Ready to merge card's
  "Overlaps …" — the title carries its project ("Shop › …") or, in one
  project, its parent (`lib/names.ts` `distinctTitle`).
- **A held proposal's card** (T446, #6) says the level it is held at and what
  Apply does: "Shop is at Advise: nothing changes until you apply. Apply
  creates the node and starts it." The level opens the project, where it is
  set.
- **Ids stay out of primary text**: a branch reads as its slug
  (`add-csv-import`), the full name on hover and in Copy; worktree paths sit
  behind a Copy button (T413).
- **Ask** (T419, D42): `a` anywhere opens one box aimed at the open node (the
  Director elsewhere); its picker re-aims it. About a node it makes a
  conversation under that node, in its own thread, so the node's work goes on
  undisturbed; about the Director it is a line in the Director's thread. A
  conversation's chat opens with its question as your message, never a Goal
  card. T435: the picker shows each node's status dot, with a project's merged
  and closed nodes last; the question sits in the thread's own list (one day
  divider), right after "Node created"; and the new conversation opens with
  its composer focused, for a follow-up.
- **An answered conversation** (T435): once its agent has replied, its
  header offers what follows from the answer — **Send to <parent>** and
  **Turn into work…**, both secondary — instead of Restart agent, which would
  only ask its question again (⋯ keeps Restart agent; the composer
  continues the talk). While its agent works, the header has Stop as ever.
- **Send to parent** (T421, D42): in a conversation under another node, a
  reply's hover action (or ⋯, or T435 the header) sends a conclusion up. It
  lands there as your message, so that node's agent acts on it as on
  anything you type. T435: not offered when that node is merged or closed
  (nothing there acts on it). The box counts characters as it nears its cap
  (`SEND_UP_MAX_CHARS`, "2,612 / 3,000"); past it Send is off and says
  "Shorten it, or send the key point". A refusal reads in words
  (`lib/errors.ts` `sendUpFailure`), never the schema's "invalid send-up: …".
- **Replies you haven't read** (T429): a node that answered and has no
  Needs me card (a conversation, a root, a coordinator) is unread until its
  page is open in a visible tab. Needs me lists them first under **Replies**
  (open, ✓ to mark read, Mark all read), the sidebar's Needs me shows a dot,
  and one notification says "Replied: …" while you're away (T388's
  setting). Read marks are per browser (localStorage); a first visit starts
  with everything read. T436: a reply's row wears the rail's role glyph and a
  clipped first line of what it said (its node's last agent line, else its
  progress line; read once per reply from the node's page read, as the frame
  carries no reply text), and ⌘K's Needs me group lists it first as "Read
  reply: <title>", opening its chat. T433: the node's row in the rail is bold with a blue
  dot, and the Director counts too: its reply marks the sidebar's Director,
  heads Replies, and is read when its page is on screen (the frame's
  `director.replied_at`). T437: a reply is an agent's (or coordinator's, or
  the Director's) line that follows one of yours; a new node's goal is the
  first question. The row's `answered_at` marks it, so a node that talks on
  its own, or a coordinator reporting up, isn't "Replied".
- **Needs you, and failures** (T437): a node with an open gate, plan
  approval or proposal (the row's `pending_decision`) reads "Needs you", not
  "Working". An agent that couldn't start (its vendor missing, the spawn
  failing) blocks its node with "The agent couldn't start: …", and its card
  says "Fix its login or install, then reply to start it again…"; the
  picker tags a vendor whose command isn't on the daemon's PATH "Not
  installed" (session defaults' `not_installed`). A done node with its own
  branch keeps its Merge card even when it has parts. T438: the chat reads a
  failed start as "The agent couldn't start: … Fix its install or login,
  then send a message to start it again.", the empty-chat hero stays hidden
  under a failure, and Details → Agent says why a session ended in words
  ("Stopped with an error: <vendor line>" in red; a clean end in grey).
- **What a worker proposes next** (T427): an agent's `propose_next` line
  ("Proposal") reads as the node it proposes — "Next: **<title>**", the goal
  under it (T435) — and carries **Create node…**, which opens New node with
  its title and goal filled in. T435: next to this node (under its parent)
  and on its repository: under it, a work node would become a coordinator
  (its Merge card gone, a coordinator agent started). The Parent picker can
  still nest it; nested under a work node with a repository, the Parent's
  hint says "<node> will coordinate it; its agent restarts as a
  coordinator". Coordinators (Organise/Run) and the Director create nodes
  themselves; a worker proposes.
  T445 (audit r7 #3): a proposal line's words are never read for a
  repository's name. Only a line whose `ref` proposes one (`repo:<name>`,
  `@agile-agents/shared` `repoProposalRef`) offers **Add <repo>** (+ Repo
  in place), and never on a project's root. A coordinator's proposal
  (`ref: proposals/AP-…`) offers **Decide below**, which takes you to its
  card (Apply / Dismiss) above the composer; a contract proposal offers **See
  the plan**.
- **New node's defaults** (T445, audit r7 #11, #12): in a project with one
  repository it starts on that repository, with **Just talk instead** (no
  repository, a conversation) one click away; a proposal's repository still
  wins. The Title is the goal's first line, cut before a clause (a comma,
  " that ", " with ", " which ") when it must be cut, and never inside a
  quote (`lib/tree.ts` `titleFromGoal`); its hint promises a written title
  only when quick drafts are on and available ("Left as is, a short title
  is written for you once it's made."), else "The goal's first line — edit
  it if you like.". The branch's slug is cut at a word.
- **A node's ⋯ menu** (T445, audit r7 #22, #23) has the rail row's
  **Rename…** and **Move to…** (so ⌘K's "This node" has them), and
  **Add repository…** picks with the searchable repository picker (the
  project's first); on a coordinating node it says "Adds a part on <repo>,
  under this node, which coordinates it."
- **Adding a repository** (T445, audit r7 #10) opens its dialog where you
  are: from Needs me's first step (then back on Needs me with Create a
  project as the next step) and from ⌘K's **Add repository…**.
- **Turn into work** (T422, D42): an open conversation's ⋯ menu (T435: and
  its header once it has replied). One box: the goal (drafted from the talk by
  the cheap model, else its last reply, else its question; the hint says
  which) and a repository, "No repository" first for research. Start adds the
  repo in place and your line starts its agent on the goal: same node, same
  thread. T435:
  - The draft is refused when it is no goal — a question, the model talking
    to you ("I don't have…", "Could you…"), a list, over 600 characters, or
    the prompt's "NONE" — and the last reply (then the question) stands in.
  - The repositories are grouped as in New node ("In <project>" first). One
    from outside the project says "Also adds <repo> to <project>'s
    repositories" under the picker, and Start does so.
  - Under a **work** node, a repository asks **Where**: **Next to <parent>**
    (the default: the node moves up beside it first, so <parent> keeps its
    branch, its Merge card and its own agent) or **Under <parent>** ("<parent>
    will coordinate it; its agent restarts as a coordinator"). A line points
    to the other way: "To have <parent>'s agent do it instead, use Send to
    <parent>." ⋯ Add repository… on a conversation under a work node says
    the same consequence.
  - A title that is still its question (as asked, Ask's placeholder, or any
    title that asks) is renamed from the new goal's first line, and the cheap
    model names it better (D41's path: `update` with `auto_title`); a title you
    gave it stays.
- **Notifications** (Settings → General, per browser, off by default): one
  browser notification at a time for what is new in Needs me (or a reply,
  T429) while the tab is away; a click opens it. Never for what was there at load. They go through
  the service worker (`registration.showNotification`, T394) where one is
  active, which Android Chrome and an installed iOS app require; its
  `notificationclick` focuses the cockpit tab and opens the node.
- **When something throws** (T394): the main view, a node's tab body
  (`TabBoundary`) and each overlay sit in an `ErrorBoundary`. The card says
  what happened in words, with Try again, Reload and Copy details; the
  sidebar keeps working, and going somewhere else resets it. A view whose code
  a rebuild removed reads "A new version of the cockpit is available" with
  Reload only.
- **Loading on demand** (T394): views off the first screen load through
  `lazyNamed()` (`ErrorBoundary.tsx`) and are warmed once the first screen is
  idle. A new heavy view or tab does the same, and nothing on the first screen
  imports it statically (a static import pulls it back into the main file).

## 8. Tests and markup

- Keep `data-testid`s on elements that survive a redesign; the e2e suites
  (`control-room.e2e.test.ts`, `walkthrough.e2e.test.ts`) are selector-driven.
  When a flow changes (a button moves into a menu), update the test to the new
  flow in the same ticket; don't delete the assertion.
- `styles.css` is one file, in sections (`/* ==== <area> ==== */`). Each
  screen's styles live in its section.
- Pure logic (status mapping, grouping, parsing question options) goes in
  `lib/*.ts` with `bun test` coverage, not in components.

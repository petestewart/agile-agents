# Cockpit UI — design system and UX rules

Status: 2026-09-26 (Phase 15, T360–T390). Follow-ups: `cockpit-ui-followups.md`. Applies to `packages/ui/app`. Where this
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
   (a chevron next to the button), never a mandatory step.
5. **Progressive disclosure.** Rarely used controls (autonomy, tracker, waits
   on, + Repo, Review, Close, Delete) live in the details panel or the `⋯`
   menu, not as a row of equal buttons.
6. **Calm by default.** Neutral surfaces; colour only for status and the one
   primary action. No uppercase-everything labels, no borders around every
   line, no orange buttons for ordinary actions.
7. **Keyboard first.** `⌘K`/`Ctrl K` the command palette (nodes, projects,
   views, actions; recent nodes first), `?` the shortcut list, `n` new node,
   `/` filter the tree, `g` then `i`/`d`/`k`/`r`/`e`/`s` jumps to Needs me,
   Director, Knowledge, Running, Events, Settings; `j`/`k` in Needs me;
   `Esc` closes any overlay, Enter sends, Shift+Enter is a newline. The `?`
   list (`Shortcuts.tsx`) names only keys that work.

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
  viewer in localStorage; hidden below 1200px unless opened).
- Pages other than a node use a centred content column (max 960px) with a
  `PageHeader`.
- A project's root node opens on an **Overview** tab (T387): counts by status
  (your move first, each a filter), its nodes grouped by status, its repos and
  its recent activity; the root's chat is the next tab. Other nodes open on
  their chat.

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
- `Popover` — the positioning shell `Menu` uses, for custom content (model
  picker).
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
- `PageHeader title icon subtitle actions` (`<header class="cr-page-hd">`).
- `Field label hint error` — form row wrapper.
- `Spinner`, `Kbd`.
- `useToast()` — transient success/info/error messages with an optional
  action ("Undo"). Errors that block the user's next step stay inline.
- `RepoIcon remote` / `repoKindLabel(remote)` — a repo's host glyph (local
  drive, GitHub, GitLab, a folder for a local clone, a globe otherwise) with
  an SSH mark; the label reads "Local only", "GitHub · SSH", "Local clone".
- `Dialog` renders in a portal on `document.body` and stops its submit from
  bubbling, so a dialog may open from inside another dialog's form (New
  project → Add repository). Single-key shortcuts (`isShortcut`) are off
  while any dialog is open.

Screen-level building blocks built on these (reuse them rather than copy):

- `Chat.tsx` (`ChatScroll`, `MessageList`, `ThreadBody`, `Thinking`) and
  `Composer.tsx` — the node chat, independent of a node (the Director uses
  them too). Rules live in `lib/chat.ts`.
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
- `lib/defaults.ts` `resolvedFor` — what a new session starts with, with the
  project step (P5) before the repo's, as attach resolves it.

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
| done | done, nothing to merge (coordinating); a conversation reads "Replied" | Done / Replied | green |
| waiting | waiting for the plan, or waits on another node | Waiting | gray |
| working | a turn in flight | Working | blue (animated) |
| not_started | its agent never ran | Not started | gray, hollow |
| stopped | you stopped it | Stopped | gray, hollow |
| idle | anything else | Idle | gray |

The `.cr-dot data-dot` colour (amber/blue/grey/green/red) is kept as
`streamDot()` returns it, so older tests read the same.

## 7. Patterns

- **Page header**: title (18px, 600), optional status pill and subtitle
  (breadcrumb), right-aligned actions: one primary, then secondary, then `⋯`.
- **Lists** are rows (40px, hover background, click opens), not stacks of
  bordered cards. Cards are for things that need a decision.
- **Decision cards** (`Card` in `Inbox.tsx`): a title line (kind icon, what it
  is, node path, age), the body, and actions on one row, primary first.
  A question with `options` shows each as a button; typing is always allowed.
  A finished node with nothing to merge (the row's `nothing_to_merge`) reads
  "Finished, no changes" and offers Close node instead of Merge, in Needs me
  and at the end of its own chat.
- **Chat**: human lines right-aligned bubbles; agent lines as prose with the
  agent's name; daemon lines as one-line system rows (icon + muted text) that
  collapse when there are several in a row. A long message folds with "Show
  more". Hover actions on a message: Copy, Branch off (conversations).
- **Composer**: rounded box, auto-growing textarea (1–10 lines), a model chip,
  a hint of what sending will do ("Starts the agent", "Queued until the
  current step ends", "Answers the question"), and Send / Stop. A message to
  a node whose agent never ran or was stopped starts it (`say` with
  `start: true`) — except a part waiting for its coordinator's plan. With a
  question open the composer answers it ("Answering: …"); the question's
  card above it shows only its choices.
- **Forms** in dialogs; labels above inputs; the submit button is the primary
  action and says what it does ("Create project", not "OK").
- **Errors**: inline under the control that caused them, in words a user can
  act on. A refused action names the reason and, if there is one, the fix.
- **Empty states** say what the place is for and give the one action that
  fills it.
- **Destructive actions** confirm (`ConfirmDialog`) or offer Undo (toast).
- **Reviewing a diff** (T393): a line's gutter (or its number, or `C` on a
  focused line) opens a comment under it; comments collect in a review bar
  ("3 comments on 2 files") whose Add to message puts one formatted review
  in the node's composer and opens the chat. It never sends by itself.
- **Editing in place**: a node's title (click it) and goal (Edit on the goal
  card) change where they are read; Enter or leaving saves, Esc cancels.
- **Notifications** (Settings → General, per browser, off by default): one
  browser notification at a time for what is new in Needs me while the tab is
  away; a click opens it. Never for what was there at load.

## 8. Tests and markup

- Keep `data-testid`s on elements that survive a redesign; the e2e suites
  (`control-room.e2e.test.ts`, `walkthrough.e2e.test.ts`) are selector-driven.
  When a flow changes (a button moves into a menu), update the test to the new
  flow in the same ticket; don't delete the assertion.
- `styles.css` is one file, in sections (`/* ==== <area> ==== */`). Each
  screen's styles live in its section.
- Pure logic (status mapping, grouping, parsing question options) goes in
  `lib/*.ts` with `bun test` coverage, not in components.

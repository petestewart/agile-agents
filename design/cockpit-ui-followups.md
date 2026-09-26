# Cockpit UX — follow-ups after Phase 15

Things found while building Phase 15 (T360–T380) that were out of scope,
deferred, or need a decision. Each names where it lives. Ticket them in
`PLAN.md` before picking one up. Design rules: `cockpit-ui.md`.

## P1 — wrong or confusing for the user

None open. (The last ones were fixed in T379, T380, T382 and T383.)

## P2 — polish

- Inbox items carry the call, rule, name and scope only inside `context`
  text (`gateText`, `ruleItem` in `packages/daemon/src/inbox/service.ts`); the
  cards parse it. Add structured fields to `InboxItem` (`.strict()`).
- A decision card stays dimmed until the frame that drops it; the card's
  action refreshes the frame at once, so this is only seen when the daemon is
  slow to drop the item. Removing it optimistically would need a way back
  when it doesn't go.



- The live steps block could also name the step in progress or how long the
  turn has run (a node's and the Director's alike).

## P3 — cleanup, hardening, decisions

- The UI's main file still carries zod and every shared schema (~90 KB):
  the UI imports small helpers from `@agile-agents/shared`, whose index pulls
  in schema modules that can't be tree-shaken. A schema-free entry for the UI
  would drop them. (T394)
- `AddRepo` (17.5 KB) stays in the main file because `NewStream.tsx` imports
  it statically and New node is always mounted for `n`; loading
  `AddRepoDialog` lazily there would move it out. (T394)
- The shell's first effect drops query params it doesn't own
  (`lib/shell.tsx`); Settings' `section` survives only because a deep link
  preloads Settings before the first render. Another lazy screen reading its
  own params would hit the same problem. (T394)
- `sw.js` still sends every request through its fetch handler, which recent
  Chrome no longer needs for install. Removing it takes the worker out of
  every request's path; check installability on the browsers in use first.
  Its `openWindow` branch (no cockpit tab open) isn't covered end to end:
  Chromium won't open a window from a synthetic click. (T394)


- `GET /api/repos/:name/events` (T245) still caps at 200 unpaged; nothing in
  the cockpit calls it since T383 (T389 removed `getRepoEvents`). Page it like
  `/api/events` or retire it.
- Live views refresh on the audit log's tailer; an event emitted without an
  audit line shows only on the next push. The events service's `onEmitted`
  could push the frame itself. (`http.ts`, the tailer)

- `resolveMainBranch` runs git synchronously per repo on every
  `GET /api/repos`.
- A line sent with `start` appears in the first prompt twice (the brief's
  "Thread so far" and "What woke you"); by design for every wake (T336), a
  few tokens, invisible to the user.
- RPC `stream.archive` (the CLI) archives one node (it stops that node's
  sessions since T398); the cockpit's Delete archives the subtree. Pete to
  say whether the CLI should match. CLI `test-support.ts` isn't wired to
  `onTreeChanged`.
- `git@github.com:` remotes show "GitHub · HTTPS" in the cloud container
  because its git config rewrites them to https (environment, not code).

## Not built (ideas for a next UX pass)


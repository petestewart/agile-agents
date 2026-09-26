# Cockpit UX — follow-ups after Phase 15

Things found while building Phase 15 (T360–T377) that were out of scope,
deferred, or need a decision. Each names where it lives. Ticket them in
`PLAN.md` before picking one up. Design rules: `cockpit-ui.md`.

## P1 — wrong or confusing for the user

- **"Ready to merge" with nothing to merge.** A work node whose agent
  finished without committing reads *Ready to merge* on the rail and gets a
  Merge card in Needs me, while its Delivery panel says there is nothing to
  merge. `lib/status.ts` `statusKey` can't tell: the cockpit row has no
  "commits ahead" signal. Either the daemon stops raising `done` as a merge
  when the branch has no commits, or the row carries a cached `ahead` (like
  T362's remote cache). (`packages/ui/app/lib/status.ts`,
  `packages/daemon/src/inbox/service.ts`, `feed/snapshot.ts`). Not a quick
  fix: `done` is what coordinators, auto-review and the tracker push react
  to, so "finished with no commits" wants its own signal (set once at the
  worker's exit), not `idle`.

## P2 — polish

- Inbox items carry the call, rule, name and scope only inside `context`
  text (`gateText`, `ruleItem` in `packages/daemon/src/inbox/service.ts`); the
  cards parse it. Add structured fields to `InboxItem` (`.strict()`).
- A decision card stays disabled up to ~10 s after its action succeeds,
  waiting for the next frame; remove it optimistically.
- The header shows Stop while the live agent is idle waiting on your answer;
  consider Stop as a menu item in that state.
- `Popover` stays open when Tab leaves it; the tree legend's position doesn't
  follow a window resize. (`components/ui.tsx`, `components/StreamTree.tsx`)
- Pull request delivery is offered for a local-only repo and refused by the
  daemon; disable it in the browser with the reason.
  (`components/SettingsRepos.tsx`)
- `lib/inbox.ts` `STOCK_TEXT` rewrote daemon card text the daemon now sends
  itself (T371): dead code.

## P3 — cleanup, hardening, decisions

- **DNS rebinding on reads.** GET routes (`/api/snapshot`, `/api/cockpit`,
  `/api/repos`, …) have no loopback `Host` check (T362 added one for the
  folder browser and clone only). A global check in `isSameOriginRequest`
  closes it but would also refuse a tunnel (D15's phone use), which needs
  auth anyway: Pete to decide.
- Repo names are not validated: `__proto__` is lost when zod parses the
  record. (`POST /api/repos`, clone)
- `resolveMainBranch` runs git synchronously per repo on every
  `GET /api/repos`.
- A clone that times out kills git but can leave its ssh child running (git
  isn't in its own process group). (`packages/daemon/src/store/clone.ts`)
- A line sent with `start` appears in the first prompt twice (the brief's
  "Thread so far" and "What woke you"); by design for every wake (T336), a
  few tokens, invisible to the user.
- `say {start}` would start a part waiting for its coordinator's plan (the
  cockpit never sends it there); refuse it in the daemon too.
- A wake and a manual attach can both pass the "no live agent" check and
  start two agents (pre-existing race).
- `buildSnapshot` counts archived nodes' questions and gates in
  `status.needs_you` (not read by the UI today).
- RPC `stream.archive` archives one node without stopping its sessions; the
  HTTP route archives the subtree and stops them. CLI `test-support.ts` isn't
  wired to `onTreeChanged`.
- Dead code/styles: `groupInbox` (`lib/streams.ts`) and its test;
  `.cr-modal-card`, `.cr-modal-actions`, `.cr-repo-choices`,
  `.cr-rules-screen`, `.cr-gate-row .cr-actions` in `styles.css`.
- `git@github.com:` remotes show "GitHub · HTTPS" in the cloud container
  because its git config rewrites them to https (environment, not code).

## Not built (ideas for a next UX pass)

- Browser notifications when something new needs you (opt-in).
- Inline title/goal editing on a node's header (the route exists:
  `POST /api/streams/:id/update`).
- A project overview on the root page (children by status, repos, recent
  activity) instead of the root node's chat.
- Keyboard: `j`/`k` in the tree beyond the rail's arrow keys; `g i`-style
  view jumps.

# Cockpit UX — follow-ups after Phase 15

Things found while building Phase 15 (T360–T380) that were out of scope,
deferred, or need a decision. Each names where it lives. Ticket them in
`PLAN.md` before picking one up. Design rules: `cockpit-ui.md`.

## P1 — wrong or confusing for the user


## P2 — polish

- Inbox items carry the call, rule, name and scope only inside `context`
  text (`gateText`, `ruleItem` in `packages/daemon/src/inbox/service.ts`); the
  cards parse it. Add structured fields to `InboxItem` (`.strict()`).
- A decision card stays dimmed until the frame that drops it; the card's
  action refreshes the frame at once, so this is only seen when the daemon is
  slow to drop the item. Removing it optimistically would need a way back
  when it doesn't go.
- Effort shows for a vendor that ignores it: a Gemini session's "Worker
  started · Gemini default model · low" and its Settings chip say "low" though
  the daemon never sends it. Drop effort from the label where the provider
  has none (`lib/chat.ts` `sessionLabel`, the provider registry knows).
- Settings → Agents: a repo set to another vendor still shows the global
  Claude model as its inherited placeholder (`SessionPicker.tsx` `SessionFields`);
  `resolveSessionDefaults` does take a named model across vendors, so this is
  the resolution's question first.

## P3 — cleanup, hardening, decisions

- `GET /api/repos/:name/events` still caps at 200 unpaged, and `getRepoEvents`
  (`lib/api.ts`) has no caller since T383: remove both or point them at
  `/api/events?repo=`.
- Live views refresh on the audit log's tailer; an event emitted without an
  audit line shows only on the next push. The events service's `onEmitted`
  could push the frame itself. (`http.ts`, the tailer)

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
- `git@github.com:` remotes show "GitHub · HTTPS" in the cloud container
  because its git config rewrites them to https (environment, not code).

## Not built (ideas for a next UX pass)

- Browser notifications when something new needs you (opt-in).
- A project overview on the root page (children by status, repos, recent
  activity) instead of the root node's chat.
- Keyboard: `j`/`k` in the tree beyond the rail's arrow keys; `g i`-style
  view jumps.

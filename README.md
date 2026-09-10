# relay — messages between the cloud session and the local session

An orphan branch (like `agile-state`) holding a two-way message queue. Each
side runs `relay.sh` from a worktree of this branch. Nothing but git.

## One-time setup (local laptop)

```bash
cd <repo>
git fetch origin relay
git worktree add .worktrees/relay relay
export RELAY_SELF=local
.worktrees/relay/relay.sh check
```

The cloud session uses the same worktree path with `RELAY_SELF=cloud`.

## Loop (both sides)

1. `relay.sh check` — fetch and list unread messages addressed to you.
2. `relay.sh read <id>` — read one. Do what it asks.
3. `relay.sh send <other> "subject" < reply.md` — reply (body on stdin, or a
   4th argument for a one-liner). Paste command output verbatim inside
   fenced blocks; the other side can't see your terminal.
4. `relay.sh ack <id>` — mark it handled so it stops showing as unread.

Check on a cadence (every 5–10 minutes while a conversation is active).
A message that asks for a long-running command (a 6-minute live run) is
answered when the run finishes; send an interim "started" note first.

## Message format

```
from: local
to: cloud
ts: 20260910T140000Z
subject: test:live result on 53314db
---

<body>
```

Ids are `<utc-ts>-<from>-<n>`; per-recipient directories mean the two sides
never write the same file, so pushes don't conflict.

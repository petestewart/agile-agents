#!/usr/bin/env bash
# relay.sh — a message queue between two Claude sessions (cloud + local),
# carried on the orphan `relay` branch of this repo. Nothing but git.
#
#   RELAY_SELF=local ./relay.sh check          # fetch; list unread messages addressed to me
#   RELAY_SELF=local ./relay.sh read <id>      # print one message
#   RELAY_SELF=local ./relay.sh ack <id>       # mark it handled (commits + pushes)
#   RELAY_SELF=local ./relay.sh send cloud "subject" < body.md   # body on stdin
#   RELAY_SELF=local ./relay.sh send cloud "subject" "one-line body"
#   RELAY_SELF=local ./relay.sh log            # every message, both directions
#
# Layout: inbox/<recipient>/<utc-ts>-<from>-<n>.md, one file per message,
# front-matter (from/to/ts/subject) then the body. inbox/<recipient>/.acked
# lists the ids the recipient has handled. Append-only, per-recipient paths,
# so both sides can push without conflicting; `sync` rebases before pushing.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="${RELAY_SELF:-}"
[[ "$SELF" == "local" || "$SELF" == "cloud" ]] || { echo "set RELAY_SELF=local or RELAY_SELF=cloud" >&2; exit 2; }
OTHER=$([[ "$SELF" == "local" ]] && echo cloud || echo local)
G=(git -C "$HERE" -c commit.gpgsign=false -c user.name="relay-$SELF" -c user.email="relay-$SELF@agile-agents.local")

sync() {
  "${G[@]}" fetch -q origin relay
  "${G[@]}" rebase -q origin/relay >/dev/null 2>&1 || { "${G[@]}" rebase --abort 2>/dev/null || true; "${G[@]}" reset -q --hard origin/relay; }
}

push() {
  local i
  for i in 1 2 3 4 5; do
    "${G[@]}" push -q origin HEAD:relay 2>/dev/null && return 0
    sync
    sleep $((i * 2))
  done
  echo "relay: push failed after retries" >&2
  return 1
}

commit() { "${G[@]}" add -A && "${G[@]}" commit -q -m "$1" && push; }

unread() {
  local f id
  for f in "$HERE/inbox/$SELF"/*.md; do
    [[ -e "$f" ]] || continue
    id="$(basename "$f" .md)"
    grep -qxF "$id" "$HERE/inbox/$SELF/.acked" 2>/dev/null || echo "$id"
  done
}

case "${1:-}" in
  check)
    sync
    ids="$(unread)"
    if [[ -z "$ids" ]]; then echo "relay($SELF): no unread messages"; exit 0; fi
    for id in $ids; do
      subj="$(sed -n 's/^subject: //p' "$HERE/inbox/$SELF/$id.md" | head -1)"
      echo "UNREAD $id — $subj"
    done
    ;;
  read)
    [[ -n "${2:-}" ]] || { echo "usage: relay.sh read <id>" >&2; exit 2; }
    cat "$HERE/inbox/$SELF/$2.md"
    ;;
  ack)
    [[ -n "${2:-}" ]] || { echo "usage: relay.sh ack <id>" >&2; exit 2; }
    sync
    echo "$2" >> "$HERE/inbox/$SELF/.acked"
    commit "ack($SELF): $2"
    echo "acked $2"
    ;;
  send)
    to="${2:-}"; subject="${3:-}"
    [[ "$to" == "$OTHER" ]] || { echo "usage: relay.sh send $OTHER \"subject\" [body]" >&2; exit 2; }
    [[ -n "$subject" ]] || { echo "subject required" >&2; exit 2; }
    if [[ $# -ge 4 ]]; then body="$4"; else body="$(cat)"; fi
    sync
    ts="$(date -u +%Y%m%dT%H%M%SZ)"
    n=1; while [[ -e "$HERE/inbox/$to/$ts-$SELF-$n.md" ]]; do n=$((n+1)); done
    id="$ts-$SELF-$n"
    {
      echo "from: $SELF"; echo "to: $to"; echo "ts: $ts"; echo "subject: $subject"; echo "---"; echo; printf '%s\n' "$body"
    } > "$HERE/inbox/$to/$id.md"
    commit "msg($SELF→$to): $subject"
    echo "sent $id"
    ;;
  log)
    sync
    ls -1 "$HERE"/inbox/*/*.md 2>/dev/null | sort -t/ -k1 | while read -r f; do
      echo "== $(basename "$f" .md) → $(basename "$(dirname "$f")")  $(sed -n 's/^subject: //p' "$f" | head -1)"
    done
    ;;
  *)
    sed -n '2,12p' "$0"; exit 2 ;;
esac

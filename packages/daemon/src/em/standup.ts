/**
 * Standup protocol — halt notification, report collection, and resume
 * (T015; design/agile-agents-design.md §5 "Discovery -> standup -> resume"
 * steps 3-4 and 7, §5 "Liveness").
 *
 * Halt *creation* and quorum bookkeeping are T007's (`../halts`) — this
 * module only drives the EM-side bus traffic around an already-created
 * halt: `standupCall` (urgent fan-out to `halt.affected`), `processInbox`
 * (drains `em`'s inbox for `standup_report`s and folds them into the halt
 * via `recordStandupReport`), `handToArchitect` (once quorum is reached),
 * and `releaseIfResolved` (once a decision has been published, releases the
 * halt and broadcasts `resume` — ticket text: "and, after a decision is
 * published (event `oracle_put` / ticket `stale`->`ready`) -> `releaseHalt`
 * + broadcast `resume`").
 *
 * Correlation DESIGN-GAP: `Message` (§5 "Message") carries no dedicated
 * halt-id field, and a halt can be `global` (no `ticket` to key off either).
 * A `standup_report`'s `refs` array is the one free-form pointer field the
 * schema gives a producer, so the convention adopted here — enforced only
 * on the *reading* side, since `engineer.md` (T013, outside this ticket's
 * file ownership) isn't updated to describe it — is: a `standup_report`
 * naming its halt puts the halt id in `refs` (e.g. `refs: ["H-3"]`).
 * A report with no recognizable halt id in `refs` is left unacked in the
 * inbox (visible, not silently dropped) rather than guessed at.
 */

import type { AgentId, Halt, HaltId, Message } from '@agile-agents/shared';
import { MESSAGE_BODY_MAX_CHARS, ulid } from '@agile-agents/shared';
import type { Bus } from '../bus';
import {
  type Clock as HaltClock,
  QUORUM_TIMEOUT_MS,
  recordStandupReport,
  releaseHalt,
} from '../halts';
import type { StateStore } from '../store';

export type Clock = () => Date;

const HALT_ID_IN_REFS = /^H-\d+$/;

function truncate(body: string): string {
  return body.length > MESSAGE_BODY_MAX_CHARS ? body.slice(0, MESSAGE_BODY_MAX_CHARS) : body;
}

function scopeLabel(halt: Halt): string {
  return Array.isArray(halt.scope) ? halt.scope.join(',') : halt.scope;
}

/**
 * Urgent fan-out to every agent a halt names as `affected` (§5 step 3:
 * "Daemon fans out at urgent. Affected agents' next tool call is blocked").
 * A no-op when `affected` is empty (vacuous halt — nobody to notify, see
 * `halts/index.ts`'s `computeAffectedAgents`).
 */
export async function standupCall(
  bus: Bus,
  halt: Halt,
  now: Clock = () => new Date(),
): Promise<void> {
  const affected = (halt.affected ?? []) as AgentId[];
  if (affected.length === 0) return;

  const result = await bus.send({
    id: ulid(now().getTime()),
    ts: now().toISOString(),
    from: 'em',
    to: affected,
    kind: 'standup_call',
    priority: 'urgent',
    body: truncate(`halt ${halt.id} (${scopeLabel(halt)}): ${halt.reason}`),
    refs: [halt.id],
    requires_ack: true,
    deadline: new Date(now().getTime() + QUORUM_TIMEOUT_MS).toISOString(),
  });
  if (!result.ok) {
    throw new Error(`standupCall: halt ${halt.id}: ${result.reason}`);
  }
}

function haltIdFromRefs(refs: readonly string[]): HaltId | undefined {
  const match = refs.find((ref) => HALT_ID_IN_REFS.test(ref));
  return match as HaltId | undefined;
}

export interface StandupReportRecord {
  message: Message;
  haltId: HaltId;
  agent: string;
}

/**
 * Drains `em`'s inbox for `standup_report` messages, folds each into its
 * halt via `recordStandupReport`, and acks it. A report whose halt can't be
 * resolved (no `H-<n>` in `refs`, or the halt is already gone) is left
 * unacked — a human/architect reading the raw inbox can still see it.
 *
 * `haltClock` is `../halts`' own `Clock` shape (`() => number`, not
 * `Date`) — threaded through explicitly rather than left to
 * `recordStandupReport`'s real-time default, so a caller using a fake
 * `Clock` for `standupCall`/`handToArchitect` (this file's `Clock`) gets the
 * *same* notion of "now" for the quorum-timeout check `recordStandupReport`
 * runs internally; otherwise a fixture halt raised at a fake `now` could
 * read as instantly quorum-timed-out against the real wall clock.
 */
export async function processStandupReports(
  store: StateStore,
  bus: Bus,
  haltClock: HaltClock = () => Date.now(),
): Promise<StandupReportRecord[]> {
  const processed: StandupReportRecord[] = [];
  for (const message of bus.poll('em' as AgentId)) {
    if (message.kind !== 'standup_report') continue;
    const haltId = haltIdFromRefs(message.refs);
    if (!haltId) continue;
    try {
      await recordStandupReport(store, haltId, message.from, haltClock);
    } catch {
      continue; // Unknown/already-released halt — leave the report visible.
    }
    await bus.ack('em' as AgentId, message.id);
    processed.push({ message, haltId, agent: message.from });
  }
  return processed;
}

/**
 * Hands a quorum-reached halt to the architect for deliberation (§5 step 5:
 * "EM + architect deliberate in a thread"). Routing (`../bus/routing.ts`)
 * allows `em -> anyone`, so this is a plain `escalate` to `architect`.
 */
export async function handToArchitect(
  bus: Bus,
  halt: Halt,
  now: Clock = () => new Date(),
): Promise<void> {
  const result = await bus.send({
    id: ulid(now().getTime()),
    ts: now().toISOString(),
    from: 'em',
    to: ['architect'],
    kind: 'escalate',
    priority: 'urgent',
    body: truncate(`halt ${halt.id} reached quorum — needs a decision (${halt.reason})`),
    refs: [halt.id],
    requires_ack: true,
    deadline: new Date(now().getTime() + QUORUM_TIMEOUT_MS).toISOString(),
  });
  if (!result.ok) {
    throw new Error(`handToArchitect: halt ${halt.id}: ${result.reason}`);
  }
}

/**
 * "event `oracle_put` / ticket `stale`->`ready`" — read here as: the halt
 * names a resolving decision (`resolves_when`) and that oracle entry now
 * exists (i.e. the architect's `oracle_put` landed). A halt with no
 * `resolves_when` set has no automatic resolution signal this function can
 * observe; it stays open until released some other way (DESIGN-GAP — no
 * sibling mechanism exists for "decision published" beyond the oracle
 * entry's presence).
 */
function decisionPublished(store: StateStore, halt: Halt): boolean {
  if (!halt.resolves_when) return false;
  try {
    store.getOracleEntry(halt.resolves_when);
    return true;
  } catch {
    return false;
  }
}

/**
 * Once quorum is reached AND a resolving decision has been published:
 * releases the halt and broadcasts `resume` (§5 step 7). Re-readied tickets
 * pick up an `assign` the next time `assignReady` runs (`loop.ts`'s regular
 * "assign newly ready tickets" step) rather than being reassigned inline
 * here. Returns `true` iff it actually released something.
 */
export async function releaseIfResolved(
  store: StateStore,
  bus: Bus,
  halt: Halt,
  now: Clock = () => new Date(),
): Promise<boolean> {
  if (halt.quorum !== 'reached' || !decisionPublished(store, halt)) return false;

  await releaseHalt(store, halt.id);
  const result = await bus.send({
    id: ulid(now().getTime()),
    ts: now().toISOString(),
    from: 'em',
    to: ['broadcast'],
    kind: 'resume',
    priority: 'normal',
    body: truncate(
      `halt ${halt.id} released — decision ${halt.resolves_when ?? '(unspecified)'} published`,
    ),
    refs: [halt.id],
    requires_ack: false,
  });
  if (!result.ok) {
    throw new Error(`releaseIfResolved: halt ${halt.id} resume broadcast: ${result.reason}`);
  }
  return true;
}

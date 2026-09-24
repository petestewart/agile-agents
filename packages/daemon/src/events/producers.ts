/**
 * Event producers (T244, projects-design §15): the emit hook the producers
 * call, the payload trimming they share, the stream-transition producers
 * (`child_status`, `child_delivered`, `pr_merged`, `dependency_satisfied`)
 * and the one-line summary each recipient is told. Delivery to sessions is
 * T242's; this file only emits.
 */

import {
  ROUTED_EVENT_PAYLOAD_MAX,
  ROUTED_EVENT_STRING_MAX,
  type RoutedEvent,
  type Stream,
} from '@agile-agents/shared';
import type { StreamService } from '../streams/service';
import { type RouteEmitInput, routeAndEmit } from './router';
import type { RoutedEventService } from './service';

/** What a producer calls. Never throws: a failed emit is logged, never a failed producer. */
export type EmitRouted = (input: RouteEmitInput) => Promise<RoutedEvent | undefined>;

/** Routes over the current tree (archived included, so closed recipients expire) and emits. */
export function makeEmitter(events: RoutedEventService, streams: StreamService): EmitRouted {
  return async (input) => {
    try {
      return await routeAndEmit(events, input, streams.list({ include_archived: true }));
    } catch (err) {
      console.error(`routed event ${input.type} not emitted:`, err);
      return undefined;
    }
  };
}

/** One payload string: first line, capped. */
export function clipLine(text: string, max = 200): string {
  const line =
    text
      .split('\n')
      .find((l) => l.trim().length > 0)
      ?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** At most 20 files within a byte budget, so the payload stays under the 4096-byte cap. */
export function trimFiles(
  files: readonly string[],
  budget = ROUTED_EVENT_PAYLOAD_MAX / 2,
): string[] {
  const out: string[] = [];
  let used = 0;
  for (const f of files) {
    if (out.length >= 20) break;
    const file = f.length > ROUTED_EVENT_STRING_MAX ? f.slice(0, ROUTED_EVENT_STRING_MAX) : f;
    used += Buffer.byteLength(JSON.stringify(file), 'utf8') + 1;
    if (used > budget) break;
    out.push(file);
  }
  return out;
}

const WAIT_STATES = new Set(['done', 'blocked', 'question']);

/**
 * The events a stream record change produces: an agent status that asks for
 * the parent's attention, a delivery reaching `merged`, a repo-less node
 * closing (a `waits_on` target done, P8).
 */
export function transitionEvents(before: Stream, after: Stream): RouteEmitInput[] {
  const out: RouteEmitInput[] = [];
  const base = {
    subject: after.id,
    by: 'daemon' as const,
    ...(after.project !== undefined ? { project: after.project } : {}),
  };
  const title = after.title.slice(0, ROUTED_EVENT_STRING_MAX);
  const status = after.agent.status;
  if (status !== before.agent.status && WAIT_STATES.has(status) && after.parent !== undefined) {
    out.push({
      ...base,
      type: 'child_status',
      payload: {
        child: after.id,
        title,
        status,
        progress: clipLine(after.agent.progress ?? '') || 'no progress line',
      },
    });
  }
  const merged =
    after.delivery_state?.status === 'merged' && before.delivery_state?.status !== 'merged';
  if (merged && after.repo !== undefined) {
    const ds = after.delivery_state;
    const sha = ds?.merged_sha ?? ds?.pr?.head ?? 'unknown';
    const pr = ds?.pr?.number;
    out.push({
      ...base,
      type: 'pr_merged',
      repo: after.repo,
      ...(ds?.pr?.url ? { ref: ds.pr.url } : {}),
      payload: { ...(pr !== undefined ? { pr } : {}), repo: after.repo, sha },
    });
    if (after.parent !== undefined) {
      out.push({
        ...base,
        type: 'child_delivered',
        repo: after.repo,
        payload: { child: after.id, title, repo: after.repo, sha },
      });
    }
  }
  const closedNoRepo =
    after.repo === undefined && after.human.status === 'closed' && before.human.status !== 'closed';
  if (merged || closedNoRepo) {
    out.push({
      ...base,
      type: 'dependency_satisfied',
      payload: {
        node: after.id,
        title,
        ...(after.project !== undefined ? { project: after.project } : {}),
        outcome: merged ? 'merged' : 'closed',
      },
    });
  }
  return out;
}

/** Wires `transitionEvents` to a stream service's `onUpdated`. */
export function emitTransitions(emit: EmitRouted) {
  return async (before: Stream, after: Stream): Promise<void> => {
    for (const input of transitionEvents(before, after)) await emit(input);
  };
}

const list = (xs: unknown): string => (Array.isArray(xs) && xs.length > 0 ? xs.join(', ') : '');

/**
 * The one line recipient `node` is told (§15 "What the recipient agent is
 * told") for every type but `human_line`/`answer` (`summaryOf` in
 * ./delivery has those). `titleOf` names nodes; the full payload is behind `read_event`.
 */
export function summarize(
  event: RoutedEvent,
  node: string,
  titleOf: (id: string) => string | undefined = () => undefined,
): string {
  const p = event.payload as Record<string, unknown>;
  const self = node === event.subject;
  const name = (id: unknown) => (typeof id === 'string' ? (titleOf(id) ?? id) : 'another node');
  const pr = `PR #${String(p.pr)}`;
  switch (event.type) {
    case 'child_status': {
      const word = p.status === 'question' ? 'asking' : String(p.status);
      return `Child ${String(p.title)} is ${word}: ${String(p.progress ?? 'no progress line')}.`;
    }
    case 'child_delivered':
      return `Child ${String(p.title)} merged into ${String(p.repo)} main (${String(p.sha).slice(0, 12)}). Tell the siblings it affects with \`note_child\`; same-repo siblings get the main sync.`;
    case 'pr_review': {
      if (!self) return `${pr} on ${name(event.subject)}: ${String(p.state)}.`;
      const comments = list(p.comments) || 'none';
      const more =
        typeof p.more_comments === 'number' && p.more_comments > 0
          ? ` (${p.more_comments} more via read_event ${event.id})`
          : '';
      return `${pr} review from ${String(p.login)}: ${String(p.state)}. Comments: ${comments}${more}. Fix small asks and push; send design disagreements to the inbox with \`ask\`.`;
    }
    case 'ci_failed':
      return `CI failed on ${pr}: ${String(p.check)}. Log excerpt at ${event.ref ?? `read_event ${event.id}`}. Find the cause, fix it and push. A flaky test is reported with \`ask\`, never skipped.`;
    case 'ship_findings': {
      const all = Array.isArray(p.findings) ? p.findings : [];
      const findings = all.slice(0, 5);
      const more = all.length - findings.length + Number(p.more_findings ?? 0);
      const tail = more > 0 ? ` (+${more} more via read_event ${event.id})` : '';
      return `The ship check (${String(p.source)}) held your delivery: ${findings.join(' | ')}${tail}. Fix them, commit and \`deliver\` again. If you disagree with a finding, say why with \`ask\`; don't re-deliver unchanged.`;
    }
    case 'pr_behind': {
      const what =
        p.state === 'behind' ? 'is behind main' : `conflicts on ${list(p.files) || 'main'}`;
      return `${pr} ${what}. Merge main in, resolve, run the tests, push.`;
    }
    case 'pr_merged':
      if (self) return 'Your PR merged; the stream is done.';
      return `${name(event.subject)} merged into ${String(p.repo)} main (${String(p.sha).slice(0, 12)}).`;
    case 'pr_closed':
      return `${pr} was closed without merging by ${String(p.login ?? 'someone')}.`;
    case 'main_changed': {
      const outcome =
        p.outcome === 'synced'
          ? 'Your branch was synced.'
          : p.outcome === 'conflict'
            ? `The sync conflicted on ${list(p.files) || 'some files'}; a conflict on your branch comes as sync_conflict.`
            : 'Your branch was not synced yet; it syncs when your turn ends.';
      return `${String(p.repo)} main moved to ${String(p.sha).slice(0, 12)} (${String(p.subject_title ?? 'outside the app')}). ${outcome}`;
    }
    case 'sync_conflict':
      if (!self) return `Syncing ${name(event.subject)} onto main conflicted on ${list(p.files)}.`;
      return `Syncing onto main conflicted on ${list(p.files)}. Merge main in, resolve keeping both intents, run the tests, commit.`;
    case 'overlap': {
      const files = list(p.files);
      if (node !== event.subject && node !== p.other) {
        return `${name(event.subject)} and ${name(p.other)} both changed ${files}. If they are your children, decide: \`add_waits_on\` (one waits), \`set_owner\` (one owns the files), or ask the operator to merge them; then \`note_child\` each.`;
      }
      const other = node === p.other ? event.subject : p.other;
      const proj = node === p.other ? event.project : p.other_project;
      const project = typeof proj === 'string' ? ` (${proj})` : '';
      return `You and ${name(other)}${project} both changed ${files}. Your coordinator decides who waits; don't rewrite their part.`;
    }
    case 'symbol_changed':
      if (node !== event.subject && !isImporter(event, node)) {
        return `${name(event.subject)} changed ${String(p.symbol)}, which a sibling imports in ${String(p.file)}.`;
      }
      return `${name(event.subject)} changed ${String(p.symbol)}, which you import in ${String(p.file)}. Check your use still fits; ask your sibling or coordinator if it doesn't.`;
    case 'dependency_satisfied': {
      const project = typeof p.project === 'string' ? ` (${p.project})` : '';
      return `${String(p.title ?? p.node)}${project} ${String(p.outcome)}; your wait on it has cleared.`;
    }
    case 'plan_changed': {
      const paths = list(p.paths);
      return `The plan changed: ${String(p.summary)}. You own ${paths || 'no paths yet'}.`;
    }
    case 'coordinator_note':
      // T286: a daemon notice (a contract decision) is not the coordinator speaking.
      if (event.by === 'daemon') return String(p.body);
      return `Your coordinator says: ${String(p.body)}`;
    case 'contract_changed':
      return `Contract ${String(p.title)} is now v${String(p.version)}: ${String(p.diff)}. Adjust your side.`;
    case 'contract_proposal':
      return `${list(p.children)} propose a change to contract ${String(p.contract)}: ${String(p.body)}. Reason: ${String(p.reason)}. Decide it with \`decide_contract\`.`;
    case 'sibling_ask':
      if (node === p.sibling) {
        return `${name(event.subject)} asks you (${event.id}): ${String(p.question)}. Answer with \`reply_sibling\`.`;
      }
      return `${name(event.subject)} asks ${name(p.sibling)}: ${String(p.question)}.`;
    case 'sibling_reply':
      if (node === p.sibling) return `${name(event.subject)} replies: ${String(p.body)}.`;
      return `${name(event.subject)} replies to ${name(p.sibling)}: ${String(p.body)}.`;
    default:
      return `${event.type}: read_event ${event.id}.`;
  }
}

/** The sibling a `symbol_changed` was routed to because it imports the symbol. */
function isImporter(event: RoutedEvent, node: string | undefined): boolean {
  return event.routing.some((r) => r.node === node && r.because === 'sibling');
}

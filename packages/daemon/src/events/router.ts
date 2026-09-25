/**
 * The router (T241, projects-design §8, §15): computes who a routed event
 * goes to, and why, from the node tree. `routeEvent` is pure; `routeAndEmit`
 * is the thin helper producers (T244) call: route, emit, then expire the
 * deliveries to closed nodes and supersede older pending ones that share the
 * event's coalesce key.
 *
 * Reasons, first match wins when a node qualifies twice:
 * - `self`: the subject node.
 * - `ancestor`: the subject's parent and every ancestor up to the root
 *   (`parentOnly` types: just the parent, which gets a copy).
 * - `waits_on`: every node with a `waits_on` entry on the subject, any project.
 * - `same_repo`: every live work node on the event's repo, any project, other
 *   than the subject.
 * - `party` / `sibling`: named by the producer (contract parties, knowledge
 *   scope, plan children; the other sibling).
 */

import {
  DIRECTOR_NODE,
  type RoutedEvent,
  type RoutedEventType,
  type RoutingEntry,
  type Stream,
} from '@agile-agents/shared';
import { isLiveWorkNode } from '../sync/overlap';
import type { RoutedEventService } from './service';

type Reason = RoutingEntry['because'];
type Rule =
  | 'director'
  | 'self'
  | 'ancestors'
  | 'parent'
  | 'waits_on'
  | 'same_repo'
  | 'party'
  | 'sibling';

/** §15 recipients per type. `party`/`sibling` take the producer's named nodes. */
export const ROUTES: Record<RoutedEventType, readonly Rule[]> = {
  human_line: ['self'],
  answer: ['self'],
  child_status: ['ancestors'],
  child_delivered: ['ancestors'],
  pr_review: ['self', 'ancestors'],
  ci_failed: ['self'],
  ship_findings: ['self'],
  pr_behind: ['self'],
  pr_merged: ['self', 'ancestors', 'waits_on'],
  pr_closed: ['self', 'ancestors'],
  main_changed: ['same_repo'],
  sync_conflict: ['self', 'ancestors'],
  // Both nodes and their ancestors: the other node is named as a party.
  overlap: ['self', 'ancestors', 'party'],
  symbol_changed: ['sibling', 'parent'],
  contract_changed: ['self', 'party'],
  contract_proposal: ['self'],
  knowledge_accepted: ['party'],
  dependency_satisfied: ['waits_on'],
  sibling_ask: ['sibling', 'parent'],
  sibling_reply: ['sibling', 'parent'],
  coordinator_note: ['self'],
  plan_changed: ['party'],
  external_changed: ['self'],
  // T300 (P16): the Director is not a node; its queue is `director`.
  director_request: ['director'],
  // T332 (D33): a tangent reports to the conversation it branched off, no higher.
  tangent_summary: ['parent'],
};

/** Types whose parties also bring their own ancestors (overlap: "both nodes, their ancestors"). */
const PARTY_ANCESTORS: ReadonlySet<RoutedEventType> = new Set(['overlap']);

export interface RouteInput {
  type: RoutedEventType;
  subject?: string;
  repo?: string;
  /** Contract parties, knowledge scope, plan children, the other overlapping node. */
  parties?: readonly string[];
  /** The other sibling (ask/reply) or the importing sibling (symbol_changed). */
  siblings?: readonly string[];
}

export interface Route {
  routing: RoutingEntry[];
  /** Routed nodes that are closed or archived: their delivery is recorded as `expired`. */
  expired: string[];
  coalesce_key?: string;
}

function ancestorsOf(id: string, byId: Map<string, Stream>): string[] {
  const out: string[] = [];
  const seen = new Set([id]);
  let cur = byId.get(id)?.parent;
  while (cur !== undefined && !seen.has(cur)) {
    out.push(cur);
    seen.add(cur);
    cur = byId.get(cur)?.parent;
  }
  return out;
}

export function coalesceKeyFor(input: Pick<RouteInput, 'type' | 'repo'>): string | undefined {
  if (input.type === 'main_changed' && input.repo !== undefined)
    return `main_changed:${input.repo}`;
  return undefined;
}

/** Pure: the routing for an event over the current tree (`all` = every stream). */
export function routeEvent(input: RouteInput, all: readonly Stream[]): Route {
  const byId = new Map(all.map((s) => [s.id, s]));
  const routing: RoutingEntry[] = [];
  const seen = new Set<string>();
  const add = (node: string | undefined, because: Reason) => {
    if (node === undefined || seen.has(node) || !byId.has(node)) return;
    seen.add(node);
    routing.push({ node, because });
  };
  const { subject } = input;
  for (const rule of ROUTES[input.type]) {
    switch (rule) {
      case 'director':
        if (!seen.has(DIRECTOR_NODE)) {
          seen.add(DIRECTOR_NODE);
          routing.push({ node: DIRECTOR_NODE, because: 'self' });
        }
        break;
      case 'self':
        add(subject, 'self');
        break;
      case 'ancestors':
        if (subject !== undefined) for (const a of ancestorsOf(subject, byId)) add(a, 'ancestor');
        break;
      case 'parent':
        add(subject === undefined ? undefined : byId.get(subject)?.parent, 'ancestor');
        break;
      case 'waits_on':
        if (subject !== undefined) {
          for (const s of all)
            if (s.waits_on?.some((w) => w.node === subject)) add(s.id, 'waits_on');
        }
        break;
      case 'same_repo':
        if (input.repo !== undefined) {
          for (const s of all) {
            if (s.id !== subject && s.repo === input.repo && isLiveWorkNode(s, all)) {
              add(s.id, 'same_repo');
            }
          }
        }
        break;
      case 'party':
        for (const p of input.parties ?? []) add(p, 'party');
        break;
      case 'sibling':
        for (const p of input.siblings ?? []) add(p, 'sibling');
        break;
    }
  }
  if (PARTY_ANCESTORS.has(input.type)) {
    for (const p of input.parties ?? []) for (const a of ancestorsOf(p, byId)) add(a, 'ancestor');
  }
  const expired = routing
    .flatMap((r) => byId.get(r.node) ?? [])
    .filter((s) => s.archived === true || s.human.status === 'closed')
    .map((s) => s.id);
  const coalesce_key = coalesceKeyFor(input);
  return { routing, expired, ...(coalesce_key !== undefined ? { coalesce_key } : {}) };
}

export type RouteEmitInput = Omit<RoutedEvent, 'id' | 'at' | 'routing' | 'coalesce_key'> &
  Pick<RouteInput, 'parties' | 'siblings'>;

/**
 * Routes over `all`, emits, expires deliveries to closed nodes, and marks
 * each recipient's older pending events with the same coalesce key
 * `superseded`. Returns the stored event.
 */
export async function routeAndEmit(
  events: RoutedEventService,
  input: RouteEmitInput,
  all: readonly Stream[],
): Promise<RoutedEvent> {
  const { parties, siblings, ...rest } = input;
  const route = routeEvent(
    {
      type: rest.type,
      ...(rest.subject !== undefined ? { subject: rest.subject } : {}),
      ...(rest.repo !== undefined ? { repo: rest.repo } : {}),
      ...(parties !== undefined ? { parties } : {}),
      ...(siblings !== undefined ? { siblings } : {}),
    },
    all,
  );
  const key = route.coalesce_key;
  const older = new Map<string, string[]>();
  if (key !== undefined) {
    for (const { node } of route.routing) {
      const ids = events
        .pendingFor(node)
        .filter((p) => p.event.coalesce_key === key)
        .map((p) => p.event.id);
      if (ids.length > 0) older.set(node, ids);
    }
  }
  const event = await events.emit({
    ...rest,
    routing: route.routing,
    ...(key !== undefined ? { coalesce_key: key } : {}),
  });
  const expired = new Set(route.expired);
  for (const node of expired) await events.mark(node, [event.id], 'expired');
  for (const [node, ids] of older) {
    if (!expired.has(node)) await events.mark(node, ids, 'superseded');
  }
  return event;
}

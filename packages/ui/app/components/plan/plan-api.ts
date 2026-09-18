/**
 * HTTP client + wire types for the Plan screen (T042 — `/api/plan/*` and
 * `POST /api/sprint/start`, served by `packages/daemon/src/plan/service.ts`).
 *
 * Lives next to the panes rather than in `lib/api.ts` for the same reason
 * `lib/feed-types.ts` mirrors `FeedSnapshot` by hand: `packages/ui` may not
 * import `@agile-agents/daemon` (the daemon already imports the UI — a
 * workspace cycle), so these are type-only mirrors of that JSON shape. Keep
 * them in sync with `plan/service.ts` + `plan/projection.ts`; drift shows up
 * as a typecheck failure the moment a pane reads a field that isn't here.
 */

import type {
  KbFact,
  OracleEntry,
  OracleId,
  Policy,
  Question,
  Ticket,
  TicketId,
} from '@agile-agents/shared';

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail: string | undefined;
    try {
      detail = ((await res.json()) as { error?: string }).error;
    } catch {
      // non-JSON error body — fall through.
    }
    throw new Error(detail ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

function post<T>(path: string, body: unknown, method = 'POST'): Promise<T> {
  return fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => asJson<T>(r));
}

export interface BriefView {
  path: string;
  body: string;
  stub: boolean;
}

export interface OracleDoc {
  entry: OracleEntry;
  body: string;
  cited_by: TicketId[];
}

export type PlanTicket = Ticket & { stub: boolean };

export interface SprintRowTicket {
  id: TicketId;
  title: string;
  status: string;
  blocked_by: TicketId[];
  blocks: TicketId[];
  stub: boolean;
}

export interface SprintRow {
  id: string;
  goal: string;
  state: 'finished' | 'running' | 'next' | 'projected';
  tickets: SprintRowTicket[];
  done: number;
  total: number;
  started?: string;
  review_at?: string;
  report?: string;
}

export interface SprintBoard {
  rows: SprintRow[];
  next?: { id: string; tickets: TicketId[] };
  running?: string;
}

export interface PlanOverview {
  brief: BriefView;
  rules: OracleDoc[];
  decisions: OracleDoc[];
  tickets: PlanTicket[];
  sprints: SprintBoard;
  knowledge: Array<{ fact: KbFact; body: string }>;
  policy?: Policy;
  questions: Question[];
}

export interface TicketEditResult {
  mode: 'free' | 'contract_change' | 'follow_up';
  ticket: Ticket;
  followUp?: Ticket;
}

export interface RuleWriteResult {
  proposed: boolean;
  entry?: OracleEntry;
  cited_by?: TicketId[];
}

export interface StartSprintResult {
  /** `false` when `approve_plan` is still pending or was denied — nothing was written. */
  started: boolean;
  sprint?: { id: string; goal: string; tickets: TicketId[] };
  /** What was put to the gate: the frontier this would start. */
  proposal: { id: string; tickets: TicketId[]; goal: string };
  gate: { id: string; owner: string; status: string; decision?: string };
  reason?: string;
}

export function getPlanOverview(): Promise<PlanOverview> {
  return fetch('/api/plan').then((r) => asJson(r));
}

export function putBrief(body: string): Promise<BriefView> {
  return post('/api/plan/brief', { body }, 'PUT');
}

export function putRule(input: {
  id?: OracleId;
  title: string;
  body: string;
}): Promise<RuleWriteResult> {
  return post('/api/plan/rules', input);
}

export function publishDecision(input: { title: string; body: string }): Promise<{
  entry: OracleEntry;
  stale: TicketId[];
  reexamined: Array<{ ticket: TicketId; verdict: string; note?: string }>;
}> {
  return post('/api/plan/decisions', input);
}

export function createTicket(input: {
  title: string;
  description?: string;
  depends?: TicketId[];
}): Promise<Ticket> {
  return post('/api/plan/tickets', input);
}

export function editTicket(
  id: TicketId,
  patch: { title?: string; description?: string; depends?: TicketId[] },
): Promise<TicketEditResult> {
  return post(`/api/plan/tickets/${encodeURIComponent(id)}`, patch, 'PATCH');
}

export function moveTicket(id: TicketId, to: 'next' | 'later'): Promise<Ticket> {
  return post(`/api/plan/tickets/${encodeURIComponent(id)}/move`, { to });
}

export function putKnowledge(input: { id?: string; body: string }): Promise<KbFact> {
  return post('/api/plan/knowledge', input);
}

export function startSprint(): Promise<StartSprintResult> {
  return post('/api/sprint/start', {});
}

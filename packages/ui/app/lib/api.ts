/**
 * HTTP client for the control room (T025). Every call hits an endpoint the
 * daemon's `packages/daemon/src/http.ts` serves; every write goes through
 * an existing daemon verb (`GateService`, `createHalt`/`releaseHalt`,
 * `Bus.send`) so it lands on the bus/event log the same as an agent-driven
 * call would (ticket AC: "every write goes through daemon verbs and
 * appears in the event log").
 */
import type {
  AgentId,
  AgentRecord,
  KbFact,
  KbId,
  KbIndex,
  Message,
  OracleEntry,
  OracleId,
  OracleIndex,
  Policy,
  Question,
  Stanza,
  Ticket,
  TicketId,
} from '@agile-agents/shared';
import type { FeedSnapshot } from './feed-types';

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail: string | undefined;
    try {
      const body = (await res.json()) as { error?: string };
      detail = body.error;
    } catch {
      // non-JSON error body — fall through to the generic message below.
    }
    throw new Error(detail ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export function getSnapshot(): Promise<FeedSnapshot> {
  return fetch('/api/snapshot').then((r) => asJson(r));
}

export function getPolicy(): Promise<Policy> {
  return fetch('/api/policy').then((r) => asJson(r));
}

export function getAgents(): Promise<Array<{ id: AgentId; record: AgentRecord }>> {
  return fetch('/api/agents').then((r) => asJson(r));
}

export function getTickets(): Promise<Ticket[]> {
  return fetch('/api/tickets').then((r) => asJson(r));
}

export function getTicketDetail(id: TicketId): Promise<{ ticket: Ticket; stanzas: Stanza[] }> {
  return fetch(`/api/tickets/${encodeURIComponent(id)}`).then((r) => asJson(r));
}

export function getOracleIndex(): Promise<OracleIndex> {
  return fetch('/api/oracle').then((r) => asJson(r));
}

export function getOracleEntry(id: OracleId): Promise<{ entry: OracleEntry; body: string }> {
  return fetch(`/api/oracle/${encodeURIComponent(id)}`).then((r) => asJson(r));
}

export function getKbIndex(): Promise<KbIndex> {
  return fetch('/api/kb').then((r) => asJson(r));
}

export function getKbFact(id: KbId): Promise<{ fact: KbFact; body: string }> {
  return fetch(`/api/kb/${encodeURIComponent(id)}`).then((r) => asJson(r));
}

/**
 * T039 (§17 "Control room v2"): every Needs-you card takes a typed answer as
 * well as its buttons. `note` rides along with approve/deny; `noteHil` sends
 * one with no button press (it resolves nothing — the EM decides).
 */
export function approveHil(id: string, by = 'human', note?: string): Promise<unknown> {
  return decideHil(id, 'approve', by, note);
}

export function denyHil(id: string, by = 'human', note?: string): Promise<unknown> {
  return decideHil(id, 'deny', by, note);
}

function decideHil(
  id: string,
  action: 'approve' | 'deny',
  by: string,
  note?: string,
): Promise<unknown> {
  return fetch(`/api/hil/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ by, ...(note ? { note } : {}) }),
  }).then((r) => asJson(r));
}

export function noteHil(id: string, note: string): Promise<unknown> {
  return fetch(`/api/hil/${encodeURIComponent(id)}/note`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ note }),
  }).then((r) => asJson(r));
}

/**
 * Questions (T040, §17 "Control room v2" → "Questions vs Decisions").
 * `answerQuestion` posts the typed reply and how it should be applied — a
 * plain reply, or a recorded `DEC-*` through the oracle write guard.
 */
export function getQuestions(openOnly = false): Promise<Question[]> {
  return fetch(`/api/questions${openOnly ? '?status=open' : ''}`).then((r) => asJson(r));
}

export function raiseQuestion(text: string, ticket?: TicketId): Promise<Question> {
  return fetch('/api/questions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, ...(ticket ? { ticket } : {}) }),
  }).then((r) => asJson(r));
}

export function answerQuestion(
  id: string,
  answer: string,
  resolvedAs: 'reply' | 'decision' = 'reply',
): Promise<{ question: Question }> {
  return fetch(`/api/questions/${encodeURIComponent(id)}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answer, resolved_as: resolvedAs }),
  }).then((r) => asJson(r));
}

export function delegateHil(id: string, to: 'em' | 'architect'): Promise<unknown> {
  return fetch(`/api/hil/${encodeURIComponent(id)}/delegate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to }),
  }).then((r) => asJson(r));
}

export function raiseHalt(reason: string): Promise<unknown> {
  return fetch('/api/halt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason, raised_by: 'human' }),
  }).then((r) => asJson(r));
}

export function releaseHalt(id: string): Promise<unknown> {
  return fetch(`/api/halt/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((r) => asJson(r));
}

/**
 * One line of the EM chat thread (T041). Local mirror of
 * `packages/daemon/src/em/chat.ts`'s `ChatEntry`, for the same
 * no-workspace-cycle reason `feed-types.ts` mirrors `FeedSnapshot`.
 */
export interface ChatEntry {
  id: string;
  ts: string;
  from: 'human' | 'em';
  body: string;
  ref?: string;
}

/** The chat thread as the daemon has it (the bus is the source of truth) — this is what makes a reload, and the popped-out window, show the same conversation. */
export function getEmChat(): Promise<ChatEntry[]> {
  return fetch('/api/chat/em').then((r) => asJson(r));
}

/** EM chat panel send (steer / question) — §17: "steer -> action-set cards". The EM's reply streams back over `/ws` (`chat_delta`/`chat_turn_end`), keyed by `reply_id`. */
export function sendEmChat(
  body: string,
  ticket?: TicketId,
): Promise<{ ok: boolean; streaming?: boolean; reply_id?: string; reason?: string }> {
  return fetch('/api/chat/em', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body, ...(ticket ? { ticket } : {}) }),
  }).then((r) => asJson(r));
}

/** Oracle/KB "propose edit" — a bus message to the architect, never a direct write (ticket scope). */
export function proposeOracleEdit(target: OracleId | KbId, body: string): Promise<{ ok: boolean }> {
  return fetch('/api/oracle/propose', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target, body }),
  }).then((r) => asJson(r));
}

export type { Message };

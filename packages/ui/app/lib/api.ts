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

export function approveHil(id: string, by = 'human'): Promise<unknown> {
  return fetch(`/api/hil/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ by }),
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

/** EM chat panel send (steer / question) — §17: "steer -> action-set cards". */
export function sendEmChat(body: string, ticket?: TicketId): Promise<{ ok: boolean }> {
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

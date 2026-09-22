/**
 * The cockpit's writes (T160). Every one goes through the same daemon
 * endpoints the CLI's verbs reach, so it lands in the event log, and none
 * of them sends an actor — the daemon stamps `human` at the HTTP edge
 * (cockpit design §2.2).
 */

import type { Policy } from '@agile-agents/shared';

async function post(path: string, body: unknown = {}): Promise<unknown> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(payload.error ?? `${path} failed (${res.status})`);
  return payload;
}

/** A question card: the typed text reaches the asking session verbatim (§3.3). */
export function answerQuestion(id: string, answer: string): Promise<unknown> {
  return post(`/api/questions/${encodeURIComponent(id)}/answer`, { answer });
}

/** A gate card (`classifier_review`, `land`): allow/deny, optionally with the typed reason. */
export function decideGate(
  id: string,
  decision: 'approve' | 'deny',
  note?: string,
): Promise<unknown> {
  return post(`/api/hil/${encodeURIComponent(id)}/${decision}`, note ? { note } : {});
}

/** A gate card's free text with no decision — recorded on the pending gate. */
export function noteGate(id: string, note: string): Promise<unknown> {
  return post(`/api/hil/${encodeURIComponent(id)}/note`, { note });
}

/** A `rule_accept` card. */
export function decideRule(id: string, decision: 'accept' | 'retire'): Promise<unknown> {
  return post(`/api/rules/${encodeURIComponent(id)}/${decision}`);
}

/** A `done` card's Land button (§8.2). */
export function landStream(id: string): Promise<unknown> {
  return post(`/api/streams/${encodeURIComponent(id)}/land`);
}

export async function getPolicy(): Promise<Policy> {
  const res = await fetch('/api/policy');
  const payload = (await res.json()) as Policy & { error?: string };
  if (!res.ok) throw new Error(payload.error ?? `policy read failed (${res.status})`);
  return payload;
}
